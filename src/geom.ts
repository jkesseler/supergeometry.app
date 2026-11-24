// Small vector / plane helpers shared by the UI and the kernel worker.

import type { PlaneDef, Vec2, Vec3 } from './doc/types';

export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: Vec3, factor: number): Vec3 => [a[0] * factor, a[1] * factor, a[2] * factor];
export const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0]
];
export const len = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
export const norm = (a: Vec3): Vec3 => {
  const length = len(a) || 1;

  return [a[0] / length, a[1] / length, a[2] / length];
};
export const dist = (a: Vec3, b: Vec3): number => len(sub(a, b));

export const GROUND: PlaneDef = { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, 0, 1] };
export const FRONT: PlaneDef = { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, -1, 0] };
export const RIGHT: PlaneDef = { origin: [0, 0, 0], xDir: [0, 1, 0], normal: [1, 0, 0] };

export function planeY(plane: PlaneDef): Vec3 {
  return cross(plane.normal, plane.xDir);
}

export function toWorld(plane: PlaneDef, uv: Vec2): Vec3 {
  const y = planeY(plane);

  return add(plane.origin, add(scale(plane.xDir, uv[0]), scale(y, uv[1])));
}

export function toPlane(plane: PlaneDef, worldPoint: Vec3): Vec2 {
  const delta = sub(worldPoint, plane.origin);

  return [dot(delta, plane.xDir), dot(delta, planeY(plane))];
}

/** Pick a stable in-plane x direction for a face normal (world X if possible). */
export function xDirFor(normal: Vec3): Vec3 {
  const ref: Vec3 = Math.abs(normal[2]) > 0.9 ? [1, 0, 0] : [0, 0, 1];
  // Project ref onto the plane; for vertical faces this gives a horizontal x axis.
  const x = Math.abs(normal[2]) > 0.9 ? ref : cross(ref, normal);
  const proj = sub(x, scale(normal, dot(x, normal)));

  return norm(proj);
}


/** Round to a "nice" step (0.1, 0.5, 1, 5, 10, …) close to `raw`. */
/**
 * The same plane with its origin where the model's origin falls on it: a
 * sketch on a face then measures X / Y from the model's origin (a face's own
 * centre moves as things are added to it - the pole typed at 0, 0 on a base
 * with letters and buttons landed at -0.9, 1.2).
 */
export function originOnPlane(plane: PlaneDef): PlaneDef {
  const normal = plane.normal;
  const offset = (plane.origin[0] * normal[0] + plane.origin[1] * normal[1] + plane.origin[2] * normal[2]) / (normal[0] * normal[0] + normal[1] * normal[1] + normal[2] * normal[2]);

  return { ...plane, origin: [normal[0] * offset, normal[1] * offset, normal[2] * offset] };
}

/** A default size: `value` rounded to two significant figures (217.4 -> 220, 0.0347 -> 0.035). */
export function roundSig(value: number, sig = 2): number {
  if (!Number.isFinite(value) || value === 0) {
    return value;
  }
  const step = Math.pow(10, Math.floor(Math.log10(Math.abs(value))) - sig + 1);

  return Math.round(value / step) * step;
}

/**
 * A linear pattern's spacing to start with: the copy clear of the original
 * (its size along the pattern plus a fifth), not a fixed 10 / 20 that piled
 * copies on top of a big part. `fallback` when there's no size to go by.
 */
export function patternSpacing(extent: number, fallback = 10): number {
  return extent > 1e-9 ? roundSig(extent * 1.2) : fallback;
}

export function niceStep(raw: number): number {
  const power = Math.pow(10, Math.floor(Math.log10(raw)));
  const mantissa = raw / power;

  return (mantissa < 2 ? 1 : mantissa < 7 ? 5 : 10) * power;
}
