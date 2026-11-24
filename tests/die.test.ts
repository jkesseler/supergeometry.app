// Run: npx tsx tests/die.test.ts [out.json] - a die: a cube 16 on a side
// intersected with a ball 20 across round its middle (Combine, Intersect:
// the corners and edges come off round, each face is left a flat circle 12
// across), then pips 3 across and 1 deep on three faces - one on the top,
// two on the front, three on the right, corner to corner. Each step held to
// its size (the ball less six caps, the pips by their cylinders) and soundness.
import { readFileSync, writeFileSync } from 'node:fs';
import { measureVolume } from '../src/kernel/ocFree';
import { arrangement, regionRef } from '../src/sketch/regions';
import { after, bodies, check, circle, done, health, line, near, rect, sketch, XY, XZ, YZ } from './kit';
import type { Shape3D } from 'replicad';
import type { Feature, SketchEntity } from '../src/doc/types';

const vol = (shape: Shape3D) => Math.abs(measureVolume(shape));
const body = (id: string) => bodies().get(id) as Shape3D;
const profileOf = (sk: string, es: SketchEntity[], keep?: (c: [number, number]) => boolean) => ({ kind: 'profile' as const, sketch: sk, regions: arrangement(es).regions.map(regionRef).filter(regionRef => !keep || keep(regionRef.c as [number, number])) });
const PI = Math.PI;

const SIDE = 16; // the cube: 16 on a side, from the floor, centred on the Z axis
const RADIUS = 10; // the ball: 20 across, round the cube's middle (0, 0, 8)
const PIP_RADIUS = 1.5, PD = 1; // the pips: 3 across, 1 deep
const CORNER = 3; // corner to corner: 3 along and 3 up from the face's middle

// ---------------------------------------------------------------- the blank
const sq = [rect('s', -SIDE / 2, -SIDE / 2, SIDE / 2, SIDE / 2)];
const ballEs = [circle('c', 0, SIDE / 2, RADIUS), line('ax', [0, SIDE / 2 - RADIUS - 1], [0, SIDE / 2 + RADIUS + 1])];
const steps: Feature[] = [
  sketch('Base', XY(), sq),
  { id: 'Cube', name: 'Extrude', type: 'extrude', source: profileOf('Base', sq), distance: SIDE, mode: 'new' } as Feature,
  sketch('Half', XZ(), ballEs),
  { id: 'Ball', name: 'Revolve', type: 'revolve', source: profileOf('Half', ballEs, center => center[0] > 0), axis: { origin: [0, 0, SIDE / 2], dir: [0, 0, 1] }, angle: 360, mode: 'new' } as Feature
];
let { errors } = await after(steps);
const ball = (4 / 3) * PI * RADIUS ** 3;
check('the cube and the ball', !errors.length && bodies().size === 2 && near(vol(body('Cube')), SIDE ** 3, 1e-6) && near(vol(body('Ball')), ball, 1e-6 * ball), [errors, bodies().size]);

// What the two share: the ball less the six caps past the faces (each height = RADIUS - 8
// high; 8 < RADIUS < 8·√2, so the caps don't meet along the edges).
steps.push({ id: 'Blank', name: 'Intersect', type: 'boolean', op: 'intersect', target: 'Cube', tools: ['Ball'] } as Feature);
({ errors } = await after(steps));
const height = RADIUS - SIDE / 2;
const vBlank = ball - 6 * ((PI * height * height * (3 * RADIUS - height)) / 3);
const blank = [...bodies().values()][0] as Shape3D;
check('intersected: the ball less six caps, one body', !errors.length && bodies().size === 1 && near(vol(blank), vBlank, 1e-6 * vBlank), [errors, bodies().size, vol(blank), vBlank]);
const id = [...bodies().keys()][0];

// ---------------------------------------------------------------- the pips
// The top (1): one in the middle.
const oneEs = [circle('p1', 0, 0, PIP_RADIUS)];
// The front (2): corner to corner, on the front plane (y = -8) - x across, z up.
const twoEs = [circle('p2a', -CORNER, SIDE / 2 - CORNER, PIP_RADIUS), circle('p2b', CORNER, SIDE / 2 + CORNER, PIP_RADIUS)];
// The right (3): on x = 8 - y across, z up.
const threeEs = [circle('p3a', -CORNER, SIDE / 2 - CORNER, PIP_RADIUS), circle('p3b', 0, SIDE / 2, PIP_RADIUS), circle('p3c', CORNER, SIDE / 2 + CORNER, PIP_RADIUS)];
steps.push(
  sketch('One', XY(SIDE), oneEs),
  { id: 'Pip1', name: 'Extrude', type: 'extrude', source: profileOf('One', oneEs), distance: -PD, mode: 'cut', target: id } as Feature,
  sketch('Two', XZ(-SIDE / 2), twoEs),
  { id: 'Pip2', name: 'Extrude', type: 'extrude', source: profileOf('Two', twoEs), distance: -PD, mode: 'cut', target: id } as Feature,
  sketch('Three', YZ(SIDE / 2), threeEs),
  { id: 'Pip3', name: 'Extrude', type: 'extrude', source: profileOf('Three', threeEs), distance: -PD, mode: 'cut', target: id } as Feature
);
({ errors } = await after(steps));
const die = [...bodies().values()][0] as Shape3D;
const pips = 6 * PI * PIP_RADIUS * PIP_RADIUS * PD;
check('the pips: one, two and three, 3 across and 1 deep', !errors.length && bodies().size === 1 && near(vBlank - vol(die), pips, 1e-6 * pips), [errors, vBlank - vol(die), pips]);
const [[x0, y0, z0], [x1, y1, z1]] = die.boundingBox.bounds;
check('the die: 16 every way', [x0, y0].every(value => near(value, -SIDE / 2, 1e-4)) && [x1, y1].every(value => near(value, SIDE / 2, 1e-4)) && near(z0, 0, 1e-4) && near(z1, SIDE, 1e-4), die.boundingBox.bounds);

const hl = health(die, 'die');
check('the die: sound, one body', hl.healthy && bodies().size === 1, hl.healthy ? `${Math.round(hl.volume)} mm³` : hl);
const codeVol = vol(die);
const codeFaces = die.faces.length;
const codeBox = die.boundingBox.bounds;
console.log('blank', vBlank.toFixed(1), 'final', codeVol.toFixed(1), 'faces', codeFaces);

// ---------------------------------------------- the die built by hand
// On a phone-sized screen (tests/fixtures/die-hand.json): from the top, a
// Sketch and a square typed (X -8, Y -8, 16 x 16), Extrude 16; from the front
// a Sketch (on the cube's face, as it said: More, Other plane, XZ), a circle
// typed (X 0, Y 8, 20 across) and a line up its middle (X 0, Y -3, Up 22);
// Revolve the right half about the line, New body; Combine, Intersect, a
// corner of the cube sticking out of the ball, then the ball; each face
// tapped, Sketch, the pips typed as circles 3 across (the top's at 0, 0;
// the front's at -3, 5 and 3, 11 - up from the floor; the right's the same
// and 0, 8), Extrude, All shapes, -1. It comes out the same.
{
  const hand = JSON.parse(readFileSync(new URL('./fixtures/die-hand.json', import.meta.url), 'utf8')).features as Feature[];
  const { errors } = await after(hand);
  check('by hand: no errors', errors.length === 0, errors);
  const Bs = [...bodies().values()].map(body => body as Shape3D);
  check('by hand: one body, sound', Bs.length === 1 && health(Bs[0], 'hand').healthy, Bs.length);
  check('by hand: the same die (to 0.1 %)', Bs.length === 1 && Math.abs(vol(Bs[0]) - codeVol) < codeVol * 1e-3, `${Bs[0] ? vol(Bs[0]).toFixed(1) : '-'} / ${codeVol.toFixed(1)}`);
  check('by hand: as many faces, the same box', Bs[0]?.faces.length === codeFaces && Bs[0].boundingBox.bounds.flat().every((x, i) => near(x, codeBox.flat()[i], 1e-3)), [Bs[0]?.faces.length, codeFaces, Bs[0]?.boundingBox.bounds]);
}

if (process.argv[2]) {
  writeFileSync(process.argv[2], JSON.stringify({ format: 'super', version: 2, name: 'Die', features: steps }));
}
done();
