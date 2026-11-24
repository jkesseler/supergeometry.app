// Run: npx tsx tests/clampjaw.test.ts - a clamp jaw made by editing faces,
// each step held to its volume: a block with its four upright corners
// rounded, its end face pushed out 10 (the rounds go with it, the sides
// stretch), a pocket cut down into the top, the two rounds at the pushed end
// deleted (sharp corners again), the top tilted 5° about its middle line (as
// much added one side as taken the other: the volume stays). Then the block is
// made longer at the start: the taps (faces, edges) find their way.
import { measureVolume } from '../src/kernel/ocFree';
import { after, bodies, check, done, health, near, rect, sketch, XY, profile } from './kit';
import type { Shape3D } from 'replicad';
import type { Feature, Vec3 } from '../src/doc/types';

const vol = () => Math.abs(measureVolume(bodies().get('jaw') as Shape3D));
const PI = Math.PI;
const DEPTH = 30, HEIGHT = 20, RADIUS = 3, PUSH = 10;
const PW = 20, PD = 10, PZ = 8; // the pocket: along x, across, deep
const corner = (RADIUS * RADIUS - (PI * RADIUS * RADIUS) / 4) * HEIGHT; // what a round takes off an upright corner

 
let last: any;
// Taps, as the app stores them (tool.ts faceRefOf / edgeRefOf).
 
const faceTaps = (pick: (f: any) => boolean) =>
   
  (last.bodies.find((b: any) => b.id === 'jaw').faces as any[]).filter(pick).map(face => ({ body: 'jaw', center: face.center, normal: face.normal, area: face.area, ...(face.step ? { step: face.step } : {}) }));
 
const edgeTaps = (pick: (e: any) => boolean) =>
   
  (last.bodies.find((b: any) => b.id === 'jaw').edges as any[]).filter(pick).map(e => ({ body: 'jaw', mid: e.mid, dir: e.dir, length: e.length, ...(e.steps ? { steps: e.steps } : {}), ...(e.curves ? { curves: e.curves } : {}) }));

const block = (length: number): Feature[] => {
  const es = [rect('r', 0, 0, length, DEPTH)];

  return [sketch('sBlock', XY(), es), { id: 'jaw', name: 'Block', type: 'extrude', source: profile('sBlock', es), distance: HEIGHT, mode: 'new' } as Feature];
};

async function run(label: string, length: number, more: Feature[] | null) {
  const fs = block(length);
  let { errors, r } = await after(fs);
  last = r;
  check(`${label}: the block`, !errors.length && near(vol(), length * DEPTH * HEIGHT, 1e-6 * length * DEPTH * HEIGHT), [errors, vol()]);
  const step = async (feature: Feature, what: string, want: number, tol = 1e-6) => {
    fs.push(feature);
    ({ errors, r } = await after(fs));
    last = r;
    const volume = bodies().get('jaw') ? vol() : NaN;

    return check(`${label}: ${what}`, !errors.length && bodies().size === 1 && near(volume, want, tol * want), [errors, volume, want]);
  };
  let stepIndex = 0;
  const next = (make: () => Feature) => (more ? more[stepIndex++] : make());
  const v1 = length * DEPTH * HEIGHT - 4 * corner;
  await step(next(() => ({ id: 'rounds', name: 'Fillet', type: 'fillet', edges: edgeTaps(e => Math.abs(e.dir[2]) > 0.99), radius: RADIUS }) as Feature), 'four upright corners rounded', v1);
  const v2 = v1 + PUSH * DEPTH * HEIGHT;
  await step(next(() => ({ id: 'push', name: 'Move face', type: 'moveFace', face: faceTaps(face => face.normal[0] > 0.99)[0], translate: [PUSH, 0, 0] }) as Feature), 'its end pushed out 10 (the rounds go with it)', v2);
  const x0 = length / 2 - PW / 2;
  const pocket = [rect('p', x0, DEPTH / 2 - PD / 2, x0 + PW, DEPTH / 2 + PD / 2)];
  if (!more) {
    fs.push(sketch('sPocket', XY(HEIGHT), pocket));
  } else {
    fs.push(more[stepIndex++]);
  }
  const v3 = v2 - PW * PD * PZ;
  await step(next(() => ({ id: 'pocket', name: 'Pocket', type: 'extrude', source: profile('sPocket', pocket), distance: -PZ, mode: 'auto', byDirection: true }) as Feature), 'a pocket cut into the top', v3);
  const v4 = v3 + 2 * corner;
  await step(next(() => ({ id: 'sharp', name: 'Delete', type: 'deleteGeom', body: 'jaw', faces: faceTaps(face => face.center[0] > length + PUSH - RADIUS - 1e-6 && Math.abs(face.normal[2]) < 1e-6 && Math.abs(face.normal[0]) > 1e-6 && Math.abs(face.normal[1]) > 1e-6), edges: [], vertices: [] }) as Feature), 'the two rounds at the pushed end deleted', v4);
  const mid: Vec3 = [(length + PUSH) / 2, DEPTH / 2, HEIGHT];
  await step(next(() => ({ id: 'tilt', name: 'Tilt top', type: 'moveFace', face: faceTaps(face => face.normal[2] > 0.99 && face.center[2] > HEIGHT - 1e-6)[0], translate: [0, 0, 0], rotate: { origin: mid, axis: [1, 0, 0], angle: 5 } }) as Feature), 'the top tilted 5° about its middle line (the volume stays)', v4, 1e-6);
  const top = (bodies().get('jaw') as Shape3D).boundingBox.bounds[1][2];
  check(`${label}: tilted: its high side up by half its width times tan 5°`, near(top, HEIGHT + (DEPTH / 2) * Math.tan((5 * PI) / 180), 1e-6), [top]);
  const bodyHealth = health(bodies().get('jaw') as Shape3D, 'jaw');
  check(`${label}: sound`, bodyHealth.healthy, bodyHealth.healthy ? `${Math.round(bodyHealth.volume)} mm³, ${bodyHealth.faces} faces` : bodyHealth);

  return fs.slice(2);
}

const later = await run('first', 60, null);
await run('longer', 80, later);
await run('shorter', 45, later);

// The same jaw built by hand at phone size (taps, typed values): it comes out
// the same, and made 80 long by its width dimension, the same as the code's.
{
  const { readFileSync } = await import('node:fs');
  const hand = JSON.parse(readFileSync(new URL('./fixtures/clampjaw-hand.json', import.meta.url), 'utf8'));
  const want = (length: number) => length * DEPTH * HEIGHT - 4 * corner + PUSH * DEPTH * HEIGHT - PW * PD * PZ + 2 * corner;
  for (const length of [60, 80]) {
    const fs = JSON.parse(JSON.stringify(hand.features)) as Feature[];
    const sk = fs[0] as unknown as { entities: { center: number[]; w: number }[]; constraints: { prop: string; value: number }[] };
    sk.entities[0] = { ...sk.entities[0], center: [length / 2, DEPTH / 2], w: length };
    sk.constraints = sk.constraints.map(constraint => (constraint.prop === 'w' ? { ...constraint, value: length } : constraint));
    const { errors } = await after(fs);
    const b = bodies().get('extrude-mwny32m0-f5oo') as Shape3D;
    const volume = b ? Math.abs(measureVolume(b)) : NaN;
    check(`by hand, ${length} long: the code's volume, sound`, !errors.length && near(volume, want(length), 1e-6 * want(length)) && health(b, 'jaw').healthy, [errors, volume, want(length)]);
  }
}
done();
