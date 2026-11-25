import { openEdges } from './health';
import { editNotes } from './faceEdit';
import type { AnyShape, Shape3D } from 'replicad';
import type { Bodies } from './types';
import type { Feature } from '../doc/types';

export function staysClosed(before: Shape3D, after: Shape3D): Shape3D {
  if (openEdges(after).length > openEdges(before).length) {
    throw new Error('That would tear the body open - try a smaller value, or another face');
  }

  return after;
}

const copyOf = (id: string) => /^([^:]+:.+):(\d+)$/.exec(id);

/**
 * The patterns a step uses whole: the original and every copy there is now
 * picked (`<pattern step>:<original>`). Some of the copies picked is that many
 * bodies, not the whole pattern.
 */
export function wholeOf(ids: string[], there: Set<string>): string[] {
  const groups = new Map<string, Set<number>>();
  for (const id of ids) {
    const match = copyOf(id);
    if (match) {
      groups.set(match[1], (groups.get(match[1]) ?? new Set()).add(+match[2]));
    }
  }
  const out: string[] = [];
  for (const [prefix, ks] of groups) {
    const original = prefix.slice(prefix.indexOf(':') + 1);
    const all = [...there].filter(key => key.startsWith(`${prefix}:`) && /^\d+$/.test(key.slice(prefix.length + 1)));
    if (ids.includes(original) && all.length && all.every(key => ks.has(+key.slice(prefix.length + 1)))) {
      out.push(prefix);
    }
  }

  return out;
}

/**
 * The bodies a step names, as they are now. A whole pattern picked (the
 * original and every copy - "Whole Pattern") stays whole when the pattern's
 * count changes: 8 vents subtracted, made 10, all 10 are cut (and made 6, the
 * step still works). Which those are is kept with the step (`whole`, worked
 * out when it was made); a step without it goes by what's there now. Copies no
 * longer there are left out with a note, as long as something is left to work with.
 */
export function bodyList(ids: string[], bodies: Bodies, what: 'tools' | 'bodies', given?: string[]): string[] {
  const out: string[] = [];
  // (Only patterns whose original it still names: picks changed by hand since are bodies one by one.)
  const whole = new Set((Array.isArray(given) ? given : wholeOf(ids, new Set(bodies.keys()))).filter(path => ids.includes(path.slice(path.indexOf(':') + 1))));
  // Copies of copies too (a row of holes, then mirrored: the mirror's copies of the row's copies).
  const add = (id: string) => {
    if (out.includes(id)) {
      return;
    }
    out.push(id);
    for (const path of whole) {
      if (path.slice(path.indexOf(':') + 1) === id) {
        for (const key of [...bodies.keys()]) {
          if (key.startsWith(`${path}:`) && /^\d+$/.test(key.slice(path.length + 1))) {
            add(key);
          }
        }
      }
    }
  };
  for (const id of ids) {
    const match = copyOf(id);
    if (!match || !whole.has(match[1])) {
      add(id);
    }
  }
  const have = [...new Set(out)].filter(id => bodies.has(id));
  const gone = new Set(out).size - have.length;
  if (!have.length) {
    throw new Error('A body it uses no longer exists');
  }
  if (gone) {
    editNotes.push(`${gone} of the ${what === 'tools' ? 'bodies it used' : 'bodies it named'} no longer exist - it works with the rest.`);
  }

  return have;
}

export function need(bodies: Bodies, id: string): Shape3D {
  const b = bodies.get(id);
  if (!b) {
    throw new Error('A body it uses no longer exists');
  }

  return b;
}

export function isEmpty(shape: AnyShape): boolean {
  try {
    return (shape as Shape3D).faces.length === 0;
  } catch {
    return true;
  }
}

/** Pattern copies are named `${featureId}:${body}:${k}`. */
export function baseId(bodyId: string): string {
  return bodyId.split(':')[0];
}

/**
 * Plain names: Body 1, Body 2… (Surface 1… for open surfaces), numbered in the
 * order the bodies were made; imported files keep their file name.
 */
export function bodyNames(features: Feature[], ids: string[], numbers: Map<string, number>): Map<string, string> {
  const isSurface = (x: Feature | undefined) => x?.type === 'freeform' && !!x.surface && !x.thickness;
  const order = [...ids].sort((a, b) => (numbers.get(a) ?? 0) - (numbers.get(b) ?? 0));
  const out = new Map<string, string>();
  let bodies = 0;
  let surfaces = 0;
  for (const id of order) {
    const feature = features.find(feature => feature.id === baseId(id));
    if (feature?.type === 'import') {
      // (One of several solids of a file: the file's name and which.)
      const part = /:(\d+)$/.exec(id);
      out.set(id, part ? `${feature.fileName} (${Number(part[1]) + 1})` : feature.fileName);
      continue;
    }
    // A copy of a surface is a surface too (its id holds the original's).
    const surface = id.split(':').some(part => isSurface(features.find(feature => feature.id === part)));
    out.set(id, surface ? `Surface ${++surfaces}` : `Body ${++bodies}`);
  }

  return out;
}
