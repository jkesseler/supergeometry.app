// Run: npx tsx tests/cableclip.test.ts [out.json] - a cable clip: a ring 12
// across inside, 2 thick, opened 6 wide at the top, on a tab 28 x 2 under it,
// all 8 tall; two screw holes 3 across through the tab. Each step held to its
// size (the outline's area worked out from circles' segments and strips) and
// soundness.
import { readFileSync, writeFileSync } from 'node:fs';
import { measureVolume } from '../src/kernel/ocFree';
import { arrangement, regionRef } from '../src/sketch/regions';
import { after, bodies, check, circle, done, health, line, near, rect, sketch, XY } from './kit';
import type { Shape3D } from 'replicad';
import type { Feature, PlaneDef, SketchEntity, Vec3 } from '../src/doc/types';

const vol = (s: Shape3D) => Math.abs(measureVolume(s));
const body = (id: string) => bodies().get(id) as Shape3D;
const profileOf = (sk: string, es: SketchEntity[]) => ({ kind: 'profile' as const, sketch: sk, regions: arrangement(es).regions.map(regionRef) });
const PI = Math.PI;

const RI = 6, RO = 8; // the ring: 12 across inside, 16 outside
const G = 3; // the opening: 6 wide (3 either side of the middle)
const TW = 14, T0 = -8.5, T1 = -6.5; // the tab: 28 wide, from 8.5 to 6.5 below the middle
const H = 8; // all of it 8 tall
const HX = 10, HR = 1.5; // the screw holes: 10 either side, 3 across

// Areas: the strip |x| < a of a circle's upper half; a circle's segment below y = -d.
const strip = (r: number, a: number) => a * Math.sqrt(r * r - a * a) + r * r * Math.asin(a / r);
const segment = (r: number, d: number) => r * r * Math.acos(d / r) - d * Math.sqrt(r * r - d * d);
const area = PI * (RO * RO - RI * RI) - (strip(RO, G) - strip(RI, G)) + 2 * TW * (T1 - T0) - segment(RO, -T1);

// ---------------------------------------------------------------- the clip
// The ring's ends where the opening's sides cut it, the arcs round the bottom.
const yo = Math.sqrt(RO * RO - G * G), yi = Math.sqrt(RI * RI - G * G);
const clipEs: SketchEntity[] = [
  { id: 'out', kind: 'arc', a: [-G, yo], m: [0, -RO], b: [G, yo] } as SketchEntity,
  { id: 'in', kind: 'arc', a: [-G, yi], m: [0, -RI], b: [G, yi] } as SketchEntity,
  line('l', [-G, yi], [-G, yo]),
  line('r', [G, yi], [G, yo]),
  rect('tab', -TW, T0, TW, T1)
];
const steps: Feature[] = [sketch('Clip', XY(), clipEs), { id: 'Clip', name: 'Extrude', type: 'extrude', source: profileOf('Clip', clipEs), distance: H, mode: 'new' } as Feature];
let { errors } = await after(steps);
const vClip = vol(body('Clip'));
check('the clip: the opened ring on its tab, 8 tall', !errors.length && bodies().size === 1 && near(vClip, area * H, 1e-6 * area * H), [errors, bodies().size, vClip, area * H]);
const [[x0, y0, z0], [x1, y1, z1]] = body('Clip').boundingBox.bounds;
check("the clip: 28 wide, from the tab's underside to the ring's top", near(x1 - x0, 2 * TW, 1e-4) && near(y0, T0, 1e-4) && near(y1, yo, 1e-4) && near(z1 - z0, H, 1e-6), body('Clip').boundingBox.bounds);

// ---------------------------------------------------------------- the holes
// Drawn on the tab's underside (facing down Y), 4 up, cut through the tab.
const under: PlaneDef = { origin: [0, T0, 0], xDir: [1, 0, 0], normal: [0, -1, 0] };
const holeEs = [circle('h1', HX, H / 2, HR), circle('h2', -HX, H / 2, HR)];
steps.push(sketch('Screws', under, holeEs), { id: 'Holes', name: 'Extrude', type: 'extrude', source: profileOf('Screws', holeEs), distance: -1, extent: 'through', mode: 'cut', target: 'Clip' } as Feature);
({ errors } = await after(steps));
const vHoles = vol(body('Clip'));
check('the holes: two, 3 across, through the tab', !errors.length && near(vClip - vHoles, 2 * PI * HR * HR * (T1 - T0), 1e-4), [errors, vClip - vHoles, 2 * PI * HR * HR * (T1 - T0)]);

const h = health(body('Clip'), 'Clip');
check('the clip: sound, one body', h.healthy && bodies().size === 1, h.healthy ? `${Math.round(h.volume)} mm³` : h);
const codeVol = vol(body('Clip'));
const codeFaces = body('Clip').faces.length;
const codeBox = body('Clip').boundingBox.bounds;
console.log('clip', vClip.toFixed(1), 'final', codeVol.toFixed(1), 'faces', codeFaces);

// ---------------------------------------------- the clip built by hand
// On a phone-sized screen (tests/fixtures/cableclip-hand.json): Sketch from
// the top, a circle 12 across, Offset Edge 2 out of it; the opening's sides
// as two lines typed in Values (X ±3, Y 4, Length 5.5, Angle 90: tapped,
// they took the inner circle's 3-4-5 point a finger's width off); the tab a
// rectangle typed (X -14, Y -8.5, 28 x 2); Trim, six taps: the two arcs
// across the opening and the lines' ends past the ring; Extrude, All shapes
// (3), 8; from the front, a sketch on the tab's underside, two circles 3
// across at X ±10, 4 up, cut Through all. It comes out the same.
{
  const hand = JSON.parse(readFileSync(new URL('./fixtures/cableclip-hand.json', import.meta.url), 'utf8')).features as Feature[];
  const { errors } = await after(hand);
  check('by hand: no errors', errors.length === 0, errors);
  const B = [...bodies().values()].map(s => s as Shape3D);
  check('by hand: one body, sound', B.length === 1 && health(B[0], 'hand').healthy, B.length);
  check('by hand: the same clip (to 0.1 %)', B.length === 1 && Math.abs(vol(B[0]) - codeVol) < codeVol * 1e-3, `${B[0] ? vol(B[0]).toFixed(1) : '-'} / ${codeVol.toFixed(1)}`);
  check('by hand: as many faces, the same box', B[0]?.faces.length === codeFaces && B[0].boundingBox.bounds.flat().every((x, i) => near(x, codeBox.flat()[i], 1e-3)), [B[0]?.faces.length, codeFaces, B[0]?.boundingBox.bounds]);
}

if (process.argv[2]) {
  writeFileSync(process.argv[2], JSON.stringify({ format: 'super', version: 2, name: 'Cable clip', features: steps }));
}
done();
