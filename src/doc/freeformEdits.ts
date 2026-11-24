// Edit Freeform steps: each holds the new cage of a freeform (or a Freeform
// Face step) made earlier. Before a rebuild - and wherever a freeform's cage
// is read - the steps that are on are put into what they edit, in order, so
// the shape is the last edit's; deleting or rolling back an edit gives the
// shape as it was before it.

import type { Feature, FreeformEditFeature } from './types';

/** The steps with their edits put in (the edit steps themselves stay, doing nothing more). */
export function applyFreeformEdits<T extends Feature>(features: readonly T[]): T[] {
  const edits = features.filter((feature): feature is T & FreeformEditFeature => feature.type === 'freeformEdit' && !feature.suppressed && !feature.rolledBack);
  if (!edits.length) {
    return features as T[];
  }
  const patch = new Map<string, FreeformEditFeature['patch']>();
  for (const e of edits) {
    patch.set(e.target, { ...(patch.get(e.target) ?? {}), ...e.patch });
  }

  return features.map((feature) => {
    const change = patch.get(feature.id);

    return change && (feature.type === 'freeform' || feature.type === 'faceFreeform') ? ({ ...feature, ...change } as T) : feature;
  });
}

/** One step as its edits leave it (up to and with the edit `upto`, when given). */
export function editedStep<T extends Feature>(features: readonly Feature[], id: string, upto?: string): T | undefined {
  const end = upto ? features.findIndex(feature => feature.id === upto) + 1 : features.length;

  return applyFreeformEdits(features.slice(0, end > 0 ? end : features.length)).find(feature => feature.id === id) as T | undefined;
}
