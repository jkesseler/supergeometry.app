// Sketch curve math, shared by the UI and the kernel worker.
// Every sketch entity is broken into primitives (line / circular arc /
// elliptical arc / spline) that can be evaluated at a parameter t ∈ [0, 1].

import { toWorld } from '../geom';
import type { PlaneDef, SketchEntity, Vec2, Vec3 } from '../doc/types';

export type Prim =
  | { t: 'line'; a: Vec2; b: Vec2; src: string }
  | { t: 'circle'; c: Vec2; r: number; a0: number; sweep: number; src: string }
  | { t: 'ellipse'; c: Vec2; rx: number; ry: number; rot: number; a0: number; sweep: number; src: string }
  | { t: 'spline'; pts: Vec2[]; closed: boolean; src: string; ctrl?: SplineDef };

/** The points a spline was drawn with (its samples are 16 per span of these). */
export interface SplineDef {
  points: Vec2[];
  closed: boolean;
  mode: 'fit' | 'control';
}

export const SPLINE_PER_SPAN = 16;

const TAU = Math.PI * 2;

export function evalPrim(prim: Prim, t: number): Vec2 {
  switch (prim.t) {
    case 'line':
      return [prim.a[0] + (prim.b[0] - prim.a[0]) * t, prim.a[1] + (prim.b[1] - prim.a[1]) * t];
    case 'circle': {
      const ang = prim.a0 + prim.sweep * t;

      return [prim.c[0] + prim.r * Math.cos(ang), prim.c[1] + prim.r * Math.sin(ang)];
    }
    case 'ellipse': {
      const ang = prim.a0 + prim.sweep * t;
      const x = prim.rx * Math.cos(ang);
      const y = prim.ry * Math.sin(ang);
      const cos = Math.cos(prim.rot);
      const sin = Math.sin(prim.rot);

      return [prim.c[0] + x * cos - y * sin, prim.c[1] + x * sin + y * cos];
    }
    case 'spline': {
      const spans = prim.pts.length - 1;
      const position = Math.min(Math.max(t, 0), 1) * spans;
      const i = Math.min(Math.floor(position), spans - 1);
      const fraction = position - i;
      const a = prim.pts[i];
      const b = prim.pts[i + 1];

      return [a[0] + (b[0] - a[0]) * fraction, a[1] + (b[1] - a[1]) * fraction];
    }
  }
}

export function isClosedPrim(prim: Prim): boolean {
  if (prim.t === 'circle' || prim.t === 'ellipse') {
    return Math.abs(Math.abs(prim.sweep) - TAU) < 1e-9;
  }
  if (prim.t === 'spline') {
    return prim.closed;
  }

  return false;
}

/** Number of straight segments used to approximate a primitive. */
export function primSegments(prim: Prim): number {
  switch (prim.t) {
    case 'line':
      return 1;
    case 'circle':
    case 'ellipse':
      return Math.max(6, Math.ceil((Math.abs(prim.sweep) / TAU) * 96));
    case 'spline':
      return prim.pts.length - 1;
  }
}

/** Break an entity into primitives. Construction geometry still yields prims (for drawing). */
export function entityPrims(e: SketchEntity): Prim[] {
  const src = e.id;
  switch (e.kind) {
    case 'line':
      return [{ t: 'line', a: e.a, b: e.b, src }];
    case 'arc': {
      const arc = arcFrom3(e.a, e.m, e.b);
      if (!arc) {
        return [{ t: 'line', a: e.a, b: e.b, src }];
      }

      return [{ t: 'circle', c: arc.c, r: arc.r, a0: arc.a0, sweep: arc.sweep, src }];
    }
    case 'circle':
      return [{ t: 'circle', c: e.center, r: e.radius, a0: 0, sweep: TAU, src }];
    case 'ellipse':
      return [{ t: 'ellipse', c: e.center, rx: e.rx, ry: e.ry, rot: e.rotation, a0: e.sweep === undefined ? 0 : (e.a0 ?? 0), sweep: e.sweep ?? TAU, src }];
    case 'spline':
      return [{ t: 'spline', pts: splinePoints(e.points, e.closed, e.mode), closed: e.closed && e.points.length > 2, src, ...(e.points.length > 2 ? { ctrl: { points: e.points, closed: e.closed, mode: e.mode } } : {}) }];
    case 'rect':
    case 'polygon':
    case 'polyline': {
      const pts = entityCorners(e);
      const closed = e.kind !== 'polyline' || e.closed;
      const out: Prim[] = [];
      for (let i = 0; i < pts.length - (closed ? 0 : 1); i++) {
        out.push({ t: 'line', a: pts[i], b: pts[(i + 1) % pts.length], src });
      }

      return out;
    }
  }
}

/** Corner points of straight-sided entities. */
export function entityCorners(e: Extract<SketchEntity, { kind: 'rect' | 'polygon' | 'polyline' }>): Vec2[] {
  if (e.kind === 'polyline') {
    return e.points;
  }
  if (e.kind === 'polygon') {
    return Array.from({ length: e.sides }, (_, i) => {
      const t = e.angle + (i / e.sides) * TAU;

      return [e.center[0] + e.radius * Math.cos(t), e.center[1] + e.radius * Math.sin(t)] as Vec2;
    });
  }
  const cos = Math.cos(e.rotation);
  const sin = Math.sin(e.rotation);
  const hw = e.w / 2;
  const hh = e.h / 2;

  return ([
    [-hw, -hh],
    [hw, -hh],
    [hw, hh],
    [-hw, hh]
  ] as Vec2[]).map(([x, y]) => [e.center[0] + x * cos - y * sin, e.center[1] + x * sin + y * cos] as Vec2);
}

/** A spline's heights off its sketch's plane, one for each of its points - null when it is flat (or they don't fit its points). */
export function splineHeights(e: SketchEntity): number[] | null {
  if (e.kind !== 'spline' || !e.z || e.z.length !== e.points.length || !e.z.some(value => Math.abs(value) > 1e-12)) {
    return null;
  }

  return e.z;
}

/**
 * The height at each point of the spline's drawn polyline (entityPolylines' own points, in step with them): the
 * heights of its points run through the same curve as their places. Null for a flat one.
 */
export function splineHeightSamples(e: SketchEntity): number[] | null {
  const z = splineHeights(e);
  if (!z || e.kind !== 'spline') {
    return null;
  }

  return splinePoints(z.map((value): Vec2 => [value, 0]), e.closed && e.points.length > 2, e.mode).map(splinePoint => splinePoint[0]);
}

/**
 * An entity's drawn polylines where they are in space: on the sketch's plane - and a spline with points off the
 * plane up where it runs. (What picks a place on a curve - a plane on it, a preview along it - goes by this, not by
 * the curve's shadow on the plane.)
 */
export function entityWorldPolylines(e: SketchEntity, plane: PlaneDef): Vec3[][] {
  const high = splineHeightSamples(e);
  const normal = plane.normal;

  return entityPolylines(e).map(poly =>
    poly.map((q, i) => {
      const at = toWorld(plane, q);
      const height = high ? (high[Math.min(i, high.length - 1)] ?? 0) : 0;

      return height ? ([at[0] + normal[0] * height, at[1] + normal[1] * height, at[2] + normal[2] * height] as Vec3) : at;
    })
  );
}

/** Dense polyline for drawing an entity. */
export function entityPolylines(e: SketchEntity): Vec2[][] {
  return entityPrims(e).map(entityPrim => samplePrim(entityPrim, 0, 1));
}

export function samplePrim(prim: Prim, t0: number, t1: number, segs?: number): Vec2[] {
  const segmentCount = segs ?? Math.max(1, Math.ceil(primSegments(prim) * Math.abs(t1 - t0)));
  if (prim.t === 'spline') {
    // Follow the stored samples exactly so pieces line up with the full curve.
    const spans = prim.pts.length - 1;
    const out: Vec2[] = [evalPrim(prim, t0)];
    const lo = Math.min(t0, t1) * spans;
    const hi = Math.max(t0, t1) * spans;
    const inner: Vec2[] = [];
    for (let i = Math.floor(lo) + 1; i < hi - 1e-9; i++) {
      inner.push(prim.pts[i]);
    }
    if (t1 < t0) {
      inner.reverse();
    }
    out.push(...inner, evalPrim(prim, t1));

    return out;
  }

  return Array.from({ length: segmentCount + 1 }, (_, i) => evalPrim(prim, t0 + ((t1 - t0) * i) / segmentCount));
}

/** Circle through three points, with the sweep that passes through the middle one. */
export function arcFrom3(a: Vec2, middle: Vec2, b: Vec2): { c: Vec2; r: number; a0: number; sweep: number } | null {
  const ax = a[0];
  const ay = a[1];
  const bx = middle[0];
  const by = middle[1];
  const cx = b[0];
  const cy = b[1];
  const denominator = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
  if (Math.abs(denominator) < 1e-12) {
    return null;
  }
  const ux = ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay) + (cx * cx + cy * cy) * (ay - by)) / denominator;
  const uy = ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx) + (cx * cx + cy * cy) * (bx - ax)) / denominator;
  const radius = Math.hypot(ax - ux, ay - uy);
  const a0 = Math.atan2(ay - uy, ax - ux);
  const am = Math.atan2(by - uy, bx - ux);
  const a1 = Math.atan2(cy - uy, cx - ux);
  const ccw = (x: number) => ((x % TAU) + TAU) % TAU;
  const toM = ccw(am - a0);
  const toB = ccw(a1 - a0);
  const sweep = toM < toB ? toB : toB - TAU;

  return { c: [ux, uy], r: radius, a0, sweep };
}

/**
 * Densely sampled spline. "fit" passes through the points (centripetal
 * Catmull-Rom); "control" treats them as B-spline control points.
 */
export function splinePoints(pts: Vec2[], closed: boolean, mode: 'fit' | 'control', perSpan = 16): Vec2[] {
  if (pts.length < 2) {
    return pts.slice();
  }
  if (pts.length === 2) {
    return [pts[0], pts[1]];
  }
  const count = pts.length;
  const get = (i: number): Vec2 => pointAt(pts, i, closed, mode);
  const spans = closed ? count : count - 1;
  const out: Vec2[] = [];
  for (let span = 0; span < spans; span++) {
    for (let step = 0; step < perSpan; step++) {
      const fraction = step / perSpan;
      out.push(mode === 'fit' ? catmull(get(span - 1), get(span), get(span + 1), get(span + 2), fraction) : bspline(get(span - 1), get(span), get(span + 1), get(span + 2), fraction));
    }
  }
  if (closed) {
    out.push(out[0]);
  } else {
    out.push(pts[count - 1]);
  }

  return out;
}

/** Exact point on span `span` of a spline (each span is one cubic), `fraction` in [0, 1]. */
export function splineSpanAt(splineDefinition: SplineDef, span: number, fraction: number): Vec2 {
  const get = (i: number): Vec2 => pointAt(splineDefinition.points, i, splineDefinition.closed, splineDefinition.mode);

  return splineDefinition.mode === 'fit' ? catmull(get(span - 1), get(span), get(span + 1), get(span + 2), fraction) : bspline(get(span - 1), get(span), get(span + 1), get(span + 2), fraction);
}

/** Number of cubic spans of a spline. */
export function splineSpans(splineDefinition: SplineDef): number {
  return splineDefinition.closed ? splineDefinition.points.length : splineDefinition.points.length - 1;
}

/**
 * Point i of a spline's list, past the ends too: closed splines wrap; an open
 * spline gets a mirrored point beyond each end, so it starts and ends exactly
 * on its first and last point (control-point splines too - no gap at the
 * ends) and leaves them heading towards the neighbour (a repeated end point
 * would leave it at a tangent of its own making - e.g. along a revolve axis,
 * which can't revolve).
 */
function pointAt(pts: Vec2[], i: number, closed: boolean, _mode: 'fit' | 'control'): Vec2 {
  const count = pts.length;
  if (closed) {
    return pts[((i % count) + count) % count];
  }
  if (count >= 2) {
    if (i < 0) {
      return [2 * pts[0][0] - pts[1][0], 2 * pts[0][1] - pts[1][1]];
    }
    if (i > count - 1) {
      return [2 * pts[count - 1][0] - pts[count - 2][0], 2 * pts[count - 1][1] - pts[count - 2][1]];
    }
  }

  return pts[Math.max(0, Math.min(count - 1, i))];
}

function catmull(p0: Vec2, p1: Vec2, p2: Vec2, p3: Vec2, fraction: number): Vec2 {
  // Centripetal parameterisation avoids cusps and self-intersections.
  const knotGap = (a: Vec2, b: Vec2) => Math.max(1e-9, Math.sqrt(Math.hypot(a[0] - b[0], a[1] - b[1])));
  const t0 = 0;
  const t1 = t0 + knotGap(p0, p1);
  const t2 = t1 + knotGap(p1, p2);
  const t3 = t2 + knotGap(p2, p3);
  const t = t1 + (t2 - t1) * fraction;
  const lerp = (a: Vec2, b: Vec2, ta: number, tb: number): Vec2 => {
    const weight = (t - ta) / (tb - ta || 1e-9);

    return [a[0] + (b[0] - a[0]) * weight, a[1] + (b[1] - a[1]) * weight];
  };
  const a1 = lerp(p0, p1, t0, t1);
  const a2 = lerp(p1, p2, t1, t2);
  const a3 = lerp(p2, p3, t2, t3);
  const b1 = lerp(a1, a2, t0, t2);
  const b2 = lerp(a2, a3, t1, t3);

  return lerp(b1, b2, t1, t2);
}

function bspline(p0: Vec2, p1: Vec2, p2: Vec2, p3: Vec2, fraction: number): Vec2 {
  const u2 = fraction * fraction;
  const u3 = u2 * fraction;
  const b0 = (1 - 3 * fraction + 3 * u2 - u3) / 6;
  const b1 = (4 - 6 * u2 + 3 * u3) / 6;
  const b2 = (1 + 3 * fraction + 3 * u2 - 3 * u3) / 6;
  const b3 = u3 / 6;

  return [b0 * p0[0] + b1 * p1[0] + b2 * p2[0] + b3 * p3[0], b0 * p0[1] + b1 * p1[1] + b2 * p2[1] + b3 * p3[1]];
}

/** Closest parameter on a primitive to a point (coarse sample + refinement). */
export function closestOnPrim(prim: Prim, q: Vec2): { t: number; d: number; pt: Vec2 } {
  const samples = Math.max(16, primSegments(prim) * 2);
  let best = { t: 0, d: Infinity, pt: evalPrim(prim, 0) };
  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    const pt = evalPrim(prim, t);
    const distance = Math.hypot(pt[0] - q[0], pt[1] - q[1]);
    if (distance < best.d) {
      best = { t, d: distance, pt };
    }
  }
  let step = 1 / samples;
  for (let iteration = 0; iteration < 30; iteration++) {
    step /= 2;
    for (const t of [best.t - step, best.t + step]) {
      if (t < 0 || t > 1) {
        continue;
      }
      const pt = evalPrim(prim, t);
      const distance = Math.hypot(pt[0] - q[0], pt[1] - q[1]);
      if (distance < best.d) {
        best = { t, d: distance, pt };
      }
    }
  }

  return best;
}

export function polyArea(poly: Vec2[]): number {
  let a = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    a += (poly[j][0] + poly[i][0]) * (poly[j][1] - poly[i][1]);
  }

  return -a / 2;
}

export function polyCentroid(poly: Vec2[]): Vec2 {
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const cross = poly[j][0] * poly[i][1] - poly[i][0] * poly[j][1];
    a += cross;
    cx += (poly[j][0] + poly[i][0]) * cross;
    cy += (poly[j][1] + poly[i][1]) * cross;
  }
  if (Math.abs(a) < 1e-12) {
    return poly[0] ?? [0, 0];
  }

  return [cx / (3 * a), cy / (3 * a)];
}

export function pointInPoly(point: Vec2, poly: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > point[1] !== yj > point[1] && point[0] < ((xj - xi) * (point[1] - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }

  return inside;
}
