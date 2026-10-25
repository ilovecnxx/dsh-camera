// dsh-camera · 局域网 server 单元测试（DESIGN 3.6）
// 全部用 port:0 + 127.0.0.1 回环 + 假 injector，不碰 3080 上正在运行的 dsh web。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import path from 'node:path';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { startCameraServer } from '../lib/server.js';
import { TokenStore } from '../lib/tokens.js';

const CSP =
  "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data: blob:; connect-src 'self'; base-uri 'none'; form-action 'none'";

const LAN_INTERFACES = () => ({
  lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
  eth0: [{ address: '10.10.10.10', family: 'IPv4', internal: false }],
});
const NO_LAN_INTERFACES = () => ({});

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('server-test-png-bytes'),
]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]);

function boundaryFor(label) {
  return `----dshCamera${label}Boundary`;
}

function buildMultipart(parts, boundary) {
  const chunks = [];
  for (const part of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n`, 'latin1'));
    let disposition = `Content-Disposition: form-data; name="${part.name}"`;
    if (part.filename !== undefined) disposition += `; filename="${part.filename}"`;
    chunks.push(Buffer.from(`${disposition}\r\n`, 'utf8'));
    if (part.contentType) chunks.push(Buffer.from(`Content-Type: ${part.contentType}\r\n`, 'utf8'));
    chunks.push(Buffer.from('\r\n', 'latin1'));
    chunks.push(Buffer.isBuffer(part.data) ? part.data : Buffer.from(String(part.data), 'utf8'));
    chunks.push(Buffer.from('\r\n', 'latin1'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, 'latin1'));
  return Buffer.concat(chunks);
}

function multipartBody(parts, boundary) {
  return { contentType: `multipart/form-data; boundary=${boundary}`, body: buildMultipart(parts, boundary) };
}

function assertSecurityHeaders(response) {
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('content-security-policy'), CSP);
}

function silentLog() {
  return { info() {}, warn() {}, error() {}, debug() {} };
}

async function startHarness(t, options = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-cam-server-'));
  const clock = { value: 1_700_000_000_000 };
  const tokens = new TokenStore({
    file: path.join(dir, 'state.json'),
    ttlMs: options.ttlMs ?? 60_000,
    now: () => clock.value,
  });
  await tokens.load();

  const calls = [];
  const injector = {
    async deliver(input) {
      calls.push(input);
      if (options.deliverImpl) return options.deliverImpl(input);
      return { ok: true, requestId: 'req-1', count: input.files.length };
    },
  };
  const logs = { info: [], warn: [], error: [] };
  const log = {
    info: (...args) => logs.info.push(args),
    warn: (...args) => logs.warn.push(args),
    error: (...args) => logs.error.push(args),
    debug: () => {},
  };
  const config = {
    enabled: true,
    port: options.port ?? 0,
    bindHost: options.bindHost ?? '127.0.0.1',
    lanIpOverride: '',
    tokenTtlMs: options.ttlMs ?? 60_000,
    maxUploadBytes: options.maxUploadBytes ?? 1024 * 1024,
    maxFilesPerUpload: options.maxFilesPerUpload ?? 6,
    uploadsPerHour: options.uploadsPerHour ?? 120,
    ...(options.config || {}),
  };

  const server = await startCameraServer({
    config,
    tokens,
    injector,
    log,
    version: options.version ?? '9.9.9',
    lanCandidatesFn: options.lanCandidatesFn || LAN_INTERFACES,
  });
  t.after(async () => {
    await server.stop();
    await rm(dir, { recursive: true, force: true });
  });

  const base = `http://127.0.0.1:${server.port}`;
  const armed = tokens.arm({ sessionId: 'sess-1', title: '测试 <对话>' });
  return {
    dir,
    clock,
    tokens,
    calls,
    logs,
    config,
    server,
    base,
    armed,
    token: armed.token,
    uploadUrl: `${base}/c/${armed.token}/upload`,
  };
}

async function postUpload(url, contentType, body) {
  return fetch(url, { method: 'POST', headers: { 'content-type': contentType }, body });
}

// --------------------------------------------------------------------- 基础路由

test('GET / → 302 /c/invalid，且带安全头', async (t) => {
  const h = await startHarness(t);
  const res = await fetch(`${h.base}/`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/c/invalid');
  assertSecurityHeaders(res);
  await res.arrayBuffer();
});

test('GET /favicon.ico → 204', async (t) => {
  const h = await startHarness(t);
  const res = await fetch(`${h.base}/favicon.ico`);
  assert.equal(res.status, 204);
  assertSecurityHeaders(res);
  await res.arrayBuffer();
});

test('未知路径 / 错误方法 → 404 文本', async (t) => {
  const h = await startHarness(t);
  for (const url of [
    `${h.base}/nope`,
    `${h.base}/c/${h.token}/upload`, // GET 不允许
    `${h.base}/c/${h.token}/info/`,
  ]) {
    const res = await fetch(url);
    assert.equal(res.status, 404, url);
    assert.match(res.headers.get('content-type'), /text\/plain/);
    assertSecurityHeaders(res);
    await res.text();
  }
  const postPage = await fetch(`${h.base}/c/${h.token}`, { method: 'POST' });
  assert.equal(postPage.status, 404);
  await postPage.text();
  const postRoot = await fetch(`${h.base}/`, { method: 'POST', redirect: 'manual' });
  assert.equal(postRoot.status, 404);
  await postRoot.arrayBuffer();
});

// --------------------------------------------------------------------- 手机页

test('GET /c/:token：200 手机页，含 DESIGN 3.7 全部锚点/内联资源/安全头', async (t) => {
  const h = await startHarness(t);
  const res = await fetch(`${h.base}/c/${h.token}`, {
    headers: { 'accept-language': 'zh-CN,zh;q=0.9,en;q=0.5' },
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^text\/html/);
  assertSecurityHeaders(res);
  const html = await res.text();

  for (const anchor of [
    'data-cam-page',
    'data-cam-input-capture',
    'data-cam-input-gallery',
    'data-cam-status',
    'data-cam-count',
    'data-cam-error',
  ]) {
    assert.ok(html.includes(anchor), `页面缺少测试锚点 ${anchor}`);
  }
  assert.ok(html.includes('data-cam-status="idle"'));
  assert.ok(html.includes('<html lang="zh"'));
  assert.ok(html.includes('测试 &lt;对话&gt;')); // title 转义
  assert.ok(html.includes(h.token));
  assert.ok(html.includes(`"expiresAt":${h.armed.expiresAt}`));
  assert.ok(html.includes('window.__DSH_CAMERA__='));
  assert.ok(html.includes('capture="environment"'));
  assert.ok(html.includes('accept="image/*"'));
  assert.ok(html.includes('multiple'));
  assert.ok(html.includes('fetch('));
  assert.ok(html.includes('FormData'));
  assert.ok(html.includes('canvas'));
  assert.ok(html.includes('@media (prefers-color-scheme:dark)'));
  assert.ok(html.includes('env(safe-area-inset-top'));
  assert.ok(html.includes('aria-label'));
  // 无外部资源（DDESIGN 3.7）
  assert.equal(/src="https?:/i.test(html), false);
  assert.equal(/href="https?:/i.test(html), false);
  assert.equal(/<link[^>]+href=/i.test(html), false);
});

test('页面 JS：覆盖 DESIGN 上传错误码的中英文映射', async (t) => {
  const h = await startHarness(t);
  const zhResponse = await fetch(`${h.base}/c/${h.token}`, { headers: { 'accept-language': 'zh' } });
  const zh = await zhResponse.text();
  for (const code of [
    'invalid-token',
    'rate-limited',
    'too-large',
    'no-image',
    'image-invalid',
    'image-too-large',
    'model-no-vision',
    'session-not-found',
    'inject-timeout',
    'inject-failed',
  ]) {
    assert.ok(zh.includes(code), `中文页缺少错误码映射 ${code}`);
  }
  for (const hint of [
    '模型不支持看图',
    '上传太频繁',
    '图片太大',
    '没有识别到可上传的图片',
    '发送超时',
    '这个对话已不存在',
    '无法读取这张图片',
  ]) {
    assert.ok(zh.includes(hint), `中文页缺少文案 ${hint}`);
  }

  const enResponse = await fetch(`${h.base}/c/${h.token}`, { headers: { 'accept-language': 'en' } });
  const en = await enResponse.text();
  for (const hint of [
    'cannot see images',
    'Too many uploads',
    'too large',
    'No supported image',
    'timed out',
    'no longer exists',
    "Couldn't read this photo",
  ]) {
    assert.ok(en.includes(hint), `英文页缺少文案 ${hint}`);
  }
});

test('GET /c/:token：Accept-Language 决定 lang（en 缺省）', async (t) => {
  const h = await startHarness(t);
  const en = await fetch(`${h.base}/c/${h.token}`, { headers: { 'accept-language': 'en-US,en;q=0.9' } });
  assert.ok((await en.text()).includes('<html lang="en"'));
  const noHeader = await fetch(`${h.base}/c/${h.token}`);
  assert.ok((await noHeader.text()).includes('<html lang="en"'));
  const zhTw = await fetch(`${h.base}/c/${h.token}`, { headers: { 'accept-language': 'zh-TW' } });
  assert.ok((await zhTw.text()).includes('<html lang="zh"'));
});

test('GET /c/:token：无效/过长/未知 token → 410 友好页', async (t) => {
  const h = await startHarness(t);
  const badTokens = [
    'invalid',
    'short',
    'x'.repeat(15),
    'x'.repeat(65),
    'A'.repeat(23) + '.',
    'unknown-' + 'a'.repeat(16), // 格式合法但不存在
    'A'.repeat(24) + '!',
  ];
  for (const badToken of badTokens) {
    const res = await fetch(`${h.base}/c/${encodeURIComponent(badToken)}`);
    assert.equal(res.status, 410, badToken);
    assert.match(res.headers.get('content-type'), /^text\/html/);
    assertSecurityHeaders(res);
    const html = await res.text();
    assert.ok(html.includes('链接已失效') || html.includes('Link expired'));
    assert.ok(html.includes('data-cam-expired'));
  }
});

test('GET /c/:token：过期的 token → 410；info → 404', async (t) => {
  const h = await startHarness(t, { ttlMs: 60_000 });
  h.clock.value += 60_001;
  const page = await fetch(`${h.base}/c/${h.token}`);
  assert.equal(page.status, 410);
  await page.text();
  const info = await fetch(`${h.base}/c/${h.token}/info`);
  assert.equal(info.status, 404);
  const json = await info.json();
  assert.equal(json.ok, false);
  assert.equal(json.error.code, 'invalid-token');
  assertSecurityHeaders(info);
});

test('GET /c/:token/info：返回标题/有效期/计数/版本/语言', async (t) => {
  const h = await startHarness(t);
  const res = await fetch(`${h.base}/c/${h.token}/info`, {
    headers: { 'accept-language': 'zh-CN' },
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^application\/json/);
  assertSecurityHeaders(res);
  const json = await res.json();
  assert.equal(json.ok, true);
  assert.equal(json.value.title, '测试 <对话>');
  assert.equal(json.value.expiresAt, h.armed.expiresAt);
  assert.equal(json.value.uploads, 0);
  assert.equal(json.value.version, '9.9.9');
  assert.equal(json.value.lang, 'zh');
  assert.equal(typeof json.value.serverTime, 'number');
  assert.ok(Math.abs(json.value.serverTime - Date.now()) < 60_000);
});

test('GET /c/:token/info：非法 token 格式 → 404 JSON', async (t) => {
  const h = await startHarness(t);
  for (const badToken of ['short', 'bad token', 'A'.repeat(65), 'unknown-' + 'b'.repeat(16)]) {
    const res = await fetch(`${h.base}/c/${encodeURIComponent(badToken)}/info`);
    assert.equal(res.status, 404, badToken);
    const json = await res.json();
    assert.equal(json.ok, false);
    assert.equal(json.error.code, 'invalid-token');
    assert.equal(typeof json.error.message, 'string');
  }
});

// --------------------------------------------------------------------- upload 正常路径

test('POST upload：multipart 单图 → 200，假 injector 收到 Buffer/mediaType/filename', async (t) => {
  const h = await startHarness(t);
  const boundary = boundaryFor('single');
  const { contentType, body } = multipartBody(
    [{ name: 'photo', filename: 'a.png', contentType: 'image/png', data: PNG }],
    boundary,
  );
  const res = await postUpload(h.uploadUrl, contentType, body);
  assert.equal(res.status, 200);
  assertSecurityHeaders(res);
  const json = await res.json();
  assert.equal(json.ok, true);
  assert.equal(json.value.count, 1);
  assert.equal(json.value.uploads, 1);
  assert.equal(json.value.expiresAt, h.armed.expiresAt);

  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].sessionId, 'sess-1');
  assert.equal(h.calls[0].files.length, 1);
  assert.equal(h.calls[0].files[0].mediaType, 'image/png');
  assert.equal(h.calls[0].files[0].filename, 'a.png');
  assert.deepEqual(h.calls[0].files[0].data, PNG);

  // recordUpload + 持久化
  assert.equal(h.tokens.get(h.token).uploads, 1);
  assert.equal(h.tokens.recent(1)[0].ok, true);
  assert.equal(h.tokens.recent(1)[0].filename, 'a.png');
  const persisted = JSON.parse(await readFile(path.join(h.dir, 'state.json'), 'utf8'));
  assert.equal(persisted.version, 1);
  assert.equal(persisted.tokens[h.token].uploads, 1);
});

test('POST upload：一次多图 → 一次 deliver、count=2、uploads 累计', async (t) => {
  const h = await startHarness(t);
  const boundary = boundaryFor('multi');
  const { contentType, body } = multipartBody(
    [
      { name: 'photo', filename: 'one.png', contentType: 'image/png', data: PNG },
      { name: 'photo', filename: 'two.jpg', contentType: 'image/jpeg', data: JPEG },
    ],
    boundary,
  );
  const first = await postUpload(h.uploadUrl, contentType, body);
  const firstJson = await first.json();
  assert.equal(firstJson.value.count, 2);
  assert.equal(firstJson.value.uploads, 1);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].files.length, 2);
  assert.equal(h.calls[0].files[1].mediaType, 'image/jpeg');

  // 第二次上传：uploads 继续累计
  const second = await postUpload(h.uploadUrl, contentType, body);
  const secondJson = await second.json();
  assert.equal(secondJson.value.uploads, 2);
  assert.equal(h.calls.length, 2);
});

test('POST upload：image/* raw body + x-filename', async (t) => {
  const h = await startHarness(t);
  const res = await fetch(h.uploadUrl, {
    method: 'POST',
    headers: {
      'content-type': 'image/png',
      'x-filename': encodeURIComponent('手机照片.png'),
    },
    body: PNG,
  });
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.value.count, 1);
  assert.equal(h.calls[0].files[0].mediaType, 'image/png');
  assert.equal(h.calls[0].files[0].filename, '手机照片.png');
});

test('POST upload：application/octet-stream 但内容是 PNG → 通过 sniff 接受', async (t) => {
  const h = await startHarness(t);
  const res = await postUpload(h.uploadUrl, 'application/octet-stream', PNG);
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.value.count, 1);
  assert.equal(h.calls[0].files[0].mediaType, 'image/png');
});

test('POST upload：声明 image/jpeg 但字节是 PNG → 以嗅探结果为准', async (t) => {
  const h = await startHarness(t);
  const res = await postUpload(h.uploadUrl, 'image/jpeg', PNG);
  assert.equal(res.status, 200);
  await res.json();
  assert.equal(h.calls[0].files[0].mediaType, 'image/png');
});

// --------------------------------------------------------------------- upload 错误路径

test('POST upload：没有图片 → 400 no-image，不调用 injector', async (t) => {
  const h = await startHarness(t);
  const boundary = boundaryFor('noimage');
  const { contentType, body } = multipartBody(
    [
      { name: 'note', data: 'hello' },
      { name: 'photo', filename: 'notes.txt', contentType: 'text/plain', data: 'not an image' },
    ],
    boundary,
  );
  const res = await postUpload(h.uploadUrl, contentType, body);
  assert.equal(res.status, 400);
  const json = await res.json();
  assert.equal(json.ok, false);
  assert.equal(json.error.code, 'no-image');
  assert.equal(h.calls.length, 0);
  assertSecurityHeaders(res);

  const rawText = await postUpload(h.uploadUrl, 'application/octet-stream', Buffer.from('plain text'));
  assert.equal(rawText.status, 400);
  const rawJson = await rawText.json();
  assert.equal(rawJson.error.code, 'no-image');
  assert.equal(h.calls.length, 0);
});

test('POST upload：不支持的 content-type → 400 bad-request', async (t) => {
  const h = await startHarness(t);
  const res = await postUpload(h.uploadUrl, 'application/json', Buffer.from('{"a":1}'));
  assert.equal(res.status, 400);
  const json = await res.json();
  assert.equal(json.error.code, 'bad-request');
  assert.equal(h.calls.length, 0);
});

test('POST upload：畸形 multipart → 400 bad-request', async (t) => {
  const h = await startHarness(t);
  const res = await postUpload(
    h.uploadUrl,
    `multipart/form-data; boundary=${boundaryFor('broken')}`,
    Buffer.from('not a multipart body'),
  );
  assert.equal(res.status, 400);
  const json = await res.json();
  assert.equal(json.error.code, 'bad-request');
  assert.equal(h.calls.length, 0);
});

test('POST upload：请求体超限（流式读取中中断）→ 413 too-large', async (t) => {
  const h = await startHarness(t, { maxUploadBytes: 2048 });
  const oversized = Buffer.concat([PNG, Buffer.alloc(8192, 7)]);
  const res = await postUpload(h.uploadUrl, 'application/octet-stream', oversized);
  assert.equal(res.status, 413);
  const json = await res.json();
  assert.equal(json.error.code, 'too-large');
  assert.equal(h.calls.length, 0);
  assert.equal(h.tokens.get(h.token).uploads, 0);

  // multipart 超限同样 413
  const boundary = boundaryFor('big');
  const { contentType, body } = multipartBody(
    [{ name: 'photo', filename: 'big.png', contentType: 'image/png', data: Buffer.alloc(8192, 3) }],
    boundary,
  );
  const multiRes = await postUpload(h.uploadUrl, contentType, body);
  assert.equal(multiRes.status, 413);
  const multiJson = await multiRes.json();
  assert.equal(multiJson.error.code, 'too-large');
  assert.equal(h.calls.length, 0);
});

test('POST upload：单图超过 20 MiB → 413 too-large', async (t) => {
  const h = await startHarness(t, { maxUploadBytes: 32 * 1024 * 1024 });
  const huge = Buffer.concat([PNG, Buffer.alloc(20 * 1024 * 1024 + 1024, 5)]);
  const res = await postUpload(h.uploadUrl, 'image/png', huge);
  assert.equal(res.status, 413);
  const json = await res.json();
  assert.equal(json.error.code, 'too-large');
  assert.equal(h.calls.length, 0);
});

test('POST upload：无效 token → 410 invalid-token，不调用 injector', async (t) => {
  const h = await startHarness(t);
  const boundary = boundaryFor('invalid');
  const { contentType, body } = multipartBody(
    [{ name: 'photo', filename: 'a.png', contentType: 'image/png', data: PNG }],
    boundary,
  );
  for (const badUrl of [
    `${h.base}/c/unknown-${'c'.repeat(16)}/upload`,
    `${h.base}/c/short/upload`,
    `${h.base}/c/${'x'.repeat(65)}/upload`,
  ]) {
    const res = await postUpload(badUrl, contentType, body);
    assert.equal(res.status, 410, badUrl);
    const json = await res.json();
    assert.equal(json.ok, false);
    assert.equal(json.error.code, 'invalid-token');
    assertSecurityHeaders(res);
  }
  assert.equal(h.calls.length, 0);
});

test('POST upload：每 token 每小时限流 → 超限 429 rate-limited', async (t) => {
  const h = await startHarness(t, { uploadsPerHour: 2 });
  const boundary = boundaryFor('rate');
  const { contentType, body } = multipartBody(
    [{ name: 'photo', filename: 'a.png', contentType: 'image/png', data: PNG }],
    boundary,
  );
  for (let i = 0; i < 2; i += 1) {
    const res = await postUpload(h.uploadUrl, contentType, body);
    assert.equal(res.status, 200, `upload ${i + 1}`);
    await res.json();
  }
  const limited = await postUpload(h.uploadUrl, contentType, body);
  assert.equal(limited.status, 429);
  const json = await limited.json();
  assert.equal(json.ok, false);
  assert.equal(json.error.code, 'rate-limited');
  assert.equal(h.calls.length, 2);
  assertSecurityHeaders(limited);
});

test('POST upload：限流按 token 隔离（换 token 不受影响）', async (t) => {
  const h = await startHarness(t, { uploadsPerHour: 1 });
  const boundary = boundaryFor('rate2');
  const { contentType, body } = multipartBody(
    [{ name: 'photo', filename: 'a.png', contentType: 'image/png', data: PNG }],
    boundary,
  );
  const first = await postUpload(h.uploadUrl, contentType, body);
  assert.equal(first.status, 200);
  await first.json();
  const limited = await postUpload(h.uploadUrl, contentType, body);
  assert.equal(limited.status, 429);
  await limited.json();

  const otherEntry = h.tokens.armNew({ sessionId: 'sess-2', title: '另一个对话' });
  const otherRes = await postUpload(
    `${h.base}/c/${otherEntry.token}/upload`,
    contentType,
    body,
  );
  assert.equal(otherRes.status, 200);
  await otherRes.json();
  assert.equal(h.calls.length, 2);
});

test('POST upload：injector 返回页面级 code → 原样透传，记录失败上传', async (t) => {
  const h = await startHarness(t, {
    deliverImpl: async () => ({
      ok: false,
      code: 'model-no-vision',
      message: 'the model does not support images',
    }),
  });
  const boundary = boundaryFor('injectfail');
  const { contentType, body } = multipartBody(
    [{ name: 'photo', filename: 'a.png', contentType: 'image/png', data: PNG }],
    boundary,
  );
  const res = await postUpload(h.uploadUrl, contentType, body);
  assert.equal(res.status, 502);
  const json = await res.json();
  assert.equal(json.ok, false);
  assert.equal(json.error.code, 'model-no-vision');
  assert.match(json.error.message, /does not support images/);
  assert.equal(h.calls.length, 1);
  // 失败上传也计入 entry.uploads 与 recent（ok:false）
  assert.equal(h.tokens.get(h.token).uploads, 1);
  assert.equal(h.tokens.recent(1)[0].ok, false);
  assertSecurityHeaders(res);
});

test('POST upload：injector 抛错 → 502 inject-failed（意外异常兜底）', async (t) => {
  const h = await startHarness(t, {
    deliverImpl: async () => {
      throw Object.assign(new Error('session vanished'), { code: 'session/not-found' });
    },
  });
  const boundary = boundaryFor('injectthrow');
  const { contentType, body } = multipartBody(
    [{ name: 'photo', filename: 'a.png', contentType: 'image/png', data: PNG }],
    boundary,
  );
  const res = await postUpload(h.uploadUrl, contentType, body);
  assert.equal(res.status, 502);
  const json = await res.json();
  assert.equal(json.error.code, 'inject-failed');
  assert.match(json.error.message, /session vanished/);
});

test('POST upload：injector 返回未知 code → 包装成 inject-failed:<code>（不重复前缀）', async (t) => {
  const h = await startHarness(t, {
    deliverImpl: async () => ({ ok: false, code: 'gateway/bad-request', message: 'bad gateway' }),
  });
  const boundary = boundaryFor('injectunknown');
  const { contentType, body } = multipartBody(
    [{ name: 'photo', filename: 'a.png', contentType: 'image/png', data: PNG }],
    boundary,
  );
  const res = await postUpload(h.uploadUrl, contentType, body);
  assert.equal(res.status, 502);
  const json = await res.json();
  assert.equal(json.error.code, 'inject-failed:gateway/bad-request');
  assert.match(json.error.message, /bad gateway/);

  const h2 = await startHarness(t, {
    deliverImpl: async () => ({ ok: false, code: 'inject-failed:weird', message: 'weird' }),
  });
  const boundary2 = boundaryFor('injectprefixed');
  const body2 = multipartBody(
    [{ name: 'photo', filename: 'b.png', contentType: 'image/png', data: PNG }],
    boundary2,
  );
  const res2 = await postUpload(h2.uploadUrl, body2.contentType, body2.body);
  assert.equal(res2.status, 502);
  const json2 = await res2.json();
  assert.equal(json2.error.code, 'inject-failed:weird');
});

test('POST upload：injector 全部页面级 code 原样透传', async (t) => {
  const pageCodes = [
    'no-image',
    'image-invalid',
    'image-too-large',
    'model-no-vision',
    'session-not-found',
    'inject-timeout',
    'inject-failed',
  ];
  for (const code of pageCodes) {
    const h = await startHarness(t, {
      deliverImpl: async () => ({ ok: false, code, message: `m-${code}` }),
    });
    const boundary = boundaryFor(`matrix${code.replace(/[^a-z]/g, '')}`);
    const { contentType, body } = multipartBody(
      [{ name: 'photo', filename: 'a.png', contentType: 'image/png', data: PNG }],
      boundary,
    );
    const res = await postUpload(h.uploadUrl, contentType, body);
    assert.equal(res.status, 502, code);
    const json = await res.json();
    assert.equal(json.error.code, code, code);
    assert.equal(json.error.message, `m-${code}`, code);
    assert.equal(h.calls.length, 1, code);
  }
});

// --------------------------------------------------------------------- server 对象

test('server 对象：buildUrl 使用 LAN IP 与真实端口；info 字段齐全', async (t) => {
  const h = await startHarness(t);
  assert.equal(h.server.host, '127.0.0.1');
  assert.equal(h.server.lanIp, '10.10.10.10');
  assert.equal(h.server.warning, null);
  assert.ok(h.server.port > 0);
  assert.equal(typeof h.server.startedAt, 'number');
  assert.equal(
    h.server.buildUrl(h.token),
    `http://10.10.10.10:${h.server.port}/c/${h.token}`,
  );

  const info = h.server.info();
  assert.deepEqual(Object.keys(info).sort(), [
    'lanIp',
    'localOnly',
    'port',
    'running',
    'startedAt',
    'version',
    'warning',
  ]);
  assert.equal(info.running, true);
  assert.equal(info.port, h.server.port);
  assert.equal(info.lanIp, '10.10.10.10');
  assert.equal(info.localOnly, false);
  assert.equal(info.version, '9.9.9');
  assert.equal(info.warning, null);
});

test('server 对象：无 LAN 地址 → localOnly、buildUrl 回退 127.0.0.1', async (t) => {
  const h = await startHarness(t, { lanCandidatesFn: NO_LAN_INTERFACES });
  assert.equal(h.server.lanIp, null);
  assert.equal(h.server.info().localOnly, true);
  assert.equal(h.server.info().lanIp, null);
  assert.equal(
    h.server.buildUrl('AbCdEfGhIjKlMnOpQrStUv'),
    `http://127.0.0.1:${h.server.port}/c/AbCdEfGhIjKlMnOpQrStUv`,
  );
});

test('端口占用：回退随机端口，设置 warning 且不抛错', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-cam-server-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const blocker = net.createServer();
  await new Promise((resolve, reject) => {
    blocker.once('error', reject);
    blocker.listen(0, '127.0.0.1', resolve);
  });
  const busyPort = blocker.address().port;
  const tokens = new TokenStore({ file: path.join(dir, 'state.json'), ttlMs: 60_000 });
  await tokens.load();
  const logs = { warn: [], info: [], error: [] };
  let server = null;
  try {
    server = await startCameraServer({
      config: {
        port: busyPort,
        bindHost: '127.0.0.1',
        lanIpOverride: '',
        maxUploadBytes: 1024 * 1024,
        maxFilesPerUpload: 6,
        uploadsPerHour: 10,
      },
      tokens,
      injector: { async deliver() { return { ok: true }; } },
      log: {
        info: (...args) => logs.info.push(args),
        warn: (...args) => logs.warn.push(args),
        error: (...args) => logs.error.push(args),
        debug() {},
      },
      version: '9.9.9',
      lanCandidatesFn: LAN_INTERFACES,
    });
    assert.notEqual(server.port, busyPort);
    assert.ok(server.port > 0);
    assert.match(server.warning, /already in use/);
    assert.match(server.info().warning, /already in use/);
    assert.match(logs.warn.map((args) => args.join(' ')).join(' '), /already in use/);
    const res = await fetch(`http://127.0.0.1:${server.port}/favicon.ico`);
    assert.equal(res.status, 204);
    await res.arrayBuffer();
  } finally {
    await server?.stop();
    await new Promise((resolve) => blocker.close(resolve));
  }
});

test('监听失败（非 EADDRINUSE）→ 抛错', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-cam-server-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const tokens = new TokenStore({ file: path.join(dir, 'state.json'), ttlMs: 60_000 });
  await tokens.load();
  await assert.rejects(
    startCameraServer({
      config: {
        port: 0,
        bindHost: '192.0.2.1', // TEST-NET-1，本机不可能绑定
        lanIpOverride: '',
        maxUploadBytes: 1024 * 1024,
        maxFilesPerUpload: 6,
        uploadsPerHour: 10,
      },
      tokens,
      injector: { async deliver() { return { ok: true }; } },
      log: silentLog(),
      version: '9.9.9',
      lanCandidatesFn: NO_LAN_INTERFACES,
    }),
    (error) => {
      assert.ok(error instanceof Error);
      assert.ok(
        ['EADDRNOTAVAIL', 'EINVAL', 'ENETUNREACH', 'EADDRINUSE'].includes(error.code),
        `unexpected listen error code: ${error.code}`,
      );
      return true;
    },
  );
});

test('参数校验：缺少 tokens / injector → TypeError', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-cam-server-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const tokens = new TokenStore({ file: path.join(dir, 'state.json'), ttlMs: 60_000 });
  await tokens.load();
  await assert.rejects(startCameraServer({ tokens: null, injector: {} }), TypeError);
  await assert.rejects(
    startCameraServer({ tokens, injector: null }),
    TypeError,
  );
});

// --------------------------------------------------------------------- 生命周期 / clientError

test('stop(): 幂等，停止后连接被拒绝、info.running=false', async (t) => {
  const h = await startHarness(t);
  await h.server.stop();
  await h.server.stop(); // 再调用不抛错
  assert.equal(h.server.info().running, false);
  await assert.rejects(fetch(`${h.base}/c/${h.token}`));
});

test('clientError：畸形 HTTP 请求得到 400 而不是崩溃', async (t) => {
  const h = await startHarness(t);
  const responseText = await new Promise((resolve, reject) => {
    const socket = net.connect(h.server.port, '127.0.0.1', () => {
      socket.write('GET / HTTP/1.1\r\nHost: x\r\nContent-Length: abc\r\n\r\n');
    });
    let data = '';
    socket.setEncoding('latin1');
    socket.setTimeout(3000);
    socket.on('data', (chunk) => {
      data += chunk;
    });
    socket.on('timeout', () => {
      socket.destroy();
      reject(new Error(`clientError timeout, got: ${JSON.stringify(data)}`));
    });
    socket.on('error', () => {
      // 服务器可能直接 reset；只要没崩溃、后续请求仍可用就算通过
      resolve(data);
    });
    socket.on('close', () => resolve(data));
  });
  assert.match(responseText, /HTTP\/1\.1 400/);
  // 服务器仍存活
  const res = await fetch(`${h.base}/favicon.ico`);
  assert.equal(res.status, 204);
  await res.arrayBuffer();
});
