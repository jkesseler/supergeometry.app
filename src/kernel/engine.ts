// The geometry kernel. This (with sketchGeom.ts) is the ONLY code that knows
// about OpenCascade / replicad; worker.ts exposes it to the UI via protocol.ts.
//
// replicad gotchas, learned the hard way:
//  - makeCompound(), translate(), rotate(), mirror(), scale() DELETE their input.
//    Shapes here live on in the feature cache, so always clone first.

import {
  exportSTEP,
  type Shape3D
} from 'replicad';
import { applyFreeformEdits } from '../doc/freeformEdits';
import { deepCopy, subShapes } from './health';
import { healthOf, isHealthy } from './repair';
import {
  editNotes,
  sameSizesAgain,
  looseBox
} from './faceEdit';
import { inheritTags, setOrigins, tagBody, type OriginOf } from './provenance';
import { binarySTL } from './meshing';
import { measureArea as trueArea, volumeProperties } from './ocFree';
import { useReleases } from './release';
import { useSafeBooleans } from './safeBooleans';
import { isFault, blame, KernelFault, crashed, errorText } from './faults';
import { rebuild } from './rebuildState';
import { DAMAGED_TEXT, MAX_REACH, damaged } from './damaged';
import { baseId, bodyNames, wholeOf, touchedBodies } from './bodies';
import { volumes } from './booleans';
import { EDGES_CLASH, guardEdit } from './editGuard';
import { applyConnect } from './steps/connect';
import { applyAxis, applyPlane } from './steps/construction';
import { applyDelete } from './steps/delete';
import { applyFreeform, applyFreeformEdit } from './steps/freeform';
import { applyImprint, applyWrap } from './steps/imprint';
import { applyDeleteGeom, applyFaceFreeform, applyMoveFace, applyReplaceFace, applyScaleFace } from './steps/directEdit';
import { applyExtrude } from './steps/extrude';
import { WALLS_CLASH, applyShell } from './steps/shell';
import { applyThread } from './steps/thread';
import { applyBoolean } from './steps/boolean';
import { applySketch, sketchWas } from './steps/sketch';
import { applyRevolve } from './steps/revolve';
import { applySweep } from './steps/sweep';
import { applyLoft } from './steps/loft';
import { applyFilletOrChamfer } from './steps/fillet';
import { transform } from './steps/transform';
import { applySplit } from './steps/split';
import { applyImport, importCache } from './steps/import';
import { applyHole } from './steps/hole';
import { applyFill, applyFillToPlane } from './steps/fill';
import { applyRepair } from './steps/repair';
import { chainKey, hash53, shortBig } from './stepKey';
import { originsOf } from './originsOf';
import { rawEntries, Noted, startReading, stopReading, unchangedFor, fork, recordDelta } from './readTracking';
import { followLinks } from './links';
import { drawingLookup, keepDrawingRebuild, keepModelRebuild, lastRebuiltBodies, modelLookup, resetRebuildCache } from './rebuildCache';
import { resetFaceInfos } from './faceInfoCache';
import { meshBody, smoothStepsOf } from './viewMesh';
import { printMesh } from './printMesh';
import type {
  Feature,
  PlaneDef,
  SketchEntity,
  Vec3
} from '../doc/types';
import type { BodyHealth, BodyMesh, BodyProps, ExportFormat, FeatureError, RegenResult } from './protocol';
import type { CacheEntry } from './rebuildCache';
import type { Reads } from './readTracking';
import type { Ctx } from './types';

export { shapeValid } from './health';

/** How many steps the last rebuild ran, took as they were (nothing before them changed), or put back (nothing they read changed). */
export const rebuildStats = { ran: 0, kept: 0, reused: 0 };

/** After a fresh OpenCascade was loaded: everything made with the old one is dropped. */
export function resetKernel(): void {
  resetRebuildCache();
  importCache.clear();
  sketchWas.clear();
  resetFaceInfos();
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

/** The project with its threads left plain, as drawings draw it, rebuilt in the drawings' own steps. */
export async function runWithPlainThreads(features: Feature[]): Promise<Ctx> {
  const plain = features.map(feature => (feature.type === 'thread' && !feature.suppressed ? { ...feature, suppressed: true } : feature));
  const rebuilt = await rebuildSteps(plain, drawingLookup());
  keepDrawingRebuild(rebuilt.entries, rebuilt.ctx.bodies);

  return rebuilt.ctx;
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



export async function regenerate(features: Feature[], saved = false): Promise<RegenResult> {
  const t0 = performance.now();
  const { ctx, errors, numbers, notes, whole, entries } = await run(features, saved);
  const names = bodyNames(features, [...ctx.bodies.keys()], numbers);
  const smoothSteps = smoothStepsOf(features);
  const meshes: BodyMesh[] = [];
  for (const [id, shape] of ctx.bodies) {
    try {
      meshes.push(meshBody(id, names.get(id)!, shape, smoothSteps));
    } catch (err) {
      if (isFault(err)) {
        // The last step that changed this body is the one whose result can't be shown.
        let index = entries.length - 1;
        while (index > 0 && entries[index - 1].ctx.bodies.get(id) === shape) {
          index--;
        }
        if (entries[index]) {
          blame(entries[index].key);
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
export function debugBodies(): Map<string, Shape3D> {
  return lastRebuiltBodies();
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
  const rebuilt = await rebuildSteps(features, modelLookup());
  keepModelRebuild(rebuilt.entries, rebuilt.ctx.bodies, saved);

  return rebuilt;
}

/** What a step is built with besides the model before it. */
interface StepScope {
  key: string;
  json: string;
  off: string;
  origins: Map<string, OriginOf>;
  editable: Set<string>;
  /** The steps of the project being built (a thread's record is only good while its step is there). */
  stepsNow: Set<string>;
}

/** Steps after the History's breakpoint are off, like suppressed ones; Edit Freeform steps are put into the freeforms they edit (those build with the new cage). */
function prepareFeatures(given: Feature[]): Feature[] {
  const isRolledBack = given.some(feature => feature.rolledBack);
  const switchedOff = isRolledBack ? given.map(feature => (feature.rolledBack && !feature.suppressed ? { ...feature, suppressed: true } : feature)) : given;

  return applyFreeformEdits(switchedOff);
}

function findCached(lookup: CacheEntry[][], index: number, key: string): CacheEntry | undefined {
  return lookup.map(entries => entries[index]).find(candidate => candidate?.key === key);
}

/** Something before it changed, but nothing it read: its result as it was, on the model as it is now. */
function reuseUnchanged(lastBuilt: CacheEntry, key: string, ctx: Ctx): CacheEntry {
  const out = fork(ctx);
  for (const [kind, id, value, isThere] of lastBuilt.delta!) {
    if (isThere) {
      Map.prototype.set.call(out[kind], id, value);
    } else {
      Map.prototype.delete.call(out[kind], id);
    }
  }

  return { ...lastBuilt, key, ctx: out, input: ctx };
}

async function rebuildSteps(features: Feature[], lookup: CacheEntry[][]) {
  const stepsNow = new Set(features.map(feature => feature.id));
  useSafeBooleans();
  useReleases();
  const prepared = prepareFeatures(features);
  const editable = new Set(prepared.filter(feature => (feature.type === 'freeform' || feature.type === 'faceFreeform') && !feature.suppressed).map(feature => feature.id));
  const errors: FeatureError[] = [];
  const notes: FeatureError[] = [];
  let ctx: Ctx = fork({ bodies: new Map(), sketches: new Map(), planes: new Map(), axes: new Map(), freeforms: new Map(), sweeps: new Map(), links: new Map() });
  rebuild.switchedOff = new Set(prepared.filter(feature => feature.suppressed).map(feature => feature.id));
  const off = [...rebuild.switchedOff].sort().join();
  // The steps as last rebuilt (by step, wherever in the list they are now).
  const lastBuiltById = new Map<string, CacheEntry>();
  for (const cachedEntry of lookup.flat()) {
    if (cachedEntry.id && !lastBuiltById.has(cachedEntry.id)) {
      lastBuiltById.set(cachedEntry.id, cachedEntry);
    }
  }
  rebuildStats.ran = rebuildStats.kept = rebuildStats.reused = 0;
  let key = '';
  const entries: CacheEntry[] = [];
  let isCacheHit = true;
  // Which of a step's faces is which, for the steps so far (a step looking for
  // the face it was built on asks; so does the mesh, for what gets picked next).
  const origins = new Map<string, OriginOf>();
  setOrigins(origins);

  for (let i = 0; i < prepared.length; i++) {
    const feature = prepared[i];
    // Chained hashes, not the text itself: a key holding every step's JSON
    // grew with the square of the project (an import's megabytes in each one).
    // (A step's `whole` is what it worked out the first time, taken in by the
    // page: not a change to build again for.)
    const text = JSON.stringify((feature.type === 'boolean' || feature.type === 'delete') && feature.whole ? { ...feature, whole: undefined } : feature, shortBig);
    const json = `${hash53(text, 3)}.${text.length}`;
    key = chainKey(key, text);
    const cached: CacheEntry | undefined = isCacheHit ? findCached(lookup, i, key) : undefined;
    isCacheHit = !!cached;
    const lastBuilt = lastBuiltById.get(feature.id);
    let entry: CacheEntry;
    if (cached) {
      entry = cached;
      rebuildStats.kept++;
    } else if (lastBuilt && !feature.suppressed && !crashed.has(key) && unchangedFor(lastBuilt, json, ctx, off)) {
      entry = reuseUnchanged(lastBuilt, key, ctx);
      rebuildStats.reused++;
    } else {
      entry = await buildStep(feature, ctx, { key, json, off, origins, editable, stepsNow });
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
    entries.push(entry);
  }

  return { ctx, errors, numbers: numberBodies(entries), notes, whole: wholePatterns(prepared, entries), entries };
}

/** A step built now, on the model before it (a suppressed one only passes it on). */
async function buildStep(feature: Feature, ctx: Ctx, scope: StepScope): Promise<CacheEntry> {
  const { key, json, off, origins } = scope;
  const out = fork(ctx);
  const entry: CacheEntry = { key, ctx: out, id: feature.id, json, off, input: ctx };
  rebuildStats.ran++;
  if (feature.suppressed) {
    return entry;
  }
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
    startReading(reads);
    const touched = touchedBodies(feature, ctx);
    const copies = copyTouchedBodies(feature, touched, out);
    await apply(feature, out, scope);
    entry.origin = originsOf(feature, out);
    stopReading();
    if (entry.origin) {
      origins.set(feature.id, entry.origin);
    }
    for (const [id, copy] of copies) {
      if (out.bodies.get(id) === copy) {
        out.bodies.set(id, ctx.bodies.get(id)!);
      }
    }
    checkReach(ctx, out);
    // Every edit of a solid ends in one: checked (and tidied) before it counts.
    if (GUARDED.has(feature.type)) {
      checkSolids(feature, ctx, out);
    }
    tagFaces(feature, ctx, out, touched, copies);
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
    stopReading();
    if (isFault(err)) {
      blame(key);
      console.error(err);
      throw new KernelFault(feature.id);
    }
    entry.error = errorText(err);
    entry.ctx = failedContext(feature, ctx);
  }
  entry.delta = recordDelta(entry.ctx, ctx, reads);

  return entry;
}

/**
 * An edit works on copies of the bodies it may touch: OpenCascade is
 * allowed to adjust the shapes it is given, and the earlier steps'
 * results (kept in the cache) must never change - not even when this
 * step fails. Bodies it leaves alone get their originals back.
 */
function copyTouchedBodies(feature: Feature, touched: string[], out: Ctx): Map<string, Shape3D> {
  const copies = new Map<string, Shape3D>();
  if (!GUARDED.has(feature.type)) {
    return copies;
  }
  for (const id of touched) {
    const body = out.bodies.get(id);
    if (!body || out.freeforms.has(id)) {
      continue;
    }
    const shape = deepCopy(body);
    inheritTags(body, shape);
    // (The same shape: its volume is known - a big body's, measured
    // again on every step's copy, was a quarter of a small cut's time.)
    const volume = volumes.get(body);
    if (volume !== undefined) {
      volumes.set(shape, volume);
    }
    copies.set(id, shape);
    out.bodies.set(id, shape);
  }

  return copies;
}

/** The model as a failed step leaves it: as it was (a failed sketch is still there, with no boundary). */
function failedContext(feature: Feature, ctx: Ctx): Ctx {
  if (feature.type !== 'sketch') {
    return { ...ctx };
  }
  const sketches = new Noted('sketches', ctx.sketches);
  Map.prototype.set.call(sketches, feature.id, { ...feature, boundary: [] });

  return { ...ctx, sketches };
}

function diagonalOf(lo: number[], hi: number[]): number {
  return Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
}

/** Nothing kilometres across, or away: a typo (a size with six noughts too many), and more than the engine or the view can work with. */
function checkReach(ctx: Ctx, out: Ctx): void {
  for (const [id, after] of out.bodies) {
    if (after === ctx.bodies.get(id)) {
      continue;
    }
    // (The quick box first - never smaller than the body: its exact one, up to a second for a curved body
    // and asked after every step, only for a body that may be over a limit.)
    let [lo, hi] = looseBox(after) as [number[], number[]];
    if (!(Math.max(...lo.map(Math.abs), ...hi.map(Math.abs)) < MAX_REACH) || diagonalOf(lo, hi) < 1e-2) {
      [lo, hi] = after.boundingBox.bounds;
    }
    const reach = Math.max(...lo.map(Math.abs), ...hi.map(Math.abs));
    const diagonal = diagonalOf(lo, hi);
    // (An empty result has an upside-down box: left to the checks below.)
    const hasBox = lo[0] <= hi[0];
    if (hasBox && !(reach < MAX_REACH)) {
      throw new Error('This would reach more than 10 km from the origin - check its values (a typo?)');
    }
    // ...and nothing scaled away to a speck (a factor of 0.0000008).
    if (hasBox && diagonal < 1e-4) {
      throw new Error('This would be smaller than a ten-thousandth of a mm - check its values (a typo?)');
    }
  }
}

/** Each solid a guarded edit changed, checked (and tidied): put in the model, or taken out when cut away to dust. */
function checkSolids(feature: Feature, ctx: Ctx, out: Ctx): void {
  for (const [id, after] of [...out.bodies]) {
    const previous = ctx.bodies.get(id);
    if (after === previous) {
      continue;
    }
    // A freeform left as an open surface (a sheet) isn't a solid to check; a solid
    // freeform is - its edits are checked like any body's.
    if (previous && (out.freeforms.has(id) || ctx.freeforms.has(id)) && !subShapes(previous, 'SOLID').length) {
      continue;
    }
    // Offsetting a face of the body itself is a face move: it doesn't split it either.
    const inPlace = feature.type === 'extrude' && feature.source.kind === 'face' && feature.mode !== 'new' && feature.target === feature.source.face.body;
    let kept: Shape3D | null;
    try {
      kept = guardEdit(previous, after, !NO_SPLIT.has(feature.type) && !inPlace, feature.type !== 'fillet' && feature.type !== 'chamfer');
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

/**
 * Which step made each face: kept from what it was made from, this step's own otherwise.
 * (Bodies the step names; the others were only there - see tagBody.)
 */
function tagFaces(feature: Feature, ctx: Ctx, out: Ctx, touched: string[], copies: Map<string, Shape3D>): void {
  const named = touchedBodies(feature, ctx, false);
  const from = [...named.map(id => ctx.bodies.get(id)!), ...named.flatMap(id => (copies.has(id) ? [copies.get(id)!] : []))];
  const others = touched.filter(id => !named.includes(id)).map(id => ctx.bodies.get(id)!);
  for (const [id, body] of out.bodies) {
    const previous = ctx.bodies.get(id);
    if (body !== previous) {
      tagBody(body, feature.id, previous ? [previous, ...from] : from, previous ? others.filter(other => other !== previous) : others);
    }
  }
}

/** Steps that don't say yet which patterns they used whole: as they were made. */
function wholePatterns(features: Feature[], entries: CacheEntry[]): Record<string, string[]> | undefined {
  let whole: Record<string, string[]> | undefined;
  features.forEach((feature, i) => {
    if ((feature.type !== 'boolean' && feature.type !== 'delete') || feature.whole || feature.suppressed) {
      return;
    }
    const ids: unknown = feature.type === 'boolean' ? feature.tools : feature.bodies;
    const bodiesBefore = entries[i]?.input?.bodies;
    // (Not for a step that failed: its saved values may be damaged.)
    if (bodiesBefore && !entries[i].error && Array.isArray(ids) && ids.every(id => typeof id === 'string')) {
      (whole ??= {})[feature.id] = wholeOf(ids, new Set(rawEntries(bodiesBefore).map(([id]) => id)));
    }
  });

  return whole;
}

/**
 * Bodies are numbered in the order they first appeared (a body that's
 * deleted later keeps its number used, so the others don't change names).
 */
function numberBodies(entries: CacheEntry[]): Map<string, number> {
  const numbers = new Map<string, number>();
  for (const entry of entries) {
    for (const id of entry.ctx.bodies.keys()) {
      if (!numbers.has(id)) {
        numbers.set(id, numbers.size + 1);
      }
    }
  }

  return numbers;
}

async function apply(feature: Feature, ctx: Ctx, scope: StepScope): Promise<void> {
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
      return applyBoolean(feature, ctx, scope.stepsNow);

    case 'transform':
      transform(feature, ctx);

      return;

    case 'split':
      return applySplit(feature, ctx);

    case 'plane':
      return applyPlane(feature, ctx);

    case 'axis':
      return applyAxis(feature, ctx);

    case 'import':
      return applyImport(feature, ctx);

    case 'delete':
      return applyDelete(feature, ctx);

    case 'image':
      return; // drawn by the UI only

    case 'freeformEdit':
      return applyFreeformEdit(feature, scope.editable);

    case 'freeform':
      return applyFreeform(feature, ctx);

    case 'scaleFace':
      return applyScaleFace(feature, ctx);

    case 'faceFreeform':
      return applyFaceFreeform(feature, ctx);

    case 'replaceFace':
      return applyReplaceFace(feature, ctx);

    case 'hole':
      return applyHole(feature, ctx);

    case 'thread':
      return applyThread(feature, ctx);

    case 'imprint':
      return applyImprint(feature, ctx);

    case 'wrap':
      return applyWrap(feature, ctx);

    case 'connect':
      return applyConnect(feature, ctx);

    case 'fill':
      return applyFill(feature, ctx);

    case 'fillToPlane':
      return applyFillToPlane(feature, ctx);

    case 'repair':
      return applyRepair(feature, ctx);

    case 'deleteGeom':
      return applyDeleteGeom(feature, ctx);

    case 'moveFace':
      return applyMoveFace(feature, ctx);
  }
}


// ------------------------------------------------------------------- meshing


// ------------------------------------------------------------------- helpers


