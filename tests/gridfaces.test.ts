// Run: npx tsx tests/gridfaces.test.ts
// Faces pushed, pulled, moved, tilted, slid and deleted, each result held to
// its exact volume: a block's faces, a cylinder's, faces next to rounded
// corners - and faces with holes in them or things standing on them (a top
// pulled up closed the hole through it with a lid; pushed down, it was
// refused because of a boss standing on it).
import { block, bodies, circle, cylinder, done, extrude, poly, rect, sketch, XY, YZ } from './kit';
import { build, edgeRefs, faceRef, near, say } from './grid';
import type { Feature, SketchEntity, Vec3 } from '../src/doc/types';

const WIDTH = 40, DEPTH = 30, HEIGHT = 20;
const featuresA = block('A', WIDTH, DEPTH, HEIGHT);
const VA = WIDTH * DEPTH * HEIGHT;
const q = 1 - Math.PI / 4;
const push = (face: any, distance: number, mode = 'auto'): Feature => ({ id: 'P', name: 'P', type: 'extrude', source: { kind: 'face', face }, distance, mode, target: face.body }) as Feature;
const cutIn = (id: string, es: SketchEntity[], depth: number): Feature[] => {
  const feature = sketch(`${id}-s`, XY(HEIGHT), es);

  return [feature, extrude(id, feature, -depth, 'cut', { target: 'A' })];
};
const standOn = (id: string, es: SketchEntity[], height: number): Feature[] => {
  const feature = sketch(`${id}-s`, XY(HEIGHT), es);

  return [feature, extrude(id, feature, height, 'join', { target: 'A' })];
};
const topAt = (z = HEIGHT) => faceRef('A', (normal, center) => normal[2] > 0.99 && Math.abs(center[2] - z) < 1e-6);
const sound = (got: Awaited<ReturnType<typeof build>>) => !got.errors.length && !got.unsound.length;
const told = (got: Awaited<ReturnType<typeof build>>, body = 'A') => `${got.errors.join(' | ')} ${got.unsound} got ${got.vol[body]?.toFixed(2)}`;

// ------------------------------------------------------------ a block's faces
{
  await build(featuresA);
  const top = topAt();
  const side = faceRef('A', normal => normal[0] > 0.99);
  for (const distance of [-19.99, -10, -0.01, 0.01, 5, 200]) {
    let got = await build([...featuresA, push(top, distance)]);
    say(sound(got) && near(got.vol.A, WIDTH * DEPTH * (HEIGHT + distance), 1e-5), `a block's top, ${distance}`, `${told(got)} want ${(WIDTH * DEPTH * (HEIGHT + distance)).toFixed(3)}`);
    if (Math.abs(distance) < WIDTH) {
      got = await build([...featuresA, push(side, distance)]);
      say(sound(got) && near(got.vol.A, (WIDTH + distance) * DEPTH * HEIGHT, 1e-5), `a block's side, ${distance}`, `${told(got)} want ${((WIDTH + distance) * DEPTH * HEIGHT).toFixed(3)}`);
    }
  }
  for (const distance of [-20, -25]) {
    const got = await build([...featuresA, push(top, distance)]);
    say(got.errors.length > 0 || !got.ids.includes('A'), `a block's top pushed ${-distance} down (all of it): nothing left, or said so`, `${got.errors.join(' | ')} ${JSON.stringify(got.vol)}`);
  }
}

// ------------------------------------------------------------ a cylinder's top and its round face
{
  const featuresC = cylinder('C', 10, 20);
  await build(featuresC);
  const top = faceRef('C', normal => normal[2] > 0.99);
  const round = faceRef('C', (_n, _c, face) => face.geomType === 'CYLINDRE');
  for (const distance of [-5, 3]) {
    let got = await build([...featuresC, push(top, distance)]);
    say(sound(got) && near(got.vol.C, Math.PI * 100 * (20 + distance), 1e-5), `a cylinder's top, ${distance}`, told(got, 'C'));
    got = await build([...featuresC, push(round, distance)]);
    say(sound(got) && near(got.vol.C, Math.PI * (10 + distance) ** 2 * 20, 1e-5), `a cylinder's round face, ${distance} (its radius ${10 + distance})`, `${told(got, 'C')} want ${(Math.PI * (10 + distance) ** 2 * 20).toFixed(2)}`);
  }
}

// ------------------------------------------------------------ next to rounded corners: the rounds go with the face
{
  await build(featuresA);
  const base = [...featuresA, { id: 'F', name: 'F', type: 'fillet', edges: edgeRefs('A', (_m, direction) => Math.abs(direction[2]) > 0.99), radius: 4 } as Feature];
  await build(base);
  const top = topAt();
  const side = faceRef('A', (normal, _c, face) => normal[0] > 0.99 && face.geomType === 'PLANE');
  for (const distance of [-5, -2, 2, 5]) {
    let got = await build([...base, push(top, distance)]);
    say(sound(got) && near(got.vol.A, (WIDTH * DEPTH - 4 * q * 16) * (HEIGHT + distance), 1e-5), `a block with rounded corners: its top, ${distance}`, told(got));
    got = await build([...base, push(side, distance)]);
    say(sound(got) && near(got.vol.A, ((WIDTH + distance) * DEPTH - 4 * q * 16) * HEIGHT, 1e-5), `a block with rounded corners: a side, ${distance} (the rounds move with it)`, `${told(got)} want ${(((WIDTH + distance) * DEPTH - 4 * q * 16) * HEIGHT).toFixed(2)}`);
  }
}

// ------------------------------------------------------------ faces with holes in them, or things standing on them
const holed: [string, Feature[], (d: number) => number, number[]][] = [
  ['a round hole through', [...featuresA, ...cutIn('h', [circle('c', 20, 15, 5)], HEIGHT)], distance => (1200 - 25 * Math.PI) * (HEIGHT + distance), [-5, 0.5, 5, 30]],
  ['two round holes through', [...featuresA, ...cutIn('h', [circle('c', 10, 15, 4), circle('e', 30, 15, 3)], HEIGHT)], distance => (1200 - 25 * Math.PI) * (HEIGHT + distance), [-5, 5]],
  ['a window through', [...featuresA, ...cutIn('h', [rect('r', 10, 10, 30, 20)], HEIGHT)], distance => 1000 * (HEIGHT + distance), [-5, 5]],
  ['a triangle hole through', [...featuresA, ...cutIn('h', [poly('p', [[10, 8], [30, 8], [20, 24]])], HEIGHT)], distance => (1200 - 160) * (HEIGHT + distance), [-5, 5]],
  ['an L-shaped hole through', [...featuresA, ...cutIn('h', [poly('p', [[8, 6], [32, 6], [32, 14], [18, 14], [18, 24], [8, 24]])], HEIGHT)], distance => (1200 - (24 * 8 + 10 * 10)) * (HEIGHT + distance), [-5, 5]],
  ['a blind pocket 8 deep', [...featuresA, ...cutIn('h', [rect('r', 10, 10, 30, 20)], 8)], distance => 1200 * (HEIGHT + distance) - 200 * (8 + distance), [-5, 5]],
  ['a blind round hole 8 deep', [...featuresA, ...cutIn('h', [circle('c', 20, 15, 5)], 8)], distance => 1200 * (HEIGHT + distance) - 25 * Math.PI * (8 + distance), [-5, 5]],
  ['a round boss 10 high on it', [...featuresA, ...standOn('b', [circle('c', 20, 15, 5)], 10)], distance => 1200 * (HEIGHT + distance) + 25 * Math.PI * (10 - distance), [-5, 3]],
  ['a square boss 10 high on it', [...featuresA, ...standOn('b', [rect('r', 15, 10, 25, 20)], 10)], distance => 1200 * (HEIGHT + distance) + 100 * (10 - distance), [-5, 3]],
  ['a hole and a boss', [...featuresA, ...cutIn('h', [circle('c', 10, 15, 4)], HEIGHT), ...standOn('b', [circle('c', 30, 15, 4)], 10)], distance => (1200 - 16 * Math.PI) * (HEIGHT + distance) + 16 * Math.PI * (10 - distance), [-5, 3]],
  ['a hole 1 mm from its edge', [...featuresA, ...cutIn('h', [circle('c', 6, 15, 5)], HEIGHT)], distance => (1200 - 25 * Math.PI) * (HEIGHT + distance), [-5, 5]]
];
for (const [name, base, vol, ds] of holed) {
  for (const distance of ds) {
    await build(base);
    const ref = topAt();
    for (const mode of ['auto', distance > 0 ? 'join' : 'cut']) {
      const got = await build([...base, push(ref, mode === 'cut' ? Math.abs(distance) : distance, mode)]);
      say(sound(got) && got.ids.length === 1 && near(got.vol.A, vol(distance), 1e-5), `a top with ${name}, ${distance > 0 ? 'pulled up' : 'pushed down'} ${Math.abs(distance)} (${mode})`, `${told(got)} want ${vol(distance).toFixed(2)}`);
    }
    const built = await build([...base, { id: 'M', name: 'M', type: 'moveFace', face: ref, translate: [0, 0, distance] } as Feature]);
    say(sound(built) && built.ids.length === 1 && near(built.vol.A, vol(distance), 1e-5), `a top with ${name}, moved ${distance}`, `${told(built)} want ${vol(distance).toFixed(2)}`);
  }
}

// A pocket's floor; the bottom of a block with a hole through; a side with a hole across it.
{
  const pocket = [...featuresA, ...cutIn('h', [rect('r', 10, 10, 30, 20)], 8)];
  await build(pocket);
  const floor = topAt(12);
  for (const distance of [-2, 2, 7]) {
    const got = await build([...pocket, push(floor, distance)]);
    say(sound(got) && near(got.vol.A, 24000 - 200 * (8 - distance), 1e-5), `a pocket's floor, ${distance}`, `${told(got)} want ${(24000 - 200 * (8 - distance)).toFixed(2)}`);
  }
  const through = [...featuresA, ...cutIn('h', [circle('c', 20, 15, 5)], HEIGHT)];
  await build(through);
  const bottom = faceRef('A', normal => normal[2] < -0.99);
  for (const distance of [-5, 5]) {
    const got = await build([...through, push(bottom, distance)]);
    say(sound(got) && near(got.vol.A, (1200 - 25 * Math.PI) * (HEIGHT + distance), 1e-5), `the bottom of a block with a round hole through, ${distance}`, `${told(got)} want ${((1200 - 25 * Math.PI) * (HEIGHT + distance)).toFixed(2)}`);
  }
  const feature = sketch('x-s', YZ(40), [circle('c', 15, 10, 4)]);
  const across = [...featuresA, feature, extrude('x', feature, -40, 'cut', { target: 'A' })];
  await build(across);
  const side = faceRef('A', (normal, center) => normal[0] > 0.99 && Math.abs(center[0] - 40) < 1e-6);
  for (const distance of [-5, 5]) {
    const got = await build([...across, push(side, distance)]);
    say(sound(got) && near(got.vol.A, (600 - 16 * Math.PI) * (40 + distance), 1e-5), `a side with a hole across the block through it, ${distance}`, `${told(got)} want ${((600 - 16 * Math.PI) * (40 + distance)).toFixed(2)}`);
  }
}

// An L-shaped top with a round hole; a cone's top with a hole (its side carries on as a cone).
{
  const sL = sketch('L-s', XY(), [poly('p', [[0, 0], [40, 0], [40, 15], [15, 15], [15, 40], [0, 40]])]);
  const sh = sketch('h-s', XY(10), [circle('c', 28, 7, 3)]);
  const base = [sL, extrude('A', sL, 10), sh, extrude('h', sh, -10, 'cut', { target: 'A' })];
  await build(base);
  const t = faceRef('A', normal => normal[2] > 0.99);
  for (const distance of [-4, 4]) {
    const got = await build([...base, push(t, distance)]);
    say(sound(got) && near(got.vol.A, (975 - 9 * Math.PI) * (10 + distance), 1e-5), `an L's top with a round hole, ${distance}`, `${told(got)} want ${((975 - 9 * Math.PI) * (10 + distance)).toFixed(2)}`);
  }
  const sc = sketch('c-s', XY(), [circle('c', 0, 0, 15)]);
  const sh2 = sketch('h2-s', XY(20), [circle('c', 0, 0, 3)]);
  const cone = [sc, extrude('A', sc, 20, 'new', { taper: 0.5 }), sh2, extrude('h', sh2, -20, 'cut', { target: 'A' })];
  await build(cone);
  const frustum = (height: number, r1: number) => ((Math.PI * height) / 3) * (225 + 15 * r1 + r1 * r1);
  const t2 = faceRef('A', normal => normal[2] > 0.99);
  for (const distance of [-5, 5]) {
    const got = await build([...cone, push(t2, distance)]);
    const volume = frustum(20 + distance, 15 - 0.375 * (20 + distance)) - 9 * Math.PI * (20 + distance);
    say(sound(got) && near(got.vol.A, volume, 3e-4), `a cone's top with a hole through it, ${distance}`, `${told(got)} want ${volume.toFixed(2)}`);
  }
}

// ------------------------------------------------------------ moved, tilted, slid, twisted; a corner and an edge
{
  await build(featuresA);
  const top = topAt();
  const mv = (extra: object): Feature => ({ id: 'M', name: 'M', type: 'moveFace', translate: [0, 0, 0], ...extra }) as Feature;
  let got = await build([...featuresA, mv({ face: top, translate: [0, 0, 7] })]);
  say(sound(got) && near(got.vol.A, WIDTH * DEPTH * 27, 1e-6), "a block's top moved 7 up", told(got));
  for (const ang of [5, 20, -20]) {
    got = await build([...featuresA, mv({ face: top, rotate: { origin: [20, 15, 20], axis: [0, 1, 0], angle: ang } })]);
    say(sound(got) && near(got.vol.A, VA, 1e-6), `a block's top tilted ${ang} about its middle: as much taken as added`, told(got));
  }
  got = await build([...featuresA, mv({ face: top, translate: [10, 0, 0] })]);
  say(sound(got) && near(got.vol.A, VA, 1e-6), "a block's top slid 10 sideways: a leaning block, the same volume", told(got));
  got = await build([...featuresA, mv({ face: top, rotate: { origin: [20, 15, 20], axis: [0, 0, 1], angle: 30 } })]);
  say(sound(got) && got.vol.A > VA * 0.7 && got.vol.A < VA * 1.3, "a block's top turned 30 about its own normal: a twisted block", told(got));
  got = await build([...featuresA, mv({ vertex: { body: 'A', at: [40, 30, 20] }, translate: [0, 0, 10] })]);
  say(sound(got) && got.vol.A > VA && got.vol.A < VA + WIDTH * DEPTH * 10 * 0.5, "a block's corner pulled 10 up", told(got));
  await build(featuresA);
  const edge = edgeRefs('A', midpoint => Math.abs(midpoint[0] - 40) < 1e-6 && Math.abs(midpoint[2] - 20) < 1e-6)[0];
  got = await build([...featuresA, mv({ edge, translate: [0, 0, 10] })]);
  say(sound(got) && near(got.vol.A, VA + (WIDTH * DEPTH * 10) / 2, 1e-6), "a block's top edge lifted 10: a wedge on top", `${told(got)} want ${VA + (WIDTH * DEPTH * 10) / 2}`);
}

// ------------------------------------------------------------ deleted: a fillet's face, a hole's wall, a pocket
{
  await build(featuresA);
  const rounded = [...featuresA, { id: 'F', name: 'F', type: 'fillet', edges: edgeRefs('A', (_m, direction) => Math.abs(direction[2]) > 0.99).slice(0, 1), radius: 5 } as Feature];
  await build(rounded);
  const del = (faces: any[]): Feature => ({ id: 'X', name: 'X', type: 'deleteGeom', body: 'A', faces, edges: [], vertices: [] }) as Feature;
  let got = await build([...rounded, del([faceRef('A', (_n, _c, face) => face.geomType === 'CYLINDRE')])]);
  say(sound(got) && near(got.vol.A, VA, 1e-6), "a fillet's face deleted: the sharp edge is back", told(got));
  const through = [...featuresA, ...cutIn('h', [circle('c', 20, 15, 5)], HEIGHT)];
  await build(through);
  got = await build([...through, del([faceRef('A', (_n, _c, face) => face.geomType === 'CYLINDRE')])]);
  say(sound(got) && near(got.vol.A, VA, 1e-6), "a through hole's wall deleted: the hole closes", told(got));
  const pocket = [...featuresA, ...cutIn('p', [rect('r', 10, 10, 30, 20)], 8)];
  await build(pocket);
  const inside = bodies().get('A')!.faces.filter((face) => {
    const center = face.center.toTuple();

    return center[0] > 9.9 && center[0] < 30.1 && center[1] > 9.9 && center[1] < 20.1 && center[2] < 19.9 && center[2] > 0.1;
  });
  got = await build([...pocket, del(inside.map(face => ({ body: 'A', center: face.center.toTuple() as Vec3, normal: face.normalAt().toTuple() as Vec3, area: 0 })))]);
  say(sound(got) && near(got.vol.A, VA, 1e-6), `a pocket's ${inside.length} faces deleted together: it fills in`, told(got));
}

// ------------------------------------------------------------ a face scaled
{
  await build(featuresA);
  const top = topAt();
  const scaled = (factors: [number, number]): Feature => ({ id: 'S', name: 'S', type: 'scaleFace', face: top, u: [1, 0, 0], factors }) as Feature;
  let got = await build([...featuresA, scaled([0.5, 0.5])]);
  const half = (HEIGHT / 3) * (WIDTH * DEPTH + (WIDTH * DEPTH) / 4 + (WIDTH * DEPTH) / 2);
  say(sound(got) && near(got.vol.A, half, 1e-6), "a block's top scaled to half each way: a frustum", `${told(got)} want ${half}`);
  got = await build([...featuresA, scaled([0.5, 1])]);
  say(sound(got) && near(got.vol.A, (DEPTH * HEIGHT * (WIDTH + WIDTH / 2)) / 2, 1e-6), "a block's top scaled to half along X only", `${told(got)} want ${(DEPTH * HEIGHT * (WIDTH + WIDTH / 2)) / 2}`);
  got = await build([...featuresA, scaled([1.5, 1.5])]);
  const more = (HEIGHT / 3) * (WIDTH * DEPTH + WIDTH * DEPTH * 2.25 + WIDTH * DEPTH * 1.5);
  say(sound(got) && near(got.vol.A, more, 1e-6), "a block's top scaled to 150 %", `${told(got)} want ${more}`);
}
done();
