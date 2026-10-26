// dsh-camera · 手机端单页（DESIGN 3.7）
// 仅依赖 Node 内置模块；渲染成完整 HTML 文档，CSS/JS 全部内联，无任何外部资源/CDN。
//
// 页面能力：
//  - 拍照（capture=environment）与相册多选：加入待发送列表，**不自动上传**；
//  - 本地 canvas 压缩（长边 ≤ 2400，JPEG 0.85），小图原样保留；
//  - 缩略图预览 + 每张状态；确认后点「发送 N 张」一次性上传，可多张连拍后一起发；
//  - 一次发送多张 → 一个 FormData POST（字段名 photo，可多个，默认上限 6 张）；
//  - token 过期（HTTP 410）明确提示回电脑重开面板；倒计时到点同样禁用；
//  - 深色模式、safe-area、aria-label、aria-live；
//  - E2E 测试锚点：data-cam-page / -input-capture / -input-gallery / -status / -count /
//    -error / -send / -send-label / -clear / -pending（body 属性）。

const CAMERA_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M4 8.6A2.6 2.6 0 0 1 6.6 6h1.1l1.2-1.8h5.2L15.3 6h1.1A2.6 2.6 0 0 1 19 8.6v7.8A2.6 2.6 0 0 1 16.4 19H6.6A2.6 2.6 0 0 1 4 16.4z"/><circle cx="11.5" cy="12.3" r="3.4"/></svg>`;

const IMAGE_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><rect x="3.5" y="4.5" width="17" height="15" rx="3"/><circle cx="9" cy="10" r="1.6"/><path d="m4.6 17.4 4.2-4.2a2 2 0 0 1 2.8 0l1.9 1.9 1.6-1.6a2 2 0 0 1 2.8 0l1.7 1.7"/></svg>`;

const STRINGS = {
  zh: {
    docTitle: '拍照上传',
    appTitle: '拍照上传',
    target: '发送到',
    defaultTitle: '当前对话',
    remaining: '链接剩余',
    expiredLabel: '已过期',
    sentLabel: '已发送',
    capture: '拍照',
    gallery: '从相册选择',
    captureAria: '调用相机拍照',
    galleryAria: '从相册选择照片',
    uploadSection: '拍摄或选择照片',
    previewSection: '待发送的照片',
    sendSection: '发送照片',
    idle: '拍多张照片后，点「发送」一起发到对话',
    working: '正在处理照片…',
    done: '已发送到对话',
    failed: '发送失败',
    compressing: '压缩中…',
    ready: '待发送',
    uploading: '上传中…',
    sent: '已发送',
    preparing: '准备中…',
    retry: '重试',
    retryAll: '重试全部',
    send: '发送',
    sendCount: '发送 {n} 张',
    sending: '发送中…',
    clear: '清空',
    sendAria: '发送照片',
    sendAriaCount: '发送 {n} 张照片',
    clearAria: '清空待发送照片',
    pending: '已选 {n} 张，确认后可发送',
    maxFiles: '一次最多发送 {n} 张，请先发送当前照片',
    cameraTitle: '全屏相机',
    cameraClose: '关闭',
    cameraFlip: '切换镜头',
    cameraShutter: '拍照',
    cameraShots: '连拍 {n} 张',
    cameraNoFlash: '无闪光灯',
    cameraDenied: '无法打开相机（请在浏览器/系统设置里允许相机权限）',
    cameraFallback: '全屏相机不可用，已改用系统相机',
    secureTitle: 'iPhone 全屏相机（可选）',
    secureBody: '装一次本机证书后，可在这个页面内全屏取景、连拍，且不使用闪光灯。',
    secureSetup: '安装证书',
    secureOpen: '用全屏相机打开',
    progress: '发送中…',
    decodeError: '无法读取这张图片（可能是 HEIC/HEIF 格式）。请用相机重拍，或在相册中选择 JPG/PNG 图片。',
    notImage: '这不是受支持的图片格式，请选择 JPG/PNG/WebP/GIF。',
    tokenExpired: '链接已失效：请在电脑上重新打开拍照面板。',
    tooLarge: '图片太大，请选择更小的图片后重试。',
    rateLimited: '上传太频繁，请稍等一分钟再试。',
    noImage: '没有识别到可上传的图片，请重新选择。',
    noVision: '当前对话的模型不支持看图，请在电脑上换一个支持图片的模型后重试。',
    sessionGone: '这个对话已不存在或已关闭，请在电脑上重新打开拍照面板。',
    timeout: '发送超时，请重试。',
    networkError: '网络连接失败，请确认手机和电脑连接的是同一个 Wi-Fi。',
    uploadFailed: '上传失败，请重试。',
    privacy: '照片通过局域网直接传到你的电脑，不会上传到云端。',
    enableJs: '请启用 JavaScript 后使用拍照上传。',
    photoAlt: '待上传的照片',
  },
  en: {
    docTitle: 'Photo upload',
    appTitle: 'Photo upload',
    target: 'Send to',
    defaultTitle: 'Current chat',
    remaining: 'Link expires in',
    expiredLabel: 'expired',
    sentLabel: 'sent',
    capture: 'Take photo',
    gallery: 'Choose from library',
    captureAria: 'Take a photo',
    galleryAria: 'Choose photos from the library',
    uploadSection: 'Take or choose photos',
    previewSection: 'Photos to send',
    sendSection: 'Send photos',
    idle: 'Take photos, then tap Send to deliver them together',
    working: 'Processing photos…',
    done: 'Sent to the conversation',
    failed: 'Upload failed',
    compressing: 'Compressing…',
    ready: 'Ready',
    uploading: 'Uploading…',
    sent: 'Sent',
    preparing: 'Preparing…',
    retry: 'Retry',
    retryAll: 'Retry all',
    send: 'Send',
    sendCount: 'Send {n} photos',
    sending: 'Sending…',
    clear: 'Clear',
    sendAria: 'Send photos',
    sendAriaCount: 'Send {n} photos',
    clearAria: 'Clear selected photos',
    pending: '{n} selected — review, then send',
    maxFiles: 'Up to {n} photos per send. Send the current ones first.',
    cameraTitle: 'Fullscreen camera',
    cameraClose: 'Close',
    cameraFlip: 'Switch camera',
    cameraShutter: 'Take photo',
    cameraShots: '{n} shots',
    cameraNoFlash: 'No flash',
    cameraDenied: 'Cannot open the camera. Allow camera access in your browser/system settings.',
    cameraFallback: 'Fullscreen camera unavailable — using the system camera',
    secureTitle: 'iPhone fullscreen camera (optional)',
    secureBody: 'Install this device\'s local certificate once, then shoot inside the page: fullscreen preview, burst capture, no flash.',
    secureSetup: 'Install certificate',
    secureOpen: 'Open fullscreen camera',
    progress: 'Sending…',
    decodeError: "Couldn't read this photo (it may be HEIC/HEIF). Please take a new photo or choose a JPG/PNG image.",
    notImage: 'This file type is not supported. Please choose JPG/PNG/WebP/GIF.',
    tokenExpired: 'This link has expired. Please reopen the camera panel on your computer.',
    tooLarge: 'The photo is too large. Please pick a smaller one and retry.',
    rateLimited: 'Too many uploads. Please wait a minute and try again.',
    noImage: 'No supported image was found. Please choose again.',
    noVision: 'The model in this conversation cannot see images. Please switch to a vision-capable model on your computer and retry.',
    sessionGone: 'This conversation no longer exists. Please reopen the camera panel on your computer.',
    timeout: 'Sending timed out. Please retry.',
    networkError: 'Network error. Make sure your phone and computer are on the same Wi-Fi.',
    uploadFailed: 'Upload failed. Please retry.',
    privacy: 'Photos travel directly over your local network — never to the cloud.',
    enableJs: 'Please enable JavaScript to use photo upload.',
    photoAlt: 'Photo to upload',
  },
};

const CSS = String.raw`
:root{
  color-scheme:light dark;
  --bg:#eef2f7;--bg-top:#ffffff;--card:#ffffff;--text:#0f172a;--muted:#64748b;
  --accent:#2563eb;--accent-press:#1d4ed8;--accent-contrast:#ffffff;
  --ok:#047857;--ok-bg:#d1fae5;--err:#b91c1c;--err-bg:#fee2e2;
  --border:rgba(15,23,42,.10);--shadow:0 22px 50px -30px rgba(15,23,42,.55);--radius:22px;
}
@media (prefers-color-scheme:dark){
  :root{--bg:#070b14;--bg-top:#0d1526;--card:#111a2c;--text:#e8eef8;--muted:#93a4bb;
    --accent:#3b82f6;--accent-press:#2563eb;--accent-contrast:#f8fbff;
    --ok:#34d399;--ok-bg:rgba(16,185,129,.16);--err:#f87171;--err-bg:rgba(248,113,113,.14);
    --border:rgba(148,163,184,.18);--shadow:0 28px 70px -34px rgba(0,0,0,.85);}
}
*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
html,body{margin:0;padding:0;min-height:100%}
body{
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Noto Sans SC","Microsoft YaHei",sans-serif;
  color:var(--text);line-height:1.55;min-height:100dvh;
  background-color:var(--bg);
  background-image:radial-gradient(120% 100% at 50% 0%,var(--bg-top) 0%,var(--bg) 55%);
  background-repeat:no-repeat;
  -webkit-tap-highlight-color:transparent;
}
.shell{
  width:100%;max-width:560px;margin:0 auto;display:flex;flex-direction:column;gap:16px;
  padding:calc(env(safe-area-inset-top,0px) + 22px) calc(env(safe-area-inset-right,0px) + 18px)
          calc(env(safe-area-inset-bottom,0px) + 30px) calc(env(safe-area-inset-left,0px) + 18px);
}
.hero{background:var(--card);border:1px solid var(--border);border-radius:var(--radius);box-shadow:var(--shadow);padding:18px 18px 14px}
.hero-top{display:flex;align-items:flex-start;gap:12px}
.brand{display:inline-flex;align-items:center;justify-content:center;width:44px;height:44px;flex:none;border-radius:14px;background:linear-gradient(140deg,var(--accent),var(--accent-press));color:var(--accent-contrast)}
.brand svg{width:24px;height:24px;display:block}
.hero-titles{flex:1;min-width:0}
.hero h1{margin:0;font-size:22px;line-height:1.25;letter-spacing:.01em}
.target{margin:4px 0 0;font-size:14px;color:var(--muted);display:flex;gap:6px;align-items:baseline;min-width:0}
.target-label{flex:none}
.target strong{color:var(--text);font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.counter{flex:none;display:flex;flex-direction:column;align-items:center;justify-content:center;min-width:58px;padding:8px 10px;border-radius:16px;background:var(--ok-bg);color:var(--ok)}
.counter strong{font-size:20px;line-height:1.1;font-variant-numeric:tabular-nums}
.counter span{font-size:11px;font-weight:600;letter-spacing:.04em;opacity:.9}
.meta-row{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:12px;padding-top:12px;border-top:1px dashed var(--border);font-size:13px;color:var(--muted)}
.timer{display:inline-flex;align-items:center;gap:6px}
.timer strong{color:var(--text);font-variant-numeric:tabular-nums;letter-spacing:.03em}
.version{font-size:11px;letter-spacing:.06em;text-transform:uppercase;opacity:.7}
.actions{display:flex;flex-direction:column;gap:10px}
.btn{display:flex;align-items:center;justify-content:center;gap:10px;width:100%;min-height:60px;padding:14px 18px;border:1px solid transparent;border-radius:18px;font:inherit;font-size:17px;font-weight:650;letter-spacing:.01em;cursor:pointer;transition:transform .12s ease,box-shadow .18s ease,opacity .18s ease}
.btn svg{width:23px;height:23px;flex:none}
.btn:active{transform:scale(.985)}
.btn:focus-visible{outline:3px solid rgba(59,130,246,.55);outline-offset:2px}
.btn.primary{background:linear-gradient(180deg,var(--accent) 0%,var(--accent-press) 100%);color:var(--accent-contrast);box-shadow:0 18px 26px -18px rgba(37,99,235,.75)}
.btn.ghost{background:var(--card);color:var(--text);border-color:var(--border);box-shadow:0 12px 26px -26px rgba(15,23,42,.5)}
.btn[disabled]{opacity:.45;cursor:not-allowed;box-shadow:none}
.statusline{display:flex;align-items:center;gap:8px;min-height:22px;padding:0 6px;font-size:14px;color:var(--muted)}
.status-dot{width:9px;height:9px;flex:none;border-radius:50%;background:var(--muted);transition:background .2s ease}
body[data-cam-status="working"] .status-dot{background:var(--accent);animation:pulse 1.1s ease-in-out infinite}
body[data-cam-status="done"] .status-dot{background:var(--ok)}
body[data-cam-status="error"] .status-dot{background:var(--err)}
body[data-cam-status="done"] .statusline{color:var(--ok)}
body[data-cam-status="error"] .statusline{color:var(--err)}
@keyframes pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.45;transform:scale(.8)}}
.error{white-space:pre-line;border-radius:16px;padding:13px 15px;font-size:14px;line-height:1.55;background:var(--err-bg);color:var(--err);border:1px solid rgba(220,38,38,.28)}
.error[hidden]{display:none}
.retry-all{min-height:48px;font-size:15px;border-color:rgba(220,38,38,.35);color:var(--err);background:transparent;box-shadow:none}
.retry-all[hidden]{display:none}
.previews{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}
.previews:empty{display:none}
.sendbar{display:flex;align-items:stretch;gap:10px}
.sendbar .btn{min-height:56px;font-size:16px}
.sendbar .send{flex:1}
.sendbar .clear{flex:none;width:96px;min-height:56px;font-size:15px}
.secure-hint{background:var(--card);border:1px solid var(--border);border-radius:18px;padding:14px 16px;display:flex;flex-direction:column;gap:10px}
.secure-hint[hidden]{display:none}
.secure-hint h2{margin:0;font-size:15px}
.secure-hint p{margin:0;font-size:13px;color:var(--muted);line-height:1.5}
.secure-actions{display:flex;gap:10px;flex-wrap:wrap}
.secure-actions .btn{flex:1;min-height:46px;font-size:14px;min-width:130px}
.progress{height:6px;border-radius:999px;background:var(--border);overflow:hidden;margin-top:-2px}
.progress[hidden]{display:none}
.progress span{display:block;height:100%;width:0;background:var(--accent);transition:width .18s ease}
.camera{position:fixed;inset:0;z-index:120;background:#000;display:flex;flex-direction:column}
.camera[hidden]{display:none}
.camera video{flex:1;width:100%;height:100%;object-fit:cover;background:#000;min-height:0}
.camera-top{position:absolute;top:0;left:0;right:0;display:flex;align-items:center;justify-content:space-between;padding:calc(env(safe-area-inset-top,0px) + 14px) 16px 10px;background:linear-gradient(180deg,rgba(0,0,0,.62),rgba(0,0,0,0))}
.camera-top span{color:#fff;font-size:13px;font-weight:600;letter-spacing:.02em}
.camera-top button{border:0;border-radius:999px;padding:8px 14px;font:inherit;font-size:13px;font-weight:600;background:rgba(255,255,255,.18);color:#fff;cursor:pointer}
.camera-controls{position:absolute;left:0;right:0;bottom:0;display:flex;align-items:center;justify-content:space-between;gap:16px;padding:18px 22px calc(env(safe-area-inset-bottom,0px) + 22px);background:linear-gradient(0deg,rgba(0,0,0,.68),rgba(0,0,0,0))}
.shutter{width:78px;height:78px;flex:none;border-radius:50%;border:4px solid rgba(255,255,255,.92);background:rgba(255,255,255,.18);box-shadow:0 0 0 6px rgba(255,255,255,.12);cursor:pointer;touch-action:manipulation}
.shutter:active{background:rgba(255,255,255,.55)}
.camera-side{width:96px;display:flex;flex-direction:column;align-items:center;gap:6px}
.camera-side button{border:0;background:rgba(255,255,255,.18);color:#fff;border-radius:999px;padding:9px 12px;font:inherit;font-size:12px;font-weight:600;cursor:pointer}
.camera-side small{color:rgba(255,255,255,.8);font-size:11px;text-align:center;line-height:1.3}
.camera-error{position:absolute;left:16px;right:16px;top:50%;transform:translateY(-50%);background:rgba(185,28,28,.92);color:#fff;padding:14px 16px;border-radius:14px;font-size:14px;text-align:center}
.camera-error[hidden]{display:none}
.thumb{position:relative;margin:0;aspect-ratio:1/1;border-radius:16px;overflow:hidden;background:var(--card);border:1px solid var(--border);box-shadow:0 10px 26px -24px rgba(15,23,42,.6);animation:pop .18s ease}
.thumb img{width:100%;height:100%;object-fit:cover;display:block;background:var(--bg)}
@keyframes pop{from{opacity:0;transform:scale(.94)}to{opacity:1;transform:scale(1)}}
.thumb-state{position:absolute;left:6px;right:6px;bottom:6px;padding:4px 6px;border-radius:9px;background:rgba(8,12,20,.62);color:#fff;font-size:11px;font-weight:600;text-align:center;backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px)}
.thumb[data-state="sent"] .thumb-state{background:#047857}
.thumb[data-state="error"] .thumb-state{background:#b91c1c}
.thumb[data-state="uploading"],.thumb[data-state="compressing"]{box-shadow:0 0 0 2px var(--accent)}
.thumb[data-state="error"]{box-shadow:0 0 0 2px var(--err)}
.thumb[data-state="compressing"] img,.thumb[data-state="uploading"] img{opacity:.72}
.thumb .retry{position:absolute;left:6px;right:6px;top:6px;padding:6px 4px;border:0;border-radius:9px;background:rgba(8,12,20,.72);color:#fff;font:inherit;font-size:12px;font-weight:650;cursor:pointer;backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px)}
.thumb .retry[hidden]{display:none}
.foot{margin-top:2px;text-align:center;font-size:12px;color:var(--muted)}
.noscript{margin:16px;padding:14px 16px;border-radius:14px;background:var(--err-bg);color:var(--err);font-size:14px;text-align:center}
@media (min-width:520px){
  .actions{flex-direction:row}
  .actions .btn{flex:1}
  .previews{grid-template-columns:repeat(4,minmax(0,1fr))}
  .sendbar .clear{width:112px}
}
`;

const PAGE_JS = String.raw`
(function () {
  'use strict';
  var CFG = window.__DSH_CAMERA__ || {};
  if (!CFG.token) return;
  var STR = CFG.strings || {};
  var ALT = CFG.alt || {};
  var uploadUrl = location.pathname.replace(/\/+$/, '') + '/upload';
  var deadline = Date.now() + Math.max(0, Number(CFG.expiresAt) - Number(CFG.serverTime));
  var MAX_FILES = Math.max(1, Math.min(20, Number(CFG.maxFiles) || 6));
  var app = { items: [], seq: 0, count: 0, expired: false, timer: null, lastError: '', sending: false };

  var els = {
    statusText: document.querySelector('[data-cam-status-text]'),
    error: document.querySelector('[data-cam-error]'),
    retryAll: document.querySelector('[data-cam-retry-all]'),
    count: document.querySelector('[data-cam-count]'),
    remaining: document.querySelector('[data-cam-remaining]'),
    previews: document.querySelector('[data-cam-previews]'),
    captureBtn: document.querySelector('[data-cam-capture-btn]'),
    galleryBtn: document.querySelector('[data-cam-gallery-btn]'),
    captureInput: document.querySelector('[data-cam-input-capture]'),
    galleryInput: document.querySelector('[data-cam-input-gallery]'),
    sendBtn: document.querySelector('[data-cam-send]'),
    sendLabel: document.querySelector('[data-cam-send-label]'),
    clearBtn: document.querySelector('[data-cam-clear]'),
    camera: document.querySelector('[data-cam-camera]'),
    video: document.querySelector('[data-cam-video]'),
    shutter: document.querySelector('[data-cam-shutter]'),
    flip: document.querySelector('[data-cam-flip]'),
    cameraClose: document.querySelector('[data-cam-camera-close]'),
    cameraCount: document.querySelector('[data-cam-camera-count]'),
    cameraError: document.querySelector('[data-cam-camera-error]'),
    secureHint: document.querySelector('[data-cam-secure-hint]'),
    secureSetup: document.querySelector('[data-cam-secure-setup]'),
    secureOpen: document.querySelector('[data-cam-secure-open]'),
    progressWrap: document.querySelector('[data-cam-progress-wrap]'),
    progressBar: document.querySelector('[data-cam-progress]')
  };

  function t(key, fallback) {
    return typeof STR[key] === 'string' && STR[key] ? STR[key] : (fallback || '');
  }
  function alt(key) {
    return typeof ALT[key] === 'string' ? ALT[key] : '';
  }
  function setStatus(state, text) {
    document.body.setAttribute('data-cam-status', state);
    if (els.statusText && typeof text === 'string' && text) els.statusText.textContent = text;
  }
  function showError(message) {
    app.lastError = message || '';
    if (!els.error) return;
    els.error.textContent = app.lastError;
    els.error.hidden = !app.lastError;
  }
  function hideError() {
    app.lastError = '';
    if (!els.error) return;
    els.error.textContent = '';
    els.error.hidden = true;
  }
  function setRetryAllVisible(visible) {
    if (els.retryAll) els.retryAll.hidden = !visible;
  }
  function addCount(n) {
    app.count += Number(n) || 0;
    if (!els.count) return;
    // 同时更新文本与属性：E2E 既可能读 textContent，也可能读 data-cam-count 的值。
    els.count.textContent = String(app.count);
    els.count.setAttribute('data-cam-count', String(app.count));
  }
  function pad(n) { return n < 10 ? '0' + n : String(n); }
  function formatRemaining(ms) {
    var total = Math.max(0, Math.floor(ms / 1000));
    var h = Math.floor(total / 3600);
    var m = Math.floor((total % 3600) / 60);
    var s = total % 60;
    return h > 0 ? h + ':' + pad(m) + ':' + pad(s) : pad(m) + ':' + pad(s);
  }
  function stopTimer() {
    if (app.timer) { window.clearInterval(app.timer); app.timer = null; }
  }
  function tick() {
    var remain = deadline - Date.now();
    if (els.remaining) {
      els.remaining.textContent = remain > 0 ? formatRemaining(remain) : t('expiredLabel', 'expired');
    }
    if (remain <= 0) { stopTimer(); expireLink(); }
  }
  function startTimer() {
    stopTimer();
    tick();
    if (!app.expired) app.timer = window.setInterval(tick, 1000);
  }

  function setProgress(percent, visible) {
    if (els.progressWrap) els.progressWrap.hidden = !visible;
    if (els.progressBar) {
      var value = Number(percent);
      els.progressBar.style.width = String(Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0))) + '%';
    }
    if (visible && app.sending && els.statusText) {
      var text = t('progress', 'Sending…');
      var pct = Math.round(Number(percent));
      if (Number.isFinite(pct) && pct > 0) text = text + ' ' + pct + '%';
      els.statusText.textContent = text;
    }
  }

  // --------------------------------------------------------------- 全屏相机
  // getUserMedia 只在 secure context（HTTPS）可用；这里从不调用 torch/闪光灯。
  var camera = { stream: null, facing: 'environment', shots: 0, failed: false };
  function cameraSupported() {
    return !!(
      window.isSecureContext &&
      navigator.mediaDevices &&
      typeof navigator.mediaDevices.getUserMedia === 'function'
    );
  }
  function showCameraError(message) {
    if (els.cameraError) {
      els.cameraError.textContent = message || t('cameraDenied', 'camera unavailable');
      els.cameraError.hidden = false;
    }
  }
  function clearCameraError() {
    if (els.cameraError) {
      els.cameraError.textContent = '';
      els.cameraError.hidden = true;
    }
  }
  function updateCameraShots() {
    if (els.cameraCount) {
      els.cameraCount.textContent = t('cameraShots', '{n} shots').replace('{n}', String(camera.shots));
    }
  }
  function stopCameraStream() {
    if (camera.stream) {
      try {
        camera.stream.getTracks().forEach(function (track) { track.stop(); });
      } catch (e) { /* ignore */ }
      camera.stream = null;
    }
    if (els.video) {
      try { els.video.srcObject = null; } catch (e) { /* ignore */ }
    }
  }
  function closeCamera() {
    stopCameraStream();
    if (els.camera) els.camera.hidden = true;
    clearCameraError();
  }
  function addCapturedFrame(blob) {
    if (!blob || app.expired) return;
    if (countPending() >= MAX_FILES) {
      showError(t('maxFiles', 'Up to {n} photos per send.').replace('{n}', String(MAX_FILES)));
      return;
    }
    var name = 'camera-' + Date.now() + '.jpg';
    var file;
    try {
      file = new File([blob], name, { type: 'image/jpeg' });
    } catch (e) {
      file = blob;
      try { file.name = name; } catch (e2) { /* ignore */ }
    }
    var item = createItem(file);
    item.blob = blob;
    item.filename = name;
    item.status = 'ready';
    renderItem(item);
    hideError();
    syncStatus();
  }
  function startCameraStream() {
    stopCameraStream();
    clearCameraError();
    var constraints = {
      audio: false,
      // 显式不使用闪光灯/补光：不请求 torch，也不做屏幕补光。
      video: {
        facingMode: { ideal: camera.facing },
        width: { ideal: 1920 },
        height: { ideal: 1440 }
      }
    };
    navigator.mediaDevices.getUserMedia(constraints).then(function (stream) {
      camera.stream = stream;
      if (els.video) {
        els.video.srcObject = stream;
        var playing = els.video.play();
        if (playing && typeof playing.catch === 'function') playing.catch(function () {});
      }
    }).catch(function (err) {
      camera.failed = true;
      var denied = err && (err.name === 'NotAllowedError' || err.name === 'SecurityError');
      showCameraError(
        (denied ? t('cameraDenied', 'camera denied') : t('cameraFallback', 'camera unavailable')) +
        (err && err.name ? ' (' + err.name + ')' : '')
      );
    });
  }
  function openCamera() {
    if (!cameraSupported()) {
      camera.failed = true;
    }
    if (camera.failed) {
      if (els.captureInput) els.captureInput.click();
      return;
    }
    if (els.camera) els.camera.hidden = false;
    camera.shots = 0;
    updateCameraShots();
    startCameraStream();
  }
  function captureFrame() {
    var video = els.video;
    if (!video || !video.videoWidth || !video.videoHeight) return;
    var width = video.videoWidth;
    var height = video.videoHeight;
    var scale = Math.min(1, 2400 / Math.max(width, height));
    var canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    var ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    canvasToBlob(canvas, 'image/jpeg', 0.9).then(function (blob) {
      if (!blob) return;
      addCapturedFrame(blob);
      camera.shots += 1;
      updateCameraShots();
      if (typeof navigator.vibrate === 'function') {
        try { navigator.vibrate(12); } catch (e) { /* ignore */ }
      }
    }, function () {
      showCameraError(t('cameraDenied', 'capture failed'));
    });
  }

  function countReady() {
    var n = 0;
    for (var i = 0; i < app.items.length; i += 1) {
      if (app.items[i].status === 'ready') n += 1;
    }
    return n;
  }
  function countPending() {
    var n = 0;
    for (var i = 0; i < app.items.length; i += 1) {
      if (app.items[i].status !== 'sent') n += 1;
    }
    return n;
  }
  function removable(item) {
    return !!item && (item.status === 'ready' || item.status === 'error' || item.status === 'pending');
  }
  function dropItem(item) {
    if (!item) return;
    item.removed = true;
    if (item.el && item.el.parentNode) item.el.parentNode.removeChild(item.el);
    item.el = null;
    var idx = app.items.indexOf(item);
    if (idx >= 0) app.items.splice(idx, 1);
  }
  function updateSendBar() {
    var ready = countReady();
    var label = ready > 0
      ? t('sendCount', 'Send {n} photos').replace('{n}', String(ready))
      : t('send', 'Send');
    if (app.sending) label = t('sending', 'Sending...');
    if (els.sendLabel) els.sendLabel.textContent = label;
    if (els.sendBtn) {
      els.sendBtn.disabled = app.expired || app.sending || ready === 0;
      els.sendBtn.setAttribute('data-cam-send-count', String(ready));
      els.sendBtn.setAttribute('aria-label',
        ready > 0
          ? t('sendAriaCount', 'Send {n} photos').replace('{n}', String(ready))
          : t('sendAria', 'Send photos'));
    }
    if (els.clearBtn) {
      var any = false;
      for (var i = 0; i < app.items.length; i += 1) {
        if (removable(app.items[i])) { any = true; break; }
      }
      els.clearBtn.disabled = app.expired || app.sending || !any;
    }
    document.body.setAttribute('data-cam-pending', String(ready));
  }
  function clearPending() {
    if (app.expired || app.sending) return;
    for (var i = app.items.length - 1; i >= 0; i -= 1) {
      if (removable(app.items[i])) dropItem(app.items[i]);
    }
    hideError();
    syncStatus();
  }
  function removeSent() {
    for (var i = app.items.length - 1; i >= 0; i -= 1) {
      if (app.items[i].status === 'sent') dropItem(app.items[i]);
    }
    syncStatus();
  }

  function syncStatus() {
    if (app.expired) {
      updateSendBar();
      setStatus('error', t('tokenExpired', 'link expired'));
      return;
    }
    var failed = false, busy = false, sent = false;
    for (var i = 0; i < app.items.length; i += 1) {
      var s = app.items[i].status;
      if (s === 'error') failed = true;
      else if (s === 'compressing' || s === 'uploading' || s === 'pending') busy = true;
      else if (s === 'sent') sent = true;
    }
    setRetryAllVisible(failed);
    var ready = countReady();
    if (app.sending) setStatus('working', t('sending', 'Sending...'));
    else if (busy) setStatus('working', t('working', 'working'));
    else if (failed) setStatus('error', t('failed', 'failed'));
    else if (sent) setStatus('done', t('done', 'sent'));
    else if (ready > 0) setStatus('idle', t('pending', '{n} selected').replace('{n}', String(ready)));
    else setStatus('idle', t('idle', 'idle'));
    updateSendBar();
  }

  function expireLink() {
    if (app.expired) return;
    app.expired = true;
    stopTimer();
    if (els.captureBtn) els.captureBtn.disabled = true;
    if (els.galleryBtn) els.galleryBtn.disabled = true;
    if (els.sendBtn) els.sendBtn.disabled = true;
    if (els.clearBtn) els.clearBtn.disabled = true;
    if (els.remaining) els.remaining.textContent = t('expiredLabel', 'expired');
    for (var i = 0; i < app.items.length; i += 1) {
      if (app.items[i].status === 'compressing' || app.items[i].status === 'uploading') {
        app.items[i].status = 'error';
        app.items[i].error = t('tokenExpired', 'link expired');
        renderItem(app.items[i]);
      }
    }
    var message = t('tokenExpired', 'link expired');
    var secondary = alt('tokenExpired');
    if (secondary) message = message + '\n' + secondary;
    showError(message);
    setStatus('error', t('tokenExpired', 'link expired'));
    setRetryAllVisible(false);
  }

  function userError(message, sub) {
    var err = new Error(message);
    err.userMessage = message;
    if (sub) err.sub = sub;
    return err;
  }
  function imageReadError() {
    return userError(t('decodeError', 'cannot read image'), alt('decodeError'));
  }

  // server 的错误码 → 本地化文案（DESIGN 3.6：inject 失败为 inject-failed:<code>）。
  function reasonForCode(rawCode) {
    var code = String(rawCode || '');
    if (code.indexOf('inject-failed:') === 0) code = code.slice('inject-failed:'.length);
    switch (code) {
      case 'too-large':
      case 'image-too-large': return t('tooLarge', 'too large');
      case 'rate-limited': return t('rateLimited', 'too many uploads');
      case 'no-image':
      case 'image-invalid': return t('noImage', 'no image');
      case 'model-no-vision': return t('noVision', 'model cannot see images');
      case 'session-not-found': return t('sessionGone', 'conversation not found');
      case 'inject-timeout': return t('timeout', 'timeout');
      case 'inject-failed': return t('uploadFailed', 'upload failed');
      default: return '';
    }
  }

  function createItem(file) {
    var item = {
      id: 'p' + (++app.seq),
      file: file,
      url: null,
      blob: null,
      filename: file && file.name ? String(file.name) : 'photo.jpg',
      status: 'pending',
      error: null,
      el: null,
      caption: null,
      retryBtn: null
    };
    try { item.url = URL.createObjectURL(file); } catch (e) { item.url = null; }

    var fig = document.createElement('figure');
    fig.className = 'thumb';
    fig.setAttribute('data-state', 'pending');
    fig.setAttribute('data-id', item.id);
    fig.setAttribute('data-cam-preview', '');
    var img = document.createElement('img');
    img.alt = t('photoAlt', 'photo');
    img.decoding = 'async';
    if (item.url) img.src = item.url;
    var caption = document.createElement('figcaption');
    caption.className = 'thumb-state';
    caption.textContent = t('preparing', 'preparing');
    var retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'retry';
    retry.hidden = true;
    retry.setAttribute('data-cam-retry', '');
    retry.setAttribute('aria-label', t('retry', 'retry'));
    retry.textContent = t('retry', 'retry');

    fig.appendChild(img);
    fig.appendChild(caption);
    fig.appendChild(retry);
    item.el = fig;
    item.caption = caption;
    item.retryBtn = retry;
    if (els.previews) els.previews.appendChild(fig);
    // Track every created item in the page state: syncStatus() derives the
    // working/done/error indicator and retry-all from this list, so an item
    // that never enters it would leave the status stuck on idle.
    app.items.push(item);
    return item;
  }

  function itemLabel(item) {
    switch (item.status) {
      case 'compressing': return t('compressing', 'compressing');
      case 'ready': return t('ready', 'ready to send');
      case 'uploading': return t('uploading', 'uploading');
      case 'sent': return t('sent', 'sent');
      case 'error': return t('failed', 'failed');
      default: return t('preparing', 'preparing');
    }
  }
  function renderItem(item) {
    if (!item || !item.el) return;
    item.el.setAttribute('data-state', item.status);
    if (item.caption) item.caption.textContent = itemLabel(item);
    if (item.retryBtn) item.retryBtn.hidden = item.status !== 'error';
    if (item.status === 'error' && item.error) item.el.setAttribute('title', item.error);
    else item.el.removeAttribute('title');
  }

  function canvasToBlob(canvas, type, quality) {
    return new Promise(function (resolve, reject) {
      if (typeof canvas.toBlob === 'function') {
        canvas.toBlob(function (blob) {
          if (blob && blob.size > 0) resolve(blob);
          else reject(new Error('canvas.toBlob returned empty blob'));
        }, type, quality);
        return;
      }
      try {
        var dataUrl = canvas.toDataURL(type, quality);
        var parts = dataUrl.split(',');
        var binary = atob(parts[1]);
        var bytes = new Uint8Array(binary.length);
        for (var i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
        resolve(new Blob([bytes], { type: type }));
      } catch (e) {
        reject(e);
      }
    });
  }

  function compressImage(file) {
    return new Promise(function (resolve, reject) {
      var type = String((file && file.type) || '').toLowerCase();
      // HEIC/HEIF: 先交给浏览器解码（iOS Safari 支持），失败再由 img.onerror 给出提示。
      if (type && type.indexOf('image/') !== 0) {
        reject(userError(t('notImage', 'not an image')));
        return;
      }
      if (type === 'image/gif') { resolve(file); return; }

      var url;
      try { url = URL.createObjectURL(file); } catch (e) { reject(imageReadError()); return; }
      var img = new Image();
      var done = false;
      function finish(fn, value) {
        if (done) return;
        done = true;
        try { URL.revokeObjectURL(url); } catch (e) {}
        fn(value);
      }
      img.onload = function () {
        try {
          var width = img.naturalWidth || img.width;
          var height = img.naturalHeight || img.height;
          if (!width || !height) { finish(reject, imageReadError()); return; }
          var maxDim = Math.max(width, height);
          if (file.size <= 1.5 * 1024 * 1024 && maxDim <= 2400) { finish(resolve, file); return; }
          var scale = Math.min(1, 2400 / maxDim);
          var canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round(width * scale));
          canvas.height = Math.max(1, Math.round(height * scale));
          var ctx = canvas.getContext('2d');
          if (!ctx) { finish(resolve, file); return; }
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          canvasToBlob(canvas, 'image/jpeg', 0.85).then(
            function (blob) { finish(resolve, blob && blob.size > 0 ? blob : file); },
            function () { finish(resolve, file); }
          );
        } catch (e) {
          finish(reject, imageReadError());
        }
      };
      img.onerror = function () { finish(reject, imageReadError()); };
      img.src = url;
    });
  }

  function prepare(item) {
    item.status = 'compressing';
    item.error = null;
    renderItem(item);
    syncStatus();
    return compressImage(item.file).then(function (blob) {
      item.blob = blob || item.file;
      var filename = item.filename || 'photo.jpg';
      if (item.blob && item.blob.type === 'image/jpeg' && !/\.jpe?g$/i.test(filename)) {
        filename = filename.replace(/\.[^.]+$/, '') + '.jpg';
      }
      item.filename = filename;
      item.status = 'ready';
      renderItem(item);
      syncStatus();
    }).catch(function (err) {
      item.status = 'error';
      item.error = (err && err.userMessage) || t('uploadFailed', 'upload failed');
      if (err && err.sub) item.error = item.error + '\n' + err.sub;
      renderItem(item);
      syncStatus();
    });
  }

  function failItems(items, message) {
    for (var i = 0; i < items.length; i += 1) {
      if (items[i].status === 'uploading') {
        items[i].status = 'error';
        items[i].error = message;
        renderItem(items[i]);
      }
    }
    syncStatus();
  }

  function sendPending() {
    if (app.expired || app.sending) return Promise.resolve();
    var ready = [];
    for (var i = 0; i < app.items.length; i += 1) {
      if (app.items[i].status === 'ready') ready.push(app.items[i]);
    }
    if (!ready.length) { syncStatus(); return Promise.resolve(); }

    var form = new FormData();
    for (var j = 0; j < ready.length; j += 1) {
      form.append('photo', ready[j].blob || ready[j].file, ready[j].filename || 'photo.jpg');
      ready[j].status = 'uploading';
      renderItem(ready[j]);
    }
    app.sending = true;
    hideError();
    syncStatus();
    setProgress(0, true);

    // 用 XHR 而不是 fetch：手机上传大图时可以显示真实进度。
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      xhr.open('POST', uploadUrl, true);
      xhr.timeout = 120000;
      xhr.setRequestHeader('Accept', 'application/json');
      xhr.upload.onprogress = function (event) {
        if (event.lengthComputable && event.total > 0) {
          setProgress(Math.round((event.loaded / event.total) * 100), true);
        }
      };
      xhr.onload = function () {
        var data = null;
        try { data = JSON.parse(xhr.responseText); } catch (e) { data = null; }
        resolve({
          response: { ok: xhr.status >= 200 && xhr.status < 300, status: xhr.status },
          data: data
        });
      };
      xhr.onerror = function () { reject(new Error('network')); };
      xhr.ontimeout = function () { reject(new Error('timeout')); };
      xhr.send(form);
    }).then(function (result) {
      var response = result.response;
      var data = result.data;
      if (response.ok && data && data.ok === true) {
        var count = data.value && Number(data.value.count) > 0 ? Number(data.value.count) : ready.length;
        addCount(count);
        for (var k = 0; k < ready.length; k += 1) {
          ready[k].status = 'sent';
          ready[k].error = null;
          renderItem(ready[k]);
        }
        app.sending = false;
        setProgress(100, false);
        hideError();
        syncStatus();
        window.setTimeout(removeSent, 1200);
        return;
      }
      var code = data && data.error && data.error.code ? String(data.error.code) : '';
      var message = data && data.error && data.error.message ? String(data.error.message) : '';
      if (response.status === 410 || code === 'invalid-token') {
        app.sending = false;
        setProgress(0, false);
        expireLink();
        return;
      }
      var reason = reasonForCode(code);
      if (!reason) {
        if (response.status === 413) reason = t('tooLarge', 'too large');
        else if (response.status === 429) reason = t('rateLimited', 'too many uploads');
        else reason = t('uploadFailed', 'upload failed');
        if (code) reason = reason + ' (' + code + ')' + (message ? ': ' + message : '');
      }
      app.sending = false;
      setProgress(0, false);
      failItems(ready, reason);
      showError(reason);
    }).catch(function () {
      app.sending = false;
      setProgress(0, false);
      var reason = t('networkError', 'network error');
      failItems(ready, reason);
      showError(reason);
    });
  }

  function handleFiles(fileList) {
    if (app.expired || app.sending) return;
    var files = [];
    for (var i = 0; i < (fileList ? fileList.length : 0); i += 1) {
      if (fileList[i]) files.push(fileList[i]);
    }
    if (!files.length) return;
    hideError();
    var room = MAX_FILES - countPending();
    if (room <= 0) {
      showError(t('maxFiles', 'Up to {n} photos per send.').replace('{n}', String(MAX_FILES)));
      return;
    }
    var trimmed = files.length > room;
    if (trimmed) files = files.slice(0, room);
    var items = [];
    for (var j = 0; j < files.length; j += 1) items.push(createItem(files[j]));
    // 手动发送：只压缩并预览，等用户点「发送 N 张」才上传。
    syncStatus();
    var chain = Promise.resolve();
    for (var k = 0; k < items.length; k += 1) {
      (function (item) {
        chain = chain.then(function () { return prepare(item); });
      })(items[k]);
    }
    chain.then(function () {
      if (app.expired) { syncStatus(); return; }
      syncStatus();
      if (trimmed) {
        showError(t('maxFiles', 'Up to {n} photos per send.').replace('{n}', String(MAX_FILES)));
      }
    }, function () { syncStatus(); });
  }

  function retryItem(item) {
    if (app.expired || app.sending || !item) return;
    hideError();
    item.error = null;
    var work;
    if (item.blob) {
      item.status = 'ready';
      renderItem(item);
      work = Promise.resolve();
    } else {
      work = prepare(item);
    }
    // 重试只是重新进入“待发送”，仍由用户点发送（不自动上传）。
    work.then(function () { syncStatus(); }, function () { syncStatus(); });
  }

  function retryAll() {
    if (app.expired || app.sending) return;
    var failed = [];
    for (var i = 0; i < app.items.length; i += 1) {
      if (app.items[i].status === 'error') failed.push(app.items[i]);
    }
    if (!failed.length) return;
    hideError();
    for (var j = 0; j < failed.length; j += 1) {
      failed[j].error = null;
      failed[j].status = 'pending';
      renderItem(failed[j]);
    }
    syncStatus();
    var chain = Promise.resolve();
    for (var k = 0; k < failed.length; k += 1) {
      (function (item) {
        chain = chain.then(function () {
          if (item.blob) { item.status = 'ready'; renderItem(item); return; }
          return prepare(item);
        });
      })(failed[k]);
    }
    chain.then(function () { syncStatus(); }).catch(function () { syncStatus(); });
  }

  function wireEvents() {
    if (els.captureBtn) {
      els.captureBtn.addEventListener('click', function () {
        if (app.expired) return;
        if (cameraSupported() && !camera.failed) openCamera();
        else if (els.captureInput) els.captureInput.click();
      });
    }
    if (els.shutter) els.shutter.addEventListener('click', captureFrame);
    if (els.cameraClose) els.cameraClose.addEventListener('click', closeCamera);
    if (els.flip) {
      els.flip.addEventListener('click', function () {
        camera.facing = camera.facing === 'environment' ? 'user' : 'environment';
        startCameraStream();
      });
    }
    if (els.secureHint && CFG.httpsUrl && !CFG.secure) els.secureHint.hidden = false;
    document.addEventListener('pagehide', stopCameraStream);
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) {
        if (els.camera && !els.camera.hidden) stopCameraStream();
      } else if (els.camera && !els.camera.hidden && !camera.stream) {
        startCameraStream();
      }
    });
    if (els.galleryBtn) {
      els.galleryBtn.addEventListener('click', function () {
        if (!app.expired && els.galleryInput) els.galleryInput.click();
      });
    }
    function onInputChange(event) {
      var input = event.target;
      var files = input.files;
      try {
        handleFiles(files);
      } finally {
        try { input.value = ''; } catch (e) {}
      }
    }
    if (els.captureInput) els.captureInput.addEventListener('change', onInputChange);
    if (els.galleryInput) els.galleryInput.addEventListener('change', onInputChange);

    if (els.previews) {
      els.previews.addEventListener('click', function (event) {
        var target = event.target;
        if (!target || typeof target.closest !== 'function') return;
        var retryBtn = target.closest('[data-cam-retry]');
        if (!retryBtn) return;
        var fig = retryBtn.closest('[data-cam-preview]');
        if (!fig) return;
        var id = fig.getAttribute('data-id');
        for (var i = 0; i < app.items.length; i += 1) {
          if (app.items[i].id === id) { retryItem(app.items[i]); return; }
        }
      });
    }
    if (els.sendBtn) els.sendBtn.addEventListener('click', function () { void sendPending(); });
    if (els.clearBtn) els.clearBtn.addEventListener('click', clearPending);
    if (els.retryAll) els.retryAll.addEventListener('click', retryAll);
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden && !app.expired) tick();
    });
    window.addEventListener('online', function () { hideError(); });
  }

  wireEvents();
  startTimer();
  syncStatus();
  if (deadline - Date.now() <= 0) expireLink();
})();
`;

function escapeHtml(value) {
  return String(value === undefined || value === null ? '' : value).replace(
    /[&<>"']/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch],
  );
}

/** 内联脚本里的 JSON：转义 `<`，避免任何值（title/version 等）打断 script 标签。 */
function inlineJson(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/**
 * 渲染手机拍照页。
 * @param {{token: string, title?: string, expiresAt: number, serverTime: number, version?: string, lang?: 'zh'|'en'}} info
 * @returns {string} 完整 HTML 文档
 */
export function renderCameraPage({
  token,
  title,
  expiresAt,
  serverTime,
  version,
  lang,
  maxFiles,
  secure,
  httpsUrl,
  setupUrl,
  httpsPort,
} = {}) {
  const locale = lang === 'zh' ? 'zh' : 'en';
  const strings = STRINGS[locale];
  const altLocale = locale === 'zh' ? 'en' : 'zh';
  const altStrings = STRINGS[altLocale];
  const titleText = typeof title === 'string' ? title : '';
  const versionText = typeof version === 'string' ? version : '0.0.0';
  const expires = Number.isFinite(Number(expiresAt)) ? Number(expiresAt) : Date.now();
  const servedAt = Number.isFinite(Number(serverTime)) ? Number(serverTime) : Date.now();

  const configJson = {
    token: String(token || ''),
    expiresAt: expires,
    serverTime: servedAt,
    secure: secure === true,
    httpsUrl: typeof httpsUrl === 'string' && httpsUrl.length > 0 ? httpsUrl : null,
    setupUrl: typeof setupUrl === 'string' && setupUrl.length > 0 ? setupUrl : null,
    httpsPort: Number.isFinite(Number(httpsPort)) ? Number(httpsPort) : null,
    maxFiles:
      Number.isFinite(Number(maxFiles)) && Number(maxFiles) > 0
        ? Math.trunc(Number(maxFiles))
        : 6,
    strings,
    alt: {
      decodeError: altStrings.decodeError,
      tokenExpired: altStrings.tokenExpired,
    },
  };

  const pageTitle = titleText
    ? `${strings.docTitle} · ${titleText}`
    : strings.docTitle;

  return `<!doctype html>
<html lang="${locale}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#0b1220" media="(prefers-color-scheme: dark)">
<meta name="theme-color" content="#eef2f7" media="(prefers-color-scheme: light)">
<meta name="referrer" content="no-referrer">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="format-detection" content="telephone=no">
<title>${escapeHtml(pageTitle)}</title>
<style>${CSS}</style>
</head>
<body data-cam-page data-cam-status="idle" data-cam-secure="${secure === true ? '1' : '0'}">
<main class="shell">
  <header class="hero">
    <div class="hero-top">
      <span class="brand" aria-hidden="true">${CAMERA_ICON}</span>
      <div class="hero-titles">
        <h1>${escapeHtml(strings.appTitle)}</h1>
        <p class="target"><span class="target-label">${escapeHtml(strings.target)}</span><strong data-cam-title title="${escapeHtml(titleText)}">${escapeHtml(titleText || strings.defaultTitle)}</strong></p>
      </div>
      <div class="counter" title="${escapeHtml(strings.sentLabel)}"><strong data-cam-count="0">0</strong><span>${escapeHtml(strings.sentLabel)}</span></div>
    </div>
    <div class="meta-row">
      <span class="timer"><span class="timer-label">${escapeHtml(strings.remaining)}</span><strong data-cam-remaining>--:--</strong></span>
      <span class="version">v${escapeHtml(versionText)}</span>
    </div>
  </header>

  <section class="actions" aria-label="${escapeHtml(strings.uploadSection)}">
    <button type="button" class="btn primary" data-cam-capture-btn aria-label="${escapeHtml(strings.captureAria)}">${CAMERA_ICON}<span>${escapeHtml(strings.capture)}</span></button>
    <button type="button" class="btn ghost" data-cam-gallery-btn aria-label="${escapeHtml(strings.galleryAria)}">${IMAGE_ICON}<span>${escapeHtml(strings.gallery)}</span></button>
    <input type="file" accept="image/*" capture="environment" data-cam-input-capture hidden>
    <input type="file" accept="image/*" multiple data-cam-input-gallery hidden>
  </section>

  <section class="statusline" aria-live="polite">
    <span class="status-dot" aria-hidden="true"></span>
    <span data-cam-status-text>${escapeHtml(strings.idle)}</span>
  </section>

  <div class="error" data-cam-error role="alert" hidden></div>
  <button type="button" class="btn ghost retry-all" data-cam-retry-all hidden>${escapeHtml(strings.retryAll)}</button>

  <section class="previews" data-cam-previews aria-live="polite" aria-label="${escapeHtml(strings.previewSection)}"></section>

  <section class="sendbar" aria-label="${escapeHtml(strings.sendSection)}">
    <button type="button" class="btn primary send" data-cam-send data-cam-send-count="0" aria-label="${escapeHtml(strings.sendAria)}" disabled><span data-cam-send-label>${escapeHtml(strings.send)}</span></button>
    <button type="button" class="btn ghost clear" data-cam-clear aria-label="${escapeHtml(strings.clearAria)}" disabled>${escapeHtml(strings.clear)}</button>
  </section>

  <div class="progress" data-cam-progress-wrap hidden><span data-cam-progress></span></div>

  <section class="secure-hint" data-cam-secure-hint hidden>
    <h2>${escapeHtml(strings.secureTitle)}</h2>
    <p>${escapeHtml(strings.secureBody)}</p>
    <div class="secure-actions">
      <a class="btn ghost" data-cam-secure-setup href="${escapeHtml(setupUrl || '#')}">${escapeHtml(strings.secureSetup)}</a>
      <a class="btn primary" data-cam-secure-open href="${escapeHtml(httpsUrl || '#')}">${escapeHtml(strings.secureOpen)}</a>
    </div>
  </section>

  <footer class="foot">${escapeHtml(strings.privacy)}</footer>
</main>
<section class="camera" data-cam-camera hidden aria-label="${escapeHtml(strings.cameraTitle)}">
  <video data-cam-video playsinline autoplay muted></video>
  <div class="camera-top">
    <span data-cam-camera-count>${escapeHtml(strings.cameraShots.replace('{n}', '0'))}</span>
    <button type="button" data-cam-camera-close>${escapeHtml(strings.cameraClose)}</button>
  </div>
  <div class="camera-error" data-cam-camera-error hidden></div>
  <div class="camera-controls">
    <div class="camera-side">
      <button type="button" data-cam-flip>${escapeHtml(strings.cameraFlip)}</button>
      <small>${escapeHtml(strings.cameraNoFlash)}</small>
    </div>
    <button type="button" class="shutter" data-cam-shutter aria-label="${escapeHtml(strings.cameraShutter)}"></button>
    <div class="camera-side"></div>
  </div>
</section>
<noscript><p class="noscript">${escapeHtml(strings.enableJs)}</p></noscript>
<script>window.__DSH_CAMERA__=${inlineJson(configJson)};</script>
<script>${PAGE_JS}</script>
</body>
</html>`;
}

export default renderCameraPage;
