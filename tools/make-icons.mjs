// Draws the Sweep logo (the same shapes as the SVG in app.js) into the PNG
// sizes Chrome wants. No dependencies: shapes are sampled 4x4 per pixel and
// written with a minimal PNG encoder.
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'extension', 'icons');
const INK = [21, 21, 21], PAPER = [243, 242, 238], RED = [228, 71, 42];

const inRoundRect = (x, y, w, h, r) => {
  const dx = Math.max(r - x, 0, x - (w - r)), dy = Math.max(r - y, 0, y - (h - r));
  return x >= 0 && y >= 0 && x <= w && y <= h && dx * dx + dy * dy <= r * r;
};
const nearSegment = (px, py, [ax, ay], [bx, by], half) => {
  const vx = bx - ax, vy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / (vx * vx + vy * vy)));
  const dx = px - (ax + t * vx), dy = py - (ay + t * vy);
  return dx * dx + dy * dy <= half * half;
};
const inPolygon = (px, py, pts) => {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
};

const HEAD = [[12.6, 13.3], [18.6, 17.6], [14.3, 26.8], [5.3, 20.3]];
function colorAt(x, y) {
  if (!inRoundRect(x, y, 32, 32, 8)) return null;
  if (nearSegment(x, y, [14.4, 16.1], [10, 22.7], 0.65) || nearSegment(x, y, [16.6, 17.7], [12.5, 24.7], 0.65)) {
    if (inPolygon(x, y, HEAD)) return INK;
  }
  if (inPolygon(x, y, HEAD)) return RED;
  if (nearSegment(x, y, [23.2, 5.4], [16, 15.4], 1.3)) return PAPER;
  return INK;
}

function render(size) {
  const px = Buffer.alloc(size * size * 4);
  const n = 4;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < n; sy++) {
        for (let sx = 0; sx < n; sx++) {
          const c = colorAt(((x + (sx + 0.5) / n) * 32) / size, ((y + (sy + 0.5) / n) * 32) / size);
          if (!c) continue;
          r += c[0]; g += c[1]; b += c[2]; a += 1;
        }
      }
      const i = (y * size + x) * 4;
      if (a) {
        px[i] = Math.round(r / a); px[i + 1] = Math.round(g / a); px[i + 2] = Math.round(b / a);
        px[i + 3] = Math.round((a / (n * n)) * 255);
      }
    }
  }
  return png(size, size, px);
}

const CRC = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(buf) {
  let c = -1;
  for (const byte of buf) c = CRC[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function png(w, h, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(h * (w * 4 + 1));
  for (let y = 0; y < h; y++) rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

mkdirSync(OUT, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  writeFileSync(join(OUT, `${size}.png`), render(size));
  console.log(`icons/${size}.png`);
}
