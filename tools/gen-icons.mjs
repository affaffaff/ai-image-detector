/**
 * Generate the extension icons as PNGs, deterministically (pure math, fixed
 * deflate settings). Output is COMMITTED; the build copies these files and
 * never regenerates them, so icon bytes cannot vary across build machines.
 *
 * Run manually after changing the artwork: node tools/gen-icons.mjs
 *
 * The mark: an indigo "lens" disc with a dark iris and white pupil — reads as
 * inspection/detection at 16px without text.
 */

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'icons');

// ---------------------------------------------------------------------------
// Minimal PNG encoder (RGBA8, filter 0, fixed deflate level for determinism)

const CRC_TABLE = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});

/** @param {Uint8Array} buf */
function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = /** @type {number} */ (CRC_TABLE[(c ^ byte) & 0xff]) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** @param {string} type @param {Uint8Array} data */
function chunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set([...type].map((ch) => ch.charCodeAt(0)), 4);
  out.set(data, 8);
  const crcInput = out.subarray(4, 8 + data.length);
  view.setUint32(8 + data.length, crc32(crcInput));
  return out;
}

/** @param {number} size @param {Uint8Array} rgba */
function encodePng(size, rgba) {
  const sig = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = new Uint8Array(13);
  const iv = new DataView(ihdr.buffer);
  iv.setUint32(0, size);
  iv.setUint32(4, size);
  ihdr.set([8, 6, 0, 0, 0], 8); // 8-bit, RGBA, deflate, filter 0, no interlace

  // Scanlines with filter byte 0.
  const raw = new Uint8Array(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw.set(rgba.subarray(y * size * 4, (y + 1) * size * 4), y * (size * 4 + 1) + 1);
  }
  const idat = deflateSync(raw, { level: 9, memLevel: 9 });

  const parts = [sig, chunk('IHDR', ihdr), chunk('IDAT', new Uint8Array(idat)), chunk('IEND', new Uint8Array(0))];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const png = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    png.set(p, off);
    off += p.length;
  }
  return png;
}

// ---------------------------------------------------------------------------
// Artwork

/** @param {number} size */
function drawIcon(size) {
  const rgba = new Uint8Array(size * size * 4);
  const c = (size - 1) / 2;
  const rDisc = size * 0.47;
  const rIris = size * 0.28;
  const rPupil = size * 0.11;

  const disc = [0x5b, 0x5b, 0xd6]; // indigo
  const iris = [0x1e, 0x1e, 0x38]; // dark navy
  const pupil = [0xff, 0xff, 0xff];

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - c, y - c);
      let color = null;
      if (d <= rPupil) color = pupil;
      else if (d <= rIris) color = iris;
      else if (d <= rDisc) color = disc;
      if (!color) continue;
      // 1px soft edge on the outer disc so small sizes don't look jagged.
      const alpha = d > rDisc - 1 ? Math.max(0, Math.min(1, rDisc - d)) : 1;
      const i = (y * size + x) * 4;
      rgba[i] = /** @type {number} */ (color[0]);
      rgba[i + 1] = /** @type {number} */ (color[1]);
      rgba[i + 2] = /** @type {number} */ (color[2]);
      rgba[i + 3] = Math.round(alpha * 255);
    }
  }
  return rgba;
}

mkdirSync(OUT_DIR, { recursive: true });
for (const size of [16, 48, 128]) {
  const png = encodePng(size, drawIcon(size));
  writeFileSync(join(OUT_DIR, `icon${size}.png`), png);
  console.log(`icon${size}.png  ${png.length} bytes`);
}
