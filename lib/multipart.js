// dsh-camera · multipart/form-data 解析 + 图片魔数嗅探（DESIGN 3.4）
// 仅依赖 Node 内置模块；不 import 任何 @deepseek-ai/* 或第三方包。
//
// 设计取舍：请求体在内存里聚合后一次性解析（上限由 maxBytes 约束，默认 24 MiB）。
// 读取过程是流式计数的：一旦超过 maxBytes 立刻停止缓冲并 drain 请求，避免内存放大。
// 不落盘、不信任任何 filename 路径；字段名/文件名只做展示用清洗。

const DEFAULT_MAX_BYTES = 24 * 1024 * 1024;
const DEFAULT_MAX_FILES = 6;
const MAX_HEADER_BYTES = 16 * 1024;
const MAX_PARTS = 128;
const MAX_NAME_CHARS = 80;

const CRLF = Buffer.from('\r\n', 'latin1');
const HEADER_END = Buffer.from('\r\n\r\n', 'latin1');

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** 可被 plugin 后处理/上传的图片类型。 */
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

/** 可被当作文件附件接收的视频类型（不转码，原样保存）。 */
const VIDEO_TYPES = new Set([
  'video/mp4',
  'video/quicktime',
  'video/webm',
  'video/x-m4v',
  'video/3gpp',
]);

function makeError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function badRequest(message) {
  return makeError('bad-request', message);
}

function tooLarge(message) {
  return makeError('too-large', message);
}

/**
 * 通过文件头判断图片类型；不是受支持图片则返回 null。
 * @param {Buffer} buf
 * @returns {'image/jpeg'|'image/png'|'image/webp'|'image/gif'|null}
 */
export function sniffImageType(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 3) return null;
  if (buf.length >= 8 && buf.subarray(0, 8).equals(PNG_SIGNATURE)) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 6) {
    const head = buf.toString('latin1', 0, 6);
    if (head === 'GIF87a' || head === 'GIF89a') return 'image/gif';
  }
  if (
    buf.length >= 12 &&
    buf.toString('latin1', 0, 4) === 'RIFF' &&
    buf.toString('latin1', 8, 12) === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

/**
 * 通过文件头判断视频容器类型；不是可识别视频则返回 null。
 * 支持：MP4/MOV/M4V（ISO BMFF ftyp）、WebM/Matroska（EBML）、3GP（ftyp 品牌）。
 * @param {Buffer} buf
 * @returns {'video/mp4'|'video/quicktime'|'video/webm'|'video/x-m4v'|'video/3gpp'|null}
 */
export function sniffVideoType(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  // ISO BMFF: 4-byte size + 'ftyp' + major brand
  if (buf.toString('latin1', 4, 8) === 'ftyp') {
    const brand = buf.toString('latin1', 8, 12);
    if (brand === 'qt  ') return 'video/quicktime';
    if (brand === 'M4V ' || brand === 'M4VH' || brand === 'M4VP') return 'video/x-m4v';
    if (brand.startsWith('3gp') || brand.startsWith('3g2')) return 'video/3gpp';
    // isom/iso2/mp41/mp42/avc1/dash/MSNV 等都按 mp4 处理
    return 'video/mp4';
  }
  // EBML/Matroska
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return 'video/webm';
  return null;
}

/**
 * 把上传文件归类为 image/video（按魔数，不信任 Content-Type）。
 * @param {Buffer} buf
 * @returns {{ kind: 'image'|'video', mediaType: string } | null}
 */
export function sniffMedia(buf) {
  const image = sniffImageType(buf);
  if (image !== null) return { kind: 'image', mediaType: image };
  const video = sniffVideoType(buf);
  if (video !== null) return { kind: 'video', mediaType: video };
  return null;
}

function headerValue(req, name) {
  const headers = req && req.headers ? req.headers : {};
  const value = headers[name];
  if (Array.isArray(value)) return value.length > 0 ? String(value[0]) : '';
  return value === undefined || value === null ? '' : String(value);
}

/** 主动丢弃请求体（保证能安全地写回 4xx 响应）。 */
function drain(req) {
  try {
    if (req && typeof req.on === 'function') req.on('error', () => {});
    if (req && typeof req.resume === 'function') req.resume();
  } catch {
    // ignore
  }
}

/**
 * 流式读取请求体，超过 maxBytes 立即中断（不继续缓冲）并 reject {code:'too-large'}。
 * @param {import('node:http').IncomingMessage} req
 * @param {number} maxBytes
 * @returns {Promise<Buffer>}
 */
function readBody(req, maxBytes) {
  if (!req || typeof req.on !== 'function') {
    return Promise.reject(badRequest('missing request stream'));
  }
  const declared = Number(headerValue(req, 'content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    drain(req);
    return Promise.reject(tooLarge(`request body exceeds limit of ${maxBytes} bytes`));
  }

  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;

    const listeners = [
      ['data', onData],
      ['end', onEnd],
      ['error', onError],
      ['aborted', onAborted],
    ];

    function cleanup() {
      for (const [event, listener] of listeners) {
        if (typeof req.off === 'function') req.off(event, listener);
        else if (typeof req.removeListener === 'function') req.removeListener(event, listener);
      }
    }

    function settleError(err) {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    }

    function onData(chunk) {
      if (settled) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buf.length;
      if (total > maxBytes) {
        chunks.length = 0; // 释放已经缓冲的部分
        settleError(tooLarge(`request body exceeds limit of ${maxBytes} bytes`));
        drain(req); // 继续丢弃剩余数据，让 server 能干净地写回 413
        return;
      }
      chunks.push(buf);
    }

    function onEnd() {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(Buffer.concat(chunks, total));
    }

    function onError(err) {
      settleError(err || badRequest('request stream error'));
    }

    function onAborted() {
      settleError(badRequest('request aborted by client'));
    }

    for (const [event, listener] of listeners) req.on(event, listener);
  });
}

function stripControl(value) {
  return String(value).replace(/[\u0000-\u001f\u007f]+/g, '');
}

/** 字段名清洗：去控制字符、截断 80 字符。 */
function sanitizeFieldName(value) {
  if (typeof value !== 'string') return '';
  const cleaned = stripControl(value).trim();
  if (!cleaned) return '';
  return Array.from(cleaned).slice(0, MAX_NAME_CHARS).join('');
}

/** 文件名清洗：去路径、去控制字符、截断 80 字符；空则返回 ''。 */
function sanitizeFilename(value) {
  if (typeof value !== 'string') return '';
  let name = value;
  const slash = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'));
  if (slash >= 0) name = name.slice(slash + 1);
  const cleaned = stripControl(name).trim();
  if (!cleaned || cleaned === '.' || cleaned === '..') return '';
  return Array.from(cleaned).slice(0, MAX_NAME_CHARS).join('');
}

function parseBoundary(contentType) {
  const match = /boundary\s*=\s*(?:"([^"]+)"|([^;\s]+))/i.exec(String(contentType || ''));
  if (!match) return null;
  const boundary = (match[1] !== undefined ? match[1] : match[2] || '').trim();
  if (!boundary || boundary.length > 200) return null;
  if (/[\u0000-\u001f\u007f]/.test(boundary)) return null;
  return boundary;
}

function parsePartHeaders(raw) {
  const headers = Object.create(null);
  let last = null;
  for (const line of raw.split('\r\n')) {
    if (!line) continue;
    if ((line.startsWith(' ') || line.startsWith('\t')) && last) {
      headers[last] += ` ${line.trim()}`;
      continue;
    }
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    if (!name) continue;
    headers[name] = line.slice(colon + 1).trim();
    last = name;
  }
  return headers;
}

function unquote(value) {
  return String(value).replace(/\\(.)/g, '$1');
}

/** RFC 5987 `filename*=UTF-8''%E4%B8%AD.png` 解码；不合法返回 null。 */
function decodeExtendedValue(value) {
  const match = /^[^']*'[^']*'(.*)$/.exec(String(value || '').trim());
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

/** 从 Content-Disposition 里取参数（支持 filename*= 扩展形式）。 */
function dispositionParam(header, key) {
  if (typeof header !== 'string' || !header) return null;
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  const starRe = new RegExp(`(?:^|;)\\s*${escapedKey}\\*\\s*=\\s*("([^"]*)"|[^;]+)`, 'i');
  const star = starRe.exec(header);
  if (star) {
    const raw = star[2] !== undefined ? star[2] : String(star[1]).trim();
    const decoded = decodeExtendedValue(raw);
    if (decoded !== null) return decoded;
  }

  const quotedRe = new RegExp(
    `(?:^|;)\\s*${escapedKey}\\s*=\\s*"((?:[^"\\\\]|\\\\.)*)"`,
    'i',
  );
  const quoted = quotedRe.exec(header);
  if (quoted) return unquote(quoted[1]);

  const plainRe = new RegExp(`(?:^|;)\\s*${escapedKey}\\s*=\\s*([^;\\s]+)`, 'i');
  const plain = plainRe.exec(header);
  return plain ? plain[1] : null;
}

function partMediaType(headers) {
  const raw = headers['content-type'];
  if (typeof raw !== 'string' || !raw.trim()) return 'application/octet-stream';
  const mediaType = raw.split(';')[0].trim().toLowerCase();
  return mediaType || 'application/octet-stream';
}

/**
 * 解析 multipart body。整个请求已经缓冲在 body 里。
 * @returns {{fields: Record<string,string>, files: Array<{fieldName: string, filename: string, mediaType: string, data: Buffer}>}}
 */
function parseMultipartBody(body, boundary, maxFiles) {
  const delimiter = Buffer.from(`--${boundary}`, 'latin1');
  const partDelimiter = Buffer.concat([CRLF, delimiter]);

  const first = body.indexOf(delimiter);
  if (first === -1) throw badRequest('multipart boundary not found in body');

  const fields = {};
  const files = [];
  let pos = first + delimiter.length;
  let parts = 0;
  let finished = false;

  while (!finished) {
    // 开边界之后要么直接是结束标记 "--"，要么是（可能有 transport padding 的）CRLF。
    if (body[pos] === 0x2d && body[pos + 1] === 0x2d) break;
    while (body[pos] === 0x20 || body[pos] === 0x09) pos += 1;
    if (body[pos] !== 0x0d || body[pos + 1] !== 0x0a) {
      throw badRequest('malformed multipart boundary delimiter');
    }
    pos += 2;

    const headerEnd = body.indexOf(HEADER_END, pos);
    if (headerEnd === -1) throw badRequest('malformed multipart part headers');
    if (headerEnd - pos > MAX_HEADER_BYTES) throw badRequest('multipart part headers too large');

    const headers = parsePartHeaders(body.toString('utf8', pos, headerEnd));
    const contentStart = headerEnd + HEADER_END.length;
    const nextDelimiter = body.indexOf(partDelimiter, contentStart);
    if (nextDelimiter === -1) throw badRequest('unterminated multipart part');
    const data = body.subarray(contentStart, nextDelimiter);

    parts += 1;
    if (parts > MAX_PARTS) throw badRequest('too many multipart parts');

    const disposition = headers['content-disposition'] || '';
    const fieldName = sanitizeFieldName(dispositionParam(disposition, 'name'));
    const rawFilename = dispositionParam(disposition, 'filename');

    if (rawFilename !== null) {
      if (files.length >= maxFiles) {
        throw badRequest(`too many files in one upload (max ${maxFiles})`);
      }
      files.push({
        fieldName: fieldName || 'photo',
        filename: sanitizeFilename(rawFilename) || 'photo.jpg',
        mediaType: partMediaType(headers),
        data,
      });
    } else if (fieldName) {
      fields[fieldName] = data.toString('utf8');
    }

    pos = nextDelimiter + CRLF.length + delimiter.length;
    if (body[pos] === 0x2d && body[pos + 1] === 0x2d) finished = true;
  }

  return { fields, files };
}

/** raw image/* 或 application/octet-stream 单文件请求。 */
async function readRawFile(req, contentType, maxBytes) {
  const data = await readBody(req, maxBytes);
  if (data.length === 0) throw badRequest('empty request body');

  const declaredType = String(contentType || '').split(';')[0].trim().toLowerCase();
  const sniffed = sniffImageType(data);
  const mediaType = declaredType.startsWith('image/')
    ? declaredType
    : sniffed || 'application/octet-stream';

  let filename = 'photo.jpg';
  const rawName = headerValue(req, 'x-filename');
  if (rawName) {
    let decoded = rawName;
    try {
      decoded = decodeURIComponent(rawName);
    } catch {
      decoded = rawName;
    }
    filename = sanitizeFilename(decoded) || 'photo.jpg';
  }

  return { fieldName: 'photo', filename, mediaType, data };
}

/**
 * 读取并解析一次上传请求。
 * @param {import('node:http').IncomingMessage} req
 * @param {{maxBytes?: number, maxFiles?: number}} [options]
 * @returns {Promise<{fields: Record<string,string>, files: Array<{fieldName: string, filename: string, mediaType: string, data: Buffer}>}>}
 */
export async function readMultipart(req, options = {}) {
  const maxBytes =
    Number.isFinite(Number(options.maxBytes)) && Number(options.maxBytes) > 0
      ? Math.floor(Number(options.maxBytes))
      : DEFAULT_MAX_BYTES;
  const maxFiles =
    Number.isFinite(Number(options.maxFiles)) && Number(options.maxFiles) > 0
      ? Math.floor(Number(options.maxFiles))
      : DEFAULT_MAX_FILES;

  const contentType = headerValue(req, 'content-type');
  const lower = contentType.toLowerCase();
  if (!lower) {
    drain(req);
    throw badRequest('missing content-type');
  }

  if (lower.startsWith('multipart/form-data')) {
    const boundary = parseBoundary(contentType);
    if (!boundary) {
      drain(req);
      throw badRequest('missing or invalid multipart boundary');
    }
    const body = await readBody(req, maxBytes);
    if (body.length === 0) throw badRequest('empty request body');
    return parseMultipartBody(body, boundary, maxFiles);
  }

  if (lower.startsWith('image/') || lower.startsWith('application/octet-stream')) {
    return { fields: {}, files: [await readRawFile(req, contentType, maxBytes)] };
  }

  drain(req);
  throw badRequest(`unsupported content-type: ${contentType.split(';')[0].trim()}`);
}

/** 供 server 侧复用的图片类型集合。 */
export const SUPPORTED_IMAGE_TYPES = IMAGE_TYPES;
export const SUPPORTED_VIDEO_TYPES = VIDEO_TYPES;
