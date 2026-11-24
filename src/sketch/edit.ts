// Pure sketch-editing operations (no UI): trim, extend, offset, fillet,
// transforms, projection of 3D edges, and text outlines.

import { roundSig, toPlane, toWorld } from '../geom';
import { constraintError, pointOf, pointsOf, refsOf, solve } from './constraints';
import { fitSpline } from './freehand';
import { arcFrom3, closestOnPrim, entityCorners, entityPrims, evalPrim, isClosedPrim, primSegments, samplePrim, splineHeights, splineHeightSamples, type Prim } from './curves';
import type { Arrangement, Region } from './regions';
import type { OutlineOffset, PlaneDef, SketchConstraint, SketchEntity, Vec2, Vec3 } from '../doc/types';

export function uid(): string {
  return Math.random().toString(36).slice(2, 10);
}

// ------------------------------------------------------------- transforms

export type Xf = (p: Vec2) => Vec2;

export const translateXf = (dx: number, dy: number): Xf => point => [point[0] + dx, point[1] + dy];
export const rotateXf = (center: Vec2, ang: number): Xf => {
  const cs = Math.cos(ang);
  const sn = Math.sin(ang);

  return point => [center[0] + (point[0] - center[0]) * cs - (point[1] - center[1]) * sn, center[1] + (point[0] - center[0]) * sn + (point[1] - center[1]) * cs];
};
export const scaleXf = (center: Vec2, factor: number): Xf => point => [center[0] + (point[0] - center[0]) * factor, center[1] + (point[1] - center[1]) * factor];
export const mirrorXf = (a: Vec2, b: Vec2): Xf => {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy || 1;

  return (point) => {
    const t = ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / l2;
    const fx = a[0] + dx * t;
    const fy = a[1] + dy * t;

    return [2 * fx - point[0], 2 * fy - point[1]];
  };
};

/** Apply a point transform to an entity, keeping its kind where possible. */
export function transformEntity(e: SketchEntity, xf: Xf, newId = false): SketchEntity {
  const id = newId ? uid() : e.id;
  const base = { id, construction: e.construction };
  const origin = xf([0, 0]);
  const ux = xf([1, 0]);
  const scale = Math.hypot(ux[0] - origin[0], ux[1] - origin[1]); // uniform scale factor
  const rot = Math.atan2(ux[1] - origin[1], ux[0] - origin[0]);
  const vy = xf([0, 1]);
  const mirrored = (ux[0] - origin[0]) * (vy[1] - origin[1]) - (ux[1] - origin[1]) * (vy[0] - origin[0]) < 0;
  switch (e.kind) {
    case 'line':
      return { ...base, kind: 'line', a: xf(e.a), b: xf(e.b) };
    case 'arc':
      return { ...base, kind: 'arc', a: xf(e.a), m: xf(e.m), b: xf(e.b) };
    case 'circle':
      return { ...base, kind: 'circle', center: xf(e.center), radius: e.radius * scale };
    case 'ellipse':
      // (Part of an ellipse, mirrored: it runs the other way round from the other side of its axis.)
      return { ...base, kind: 'ellipse', center: xf(e.center), rx: e.rx * scale, ry: e.ry * scale, rotation: mirrored ? rot - e.rotation : e.rotation + rot, ...(e.sweep === undefined ? {} : { a0: mirrored ? -(e.a0 ?? 0) : (e.a0 ?? 0), sweep: mirrored ? -e.sweep : e.sweep }) };
    case 'spline':
      // (Moved, turned or mirrored in the plane, its points stay as far off it; scaled, that much nearer or further.)
      return { ...base, kind: 'spline', points: e.points.map(xf), closed: e.closed, mode: e.mode, ...(e.z ? { z: e.z.map(value => value * scale) } : {}) };
    case 'rect':
      return { ...base, kind: 'rect', center: xf(e.center), w: e.w * scale, h: e.h * scale, rotation: mirrored ? rot - e.rotation : e.rotation + rot };
    case 'polygon': {
      const corner = xf(entityCorners(e)[0]);
      const center = xf(e.center);

      return { ...base, kind: 'polygon', center: center, radius: e.radius * scale, sides: e.sides, angle: Math.atan2(corner[1] - center[1], corner[0] - center[0]) };
    }
    case 'polyline':
      return { ...base, kind: 'polyline', points: e.points.map(xf), closed: e.closed };
  }
}

/** Characteristic points: endpoints, midpoints, centres (for snapping). */
export function guidePoints(e: SketchEntity): { p: Vec2; kind: 'end' | 'mid' | 'center' }[] {
  const out: { p: Vec2; kind: 'end' | 'mid' | 'center' }[] = [];
  switch (e.kind) {
    case 'line':
      out.push({ p: e.a, kind: 'end' }, { p: e.b, kind: 'end' }, { p: [(e.a[0] + e.b[0]) / 2, (e.a[1] + e.b[1]) / 2], kind: 'mid' });
      break;
    case 'arc': {
      out.push({ p: e.a, kind: 'end' }, { p: e.b, kind: 'end' });
      const arc = arcFrom3(e.a, e.m, e.b);
      if (arc) {
        out.push({ p: arc.c, kind: 'center' });
      }
      break;
    }
    case 'circle':
    case 'ellipse':
      out.push({ p: e.center, kind: 'center' });
      // (Part of an ellipse: its two ends and its middle.)
      for (const entityPrim of entityPrims(e)) {
        for (const t of e.kind === 'ellipse' && e.sweep !== undefined ? [0, 0.5, 1] : [0, 0.25, 0.5, 0.75]) {
          out.push({ p: evalPrim(entityPrim, t), kind: 'end' });
        }
      }
      break;
    case 'spline':
      e.points.forEach(point => out.push({ p: point, kind: 'end' }));
      break;
    case 'rect':
    case 'polygon':
    case 'polyline': {
      const pts = entityCorners(e);
      pts.forEach(point => out.push({ p: point, kind: 'end' }));
      for (let i = 0; i < pts.length - (e.kind === 'polyline' && !e.closed ? 1 : 0); i++) {
        const a = pts[i];
        const b = pts[(i + 1) % pts.length];
        out.push({ p: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], kind: 'mid' });
      }
      if (e.kind !== 'polyline') {
        out.push({ p: e.center, kind: 'center' });
      }
    }
  }

  return out;
}

// -------------------------------------------------------- trim & extend

/** Turn rects/polygons/polylines into separate lines (needed before trimming one side). */
export function explode(e: SketchEntity): SketchEntity[] {
  if (e.kind !== 'rect' && e.kind !== 'polygon' && e.kind !== 'polyline') {
    return [e];
  }

  return entityPrims(e).map(entityPrim => ({ id: uid(), kind: 'line', a: (entityPrim as { a: Vec2 }).a, b: (entityPrim as { b: Vec2 }).b, construction: e.construction }));
}

/**
 * A rectangle or polygon taken apart into lines that stay joined at the
 * corners (Coincident), so dragging one corner moves just that corner and the
 * two sides meeting there. A rectangle's sides also stay square to each other
 * (Horizontal / Vertical when it isn't turned, else Perpendicular / Parallel),
 * so it stretches as a rectangle; a polygon's corners move freely. The shape's
 * own constraints follow: its corners become the lines' ends, its width and
 * height the lengths of two sides; ones about its centre go.
 */
export function explodeJoined(
  e: SketchEntity,
  constraints: SketchConstraint[],
  newId: () => string
): { lines: SketchEntity[]; constraints: SketchConstraint[]; ref: (r: { e: string; p: string }) => { e: string; p: string } | null } | null {
  if (e.kind !== 'rect' && e.kind !== 'polygon') {
    return null;
  }
  const corners = entityCorners(e);
  const count = corners.length;
  const lines: SketchEntity[] = corners.map((a, i) => ({ id: newId(), kind: 'line', a, b: corners[(i + 1) % count], ...(e.construction ? { construction: true } : {}) }));
  const sid = (i: number) => lines[((i % count) + count) % count].id;
  const ref = (ref: { e: string; p: string }) => {
    if (ref.e !== e.id) {
      return ref;
    }
    const match = /^k(\d+)$/.exec(ref.p);

    return match ? { e: sid(Number(match[1])), p: 'a' } : null;
  };
  const cs: SketchConstraint[] = [];
  for (const constraint of constraints) {
    const onShape = constraint.curves?.includes(e.id);
    if (onShape) {
      if (constraint.type === 'dim' && e.kind === 'rect' && (constraint.prop === 'w' || constraint.prop === 'h')) {
        cs.push({ ...constraint, curves: [sid(constraint.prop === 'w' ? 0 : 1)], prop: 'length' });
      }
      // Other sizes and relations of the whole shape no longer have a curve to hold.
      continue;
    }
    if (constraint.pts?.some(point => point.e === e.id)) {
      const pts = constraint.pts.map(ref);
      if (pts.some(point => !point)) {
        continue;
      }
      cs.push({ ...constraint, pts: pts as { e: string; p: string }[] });
    } else {
      cs.push(constraint);
    }
  }
  for (let i = 0; i < count; i++) {
    cs.push({ id: newId(), type: 'coincident', pts: [{ e: sid(i), p: 'b' }, { e: sid(i + 1), p: 'a' }] });
  }
  if (e.kind === 'rect') {
    const turn = ((e.rotation % (Math.PI / 2)) + Math.PI / 2) % (Math.PI / 2);
    if (Math.min(turn, Math.PI / 2 - turn) < 1e-9) {
      const flat = Math.abs(Math.cos(e.rotation)) > 0.5;
      cs.push({ id: newId(), type: flat ? 'horizontal' : 'vertical', curves: [sid(0)] }, { id: newId(), type: flat ? 'horizontal' : 'vertical', curves: [sid(2)] });
      cs.push({ id: newId(), type: flat ? 'vertical' : 'horizontal', curves: [sid(1)] }, { id: newId(), type: flat ? 'vertical' : 'horizontal', curves: [sid(3)] });
    } else {
      cs.push({ id: newId(), type: 'perpendicular', curves: [sid(0), sid(1)] });
      cs.push({ id: newId(), type: 'parallel', curves: [sid(0), sid(2)] }, { id: newId(), type: 'parallel', curves: [sid(1), sid(3)] });
    }
  }

  return { lines, constraints: cs, ref };
}

/** Parameters where other entities cross primitive `prim`. */
export function crossings(prim: Prim, others: Prim[]): number[] {
  const ts: number[] = [];
  const samples = Math.max(primSegments(prim), 1) * 4;
  const pointsA = Array.from({ length: samples + 1 }, (_, i) => evalPrim(prim, i / samples));
  for (const q of others) {
    const samplesB = Math.max(primSegments(q), 1) * 4;
    const pointsB = Array.from({ length: samplesB + 1 }, (_, i) => evalPrim(q, i / samplesB));
    for (let i = 0; i < samples; i++) {
      for (let j = 0; j < samplesB; j++) {
        const hit = segHit2(pointsA[i], pointsA[i + 1], pointsB[j], pointsB[j + 1]);
        if (!hit) {
          continue;
        }
        // The samples only find it roughly: put it exactly on both curves.
        const [t] = refineCrossing(prim, q, (i + hit[0]) / samples, (j + hit[1]) / samplesB);
        if (t >= -1e-9 && t <= 1 + 1e-9) {
          ts.push(Math.min(1, Math.max(0, t)));
        }
      }
    }
    // A curve that ends right on `prim` (e.g. an arc left by an earlier trim) counts
    // as a crossing there: its samples may stop just short of p's.
    if (!isClosedPrim(q)) {
      const size = Math.max(1, ...pointsA.map(point => Math.max(Math.abs(point[0]), Math.abs(point[1]))));
      for (const end of [evalPrim(q, 0), evalPrim(q, 1)]) {
        const closest = closestOnPrim(prim, end);
        if (closest.d < size * 1e-7) {
          ts.push(closest.t);
        }
      }
    }
  }

  return ts.sort((a, b) => a - b);
}

/**
 * Newton on P(t) = Q(s): a crossing found between samples, moved exactly onto
 * both curves (round curves are only approximated by their samples - a cut
 * there would leave a hair-thin gap). Straight pieces are exact already.
 */
function refineCrossing(prim: Prim, q: Prim, t: number, paramB: number): [number, number] {
  const round = (x: Prim) => x.t === 'circle' || x.t === 'ellipse';
  if (!round(prim) && !round(q)) {
    return [t, paramB];
  }
  const t0 = t;
  const s0 = paramB;
  const step = 1e-7;
  for (let it = 0; it < 30; it++) {
    const pointOnP = evalPrim(prim, t);
    const pointOnQ = evalPrim(q, paramB);
    const fx = pointOnP[0] - pointOnQ[0];
    const fy = pointOnP[1] - pointOnQ[1];
    const Pt = evalPrim(prim, t + step);
    const Qs = evalPrim(q, paramB + step);
    const a = (Pt[0] - pointOnP[0]) / step;
    const dyDt = (Pt[1] - pointOnP[1]) / step;
    const b = -(Qs[0] - pointOnQ[0]) / step;
    const dyDs = -(Qs[1] - pointOnQ[1]) / step;
    const det = a * dyDs - b * dyDt;
    if (Math.abs(det) < 1e-14) {
      break;
    }
    const dt = (dyDs * fx - b * fy) / det;
    const ds = (-dyDt * fx + a * fy) / det;
    t -= dt;
    paramB -= ds;
    if (Math.abs(dt) < 1e-15 && Math.abs(ds) < 1e-15) {
      break;
    }
  }
  // Wandered off to some other crossing (or nowhere): keep the rough one.
  if (!Number.isFinite(t) || !Number.isFinite(paramB) || Math.abs(t - t0) > 0.05 || Math.abs(paramB - s0) > 0.05) {
    return [t0, s0];
  }

  return [t, paramB];
}

/** Where segments ab and cd cross: fractions along each (null if they don't). */
function segHit2(a: Vec2, b: Vec2, otherStart: Vec2, otherEnd: Vec2): [number, number] | null {
  const rx = b[0] - a[0];
  const ry = b[1] - a[1];
  const sx = otherEnd[0] - otherStart[0];
  const sy = otherEnd[1] - otherStart[1];
  const den = rx * sy - ry * sx;
  if (Math.abs(den) < 1e-14) {
    return null;
  }
  const qx = otherStart[0] - a[0];
  const qy = otherStart[1] - a[1];
  const fractionA = (qx * sy - qy * sx) / den;
  const fractionB = (qx * ry - qy * rx) / den;

  return fractionA >= -1e-9 && fractionA <= 1 + 1e-9 && fractionB >= -1e-9 && fractionB <= 1 + 1e-9 ? [fractionA, fractionB] : null;
}

function segHit(a: Vec2, b: Vec2, otherStart: Vec2, otherEnd: Vec2): number | null {
  const rx = b[0] - a[0];
  const ry = b[1] - a[1];
  const sx = otherEnd[0] - otherStart[0];
  const sy = otherEnd[1] - otherStart[1];
  const den = rx * sy - ry * sx;
  if (Math.abs(den) < 1e-14) {
    return null;
  }
  const qx = otherStart[0] - a[0];
  const qy = otherStart[1] - a[1];
  const fractionA = (qx * sy - qy * sx) / den;
  const fractionB = (qx * ry - qy * rx) / den;

  return fractionA >= -1e-9 && fractionA <= 1 + 1e-9 && fractionB >= -1e-9 && fractionB <= 1 + 1e-9 ? fractionA : null;
}

/** Remove the piece of `id` under `at` that lies between crossings. Returns the new entity list. */
export function trim(entities: SketchEntity[], id: string, at: Vec2): SketchEntity[] {
  let list = entities;
  let target = list.find(e => e.id === id);
  if (!target) {
    return entities;
  }
  // Straight-sided shapes: trim the one side that was tapped.
  if (target.kind === 'rect' || target.kind === 'polygon' || target.kind === 'polyline') {
    const parts = explode(target);
    list = list.flatMap(e => (e.id === id ? parts : [e]));
    target = parts.reduce((best, e) => (closestOnPrim(entityPrims(e)[0], at).d < closestOnPrim(entityPrims(best)[0], at).d ? e : best));
  }
  const prim = entityPrims(target)[0];
  const others = list.filter(e => e.id !== target!.id && !e.construction).flatMap(entityPrims);
  const ts = crossings(prim, others).filter((t, i, a) => i === 0 || t - a[i - 1] > 1e-6);
  const tap = closestOnPrim(prim, at).t;
  const closed = isClosedPrim(prim);
  const keep: [number, number][] = [];
  if (closed) {
    if (ts.length < 2) {
      return list.filter(e => e.id !== target!.id);
    }
    // The removed piece is between the crossings around the tap (cyclically).
    let lo = ts[ts.length - 1] - 1;
    let hi = ts[0];
    for (let i = 0; i < ts.length - 1; i++) {
      if (tap >= ts[i] && tap <= ts[i + 1]) {
        ((lo = ts[i]), (hi = ts[i + 1]));
      }
    }
    if (tap > ts[ts.length - 1]) {
      ((lo = ts[ts.length - 1]), (hi = ts[0] + 1));
    }
    keep.push([hi, lo + 1]);
  } else {
    const cuts = [0, ...ts.filter(t => t > 1e-6 && t < 1 - 1e-6), 1];
    for (let i = 0; i < cuts.length - 1; i++) {
      if (!(tap >= cuts[i] && tap <= cuts[i + 1])) {
        keep.push([cuts[i], cuts[i + 1]]);
      }
    }
  }
  const pieces = keep.map(([t0, t1]) => {
    const piece = pieceEntity(prim, t0, t1, target!.construction);
    // An end that wasn't cut stays exactly where it was (not re-evaluated).
    if (!closed && (piece.kind === 'line' || piece.kind === 'arc') && (target!.kind === 'line' || target!.kind === 'arc')) {
      if (t0 === 0) {
        piece.a = target!.a;
      }
      if (t1 === 1) {
        piece.b = target!.b;
      }
    }

    return piece;
  });
  // The piece that keeps the start (or the only one left) keeps the curve's id,
  // so what's tied to it stays tied (see carryConstraints).
  if (pieces.length) {
    const i = closed ? 0 : Math.max(0, keep.findIndex(([t0]) => t0 === 0));
    pieces[i] = { ...pieces[i], id: target.id };
  }

  return list.flatMap(e => (e.id === target!.id ? pieces : [e]));
}

/** Entity for part [t0, t1] of a primitive (t may exceed 1 for closed curves). */
export function pieceEntity(prim: Prim, t0: number, t1: number, construction?: boolean): SketchEntity {
  const at = (t: number) => evalPrim(prim, isClosedPrim(prim) && prim.t !== 'spline' ? t : Math.min(1, t > 1 ? t - 1 : t));
  if (prim.t === 'line') {
    return { id: uid(), kind: 'line', a: at(t0), b: at(t1), construction };
  }
  if (prim.t === 'circle') {
    return { id: uid(), kind: 'arc', a: at(t0), m: at((t0 + t1) / 2), b: at(t1), construction };
  }
  // Ellipses and splines: keep shape as a fit spline through samples.
  const samples = 12;
  const pts = Array.from({ length: samples + 1 }, (_, i) => at(t0 + ((t1 - t0) * i) / samples));

  return { id: uid(), kind: 'spline', points: pts, closed: false, mode: 'fit', construction };
}

/**
 * Extend the end of a line or arc nearest `at` to the next curve it would hit:
 * a line straight on, an arc along its own circle.
 */
export function extend(entities: SketchEntity[], id: string, at: Vec2): SketchEntity[] | null {
  const e = entities.find(entity => entity.id === id);
  if (!e || (e.kind !== 'line' && e.kind !== 'arc')) {
    return null;
  }
  const endB = Math.hypot(at[0] - e.b[0], at[1] - e.b[1]) < Math.hypot(at[0] - e.a[0], at[1] - e.a[1]);
  const others = entities.filter(entity => entity.id !== id && !entity.construction).flatMap(entityPrims);
  let path: Prim;
  if (e.kind === 'line') {
    const from = endB ? e.b : e.a;
    const other = endB ? e.a : e.b;
    const dx = from[0] - other[0];
    const dy = from[1] - other[1];
    const length = Math.hypot(dx, dy) || 1;
    // Far enough to pass everything in the sketch (and short enough to refine on).
    let reach = 1;
    for (const x of entities) {
      for (const point of pointsOf(x)) {
        reach = Math.max(reach, Math.hypot(point.at[0] - from[0], point.at[1] - from[1]));
      }
    }
    for (const q of others) {
      for (let i = 0; i <= 8; i++) {
        const prim = evalPrim(q, i / 8);
        reach = Math.max(reach, Math.hypot(prim[0] - from[0], prim[1] - from[1]));
      }
    }
    reach *= 3;
    path = { t: 'line', a: from, b: [from[0] + (dx / length) * reach, from[1] + (dy / length) * reach], src: '' };
  } else {
    const arc = arcFrom3(e.a, e.m, e.b);
    if (!arc) {
      return null;
    }
    // On round its circle from that end, the way the arc runs, up to its other end.
    const dir = endB ? Math.sign(arc.sweep) : -Math.sign(arc.sweep);
    const start = endB ? arc.a0 + arc.sweep : arc.a0;
    path = { t: 'circle', c: arc.c, r: arc.r, a0: start, sweep: dir * (2 * Math.PI - Math.abs(arc.sweep)), src: '' };
  }
  const ts = crossings(path, others).filter(t => t > 1e-9);
  if (!ts.length) {
    return null;
  }
  const to = evalPrim(path, ts[0]);
  if (e.kind === 'line') {
    return entities.map(entity => (entity.id === id ? { ...e, ...(endB ? { b: to } : { a: to }) } : entity));
  }

  return entities.map(entity => (entity.id === id ? moveEnd(e, endB ? 'b' : 'a', to) : entity));
}

/** Which end of an open curve the pick is nearer to ("a" or "b"); null for closed curves. */
export function endNear(e: SketchEntity, at: Vec2): 'a' | 'b' | null {
  const se = splineEnds(e);
  if (se) {
    return Math.hypot(at[0] - se[0][0], at[1] - se[0][1]) <= Math.hypot(at[0] - se[1][0], at[1] - se[1][1]) ? 'a' : 'b';
  }
  if (e.kind !== 'line' && e.kind !== 'arc') {
    return null;
  }

  return Math.hypot(at[0] - e.a[0], at[1] - e.a[1]) <= Math.hypot(at[0] - e.b[0], at[1] - e.b[1]) ? 'a' : 'b';
}

type Carrier = { kind: 'line'; p: Vec2; d: Vec2 } | { kind: 'circle'; c: Vec2; r: number };

type Piece = Extract<SketchEntity, { kind: 'line' | 'arc' | 'spline' }>;

/** Where an open spline starts and ends (its real curve ends). */
export function splineEnds(e: SketchEntity): [Vec2, Vec2] | null {
  if (e.kind !== 'spline' || e.closed || e.points.length < 2) {
    return null;
  }
  const firstEntityPrim = entityPrims(e)[0];

  return [evalPrim(firstEntityPrim, 0), evalPrim(firstEntityPrim, 1)];
}

/** The same curve run the other way. */
function reverseIf(e: SketchEntity, rev: boolean): SketchEntity {
  if (!rev) {
    return e;
  }
  if (e.kind === 'line' || e.kind === 'arc') {
    return { ...e, a: e.b, b: e.a } as SketchEntity;
  }
  if (e.kind === 'spline') {
    return { ...e, points: [...e.points].reverse(), ...(e.z ? { z: [...e.z].reverse() } : {}) };
  }

  return e;
}

/** Point on a circle in the direction of q. */
function towards(center: Vec2, q: Vec2, radius: number): Vec2 {
  const length = Math.hypot(q[0] - center[0], q[1] - center[1]) || 1;

  return [center[0] + ((q[0] - center[0]) / length) * radius, center[1] + ((q[1] - center[1]) / length) * radius];
}

/** A spline end's tangent as a line carrier (to carry it on straight). */
function splineEndCarrier(e: SketchEntity, end: 'a' | 'b'): Carrier | null {
  if (e.kind !== 'spline') {
    return null;
  }
  const firstEntityPrim = entityPrims(e)[0];
  const q = evalPrim(firstEntityPrim, end === 'a' ? 0 : 1);
  const prim = evalPrim(firstEntityPrim, end === 'a' ? 0.01 : 0.99);

  return { kind: 'line', p: q, d: [q[0] - prim[0], q[1] - prim[1]] };
}

function carrierOf(e: SketchEntity): Carrier | null {
  if (e.kind === 'line') {
    return { kind: 'line', p: e.a, d: [e.b[0] - e.a[0], e.b[1] - e.a[1]] };
  }
  if (e.kind === 'arc') {
    const arc = arcFrom3(e.a, e.m, e.b);

    return arc ? { kind: 'circle', c: arc.c, r: arc.r } : null;
  }

  return null;
}

/** Where two infinite lines / full circles cross. */
function carrierCrossings(carrier: Carrier, other: Carrier): Vec2[] {
  if (carrier.kind === 'circle' && other.kind === 'line') {
    return carrierCrossings(other, carrier);
  }
  if (carrier.kind === 'line' && other.kind === 'line') {
    const det = carrier.d[0] * other.d[1] - carrier.d[1] * other.d[0];
    if (Math.abs(det) < 1e-12 * (Math.hypot(...carrier.d) * Math.hypot(...other.d) || 1)) {
      return [];
    }
    const t = ((other.p[0] - carrier.p[0]) * other.d[1] - (other.p[1] - carrier.p[1]) * other.d[0]) / det;

    return [[carrier.p[0] + carrier.d[0] * t, carrier.p[1] + carrier.d[1] * t]];
  }
  if (carrier.kind === 'line' && other.kind === 'circle') {
    const length = Math.hypot(...carrier.d) || 1;
    const direction: Vec2 = [carrier.d[0] / length, carrier.d[1] / length];
    const fromCenter: Vec2 = [carrier.p[0] - other.c[0], carrier.p[1] - other.c[1]];
    const b = fromCenter[0] * direction[0] + fromCenter[1] * direction[1];
    const disc = b * b - (fromCenter[0] * fromCenter[0] + fromCenter[1] * fromCenter[1] - other.r * other.r);
    if (disc < -1e-12) {
      return [];
    }
    const root = Math.sqrt(Math.max(0, disc));

    return [-b - root, -b + root].map(t => [carrier.p[0] + direction[0] * t, carrier.p[1] + direction[1] * t] as Vec2);
  }
  if (carrier.kind === 'circle' && other.kind === 'circle') {
    const dx = other.c[0] - carrier.c[0];
    const dy = other.c[1] - carrier.c[1];
    const distance = Math.hypot(dx, dy);
    if (distance < 1e-12 || distance > carrier.r + other.r + 1e-9 || distance < Math.abs(carrier.r - other.r) - 1e-9) {
      return [];
    }
    const a = (carrier.r * carrier.r - other.r * other.r + distance * distance) / (2 * distance);
    const halfChord = Math.sqrt(Math.max(0, carrier.r * carrier.r - a * a));
    const base: Vec2 = [carrier.c[0] + (dx * a) / distance, carrier.c[1] + (dy * a) / distance];

    return [
      [base[0] - (dy * halfChord) / distance, base[1] + (dx * halfChord) / distance],
      [base[0] + (dy * halfChord) / distance, base[1] - (dx * halfChord) / distance]
    ];
  }

  return [];
}

/** Move one end of a line/arc to `to` (an arc keeps its circle and its other end). */
function moveEnd(e: SketchEntity, end: 'a' | 'b', to: Vec2): SketchEntity {
  if (e.kind === 'line') {
    return { ...e, [end]: to };
  }
  if (e.kind === 'spline' && !e.closed) {
    // The end fit point moves there.
    const pts = [...e.points];
    pts[end === 'a' ? 0 : pts.length - 1] = to;

    // (Its heights stay with its points: the spread above keeps them.)
    return { ...e, points: pts };
  }
  if (e.kind !== 'arc') {
    return e;
  }
  const arc = arcFrom3(e.a, e.m, e.b);
  if (!arc) {
    return e;
  }
  const ang = (q: Vec2) => Math.atan2(q[1] - arc.c[1], q[0] - arc.c[0]);
  const a = end === 'a' ? to : e.a;
  const b = end === 'b' ? to : e.b;
  // Keep the arc's turning direction; the new mid point halves the new sweep.
  const dir = Math.sign(arc.sweep) || 1;
  let sweep = ang(b) - ang(a);
  while (dir > 0 && sweep <= 1e-9) {
    sweep += 2 * Math.PI;
  }
  while (dir < 0 && sweep >= -1e-9) {
    sweep -= 2 * Math.PI;
  }
  const t = ang(a) + sweep / 2;

  return { ...e, a, b, m: [arc.c[0] + arc.r * Math.cos(t), arc.c[1] + arc.r * Math.sin(t)] };
}

/**
 * Extend (or trim) two open curves so the picked ends meet: each pick says
 * which end (the half that was tapped). Lines run along their direction,
 * arcs along their circle. Picking both halves of one arc closes it into a circle.
 */
export function joinEnds(entities: SketchEntity[], first: { id: string; at: Vec2 }, second: { id: string; at: Vec2 }): SketchEntity[] | null {
  const e1 = entities.find(entity => entity.id === first.id);
  const e2 = entities.find(entity => entity.id === second.id);
  if (!e1 || !e2) {
    return null;
  }
  const end1 = endNear(e1, first.at);
  const end2 = endNear(e2, second.at);
  if (!end1 || !end2) {
    return null;
  }
  if (e1.id === e2.id) {
    if (e1.kind !== 'arc' || end1 === end2) {
      return null;
    }
    const arc = arcFrom3(e1.a, e1.m, e1.b);
    if (!arc) {
      return null;
    }
    const circle: SketchEntity = { id: e1.id, kind: 'circle', center: arc.c, radius: arc.r, construction: e1.construction };

    return entities.map(entity => (entity.id === e1.id ? circle : entity));
  }
  // A spline end carries on along its end tangent.
  const k1 = carrierOf(e1) ?? splineEndCarrier(e1, end1);
  const k2 = carrierOf(e2) ?? splineEndCarrier(e2, end2);
  if (!k1 || !k2) {
    return null;
  }
  const endPt = (e: SketchEntity, end: 'a' | 'b'): Vec2 => splineEnds(e)?.[end === 'a' ? 0 : 1] ?? (e as Extract<SketchEntity, { kind: 'line' | 'arc' }>)[end];
  const p1 = endPt(e1, end1);
  const p2 = endPt(e2, end2);
  // A line running into a spline (as it is, or carried on): it stops on the spline itself.
  if ((e1.kind === 'spline') !== (e2.kind === 'spline')) {
    const [ln, lnEnd, sp] = e1.kind === 'spline' ? [e2, end2, e1] : [e1, end1, e2];
    if (ln.kind === 'line') {
      const from = ln[lnEnd];
      const other = lnEnd === 'a' ? ln.b : ln.a;
      const length = Math.hypot(from[0] - other[0], from[1] - other[1]) || 1;
      const dir: Vec2 = [(from[0] - other[0]) / length, (from[1] - other[1]) / length];
      const farA: Vec2 = [other[0] - dir[0] * 1e6, other[1] - dir[1] * 1e6];
      const farB: Vec2 = [from[0] + dir[0] * 1e6, from[1] + dir[1] * 1e6];
      const pts = samplePrim(entityPrims(sp)[0], 0, 1);
      let best: Vec2 | null = null;
      let bd = Infinity;
      for (let i = 0; i < pts.length - 1; i++) {
        const hit = segHit(farA, farB, pts[i], pts[i + 1]);
        if (hit === null) {
          continue;
        }
        const q: Vec2 = [farA[0] + (farB[0] - farA[0]) * hit, farA[1] + (farB[1] - farA[1]) * hit];
        const dd = Math.hypot(q[0] - from[0], q[1] - from[1]);
        if (dd < bd) {
          [bd, best] = [dd, q];
        }
      }
      if (best) {
        return entities.map(entity => (entity.id === ln.id ? moveEnd(ln, lnEnd, best!) : entity));
      }
    }
  }
  const cands = carrierCrossings(k1, k2);
  if (!cands.length) {
    return null;
  }
  // The meeting point nearest both picked ends.
  const cost = (q: Vec2) => Math.hypot(q[0] - p1[0], q[1] - p1[1]) + Math.hypot(q[0] - p2[0], q[1] - p2[1]);
  const to = cands.reduce((best, q) => (cost(q) < cost(best) ? q : best), cands[0]);
  // A spline carries on to the meeting point (it becomes its new end point).
  const reach = (e: SketchEntity, end: 'a' | 'b'): SketchEntity => {
    if (e.kind !== 'spline') {
      return moveEnd(e, end, to);
    }

    return { ...e, points: end === 'a' ? [to, ...e.points] : [...e.points, to] };
  };

  return entities.map(entity => (entity.id === e1.id ? reach(e1, end1) : entity.id === e2.id ? reach(e2, end2) : entity));
}

/**
 * Cut a line or arc in two: at its midpoint, or at the point nearest `at`.
 * The second piece gets `newId`; returns null for other curves.
 */
export function splitEntity(entities: SketchEntity[], id: string, newId: string, at?: Vec2): SketchEntity[] | null {
  const e = entities.find(entity => entity.id === id);
  if (!e) {
    return null;
  }
  if (e.kind === 'line') {
    const direction: Vec2 = [e.b[0] - e.a[0], e.b[1] - e.a[1]];
    const L2 = direction[0] * direction[0] + direction[1] * direction[1];
    let t = 0.5;
    if (at && L2 > 0) {
      t = ((at[0] - e.a[0]) * direction[0] + (at[1] - e.a[1]) * direction[1]) / L2;
    }
    if (!(t > 1e-6 && t < 1 - 1e-6)) {
      return null;
    }
    const point: Vec2 = [e.a[0] + direction[0] * t, e.a[1] + direction[1] * t];

    return entities.flatMap(entity => (entity.id === id ? [{ ...e, b: point }, { ...e, id: newId, a: point }] : [entity]));
  }
  if (e.kind === 'arc') {
    const arc = arcFrom3(e.a, e.m, e.b);
    if (!arc) {
      return null;
    }
    let t = 0.5;
    if (at) {
      const ang = Math.atan2(at[1] - arc.c[1], at[0] - arc.c[0]);
      let fraction = (ang - arc.a0) / arc.sweep;
      // Bring the angle into the arc's own sweep.
      const turn = (2 * Math.PI) / Math.abs(arc.sweep);
      while (fraction < 0) {
        fraction += turn;
      }
      while (fraction > 1 && fraction - turn >= 0) {
        fraction -= turn;
      }
      t = fraction;
    }
    if (!(t > 1e-6 && t < 1 - 1e-6)) {
      return null;
    }
    const pt = (fraction: number): Vec2 => [arc.c[0] + arc.r * Math.cos(arc.a0 + arc.sweep * fraction), arc.c[1] + arc.r * Math.sin(arc.a0 + arc.sweep * fraction)];
    const point = pt(t);

    return entities.flatMap(entity => (entity.id === id ? [{ ...e, m: pt(t / 2), b: point }, { ...e, id: newId, a: point, m: pt((1 + t) / 2) }] : [entity]));
  }

  return null;
}

/**
 * Where the grid (lines every `step`) crosses curve `e`, nearest to `at`; or
 * simply the curve's point nearest `at` if no grid line crosses it.
 */
export function gridPointOn(e: SketchEntity, at: Vec2, step: number): Vec2 {
  let best: { p: Vec2; d: number } | null = null;
  const consider = (point: Vec2) => {
    const distance = Math.hypot(point[0] - at[0], point[1] - at[1]);
    if (!best || distance < best.d) {
      best = { p: point, d: distance };
    }
  };
  for (const prim of entityPrims(e)) {
    const samples = Math.max(primSegments(prim), 1) * 4;
    const poly = Array.from({ length: samples + 1 }, (_, i) => evalPrim(prim, i / samples));
    for (let i = 0; i < samples; i++) {
      const [a, b] = [poly[i], poly[i + 1]];
      for (const axis of [0, 1] as const) {
        if (Math.abs(b[axis] - a[axis]) < 1e-12) {
          continue;
        }
        const lo = Math.min(a[axis], b[axis]);
        const hi = Math.max(a[axis], b[axis]);
        for (let gridLine = Math.ceil(lo / step) * step; gridLine <= hi; gridLine += step) {
          // Onto the curve itself (not the straight piece between samples): halve the step until it sits on the grid line.
          let t0 = i / samples;
          let t1 = (i + 1) / samples;
          const offsetAt = (t: number) => evalPrim(prim, t)[axis] - gridLine;
          let f0 = offsetAt(t0);
          for (let it = 0; it < 50; it++) {
            const tm = (t0 + t1) / 2;
            const fm = offsetAt(tm);
            if (Math.sign(fm) === Math.sign(f0)) {
              ((t0 = tm), (f0 = fm));
            } else {
              t1 = tm;
            }
          }
          consider(evalPrim(prim, (t0 + t1) / 2));
        }
      }
    }
  }
  if (best) {
    return (best as { p: Vec2 }).p;
  }
  const prim = entityPrims(e)[0];

  return prim ? closestOnPrim(prim, at).pt : at;
}

/**
 * Split any curve where it's tapped. Lines: in half (or right at `at` with
 * `exact`). Straight-sided shapes (rectangle, polygon, outline): they come
 * apart into lines and the tapped side is split in half. Curves (arcs,
 * circles, ellipses, splines): where the grid crosses them, nearest the tap.
 * Returns the new list and the ids of the pieces.
 */
export function splitAny(entities: SketchEntity[], id: string, at: Vec2, step: number, exact: boolean, newId: () => string): { entities: SketchEntity[]; parts: string[]; exploded: boolean } | null {
  const e = entities.find(entity => entity.id === id);
  if (!e) {
    return null;
  }
  if (e.kind === 'line') {
    const nextId = newId();
    const out = splitEntity(entities, id, nextId, exact ? at : undefined);

    return out && { entities: out, parts: [id, nextId], exploded: false };
  }
  if (e.kind === 'rect' || e.kind === 'polygon' || e.kind === 'polyline') {
    const sides = explode(e);
    const side = sides.reduce((sketchEntity, side) => (closestOnPrim(entityPrims(side)[0], at).d < closestOnPrim(entityPrims(sketchEntity)[0], at).d ? side : sketchEntity));
    const list = entities.flatMap(entity => (entity.id === id ? sides : [entity]));
    const nextId = newId();
    const out = splitEntity(list, side.id, nextId, exact ? at : undefined);

    return out && { entities: out, parts: [...sides.map(side => side.id), nextId], exploded: true };
  }
  const point = exact ? closestOnPrim(entityPrims(e)[0], at).pt : gridPointOn(e, at, step);
  if (e.kind === 'arc') {
    const nextId = newId();
    const out = splitEntity(entities, id, nextId, point);

    return out && { entities: out, parts: [id, nextId], exploded: false };
  }
  if (e.kind === 'circle') {
    // A whole circle: two half circles, meeting at the split point and opposite it.
    const t = Math.atan2(point[1] - e.center[1], point[0] - e.center[0]);
    const pt = (a: number): Vec2 => [e.center[0] + e.radius * Math.cos(a), e.center[1] + e.radius * Math.sin(a)];
    const nextId = newId();
    const a1: SketchEntity = { id, kind: 'arc', a: pt(t), m: pt(t + Math.PI / 2), b: pt(t + Math.PI), construction: e.construction };
    const a2: SketchEntity = { id: nextId, kind: 'arc', a: pt(t + Math.PI), m: pt(t + (3 * Math.PI) / 2), b: pt(t), construction: e.construction };

    return { entities: entities.flatMap(entity => (entity.id === id ? [a1, a2] : [entity])), parts: [id, nextId], exploded: true };
  }
  if (e.kind === 'ellipse' || e.kind === 'spline') {
    // An ellipse becomes a smooth closed spline through 12 of its points first.
    const prim = entityPrims(e)[0];
    let pts: Vec2[];
    let closed: boolean;
    let mode: 'fit' | 'control' = 'fit';
    if (e.kind === 'spline') {
      pts = e.points;
      closed = e.closed;
      mode = e.mode;
    } else if (e.sweep !== undefined) {
      // Part of an ellipse: an open spline through 13 of its points.
      pts = Array.from({ length: 13 }, (_, i) => evalPrim(prim, i / 12));
      closed = false;
    } else {
      pts = Array.from({ length: 12 }, (_, i) => evalPrim(prim, i / 12));
      closed = true;
    }
    // The span the point is on (spans run between consecutive points).
    const param = closestOnPrim(prim, point).t;
    const spans = closed ? pts.length : pts.length - 1;
    const span = Math.max(0, Math.min(spans - 1, Math.floor(param * spans + 1e-9)));
    // A spline with points off the plane: each piece keeps its points' heights, and the new end is as high as the
    // curve is there. (The pieces came out flat on the plane.)
    const z = splineHeights(e);
    const high = z ? splineHeightSamples(e) : null;
    const zP = high ? (high[Math.max(0, Math.min(high.length - 1, Math.round(param * (high.length - 1))))] ?? 0) : 0;
    const up = (list: number[]) => (z ? { z: list } : {});
    if (closed) {
      // A closed loop opens up at that point (one piece, both ends there).
      const ring = [...pts.slice(span + 1), ...pts.slice(0, span + 1)];
      const open: SketchEntity = { id, kind: 'spline', points: [point, ...ring, point], closed: false, mode, construction: e.construction, ...up(z ? [zP, ...z.slice(span + 1), ...z.slice(0, span + 1), zP] : []) };

      return { entities: entities.map(entity => (entity.id === id ? open : entity)), parts: [id], exploded: true };
    }
    const nextId = newId();
    const first: SketchEntity = { id, kind: 'spline', points: [...pts.slice(0, span + 1), point], closed: false, mode, construction: e.construction, ...up(z ? [...z.slice(0, span + 1), zP] : []) };
    const second: SketchEntity = { id: nextId, kind: 'spline', points: [point, ...pts.slice(span + 1)], closed: false, mode, construction: e.construction, ...up(z ? [zP, ...z.slice(span + 1)] : []) };

    return { entities: entities.flatMap(entity => (entity.id === id ? [first, second] : [entity])), parts: [id, nextId], exploded: false };
  }

  return null;
}

/**
 * Fillet two lines picked by their halves: first they're extended/trimmed to
 * meet (like `joinEnds`), then the corner is rounded with `radius`.
 */
export function filletEnds(entities: SketchEntity[], first: { id: string; at: Vec2 }, second: { id: string; at: Vec2 }, radius: number): SketchEntity[] | null {
  const e1 = entities.find(entity => entity.id === first.id);
  const e2 = entities.find(entity => entity.id === second.id);
  if (e1?.kind !== 'line' || e2?.kind !== 'line' || e1.id === e2.id) {
    return null;
  }
  const joined = joinEnds(entities, first, second);
  if (!joined) {
    return null;
  }
  const end = endNear(e1, first.at)!;
  const corner = (joined.find(sketchEntity => sketchEntity.id === e1.id) as Extract<SketchEntity, { kind: 'line' }>)[end];
  const size = Math.max(Math.hypot(e1.b[0] - e1.a[0], e1.b[1] - e1.a[1]), Math.hypot(e2.b[0] - e2.a[0], e2.b[1] - e2.a[1]), 1);

  return filletCorner(joined, corner, radius, size * 1e-7);
}

/**
 * Turn line `id2` so it makes `deg` degrees with line `id1`, about its end
 * nearest to line 1. Both lines are re-oriented to point away from where they
 * (would) meet, so their a→b directions span exactly that angle; `swapped`
 * lists lines whose ends were exchanged (point refs a/b must follow).
 */
export function angleLines(entities: SketchEntity[], id1: string, id2: string, deg: number): { entities: SketchEntity[]; swapped: string[] } | null {
  const l1 = entities.find(e => e.id === id1);
  const l2 = entities.find(e => e.id === id2);
  if (l1?.kind !== 'line' || l2?.kind !== 'line' || id1 === id2) {
    return null;
  }
  const d1raw: Vec2 = [l1.b[0] - l1.a[0], l1.b[1] - l1.a[1]];
  const L1 = Math.hypot(...d1raw);
  if (L1 < 1e-12) {
    return null;
  }
  // Pivot: the end of line 2 closest to line 1 (its infinite line).
  const off = (q: Vec2) => Math.abs((q[0] - l1.a[0]) * d1raw[1] - (q[1] - l1.a[1]) * d1raw[0]) / L1;
  const pivotIsA = off(l2.a) <= off(l2.b);
  const pivot = pivotIsA ? l2.a : l2.b;
  const far = pivotIsA ? l2.b : l2.a;
  const d2: Vec2 = [far[0] - pivot[0], far[1] - pivot[1]];
  const L2 = Math.hypot(...d2);
  if (L2 < 1e-12) {
    return null;
  }
  // Line 1 points away from the meeting point (its far end from line 2's pivot).
  const da = Math.hypot(l1.a[0] - pivot[0], l1.a[1] - pivot[1]);
  const db = Math.hypot(l1.b[0] - pivot[0], l1.b[1] - pivot[1]);
  const flip1 = db < da;
  const along: Vec2 = flip1 ? [-d1raw[0] / L1, -d1raw[1] / L1] : [d1raw[0] / L1, d1raw[1] / L1];
  // Keep the side line 2 is on now (counter-clockwise or clockwise from line 1).
  const side = along[0] * d2[1] - along[1] * d2[0] >= 0 ? 1 : -1;
  const t = Math.atan2(along[1], along[0]) + side * (deg * Math.PI) / 180;
  const nf: Vec2 = [pivot[0] + Math.cos(t) * L2, pivot[1] + Math.sin(t) * L2];
  const swapped: string[] = [];
  if (flip1) {
    swapped.push(id1);
  }
  if (!pivotIsA) {
    swapped.push(id2);
  }

  return {
    entities: entities.map(e => (e.id === id1 && flip1 ? { ...l1, a: l1.b, b: l1.a } : e.id === id2 ? { ...l2, a: pivot, b: nf } : e)),
    swapped
  };
}

/** A curve with open ends (line/arc), walked in the chain's direction. */
export interface ChainLink {
  id: string;
  /** Walked b→a rather than a→b. */
  reversed: boolean;
}

/**
 * Curves joined end to end with `id` (lines and arcs), in order. `closed`
 * when the last one comes back to where the first started.
 */
export function connectedChain(entities: SketchEntity[], id: string): { links: ChainLink[]; closed: boolean } | null {
  // Lines, arcs and open splines, by their two ends.
  type Open = { id: string; a: Vec2; b: Vec2 };
  const open: Open[] = entities.flatMap((e) => {
    if (e.construction) {
      return [];
    }
    if (e.kind === 'line' || e.kind === 'arc') {
      return [{ id: e.id, a: e.a, b: e.b }];
    }
    const ends = splineEnds(e);

    return ends ? [{ id: e.id, a: ends[0], b: ends[1] }] : [];
  });
  const start = open.find(e => e.id === id);
  if (!start) {
    return null;
  }
  const size = Math.max(1, ...open.flatMap(e => [Math.abs(e.a[0]), Math.abs(e.a[1]), Math.abs(e.b[0]), Math.abs(e.b[1])]));
  const tol = size * 1e-7;
  const same = (point: Vec2, q: Vec2) => Math.hypot(point[0] - q[0], point[1] - q[1]) < tol;
  const used = new Set([start.id]);
  const walk = (from: Vec2): ChainLink[] => {
    const out: ChainLink[] = [];
    let at = from;
    for (;;) {
      const next = open.find(e => !used.has(e.id) && (same(e.a, at) || same(e.b, at)));
      if (!next) {
        return out;
      }
      used.add(next.id);
      const reversed = !same(next.a, at);
      out.push({ id: next.id, reversed });
      at = reversed ? next.a : next.b;
    }
  };
  const forward = walk(start.b);
  const last = forward.length ? open.find(e => e.id === forward[forward.length - 1].id)! : start;
  const lastEnd = forward.length ? (forward[forward.length - 1].reversed ? last.a : last.b) : start.b;
  const closed = forward.length > 0 && same(lastEnd, start.a);
  // Not closed: also walk backwards from the start, then flip that part.
  const backward = closed ? [] : walk(start.a).reverse().map(chainLink => ({ ...chainLink, reversed: !chainLink.reversed }));

  return { links: [...backward, { id: start.id, reversed: false }, ...forward], closed };
}

/**
 * Offset a whole chain (e.g. a closed outline made of lines and arcs) by `d`:
 * each piece moves sideways and neighbours are trimmed/extended to meet again,
 * so a closed shape stays closed. Positive `d` grows a closed shape outward.
 */
export function offsetChain(entities: SketchEntity[], id: string, distance: number): SketchEntity[] | null {
  const chain = connectedChain(entities, id);
  if (!chain) {
    return null;
  }
  const byId = new Map(entities.map(e => [e.id, e]));
  // Walk direction: flip pieces walked backwards so every piece runs along the chain.
  const pieces = chain.links.map(link => reverseIf(byId.get(link.id)!, link.reversed) as Piece);
  // Outward is to the right of a counter-clockwise loop (offsetEntity goes left).
  let side = 1;
  if (chain.closed) {
    const poly = pieces.flatMap(e => (e.kind === 'arc' ? [e.a, e.m] : e.kind === 'spline' ? samplePrim(entityPrims(e)[0], 0, 1).slice(0, -1) : [e.a]));
    let area = 0;
    for (let i = 0; i < poly.length; i++) {
      const point = poly[i];
      const q = poly[(i + 1) % poly.length];
      area += point[0] * q[1] - q[0] * point[1];
    }
    side = area > 0 ? -1 : 1;
  }
  // offsetEntity moves lines to their left but arcs always outward: an arc
  // turning left (counter-clockwise) has its left side towards its centre.
  const leftOf = (e: Piece) => (e.kind === 'arc' && (arcFrom3(e.a, e.m, e.b)?.sweep ?? 0) > 0 ? -1 : 1);
  const endOf = (e: Piece, end: 'a' | 'b'): Vec2 => (e.kind === 'spline' ? splineEnds(e)![end === 'a' ? 0 : 1] : e[end]);
  const lenOf = (e: Piece) => (e.kind === 'line' ? Math.hypot(e.b[0] - e.a[0], e.b[1] - e.a[1]) : 1);
  let size = 1;
  for (const e of pieces) {
    for (const end of ['a', 'b'] as const) {
      size = Math.max(size, Math.abs(endOf(e, end)[0]), Math.abs(endOf(e, end)[1]));
    }
  }
  // Pieces that would shrink past nothing (a fillet offset inward beyond its
  // radius, a side squeezed out between its neighbours) drop out, and their
  // neighbours meet straight away - like a CAD offset, not an inside-out loop.
  let alive = pieces.map((_, i) => i);
  let out: Piece[] = [];
  const allLines = pieces.every(e => e.kind === 'line');
  for (let round = 0; round <= pieces.length; round++) {
    if (alive.length < (chain.closed ? 2 : 1)) {
      return null;
    }
    const moved = alive.map(i => offsetEntity(pieces[i], leftOf(pieces[i]) * side * distance) as Piece | null);
    const gone = alive.filter((_, index) => !moved[index]);
    if (gone.length) {
      alive = alive.filter(i => !gone.includes(i));
      continue;
    }
    out = moved as Piece[];
    // Re-join neighbours where their offset carriers cross, nearest the original corner.
    const count = out.length;
    for (let i = 0; i < (chain.closed ? count : count - 1); i++) {
      const j = (i + 1) % count;
      const k1 = carrierOf(out[i]);
      const k2 = carrierOf(out[j]);
      const corner = endOf(pieces[alive[i]], 'b');
      let meet: Vec2 | null = null;
      if (k1 && k2) {
        const cands = carrierCrossings(k1, k2);
        if (cands.length) {
          meet = cands.reduce((best, q) => (Math.hypot(q[0] - corner[0], q[1] - corner[1]) < Math.hypot(best[0] - corner[0], best[1] - corner[1]) ? q : best), cands[0]);
        }
      } else if (k1 || k2) {
        // A spline next to a line/arc: the spline's offset end, brought onto the other's carrier.
        const carrier = (k1 ?? k2)!;
        const q = k1 ? endOf(out[j], 'a') : endOf(out[i], 'b');
        meet = carrier.kind === 'line' ? projectOnLine(q, carrier.p, [carrier.p[0] + carrier.d[0], carrier.p[1] + carrier.d[1]]) : towards(carrier.c, q, carrier.r);
      } else {
        // Two splines: halfway between their offset ends.
        const end = endOf(out[i], 'b');
        const q = endOf(out[j], 'a');
        meet = [(end[0] + q[0]) / 2, (end[1] + q[1]) / 2];
      }
      // Neighbours that no longer meet (parallel after a piece between them went): no outline.
      if (!meet && alive[j] !== (alive[i] + 1) % pieces.length) {
        return null;
      }
      // Tangent neighbours (e.g. line into a fillet) already meet: keep the offset end.
      if (!meet) {
        meet = endOf(out[i], 'b');
      }
      out[i] = moveEnd(out[i], 'b', meet) as (typeof out)[number];
      out[j] = moveEnd(out[j], 'a', meet) as (typeof out)[number];
    }
    // All straight: no piece is dropped here - the offset is cut where it crosses
    // itself instead, and what turned round or runs too near the outline goes
    // (cleanLineOffset). Dropping pieces one by one lost whole lobes of a shape
    // past a narrow notch.
    if (allLines) {
      break;
    }
    // Turned round or squeezed to nothing: that piece goes, and again.
    const flipped = alive.filter((src, index) => {
      const piece = out[index];
      const e = pieces[src];
      if (piece.kind === 'line' && e.kind === 'line') {
        const dot = (piece.b[0] - piece.a[0]) * (e.b[0] - e.a[0]) + (piece.b[1] - piece.a[1]) * (e.b[1] - e.a[1]);

        return dot <= 0 || lenOf(piece) < size * 1e-9;
      }
      if (piece.kind === 'arc' && e.kind === 'arc') {
        const c0 = arcFrom3(e.a, e.m, e.b);
        const c1 = arcFrom3(piece.a, piece.m, piece.b);

        return !c0 || !c1 || Math.sign(c0.sweep) !== Math.sign(c1.sweep) || Math.abs(c1.sweep) > Math.abs(c0.sweep) + Math.PI / 2 || Math.hypot(piece.b[0] - piece.a[0], piece.b[1] - piece.a[1]) < size * 1e-9;
      }

      return false;
    });
    if (!flipped.length) {
      break;
    }
    alive = alive.filter(i => !flipped.includes(i));
  }
  // Straight pieces: what still runs closer to the outline than the distance
  // (across a narrow spike or neck it swung past the far side) is cut away -
  // the offset never crosses the original.
  if (out.every(e => e.kind === 'line') && pieces.every(e => e.kind === 'line')) {
    const clean = cleanLineOffset(pieces as Extract<SketchEntity, { kind: 'line' }>[], out as Extract<SketchEntity, { kind: 'line' }>[], distance, chain.closed);
    if (!clean) {
      return null;
    }

    return [...entities, ...clean.map(e => ({ ...e, id: uid() }))];
  }

  return [...entities, ...out.map(e => ({ ...e, id: uid() }))];
}

/**
 * The offset of straight pieces, cut where it crosses itself, keeping only the
 * parts at least the distance from the original (and, for a closed outline, on
 * the side it was offset to) - joined up again into one or more outlines.
 * `grow` > 0: a closed outline grows (the offset is outside it).
 */
function cleanLineOffset(orig: LineE[], off: LineE[], grow: number, closed: boolean): LineE[] | null {
  const distance = Math.abs(grow);
  let size = 1;
  for (const e of [...orig, ...off]) {
    for (const q of [e.a, e.b]) {
      size = Math.max(size, Math.abs(q[0]), Math.abs(q[1]));
    }
  }
  const eps = size * 1e-9;
  const distSeg = (q: Vec2, a: Vec2, b: Vec2) => {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const t = Math.max(0, Math.min(1, ((q[0] - a[0]) * dx + (q[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)));

    return Math.hypot(a[0] + dx * t - q[0], a[1] + dy * t - q[1]);
  };
  const distOrig = (q: Vec2) => Math.min(...orig.map(line => distSeg(q, line.a, line.b)));
  const poly = orig.map(line => line.a);
  const inside = (q: Vec2) => {
    let isInside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i];
      const [xj, yj] = poly[j];
      if (yi > q[1] !== yj > q[1] && q[0] < ((xj - xi) * (q[1] - yi)) / (yj - yi) + xi) {
        isInside = !isInside;
      }
    }

    return isInside;
  };
  // Where each offset piece crosses the others (and the original, which it must not run past).
  const cuts: number[][] = off.map(() => [0, 1]);
  const cross = (a: Vec2, b: Vec2, otherStart: Vec2, e: Vec2): [number, number] | null => {
    const along: Vec2 = [b[0] - a[0], b[1] - a[1]];
    const otherAlong: Vec2 = [e[0] - otherStart[0], e[1] - otherStart[1]];
    const den = along[0] * otherAlong[1] - along[1] * otherAlong[0];
    if (Math.abs(den) < 1e-15 * (Math.hypot(...along) * Math.hypot(...otherAlong) || 1)) {
      return null;
    }
    const t = ((otherStart[0] - a[0]) * otherAlong[1] - (otherStart[1] - a[1]) * otherAlong[0]) / den;
    const fraction = ((otherStart[0] - a[0]) * along[1] - (otherStart[1] - a[1]) * along[0]) / den;

    return t > 1e-12 && t < 1 - 1e-12 && fraction >= -1e-12 && fraction <= 1 + 1e-12 ? [t, fraction] : null;
  };
  for (let i = 0; i < off.length; i++) {
    for (let j = 0; j < off.length; j++) {
      if (i === j) {
        continue;
      }
      const x = cross(off[i].a, off[i].b, off[j].a, off[j].b);
      if (x) {
        cuts[i].push(x[0]);
      }
    }
    for (const line of orig) {
      const x = cross(off[i].a, off[i].b, line.a, line.b);
      if (x) {
        cuts[i].push(x[0]);
      }
    }
  }
  const at = (e: LineE, t: number): Vec2 => [e.a[0] + (e.b[0] - e.a[0]) * t, e.a[1] + (e.b[1] - e.a[1]) * t];
  // The parts that are far enough (and on the right side), each with its piece's index.
  const kept: { a: Vec2; b: Vec2; src: number }[] = [];
  off.forEach((e, i) => {
    const ts = [...new Set(cuts[i])].sort((x, y) => x - y);
    for (let index = 0; index + 1 < ts.length; index++) {
      const point = at(e, ts[index]);
      const q = at(e, ts[index + 1]);
      if (Math.hypot(q[0] - point[0], q[1] - point[1]) < eps * 10) {
        continue;
      }
      const mid = at(e, (ts[index] + ts[index + 1]) / 2);
      if (distOrig(mid) < distance * (1 - 1e-6)) {
        continue;
      }
      if (closed && inside(mid) !== grow < 0) {
        continue;
      }
      // A piece turned round (squeezed past nothing between its neighbours).
      const original = orig[i];
      if (original && (e.b[0] - e.a[0]) * (original.b[0] - original.a[0]) + (e.b[1] - e.a[1]) * (original.b[1] - original.a[1]) <= 0) {
        continue;
      }
      kept.push({ a: point, b: q, src: i });
    }
  });
  if (!kept.length) {
    return null;
  }
  // Nothing was cut away: as it was.
  if (kept.length === off.length && kept.every((piece, i) => piece.src === i)) {
    return off;
  }
  // Join the parts end to end again (in the offset's own direction), and merge
  // the parts of one piece that follow each other straight on.
  const tol = Math.max(eps * 1e3, distance * 1e-7);
  const same = (point: Vec2, q: Vec2) => Math.hypot(point[0] - q[0], point[1] - q[1]) < tol;
  const used = new Set<number>();
  const out: LineE[] = [];
  for (let start = 0; start < kept.length; start++) {
    if (used.has(start)) {
      continue;
    }
    const path: (typeof kept)[number][] = [];
    let cur = start;
    while (cur >= 0 && !used.has(cur)) {
      used.add(cur);
      const piece = kept[cur];
      const last = path[path.length - 1];
      if (last && last.src === piece.src && same(last.b, piece.a)) {
        last.b = piece.b;
      } else {
        path.push({ ...piece });
      }
      // Back at the start: the loop is closed (where offsets crossed, two
      // parts start at the same point - going on there lost the loop).
      if (path.length > 1 && same(kept[start].a, piece.b)) {
        break;
      }
      cur = kept.findIndex((candidate, j) => !used.has(j) && same(candidate.a, piece.b));
    }
    // A loop's first and last parts of the same piece: one line.
    if (path.length > 1 && path[0].src === path[path.length - 1].src && same(path[path.length - 1].b, path[0].a)) {
      path[0].a = path[path.length - 1].a;
      path.pop();
    }
    // Scraps that don't join into an outline (a closed offset is loops only).
    if (closed && !(path.length >= 2 && same(path[path.length - 1].b, path[0].a))) {
      continue;
    }
    for (const piece of path) {
      out.push({ ...off[piece.src], a: piece.a, b: piece.b });
    }
  }

  return out.length ? out : null;
}

// --------------------------------------------------------------- offset

/**
 * The offset distance to start with for a curve: a tenth of its size (a line's
 * length, an arc's, a circle's diameter, a box's smaller side), rounded - so it
 * shows on a sketch of any size (a fixed 2 mm was invisible on a 10 m one).
 */
export function defaultOffset(e: SketchEntity): number {
  let size = 0;
  switch (e.kind) {
    case 'line':
      size = Math.hypot(e.b[0] - e.a[0], e.b[1] - e.a[1]);
      break;
    case 'arc': {
      const arc = arcFrom3(e.a, e.m, e.b);
      size = arc ? arc.r * Math.abs(arc.sweep) : Math.hypot(e.b[0] - e.a[0], e.b[1] - e.a[1]);
      break;
    }
    case 'circle':
    case 'polygon':
      size = 2 * e.radius;
      break;
    case 'ellipse':
      size = 2 * Math.min(e.rx, e.ry);
      break;
    case 'rect':
      size = Math.min(e.w, e.h);
      break;
    case 'spline':
    case 'polyline': {
      const pts = e.kind === 'spline' ? samplePrim(entityPrims(e)[0], 0, 1) : e.points;
      for (let i = 1; i < pts.length; i++) {
        size += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
      }
      break;
    }
  }

  return size > 0 ? roundSig(size * 0.1) : 1;
}

/** Offset copy of an entity (outward for closed shapes, to the left for open ones). */
export function offsetEntity(e: SketchEntity, distance: number): SketchEntity | null {
  const base = { id: uid(), construction: e.construction };
  switch (e.kind) {
    case 'circle':
      return e.radius + distance > 0 ? { ...base, kind: 'circle', center: e.center, radius: e.radius + distance } : null;
    case 'ellipse':
      return e.rx + distance > 0 && e.ry + distance > 0 ? { ...base, kind: 'ellipse', center: e.center, rx: e.rx + distance, ry: e.ry + distance, rotation: e.rotation, ...(e.sweep === undefined ? {} : { a0: e.a0 ?? 0, sweep: e.sweep }) } : null;
    case 'rect':
      return e.w + 2 * distance > 0 && e.h + 2 * distance > 0 ? { ...base, kind: 'rect', center: e.center, w: e.w + 2 * distance, h: e.h + 2 * distance, rotation: e.rotation } : null;
    case 'polygon': {
      const radius = e.radius + distance / Math.cos(Math.PI / e.sides);

      return radius > 0 ? { ...base, kind: 'polygon', center: e.center, radius: radius, sides: e.sides, angle: e.angle } : null;
    }
    case 'line': {
      const dx = e.b[0] - e.a[0];
      const dy = e.b[1] - e.a[1];
      const length = Math.hypot(dx, dy) || 1;
      const nx = (-dy / length) * distance;
      const ny = (dx / length) * distance;

      return { ...base, kind: 'line', a: [e.a[0] + nx, e.a[1] + ny], b: [e.b[0] + nx, e.b[1] + ny] };
    }
    case 'arc': {
      const arc = arcFrom3(e.a, e.m, e.b);
      if (!arc) {
        return null;
      }
      const scale = (arc.r + distance) / arc.r;
      if (scale <= 0) {
        return null;
      }
      const xf = scaleXf(arc.c, scale);

      return { ...base, kind: 'arc', a: xf(e.a), m: xf(e.m), b: xf(e.b) };
    }
    case 'spline':
    case 'polyline': {
      const pts = e.kind === 'spline' ? samplePrim(entityPrims(e)[0], 0, 1) : e.points;
      const closed = e.closed;
      const sign = closed && signedArea(pts) < 0 ? -1 : 1;
      const out = pts.map((point, i) => {
        const prev = pts[i === 0 ? (closed ? pts.length - 2 : 0) : i - 1];
        const next = pts[i === pts.length - 1 ? (closed ? 1 : i) : i + 1];
        const tx = next[0] - prev[0];
        const ty = next[1] - prev[1];
        const length = Math.hypot(tx, ty) || 1;

        // Outward for CCW closed curves = to the right of travel.
        return [point[0] + (ty / length) * distance * sign * (closed ? 1 : -1), point[1] - (tx / length) * distance * sign * (closed ? 1 : -1)] as Vec2;
      });
      if (e.kind !== 'spline') {
        return { ...base, kind: 'polyline', points: out, closed };
      }
      // As few fit points as follow the curve closely (within a five-thousandth of its size): it was four per span of
      // the original, so the offset of a curve projected from an edge - 24 points, out of sight - came out a row of 97 dots.
      const xs = out.map(q => q[0]);
      const ys = out.map(q => q[1]);
      const size = Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));

      return { ...base, kind: 'spline', points: fitSpline(closed ? out.slice(0, -1) : out, closed, Math.max(size * 2e-4, 1e-9)), closed, mode: 'fit' };
    }
  }
}

function signedArea(points: Vec2[]): number {
  let a = 0;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    a += (points[j][0] + points[i][0]) * (points[j][1] - points[i][1]);
  }

  return -a / 2;
}

function thin(pts: Vec2[], count: number): Vec2[] {
  if (pts.length <= count) {
    return pts;
  }
  const step = (pts.length - 1) / (count - 1);

  return Array.from({ length: count }, (_, i) => pts[Math.round(i * step)]);
}

// --------------------------------------------------------------- fillet

/**
 * Round the corner nearest `at` where two lines meet. Rects/polygons are
 * turned into lines first. Returns null if no corner is near.
 */
export function filletCorner(entities: SketchEntity[], at: Vec2, radius: number, tol: number): SketchEntity[] | null {
  let list = entities.flatMap(e => (e.kind === 'rect' || e.kind === 'polygon' || e.kind === 'polyline' ? cornerNear(e, at, tol) ? explode(e) : [e] : [e]));
  const lines = list.filter((e): e is Extract<SketchEntity, { kind: 'line' }> => e.kind === 'line');
  const ends: { e: (typeof lines)[number]; end: 'a' | 'b' }[] = [];
  for (const e of lines) {
    for (const end of ['a', 'b'] as const) {
      if (Math.hypot(e[end][0] - at[0], e[end][1] - at[1]) < tol) {
        ends.push({ e, end });
      }
    }
  }
  if (ends.length < 2) {
    return roundCorner(list, at, radius, tol);
  }
  const [first, q] = ends;
  const corner = first.e[first.end];
  const farP = first.e[first.end === 'a' ? 'b' : 'a'];
  const farQ = q.e[q.end === 'a' ? 'b' : 'a'];
  const unitA = unit(sub2(farP, corner));
  const unitB = unit(sub2(farQ, corner));
  const cos = unitA[0] * unitB[0] + unitA[1] * unitB[1];
  const half = Math.acos(Math.max(-1, Math.min(1, cos))) / 2;
  if (half < 1e-3 || Math.PI / 2 - half < 1e-3) {
    return null;
  }
  const dist = radius / Math.tan(half);
  if (dist > Math.hypot(...sub2(farP, corner)) || dist > Math.hypot(...sub2(farQ, corner))) {
    return null;
  }
  const tp: Vec2 = [corner[0] + unitA[0] * dist, corner[1] + unitA[1] * dist];
  const tq: Vec2 = [corner[0] + unitB[0] * dist, corner[1] + unitB[1] * dist];
  const bis = unit([unitA[0] + unitB[0], unitA[1] + unitB[1]]);
  const cdist = radius / Math.sin(half);
  const center: Vec2 = [corner[0] + bis[0] * cdist, corner[1] + bis[1] * cdist];
  const mid: Vec2 = [center[0] - bis[0] * radius, center[1] - bis[1] * radius];
  list = list.map(e => (e === first.e ? { ...first.e, [first.end]: tp } : e === q.e ? { ...q.e, [q.end]: tq } : e));
  list.push({ id: uid(), kind: 'arc', a: tp, m: mid, b: tq, construction: first.e.construction });

  return list;
}

/**
 * Fillet where a line meets an arc, or two arcs meet: the rounding circle sits
 * at `radius` from both (offset carriers crossing), on the side where it
 * touches both curves on their own length, nearest the corner.
 */
function roundCorner(list: SketchEntity[], at: Vec2, radius: number, tol: number): SketchEntity[] | null {
  type End = { e: Extract<SketchEntity, { kind: 'line' | 'arc' }>; end: 'a' | 'b' };
  const ends: End[] = [];
  for (const e of list) {
    if (e.kind === 'line' || e.kind === 'arc') {
      for (const end of ['a', 'b'] as const) {
        if (Math.hypot(e[end][0] - at[0], e[end][1] - at[1]) < tol) {
          ends.push({ e, end });
        }
      }
    }
  }
  if (ends.length < 2 || ends[0].e === ends[1].e || !(radius > 0)) {
    return null;
  }
  const [first, second] = ends;
  const corner = first.e[first.end];
  const k1 = carrierOf(first.e);
  const k2 = carrierOf(second.e);
  if (!k1 || !k2) {
    return null;
  }
  const shifted = (carrier: Carrier): Carrier[] => {
    if (carrier.kind === 'line') {
      const length = Math.hypot(...carrier.d) || 1;
      const normal: Vec2 = [(-carrier.d[1] / length) * radius, (carrier.d[0] / length) * radius];

      return [{ kind: 'line', p: [carrier.p[0] + normal[0], carrier.p[1] + normal[1]], d: carrier.d }, { kind: 'line', p: [carrier.p[0] - normal[0], carrier.p[1] - normal[1]], d: carrier.d }];
    }

    return [{ kind: 'circle', c: carrier.c, r: carrier.r + radius }, ...(carrier.r - radius > 1e-12 ? [{ kind: 'circle' as const, c: carrier.c, r: carrier.r - radius }] : [])];
  };
  const touch = (carrier: Carrier, center: Vec2): Vec2 => (carrier.kind === 'line' ? projectOnLine(center, carrier.p, [carrier.p[0] + carrier.d[0], carrier.p[1] + carrier.d[1]]) : towards(carrier.c, center, carrier.r));
  // Where on the curve a point is, from the corner end (0) to the far end (1); outside → out of range.
  const along = (x: End, q: Vec2): number => {
    const e = x.e;
    if (e.kind === 'line') {
      const from = e[x.end];
      const to = x.end === 'a' ? e.b : e.a;
      const direction: Vec2 = [to[0] - from[0], to[1] - from[1]];

      return ((q[0] - from[0]) * direction[0] + (q[1] - from[1]) * direction[1]) / (direction[0] * direction[0] + direction[1] * direction[1] || 1);
    }
    const arc = arcFrom3(e.a, e.m, e.b)!;
    const ang = Math.atan2(q[1] - arc.c[1], q[0] - arc.c[0]);
    let fraction = (ang - arc.a0) / arc.sweep;
    const turn = (2 * Math.PI) / Math.abs(arc.sweep);
    while (fraction < -1e-9) {
      fraction += turn;
    }
    while (fraction > 1 + 1e-9 && fraction - turn >= -1e-9) {
      fraction -= turn;
    }

    return x.end === 'a' ? fraction : 1 - fraction;
  };
  /** Direction of travel along a curve at q: towards its corner end ("in") or away from it ("out"). */
  const dirAt = (x: End, q: Vec2, way: 'in' | 'out'): Vec2 => {
    const e = x.e;
    let direction: Vec2;
    if (e.kind === 'line') {
      direction = unit(x.end === 'b' ? [e.b[0] - e.a[0], e.b[1] - e.a[1]] : [e.a[0] - e.b[0], e.a[1] - e.b[1]]);
    } else {
      const arc = arcFrom3(e.a, e.m, e.b)!;
      const sign = Math.sign(arc.sweep) * (x.end === 'b' ? 1 : -1);
      direction = unit([-(q[1] - arc.c[1]) * sign, (q[0] - arc.c[0]) * sign]);
    }

    return way === 'in' ? direction : [-direction[0], -direction[1]];
  };
  let best: { c: Vec2; tp: Vec2; tq: Vec2; d: number } | null = null;
  for (const carrier of shifted(k1)) {
    for (const otherCarrier of shifted(k2)) {
      for (const carrierCrossing of carrierCrossings(carrier, otherCarrier)) {
        const tp = touch(k1, carrierCrossing);
        const tq = touch(k2, carrierCrossing);
        const fp = along(first, tp);
        const fq = along(second, tq);
        if (!(fp > 1e-9 && fp < 1 - 1e-9 && fq > 1e-9 && fq < 1 - 1e-9)) {
          continue;
        }
        // It must carry on smoothly: running along `first` into the corner, the
        // rounding takes over in the same direction and hands over to `second` the same way.
        const mid = towards(carrierCrossing, corner, radius);
        const filletArc = arcFrom3(tp, mid, tq);
        if (!filletArc || Math.abs(filletArc.sweep) >= Math.PI) {
          continue;
        }
        const spin = Math.sign(filletArc.sweep);
        const tan = (q: Vec2): Vec2 => unit([-(q[1] - carrierCrossing[1]) * spin, (q[0] - carrierCrossing[0]) * spin]);
        const inP = dirAt(first, tp, 'in');
        const outQ = dirAt(second, tq, 'out');
        const tp1 = tan(tp);
        const tq1 = tan(tq);
        if (inP[0] * tp1[0] + inP[1] * tp1[1] < 0.999 || outQ[0] * tq1[0] + outQ[1] * tq1[1] < 0.999) {
          continue;
        }
        const distance = Math.hypot(carrierCrossing[0] - corner[0], carrierCrossing[1] - corner[1]);
        if (!best || distance < best.d) {
          best = { c: carrierCrossing, tp, tq, d: distance };
        }
      }
    }
  }
  if (!best) {
    return null;
  }
  const { c, tp, tq } = best;
  // The rounding's middle: the point of its circle nearest the old corner.
  const mid = towards(c, corner, radius);
  const arc: SketchEntity = { id: uid(), kind: 'arc', a: tp, m: mid, b: tq, construction: first.e.construction };
  if (!arcFrom3(tp, mid, tq)) {
    return null;
  }

  return [...list.map(e => (e === first.e ? moveEnd(first.e, first.end, tp) : e === second.e ? moveEnd(second.e, second.end, tq) : e)), arc];
}

function cornerNear(e: Extract<SketchEntity, { kind: 'rect' | 'polygon' | 'polyline' }>, at: Vec2, tol: number): boolean {
  return entityCorners(e).some(entityCorner => Math.hypot(entityCorner[0] - at[0], entityCorner[1] - at[1]) < tol);
}

const sub2 = (a: Vec2, b: Vec2): Vec2 => [a[0] - b[0], a[1] - b[1]];
const unit = (a: Vec2): Vec2 => {
  const length = Math.hypot(a[0], a[1]) || 1;

  return [a[0] / length, a[1] / length];
};

// --------------------------------------------------- projection of edges

/**
 * A 3D polyline (e.g. a body edge) flattened onto the sketch plane, as the
 * simplest matching entity: line, circle, arc or spline.
 */
/**
 * (A curved edge that is no circle is a spline through 24 of its points: as
 * close to the edge as that gets. A curve that follows its edge keeps that -
 * only its two ends show (`pointsOf`). `lean`: a free copy, which is the
 * user's to shape - a whole ellipse as an ellipse, anything else with as few
 * points as hold it within a two-thousandth of its size, not a row of 24 dots
 * to drag one by one. And a round edge seen at a slant - part of a circle or
 * of an ellipse - is part of an ellipse, exactly, with its two ends: `conic`
 * false keeps the spline, for a curve of an older project made as one, which
 * may have sizes tied to its points.)
 */
export function projectPolyline(pts3: Vec3[], plane: PlaneDef, type: string, lean = false, conic = true): SketchEntity | null {
  const pts = dedupe(pts3.map(point => toPlane(plane, point)));
  if (pts.length < 2) {
    return null;
  }
  const a = pts[0];
  const b = pts[pts.length - 1];
  const closed = Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-6 * (1 + span(pts));
  if (type === 'LINE' || pts.length === 2) {
    return { id: uid(), kind: 'line', a, b };
  }
  if (type === 'CIRCLE') {
    const point = pts[Math.floor(pts.length / 2)];
    const q = pts[Math.floor(pts.length / 3)];
    const arc = arcFrom3(pts[0], q, point);
    if (arc) {
      // Only a true circle if the projection didn't squash it (plane parallel to the edge's circle).
      const ok = pts.every(sample => Math.abs(Math.hypot(sample[0] - arc.c[0], sample[1] - arc.c[1]) - arc.r) < arc.r * 1e-3);
      if (ok) {
        return closed ? { id: uid(), kind: 'circle', center: arc.c, radius: arc.r } : { id: uid(), kind: 'arc', a, m: point, b };
      }
    }
  }
  const run = closed ? pts.slice(0, -1) : pts;
  if (conic && !closed && (type === 'CIRCLE' || type === 'ELLIPSE') && run.length >= 7) {
    const xs = pts.map(point => point[0]);
    const ys = pts.map(point => point[1]);
    const size = Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
    const el = fitEllipse(run);
    // (Only when every point is on it: a short, nearly straight piece can be fitted by ellipses that are nothing like it.)
    if (el && run.every(point => offEllipse(point, el) < size * 1e-6) && Math.max(el.rx, el.ry) < size * 50) {
      const at = (point: Vec2) => {
        const dx = point[0] - el.c[0];
        const dy = point[1] - el.c[1];

        return Math.atan2((-dx * Math.sin(el.rot) + dy * Math.cos(el.rot)) / el.ry, (dx * Math.cos(el.rot) + dy * Math.sin(el.rot)) / el.rx);
      };
      // Which way round it goes: the way that passes its middle point.
      const turn = (from: number, to: number) => ((((to - from) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI));
      const a0 = at(a);
      const toMid = turn(a0, at(run[Math.floor(run.length / 2)]));
      const toEnd = turn(a0, at(b));
      const sweep = toMid <= toEnd ? toEnd : toEnd - 2 * Math.PI;
      if (Math.abs(sweep) > 1e-6) {
        return { id: uid(), kind: 'ellipse', center: el.c, rx: el.rx, ry: el.ry, rotation: el.rot, a0, sweep };
      }
    }
  }
  if (lean) {
    const xs = pts.map(point => point[0]);
    const ys = pts.map(point => point[1]);
    const size = Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
    // A circle seen at a slant, an ellipse: the ellipse itself.
    if (closed && run.length >= 6) {
      const el = fitEllipse(run);
      if (el && run.every(point => offEllipse(point, el) < size * 1e-5)) {
        return { id: uid(), kind: 'ellipse', center: el.c, rx: el.rx, ry: el.ry, rotation: el.rot };
      }
    }
    // Within a two-thousandth of its size of the edge (0.025 on a curve 50 long).
    const tol = Math.max(size * 5e-4, 1e-9);
    const ctrl = closed ? null : fitControl(run, tol);
    if (ctrl) {
      return { id: uid(), kind: 'spline', points: ctrl, closed: false, mode: 'control' };
    }

    return { id: uid(), kind: 'spline', points: fitSpline(run, closed, tol), closed, mode: 'fit' };
  }

  return { id: uid(), kind: 'spline', points: thin(run, 24), closed, mode: 'fit' };
}

/** A spline with only the points it needs (one that followed an edge and was unlinked: its 24 become the user's to shape). */
export function leanSpline<E extends SketchEntity>(e: E): E {
  if (e.kind !== 'spline' || e.mode !== 'fit' || e.points.length < 7) {
    return e;
  }
  const xs = e.points.map(point => point[0]);
  const ys = e.points.map(point => point[1]);
  const size = Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));

  return { ...e, points: fitSpline(e.points, e.closed, Math.max(size * 5e-4, 1e-9)) };
}

/** Solve `rows` (`count` rows of `count` + 1: the last column the right side) in place; null when it has no one answer. */
function solveRows(rows: number[][]): number[] | null {
  const count = rows.length;
  for (let i = 0; i < count; i++) {
    let best = i;
    for (let row = i + 1; row < count; row++) {
      if (Math.abs(rows[row][i]) > Math.abs(rows[best][i])) {
        best = row;
      }
    }
    if (Math.abs(rows[best][i]) < 1e-12) {
      return null;
    }
    [rows[i], rows[best]] = [rows[best], rows[i]];
    for (let row = 0; row < count; row++) {
      if (row === i) {
        continue;
      }
      const factor = rows[row][i] / rows[i][i];
      for (let j = i; j <= count; j++) {
        rows[row][j] -= factor * rows[i][j];
      }
    }
  }

  return rows.map((row, i) => row[count] / row[i]);
}

/**
 * The fewest control points of an open spline (the sketch's own kind: a
 * uniform cubic B-spline that starts and ends on its first and last point)
 * that keep it within `tol` of the points: its two ends where the curve's
 * are, the handles between fitted (least squares, each point's place along
 * the curve put right and fitted again). Null when even twelve don't hold it.
 */
function fitControl(run: Vec2[], tol: number): Vec2[] | null {
  const count = run.length;
  if (count < 4) {
    return null;
  }
  const first = run[0];
  const last = run[count - 1];
  // Where each point is along the curve, 0 to 1, by the way gone.
  const way = [0];
  for (let i = 1; i < count; i++) {
    way.push(way[i - 1] + Math.hypot(run[i][0] - run[i - 1][0], run[i][1] - run[i - 1][1]));
  }
  if (!(way[count - 1] > 0)) {
    return null;
  }
  const start = way.map(length => length / way[count - 1]);
  /** How much of each control point a place along the curve is made of (the mirrored ones past the ends folded in). */
  const weights = (controlCount: number, at: number): number[] => {
    const spans = controlCount - 1;
    const position = Math.min(spans - 1e-12, Math.max(0, at * spans));
    const span = Math.min(spans - 1, Math.floor(position));
    const fraction = position - span;
    const u2 = fraction * fraction;
    const u3 = u2 * fraction;
    const b = [(1 - 3 * fraction + 3 * u2 - u3) / 6, (4 - 6 * u2 + 3 * u3) / 6, (1 + 3 * fraction + 3 * u2 - 3 * u3) / 6, u3 / 6];
    const weights = new Array<number>(controlCount).fill(0);
    for (let j = 0; j < 4; j++) {
      const i = span - 1 + j;
      if (i < 0) {
        (weights[0] += 2 * b[j]), (weights[1] -= b[j]);
      } else if (i > controlCount - 1) {
        (weights[controlCount - 1] += 2 * b[j]), (weights[controlCount - 2] -= b[j]);
      } else {
        weights[i] += b[j];
      }
    }

    return weights;
  };
  const at = (controls: Vec2[], x: number): Vec2 => {
    const blend = weights(controls.length, x);

    return [blend.reduce((sum, weight, i) => sum + weight * controls[i][0], 0), blend.reduce((sum, weight, i) => sum + weight * controls[i][1], 0)];
  };
  for (let controlCount = 3; controlCount <= 12 && controlCount < count; controlCount++) {
    let ts = start.slice();
    let controls: Vec2[] | null = null;
    for (let round = 0; round < 4; round++) {
      // The handles (all but the two ends), least squares.
      const q = controlCount - 2;
      const mx = Array.from({ length: q }, () => new Array<number>(q + 1).fill(0));
      const my = Array.from({ length: q }, () => new Array<number>(q + 1).fill(0));
      for (let j = 0; j < count; j++) {
        const blend = weights(controlCount, ts[j]);
        const rx = run[j][0] - blend[0] * first[0] - blend[controlCount - 1] * last[0];
        const ry = run[j][1] - blend[0] * first[1] - blend[controlCount - 1] * last[1];
        for (let a = 0; a < q; a++) {
          for (let b = 0; b < q; b++) {
            mx[a][b] += blend[a + 1] * blend[b + 1];
            my[a][b] += blend[a + 1] * blend[b + 1];
          }
          mx[a][q] += blend[a + 1] * rx;
          my[a][q] += blend[a + 1] * ry;
        }
      }
      const xs = solveRows(mx);
      const ys = solveRows(my);
      if (!xs || !ys) {
        break;
      }
      controls = [first, ...xs.map((x, i): Vec2 => [x, ys[i]]), last];
      // Each point's place along this curve, put right: the nearest of a fine walk along it, near where it was.
      const fine = 24 * (controlCount - 1);
      const walk = Array.from({ length: fine + 1 }, (_, i) => at(controls!, i / fine));
      let worst = 0;
      const next = ts.slice();
      for (let j = 1; j < count - 1; j++) {
        const mid = Math.round(ts[j] * fine);
        let best = Infinity;
        let where = ts[j];
        for (let i = Math.max(1, mid - 24); i <= Math.min(fine, mid + 24); i++) {
          // (To the piece of the walk, not just its corners.)
          const a = walk[i - 1];
          const b = walk[i];
          const dx = b[0] - a[0];
          const dy = b[1] - a[1];
          const fraction = Math.max(0, Math.min(1, ((run[j][0] - a[0]) * dx + (run[j][1] - a[1]) * dy) / (dx * dx + dy * dy || 1)));
          const distance = Math.hypot(run[j][0] - a[0] - fraction * dx, run[j][1] - a[1] - fraction * dy);
          if (distance < best) {
            (best = distance), (where = (i - 1 + fraction) / fine);
          }
        }
        next[j] = where;
        worst = Math.max(worst, best);
      }
      if (worst <= tol) {
        return controls;
      }
      ts = next;
    }
  }

  return null;
}

/** The ellipse through these points (a conic fitted to them, least squares), or null when they are not on one. */
function fitEllipse(pts: Vec2[]): { c: Vec2; rx: number; ry: number; rot: number } | null {
  const count = pts.length;
  const mx = pts.reduce((sum, point) => sum + point[0], 0) / count;
  const my = pts.reduce((sum, point) => sum + point[1], 0) / count;
  const scale = Math.max(...pts.map(point => Math.hypot(point[0] - mx, point[1] - my))) || 1;
  // A x² + B xy + C y² + D x + E y = 1, about their middle and at their own size (so the numbers stay tame).
  const rows = Array.from({ length: 5 }, () => new Array<number>(6).fill(0));
  for (const point of pts) {
    const x = (point[0] - mx) / scale;
    const y = (point[1] - my) / scale;
    const row = [x * x, x * y, y * y, x, y];
    for (let i = 0; i < 5; i++) {
      for (let j = 0; j < 5; j++) {
        rows[i][j] += row[i] * row[j];
      }
      rows[i][5] += row[i];
    }
  }
  const sol = solveRows(rows);
  if (!sol) {
    return null;
  }
  const [coefA, coefB, coefC, coefD, coefE] = sol;
  const det = 4 * coefA * coefC - coefB * coefB;
  if (!(det > 1e-12)) {
    return null;
  }
  const cx = (coefB * coefE - 2 * coefC * coefD) / det;
  const cy = (coefB * coefD - 2 * coefA * coefE) / det;
  const residual = coefA * cx * cx + coefB * cx * cy + coefC * cy * cy + coefD * cx + coefE * cy - 1;
  const rot = 0.5 * Math.atan2(coefB, coefA - coefC);
  const cos = Math.cos(rot);
  const sin = Math.sin(rot);
  const along = coefA * cos * cos + coefB * cos * sin + coefC * sin * sin;
  const across = coefA * sin * sin - coefB * cos * sin + coefC * cos * cos;
  if (!(-residual / along > 0) || !(-residual / across > 0)) {
    return null;
  }

  return { c: [mx + cx * scale, my + cy * scale], rx: Math.sqrt(-residual / along) * scale, ry: Math.sqrt(-residual / across) * scale, rot };
}

/** About how far a point is from an ellipse (exact on it, near enough close by). */
function offEllipse(point: Vec2, el: { c: Vec2; rx: number; ry: number; rot: number }): number {
  const dx = point[0] - el.c[0];
  const dy = point[1] - el.c[1];
  const x = dx * Math.cos(el.rot) + dy * Math.sin(el.rot);
  const y = -dx * Math.sin(el.rot) + dy * Math.cos(el.rot);
  const radial = Math.hypot(x / el.rx, y / el.ry);

  return Math.abs(radial - 1) * Math.min(el.rx, el.ry);
}

function dedupe(pts: Vec2[]): Vec2[] {
  const out: Vec2[] = [];
  for (const point of pts) {
    const q = out[out.length - 1];
    if (!q || Math.hypot(point[0] - q[0], point[1] - q[1]) > 1e-9) {
      out.push(point);
    }
  }

  return out;
}

function span(pts: Vec2[]): number {
  let max = 0;
  for (const point of pts) {
    max = Math.max(max, Math.abs(point[0]), Math.abs(point[1]));
  }

  return max;
}

/**
 * After a fillet: the lines no longer meet at the old corner, so the
 * Coincident that joined them there would pull them back. Replace it with
 * Coincident + Tangent between each line and the new arc.
 */
export function filletConstraints(entities: SketchEntity[], constraints: SketchConstraint[], before: Set<string>): SketchConstraint[] {
  const arcs = entities.filter((e): e is Extract<SketchEntity, { kind: 'arc' }> => e.kind === 'arc' && !before.has(e.id));
  let cs = constraints;
  for (const arc of arcs) {
    const touching: { e: string; p: 'a' | 'b'; arcEnd: 'a' | 'b' }[] = [];
    for (const entity of entities) {
      if ((entity.kind === 'line' || entity.kind === 'arc') && entity.id !== arc.id) {
        for (const end of ['a', 'b'] as const) {
          for (const arcEnd of ['a', 'b'] as const) {
            if (Math.hypot(entity[end][0] - arc[arcEnd][0], entity[end][1] - arc[arcEnd][1]) < 1e-9) {
              touching.push({ e: entity.id, p: end, arcEnd });
            }
          }
        }
      }
    }
    if (touching.length < 2) {
      continue;
    }
    const ends = new Set(touching.map(t => `${t.e}:${t.p}`));
    // Drop constraints that tie these moved ends to each other.
    cs = cs.filter(sketchConstraint => !(sketchConstraint.type === 'coincident' && sketchConstraint.pts?.length === 2 && sketchConstraint.pts.every(q => ends.has(`${q.e}:${q.p}`))));
    for (const t of touching) {
      cs = [...cs, { id: uid(), type: 'coincident', pts: [{ e: t.e, p: t.p }, { e: arc.id, p: t.arcEnd }] }, { id: uid(), type: 'tangent', curves: [t.e, arc.id] }];
    }
    // The fillet keeps the radius it was made with (else it floats whenever
    // anything else changes, and a big change can fold the corner over).
    const roundArc = arcFrom3(arc.a, arc.m, arc.b);
    if (roundArc) {
      cs = [...cs, { id: uid(), type: 'dim', curves: [arc.id], prop: 'radius', value: roundArc.r }];
    }
  }

  return cs;
}

// ------------------------------------------------------------ align / join

type LineE = Extract<SketchEntity, { kind: 'line' }>;

const near2 = (point: Vec2, q: Vec2, tol: number) => Math.hypot(point[0] - q[0], point[1] - q[1]) < tol;

/** Where the infinite line point + t·direction meets the infinite line through a, b (null if parallel). */
function meetLines(point: Vec2, direction: Vec2, a: Vec2, b: Vec2): Vec2 | null {
  const e: Vec2 = [b[0] - a[0], b[1] - a[1]];
  const den = direction[0] * e[1] - direction[1] * e[0];
  if (Math.abs(den) < 1e-12 * Math.hypot(...direction) * Math.hypot(...e)) {
    return null;
  }
  const t = ((a[0] - point[0]) * e[1] - (a[1] - point[1]) * e[0]) / den;

  return [point[0] + direction[0] * t, point[1] + direction[1] * t];
}

function projectOnLine(point: Vec2, a: Vec2, b: Vec2): Vec2 {
  const direction: Vec2 = [b[0] - a[0], b[1] - a[1]];
  const l2 = direction[0] * direction[0] + direction[1] * direction[1] || 1;
  const t = ((point[0] - a[0]) * direction[0] + (point[1] - a[1]) * direction[1]) / l2;

  return [a[0] + direction[0] * t, a[1] + direction[1] * t];
}

/**
 * Align: line `id` moves onto the infinite line of `target` (it ends up lying
 * on it). Lines joined to its ends keep their direction and stretch to follow,
 * like the neighbouring faces of a replaced face.
 */
export function alignLine(entities: SketchEntity[], id: string, target: SketchEntity): SketchEntity[] | null {
  const ln = entities.find(e => e.id === id);
  if (ln?.kind !== 'line' || target.kind !== 'line' || target.id === id) {
    return null;
  }
  const [ta, tb] = [target.a, target.b];
  const size = Math.hypot(ln.b[0] - ln.a[0], ln.b[1] - ln.a[1]) + Math.hypot(tb[0] - ta[0], tb[1] - ta[1]);
  const tol = size * 1e-6 + 1e-9;
  const moved = new Map<string, LineE>();
  const ends: Record<'a' | 'b', Vec2> = { a: ln.a, b: ln.b };
  for (const endKey of ['a', 'b'] as const) {
    const point = ln[endKey];
    // A line joined here (not the target itself) slides its end along its own direction.
    const nb = entities.find((e): e is LineE => e.kind === 'line' && e.id !== id && e.id !== target.id && !e.construction && (near2(e.a, point, tol) || near2(e.b, point, tol)));
    let q: Vec2 | null = null;
    if (nb) {
      const end = near2(nb.a, point, tol) ? 'a' : 'b';
      const other = end === 'a' ? nb.b : nb.a;
      q = meetLines(other, [point[0] - other[0], point[1] - other[1]], ta, tb);
      if (q) {
        moved.set(nb.id, { ...(moved.get(nb.id) ?? nb), [end]: q });
      }
    }
    ends[endKey] = q ?? projectOnLine(point, ta, tb);
  }
  if (near2(ends.a, ends.b, tol)) {
    return null;
  }

  return entities.map(e => (e.id === id ? { ...ln, a: ends.a, b: ends.b } : moved.get(e.id) ?? e));
}

/**
 * Align, as the tool does it: line `id` moves onto `target`'s axis (lines
 * joined to it slide along), and only it - the target and the rest stay put
 * when the sketch's constraints are solved again. Constraints the move breaks
 * (an old angle, a size) go; joins stay.
 */
export function alignOne(entities: SketchEntity[], constraints: SketchConstraint[], id: string, target: LineE): { entities: SketchEntity[]; constraints: SketchConstraint[] } | null {
  const next = alignLine(entities, id, target);
  if (!next) {
    return null;
  }

  return settleMoved(next, constraints, new Set(next.filter((sketchEntity, i) => sketchEntity !== entities[i]).map(sketchEntity => sketchEntity.id)), target.id);
}

/**
 * Align a whole shape: turned (the short way) and slid so its `edge` lies on
 * `target`'s axis; it moves as one, nothing else does.
 */
export function alignShape(entities: SketchEntity[], constraints: SketchConstraint[], shape: Set<string>, edge: LineE, target: LineE): { entities: SketchEntity[]; constraints: SketchConstraint[] } | null {
  const de: Vec2 = [edge.b[0] - edge.a[0], edge.b[1] - edge.a[1]];
  const dt: Vec2 = [target.b[0] - target.a[0], target.b[1] - target.a[1]];
  const le = Math.hypot(...de);
  const lt = Math.hypot(...dt);
  if (le < 1e-12 || lt < 1e-12 || shape.has(target.id)) {
    return null;
  }
  let ang = Math.atan2(dt[1], dt[0]) - Math.atan2(de[1], de[0]);
  // The short way round: a line has no direction.
  while (ang > Math.PI / 2) {
    ang -= Math.PI;
  }
  while (ang <= -Math.PI / 2) {
    ang += Math.PI;
  }
  const mid: Vec2 = [(edge.a[0] + edge.b[0]) / 2, (edge.a[1] + edge.b[1]) / 2];
  const turn = rotateXf(mid, ang);
  const on = projectOnLine(mid, target.a, target.b);
  const xf: Xf = (point) => {
    const q = turn(point);

    return [q[0] + on[0] - mid[0], q[1] + on[1] - mid[1]];
  };
  const next = entities.map(e => (shape.has(e.id) ? transformEntity(e, xf) : e));

  return settleMoved(next, constraints, shape, target.id);
}

/**
 * After an align: keep the constraints still met (and joins, which the solve
 * restores), drop the rest, and solve with the target held still.
 */
function settleMoved(next: SketchEntity[], constraints: SketchConstraint[], moved: Set<string>, target: string): { entities: SketchEntity[]; constraints: SketchConstraint[] } {
  let size = 1;
  for (const e of next) {
    for (const q of pointsOf(e)) {
      size = Math.max(size, Math.abs(q.at[0]), Math.abs(q.at[1]));
    }
  }
  // What the move broke (a join to something that stayed, an old angle) would
  // pull it back: only the constraints still met stay.
  const kept = constraints.filter(constraint => !refsOf(constraint).some(ref => moved.has(ref)) || constraintError(next, [constraint]) < size * 1e-7);
  const solution = solve(next, kept, { fixed: new Set([target]) });
  if (solution.ok) {
    return { entities: solution.entities, constraints: kept };
  }
  // Couldn't settle: the constraints on what moved go (it stays where it was put).
  const rest = kept.filter(sketchConstraint => !refsOf(sketchConstraint).some(ref => moved.has(ref)));

  return { entities: next, constraints: rest };
}

/**
 * Join: line `id` and a line on the same axis that shares one of its ends
 * become a single line. Returns the new entities and the id that was merged away.
 */
export function joinCollinear(entities: SketchEntity[], id: string, prefer?: Vec2): { entities: SketchEntity[]; removed: string } | null {
  const ln = entities.find(e => e.id === id);
  if (ln?.kind !== 'line') {
    return null;
  }
  const len = Math.hypot(ln.b[0] - ln.a[0], ln.b[1] - ln.a[1]);
  const tol = len * 1e-6 + 1e-9;
  const direction: Vec2 = [(ln.b[0] - ln.a[0]) / len, (ln.b[1] - ln.a[1]) / len];
  const onAxis = (point: Vec2) => Math.abs((point[0] - ln.a[0]) * direction[1] - (point[1] - ln.a[1]) * direction[0]) < tol * 10;
  const cands = entities.filter(
    (e): e is LineE => e.kind === 'line' && e.id !== id && !!e.construction === !!ln.construction && onAxis(e.a) && onAxis(e.b) && [e.a, e.b].some(point => near2(point, ln.a, tol) || near2(point, ln.b, tol))
  );
  if (!cands.length) {
    return null;
  }
  // Two candidates (one at each end): the one on the side that was tapped.
  const along = (point: Vec2) => (point[0] - ln.a[0]) * direction[0] + (point[1] - ln.a[1]) * direction[1];
  const pick = prefer && cands.length > 1 ? cands.reduce((best, candidate) => (Math.abs(along(mid(best)) - along(prefer)) < Math.abs(along(mid(candidate)) - along(prefer)) ? best : candidate)) : cands[0];
  const pts = [ln.a, ln.b, pick.a, pick.b].sort((point, q) => along(point) - along(q));
  const joined: LineE = { ...ln, a: pts[0], b: pts[3] };

  return { entities: entities.filter(e => e.id !== pick.id).map(e => (e.id === id ? joined : e)), removed: pick.id };
}

function mid(line: LineE): Vec2 {
  return [(line.a[0] + line.b[0]) / 2, (line.a[1] + line.b[1]) / 2];
}

// ------------------------------------------------- constraints after edits

/**
 * Constraints after an edit changed curves (trim, extend, …): ones on points
 * that are still there follow them (to whichever piece now has that point),
 * ones on a curve that was cut go to the pieces of it, and any that no longer
 * hold are dropped - an old length would pull an extended line back, a join
 * to a trimmed-away end would drag it out again.
 */
export function carryConstraints(before: SketchEntity[], after: SketchEntity[], cs: SketchConstraint[]): SketchConstraint[] {
  const old = new Map(before.map(e => [e.id, e]));
  const now = new Map(after.map(e => [e.id, e]));
  let size = 1;
  for (const e of after) {
    for (const point of pointsOf(e)) {
      size = Math.max(size, Math.abs(point.at[0]), Math.abs(point.at[1]));
    }
  }
  const tol = size * 1e-7;
  const changed = after.filter(e => old.get(e.id) !== e);
  const same = (point: Vec2, q: Vec2) => Math.hypot(point[0] - q[0], point[1] - q[1]) < tol;
  /** Curves (new or changed) that lie on the old curve `id`: its pieces. */
  const piecesOf = (id: string): SketchEntity[] => {
    const original = old.get(id);
    if (!original) {
      return [];
    }
    const prims = entityPrims(original);

    return changed.filter((e) => {
      const firstEntityPrim = entityPrims(e)[0];
      if (!firstEntityPrim) {
        return false;
      }
      const mid = evalPrim(firstEntityPrim, 0.5);

      return prims.some(pr => closestOnPrim(pr, mid).d < tol * 10);
    });
  };
  const out: SketchConstraint[] = [];
  for (const sketchConstraint of cs) {
    // A copy that follows its original (an offset, a mirror image), one of the two cut or reshaped here: it is its
    // own curve from now on - held to being the copy, a trimmed offset would be pulled back to its whole length.
    if (sketchConstraint.type === 'follow' && (sketchConstraint.curves ?? []).some(id => old.get(id) !== now.get(id))) {
      continue;
    }
    let ok = true;
    const pts = sketchConstraint.pts?.map((point) => {
      const was = old.get(point.e);
      const q = was && pointOf(was, point.p);
      const e = now.get(point.e);
      const at = e && pointOf(e, point.p);
      if (at && q && same(at, q)) {
        return point;
      }
      if (!q) {
        return point;
      }
      // That point now belongs to a piece of the curve.
      for (const piece of [...(e ? [e] : []), ...piecesOf(point.e)]) {
        for (const eachPoint of pointsOf(piece)) {
          if (same(eachPoint.at, q)) {
            return { e: piece.id, p: eachPoint.p };
          }
        }
      }
      ok = false;

      return point;
    });
    const curves = sketchConstraint.curves?.map((id) => {
      if (now.has(id)) {
        return id;
      }
      const ps = piecesOf(id);
      if (!ps.length) {
        ok = false;
      }

      return ps[0]?.id ?? id;
    });
    if (!ok) {
      continue;
    }
    const next: SketchConstraint = { ...sketchConstraint, ...(pts ? { pts } : {}), ...(curves ? { curves } : {}) };
    if (!refsOf(next).every(id => now.has(id))) {
      continue;
    }
    // Two refs that became the very same point hold nothing.
    if (next.pts?.length === 2 && next.pts[0].e === next.pts[1].e && next.pts[0].p === next.pts[1].p) {
      continue;
    }
    // Only what still holds stays.
    if (constraintError(after, [next]) > tol * 10) {
      continue;
    }
    out.push(next);
  }

  return out;
}

// ------------------------------------------------------ more shapes

/**
 * Arc by its centre: from `start` round to the direction of `toward`, the
 * short way - or anticlockwise (angles typed: 90° to 270° is the left half,
 * where the short way can't tell a half circle's sides apart).
 */
export function centreArc(id: string, center: Vec2, start: Vec2, toward: Vec2, anticlockwise = false): SketchEntity | null {
  const radius = Math.hypot(start[0] - center[0], start[1] - center[1]);
  if (radius < 1e-9) {
    return null;
  }
  const t0 = Math.atan2(start[1] - center[1], start[0] - center[0]);
  let sw = Math.atan2(toward[1] - center[1], toward[0] - center[0]) - t0;
  if (anticlockwise) {
    while (sw <= 1e-9) {
      sw += 2 * Math.PI;
    }
    while (sw > 2 * Math.PI) {
      sw -= 2 * Math.PI;
    }
  }
  while (!anticlockwise && sw > Math.PI) {
    sw -= 2 * Math.PI;
  }
  while (!anticlockwise && sw < -Math.PI) {
    sw += 2 * Math.PI;
  }
  if (Math.abs(sw) < 1e-6) {
    return null;
  }
  const at = (t: number): Vec2 => [center[0] + radius * Math.cos(t), center[1] + radius * Math.sin(t)];

  return { id, kind: 'arc', a: start, m: at(t0 + sw / 2), b: at(t0 + sw) };
}

/**
 * Chamfer the corner nearest `at` where two lines meet: both are cut back by
 * `dist` and a straight line joins the cuts. Null if a line is too short.
 */
export function chamferCorner(entities: SketchEntity[], at: Vec2, dist: number, tol: number): SketchEntity[] | null {
  const list = entities.flatMap(e => (e.kind === 'rect' || e.kind === 'polygon' || e.kind === 'polyline' ? (cornerNear(e, at, tol) ? explode(e) : [e]) : [e]));
  const ends: { e: LineE; end: 'a' | 'b' }[] = [];
  for (const e of list) {
    if (e.kind === 'line') {
      for (const end of ['a', 'b'] as const) {
        if (Math.hypot(e[end][0] - at[0], e[end][1] - at[1]) < tol) {
          ends.push({ e, end });
        }
      }
    }
  }
  if (ends.length < 2 || !(dist > 0)) {
    return null;
  }
  const [first, q] = ends;
  const corner = first.e[first.end];
  const cut = (x: { e: LineE; end: 'a' | 'b' }): Vec2 | null => {
    const far = x.e[x.end === 'a' ? 'b' : 'a'];
    const length = Math.hypot(far[0] - corner[0], far[1] - corner[1]);
    if (dist >= length - 1e-9) {
      return null;
    }

    return [corner[0] + ((far[0] - corner[0]) / length) * dist, corner[1] + ((far[1] - corner[1]) / length) * dist];
  };
  const tp = cut(first);
  const tq = cut(q);
  if (!tp || !tq) {
    return null;
  }
  // Lines that carry straight on (no corner): nothing to cut.
  const unitA = unit(sub2(first.e[first.end === 'a' ? 'b' : 'a'], corner));
  const unitB = unit(sub2(q.e[q.end === 'a' ? 'b' : 'a'], corner));
  if (Math.abs(unitA[0] * unitB[1] - unitA[1] * unitB[0]) < 1e-6) {
    return null;
  }
  const chamfer: SketchEntity = { id: uid(), kind: 'line', a: tp, b: tq, construction: first.e.construction };

  return [...list.map(e => (e === first.e ? { ...first.e, [first.end]: tp } : e === q.e ? { ...q.e, [q.end]: tq } : e)), chamfer];
}

/** Two lines picked by their halves: extended/trimmed to meet, then that corner chamfered. */
export function chamferEnds(entities: SketchEntity[], first: { id: string; at: Vec2 }, second: { id: string; at: Vec2 }, dist: number): SketchEntity[] | null {
  const e1 = entities.find(entity => entity.id === first.id);
  const e2 = entities.find(entity => entity.id === second.id);
  if (e1?.kind !== 'line' || e2?.kind !== 'line' || e1.id === e2.id) {
    return null;
  }
  const joined = joinEnds(entities, first, second);
  if (!joined) {
    return null;
  }
  const end = endNear(e1, first.at)!;
  const corner = (joined.find(sketchEntity => sketchEntity.id === e1.id) as LineE)[end];
  const size = Math.max(Math.hypot(e1.b[0] - e1.a[0], e1.b[1] - e1.a[1]), Math.hypot(e2.b[0] - e2.a[0], e2.b[1] - e2.a[1]), 1);

  return chamferCorner(joined, corner, dist, size * 1e-7);
}

/** After a chamfer: the cut line is joined to both lines (the old corner's join goes). */
export function chamferConstraints(entities: SketchEntity[], constraints: SketchConstraint[], before: Set<string>): SketchConstraint[] {
  let cs = constraints;
  for (const entity of entities) {
    if (entity.kind !== 'line' || before.has(entity.id)) {
      continue;
    }
    const touching: { e: string; p: 'a' | 'b'; mine: 'a' | 'b' }[] = [];
    for (const sketchEntity of entities) {
      if (sketchEntity.kind === 'line' && sketchEntity.id !== entity.id) {
        for (const end of ['a', 'b'] as const) {
          for (const mine of ['a', 'b'] as const) {
            if (near2(sketchEntity[end], entity[mine], 1e-9)) {
              touching.push({ e: sketchEntity.id, p: end, mine });
            }
          }
        }
      }
    }
    if (touching.length < 2) {
      continue;
    }
    const ends = new Set(touching.map(t => `${t.e}:${t.p}`));
    cs = cs.filter(sketchConstraint => !(sketchConstraint.type === 'coincident' && sketchConstraint.pts?.length === 2 && sketchConstraint.pts.every(q => ends.has(`${q.e}:${q.p}`))));
    for (const t of touching) {
      cs = [...cs, { id: uid(), type: 'coincident', pts: [{ e: t.e, p: t.p }, { e: entity.id, p: t.mine }] }];
    }
  }

  return cs;
}

/** Where the (infinite) lines of two line curves meet. */
export function lineMeet(first: LineE, q: LineE): Vec2 | null {
  return meetLines(first.a, [first.b[0] - first.a[0], first.b[1] - first.a[1]], q.a, q.b);
}

/**
 * The curves of a sketch's linked offsets of its face outline (see
 * SketchFeature.outlineOffsets), made from the outline as it is now. Each
 * offsets the loop of the outline nearest where it was tapped.
 */
export function outlineOffsetCurves(boundary: SketchEntity[], links: OutlineOffset[] | undefined): SketchEntity[] {
  const out: SketchEntity[] = [];
  for (const outlineOffset of links ?? []) {
    let seed: SketchEntity | null = null;
    let best = Infinity;
    for (const e of boundary) {
      for (const entityPrim of entityPrims(e)) {
        const distance = closestOnPrim(entityPrim, outlineOffset.at).d;
        if (distance < best) {
          [best, seed] = [distance, e];
        }
      }
    }
    if (!seed) {
      continue;
    }
    let made: SketchEntity[] = [];
    if (!outlineOffset.single && (seed.kind === 'line' || seed.kind === 'arc' || (seed.kind === 'spline' && !seed.closed))) {
      made = offsetChain(boundary, seed.id, outlineOffset.distance)?.slice(boundary.length) ?? [];
    } else {
      const one = offsetEntity(seed, outlineOffset.distance);
      if (one) {
        made = [one];
      }
    }
    made.forEach((e, index) => out.push({ ...e, id: `lnk-${outlineOffset.id}-${index}` }));
  }

  return out;
}

/**
 * A sketch's shapes onto another plane, square to it: each outline (and hole)
 * of the regions, a run of one curve at a time (a whole circle stays a circle,
 * one squashed by the slant becomes a spline).
 */
export function projectRegions(arr: Arrangement, regions: Region[], from: PlaneDef, to: PlaneDef): SketchEntity[] {
  const kind = (prim: number) => ({ line: 'LINE', circle: 'CIRCLE' })[arr.prims[prim].t as 'line' | 'circle'] ?? 'SPLINE';
  const out: SketchEntity[] = [];
  const seen = new Set<number>();
  for (const region of regions) {
    for (const loop of [region.outer, ...region.holes]) {
    // Runs of pieces of one curve, the run started where the curve changes.
      const ps = loop.pieces;
      let start = ps.findIndex((loopRef, i) => arr.pieces[loopRef.piece].prim !== arr.pieces[ps[(i + ps.length - 1) % ps.length].piece].prim);
      if (start < 0) {
        start = 0;
      }
      let run: { prim: number; pts: Vec2[]; pieces: number[] } | null = null;
      const flush = () => {
      // A piece two regions share (a line between them) is drawn once.
        if (run && !run.pieces.every(piece => seen.has(piece))) {
          run.pieces.forEach(piece => seen.add(piece));
          const e = projectPolyline(run.pts.map(q => toWorld(from, q)), to, kind(run.prim));
          if (e) {
            out.push(e);
          }
        }
        run = null;
      };
      for (let i = 0; i < ps.length; i++) {
        const ref = ps[(start + i) % ps.length];
        const pc = arr.pieces[ref.piece];
        const poly = ref.reversed ? pc.poly.slice().reverse() : pc.poly;
        if (run && (run as { prim: number }).prim === pc.prim && kind(pc.prim) !== 'LINE') {
          (run as { pts: Vec2[] }).pts.push(...poly.slice(1));
          (run as { pieces: number[] }).pieces.push(ref.piece);
        } else {
          flush();
          run = { prim: pc.prim, pts: poly.slice(), pieces: [ref.piece] };
        }
      }
      flush();
    }
  }

  return out;
}
