import { isClosed, selfCrossings } from '../freeform/cage';
import { applyAffine } from './affine';
import { cageToShape } from './freeform';
import { shapeValid, subShapes } from './health';
import { repairShape } from './repair';
import { editNotes } from './faceEdit';
import { quickVolume } from './ocFree';
import type { Shape3D } from 'replicad';
import type { Feature, Vec3 } from '../doc/types';
import type { Affine } from './types';

/** A freeform's shape with its cage mapped by `affine` (thickness grows with the overall scale). */
export function freeformShape(freeform: Extract<Feature, { type: 'freeform' }>, affine: Affine): Shape3D {
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
