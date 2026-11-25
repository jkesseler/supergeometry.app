// The geometry kernel. This (with sketchGeom.ts) is the ONLY code that knows
// about OpenCascade / replicad; worker.ts exposes it to the UI via protocol.ts.
//
// replicad gotchas, learned the hard way:
//  - makeCompound(), translate(), rotate(), mirror(), scale() DELETE their input.
//    Shapes here live on in the feature cache, so always clone first.

import {
  basicFaceExtrusion,
  exportSTEP,
  getOC,
  genericSweep,
  importSTEP,
  loft,
  makeCompound,
  makeBox,
  iterTopo,
  makeBSplineApproximation,
  makeBezierCurve,
  makeThreePointArc,
  makeVertex,
  makeSphere,
  makeCircle,
  makeLine,
  makeCylinder,
  makeHelix,
  isShape3D,
  makeFace,
  cast,
  makePolygon,
  makeSolid,
  measureArea,
  measureDistanceBetween,
  ProjectionCamera,
  revolution,
  Solid,
  Vector,
  assembleWire,
  type AnyShape,
  type Edge,
  type Face,
  type Shape3D,
  type Wire
} from 'replicad';
import { fillEdgeKey } from '../doc/types';
import { applyFreeformEdits } from '../doc/freeformEdits';
import { facesNormal } from '../freeform/faceGrid';
import { add, cross, dist, dot, len, norm, scale, sub, xDirFor } from '../geom';
import { outlineOffsetCurves, projectPolyline } from '../sketch/edit';
import { solveFine } from '../sketch/constraints';
import { carried } from '../sketch/follow';
import { arcSpine, carriedFrames, evenly, gentle, guideCurve, oriented, plainSpine, slideAxis, slidingSpine, smoothed } from '../freeform/connect';
import { applyPlan, boundaryEdges, cachedPlan, deleteFaces, isClosed, selfCrossings, subdivide } from '../freeform/cage';
import { closestOnEntity } from '../sketch/regions';
import { holeFromLines } from '../doc/holeSizes';
import { cageToShape } from './freeform';
import { deepCopy, hairThin, openEdges, shapeValid, subShapes } from './health';
import { healthOf, isHealthy, repairShape } from './repair';
import { meshFlatFaces, meshModel, meshParts, stlTriangles, type MeshModel, type MeshCylinder, type MeshFace, type MeshStandIn } from './meshRound';
import { faceMiddle, holeCutter, holeFault, roundCentre } from './hole';
import { threadDepth } from './threads';
import { cylinderOf, deleteFace,
  deleteFaces as deleteBodyFaces, editNotes, freeformFace, sameSizesAgain, sheetFace, sheetFaces, hasBlends, inFlatFace, looseBox, offsetFace, onFace as pointOnFace, planeOf, replaceFacePlane, SIDES_MEET, sizeOf, unify } from './faceEdit';
import { edgeOrigins, edgeSteps, faceAliases, faceOrigins, faceSteps, inheritTags, movedTags, oldEdgeSteps, seamEdges, setOrigins, tagBody, type OriginOf } from './provenance';
import { railLoft } from './loftRails';
import { loftInLine } from './loftAlign';
import { binarySTL, faceTriangles, meshEdgeLines, meshFaces, meshOff, type FaceMesh } from './meshing';
import { measureArea as trueArea, measureVolume, normalOnEdge, quickVolume, roughVolume, surfaceAt, volumeProperties } from './ocFree';
import { useReleases } from './release';
import { useSafeBooleans, withoutInternals } from './safeBooleans';
import { anchorOf, freeformFaces, meshViews, viewEdge } from './viewLines';
import { withFittedSplines } from './sketchGeom';
import { stretchShape } from './stretch';
import { imprint, onFace as linesOnFace, seenFrom, wrapOnto } from './wrap';
import { MESH_MAX, TooBig } from './protocol';
import { isFault, blame, KernelFault, crashed } from './faults';
import { rebuild } from './rebuildState';
import { DAMAGED_TEXT, MAX_REACH, damaged } from './damaged';
import { baseId, bodyList, bodyNames, isEmpty, need, staysClosed, wholeOf } from './bodies';
import { EDGE_GONE, edgeInfo, faceInfo, resolveAxis, resolveEdge, resolveFace } from './references';
import { AFFINE_ID, affineDet, affineFrom, affineInverse, affineIsSimilar, affineThen, applyAffine, rotateAbout, scaleAbout, shapeThrough } from './affine';
import { booleanVolumeOk, checkedBoolean, combine, fuseAll, fuzzyBoolean, halfSpace, insideOf, overlapping, volumeOf, volumes } from './booleans';
import { noSketch, pathWire, sourceFaces, sourceWires, withHoles } from './sources';
import type {
  BooleanFeature,
  ConnectFeature,
  DeleteGeomFeature,
  EdgeFeature,
  EdgeRef,
  ExtrudeFeature,
  ExtrudeSource,
  FaceFreeformFeature,
  FaceRef,
  Feature,
  HoleFeature,
  ImportFeature,
  LoftFeature,
  MoveFaceFeature,
  PathRef,
  PlaneDef,
  RepairFeature,
  ReplaceFaceFeature,
  RevolveFeature,
  ShellFeature,
  SketchEntity,
  SketchFeature,
  SplitFeature,
  SweepFeature,
  ThreadFeature,
  Vec3
} from '../doc/types';
import type { BodyHealth, BodyMesh, BodyProps, ProjectedView, ViewBody, ViewEdge, ViewSpec, EdgeInfo, ExportFormat, FaceInfo, FeatureError, RegenResult } from './protocol';
import type { Affine, Bodies, Ctx, SketchState } from './types';

export { shapeValid } from './health';

/**
 * What a step read of the model before it, as it ran: so that when an
 * earlier step changes, a step that read nothing of what changed is not
 * rebuilt - its result is put on the model as it is now.
 */
interface Reads {
  /** Each thing it asked for ("bodies|id") and what it got (undefined: not there). */
  one: Map<string, unknown>;
  /** Kinds it looked through all of (any change among them is a change for it). */
  all: Set<keyof Ctx>;
  written: Set<string>;
}
let reading: Reads | null = null;
const KINDS = ['bodies', 'sketches', 'planes', 'axes', 'freeforms', 'sweeps', 'links'] as const;
const rawGet = <V>(map: Map<string, V>, key: string): V | undefined => Map.prototype.get.call(map, key) as V | undefined;
const rawHas = (map: Map<string, unknown>, key: string): boolean => Map.prototype.has.call(map, key) as boolean;
const rawEntries = <V>(map: Map<string, V>): [string, V][] => [...(Map.prototype.entries.call(map) as IterableIterator<[string, V]>)];

/** A map of the model (its bodies, sketches…) that notes what a step reads of it. */
class Noted<V> extends Map<string, V> {
  private live = false;
  constructor(readonly kind: keyof Ctx, from?: Map<string, V>) {
    super();
    if (from) {
      for (const [key, value] of rawEntries(from)) {
        super.set(key, value);
      }
    }
    this.live = true;
  }
  private saw(entryKey: string, value: unknown): void {
    const key = `${this.kind}|${entryKey}`;
    if (reading && !reading.written.has(key) && !reading.one.has(key)) {
      reading.one.set(key, value);
    }
  }
  get(key: string): V | undefined {
    const value = super.get(key);
    this.saw(key, value);

    return value;
  }
  has(key: string): boolean {
    this.saw(key, super.get(key));

    return super.has(key);
  }
  set(key: string, value: V): this {
    if (this.live) {
      reading?.written.add(`${this.kind}|${key}`);
    }

    return super.set(key, value);
  }
  delete(key: string): boolean {
    reading?.written.add(`${this.kind}|${key}`);

    return super.delete(key);
  }
  clear(): void {
    reading?.all.add(this.kind);
    super.clear();
  }
  get size(): number {
    reading?.all.add(this.kind);

    return super.size;
  }
  keys(): MapIterator<string> {
    reading?.all.add(this.kind);

    return super.keys();
  }
  values(): MapIterator<V> {
    reading?.all.add(this.kind);

    return super.values();
  }
  entries(): MapIterator<[string, V]> {
    reading?.all.add(this.kind);

    return super.entries();
  }
  forEach(fn: (value: V, key: string, map: Map<string, V>) => void, thisArg?: unknown): void {
    reading?.all.add(this.kind);
    super.forEach(fn, thisArg);
  }
  [Symbol.iterator](): MapIterator<[string, V]> {
    reading?.all.add(this.kind);

    return super[Symbol.iterator]();
  }
}
/** The model for the next step to work on: a copy to change, the one before it left as it is. */
function fork(ctx: Ctx): Ctx {
  return {
    bodies: new Noted('bodies', ctx.bodies),
    sketches: new Noted('sketches', ctx.sketches),
    planes: new Noted('planes', ctx.planes),
    axes: new Noted('axes', ctx.axes),
    freeforms: new Noted('freeforms', ctx.freeforms),
    sweeps: new Noted('sweeps', ctx.sweeps),
    links: new Noted('links', ctx.links)
  };
}
/** How many steps the last rebuild ran, took as they were (nothing before them changed), or put back (nothing they read changed). */
export const rebuildStats = { ran: 0, kept: 0, reused: 0 };

interface CacheEntry {
  key: string;
  ctx: Ctx;
  /** The step, and its values as text (hashed): the same step, unchanged? */
  id?: string;
  json?: string;
  /** What it read of the model before it, that model, and what it changed in it. */
  reads?: Reads;
  input?: Ctx;
  delta?: [keyof Ctx, string, unknown, boolean][];
  /** The steps switched off when it ran (a failed step's words depend on it). */
  off?: string;
  error?: string;
  /** Worked, but had to give something up (shown on the step in History). */
  note?: string;
  /** Which of its faces a face is (see provenance.ts): for steps made from a sketch. */
  origin?: OriginOf;
}

const meshCache = new WeakMap<Shape3D, BodyMesh>();
/** The Freeform Face steps of the project being rebuilt (their faces are patches of one smooth surface). */
let smoothSteps = new Set<string>();
/** Freeform and Freeform Face steps that are on (what an Edit Freeform step can edit). */
let editable = new Set<string>();
/** The next mesh's key (see BodyMesh.key). */
let meshKey = 1;
const importCache = new Map<string, Shape3D>();
let cache: CacheEntry[] = [];
/**
 * The saved project's steps, kept while a step is being changed (its previews
 * fill `cache`): Cancel goes back to them at once, not after a rebuild of
 * every step after the one that was open.
 */
let savedCache: CacheEntry[] = [];
/** The project with its threads left plain, as drawings draw it (kept apart from `cache`). */
let drawingCache: CacheEntry[] = [];
/** While drawings rebuild into `drawingCache`: the model's own steps, for the ones before its first thread. */
let alsoCache: CacheEntry[] = [];

/** After a fresh OpenCascade was loaded: everything made with the old one is dropped. */
export function resetKernel(): void {
  cache = [];
  savedCache = [];
  drawingCache = [];
  lastBodies = new Map();
  importCache.clear();
  sketchWas.clear();
}

/**
 * `work`, and if the engine breaks down in it: a fresh engine (`reload` loads
 * OpenCascade again) and once more, the step that did it now refused.
 */
export async function withFreshKernel<T>(reload: () => Promise<void>, work: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await work();
    } catch (err) {
      if (!isFault(err) || attempt >= 3) {
        throw err;
      }
      await reload();
      resetKernel();
    }
  }
}

/** Is a step as it was last rebuilt, and everything it read of the model then still what is there now? */
function unchangedFor(was: CacheEntry, json: string, ctx: Ctx, off: string): boolean {
  if (was.json !== json || !was.reads || !was.delta || !was.input) {
    return false;
  }
  // (What a failed step says can depend on which steps are switched off.)
  if (was.error && was.off !== off) {
    return false;
  }
  for (const [key, value] of was.reads.one) {
    const at = key.indexOf('|');
    if (rawGet(ctx[key.slice(0, at) as keyof Ctx] as Map<string, unknown>, key.slice(at + 1)) !== value) {
      return false;
    }
  }
  for (const kind of was.reads.all) {
    const [a, b] = [rawEntries(ctx[kind] as Map<string, unknown>), was.input[kind] as Map<string, unknown>];
    if (a.length !== rawEntries(b).length || a.some(([key, value]) => rawGet(b, key) !== value || !rawHas(b, key))) {
      return false;
    }
  }

  return true;
}


// ------------------------------------------------------------------ public API

/** Each body's volume, area, centre of mass and box, measured on the solid (for its mass, in BIM). */
export async function bodyProperties(features: Feature[]): Promise<BodyProps[]> {
  const { ctx, numbers } = await run(features);
  const names = bodyNames(features, [...ctx.bodies.keys()], numbers);

  return [...ctx.bodies.entries()].map(([id, shape]) => {
    let volume = 0;
    let center: Vec3 = [0, 0, 0];
    try {
      const properties = volumeProperties(shape);
      volume = Math.abs(properties.volume);
      center = properties.centerOfMass;
    } catch {
      // an open surface: no volume
    }
    let area = 0;
    try {
      area = trueArea(shape);
    } catch {
      area = 0;
    }
    const [lo, hi] = shape.boundingBox.bounds as [Vec3, Vec3];

    return { id, name: names.get(id) ?? id, volume, area, center, box: [lo, hi] };
  });
}

/** Each body's health: valid, closed, solids, faces, volume (for checking a model from the console or the command line). */
export async function bodyHealth(features: Feature[]): Promise<BodyHealth[]> {
  const { ctx, numbers } = await run(features);
  const names = bodyNames(features, [...ctx.bodies.keys()], numbers);

  return [...ctx.bodies.entries()].map(([id, shape]) => healthReport(id, names.get(id) ?? id, shape));
}

/** One body's health (also for tests and scripts that hold the solid). */
export function healthReport(id: string, name: string, shape: Shape3D): BodyHealth {
  const health = healthOf(shape);
  let edges = 0;
  let box: [Vec3, Vec3] = [[0, 0, 0], [0, 0, 0]];
  try {
    edges = shape.edges.length;
    box = shape.boundingBox.bounds as [Vec3, Vec3];
  } catch {
    // a broken shape: what healthOf found is the news
  }

  return { id, name, ...health, edges, box, healthy: isHealthy(health) };
}

/**
 * Drawings: the bodies seen along each view's direction, with hidden line
 * removal (OpenCascade's exact HLR), each body's edges kept apart so a balloon
 * can point at it. Edges come out as SVG path data in mm, y down.
 */
export async function projectViews(features: Feature[], views: ViewSpec[], only?: string[], method: 'auto' | 'exact' | 'mesh' = 'auto'): Promise<ProjectedView[]> {
  // Threads are drawn the way drawings show them (ISO 6410): the plain round
  // face, and a thin line at the thread's depth. Modelled, a valve's six
  // threads took the hidden line removal minutes.
  const threads = features.filter((feature): feature is Extract<Feature, { type: 'thread' }> => feature.type === 'thread' && !feature.suppressed);
  let ctx: Ctx;
  if (!threads.length) {
    ctx = (await run(features)).ctx;
  } else {
    const keep = cache;
    cache = drawingCache;
    alsoCache = keep;
    try {
      ctx = (await run(features.map(feature => (feature.type === 'thread' && !feature.suppressed ? { ...feature, suppressed: true } : feature)))).ctx;
    } finally {
      drawingCache = cache;
      cache = keep;
      alsoCache = [];
    }
  }
  const bodies = [...ctx.bodies.entries()].filter(([id]) => !only || only.includes(id));
  const marks = threadMarks(threads, ctx);
  const withMarks = (out: ProjectedView[], views: ViewSpec[]) => {
    out.forEach((pv, viewIndex) =>
      pv.bodies.forEach((vb) => {
        for (const mark of marks.filter(threadMark => threadMark.body === vb.id)) {
          const line = threadLines(mark, views[viewIndex], vb.edges);
          if (!line) {
            continue;
          }
          if (line.seen) {
            vb.tangent += line.d;
          } else {
            vb.hidden += line.d;
          }
        }
      })
    );

    return out;
  };
  // Section views: the bodies cut, each on its own.
  const plain = views.filter(view => !view.cut);
  const drawn = new Map<ViewSpec, ProjectedView>();
  if (plain.length) {
    withMarks(drawViews(bodies, plain, method), plain).forEach((pv, withMarkIndex) => drawn.set(plain[withMarkIndex], pv));
  }
  for (const view of views) {
    if (view.cut) {
      drawn.set(view, sectionView(bodies, view, method));
    }
  }

  return views.map(view => drawn.get(view)!);
}

/**
 * A section view: each body cut by the plane through `cut` square to the
 * view, the part between the eye and the plane taken off. The faces the cut
 * makes come back as closed outlines, to hatch; hidden lines aren't drawn in
 * a section (ISO 128-40).
 */
function sectionView(bodies: [string, Shape3D][], viewSpec: ViewSpec, method: 'auto' | 'exact' | 'mesh'): ProjectedView {
  const direction = norm(viewSpec.dir as Vec3);
  const look = scale(direction, -1);
  const xAxis = norm(viewSpec.xAxis as Vec3);
  const yAxis = cross(direction, xAxis);
  const at = viewSpec.cut as Vec3;
  const to2 = (point: Vec3): [number, number] => [dot(point, xAxis), -dot(point, yAxis)];
  const cut: [string, Shape3D][] = [];
  const faces = new Map<string, string>();
  for (const [id, shape] of bodies) {
    let part: Shape3D;
    try {
      part = shape.intersect(halfSpace({ origin: at, xDir: xDirFor(look), normal: look }, shape));
    } catch {
      continue;
    }
    if (isEmpty(part)) {
      continue;
    }
    cut.push([id, part]);
    let path = '';
    for (const face of part.faces) {
      if (face.geomType !== 'PLANE') {
        continue;
      }
      const pl = planeOf(face);
      if (Math.abs(Math.abs(dot(pl.normal, look)) - 1) > 1e-6 || Math.abs(dot(sub(pl.origin, at), look)) > 1e-4) {
        continue;
      }
      path += closedLoops(face.edges.map(e => edgePoints(e).map(to2)));
    }
    if (path) {
      faces.set(id, path);
    }
  }
  if (!cut.length) {
    return { id: viewSpec.id, bodies: [], box: null };
  }
  const [pv] = drawViews(cut, [{ ...viewSpec, cut: undefined }], method);
  for (const b of pv.bodies) {
    b.hidden = '';
    delete b.under;
    const faceSvg = faces.get(b.id);
    if (faceSvg) {
      b.section = faceSvg;
    }
  }

  return pv;
}

/** An edge's points in space: its ends for a line, more along a curve. */
function edgePoints(e: Edge): Vec3[] {
  const oc = getOC();
  const ad = new oc.BRepAdaptor_Curve(e.wrapped as never);
  try {
    const u0 = ad.FirstParameter();
    const u1 = ad.LastParameter();
    const at = (param: number): Vec3 => {
      const curvePoint = ad.Value(param);
      const point: Vec3 = [curvePoint.X(), curvePoint.Y(), curvePoint.Z()];
      curvePoint.delete();

      return point;
    };
    if (ad.GetType() === oc.GeomAbs_CurveType.GeomAbs_Line) {
      return [at(u0), at(u1)];
    }
    let length = 0;
    for (let i = 1; i <= 8; i++) {
      length += dist(at(u0 + ((u1 - u0) * (i - 1)) / 8), at(u0 + ((u1 - u0) * i) / 8));
    }
    const samples = Math.max(8, Math.min(96, Math.ceil(length / 0.5)));

    return Array.from({ length: samples + 1 }, (_, i) => at(u0 + ((u1 - u0) * i) / samples));
  } finally {
    ad.delete();
  }
}

/** Edges (as point runs, any order and way round) joined end to end into closed outlines: SVG path data. */
export function closedLoops(runs: [number, number][][]): string {
  const left = runs.filter(run => run.length > 1);
  const same = (a: [number, number], b: [number, number]) => Math.abs(a[0] - b[0]) < 1e-3 && Math.abs(a[1] - b[1]) < 1e-3;
  let pathData = '';
  while (left.length) {
    const loop = [...left.shift()!];
    for (let grew = true; grew && !same(loop[0], loop[loop.length - 1]); ) {
      grew = false;
      const end = loop[loop.length - 1];
      const i = left.findIndex(run => same(run[0], end) || same(run[run.length - 1], end));
      if (i < 0) {
        break;
      }
      const taken = left.splice(i, 1)[0];
      loop.push(...(same(taken[0], end) ? taken : [...taken].reverse()).slice(1));
      grew = true;
    }
    pathData += loop.map((point, i) => `${i ? 'L' : 'M'}${r3(point[0])} ${r3(point[1])}`).join('') + 'Z';
  }

  return pathData;
}

/** Views drawn the usual way: exact hidden line removal, or from the meshes for freeform or very big models. */
function drawViews(bodies: [string, Shape3D][], views: ViewSpec[], method: 'auto' | 'exact' | 'mesh'): ProjectedView[] {
  // Freeform faces (or a great many faces) take the exact hidden line removal
  // seconds to minutes a view: those models are drawn from their meshes.
  const meshes = bodies.map(([id, shape]) => ({ id, shape: shape, mesh: drawingMesh(id, shape) }));
  const faces = meshes.reduce((total, mesh) => total + mesh.mesh.faces.length, 0);
  const free = meshes.reduce((total, mesh) => total + freeformFaces(mesh.mesh), 0);
  const how = method === 'auto' ? (free > 0 || faces > 600 ? 'mesh' : 'exact') : method;
  if (how === 'mesh') {
    return meshViews(meshes, views);
  }
  const oc = getOC();

  return views.map((view) => {
    const cam = new ProjectionCamera([0, 0, 0], view.dir, view.xAxis);
    const algo = new oc.HLRBRep_Algo();
    for (const [, shape] of bodies) {
      algo.Add(shape.wrapped, 0);
    }
    const projector = new oc.HLRAlgo_Projector(cam.wrapped);
    algo.Projector(projector);
    algo.Update();
    algo.Hide();
    const out = new oc.HLRBRep_HLRToShape(algo);
    let lo: [number, number] = [Infinity, Infinity];
    let hi: [number, number] = [-Infinity, -Infinity];
    // Hidden edges lying exactly under seen ones (the back of a box, seen
    // straight on) are left out: they would only be drawn over.
    const drawn = new Set<string>();
    const key = (a: [number, number], b: [number, number]) => {
      const [from, q] = [`${r3(a[0])} ${r3(a[1])}`, `${r3(b[0])} ${r3(b[1])}`].sort();

      return `${from}|${q}`;
    };
    const result: ViewBody[] = bodies.map(([id, bodyShape]) => {
      const seen: [number, number][][] = [];
      const edges: ViewEdge[] = [];
      const paths = (parts: unknown[], keep: boolean) => {
        let pathData = '';
        for (const part of parts) {
          const shape = part as { IsNull(): boolean };
          if (shape.IsNull()) {
            continue;
          }
          for (const e of (cast(shape as never) as AnyShape).edges) {
            oc.BRepLib.BuildCurves3d(e.wrapped as never);
            const { pts, kind } = edgeSamples(e);
            const edgeKey = key(pts[0], pts[pts.length - 1]);
            if (keep) {
              drawn.add(edgeKey);
            } else if (pts.length === 2 && drawn.has(edgeKey)) {
              continue;
            }
            for (const point of pts) {
              lo = [Math.min(lo[0], point[0]), Math.min(lo[1], point[1])];
              hi = [Math.max(hi[0], point[0]), Math.max(hi[1], point[1])];
            }
            if (keep) {
              seen.push(pts);
              const edge = viewEdge(kind, pts);
              if (edge) {
                edges.push(edge);
              }
            }
            pathData += pts.map((point, i) => `${i ? 'L' : 'M'}${r3(point[0])} ${r3(point[1])}`).join('');
          }
        }

        return pathData;
      };
      const wrapped = bodyShape.wrapped;
      const visible = paths([out.VCompound(wrapped), out.OutLineVCompound(wrapped)], true);
      const tangent = paths([out.Rg1LineVCompound(wrapped)], true);

      return { id, visible, tangent, hidden: '', anchor: anchorOf(seen), edges };
    });
    // Hidden edges once every body's seen ones are known. A body hidden
    // whole (inside a housing) still gets a spot a balloon can point at.
    bodies.forEach(([, shape], i) => {
      let hiddenPath = '';
      const under: [number, number][][] = [];
      for (const part of [out.HCompound(shape.wrapped), out.OutLineHCompound(shape.wrapped)]) {
        if (part.IsNull()) {
          continue;
        }
        for (const e of (cast(part) as AnyShape).edges) {
          oc.BRepLib.BuildCurves3d(e.wrapped as never);
          const { pts } = edgeSamples(e);
          if (pts.length === 2 && drawn.has(key(pts[0], pts[1]))) {
            continue;
          }
          if (!result[i].anchor) {
            under.push(pts);
          }
          hiddenPath += pts.map((point, j) => `${j ? 'L' : 'M'}${r3(point[0])} ${r3(point[1])}`).join('');
        }
      }
      result[i].hidden = hiddenPath;
      if (!result[i].anchor && under.length) {
        result[i].under = anchorOf(under);
      }
    });
    out.delete();
    projector.delete();
    algo.delete();
    cam.delete();

    return { id: view.id, bodies: result, box: lo[0] <= hi[0] ? [lo, hi] : null };
  });
}

const r3 = (value: number) => String(Math.round(value * 1000) / 1000);

/** A thread as a drawing marks it: its round face's axis and length, and the radius of its thin line. */
type ThreadMark = { body: string; c: Vec3; a: Vec3; r: number; rc: number; t0: number; t1: number };

/** Where the threads are, on the plain bodies (a face that moved since its thread step is left unmarked). */
function threadMarks(threads: Extract<Feature, { type: 'thread' }>[], ctx: Ctx): ThreadMark[] {
  const out: ThreadMark[] = [];
  for (const thread of threads) {
    const body = ctx.bodies.get(thread.face.body);
    if (!body) {
      continue;
    }
    try {
      const face = threadTarget(body, thread);
      const cy = cylinderOf(face);
      if (!cy) {
        continue;
      }
      const a = norm(cy.a);
      const ts: number[] = [];
      for (const e of face.edges) {
        for (const fraction of [0, 0.5, 1]) {
          ts.push(dot(sub(e.pointAt(fraction).toTuple() as Vec3, cy.c), a));
        }
      }
      const inside = cy.s < 0;
      const depth = threadDepth(thread.pitch, inside);
      out.push({ body: thread.face.body, c: cy.c, a, r: cy.r, rc: inside ? cy.r + depth : cy.r - depth, t0: Math.min(...ts), t1: Math.max(...ts) });
    } catch {
      // Not found: no mark.
    }
  }

  return out;
}

/**
 * A thread's thin line in a view, as path data: along its axis, two lines at
 * the thread's depth (seen where the round face's outline is); looking down
 * it, three quarters of a circle (seen where its edge circle is).
 */
function threadLines(threadMark: ThreadMark, viewSpec: ViewSpec, edges: ViewEdge[]): { d: string; seen: boolean } | null {
  const direction = norm(viewSpec.dir);
  const xAxis = norm(viewSpec.xAxis);
  const yAxis = cross(direction, xAxis);
  const to2 = (point: Vec3): [number, number] => [dot(point, xAxis), -dot(point, yAxis)];
  const along = Math.abs(dot(threadMark.a, direction));
  const tol = Math.max(0.02, threadMark.r * 0.02);
  if (along < 1e-6) {
    const p0 = to2(add(threadMark.c, scale(threadMark.a, threadMark.t0)));
    const p1 = to2(add(threadMark.c, scale(threadMark.a, threadMark.t1)));
    const along = norm([p1[0] - p0[0], p1[1] - p0[1], 0]);
    const normal: [number, number] = [-along[1], along[0]];
    let path = '';
    let seen = false;
    for (const sgn of [1, -1]) {
      const off = (point: [number, number], offset: number): [number, number] => [point[0] + normal[0] * offset * sgn, point[1] + normal[1] * offset * sgn];
      // The round face's outline on this side, among the seen straight edges.
      const o0 = off(p0, threadMark.r);
      const across = (q: [number, number]) => Math.abs((q[0] - o0[0]) * normal[0] + (q[1] - o0[1]) * normal[1]);
      if (edges.some(e => !('m' in e) && across(e.a) < tol && across(e.b) < tol)) {
        seen = true;
      }
      const [a, b] = [off(p0, threadMark.rc), off(p1, threadMark.rc)];
      path += `M${r3(a[0])} ${r3(a[1])}L${r3(b[0])} ${r3(b[1])}`;
    }

    return { d: path, seen };
  }
  if (along > 1 - 1e-6) {
    // The end the view looks at.
    const near = dot(threadMark.a, direction) > 0 ? threadMark.t0 : threadMark.t1;
    const center = to2(add(threadMark.c, scale(threadMark.a, near)));
    const seen = edges.some(e => 'm' in e && Math.abs(e.r - threadMark.r) < tol && Math.hypot(e.c[0] - center[0], e.c[1] - center[1]) < tol);
    const segments = 48;
    const pts = Array.from({ length: segments + 1 }, (_, i) => {
      const t = (i / segments) * 1.5 * Math.PI;

      return [center[0] + threadMark.rc * Math.cos(t), center[1] - threadMark.rc * Math.sin(t)];
    });

    return { d: pts.map((point, i) => `${i ? 'L' : 'M'}${r3(point[0])} ${r3(point[1])}`).join(''), seen };
  }

  return null;
}

/**
 * Points along a projected edge (y flipped, for the paper): a line's two
 * ends, a curve sampled finely enough to print - read from one curve adaptor
 * (a drawing of a big assembly has thousands of edges).
 */
function edgeSamples(e: Edge): { pts: [number, number][]; kind: 'line' | 'circle' | 'other' } {
  const oc = getOC();
  const ad = new oc.BRepAdaptor_Curve(e.wrapped as never);
  try {
    const curveTypes = oc.GeomAbs_CurveType;
    const type = ad.GetType();
    const u0 = ad.FirstParameter();
    const u1 = ad.LastParameter();
    const at = (param: number): [number, number] => {
      const curvePoint = ad.Value(param);
      const point: [number, number] = [curvePoint.X(), -curvePoint.Y()];
      curvePoint.delete();

      return point;
    };
    if (type === curveTypes.GeomAbs_Line) {
      return { pts: [at(u0), at(u1)], kind: 'line' };
    }
    // As many points as its length asks for (one every half millimetre, 8 to 96).
    let len = 0;
    let prev = at(u0);
    for (let i = 1; i <= 8; i++) {
      const q = at(u0 + ((u1 - u0) * i) / 8);
      len += Math.hypot(q[0] - prev[0], q[1] - prev[1]);
      prev = q;
    }
    const samples = Math.max(8, Math.min(96, Math.ceil(len / 0.5)));

    return { pts: Array.from({ length: samples + 1 }, (_, i) => at(u0 + ((u1 - u0) * i) / samples)), kind: type === curveTypes.GeomAbs_Circle ? 'circle' : 'other' };
  } finally {
    ad.delete();
  }
}

export async function exportBodies(features: Feature[], format: ExportFormat, only?: string[]): Promise<Blob> {
  const { ctx, numbers } = await run(features);
  const shapes = [...ctx.bodies.entries()].filter(([id]) => !only || only.includes(id));
  if (shapes.length === 0) {
    throw new Error('Nothing to export');
  }
  const names = bodyNames(features, [...ctx.bodies.keys()], numbers);
  if (format === 'mesh') {
    // As fine as the STL (the view's own mesh is coarser, for speed).
    const out = shapes.map(([id, shape]) => {
      const faceMesh = printMesh(shape);

      return { id, positions: Array.from(faceMesh.vertices), indices: Array.from(faceMesh.triangles) };
    });

    return new Blob([JSON.stringify(out)], { type: 'application/json' });
  }
  if (format === 'step') {
    return exportSTEP(shapes.map(([id, shape]) => ({ shape, name: names.get(id)! })));
  }

  // (Written here from the bodies' own meshes: OpenCascade's writer meshes them
  // all as one shape first - gigabytes for a body of thousands of faces.)
  return new Blob([binarySTL(shapes.map(([, shape]) => printMesh(shape))) as BlobPart], { type: 'application/sla' });
}

/**
 * A body's mesh for printing - of a copy of it: meshed itself, the body kept
 * those triangles (ten times the view's, megabytes on a part of a few hundred
 * faces) for as long as it was there, and every later copy of it carried them.
 * Kept here with the body instead, for the next file made of it.
 */
const printMeshes = new WeakMap<Shape3D, FaceMesh>();
function printMesh(shape: Shape3D): FaceMesh {
  let faceMesh = printMeshes.get(shape);
  if (!faceMesh) {
    printMeshes.set(shape, (faceMesh = meshFaces(deepCopy(shape), PRINT_TOLERANCE, PRINT_ANGLE)));
  }

  return faceMesh;
}

/**
 * How finely a mesh for printing (STL, 3MF) follows curved surfaces: within
 * 0.01 mm, and a facet per 0.05 rad (under 3°). Slicers draw each facet flat,
 * so round faces showed as polygons at the view's coarser setting.
 */
const PRINT_TOLERANCE = 0.01;
const PRINT_ANGLE = 0.05;

export async function regenerate(features: Feature[], saved = false): Promise<RegenResult> {
  const t0 = performance.now();
  const { ctx, errors, numbers, notes, whole } = await run(features, saved);
  const names = bodyNames(features, [...ctx.bodies.keys()], numbers);
  const meshes: BodyMesh[] = [];
  for (const [id, shape] of ctx.bodies) {
    try {
      meshes.push(meshBody(id, names.get(id)!, shape));
    } catch (err) {
      if (isFault(err)) {
        // The last step that changed this body is the one whose result can't be shown.
        let index = cache.length - 1;
        while (index > 0 && cache[index - 1].ctx.bodies.get(id) === shape) {
          index--;
        }
        if (cache[index]) {
          blame(cache[index].key);
        }
        throw new KernelFault(features[index]?.id ?? baseId(id));
      }
      errors.push({ featureId: baseId(id), message: `Could not display body: ${errorText(err)}` });
    }
  }
  const sketchPlanes: Record<string, PlaneDef> = {};
  const sketchBoundaries: Record<string, SketchEntity[]> = {};
  // Sketches that follow a body: their curves where the engine put them (the page takes them as the sketch's own).
  let sketchEntities: Record<string, SketchEntity[]> | undefined;
  const asGiven = new Map(features.map(feature => [feature.id, feature]));
  for (const [id, sketch] of ctx.sketches) {
    sketchPlanes[id] = sketch.plane;
    if (sketch.boundary.length) {
      sketchBoundaries[id] = sketch.boundary;
    }
    const feature = asGiven.get(id);
    if (feature?.type === 'sketch' && feature.links?.length && sketch.entities !== feature.entities && JSON.stringify(sketch.entities) !== JSON.stringify(feature.entities)) {
      (sketchEntities ??= {})[id] = sketch.entities;
    }
  }

  return { bodies: meshes, errors, notes, sketchPlanes, sketchBoundaries, ...(sketchEntities ? { sketchEntities } : {}), ...(whole ? { whole } : {}), planes: [...ctx.planes.values()], axes: [...ctx.axes.values()], ms: performance.now() - t0 };
}

/** The solids of the last rebuild (for tests that check the real geometry, not just its mesh). */
let lastBodies: Map<string, Shape3D> = new Map();
export function debugBodies(): Map<string, Shape3D> {
  return lastBodies;
}

/**
 * Replay features in order. Results are cached per feature, keyed by the JSON
 * of every feature up to it, so editing feature k only rebuilds k onwards.
 */
async function run(features: Feature[], saved = false) {
  rebuild.stepsNow = new Set(features.map(feature => feature.id));
  useSafeBooleans();
  useReleases();
  // Steps after the History's breakpoint: off, like suppressed ones.
  if (features.some(feature => feature.rolledBack)) {
    features = features.map(feature => (feature.rolledBack && !feature.suppressed ? { ...feature, suppressed: true } : feature));
  }
  // Edit Freeform steps: put into the freeforms they edit (those build with the new cage).
  features = applyFreeformEdits(features);
  editable = new Set(features.filter(feature => (feature.type === 'freeform' || feature.type === 'faceFreeform') && !feature.suppressed).map(feature => feature.id));
  const errors: FeatureError[] = [];
  const notes: FeatureError[] = [];
  let ctx: Ctx = fork({ bodies: new Map(), sketches: new Map(), planes: new Map(), axes: new Map(), freeforms: new Map(), sweeps: new Map(), links: new Map() });
  rebuild.switchedOff = new Set(features.filter(feature => feature.suppressed).map(feature => feature.id));
  const off = [...rebuild.switchedOff].sort().join();
  // The steps as last rebuilt (by step, wherever in the list they are now).
  const before = new Map<string, CacheEntry>();
  for (const e of [...cache, ...savedCache, ...alsoCache]) {
    if (e.id && !before.has(e.id)) {
      before.set(e.id, e);
    }
  }
  rebuildStats.ran = rebuildStats.kept = rebuildStats.reused = 0;
  smoothSteps = new Set(features.filter(feature => feature.type === 'faceFreeform').map(feature => feature.id));
  let key = '';
  const next: CacheEntry[] = [];
  let hit = true;
  // Which of a step's faces is which, for the steps so far (a step looking for
  // the face it was built on asks; so does the mesh, for what gets picked next).
  const origins = new Map<string, OriginOf>();
  setOrigins(origins);

  for (let i = 0; i < features.length; i++) {
    const feature = features[i];
    // Chained hashes, not the text itself: a key holding every step's JSON
    // grew with the square of the project (an import's megabytes in each one).
    // (A step's `whole` is what it worked out the first time, taken in by the
    // page: not a change to build again for.)
    const text = JSON.stringify((feature.type === 'boolean' || feature.type === 'delete') && feature.whole ? { ...feature, whole: undefined } : feature, shortBig);
    const json = `${hash53(text, 3)}.${text.length}`;
    key = chainKey(key, text);
    const cached: CacheEntry | undefined = !hit ? undefined : cache[i]?.key === key ? cache[i] : savedCache[i]?.key === key ? savedCache[i] : alsoCache[i]?.key === key ? alsoCache[i] : undefined;
    hit = !!cached;
    let entry: CacheEntry;
    const was = before.get(feature.id);
    if (cached) {
      entry = cached;
      rebuildStats.kept++;
    } else if (was && !feature.suppressed && !crashed.has(key) && unchangedFor(was, json, ctx, off)) {
      // Something before it changed, but nothing it read: its result as it was, on the model as it is now.
      const out = fork(ctx);
      for (const [kind, key, value, there] of was.delta!) {
        if (there) {
          Map.prototype.set.call(out[kind], key, value);
        } else {
          Map.prototype.delete.call(out[kind], key);
        }
      }
      entry = { ...was, key, ctx: out, input: ctx };
      rebuildStats.reused++;
    } else {
      const out = fork(ctx);
      entry = { key, ctx: out, id: feature.id, json, off, input: ctx };
      rebuildStats.ran++;
      if (!feature.suppressed) {
        const reads: Reads = { one: new Map(), all: new Set(), written: new Set() };
        entry.reads = reads;
        try {
          editNotes.length = 0;
          sameSizesAgain();
          if (crashed.has(key)) {
            throw new Error(crashed.get(key));
          }
          if (damaged(feature)) {
            throw new Error(DAMAGED_TEXT);
          }
          reading = reads;
          const touched = touchedBodies(feature, ctx);
          // An edit works on copies of the bodies it may touch: OpenCascade is
          // allowed to adjust the shapes it is given, and the earlier steps'
          // results (kept in the cache) must never change - not even when this
          // step fails. Bodies it leaves alone get their originals back.
          const copies = new Map<string, Shape3D>();
          if (GUARDED.has(feature.type)) {
            for (const id of touched) {
              const b = out.bodies.get(id);
              if (!b || out.freeforms.has(id)) {
                continue;
              }
              const shape = deepCopy(b);
              inheritTags(b, shape);
              // (The same shape: its volume is known - a big body's, measured
              // again on every step's copy, was a quarter of a small cut's time.)
              const volume = volumes.get(b);
              if (volume !== undefined) {
                volumes.set(shape, volume);
              }
              copies.set(id, shape);
              out.bodies.set(id, shape);
            }
          }
          await apply(feature, out);
          entry.origin = originsOf(feature, out);
          reading = null;
          if (entry.origin) {
            origins.set(feature.id, entry.origin);
          }
          for (const [id, copy] of copies) {
            if (out.bodies.get(id) === copy) {
              out.bodies.set(id, ctx.bodies.get(id)!);
            }
          }
          // Nothing kilometres across, or away: a typo (a size with six noughts
          // too many), and more than the engine or the view can work with.
          for (const [id, after] of out.bodies) {
            if (after === ctx.bodies.get(id)) {
              continue;
            }
            // (The quick box first - never smaller than the body: its exact one, up to a second for a curved body
            // and asked after every step, only for a body that may be over a limit.)
            let [lo, hi] = looseBox(after) as [number[], number[]];
            if (!(Math.max(...lo.map(Math.abs), ...hi.map(Math.abs)) < MAX_REACH) || Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) < 1e-2) {
              [lo, hi] = after.boundingBox.bounds;
            }
            const reach = Math.max(...lo.map(Math.abs), ...hi.map(Math.abs));
            // (An empty result has an upside-down box: left to the checks below.)
            if (lo[0] <= hi[0] && !(reach < MAX_REACH)) {
              throw new Error('This would reach more than 10 km from the origin - check its values (a typo?)');
            }
            // ...and nothing scaled away to a speck (a factor of 0.0000008).
            if (lo[0] <= hi[0] && Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) < 1e-4) {
              throw new Error('This would be smaller than a ten-thousandth of a mm - check its values (a typo?)');
            }
          }
          // Every edit of a solid ends in one: checked (and tidied) before it counts.
          if (GUARDED.has(feature.type)) {
            for (const [id, after] of [...out.bodies]) {
              const before = ctx.bodies.get(id);
              if (after === before) {
                continue;
              }
              // A freeform left as an open surface (a sheet) isn't a solid to check; a solid
              // freeform is - its edits are checked like any body's.
              if (before && (out.freeforms.has(id) || ctx.freeforms.has(id)) && !subShapes(before, 'SOLID').length) {
                continue;
              }
              // Offsetting a face of the body itself is a face move: it doesn't split it either.
              const inPlace = feature.type === 'extrude' && feature.source.kind === 'face' && feature.mode !== 'new' && feature.target === feature.source.face.body;
              let kept: Shape3D | null;
              try {
                kept = guardEdit(before, after, !NO_SPLIT.has(feature.type) && !inPlace, feature.type !== 'fillet' && feature.type !== 'chamfer');
              } catch (err) {
                // Rounds or chamfers that tear the body open ran into each other (a
                // cookie cutter's 1.2 wall, both its top edges rounded 1): a flat face
                // patched over the gap isn't what was asked for - said, not repaired.
                if ((feature.type === 'fillet' || feature.type === 'chamfer') && !isFault(err) && /tear the body open/.test(errorText(err))) {
                  throw new Error(feature.type === 'fillet' ? EDGES_CLASH.replace('@', 'rounds') : EDGES_CLASH.replace('@', 'chamfers'));
                }
                // A shell that came out torn or broken: its walls ran into each other ("would tear the body open" said nothing of walls).
                if (feature.type !== 'shell' || isFault(err)) {
                  throw err;
                }
                throw new Error(/break the body into pieces/.test(errorText(err)) ? SHELL_LOOSE : WALLS_CLASH);
              }
              // Cut away to dust: the body is gone.
              if (kept) {
                out.bodies.set(id, kept);
              } else {
                out.bodies.delete(id);
              }
            }
          }
          // Which step made each face: kept from what it was made from, this step's own otherwise.
          // (Bodies the step names; the others were only there - see tagBody.)
          const named = touchedBodies(feature, ctx, false);
          const from = [...named.map(id => ctx.bodies.get(id)!), ...named.flatMap(id => (copies.has(id) ? [copies.get(id)!] : []))];
          const others = touched.filter(id => !named.includes(id)).map(id => ctx.bodies.get(id)!);
          for (const [id, body] of out.bodies) {
            const was = ctx.bodies.get(id);
            if (body !== was) {
              tagBody(body, feature.id, was ? [was, ...from] : from, was ? others.filter(other => other !== was) : others);
            }
          }
          // Linked bodies: the others of a changed one's group follow it. (Any change among the links is a change
          // for this step: it is built again then.)
          // (A pattern of a hole changes its body's shape, as a cut does: the body's linked ones follow.)
          if (feature.type !== 'transform' || feature.hole) {
            reads.all.add('links');
            followLinks(feature.id, ctx, out);
          }
          if (editNotes.length) {
            entry.note = [...new Set(editNotes)].join(' ');
          }
          // Anything but a move/scale changing a freeform body makes it an ordinary body.
          if (feature.type !== 'freeform' && feature.type !== 'transform') {
            for (const id of [...out.freeforms.keys()]) {
              if (out.bodies.get(id) !== ctx.bodies.get(id)) {
                out.freeforms.delete(id);
              }
            }
          }
        } catch (err) {
          reading = null;
          if (isFault(err)) {
            blame(key);
            console.error(err);
            throw new KernelFault(feature.id);
          }
          entry.error = errorText(err);
          const sketches = feature.type === 'sketch' ? new Noted('sketches', ctx.sketches) : ctx.sketches;
          if (feature.type === 'sketch') {
            Map.prototype.set.call(sketches, feature.id, { ...feature, boundary: [] });
          }
          entry.ctx = { ...ctx, sketches };
        }
        // What it changed in the model (and each of those as it was is something it went by).
        entry.delta = [];
        for (const kind of KINDS) {
          const [a, b] = [entry.ctx[kind] as Map<string, unknown>, ctx[kind] as Map<string, unknown>];
          if (a === b) {
            continue;
          }
          for (const key of new Set([...rawEntries(a).map(rawEntry => rawEntry[0]), ...rawEntries(b).map(rawEntry => rawEntry[0])])) {
            if (rawGet(a, key) === rawGet(b, key) && rawHas(a, key) === rawHas(b, key)) {
              continue;
            }
            entry.delta.push([kind, key, rawGet(a, key), rawHas(a, key)]);
            if (!reads.one.has(`${kind}|${key}`)) {
              reads.one.set(`${kind}|${key}`, rawGet(b, key));
            }
          }
        }
      }
    }
    if (entry.origin) {
      origins.set(feature.id, entry.origin);
    }
    if (entry.error) {
      errors.push({ featureId: feature.id, message: entry.error });
    }
    if (entry.note && !entry.error) {
      notes.push({ featureId: feature.id, message: entry.note });
    }
    ctx = entry.ctx;
    next.push(entry);
  }
  cache = next;
  if (saved) {
    savedCache = next;
  }
  lastBodies = ctx.bodies;
  // Steps that don't say yet which patterns they used whole: as they were made.
  let whole: Record<string, string[]> | undefined;
  features.forEach((feature, i) => {
    if ((feature.type !== 'boolean' && feature.type !== 'delete') || feature.whole || feature.suppressed) {
      return;
    }
    const ids: unknown = feature.type === 'boolean' ? feature.tools : feature.bodies;
    const there = next[i]?.input?.bodies;
    // (Not for a step that failed: its saved values may be damaged.)
    if (there && !next[i].error && Array.isArray(ids) && ids.every(id => typeof id === 'string')) {
      (whole ??= {})[feature.id] = wholeOf(ids, new Set(rawEntries(there).map(([key]) => key)));
    }
  });
  // Bodies are numbered in the order they first appeared (a body that's
  // deleted later keeps its number used, so the others don't change names).
  const numbers = new Map<string, number>();
  for (const e of next) {
    for (const id of e.ctx.bodies.keys()) {
      if (!numbers.has(id)) {
        numbers.set(id, numbers.size + 1);
      }
    }
  }

  return { ctx, errors, numbers, notes, whole };
}

async function apply(feature: Feature, ctx: Ctx): Promise<void> {
  const { bodies } = ctx;
  switch (feature.type) {
    case 'sketch':
      return applySketch(feature, ctx);

    case 'extrude':
      return applyExtrude(feature, ctx);

    case 'revolve':
      return applyRevolve(feature, ctx);

    case 'sweep':
      return applySweep(feature, ctx);

    case 'loft':
      return applyLoft(feature, ctx);

    case 'fillet':
    case 'chamfer':
      return applyFilletOrChamfer(feature, ctx);

    case 'shell':
      return applyShell(feature, ctx);

    case 'boolean':
      return applyBoolean(feature, ctx);

    case 'transform':
      transform(feature, ctx);

      return;

    case 'split':
      return applySplit(feature, ctx);

    case 'plane': {
      let plane = feature.plane;
      if (feature.face) {
        const body = bodies.get(feature.face.body);
        if (body) {
          const info = faceInfo(resolveFace(body, feature.face));
          if (info.plane) {
            plane = { ...info.plane, xDir: dot(info.plane.normal, feature.plane.normal) > 0.999 ? feature.plane.xDir : info.plane.xDir };
          }
        }
      }
      plane = { ...plane, origin: add(plane.origin, scale(plane.normal, feature.offset)) };
      // (Older projects: how it was made, from its name.)
      const kind = feature.kind ?? (/^Midplane/.test(feature.name) ? 'mid' : /3 Points/.test(feature.name) ? '3pt' : /Perp/.test(feature.name) ? 'perp' : /on Curve/.test(feature.name) ? 'curve' : /Angle/.test(feature.name) ? 'angle' : /Parallel/.test(feature.name) ? 'parallel' : 'offset');
      ctx.planes.set(feature.id, { id: feature.id, name: feature.name, plane, kind });

      return;
    }

    case 'axis':
      ctx.axes.set(feature.id, { id: feature.id, name: feature.name, plane: { origin: feature.origin, normal: norm(feature.dir), xDir: xDirFor(norm(feature.dir)) } });

      return;

    case 'import':
      return applyImport(feature, ctx);

    case 'delete':
      for (const b of bodyList(feature.bodies, bodies, 'bodies', feature.whole)) {
        bodies.delete(b);
      }

      return;

    case 'image':
      return; // drawn by the UI only

    case 'freeformEdit':
      // (Put into its freeform before the rebuild: nothing more to do here.)
      if (!editable.has(feature.target)) {
        throw new Error('The freeform this edits is gone (deleted, or switched off)');
      }

      return;

    case 'freeform':
      bodies.set(feature.id, freeformShape(feature, AFFINE_ID));
      ctx.freeforms.set(feature.id, { feature: feature, m: AFFINE_ID });

      return;

    case 'scaleFace': {
      const body = need(bodies, feature.face.body);
      bodies.set(feature.face.body, staysClosed(body, scaleFace(body, resolveFace(body, feature.face), feature.u, feature.factors)));

      return;
    }

    case 'faceFreeform':
      return applyFaceFreeform(feature, ctx);

    case 'replaceFace':
      return applyReplaceFace(feature, ctx);

    case 'hole':
      return applyHole(feature, ctx);

    case 'thread':
      return applyThread(feature, ctx);

    case 'imprint': {
      const body = need(bodies, feature.body);
      if (feature.source) {
        const src = sourceFaces(feature.source, ctx);
        if (!src.length) {
          throw new Error('Nothing to project');
        }
        const normal = src[0].normal;
        bodies.set(feature.body, imprint(body, src.flatMap(source => source.face.edges), normal, seenFrom(body, src[0].face.center.toTuple() as Vec3, normal)));

        return;
      }
      if (!feature.edges?.length || !feature.face) {
        throw new Error('Pick the edges, then the face to project them onto');
      }
      const face = resolveFace(body, feature.face);
      const curves = feature.edges.map(edge => resolveEdge(need(bodies, edge.body), edge));
      bodies.set(feature.body, imprint(body, curves, face.normalAt(face.center).toTuple() as Vec3, linesOnFace(body, face)));

      return;
    }

    case 'wrap': {
      const body = need(bodies, feature.face.body);
      const round = resolveFace(body, feature.face, face => face.geomType === 'CYLINDRE');
      bodies.set(feature.face.body, wrapOnto(body, round, sourceFaces(feature.source, ctx), feature.height));

      return;
    }

    case 'connect':
      return applyConnect(feature, ctx);

    case 'fill': {
      bodies.set(feature.id, fillNetwork(feature, ctx));

      return;
    }

    case 'fillToPlane': {
      const sheet = need(bodies, feature.body);
      bodies.set(feature.body, fillToPlane(sheet, feature.plane));
      ctx.freeforms.delete(feature.body);

      return;
    }

    case 'repair':
      return applyRepair(feature, ctx);

    case 'deleteGeom':
      return applyDeleteGeom(feature, ctx);

    case 'moveFace':
      return applyMoveFace(feature, ctx);
  }
}

function applySketch(feature: SketchFeature, ctx: Ctx) {
  const { bodies } = ctx;
  const plane = feature.attachedTo ? followFace(feature, bodies) : feature.onPlane ? followPlane(feature, ctx) : feature.plane;
  // On a face, the face outline takes part in regions: a line across the face splits it.
  const outline = feature.attachedTo ? faceBoundary(feature.attachedTo, plane, bodies) : [];
  // Offsets of the outline, made from it as it is now (they follow the face).
  const boundary = [...outline, ...outlineOffsetCurves(outline, feature.outlineOffsets)];
  // Curves that follow a body's edge go where it is now, the rest by its dimensions to them.
  const entities = feature.links?.length ? followEdges(feature, plane, bodies) : feature.entities;
  const state: SketchState = { ...feature, entities, plane, boundary };
  // The same sketch as last time, to the last digit (the page took the
  // curves the engine moved as the sketch's own): it is that one, and
  // the steps made from it have nothing new to read.
  const text = JSON.stringify(state);
  const was = sketchWas.get(feature.id);
  if (was?.text === text) {
    ctx.sketches.set(feature.id, was.state);
  } else {
    sketchWas.set(feature.id, { text, state });
    ctx.sketches.set(feature.id, state);
  }
}

function applyExtrude(feature: ExtrudeFeature, ctx: Ctx) {
  const { bodies } = ctx;
  const ext = feature.extent ?? 'distance';
  if (ext === 'distance' && Math.abs(feature.distance) < 1e-6) {
    throw new Error('Distance is zero');
  }
  if (ext === 'to' && feature.symmetric) {
    throw new Error('Up to works one way only - switch Sides back to One side');
  }
  if (ext === 'to' && !feature.to?.face && !feature.to?.plane) {
    throw new Error('Pick the face or plane it goes up to');
  }
  // Where it starts: at the shape, or `start` from it along its normal.
  const startFaces = () => {
    const src = sourceFaces(feature.source, ctx);

    return feature.start ? src.map(({ face, normal }) => ({ face: face.clone().translate(scale(normal, feature.start!)) as Face, normal })) : src;
  };
  // Up to: the face (where it is now) or the plane it stops at.
  const upTo = ext === 'to' ? extrudeTarget(feature.to!, ctx) : null;
  // How far: the distance, or far enough to come out of everything (the way the distance's sign says, or towards the target).
  let distance = feature.distance;
  if (ext === 'through' && !ctx.bodies.size) {
    throw new Error('Through all goes through the bodies there are - there are none yet: set a Distance');
  }
  if (ext !== 'distance') {
    const src = startFaces();
    const reach = reachOf(ctx, src.map(source => source.face as unknown as Shape3D), upTo?.shape);
    const normal = src[0]?.normal ?? [0, 0, 1];
    const center = src[0]?.face.center.toTuple() as Vec3 | undefined;
    const way = upTo && center ? Math.sign(dot(sub(upTo.point, center), normal)) || 1 : Math.sign(feature.distance) || 1;
    distance = way * reach;
  }
  const plain = ext === 'distance' && !feature.start && !feature.draft;
  // Pushing/pulling a face of its own body offsets it: the neighbouring faces
  // extend along their own surfaces (a round side stays round).
  const tapered = feature.taper !== undefined && Math.abs(feature.taper - 1) > 1e-9;
  if (tapered && feature.symmetric) {
    throw new Error('Taper works one way only - switch Sides back to One side');
  }
  if (tapered) {
    // Sides leaning in (or out): each shape's outline to a scaled copy at the far end.
    // Pieces that meet are one shape first: a circle drawn on a small face
    // is split by the face's outline into a disc and a ring round it (the
    // ring was refused as "a shape with a hole", and each piece would have
    // shrunk towards its own middle).
    if (ext !== 'distance' || feature.draft) {
      throw new Error('Taper end % works with a set distance and no draft - set Taper end back to 100%');
    }
    const src = startFaces();
    const parts = mergedFaces(src.map(source => source.face), src[0]?.normal ?? [0, 0, 1]).map(face => ({ face, normal: src[0].normal })).map(({ face, normal }) => {
      // (replicad's outerWire() and innerWires() free the face they're asked
      // of: they're asked of copies.)
      const center = face.center.toTuple() as Vec3;
      if (face.clone().innerWires().length) {
        throw new Error('Taper works on shapes without holes');
      }
      const w0 = face.clone().outerWire();
      const taper = Math.max(0.002, feature.taper!);
      // Straight-edged shapes: flat sides (a loft makes them curved surfaces,
      // and then nothing that needs a flat face - sketch on it, move it - works).
      const flat = taperedPrism(face, center, normal, taper, distance);
      if (flat) {
        return flat;
      }
      const w1 = w0.clone().scale(taper, center).translate(scale(normal, distance));
      try {
        return loft([w0, w1], { ruled: true }) as Shape3D;
      } catch {
        throw new Error("This shape can't be tapered");
      }
    });
    combine(feature.id, feature.mode, feature.target, fuseAll(parts), distance < 0, ctx);

    return;
  }
  if (plain && feature.source.kind === 'face' && feature.mode !== 'new' && feature.mode !== 'intersect' && feature.target === feature.source.face.body && !feature.symmetric) {
    const body = need(bodies, feature.target);
    const face = resolveFace(body, feature.source.face);
    const distance = feature.mode === 'cut' ? -Math.abs(feature.distance) : feature.mode === 'join' ? Math.abs(feature.distance) : feature.distance;
    // The end of a sweep pushed in: shortened along its path, the new end
    // square to the path there (not the old end's plane slid along).
    const trimmed = distance < 0 ? trimSweepEnd(body, face, -distance, ctx) : null;
    if (trimmed) {
      bodies.set(feature.target, staysClosed(body, trimmed));

      return;
    }
    try {
      const out = staysClosed(body, offsetFace(body, face, distance));
      // Hair-thin faces left behind (a face pushed over a fillet): a straight push is cleaner.
      if (face.geomType === 'PLANE' && slivers(out) > slivers(body)) {
        throw new Error('slivers');
      }
      bodies.set(feature.target, out);

      return;
    } catch (err) {
      // Faces whose neighbours don't enclose them still get a straight push -
      // but not one with a fillet on it (the old fillet would stay standing).
      // (Nor one whose sides meet before it gets there: straight sides would be another shape.)
      if (face.geomType !== 'PLANE' || hasBlends(body, face) || (err instanceof Error && err.message === SIDES_MEET)) {
        throw err;
      }
    }
  }
  // Symmetric: from `distance` behind the shape to `distance` in front.
  const parts = startFaces().map(({ face, normal }) => {
    const straight = feature.symmetric ? basicFaceExtrusion(face.clone().translate(scale(normal, -distance)), new Vector(normal).multiply(2 * distance)) : basicFaceExtrusion(face, new Vector(normal).multiply(distance));

    // Draft: the sides lean from the shape's own plane (both ways from it, symmetric).
    return feature.draft ? drafted(straight, scale(normal, Math.sign(distance) || 1), face.center.toTuple() as Vec3, feature.draft) : straight;
  });
  let solid = fuseAll(parts);
  // Up to: what goes past the face or plane is cut off.
  if (upTo) {
    solid = trimmedTo(solid, upTo, startFaces()[0]?.face.center.toTuple() as Vec3);
  }
  // Auto: other bodies the extrusion runs into get cut through. Drawn on
  // its own (no body it belongs to), it then only cuts - no new body.
  // (By the way it goes: going +, a shape drawn on its own is a new body, whatever it runs into.)
  if (feature.mode === 'auto' && !(feature.byDirection && !feature.target && distance >= 0)) {
    const hit = overlapping(solid, ctx, feature.target);
    // Started inside a body (drawn on a plane through it) and reaching out
    // of it: cut, and the part outside left off - said so (a pipe's branch
    // drawn on the floor through the pipe came out a notch, no word why).
    if (hit.length && !feature.target && Math.abs(distance) > 1e-9) {
      const dir = Math.sign(distance);
      const starts = startFaces().flatMap(({ face, normal }) => {
        const { p } = pointOnFace(face as unknown as Shape3D, face); const e = 1e-3;

        return [add(p, scale(normal, e * dir)), add(p, scale(normal, -e * dir))]; 
      });
      const inside = hit.some(id => insideOf(need(bodies, id), starts).every(Boolean));
      if (inside) {
        let rest: Shape3D = solid;
        for (const id of hit) {
          rest = checkedBoolean('cut', rest, need(bodies, id));
        }
        if (!isEmpty(rest) && Math.abs(measureVolume(rest)) > 1e-3 * Math.abs(measureVolume(solid))) {
          editNotes.push(AUTO_CUT_INSIDE);
        }
      }
    }
    for (const id of hit) {
      const cut = checkedBoolean('cut', need(bodies, id), solid);
      if (isEmpty(cut)) {
        bodies.delete(id);
      } else {
        bodies.set(id, cut);
      }
      ctx.freeforms.delete(id);
    }
    if (hit.length && !feature.target) {
      return;
    }
  }
  combine(feature.id, feature.mode, feature.target, solid, distance < 0, ctx);
}

function applyRevolve(feature: RevolveFeature, ctx: Ctx) {
  if (Math.abs(feature.angle) < 1e-6) {
    throw new Error('Angle is zero');
  }
  const axis = resolveAxis(feature.axis, ctx);
  if (feature.travel && Math.abs(feature.travel) > 1e-9) {
    // Moving along the axis while turning: a helical sweep (threads, springs).
    const parts = withHoles(feature.source, ctx, wire => helicalSweep(wire, axis.origin, norm(axis.dir), feature.angle, feature.travel!));
    combine(feature.id, feature.mode, feature.target, fuseAll(parts), false, ctx);

    return;
  }
  if (Math.abs(feature.angle) > 360 + 1e-6) {
    throw new Error('More than one turn needs a Travel along the axis (or it overlaps itself)');
  }
  const whole = Math.abs(Math.abs(feature.angle) - 360) < 1e-6;
  const turnFace = (face: Face): Shape3D => {
    // A whole ellipse turned all the way round is a ring with one face and
    // no edges: later unions break it (a combustor ring took one fuel
    // nozzle, then came out inside out). Two halves, joined, are sound.
    if (whole && face.edges.length === 1 && face.edges[0].geomType === 'ELLIPSE') {
      const half = revolution(face, axis.origin, axis.dir, 180) as Shape3D;

      return half.fuse(half.clone().rotate(180, axis.origin, axis.dir));
    }

    return revolution(face, axis.origin, axis.dir, feature.angle) as Shape3D;
  };
  // A shape across the axis turns into itself (the kernel only said it
  // "could not compute this").
  for (const { face } of sourceFaces(feature.source, ctx)) {
    if (crossesAxis(face, axis.origin, norm(axis.dir))) {
      throw new Error('The shape crosses the axis - it has to stay on one side of it (touching it is fine)');
    }
  }
  const turn = () => sourceFaces(feature.source, ctx).map(({ face }) => turnFace(face));
  let parts: Shape3D[];
  try {
    parts = turn();
  } catch {
    // A profile whose exact spline won't turn (it touches the axis awkwardly): a close fit does.
    parts = withFittedSplines(turn);
  }
  combine(feature.id, feature.mode, feature.target, fuseAll(parts), false, ctx);
}

function applySweep(feature: SweepFeature, ctx: Ctx) {
  const spine = pathWire(feature.path, ctx);
  // The profile keeps its turn round the path as it goes (OpenCascade's
  // corrected Frenet), not the path's own Frenet frame: that one flips
  // half a turn where a bend changes side (an S curve) and is undefined
  // where the path runs straight, so the tube broke into pieces that
  // jumped sideways there - a profile off the path's centre most of all.
  const scale = feature.scale ?? 1;
  if (!(scale > 0)) {
    throw new Error('The end size must be more than 0');
  }
  const twist = feature.twist ?? 0;
  const parallel = feature.orientation === 'parallel';
  if (parallel && Math.abs(twist) > 1e-9) {
    throw new Error('A twist turns the profile with the path: set Orientation to Normal to path');
  }
  const corner = feature.corner === 'mitre' ? 'right' : 'round';
  // Moved onto the path: its centre to the path's nearer end, turned square to the path there.
  const place = feature.position === 'start' ? onPathStart(sourceFaces(feature.source, ctx), spine) : null;
  // Along a straight line square to the profiles, from one of its ends,
  // unturned and the same size all the way: an extrusion, made as one (the
  // sweep's faces looked the same but wouldn't take a chamfer round a
  // gear's teeth that the extrusion's took).
  const ends = Math.abs(scale - 1) < 1e-9 && Math.abs(twist) < 1e-9 && !place ? straightRun(spine) : null;
  if (ends) {
    const faces = sourceFaces(feature.source, ctx);
    const [a, b] = ends;
    const length = dist(a, b);
    const runs = faces.map(({ face, normal }) => {
      const unitNormal = norm(normal);
      if (len(cross(norm(sub(b, a)), unitNormal)) > 1e-9) {
        return null;
      }
      const center = face.center.toTuple() as Vec3;
      if (Math.abs(dot(sub(a, center), unitNormal)) < length * 1e-9) {
        return sub(b, a);
      }
      if (Math.abs(dot(sub(b, center), unitNormal)) < length * 1e-9) {
        return sub(a, b);
      }

      return null;
    });
    if (runs.every(run => run)) {
      const parts = faces.map(({ face }, i) => basicFaceExtrusion(face, new Vector(runs[i]!)) as Shape3D);
      combine(feature.id, feature.mode, feature.target, fuseAll(parts), false, ctx);
      ctx.sweeps.set(feature.id, spine);

      return;
    }
  }
  const scaled = Math.abs(scale - 1) > 1e-9;
  const twisted = Math.abs(twist) > 1e-9;
  // Facing the same way all along, the profile has no thickness where the
  // path runs in the profile's own plane (up a post, then sideways): that
  // leg came out missing without a word, or as a body "damaged", and a
  // ring's never came back at all (the engine hung). Said, before it's tried.
  if (parallel) {
    const src = sourceFaces(feature.source, ctx);
    const facing = place ? norm(spine.tangentAt(dist(src[0].face.center.toTuple() as Vec3, spine.startPoint.toTuple() as Vec3) <= dist(src[0].face.center.toTuple() as Vec3, spine.endPoint.toTuple() as Vec3) ? 0 : 1).toTuple() as Vec3) : norm(src[0]?.normal ?? [0, 0, 1]);
    if (runsAcross(spine, facing) > 0.02) {
      throw new Error('Facing the same way, the profile slides along its own plane on part of this path and has no thickness there - turn the profile to face along that part, or set Orientation to Normal to path');
    }
  }
  // One profile along one path is one solid. Round a sharp corner of the
  // path a profile that changes size, or turns as it goes, came out in two
  // pieces run through each other (or broken): said as what it is.
  const corners = (scaled || twisted) && sharpCorners(spine);
  const cornerTrouble = () =>
    new Error(`A profile that ${scaled && twisted ? 'changes size and turns' : scaled ? 'changes size' : 'turns'} as it goes can't get round a sharp corner of the path - round the corner (a small fillet in the path's sketch), or set ${scaled && twisted ? 'End size back to 100% and Twist to 0' : scaled ? 'End size back to 100%' : 'Twist back to 0'}`);
  const whole = (part: Shape3D): Shape3D => {
    const pieces = subShapes(part, 'SOLID').length;
    if (pieces === 1 && !(corners && !shapeValid(part))) {
      return part;
    }
    if (corners) {
      throw cornerTrouble();
    }
    if (twisted) {
      throw new Error("The twist didn't build along this path - try a smoother path (no sharp corners) or less twist");
    }
    throw new Error('The sweep came apart along this path - try a smoother path (no sharp corners, no tight turns)');
  };
  // (With holes - a tube: each wire's sweep may be sound and the one cut from the other still not.)
  const made = () => withHoles(feature.source, ctx, (w0, outer0) => {
    const wire = place ? place(w0) : w0;
    const outer = place ? place(outer0) : outer0;
    const law = scaled ? scaleLaw(spine, scale) : null;
    if (parallel) {
      return whole(flatFaces(fixedSweep(wire, spine, corner, law)));
    }
    // A circle round the path's start, square to it, is the same twisted or not (a gear's bore): swept
    // plainly it stays a true cylinder (twisted, a spline with a winding seam that threads couldn't use).
    if (!twisted || roundAboutPath(wire, spine)) {
      return whole(flatFaces(genericSweep(wire, spine, { frenet: false, transitionMode: corner, law }) as Shape3D));
    }
    // Twisted: the profile's sideways direction follows a curve wound round the path.
    const reach = Math.max(1, len(sub(...(outer.boundingBox.bounds as [Vec3, Vec3]))));
    try {
      return whole(flatFaces(genericSweep(wire, spine, { auxiliarySpine: twistGuide(spine, twist, reach), transitionMode: 'right', law }) as Shape3D));
    } catch (err) {
      if (err instanceof Error && /Could not sweep/.test(err.message)) {
        throw new Error("The twist didn't build along this path - try a smoother path (no sharp corners) or less twist");
      }
      throw err;
    }
  });
  let parts: Shape3D[];
  try {
    parts = made();
  } catch (err) {
    if (!corners || isFault(err) || (err instanceof Error && /sharp corner/.test(err.message))) {
      throw err;
    }
    throw cornerTrouble();
  }
  if (corners && parts.some(part => subShapes(part, 'SOLID').length !== 1 || !shapeValid(part))) {
    throw cornerTrouble();
  }
  // Mitred: each leg of the path is a piece of its own, so a flat side
  // running round (a picture frame's front) was four faces meeting along
  // the mitres - a chamfer round its inside edge "didn't fit", a round
  // round its outside took more than it should at the corners. One face each.
  if (corner === 'right') {
    parts = parts.map(part => unify(part));
  }
  // A curve of the path that bends tighter than the profile is wide: the body folds over itself on the inside of
  // the bend and comes out lumpy there - said, with both sizes (it is no fault of the build; it looked like one).
  if (!parallel) {
    const bend = tightestBend(spine);
    const reach = Math.max(0, ...sourceFaces(feature.source, ctx).map(({ face }) => {
      const center = face.center.toTuple() as Vec3;
      let far = 0;
      for (const e of face.edges) {
        for (let i = 0; i <= 8; i++) {
          far = Math.max(far, dist(e.pointAt(i / 8).toTuple() as Vec3, center));
        }
      }

      return far;
    })) * Math.max(1, scale);
    if (bend < reach * 0.98) {
      const mm = (value: number) => String(Math.round(value * 10) / 10);
      editNotes.push(`The path bends tighter (a radius of about ${mm(bend)} mm) than the profile reaches from its middle (${mm(reach)} mm): the body folds over itself inside that bend. A gentler bend, or a smaller profile, keeps it even.`);
    }
  }
  combine(feature.id, feature.mode, feature.target, fuseAll(parts), false, ctx);
  ctx.sweeps.set(feature.id, spine);
}

function applyLoft(feature: LoftFeature, ctx: Ctx) {
  if (feature.sections.length < 2) {
    throw new Error('Pick at least two profiles');
  }
  // Each section's own plane (a profile's sketch, or the face).
  const frames = feature.sections.map(section => sectionFrame(section, ctx));
  let order = feature.sections.map((_, i) => i);
  const n0 = frames[0].normal;
  // Parallel sections go in their order along the normal, whatever order they were picked in
  // (a loft that doubles back on itself isn't a solid).
  if (!feature.closed && !feature.guide && frames.every(fr => Math.abs(dot(fr.normal, n0)) > 0.999)) {
    const height = (i: number) => dot(sub(frames[i].origin, frames[0].origin), n0);
    order.sort((a, b) => height(a) - height(b));
    for (let index = 1; index < order.length; index++) {
      if (Math.abs(height(order[index]) - height(order[index - 1])) < 1e-6) {
        throw new Error('Two profiles lie on the same plane: loft needs them one above another');
      }
    }
  }
  // The same profile picked twice counts once.
  order = order.filter((i, index) => index === 0 || JSON.stringify(feature.sections[i]) !== JSON.stringify(feature.sections[order[index - 1]]));
  if (order.length < 2) {
    throw new Error('Pick at least two different profiles');
  }
  let wires = order.map(i => sourceWires(feature.sections[i], ctx)[0]);
  if ((feature.startContinuity || feature.endContinuity) && !feature.guide && !feature.closed) {
    if (feature.ruled) {
      throw new Error("Straight sides can't also leave a profile smoothly: switch off Straight sides");
    }
    const nrm = order.map(i => frames[i].normal);
    wires = withEndPulls(wires, nrm, feature.startContinuity, feature.startWeight ?? 1, feature.endContinuity, feature.endWeight ?? 1);
  }
  let shape: Shape3D;
  if (feature.rails?.length || feature.connections?.length) {
    if (feature.guide || feature.closed) {
      throw new Error("Guide curves and connections can't be used with a centre line or a closed loop");
    }
    const rails = (feature.rails ?? []).map(pathRef => pathWire(pathRef, ctx));
    const conns = (feature.connections ?? []).map(connection => order.map(i => connection[i]));
    shape = railLoft(wires, rails, conns);
  } else if (feature.guide || feature.closed) {
    if (feature.closed && wires.length < 3 && !feature.guide) {
      throw new Error('A closed loop needs at least three profiles');
    }
    shape = loftAlong(wires, feature.guide ? pathWire(feature.guide, ctx) : null, !!feature.closed);
  } else {
    try {
    // One smooth side where the sections' starts are in line already (see loftAlign.ts).
      const inLine = loftInLine(wires, feature.ruled);
      shape = inLine && shapeValid(inLine) && quickVolume(inLine) > 0 ? inLine : loft(wires, { ruled: feature.ruled });
    } catch {
      throw new Error("These profiles can't be lofted together");
    }
  }
  combine(feature.id, feature.mode, feature.target, shape, false, ctx);
}

function applyFilletOrChamfer(feature: EdgeFeature, ctx: Ctx) {
  const { bodies } = ctx;
  const byBody = new Map<string, EdgeRef[]>();
  for (const e of feature.edges) {
    byBody.set(e.body, [...(byBody.get(e.body) ?? []), e]);
  }
  for (const [bodyId, refs] of byBody) {
    const body = need(bodies, bodyId);
    // (An edge next to nothing in length - the end of a sliver, picked with the
    // rest of a face's outline before such ends were cleared away - isn't one to round.)
    const real = refs.filter(ref => ref.length > 1e-4);
    // A sliver of a picked run gone (a blade's root cut short where the hub's seam
    // crossed it, moved when the blade did) is skipped: the round runs on along the
    // smooth run it was part of. A whole edge gone still says so.
    const picked = real.length ? real : refs;
    const longest = Math.max(...picked.map(edgeRef => edgeRef.length));
    const found = picked.map((edgeRef) => {
      try {
        return resolveEdge(body, edgeRef, true);
      } catch (err) {
        if (err instanceof Error && err.message === EDGE_GONE && edgeRef.length < longest * 0.05) {
          return null;
        }
        throw err;
      }
    });
    const edges = found.filter((e): e is Edge => !!e);
    if (!edges.length) {
      throw new Error(EDGE_GONE);
    }
    if (edges.length < found.length) {
      editNotes.push(`${found.length - edges.length} tiny piece${found.length - edges.length > 1 ? 's' : ''} of the edges it was built on ${found.length - edges.length > 1 ? 'are' : 'is'} gone - the rest are ${feature.type === 'fillet' ? 'rounded' : 'chamfered'}.`);
    }
    let result: Shape3D | null = null;
    // Two-Distance chamfer: each edge's first distance runs along one of
    // its two faces (Flip: the other one), the second along the other.
    const d2 = feature.type === 'chamfer' && feature.distance2 !== undefined && feature.distance2 > 0 ? feature.distance2 : null;
    const sideOf = (e: Edge): Face => {
      const two = body.faces.filter(fc => fc.edges.some(edge => edge.isSame(e)));
      if (!two.length) {
        throw new Error('That edge has no face beside it to measure the chamfer along');
      }

      return two[feature.flip && two.length > 1 ? 1 : 0];
    };
    const twoDistance = (radius: number) =>
      body.chamfer((e: Edge) => (edges.some(edge => edge.isSame(e)) ? { distances: [radius, (d2! * radius) / feature.radius] as [number, number], selectedFace: finder => finder.inList([sideOf(e)]) } : null));
    // Variable fillet: the radius runs evenly from one end of each edge to the other.
    const r2 = feature.type === 'fillet' && feature.radius2 !== undefined && feature.radius2 > 0 && Math.abs(feature.radius2 - feature.radius) > 1e-9 ? feature.radius2 : null;
    const variable = (radius: number) =>
      body.fillet((e: Edge) => {
        if (!edges.some(edge => edge.isSame(e))) {
          return null;
        }
        const ends: [number, number] = [radius, (r2! * radius) / feature.radius];

        return feature.flip ? [ends[1], ends[0]] : ends;
      });
    if (feature.type === 'fillet' && feature.g2 && (r2 || feature.chord)) {
      throw new Error('Smooth (G2) takes one radius - set Type to Constant and Size to Radius');
    }
    const edge = (radius: number) =>
      feature.type === 'fillet' && feature.g2 ? g2Fillet(body, edges, radius) : feature.type === 'fillet' ? (feature.chord ? chordFillet(body, edges, radius, r2 ? (r2 * radius) / feature.radius : radius, !!feature.flip) : r2 ? variable(radius) : body.fillet(radius, finder => finder.inList(edges))) : d2 ? twoDistance(radius) : body.chamfer(radius, finder => finder.inList(edges));
    try {
      result = edge(feature.radius);
    } catch (err) {
      if (err instanceof Error && !/WebAssembly|kernel/i.test(err.message)) {
        throw err;
      }
      // Exactly the size that uses up a face (4 mm on both edges of an
      // 8 mm block: a full round): the two roundings meet with nothing
      // between, and that exact case fails where 3.999 works. A hair
      // less gives the same shape, to a millionth of a millimetre.
      for (const factor of [1 - 1e-6, 1 - 1e-5, 1 - 1e-4]) {
        try {
          result = edge(feature.radius * factor);
          break;
        } catch {
          // a bit less again
        }
      }
    }
    // Too big for a face beside it (OpenCascade gives up): built as a true round that
    // cuts on through that face's far edge (overflow: keep surface).
    if (!result && feature.type === 'fillet' && !feature.g2 && !r2 && !feature.chord) {
      try {
        result = blendFillet(body, edges, feature.radius, false);
        editNotes.push("The round was too big for a face beside it, so it cuts on through that face's far edge (still exactly round).");
      } catch {
        result = null;
      }
    }
    if (result && feature.type === 'fillet' && !feature.g2 && (feature.setback ?? 0) > 0) {
      result = setbackCorners(result, edges, feature.setback!, feature.radius * Math.max(1, r2 ? r2 / feature.radius : 1));
    }
    if (!result) {
      const what = feature.type === 'fillet' ? 'radius' : 'distance';
      // No corner there at all: the faces either side run smoothly into each other (the lines between a
      // freeform's patches, where a round already ends). Said as that - "too big" sent people to try smaller.
      if (edges.every(e => smoothEdge(body, e))) {
        throw new Error(`${edges.length > 1 ? 'Those edges are' : 'That edge is'} smooth already: the faces either side run into each other with no corner to ${feature.type === 'fillet' ? 'round' : 'cut'}. Pick an edge with a corner.`);
      }
      throw new Error(`That ${feature.type} doesn't fit here - the ${what} is too big for the faces around ${edges.length > 1 ? 'those edges' : 'that edge'}. Try a smaller ${what}.`);
    }
    bodies.set(bodyId, result);
  }
}

function applyShell(feature: ShellFeature, ctx: Ctx) {
  const { bodies } = ctx;
  const body = need(bodies, feature.body);
  let faces = feature.faces.map(face => resolveFace(body, face));
  // Every face picked (a ball's one round face) leaves no wall to keep: hollow it sealed instead.
  if (faces.length && body.faces.every(face => faces.some(removed => removed.isSame(face)))) {
    faces = [];
    editNotes.push("Every face of the body was picked, so there's no opening: it's hollow inside, sealed. Pick fewer faces for an opening.");
  }
  // A freeform: drop the picked cage faces and thicken the rest inward -
  // exact, where shelling its smooth surfaces is unreliable.
  const ff = ctx.freeforms.get(feature.body);
  if (ff && faces.length) {
    bodies.set(feature.body, shellFreeform(ff, faces, Math.abs(feature.thickness)));
    ctx.freeforms.delete(feature.body);

    return;
  }
  // Positive thickness shells inward (negative grows outward with rounded corners).
  const t = Math.abs(feature.thickness);
  // (To a thousandth first: a hollowed body is well off what it was. Only one within a hundredth is measured exactly.)
  const q0 = Math.abs(quickVolume(body));
  const hollowed = (shape: Shape3D | null): shape is Shape3D => !!shape && (Math.abs(Math.abs(quickVolume(shape)) - q0) > 0.01 * q0 || Math.abs(Math.abs(volumeOf(shape)) - Math.abs(volumeOf(body))) > 1e-6 * Math.abs(volumeOf(body)));
  // A shell to trust: hollow, a sound solid, a wall behind every face it
  // kept and nothing left deep inside. OpenCascade can "succeed" without
  // hollowing anything, or hollowing only a corner of it - or hollow it
  // and leave a wall out: where two faces are closer together than two
  // walls (a pocket 1.7 mm from a hole, 1 mm walls) it dropped the
  // pocket's walls without a word, the pocket a window into the hollow.
  const kept = body.faces.filter(face => !faces.some(removed => removed.isSame(face)));
  const gaps = openEdges(body).length;
  // (No hair-thin faces either, as every edit is held to: the exact case
  // above comes out "fine" with its inside rounds shrunk to slivers.)
  const thin0 = hairThin(body);
  const fine = (shape: Shape3D) => {
    if (hairThin(shape) <= thin0) {
      return true;
    }
    try {
      return hairThin(unify(shape)) <= thin0;
    } catch {
      return false;
    }
  };
  // (The quick checks first: measuring the volume of a way that came out
  // wrong took 6.6 s in a split box's shell, the hair-thin faces that
  // turned it down a fifth of a second.)
  const good = (shape: Shape3D | null): shape is Shape3D => !!shape && shapeValid(shape) && openEdges(shape).length <= gaps && fine(shape) && hollowed(shape) && wallsStand(body, shape, kept, t) && hollowInside(body, shape, kept, t);
  // The ways there are, in turn: in one step (no face picked: that gives
  // only the inner core back - a battery case came out solid); hollowed
  // with an offset copy of the body, the openings cut through (many-faced
  // shapes trip the one-step shell); and that a hair thicker - a wall
  // exactly as thick as the corners are round (2 mm walls in a box with
  // 2 mm corners) has inside corners that shrink to nothing, and that
  // exact case defeats both: a hair thicker gives the sharp inside corner
  // it should have.
  const ways: (() => Shape3D | null)[] = [
    () => {
      if (!faces.length) {
        return null;
      }
      try {
        return body.shell(t, finder => finder.inList(faces));
      } catch {
        return null;
      }
    },
    () => shellByOffset(body, faces, t),
    // (Sealed too: a closed box with 2 mm rounds hollowed 2 thick.)
    ...[1 + 1e-4, 1 + 1e-3].map(factor => () => shellByOffset(body, faces, t * factor)),
    // ...and the hollow put together from what is cut out of the body, each
    // cut-out grown on its own: where two of them are closer than two walls
    // (a pocket 1.7 mm from a hole, 1 mm walls) offsetting the whole body fails.
    () => shellByOffset(body, faces, t, true)
  ];
  let out: Shape3D | null = null;
  // (Hollow, but torn or broken: put right below, if nothing better comes -
  // the first of them, found only then: its volume can be slow to measure.)
  const tried: Shape3D[] = [];
  for (const way of ways) {
    const made = way();
    if (good(made)) {
      out = made;
      break;
    }
    if (made) {
      tried.push(made);
    }
  }
  const rough = out ? null : (tried.find(shape => hollowed(shape)) ?? null);
  if (!out && rough) {
    // Put right as any edit's result is - and then held to the same: a
    // broken shell "repaired" came out sound and a sixth too light, the
    // walls round two bores gone.
    const fixed = repairShape(rough, { maxSolids: Math.max(1, subShapes(body, 'SOLID').length) });
    if (fixed && good(fixed.shape)) {
      if (fixed.fixes.length) {
        editNotes.push(`Repaired automatically: ${fixed.fixes.join(', ')}.`);
      }
      out = fixed.shape;
    }
  }
  // (A pocket or a blind hole cut into the face being opened hangs from that face alone.)
  const loose = faces.some(face => face.clone().innerWires().length > 0);
  if (!out) {
    throw new Error(!rough ? "Shell didn't work on this shape (try a smaller thickness)" : loose ? `${WALLS_CLASH} - or what is cut into the opened face would be left standing loose (open another face)` : WALLS_CLASH);
  }
  bodies.set(feature.body, out);
}

function applyBoolean(feature: BooleanFeature, ctx: Ctx) {
  const { bodies } = ctx;
  let target = need(bodies, feature.target);
  const toolIds = bodyList(feature.tools, bodies, 'tools', feature.whole);
  const solidsIn = (x: Shape3D) => [...iterTopo(x.wrapped, 'solid')].length;
  // Subtract: every tool at once (see cutAway), each kept the clearance
  // away if one is set, cut from the body, the tools or all of them.
  if (feature.op === 'subtract' && toolIds.length) {
    const tools = toolIds.map(t => need(bodies, t));
    if (!solidsIn(target) || tools.some(t => !solidsIn(t))) {
      throw new Error('One of these is an open surface (e.g. a freeform with a hole), not a solid. Close it first: tap an edge of the hole → Fill hole, or give it a Thickness - then Union.');
    }
    const gap = Math.max(0, feature.clearance ?? 0);
    const from = feature.cutFrom ?? 'body';
    // Each body grown by the gap it keeps from the others (once each).
    const grown = new Map<Shape3D, Map<number, Shape3D[]>>();
    const grow = (shape: Shape3D, by: number): Shape3D[] => {
      if (!(by > 0)) {
        return [shape.clone()];
      }
      let shapes = grown.get(shape)?.get(by);
      if (!shapes) {
        // (A threaded body: the same thread cut on the body grown. The kernel can't grow a thread's own faces.)
        shapes = grownThreaded(shape, by, toolIds[tools.indexOf(shape)] ?? (shape === target ? feature.target : '')) ?? grownBy(shape, by) ?? undefined;
        if (!shapes) {
          throw new Error(`Couldn't keep ${+by.toFixed(4)} mm clear round one of the bodies - try a smaller clearance`);
        }
        grown.set(shape, (grown.get(shape) ?? new Map()).set(by, shapes));
      }

      return shapes.map(shape => shape.clone());
    };
    if (from === 'body') {
      const out = cutAway(target, tools.flatMap(t => grow(t, gap)));
      if (!feature.keepTools) {
        for (const t of toolIds) {
          bodies.delete(t);
        }
      }
      // Kept as it was: the result is a body of its own.
      bodies.set(feature.keepTarget ? feature.id : feature.target, out);

      return;
    }
    // The others give way: each cut by the body, grown by the gap.
    if (from === 'tools') {
      const outs = tools.map(t => cutAway(t, grow(target, gap)));
      outs.forEach((out, outIndex) => bodies.set(toolIds[outIndex], out));

      return;
    }
    // All of them, in turn: each gives way half the gap to the ones still
    // to come, and the ones before it what's left - itself less the
    // earlier ones grown by the whole gap, but its own core (itself
    // brought in by half the gap) kept. So any two end up the gap apart,
    // half from each where they overlapped: a peg through a plate, a hole
    // r + gap/2 and a pin r - gap/2. Only the bodies as they were are
    // grown or brought in (the kernel can't grow a cut one: its round
    // from the cut is the gap's own radius).
    const ids = [feature.target, ...toolIds];
    const was = [target, ...tools];
    const now = was.map((b, index) => {
      const by = was.slice(index + 1).flatMap(shape => grow(shape, gap / 2));
      if (index > 0) {
        let early = fuseAll(was.slice(0, index).flatMap(shape => grow(shape, gap)));
        const core = gap > 0 ? broughtIn(b, gap / 2) : b.clone();
        // (Its core not kept, if that cut fails: more is cut away, still the gap apart.)
        if (core) {
          try {
            early = fuzzyBoolean('cut', early, core);
          } catch (err) {
            if (isFault(err)) {
              throw err;
            }
          }
        }
        if (!isEmpty(early)) {
          by.push(early);
        }
      }

      return by.length ? cutAway(b, by) : b;
    });
    now.forEach((shape, index) => bodies.set(ids[index], shape));

    return;
  }
  let open: number | undefined;
  for (const t of toolIds) {
    const tool = need(bodies, t);
    const solids = (x: Shape3D) => [...iterTopo(x.wrapped, 'solid')].length;
    // An open freeform (a surface with a hole) isn't a solid: nothing to join into.
    if (!solids(target) || !solids(tool)) {
      throw new Error('One of these is an open surface (e.g. a freeform with a hole), not a solid. Close it first: tap an edge of the hole → Fill hole, or give it a Thickness - then Union.');
    }
    const before = feature.op === 'union' ? solids(target) + solids(tool) : 0;
    const prev = target;
    target = feature.op === 'union' ? target.fuse(tool) : feature.op === 'subtract' ? target.cut(tool) : target.intersect(tool);
    // A join that leaves a gap (a coil wound round a hollowed cowl: one
    // edge left open where the two met): the tolerant join closes it.
    if (feature.op === 'union') {
      open ??= openEdges(prev).length;
      let now = openEdges(target).length;
      if (now > open + openEdges(tool).length) {
        try {
          const fz = fuzzyBoolean('fuse', prev, tool);
          const nz = openEdges(fz).length;
          if (nz < now && booleanVolumeOk('fuse', prev, tool, fz)) {
            [target, now] = [fz, nz];
          }
        } catch {
          // keep the plain result: the usual checks speak for it
        }
      }
      open = now;
    }
    // A union joins: a body that doesn't touch would only be grouped with it, not joined.
    if (feature.op === 'union' && solids(target) >= before) {
      throw new Error("These bodies don't touch - Union needs them to overlap or touch (move one onto the other first)");
    }
    if (!(feature.op === 'intersect' && feature.keepTools)) {
      bodies.delete(t);
    }
  }
  if (isEmpty(target)) {
    throw new Error('The result is empty');
  }
  bodies.set(feature.op === 'intersect' && feature.keepTarget ? feature.id : feature.target, target);
}

function applySplit(feature: SplitFeature, ctx: Ctx) {
  const { bodies } = ctx;
  const body = need(bodies, feature.body);
  // Several planes, or bodies, at once: every piece they cut it into. The
  // biggest stays the body; the others are new ones.
  if (feature.planes?.length || feature.tools?.length || feature.noPlane) {
    const planes = [...(feature.noPlane ? [] : [feature.plane]), ...(feature.planes ?? [])];
    const tools = (feature.tools ?? []).filter(t => t !== feature.body).map(t => need(bodies, t));
    if (!planes.length && !tools.length) {
      throw new Error('Pick a plane or a body to split it with');
    }
    const pieces = splitAll(body, planes, tools);
    if (pieces.length < 2) {
      throw new Error("Nothing it's split with cuts through the body");
    }
    bodies.set(feature.body, pieces[0]);
    pieces.slice(1).forEach((piece, pieceIndex) => bodies.set(pieceIndex ? `${feature.id}:${pieceIndex + 1}` : feature.id, piece));

    return;
  }
  const half = halfSpace(feature.plane, body);
  let a: Shape3D | null = null, b: Shape3D | null = null;
  try {
    a = body.intersect(half);
    b = body.cut(half);
  } catch {
    // Faces lying on the plane (a coil's end drawn on it) can stop the
    // plain split: the tolerant one treats them as on it.
  }
  // A plane crossing a round face's seam twice (the top off a ball turned
  // round the pipe's axis) gives the plain split an empty, broken half,
  // with no error: the halves must be sound and add up to the body.
  const whole = Math.abs(volumeOf(body));
  const sound = (shape: Shape3D | null) => !!shape && !isEmpty(shape) && shapeValid(shape);
  const addsUp = () => Math.abs(Math.abs(volumeOf(a!)) + Math.abs(volumeOf(b!)) - whole) <= Math.max(1e-9, whole * 1e-4);
  if (!sound(a) || !sound(b) || !addsUp()) {
    a = fuzzyBoolean('common', body, half);
    b = fuzzyBoolean('cut', body, half);
  }
  const [inside, outside] = [a as Shape3D, b as Shape3D];
  if (isEmpty(inside) || isEmpty(outside)) {
    throw new Error("The plane doesn't cut through the body");
  }
  bodies.set(feature.body, outside);
  bodies.set(feature.id, inside);
}

async function applyImport(feature: ImportFeature, ctx: Ctx) {
  const { bodies } = ctx;
  const rounding = feature.format === 'stl' && !!feature.round;
  const cacheKey = rounding ? `round:${feature.data}` : feature.data;
  let shape = importCache.get(cacheKey);
  if (!shape) {
    const bytes = Uint8Array.from(atob(feature.data), char => char.charCodeAt(0));
    const blob = new Blob([bytes]);
    try {
      // (A mesh asked to be made into faces: its flat faces built whole here, whichever way they face; where
      // that cannot be done, the kernel's own reading of the file.)
      const whole = rounding ? meshBodyOf(bytes) : null;
      shape = whole?.shape ?? ((feature.format === 'step' ? await importSTEP(blob) : readSTL(bytes)) as Shape3D);
    } catch (err) {
      // (The engine itself breaking down is for whoever runs it - it was
      // taken for a file that couldn't be read, and the broken engine kept.
      // A mesh too big says so in its own words.)
      if (isFault(err) || err instanceof TooBig) {
        throw err;
      }
      // (OpenCascade's own words were "This shape has not type, it is null".)
      throw new Error(feature.format === 'step' ? "This STEP file couldn't be read - it may be damaged" : "This STL file couldn't be read");
    }
    if (isEmpty(shape)) {
      throw new Error('The file contains no solid geometry');
    }
    importCache.set(cacheKey, shape);
  }
  // A file of several solids (an assembly; this app's own STEP of two bodies): each a body of its own, to pick,
  // hide, move and cut by itself. (They came in as one body of several pieces: the two bodies of a project
  // saved as STEP and opened again were one, that nothing could take apart.)
  const solids = feature.apart && (feature.format === 'step' || rounding) ? subShapes(shape, 'SOLID') : [];
  if (solids.length > 1) {
    solids.forEach((solid, i) => bodies.set(i ? `${feature.id}:${i}` : feature.id, cast(solid) as Shape3D));

    return;
  }
  bodies.set(feature.id, shape);
}

function applyFaceFreeform(feature: FaceFreeformFeature, ctx: Ctx) {
  const { bodies } = ctx;
  const body = need(bodies, feature.face.body);
  const face = resolveFace(body, feature.face);
  if (!feature.cage?.verts?.length) {
    throw new Error('Made before Freeform Face had a cage: tap the face, Edit Freeform, and shape it again');
  }
  // The cage follows the face (an earlier step moved it).
  const center = face.center.toTuple() as Vec3;
  const cage = { faces: feature.cage.faces, verts: feature.cage.verts.map(vertex => add(center, vertex)) };
  // Several faces side by side: one smooth surface over them all (no fitted way for those).
  if (feature.more?.length) {
    const Fs = [face, ...feature.more.map(faceRef => resolveFace(body, faceRef))];
    const normal = facesNormal(Fs.map(face => face.normalAt().toTuple() as Vec3));
    try {
      bodies.set(feature.face.body, staysClosed(body, sheetFaces(body, Fs, cage, normal)));
    } catch (err) {
      if (isFault(err) || (err instanceof Error && /holes in them/.test(err.message))) {
        throw err;
      }
      throw new Error("These faces can't be made one smooth surface like that - move the points less, or pick fewer faces");
    }

    return;
  }
  const unitNormal = norm(face.normalAt().toTuple() as Vec3);
  // Through the cage's surface twice as fine as the cage; if the face
  // can't be filled through that many points (a fine cage on an outline
  // with inward corners), through the cage's own.
  if (!faceCagePoints(cage, unitNormal, false)) {
    return;
  }
  // The cage's own smooth surface, its border on the face's edges. (A cage
  // whose border doesn't follow the edges - laid before it did - or a
  // body that won't close round it: fitted through its points instead.)
  try {
    bodies.set(feature.face.body, staysClosed(body, sheetFace(body, face, cage)));

    return;
  } catch (err) {
    if (isFault(err) || (err instanceof Error && /holes in them/.test(err.message))) {
      throw err;
    }
  }
  let last: unknown;
  for (const fine of [true, false]) {
    const pts = faceCagePoints(cage, unitNormal, fine);
    if (!pts) {
      return;
    }
    try {
      bodies.set(feature.face.body, staysClosed(body, freeformFace(body, face, onFace(face, pts))));

      return;
    } catch (err) {
      if (isFault(err)) {
        throw err;
      }
      last = err;
    }
  }
  throw last;
}

function applyReplaceFace(feature: ReplaceFaceFeature, ctx: Ctx) {
  const { bodies } = ctx;
  const body = need(bodies, feature.face.body);
  const face = resolveFace(body, feature.face);
  // Follow the target face if it's still there; else the plane as saved.
  let plane = feature.plane;
  if (feature.target) {
    const tb = bodies.get(feature.target.body);
    const tf = tb && (() => {
      try {
        return resolveFace(tb, feature.target!);
      } catch {
        return null;
      }
    })();
    if (tf?.geomType === 'PLANE') {
      plane = planeOf(tf);
    }
  }
  // Keep the face pointing the way it pointed (outward).
  const n0 = planeOf(face).normal;
  const normal = dot(plane.normal, n0) < 0 ? scale(plane.normal, -1) : plane.normal;
  bodies.set(feature.face.body, staysClosed(body, replaceFacePlane(body, face, { origin: plane.origin, normal: normal, xDir: xDirFor(normal) })));
}

function applyHole(feature: HoleFeature, ctx: Ctx) {
  const { bodies } = ctx;
  const body = need(bodies, feature.face.body);
  const face = resolveFace(body, feature.face, candidate => candidate.geomType === 'PLANE');
  const out = norm(face.normalAt().toTuple() as Vec3);
  const on = planeOf(face).origin;
  // Where: the centre of the round edge it was put on, the face's middle, or the place itself - on the face's
  // plane as it is now (the face moved out or in since: the hole starts at it still).
  let at = feature.at;
  if (feature.around) {
    try {
      at = roundCentre(resolveEdge(body, feature.around)) ?? at;
    } catch {
      // The edge is gone: where it was put.
    }
  } else if (feature.centered) {
    at = faceMiddle(face);
  } else if (feature.from) {
    try {
      const lines = feature.from.map((x) => {
        const e = resolveEdge(body, x.edge);
        if (e.geomType !== 'LINE') {
          throw new Error('not straight');
        }

        return { a: e.pointAt(0).toTuple() as Vec3, b: e.pointAt(1).toTuple() as Vec3, d: x.d };
      });
      at = holeFromLines(at, faceMiddle(face), out, lines[0], lines[1]) ?? at;
    } catch {
      // An edge is gone, or round now: where it was put.
    }
  }
  at = sub(at, scale(out, dot(sub(at, on), out)));
  const into = scale(out, -1);
  // Right through: past the far side of the body, wherever that is.
  let depth = feature.depth;
  if (feature.through) {
    const [lo, hi] = body.boundingBox.bounds as [Vec3, Vec3];
    depth = 0;
    for (const x of [lo[0], hi[0]]) {
      for (const y of [lo[1], hi[1]]) {
        for (const z of [lo[2], hi[2]]) {
          depth = Math.max(depth, dot(sub([x, y, z], at), into));
        }
      }
    }
    depth += Math.max(1, feature.diameter);
  }
  const fault = holeFault(feature, depth);
  if (fault) {
    throw new Error(fault);
  }
  // Its mouth is open: nothing of the body over it. (Put on the plate under a boss - the boss's foot is a round
  // edge to catch on - it was drilled from the plate's face down, a hollow under the boss that nothing showed.)
  if (insideOf(body, [add(at, scale(out, Math.max(2e-3, feature.diameter * 0.05)))])[0]) {
    throw new Error('The body covers the hole there: tap the face the screw goes in from.');
  }
  const made = body.cut(holeCutter(feature, at, into, depth, Math.max(1e-3, feature.diameter * 0.01))) as Shape3D;
  if (!(volumeOf(body) - volumeOf(made) > 1e-9)) {
    throw new Error('The hole is off the body there: nothing to drill into. Drag it onto the face.');
  }
  bodies.set(feature.face.body, made);
}

function applyThread(feature: ThreadFeature, ctx: Ctx) {
  const { bodies } = ctx;
  const body = need(bodies, feature.face.body);
  const face = threadTarget(body, feature);
  const cy = cylinderOf(face);
  // (How it was cut is kept by its step: a clearance round the body is the same thread cut on the body grown -
  // see grownThreaded.)
  if (cy) {
    const a = norm(cy.a);
    const ts: number[] = [];
    for (const e of face.edges) {
      for (const fraction of [0, 0.25, 0.5, 0.75, 1]) {
        ts.push(dot(sub(e.pointAt(fraction).toTuple() as Vec3, cy.c), a));
      }
    }
    const used: { phase?: number } = {};
    const made = threadFace(body, face, feature.pitch, !!feature.left, undefined, used, threadStarts(feature.starts));
    threadsCut.set(feature.id, { body: feature.face.body, c: cy.c, a, r: cy.r, inside: cy.s < 0, pitch: feature.pitch, left: !!feature.left, t0: Math.min(...ts), t1: Math.max(...ts), phase: used.phase, starts: threadStarts(feature.starts) });
    bodies.set(feature.face.body, made);

    return;
  }
  bodies.set(feature.face.body, threadFace(body, face, feature.pitch, !!feature.left, undefined, undefined, threadStarts(feature.starts)));
}

function applyConnect(feature: ConnectFeature, ctx: Ctx) {
  const { bodies } = ctx;
  const [ra, rb] = feature.faces;
  const shapeA = need(bodies, ra.body);
  const shapeB = need(bodies, rb.body);
  const fa = resolveFace(shapeA, ra);
  const fb = resolveFace(shapeB, rb);
  if (ra.body === rb.body && fa.isSame(fb)) {
    throw new Error('Pick two different faces to connect');
  }
  const mode = feature.mode === 'auto' ? 'join' : feature.mode;
  const size = feature.size ?? 1;
  // Cut between two faces of one body: a tunnel, into the faces (else out of them).
  const inward = mode === 'cut' && ra.body === rb.body;
  // Cutting a face's whole outline out: the cutter a hair wider, so no sliver stays on the walls beside it.
  const cutSize = mode === 'cut' && !inward && size > 0.99 ? size * 1.002 : size;
  const ea = bridgeEnd(shapeA, fa, cutSize, inward, mode !== 'new');
  const eb = bridgeEnd(shapeB, fb, cutSize, inward, mode !== 'new');
  const reach = Math.max(ea.reach, eb.reach);
  // The bridge's outline at each end (the fold check carries them along the curve).
  const rings = { a: ea.ring, b: eb.ring };
  let along: (t: number) => Vec3;
  // Turning with its curve, the outline never runs back over itself (the
  // bridge folding through itself: a solid no join or cut can use). Where
  // it would - `slide`: the way the outline keeps facing instead, all the
  // way, sliding along the curve without turning.
  let sound = true;
  let slide: Vec3 | undefined;
  // Points taken along the curve for the sweep's path (two arcs: more, or the
  // path fitted through them wavers where the arcs meet and the sweep breaks).
  let samples = 60;
  if (feature.guide) {
    // Eased onto the guide over a longer stretch when it leaves the face
    // steeply; where the guide itself turns tighter than the bridge is
    // wide, rounded off a little at a time until it fits.
    const drawn = curvePoints(pathWire(feature.guide, ctx).wrapped, 200);
    const fit = (pts: Vec3[]) => [1.5, 2.5, 3.5, 5].map(factor => guideCurve(pts, ea.center, eb.center, ea.dir, eb.dir, factor * reach)).find(curve => gentle(curve, rings));
    let pts = oriented(evenly(drawn, 60), ea.center, eb.center);
    let found = fit(pts);
    for (let attempt = 0; attempt < 40 && !found; attempt++) {
      found = fit((pts = smoothed(pts, 10, ea.dir, eb.dir)));
    }
    along = found ?? guideCurve(drawn, ea.center, eb.center, ea.dir, eb.dir, 1.5 * reach);
    sound = !!found;
    if (!sound) {
      slide = slideAxis(along, ea.dir, scale(eb.dir, -1), reach) ?? undefined;
    }
  } else {
    const plain = plainSpine(ea.center, ea.dir, eb.center, eb.dir, feature.bulge ?? 1, rings);
    along = plain.along;
    sound = plain.gentle;
    if (!sound) {
      // Faces too wide for how close they are (or how far to the side of
      // each other): two arcs - the gentlest way from one to the other -
      // or, facing each other, a bridge that slides along the plain curve.
      const arcs = arcSpine(ea.center, ea.dir, eb.center, eb.dir);
      if (arcs && gentle(arcs, rings)) {
        (along = arcs), (sound = true), (samples = 180);
      } else {
        const sliding = slidingSpine(ea.center, ea.dir, eb.center, eb.dir, feature.bulge ?? 1, reach);
        if (sliding) {
          (along = sliding.along), (slide = sliding.axis);
        }
      }
    }
  }
  // Into both bodies (one, when both faces are on it).
  const into = (bridge: Shape3D) => {
    combine(feature.id, mode, ra.body, bridge, false, ctx);
    if (rb.body !== ra.body) {
      if (mode === 'join') {
        combine(feature.id, 'join', ra.body, need(bodies, rb.body), false, ctx);
        bodies.delete(rb.body);
        ctx.freeforms.delete(rb.body);
      } else {
        combine(feature.id, 'cut', rb.body, bridge, false, ctx);
      }
    }
    ctx.freeforms.delete(ra.body);
  };
  try {
    const made = sweepBridge(ea, eb, along, { guided: !!feature.guide, exact: true, slide, samples });
    if (mode === 'new') {
      bodies.set(feature.id, made.shape);

      return;
    }
    if (!made.exact) {
      return into(made.shape);
    }
    // Starting on the faces' very edges, its walls lie on the bodies' own:
    // where joining (or cutting) that fails, the bridge made the other way
    // (a little inside the edges) - on the bodies as they were.
    const was = [ra.body, rb.body].map(id => [id, bodies.get(id), ctx.freeforms.get(id)] as const);
    try {
      into(made.shape);
    } catch (err) {
      if (isFault(err)) {
        throw err;
      }
      for (const [id, body, ff] of was) {
        if (body) {
          bodies.set(id, body);
        }
        if (ff) {
          ctx.freeforms.set(id, ff);
        }
      }
      into(sweepBridge(ea, eb, along, { guided: !!feature.guide, exact: false, slide, samples }).shape);
    }
  } catch (err) {
    // On a curve too tight for it the bridge runs through itself: whatever
    // went wrong with it after that, this is why.
    if (isFault(err) || sound || slide) {
      throw err;
    }
    throw new Error(bridgeFailed(!!feature.guide));
  } finally {
    for (const e of [ea, eb]) {
      (e.outline.delete(), e.rim.delete());
    }
  }
}

function applyRepair(feature: RepairFeature, ctx: Ctx) {
  const { bodies } = ctx;
  for (const id of feature.bodies) {
    const body = need(bodies, id);
    const repaired = repairShape(body);
    if (!repaired) {
      throw new Error(`This body can't be made a clean solid: ${whatsWrong(healthOf(body))}`);
    }
    editNotes.push(repaired.fixes.length ? `Repaired: ${repaired.fixes.join(', ')}.` : "Nothing to repair - it's a clean solid already.");
    bodies.set(id, repaired.shape);
  }
}

function applyDeleteGeom(feature: DeleteGeomFeature, ctx: Ctx) {
  const { bodies } = ctx;
  const start = need(bodies, feature.body);
  let body = start;
  // Picked together, taken out together: a slot's two walls and floor close
  // up as one gap (one wall alone has nothing to close it).
  let together: Shape3D | null = null;
  if (feature.faces.length > 1) {
    try {
      together = deleteBodyFaces(body, feature.faces.map(face => resolveFace(body, face)));
    } catch {
      together = null;
    }
  }
  if (together) {
    body = together;
  } else {
    for (const face of feature.faces) {
      body = deleteFace(body, resolveFace(body, face));
    }
  }
  for (const edge of feature.edges) {
    body = deleteEdge(body, edge);
  }
  for (const vertex of feature.vertices) {
    body = deleteVertex(body, vertex);
  }
  bodies.set(feature.body, staysClosed(start, body));
}

function applyMoveFace(feature: MoveFaceFeature, ctx: Ctx) {
  const { bodies } = ctx;
  let rotation = feature.rotate && Math.abs(feature.rotate.angle) > 1e-9 ? feature.rotate : undefined;
  let translate = feature.translate;
  const move = (point: Vec3) => add(rotation ? rotateAbout(point, rotation.origin, rotation.axis, rotation.angle) : point, translate);
  const turn = (normal: Vec3) => (rotation ? norm(sub(rotateAbout(add(rotation.origin, normal), rotation.origin, rotation.axis, rotation.angle), rotation.origin)) : normal);
  if (feature.face) {
    const body = need(bodies, feature.face.body);
    const face = resolveFace(body, feature.face);
    const { origin, normal } = planeOf(face);
    const nn = norm(normal);
    // Pushed straight out (or tilted about a line in it) when it was made:
    // still that, square to the face as it is now - a step before it that
    // turns the face a little more mustn't make the push a slide.
    const was = feature.face.normal && len(feature.face.normal) > 1e-9 ? norm(feature.face.normal) : undefined;
    if (was) {
      const way = dot(nn, was) < 0 ? -1 : 1;
      const out = dot(translate, was);
      if (len(sub(translate, scale(was, out))) <= 1e-6 * Math.max(1, Math.abs(out))) {
        translate = scale(nn, out * way);
      }
      if (rotation && Math.abs(dot(norm(rotation.axis), was)) <= 1e-6) {
        const inPlane = sub(rotation.axis, scale(nn, dot(rotation.axis, nn)));
        if (len(inPlane) > 1e-9) {
          rotation = { ...rotation, axis: norm(inPlane) };
        }
      }
    }
    // Slid within its own plane, or turned about its normal: its corners
    // move and the faces round it follow (a plane alone can't show that -
    // the face stayed where it was).
    const slide = sub(translate, scale(nn, dot(translate, nn)));
    const twist = !!rotation && Math.abs(dot(norm(rotation.axis), nn)) > 1e-6;
    if (len(slide) > 1e-9 || twist) {
      const size = Math.hypot(body.boundingBox.width, body.boundingBox.height, body.boundingBox.depth) || 1;
      const loop = faceLoop(face, size * 1e-6);
      const out = loop ? movePolyhedronPoints(body, loop.map(vertex => [vertex, move(vertex)] as [Vec3, Vec3])) : null;
      if (!out) {
        throw new Error('Sliding or turning a face within its plane works on bodies of flat, straight-edged faces - push or tilt it instead');
      }
      bodies.set(feature.face.body, staysClosed(body, out));

      return;
    }
    // Drawn inside a bigger flat face (projected onto it): moving its plane
    // moves nothing - raised, it's a prism joined on; sunk, one cut out.
    if (inFlatFace(body, face)) {
      if (rotation) {
        throw new Error('This face lies in a bigger flat face: it can be pushed straight out or in, not tilted (Extrude it at an angle instead)');
      }
      const along = dot(translate, nn);
      if (Math.abs(along) < 1e-12) {
        return;
      }
      const prism = basicFaceExtrusion(face, new Vector(scale(nn, along))) as Shape3D;
      const size = Math.hypot(body.boundingBox.width, body.boundingBox.height, body.boundingBox.depth) || 1;
      const { p } = pointOnFace(body, face);
      const [into] = insideOf(body, [add(p, scale(nn, Math.sign(along) * Math.min(Math.abs(along) / 2, size * 1e-3)))]);
      bodies.set(feature.face.body, staysClosed(body, checkedBoolean(into ? 'cut' : 'fuse', body, prism)));

      return;
    }
    const turned = turn(normal);
    bodies.set(feature.face.body, staysClosed(body, replaceFacePlane(body, face, { origin: move(origin), normal: turned, xDir: xDirFor(turned) })));

    return;
  }
  if (feature.vertex) {
    if (ctx.freeforms.has(feature.vertex.body)) {
      throw new Error("A freeform's shape comes from its cage: use Edit Freeform to move its points");
    }
    const body = need(bodies, feature.vertex.body);
    bodies.set(feature.vertex.body, staysClosed(body, moveVertex(body, feature.vertex.at, move(feature.vertex.at))));

    return;
  }
  if (!feature.edge) {
    throw new Error('Nothing to move');
  }
  const eb = need(bodies, feature.edge.body);
  bodies.set(feature.edge.body, staysClosed(eb, moveEdge(eb, feature.edge, move)));
}

// ------------------------------------------------------------ affine maps


/**
 * Linked bodies follow each other: a step that changed one body of a group (rounded an edge of it, cut a hole in
 * it, joined something to it...) leaves every other body of the group changed the same way - the changed body's
 * new shape, put where the other stands. (Asked for: "if it's linked, whatever change I do to any copy of that
 * body or the original, it should also change the other ones exactly the same. We should also have this in
 * patterns".) Moving or turning one of them is its own business: that only changes where it stands. One deleted,
 * or used up by a join, leaves the group; the others stay.
 */
function followLinks(step: string, before: Ctx, out: Ctx): void {
  const links = rawEntries(before.links);
  if (!links.length) {
    return;
  }
  const done = new Set<string>();
  for (const [id, lk] of links) {
    const now = rawGet(out.bodies, id);
    if (!now) {
      Map.prototype.delete.call(out.links, id);
      continue;
    }
    if (now === rawGet(before.bodies, id) || done.has(lk.group)) {
      continue;
    }
    done.add(lk.group);
    const back = affineInverse(lk.m);
    if (!back) {
      continue;
    }
    for (const [other, ol] of links) {
      if (other === id || ol.group !== lk.group) {
        continue;
      }
      const was = rawGet(out.bodies, other);
      // (Gone, or changed by this very step itself - a join of two of the group: left as the step left it.)
      if (!was || was !== rawGet(before.bodies, other)) {
        continue;
      }
      const rel = affineThen(back, ol.m);
      const shape = shapeThrough(now, rel);
      const det = affineDet(rel);
      movedFrom.set(shape, { from: new WeakRef(now), m: rel, flip: det < 0 });
      movedTags(now, shape, step, rel);
      const volume = volumes.get(now);
      if (volume !== undefined) {
        volumes.set(shape, volume * Math.abs(det));
      }
      out.bodies.set(other, shape);
      // (No longer the freeform it was: its shape is the changed body's now.)
      out.freeforms.delete(other);
    }
  }
}


/** The affine map of a move/scale/mirror step (null for patterns). */
function opAffine(op: Extract<Feature, { type: 'transform' }>['op']): Affine | null {
  const fromPoints = affineFrom;
  switch (op.kind) {
    case 'move': {
      const rotation = op.rotate && Math.abs(op.rotate.angle) > 1e-9 ? op.rotate : null;

      return fromPoints(point => add(rotation ? rotateAbout(point, rotation.origin, rotation.axis, rotation.angle) : point, op.translate));
    }
    case 'scale':
      return scaleAbout(op.center, [op.factor, op.factor, op.factor]);
    case 'scaleXYZ':
      return scaleAbout(op.center, op.factors);
    case 'mirror': {
      const unitNormal = norm(op.plane.normal);

      return fromPoints(point => sub(point, scale(unitNormal, 2 * dot(sub(point, op.plane.origin), unitNormal))));
    }
    default:
      return null;
  }
}

/** Shell a freeform: remove the cage quads under the picked faces, thicken the sheet inward. */
function shellFreeform(ff: { feature: Extract<Feature, { type: 'freeform' }>; m: Affine }, faces: Face[], t: number): Shape3D {
  const cage = { ...ff.feature.cage, verts: ff.feature.cage.verts.map(vertex => applyAffine(ff.m, vertex)) };
  // Each body face is one cage quad's patch: match by the patch's middle point.
  const sub3 = subdivide(cage, 3);
  const mid = sub3.n / 2;
  const centres = sub3.grids.map(grid => sub3.points[grid[mid][mid]]);
  const drop = new Set<number>();
  for (const face of faces) {
    const center = face.center.toTuple() as Vec3;
    let best = 0;
    centres.forEach((q, i) => {
      if (dist(q, center) < dist(centres[best], center)) {
        best = i;
      }
    });
    drop.add(best);
  }
  if (drop.size >= cage.faces.length) {
    throw new Error('Shell needs at least one face to stay');
  }
  const open = deleteFaces(cage, [...drop]);

  // Closed cages face outward, so "down" (against the normals) is inward.
  return cageToShape(open, 3, { thickness: t, side: 'down' });
}

/** A freeform's shape with its cage mapped by `affine` (thickness grows with the overall scale). */
function freeformShape(freeform: Extract<Feature, { type: 'freeform' }>, affine: Affine): Shape3D {
  const cage = { ...freeform.cage, verts: freeform.cage.verts.map(vertex => applyAffine(affine, vertex)) };
  const det = Math.abs(affine[0] * (affine[5] * affine[10] - affine[6] * affine[9]) - affine[1] * (affine[4] * affine[10] - affine[6] * affine[8]) + affine[2] * (affine[4] * affine[9] - affine[5] * affine[8]));
  const thicken = freeform.thickness ? { thickness: freeform.thickness * Math.cbrt(det || 1), side: freeform.thickSide ?? 'up' } : undefined;

  return checkedFreeform(cage, thicken);
}

/**
 * A freeform's body, only if it's a clean one: a surface that passes through
 * itself (a cage point pulled through the body) or collapses (points on top
 * of each other) would make a solid every later edit trips over.
 */
function checkedFreeform(cage: { verts: Vec3[]; faces: [number, number, number, number][] }, thicken?: { thickness: number; side: 'up' | 'down' | 'both' }): Shape3D {
  if (selfCrossings(cage, 2, 1).length) {
    throw new Error('This freeform passes through itself (a cage point pulled through the body, or faces folded over) - pull it back; it shows red while you edit it');
  }
  let shape: Shape3D;
  try {
    shape = cageToShape(cage, 3, thicken);
  } catch (e) {
    if (thicken) {
      throw new Error("That thickness doesn't fit this surface (it folds into itself) - try a thinner one, or the other side");
    }
    throw e;
  }
  const closed = isClosed(cage) || !!thicken;
  const degenerate = 'This freeform has collapsed somewhere (cage points on top of each other, or a face squashed flat) - move those points apart';
  if (!shapeValid(shape)) {
    const repaired = repairShape(shape, { maxSolids: 1 });
    if (!repaired) {
      throw new Error(thicken ? "That thickness doesn't fit this surface (it folds into itself) - try a thinner one, or the other side" : degenerate);
    }
    editNotes.push(`Repaired automatically: ${repaired.fixes.join(', ')}.`);
    shape = repaired.shape;
  }
  if (closed && (subShapes(shape, 'SOLID').length !== 1 || !(quickVolume(shape) > 0))) {
    throw new Error(degenerate);
  }

  return shape;
}

/**
 * Scale a flat face within its plane: each flat neighbour turns about its far
 * side so it passes through the face's moved edge (like a taper).
 */
function scaleFace(body: Shape3D, face: Face, u0: Vec3, [su, sv]: [number, number]): Shape3D {
  if (face.geomType !== 'PLANE') {
    throw new Error('Scale Face works on flat faces');
  }
  if (su <= 0 || sv <= 0) {
    throw new Error('Scale factors must be positive');
  }
  const { normal: normal } = planeOf(face);
  const center = face.center.toTuple() as Vec3;
  const unitU = norm(sub(u0, scale(normal, dot(u0, normal))));
  const unitV = cross(normal, unitU);
  const map = (point: Vec3): Vec3 => {
    const offset = sub(point, center);

    return add(center, add(add(scale(unitU, su * dot(offset, unitU)), scale(unitV, sv * dot(offset, unitV))), scale(normal, dot(offset, normal))));
  };
  const targets = face.edges.map((edge) => {
    if (edge.geomType !== 'LINE') {
      throw new Error("Scale Face needs straight edges (round edges can't taper yet)");
    }
    const neighbour = body.faces.find(candidate => !candidate.isSame(face) && candidate.edges.some(e => e.isSame(edge)));
    if (!neighbour) {
      throw new Error('A neighbouring face is missing');
    }
    if (neighbour.geomType !== 'PLANE') {
      throw new Error('Scale Face works when the faces around it are flat');
    }
    const a = edge.startPoint.toTuple() as Vec3;
    const b = edge.endPoint.toTuple() as Vec3;
    const a2 = map(a);
    const b2 = map(b);
    const direction = norm(sub(b, a));
    const off = (point: Vec3) => len(sub(sub(point, a), scale(direction, dot(sub(point, a), direction))));
    const pts = neighbour.edges.flatMap(e => [e.startPoint.toTuple() as Vec3, e.endPoint.toTuple() as Vec3]);
    const far = pts.reduce((farthest, point) => (off(point) > off(farthest) ? point : farthest), pts[0]);
    const old = planeOf(neighbour);
    let nn = norm(cross(sub(b2, a2), sub(far, a2)));
    if (dot(nn, old.normal) < 0) {
      nn = scale(nn, -1);
    }

    return { sig: faceInfo(neighbour), plane: { origin: a2, normal: nn, xDir: xDirFor(nn) } };
  });
  let out = body;
  for (const t of targets) {
    // A side that stays where it is (scaled 1 that way): left alone - it may
    // run the whole length of the part (a lever's side, from the hub to the tip).
    const old = { origin: t.sig.center, normal: norm(t.sig.normal) };
    if (Math.abs(dot(norm(t.plane.normal), old.normal)) > 1 - 1e-12 && Math.abs(dot(sub(t.plane.origin, old.origin), old.normal)) < sizeOf(body) * 1e-9) {
      continue;
    }
    out = replaceFacePlane(out, resolveFace(out, { body: '', center: t.sig.center, normal: t.sig.normal, area: t.sig.area }), t.plane);
  }

  return out;
}

/**
 * Move a straight edge: each flat face on it turns about its far side so it
 * passes through the edge's new position.
 */
function moveEdge(body: Shape3D, ref: EdgeRef, move: (p: Vec3) => Vec3): Shape3D {
  const edge = resolveEdge(body, ref);
  if (edge.geomType !== 'LINE') {
    throw new Error('Only straight edges can be moved');
  }
  const a = edge.startPoint.toTuple() as Vec3;
  const b = edge.endPoint.toTuple() as Vec3;
  const a2 = move(a);
  const b2 = move(b);
  // A body of flat faces: just the edge's two corners move; every other corner
  // stays (bending faces are split) - repeated moves don't drift or pile up.
  const poly = movePolyhedronPoints(body, [[a, a2], [b, b2]]);
  if (poly) {
    return poly;
  }
  const d2 = norm(sub(b2, a2));
  const faces = body.faces.filter(face => face.edges.some(e => e.isSame(edge)));
  if (faces.some(face => face.geomType !== 'PLANE')) {
    throw new Error('Only edges between flat faces can be moved');
  }
  const targets = faces.map((face) => {
    const old = planeOf(face);
    // The face's point farthest from the edge stays put.
    const pts = face.edges.flatMap(e => [e.startPoint.toTuple() as Vec3, e.endPoint.toTuple() as Vec3]);
    const direction = norm(sub(b, a));
    const off = (point: Vec3) => len(sub(sub(point, a), scale(direction, dot(sub(point, a), direction))));
    const far = pts.reduce((farthest, point) => (off(point) > off(farthest) ? point : farthest), pts[0]);
    let normal = norm(cross(d2, sub(far, a2)));
    if (dot(normal, old.normal) < 0) {
      normal = scale(normal, -1);
    }

    return { sig: faceInfo(face), plane: { origin: a2, normal: normal, xDir: xDirFor(normal) } };
  });
  let out = body;
  for (const t of targets) {
    out = replaceFacePlane(out, resolveFace(out, { body: ref.body, center: t.sig.center, normal: t.sig.normal, area: t.sig.area }), t.plane);
  }

  return out;
}

/**
 * Move one corner: every flat face meeting at it turns about its far edge (the
 * one not touching the corner) so it passes through the corner's new place.
 */
function moveVertex(body: Shape3D, at: Vec3, to: Vec3): Shape3D {
  // A body of flat faces moves just the point: faces that would bend are split
  // into a triangle at the corner and the untouched rest.
  const poly = movePolyhedronVertex(body, at, to);
  if (poly) {
    return poly;
  }

  return moveVertexByPlanes(body, at, to);
}

/** Outer loop of a flat, straight-edged face as ordered corners (null if it isn't one). */
function faceLoop(face: Face, tol: number): Vec3[] | null {
  // (outerWire / innerWires use up the face they're called on: ask clones.)
  if (face.geomType !== 'PLANE' || face.clone().innerWires().length) {
    return null;
  }
  const edges = face.clone().outerWire().edges;
  if (edges.some(e => e.geomType !== 'LINE')) {
    return null;
  }
  const segs = edges.map(e => [e.startPoint.toTuple() as Vec3, e.endPoint.toTuple() as Vec3]);
  const loop: Vec3[] = [segs[0][0], segs[0][1]];
  const used = new Set([0]);
  while (used.size < segs.length) {
    const last = loop[loop.length - 1];
    const index = segs.findIndex((sg, i) => !used.has(i) && (dist(sg[0], last) < tol || dist(sg[1], last) < tol));
    if (index < 0) {
      return null;
    }
    used.add(index);
    loop.push(dist(segs[index][0], last) < tol ? segs[index][1] : segs[index][0]);
  }
  if (dist(loop[0], loop[loop.length - 1]) > tol) {
    return null;
  }
  loop.pop();
  // Wind it so its normal is the face's outward normal.
  const normal = face.normalAt().toTuple() as Vec3;
  if (dot(polyNormal(loop), normal) < 0) {
    loop.reverse();
  }

  return loop;
}

function polyNormal(pts: Vec3[]): Vec3 {
  let normal: Vec3 = [0, 0, 0];
  for (let i = 0; i < pts.length; i++) {
    normal = add(normal, cross(pts[i], pts[(i + 1) % pts.length]));
  }

  return normal;
}

function coplanar(pts: Vec3[], tol: number): boolean {
  const normal = norm(polyNormal(pts));
  if (!Number.isFinite(normal[0]) || len(normal) < 0.5) {
    return false;
  }

  return pts.every(point => Math.abs(dot(sub(point, pts[0]), normal)) < tol);
}

function movePolyhedronVertex(body: Shape3D, at: Vec3, to: Vec3): Shape3D | null {
  return movePolyhedronPoints(body, [[at, to]]);
}

/**
 * A straight-edged shape tapered: its outline, the outline scaled about its
 * centre at the far end, and a flat four-sided face between each pair of
 * edges (a scaled edge stays parallel to its original, so each side is flat).
 * Null when the outline isn't all straight lines or it doesn't come out solid.
 */
function taperedPrism(face: Face, center: Vec3, normal: Vec3, taper: number, distance: number): Shape3D | null {
  const bb = face.boundingBox;
  const size = Math.hypot(bb.width, bb.height, bb.depth) || 1;
  const loop = faceLoop(face, size * 1e-6);
  if (!loop || loop.length < 3) {
    return null;
  }
  const off = scale(normal, distance);
  const top = loop.map(point => add(add(center, scale(sub(point, center), taper)), off));
  const count = loop.length;
  const polys: Vec3[][] = [[...loop].reverse(), top];
  for (let i = 0; i < count; i++) {
    const j = (i + 1) % count;
    polys.push([loop[i], loop[j], top[j], top[i]]);
  }
  try {
    const build = (list: Vec3[][]) => makeSolid(list.map(pl => makePolygon(pl))) as unknown as Shape3D;
    let solid = build(polys);
    if (measureVolume(solid) < 0) {
      solid = build(polys.map(pl => [...pl].reverse()));
    }
    const volume = measureVolume(solid);
    if (!Number.isFinite(volume) || volume <= 0 || !shapeValid(solid)) {
      return null;
    }

    return solid;
  } catch {
    return null;
  }
}

/**
 * A body of flat, straight-edged faces with some corners moved: every other
 * corner stays exactly where it is. A face whose corners no longer lie in one
 * plane keeps its unmoved part, and the moved corners get triangles (fanned
 * from the unmoved corner before them); coplanar pieces merge again after.
 */
function movePolyhedronPoints(body: Shape3D, moves: [Vec3, Vec3][]): Shape3D | null {
  const size = Math.hypot(body.boundingBox.width, body.boundingBox.height, body.boundingBox.depth) || 1;
  const tol = size * 1e-6;
  // A body in separate pieces (a block added that doesn't touch the rest): the
  // piece with the corners moves, the others stay as they are. (Made as one,
  // the pieces came out as a group, not a solid - every move of a corner failed.)
  const pieces = subShapes(body, 'SOLID');
  if (pieces.length > 1) {
    const on = (piece: Shape3D) => piece.edges.some(e => moves.some(([a]) => dist(e.startPoint.toTuple() as Vec3, a) < tol || dist(e.endPoint.toTuple() as Vec3, a) < tol));
    let hit = false;
    const out: Shape3D[] = [];
    for (const part of pieces) {
      const piece = cast(part) as Shape3D;
      if (!on(piece)) {
        out.push(piece);
        continue;
      }
      hit = true;
      const moved = movePolyhedronPoints(piece, moves);
      if (!moved) {
        return null;
      }
      out.push(moved);
    }

    return hit ? (makeCompound(out as never) as unknown as Shape3D) : null;
  }
  const loops = body.faces.map(face => faceLoop(face, tol));
  if (loops.some(loop => !loop)) {
    return null;
  }
  const movedTo = (point: Vec3): Vec3 | null => moves.find(([a]) => dist(a, point) < tol)?.[1] ?? null;
  const polys: Vec3[][] = [];
  let touched = 0;
  for (const loop of loops as Vec3[][]) {
    const isMoved = loop.map(point => movedTo(point) !== null);
    if (!isMoved.some(Boolean)) {
      polys.push(loop);
      continue;
    }
    touched++;
    const moved = loop.map(point => movedTo(point) ?? point);
    if (coplanar(moved, tol * 10)) {
      polys.push(moved);
      continue;
    }
    // Cut triangles off at the moved corners (ear clipping in the face's own
    // plane, so concave faces stay valid); what's left never moved and stays flat.
    const { tris, rest } = clipMovedCorners(loop, isMoved);
    if (rest.length >= 3) {
      polys.push(rest.map(index => loop[index]));
    }
    for (const t of tris) {
      polys.push(t.map(index => moved[index]));
    }
  }
  if (!touched) {
    throw new Error('That corner is no longer there');
  }
  // A body of flat faces: this is the way to move its corners. If the result
  // folds through itself, say so - another method would only give a mangled
  // shape (and dragging would jump between the two).
  const folded = 'That would fold the faces through each other - move it less far, or another way';
  let solid: Shape3D;
  let volume: number;
  try {
    const build = (list: Vec3[][]) => unify(makeSolid(list.map(pl => makePolygon(pl))) as unknown as Shape3D);
    solid = build(polys);
    volume = measureVolume(solid);
    // Inside out: wind every face the other way.
    if (volume < 0) {
      solid = build(polys.map(pl => [...pl].reverse()));
      volume = measureVolume(solid);
    }
  } catch {
    throw new Error(folded);
  }
  if (!Number.isFinite(volume) || volume < 1e-9 * size ** 3 || solid.faces.length < 4 || !shapeValid(solid)) {
    throw new Error(folded);
  }

  return solid;
}

/**
 * Ear clipping of a flat face's loop that removes the moved corners first:
 * triangles holding a moved corner, plus the untouched rest as one polygon.
 */
function clipMovedCorners(loop: Vec3[], isMoved: boolean[]): { tris: number[][]; rest: number[] } {
  const normal = norm(polyNormal(loop));
  const x = norm(sub(loop[1], loop[0]));
  const y = cross(normal, x);
  const flat = loop.map(point => [dot(sub(point, loop[0]), x), dot(sub(point, loop[0]), y)] as [number, number]);
  const area2 = (a: number, b: number, indexC: number) => (flat[b][0] - flat[a][0]) * (flat[indexC][1] - flat[a][1]) - (flat[b][1] - flat[a][1]) * (flat[indexC][0] - flat[a][0]);
  const idx = loop.map((_, index) => index);
  const tris: number[][] = [];
  const isEar = (i: number): boolean => {
    const count = idx.length;
    const a = idx[(i + count - 1) % count];
    const b = idx[i];
    const nextIndex = idx[(i + 1) % count];
    if (area2(a, b, nextIndex) <= 1e-12) {
      return false;
    }
    for (const index of idx) {
      if (index === a || index === b || index === nextIndex) {
        continue;
      }
      if (area2(a, b, index) >= -1e-12 && area2(b, nextIndex, index) >= -1e-12 && area2(nextIndex, a, index) >= -1e-12) {
        return false;
      }
    }

    return true;
  };
  const clip = (i: number) => {
    const count = idx.length;
    tris.push([idx[(i + count - 1) % count], idx[i], idx[(i + 1) % count]]);
    idx.splice(i, 1);
  };
  let guard = loop.length * 4;
  while (idx.length > 3 && idx.some(index => isMoved[index]) && guard-- > 0) {
    const count = idx.length;
    const order = idx.map((_, i) => i);
    // Ears at a moved corner first, then ears next to one, then any ear.
    const rank = (i: number) => (isMoved[idx[i]] ? 0 : isMoved[idx[(i + 1) % count]] || isMoved[idx[(i + count - 1) % count]] ? 1 : 2);
    order.sort((first, q) => rank(first) - rank(q));
    const ear = order.find(isEar);
    if (ear === undefined) {
      break;
    }
    clip(ear);
  }
  if (idx.some(index => isMoved[index])) {
    // Down to a triangle (or clipping got stuck): all of it moves.
    if (idx.length === 3) {
      tris.push([...idx]);
    } else {
      for (let q = 1; q + 1 < idx.length; q++) {
        tris.push([idx[0], idx[q], idx[q + 1]]);
      }
    }

    return { tris, rest: [] };
  }

  return { tris, rest: idx };
}

function moveVertexByPlanes(body: Shape3D, at: Vec3, to: Vec3): Shape3D {
  const size = Math.hypot(body.boundingBox.width, body.boundingBox.height, body.boundingBox.depth) || 1;
  const tol = size * 1e-6;
  const ends = (e: Edge): Vec3[] => [e.startPoint.toTuple() as Vec3, e.endPoint.toTuple() as Vec3];
  const faces = body.faces.filter(face => face.edges.some(e => ends(e).some(end => dist(end, at) < tol)));
  if (!faces.length) {
    throw new Error('That corner is no longer there');
  }
  if (faces.some(face => face.geomType !== 'PLANE')) {
    throw new Error('Only corners where flat faces meet can be moved');
  }
  const targets = faces.map((face) => {
    const old = planeOf(face);
    // The far edge: both ends away from the corner, the farthest such edge.
    const far = face.edges
      .filter(e => e.geomType === 'LINE' && ends(e).every(end => dist(end, at) > tol))
      .sort((a, b) => dist(b.pointAt(0.5).toTuple() as Vec3, at) - dist(a.pointAt(0.5).toTuple() as Vec3, at))[0];
    if (!far) {
      throw new Error('Moving this corner needs straight-edged faces around it');
    }
    const [p1, p2] = ends(far);
    let normal = norm(cross(sub(p1, to), sub(p2, to)));
    if (len(normal) < 1e-9 || !Number.isFinite(normal[0])) {
      throw new Error("The corner can't go there (a face would fold flat)");
    }
    if (dot(normal, old.normal) < 0) {
      normal = scale(normal, -1);
    }

    return { sig: faceInfo(face), plane: { origin: to, normal: normal, xDir: xDirFor(normal) } };
  });
  let out = body;
  for (const t of targets) {
    out = replaceFacePlane(out, resolveFace(out, { body: '', center: t.sig.center, normal: t.sig.normal, area: t.sig.area }), t.plane);
  }

  return out;
}

/**
 * Remove an edge: merge its faces when they lie on one surface, otherwise drop
 * the blend face it bounds (fillet/chamfer) so its neighbours meet again.
 */
function deleteEdge(body: Shape3D, ref: EdgeRef): Shape3D {
  const edge = resolveEdge(body, ref);
  const merged = unify(body);
  if (merged.edges.length < body.edges.length && !hasEdge(merged, ref)) {
    return merged;
  }
  const adjacent = body.faces.filter(face => face.edges.some(e => e.isSame(edge)));
  // Try the curved / smaller face first: that's the blend.
  adjacent.sort((a, b) => (a.geomType === 'PLANE' ? 1 : 0) - (b.geomType === 'PLANE' ? 1 : 0) || measureArea(a) - measureArea(b));
  for (const face of adjacent) {
    try {
      return deleteFace(body, face);
    } catch {
      // try the other face
    }
  }
  throw new Error("This edge can't be removed - the faces around it wouldn't close up");
}

function hasEdge(body: Shape3D, ref: EdgeRef): boolean {
  try {
    const e = edgeInfo(resolveEdge(body, ref));

    return dist(e.mid, ref.mid) < (ref.length || 1) * 1e-3 && Math.abs(e.length - ref.length) < (ref.length || 1) * 1e-3;
  } catch {
    return false;
  }
}

/**
 * A profile turned `angle` degrees about an axis while moving `travel` along
 * it: swept along a helix through the profile's centre, keeping its
 * orientation to the axis (binormal mode), as threads are made.
 */
function helicalSweep(wire: Wire, origin: Vec3, dir: Vec3, angle: number, travel: number): Shape3D {
  const bb = wire.boundingBox;
  const center = bb.center as Vec3;
  // The helix runs through the profile's centre (or, on the axis, its far side).
  const radial = (point: Vec3) => {
    const offset = sub(point, origin);

    return sub(offset, scale(dir, dot(offset, dir)));
  };
  let start = center;
  if (len(radial(center)) < 1e-6 * (1 + bb.width + bb.height + bb.depth)) {
    const far = wire.edges.flatMap(e => [0, 0.5, 1].map(t => e.pointAt(t).toTuple() as Vec3)).sort((a, b) => len(radial(b)) - len(radial(a)))[0];
    start = far;
  }
  const turns = Math.abs(angle) / 360;
  const segments = Math.max(16, Math.ceil(turns * 48));
  const pts: Vec3[] = [];
  const rel = sub(start, origin);
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const th = (angle * Math.PI * t) / 180;
    // Rodrigues' rotation about the axis, plus the travel so far.
    const rotated = add(add(scale(rel, Math.cos(th)), scale(cross(dir, rel), Math.sin(th))), scale(dir, dot(dir, rel) * (1 - Math.cos(th))));
    pts.push(add(add(origin, rotated), scale(dir, travel * t)));
  }
  const spine = assembleWire([makeBSplineApproximation(pts, { tolerance: 1e-5 * (1 + len(rel)), degMax: 5, degMin: 3 })]);
  const oc = getOC();
  const builder = new oc.BRepOffsetAPI_MakePipeShell(spine.wrapped);
  const bi = new oc.gp_Dir(dir[0], dir[1], dir[2]);
  try {
    builder.SetMode(bi);
    builder.Add(wire.wrapped, false, false);
    builder.Build();
    if (!builder.IsDone()) {
      throw new Error("The profile can't be swept round this axis");
    }
    builder.MakeSolid();
    const shape = cast(builder.Shape());
    if (!isShape3D(shape)) {
      throw new Error("The profile can't be swept round this axis");
    }

    return shape;
  } finally {
    builder.delete();
    bi.delete();
  }
}

/**
 * Fill: a surface over a network of curves (BRepOffsetAPI_MakeFilling). The
 * boundary's edges bound it; along a body's edge it can meet that body's face
 * tangentially (G1) or with matching curvature (G2). Guides are curves it
 * passes through. The surface is an open body of its own.
 */
function fillNetwork(fillFeature: Extract<Feature, { type: 'fill' }>, ctx: Ctx): Shape3D {
  if (!fillFeature.boundary.length) {
    throw new Error('Pick the curves or edges round the surface');
  }
  const oc = getOC();
  const orderOf = (continuity?: string) => (continuity === 'g2' ? oc.GeomAbs_Shape.GeomAbs_G2 : continuity === 'g1' ? oc.GeomAbs_Shape.GeomAbs_G1 : oc.GeomAbs_Shape.GeomAbs_C0);
  // Each body edge: its own continuity, else the one for all.
  const cont = (edgeRef?: EdgeRef) => (edgeRef && fillFeature.edgeContinuity?.[fillEdgeKey(edgeRef)]) ?? fillFeature.continuity;
  let g2 = fillFeature.continuity === 'g2';
  const edgesOf = (pathRef: PathRef): Edge[] => {
    if (pathRef.kind === 'edges') {
      return pathRef.edges.map(edge => resolveEdge(need(ctx.bodies, edge.body), edge));
    }

    return pathWire(pathRef, ctx).edges;
  };
  const fill = new oc.BRepOffsetAPI_MakeFilling(3, 15, 2, false, 1e-5, 1e-4, 0.01, 0.1, 8, 9);
  try {
    let count = 0;
    for (const pathRef of fillFeature.boundary) {
      edgesOf(pathRef).forEach((e, edgeIndex) => {
      // A body's edge, held to the face beside it (the first one of that body that has it).
        const continuity = pathRef.kind === 'edges' ? cont(pathRef.edges[edgeIndex]) : undefined;
        if (continuity === 'g2') {
          g2 = true;
        }
        const beside = pathRef.kind === 'edges' && continuity && continuity !== 'g0' ? need(ctx.bodies, pathRef.edges[edgeIndex].body).faces.find(fc => fc.edges.some(edge => edge.isSame(e))) : undefined;
        if (beside) {
          fill.Add(e.wrapped, beside.wrapped, orderOf(continuity), true);
        } else {
          fill.Add(e.wrapped, oc.GeomAbs_Shape.GeomAbs_C0, true);
        }
        count++;
      });
    }
    const only = count === 1 ? edgesOf(fillFeature.boundary[0])[0] : null;
    if (count === 0 || (only && dist(only.startPoint.toTuple() as Vec3, only.endPoint.toTuple() as Vec3) > 1e-6)) {
      throw new Error('The boundary needs curves that close a loop');
    }
    for (const pathRef of fillFeature.guides ?? []) {
      for (const e of edgesOf(pathRef)) {
        fill.Add(e.wrapped, oc.GeomAbs_Shape.GeomAbs_C0, false);
      }
    }
    fill.Build(new oc.Message_ProgressRange());
    if (!fill.IsDone()) {
      throw new Error('no fill');
    }
    const made = cast(fill.Shape()) as AnyShape;
    const faces = 'faces' in made ? (made as unknown as { faces: Face[] }).faces : [made as unknown as Face];
    if (!faces.length) {
      throw new Error('no fill');
    }
    const builder = new oc.TopoDS_Builder();
    const shell = new oc.TopoDS_Shell();
    builder.MakeShell(shell);
    for (const fc of faces) {
      builder.Add(shell, fc.wrapped);
    }
    builder.delete();

    return cast(shell) as Shape3D;
  } catch (err) {
    if (err instanceof Error && /boundary needs/.test(err.message)) {
      throw err;
    }
    if (g2) {
      throw new Error("Curvature (G2) couldn't be held along these edges - Tangent (G1) can be tried");
    }
    throw new Error("These curves don't make a surface - the boundary must close a loop (end to end), and guides lie across it");
  } finally {
    fill.delete();
  }
}

/** Sweep a profile along a path without turning it (Orientation: Parallel to profile). */
function fixedSweep(wire: Wire, spine: Wire, corner: 'round' | 'right', law: ReturnType<typeof scaleLaw> | null): Shape3D {
  const oc = getOC();
  const builder = new oc.BRepOffsetAPI_MakePipeShell(spine.wrapped);
  const origin = new oc.gp_Pnt(0, 0, 0);
  const direction = new oc.gp_Dir(0, 0, 1);
  const ax = new oc.gp_Ax2(origin, direction);
  try {
    builder.SetMode(ax);
    builder.SetTransitionMode(corner === 'right' ? oc.BRepBuilderAPI_TransitionMode.BRepBuilderAPI_RightCorner : oc.BRepBuilderAPI_TransitionMode.BRepBuilderAPI_RoundCorner);
    if (law) {
      builder.SetLaw(wire.wrapped, law, false, false);
    } else {
      builder.Add(wire.wrapped, false, false);
    }
    builder.Build();
    if (!builder.IsDone()) {
      throw new Error("The profile can't be swept along this path facing the same way - try Normal to path");
    }
    builder.MakeSolid();
    const shape = cast(builder.Shape());
    if (!isShape3D(shape)) {
      throw new Error("The profile can't be swept along this path facing the same way - try Normal to path");
    }

    return shape;
  } finally {
    builder.delete();
    ax.delete();
    origin.delete();
    direction.delete();
  }
}

/**
 * Profile Position "start": a function that moves a wire of the profile so
 * the profile's centre is on the path's end nearer to it, and turns it square
 * to the path there (its normal along the path, pointing on along it).
 */
function onPathStart(faces: { face: Face; normal: Vec3 }[], spine: Wire): (w: Wire) => Wire {
  if (!faces.length) {
    return wire => wire;
  }
  const center = faces[0].face.center.toTuple() as Vec3;
  const normal = norm(faces[0].normal);
  const a = spine.startPoint.toTuple() as Vec3;
  const b = spine.endPoint.toTuple() as Vec3;
  const atStart = dist(center, a) <= dist(center, b);
  const point = atStart ? a : b;
  // On along the path, from that end.
  let t = norm(spine.tangentAt(atStart ? 0 : 1).toTuple() as Vec3);
  if (!atStart) {
    t = scale(t, -1);
  }
  // The profile's side that faces along the path stays its front (normal·t > 0 after turning).
  const from = dot(normal, t) < 0 ? scale(normal, -1) : normal;
  const axis = cross(from, t);
  const length = len(axis);
  const angle = (Math.atan2(length, dot(from, t)) * 180) / Math.PI;

  return (wire) => {
    let out = wire.clone();
    if (length > 1e-9 && Math.abs(angle) > 1e-9) {
      out = out.rotate(angle, center, scale(axis, 1 / length));
    }

    return out.translate(sub(point, center));
  };
}

/**
 * Loft end continuity: copies of the first (last) profile set a little way
 * along its normal, towards the next one, so the smooth loft leaves it
 * straight out (G1); a second copy further on holds the curve too (G2).
 */
function withEndPulls(wires: Wire[], normals: Vec3[], start: 'g1' | 'g2' | undefined, sw: number, end: 'g1' | 'g2' | undefined, ew: number): Wire[] {
  const centre = (wire: Wire) => wire.boundingBox.center as Vec3;
  const pulls = (wire: Wire, normal: Vec3, next: Wire, kind: 'g1' | 'g2', weight: number): Wire[] => {
    const toward = sub(centre(next), centre(wire));
    const gap = Math.abs(dot(toward, normal)) || len(toward);
    const dir = dot(toward, normal) < 0 ? scale(normal, -1) : normal;
    const distance = (gap * 0.25 * Math.max(weight, 0.05)) / (kind === 'g2' ? 2 : 1);

    return (kind === 'g2' ? [1, 2] : [1]).map(step => wire.clone().translate(scale(dir, distance * step)));
  };
  const last = wires.length - 1;
  const head = start ? pulls(wires[0], norm(normals[0]), wires[1], start, sw) : [];
  const tail = end ? pulls(wires[last], norm(normals[last]), wires[last - 1], end, ew).reverse() : [];

  return [wires[0], ...head, ...wires.slice(1, last), ...tail, wires[last]];
}

/** Sweep a profile along a path, keeping it square to `up` (a helix: the profile stays in planes through the axis). */
function pipeAlong(profile: Wire, path: Wire, up: Vec3): Shape3D {
  const oc = getOC();
  const builder = new oc.BRepOffsetAPI_MakePipeShell(path.wrapped);
  const bi = new oc.gp_Dir(up[0], up[1], up[2]);
  try {
    builder.SetMode(bi);
    builder.Add(profile.wrapped, false, false);
    builder.Build();
    if (!builder.IsDone()) {
      throw new Error("The thread's groove couldn't be made");
    }
    builder.MakeSolid();
    const shape = cast(builder.Shape());
    if (!isShape3D(shape)) {
      throw new Error("The thread's groove couldn't be made");
    }

    return shape;
  } finally {
    builder.delete();
    bi.delete();
  }
}

/** Turns of a thread's groove made in one piece (see threadFace). */
const MAX_THREAD_TURNS = 8;

/** The round face a thread step threads. */
function threadTarget(body: Shape3D, thread: Extract<Feature, { type: 'thread' }>): Face {
  // Only a round face of the kind picked (a hole stays a hole): with the
  // boss its hole was in switched off, the nearest face was the box's
  // rounded corner - threaded, 60 turns of it, for over a minute. And
  // about its size: a shelled box's inside corner is a "hole" too.
  const round = (face: Face) => {
    if (face.geomType !== 'CYLINDRE') {
      return false;
    }
    const cy = cylinderOf(face);

    return !!cy && (!thread.round || ((cy.s < 0) === thread.round.hole && cy.r < thread.round.r * 2 && cy.r > thread.round.r / 2));
  };
  try {
    return resolveFace(body, thread.face, round);
  } catch {
    // Never a round face (a flat one picked): threadFace says threads go on round faces.
    if (!thread.round) {
      return resolveFace(body, thread.face);
    }
    throw new Error(thread.round.hole ? 'The hole it was cut in is gone' : 'The round face it was cut on is gone');
  }
}

/** A thread's starts as a whole number from 1 to 8 (missing, or nonsense: 1). */
const threadStarts = (count: number | undefined): number => (Number.isFinite(count) ? Math.max(1, Math.min(8, Math.round(count!))) : 1);

/**
 * Cut an ISO 60° thread into a round face: a V groove swept along a helix
 * round the face's axis (deepest at the minor diameter of a shank, the major
 * of a hole), kept to the face's own length, cut away. Cutting (never adding
 * a ridge) is the reliable way: a ridge only just overlapping its core can
 * come out of OpenCascade wrong without a word.
 */
export function threadFace(body: Shape3D, face: Face, pitch: number, left = false, like?: { t0: number; t1: number; anchor?: number; phase?: number; shallow?: number; c?: Vec3; a?: Vec3 }, used?: { phase?: number }, starts = 1): Shape3D {
  if (face.geomType !== 'CYLINDRE') {
    throw new Error('Threads go on round faces (a shank or a hole)');
  }
  if (!(pitch > 0)) {
    throw new Error('The pitch must be more than 0');
  }
  // (Finer than any standard thread: it failed with "try a slightly different pitch".)
  if (pitch < 0.2 - 1e-9) {
    throw new Error('That pitch is too fine - the finest is 0.2 mm');
  }
  const cy0 = cylinderOf(face);
  // (`like.c`, `like.a`: measured from the same point along the same axis as another thread. A face's own centre
  // and the way its axis points are the kernel's choice, and differ from one body to the same body grown - the
  // turns then started somewhere else, and ran into the first thread's.)
  const cy = cy0 && like?.c && like.a ? { ...cy0, c: like.c, a: like.a } : cy0;
  if (!cy) {
    throw new Error('Threads go on round faces (a shank or a hole)');
  }
  const inside = cy.s < 0;
  // (`like.shallow`: a groove that much less deep, and so that much narrower - the thread of a body grown by a
  // clearance. Its round face is already out by the clearance; with the V out by it once more, its sides stand
  // that clearance off the first thread's sides, not half of it.)
  const depth = threadDepth(pitch, inside) - (like?.shallow ?? 0);
  if (!(depth > 0)) {
    throw new Error('That clearance is more than the thread is deep');
  }
  if (!inside && depth >= cy.r * 0.9) {
    throw new Error('That pitch is too coarse for this diameter');
  }
  const a = norm(cy.a);
  // The face's length along its axis.
  const ts: number[] = [];
  for (const e of face.edges) {
    for (const fraction of [0, 0.25, 0.5, 0.75, 1]) {
      ts.push(dot(sub(e.pointAt(fraction).toTuple() as Vec3, cy.c), a));
    }
  }
  // (`like`: along the same stretch and from the same start as another thread - one cut again on the body grown,
  // so its turns lie over the first one's.)
  const t0 = like ? like.t0 : Math.min(...ts);
  const t1 = like ? like.t1 : Math.max(...ts);
  if (t1 - t0 < pitch) {
    throw new Error('This face is shorter than one turn of the thread');
  }
  // The groove's section in a plane through the axis: a 60° V from its tip
  // (the thread's depth) opening past the face.
  const out = inside ? -1 : 1;
  const tip = cy.r - out * depth;
  const mouth = cy.r + out * 0.2 * pitch;
  const hm = Math.abs(mouth - tip) * Math.tan(Math.PI / 6);
  // The groove stops just short of both ends: its ends never lie on a face of
  // the body (a groove run out through an end face makes OpenCascade's cut
  // take the wrong amount, every start tried), and under a head it mustn't
  // cut into the head anyway. That leaves a thin ring of the face at each end
  // and the groove's flat stub beside it: at an end with nothing past it (a
  // shank's free end, a hole's open end) - seen there as stray little faces
  // along its edge - a 45° chamfer down to the thread's root takes them away,
  // as a bolt's end (a nut's mouth) is made.
  const side = norm(cross(a, Math.abs(a[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]));
  const side2 = cross(a, side);
  const freeAt = (t: number, way: number): boolean => {
    const rr = (cy.r + tip) / 2;
    const at: Vec3[] = [];
    for (let index = 0; index < 6; index++) {
      const th = (index * Math.PI) / 3;
      at.push(add(add(cy.c, scale(a, t + way * 0.3 * pitch)), add(scale(side, rr * Math.cos(th)), scale(side2, rr * Math.sin(th)))));
    }
    try {
      return !insideOf(body, at).some(Boolean);
    } catch {
      return false;
    }
  };
  const res = threadCut(body, face, cy, a, pitch, left, inside, depth, tip, mouth, hm, t0, t1, like?.phase, used, like?.anchor, starts);
  if (res) {
    let shape = res;
    for (const [t, way] of [[t0, -1], [t1, 1]] as const) {
      if (freeAt(t, way)) {
        shape = threadEndChamfer(shape, cy.c, a, side, cy.r, tip, out, t, way, pitch) ?? shape;
      }
    }

    return shape;
  }
  // A very fine pitch on a wide face is where this happens: "slightly different" sent people from 0.2 to 0.21.
  throw new Error(pitch < 0.1 * cy.r ? "The thread couldn't be cut here - try a coarser pitch" : "The thread couldn't be cut here - try a slightly different pitch");
}

/**
 * A thread's free end chamfered at 45° from the face down to the thread's
 * root (in to the minor diameter of a shank, out to the major of a hole), so
 * the groove's stopped end is cut away. Null when the cut goes wrong.
 */
function threadEndChamfer(body: Shape3D, center: Vec3, a: Vec3, side: Vec3, radius: number, tip: number, out: number, t: number, way: number, pitch: number): Shape3D | null {
  try {
    const e = 0.5 * pitch;
    const air = radius + out * e;
    const at = (rr: number, tt: number): Vec3 => add(add(center, scale(a, tt)), scale(side, rr));
    // A triangle in a plane through the axis, its slope through (root, end), turned all the way round.
    // (Through a point a little below the root: through the root itself, a sliver of the groove's stub stayed.)
    const root = tip - out * 0.15 * pitch;
    const tri = makePolygon([at(root - out * e, t + way * e), at(air, t + way * e), at(air, t - way * Math.abs(air - root))]);
    const ring = revolution(tri, center, a, 360) as Shape3D;
    // (Each volume once: this body is the groove's result, measured there already.)
    const v0 = Math.abs(volumeOf(body));
    const res = body.cut(ring);
    const volume = Math.abs(volumeOf(res));
    // It takes a little (no more than the ring holds, at most the body's own share of it).
    const most = Math.abs(measureVolume(ring));
    if (!Number.isFinite(volume) || !(volume < v0) || v0 - volume > most || subShapes(res, 'SOLID').length !== subShapes(body, 'SOLID').length) {
      return null;
    }

    return res;
  } catch {
    return null;
  }
}

/** threadFace's groove, stopped just short of both ends; null when it can't be made right. */
function threadCut(
  body: Shape3D,
  face: Face,
  cy: NonNullable<ReturnType<typeof cylinderOf>>,
  a: Vec3,
  pitch: number,
  left: boolean,
  inside: boolean,
  depth: number,
  tip: number,
  mouth: number,
  hm: number,
  t0: number,
  t1: number,
  only?: number,
  used?: { phase?: number },
  anchor?: number,
  starts = 1
): Shape3D | null {
  // Several starts: that many grooves side by side, each going `lead` along in one turn, a pitch from the next.
  const lead = pitch * starts;
  const lo = t0 + 0.05 * pitch;
  const hi = t1 - 0.05 * pitch;
  // Only along the face (a shank's thread mustn't run into the head).
  const reach = Math.max(cy.r, tip, mouth) + pitch * 2;
  const slab = makeCylinder(reach, hi - lo, add(cy.c, scale(a, lo)), a) as Shape3D;
  const v0 = Math.abs(volumeOf(body));
  // What it must take away: the V inside the face (depth deep, 2·depth·tan30
  // wide at the face) along the helix through its centroid.
  const section = depth * depth * Math.tan(Math.PI / 6);
  const rc = inside ? cy.r + depth / 3 : cy.r - depth / 3;
  // (As many grooves pass any one place along the face as it is pitches long, whatever the starts: each groove is
  // longer in a turn, and there are fewer turns of it.)
  const expect = section * Math.hypot(2 * Math.PI * rc, lead) * ((hi - lo) / lead) * starts;
  // A face that isn't a whole ring (a shank with flats cut along it, a slot
  // across a hole) loses less: what the groove overlaps, if that's no more.
  // (A whole ring must lose all of it: a groove that came out broken - a
  // crankshaft's M24 at one start overlapped the pin by half what it should -
  // took half, and "what the groove overlaps" passed it.)
  const whole = trueArea(face) > 2 * Math.PI * cy.r * (t1 - t0) * (1 - 1e-4);
  const ok = (shape: Shape3D, cut: Shape3D) => {
    const volume = Math.abs(volumeOf(shape));
    if (!Number.isFinite(volume)) {
      return false;
    }
    if (Math.abs(v0 - volume - expect) < expect * 0.03) {
      return true;
    }
    if (whole) {
      return false;
    }
    try {
      const want = Math.abs(measureVolume(fuzzyBoolean('common', body, cut)));

      return want > expect * 0.05 && want < expect * 1.03 && Math.abs(v0 - volume - want) < want * 0.03;
    } catch {
      return false;
    }
  };
  // Where the thread starts round the face doesn't matter: if OpenCascade
  // trips on one start (a groove lining up with the face's seams), another
  // is tried.
  for (const phase of only !== undefined ? [only] : [0, 0.37, 0.71]) {
    // (`anchor`: where another thread's stretch began - the turns start from there, whatever stretch this one has.)
    const start = (anchor !== undefined ? anchor + 0.05 * pitch : lo) - lead * (1 + phase);
    const turns = Math.ceil((hi - start) / lead) + 1;
    // An exact helix (a line wound on a cylinder, not a fitted spline: those
    // drift over many turns and the sweep fails), through the groove's middle.
    // Long threads go in pieces of a few whole turns: one 40-turn groove in an
    // M3 boss hole made OpenCascade's cut find nothing to cut (after 40 s).
    // Whole turns, so each piece ends on the very face the next starts on.
    const per = Math.ceil(turns / Math.ceil(turns / MAX_THREAD_TURNS));
    let cut: Shape3D;
    try {
      const grooves: Shape3D[] = [];
      for (let startIndex = 0; startIndex < starts; startIndex++) {
        const pieces: Shape3D[] = [];
        for (let piece = 0; piece * per < turns; piece++) {
          const turnCount = Math.min(per, turns - piece * per);
          // (The next start's groove: the same, one pitch along.)
          const base = add(cy.c, scale(a, start + startIndex * pitch + piece * per * lead));
          const helix = makeHelix(lead, lead * turnCount, (tip + mouth) / 2, base, a, left);
          const r0 = sub(helix.startPoint.toTuple() as Vec3, base);
          const ur = norm(sub(r0, scale(a, dot(r0, a))));
          const at = (rr: number, t: number): Vec3 => add(add(base, scale(a, t)), scale(ur, rr));
          const profile = makePolygon([at(mouth, -hm), at(tip, 0), at(mouth, hm)]).outerWire();
          pieces.push(pipeAlong(profile, helix, a).intersect(slab));
        }
        // Fused into one groove where it can be: cut as pieces, a little flat
        // triangle stayed where each piece met the next (a stray face on the
        // thread, all of them in a line down one side).
        let one: Shape3D | null = pieces.length === 1 ? pieces[0] : null;
        if (!one) {
          try {
            let firstPiece = pieces[0];
            for (const q of pieces.slice(1)) {
              firstPiece = fuzzyBoolean('fuse', firstPiece, q);
            }
            if (subShapes(firstPiece, 'SOLID').length === 1) {
              one = firstPiece;
            }
          } catch {
          // the pieces, then
          }
        }
        grooves.push(one ?? (makeCompound(pieces) as unknown as Shape3D));
      }
      cut = grooves.length === 1 ? grooves[0] : (makeCompound(grooves) as unknown as Shape3D);
    } catch {
      continue;
    }
    for (const fuzzy of [true, false]) {
      try {
        const res = fuzzy ? fuzzyBoolean('cut', body, cut) : body.cut(cut);
        if (ok(res, cut)) {
          if (used) {
            used.phase = phase;
          }

          return res;
        }
      } catch {
        // the other way, or the next start
      }
    }
  }

  return null;
}

/** A shell in pieces: what was cut into the opened face hung from that face alone. */
const SHELL_LOOSE = 'Opening this face would leave what is cut into it (a pocket, a blind hole) standing loose from the rest - open another face';
const WALLS_CLASH
  = "Walls this thick don't fit everywhere: somewhere two faces are closer together than two walls (a hole near a side, a pocket near a hole), and their walls would run into each other - try a thinner wall";

/**
 * Does a shell have a wall behind every face it kept? Spots half a wall deep
 * behind points spread over each face (so in the wall wherever it is in the
 * body): every one of them that is in the body must be in the shell too.
 * (600 spots at most, shared out among the faces. Asked point by point: done
 * with booleans against little cubes, the check of a shelled mouse - spline
 * walls, offset faces inside - took half a minute.)
 */
function wallsStand(body: Shape3D, shell: Shape3D, kept: Face[], t: number): boolean {
  if (!kept.length || !(t > 0)) {
    return true;
  }
  try {
    const each = Math.max(1, Math.min(6, Math.floor(600 / kept.length)));
    const every = Math.ceil(kept.length / 600);
    const at: Vec3[] = [];
    // (Each told by a segment out through the face it is behind, to just past it: outside both.)
    const past: Vec3[] = [];
    for (const [i, face] of kept.entries()) {
      if (i % every) {
        continue;
      }
      for (const { p, n } of spotsOn(body, face, each)) {
        at.push(sub(p, scale(n, t / 2)));
        past.push(add(p, scale(n, t / 50)));
      }
    }
    if (!at.length) {
      return true;
    }
    const inBody = insideAlong(body, at, past, true);
    const keep = at.map((_, index) => index).filter(index => inBody[index]);
    const inShell = insideAlong(shell, keep.map(index => at[index]), keep.map(index => past[index]));

    return inShell.every(Boolean);
  } catch {
    // Can't tell: the usual checks speak for it.
    return true;
  }
}

/**
 * Which of the points are inside the solid, each told by a short segment from
 * it to a point known to be outside (just past the face the point sits
 * behind): inside when the segment crosses the solid's boundary an odd number
 * of times. All the segments go into one section with the solid, which only
 * looks at the faces near each one - where measuring each point's distance to
 * the whole solid (insideOf) took 50 s for a guitar's shelled body. A segment
 * the section can't tell about (it runs along a face, or a crossing lands on
 * one of its ends) is asked the slow way.
 */
function insideAlong(shape: Shape3D, from: Vec3[], to: Vec3[], sound = false): boolean[] {
  const oc = getOC();
  const out: (boolean | undefined)[] = from.map(() => undefined);
  const size = sizeOf(shape);
  const tol = Math.max(1e-6, size * 1e-6);
  // ...and each one again the other way, right out of the solid: a sound
  // solid gives both the same answer. (A shell whose walls ran into each
  // other kept a pocket's face with no wall behind it - air on both sides:
  // the short way through it counted it, and said "inside".)
  // (Out the shortest way, square to the nearest side of its box: through
  // the middle of a guitar's body every ray crossed so many faces that this
  // took as long as asking each point the slow way.)
  const [lo, hi] = shape.boundingBox.bounds;
  const margin = size * 0.01 + 1e-3;
  const back = from.map((a): Vec3 => {
    let best = Infinity;
    let end: Vec3 = a;
    for (let axis = 0; axis < 3; axis++) {
      for (const [edge, way] of [[lo[axis], -1], [hi[axis], 1]] as const) {
        const distance = way * (edge - a[axis]);
        if (distance < best) {
          best = distance;
          end = [...a] as Vec3;
          end[axis] = edge + way * margin;
        }
      }
    }

    return end;
  });
  const count = from.length;
  // (A solid known to be sound - a step's input, checked when it was made - needs only the short way.)
  const ends = sound ? to : [...to, ...back];
  const segs = (sound ? from : [...from, ...from]).map((a, i) => ({ a, b: ends[i], d: sub(ends[i], a), l: Math.hypot(...sub(ends[i], a)) }));
  const usable = segs.map(segment => segment.l > 10 * tol);
  const lines = segs.filter((_, i) => usable[i]).map(segment => makeLine(segment.a, segment.b));
  if (lines.length) {
    const sec = new oc.BRepAlgoAPI_Section();
    const progress = new oc.Message_ProgressRange();
    const args = new oc.NCollection_List_TopoDS_Shape();
    const tools = new oc.NCollection_List_TopoDS_Shape();
    const comp = makeCompound(lines) as unknown as Shape3D;
    try {
      args.Append(comp.wrapped);
      tools.Append(shape.wrapped);
      sec.SetArguments(args);
      sec.SetTools(tools);
      sec.SetNonDestructive(true);
      sec.Build(progress);
      if (sec.IsDone()) {
        const made = cast(sec.Shape());
        // Where each segment crosses: its parameter along it (0 at the point, 1 outside).
        const hits: number[][] = segs.map(() => []);
        const bad = segs.map(() => false);
        const onto = (point: Vec3): number[] => {
          const at: number[] = [];
          segs.forEach((segment, i) => {
            if (!usable[i]) {
              return;
            }
            const fraction = dot(sub(point, segment.a), segment.d) / (segment.l * segment.l);
            if (fraction < -1e-9 || fraction > 1 + 1e-9) {
              return;
            }
            const off = sub(point, add(segment.a, scale(segment.d, fraction)));
            if (Math.hypot(...off) < tol * 10) {
              at.push(i, fraction);
            }
          });

          return at;
        };
        // (A segment lying along a face comes back as an edge: that one can't be told by counting.)
        for (const e of 'edges' in made ? made.edges : []) {
          const at = onto(e.pointAt(0.5).toTuple() as Vec3);
          for (let index = 0; index < at.length; index += 2) {
            bad[at[index]] = true;
          }
        }
        const ex = new oc.TopExp_Explorer(made.wrapped, oc.TopAbs_ShapeEnum.TopAbs_VERTEX, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
        const pts: Vec3[] = [];
        for (; ex.More(); ex.Next()) {
          const item = ex.Current();
          const q = oc.BRep_Tool.Pnt(oc.TopoDS.Vertex(item));
          pts.push([q.X(), q.Y(), q.Z()]);
          q.delete();
          item.delete();
        }
        ex.delete();
        for (const point of pts) {
          const at = onto(point);
          for (let index = 0; index < at.length; index += 2) {
            const [i, fraction] = [at[index], at[index + 1]];
            // On an end: the point itself on the boundary, or the outside point not outside.
            if (fraction * segs[i].l < tol * 10 || (1 - fraction) * segs[i].l < tol * 10) {
              bad[i] = true;
            } else if (!hits[i].some(found => Math.abs(found - fraction) * segs[i].l < tol * 10)) {
              // (The same crossing twice: two faces meeting there.)
              hits[i].push(fraction);
            }
          }
        }
        for (let i = 0; i < count; i++) {
          const j = sound ? i : i + count;
          if (usable[i] && usable[j] && !bad[i] && !bad[j] && hits[i].length % 2 === hits[j].length % 2) {
            out[i] = hits[i].length % 2 === 1;
          }
        }
      }
    } catch {
      // (Asked the slow way below.)
    } finally {
      sec.delete();
      progress.delete();
      args.delete();
      tools.delete();
    }
  }
  const left = from.map((_, i) => i).filter(i => out[i] === undefined);
  if (left.length) {
    const slow = insideOf(shape, left.map(i => from[i]));
    left.forEach((i, index) => (out[i] = slow[index]));
  }

  return out as boolean[];
}

/** Up to `spotCount` points spread over a face (the middles of triangles of its mesh, taken evenly through them), each with the face's outward normal there. */
function spotsOn(body: Shape3D, face: Face, spotCount: number): { p: Vec3; n: Vec3 }[] {
  const one = () => [pointOnFace(body, face)];
  if (spotCount <= 1) {
    return one();
  }
  const tri = faceTriangles(face, sizeOf(body));
  if (!tri) {
    return one();
  }
  const count = tri.trianglesIndexes.length / 3;
  const vertexAt = (i: number): Vec3 => [tri!.vertices[3 * i], tri!.vertices[3 * i + 1], tri!.vertices[3 * i + 2]];
  const out: { p: Vec3; n: Vec3 }[] = [];
  for (let index = 0; index < Math.min(spotCount, count); index++) {
    const at = Math.floor(((index + 0.5) * count) / Math.min(spotCount, count)) * 3;
    const [a, b, vertexC] = [0, 1, 2].map(j => vertexAt(tri!.trianglesIndexes[at + j]));
    const centroid = scale(add(add(a, b), vertexC), 1 / 3);
    try {
      out.push({ p: centroid, n: norm(face.normalAt(centroid).toTuple() as Vec3) });
    } catch {
      // (A spot the surface gives no normal at: the others will do.)
    }
  }

  return out.length ? out : one();
}

/**
 * Is a shell hollow where it should be? Spots three walls deep behind its
 * faces that are well clear of every face of the body (more than two walls:
 * past the sharpest inside corner a shell can have) must be empty - a shell
 * that hollowed one corner of a part and left the rest solid passed for one.
 */
function hollowInside(body: Shape3D, shell: Shape3D, kept: Face[], t: number): boolean {
  if (!kept.length || !(t > 0)) {
    return true;
  }
  try {
    const skin = subShapes(body, 'SHELL');
    if (!skin.length) {
      return true;
    }
    const every = Math.ceil(kept.length / 40);
    const at: Vec3[] = [];
    const past: Vec3[] = [];
    // (One measurer for each skin, asked about every spot: one made for each
    // spot kept what it worked out about the whole skin, for good - release.ts.)
    const oc = getOC();
    const far = skin.map((sk) => {
      const measure = new oc.BRepExtrema_DistShapeShape();
      measure.LoadS1(sk);

      return measure;
    });
    try {
      for (const [i, face] of kept.entries()) {
        if (i % every) {
          continue;
        }
        const { p, n } = pointOnFace(body, face);
        const q = sub(p, scale(n, 3 * t));
        const point = makeVertex(q);
        let near = Infinity;
        for (const measure of far) {
          measure.LoadS2(point.wrapped);
          measure.Perform();
          near = Math.min(near, measure.Value());
        }
        if (near < 2.1 * t) {
          continue;
        }
        at.push(q);
        past.push(add(p, scale(n, t / 50)));
      }
    } finally {
      for (const measure of far) {
        measure.delete();
      }
    }
    if (!at.length) {
      return true;
    }
    const inBody = insideAlong(body, at, past, true);
    const keep = at.map((_, index) => index).filter(index => inBody[index]);

    return !insideAlong(shell, keep.map(index => at[index]), keep.map(index => past[index])).some(Boolean);
  } catch {
    // Can't tell: the usual checks speak for it.
    return true;
  }
}

/**
 * A shape offset by `by` (outward, or inward when negative) as a solid: with
 * sharp corners where its offset faces meet, else round ones. Null: no go.
 */
function offsetSolid(off: any, shape: Shape3D, by: number): Shape3D | null {
  const oc = getOC();
  for (const join of [oc.GeomAbs_JoinType.GeomAbs_Intersection, oc.GeomAbs_JoinType.GeomAbs_Arc]) {
    const progress = new oc.Message_ProgressRange();
    try {
      off.PerformByJoin(shape.wrapped, by, 1e-6, oc.BRepOffset_Mode.BRepOffset_Skin, true, false, join, false, progress);
      if (!off.IsDone()) {
        continue;
      }
      let got = cast(off.Shape());
      // It can come back as a closed shell: make that a solid. (Asked of the
      // shape itself - class names are renamed in the app's build, so a
      // constructor.name test never matched there and the cut came out null.)
      if (got.wrapped.ShapeType() === oc.TopAbs_ShapeEnum.TopAbs_SHELL) {
        got = makeSolid([got as never]);
      }
      if (Math.abs(quickVolume(got as Shape3D)) > 0) {
        return tightenEdges(got as Shape3D);
      }
    } catch (err) {
      if (isFault(err)) {
        throw err;
      }
    } finally {
      progress.delete();
    }
  }

  return null;
}

/**
 * A body grown by `by` all round (what a clearance cut takes away), or brought
 * in when `by` is negative, as pieces that together are it - grown a piece at
 * a time: the kernel's offset of a body in two pieces (a peg cut into two
 * stubs) fails. Null: no go.
 */
function grownBy(shape: Shape3D, by: number): Shape3D[] | null {
  const oc = getOC();
  const off = new oc.BRepOffsetAPI_MakeOffsetShape();
  try {
    const parts = subShapes(shape, 'SOLID');
    const out: Shape3D[] = [];
    for (const x of parts.length > 1 ? parts.map(part => cast(part) as Shape3D) : [shape]) {
      const grown = offsetSolid(off, unify(x), by);
      const volume = grown ? Math.abs(measureVolume(grown)) : 0, v0 = Math.abs(measureVolume(x));
      if (!grown || !(by > 0 ? volume > v0 : volume < v0 && volume > 0)) {
        return null;
      }
      out.push(grown);
    }

    return out;
  } finally {
    off.delete();
  }
}

/** The threads cut in this project, by their step: on which body, the round face's axis, size and reach, the pitch. */
const threadsCut = new Map<string, { body: string; c: Vec3; a: Vec3; r: number; inside: boolean; pitch: number; left: boolean; t0: number; t1: number; phase?: number; starts?: number }>();

/**
 * A threaded body grown by `by` (the clearance a Subtract keeps round it). The kernel's own offset of a thread's
 * helical faces fails every time (asked: "when I want to subtract a thread and I put clearance, it always fails").
 * So: its grooves filled back in (a cylinder over the thread's reach - what it was before the thread), that
 * grown, and the same thread cut on its round face - a thread that much bigger all round (in a hole: that much
 * smaller), which is what a nut cut with it needs to turn on the bolt with that gap.
 * Null when the body has no thread of its own any more, or it doesn't work out (the plain way is tried then).
 */
function grownThreaded(shape: Shape3D, by: number, bodyId: string): Shape3D[] | null {
  const cut = [...threadsCut].filter(([step, t]) => t.body === bodyId && rebuild.stepsNow.has(step)).map(([, t]) => t);
  if (!cut.length) {
    return null;
  }
  try {
    // Its grooves filled in.
    let plain = shape;
    const v0 = Math.abs(measureVolume(shape));
    for (const t of cut) {
      // The whole band the thread is in - from under its roots to its round face - taken out and put back as one
      // clean ring. (A cylinder simply added over the grooves left their edges in the body: grown, that body broke
      // the engine.)
      const depth = threadDepth(t.pitch, t.inside) * 1.05 + 0.25 * t.pitch;
      const from = add(t.c, scale(t.a, t.t0));
      const height = t.t1 - t.t0;
      const [inner, outer] = t.inside ? [t.r, t.r + depth] : [Math.max(t.r - depth, t.r * 0.05), t.r];
      const ring = (makeCylinder(outer, height, from, t.a) as Shape3D).cut(makeCylinder(inner, height, from, t.a) as Shape3D) as Shape3D;
      plain = unify((plain.cut(ring.clone()) as Shape3D).fuse(ring) as Shape3D);
    }
    // (Nothing filled: there is no thread on it now - something else was done to it since.)
    if (!(Math.abs(measureVolume(plain)) > v0 * (1 + 1e-9))) {
      return null;
    }
    const grown = grownBy(plain, by);
    if (!grown || grown.length !== 1) {
      return null;
    }
    let out = grown[0];
    for (const t of cut) {
      const want = t.r + (t.inside ? -by : by);
      if (!(want > 0)) {
        return null;
      }
      const face = out.faces.find((face) => {
        if (face.geomType !== 'CYLINDRE') {
          return false;
        }
        const cy = cylinderOf(face);
        if (!cy || cy.s < 0 !== t.inside || Math.abs(cy.r - want) > 1e-4 * Math.max(1, want)) {
          return false;
        }
        if (Math.abs(dot(norm(cy.a), t.a)) < 0.9999) {
          return false;
        }
        // (The same axis: its centre is on the thread's axis line.)
        const offset = sub(cy.c, t.c);

        return len(sub(offset, scale(t.a, dot(offset, t.a)))) < 1e-4 * Math.max(1, want);
      });
      if (!face) {
        return null;
      }
      // Along the first thread's own stretch - but not into what has grown towards it: an end that stops at a
      // shoulder (under a bolt's head) stops the clearance short of where it did, the shoulder having come that
      // much nearer. (Run on to the old end, the groove cut into the grown head, and the hole had a ridge there.)
      const along: number[] = [];
      for (const e of face.edges) {
        for (const fraction of [0, 0.25, 0.5, 0.75, 1]) {
          along.push(dot(sub(e.pointAt(fraction).toTuple() as Vec3, t.c), t.a));
        }
      }
      const g0 = Math.min(...along);
      const g1 = Math.max(...along);
      out = threadFace(out, face, t.pitch, t.left, { t0: Math.max(t.t0, g0), t1: Math.min(t.t1, g1), anchor: t.t0, phase: t.phase, shallow: by, c: t.c, a: t.a }, undefined, t.starts ?? 1);
    }

    return Math.abs(quickVolume(out)) > 0 ? [out] : null;
  } catch (err) {
    if (isFault(err)) {
      throw err;
    }

    return null;
  }
}

/** A body brought in by `by` all round (one shape), or null when that doesn't work. */
function broughtIn(shape: Shape3D, by: number): Shape3D | null {
  const grown = grownBy(shape, -by);

  return grown ? (grown.length > 1 ? fuseAll(grown) : grown[0]) : null;
}

/**
 * An offset solid with its loose edges made again. Where two offset faces
 * meet smoothly (a shelled mouse's top and the round along its rim), the
 * kernel's edge between them strays (0.2 mm off, 0.14 mm allowed) while its
 * curves on the two faces are exact: any cut across that edge left the faces
 * "not meeting up", at every tolerance. Each such edge is made again from its
 * curve on each face (one edge per face), the faces with them, all sewn back
 * together. Kept only if that comes out one sound solid of the same volume;
 * else the solid as it was.
 */
function tightenEdges(shape: Shape3D): Shape3D {
  const oc = getOC();
  const size = sizeOf(shape);
  const loose = size * 1e-5;
  if (!shape.edges.some(e => oc.BRep_Tool.Tolerance(e.wrapped) > loose)) {
    return shape;
  }
  const gc: { delete(): void }[] = [];
  const keep = <T extends { delete(): void }>(x: T): T => (gc.push(x), x);
  try {
    const copy = deepCopy(shape);
    const faces = copy.faces;
    // Per face: its loose edges and what takes their place there.
    const swaps = new Map<number, [any, any][]>();
    for (const e of copy.edges) {
      if (oc.BRep_Tool.Tolerance(e.wrapped) <= loose) {
        continue;
      }
      const owners = faces.map((face, i) => [face, i] as const).filter(([face]) => face.edges.some(edge => edge.wrapped.IsSame(e.wrapped)));
      // (A seam - one face on both sides - or an edge of three faces: left as it is.)
      if (owners.length !== 2) {
        continue;
      }
      const made = owners.map(([face]) => {
        const c2 = keep(new oc.BRepAdaptor_Curve2d(e.wrapped, face.wrapped));
        const mk = keep(new oc.BRepBuilderAPI_MakeEdge(c2.Curve(), oc.BRep_Tool.Surface(face.wrapped), c2.FirstParameter(), c2.LastParameter()));
        const edge = mk.Edge();
        oc.BRepLib.BuildCurve3d(edge, 1e-7, oc.GeomAbs_Shape.GeomAbs_C1, 14, 200);

        return edge;
      });
      // The two must be the same curve (exact curves on both faces), within what an edge may be off.
      const [a, b] = made.map(edge => keep(new oc.BRepAdaptor_Curve(edge)));
      let apart = 0;
      for (let step = 0; step <= 32; step++) {
        const curvePoint = a.Value(a.FirstParameter() + ((a.LastParameter() - a.FirstParameter()) * step) / 32);
        const q = b.Value(b.FirstParameter() + ((b.LastParameter() - b.FirstParameter()) * step) / 32);
        apart = Math.max(apart, curvePoint.Distance(q));
        curvePoint.delete();
        q.delete();
      }
      if (apart > loose) {
        continue;
      }
      owners.forEach(([, i], ownerIndex) => swaps.set(i, [...(swaps.get(i) ?? []), [e.wrapped, made[ownerIndex]]]));
    }
    if (!swaps.size) {
      return shape;
    }
    // A face's wire with its loose edges swapped, in its own order and directions (a seam twice).
    const rewire = (wire: any, swap: [any, any][]) => {
      const tb = keep(new oc.TopoDS_Builder());
      const nw = new oc.TopoDS_Wire();
      tb.MakeWire(nw);
      const ex = keep(new oc.TopExp_Explorer(wire, oc.TopAbs_ShapeEnum.TopAbs_EDGE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE));
      for (; ex.More(); ex.Next()) {
        const ed = ex.Current();
        const to = swap.find(([original]) => ed.IsSame(original));
        tb.Add(nw, to ? to[1].Oriented(ed.Orientation()) : ed);
      }

      return nw;
    };
    const sew = keep(new oc.BRepBuilderAPI_Sewing(size * 1e-6, true, true, true, false));
    faces.forEach((face, i) => {
      const swap = swaps.get(i);
      if (!swap) {
        return void sew.Add(face.wrapped);
      }
      const fwd = oc.TopoDS.Face(face.wrapped.Oriented(oc.TopAbs_Orientation.TopAbs_FORWARD));
      const outer = oc.BRepTools.OuterWire(fwd);
      const mk = keep(new oc.BRepBuilderAPI_MakeFace(oc.BRep_Tool.Surface(fwd), rewire(outer, swap), true));
      const ex = keep(new oc.TopExp_Explorer(fwd, oc.TopAbs_ShapeEnum.TopAbs_WIRE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE));
      for (; ex.More(); ex.Next()) {
        if (!ex.Current().IsSame(outer)) {
          mk.Add(rewire(oc.TopoDS.Wire(ex.Current()), swap));
        }
      }
      if (!mk.IsDone()) {
        throw new Error('face');
      }
      const nf = mk.Face();
      sew.Add(face.wrapped.Orientation() === oc.TopAbs_Orientation.TopAbs_REVERSED ? nf.Reversed() : nf);
    });
    sew.Perform(keep(new oc.Message_ProgressRange()));
    const shells = subShapes(cast(sew.SewedShape()) as Shape3D, 'SHELL');
    if (shells.length !== 1) {
      return shape;
    }
    const ms = keep(new oc.BRepBuilderAPI_MakeSolid());
    ms.Add(oc.TopoDS.Shell(shells[0]));
    const solid = ms.Solid();
    oc.BRepLib.OrientClosedSolid(solid);
    const fix = keep(new oc.ShapeFix_Solid());
    fix.Init(solid);
    fix.Perform(keep(new oc.Message_ProgressRange()));
    const out = cast(fix.Solid()) as Shape3D;
    const v0 = Math.abs(measureVolume(shape));
    const ok = shapeValid(out) && subShapes(out, 'SOLID').length === 1 && openEdges(out).length === 0 && Math.abs(Math.abs(measureVolume(out)) - v0) <= v0 * 1e-4;

    return ok ? out : shape;
  } catch (err) {
    if (isFault(err)) {
      throw err;
    }

    return shape;
  } finally {
    for (const x of gc.reverse()) {
      x.delete();
    }
  }
}

/**
 * A body brought in by t all round, worked out from what is cut out of it:
 * the box round the body brought in by t, less every lump of what the box
 * holds besides the body (a pocket's room, a hole's) grown by t. The same
 * shape as the body offset inward - which OpenCascade gives up on when the
 * offsets of two cut-outs run into each other (a pocket and a hole less than
 * two walls apart). Grown one by one and joined, they just overlap.
 */
function innerByCutouts(off: any, body: Shape3D, t: number): Shape3D | null {
  const [lo, hi] = body.boundingBox.bounds as [Vec3, Vec3];
  if ([0, 1, 2].some(axis => hi[axis] - lo[axis] <= 2 * t)) {
    return null;
  }
  const room = makeBox([lo[0] + t, lo[1] + t, lo[2] + t], [hi[0] - t, hi[1] - t, hi[2] - t]) as Shape3D;
  const beside = fuzzyBoolean('cut', makeBox(lo, hi) as Shape3D, body);
  if (isEmpty(beside)) {
    return room;
  }
  const lumps = subShapes(beside, 'SOLID').map(solid => cast(solid) as Shape3D);
  if (!lumps.length || lumps.length > 60) {
    return null;
  }
  const grown: Shape3D[] = [];
  for (const lump of lumps) {
    const offsetLump = offsetSolid(off, lump, t);
    if (!offsetLump) {
      return null;
    }
    grown.push(offsetLump);
  }
  const inner = fuzzyBoolean('cut', room, fuseAll(grown));
  if (isEmpty(inner) || !(Math.abs(quickVolume(inner)) > 0)) {
    return null;
  }
  // Held to what it is for: nowhere nearer the body's skin than t (a lump that
  // didn't grow all the way round - one ending in a knife edge - would leave the wall thin there).
  const clear = Math.min(...subShapes(body, 'SHELL').map(skin => measureDistanceBetween(inner, cast(skin) as AnyShape)));

  return clear >= t * (1 - 1e-3) ? inner : null;
}

/**
 * Shell without BRepOffsetAPI_MakeThickSolid: body − (body offset inward by t)
 * leaves a closed skin; each removed flat face then gets a hole cut through
 * it (its outline shrunk by t, pushed through the skin). `cutouts`: the body
 * offset inward is put together from what is cut out of it (innerByCutouts).
 */
function shellByOffset(body: Shape3D, faces: Face[], t: number, cutouts = false): Shape3D | null {
  const oc = getOC();
  const off = new oc.BRepOffsetAPI_MakeOffsetShape();
  try {
    const src = unify(body);
    const inner = cutouts ? innerByCutouts(off, src, t) : offsetSolid(off, src, -t);
    if (!inner) {
      return null;
    }
    const tol = sizeOf(body) * 1e-6;
    // The openings: the hollow's own floor behind each opened face, carried on
    // out through the wall (the hollow and its way out, cut away as one). So
    // what stands in the hollow there keeps its walls right down to the
    // opening - a bore through the floor, its tube: cut by the face's outline
    // brought in, as it was, the tube ended a wall and a half short of it.
    let hollow: Shape3D = inner;
    const byOutline: { face: Face; n: Vec3 }[] = [];
    for (const face of faces) {
      if (face.geomType !== 'PLANE') {
        return null;
      }
      const normal = norm(face.normalAt().toTuple() as Vec3);
      const at = face.pointOnSurface(0.5, 0.5).toTuple() as Vec3;
      const floors = inner.faces.filter((otherFace) => {
        if (otherFace.geomType !== 'PLANE' || dot(norm(otherFace.normalAt().toTuple() as Vec3), normal) < 1 - 1e-6) {
          return false;
        }
        const { p } = pointOnFace(inner!, otherFace);
        if (Math.abs(dot(sub(p, at), normal) + t) > tol * 10) {
          return false;
        }

        // (Another face of the body on the same plane, not opened: its floor stays.)
        return measureDistanceBetween(makeVertex(add(p, scale(normal, t))), face) < tol * 10;
      });
      if (!floors.length) {
        byOutline.push({ face, n: normal });
      }
      for (const floor of floors) {
        hollow = hollow.fuse(basicFaceExtrusion(floor.clone(), new Vector(scale(normal, t * 1.5))) as Shape3D);
      }
    }
    let skin = body.cut(hollow);
    for (const { face, n } of byOutline) {
      // (No such floor found: the face's outline brought in by the wall thickness, pushed through.)
      const wire = face.clone().outerWire().offset2D(-t, 'intersection');
      const start = new Vector(scale(n, t * 0.5));
      const hole = basicFaceExtrusion(makeFace(wire).translate(start), new Vector(scale(n, -t * 2)));
      skin = skin.cut(hole);
    }

    return skin;
  } catch {
    return null;
  } finally {
    off.delete();
  }
}

/** Remove a vertex that only splits an edge or face (merges what it separates). */
function deleteVertex(body: Shape3D, at: Vec3): Shape3D {
  const merged = unify(body);
  const tol = 1e-6 * (Math.hypot(body.boundingBox.width, body.boundingBox.height, body.boundingBox.depth) || 1);
  const still = merged.edges.some(e => dist(e.startPoint.toTuple() as Vec3, at) < tol || dist(e.endPoint.toTuple() as Vec3, at) < tol);
  if (still) {
    throw new Error("This corner can't be removed - it's where faces meet");
  }

  return merged;
}

// ------------------------------------------------------------ feature helpers

/** Plane of a loft section. */
function sectionFrame(src: ExtrudeSource, ctx: Ctx): { origin: Vec3; normal: Vec3 } {
  if (src.kind === 'profile') {
    const sketch = ctx.sketches.get(src.sketch);
    if (!sketch) {
      throw noSketch(src.sketch);
    }

    return { origin: sketch.plane.origin, normal: norm(sketch.plane.normal) };
  }
  const face = resolveFace(need(ctx.bodies, src.face.body), src.face);

  return { origin: face.center.toTuple() as Vec3, normal: norm(face.normalAt().toTuple() as Vec3) };
}

/** The smallest radius any curve of the wire bends with (its corners between curves don't count; a straight wire: Infinity). */
function tightestBend(wire: Wire): number {
  let least = Infinity;
  for (const e of wire.edges) {
    if (e.geomType === 'LINE') {
      continue;
    }
    const samples = 240;
    const points: Vec3[] = [];
    for (let i = 0; i <= samples; i++) {
      points.push(e.pointAt(i / samples).toTuple() as Vec3);
    }
    for (let i = 1; i < samples; i++) {
      const ab = dist(points[i - 1], points[i]);
      const bc = dist(points[i], points[i + 1]);
      const ac = dist(points[i - 1], points[i + 1]);
      const semiPerimeter = (ab + bc + ac) / 2;
      const area = Math.sqrt(Math.max(0, semiPerimeter * (semiPerimeter - ab) * (semiPerimeter - bc) * (semiPerimeter - ac)));
      if (area > 1e-14 * ab * bc) {
        least = Math.min(least, (ab * bc * ac) / (4 * area));
      }
    }
  }

  return least;
}

/** A wire's points in order along it, close together (curves sampled finely). */
function wirePoints(wire: Wire): Vec3[] {
  const pts: Vec3[] = [];
  for (const e of wire.edges) {
    const samples = e.geomType === 'LINE' ? 1 : 200;
    let seg: Vec3[] = [];
    for (let i = 0; i <= samples; i++) {
      seg.push(e.pointAt(i / samples).toTuple() as Vec3);
    }
    // Edges run end to end, each its own way round.
    if (pts.length && dist(seg[seg.length - 1], pts[pts.length - 1]) < dist(seg[0], pts[pts.length - 1])) {
      seg = seg.reverse();
    }
    if (pts.length === 0 && wire.edges.length > 1) {
      const next = wire.edges[1];
      const ends = [next.pointAt(0).toTuple() as Vec3, next.pointAt(1).toTuple() as Vec3];
      const near = (point: Vec3) => Math.min(...ends.map(q => dist(point, q)));
      if (near(seg[0]) < near(seg[seg.length - 1])) {
        seg = seg.reverse();
      }
    }
    pts.push(...(pts.length ? seg.slice(1) : seg));
  }

  return pts;
}

/**
 * Face F of `body` is the end of a sweep (square to its path's end, the path
 * ending on it): cut `by` off along the path, so the tube is that much
 * shorter and its new end is square to the path where it now ends. A disc
 * wider than the end is swept along that last piece of the path (starting a
 * little past the end) and cut away. Null when F isn't a sweep's end.
 */
function trimSweepEnd(body: Shape3D, face: Face, by: number, ctx: Ctx): Shape3D | null {
  if (face.geomType !== 'PLANE' || !ctx.sweeps.size) {
    return null;
  }
  const { origin, normal } = planeOf(face);
  const bb = face.boundingBox;
  const size = Math.hypot(bb.width, bb.height, bb.depth);
  const center = face.center.toTuple() as Vec3;
  for (const spine of ctx.sweeps.values()) {
    const all = wirePoints(spine);
    // Every place the path passes through `face`'s plane heading out through `face`
    // (the end itself, or where an earlier push left it): the one at `face`. On an
    // S-bend the plane cuts the path elsewhere too.
    const side = (point: Vec3) => dot(sub(point, origin), normal);
    const tolPlane = size * 0.05 + 1e-6;
    let best: { pts: Vec3[]; out: Vec3; d: number } | null = null;
    for (const way of [all, [...all].reverse()]) {
      for (let index = 0; index < way.length - 1; index++) {
        const a0 = side(way[index]);
        const a1 = side(way[index + 1]);
        if (!(a0 >= -tolPlane && a1 < a0 && a1 <= tolPlane)) {
          continue;
        }
        const out = norm(sub(way[index], way[index + 1]));
        if (Math.abs(dot(out, normal)) < 0.98) {
          continue;
        }
        // (The sweep turns its profile square to the path: a profile drawn a
        // little off square ends on a plane a hair off the path's end.)
        const t0 = a0 <= tolPlane && index === 0 ? 0 : Math.min(1, Math.max(0, a0 / (a0 - a1)));
        const q = add(way[index], scale(sub(way[index + 1], way[index]), t0));
        const distance = dist(q, center);
        if (distance <= size && (!best || distance < best.d)) {
          best = { pts: [q, ...way.slice(index + 1)], out, d: distance };
        }
      }
    }
    if (best) {
      const { pts, out } = best;
      const p0 = pts[0];
      // The piece of path to take off: from the end, `by` along it.
      const piece: Vec3[] = [p0];
      let run = 0;
      let i = 1;
      for (; i < pts.length; i++) {
        const step = dist(pts[i - 1], pts[i]);
        if (run + step >= by) {
          const t = (by - run) / step;
          piece.push(add(pts[i - 1], scale(sub(pts[i], pts[i - 1]), t)));
          run = by;
          break;
        }
        run += step;
        piece.push(pts[i]);
      }
      if (run < by - 1e-9 || i >= pts.length - 1) {
        throw new Error("That's as long as the sweep's whole path or more - it would remove it");
      }
      // Straight line pieces stay a line; a curve is fitted through its points.
      const straight = piece.every(point => len(sub(sub(point, p0), scale(norm(sub(piece[piece.length - 1], p0)), dot(sub(point, p0), norm(sub(piece[piece.length - 1], p0)))))) < size * 1e-6);
      const lead = size * 0.05 + 1e-3;
      const start = add(p0, scale(out, lead));
      const curve = straight || piece.length < 4 ? makeLine(p0, piece[piece.length - 1]) : makeBSplineApproximation(piece, { tolerance: size * 1e-4 + 1e-6, degMax: 5, degMin: 2 });
      const path = assembleWire([makeLine(start, p0), curve]);
      let reach0 = 0;
      for (const e of face.edges) {
        for (let j = 0; j <= 16; j++) {
          reach0 = Math.max(reach0, dist(e.pointAt(j / 16).toTuple() as Vec3, p0));
        }
      }
      const reach = reach0 * 1.1 + size * 0.02;
      const disc = assembleWire([makeCircle(reach, start, scale(out, -1))]);
      const cutter = genericSweep(disc, path, { frenet: false, transitionMode: 'round' }) as Shape3D;
      const result = fuzzyBoolean('cut', body, cutter);
      if (isEmpty(result)) {
        throw new Error('That would remove the whole sweep');
      }

      return result;
    }
  }

  return null;
}

/** Auto, drawn inside a body and reaching out of it: cut, not added. */
export const AUTO_CUT_INSIDE = "Auto cut this out of the body it starts inside - what reaches past that body isn't added. To add it (a branch, a boss), pick Add.";

/**
 * The Subtract tool's cut: every tool at once - joined, then one tolerant cut
 * checked by its volume. Cut one by one, eight vents round a lamp shade left
 * it with no solid after the sixth, and the message blamed an "open surface".
 */
function cutAway(target: Shape3D, tools: Shape3D[]): Shape3D {
  const solidsIn = (x: Shape3D) => [...iterTopo(x.wrapped, 'solid')].length;
  const all = fuseAll(tools);
  let out = fuzzyBoolean('cut', target, all);
  if (!solidsIn(out) || !booleanVolumeOk('cut', target, all, out)) {
    const plain = target.cut(all);
    if (solidsIn(plain) && booleanVolumeOk('cut', target, all, plain)) {
      out = plain;
    } else if (isEmpty(out) && isEmpty(plain)) {
      throw new Error('The result is empty');
    } else {
      throw new Error("Subtracting these didn't work out - the geometry engine lost the shape. Try the tools one or two at a time");
    }
  } else if (!shapeValid(out) && shapeValid(target)) {
    // The tolerant cut can leave faces that don't meet up where the plain one
    // is clean (a direction switch's slot through the housing's shelled top).
    try {
      const plain = target.cut(all);
      if (solidsIn(plain) && shapeValid(plain) && booleanVolumeOk('cut', target, all, plain)) {
        out = plain;
      }
    } catch {
      // No plain cut either (it can come back empty): the tolerant one goes on to be checked.
    }
  }

  return out;
}



/**
 * Flat pieces of one plane that meet, joined into one face each (pieces apart
 * stay apart): each lifted into a thin slab, the slabs joined, and the joined
 * slab's top brought back down (OpenCascade doesn't merge loose faces).
 */
function mergedFaces(faces: Face[], normal: Vec3): Face[] {
  if (faces.length < 2) {
    return faces;
  }
  try {
    const unitNormal = norm(normal);
    const step = Math.max(1e-3, Math.max(...faces.map(face => sizeOf(face as unknown as Shape3D))) * 0.01);
    const slab = unify(fuseAll(faces.map(face => basicFaceExtrusion(face, new Vector(scale(unitNormal, step))))));
    const top = slab.faces.filter(face => face.geomType === 'PLANE' && dot(norm(face.normalAt().toTuple() as Vec3), unitNormal) > 0.9999);
    const level = Math.max(...top.map(face => dot(face.center.toTuple() as Vec3, unitNormal)));
    const out = top.filter(face => Math.abs(dot(face.center.toTuple() as Vec3, unitNormal) - level) < step * 0.01).map(face => face.translate(scale(unitNormal, -step)) as Face);

    return out.length ? out : faces;
  } catch {
    return faces;
  }
}

/** Is the face flat (every point on one plane, every normal the same)? */
function isFlat(face: Face, tol: number): boolean {
  try {
    const mid = surfaceAt(face, 0.5, 0.5);
    const n0 = norm(mid.n);
    const tuple = mid.p;
    for (let i = 0; i <= 4; i++) {
      for (let j = 0; j <= 4; j++) {
        const { p, n } = surfaceAt(face, i / 4, j / 4);
        if (Math.abs(dot(sub(p, tuple), n0)) > tol) {
          return false;
        }
        if (len(cross(norm(n), n0)) > 1e-7) {
          return false;
        }
      }
    }

    return true;
  } catch {
    return false;
  }
}

/** The cylinder a face lies on (its axis and radius), if it's one: every normal square to one direction, meeting one line. */
function cylinderFit(face: Face, tol: number): { c: Vec3; a: Vec3; r: number } | null {
  const points: Vec3[] = [];
  const normals: Vec3[] = [];
  for (let i = 0; i <= 4; i++) {
    for (let j = 0; j <= 4; j++) {
      const { p, n } = surfaceAt(face, i / 4, j / 4);
      points.push(p);
      normals.push(norm(n));
    }
  }
  // The axis: square to the two normals furthest apart.
  let best = 0;
  let a: Vec3 = [0, 0, 0];
  for (let index = 1; index < normals.length; index++) {
    const normalCross = cross(normals[0], normals[index]);
    if (len(normalCross) > best) {
      [best, a] = [len(normalCross), normalCross];
    }
  }
  if (best < 1e-3) {
    return null;
  }
  a = norm(a);
  if (normals.some(normal => Math.abs(dot(normal, a)) > 1e-7)) {
    return null;
  }
  // Where the normals at 0 and the furthest one meet (seen along the axis): the centre.
  const farIndex = normals.findIndex(normal => len(cross(normals[0], normal)) === best);
  const flat = (point: Vec3) => sub(point, scale(a, dot(point, a)));
  const [p0, pk, n0, nk] = [flat(points[0]), flat(points[farIndex]), flat(normals[0]), flat(normals[farIndex])];
  // p0 + t n0 = pk + s nk: solved in the plane square to the axis.
  const offset = sub(pk, p0);
  const den = dot(cross(n0, nk), a);
  if (Math.abs(den) < 1e-9) {
    return null;
  }
  const t = dot(cross(offset, nk), a) / den;
  const center = add(p0, scale(n0, t));
  const radius = Math.abs(t);
  if (points.some(point => Math.abs(len(sub(flat(point), center)) - radius) > tol * 10)) {
    return null;
  }

  return { c: center, a, r: radius };
}

/** The face rebuilt on a true cylinder, within its own edges (null if that doesn't work out). */
function asCylinder(face: Face, cyl: { c: Vec3; a: Vec3; r: number }, size: number): Face | null {
  const oc = getOC();
  const length = size * 4 + cyl.r;
  const solid = makeCylinder(cyl.r, 2 * length, sub(cyl.c, scale(cyl.a, length)), cyl.a);
  const side = solid.faces.find(face => face.geomType === 'CYLINDRE');
  if (!side) {
    return null;
  }
  const surface = oc.BRep_Tool.Surface(side.wrapped);
  const wires = [face.clone().outerWire(), ...face.clone().innerWires()];
  const maker = new oc.BRepBuilderAPI_MakeFace(surface, wires[0].wrapped, true);
  try {
    for (const wire of wires.slice(1)) {
      maker.Add(wire.wrapped);
    }
    if (!maker.IsDone()) {
      return null;
    }
    const fix = new oc.ShapeFix_Face(maker.Face());
    try {
      fix.Perform();
      fix.FixOrientation();
      const out = cast(fix.Face()) as Face;

      return out.geomType === 'CYLINDRE' && Math.abs(measureArea(out) - measureArea(face)) < Math.max(1e-9, measureArea(face) * 1e-5) ? out : null;
    } finally {
      fix.delete();
    }
  } finally {
    maker.delete();
  }
}

/**
 * Faces that are flat but not stored as planes - a straight side swept round
 * an arc is a "surface of revolution" - made planes: they merge with the flat
 * faces either side, and Move / Scale / Replace Face can tilt and trim them
 * (a lever's tip couldn't be narrowed, its bottom couldn't be brought down:
 * "the neighbouring faces don't enclose it"). The shape stays as it was if
 * anything doesn't come out exactly the same.
 */
function flatFaces(shape: Shape3D): Shape3D {
  const size = sizeOf(shape);
  const tol = size * 1e-7 + 1e-9;
  let changed = false;
  const faces = shape.faces.map((face) => {
    if (face.geomType === 'PLANE' || face.geomType === 'CYLINDRE') {
      return face;
    }
    try {
      if (isFlat(face, tol)) {
        // (outerWire uses up the face it is asked of.)
        const flat = makeFace(face.clone().outerWire(), face.clone().innerWires());
        if (flat.geomType !== 'PLANE') {
          return face;
        }
        changed = true;

        return flat;
      }
      // A straight line swept round an arc, along its axis: a cylinder.
      const cyl = cylinderFit(face, tol);
      if (!cyl) {
        return face;
      }
      const round = asCylinder(face, cyl, size);
      if (!round) {
        return face;
      }
      changed = true;

      return round;
    } catch {
      return face;
    }
  });
  if (!changed) {
    return shape;
  }
  try {
    const solid = makeSolid(faces) as unknown as Shape3D;
    const volume = Math.abs(volumeOf(shape));
    if (!shapeValid(solid) || Math.abs(Math.abs(volumeOf(solid)) - volume) > Math.max(1e-9, volume * 1e-6)) {
      return shape;
    }

    return unify(solid, size) as Shape3D;
  } catch {
    return shape;
  }
}

/**
 * A pattern of a hole: the hole's round wall as a plug - as long as the wall, a hair longer at an end that is open
 * - cut out of the body again at each place of the pattern. (A pattern started from a hole's wall copied the whole
 * body: there was no way to repeat a hole.)
 */
function holePattern(transform: Extract<Feature, { type: 'transform' }>, ctx: Ctx): void {
  const op = transform.op;
  if (op.kind !== 'linear' && op.kind !== 'circular') {
    throw new Error('A hole is repeated with a pattern');
  }
  const id = transform.bodies[0];
  const body = need(ctx.bodies, id);
  const face = resolveFace(body, transform.hole!);
  const cy = cylinderOf(face);
  if (!cy || cy.s >= 0) {
    throw new Error('Pick the round wall of a hole to repeat the hole');
  }
  patternCount(op.count);
  const a = norm(cy.a);
  const ts: number[] = [];
  for (const e of face.edges) {
    for (const fraction of [0, 0.25, 0.5, 0.75, 1]) {
      ts.push(dot(sub(e.pointAt(fraction).toTuple() as Vec3, cy.c), a));
    }
  }
  let [t0, t1] = [Math.min(...ts), Math.max(...ts)];
  if (!(t1 - t0 > 1e-9)) {
    throw new Error('That hole has no depth to repeat');
  }
  // An end with nothing past it (the hole's mouth, the far side of a hole right through): a hair past it, so the
  // cut comes out clean. An end with the body past it (a hole's bottom): exactly there, the same depth.
  const hair = Math.max(1e-3, cy.r * 0.02);
  const probe = Math.max(1e-4, Math.min(cy.r, t1 - t0) * 0.01);
  const [past0, past1] = insideOf(body, [add(cy.c, scale(a, t0 - probe)), add(cy.c, scale(a, t1 + probe))]);
  if (!past0) {
    t0 -= hair;
  }
  if (!past1) {
    t1 += hair;
  }
  const plug = makeCylinder(cy.r, t1 - t0, add(cy.c, scale(a, t0)), a) as Shape3D;
  let step: (k: number) => Affine;
  if (op.kind === 'linear') {
    if (Math.abs(op.spacing) < 1e-9 || len(op.dir) < 1e-12) {
      throw new Error('The spacing is zero: the holes would all be in one place');
    }
    step = index => affineFrom(point => add(point, scale(norm(op.dir), op.spacing * index)));
  } else {
    if (Math.abs(op.angle) < 1e-9) {
      throw new Error('The angle is zero: the holes would all be in one place');
    }
    const ax = resolveAxis(op.axis, ctx);
    const full = Math.abs(Math.abs(op.angle) - 360) < 1e-6;
    const turn = op.angle / (full ? op.count : Math.max(1, op.count - 1));
    step = index => affineFrom(point => rotateAbout(point, ax.origin, ax.dir, turn * index));
  }
  let out = body;
  let missed = 0;
  for (let index = 1; index < op.count; index++) {
    const next = out.cut(shapeThrough(plug, step(index))) as Shape3D;
    if (isEmpty(next)) {
      throw new Error('That pattern would cut the whole body away');
    }
    // (A place off the body: nothing to cut there - said, and the others made.)
    if (Math.abs(quickVolume(next) - quickVolume(out)) <= Math.abs(quickVolume(out)) * 1e-9) {
      missed++;
    }
    out = next;
  }
  if (missed === op.count - 1) {
    throw new Error('None of those holes is on the body - check the direction and the spacing');
  }
  if (missed) {
    editNotes.push(`${missed} of the ${op.count - 1} new holes ${missed === 1 ? 'is' : 'are'} off the body: nothing was cut there.`);
  }
  const kept = guardEdit(body, out, true);
  if (!kept) {
    throw new Error('That pattern would cut the whole body away');
  }
  ctx.bodies.set(id, kept);
  ctx.freeforms.delete(id);
}

function transform(transformFeature: Extract<Feature, { type: 'transform' }>, ctx: Ctx): void {
  const op = transformFeature.op;
  if (transformFeature.hole) {
    return holePattern(transformFeature, ctx);
  }
  const copies: [string, Shape3D][] = [];
  for (const id of transformFeature.bodies) {
    const body = need(ctx.bodies, id);
    const results: Shape3D[] = [];
    switch (op.kind) {
      case 'move': {
        let moved = body.clone();
        if (op.rotate && Math.abs(op.rotate.angle) > 1e-9) {
          moved = moved.rotate(op.rotate.angle, op.rotate.origin, op.rotate.axis);
        }
        if (len(op.translate) > 1e-9) {
          moved = moved.translate(op.translate);
        }
        results.push(moved);
        break;
      }
      case 'scale':
        if (op.factor <= 0) {
          throw new Error('Scale must be positive');
        }
        results.push(body.clone().scale(op.factor, op.center));
        break;
      case 'scaleXYZ': {
        if (op.factors.some(factor => factor <= 0)) {
          throw new Error('Scale factors must be positive');
        }
        const ff = ctx.freeforms.get(id);
        const [kx, ky, kz] = op.factors;
        // A freeform is rebuilt from its stretched cage (smooth as ever); any
        // other body is rebuilt face by face, stretched (all three the same: a plain scale).
        if (ff) {
          results.push(freeformShape(ff.feature, affineThen(ff.m, scaleAbout(op.center, op.factors))));
        } else if (Math.abs(kx - ky) < 1e-12 && Math.abs(ky - kz) < 1e-12) {
          results.push(body.clone().scale(kx, op.center));
        } else {
          results.push(stretchShape(body, op.center, op.factors));
        }
        break;
      }
      case 'mirror':
        results.push(body.clone().mirror(op.plane.normal, op.plane.origin));
        break;
      case 'linear':
        patternCount(op.count);
        if (Math.abs(op.spacing) < 1e-9 || len(op.dir) < 1e-12) {
          throw new Error('The spacing is zero: the copies would all sit in one place');
        }
        for (let index = 1; index < op.count; index++) {
          results.push(body.clone().translate(scale(norm(op.dir), op.spacing * index)));
        }
        break;
      case 'circular': {
        patternCount(op.count);
        if (Math.abs(op.angle) < 1e-9) {
          throw new Error('The angle is zero: the copies would all sit in one place');
        }
        const ax = resolveAxis(op.axis, ctx);
        const full = Math.abs(Math.abs(op.angle) - 360) < 1e-6;
        const step = op.angle / (full ? op.count : Math.max(1, op.count - 1));
        for (let index = 1; index < op.count; index++) {
          results.push(body.clone().rotate(step * index, ax.origin, ax.dir));
        }
        break;
      }
    }
    // Moved without changing shape: its mesh can be this body's, moved.
    const rigid = (index: number): Affine | null => {
      if (op.kind === 'move' || op.kind === 'mirror') {
        return opAffine(op);
      }
      if (op.kind === 'linear') {
        return affineFrom(point => add(point, scale(norm(op.dir), op.spacing * (index + 1))));
      }
      if (op.kind === 'circular') {
        const ax = resolveAxis(op.axis, ctx);
        const full = Math.abs(Math.abs(op.angle) - 360) < 1e-6;
        const step = op.angle / (full ? op.count : Math.max(1, op.count - 1));

        return affineFrom(point => rotateAbout(point, ax.origin, ax.dir, step * (index + 1)));
      }

      return null;
    };
    results.forEach((result, resultIndex) => {
      const affine = rigid(resultIndex);
      if (!affine) {
        return;
      }
      movedFrom.set(result, { from: new WeakRef(body), m: affine, flip: op.kind === 'mirror' });
      // (Its faces are still the steps' that made them: see movedTags.)
      movedTags(body, result, transformFeature.id, affine);
    });
    const isPattern = op.kind === 'linear' || op.kind === 'circular';
    // Linked: the copies and what they were made from are a group (one already of a group: its copies join it);
    // each stands where its move put it. A linked body moved, turned, mirrored or scaled evenly stands somewhere
    // else in its group; stretched, it is no longer the others' shape, and leaves it.
    const placed = (index: number): Affine | null => {
      const affine = rigid(index) ?? (isPattern ? null : opAffine(op));

      return affine && affineIsSimilar(affine) ? affine : null;
    };
    const mine = ctx.links.get(id);
    if (isPattern || transformFeature.copy) {
      if (transformFeature.link && results.every((_, resultIndex) => placed(resultIndex))) {
        const at = mine ?? { group: `${transformFeature.id}:${id}`, m: AFFINE_ID };
        if (!mine) {
          ctx.links.set(id, at);
        }
        results.forEach((_, resultIndex) => ctx.links.set(`${transformFeature.id}:${id}:${resultIndex}`, { group: at.group, m: affineThen(at.m, placed(resultIndex)!) }));
      }
    } else if (mine) {
      const affine = placed(0);
      if (affine) {
        ctx.links.set(id, { group: mine.group, m: affineThen(mine.m, affine) });
      } else {
        ctx.links.delete(id);
      }
    }
    // A freeform stays rebuildable through moves, scales and mirrors (copies too).
    const ff = ctx.freeforms.get(id);
    const step = ff && !isPattern ? opAffine(op) : null;
    if (isPattern || transformFeature.copy) {
      results.forEach((result, resultIndex) => copies.push([`${transformFeature.id}:${id}:${resultIndex}`, result]));
      if (ff && step) {
        ctx.freeforms.set(`${transformFeature.id}:${id}:0`, { feature: ff.feature, m: affineThen(ff.m, step) });
      }
    } else {
      ctx.bodies.set(id, results[0]);
      if (ff && step) {
        ctx.freeforms.set(id, { feature: ff.feature, m: affineThen(ff.m, step) });
      } else {
        ctx.freeforms.delete(id);
      }
    }
  }
  for (const [id, shape] of copies) {
    ctx.bodies.set(id, shape);
  }
}

/** A body cut by planes and other bodies' surfaces at once (OpenCascade's Splitter): the pieces, biggest first. */
function splitAll(body: Shape3D, planes: PlaneDef[], tools: Shape3D[]): Shape3D[] {
  const oc = getOC();
  const sp = new oc.BRepAlgoAPI_Splitter();
  const args = new oc.NCollection_List_TopoDS_Shape();
  const list = new oc.NCollection_List_TopoDS_Shape();
  const progress = new oc.Message_ProgressRange();
  try {
    args.Append(body.wrapped);
    const bb = body.boundingBox;
    for (const plane of planes) {
      // A sheet of the plane wider than the body.
      const length = (Math.hypot(bb.width, bb.height, bb.depth) + dist(bb.center as Vec3, plane.origin)) * 2 + 10;
      const x = plane.xDir;
      const y = cross(plane.normal, x);
      const corner = (along: number, across: number): Vec3 => add(plane.origin, add(scale(x, along * length), scale(y, across * length)));
      list.Append(makePolygon([corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)]).wrapped);
    }
    for (const t of tools) {
      list.Append(t.wrapped);
    }
    sp.SetArguments(args);
    sp.SetTools(list);
    sp.SetFuzzyValue(1e-5);
    sp.Build(progress);
    if (!sp.IsDone()) {
      throw new Error("It couldn't be split with those");
    }
    const pieces = subShapes(cast(sp.Shape()) as Shape3D, 'SOLID').map(solid => cast(solid) as Shape3D);
    const vol = pieces.map(piece => Math.abs(volumeOf(piece)));

    return pieces.map((piece, i) => ({ p: piece, v: vol[i] })).filter(piece => piece.v > 1e-9).sort((a, b) => b.v - a.v).map(piece => piece.p);
  } finally {
    sp.delete();
    args.delete();
    list.delete();
    progress.delete();
  }
}

/** What an extrusion goes up to: the face as it is now (a flat one: its whole plane), or a plane; and a point on it. */
function extrudeTarget(to: { face?: FaceRef; plane?: PlaneDef }, ctx: Ctx): { shape: Shape3D; point: Vec3; plane?: PlaneDef } {
  if (to.face) {
    const face = resolveFace(need(ctx.bodies, to.face.body), to.face);
    // A flat face: its whole plane (an extrusion wider than the face still stops there).
    if (face.geomType === 'PLANE') {
      const point = face.center.toTuple() as Vec3;
      const normal = norm(face.normalAt().toTuple() as Vec3);

      return { shape: face as unknown as Shape3D, point, plane: { origin: point, normal, xDir: xDirFor(normal) } };
    }

    return { shape: face as unknown as Shape3D, point: face.center.toTuple() as Vec3 };
  }
  const plane = to.plane!;

  return { shape: makeVertex(plane.origin) as unknown as Shape3D, point: plane.origin, plane };
}

/** Far enough to come out of every body, the shapes and the target: twice everything's span. */
function reachOf(ctx: Ctx, shapes: Shape3D[], extra?: Shape3D): number {
  const lo: Vec3 = [Infinity, Infinity, Infinity];
  const hi: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const shape of [...ctx.bodies.values(), ...shapes, ...(extra ? [extra] : [])]) {
    const [a, b] = shape.boundingBox.bounds;
    for (let axis = 0; axis < 3; axis++) {
      lo[axis] = Math.min(lo[axis], a[axis]);
      hi[axis] = Math.max(hi[axis], b[axis]);
    }
  }
  if (!Number.isFinite(lo[0])) {
    return 1000;
  }

  return Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) * 2 + 10;
}

/** An extrusion stopped at its target: a plane cuts off what's beyond it; a round face splits it and the part at the shape stays. */
function trimmedTo(solid: Shape3D, to: { shape: Shape3D; point: Vec3; plane?: PlaneDef }, from: Vec3): Shape3D {
  if (to.plane) {
    // The half beyond the plane (away from the shape) goes.
    const normal = dot(sub(from, to.plane.origin), to.plane.normal) > 0 ? scale(to.plane.normal, -1) : to.plane.normal;
    const beyond = halfSpace({ ...to.plane, normal: normal, xDir: xDirFor(normal) }, solid);
    const out = fuzzyBoolean('cut', solid, beyond);
    if (isEmpty(out)) {
      throw new Error("Nothing is left before that face or plane - it's behind the shape");
    }

    return out;
  }
  const oc = getOC();
  const sp = new oc.BRepAlgoAPI_Splitter();
  const args = new oc.NCollection_List_TopoDS_Shape();
  const tools = new oc.NCollection_List_TopoDS_Shape();
  const progress = new oc.Message_ProgressRange();
  try {
    args.Append(solid.wrapped);
    tools.Append(to.shape.wrapped);
    sp.SetArguments(args);
    sp.SetTools(tools);
    sp.Build(progress);
    if (!sp.IsDone()) {
      throw new Error("It couldn't be stopped at that face");
    }
    const pieces = subShapes(cast(sp.Shape()) as Shape3D, 'SOLID').map(solid => cast(solid) as Shape3D);
    if (pieces.length < 2) {
      throw new Error("It doesn't run all the way across that face - pick a face it passes through whole, or a plane");
    }
    // The piece the shape starts from: the one nearest it.
    const at = makeVertex(from) as unknown as Shape3D;
    const distances = pieces.map(piece => measureDistanceBetween(piece, at));
    const best = Math.min(...distances);

    return fuseAll(pieces.filter((_, i) => distances[i] <= best + 1e-6));
  } finally {
    sp.delete();
    args.delete();
    tools.delete();
    progress.delete();
  }
}

/** A straight extrusion's sides leaned `deg` degrees in (a draft) towards its far end along `dir`, hinged on the plane through `origin`. */
function drafted(solid: Shape3D, dir: Vec3, origin: Vec3, deg: number): Shape3D {
  const oc = getOC();
  const normal = norm(dir);
  const direction = new oc.gp_Dir(normal[0], normal[1], normal[2]);
  const at = new oc.gp_Pnt(origin[0], origin[1], origin[2]);
  const pln = new oc.gp_Pln(at, direction);
  const mk = new oc.BRepOffsetAPI_DraftAngle(solid.wrapped);
  const progress = new oc.Message_ProgressRange();
  const fail = "These sides can't lean that far - try a smaller draft angle";
  try {
    for (const face of solid.faces) {
      // The ends stay as they are; every side leans.
      if (face.geomType === 'PLANE' && Math.abs(dot(norm(face.normalAt().toTuple() as Vec3), normal)) > 0.999) {
        continue;
      }
      mk.Add(oc.TopoDS.Face(face.wrapped), direction, (DRAFT_SIGN * deg * Math.PI) / 180, pln, true);
      if (!mk.AddDone()) {
        throw new Error(fail);
      }
    }
    mk.Build(progress);
    if (!mk.IsDone()) {
      throw new Error(fail);
    }
    const out = cast(mk.Shape());
    if (!isShape3D(out) || !shapeValid(out)) {
      throw new Error(fail);
    }

    return out;
  } finally {
    mk.delete();
    pln.delete();
    at.delete();
    direction.delete();
    progress.delete();
  }
}
/** Which way OpenCascade's draft angle leans (checked in tests: a positive draft narrows the far end). */
const DRAFT_SIGN = 1;

/** Each sketch as it was last made (see the sketch step). */
const sketchWas = new Map<string, { text: string; state: SketchState }>();

/** The same thing, every number within `tol` of the other's. */
function sameNumbers(a: unknown, b: unknown, tol: number): boolean {
  if (typeof a === 'number' && typeof b === 'number') {
    return Math.abs(a - b) <= tol;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => sameNumbers(item, b[i], tol));
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a as object);

    return ka.length === Object.keys(b as object).length && ka.every(key => sameNumbers((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key], tol));
  }

  return a === b;
}

/**
 * A sketch's curves with those that follow a body's edge put where the edge
 * is now (seen straight onto the sketch's plane), and the rest moved by the
 * sketch's dimensions and constraints to them.
 */
function followEdges(sketch: SketchFeature, plane: PlaneDef, bodies: Bodies): SketchEntity[] {
  const links = new Map(sketch.links!.map(link => [link.id, link]));
  let lost = 0;
  let moved = false;
  const entities = sketch.entities.map((e) => {
    const link = links.get(e.id);
    if (!link) {
      return e;
    }
    let made: SketchEntity | null = null;
    try {
      const edge = resolveEdge(need(bodies, link.edge.body), link.edge);
      // (A curve made as a spline - an older project's - stays one: sizes may be tied to its points.)
      made = projectPolyline(Array.from({ length: 25 }, (_, index) => edge.pointAt(index / 24).toTuple() as Vec3), plane, edge.geomType, false, e.kind !== 'spline');
    } catch (err) {
      if (isFault(err)) {
        throw err;
      }
    }
    // Gone, or seen end-on from here (a point): the curve stays where it was.
    if (!made) {
      lost++;

      return e;
    }
    // Its ends the way round they were (what is tied to one end stays on that end).
    if ((made.kind === 'line' || made.kind === 'arc') && e.kind === made.kind) {
      const far = (point: number[], q: number[]) => Math.hypot(point[0] - q[0], point[1] - q[1]);
      if (far(made.a, e.b) + far(made.b, e.a) < far(made.a, e.a) + far(made.b, e.b)) {
        made = { ...made, a: made.b, b: made.a };
      }
    }
    // (Part of an ellipse the same: run from the end it ran from before.)
    if (made.kind === 'ellipse' && made.sweep !== undefined && e.kind === 'ellipse' && e.sweep !== undefined) {
      const end = (x: Extract<SketchEntity, { kind: 'ellipse' }>, t: number): [number, number] => {
        const px = x.rx * Math.cos(t);
        const py = x.ry * Math.sin(t);

        return [x.center[0] + px * Math.cos(x.rotation) - py * Math.sin(x.rotation), x.center[1] + px * Math.sin(x.rotation) + py * Math.cos(x.rotation)];
      };
      const far = (point: number[], q: number[]) => Math.hypot(point[0] - q[0], point[1] - q[1]);
      const [ma, mb] = [end(made, made.a0 ?? 0), end(made, (made.a0 ?? 0) + made.sweep)];
      const [ea, eb] = [end(e, e.a0 ?? 0), end(e, (e.a0 ?? 0) + e.sweep)];
      if (far(ma, eb) + far(mb, ea) < far(ma, ea) + far(mb, eb)) {
        made = { ...made, a0: (made.a0 ?? 0) + made.sweep, sweep: -made.sweep };
      }
    }
    const now = { ...made, id: e.id, ...(e.construction ? { construction: true } : {}) } as SketchEntity;
    if (sameNumbers(e, now, 1e-9)) {
      return e;
    }
    moved = true;

    return now;
  });
  if (lost) {
    editNotes.push(lost === 1 ? 'An edge this sketch follows is gone: that curve stays where it was.' : `${lost} edges this sketch follows are gone: those curves stay where they were.`);
  }
  if (!moved) {
    return sketch.entities;
  }
  if (!sketch.constraints?.length) {
    return entities;
  }
  // What is dimensioned to them goes with them first (a distance doesn't say which side).
  const solution = solveFine(carried(sketch.entities, entities, sketch.constraints, new Set(links.keys())), sketch.constraints);
  if (solution.ok) {
    return solution.entities;
  }
  editNotes.push("The edge this sketch follows moved to where the sketch's dimensions can't all be kept: its other curves stay where they were.");

  return entities;
}

/** The outline of the face a sketch sits on, as sketch curves (ids "bnd-…"). */
function faceBoundary(ref: FaceRef, plane: PlaneDef, bodies: Bodies): SketchEntity[] {
  const body = bodies.get(ref.body);
  if (!body) {
    return [];
  }
  let face: Face;
  try {
    face = resolveFace(body, ref);
  } catch {
    return [];
  }
  if (face.geomType !== 'PLANE') {
    return [];
  }

  return face.edges.flatMap((e, i) => {
    const pts = Array.from({ length: 25 }, (_, index) => e.pointAt(index / 24).toTuple() as Vec3);
    // (A face's own outline: as it always was - shapes are made of it.)
    const ent = projectPolyline(pts, plane, e.geomType, false, false);

    return ent ? [{ ...ent, id: `bnd-${i}` }] : [];
  });
}

/** A sketch drawn on a construction plane: where that plane is now (moved along it, or turned with it). */
function followPlane(sketch: SketchFeature, ctx: Ctx): PlaneDef {
  const plane = ctx.planes.get(sketch.onPlane!)?.plane;
  if (!plane) {
    return sketch.plane;
  }
  const normal = norm(plane.normal);
  if (Math.abs(dot(normal, norm(sketch.plane.normal))) < 0.9999) {
    return { origin: plane.origin, normal: plane.normal, xDir: plane.xDir };
  }

  // The same way round: the sketch's own origin and X kept, moved onto the plane.
  return { ...sketch.plane, origin: add(sketch.plane.origin, scale(normal, dot(normal, sub(plane.origin, sketch.plane.origin)))) };
}

/** A sketch drawn on a face moves with that face when earlier features change. */
function followFace(sketch: SketchFeature, bodies: Bodies): PlaneDef {
  const ref = sketch.attachedTo!;
  const body = bodies.get(ref.body);
  if (!body) {
    return sketch.plane;
  }
  let face: Face;
  try {
    face = resolveFace(body, ref);
  } catch {
    // Its face is gone (the step that made it switched off or changed): the
    // sketch stays where it was, and says so - rather than stopping every step after it.
    editNotes.push('The face this sketch was drawn on is gone: it stays where it was. Tap it and pick a face to move it onto one.');

    return sketch.plane;
  }

  const normal = norm(face.normalAt().toTuple() as Vec3);
  const center = face.center.toTuple() as Vec3;
  const offset = dot(normal, sub(center, sketch.plane.origin));
  const origin = add(sketch.plane.origin, scale(normal, offset));

  return dot(normal, sketch.plane.normal) > 0.999 ? { ...sketch.plane, origin } : { origin, normal: normal, xDir: xDirFor(normal) };
}

// ----------------------------------------------------- geometric references

/** `count` points along a wire (end to end; a closed one's start not repeated). */
function curvePoints(wire: any, count: number, closed = false): Vec3[] {
  const oc = getOC();
  const curve = new oc.BRepAdaptor_CompCurve(wire, false);
  const out: Vec3[] = [];
  try {
    const a = curve.FirstParameter();
    const b = curve.LastParameter();
    for (let index = 0; index < (closed ? count : count + 1); index++) {
      const curvePoint = curve.Value(a + ((b - a) * index) / count);
      out.push([curvePoint.X(), curvePoint.Y(), curvePoint.Z()]);
      curvePoint.delete();
    }
  } finally {
    curve.delete();
  }

  return out;
}

/**
 * One end of a Connect bridge: the face's outer edge as points in order, its
 * middle and outward normal, and how far the bridge may go into the body
 * behind it (a third of the face's size, less than half the body's depth
 * there - a 3 mm plate's end doesn't poke out of its back).
 */
interface BridgeEnd {
  center: Vec3;
  /** The way the bridge leaves the face: out of it (into it, for a tunnel). */
  dir: Vec3;
  /** The outline swept (sized, and moved `depth` back against `dir`). */
  outline: any;
  /** The same outline on the face itself. */
  rim: any;
  depth: number;
  /** How far the outline reaches from the middle. */
  reach: number;
  /** Points round the outline (sized), from the middle. */
  ring: Vec3[];
  /** Made of two faces either side of a seam (its outline in more pieces than the face's own: a sweep pairs them up wrongly). */
  joined?: boolean;
  /** The face's area (sized). */
  area: number;
}

/**
 * A patch on a round face that crosses the seam of its surface (where a
 * revolved body's surface starts and ends) comes in two faces, one each side:
 * the piece on the other side of `face`'s, and the outline of the two as one.
 * (A handle's pad projected onto a mug's side, on the seam: one tap picked
 * half of it, and the handle was bridged from half a pad.)
 */
function acrossSeam(body: Shape3D, face: Face): { other: Face; wire: any } | null {
  if (!['CYLINDRE', 'CONE', 'SPHERE', 'TORUS', 'REVOLUTION_SURFACE'].includes(face.geomType)) {
    return null;
  }
  const TAU = 2 * Math.PI;
  const onSeam = (face: Face, point: Vec3) => {
    const angle = ((face.uvCoordinates(point)[0] % TAU) + TAU) % TAU;

    return angle < 1e-6 || TAU - angle < 1e-6;
  };
  try {
    for (const e of face.edges) {
      const mid = e.pointAt(0.5).toTuple() as Vec3;
      if (!onSeam(face, mid)) {
        continue;
      }
      const other = body.faces.find(otherFace => !otherFace.isSame(face) && otherFace.geomType === face.geomType && otherFace.edges.some(edge => edge.isSame(e)));
      // (The same surface going on smoothly across the edge.)
      if (!other || dot(norm(face.normalAt(mid).toTuple() as Vec3), norm(other.normalAt(mid).toTuple() as Vec3)) < 1 - 1e-6) {
        continue;
      }
      // The two outlines, the edge between them left out, end to end.
      const pool = [...face.clone().outerWire().edges, ...other.clone().outerWire().edges].filter(edge => !edge.isSame(e));
      const chain = [pool.shift()!];
      const tol = sizeOf(body) * 1e-5;
      while (pool.length) {
        const end = chain[chain.length - 1].endPoint.toTuple() as Vec3;
        const end0 = chain[chain.length - 1].startPoint.toTuple() as Vec3;
        const i = pool.findIndex(edge => [edge.startPoint, edge.endPoint].some(q => [end, end0].some(point => dist(q.toTuple() as Vec3, point) < tol)));
        if (i < 0) {
          return null;
        }
        chain.push(pool.splice(i, 1)[0]);
      }

      return { other, wire: assembleWire(chain).wrapped };
    }
  } catch {
    // (Not one to join: the face as it is.)
  }

  return null;
}

/**
 * One end of Connect's bridge: the face's outline (`size` of it, about its
 * middle), and the same moved a little way into its body when it's to be
 * joined or cut (so the bodies overlap it, not only touch) - never out of the
 * far side.
 */
function bridgeEnd(body: Shape3D, face: Face, size: number, inward: boolean, sink: boolean): BridgeEnd {
  const oc = getOC();
  const joined = acrossSeam(body, face);
  let info = faceInfo(face);
  if (joined) {
    // The middle, the area and the way out of the two pieces as one.
    const joinedInfo = faceInfo(joined.other);
    const area = info.area + joinedInfo.area;
    const center = scale(add(scale(info.center, info.area), scale(joinedInfo.center, joinedInfo.area)), 1 / area);
    info = { ...info, area, center, normal: norm(add(scale(info.normal, info.area), scale(joinedInfo.normal, joinedInfo.area))) };
  }
  const wire = joined?.wire ?? oc.BRepTools.OuterWire(face.wrapped);
  // (A joined outline evenly round by length: by the pieces' own measures, its
  // points bunched on the straight sides, few on the arcs, and the smooth
  // outline made through them bulged out past the pad.)
  const dense = joined ? curvePoints(wire, 512, true) : null;
  const ring = dense ? evenly([...dense, dense[0]], 65).slice(0, 64) : curvePoints(wire, 64, true);
  const reach = Math.max(...ring.map(point => dist(point, info.center))) * size;
  const around = ring.map(point => scale(sub(point, info.center), size));
  const dir = inward ? scale(info.normal, -1) : info.normal;
  // The ends start a little back from the faces so the bridge overlaps what it
  // joins (into the body, but not out of its back; for a tunnel, outside it).
  const [lo, hi] = body.boundingBox.bounds as [Vec3, Vec3];
  let behind = 0;
  for (const x of [lo[0], hi[0]]) {
    for (const y of [lo[1], hi[1]]) {
      for (const z of [lo[2], hi[2]]) {
        behind = Math.max(behind, dot(sub(info.center, [x, y, z]), info.normal));
      }
    }
  }
  const depth = !sink ? 0 : inward ? reach * 0.25 : Math.max(1e-3, Math.min(reach * 0.25, behind * 0.45 || reach * 0.1));
  const t = new oc.gp_Trsf();
  const at = new oc.gp_Pnt(info.center[0], info.center[1], info.center[2]);
  t.SetScale(at, size);
  const move = new oc.gp_Trsf();
  const vector = new oc.gp_Vec(-dir[0] * depth, -dir[1] * depth, -dir[2] * depth);
  move.SetTranslation(vector);
  const both = move.Multiplied(t);
  const mk = new oc.BRepBuilderAPI_Transform(wire, both, true);
  const outline = mk.Shape();
  const mr = new oc.BRepBuilderAPI_Transform(wire, t, true);
  const rim = mr.Shape();
  for (const x of [t, at, move, vector, both, mk, mr]) {
    x.delete();
  }

  return { center: info.center, dir, outline, rim, depth, reach, ring: around, area: info.area * size * size, joined: !!joined };
}

/** Why a bridge couldn't be made (its curve too tight for its width: the usual reason). */
const bridgeFailed = (guided: boolean) =>
  guided
    ? "The bridge can't be made along this curve (it turns too tightly for its width, or twists through itself) - try a gentler curve, or a smaller Size"
    : "The bridge can't be made between these two faces as they are (too close for its width, or outlines too unlike each other) - try a smaller Size or another Bend, or draw a curve for it to follow";

/**
 * Connect's bridge: face A's outline swept along `along` (0..1, from A's
 * middle to B's) turning into face B's - it starts and ends exactly on the
 * faces' edges (as sized by bridgeEnd), and goes on, straight, as far into
 * the bodies as bridgeEnd set it back.
 */
function sweepBridge(a: BridgeEnd, b: BridgeEnd, along: (t: number) => Vec3, how: { guided: boolean; exact: boolean; slide?: Vec3; samples: number }): { shape: Shape3D; exact: boolean } {
  const oc = getOC();
  const { guided, exact, slide, samples } = how;
  // A bridge is at least this big: its smaller end carried straight from one
  // face to the other (sliding, as little of that as the curve may lean). Less,
  // and the sweep went wrong without saying so - turned inside out part of the
  // way, its two halves cancelling (a solid of 128 mm3 for one of 30 000).
  const least = Math.min(a.area, b.area) * dist(a.center, b.center) * 0.15;
  // B's outline lined up with A's as A's arrives there carried along the
  // curve: the same way round, from the point A's first point comes to.
  // (Starting from another corner, or going round the other way, the bridge
  // twisted - half way round, or inside out to a solid of half a mm3.)
  const fr = carriedFrames(along, 120);
  const [f0, f1] = [fr[0], fr[fr.length - 1]];
  const arrived = a.ring.map((point): Vec3 => add(scale(f1.r, dot(point, f0.r)), scale(f1.s, dot(point, f0.s))));
  const flatten = (e: BridgeEnd, point: Vec3) => sub(point, scale(e.dir, dot(point, e.dir)));
  let bRing = b.ring;
  // (An outline joined across a seam is in more pieces than the face's own,
  // and the sweep pairs them up wrongly: only the lined-up ones are used.)
  const lined = !a.joined && !b.joined;
  {
    const count = b.ring.length;
    const step = Math.max(1, Math.round(count / a.ring.length));
    let best = Infinity;
    for (const ring of [b.ring, [...b.ring].reverse()]) {
      for (let shift = 0; shift < count; shift++) {
        let cost = 0;
        for (let i = 0; i < arrived.length; i++) {
          const delta = sub(flatten(b, arrived[i]), flatten(b, ring[(shift + i * step) % count]));
          cost += dot(delta, delta);
        }
        if (cost < best) {
          (best = cost), (bRing = [...ring.slice(shift), ...ring.slice(0, shift)]);
        }
      }
    }
  }
  const spine = (lead: boolean) => {
    // In from deep in A, straight out through its face; along the curve; and the same into B.
    const back = (e: BridgeEnd, rev: boolean) => {
      const depths = [0, 1, 2, 3].map(i => (e.depth * (rev ? i : 3 - i)) / 3);

      return lead && e.depth > 0 ? depths.filter(x => x > 0).map(x => sub(e.center, scale(e.dir, x))) : [];
    };
    const pts = [...back(a, false), ...Array.from({ length: samples + 1 }, (_, i) => along(i / samples)), ...back(b, true)];
    const span = dist(pts[0], pts[pts.length - 1]) + 1;

    return assembleWire([makeBSplineApproximation(pts, { tolerance: span * 1e-4, degMax: 5, degMin: 3 })]);
  };
  const pipe = (path: ReturnType<typeof spine>, sections: (() => any[])[]): Shape3D | null => {
    // The way the outline is carried along: each copes with curves the others don't.
    for (const section of sections) {
      for (const mode of slide ? ['slide'] : ['discrete', 'corrected']) {
        let ends: any[];
        try {
          ends = section();
        } catch {
          continue;
        }
        const mk = new oc.BRepOffsetAPI_MakePipeShell(path.wrapped);
        const progress = new oc.Message_ProgressRange();
        try {
          if (mode === 'slide') {
          // Every section facing the same way: the outline slides along the curve, not turning with it.
            const x = xDirFor(slide!);
            const origin = new oc.gp_Pnt(0, 0, 0);
            const direction = new oc.gp_Dir(slide![0], slide![1], slide![2]);
            const vx = new oc.gp_Dir(x[0], x[1], x[2]);
            const ax = new oc.gp_Ax2(origin, direction, vx);
            mk.SetMode(ax);
            for (const handle of [origin, direction, vx, ax]) {
              handle.delete();
            }
          } else if (mode === 'discrete') {
            mk.SetDiscreteMode();
          } else {
            mk.SetMode(false);
          }
          for (const end of ends) {
            mk.Add(end, false, false);
          }
          mk.Build(progress);
          if (!mk.IsDone()) {
            throw new Error('sweep');
          }
          mk.MakeSolid();
          let shape = cast(mk.Shape()) as Shape3D;
          // (Its sign and that it isn't empty: the rough measure tells both.)
          const volume = roughVolume(shape);
          if (volume < 0) {
            shape = cast(shape.wrapped.Reversed()) as Shape3D;
          }
          // (Ends that aren't flat aren't closed: a tube open at both ends.)
          if (!shapeValid(shape) || !(Math.abs(volume) > least) || openEdges(shape).length) {
            throw new Error('bad');
          }

          return shape;
        } catch {
        /* the next way, or none */
        } finally {
          mk.delete();
          progress.delete();
        }
      }
    }

    return null;
  };
  // Set back into the bodies: from face to face, then each face's outline
  // straight on into its body (a plug). Swept from where it was set back
  // instead, the outline was already part way to the other face's where it
  // left its own - a square end into a small round one started inside the
  // square's edges.
  if (exact && lined && (a.depth > 0 || b.depth > 0)) {
    const plug = (e: BridgeEnd): Shape3D => {
      const mf = new oc.BRepBuilderAPI_MakeFace(oc.TopoDS.Wire(e.rim), true);
      const vector = new oc.gp_Vec(-e.dir[0] * e.depth, -e.dir[1] * e.depth, -e.dir[2] * e.depth);
      try {
        if (!mf.IsDone()) {
          throw new Error('not flat');
        }
        const pr = new oc.BRepPrimAPI_MakePrism(mf.Face(), vector, true, true);
        const shape = cast(pr.Shape()) as Shape3D;
        pr.delete();

        return shape;
      } finally {
        mf.delete();
        vector.delete();
      }
    };
    const piped = pipe(spine(false), [() => [a.rim, b.rim]]);
    if (piped) {
      try {
        let out = piped;
        for (const e of [a, b]) {
          if (e.depth > 0) {
            out = out.fuse(plug(e));
          }
        }
        if (quickVolume(out) < 0) {
          out = cast(out.wrapped.Reversed()) as Shape3D;
        }
        if (shapeValid(out) && [...iterTopo(out.wrapped, 'solid')].length === 1 && measureVolume(out) > measureVolume(piped)) {
          return { shape: out, exact: true };
        }
      } catch {
        /* (a curved face, or a plug that won't join) the way below */
      }
    }
  }
  // The faces' own outlines; and, where one can't be turned into the other (a
  // square into an L: not the same number of sides, corners that don't pair
  // up), each as one smooth closed curve through points round it. `flat`: laid
  // flat across the way out of the face (a patch on a round face - a mug's
  // side - has an outline that isn't flat, and no sweep closes on it).
  const smooth = (e: BridgeEnd, flat = false, own = false) => {
    const base = sub(e.center, scale(e.dir, e.depth));
    const ring = e === b && !own ? bRing : e.ring;
    // (A little inside the face's own edge: walls a hair apart from the body's make its join leave gaps.)
    const round = ring.map(point => add(base, scale(flat ? flatten(e, point) : point, 0.97)));

    return assembleWire([makeBSplineApproximation([...round, round[0]], { tolerance: Math.max(1e-4, e.reach * 1e-3), degMax: 5, degMin: 3 })]).wrapped;
  };
  // (Faces' own outlines: tried first each the way it goes round;
  // then lined up. An L's outline lined up with a square's that way twisted the
  // bridge at its inward corner, and it wouldn't join.)
  const own = lined ? [() => [a.outline, b.outline], () => [smooth(a), smooth(b, false, true)]] : [];
  const smoothPiped = pipe(spine(true), [...own, () => [smooth(a), smooth(b)], () => [smooth(a, true), smooth(b, true)]]);
  if (smoothPiped) {
    return { shape: smoothPiped, exact: false };
  }
  throw new Error(bridgeFailed(guided));
}

/**
 * Those of `pts` that lie over the flat face itself (seen along its normal),
 * clear of its edge. A cage's smooth surface cuts an inward corner of the
 * face's outline (an L's) a little short: the points it has out there, past
 * the edge, would fold the face over when it is filled through them.
 */
function onFace(face: Face, pts: Vec3[]): Vec3[] {
  const normal = norm(face.normalAt().toTuple() as Vec3);
  const xDir = xDirFor(normal);
  const vAxis = norm(cross(normal, xDir));
  // (outerWire uses up the face it's called on: a clone.)
  const wire = face.clone().outerWire();
  const loop = curvePoints(wire.wrapped, 600, true).map(curvePoint => [dot(curvePoint, xDir), dot(curvePoint, vAxis)]);
  wire.delete();
  const count = loop.length;
  let area = 0;
  for (let a = 0, b = count - 1; a < count; b = a++) {
    area += loop[b][0] * loop[a][1] - loop[a][0] * loop[b][1];
  }
  const margin = Math.sqrt(Math.abs(area) / 2) * 0.01;
  const kept = pts.filter((point) => {
    const x = dot(point, xDir);
    const y = dot(point, vAxis);
    let inside = false;
    let near = Infinity;
    for (let a = 0, b = count - 1; a < count; b = a++) {
      const [ax, ay] = loop[a];
      const [bx, by] = loop[b];
      if (ay > y !== by > y && x < ((bx - ax) * (y - ay)) / (by - ay) + ax) {
        inside = !inside;
      }
      const lengthSquared = (bx - ax) ** 2 + (by - ay) ** 2;
      const t = lengthSquared > 0 ? Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / lengthSquared)) : 0;
      near = Math.min(near, Math.hypot(x - ax - t * (bx - ax), y - ay - t * (by - ay)));
    }

    return inside && near > margin;
  });

  // (None left - a sliver of a face: as they were, and the fill says what it can't do.)
  return kept.length ? kept : pts;
}

/**
 * Points on the smooth surface a Freeform Face cage makes (its border left
 * out: the face's own edges are kept), for the face to be filled through; null
 * when every inside point is still on the face (nothing to do).
 */
function faceCagePoints(cage: { verts: Vec3[]; faces: [number, number, number, number][] }, normal: Vec3, fine = true): Vec3[] | null {
  const border = new Set(boundaryEdges(cage).flat());
  const inside = cage.verts.map((_, i) => i).filter(i => !border.has(i));
  const vertex = cage.verts[[...border][0]];
  // All still in the face's plane: the smooth surface is the flat face itself.
  if (!vertex || !inside.some(i => Math.abs(dot(sub(cage.verts[i], vertex), normal)) > 1e-9)) {
    return null;
  }
  // Twice as fine as the cage, as long as that isn't too many to fill through.
  const plan = cachedPlan(cage, !fine || inside.length > 60 ? 0 : 1);
  const pos = applyPlan(plan, cage.verts);
  const { ptr, idx } = plan.rows;
  const out: Vec3[] = [];
  for (let row = 0; row < ptr.length - 1; row++) {
    let onBorder = true;
    for (let t = ptr[row]; t < ptr[row + 1] && onBorder; t++) {
      if (!border.has(idx[t])) {
        onBorder = false;
      }
    }
    if (!onBorder) {
      out.push([pos[3 * row], pos[3 * row + 1], pos[3 * row + 2]]);
    }
  }

  return out;
}

/**
 * A face's facts, kept from the last time it was shown: a step changes a few of a body's faces and leaves the rest
 * the very same faces, and each one's exact area was measured again for the whole body all the same (a freeform
 * shoe with a hole cut in it: 1.7 s of measuring faces that hadn't changed).
 */
let infosNow = new Map<number, { face: { IsEqual(o: unknown): boolean; IsNull(): boolean }; info: FaceInfo }[]>();
let infosWas = new Map<number, { face: { IsEqual(o: unknown): boolean; IsNull(): boolean }; info: FaceInfo }[]>();
let infosKept = 0;
function faceInfoKept(face: Face): FaceInfo {
  let hash = -1;
  try {
    hash = (face.wrapped as unknown as { HashCode(max: number): number }).HashCode(2147483647);
    for (const kept of [infosNow, infosWas]) {
      const hit = kept.get(hash)?.find(entry => !entry.face.IsNull() && entry.face.IsEqual(face.wrapped));
      if (hit) {
        if (kept === infosWas) {
          keepInfo(hash, hit);
        }

        return hit.info;
      }
    }
  } catch {
    // Measured, below.
  }
  const info = faceInfo(face);
  if (hash >= 0) {
    keepInfo(hash, { face: face.wrapped as never, info });
  }

  return info;
}
function keepInfo(hash: number, entry: { face: { IsEqual(o: unknown): boolean; IsNull(): boolean }; info: FaceInfo }): void {
  // (Not for ever: the faces of bodies long gone are let go, two lots back.)
  if (infosKept >= 6000) {
    infosWas = infosNow;
    infosNow = new Map();
    infosKept = 0;
  }
  const list = infosNow.get(hash);
  if (list) {
    list.push(entry);
  } else {
    infosNow.set(hash, [entry]);
  }
  infosKept++;
}

/**
 * For a step made from a sketch (an extrusion, a revolve): which of its faces
 * a face is - the sketch curve its surface was drawn out of ("line3:0": the
 * curve's id and which piece of it), or an end ("cap:0" on the sketch's plane,
 * "cap:1" away from it, and the curve nearest its middle). Told from the face
 * as it is, so a face trimmed or cut by later steps still says the same.
 */
function originsOf(feature: Feature, ctx: Ctx): OriginOf | undefined {
  if ((feature.type !== 'extrude' && feature.type !== 'revolve') || feature.source.kind !== 'profile') {
    return undefined;
  }
  if (feature.type === 'extrude' && feature.taper !== undefined && Math.abs(feature.taper - 1) > 1e-9) {
    return undefined;
  }
  const sketchState = ctx.sketches.get(feature.source.sketch);
  if (!sketchState) {
    return undefined;
  }
  // The curves round the shapes it was made from (all of the sketch's, when not known).
  const ids = new Set(feature.source.regions.flatMap(region => region.k ?? []));
  const known = feature.source.regions.every(region => region.k?.length);
  const curves = sketchState.entities.filter(e => !e.construction && (!known || ids.has(e.id)));
  if (!curves.length || curves.length > 400) {
    return undefined;
  }
  const { origin, normal } = sketchState.plane;
  const unitNormal = norm(normal);
  const uAxis = norm(sketchState.plane.xDir);
  const vAxis = norm(cross(unitNormal, uAxis));
  const flat = (point: Vec3): [number, number] => [dot(sub(point, origin), uAxis), dot(sub(point, origin), vAxis)];
  const nearest = (q: [number, number]) => {
    let best: { key: string; d: number } | null = null;
    for (const e of curves) {
      const closest = closestOnEntity(e, q);
      if (!best || closest.d < best.d) {
        best = { key: `${e.id}:${closest.prim}`, d: closest.d };
      }
    }

    return best!;
  };
  const axis = feature.type === 'revolve' ? resolveAxis(feature.axis, ctx) : null;

  return (face, back) => {
    const point = face.pointOnSurface(0.5, 0.5);
    let at = point.toTuple() as Vec3;
    point.delete();
    let fn = face.geomType === 'PLANE' ? norm(face.normalAt().toTuple() as Vec3) : null;
    // (A face of a body moved since: taken back to where this step made it.)
    if (back) {
      at = back(at);
      if (fn) {
        fn = norm(back(fn, true));
      }
    }
    if (axis) {
      // An end of a part turn: a flat face the axis lies in.
      if (fn && Math.abs(dot(fn, axis.dir)) < 1e-6 && Math.abs(dot(sub(at, axis.origin), fn)) < 1e-4) {
        return `cap:${Math.abs(dot(fn, unitNormal)) > 0.999 ? 0 : 1}`;
      }
      // Turned back into the sketch's plane (either side of the axis).
      const along = dot(sub(at, axis.origin), axis.dir);
      const foot = add(axis.origin, scale(axis.dir, along));
      const radius = dist(at, foot);
      const out = norm(cross(unitNormal, axis.dir));
      const a = nearest(flat(add(foot, scale(out, radius))));
      const b = nearest(flat(add(foot, scale(out, -radius))));
      const best = a.d <= b.d ? a : b;

      return best.d < 1e-3 + radius * 1e-6 ? best.key : null;
    }
    const q = flat(at);
    const hit = nearest(q);
    if (fn && Math.abs(dot(fn, unitNormal)) > 0.999) {
      const height = dot(sub(at, origin), unitNormal);

      return `cap:${Math.abs(height) < 1e-4 ? 0 : height > 0 ? 1 : 2}@${hit.key}`;
    }

    return hit.d < 1e-3 ? hit.key : null;
  };
}



/** No corner along it: the two faces beside the edge look the same way at its middle (to about 3°). */
function smoothEdge(body: Shape3D, edge: Edge): boolean {
  const two = body.faces.filter(fc => fc.edges.some(faceEdge => faceEdge.isSame(edge)));
  if (two.length !== 2) {
    return false;
  }
  try {
    const mid = edge.pointAt(0.5);
    const [a, b] = two.map((fc) => {
      const normal = fc.normalAt(mid);

      return norm([normal.x, normal.y, normal.z]);
    });

    return Math.abs(dot(a, b)) > 0.9986;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------- meshing

/**
 * Bodies that are another body moved, turned or mirrored (a Move step, a
 * pattern's copies): their mesh is that body's, moved the same way - meshed
 * again, a fan's rotated casing took 3 s, and a pattern meshed every copy.
 * (The faces and edges come in the same order: the shape is the same.)
 */
// (The body it was moved from held weakly: a chain of moves mustn't keep every earlier body alive.)
const movedFrom = new WeakMap<Shape3D, { from: WeakRef<Shape3D>; m: Affine; flip: boolean }>();
function movedMesh(shape: Shape3D) {
  const mv = movedFrom.get(shape);
  const was = mv?.from.deref();
  const src = was && (meshCache.get(was) ?? drawMeshes.get(was));
  if (!mv || !src) {
    return null;
  }
  const { m, flip } = mv;
  const at = (a: Float32Array, normal: boolean) => {
    const out = new Float32Array(a.length);
    for (let i = 0; i < a.length; i += 3) {
      const [x, y, z] = [a[i], a[i + 1], a[i + 2]];
      for (let row = 0; row < 3; row++) {
        out[i + row] = m[row * 4] * x + m[row * 4 + 1] * y + m[row * 4 + 2] * z + (normal ? 0 : m[row * 4 + 3]);
      }
    }

    return out;
  };
  let triangles = src.indices;
  if (flip) {
    // Mirrored: each triangle the other way round, or it faces inward.
    triangles = new Uint32Array(src.indices);
    for (let i = 0; i < triangles.length; i += 3) {
      [triangles[i + 1], triangles[i + 2]] = [triangles[i + 2], triangles[i + 1]];
    }
  }

  return {
    m: { vertices: at(src.positions, false), normals: at(src.normals, true), triangles, faceGroups: src.faceGroups },
    e: { lines: at(src.edgePositions, false), edgeGroups: src.edgeGroups }
  };
}

/** The triangles and edge lines of a body, as the view shows them. */
function meshLines(shape: Shape3D) {
  const moved = movedMesh(shape);
  if (moved) {
    return moved;
  }
  // (About its size is enough for how fine to draw it: the exact box of a curved body takes up to a second.)
  const diag = sizeOf(shape);
  // (Never finer than 1/50 000 of its size: a 100 m arc at 0.1 mm is millions of triangles.)
  const tolerance = Math.max(Math.min(0.1, Math.max(0.001, diag * 0.0008)), diag * 2e-5);
  const angularTolerance = 0.25;
  const faceMesh = meshFaces(shape, tolerance, angularTolerance);
  const e = meshEdgeLines(shape, tolerance, angularTolerance);
  meshOff(shape);
  // A face made freeform is many patches, smooth across the lines between
  // them: those lines aren't edges to show or pick (drawn as nothing).
  const made = edgeSteps(shape);
  if (made && smoothSteps.size && e.edgeGroups.reduce((total, edgeGroup) => total + edgeGroup.count, 0) * 3 === e.lines.length) {
    const seams = seamEdges(shape);
    e.edgeGroups.forEach((edgeGroup, i) => {
      if (made[i]?.length !== 1 || !smoothSteps.has(made[i][0]) || seams[i]) {
        return;
      }
      for (let vertexIndex = 1; vertexIndex < edgeGroup.count; vertexIndex++) {
        for (let axis = 0; axis < 3; axis++) {
          e.lines[(edgeGroup.start + vertexIndex) * 3 + axis] = e.lines[edgeGroup.start * 3 + axis];
        }
      }
    });
  }

  return { m: faceMesh, e };
}

/**
 * For a drawing: the mesh with only what the drawing reads (the faces' and
 * edges' kinds) - the view's own when it has it. The model drawn without its
 * threads is bodies the view never showed: its full mesh took seconds more.
 */
const drawMeshes = new WeakMap<Shape3D, BodyMesh>();
function drawingMesh(id: string, shape: Shape3D): BodyMesh {
  const have = meshCache.get(shape) ?? drawMeshes.get(shape);
  if (have) {
    return { ...have, id, name: id };
  }
  const { m, e } = meshLines(shape);
  const mesh: BodyMesh = {
    id,
    name: id,
    key: meshKey++,
    positions: new Float32Array(m.vertices),
    normals: new Float32Array(m.normals),
    indices: new Uint32Array(m.triangles),
    faceGroups: m.faceGroups.map((faceGroup, i) => ({ start: faceGroup.start, count: faceGroup.count, face: i })),
    edgePositions: new Float32Array(e.lines),
    edgeGroups: e.edgeGroups.map((edgeGroup, i) => ({ start: edgeGroup.start, count: edgeGroup.count, edge: i })),
    faces: shape.faces.map(face => ({ type: face.geomType }) as FaceInfo),
    edges: shape.edges.map(edge => ({ type: edge.geomType }) as EdgeInfo),
    openEdges: []
  };
  drawMeshes.set(shape, mesh);

  return mesh;
}

function meshBody(id: string, name: string, shape: Shape3D): BodyMesh {
  const cached = meshCache.get(shape);
  if (cached) {
    return { ...cached, id, name };
  }
  const { m, e } = meshLines(shape);
  // Group order matches shape.faces / shape.edges order (verified); ids are hashes.
  const mesh: BodyMesh = {
    id,
    name,
    key: meshKey++,
    positions: new Float32Array(m.vertices),
    normals: new Float32Array(m.normals),
    indices: new Uint32Array(m.triangles),
    faceGroups: m.faceGroups.map((faceGroup, i) => ({ start: faceGroup.start, count: faceGroup.count, face: i })),
    edgePositions: new Float32Array(e.lines),
    edgeGroups: e.edgeGroups.map((edgeGroup, i) => ({ start: edgeGroup.start, count: edgeGroup.count, edge: i })),
    faces: shape.faces.map((face, i) => ({ ...faceInfoKept(face), step: faceSteps(shape)?.[i], curve: faceOrigins(shape)?.[i], ...(faceAliases(shape)?.[i] ? { was: faceAliases(shape)![i] } : {}) })),
    edges: shape.edges.map((e, i) => ({ ...edgeInfo(e), steps: edgeSteps(shape)?.[i], curves: edgeOrigins(shape)?.[i], ...(oldEdgeSteps(shape) ? { was: oldEdgeSteps(shape)![i] } : {}), ...(seamEdges(shape)[i] ? { seam: true } : {}) })),

    openEdges: openEdges(shape)
  };
  meshCache.set(shape, mesh);

  return mesh;
}

// ------------------------------------------------------------------- helpers

/** How many faces are next to nothing in area (leftovers of an edit, not real faces). */
function slivers(shape: Shape3D): number {
  const areas = shape.faces.map(face => measureArea(face));
  const total = areas.reduce((a, b) => a + b, 0);

  return areas.filter(a => a < Math.max(1e-9, total * 1e-7)).length;
}

/**
 * The bodies an edit may change: the ones it names - and, for a solid made
 * from a sketch or face that joins/cuts whatever it runs into, all of them.
 */
function touchedBodies(feature: Feature, ctx: Ctx, all = true): string[] {
  const named = new Set<string>();
  const walk = (value: unknown, key = ''): void => {
    if (Array.isArray(value)) {
      return value.forEach(item => walk(item, key));
    }
    if (value && typeof value === 'object') {
      for (const [key, x] of Object.entries(value as Record<string, unknown>)) {
        walk(x, key);
      }

      return;
    }
    if (typeof value === 'string' && (key === 'body' || key === 'bodies' || key === 'target' || key === 'tools')) {
      named.add(value);
    }
  };
  walk(feature);
  const mode = (feature as { mode?: string }).mode;
  if (all && (feature.type === 'extrude' || feature.type === 'revolve' || feature.type === 'sweep' || feature.type === 'loft') && mode && mode !== 'new') {
    for (const id of ctx.bodies.keys()) {
      named.add(id);
    }
  }

  return [...named].filter(id => ctx.bodies.has(id));
}

/** Does a flat shape in a plane through the axis reach both sides of it? */
function crossesAxis(face: Face, origin: Vec3, dir: Vec3): boolean {
  const normal = norm(face.normalAt().toTuple() as Vec3);
  if (Math.abs(dot(normal, dir)) > 1e-6) {
    return false;
  } // tilted to the axis: not this question
  const side = cross(dir, normal);
  let lo = 0, hi = 0;
  for (const e of face.edges) {
    for (const fraction of [0, 0.25, 0.5, 0.75, 1]) {
      const sideDistance = dot(sub(e.pointAt(fraction).toTuple() as Vec3, origin), side);
      lo = Math.min(lo, sideDistance);
      hi = Math.max(hi, sideDistance);
    }
  }
  const tol = Math.max(1e-6, (hi - lo) * 1e-6);

  return lo < -tol && hi > tol;
}

/**
 * A pattern's count, held to what a phone can build: a typo (3000 for 30)
 * stops at once with a message, not after minutes (and again each time the
 * project is opened).
 */
const MAX_COPIES = 1000;
function patternCount(count: number): void {
  if (!(count >= 1) || !Number.isFinite(count)) {
    throw new Error('The count must be 2 or more');
  }
  if (count > MAX_COPIES) {
    throw new Error(`${Math.round(count)} copies is too many - up to ${MAX_COPIES} at once`);
  }
}

/** Edits that change a solid in place (their results are checked). */
const GUARDED = new Set<string>(['extrude', 'revolve', 'sweep', 'loft', 'boolean', 'fillet', 'chamfer', 'shell', 'moveFace', 'scaleFace', 'replaceFace', 'deleteGeom', 'split', 'connect', 'hole']);
/** Edits that must not break a body into pieces (cuts and booleans may). */
const NO_SPLIT = new Set<string>(['fillet', 'chamfer', 'shell', 'moveFace', 'scaleFace', 'replaceFace', 'deleteGeom']);

/**
 * The result of an edit must be a solid like the one it changed: crumbs a
 * cut left behind are swept away, a hollow left as loose surfaces is made a
 * solid, an inside-out one is turned right - and anything still broken
 * (invalid, hair-thin faces, split by an edit that shouldn't split) makes the
 * step stop with a message instead of leaving a damaged body to build on.
 */
const EDGES_CLASH = 'That size is too big here: the @ run into each other or past a face (a wall thinner than two of them?) - try a smaller one';

function guardEdit(before: Shape3D | undefined, after: Shape3D, mayPart: boolean, mendTears = true): Shape3D | null {
  const oc = getOC();
  // A new body (made by this edit): held to being a good solid, like an edited one.
  const was = before ? subShapes(before, 'SOLID').length : Math.max(1, subShapes(after, 'SOLID').length);
  // Not a solid before (an imported mesh, a sheet): nothing to hold it to.
  if (!was) {
    return after;
  }
  // (Volumes here to a thousandth: they tell dust from a body and inside out from right way out. To a millionth
  // they took seconds on a curved body - on every step that changed it.)
  const about = (shape: Shape3D) => volumes.get(shape) ?? quickVolume(shape);
  const v0 = before ? Math.abs(about(before)) : 0;
  let solids = subShapes(after, 'SOLID');
  if (!solids.length) {
    // A hollow (outer skin + inner skin) left as loose skins: one solid with a void.
    const shells = subShapes(after, 'SHELL');
    if (!shells.length) {
      throw new Error('That edit would leave nothing solid');
    }
    const mk = new oc.BRepBuilderAPI_MakeSolid();
    for (const sh of shells) {
      mk.Add(sh);
    }
    const solid = mk.Solid();
    oc.BRepLib.OrientClosedSolid(solid);
    mk.delete();
    solids = [solid];
    after = cast(solid) as Shape3D;
  }
  // A lump inside out among the others: the cut went wrong.
  // (One solid: the body itself - its volume, worked out once.)
  // (Or a group holding that one solid and nothing else, as a cut gives back: the same volume, likely known already.)
  const one = solids.length === 1 && (after instanceof Solid || [...iterTopo(after.wrapped, 'face')].length === [...iterTopo(solids[0], 'face')].length);
  const signed = one ? [about(after)] : solids.map(solid => quickVolume(cast(solid) as Shape3D));
  if (solids.length > 1 && signed.some(volume => volume < 0) && signed.some(volume => volume > 0)) {
    throw new Error('That edit would damage the body - try a different value');
  }
  // Crumbs: lumps far smaller than the rest (left between coincident faces).
  const vols = signed.map(volume => Math.abs(volume));
  const total = vols.reduce((a, b) => a + b, 0);
  // All of it cut away but dust: no body left.
  if (before && total < v0 * 1e-6) {
    return null;
  }
  const keep = solids.filter((_, i) => vols[i] > total * 1e-5);
  if (!keep.length) {
    throw new Error('That edit would leave nothing solid');
  }
  if (keep.length < solids.length) {
    if (keep.length === 1) {
      after = cast(keep[0]) as Shape3D;
    } else {
      after = makeCompound(keep.map(shape => cast(shape))) as Shape3D;
    }
    solids = keep;
  }
  if (!mayPart && solids.length > was) {
    throw new Error('That would break the body into pieces - try a smaller value');
  }
  // Inside out (negative volume): turn it right - on a copy (its faces may be
  // shared with earlier steps' results, which must never change).
  if (about(after) < 0) {
    after = deepCopy(after);
    solids = subShapes(after, 'SOLID');
    for (const x of solids) {
      oc.BRepLib.OrientClosedSolid(x);
    }
    if (quickVolume(after) < 0) {
      throw new Error('That edit would turn the body inside out');
    }
  }
  // Something wrong with it: repaired if that can be done without changing
  // the shape (noted in History); else the step stops with the message.
  const fixOr = (message: string): Shape3D => {
    const repaired = repairShape(after, { maxSolids: mayPart ? undefined : Math.max(1, was) });
    if (!repaired) {
      throw new Error(message);
    }
    editNotes.push(`Repaired automatically: ${repaired.fixes.join(', ')}.`);

    return repaired.shape;
  };
  // Gaps it didn't have before (an edge with a face on one side only).
  if (openEdges(after).length > (before ? openEdges(before).length : 0)) {
    if (!mendTears) {
      throw new Error('That edit would tear the body open - try a smaller value, or another face');
    }

    return fixOr('That edit would tear the body open - try a smaller value, or another face');
  }
  const validBefore = before ? shapeValid(before) : true;
  if (validBefore && !shapeValid(after)) {
    return fixOr("That edit would damage the body (the faces don't meet up) - try a different value");
  }
  const thinBefore = before ? hairThin(before) : 0;
  if (hairThin(after) > thinBefore) {
    // Often just faces left split on one surface: merge them, then look again.
    let merged: Shape3D | null = null;
    try {
      merged = unify(after);
    } catch {
      merged = null;
    }
    if (merged && hairThin(merged) <= thinBefore && (!validBefore || shapeValid(merged))) {
      return merged;
    }

    return fixOr('That edit would leave hair-thin faces - try a slightly different value');
  }

  return after;
}

/**
 * An STL file as a body. OpenCascade's reader hands back the triangles loose
 * (a pile of faces, no two sharing an edge - replicad's importSTL wanted a
 * shell and threw on every file, the app's own STL exports too). Sewn here:
 * one closed skin is a solid, its flat triangles merged; anything else (open,
 * several lumps) stays loose faces for Repair to close. (The reader used to
 * hand back a shell, and this looked for one: with none to find, every STL
 * came in as loose faces - a block of 12 triangles too - and nothing could be
 * joined to it or cut from it until it was Repaired.)
 */
function readSTL(bytes: Uint8Array): Shape3D {
  const oc = getOC();
  // A binary file is known by its length: 84 bytes and 50 for each triangle
  // it says it has (one with too many isn't read at all). OpenCascade's reader
  // goes by its first 134 bytes instead - binary if one of them is no letter
  // of plain text - and took for text a file with a blank or plain heading
  // whose first triangle's numbers were all such bytes (round sizes and no
  // normal: a 10 mm cube out of a 3MF) - "couldn't be read". Its heading,
  // which nothing reads, is given such a byte.
  let file = bytes;
  if (bytes.length >= 134) {
    const said = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(80, true);
    if (84 + said * 50 === bytes.length) {
      if (said > MESH_MAX) {
        throw new TooBig(said);
      }
      file = bytes.slice();
      file[79] = 0xff;
    }
  }
  const name = `stl-${Math.random().toString(36).slice(2)}.stl`;
  oc.FS.writeFile(`/${name}`, file);
  const reader = new oc.StlAPI_Reader();
  const read = new oc.TopoDS_Shell();
  try {
    if (!reader.Read(read, name)) {
      throw new Error("This STL file couldn't be read");
    }
    const loose = cast(read) as Shape3D;
    // (Counted straight off the shape: replicad's iterTopo checks each one against
    // all before it - 6 of the 10 s ten thousand triangles took to come in.)
    let count = 0;
    const each = new oc.TopExp_Explorer(read, oc.TopAbs_ShapeEnum.TopAbs_FACE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
    for (; each.More(); each.Next()) {
      count++;
    }
    each.delete();
    if (count > MESH_MAX) {
      throw new TooBig(count);
    }
    if (count) {
      const size = sizeOf(loose);
      const sew = new oc.BRepBuilderAPI_Sewing(Math.max(1e-7, size * 1e-7), true, true, true, false);
      const progress = new oc.Message_ProgressRange();
      try {
        sew.Add(read);
        sew.Perform(progress);
        const shells = subShapes(cast(sew.SewedShape()) as Shape3D, 'SHELL');
        if (shells.length === 1 && sew.NbFreeEdges() === 0) {
          const mk = new oc.BRepBuilderAPI_MakeSolid();
          mk.Add(shells[0]);
          const made = cast(mk.Solid()) as Shape3D;
          mk.delete();
          // Flat triangles made one face each, as Repair leaves them. A file's
          // numbers are to seven digits, so a corner can be a hair off the
          // plane of the face it now belongs to, which the check calls damage
          // (a faceted ball came in "invalid"): its edges are given that room,
          // as Repair's first step does - or the triangles are kept as they are.
          let solid = unify(made, size);
          if (solid !== made && !shapeValid(solid)) {
            try {
              oc.BRepLib.BuildCurves3d(solid.wrapped);
              oc.BRepLib.SameParameter(solid.wrapped, size * 1e-7, true);
              oc.BRepLib.UpdateTolerances(solid.wrapped, true);
            } catch (err) {
              if (isFault(err)) {
                throw err;
              }
            }
            // (Looked at afresh: what a shape was found to be is remembered.)
            solid = cast(solid.wrapped) as Shape3D;
            if (!shapeValid(solid)) {
              solid = made;
            }
          }
          let volume = measureVolume(solid);
          if (volume < 0) {
            oc.BRepLib.OrientClosedSolid(solid.wrapped);
            volume = measureVolume(solid);
          }
          if (volume > 0 && !openEdges(solid).length) {
            // (Measured once: a body of a hundred thousand faces takes seconds to.)
            volumes.set(solid, volume);

            return solid;
          }
        }
      } catch (err) {
        if (isFault(err)) {
          throw err;
        }
        // fall through: loose faces
      } finally {
        sew.delete();
        progress.delete();
      }
    }

    return loose;
  } finally {
    oc.FS.unlink(`/${name}`);
    reader.delete();
    read.delete();
  }
}

/**
 * A mesh file as a body: its flat faces each one face, whichever way they face, and its round parts truly round
 * (see meshRound.ts). Null when the mesh cannot be read that way (open, tangled, nothing flat in it) - it then
 * comes in as the kernel reads it.
 */
function meshBodyOf(bytes: Uint8Array): { shape: Shape3D; made: number } | null {
  const all = stlTriangles(bytes);
  if (!all) {
    return null;
  }
  if (all.length / 9 > MESH_MAX) {
    throw new TooBig(all.length / 9);
  }
  // A file of several separate parts (a box and its lid): each read by itself, and together again as its solids -
  // a body each (see "import"). A part inside another (a hollow's inner skin) is not a part of its own: the old way.
  const parts = meshParts(all);
  if (!parts) {
    return null;
  }
  // Read first, all of it, which is quick; built only if it is worth building.
  const models = parts.map(part => meshModel(part));
  if (models.some(model => !model)) {
    return null;
  }
  // (A mesh with little flat in it - a figure, a scan, a bowl whose curves are cut into four-sided flats, two
  // triangles each: nearly a face a triangle, or a face to two. Building that face by face took as long again as
  // the kernel's own reader, for nothing - 11 s more on a bowl of 62,000 triangles, in one part or in four. Counted
  // after the round parts' strips are taken out, so a part that is mostly holes and bosses is not taken for one.)
  const count = all.length / 9;
  if (count > 5000 && models.reduce((total, model) => total + model!.faces.length, 0) > count * 0.4) {
    return null;
  }
  const made = parts.map((part, i) => meshPartBody(part, models[i]!));
  if (made.some(body => !body)) {
    return null;
  }
  if (made.length === 1) {
    return made[0];
  }

  return { shape: makeCompound(made.map(body => body!.shape.clone())) as unknown as Shape3D, made: made.reduce((total, body) => total + body!.made, 0) };
}

/** One part of a mesh, read (see meshModel), as a body: round parts stood in for and made round with a ring each. */
function meshPartBody(tris: Float64Array, model: MeshModel): { shape: Shape3D; made: number } | null {
  // Should any of the quick way not come out sound, the plain way: every strip a face, the round parts made round
  // one after another.
  const quick = model.rounds.length ? facesSolid(model.faces) : null;
  const rounded = quick && ringsOn(quick, model.rounds);
  if (rounded) {
    const more = model.rest.length ? roundMeshSolid(rounded, model.rest) : { shape: rounded, made: 0 };

    return { shape: more.shape, made: model.rounds.length + more.made };
  }
  const flat = model.rounds.length ? meshFlatFaces(tris) : model.faces;
  const plain = flat && facesSolid(flat);
  if (!plain) {
    return null;
  }
  const cyls = [...model.rounds.map(round => round.cy), ...model.rest];

  return cyls.length ? roundMeshSolid(plain, cyls) : { shape: plain, made: 0 };
}

/** Flat faces, each given by its outline and holes, sewn into one closed skin: a solid - or null if they do not close into one sound solid. */
function facesSolid(faces: MeshFace[]): Shape3D | null {
  const oc = getOC();
  const lo: Vec3 = [Infinity, Infinity, Infinity];
  const hi: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const face of faces) {
    for (const point of face.outer) {
      for (let axis = 0; axis < 3; axis++) {
        (lo[axis] = Math.min(lo[axis], point[axis])), (hi[axis] = Math.max(hi[axis], point[axis]));
      }
    }
  }
  const size = len(sub(hi, lo)) || 1;
  const sew = new oc.BRepBuilderAPI_Sewing(Math.max(1e-7, size * 1e-7), true, true, true, false);
  const progress = new oc.Message_ProgressRange();
  try {
    const wire = (ring: Vec3[]) => assembleWire(ring.map((point, i) => makeLine(point, ring[(i + 1) % ring.length])));
    for (const face of faces) {
      // (On its own plane, said outright: found again from the outline, a face with holes was "not flat".)
      const pln = new oc.gp_Pln(new oc.gp_Pnt(...face.outer[0]), new oc.gp_Dir(...face.n));
      const mk = new oc.BRepBuilderAPI_MakeFace(pln, wire(face.outer).wrapped, true);
      for (const hole of face.holes) {
        mk.Add(wire(hole).wrapped);
      }
      if (!mk.IsDone()) {
        return null;
      }
      sew.Add(mk.Face());
    }
    sew.Perform(progress);
    const shells = subShapes(cast(sew.SewedShape()) as Shape3D, 'SHELL');
    if (shells.length !== 1 || sew.NbFreeEdges() !== 0) {
      return null;
    }
    const mk = new oc.BRepBuilderAPI_MakeSolid();
    mk.Add(shells[0]);
    let solid = cast(mk.Solid()) as Shape3D;
    mk.delete();
    if (measureVolume(solid) < 0) {
      oc.BRepLib.OrientClosedSolid(solid.wrapped);
    }
    // (Straight edges cut where a neighbour's corner met them: each one edge again.)
    const tidy = unify(solid, size);
    if (shapeValid(tidy)) {
      solid = tidy;
    }
    const volume = measureVolume(solid);
    if (!(volume > 0) || openEdges(solid).length || !shapeValid(solid)) {
      return null;
    }
    volumes.set(solid, volume);

    return solid;
  } catch (err) {
    if (isFault(err)) {
      throw err;
    }

    return null;
  } finally {
    sew.delete();
    progress.delete();
  }
}

/**
 * The round parts of a mesh body that were stood in for (meshModel) made round: a ring from inside each stand-in
 * out to its true radius, cut from the body round a hole, joined to it round a boss - all the holes at once, all
 * the bosses at once. Null unless the body is then one sound solid whose volume changed by what lay between the
 * stand-ins and the round faces.
 */
function ringsOn(solid: Shape3D, rounds: MeshStandIn[]): Shape3D | null {
  const size = sizeOf(solid);
  let spare = 0;
  try {
    const tools = rounds.map((round) => {
      const cy = round.cy;
      const perpendicular = norm(cross(cy.a, cy.u));
      const at = (radius: number, ang: number, t: number): Vec3 => add(add(cy.c, scale(cy.a, t)), add(scale(cy.u, radius * Math.cos(ang)), scale(perpendicular, radius * Math.sin(ang))));
      // An end with nothing past it: a cut goes a hair past it. An end with the body past it: a join goes a hair in.
      const hair = Math.max(2e-3, (cy.r - round.inner) * 0.25);
      const rp = round.inner + (cy.r - round.inner) * 0.25;
      const angs = [0.25, 0.5, 0.75].map(fraction => cy.sweep * fraction);
      const ends: [number, number] = [...round.ends];
      [round.ends[0] - hair * 0.5, round.ends[1] + hair * 0.5].forEach((t, e) => {
        const inside = insideOf(solid, angs.map(ang => at(rp, ang, t)));
        if (!inside.every(x => x === !cy.concave)) {
          return;
        }
        ends[e] += e ? hair : -hair;
        // (The most that hair can take or add past the end, where the end is not as clean as a plate's face.)
        spare += ((cy.r * cy.r - round.inner * round.inner) * cy.sweep * hair) / 2;
      });
      const outline = makePolygon([at(round.inner, 0, ends[0]), at(cy.r, 0, ends[0]), at(cy.r, 0, ends[1]), at(round.inner, 0, ends[1])]);

      return revolution(outline, cy.c, cy.a, Math.min(360, (cy.sweep * 180) / Math.PI)) as Shape3D;
    });
    const holes = tools.filter((_, i) => rounds[i].cy.concave);
    const bosses = tools.filter((_, i) => !rounds[i].cy.concave);
    let out = solid;
    if (holes.length) {
      out = booleanWith('cut', out, holes, size);
    }
    if (bosses.length) {
      out = booleanWith('fuse', out, bosses, size);
    }
    const expect = rounds.reduce((sum, round) => sum + (round.cy.concave ? -round.volume : round.volume), 0);
    const most = rounds.reduce((sum, round) => sum + round.volume, 0);
    const change = measureVolume(out) - volumeOf(solid);
    if (Math.abs(change - expect) > Math.max(most * 0.01, size ** 3 * 1e-10) + spare) {
      return null;
    }
    if (subShapes(out, 'SOLID').length !== 1 || openEdges(out).length || !shapeValid(out)) {
      return null;
    }

    return out;
  } catch (err) {
    if (isFault(err)) {
      throw err;
    }

    return null;
  }
}

/**
 * A mesh's cylinders made truly round (see meshRound.ts for how they are found).
 *
 * The flat strips lie just inside their cylinder, touching it at the creases - a hair's breadth from it where the
 * mesh is cut fine (a 4 mm hole in 252 strips: 0.00015 mm), which is nothing the kernel can cut along. So the
 * strips are first buried or cut away with room to spare, then the round face is made in clean material:
 *  - a hole: a ring that covers its wall, a little either side, is joined on (the hole is now too small, its strips
 *    inside the body), then a ring from inside that out to the true radius is cut away;
 *  - a boss: the same ring is cut away (the boss is now too thin), then one out to the true radius joined on.
 * Rings, not whole cylinders: a boss with a bore keeps its bore, a post standing in a hole stays. A ring ends
 * exactly where its strips end, or a hair past that where it does no harm (a cut into the open, a join into the body).
 *
 * All of them in three passes; checked: the body is still one sound solid, and its volume changed by what lay
 * between the strips and the round faces, no more. If not, one at a time, each checked, those that fail left as
 * strips. Returns how many were made round.
 */
const SLOW_ROUNDS_AT_ONCE = 24;
/**
 * How many round parts are tried one at a time the slow way: each try is two or three cuts of the whole body, and
 * that takes as long as the body has faces - two seconds on one of two thousand. Eight on a small body, none
 * on one of over 1500 faces. (By the body's size, not by the clock: the same file gives the same faces on a phone as on a desktop.)
 */
const slowRounds = (faces: number) => Math.min(8, Math.floor(1500 / Math.max(1, faces)));
export function roundMeshSolid(solid: Shape3D, cyls: MeshCylinder[]): { shape: Shape3D; made: number } {
  const size = sizeOf(solid);
  interface Job {
    cy: MeshCylinder;
    /** The most a ring's hair past an end can take or add there (a round that ends on a cone's flats: a little of them). */
    spare: number;
    /** The ring that buries (a hole) or removes (a boss) the strips, and the one that makes the round face. */
    rough: () => Shape3D;
    fine: () => Shape3D;
  }
  const jobs: Job[] = [];
  // Which to try: all of them where they are few enough to do at once; else the biggest few, by how big the body
  // is (see slowRounds) - chosen before anything is asked of the kernel about them (it was asked what lies past
  // each end of a hundred and fifty rounds, of which it then tried one).
  // (Strips that end at different heights - on a slope, at another feature - are not tried: a ring their whole
  // length would add or take where there is nothing of them.)
  // (A body too big for even one try: none - at once is a try like any other.)
  if (!slowRounds(solid.faces.length)) {
    return { shape: solid, made: 0 };
  }
  const even = cyls.filter(cy => cy.even);
  const worth = (cy: MeshCylinder) => (cy.sweep > 2 * Math.PI - 1e-9 ? 1e6 : 1) * cy.r * cy.sweep * (cy.t1 - cy.t0);
  const atOnce = even.length <= SLOW_ROUNDS_AT_ONCE;
  const chosen = atOnce ? even : [...even].sort((x, y) => worth(y) - worth(x)).slice(0, slowRounds(solid.faces.length));
  for (const cy of chosen) {
    const half = cy.step / 2;
    const sag = cy.r * (1 - Math.cos(half));
    const room = Math.max(sag * 4, size * 2e-4);
    const inner = cy.r * Math.cos(half) - room;
    if (!(inner > 0) || !(sag > 0)) {
      continue;
    }
    const perpendicular = norm(cross(cy.a, cy.u));
    const at = (radius: number, ang: number, t: number): Vec3 => add(add(cy.c, scale(cy.a, t)), add(scale(cy.u, radius * Math.cos(ang)), scale(perpendicular, radius * Math.sin(ang))));
    // What is past each end, just inside the strips: the body, or nothing.
    const hair = Math.max(2e-3, sag);
    const rp = cy.r * Math.cos(half) - sag * 0.25;
    const angs = [0.25, 0.5, 0.75].map(fraction => cy.sweep * fraction);
    const past = [cy.t0 - hair * 0.5, cy.t1 + hair * 0.5].map(t => insideOf(solid, angs.map(ang => at(rp, ang, t))));
    const open = past.map(samples => samples.every(x => !x));
    const filled = past.map(samples => samples.every(x => x));
    const ring = (r0: number, r1: number, ends: [number, number]): Shape3D => {
      const outline = makePolygon([at(r0, 0, ends[0]), at(r1, 0, ends[0]), at(r1, 0, ends[1]), at(r0, 0, ends[1])]);

      return revolution(outline, cy.c, cy.a, Math.min(360, (cy.sweep * 180) / Math.PI)) as Shape3D;
    };
    const exact: [number, number] = [cy.t0, cy.t1];
    const intoOpen: [number, number] = [cy.t0 - (open[0] ? hair : 0), cy.t1 + (open[1] ? hair : 0)];
    const intoBody: [number, number] = [cy.t0 - (filled[0] ? hair : 0), cy.t1 + (filled[1] ? hair : 0)];
    const within = Math.max(0, inner - room);
    const spare = (((cy.r * cy.r - within * within) * cy.sweep * hair) / 2) * (cy.concave ? open : filled).filter(Boolean).length;
    jobs.push(
      cy.concave
        ? { cy, spare, rough: () => ring(inner, cy.r + room, exact), fine: () => ring(within, cy.r, intoOpen) }
        : { cy, spare, rough: () => ring(inner, cy.r + room, intoOpen), fine: () => ring(within, cy.r, intoBody) }
    );
  }
  const apply = (body: Shape3D, list: Job[]): Shape3D | null => {
    try {
      const holes = list.filter(j => j.cy.concave);
      const bosses = list.filter(j => !j.cy.concave);
      let out = body;
      if (holes.length) {
        out = booleanWith('fuse', out, holes.map(j => j.rough()), size);
      }
      out = booleanWith('cut', out, [...holes.map(j => j.fine()), ...bosses.map(j => j.rough())], size);
      if (bosses.length) {
        out = booleanWith('fuse', out, bosses.map(j => j.fine()), size);
      }
      const expect = list.reduce((total, j) => total + (j.cy.concave ? -j.cy.sliver : j.cy.sliver), 0);
      const most = list.reduce((total, j) => total + j.cy.sliver, 0);
      const change = measureVolume(out) - volumeOf(body);
      // (By what lay between the strips and the round faces - and no more than the hairs past the ends besides:
      // taken at holes, added at bosses.)
      const slack = Math.max(most * 0.03, size ** 3 * 1e-10);
      const took = holes.reduce((total, j) => total + j.spare, 0);
      const gave = bosses.reduce((total, j) => total + j.spare, 0);
      if (change - expect > slack + gave || expect - change > slack + took) {
        return null;
      }
      if (subShapes(out, 'SOLID').length !== 1 || openEdges(out).length || !shapeValid(out)) {
        return null;
      }

      return out;
    } catch (err) {
      if (isFault(err)) {
        throw err;
      }

      return null;
    }
  };
  if (!jobs.length) {
    return { shape: solid, made: 0 };
  }
  // All at once where there are few enough for that to be likely; else, and if that fails, one at a time - the
  // biggest first, and no more than a handful: each try is two or three cuts of the whole body, and a part with
  // lettering has a hundred and fifty rounds a fifth of a millimetre across (a guitar pick: 18 s, for 3 made).
  // (By count, not by the clock: the same file gives the same faces on a phone as on a desktop.)
  const all = atOnce ? apply(solid, jobs) : null;
  if (all) {
    return { shape: all, made: jobs.length };
  }
  jobs.sort((x, y) => worth(y.cy) - worth(x.cy));
  let body = solid;
  let made = 0;
  for (const job of jobs.slice(0, slowRounds(solid.faces.length))) {
    const next = apply(body, [job]);
    if (next) {
      (body = next), made++;
    }
  }

  return { shape: body, made };
}

/** A join or cut of a body with several tools at once (that do not overlap each other), faces on one surface merged. */
function booleanWith(op: 'cut' | 'fuse', a: Shape3D, list: Shape3D[], size: number): Shape3D {
  const oc = getOC();
  const algo = op === 'cut' ? new oc.BRepAlgoAPI_Cut() : new oc.BRepAlgoAPI_Fuse();
  const args = new oc.NCollection_List_TopoDS_Shape();
  const tools = new oc.NCollection_List_TopoDS_Shape();
  const progress = new oc.Message_ProgressRange();
  try {
    args.Append(a.wrapped);
    for (const b of list) {
      tools.Append(b.wrapped);
    }
    algo.SetArguments(args);
    algo.SetTools(tools);
    algo.SetFuzzyValue(Math.max(1e-7, size * 1e-6));
    algo.SetNonDestructive(true);
    algo.Build(progress);
    if (!algo.IsDone()) {
      throw new Error('boolean failed');
    }
    const made = algo.Shape();
    try {
      return unify(cast(withoutInternals(made)) as Shape3D, size);
    } finally {
      made.delete();
    }
  } finally {
    algo.delete();
    args.delete();
    tools.delete();
    progress.delete();
  }
}

export function errorText(err: unknown): string {
  // A step whose saved values are missing or the wrong kind (a damaged file, a
  // step from a newer version) trips the code itself: said in words, not "x is not iterable".
  if (err instanceof RangeError && /allocation|array length|Array buffer|too large/i.test(err.message)) {
    return 'This is too big to compute (a value far too big?)';
  }
  if (err instanceof TypeError || err instanceof RangeError || err instanceof ReferenceError) {
    console.error(err);

    return DAMAGED_TEXT;
  }
  if (err instanceof Error) {
    return err.message.trim() || 'The geometry kernel could not compute this (try other values)';
  }
  // OpenCascade gave up (a raw exception from the kernel): say so in words.
  if (typeof err === 'number' || String(err).includes('WebAssembly.Exception') || String(err) === '[object Object]') {
    return 'The geometry kernel could not compute this (try other values)';
  }

  return String(err);
}

/** What's wrong with a body, in words (for a repair that couldn't fix it). */
function whatsWrong(health: ReturnType<typeof healthOf>): string {
  const out: string[] = [];
  if (!health.solids) {
    out.push(health.shells ? "it's a surface that doesn't close" : 'it has no surface that encloses anything');
  }
  if (health.openEdges) {
    out.push(`${health.openEdges} open edge${health.openEdges > 1 ? 's' : ''} (a gap or a missing curved face)`);
  }
  if (!health.valid) {
    out.push("faces that don't meet up");
  }
  if (health.thin) {
    out.push(`${health.thin} hair-thin face${health.thin > 1 ? 's' : ''}`);
  }

  return out.join(', ') || "it doesn't enclose a volume";
}

/**
 * A step's big values (an imported model's megabytes) as a short fingerprint
 * in the text its key is made from, worked out once per value: hashing them
 * character by character on every rebuild cost 15 ms per 5 MB, every step of
 * a drag.
 */
const bigPrints = new Map<string, string>();
function shortBig(_k: string, value: unknown): unknown {
  if (typeof value !== 'string' || value.length < 20_000) {
    return value;
  }
  let print = bigPrints.get(value);
  if (!print) {
    print = `\u0000big:${hash53(value, 11)}.${hash53(value, 13)}.${value.length}`;
    if (bigPrints.size > 64) {
      bigPrints.clear();
    }
    bigPrints.set(value, print);
  }

  return print;
}

/** Key of the steps so far: the previous key and this step's JSON, hashed (two 53-bit hashes, no collisions in practice). */
function chainKey(prev: string, json: string): string {
  return `${hash53(prev + json, 1)}.${hash53(json, 7)}.${json.length}`;
}

/** cyrb53: a fast, well-mixed 53-bit string hash. */
function hash53(str: string, seed: number): string {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);

  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/**
 * An open surface filled down to a plane: the surface swept straight towards
 * the plane (along its normal) and past it, then everything beyond the plane
 * cut away - sides straight down, the bottom its outline projected onto the
 * plane. Parts of the surface beyond the plane are left out.
 */
function fillToPlane(sheet: Shape3D, plane: PlaneDef): Shape3D {
  const oc = getOC();
  if (subShapes(sheet, 'SOLID').length) {
    throw new Error('Fill to Plane fills an open surface - this body is already a solid');
  }
  if (!sheet.faces.length) {
    throw new Error('This body has no surface to fill from');
  }
  const normal = norm(plane.normal);
  // Which side the surface is on (most of it): the fill goes from there to the plane.
  const side = Math.sign(dot(sub(sheet.boundingBox.center as Vec3, plane.origin), normal));
  if (!side) {
    throw new Error('The surface lies across the plane - move the plane to one side of it');
  }
  // Seen from the plane, the surface must have some area: a plane side-on to it
  // (facing its edge) has nothing to fill.
  let facing = 0;
  let total = 0;
  // And which way it faces the plane, all over: both ways means it folds back
  // over itself as seen from the plane (the blocks under it overlap).
  let up = 0;
  let down = 0;
  for (const face of sheet.faces) {
    const a = measureArea(face);
    for (const [paramU, paramV] of [[0.5, 0.5], [0.15, 0.15], [0.85, 0.15], [0.15, 0.85], [0.85, 0.85]]) {
      let fn: Vec3;
      try {
        fn = norm(surfaceAt(face, paramU, paramV).n);
      } catch {
        continue;
      }
      const cosine = dot(fn, normal);
      facing += (Math.abs(cosine) * a) / 5;
      total += a / 5;
      if (cosine > 0.02) {
        up += a;
      } else if (cosine < -0.02) {
        down += a;
      }
    }
  }
  const folds = Math.min(up, down) > Math.max(up, down) * 1e-3;
  if (facing < total * 0.3) {
    throw new Error('The plane is side-on to the surface (facing its edge) - pick a plane the surface lies over, like the ground under it');
  }
  const bb = sheet.boundingBox;
  const reach = (Math.hypot(bb.width, bb.height, bb.depth) + Math.abs(dot(sub(bb.center as Vec3, plane.origin), normal))) * 2 + 1;
  const vector = new oc.gp_Vec(-side * normal[0] * reach, -side * normal[1] * reach, -side * normal[2] * reach);
  const mk = new oc.BRepPrimAPI_MakePrism(sheet.wrapped, vector, true, true);
  let swept: Shape3D;
  try {
    swept = cast(mk.Shape()) as Shape3D;
  } finally {
    mk.delete();
    vector.delete();
  }
  // The surface's side of the plane only - one cut for the whole sweep.
  const keep = halfSpace(side > 0 ? plane : { ...plane, normal: scale(normal, -1) as Vec3 }, swept);
  const cut = swept.intersect(keep);
  if (isEmpty(cut)) {
    throw new Error("The surface doesn't reach over the plane (seen along the plane's normal, there's nothing to fill)");
  }
  // One block per surface patch, side by side: the walls between them (each
  // shared by two blocks) go, and the outside is sewn into one solid.
  const blocks = subShapes(cut, 'SOLID').map(solid => cast(solid) as Shape3D);
  const seen: { f: Face; n: number }[] = [];
  for (const b of blocks) {
    for (const face of b.faces) {
      const had = seen.find(entry => entry.f.isSame(face));
      if (had) {
        had.n++;
      } else {
        seen.push({ f: face, n: 1 });
      }
    }
  }
  const outside = seen.filter(entry => entry.n === 1).map(entry => entry.f.wrapped);
  /** The blocks joined by unions (slow, but right where they overlap). */
  const joinAll = (): Shape3D => {
    try {
      // Each patch's sweep cut on its own (cutting them all at once mixes up the overlaps).
      const own = subShapes(swept, 'SOLID').map(solid => (cast(solid) as Shape3D).intersect(keep)).filter(shape => !isEmpty(shape));
      const j = own.reduce((a, b) => a.fuse(b));
      if (isEmpty(j)) {
        throw new Error('empty');
      }

      return j;
    } catch {
      throw new Error(facing < total * 0.6 ? 'The plane is too side-on to the surface - pick a plane the surface lies over, like the ground under it' : 'The surface folds back over itself as seen from the plane too much to fill - pick a plane it lies flatter over');
    }
  };
  const size = Math.hypot(bb.width, bb.height, bb.depth);
  const sw = new oc.BRepBuilderAPI_Sewing(size * 1e-7, true, true, true, false);
  let solid: Shape3D;
  try {
    for (const face of outside) {
      sw.Add(face);
    }
    sw.Perform(new oc.Message_ProgressRange());
    const shells = subShapes(cast(sw.SewedShape()) as Shape3D, 'SHELL');
    if (shells.length !== 1) {
      solid = joinAll();
    } else {
      const fix = new oc.ShapeFix_Solid();
      const made = fix.SolidFromShell(shells[0]);
      fix.delete();
      oc.BRepLib.OrientClosedSolid(oc.TopoDS.Solid(made));
      solid = cast(made) as Shape3D;
    }
  } finally {
    sw.delete();
  }
  // The surface folds back over itself as seen from the plane: the blocks
  // overlap instead of just touching - joined the slow, sure way instead.
  if (folds) {
    solid = joinAll();
  }
  // The bottom (one flat piece per patch) and flat sides become whole faces.
  try {
    solid = unify(solid);
  } catch {
    // keep it as sewn
  }
  const v0 = Math.abs(measureVolume(solid));
  if (!(v0 > reach ** 3 * 1e-12)) {
    throw new Error("There's nothing between the surface and the plane to fill");
  }
  const repaired = repairShape(solid);
  if (!repaired) {
    throw new Error("The fill didn't come out as a clean solid (the surface folds back over itself as seen from the plane?)");
  }
  if (repaired.fixes.length) {
    editNotes.push(`Repaired automatically: ${repaired.fixes.join(', ')}.`);
  }

  return repaired.shape;
}

/** A size that runs evenly from 1 at the path's start to `endScale` at its end (a sweep's end scale). */
function scaleLaw(spine: Wire, endScale: number) {
  const oc = getOC();
  const ad = new oc.BRepAdaptor_CompCurve(spine.wrapped, false);
  const t0 = ad.FirstParameter();
  const t1 = ad.LastParameter();
  ad.delete();
  const law = new oc.Law_Linear();
  law.Set(t0, 1, t1, endScale);

  return law;
}

/**
 * A fillet sized by its chord: the straight width across the round, from one
 * face to the other. Where the faces' outward normals are θ apart, a round of
 * radius r is 2·r·sin(θ/2) across, so r = width / (2·sin(θ/2)), worked out
 * along each edge (faces that meet at a changing angle get a changing radius).
 */
function chordFillet(body: Shape3D, edges: Edge[], c1: number, c2: number, flip: boolean): Shape3D {
  const oc = getOC();
  const builder = new oc.BRepFilletAPI_MakeFillet(body.wrapped, oc.ChFi3d_FilletShape.ChFi3d_Rational);
  try {
    for (const e of edges) {
      const two = body.faces.filter(fc => fc.edges.some(edge => edge.isSame(e)));
      if (two.length < 2) {
        throw new Error("That edge has a face on one side only: there's nothing to round across");
      }
      const samples = 9;
      const radii: number[] = [];
      for (let i = 0; i < samples; i++) {
        const fraction = i / (samples - 1);
        const n1 = normalOnEdge(two[0], e, fraction) ?? norm(two[0].normalAt(e.pointAt(fraction)).toTuple() as Vec3);
        const n2 = normalOnEdge(two[1], e, fraction) ?? norm(two[1].normalAt(e.pointAt(fraction)).toTuple() as Vec3);
        const half = len(sub(n1, n2)) / 2; // sin(θ/2)
        if (half < 1e-3) {
          throw new Error("The faces meet almost flat there, so a chord width can't size the round - switch Size to Radius");
        }
        const scale = flip ? c2 + (c1 - c2) * fraction : c1 + (c2 - c1) * fraction;
        radii.push(scale / (2 * half));
      }
      const even = radii.every((radius, i) => Math.abs(radius - (radii[0] + ((radii[samples - 1] - radii[0]) * i) / (samples - 1))) < 1e-7 * Math.max(1, radii[0]));
      if (even && Math.abs(radii[0] - radii[samples - 1]) < 1e-9) {
        builder.Add(radii[0], e.wrapped);
      } else if (even) {
        builder.Add(radii[0], radii[samples - 1], e.wrapped);
      } else {
        const table = new oc.NCollection_Array1_gp_Pnt2d(1, samples);
        radii.forEach((radius, i) => {
          const q = new oc.gp_Pnt2d(i / (samples - 1), radius);
          table.SetValue(i + 1, q);
          q.delete();
        });
        builder.Add(table, e.wrapped);
        table.delete();
      }
    }

    return cast(builder.Shape()) as Shape3D;
  } finally {
    builder.delete();
  }
}

/**
 * How much of a path (as a share of its length) runs across `facing` - in the
 * plane of a profile that faces that way: a profile held facing the same way
 * has no thickness along those parts.
 */
function runsAcross(spine: Wire, facing: Vec3): number {
  let total = 0;
  let across = 0;
  for (const e of spine.edges) {
    const count = e.length as number;
    const samples = e.geomType === 'LINE' ? 1 : 32;
    for (let i = 0; i < samples; i++) {
      const t = norm(e.tangentAt((i + 0.5) / samples).toTuple() as Vec3);
      if (Math.abs(dot(t, facing)) < 0.005) {
        across += count / samples;
      }
    }
    total += count;
  }

  return total > 0 ? across / total : 0;
}

/** Does a path have a sharp corner (two of its edges meeting at an angle)? */
function sharpCorners(spine: Wire): boolean {
  const edges = spine.edges;
  const size = edges.reduce((sum, e) => sum + (e.length as number), 0) || 1;
  const ends = edges.flatMap(e => [0, 1].map(end => ({ e, p: e.pointAt(end).toTuple() as Vec3, t: norm(e.tangentAt(end).toTuple() as Vec3) })));
  for (let i = 0; i < ends.length; i++) {
    for (let j = i + 1; j < ends.length; j++) {
      if (ends[i].e === ends[j].e || dist(ends[i].p, ends[j].p) > size * 1e-7) {
        continue;
      }
      // (The same line through the point, whichever way each edge runs: within about two degrees.)
      if (Math.abs(dot(ends[i].t, ends[j].t)) < 0.9994) {
        return true;
      }
    }
  }

  return false;
}

/** A path that runs straight from its start to its end: its ends (else null). */
function straightRun(spine: Wire): [Vec3, Vec3] | null {
  const oc = getOC();
  const ad = new oc.BRepAdaptor_CompCurve(spine.wrapped, true);
  const a = new oc.gp_Pnt();
  const b = new oc.gp_Pnt();
  try {
    ad.D0(ad.FirstParameter(), a);
    ad.D0(ad.LastParameter(), b);
    const start: Vec3 = [a.X(), a.Y(), a.Z()];
    const run = sub([b.X(), b.Y(), b.Z()], start);
    const length = len(run);
    if (length < 1e-9 || spine.edges.some(e => e.geomType !== 'LINE')) {
      return null;
    }
    const direction = norm(run);
    for (const e of spine.edges) {
      for (const t of [0, 1]) {
        const q = sub(e.pointAt(t).toTuple() as Vec3, start);
        if (len(cross(q, direction)) > length * 1e-9) {
          return null;
        }
      }
    }

    return [start, add(start, run)];
  } finally {
    b.delete();
    a.delete();
    ad.delete();
  }
}

/** Every point of the wire as far from the path's start, in the plane square to the path there (a circle round it). */
function roundAboutPath(wire: Wire, spine: Wire): boolean {
  const oc = getOC();
  const ad = new oc.BRepAdaptor_CompCurve(spine.wrapped, true);
  const point = new oc.gp_Pnt();
  const tangent = new oc.gp_Vec();
  try {
    ad.D1(ad.FirstParameter(), point, tangent);
    const origin: Vec3 = [point.X(), point.Y(), point.Z()];
    const t = norm([tangent.X(), tangent.Y(), tangent.Z()]);
    let radius = -1;
    const tol = Math.max(1e-9, len(sub(...(wire.boundingBox.bounds as [Vec3, Vec3]))) * 1e-7);
    for (const e of wire.edges) {
      for (let i = 0; i <= 8; i++) {
        const q = sub(e.pointAt(i / 8).toTuple() as Vec3, origin);
        if (Math.abs(dot(q, t)) > tol) {
          return false;
        }
        if (radius < 0) {
          radius = len(q);
        } else if (Math.abs(len(q) - radius) > tol) {
          return false;
        }
      }
    }

    return radius > tol;
  } finally {
    tangent.delete();
    point.delete();
    ad.delete();
  }
}

/**
 * A curve wound round a sweep's path that turns `deg` degrees from start to
 * end, evenly by length, `reach` out from the path: a sweep that keeps the
 * profile pointing at it twists. It starts from the path's own frame that
 * doesn't spin (rotation minimizing, by double reflection), so a twist of 0
 * would be the plain sweep.
 */
function twistGuide(spine: Wire, deg: number, reach: number): Wire {
  const oc = getOC();
  const ad = new oc.BRepAdaptor_CompCurve(spine.wrapped, true);
  const u0 = ad.FirstParameter();
  const u1 = ad.LastParameter();
  const samples = Math.min(600, 64 + Math.ceil((Math.abs(deg) / 360) * 32));
  const pts: Vec3[] = [];
  for (let i = 0; i <= samples; i++) {
    const curvePoint = ad.Value(u0 + ((u1 - u0) * i) / samples);
    pts.push([curvePoint.X(), curvePoint.Y(), curvePoint.Z()]);
    curvePoint.delete();
  }
  ad.delete();
  const tan = pts.map((_, i) => norm(sub(pts[Math.min(samples, i + 1)], pts[Math.max(0, i - 1)])));
  // Any square-on direction to start with.
  const t0 = tan[0];
  let radial = norm(cross(t0, Math.abs(t0[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]));
  const along = [0];
  for (let i = 1; i <= samples; i++) {
    along.push(along[i - 1] + len(sub(pts[i], pts[i - 1])));
  }
  const total = along[samples] || 1;
  const out: Vec3[] = [];
  for (let i = 0; i <= samples; i++) {
    if (i > 0) {
      const v1 = sub(pts[i], pts[i - 1]);
      const c1 = dot(v1, v1);
      if (c1 > 1e-18) {
        const rL = sub(radial, scale(v1, (2 / c1) * dot(v1, radial)));
        const tL = sub(tan[i - 1], scale(v1, (2 / c1) * dot(v1, tan[i - 1])));
        const v2 = sub(tan[i], tL);
        const c2 = dot(v2, v2);
        radial = norm(c2 > 1e-18 ? sub(rL, scale(v2, (2 / c2) * dot(v2, rL))) : rL);
      }
    }
    const a = ((deg * Math.PI) / 180) * (along[i] / total);
    const b = cross(tan[i], radial);
    out.push(add(pts[i], scale(add(scale(radial, Math.cos(a)), scale(b, Math.sin(a))), reach)));
  }

  return assembleWire([makeBSplineApproximation(out, { tolerance: reach * 1e-5, degMax: 5, degMin: 3 })]);
}

/**
 * A loft carried along a spine: the guide curve, or (a closed loop with no
 * guide) a smooth closed curve through the profiles' middles in the order
 * they were picked. Each profile sits where it is drawn; the body passes
 * through them in their order along the spine.
 */
function loftAlong(wires: Wire[], guide: Wire | null, closed: boolean): Shape3D {
  const oc = getOC();
  const mid = (wire: Wire): Vec3 => {
    const [lo, hi] = wire.boundingBox.bounds as [Vec3, Vec3];

    return scale(add(lo, hi), 0.5);
  };
  let spine = guide;
  let order = wires;
  if (!spine) {
    // A closed curve through the middles (Catmull-Rom: through each one, smooth all round).
    const centers = wires.map(mid);
    const count = centers.length;
    const pts: Vec3[] = [];
    const steps = 24;
    for (let i = 0; i < count; i++) {
      const [p0, p1, p2, p3] = [centers[(i - 1 + count) % count], centers[i], centers[(i + 1) % count], centers[(i + 2) % count]];
      for (let step = 0; step < steps; step++) {
        const t = step / steps;
        const t2 = t * t;
        const t3 = t2 * t;
        const weights = [-t3 + 2 * t2 - t, 3 * t3 - 5 * t2 + 2, -3 * t3 + 4 * t2 + t, t3 - t2].map(x => x / 2);
        pts.push(add(add(scale(p0, weights[0]), scale(p1, weights[1])), add(scale(p2, weights[2]), scale(p3, weights[3]))));
      }
    }
    pts.push(pts[0]);
    const size = Math.max(...centers.map(point => len(sub(point, centers[0]))), 1);
    spine = assembleWire([makeBSplineApproximation(pts, { tolerance: size * 1e-5, degMax: 5, degMin: 3 })]);
  } else {
    // Along a guide: in the order they lie along it.
    const ad = new oc.BRepAdaptor_CompCurve(spine.wrapped, true);
    const u0 = ad.FirstParameter();
    const u1 = ad.LastParameter();
    const samples: Vec3[] = [];
    for (let i = 0; i <= 200; i++) {
      const curvePoint = ad.Value(u0 + ((u1 - u0) * i) / 200);
      samples.push([curvePoint.X(), curvePoint.Y(), curvePoint.Z()]);
      curvePoint.delete();
    }
    ad.delete();
    const at = (wire: Wire) => {
      const middle = mid(wire);
      let best = 0;
      samples.forEach((sample, i) => len(sub(sample, middle)) < len(sub(samples[best], middle)) && (best = i));

      return best;
    };
    order = [...wires].sort((a, b) => at(a) - at(b));
  }
  const builder = new oc.BRepOffsetAPI_MakePipeShell(spine.wrapped);
  try {
    builder.SetMode(false);
    for (const wire of order) {
      builder.Add(wire.wrapped, false, false);
    }
    if (closed && guide) {
      builder.Add(order[0].wrapped, false, false);
    }
    builder.Build(new oc.Message_ProgressRange());
    if (!builder.IsDone()) {
      throw new Error('no shape');
    }
    builder.MakeSolid();
    const shape = cast(builder.Shape());
    if (!isShape3D(shape)) {
      throw new Error('no solid');
    }

    return shape;
  } catch {
    throw new Error(guide ? "The profiles can't be carried along that guide - each one needs to sit across it" : "These profiles can't be joined into a closed loop");
  } finally {
    builder.delete();
  }
}

/**
 * Smooth (G2) fillets: the blend's bend eases in from nothing at both faces
 * (no line in reflections where it starts), unlike a circular round whose
 * bend starts all at once. Its cross-section is a degree-5 Bezier whose first
 * and last three control points lie in the faces, so it leaves each face flat
 * (curvature 0) and tangent. It starts where a round of the same radius would.
 * Made for straight edges between flat faces (a prism of the corner, cut away
 * or, in an inside corner, added) and full circular edges between a flat face
 * and a cylinder (the same section spun round the axis).
 */
function g2Fillet(body: Shape3D, edges: Edge[], radius: number): Shape3D {
  return blendFillet(body, edges, radius, true);
}

/**
 * Rounds built from their own cross-section (see g2Fillet): `smooth`, the G2
 * Bezier; otherwise a true circular arc. Made with booleans, the round trims
 * whatever it runs into: a round too big for the face beside it cuts on
 * through that face's far edge, still exactly round (overflow, keep surface).
 */
function blendFillet(body: Shape3D, edges: Edge[], radius: number, smooth: boolean): Shape3D {
  const tuple = (vector: { toTuple(): number[] }) => vector.toTuple() as Vec3;
  const made: { tool: Shape3D; convex: boolean; along: Vec3 | null }[] = [];
  for (const e of edges) {
    const two = body.faces.filter(fc => fc.edges.some(edge => edge.isSame(e)));
    if (two.length < 2) {
      throw new Error("That edge has a face on one side only: there's nothing to round across");
    }
    const [fa, fb] = two;
    const kinds = [fa.geomType, fb.geomType];
    // A point on the edge, the edge's direction there, and each face's way in from it.
    let at: Vec3;
    let t: Vec3;
    let length = 0;
    let axis: { c: Vec3; dir: Vec3 } | null = null;
    if (e.geomType === 'LINE' && kinds.every(kind => kind === 'PLANE')) {
      const a = tuple(e.startPoint);
      const b = tuple(e.endPoint);
      length = len(sub(b, a));
      t = norm(sub(b, a));
      at = a;
    } else if (e.geomType === 'CIRCLE' && kinds.includes('PLANE') && kinds.includes('CYLINDRE') && len(sub(tuple(e.startPoint), tuple(e.endPoint))) < 1e-7) {
      const [p0, p1, p2] = [0, 1 / 3, 2 / 3].map(fraction => tuple(e.pointAt(fraction)));
      const normal = norm(cross(sub(p1, p0), sub(p2, p0)));
      // The circle's centre: equally far from all three points.
      const ab = sub(p1, p0);
      const ac = sub(p2, p0);
      const abXac = cross(ab, ac);
      const center = add(p0, scale(add(scale(cross(abXac, ab), dot(ac, ac)), scale(cross(ac, abXac), dot(ab, ab))), 1 / (2 * dot(abXac, abXac))));
      axis = { c: center, dir: normal };
      at = p0;
      t = norm(cross(normal, sub(p0, center)));
    } else {
      throw new Error(smooth ? 'Smooth (G2) works on straight edges between flat faces and on the round edges of cylinders - set Blend to Round for this edge' : 'unsupported edge');
    }
    const probe = Math.max(1e-4, radius * 1e-3);
    const inward = (face: Face): Vec3 => {
      const nrm = norm(tuple(face.normalAt(at)));
      let across = norm(cross(nrm, t));
      const q = makeVertex(add(at, scale(across, probe)));
      if (measureDistanceBetween(face, q) > probe * 0.5) {
        across = scale(across, -1);
      }
      q.delete();

      return across;
    };
    const u1 = inward(fa);
    const u2 = inward(fb);
    const n1 = norm(tuple(fa.normalAt(at)));
    const n2 = norm(tuple(fb.normalAt(at)));
    const convex = dot(n1, u2) < 0;
    const cosA = Math.max(-1, Math.min(1, dot(u1, u2)));
    const phi = Math.acos(cosA);
    if (phi > Math.PI - 1e-3) {
      throw new Error("The faces meet almost flat there: there's no corner to blend");
    }
    const setback = radius / Math.tan(phi / 2);
    // The corner's section, pushed past the faces on the side away from the blend (no faces lying on faces).
    const back = convex ? 1 : -1;
    const ext = axis ? 0 : Math.max(setback, length * 0.02);
    const corner = sub(at, scale(t, ext));
    const pointA = add(corner, scale(u1, setback));
    const pointB = add(corner, scale(u2, setback));
    // The round's middle: on the bisector, a radius short of its centre.
    const bis = norm(add(u1, u2));
    const curve = smooth
      ? makeBezierCurve([pointA, add(corner, scale(u1, 0.7 * setback)), add(corner, scale(u1, 0.4 * setback)), add(corner, scale(u2, 0.4 * setback)), add(corner, scale(u2, 0.7 * setback)), pointB])
      : makeThreePointArc(pointA, add(corner, scale(bis, radius / Math.sin(phi / 2) - radius)), pointB);
    const outB = add(pointB, scale(n2, back * setback));
    const outO = add(corner, scale(add(n1, n2), back * setback));
    const outA = add(pointA, scale(n1, back * setback));
    const wire = assembleWire([curve, makeLine(pointB, outB), makeLine(outB, outO), makeLine(outO, outA), makeLine(outA, pointA)]);
    const section = makeFace(wire);
    const tool = (axis ? revolution(section, axis.c, axis.dir, 360) : basicFaceExtrusion(section, new Vector(scale(t, length + 2 * ext)))) as Shape3D;
    made.push({ tool, convex, along: axis ? null : t });
  }
  // Two rounds side by side that run into each other along their length (both
  // edges of a block narrower than the two of them): that isn't a round that
  // overflows a face, it doesn't fit. (Rounds meeting at a corner are fine.)
  for (let i = 0; i < made.length; i++) {
    for (let j = i + 1; j < made.length; j++) {
      const [a, b] = [made[i], made[j]];
      if (!a.along || !b.along || Math.abs(dot(a.along, b.along)) < 0.999) {
        continue;
      }
      const both = a.tool.intersect(b.tool).intersect(body) as Shape3D;
      if (measureVolume(both) > 1e-6 * Math.pow(radius, 3)) {
        throw new Error('Those rounds run into each other - make the radius smaller');
      }
    }
  }
  let out = body;
  for (const tool of made) {
    out = (tool.convex ? out.cut(tool.tool) : out.fuse(tool.tool)) as Shape3D;
  }

  return out;
}

/**
 * Setback corners: where three or more of the rounded edges meet, the rounds
 * stop `s` from the corner and one smooth patch joins them (it meets every
 * face round it tangentially), instead of the rolling ball's corner. Made by
 * cutting a ball of radius s out of the rounded corner and filling the hole.
 */
function setbackCorners(body: Shape3D, edges: Edge[], setback: number, radius: number): Shape3D {
  const oc = getOC();
  const tuple = (vector: { toTuple(): number[] }) => vector.toTuple() as Vec3;
  // The corners: points where three or more of the edges end.
  const ends = edges.flatMap(e => [tuple(e.startPoint), tuple(e.endPoint)]);
  const tol = 1e-6 * (1 + Math.max(...ends.map(end => len(end))));
  const corners: Vec3[] = [];
  for (const end of ends) {
    if (!corners.some(corner => len(sub(corner, end)) < tol) && ends.filter(q => len(sub(q, end)) < tol).length >= 3) {
      corners.push(end);
    }
  }
  if (!corners.length) {
    throw new Error('Setback joins corners where three or more rounded edges meet - pick all the edges round a corner');
  }
  if (setback < radius * 1.8) {
    throw new Error(`The setback needs to be at least ${Math.ceil(radius * 1.8 * 100) / 100} for this radius (it must reach past the rounds' own corner)`);
  }
  for (const e of edges) {
    const at = corners.filter(corner => len(sub(corner, tuple(e.startPoint))) < tol || len(sub(corner, tuple(e.endPoint))) < tol).length;
    if (at && len(sub(tuple(e.endPoint), tuple(e.startPoint))) < setback * at * 1.05) {
      throw new Error('The setback is longer than an edge it runs along - make it smaller');
    }
  }
  let out = body;
  for (const corner of corners) {
    const ball = makeSphere(setback).translate(corner);
    const cut = out.cut(ball) as Shape3D;
    const near = (fc: Face) => fc.geomType === 'SPHERE' && Math.abs(len(sub(tuple(fc.center), corner)) - setback) < setback * 0.5 + tol;
    const hole = cut.faces.filter(near);
    const keep = cut.faces.filter(fc => !near(fc));
    if (!hole.length) {
      throw new Error('The setback missed the corner');
    }
    // The hole's rim, edge after edge, each held smooth to the face beside it.
    const rim = hole.flatMap(fc => fc.edges).filter(e => e.geomType !== 'LINE' || len(sub(tuple(e.startPoint), tuple(e.endPoint))) > tol);
    const fill = new oc.BRepOffsetAPI_MakeFilling(3, 15, 2, false, 1e-5, 1e-4, 0.01, 0.1, 8, 9);
    try {
      for (const e of rim) {
        const beside = keep.find(fc => fc.edges.some(edge => edge.isSame(e)));
        if (beside) {
          fill.Add(e.wrapped, beside.wrapped, oc.GeomAbs_Shape.GeomAbs_G1, true);
        } else {
          fill.Add(e.wrapped, oc.GeomAbs_Shape.GeomAbs_C0, true);
        }
      }
      fill.Build(new oc.Message_ProgressRange());
      if (!fill.IsDone()) {
        throw new Error('no patch');
      }
      const patch = cast(fill.Shape()) as AnyShape;
      const patchFaces = 'faces' in patch ? (patch as unknown as { faces: Face[] }).faces : [patch as unknown as Face];
      const made = makeSolid([...keep, ...patchFaces]);
      if (openEdges(made).length > 0 || !shapeValid(made)) {
        throw new Error('leaky');
      }
      out = made;
    } catch {
      throw new Error("The corner patch didn't fit - try a different setback");
    } finally {
      fill.delete();
    }
  }

  return out;
}
