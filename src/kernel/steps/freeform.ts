import { AFFINE_ID } from '../affine';
import { freeformShape } from '../freeformShape';
import type { FreeformEditFeature, FreeformFeature } from '../../doc/types';
import type { Ctx } from '../types';

export function applyFreeform(feature: FreeformFeature, ctx: Ctx) {
  ctx.bodies.set(feature.id, freeformShape(feature, AFFINE_ID));
  ctx.freeforms.set(feature.id, { feature: feature, m: AFFINE_ID });
}

/** Put into its freeform before the rebuild: only checks that freeform is still there. */
export function applyFreeformEdit(feature: FreeformEditFeature, editable: Set<string>) {
  if (!editable.has(feature.target)) {
    throw new Error('The freeform this edits is gone (deleted, or switched off)');
  }
}
