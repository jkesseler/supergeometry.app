// Sketch constraint solver: every entity is a short parameter vector; each
// constraint is one or more residuals; Levenberg–Marquardt drives them to zero
// while a weak pull towards the current shape keeps under-constrained sketches
// from wandering (so the result is the smallest change that satisfies them).

import { arcFrom3, entityCorners, entityPolylines } from './curves';
import { mirrorXf, offsetEntity, transformEntity } from './edit';
import type { ConstraintType, PointRef, SketchConstraint, SketchEntity, Vec2 } from '../doc/types';

// ------------------------------------------------------------- parameters

/**
 * Entity → flat parameter list (and back). Arcs are solved as centre, radius,
 * start angle and sweep: three points on a circle have a spare direction (the
 * middle one sliding along it) that slows the solver down, and can turn the
 * arc inside out; with angles it keeps its way round.
 */
function params(e: SketchEntity): number[] {
  switch (e.kind) {
    case 'line':
      return [...e.a, ...e.b];
    case 'arc': {
      const arc = arcFrom3(e.a, e.m, e.b);

      return arc ? [arc.c[0], arc.c[1], arc.r, arc.a0, arc.sweep] : [...e.a, ...e.m, ...e.b];
    }
    case 'circle':
      return [...e.center, e.radius];
    case 'ellipse':
      return [...e.center, e.rx, e.ry, e.rotation];
    case 'rect':
      return [...e.center, e.w, e.h, e.rotation];
    case 'polygon':
      return [...e.center, e.radius, e.angle];
    case 'spline':
    case 'polyline':
      return e.points.flat();
  }
}

/**
 * A shape with a size of its own (a rectangle, an ellipse, a polygon) keeps it sooner than its place: asked to bring
 * a corner somewhere, it goes there - it is not squashed towards it. (Each counted the same, a rectangle whose corner
 * was put on a point 60 away came out 0.00001 tall, and an ellipse flat.)
 */
const STIFF = 4;

/**
 * Length per unit of each parameter (1 for coordinates, the radius for angles). `stiff`: how much sooner a shape
 * keeps its size and its way round than its place (1 while it is dragged: a corner pulled is the shape pulled about).
 */
function pullScale(e: SketchEntity, params: number[], stiff: number): number[] {
  const magnitude = (value: number) => Math.max(Math.abs(value), 1e-9);
  switch (e.kind) {
    case 'arc':
      return params.length === 5 ? [1, 1, stiff, stiff * magnitude(params[2]), stiff * magnitude(params[2])] : params.map(() => 1);
    case 'ellipse':
      return [1, 1, stiff, stiff, magnitude(Math.max(e.rx, e.ry))];
    case 'rect':
      return [1, 1, stiff, stiff, magnitude(Math.hypot(e.w, e.h) / 2)];
    case 'polygon':
      return [1, 1, stiff, magnitude(e.radius)];
    default:
      return params.map(() => 1);
  }
}

function withParams(e: SketchEntity, x: number[]): SketchEntity {
  switch (e.kind) {
    case 'line':
      return { ...e, a: [x[0], x[1]], b: [x[2], x[3]] };
    case 'arc': {
      if (x.length === 6) {
        return { ...e, a: [x[0], x[1]], m: [x[2], x[3]], b: [x[4], x[5]] };
      }
      const [cx, cy, radius, a0, sw] = x;
      const at = (t: number): Vec2 => [cx + radius * Math.cos(t), cy + radius * Math.sin(t)];

      return { ...e, a: at(a0), m: at(a0 + sw / 2), b: at(a0 + sw) };
    }
    case 'circle':
      return { ...e, center: [x[0], x[1]], radius: Math.abs(x[2]) };
    case 'ellipse':
      return { ...e, center: [x[0], x[1]], rx: Math.abs(x[2]), ry: Math.abs(x[3]), rotation: x[4] };
    case 'rect':
      return { ...e, center: [x[0], x[1]], w: Math.abs(x[2]), h: Math.abs(x[3]), rotation: x[4] };
    case 'polygon':
      return { ...e, center: [x[0], x[1]], radius: Math.abs(x[2]), angle: x[3] };
    case 'spline':
    case 'polyline': {
      const pts: Vec2[] = [];
      for (let i = 0; i < x.length; i += 2) {
        pts.push([x[i], x[i + 1]]);
      }

      return { ...e, points: pts };
    }
  }
}

/** Named points of an entity (what constraints can grab). */
export function pointsOf(e: SketchEntity): { p: string; at: Vec2 }[] {
  switch (e.kind) {
    case 'line':
      return [{ p: 'a', at: e.a }, { p: 'b', at: e.b }];
    case 'arc': {
      const arc = arcFrom3(e.a, e.m, e.b);

      return [{ p: 'a', at: e.a }, { p: 'b', at: e.b }, ...(arc ? [{ p: 'c', at: arc.c }] : [])];
    }
    case 'circle':
      return [{ p: 'c', at: e.center }];
    case 'ellipse': {
      if (e.sweep === undefined) {
        return [{ p: 'c', at: e.center }];
      }
      // Part of an ellipse: its two ends too.
      const at = (t: number): Vec2 => {
        const x = e.rx * Math.cos(t);
        const y = e.ry * Math.sin(t);

        return [e.center[0] + x * Math.cos(e.rotation) - y * Math.sin(e.rotation), e.center[1] + x * Math.sin(e.rotation) + y * Math.cos(e.rotation)];
      };

      return [{ p: 'a', at: at(e.a0 ?? 0) }, { p: 'b', at: at((e.a0 ?? 0) + e.sweep) }, { p: 'c', at: e.center }];
    }
    case 'rect':
    case 'polygon':
      return [{ p: 'c', at: e.center }, ...entityCorners(e).map((at, i) => ({ p: `k${i}`, at }))];
    case 'spline':
      // A curve that follows a body's edge (Project): its two ends, as the edge has - the points between are the
      // edge's shape, made again whenever the body changes, and not there to pick, snap to or drag.
      if (e.id.startsWith(LINKED) && !e.closed && e.points.length > 2) {
        return [{ p: 'k0', at: e.points[0] }, { p: `k${e.points.length - 1}`, at: e.points[e.points.length - 1] }];
      }

      return e.points.map((at, i) => ({ p: `k${i}`, at }));
    case 'polyline':
      return e.points.map((at, i) => ({ p: `k${i}`, at }));
  }
}

export function pointOf(e: SketchEntity, pointName: string): Vec2 | null {
  return pointsOf(e).find(q => q.p === pointName)?.at ?? null;
}

/** Size of an entity by name, for dimension constraints and size fields. */
export function sizeOf(e: SketchEntity, prop: string): number | null {
  switch (prop) {
    case 'length':
      if (e.kind === 'line') {
        return Math.hypot(e.b[0] - e.a[0], e.b[1] - e.a[1]);
      }

      return null;
    case 'radius':
    case 'diameter': {
      const radius = e.kind === 'circle' || e.kind === 'polygon' ? e.radius : e.kind === 'arc' ? (arcFrom3(e.a, e.m, e.b)?.r ?? null) : null;

      return radius === null ? null : prop === 'diameter' ? 2 * radius : radius;
    }
    case 'w':
      return e.kind === 'rect' ? e.w : null;
    case 'h':
      return e.kind === 'rect' ? e.h : null;
    case 'rx':
      return e.kind === 'ellipse' ? e.rx : null;
    case 'ry':
      return e.kind === 'ellipse' ? e.ry : null;
    // Ellipse axis lengths (full widths, like a circle's diameter).
    case 'dx':
      return e.kind === 'ellipse' ? 2 * e.rx : null;
    case 'dy':
      return e.kind === 'ellipse' ? 2 * e.ry : null;
    case 'angle':
      return e.kind === 'line' ? (Math.atan2(e.b[1] - e.a[1], e.b[0] - e.a[0]) * 180) / Math.PI : null;
  }

  return null;
}

/** Direction of a straight entity (line), or null. */
function dirOf(e: SketchEntity): Vec2 | null {
  if (e.kind !== 'line') {
    return null;
  }

  return [e.b[0] - e.a[0], e.b[1] - e.a[1]];
}

/** Centre and radius of round entities. */
function roundOf(e: SketchEntity): { c: Vec2; r: number } | null {
  if (e.kind === 'circle') {
    return { c: e.center, r: e.radius };
  }
  if (e.kind === 'arc') {
    const a = arcFrom3(e.a, e.m, e.b);

    return a ? { c: a.c, r: a.r } : null;
  }

  return null;
}

// --------------------------------------------------------------- residuals

type Lookup = (id: string) => SketchEntity | undefined;

/** Residuals of one constraint (empty if it refers to something missing). */
function residuals(sketchConstraint: SketchConstraint, get: Lookup): number[] {
  const pointAt = (pointRef: PointRef) => {
    const e = get(pointRef.e);

    return e ? pointOf(e, pointRef.p) : null;
  };
  const entityAt = (i: number) => (sketchConstraint.curves?.[i] ? get(sketchConstraint.curves[i]) : undefined);
  const unit = (vector: Vec2) => {
    const length = Math.hypot(vector[0], vector[1]) || 1;

    return [vector[0] / length, vector[1] / length] as Vec2;
  };
  switch (sketchConstraint.type) {
    case 'coincident': {
      const [a, b] = (sketchConstraint.pts ?? []).map(pointAt);
      if (a && b) {
        return [a[0] - b[0], a[1] - b[1]];
      }
      // Point on a curve.
      const e = entityAt(0);
      if (a && e) {
        return distToEntity(a, e);
      }

      return [];
    }
    case 'horizontal':
    case 'vertical': {
      const e = entityAt(0);
      const direction = e && dirOf(e);
      if (direction) {
        return [sketchConstraint.type === 'horizontal' ? direction[1] : direction[0]];
      }
      const [a, b] = (sketchConstraint.pts ?? []).map(pointAt);
      if (a && b) {
        return [sketchConstraint.type === 'horizontal' ? a[1] - b[1] : a[0] - b[0]];
      }

      return [];
    }
    case 'parallel':
    case 'perpendicular': {
      const [d1, d2] = [entityAt(0), entityAt(1)].map(e => (e ? dirOf(e) : null));
      if (!d1 || !d2) {
        return [];
      }
      const unitA = unit(d1);
      const unitB = unit(d2);

      return [sketchConstraint.type === 'parallel' ? unitA[0] * unitB[1] - unitA[1] * unitB[0] : unitA[0] * unitB[0] + unitA[1] * unitB[1]];
    }
    case 'equal': {
      const [e1, e2] = [entityAt(0), entityAt(1)];
      if (!e1 || !e2) {
        return [];
      }
      const sizeAt = (e: SketchEntity) => sizeOf(e, e.kind === 'line' ? 'length' : 'radius');
      const a = sizeAt(e1);
      const b = sizeAt(e2);

      return a !== null && b !== null ? [a - b] : [];
    }
    case 'tangent': {
      const [e1, e2] = [entityAt(0), entityAt(1)];
      if (!e1 || !e2) {
        return [];
      }
      const r1 = roundOf(e1);
      const r2 = roundOf(e2);
      const line = e1.kind === 'line' ? e1 : e2.kind === 'line' ? e2 : null;
      const round = r1 ?? r2;
      if (line && round) {
        return [distPointLine(round.c, line.a, line.b) - round.r];
      }
      if (r1 && r2) {
        const distance = Math.hypot(r1.c[0] - r2.c[0], r1.c[1] - r2.c[1]);
        // Touching from outside, or one inside the other: whichever is nearer. (With its sign: the smaller of the two
        // sizes has a kink right at the answer, and the last of the way there was crept.)
        const out = distance - (r1.r + r2.r);
        const ins = distance - Math.abs(r1.r - r2.r);

        return [Math.abs(out) < Math.abs(ins) ? out : ins];
      }
      // A line and an ellipse: the line is as far from the centre as the ellipse reaches that way.
      const ell = e1.kind === 'ellipse' ? e1 : e2.kind === 'ellipse' ? e2 : null;
      if (line && ell) {
        const length = Math.hypot(line.b[0] - line.a[0], line.b[1] - line.a[1]) || 1;
        const normal: Vec2 = [(line.b[1] - line.a[1]) / length, -(line.b[0] - line.a[0]) / length];
        const cs = Math.cos(ell.rotation);
        const sn = Math.sin(ell.rotation);
        const reach = Math.hypot(ell.rx * (normal[0] * cs + normal[1] * sn), ell.ry * (-normal[0] * sn + normal[1] * cs));

        return [distPointLine(ell.center, line.a, line.b) - reach];
      }

      return [];
    }
    case 'concentric': {
      const c1 = entityAt(0) && centreOf(entityAt(0)!);
      const c2 = entityAt(1) && centreOf(entityAt(1)!);

      return c1 && c2 ? [c1[0] - c2[0], c1[1] - c2[1]] : [];
    }
    case 'midpoint': {
      const a = sketchConstraint.pts?.[0] && pointAt(sketchConstraint.pts[0]);
      const e = entityAt(0);
      if (!a || e?.kind !== 'line') {
        return [];
      }

      return [a[0] - (e.a[0] + e.b[0]) / 2, a[1] - (e.a[1] + e.b[1]) / 2];
    }
    case 'symmetric': {
      const [a, b] = (sketchConstraint.pts ?? []).map(pointAt);
      const e = entityAt(0);
      if (!a || !b || e?.kind !== 'line') {
        return [];
      }
      const midpoint: Vec2 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      const direction = unit(dirOf(e)!);

      // Midpoint on the line, and a–b perpendicular to it.
      return [distPointLineSigned(midpoint, e.a, e.b), (b[0] - a[0]) * direction[0] + (b[1] - a[1]) * direction[1]];
    }
    case 'fix': {
      const a = sketchConstraint.pts?.[0] && pointAt(sketchConstraint.pts[0]);

      return a && sketchConstraint.at ? [a[0] - sketchConstraint.at[0], a[1] - sketchConstraint.at[1]] : [];
    }
    case 'pattern': {
      // A copy in a sketch pattern: each of its points is the original's,
      // moved by `at` (or turned round `at` by `value` degrees); sizes the same.
      const original = entityAt(0);
      const copy = entityAt(1);
      if (!original || !copy || original.kind !== copy.kind || !sketchConstraint.at) {
        return [];
      }
      const t = ((sketchConstraint.value ?? 0) * Math.PI) / 180;
      const [cx, cy] = sketchConstraint.at;
      const map = (point: Vec2): Vec2 => (sketchConstraint.turn ? [cx + (point[0] - cx) * Math.cos(t) - (point[1] - cy) * Math.sin(t), cy + (point[0] - cx) * Math.sin(t) + (point[1] - cy) * Math.cos(t)] : [point[0] + cx, point[1] + cy]);
      const out: number[] = [];
      for (const q of pointsOf(original)) {
        const point = pointOf(copy, q.p);
        if (!point) {
          return [];
        }
        const moved = map(q.at);
        out.push(point[0] - moved[0], point[1] - moved[1]);
      }
      if ((original.kind === 'circle' || original.kind === 'polygon') && (copy.kind === 'circle' || copy.kind === 'polygon')) {
        out.push(copy.radius - original.radius);
      }
      if (original.kind === 'ellipse' && copy.kind === 'ellipse') {
        out.push(copy.rx - original.rx, copy.ry - original.ry);
      }

      return out;
    }
    case 'follow': {
      // A copy made from another curve - its offset, its mirror image: it is that, of the original as it is now.
      // (An offset or a mirrored copy was a curve of its own from the moment it was made: the original given
      // another size - a dimension typed, a variable changed - the copy stayed as it had been.)
      const original = entityAt(0);
      const copy = entityAt(1);
      const how = sketchConstraint.how;
      if (!original || !copy || !how) {
        return [];
      }
      const want = how.mirror ? transformEntity(original, mirrorXf(how.mirror[0], how.mirror[1])) : how.offset !== undefined ? offsetEntity(original, how.offset) : null;
      if (!want) {
        return [];
      }
      if (how.loose) {
        // A piece of an offset outline: on the original's offset (its ends are its neighbours' business).
        if (want.kind === 'line' && copy.kind === 'line') {
          return [distPointLineSigned(copy.a, want.a, want.b), distPointLineSigned(copy.b, want.a, want.b)];
        }
        if (want.kind === 'arc' && copy.kind === 'arc') {
          const wanted = arcFrom3(want.a, want.m, want.b);

          return wanted ? [copy.a, copy.m, copy.b].map(point => Math.hypot(point[0] - wanted.c[0], point[1] - wanted.c[1]) - wanted.r) : [];
        }

        return [];
      }
      if (want.kind !== copy.kind) {
        return [];
      }
      const out: number[] = [];
      for (const q of pointsOf(want)) {
        const point = pointOf(copy, q.p);
        if (!point) {
          return [];
        }
        out.push(point[0] - q.at[0], point[1] - q.at[1]);
      }
      if (want.kind === 'arc' && copy.kind === 'arc') {
        out.push(copy.m[0] - want.m[0], copy.m[1] - want.m[1]);
      }
      if ((want.kind === 'circle' || want.kind === 'polygon') && (copy.kind === 'circle' || copy.kind === 'polygon')) {
        out.push(copy.radius - want.radius);
      }
      if (want.kind === 'ellipse' && copy.kind === 'ellipse') {
        out.push(copy.rx - want.rx, copy.ry - want.ry, wrap(copy.rotation - want.rotation) * Math.max(want.rx, want.ry));
      }

      return out;
    }
    case 'distance': {
      if (sketchConstraint.value === undefined) {
        return [];
      }
      // Point to line: perpendicular distance.
      if (sketchConstraint.pts?.length === 1 && sketchConstraint.curves?.length === 1) {
        const point = pointAt(sketchConstraint.pts[0]);
        const curve = entityAt(0);

        return point && curve?.kind === 'line' ? [distPointLine(point, curve.a, curve.b) - sketchConstraint.value] : [];
      }
      // Line to line: they run the same way, that far apart (the second's middle from the first).
      if (!sketchConstraint.pts?.length && sketchConstraint.curves?.length === 2) {
        const [first, second] = [entityAt(0), entityAt(1)];
        if (first?.kind !== 'line' || second?.kind !== 'line') {
          return [];
        }
        const [d1, d2] = [dirOf(first), dirOf(second)];
        if (!d1 || !d2) {
          return [];
        }
        const mid: Vec2 = [(second.a[0] + second.b[0]) / 2, (second.a[1] + second.b[1]) / 2];
        const len = Math.hypot(second.b[0] - second.a[0], second.b[1] - second.a[1]) || 1;

        // (The turn as a length - the second line's end off the first's way - so it weighs as the distance does.)
        return [distPointLine(mid, first.a, first.b) - sketchConstraint.value, (d1[0] * d2[1] - d1[1] * d2[0]) * len];
      }
      const [a, b] = (sketchConstraint.pts ?? []).map(pointAt);

      return a && b ? [Math.hypot(a[0] - b[0], a[1] - b[1]) - sketchConstraint.value] : [];
    }
    case 'dim': {
      const e = entityAt(0);
      if (!e || !sketchConstraint.prop || sketchConstraint.value === undefined) {
        return [];
      }
      if (sketchConstraint.prop === 'angle' && sketchConstraint.curves?.length === 2) {
        const d1 = dirOf(e);
        const d2 = entityAt(1) && dirOf(entityAt(1)!);
        if (!d1 || !d2) {
          return [];
        }
        const ang = Math.atan2(d1[0] * d2[1] - d1[1] * d2[0], d1[0] * d2[0] + d1[1] * d2[1]);

        return [wrap(Math.abs(ang) - (sketchConstraint.value * Math.PI) / 180)];
      }
      const size = sizeOf(e, sketchConstraint.prop);
      if (size === null) {
        return [];
      }

      return sketchConstraint.prop === 'angle' ? [wrap(((size - sketchConstraint.value) * Math.PI) / 180)] : [size - sketchConstraint.value];
    }
  }
}

function wrap(a: number): number {
  while (a > Math.PI) {
    a -= 2 * Math.PI;
  }
  while (a < -Math.PI) {
    a += 2 * Math.PI;
  }

  return a;
}

function centreOf(e: SketchEntity): Vec2 | null {
  if (e.kind === 'circle' || e.kind === 'ellipse' || e.kind === 'rect' || e.kind === 'polygon') {
    return e.center;
  }

  return roundOf(e)?.c ?? null;
}

function distPointLine(point: Vec2, a: Vec2, b: Vec2): number {
  return Math.abs(distPointLineSigned(point, a, b));
}

function distPointLineSigned(point: Vec2, a: Vec2, b: Vec2): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const length = Math.hypot(dx, dy) || 1;

  return ((point[0] - a[0]) * dy - (point[1] - a[1]) * dx) / length;
}

function distToEntity(point: Vec2, e: SketchEntity): number[] {
  if (e.kind === 'line') {
    return [distPointLineSigned(point, e.a, e.b)];
  }
  const round = roundOf(e);
  if (round) {
    return [Math.hypot(point[0] - round.c[0], point[1] - round.c[1]) - round.r];
  }
  if (e.kind === 'ellipse') {
    // In the ellipse's own frame, how far out the point is as a share of the way to it (1: on it).
    const dx = point[0] - e.center[0];
    const dy = point[1] - e.center[1];
    const cs = Math.cos(e.rotation);
    const sn = Math.sin(e.rotation);
    const scaled = Math.hypot((dx * cs + dy * sn) / Math.max(e.rx, 1e-12), (-dx * sn + dy * cs) / Math.max(e.ry, 1e-12));

    return [(scaled - 1) * Math.min(e.rx, e.ry)];
  }
  // A rectangle, a polygon, a polyline, a spline: from the nearest place on it (a spline: as it is drawn) to the
  // point, across and up. Two numbers that change evenly as the point goes round a corner, so it gets there from
  // anywhere and the last of the way is not crept. (It was 0 for all of these: a point "put on" a rectangle's edge
  // was taken and stayed where it was.)
  const runs: Vec2[][] = e.kind === 'rect' || e.kind === 'polygon' ? [closedRun(entityCorners(e))] : e.kind === 'polyline' ? [e.closed ? closedRun(e.points) : e.points] : entityPolylines(e);
  let best = Infinity;
  let out = [0, 0];
  for (const run of runs) {
    for (let i = 0; i + 1 < run.length; i++) {
      const a = run[i];
      const b = run[i + 1];
      const ux = b[0] - a[0];
      const uy = b[1] - a[1];
      const l2 = ux * ux + uy * uy;
      if (l2 < 1e-24) {
        continue;
      }
      const along = ((point[0] - a[0]) * ux + (point[1] - a[1]) * uy) / l2;
      const clamped = Math.max(0, Math.min(1, along));
      const vx = point[0] - a[0] - clamped * ux;
      const vy = point[1] - a[1] - clamped * uy;
      const distance = Math.hypot(vx, vy);
      if (distance >= best) {
        continue;
      }
      best = distance;
      out = [vx, vy];
    }
  }

  return out;
}

function closedRun(pts: Vec2[]): Vec2[] {
  return pts.length ? [...pts, pts[0]] : pts;
}

// ------------------------------------------------------------------ solver

/** How the id of a curve that follows a body's edge begins: it is where that edge is, and nothing in the sketch moves it. */
export const LINKED = 'ref-';

export interface SolveOptions {
  /** Points to pull towards a target (dragging), with a strong weight. */
  drag?: { ref: PointRef; to: Vec2 }[];
  /** Entities that must not move (e.g. the face outline). */
  fixed?: Set<string>;
  /** Time it may take (ms); past it, what it has is the answer (and likely not met). */
  budget?: number;
}

export interface SolveResult {
  entities: SketchEntity[];
  /** Largest remaining residual (≈0 when every constraint is met). */
  error: number;
  ok: boolean;
}

/**
 * Solve constraints; returns updated entities (unchanged ones are kept).
 * Groups of curves that no constraint links are solved apart (a sketch of
 * twenty rectangles is twenty small problems, not one big one), and a group
 * whose constraints are already met, with nothing dragged in it, isn't touched.
 */
export function solve(entities: SketchEntity[], constraints: SketchConstraint[], opts: SolveOptions = {}): SolveResult {
  const held = entities.filter(e => e.id.startsWith(LINKED));
  if (held.length) {
    opts = { ...opts, fixed: new Set([...(opts.fixed ?? []), ...held.map(e => e.id)]) };
  }
  const ids = new Set(entities.map(e => e.id));
  const live = constraints.filter(constraint => refsOf(constraint).every(id => ids.has(id)));
  const drags = opts.drag ?? [];
  if (!live.length && !drags.length) {
    return { entities, error: 0, ok: true };
  }
  // Union–find over curves linked by a constraint (fixed curves don't link: they don't move).
  const parent = new Map<string, string>();
  const find = (a: string): string => {
    let root = a;
    while (parent.has(root) && parent.get(root) !== root) {
      root = parent.get(root)!;
    }
    parent.set(a, root);

    return root;
  };
  const join = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) {
      parent.set(ra, rb);
    }
  };
  const moving = (id: string) => !opts.fixed?.has(id);
  for (const sketchConstraint of live) {
    const refs = refsOf(sketchConstraint).filter(moving);
    for (const id of refs) {
      find(id);
    }
    for (let i = 1; i < refs.length; i++) {
      join(refs[0], refs[i]);
    }
  }
  for (const drag of drags) {
    if (moving(drag.ref.e)) {
      find(drag.ref.e);
    }
  }
  const groups = new Map<string, { cs: SketchConstraint[]; drag: typeof drags }>();
  const groupOf = (root: string) => {
    let group = groups.get(root);
    if (!group) {
      groups.set(root, (group = { cs: [], drag: [] }));
    }

    return group;
  };
  // Constraints on nothing that may move: either already met, or they can't be.
  const stuck: SketchConstraint[] = [];
  for (const sketchConstraint of live) {
    const refs = refsOf(sketchConstraint).filter(moving);
    if (refs.length) {
      groupOf(find(refs[0])).cs.push(sketchConstraint);
    } else {
      stuck.push(sketchConstraint);
    }
  }
  for (const drag of drags) {
    if (moving(drag.ref.e)) {
      groupOf(find(drag.ref.e)).drag.push(drag);
    }
  }
  if (groups.size <= 1 && !stuck.length) {
    return solveGroup(entities, live, opts);
  }
  const byId = new Map(entities.map(e => [e.id, e]));
  let error = constraintError(entities, stuck);
  let ok = error < 1e-9 * Math.max(1, ...entities.flatMap(e => pointsOf(e).map(point => Math.max(Math.abs(point.at[0]), Math.abs(point.at[1])))));
  for (const group of groups.values()) {
    if (!group.drag.length && constraintError(entities, group.cs) < 1e-12) {
      continue;
    }
    const need = new Set<string>([...group.cs.flatMap(refsOf), ...group.drag.map(drag => drag.ref.e)]);
    const solution = solveGroup(entities.filter(e => need.has(e.id)), group.cs, { ...opts, drag: group.drag });
    for (const e of solution.entities) {
      byId.set(e.id, e);
    }
    error = Math.max(error, solution.error);
    ok &&= solution.ok;
  }

  return { entities: entities.map(e => byId.get(e.id) ?? e), error, ok };
}

function solveGroup(entities: SketchEntity[], live: SketchConstraint[], opts: SolveOptions): SolveResult {
  if (!live.length && !opts.drag?.length) {
    return { entities, error: 0, ok: true };
  }
  // Only entities that take part move; everything else is left as is.
  const involved = new Set<string>(live.flatMap(refsOf));
  for (const drag of opts.drag ?? []) {
    involved.add(drag.ref.e);
  }
  for (const id of opts.fixed ?? []) {
    involved.delete(id);
  }
  const movers = entities.filter(e => involved.has(e.id));
  const offsets: number[] = [];
  const counts: number[] = [];
  // How much each parameter's change counts in the pull towards the start: in
  // lengths, so turning an arc by an angle costs what its ends travel (else
  // arcs would spin round freely instead of the sketch keeping its shape).
  const per: number[] = [];
  const x0: number[] = [];
  for (const e of movers) {
    const entityParams = params(e);
    offsets.push(x0.length);
    counts.push(entityParams.length);
    per.push(...pullScale(e, entityParams, opts.drag?.length ? 1 : STIFF));
    x0.push(...entityParams);
  }
  // A line asked to lie a way it is far from (Vertical on one nearly level; an angle 130 degrees off): turned there
  // about its middle first, its length kept. Left to the steps alone it got there by shrinking - shorter is the
  // shortest way to "upright" - and a line given a far angle ended a speck.
  if (!opts.drag?.length) {
    const at = new Map(movers.map((e, i) => [e.id, i]));
    for (const sketchConstraint of live) {
      const pair = (sketchConstraint.type === 'parallel' || sketchConstraint.type === 'perpendicular') && sketchConstraint.curves?.length === 2;
      // (Parallel, Perpendicular: the second line is the one turned - the first if only that one may move.)
      const which = pair ? (at.has(sketchConstraint.curves![1]) ? 1 : 0) : 0;
      const i = (pair || sketchConstraint.curves?.length === 1) && !sketchConstraint.pts?.length ? at.get(sketchConstraint.curves![which]) : undefined;
      const e = i === undefined ? undefined : movers[i];
      if (i === undefined || e?.kind !== 'line') {
        continue;
      }
      const now = Math.atan2(e.b[1] - e.a[1], e.b[0] - e.a[0]);
      let want: number | null = null;
      if (pair) {
        const entity = entities.find(entity => entity.id === sketchConstraint.curves![1 - which]);
        if (entity?.kind !== 'line') {
          continue;
        }
        const base = Math.atan2(entity.b[1] - entity.a[1], entity.b[0] - entity.a[0]) + (sketchConstraint.type === 'perpendicular' ? Math.PI / 2 : 0);
        // (Either way along it will do: the nearer.)
        want = Math.abs(wrap(base - now)) <= Math.PI / 2 ? base : base + Math.PI;
      }
      if (sketchConstraint.type === 'dim' && sketchConstraint.prop === 'angle' && sketchConstraint.value !== undefined) {
        want = (sketchConstraint.value * Math.PI) / 180;
      } else if (sketchConstraint.type === 'horizontal') {
        want = Math.abs(wrap(now)) < Math.PI / 2 ? 0 : Math.PI;
      } else if (sketchConstraint.type === 'vertical') {
        want = wrap(now) > 0 ? Math.PI / 2 : -Math.PI / 2;
      }
      if (want === null || Math.abs(wrap(want - now)) < Math.PI / 6) {
        continue;
      }
      const offset = offsets[i];
      const mx = (e.a[0] + e.b[0]) / 2;
      const my = (e.a[1] + e.b[1]) / 2;
      const halfLength = Math.hypot(e.b[0] - e.a[0], e.b[1] - e.a[1]) / 2;
      x0[offset] = mx - halfLength * Math.cos(want);
      x0[offset + 1] = my - halfLength * Math.sin(want);
      x0[offset + 2] = mx + halfLength * Math.cos(want);
      x0[offset + 3] = my + halfLength * Math.sin(want);
    }
  }
  const byId = new Map(entities.map(e => [e.id, e]));
  const build = (x: number[]) => {
    const entities = new Map(byId);
    movers.forEach((e, i) => entities.set(e.id, withParams(e, x.slice(offsets[i], offsets[i] + counts[i]))));

    return entities;
  };
  const scale = Math.max(1, ...x0.map(Math.abs));
  const drags = opts.drag ?? [];
  // Which constraints (and drags) each moving entity takes part in: nudging one
  // parameter only changes those rows, so the Jacobian is built from just them.
  const moverOf = new Map(movers.map((e, i) => [e.id, i]));
  const usedBy: number[][] = movers.map(() => []);
  live.forEach((sketchConstraint, ci) => {
    for (const id of new Set(refsOf(sketchConstraint))) {
      const i = moverOf.get(id);
      if (i !== undefined) {
        usedBy[i].push(ci);
      }
    }
  });
  const dragsOf: number[][] = movers.map(() => []);
  drags.forEach((drag, di) => {
    const i = moverOf.get(drag.ref.e);
    if (i !== undefined) {
      dragsOf[i].push(di);
    }
  });

  /** Residuals, laid out per constraint then per drag (rows found from the start). */
  const evalAll = (entities: Map<string, SketchEntity>, withDrag: boolean) => {
    const get = (id: string) => entities.get(id);
    const parts = live.map(sketchConstraint => residuals(sketchConstraint, get));
    const dr = withDrag ? drags.map(drag => dragRes(entities, drag)) : [];

    return { parts, dr };
  };
  const dragRes = (entities: Map<string, SketchEntity>, drag: { ref: PointRef; to: Vec2 }) => {
    const e = entities.get(drag.ref.e);
    const point = e && pointOf(e, drag.ref.p);

    // The drag target is "soft but strong": constraints still win where they conflict.
    return point ? [(point[0] - drag.to[0]) * 0.3, (point[1] - drag.to[1]) * 0.3] : [0, 0];
  };
  const errorAt = (x: number[]) => {
    let worst = 0;
    for (const part of evalAll(build(x), false).parts) {
      for (const value of part) {
        worst = Math.max(worst, Number.isFinite(value) ? Math.abs(value) : Infinity);
      }
    }

    return worst;
  };
  const start = evalAll(build(x0), true);
  // A drag frame must keep up with the finger; a typed value can take a moment.
  const deadline = performance.now() + (opts.budget ?? (drags.length ? 40 : 800));
  /** Fraction of the step dx that keeps every arc's change within about its size. */
  const stepLimit = (x: number[], dx: number[]) => {
    let fraction = 1;
    movers.forEach((e, i) => {
      const offset = offsets[i];
      if (e.kind === 'arc' && counts[i] === 5) {
        const radius = Math.max(Math.abs(x[offset + 2]), Math.abs(x0[offset + 2]));
        const move = Math.max(Math.abs(dx[offset]), Math.abs(dx[offset + 1]), Math.abs(dx[offset + 2]));
        if (move > 0.5 * radius) {
          fraction = Math.min(fraction, (0.5 * radius) / move);
        }
        const turn = Math.max(Math.abs(dx[offset + 3]), Math.abs(dx[offset + 4]));
        if (turn > 0.5) {
          fraction = Math.min(fraction, 0.5 / turn);
        }
      } else if (e.kind === 'ellipse' || e.kind === 'rect') {
        const turn = Math.abs(dx[offset + 4]);
        if (turn > 0.5) {
          fraction = Math.min(fraction, 0.5 / turn);
        }
      } else if (e.kind === 'polygon') {
        const turn = Math.abs(dx[offset + 3]);
        if (turn > 0.5) {
          fraction = Math.min(fraction, 0.5 / turn);
        }
      }
    });

    return fraction;
  };
  const run = (t: number, from: number[]) => {
    let xs = from;
    // On the way (t < 1) near enough is fine; only the end must be exact.
    const it = t < 1 ? 25 : 40;
    if (drags.length) {
      // Pulled towards the pointer (smallest change elsewhere), then put exactly
      // back on the constraints: the target only says where to go, they always win.
      // (The pull pass only has to get near: once a step gains next to nothing
      // it stops - it used to run all 30 steps every frame, as the pull never
      // reaches zero; the exact pass stops once the constraints are met.)
      xs = lm(xs, 1e-7, true, t, Math.min(30, it), 1e-6, false, 1e-7);
      xs = lm(xs, 1e-8, false, t, it, 1e-10, true, 1e-9);
    } else {
      // A noticeable pull first (smallest change), then almost none (exact constraints).
      xs = lm(xs, 1e-3, false, t, Math.min(30, it));
      xs = lm(xs, 1e-8, false, t, it);
    }

    return xs;
  };
  const t0 = turnsOf(build(x0), live);
  /**
   * The change made in small steps (each from the last), smaller wherever one
   * would flip a corner or arc; one that flips even when tiny is a flip the
   * change really needs. Null if it doesn't get all the way.
   */
  const gradually = (dt0: number, most: number): number[] | null => {
    let xc = x0;
    let t = 0;
    let dt = dt0;
    let turns = t0;
    for (let runs = 0; t < 1 && runs < most && performance.now() < deadline; runs++) {
      const tn = Math.min(1, t + dt);
      const xn = run(tn, xc);
      const tu = turnsOf(build(xn), live);
      if (!sameTurns(turns, tu) && dt > 1 / 256) {
        dt /= 2;
        continue;
      }
      xc = xn;
      t = tn;
      turns = tu;
      dt = Math.min(dt0, dt * 2);
    }

    return t >= 1 ? xc : null;
  };
  const tol = 1e-6 * Math.max(1, scale);
  let xs = run(1, x0);
  // A change can land on a flipped solution (a corner folded the other way, an
  // arc turned inside out); made in small steps it keeps its shape: redo it so.
  // (Not while dragging: each frame goes on from the last, so a flip there is
  // the pointer's doing - and a frame must stay quick.)
  if (!drags.length && !sameTurns(t0, turnsOf(build(xs), live))) {
    const xg = gradually(1 / 16, 60);
    if (xg && errorAt(xg) <= Math.max(errorAt(xs), tol)) {
      xs = xg;
    }
  }
  // Float noise off the answer (a height typed as 93 solved to 92.999999999999,
  // then shown, saved and built so): each value a hair off a clean one is put
  // on it, when that keeps the constraints as well met.
  if (!drags.length) {
    const clean = xs.map((value) => {
      const rounded = Math.round(value * 1e9) / 1e9;

      return rounded !== value && Math.abs(rounded - value) < 1e-10 * Math.max(1, Math.abs(value)) ? rounded : value;
    });
    if (clean.some((value, i) => value !== xs[i]) && errorAt(clean) <= Math.max(errorAt(xs), tol)) {
      xs = clean;
    }
  }
  const solved = build(xs);
  const error = errorAt(xs);

  return { entities: entities.map(e => solved.get(e.id) ?? e), error, ok: error < 1e-6 * Math.max(1, scale) };

  /**
   * Levenberg–Marquardt from `from`. `t` < 1 asks for only that part of the
   * way (the rest of the starting residuals is left), for stepping gradually.
   */
  function lm(from: number[], weight: number, withDrag: boolean, t: number, maxIt: number, minGain = 1e-10, untilMet = false, lambda0 = 1e-3): number[] {
    const keep = 1 - t;
    const flat = (ev: { parts: number[][]; dr: number[][] }) => {
      const out: number[] = [];
      ev.parts.forEach((part, ci) => {
        const s0 = start.parts[ci];
        for (let index = 0; index < part.length; index++) {
          out.push(part[index] - (keep && s0.length === part.length ? s0[index] * keep : 0));
        }
      });
      ev.dr.forEach((residual, di) => {
        const s0 = start.dr[di];
        out.push(residual[0] - s0[0] * keep, residual[1] - s0[1] * keep);
      });

      return out;
    };
    const residualsAt = (x: number[]) => {
      const out = flat(evalAll(build(x), withDrag));
      // Weak pull towards the start: picks the smallest change for free directions.
      for (let i = 0; i < x.length; i++) {
        out.push((x[i] - from[i]) * weight * per[i]);
      }

      return out;
    };
    let x = from.slice();
    let entities = build(x);
    let ev = evalAll(entities, withDrag);
    let residualNow = residualsAt(x);
    let cost = dot(residualNow, residualNow);
    // (Starting next to the answer - the exact pass of a drag - hardly any
    // damping: Gauss-Newton gets there in a step or two, damped it crept.)
    let lambda = lambda0;
    const count = x.length;
    let extra = 0;
    for (let it = 0; it < maxIt + extra && cost > 1e-24 && performance.now() < deadline; it++) {
      // Row where each constraint's / drag's residuals start.
      const rowC: number[] = [];
      let row = 0;
      for (const part of ev.parts) {
        rowC.push(row);
        row += part.length;
      }
      const rowD = ev.dr.map((_, di) => row + di * 2);
      const nRes = residualNow.length;
      // Numeric Jacobian, column by column, from only the rows that parameter
      // touches - kept as the few non-zeros of each row.
      const rows: { j: number; v: number }[][] = Array.from({ length: nRes }, () => []);
      const get = (id: string) => entities.get(id);
      for (let i = 0; i < movers.length; i++) {
        const id = movers[i].id;
        const was = entities.get(id)!;
        const base = x.slice(offsets[i], offsets[i] + counts[i]);
        for (let index = 0; index < counts[i]; index++) {
          const j = offsets[i] + index;
          const step = 1e-6 * Math.max(1, Math.abs(x[j]), scale * 1e-3);
          const pert = base.slice();
          pert[index] += step;
          entities.set(id, withParams(movers[i], pert));
          for (const ci of usedBy[i]) {
            const rp = residuals(live[ci], get);
            const r0 = ev.parts[ci];
            if (rp.length !== r0.length) {
              continue;
            }
            for (let q = 0; q < rp.length; q++) {
              const derivative = (rp[q] - r0[q]) / step;
              if (derivative !== 0) {
                rows[rowC[ci] + q].push({ j, v: derivative });
              }
            }
          }
          if (withDrag) {
            for (const di of dragsOf[i]) {
              const rp = dragRes(entities, drags[di]);
              const r0 = ev.dr[di];
              const v0 = (rp[0] - r0[0]) / step;
              const v1 = (rp[1] - r0[1]) / step;
              if (v0 !== 0) {
                rows[rowD[di]].push({ j, v: v0 });
              }
              if (v1 !== 0) {
                rows[rowD[di] + 1].push({ j, v: v1 });
              }
            }
          }
          rows[nRes - count + j].push({ j, v: weight * per[j] });
        }
        entities.set(id, was);
      }
      // (JᵀJ + λ diag) dx = -Jᵀ·residualNow, from those non-zeros (each residual depends
      // on a handful of parameters), not the whole matrix.
      const normalMatrix: number[][] = Array.from({ length: count }, () => new Array(count).fill(0));
      const gradient = new Array(count).fill(0);
      for (let i = 0; i < nRes; i++) {
        const row = rows[i];
        const ri = residualNow[i];
        for (let column = 0; column < row.length; column++) {
          const { j: a, v: va } = row[column];
          gradient[a] -= va * ri;
          const Aa = normalMatrix[a];
          for (let q = column; q < row.length; q++) {
            Aa[row[q].j] += va * row[q].v;
          }
        }
      }
      for (let a = 0; a < count; a++) {
        for (let b = a + 1; b < count; b++) {
          normalMatrix[b][a] = normalMatrix[a][b];
        }
      }
      let improved = false;
      let gain = 0;
      // Damped the same in every direction (each parameter in its own length): the step is then the shortest one
      // that does it. Damped by each parameter's own share (Marquardt's way), a sketch with room to spare - most
      // are - stepped furthest in the direction that helped least: a line given a length drew its ends together
      // sideways until it stood upright, and stopped there, the length not met.
      let mean = 0;
      for (let i = 0; i < count; i++) {
        mean += normalMatrix[i][i] / (per[i] * per[i]);
      }
      mean = mean / Math.max(1, count) || 1;
      for (let tries = 0; tries < 8; tries++) {
        const diag = normalMatrix.map((rowA, i) => rowA[i] + lambda * mean * per[i] * per[i] + 1e-12);
        let dx = solveSPD(normalMatrix, diag, gradient);
        if (!dx) {
          const damped = normalMatrix.map((rowA, i) => rowA.map((value, j) => (i === j ? diag[i] : value)));
          dx = solveLinear(damped, gradient);
        }
        if (!dx) {
          lambda *= 10;
          continue;
        }
        // Curved things are only near-linear within about their own size: a
        // longer step would land somewhere arbitrary (folded, inside out).
        const fraction = stepLimit(x, dx);
        if (fraction < 1) {
          for (let i = 0; i < count; i++) {
            dx[i] *= fraction;
          }
          if (tries === 0) {
            extra = Math.min(extra + 1, 160);
          }
        }
        const xn = x.map((value, i) => value + dx[i]);
        const rn = residualsAt(xn);
        const cn = dot(rn, rn);
        if (cn < cost) {
          gain = (cost - cn) / cost;
          x = xn;
          residualNow = rn;
          cost = cn;
          entities = build(x);
          ev = evalAll(entities, withDrag);
          lambda = Math.max(1e-9, lambda / 3);
          improved = true;
          break;
        }
        lambda *= 10;
      }
      // Done: nothing left to gain.
      if (!improved || gain < minGain) {
        break;
      }
      // Exact pass of a drag: the constraints are met (far inside what counts as
      // solved) - the tiny pull left doesn't need more steps.
      if (untilMet && t >= 1) {
        let worst = 0;
        for (const rr of ev.parts) {
          for (const value of rr) {
            worst = Math.max(worst, Math.abs(value));
          }
        }
        if (worst < tol * 1e-4) {
          break;
        }
      }
    }

    return x;
  }
}

/** Which way each joined corner of two lines turns, and each arc: a flip changes a sign. */
function turnsOf(entities: Map<string, SketchEntity>, cs: SketchConstraint[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const e of entities.values()) {
    if (e.kind !== 'arc') {
      continue;
    }
    const a = arcFrom3(e.a, e.m, e.b);
    if (a) {
      out.set(e.id, Math.sign(a.sweep));
    }
  }
  // Corners: two lines joined end to end (by a coincident constraint). Legs
  // that are next to nothing don't count - they can tip either way.
  let size = 0;
  for (const e of entities.values()) {
    if (e.kind === 'line') {
      size = Math.max(size, Math.hypot(e.b[0] - e.a[0], e.b[1] - e.a[1]));
    }
  }
  for (const sketchConstraint of cs) {
    if (sketchConstraint.type !== 'coincident' || sketchConstraint.pts?.length !== 2) {
      continue;
    }
    const [pointRef, q] = sketchConstraint.pts;
    const l1 = entities.get(pointRef.e);
    const l2 = entities.get(q.e);
    if (l1?.kind !== 'line' || l2?.kind !== 'line' || l1 === l2 || (pointRef.p !== 'a' && pointRef.p !== 'b') || (q.p !== 'a' && q.p !== 'b')) {
      continue;
    }
    const origin = pointRef.p === 'a' ? l1.a : l1.b;
    const endA = pointRef.p === 'a' ? l1.b : l1.a;
    const endB = q.p === 'a' ? l2.b : l2.a;
    const lu = Math.hypot(endA[0] - origin[0], endA[1] - origin[1]);
    const lv = Math.hypot(endB[0] - origin[0], endB[1] - origin[1]);
    if (lu < size * 1e-4 || lv < size * 1e-4) {
      continue;
    }
    const cr = (endA[0] - origin[0]) * (endB[1] - origin[1]) - (endA[1] - origin[1]) * (endB[0] - origin[0]);
    // Straight-through or folded flat: no clear side.
    if (Math.abs(cr) > lu * lv * 0.02) {
      out.set(sketchConstraint.id, Math.sign(cr));
    }
  }

  return out;
}

function sameTurns(a: Map<string, number>, b: Map<string, number>): boolean {
  for (const [key, turns] of a) {
    const other = b.get(key);
    if (other !== undefined && other !== turns) {
      return false;
    }
  }

  return true;
}

/** Entity ids a constraint refers to. */
/**
 * Which curves the constraints hold completely - nothing about them can
 * change without breaking one (a sketch drawn green there) - and whether that's
 * all of them. From the rank of the constraints' Jacobian: a parameter is held
 * when no free direction of the system moves it. Null for a sketch too big
 * to work it out quickly.
 */
export function definedCurves(entities: SketchEntity[], constraints: SketchConstraint[]): { defined: Set<string>; all: boolean } | null {
  const ids = new Set(entities.map(e => e.id));
  const live = constraints.filter(constraint => refsOf(constraint).every(id => ids.has(id)));
  // Curves that follow a body's edge are where the edge is: held already.
  const movers = entities.filter(e => !e.id.startsWith(LINKED));
  const offsets: number[] = [];
  const counts: number[] = [];
  const x0: number[] = [];
  for (const e of movers) {
    const entityParams = params(e);
    offsets.push(x0.length);
    counts.push(entityParams.length);
    x0.push(...entityParams);
  }
  const count = x0.length;
  const linked = new Set(entities.filter(e => e.id.startsWith(LINKED)).map(e => e.id));
  if (!count) {
    return { defined: linked, all: true };
  }
  if (count > 300) {
    return null;
  }
  const byId = new Map(entities.map(e => [e.id, e]));
  const at = (id: string) => byId.get(id);
  const rowStart: number[] = [];
  let rowCount = 0;
  for (const sketchConstraint of live) {
    rowStart.push(rowCount);
    rowCount += residuals(sketchConstraint, at).length;
  }
  const jacobian: Float64Array[] = Array.from({ length: rowCount }, () => new Float64Array(count));
  const moverOf = new Map(movers.map((e, i) => [e.id, i]));
  const usedBy: number[][] = movers.map(() => []);
  live.forEach((sketchConstraint, ci) => {
    for (const id of new Set(refsOf(sketchConstraint))) {
      const i = moverOf.get(id);
      if (i !== undefined) {
        usedBy[i].push(ci);
      }
    }
  });
  let big = 0;
  movers.forEach((e, i) => {
    const xs = x0.slice(offsets[i], offsets[i] + counts[i]);
    for (let index = 0; index < counts[i]; index++) {
      const j = offsets[i] + index;
      const step = 1e-6 * Math.max(1, Math.abs(xs[index]));
      const up = xs.slice();
      const down = xs.slice();
      up[index] += step;
      down[index] -= step;
      const ep = withParams(e, up);
      const em = withParams(e, down);
      for (const ci of usedBy[i]) {
        const rp = residuals(live[ci], id => (id === e.id ? ep : byId.get(id)));
        const rm = residuals(live[ci], id => (id === e.id ? em : byId.get(id)));
        for (let row = 0; row < rp.length; row++) {
          const derivative = (rp[row] - rm[row]) / (2 * step);
          if (Number.isFinite(derivative)) {
            jacobian[rowStart[ci] + row][j] = derivative;
            big = Math.max(big, Math.abs(derivative));
          }
        }
      }
    }
  });
  // Reduced row echelon form; the columns without a pivot are free directions.
  const tol = 1e-7 * Math.max(1, big);
  const pivotRow = new Int32Array(count).fill(-1);
  let row = 0;
  for (let col = 0; col < count && row < rowCount; col++) {
    let pivot = row;
    for (let candidateRow = row + 1; candidateRow < rowCount; candidateRow++) {
      if (Math.abs(jacobian[candidateRow][col]) > Math.abs(jacobian[pivot][col])) {
        pivot = candidateRow;
      }
    }
    if (Math.abs(jacobian[pivot][col]) < tol) {
      continue;
    }
    [jacobian[row], jacobian[pivot]] = [jacobian[pivot], jacobian[row]];
    const values = jacobian[row];
    const pivotValue = values[col];
    for (let column = col; column < count; column++) {
      values[column] /= pivotValue;
    }
    for (let otherRow = 0; otherRow < rowCount; otherRow++) {
      if (otherRow === row) {
        continue;
      }
      const factor = jacobian[otherRow][col];
      if (Math.abs(factor) < 1e-15) {
        continue;
      }
      const Rr = jacobian[otherRow];
      for (let column = col; column < count; column++) {
        Rr[column] -= factor * values[column];
      }
    }
    pivotRow[col] = row++;
  }
  const free: number[] = [];
  for (let j = 0; j < count; j++) {
    if (pivotRow[j] < 0) {
      free.push(j);
    }
  }
  // A pivot parameter is held when no free direction moves it.
  const held = (j: number) => pivotRow[j] >= 0 && free.every(freeColumn => Math.abs(jacobian[pivotRow[j]][freeColumn]) < 1e-6);
  const defined = new Set(linked);
  movers.forEach((e, i) => {
    let ok = true;
    for (let index = 0; index < counts[i] && ok; index++) {
      ok = held(offsets[i] + index);
    }
    if (ok) {
      defined.add(e.id);
    }
  });

  return { defined, all: defined.size === entities.length };
}

export function refsOf(sketchConstraint: SketchConstraint): string[] {
  return [...(sketchConstraint.pts ?? []).map(pointRef => pointRef.e), ...(sketchConstraint.curves ?? [])];
}

function dot(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    sum += a[i] * b[i];
  }

  return sum;
}

/**
 * Cholesky for the symmetric positive definite normal equations, keeping to
 * each row's envelope (from its first non-zero): sketch parameters link mostly
 * to their neighbours, so this is far less work than full elimination.
 * Null if the matrix turns out not positive definite.
 */
function solveSPD(matrix: number[][], diag: number[], b: number[]): number[] | null {
  // `matrix` holds the upper triangle (matrix[j][i], j ≤ i); diag replaces its diagonal.
  const count = b.length;
  const first = new Array<number>(count);
  for (let i = 0; i < count; i++) {
    let firstColumn = i;
    for (let j = 0; j < i; j++) {
      if (matrix[j][i] !== 0) {
        firstColumn = j;
        break;
      }
    }
    first[i] = firstColumn;
  }
  const lower: Float64Array[] = matrix.map(() => new Float64Array(count));
  for (let i = 0; i < count; i++) {
    const Li = lower[i];
    for (let j = first[i]; j <= i; j++) {
      const Lj = lower[j];
      let sum = j === i ? diag[i] : matrix[j][i];
      for (let index = Math.max(first[i], first[j]); index < j; index++) {
        sum -= Li[index] * Lj[index];
      }
      if (j === i) {
        if (!(sum > 0)) {
          return null;
        }
        Li[i] = Math.sqrt(sum);
      } else {
        Li[j] = sum / Lj[j];
      }
    }
  }
  // lower·y = b, then lowerᵀ·x = y.
  const y = new Array<number>(count);
  for (let i = 0; i < count; i++) {
    let sum = b[i];
    for (let index = first[i]; index < i; index++) {
      sum -= lower[i][index] * y[index];
    }
    y[i] = sum / lower[i][i];
  }
  const x = y.slice();
  for (let i = count - 1; i >= 0; i--) {
    x[i] /= lower[i][i];
    const xi = x[i];
    for (let index = first[i]; index < i; index++) {
      x[index] -= lower[i][index] * xi;
    }
  }

  return x.every(Number.isFinite) ? x : null;
}

/** Gaussian elimination with partial pivoting. */
function solveLinear(matrix: number[][], b: number[]): number[] | null {
  const count = b.length;
  const augmented = matrix.map((row, i) => [...row, b[i]]);
  for (let column = 0; column < count; column++) {
    let pivot = column;
    for (let row = column + 1; row < count; row++) {
      if (Math.abs(augmented[row][column]) > Math.abs(augmented[pivot][column])) {
        pivot = row;
      }
    }
    if (Math.abs(augmented[pivot][column]) < 1e-18) {
      return null;
    }
    [augmented[column], augmented[pivot]] = [augmented[pivot], augmented[column]];
    for (let row = column + 1; row < count; row++) {
      const factor = augmented[row][column] / augmented[column][column];
      if (!factor) {
        continue;
      }
      for (let entry = column; entry <= count; entry++) {
        augmented[row][entry] -= factor * augmented[column][entry];
      }
    }
  }
  const x = new Array(count).fill(0);
  for (let row = count - 1; row >= 0; row--) {
    let sum = augmented[row][count];
    for (let column = row + 1; column < count; column++) {
      sum -= augmented[row][column] * x[column];
    }
    x[row] = sum / augmented[row][row];
  }

  return x;
}

// ------------------------------------------------------------- utilities

/** Which constraints the current selection allows (for enabling buttons). */
export function applicable(type: ConstraintType, pts: PointRef[], curves: SketchEntity[]): boolean {
  const lines = curves.filter(e => e.kind === 'line');
  const rounds = curves.filter(e => e.kind === 'circle' || e.kind === 'arc');
  switch (type) {
    case 'coincident':
      return pts.length === 2 || (pts.length === 1 && curves.length === 1);
    case 'horizontal':
    case 'vertical':
      return (lines.length === 1 && curves.length === 1 && !pts.length) || (pts.length === 2 && !curves.length);
    case 'parallel':
    case 'perpendicular':
      return lines.length === 2 && curves.length === 2;
    case 'equal':
      return curves.length === 2 && (lines.length === 2 || rounds.length === 2);
    case 'tangent':
      // A circle or an arc with a line or another of them; a line with an ellipse. (It was offered for a circle with
      // anything - a rectangle, a spline, an ellipse - and taken, and did nothing.)
      return curves.length === 2 && (rounds.length === 2 || (rounds.length === 1 && lines.length === 1) || (lines.length === 1 && curves.some(e => e.kind === 'ellipse')));
    case 'concentric':
      return curves.length === 2 && curves.every(e => e.kind !== 'line' && e.kind !== 'spline' && e.kind !== 'polyline');
    case 'midpoint':
      return pts.length === 1 && lines.length === 1 && curves.length === 1;
    case 'symmetric':
      return pts.length === 2 && lines.length === 1 && curves.length === 1;
    case 'distance':
      return (pts.length === 2 && !curves.length) || (pts.length === 1 && lines.length === 1 && curves.length === 1) || (!pts.length && lines.length === 2 && curves.length === 2);
    case 'fix':
      // Points, or whole curves (all their points).
      return pts.length >= 1 || curves.length >= 1;
    default:
      return false;
  }
}

/**
 * Add constraints strictly: they go in only if everything still works out
 * together. A new constraint that contradicts existing ones is refused
 * (nothing already there is taken away).
 */
export function addStrict(
  entities: SketchEntity[],
  existing: SketchConstraint[],
  added: SketchConstraint[],
  opts: SolveOptions = {}
): { ok: boolean; constraints: SketchConstraint[]; result: SolveResult } {
  const all = [...existing, ...added];
  const solution = solveFine(entities, all, opts);

  return solution.ok ? { ok: true, constraints: all, result: solution } : { ok: false, constraints: existing, result: solution };
}

function curveSize(e: SketchEntity): number {
  switch (e.kind) {
    case 'line':
      return Math.hypot(e.b[0] - e.a[0], e.b[1] - e.a[1]);
    case 'circle':
    case 'polygon':
      return e.radius;
    case 'arc': {
      // Its length: a nearly full arc has almost no chord but is no crumb; one
      // that sweeps next to nothing is.
      const arc = arcFrom3(e.a, e.m, e.b);

      return arc ? arc.r * Math.abs(arc.sweep) : 0;
    }
    case 'rect':
      return Math.min(e.w, e.h);
    case 'ellipse':
      return Math.min(e.rx, e.ry);
    default:
      return 1;
  }
}

/**
 * Solve, and only call it met if no curve had to shrink to nothing for it
 * (a line of zero length "is" horizontal and vertical at once - that's not a sketch).
 */
export function solveFine(entities: SketchEntity[], constraints: SketchConstraint[], opts: SolveOptions = {}): SolveResult {
  const solution = solve(entities, constraints, opts);
  // Against the sketch's size before and after (a curve made huge can crush another).
  const extent = (e: SketchEntity) => (e.kind === 'rect' ? Math.max(e.w, e.h) : e.kind === 'ellipse' ? Math.max(e.rx, e.ry) : curveSize(e));
  const scale = Math.max(1e-9, ...entities.map(extent), ...solution.entities.map(extent));
  // One that was already tiny may stay so, but not shrink further towards nothing.
  const ok = solution.ok && solution.entities.every((e, i) => curveSize(e) > scale * 1e-6 || curveSize(e) >= curveSize(entities[i]) * 0.99);

  return { ...solution, ok };
}

/** A dimension's new value, strictly: refused (null) if the sketch can't take it. */
export function setValueStrict(entities: SketchEntity[], constraints: SketchConstraint[], id: string, value: number, expr?: string): { constraints: SketchConstraint[]; result: SolveResult } | null {
  const constraint = constraints.find(constraint => constraint.id === id);
  if (!constraint) {
    return null;
  }
  const next = { ...constraint, value, expr };
  const result = addStrict(entities, constraints.filter(sketchConstraint => sketchConstraint !== constraint), [next]);
  if (!result.ok) {
    return null;
  }

  // Keep the constraint where it was in the list.
  return { constraints: constraints.map(sketchConstraint => (sketchConstraint === constraint ? next : sketchConstraint)), result: result.result };
}

/**
 * Add constraints without being strict about it: if the new ones contradict
 * existing ones, the existing ones they clash with give way (newest first,
 * as few as possible). Ones that agree stay alongside.
 */
export function addResolving(
  entities: SketchEntity[],
  existing: SketchConstraint[],
  added: SketchConstraint[],
  opts: SolveOptions = {}
): { constraints: SketchConstraint[]; removed: SketchConstraint[]; result: SolveResult } {
  const all = [...existing, ...added];
  const solveOk = (cs: SketchConstraint[]) => solveFine(entities, cs, opts);
  const first = solveOk(all);
  if (first.ok) {
    return { constraints: all, removed: [], result: first };
  }
  // Only ones touching what the new constraint touches can be in its way.
  const refs = new Set(added.flatMap(refsOf));
  const near = existing.filter(sketchConstraint => refsOf(sketchConstraint).some(ref => refs.has(ref))).reverse();
  // One is usually enough: try each alone first.
  for (const sketchConstraint of near) {
    const rest = all.filter(other => other !== sketchConstraint);
    const solution = solveOk(rest);
    if (solution.ok) {
      return { constraints: rest, removed: [sketchConstraint], result: solution };
    }
  }
  // Else take them away one by one until it works out.
  const removed: SketchConstraint[] = [];
  let rest = all;
  for (const sketchConstraint of near) {
    rest = rest.filter(other => other !== sketchConstraint);
    removed.push(sketchConstraint);
    const solution = solveOk(rest);
    if (solution.ok) {
      return { constraints: rest, removed, result: solution };
    }
  }

  return { constraints: all, removed: [], result: first };
}

/**
 * Which existing constraints give way first when a new one is asked for: an
 * angle or orientation the new one restates, then sizes, then shape links;
 * joins (coincident) and locks last of all - the user meant to keep those.
 */
function yieldRank(sketchConstraint: SketchConstraint): number {
  if (sketchConstraint.type === 'dim' && sketchConstraint.prop === 'angle') {
    return 0;
  }
  if (sketchConstraint.type === 'horizontal' || sketchConstraint.type === 'vertical' || sketchConstraint.type === 'parallel' || sketchConstraint.type === 'perpendicular') {
    return 1;
  }
  if (sketchConstraint.type === 'dim' || sketchConstraint.type === 'distance') {
    return 2;
  }
  if (sketchConstraint.type === 'equal' || sketchConstraint.type === 'symmetric' || sketchConstraint.type === 'midpoint' || sketchConstraint.type === 'tangent' || sketchConstraint.type === 'concentric') {
    return 3;
  }
  if (sketchConstraint.type === 'coincident') {
    return 4;
  }

  return 5;
}

/**
 * A constraint the user asked for (a button press): it goes in. `first` (the
 * first-picked curve) stays put where that makes sense - only when the new
 * constraints also reach something else to move; a constraint on one curve
 * alone (Horizontal on a line) has to move that curve. If what is already there
 * doesn't allow it, the existing constraints in its way give way (angles and
 * orientations first, then sizes; joins and locks only as a last resort), as
 * few as possible. Refused (ok false) only when even that can't make it work.
 */
export function addForUser(
  entities: SketchEntity[],
  existing: SketchConstraint[],
  added: SketchConstraint[],
  first?: string
): { ok: boolean; constraints: SketchConstraint[]; removed: SketchConstraint[]; result: SolveResult } {
  const refs = new Set(added.flatMap(refsOf));
  const all = [...existing, ...added];
  const holdFirst = !!first && refs.has(first) && [...refs].some(ref => ref !== first) && !added.every(sketchConstraint => sketchConstraint.type === 'fix');
  const tries: SolveOptions[] = holdFirst ? [{ fixed: new Set([first!]) }, {}] : [{}];
  // No curve may all but vanish for it (a line squashed to a speck "is" any
  // direction): unless the new constraint sizes that very curve, each keeps
  // a good part of its size.
  const sized = new Set(added.filter(sketchConstraint => sketchConstraint.type === 'dim' || sketchConstraint.type === 'equal').flatMap(refsOf));
  const before = new Map(entities.map(e => [e.id, curveSize(e)]));
  const sane = (solveResult: SolveResult) => solveResult.ok && solveResult.entities.every(e => sized.has(e.id) || curveSize(e) >= 0.2 * (before.get(e.id) ?? 0));
  let last: SolveResult | null = null;
  for (const solveOptions of tries) {
    const solution = solveFine(entities, all, solveOptions);
    if (sane(solution)) {
      return { ok: true, constraints: all, removed: [], result: solution };
    }
    last = solution;
  }
  // What can be in its way: constraints on the curves it touches, then on their neighbours.
  const ring1 = existing.filter(sketchConstraint => refsOf(sketchConstraint).some(ref => refs.has(ref)));
  const near1 = new Set([...refs, ...ring1.flatMap(refsOf)]);
  const ring2 = existing.filter(sketchConstraint => !ring1.includes(sketchConstraint) && refsOf(sketchConstraint).some(ref => near1.has(ref)));
  // Lowest rank first; within a rank, newest first.
  const order = (list: SketchConstraint[]) =>
    list
      .map((sketchConstraint, i) => ({ c: sketchConstraint, i }))
      .sort((a, b) => yieldRank(a.c) - yieldRank(b.c) || b.i - a.i)
      .map(entry => entry.c);
  // Locks stay: the user set them to hold things where they are.
  const cands = [...order(ring1), ...order(ring2)].filter(sketchConstraint => sketchConstraint.type !== 'fix');
  const attempt = (cs: SketchConstraint[]) => {
    for (const solveOptions of tries) {
      const solution = solveFine(entities, cs, solveOptions);
      if (sane(solution)) {
        return solution;
      }
    }

    return null;
  };
  // One is usually enough: try each alone (the most willing first).
  for (const candidate of cands) {
    const rest = all.filter(sketchConstraint => sketchConstraint !== candidate);
    const solveResult = attempt(rest);
    if (solveResult) {
      return { ok: true, constraints: rest, removed: [candidate], result: solveResult };
    }
  }
  // Else take them away in that order until it works, then put back any that weren't needed.
  const removed: SketchConstraint[] = [];
  let rest = all;
  for (const candidate of cands) {
    rest = rest.filter(sketchConstraint => sketchConstraint !== candidate);
    removed.push(candidate);
    let solveResult = attempt(rest);
    if (!solveResult) {
      continue;
    }
    for (const back of [...removed].reverse()) {
      const withBack = all.filter(sketchConstraint => rest.includes(sketchConstraint) || sketchConstraint === back);
      const rb = attempt(withBack);
      if (rb) {
        rest = withBack;
        removed.splice(removed.indexOf(back), 1);
        solveResult = rb;
      }
    }

    return { ok: true, constraints: rest, removed, result: solveResult };
  }

  return { ok: false, constraints: existing, removed: [], result: last! };
}

/** Short name of a constraint for messages ("angle dimension", "parallel"). */
export function constraintName(sketchConstraint: SketchConstraint): string {
  if (sketchConstraint.type === 'dim') {
    return `${sketchConstraint.prop === 'angle' ? 'angle' : (sketchConstraint.prop ?? 'size')} dimension`;
  }
  if (sketchConstraint.type === 'fix') {
    return 'lock';
  }
  if (sketchConstraint.type === 'pattern') {
    return 'pattern link';
  }
  if (sketchConstraint.type === 'follow') {
    return sketchConstraint.how?.mirror ? 'mirror link' : 'offset link';
  }

  return sketchConstraint.type;
}

/** Largest residual of the constraints on these entities as they are (0 = all met). */
export function constraintError(entities: SketchEntity[], constraints: SketchConstraint[]): number {
  const byId = new Map(entities.map(e => [e.id, e]));
  const get = (id: string) => byId.get(id);
  let worst = 0;
  for (const constraint of constraints) {
    for (const residual of residuals(constraint, get)) {
      worst = Math.max(worst, Number.isFinite(residual) ? Math.abs(residual) : Infinity);
    }
  }

  return worst;
}

/**
 * One frame of a drag: carry on from the last good frame (small steps solve
 * fast and keep the shape's way round). Where the constraints can't follow the
 * pointer all the way, it goes as far towards it as they allow.
 */
export function followDrag(
  prev: SketchEntity[],
  constraints: SketchConstraint[],
  drag: { ref: PointRef; to: Vec2 }[],
  prevTo: Vec2[] | null
): { entities: SketchEntity[]; to: Vec2[]; ok: boolean } {
  const solution = solveFine(prev, constraints, { drag, budget: 30 });
  if (solution.ok || !prevTo) {
    return { entities: solution.ok ? solution.entities : prev, to: drag.map(drag => drag.to), ok: solution.ok };
  }
  // Halfway, and halfway again: the furthest point it can still reach.
  let lo = 0;
  let hi = 1;
  let best: SketchEntity[] = prev;
  let bestTo = prevTo;
  for (let i = 0; i < 3; i++) {
    const t = (lo + hi) / 2;
    const to = drag.map((drag, index) => [prevTo[index][0] + (drag.to[0] - prevTo[index][0]) * t, prevTo[index][1] + (drag.to[1] - prevTo[index][1]) * t] as Vec2);
    const q = solveFine(prev, constraints, { drag: drag.map((drag, index) => ({ ref: drag.ref, to: to[index] })), budget: 8 });
    if (q.ok) {
      lo = t;
      best = q.entities;
      bestTo = to;
    } else {
      hi = t;
    }
  }

  return { entities: best, to: bestTo, ok: lo > 0 };
}

/**
 * Ends of the given curves that sit on another curve's end but aren't joined
 * (no Coincident links them, directly or through others) - e.g. after the
 * constraints of a shape were deleted. Pairs where at least one side is one of
 * `ids`; centres don't count.
 */
export function touchingEnds(entities: SketchEntity[], constraints: SketchConstraint[], ids: Set<string>): [PointRef, PointRef][] {
  const ends = entities.flatMap(e => (e.construction && !ids.has(e.id) ? [] : pointsOf(e).filter(q => q.p !== 'c').map(q => ({ ref: { e: e.id, p: q.p }, at: q.at }))));
  let size = 1;
  for (const q of ends) {
    size = Math.max(size, Math.abs(q.at[0]), Math.abs(q.at[1]));
  }
  const tol = size * 1e-7;
  // Already joined: groups of points linked by Coincident.
  const parent = new Map<string, string>();
  const key = (pointRef: PointRef) => `${pointRef.e}:${pointRef.p}`;
  const find = (key: string): string => {
    let root = key;
    while (parent.has(root) && parent.get(root) !== root) {
      root = parent.get(root)!;
    }

    return root;
  };
  for (const constraint of constraints) {
    if (constraint.type === 'coincident' && constraint.pts?.length === 2 && !constraint.curves?.length) {
      parent.set(find(key(constraint.pts[0])), find(key(constraint.pts[1])));
    }
  }
  const out: [PointRef, PointRef][] = [];
  for (let i = 0; i < ends.length; i++) {
    for (let j = i + 1; j < ends.length; j++) {
      const endA = ends[i];
      const endB = ends[j];
      if (endA.ref.e === endB.ref.e || (!ids.has(endA.ref.e) && !ids.has(endB.ref.e))) {
        continue;
      }
      if (Math.hypot(endA.at[0] - endB.at[0], endA.at[1] - endB.at[1]) > tol) {
        continue;
      }
      const ka = find(key(endA.ref));
      const kb = find(key(endB.ref));
      if (ka === kb) {
        continue;
      }
      parent.set(ka, kb);
      out.push([endA.ref, endB.ref]);
    }
  }

  return out;
}
