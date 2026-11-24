// More ways to make a construction plane. Each one does what its name says:
//   Through 3 Points               – three corners / points of the model.
//   On Curve at Point              – across a curve (normal = the curve's direction there).
//   Perpendicular to Edge at Point – same, on a body edge, at the point you pick on it.
//   Through Edge at Angle          – contains a straight edge, turned about it from a face.
//   Parallel to Face at Point      – a face's direction, moved to a point.
// The plane is worked out from the picks and kept (it can be redone from History).

import { Vector3 } from 'three';
import { add, cross, dot, len, norm, scale, sub, xDirFor } from '../geom';
import { entityWorldPolylines } from '../sketch/curves';
import { FeatureOp, type Slot } from './featureOp';
import { planeSlot, pointSlot } from './slots';
import type { PickHit } from '../view/viewport';
import type { PanelItem } from '../ui/ui';
import type { PlaneDef, PlaneFeature, PlaneKind, Vec3 } from '../doc/types';
import type { AppContext, Sel } from './tool';

/** A curve picked at a point: the point on it and its direction there. */
interface CurvePick {
  at: Vec3;
  tangent: Vec3;
  /** Straight (a line / straight edge): its two ends. */
  line?: [Vec3, Vec3];
  sel: Sel;
}

function nearestOnPolyline(pts: Vec3[], q: Vec3): { at: Vec3; tangent: Vec3 } | null {
  let best: { at: Vec3; tangent: Vec3; d: number } | null = null;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const ab = sub(b, a);
    const L2 = dot(ab, ab);
    if (L2 < 1e-18) {
      continue;
    }
    const t = Math.max(0, Math.min(1, dot(sub(q, a), ab) / L2));
    const foot = add(a, scale(ab, t));
    const distance = len(sub(q, foot));
    if (!best || distance < best.d) {
      best = { at: foot, tangent: norm(ab), d: distance };
    }
  }

  return best && { at: best.at, tangent: best.tangent };
}

/** A body edge or a sketch curve under a tap, as a curve picked at that point. */
function curvePick(app: AppContext, hit: PickHit): CurvePick | null {
  if (hit.kind === 'face') {
    // A tap just beside an edge lands on the face: take the edge it was meant for.
    const b = app.view.body(hit.body);
    if (!b) {
      return null;
    }
    let best: { edge: number; at: Vec3; d: number } | null = null;
    for (const edgeGroup of b.edgeGroups) {
      const pts: Vec3[] = [];
      for (let i = edgeGroup.start; i < edgeGroup.start + edgeGroup.count; i++) {
        pts.push([b.edgePositions[i * 3], b.edgePositions[i * 3 + 1], b.edgePositions[i * 3 + 2]]);
      }
      const near = nearestOnPolyline(pts, hit.point);
      if (!near) {
        continue;
      }
      const distance = len(sub(near.at, hit.point));
      if (!best || distance < best.d) {
        best = { edge: edgeGroup.edge, at: near.at, d: distance };
      }
    }
    if (!best) {
      return null;
    }
    const a = app.view.toScreen(new Vector3(...best.at));
    const q = app.view.toScreen(new Vector3(...hit.point));
    if (!a || !q || Math.hypot(a[0] - q[0], a[1] - q[1]) > 28) {
      return null;
    }

    return curvePick(app, { kind: 'edge', body: hit.body, edge: best.edge, point: hit.point });
  }
  if (hit.kind === 'edge') {
    const b = app.view.body(hit.body);
    const edgeGroup = b?.edgeGroups.find(edgeGroup => edgeGroup.edge === hit.edge);
    const info = b?.edges[hit.edge];
    if (!b || !edgeGroup || !info) {
      return null;
    }
    const pts: Vec3[] = [];
    for (let i = edgeGroup.start; i < edgeGroup.start + edgeGroup.count; i++) {
      pts.push([b.edgePositions[i * 3], b.edgePositions[i * 3 + 1], b.edgePositions[i * 3 + 2]]);
    }
    const near = nearestOnPolyline(pts, hit.point);
    if (!near) {
      return null;
    }
    // Straight when the middle lies on the line between the ends.
    const straight = len(sub(info.start, info.end)) > 1e-9 && Math.abs(len(sub(info.start, info.end)) - info.length) < info.length * 1e-4;

    return { ...near, line: straight ? [info.start, info.end] : undefined, sel: { kind: 'edge', body: hit.body, edge: hit.edge } };
  }
  if (hit.kind === 'curve') {
    const plane = app.sketchPlane(hit.sketch);
    const e = app.sketchCurves(hit.sketch).find(sketchCurve => sketchCurve.id === hit.entity);
    if (!plane || !e) {
      return null;
    }
    // (Where the curve is in space: a spline with points off its plane is picked up there, and the plane put on it
    // is square to it there - it was put on the curve's shadow, off the curve and askew to it.)
    for (const pts of entityWorldPolylines(e, plane)) {
      const near = nearestOnPolyline(pts, hit.point);
      if (near) {
        return { ...near, line: e.kind === 'line' ? [pts[0], pts[pts.length - 1]] : undefined, sel: { kind: 'curve', sketch: hit.sketch, entity: hit.entity } };
      }
    }
  }

  return null;
}

function curveSlot(app: AppContext, label: string, get: () => CurvePick | null, set: (c: CurvePick) => void, straightOnly = false): Slot {
  return {
    label,
    describe: () => (get() ? (get()!.line ? 'Straight edge' : 'Curve') : straightOnly ? 'Tap a straight edge or line' : 'Tap an edge or curve where the plane goes'),
    filled: () => !!get(),
    pick: { profiles: false, curves: true, planes: false, edges: true, vertices: false },
    rejectHint: straightOnly ? 'Tap a straight edge or sketch line' : 'Tap an edge or a sketch curve',
    shows: () => (get() ? [get()!.sel] : []),
    accept(hit) {
      const curve = curvePick(app, hit);
      if (!curve || (straightOnly && !curve.line)) {
        return false;
      }
      set(curve);

      return true;
    }
  };
}

const placeholder = (): PlaneDef => ({ origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, 0, 1] });

abstract class PlaneFromPicks extends FeatureOp<PlaneFeature> {
  readonly id = 'plane';
  constructor(app: AppContext, label: string, kind: PlaneKind) {
    super(app, { ...app.store.newIdentity('plane', label), type: 'plane', kind, plane: placeholder(), offset: 0 });
  }
  /** The plane the picks make (null: not yet / they don't make one). */
  protected abstract make(): PlaneDef | null;
  protected sync(): void {
    const plane = this.make();
    if (plane) {
      this.feature.plane = plane;
    }
  }
  protected ready(): boolean {
    return super.ready() && !!this.make();
  }
  protected items(): PanelItem[] {
    return [];
  }
}

export class ThreePointPlaneOp extends PlaneFromPicks {
  private pts: (Vec3 | null)[] = [null, null, null];
  constructor(app: AppContext) {
    super(app, 'Plane 3 Points', '3pt');
    this.slots = ['First point', 'Second point', 'Third point'].map((label, i) => pointSlot(app, label, () => this.pts[i], point => ((this.pts[i] = point), this.sync())));
  }
  protected make(): PlaneDef | null {
    const [a, b, pointC] = this.pts;
    if (!a || !b || !pointC) {
      return null;
    }
    const normal = cross(sub(b, a), sub(pointC, a));
    if (len(normal) < 1e-9 * Math.max(1, len(sub(b, a)) * len(sub(pointC, a)))) {
      return null;
    }

    return { origin: a, normal: norm(normal), xDir: norm(sub(b, a)) };
  }
  protected hint(): string {
    return this.pts.every(Boolean) && !this.make() ? '⚠ The three points are on one line - pick another' : 'Tap three points (corners, points on edges or in sketches): the plane goes through all three.';
  }
}

/** On Curve at Point / Perpendicular to Edge at Point: across the curve where it's picked. */
export class CurvePointPlaneOp extends PlaneFromPicks {
  private curve: CurvePick | null = null;
  constructor(app: AppContext, private edgesOnly: boolean) {
    super(app, edgesOnly ? 'Plane Perp. to Edge' : 'Plane on Curve', edgesOnly ? 'perp' : 'curve');
    this.slots = [curveSlot(app, edgesOnly ? 'Edge (tap where the plane goes)' : 'Curve (tap where the plane goes)', () => this.curve, curvePick => ((this.curve = curvePick), this.sync()))];
    this.finishWhenPicked = true;
  }
  protected make(): PlaneDef | null {
    return this.curve && { origin: this.curve.at, normal: this.curve.tangent, xDir: xDirFor(this.curve.tangent) };
  }
  protected hint(): string {
    return this.edgesOnly ? 'Tap an edge where the plane should cross it, square to it.' : 'Tap a line or edge where the plane should cross it, square to it.';
  }
}

/** Through a straight edge, turned about it from a face or plane by an angle. */
export class EdgeAnglePlaneOp extends PlaneFromPicks {
  private curve: CurvePick | null = null;
  private ref: PlaneDef | null = null;
  private angle = 45;
  /** `edge`: the straight edge picked before (Plane – Through Edge on an edge). */
  constructor(app: AppContext, edge?: { body: string; edge: number; point: Vec3 }) {
    super(app, 'Plane at Angle', 'angle');
    this.slots = [
      curveSlot(app, 'Edge (the plane turns about it)', () => this.curve, curvePick => ((this.curve = curvePick), this.sync()), true),
      planeSlot(app, 'From face or plane (0°)', () => this.ref, plane => ((this.ref = plane), this.sync()))
    ];
    if (edge) {
      const curve = curvePick(app, { kind: 'edge', ...edge });
      if (curve?.line) {
        (this.curve = curve), this.sync();
      }
    }
  }
  protected make(): PlaneDef | null {
    if (!this.curve?.line) {
      return null;
    }
    const [a, b] = this.curve.line;
    const direction = norm(sub(b, a));
    // 0°: the reference's direction (a face the edge lies on); without one, upright-ish.
    let n0 = this.ref ? this.ref.normal : xDirFor(direction);
    n0 = sub(n0, scale(direction, dot(n0, direction)));
    if (len(n0) < 1e-9) {
      return null;
    } // edge across the reference: no turning about it
    n0 = norm(n0);
    const t = (this.angle * Math.PI) / 180;
    const normal = norm(add(scale(n0, Math.cos(t)), scale(cross(direction, n0), Math.sin(t))));

    // Centred on the edge (that's where it's drawn).
    return { origin: scale(add(a, b), 0.5), normal: normal, xDir: direction };
  }
  protected items(): PanelItem[] {
    return [{ type: 'number', label: 'Angle', value: this.angle, kind: 'angle', onInput: angle => ((this.angle = angle), this.sync(), this.update()) }];
  }
  protected hint(): string {
    return 'Tap a straight edge, then the face to measure the angle from, then type the angle.';
  }
}

/** A face's (or plane's) direction, moved to a point. */
export class FacePointPlaneOp extends PlaneFromPicks {
  private ref: PlaneDef | null = null;
  private at: Vec3 | null = null;
  constructor(app: AppContext) {
    super(app, 'Plane Parallel', 'parallel');
    this.slots = [planeSlot(app, 'Parallel to', () => this.ref, plane => ((this.ref = plane), this.sync())), pointSlot(app, 'Through point', () => this.at, plane => ((this.at = plane), this.sync()))];
    this.finishWhenPicked = true;
  }
  protected make(): PlaneDef | null {
    return this.ref && this.at ? { ...this.ref, origin: this.at } : null;
  }
  protected hint(): string {
    return 'Tap a face or plane to copy its direction, then the point the new plane goes through.';
  }
}
