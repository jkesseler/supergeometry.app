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
  const twin = doc.variables.find(v => v.name !== from && v.name.toLowerCase() === to.toLowerCase());
  if (twin) {
    return twin.name === to ? `There is a variable ${to} already` : `There is a variable ${twin.name} already: ${to} differs only in its capitals`;
  }

  return null;
}

/** The variable `from` called `to` from now on, in place. How many formulas were rewritten (-1: no such variable). */
export function renameVariable(doc: ProjectDoc, from: string, to: string): number {
  const v = doc.variables.find(x => x.name === from);
  if (!v || from === to) {
    return v ? 0 : -1;
  }
  let n = 0;
  const re = (expr: string): string => {
    const next = renameIn(expr, from, to);
    if (next !== expr) {
      n++;
    }

    return next;
  };
  v.name = to;
  for (const x of doc.variables) {
    x.expr = re(x.expr);
  }
  for (const f of doc.features) {
    if (f.exprs) {
      for (const k of Object.keys(f.exprs)) {
        f.exprs[k] = re(f.exprs[k]);
      }
    }
    if (f.type !== 'sketch') {
      continue;
    }
    for (const r of f.repeats ?? []) {
      r.countExpr = re(r.countExpr);
    }
    for (const c of f.constraints ?? []) {
      if (c.expr) {
        c.expr = re(c.expr);
      }
      if (c.atExpr) {
        c.atExpr = c.atExpr.map(e => (e ? re(e) : e)) as typeof c.atExpr;
      }
    }
  }

  return n;
}
