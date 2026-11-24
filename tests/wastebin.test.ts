// Run: npx tsx tests/wastebin.test.ts [out.json] - a waste bin: a square 240
// on a side extruded 300 with its sides leaning out 5° (a draft); shelled 3
// thick, open at the top; a handle slot 80 by 25 cut through the front and
// back walls near the top. Each step held to its size (the frustum by its two
// squares, the hollow by each wall moved in 3 along its own slant, the slots
// by the wall's width across) and soundness.
import { readFileSync, writeFileSync } from 'node:fs';
import { measureArea, type Face, type Shape3D } from 'replicad';
import { measureVolume } from '../src/kernel/ocFree';
import { arrangement, regionRef } from '../src/sketch/regions';
import { after, bodies, check, done, health, near, rect, sketch, XY, XZ } from './kit';
import type { FaceRef, Feature, SketchEntity, Vec3 } from '../src/doc/types';

const vol = (s: Shape3D) => Math.abs(measureVolume(s));
const body = (id: string) => bodies().get(id) as Shape3D;
const profileOf = (sk: string, es: SketchEntity[], keep?: (c: [number, number]) => boolean) => ({ kind: 'profile' as const, sketch: sk, regions: arrangement(es).regions.map(regionRef).filter(r => !keep || keep(r.c as [number, number])) });
const faceRef = (id: string, f: Face): FaceRef => ({ body: id, center: f.center.toTuple() as Vec3, normal: f.normalAt().toTuple() as Vec3, area: measureArea(f) });
const PI = Math.PI;

const A = 120; // the foot: 240 square, centred
const H = 300; // 300 high
const DEG = 5; // the sides lean out 5°
const T = 3; // the shell: 3 thick, open at the top
const SW = 80, SH = 25, SZ = 250; // the slots: 80 wide, 25 high, from 250 up

const t = Math.tan((DEG * PI) / 180);
// Half the width at height z, outside; inside (each wall moved in 3 along its normal: 3 / cos across).
const out = (z: number) => A + z * t;
const inn = (z: number) => out(z) - T / Math.cos((DEG * PI) / 180);
// ∫ (2·w(z))² dz for w linear in z, from z0 to z1.
const squares = (w: (z: number) => number, z0: number, z1: number) => (4 * (w(z1) ** 3 - w(z0) ** 3)) / (3 * t);

// ---------------------------------------------------------------- the bin
const foot = [rect('s', -A, -A, A, A)];
const steps: Feature[] = [sketch('Foot', XY(), foot), { id: 'Bin', name: 'Extrude', type: 'extrude', source: profileOf('Foot', foot), distance: H, draft: -DEG, mode: 'new' } as Feature];
let { errors } = await after(steps);
const vBin = vol(body('Bin'));
check('the bin: 240 square at the foot, leaning out 5°, 300 high', !errors.length && near(vBin, squares(out, 0, H), 1e-6 * vBin), [errors, vBin, squares(out, 0, H)]);
const [[, , ], [bx1, by1, bz1]] = body('Bin').boundingBox.bounds;
check('the bin: its top 2·(120 + 300·tan 5°) across', near(bx1, out(H), 1e-4) && near(by1, out(H), 1e-4) && near(bz1, H, 1e-6), body('Bin').boundingBox.bounds);

// ---------------------------------------------------------------- the shell
const top = faceRef('Bin', body('Bin').faces.find(f => f.geomType === 'PLANE' && near(f.center.z, H, 1e-6))!);
steps.push({ id: 'Hollow', name: 'Shell', type: 'shell', body: 'Bin', faces: [top], thickness: T } as Feature);
({ errors } = await after(steps));
const vShell = vol(body('Bin'));
const vInside = squares(inn, T, H);
check('the shell: 3 thick, open at the top', !errors.length && bodies().size === 1 && near(vBin - vShell, vInside, 1e-6 * vInside), [errors, vBin - vShell, vInside]);

// ---------------------------------------------------------------- the slots
// Handles: a slot 60 by 20 near the top, drawn on the middle plane and cut
// both ways through the front and back walls. Through a wall leaning 5° a
// straight cut takes the slot's area times 3 / cos 5° (the wall, across).
const slotEs = [rect('h', -SW / 2, SZ, SW / 2, SZ + SH)];
steps.push(sketch('Grip', XZ(), slotEs), { id: 'Slots', name: 'Extrude', type: 'extrude', source: profileOf('Grip', slotEs), distance: out(H) + 10, symmetric: true, mode: 'cut', target: 'Bin' } as Feature);
({ errors } = await after(steps));
const vSlots = vol(body('Bin'));
const slots = 2 * SW * SH * (T / Math.cos((DEG * PI) / 180));
check('the slots: through the front and back walls', !errors.length && bodies().size === 1 && near(vShell - vSlots, slots, 1e-6 * slots), [errors, vShell - vSlots, slots]);
check('the slots: four faces round each', body('Bin').faces.length === 11 + 2 * 4, body('Bin').faces.length);

const h = health(body('Bin'), 'Bin');
check('the bin: sound, one body', h.healthy && bodies().size === 1, h.healthy ? `${Math.round(h.volume)} mm³` : h);
const codeVol = vol(body('Bin'));
const codeFaces = body('Bin').faces.length;
const codeBox = body('Bin').boundingBox.bounds;
console.log('bin', vBin.toFixed(1), 'shell', vShell.toFixed(1), 'final', codeVol.toFixed(1), 'faces', codeFaces);

// ---------------------------------------------- the bin built by hand
// On a phone-sized screen (tests/fixtures/wastebin-hand.json): from the top,
// a Sketch and a rectangle typed (X -120, Y -120, 240 x 240); Extrude 300,
// Draft angle 5 - the sides leaned in, narrowing to the top, and nothing said
// which way a sign leans (the hint says so now while a draft is set), so -5;
// the top tapped, Shell, Thickness 3; from the front a Sketch (on the front
// plane through the middle, as it said), a rectangle typed (X -40, Y 250,
// 80 x 25), Extrude, Sides: Symmetric, Each side 160, on Auto: through both
// walls. It comes out the same.
{
  const hand = JSON.parse(readFileSync(new URL('./fixtures/wastebin-hand.json', import.meta.url), 'utf8')).features as Feature[];
  const { errors } = await after(hand);
  check('by hand: no errors', errors.length === 0, errors);
  const Bs = [...bodies().values()].map(s => s as Shape3D);
  check('by hand: one body, sound', Bs.length === 1 && health(Bs[0], 'hand').healthy, Bs.length);
  check('by hand: the same bin (to 0.1 %)', Bs.length === 1 && Math.abs(vol(Bs[0]) - codeVol) < codeVol * 1e-3, `${Bs[0] ? vol(Bs[0]).toFixed(1) : '-'} / ${codeVol.toFixed(1)}`);
  check('by hand: as many faces, the same box', Bs[0]?.faces.length === codeFaces && Bs[0].boundingBox.bounds.flat().every((x, i) => near(x, codeBox.flat()[i], 1e-3)), [Bs[0]?.faces.length, codeFaces, Bs[0]?.boundingBox.bounds]);
}

if (process.argv[2]) {
  writeFileSync(process.argv[2], JSON.stringify({ format: 'super', version: 2, name: 'Waste bin', features: steps }));
}
done();
