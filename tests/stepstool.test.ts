// Run: npx tsx tests/stepstool.test.ts [out.json] - a step stool: its side, an
// L (a low step in front, the high seat behind), drawn on the side plane and
// extruded 200 both ways; the step's top offset up 20; shelled 15 thick, open
// at the bottom; a hand hole through the seat. Each step held to its size (the
// L by its area, the hollow by the L moved in 15 - round where it goes round
// the step's inside corner, as an offset does) and soundness.
import { readFileSync, writeFileSync } from 'node:fs';
import { measureArea, type Face, type Shape3D } from 'replicad';
import { measureVolume } from '../src/kernel/ocFree';
import { arrangement, regionRef } from '../src/sketch/regions';
import { after, bodies, check, done, health, near, poly, rect, sketch, XY, YZ } from './kit';
import type { FaceRef, Feature, SketchEntity, Vec3 } from '../src/doc/types';

const vol = (s: Shape3D) => Math.abs(measureVolume(s));
const body = (id: string) => bodies().get(id) as Shape3D;
const profileOf = (sk: string, es: SketchEntity[]) => ({ kind: 'profile' as const, sketch: sk, regions: arrangement(es).regions.map(regionRef) });
const faceRef = (id: string, f: Face): FaceRef => ({ body: id, center: f.center.toTuple() as Vec3, normal: f.normalAt().toTuple() as Vec3, area: measureArea(f) });
const PI = Math.PI;

const HX = 200; // 400 wide: 200 either side of the side plane
const D = 300, DS = 150; // 300 deep, the step the front 150
const HS = 200, HH = 400; // the step 200 high (then 220), the seat 400
const UP = 20; // the step's top offset up 20
const T = 15; // the shell
const SW = 120, SL = 30; // the hand hole: 120 by 30, through the seat's middle

// ---------------------------------------------------------------- the L
// On the side plane (x = 0): y back from the front, z up.
const L: [number, number][] = [[0, 0], [D, 0], [D, HH], [DS, HH], [DS, HS], [0, HS]];
const sideEs = [poly('l', L)];
const steps: Feature[] = [sketch('Side', YZ(), sideEs), { id: 'Stool', name: 'Extrude', type: 'extrude', source: profileOf('Side', sideEs), distance: HX, symmetric: true, mode: 'new' } as Feature];
let { errors } = await after(steps);
const area0 = D * HS + (D - DS) * (HH - HS);
const v0 = vol(body('Stool'));
check('the L: 400 wide', !errors.length && near(v0, area0 * 2 * HX, 1e-6 * v0), [errors, v0, area0 * 2 * HX]);

// ---------------------------------------------------------------- the step up 20
const stepTop = faceRef('Stool', body('Stool').faces.find(f => f.geomType === 'PLANE' && near(f.center.z, HS, 1e-6) && f.normalAt().z > 0.99)!);
steps.push({ id: 'Raise', name: 'Offset Face', type: 'extrude', source: { kind: 'face', face: stepTop }, distance: UP, mode: 'join', target: 'Stool' } as Feature);
({ errors } = await after(steps));
const v1 = vol(body('Stool'));
check("the step's top: up 20", !errors.length && bodies().size === 1 && near(v1 - v0, DS * UP * 2 * HX, 1e-6 * v1) && body('Stool').faces.length === 8, [errors, v1 - v0, DS * UP * 2 * HX, body('Stool').faces.length]);

// ---------------------------------------------------------------- the shell
// Inside: the L moved in 15 (but not at the floor), 370 wide. Round the step's
// inside corner the inside goes round too (everything 15 from that edge):
// a quarter circle 15 across instead of a square corner, T²·(1 - π/4) more.
const HS2 = HS + UP;
const inner = (D - 2 * T) * (HS2 - T) + (D - DS - 2 * T) * (HH - HS2);
const corner = T * T * (1 - PI / 4);
const floor = faceRef('Stool', body('Stool').faces.find(f => f.geomType === 'PLANE' && near(f.center.z, 0, 1e-6))!);
steps.push({ id: 'Hollow', name: 'Shell', type: 'shell', body: 'Stool', faces: [floor], thickness: T } as Feature);
({ errors } = await after(steps));
const v2 = vol(body('Stool'));
const wantRound = (inner + corner) * (2 * HX - 2 * T);
const wantSharp = inner * (2 * HX - 2 * T);
check("the shell: 15 thick, open at the bottom, round inside the step's corner", !errors.length && bodies().size === 1 && near(v1 - v2, wantRound, 1e-6 * wantRound), [errors, v1 - v2, 'round', wantRound, 'sharp', wantSharp]);

// ---------------------------------------------------------------- the hand hole
// A slot 120 by 30 through the seat (15 thick), in its middle.
const holeEs = [rect('h', -SW / 2, DS + (D - DS) / 2 - SL / 2, SW / 2, DS + (D - DS) / 2 + SL / 2)];
steps.push(sketch('Grip', XY(HH), holeEs), { id: 'Hole', name: 'Extrude', type: 'extrude', source: profileOf('Grip', holeEs), distance: -T, mode: 'cut', target: 'Stool' } as Feature);
({ errors } = await after(steps));
const v3 = vol(body('Stool'));
check('the hand hole: through the seat', !errors.length && bodies().size === 1 && near(v2 - v3, SW * SL * T, 1e-6 * v3), [errors, v2 - v3, SW * SL * T]);
const [[x0, y0, z0], [x1, y1, z1]] = body('Stool').boundingBox.bounds;
check('the stool: 400 wide, 300 deep, 400 high', near(x0, -HX, 1e-4) && near(x1, HX, 1e-4) && near(y0, 0, 1e-4) && near(y1, D, 1e-4) && near(z0, 0, 1e-4) && near(z1, HH, 1e-4), body('Stool').boundingBox.bounds);

const h = health(body('Stool'), 'Stool');
check('the stool: sound, one body', h.healthy && bodies().size === 1, h.healthy ? `${Math.round(h.volume)} mm³` : h);
const codeVol = vol(body('Stool'));
const codeFaces = body('Stool').faces.length;
const codeBox = body('Stool').boundingBox.bounds;
console.log('L', v0.toFixed(1), 'raised', v1.toFixed(1), 'shell', v2.toFixed(1), 'final', codeVol.toFixed(1), 'faces', codeFaces);

// ---------------------------------------------- the stool built by hand
// On a phone-sized screen (tests/fixtures/stepstool-hand.json): from the
// right, a Sketch (on the side plane, as it said) and the L as typed lines
// from (0, 0): Across 300; Up 400; Across -150; Up -200; Across -150; Up -200
// closes it (each placed with Done: the value box's Enter only sets it);
// Extrude, Sides: Symmetric, Each side 200; the step's top tapped, Offset
// Face 20; from below the floor tapped, Shell, Thickness 15 (round inside
// the step's corner, as the code has it); from the top the seat tapped,
// Sketch, a rectangle typed (X -60, Y 210, 120 x 30), Extrude -15 on Auto: a
// hole through the seat. Nothing to fix; it comes out the same.
{
  const hand = JSON.parse(readFileSync(new URL('./fixtures/stepstool-hand.json', import.meta.url), 'utf8')).features as Feature[];
  const { errors } = await after(hand);
  check('by hand: no errors', errors.length === 0, errors);
  const Bs = [...bodies().values()].map(s => s as Shape3D);
  check('by hand: one body, sound', Bs.length === 1 && health(Bs[0], 'hand').healthy, Bs.length);
  check('by hand: the same stool (to 0.1 %)', Bs.length === 1 && Math.abs(vol(Bs[0]) - codeVol) < codeVol * 1e-3, `${Bs[0] ? vol(Bs[0]).toFixed(1) : '-'} / ${codeVol.toFixed(1)}`);
  check('by hand: as many faces, the same box', Bs[0]?.faces.length === codeFaces && Bs[0].boundingBox.bounds.flat().every((x, i) => near(x, codeBox.flat()[i], 1e-3)), [Bs[0]?.faces.length, codeFaces, Bs[0]?.boundingBox.bounds]);
}

if (process.argv[2]) {
  writeFileSync(process.argv[2], JSON.stringify({ format: 'super', version: 2, name: 'Step stool', features: steps }));
}
done();
