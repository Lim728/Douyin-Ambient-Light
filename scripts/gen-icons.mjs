/**
 * Generates the extension icons (16 / 32 / 48 / 128 px) as PNG files.
 *
 * Writing them procedurally keeps the repository free of opaque binary assets and makes the
 * icon reproducible: a dark rounded plate (the page background) with a coloured aura
 * (the ambient light) behind a small dark screen rectangle.
 *
 * Usage: node scripts/gen-icons.mjs
 */

import { deflateSync } from 'node:zlib';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SIZES = [16, 32, 48, 128];
const SUPERSAMPLE = 3;

// ---------------------------------------------------------------- PNG encoder

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuffer = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function encodePng(width, height, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------- rasteriser

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smoothstep = (edge0, edge1, x) => {
  const t = clamp01((x - edge0) / (edge1 - edge0 || 1e-6));
  return t * t * (3 - 2 * t);
};

/** Signed distance to a rounded rectangle centred in a unit square. */
function roundedRectDistance(px, py, halfWidth, halfHeight, radius) {
  const dx = Math.abs(px) - (halfWidth - radius);
  const dy = Math.abs(py) - (halfHeight - radius);
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
  return outside + Math.min(Math.max(dx, dy), 0) - radius;
}

/** Aura colour as a function of the angle: teal -> blue -> violet -> magenta. */
function auraColor(angle) {
  const t = (angle + Math.PI) / (Math.PI * 2);
  const stops = [
    [0.0, [80, 200, 255]],
    [0.25, [110, 150, 255]],
    [0.5, [170, 120, 255]],
    [0.75, [255, 120, 190]],
    [1.0, [80, 200, 255]],
  ];
  for (let i = 0; i < stops.length - 1; i++) {
    const [t0, c0] = stops[i];
    const [t1, c1] = stops[i + 1];
    if (t >= t0 && t <= t1) {
      const k = (t - t0) / (t1 - t0 || 1);
      return [c0[0] + (c1[0] - c0[0]) * k, c0[1] + (c1[1] - c0[1]) * k, c0[2] + (c1[2] - c0[2]) * k];
    }
  }
  return stops[0][1];
}

function shade(px, py) {
  // Unit square coordinates in -0.5 .. 0.5
  const plate = roundedRectDistance(px, py, 0.5, 0.5, 0.22);
  if (plate > 0.02) return [0, 0, 0, 0];
  const plateAlpha = 1 - smoothstep(0, 0.02, plate);

  const radius = Math.hypot(px, py);
  const angle = Math.atan2(py, px);
  const aura = auraColor(angle);

  // Ring: bright just outside the screen, fading into the plate.
  const ring = Math.exp(-Math.pow((radius - 0.30) / 0.115, 2));
  // Screen rectangle sits on top and stays dark.
  const screen = roundedRectDistance(px, py, 0.215, 0.135, 0.045);
  const screenMask = 1 - smoothstep(-0.006, 0.006, screen);

  let r = 12;
  let g = 13;
  let b = 19;

  const glowStrength = ring * 0.95;
  r += aura[0] * glowStrength;
  g += aura[1] * glowStrength;
  b += aura[2] * glowStrength;

  // Soft inner halo bleeding onto the screen edges.
  const inner = Math.exp(-Math.pow((radius - 0.22) / 0.14, 2)) * 0.35;
  r += aura[0] * inner;
  g += aura[1] * inner;
  b += aura[2] * inner;

  if (screenMask > 0) {
    const screenColor = [8, 9, 13];
    r = r * (1 - screenMask) + screenColor[0] * screenMask;
    g = g * (1 - screenMask) + screenColor[1] * screenMask;
    b = b * (1 - screenMask) + screenColor[2] * screenMask;
  }

  return [clamp01(r / 255) * 255, clamp01(g / 255) * 255, clamp01(b / 255) * 255, plateAlpha * 255];
}

function render(size) {
  const data = new Uint8ClampedArray(size * size * 4);
  const step = 1 / (size * SUPERSAMPLE);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SUPERSAMPLE; sy++) {
        for (let sx = 0; sx < SUPERSAMPLE; sx++) {
          const px = (x + (sx + 0.5) / SUPERSAMPLE) / size - 0.5;
          const py = (y + (sy + 0.5) / SUPERSAMPLE) / size - 0.5;
          const [pr, pg, pb, pa] = shade(px, py);
          const alpha = pa / 255;
          r += pr * alpha;
          g += pg * alpha;
          b += pb * alpha;
          a += alpha;
        }
      }
      const samples = SUPERSAMPLE * SUPERSAMPLE;
      const alpha = a / samples;
      const index = (y * size + x) * 4;
      data[index] = alpha > 0 ? r / a : 0;
      data[index + 1] = alpha > 0 ? g / a : 0;
      data[index + 2] = alpha > 0 ? b / a : 0;
      data[index + 3] = Math.round(alpha * 255);
    }
  }
  void step;
  return data;
}

async function main() {
  const outDir = resolve(root, 'icons');
  await mkdir(outDir, { recursive: true });
  for (const size of SIZES) {
    const png = encodePng(size, size, render(size));
    await writeFile(resolve(outDir, `icon-${size}.png`), png);
    console.log(`icons/icon-${size}.png  ${png.length} bytes`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
