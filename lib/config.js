/**
 * Resolved plugin configuration for the Host half of dsh-camera.
 *
 * The plugin receives its raw `config` object from the composed profile row
 * (`cordis.patch.yml` insert). There is no schemastery schema because a
 * `link:`-installed plugin cannot resolve `@deepseek-ai/schemastery`; every
 * field is therefore validated here, once, with documented defaults.
 */
import os from 'node:os';
import path from 'node:path';

/** Documented defaults, also echoed by README. */
export const DEFAULTS = Object.freeze({
  enabled: true,
  port: 3579,
  bindHost: '0.0.0.0',
  lanIpOverride: '',
  tokenTtlMs: 2 * 60 * 60 * 1000,
  maxUploadBytes: 24 * 1024 * 1024,
  maxFilesPerUpload: 6,
  uploadsPerHour: 120,
  /** HTTPS（全屏相机）开关；默认关，开启后手机页可用 getUserMedia 全屏拍照 */
  https: false,
  /** HTTPS 端口；0 表示自动取 HTTP 实际端口 + 1（占用时回退随机端口） */
  httpsPort: 0,
});

/**
 * Resolve the harness home directory.
 * @param {NodeJS.ProcessEnv} env - environment to read.
 * @returns {string} absolute DSH home.
 */
export function dshHome(env = process.env) {
  const fromEnv = typeof env.DSH_HOME === 'string' ? env.DSH_HOME.trim() : '';
  return fromEnv.length > 0 ? path.resolve(fromEnv) : path.join(os.homedir(), '.dsh');
}

/**
 * Positive integer coercion with a hard fallback.
 * @param {unknown} value - candidate from config or environment.
 * @param {number} fallback - default used for anything invalid.
 * @param {{ min?: number, max?: number }} [bounds] - inclusive bounds.
 * @returns {number} validated number.
 */
function positiveInt(value, fallback, bounds = {}) {
  const min = bounds.min ?? 1;
  const max = bounds.max ?? Number.MAX_SAFE_INTEGER;
  const parsed = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isFinite(parsed)) return fallback;
  const rounded = Math.trunc(parsed);
  if (rounded < min || rounded > max) return fallback;
  return rounded;
}

/**
 * Boolean coercion for config values (`false`/`0`/`'0'`/`'false'` are falsey).
 * @param {unknown} value - candidate value.
 * @param {boolean} fallback - default.
 * @returns {boolean} validated boolean.
 */
function boolValue(value, fallback) {
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === '1' || value === 1) return true;
  if (value === 'false' || value === '0' || value === 0) return false;
  return fallback;
}

/**
 * Validate one bind address. Only `0.0.0.0` or a concrete IPv4 literal is
 * accepted: the camera server is a LAN-facing surface and must never rely on an
 * unspecified address being rejected later by Node.
 * @param {unknown} value - candidate bind host.
 * @param {string} fallback - default bind host.
 * @returns {string} validated bind host.
 */
function bindHostValue(value, fallback) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text === '0.0.0.0' || text === '127.0.0.1') return text;
  if (/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(text)) return text;
  return fallback;
}

/**
 * Resolve the full plugin configuration from its raw profile row plus the
 * environment (environment wins for the few operational overrides).
 * @param {Record<string, unknown> | undefined} rawConfig - `config` from the profile patch row.
 * @param {NodeJS.ProcessEnv} [env] - process environment.
 * @returns {{
 *   enabled: boolean, port: number, bindHost: string, lanIpOverride: string,
 *   tokenTtlMs: number, maxUploadBytes: number, maxFilesPerUpload: number,
 *   uploadsPerHour: number, https: boolean, httpsPort: number,
 *   stateDir: string, debug: boolean, home: string,
 * }}
 */
export function resolveConfig(rawConfig, env = process.env) {
  const raw = rawConfig !== null && typeof rawConfig === 'object' ? rawConfig : {};
  const home = dshHome(env);
  const stateDir = path.join(home, 'dsh-camera');
  const lanIpOverride = String(
    raw.lanIpOverride ?? env.DSH_CAMERA_LAN_IP ?? DEFAULTS.lanIpOverride,
  ).trim();
  const config = {
    enabled: boolValue(raw.enabled, DEFAULTS.enabled),
    port: positiveInt(env.DSH_CAMERA_PORT ?? raw.port, DEFAULTS.port, { min: 0, max: 65535 }),
    bindHost: bindHostValue(raw.bindHost, DEFAULTS.bindHost),
    lanIpOverride: /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(lanIpOverride) ? lanIpOverride : '',
    tokenTtlMs: positiveInt(raw.tokenTtlMs, DEFAULTS.tokenTtlMs, { min: 60_000 }),
    maxUploadBytes: positiveInt(raw.maxUploadBytes, DEFAULTS.maxUploadBytes, { min: 1024 }),
    maxFilesPerUpload: positiveInt(raw.maxFilesPerUpload, DEFAULTS.maxFilesPerUpload, { min: 1, max: 20 }),
    uploadsPerHour: positiveInt(raw.uploadsPerHour, DEFAULTS.uploadsPerHour, { min: 1 }),
    https: boolValue(raw.https, DEFAULTS.https),
    httpsPort: positiveInt(raw.httpsPort, DEFAULTS.httpsPort, { min: 0, max: 65535 }),
    stateDir,
    home,
    debug: boolValue(env.DSH_CAMERA_DEBUG, false),
  };
  if (config.port === 0) config.port = DEFAULTS.port;
  return config;
}

export default resolveConfig;
