// More ways to make a construction axis, each from what it says:
//   Point to Point          – through two points of the model.
//   Intersection of 2 Planes – where two planes or flat faces cross.
// (Square to a face, along an edge and the middle of a cylinder or cone are
// one tap each: started from the wheel with the pick, see app.ts.)
// The axis is worked out from the picks and kept, like the planes.

import { add, cross, dot, len, norm, scale, sub } from '../geom';
import { FeatureOp } from './featureOp';
import { roundAxis } from './select';
import { planeSlot, pointSlot } from './slots';
import type { PanelItem } from '../ui/ui';
import type { AxisFeature, AxisKind, PlaneDef, Vec3 } from '../doc/types';
import type { AppContext } from './tool';

abstract class AxisFromPicks extends FeatureOp<AxisFeature> {
  readonly id = 'axis';
  constructor(app: AppContext, label: string, kind: AxisKind) {
    super(app, { ...app.store.newIdentity('axis', label), type: 'axis', origin: [0, 0, 0], dir: [0, 0, 1], kind });
  }
  /** The axis the picks make (null: not yet / they don't make one). */
  protected abstract make(): { origin: Vec3; dir: Vec3 } | null;
  protected sync(): void {
    const a = this.make();
    if (a) {
      (this.feature.origin = a.origin), (this.feature.dir = a.dir);
    }
  }
  protected ready(): boolean {
    return super.ready() && !!this.make();
  }
  protected items(): PanelItem[] {
    return [];
  }
}

export class TwoPointAxisOp extends AxisFromPicks {
  private pts: (Vec3 | null)[] = [null, null];
  constructor(app: AppContext) {
    super(app, 'Axis Point to Point', '2pt');
    this.slots = ['First point', 'Second point'].map((label, i) => pointSlot(app, label, () => this.pts[i], point => ((this.pts[i] = point), this.sync())));
    this.finishWhenPicked = true;
  }
  protected make(): { origin: Vec3; dir: Vec3 } | null {
    const [a, b] = this.pts;
    if (!a || !b || len(sub(b, a)) < 1e-9) {
      return null;
    }

    return { origin: a, dir: norm(sub(b, a)) };
  }
  protected hint(): string {
    const [a, b] = this.pts;

    return a && b && !this.make() ? '⚠ The two points are the same - pick another' : 'Tap two points (corners, points on edges or in sketches): the axis goes through both.';
  }
}

export class PlanesAxisOp extends AxisFromPicks {
  private a: PlaneDef | null = null;
  private b: PlaneDef | null = null;
  constructor(app: AppContext) {
    super(app, 'Axis 2 Planes', 'planes');
    this.slots = [
      planeSlot(app, 'First plane', () => this.a, plane => ((this.a = plane), this.sync())),
      planeSlot(app, 'Second plane', () => this.b, plane => ((this.b = plane), this.sync()))
    ];
    this.finishWhenPicked = true;
  }
  protected make(): { origin: Vec3; dir: Vec3 } | null {
    return this.a && this.b ? planesMeet(this.a, this.b) : null;
  }
  protected hint(): string {
    return this.a && this.b && !this.make() ? '⚠ The two planes are parallel - they never cross. Pick another' : 'Tap two planes or flat faces: the axis goes where they cross.';
  }
}

/** Where two planes cross: the line, through the point of it nearest the middle of their origins. */
export function planesMeet(a: PlaneDef, b: PlaneDef): { origin: Vec3; dir: Vec3 } | null {
  const n1 = norm(a.normal);
  const n2 = norm(b.normal);
  const direction = cross(n1, n2);
  if (len(direction) < 1e-6) {
    return null;
  }
  const dir = norm(direction);
  // A point on both: x = q + s n1 + t n2, with n1·x = n1·a.origin and n2·x = n2·b.origin, q the middle.
  const q = scale(add(a.origin, b.origin), 0.5);
  const r1 = dot(n1, sub(a.origin, q));
  const r2 = dot(n2, sub(b.origin, q));
  const cosine = dot(n1, n2);
  const det = 1 - cosine * cosine;
  const factor = (r1 - cosine * r2) / det;
  const t = (r2 - cosine * r1) / det;

  return { origin: add(q, add(scale(n1, factor), scale(n2, t))), dir };
}

/**
 * The middle line of a round face - a cylinder (or a hole), a cone (a
 * countersink, a taper) - from its mesh: every normal on it is at the same
 * angle to the axis, and every normal line goes through the axis.
 */
export function surfaceAxis(app: AppContext, body: string, face: number): { origin: Vec3; dir: Vec3 } | null {
  const round = roundAxis(app, body, face);
  if (round) {
    return round;
  }
  const b = app.view.body(body);
  const info = b?.faces[face];
  const faceGroup = b?.faceGroups.find(faceGroup => faceGroup.face === face);
  if (!b || !info || !faceGroup || faceGroup.count < 3 || !['CONE', 'CYLINDRE', 'REVOLUTION_SURFACE', 'TORUS', 'SPHERE'].includes(info.type)) {
    return null;
  }
  const at = (values: ArrayLike<number>, i: number): Vec3 => [values[3 * i], values[3 * i + 1], values[3 * i + 2]];
  const idx = [...new Set(Array.from(b.indices.subarray(faceGroup.start, faceGroup.start + faceGroup.count)))];
  const ns = idx.map(i => norm(at(b.normals, i)));
  const ps = idx.map(i => at(b.positions, i));
  // The axis: the way the normals don't spread (their spread's least direction).
  const mean = scale(ns.reduce(add, [0, 0, 0] as Vec3), 1 / ns.length);
  const covariance = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (const normal of ns) {
    const offset = sub(normal, mean);
    for (let row = 0; row < 3; row++) {
      for (let column = 0; column < 3; column++) {
        covariance[row * 3 + column] += offset[row] * offset[column];
      }
    }
  }
  const tr = covariance[0] + covariance[4] + covariance[8];
  if (tr < 1e-6 * ns.length) {
    return null;
  } // all the normals one way: a sliver, nothing to go by
  // Power steps on (tr·I − covariance): its biggest is the covariance's least.
  let direction: Vec3 = norm(cross(ns[0], ns[ns.length >> 1]));
  if (len(direction) < 0.5) {
    direction = [0.577, 0.577, 0.577];
  }
  for (let iteration = 0; iteration < 60; iteration++) {
    const nd: Vec3 = [0, 1, 2].map(row => tr * direction[row] - (covariance[row * 3] * direction[0] + covariance[row * 3 + 1] * direction[1] + covariance[row * 3 + 2] * direction[2])) as Vec3;
    if (len(nd) < 1e-12) {
      return null;
    }
    direction = norm(nd);
  }
  // The point on the axis: nearest every normal line, across the axis.
  const system = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  const rhs: Vec3 = [0, 0, 0];
  for (let i = 0; i < ns.length; i++) {
    const u0 = sub(ns[i], scale(direction, dot(ns[i], direction)));
    if (len(u0) < 1e-6) {
      continue;
    }
    const unitU = norm(u0);
    for (let row = 0; row < 3; row++) {
      for (let column = 0; column < 3; column++) {
        const projector = (row === column ? 1 : 0) - unitU[row] * unitU[column] - direction[row] * direction[column];
        system[row * 3 + column] += projector;
        rhs[row] += projector * ps[i][column];
      }
    }
  }
  // (Along the axis it is free: held at the face's middle.)
  for (let row = 0; row < 3; row++) {
    for (let column = 0; column < 3; column++) {
      system[row * 3 + column] += direction[row] * direction[column] * ns.length;
    }
  }
  for (let rhIndex = 0; rhIndex < 3; rhIndex++) {
    rhs[rhIndex] += direction[rhIndex] * dot(direction, info.center) * ns.length;
  }
  const solution = solve3(system, rhs);

  return solution && { origin: solution, dir: direction };
}

function solve3(matrix: number[], b: Vec3): Vec3 | null {
  const det = (cells: number[]) => cells[0] * (cells[4] * cells[8] - cells[5] * cells[7]) - cells[1] * (cells[3] * cells[8] - cells[5] * cells[6]) + cells[2] * (cells[3] * cells[7] - cells[4] * cells[6]);
  const determinant = det(matrix);
  if (Math.abs(determinant) < 1e-12) {
    return null;
  }
  const col = (column: number) => matrix.map((value, i) => (i % 3 === column ? b[Math.floor(i / 3)] : value));

  return [det(col(0)) / determinant, det(col(1)) / determinant, det(col(2)) / determinant];
}
