// The geometry kernel. This (with sketchGeom.ts) is the ONLY code that knows
// about OpenCascade / replicad; worker.ts exposes it to the UI via protocol.ts.
//
// replicad gotchas, learned the hard way:
//  - makeCompound(), translate(), rotate(), mirror(), scale() DELETE their input.
//    Shapes here live on in the feature cache, so always clone first.

import {
  exportSTEP,
  getOC,
  importSTEP,
  makeCompound,
  makeLine,
  cast,
  makePolygon,
  measureArea,
  ProjectionCamera,
  revolution,
  assembleWire,
  type AnyShape,
  type Edge,
  type Face,
  type Shape3D
} from 'replicad';
import { fillEdgeKey } from '../doc/types';
import { applyFreeformEdits } from '../doc/freeformEdits';
import { add, cross, dist, dot, len, norm, scale, sub, xDirFor } from '../geom';
import { closestOnEntity } from '../sketch/regions';
import { holeFromLines } from '../doc/holeSizes';
import { deepCopy, openEdges, shapeValid, subShapes } from './health';
import { healthOf, isHealthy, repairShape } from './repair';
import { meshFlatFaces, meshModel, meshParts, stlTriangles, type MeshModel, type MeshCylinder, type MeshFace, type MeshStandIn } from './meshRound';
import { faceMiddle, holeCutter, holeFault, roundCentre } from './hole';
import { threadDepth } from './threads';
import {
  cylinderOf,
  editNotes,
  sameSizesAgain,
  looseBox,
  planeOf,
  sizeOf,
  unify
} from './faceEdit';
import { edgeOrigins, edgeSteps, faceAliases, faceOrigins, faceSteps, inheritTags, movedTags, oldEdgeSteps, seamEdges, setOrigins, tagBody, type OriginOf } from './provenance';
import { binarySTL, meshEdgeLines, meshFaces, meshOff, type FaceMesh } from './meshing';
import { measureArea as trueArea, measureVolume, surfaceAt, volumeProperties } from './ocFree';
import { useReleases } from './release';
import { useSafeBooleans, withoutInternals } from './safeBooleans';
import { anchorOf, freeformFaces, meshViews, viewEdge } from './viewLines';
import { imprint, onFace as linesOnFace, seenFrom, wrapOnto } from './wrap';
import { MESH_MAX, TooBig } from './protocol';
import { isFault, blame, KernelFault, crashed } from './faults';
import { rebuild } from './rebuildState';
import { DAMAGED_TEXT, MAX_REACH, damaged } from './damaged';
import { baseId, bodyList, bodyNames, isEmpty, need, staysClosed, wholeOf } from './bodies';
import { edgeInfo, faceInfo, resolveAxis, resolveEdge, resolveFace } from './references';
import { AFFINE_ID, affineDet, affineInverse, affineThen, shapeThrough } from './affine';
import { fuzzyBoolean, halfSpace, insideOf, volumeOf, volumes } from './booleans';
import { pathWire, sourceFaces } from './sources';
import { EDGES_CLASH, guardEdit } from './editGuard';
import { freeformShape } from './freeformShape';
import { applyConnect } from './steps/connect';
import { applyDeleteGeom, applyFaceFreeform, applyMoveFace, applyReplaceFace, scaleFace } from './steps/directEdit';
import { applyExtrude } from './steps/extrude';
import { WALLS_CLASH, applyShell } from './steps/shell';
import { applyThread, threadTarget } from './steps/thread';
import { applyBoolean } from './steps/boolean';
import { applySketch, sketchWas } from './steps/sketch';
import { applyRevolve } from './steps/revolve';
import { applySweep } from './steps/sweep';
import { applyLoft } from './steps/loft';
import { applyFilletOrChamfer } from './steps/fillet';
import { movedFrom, transform } from './steps/transform';
import type {
  EdgeRef,
  Feature,
  HoleFeature,
  ImportFeature,
  PathRef,
  PlaneDef,
  RepairFeature,
  SketchEntity,
  SplitFeature,
  Vec3
} from '../doc/types';
import type { BodyHealth, BodyMesh, BodyProps, ProjectedView, ViewBody, ViewEdge, ViewSpec, EdgeInfo, ExportFormat, FaceInfo, FeatureError, RegenResult } from './protocol';
import type { Ctx } from './types';

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

/** A shell in pieces: what was cut into the opened face hung from that face alone. */
const SHELL_LOOSE = 'Opening this face would leave what is cut into it (a pocket, a blind hole) standing loose from the rest - open another face';

// ------------------------------------------------------------ feature helpers



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


// ----------------------------------------------------- geometric references

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



// ------------------------------------------------------------------- meshing

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


/** Edits that change a solid in place (their results are checked). */
const GUARDED = new Set<string>(['extrude', 'revolve', 'sweep', 'loft', 'boolean', 'fillet', 'chamfer', 'shell', 'moveFace', 'scaleFace', 'replaceFace', 'deleteGeom', 'split', 'connect', 'hole']);
/** Edits that must not break a body into pieces (cuts and booleans may). */
const NO_SPLIT = new Set<string>(['fillet', 'chamfer', 'shell', 'moveFace', 'scaleFace', 'replaceFace', 'deleteGeom']);

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

