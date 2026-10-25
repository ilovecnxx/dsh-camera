/**
 * QR code rendering for the camera panel (Host half).
 *
 * The vendored `qrcode-generator` (MIT, Kazuhiko Arase) is a CommonJS/UMD module,
 * so it is required through createRequire — the plugin is installed as a link and
 * must not import any package that is not resolvable from its own directory.
 *
 * Output is an SVG path in module coordinates so the browser can render it with
 * one `<path>` element and the current text color.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// eslint-disable-next-line n/no-missing-require
const qrcodeFactory = require('./vendor/qrcode.cjs');

/** Quiet zone width in modules (the QR specification asks for 4). */
const QUIET_ZONE = 4;

/**
 * Build one row-major SVG path for the QR matrix.
 * @param {object} matrix - qrcode instance with getModuleCount()/isDark(row, col).
 * @param {number} moduleCount - matrix edge length in modules.
 * @returns {string} SVG path data covering every dark module as a unit rectangle.
 */
function matrixPath(matrix, moduleCount) {
  const parts = [];
  for (let row = 0; row < moduleCount; row += 1) {
    let col = 0;
    while (col < moduleCount) {
      if (!matrix.isDark(row, col)) {
        col += 1;
        continue;
      }
      const start = col;
      while (col < moduleCount && matrix.isDark(row, col)) col += 1;
      const width = col - start;
      parts.push(`M${start + QUIET_ZONE} ${row + QUIET_ZONE}h${width}v1h-${width}z`);
    }
  }
  return parts.join('');
}

/**
 * Render any ASCII-safe payload (URL) as a QR code path.
 * @param {string} text - payload to encode; URLs and tokens are ASCII.
 * @param {object} [options] - rendering options.
 * @param {'L'|'M'|'Q'|'H'} [options.ecLevel] - error correction level, default `M`.
 * @returns {{ size: number, path: string, ecLevel: string, moduleCount: number }}
 *   `size` includes the quiet zone and is the SVG viewBox edge length.
 */
export function renderQrPath(text, options = {}) {
  const payload = String(text ?? '');
  if (payload.length === 0) throw new Error('QR payload is empty');
  const ecLevel = options.ecLevel ?? 'M';
  // URLs are ASCII, so the default (SJIS) byte mapping encodes them losslessly.
  // Switching to UTF-8 makes non-ASCII payloads (future captions) safe too.
  if (qrcodeFactory.stringToBytesFuncs && qrcodeFactory.stringToBytesFuncs['UTF-8']) {
    qrcodeFactory.stringToBytes = qrcodeFactory.stringToBytesFuncs['UTF-8'];
  }
  let matrix;
  let lastError;
  for (let typeNumber = 1; typeNumber <= 40; typeNumber += 1) {
    try {
      const candidate = qrcodeFactory(typeNumber, ecLevel);
      candidate.addData(payload);
      candidate.make();
      matrix = candidate;
      break;
    } catch (error) {
      lastError = error;
    }
  }
  if (matrix === undefined) {
    const reason = lastError instanceof Error ? lastError.message : String(lastError);
    throw new Error(`QR payload cannot be encoded (${reason})`);
  }
  const moduleCount = matrix.getModuleCount();
  return {
    size: moduleCount + QUIET_ZONE * 2,
    path: matrixPath(matrix, moduleCount),
    ecLevel,
    moduleCount,
  };
}

export default renderQrPath;
