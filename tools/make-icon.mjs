// SPDX-License-Identifier: MIT OR Apache-2.0
//
// Draws the Torflix app icon (a red T on a dark rounded square) and writes assets/icon.png,
// assets/icon.ico (PNG-compressed, 256 px) and assets/icon.icns (128/256/512 px) with no
// image library: pixels are computed here, PNG is encoded with zlib.
//
//   node tools/make-icon.mjs

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const assets = path.join(here, '..', 'assets');

const BG = [11, 11, 11];
const RED = [229, 9, 20];
const DARK_RED = [178, 7, 16];

/** Renders the icon at `size` pixels as RGBA, supersampled 3× for smooth edges. */
function render(size) {
  const ss = 3;
  const big = size * ss;
  const px = new Float32Array(big * big * 4);
  const radius = big * 0.19;
  const barTop = big * 0.22;
  const barBottom = big * 0.375;
  const stemLeft = big * 0.405;
  const stemRight = big * 0.595;
  const stemBottom = big * 0.78;
  const barLeft = big * 0.22;
  const barRight = big * 0.78;
  for (let y = 0; y < big; y++) {
    for (let x = 0; x < big; x++) {
      const i = (y * big + x) * 4;
      // Rounded square.
      const dx = Math.max(radius - x, x - (big - 1 - radius), 0);
      const dy = Math.max(radius - y, y - (big - 1 - radius), 0);
      if (dx * dx + dy * dy > radius * radius) continue;
      let c = BG;
      const cx = x + 0.5;
      const cy = y + 0.5;
      const inBar = cx >= barLeft && cx < barRight && cy >= barTop && cy < barBottom;
      const inStem = cx >= stemLeft && cx < stemRight && cy >= barBottom && cy < stemBottom;
      // A folded corner under the bar, like a ribbon, for a little depth.
      const inFold = cx >= stemLeft && cx < stemRight && cy >= barBottom && cy < barBottom + (stemRight - cx) * 0.55;
      if (inBar || inStem) c = inFold ? DARK_RED : RED;
      px[i] = c[0];
      px[i + 1] = c[1];
      px[i + 2] = c[2];
      px[i + 3] = 255;
    }
  }
  // Downsample.
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const i = ((y * ss + sy) * big + (x * ss + sx)) * 4;
          const alpha = px[i + 3] / 255;
          r += px[i] * alpha;
          g += px[i + 1] * alpha;
          b += px[i + 2] * alpha;
          a += alpha;
        }
      }
      const o = (y * size + x) * 4;
      if (a > 0) {
        out[o] = Math.round(r / a);
        out[o + 1] = Math.round(g / a);
        out[o + 2] = Math.round(b / a);
      }
      out[o + 3] = Math.round((a / (ss * ss)) * 255);
    }
  }
  return out;
}

const CRC_TABLE = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});

function crc32(buf) {
  let c = -1;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(size) {
  const rgba = render(size);
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

function ico(sizes) {
  const images = sizes.map((s) => ({ size: s, data: png(s) }));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  const entries = [];
  let offset = 6 + images.length * 16;
  for (const img of images) {
    const e = Buffer.alloc(16);
    e[0] = img.size >= 256 ? 0 : img.size;
    e[1] = img.size >= 256 ? 0 : img.size;
    e[2] = 0;
    e[3] = 0;
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(img.data.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += img.data.length;
    entries.push(e);
  }
  return Buffer.concat([header, ...entries, ...images.map((i) => i.data)]);
}

function icns() {
  const types = [
    ['ic07', 128],
    ['ic08', 256],
    ['ic09', 512],
  ];
  const parts = types.map(([type, size]) => {
    const data = png(size);
    const head = Buffer.alloc(8);
    head.write(type, 0, 'latin1');
    head.writeUInt32BE(8 + data.length, 4);
    return Buffer.concat([head, data]);
  });
  const total = 8 + parts.reduce((n, p) => n + p.length, 0);
  const head = Buffer.alloc(8);
  head.write('icns', 0, 'latin1');
  head.writeUInt32BE(total, 4);
  return Buffer.concat([head, ...parts]);
}

fs.mkdirSync(assets, { recursive: true });
fs.writeFileSync(path.join(assets, 'icon.png'), png(512));
fs.writeFileSync(path.join(assets, 'icon.ico'), ico([16, 32, 48, 256]));
fs.writeFileSync(path.join(assets, 'icon.icns'), icns());
console.log('wrote assets/icon.png, icon.ico, icon.icns');
