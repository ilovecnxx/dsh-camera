// dsh-camera · 本地 HTTPS 证书材料（task-5）
// 仅依赖 Node 内置模块；不 import 任何 @deepseek-ai/* 或第三方包。
//
// iPhone 上的 getUserMedia 需要 secure context：局域网 HTTP 页面拿不到相机。
// 本模块用系统 openssl 同步生成/复用一套本地 PKI：
//
//   <stateDir>/tls/ca.key        本地 CA 私钥（RSA 2048，0600）
//   <stateDir>/tls/ca.crt        本地 CA 证书（10 年，basicConstraints=critical,CA:TRUE）
//   <stateDir>/tls/server.key    服务器私钥（RSA 2048，0600）
//   <stateDir>/tls/server.crt    服务器证书（由 CA 签，825 天，SAN=hosts）
//   <stateDir>/tls/meta.json     SAN / 指纹 / mobileconfig UUID 持久化
//
// 复用策略：
//   - CA 永远复用；只有 ca.key/ca.crt 缺失、无法解析、过期、私钥不匹配时才重建。
//   - server 证书在缺失/损坏/过期/CA 变了/meta.san 与本次 hosts 不一致时重签；
//     hosts 变化只重签 server.crt，复用 server.key。
//
// 一切失败都抛 Error（message 带 openssl stderr 摘要），上层据此降级为「HTTPS 不可用」。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const TLS_DIR = 'tls';
const CA_KEY_FILE = 'ca.key';
const CA_CERT_FILE = 'ca.crt';
const SERVER_KEY_FILE = 'server.key';
const SERVER_CERT_FILE = 'server.crt';
const META_FILE = 'meta.json';

const CA_CN = 'dsh-camera local CA';
const SERVER_CN = 'dsh-camera local server';
const CA_DISPLAY_NAME = 'dsh-camera local CA';
const CA_DAYS = 3650;
const SERVER_DAYS = 825;
const RSA_BITS = 2048;
const OPENSSL_TIMEOUT_MS = 60 * 1000;
const CERT_EXPIRY_MARGIN_MS = 60 * 1000; // 剩余寿命不足 1 分钟即视为过期
const CERTIFICATE_FILE_NAME = 'dsh-camera-ca.crt';

const PROFILE_IDENTIFIER = 'local.dsh-camera.profile';
const CA_PAYLOAD_IDENTIFIER = 'local.dsh-camera.ca';

// 无论 hosts 是什么，这几个地址始终写进 SAN：
// 在本机自测（https://127.0.0.1 / https://localhost）时也用同一套证书。
const FIXED_SAN = ['IP:127.0.0.1', 'DNS:localhost'];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IPV4_RE =
  /^(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]\d|[0-9])(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]\d|[0-9])){3}$/;
const IPV6_RE = /^[0-9a-fA-F:]+$/;
const HOST_LABEL_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;

// ----------------------------------------------------------------- helpers: log

function safeLog(log) {
  const target = log && typeof log === 'object' ? log : null;
  return (level, ...args) => {
    try {
      const fn = target && target[level];
      if (typeof fn === 'function') fn.apply(target, args);
    } catch {
      // 日志永远不能影响证书生成
    }
  };
}

// -------------------------------------------------------------- helpers: openssl

/** 允许 DSH_CAMERA_OPENSSL 覆盖二进制路径（测试/特殊环境），默认走 PATH 里的 openssl。 */
function opensslBinary() {
  const override = process.env.DSH_CAMERA_OPENSSL;
  if (typeof override === 'string' && override.trim()) return override.trim();
  return 'openssl';
}

function errorSummary(err) {
  let raw = '';
  try {
    if (err && err.stderr) raw = Buffer.from(err.stderr).toString('utf8');
  } catch {
    raw = '';
  }
  if (!raw.trim()) {
    try {
      if (err && err.stdout) raw = Buffer.from(err.stdout).toString('utf8');
    } catch {
      raw = '';
    }
  }
  if (!raw.trim()) raw = (err && err.message) || String(err);
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 4)
    .join(' | ')
    .slice(0, 600);
}

/**
 * 同步执行 openssl（参数数组，绝不拼 shell 字符串）。
 * 失败时抛 Error，message 含 stderr 摘要，便于上层降级。
 */
function runOpenssl(args) {
  const bin = opensslBinary();
  try {
    return execFileSync(bin, args, {
      encoding: 'utf8',
      timeout: OPENSSL_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
  } catch (err) {
    const summary = errorSummary(err);
    const detail = summary || 'unknown error';
    const error = new Error(`[dsh-camera] openssl ${String(args[0] || '')} failed: ${detail}`);
    error.code = 'tls-generation-failed';
    error.stderr = (() => {
      try {
        return err && err.stderr ? Buffer.from(err.stderr).toString('utf8') : '';
      } catch {
        return '';
      }
    })();
    error.cause = err;
    throw error;
  }
}

// ---------------------------------------------------------------- helpers: hosts

function stripBrackets(value) {
  const trimmed = String(value).trim();
  return trimmed.startsWith('[') && trimmed.endsWith(']') ? trimmed.slice(1, -1) : trimmed;
}

function isIpv4(value) {
  return IPV4_RE.test(value);
}

function isIpv6(value) {
  if (!value || !value.includes(':')) return false;
  // 只看字符集与冒号数量是否像 IPv6；hosts 来自本地配置，无需完整 RFC 校验。
  if (!IPV6_RE.test(value)) return false;
  return (value.match(/:/g) || []).length >= 2;
}

function isHostname(value) {
  if (typeof value !== 'string') return false;
  let name = value.trim();
  if (name.endsWith('.')) name = name.slice(0, -1); // 允许 FQDN 末尾的点，但写 SAN 时去掉
  if (!name || name.length > 253) return false;
  return name.split('.').every((label) => HOST_LABEL_RE.test(label));
}

function classifyStringHost(value) {
  const raw = stripBrackets(value);
  if (!raw) return null;
  if (isIpv4(raw)) return `IP:${raw}`;
  if (isIpv6(raw)) return `IP:${raw}`;
  if (isHostname(raw)) {
    const name = raw.endsWith('.') ? raw.slice(0, -1) : raw;
    return `DNS:${name}`;
  }
  return null;
}

/**
 * 把 hosts 元素（`{ ip }` / `{ dns }`，也接受裸字符串）转成 SAN 条目。
 * 非法条目返回 null（调用方忽略，避免一张坏条目毁掉整个证书）。
 */
function hostToSan(entry) {
  if (typeof entry === 'string') return classifyStringHost(entry);
  if (!entry || typeof entry !== 'object') return null;
  if (typeof entry.ip === 'string' && entry.ip.trim()) {
    const ip = stripBrackets(entry.ip);
    if (isIpv4(ip) || isIpv6(ip)) return `IP:${ip}`;
    return null;
  }
  if (typeof entry.dns === 'string' && entry.dns.trim()) {
    const dns = entry.dns.trim();
    if (!isHostname(dns)) return null;
    return `DNS:${dns.endsWith('.') ? dns.slice(0, -1) : dns}`;
  }
  return null;
}

/** 固定 SAN + hosts，去重且保持顺序（固定项在最前，保证同一个 hosts 集合生成稳定证书）。 */
function buildSan(hosts) {
  const result = [];
  const seen = new Set();
  const add = (san) => {
    if (!san || seen.has(san)) return;
    seen.add(san);
    result.push(san);
  };
  for (const fixed of FIXED_SAN) add(fixed);
  const list = Array.isArray(hosts) ? hosts : hosts === undefined || hosts === null ? [] : [hosts];
  for (const entry of list) add(hostToSan(entry));
  return result;
}

// ------------------------------------------------------------------- helpers: fs

function ensureTlsDir(stateDir) {
  const dir = path.join(stateDir, TLS_DIR);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // mkdir 的 mode 受 umask 影响，显式 chmod 保证 0700。
  fs.chmodSync(dir, 0o700);
  return dir;
}

function randomSuffix() {
  return crypto.randomBytes(6).toString('hex');
}

function readTextIfExists(file) {
  try {
    const value = fs.readFileSync(file, 'utf8');
    return value.trim() ? value : null;
  } catch {
    return null;
  }
}

function writeSecretFile(file, data) {
  fs.writeFileSync(file, data, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

function removeQuietly(file) {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    // ignore
  }
}

// -------------------------------------------------------------- helpers: certs

function parseCertificate(pem) {
  if (typeof pem !== 'string' || !pem.includes('BEGIN CERTIFICATE')) return null;
  try {
    return new crypto.X509Certificate(pem);
  } catch {
    return null;
  }
}

function certExpiryMs(cert) {
  try {
    if (cert.validToDate instanceof Date) return cert.validToDate.getTime();
  } catch {
    // ignore
  }
  const parsed = Date.parse(cert.validTo);
  return Number.isFinite(parsed) ? parsed : NaN;
}

/** SHA-256 指纹（大写冒号分隔，形如 openssl x509 -fingerprint -sha256 的输出）。 */
function certificateFingerprint(cert) {
  const raw = (cert && cert.fingerprint256) || '';
  if (!raw) return '';
  return raw
    .split(':')
    .map((part) => part.trim().toUpperCase())
    .filter(Boolean)
    .join(':');
}

function isValidCa(cert, keyPem) {
  if (!cert || cert.ca !== true) return false;
  const expiry = certExpiryMs(cert);
  if (!Number.isFinite(expiry) || expiry <= Date.now() + CERT_EXPIRY_MARGIN_MS) return false;
  let key;
  try {
    key = crypto.createPrivateKey(keyPem);
  } catch {
    return false;
  }
  try {
    return cert.checkPrivateKey(key) === true;
  } catch {
    return false;
  }
}

/** 服务器证书是否还能直接复用（能解析、未过期、由当前 CA 签发、与 server.key 配对）。 */
function isServerCertUsable(cert, keyPem, caCert) {
  if (!cert || !keyPem) return false;
  const expiry = certExpiryMs(cert);
  if (!Number.isFinite(expiry) || expiry <= Date.now() + CERT_EXPIRY_MARGIN_MS) return false;
  if (!caCert) return false;
  try {
    if (cert.checkIssued(caCert) !== true) return false;
  } catch {
    return false;
  }
  let key;
  try {
    key = crypto.createPrivateKey(keyPem);
  } catch {
    return false;
  }
  try {
    return cert.checkPrivateKey(key) === true;
  } catch {
    return false;
  }
}

// -------------------------------------------------------------- helpers: generate

function generateCa(dir) {
  const keyPath = path.join(dir, CA_KEY_FILE);
  const certPath = path.join(dir, CA_CERT_FILE);

  runOpenssl([
    'genpkey',
    '-algorithm',
    'RSA',
    '-pkeyopt',
    `rsa_keygen_bits:${RSA_BITS}`,
    '-out',
    keyPath,
  ]);
  fs.chmodSync(keyPath, 0o600);

  runOpenssl([
    'req',
    '-x509',
    '-new',
    '-key',
    keyPath,
    '-sha256',
    '-days',
    String(CA_DAYS),
    '-subj',
    `/CN=${CA_CN}`,
    '-out',
    certPath,
    '-addext',
    'basicConstraints=critical,CA:TRUE',
    '-addext',
    'keyUsage=critical,keyCertSign,cRLSign',
    '-addext',
    'subjectKeyIdentifier=hash',
  ]);
  fs.chmodSync(certPath, 0o600);
}

/** server.key 存在且可解析就复用；否则生成新密钥。 */
function ensureServerKey(dir) {
  const keyPath = path.join(dir, SERVER_KEY_FILE);
  const existing = readTextIfExists(keyPath);
  if (existing) {
    try {
      crypto.createPrivateKey(existing);
      fs.chmodSync(keyPath, 0o600);
      return;
    } catch {
      // 损坏 → 重新生成
    }
  }
  runOpenssl([
    'genpkey',
    '-algorithm',
    'RSA',
    '-pkeyopt',
    `rsa_keygen_bits:${RSA_BITS}`,
    '-out',
    keyPath,
  ]);
  fs.chmodSync(keyPath, 0o600);
}

function serverExtensions(san) {
  return (
    [
      'basicConstraints=critical,CA:FALSE',
      'keyUsage=critical,digitalSignature,keyEncipherment',
      'extendedKeyUsage=serverAuth',
      `subjectAltName=${san.join(',')}`,
      'subjectKeyIdentifier=hash',
      'authorityKeyIdentifier=keyid,issuer',
    ].join('\n') + '\n'
  );
}

/** 用现有 server.key 生成 CSR，再由本地 CA 签发 server.crt（临时文件用完即删）。 */
function signServerCert(dir, san) {
  ensureServerKey(dir);
  const keyPath = path.join(dir, SERVER_KEY_FILE);
  const certPath = path.join(dir, SERVER_CERT_FILE);
  const caCertPath = path.join(dir, CA_CERT_FILE);
  const caKeyPath = path.join(dir, CA_KEY_FILE);
  const suffix = randomSuffix();
  const csrPath = path.join(dir, `.server-${suffix}.csr`);
  const extPath = path.join(dir, `.server-${suffix}.ext`);

  try {
    writeSecretFile(extPath, serverExtensions(san));

    runOpenssl(['req', '-new', '-key', keyPath, '-subj', `/CN=${SERVER_CN}`, '-out', csrPath]);
    fs.chmodSync(csrPath, 0o600);

    // 随机 128-bit 序列号：重签时新旧证书序号不同，避免客户端缓存旧证书。
    const serial = `0x${crypto.randomBytes(16).toString('hex')}`;
    runOpenssl([
      'x509',
      '-req',
      '-in',
      csrPath,
      '-CA',
      caCertPath,
      '-CAkey',
      caKeyPath,
      '-set_serial',
      serial,
      '-days',
      String(SERVER_DAYS),
      '-sha256',
      '-extfile',
      extPath,
      '-out',
      certPath,
    ]);
    fs.chmodSync(certPath, 0o600);
  } finally {
    removeQuietly(csrPath);
    removeQuietly(extPath);
  }
}

// ---------------------------------------------------------------- helpers: meta

function readMeta(dir) {
  const raw = readTextIfExists(path.join(dir, META_FILE));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function persistedUuid(meta, key) {
  const value = meta && typeof meta[key] === 'string' ? meta[key] : '';
  return UUID_RE.test(value) ? value : crypto.randomUUID();
}

function writeMeta(dir, meta) {
  const file = path.join(dir, META_FILE);
  const tmp = path.join(dir, `.meta-${randomSuffix()}.json`);
  try {
    writeSecretFile(tmp, `${JSON.stringify(meta, null, 2)}\n`);
    fs.renameSync(tmp, file);
    fs.chmodSync(file, 0o600);
  } finally {
    removeQuietly(tmp);
  }
}

function sanEquals(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right)) return false;
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

// ------------------------------------------------------------------- public API

function pemCertificateBase64(pem) {
  if (typeof pem !== 'string' || !pem.trim()) {
    throw new Error('[dsh-camera] renderCaProfile requires a non-empty caPem string');
  }
  const match = /-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/.exec(pem);
  if (!match) {
    throw new Error('[dsh-camera] renderCaProfile: caPem does not contain a PEM certificate');
  }
  const body = match[1].replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(body) || body.length % 4 !== 0) {
    throw new Error('[dsh-camera] renderCaProfile: caPem contains an invalid base64 certificate body');
  }
  return body;
}

function escapeXml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&apos;';
    }
  });
}

/**
 * 渲染 iOS configuration profile（.mobileconfig），把本地 CA 装进系统信任链。
 * iPhone 打开该文件 → 设置里安装描述文件 →「关于本机 → 证书信任设置」信任该根证书。
 *
 * @param {{ caPem: string, caUUID: string, profileUUID: string, displayName?: string }} options
 * @returns {string} plist XML
 */
export function renderCaProfile({ caPem, caUUID, profileUUID, displayName } = {}) {
  const certificateBase64 = pemCertificateBase64(caPem);
  const caUuid = typeof caUUID === 'string' && caUUID.trim() ? caUUID.trim() : crypto.randomUUID();
  const profileUuid =
    typeof profileUUID === 'string' && profileUUID.trim() ? profileUUID.trim() : crypto.randomUUID();
  const rawName = displayName === undefined || displayName === null ? '' : String(displayName).trim();
  const name = escapeXml(rawName || CA_DISPLAY_NAME);
  const description = escapeXml(
    `${rawName || CA_DISPLAY_NAME}：dsh-camera 局域网 HTTPS 所需的本地根证书（Local root CA for dsh-camera LAN HTTPS）`,
  );

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>PayloadContent</key>
	<array>
		<dict>
			<key>PayloadCertificateFileName</key>
			<string>${CERTIFICATE_FILE_NAME}</string>
			<key>PayloadContent</key>
			<data>${certificateBase64}</data>
			<key>PayloadDescription</key>
			<string>${description}</string>
			<key>PayloadDisplayName</key>
			<string>${name}</string>
			<key>PayloadIdentifier</key>
			<string>${CA_PAYLOAD_IDENTIFIER}</string>
			<key>PayloadType</key>
			<string>com.apple.security.root</string>
			<key>PayloadUUID</key>
			<string>${escapeXml(caUuid)}</string>
			<key>PayloadVersion</key>
			<integer>1</integer>
		</dict>
	</array>
	<key>PayloadDescription</key>
	<string>${description}</string>
	<key>PayloadDisplayName</key>
	<string>${name}</string>
	<key>PayloadIdentifier</key>
	<string>${PROFILE_IDENTIFIER}</string>
	<key>PayloadOrganization</key>
	<string>dsh-camera</string>
	<key>PayloadType</key>
	<string>Configuration</string>
	<key>PayloadUUID</key>
	<string>${escapeXml(profileUuid)}</string>
	<key>PayloadVersion</key>
	<integer>1</integer>
</dict>
</plist>
`;
}

/**
 * 同步确保本地 HTTPS 证书材料可用（生成或复用）。
 *
 * @param {{
 *   stateDir: string,                         // $DSH_HOME/dsh-camera
 *   hosts?: Array<{ip?: string, dns?: string}>, // 需要写进 SAN 的地址
 *   log?: object,                             // console 兼容对象（可选）
 * }} options
 * @returns {{
 *   key: Buffer, cert: Buffer, caPem: string, caPath: string,
 *   mobileConfig: string, san: string[], generated: boolean, fingerprint: string,
 * }}
 */
export function ensureTlsMaterial({ stateDir, hosts, log } = {}) {
  if (typeof stateDir !== 'string' || !stateDir.trim()) {
    throw new TypeError('[dsh-camera] ensureTlsMaterial requires a stateDir string');
  }
  const warn = safeLog(log);
  const dir = ensureTlsDir(stateDir);
  const san = buildSan(hosts);

  const caKeyPath = path.join(dir, CA_KEY_FILE);
  const caCertPath = path.join(dir, CA_CERT_FILE);
  const serverKeyPath = path.join(dir, SERVER_KEY_FILE);
  const serverCertPath = path.join(dir, SERVER_CERT_FILE);

  // ---- 1) CA：优先复用，损坏/缺失才重建
  let caPem = readTextIfExists(caCertPath);
  let caKeyPem = readTextIfExists(caKeyPath);
  let caCert = caPem ? parseCertificate(caPem) : null;
  let caRegenerated = false;

  if (!caPem || !caKeyPem || !caCert || !isValidCa(caCert, caKeyPem)) {
    warn('info', '[dsh-camera] tls: generating local CA');
    generateCa(dir);
    caPem = readTextIfExists(caCertPath);
    caKeyPem = readTextIfExists(caKeyPath);
    caCert = caPem ? parseCertificate(caPem) : null;
    if (!caPem || !caKeyPem || !caCert) {
      throw new Error('[dsh-camera] failed to generate the local CA (certificate or key missing)');
    }
    caRegenerated = true;
  }

  const fingerprint = certificateFingerprint(caCert);
  if (!fingerprint) {
    throw new Error('[dsh-camera] failed to compute the CA SHA-256 fingerprint');
  }

  // ---- 2) meta：UUID / SAN / 指纹持久化（CA 重建也保留已有 UUID）
  const previousMeta = readMeta(dir);
  const caUUID = persistedUuid(previousMeta, 'caUUID');
  const profileUUID = persistedUuid(previousMeta, 'profileUUID');

  // ---- 3) server 证书：按需重签
  const serverKeyPem = readTextIfExists(serverKeyPath);
  const serverCertPem = readTextIfExists(serverCertPath);
  const serverCert = serverCertPem ? parseCertificate(serverCertPem) : null;

  let needsServer = caRegenerated || !serverKeyPem || !serverCert;
  if (!needsServer) {
    if (!isServerCertUsable(serverCert, serverKeyPem, caCert)) {
      needsServer = true; // 过期 / 不是当前 CA 签的 / 与私钥不配对
    } else if (!previousMeta) {
      needsServer = true; // 没有 meta 无法确认 SAN，重签一次最安全
    } else if (previousMeta.caFingerprint !== fingerprint) {
      needsServer = true;
    } else if (!sanEquals(previousMeta.hosts, san)) {
      needsServer = true; // hosts 变化 → 只重签 server 证书
    }
  }

  let generated = caRegenerated;
  if (needsServer) {
    warn('info', '[dsh-camera] tls: signing server certificate', san.join(','));
    signServerCert(dir, san);
    generated = true;
  } else {
    warn('debug', '[dsh-camera] tls: reusing existing certificate material');
  }

  // ---- 4) 读回最终材料（服务端要的是 Buffer；TLS 不接受字符串）
  let keyBuffer;
  try {
    keyBuffer = fs.readFileSync(serverKeyPath);
  } catch (err) {
    throw new Error(
      `[dsh-camera] failed to read server key: ${(err && err.message) || err}`,
    );
  }
  let certBuffer;
  try {
    certBuffer = fs.readFileSync(serverCertPath);
  } catch (err) {
    throw new Error(
      `[dsh-camera] failed to read server certificate: ${(err && err.message) || err}`,
    );
  }

  // ---- 5) meta 与 mobileconfig
  const generatedAt = generated
    ? new Date().toISOString()
    : typeof previousMeta.generatedAt === 'string'
      ? previousMeta.generatedAt
      : new Date().toISOString();

  writeMeta(dir, {
    hosts: san,
    caFingerprint: fingerprint,
    caUUID,
    profileUUID,
    generatedAt,
  });

  const mobileConfig = renderCaProfile({
    caPem,
    caUUID,
    profileUUID,
    displayName: CA_DISPLAY_NAME,
  });

  return {
    key: keyBuffer,
    cert: certBuffer,
    caPem,
    caPath: caCertPath,
    mobileConfig,
    san,
    generated,
    fingerprint,
  };
}

export default ensureTlsMaterial;
