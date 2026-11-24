// Run: npx tsx tests/funnel.test.ts [out.json] - a funnel: a loft from a small
// circle on the floor up to a wide one on a plane 40 up (a cone's frustum); a
// spout drawn on its small end, 30 down; the join between them rounded; shelled
// 1.5 thick, open at the top and at the spout's end. Each step held to its size
// and soundness.
import { readFileSync, writeFileSync } from 'node:fs';
import { measureArea, type Face, type Shape3D } from 'replicad';
import { measureVolume } from '../src/kernel/ocFree';
import { arrangement, regionRef } from '../src/sketch/regions';
import { after, bodies, check, circle, done, health, near, sketch, XY } from './kit';
import type { EdgeRef, FaceRef, Feature, SketchEntity, Vec3 } from '../src/doc/types';

const vol = (s: Shape3D) => Math.abs(measureVolume(s));
const body = (id: string) => bodies().get(id) as Shape3D;
const profileOf = (sk: string, es: SketchEntity[]) => ({ kind: 'profile' as const, sketch: sk, regions: arrangement(es).regions.map(regionRef) });
const unit = (v: number[]): Vec3 => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;

  return [v[0] / l, v[1] / l, v[2] / l]; 
};
const edgesOf = (id: string, test: (m: Vec3, d: Vec3, len: number) => boolean): EdgeRef[] =>
  body(id).edges.filter(e => test(e.pointAt(0.5).toTuple() as Vec3, unit(e.tangentAt(0.5).toTuple()), e.length)).map(e => ({ body: id, mid: e.pointAt(0.5).toTuple() as Vec3, dir: e.tangentAt(0.5).toTuple() as Vec3, length: e.length }));
const ref = (id: string, f: Face): FaceRef => ({ body: id, center: f.center.toTuple() as Vec3, normal: f.normalAt().toTuple() as Vec3, area: measureArea(f) });
const faceOf = (id: string, pick: (f: Face) => boolean) => {
  const f = body(id).faces.find(pick); if (!f) {
    throw new Error(`no such face on ${id}`);
  }

  return ref(id, f); 
};
const PI = Math.PI;

const R0 = 6, R1 = 30, H = 40; // the cone: 12 across at the floor, 60 across 40 up
const S = 30; // the spout: 30 long
const F = 4; // the join's round
const T = 1.5; // the wall

// ---------------------------------------------------------------- the cone
const smallEs = [circle('s', 0, 0, R0)], wideEs = [circle('w', 0, 0, R1)];
const top = { origin: [0, 0, H] as Vec3, xDir: [1, 0, 0] as Vec3, normal: [0, 0, 1] as Vec3 };
const steps: Feature[] = [
  sketch('Small', XY(), smallEs),
  { id: 'Top', name: 'Plane', type: 'plane', plane: top, offset: H } as Feature,
  sketch('Wide', top, wideEs),
  { id: 'Funnel', name: 'Loft', type: 'loft', sections: [profileOf('Small', smallEs), profileOf('Wide', wideEs)], ruled: false, mode: 'new' } as Feature
];
let { errors } = await after(steps);
const vCone = vol(body('Funnel'));
const frustum = (PI * H * (R0 * R0 + R0 * R1 + R1 * R1)) / 3;
check('the cone: a frustum, 12 to 60 across, 40 tall', !errors.length && bodies().size === 1 && near(vCone, frustum, 1e-4 * frustum), [errors, vCone, frustum]);

// ---------------------------------------------------------------- the spout
// Its bottom face pulled 30 down would carry the cone on, past its point 10
// down: refused, with a way to do it (before, an hourglass or nothing at all).
const bottom = faceOf('Funnel', f => f.geomType === 'PLANE' && near(f.center.z, 0, 1e-6));
const pulled = await after([...steps, { id: 'Pull', name: 'Extrude', type: 'extrude', source: { kind: 'face', face: bottom }, distance: S, mode: 'auto', target: 'Funnel' } as Feature]);
check("the spout: the bottom face pulled past the cone's point is refused", pulled.errors.length === 1 && /sides would meet/.test(pulled.errors[0]) && near(vol(body('Funnel')), vCone, 1e-6), pulled.errors);
const nudged = await after([...steps, { id: 'Pull', name: 'Extrude', type: 'extrude', source: { kind: 'face', face: bottom }, distance: 5, mode: 'auto', target: 'Funnel' } as Feature]);
check('…pulled 5 (short of it) it carries the cone on', !nudged.errors.length && near(vol(body('Funnel')) - vCone, (PI * 5 * (9 + 18 + 36)) / 3, 1e-3), [nudged.errors, vol(body('Funnel')) - vCone]);
// The spout drawn on that face (the cone's small end, facing down) and extruded 30 out of it.
const spoutEs = [circle('p', 0, 0, R0)];
const under = { origin: [0, 0, 0] as Vec3, xDir: [1, 0, 0] as Vec3, normal: [0, 0, -1] as Vec3 };
steps.push({ ...sketch('Spout sketch', under, spoutEs), attachedTo: bottom } as Feature, { id: 'Spout', name: 'Extrude', type: 'extrude', source: profileOf('Spout sketch', spoutEs), distance: S, mode: 'join', target: 'Funnel' } as Feature);
({ errors } = await after(steps));
const vSpout = vol(body('Funnel'));
const [[, , z0]] = body('Funnel').boundingBox.bounds;
check('the spout: 12 across, 30 down', !errors.length && bodies().size === 1 && near(vSpout - vCone, PI * R0 * R0 * S, 1e-3) && near(z0, -S, 1e-4), [errors, vSpout - vCone, PI * R0 * R0 * S, z0]);

// ----------------------------------------------------------------- the join
// The edge where the spout meets the cone rounded 4: it fills the inside
// corner (less than a 4 x 4 square's ring, more than nothing).
const join = edgesOf('Funnel', m => near(m[2], 0, 1e-6) && near(Math.hypot(m[0], m[1]), R0, 1e-4));
steps.push({ id: 'Join', name: 'Fillet', type: 'fillet', edges: join, radius: F } as Feature);
({ errors } = await after(steps));
const vJoin = vol(body('Funnel'));
check('the join: rounded 4', !errors.length && join.length >= 1 && vJoin > vSpout && vJoin - vSpout < F * F * 2 * PI * (R0 + F), [errors, join.length, vJoin - vSpout]);

// ---------------------------------------------------------------- the shell
// 1.5 thick, open at the top and the spout's end.
const mouth = faceOf('Funnel', f => f.geomType === 'PLANE' && near(f.center.z, H, 1e-6));
const tip = faceOf('Funnel', f => f.geomType === 'PLANE' && near(f.center.z, -S, 1e-6));
const skin = measureArea(body('Funnel')) - PI * R1 * R1 - PI * R0 * R0;
steps.push({ id: 'Hollow', name: 'Shell', type: 'shell', body: 'Funnel', faces: [mouth, tip], thickness: T } as Feature);
({ errors } = await after(steps));
const vShell = vol(body('Funnel'));
check('the shell: 1.5 thick, open at both ends', !errors.length && bodies().size === 1 && vShell > skin * T * 0.85 && vShell < skin * T * 1.05, [errors, vShell, skin * T]);
const [[bx0, , bz0], [bx1, , bz1]] = body('Funnel').boundingBox.bounds;
check('the shell: the same outside, 60 across, 70 tall', near(bx0, -R1, 1e-3) && near(bx1, R1, 1e-3) && near(bz0, -S, 1e-3) && near(bz1, H, 1e-3), body('Funnel').boundingBox.bounds);
// A way through: a straight line down the middle meets no wall.
const holes = body('Funnel').faces.filter(f => f.geomType === 'PLANE').map(f => f.center.z);
check('the shell: open, a way through (only the rims are flat)', holes.length === 2 && holes.some(z => near(z, H, 1e-6)) && holes.some(z => near(z, -S, 1e-6)), holes);

const h = health(body('Funnel'), 'Funnel');
check('the funnel: sound, one body', h.healthy && bodies().size === 1, h.healthy ? `${Math.round(h.volume)} mm³` : h);
const codeVol = vol(body('Funnel'));
const codeFaces = body('Funnel').faces.length;
const codeBox = body('Funnel').boundingBox.bounds;
console.log('cone', vCone.toFixed(1), 'spout', vSpout.toFixed(1), 'join', vJoin.toFixed(1), 'final', codeVol.toFixed(1), 'faces', codeFaces);

// ---------------------------------------------- the funnel built by hand
// On a phone-sized screen (tests/fixtures/funnel-hand.json): the small circle
// on the floor, an offset plane 40 up, the wide circle on it, a loft of the
// two; from below, the bottom face pulled 30 for the spout (refused now, with
// the way to do it: before, nothing happened), so a circle drawn on that face
// and extruded 30; the join rounded 4; Shell with the top tapped, then the
// spout's end from below (it went to the thickness box, on the top face's
// middle right behind it: the box steps aside now when its face is turned
// away), 1.5 thick. It comes out the same.
{
  const hand = JSON.parse(readFileSync(new URL('./fixtures/funnel-hand.json', import.meta.url), 'utf8')).features as Feature[];
  const { errors } = await after(hand);
  check('by hand: no errors', errors.length === 0, errors);
  const B = [...bodies().values()].map(s => s as Shape3D);
  check('by hand: one body, sound', B.length === 1 && health(B[0], 'hand').healthy, B.length);
  check('by hand: the same funnel (to 0.1 %)', B.length === 1 && Math.abs(vol(B[0]) - codeVol) < codeVol * 1e-3, `${B[0] ? vol(B[0]).toFixed(1) : '-'} / ${codeVol.toFixed(1)}`);
  check('by hand: as many faces, the same box', B[0]?.faces.length === codeFaces && B[0].boundingBox.bounds.flat().every((x, i) => near(x, codeBox.flat()[i], 1e-3)), [B[0]?.faces.length, codeFaces, B[0]?.boundingBox.bounds]);
}

if (process.argv[2]) {
  writeFileSync(process.argv[2], JSON.stringify({ format: 'super', version: 2, name: 'Funnel', features: steps }));
}
done();
