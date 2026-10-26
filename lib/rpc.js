/**
 * Authenticated browser RPC channel for the camera panel.
 *
 * The Client half calls `ctx.connection.rpc.call('/dsh-camera', endpoint, payload)`,
 * which issues `POST /dsh-camera/<endpoint>` on the same origin with the
 * Connection `client-request` envelope. This module mounts that prefix route on
 * the Web server, reuses Connection's own browser admission
 * (`ctx.connection.requestRejection`) for authentication, and answers with the
 * matching `server-response` envelope.
 *
 * It mirrors the transport behavior of `ctx.connection.rpc.handle()` by hand
 * because that registry resolves `owner.webServer` from the service owner and
 * rejects plugins that do not inject the Web server; the prefix route is the
 * stable public seam.
 */
import { renderQrPath } from './qr.js';

/** Absolute logical channel shared with client.js. */
export const RPC_CHANNEL = '/dsh-camera';

/** Endpoint names; keep in sync with dsh-camera/client.js. */
export const ENDPOINTS = Object.freeze({
  status: 'camera.status',
  arm: 'camera.arm',
  disarm: 'camera.disarm',
  recent: 'camera.recent',
});

/** Allowed endpoint shape, matching Connection's endpoint segment grammar. */
const ENDPOINT_SEGMENT = /^[A-Za-z0-9_$.-]+$/;

/** Maximum JSON request body accepted on this channel (control payloads only). */
const RPC_BODY_MAX = 1024 * 1024;

/** Envelope id used when a request does not carry a usable rpcId. */
const INVALID_RPC_ID = 'invalid-request';

/**
 * Build a Connection success envelope.
 * @param {unknown} value - endpoint-owned value.
 * @returns {{ ok: true, value: unknown }} result.
 */
function ok(value) {
  return { ok: true, value };
}

/**
 * Build a Connection failure envelope.
 * @param {string} code - stable machine-readable code.
 * @param {string} message - human-readable explanation.
 * @param {Record<string, unknown>} [details] - optional structured details.
 * @returns {{ ok: false, error: { code: string, message: string, details: Record<string, unknown> } }} result.
 */
function fail(code, message, details = {}) {
  return { ok: false, error: { code, message: String(message), details } };
}

/**
 * Clamp a caller-supplied conversation title for display only.
 * @param {unknown} title - title from the browser.
 * @returns {string} safe short title.
 */
function displayTitle(title) {
  const text = typeof title === 'string' ? title : '';
  // eslint-disable-next-line no-control-regex
  const cleaned = text.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return cleaned.slice(0, 120);
}

/**
 * Serialize one server-response envelope.
 * @param {string} rpcId - correlation identity echoed from the request.
 * @param {object} result - success or failure result.
 * @returns {string} JSON body.
 */
function responseJson(rpcId, result) {
  return JSON.stringify({ type: 'server-response', rpcId, result });
}

/**
 * Read one bounded JSON request body.
 * @param {import('node:http').IncomingMessage} req - incoming request.
 * @param {number} maxBytes - hard byte cap.
 * @returns {Promise<unknown>} parsed JSON value.
 */
async function readJsonBody(req, maxBytes) {
  const declared = req.headers['content-length'];
  if (declared !== undefined && Number(declared) > maxBytes) {
    const error = new Error('request body is too large');
    error.code = 'too-large';
    throw error;
  }
  const chunks = [];
  let received = 0;
  for await (const chunk of req) {
    received += chunk.length;
    if (received > maxBytes) {
      const error = new Error('request body is too large');
      error.code = 'too-large';
      throw error;
    }
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.length === 0) return undefined;
  return JSON.parse(text);
}

/**
 * Extract the endpoint segment after the channel prefix.
 * @param {string} channel - absolute channel path.
 * @param {string} pathname - request pathname.
 * @returns {string | undefined} endpoint, or undefined when the path is not ours.
 */
function endpointFromPath(channel, pathname) {
  if (!pathname.startsWith(`${channel}/`)) return undefined;
  const endpoint = pathname.slice(channel.length + 1);
  const segments = endpoint.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..' || !ENDPOINT_SEGMENT.test(segment))) {
    return undefined;
  }
  return endpoint;
}

/**
 * Mount the camera RPC channel.
 * @param {object} options - wiring.
 * @param {import('@deepseek-ai/cordis').Context} options.ctx - Host plugin context.
 * @param {object} options.tokens - TokenStore instance.
 * @param {object} options.injector - injector facade from lib/inject.js.
 * @param {() => object | null} options.serverRef - returns the running LAN server, or null.
 * @param {() => string | null} options.serverErrorRef - returns the last server startup failure.
 * @param {object} options.config - resolved plugin configuration.
 * @param {string} options.version - plugin version reported to the panel.
 * @param {{ info: Function, warn: Function, error: Function }} options.log - named logger.
 * @returns {{ available: boolean, dispose: () => Promise<void> }} channel handle.
 */
export function installRpc({ ctx, tokens, injector, serverRef, serverErrorRef, config, version, log }) {
  const webServer = ctx.webServer;
  const connection = ctx.connection;
  if (typeof webServer?.register !== 'function' || connection === undefined) {
    log?.warn?.('dsh-camera: webServer/connection is unavailable; the camera panel cannot reach the Host');
    return { available: false, dispose: async () => {} };
  }

  /**
   * Current server facts for the panel.
   * @returns {{ running: boolean, port: number | null, lanIp: string | null, localOnly: boolean, warning: string | null }} facts.
   */
  function serverFacts() {
    const server = serverRef();
    const info = typeof server?.info === 'function' ? server.info() : null;
    return {
      running: info?.running === true,
      port: typeof info?.port === 'number' ? info.port : null,
      lanIp: typeof info?.lanIp === 'string' ? info.lanIp : null,
      localOnly: info?.localOnly === true,
      warning: serverErrorRef() ?? info?.warning ?? null,
      httpsEnabled: info?.httpsEnabled === true,
      httpsPort: typeof info?.httpsPort === 'number' ? info.httpsPort : null,
      setupUrl: typeof info?.setupUrl === 'string' ? info.setupUrl : null,
      caFingerprint: typeof info?.caFingerprint === 'string' ? info.caFingerprint : null,
    };
  }

  /**
   * `camera.status`: server availability plus the configuration the panel may show.
   * @returns {Promise<object>} endpoint result.
   */
  async function status() {
    return ok({
      server: serverFacts(),
      config: {
        enabled: config.enabled === true,
        port: config.port,
        tokenTtlMs: config.tokenTtlMs,
        maxFilesPerUpload: config.maxFilesPerUpload,
      },
      version,
    });
  }

  /**
   * `camera.arm`: validate the conversation and mint (or reuse) one upload link.
   * @param {unknown} payload - `{ sessionId, title?, rotate? }`.
   * @returns {Promise<object>} endpoint result.
   */
  async function arm(payload) {
    const input = payload !== null && typeof payload === 'object' ? payload : {};
    const sessionId = typeof input.sessionId === 'string' ? input.sessionId.trim() : '';
    if (sessionId.length === 0) return fail('bad-request', 'sessionId is required.');
    const server = serverRef();
    if (server === null || typeof server.buildUrl !== 'function') {
      return fail('server-unavailable', serverErrorRef() ?? 'The LAN camera server is not running.');
    }
    const validation = await injector.validateSession(sessionId);
    if (!validation.ok) {
      return fail(validation.code ?? 'session/not-found', validation.message ?? 'Session not found.');
    }
    const title = displayTitle(input.title);
    const entry = input.rotate === true
      ? tokens.armNew({ sessionId, title })
      : tokens.arm({ sessionId, title });
    const facts = serverFacts();
    // The server falls back to a loopback URL when no LAN address is
    // detectable; a QR code pointing at 127.0.0.1 is useless for a phone, so
    // surface the configuration problem instead of minting such a link.
    if (facts.localOnly || facts.lanIp === null) {
      return fail(
        'no-lan-address',
        'No LAN address was detected. Set lanIpOverride in the plugin config or check the network connection.',
      );
    }
    const url = server.buildUrl(entry.token);
    if (typeof url !== 'string' || url.length === 0) {
      return fail(
        'no-lan-address',
        'No LAN address was detected. Set lanIpOverride in the plugin config or check the network connection.',
      );
    }
    const qr = renderQrPath(url);
    await tokens.flush();
    log?.info?.('dsh-camera: armed an upload link for session %s', sessionId);
    return ok({
      token: entry.token,
      url,
      qr: { size: qr.size, path: qr.path },
      expiresAt: entry.expiresAt,
      sessionId,
      title: entry.title,
      lanIp: facts.lanIp,
      server: { port: facts.port },
    });
  }

  /**
   * `camera.disarm`: revoke one upload link immediately.
   * @param {unknown} payload - `{ token }`.
   * @returns {Promise<object>} endpoint result.
   */
  async function disarm(payload) {
    const input = payload !== null && typeof payload === 'object' ? payload : {};
    const token = typeof input.token === 'string' ? input.token.trim() : '';
    if (token.length === 0) return fail('bad-request', 'token is required.');
    const disarmed = tokens.disarm(token);
    if (disarmed) await tokens.flush();
    return ok({ disarmed });
  }

  /**
   * `camera.recent`: recent upload rows for the panel's counter.
   * @param {unknown} payload - `{ limit? }`.
   * @returns {Promise<object>} endpoint result.
   */
  async function recent(payload) {
    const input = payload !== null && typeof payload === 'object' ? payload : {};
    const limit = Number.isFinite(input.limit) ? Math.max(1, Math.min(50, Math.trunc(input.limit))) : 10;
    return ok({ uploads: tokens.recent(limit) });
  }

  /** Endpoint dispatch table. */
  const handlers = {
    [ENDPOINTS.status]: status,
    [ENDPOINTS.arm]: arm,
    [ENDPOINTS.disarm]: disarm,
    [ENDPOINTS.recent]: recent,
  };

  /**
   * Answer one browser request; owns the full response lifecycle.
   * @param {import('node:http').IncomingMessage} req - incoming request.
   * @param {import('node:http').ServerResponse} res - response to complete.
   */
  async function handleRequest(req, res) {
    const endpoint = endpointFromPath(RPC_CHANNEL, new URL(req.url, 'http://localhost').pathname);
    if (req.method !== 'POST' || endpoint === undefined) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found');
      return;
    }
    // Browser admission: loopback/Host fence, cookie authentication, and live Peer.
    let rejection;
    try {
      rejection = connection.requestRejection(req);
    } catch {
      rejection = 403;
    }
    if (rejection !== undefined) {
      res.writeHead(rejection, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(rejection === 401 ? 'unauthorized' : 'forbidden');
      return;
    }
    const mediaType = req.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase();
    if (mediaType !== 'application/json') {
      res.writeHead(415, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('content type must be application/json');
      return;
    }
    let body;
    try {
      body = await readJsonBody(req, RPC_BODY_MAX);
    } catch (error) {
      const status = error?.code === 'too-large' ? 413 : 400;
      res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(status === 413 ? 'request body is too large' : 'body is not JSON');
      return;
    }
    const rpcId = body !== null && typeof body === 'object' && typeof body.rpcId === 'string' ? body.rpcId : INVALID_RPC_ID;
    const method = body !== null && typeof body === 'object' && typeof body.method === 'string' ? body.method : null;
    if (rpcId === INVALID_RPC_ID || method === null || method !== endpoint) {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(
        responseJson(rpcId, fail('gateway/bad-request', 'invalid client-request message')),
      );
      return;
    }
    const handler = handlers[endpoint];
    if (handler === undefined) {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(responseJson(rpcId, fail('gateway/bad-request', `Unknown camera endpoint "${endpoint}".`)));
      return;
    }
    let result;
    try {
      result = await handler(body.payload);
    } catch (error) {
      log?.warn?.('dsh-camera: RPC %s failed: %s', endpoint, error?.message ?? error);
      result = fail('internal', error?.message ?? String(error));
    }
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(responseJson(rpcId, result));
  }

  const registered = webServer.register({
    kind: 'prefix',
    path: RPC_CHANNEL,
    handler: handleRequest,
  });

  // `webServer.register` returns a disposer synchronously, but tolerate a
  // Promise-returning seam: dispose exactly once and await either shape.
  let disposed = false;
  async function cleanup() {
    if (disposed) return;
    disposed = true;
    try {
      const resolved = typeof registered?.then === 'function' ? await registered : registered;
      if (typeof resolved === 'function') {
        const result = resolved();
        if (result !== null && typeof result?.then === 'function') await result;
      } else if (resolved !== null && typeof resolved?.dispose === 'function') {
        await resolved.dispose();
      }
    } catch {
      /* already disposed */
    }
  }

  return { available: true, dispose: cleanup };
}

export default installRpc;
