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
    this.slots = ['First point', 'Second point'].map((l, i) => pointSlot(app, l, () => this.pts[i], p => ((this.pts[i] = p), this.sync())));
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
      planeSlot(app, 'First plane', () => this.a, p => ((this.a = p), this.sync())),
      planeSlot(app, 'Second plane', () => this.b, p => ((this.b = p), this.sync()))
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
  const d = cross(n1, n2);
  if (len(d) < 1e-6) {
    return null;
  }
  const dir = norm(d);
  // A point on both: x = q + s n1 + t n2, with n1·x = n1·a.origin and n2·x = n2·b.origin, q the middle.
  const q = scale(add(a.origin, b.origin), 0.5);
  const r1 = dot(n1, sub(a.origin, q));
  const r2 = dot(n2, sub(b.origin, q));
  const c = dot(n1, n2);
  const det = 1 - c * c;
  const s = (r1 - c * r2) / det;
  const t = (r2 - c * r1) / det;

  return { origin: add(q, add(scale(n1, s), scale(n2, t))), dir };
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
  const g = b?.faceGroups.find(x => x.face === face);
  if (!b || !info || !g || g.count < 3 || !['CONE', 'CYLINDRE', 'REVOLUTION_SURFACE', 'TORUS', 'SPHERE'].includes(info.type)) {
    return null;
  }
  const at = (A: ArrayLike<number>, i: number): Vec3 => [A[3 * i], A[3 * i + 1], A[3 * i + 2]];
  const idx = [...new Set(Array.from(b.indices.subarray(g.start, g.start + g.count)))];
  const ns = idx.map(i => norm(at(b.normals, i)));
  const ps = idx.map(i => at(b.positions, i));
  // The axis: the way the normals don't spread (their spread's least direction).
  const m = scale(ns.reduce(add, [0, 0, 0] as Vec3), 1 / ns.length);
  const C = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (const n of ns) {
    const v = sub(n, m);
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) {
        C[r * 3 + c] += v[r] * v[c];
      }
    }
  }
  const tr = C[0] + C[4] + C[8];
  if (tr < 1e-6 * ns.length) {
    return null;
  } // all the normals one way: a sliver, nothing to go by
  // Power steps on (tr·I − C): its biggest is C's least.
  let d: Vec3 = norm(cross(ns[0], ns[ns.length >> 1]));
  if (len(d) < 0.5) {
    d = [0.577, 0.577, 0.577];
  }
  for (let k = 0; k < 60; k++) {
    const nd: Vec3 = [0, 1, 2].map(r => tr * d[r] - (C[r * 3] * d[0] + C[r * 3 + 1] * d[1] + C[r * 3 + 2] * d[2])) as Vec3;
    if (len(nd) < 1e-12) {
      return null;
    }
    d = norm(nd);
  }
  // The point on the axis: nearest every normal line, across the axis.
  const A = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  const rhs: Vec3 = [0, 0, 0];
  for (let i = 0; i < ns.length; i++) {
    const u0 = sub(ns[i], scale(d, dot(ns[i], d)));
    if (len(u0) < 1e-6) {
      continue;
    }
    const u = norm(u0);
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) {
        const M = (r === c ? 1 : 0) - u[r] * u[c] - d[r] * d[c];
        A[r * 3 + c] += M;
        rhs[r] += M * ps[i][c];
      }
    }
  }
  // (Along the axis it is free: held at the face's middle.)
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      A[r * 3 + c] += d[r] * d[c] * ns.length;
    }
  }
  for (let r = 0; r < 3; r++) {
    rhs[r] += d[r] * dot(d, info.center) * ns.length;
  }
  const o = solve3(A, rhs);

  return o && { origin: o, dir: d };
}

function solve3(A: number[], b: Vec3): Vec3 | null {
  const det = (m: number[]) => m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);
  const D = det(A);
  if (Math.abs(D) < 1e-12) {
    return null;
  }
  const col = (k: number) => A.map((v, i) => (i % 3 === k ? b[Math.floor(i / 3)] : v));

  return [det(col(0)) / D, det(col(1)) / D, det(col(2)) / D];
}
