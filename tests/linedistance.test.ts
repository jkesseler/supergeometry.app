// Run: npx tsx tests/linedistance.test.ts
// A distance between two lines of a sketch: they run the same way, that far apart - measured here from the lines
// themselves. Offered for two lines that are (all but) parallel; two that cross have an angle, not a distance.
import { applicable, solve } from '../src/sketch/constraints';
import type { SketchConstraint, SketchEntity, Vec2 } from '../src/doc/types';

let failed = 0;
const check = (name: string, ok: boolean, info: unknown = '') => {
  if (!ok) {
    failed++;
  }
  console.log(ok ? 'ok  ' : 'FAIL', name, info);
};
const line = (id: string, a: Vec2, b: Vec2): SketchEntity => ({ id, kind: 'line', a, b }) as SketchEntity;
type L = Extract<SketchEntity, { kind: 'line' }>;
const apart = (es: SketchEntity[]) => {
  const [l, m] = es as L[];
  const d = [l.b[0] - l.a[0], l.b[1] - l.a[1]];
  const e = [m.b[0] - m.a[0], m.b[1] - m.a[1]];
  const L1 = Math.hypot(d[0], d[1]);
  const off = (p: Vec2) => Math.abs((p[0] - l.a[0]) * d[1] - (p[1] - l.a[1]) * d[0]) / L1;

  return { ends: [off(m.a), off(m.b)], turn: Math.abs(d[0] * e[1] - d[1] * e[0]) / (L1 * Math.hypot(e[0], e[1])) };
};

const A = line('a', [0, 0], [40, 0]);
const B = line('b', [5, 12], [35, 12]);
check('offered for two lines, not for a line and a circle', applicable('distance', [], [A, B]) && !applicable('distance', [], [A, { id: 'c', kind: 'circle', center: [0, 0], radius: 3 } as SketchEntity]));

for (const want of [20, 5, 0.5, 137]) {
  const c: SketchConstraint = { id: 'd', type: 'distance', curves: ['a', 'b'], value: want };
  const r = solve([A, B], [c]);
  const got = apart(r.entities);
  check(`set to ${want}: both ends of the second that far from the first, still parallel`, r.ok && got.ends.every(x => Math.abs(x - want) < 1e-6) && got.turn < 1e-8, `${got.ends.map(x => x.toFixed(6))} turn ${got.turn.toExponential(1)}`);
}
// A slanted pair, and one a little out of parallel: brought parallel, and to the distance.
{
  const P = line('p', [0, 0], [30, 30]);
  const Q = line('q', [10, 0], [38, 29]);
  const r = solve([P, Q], [{ id: 'd', type: 'distance', curves: ['p', 'q'], value: 8 }]);
  const got = apart(r.entities);
  check('a slanted pair a little out of parallel, set to 8: parallel and 8 apart', r.ok && got.ends.every(x => Math.abs(x - 8) < 1e-6) && got.turn < 1e-8, `${got.ends.map(x => x.toFixed(6))}`);
}
// With the first line held: only the second moves.
{
  const r = solve([A, B], [{ id: 'd', type: 'distance', curves: ['a', 'b'], value: 30 }], { fixed: new Set(['a']) });
  const a = r.entities[0] as L;
  check('the first held: it stays, the second goes to 30', r.ok && a.a[0] === 0 && a.a[1] === 0 && a.b[0] === 40 && a.b[1] === 0 && apart(r.entities).ends.every(x => Math.abs(x - 30) < 1e-6));
}
// Beside other constraints: a rectangle's two sides held 15 apart by it, its other sizes free.
{
  const es = [line('l1', [0, 0], [50, 0]), line('l2', [0, 20], [50, 20]), line('v', [0, 0], [0, 20])];
  const cs: SketchConstraint[] = [
    { id: 'h', type: 'horizontal', curves: ['l1'] },
    { id: 'j1', type: 'coincident', pts: [{ e: 'v', p: 'a' }, { e: 'l1', p: 'a' }] },
    { id: 'j2', type: 'coincident', pts: [{ e: 'v', p: 'b' }, { e: 'l2', p: 'a' }] },
    { id: 'd', type: 'distance', curves: ['l1', 'l2'], value: 15 }
  ];
  const r = solve(es, cs);
  const v = r.entities[2] as L;
  check('joined by an upright between them: the two 15 apart, the upright still joined to both', r.ok && apart(r.entities).ends.every(x => Math.abs(x - 15) < 1e-6) && Math.hypot(v.b[0] - (r.entities[1] as L).a[0], v.b[1] - (r.entities[1] as L).a[1]) < 1e-6);
}
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
