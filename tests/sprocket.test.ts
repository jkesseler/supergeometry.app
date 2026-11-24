// Run: npx tsx tests/sprocket.test.ts - a sprocket built, then changed early
// on: a toothed plate (a star outline), a hub joined on top, a bore with a
// keyway cut through both, five lightening holes (one pin body patterned round
// and taken away), the hub's foot filleted and the bore's mouth chamfered. Each
// step held to its volume worked out by hand; then the tooth count, the holes'
// size and the hub's size are changed in the steps at the start, and every
// later step has to follow (the fillet and the chamfer find their edges again).
import { measureVolume } from '../src/kernel/ocFree';
import { after, bodies, check, circle, done, health, near, poly, rect, sketch, XY, profile } from './kit';
import type { Shape3D } from 'replicad';
import type { Feature, Vec3 } from '../src/doc/types';

const vol = (shape: Shape3D) => Math.abs(measureVolume(shape));
const PI = Math.PI;
const THICKNESS = 6; // plate thickness
const HH = 10; // hub height above the plate
const RB = 5; // bore
const KW = 3, KD = 7; // keyway width, how far out from the axis
const RF = 2; // hub fillet
const CH = 0.5; // bore chamfer
const RO = 30, RR = 25; // teeth: tips, roots
const RP = 19; // the holes' circle

interface Dims { N: number; rh: number; RH: number }

const star = (teeth: number): [number, number][] => Array.from({ length: 2 * teeth }, (_, index) => {
  const a = (index * PI) / teeth; const radius = index % 2 ? RR : RO;

  return [radius * Math.cos(a), radius * Math.sin(a)]; 
});
const keyOverlap = 2 * ((KW / 2 / 2) * Math.sqrt(RB * RB - (KW / 2) ** 2) + ((RB * RB) / 2) * Math.asin(KW / 2 / RB));
// The added fillet (a square less its quarter round), turned round the hub at its centroid.
const filletA = RF * RF * (1 - PI / 4);
const filletX = (RF * (10 - 3 * PI)) / (3 * (4 - PI));

function build(dimensions: Dims): Feature[] {
  const teeth = [poly('t', star(dimensions.N))];
  const hub = [circle('h', 0, 0, dimensions.RH)];
  const bore = [circle('b', 0, 0, RB), rect('k', -KW / 2, 0, KW / 2, KD)];
  const pin = [circle('p', RP, 0, dimensions.rh)];

  return [
    sketch('sTeeth', XY(), teeth),
    { id: 'plate', name: 'Plate', type: 'extrude', source: profile('sTeeth', teeth), distance: THICKNESS, mode: 'new' } as Feature,
    sketch('sHub', XY(THICKNESS), hub),
    { id: 'hub', name: 'Hub', type: 'extrude', source: profile('sHub', hub), distance: HH, mode: 'join', target: 'plate' } as Feature,
    sketch('sBore', XY(THICKNESS + HH), bore),
    { id: 'bore', name: 'Bore', type: 'extrude', source: profile('sBore', bore), distance: -(THICKNESS + HH), mode: 'cut', target: 'plate' } as Feature,
    sketch('sPin', XY(), pin),
    { id: 'pin', name: 'Pin', type: 'extrude', source: profile('sPin', pin), distance: THICKNESS, mode: 'new' } as Feature,
    { id: 'pins', name: 'Pins', type: 'transform', bodies: ['pin'], copy: true, op: { kind: 'circular', axis: { origin: [0, 0, 0], dir: [0, 0, 1] }, count: 5, angle: 360 } } as Feature
  ];
}

function want(dimensions: Dims) {
  const plate = dimensions.N * RO * RR * Math.sin(PI / dimensions.N) * THICKNESS;
  const hub = plate + PI * dimensions.RH * dimensions.RH * HH;
  const bore = hub - PI * RB * RB * (THICKNESS + HH) - (KW * KD - keyOverlap) * (THICKNESS + HH);
  const holes = bore - 5 * PI * dimensions.rh * dimensions.rh * THICKNESS;
  const fillet = holes + filletA * 2 * PI * (dimensions.RH + filletX);

  // (The chamfer runs round the bore's edge, broken by the keyway: about its share of the round.)
  return { plate, hub, bore, holes, fillet };
}

// A tap, as the app stores it (tool.ts edgeRefOf): with the steps and sketch curves of its faces.
 
let last: any;
const edgeAt = (body: string, pick: (m: Vec3) => boolean) =>
   
  (last.bodies.find((b: any) => b.id === body).edges as any[])
    .filter(e => pick(e.mid))
    .map(e => ({ body, mid: e.mid, dir: e.dir, length: e.length, ...(e.steps ? { steps: e.steps } : {}), ...(e.curves ? { curves: e.curves } : {}) }));

async function run(label: string, dimensions: Dims, fs: Feature[] | null) {
  const expected = want(dimensions);
  let steps = build(dimensions);
  let { errors, r } = await after(steps.slice(0, 2));
  check(`${label}: the plate (a ${dimensions.N}-tooth star)`, !errors.length && near(vol(bodies().get('plate') as Shape3D), expected.plate, 1e-6 * expected.plate), [errors, vol(bodies().get('plate') as Shape3D), expected.plate]);
  ({ errors } = await after(steps.slice(0, 4)));
  check(`${label}: the hub joined on`, !errors.length && bodies().size === 1 && near(vol(bodies().get('plate') as Shape3D), expected.hub, 1e-6 * expected.hub), [errors, [...bodies().keys()], vol(bodies().get('plate') as Shape3D), expected.hub]);
  ({ errors } = await after(steps.slice(0, 6)));
  check(`${label}: the bore and keyway through both`, !errors.length && near(vol(bodies().get('plate') as Shape3D), expected.bore, 1e-6 * expected.bore), [errors, vol(bodies().get('plate') as Shape3D), expected.bore]);
  ({ errors } = await after(steps));
  const pins = [...bodies().keys()].filter(key => key.startsWith('pin'));
  check(`${label}: five pins round`, !errors.length && pins.length === 5, [errors, pins]);
  steps.push({ id: 'holes', name: 'Holes', type: 'boolean', op: 'subtract', target: 'plate', tools: pins } as Feature);
  ({ errors, r } = await after(steps));
  last = r;
  check(`${label}: the pins taken away, five holes`, !errors.length && bodies().size === 1 && near(vol(bodies().get('plate') as Shape3D), expected.holes, 1e-6 * expected.holes), [errors, [...bodies().keys()], vol(bodies().get('plate') as Shape3D), expected.holes]);
  if (fs) {
    // The steps after it as first made (their edges picked on the first build).
    steps = [...steps, ...fs];
  } else {
    steps.push({ id: 'foot', name: 'Fillet', type: 'fillet', edges: edgeAt('plate', midpoint => near(midpoint[2], THICKNESS, 1e-6) && near(Math.hypot(midpoint[0], midpoint[1]), dimensions.RH, 1e-4)), radius: RF } as Feature);
  }
  ({ errors, r } = await after(steps.slice(0, steps.findIndex(step => step.id === 'foot') + 1)));
  last = r;
  const vF = vol(bodies().get('plate') as Shape3D);
  check(`${label}: the hub's foot filleted`, !errors.length && near(vF, expected.fillet, 1e-5 * expected.fillet), [errors, vF, expected.fillet]);
  if (!fs) {
    steps.push({ id: 'mouth', name: 'Chamfer', type: 'chamfer', edges: edgeAt('plate', midpoint => near(midpoint[2], THICKNESS + HH, 1e-6) && near(Math.hypot(midpoint[0], midpoint[1]), RB, 1e-4)), radius: CH } as Feature);
  }
  ({ errors } = await after(steps));
  const vC = vol(bodies().get('plate') as Shape3D);
  // The round less the keyway's gap, each a CH x CH half square turned at a third of it out.
  const gap = 2 * Math.asin(KW / 2 / RB);
  const chamfer = ((CH * CH) / 2) * (RB + CH / 3) * (2 * PI - gap);
  check(`${label}: the bore's mouth chamfered (all round but the keyway)`, !errors.length && vF - vC > chamfer * 0.97 && vF - vC < chamfer * 1.03, [errors, vF - vC, chamfer]);
  const bodyHealth = health(bodies().get('plate') as Shape3D, 'plate');
  check(`${label}: sound, one body`, bodyHealth.healthy && bodies().size === 1, bodyHealth.healthy ? `${Math.round(bodyHealth.volume)} mm³` : bodyHealth);

  return steps;
}

const first: Dims = { N: 12, rh: 3, RH: 12 };
const made = await run('first', first, null);
const later = made.slice(made.findIndex(feature => feature.id === 'foot'));
// Changed at the start, the later steps kept as they were.
await run('15 teeth', { ...first, N: 15 }, later);
await run('smaller holes', { ...first, rh: 2.5 }, later);
// (13: at 14 the fillet's foot would reach the holes, at 16 out.)
await run('a bigger hub', { ...first, RH: 13 }, later);
done();
