// 最小 PNG 编码器（只用 node:zlib），用于 E2E 生成测试图片，不依赖 sharp/canvas。
//
// 生成的图片可被浏览器 <img>/createImageBitmap/canvas 正常解码，因此既能走
// 「原样上传」路径（<1.5 MiB 且长边 <= 2400），也能用 makeNoisePng 生成大文件
// 触发手机页的 canvas 压缩路径。
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/**
 * 把 RGBA 像素编码成 PNG。
 * @param {number} width
 * @param {number} height
 * @param {Buffer} rgba 长度必须为 width*height*4
 * @returns {Buffer}
 */
export function encodePng(width, height, rgba) {
  if (!Number.isInteger(width) || width <= 0) throw new Error(`bad width: ${width}`);
  if (!Number.isInteger(height) || height <= 0) throw new Error(`bad height: ${height}`);
  if (rgba.length !== width * height * 4) {
    throw new Error(`rgba length ${rgba.length} != ${width * height * 4}`);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter type 0 (None)
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const idat = zlib.deflateSync(raw, { level: 6 });
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function clampByte(v) {
  return v < 0 ? 0 : v > 255 ? 255 : v | 0;
}

/**
 * 生成可辨识的测试图案：彩虹渐变 + 对角条纹 + 角标色块。
 * 尺寸默认 800x600，编码后远小于手机页 1.5 MiB 阈值，会走「原样上传」。
 * @returns {Buffer} PNG bytes
 */
export function makePatternPng({ width = 800, height = 600, variant = 0 } = {}) {
  const rgba = Buffer.alloc(width * height * 4);
  const hues = [
    [244, 63, 94],
    [249, 115, 22],
    [234, 179, 8],
    [34, 197, 94],
    [14, 165, 233],
    [139, 92, 246],
  ];
  const base = hues[variant % hues.length];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const t = (x / width + y / height) / 2;
      const band = (x + y + variant * 40) % 96 < 48 ? 1 : 0.55;
      rgba[i] = clampByte((base[0] * (0.35 + 0.65 * t)) * band);
      rgba[i + 1] = clampByte((base[1] * (0.35 + 0.65 * t)) * band);
      rgba[i + 2] = clampByte((base[2] * (0.35 + 0.65 * t)) * band);
      rgba[i + 3] = 255;
    }
  }
  // 四个角标色块，方便截图里肉眼确认是哪张测试图。
  const marks = [
    [0, 0, 255, 255],
    [0, 255, 255, 255],
    [255, 0, 255, 255],
    [255, 255, 0, 255],
  ];
  const markSize = Math.max(8, Math.round(Math.min(width, height) * 0.06));
  for (let m = 0; m < 4; m++) {
    const ox = m % 2 === 0 ? 0 : width - markSize;
    const oy = m < 2 ? 0 : height - markSize;
    for (let y = oy; y < oy + markSize; y++) {
      for (let x = ox; x < ox + markSize; x++) {
        const i = (y * width + x) * 4;
        rgba[i] = marks[m][0];
        rgba[i + 1] = marks[m][1];
        rgba[i + 2] = marks[m][2];
        rgba[i + 3] = marks[m][3];
      }
    }
  }
  return encodePng(width, height, rgba);
}

/**
 * 生成高熵噪声 PNG（几乎不可压缩），用于触发手机页压缩路径。
 * 默认 1600x1200 编码后 > 1.5 MiB 且长边 <= 2400。
 * @returns {Buffer}
 */
export function makeNoisePng({ width = 1600, height = 1200, seed = 1 } = {}) {
  const rgba = Buffer.alloc(width * height * 4);
  // xorshift32，固定 seed 保证可复现
  let s = seed >>> 0 || 1;
  for (let i = 0; i < width * height; i++) {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    const o = i * 4;
    rgba[o] = s & 0xff;
    rgba[o + 1] = (s >>> 8) & 0xff;
    rgba[o + 2] = (s >>> 16) & 0xff;
    rgba[o + 3] = 255;
  }
  return encodePng(width, height, rgba);
}

export function writePng(file, buf) {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(file, buf);
  return file;
}

/** 生成标准 E2E 测试图集合，返回路径列表。 */
export function writeTestImages(dir, { count = 1, noise = false } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const files = [];
  for (let i = 0; i < count; i++) {
    const file = path.join(dir, `cam-test-${i + 1}.png`);
    writePng(file, makePatternPng({ variant: i }));
    files.push(file);
  }
  if (noise) {
    const file = path.join(dir, 'cam-test-noise.png');
    writePng(file, makeNoisePng());
    files.push(file);
  }
  return files;
}

// CLI: node scripts/lib/png.mjs <outdir> [count]
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outdir = process.argv[2] || '/tmp/cam-test-images';
  const count = Number(process.argv[3] || 2);
  const files = writeTestImages(outdir, { count, noise: true });
  for (const f of files) {
    const st = fs.statSync(f);
    console.log(`${f}  ${st.size} bytes`);
  }
}
