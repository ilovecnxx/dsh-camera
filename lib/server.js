// dsh-camera · 局域网 HTTP 服务器（DESIGN 3.6）
// 仅依赖 Node 内置模块；不 import 任何 @deepseek-ai/* 或第三方包。
//
// 路由（全部响应带 Cache-Control: no-store + X-Content-Type-Options: nosniff + CSP）：
//   GET  /                 → 302 /c/invalid
//   GET  /c/:token         → 200 手机页（page.js）；无效/过期 → 410 提示页
//   GET  /c/:token/info    → 200 {ok,value}；无效 → 404 {ok:false,error}
//   POST /c/:token/upload  → 200 {ok,value}；失败 → 4xx/5xx {ok:false,error}
//   GET  /favicon.ico      → 204
//   其他                   → 404 text

import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { lanCandidates, pickLanIp } from './lan-ip.js';
import { ensureTlsMaterial } from './tls.js';
import { readMultipart, sniffImageType } from './multipart.js';
import { renderCameraPage } from './page.js';

const TOKEN_RE = /^[A-Za-z0-9_-]{16,64}$/;
const CSP =
  "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data: blob:; connect-src 'self'; base-uri 'none'; form-action 'none'";

const HOUR_MS = 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 120 * 1000;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024; // DSH 单图上限
const DEFAULT_MAX_UPLOAD_BYTES = 24 * 1024 * 1024;
const DEFAULT_MAX_FILES = 6;
const DEFAULT_UPLOADS_PER_HOUR = 120;
const DEFAULT_PORT = 3579;

// injector 已把 RemoteError 映射成页面可直接本地化的 code（见 DESIGN 3.6 / 3.5）；
// 这些 code 原样透传，其余（意外）code 才包成 inject-failed:<code>。
const INJECT_PAGE_CODES = new Set([
  'no-image',
  'image-invalid',
  'image-too-large',
  'model-no-vision',
  'session-not-found',
  'inject-timeout',
  'inject-failed',
]);

const DEFAULT_FILENAMES = {
  'image/jpeg': 'photo.jpg',
  'image/png': 'photo.png',
  'image/webp': 'photo.webp',
  'image/gif': 'photo.gif',
};

function defaultFilename(mediaType) {
  return DEFAULT_FILENAMES[mediaType] || 'photo.jpg';
}

function escapeHtmlText(value) {
  return String(value === undefined || value === null ? '' : value).replace(
    /[&<>"']/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch],
  );
}

function baseHeaders(extra) {
  return {
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': CSP,
    ...(extra || {}),
  };
}

function sendHtml(res, status, html) {
  const body = Buffer.from(String(html), 'utf8');
  res.writeHead(
    status,
    baseHeaders({ 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': body.length }),
  );
  res.end(body);
}

function sendJson(res, status, value) {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  res.writeHead(
    status,
    baseHeaders({ 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length }),
  );
  res.end(body);
}

function sendText(res, status, text) {
  const body = Buffer.from(String(text), 'utf8');
  res.writeHead(
    status,
    baseHeaders({ 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': body.length }),
  );
  res.end(body);
}

function sendRedirect(res, location) {
  res.writeHead(302, baseHeaders({ Location: location, 'Content-Length': 0 }));
  res.end();
}

function sendEmpty(res, status) {
  res.writeHead(status, baseHeaders({ 'Content-Length': 0 }));
  res.end();
}

function sendDownload(res, status, contentType, filename, body) {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
  res.writeHead(
    status,
    baseHeaders({
      'Content-Type': contentType,
      'Content-Length': payload.length,
      'Content-Disposition': `attachment; filename="${filename}"`,
    }),
  );
  res.end(payload);
}

function errorBody(code, message) {
  return { ok: false, error: { code: String(code), message: String(message || '') } };
}

function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function normalizePort(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0 || n > 65535) return DEFAULT_PORT;
  return n;
}

function headerOf(req, name) {
  const headers = req && req.headers ? req.headers : {};
  const raw = headers[name];
  if (Array.isArray(raw)) return raw.length > 0 ? String(raw[0]) : '';
  return raw === undefined || raw === null ? '' : String(raw);
}

function langOf(req) {
  const accept = headerOf(req, 'accept-language');
  if (!accept) return 'en';
  for (const part of accept.split(',')) {
    const tag = part.split(';')[0].trim().toLowerCase();
    if (!tag) continue;
    if (tag === 'zh' || tag.startsWith('zh-')) return 'zh';
    if (tag === 'en' || tag.startsWith('en-')) return 'en';
  }
  return 'en';
}

/** 主动丢弃未读请求体，保证 4xx 响应能写出去。 */
function drainRequest(req) {
  try {
    if (req && typeof req.on === 'function') req.on('error', () => {});
    if (req && typeof req.resume === 'function') req.resume();
  } catch {
    // ignore
  }
}

function renderExpiredPage(lang) {
  const htmlLang = lang === 'zh' ? 'zh' : 'en';
  return `<!doctype html>
<html lang="${htmlLang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#0b1220" media="(prefers-color-scheme: dark)">
<meta name="theme-color" content="#eef2f7" media="(prefers-color-scheme: light)">
<title>链接已失效 / Link expired</title>
<style>
:root{color-scheme:light dark;--bg:#eef2f7;--card:#ffffff;--text:#0f172a;--muted:#64748b;--border:rgba(15,23,42,.1);--radius:22px}
@media (prefers-color-scheme:dark){:root{--bg:#070b14;--card:#111a2c;--text:#e8eef8;--muted:#93a4bb;--border:rgba(148,163,184,.18)}}
*,*::before,*::after{box-sizing:border-box}
html,body{margin:0;min-height:100%}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Noto Sans SC",sans-serif;background-color:var(--bg);color:var(--text);min-height:100dvh;display:flex;align-items:center;justify-content:center;padding:calc(env(safe-area-inset-top,0px) + 24px) 20px calc(env(safe-area-inset-bottom,0px) + 24px);line-height:1.6;text-align:center}
.card{max-width:420px;width:100%;background:var(--card);border:1px solid var(--border);border-radius:var(--radius);padding:30px 24px;box-shadow:0 24px 60px -32px rgba(15,23,42,.5)}
.icon{font-size:40px;line-height:1;margin-bottom:14px}
h1{margin:0 0 10px;font-size:20px}
p{margin:8px 0 0;color:var(--muted);font-size:15px}
.en{margin-top:12px;font-size:13px;opacity:.85}
</style>
</head>
<body data-cam-page="expired" data-cam-expired>
<main class="card">
<div class="icon" aria-hidden="true">⏳</div>
<h1>链接已失效 / Link expired</h1>
<p>请在电脑上重新打开拍照面板，获取新的二维码或链接。</p>
<div class="en">Please reopen the camera panel on your computer to get a fresh QR code or link.</div>
</main>
</body>
</html>`;
}

function renderSetupPage(lang, info = {}) {
  const zh = lang === 'zh';
  const httpsLine = info.httpsEnabled
    ? (zh
        ? `HTTPS 已开启：<strong>https://${escapeHtmlText(info.lanIp || '127.0.0.1')}:${escapeHtmlText(String(info.httpsPort || ''))}</strong>`
        : `HTTPS is enabled: <strong>https://${escapeHtmlText(info.lanIp || '127.0.0.1')}:${escapeHtmlText(String(info.httpsPort || ''))}</strong>`)
    : (zh
        ? '当前未开启 HTTPS：在电脑上的插件配置里设置 <code>https: true</code> 后重试。'
        : 'HTTPS is not enabled yet: set <code>https: true</code> in the plugin config and retry.');
  const title = zh ? '全屏相机证书安装' : 'Fullscreen camera certificate setup';
  return `<!doctype html>
<html lang="${zh ? 'zh' : 'en'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#0b1220" media="(prefers-color-scheme: dark)">
<meta name="theme-color" content="#eef2f7" media="(prefers-color-scheme: light)">
<title>${title}</title>
<style>
:root{color-scheme:light dark;--bg:#eef2f7;--card:#ffffff;--text:#0f172a;--muted:#64748b;--accent:#2563eb;--border:rgba(15,23,42,.1);--radius:20px}
@media (prefers-color-scheme:dark){:root{--bg:#070b14;--card:#111a2c;--text:#e8eef8;--muted:#93a4bb;--border:rgba(148,163,184,.18);--accent:#3b82f6}}
*,*::before,*::after{box-sizing:border-box}
html,body{margin:0;min-height:100%}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Noto Sans SC",sans-serif;background:var(--bg);color:var(--text);min-height:100dvh;padding:calc(env(safe-area-inset-top,0px) + 22px) 18px calc(env(safe-area-inset-bottom,0px) + 30px);line-height:1.65}
.shell{max-width:520px;margin:0 auto;display:flex;flex-direction:column;gap:14px}
.card{background:var(--card);border:1px solid var(--border);border-radius:var(--radius);padding:20px}
h1{margin:0 0 8px;font-size:21px;line-height:1.3}
p{margin:0 0 10px;color:var(--muted);font-size:14px}
ol{margin:0;padding-left:20px;font-size:14px}
li{margin:6px 0}
.btn{display:flex;align-items:center;justify-content:center;gap:8px;min-height:52px;border-radius:16px;background:var(--accent);color:#fff;text-decoration:none;font-weight:650;font-size:16px}
.btn.ghost{background:transparent;color:var(--text);border:1px solid var(--border)}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px}
.note{font-size:13px;color:var(--muted)}
.warn{color:#b45309}
</style>
</head>
<body>
<div class="shell">
<div class="card">
<h1>${title}</h1>
<p>${httpsLine}</p>
<p>${zh
  ? 'iPhone 的 Safari 只有在 HTTPS（受信任证书）下才允许网页直接调用相机：全屏取景、可连拍、<strong>无闪光灯</strong>。本证书由插件在电脑本机生成，只用于这个局域网地址。'
  : 'iOS Safari only allows in-page camera access (fullscreen preview, burst capture, <strong>no flash</strong>) over trusted HTTPS. The certificate is generated locally on your computer and only covers this LAN address.'}</p>
</div>
<div class="card">
<h1 style="font-size:17px">${zh ? 'iPhone / iPad' : 'iPhone / iPad'}</h1>
<ol>
<li>${zh ? '点下面的「下载 iPhone 证书」，允许下载描述文件。' : 'Tap “Download iPhone profile” below and allow the download.'}</li>
<li>${zh ? '打开 设置 → 已下载描述文件 → 安装（需要输入锁屏密码）。' : 'Open Settings → Profile Downloaded → Install (passcode required).'}</li>
<li>${zh ? '设置 → 通用 → 关于本机 → 证书信任设置 → 打开「dsh-camera local CA」。' : 'Settings → General → About → Certificate Trust Settings → enable “dsh-camera local CA”.'}</li>
<li>${zh ? '回到拍照页，点「全屏相机」即可。' : 'Go back to the camera page and tap “Fullscreen camera”.'}</li>
</ol>
<a class="btn" href="/ca.mobileconfig" download>${zh ? '下载 iPhone 证书（.mobileconfig）' : 'Download iPhone profile (.mobileconfig)'}</a>
</div>
<div class="card">
<h1 style="font-size:17px">Android</h1>
<ol>
<li>${zh ? '点下面的「下载 CA 证书（.crt）」。' : 'Tap “Download CA certificate (.crt)” below.'}</li>
<li>${zh ? '设置 → 安全 → 加密与凭据 → 安装证书 → CA 证书，选择刚下载的文件。' : 'Settings → Security → Encryption & credentials → Install a certificate → CA certificate, pick the downloaded file.'}</li>
<li>${zh ? '回到拍照页，点「全屏相机」。' : 'Go back to the camera page and tap “Fullscreen camera”.'}</li>
</ol>
<a class="btn ghost" href="/ca.crt" download>${zh ? '下载 CA 证书（.crt）' : 'Download CA certificate (.crt)'}</a>
</div>
<div class="card">
<p class="note ${info.httpsEnabled ? '' : 'warn'}">${zh
  ? '安全提示：这个证书只用于本机局域网的 HTTPS，请勿分享给他人；不再需要时可在手机「证书信任设置」里关闭。'
  : 'Security note: this certificate is only for this local LAN HTTPS endpoint. Do not share it; disable it in Certificate Trust Settings when no longer needed.'}</p>
</div>
</div>
</body>
</html>`;
}

/**
 * 启动局域网手机拍照服务器。
 *
 * @param {{
 *   config: object,
 *   tokens: object,
 *   injector: {deliver: (input: object) => Promise<object>},
 *   log?: object,
 *   version?: string,
 *   lanCandidatesFn?: Function,
 * }} options
 * @returns {Promise<{
 *   port: number, host: string, lanIp: string|null, startedAt: number,
 *   warning: string|null, listenWarning: string|null,
 *   buildUrl: (token: string) => string,
 *   info: () => object,
 *   stop: () => Promise<void>,
 * }>}
 */
export async function startCameraServer({
  config = {},
  tokens,
  injector,
  log = console,
  version = '0.0.0',
  lanCandidatesFn,
} = {}) {
  if (!tokens || typeof tokens.get !== 'function') {
    throw new TypeError('[dsh-camera] startCameraServer requires a TokenStore instance (tokens)');
  }
  if (!injector || typeof injector.deliver !== 'function') {
    throw new TypeError('[dsh-camera] startCameraServer requires injector.deliver()');
  }

  const safeLog = (level, ...args) => {
    try {
      const fn = log && log[level];
      if (typeof fn === 'function') fn.apply(log, args);
    } catch {
      // logging must never break the server
    }
  };

  const maxUploadBytes = positiveInt(config.maxUploadBytes, DEFAULT_MAX_UPLOAD_BYTES);
  const maxFiles = positiveInt(config.maxFilesPerUpload, DEFAULT_MAX_FILES);
  const uploadsPerHour = positiveInt(config.uploadsPerHour, DEFAULT_UPLOADS_PER_HOUR);
  const configuredPort = normalizePort(config.port);
  const host =
    typeof config.bindHost === 'string' && config.bindHost.trim()
      ? config.bindHost.trim()
      : '0.0.0.0';
  const lanIp = pickLanIp(config.lanIpOverride, lanCandidatesFn);
  const localOnly = !lanIp;
  const startedAt = Date.now();

  /** @type {Map<string, number[]>} token -> 最近一小时内的上传时间戳 */
  const rateBuckets = new Map();

  function takeUploadSlot(token) {
    const now = Date.now();
    const previous = rateBuckets.get(token);
    const bucket = Array.isArray(previous)
      ? previous.filter((at) => now - at < HOUR_MS)
      : [];
    if (bucket.length >= uploadsPerHour) {
      rateBuckets.set(token, bucket);
      return false;
    }
    bucket.push(now);
    rateBuckets.set(token, bucket);
    return true;
  }

  function tokenEntry(rawToken) {
    if (typeof rawToken !== 'string' || !TOKEN_RE.test(rawToken)) return null;
    try {
      return tokens.get(rawToken);
    } catch (err) {
      safeLog('error', '[dsh-camera] token lookup failed:', err && err.message ? err.message : err);
      return null;
    }
  }

  async function persistTokens() {
    try {
      if (typeof tokens.flush === 'function') await tokens.flush();
    } catch (err) {
      safeLog('error', '[dsh-camera] token flush failed:', err && err.message ? err.message : err);
    }
  }

  function recordUpload(token, info) {
    try {
      if (typeof tokens.recordUpload === 'function') return tokens.recordUpload(token, info);
    } catch (err) {
      safeLog('error', '[dsh-camera] recordUpload failed:', err && err.message ? err.message : err);
    }
    return null;
  }

  // ------------------------------------------------------------------ handlers

  function handlePage(req, res, rawToken, secure) {
    const lang = langOf(req);
    const entry = tokenEntry(rawToken);
    if (!entry) {
      sendHtml(res, 410, renderExpiredPage(lang));
      return;
    }
    const httpsUrl = secure === true ? null : buildHttpsUrl(entry.token);
    sendHtml(
      res,
      200,
      renderCameraPage({
        token: entry.token,
        title: entry.title,
        expiresAt: entry.expiresAt,
        serverTime: Date.now(),
        version,
        lang,
        maxFiles: config.maxFilesPerUpload,
        secure: secure === true,
        httpsUrl,
        setupUrl: httpsUrl === null ? null : `${httpBase()}/setup`,
        httpsPort: httpsPort === null ? null : httpsPort,
      }),
    );
  }

  function handleInfo(req, res, rawToken, secure) {
    const entry = tokenEntry(rawToken);
    if (!entry) {
      sendJson(res, 404, errorBody('invalid-token', 'the link is invalid or has expired'));
      return;
    }
    sendJson(res, 200, {
      ok: true,
      value: {
        secure: secure === true,
        httpsEnabled,
        httpsPort,
        httpsUrl: secure === true ? null : buildHttpsUrl(entry.token),
        setupUrl: httpsEnabled ? `${httpBase()}/setup` : null,
        title: entry.title || '',
        expiresAt: entry.expiresAt,
        uploads: entry.uploads,
        serverTime: Date.now(),
        version,
        lang: langOf(req),
      },
    });
  }

  async function handleUpload(req, res, rawToken) {
    const entry = tokenEntry(rawToken);
    if (!entry) {
      if (typeof rawToken === 'string') rateBuckets.delete(rawToken);
      drainRequest(req);
      sendJson(res, 410, errorBody('invalid-token', 'the upload link is invalid or has expired'));
      return;
    }

    const contentType = headerOf(req, 'content-type');
    const lower = contentType.toLowerCase();
    const supported =
      lower.startsWith('multipart/form-data') ||
      lower.startsWith('image/') ||
      lower.startsWith('application/octet-stream');
    if (!supported) {
      drainRequest(req);
      sendJson(res, 400, errorBody('bad-request', 'unsupported content-type'));
      return;
    }

    if (!takeUploadSlot(entry.token)) {
      drainRequest(req);
      sendJson(
        res,
        429,
        errorBody(
          'rate-limited',
          `too many uploads for this link (limit ${uploadsPerHour} per hour)`,
        ),
      );
      return;
    }

    let parsed;
    try {
      parsed = await readMultipart(req, { maxBytes: maxUploadBytes, maxFiles });
    } catch (err) {
      if (err && err.code === 'too-large') {
        sendJson(res, 413, errorBody('too-large', err.message || 'upload too large'));
        return;
      }
      safeLog('warn', '[dsh-camera] upload rejected:', (err && err.message) || err);
      sendJson(res, 400, errorBody('bad-request', (err && err.message) || 'malformed upload'));
      return;
    }

    const accepted = [];
    let perImageTooLarge = false;
    const files = (parsed && parsed.files) || [];
    for (const file of files) {
      if (!file || !Buffer.isBuffer(file.data)) continue;
      if (file.data.length > MAX_IMAGE_BYTES) {
        perImageTooLarge = true;
        break;
      }
      const mediaType = sniffImageType(file.data);
      if (!mediaType) continue; // 非图片直接忽略（例如误传的文本字段）
      accepted.push({
        data: file.data,
        mediaType,
        filename: file.filename || defaultFilename(mediaType),
      });
    }
    if (perImageTooLarge) {
      sendJson(res, 413, errorBody('too-large', 'a single image exceeds the 20 MiB limit'));
      return;
    }
    if (accepted.length === 0) {
      sendJson(
        res,
        400,
        errorBody('no-image', 'no supported image (JPEG/PNG/WebP/GIF) found in the upload'),
      );
      return;
    }

    const filenames = accepted.map((file) => file.filename).join(', ');
    let result;
    try {
      result = await injector.deliver({ sessionId: entry.sessionId, files: accepted });
    } catch (err) {
      // injector.deliver 契约上不抛错（内部已 map），走到这里属于意外，统一 inject-failed。
      result = {
        ok: false,
        code: 'inject-failed',
        message: (err && err.message) || String(err),
      };
    }

    if (!result || result.ok !== true) {
      const rawCode = (result && result.code) || 'inject-failed';
      const pageCode = INJECT_PAGE_CODES.has(rawCode)
        ? rawCode
        : `inject-failed:${String(rawCode).replace(/^inject-failed:/, '')}`;
      const message =
        (result && result.message) || 'failed to inject the image into the conversation';
      recordUpload(entry.token, { filename: filenames, ok: false, count: accepted.length });
      await persistTokens();
      sendJson(res, 502, errorBody(pageCode, message));
      return;
    }

    const updated = recordUpload(entry.token, { filename: filenames, ok: true, count: accepted.length }) || entry;
    await persistTokens();
    sendJson(res, 200, {
      ok: true,
      value: {
        count: accepted.length,
        expiresAt: updated.expiresAt,
        uploads: updated.uploads,
      },
    });
  }

  async function handleRequest(req, res, secure) {
    let pathname;
    try {
      pathname = new URL(String(req.url || '/'), 'http://127.0.0.1').pathname;
    } catch {
      sendText(res, 400, 'bad request');
      return;
    }
    const method = String(req.method || 'GET').toUpperCase();

    if (method === 'GET' && pathname === '/') {
      sendRedirect(res, '/c/invalid');
      return;
    }
    if (method === 'GET' && pathname === '/favicon.ico') {
      sendEmpty(res, 204);
      return;
    }

    if (method === 'GET' && pathname === '/setup') {
      sendHtml(
        res,
        200,
        renderSetupPage(langOf(req), {
          httpsEnabled,
          httpsPort,
          httpPort: actualPort,
          lanIp,
        }),
      );
      return;
    }
    if (method === 'GET' && pathname === '/ca.mobileconfig') {
      if (tlsMaterial === null) {
        sendText(res, 404, 'HTTPS is not enabled');
        return;
      }
      sendDownload(
        res,
        200,
        'application/x-apple-aspen-config',
        'dsh-camera-ca.mobileconfig',
        tlsMaterial.mobileConfig,
      );
      return;
    }
    if (method === 'GET' && pathname === '/ca.crt') {
      if (tlsMaterial === null) {
        sendText(res, 404, 'HTTPS is not enabled');
        return;
      }
      sendDownload(res, 200, 'application/x-x509-ca-cert', 'dsh-camera-ca.crt', tlsMaterial.caPem);
      return;
    }

    let match = /^\/c\/([^/]+)\/info$/.exec(pathname);
    if (match && method === 'GET') {
      handleInfo(req, res, match[1], secure);
      return;
    }
    match = /^\/c\/([^/]+)\/upload$/.exec(pathname);
    if (match && method === 'POST') {
      await handleUpload(req, res, match[1]);
      return;
    }
    match = /^\/c\/([^/]+)$/.exec(pathname);
    if (match && method === 'GET') {
      handlePage(req, res, match[1], secure);
      return;
    }
    sendText(res, 404, 'not found');
  }

  // ------------------------------------------------------------------- server

  /** node:http/node:https 共用的请求兜底包装。 */
  function makeHandler(secure) {
    return (req, res) => {
      handleRequest(req, res, secure).catch((err) => {
        safeLog('error', '[dsh-camera] request failed:', (err && err.stack) || err);
        try {
          if (!res.headersSent) sendText(res, 500, 'internal error');
          else if (!res.writableEnded) res.end();
        } catch {
          // ignore
        }
      });
    };
  }

  function onClientError(err, socket) {
    safeLog('warn', '[dsh-camera] client error:', (err && err.message) || err);
    if (!socket) return;
    try {
      if (socket.writable) {
        socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      } else {
        socket.destroy();
      }
    } catch {
      try {
        socket.destroy();
      } catch {
        // ignore
      }
    }
  }

  const httpServer = http.createServer(makeHandler(false));
  httpServer.requestTimeout = REQUEST_TIMEOUT_MS;
  httpServer.on('clientError', onClientError);

  function listenServer(server, port) {
    return new Promise((resolve, reject) => {
      const onError = (err) => {
        server.removeListener('listening', onListening);
        reject(err);
      };
      const onListening = () => {
        server.removeListener('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, host);
    });
  }

  let warning = null;
  try {
    await listenServer(httpServer, configuredPort);
  } catch (err) {
    if (err && err.code === 'EADDRINUSE' && configuredPort !== 0) {
      warning = `port ${configuredPort} is already in use; fell back to a random port`;
      safeLog('warn', `[dsh-camera] ${warning}`);
      await listenServer(httpServer, 0);
    } else {
      throw err;
    }
  }

  const address = httpServer.address();
  const actualPort =
    address && typeof address === 'object' && Number.isInteger(address.port)
      ? address.port
      : configuredPort;
  const publicHost = lanIp || '127.0.0.1';

  // ------------------------------------------------------------------ HTTPS
  // getUserMedia（全屏相机）只在 secure context 可用，所以可选再起一个 HTTPS
  // 监听；证书由 lib/tls.js 在本机生成（本地 CA），手机首次需安装该 CA。
  let httpsServer = null;
  let httpsPort = null;
  let httpsEnabled = false;
  let tlsMaterial = null;
  let httpsWarning = null;

  function tlsHosts(primary) {
    const hosts = [];
    const seen = new Set();
    const push = (host) => {
      const key = host.ip ? `ip:${host.ip}` : `dns:${host.dns}`;
      if (seen.has(key)) return;
      seen.add(key);
      hosts.push(host);
    };
    if (primary) push({ ip: primary });
    try {
      for (const candidate of lanCandidates()) push({ ip: candidate.address });
    } catch {
      // discovery is best-effort
    }
    try {
      const hostname = os.hostname();
      if (hostname) push({ dns: hostname });
    } catch {
      // ignore
    }
    return hosts;
  }

  function markHttpsUnavailable(message) {
    httpsWarning = message;
    httpsEnabled = false;
    httpsPort = null;
    try {
      if (httpsServer !== null) {
        httpsServer.close();
        if (typeof httpsServer.closeAllConnections === 'function') httpsServer.closeAllConnections();
      }
    } catch {
      // ignore
    }
    httpsServer = null;
    safeLog('warn', `[dsh-camera] HTTPS disabled: ${message}`);
  }

  if (config.https === true) {
    try {
      const stateDir =
        typeof config.stateDir === 'string' && config.stateDir.length > 0
          ? config.stateDir
          : path.join(os.homedir(), '.dsh', 'dsh-camera');
      tlsMaterial = ensureTlsMaterial({
        stateDir,
        hosts: tlsHosts(lanIp),
        log: {
          info: (...args) => safeLog('info', ...args),
          warn: (...args) => safeLog('warn', ...args),
          error: (...args) => safeLog('error', ...args),
        },
      });
      httpsServer = https.createServer(
        { key: tlsMaterial.key, cert: tlsMaterial.cert },
        makeHandler(true),
      );
      httpsServer.requestTimeout = REQUEST_TIMEOUT_MS;
      httpsServer.on('clientError', onClientError);
      const preferredHttpsPort =
        Number.isInteger(config.httpsPort) && config.httpsPort > 0
          ? config.httpsPort
          : actualPort + 1;
      let httpsPortWarning = null;
      try {
        await listenServer(httpsServer, preferredHttpsPort);
      } catch (err) {
        if (err && err.code === 'EADDRINUSE') {
          httpsPortWarning = `HTTPS port ${preferredHttpsPort} is already in use; fell back to a random port`;
          safeLog('warn', `[dsh-camera] ${httpsPortWarning}`);
          await listenServer(httpsServer, 0);
        } else {
          throw err;
        }
      }
      const httpsAddress = httpsServer.address();
      httpsPort =
        httpsAddress && typeof httpsAddress === 'object' && Number.isInteger(httpsAddress.port)
          ? httpsAddress.port
          : preferredHttpsPort;
      httpsEnabled = true;
      if (httpsPortWarning !== null) httpsWarning = httpsPortWarning;
      safeLog(
        'info',
        '[dsh-camera] HTTPS fullscreen camera listening on port %s (CA: %s)',
        httpsPort,
        tlsMaterial.fingerprint,
      );
    } catch (err) {
      markHttpsUnavailable((err && err.message) || String(err));
    }
  }

  let stopped = false;

  function httpBase() {
    return `http://${publicHost}:${actualPort}`;
  }

  function buildUrl(token) {
    const safeToken = token === undefined || token === null ? '' : String(token);
    return `${httpBase()}/c/${encodeURIComponent(safeToken)}`;
  }

  function buildHttpsUrl(token) {
    if (!httpsEnabled || httpsPort === null) return null;
    const safeToken = token === undefined || token === null ? '' : String(token);
    return `https://${publicHost}:${httpsPort}/c/${encodeURIComponent(safeToken)}`;
  }

  function setupUrl() {
    return httpsEnabled ? `${httpBase()}/setup` : null;
  }

  function info() {
    return {
      running: !stopped,
      port: actualPort,
      httpPort: actualPort,
      lanIp,
      localOnly,
      startedAt,
      version,
      warning,
      httpsEnabled,
      httpsPort,
      httpsWarning,
      setupUrl: setupUrl(),
      caFingerprint: tlsMaterial === null ? null : tlsMaterial.fingerprint,
    };
  }

  async function closeOne(server) {
    if (server === null) return;
    await new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      const timer = setTimeout(finish, 2000);
      if (timer && typeof timer.unref === 'function') timer.unref();
      try {
        server.close(() => finish());
        if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
        else if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
      } catch {
        finish();
      }
    });
  }

  async function stop() {
    if (stopped) return;
    stopped = true;
    rateBuckets.clear();
    await closeOne(httpsServer);
    httpsServer = null;
    await closeOne(httpServer);
  }

  return {
    port: actualPort,
    httpPort: actualPort,
    host,
    lanIp,
    startedAt,
    warning,
    listenWarning: warning,
    httpsEnabled,
    httpsPort,
    httpsWarning,
    setupUrl: setupUrl(),
    buildUrl,
    buildHttpsUrl,
    info,
    stop,
  };
}

export default startCameraServer;
