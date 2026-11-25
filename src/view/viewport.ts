import {
  CanvasTexture,
  AmbientLight,
  BackSide,
  Box3,
  BufferAttribute,
  BufferGeometry,
  Color,
  DirectionalLight,
  DoubleSide,
  EdgesGeometry,
  Float32BufferAttribute,
  FrontSide,
  Group,
  HemisphereLight,
  Line,
  LineBasicMaterial,
  LineDashedMaterial,
  LineSegments,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  Path,
  Plane,
  PlaneGeometry,
  Points,
  PointsMaterial,
  Raycaster,
  Scene,
  Shape,
  ShapeGeometry,
  SRGBColorSpace,
  TextureLoader,
  Vector2,
  Vector3,
  WebGLRenderer,
  Sprite,
  SpriteMaterial,
  AlwaysStencilFunc,
  DecrementWrapStencilOp,
  IncrementWrapStencilOp,
  NotEqualStencilFunc,
  ReplaceStencilOp
} from 'three';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { isHeadset } from '../device';
import { bodyColor } from '../doc/types';
import { FRONT, GROUND, RIGHT, planeY } from '../geom';
import { settings } from '../settings';
import { pointsOf } from '../sketch/constraints';
import { entityPolylines, splineHeights, splineHeightSamples } from '../sketch/curves';
import { arrangement } from '../sketch/regions';
import { uniqueEnds } from './corners';
import { CameraController, type Insets } from './camera';
import { AdaptiveGrid } from './grid';
import { analysisMaterial, curvatureOf } from './analysis';
import type { BodyMesh, ConstructionInfo, EdgeInfo, FaceInfo } from '../kernel/protocol';
import type { ImageFeature, PlaneDef, SketchEntity, SketchFeature, Vec2, Vec3 } from '../doc/types';

export type PickHit =
  | { kind: 'face'; body: string; face: number; point: Vec3 }
  | { kind: 'edge'; body: string; edge: number; point: Vec3 }
  | { kind: 'vertex'; body: string; vertex: number; point: Vec3 }
  | { kind: 'profile'; sketch: string; region: number; point: Vec3 }
  | { kind: 'curve'; sketch: string; entity: string; point: Vec3 }
  | { kind: 'point'; sketch: string; entity: string; p: string; point: Vec3 }
  | { kind: 'image'; id: string; point: Vec3 }
  | { kind: 'plane'; id: string; point: Vec3 }
  | { kind: 'axis'; id: string; point: Vec3 }
  /** The world origin, 0, 0, 0 (point picks only: PickOptions.origin). */
  | { kind: 'origin'; point: Vec3 };

export type Highlight =
  | { kind: 'face'; body: string; face: number }
  | { kind: 'edge'; body: string; edge: number }
  | { kind: 'vertex'; body: string; vertex: number }
  | { kind: 'body'; body: string }
  | { kind: 'profile'; sketch: string; region: number }
  | { kind: 'curve'; sketch: string; entity: string }
  | { kind: 'point'; sketch: string; entity: string; p: string }
  | { kind: 'image'; id: string }
  | { kind: 'plane'; id: string }
  | { kind: 'axis'; id: string }
  | { kind: 'origin' };

const WORLD_AXIS_DIRS: Record<string, Vec3> = { X: [1, 0, 0], Y: [0, 1, 0], Z: [0, 0, 1] };

/** Round dots for points (three.js draws points as squares; squares are kept for midpoints). */
let dotTexture: CanvasTexture | null = null;
export function dotMaterial(opts: { color: number; size: number; depthTest?: boolean; opacity?: number }): PointsMaterial {
  if (!dotTexture) {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 64;
    const context = canvas.getContext('2d')!;
    context.fillStyle = '#fff';
    context.beginPath();
    context.arc(32, 32, 30, 0, Math.PI * 2);
    context.fill();
    dotTexture = new CanvasTexture(canvas);
  }

  return new PointsMaterial({ color: opts.color, size: opts.size, sizeAttenuation: false, depthTest: opts.depthTest ?? false, map: dotTexture, alphaTest: 0.5, transparent: true, opacity: opts.opacity ?? 1 });
}

export interface PickOptions {
  edgeTolPx?: number;
  profiles?: boolean;
  bodies?: boolean;
  edges?: boolean;
  curves?: boolean | string;
  planes?: boolean;
  axes?: boolean;
  /** The world X/Y/Z axes count as axes (ids "X", "Y", "Z") - for axis/direction slots. */
  worldAxes?: boolean;
  vertices?: boolean;
  images?: boolean;
  /** Planes win even when a body is in front (picking a sketch/section plane). */
  planesFirst?: boolean;
  /** The world origin (0, 0, 0) can be picked, near where the X / Y / Z axes cross. */
  origin?: boolean;
}

/** A sketch as drawn: its own curves plus the face outline it sits on (if any). */
export type SketchView = SketchFeature & { boundary?: SketchEntity[]; /** The sketch being edited: its curves the constraints hold completely (drawn green). */ defined?: ReadonlySet<string> };

/** The three origin planes, addressable like construction planes. */
export const ORIGIN_PLANES: Record<string, PlaneDef> = { XY: GROUND, XZ: FRONT, YZ: RIGHT };

const COLORS = {
  body: 0xb9bec7,
  edge: 0x23262b,
  hover: 0x7fb2ff,
  select: 0x2f7bff,
  sketch: 0xe8e8e8,
  sketchActive: 0xffc23d,
  // (A sketch's construction lines: an orange that stands out on a body's grey, a plane's blue and the dark floor
  // alike. They were a thin grey - the body's own colour, all but - and could hardly be seen drawn on a face.)
  construction: 0xf26b00,
  linked: 0xc79bff,
  profile: 0x4d8dff,
  plane: 0x8fb4ff,
  cap: 0xff8fb8
};

interface BodyView {
  data: BodyMesh;
  mesh: Mesh;
  /** Section cap: a plane on the cut, drawn only inside the body (stencil). */
  cap: Mesh;
  /** The two passes that mark "inside the body" for the cap. */
  capStencil: Mesh[];
  /** The cut's outline, drawn thick. */
  outline: LineSegments2 | null;
  edges: LineSegments;
  hidden: LineSegments;
  /** Unique edge endpoints (the body's vertices). */
  vertices: Vector3[];
}

export class Viewport {
  readonly renderer: WebGLRenderer;
  readonly scene = new Scene();
  readonly cam: CameraController;
  readonly overlay = new Group();
  readonly grid = new AdaptiveGrid();
  /** Called before each render, e.g. to keep handles a constant screen size. */
  readonly frameHooks = new Set<() => void>();
  private bodiesGroup = new Group();
  private sketchGroup = new Group();
  private constructionGroup = new Group();
  private imageGroup = new Group();
  private highlightGroup = new Group();
  private axesGroup: Object3D;
  private bodies = new Map<string, BodyView>();
  private profileMeshes: Mesh[] = [];
  /** Closed shapes of the sketches on show, ready to pull into 3D. */
  /** The closed shapes of the sketches shown (outside the sketch being drawn): which, and the corners of each in the world. */
  profileList(): { sketch: string; region: number; points: Vec3[] }[] {
    return this.profileMeshes
      .filter(profileMesh => profileMesh.visible && profileMesh.parent?.visible !== false)
      .map((profileMesh) => {
        let pts = profileMesh.userData.world as Vec3[] | undefined;
        if (!pts) {
          const pos = profileMesh.geometry.getAttribute('position');
          const vector = new Vector3();
          pts = [];
          for (let i = 0; i < pos.count; i++) {
            pts.push(vector.fromBufferAttribute(pos, i).applyMatrix4(profileMesh.matrix).toArray() as Vec3);
          }
          profileMesh.userData.world = pts;
        }

        return { sketch: profileMesh.userData.sketch as string, region: profileMesh.userData.region as number, points: pts };
      });
  }

  get profileCount(): number {
    return this.profileMeshes.length;
  }
  private curveLines: { sketch: string; entity: string; pts: Vector3[] }[] = [];
  private planeMeshes: Mesh[] = [];
  private axisLines: { id: string; a: Vector3; b: Vector3 }[] = [];
  private raycaster = new Raycaster();
  private dirty = true;
  private light = new DirectionalLight(0xffffff, 1.6);
  private lineMaterials: LineMaterial[] = [];
  private sketches: SketchView[] = [];
  /** The sketch being edited and the sketches shown whole, as last given (to draw them again when a curve is picked). */
  private activeSketch: string | undefined;
  private freshSketches: ReadonlySet<string> = new Set();
  /**
   * The curves picked in the sketch being edited. A spline shows its two ends;
   * the points between (the ones it is shaped by) come up once it is picked -
   * a curve projected from an edge, offset, or a text's outline was a row of
   * dots otherwise.
   */
  private openCurves = new Set<string>();
  /** The construction planes and axes shown (read: listed by name where a tap would pick one). */
  construction: { planes: ConstructionInfo[]; axes: ConstructionInfo[] } = { planes: [], axes: [] };
  private showOriginPlanes = false;
  private clip: Plane | null = null;
  private bodyMat: MeshStandardMaterial;
  private capMat: MeshBasicMaterial;
  private stencilMats: MeshBasicMaterial[] = [];
  /** Section caps, their stencil passes and outlines (apart: not part of the model's size). */
  private capGroup = new Group();
  private capPlaneGeo = new PlaneGeometry(1, 1);
  private edgeMat: LineBasicMaterial;
  private hiddenMat: LineDashedMaterial;

  constructor(readonly canvas: HTMLCanvasElement) {
    // (The drawing buffer isn't kept between frames: the browser shows each one the
    // quick way. The two places that read the canvas - the library's picture and
    // the screenshot - draw the view right before they do.)
    this.renderer = new WebGLRenderer({ canvas, antialias: true, stencil: true });
    // Headsets render the page into a big virtual screen already: full ratio costs frames for no gain.
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, isHeadset ? 1.25 : 2));
    this.renderer.localClippingEnabled = true;
    this.cam = new CameraController(1);
    this.scene.background = new Color(0x2b2d31);

    this.scene.add(new HemisphereLight(0xffffff, 0x3a3d44, 1.1));
    this.scene.add(new AmbientLight(0xffffff, 0.25));
    this.scene.add(this.light, this.light.target);

    this.bodyMat = new MeshStandardMaterial({ color: COLORS.body, metalness: 0.05, roughness: 0.55, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1, side: FrontSide });
    // Section caps: a plane on the cut, drawn only where the body is cut (a
    // stencil marks the inside) - solid: what's behind it doesn't show through
    // (the far wall's inside was drawn flat before, its edges and all).
    this.capMat = hatched(new MeshBasicMaterial({ color: COLORS.cap, side: DoubleSide, stencilWrite: true, stencilRef: 0, stencilFunc: NotEqualStencilFunc, stencilFail: ReplaceStencilOp, stencilZFail: ReplaceStencilOp, stencilZPass: ReplaceStencilOp }));
    this.stencilMats = [BackSide, FrontSide].map(
      side =>
        new MeshBasicMaterial({
          side,
          colorWrite: false,
          depthWrite: false,
          depthTest: false,
          stencilWrite: true,
          stencilFunc: AlwaysStencilFunc,
          ...(side === BackSide
            ? { stencilFail: IncrementWrapStencilOp, stencilZFail: IncrementWrapStencilOp, stencilZPass: IncrementWrapStencilOp }
            : { stencilFail: DecrementWrapStencilOp, stencilZFail: DecrementWrapStencilOp, stencilZPass: DecrementWrapStencilOp })
        })
    );
    this.edgeMat = new LineBasicMaterial({ color: COLORS.edge });
    this.hiddenMat = new LineDashedMaterial({ color: 0x6b7280, dashSize: 2, gapSize: 2, depthTest: false, transparent: true, opacity: 0.7 });

    this.axesGroup = makeAxes();
    this.scene.add(this.grid.mesh, this.axesGroup, this.imageGroup, this.bodiesGroup, this.capGroup, this.constructionGroup, this.sketchGroup, this.highlightGroup, this.overlay);

    settings.onChange(() => this.applySettings());
    this.applySettings();
    new ResizeObserver(() => this.resize()).observe(canvas);
    this.resize();
    const loop = (t: number) => {
      if (this.cam.tick(t)) {
        this.dirty = true;
      }
      if (this.tickPulse(t)) {
        this.dirty = true;
      }
      // (In a headset the headset's own loop draws: see xr.ts.)
      if (this.dirty && !this.renderer.xr.isPresenting) {
        this.render();
      }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  get width(): number {
    return this.canvas.clientWidth;
  }
  get height(): number {
    return this.canvas.clientHeight;
  }
  get camera() {
    return this.cam.camera;
  }

  requestRender(): void {
    this.dirty = true;
  }

  private resize(): void {
    const clientWidth = this.canvas.clientWidth;
    const clientHeight = this.canvas.clientHeight;
    if (!clientWidth || !clientHeight) {
      return;
    }
    this.renderer.setSize(clientWidth, clientHeight, false);
    this.cam.setAspect(clientWidth / clientHeight);
    this.lineMaterials.forEach(lineMaterial => lineMaterial.resolution.set(clientWidth, clientHeight));
    this.dirty = true;
  }

  private render(): void {
    this.dirty = false;
    const cam = this.camera;
    this.light.position.copy(cam.position).add(new Vector3(0, 0, this.cam.distance * 0.5));
    this.light.target.position.copy(this.cam.target);
    this.grid.update(this.cam.worldPerPixel(this.height), this.cam.target, this.cam.distance, this.cam.camera.position);
    this.layoutOriginPlanes();
    if (this.anaMat && settings.value.analysis !== 'none') {
      this.anaMat.uniforms.uOrtho.value = this.cam.ortho;
      this.anaMat.uniforms.uViewDir.value.copy(this.cam.viewDir());
    }
    this.frameHooks.forEach(frameHook => frameHook());
    this.renderer.render(this.scene, cam);
  }

  private applySettings(): void {
    const value = settings.value;
    this.grid.mesh.visible = value.showGrid;
    this.grid.locked = value.gridLocked;
    this.grid.lockedStep = value.gridStep;
    this.axesGroup.visible = value.showAxes;
    this.cam.animate = value.animateCamera;
    // A 2D section is always seen straight on, without perspective.
    // (Orthographic chosen in Settings: no longer only flat for a view of the cube's.)
    if (value.ortho) {
      this.cam.flatForNow = false;
    }
    this.cam.setOrtho(value.ortho || (this.sectionStyle === 'flat' && !!this.clip) || this.cam.flatForNow);
    // Select Through shows what's behind (X-ray), since that's what it picks.
    const xray = value.shader === 'xray' || this.selectThrough;
    for (const allBodyMaterial of this.allBodyMats()) {
      // A see-through body (Transparency) is seen through in every view; while a
      // new solid is being sized from a sketch, everything is a little see-through.
      const opacity = ((allBodyMaterial.userData.opacity as number | undefined) ?? 1) * (this.ghost ? 0.62 : 1);
      const see = xray || opacity < 1;
      allBodyMaterial.transparent = see;
      allBodyMaterial.opacity = (xray ? 0.35 : 1) * opacity;
      allBodyMaterial.depthWrite = !see;
      allBodyMaterial.side = see ? DoubleSide : FrontSide;
      allBodyMaterial.needsUpdate = true;
    }
    this.applyAnalysis();
    this.applyHidden();
  }

  /** Select Through (Ctrl+Shift+S): picking ignores the faces in front. */
  selectThrough = false;

  setSelectThrough(on: boolean): void {
    this.selectThrough = on;
    this.applySettings();
  }

  /** Zebra stripes / curvature map (Display modes): every body wears it while on. */
  private anaMat: ReturnType<typeof analysisMaterial> | null = null;

  private applyAnalysis(): void {
    const value = settings.value;
    // A 2D section's lines are light (on the dark background), a 3D model's dark (on its grey faces).
    this.edgeMat.color.set(this.sectionStyle === 'flat' && this.clip ? 0xd8dbe2 : COLORS.edge);
    if (this.sectionStyle === 'flat' && this.clip) {
      const material = (this.flatMat ??= new MeshBasicMaterial({ color: (this.scene.background as Color).clone(), polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 }));
      material.clippingPlanes = [this.clip];
      material.needsUpdate = true;
      for (const b of this.bodies.values()) {
        b.mesh.material = material;
      }
      this.dirty = true;

      return;
    }
    if (value.analysis === 'none') {
      for (const [id, b] of this.bodies) {
        if (b.mesh.material === this.anaMat || b.mesh.material === this.flatMat) {
          b.mesh.material = this.matsFor(id).body;
        }
      }

      return;
    }
    const shader = (this.anaMat ??= analysisMaterial());
    shader.uniforms.uKind.value = value.analysis === 'zebra' ? 0 : 1;
    shader.uniforms.uStripes.value = value.zebraStripes;
    shader.uniforms.uHorizontal.value = value.zebraDirection === 'horizontal' ? 1 : 0;
    shader.uniforms.uScale.value = 1 / Math.max(value.curvatureRadius, 1e-3);
    shader.clippingPlanes = this.clip ? [this.clip] : [];
    shader.needsUpdate = true;
    for (const b of this.bodies.values()) {
      const geometry = b.mesh.geometry;
      if (!geometry.getAttribute('curv')) {
        geometry.setAttribute('curv', new BufferAttribute(curvatureOf(b.data.positions, b.data.normals, b.data.indices), 1));
      }
      b.mesh.material = shader;
    }
    this.dirty = true;
  }

  // ---------------------------------------------------------------- bodies

  private openMats: LineMaterial[] = [];

  /** Body colour → its surface and section-cap materials (copies of the shared ones). */
  private colorMats = new Map<string, { body: MeshStandardMaterial; cap: MeshBasicMaterial }>();
  private bodyColors: Record<string, string> = {};
  private bodyOpacity: Record<string, number> = {};

  private matsFor(id: string): { body: MeshStandardMaterial; cap: MeshBasicMaterial } {
    const hex = bodyColor(this.bodyColors[id]);
    const opacity = this.bodyOpacity[id] ?? 1;
    if (!hex && opacity >= 1) {
      return { body: this.bodyMat, cap: this.capMat };
    }
    const key = `${hex ?? 'base'}|${opacity}`;
    let colorMaterial = this.colorMats.get(key);
    if (!colorMaterial) {
      const body = this.bodyMat.clone();
      if (hex) {
        body.color.set(hex);
      }
      body.userData.opacity = opacity;
      // The cut face is the same for every body, whatever its colour: pink with its dark diagonal lines - a cut
      // reads as a cut. (It was the body's colour, a little darker.)
      colorMaterial = { body, cap: this.capMat };
      this.colorMats.set(key, colorMaterial);
    }

    return colorMaterial;
  }

  /** Every body surface material (shared + coloured), for settings that apply to all. */
  private allBodyMats(): MeshStandardMaterial[] {
    return [this.bodyMat, ...[...this.colorMats.values()].map(colorMaterial => colorMaterial.body)];
  }

  private ghost = false;

  /** Bodies a little see-through (while sizing a new solid, so its sketch shows through). */
  setGhost(on: boolean): void {
    if (this.ghost === on) {
      return;
    }
    this.ghost = on;
    this.applySettings();
    this.requestRender();
  }

  setBodyColors(colors: Record<string, string>, opacity: Record<string, number> = {}): void {
    this.bodyColors = { ...colors };
    this.bodyOpacity = { ...opacity };
    for (const [id, b] of this.bodies) {
      const materials = this.matsFor(id);
      b.mesh.material = materials.body;
      b.cap.material = materials.cap;
    }
    this.applyClip();
    this.applySettings();
  }

  setBodies(meshes: BodyMesh[]): void {
    // A body the step didn't change (same mesh key): what was drawn for it stays
    // (its triangles went to the graphics card once, not again on every rebuild).
    const was = new Map(this.bodies);
    const keep = new Set(meshes.filter(mesh => was.get(mesh.id)?.data.key === mesh.key).map(mesh => mesh.id));
    for (const [id, b] of was) {
      b.outline?.geometry.dispose();
      b.outline = null;
      if (keep.has(id)) {
        continue;
      }
      b.mesh.geometry.dispose();
      b.edges.geometry.dispose();
    }
    this.openMats.forEach(openMaterial => this.releaseLineMaterial(openMaterial));
    this.openMats = [];
    this.bodies.clear();
    this.bodiesGroup.clear();
    this.capGroup.clear();
    for (const data of meshes) {
      const old = keep.has(data.id) ? was.get(data.id) : undefined;
      if (old) {
        const i = this.bodies.size;
        old.data = data;
        old.mesh.material = this.matsFor(data.id).body;
        old.cap.material = this.matsFor(data.id).cap;
        old.capStencil.forEach(sm => (sm.renderOrder = 10 + 3 * i));
        old.cap.renderOrder = 11 + 3 * i;
        this.bodiesGroup.add(old.mesh, old.edges, old.hidden);
        this.capGroup.add(old.cap, ...old.capStencil);
        this.bodies.set(data.id, old);
        this.addOpenEdges(data);
        continue;
      }
      const geometry = new BufferGeometry();
      geometry.setAttribute('position', new BufferAttribute(data.positions, 3));
      geometry.setAttribute('normal', new BufferAttribute(data.normals, 3));
      geometry.setIndex(new BufferAttribute(data.indices, 1));
      geometry.computeBoundingSphere();
      const mats = this.matsFor(data.id);
      const mesh = new Mesh(geometry, mats.body);
      mesh.userData.body = data.id;
      const i = this.bodies.size;
      const capStencil = this.stencilMats.map((stencilMaterial) => {
        const sm = new Mesh(geometry, stencilMaterial);
        sm.renderOrder = 10 + 3 * i;

        return sm;
      });
      const cap = new Mesh(this.capPlaneGeo, mats.cap);
      cap.renderOrder = 11 + 3 * i;
      // Each body's cap clears the marks after it: the next body starts afresh.
      cap.onAfterRender = renderer => renderer.clearStencil();
      const eg = new BufferGeometry();
      eg.setAttribute('position', new BufferAttribute(data.edgePositions, 3));
      const edges = new LineSegments(eg, this.edgeMat);
      const hidden = new LineSegments(eg, this.hiddenMat);
      hidden.computeLineDistances();
      hidden.renderOrder = 5;
      this.bodiesGroup.add(mesh, edges, hidden);
      this.capGroup.add(cap, ...capStencil);
      const vertices = uniqueEnds(data.edges);
      this.bodies.set(data.id, { data, mesh, cap, capStencil, outline: null, edges, hidden, vertices });
      this.addOpenEdges(data);
    }
    this.applyClip();
    this.applySettings();
    this.applyHidden();
    this.applyPoses();
  }

  /** Assemblies: each body's move from where it was modelled (a 4 x 4, column by column); none: all at home. */
  private poses: Map<string, number[]> | null = null;

  /**
   * Bodies shown moved - an assembly's parts at their joints' values, or pulled apart - without the model being
   * made again: what is drawn of each (its faces, its edges) is put through its move. Null: all where they were
   * modelled. Picks of faces and bodies go by what is drawn; edges, vertices and what is lit do not (they are
   * where the model has them), so a tool that shows bodies moved picks by `facesAt`.
   */
  setPoses(poses: Map<string, number[]> | null): void {
    // (Only the bodies that are moved: one whose move is none is as it was modelled.)
    const still = (matrix: number[]) => matrix.every((value, i) => Math.abs(value - (i % 5 === 0 ? 1 : 0)) < 1e-12);
    const moved = poses ? new Map([...poses].filter(([, matrix]) => !still(matrix))) : null;
    if (!this.poses && !moved?.size) {
      return;
    }
    this.poses = moved?.size ? moved : null;
    this.applyPoses();
    this.requestRender();
  }

  private applyPoses(): void {
    for (const [id, b] of this.bodies) {
      const pose = this.poses?.get(id);
      for (const mesh of [b.mesh, b.edges, b.hidden, ...b.capStencil]) {
        if (!pose && mesh.matrixAutoUpdate) {
          continue;
        }
        if (pose) {
          mesh.matrixAutoUpdate = false;
          mesh.matrix.fromArray(pose);
        } else {
          mesh.matrix.identity();
          mesh.matrixAutoUpdate = true;
        }
        mesh.matrixWorldNeedsUpdate = true;
      }
    }
  }

  /** Open (non-watertight) edges stand out in orange. */
  private addOpenEdges(data: BodyMesh): void {
    if (!data.openEdges?.length) {
      return;
    }
    const seg: number[] = [];
    for (const i of data.openEdges) {
      const edgeGroup = data.edgeGroups.find(edgeGroup => edgeGroup.edge === i);
      if (edgeGroup) {
        seg.push(...Array.from(data.edgePositions.slice(edgeGroup.start * 3, (edgeGroup.start + edgeGroup.count) * 3)));
      }
    }
    if (!seg.length) {
      return;
    }
    const mat = this.lineMaterial(0xff9a3d, 3, true);
    this.openMats.push(mat);
    const lines = new LineSegments2(new LineSegmentsGeometry().setPositions(seg), mat);
    lines.renderOrder = 3;
    this.bodiesGroup.add(lines);
  }

  // ------------------------------------------------------- hidden/isolate

  private hiddenIds = new Set<string>();

  /** Bodies hidden from Items or by Isolate: not drawn, not pickable. */
  setHidden(ids: Iterable<string>): void {
    this.hiddenIds = new Set(ids);
    this.applyHidden();
  }

  isHidden(id: string): boolean {
    return this.hiddenIds.has(id);
  }

  private applyHidden(): void {
    for (const [id, b] of this.bodies) {
      const vis = !this.hiddenIds.has(id);
      // Section only: the cut faces alone (and their outline), the rest of the model gone.
      const only = this.sectionStyle === 'only' && !!this.clip;
      b.mesh.visible = vis && settings.value.shader !== 'wireframe' && !only;
      b.cap.visible = vis && !!this.clip && (settings.value.shader === 'shaded' || only);
      for (const sm of b.capStencil) {
        sm.visible = b.cap.visible;
      }
      if (b.outline) {
        b.outline.visible = vis && !!this.clip;
      }
      b.edges.visible = vis && !only && (settings.value.showEdges || settings.value.shader === 'wireframe' || this.sectionStyle === 'flat');
      b.hidden.visible = vis && !only && (settings.value.showHiddenEdges || settings.value.shader === 'wireframe');
    }
    this.dirty = true;
  }

  /** How a section shows: the model cut (normal), the cut faces alone (only), or flat like a drawing, the edges beyond it drawn (flat). */
  private sectionStyle: 'normal' | 'only' | 'flat' = 'normal';

  setSectionStyle(style: 'normal' | 'only' | 'flat'): void {
    if (this.sectionStyle === style) {
      return;
    }
    this.sectionStyle = style;
    this.applySettings();
  }

  /** The bodies' faces in a 2D section: the background's colour, unlit (they only hide the edges behind). */
  private flatMat: MeshBasicMaterial | null = null;

  private visibleBodies(): BodyView[] {
    return [...this.bodies.entries()].filter(([id]) => !this.hiddenIds.has(id)).map(([, b]) => b);
  }

  vertexOf(body: string, i: number): Vec3 | undefined {
    return this.bodies.get(body)?.vertices[i]?.toArray() as Vec3 | undefined;
  }

  body(id: string): BodyMesh | undefined {
    return this.bodies.get(id)?.data;
  }

  get bodyList(): BodyMesh[] {
    return [...this.bodies.values()].map(b => b.data);
  }

  /**
   * A picture of everything shown, fitted into a width × height frame, seen from the
   * way the view looks now (for the project library). The view itself doesn't move.
   */
  snapshot(width: number, height: number, background: string): string | undefined {
    const canvasWidth = this.canvas.width, canvasHeight = this.canvas.height;
    if (!canvasWidth || !canvasHeight) {
      return undefined;
    }
    // The middle of the canvas with the frame's shape: the model is fitted into that.
    const scale = Math.min(canvasWidth / width, canvasHeight / height);
    const [cw, ch] = [width * scale, height * scale];
    const side = (1 - cw / canvasWidth) / 2, top = (1 - ch / canvasHeight) / 2;
    const out = document.createElement('canvas');
    out.width = width;
    out.height = height;
    const context = out.getContext('2d')!;
    // The view is see-through (the page shows behind it); a JPEG would turn that black.
    context.fillStyle = background;
    context.fillRect(0, 0, width, height);
    this.cam.borrow(() => {
      this.cam.fit(this.bounds(), false, { left: side, right: side, top, bottom: top });
      this.render();
      context.drawImage(this.canvas, (canvasWidth - cw) / 2, (canvasHeight - ch) / 2, cw, ch, 0, 0, width, height);
    });
    // Drawn again as it was.
    this.render();

    return out.toDataURL('image/jpeg', 0.75);
  }

  /** Zoom to fit everything shown, in the part of the screen the tools leave free. */
  fitAll(animate = true): void {
    this.cam.fit(this.bounds(), animate, this.coveredInsets());
  }

  /** Zoom to one face (Space over it): the face filling the free part of the screen. */
  zoomToFace(body: string, face: number): boolean {
    const bodyMesh = this.body(body);
    if (!bodyMesh) {
      return false;
    }
    const box = new Box3();
    const vector = new Vector3();
    for (const faceGroup of bodyMesh.faceGroups) {
      if (faceGroup.face === face) {
        for (let i = faceGroup.start; i < faceGroup.start + faceGroup.count; i++) {
          box.expandByPoint(vector.fromArray(bodyMesh.positions, bodyMesh.indices[i] * 3));
        }
      }
    }
    if (box.isEmpty()) {
      return false;
    }
    this.cam.fit(box, true, this.coveredInsets());

    return true;
  }

  /**
   * Bring what a tool is working on (its highlighted picks, else everything)
   * into the free part of the screen - only when some of it is outside it,
   * and never zooming in.
   */
  keepInView(): void {
    const box = new Box3();
    this.highlightGroup.traverse((object) => {
      const b = new Box3().expandByObject(object, true);
      if (!b.isEmpty() && [b.min.x, b.min.y, b.min.z, b.max.x, b.max.y, b.max.z].every(value => Number.isFinite(value) && Math.abs(value) < 1e8)) {
        box.union(b);
      }
    });
    if (box.isEmpty()) {
      box.copy(this.bounds());
    }
    if (box.isEmpty()) {
      return;
    }
    const ins = this.coveredInsets();
    const width = this.width, height = this.height;
    const inside = [0, 1, 2, 3, 4, 5, 6, 7].every((i) => {
      const screenPoint = this.toScreen(new Vector3(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z));

      return !!screenPoint && screenPoint[0] >= ins.left * width && screenPoint[0] <= (1 - ins.right) * width && screenPoint[1] >= ins.top * height && screenPoint[1] <= (1 - ins.bottom) * height;
    });
    if (!inside) {
      this.cam.fit(box, true, ins, true);
    }
  }

  /**
   * How much of each side of the canvas the tool columns and bars cover: a
   * column hugging the left or right edge, a bar along the top or bottom.
   * Panels that cover most of the screen (History on a phone) don't count -
   * the model would have nowhere left to go.
   */
  coveredInsets(): Insets {
    const width = this.width, height = this.height;
    const cv = this.canvas.getBoundingClientRect();
    const ins = { left: 0, right: 0, top: 0, bottom: 0 };
    if (!width || !height) {
      return ins;
    }
    const cols: DOMRect[] = [];
    for (const id of ['topbar', 'toolbar', 'right-col', 'undo-dock', 'bottom-left', 'panel', 'items', 'history']) {
      const el = document.getElementById(id);
      // (Not offsetParent: it is null for fixed-position bars, which these are.)
      if (!el || el.hidden || !el.getClientRects().length || getComputedStyle(el).visibility === 'hidden') {
        continue;
      }
      const rect = el.getBoundingClientRect();
      if (rect.width < 4 || rect.height < 4) {
        continue;
      }
      const t = rect.top - cv.top, b = cv.bottom - rect.bottom;
      // A column: clearly taller than wide (a tablet's tool menu is under a quarter of the height).
      const wide = rect.width > width * 0.5, tall = rect.height > Math.min(height * 0.25, rect.width * 1.8);
      // A panel over most of the screen (History on a phone): nowhere left to put the model - ignored.
      if (wide && rect.height > height * 0.6) {
        continue;
      }
      if (tall && !wide) {
        cols.push(rect);
      } else if (t < height * 0.2 && (wide || rect.height < height * 0.12)) {
        // Bars: wide along the top or bottom (a phone's tool card can be tall as well as wide).
        ins.top = Math.max(ins.top, (rect.bottom - cv.top) / height);
      } else if (b < height * 0.2 && wide) {
        ins.bottom = Math.max(ins.bottom, (cv.bottom - rect.top) / height);
      }
    }
    // Columns from each edge inwards, side by side: Items, then the tool column
    // just right of it (a phone on its side) all count as the left side.
    let lpx = 0, rpx = 0;
    for (const column of [...cols].sort((a, b) => a.left - b.left)) {
      if (column.left - cv.left <= Math.max(width * 0.04, lpx + 24) && column.right - cv.left < width * 0.65) {
        lpx = Math.max(lpx, column.right - cv.left);
      }
    }
    for (const column of [...cols].sort((a, b) => b.right - a.right)) {
      if (cv.right - column.right <= Math.max(width * 0.04, rpx + 24) && cv.right - column.left < width * 0.65) {
        rpx = Math.max(rpx, cv.right - column.left);
      }
    }
    ins.left = lpx / width;
    ins.right = rpx / width;
    // Never squeeze the model into less than a third of the screen either way
    // (a tablet held upright with Items and the tool menu open leaves ~40 %).
    const cap = (a: number, b: number) => (a + b > 0.65 ? [(a * 0.65) / (a + b), (b * 0.65) / (a + b)] : [a, b]);
    [ins.left, ins.right] = cap(ins.left, ins.right);
    [ins.top, ins.bottom] = cap(ins.top, ins.bottom);

    return ins;
  }

  bounds(): Box3 {
    const box = new Box3();
    // Each part on its own, so one broken piece (NaN) can't spoil the whole fit.
    const add = (object: Object3D) => {
      const b = new Box3().expandByObject(object);
      if (!b.isEmpty() && [b.min.x, b.min.y, b.min.z, b.max.x, b.max.y, b.max.z].every(value => Number.isFinite(value) && Math.abs(value) < 1e8)) {
        box.union(b);
      }
    };
    for (const b of this.visibleBodies()) {
      add(b.mesh);
    }
    this.sketchGroup.children.forEach(add);
    // Shapes a tool is still making (a freeform cage) count too: Fit framed an empty scene.
    this.overlay.children.forEach(child => child.userData.fit && child.visible && add(child));
    this.imageMeshes.forEach(imageMesh => imageMesh.visible && add(imageMesh));

    return box;
  }

  // --------------------------------------------------------------- section

  /** Cut the view with a plane (keeps the side the normal points away from). */
  setSection(plane: PlaneDef | null): void {
    this.clip = plane ? new Plane().setFromNormalAndCoplanarPoint(new Vector3(...plane.normal).negate(), new Vector3(...plane.origin)) : null;
    this.applyClip();
    this.applySettings();
  }

  private applyClip(): void {
    const planes = this.clip ? [this.clip] : [];
    // (The caps lie on the cut itself: never clipped.)
    for (const material of [this.bodyMat, this.edgeMat, this.hiddenMat, ...this.stencilMats, ...[...this.colorMats.values()].map(colorMaterial => colorMaterial.body)]) {
      material.clippingPlanes = planes;
      material.needsUpdate = true;
    }
    this.placeCaps();
    this.dirty = true;
  }

  private outlineMat: LineMaterial | null = null;

  /** Each cap plane onto the cut (big enough to cover its body), and the cut's outline. */
  private placeCaps(): void {
    const clip = this.clip;
    for (const b of this.bodies.values()) {
      if (b.outline) {
        this.capGroup.remove(b.outline);
        b.outline.geometry.dispose();
        b.outline = null;
      }
      if (!clip) {
        continue;
      }
      const geometry = b.mesh.geometry;
      if (!geometry.boundingSphere) {
        geometry.computeBoundingSphere();
      }
      const sph = geometry.boundingSphere!;
      b.cap.position.copy(clip.projectPoint(sph.center, new Vector3()));
      b.cap.quaternion.setFromUnitVectors(new Vector3(0, 0, 1), clip.normal);
      b.cap.scale.setScalar(sph.radius * 2.2 + 1);
      b.cap.updateMatrixWorld();
      // The outline: where the cut crosses each triangle.
      const pos = geometry.getAttribute('position').array as ArrayLike<number>;
      const idx = geometry.getIndex()!.array as ArrayLike<number>;
      const normal = clip.normal;
      const constant = clip.constant;
      const dist = (i: number) => normal.x * pos[3 * i] + normal.y * pos[3 * i + 1] + normal.z * pos[3 * i + 2] + constant;
      const seg: number[] = [];
      for (let t = 0; t < idx.length; t += 3) {
        const triangle = [idx[t], idx[t + 1], idx[t + 2]];
        const sd = triangle.map(dist);
        if ((sd[0] > 0 && sd[1] > 0 && sd[2] > 0) || (sd[0] < 0 && sd[1] < 0 && sd[2] < 0)) {
          continue;
        }
        const pts: number[] = [];
        for (let e = 0; e < 3; e++) {
          const a = triangle[e];
          const nextVertex = triangle[(e + 1) % 3];
          const sa = sd[e];
          const sc = sd[(e + 1) % 3];
          if (sa < 0 === sc < 0 || sa === sc) {
            continue;
          }
          const fraction = sa / (sa - sc);
          pts.push(pos[3 * a] + (pos[3 * nextVertex] - pos[3 * a]) * fraction, pos[3 * a + 1] + (pos[3 * nextVertex + 1] - pos[3 * a + 1]) * fraction, pos[3 * a + 2] + (pos[3 * nextVertex + 2] - pos[3 * a + 2]) * fraction);
        }
        if (pts.length === 6) {
          seg.push(...pts);
        }
      }
      if (!seg.length) {
        continue;
      }
      const lg = new LineSegmentsGeometry();
      lg.setPositions(seg);
      this.outlineMat ??= this.lineMaterial(COLORS.edge, 3, true);
      const line = new LineSegments2(lg, this.outlineMat);
      line.renderOrder = 1000;
      line.visible = !this.hiddenIds.has(b.data.id);
      this.capGroup.add(line);
      b.outline = line;
    }
  }

  // -------------------------------------------------------------- sketches

  private sketchMats: LineMaterial[] = [];
  private sketchPoints: { sketch: string; entity: string; p: string; pos: Vector3 }[] = [];

  setSketches(sketches: SketchView[], activeId?: string, fresh: ReadonlySet<string> = new Set()): void {
    this.sketches = sketches;
    this.activeSketch = activeId;
    this.freshSketches = fresh;
    this.sketchGroup.traverse((object) => {
      if (object instanceof Mesh || object instanceof Line || object instanceof LineSegments2 || object instanceof Points) {
        object.geometry.dispose();
      }
    });
    this.sketchGroup.clear();
    this.sketchMats.forEach(sketchMaterial => this.releaseLineMaterial(sketchMaterial));
    this.sketchMats = [];
    this.profileMeshes = [];
    this.curveLines = [];
    this.sketchPoints = [];
    const wpp = this.cam.worldPerPixel(this.height);
    for (const sketch of sketches) {
      // (A sketch saved without a plane - a damaged file: left out, not the whole drawing stopped.)
      if (!sketch.plane) {
        continue;
      }
      const active = sketch.id === activeId;
      // Not made into anything yet: drawn on top of bodies, so one inside a body still shows.
      const onTop = active || fresh.has(sketch.id);
      const matrix = planeMatrix(sketch.plane, this.cam.distance * 1e-5);
      // Clean 2px lines; the sketch being edited is brighter and on top.
      // (Each drawn with the see-through things, after the world's axes: a line along an axis is the line's colour.)
      const solid: number[] = [];
      const dashed: number[] = [];
      // Curves that follow a body's edge: in their own colour (they aren't the sketch's to move).
      const linked: number[] = [];
      // In the sketch being edited, curves its constraints hold completely: green.
      const held: number[] = [];
      // Offsets of the face's edge (linked to it): drawn and tapped like the sketch's own curves.
      for (const e of [...sketch.entities, ...(sketch.boundary ?? []).filter(b => b.id.startsWith('lnk-'))]) {
        // (A spline with points off the plane runs through space: drawn, picked and snapped to where it is.)
        const high = splineHeightSamples(e);
        const lift = splineHeights(e);
        for (const poly of entityPolylines(e)) {
          const pts = poly.map((point, i) => new Vector3(point[0], point[1], high ? (high[Math.min(i, high.length - 1)] ?? 0) : 0).applyMatrix4(matrix));
          const into = e.construction ? dashed : e.id.startsWith('ref-') ? linked : active && sketch.defined?.has(e.id) ? held : solid;
          for (let i = 0; i < pts.length - 1; i++) {
            into.push(...pts[i].toArray(), ...pts[i + 1].toArray());
          }
          this.curveLines.push({ sketch: sketch.id, entity: e.id, pts });
        }
        if (active) {
          const all = pointsOf(e);
          // (A spline not picked: its two ends - none for a closed one. Picked: every point it is shaped by.)
          const shown = e.kind === 'spline' && all.length > 2 && !this.openCurves.has(e.id) ? (e.closed ? [] : [all[0], all[all.length - 1]]) : all;
          for (const q of shown) {
            this.sketchPoints.push({ sketch: sketch.id, entity: e.id, p: q.p, pos: new Vector3(q.at[0], q.at[1], lift && q.p.startsWith('k') ? (lift[Number(q.p.slice(1))] ?? 0) : 0).applyMatrix4(matrix) });
          }
        }
      }
      if (solid.length) {
        const mat = this.lineMaterial(active ? 0xffffff : COLORS.sketch, active ? 2.2 : 1.6, !onTop);
        mat.transparent = true;
        this.sketchMats.push(mat);
        const lines = new LineSegments2(new LineSegmentsGeometry().setPositions(solid), mat);
        lines.renderOrder = 2;
        this.sketchGroup.add(lines);
      }
      if (held.length) {
        const mat = this.lineMaterial(0x5fd38a, 2.2, !onTop);
        mat.transparent = true;
        this.sketchMats.push(mat);
        const lines = new LineSegments2(new LineSegmentsGeometry().setPositions(held), mat);
        lines.renderOrder = 2;
        this.sketchGroup.add(lines);
      }
      if (linked.length) {
        const mat = this.lineMaterial(COLORS.linked, active ? 2.2 : 1.6, !onTop);
        mat.transparent = true;
        this.sketchMats.push(mat);
        const lines = new LineSegments2(new LineSegmentsGeometry().setPositions(linked), mat);
        lines.renderOrder = 2;
        this.sketchGroup.add(lines);
      }
      if (dashed.length) {
        // As wide as the sketch's other lines (asked for: "should be more visible, like the normal line"): told
        // from them by its dashes and its colour, not by being faint.
        const mat = this.lineMaterial(COLORS.construction, active ? 2.2 : 1.6, !onTop);
        mat.transparent = true;
        mat.dashed = true;
        mat.dashSize = wpp * 9;
        mat.gapSize = wpp * 5;
        this.sketchMats.push(mat);
        const lines = new LineSegments2(new LineSegmentsGeometry().setPositions(dashed), mat);
        lines.computeLineDistances();
        lines.renderOrder = 2;
        this.sketchGroup.add(lines);
      }
      if (active && this.sketchPoints.length) {
        const dots = new Points(new BufferGeometry().setFromPoints(this.sketchPoints.map(q => q.pos)), dotMaterial({ color: 0xffffff, size: 8 }));
        dots.renderOrder = 4;
        this.sketchGroup.add(dots);
      }
      const fillMat = new MeshBasicMaterial({
        color: COLORS.profile,
        transparent: true,
        opacity: active ? 0.16 : 0.1,
        side: DoubleSide,
        depthWrite: false,
        depthTest: !fresh.has(sketch.id) || active,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2
      });
      // Regions include the face outline, so a line across a face splits it in two.
      for (const region of arrangement([...sketch.entities, ...(sketch.boundary ?? [])]).regions) {
        const shape = new Shape(region.outer.poly.map(point => new Vector2(point[0], point[1])));
        for (const hole of region.holes) {
          shape.holes.push(new Path(hole.poly.map(point => new Vector2(point[0], point[1]))));
        }
        const fill = new Mesh(new ShapeGeometry(shape), fillMat);
        fill.applyMatrix4(matrix);
        fill.userData = { sketch: sketch.id, region: region.index, area: region.area, fresh: fresh.has(sketch.id) };
        fill.renderOrder = 1;
        this.sketchGroup.add(fill);
        this.profileMeshes.push(fill);
      }
    }
    this.dirty = true;
  }

  // ------------------------------------------------ construction + images

  setConstruction(planes: ConstructionInfo[], axes: ConstructionInfo[]): void {
    this.construction = { planes, axes };
    this.rebuildPlanes();
  }

  /** Show the XY/XZ/YZ origin planes as pickable squares (sketch/section pick). */
  setOriginPlanesVisible(on: boolean): void {
    this.showOriginPlanes = on;
    this.rebuildPlanes();
  }

  private rebuildPlanes(): void {
    this.constructionGroup.traverse((object) => {
      if (object instanceof Mesh || object instanceof Line) {
        object.geometry.dispose();
      }
    });
    this.constructionGroup.clear();
    this.planeMeshes = [];
    this.axisLines = [];
    // Origin planes (shown only while picking a plane) draw through bodies so they can always be picked.
    const mat = (color: number, opacity: number, onTop: boolean) => new MeshBasicMaterial({ color, transparent: true, opacity: opacity, side: DoubleSide, depthWrite: false, depthTest: !onTop });
    // Origin planes take the colour of the axis they face: XY blue (Z), XZ green (Y), YZ red (X).
    const AXIS_TINT: Record<string, number> = { XY: 0x4f8ce0, XZ: 0x5fbf5a, YZ: 0xe0584f };
    const kindOf = (id: string) => this.construction.planes.find(plane => plane.id === id)?.kind ?? 'offset';
    const addPlane = (id: string, plane: PlaneDef, size: number, origin: boolean) => {
      const color = origin ? (AXIS_TINT[id] ?? COLORS.plane) : COLORS.plane;
      const mesh = new Mesh(new PlaneGeometry(1, 1), mat(color, origin ? 0.35 : 0.16, origin));
      mesh.userData = { plane: id, origin, size };
      mesh.matrixAutoUpdate = false;
      mesh.matrix.copy(planeMatrix(plane).multiply(new Matrix4().makeScale(size, size, 1)));
      // Origin planes (shown only while choosing where to sketch) draw over everything, highlights included.
      mesh.renderOrder = origin ? 60 : 3;
      const border = new LineSegments(
        new BufferGeometry().setFromPoints([[-0.5, -0.5], [0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [0.5, 0.5], [-0.5, 0.5], [-0.5, 0.5], [-0.5, -0.5]].map(([x, y]) => new Vector3(x, y, 0))),
        new LineBasicMaterial({ color, transparent: true, opacity: 0.8, depthTest: !origin })
      );
      border.renderOrder = mesh.renderOrder;
      mesh.add(border);
      // How it was made, at its corner: each kind of plane has its own mark.
      if (!origin) {
        const mark = new Sprite(planeMarkMaterial(kindOf(id)));
        // Small, in the plane's corner: it grows and shrinks with the zoom like the plane.
        mark.position.set(-0.48, 0.48, 0);
        mark.scale.set(PLANE_MARK_SIZE, PLANE_MARK_SIZE, 1);
        mark.renderOrder = 4;
        mesh.add(mark);
      }
      this.constructionGroup.add(mesh);
      this.planeMeshes.push(mesh);
    };
    if (this.showOriginPlanes) {
      for (const [id, plane] of Object.entries(ORIGIN_PLANES)) {
        addPlane(id, plane, 1, true);
      }
    }
    for (const plane of this.construction.planes) {
      addPlane(plane.id, plane.plane, 1, false);
    }
    for (const a of this.construction.axes) {
      const vector = new Vector3(...a.plane.origin);
      const direction = new Vector3(...a.plane.normal);
      const reach = 1e4;
      const geo = new BufferGeometry().setFromPoints([vector.clone().addScaledVector(direction, -reach), vector.clone().addScaledVector(direction, reach)]);
      const line = new Line(geo, new LineDashedMaterial({ color: 0xffb454, dashSize: 4, gapSize: 3 }));
      line.computeLineDistances();
      this.constructionGroup.add(line);
      this.axisLines.push({ id: a.id, a: vector.clone().addScaledVector(direction, -reach), b: vector.clone().addScaledVector(direction, reach) });
    }
    this.dirty = true;
  }

  private planeSizes = new Map<string, number>();
  private planeCentres = new Map<string, Vec3>();

  /** History hover: what a step works on, as dashed lines seen through everything. */
  private stepGroup = new Group();

  setStepHover(t: { bodies: string[]; lines: Vec3[][] } | null): void {
    this.stepGroup.traverse((object) => {
      if (object instanceof LineSegments || object instanceof Line) {
        object.geometry.dispose();
        (object.material as LineDashedMaterial).dispose();
      }
    });
    this.stepGroup.clear();
    if (t) {
      if (!this.stepGroup.parent) {
        this.scene.add(this.stepGroup);
      }
      const wpp = this.cam.worldPerPixel(this.height);
      const mat = () => new LineDashedMaterial({ color: 0xffa31a, dashSize: wpp * 7, gapSize: wpp * 5, depthTest: false, transparent: true });
      for (const id of t.bodies) {
        const b = this.bodies.get(id);
        if (!b) {
          continue;
        }
        const geo = new BufferGeometry();
        geo.setAttribute('position', new BufferAttribute(b.data.edgePositions, 3));
        const ls = new LineSegments(geo, mat());
        ls.computeLineDistances();
        ls.renderOrder = 40;
        this.stepGroup.add(ls);
      }
      for (const pl of t.lines) {
        if (pl.length < 2) {
          continue;
        }
        const ln = new Line(new BufferGeometry().setFromPoints(pl.map(point => new Vector3(...point))), mat());
        ln.computeLineDistances();
        ln.renderOrder = 40;
        this.stepGroup.add(ln);
      }
    }
    this.requestRender();
  }

  /**
   * On-screen helpers that are alive (handles, gimbals, value boxes, copy
   * toggles). Back in plain selection, any the selection doesn't own are
   * leftovers and get cleared (no ghost arrows or dots).
   */
  readonly helpers = new Set<{ dispose(): void }>();

  clearHelpers(keep: Iterable<unknown>): void {
    const kept = new Set(keep);
    for (const helper of [...this.helpers]) {
      if (!kept.has(helper)) {
        helper.dispose();
      }
    }
  }

  /** Origin planes stay ~90 px on screen; construction planes keep their first size. */
  private layoutOriginPlanes(): void {
    const wpp = this.cam.worldPerPixel(this.height);
    for (const planeMesh of this.planeMeshes) {
      const id = planeMesh.userData.plane as string;
      const plane = ORIGIN_PLANES[id] ?? this.construction.planes.find(constructionInfo => constructionInfo.id === id)?.plane;
      if (!plane) {
        continue;
      }
      // A construction plane keeps the size it was first shown at: it doesn't
      // grow and shrink while the model is edited.
      // Origin planes: big enough to hit easily (fingers, headsets), even with a body in front.
      let size = planeMesh.userData.origin ? wpp * 120 : this.planeSizes.get(id);
      let mid = planeMesh.userData.origin ? undefined : this.planeCentres.get(id);
      if (size === undefined || (!planeMesh.userData.origin && mid === undefined)) {
        const box = this.bounds();
        size = Math.max(wpp * 160, box.getSize(new Vector3()).length() * 0.6);
        this.planeSizes.set(id, size);
        mid = box.isEmpty() ? plane.origin : (box.getCenter(new Vector3()).toArray() as Vec3);
        this.planeCentres.set(id, mid);
      }
      // Centred where the middle of the model (as it was) falls on the plane - a
      // plane 92 mm across through a lamp shade 150 mm up was drawn around the
      // floor below it. (Projected each time: the plane may have moved since.)
      let at = plane.origin;
      if (mid) {
        const normal = new Vector3(...plane.normal).normalize();
        const vector = new Vector3(...mid);
        at = vector.addScaledVector(normal, -vector.clone().sub(new Vector3(...plane.origin)).dot(normal)).toArray() as Vec3;
      }
      // Origin planes sit in their quadrant (like a corner), the rest are centred.
      const off = planeMesh.userData.origin ? size / 2 : 0;
      const mm = planeMatrix({ ...plane, origin: at }).multiply(new Matrix4().makeTranslation(off, off, 0)).multiply(new Matrix4().makeScale(size, size, 1));
      planeMesh.matrix.copy(mm);
      planeMesh.matrixWorldNeedsUpdate = true;
    }
  }

  planeOf(id: string): PlaneDef | undefined {
    return ORIGIN_PLANES[id] ?? this.construction.planes.find(plane => plane.id === id)?.plane;
  }

  /** The middle of a construction plane's square as drawn (on the plane). */
  planeShownAt(id: string): Vec3 | undefined {
    const plane = this.planeOf(id);
    if (!plane) {
      return undefined;
    }
    const mid = this.planeCentres.get(id);
    if (!mid || ORIGIN_PLANES[id]) {
      return plane.origin;
    }
    const normal = new Vector3(...plane.normal).normalize();
    const vector = new Vector3(...mid);

    return vector.addScaledVector(normal, -vector.clone().sub(new Vector3(...plane.origin)).dot(normal)).toArray() as Vec3;
  }

  /** A moved (or copied) plane's square goes with it - the size of the one it came from. */
  showPlaneAt(id: string, at: Vec3, like = id): void {
    this.planeCentres.set(id, at);
    const planeSize = this.planeSizes.get(like);
    if (planeSize !== undefined) {
      this.planeSizes.set(id, planeSize);
    }
    this.requestRender();
  }

  axisOf(id: string): ConstructionInfo | undefined {
    const axisDirection = WORLD_AXIS_DIRS[id];
    if (axisDirection) {
      return { id, name: `${id} axis`, plane: { origin: [0, 0, 0], normal: axisDirection, xDir: axisDirection[2] ? [1, 0, 0] : [0, 0, 1] } };
    }

    return this.construction.axes.find(a => a.id === id);
  }

  /** A world axis as a segment long enough to cover the view. */
  private worldAxisLine(id: string): { id: string; a: Vector3; b: Vector3 } | null {
    const axisDirection = WORLD_AXIS_DIRS[id];
    if (!axisDirection || !settings.value.showAxes) {
      return null;
    }
    const reach = Math.max(this.cam.distance * 4, 100);
    const vector = new Vector3(...axisDirection);

    return { id, a: vector.clone().multiplyScalar(-reach), b: vector.clone().multiplyScalar(reach) };
  }

  setImages(images: ImageFeature[]): void {
    this.imageGroup.traverse((object) => {
      if (object instanceof Mesh) {
        object.geometry.dispose();
      }
    });
    this.imageGroup.clear();
    const loader = new TextureLoader();
    this.imageMeshes = [];
    for (const img of images) {
      // Textures are cached by source so live moves/scales don't reload them.
      let tex = this.textures.get(img.src);
      if (!tex) {
        tex = loader.load(img.src, () => this.requestRender());
        tex.colorSpace = SRGBColorSpace;
        this.textures.set(img.src, tex);
      }
      const mesh = new Mesh(new PlaneGeometry(img.width, img.height), new MeshBasicMaterial({ map: tex, transparent: true, opacity: img.opacity, side: DoubleSide, depthWrite: false }));
      mesh.applyMatrix4(planeMatrix(img.plane, -this.cam.distance * 1e-5));
      mesh.renderOrder = 0;
      mesh.userData.image = img.id;
      this.imageGroup.add(mesh);
      this.imageMeshes.push(mesh);
    }
    this.dirty = true;
  }

  private imageMeshes: Mesh[] = [];
  private textures = new Map<string, import('three').Texture>();

  // ------------------------------------------------------------ highlights

  private lastSelKey = '';
  private pulse: { t0: number; mats: { m: MeshBasicMaterial | LineMaterial | PointsMaterial; base: number }[] } | null = null;

  setHighlights(selected: Highlight[], hover: Highlight | null): void {
    // The curves picked changed: a spline among them shows its points, one let go only its ends (the sketch is drawn again).
    const open = new Set(selected.flatMap(highlight => (highlight.kind === 'curve' || highlight.kind === 'point' ? [highlight.entity] : [])));
    if (open.size !== this.openCurves.size || [...open].some(id => !this.openCurves.has(id))) {
      const was = this.openCurves;
      this.openCurves = open;
      const changed = (id: string) => was.has(id) !== open.has(id);
      const sk = this.activeSketch ? this.sketches.find(sketch => sketch.id === this.activeSketch) : undefined;
      if (sk?.entities.some(e => e.kind === 'spline' && e.points.length > 2 && changed(e.id))) {
        this.setSketches(this.sketches, this.activeSketch, this.freshSketches);
      }
    }
    this.highlightGroup.traverse((object) => {
      if (object instanceof Mesh || object instanceof LineSegments2) {
        object.geometry.dispose();
      }
    });
    this.highlightGroup.clear();
    const selKey = JSON.stringify(selected);
    const fresh = selKey !== this.lastSelKey && selected.length > 0;
    this.lastSelKey = selKey;
    this.lineMaterials = this.lineMaterials.filter(lineMaterial => lineMaterial.userData.keep);
    let width = 4;
    const fatLines = (pts: number[], color: number) => {
      const geo = new LineSegmentsGeometry().setPositions(pts);
      const mat = new LineMaterial({ color, linewidth: width, depthTest: false });
      mat.resolution.set(this.width, this.height);
      this.lineMaterials.push(mat);
      const line = new LineSegments2(geo, mat);
      line.renderOrder = 4;
      this.highlightGroup.add(line);
    };
    const add0 = (highlight: Highlight, color: number, opacity: number) => {
      if (highlight.kind === 'profile') {
        const src = this.profileMeshes.find(profileMesh => profileMesh.userData.sketch === highlight.sketch && profileMesh.userData.region === highlight.region);
        if (!src) {
          return;
        }
        const mesh = new Mesh(src.geometry.clone(), overlayMat(color, opacity + 0.15));
        mesh.applyMatrix4(src.matrix);
        mesh.renderOrder = 3;
        this.highlightGroup.add(mesh);

        return;
      }
      if (highlight.kind === 'curve') {
        const pts: number[] = [];
        for (const curveLine of this.curveLines.filter(otherCurveLine => otherCurveLine.sketch === highlight.sketch && otherCurveLine.entity === highlight.entity)) {
          for (let i = 0; i < curveLine.pts.length - 1; i++) {
            pts.push(...curveLine.pts[i].toArray(), ...curveLine.pts[i + 1].toArray());
          }
        }
        if (pts.length) {
          fatLines(pts, color);
        }

        return;
      }
      if (highlight.kind === 'point') {
        const q = this.sketchPoints.find(sketchPoint => sketchPoint.sketch === highlight.sketch && sketchPoint.entity === highlight.entity && sketchPoint.p === highlight.p);
        if (!q) {
          return;
        }
        const dot = new Points(new BufferGeometry().setFromPoints([q.pos]), dotMaterial({ color, size: 13 }));
        dot.renderOrder = 6;
        this.highlightGroup.add(dot);

        return;
      }
      if (highlight.kind === 'image') {
        const src = this.imageMeshes.find(imageMesh => imageMesh.userData.image === highlight.id);
        if (!src) {
          return;
        }
        const box = new LineSegments(new EdgesGeometry(src.geometry), new LineBasicMaterial({ color, depthTest: false }));
        box.applyMatrix4(src.matrix);
        box.renderOrder = 6;
        this.highlightGroup.add(box);
        const mesh = new Mesh(src.geometry.clone(), overlayMat(color, opacity * 0.5));
        mesh.applyMatrix4(src.matrix);
        this.highlightGroup.add(mesh);

        return;
      }
      if (highlight.kind === 'plane') {
        const src = this.planeMeshes.find(planeMesh => planeMesh.userData.plane === highlight.id);
        if (!src) {
          return;
        }
        // Just a tint (the plane stays see-through), so it doesn't cover the model.
        const mat = overlayMat(color, Math.min(0.22, opacity * 0.5));
        // Planes are picked through bodies, so their highlight must show through too.
        mat.depthTest = false;
        const mesh = new Mesh(src.geometry.clone(), mat);
        mesh.matrixAutoUpdate = false;
        mesh.matrix.copy(src.matrix);
        mesh.renderOrder = src.userData.origin ? 61 : 9;
        this.highlightGroup.add(mesh);

        return;
      }
      if (highlight.kind === 'origin') {
        const dot = new Points(new BufferGeometry().setFromPoints([new Vector3(0, 0, 0)]), dotMaterial({ color, size: 13, depthTest: false }));
        dot.renderOrder = 6;
        this.highlightGroup.add(dot);

        return;
      }
      if (highlight.kind === 'axis') {
        const a = this.axisLines.find(axisLine => axisLine.id === highlight.id) ?? this.worldAxisLine(highlight.id);
        if (a) {
          fatLines([...a.a.toArray(), ...a.b.toArray()], color);
        }

        return;
      }
      const b = this.bodies.get(highlight.body);
      if (!b) {
        return;
      }
      if (highlight.kind === 'vertex') {
        const vertex = b.vertices[highlight.vertex];
        if (!vertex) {
          return;
        }
        const dot = new Points(new BufferGeometry().setFromPoints([vertex]), dotMaterial({ color, size: 12 }));
        dot.renderOrder = 6;
        this.highlightGroup.add(dot);

        return;
      }
      if (highlight.kind === 'body' || highlight.kind === 'face') {
        const groups = highlight.kind === 'body' ? b.data.faceGroups : b.data.faceGroups.filter(faceGroup => faceGroup.face === highlight.face);
        const idx: number[] = [];
        for (const group of groups) {
          for (let i = group.start; i < group.start + group.count; i++) {
            idx.push(b.data.indices[i]);
          }
        }
        const geo = new BufferGeometry();
        geo.setAttribute('position', b.mesh.geometry.getAttribute('position'));
        geo.setIndex(idx);
        const mesh = new Mesh(geo, overlayMat(color, opacity));
        mesh.renderOrder = 3;
        this.highlightGroup.add(mesh);
        // Outline the face/body with its edges so it reads clearly.
        const outline: number[] = [];
        b.data.edges.forEach((e, i) => {
          if (highlight.kind === 'face' && !edgeOnFace(e, b.data.faces[highlight.face])) {
            return;
          }
          const edgeGroup = b.data.edgeGroups.find(edgeGroup => edgeGroup.edge === i);
          if (edgeGroup) {
            outline.push(...Array.from(b.data.edgePositions.slice(edgeGroup.start * 3, (edgeGroup.start + edgeGroup.count) * 3)));
          }
        });
        const lineWidth = width;
        width = 2;
        if (outline.length) {
          fatLines(outline, color);
        }
        width = lineWidth;
      } else {
        const edgeGroup = b.data.edgeGroups.find(e => e.edge === highlight.edge);
        if (edgeGroup) {
          fatLines(Array.from(b.data.edgePositions.slice(edgeGroup.start * 3, (edgeGroup.start + edgeGroup.count) * 3)), color);
        }
      }
    };
    // (A body shown moved - an assembly's pose: what is lit of it is moved with it.)
    const add = (highlight: Highlight, color: number, opacity: number) => {
      const n0 = this.highlightGroup.children.length;
      add0(highlight, color, opacity);
      const pose = 'body' in highlight ? this.poses?.get(highlight.body) : undefined;
      if (!pose) {
        return;
      }
      for (const child of this.highlightGroup.children.slice(n0)) {
        child.matrixAutoUpdate = false;
        child.matrix.fromArray(pose);
        child.matrixWorldNeedsUpdate = true;
      }
    };
    width = 5;
    if (hover) {
      add(hover, COLORS.hover, 0.3);
    }
    width = 4;
    const firstSel = this.highlightGroup.children.length;
    for (const highlight of selected) {
      add(highlight, COLORS.select, 0.42);
    }
    // A newly selected thing flashes briefly, so it's obvious what was picked.
    if (fresh) {
      const mats: { m: MeshBasicMaterial | LineMaterial | PointsMaterial; base: number }[] = [];
      this.highlightGroup.children.slice(firstSel).forEach((child) => {
        const material = (child as Mesh).material as MeshBasicMaterial | LineMaterial | PointsMaterial;
        if (!material) {
          return;
        }
        material.transparent = true;
        mats.push({ m: material, base: material.opacity });
      });
      this.pulse = { t0: performance.now(), mats };
    }
    this.dirty = true;
  }

  /** Advance the selection flash; returns true while it runs. */
  private tickPulse(now: number): boolean {
    const pulse = this.pulse;
    if (!pulse) {
      return false;
    }
    const progress = Math.min(1, (now - pulse.t0) / 420);
    const boost = Math.sin(progress * Math.PI) * 0.5;
    for (const { m, base } of pulse.mats) {
      m.opacity = Math.min(1, base + boost);
    }
    if (progress >= 1) {
      this.pulse = null;
    }

    return true;
  }

  // --------------------------------------------------------------- picking

  /** The model's box (the bodies shown), or null when there are none. */
  modelBounds(): { min: Vec3; max: Vec3 } | null {
    const box = new Box3();
    for (const b of this.visibleBodies()) {
      box.expandByObject(b.mesh);
    }

    return box.isEmpty() ? null : { min: box.min.toArray() as Vec3, max: box.max.toArray() as Vec3 };
  }

  /** The per-frame work a headset frame needs too (handles kept their size, and so on). */
  xrFrame(): void {
    this.frameHooks.forEach(frameHook => frameHook());
  }

  /** What the headset leaves out (and the page had shown), to put back after. */
  private xrHidden: Object3D[] = [];

  /** In the headset only the bodies show (no grid, axes, sketches, planes or highlights); back on the page, as it was. */
  xrMode(on: boolean): void {
    if (on) {
      this.xrHidden = [this.grid.mesh, this.axesGroup, this.imageGroup, this.constructionGroup, this.sketchGroup, this.highlightGroup, this.overlay].filter(object => object.visible);
      for (const object of this.xrHidden) {
        object.visible = false;
      }
    } else {
      for (const object of this.xrHidden) {
        object.visible = true;
      }
      this.xrHidden = [];
      this.grid.mesh.visible = settings.value.showGrid;
    }
    this.dirty = true;
  }

  private setRay(x: number, y: number): void {
    const ndc = new Vector2((x / this.width) * 2 - 1, -(y / this.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
  }

  /** Set while the pointer only hovers: picking skips the near-miss search that taps get. */
  hovering = false;

  /**
   * Under the pointer, the section's own cut face (the hatched cap, where it
   * is drawn): the point on it, or null where the tap lands on anything else
   * (a face in front of the cut, empty space, past a body's outline).
   */
  cutAt(x: number, y: number): Vec3 | null {
    const clip = this.clip;
    if (!clip) {
      return null;
    }
    this.setRay(x, y);
    const ray = this.raycaster.ray;
    const at = ray.intersectPlane(clip, new Vector3());
    if (!at) {
      return null;
    }
    const distance = at.distanceTo(ray.origin);
    const near = this.cam.distance * 1e-4;
    const front = this.raycaster.intersectObjects(this.visibleBodies().map(b => b.mesh), false).find(hit => clip.distanceToPoint(hit.point) >= 0);
    if (front && front.distance < distance - near) {
      return null;
    }
    // Inside a body there: from the cut on along the ray, its surface is crossed an odd number of times.
    const from = new Raycaster(at.clone().addScaledVector(ray.direction, near), ray.direction.clone());
    for (const b of this.visibleBodies()) {
      if (!b.cap.visible) {
        continue;
      }
      const material = b.mesh.material as MeshStandardMaterial;
      const side = material.side;
      material.side = DoubleSide;
      const hits = from.intersectObject(b.mesh, false);
      material.side = side;
      // (A ray through a seam between two triangles meets both: counted once.)
      let count = 0;
      let last = -Infinity;
      for (const hit of hits) {
        if (hit.distance - last > near) {
          count++;
        }
        last = hit.distance;
      }
      if (count % 2 === 1) {
        return at.toArray() as Vec3;
      }
    }

    return null;
  }

  /** Pick what's under the pointer. Edges and curves win within the tolerance. */
  /**
   * The face of every body under the point at the nearest depth: more than one
   * where bodies share a face's place (a bolt flush with the flange it's to
   * cut). The nearest first, one per body.
   */
  facesAt(x: number, y: number): PickHit[] {
    if (settings.value.shader === 'wireframe') {
      return [];
    }
    this.setRay(x, y);
    const hits = this.raycaster.intersectObjects(this.visibleBodies().map(b => b.mesh), false).filter(hit => !this.clip || this.clip.distanceToPoint(hit.point) >= 0);
    const near = this.cam.distance * 1e-3;
    const out: PickHit[] = [];
    for (const hit of hits) {
      if (hit.distance - hits[0].distance > near) {
        break;
      }
      const body = hit.object.userData.body as string;
      if (typeof hit.faceIndex !== 'number' || out.some(pickHit => pickHit.kind === 'face' && pickHit.body === body)) {
        continue;
      }
      const tri = hit.faceIndex * 3;
      const faceGroup = this.bodies.get(body)?.data.faceGroups.find(candidate => tri >= candidate.start && tri < candidate.start + candidate.count);
      if (faceGroup) {
        out.push({ kind: 'face', body, face: faceGroup.face, point: hit.point.toArray() as Vec3 });
      }
    }

    return out;
  }

  pick(x: number, y: number, opts: PickOptions = {}): PickHit | null {
    const { edgeTolPx = 8, profiles = true, bodies = true, edges = true, curves = false, planes = true, axes = true, vertices = edges, planesFirst = false } = opts;
    this.setRay(x, y);
    // The origin, tapped near it on screen: it wins (a point you mean exactly).
    if (opts.origin) {
      const values = new Float64Array(2);
      if (this.projector()(0, 0, 0, values) && Math.hypot(values[0] - x, values[1] - y) < Math.max(12, edgeTolPx)) {
        return { kind: 'origin', point: [0, 0, 0] };
      }
    }
    // A plane of the project's own, where the tap lands on one: the origin
    // planes draw over everything and covered it (a plane 18 up, tapped from
    // the top, gave the floor; they have buttons in the card as well). A
    // sketch's shape on it still comes first (tapped to carry on with it).
    let ownPlane: PickHit | null = null;
    if (planes && planesFirst) {
      const hits = this.raycaster.intersectObjects(this.planeMeshes, false);
      const own = hits.find(hit => !hit.object.userData.origin);
      if (own) {
        ownPlane = { kind: 'plane', id: own.object.userData.plane, point: own.point.toArray() as Vec3 };
      } else if (hits[0]) {
        return { kind: 'plane', id: hits[0].object.userData.plane, point: hits[0].point.toArray() as Vec3 };
      }
    }
    const visibleBodies = bodies && settings.value.shader !== 'wireframe';
    const meshes = visibleBodies ? this.visibleBodies().map(b => b.mesh) : [];
    const faceHit = this.raycaster.intersectObjects(meshes, false).find(hit => !this.clip || this.clip.distanceToPoint(hit.point) >= 0);
    // Select Through: edges, corners and sketches behind the front faces can be picked.
    const faceDist = faceHit && !this.selectThrough ? faceHit.distance : Infinity;
    const near = this.cam.distance * 1e-3;

    if (bodies && vertices) {
      const vertex = this.pickVertex(x, y, edgeTolPx, faceDist);
      // A corner within a finger's reach - but a short edge tapped in its
      // middle (a 3 mm high box's upright edge) is the edge: the tap is much
      // nearer it than either end.
      if (vertex?.kind === 'vertex' && edges) {
        const dist = (point: Vec3) => {
          const q = this.toScreen(new Vector3(...point));

          return q ? Math.hypot(q[0] - x, q[1] - y) : Infinity;
        };
        const dv = dist(vertex.point);
        const e = dv > 6 ? this.pickEdge(x, y, faceHit ? Math.max(5, edgeTolPx * 0.6) : edgeTolPx, faceDist) : null;
        if (e && dist(e.point) + 5 < dv) {
          return e;
        }
      }
      if (vertex) {
        return vertex;
      }
    }

    if (curves) {
      const only = typeof curves === 'string' ? curves : undefined;
      // Points first: endpoints sit on curves, and are what you usually mean.
      let bestPt: { d: number; q: { sketch: string; entity: string; p: string; pos: Vector3 } } | null = null;
      const proj = this.projector();
      const values = new Float64Array(2);
      for (const q of this.sketchPoints) {
        if (only && q.sketch !== only) {
          continue;
        }
        if (!proj(q.pos.x, q.pos.y, q.pos.z, values)) {
          continue;
        }
        const distance = Math.hypot(values[0] - x, values[1] - y);
        if (distance < edgeTolPx && (!bestPt || distance < bestPt.d)) {
          bestPt = { d: distance, q };
        }
      }
      if (bestPt) {
        return { kind: 'point', sketch: bestPt.q.sketch, entity: bestPt.q.entity, p: bestPt.q.p, point: bestPt.q.pos.toArray() as Vec3 };
      }
      const curve = this.pickCurve(x, y, edgeTolPx, only);
      if (curve) {
        return curve;
      }
    }
    if (profiles) {
      // A fresh sketch (drawn on top) is found behind a face too.
      const ph = this.raycaster.intersectObjects(this.profileMeshes, false).filter(hit => hit.distance <= faceDist + near || hit.object.userData.fresh);
      if (ph.length) {
        // Smallest region under the pointer at the nearest depth.
        const d0 = ph[0].distance;
        const best = ph.filter(hit => Math.abs(hit.distance - d0) < near).sort((a, b) => a.object.userData.area - b.object.userData.area)[0];

        return { kind: 'profile', sketch: best.object.userData.sketch, region: best.object.userData.region, point: best.point.toArray() as Vec3 };
      }
    }
    if (bodies && edges) {
      // Over a face, an edge has to be nearer to win (else small faces are
      // hard to hit between their edges when zoomed out).
      const near: { d: number; point: Vector3 }[] = [];
      const edge = this.pickEdge(x, y, faceHit ? Math.max(5, edgeTolPx * 0.6) : edgeTolPx, faceDist, near);
      // Over a face, the finger between two edges about as near either side -
      // the middle of a narrow strip (a 3 mm round, 21 px across, tapped in
      // its middle, gave one of its edges every time): the strip is meant.
      const strip = () => {
        const q = near[0] && this.toScreen(near[0].point);
        if (!q) {
          return false;
        }

        return near.slice(1).some((other) => {
          const screenPoint = this.toScreen(other.point);

          return !!screenPoint && other.d < near[0].d * 1.5 + 1 && (q[0] - x) * (screenPoint[0] - x) + (q[1] - y) * (screenPoint[1] - y) < 0;
        });
      };
      if (edge && !(faceHit && strip())) {
        return edge;
      }
    }
    if (typeof faceHit?.faceIndex === 'number') {
      const body = faceHit.object.userData.body as string;
      const data = this.bodies.get(body)!.data;
      const tri = faceHit.faceIndex * 3;
      const faceGroup = data.faceGroups.find(candidate => tri >= candidate.start && tri < candidate.start + candidate.count);
      if (faceGroup) {
        return { kind: 'face', body, face: faceGroup.face, point: faceHit.point.toArray() as Vec3 };
      }
    }
    // Nothing right under the tap: a corner, edge or curve just beside it is what
    // was meant (a finger, or a quick click, is rarely exactly on a thin line).
    if (!faceHit && edgeTolPx > 0 && !this.hovering) {
      const wide = Math.min(28, edgeTolPx * 1.6);
      if (bodies && vertices) {
        const vertex = this.pickVertex(x, y, wide * 0.8, Infinity);
        if (vertex) {
          return vertex;
        }
      }
      if (curves) {
        const curve = this.pickCurve(x, y, wide, typeof curves === 'string' ? curves : undefined);
        if (curve) {
          return curve;
        }
      }
      if (bodies && edges) {
        const e = this.pickEdge(x, y, wide, Infinity);
        if (e) {
          return e;
        }
      }
    }
    if (opts.images !== false) {
      const hit = this.raycaster.intersectObjects(this.imageMeshes, false)[0];
      if (hit && hit.distance <= faceDist) {
        return { kind: 'image', id: hit.object.userData.image, point: hit.point.toArray() as Vec3 };
      }
    }
    if (axes) {
      // World axes in short pieces: a far end behind the camera has no screen position.
      const world: { id: string; a: Vector3; b: Vector3 }[] = [];
      for (const id of opts.worldAxes ? ['X', 'Y', 'Z'] : []) {
        const axisLine = this.worldAxisLine(id);
        if (!axisLine) {
          continue;
        }
        const segmentCount = 64;
        for (let segment = 0; segment < segmentCount; segment++) {
          world.push({ id, a: axisLine.a.clone().lerp(axisLine.b, segment / segmentCount), b: axisLine.a.clone().lerp(axisLine.b, (segment + 1) / segmentCount) });
        }
      }
      for (const a of [...this.axisLines, ...world]) {
        const sa = this.toScreen(a.a);
        const sb = this.toScreen(a.b);
        if (sa && sb && distToSeg(x, y, sa, sb) < edgeTolPx) {
          return { kind: 'axis', id: a.id, point: a.a.toArray() as Vec3 };
        }
      }
    }
    if (ownPlane) {
      return ownPlane;
    }
    if (planes) {
      const hit = this.raycaster.intersectObjects(this.planeMeshes, false)[0];
      if (hit && hit.distance <= faceDist) {
        return { kind: 'plane', id: hit.object.userData.plane, point: hit.point.toArray() as Vec3 };
      }
    }

    return null;
  }

  /**
   * A sketch's shape at or right beside the pointer that is too narrow there to be tapped without tapping its own
   * outline - the frame between a face's edge and a small offset of it, a letter's stroke: that shape. (Its lines
   * and the body's edges took every tap; to pick it, the view had to be zoomed right in on it. Asked for: "because
   * the surface is so small, it doesn't select that sketch surface and I have to rotate the camera and zoom in
   * very much to select it".) Null where the shape under the pointer is wide enough to tap, or there is none.
   */
  thinProfileNear(x: number, y: number, tol: number): PickHit | null {
    if (!this.profileMeshes.length) {
      return null;
    }
    const only = { curves: false, edges: false, vertices: false, planes: false, axes: false, images: false, edgeTolPx: 0 } as const;
    const at = (px: number, py: number) => {
      const hit = this.pick(px, py, only);

      return hit?.kind === 'profile' ? hit : null;
    };
    const same = (a: PickHit | null, b: PickHit) => a?.kind === 'profile' && b.kind === 'profile' && a.sketch === b.sketch && a.region === b.region;
    const area = (pickHit: PickHit) => (pickHit.kind === 'profile' ? ((this.profileMeshes.find(profileMesh => profileMesh.userData.sketch === pickHit.sketch && profileMesh.userData.region === pickHit.region)?.userData.area as number | undefined) ?? Infinity) : Infinity);
    // The shapes at the pointer and round it, as far as a tap's reach: the smallest of them is the one meant.
    const found: { h: PickHit; x: number; y: number }[] = [];
    const reach = Math.max(4, tol);
    for (const radius of [0, reach * 0.5, reach]) {
      for (let spoke = 0; spoke < (radius ? 8 : 1); spoke++) {
        const [px, py] = [x + radius * Math.cos((spoke * Math.PI) / 4), y + radius * Math.sin((spoke * Math.PI) / 4)];
        const hit = at(px, py);
        if (hit && !found.some(foundHit => same(foundHit.h, hit))) {
          found.push({ h: hit, x: px, y: py });
        }
      }
    }
    // (Right on a shape that is wide enough to tap: its line was meant, not a narrow neighbour's.)
    const under = found[0] && found[0].x === x && found[0].y === y ? found[0] : null;
    const narrow = (candidate: { h: PickHit; x: number; y: number }, by = 2 * reach) => [0, 1, 2, 3].some((side) => {
      const [dx, dy] = [by * Math.cos((side * Math.PI) / 4), by * Math.sin((side * Math.PI) / 4)];

      return !same(at(candidate.x + dx, candidate.y + dy), candidate.h) && !same(at(candidate.x - dx, candidate.y - dy), candidate.h);
    });
    found.sort((a, b) => area(a.h) - area(b.h));
    // One no wider than a tap's own reach - a hair of a frame, seen from far off: it is meant even from just beside
    // it, on the wide shape next to it (there is no tapping it otherwise; a double tap on its line opens the sketch).
    const hair = found.find(candidate => candidate !== under && narrow(candidate, reach));
    if (hair) {
      return hair.h;
    }
    if (under) {
      return narrow(under) ? under.h : null;
    }
    for (const candidate of found) {
      // Narrow there: some way across it, two taps' reach either side of the spot are both off it.
      if (narrow(candidate)) {
        return candidate.h;
      }
    }

    return null;
  }

  private pickCurve(x: number, y: number, tol: number, onlySketch?: string): PickHit | null {
    let best: { d: number; c: { sketch: string; entity: string; pts: Vector3[] }; p: Vector3 } | null = null;
    const proj = this.projector();
    const values = new Float64Array(2);
    const sa: [number, number] = [0, 0];
    const sb: [number, number] = [0, 0];
    for (const curveLine of this.curveLines) {
      if (onlySketch && curveLine.sketch !== onlySketch) {
        continue;
      }
      for (let i = 0; i < curveLine.pts.length - 1; i++) {
        const pointA = curveLine.pts[i];
        const pointB = curveLine.pts[i + 1];
        if (!proj(pointA.x, pointA.y, pointA.z, values)) {
          continue;
        }
        ((sa[0] = values[0]), (sa[1] = values[1]));
        if (!proj(pointB.x, pointB.y, pointB.z, values)) {
          continue;
        }
        ((sb[0] = values[0]), (sb[1] = values[1]));
        const distance = distToSeg(x, y, sa, sb);
        if (distance < tol && (!best || distance < best.d)) {
          // Where on the piece the pointer is (not the piece's start: a straight line is one piece, and its far
          // end stood for it - "further away than the face it is drawn on", so the face was picked, not the line).
          // (Nearest the pointer's own line of sight: right in perspective too, however long the piece.)
          const at = new Vector3();
          this.raycaster.ray.distanceSqToSegment(pointA, pointB, undefined, at);
          best = { d: distance, c: curveLine, p: at };
        }
      }
    }

    return best ? { kind: 'curve', sketch: best.c.sketch, entity: best.c.entity, point: best.p.toArray() as Vec3 } : null;
  }

  /** Distance of a point along the view direction (works for ortho and perspective). */
  private depthOf(worldPoint: Vector3): number {
    return this.cam.ortho ? worldPoint.clone().sub(this.camera.position).dot(this.cam.viewDir()) : worldPoint.distanceTo(this.camera.position);
  }

  /**
   * World → screen for many points at once: one matrix, the canvas size read
   * once, nothing allocated (picking projects every corner and edge piece of
   * every body - 10–14 ms a pick for a ruler's 11 000 edges).
   */
  private projector(): (x: number, y: number, z: number, out: Float64Array) => boolean {
    const elements = new Matrix4().multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse).elements;
    const width = this.width;
    const height = this.height;

    return (x, y, z, out) => {
      const clipW = elements[3] * x + elements[7] * y + elements[11] * z + elements[15];
      const pz = (elements[2] * x + elements[6] * y + elements[10] * z + elements[14]) / clipW;
      if (pz > 1 || pz < -1) {
        return false;
      }
      out[0] = (((elements[0] * x + elements[4] * y + elements[8] * z + elements[12]) / clipW + 1) / 2) * width;
      out[1] = ((1 - (elements[1] * x + elements[5] * y + elements[9] * z + elements[13]) / clipW) / 2) * height;

      return true;
    };
  }

  private pickVertex(x: number, y: number, tolPx: number, faceDist: number): PickHit | null {
    const cands: { d: number; body: string; vertex: number; p: Vector3 }[] = [];
    const proj = this.projector();
    const values = new Float64Array(2);
    for (const [id, b] of this.bodies) {
      // (A body shown moved is picked by its faces only: its corners and edges are known where it was modelled.)
      if (this.hiddenIds.has(id) || this.poses?.has(id)) {
        continue;
      }
      b.vertices.forEach((vertex, i) => {
        if (this.clip && this.clip.distanceToPoint(vertex) < 0) {
          return;
        }
        if (!proj(vertex.x, vertex.y, vertex.z, values)) {
          return;
        }
        const distance = Math.hypot(values[0] - x, values[1] - y);
        if (distance > tolPx) {
          return;
        }
        if (this.depthOf(vertex) > faceDist + this.cam.distance * 0.01) {
          return;
        }
        cands.push({ d: distance, body: id, vertex: i, p: vertex });
      });
    }
    if (!cands.length) {
      return null;
    }
    cands.sort((a, b) => a.d - b.d);
    // The nearest corner nothing covers: the depth allowance above lets a
    // point just behind a thin wall through (the end of a stem 2 mm above the
    // inside of a lamp shade was picked through it).
    const hit = cands.slice(0, 6).find(candidate => this.uncovered(candidate.p)) ?? null;
    this.setRay(x, y);

    return hit ? { kind: 'vertex', body: hit.body, vertex: hit.vertex, point: hit.p.toArray() as Vec3 } : null;
  }

  /** The edge nearest the pointer (within tolPx, not hidden); `near` gets the nearest few, the nearest first. */
  private pickEdge(x: number, y: number, tolPx: number, faceDist: number, near?: { d: number; point: Vector3 }[]): PickHit | null {
    // The nearest point of each edge near the pointer.
    const per = new Map<string, { d: number; body: string; edge: number; point: Vector3; depth: number }>();
    const a = new Vector3();
    const b = new Vector3();
    const camPos = this.camera.position;
    const viewDir = this.cam.viewDir();
    const proj = this.projector();
    const values = new Float64Array(2);
    const sa: [number, number] = [0, 0];
    const sb: [number, number] = [0, 0];
    for (const [id, { data }] of this.bodies) {
      if (this.hiddenIds.has(id) || this.poses?.has(id)) {
        continue;
      }
      const edgePositions = data.edgePositions;
      for (const edgeGroup of data.edgeGroups) {
        for (let i = edgeGroup.start; i < edgeGroup.start + edgeGroup.count; i += 2) {
          if (!proj(edgePositions[i * 3], edgePositions[i * 3 + 1], edgePositions[i * 3 + 2], values)) {
            continue;
          }
          ((sa[0] = values[0]), (sa[1] = values[1]));
          if (!proj(edgePositions[i * 3 + 3], edgePositions[i * 3 + 4], edgePositions[i * 3 + 5], values)) {
            continue;
          }
          ((sb[0] = values[0]), (sb[1] = values[1]));
          // Nowhere near the pointer: skip before anything else.
          if ((sa[0] < x - tolPx && sb[0] < x - tolPx) || (sa[0] > x + tolPx && sb[0] > x + tolPx) || (sa[1] < y - tolPx && sb[1] < y - tolPx) || (sa[1] > y + tolPx && sb[1] > y + tolPx)) {
            continue;
          }
          a.set(edgePositions[i * 3], edgePositions[i * 3 + 1], edgePositions[i * 3 + 2]);
          b.set(edgePositions[i * 3 + 3], edgePositions[i * 3 + 4], edgePositions[i * 3 + 5]);
          if (this.clip && this.clip.distanceToPoint(a) < 0 && this.clip.distanceToPoint(b) < 0) {
            continue;
          }
          const t = segParam(x, y, sa, sb);
          const distance = Math.hypot(sa[0] + (sb[0] - sa[0]) * t - x, sa[1] + (sb[1] - sa[1]) * t - y);
          const key = `${id} ${edgeGroup.edge}`;
          const was = per.get(key);
          if (distance > tolPx || (was && distance >= was.d)) {
            continue;
          }
          const point = a.clone().lerp(b, t);
          // Hidden edges (behind the face under the pointer) are not pickable.
          const depth = this.cam.ortho ? point.clone().sub(camPos).dot(viewDir) : point.distanceTo(camPos);
          if (depth > faceDist + this.cam.distance * 0.01) {
            continue;
          }
          per.set(key, { d: distance, body: id, edge: edgeGroup.edge, point: point, depth });
        }
      }
    }
    // The nearest one nothing covers (the allowance above lets an edge just
    // behind a thin wall through). Two on the same pixels (a frame's front
    // and back edge, seen from straight above): the one nearer the eye - the
    // tap just off the face took the hidden one under it.
    const sorted = [...per.values()].sort((first, q) => (Math.abs(first.d - q.d) < 1 ? first.depth - q.depth : first.d - q.d)).slice(0, 6);
    const best = sorted.find(candidate => this.uncovered(candidate.point));
    if (near && best) {
      for (const candidate of sorted) {
        if (candidate === best || (candidate.d > best.d && this.uncovered(candidate.point))) {
          near.push({ d: candidate.d, point: candidate.point });
        }
      }
    }
    this.setRay(x, y);

    return best ? { kind: 'edge', body: best.body, edge: best.edge, point: best.point.toArray() as Vec3 } : null;
  }

  /** Nothing drawn lies in front of this point (a few pixels' slack). Moves the ray. */
  private uncovered(point: Vector3): boolean {
    if (settings.value.shader === 'wireframe' || this.selectThrough) {
      return true;
    }
    const q = this.toScreen(point);
    if (!q) {
      return false;
    }
    this.setRay(q[0], q[1]);
    const front = this.raycaster.intersectObjects(this.visibleBodies().map(b => b.mesh), false).find(hit => !this.clip || this.clip.distanceToPoint(hit.point) >= 0);

    return !front || front.distance >= this.raycaster.ray.origin.distanceTo(point) - this.cam.worldPerPixel(this.height) * 2;
  }

  /** Intersection of the pointer ray with a plane, or null if parallel. */
  /** The ray from the eye through a point of the canvas (origin, unit direction). */
  pointerRay(x: number, y: number): { o: Vec3; d: Vec3 } {
    this.setRay(x, y);
    const ray = this.raycaster.ray;

    return { o: ray.origin.toArray() as Vec3, d: ray.direction.clone().normalize().toArray() as Vec3 };
  }

  rayToPlane(x: number, y: number, plane: PlaneDef): Vec3 | null {
    this.setRay(x, y);
    const vector = new Vector3(...plane.normal);
    const origin = new Vector3(...plane.origin);
    const ray = this.raycaster.ray;
    const denom = vector.dot(ray.direction);
    if (Math.abs(denom) < 1e-9) {
      return null;
    }
    const t = origin.sub(ray.origin).dot(vector) / denom;
    if (t < 0 && !this.cam.ortho) {
      return null;
    }

    return ray.origin.clone().addScaledVector(ray.direction, t).toArray() as Vec3;
  }

  /** World point → CSS pixel coords, or null when behind the camera. */
  toScreen(target: Vector3 | Vec3): [number, number] | null {
    const point = Array.isArray(target) ? new Vector3(...target) : target.clone();
    point.project(this.camera);
    if (point.z > 1 || point.z < -1) {
      return null;
    }

    return [((point.x + 1) / 2) * this.width, ((1 - point.y) / 2) * this.height];
  }

  /** Point under the pointer for zooming: model surface, else ground, else target depth. */
  worldUnder(x: number, y: number): Vector3 {
    this.setRay(x, y);
    const hit = this.raycaster.intersectObjects([...this.bodies.values()].map(b => b.mesh), false)[0];
    if (hit) {
      return hit.point;
    }
    const groundPoint = this.rayToPlane(x, y, GROUND);
    if (groundPoint && new Vector3(...groundPoint).distanceTo(this.camera.position) < this.cam.distance * 20) {
      return new Vector3(...groundPoint);
    }
    const ray = this.raycaster.ray;

    return ray.origin.clone().addScaledVector(ray.direction, this.cam.target.clone().sub(ray.origin).dot(ray.direction));
  }

  /** Line material that tracks viewport resolution (for overlays). */
  lineMaterial(color: number, width: number, depthTest = false): LineMaterial {
    const material = new LineMaterial({ color, linewidth: width, depthTest });
    material.resolution.set(this.width, this.height);
    material.userData.keep = true;
    this.lineMaterials.push(material);

    return material;
  }

  releaseLineMaterial(material: LineMaterial): void {
    this.lineMaterials = this.lineMaterials.filter(lineMaterial => lineMaterial !== material);
    material.dispose();
  }

  /** PNG of the current view. */
  /**
   * The view as a PNG, with see-through marks at the bottom right: the
   * project's name, the isolated bodies' names (when isolating), and the
   * superGeometry.app logo and name.
   */
  async screenshot(label?: { project: string; isolated?: string[] }): Promise<Blob | null> {
    const logo = await watermarkLogo();
    // Render and copy straight away (the drawing buffer isn't kept after this task).
    this.render();
    const out = document.createElement('canvas');
    out.width = this.canvas.width;
    out.height = this.canvas.height;
    const context = out.getContext('2d');
    if (!context) {
      return new Promise(resolve => this.canvas.toBlob(resolve, 'image/png'));
    }
    context.drawImage(this.canvas, 0, 0);
    // Sized like the app's own name at the top (scaled to the picture's pixels).
    const px = this.canvas.width / Math.max(1, this.canvas.clientWidth);
    const pad = 14 * px;
    const icon = 26 * px;
    const font = (weight: number, size: number) => `${weight} ${size * px}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
    const right = out.width - pad;
    context.globalAlpha = 0.45;
    context.textBaseline = 'middle';
    // Bottom line: logo, "superGeometry" and ".app", ending at the right edge.
    let y = out.height - pad - icon / 2;
    context.font = font(750, 20);
    const tld = context.measureText('.app').width;
    const name = context.measureText('superGeometry').width;
    context.fillStyle = '#3d8bff';
    context.fillText('.app', right - tld, y);
    context.fillStyle = '#cfd6e4';
    context.fillText('superGeometry', right - tld - name, y);
    if (logo) {
      context.drawImage(logo, right - tld - name - 8 * px - icon, y - icon / 2, icon, icon);
    }
    // Above it, right-aligned: the isolated bodies, then the project's name.
    context.textAlign = 'right';
    const maxW = out.width * 0.6;
    const fit = (text: string) => {
      if (context.measureText(text).width <= maxW) {
        return text;
      }
      while (text.length > 1 && context.measureText(`${text}…`).width > maxW) {
        text = text.slice(0, -1);
      }

      return `${text.trimEnd()}…`;
    };
    y -= icon / 2 + 6 * px;
    const names = label?.isolated ?? [];
    if (names.length) {
      context.font = font(500, 13);
      context.fillStyle = '#cfd6e4';
      y -= 8 * px;
      context.fillText(fit(names.join(', ')), right, y);
      y -= 8 * px + 4 * px;
    }
    if (label?.project) {
      context.font = font(650, 16);
      context.fillStyle = '#e8e9ec';
      y -= 10 * px;
      context.fillText(fit(label.project), right, y);
    }
    context.textAlign = 'left';
    context.globalAlpha = 1;

    return new Promise(resolve => out.toBlob(resolve, 'image/png'));
  }

  get sketchList(): SketchView[] {
    return this.sketches;
  }
}

/** Matrix taking sketch-local (u, v, w) into world space. */
export function planeMatrix(plane: PlaneDef, lift = 0): Matrix4 {
  const x = new Vector3(...plane.xDir);
  const y = new Vector3(...planeY(plane));
  const z = new Vector3(...plane.normal);
  const origin = new Vector3(...plane.origin).addScaledVector(z, lift);

  return new Matrix4().makeBasis(x, y, z).setPosition(origin);
}

export function sketchToWorld(plane: PlaneDef, uv: Vec2, lift = 0): Vector3 {
  return new Vector3(uv[0], uv[1], 0).applyMatrix4(planeMatrix(plane, lift));
}

/** Does an edge lie on a face? (flat faces: all three sample points on its plane). */
export function edgeOnFace(e: EdgeInfo, faceInfo: FaceInfo): boolean {
  if (!faceInfo.plane) {
    // Curved faces: an edge belongs if its midpoint is close to the face centre region.
    return false;
  }

  return [e.start, e.end, e.mid].every(point => Math.abs((point[0] - faceInfo.center[0]) * faceInfo.normal[0] + (point[1] - faceInfo.center[1]) * faceInfo.normal[1] + (point[2] - faceInfo.center[2]) * faceInfo.normal[2]) < 1e-5 * (1 + Math.sqrt(faceInfo.area)));
}

function overlayMat(color: number, opacity: number): MeshBasicMaterial {
  return new MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, side: DoubleSide, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });
}

function segParam(x: number, y: number, a: [number, number], b: [number, number]): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  if (l2 < 1e-9) {
    return 0;
  }

  return Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / l2));
}

function distToSeg(x: number, y: number, a: [number, number], b: [number, number]): number {
  const t = segParam(x, y, a, b);

  return Math.hypot(a[0] + (b[0] - a[0]) * t - x, a[1] + (b[1] - a[1]) * t - y);
}

function makeAxes(): Object3D {
  const group = new Group();
  const reach = 1e6;
  const axis = (to: Vec3, color: number) => {
    const geo = new BufferGeometry();
    geo.setAttribute('position', new Float32BufferAttribute([0, 0, 0, ...to], 3));
    // Transparent + later render order so the axes draw over the coplanar grid.
    const mat = new LineBasicMaterial({ color, transparent: true, depthWrite: false });
    // The axes are the background of whatever is made: a hair further from the eye than they are (a third of a
    // percent of the way to what is looked at), so a body's edge or a sketch's line that runs along one is drawn
    // whole, in its own colour. (Lying in the very same place, the two fought for each pixel - an edge along X came
    // out in dashes of red, a sketch line there lost its colour to the axis. Asked for: "I want the line of
    // whatever was made to be on top of everything. The axis lines should be in the background".)
    mat.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader.replace('#include <project_vertex>', '#include <project_vertex>\n  gl_Position.z += 3.0e-6 * gl_Position.w;');
    };
    mat.customProgramCacheKey = () => 'axis-behind';
    const line = new LineSegments(geo, mat);
    line.renderOrder = 1;

    return line;
  };
  group.add(axis([reach, 0, 0], 0xe0584f), axis([0, reach, 0], 0x5fbf5a), axis([0, 0, reach], 0x4f8ce0));

  return group;
}

/**
 * Section caps get thin diagonal lines (fixed on screen), so a cut reads as a
 * cut and not as another face of the body.
 */
function hatched<M extends MeshBasicMaterial>(material: M): M {
  material.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <dithering_fragment>',
      `#include <dithering_fragment>
      float hatchK = mod(gl_FragCoord.x + gl_FragCoord.y, 9.0);
      if (hatchK < 1.6) gl_FragColor.rgb *= 0.62;`
    );
  };
  material.customProgramCacheKey = () => 'hatched';

  return material;
}

/**
 * A plane's mark: a small outline symbol for how it was made (and the
 * symmetry plane's) - like the view cube's buttons, no badge behind it.
 */
const PLANE_MARKS: Record<string, string> = { offset: '⇡', mid: '⇹', '3pt': '∴', curve: '∿', perp: '⊥', angle: '∠', parallel: '∥', symmetry: '⧖' };
/** Its size, as a part of the plane's width. */
export const PLANE_MARK_SIZE = 0.024;
const markMats = new Map<string, SpriteMaterial>();
export function planeMarkMaterial(kind: string): SpriteMaterial {
  let material = markMats.get(kind);
  if (material) {
    return material;
  }
  const canvas = document.createElement('canvas');
  // Drawn large and scaled down smoothly: crisp when zoomed in (a 64 px one pixelated).
  canvas.width = canvas.height = 256;
  const context = canvas.getContext('2d')!;
  context.fillStyle = kind === 'symmetry' ? '#a98bd6' : '#8f96a3';
  context.font = '176px system-ui, sans-serif';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillText(PLANE_MARKS[kind] ?? '?', 128, 140);
  const tex = new CanvasTexture(canvas);
  tex.colorSpace = SRGBColorSpace;
  tex.anisotropy = 8;
  material = new SpriteMaterial({ map: tex, transparent: true, depthTest: false, opacity: 0.4 });
  markMats.set(kind, material);

  return material;
}

/** The app's mark, the cape (public/icon.svg without its dark tile), for the screenshot watermark. */
let logoImage: Promise<HTMLImageElement | null> | null = null;
function watermarkLogo(): Promise<HTMLImageElement | null> {
  logoImage ??= fetch('icon.svg')
    .then(response => (response.ok ? response.text() : Promise.reject()))
    .then(
      text =>
        new Promise<HTMLImageElement | null>((resolve) => {
          // Drop the tile and crop to the cape.
          const svg = text.replace(/<rect[^>]*\/>/, '').replace(/viewBox="[^"]*"/, 'viewBox="3 8 58 48"');
          const img = new Image();
          img.onload = () => resolve(img);
          img.onerror = () => resolve(null);
          img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
        })
    )
    .catch(() => null);

  return logoImage;
}
