// Run: npx tsx tests/planter.test.ts [out.json] - a planter pot: lofted from
// a square foot to a round mouth, shelled open at the top, four drain holes
// through its floor (one circle, patterned round the middle in the sketch),
// the mouth's outer edge rounded. Each step held to its size and soundness.
import { readFileSync, writeFileSync } from 'node:fs';
import { measureArea, type Face, type Shape3D } from 'replicad';
import { measureVolume } from '../src/kernel/ocFree';
import { arrangement, regionRef } from '../src/sketch/regions';
import { after, bodies, check, circle, done, health, near, rect, sketch, XY } from './kit';
import type { EdgeRef, FaceRef, Feature, SketchEntity, Vec3 } from '../src/doc/types';

const vol = (s: Shape3D) => Math.abs(measureVolume(s));
const body = (id: string) => bodies().get(id) as Shape3D;
const profileOf = (sk: string, es: SketchEntity[]) => ({ kind: 'profile' as const, sketch: sk, regions: arrangement(es).regions.map(regionRef) });
const faceOf = (id: string, pick: (f: Face) => boolean): FaceRef => {
  const f = body(id).faces.find(pick);
  if (!f) {
    throw new Error('no such face');
  }

  return { body: id, center: f.center.toTuple() as Vec3, normal: f.normalAt().toTuple() as Vec3, area: measureArea(f) };
};

const FOOT = 60, MOUTH = 40, H = 80, WALL = 2, HOLE = 3, AT = 16, ROUND = 0.8;

// ------------------------------------------------------------------ the pot
// A square 60 on the floor, a circle 80 across 80 up: lofted between.
const footEs = [rect('f', -FOOT / 2, -FOOT / 2, FOOT / 2, FOOT / 2)];
const mouthEs = [circle('m', 0, 0, MOUTH)];
const steps: Feature[] = [
  sketch('Foot', XY(), footEs),
  sketch('Mouth', XY(H), mouthEs),
  { id: 'Pot', name: 'Loft', type: 'loft', sections: [profileOf('Foot', footEs), profileOf('Mouth', mouthEs)], ruled: false, mode: 'new' } as Feature
];
let { errors } = await after(steps);
check('the pot: no errors, one body', !errors.length && bodies().size === 1, errors);
const vPot = vol(body('Pot'));
// (Between the square's prism and the circle's: the sections' areas, 3600 and 5026.5, 80 apart.)
check("the pot: between the foot's and the mouth's prisms", vPot > FOOT * FOOT * H && vPot < Math.PI * MOUTH * MOUTH * H, vPot);
const [[x0, , z0], [x1, , z1]] = body('Pot').boundingBox.bounds;
check('the pot: 80 high, 80 across at the top', near(z0, 0, 1e-6) && near(z1, H, 1e-6) && near(x1 - x0, 2 * MOUTH, 0.01), body('Pot').boundingBox.bounds);

// ---------------------------------------------------------------- the shell
const mouthFace = faceOf('Pot', f => near(f.center.z, H, 1e-6) && f.normalAt().z > 0.99);
steps.push({ id: 'Hollow', name: 'Shell', type: 'shell', body: 'Pot', faces: [mouthFace], thickness: WALL } as Feature);
({ errors } = await after(steps));
check('the shell: no errors', !errors.length, errors);
const vShell = vol(body('Pot'));
// The floor alone is 60 x 60 x 2; the walls about 2 thick round 80 high.
check('the shell: hollow, walls about 2 thick (the floor and the walls)', vShell > FOOT * FOOT * WALL + 4 * FOOT * WALL * H * 0.9 && vShell < FOOT * FOOT * WALL + 2 * Math.PI * MOUTH * WALL * H * 1.2, vShell);
check('the shell: open at the top, sound', health(body('Pot'), 'p').healthy, health(body('Pot'), 'p'));

// ----------------------------------------------------------- the drain holes
// One circle 16 out, patterned four round the middle (in the sketch), cut through the floor.
const holeEs = [0, 1, 2, 3].map(i => circle(`h${i}`, AT * Math.cos((i * Math.PI) / 2), AT * Math.sin((i * Math.PI) / 2), HOLE));
steps.push(sketch('Drain', XY(), holeEs), { id: 'Holes', name: 'Extrude', type: 'extrude', source: profileOf('Drain', holeEs), distance: WALL, mode: 'cut', target: 'Pot' } as Feature);
({ errors } = await after(steps));
check('the holes: no errors', !errors.length, errors);
const vHoles = vol(body('Pot'));
check('the holes: four, 6 round, through the 2 thick floor', near(vShell - vHoles, 4 * Math.PI * HOLE * HOLE * WALL, 1e-3), vShell - vHoles);

// ----------------------------------------------------------------- the rim
// The mouth's outer edge (a circle 40 round, 80 up) rounded 0.8.
const rimEdge = body('Pot').edges.filter(e => near(e.pointAt(0.5).z, H, 1e-6) && near(Math.hypot(e.pointAt(0.5).x, e.pointAt(0.5).y), MOUTH, 1e-3));
const rim: EdgeRef[] = rimEdge.map(e => ({ body: 'Pot', mid: e.pointAt(0.5).toTuple() as Vec3, dir: e.tangentAt(0.5).toTuple() as Vec3, length: e.length }));
steps.push({ id: 'Rim', name: 'Fillet', type: 'fillet', edges: rim, radius: ROUND } as Feature);
({ errors } = await after(steps));
// (The loft splits the mouth's circle where the square's corners run up to it: five pieces, all of them.)
check('the rim: rounded all round, no errors', !errors.length && rim.length >= 1 && near(rim.reduce((a, e) => a + e.length, 0), 2 * Math.PI * MOUTH, 1e-3), [errors, rim.length]);
const vRim = vol(body('Pot'));
check('the rim: a little off round it', vRim < vHoles && vHoles - vRim < 2 * Math.PI * MOUTH * ROUND * ROUND, vHoles - vRim);

const h = health(body('Pot'), 'Pot');
check('the planter: sound, one body', h.healthy && bodies().size === 1, h.healthy ? `${Math.round(h.volume)} mm³` : h);
const codeVol = vol(body('Pot'));
const codeFaces = body('Pot').faces.length;
const codeBox = body('Pot').boundingBox.bounds;
console.log('pot', vPot.toFixed(1), 'shell', vShell.toFixed(1), 'holes', vHoles.toFixed(1), 'final', codeVol.toFixed(1), 'faces', codeFaces);

// ------------------------------------------------ the planter built by hand
// On a phone-sized screen (tests/fixtures/planter-hand.json): the square typed
// on the floor, an Offset Plane 80 up and the circle on it, the two lofted;
// the mouth tapped and shelled 2; on the underside one circle, Pattern
// (tapped again for Circular) four round the middle, cut Through all with
// Auto; the rim tapped once and rounded 0.8 (a quarter of it alone, before:
// "would damage the body"). It comes out the same.
{
  const hand = JSON.parse(readFileSync(new URL('./fixtures/planter-hand.json', import.meta.url), 'utf8')).features as Feature[];
  const { errors } = await after(hand);
  check('by hand: no errors', errors.length === 0, errors);
  const H = [...bodies().values()].map(s => s as Shape3D);
  check('by hand: one body, sound', H.length === 1 && health(H[0], 'hand').healthy, H.length);
  check('by hand: the same planter (to 0.1 %)', H.length === 1 && Math.abs(vol(H[0]) - codeVol) < codeVol * 1e-3, `${H[0] ? vol(H[0]).toFixed(1) : '-'} / ${codeVol.toFixed(1)}`);
  check('by hand: as many faces, the same box', H[0]?.faces.length === codeFaces && H[0].boundingBox.bounds.flat().every((x, i) => near(x, codeBox.flat()[i], 1e-3)), [H[0]?.faces.length, codeFaces, H[0]?.boundingBox.bounds]);
}

if (process.argv[2]) {
  writeFileSync(process.argv[2], JSON.stringify({ format: 'super', version: 2, name: 'Planter', features: steps }));
}
done();
