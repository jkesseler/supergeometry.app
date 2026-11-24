// Run: npx tsx tests/soapdish.test.ts [out.json] - a soap dish: a block 80 x
// 50 x 15, its upright corners rounded 10 and its bottom edges 3, hollowed 2
// thick open at the top, eight drain holes through its floor (one drawn, the
// rest a 4 x 2 pattern of it). Each step held to its size (the roundings by
// Pappus, the hollow as the outside less the same shape 2 in) and soundness.
import { readFileSync, writeFileSync } from 'node:fs';
import { measureArea, type Face, type Shape3D } from 'replicad';
import { measureVolume } from '../src/kernel/ocFree';
import { arrangement, regionRef } from '../src/sketch/regions';
import { after, bodies, check, circle, done, health, near, rect, sketch, XY } from './kit';
import type { EdgeRef, FaceRef, Feature, SketchEntity, Vec3 } from '../src/doc/types';

const vol = (s: Shape3D) => Math.abs(measureVolume(s));
const body = (id: string) => bodies().get(id) as Shape3D;
const profileOf = (sk: string, es: SketchEntity[]) => ({ kind: 'profile' as const, sketch: sk, regions: arrangement(es).regions.map(regionRef) });
const unit = (v: number[]): Vec3 => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;

  return [v[0] / l, v[1] / l, v[2] / l]; 
};
const edgesOf = (id: string, test: (m: Vec3, d: Vec3, len: number) => boolean): EdgeRef[] =>
  body(id).edges.filter(e => test(e.pointAt(0.5).toTuple() as Vec3, unit(e.tangentAt(0.5).toTuple()), e.length)).map(e => ({ body: id, mid: e.pointAt(0.5).toTuple() as Vec3, dir: e.tangentAt(0.5).toTuple() as Vec3, length: e.length }));
const ref = (id: string, f: Face): FaceRef => ({ body: id, center: f.center.toTuple() as Vec3, normal: f.normalAt().toTuple() as Vec3, area: measureArea(f) });
const faceOf = (id: string, pick: (f: Face) => boolean) => {
  const f = body(id).faces.find(pick); if (!f) {
    throw new Error(`no such face on ${id}`);
  }

  return ref(id, f); 
};
const PI = Math.PI;

const L = 80, W = 50, H = 15; // the block
const RC = 10, RB = 3; // its upright corners' round, its bottom edges'
const T = 2; // the wall
const HR = 3, HX = [-24, -8, 8, 24], HY = [-10, 10]; // the drain holes: 6 round, 4 x 2

// A rounded rectangle's area, and what rounding its bottom edges r takes off:
// the corner's spandrel ((1 - π/4)·r²) along the straight sides and, by
// Pappus, round the corners (its middle (10 - 3π)/(12 - 3π)·r in from the wall).
const area = (l: number, w: number, rc: number) => l * w - 4 * (1 - PI / 4) * rc * rc;
const rounded = (l: number, w: number, rc: number, r: number) => (1 - PI / 4) * r * r * (2 * (l - 2 * rc) + 2 * (w - 2 * rc) + 2 * PI * (rc - ((10 - 3 * PI) / (12 - 3 * PI)) * r));
// The outside, and the inside (the same 2 in: 76 x 46, corners 8, bottom edges 1, from 2 up).
const Vout = area(L, W, RC) * H - rounded(L, W, RC, RB);
const Vin = area(L - 2 * T, W - 2 * T, RC - T) * (H - T) - rounded(L - 2 * T, W - 2 * T, RC - T, RB - T);

// ---------------------------------------------------------------- the block
const boxEs = [rect('b', -L / 2, -W / 2, L / 2, W / 2)];
const steps: Feature[] = [sketch('Base', XY(), boxEs), { id: 'Dish', name: 'Extrude', type: 'extrude', source: profileOf('Base', boxEs), distance: H, mode: 'new' } as Feature];
let { errors } = await after(steps);
const corners = edgesOf('Dish', (m, d) => Math.abs(d[2]) > 0.99);
steps.push({ id: 'Corners', name: 'Fillet', type: 'fillet', edges: corners, radius: RC } as Feature);
({ errors } = await after(steps));
const vCorners = vol(body('Dish'));
check('the block: 80 x 50 x 15, its upright corners rounded 10', !errors.length && corners.length === 4 && near(vCorners, area(L, W, RC) * H, 1e-6), [errors, corners.length, vCorners]);

// ----------------------------------------------------------- the bottom edges
const bottom = edgesOf('Dish', m => near(m[2], 0, 1e-6));
steps.push({ id: 'Bottom', name: 'Fillet', type: 'fillet', edges: bottom, radius: RB } as Feature);
({ errors } = await after(steps));
const vBottom = vol(body('Dish'));
check('the bottom edges: all round, 3 (Pappus)', !errors.length && bottom.length === 8 && near(vBottom, Vout, 1e-4), [errors, bottom.length, vBottom, Vout]);

// ---------------------------------------------------------------- the hollow
const top = faceOf('Dish', f => f.geomType === 'PLANE' && near(f.center.z, H, 1e-6));
steps.push({ id: 'Hollow', name: 'Shell', type: 'shell', body: 'Dish', faces: [top], thickness: T } as Feature);
({ errors } = await after(steps));
const vShell = vol(body('Dish'));
check('the hollow: 2 thick, open at the top', !errors.length && bodies().size === 1 && near(vShell, Vout - Vin, 1e-3), [errors, vShell, Vout - Vin]);

// ----------------------------------------------------------------- the holes
// Drawn on the floor inside (2 up), cut through it.
const holeEs = HX.flatMap((x, i) => HY.map((y, j) => circle(`h${i}${j}`, x, y, HR)));
steps.push(sketch('Drains', XY(T), holeEs), { id: 'Holes', name: 'Extrude', type: 'extrude', source: profileOf('Drains', holeEs), distance: -1, extent: 'through', mode: 'cut', target: 'Dish' } as Feature);
({ errors } = await after(steps));
const vHoles = vol(body('Dish'));
check('the holes: eight, 6 round, through the floor', !errors.length && near(vShell - vHoles, 8 * PI * HR * HR * T, 1e-3), [errors, vShell - vHoles, 8 * PI * HR * HR * T]);
const [[bx0, by0, bz0], [bx1, by1, bz1]] = body('Dish').boundingBox.bounds;
check('the dish: still 80 x 50 x 15', near(bx1 - bx0, L, 1e-4) && near(by1 - by0, W, 1e-4) && near(bz1 - bz0, H, 1e-4), body('Dish').boundingBox.bounds);

const h = health(body('Dish'), 'Dish');
check('the dish: sound, one body', h.healthy && bodies().size === 1, h.healthy ? `${Math.round(h.volume)} mm³` : h);
const codeVol = vol(body('Dish'));
const codeFaces = body('Dish').faces.length;
const codeBox = body('Dish').boundingBox.bounds;
console.log('corners', vCorners.toFixed(1), 'bottom', vBottom.toFixed(1), 'shell', vShell.toFixed(1), 'final', codeVol.toFixed(1), 'faces', codeFaces);

// ---------------------------------------------- the dish built by hand
// On a phone-sized screen (tests/fixtures/soapdish-hand.json): Sketch, the
// floor tapped (from the usual view most of it is behind the front plane: the
// front plane it was, twice - the hint names the planes on the options wheel
// now), a rectangle 80 x 50, extruded 15; Fillet, three upright corners, the
// view turned for the fourth (a stray top edge tapped again was added, not
// dropped: its 1 mm preview round's edge was a hair nearer - dropped now),
// 10; Fillet, the bottom face from below, 3; Shell, the top, 2; Sketch from
// the top (on the floor inside), a circle 6 across, its centre typed X -24,
// Y -10 (−24 on the numpad gave 24.6224: the sign flipped the old value and
// the digits went on its end), patterned 4 along X 16 apart, then the row 2
// along Y 20 apart; the eight cut Through all. It comes out the same.
{
  const hand = JSON.parse(readFileSync(new URL('./fixtures/soapdish-hand.json', import.meta.url), 'utf8')).features as Feature[];
  const { errors } = await after(hand);
  check('by hand: no errors', errors.length === 0, errors);
  const B = [...bodies().values()].map(s => s as Shape3D);
  check('by hand: one body, sound', B.length === 1 && health(B[0], 'hand').healthy, B.length);
  check('by hand: the same dish (to 0.1 %)', B.length === 1 && Math.abs(vol(B[0]) - codeVol) < codeVol * 1e-3, `${B[0] ? vol(B[0]).toFixed(1) : '-'} / ${codeVol.toFixed(1)}`);
  check('by hand: as many faces, the same box', B[0]?.faces.length === codeFaces && B[0].boundingBox.bounds.flat().every((x, i) => near(x, codeBox.flat()[i], 1e-3)), [B[0]?.faces.length, codeFaces, B[0]?.boundingBox.bounds]);
}

if (process.argv[2]) {
  writeFileSync(process.argv[2], JSON.stringify({ format: 'super', version: 2, name: 'Soap dish', features: steps }));
}
done();
