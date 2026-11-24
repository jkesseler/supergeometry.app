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

const mine = (id: string, r: SketchRepeat) => id.startsWith(`${REPEAT_PREFIX}${r.id}-`) || id.startsWith(`${LINK_PREFIX}${r.id}-`);

/** How many times the pattern's curves are there now, the originals counted (1: no copies). */
export function repeatCountNow(entities: SketchEntity[], r: SketchRepeat): number {
  const copies = new Set(entities.filter(e => mine(e.id, r)).map(e => e.id.slice(`${REPEAT_PREFIX}${r.id}-`.length).split('-')[0]));

  return copies.size + 1;
}

/** The pattern's copies and their links, for its originals as they are now. */
export function repeatCurves(entities: SketchEntity[], r: SketchRepeat): { curves: SketchEntity[]; links: SketchConstraint[] } {
  const src = r.src.map(id => entities.find(e => e.id === id)).filter((e): e is SketchEntity => !!e);
  const n = Math.max(1, Math.min(REPEAT_MOST, Math.round(r.count)));
  const curves: SketchEntity[] = [];
  const links: SketchConstraint[] = [];
  const full = Math.abs(Math.abs(r.angle ?? 0) - 360) < 1e-6;
  const turn = (r.angle ?? 0) / (full ? n : Math.max(1, n - 1));
  for (let k = 1; k < n; k++) {
    src.forEach((e, i) => {
      const id = `${REPEAT_PREFIX}${r.id}-${k}-${i}`;
      const xf = r.kind === 'linear' ? translateXf(r.step![0] * k, r.step![1] * k) : rotateXf(r.at!, (turn * k * Math.PI) / 180);
      curves.push({ ...transformEntity(e, xf, true), id });
      const base = { id: `${LINK_PREFIX}${r.id}-${k}-${i}`, type: 'pattern' as const, curves: [e.id, id] };
      links.push(r.kind === 'linear' ? { ...base, at: [r.step![0] * k, r.step![1] * k] } : { ...base, turn: true, at: r.at!, value: turn * k });
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
  for (const r of repeats) {
    const want = Math.max(1, Math.min(REPEAT_MOST, Math.round(r.count)));
    if (!force && repeatCountNow(entities, r) === want) {
      continue;
    }
    if (!r.src.some(id => entities.some(e => e.id === id))) {
      continue;
    }
    const base = entities.filter(e => !mine(e.id, r));
    const made = repeatCurves(base, r);
    entities = [...base, ...made.curves];
    const gone = (c: SketchConstraint) => mine(c.id, r) || [...(c.curves ?? []), ...(c.pts ?? []).map(q => q.e)].some(id => mine(id, r) && !made.curves.some(e => e.id === id));
    constraints = [...constraints.filter(c => !gone(c)), ...made.links];
    changed = true;
  }

  return changed ? { entities, constraints } : null;
}
