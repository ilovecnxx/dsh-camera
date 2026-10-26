// unit-inject：mock ctx（sessionController / attachments）验证 lib/inject.js 的契约：
// - validateSession 的会话 id 校验/不存在/异常映射
// - deliver 的图片批量校验（空/类型/大小/数量）
// - 主路径：一次上传 = 一条 user 消息，content 为 base64 image，requestId 为 uuid，mode=queue
// - 兜底路径：attachments.saveImage + agent.followup(frozen message)
// - 错误映射：RemoteError code/details.reason → 页面稳定 code
import test from 'node:test';
import assert from 'node:assert/strict';
import { createInjector, mapAdmissionError } from '../lib/inject.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const IMAGE_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

function makeLog() {
  const entries = [];
  return {
    entries,
    info: (...args) => entries.push(['info', ...args]),
    warn: (...args) => entries.push(['warn', ...args]),
    error: (...args) => entries.push(['error', ...args]),
  };
}

/**
 * 构造带调用记录的 mock controller。
 * @param {{prompt?: Function|false, inspect?: Function|false, resolveAgent?: Function|false, followups?: object[]}} options
 */
function makeController({ prompt, inspect, resolveAgent, followups = [] } = {}) {
  const calls = { prompt: [], inspect: [], resolveAgent: [] };
  const controller = {};
  if (prompt !== false) {
    controller.prompt = prompt ?? (async (request, signal) => {
      calls.prompt.push({ request, signal });
    });
  }
  if (inspect !== false) {
    controller.inspect = inspect ?? (async (sessionId) => {
      calls.inspect.push(sessionId);
      return { sessionId, title: 'mock title' };
    });
  }
  if (resolveAgent !== false) {
    controller.resolveAgent = resolveAgent ?? (async (sessionId) => {
      calls.resolveAgent.push(sessionId);
      return { agent: { followup: (message) => followups.push(message) } };
    });
  }
  return { controller, calls, followups };
}

function makeCtx({ controller, imageLimits, saveImage, noAttachments = false } = {}) {
  const ctx = { sessionController: controller };
  if (!noAttachments) {
    ctx.attachments = {};
    if (imageLimits !== undefined) ctx.attachments.imageLimits = imageLimits;
    if (saveImage !== undefined) ctx.attachments.saveImage = saveImage;
  }
  return ctx;
}

function makeInjector({ controller, ctx, imageLimits, saveImage, config = {}, log = makeLog() } = {}) {
  const { controller: ctrl, calls, followups } = controller ?? makeController();
  const context = ctx ?? makeCtx({ controller: ctrl, imageLimits, saveImage });
  const injector = createInjector({ ctx: context, config, log });
  return { injector, calls, followups, log };
}

const pngFiles = (count = 1) =>
  Array.from({ length: count }, (_, index) => ({
    data: IMAGE_BYTES,
    mediaType: 'image/png',
    filename: `photo-${index + 1}.png`,
  }));

// ---------------------------------------------------------------------------
// validateSession
// ---------------------------------------------------------------------------

test('validateSession: 合法 session id → ok:true 且把 trim 后的 id 传给 inspect', async () => {
  const { injector, calls } = makeInjector();
  const result = await injector.validateSession('  session-abc-123  ');
  assert.deepEqual(result, { ok: true, sessionId: 'session-abc-123' });
  assert.deepEqual(calls.inspect, ['session-abc-123']);
});

test('validateSession: 非法/空/超长 session id → bad-request，且不触碰 controller', async () => {
  const { injector, calls } = makeInjector();
  for (const bad of ['', '   ', 'has space', 'x'.repeat(201), 'bad/slash', null, undefined, 42]) {
    const result = await injector.validateSession(bad);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'bad-request', `输入 ${String(bad).slice(0, 20)} 应被拒绝`);
  }
  assert.equal(calls.inspect.length, 0);
});

test('validateSession: controller 没有 inspect 方法时视为存在（不强校验）', async () => {
  const { injector, calls } = makeInjector({ controller: makeController({ inspect: false }) });
  const result = await injector.validateSession('session-no-inspect');
  assert.deepEqual(result, { ok: true, sessionId: 'session-no-inspect' });
  assert.equal(calls.inspect.length, 0);
});

test('validateSession: inspect 返回 null/undefined → session/not-found', async () => {
  for (const value of [null, undefined]) {
    const { injector } = makeInjector({ controller: makeController({ inspect: async () => value }) });
    const result = await injector.validateSession('session-missing');
    assert.equal(result.ok, false);
    assert.equal(result.code, 'session/not-found');
    assert.match(result.message, /not found|was not found/i);
  }
});

test('validateSession: inspect 抛 RemoteError session/not-found → 原 code 透传', async () => {
  const error = Object.assign(new Error('gone'), { code: 'session/not-found' });
  const { injector } = makeInjector({ controller: makeController({ inspect: async () => { throw error; } }) });
  const result = await injector.validateSession('session-gone');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'session/not-found');
});

test('validateSession: inspect 抛未知异常 → code=internal，消息保留', async () => {
  const { injector } = makeInjector({
    controller: makeController({ inspect: async () => { throw new Error('disk exploded'); } }),
  });
  const result = await injector.validateSession('session-boom');
  assert.deepEqual(result, { ok: false, code: 'internal', message: 'disk exploded' });
});

// ---------------------------------------------------------------------------
// deliver：批量输入校验
// ---------------------------------------------------------------------------

test('deliver: 没有图片 → no-image，不调用 prompt', async () => {
  for (const files of [[], undefined, null]) {
    const { injector, calls } = makeInjector();
    const result = await injector.deliver({ sessionId: 'session-1', files });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'no-image');
    assert.equal(calls.prompt.length, 0);
  }
});

test('deliver: 图片数量超过 ctx.attachments.imageLimits.maxImagesPerMessage → image-too-large', async () => {
  const { injector, calls } = makeInjector({ imageLimits: { maxImagesPerMessage: 2, maxImageBytes: 1024 } });
  const result = await injector.deliver({ sessionId: 'session-1', files: pngFiles(3) });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'image-too-large');
  assert.equal(calls.prompt.length, 0);
});

test('deliver: 不支持/缺失的 mediaType → image-invalid', async () => {
  const { injector } = makeInjector();
  for (const mediaType of ['image/heic', 'text/plain', '', undefined, 'application/octet-stream']) {
    const result = await injector.deliver({
      sessionId: 'session-1',
      files: [{ data: IMAGE_BYTES, mediaType }],
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'image-invalid', `mediaType=${String(mediaType)} 应被拒绝`);
  }
});

test('deliver: 空数据/非 Buffer 数据 → image-invalid', async () => {
  const { injector } = makeInjector();
  for (const data of [Buffer.alloc(0), 'not-a-buffer', new Uint8Array([1, 2]), undefined]) {
    const result = await injector.deliver({
      sessionId: 'session-1',
      files: [{ data, mediaType: 'image/png' }],
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'image-invalid');
  }
});

test('deliver: 单图字节超限 → image-too-large', async () => {
  const { injector, calls } = makeInjector({ imageLimits: { maxImagesPerMessage: 20, maxImageBytes: 10 } });
  const result = await injector.deliver({
    sessionId: 'session-1',
    files: [{ data: Buffer.alloc(11), mediaType: 'image/png' }],
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'image-too-large');
  assert.equal(calls.prompt.length, 0);
});

test('deliver: 会话无效时优先返回会话错误（先 validateSession 后校验图片）', async () => {
  const { injector } = makeInjector({ controller: makeController({ inspect: async () => null }) });
  const result = await injector.deliver({ sessionId: 'session-missing', files: [] });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'session/not-found');
});

// ---------------------------------------------------------------------------
// deliver：主路径（sessionController.prompt）
// ---------------------------------------------------------------------------

test('deliver 主路径：一次上传 = 一条 user 消息，多图同一请求，content 为 base64 image', async () => {
  const promptCalls = [];
  const { injector } = makeInjector({
    controller: makeController({
      prompt: async (request, signal) => promptCalls.push({ request, signal }),
    }),
  });
  const files = pngFiles(2);
  const result = await injector.deliver({ sessionId: '  session-abc  ', files });

  assert.equal(result.ok, true);
  assert.match(result.requestId, UUID_RE);
  assert.equal(result.count, 2);

  assert.equal(promptCalls.length, 1, '一次上传只能调用一次 prompt');
  const { request, signal } = promptCalls[0];
  assert.equal(request.sessionId, 'session-abc');
  assert.equal(request.mode, 'queue');
  assert.equal(request.requestId, result.requestId, 'requestId 必须与返回值一致');
  assert.match(request.requestId, UUID_RE);
  assert.ok(signal instanceof AbortSignal, 'prompt 必须带 AbortSignal');
  assert.equal(request.content.length, 2);
  for (let index = 0; index < files.length; index++) {
    const part = request.content[index];
    assert.deepEqual(Object.keys(part).sort(), ['data', 'mediaType', 'name', 'type']);
    assert.equal(part.type, 'image');
    assert.equal(part.mediaType, 'image/png');
    assert.equal(part.name, `photo-${index + 1}.png`);
    assert.equal(typeof part.data, 'string');
    assert.deepEqual(Buffer.from(part.data, 'base64'), IMAGE_BYTES, 'base64 必须可还原为原始字节');
  }
});

test('deliver 主路径：filename 清洗（去路径/控制字符/截断 80/缺省 photo-N.jpg）', async () => {
  const promptCalls = [];
  const { injector } = makeInjector({
    controller: makeController({ prompt: async (request) => promptCalls.push(request) }),
  });
  await injector.deliver({
    sessionId: 'session-1',
    files: [
      { data: IMAGE_BYTES, mediaType: 'image/png', filename: '../../etc/passwd' },
      { data: IMAGE_BYTES, mediaType: 'image/jpeg', filename: 'C:\\Users\\x\\cat.jpg' },
      { data: IMAGE_BYTES, mediaType: 'image/webp', filename: 'bad\u0000name\u001f.webp' },
      { data: IMAGE_BYTES, mediaType: 'image/gif' },
      { data: IMAGE_BYTES, mediaType: 'image/png', filename: 'y'.repeat(200) + '.png' },
    ],
  });
  const names = promptCalls[0].content.map((part) => part.name);
  assert.deepEqual(names, [
    'passwd',
    'cat.jpg',
    'badname.webp',
    'photo-4.jpg',
    `${'y'.repeat(80)}`,
  ]);
});

test('deliver 主路径：prompt 抛各种 RemoteError 时映射为页面稳定 code', async () => {
  const cases = [
    [{ code: 'session/not-found', message: 'gone' }, 'session-not-found'],
    [
      { code: 'session/attachment-invalid', message: 'bad image', details: { reason: 'MODEL_DOES_NOT_SUPPORT_IMAGES' } },
      'model-no-vision',
    ],
    [
      { code: 'session/attachment-invalid', message: 'too big', details: { reason: 'IMAGE_TOO_LARGE' } },
      'image-too-large',
    ],
    [
      { code: 'session/attachment-invalid', message: 'too many px', details: { reason: 'TOO_MANY_PIXELS' } },
      'image-too-large',
    ],
    [
      { code: 'session/attachment-invalid', message: 'mismatch', details: { reason: 'IMAGE_TYPE_MISMATCH' } },
      'image-invalid',
    ],
    [{ code: 'session/attachment-invalid', message: 'unknown', details: {} }, 'image-invalid'],
    [{ code: 'gateway/bad-request', message: 'nope' }, 'inject-failed'],
    [new Error('plain failure'), 'inject-failed'],
  ];
  for (const [thrown, expected] of cases) {
    const { injector, log } = makeInjector({
      controller: makeController({ prompt: async () => { throw thrown; } }),
    });
    const result = await injector.deliver({ sessionId: 'session-1', files: pngFiles(1) });
    assert.equal(result.ok, false);
    assert.equal(result.code, expected, `错误 ${thrown.code ?? thrown.message} 应映射为 ${expected}`);
    assert.equal(typeof result.message, 'string');
    assert.ok(log.entries.some(([level]) => level === 'warn'), '失败必须记录 warn 日志');
  }
});

test('deliver 主路径：abort/timeout 错误 → inject-timeout', async () => {
  for (const thrown of [
    Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }),
    Object.assign(new Error('request aborted by peer'), { name: 'Error' }),
    Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }),
  ]) {
    const { injector } = makeInjector({ controller: makeController({ prompt: async () => { throw thrown; } }) });
    const result = await injector.deliver({ sessionId: 'session-1', files: pngFiles(1) });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'inject-timeout');
  }
});

// ---------------------------------------------------------------------------
// deliver：兜底路径（attachments.saveImage + agent.followup）
// ---------------------------------------------------------------------------

test('deliver 兜底路径：无 prompt 时 saveImage 持久化并 followup 一条冻结的 user 消息', async () => {
  const saveImageCalls = [];
  const { injector, followups } = makeInjector({
    controller: makeController({ prompt: false }),
    saveImage: async (input) => {
      saveImageCalls.push(input);
      return {
        attachmentId: `att-${saveImageCalls.length}`,
        mediaType: input.mediaType,
        width: 1,
        height: 1,
      };
    },
  });
  const result = await injector.deliver({
    sessionId: 'session-1',
    files: [
      { data: IMAGE_BYTES, mediaType: 'image/png', filename: 'a.png' },
      { data: IMAGE_BYTES, mediaType: 'image/jpeg', filename: 'b.jpg' },
    ],
  });

  assert.equal(result.ok, true);
  assert.equal(result.count, 2);
  assert.match(result.requestId, UUID_RE);
  assert.equal(saveImageCalls.length, 2);
  assert.ok(saveImageCalls[0].data instanceof Uint8Array);
  assert.equal(saveImageCalls[0].data.constructor, Uint8Array);
  assert.deepEqual(Buffer.from(saveImageCalls[0].data), IMAGE_BYTES);
  assert.equal(saveImageCalls[0].mediaType, 'image/png');
  assert.equal(saveImageCalls[0].name, 'a.png');

  assert.equal(followups.length, 1);
  const message = followups[0];
  assert.match(message.id, UUID_RE);
  assert.equal(message.role, 'user');
  assert.equal(message.source.kind, 'user');
  assert.equal(message.source.rpcId, result.requestId);
  assert.equal(message.content.length, 2);
  assert.equal(message.content[0].type, 'image');
  assert.equal(message.content[0].attachment.attachmentId, 'att-1');
  assert.equal(message.content[1].attachment.attachmentId, 'att-2');
  // 深冻结：避免后续被 Agent/投影修改
  assert.ok(Object.isFrozen(message));
  assert.ok(Object.isFrozen(message.content));
  assert.ok(Object.isFrozen(message.content[0]));
  assert.ok(Object.isFrozen(message.source));
});

test('deliver 兜底路径：resolveAgent 返回错误 → 映射 code 并失败', async () => {
  for (const resolved of [
    { error: { code: 'session/not-found', message: 'not found' } },
    undefined,
  ]) {
    const { injector, followups } = makeInjector({
      controller: makeController({ prompt: false, resolveAgent: async () => resolved }),
      saveImage: async () => ({ attachmentId: 'a' }),
    });
    const result = await injector.deliver({ sessionId: 'session-1', files: pngFiles(1) });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'session-not-found');
    assert.equal(followups.length, 0);
  }
});

test('deliver 兜底路径：既无 prompt 也无 attachments.saveImage → inject-failed', async () => {
  const { injector } = makeInjector({
    controller: makeController({ prompt: false }),
    ctx: makeCtx({ controller: makeController({ prompt: false }), saveImage: undefined, noAttachments: true }),
  });
  // 上面 makeInjector 的 controller 参数与 ctx 不一致，这里显式构造保证无 attachments
  const context = { sessionController: makeController({ prompt: false }).controller };
  const injector2 = createInjector({ ctx: context, config: {}, log: makeLog() });
  for (const instance of [injector, injector2]) {
    const result = await instance.deliver({ sessionId: 'session-1', files: pngFiles(1) });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'inject-failed');
  }
});

// ---------------------------------------------------------------------------
// 元信息
// ---------------------------------------------------------------------------

test('supportsDirectPrompt: 有/无 sessionController.prompt', () => {
  assert.equal(makeInjector().injector.supportsDirectPrompt(), true);
  const direct = makeInjector({ controller: makeController({ prompt: false }) });
  assert.equal(direct.injector.supportsDirectPrompt(), false);
});

test('limits: 从 ctx.attachments.imageLimits 读取，缺省 20 张 / 20 MiB', () => {
  assert.deepEqual(makeInjector().injector.limits(), {
    maxImagesPerMessage: 20,
    maxImageBytes: 20 * 1024 * 1024,
    maxVideoBytes: 80 * 1024 * 1024,
    maxFilesPerUpload: 6,
  });
  const custom = makeInjector({ imageLimits: { maxImagesPerMessage: 3, maxImageBytes: 1234 } });
  assert.deepEqual(custom.injector.limits(), {
    maxImagesPerMessage: 3,
    maxImageBytes: 1234,
    maxVideoBytes: 80 * 1024 * 1024,
    maxFilesPerUpload: 6,
  });
  const invalid = makeInjector({ imageLimits: { maxImagesPerMessage: 'x', maxImageBytes: null } });
  assert.deepEqual(invalid.injector.limits(), {
    maxImagesPerMessage: 20,
    maxImageBytes: 20 * 1024 * 1024,
    maxVideoBytes: 80 * 1024 * 1024,
    maxFilesPerUpload: 6,
  });
});

test('mapAdmissionError: 独立导出的错误映射保持稳定 code', () => {
  assert.equal(mapAdmissionError({ code: 'session/not-found' }).code, 'session-not-found');
  assert.equal(
    mapAdmissionError({ code: 'session/attachment-invalid', details: { reason: 'MODEL_DOES_NOT_SUPPORT_IMAGES' } }).code,
    'model-no-vision',
  );
  assert.equal(mapAdmissionError(new Error('boom')).code, 'inject-failed');
  assert.equal(
    mapAdmissionError(Object.assign(new Error('aborted'), { name: 'AbortError' })).code,
    'inject-timeout',
  );
});

// ---------------------------------------------------------------------------
// 视频（文件附件）与图片混合
// ---------------------------------------------------------------------------

const MP4_BYTES = Buffer.concat([
  Buffer.from([0x00, 0x00, 0x00, 0x18]),
  Buffer.from('ftypisom', 'latin1'),
  Buffer.alloc(64, 9),
]);

function mediaCtx({ withFileUploads = true, uploadStream, saveFileStream } = {}) {
  const controller = makeController();
  const ctx = {
    sessionController: controller.controller,
    attachments: {
      imageLimits: { maxImagesPerMessage: 20, maxImageBytes: 20 * 1024 * 1024 },
      saveImage: async ({ name }) => ({ attachmentId: `image-${name}`, name, bytes: 1 }),
    },
  };
  if (withFileUploads) {
    ctx.fileUploads = {
      uploadStream: uploadStream ?? (async (request) => {
        const chunks = [];
        for await (const chunk of request.data) chunks.push(Buffer.from(chunk));
        return { receiptId: 'receipt-video-1', file: { attachmentId: 'file-1', name: request.name, bytes: chunks.length } };
      }),
    };
  }
  if (saveFileStream !== undefined) ctx.attachments.saveFileStream = saveFileStream;
  return { ctx, calls: controller.calls, followups: controller.followups };
}

const imageFile = (name = 'a.png') => ({ kind: 'image', data: IMAGE_BYTES, mediaType: 'image/png', filename: name });
const videoFile = (name = 'a.mp4', bytes = MP4_BYTES) => ({
  kind: 'video',
  data: bytes,
  mediaType: 'video/mp4',
  filename: name,
});

test('deliver：图片 + 视频 → 一条 prompt，视频以 file receiptId 引用', async () => {
  const staged = [];
  const { ctx, calls } = mediaCtx({
    uploadStream: async (request) => {
      const chunks = [];
      for await (const chunk of request.data) chunks.push(Buffer.from(chunk));
      staged.push({ name: request.name, sessionId: request.sessionId, bytes: Buffer.concat(chunks) });
      return { receiptId: 'receipt-video-1', file: { attachmentId: 'file-1', name: request.name, bytes: 1 } };
    },
  });
  const log = makeLog();
  const injector = createInjector({ ctx, config: { maxVideoBytes: 80 * 1024 * 1024, maxFilesPerUpload: 6 }, log });
  const result = await injector.deliver({
    sessionId: 'session-media-1',
    files: [imageFile('a.png'), videoFile('clip.mp4')],
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.count, 2);
  assert.equal(staged.length, 1);
  assert.equal(staged[0].sessionId, 'session-media-1');
  assert.deepEqual(staged[0].bytes, MP4_BYTES, '视频必须原样流式暂存，不转码');
  assert.equal(calls.prompt.length, 1);
  const { request } = calls.prompt[0];
  assert.equal(request.mode, 'queue');
  assert.equal(request.content.length, 2);
  assert.equal(request.content[0].type, 'image');
  assert.equal(request.content[0].data, IMAGE_BYTES.toString('base64'));
  assert.deepEqual(request.content[1], { type: 'file', receiptId: 'receipt-video-1' });
});

test('deliver：视频在前、图片在后 → content 顺序与选择顺序一致', async () => {
  const { ctx, calls } = mediaCtx();
  const injector = createInjector({ ctx, config: {}, log: makeLog() });
  const result = await injector.deliver({
    sessionId: 'session-media-2',
    files: [videoFile('first.mp4'), imageFile('second.jpg')],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(calls.prompt[0].request.content.map((part) => part.type), ['file', 'image']);
});

test('deliver：视频超过 maxVideoBytes → video-too-large，且不调用 prompt/uploadStream', async () => {
  let staged = 0;
  const { ctx, calls } = mediaCtx({ uploadStream: async () => { staged += 1; return { receiptId: 'x' }; } });
  const injector = createInjector({ ctx, config: { maxVideoBytes: 32 }, log: makeLog() });
  const result = await injector.deliver({ sessionId: 'session-media-3', files: [videoFile('big.mp4')] });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'video-too-large');
  assert.equal(staged, 0);
  assert.equal(calls.prompt.length, 0);
});

test('deliver：不支持的视频 mediaType → video-invalid', async () => {
  const { ctx } = mediaCtx();
  const injector = createInjector({ ctx, config: {}, log: makeLog() });
  const bad = { ...videoFile('x.avi'), mediaType: 'video/x-msvideo' };
  const result = await injector.deliver({ sessionId: 'session-media-4', files: [bad] });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'video-invalid');
});

test('deliver：无 fileUploads 但有 attachments.saveFileStream → 兜底消息含 file block', async () => {
  const savedFileChunks = [];
  const { ctx, followups } = mediaCtx({
    withFileUploads: false,
    saveFileStream: async ({ data, name }) => {
      for await (const chunk of data) savedFileChunks.push(Buffer.from(chunk));
      return { attachmentId: 'file-fallback', name, bytes: MP4_BYTES.length };
    },
  });
  const injector = createInjector({ ctx, config: {}, log: makeLog() });
  const result = await injector.deliver({
    sessionId: 'session-media-5',
    files: [imageFile('a.png'), videoFile('clip.mp4')],
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(followups.length, 1);
  const message = followups[0];
  assert.deepEqual(message.content.map((block) => block.type), ['image', 'file']);
  assert.equal(message.content[1].attachment.name, 'clip.mp4');
  assert.deepEqual(Buffer.concat(savedFileChunks), MP4_BYTES);
});
