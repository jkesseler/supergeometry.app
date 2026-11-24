// Run: npx tsx tests/domino.test.ts [out.json] - a domino: a plate 48 x 24 x 8,
// every edge rounded 1, a groove 1 wide and 0.5 deep across its middle; a pip
// (a ball 4 across, its middle on the top) made by turning half a circle, a
// row of three of it (Pattern), the row mirrored to the other half (Mirror),
// all six taken out of the plate (Combine, Subtract): a 3-3. Each step held
// to its size (the rounds by the box's edges and corners, the pips by half a
// ball each) and soundness.
import { readFileSync, writeFileSync } from 'node:fs';
import { measureVolume } from '../src/kernel/ocFree';
import { arrangement, regionRef } from '../src/sketch/regions';
import { after, bodies, check, circle, done, health, line, near, rect, sketch, XY, XZ } from './kit';
import type { Shape3D } from 'replicad';
import type { EdgeRef, Feature, SketchEntity, Vec3 } from '../src/doc/types';

const vol = (s: Shape3D) => Math.abs(measureVolume(s));
const body = (id: string) => bodies().get(id) as Shape3D;
const profileOf = (sk: string, es: SketchEntity[], keep?: (c: [number, number]) => boolean) => ({ kind: 'profile' as const, sketch: sk, regions: arrangement(es).regions.map(regionRef).filter(r => !keep || keep(r.c as [number, number])) });
const allEdges = (id: string): EdgeRef[] => body(id).edges.map(e => ({ body: id, mid: e.pointAt(0.5).toTuple() as Vec3, dir: e.tangentAt(0.5).toTuple() as Vec3, length: e.length }));
const PI = Math.PI;

const A = 48, B = 24, H = 8; // the plate
const F = 1; // every edge rounded 1
const GW = 1, GL = 20, GD = 0.5; // the groove: 1 wide, 20 long, 0.5 deep
const R = 2; // the pips: balls 4 across, their middles on the top
const X0 = -18, S = 6; // the first pip 18 left of the middle, the next ones 6 apart

// ---------------------------------------------------------------- the plate
const plateEs = [rect('p', -A / 2, -B / 2, A / 2, B / 2)];
const steps: Feature[] = [sketch('Outline', XY(), plateEs), { id: 'Plate', name: 'Extrude', type: 'extrude', source: profileOf('Outline', plateEs), distance: H, mode: 'new' } as Feature];
let { errors } = await after(steps);
check('the plate: 48 x 24 x 8', !errors.length && near(vol(body('Plate')), A * B * H, 1e-6), [errors, vol(body('Plate'))]);

// Every edge rounded: each edge's straight run loses (1 - π/4)·r² along it,
// each corner a cube r³ less an eighth of a ball.
steps.push({ id: 'Rounds', name: 'Fillet', type: 'fillet', edges: allEdges('Plate'), radius: F } as Feature);
({ errors } = await after(steps));
const vRound = vol(body('Plate'));
const lost = (4 - PI) * F * F * (A + B + H - 6 * F) + (8 - (4 * PI) / 3) * F ** 3;
check('the rounds: all twelve edges, 1', !errors.length && near(A * B * H - vRound, lost, 1e-4 * lost), [errors, A * B * H - vRound, lost]);

// The groove across the middle, short of the rounded ends.
const grooveEs = [rect('g', -GW / 2, -GL / 2, GW / 2, GL / 2)];
steps.push(sketch('Groove', XY(H), grooveEs), { id: 'Line', name: 'Extrude', type: 'extrude', source: profileOf('Groove', grooveEs), distance: -GD, mode: 'cut', target: 'Plate' } as Feature);
({ errors } = await after(steps));
const vGroove = vol(body('Plate'));
check('the groove: 1 wide, 20 long, 0.5 deep', !errors.length && near(vRound - vGroove, GW * GL * GD, 1e-6), [errors, vRound - vGroove]);

// ---------------------------------------------------------------- the pips
// Half a circle on the front plane (a circle and the line down its middle,
// the right half), turned round that line: a ball.
const pipEs = [circle('c', X0, H, R), line('ax', [X0, H - R - 1], [X0, H + R + 1])];
steps.push(
  sketch('Pip', XZ(), pipEs),
  { id: 'Ball', name: 'Revolve', type: 'revolve', source: profileOf('Pip', pipEs, c => c[0] > X0), axis: { origin: [X0, 0, H], dir: [0, 0, 1] }, angle: 360, mode: 'new' } as Feature
);
({ errors } = await after(steps));
const ball = (4 / 3) * PI * R ** 3;
check('the pip: a ball 4 across', !errors.length && bodies().size === 2 && near(vol(body('Ball')), ball, 1e-6 * ball), [errors, bodies().size, vol(body('Ball'))]);

steps.push(
  { id: 'Row', name: 'Pattern', type: 'transform', bodies: ['Ball'], copy: false, op: { kind: 'linear', dir: [1, 0, 0], spacing: S, count: 3 } } as Feature,
  { id: 'Other', name: 'Mirror', type: 'transform', bodies: ['Ball', 'Row:Ball:0', 'Row:Ball:1'], copy: true, op: { kind: 'mirror', plane: { origin: [0, 0, 0], normal: [1, 0, 0], xDir: [0, 1, 0] } } } as Feature
);
({ errors } = await after(steps));
const pips = [...bodies().keys()].filter(id => id !== 'Plate');
const xs = pips.map((id) => {
  const [[a], [b]] = body(id).boundingBox.bounds;

  return Math.round((a + b) / 2); 
}).sort((a, b) => a - b);
check('the pips: a row of three, mirrored - six', !errors.length && pips.length === 6 && JSON.stringify(xs) === JSON.stringify([-18, -12, -6, 6, 12, 18]), [errors, pips, xs]);

steps.push({ id: 'Holes', name: 'Subtract', type: 'boolean', op: 'subtract', target: 'Plate', tools: pips } as Feature);
({ errors } = await after(steps));
const vPips = vol(body('Plate'));
check('the dimples: six, half a ball each, out of the plate', !errors.length && bodies().size === 1 && near(vGroove - vPips, 6 * ball / 2, 1e-5 * ball), [errors, bodies().size, vGroove - vPips, 3 * ball]);

const h = health(body('Plate'), 'Plate');
check('the domino: sound, one body', h.healthy && bodies().size === 1, h.healthy ? `${Math.round(h.volume)} mm³` : h);
const codeVol = vol(body('Plate'));
const codeFaces = body('Plate').faces.length;
const codeBox = body('Plate').boundingBox.bounds;
console.log('round', vRound.toFixed(1), 'groove', vGroove.toFixed(1), 'final', codeVol.toFixed(1), 'faces', codeFaces);

// ---------------------------------------------- the domino built by hand
// On a phone-sized screen (tests/fixtures/domino-hand.json): a rectangle
// typed (48 x 24 from the middle), Extrude 8; Fillet, all twelve edges by
// tapping faces (a face tapped again took its edges out: it added the rounded
// preview's borders instead; a tap on a thin side face near a picked edge
// dropped that edge - a face's tap reaches less far for edges now), 1; the
// groove on the top, a rectangle typed, Extrude -0.5; the pip on the front
// plane (More, Other plane, XZ), a circle and a line typed through its middle,
// Revolve the right half about the line (the tap on the line landed on its
// point: an axis takes the line through a tapped point now); Pattern, Linear,
// the ball (the tap on it picked from Body 1 / Body 2), X, spacing 6; Mirror,
// the three pips tapped one after the other (the second said "tap a flat
// face": a body the plane can't use joins the mirror now), YZ; Subtract, the
// plate, then the six. It comes out the same.
{
  const hand = JSON.parse(readFileSync(new URL('./fixtures/domino-hand.json', import.meta.url), 'utf8')).features as Feature[];
  const { errors } = await after(hand);
  check('by hand: no errors', errors.length === 0, errors);
  const Bs = [...bodies().values()].map(s => s as Shape3D);
  check('by hand: one body, sound', Bs.length === 1 && health(Bs[0], 'hand').healthy, Bs.length);
  check('by hand: the same domino (to 0.1 %)', Bs.length === 1 && Math.abs(vol(Bs[0]) - codeVol) < codeVol * 1e-3, `${Bs[0] ? vol(Bs[0]).toFixed(1) : '-'} / ${codeVol.toFixed(1)}`);
  check('by hand: as many faces, the same box', Bs[0]?.faces.length === codeFaces && Bs[0].boundingBox.bounds.flat().every((x, i) => near(x, codeBox.flat()[i], 1e-3)), [Bs[0]?.faces.length, codeFaces, Bs[0]?.boundingBox.bounds]);
}

if (process.argv[2]) {
  writeFileSync(process.argv[2], JSON.stringify({ format: 'super', version: 2, name: 'Domino', features: steps }));
}
done();
