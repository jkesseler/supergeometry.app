// Run: npx tsx tests/cornerdrag.test.ts
// Dragging a corner of a rectangle or polygon: the shape becomes lines joined
// at the corners; only that corner (and, for a rectangle, its square-ness) moves.
import assert from 'node:assert/strict';
import { constraintError, pointOf, solve, touchingEnds } from '../src/sketch/constraints';
import { explodeJoined } from '../src/sketch/edit';
import type { SketchEntity } from '../src/doc/types';

let count = 0;
const id = () => `n${count++}`;
const near = (a: number[] | null, b: number[], tol = 2e-3) => !!a && Math.hypot(a[0] - b[0], a[1] - b[1]) < tol;

const checks: [string, () => void][] = [
  ['rectangle corner drag: corners stay joined, opposite corner stays, still a rectangle', () => {
    const sketchEntity: SketchEntity = { id: 'r', kind: 'rect', center: [0, 0], w: 100, h: 60, rotation: 0 };
    const out = explodeJoined(sketchEntity, [{ id: 'dw', type: 'dim', curves: ['r'], prop: 'w', value: 100 }], id)!;
    assert.equal(out.lines.length, 4);
    const k0 = out.ref({ e: 'r', p: 'k0' })!;
    // Width dimension became the bottom side's length: drop it to drag freely.
    const cs = out.constraints.filter(constraint => constraint.type !== 'dim');
    const solution = solve(out.lines, cs, { drag: [{ ref: k0, to: [-70, -50] }] });
    assert.ok(solution.ok);
    assert.ok(constraintError(solution.entities, cs) < 1e-6);
    assert.ok(near(pointOf(solution.entities.find(e => e.id === k0.e)!, 'a'), [-70, -50]));
    // Opposite corner (end of side 1) held where it was.
    assert.ok(near(pointOf(solution.entities[1], 'b'), [50, 30], 1e-3));
    const [a, b, lineC, lineD] = solution.entities as Extract<SketchEntity, { kind: 'line' }>[];
    assert.ok(Math.abs(a.a[1] - a.b[1]) < 1e-6 && Math.abs(b.a[0] - b.b[0]) < 1e-6 && Math.abs(lineC.a[1] - lineC.b[1]) < 1e-6 && Math.abs(lineD.a[0] - lineD.b[0]) < 1e-6);
    assert.ok(out.constraints.some(constraint => constraint.type === 'dim' && constraint.prop === 'length' && constraint.curves?.[0] === out.lines[0].id));
  }],
  ['turned rectangle stays square', () => {
    const sketchEntity: SketchEntity = { id: 'r', kind: 'rect', center: [0, 0], w: 100, h: 60, rotation: 0.4 };
    const out = explodeJoined(sketchEntity, [], id)!;
    const solution = solve(out.lines, out.constraints, { drag: [{ ref: out.ref({ e: 'r', p: 'k2' })!, to: [80, 70] }] });
    assert.ok(solution.ok && constraintError(solution.entities, out.constraints) < 1e-6);
    const [a, b] = solution.entities as Extract<SketchEntity, { kind: 'line' }>[];
    const da = [a.b[0] - a.a[0], a.b[1] - a.a[1]];
    const db = [b.b[0] - b.a[0], b.b[1] - b.a[1]];
    assert.ok(Math.abs(da[0] * db[0] + da[1] * db[1]) / Math.hypot(...da) / Math.hypot(...db) < 1e-6);
  }],
  ['polygon corner drag moves only that corner', () => {
    const sketchEntity: SketchEntity = { id: 'p', kind: 'polygon', center: [0, 0], radius: 50, sides: 6, angle: 0 };
    const out = explodeJoined(sketchEntity, [], id)!;
    const before = out.lines.map(line => pointOf(line, 'a')!);
    const solution = solve(out.lines, out.constraints, { drag: [{ ref: out.ref({ e: 'p', p: 'k0' })!, to: [70, 10] }] });
    assert.ok(solution.ok);
    assert.ok(near(pointOf(solution.entities[0], 'a'), [70, 10]));
    assert.ok(near(pointOf(solution.entities[5], 'b'), [70, 10]));
    for (let i = 1; i < 6; i++) {
      assert.ok(near(pointOf(solution.entities[i], 'a'), before[i], 1e-3), `corner ${i} moved`);
    }
  }],
  ['a coincident to a corner follows to the line end', () => {
    const sketchEntity: SketchEntity = { id: 'r', kind: 'rect', center: [0, 0], w: 10, h: 10, rotation: 0 };
    const out = explodeJoined(sketchEntity, [{ id: 'c1', type: 'coincident', pts: [{ e: 'r', p: 'k1' }, { e: 'x', p: 'a' }] }, { id: 'c2', type: 'coincident', pts: [{ e: 'r', p: 'c' }, { e: 'x', p: 'b' }] }], id)!;
    const c1 = out.constraints.find(constraint => constraint.id === 'c1')!;
    assert.deepEqual(c1.pts![0], { e: out.lines[1].id, p: 'a' });
    assert.ok(!out.constraints.some(constraint => constraint.id === 'c2'));
  }],
  ['constraints deleted: the touching ends are found again to join', () => {
    const sketchEntity: SketchEntity = { id: 'r', kind: 'rect', center: [0, 0], w: 100, h: 60, rotation: 0 };
    const out = explodeJoined(sketchEntity, [], id)!;
    const ids = new Set(out.lines.map(line => line.id));
    // Joined: nothing to add.
    assert.equal(touchingEnds(out.lines, out.constraints, ids).length, 0);
    // All deleted: the 4 corners.
    assert.equal(touchingEnds(out.lines, [], ids).length, 4);
    // Only one line picked: its 2 ends.
    assert.equal(touchingEnds(out.lines, [], new Set([out.lines[0].id])).length, 2);
    // A line elsewhere: nothing.
    assert.equal(touchingEnds([...out.lines, { id: 'far', kind: 'line', a: [500, 0], b: [600, 0] }], [], new Set(['far'])).length, 0);
  }]
];
let failed = 0;
for (const [name, run] of checks) {
  try {
    run(); console.log(`ok   ${name}`); 
  } catch (e) {
    failed++; console.log(`FAIL ${name}\n     ${(e as Error).message}`); 
  }
}
if (failed) {
  process.exit(1);
}
console.log('all corner-drag checks passed');
