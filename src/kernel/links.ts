import { rawEntries, rawGet } from './readTracking';
import { affineDet, affineInverse, affineThen, shapeThrough } from './affine';
import { movedFrom } from './steps/transform';
import { movedTags } from './provenance';
import { volumes } from './booleans';
import type { Ctx } from './types';

/**
 * Linked bodies follow each other: a step that changed one body of a group (rounded an edge of it, cut a hole in
 * it, joined something to it...) leaves every other body of the group changed the same way - the changed body's
 * new shape, put where the other stands. (Asked for: "if it's linked, whatever change I do to any copy of that
 * body or the original, it should also change the other ones exactly the same. We should also have this in
 * patterns".) Moving or turning one of them is its own business: that only changes where it stands. One deleted,
 * or used up by a join, leaves the group; the others stay.
 */
export function followLinks(step: string, before: Ctx, out: Ctx): void {
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
