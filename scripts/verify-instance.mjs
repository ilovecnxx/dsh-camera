// 阶段一验证：隔离实例能启动 + Chrome 能打开 GUI 并截图 + 输出 DOM 结构诊断。
// 不依赖 dsh-camera 插件 UI（插件加载失败也能跑），用于提前验证 E2E 基础设施。
//
// 运行：node scripts/verify-instance.mjs
// 产物：verification/phase1-gui.png、verification/phase1-dom.json、verification/phase1-instance.log
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChrome } from './lib/cdp.mjs';
import {
  DEFAULTS,
  prepareProfile,
  startInstance,
} from './lib/dsh-instance.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VERIFY_DIR = path.resolve(HERE, '..', 'verification');

const DOM_DUMP_EXPRESSION = `(() => {
  const pick = (el) => {
    const data = {};
    for (const attr of el.attributes || []) {
      if (attr.name.startsWith('data-') || attr.name === 'aria-label' || attr.name === 'placeholder' || attr.name === 'type' || attr.name === 'contenteditable' || attr.name === 'role') {
        data[attr.name] = attr.value;
      }
    }
    return data;
  };
  const buttons = [...document.querySelectorAll('button,[role="button"]')].slice(0, 60).map((el) => ({
    tag: el.tagName.toLowerCase(),
    text: (el.innerText || el.textContent || '').trim().slice(0, 80),
    attrs: pick(el),
    cls: typeof el.className === 'string' ? el.className.slice(0, 200) : '',
  }));
  const inputs = [...document.querySelectorAll('input,textarea,[contenteditable]')].slice(0, 40).map((el) => ({
    tag: el.tagName.toLowerCase(),
    attrs: pick(el),
    cls: typeof el.className === 'string' ? el.className.slice(0, 200) : '',
  }));
  const dataAttrs = new Set();
  for (const el of document.querySelectorAll('*')) {
    for (const attr of el.attributes || []) if (attr.name.startsWith('data-')) dataAttrs.add(attr.name);
  }
  return {
    title: document.title,
    href: location.href,
    rootChildren: document.querySelector('#root')?.children.length ?? null,
    bodyText: (document.body?.innerText || '').slice(0, 4000),
    buttons,
    inputs,
    dataAttributes: [...dataAttrs].sort().slice(0, 200),
    language: document.documentElement.lang,
    hasTokenParam: new URL(location.href).searchParams.has('token'),
    cookie: document.cookie.slice(0, 300),
    localKeys: (() => { try { return Object.keys(localStorage).slice(0, 30); } catch { return []; } })(),
  };
})()`;

function summarize(dom) {
  return {
    title: dom.title,
    href: dom.href,
    rootChildren: dom.rootChildren,
    bodyTextHead: (dom.bodyText || '').slice(0, 600),
    buttonCount: dom.buttons.length,
    buttons: dom.buttons.map((b) => `[${b.tag}] ${JSON.stringify(b.text)}`).slice(0, 25),
    inputs: dom.inputs,
    dataAttributes: dom.dataAttributes.slice(0, 80),
    language: dom.language,
    hasTokenParam: dom.hasTokenParam,
    cookie: dom.cookie,
    localKeys: dom.localKeys,
  };
}

async function main() {
  fs.mkdirSync(VERIFY_DIR, { recursive: true });
  const summary = { startedAt: new Date().toISOString(), steps: [] };
  const step = (name, detail) => {
    summary.steps.push({ name, ...detail });
    console.log(`[verify] ${name}`, detail ? JSON.stringify(detail).slice(0, 500) : '');
  };

  // 0) 如有上次残留的测试实例，先精确清理（只针对本测试 home/profile）
  let inst = null;
  let browser = null;
  let ok = false;
  try {
    await prepareProfile({ log: (m) => console.log(m) });
    step('prepareProfile', { ok: true });

    inst = await startInstance({ log: (m) => console.log(m) });
    step('startInstance', { ok: true, pid: inst.pid, url: inst.url, port: inst.port });
    fs.copyFileSync(inst.logFile, path.join(VERIFY_DIR, 'phase1-instance.log'));

    browser = await launchChrome({
      userDataDir: DEFAULTS.chromeProfile,
      logFile: DEFAULTS.chromeLogFile,
    });
    step('launchChrome', { ok: true, port: browser.port, version: browser.versionInfo?.Browser });

    const page = await browser.newPage();
    await page.enableRuntime();
    await page.goto(inst.url, { timeoutMs: 45000 });
    step('navigate', { ok: true, url: inst.url });

    // 前端是 SPA：等 #root 有内容（最多 60s）
    await page.waitFor(
      `document.querySelector('#root') && document.querySelector('#root').children.length > 0`,
      { timeoutMs: 60000, label: 'frontend app mount (#root children)' },
    );
    // 再等一会儿让异步数据/会话列表渲染
    await new Promise((r) => setTimeout(r, 2500));
    const dom = await page.evaluate(DOM_DUMP_EXPRESSION);
    const screenshot = await page.screenshot(path.join(VERIFY_DIR, 'phase1-gui.png'));
    const domFile = path.join(VERIFY_DIR, 'phase1-dom.json');
    fs.writeFileSync(domFile, `${JSON.stringify({ dom, console: page.consoleMessages, pageErrors: page.pageErrors }, null, 2)}\n`);
    step('domDump', { screenshot, domFile, ...summarize(dom) });
    step('console', {
      messages: page.consoleMessages.slice(0, 30),
      errors: page.pageErrors.slice(0, 30),
    });
    ok = true;
  } catch (err) {
    summary.error = err?.stack || String(err);
    console.error('[verify] FAILED:', err?.stack || err);
    try {
      if (inst) fs.copyFileSync(inst.logFile, path.join(VERIFY_DIR, 'phase1-instance.log'));
    } catch {
      /* ignore */
    }
  } finally {
    try {
      if (browser) await browser.close();
    } catch (err) {
      console.error('[verify] browser close failed:', err.message);
    }
    try {
      if (inst) await inst.stop();
    } catch (err) {
      console.error('[verify] instance stop failed:', err.message);
    }
    summary.finishedAt = new Date().toISOString();
    summary.ok = ok;
    fs.writeFileSync(path.join(VERIFY_DIR, 'phase1-summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
    console.log(`[verify] ${ok ? 'PASS' : 'FAIL'} — summary: verification/phase1-summary.json`);
  }
  process.exit(ok ? 0 : 1);
}

main();
