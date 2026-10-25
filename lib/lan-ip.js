// dsh-camera · 局域网 IPv4 探测（DESIGN 3.2）
// 仅依赖 Node 内置模块；不 import 任何 @deepseek-ai/* 或第三方包。

import os from 'node:os';
import { execFileSync } from 'node:child_process';

// 严格点分十进制 IPv4（不允许前导零，避免把 010.0.0.1 解析成奇怪的地址）。
const IPV4_RE =
  /^(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]\d|[0-9])(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]\d|[0-9])){3}$/;

const SCORE_192_168 = 0; // 家用路由器最常见
const SCORE_10 = 1; // 企业/校园网
const SCORE_172 = 2; // Docker / VPN 较多，优先级最低

// /30、/31、/32 常出现在 USB 共享网络、点对点隧道、容器网桥上：
// 这类地址手机通常不可达，排序时降权，但保留作为兜底候选。
const NARROW_NETMASKS = new Set(['255.255.255.252', '255.255.255.254', '255.255.255.255']);

/** @param {string} value */
function parseIPv4(value) {
  if (typeof value !== 'string') return null;
  const address = value.trim();
  if (!IPV4_RE.test(address)) return null;
  const octets = address.split('.').map(Number);
  if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return null;
  }
  return octets;
}

/** 只接受 RFC1918 私网段；返回排序权重，非私网返回 -1。 */
function privateScore(octets) {
  const [a, b] = octets;
  if (a === 192 && b === 168) return SCORE_192_168;
  if (a === 10) return SCORE_10;
  if (a === 172 && b >= 16 && b <= 31) return SCORE_172;
  return -1;
}

let cachedDefaultRoute = { at: 0, ip: null };

/**
 * 探测默认路由所在的源 IPv4（手机通常与电脑在同一个默认路由网段）。
 * 仅支持 Linux 的 `ip` 命令；其他平台/失败时返回 null，纯靠网卡排序兜底。
 * @returns {string | null} 默认路由源地址
 */
export function detectDefaultRouteIp() {
  const now = Date.now();
  if (now - cachedDefaultRoute.at < 10_000) return cachedDefaultRoute.ip;
  let ip = null;
  try {
    const out = execFileSync('ip', ['-4', 'route', 'show', 'default'], {
      encoding: 'utf8',
      timeout: 1500,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const src = out.match(/\bsrc\s+(\d{1,3}(?:\.\d{1,3}){3})/);
    if (src && parseIPv4(src[1])) ip = src[1];
  } catch {
    ip = null;
  }
  cachedDefaultRoute = { at: now, ip };
  return ip;
}

function compareAddress(a, b) {
  const ao = a.split('.').map(Number);
  const bo = b.split('.').map(Number);
  for (let i = 0; i < 4; i += 1) {
    if (ao[i] !== bo[i]) return ao[i] - bo[i];
  }
  return 0;
}

/**
 * 列出可用的局域网候选地址（已按推荐程度排序）。
 * @param {() => Record<string, Array<{address: string, family: string|number, internal: boolean, netmask?: string}>>} [interfacesFn]
 * @param {() => (string | null)} [defaultRouteFn] - 默认路由源地址探测（测试注入；默认不探测）
 * @returns {Array<{address: string, iface: string, score: number, defaultRoute: boolean, narrow: boolean}>}
 */
export function lanCandidates(interfacesFn = os.networkInterfaces, defaultRouteFn = () => null) {
  let interfaces;
  try {
    interfaces = typeof interfacesFn === 'function' ? interfacesFn() : interfacesFn;
  } catch {
    return [];
  }
  if (!interfaces || typeof interfaces !== 'object') return [];

  /** @type {Array<{address: string, iface: string, score: number}>} */
  const candidates = [];
  for (const iface of Object.keys(interfaces)) {
    const entries = interfaces[iface];
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object') continue;
      if (entry.internal === true) continue; // loopback
      if (entry.family !== 'IPv4' && entry.family !== 4) continue;
      const octets = parseIPv4(entry.address);
      if (!octets) continue;
      const score = privateScore(octets);
      if (score < 0) continue; // 公网 / link-local 169.254 / CGNAT 100.64 等一律过滤
      const netmask = typeof entry.netmask === 'string' ? entry.netmask : '';
      candidates.push({
        address: entry.address.trim(),
        iface,
        score,
        defaultRoute: false,
        narrow: NARROW_NETMASKS.has(netmask),
      });
    }
  }

  // 默认路由所在网段优先：同一 Wi-Fi 下手机一定能路由到它；
  // 其次排除 /30 等点对点窄网段；最后沿用私网段偏好。
  let defaultRouteIp = null;
  try {
    defaultRouteIp = typeof defaultRouteFn === 'function' ? defaultRouteFn() : null;
  } catch {
    defaultRouteIp = null;
  }
  if (typeof defaultRouteIp === 'string') {
    for (const candidate of candidates) {
      if (candidate.address === defaultRouteIp || candidate.iface === defaultRouteIp) {
        candidate.defaultRoute = true;
      }
    }
  }
  candidates.sort(
    (a, b) =>
      Number(b.defaultRoute) - Number(a.defaultRoute) ||
      Number(a.narrow) - Number(b.narrow) ||
      a.score - b.score ||
      compareAddress(a.address, b.address) ||
      (a.iface < b.iface ? -1 : a.iface > b.iface ? 1 : 0),
  );

  // 同一地址可能挂在多个虚拟网卡上（docker0 / br-xxx），去重保留优先级最高的一条。
  const seen = new Set();
  const unique = [];
  for (const candidate of candidates) {
    if (seen.has(candidate.address)) continue;
    seen.add(candidate.address);
    unique.push(candidate);
  }
  return unique;
}

/**
 * 选出用于生成手机访问链接的局域网 IP。
 * @param {string} [override] 用户在 config 里手动指定的 IPv4；合法则直接使用
 * @param {() => Record<string, unknown>} [interfacesFn] 便于单测注入
 * @param {() => (string | null)} [defaultRouteFn] 默认路由探测（测试注入）
 * @returns {string | null}
 */
export function pickLanIp(
  override,
  interfacesFn = os.networkInterfaces,
  defaultRouteFn = detectDefaultRouteIp,
) {
  if (typeof override === 'string') {
    const value = override.trim();
    if (value && parseIPv4(value)) return value;
  }
  const candidates = lanCandidates(interfacesFn, defaultRouteFn);
  return candidates.length > 0 ? candidates[0].address : null;
}
