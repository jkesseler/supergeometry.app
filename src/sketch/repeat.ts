// A sketch pattern whose count is a variable (or a formula): kept with the sketch, so its copies are made again
// when the count comes to another number - six holes round a circle become eight when "n" does. (A sketch pattern
// was its copies and nothing more: the count could be typed once, and never follow anything.)
//
// The copies are curves of the sketch, each tied to its original by the same "pattern" link a plain pattern's
// copies have - named for their pattern, "rp-<pattern>-<copy>-<curve>", their links "rpc-...".

import { rotateXf, transformEntity, translateXf } from './edit';
import type { SketchConstraint, SketchEntity, SketchRepeat } from '../doc/types';

export const REPEAT_PREFIX = 'rp-';
const LINK_PREFIX = 'rpc-';
/** No more copies than this from one pattern (a count that came to thousands by a slip). */
export const REPEAT_MOST = 500;

const mine = (id: string, sketchRepeat: SketchRepeat) => id.startsWith(`${REPEAT_PREFIX}${sketchRepeat.id}-`) || id.startsWith(`${LINK_PREFIX}${sketchRepeat.id}-`);

/** How many times the pattern's curves are there now, the originals counted (1: no copies). */
export function repeatCountNow(entities: SketchEntity[], sketchRepeat: SketchRepeat): number {
  const copies = new Set(entities.filter(e => mine(e.id, sketchRepeat)).map(e => e.id.slice(`${REPEAT_PREFIX}${sketchRepeat.id}-`.length).split('-')[0]));

  return copies.size + 1;
}

/** The pattern's copies and their links, for its originals as they are now. */
export function repeatCurves(entities: SketchEntity[], sketchRepeat: SketchRepeat): { curves: SketchEntity[]; links: SketchConstraint[] } {
  const src = sketchRepeat.src.map(id => entities.find(e => e.id === id)).filter((e): e is SketchEntity => !!e);
  const count = Math.max(1, Math.min(REPEAT_MOST, Math.round(sketchRepeat.count)));
  const curves: SketchEntity[] = [];
  const links: SketchConstraint[] = [];
  const full = Math.abs(Math.abs(sketchRepeat.angle ?? 0) - 360) < 1e-6;
  const turn = (sketchRepeat.angle ?? 0) / (full ? count : Math.max(1, count - 1));
  for (let copyIndex = 1; copyIndex < count; copyIndex++) {
    src.forEach((e, i) => {
      const id = `${REPEAT_PREFIX}${sketchRepeat.id}-${copyIndex}-${i}`;
      const xf = sketchRepeat.kind === 'linear' ? translateXf(sketchRepeat.step![0] * copyIndex, sketchRepeat.step![1] * copyIndex) : rotateXf(sketchRepeat.at!, (turn * copyIndex * Math.PI) / 180);
      curves.push({ ...transformEntity(e, xf, true), id });
      const base = { id: `${LINK_PREFIX}${sketchRepeat.id}-${copyIndex}-${i}`, type: 'pattern' as const, curves: [e.id, id] };
      links.push(sketchRepeat.kind === 'linear' ? { ...base, at: [sketchRepeat.step![0] * copyIndex, sketchRepeat.step![1] * copyIndex] } : { ...base, turn: true, at: sketchRepeat.at!, value: turn * copyIndex });
    });
  }

  return { curves, links };
}

/**
 * The sketch's curves and constraints with each pattern's copies as many as its count says. A pattern whose copies
 * are that many already is left as it is (its copies follow their originals by their links); one whose originals
 * are all gone goes, its copies staying as plain curves. Null: nothing to change.
 */
export function applyRepeats(entities: SketchEntity[], constraints: SketchConstraint[], repeats: SketchRepeat[] | undefined, force = false): { entities: SketchEntity[]; constraints: SketchConstraint[] } | null {
  if (!repeats?.length) {
    return null;
  }
  let changed = false;
  for (const repeat of repeats) {
    const want = Math.max(1, Math.min(REPEAT_MOST, Math.round(repeat.count)));
    if (!force && repeatCountNow(entities, repeat) === want) {
      continue;
    }
    if (!repeat.src.some(id => entities.some(e => e.id === id))) {
      continue;
    }
    const base = entities.filter(e => !mine(e.id, repeat));
    const made = repeatCurves(base, repeat);
    entities = [...base, ...made.curves];
    const gone = (sketchConstraint: SketchConstraint) => mine(sketchConstraint.id, repeat) || [...(sketchConstraint.curves ?? []), ...(sketchConstraint.pts ?? []).map(q => q.e)].some(id => mine(id, repeat) && !made.curves.some(e => e.id === id));
    constraints = [...constraints.filter(constraint => !gone(constraint)), ...made.links];
    changed = true;
  }

  return changed ? { entities, constraints } : null;
}
