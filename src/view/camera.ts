import { Box3, MathUtils, OrthographicCamera, PerspectiveCamera, Quaternion, Vector3 } from 'three';
import type { Camera } from 'three';
import type { SavedView, Vec3 } from '../doc/types';

const UP = new Vector3(0, 0, 1);
const FOV = 40;
const ISO_AZIMUTH = MathUtils.degToRad(-60);
const ISO_ELEVATION = MathUtils.degToRad(30);
const START_DISTANCE = 300;
/** Just short of straight up or down, where the view's sideways direction is undefined. */
const MAX_ELEVATION = Math.PI / 2 - 1e-4;
const FIT_MARGIN = 1.12;
const MOVE_MS = 380;

/** How much of the screen tool columns and bars cover on each side (0–1 of the width/height). */
export interface Insets {
  left: number;
  right: number;
  top: number;
  bottom: number;
}
const NO_INSETS: Insets = { left: 0, right: 0, top: 0, bottom: 0 };

interface ViewState {
  target: Vector3;
  distance: number;
  azimuth: number;
  elevation: number;
  roll: number;
}

/** The screen's right, up and towards-the-viewer directions. */
interface ScreenAxes {
  right: Vector3;
  up: Vector3;
  back: Vector3;
}

interface FitFrame {
  /** The view the fit starts from: its direction and roll are kept. */
  view: ViewState;
  axes: ScreenAxes;
  boxCenter: Vector3;
  corners: Vector3[];
  free: Insets;
  /** The free part of the screen: its size and centre, as fractions of the screen. */
  freeWidth: number;
  freeHeight: number;
  freeCenterX: number;
  freeCenterY: number;
  /** Tangents of half the view's horizontal and vertical angle. */
  tanH: number;
  tanV: number;
  minDistance: number;
}

const clampElevation = (elevation: number) => MathUtils.clamp(elevation, -MAX_ELEVATION, MAX_ELEVATION);

/** The same turn, the short way round (-π … π). */
const shortestTurn = (angle: number) => Math.atan2(Math.sin(angle), Math.cos(angle));

const isFiniteVector = (vector: Vector3) => Number.isFinite(vector.x) && Number.isFinite(vector.y) && Number.isFinite(vector.z);

/** NaN or Infinity would blank everything, grid included. */
function isValidView(view: ViewState): boolean {
  return isFiniteVector(view.target) && [view.distance, view.azimuth, view.elevation, view.roll].every(Number.isFinite) && view.distance > 0;
}

function startView(): ViewState {
  return { target: new Vector3(), distance: START_DISTANCE, azimuth: ISO_AZIMUTH, elevation: ISO_ELEVATION, roll: 0 };
}

/** The unit vector from the target towards the camera. */
function directionOf(azimuth: number, elevation: number): Vector3 {
  const cosElevation = Math.cos(elevation);

  return new Vector3(cosElevation * Math.cos(azimuth), cosElevation * Math.sin(azimuth), Math.sin(elevation));
}

function placeCamera(camera: Camera, view: ViewState): void {
  const direction = directionOf(view.azimuth, view.elevation);
  camera.position.copy(view.target).addScaledVector(direction, view.distance);
  camera.up.copy(UP);
  // Near the poles, derive "up" from the azimuth so the view doesn't spin.
  if (Math.abs(direction.z) > 0.99) {
    camera.up.set(-Math.cos(view.azimuth) * Math.sign(direction.z), -Math.sin(view.azimuth) * Math.sign(direction.z), 0);
  }
  camera.lookAt(view.target);
  if (view.roll) {
    camera.rotateZ(view.roll);
  }
}

function cornersOf(box: Box3): Vector3[] {
  return [0, 1, 2, 3, 4, 5, 6, 7].map(i => new Vector3(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z));
}

const hasFiniteSize = (box: Box3) => !box.isEmpty() && isFiniteVector(box.min) && isFiniteVector(box.max);

/**
 * Z-up orbit camera: azimuth around Z, elevation above the XY plane.
 * Perspective and orthographic share target/distance, so switching is seamless.
 */
export class CameraController {
  readonly persp: PerspectiveCamera;
  readonly orthoCam: OrthographicCamera;
  ortho = false;
  /**
   * Flat only for a view asked for by name (a side of the view cube, Front / Top / ... in Views) while the view is
   * in perspective: in perspective again once the view is turned by hand.
   */
  flatForNow = false;
  target = new Vector3(0, 0, 0);
  distance = START_DISTANCE;
  azimuth = ISO_AZIMUTH;
  elevation = ISO_ELEVATION;
  /** Roll around the view direction (used for face-on views, rotated 90° steps). */
  roll = 0;
  animate = true;
  /** A chosen point to orbit around (else the view turns about its target). Zoom to fit clears it. */
  pivot: Vector3 | null = null;
  private aspect = 1;
  private animation: { from: ViewState; to: ViewState; t0: number } | null = null;
  /** The last view that was valid: restored if something ever corrupts it. */
  private lastValid: ViewState | null = null;
  /** Placed for a view state to read its screen directions, leaving the real cameras alone. */
  private scratch = new PerspectiveCamera();

  constructor(aspect: number) {
    this.persp = new PerspectiveCamera(FOV, aspect, 0.1, 1e7);
    this.orthoCam = new OrthographicCamera(-1, 1, 1, -1, -1e7, 1e7);
    this.aspect = aspect;
    this.update();
  }

  get camera(): PerspectiveCamera | OrthographicCamera {
    return this.ortho ? this.orthoCam : this.persp;
  }

  setAspect(aspect: number): void {
    this.aspect = aspect;
    this.update();
  }

  setOrtho(on: boolean): void {
    this.ortho = on;
    if (!on) {
      this.flatForNow = false;
    }
    this.update();
  }

  /** Flat for a view asked for by name, until the view is turned by hand. */
  flatUntilTurned(): void {
    if (this.ortho && !this.flatForNow) {
      return;
    }
    this.flatForNow = true;
    this.setOrtho(true);
  }

  /** Back in perspective, if the view was only flat for a view asked for by name. */
  private endFlat(): void {
    if (!this.flatForNow) {
      return;
    }
    this.flatForNow = false;
    this.ortho = false;
  }

  orbit(dxPx: number, dyPx: number): void {
    this.animation = null;
    this.endFlat();
    this.roll = 0;
    const previousAzimuth = this.azimuth;
    const previousElevation = this.elevation;
    this.azimuth -= dxPx * 0.006;
    this.elevation = clampElevation(this.elevation + dyPx * 0.006);
    if (this.pivot) {
      // Turn the target about the pivot the same way the view turned, so the
      // pivot stays put on screen: first about Z (azimuth), then about the
      // view's sideways axis (elevation).
      const sideways = new Vector3(-Math.sin(previousAzimuth), Math.cos(previousAzimuth), 0);
      const turnUp = new Quaternion().setFromAxisAngle(sideways, -(this.elevation - previousElevation));
      const turnAround = new Quaternion().setFromAxisAngle(UP, this.azimuth - previousAzimuth);
      const offset = this.target.clone().sub(this.pivot).applyQuaternion(turnUp).applyQuaternion(turnAround);
      this.target.copy(this.pivot).add(offset);
    }
    this.update();
  }

  /** Pan so the scene follows the pointer. */
  pan(dxPx: number, dyPx: number, viewportHeight: number): void {
    this.animation = null;
    const unitsPerPixel = this.worldPerPixel(viewportHeight);
    const right = new Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0);
    const up = new Vector3().setFromMatrixColumn(this.camera.matrixWorld, 1);
    this.target.addScaledVector(right, -dxPx * unitsPerPixel).addScaledVector(up, dyPx * unitsPerPixel);
    this.update();
  }

  /** factor < 1 zooms in. `toward` keeps that world point under the pointer. */
  zoom(factor: number, toward?: Vector3): void {
    this.animation = null;
    // 0.001 mm … 1 000 000 mm scenes.
    const nextDistance = MathUtils.clamp(this.distance * factor, 0.005, 5e6);
    // A point far off (the ground at the horizon, a bad hit) would fling the
    // target away: zoom straight in instead.
    const isTowardUsable = toward !== undefined && Number.isFinite(toward.x + toward.y + toward.z) && toward.distanceTo(this.target) <= this.distance * 20;
    if (isTowardUsable) {
      const fraction = 1 - nextDistance / this.distance;
      if (this.ortho) {
        // In ortho, only move sideways (depth doesn't change what's under the cursor).
        const view = this.viewDir();
        const offset = toward.clone().sub(this.target);
        offset.addScaledVector(view, -offset.dot(view));
        this.target.addScaledVector(offset, fraction);
      } else {
        this.target.lerp(toward, fraction);
      }
    }
    this.distance = nextDistance;
    this.update();
  }

  worldPerPixel(viewportHeight: number): number {
    return (2 * this.distance * Math.tan(MathUtils.degToRad(FOV / 2))) / viewportHeight;
  }

  /** Unit vector from the camera towards the target. */
  viewDir(): Vector3 {
    return this.target.clone().sub(this.camera.position).normalize();
  }

  /**
   * Look along -normal at the target. `xDir` (optional) is the world direction
   * that should point right on screen, e.g. a sketch plane's x axis.
   */
  lookAlong(normal: Vec3, xDir?: Vec3, target?: Vec3): void {
    const unitNormal = new Vector3(...normal).normalize();
    const to = this.aim();
    if (target) {
      to.target = new Vector3(...target);
    }
    to.elevation = clampElevation(Math.asin(unitNormal.z));
    to.roll = 0;
    const wantedRight = new Vector3(...(xDir ?? [1, 0, 0]));
    if (Math.abs(unitNormal.z) > 0.999) {
      // Top/bottom: at the poles the screen's right is (-sin a, cos a, 0).
      to.azimuth = Math.atan2(-wantedRight.x, wantedRight.y);
    } else {
      to.azimuth = Math.atan2(unitNormal.y, unitNormal.x);
      if (xDir) {
        // Tilted planes: roll so xDir points right on screen.
        const right = new Vector3().crossVectors(UP, unitNormal).normalize();
        const up = new Vector3().crossVectors(unitNormal, right);
        to.roll = Math.atan2(wantedRight.dot(up), wantedRight.dot(right));
      }
    }
    this.go(to);
  }

  /** Rotate the view 90° around the view direction (view cube arrows). */
  rollBy(radians: number): void {
    const to = this.aim();
    to.roll += radians;
    this.go(to);
  }

  iso(): void {
    this.endFlat();
    this.go({ ...this.aim(), azimuth: ISO_AZIMUTH, elevation: ISO_ELEVATION, roll: 0 });
  }

  /**
   * Frame `box` in the part of the screen the tool columns and bars leave free (`free`: the fraction of the width
   * or height they cover on each side), centred in it. `noZoomIn`: only move over (and out if it must), never closer.
   */
  fit(box: Box3, animate = true, free: Insets = NO_INSETS, noZoomIn = false): void {
    this.pivot = null;
    const framed = hasFiniteSize(box) ? box : new Box3(new Vector3(-50, -50, 0), new Vector3(50, 50, 20));
    const view = this.aim();
    const freeWidth = Math.max(0.3, 1 - free.left - free.right);
    const freeHeight = Math.max(0.3, 1 - free.top - free.bottom);
    const tanV = Math.tan(MathUtils.degToRad(FOV / 2));
    const frame: FitFrame = {
      view,
      axes: this.axes(view),
      boxCenter: framed.getCenter(new Vector3()),
      corners: cornersOf(framed),
      free,
      freeWidth,
      freeHeight,
      freeCenterX: free.left + freeWidth / 2,
      freeCenterY: free.top + freeHeight / 2,
      tanH: tanV * this.aspect,
      tanV,
      minDistance: noZoomIn ? view.distance : 0
    };
    const dest = this.roughFit(frame);
    this.refineFit(dest, frame);
    if (animate) {
      this.go(dest);
    } else {
      this.applyState(dest);
    }
  }

  /** A first framing: the box's extent across and up the screen fitted into the free area, centred in it. */
  private roughFit(frame: FitFrame): ViewState {
    const { axes, boxCenter, free } = frame;
    // The box as the view sees it: its half extent across and up the screen,
    // and how far its nearest corner comes towards the camera.
    let halfWidth = 0;
    let halfHeight = 0;
    let nearReach = 0;
    for (const corner of frame.corners) {
      const offset = corner.clone().sub(boxCenter);
      halfWidth = Math.max(halfWidth, Math.abs(offset.dot(axes.right)));
      halfHeight = Math.max(halfHeight, Math.abs(offset.dot(axes.up)));
      nearReach = Math.max(nearReach, offset.dot(axes.back));
    }
    const halfSize = Math.max(halfWidth, halfHeight, 0.005);
    halfWidth = Math.max(halfWidth, halfSize * 0.02);
    halfHeight = Math.max(halfHeight, halfSize * 0.02);
    // Half the free width at distance d is d·tanH·freeWidth.
    const fitted = Math.max(halfWidth / (frame.tanH * frame.freeWidth), halfHeight / (frame.tanV * frame.freeHeight)) * FIT_MARGIN + (this.ortho ? 0 : nearReach);
    const distance = Math.max(fitted, frame.minDistance);
    // Put the box's centre in the middle of the free area, not of the screen.
    const offsetX = (free.left - free.right) * distance * frame.tanH;
    const offsetY = (free.top - free.bottom) * distance * frame.tanV;
    const target = boxCenter.clone().addScaledVector(axes.right, -offsetX).addScaledVector(axes.up, offsetY);

    return { ...frame.view, target, distance };
  }

  /**
   * Perspective swells the near side of a deep model, and not about the free
   * area's centre: project the corners and correct, a few times over.
   */
  private refineFit(dest: ViewState, frame: FitFrame): void {
    const { axes } = frame;
    for (let attempt = 0; attempt < 10; attempt++) {
      const seen = this.screenBounds(dest, frame);
      const scale = Math.max((seen.right - seen.left) / (frame.freeWidth / FIT_MARGIN), (seen.bottom - seen.top) / (frame.freeHeight / FIT_MARGIN), 1e-6, frame.minDistance / dest.distance);
      const dx = (seen.left + seen.right) / 2 - frame.freeCenterX;
      const dy = (seen.top + seen.bottom) / 2 - frame.freeCenterY;
      if (Math.abs(scale - 1) < 0.01 && Math.abs(dx) < 0.002 && Math.abs(dy) < 0.002) {
        return;
      }
      // The extremes are mostly the near corners: they move by the shift over their own depth.
      dest.target.addScaledVector(axes.right, dx * 2 * seen.nearDepth * frame.tanH).addScaledVector(axes.up, -dy * 2 * seen.nearDepth * frame.tanV);
      dest.distance *= scale;
    }
  }

  /** Where the box's corners land on screen seen from `view` (fractions of the screen, y down), and the nearest one's depth. */
  private screenBounds(view: ViewState, frame: FitFrame) {
    const { axes } = frame;
    const eye = view.target.clone().addScaledVector(axes.back, view.distance);
    const bounds = { left: Infinity, right: -Infinity, top: Infinity, bottom: -Infinity, nearDepth: view.distance };
    for (const corner of frame.corners) {
      const fromEye = corner.clone().sub(eye);
      const depth = this.ortho ? view.distance : Math.max(1e-9, -fromEye.dot(axes.back));
      const x = (fromEye.dot(axes.right) / (depth * frame.tanH) + 1) / 2;
      const y = (1 - fromEye.dot(axes.up) / (depth * frame.tanV)) / 2;
      bounds.nearDepth = Math.min(bounds.nearDepth, depth);
      bounds.left = Math.min(bounds.left, x);
      bounds.right = Math.max(bounds.right, x);
      bounds.top = Math.min(bounds.top, y);
      bounds.bottom = Math.max(bounds.bottom, y);
    }

    return bounds;
  }

  private axes(viewState: ViewState): ScreenAxes {
    placeCamera(this.scratch, { ...viewState, target: new Vector3(), distance: 1 });
    this.scratch.updateMatrixWorld();

    return {
      right: new Vector3().setFromMatrixColumn(this.scratch.matrixWorld, 0),
      up: new Vector3().setFromMatrixColumn(this.scratch.matrixWorld, 1),
      back: new Vector3().setFromMatrixColumn(this.scratch.matrixWorld, 2)
    };
  }

  /** Run `work` with the camera free to move; it comes back exactly as it was (a picture framed differently, say). */
  borrow(work: () => void): void {
    const keep = this.state();
    const pivot = this.pivot;
    try {
      work();
    } finally {
      this.applyState(keep);
      this.pivot = pivot;
    }
  }

  savedView(name: string): SavedView {
    return { name, target: this.target.toArray() as Vec3, distance: this.distance, azimuth: this.azimuth, elevation: this.elevation, ortho: this.ortho };
  }

  restore(savedView: SavedView): void {
    this.flatForNow = false;
    this.ortho = savedView.ortho;
    this.go({ target: new Vector3(...savedView.target), distance: savedView.distance, azimuth: savedView.azimuth, elevation: savedView.elevation, roll: 0 });
  }

  /** Where the view is heading now, to come back to with `back` (a view cube double tap undoes its first tap's turn). */
  mark(): ViewState {
    return this.aim();
  }

  back(viewState: ViewState): void {
    this.endFlat();
    this.go({ ...viewState, target: viewState.target.clone() });
  }

  /** Advance animations; returns true while animating. */
  tick(now: number): boolean {
    if (!this.animation) {
      return false;
    }
    const { from, to, t0 } = this.animation;
    const progress = Math.min(1, (now - t0) / MOVE_MS);
    const eased = progress < 0.5 ? 2 * progress * progress : 1 - Math.pow(-2 * progress + 2, 2) / 2;
    this.applyState({
      target: from.target.clone().lerp(to.target, eased),
      distance: MathUtils.lerp(from.distance, to.distance, eased),
      azimuth: from.azimuth + shortestTurn(to.azimuth - from.azimuth) * eased,
      elevation: MathUtils.lerp(from.elevation, to.elevation, eased),
      roll: from.roll + shortestTurn(to.roll - from.roll) * eased
    });
    if (progress >= 1) {
      this.animation = null;
    }

    return true;
  }

  get animating(): boolean {
    return this.animation !== null;
  }

  private state(): ViewState {
    return { target: this.target.clone(), distance: this.distance, azimuth: this.azimuth, elevation: this.elevation, roll: this.roll };
  }

  /**
   * Where the view is heading: the end of a move still animating, else where it
   * is. A new move builds on this - Fit tapped while a turn to Top is still
   * animating must keep the Top, not freeze it half way round.
   */
  private aim(): ViewState {
    const animation = this.animation;

    return animation ? { ...animation.to, target: animation.to.target.clone() } : this.state();
  }

  private go(to: ViewState): void {
    if (!this.animate) {
      this.applyState(to);

      return;
    }
    this.animation = { from: this.state(), to, t0: performance.now() };
  }

  private applyState(viewState: ViewState): void {
    if (!isValidView(viewState)) {
      return;
    }
    this.setView(viewState);
    this.update();
  }

  private setView(viewState: ViewState): void {
    this.target.copy(viewState.target);
    this.distance = viewState.distance;
    this.azimuth = viewState.azimuth;
    this.elevation = viewState.elevation;
    this.roll = viewState.roll;
  }

  update(): void {
    const current = this.state();
    if (isValidView(current)) {
      this.lastValid = current;
    } else {
      this.setView(this.lastValid ?? startView());
      this.animation = null;
    }
    this.placeCameras();
  }

  private placeCameras(): void {
    const view = this.state();
    placeCamera(this.persp, view);
    placeCamera(this.orthoCam, view);
    this.persp.aspect = this.aspect;
    this.persp.near = Math.max(1e-4, this.distance / 2000);
    this.persp.far = this.distance * 2000;
    this.persp.updateProjectionMatrix();
    const halfHeight = this.distance * Math.tan(MathUtils.degToRad(FOV / 2));
    Object.assign(this.orthoCam, { left: -halfHeight * this.aspect, right: halfHeight * this.aspect, top: halfHeight, bottom: -halfHeight });
    this.orthoCam.near = -this.distance * 1000;
    this.orthoCam.far = this.distance * 1000;
    this.orthoCam.updateProjectionMatrix();
    this.persp.updateMatrixWorld();
    this.orthoCam.updateMatrixWorld();
  }
}
