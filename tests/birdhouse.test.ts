// Run: npx tsx tests/birdhouse.test.ts [out.json] - a birdhouse: a house
// shape (120 wide, walls 100 high, the ridge at 150) drawn on the front plane
// and extruded 60 both ways; shelled 4 thick, open at the bottom; the ridge
// rounded 5 outside; an entrance 32 across through the front wall and a
// perch 6 across standing out 20 below it. Each step held to its size (the
// shell by the house shape moved in 4 on every side but the floor, the round
// by its spandrel at the ridge's angle) and soundness.
import { readFileSync, writeFileSync } from 'node:fs';
import { measureArea, type Face, type Shape3D } from 'replicad';
import { measureVolume } from '../src/kernel/ocFree';
import { arrangement, regionRef } from '../src/sketch/regions';
import { after, bodies, check, circle, done, health, near, poly, sketch, XZ } from './kit';
import type { EdgeRef, FaceRef, Feature, SketchEntity, Vec3 } from '../src/doc/types';

const vol = (shape: Shape3D) => Math.abs(measureVolume(shape));
const body = (id: string) => bodies().get(id) as Shape3D;
const profileOf = (sk: string, es: SketchEntity[]) => ({ kind: 'profile' as const, sketch: sk, regions: arrangement(es).regions.map(regionRef) });
const faceRef = (id: string, face: Face): FaceRef => ({ body: id, center: face.center.toTuple() as Vec3, normal: face.normalAt().toTuple() as Vec3, area: measureArea(face) });
const edgesOf = (id: string, test: (m: number[], d: number[]) => boolean): EdgeRef[] =>
  body(id).edges.filter(e => test(e.pointAt(0.5).toTuple(), e.tangentAt(0.5).toTuple())).map(e => ({ body: id, mid: e.pointAt(0.5).toTuple() as Vec3, dir: e.tangentAt(0.5).toTuple() as Vec3, length: e.length }));
const PI = Math.PI;
type P2 = [number, number];
const shoelace = (ps: P2[]) => Math.abs(ps.reduce((total, point, i) => {
  const q = ps[(i + 1) % ps.length];

  return total + point[0] * q[1] - q[0] * point[1]; 
}, 0)) / 2;

const HW = 60, WALL = 100, RIDGE = 150; // the house: 120 wide, walls 100 high, the ridge at 150
const DEPTH = 60; // 60 either side of the front plane: 120 deep
const THICKNESS = 4; // the shell: 4 thick, open at the bottom
const FILLET = 5; // the ridge rounded 5
const ER = 16, EZ = 90; // the entrance: 32 across, its middle 90 up
const PR = 3, PZ = 60, PL = 20; // the perch: 6 across, 60 up, standing out 20

// ---------------------------------------------------------------- the house
const house: P2[] = [[-HW, 0], [HW, 0], [HW, WALL], [0, RIDGE], [-HW, WALL]];
const houseEs = [poly('h', house)];
const steps: Feature[] = [sketch('Front', XZ(), houseEs), { id: 'House', name: 'Extrude', type: 'extrude', source: profileOf('Front', houseEs), distance: DEPTH, symmetric: true, mode: 'new' } as Feature];
let { errors } = await after(steps);
const vHouse = vol(body('House'));
check('the house: 120 wide, the ridge at 150, 120 deep', !errors.length && near(vHouse, shoelace(house) * 2 * DEPTH, 1e-6 * vHouse), [errors, vHouse, shoelace(house) * 2 * DEPTH]);

// ---------------------------------------------------------------- the shell
// Inside: every side but the floor moved in 4 (each roof line along its own
// normal), 8 shorter front to back, down to the floor.
// (Moved 4 along its normal, a roof line drops 4 / cos of its slope.)
const slope = Math.hypot(RIDGE - WALL, HW);
const roofAt = (x: number) => RIDGE - (THICKNESS * slope) / HW - ((RIDGE - WALL) / HW) * Math.abs(x);
const inner: P2[] = [[-(HW - THICKNESS), 0], [HW - THICKNESS, 0], [HW - THICKNESS, roofAt(HW - THICKNESS)], [0, roofAt(0)], [-(HW - THICKNESS), roofAt(HW - THICKNESS)]];
const floor = faceRef('House', body('House').faces.find(face => face.geomType === 'PLANE' && near(face.center.z, 0, 1e-6))!);
steps.push({ id: 'Hollow', name: 'Shell', type: 'shell', body: 'House', faces: [floor], thickness: THICKNESS } as Feature);
({ errors } = await after(steps));
const vShell = vol(body('House'));
const vInside = shoelace(inner) * (2 * DEPTH - 2 * THICKNESS);
check('the shell: 4 thick, open at the bottom', !errors.length && bodies().size === 1 && near(vHouse - vShell, vInside, 1e-6 * vInside), [errors, vHouse - vShell, vInside]);

// ---------------------------------------------------------------- the ridge
// Its inside angle α between the roofs: the round takes r²·(cot(α/2) - (π - α)/2) along it.
const ridge = edgesOf('House', (midpoint, direction) => near(midpoint[0], 0, 1e-6) && near(midpoint[2], RIDGE, 1e-6) && Math.abs(direction[1]) > 0.999);
steps.push({ id: 'Round', name: 'Fillet', type: 'fillet', edges: ridge, radius: FILLET } as Feature);
({ errors } = await after(steps));
const vRound = vol(body('House'));
const alpha = PI - 2 * Math.atan2(RIDGE - WALL, HW);
const spandrel = FILLET * FILLET * (1 / Math.tan(alpha / 2) - (PI - alpha) / 2);
check('the ridge: rounded 5', !errors.length && ridge.length === 1 && near(vShell - vRound, spandrel * 2 * DEPTH, 1e-4 * spandrel * 2 * DEPTH), [errors, ridge.length, vShell - vRound, spandrel * 2 * DEPTH]);

// ---------------------------------------------------- the entrance and perch
// On the front wall (y = -60): the entrance through its 4, the perch out 20.
const holeEs = [circle('e', 0, EZ, ER)];
const perchEs = [circle('p', 0, PZ, PR)];
steps.push(
  sketch('Door', XZ(-DEPTH), holeEs),
  { id: 'Entrance', name: 'Extrude', type: 'extrude', source: profileOf('Door', holeEs), distance: -THICKNESS, mode: 'cut', target: 'House' } as Feature,
  sketch('Stick', XZ(-DEPTH), perchEs),
  { id: 'Perch', name: 'Extrude', type: 'extrude', source: profileOf('Stick', perchEs), distance: PL, mode: 'join', target: 'House' } as Feature
);
({ errors } = await after(steps));
const vDone = vol(body('House'));
const delta = PI * PR * PR * PL - PI * ER * ER * THICKNESS;
check('the entrance through the front wall, the perch out 20', !errors.length && bodies().size === 1 && near(vDone - vRound, delta, 1e-5 * Math.abs(delta)), [errors, vDone - vRound, delta]);
const [[x0, y0, z0], [x1, y1, z1]] = body('House').boundingBox.bounds;
check('the birdhouse: 120 wide, 140 deep with the perch, 150 high', near(x0, -HW, 1e-3) && near(x1, HW, 1e-3) && near(y0, -DEPTH - PL, 1e-3) && near(y1, DEPTH, 1e-3) && near(z0, 0, 1e-3) && z1 < RIDGE && z1 > RIDGE - FILLET, body('House').boundingBox.bounds);

const bodyHealth = health(body('House'), 'House');
check('the birdhouse: sound, one body', bodyHealth.healthy && bodies().size === 1, bodyHealth.healthy ? `${Math.round(bodyHealth.volume)} mm³` : bodyHealth);
const codeVol = vol(body('House'));
const codeFaces = body('House').faces.length;
const codeBox = body('House').boundingBox.bounds;
console.log('house', vHouse.toFixed(1), 'shell', vShell.toFixed(1), 'round', vRound.toFixed(1), 'final', codeVol.toFixed(1), 'faces', codeFaces);

// ---------------------------------------------- the birdhouse built by hand
// On a phone-sized screen (tests/fixtures/birdhouse-hand.json): from the
// front, a Sketch and the house as typed lines from (-60, 0) (Across 120;
// Up 100; Across -60, Up 50; Across -60, Up -50; Up -100 closes it);
// Extrude, Sides: Symmetric, Each side 60 (the box is called Each side then:
// the first 60 went nowhere, and Done at 0 closed it without a word - it says
// "Nothing made" now); from below, Shell, the floor tapped, Thickness 4; the
// ridge tapped, Fillet 5; the front face, Sketch, a circle typed (0, 90, 32
// across), Extrude -4; the front face again, a circle (0, 60, 6 across),
// Extrude 20. It comes out the same.
{
  const hand = JSON.parse(readFileSync(new URL('./fixtures/birdhouse-hand.json', import.meta.url), 'utf8')).features as Feature[];
  const { errors } = await after(hand);
  check('by hand: no errors', errors.length === 0, errors);
  const Bs = [...bodies().values()].map(body => body as Shape3D);
  check('by hand: one body, sound', Bs.length === 1 && health(Bs[0], 'hand').healthy, Bs.length);
  check('by hand: the same birdhouse (to 0.1 %)', Bs.length === 1 && Math.abs(vol(Bs[0]) - codeVol) < codeVol * 1e-3, `${Bs[0] ? vol(Bs[0]).toFixed(1) : '-'} / ${codeVol.toFixed(1)}`);
  check('by hand: as many faces, the same box', Bs[0]?.faces.length === codeFaces && Bs[0].boundingBox.bounds.flat().every((x, i) => near(x, codeBox.flat()[i], 1e-3)), [Bs[0]?.faces.length, codeFaces, Bs[0]?.boundingBox.bounds]);
}

if (process.argv[2]) {
  writeFileSync(process.argv[2], JSON.stringify({ format: 'super', version: 2, name: 'Birdhouse', features: steps }));
}
done();
