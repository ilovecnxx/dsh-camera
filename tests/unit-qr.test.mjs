// unit-qr：验证 lib/qr.js 的 renderQrPath() 输出能被真实二维码解码器（jsqr）还原。
//
// jsqr 是可选依赖：临时装在 /tmp/cam-test-deps（或 /tmp/node_modules），
// 缺失时解码类用例 skip，几何/契约类用例仍照常运行。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { renderQrPath } from '../lib/qr.js';

const require = createRequire(import.meta.url);

function loadJsqr() {
  const candidates = [
    '/tmp/cam-test-deps/node_modules/jsqr',
    '/tmp/node_modules/jsqr',
    path.resolve(import.meta.dirname, '../node_modules/jsqr'),
  ];
  for (const candidate of candidates) {
    try {
      const loaded = require(candidate);
      const fn = loaded?.default ?? loaded;
      if (typeof fn === 'function') return fn;
    } catch {
      /* try next */
    }
  }
  return null;
}

const jsQR = loadJsqr();
const skipDecode = jsQR === null ? 'jsqr 未安装（/tmp/cam-test-deps/node_modules/jsqr）' : false;

/**
 * 解析本仓库 renderQrPath 生成的单行 path（M x y h w v1 h-w z），
 * 栅格化成 size×size 的模块矩阵。同时支持 H/V/L/l/m 以容忍实现微调。
 * @param {string} d SVG path 数据
 * @param {number} size viewBox 边长（含 quiet zone）
 * @returns {boolean[][]} [row][col] === true 表示深色模块
 */
export function rasterizeQrPath(d, size) {
  const grid = Array.from({ length: size }, () => new Array(size).fill(false));
  const tokens = d.match(/[A-Za-z]|-?\d+(?:\.\d+)?/g) ?? [];
  const fillRow = (y, x1, x2) => {
    if (!Number.isInteger(y)) throw new Error(`non-integer row in QR path: ${y}`);
    const from = Math.min(x1, x2);
    const to = Math.max(x1, x2);
    for (let x = from; x < to; x++) {
      if (y < 0 || y >= size || x < 0 || x >= size) throw new Error(`QR path out of bounds: ${x},${y}`);
      grid[y][x] = true;
    }
  };
  const fillCol = (x, y1, y2) => {
    if (!Number.isInteger(x)) throw new Error(`non-integer col in QR path: ${x}`);
    const from = Math.min(y1, y2);
    const to = Math.max(y1, y2);
    for (let y = from; y < to; y++) {
      if (y < 0 || y >= size || x < 0 || x >= size) throw new Error(`QR path out of bounds: ${x},${y}`);
      grid[y][x] = true;
    }
  };
  let i = 0;
  let x = 0;
  let y = 0;
  let cmd = '';
  // renderQrPath 的每个深色模块区段是「高 1 的矩形」：M x y h w v1 h-w z。
  // 其中第一段 h 是上边（要填充），v 之后的 h 是回程下边（不填充）。
  let lastVerb = '';
  const num = () => {
    const value = Number(tokens[i++]);
    if (!Number.isFinite(value)) throw new Error(`bad number in QR path at token ${i - 1}`);
    return value;
  };
  while (i < tokens.length) {
    const token = tokens[i];
    if (/[A-Za-z]/.test(token)) {
      cmd = token;
      i += 1;
      continue;
    }
    switch (cmd) {
      case 'M': {
        x = num();
        y = num();
        cmd = 'L';
        lastVerb = 'M';
        break;
      }
      case 'm': {
        x += num();
        y += num();
        cmd = 'l';
        break;
      }
      case 'h': {
        const width = num();
        if (lastVerb !== 'v' && lastVerb !== 'V') fillRow(y, x, x + width);
        x += width;
        lastVerb = 'h';
        break;
      }
      case 'H': {
        const nx = num();
        if (lastVerb !== 'v' && lastVerb !== 'V') fillRow(y, x, nx);
        x = nx;
        lastVerb = 'H';
        break;
      }
      // renderQrPath 每段是「高 1 模块的水平条」：M x y h w v1 h-w z。
      // 填充只由水平边决定（v 只是矩形高度，垂直边不构成模块面积）。
      case 'v': {
        y += num();
        lastVerb = 'v';
        break;
      }
      case 'V': {
        y = num();
        lastVerb = 'V';
        break;
      }
      case 'l':
      case 'L': {
        const nx = cmd === 'l' ? x + num() : num();
        const ny = cmd === 'l' ? y + num() : num();
        if (ny === y) {
          if (lastVerb !== 'v' && lastVerb !== 'V') fillRow(y, x, nx);
        } else if (nx === x) {
          // 垂直边：不填充（见上），仅移动
        } else throw new Error(`diagonal line in QR path: ${cmd} ${nx} ${ny}`);
        x = nx;
        y = ny;
        lastVerb = cmd;
        break;
      }
      case 'z':
      case 'Z':
        lastVerb = 'z';
        break;
      default:
        throw new Error(`unsupported QR path command "${cmd}"`);
    }
  }
  return grid;
}

/**
 * 把模块矩阵渲染成 RGBA 像素（scale px/模块），交给 jsqr 解码。
 * @param {boolean[][]} grid
 * @param {number} scale
 * @returns {{ data: Uint8ClampedArray, width: number, height: number }}
 */
function rasterizeToRgba(grid, scale = 8) {
  const size = grid.length;
  const pixels = size * scale;
  const data = new Uint8ClampedArray(pixels * pixels * 4);
  for (let py = 0; py < pixels; py++) {
    const row = grid[Math.floor(py / scale)];
    for (let px = 0; px < pixels; px++) {
      const dark = row[Math.floor(px / scale)];
      const offset = (py * pixels + px) * 4;
      const value = dark ? 0 : 255;
      data[offset] = value;
      data[offset + 1] = value;
      data[offset + 2] = value;
      data[offset + 3] = 255;
    }
  }
  return { data, width: pixels, height: pixels };
}

/**
 * 渲染 + 解码，返回解码文本（解码失败返回 null）。
 * @param {string} text
 * @returns {string | null}
 */
export function decodeQr(text) {
  const { size, path: d } = renderQrPath(text);
  const grid = rasterizeQrPath(d, size);
  const { data, width, height } = rasterizeToRgba(grid, 8);
  const result = jsQR(data, width, height, { inversionAttempts: 'dontInvert' });
  return result?.data ?? null;
}

const URLS = {
  basic: 'http://10.10.10.10:3579/c/Lcs-zbpF0GC6i3Si6Z_zZqJO7p9WOftdqZ5lpy_1524',
  localhost: 'http://127.0.0.1:3579/c/AAAAAAAAAAAAAAAAAAAAAAAA',
  long: `http://192.168.100.123:3579/c/${'x'.repeat(40)}`,
};

test('renderQrPath 返回 {size,path}，size = moduleCount + 8（4 模块 quiet zone ×2）', () => {
  const result = renderQrPath(URLS.basic);
  assert.equal(typeof result.path, 'string');
  assert.ok(result.path.length > 100, 'path 应有实质内容');
  assert.ok(Number.isInteger(result.size));
  assert.ok(result.size >= 29, `size 至少 29，实际 ${result.size}`);
  assert.ok(Number.isInteger(result.moduleCount));
  assert.equal(result.size, result.moduleCount + 8);
  assert.equal(result.ecLevel, 'M');
});

test('renderQrPath 的 path 以 M 开头、只包含合法命令/数字，深色模块全部落在 quiet zone 内', () => {
  const { path: d, size } = renderQrPath(URLS.basic);
  assert.match(d, /^M\d/);
  assert.match(d, /^[MmLlHhVvZz0-9.\s-]+$/, `path 含非法字符: ${d.slice(0, 80)}`);
  // 解析出所有 M 坐标，确认没有越过 viewBox 边界
  const marks = [...d.matchAll(/M(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)/g)];
  assert.ok(marks.length > 10, '应当有多个深色区段');
  for (const mark of marks) {
    const x = Number(mark[1]);
    const y = Number(mark[2]);
    assert.ok(x >= 4 && x <= size - 4, `M x 坐标越界: ${x} (size ${size})`);
    assert.ok(y >= 4 && y <= size - 4, `M y 坐标越界: ${y} (size ${size})`);
  }
});

test('renderQrPath 对空 payload 抛错', () => {
  assert.throws(() => renderQrPath(''), /empty/i);
  assert.throws(() => renderQrPath(null), /empty/i);
});

test('renderQrPath 相同输入输出稳定、不同输入输出不同，且尺寸随内容增长', () => {
  const first = renderQrPath(URLS.basic);
  const second = renderQrPath(URLS.basic);
  assert.deepEqual(first, second);
  const other = renderQrPath(URLS.long);
  assert.notEqual(first.path, other.path);
  assert.ok(other.size >= first.size, '更长的 payload 至少不应更小');
});

test('jsqr 解码往返：标准 LAN URL', { skip: skipDecode }, () => {
  assert.equal(decodeQr(URLS.basic), URLS.basic);
});

test('jsqr 解码往返：localhost URL 与长 token URL', { skip: skipDecode }, () => {
  assert.equal(decodeQr(URLS.localhost), URLS.localhost);
  assert.equal(decodeQr(URLS.long), URLS.long);
});

test('jsqr 解码往返：显式 ecLevel=H', { skip: skipDecode }, () => {
  const text = 'http://10.10.10.10:3579/c/abcdefghijklmnopqrstuvwx';
  const { size, path: d, ecLevel } = renderQrPath(text, { ecLevel: 'H' });
  assert.equal(ecLevel, 'H');
  const grid = rasterizeQrPath(d, size);
  const { data, width, height } = rasterizeToRgba(grid, 8);
  const decoded = jsQR(data, width, height, { inversionAttempts: 'dontInvert' });
  assert.equal(decoded?.data, text);
});
