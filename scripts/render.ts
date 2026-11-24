// A picture of solids without a browser: the bodies meshed, drawn shaded with
// their edges by a small software renderer, and written as a PNG.
//
//   npx tsx scripts/render.ts project.super out.png [--view iso|front|back|top|bottom|left|right] [--size 800]
//   import { renderPNG } from "./render";  renderPNG([{ shape }], "out.png", { view: "front" });
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import type { Shape3D } from 'replicad';

type V3 = [number, number, number];

export interface RenderOptions {
  view?: 'iso' | 'front' | 'back' | 'top' | 'bottom' | 'left' | 'right';
  /** Width and height in pixels (default 800). */
  size?: number;
  /** Background, "#rrggbb" (default light grey). */
  background?: string;
  /** Edges drawn over the faces (default on). */
  edges?: boolean;
}

export interface RenderBody {
  shape: Shape3D;
  /** "#rrggbb" (default a blue-grey). */
  color?: string;
}

// The views: the direction looked from (towards the viewer) and which way is up on the picture.
const VIEWS: Record<NonNullable<RenderOptions['view']>, { dir: V3; up: V3 }> = {
  iso: { dir: [1, -1, 1], up: [0, 0, 1] },
  front: { dir: [0, -1, 0], up: [0, 0, 1] },
  back: { dir: [0, 1, 0], up: [0, 0, 1] },
  top: { dir: [0, 0, 1], up: [0, 1, 0] },
  bottom: { dir: [0, 0, -1], up: [0, -1, 0] },
  left: { dir: [-1, 0, 0], up: [0, 0, 1] },
  right: { dir: [1, 0, 0], up: [0, 0, 1] }
};

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: V3): V3 => {
  const length = Math.hypot(...a) || 1;

  return [a[0] / length, a[1] / length, a[2] / length];
};
const rgb = (hex: string): V3 => {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  const rgb = match ? parseInt(match[1], 16) : 0x8fa3b8;

  return [(rgb >> 16) & 255, (rgb >> 8) & 255, rgb & 255];
};

/** The picture as RGBA pixels (size x size). */
export function renderRGBA(bodies: RenderBody[], renderOptions: RenderOptions = {}): { width: number; height: number; data: Uint8Array } {
  const size = renderOptions.size ?? 800;
  const SS = 2; // drawn twice as big, then averaged down (smooth edges)
  const canvasWidth = size * SS;
  const view = VIEWS[renderOptions.view ?? 'iso'];
  const fwd = norm(view.dir);
  const right = norm(cross(view.up, fwd));
  const up = cross(fwd, right);
  const bg = rgb(renderOptions.background ?? '#eef0f3');

  // Meshes in view space: x right, y up, z towards the viewer.
  const meshes = bodies.flatMap((b) => {
    try {
      const mesh = b.shape.mesh({ tolerance: 0.05, angularTolerance: 0.15 });
      let lines: number[] = [];
      if (renderOptions.edges !== false) {
        try {
          lines = (b.shape as any).meshEdges({ tolerance: 0.05, angularTolerance: 0.15 }).lines as number[];
        } catch {
          lines = [];
        }
      }

      return [{ v: mesh.vertices as number[], t: mesh.triangles as number[], lines, color: rgb(b.color ?? '#8fa3b8') }];
    } catch {
      return [];
    }
  });
  const toView = (a: number[], i: number): V3 => {
    const point: V3 = [a[i], a[i + 1], a[i + 2]];

    return [dot(point, right), dot(point, up), dot(point, fwd)];
  };
  let lo: V3 = [Infinity, Infinity, Infinity];
  let hi: V3 = [-Infinity, -Infinity, -Infinity];
  for (const mesh of meshes) {
    for (let i = 0; i < mesh.v.length; i += 3) {
      const view = toView(mesh.v, i);
      lo = [Math.min(lo[0], view[0]), Math.min(lo[1], view[1]), Math.min(lo[2], view[2])];
      hi = [Math.max(hi[0], view[0]), Math.max(hi[1], view[1]), Math.max(hi[2], view[2])];
    }
  }
  const color = new Float32Array(canvasWidth * canvasWidth * 3);
  for (let i = 0; i < canvasWidth * canvasWidth; i++) {
    color.set(bg, i * 3);
  }
  const depth = new Float32Array(canvasWidth * canvasWidth).fill(-Infinity);
  if (Number.isFinite(lo[0])) {
    // Fit with a margin, centred.
    const span = Math.max(hi[0] - lo[0], hi[1] - lo[1]) || 1;
    const scale = (canvasWidth * 0.86) / span;
    const cx = (lo[0] + hi[0]) / 2;
    const cy = (lo[1] + hi[1]) / 2;
    const px = (point: V3): V3 => [canvasWidth / 2 + (point[0] - cx) * scale, canvasWidth / 2 - (point[1] - cy) * scale, point[2]];
    const light = norm([0.35, 0.55, 1]);
    for (const mesh of meshes) {
      const points: V3[] = [];
      for (let i = 0; i < mesh.v.length; i += 3) {
        points.push(px(toView(mesh.v, i)));
      }
      for (let t = 0; t < mesh.t.length; t += 3) {
        const a = points[mesh.t[t]];
        const b = points[mesh.t[t + 1]];
        const pointC = points[mesh.t[t + 2]];
        // The face's normal in view space (screen y is down: flip it back).
        const normal = norm(cross(sub([b[0], -b[1], b[2]], [a[0], -a[1], a[2]]), sub([pointC[0], -pointC[1], pointC[2]], [a[0], -a[1], a[2]])));
        const facing = normal[2] < 0 ? ([-normal[0], -normal[1], -normal[2]] as V3) : normal;
        const shade = 0.38 + 0.62 * Math.max(0, dot(facing, light));
        const col: V3 = [mesh.color[0] * shade, mesh.color[1] * shade, mesh.color[2] * shade];
        fillTri(a, b, pointC, col, color, depth, canvasWidth);
      }
      // Edges: dark, drawn where they are not behind a face.
      const bias = (hi[2] - lo[2] || 1) * 2e-3;
      for (let i = 0; i + 5 < mesh.lines.length; i += 6) {
        const a = px(toView(mesh.lines, i));
        const b = px(toView(mesh.lines, i + 3));
        drawLine(a, b, [40, 44, 52], color, depth, canvasWidth, bias, SS);
      }
    }
  }
  // Average each SS x SS block.
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let red = 0,
        green = 0,
        b = 0;
      for (let j = 0; j < SS; j++) {
        for (let i = 0; i < SS; i++) {
          const q = ((y * SS + j) * canvasWidth + x * SS + i) * 3;
          red += color[q];
          green += color[q + 1];
          b += color[q + 2];
        }
      }
      const o4 = (y * size + x) * 4;
      data[o4] = red / (SS * SS);
      data[o4 + 1] = green / (SS * SS);
      data[o4 + 2] = b / (SS * SS);
      data[o4 + 3] = 255;
    }
  }

  return { width: size, height: size, data };
}

function fillTri(a: V3, b: V3, pointC: V3, col: V3, color: Float32Array, depth: Float32Array, canvasWidth: number): void {
  const x0 = Math.max(0, Math.floor(Math.min(a[0], b[0], pointC[0])));
  const x1 = Math.min(canvasWidth - 1, Math.ceil(Math.max(a[0], b[0], pointC[0])));
  const y0 = Math.max(0, Math.floor(Math.min(a[1], b[1], pointC[1])));
  const y1 = Math.min(canvasWidth - 1, Math.ceil(Math.max(a[1], b[1], pointC[1])));
  const area = (b[0] - a[0]) * (pointC[1] - a[1]) - (b[1] - a[1]) * (pointC[0] - a[0]);
  if (Math.abs(area) < 1e-12) {
    return;
  }
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      const w0 = ((b[0] - px) * (pointC[1] - py) - (b[1] - py) * (pointC[0] - px)) / area;
      const w1 = ((pointC[0] - px) * (a[1] - py) - (pointC[1] - py) * (a[0] - px)) / area;
      const w2 = 1 - w0 - w1;
      if (w0 < 0 || w1 < 0 || w2 < 0) {
        continue;
      }
      const z = w0 * a[2] + w1 * b[2] + w2 * pointC[2];
      const i = y * canvasWidth + x;
      if (z <= depth[i]) {
        continue;
      }
      depth[i] = z;
      color[i * 3] = col[0];
      color[i * 3 + 1] = col[1];
      color[i * 3 + 2] = col[2];
    }
  }
}

function drawLine(a: V3, b: V3, col: V3, color: Float32Array, depth: Float32Array, canvasWidth: number, bias: number, thick: number): void {
  const steps = Math.ceil(Math.max(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]))) + 1;
  for (let step = 0; step <= steps; step++) {
    const t = step / steps;
    const x = a[0] + (b[0] - a[0]) * t;
    const y = a[1] + (b[1] - a[1]) * t;
    const z = a[2] + (b[2] - a[2]) * t;
    for (let j = 0; j < thick; j++) {
      for (let i = 0; i < thick; i++) {
        const pixelX = Math.floor(x - thick / 2 + i + 0.5);
        const pixelY = Math.floor(y - thick / 2 + j + 0.5);
        if (pixelX < 0 || pixelY < 0 || pixelX >= canvasWidth || pixelY >= canvasWidth) {
          continue;
        }
        const pixelIndex = pixelY * canvasWidth + pixelX;
        if (z + bias < depth[pixelIndex]) {
          continue;
        }
        color[pixelIndex * 3] = col[0];
        color[pixelIndex * 3 + 1] = col[1];
        color[pixelIndex * 3 + 2] = col[2];
      }
    }
  }
}

// ------------------------------------------------------------------ PNG

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let entry = 0; entry < 256; entry++) {
    let value = entry;
    for (let bit = 0; bit < 8; bit++) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    t[entry] = value >>> 0;
  }

  return t;
})();
function crc32(buf: Uint8Array): number {
  let crc = 0xffffffff;
  for (const b of buf) {
    crc = CRC[(crc ^ b) & 255] ^ (crc >>> 8);
  }

  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  out.set(Buffer.from(type, 'ascii'), 4);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));

  return out;
}

/** RGBA pixels as a PNG file. */
export function encodePNG(width: number, height: number, rgba: Uint8Array): Uint8Array {
  const raw = new Uint8Array(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
  }
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', new Uint8Array())];
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at), (at += part.length);
  }

  return out;
}

/** Draw the bodies and write the picture to `file`. */
export function renderPNG(bodies: RenderBody[], file: string, renderOptions: RenderOptions = {}): void {
  const { width, height, data } = renderRGBA(bodies, renderOptions);
  writeFileSync(file, encodePNG(width, height, data));
}

// ------------------------------------------------------------------ command line

if (process.argv[1]?.replace(/\\/g, '/').endsWith('scripts/render.ts')) {
  const args = process.argv.slice(2);
  const [file, out] = args.filter((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
  if (!file || !out) {
    console.log('Usage: npx tsx scripts/render.ts <project.super> <out.png> [--view iso|front|back|top|bottom|left|right] [--size 800]');
    process.exit(2);
  }
  const { readFileSync } = await import('node:fs');
  const opencascade = (await import('replicad-opencascadejs')).default;
  const { setOC } = await import('replicad');
  const { parseProject } = await import('../src/doc/store');
  const { debugBodies, regenerate } = await import('../src/kernel/engine');
  const doc = parseProject(readFileSync(file, 'utf8'));
  setOC(await (opencascade as unknown as () => Promise<any>)());
  const result = await regenerate(doc.features);
  for (const e of result.errors) {
    console.log(`error in ${e.featureId}: ${e.message}`);
  }
  const hidden = new Set(doc.hidden ?? []);
  const opt = (flag: string) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
  renderPNG(
    [...debugBodies()].filter(([id]) => !hidden.has(id)).map(([id, shape]) => ({ shape, color: doc.colors?.[id] })),
    out,
    { view: (opt('--view') as RenderOptions['view']) ?? 'iso', size: Number(opt('--size') ?? 800) }
  );
  console.log(`Picture: ${out}`);
}
