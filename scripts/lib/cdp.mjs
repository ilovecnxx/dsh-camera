// 手写 Chrome DevTools Protocol 客户端（Node 24 全局 WebSocket/fetch），不依赖 puppeteer。
//
// 用法：
//   const browser = await launchChrome({ userDataDir: '/tmp/cam-chrome', logger });
//   const page = await browser.newPage('http://127.0.0.1:3099/?token=...');
//   await page.waitFor(() => document.querySelector('#root'));
//   await page.screenshot('verification/gui.png');
//   await browser.close();
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const DEFAULT_CHROME = '/usr/bin/google-chrome';

function logError(...args) {
  // 只做最低限度日志，避免污染 node --test 的 TAP 输出
  if (process.env.DSH_CAMERA_DEBUG === '1') console.error('[cdp]', ...args);
}

/** 把函数源码 + 参数序列化成 Runtime.evaluate 表达式。 */
function callExpression(fn, args = []) {
  const src = typeof fn === 'function' ? fn.toString() : String(fn);
  return `(${src})(...${JSON.stringify(args)})`;
}

export class CdpError extends Error {
  constructor(method, error) {
    super(`CDP ${method} failed: ${error?.message ?? JSON.stringify(error)}`);
    this.name = 'CdpError';
    this.method = method;
    this.code = error?.code;
    this.data = error?.data;
  }
}

/** 一个 WebSocket 连接（browser 级或 flattened session 级共用）。 */
export class CdpConnection {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Set();
    this.closed = false;
    ws.addEventListener('message', (event) => {
      let msg;
      try {
        msg = JSON.parse(typeof event.data === 'string' ? event.data : Buffer.from(event.data).toString('utf8'));
      } catch (err) {
        logError('bad CDP message', err);
        return;
      }
      if (msg.id !== undefined && msg.id !== null) {
        const pending = this.pending.get(msg.id);
        if (!pending) return;
        this.pending.delete(msg.id);
        if (msg.error) pending.reject(new CdpError(pending.method, msg.error));
        else pending.resolve(msg.result);
        return;
      }
      for (const listener of this.listeners) {
        try {
          listener(msg);
        } catch (err) {
          logError('listener threw', err);
        }
      }
    });
    ws.addEventListener('close', () => {
      this.closed = true;
      for (const [, pending] of this.pending) {
        pending.reject(new Error(`CDP connection closed before ${pending.method} responded`));
      }
      this.pending.clear();
    });
  }

  static async connect(wsUrl, { timeoutMs = 15000 } = {}) {
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`CDP WebSocket connect timeout: ${wsUrl}`)), timeoutMs);
      const cleanup = () => clearTimeout(timer);
      ws.addEventListener('open', () => {
        cleanup();
        resolve();
      }, { once: true });
      ws.addEventListener('error', (event) => {
        cleanup();
        reject(new Error(`CDP WebSocket error: ${event?.message ?? 'unknown'} (${wsUrl})`));
      }, { once: true });
    });
    return new CdpConnection(ws);
  }

  send(method, params = {}, sessionId) {
    if (this.closed) return Promise.reject(new Error(`CDP connection closed (${method})`));
    const id = this.nextId++;
    const message = { id, method, params };
    if (sessionId) message.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      try {
        this.ws.send(JSON.stringify(message));
      } catch (err) {
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  onEvent(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close() {
    this.closed = true;
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

export class Browser {
  constructor({ wsUrl, proc, userDataDir, logFile }) {
    this.wsUrl = wsUrl;
    this.proc = proc;
    this.userDataDir = userDataDir;
    this.logFile = logFile;
    this.conn = null;
    this.pages = new Set();
  }

  static async connect(wsUrl, meta = {}) {
    const browser = new Browser({ wsUrl, ...meta });
    browser.conn = await CdpConnection.connect(wsUrl);
    return browser;
  }

  send(method, params) {
    return this.conn.send(method, params);
  }

  async version() {
    return this.send('Browser.getVersion');
  }

  /** 新建标签页并 attach，返回 Page 封装。 */
  async newPage(url = 'about:blank') {
    const { targetId } = await this.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
    const page = new Page(this, targetId, sessionId);
    this.pages.add(page);
    await page.send('Page.enable');
    if (url && url !== 'about:blank') await page.goto(url);
    return page;
  }

  /** 按 target 列表查找已有页面（可选项：url 前缀）。 */
  async targets() {
    const { targetInfos } = await this.send('Target.getTargets');
    return targetInfos.filter((t) => t.type === 'page');
  }

  async closePage(page) {
    this.pages.delete(page);
    try {
      await this.send('Target.closeTarget', { targetId: page.targetId });
    } catch (err) {
      logError('closeTarget failed', err.message);
    }
  }

  async close() {
    try {
      this.conn?.close();
    } catch {
      /* ignore */
    }
    if (this.proc && !this.proc.killed) {
      await killProcessGroup(this.proc);
    }
  }
}

export class Page {
  constructor(browser, targetId, sessionId) {
    this.browser = browser;
    this.targetId = targetId;
    this.sessionId = sessionId;
    this.consoleMessages = [];
    this.pageErrors = [];
    this.connection = browser.conn;
    this.connection.onEvent((msg) => {
      if (msg.sessionId !== this.sessionId) return;
      if (msg.method === 'Runtime.consoleAPICalled') {
        const text = (msg.params.args || [])
          .map((a) => (a.value !== undefined ? String(a.value) : a.description ?? a.type))
          .join(' ');
        this.consoleMessages.push({ type: msg.params.type, text, ts: Date.now() });
        if (this.consoleMessages.length > 500) this.consoleMessages.shift();
      } else if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails;
        this.pageErrors.push({
          text: d?.exception?.description ?? d?.text ?? 'unknown exception',
          url: d?.url,
          line: d?.lineNumber,
          ts: Date.now(),
        });
      }
    });
  }

  send(method, params = {}) {
    return this.connection.send(method, params, this.sessionId);
  }

  async enableRuntime() {
    await this.send('Runtime.enable');
  }

  /** 导航并等待 document.readyState === 'complete'（或超时抛错）。 */
  async goto(url, { timeoutMs = 30000 } = {}) {
    await this.send('Page.navigate', { url });
    await this.waitFor(`document.readyState === 'complete'`, {
      timeoutMs,
      label: `navigate ${url}`,
    });
    return url;
  }

  /** 在页面上下文求值，默认 awaitPromise + returnByValue。 */
  async evaluate(expression, { awaitPromise = true, returnByValue = true, timeoutMs = 20000 } = {}) {
    const timer = delay(timeoutMs).then(() => {
      throw new Error(`Runtime.evaluate timeout after ${timeoutMs}ms: ${String(expression).slice(0, 200)}`);
    });
    const result = await Promise.race([
      this.send('Runtime.evaluate', {
        expression,
        awaitPromise,
        returnByValue,
        userGesture: true,
      }),
      timer,
    ]);
    if (result.exceptionDetails) {
      const d = result.exceptionDetails;
      throw new Error(
        `page evaluate threw: ${d.exception?.description ?? d.text ?? JSON.stringify(d)}`,
      );
    }
    return returnByValue ? result.result?.value : result.result;
  }

  /** 求值函数（自动 JSON 序列化参数）。 */
  async evaluateFunction(fn, args = [], opts) {
    return this.evaluate(callExpression(fn, args), opts);
  }

  /** 轮询直到表达式返回 truthy，返回该值。 */
  async waitFor(expression, { timeoutMs = 20000, intervalMs = 100, label } = {}) {
    const started = Date.now();
    let lastError = null;
    while (Date.now() - started < timeoutMs) {
      try {
        const value = await this.evaluate(expression, { awaitPromise: false, timeoutMs: Math.min(5000, timeoutMs) });
        if (value) return value;
        lastError = null;
      } catch (err) {
        lastError = err;
        // 页面导航中 evaluate 可能短暂失败；继续重试，直到超时。
      }
      await delay(intervalMs);
    }
    const suffix = lastError ? ` (last error: ${lastError.message})` : '';
    throw new Error(`waitFor timeout after ${timeoutMs}ms${label ? `: ${label}` : ''}: ${String(expression).slice(0, 300)}${suffix}`);
  }

  async waitForSelector(selector, opts = {}) {
    return this.waitFor(`!!document.querySelector(${JSON.stringify(selector)})`, {
      label: `selector ${selector}`,
      ...opts,
    });
  }

  /** 返回匹配元素数量。 */
  async count(selector) {
    return this.evaluate(`document.querySelectorAll(${JSON.stringify(selector)}).length`);
  }

  async text(selector) {
    return this.evaluate(
      `(() => { const el = document.querySelector(${JSON.stringify(selector)}); return el ? (el.innerText ?? el.textContent ?? '') : null; })()`,
    );
  }

  async attr(selector, name) {
    return this.evaluate(
      `(() => { const el = document.querySelector(${JSON.stringify(selector)}); return el ? el.getAttribute(${JSON.stringify(name)}) : null; })()`,
    );
  }

  /** 点击匹配元素（先 scrollIntoView；React onClick 用原生 click() 可触发）。 */
  async click(selector, { timeoutMs = 15000 } = {}) {
    await this.waitForSelector(selector, { timeoutMs });
    const clicked = await this.evaluate(
      `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.scrollIntoView({block:'center', inline:'center'}); el.click(); return true; })()`,
    );
    if (!clicked) throw new Error(`click failed, no element: ${selector}`);
    return clicked;
  }

  /** 对 contenteditable / input 输入文本：先 focus/select，再用 Input.insertText。 */
  async type(selector, value, { timeoutMs = 15000 } = {}) {
    await this.waitForSelector(selector, { timeoutMs });
    const focused = await this.evaluate(
      `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.focus(); if (el.select) el.select(); return true; })()`,
    );
    if (!focused) throw new Error(`type failed, no element: ${selector}`);
    await this.send('Input.insertText', { text: value });
    return true;
  }

  /** 给 <input type=file> 塞本地文件（CDP DOM.setFileInputFiles）。 */
  async setFileInputFiles(selector, files, { timeoutMs = 15000 } = {}) {
    await this.waitForSelector(selector, { timeoutMs });
    const handle = await this.evaluate(`document.querySelector(${JSON.stringify(selector)})`, {
      returnByValue: false,
    });
    const objectId = handle?.objectId;
    if (!objectId) throw new Error(`setFileInputFiles: no objectId for ${selector}`);
    try {
      await this.send('DOM.setFileInputFiles', { files, objectId });
    } catch (err) {
      // 回退：DOM.enable + getDocument + querySelector 得到 nodeId
      await this.send('DOM.enable');
      const { root } = await this.send('DOM.getDocument', { depth: -1, pierce: true });
      const { nodeId } = await this.send('DOM.querySelector', { nodeId: root.nodeId, selector });
      if (!nodeId) throw new Error(`setFileInputFiles: DOM.querySelector found nothing for ${selector}`);
      await this.send('DOM.setFileInputFiles', { files, nodeId });
    }
    return true;
  }

  /**
   * 开启 Network 域并记录请求/响应/失败/上传响应体，用于 E2E 失败定位。
   * @returns {Promise<{requests: object[], responses: object[], failures: object[], bodies: object[], stop: () => void}>}
   */
  async startNetworkCapture({ captureBodies = true, bodyUrlPattern = /\/upload/ } = {}) {
    const capture = { requests: [], responses: [], failures: [], bodies: [], events: [] };
    const off = this.connection.onEvent((msg) => {
      if (msg.sessionId !== this.sessionId) return;
      try {
        if (msg.method === 'Network.requestWillBeSent') {
          const request = msg.params.request;
          capture.requests.push({
            id: msg.params.requestId,
            method: request.method,
            url: request.url,
            headers: request.headers,
            hasPostData: request.hasPostData === true,
            postDataLength: request.postDataLength ?? null,
          });
        } else if (msg.method === 'Network.responseReceived') {
          const response = msg.params.response;
          const record = {
            id: msg.params.requestId,
            url: response.url,
            status: response.status,
            mimeType: response.mimeType,
            fromDiskCache: response.fromDiskCache === true,
          };
          capture.responses.push(record);
          if (captureBodies && bodyUrlPattern.test(response.url)) {
            this.send('Network.getResponseBody', { requestId: msg.params.requestId })
              .then(({ body, base64Encoded }) => {
                capture.bodies.push({
                  url: response.url,
                  status: response.status,
                  body: base64Encoded ? '<base64>' : String(body ?? '').slice(0, 4000),
                });
              })
              .catch((error) => capture.bodies.push({ url: response.url, error: error.message }));
          }
        } else if (msg.method === 'Network.loadingFailed') {
          capture.failures.push({
            id: msg.params.requestId,
            errorText: msg.params.errorText,
            blockedReason: msg.params.blockedReason ?? null,
            corsErrorStatus: msg.params.corsErrorStatus ?? null,
          });
        }
      } catch {
        /* capture must never break the test */
      }
    });
    await this.send('Network.enable');
    capture.stop = off;
    this.networkCapture = capture;
    return capture;
  }

  /** 截图到文件。 */
  async screenshot(file, { fullPage = false } = {}) {
    const params = { format: 'png' };
    if (fullPage) params.captureBeyondViewport = true;
    const { data } = await this.send('Page.captureScreenshot', params);
    fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    fs.writeFileSync(file, Buffer.from(data, 'base64'));
    return file;
  }

  /** 模拟移动设备视口（手机页 E2E）。 */
  async setMobileViewport({ width = 390, height = 844, deviceScaleFactor = 2 } = {}) {
    await this.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor,
      mobile: true,
    });
    await this.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  }

  async title() {
    return this.evaluate('document.title');
  }

  async close() {
    return this.browser.closePage(this);
  }
}

/** 等待 HTTP 端点可用（/json/version）。 */
async function waitDevtoolsHttp(port, timeoutMs = 20000) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return await res.json();
      lastError = new Error(`HTTP ${res.status}`);
    } catch (err) {
      lastError = err;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`Chrome DevTools endpoint not ready on :${port}: ${lastError?.message}`);
}

/**
 * 启动 headless Chrome 并连接 CDP。
 * 使用 --remote-debugging-port=0（交给系统分配），从 stderr 的
 * "DevTools listening on ws://..." 读取地址，避免端口冲突。
 */
export async function launchChrome({
  chromePath = DEFAULT_CHROME,
  userDataDir = '/tmp/cam-chrome-profile',
  windowSize = '1440,900',
  logFile = null,
  extraArgs = [],
  timeoutMs = 30000,
} = {}) {
  fs.rmSync(userDataDir, { recursive: true, force: true });
  fs.mkdirSync(userDataDir, { recursive: true });
  const args = [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
    '--disable-extensions',
    '--mute-audio',
    `--window-size=${windowSize}`,
    '--remote-debugging-port=0',
    `--user-data-dir=${userDataDir}`,
    'about:blank',
    ...extraArgs,
  ];
  const proc = spawn(chromePath, args, { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  let stderr = '';
  const wsUrl = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Chrome DevTools did not announce in ${timeoutMs}ms. stderr:\n${stderr.slice(-4000)}`)), timeoutMs);
    const onData = (chunk) => {
      stderr += chunk.toString();
      if (logFile) fs.appendFileSync(logFile, chunk);
      const m = /DevTools listening on (ws:\/\/[^\s]+)/.exec(stderr);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Chrome exited early (code ${code}). stderr:\n${stderr.slice(-4000)}`));
    });
  });
  proc.removeAllListeners('exit');
  proc.on('exit', () => logError('chrome exited'));
  const port = Number(new URL(wsUrl).port);
  const versionInfo = await waitDevtoolsHttp(port).catch(() => null);
  const browser = await Browser.connect(wsUrl, { proc, userDataDir, logFile });
  browser.port = port;
  browser.versionInfo = versionInfo;
  return browser;
}

/** 杀掉 spawn(detached:true) 的进程组，先 SIGTERM 后 SIGKILL。 */
export async function killProcessGroup(proc, { graceMs = 4000 } = {}) {
  if (!proc || proc.exitCode !== null) return;
  const pid = proc.pid;
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    try {
      proc.kill('SIGTERM');
    } catch {
      /* already gone */
    }
  }
  const exited = await waitExit(proc, graceMs);
  if (!exited) {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try {
        proc.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }
    await waitExit(proc, 3000);
  }
}

function waitExit(proc, timeoutMs) {
  if (proc.exitCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    proc.once('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}
