// Screw sizes for the Hole tool: what a hole for each metric screw measures, so nobody has to look it up.
//
// - `clearance`: the hole the screw passes through freely (ISO 273, medium fit).
// - `bore`, `boreDepth`: the recess that sinks a socket head cap screw's head (ISO 4762) flush - a little wider and
//   deeper than the head (DIN 974-1).
// - `sink`: the mouth of the 90° cone a countersunk screw's head (ISO 10642) sits in, a little wider than the head.
//
// They are where a hole starts: every number can be typed over (a printer that makes holes tight wants a few tenths more).
//
// Where they are from (2026-11): the through holes and the counterbores of M3, M5 and M6 were checked against a
// published chart; the other rows are those tables as remembered, not checked against the standards themselves (one
// chart gives 8.5 for M4's counterbore where this has 8). The countersink widths are the head of the common
// countersunk screw plus about a twentieth.

import { add, cross, dot, len, norm, scale, sub, xDirFor } from '../geom';
import type { HoleFeature, Vec3 } from './types';

export interface ScrewSize {
  name: string;
  /** The screw's own diameter. */
  d: number;
  clearance: number;
  bore: number;
  boreDepth: number;
  sink: number;
}

export const SCREW_SIZES: ScrewSize[] = [
  { name: 'M2', d: 2, clearance: 2.4, bore: 4.4, boreDepth: 2.3, sink: 4.4 },
  { name: 'M2.5', d: 2.5, clearance: 2.9, bore: 5.5, boreDepth: 2.9, sink: 5.5 },
  { name: 'M3', d: 3, clearance: 3.4, bore: 6.5, boreDepth: 3.4, sink: 6.5 },
  { name: 'M4', d: 4, clearance: 4.5, bore: 8, boreDepth: 4.4, sink: 8.6 },
  { name: 'M5', d: 5, clearance: 5.5, bore: 10, boreDepth: 5.4, sink: 10.6 },
  { name: 'M6', d: 6, clearance: 6.6, bore: 11, boreDepth: 6.4, sink: 12.8 },
  { name: 'M8', d: 8, clearance: 9, bore: 15, boreDepth: 8.6, sink: 17 },
  { name: 'M10', d: 10, clearance: 11, bore: 18, boreDepth: 10.6, sink: 21 },
  { name: 'M12', d: 12, clearance: 13.5, bore: 20, boreDepth: 12.6, sink: 25 }
];

export const screwSize = (name: string | undefined): ScrewSize | undefined => SCREW_SIZES.find(screwSize => screwSize.name === name);

/** The sizes a hole for this screw has, with this head. */
export function holeFor(size: ScrewSize, head: HoleFeature['head']): Pick<HoleFeature, 'size' | 'diameter' | 'headDiameter' | 'headDepth'> {
  return {
    size: size.name,
    diameter: size.clearance,
    headDiameter: head === 'countersink' ? size.sink : size.bore,
    headDepth: size.boreDepth
  };
}

/** A head recess for a hole of any diameter (no screw size chosen): in the proportions of the table. */
export function headFor(diameter: number, head: HoleFeature['head']): { headDiameter: number; headDepth: number } {
  const round = (value: number) => Math.round(value * 10) / 10;

  return { headDiameter: round(diameter * (head === 'countersink' ? 1.95 : 1.9)), headDepth: round(diameter) };
}

/** A countersink's cone: 90° across, so as deep as it is wider (on the radius) than the hole. */
export const sinkDepth = (hole: Pick<HoleFeature, 'diameter' | 'headDiameter'>): number => Math.max(0, (hole.headDiameter - hole.diameter) / 2);

// ------------------------------------------------------------ held from two edges

export interface HoleLine {
  a: Vec3;
  b: Vec3;
  /** How far from the line (see sideOf for which side is positive). */
  d: number;
}

/**
 * The direction square to a straight edge, in the face's plane, that distances from it are measured in: towards the
 * face's middle - or, with the middle on the edge's own line, towards `at`.
 */
export function sideOf(line: { a: Vec3; b: Vec3 }, middle: Vec3, at: Vec3, normal: Vec3): Vec3 | null {
  const t = sub(line.b, line.a);
  const size = len(t);
  if (size < 1e-9) {
    return null;
  }
  const tangent = norm(cross(normal, t));
  const toMiddle = dot(sub(middle, line.a), tangent);
  const side = Math.abs(toMiddle) > 1e-6 * Math.max(1, size) ? toMiddle : dot(sub(at, line.a), tangent);

  return side < 0 ? scale(tangent, -1) : tangent;
}

/** How far `point` is from a straight edge, measured as its hole's distance is. */
export function distanceFrom(line: { a: Vec3; b: Vec3 }, point: Vec3, middle: Vec3, normal: Vec3): number | null {
  const side = sideOf(line, middle, point, normal);

  return side ? dot(sub(point, line.a), side) : null;
}

/** The point of the face's plane (through `at`, facing `normal`) that is `d` from each of two straight edges; null: they run the same way. */
export function holeFromLines(at: Vec3, middle: Vec3, normal: Vec3, l1: HoleLine, l2: HoleLine): Vec3 | null {
  const m1 = sideOf(l1, middle, at, normal);
  const m2 = sideOf(l2, middle, at, normal);
  if (!m1 || !m2) {
    return null;
  }
  const xAxis = norm(xDirFor(normal));
  const yAxis = norm(cross(normal, xAxis));
  // at + x xAxis + y yAxis, with (that - a) . tangent = d for both.
  const a11 = dot(m1, xAxis), a12 = dot(m1, yAxis), a21 = dot(m2, xAxis), a22 = dot(m2, yAxis);
  const det = a11 * a22 - a12 * a21;
  if (Math.abs(det) < 0.05) {
    return null;
  }
  const c1 = l1.d - dot(sub(at, l1.a), m1);
  const c2 = l2.d - dot(sub(at, l2.a), m2);
  const x = (c1 * a22 - c2 * a12) / det;
  const y = (a11 * c2 - a21 * c1) / det;

  return add(add(at, scale(xAxis, x)), scale(yAxis, y));
}
