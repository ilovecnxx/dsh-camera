// dsh-camera · multipart 解析 / 图片嗅探单元测试（DESIGN 3.4）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { readMultipart, sniffImageType } from '../lib/multipart.js';

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('fake png payload'),
]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const GIF = Buffer.from('GIF89a-body-data', 'latin1');
const WEBP = Buffer.concat([
  Buffer.from('RIFF', 'latin1'),
  Buffer.from([0x1a, 0, 0, 0]),
  Buffer.from('WEBPVP8 ', 'latin1'),
]);

const BOUNDARY = '----dshCameraTestBoundary1234567890';

class MockReq extends EventEmitter {
  constructor(headers = {}) {
    super();
    this.headers = headers;
    this.resumed = false;
    this.destroyed = false;
  }

  resume() {
    this.resumed = true;
    return this;
  }

  pause() {
    return this;
  }

  destroy(error) {
    this.destroyed = true;
    if (error) this.emit('error', error);
    return this;
  }
}

function buildMultipart(parts, boundary = BOUNDARY) {
  const chunks = [];
  for (const part of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n`, 'latin1'));
    let disposition = `Content-Disposition: form-data; name="${part.name}"`;
    if (part.filename !== undefined) disposition += `; filename="${part.filename}"`;
    chunks.push(Buffer.from(`${disposition}\r\n`, 'utf8'));
    if (part.contentType) chunks.push(Buffer.from(`Content-Type: ${part.contentType}\r\n`, 'utf8'));
    if (part.extraHeaders) {
      for (const [name, value] of Object.entries(part.extraHeaders)) {
        chunks.push(Buffer.from(`${name}: ${value}\r\n`, 'utf8'));
      }
    }
    chunks.push(Buffer.from('\r\n', 'latin1'));
    chunks.push(Buffer.isBuffer(part.data) ? part.data : Buffer.from(String(part.data), 'utf8'));
    chunks.push(Buffer.from('\r\n', 'latin1'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, 'latin1'));
  return Buffer.concat(chunks);
}

function multipartHeaders(boundary = BOUNDARY) {
  return { 'content-type': `multipart/form-data; boundary=${boundary}` };
}

function chunkedBody(body, size = 11) {
  const chunks = [];
  for (let i = 0; i < body.length; i += size) chunks.push(body.subarray(i, i + size));
  return chunks;
}

async function parse(headers, body, options) {
  const req = new MockReq(headers);
  const promise = readMultipart(req, options);
  for (const chunk of chunkedBody(body)) req.emit('data', chunk);
  req.emit('end');
  return { result: await promise, req };
}

async function rejectWith(headers, body, options) {
  const req = new MockReq(headers);
  const promise = readMultipart(req, options).then(
    (value) => {
      throw new Error(`expected rejection but resolved: ${JSON.stringify(value)}`);
    },
    (error) => error,
  );
  for (const chunk of chunkedBody(body)) req.emit('data', chunk);
  req.emit('end');
  return { error: await promise, req };
}

// ---------------------------------------------------------------- sniffImageType

test('sniffImageType: 识别 JPEG/PNG/WebP/GIF', () => {
  assert.equal(sniffImageType(PNG), 'image/png');
  assert.equal(sniffImageType(JPEG), 'image/jpeg');
  assert.equal(sniffImageType(GIF), 'image/gif');
  assert.equal(sniffImageType(Buffer.from('GIF87a-data', 'latin1')), 'image/gif');
  assert.equal(sniffImageType(WEBP), 'image/webp');
});

test('sniffImageType: 非图片/过短/非 Buffer 返回 null', () => {
  assert.equal(sniffImageType(Buffer.from('hello world')), null);
  assert.equal(sniffImageType(Buffer.alloc(0)), null);
  assert.equal(sniffImageType(Buffer.from([0x89, 0x50])), null);
  assert.equal(sniffImageType(Buffer.from('RIFFxxxxWAVE')), null);
  assert.equal(sniffImageType('not a buffer'), null);
  assert.equal(sniffImageType(null), null);
  assert.equal(sniffImageType(undefined), null);
});

// ---------------------------------------------------------------- multipart 正常路径

test('multipart: 单文件 + 文本字段（分块到达）', async () => {
  const body = buildMultipart([
    { name: 'caption', data: '你好，世界' },
    { name: 'photo', filename: 'photo.png', contentType: 'image/png', data: PNG },
  ]);
  const { result } = await parse(multipartHeaders(), body);
  assert.deepEqual(result.fields, { caption: '你好，世界' });
  assert.equal(result.files.length, 1);
  assert.equal(result.files[0].fieldName, 'photo');
  assert.equal(result.files[0].filename, 'photo.png');
  assert.equal(result.files[0].mediaType, 'image/png');
  assert.deepEqual(result.files[0].data, PNG);
});

test('multipart: 多文件 + 中文文件名', async () => {
  const body = buildMultipart([
    { name: 'photo', filename: '中文照片.png', contentType: 'image/png', data: PNG },
    { name: 'photo', filename: '第二个.jpg', contentType: 'image/jpeg', data: JPEG },
    { name: 'photo', filename: '动图.gif', contentType: 'image/gif', data: GIF },
  ]);
  const { result } = await parse(multipartHeaders(), body);
  assert.deepEqual(
    result.files.map((file) => [file.fieldName, file.filename, file.mediaType]),
    [
      ['photo', '中文照片.png', 'image/png'],
      ['photo', '第二个.jpg', 'image/jpeg'],
      ['photo', '动图.gif', 'image/gif'],
    ],
  );
  assert.deepEqual(result.files[1].data, JPEG);
});

test('multipart: 二进制安全（0x00/0xff/\r\n/相似边界片段）', async () => {
  const payload = Buffer.alloc(4096);
  for (let i = 0; i < payload.length; i += 1) payload[i] = (i * 37 + 11) & 0xff;
  // 放进一些看起来像分隔符但不等于真实 boundary 的片段
  Buffer.from('\r\n--not-the-boundary\r\n').copy(payload, 100);
  Buffer.from('\r\n\r\n--dshCameraTestBoundary123456789').copy(payload, 2000);
  const body = buildMultipart([
    { name: 'photo', filename: 'binary.png', contentType: 'image/png', data: payload },
  ]);
  const { result } = await parse(multipartHeaders(), body);
  assert.deepEqual(result.files[0].data, payload);
});

test('multipart: 带 preamble / epilogue 也能正确解析', async () => {
  const inner = buildMultipart([
    { name: 'photo', filename: 'a.png', contentType: 'image/png', data: PNG },
  ]);
  const body = Buffer.concat([Buffer.from('this is a preamble\r\n'), inner, Buffer.from('epilogue')]);
  const { result } = await parse(multipartHeaders(), body);
  assert.equal(result.files.length, 1);
  assert.deepEqual(result.files[0].data, PNG);
});

test('multipart: boundary 用双引号包裹', async () => {
  const boundary = '----quotedBoundary987';
  const body = buildMultipart(
    [{ name: 'photo', filename: 'q.png', contentType: 'image/png', data: PNG }],
    boundary,
  );
  const { result } = await parse(
    { 'content-type': `multipart/form-data; boundary="${boundary}"` },
    body,
  );
  assert.equal(result.files[0].filename, 'q.png');
});

test('multipart: 没有 filename 的 part 作为字段；空字段名被忽略', async () => {
  const body = buildMultipart([
    { name: 'note', data: 'hello' },
    { name: '', data: 'ignored' },
    { name: 'photo', filename: 'x.png', contentType: 'image/png', data: PNG },
  ]);
  const { result } = await parse(multipartHeaders(), body);
  assert.deepEqual(result.fields, { note: 'hello' });
  assert.equal(result.files.length, 1);
});

test('multipart: filename* (RFC 5987) 优先于 filename', async () => {
  const boundary = BOUNDARY;
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\n`, 'latin1'),
    Buffer.from(
      `Content-Disposition: form-data; name="photo"; filename*=UTF-8''%E4%B8%AD%E6%96%87.png\r\n`,
      'utf8',
    ),
    Buffer.from('Content-Type: image/png\r\n\r\n', 'utf8'),
    PNG,
    Buffer.from(`\r\n--${boundary}--\r\n`, 'latin1'),
  ]);
  const { result } = await parse(multipartHeaders(boundary), body);
  assert.equal(result.files[0].filename, '中文.png');
});

test('multipart: 文件名清洗（去路径/去控制字符/截断 80 字符）', async () => {
  const body = buildMultipart([
    { name: 'photo', filename: '../../etc/passwd.png', contentType: 'image/png', data: PNG },
    { name: 'photo', filename: 'C:\\\\Users\\\\x\\\\evil.png', contentType: 'image/png', data: PNG },
    { name: 'photo', filename: 'bad\u0000na\u001fme.png', contentType: 'image/png', data: PNG },
    { name: 'photo', filename: `${'x'.repeat(200)}.png`, contentType: 'image/png', data: PNG },
  ]);
  const { result } = await parse(multipartHeaders(), body);
  assert.deepEqual(
    result.files.map((file) => file.filename),
    ['passwd.png', 'evil.png', 'badname.png', `${'x'.repeat(80)}`],
  );
});

test('multipart: 文件缺少 Content-Type 时默认 application/octet-stream', async () => {
  const body = buildMultipart([{ name: 'photo', filename: 'raw.bin', data: PNG }]);
  const { result } = await parse(multipartHeaders(), body);
  assert.equal(result.files[0].mediaType, 'application/octet-stream');
});

test('multipart: maxFiles 允许恰好 6 个文件（默认上限）', async () => {
  const parts = Array.from({ length: 6 }, (_, index) => ({
    name: 'photo',
    filename: `p${index}.png`,
    contentType: 'image/png',
    data: PNG,
  }));
  const { result } = await parse(multipartHeaders(), buildMultipart(parts));
  assert.equal(result.files.length, 6);
});

// ---------------------------------------------------------------- multipart 错误路径

test('multipart: 超过 maxFiles → bad-request', async () => {
  const parts = Array.from({ length: 7 }, (_, index) => ({
    name: 'photo',
    filename: `p${index}.png`,
    contentType: 'image/png',
    data: PNG,
  }));
  const { error } = await rejectWith(multipartHeaders(), buildMultipart(parts), { maxFiles: 6 });
  assert.equal(error.code, 'bad-request');
  assert.match(error.message, /too many files/);
});

test('multipart: 缺少 content-type → bad-request 并 drain', async () => {
  const { error, req } = await rejectWith({}, buildMultipart([]));
  assert.equal(error.code, 'bad-request');
  assert.equal(req.resumed, true);
});

test('multipart: 缺少 boundary → bad-request', async () => {
  const { error, req } = await rejectWith(
    { 'content-type': 'multipart/form-data' },
    Buffer.from('anything'),
  );
  assert.equal(error.code, 'bad-request');
  assert.match(error.message, /boundary/i);
  assert.equal(req.resumed, true);
});

test('multipart: body 里找不到 boundary → bad-request', async () => {
  const { error } = await rejectWith(multipartHeaders(), Buffer.from('no delimiter here'));
  assert.equal(error.code, 'bad-request');
  assert.match(error.message, /boundary/i);
});

test('multipart: 结束 boundary 缺失 → bad-request', async () => {
  const body = Buffer.from(
    `--${BOUNDARY}\r\nContent-Disposition: form-data; name="a"\r\n\r\nvalue`,
    'utf8',
  );
  const { error } = await rejectWith(multipartHeaders(), body);
  assert.equal(error.code, 'bad-request');
  assert.match(error.message, /unterminated/i);
});

test('multipart: 斜杠后不是 CRLF → bad-request', async () => {
  const body = Buffer.from(
    `--${BOUNDARY}XX\r\nContent-Disposition: form-data; name="a"\r\n\r\nvalue\r\n--${BOUNDARY}--\r\n`,
    'utf8',
  );
  const { error } = await rejectWith(multipartHeaders(), body);
  assert.equal(error.code, 'bad-request');
  assert.match(error.message, /malformed/i);
});

test('multipart: 空 body → bad-request', async () => {
  const { error } = await rejectWith(multipartHeaders(), Buffer.alloc(0));
  assert.equal(error.code, 'bad-request');
  assert.match(error.message, /empty/i);
});

test('multipart: part 数量超限 → bad-request', async () => {
  const parts = Array.from({ length: 130 }, (_, index) => ({ name: `f${index}`, data: 'v' }));
  const { error } = await rejectWith(multipartHeaders(), buildMultipart(parts));
  assert.equal(error.code, 'bad-request');
  assert.match(error.message, /too many multipart parts/i);
});

test('multipart: 超过 maxBytes → too-large（整包读取路径）', async () => {
  const body = buildMultipart([
    { name: 'photo', filename: 'big.png', contentType: 'image/png', data: Buffer.alloc(4096, 7) },
  ]);
  const { error } = await rejectWith(multipartHeaders(), body, { maxBytes: 1024 });
  assert.equal(error.code, 'too-large');
});

test('超限：读取过程中立即中断并 drain，后续数据被忽略', async () => {
  const req = new MockReq({ 'content-type': 'application/octet-stream' });
  const promise = readMultipart(req, { maxBytes: 100 }).then(
    (value) => ({ ok: true, value }),
    (error) => ({ ok: false, error }),
  );
  req.emit('data', Buffer.alloc(60, 1));
  req.emit('data', Buffer.alloc(60, 1));
  const outcome = await promise;
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error.code, 'too-large');
  assert.equal(req.resumed, true);
  // 后续 chunk 不会再抛错，也不会被缓冲
  req.emit('data', Buffer.alloc(100000, 2));
  req.emit('end');
});

test('超限：content-length 声明超限时直接拒绝（不读 body）', async () => {
  const req = new MockReq({
    'content-type': 'application/octet-stream',
    'content-length': '999999',
  });
  const promise = readMultipart(req, { maxBytes: 1024 }).then(
    (value) => ({ ok: true, value }),
    (error) => ({ ok: false, error }),
  );
  const outcome = await promise;
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error.code, 'too-large');
  assert.equal(req.resumed, true);
});

test('请求流 error 事件 → 原样 reject', async () => {
  const req = new MockReq({ 'content-type': 'multipart/form-data; boundary=' + BOUNDARY });
  const promise = readMultipart(req, {}).then(
    (value) => ({ ok: true, value }),
    (error) => ({ ok: false, error }),
  );
  const boom = Object.assign(new Error('stream exploded'), { code: 'boom' });
  req.emit('data', Buffer.from(`--${BOUNDARY}\r\n`));
  req.emit('error', boom);
  const outcome = await promise;
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error, boom);
});

test('请求流 aborted → bad-request', async () => {
  const req = new MockReq({ 'content-type': 'multipart/form-data; boundary=' + BOUNDARY });
  const promise = readMultipart(req, {}).then(
    (value) => ({ ok: true, value }),
    (error) => ({ ok: false, error }),
  );
  req.emit('aborted');
  const outcome = await promise;
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error.code, 'bad-request');
});

// ---------------------------------------------------------------- raw image body

test('raw image: 默认 filename 为 photo.jpg，mediaType 取 content-type', async () => {
  const { result } = await parse({ 'content-type': 'image/png' }, PNG);
  assert.equal(result.files.length, 1);
  assert.equal(result.files[0].fieldName, 'photo');
  assert.equal(result.files[0].filename, 'photo.jpg');
  assert.equal(result.files[0].mediaType, 'image/png');
  assert.deepEqual(result.files[0].data, PNG);
  assert.deepEqual(result.fields, {});
});

test('raw image: x-filename 做 URL 解码与路径清洗', async () => {
  const decoded = await parse(
    { 'content-type': 'image/jpeg', 'x-filename': encodeURIComponent('我的照片.png') },
    JPEG,
  );
  assert.equal(decoded.result.files[0].filename, '我的照片.png');

  const traversal = await parse(
    { 'content-type': 'image/png', 'x-filename': encodeURIComponent('../../etc/evil.png') },
    PNG,
  );
  assert.equal(traversal.result.files[0].filename, 'evil.png');

  const invalidPercent = await parse(
    { 'content-type': 'image/png', 'x-filename': 'bad%E4%' },
    PNG,
  );
  assert.equal(invalidPercent.result.files[0].filename, 'bad%E4%');
});

test('raw octet-stream: mediaType 由文件头嗅探', async () => {
  const png = await parse({ 'content-type': 'application/octet-stream' }, PNG);
  assert.equal(png.result.files[0].mediaType, 'image/png');
  const text = await parse({ 'content-type': 'application/octet-stream' }, Buffer.from('plain text'));
  assert.equal(text.result.files[0].mediaType, 'application/octet-stream');
});

test('raw image: 声明类型与字节不一致时保留声明类型（server 会再嗅探）', async () => {
  const { result } = await parse({ 'content-type': 'image/jpeg' }, PNG);
  assert.equal(result.files[0].mediaType, 'image/jpeg');
});

test('raw image: 空 body → bad-request', async () => {
  const { error } = await rejectWith({ 'content-type': 'image/png' }, Buffer.alloc(0));
  assert.equal(error.code, 'bad-request');
  assert.match(error.message, /empty/i);
});

test('不支持的 content-type → bad-request 并 drain', async () => {
  const { error, req } = await rejectWith(
    { 'content-type': 'application/json' },
    Buffer.from('{"hello":true}'),
  );
  assert.equal(error.code, 'bad-request');
  assert.match(error.message, /unsupported content-type/i);
  assert.equal(req.resumed, true);
});

test('raw image: 超限 → too-large', async () => {
  const { error } = await rejectWith(
    { 'content-type': 'image/png' },
    Buffer.concat([PNG, Buffer.alloc(4096, 3)]),
    { maxBytes: 512 },
  );
  assert.equal(error.code, 'too-large');
});

test('readMultipart: 无请求流对象 → bad-request', async () => {
  await assert.rejects(() => readMultipart(null, {}), (error) => error.code === 'bad-request');
  await assert.rejects(() => readMultipart({}, {}), (error) => error.code === 'bad-request');
});
