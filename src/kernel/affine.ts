import { cast, getOC } from 'replicad';
import { add, cross, dot, len, norm, scale, sub } from '../geom';
import type { Affine } from './types';
import type { Vec3 } from '../doc/types';
import type { Shape3D } from 'replicad';

export const AFFINE_ID: Affine = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];
export const applyAffine = (affine: Affine, point: Vec3): Vec3 => [0, 1, 2].map(row => affine[row * 4] * point[0] + affine[row * 4 + 1] * point[1] + affine[row * 4 + 2] * point[2] + affine[row * 4 + 3]) as Vec3;
/** The map that undoes `affine` (null: it squashes something flat, and has none). */
export function affineInverse(affine: Affine): Affine | null {
  const [a, b, m02, , m10, e, m12, , m20, m21, i] = affine;
  const det = a * (e * i - m12 * m21) - b * (m10 * i - m12 * m20) + m02 * (m10 * m21 - e * m20);
  if (!(Math.abs(det) > 1e-12)) {
    return null;
  }
  const rotation = [(e * i - m12 * m21) / det, (m02 * m21 - b * i) / det, (b * m12 - m02 * e) / det, (m12 * m20 - m10 * i) / det, (a * i - m02 * m20) / det, (m02 * m10 - a * m12) / det, (m10 * m21 - e * m20) / det, (b * m20 - a * m21) / det, (a * e - b * m10) / det];
  const t = [affine[3], affine[7], affine[11]];

  return [0, 1, 2].flatMap(row => [rotation[row * 3], rotation[row * 3 + 1], rotation[row * 3 + 2], -(rotation[row * 3] * t[0] + rotation[row * 3 + 1] * t[1] + rotation[row * 3 + 2] * t[2])]);
}
export const affineDet = (affine: Affine): number => affine[0] * (affine[5] * affine[10] - affine[6] * affine[9]) - affine[1] * (affine[4] * affine[10] - affine[6] * affine[8]) + affine[2] * (affine[4] * affine[9] - affine[5] * affine[8]);
/** A move, turn, mirroring or even scaling (not a stretch): the only maps a shape is put through as it is. */
export function affineIsSimilar(affine: Affine): boolean {
  const cols = [0, 1, 2].map(column => [affine[column], affine[4 + column], affine[8 + column]] as Vec3);
  const length = len(cols[0]);
  if (!(length > 1e-9)) {
    return false;
  }

  return cols.every(column => Math.abs(len(column) - length) < 1e-9 * length) && Math.abs(dot(cols[0], cols[1])) < 1e-9 * length * length && Math.abs(dot(cols[0], cols[2])) < 1e-9 * length * length && Math.abs(dot(cols[1], cols[2])) < 1e-9 * length * length;
}
/** A shape put through a move, turn, mirroring or even scaling: a new shape, the one given left as it is. */
export function shapeThrough(shape: Shape3D, affine: Affine): Shape3D {
  const oc = getOC();
  const t = new oc.gp_Trsf();
  t.SetValues(affine[0], affine[1], affine[2], affine[3], affine[4], affine[5], affine[6], affine[7], affine[8], affine[9], affine[10], affine[11]);
  const mk = new oc.BRepBuilderAPI_Transform(shape.wrapped, t, true, false);
  try {
    return cast(mk.Shape()) as Shape3D;
  } finally {
    mk.delete();
    t.delete();
  }
}

/** First `affine`, then `after`. */
export function affineThen(affine: Affine, after: Affine): Affine {
  const out: number[] = [];
  for (let row = 0; row < 3; row++) {
    for (let column = 0; column < 3; column++) {
      out.push(after[row * 4] * affine[column] + after[row * 4 + 1] * affine[4 + column] + after[row * 4 + 2] * affine[8 + column]);
    }
    out.push(after[row * 4] * affine[3] + after[row * 4 + 1] * affine[7] + after[row * 4 + 2] * affine[11] + after[row * 4 + 3]);
  }

  return out;
}
export const scaleAbout = (center: Vec3, factors: Vec3): Affine => [factors[0], 0, 0, center[0] * (1 - factors[0]), 0, factors[1], 0, center[1] * (1 - factors[1]), 0, 0, factors[2], center[2] * (1 - factors[2])];

/** The affine map that a point map `map` is (it must be one). */
export function affineFrom(map: (p: Vec3) => Vec3): Affine {
  const origin = map([0, 0, 0]);
  const cols = [[1, 0, 0], [0, 1, 0], [0, 0, 1]].map(e => sub(map(e as Vec3), origin));

  return [0, 1, 2].flatMap(row => [cols[0][row], cols[1][row], cols[2][row], origin[row]]);
}

/** Rotate `point` about the axis through `origin` along a (degrees). */
export function rotateAbout(point: Vec3, origin: Vec3, a: Vec3, deg: number): Vec3 {
  const unitAxis = norm(a);
  const offset = sub(point, origin);
  const t = (deg * Math.PI) / 180;
  const cos = Math.cos(t);
  const sin = Math.sin(t);
  // Rodrigues' rotation formula.
  const rotated = add(add(scale(offset, cos), scale(cross(unitAxis, offset), sin)), scale(unitAxis, dot(unitAxis, offset) * (1 - cos)));

  return add(origin, rotated);
}
