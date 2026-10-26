// dsh-camera 全屏相机（HTTPS/getUserMedia）E2E：
// 隔离 profile 开启 https，用 Chrome 的 fake media device + secure-context 覆盖，
// 验证：HTTP 页出现 HTTPS 引导 → 页面内全屏相机取景 → 连拍 2 张进入待发送 →
// 手动发送 → 桌面面板计数/对话图片/会话日志（与 HTTP E2E 同一套断言口径）。
//
// 运行：node scripts/e2e-camera.mjs
// 只操作自己的 DSH_HOME、端口 3097 与 /tmp 下 Chrome，绝不碰正在运行的 DSH。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import zlib from 'node:zlib';

import { launchChrome } from './lib/cdp.mjs';
import { prepareProfile, startInstance, stopInstance, stopStrayTestChrome } from './lib/dsh-instance.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const OUT_DIR = path.join(REPO_ROOT, 'verification', 'e2e-camera');
const HOME = '/tmp/dsh-cam-home-https';
const PROFILE = 'cam-https';
const GUI_PORT = 3097;
const LAN_HTTP_PORT = 3599;
const LAN_HTTPS_PORT = 3600;
const LAN_IP = '10.10.10.10';
const CHROME_PROFILE = '/tmp/cam-chrome-camera-profile';

class E2EError extends Error {
  constructor(step, message, detail = undefined) {
    super(`[${step}] ${message}`);
    this.name = 'E2EError';
    this.step = step;
    this.detail = detail;
  }
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

async function step(summary, name, fn) {
  const at = Date.now();
  console.log(`\n[e2e-camera] ▶ ${name}`);
  try {
    const detail = await fn();
    summary.steps.push({ name, ok: true, ms: Date.now() - at, detail: detail ?? null });
    console.log(`[e2e-camera] ✔ ${name} (${Date.now() - at}ms) ${detail ? JSON.stringify(detail).slice(0, 400) : ''}`);
    return detail;
  } catch (error) {
    summary.steps.push({ name, ok: false, ms: Date.now() - at, error: error.message });
    throw error;
  }
}

async function writeProfilePatch() {
  const profileDir = path.join(HOME, 'profiles', PROFILE);
  fs.mkdirSync(profileDir, { recursive: true });
  fs.writeFileSync(
    path.join(profileDir, 'cordis.patch.yml'),
    `# e2e-camera: enable the optional HTTPS fullscreen camera on a fixed LAN port\n- id: dsh-camera\n  config:\n    port: ${LAN_HTTP_PORT}\n    https: true\n    httpsPort: ${LAN_HTTPS_PORT}\n`,
  );
}

async function dismissOverlays(page) {
  const clicked = [];
  for (let round = 0; round < 12; round += 1) {
    const hit = await page.evaluate(`(() => {
      const wanted = ['继续', 'Continue', '跳过', 'Skip', '关闭', 'Close', '知道了', '我知道了', 'Got it'];
      const buttons = [...document.querySelectorAll('button,[role="button"]')];
      const el = buttons.find((e) => {
        const label = (e.getAttribute('aria-label') || '').trim();
        const text = (e.innerText || e.textContent || '').trim();
        return wanted.includes(text) || wanted.includes(label);
      });
      if (!el) return null;
      el.click();
      return (el.innerText || el.textContent || '').trim() || el.getAttribute('aria-label');
    })()`);
    if (hit === null) {
      await delay(400);
      if (clicked.length > 0) break;
      if (round >= 3) break;
      continue;
    }
    clicked.push(hit);
    await delay(500);
  }
  return clicked;
}

async function waitFor(page, expression, label, timeoutMs = 30000) {
  return page.waitFor(expression, { timeoutMs, label });
}

function readSessionLogText(file) {
  const buffer = fs.readFileSync(file);
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
  const starts = [];
  let cursor = 0;
  while (cursor < buffer.length) {
    const hit = buffer.indexOf(magic, cursor);
    if (hit < 0) break;
    starts.push(hit);
    cursor = hit + magic.length;
  }
  const chunks = [];
  for (let i = 0; i < starts.length; i += 1) {
    try {
      chunks.push(zlib.zstdDecompressSync(buffer.subarray(starts[i], starts[i + 1] ?? buffer.length)));
    } catch {
      /* not a frame */
    }
  }
  return Buffer.concat(chunks).toString('utf8');
}

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
      else if (/\.jsonl(\.zstd)?$/.test(entry.name) && stat.mtimeMs >= runStartMs - 2000) files.push(full);
    }
  };
  walk(home, 0);
  const result = { files: [], imageBlocks: 0, fileBlocks: 0, userImageMessages: 0, sessionIdMatched: false };
  for (const file of files) {
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
      const images = json.match(/"type":"image"/g);
      if (!images) continue;
      result.imageBlocks += images.length;
      result.fileBlocks += (json.match(/"type":"file"/g) || []).length;
      if (value?.type === 'user/message') result.userImageMessages += 1;
    }
  }
  return result;
}

async function run() {
  const summary = { ok: false, startedAt: new Date().toISOString(), home: HOME, profile: PROFILE, guiPort: GUI_PORT, lan: { ip: LAN_IP, http: LAN_HTTP_PORT, https: LAN_HTTPS_PORT }, steps: [], screenshots: [] };
  const runStartMs = Date.now();
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  ensureDir(OUT_DIR);
  const shot = async (page, name) => {
    const rel = path.join('verification', 'e2e-camera', name);
    await page.screenshot(path.join(REPO_ROOT, rel));
    summary.screenshots.push(rel);
    return rel;
  };
  let browser = null;
  let inst = null;
  try {
    await step(summary, 'prepare-profile', async () => {
      await prepareProfile({ home: HOME, profile: PROFILE, repo: REPO_ROOT, log: console.log });
      await writeProfilePatch();
      return { profilePatch: path.join(HOME, 'profiles', PROFILE, 'cordis.patch.yml') };
    });

    await step(summary, 'start-instance', async () => {
      await stopInstance({ home: HOME, profile: PROFILE, port: GUI_PORT, log: console.log });
      inst = await startInstance({ home: HOME, profile: PROFILE, port: GUI_PORT, logFile: '/tmp/cam-https-instance.log', log: console.log });
      return { url: inst.url.replace(/token=[^&]+/, 'token=***'), pid: inst.pid };
    });

    await step(summary, 'launch-chrome', async () => {
      browser = await launchChrome({
        userDataDir: CHROME_PROFILE,
        logFile: path.join(OUT_DIR, 'chrome.log'),
        extraArgs: [
          '--use-fake-device-for-media-stream',
          '--use-fake-ui-for-media-stream',
          `--unsafely-treat-insecure-origin-as-secure=http://${LAN_IP}:${LAN_HTTP_PORT}`,
        ],
      });
      return { port: browser.port, version: browser.versionInfo?.Browser };
    });

    let gui;
    let sessionId = '';
    await step(summary, 'open-gui-and-create-session', async () => {
      gui = await browser.newPage();
      await gui.enableRuntime();
      await gui.goto(inst.url, { timeoutMs: 45000 });
      await waitFor(gui, `document.querySelector('#root') && document.querySelector('#root').children.length > 0`, 'SPA mount', 60000);
      await delay(1500);
      await dismissOverlays(gui);
      await waitFor(gui, `!!document.querySelector('[data-composer-input]')`, 'composer', 20000);
      await dismissOverlays(gui);
      const text = `dsh-camera camera e2e ${Date.now()}`;
      await gui.type('[data-composer-input]', text);
      await waitFor(gui, `(() => { const b = document.querySelector('button[aria-label="发送消息"]'); return !!b && !b.disabled; })()`, 'send enabled', 20000);
      await gui.evaluate(`(() => { const b = document.querySelector('button[aria-label="发送消息"]'); if (b) b.click(); return true; })()`);
      await waitFor(gui, `(() => { const r = document.querySelector('[data-conversation-content]'); return r ? r.getAttribute('data-content-phase') === 'active' : false; })()`, 'conversation active', 30000);
      sessionId = await gui.evaluate(`document.querySelector('[data-conversation-session]')?.getAttribute('data-conversation-session') ?? ''`);
      await shot(gui, '01-gui-session.png');
      return { sessionId };
    });

    let phoneUrl = '';
    let httpsUrl = '';
    await step(summary, 'open-camera-panel', async () => {
      await waitFor(gui, `!!document.querySelector('[data-dsh-camera-dock]')`, 'camera dock', 30000);
      await gui.click('[data-dsh-camera-dock]');
      await waitFor(gui, `(() => { const p = document.querySelector('[data-dsh-camera-panel]'); return p && p.getAttribute('data-dsh-camera-panel') === 'ready'; })()`, 'panel ready', 30000);
      const panel = await gui.evaluate(`(() => {
        const urlEl = document.querySelector('[data-dsh-camera-url]');
        const httpsRow = document.querySelector('[data-dsh-camera-https]');
        return {
          url: urlEl ? (urlEl.getAttribute('data-dsh-camera-url') || urlEl.textContent || '').trim() : '',
          https: httpsRow ? httpsRow.getAttribute('data-dsh-camera-https') : null,
        };
      })()`);
      phoneUrl = panel.url;
      await shot(gui, '02-gui-panel-https.png');
      return panel;
    });

    await step(summary, 'open-phone-page', async () => {
      const phone = await browser.newPage(phoneUrl);
      await phone.enableRuntime();
      await phone.startNetworkCapture({ captureBodies: true });
      await phone.setMobileViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
      await waitFor(phone, `!!document.querySelector('[data-cam-page]')`, 'phone page', 30000);
      await waitFor(phone, `typeof window.__DSH_CAMERA__ === 'object'`, 'phone config', 15000);
      await delay(400);
      const info = await phone.evaluate(`(() => {
        const hint = document.querySelector('[data-cam-secure-hint]');
        const cta = document.querySelector('[data-cam-secure-open]');
        return {
          href: location.href,
          isSecureContext: window.isSecureContext,
          cfgSecure: window.__DSH_CAMERA__.secure,
          hintVisible: hint ? !hint.hidden : false,
          ctaHref: cta ? cta.getAttribute('href') : null,
          hasCameraMarkup: !!document.querySelector('[data-cam-camera]'),
        };
      })()`);
      httpsUrl = info.ctaHref || '';
      await shot(phone, '03-phone-secure-hint.png');
      if (info.cfgSecure !== false) throw new E2EError('open-phone-page', `HTTP page should be secure=false: ${JSON.stringify(info)}`);
      if (info.hintVisible !== true) throw new E2EError('open-phone-page', `HTTPS 引导未显示：${JSON.stringify(info)}`);
      if (!/^https:\/\//.test(httpsUrl)) throw new E2EError('open-phone-page', `https 引导链接异常：${JSON.stringify(info)}`);
      summary.phone = info;
      summary.httpsUrl = httpsUrl;
      return info;
    });

    await step(summary, 'fullscreen-camera-burst', async () => {
      // 手机页是后打开的 tab（Browser.pages 是 Set，按插入顺序）。
      const target = [...browser.pages].find((page) => page !== gui);
      if (!target) throw new Error('phone page not found');
      await target.click('[data-cam-capture-btn]');
      await waitFor(target, `(() => { const c = document.querySelector('[data-cam-camera]'); return !!c && !c.hidden; })()`, 'camera overlay visible', 10000);
      await waitFor(target, `(() => { const v = document.querySelector('[data-cam-video]'); return !!v && v.readyState >= 2 && v.videoWidth > 0; })()`, 'camera stream live', 15000);
      await shot(target, '04-phone-fullscreen-camera.png');
      const before = await target.evaluate(`(() => ({ pending: Number(document.body.getAttribute('data-cam-pending') || 0), uploadRequests: performance.getEntriesByType('resource').filter((e) => /\\/upload/.test(e.name)).length }))()`);
      await target.click('[data-cam-shutter]');
      await waitFor(target, `Number(document.body.getAttribute('data-cam-pending') || 0) >= 1`, 'first capture pending', 10000);
      await delay(300);
      await target.click('[data-cam-shutter]');
      await waitFor(target, `Number(document.body.getAttribute('data-cam-pending') || 0) >= 2`, 'second capture pending', 10000);

      // 同一页面内切到录像模式，录 1.2s 后停止 → 视频进入待发送（不自动上传）。
      await target.click('[data-cam-mode-video]');
      await waitFor(target, `(() => { const m = document.querySelector('[data-cam-mode-video]'); return m && m.getAttribute('aria-pressed') === 'true'; })()`, 'video mode', 10000);
      await waitFor(target, `(() => { const v = document.querySelector('[data-cam-video]'); return !!v && v.readyState >= 2 && v.videoWidth > 0; })()`, 'video-mode stream', 15000);
      await delay(400);
      await target.click('[data-cam-shutter]');
      await waitFor(target, `(() => { const t = document.querySelector('[data-cam-record-time]'); return !!t && !t.hidden; })()`, 'recording timer visible', 10000);
      await delay(1300);
      await target.click('[data-cam-shutter]');
      await waitFor(target, `Number(document.body.getAttribute('data-cam-pending') || 0) >= 3`, 'recorded video pending', 15000);
      const videoInfo = await target.evaluate(`(() => {
        const figs = [...document.querySelectorAll('[data-cam-preview]')];
        const last = figs[figs.length - 1];
        return {
          pending: Number(document.body.getAttribute('data-cam-pending') || 0),
          kind: last ? last.getAttribute('data-kind') : null,
          name: last ? last.getAttribute('data-name') : null,
          shots: (document.querySelector('[data-cam-camera-count]') || {}).textContent || '',
        };
      })()`);
      if (videoInfo.kind !== 'video') throw new E2EError('fullscreen-camera-burst', `录制结果不是视频：${JSON.stringify(videoInfo)}`);
      await shot(target, '05b-phone-recorded-video.png');
      const during = await target.evaluate(`(() => ({
        pending: Number(document.body.getAttribute('data-cam-pending') || 0),
        shots: (document.querySelector('[data-cam-camera-count]') || {}).textContent || '',
        uploadRequests: performance.getEntriesByType('resource').filter((e) => /\\/upload/.test(e.name)).length,
        overlayHidden: document.querySelector('[data-cam-camera]')?.hidden,
      }))()`);
      await shot(target, '05-phone-camera-two-shots.png');
      await target.click('[data-cam-camera-close]');
      await waitFor(target, `(() => { const c = document.querySelector('[data-cam-camera]'); return !!c && c.hidden; })()`, 'camera overlay hidden', 10000);
      const after = await target.evaluate(`(() => ({ pending: Number(document.body.getAttribute('data-cam-pending') || 0), status: document.body.getAttribute('data-cam-status') }))()`);
      if (during.pending < 3) throw new E2EError('fullscreen-camera-burst', `连拍/录像未全部进入待发送：${JSON.stringify(during)}`);
      if (during.uploadRequests > 0) throw new E2EError('fullscreen-camera-burst', `连拍时不应自动上传：${JSON.stringify(during)}`);
      summary.camera = { before, during, after, stream: true, video: videoInfo };
      return { pending: during.pending, shots: during.shots, video: videoInfo, before, after };
    });

    await step(summary, 'manual-send-and-verify', async () => {
      const target = [...browser.pages].find((page) => page !== gui);
      if (!target) throw new Error('phone page not found');
      await target.click('[data-cam-send]');
      await waitFor(target, `(() => { const c = document.querySelector('[data-cam-count]'); const p = Number(document.body.getAttribute('data-cam-pending') || 0); return c && Number(c.getAttribute('data-cam-count') || c.textContent || 0) >= 3 && p === 0; })()`, 'sent', 60000);
      await shot(target, '06-phone-sent.png');
      const phoneState = await target.evaluate(`(() => ({
        count: Number(document.querySelector('[data-cam-count]')?.getAttribute('data-cam-count') || 0),
        pending: Number(document.body.getAttribute('data-cam-pending') || 0),
      }))()`);
      if (phoneState.count < 3) throw new E2EError('manual-send-and-verify', `手机页计数 < 3：${JSON.stringify(phoneState)}`);

      await browser.send('Target.activateTarget', { targetId: gui.targetId });
      await waitFor(gui, `(() => { const r = document.querySelector('[data-conversation-content]'); if (!r) return false; return r.querySelectorAll('img').length >= 2; })()`, 'gui images', 30000);
      await waitFor(gui, `(() => {
        const r = document.querySelector('[data-conversation-content]');
        const text = r.innerText || ''; return text.includes('.mp4') || text.includes('.webm') || text.includes('.mov');
      })()`, 'gui recorded video card', 30000);
      await shot(gui, '07-gui-conversation.png');
      await delay(500);
      const persisted = inspectPersistedSession(HOME, sessionId, runStartMs);
      summary.persisted = persisted;
      if (!persisted.sessionIdMatched || persisted.imageBlocks < 2) {
        throw new E2EError('manual-send-and-verify', `会话日志未找到图片附件：${JSON.stringify(persisted)}`);
      }
      if (persisted.fileBlocks < 1) {
        throw new E2EError('manual-send-and-verify', `会话日志未找到视频文件附件：${JSON.stringify(persisted)}`);
      }
      return {
        phoneState,
        persisted: {
          imageBlocks: persisted.imageBlocks,
          fileBlocks: persisted.fileBlocks,
          userImageMessages: persisted.userImageMessages,
        },
      };
    });

    summary.ok = true;
  } catch (error) {
    summary.error = { message: error.message, step: error.step ?? null };
    console.error(`\n[e2e-camera] FAILED at "${error.step ?? 'unknown'}": ${error.message}`);
    try {
      if (gui) await shot(gui, 'failure-gui.png');
    } catch {
      /* ignore */
    }
    for (const page of browser ? [...browser.pages] : []) {
      try {
        await shot(page, `failure-${page.targetId.slice(0, 6)}.png`);
      } catch {
        /* ignore */
      }
    }
  } finally {
    summary.finishedAt = new Date().toISOString();
    summary.durationMs = Date.now() - runStartMs;
    try {
      if (browser) await browser.close();
    } catch {
      /* ignore */
    }
    try {
      await stopInstance({ home: HOME, profile: PROFILE, port: GUI_PORT, proc: inst?.proc, log: console.log });
    } catch {
      /* ignore */
    }
    try {
      stopStrayTestChrome({ chromeProfile: CHROME_PROFILE, log: console.log });
    } catch {
      /* ignore */
    }
    writeJson(path.join(OUT_DIR, 'summary.json'), summary);
  }
  console.log(`\n[e2e-camera] ${summary.ok ? 'PASS' : 'FAIL'} (${summary.durationMs}ms)`);
  console.log(`[e2e-camera] screenshots: ${summary.screenshots.join(', ')}`);
  if (!summary.ok) process.exitCode = 1;
  return summary;
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
