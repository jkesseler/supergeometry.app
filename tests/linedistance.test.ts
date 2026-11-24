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
  const [lineA, lineB] = es as L[];
  const direction = [lineA.b[0] - lineA.a[0], lineA.b[1] - lineA.a[1]];
  const e = [lineB.b[0] - lineB.a[0], lineB.b[1] - lineB.a[1]];
  const L1 = Math.hypot(direction[0], direction[1]);
  const off = (point: Vec2) => Math.abs((point[0] - lineA.a[0]) * direction[1] - (point[1] - lineA.a[1]) * direction[0]) / L1;

  return { ends: [off(lineB.a), off(lineB.b)], turn: Math.abs(direction[0] * e[1] - direction[1] * e[0]) / (L1 * Math.hypot(e[0], e[1])) };
};

const sketchEntityA = line('a', [0, 0], [40, 0]);
const sketchEntityB = line('b', [5, 12], [35, 12]);
check('offered for two lines, not for a line and a circle', applicable('distance', [], [sketchEntityA, sketchEntityB]) && !applicable('distance', [], [sketchEntityA, { id: 'c', kind: 'circle', center: [0, 0], radius: 3 } as SketchEntity]));

for (const want of [20, 5, 0.5, 137]) {
  const sketchConstraint: SketchConstraint = { id: 'd', type: 'distance', curves: ['a', 'b'], value: want };
  const solution = solve([sketchEntityA, sketchEntityB], [sketchConstraint]);
  const got = apart(solution.entities);
  check(`set to ${want}: both ends of the second that far from the first, still parallel`, solution.ok && got.ends.every(x => Math.abs(x - want) < 1e-6) && got.turn < 1e-8, `${got.ends.map(x => x.toFixed(6))} turn ${got.turn.toExponential(1)}`);
}
// A slanted pair, and one a little out of parallel: brought parallel, and to the distance.
{
  const sketchEntity = line('p', [0, 0], [30, 30]);
  const lineQ = line('q', [10, 0], [38, 29]);
  const solution = solve([sketchEntity, lineQ], [{ id: 'd', type: 'distance', curves: ['p', 'q'], value: 8 }]);
  const got = apart(solution.entities);
  check('a slanted pair a little out of parallel, set to 8: parallel and 8 apart', solution.ok && got.ends.every(x => Math.abs(x - 8) < 1e-6) && got.turn < 1e-8, `${got.ends.map(x => x.toFixed(6))}`);
}
// With the first line held: only the second moves.
{
  const solution = solve([sketchEntityA, sketchEntityB], [{ id: 'd', type: 'distance', curves: ['a', 'b'], value: 30 }], { fixed: new Set(['a']) });
  const a = solution.entities[0] as L;
  check('the first held: it stays, the second goes to 30', solution.ok && a.a[0] === 0 && a.a[1] === 0 && a.b[0] === 40 && a.b[1] === 0 && apart(solution.entities).ends.every(x => Math.abs(x - 30) < 1e-6));
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
  const solution = solve(es, cs);
  const entity = solution.entities[2] as L;
  check('joined by an upright between them: the two 15 apart, the upright still joined to both', solution.ok && apart(solution.entities).ends.every(x => Math.abs(x - 15) < 1e-6) && Math.hypot(entity.b[0] - (solution.entities[1] as L).a[0], entity.b[1] - (solution.entities[1] as L).a[1]) < 1e-6);
}
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
