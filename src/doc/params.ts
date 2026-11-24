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
  const last = [...keys].reverse().find(key => !/^\d+$/.test(key)) ?? '';
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
  return path.split('.').reduce<unknown>((current, key) => (current == null ? undefined : (current as Record<string, unknown>)[key]), obj);
}

export function setPath(obj: unknown, path: string, value: unknown): void {
  const keys = path.split('.');
  let current = obj as Record<string, unknown>;
  for (const key of keys.slice(0, -1)) {
    if (current[key] == null) {
      return;
    }
    current = current[key] as Record<string, unknown>;
  }
  current[keys[keys.length - 1]] = value;
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
  for (const feature of doc.features as Feature[]) {
    for (const [path, expr] of Object.entries(feature.exprs ?? {})) {
      const value = evaluate(expr, kindOfPath(path));
      if (value === null) {
        problems.push(`${feature.name}: "${expr}" can't be evaluated`);
      } else {
        setPath(feature, path, value);
      }
    }
    // Curves projected from an earlier sketch: put where that sketch's curves are now (it was changed in History,
    // or by a variable - a step before this one, already worked out above).
    if (feature.type === 'sketch' && feature.refs?.length) {
      const next = refreshRefs(feature, doc.features as Feature[]);
      if (next && !sameNumbers(feature.entities, next, 1e-9)) {
        feature.entities = next;
      }
    }
    // A sketch's patterns that follow a count: the count worked out, their copies made again if it is another number.
    if (feature.type === 'sketch' && feature.repeats?.length) {
      for (const repeat of feature.repeats) {
        const value = evaluate(repeat.countExpr, 'number');
        if (value === null) {
          problems.push(`${feature.name}: "${repeat.countExpr}" can't be evaluated`);
        } else if (!(value >= 1)) {
          problems.push(`${feature.name}: a pattern's count is ${Math.round(value)} ("${repeat.countExpr}") - it has to be at least 1`);
        } else {
          repeat.count = Math.round(value);
        }
      }
      const again = applyRepeats(feature.entities, feature.constraints ?? [], feature.repeats);
      if (again) {
        ((feature.entities = again.entities), (feature.constraints = again.constraints));
      }
    }
    if (feature.type === 'sketch' && feature.constraints?.length) {
      for (const constraint of feature.constraints) {
        // A point held where X / Y were typed with a variable.
        if (constraint.type === 'fix' && constraint.at && constraint.atExpr) {
          constraint.at = constraint.at.map((x, i) => {
            const e = constraint.atExpr![i];
            if (!e) {
              return x;
            }
            const value = evaluate(e, 'length');
            if (value === null) {
              problems.push(`${feature.name}: "${e}" can't be evaluated`);
            }

            return value ?? x;
          }) as typeof constraint.at;
        }
        if (!constraint.expr) {
          continue;
        }
        const evaluated = evaluate(constraint.expr, constraint.prop === 'angle' ? 'angle' : 'length');
        if (evaluated === null) {
          problems.push(`${feature.name}: "${constraint.expr}" can't be evaluated`);
        } else {
          constraint.value = evaluated;
        }
      }
      // (Curves that are another sketch's stay where that sketch has them: the rest is solved round them.)
      const held = new Set((feature.refs ?? []).map(sketchRef => sketchRef.id));
      const solution = solveFine(feature.entities, feature.constraints, held.size ? { fixed: held } : {});
      // Can't all be met: the sketch stays as it was rather than being bent out of shape.
      // Met already (only rounding noise in the 14th digit): kept exactly as it
      // was - the noise changed the step, and every change anywhere (a colour,
      // a name, an eye in Items) rebuilt everything after the sketch: 20 s a
      // time on a desk fan.
      if (!solution.ok) {
        problems.push(`${feature.name}: constraints can't all be met`);
      } else if (!sameNumbers(feature.entities, solution.entities, 1e-9)) {
        feature.entities = solution.entities;
      }
    }
    // Fill patterns follow their shapes, here too: a shape that changed size by a variable or a dimension has its
    // pattern made again (it was only made again when the sketch was changed in the sketch tool).
    if (feature.type === 'sketch' && feature.fills?.length) {
      const filled = refill(feature.entities, feature.fills);
      if (!sameNumbers(feature.entities, filled, 1e-9)) {
        feature.entities = filled;
      }
    }
  }

  return problems;
}

/**
 * A sketch's curves with those it has from an earlier sketch as that sketch has them now, seen from this one's plane
 * (the two parallel: the same shapes, moved and turned into it). Null: none could be found again.
 */
function refreshRefs(sketch: Extract<Feature, { type: 'sketch' }>, all: Feature[]): SketchEntity[] | null {
  let changed = false;
  const out = sketch.entities.map((e) => {
    const ref = sketch.refs!.find(ref => ref.id === e.id);
    if (!ref) {
      return e;
    }
    const from = all.find(feature => feature.id === ref.sketch);
    if (!from || from.type !== 'sketch' || from === sketch) {
      return e;
    }
    const src = from.entities.find(entity => entity.id === ref.entity);
    if (!src || Math.abs(dot(from.plane.normal, sketch.plane.normal)) < 1 - 1e-9) {
      return e;
    }
    changed = true;

    return { ...transformEntity(src, uv => toPlane(sketch.plane, toWorld(from.plane, uv))), id: e.id, ...(e.construction ? { construction: true } : { construction: undefined }) } as SketchEntity;
  });

  return changed ? out : null;
}

/** The same structure with every number within `tol` of the other's. */
function sameNumbers(a: unknown, b: unknown, tol: number): boolean {
  if (typeof a === 'number' && typeof b === 'number') {
    return Math.abs(a - b) <= tol;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => sameNumbers(item, b[i], tol));
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a as object);
    const kb = Object.keys(b as object);

    return ka.length === kb.length && ka.every(key => sameNumbers((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key], tol));
  }

  return a === b;
}
