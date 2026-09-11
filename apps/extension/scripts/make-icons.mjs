/**
 * Generates the extension's PNG icons procedurally, so there is no binary asset
 * to keep in sync and every size is drawn crisply rather than downscaled.
 *
 * Motif: a decoy on the water. A carved bird put exactly where the real one
 * would be, convincing enough that nothing changes its behaviour -- which is
 * the product in one object.
 *
 * Everything is defined as coverage in unit space and sampled, so the same
 * description produces a clean 128 and a legible 16. The 16 is the size that
 * decides a mark: it is what sits in the toolbar all day, and it is where
 * detail has to be spent rather than added.
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const OUT_DIR = fileURLToPath(new URL('../public/icons', import.meta.url));
const SIZES = [16, 32, 48, 128];

/** The app's own ink and gold, so the toolbar and the surface are one thing. */
const INK = [26, 23, 21, 255];
const GOLD = [224, 168, 26, 255];
const WATER = [86, 74, 60, 255];

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

function encodePng(size, rgba) {
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (stride + 1)] = 0; // no per-scanline filter
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Standard rounded-rectangle signed distance function over the whole tile.
 * Clamping each axis at zero before taking the length is what keeps the
 * straight edges straight and rounds only the corners.
 */
function insideTile(x, y) {
  const radius = 0.22;
  const dx = Math.abs(x - 0.5) - (0.5 - radius);
  const dy = Math.abs(y - 0.5) - (0.5 - radius);
  return Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) - radius <= 0;
}

function ellipse(x, y, cx, cy, rx, ry) {
  return ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1;
}

const WATERLINE = 0.68;

/**
 * The hull, cut flat where it meets the water, with the stern lifted into a
 * tail. The tail is what stops the silhouette reading as a rubber duck.
 */
function insideBody(x, y) {
  if (y > WATERLINE) return false;
  if (ellipse(x, y, 0.51, 0.6, 0.3, 0.2)) return true;

  const t = (x - 0.7) / 0.22;
  if (t >= 0 && t <= 1) {
    const top = 0.6 - 0.2 * (1 - t) - 0.115 * t;
    return y >= top && y <= 0.6 + 0.08 * (1 - t);
  }
  return false;
}

/** Head and neck, merged into the hull so the whole bird is one shape. */
function insideHead(x, y) {
  if (ellipse(x, y, 0.345, 0.335, 0.145, 0.145)) return true;
  return x >= 0.27 && x <= 0.44 && y >= 0.32 && y <= 0.6;
}

/** A short wedge, kept blunt: a fine point disappears below 32px. */
function insideBeak(x, y) {
  if (x > 0.345 || x < 0.115) return false;
  const t = (0.345 - x) / 0.23;
  return Math.abs(y - 0.365) <= 0.062 * (1 - t * 0.6);
}

/**
 * The eye, punched back out to ink. Below 32px it would be a single muddy
 * pixel in the middle of the head, so it is simply not drawn there -- the
 * silhouette carries the mark on its own.
 */
function insideEye(x, y, size) {
  if (size < 32) return false;
  return ellipse(x, y, 0.315, 0.315, 0.036, 0.036);
}

/**
 * Two strokes of water, which is what makes it float rather than hover.
 *
 * Dropped at 16, where they are three muddy pixels arguing with the bird for
 * the same few rows. At that size the silhouette has to carry the mark alone,
 * and it does.
 */
function insideWater(x, y, size) {
  if (size < 24) return false;
  if (Math.abs(y - (WATERLINE + 0.085)) > 0.045) return false;
  return (x >= 0.13 && x <= 0.4) || (x >= 0.48 && x <= 0.87);
}

/** 4x4 supersampling, which is enough to keep the 16px tile from looking ragged. */
function sampleColour(px, py, step, size) {
  const accumulator = [0, 0, 0, 0];
  let samples = 0;
  // With the water dropped, the bird is nudged down into the space it leaves,
  // so the mark stays optically centred rather than sitting high in the tile.
  const drop = size < 24 ? 0.05 : 0;
  for (let sy = 0; sy < 4; sy += 1) {
    for (let sx = 0; sx < 4; sx += 1) {
      const x = px + ((sx + 0.5) / 4) * step;
      const y = py + ((sy + 0.5) / 4) * step - drop;
      let colour = [0, 0, 0, 0];
      if (insideTile(x, y)) {
        colour = INK;
        if (insideWater(x, y, size)) colour = WATER;
        if (insideBody(x, y) || insideHead(x, y) || insideBeak(x, y)) colour = GOLD;
        if (insideEye(x, y, size)) colour = INK;
      }
      for (let i = 0; i < 4; i += 1) accumulator[i] += colour[i];
      samples += 1;
    }
  }
  return accumulator.map((total) => Math.round(total / samples));
}

function drawIcon(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const step = 1 / size;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const [r, g, b, a] = sampleColour(x * step, y * step, step, size);
      const offset = (y * size + x) * 4;
      rgba[offset] = r;
      rgba[offset + 1] = g;
      rgba[offset + 2] = b;
      rgba[offset + 3] = a;
    }
  }
  return encodePng(size, rgba);
}

mkdirSync(OUT_DIR, { recursive: true });
for (const size of SIZES) {
  const file = path.join(OUT_DIR, `icon-${size}.png`);
  writeFileSync(file, drawIcon(size));
  console.log(`icons: wrote ${path.relative(process.cwd(), file)}`);
}
