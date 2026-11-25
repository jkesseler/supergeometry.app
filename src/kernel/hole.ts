// The shape a Hole step cuts away: the screw's shaft and, at the mouth, the recess for its head - one outline
// turned once round the hole's axis.

import { makeFace, makePolygon, revolution, type Edge, type Face, type Shape3D } from 'replicad';
import { sinkDepth } from '../doc/holeSizes';
import { add, cross, dot, len, norm, scale, sub, xDirFor } from '../geom';
import { areaProperties } from './ocFree';
import type { HoleFeature, Vec3 } from '../doc/types';

/** What is wrong with a hole's sizes, in words - or null. `depth`: how deep it goes (a through hole: all the way). */
export function holeFault(f: HoleFeature, depth: number): string | null {
  if (!(f.diameter > 0)) {
    return "The hole's diameter must be more than 0";
  }
  if (!(depth > 0)) {
    return "The hole's depth must be more than 0";
  }
  if (f.head === 'none') {
    return null;
  }
  if (!(f.headDiameter > f.diameter)) {
    return "The head's recess must be wider than the hole";
  }
  const deep = f.head === 'counterbore' ? f.headDepth : sinkDepth(f);
  if (f.head === 'counterbore' && !(deep > 0)) {
    return "The head's recess must be more than 0 deep";
  }
  if (!f.through && !(depth > deep)) {
    return 'The hole must go deeper than the recess for the head';
  }

  return null;
}

/**
 * The cutter: from `over` above the face at `at`, `depth` into it along `into` (pointing into the body).
 * (A hair above the face so that the cut's mouth comes out clean.)
 */
export function holeCutter(f: HoleFeature, at: Vec3, into: Vec3, depth: number, over: number): Shape3D {
  const u = norm(xDirFor(into));
  const R = f.diameter / 2;
  const Rh = f.headDiameter / 2;
  // The outline, as (out from the axis, into the body).
  const pts: [number, number][] = [[0, -over]];
  if (f.head === 'counterbore') {
    pts.push([Rh, -over], [Rh, f.headDepth], [R, f.headDepth]);
  } else if (f.head === 'countersink') {
    pts.push([Rh, -over], [Rh, 0], [R, sinkDepth(f)]);
  } else {
    pts.push([R, -over]);
  }
  pts.push([R, depth], [0, depth]);
  const outline = makePolygon(pts.map(([r, z]) => add(add(at, scale(u, r)), scale(into, z))));

  return revolution(outline, at, into, 360) as Shape3D;
}

/** The centre of a round edge (a whole circle or an arc of one); null for an edge that is not round. */
export function roundCentre(e: Edge): Vec3 | null {
  if (e.geomType !== 'CIRCLE') {
    return null;
  }
  const [a, b, c] = [0, 0.3, 0.6].map(t => e.pointAt(t).toTuple() as Vec3);
  // The point as far from all three, in their plane.
  const ab = sub(b, a);
  const ac = sub(c, a);
  const n = cross(ab, ac);
  const n2 = dot(n, n);
  if (n2 < 1e-18) {
    return null;
  }
  const to = add(scale(cross(n, ab), dot(ac, ac)), scale(cross(ac, n), dot(ab, ab)));

  return add(a, scale(to, 1 / (2 * n2)));
}

/** The middle of a flat face's outline: where it balances with its holes filled in (other holes do not move it). */
export function faceMiddle(face: Face): Vec3 {
  try {
    const whole = makeFace(face.outerWire());
    const c = areaProperties(whole).center;
    if (c.every(Number.isFinite) && len(c) < 1e9) {
      return c;
    }
  } catch {
    // As it is, below.
  }

  return areaProperties(face).center;
}
