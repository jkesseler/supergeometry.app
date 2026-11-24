// Run: npx tsx tests/cablereel.test.ts [out.json] - a cable reel: its half
// section drawn on the front plane (two flanges 80 across and 3 thick, a hub
// 24 across between them, a bore 10 across) turned round the Z axis; the
// corners where the hub meets the flanges rounded 2; six windows 12 across,
// 26 out, through both flanges (one circle and a circular pattern of it in the
// sketch); the flanges' outer rims chamfered 1. Each step held to its size
// (the turn by its rings, the rounds and chamfers by Pappus) and soundness.
import { readFileSync, writeFileSync } from 'node:fs';
import { measureVolume } from '../src/kernel/ocFree';
import { arrangement, regionRef } from '../src/sketch/regions';
import { after, bodies, check, circle, done, health, near, poly, sketch, XY, XZ } from './kit';
import type { Shape3D } from 'replicad';
import type { EdgeRef, Feature, SketchEntity, Vec3 } from '../src/doc/types';

const vol = (s: Shape3D) => Math.abs(measureVolume(s));
const body = (id: string) => bodies().get(id) as Shape3D;
const profileOf = (sk: string, es: SketchEntity[]) => ({ kind: 'profile' as const, sketch: sk, regions: arrangement(es).regions.map(regionRef) });
const edgesOf = (id: string, test: (e: Shape3D['edges'][number]) => boolean): EdgeRef[] =>
  body(id).edges.filter(test).map(e => ({ body: id, mid: e.pointAt(0.5).toTuple() as Vec3, dir: e.tangentAt(0.5).toTuple() as Vec3, length: e.length }));
const PI = Math.PI;

const RO = 40, T = 3; // the flanges: 80 across, 3 thick
const RH = 12, RB = 5; // the hub 24 across, the bore 10
const L = 40; // the reel 40 long
const F = 2; // the hub's corners rounded 2
const RW = 6, DW = 26, N = 6; // six windows 12 across, 26 out
const C = 1; // the rims chamfered 1

// ---------------------------------------------------------------- the reel
const half = [poly('s', [[RB, 0], [RO, 0], [RO, T], [RH, T], [RH, L - T], [RO, L - T], [RO, L], [RB, L]])];
const steps: Feature[] = [
  sketch('Section', XZ(), half),
  { id: 'Reel', name: 'Revolve', type: 'revolve', source: profileOf('Section', half), axis: { origin: [0, 0, 0], dir: [0, 0, 1] }, angle: 360, mode: 'new' } as Feature
];
let { errors } = await after(steps);
const vReel = vol(body('Reel'));
const rings = PI * ((RO * RO - RB * RB) * T * 2 + (RH * RH - RB * RB) * (L - 2 * T));
check('the reel: two flanges, a hub, a bore', !errors.length && near(vReel, rings, 1e-6 * rings), [errors, vReel, rings]);

// The hub's two corners (circles 24 across at 3 and 37): each fills a
// spandrel ((1 - π/4)·r²) whose middle sits r·(10 - 3π)/(3·(4 - π)) out.
const corners = edgesOf('Reel', (e) => {
  const m = e.pointAt(0.5).toTuple();

  return near(Math.hypot(m[0], m[1]), RH, 1e-4) && (near(m[2], T, 1e-4) || near(m[2], L - T, 1e-4)); 
});
steps.push({ id: 'Rounds', name: 'Fillet', type: 'fillet', edges: corners, radius: F } as Feature);
({ errors } = await after(steps));
const vRound = vol(body('Reel'));
const gain = 2 * 2 * PI * (RH + (F * (10 - 3 * PI)) / (3 * (4 - PI))) * (1 - PI / 4) * F * F;
check("the hub's corners: rounded 2", !errors.length && corners.length === 2 && near(vRound - vReel, gain, 1e-4 * gain), [errors, corners.length, vRound - vReel, gain]);

// ---------------------------------------------------------------- the windows
// One circle and five turned copies of it (60° apart) on the top.
const winEs = Array.from({ length: N }, (_, k) => circle(`w${k}`, DW * Math.cos((k * 2 * PI) / N), DW * Math.sin((k * 2 * PI) / N), RW));
steps.push(sketch('Windows', XY(L), winEs), { id: 'Cut', name: 'Extrude', type: 'extrude', source: profileOf('Windows', winEs), distance: -1, extent: 'through', mode: 'cut', target: 'Reel' } as Feature);
({ errors } = await after(steps));
const vWin = vol(body('Reel'));
const holes = N * PI * RW * RW * 2 * T;
check('the windows: six, 12 across, through both flanges', !errors.length && bodies().size === 1 && near(vRound - vWin, holes, 1e-4 * holes), [errors, vRound - vWin, holes]);

// ---------------------------------------------------------------- the rims
// The four circles 80 across: each loses a triangle C²/2 whose middle is C/3 in.
const rims = edgesOf('Reel', (e) => {
  const m = e.pointAt(0.5).toTuple();

  return near(Math.hypot(m[0], m[1]), RO, 1e-4) && Math.abs(e.tangentAt(0.5).toTuple()[2]) < 1e-6; 
});
steps.push({ id: 'Rims', name: 'Chamfer', type: 'chamfer', edges: rims, radius: C } as Feature);
({ errors } = await after(steps));
const vRim = vol(body('Reel'));
const cut = 4 * 2 * PI * (RO - C / 3) * (C * C) / 2;
check('the rims: four, chamfered 1', !errors.length && rims.length === 4 && near(vWin - vRim, cut, 1e-4 * cut), [errors, rims.length, vWin - vRim, cut]);
const [[x0, y0, z0], [x1, y1, z1]] = body('Reel').boundingBox.bounds;
check('the reel: 80 across, 40 long', near(x0, -RO, 1e-3) && near(x1, RO, 1e-3) && near(y0, -RO, 1e-3) && near(y1, RO, 1e-3) && near(z0, 0, 1e-4) && near(z1, L, 1e-4), body('Reel').boundingBox.bounds);

const h = health(body('Reel'), 'Reel');
check('the reel: sound, one body', h.healthy && bodies().size === 1, h.healthy ? `${Math.round(h.volume)} mm³` : h);
const codeVol = vol(body('Reel'));
const codeFaces = body('Reel').faces.length;
const codeBox = body('Reel').boundingBox.bounds;
console.log('reel', vReel.toFixed(1), 'round', vRound.toFixed(1), 'windows', vWin.toFixed(1), 'final', codeVol.toFixed(1), 'faces', codeFaces);

// ---------------------------------------------- the reel built by hand
// On a phone-sized screen (tests/fixtures/cablereel-hand.json): a Sketch from
// the front, the half section as typed lines (a tap, X 5, Y 0, then Across /
// Up for each side: Up 34 typed came out -34 the first time - the box showed
// where the finger last was, -2.7, and the numpad kept its minus; a box that
// only follows the finger is typed over whole now); Revolve, the section, Z;
// Fillet, the hub's two corners (from straight in front the top one lines up
// with the flange's rim, and the tap took the rim: taken out, the view tilted
// a little), 2; the top face, Sketch, a circle typed (X 26, Y 0, 12 across),
// Transform, Pattern, Circular, the centre tapped, Count 6, Apply; Extrude,
// All shapes, Through all; Chamfer, the four rims from the front, 1. It
// comes out the same.
{
  const hand = JSON.parse(readFileSync(new URL('./fixtures/cablereel-hand.json', import.meta.url), 'utf8')).features as Feature[];
  const { errors } = await after(hand);
  check('by hand: no errors', errors.length === 0, errors);
  const Bs = [...bodies().values()].map(s => s as Shape3D);
  check('by hand: one body, sound', Bs.length === 1 && health(Bs[0], 'hand').healthy, Bs.length);
  check('by hand: the same reel (to 0.1 %)', Bs.length === 1 && Math.abs(vol(Bs[0]) - codeVol) < codeVol * 1e-3, `${Bs[0] ? vol(Bs[0]).toFixed(1) : '-'} / ${codeVol.toFixed(1)}`);
  check('by hand: as many faces, the same box', Bs[0]?.faces.length === codeFaces && Bs[0].boundingBox.bounds.flat().every((x, i) => near(x, codeBox.flat()[i], 1e-3)), [Bs[0]?.faces.length, codeFaces, Bs[0]?.boundingBox.bounds]);
}

if (process.argv[2]) {
  writeFileSync(process.argv[2], JSON.stringify({ format: 'super', version: 2, name: 'Cable reel', features: steps }));
}
done();
