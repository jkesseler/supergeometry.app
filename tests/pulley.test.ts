// Run: npx tsx tests/pulley.test.ts [out.json] - a V-belt pulley: its half
// section drawn on the front plane and revolved round Z (a hub, a web, a rim
// with a V groove); a keyway cut along the bore; one lightening hole through
// the web, patterned six round the axis and taken away; the rim's two outer
// edges chamfered. Each step held to its size and soundness.
import { readFileSync, writeFileSync } from 'node:fs';
import { measureVolume } from '../src/kernel/ocFree';
import { arrangement, regionRef } from '../src/sketch/regions';
import { after, bodies, check, circle, done, health, near, poly, rect, sketch, XY, XZ } from './kit';
import type { Shape3D } from 'replicad';
import type { EdgeRef, Feature, SketchEntity, Vec3 } from '../src/doc/types';

const vol = (s: Shape3D) => Math.abs(measureVolume(s));
const body = (id: string) => bodies().get(id) as Shape3D;
const profileOf = (sk: string, es: SketchEntity[]) => ({ kind: 'profile' as const, sketch: sk, regions: arrangement(es).regions.map(regionRef) });
const unit = (v: number[]): Vec3 => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;

  return [v[0] / l, v[1] / l, v[2] / l]; 
};
const edgesOf = (id: string, test: (m: Vec3, d: Vec3, len: number) => boolean): EdgeRef[] =>
  body(id).edges.filter(e => test(e.pointAt(0.5).toTuple() as Vec3, unit(e.tangentAt(0.5).toTuple()), e.length)).map(e => ({ body: id, mid: e.pointAt(0.5).toTuple() as Vec3, dir: e.tangentAt(0.5).toTuple() as Vec3, length: e.length }));
const Z = { origin: [0, 0, 0] as Vec3, dir: [0, 0, 1] as Vec3 };

const BORE = 6, HUB = 12, H = 20; // the hub: a 12 bore, 24 across, 20 long
const WEB0 = 7.5, WEB1 = 12.5; // the web: 5 thick in the middle
const RIM0 = 30, RIM = 40, R0 = 2, R1 = 18; // the rim: from 30 out to 40, 16 wide
const G0 = 6, GD = 34, G1 = 14; // the V groove: in to 34 at the middle
const KW = 3, KD = 8; // the keyway: 3 wide, to 8 from the axis
const LR = 4, LAT = 21, N = 6; // the lightening holes
const CH = 1; // the rim's chamfers

// ---------------------------------------------------------------- the body
// The half section (x out, z up), revolved a full turn round Z.
const section: [number, number][] = [[BORE, 0], [HUB, 0], [HUB, WEB0], [RIM0, WEB0], [RIM0, R0], [RIM, R0], [RIM, G0], [GD, (G0 + G1) / 2], [RIM, G1], [RIM, R1], [RIM0, R1], [RIM0, WEB1], [HUB, WEB1], [HUB, H], [BORE, H]];
// Pappus: the volume is 2π times the area times how far out its middle is (∫ x dA, by the polygon's sides).
const ixA = section.reduce((s, [x0, y0], i) => {
  const [x1, y1] = section[(i + 1) % section.length];

  return s + ((x0 * y1 - x1 * y0) * (x0 + x1)) / 6; 
}, 0);
const secEs = [poly('sec', section)];
const steps: Feature[] = [sketch('Section', XZ(), secEs), { id: 'Pulley', name: 'Revolve', type: 'revolve', source: profileOf('Section', secEs), axis: Z, angle: 360, mode: 'new' } as Feature];
let { errors } = await after(steps);
check('the body: no errors, one body', !errors.length && bodies().size === 1, errors);
const vRev = vol(body('Pulley'));
check('the body: the section turned round (Pappus)', near(vRev, 2 * Math.PI * Math.abs(ixA), 1e-3), [vRev, 2 * Math.PI * Math.abs(ixA)]);
const [[x0, y0, z0], [x1, y1, z1]] = body('Pulley').boundingBox.bounds;
check('the body: 80 across, 20 long', near(x0, -RIM, 1e-6) && near(x1, RIM, 1e-6) && near(y0, -RIM, 1e-6) && near(y1, RIM, 1e-6) && near(z0, 0, 1e-6) && near(z1, H, 1e-6), body('Pulley').boundingBox.bounds);

// --------------------------------------------------------------- the keyway
// On the hub's end: a box 3 wide from inside the bore out to 8; cut through.
const keyEs = [rect('k', BORE - 1, -KW / 2, KD, KW / 2)];
steps.push(sketch('Key', XY(H), keyEs), { id: 'Keyway', name: 'Extrude', type: 'extrude', source: profileOf('Key', keyEs), distance: -1, extent: 'through', mode: 'cut', target: 'Pulley' } as Feature);
({ errors } = await after(steps));
const vKey = vol(body('Pulley'));
// What's cut: the box beyond the bore's circle, ∫ (8 - √(36 - y²)) dy over its width.
let keyArea = 0;
for (let i = 0, n = 20000; i < n; i++) {
  const y = -KW / 2 + (KW * (i + 0.5)) / n; keyArea += ((KD - Math.sqrt(BORE * BORE - y * y)) * KW) / n; 
}
check("the keyway: 3 wide, to 8 out, the hub's length", !errors.length && near(vRev - vKey, keyArea * H, 1e-2), [errors, vRev - vKey, keyArea * H]);

// ------------------------------------------------------- the lightening holes
// A peg through the web, six of them round Z, taken away.
const pegEs = [circle('l', LAT, 0, LR)];
steps.push(
  sketch('Peg', XY(), pegEs),
  { id: 'Peg', name: 'Extrude', type: 'extrude', source: profileOf('Peg', pegEs), distance: H, mode: 'new' } as Feature,
  { id: 'Ring', name: 'Circular', type: 'transform', bodies: ['Peg'], copy: true, op: { kind: 'circular', axis: Z, count: N, angle: 360 } } as Feature
);
({ errors } = await after(steps));
const pegs = [...bodies().keys()].filter(k => k !== 'Pulley');
check('the pegs: six round the axis', !errors.length && pegs.length === N, [errors, pegs]);
steps.push({ id: 'Lighten', name: 'Subtract', type: 'boolean', op: 'subtract', target: 'Pulley', tools: pegs } as Feature);
({ errors } = await after(steps));
const vHoles = vol(body('Pulley'));
check('the holes: six, 8 round, through the 5 thick web', !errors.length && bodies().size === 1 && near(vKey - vHoles, N * Math.PI * LR * LR * (WEB1 - WEB0), 1e-3), [errors, bodies().size, vKey - vHoles]);

// ---------------------------------------------------------------- the rim
// Its two outer edges (the circles 40 round at 2 and 18 up) chamfered 1.
const rimEdges = edgesOf('Pulley', m => near(Math.hypot(m[0], m[1]), RIM, 1e-4) && (near(m[2], R0, 1e-6) || near(m[2], R1, 1e-6)));
steps.push({ id: 'Chamfers', name: 'Chamfer', type: 'chamfer', edges: rimEdges, radius: CH } as Feature);
({ errors } = await after(steps));
const vCh = vol(body('Pulley'));
// Each a ring of triangle c²/2, its middle c/3 in from the edge.
check('the rim: both outer edges chamfered 1', !errors.length && rimEdges.length >= 2 && near(vHoles - vCh, 2 * 2 * Math.PI * (RIM - CH / 3) * (CH * CH) / 2, 1e-3), [errors, rimEdges.length, vHoles - vCh]);

const h = health(body('Pulley'), 'Pulley');
check('the pulley: sound, one body', h.healthy && bodies().size === 1, h.healthy ? `${Math.round(h.volume)} mm³` : h);
const codeVol = vol(body('Pulley'));
const codeFaces = body('Pulley').faces.length;
const codeBox = body('Pulley').boundingBox.bounds;
console.log('revolve', vRev.toFixed(1), 'keyway', vKey.toFixed(1), 'holes', vHoles.toFixed(1), 'final', codeVol.toFixed(1), 'faces', codeFaces);

// ---------------------------------------------- the pulley built by hand
// On a phone-sized screen (tests/fixtures/pulley-hand.json): the section's
// fifteen sides typed (lengths and angles, the groove across and up) on the
// front plane, revolved round Z; the hub's end tapped, the keyway's box typed
// on it and cut Through all (a tap in the box gave the corner on the bore's
// seam, which Extrude can't take, before); the peg's circle on the web, a New
// body 5 down into it, picked in Items for Circular 6 round Z; Subtract with
// the pulley and the six pegs tapped in Items (the pegs are inside the web:
// Items put Subtract away, before); the rim's two edges chamfered 1. It comes
// out the same.
{
  const hand = JSON.parse(readFileSync(new URL('./fixtures/pulley-hand.json', import.meta.url), 'utf8')).features as Feature[];
  const { errors } = await after(hand);
  check('by hand: no errors', errors.length === 0, errors);
  const H = [...bodies().values()].map(s => s as Shape3D);
  check('by hand: one body, sound', H.length === 1 && health(H[0], 'hand').healthy, H.length);
  check('by hand: the same pulley (to 0.1 %)', H.length === 1 && Math.abs(vol(H[0]) - codeVol) < codeVol * 1e-3, `${H[0] ? vol(H[0]).toFixed(1) : '-'} / ${codeVol.toFixed(1)}`);
  check('by hand: as many faces, the same box', H[0]?.faces.length === codeFaces && H[0].boundingBox.bounds.flat().every((x, i) => near(x, codeBox.flat()[i], 1e-3)), [H[0]?.faces.length, codeFaces, H[0]?.boundingBox.bounds]);
}

if (process.argv[2]) {
  writeFileSync(process.argv[2], JSON.stringify({ format: 'super', version: 2, name: 'Pulley', features: steps }));
}
done();
