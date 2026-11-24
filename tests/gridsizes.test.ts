// Run: npx tsx tests/gridsizes.test.ts
// The same small part built at six sizes, from a hundredth of its size (a
// block 0.4 mm long, its walls 15 microns) to a thousand times (40 metres): a hole, rounds, a
// face pulled, a boss, a chamfer, a pocket, its floor rounded, a shell, a
// split, a pattern joined - and a ring revolved, a loft, a sweep and a bridge.
// Every step must work at every size, and the volumes scale as the cube.
import { circle, done, extrude, profile, rect, sketch, XY, XZ } from './kit';
import { build, edgeRefs, faceRef, near, say } from './grid';
import type { Feature, Vec3 } from '../src/doc/types';

const sizes = [0.01, 0.1, 1, 10, 100, 1000];
const results = new Map<string, Map<number, number | string>>();
const note = (step: string, scale: number, value: number | string) => (results.get(step) ?? results.set(step, new Map()).get(step)!).set(scale, value);

for (const size of sizes) {
  const s0 = sketch('s0', XY(), [rect('r', 0, 0, 40 * size, 30 * size)]);
  let fs: Feature[] = [s0, extrude('A', s0, 20 * size)];
  const step = async (name: string, add: () => Feature[] | Promise<Feature[]>, body = 'A') => {
    let extra: Feature[];
    try {
      extra = await add();
    } catch (e) {
      note(name, size, 'refs: ' + String((e as Error).message ?? e).slice(0, 60));

      return;
    }
    const got = await build([...fs, ...extra], { T: 0 });
    if (got.errors.length) {
      note(name, size, got.errors.join(' | ').slice(0, 90));
    } else if (got.unsound.filter(problem => !problem.startsWith('T:')).length) {
      note(name, size, 'unsound: ' + got.unsound.join(', '));
    } else {
      note(name, size, got.vol[body] / size ** 3);
      fs = [...fs, ...extra];
    }
    await build(fs);
  };
  await build(fs);
  await step('block', () => []);
  await step('a round hole through', () => {
    const feature = sketch('s1', XY(20 * size), [circle('c', 20 * size, 15 * size, 5 * size)]);

    return [feature, extrude('h', feature, -20 * size, 'cut', { target: 'A' })]; 
  });
  await step('fillet the four upright edges', () => [{ id: 'F', name: 'F', type: 'fillet', edges: edgeRefs('A', (midpoint, direction, e) => Math.abs(direction[2]) > 0.99 && e.geomType === 'LINE' && (Math.abs(midpoint[0]) < 1e-6 * size || Math.abs(midpoint[0] - 40 * size) < 1e-6 * size)), radius: 4 * size } as Feature]);
  await step('pull the top up', () => [{ id: 'P', name: 'P', type: 'extrude', source: { kind: 'face', face: faceRef('A', normal => normal[2] > 0.99) }, distance: 5 * size, mode: 'auto', target: 'A' } as Feature]);
  await step('a boss on top', () => {
    const feature = sketch('s2', XY(25 * size), [circle('c', 10 * size, 15 * size, 3 * size)]);

    return [feature, extrude('b', feature, 6 * size, 'join', { target: 'A' })]; 
  });
  await step("chamfer the boss's rim", () => [{ id: 'C', name: 'C', type: 'chamfer', edges: edgeRefs('A', (midpoint, direction, e) => e.geomType === 'CIRCLE' && Math.abs(midpoint[2] - 31 * size) < 1e-6 * size), radius: 1 * size } as Feature]);
  await step('a pocket', () => {
    const feature = sketch('s3', XY(25 * size), [rect('r', 27 * size, 4 * size, 35 * size, 10 * size)]);

    return [feature, extrude('p', feature, -8 * size, 'cut', { target: 'A' })]; 
  });
  await step("fillet the pocket's floor edges", () => [{ id: 'F2', name: 'F2', type: 'fillet', edges: edgeRefs('A', (midpoint, direction) => Math.abs(midpoint[2] - 17 * size) < 1e-6 * size && Math.abs(direction[2]) < 0.01), radius: 1 * size } as Feature]);
  await step('shell, bottom open', () => [{ id: 'S', name: 'S', type: 'shell', body: 'A', faces: [faceRef('A', normal => normal[2] < -0.99)], thickness: 1.5 * size } as Feature]);
  await step('split in two', () => [{ id: 'X', name: 'X', type: 'split', body: 'A', plane: { origin: [20 * size, 0, 0], xDir: [0, 1, 0], normal: [1, 0, 0] } } as Feature]);
  await step('a pattern of three, joined', () => [
    { id: 'T', name: 'T', type: 'transform', bodies: ['X'], copy: false, op: { kind: 'linear', dir: [0, 1, 0], spacing: 25 * size, count: 3 } } as Feature,
    { id: 'U', name: 'U', type: 'boolean', op: 'union', target: 'X', tools: ['T:X:0', 'T:X:1'] } as Feature
  ], 'X');
}
// Separate small things at each size.
for (const size of sizes) {
  const zAxis = { origin: [0, 0, 0] as Vec3, dir: [0, 0, 1] as Vec3 };
  const es: any[] = [rect('r', 10 * size, 0, 20 * size, 8 * size)];
  let got = await build([sketch('s', XZ(), es), { id: 'R', name: 'R', type: 'revolve', source: profile('s', es), axis: zAxis, angle: 360, mode: 'new' } as Feature]);
  note('revolve a ring', size, got.errors.length ? got.errors.join(' | ').slice(0, 80) : got.unsound.length ? 'unsound: ' + got.unsound : got.vol.R / size ** 3);
  const a = [circle('c', 0, 0, 10 * size)], b = [rect('r', -6 * size, -6 * size, 6 * size, 6 * size)];
  got = await build([sketch('s1', XY(0), a), sketch('s2', XY(30 * size), b), { id: 'L', name: 'L', type: 'loft', sections: [profile('s1', a), profile('s2', b)], ruled: false, mode: 'new' } as Feature]);
  note('loft a circle to a square', size, got.errors.length ? got.errors.join(' | ').slice(0, 80) : got.unsound.length ? 'unsound: ' + got.unsound : got.vol.L / size ** 3);
  const profileEntities = [circle('c', 0, 0, 3 * size)];
  const q = [{ id: 'sp', kind: 'spline', points: [[0, 0], [2 * size, 15 * size], [15 * size, 30 * size], [35 * size, 35 * size]], closed: false, mode: 'fit' } as any];
  got = await build([sketch('sp', XY(0), profileEntities), sketch('sq', XZ(), q), { id: 'W', name: 'W', type: 'sweep', source: profile('sp', profileEntities), path: { kind: 'sketch', sketch: 'sq', entities: ['sp'] }, mode: 'new' } as Feature]);
  note('sweep a circle along a spline', size, got.errors.length ? got.errors.join(' | ').slice(0, 80) : got.unsound.length ? 'unsound: ' + got.unsound : got.vol.W / size ** 3);
  // Connect two blocks
  const sa = sketch('sa', XY(), [rect('r', 0, 0, 20 * size, 20 * size)]), sb = sketch('sb', XY(50 * size), [rect('r', 30 * size, 0, 50 * size, 20 * size)]);
  const two = [sa, extrude('A', sa, 10 * size), sb, extrude('B', sb, 10 * size)];
  await build(two);
  try {
    const fa = faceRef('A', normal => normal[2] > 0.99), fb = faceRef('B', normal => normal[2] < -0.99);
    got = await build([...two, { id: 'cn', name: 'cn', type: 'connect', faces: [fa, fb], mode: 'join' } as Feature]);
    note('connect two blocks', size, got.errors.length ? got.errors.join(' | ').slice(0, 80) : got.unsound.length ? 'unsound: ' + got.unsound : got.vol.A / size ** 3);
  } catch (e) {
    note('connect two blocks', size, String(e).slice(0, 60)); 
  }
}
for (const [step, result] of results) {
  const ref = result.get(1);
  for (const size of sizes) {
    const value = result.get(size);
    const ok = typeof value === 'number' && typeof ref === 'number' && near(value, ref, 2e-4);
    say(ok, `${step} at x${size}`, typeof value === 'number' ? `${value.toFixed(3)} per unit cube, at x1: ${typeof ref === 'number' ? ref.toFixed(3) : ref}` : String(value));
  }
}
done();
