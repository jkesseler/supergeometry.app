// Make the PNG app icons (home screen / install) from the paths in public/icon.svg
// (scripts/logo.py writes that file).
// Run: node scripts/icons.mjs
import { deflateSync } from 'node:zlib';
import { readFileSync, writeFileSync } from 'node:fs';

const hex = hexColor => [parseInt(hexColor.slice(1, 3), 16), parseInt(hexColor.slice(3, 5), 16), parseInt(hexColor.slice(5, 7), 16)];
const svg = readFileSync('public/icon.svg', 'utf8');
const BG = hex(svg.match(/<rect[^>]*fill="(#[0-9a-f]{6})"/i)[1]);
// Every filled path, in drawing order, with its bounding box (to skip it quickly).
const shapes = [...svg.matchAll(/<path d="M([^"]+)Z" fill="(#[0-9a-f]{6})"/gi)].map(([, pathData, fill]) => {
  const points = pathData.split('L').map(q => q.trim().split(/\s+/).map(Number));
  const xs = points.map(point => point[0]), ys = points.map(point => point[1]);

  return [hex(fill), points, [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]];
});
const inPoly = (x, y, polygon) => {
  let isInside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i], [xj, yj] = polygon[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      isInside = !isInside;
    }
  }

  return isInside;
};
const inRound = (x, y, radius) => {
  const cx = Math.min(Math.max(x, radius), 64 - radius), cy = Math.min(Math.max(y, radius), 64 - radius);

  return (x - cx) ** 2 + (y - cy) ** 2 <= radius * radius && x >= 0 && y >= 0 && x <= 64 && y <= 64;
};
function render(size, { rounded = true, scale = 1 } = {}) {
  const samples = 4;
  const px = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let red = 0, green = 0, b = 0, a = 0;
      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const iconX = ((x + (sx + 0.5) / samples) / size) * 64, iconY = ((y + (sy + 0.5) / samples) / size) * 64;
          if (rounded && !inRound(iconX, iconY, 14)) {
            continue;
          }
          // The logo, scaled about the middle (smaller for maskable icons).
          const lu = 32 + (iconX - 32) / scale, lv = 32 + (iconY - 32) / scale;
          let color = BG;
          for (const [col, polygon, b] of shapes) {
            if (lu >= b[0] && lu <= b[2] && lv >= b[1] && lv <= b[3] && inPoly(lu, lv, polygon)) {
              color = col;
            }
          }
          red += color[0]; green += color[1]; b += color[2]; a += 255;
        }
      }
      const sampleCount = samples * samples, offset = (y * size + x) * 4;
      const cov = a / sampleCount;
      px[offset] = cov ? Math.round(red / (a / 255)) : 0;
      px[offset + 1] = cov ? Math.round(green / (a / 255)) : 0;
      px[offset + 2] = cov ? Math.round(b / (a / 255)) : 0;
      px[offset + 3] = Math.round(cov);
    }
  }

  return png(size, size, px);
}
function crc(buf) {
  let value, crc = 0xffffffff;
  for (const byte of buf) {
    value = (crc ^ byte) & 0xff;
    for (let bit = 0; bit < 8; bit++) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    crc = (crc >>> 8) ^ value;
  }

  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crcBytes = Buffer.alloc(4); crcBytes.writeUInt32BE(crc(td));

  return Buffer.concat([len, td, crcBytes]);
}
function png(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4); 
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;

  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
writeFileSync('public/icon-192.png', render(192));
writeFileSync('public/icon-512.png', render(512));
// Maskable: full square, logo inside the safe circle.
writeFileSync('public/icon-maskable-512.png', render(512, { rounded: false, scale: 0.75 }));
// iOS rounds the corners itself.
writeFileSync('public/apple-touch-icon.png', render(180, { rounded: false }));
console.log('icons written');
