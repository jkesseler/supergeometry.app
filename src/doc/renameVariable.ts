// A variable given another name: every formula that uses it says the new name - other variables' values, steps'
// sizes, a sketch's dimensions and the points placed by it. Nothing changes size. (A variable could only be deleted
// and made again under another name, and everything that used it lost its link to it.)

import { RESERVED } from '../units';
import type { ProjectDoc } from './types';

/** A name as it stands in a formula: not part of a longer name or a number ("w" in "w2", in "2.5e3"). */
const word = (name: string) => new RegExp(`(^|[^A-Za-z0-9_.])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_])`, 'g');

/** `from` replaced by `to` wherever it stands as a name in the formula. */
export function renameIn(expr: string, from: string, to: string): string {
  return expr.replace(word(from), (_, before: string) => `${before}${to}`);
}

/** Why `to` can't be a variable's name here (null: it can). */
export function nameProblem(doc: ProjectDoc, from: string, to: string): string | null {
  if (!/^[a-z_][a-z0-9_]*$/i.test(to) || RESERVED.test(to)) {
    return 'Names use letters, digits and _ (not starting with a digit, and not a unit or a function like sin or pi)';
  }
  const twin = doc.variables.find(variable => variable.name !== from && variable.name.toLowerCase() === to.toLowerCase());
  if (twin) {
    return twin.name === to ? `There is a variable ${to} already` : `There is a variable ${twin.name} already: ${to} differs only in its capitals`;
  }

  return null;
}

/** The variable `from` called `to` from now on, in place. How many formulas were rewritten (-1: no such variable). */
export function renameVariable(doc: ProjectDoc, from: string, to: string): number {
  const variable = doc.variables.find(variable => variable.name === from);
  if (!variable || from === to) {
    return variable ? 0 : -1;
  }
  let count = 0;
  const re = (expr: string): string => {
    const next = renameIn(expr, from, to);
    if (next !== expr) {
      count++;
    }

    return next;
  };
  variable.name = to;
  for (const x of doc.variables) {
    x.expr = re(x.expr);
  }
  for (const feature of doc.features) {
    if (feature.exprs) {
      for (const key of Object.keys(feature.exprs)) {
        feature.exprs[key] = re(feature.exprs[key]);
      }
    }
    if (feature.type !== 'sketch') {
      continue;
    }
    for (const sketchRepeat of feature.repeats ?? []) {
      sketchRepeat.countExpr = re(sketchRepeat.countExpr);
    }
    for (const sketchConstraint of feature.constraints ?? []) {
      if (sketchConstraint.expr) {
        sketchConstraint.expr = re(sketchConstraint.expr);
      }
      if (sketchConstraint.atExpr) {
        sketchConstraint.atExpr = sketchConstraint.atExpr.map(e => (e ? re(e) : e)) as typeof sketchConstraint.atExpr;
      }
    }
  }

  return count;
}
