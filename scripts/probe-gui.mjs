// GUI 交互探针：启动隔离实例 + Chrome，依次执行可配置动作并 dump DOM，
// 用于确定 E2E 的稳定定位方式（可反复运行，不影响 3080）。
//
// 运行：node scripts/probe-gui.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChrome } from './lib/cdp.mjs';
import { DEFAULTS, prepareProfile, startInstance } from './lib/dsh-instance.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(HERE, '..', 'verification', 'probe');
fs.mkdirSync(OUT, { recursive: true });

const DUMP = `(() => {
  const attrs = (el) => {
    const out = {};
    for (const a of el.attributes || []) if (/^(data-|aria-|role|placeholder|type|contenteditable)/.test(a.name)) out[a.name] = a.value;
    return out;
  };
  const short = (el) => ({
    tag: el.tagName.toLowerCase(),
    attrs: attrs(el),
    text: (el.innerText || el.textContent || '').trim().slice(0, 120),
    cls: typeof el.className === 'string' ? el.className.slice(0, 120) : '',
  });
  return {
    href: location.href,
    title: document.title,
    bodyText: (document.body.innerText || '').slice(0, 3000),
    dock: document.querySelector('[data-composer-dock]') ? document.querySelector('[data-composer-dock]').innerHTML.slice(0, 2000) : null,
    dockChildren: document.querySelector('[data-composer-dock]')?.children.length ?? null,
    composerCards: [...document.querySelectorAll('[data-composer-card]')].length,
    buttons: [...document.querySelectorAll('button')].slice(0, 60).map(short),
    media: [...document.querySelectorAll('img,video,canvas')].slice(0, 20).map((el) => ({ tag: el.tagName.toLowerCase(), src: (el.getAttribute('src') || '').slice(0, 120), alt: el.getAttribute('alt'), cls: typeof el.className === 'string' ? el.className.slice(0, 80) : '' })),
    links: [...document.querySelectorAll('a[href]')].slice(0, 20).map((a) => ({ href: a.getAttribute('href'), text: (a.innerText || '').trim().slice(0, 60) })),
    cameraDock: !!document.querySelector('[data-dsh-camera-dock]'),
  };
})()`;

const TEXT_CLICK = (needle) => `(() => {
  const candidates = [...document.querySelectorAll('button,[role="button"],a')];
  const el = candidates.find((e) => ((e.innerText || e.textContent || '').trim() === ${JSON.stringify(needle)})) ||
             candidates.find((e) => ((e.getAttribute('aria-label') || '') === ${JSON.stringify(needle)})) ||
             candidates.find((e) => ((e.innerText || e.textContent || '').includes(${JSON.stringify(needle)})));
  if (!el) return { clicked: false, candidates: candidates.slice(0, 40).map((e) => ({ text: (e.innerText || e.textContent || '').trim().slice(0, 60), aria: e.getAttribute('aria-label') })) };
  el.scrollIntoView({ block: 'center' });
  el.click();
  return { clicked: true, text: (el.innerText || el.textContent || '').trim().slice(0, 80), aria: el.getAttribute('aria-label') };
})()`;

async function dump(page, label) {
  await new Promise((r) => setTimeout(r, 800));
  const dom = await page.evaluate(DUMP);
  const png = path.join(OUT, `${label}.png`);
  await page.screenshot(png);
  const jsonFile = path.join(OUT, `${label}.json`);
  fs.writeFileSync(jsonFile, `${JSON.stringify({ dom, console: page.consoleMessages, errors: page.pageErrors }, null, 2)}\n`);
  console.log(`\n===== ${label} =====  href=${dom.href} cameraDock=${dom.cameraDock} dockChildren=${dom.dockChildren} cards=${dom.composerCards}`);
  console.log('buttons:', dom.buttons.map((b) => `[${b.text || b.attrs['aria-label'] || '?'}]`).join(' | ').slice(0, 1200));
  console.log('media:', JSON.stringify(dom.media));
  console.log(`screenshot: ${png}`);
  return dom;
}

async function main() {
  let inst = null;
  let browser = null;
  let ok = false;
  try {
    await prepareProfile();
    inst = await startInstance();
    browser = await launchChrome({ logFile: DEFAULTS.chromeLogFile });
    const page = await browser.newPage();
    await page.enableRuntime();
    await page.goto(inst.url, { timeoutMs: 45000 });
    await page.waitFor(`document.querySelector('#root') && document.querySelector('#root').children.length > 0`, { timeoutMs: 60000 });
    await new Promise((r) => setTimeout(r, 2000));
    await dump(page, '01-landing');

    // 关掉预览版说明弹窗
    const dismiss = await page.evaluate(TEXT_CLICK('继续'));
    console.log('dismiss preview:', JSON.stringify(dismiss));
    await new Promise((r) => setTimeout(r, 600));
    await dump(page, '02-after-dismiss');

    // 点击侧边栏「新会话」
    const newSession = await page.evaluate(TEXT_CLICK('新建会话'));
    console.log('click new session:', JSON.stringify(newSession));
    await page.waitFor('!!document.querySelector("[data-conversation-session]")', { timeoutMs: 20000 }).catch((e) => console.log('no conversation-session:', e.message));
    await dump(page, '03-new-session');

    // 看 composer contenteditable 与发送按钮状态
    const composer = await page.evaluate(`(() => {
      const el = document.querySelector('[data-composer-input]');
      const send = document.querySelector('button[aria-label="发送消息"]');
      return { hasComposer: !!el, composerAttrs: el ? [...el.attributes].map(a => [a.name, a.value]) : null, sendDisabled: send ? send.disabled : null };
    })()`);
    console.log('composer:', JSON.stringify(composer, null, 1));

    await page.evaluate(`(() => { const el = document.querySelector('[data-composer-input]'); if (!el) return false; el.focus(); return true; })()`);
    await new Promise((r) => setTimeout(r, 300));
    await page.send('Input.insertText', { text: 'dsh-camera e2e probe' });
    await new Promise((r) => setTimeout(r, 600));
    const afterType = await page.evaluate(`(() => {
      const send = document.querySelector('button[aria-label="发送消息"]');
      return { text: document.querySelector('[data-composer-input]')?.innerText, sendDisabled: send ? send.disabled : null };
    })()`);
    console.log('after type:', JSON.stringify(afterType));
    await dump(page, '04-typed');

    ok = true;
  } catch (err) {
    console.error('PROBE FAILED:', err?.stack || err);
  } finally {
    try { if (browser) await browser.close(); } catch (e) { console.error('browser close:', e.message); }
    try { if (inst) await inst.stop(); } catch (e) { console.error('instance stop:', e.message); }
    console.log(ok ? '\nPROBE PASS' : '\nPROBE FAIL');
  }
  process.exit(ok ? 0 : 1);
}

main();
