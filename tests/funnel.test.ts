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

const vol = (shape: Shape3D) => Math.abs(measureVolume(shape));
const body = (id: string) => bodies().get(id) as Shape3D;
const profileOf = (sk: string, es: SketchEntity[]) => ({ kind: 'profile' as const, sketch: sk, regions: arrangement(es).regions.map(regionRef) });
const unit = (vector: number[]): Vec3 => {
  const length = Math.hypot(vector[0], vector[1], vector[2]) || 1;

  return [vector[0] / length, vector[1] / length, vector[2] / length]; 
};
const edgesOf = (id: string, test: (m: Vec3, d: Vec3, len: number) => boolean): EdgeRef[] =>
  body(id).edges.filter(e => test(e.pointAt(0.5).toTuple() as Vec3, unit(e.tangentAt(0.5).toTuple()), e.length)).map(e => ({ body: id, mid: e.pointAt(0.5).toTuple() as Vec3, dir: e.tangentAt(0.5).toTuple() as Vec3, length: e.length }));
const ref = (id: string, face: Face): FaceRef => ({ body: id, center: face.center.toTuple() as Vec3, normal: face.normalAt().toTuple() as Vec3, area: measureArea(face) });
const faceOf = (id: string, pick: (f: Face) => boolean) => {
  const face = body(id).faces.find(pick); if (!face) {
    throw new Error(`no such face on ${id}`);
  }

  return ref(id, face); 
};
const PI = Math.PI;

const R0 = 6, R1 = 30, HEIGHT = 40; // the cone: 12 across at the floor, 60 across 40 up
const SPOUT = 30; // the spout: 30 long
const FILLET = 4; // the join's round
const THICKNESS = 1.5; // the wall

// ---------------------------------------------------------------- the cone
const smallEs = [circle('s', 0, 0, R0)], wideEs = [circle('w', 0, 0, R1)];
const top = { origin: [0, 0, HEIGHT] as Vec3, xDir: [1, 0, 0] as Vec3, normal: [0, 0, 1] as Vec3 };
const steps: Feature[] = [
  sketch('Small', XY(), smallEs),
  { id: 'Top', name: 'Plane', type: 'plane', plane: top, offset: HEIGHT } as Feature,
  sketch('Wide', top, wideEs),
  { id: 'Funnel', name: 'Loft', type: 'loft', sections: [profileOf('Small', smallEs), profileOf('Wide', wideEs)], ruled: false, mode: 'new' } as Feature
];
let { errors } = await after(steps);
const vCone = vol(body('Funnel'));
const frustum = (PI * HEIGHT * (R0 * R0 + R0 * R1 + R1 * R1)) / 3;
check('the cone: a frustum, 12 to 60 across, 40 tall', !errors.length && bodies().size === 1 && near(vCone, frustum, 1e-4 * frustum), [errors, vCone, frustum]);

// ---------------------------------------------------------------- the spout
// Its bottom face pulled 30 down would carry the cone on, past its point 10
// down: refused, with a way to do it (before, an hourglass or nothing at all).
const bottom = faceOf('Funnel', face => face.geomType === 'PLANE' && near(face.center.z, 0, 1e-6));
const pulled = await after([...steps, { id: 'Pull', name: 'Extrude', type: 'extrude', source: { kind: 'face', face: bottom }, distance: SPOUT, mode: 'auto', target: 'Funnel' } as Feature]);
check("the spout: the bottom face pulled past the cone's point is refused", pulled.errors.length === 1 && /sides would meet/.test(pulled.errors[0]) && near(vol(body('Funnel')), vCone, 1e-6), pulled.errors);
const nudged = await after([...steps, { id: 'Pull', name: 'Extrude', type: 'extrude', source: { kind: 'face', face: bottom }, distance: 5, mode: 'auto', target: 'Funnel' } as Feature]);
check('…pulled 5 (short of it) it carries the cone on', !nudged.errors.length && near(vol(body('Funnel')) - vCone, (PI * 5 * (9 + 18 + 36)) / 3, 1e-3), [nudged.errors, vol(body('Funnel')) - vCone]);
// The spout drawn on that face (the cone's small end, facing down) and extruded 30 out of it.
const spoutEs = [circle('p', 0, 0, R0)];
const under = { origin: [0, 0, 0] as Vec3, xDir: [1, 0, 0] as Vec3, normal: [0, 0, -1] as Vec3 };
steps.push({ ...sketch('Spout sketch', under, spoutEs), attachedTo: bottom } as Feature, { id: 'Spout', name: 'Extrude', type: 'extrude', source: profileOf('Spout sketch', spoutEs), distance: SPOUT, mode: 'join', target: 'Funnel' } as Feature);
({ errors } = await after(steps));
const vSpout = vol(body('Funnel'));
const [[, , z0]] = body('Funnel').boundingBox.bounds;
check('the spout: 12 across, 30 down', !errors.length && bodies().size === 1 && near(vSpout - vCone, PI * R0 * R0 * SPOUT, 1e-3) && near(z0, -SPOUT, 1e-4), [errors, vSpout - vCone, PI * R0 * R0 * SPOUT, z0]);

// ----------------------------------------------------------------- the join
// The edge where the spout meets the cone rounded 4: it fills the inside
// corner (less than a 4 x 4 square's ring, more than nothing).
const join = edgesOf('Funnel', midpoint => near(midpoint[2], 0, 1e-6) && near(Math.hypot(midpoint[0], midpoint[1]), R0, 1e-4));
steps.push({ id: 'Join', name: 'Fillet', type: 'fillet', edges: join, radius: FILLET } as Feature);
({ errors } = await after(steps));
const vJoin = vol(body('Funnel'));
check('the join: rounded 4', !errors.length && join.length >= 1 && vJoin > vSpout && vJoin - vSpout < FILLET * FILLET * 2 * PI * (R0 + FILLET), [errors, join.length, vJoin - vSpout]);

// ---------------------------------------------------------------- the shell
// 1.5 thick, open at the top and the spout's end.
const mouth = faceOf('Funnel', face => face.geomType === 'PLANE' && near(face.center.z, HEIGHT, 1e-6));
const tip = faceOf('Funnel', face => face.geomType === 'PLANE' && near(face.center.z, -SPOUT, 1e-6));
const skin = measureArea(body('Funnel')) - PI * R1 * R1 - PI * R0 * R0;
steps.push({ id: 'Hollow', name: 'Shell', type: 'shell', body: 'Funnel', faces: [mouth, tip], thickness: THICKNESS } as Feature);
({ errors } = await after(steps));
const vShell = vol(body('Funnel'));
check('the shell: 1.5 thick, open at both ends', !errors.length && bodies().size === 1 && vShell > skin * THICKNESS * 0.85 && vShell < skin * THICKNESS * 1.05, [errors, vShell, skin * THICKNESS]);
const [[bx0, , bz0], [bx1, , bz1]] = body('Funnel').boundingBox.bounds;
check('the shell: the same outside, 60 across, 70 tall', near(bx0, -R1, 1e-3) && near(bx1, R1, 1e-3) && near(bz0, -SPOUT, 1e-3) && near(bz1, HEIGHT, 1e-3), body('Funnel').boundingBox.bounds);
// A way through: a straight line down the middle meets no wall.
const holes = body('Funnel').faces.filter(face => face.geomType === 'PLANE').map(face => face.center.z);
check('the shell: open, a way through (only the rims are flat)', holes.length === 2 && holes.some(z => near(z, HEIGHT, 1e-6)) && holes.some(z => near(z, -SPOUT, 1e-6)), holes);

const bodyHealth = health(body('Funnel'), 'Funnel');
check('the funnel: sound, one body', bodyHealth.healthy && bodies().size === 1, bodyHealth.healthy ? `${Math.round(bodyHealth.volume)} mm³` : bodyHealth);
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
  const shapesB = [...bodies().values()].map(body => body as Shape3D);
  check('by hand: one body, sound', shapesB.length === 1 && health(shapesB[0], 'hand').healthy, shapesB.length);
  check('by hand: the same funnel (to 0.1 %)', shapesB.length === 1 && Math.abs(vol(shapesB[0]) - codeVol) < codeVol * 1e-3, `${shapesB[0] ? vol(shapesB[0]).toFixed(1) : '-'} / ${codeVol.toFixed(1)}`);
  check('by hand: as many faces, the same box', shapesB[0]?.faces.length === codeFaces && shapesB[0].boundingBox.bounds.flat().every((x, i) => near(x, codeBox.flat()[i], 1e-3)), [shapesB[0]?.faces.length, codeFaces, shapesB[0]?.boundingBox.bounds]);
}

if (process.argv[2]) {
  writeFileSync(process.argv[2], JSON.stringify({ format: 'super', version: 2, name: 'Funnel', features: steps }));
}
done();
