import { Solid, cast, getOC, iterTopo, makeCompound } from 'replicad';
import { deepCopy, hairThin, openEdges, shapeValid, subShapes } from './health';
import { volumes } from './booleans';
import { quickVolume } from './ocFree';
import { repairShape } from './repair';
import { editNotes, unify } from './faceEdit';
import type { Shape3D } from 'replicad';

/**
 * The result of an edit must be a solid like the one it changed: crumbs a
 * cut left behind are swept away, a hollow left as loose surfaces is made a
 * solid, an inside-out one is turned right - and anything still broken
 * (invalid, hair-thin faces, split by an edit that shouldn't split) makes the
 * step stop with a message instead of leaving a damaged body to build on.
 */
export const EDGES_CLASH = 'That size is too big here: the @ run into each other or past a face (a wall thinner than two of them?) - try a smaller one';

export function guardEdit(before: Shape3D | undefined, after: Shape3D, mayPart: boolean, mendTears = true): Shape3D | null {
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
