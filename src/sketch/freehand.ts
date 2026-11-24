// Freehand drawing (Spline > Draw): a pencil stroke made into a few clean curves.
//
// A stroke is hundreds of points; drawn as is it would be hundreds of edges.
// Here it is cut at its sharp corners, and each run between corners becomes
// the simplest curve that stays within `tol` of where the pointer went: a
// line, an arc, or a fit spline through as few points as that takes. A closed
// stroke without corners that is round enough becomes a circle.

import { splinePoints } from './curves';
import type { Vec2 } from '../doc/types';

export type FreehandPiece =
  | { kind: 'line'; a: Vec2; b: Vec2 }
  | { kind: 'arc'; a: Vec2; m: Vec2; b: Vec2 }
  | { kind: 'circle'; center: Vec2; radius: number }
  | { kind: 'spline'; points: Vec2[]; closed: boolean };

export interface Freehand {
  pieces: FreehandPiece[];
  /** The stroke ended where it began: the pieces make one closed outline. */
  closed: boolean;
}

const dist = (a: Vec2, b: Vec2) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** Distance from `point` to the segment a-b. */
function segDist(point: Vec2, a: Vec2, b: Vec2): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const L2 = dx * dx + dy * dy;
  const t = L2 ? Math.max(0, Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / L2)) : 0;

  return Math.hypot(point[0] - a[0] - dx * t, point[1] - a[1] - dy * t);
}

function length(pts: Vec2[]): number {
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    total += dist(pts[i - 1], pts[i]);
  }

  return total;
}

/** Evenly spaced points along a polyline (the ends kept). */
function resample(pts: Vec2[], step: number): Vec2[] {
  const out: Vec2[] = [pts[0]];
  let carry = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const distance = dist(a, b);
    let t = step - carry;
    while (t <= distance) {
      out.push([a[0] + ((b[0] - a[0]) * t) / distance, a[1] + ((b[1] - a[1]) * t) / distance]);
      t += step;
    }
    carry = distance - (t - step);
  }
  const last = pts[pts.length - 1];
  if (dist(out[out.length - 1], last) > step * 0.3) {
    out.push(last);
  } else {
    out[out.length - 1] = last;
  }

  return out;
}

/** Light smoothing (hand jitter), the ends kept unless the stroke is a loop. */
function smooth(pts: Vec2[], loop: boolean, passes = 2): Vec2[] {
  let points = pts;
  const count = points.length;
  for (let pass = 0; pass < passes; pass++) {
    points = points.map((q, i) => {
      if (!loop && (i === 0 || i === count - 1)) {
        return q;
      }
      const a = points[(i - 1 + count) % count];
      const b = points[(i + 1) % count];

      return [(a[0] + 2 * q[0] + b[0]) / 4, (a[1] + 2 * q[1] + b[1]) / 4] as Vec2;
    });
  }

  return points;
}

/** Least-squares circle (Kåsa) through points; null when they are (nearly) straight. */
export function fitCircle(pts: Vec2[]): { c: Vec2; r: number } | null {
  const count = pts.length;
  if (count < 3) {
    return null;
  }
  let mx = 0;
  let my = 0;
  for (const point of pts) {
    (mx += point[0]), (my += point[1]);
  }
  mx /= count;
  my /= count;
  let suu = 0, svv = 0, suv = 0, suuu = 0, svvv = 0, suvv = 0, svuu = 0;
  for (const point of pts) {
    const offsetX = point[0] - mx;
    const offsetY = point[1] - my;
    suu += offsetX * offsetX;
    svv += offsetY * offsetY;
    suv += offsetX * offsetY;
    suuu += offsetX * offsetX * offsetX;
    svvv += offsetY * offsetY * offsetY;
    suvv += offsetX * offsetY * offsetY;
    svuu += offsetY * offsetX * offsetX;
  }
  const det = suu * svv - suv * suv;
  if (Math.abs(det) < 1e-18 * Math.max(1, suu * svv)) {
    return null;
  }
  const b1 = (suuu + suvv) / 2;
  const b2 = (svvv + svuu) / 2;
  const uc = (b1 * svv - b2 * suv) / det;
  const vc = (b2 * suu - b1 * suv) / det;
  const radius = Math.sqrt(uc * uc + vc * vc + (suu + svv) / count);

  return Number.isFinite(radius) ? { c: [mx + uc, my + vc], r: radius } : null;
}

/** Indices of the sharp corners of an evenly spaced stroke. */
function corners(points: Vec2[], loop: boolean, reach: number, minTurn: number): number[] {
  const count = points.length;
  const turn = new Array<number>(count).fill(0);
  for (let i = 0; i < count; i++) {
    if (!loop && (i < reach || i > count - 1 - reach)) {
      continue;
    }
    const a = points[(i - reach + count) % count];
    const b = points[(i + reach) % count];
    const q = points[i];
    const a1 = Math.atan2(q[1] - a[1], q[0] - a[0]);
    const a2 = Math.atan2(b[1] - q[1], b[0] - q[0]);
    let turnAngle = Math.abs(a2 - a1);
    if (turnAngle > Math.PI) {
      turnAngle = 2 * Math.PI - turnAngle;
    }
    turn[i] = turnAngle;
  }
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    if (turn[i] < minTurn) {
      continue;
    }
    // The sharpest spot of the bend (a tie goes to the first).
    let best = true;
    for (let j = -reach; j <= reach && best; j++) {
      if (!j) {
        continue;
      }
      const neighbour = loop ? (i + j + count) % count : i + j;
      if (neighbour < 0 || neighbour >= count) {
        continue;
      }
      if (turn[neighbour] > turn[i] || (turn[neighbour] === turn[i] && j < 0)) {
        best = false;
      }
    }
    if (best) {
      out.push(i);
    }
  }

  return out;
}

/**
 * A run between two corners, as one curve within tol. `exact`: the points lie
 * on the true curve (a font's outline, not a hand's wobble) - lines and arcs
 * must keep to tol itself.
 */
export function fitRun(run: Vec2[], tol: number, exact = false): FreehandPiece {
  const a = run[0];
  const b = run[run.length - 1];
  const runLength = length(run);
  const chord = dist(a, b);
  // Straight enough (a freehand line wobbles a little more than the tolerance).
  const lineTol = exact ? tol : Math.min(Math.max(tol * 1.6, runLength * 0.015), tol * 4);
  if (chord > 0 && run.every(point => segDist(point, a, b) <= lineTol)) {
    return { kind: 'line', a, b };
  }
  // Round enough: an arc (not almost a full turn, and not a huge flat one).
  const circle = fitCircle(run);
  if (circle && circle.r < chord * 20 + runLength) {
    const arcTol = exact ? tol : Math.min(Math.max(tol * 1.5, circle.r * 0.02), tol * 2.5);
    if (run.every(point => Math.abs(dist(point, circle.c) - circle.r) <= arcTol)) {
      let sweep = 0;
      for (let i = 1; i < run.length; i++) {
        const t0 = Math.atan2(run[i - 1][1] - circle.c[1], run[i - 1][0] - circle.c[0]);
        const t1 = Math.atan2(run[i][1] - circle.c[1], run[i][0] - circle.c[0]);
        let sweepStep = t1 - t0;
        if (sweepStep > Math.PI) {
          sweepStep -= 2 * Math.PI;
        }
        if (sweepStep < -Math.PI) {
          sweepStep += 2 * Math.PI;
        }
        sweep += sweepStep;
      }
      if (Math.abs(sweep) < Math.PI * 1.75 && Math.abs(sweep) > 0.2) {
        const onC = (point: Vec2): Vec2 => {
          const distance = dist(point, circle.c) || 1;

          return [circle.c[0] + ((point[0] - circle.c[0]) * circle.r) / distance, circle.c[1] + ((point[1] - circle.c[1]) * circle.r) / distance];
        };

        // Ends stay where they were drawn (they join the next piece); the middle on the circle.
        return { kind: 'arc', a, m: onC(run[Math.floor(run.length / 2)]), b };
      }
    }
  }

  return { kind: 'spline', points: fitSpline(run, false, tol), closed: false };
}

/**
 * As few fit points as keep the spline within tol of the stroke: start from a
 * handful and add the stroke point where the spline strays furthest, until it
 * doesn't.
 */
export function fitSpline(run: Vec2[], loop: boolean, tol: number): Vec2[] {
  const count = run.length;
  // Too few points to thin out (a tiny curve): all of them.
  if (count <= (loop ? 4 : 3)) {
    return run.slice();
  }
  const PER = 12;
  const idx: number[] = loop ? [0, 1, 2, 3].map(i => Math.floor((i * count) / 4)) : [0, Math.floor(count / 2), count - 1];
  // The worst stroke point (and how far): each one measured against the spans
  // around its own (the curve near it), not the whole curve - long strokes stay quick.
  const worst = (ix: number[]): [number, number] => {
    let curve = splinePoints(ix.map(i => run[i]), loop, 'fit', PER);
    // Down to its two ends: a straight span (sampled like the others).
    if (curve.length === 2) {
      curve = Array.from({ length: PER + 1 }, (_, step) => [curve[0][0] + ((curve[1][0] - curve[0][0]) * step) / PER, curve[0][1] + ((curve[1][1] - curve[0][1]) * step) / PER] as Vec2);
    }
    const spans = loop ? ix.length : ix.length - 1;
    let worstIndex = -1;
    let wd = tol;
    let span = 0;
    for (let i = 0; i < count; i++) {
      while (span < ix.length - 1 && i >= ix[span + 1]) {
        span++;
      }
      if (i === ix[span]) {
        continue;
      }
      let distance = Infinity;
      for (let t = span - 1; t <= span + 1; t++) {
        const sp = loop ? (t + spans) % spans : t;
        if (sp < 0 || sp >= spans) {
          continue;
        }
        for (let sample = sp * PER + 1; sample <= (sp + 1) * PER; sample++) {
          distance = Math.min(distance, segDist(run[i], curve[sample - 1], curve[sample]));
        }
      }
      if (distance > wd) {
        (wd = distance), (worstIndex = i);
      }
    }

    return [worstIndex, wd];
  };
  for (let guard = 0; guard < count; guard++) {
    const [worstSpan] = worst(idx);
    if (worstSpan < 0) {
      break;
    }
    idx.push(worstSpan);
    idx.sort((x, y) => x - y);
  }
  // Then drop every point the curve can do without (adding the worst point
  // first crowds them where the stroke bends).
  const keep = loop ? 3 : 2;
  for (let j = loop ? 0 : 1; j < idx.length - (loop ? 0 : 1) && idx.length > keep; ) {
    const without = idx.filter((_, index) => index !== j);
    if (worst(without)[0] < 0) {
      idx.splice(j, 1);
    } else {
      j++;
    }
  }

  return idx.map(i => run[i]);
}

/**
 * The stroke's points (in sketch units, as the pointer went), the tolerance
 * (how far the result may stray, a couple of screen pixels in sketch units)
 * and how near its end must come back to its start to close it.
 */
export function simplifyStroke(raw: Vec2[], tol: number, closeTol = tol * 6): Freehand {
  const none: Freehand = { pieces: [], closed: false };
  // Drop the repeats (a pointer held still reports the same spot).
  const pts: Vec2[] = [];
  for (const point of raw) {
    if (!pts.length || dist(point, pts[pts.length - 1]) > tol * 0.25) {
      pts.push(point);
    }
  }
  if (pts.length < 2) {
    return none;
  }
  const totalLength = length(pts);
  if (totalLength < tol * 4) {
    return none;
  }
  // Back near the start (a hand overshoots it a little: the spot nearest it,
  // in the last part of the stroke, is where the loop closes).
  let closed = false;
  if (pts.length >= 6 && totalLength > closeTol * 4) {
    let j = -1;
    let jd = closeTol;
    let along = 0;
    for (let i = 1; i < pts.length; i++) {
      along += dist(pts[i - 1], pts[i]);
      if (along < totalLength * 0.6) {
        continue;
      }
      const distance = dist(pts[i], pts[0]);
      if (distance <= jd) {
        (jd = distance), (j = i);
      }
    }
    if (j > 0) {
      closed = true;
      pts.length = j + 1;
    }
  }
  // Evenly spaced and lightly smoothed: corners and fits don't depend on how fast it was drawn.
  const step = Math.max(tol, totalLength / 2000);
  let points = resample(pts, step);
  if (closed) {
    // A loop: the gap closed, the last point (= the first) dropped.
    points = resample([...pts, pts[0]], step);
    points.pop();
    if (points.length < 6) {
      return none;
    }
  }
  points = smooth(points, closed);
  const reach = Math.max(2, Math.round((tol * 5) / step));
  const cut = corners(points, closed, reach, (50 * Math.PI) / 180);

  if (closed && !cut.length) {
    const circle = fitCircle(points);
    if (circle && points.every(q => Math.abs(dist(q, circle.c) - circle.r) <= Math.max(tol * 2, circle.r * 0.06))) {
      return { pieces: [{ kind: 'circle', center: circle.c, radius: circle.r }], closed: true };
    }

    return { pieces: [{ kind: 'spline', points: fitSpline(points, true, tol), closed: true }], closed: true };
  }

  const runs: Vec2[][] = [];
  if (closed) {
    const count = points.length;
    for (let j = 0; j < cut.length; j++) {
      const cutIndex = cut[j];
      const e = cut[(j + 1) % cut.length];
      const run: Vec2[] = [];
      for (let i = cutIndex; ; i = (i + 1) % count) {
        run.push(points[i]);
        if (i === e && run.length > 1) {
          break;
        }
      }
      runs.push(run);
    }
  } else {
    const at = [0, ...cut, points.length - 1];
    for (let j = 1; j < at.length; j++) {
      runs.push(points.slice(at[j - 1], at[j] + 1));
    }
  }
  const pieces = runs.filter(run => run.length >= 2 && length(run) > tol).map(run => fitRun(run, tol));
  // Each piece starts where the one before it ends (exactly: they are joined).
  for (let i = 1; i < pieces.length; i++) {
    setStart(pieces[i], endOf(pieces[i - 1]));
  }
  if (closed && pieces.length > 1) {
    setStart(pieces[0], endOf(pieces[pieces.length - 1]));
  }
  // (One piece around a loop with one corner, a teardrop: its ends meet.)
  if (closed && pieces.length === 1) {
    setStart(pieces[0], endOf(pieces[0]));
  }

  return { pieces, closed: closed && pieces.length > 0 };
}

export function endOf(e: FreehandPiece): Vec2 {
  return e.kind === 'spline' ? e.points[e.points.length - 1] : e.kind === 'circle' ? e.center : e.b;
}
function setStart(e: FreehandPiece, at: Vec2): void {
  if (e.kind === 'spline') {
    e.points[0] = at;
  } else if (e.kind !== 'circle') {
    e.a = at;
  }
}
