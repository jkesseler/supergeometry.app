// The project's unit changed: every formula keeps the size it had.
//
// A plain number in a formula is in the unit in use ("160" is 160 mm, or 160 in). So with the unit changed from mm to
// inches, a variable od = 160 was 160 inches from then on, and the whole model 25 times its size. Here each formula
// that would change is written so that it does not: its plain lengths get the unit they were typed in ("160 mm",
// "od / 2 + 5 mm"). What is no length - a count, a factor, an angle - is left as it is.

import { UNIT_MM, valueAt } from '../units';
import { kindOfPath } from './params';
import { namesIn } from './varAnchors';
import type { ProjectDoc, Units, Variable } from './types';

const NUM = String.raw`(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?`;

/** Rewrites the project's formulas for a change of unit (in place). Returns how many it could not keep as they were. */
export function keepSizes(doc: ProjectDoc, from: Units, to: Units): { changed: number; lost: number } {
  const out = { changed: 0, lost: 0 };
  if (from === to) {
    return out;
  }
  const sFrom = UNIT_MM[from];
  const sTo = UNIT_MM[to];
  const old: Variable[] = doc.variables.map(variable => ({ ...variable }));
  const vars = doc.variables;
  const same = (a: number, b: number) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
  /** How a formula's size goes with the unit in use: 0 not at all, 1 in step with it; NaN neither (or it can't be read). */
  const degree = (text: string): number => {
    const a = valueAt(text, sFrom, vars);
    const b = valueAt(text, sFrom * 2, vars);
    if (a === null || b === null) {
      return NaN;
    }

    return same(a, b) ? 0 : same(b, 2 * a) ? 1 : NaN;
  };
  /** One part of a sum, its size fixed to the unit it was typed in. */
  const pin = (term: string): string | null => {
    const want = valueAt(term, sFrom, vars);
    if (want === null) {
      return null;
    }
    // (The spaces round it stay where they were.)
    const [, pre, core, post] = /^(\s*)(.*?)(\s*)$/s.exec(term)!;
    const lead = new RegExp(String.raw`^(-?\s*${NUM})(\s*(?:[*/].*)?)$`, 'is').exec(core);
    const tries = [...(lead ? [`${lead[1]} ${from}${lead[2]}`] : []), `(${core}) ${from}`];
    for (const t of tries) {
      const got = valueAt(t, sTo, vars);
      if (got !== null && same(got, want) && degree(t) === 0) {
        return pre + t + post;
      }
    }

    return null;
  };
  /** A formula with each part that goes with the unit fixed to it - into its brackets where a part is mixed. */
  const fixed = (expr: string): string => {
    if (degree(expr) === 0) {
      return expr;
    }

    return terms(expr)
      .map((t) => {
        if (t.op) {
          return t.text;
        }
        const degrees = degree(t.text);
        if (degrees === 0) {
          return t.text;
        }
        const whole = degrees === 1 ? pin(t.text) : null;
        if (whole) {
          return whole;
        }
        // Mixed (a length with its unit beside a plain one, inside brackets): each bracket's own parts.
        const inner = brackets(t.text, fixed);

        return degree(inner) === 1 ? (pin(inner) ?? inner) : inner;
      })
      .join('');
  };
  const rewrite = (expr: string, was: number | null): string => {
    if (was === null) {
      return expr;
    }
    const now = valueAt(expr, sTo, vars);
    if (now !== null && same(now, was)) {
      return expr;
    }
    const next = fixed(expr);
    const got = valueAt(next, sTo, vars);
    if (got !== null && same(got, was)) {
      out.changed++;

      return next;
    }
    // (Not a sum of plain parts - "a * b" of two lengths: the whole of it, if that is in step with the unit.)
    const whole = degree(expr) === 1 ? pin(expr) : null;
    if (whole) {
      out.changed++;

      return whole;
    }
    out.lost++;

    return expr;
  };

  // What each formula comes to now, before anything is touched.
  const before = new Map<string, number | null>();
  for (const variable of old) {
    before.set(`v:${variable.name}`, valueAt(variable.expr, sFrom, old));
  }
  // Variables used as a count, a factor or an angle somewhere (and the ones those are made from) stay as they are:
  // "6" with a unit after it is no count. Where one of them is used as a length, that place is fixed instead.
  const plain = new Set<string>();
  const mark = (expr: string) => {
    for (const name of namesIn(expr)) {
      if (plain.has(name)) {
        continue;
      }
      const variable = old.find(variable => variable.name === name);
      if (!variable) {
        continue;
      }
      plain.add(name);
      mark(variable.expr);
    }
  };
  for (const feature of doc.features) {
    for (const [path, expr] of Object.entries(feature.exprs ?? {})) {
      if (kindOfPath(path) !== 'length') {
        mark(expr);
      }
    }
    if (feature.type === 'sketch') {
      for (const sketchConstraint of feature.constraints ?? []) {
        if (sketchConstraint.expr && sketchConstraint.prop === 'angle') {
          mark(sketchConstraint.expr);
        }
      }
    }
  }
  // Variables first, each after the ones it is made from (so those are already as they will be).
  const done = new Set<string>();
  for (let pass = 0; pass <= vars.length; pass++) {
    for (const variable of vars) {
      if (done.has(variable.name)) {
        continue;
      }
      const needs = namesIn(variable.expr).filter(name => name !== variable.name && vars.some(variable => variable.name === name));
      if (pass < vars.length && needs.some(need => !done.has(need))) {
        continue;
      }
      done.add(variable.name);
      if (!plain.has(variable.name)) {
        variable.expr = rewrite(variable.expr, before.get(`v:${variable.name}`) ?? null);
      }
    }
  }
  // Then every size that follows a formula.
  const length = (expr: string) => rewrite(expr, valueAt(expr, sFrom, old));
  for (const feature of doc.features) {
    for (const [path, expr] of Object.entries(feature.exprs ?? {})) {
      if (kindOfPath(path) === 'length') {
        feature.exprs![path] = length(expr);
      }
    }
    if (feature.type !== 'sketch') {
      continue;
    }
    for (const sketchConstraint of feature.constraints ?? []) {
      if (sketchConstraint.expr && sketchConstraint.prop !== 'angle') {
        sketchConstraint.expr = length(sketchConstraint.expr);
      }
      if (sketchConstraint.atExpr) {
        sketchConstraint.atExpr = sketchConstraint.atExpr.map(e => (e ? length(e) : e));
      }
    }
  }

  return out;
}

/** A formula as the parts of its sum: each part, and the + or - between them (brackets kept whole). */
function terms(expr: string): { text: string; op: boolean }[] {
  const out: { text: string; op: boolean }[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < expr.length; i++) {
    const char = expr[i];
    if (char === '(') {
      depth++;
    } else if (char === ')') {
      depth--;
    } else if ((char === '+' || char === '-') && depth === 0) {
      const before = expr.slice(start, i).trimEnd();
      // A sign, not a sum: at the start, after another operator, or the exponent of 1e-3.
      if (!before || /[-+*/^(]$/.test(before) || (/\de$/i.test(before) && /^\d/.test(expr.slice(i + 1)))) {
        continue;
      }
      out.push({ text: expr.slice(start, i), op: false }, { text: char, op: true });
      start = i + 1;
    }
  }
  out.push({ text: expr.slice(start), op: false });

  return out;
}

/**
 * A part of a formula with what is inside each of its outermost brackets put through `each` - the values of min(...)
 * and max(...) one by one.
 */
function brackets(text: string, each: (inner: string) => string): string {
  let out = '';
  let depth = 0;
  let start = 0;
  let many = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '(') {
      if (depth++ === 0) {
        many = /\b(min|max)\s*$/i.test(text.slice(0, i));
        out += text.slice(start, i + 1);
        start = i + 1;
      }
    } else if (char === ')') {
      if (--depth === 0) {
        out += each(text.slice(start, i));
        start = i;
      }
    } else if ((char === ',' || char === ';') && depth === 1 && many) {
      out += each(text.slice(start, i)) + char;
      start = i + 1;
    }
  }

  return out + text.slice(start);
}
