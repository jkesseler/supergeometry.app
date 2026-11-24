// Run: npx tsx tests/unitchange.test.ts
// The project's unit changed: nothing changes size. Every formula - a variable's, a step's, a sketch dimension's -
// comes to what it came to before, in each unit in turn and back.
import { keepSizes } from '../src/doc/unitChange';
import { kindOfPath } from '../src/doc/params';
import { evaluate, setUnits, setVariables } from '../src/units';
import type { ProjectDoc, Units } from '../src/doc/types';

let failed = 0;
const check = (name: string, ok: boolean, info = '') => {
  if (!ok) {
    failed++;
  }
  console.log(ok ? 'ok  ' : 'FAIL', name, info);
};

const make = (): ProjectDoc =>
  ({
    format: 'super',
    version: 2,
    name: 't',
    units: 'mm',
    variables: [
      { name: 'od', expr: '160' },
      { name: 'bore', expr: '40' },
      { name: 'wall', expr: '10 mm' },
      { name: 'hubD', expr: 'bore + 2*wall' },
      { name: 'pcd', expr: '(od + hubD) / 2' },
      { name: 'n', expr: '6' },
      { name: 'pitch', expr: 'od / n' },
      { name: 'gap', expr: 'od / 2 + 5' },
      { name: 'lip', expr: '3 * 4' },
      { name: 'half', expr: '10 / 4' },
      { name: 'root', expr: 'sqrt(16) + 1' },
      { name: 'inch', expr: '1 in + 2' },
      { name: 'neg', expr: '-(od + 3)' },
      { name: 'tilt', expr: '30 deg' },
      { name: 'small', expr: '1e-3 + 2' },
      { name: 'big', expr: 'max(od, 200) - min(3, bore)' }
    ],
    features: [
      {
        id: 's1',
        name: 'Sketch 01',
        type: 'sketch',
        plane: { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, 0, 1] },
        entities: [],
        constraints: [
          { id: 'c1', type: 'dim', curves: ['a'], prop: 'diameter', value: 0, expr: 'od' },
          { id: 'c2', type: 'dim', curves: ['b'], prop: 'length', value: 0, expr: 'pcd / 2 + 1.5' },
          { id: 'c3', type: 'dim', curves: ['b'], prop: 'angle', value: 0, expr: 'tilt * 2' },
          { id: 'c4', type: 'fix', pts: [{ e: 'a', p: 'c' }], at: [0, 0], atExpr: ['pcd / 2', 'n * 2'] }
        ]
      },
      { id: 'e1', name: 'Extrude 01', type: 'extrude', exprs: { distance: '-(wall + 12)', taper: 'n / 12' } },
      { id: 't1', name: 'Pattern 01', type: 'transform', exprs: { 'op.count': 'n', 'op.translate.0': 'pitch + 2', 'op.rotate.angle': '360 / n' } },
      { id: 't2', name: 'Pattern 02', type: 'transform', exprs: { 'op.count': 'floor(od / 25)', 'op.translate.1': 'n * 10' } }
    ],
    views: [],
    hidden: [],
    pins: [],
    names: {}
  }) as unknown as ProjectDoc;

/** What every formula of the project comes to (mm, degrees, plain numbers). */
function all(doc: ProjectDoc): Record<string, number | null> {
  setUnits(doc.units);
  setVariables(doc.variables);
  const out: Record<string, number | null> = {};
  for (const feature of doc.features as any[]) {
    for (const [path, expr] of Object.entries(feature.exprs ?? {})) {
      out[`${feature.id}.${path}`] = evaluate(expr as string, kindOfPath(path));
    }
    for (const constraint of feature.constraints ?? []) {
      if (constraint.expr) {
        out[`${feature.id}.${constraint.id}`] = evaluate(constraint.expr, constraint.prop === 'angle' ? 'angle' : 'length');
      }
      (constraint.atExpr ?? []).forEach((e: string | null, i: number) => e && (out[`${feature.id}.${constraint.id}.at${i}`] = evaluate(e, 'length')));
    }
  }
  // Each variable as a length too - but for the ones that are counts or angles (those are checked where they are used).
  // (od is used to count with - floor(od / 25) - so it stays a plain number too, and each length made from it is fixed.)
  for (const variable of doc.variables) {
    if (!['n', 'tilt', 'od'].includes(variable.name)) {
      out[`var ${variable.name}`] = evaluate(variable.name, 'length');
    }
  }

  return out;
}

const near = (a: number | null, b: number | null) => a !== null && b !== null && Math.abs(a - b) <= 1e-7 * Math.max(1, Math.abs(a));
const doc = make();
const first = all(doc);
check('every formula reads to begin with', Object.values(first).every(value => value !== null), JSON.stringify(Object.entries(first).filter(([, value]) => value === null)));
check('the bore is 40 mm, the pitch 26.667, the count 6', near(first['var bore'], 40) && near(first['var pitch'], 160 / 6) && first['t1.op.count'] === 6);

// Without it, this is what a change of unit did.
const naive = make();
naive.units = 'in';
check('left alone, inches make the bore 40 in (1016 mm)', near(all(naive)['var bore'], 1016));

let from: Units = 'mm';
for (const to of ['in', 'cm', 'ft', 'm', 'mm', 'in', 'mm'] as Units[]) {
  const result = keepSizes(doc, from, to);
  doc.units = to;
  const now = all(doc);
  const off = Object.keys(first).filter(key => !near(now[key], first[key]));
  check(`${from} to ${to}: every size as it was`, !off.length && !result.lost, off.map(key => `${key}: ${first[key]} -> ${now[key]}`).join('; ') + (result.lost ? ` lost ${result.lost}` : ''));
  from = to;
}
console.log('     ' + doc.variables.map(variable => `${variable.name} = ${variable.expr}`).join(' | '));
check('a count is still a plain number', doc.variables.find(variable => variable.name === 'n')!.expr === '6');
check('an angle is left alone', doc.variables.find(variable => variable.name === 'tilt')!.expr === '30 deg');
check('a length that had its unit is left alone', doc.variables.find(variable => variable.name === 'wall')!.expr === '10 mm');
check('a plain length says its unit', doc.variables.find(variable => variable.name === 'bore')!.expr === '40 mm');
check('one that is counted with stays plain', doc.variables.find(variable => variable.name === 'od')!.expr === '160');
check('a formula of variables only is left alone', doc.variables.find(variable => variable.name === 'hubD')!.expr === 'bore + 2*wall');
// The same unit: nothing touched.
const same = make();
check('no change of unit: nothing rewritten', keepSizes(same, 'mm', 'mm').changed === 0 && JSON.stringify(same) === JSON.stringify(make()));

setUnits('mm');
process.exit(failed ? 1 : 0);
