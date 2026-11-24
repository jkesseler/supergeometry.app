// Run: npx tsx tests/wallhook.test.ts [out.json] - a wall hook: a plate with
// its corners rounded and two countersunk screw holes; an arm swept from its
// middle along a J (up, over in a half circle, down a little). Each step held
// to its size (the arm by Pappus: its section times its path) and soundness.
import { readFileSync, writeFileSync } from 'node:fs';
import { measureVolume } from '../src/kernel/ocFree';
import { arrangement, regionRef } from '../src/sketch/regions';
import { after, bodies, check, circle, done, health, line, near, rect, sketch, XY, XZ } from './kit';
import type { Shape3D } from 'replicad';
import type { EdgeRef, Feature, SketchEntity, Vec3 } from '../src/doc/types';

const vol = (shape: Shape3D) => Math.abs(measureVolume(shape));
const body = (id: string) => bodies().get(id) as Shape3D;
const profileOf = (sk: string, es: SketchEntity[]) => ({ kind: 'profile' as const, sketch: sk, regions: arrangement(es).regions.map(regionRef) });
const unit = (vector: number[]): Vec3 => {
  const length = Math.hypot(vector[0], vector[1], vector[2]) || 1;

  return [vector[0] / length, vector[1] / length, vector[2] / length]; 
};
const edgesOf = (id: string, test: (m: Vec3, d: Vec3, len: number) => boolean): EdgeRef[] =>
  body(id).edges.filter(e => test(e.pointAt(0.5).toTuple() as Vec3, unit(e.tangentAt(0.5).toTuple()), e.length)).map(e => ({ body: id, mid: e.pointAt(0.5).toTuple() as Vec3, dir: e.tangentAt(0.5).toTuple() as Vec3, length: e.length }));
const PI = Math.PI;

const WIDTH = 20, LENGTH = 60, THICKNESS = 4, RADIUS = 5; // the plate: 20 x 60 x 4, its corners rounded 5
const HY = 20, HR = 2, CS = 1.5; // the screw holes: 4 round, 20 either side, countersunk 1.5
const AR = 3; // the arm: 6 round
const UP = 30, BR = 10, DOWN = 8; // its path: up to 30, over a half circle 10 round, 8 down

// ---------------------------------------------------------------- the plate
const plateEs = [rect('p', -WIDTH / 2, -LENGTH / 2, WIDTH / 2, LENGTH / 2)];
const steps: Feature[] = [sketch('Plate', XY(), plateEs), { id: 'Hook', name: 'Extrude', type: 'extrude', source: profileOf('Plate', plateEs), distance: THICKNESS, mode: 'new' } as Feature];
let { errors } = await after(steps);
const corners = edgesOf('Hook', (midpoint, direction) => Math.abs(direction[2]) > 0.99);
steps.push({ id: 'Corners', name: 'Fillet', type: 'fillet', edges: corners, radius: RADIUS } as Feature);
({ errors } = await after(steps));
const vPlate = vol(body('Hook'));
check('the plate: 20 x 60 x 4, its corners rounded 5', !errors.length && corners.length === 4 && near(vPlate, (WIDTH * LENGTH - 4 * (1 - PI / 4) * RADIUS * RADIUS) * THICKNESS, 1e-6), [errors, corners.length, vPlate]);

// ---------------------------------------------------------------- the holes
const holeEs = [circle('h1', 0, HY, HR), circle('h2', 0, -HY, HR)];
steps.push(sketch('Screws', XY(THICKNESS), holeEs), { id: 'Holes', name: 'Extrude', type: 'extrude', source: profileOf('Screws', holeEs), distance: -1, extent: 'through', mode: 'cut', target: 'Hook' } as Feature);
({ errors } = await after(steps));
const vHoles = vol(body('Hook'));
check('the holes: two, 4 round, through', !errors.length && near(vPlate - vHoles, 2 * PI * HR * HR * THICKNESS, 1e-3), [errors, vPlate - vHoles]);
// Countersunk: their top edges chamfered 1.5 - a ring of triangle c²/2, its middle c/3 out from the hole.
const rims = edgesOf('Hook', midpoint => near(midpoint[2], THICKNESS, 1e-6) && Math.abs(Math.abs(midpoint[1]) - HY) < HR + 1e-4 && Math.abs(midpoint[0]) < HR + 1e-4);
steps.push({ id: 'Countersinks', name: 'Chamfer', type: 'chamfer', edges: rims, radius: CS } as Feature);
({ errors } = await after(steps));
const vSunk = vol(body('Hook'));
check('the countersinks: both holes, 1.5', !errors.length && rims.length >= 2 && near(vHoles - vSunk, 2 * 2 * PI * (HR + CS / 3) * (CS * CS) / 2, 1e-3), [errors, rims.length, vHoles - vSunk]);

// ------------------------------------------------------------------ the arm
// Its path on the front plane, from the plate's top: up, a half circle over, down.
const pathEs: SketchEntity[] = [
  line('up', [0, THICKNESS], [0, UP]),
  { id: 'over', kind: 'arc', a: [0, UP], m: [BR, UP + BR], b: [2 * BR, UP] } as SketchEntity,
  line('down', [2 * BR, UP], [2 * BR, UP - DOWN])
];
const armEs = [circle('a', 0, 0, AR)];
steps.push(
  sketch('Path', XZ(), pathEs),
  sketch('Arm section', XY(THICKNESS), armEs),
  { id: 'Arm', name: 'Sweep', type: 'sweep', source: profileOf('Arm section', armEs), path: { kind: 'sketch', sketch: 'Path', entities: ['up', 'over', 'down'] }, mode: 'join', target: 'Hook' } as Feature
);
({ errors } = await after(steps));
const vArm = vol(body('Hook'));
const pathLen = UP - THICKNESS + PI * BR + DOWN;
check('the arm: its section times its path (Pappus)', !errors.length && bodies().size === 1 && near(vArm - vSunk, PI * AR * AR * pathLen, 1e-3), [errors, bodies().size, vArm - vSunk, PI * AR * AR * pathLen]);
// A path with a gap (the arc left out): said so plainly - it was the kernel's
// "Failed to build the wire, disconnected wire".
const gap = await after([...steps.slice(0, -1), { ...steps[steps.length - 1], path: { kind: 'sketch', sketch: 'Path', entities: ['up', 'down'] } } as Feature]);
check('…a path with a gap in it is refused in plain words', gap.errors.length === 1 && /don't join end to end/.test(gap.errors[0]), gap.errors);
({ errors } = await after(steps));
const [[bx0, , bz0], [bx1, , bz1]] = body('Hook').boundingBox.bounds;
check('the arm: up to 43, out to 23', near(bz1, UP + BR + AR, 1e-3) && near(bx1, 2 * BR + AR, 1e-3) && near(bx0, -WIDTH / 2, 1e-4) && near(bz0, 0, 1e-4), body('Hook').boundingBox.bounds);

const bodyHealth = health(body('Hook'), 'Hook');
check('the hook: sound, one body', bodyHealth.healthy && bodies().size === 1, bodyHealth.healthy ? `${Math.round(bodyHealth.volume)} mm³` : bodyHealth);
const codeVol = vol(body('Hook'));
const codeFaces = body('Hook').faces.length;
const codeBox = body('Hook').boundingBox.bounds;
console.log('plate', vPlate.toFixed(1), 'holes', vHoles.toFixed(1), 'sunk', vSunk.toFixed(1), 'final', codeVol.toFixed(1), 'faces', codeFaces);

// ---------------------------------------------- the hook built by hand
// On a phone-sized screen (tests/fixtures/wallhook-hand.json): the plate's
// rectangle extruded 4, its corners rounded 5; two circles on its top cut
// Through all, their rims chamfered 1.5; Sketch with the front plane tapped
// for the path (More in the sketch tools opened on an empty ring: Other
// plane and Constraints were out of reach), a line up, an arc by its centre,
// a line down; a circle on the plate's top, 6 typed in Values; Sweep with
// the circle, the path's three curves taken by one tap (tapping the others
// as well left a gap: it said "disconnected wire", in plain words now). It
// comes out the same.
{
  const hand = JSON.parse(readFileSync(new URL('./fixtures/wallhook-hand.json', import.meta.url), 'utf8')).features as Feature[];
  const { errors } = await after(hand);
  check('by hand: no errors', errors.length === 0, errors);
  const shapesB = [...bodies().values()].map(body => body as Shape3D);
  check('by hand: one body, sound', shapesB.length === 1 && health(shapesB[0], 'hand').healthy, shapesB.length);
  check('by hand: the same hook (to 0.1 %)', shapesB.length === 1 && Math.abs(vol(shapesB[0]) - codeVol) < codeVol * 1e-3, `${shapesB[0] ? vol(shapesB[0]).toFixed(1) : '-'} / ${codeVol.toFixed(1)}`);
  check('by hand: as many faces, the same box', shapesB[0]?.faces.length === codeFaces && shapesB[0].boundingBox.bounds.flat().every((x, i) => near(x, codeBox.flat()[i], 1e-3)), [shapesB[0]?.faces.length, codeFaces, shapesB[0]?.boundingBox.bounds]);
}

if (process.argv[2]) {
  writeFileSync(process.argv[2], JSON.stringify({ format: 'super', version: 2, name: 'Wall hook', features: steps }));
}
done();
