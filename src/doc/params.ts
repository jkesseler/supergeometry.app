// Parametric document: evaluate expressions (variables) into feature values and
// re-solve sketch constraints, so the document's numbers are always consistent.

import { transformEntity } from '../sketch/edit';
import { dot, toPlane, toWorld } from '../geom';
import { applyRepeats } from '../sketch/repeat';
import { refill } from '../sketch/fill';
import { solveFine } from '../sketch/constraints';
import { evaluate, setUnits, setVariables } from '../units';
import type { Feature, ProjectDoc, SketchEntity } from './types';

/** Kind of value stored at a path (for units: lengths are mm, angles degrees). */
export function kindOfPath(path: string): 'length' | 'angle' | 'number' {
  // The value's own name (a number at the end is a place in a list: a point's X / Y / Z).
  const keys = path.split('.');
  const last = [...keys].reverse().find(k => !/^\d+$/.test(k)) ?? '';
  // A turn's pivot point is a length (only its angle is an angle): a pivot
  // driven by a variable ("p1") was refused as "can't be evaluated".
  if (/angle|rot/i.test(last) && !/origin|translate|center/i.test(last)) {
    return 'angle';
  }
  if (/count|factor|sides|opacity|taper|starts/i.test(last)) {
    return 'number';
  }

  return 'length';
}

export function getPath(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((o, k) => (o == null ? undefined : (o as Record<string, unknown>)[k]), obj);
}

export function setPath(obj: unknown, path: string, value: unknown): void {
  const keys = path.split('.');
  let o = obj as Record<string, unknown>;
  for (const k of keys.slice(0, -1)) {
    if (o[k] == null) {
      return;
    }
    o = o[k] as Record<string, unknown>;
  }
  o[keys[keys.length - 1]] = value;
}

/** Recompute every expression-driven value and re-solve constrained sketches (in place). */
export function resolveDoc(doc: ProjectDoc): string[] {
  const problems: string[] = [];
  // (Its own unit, before anything is read: the app set it after this ran, so a project whose unit had just changed
  // was worked out once more in the old one.)
  if (doc.units) {
    setUnits(doc.units);
  }
  setVariables(doc.variables ?? []);
  for (const f of doc.features as Feature[]) {
    for (const [path, expr] of Object.entries(f.exprs ?? {})) {
      const v = evaluate(expr, kindOfPath(path));
      if (v === null) {
        problems.push(`${f.name}: "${expr}" can't be evaluated`);
      } else {
        setPath(f, path, v);
      }
    }
    // Curves projected from an earlier sketch: put where that sketch's curves are now (it was changed in History,
    // or by a variable - a step before this one, already worked out above).
    if (f.type === 'sketch' && f.refs?.length) {
      const next = refreshRefs(f, doc.features as Feature[]);
      if (next && !sameNumbers(f.entities, next, 1e-9)) {
        f.entities = next;
      }
    }
    // A sketch's patterns that follow a count: the count worked out, their copies made again if it is another number.
    if (f.type === 'sketch' && f.repeats?.length) {
      for (const r of f.repeats) {
        const v = evaluate(r.countExpr, 'number');
        if (v === null) {
          problems.push(`${f.name}: "${r.countExpr}" can't be evaluated`);
        } else if (!(v >= 1)) {
          problems.push(`${f.name}: a pattern's count is ${Math.round(v)} ("${r.countExpr}") - it has to be at least 1`);
        } else {
          r.count = Math.round(v);
        }
      }
      const again = applyRepeats(f.entities, f.constraints ?? [], f.repeats);
      if (again) {
        ((f.entities = again.entities), (f.constraints = again.constraints));
      }
    }
    if (f.type === 'sketch' && f.constraints?.length) {
      for (const c of f.constraints) {
        // A point held where X / Y were typed with a variable.
        if (c.type === 'fix' && c.at && c.atExpr) {
          c.at = c.at.map((x, i) => {
            const e = c.atExpr![i];
            if (!e) {
              return x;
            }
            const v = evaluate(e, 'length');
            if (v === null) {
              problems.push(`${f.name}: "${e}" can't be evaluated`);
            }

            return v ?? x;
          }) as typeof c.at;
        }
        if (!c.expr) {
          continue;
        }
        const v = evaluate(c.expr, c.prop === 'angle' ? 'angle' : 'length');
        if (v === null) {
          problems.push(`${f.name}: "${c.expr}" can't be evaluated`);
        } else {
          c.value = v;
        }
      }
      // (Curves that are another sketch's stay where that sketch has them: the rest is solved round them.)
      const held = new Set((f.refs ?? []).map(x => x.id));
      const r = solveFine(f.entities, f.constraints, held.size ? { fixed: held } : {});
      // Can't all be met: the sketch stays as it was rather than being bent out of shape.
      // Met already (only rounding noise in the 14th digit): kept exactly as it
      // was - the noise changed the step, and every change anywhere (a colour,
      // a name, an eye in Items) rebuilt everything after the sketch: 20 s a
      // time on a desk fan.
      if (!r.ok) {
        problems.push(`${f.name}: constraints can't all be met`);
      } else if (!sameNumbers(f.entities, r.entities, 1e-9)) {
        f.entities = r.entities;
      }
    }
    // Fill patterns follow their shapes, here too: a shape that changed size by a variable or a dimension has its
    // pattern made again (it was only made again when the sketch was changed in the sketch tool).
    if (f.type === 'sketch' && f.fills?.length) {
      const filled = refill(f.entities, f.fills);
      if (!sameNumbers(f.entities, filled, 1e-9)) {
        f.entities = filled;
      }
    }
  }

  return problems;
}

/**
 * A sketch's curves with those it has from an earlier sketch as that sketch has them now, seen from this one's plane
 * (the two parallel: the same shapes, moved and turned into it). Null: none could be found again.
 */
function refreshRefs(f: Extract<Feature, { type: 'sketch' }>, all: Feature[]): SketchEntity[] | null {
  let changed = false;
  const out = f.entities.map((e) => {
    const ref = f.refs!.find(r => r.id === e.id);
    if (!ref) {
      return e;
    }
    const from = all.find(x => x.id === ref.sketch);
    if (!from || from.type !== 'sketch' || from === f) {
      return e;
    }
    const src = from.entities.find(x => x.id === ref.entity);
    if (!src || Math.abs(dot(from.plane.normal, f.plane.normal)) < 1 - 1e-9) {
      return e;
    }
    changed = true;

    return { ...transformEntity(src, uv => toPlane(f.plane, toWorld(from.plane, uv))), id: e.id, ...(e.construction ? { construction: true } : { construction: undefined }) } as SketchEntity;
  });

  return changed ? out : null;
}

/** The same structure with every number within `tol` of the other's. */
function sameNumbers(a: unknown, b: unknown, tol: number): boolean {
  if (typeof a === 'number' && typeof b === 'number') {
    return Math.abs(a - b) <= tol;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => sameNumbers(x, b[i], tol));
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a as object);
    const kb = Object.keys(b as object);

    return ka.length === kb.length && ka.every(k => sameNumbers((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], tol));
  }

  return a === b;
}
