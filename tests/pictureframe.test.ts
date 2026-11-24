// Run: npx tsx tests/pictureframe.test.ts [out.json] - a picture frame: an
// L-shaped bar section (15 wide, 12 deep, a 6 x 4 rebate at the back for the
// glass) swept round a rectangle 100 x 80, the corners mitred; its outside
// front edge rounded 2, its inside front edge chamfered 1; a hole 5 across,
// 6 deep, in the back of the top bar to hang it by. Each step held to its size
// (the sweep and the edges by the length of the loop at each offset) and
// soundness.
import { readFileSync, writeFileSync } from 'node:fs';
import { measureVolume } from '../src/kernel/ocFree';
import { arrangement, regionRef } from '../src/sketch/regions';
import { after, bodies, check, circle, done, health, near, poly, rect, sketch, XY, XZ } from './kit';
import type { Shape3D } from 'replicad';
import type { EdgeRef, Feature, SketchEntity, Vec3 } from '../src/doc/types';

const vol = (shape: Shape3D) => Math.abs(measureVolume(shape));
const body = (id: string) => bodies().get(id) as Shape3D;
const profileOf = (sk: string, es: SketchEntity[]) => ({ kind: 'profile' as const, sketch: sk, regions: arrangement(es).regions.map(regionRef) });
const edgesOf = (id: string, test: (m: number[], d: number[]) => boolean): EdgeRef[] =>
  body(id).edges.filter(e => test(e.pointAt(0.5).toTuple(), e.tangentAt(0.5).toTuple())).map(e => ({ body: id, mid: e.pointAt(0.5).toTuple() as Vec3, dir: e.tangentAt(0.5).toTuple() as Vec3, length: e.length }));
const PI = Math.PI;

const WIDTH = 100, HEIGHT = 80; // the path: the opening, 100 x 80
const BW = 15, BD = 12; // the bar: 15 wide, 12 deep
const RW = 6, RD = 4; // the rebate at the back: 6 in, 4 deep
const FILLET = 2; // the outside front edge rounded 2
const CHAMFER = 1; // the inside front edge chamfered 1
const HR = 2.5, HD = 6; // the hanging hole: 5 across, 6 deep, in the top bar's back

// The loop's length at `offset` out from the opening (mitred corners): 2(WIDTH + 2·offset) + 2(HEIGHT + 2·offset).
const loop = (offset: number) => 2 * (WIDTH + HEIGHT) + 8 * offset;

// ---------------------------------------------------------------- the frame
const pathEs = [rect('r', -WIDTH / 2, -HEIGHT / 2, WIDTH / 2, HEIGHT / 2)];
// The section where the path crosses the front plane (the right bar), u = x - 50 out.
const x0 = WIDTH / 2;
const secEs = [poly('L', [[x0 + RW, 0], [x0 + BW, 0], [x0 + BW, BD], [x0, BD], [x0, RD], [x0 + RW, RD]])];
const steps: Feature[] = [
  sketch('Opening', XY(), pathEs),
  sketch('Section', XZ(), secEs),
  { id: 'Frame', name: 'Sweep', type: 'sweep', source: profileOf('Section', secEs), path: { kind: 'sketch', sketch: 'Opening', entities: ['r'] }, mode: 'new', corner: 'mitre' } as Feature
];
let { errors } = await after(steps);
const vFrame = vol(body('Frame'));
// Section: the 15 x 12 less the 6 x 4 rebate; ∫ loop(u) dA = loop(0)·SECTION_AREA + 8·∫u dA.
const SECTION_AREA = BW * BD - RW * RD;
const uA = (BW * BD * BW) / 2 - (RW * RD * RW) / 2;
const vSweep = loop(0) * SECTION_AREA + 8 * uA;
check('the frame: the section swept round, mitred', !errors.length && near(vFrame, vSweep, 1e-5 * vSweep), [errors, vFrame, vSweep]);

// The outside front edge: four lines at z 12, round the outside. The round's
// spandrel ((1 - π/4)·r²) has its middle r·(10 - 3π)/(3·(4 - π)) in from it.
const outside = edgesOf('Frame', midpoint => near(midpoint[2], BD, 1e-4) && (near(Math.abs(midpoint[0]), x0 + BW, 1e-4) || near(Math.abs(midpoint[1]), HEIGHT / 2 + BW, 1e-4)));
steps.push({ id: 'Round', name: 'Fillet', type: 'fillet', edges: outside, radius: FILLET } as Feature);
({ errors } = await after(steps));
const vRound = vol(body('Frame'));
const dF = (FILLET * (10 - 3 * PI)) / (3 * (4 - PI));
const lostF = (1 - PI / 4) * FILLET * FILLET * loop(BW - dF);
check('the outside front edge: rounded 2', !errors.length && outside.length === 4 && near(vFrame - vRound, lostF, 1e-4 * lostF), [errors, outside.length, vFrame - vRound, lostF]);

// The inside front edge: a triangle CHAMFER²/2 off it, its middle CHAMFER/3 out.
const inside = edgesOf('Frame', midpoint => near(midpoint[2], BD, 1e-4) && (near(Math.abs(midpoint[0]), x0, 1e-4) || near(Math.abs(midpoint[1]), HEIGHT / 2, 1e-4)));
steps.push({ id: 'Bevel', name: 'Chamfer', type: 'chamfer', edges: inside, radius: CHAMFER } as Feature);
({ errors } = await after(steps));
const vBevel = vol(body('Frame'));
const lostC = ((CHAMFER * CHAMFER) / 2) * loop(CHAMFER / 3);
check('the inside front edge: chamfered 1', !errors.length && inside.length === 4 && near(vRound - vBevel, lostC, 1e-4 * lostC), [errors, inside.length, vRound - vBevel, lostC]);

// ---------------------------------------------------------------- the hole
// In the back of the top bar, half way across what is left of it past the rebate (46 to 55).
const HY = HEIGHT / 2 + (RW + BW) / 2;
const holeEs = [circle('h', 0, HY, HR)];
steps.push(sketch('Hanger', XY(), holeEs), { id: 'Hole', name: 'Extrude', type: 'extrude', source: profileOf('Hanger', holeEs), distance: HD, mode: 'cut', target: 'Frame' } as Feature);
({ errors } = await after(steps));
const vHole = vol(body('Frame'));
const hole = PI * HR * HR * HD;
check('the hole: 5 across, 6 deep, in the back of the top bar', !errors.length && bodies().size === 1 && near(vBevel - vHole, hole, 1e-4 * hole), [errors, vBevel - vHole, hole]);
const [[bx0, by0, bz0], [bx1, by1, bz1]] = body('Frame').boundingBox.bounds;
check('the frame: 130 x 110 x 12', near(bx0, -65, 1e-3) && near(bx1, 65, 1e-3) && near(by0, -55, 1e-3) && near(by1, 55, 1e-3) && near(bz0, 0, 1e-4) && near(bz1, BD, 1e-4), body('Frame').boundingBox.bounds);

const bodyHealth = health(body('Frame'), 'Frame');
check('the frame: sound, one body', bodyHealth.healthy && bodies().size === 1, bodyHealth.healthy ? `${Math.round(bodyHealth.volume)} mm³` : bodyHealth);
const codeVol = vol(body('Frame'));
const codeFaces = body('Frame').faces.length;
const codeBox = body('Frame').boundingBox.bounds;
console.log('sweep', vFrame.toFixed(1), 'round', vRound.toFixed(1), 'bevel', vBevel.toFixed(1), 'final', codeVol.toFixed(1), 'faces', codeFaces);

// ---------------------------------------------- the frame built by hand
// On a phone-sized screen (tests/fixtures/pictureframe-hand.json): from the
// top, a Sketch and a rectangle typed (X -50, Y -40, 100 x 80); from the
// front, a Sketch and the section as typed lines from (56, 0) (Across / Up,
// Up -8 and -4 on the way back); Sweep, the section, the rectangle, Corners:
// Mitre (each leg was a piece of its own: the front four faces meeting along
// the mitres, which a 1 chamfer round the inside "didn't fit" - one face now);
// Fillet from the top, the four outside edges (the left one's tap, just off
// the face, took the back edge right under it: the nearer of two on the same
// pixels now), 2; Chamfer, the four inside edges, 1; from below, a Sketch on
// the back, a circle typed (X 0, Y -50.5 - up the screen from there is the
// frame's bottom - 5 across), Extrude -6. It comes out the same.
{
  const hand = JSON.parse(readFileSync(new URL('./fixtures/pictureframe-hand.json', import.meta.url), 'utf8')).features as Feature[];
  const { errors } = await after(hand);
  check('by hand: no errors', errors.length === 0, errors);
  const Bs = [...bodies().values()].map(body => body as Shape3D);
  check('by hand: one body, sound', Bs.length === 1 && health(Bs[0], 'hand').healthy, Bs.length);
  check('by hand: the same frame (to 0.1 %)', Bs.length === 1 && Math.abs(vol(Bs[0]) - codeVol) < codeVol * 1e-3, `${Bs[0] ? vol(Bs[0]).toFixed(1) : '-'} / ${codeVol.toFixed(1)}`);
  check('by hand: as many faces, the same box', Bs[0]?.faces.length === codeFaces && Bs[0].boundingBox.bounds.flat().every((x, i) => near(x, codeBox.flat()[i], 1e-3)), [Bs[0]?.faces.length, codeFaces, Bs[0]?.boundingBox.bounds]);
}

if (process.argv[2]) {
  writeFileSync(process.argv[2], JSON.stringify({ format: 'super', version: 2, name: 'Picture frame', features: steps }));
}
done();
