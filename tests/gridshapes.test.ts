// Run: npx tsx tests/gridshapes.test.ts
// Revolve (eight profiles - off the axis, touching it, a corner on it, a ball,
// a rectangle a micron from it - through seven angles, by Pappus), patterns
// in a row and round an axis (joined where the copies touch or overlap),
// Mirror, Scale (one size and each way its own), Move with a turn, and Split
// (planes across, on a diagonal, on a face, past the body; three at once):
// each held to its exact volume.
import { block, circle, cylinder, done, poly, profile, rect, sketch, XZ } from './kit';
import { build, near, say } from './grid';
import type { Feature, PlaneDef, SketchEntity, Vec3 } from '../src/doc/types';


// ---------------------------------------------------------------- revolve
{
  // Profiles on the front plane (x right, z up), turned about the z axis: Pappus.
  const zAxis = { origin: [0, 0, 0] as Vec3, dir: [0, 0, 1] as Vec3 };
  const shapes: [string, SketchEntity[], number, number][] = [
    // name, entities, area, centroid's distance from the axis
    ['a rectangle off the axis', [rect('r', 10, 0, 20, 8)], 80, 15],
    ['a rectangle touching the axis', [rect('r', 0, 0, 12, 8)], 96, 6],
    ['a circle off the axis (a ring)', [circle('c', 20, 5, 4)], Math.PI * 16, 20],
    ['a triangle with a corner on the axis', [poly('p', [[0, 0], [15, 0], [15, 10]])], 75, 10],
    ['a half disc on the axis (a ball)', [poly('p', [[0, -10], [0, 10]], false), { id: 'a', kind: 'arc', a: [0, -10], m: [10, 0], b: [0, 10] } as any], (Math.PI * 100) / 2, (4 * 10) / (3 * Math.PI)],
    ['a quarter disc, its corner on the axis', [poly('p', [[10, 0], [0, 0], [0, 10]], false), { id: 'a', kind: 'arc', a: [0, 10], m: [Math.SQRT1_2 * 10, Math.SQRT1_2 * 10], b: [10, 0] } as any], (Math.PI * 100) / 4, (4 * 10) / (3 * Math.PI)],
    ['a rectangle 0.001 from the axis', [rect('r', 0.001, 0, 12, 8)], 11.999 * 8, 6.0005],
    ['an L against the axis', [poly('p', [[0, 0], [20, 0], [20, 5], [6, 5], [6, 15], [0, 15]])], 20 * 5 + 6 * 10, (100 * 10 + 60 * 3) / 160]
  ];
  for (const [name, es, ar, rc] of shapes) {
    const feature = sketch('s', XZ(), es);
    const src = profile('s', es);
    for (const angle of [360, 180, 90, 270, -90, 45, 359]) {
      const got = await build([feature, { id: 'R', name: 'R', type: 'revolve', source: src, axis: zAxis, angle, mode: 'new' } as Feature]);
      const volume = (ar * 2 * Math.PI * rc * Math.abs(angle)) / 360;
      say(!got.errors.length && !got.unsound.length && near(got.vol.R, volume, 3e-4), `revolve ${angle}: ${name}`, `${got.errors.join(' | ')} ${got.unsound} got ${got.vol.R?.toFixed(2)} want ${volume.toFixed(2)}`);
    }
  }
}

// ---------------------------------------------------------------- patterns, mirror, scale
{
  const featuresA = block('A', 10, 10, 10, [20, -5, 0]);
  const zAxis = { origin: [0, 0, 0] as Vec3, dir: [0, 0, 1] as Vec3 };
  const tf = (op: object, extra: object = {}): Feature => ({ id: 'T', name: 'T', type: 'transform', bodies: ['A'], copy: false, op, ...extra }) as Feature;
  for (const count of [2, 3, 8, 24]) {
    let got = await build([...featuresA, tf({ kind: 'linear', dir: [1, 0, 0], spacing: 15, count })]);
    say(!got.errors.length && !got.unsound.length && got.ids.length === count && Object.values(got.vol).every(volume => near(volume, 1000, 1e-6)), `linear x ${count}`, `${got.errors.join(' | ')} ${got.unsound} ${got.ids.length} bodies`);
    got = await build([...featuresA, tf({ kind: 'circular', axis: zAxis, angle: 360, count })]);
    say(!got.errors.length && !got.unsound.length && got.ids.length === count && Object.values(got.vol).every(volume => near(volume, 1000, 1e-6)), `circular x ${count}, a full turn`, `${got.errors.join(' | ')} ${got.unsound} ${got.ids.length} bodies`);
    got = await build([...featuresA, tf({ kind: 'circular', axis: zAxis, angle: 90, count })]);
    say(!got.errors.length && !got.unsound.length && got.ids.length === count, `circular x ${count}, a quarter turn`, `${got.errors.join(' | ')} ${got.unsound} ${got.ids.length} bodies`);
    // touching copies joined into one: spacing 10 = the block's own width
    got = await build([...featuresA, tf({ kind: 'linear', dir: [1, 0, 0], spacing: 10, count }), { id: 'U', name: 'U', type: 'boolean', op: 'union', target: 'A', tools: Array.from({ length: count - 1 }, (_, index) => `T:A:${index}`) } as Feature]);
    say(!got.errors.length && !got.unsound.length && got.ids.length === 1 && near(got.vol.A, 1000 * count, 1e-6), `linear x ${count}, touching, joined`, `${got.errors.join(' | ')} ${got.unsound} ${got.ids.length} bodies ${got.vol.A?.toFixed(1)}`);
    // overlapping copies joined: spacing 6
    got = await build([...featuresA, tf({ kind: 'linear', dir: [1, 0, 0], spacing: 6, count }), { id: 'U', name: 'U', type: 'boolean', op: 'union', target: 'A', tools: Array.from({ length: count - 1 }, (_, index) => `T:A:${index}`) } as Feature]);
    say(!got.errors.length && !got.unsound.length && got.ids.length === 1 && near(got.vol.A, 100 * (10 + 6 * (count - 1)), 1e-6), `linear x ${count}, overlapping, joined`, `${got.errors.join(' | ')} ${got.unsound} ${got.ids.length} bodies ${got.vol.A?.toFixed(1)}`);
  }
  // mirror: moved, copied, and the copy joined across the plane it touches
  const pl = (x: number): PlaneDef => ({ origin: [x, 0, 0], xDir: [0, 1, 0], normal: [1, 0, 0] });
  let built = await build([...featuresA, tf({ kind: 'mirror', plane: pl(0) })]);
  say(!built.errors.length && !built.unsound.length && near(built.vol.A, 1000, 1e-6), 'mirror: moved across', `${built.errors.join(' | ')} ${built.unsound}`);
  built = await build([...featuresA, tf({ kind: 'mirror', plane: pl(20) }, { copy: true }), { id: 'U', name: 'U', type: 'boolean', op: 'union', target: 'A', tools: ['T:A:0'] } as Feature]);
  say(!built.errors.length && !built.unsound.length && built.ids.length === 1 && near(built.vol.A, 2000, 1e-6), "mirror: a copy across the block's own face, joined", `${built.errors.join(' | ')} ${built.unsound} ${built.ids} ${built.vol.A?.toFixed(1)}`);
  built = await build([...featuresA, tf({ kind: 'mirror', plane: pl(24) }, { copy: true }), { id: 'U', name: 'U', type: 'boolean', op: 'union', target: 'A', tools: ['T:A:0'] } as Feature]);
  say(!built.errors.length && !built.unsound.length && built.ids.length === 1 && near(built.vol.A, 1200, 1e-6), 'mirror: a copy across a plane through the block, joined (12 wide now)', `${built.errors.join(' | ')} ${built.unsound} ${built.ids} ${built.vol.A?.toFixed(1)}`);
  // scale
  for (const scale of [0.01, 0.5, 2, 37.5]) {
    built = await build([...featuresA, tf({ kind: 'scale', center: [0, 0, 0], factor: scale })]);
    say(!built.errors.length && !built.unsound.length && near(built.vol.A, 1000 * scale ** 3, 1e-6), `scale ${scale}`, `${built.errors.join(' | ')} ${built.unsound} ${built.vol.A}`);
    built = await build([...featuresA, tf({ kind: 'scaleXYZ', center: [25, 0, 5], factors: [scale, 1, 2] })]);
    say(!built.errors.length && !built.unsound.length && near(built.vol.A, 2000 * scale, 1e-6), `scale ${scale} along X, 2 along Z`, `${built.errors.join(' | ')} ${built.unsound} ${built.vol.A}`);
  }
  // scaleXYZ of round and filleted things
  const featuresC = cylinder('C', 10, 20);
  built = await build([...featuresC, { id: 'T', name: 'T', type: 'transform', bodies: ['C'], copy: false, op: { kind: 'scaleXYZ', center: [0, 0, 0], factors: [2, 1, 0.5] } } as Feature]);
  say(!built.errors.length && !built.unsound.length && near(built.vol.C, Math.PI * 100 * 20, 1e-4), 'a cylinder stretched 2 x 1 x 0.5 (an oval post)', `${built.errors.join(' | ')} ${built.unsound} ${built.vol.C}`);
  // move with rotation
  built = await build([...featuresA, tf({ kind: 'move', translate: [5, 6, 7], rotate: { origin: [1, 2, 3], axis: [1, 1, 1], angle: 123 } })]);
  say(!built.errors.length && !built.unsound.length && near(built.vol.A, 1000, 1e-6), 'move and turn', `${built.errors.join(' | ')} ${built.unsound} ${built.vol.A}`);
}

// ---------------------------------------------------------------- split
{
  const featuresA = block('A', 40, 30, 20);
  const planes: [string, PlaneDef, number][] = [
    ['across the middle', { origin: [20, 0, 0], xDir: [0, 1, 0], normal: [1, 0, 0] }, 0.5],
    ['a quarter up', { origin: [0, 0, 5], xDir: [1, 0, 0], normal: [0, 0, 1] }, 0.75],
    ['corner to corner (diagonal)', { origin: [0, 0, 0], xDir: [0, 0, 1], normal: [30 / 50, -40 / 50, 0] }, 0.5],
    ['on a face (nothing to split)', { origin: [40, 0, 0], xDir: [0, 1, 0], normal: [1, 0, 0] }, -1],
    ['past the body', { origin: [50, 0, 0], xDir: [0, 1, 0], normal: [1, 0, 0] }, -1],
    ['through one corner edge only', { origin: [0, 0, 0], xDir: [0, 0, 1], normal: [Math.SQRT1_2, Math.SQRT1_2, 0] }, -1]
  ];
  for (const [name, plane, share] of planes) {
    const got = await build([...featuresA, { id: 'S', name: 'S', type: 'split', body: 'A', plane } as Feature]);
    if (share < 0) {
      say(got.errors.length > 0 && /doesn't cut|Nothing/i.test(got.errors.join()), `split ${name}`, `${got.errors.join(' | ')} ${JSON.stringify(got.vol)}`);
    } else {
      say(!got.errors.length && !got.unsound.length && got.ids.length === 2 && near(got.vol.A + got.vol.S, 24000, 1e-6) && (near(got.vol.A, 24000 * share, 1e-6) || near(got.vol.S, 24000 * share, 1e-6)), `split ${name}`, `${got.errors.join(' | ')} ${got.unsound} ${JSON.stringify(got.vol)}`);
    }
  }
  // A cylinder split through its axis, and off it.
  const featuresC = cylinder('C', 10, 20);
  for (const [name, x, share] of [['through its axis', 0, 0.5], ['off its axis', 5, (Math.acos(0.5) - 0.5 * Math.sqrt(0.75)) / Math.PI]] as const) {
    const got = await build([...featuresC, { id: 'S', name: 'S', type: 'split', body: 'C', plane: { origin: [x, 0, 0], xDir: [0, 1, 0], normal: [1, 0, 0] } } as Feature]);
    const VOLUME = Math.PI * 100 * 20;
    say(!got.errors.length && !got.unsound.length && got.ids.length === 2 && near(got.vol.C + got.vol.S, VOLUME, 1e-5) && (near(got.vol.C, VOLUME * share, 1e-4) || near(got.vol.S, VOLUME * share, 1e-4)), `split a cylinder ${name}`, `${got.errors.join(' | ')} ${got.unsound} ${JSON.stringify(got.vol)} want ${(VOLUME * share).toFixed(2)}`);
  }
  // several planes at once
  const built = await build([...featuresA, { id: 'S', name: 'S', type: 'split', body: 'A', plane: { origin: [10, 0, 0], xDir: [0, 1, 0], normal: [1, 0, 0] }, planes: [{ origin: [30, 0, 0], xDir: [0, 1, 0], normal: [1, 0, 0] }, { origin: [0, 0, 10], xDir: [1, 0, 0], normal: [0, 0, 1] }] } as Feature]);
  say(!built.errors.length && !built.unsound.length && built.ids.length === 6 && near(Object.values(built.vol).reduce((a, b) => a + b, 0), 24000, 1e-6), 'split by three planes at once: six pieces', `${built.errors.join(' | ')} ${built.unsound} ${built.ids.length} ${JSON.stringify(built.vol)}`);
}
done();
