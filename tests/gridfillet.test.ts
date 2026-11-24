// Run: npx tsx tests/gridfillet.test.ts
// Fillets and chamfers on a block's edges (one, the four upright ones, the
// top's, all twelve), a cylinder's rims and an L's inside edge, at sizes from
// half a millimetre up to the biggest that fits, each held to its exact
// volume (a round takes (1 - pi/4) r^2 per unit length, a chamfer r^2 / 2;
// an inside edge gains as much). Exactly at the limit a refusal in words is
// fine; a wrong shape is not.
import { block, cylinder, done, extrude, poly, sketch, XY } from './kit';
import { build, edgeRefs, near, say } from './grid';
import type { Feature, Vec3 } from '../src/doc/types';

const WIDTH = 40, DEPTH = 30, HEIGHT = 20;
const featuresA = block('A', WIDTH, DEPTH, HEIGHT);
const VA = WIDTH * DEPTH * HEIGHT;
const vertical = (midpoint: Vec3, direction: Vec3) => Math.abs(direction[2]) > 0.99;
const topLoop = (midpoint: Vec3, direction: Vec3) => Math.abs(midpoint[2] - HEIGHT) < 1e-6 && Math.abs(direction[2]) < 0.01;
const edge = (type: 'fillet' | 'chamfer', edges: any[], radius: number, extra: object = {}): Feature => ({ id: 'F', name: 'F', type, edges, radius, ...extra }) as Feature;
const q = 1 - Math.PI / 4;

await build(featuresA);
const sets: [string, any[], (r: number) => number | null, (r: number) => number | null, number][] = [
  // name, edges, fillet volume removed, chamfer volume removed, biggest size that fits
  ['one vertical edge', edgeRefs('A', vertical).slice(0, 1), radius => q * radius * radius * HEIGHT, radius => (radius * radius * HEIGHT) / 2, 30],
  ['the four vertical edges', edgeRefs('A', vertical), radius => 4 * q * radius * radius * HEIGHT, radius => 2 * radius * radius * HEIGHT, 15],
  ['one top edge', edgeRefs('A', (midpoint, direction) => topLoop(midpoint, direction) && Math.abs(direction[0]) > 0.99).slice(0, 1), radius => q * radius * radius * WIDTH, radius => (radius * radius * WIDTH) / 2, 20],
  ['two opposite top edges', edgeRefs('A', (midpoint, direction) => topLoop(midpoint, direction) && Math.abs(direction[0]) > 0.99), radius => 2 * q * radius * radius * WIDTH, radius => radius * radius * WIDTH, 15],
  // (The four top edges: the chamfers overlap at the corners - each corner's pyramid, radius^3 / 3, counted once.)
  ['the four top edges', edgeRefs('A', topLoop), () => null, radius => radius * radius * (WIDTH + DEPTH) - (4 / 3) * radius ** 3, 10],
  ['all twelve edges', edgeRefs('A', () => true), () => null, () => null, 9]
];
for (const [name, edges, fv, cv, limit] of sets) {
  if (!edges.length) {
    say(false, name, 'no edges found'); continue; 
  }
  for (const radius of [0.5, 2, 5, limit * 0.6, limit * 0.999, limit]) {
    for (const type of ['fillet', 'chamfer'] as const) {
      const got = await build([...featuresA, edge(type, edges, radius)]);
      const rem = type === 'fillet' ? fv(radius) : cv(radius);
      const okVol = rem === null ? got.vol.A < VA && got.vol.A > VA * 0.3 : near(got.vol.A, VA - rem, 2e-4);
      // exactly at the limit OpenCascade may refuse: a refusal in words is fine there, a wrong shape is not
      const atLimit = radius === limit;
      const refused = got.errors.length > 0 && /doesn't fit|too big|smaller/i.test(got.errors.join());
      say((atLimit && refused) || (!got.errors.length && !got.unsound.length && okVol), `${type} ${radius.toFixed(3)} on ${name}`, `${got.errors.join(' | ')} ${got.unsound} got ${got.vol.A?.toFixed(2)} want ${rem === null ? '?' : (VA - rem).toFixed(2)}`);
    }
  }
}

// Variable, chord, two-distance, G2, setback: sound, and between the plain sizes.
await build(featuresA);
const V4 = edgeRefs('A', vertical), V1 = V4.slice(0, 1), T4 = edgeRefs('A', topLoop), ALL = edgeRefs('A', () => true);
for (const [name, extra, type] of [['variable 2..5', { radius2: 5 }, 'fillet'], ['by chord 3', { chord: true }, 'fillet'], ['G2', { g2: true }, 'fillet'], ['two distances 2, 4', { distance2: 4 }, 'chamfer'], ['two distances, flipped', { distance2: 4, flip: true }, 'chamfer']] as const) {
  for (const [sname, edges] of [['one vertical edge', V1], ['the four vertical edges', V4], ['the four top edges', T4], ['all twelve', ALL]] as const) {
    const got = await build([...featuresA, edge(type, edges as any[], name.startsWith('by chord') ? 3 : 2, extra)]);
    say(!got.errors.length && !got.unsound.length && got.vol.A < VA && got.vol.A > VA * 0.8, `${type} ${name} on ${sname}`, `${got.errors.join(' | ')} ${got.unsound} got ${got.vol.A?.toFixed(2)} of ${VA}`);
  }
}

// Setback (a rounded corner where three rounds meet): all the edges round the corners, a setback that reaches past them.
for (const setback of [4, 6]) {
  const got = await build([...featuresA, edge('fillet', ALL, 2, { setback })]);
  say(!got.errors.length && !got.unsound.length && got.vol.A < VA && got.vol.A > VA * 0.9, `fillet 2 with setback ${setback} on all twelve`, `${got.errors.join(' | ')} ${got.unsound} got ${got.vol.A?.toFixed(2)} of ${VA}`);
}
{
  const got = await build([...featuresA, edge('fillet', V4, 2, { setback: 4 })]);
  say(/Setback joins corners/.test(got.errors.join()), 'setback with no corner where three rounds meet: said so', got.errors.join(' | '));
}

// A cylinder's rims.
{
  const featuresC = cylinder('C', 10, 20, 0, 0, 0);
  await build(featuresC);
  const VC = Math.PI * 100 * 20;
  const rims = edgeRefs('C', (midpoint, direction, e) => e.geomType === 'CIRCLE');
  // (A hair under the cylinder's own radius leaves a top next to nothing: refused, in words.)
  const refusal = /doesn't fit|too big|smaller|hair-thin/i;
  for (const radius of [1, 4, 9, 9.999, 10]) {
    // A rim rounded: what is between the corner and the arc (area q·radius^2, its middle radius·(10 - 3 pi) / (12 - 3 pi) in from the corner), turned round the axis.
    const cg = (radius * (10 - 3 * Math.PI)) / (12 - 3 * Math.PI);
    const one = q * radius * radius * 2 * Math.PI * (10 - cg);
    for (const [which, edges, count] of [['top rim', rims.filter(e => e.mid[2] > 10), 1], ['both rims', rims, 2]] as const) {
      let got = await build([...featuresC, { id: 'F', name: 'F', type: 'fillet', edges, radius: radius } as Feature]);
      const refused = got.errors.length > 0 && refusal.test(got.errors.join());
      say((radius >= 9.999 && refused) || (!got.errors.length && !got.unsound.length && near(got.vol.C, VC - count * one, 3e-4)), `fillet ${radius} on a cylinder's ${which}`, `${got.errors.join(' | ')} ${got.unsound} got ${got.vol.C?.toFixed(2)} want ${(VC - count * one).toFixed(2)}`);
      // Chamfered: a triangle radius by radius, its middle radius / 3 in from the corner.
      const cone = (radius * radius * 0.5) * 2 * Math.PI * (10 - radius / 3);
      got = await build([...featuresC, { id: 'F', name: 'F', type: 'chamfer', edges, radius: radius } as Feature]);
      const refused2 = got.errors.length > 0 && refusal.test(got.errors.join());
      say((radius >= 9.999 && refused2) || (!got.errors.length && !got.unsound.length && near(got.vol.C, VC - count * cone, 3e-4)), `chamfer ${radius} on a cylinder's ${which}`, `${got.errors.join(' | ')} ${got.unsound} got ${got.vol.C?.toFixed(2)} want ${(VC - count * cone).toFixed(2)}`);
    }
  }
}

// An L-shaped block: the inside (concave) edge filleted adds material, chamfered too.
{
  const feature = sketch('s', XY(), [poly('p', [[0, 0], [40, 0], [40, 15], [15, 15], [15, 40], [0, 40]])]);
  const features = [feature, extrude('L', feature, 10)];
  await build(features);
  const VL = (40 * 15 + 15 * 25) * 10;
  const inner = edgeRefs('L', (midpoint, direction) => Math.abs(direction[2]) > 0.99 && Math.abs(midpoint[0] - 15) < 1e-6 && Math.abs(midpoint[1] - 15) < 1e-6);
  for (const radius of [1, 5, 14, 20]) {
    let got = await build([...features, { id: 'F', name: 'F', type: 'fillet', edges: inner, radius: radius } as Feature]);
    say(!got.errors.length && !got.unsound.length && near(got.vol.L, VL + q * radius * radius * 10, 2e-4), `fillet ${radius} on an L's inside edge`, `${got.errors.join(' | ')} ${got.unsound} got ${got.vol.L?.toFixed(2)} want ${(VL + q * radius * radius * 10).toFixed(2)}`);
    got = await build([...features, { id: 'F', name: 'F', type: 'chamfer', edges: inner, radius: radius } as Feature]);
    say(!got.errors.length && !got.unsound.length && near(got.vol.L, VL + (radius * radius * 10) / 2, 2e-4), `chamfer ${radius} on an L's inside edge`, `${got.errors.join(' | ')} ${got.unsound} got ${got.vol.L?.toFixed(2)} want ${(VL + (radius * radius * 10) / 2).toFixed(2)}`);
  }
  // every vertical edge at once (five convex, one concave)
  await build(features);
  const all = edgeRefs('L', (midpoint, direction) => Math.abs(direction[2]) > 0.99);
  for (const radius of [1, 3, 6]) {
    const got = await build([...features, { id: 'F', name: 'F', type: 'fillet', edges: all, radius: radius } as Feature]);
    say(!got.errors.length && !got.unsound.length && near(got.vol.L, VL - 4 * q * radius * radius * 10, 2e-4), `fillet ${radius} on all six vertical edges of an L (five out, one in)`, `${got.errors.join(' | ')} ${got.unsound} got ${got.vol.L?.toFixed(2)} want ${(VL - 4 * q * radius * radius * 10).toFixed(2)}`);
  }
}
done();
