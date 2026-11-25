// The geometry kernel. This (with sketchGeom.ts) is the ONLY code that knows
// about OpenCascade / replicad; worker.ts exposes it to the UI via protocol.ts.
//
// replicad gotchas, learned the hard way:
//  - makeCompound(), translate(), rotate(), mirror(), scale() DELETE their input.
//    Shapes here live on in the feature cache, so always clone first.

import {
  exportSTEP,
  type Face,
  type Shape3D
} from 'replicad';
import { applyFreeformEdits } from '../doc/freeformEdits';
import { add, dot, norm, scale, xDirFor } from '../geom';
import { deepCopy, openEdges, subShapes } from './health';
import { healthOf, isHealthy } from './repair';
import {
  editNotes,
  sameSizesAgain,
  looseBox,
  sizeOf
} from './faceEdit';
import { edgeOrigins, edgeSteps, faceAliases, faceOrigins, faceSteps, inheritTags, movedTags, oldEdgeSteps, seamEdges, setOrigins, tagBody, type OriginOf } from './provenance';
import { binarySTL, meshEdgeLines, meshFaces, meshOff, type FaceMesh } from './meshing';
import { measureArea as trueArea, volumeProperties } from './ocFree';
import { useReleases } from './release';
import { useSafeBooleans } from './safeBooleans';
import { imprint, onFace as linesOnFace, seenFrom, wrapOnto } from './wrap';
import { isFault, blame, KernelFault, crashed, errorText } from './faults';
import { rebuild } from './rebuildState';
import { DAMAGED_TEXT, MAX_REACH, damaged } from './damaged';
import { baseId, bodyList, bodyNames, need, staysClosed, wholeOf, touchedBodies } from './bodies';
import { edgeInfo, faceInfo, resolveEdge, resolveFace } from './references';
import { AFFINE_ID, affineDet, affineInverse, affineThen, shapeThrough } from './affine';
import { volumes } from './booleans';
import { sourceFaces } from './sources';
import { EDGES_CLASH, guardEdit } from './editGuard';
import { freeformShape } from './freeformShape';
import { applyConnect } from './steps/connect';
import { applyDeleteGeom, applyFaceFreeform, applyMoveFace, applyReplaceFace, scaleFace } from './steps/directEdit';
import { applyExtrude } from './steps/extrude';
import { WALLS_CLASH, applyShell } from './steps/shell';
import { applyThread } from './steps/thread';
import { applyBoolean } from './steps/boolean';
import { applySketch, sketchWas } from './steps/sketch';
import { applyRevolve } from './steps/revolve';
import { applySweep } from './steps/sweep';
import { applyLoft } from './steps/loft';
import { applyFilletOrChamfer } from './steps/fillet';
import { movedFrom, transform } from './steps/transform';
import { applySplit } from './steps/split';
import { applyImport, importCache } from './steps/import';
import { applyHole } from './steps/hole';
import { fillNetwork, fillToPlane } from './steps/fill';
import { applyRepair } from './steps/repair';
import { chainKey, hash53, shortBig } from './stepKey';
import { originsOf } from './originsOf';
import { rawEntries, rawGet, rawHas } from './readTracking';
import type {
  Feature,
  PlaneDef,
  SketchEntity,
  Vec3
} from '../doc/types';
import type { BodyHealth, BodyMesh, BodyProps, EdgeInfo, ExportFormat, FaceInfo, FeatureError, RegenResult } from './protocol';
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

/** The project with its threads left plain, as drawings draw it, rebuilt in `drawingCache`. */
export async function runWithPlainThreads(features: Feature[]): Promise<Ctx> {
  const keep = cache;
  cache = drawingCache;
  alsoCache = keep;
  try {
    return (await run(features.map(feature => (feature.type === 'thread' && !feature.suppressed ? { ...feature, suppressed: true } : feature)))).ctx;
  } finally {
    drawingCache = cache;
    cache = keep;
    alsoCache = [];
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

/** Edits that change a solid in place (their results are checked). */
const GUARDED = new Set<string>(['extrude', 'revolve', 'sweep', 'loft', 'boolean', 'fillet', 'chamfer', 'shell', 'moveFace', 'scaleFace', 'replaceFace', 'deleteGeom', 'split', 'connect', 'hole']);
/** Edits that must not break a body into pieces (cuts and booleans may). */
const NO_SPLIT = new Set<string>(['fillet', 'chamfer', 'shell', 'moveFace', 'scaleFace', 'replaceFace', 'deleteGeom']);

/** A shell in pieces: what was cut into the opened face hung from that face alone. */
const SHELL_LOOSE = 'Opening this face would leave what is cut into it (a pocket, a blind hole) standing loose from the rest - open another face';

/**
 * Replay features in order. Results are cached per feature, keyed by the JSON
 * of every feature up to it, so editing feature k only rebuilds k onwards.
 */
export async function run(features: Feature[], saved = false) {
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
export function drawingMesh(id: string, shape: Shape3D): BodyMesh {
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


