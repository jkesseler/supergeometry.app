// Run: npx tsx tests/shelfbracket.test.ts [out.json] - a shelf bracket: an L
// 4 thick (a 60 base, an 80 upright) drawn on the front plane and extruded 30
// wide, both ways; a triangular gusset 4 thick down its middle; the inside
// corner rounded 3 either side of the gusset; two screw holes 5 across through
// the base and two through the upright. Each step held to its size (the round
// by its spandrel, the holes by their cylinders) and soundness.
import { readFileSync, writeFileSync } from 'node:fs';
import { measureVolume } from '../src/kernel/ocFree';
import { arrangement, regionRef } from '../src/sketch/regions';
import { after, bodies, check, circle, done, health, near, poly, sketch, XY, XZ, YZ } from './kit';
import type { Shape3D } from 'replicad';
import type { EdgeRef, Feature, SketchEntity, Vec3 } from '../src/doc/types';

const vol = (s: Shape3D) => Math.abs(measureVolume(s));
const body = (id: string) => bodies().get(id) as Shape3D;
const profileOf = (sk: string, es: SketchEntity[]) => ({ kind: 'profile' as const, sketch: sk, regions: arrangement(es).regions.map(regionRef) });
const unit = (v: number[]): Vec3 => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;

  return [v[0] / l, v[1] / l, v[2] / l]; 
};
const edgesOf = (id: string, test: (m: Vec3, d: Vec3) => boolean): EdgeRef[] =>
  body(id).edges.filter(e => test(e.pointAt(0.5).toTuple() as Vec3, unit(e.tangentAt(0.5).toTuple()))).map(e => ({ body: id, mid: e.pointAt(0.5).toTuple() as Vec3, dir: e.tangentAt(0.5).toTuple() as Vec3, length: e.length }));
const PI = Math.PI;

const T = 4; // the L: 4 thick
const BASE = 60, UP = 80; // a 60 base, an 80 upright
const W = 30; // 30 wide, 15 either side of the front plane
const G = [50, 70]; // the gusset's legs, from the inside corner's foot: along the base to 50, up the upright to 70
const GT = 4; // the gusset: 4 thick, 2 either side
const F = 3; // the inside corner's round
const HR = 2.5, HY = 8; // the holes: 5 across, 8 either side of the middle
const HX = 40, HZ = 60; // in the base 40 out, in the upright 60 up

// ---------------------------------------------------------------- the L
const lEs = [poly('L', [[0, 0], [BASE, 0], [BASE, T], [T, T], [T, UP], [0, UP]])];
const steps: Feature[] = [sketch('Side', XZ(), lEs), { id: 'Bracket', name: 'Extrude', type: 'extrude', source: profileOf('Side', lEs), distance: W / 2, symmetric: true, mode: 'new' } as Feature];
let { errors } = await after(steps);
const vL = vol(body('Bracket'));
const lArea = BASE * T + T * (UP - T);
check('the L: a 60 base and an 80 upright, 4 thick, 30 wide', !errors.length && near(vL, lArea * W, 1e-6 * lArea * W), [errors, vL, lArea * W]);

// ---------------------------------------------------------------- the gusset
// Drawn on the same front plane, through the middle of the L: joined (Add).
const gEs = [poly('g', [[T, T], [G[0], T], [T, G[1]]])];
steps.push(sketch('Web', XZ(), gEs), { id: 'Gusset', name: 'Extrude', type: 'extrude', source: profileOf('Web', gEs), distance: GT / 2, symmetric: true, mode: 'join', target: 'Bracket' } as Feature);
({ errors } = await after(steps));
const vG = vol(body('Bracket'));
const gArea = 0.5 * (G[0] - T) * (G[1] - T);
check('the gusset: a triangle 4 thick down the middle', !errors.length && bodies().size === 1 && near(vG - vL, gArea * GT, 1e-6 * gArea * GT), [errors, vG - vL, gArea * GT]);

// ---------------------------------------------------------- the inside corner
// Along Y where the base meets the upright, in two now (the gusset between):
// each gains the corner's spandrel ((1 - π/4)·r²) along its 13.
const corner = edgesOf('Bracket', (m, d) => near(m[0], T, 1e-6) && near(m[2], T, 1e-6) && Math.abs(d[1]) > 0.999);
steps.push({ id: 'Round', name: 'Fillet', type: 'fillet', edges: corner, radius: F } as Feature);
({ errors } = await after(steps));
const vF = vol(body('Bracket'));
const spandrel = (1 - PI / 4) * F * F * (W - GT);
check('the inside corner: rounded 3, either side of the gusset', !errors.length && corner.length === 2 && near(vF - vG, spandrel, 1e-4 * spandrel), [errors, corner.length, vF - vG, spandrel]);

// ---------------------------------------------------------------- the holes
const baseEs = [circle('b1', HX, HY, HR), circle('b2', HX, -HY, HR)];
const upEs = [circle('u1', HY, HZ, HR), circle('u2', -HY, HZ, HR)];
steps.push(
  sketch('BaseHoles', XY(T), baseEs),
  { id: 'Drill1', name: 'Extrude', type: 'extrude', source: profileOf('BaseHoles', baseEs), distance: -1, extent: 'through', mode: 'cut', target: 'Bracket' } as Feature,
  sketch('WallHoles', YZ(T), upEs),
  { id: 'Drill2', name: 'Extrude', type: 'extrude', source: profileOf('WallHoles', upEs), distance: -1, extent: 'through', mode: 'cut', target: 'Bracket' } as Feature
);
({ errors } = await after(steps));
const vH = vol(body('Bracket'));
const holes = 4 * PI * HR * HR * T;
check('the holes: four, 5 across, through the base and the upright', !errors.length && bodies().size === 1 && near(vF - vH, holes, 1e-4 * holes), [errors, vF - vH, holes]);
const [[x0, y0, z0], [x1, y1, z1]] = body('Bracket').boundingBox.bounds;
check('the bracket: 60 deep, 30 wide, 80 tall', near(x0, 0, 1e-4) && near(x1, BASE, 1e-4) && near(y0, -W / 2, 1e-4) && near(y1, W / 2, 1e-4) && near(z0, 0, 1e-4) && near(z1, UP, 1e-4), body('Bracket').boundingBox.bounds);

const h = health(body('Bracket'), 'Bracket');
check('the bracket: sound, one body', h.healthy && bodies().size === 1, h.healthy ? `${Math.round(h.volume)} mm³` : h);
const codeVol = vol(body('Bracket'));
const codeFaces = body('Bracket').faces.length;
const codeBox = body('Bracket').boundingBox.bounds;
console.log('L', vL.toFixed(1), 'gusset', vG.toFixed(1), 'round', vF.toFixed(1), 'final', codeVol.toFixed(1), 'faces', codeFaces);

// ---------------------------------------------- the bracket built by hand
// On a phone-sized screen (tests/fixtures/shelfbracket-hand.json): Sketch,
// More, Other plane, XZ (front); the L as two rectangles typed (60 x 4 and
// 4 x 80, both from the origin); Extrude, All shapes (3), Symmetric, 15 each
// side; a Sketch from the front (on XZ through the origin, as it said), the
// gusset as typed lines (X 4, Y 4, Length 46, Angle 0; Across -46, Up 66; a
// tap on the first point closes it); Extrude, Symmetric 2, Add. Fillet: one
// corner piece, then a tap meant for the other landed on the gusset's side
// (all its edges added) - a tap on it again took them out now (it added the
// rounded preview's edges on top), the other piece from a turned view, 3.
// Holes: the base's top tapped (away from the gusset's foot: near it, the
// tap took its edge), Sketch, two circles typed (X 40, Y ±8, 5 across),
// Extrude, All shapes, Through all; the upright's inside face from the
// right, the same at X ±8, Y 60. It comes out the same.
{
  const hand = JSON.parse(readFileSync(new URL('./fixtures/shelfbracket-hand.json', import.meta.url), 'utf8')).features as Feature[];
  const { errors } = await after(hand);
  check('by hand: no errors', errors.length === 0, errors);
  const B = [...bodies().values()].map(s => s as Shape3D);
  check('by hand: one body, sound', B.length === 1 && health(B[0], 'hand').healthy, B.length);
  check('by hand: the same bracket (to 0.1 %)', B.length === 1 && Math.abs(vol(B[0]) - codeVol) < codeVol * 1e-3, `${B[0] ? vol(B[0]).toFixed(1) : '-'} / ${codeVol.toFixed(1)}`);
  check('by hand: as many faces, the same box', B[0]?.faces.length === codeFaces && B[0].boundingBox.bounds.flat().every((x, i) => near(x, codeBox.flat()[i], 1e-3)), [B[0]?.faces.length, codeFaces, B[0]?.boundingBox.bounds]);
}

if (process.argv[2]) {
  writeFileSync(process.argv[2], JSON.stringify({ format: 'super', version: 2, name: 'Shelf bracket', features: steps }));
}
done();
