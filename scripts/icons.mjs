// Make the PNG app icons (home screen / install) from the paths in public/icon.svg
// (scripts/logo.py writes that file).
// Run: node scripts/icons.mjs
import { deflateSync } from 'node:zlib';
import { readFileSync, writeFileSync } from 'node:fs';

const hex = h => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const svg = readFileSync('public/icon.svg', 'utf8');
const BG = hex(svg.match(/<rect[^>]*fill="(#[0-9a-f]{6})"/i)[1]);
// Every filled path, in drawing order, with its bounding box (to skip it quickly).
const shapes = [...svg.matchAll(/<path d="M([^"]+)Z" fill="(#[0-9a-f]{6})"/gi)].map(([, d, fill]) => {
  const P = d.split('L').map(q => q.trim().split(/\s+/).map(Number));
  const xs = P.map(p => p[0]), ys = P.map(p => p[1]);

  return [hex(fill), P, [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]];
});
const inPoly = (x, y, P) => {
  let c = false;
  for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
    const [xi, yi] = P[i], [xj, yj] = P[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      c = !c;
    }
  }

  return c;
};
const inRound = (x, y, r) => {
  const cx = Math.min(Math.max(x, r), 64 - r), cy = Math.min(Math.max(y, r), 64 - r);

  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r && x >= 0 && y >= 0 && x <= 64 && y <= 64;
};
function render(n, { rounded = true, scale = 1 } = {}) {
  const S = 4;
  const px = Buffer.alloc(n * n * 4);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const u = ((x + (sx + 0.5) / S) / n) * 64, v = ((y + (sy + 0.5) / S) / n) * 64;
          if (rounded && !inRound(u, v, 14)) {
            continue;
          }
          // The logo, scaled about the middle (smaller for maskable icons).
          const lu = 32 + (u - 32) / scale, lv = 32 + (v - 32) / scale;
          let c = BG;
          for (const [col, P, b] of shapes) {
            if (lu >= b[0] && lu <= b[2] && lv >= b[1] && lv <= b[3] && inPoly(lu, lv, P)) {
              c = col;
            }
          }
          r += c[0]; g += c[1]; b += c[2]; a += 255;
        }
      }
      const k = S * S, o = (y * n + x) * 4;
      const cov = a / k;
      px[o] = cov ? Math.round(r / (a / 255)) : 0;
      px[o + 1] = cov ? Math.round(g / (a / 255)) : 0;
      px[o + 2] = cov ? Math.round(b / (a / 255)) : 0;
      px[o + 3] = Math.round(cov);
    }
  }

  return png(n, n, px);
}
function crc(buf) {
  let c, crc = 0xffffffff;
  for (const byte of buf) {
    c = (crc ^ byte) & 0xff;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    crc = (crc >>> 8) ^ c;
  }

  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));

  return Buffer.concat([len, td, c]);
}
function png(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0; rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4); 
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;

  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
writeFileSync('public/icon-192.png', render(192));
writeFileSync('public/icon-512.png', render(512));
// Maskable: full square, logo inside the safe circle.
writeFileSync('public/icon-maskable-512.png', render(512, { rounded: false, scale: 0.75 }));
// iOS rounds the corners itself.
writeFileSync('public/apple-touch-icon.png', render(180, { rounded: false }));
console.log('icons written');
