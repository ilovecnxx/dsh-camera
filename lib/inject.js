/**
 * Prompt injection for the Host half of dsh-camera.
 *
 * The mobile page uploads image bytes; this module turns one upload batch into
 * exactly one user message carrying durable image attachments and delivers it
 * into the target conversation.
 *
 * Primary path: `ctx.sessionController.prompt()` — the same Host admission the
 * Web composer uses. It validates the model's image modality, normalizes every
 * image, persists it, records `source = { kind: 'user', rpcId }`, and queues a
 * follow-up turn that wakes the agent.
 *
 * Fallback path (when the controller method is unavailable in a future
 * composition): resolve the Agent, persist images through `ctx.attachments`
 * directly, and hand a frozen user message to `agent.followup()`.
 */
import { randomUUID } from 'node:crypto';

/** Media types accepted by the image attachment pipeline (mirrors the shipped limits). */
const ALLOWED_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

/** Video containers accepted as generic file attachments (stored verbatim, never transcoded). */
const ALLOWED_VIDEO_TYPES = new Set([
  'video/mp4',
  'video/quicktime',
  'video/webm',
  'video/x-m4v',
  'video/3gpp',
]);

/** Streaming chunk size for video/file staging. */
const STAGE_CHUNK_BYTES = 256 * 1024;

/** Upper bound for one prompt admission, including image normalization. */
const PROMPT_TIMEOUT_MS = 120_000;

/** Session ids are `<kind>-<uuid>` style opaque strings with these characters. */
const SESSION_ID_PATTERN = /^[A-Za-z0-9_$.:-]{1,200}$/;

/**
 * Normalize a display filename: no path components, no control characters.
 * @param {unknown} filename - client-supplied name.
 * @param {number} index - fallback position for an unnamed file.
 * @returns {string} safe display name.
 */
function displayName(filename, index) {
  const text = typeof filename === 'string' ? filename : '';
  const leaf = text.split(/[\\/]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  const cleaned = leaf.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 80);
  if (cleaned.length > 0) return cleaned;
  return `photo-${index + 1}.jpg`;
}

/**
 * Deep-freeze a fabricated message for the fallback delivery path.
 * @param {object} message - freshly built message value.
 * @returns {object} frozen message.
 */
function freezeMessage(message) {
  for (const block of message.content) Object.freeze(block);
  Object.freeze(message.content);
  Object.freeze(message.source);
  return Object.freeze(message);
}

/**
 * Map one thrown admission error into a stable page-facing code.
 * @param {unknown} error - value thrown by the session controller.
 * @returns {{ code: string, message: string }} stable code plus technical message.
 */
export function mapAdmissionError(error) {
  const code = typeof error?.code === 'string' ? error.code : '';
  const details = error?.details !== null && typeof error?.details === 'object' ? error.details : {};
  const reason = typeof details.reason === 'string' ? details.reason : '';
  const message = typeof error?.message === 'string' ? error.message : String(error);
  if (error?.name === 'AbortError' || /abort/i.test(message)) {
    return { code: 'inject-timeout', message };
  }
  if (code === 'session/not-found') {
    return { code: 'session-not-found', message };
  }
  if (code === 'session/attachment-invalid') {
    if (reason === 'MODEL_DOES_NOT_SUPPORT_IMAGES') return { code: 'model-no-vision', message };
    if (reason === 'FILE_NOT_STAGED' || reason === 'FILE_INVALID' || reason === 'file-upload') {
      return { code: 'file-invalid', message };
    }
    if (/TOO_LARGE|TOO_MANY_PIXELS|TOO_LARGE_DIMENSION|EXCEEDS/.test(reason)) {
      return { code: 'image-too-large', message };
    }
    return { code: 'image-invalid', message };
  }
  if (code === 'video-unavailable' || code === 'file-invalid') {
    return { code, message };
  }
  if (code === 'session/agent-busy' || code === 'gateway/bad-request') {
    return { code: 'inject-failed', message };
  }
  return { code: 'inject-failed', message };
}

/**
 * Create the injector facade consumed by the LAN server and RPC handlers.
 * @param {object} options - wiring.
 * @param {import('@deepseek-ai/cordis').Context} options.ctx - Host plugin context.
 * @param {object} options.config - resolved plugin configuration.
 * @param {{ info: Function, warn: Function, error: Function }} options.log - named logger.
 * @returns {{
 *   validateSession: (sessionId: string) => Promise<{ ok: boolean, sessionId?: string, code?: string, message?: string }>,
 *   deliver: (input: { sessionId: string, files: readonly { data: Buffer, mediaType: string, filename?: string }[] }) => Promise<{ ok: boolean, requestId?: string, count?: number, code?: string, message?: string }>,
 *   limits: () => { maxImagesPerMessage: number, maxImageBytes: number },
 *   supportsDirectPrompt: () => boolean,
 * }}
 */
export function createInjector({ ctx, config, log }) {
  const controller = () => ctx.sessionController;

  /**
   * Read the attachment image limits without importing the attachment package.
   * @returns {{ maxImagesPerMessage: number, maxImageBytes: number }} effective limits.
   */
  function limits() {
    // Service access on a Context that does not inject `attachments` throws in
    // Cordis, so read the limits defensively: the defaults mirror the shipped
    // attachment-local configuration.
    let imageLimits;
    try {
      imageLimits = ctx.attachments?.imageLimits;
    } catch {
      imageLimits = undefined;
    }
    return {
      maxImagesPerMessage:
        typeof imageLimits?.maxImagesPerMessage === 'number' ? imageLimits.maxImagesPerMessage : 20,
      maxImageBytes:
        typeof imageLimits?.maxImageBytes === 'number' ? imageLimits.maxImageBytes : 20 * 1024 * 1024,
      maxVideoBytes:
        typeof config?.maxVideoBytes === 'number' ? config.maxVideoBytes : 80 * 1024 * 1024,
      maxFilesPerUpload:
        typeof config?.maxFilesPerUpload === 'number' ? config.maxFilesPerUpload : 6,
    };
  }

  /**
   * Whether the composed controller exposes the direct prompt admission method.
   * @returns {boolean} true when the primary injection path is available.
   */
  function supportsDirectPrompt() {
    return typeof controller()?.prompt === 'function';
  }

  /**
   * Whether the composed Host exposes the staged file-upload service.
   * @returns {boolean} true when videos can be staged as receipts.
   */
  function hasFileUploads() {
    try {
      return typeof ctx.fileUploads?.uploadStream === 'function';
    } catch {
      return false;
    }
  }

  /**
   * Yield one buffer in bounded chunks for streaming attachment storage.
   * @param {Buffer} buffer - complete file bytes.
   * @returns {AsyncGenerator<Uint8Array>} chunk sequence.
   */
  async function* chunked(buffer) {
    for (let offset = 0; offset < buffer.length; offset += STAGE_CHUNK_BYTES) {
      yield buffer.subarray(offset, Math.min(buffer.length, offset + STAGE_CHUNK_BYTES));
    }
  }

  /**
   * Validate one target conversation without activating a cold Agent.
   * @param {unknown} rawSessionId - session identity from the RPC/page token.
   * @returns {Promise<{ ok: boolean, sessionId?: string, code?: string, message?: string }>} validation result.
   */
  async function validateSession(rawSessionId) {
    const sessionId = typeof rawSessionId === 'string' ? rawSessionId.trim() : '';
    if (!SESSION_ID_PATTERN.test(sessionId)) {
      return { ok: false, code: 'bad-request', message: 'Invalid session id.' };
    }
    try {
      if (typeof controller()?.inspect === 'function') {
        const inspection = await controller().inspect(sessionId);
        if (inspection === undefined || inspection === null) {
          return { ok: false, code: 'session/not-found', message: `Session "${sessionId}" was not found.` };
        }
      }
      return { ok: true, sessionId };
    } catch (error) {
      const code = typeof error?.code === 'string' ? error.code : 'internal';
      if (code === 'session/not-found') {
        return { ok: false, code, message: `Session "${sessionId}" was not found.` };
      }
      return { ok: false, code, message: typeof error?.message === 'string' ? error.message : String(error) };
    }
  }

  /**
   * Validate the upload batch against deployment image policy before admission.
   * @param {readonly { data: Buffer, mediaType: string }[]} files - uploaded images.
   * @returns {{ ok: true } | { ok: false, code: string, message: string }} batch verdict.
   */
  function validateFiles(files) {
    const mediaLimits = limits();
    if (!Array.isArray(files) || files.length === 0) {
      return { ok: false, code: 'no-image', message: 'No media data was received.' };
    }
    if (files.length > mediaLimits.maxFilesPerUpload) {
      return {
        ok: false,
        code: 'image-too-large',
        message: `Too many files in one message (limit ${mediaLimits.maxFilesPerUpload}).`,
      };
    }
    let imageCount = 0;
    for (const file of files) {
      const kind = file.kind === 'video' ? 'video' : 'image';
      if (!Buffer.isBuffer(file.data) || file.data.length === 0) {
        return { ok: false, code: kind === 'video' ? 'video-invalid' : 'image-invalid', message: 'Empty media data.' };
      }
      if (kind === 'video') {
        if (!ALLOWED_VIDEO_TYPES.has(file.mediaType)) {
          return { ok: false, code: 'video-invalid', message: `Unsupported video type "${file.mediaType}".` };
        }
        if (file.data.length > mediaLimits.maxVideoBytes) {
          return {
            ok: false,
            code: 'video-too-large',
            message: `Video exceeds the byte limit (${mediaLimits.maxVideoBytes}).`,
          };
        }
        continue;
      }
      imageCount += 1;
      if (!ALLOWED_MEDIA_TYPES.has(file.mediaType)) {
        return { ok: false, code: 'image-invalid', message: `Unsupported image type "${file.mediaType}".` };
      }
      if (file.data.length > mediaLimits.maxImageBytes) {
        return {
          ok: false,
          code: 'image-too-large',
          message: `Image exceeds the byte limit (${mediaLimits.maxImageBytes}).`,
        };
      }
    }
    if (imageCount > mediaLimits.maxImagesPerMessage) {
      return {
        ok: false,
        code: 'image-too-large',
        message: `Too many images in one message (limit ${mediaLimits.maxImagesPerMessage}).`,
      };
    }
    return { ok: true };
  }

  /**
   * Stage one video as a durable file attachment and return its prompt part.
   * @param {string} sessionId - target conversation.
   * @param {{ data: Buffer, mediaType: string, filename?: string }} file - video bytes.
   * @param {number} index - position in the batch (fallback display name).
   * @returns {Promise<{ type: 'file', receiptId: string }>} prompt content part.
   */
  async function stageVideoPart(sessionId, file, index) {
    if (!hasFileUploads()) {
      throw Object.assign(new Error('Staged file uploads are not available in this composition.'), {
        code: 'video-unavailable',
      });
    }
    const name = displayName(file.filename, index);
    const staged = await ctx.fileUploads.uploadStream({
      sessionId,
      data: chunked(file.data),
      signal: AbortSignal.timeout(PROMPT_TIMEOUT_MS),
      name,
    });
    return { type: 'file', receiptId: staged.receiptId };
  }

  /**
   * Deliver one batch through the primary session-controller admission.
   * Images become image parts; videos are staged as file receipts and cited as
   * generic file parts (the model receives a durable handle/path, never bytes).
   * @param {string} sessionId - target conversation.
   * @param {readonly { kind?: string, data: Buffer, mediaType: string, filename?: string }[]} files - media.
   * @returns {Promise<{ requestId: string }>} accepted request identity.
   */
  async function deliverDirect(sessionId, files) {
    const requestId = randomUUID();
    const content = [];
    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];
      if (file.kind === 'video') {
        content.push(await stageVideoPart(sessionId, file, index));
      } else {
        content.push({
          type: 'image',
          mediaType: file.mediaType,
          data: file.data.toString('base64'),
          name: displayName(file.filename, index),
        });
      }
    }
    const request = { sessionId, requestId, mode: 'queue', content };
    await controller().prompt(request, AbortSignal.timeout(PROMPT_TIMEOUT_MS));
    return { requestId };
  }

  /**
   * Fallback delivery: persist media and queue a frozen user message directly.
   * @param {string} sessionId - target conversation.
   * @param {readonly { kind?: string, data: Buffer, mediaType: string, filename?: string }[]} files - media.
   * @returns {Promise<{ requestId: string }>} synthetic request identity.
   */
  async function deliverFallback(sessionId, files) {
    const attachments = ctx.attachments;
    if (typeof attachments?.saveImage !== 'function') {
      throw Object.assign(new Error('Neither sessionController.prompt nor attachments.saveImage is available.'), {
        code: 'inject-failed',
      });
    }
    const resolved = await controller().resolveAgent?.(sessionId);
    if (resolved === undefined || resolved?.error !== undefined || resolved?.agent === undefined) {
      const code = resolved?.error?.code ?? 'session/not-found';
      throw Object.assign(new Error(resolved?.error?.message ?? 'Session was not found.'), { code });
    }
    const blocks = [];
    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];
      const name = displayName(file.filename, index);
      if (file.kind === 'video') {
        if (typeof attachments.saveFileStream !== 'function') {
          throw Object.assign(new Error('Streamed file storage is not available in this composition.'), {
            code: 'video-unavailable',
          });
        }
        const ref = await attachments.saveFileStream({
          data: chunked(file.data),
          name,
          signal: AbortSignal.timeout(PROMPT_TIMEOUT_MS),
        });
        blocks.push({ type: 'file', attachment: ref });
      } else {
        const ref = await attachments.saveImage({
          data: new Uint8Array(file.data),
          mediaType: file.mediaType,
          name,
        });
        blocks.push({ type: 'image', attachment: ref });
      }
    }
    const requestId = randomUUID();
    const message = freezeMessage({
      id: randomUUID(),
      role: 'user',
      content: blocks,
      source: { kind: 'user', rpcId: requestId },
    });
    resolved.agent.followup(message);
    return { requestId };
  }

  /**
   * Inject one upload batch into the target conversation.
   * @param {{ sessionId: string, files: readonly { kind?: string, data: Buffer, mediaType: string, filename?: string }[] }} input - delivery request.
   * @returns {Promise<{ ok: boolean, requestId?: string, count?: number, code?: string, message?: string }>} outcome.
   */
  async function deliver({ sessionId, files }) {
    const target = await validateSession(sessionId);
    if (!target.ok) return { ok: false, code: target.code, message: target.message };
    const verdict = validateFiles(files);
    if (!verdict.ok) return verdict;
    const hasVideo = files.some((file) => file.kind === 'video');
    // Videos need either the receipt-based prompt path or streamed file storage.
    const promptReady = supportsDirectPrompt() && (!hasVideo || hasFileUploads());
    try {
      const delivered = promptReady
        ? await deliverDirect(target.sessionId, files)
        : await deliverFallback(target.sessionId, files);
      return { ok: true, requestId: delivered.requestId, count: files.length };
    } catch (error) {
      const mapped = mapAdmissionError(error);
      log?.warn?.('dsh-camera: prompt injection failed (%s): %s', mapped.code, error?.message ?? error);
      return { ok: false, ...mapped };
    }
  }

  return { validateSession, deliver, limits, supportsDirectPrompt, hasFileUploads };
}

export default createInjector;
