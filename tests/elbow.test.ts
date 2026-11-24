// Run: npx tsx tests/elbow.test.ts - a pipe elbow: a ring (10 out, 7 in)
// swept round an arc (Pappus: the ring's area times the arc's length, to a
// millionth - its faces swept, measured by our own integrator), a flange
// pulled down from its start and joined, four bolt holes (a pin patterned
// round, taken away), the pipe's foot filleted onto the flange. Then the bend
// changed at the start - 60°, 135°, a tighter radius - and every step after
// follows.
import { measureVolume } from '../src/kernel/ocFree';
import { after, bodies, check, circle, done, health, near, sketch, XY, XZ, profile } from './kit';
import type { Shape3D } from 'replicad';
import type { Feature, SketchEntity, Vec3 } from '../src/doc/types';

const vol = (id: string) => Math.abs(measureVolume(bodies().get(id) as Shape3D));
const PI = Math.PI;
const RO = 10, RI = 7; // the pipe
const RFL = 20, TF = 5; // the flange
const RBC = 15, RH = 2; // bolt circle, holes
const RF = 1.5; // the fillet

 
let last: any;
const edgeAt = (body: string, pick: (m: Vec3) => boolean) =>
   
  (last.bodies.find((b: any) => b.id === body).edges as any[])
    .filter(e => pick(e.mid))
    .map(e => ({ body, mid: e.mid, dir: e.dir, length: e.length, ...(e.steps ? { steps: e.steps } : {}), ...(e.curves ? { curves: e.curves } : {}) }));

function start(radius: number, deg: number): Feature[] {
  const th = (deg * PI) / 180;
  // The bend in the front plane (its x out, its y up): from the origin, up, round to +x.
  const path = [{ id: 'bend', kind: 'arc', a: [0, 0], m: [radius - radius * Math.cos(th / 2), radius * Math.sin(th / 2)], b: [radius - radius * Math.cos(th), radius * Math.sin(th)] } as SketchEntity];
  const ring = [circle('o', 0, 0, RO), circle('i', 0, 0, RI)];
  const flange = [circle('fo', 0, 0, RFL), circle('fi', 0, 0, RI)];

  return [
    sketch('sPath', XZ(), path),
    sketch('sRing', XY(), ring),
    // (The ring only: not the hole inside it.)
    { id: 'pipe', name: 'Sweep', type: 'sweep', source: profile('sRing', ring, rs => rs.filter(regionRef => near(regionRef.a, PI * (RO * RO - RI * RI), 2))), path: { kind: 'sketch', sketch: 'sPath', entities: ['bend'] }, mode: 'new' } as Feature,
    sketch('sFlange', XY(), flange),
    { id: 'flange', name: 'Flange', type: 'extrude', source: profile('sFlange', flange, rs => rs.filter(regionRef => near(regionRef.a, PI * (RFL * RFL - RI * RI), 2))), distance: -TF, mode: 'join', target: 'pipe' } as Feature,
    sketch('sPin', XY(-TF - 1), [circle('p', RBC, 0, RH)]),
    { id: 'pin', name: 'Pin', type: 'extrude', source: profile('sPin', [circle('p', RBC, 0, RH)]), distance: TF + 1.5, mode: 'new' } as Feature,
    { id: 'pins', name: 'Pins', type: 'transform', bodies: ['pin'], copy: true, op: { kind: 'circular', axis: { origin: [0, 0, 0], dir: [0, 0, 1] }, count: 4, angle: 360 } } as Feature
  ];
}

async function run(label: string, radius: number, deg: number, more: Feature[] | null) {
  const th = (deg * PI) / 180;
  const vPipe = PI * (RO * RO - RI * RI) * radius * th;
  let fs = start(radius, deg).slice(0, 3);
  let { errors, r } = await after(fs);
  check(`${label}: the ring swept round ${deg}° at ${radius} (Pappus)`, !errors.length && near(vol('pipe'), vPipe, 1e-6 * vPipe), [errors, vol('pipe'), vPipe]);
  const vFl = vPipe + PI * (RFL * RFL - RI * RI) * TF;
  fs = start(radius, deg).slice(0, 5);
  ({ errors } = await after(fs));
  check(`${label}: the flange joined below it`, !errors.length && bodies().size === 1 && near(vol('pipe'), vFl, 1e-6 * vFl), [errors, [...bodies().keys()], vol('pipe'), vFl]);
  fs = start(radius, deg);
  ({ errors } = await after(fs));
  const pins = [...bodies().keys()].filter(key => key.startsWith('pin'));
  check(`${label}: four pins round`, !errors.length && pins.length === 4, [errors, pins]);
  fs.push(more ? more[0] : ({ id: 'bolts', name: 'Bolt holes', type: 'boolean', op: 'subtract', target: 'pipe', tools: pins } as Feature));
  ({ errors, r } = await after(fs));
  last = r;
  const vHoles = vFl - 4 * PI * RH * RH * TF;
  check(`${label}: four bolt holes`, !errors.length && bodies().size === 1 && near(vol('pipe'), vHoles, 1e-6 * vHoles), [errors, [...bodies().keys()], vol('pipe'), vHoles]);
  fs.push(more ? more[1] : ({ id: 'foot', name: 'Fillet', type: 'fillet', edges: edgeAt('pipe', midpoint => near(midpoint[2], 0, 1e-6) && near(Math.hypot(midpoint[0], midpoint[1]), RO, 1e-4)), radius: RF } as Feature));
  ({ errors } = await after(fs));
  // (Round a straight pipe it would add a quarter-round's corner turned at its centroid; the bend starts at once, so about that.)
  const add = RF * RF * (1 - PI / 4) * 2 * PI * (RO + (RF * (10 - 3 * PI)) / (3 * (4 - PI)));
  const got = vol('pipe') - vHoles;
  check(`${label}: the pipe's foot filleted onto the flange`, !errors.length && got > add * 0.9 && got < add * 1.1, [errors, got, add]);
  const bodyHealth = health(bodies().get('pipe') as Shape3D, 'pipe');
  check(`${label}: sound, one body`, bodyHealth.healthy && bodies().size === 1, bodyHealth.healthy ? `${Math.round(bodyHealth.volume)} mm³` : bodyHealth);

  return fs.slice(-2);
}

const later = await run('first', 40, 90, null);
await run('60°', 40, 60, later);
await run('135°', 40, 135, later);
await run('tighter', 25, 90, later);
done();
