// dsh-camera · 一次性拍照链接的 token 生命周期与持久化（DESIGN 3.3）
// 仅依赖 Node 内置模块；不 import 任何 @deepseek-ai/* 或第三方包。
//
// token 只存在内存 + 一个 JSON 落盘文件里（mode 0600），进程重启后仍然有效直至过期。
// 数据结构：{ version: 1, tokens: { [token]: entry }, recent: [...] }

import { randomBytes } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import path from 'node:path';

const MAX_RECENT = 50;
const MAX_TITLE_CHARS = 120;
const MAX_FILENAME_CHARS = 120;
const DEFAULT_TTL_MS = 2 * 60 * 60 * 1000;
const DEFAULT_MAX_TOKENS = 16;
const TOKEN_BYTES = 18; // base64url 后 24 个字符
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{16,64}$/;

/** 去掉控制字符、折叠空白并按「字符」（而不是 UTF-16 码元）截断。 */
function sanitizeText(value, maxChars) {
  if (typeof value !== 'string') return '';
  const cleaned = value
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return '';
  return Array.from(cleaned).slice(0, maxChars).join('');
}

/** 展示用文件名：去掉任何路径片段与控制字符，截断到 120 字符。 */
function sanitizeFilename(value) {
  if (typeof value !== 'string') return '';
  let name = value;
  const slash = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'));
  if (slash >= 0) name = name.slice(slash + 1);
  const cleaned = name.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  return Array.from(cleaned).slice(0, MAX_FILENAME_CHARS).join('');
}

function cloneEntry(entry) {
  return {
    token: entry.token,
    sessionId: entry.sessionId,
    title: entry.title,
    createdAt: entry.createdAt,
    expiresAt: entry.expiresAt,
    uploads: entry.uploads,
    lastUploadAt: entry.lastUploadAt,
  };
}

function toFiniteNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clampInt(value, fallback, min, max) {
  const n = Math.floor(toFiniteNumber(value, NaN));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export class TokenStore {
  #file;
  #ttlMs;
  #maxTokens;
  #now;
  #tokens; // Map<token, entry>
  #recent; // 最新在前

  /**
   * @param {{file?: string, ttlMs?: number, maxTokens?: number, now?: () => number}} [options]
   */
  constructor({ file, ttlMs, maxTokens = DEFAULT_MAX_TOKENS, now = Date.now } = {}) {
    this.#file = typeof file === 'string' && file.trim() ? file : null;
    const ttlCandidate = Math.floor(Number(ttlMs));
    this.#ttlMs =
      Number.isFinite(ttlCandidate) && ttlCandidate > 0 && ttlCandidate <= 365 * 24 * 60 * 60 * 1000
        ? ttlCandidate
        : DEFAULT_TTL_MS;
    const maxCandidate = Math.floor(Number(maxTokens));
    this.#maxTokens =
      Number.isFinite(maxCandidate) && maxCandidate >= 1
        ? Math.min(maxCandidate, 4096)
        : DEFAULT_MAX_TOKENS;
    this.#now = typeof now === 'function' ? now : Date.now;
    this.#tokens = new Map();
    this.#recent = [];
  }

  /** 读持久化文件；缺省/损坏/格式不符一律视为空，并顺带 prune 过期项。 */
  async load() {
    this.#tokens.clear();
    this.#recent = [];
    if (!this.#file) return this;
    try {
      const raw = await fsp.readFile(this.#file, 'utf8');
      this.#restore(JSON.parse(raw));
    } catch (err) {
      if (err && err.code !== 'ENOENT') {
        console.error(
          '[dsh-camera] token store load failed, starting empty:',
          err && err.message ? err.message : err,
        );
      }
    }
    this.#prune();
    return this;
  }

  /**
   * 同一 session 有未过期 token 则复用（取最新创建的那个，保证 rotate 之后
   * 再打开面板拿到的是新链接）；否则新建。返回 entry 快照。
   */
  arm({ sessionId, title } = {}) {
    if (typeof sessionId !== 'string' || !sessionId) {
      throw new TypeError('TokenStore.arm: sessionId is required');
    }
    const now = this.#now();
    this.#prune(now);
    let reusable = null;
    for (const entry of this.#tokens.values()) {
      if (entry.sessionId !== sessionId || !(entry.expiresAt > now)) continue;
      if (!reusable || entry.createdAt >= reusable.createdAt) reusable = entry;
    }
    if (reusable) return cloneEntry(reusable);
    return this.#create(sessionId, title, now);
  }

  /** 强制新建 token；旧 token 保留至过期/被 disarm（DESIGN 3.3）。 */
  armNew({ sessionId, title } = {}) {
    if (typeof sessionId !== 'string' || !sessionId) {
      throw new TypeError('TokenStore.armNew: sessionId is required');
    }
    return this.#create(sessionId, title, this.#now());
  }

  /** 查 token；未知/格式不对/过期 → null，并 prune 过期项。 */
  get(token) {
    if (typeof token !== 'string' || !token) return null;
    const now = this.#now();
    this.#prune(now);
    const entry = this.#tokens.get(token);
    return entry ? cloneEntry(entry) : null;
  }

  /** 撤销 token（上传面板关闭/换链接时）；返回是否确实删除了一个 token。 */
  disarm(token) {
    if (typeof token !== 'string' || !token) return false;
    return this.#tokens.delete(token);
  }

  /** 记录一次上传（ok=false 也记录，面板可显示失败）；返回更新后的 entry 快照。 */
  recordUpload(token, info = {}) {
    if (typeof token !== 'string' || !token) return null;
    const now = this.#now();
    this.#prune(now);
    const entry = this.#tokens.get(token);
    if (!entry) return null;
    entry.uploads += 1;
    entry.lastUploadAt = now;
    this.#recent.unshift({
      token: entry.token,
      sessionId: entry.sessionId,
      title: entry.title,
      at: now,
      filename: sanitizeFilename(info && info.filename),
      ok: Boolean(info && info.ok),
      // One upload request may carry several photos (a multi-select batch);
      // `count` lets the desktop panel report "N photos", not "N requests".
      count: clampInt(info && info.count, 1, 1, 20),
    });
    if (this.#recent.length > MAX_RECENT) this.#recent.length = MAX_RECENT;
    return cloneEntry(entry);
  }

  /** 最近上传记录，最新在前。 */
  recent(limit = 10) {
    const n = clampInt(limit, 10, 0, MAX_RECENT);
    return this.#recent.slice(0, n).map((item) => ({ ...item }));
  }

  /** 清理已过期 token（公开方法；index.js 会在读取状态前调用）。 */
  prune() {
    this.#prune();
    return this;
  }

  /** 当前未过期 token 数量。 */
  status() {
    this.#prune();
    return { tokens: this.#tokens.size };
  }

  /** 原子写（temp + rename，mode 0600）；失败只 log，不抛错。 */
  async flush() {
    if (!this.#file) return;
    const now = this.#now();
    this.#prune(now);
    const payload = {
      version: 1,
      tokens: {},
      recent: this.#recent.slice(0, MAX_RECENT),
    };
    for (const [token, entry] of this.#tokens) {
      payload.tokens[token] = {
        token: entry.token,
        sessionId: entry.sessionId,
        title: entry.title,
        createdAt: entry.createdAt,
        expiresAt: entry.expiresAt,
        uploads: entry.uploads,
        lastUploadAt: entry.lastUploadAt,
      };
    }

    const dir = path.dirname(this.#file);
    const tmp = path.join(
      dir,
      `.${path.basename(this.#file)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`,
    );
    try {
      await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
      await fsp.writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      });
      await fsp.chmod(tmp, 0o600).catch(() => {});
      await fsp.rename(tmp, this.#file);
      await fsp.chmod(this.#file, 0o600).catch(() => {});
    } catch (err) {
      try {
        await fsp.unlink(tmp);
      } catch {
        // ignore
      }
      console.error(
        '[dsh-camera] token store flush failed:',
        err && err.message ? err.message : err,
      );
    }
  }

  // ---------------------------------------------------------------- internal

  #prune(now = this.#now()) {
    for (const [token, entry] of this.#tokens) {
      if (!(entry.expiresAt > now)) this.#tokens.delete(token);
    }
  }

  #create(sessionId, title, now) {
    this.#prune(now);
    // 容量上限：先清过期，仍满则淘汰 createdAt 最早的 token。
    while (this.#tokens.size >= this.#maxTokens) {
      let oldestToken = null;
      let oldestCreatedAt = Infinity;
      for (const [token, entry] of this.#tokens) {
        if (entry.createdAt < oldestCreatedAt) {
          oldestCreatedAt = entry.createdAt;
          oldestToken = token;
        }
      }
      if (oldestToken === null) break;
      this.#tokens.delete(oldestToken);
    }

    let token = randomBytes(TOKEN_BYTES).toString('base64url');
    while (this.#tokens.has(token)) {
      token = randomBytes(TOKEN_BYTES).toString('base64url');
    }
    const entry = {
      token,
      sessionId,
      title: sanitizeText(title, MAX_TITLE_CHARS),
      createdAt: now,
      expiresAt: now + this.#ttlMs,
      uploads: 0,
      lastUploadAt: null,
    };
    this.#tokens.set(token, entry);
    return cloneEntry(entry);
  }

  #restore(data) {
    if (!data || typeof data !== 'object') return;
    const tokens = data.tokens && typeof data.tokens === 'object' ? data.tokens : {};
    for (const [token, raw] of Object.entries(tokens)) {
      if (typeof token !== 'string' || !TOKEN_SHAPE.test(token)) continue;
      if (!raw || typeof raw !== 'object') continue;
      if (typeof raw.sessionId !== 'string' || !raw.sessionId) continue;
      const createdAt = toFiniteNumber(raw.createdAt, NaN);
      const expiresAt = toFiniteNumber(raw.expiresAt, NaN);
      if (!Number.isFinite(createdAt) || !Number.isFinite(expiresAt)) continue;
      this.#tokens.set(token, {
        token,
        sessionId: raw.sessionId,
        title: sanitizeText(raw.title, MAX_TITLE_CHARS),
        createdAt,
        expiresAt,
        uploads: Math.max(0, Math.floor(toFiniteNumber(raw.uploads, 0))),
        lastUploadAt: Number.isFinite(toFiniteNumber(raw.lastUploadAt, NaN))
          ? toFiniteNumber(raw.lastUploadAt, null)
          : null,
      });
    }
    const recent = Array.isArray(data.recent) ? data.recent : [];
    this.#recent = recent
      .filter((item) => item && typeof item === 'object' && typeof item.token === 'string')
      .slice(0, MAX_RECENT)
      .map((item) => ({
        token: item.token,
        sessionId: typeof item.sessionId === 'string' ? item.sessionId : '',
        title: sanitizeText(item.title, MAX_TITLE_CHARS),
        at: toFiniteNumber(item.at, 0),
        filename: sanitizeFilename(item.filename),
        ok: Boolean(item.ok),
      }));
  }
}

export default TokenStore;
