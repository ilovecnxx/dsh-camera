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

/** Media types accepted by the attachment pipeline (mirrors the shipped limits). */
const ALLOWED_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

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
    if (/TOO_LARGE|TOO_MANY_PIXELS|TOO_LARGE_DIMENSION|EXCEEDS/.test(reason)) {
      return { code: 'image-too-large', message };
    }
    return { code: 'image-invalid', message };
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
      maxImageBytes: typeof imageLimits?.maxImageBytes === 'number' ? imageLimits.maxImageBytes : 20 * 1024 * 1024,
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
    const imageLimits = limits();
    if (!Array.isArray(files) || files.length === 0) {
      return { ok: false, code: 'no-image', message: 'No image data was received.' };
    }
    if (files.length > imageLimits.maxImagesPerMessage) {
      return {
        ok: false,
        code: 'image-too-large',
        message: `Too many images in one message (limit ${imageLimits.maxImagesPerMessage}).`,
      };
    }
    for (const file of files) {
      if (!Buffer.isBuffer(file.data) || file.data.length === 0) {
        return { ok: false, code: 'image-invalid', message: 'Empty image data.' };
      }
      if (!ALLOWED_MEDIA_TYPES.has(file.mediaType)) {
        return { ok: false, code: 'image-invalid', message: `Unsupported image type "${file.mediaType}".` };
      }
      if (file.data.length > imageLimits.maxImageBytes) {
        return {
          ok: false,
          code: 'image-too-large',
          message: `Image exceeds the byte limit (${imageLimits.maxImageBytes}).`,
        };
      }
    }
    return { ok: true };
  }

  /**
   * Deliver one batch through the primary session-controller admission.
   * @param {string} sessionId - target conversation.
   * @param {readonly { data: Buffer, mediaType: string, filename?: string }[]} files - images.
   * @returns {Promise<{ requestId: string }>} accepted request identity.
   */
  async function deliverDirect(sessionId, files) {
    const requestId = randomUUID();
    const content = files.map((file, index) => ({
      type: 'image',
      mediaType: file.mediaType,
      data: file.data.toString('base64'),
      name: displayName(file.filename, index),
    }));
    const request = { sessionId, requestId, mode: 'queue', content };
    await controller().prompt(request, AbortSignal.timeout(PROMPT_TIMEOUT_MS));
    return { requestId };
  }

  /**
   * Fallback delivery: persist images and queue a frozen user message directly.
   * @param {string} sessionId - target conversation.
   * @param {readonly { data: Buffer, mediaType: string, filename?: string }[]} files - images.
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
      const ref = await attachments.saveImage({
        data: new Uint8Array(file.data),
        mediaType: file.mediaType,
        name: displayName(file.filename, index),
      });
      blocks.push({ type: 'image', attachment: ref });
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
   * @param {{ sessionId: string, files: readonly { data: Buffer, mediaType: string, filename?: string }[] }} input - delivery request.
   * @returns {Promise<{ ok: boolean, requestId?: string, count?: number, code?: string, message?: string }>} outcome.
   */
  async function deliver({ sessionId, files }) {
    const target = await validateSession(sessionId);
    if (!target.ok) return { ok: false, code: target.code, message: target.message };
    const verdict = validateFiles(files);
    if (!verdict.ok) return verdict;
    try {
      const delivered = supportsDirectPrompt()
        ? await deliverDirect(target.sessionId, files)
        : await deliverFallback(target.sessionId, files);
      return { ok: true, requestId: delivered.requestId, count: files.length };
    } catch (error) {
      const mapped = mapAdmissionError(error);
      log?.warn?.('dsh-camera: prompt injection failed (%s): %s', mapped.code, error?.message ?? error);
      return { ok: false, ...mapped };
    }
  }

  return { validateSession, deliver, limits, supportsDirectPrompt };
}

export default createInjector;
