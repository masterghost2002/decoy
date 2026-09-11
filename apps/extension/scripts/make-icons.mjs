/**
 * Generates the extension's PNG icons procedurally, so there is no binary asset
 * to keep in sync and every size is drawn crisply rather than downscaled.
 *
 * Motif: a severed wire with a node at the break, on a dark slate tile.
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const OUT_DIR = fileURLToPath(new URL('../public/icons', import.meta.url));
const SIZES = [16, 32, 48, 128];

const SLATE = [17, 24, 39, 255];
const WIRE = [100, 116, 139, 255];
const ACCENT = [245, 158, 11, 255];

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
  const qx = Math.max(dx, 0);
  const qy = Math.max(dy, 0);
  return Math.hypot(qx, qy) - radius <= 0;
}

function insideWire(x, y) {
  if (Math.abs(y - 0.5) > 0.045) return false;
  return (x >= 0.13 && x <= 0.36) || (x >= 0.64 && x <= 0.87);
}

function insideNode(x, y) {
  return Math.abs(x - 0.5) / 0.2 + Math.abs(y - 0.5) / 0.2 <= 1;
}

/** 3x3 supersampling, which is enough to keep the 16px tile from looking ragged. */
function sampleColour(px, py, step) {
  const accumulator = [0, 0, 0, 0];
  let samples = 0;
  for (let sy = 0; sy < 3; sy += 1) {
    for (let sx = 0; sx < 3; sx += 1) {
      const x = px + ((sx + 0.5) / 3) * step;
      const y = py + ((sy + 0.5) / 3) * step;
      let colour = [0, 0, 0, 0];
      if (insideTile(x, y)) {
        colour = SLATE;
        if (insideWire(x, y)) colour = WIRE;
        if (insideNode(x, y)) colour = ACCENT;
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
      const [r, g, b, a] = sampleColour(x * step, y * step, step);
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
