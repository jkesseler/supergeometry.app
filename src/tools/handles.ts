import { ConeGeometry, Group, Mesh, MeshBasicMaterial, SphereGeometry, Vector3 } from 'three';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import type { Vec3 } from '../doc/types';
import type { Viewport } from '../view/viewport';
import type { ToolPointer } from '../view/input';

// Amber, so a handle never disappears against the blue of a selection.
const COLOR = 0xffa31a;
const HOT = 0xffd27a;
// (Slim and short: a line with a dark edge under it, so it reads over a lit face and over the grid alike, and a
// head sized for a finger whatever the arrow's length.)
const ARROW_PX = 64;
const HEAD_PX = 70;
const EDGE = 0x15171b;

/**
 * A drag handle drawn at constant screen size: an arrow along a direction, or a
 * dot. `hit` tests in screen space so it's easy to grab with a finger.
 */
export class Handle {
  private group = new Group();
  private base = new Vector3();
  private dir = new Vector3(0, 0, 1);
  // Transparent (at full opacity) so it's drawn in the last pass, over see-through
  // selection highlights - three.js draws all opaque things before those.
  private mat = new MeshBasicMaterial({ color: COLOR, depthTest: false, transparent: true });
  private head: Mesh;
  private shaft: LineSegments2 | null = null;
  /** The dark edge under the shaft. */
  private under: LineSegments2 | null = null;
  private underMat: ReturnType<Viewport['lineMaterial']> | null = null;
  private lineMat;
  private onFrame = () => this.layout();

  /** `px`: how long an arrow is on screen (a pair back to back - a double arrow - is drawn shorter). */
  constructor(private view: Viewport, readonly shape: 'arrow' | 'dot', private px = ARROW_PX) {
    this.lineMat = view.lineMaterial(COLOR, 3);
    this.lineMat.transparent = true;
    this.head = new Mesh(shape === 'arrow' ? new ConeGeometry(0.095, 0.3, 24) : new SphereGeometry(0.1, 20, 12), this.mat);
    this.head.renderOrder = 50;
    this.group.add(this.head);
    if (shape === 'arrow') {
      this.underMat = view.lineMaterial(EDGE, 6);
      this.underMat.transparent = true;
      this.underMat.opacity = 0.55;
      this.under = new LineSegments2(new LineSegmentsGeometry(), this.underMat);
      this.under.renderOrder = 49;
      this.group.add(this.under);
      this.shaft = new LineSegments2(new LineSegmentsGeometry(), this.lineMat);
      this.shaft.renderOrder = 50;
      this.group.add(this.shaft);
    }
    view.overlay.add(this.group);
    view.frameHooks.add(this.onFrame);
    view.helpers.add(this);
  }

  private hot = false;

  /** Highlight while the pointer is over it (brighter and a bit bigger). */
  setHot(on: boolean): void {
    if (on === this.hot) {
      return;
    }
    this.hot = on;
    this.mat.color.setHex(on ? HOT : COLOR);
    if (this.shaft) {
      this.view.releaseLineMaterial(this.lineMat);
      this.lineMat = this.view.lineMaterial(on ? HOT : COLOR, on ? 4.5 : 3);
      this.lineMat.transparent = true;
      this.shaft.material = this.lineMat;
    }
    this.layout();
    this.view.requestRender();
  }

  set(base: Vec3, dir?: Vec3): void {
    this.base.set(...base);
    if (dir) {
      this.dir.set(...dir).normalize();
    }
    this.layout();
    this.view.requestRender();
  }

  /** Screen position of the grabbable part. */
  grabPoint(): [number, number] | null {
    return this.view.toScreen(this.tip());
  }

  /** Shown or not (a hidden one can't be grabbed). */
  setVisible(on: boolean): void {
    if (this.group.visible === on) {
      return;
    }
    this.group.visible = on;
    this.view.requestRender();
  }

  hit(pointer: ToolPointer): boolean {
    if (!this.group.visible) {
      return false;
    }
    const grab = this.grabPoint();

    return !!grab && Math.hypot(grab[0] - pointer.x, grab[1] - pointer.y) < Math.max(30, pointer.tol * 1.8);
  }

  dispose(): void {
    this.view.helpers.delete(this);
    this.view.frameHooks.delete(this.onFrame);
    this.view.overlay.remove(this.group);
    this.head.geometry.dispose();
    this.shaft?.geometry.dispose();
    this.under?.geometry.dispose();
    if (this.underMat) {
      this.view.releaseLineMaterial(this.underMat);
    }
    this.view.releaseLineMaterial(this.lineMat);
    this.view.requestRender();
  }

  private size(): number {
    return this.view.cam.worldPerPixel(this.view.height) * this.px;
  }

  private headScale(): number {
    return this.view.cam.worldPerPixel(this.view.height) * HEAD_PX * (this.hot ? 1.3 : 1);
  }

  private tip(): Vector3 {
    return this.shape === 'arrow' ? this.base.clone().addScaledVector(this.dir, this.size()) : this.base.clone();
  }

  private layout(): void {
    const size = this.size();
    this.head.scale.setScalar(this.headScale());
    if (this.shape === 'arrow') {
      const tip = this.tip();
      this.head.position.copy(tip);
      this.head.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), this.dir);
      // (From a little off its foot to the head's base; the head's point is the arrow's tip.)
      const height = this.headScale() * 0.3;
      this.head.position.copy(tip).addScaledVector(this.dir, -height / 2);
      const start = this.base.clone().addScaledVector(this.dir, Math.min(size * 0.12, Math.max(0, size - height)));
      const end = this.base.clone().addScaledVector(this.dir, Math.max(0, size - height));
      const at = [...start.toArray(), ...end.toArray()];
      (this.shaft!.geometry as LineSegmentsGeometry).setPositions(at);
      (this.under!.geometry as LineSegmentsGeometry).setPositions(at);
    } else {
      this.head.position.copy(this.base);
    }
  }
}

/** Screen-space drag along a world axis → signed world distance. */
/**
 * How far (world units, signed along `dir`) the pointer has dragged along the
 * line through `origin` in direction `dir`: the point of that line under the
 * finger, now minus at the start. Exact at any zoom and from any side - the
 * arrow always follows the finger: drag outward, it goes outward.
 */
export function axisDrag(view: Viewport, origin: Vec3, dir: Vec3, from: ToolPointer, to: ToolPointer): number {
  const dl = Math.hypot(dir[0], dir[1], dir[2]) || 1;
  const direction: Vec3 = [dir[0] / dl, dir[1] / dl, dir[2] / dl];
  const dot3 = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  // Where along the line the pointer's ray passes closest.
  const along = (pointer: ToolPointer): number | null => {
    const ray = view.pointerRay(pointer.x, pointer.y);
    const toOrigin: Vec3 = [origin[0] - ray.o[0], origin[1] - ray.o[1], origin[2] - ray.o[2]];
    const b = dot3(direction, ray.d);
    const den = 1 - b * b;
    // Looking (almost) straight along the line: no good answer this way.
    if (den < 0.03) {
      return null;
    }

    return (b * dot3(ray.d, toOrigin) - dot3(direction, toOrigin)) / den;
  };
  const t0 = along(from);
  const t1 = along(to);
  if (t0 !== null && t1 !== null) {
    return t1 - t0;
  }
  // Nearly end-on: by the screen direction of a long piece of the line (or,
  // dead end-on, finger up = towards you).
  const wpp = view.cam.worldPerPixel(view.height);
  const length = wpp * 80;
  const vector = new Vector3(...origin);
  const a = view.toScreen(vector);
  const b = view.toScreen(vector.clone().addScaledVector(new Vector3(...direction), length));
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (a && b) {
    const vx = b[0] - a[0];
    const vy = b[1] - a[1];
    const l2 = vx * vx + vy * vy;
    if (l2 > 16) {
      return ((dx * vx + dy * vy) / l2) * length;
    }
  }
  const eye = view.pointerRay(view.width / 2, view.height / 2).d;
  const towardYou = dot3(direction, eye) < 0 ? 1 : -1;

  return -dy * wpp * towardYou;
}
