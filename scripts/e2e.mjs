// dsh-camera 全链路 E2E：隔离 DSH 实例（DSH_HOME=/tmp/dsh-cam-home, profile cam, port 3099）
// + headless Chrome（手写 CDP）验证：
//
//   GUI 打开（带 token）→ 建立会话 → 点 composer dock 相机入口 → 面板出现二维码/URL
//   → 新标签打开手机页 → 塞测试 PNG → 手机页 status=done/count≥1
//   → 回 GUI 等对话里渲染出图片消息 → 截图存 verification/e2e/
//
// 只操作自己启动的 3099 实例、3579 LAN server 与 /tmp 下 Chrome，绝不碰 3080。
// 失败时：非零退出 + 精确步骤 + 截图/DOM/控制台/实例日志全部落盘。
//
// 运行：node scripts/e2e.mjs
// 退出码：0 成功；1 失败。
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { launchChrome } from './lib/cdp.mjs';
import {
  DEFAULTS,
  findInstancePids,
  prepareProfile,
  startInstance,
  stopInstance,
  stopStrayTestChrome,
} from './lib/dsh-instance.mjs';
import { writeTestImages } from './lib/png.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const OUT_DIR = path.join(REPO_ROOT, 'verification', 'e2e');
const IMAGE_DIR = '/tmp/cam-test-images';
const GUI_PORT = Number(process.env.DSH_CAMERA_TEST_PORT || DEFAULTS.port);

const PANEL_READY_TIMEOUT = 30_000;
const PHONE_DONE_TIMEOUT = 90_000;
const GUI_IMAGE_TIMEOUT = 30_000;

class E2EError extends Error {
  constructor(step, message, detail = undefined) {
    super(`[${step}] ${message}`);
    this.name = 'E2EError';
    this.step = step;
    this.detail = detail;
  }
}

function log(message, detail) {
  const suffix = detail === undefined ? '' : ` ${JSON.stringify(detail).slice(0, 600)}`;
  console.log(`${message}${suffix}`);
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeJson(file, value) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
  return file;
}

/** 诊断用：读取页面 DOM 摘要（不抛错）。 */
async function dumpPageDiagnostics(page) {
  if (!page) return null;
  try {
    return await page.evaluate(`(() => {
      const attrs = {};
      for (const el of document.querySelectorAll('[data-dsh-camera-dock],[data-dsh-camera-panel],[data-dsh-camera-url],[data-dsh-camera-error],[data-cam-page],[data-cam-status],[data-cam-count],[data-cam-error],[data-conversation-content],[data-composer-dock],[data-composer-input]')) {
        const name = el.tagName.toLowerCase();
        const entry = { attrs: {}, text: (el.innerText || el.textContent || '').trim().slice(0, 300) };
        for (const a of el.attributes) if (a.name.startsWith('data-') || a.name.startsWith('aria-')) entry.attrs[a.name] = a.value.slice(0, 300);
        (attrs[name] ||= []).push(entry);
      }
      const images = [...document.querySelectorAll('img')].slice(0, 30).map((img) => ({
        src: (img.getAttribute('src') || '').slice(0, 160),
        alt: img.getAttribute('alt'),
        cls: typeof img.className === 'string' ? img.className.slice(0, 120) : '',
      }));
      const conversation = document.querySelector('[data-conversation-content]');
      return {
        href: location.href,
        title: document.title,
        bodyText: (document.body?.innerText || '').slice(0, 3000),
        anchors: attrs,
        images,
        conversationHtml: conversation ? conversation.innerHTML.slice(0, 6000) : null,
        dataAttributes: [...new Set([...document.querySelectorAll('*')].flatMap((el) => [...el.attributes].map((a) => a.name)).filter((n) => n.startsWith('data-')))]
          .sort().slice(0, 120),
        resourceHints: performance.getEntriesByType('resource').map((r) => r.name).filter((n) => /camera|client|module/i.test(n)).slice(0, 20),
        moduleLoader: typeof window.__ModuleLoader__,
      };
    })()`);
  } catch (error) {
    return { error: error.message };
  }
}

/** 关闭首启的「预览版说明」「开始使用」等遮罩（最多 6 轮）。 */
async function dismissOverlays(page) {
  const clicked = [];
  const wanted = ['继续', 'Continue', '跳过', 'Skip', '关闭', 'Close', '知道了', '我知道了', 'Got it', '稍后', 'Later'];
  let idle = 0;
  for (let round = 0; round < 16; round += 1) {
    const hit = await page.evaluate(`(() => {
      const wanted = ${JSON.stringify(wanted)};
      const buttons = [...document.querySelectorAll('button,[role="button"]')];
      const el = buttons.find((e) => {
        const label = (e.getAttribute('aria-label') || '').trim();
        const text = (e.innerText || e.textContent || '').trim();
        return wanted.includes(text) || wanted.includes(label);
      });
      if (!el) return null;
      el.scrollIntoView({ block: 'center' });
      el.click();
      return (el.innerText || el.textContent || '').trim() || el.getAttribute('aria-label');
    })()`);
    if (hit === null) {
      idle += 1;
      if (idle >= 2) break;
      await delay(400);
      continue;
    }
    idle = 0;
    clicked.push(hit);
    await delay(500);
  }
  return clicked;
}

/** 等登录墙/预览说明等阻塞弹窗出现并关掉它；返回关闭过的按钮文案。 */
async function clearBlockingModal(page) {
  const clicked = [];
  for (let round = 0; round < 20; round += 1) {
    const modal = await page.evaluate(`(() => {
      const text = document.body ? (document.body.innerText || '') : '';
      return /开始使用|添加 API Key|Get started|Add API Key|预览版说明/.test(text);
    })()`);
    if (!modal) {
      if (clicked.length > 0) break;
      // 弹窗可能晚于首帧出现：短暂观察后仍没有就直接返回
      await delay(300);
      if (round >= 4) break;
      continue;
    }
    clicked.push(...(await dismissOverlays(page)));
    await delay(300);
  }
  return clicked;
}

/**
 * 写一个最小 MP4 测试文件（ftyp 容器头 + 填充字节）。只用于验证上传链路：
 * 服务端按文件头归类为视频并原样保存，不做解码/转码。
 * @param {string} dir - target directory.
 * @returns {string} absolute file path.
 */
function writeTestVideo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'cam-test-video.mp4');
  const mp4 = Buffer.concat([
    Buffer.from([0x00, 0x00, 0x00, 0x18]),
    Buffer.from('ftypisom', 'latin1'),
    Buffer.from([0x00, 0x00, 0x02, 0x00]),
    Buffer.from('isomiso2avc1mp41', 'latin1'),
    Buffer.alloc(2048, 9),
  ]);
  fs.writeFileSync(file, mp4);
  return file;
}

/** 等待 expression 返回 truthy 的 JSON 值。 */
async function waitForValue(page, expression, { timeoutMs = 20_000, intervalMs = 150, label = expression } = {}) {
  return page.waitFor(expression, { timeoutMs, intervalMs, label });
}

/** 在 GUI 中建立一个 active 会话（发送一条消息）。 */
async function establishSession(page) {
  await page.waitForSelector('[data-composer-input]', { timeoutMs: 30_000 });
  // 首启会先弹「预览版说明」，再弹「开始使用（登录墙）」；两者都必须关掉，
  // 否则 composer 被 inert，发送按钮永远 disabled。
  await clearBlockingModal(page);
  await page.waitForSelector('[data-composer-input]', { timeoutMs: 15_000 });
  const text = `dsh-camera e2e setup ${Date.now()}`;
  await page.type('[data-composer-input]', text);
  // 若弹窗在输入后补弹（异步挂载），再关一轮。
  const sendEnabled = () => page.evaluate(
    `(() => { const b = document.querySelector('button[aria-label="发送消息"]') || document.querySelector('button[aria-label="Send message"]'); return !!b && !b.disabled; })()`,
  );
  if (!(await sendEnabled())) {
    await clearBlockingModal(page);
  }
  // 输入可能因弹窗夺焦而丢失：确认 composer 里确有本次文案，没有就重打。
  const draft = await page.evaluate(
    `(() => { const el = document.querySelector('[data-composer-input]'); return el ? (el.innerText || el.textContent || '') : ''; })()`,
  );
  if (!String(draft).includes(text)) {
    await page.click('[data-composer-input]');
    await page.type('[data-composer-input]', text);
    await clearBlockingModal(page);
  }
  // 等发送按钮可用（React 状态更新）
  await waitForValue(
    page,
    `(() => { const b = document.querySelector('button[aria-label="发送消息"]') || document.querySelector('button[aria-label="Send message"]'); return !!b && !b.disabled; })()`,
    { timeoutMs: 20_000, label: 'send button enabled' },
  );
  const clicked = await page.evaluate(
    `(() => { const b = document.querySelector('button[aria-label="发送消息"]') || document.querySelector('button[aria-label="Send message"]'); if (!b) return false; b.click(); return true; })()`,
  );
  if (!clicked) throw new Error('发送消息按钮不存在');
  // 会话变为 active，且 composer dock 槽出现
  await waitForValue(
    page,
    `(() => {
      const region = document.querySelector('[data-conversation-content]');
      return region ? region.getAttribute('data-content-phase') === 'active' : false;
    })()`,
    { timeoutMs: 30_000, label: 'conversation active' },
  );
  const sessionId = await page.evaluate(
    `document.querySelector('[data-conversation-session]')?.getAttribute('data-conversation-session') ?? ''`,
  );
  return { text, sessionId };
}

/** 轮询等待 GUI 对话里出现图片消息（img/attachment 节点）。 */
async function waitForConversationImage(page, { timeoutMs = GUI_IMAGE_TIMEOUT, minCount = 1 } = {}) {
  const started = Date.now();
  let snapshot = null;
  while (Date.now() - started < timeoutMs) {
    snapshot = await page.evaluate(`(() => {
      const region = document.querySelector('[data-conversation-content]');
      if (!region) return { count: 0, srcs: [], html: null };
      const imgs = [...region.querySelectorAll('img')].filter((img) => {
        const src = img.getAttribute('src') || '';
        return src.length > 0 && !/favicon/i.test(src);
      });
      const canvas = [...region.querySelectorAll('canvas')];
      return {
        count: imgs.length + canvas.length,
        srcs: imgs.map((img) => (img.getAttribute('src') || '').slice(0, 120)),
        canvasCount: canvas.length,
        blobUrls: imgs.filter((img) => (img.getAttribute('src') || '').startsWith('blob:')).length,
        html: region.innerHTML.slice(0, 4000),
        text: (region.innerText || '').slice(0, 1200),
      };
    })()`);
    if (snapshot.count >= minCount) return snapshot;
    await delay(250);
  }
  const error = new Error(`等待对话图片消息超时：${JSON.stringify(snapshot).slice(0, 1500)}`);
  error.snapshot = snapshot;
  throw error;
}

/**
 * 扫描隔离 DSH_HOME 下本次运行期间写入的 session 日志，统计 image attachment 块。
 * 这是独立于 GUI 渲染的服务端证据（注入是否真正持久化成 user 消息附件）。
 */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/**
 * Decode one session log file. DSH writes `session.v4.jsonl.zstd` as a series
 * of concatenated zstd frames (one per flush), and Node's zstd decompressor
 * stops after the first frame — so decode frame by frame and concatenate.
 * @param {string} file - absolute path.
 * @returns {string} complete JSONL text, or '' when unreadable.
 */
function readSessionLogText(file) {
  let buffer;
  try {
    buffer = fs.readFileSync(file);
  } catch {
    return '';
  }
  if (!/\.zstd$/.test(file)) return buffer.toString('utf8');
  const starts = [];
  let cursor = 0;
  while (cursor < buffer.length) {
    const hit = buffer.indexOf(ZSTD_MAGIC, cursor);
    if (hit < 0) break;
    starts.push(hit);
    cursor = hit + ZSTD_MAGIC.length;
  }
  const chunks = [];
  for (let index = 0; index < starts.length; index += 1) {
    const slice = buffer.subarray(starts[index], starts[index + 1] ?? buffer.length);
    try {
      chunks.push(zlib.zstdDecompressSync(slice));
    } catch {
      /* not a frame boundary after all */
    }
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Independently read the isolated Session log and count persisted image blocks.
 * This proves the upload was admitted into the durable conversation, not merely
 * rendered from a local preview.
 * @param {string} home - isolated DSH_HOME.
 * @param {string} sessionId - Session identity from the GUI.
 * @param {number} runStartMs - start of this E2E run.
 * @returns {{ files: string[], imageBlocks: number, userImageMessages: number, sessionIdMatched: boolean, sample: string | null }} evidence.
 */
function inspectPersistedSession(home, sessionId, runStartMs) {
  const files = [];
  const walk = (dir, depth) => {
    if (depth > 6) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const full = path.join(dir, entry.name);
      let stat;
      try {
        stat = fs.statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) walk(full, depth + 1);
      else if (/\.jsonl(\.zstd)?$/.test(entry.name) && stat.mtimeMs >= runStartMs - 2_000) {
        files.push({ file: full, size: stat.size });
      }
    }
  };
  walk(home, 0);
  const result = {
    files: [],
    imageBlocks: 0,
    fileBlocks: 0,
    userImageMessages: 0,
    sessionIdMatched: false,
    sample: null,
  };
  for (const { file } of files) {
    if (!file.includes(sessionId)) continue;
    const text = readSessionLogText(file);
    if (!text.includes(sessionId)) continue;
    result.files.push(path.relative(home, file));
    result.sessionIdMatched = true;
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let value;
      try {
        value = JSON.parse(line);
      } catch {
        continue;
      }
      const json = JSON.stringify(value);
      const imageMatches = json.match(/"type":"image"/g);
      if (!imageMatches) continue;
      result.imageBlocks += imageMatches.length;
      result.fileBlocks += (json.match(/"type":"file"/g) || []).length;
      if (value?.type === 'user/message' || json.includes('"role":"user"')) result.userImageMessages += 1;
      result.sample ||= json.slice(0, 600);
    }
  }
  return result;
}

function sanitize(value) {
  if (value === undefined || value === null) return value;
  try {
    const json = JSON.stringify(value);
    if (json.length <= 3000) return value;
    return { truncated: true, head: json.slice(0, 3000) };
  } catch {
    return String(value);
  }
}

/**
 * 执行完整 E2E。
 * @param {{ log?: Function, imageCount?: number }} options
 * @returns {Promise<object>} summary（成功时 ok=true）
 */
export async function runE2E({ log: logger = log, imageCount = 2 } = {}) {
  const runStartMs = Date.now();
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  ensureDir(OUT_DIR);
  ensureDir(IMAGE_DIR);
  const summary = {
    ok: false,
    startedAt: new Date().toISOString(),
    guiPort: GUI_PORT,
    imageCount,
    steps: [],
    screenshots: [],
    artifacts: {},
  };
  const state = { inst: null, browser: null, gui: null, phone: null };
  const startedAt = Date.now();

  const step = async (name, fn) => {
    const at = Date.now();
    logger(`\n[e2e] ▶ ${name}`);
    try {
      const detail = await fn();
      summary.steps.push({ name, ok: true, ms: Date.now() - at, detail: sanitize(detail) });
      logger(`[e2e] ✔ ${name} (${Date.now() - at}ms)`, detail);
      return detail;
    } catch (error) {
      summary.steps.push({ name, ok: false, ms: Date.now() - at, error: error.message, stack: error.stack });
      logger(`[e2e] ✖ ${name}: ${error.message}`);
      throw new E2EError(name, error.message, error.snapshot ?? error.detail);
    }
  };

  const screenshot = async (page, name) => {
    const file = path.join(OUT_DIR, name);
    await page.screenshot(file);
    summary.screenshots.push(path.relative(REPO_ROOT, file));
    logger(`[e2e]   screenshot: ${path.relative(REPO_ROOT, file)}`);
    return file;
  };

  try {
    // 清理上一次残留（只针对测试 DSH_HOME / 测试 Chrome profile）
    const strays = findInstancePids({ home: DEFAULTS.home, profile: DEFAULTS.profile });
    if (strays.length > 0) {
      logger(`[e2e] cleaning up stale test instance pids: ${strays.join(', ')}`);
      await stopInstance({ home: DEFAULTS.home, profile: DEFAULTS.profile, port: GUI_PORT });
    }
    stopStrayTestChrome({ log: logger });

    await step('prepare-profile', async () => {
      await prepareProfile({ log: logger });
      return { home: DEFAULTS.home, profile: DEFAULTS.profile };
    });

    await step('start-instance', async () => {
      state.inst = await startInstance({ log: logger });
      summary.artifacts.instanceLog = path.relative(
        REPO_ROOT,
        path.join(OUT_DIR, 'instance.log'),
      );
      return { pid: state.inst.pid, url: state.inst.url.replace(/token=[^&]+/, 'token=***'), port: state.inst.port };
    });

    await step('launch-chrome', async () => {
      state.browser = await launchChrome({ logFile: path.join(OUT_DIR, 'chrome.log') });
      return { port: state.browser.port, version: state.browser.versionInfo?.Browser };
    });

    await step('open-gui', async () => {
      state.gui = await state.browser.newPage();
      await state.gui.enableRuntime();
      await state.gui.goto(state.inst.url, { timeoutMs: 45_000 });
      await state.gui.waitFor(
        `document.querySelector('#root') && document.querySelector('#root').children.length > 0`,
        { timeoutMs: 60_000, label: 'SPA mount' },
      );
      const finalUrl = await state.gui.evaluate('location.href');
      if (!/^http:\/\/127\.0\.0\.1:\d+\//.test(finalUrl)) {
        throw new Error(`GUI 最终地址不是隔离实例（禁止 3080）：${finalUrl}`);
      }
      return { finalUrl, title: await state.gui.title() };
    });

    await step('dismiss-overlays', async () => {
      const clicked = await dismissOverlays(state.gui);
      await screenshot(state.gui, '01-gui-landing.png');
      return { clicked };
    });

    await step('create-session', async () => {
      const session = await establishSession(state.gui);
      await screenshot(state.gui, '02-gui-session.png');
      summary.gui = { sessionId: session.sessionId };
      return session;
    });

    await step('client-plugin-dock', async () => {
      try {
        await waitForValue(state.gui, `!!document.querySelector('[data-dsh-camera-dock]')`, {
          timeoutMs: 45_000,
          label: '[data-dsh-camera-dock]',
        });
      } catch (error) {
        const diag = await dumpPageDiagnostics(state.gui);
        writeJson(path.join(OUT_DIR, 'failure-dock-dom.json'), {
          error: error.message,
          console: state.gui.consoleMessages,
          pageErrors: state.gui.pageErrors,
          diag,
        });
        throw new Error(
          `45s 内未出现相机 dock 按钮（定位：client.js 是否被 ModuleLoader 加载 / composer.dock slot 注册失败）。console=${JSON.stringify(state.gui.consoleMessages.slice(-8))} errors=${JSON.stringify(state.gui.pageErrors.slice(-5))}`,
        );
      }
      const dock = await state.gui.evaluate(`(() => {
        const el = document.querySelector('[data-dsh-camera-dock]');
        return { text: (el.innerText || el.textContent || '').trim(), aria: el.getAttribute('aria-label'), tag: el.tagName };
      })()`);
      return dock;
    });

    await step('open-camera-panel', async () => {
      await state.gui.click('[data-dsh-camera-dock]');
      // 面板 phase: loading → ready | error
      const panelPhase = await waitForValue(
        state.gui,
        `(() => { const p = document.querySelector('[data-dsh-camera-panel]'); return p ? p.getAttribute('data-dsh-camera-panel') : null; })()`,
        { timeoutMs: PANEL_READY_TIMEOUT, label: '[data-dsh-camera-panel]' },
      );
      if (panelPhase === 'error') {
        const errorInfo = await state.gui.evaluate(`(() => {
          const e = document.querySelector('[data-dsh-camera-error]');
          return { code: e ? e.getAttribute('data-dsh-camera-error') : null, text: e ? (e.innerText || e.textContent || '').trim() : '' };
        })()`);
        await screenshot(state.gui, 'failure-panel-error.png');
        throw new Error(`相机面板返回错误（定位：RPC camera.arm/server）：${JSON.stringify(errorInfo)}`);
      }
      await waitForValue(
        state.gui,
        `(() => { const p = document.querySelector('[data-dsh-camera-panel]'); return !!p && p.getAttribute('data-dsh-camera-panel') === 'ready'; })()`,
        { timeoutMs: PANEL_READY_TIMEOUT, label: 'panel ready' },
      );
      await waitForValue(
        state.gui,
        `(() => { const u = document.querySelector('[data-dsh-camera-url]'); const v = u ? (u.getAttribute('data-dsh-camera-url') || u.textContent || '') : ''; return v.startsWith('http') ? v : null; })()`,
        { timeoutMs: PANEL_READY_TIMEOUT, label: '[data-dsh-camera-url]' },
      );
      const panel = await state.gui.evaluate(`(() => {
        const urlEl = document.querySelector('[data-dsh-camera-url]');
        const qr = document.querySelector('[data-dsh-camera-qr]');
        const path = qr ? qr.querySelector('path') : null;
        const countEl = document.querySelector('[data-dsh-camera-count]');
        return {
          url: urlEl ? (urlEl.getAttribute('data-dsh-camera-url') || urlEl.textContent || '').trim() : '',
          qrPathLength: path ? (path.getAttribute('d') || '').length : 0,
          qrViewBox: qr ? qr.getAttribute('viewBox') : null,
          count: countEl ? Number(countEl.getAttribute('data-dsh-camera-count') || countEl.textContent || 0) : 0,
          error: document.querySelector('[data-dsh-camera-error]')?.getAttribute('data-dsh-camera-error') ?? null,
        };
      })()`);
      await screenshot(state.gui, '03-gui-panel.png');
      if (!/^https?:\/\/\d{1,3}(\.\d{1,3}){3}:\d+\/c\/[A-Za-z0-9_-]{16,64}$/.test(panel.url)) {
        throw new Error(`面板 URL 不符合 LAN 链接格式（定位：rpc camera.arm / server.buildUrl）：${panel.url}`);
      }
      if (panel.qrPathLength < 100) throw new Error(`二维码 path 为空/过短（定位：rpc camera.arm / qr.js）：${panel.qrPathLength}`);
      summary.gui.panel = panel;
      return panel;
    });

    await step('open-phone-page', async () => {
      state.phone = await state.browser.newPage(summary.gui.panel.url);
      await state.phone.enableRuntime();
      state.phoneNet = await state.phone.startNetworkCapture();
      await state.phone.setMobileViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
      await state.phone.waitFor(`!!document.querySelector('[data-cam-page]')`, {
        timeoutMs: 30_000,
        label: '[data-cam-page]',
      });
      // 页面内联 JS 是页面末尾执行的：等其配置对象与事件处理器就绪
      await state.phone.waitFor(`typeof window.__DSH_CAMERA__ === 'object' && !!document.querySelector('[data-cam-input-gallery]')`, {
        timeoutMs: 15_000,
        label: 'mobile page JS ready',
      });
      await delay(200);
      const pageInfo = await state.phone.evaluate(`(() => {
        const page = document.querySelector('[data-cam-page]');
        const status = document.querySelector('[data-cam-status]');
        const count = document.querySelector('[data-cam-count]');
        return {
          href: location.href,
          title: document.title,
          lang: document.documentElement.lang,
          pageAttr: page ? page.getAttribute('data-cam-page') : null,
          status: status ? status.getAttribute('data-cam-status') : null,
          count: count ? Number(count.getAttribute('data-cam-count') || count.textContent || 0) : 0,
          hasGalleryInput: !!document.querySelector('[data-cam-input-gallery]'),
          hasCaptureInput: !!document.querySelector('[data-cam-input-capture]'),
        };
      })()`);
      if (!pageInfo.hasGalleryInput) throw new Error('手机页缺少 [data-cam-input-gallery]（定位：lib/page.js）');
      await screenshot(state.phone, '04-phone-page.png');
      summary.phone = pageInfo;
      return pageInfo;
    });

    await step('upload-test-photos', async () => {
      const images = writeTestImages(IMAGE_DIR, { count: imageCount });
      const video = writeTestVideo(IMAGE_DIR);
      const videoCount = 1;
      const totalCount = imageCount + videoCount;
      logger(
        `[e2e]   test media: ${[...images, video]
          .map((file) => `${path.basename(file)}(${fs.statSync(file).size}B)`)
          .join(', ')}`,
      );

      // 先确认是「手动发送」模式：初始发送按钮禁用、待发送 0、没有任何上传请求。
      const baseline = await state.phone.evaluate(`(() => {
        const send = document.querySelector('[data-cam-send]');
        return {
          sendDisabled: send ? send.disabled : null,
          pending: Number(document.body.getAttribute('data-cam-pending') || 0),
          uploads: 0,
        };
      })()`);
      if (baseline.sendDisabled !== true) throw new Error(`初始发送按钮应禁用（定位：page.js 手动发送模式）：${JSON.stringify(baseline)}`);

      await state.phone.setFileInputFiles('[data-cam-input-gallery]', [...images, video]);

      // 选完照片后只做压缩预览，不应自动上传。
      await waitForValue(
        state.phone,
        `(() => {
          const send = document.querySelector('[data-cam-send]');
          const pending = Number(document.body.getAttribute('data-cam-pending') || 0);
          return !!send && !send.disabled && pending >= ${totalCount} ? pending : null;
        })()`,
        { timeoutMs: 60_000, label: `send button ready (pending >= ${totalCount})` },
      );
      const readyState = await state.phone.evaluate(`(() => {
        const send = document.querySelector('[data-cam-send]');
        const label = document.querySelector('[data-cam-send-label]');
        const status = document.querySelector('[data-cam-status]');
        return {
          pending: Number(document.body.getAttribute('data-cam-pending') || 0),
          sendDisabled: send ? send.disabled : null,
          sendLabel: label ? (label.textContent || '').trim() : '',
          sendCount: send ? Number(send.getAttribute('data-cam-send-count') || 0) : 0,
          status: status ? status.getAttribute('data-cam-status') : null,
        };
      })()`);
      const uploadRequestsBeforeSend = state.phoneNet
        ? state.phoneNet.requests.filter((r) => /\/upload/.test(r.url)).length
        : 0;
      await screenshot(state.phone, '05a-phone-ready.png');
      if (uploadRequestsBeforeSend > 0) {
        throw new Error(`选择照片后不应自动上传（应等用户点发送）：已看到 ${uploadRequestsBeforeSend} 个 upload 请求`);
      }
      if (!new RegExp(`发送 ${totalCount} 项|Send ${totalCount} items`).test(readyState.sendLabel)) {
        throw new Error(`发送按钮文案应显示待发送数量：${JSON.stringify(readyState)}`);
      }

      // 用户点「发送」后才上传。
      await state.phone.click('[data-cam-send]');
      const started = Date.now();
      let last = null;
      let sentSnapshot = null;
      while (Date.now() - started < PHONE_DONE_TIMEOUT) {
        last = await state.phone.evaluate(`(() => {
          const status = document.querySelector('[data-cam-status]');
          const count = document.querySelector('[data-cam-count]');
          const error = document.querySelector('[data-cam-error]');
          return {
            status: status ? status.getAttribute('data-cam-status') : null,
            count: count ? Number(count.getAttribute('data-cam-count') || count.textContent || 0) : 0,
            pending: Number(document.body.getAttribute('data-cam-pending') || 0),
            error: error ? (error.innerText || error.textContent || '').trim().slice(0, 500) : '',
          };
        })()`);
        if (last.status === 'error') {
          await screenshot(state.phone, 'failure-phone-upload.png');
          const uploadEvidence = {
            last,
            baseline,
            readyState,
            phoneConsole: state.phone.consoleMessages.slice(-10),
            phonePageErrors: state.phone.pageErrors.slice(-10),
            network: state.phoneNet
              ? {
                  requests: state.phoneNet.requests.filter((r) => /\/upload/.test(r.url)),
                  responses: state.phoneNet.responses.filter((r) => /\/upload/.test(r.url)),
                  failures: state.phoneNet.failures,
                  bodies: state.phoneNet.bodies,
                }
              : null,
          };
          writeJson(path.join(OUT_DIR, 'failure-upload-net.json'), uploadEvidence);
          throw new Error(`手机页上传失败（定位：page.js fetch / server upload / injector.deliver）：${JSON.stringify(uploadEvidence).slice(0, 1800)}`);
        }
        if (last.count >= totalCount && last.pending === 0) {
          sentSnapshot = last;
          break;
        }
        await delay(250);
      }
      await screenshot(state.phone, '05-phone-done.png');
      if (!sentSnapshot) {
        throw new Error(`点发送后等待上传完成超时（${PHONE_DONE_TIMEOUT}ms）：${JSON.stringify(last)}`);
      }
      if (!last || last.count < totalCount) {
        throw new Error(`手机页 data-cam-count=${last?.count} 小于上传内容数 ${totalCount}`);
      }
      summary.phone.upload = {
        ...last,
        images,
        video,
        timeout: false,
        manual: true,
        pendingBeforeSend: readyState.pending,
        sendLabel: readyState.sendLabel,
        uploadRequestsBeforeSend,
      };
      if (state.phoneNet) {
        summary.phone.network = {
          requests: state.phoneNet.requests.filter((r) => /\/upload/.test(r.url)),
          responses: state.phoneNet.responses.filter((r) => /\/upload/.test(r.url)),
          failures: state.phoneNet.failures,
          bodies: state.phoneNet.bodies,
          console: state.phone.consoleMessages.slice(-10),
          pageErrors: state.phone.pageErrors.slice(-10),
        };
        const uploadResponses = summary.phone.network.responses.filter((r) => /\/upload/.test(r.url));
        if (uploadResponses.length === 0 || uploadResponses.some((r) => r.status >= 400)) {
          writeJson(path.join(OUT_DIR, 'failure-upload-net.json'), summary.phone.network);
          throw new Error(`上传响应异常（定位：server upload）：${JSON.stringify(uploadResponses)}`);
        }
      }
      return {
        status: sentSnapshot.status,
        count: sentSnapshot.count,
        pendingAfterSend: sentSnapshot.pending,
        manual: true,
        pendingBeforeSend: readyState.pending,
        sendLabel: readyState.sendLabel,
        uploadRequestsBeforeSend,
        images: images.map((file) => path.basename(file)),
        video: path.basename(video),
        totalCount,
      };
    });

    await step('desktop-counter', async () => {
      // 回到 GUI 标签（后台标签定时器会被 Chrome 节流，必须激活）
      await state.browser.send('Target.activateTarget', { targetId: state.gui.targetId });
      const expected = summary.phone.upload.count;
      await waitForValue(
        state.gui,
        `(() => { const el = document.querySelector('[data-dsh-camera-count]'); if (!el) return null; const n = Number(el.getAttribute('data-dsh-camera-count') || el.textContent || 0); return n >= ${expected} ? n : null; })()`,
        { timeoutMs: 20_000, label: `panel count >= ${expected}` },
      );
      const count = await state.gui.evaluate(
        `(() => { const el = document.querySelector('[data-dsh-camera-count]'); return el ? Number(el.getAttribute('data-dsh-camera-count') || el.textContent || 0) : 0; })()`,
      );
      return { count };
    });

    await step('gui-image-message', async () => {
      let snapshot;
      try {
        snapshot = await waitForConversationImage(state.gui, { timeoutMs: GUI_IMAGE_TIMEOUT, minCount: imageCount });
      } catch (error) {
        const diag = await dumpPageDiagnostics(state.gui);
        writeJson(path.join(OUT_DIR, 'failure-conversation-dom.json'), {
          error: error.message,
          console: state.gui.consoleMessages,
          pageErrors: state.gui.pageErrors,
          diag,
        });
        throw error;
      }
      // 视频以文件卡片进入对话：等文件名出现在会话区域。
      await waitForValue(
        state.gui,
        `(() => {
          const region = document.querySelector('[data-conversation-content]');
          return !!region && (region.innerText || '').includes('cam-test-video.mp4');
        })()`,
        { timeoutMs: 30_000, label: 'video file card in conversation' },
      );
      await screenshot(state.gui, '06-gui-conversation.png');
      summary.gui.conversationImages = { count: snapshot.count, srcs: snapshot.srcs, blobUrls: snapshot.blobUrls, canvasCount: snapshot.canvasCount };
      return { count: snapshot.count, blobUrls: snapshot.blobUrls, srcs: snapshot.srcs.slice(0, 4) };
    });

    await step('close-panel-and-screenshot', async () => {
      // 关掉面板，让对话里的照片消息可见（最终人工验收截图）。
      await state.gui.evaluate(`(() => {
        const close = document.querySelector('[data-dsh-camera-panel] [aria-label="关闭"], [data-dsh-camera-panel] button[aria-label="Close"]');
        if (close) { close.click(); return 'close-button'; }
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        return 'escape';
      })()`);
      await waitForValue(
        state.gui,
        `!document.querySelector('[data-dsh-camera-panel]')`,
        { timeoutMs: 8_000, label: 'panel closed' },
      );
      await delay(600);
      await screenshot(state.gui, '07-gui-images-visible.png');
      const visible = await state.gui.evaluate(`(() => {
        const region = document.querySelector('[data-conversation-content]');
        const imgs = region ? [...region.querySelectorAll('img')].filter((img) => (img.getAttribute('src') || '').length > 0) : [];
        return { images: imgs.length, panelOpen: !!document.querySelector('[data-dsh-camera-panel]') };
      })()`);
      return visible;
    });

    await step('persisted-session-log', async () => {
      // 给持久化一点点时间（正常注入是同步 await prompt，日志应已落盘）
      await delay(500);
      const persisted = inspectPersistedSession(DEFAULTS.home, summary.gui.sessionId, startedAt);
      summary.artifacts.persistedSession = persisted;
      if (!persisted.sessionIdMatched) {
        return { warning: '未找到本会话的 jsonl 日志（不阻塞 GUI 层断言）', ...persisted };
      }
      if (persisted.imageBlocks < imageCount) {
        throw new Error(
          `会话日志里 image 块数量 ${persisted.imageBlocks} < 上传张数 ${imageCount}（定位：inject.js / session 持久化）：${JSON.stringify(persisted)}`,
        );
      }
      if (persisted.fileBlocks < 1) {
        throw new Error(
          `会话日志里 file 块数量 ${persisted.fileBlocks} < 1（视频未作为文件附件落库，定位：inject.js fileUploads）：${JSON.stringify(persisted)}`,
        );
      }
      return persisted;
    });

    summary.ok = true;
  } catch (error) {
    summary.error = { message: error.message, step: error.step, stack: error.stack };
    // 失败取证：截图 + DOM + 控制台 + 实例日志
    for (const [name, page] of [
      ['gui', state.gui],
      ['phone', state.phone],
    ]) {
      if (!page) continue;
      try {
        await screenshot(page, `failure-${name}.png`);
      } catch {
        /* ignore */
      }
      try {
        writeJson(path.join(OUT_DIR, `failure-${name}-dom.json`), {
          console: page.consoleMessages,
          pageErrors: page.pageErrors,
          diag: await dumpPageDiagnostics(page),
        });
      } catch {
        /* ignore */
      }
    }
    if (state.inst) {
      try {
        fs.copyFileSync(state.inst.logFile, path.join(OUT_DIR, 'instance.log'));
      } catch {
        /* ignore */
      }
    }
    logger(`\n[e2e] FAILED at step "${error.step ?? 'unknown'}": ${error.message}`);
  } finally {
    summary.finishedAt = new Date().toISOString();
    summary.durationMs = Date.now() - startedAt;
    try {
      if (state.browser) await state.browser.close();
    } catch (error) {
      logger(`[e2e] chrome close failed: ${error.message}`);
    }
    try {
      if (state.inst) await state.inst.stop();
    } catch (error) {
      logger(`[e2e] instance stop failed: ${error.message}`);
    }
    stopStrayTestChrome({ log: logger });
    writeJson(path.join(OUT_DIR, 'summary.json'), summary);
  }

  logger(`\n[e2e] ${summary.ok ? 'PASS' : 'FAIL'} (${summary.durationMs}ms)`);
  logger(`[e2e] evidence: ${path.relative(REPO_ROOT, OUT_DIR)}/`);
  if (summary.screenshots.length > 0) logger(`[e2e] screenshots: ${summary.screenshots.join(', ')}`);
  if (!summary.ok) {
    const error = new Error(`E2E 失败：${summary.error.message}`);
    error.summary = summary;
    throw error;
  }
  return summary;
}

// CLI
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runE2E().then(
    (summary) => {
      console.log(`\n[e2e] steps: ${summary.steps.map((s) => `${s.ok ? '✔' : '✖'}${s.name}(${s.ms}ms)`).join(' → ')}`);
      process.exit(0);
    },
    (error) => {
      console.error(`\n[e2e] ${error.message}`);
      if (error.summary?.error?.stack) console.error(error.summary.error.stack);
      process.exit(1);
    },
  );
}
