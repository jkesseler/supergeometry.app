// SVG → sketch curves. Lines stay lines, circular arcs become arcs, circles /
// ellipses / rectangles become those shapes (when not skewed), and Bézier or
// elliptical curves become splines through points on them. Units follow the
// SVG's width/viewBox (mm, cm, in, pt, px); y is flipped so up stays up, and
// the drawing is centred on the sketch origin.
//
// Self-contained (no DOM), so it works in tests and workers alike.

import { uid } from '../sketch/edit';
import { entityPrims, samplePrim, type Prim } from '../sketch/curves';
import type { SketchEntity, Vec2 } from '../doc/types';

/** 2D affine map [a b c d e f]: x' = a x + c y + e, y' = b x + d y + f (SVG's matrix order). */
type M = [number, number, number, number, number, number];
const identity: M = [1, 0, 0, 1, 0, 0];
const mul = (left: M, q: M): M => [left[0] * q[0] + left[2] * q[1], left[1] * q[0] + left[3] * q[1], left[0] * q[2] + left[2] * q[3], left[1] * q[2] + left[3] * q[3], left[0] * q[4] + left[2] * q[5] + left[4], left[1] * q[4] + left[3] * q[5] + left[5]];
const ap = (matrix: M, [x, y]: Vec2): Vec2 => [matrix[0] * x + matrix[2] * y + matrix[4], matrix[1] * x + matrix[3] * y + matrix[5]];

/** Rotation + uniform scale (+ mirror) only: circles stay circles. */
function similarity(matrix: M): { k: number; rot: number } | null {
  const k1 = Math.hypot(matrix[0], matrix[1]);
  const k2 = Math.hypot(matrix[2], matrix[3]);
  const dotp = matrix[0] * matrix[2] + matrix[1] * matrix[3];
  if (Math.abs(k1 - k2) > 1e-9 * Math.max(k1, k2) || Math.abs(dotp) > 1e-9 * k1 * k2) {
    return null;
  }

  return { k: k1, rot: Math.atan2(matrix[1], matrix[0]) };
}

function parseTransform(text: string | undefined): M {
  let matrix = identity;
  if (!text) {
    return matrix;
  }
  for (const [, fn, args] of text.matchAll(/(\w+)\s*\(([^)]*)\)/g)) {
    const values = nums(args);
    let t: M = identity;
    switch (fn) {
      case 'matrix':
        if (values.length === 6) {
          t = values as M;
        }
        break;
      case 'translate':
        t = [1, 0, 0, 1, values[0] ?? 0, values[1] ?? 0];
        break;
      case 'scale':
        t = [values[0] ?? 1, 0, 0, values[1] ?? values[0] ?? 1, 0, 0];
        break;
      case 'rotate': {
        const a = ((values[0] ?? 0) * Math.PI) / 180;
        const rotation: M = [Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), 0, 0];
        t = values.length >= 3 ? mul(mul([1, 0, 0, 1, values[1], values[2]], rotation), [1, 0, 0, 1, -values[1], -values[2]]) : rotation;
        break;
      }
      case 'skewX':
        t = [1, 0, Math.tan(((values[0] ?? 0) * Math.PI) / 180), 1, 0, 0];
        break;
      case 'skewY':
        t = [1, Math.tan(((values[0] ?? 0) * Math.PI) / 180), 0, 1, 0, 0];
        break;
    }
    matrix = mul(matrix, t);
  }

  return matrix;
}

function nums(text: string): number[] {
  return (text.match(/[-+]?(?:\d*\.\d+|\d+\.?)(?:e[-+]?\d+)?/gi) ?? []).map(Number);
}

// ---------------------------------------------------------------- XML

interface El {
  name: string;
  attrs: Record<string, string>;
  children: El[];
}

/** Tiny XML reader: elements and attributes only (enough for SVG geometry). */
function parseXml(text: string): El {
  const root: El = { name: '#root', attrs: {}, children: [] };
  const stack = [root];
  const src = text.replace(/<!--[\s\S]*?-->/g, '').replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '').replace(/<\?[\s\S]*?\?>/g, '').replace(/<!DOCTYPE[\s\S]*?>/gi, '');
  for (const [, close, name, rest, selfClose] of src.matchAll(/<(\/?)([\w:.-]+)([^>]*?)(\/?)>/g)) {
    if (close) {
      if (stack.length > 1) {
        stack.pop();
      }
      continue;
    }
    const attrs: Record<string, string> = {};
    for (const [, key, , v1, v2] of rest.matchAll(/([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) {
      attrs[key] = v1 ?? v2 ?? '';
    }
    // style="stroke:…; transform:…" isn't geometry, except display:none.
    const el: El = { name: name.replace(/^svg:/, ''), attrs, children: [] };
    stack[stack.length - 1].children.push(el);
    if (!selfClose) {
      stack.push(el);
    }
  }

  return root;
}

// ---------------------------------------------------------------- units

const UNIT_MM: Record<string, number> = { mm: 1, cm: 10, in: 25.4, pt: 25.4 / 72, pc: 25.4 / 6, px: 25.4 / 96, '': 25.4 / 96 };

function lengthMM(text: string | undefined): number | null {
  const match = text?.trim().match(/^([-+]?[\d.]+(?:e[-+]?\d+)?)\s*(mm|cm|in|pt|pc|px)?$/i);

  return match ? Number(match[1]) * UNIT_MM[(match[2] ?? '').toLowerCase()] : null;
}

// ---------------------------------------------------------------- import

export interface SvgImport {
  entities: SketchEntity[];
  /** Size of the drawing in mm. */
  size: Vec2;
}

export function parseSVG(text: string): SvgImport {
  const doc = parseXml(text);
  const svg = findFirst(doc, 'svg');
  if (!svg) {
    throw new Error('Not an SVG file');
  }
  // User units → mm, from width + viewBox (no width: 96 px per inch).
  const vb = svg.attrs.viewBox ? nums(svg.attrs.viewBox) : null;
  const width = lengthMM(svg.attrs.width);
  const height = lengthMM(svg.attrs.height);
  // Without a viewBox one user unit is one CSS pixel; with one, width (or height) sets the scale.
  let px = UNIT_MM.px;
  if (vb && vb.length === 4 && vb[2] > 0 && vb[3] > 0) {
    px = width !== null ? width / vb[2] : height !== null ? height / vb[3] : UNIT_MM.px;
  }
  const [kx, ky] = [px, px];
  const ox = vb?.[0] ?? 0;
  const oy = vb?.[1] ?? 0;
  // SVG y points down; the sketch's y points up.
  const base: M = mul([kx, 0, 0, -ky, 0, 0], [1, 0, 0, 1, -ox, -oy]);
  const out: SketchEntity[] = [];
  walk(svg, base, out);
  if (!out.length) {
    throw new Error('No shapes found (text has to be converted to paths first)');
  }
  // Centre on the origin.
  const pts = out.flatMap(samplePoints);
  const lo: Vec2 = [Math.min(...pts.map(point => point[0])), Math.min(...pts.map(point => point[1]))];
  const hi: Vec2 = [Math.max(...pts.map(point => point[0])), Math.max(...pts.map(point => point[1]))];
  const center: Vec2 = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2];

  return { entities: out.map(e => shift(e, -center[0], -center[1])), size: [hi[0] - lo[0], hi[1] - lo[1]] };
}

function findFirst(el: El, name: string): El | null {
  if (el.name === name) {
    return el;
  }
  for (const child of el.children) {
    const first = findFirst(child, name);
    if (first) {
      return first;
    }
  }

  return null;
}

const SKIP = new Set(['defs', 'clipPath', 'mask', 'symbol', 'marker', 'pattern', 'style', 'title', 'desc', 'metadata', 'text', 'linearGradient', 'radialGradient', 'filter', 'image']);

function walk(el: El, parent: M, out: SketchEntity[]): void {
  for (const child of el.children) {
    if (SKIP.has(child.name) || /display\s*:\s*none/.test(child.attrs.style ?? '') || child.attrs.display === 'none') {
      continue;
    }
    const matrix = mul(parent, parseTransform(child.attrs.transform));
    const attrNumber = (key: string, fallback = 0) => (child.attrs[key] !== undefined ? Number(nums(child.attrs[key])[0] ?? fallback) : fallback);
    switch (child.name) {
      case 'g':
      case 'svg':
      case 'a':
      case 'switch':
        walk(child, child.name === 'svg' ? mul(matrix, [1, 0, 0, 1, attrNumber('x'), attrNumber('y')]) : matrix, out);
        break;
      case 'path':
        out.push(...pathEntities(child.attrs.d ?? '', matrix));
        break;
      case 'line':
        out.push(line(ap(matrix, [attrNumber('x1'), attrNumber('y1')]), ap(matrix, [attrNumber('x2'), attrNumber('y2')])));
        break;
      case 'polyline':
      case 'polygon': {
        const values = nums(child.attrs.points ?? '');
        const points: Vec2[] = [];
        for (let i = 0; i + 1 < values.length; i += 2) {
          points.push(ap(matrix, [values[i], values[i + 1]]));
        }
        for (let i = 0; i + 1 < points.length; i++) {
          out.push(line(points[i], points[i + 1]));
        }
        if (child.name === 'polygon' && points.length > 2) {
          out.push(line(points[points.length - 1], points[0]));
        }
        break;
      }
      case 'rect': {
        const [x, y, width, height] = [attrNumber('x'), attrNumber('y'), attrNumber('width'), attrNumber('height')];
        if (width <= 0 || height <= 0) {
          break;
        }
        const rx = Math.min(attrNumber('rx', attrNumber('ry')), width / 2);
        const ry = Math.min(attrNumber('ry', rx), height / 2);
        const sim = similarity(matrix);
        if (!rx && !ry && sim) {
          const ctr = ap(matrix, [x + width / 2, y + height / 2]);
          out.push({ id: uid(), kind: 'rect', center: ctr, w: width * sim.k, h: height * sim.k, rotation: Math.atan2(matrix[1], matrix[0]) });
        } else {
          // Rounded (or skewed): as a path.
          const pathData = rx || ry
            ? `M${x + rx},${y}H${x + width - rx}A${rx},${ry} 0 0 1 ${x + width},${y + ry}V${y + height - ry}A${rx},${ry} 0 0 1 ${x + width - rx},${y + height}H${x + rx}A${rx},${ry} 0 0 1 ${x},${y + height - ry}V${y + ry}A${rx},${ry} 0 0 1 ${x + rx},${y}Z`
            : `M${x},${y}H${x + width}V${y + height}H${x}Z`;
          out.push(...pathEntities(pathData, matrix));
        }
        break;
      }
      case 'circle':
      case 'ellipse': {
        const cx = attrNumber('cx');
        const cy = attrNumber('cy');
        const rx = child.name === 'circle' ? attrNumber('r') : attrNumber('rx');
        const ry = child.name === 'circle' ? attrNumber('r') : attrNumber('ry', rx);
        if (rx <= 0 || ry <= 0) {
          break;
        }
        const sim = similarity(matrix);
        const ctr = ap(matrix, [cx, cy]);
        if (sim && Math.abs(rx - ry) < 1e-12) {
          out.push({ id: uid(), kind: 'circle', center: ctr, radius: rx * sim.k });
        } else if (sim) {
          out.push({ id: uid(), kind: 'ellipse', center: ctr, rx: rx * sim.k, ry: ry * sim.k, rotation: sim.rot });
        } else {
          out.push(closedSpline(Array.from({ length: 24 }, (_, i) => ap(matrix, [cx + rx * Math.cos((i / 24) * Math.PI * 2), cy + ry * Math.sin((i / 24) * Math.PI * 2)]))));
        }
        break;
      }
    }
  }
}

// ---------------------------------------------------------------- paths

/** One SVG path's curves. */
export function pathEntities(pathData: string, matrix: M = identity): SketchEntity[] {
  const out: SketchEntity[] = [];
  const toks = pathData.match(/[a-df-z]|[-+]?(?:\d*\.\d+|\d+\.?)(?:e[-+]?\d+)?/gi) ?? [];
  let i = 0;
  let cmd = '';
  let cur: Vec2 = [0, 0];
  let start: Vec2 = [0, 0];
  let lastCtrl: Vec2 | null = null;
  let lastQ: Vec2 | null = null;
  const num = () => Number(toks[i++]);
  const more = () => i < toks.length && !/^[a-z]$/i.test(toks[i]);
  const place = (point: Vec2) => ap(matrix, point);
  const sim = similarity(matrix);
  while (i < toks.length) {
    if (/^[a-z]$/i.test(toks[i])) {
      cmd = toks[i++];
    }
    const rel = cmd === cmd.toLowerCase();
    const absolute = (point: Vec2): Vec2 => (rel ? [cur[0] + point[0], cur[1] + point[1]] : point);
    const command = cmd.toUpperCase();
    if (command === 'Z') {
      if (Math.hypot(cur[0] - start[0], cur[1] - start[1]) > 1e-12) {
        out.push(line(place(cur), place(start)));
      }
      cur = start;
      lastCtrl = lastQ = null;
      if (!more()) {
        continue;
      }
      cmd = rel ? 'l' : 'L';
      continue;
    }
    if (!more()) {
      break;
    }
    switch (command) {
      case 'M': {
        cur = absolute([num(), num()]);
        start = cur;
        cmd = rel ? 'l' : 'L';
        lastCtrl = lastQ = null;
        continue;
      }
      case 'L':
      case 'H':
      case 'V': {
        const point: Vec2 = command === 'L' ? absolute([num(), num()]) : command === 'H' ? [rel ? cur[0] + num() : num(), cur[1]] : [cur[0], rel ? cur[1] + num() : num()];
        if (Math.hypot(point[0] - cur[0], point[1] - cur[1]) > 1e-12) {
          out.push(line(place(cur), place(point)));
        }
        cur = point;
        lastCtrl = lastQ = null;
        break;
      }
      case 'C':
      case 'S': {
        const c1: Vec2 = command === 'C' ? absolute([num(), num()]) : lastCtrl ? [2 * cur[0] - lastCtrl[0], 2 * cur[1] - lastCtrl[1]] : cur;
        const c2 = absolute([num(), num()]);
        const point = absolute([num(), num()]);
        out.push(bezierSpline([cur, c1, c2, point].map(place)));
        lastCtrl = c2;
        lastQ = null;
        cur = point;
        break;
      }
      case 'Q':
      case 'T': {
        const q: Vec2 = command === 'Q' ? absolute([num(), num()]) : lastQ ? [2 * cur[0] - lastQ[0], 2 * cur[1] - lastQ[1]] : cur;
        const point = absolute([num(), num()]);
        // Quadratic → cubic.
        const c1: Vec2 = [cur[0] + (2 / 3) * (q[0] - cur[0]), cur[1] + (2 / 3) * (q[1] - cur[1])];
        const c2: Vec2 = [point[0] + (2 / 3) * (q[0] - point[0]), point[1] + (2 / 3) * (q[1] - point[1])];
        out.push(bezierSpline([cur, c1, c2, point].map(place)));
        lastQ = q;
        lastCtrl = null;
        cur = point;
        break;
      }
      case 'A': {
        const rx0 = Math.abs(num());
        const ry0 = Math.abs(num());
        const phi = (num() * Math.PI) / 180;
        const large = num() !== 0;
        const sweep = num() !== 0;
        const point = absolute([num(), num()]);
        out.push(...arcEntities(cur, point, rx0, ry0, phi, large, sweep, matrix, sim));
        cur = point;
        lastCtrl = lastQ = null;
        break;
      }
      default:
        i++;
    }
  }

  return out;
}

/** SVG endpoint arc → one arc (circular, under a similarity) or a spline through it. */
function arcEntities(a: Vec2, b: Vec2, rx: number, ry: number, phi: number, large: boolean, sweep: boolean, matrix: M, sim: { k: number } | null): SketchEntity[] {
  if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 1e-12) {
    return [];
  }
  if (!rx || !ry) {
    return [line(ap(matrix, a), ap(matrix, b))];
  }
  // Endpoint → centre parameterisation (SVG spec, F.6.5).
  const cs = Math.cos(phi);
  const sn = Math.sin(phi);
  const dx = (a[0] - b[0]) / 2;
  const dy = (a[1] - b[1]) / 2;
  const x1 = cs * dx + sn * dy;
  const y1 = -sn * dx + cs * dy;
  const lam = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
  if (lam > 1) {
    rx *= Math.sqrt(lam);
    ry *= Math.sqrt(lam);
  }
  const num = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1;
  const den = rx * rx * y1 * y1 + ry * ry * x1 * x1;
  const co = (large !== sweep ? 1 : -1) * Math.sqrt(Math.max(0, num / den));
  const cx1 = (co * rx * y1) / ry;
  const cy1 = (-co * ry * x1) / rx;
  const cx = cs * cx1 - sn * cy1 + (a[0] + b[0]) / 2;
  const cy = sn * cx1 + cs * cy1 + (a[1] + b[1]) / 2;
  const ang = (ux: number, uy: number, vx: number, vy: number) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  const t1 = ang(1, 0, (x1 - cx1) / rx, (y1 - cy1) / ry);
  let dt = ang((x1 - cx1) / rx, (y1 - cy1) / ry, (-x1 - cx1) / rx, (-y1 - cy1) / ry);
  if (!sweep && dt > 0) {
    dt -= 2 * Math.PI;
  }
  if (sweep && dt < 0) {
    dt += 2 * Math.PI;
  }
  const at = (t: number): Vec2 => ap(matrix, [cx + rx * Math.cos(t) * cs - ry * Math.sin(t) * sn, cy + rx * Math.cos(t) * sn + ry * Math.sin(t) * cs]);
  if (sim && Math.abs(rx - ry) < 1e-9 * rx) {
    // A full-ish circle is split in two so each arc's three points stay well apart.
    if (Math.abs(dt) > Math.PI * 1.5) {
      const half = dt / 2;

      return [arc3(at(t1), at(t1 + half / 2), at(t1 + half)), arc3(at(t1 + half), at(t1 + half * 1.5), at(t1 + dt))];
    }

    return [arc3(at(t1), at(t1 + dt / 2), at(t1 + dt))];
  }
  const segmentCount = Math.max(4, Math.ceil((Math.abs(dt) / (Math.PI / 2)) * 4));

  return [{ id: uid(), kind: 'spline', mode: 'fit', closed: false, points: Array.from({ length: segmentCount + 1 }, (_, step) => at(t1 + (dt * step) / segmentCount)) }];
}

/** A cubic Bézier as a fit spline through points on it (ends exact). */
function bezierSpline([p0, p1, p2, p3]: Vec2[]): SketchEntity {
  // Straight "curves" stay lines.
  const off = (point: Vec2) => {
    const dx = p3[0] - p0[0];
    const dy = p3[1] - p0[1];
    const length = Math.hypot(dx, dy) || 1;

    return Math.abs((point[0] - p0[0]) * dy - (point[1] - p0[1]) * dx) / length;
  };
  if (off(p1) < 1e-9 && off(p2) < 1e-9) {
    return line(p0, p3);
  }
  const steps = 8;
  const pts = Array.from({ length: steps + 1 }, (_, step): Vec2 => {
    const t = step / steps;
    const oneMinusT = 1 - t;

    return [oneMinusT * oneMinusT * oneMinusT * p0[0] + 3 * oneMinusT * oneMinusT * t * p1[0] + 3 * oneMinusT * t * t * p2[0] + t * t * t * p3[0], oneMinusT * oneMinusT * oneMinusT * p0[1] + 3 * oneMinusT * oneMinusT * t * p1[1] + 3 * oneMinusT * t * t * p2[1] + t * t * t * p3[1]];
  });

  return { id: uid(), kind: 'spline', mode: 'fit', closed: false, points: pts };
}

const line = (a: Vec2, b: Vec2): SketchEntity => ({ id: uid(), kind: 'line', a, b });
const arc3 = (a: Vec2, middle: Vec2, b: Vec2): SketchEntity => ({ id: uid(), kind: 'arc', a, m: middle, b });
const closedSpline = (points: Vec2[]): SketchEntity => ({ id: uid(), kind: 'spline', mode: 'fit', closed: true, points });

function samplePoints(e: SketchEntity): Vec2[] {
  switch (e.kind) {
    case 'line':
      return [e.a, e.b];
    case 'arc':
      return [e.a, e.m, e.b];
    case 'circle':
      return [[e.center[0] - e.radius, e.center[1] - e.radius], [e.center[0] + e.radius, e.center[1] + e.radius]];
    case 'ellipse': {
      const radius = Math.max(e.rx, e.ry);

      return [[e.center[0] - radius, e.center[1] - radius], [e.center[0] + radius, e.center[1] + radius]];
    }
    case 'rect': {
      const cos = Math.cos(e.rotation);
      const sin = Math.sin(e.rotation);

      return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([cornerU, cornerV]): Vec2 => [e.center[0] + (cornerU * e.w * cos - cornerV * e.h * sin) / 2, e.center[1] + (cornerU * e.w * sin + cornerV * e.h * cos) / 2]);
    }
    case 'spline':
    case 'polyline':
      return e.points;
    default:
      return [];
  }
}

function shift(e: SketchEntity, dx: number, dy: number): SketchEntity {
  const shiftPoint = (point: Vec2): Vec2 => [point[0] + dx, point[1] + dy];
  switch (e.kind) {
    case 'line':
      return { ...e, a: shiftPoint(e.a), b: shiftPoint(e.b) };
    case 'arc':
      return { ...e, a: shiftPoint(e.a), m: shiftPoint(e.m), b: shiftPoint(e.b) };
    case 'circle':
    case 'ellipse':
    case 'rect':
    case 'polygon':
      return { ...e, center: shiftPoint(e.center) };
    case 'spline':
    case 'polyline':
      return { ...e, points: e.points.map(shiftPoint) };
    default:
      return e;
  }
}

/**
 * A sketch's curves as an SVG file's text: millimetres, the page just round the drawing, up as in the sketch (SVG's
 * y runs down, so it is turned over). Lines, circles and arcs stay exact; ellipses and splines are fine polylines.
 * Construction curves are in a group of their own, dashed.
 */
export function sketchToSVG(entities: SketchEntity[], title = 'Sketch'): string {
  const formatNumber = (value: number) => String(Math.round(value * 1e4) / 1e4 || 0);
  const pt = (point: Vec2) => `${formatNumber(point[0])} ${formatNumber(-point[1])}`;
  let lo: Vec2 = [Infinity, Infinity];
  let hi: Vec2 = [-Infinity, -Infinity];
  const see = (point: Vec2) => {
    lo = [Math.min(lo[0], point[0]), Math.min(lo[1], -point[1])];
    hi = [Math.max(hi[0], point[0]), Math.max(hi[1], -point[1])];
  };
  const TAU = Math.PI * 2;
  const draw = (prim: Prim): string => {
    if (prim.t === 'line') {
      see(prim.a);
      see(prim.b);

      return `<path d="M${pt(prim.a)} L${pt(prim.b)}"/>`;
    }
    if (prim.t === 'circle') {
      const at = (t: number): Vec2 => [prim.c[0] + prim.r * Math.cos(t), prim.c[1] + prim.r * Math.sin(t)];
      // (Its whole round counted for the page's size: an arc can bulge past its ends.)
      for (const q of samplePrim(prim, 0, 1, 32)) {
        see(q);
      }
      if (Math.abs(Math.abs(prim.sweep) - TAU) < 1e-9) {
        return `<circle cx="${formatNumber(prim.c[0])}" cy="${formatNumber(-prim.c[1])}" r="${formatNumber(prim.r)}"/>`;
      }

      // Turned over, anticlockwise in the sketch is clockwise on the page: sweep flag 0 for a positive sweep.
      return `<path d="M${pt(at(prim.a0))} A${formatNumber(prim.r)} ${formatNumber(prim.r)} 0 ${Math.abs(prim.sweep) > Math.PI ? 1 : 0} ${prim.sweep > 0 ? 0 : 1} ${pt(at(prim.a0 + prim.sweep))}"/>`;
    }
    const closed = prim.t === 'spline' ? prim.closed : Math.abs(Math.abs(prim.sweep) - TAU) < 1e-9;
    let pts = samplePrim(prim, 0, 1, prim.t === 'spline' ? Math.max(64, prim.pts.length * 16) : 128);
    if (closed && pts.length > 1) {
      pts = pts.slice(0, -1);
    }
    pts.forEach(see);

    return `<path d="M${pts.map(pt).join(' L')}${closed ? ' Z' : ''}"/>`;
  };
  const solid: string[] = [];
  const construction: string[] = [];
  for (const e of entities) {
    for (const entityPrim of entityPrims(e)) {
      (e.construction ? construction : solid).push(draw(entityPrim));
    }
  }
  if (!Number.isFinite(lo[0])) {
    [lo, hi] = [[0, 0], [1, 1]];
  }
  const pad = Math.max(1, Math.max(hi[0] - lo[0], hi[1] - lo[1]) * 0.02);
  const width = hi[0] - lo[0] + pad * 2;
  const height = hi[1] - lo[1] + pad * 2;
  const stroke = Math.max(0.05, Math.min(0.35, Math.max(width, height) / 600));
  const safe = title.replace(/[<>&]/g, '');

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" width="${formatNumber(width)}mm" height="${formatNumber(height)}mm" viewBox="${formatNumber(lo[0] - pad)} ${formatNumber(lo[1] - pad)} ${formatNumber(width)} ${formatNumber(height)}">`,
    `<title>${safe}</title>`,
    `<g fill="none" stroke="#000" stroke-width="${formatNumber(stroke)}" stroke-linecap="round" stroke-linejoin="round">`,
    ...solid,
    '</g>',
    ...(construction.length ? [`<g id="construction" fill="none" stroke="#888" stroke-width="${formatNumber(stroke)}" stroke-dasharray="${formatNumber(stroke * 6)} ${formatNumber(stroke * 4)}">`, ...construction, '</g>'] : []),
    '</svg>',
    ''
  ].join('\n');
}
