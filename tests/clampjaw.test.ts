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
const D = 30, H = 20, R = 3, PUSH = 10;
const PW = 20, PD = 10, PZ = 8; // the pocket: along x, across, deep
const corner = (R * R - (PI * R * R) / 4) * H; // what a round takes off an upright corner

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let last: any;
// Taps, as the app stores them (tool.ts faceRefOf / edgeRefOf).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const faceTaps = (pick: (f: any) => boolean) =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (last.bodies.find((b: any) => b.id === 'jaw').faces as any[]).filter(pick).map(f => ({ body: 'jaw', center: f.center, normal: f.normal, area: f.area, ...(f.step ? { step: f.step } : {}) }));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const edgeTaps = (pick: (e: any) => boolean) =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (last.bodies.find((b: any) => b.id === 'jaw').edges as any[]).filter(pick).map(e => ({ body: 'jaw', mid: e.mid, dir: e.dir, length: e.length, ...(e.steps ? { steps: e.steps } : {}), ...(e.curves ? { curves: e.curves } : {}) }));

const block = (L: number): Feature[] => {
  const es = [rect('r', 0, 0, L, D)];

  return [sketch('sBlock', XY(), es), { id: 'jaw', name: 'Block', type: 'extrude', source: profile('sBlock', es), distance: H, mode: 'new' } as Feature];
};

async function run(label: string, L: number, more: Feature[] | null) {
  const fs = block(L);
  let { errors, r } = await after(fs);
  last = r;
  check(`${label}: the block`, !errors.length && near(vol(), L * D * H, 1e-6 * L * D * H), [errors, vol()]);
  const step = async (f: Feature, what: string, want: number, tol = 1e-6) => {
    fs.push(f);
    ({ errors, r } = await after(fs));
    last = r;
    const v = bodies().get('jaw') ? vol() : NaN;

    return check(`${label}: ${what}`, !errors.length && bodies().size === 1 && near(v, want, tol * want), [errors, v, want]);
  };
  let k = 0;
  const next = (make: () => Feature) => (more ? more[k++] : make());
  const v1 = L * D * H - 4 * corner;
  await step(next(() => ({ id: 'rounds', name: 'Fillet', type: 'fillet', edges: edgeTaps(e => Math.abs(e.dir[2]) > 0.99), radius: R }) as Feature), 'four upright corners rounded', v1);
  const v2 = v1 + PUSH * D * H;
  await step(next(() => ({ id: 'push', name: 'Move face', type: 'moveFace', face: faceTaps(f => f.normal[0] > 0.99)[0], translate: [PUSH, 0, 0] }) as Feature), 'its end pushed out 10 (the rounds go with it)', v2);
  const x0 = L / 2 - PW / 2;
  const pocket = [rect('p', x0, D / 2 - PD / 2, x0 + PW, D / 2 + PD / 2)];
  if (!more) {
    fs.push(sketch('sPocket', XY(H), pocket));
  } else {
    fs.push(more[k++]);
  }
  const v3 = v2 - PW * PD * PZ;
  await step(next(() => ({ id: 'pocket', name: 'Pocket', type: 'extrude', source: profile('sPocket', pocket), distance: -PZ, mode: 'auto', byDirection: true }) as Feature), 'a pocket cut into the top', v3);
  const v4 = v3 + 2 * corner;
  await step(next(() => ({ id: 'sharp', name: 'Delete', type: 'deleteGeom', body: 'jaw', faces: faceTaps(f => f.center[0] > L + PUSH - R - 1e-6 && Math.abs(f.normal[2]) < 1e-6 && Math.abs(f.normal[0]) > 1e-6 && Math.abs(f.normal[1]) > 1e-6), edges: [], vertices: [] }) as Feature), 'the two rounds at the pushed end deleted', v4);
  const mid: Vec3 = [(L + PUSH) / 2, D / 2, H];
  await step(next(() => ({ id: 'tilt', name: 'Tilt top', type: 'moveFace', face: faceTaps(f => f.normal[2] > 0.99 && f.center[2] > H - 1e-6)[0], translate: [0, 0, 0], rotate: { origin: mid, axis: [1, 0, 0], angle: 5 } }) as Feature), 'the top tilted 5° about its middle line (the volume stays)', v4, 1e-6);
  const top = (bodies().get('jaw') as Shape3D).boundingBox.bounds[1][2];
  check(`${label}: tilted: its high side up by half its width times tan 5°`, near(top, H + (D / 2) * Math.tan((5 * PI) / 180), 1e-6), [top]);
  const h = health(bodies().get('jaw') as Shape3D, 'jaw');
  check(`${label}: sound`, h.healthy, h.healthy ? `${Math.round(h.volume)} mm³, ${h.faces} faces` : h);

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
  const want = (L: number) => L * D * H - 4 * corner + PUSH * D * H - PW * PD * PZ + 2 * corner;
  for (const L of [60, 80]) {
    const fs = JSON.parse(JSON.stringify(hand.features)) as Feature[];
    const sk = fs[0] as unknown as { entities: { center: number[]; w: number }[]; constraints: { prop: string; value: number }[] };
    sk.entities[0] = { ...sk.entities[0], center: [L / 2, D / 2], w: L };
    sk.constraints = sk.constraints.map(c => (c.prop === 'w' ? { ...c, value: L } : c));
    const { errors } = await after(fs);
    const b = bodies().get('extrude-mwny32m0-f5oo') as Shape3D;
    const v = b ? Math.abs(measureVolume(b)) : NaN;
    check(`by hand, ${L} long: the code's volume, sound`, !errors.length && near(v, want(L), 1e-6 * want(L)) && health(b, 'jaw').healthy, [errors, v, want(L)]);
  }
}
done();
