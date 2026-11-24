// Move/rotate gimbal: three axis arrows, three plane squares, three rotation
// arcs and a centre ball. Drawn at constant screen size; hit-tested on screen.

import { BoxGeometry, BufferGeometry, ConeGeometry, DoubleSide, Group, Mesh, MeshBasicMaterial, PlaneGeometry, SphereGeometry, Vector3 } from 'three';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import type { Vec3 } from '../doc/types';
import type { ToolPointer } from '../view/input';
import type { Viewport } from '../view/viewport';

export type GimbalPart = { kind: 'axis' | 'plane' | 'ring'; i: 0 | 1 | 2 } | { kind: 'center' };

const AXES: Vec3[] = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1]
];
const COLORS = [0xe0584f, 0x5fbf5a, 0x4f8ce0];
const SIZE_PX = 85;
const ARC_FROM = 0.25;
const ARC_TO = 1.32;

/** Points of the rotation arc around axis i, in unit gimbal space. */
function arcPoints(axes: Vec3[], i: number, count = 24): Vector3[] {
  const vector = new Vector3(...axes[(i + 1) % 3]);
  const vAxis = new Vector3(...axes[(i + 2) % 3]);

  return Array.from({ length: count + 1 }, (_, step) => {
    const t = ARC_FROM + ((ARC_TO - ARC_FROM) * step) / count;

    return vector.clone().multiplyScalar(Math.cos(t) * 1.1).addScaledVector(vAxis, Math.sin(t) * 1.1);
  });
}

export interface GimbalOptions {
  /** The three axes (default world X, Y, Z). For a sketch: plane x, plane y, normal. */
  axes?: Vec3[];
  /** Which parts exist (e.g. a sketch gimbal has no out-of-plane arrow). */
  parts?: (p: GimbalPart) => boolean;
  /** Cube ends instead of arrow heads: the scale gimbal. */
  cubes?: boolean;
}

/** Scale gimbal: the three axis handles (cube ends) and the centre (uniform). */
export const SCALE_PARTS = (gimbalPart: GimbalPart) => gimbalPart.kind === 'axis' || gimbalPart.kind === 'center';

/** Parts of a gimbal that keep things in a plane whose normal is axis 2. */
export const IN_PLANE = (gimbalPart: GimbalPart) => gimbalPart.kind === 'center' || (gimbalPart.kind === 'axis' && gimbalPart.i < 2) || (gimbalPart.kind !== 'axis' && gimbalPart.i === 2);

export class Gimbal {
  private group = new Group();
  private center = new Vector3();
  private parts: { part: GimbalPart; obj: Group | Mesh | LineSegments2; color: number }[] = [];
  private hook = () => this.layout();
  private hot: GimbalPart | null = null;
  readonly axes: Vec3[];
  private allow: (p: GimbalPart) => boolean;

  constructor(
    private view: Viewport,
    opts: GimbalOptions = {}
  ) {
    this.axes = opts.axes ?? AXES;
    this.allow = opts.parts ?? (() => true);
    const AX = this.axes;
    AX.forEach((a, i) => {
      const dir = new Vector3(...a);
      const color = COLORS[i];
      // Axis arrow
      const arrow = new Group();
      const shaft = new LineSegments2(new LineSegmentsGeometry().setPositions([...dir.clone().multiplyScalar(0.18).toArray(), ...dir.clone().multiplyScalar(0.82).toArray()]), view.lineMaterial(color, 3.5));
      const head = new Mesh(opts.cubes ? new BoxGeometry(0.15, 0.15, 0.15) : new ConeGeometry(0.07, 0.22, 16), new MeshBasicMaterial({ color, depthTest: false }));
      head.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), dir);
      head.position.copy(dir).multiplyScalar(0.9);
      arrow.add(shaft, head);
      this.add({ kind: 'axis', i: i as 0 | 1 | 2 }, arrow, color);
      // Plane square (moves in the plane perpendicular to this axis)
      const vector = new Vector3(...AX[(i + 1) % 3]);
      const vAxis = new Vector3(...AX[(i + 2) % 3]);
      const sq = new Mesh(new PlaneGeometry(0.17, 0.17), new MeshBasicMaterial({ color, transparent: true, opacity: 0.55, side: DoubleSide, depthTest: false }));
      sq.position.copy(vector.clone().add(vAxis).multiplyScalar(0.33));
      sq.quaternion.setFromUnitVectors(new Vector3(0, 0, 1), dir);
      this.add({ kind: 'plane', i: i as 0 | 1 | 2 }, sq, color);
      // Rotation arc
      const pts = arcPoints(AX, i);
      const seg: number[] = [];
      for (let pointIndex = 0; pointIndex < pts.length - 1; pointIndex++) {
        seg.push(...pts[pointIndex].toArray(), ...pts[pointIndex + 1].toArray());
      }
      const arc = new LineSegments2(new LineSegmentsGeometry().setPositions(seg), view.lineMaterial(color, 3));
      this.add({ kind: 'ring', i: i as 0 | 1 | 2 }, arc, color);
    });
    const ball = new Mesh(new SphereGeometry(0.075, 16, 12), new MeshBasicMaterial({ color: 0xffffff, depthTest: false }));
    this.add({ kind: 'center' }, ball, 0xffffff);
    // Over everything, selection highlights included (see Handle).
    this.group.traverse((object) => {
      object.renderOrder = 50;
      const material = (object as Mesh).material as MeshBasicMaterial | undefined;
      if (material && 'transparent' in material) {
        material.transparent = true;
      }
    });
    view.overlay.add(this.group);
    view.frameHooks.add(this.hook);
    view.helpers.add(this);
  }

  private add(part: GimbalPart, obj: Group | Mesh | LineSegments2, color: number): void {
    obj.visible = this.allow(part);
    this.parts.push({ part, obj, color });
    this.group.add(obj);
  }

  setCenter(center: Vec3): void {
    this.center.set(...center);
    this.layout();
    this.view.requestRender();
  }

  get origin(): Vec3 {
    return this.center.toArray() as Vec3;
  }

  private scale(): number {
    return this.view.cam.worldPerPixel(this.view.height) * SIZE_PX;
  }

  private layout(): void {
    this.group.position.copy(this.center);
    this.group.scale.setScalar(this.scale());
    this.faceView();
  }

  /** The direction last looked from (parts shown or put aside for it). */
  private looked = new Vector3();

  /**
   * Parts seen edge-on step aside: looking straight at a face (the view cube),
   * an arc whose plane runs towards you is a line lying right over an arrow
   * and took its taps; an arrow pointing at you is a dot over the centre; a
   * square edge-on is a sliver. None of them can be dragged usefully like that.
   */
  private usable(part: GimbalPart): boolean {
    if (!this.allow(part)) {
      return false;
    }
    if (part.kind === 'center') {
      return true;
    }
    const along = Math.abs(this.looked.dot(new Vector3(...this.axes[part.i])));

    return part.kind === 'axis' ? along < 0.97 : along > 0.26;
  }

  private faceView(): void {
    const direction = this.view.cam.camera.getWorldDirection(new Vector3());
    if (direction.distanceToSquared(this.looked) < 1e-8) {
      return;
    }
    this.looked.copy(direction);
    for (const { part, obj } of this.parts) {
      obj.visible = this.usable(part);
    }
  }

  private screen(local: Vector3): [number, number] | null {
    return this.view.toScreen(local.clone().multiplyScalar(this.scale()).add(this.center));
  }

  /** Which part is under the pointer (centre, planes, arrows, arcs - in that order). */
  hit(pointer: ToolPointer): GimbalPart | null {
    const tol = Math.max(10, pointer.tol * 1.2);
    const screenCenter = this.screen(new Vector3());
    this.faceView();
    if (screenCenter && this.allow({ kind: 'center' }) && Math.hypot(screenCenter[0] - pointer.x, screenCenter[1] - pointer.y) < tol) {
      return { kind: 'center' };
    }
    for (let i = 0; i < 3; i++) {
      if (!this.usable({ kind: 'plane', i: i as 0 | 1 | 2 })) {
        continue;
      }
      const vector = new Vector3(...this.axes[(i + 1) % 3]);
      const vAxis = new Vector3(...this.axes[(i + 2) % 3]);
      const midpoint = vector.clone().add(vAxis).multiplyScalar(0.33);
      const quad = [midpoint.clone().addScaledVector(vector, -0.085).addScaledVector(vAxis, -0.085), midpoint.clone().addScaledVector(vector, 0.085).addScaledVector(vAxis, -0.085), midpoint.clone().addScaledVector(vector, 0.085).addScaledVector(vAxis, 0.085), midpoint.clone().addScaledVector(vector, -0.085).addScaledVector(vAxis, 0.085)]
        .map(q => this.screen(q))
        .filter((q): q is [number, number] => !!q);
      if (quad.length === 4 && inPoly(pointer.x, pointer.y, quad)) {
        return { kind: 'plane', i: i as 0 | 1 | 2 };
      }
    }
    let best: { part: GimbalPart; d: number } | null = null;
    let arrow: { part: GimbalPart; d: number } | null = null;
    for (let i = 0; i < 3; i++) {
      const dir = new Vector3(...this.axes[i]);
      const a = this.screen(dir.clone().multiplyScalar(0.18));
      const b = this.screen(dir.clone().multiplyScalar(1.02));
      if (a && b && this.usable({ kind: 'axis', i: i as 0 | 1 | 2 })) {
        const distance = segDist(pointer.x, pointer.y, a, b);
        if (distance < tol && (!arrow || distance < arrow.d)) {
          arrow = { part: { kind: 'axis', i: i as 0 | 1 | 2 }, d: distance };
        }
      }
      const pts = this.usable({ kind: 'ring', i: i as 0 | 1 | 2 }) ? arcPoints(this.axes, i, 16).map(q => this.screen(q)) : [];
      for (let pointIndex = 0; pointIndex < pts.length - 1; pointIndex++) {
        const s0 = pts[pointIndex];
        const s1 = pts[pointIndex + 1];
        if (!s0 || !s1) {
          continue;
        }
        const distance = segDist(pointer.x, pointer.y, s0, s1);
        if (distance < tol && (!best || distance < best.d)) {
          best = { part: { kind: 'ring', i: i as 0 | 1 | 2 }, d: distance };
        }
      }
    }

    // An arrow within reach wins over an arc that also is (the arc runs close by its tip).
    return arrow?.part ?? best?.part ?? null;
  }

  /** Brighten the part under the pointer / being dragged. */
  setHot(part: GimbalPart | null): void {
    if (JSON.stringify(part) === JSON.stringify(this.hot)) {
      return;
    }
    this.hot = part;
    for (const { part: q, obj, color } of this.parts) {
      const on = !!part && JSON.stringify(part) === JSON.stringify(q);
      obj.traverse((object) => {
        const material = (object as Mesh).material as MeshBasicMaterial & { color?: { setHex(n: number): void } };
        if (material?.color) {
          material.color.setHex(on ? 0xffd34d : color);
        }
      });
    }
    this.view.requestRender();
  }

  dispose(): void {
    this.view.helpers.delete(this);
    this.view.frameHooks.delete(this.hook);
    this.view.overlay.remove(this.group);
    this.group.traverse((object) => {
      const mesh = object as Mesh;
      if (mesh.geometry instanceof BufferGeometry) {
        mesh.geometry.dispose();
      }
      if (mesh.material instanceof LineMaterial) {
        this.view.releaseLineMaterial(mesh.material);
      }
    });
    this.view.requestRender();
  }
}

export const GIMBAL_AXES = AXES;

function segDist(x: number, y: number, a: [number, number], b: [number, number]): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / l2));

  return Math.hypot(a[0] + dx * t - x, a[1] + dy * t - y);
}

function inPoly(x: number, y: number, poly: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }

  return inside;
}
