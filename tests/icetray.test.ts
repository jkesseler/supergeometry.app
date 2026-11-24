// Run: npx tsx tests/icetray.test.ts [out.json] - an ice cube tray, with the
// tools the other build tests use least: one pocket pulled down with a draft
// (so the cubes come out), patterned four along and two across, all eight
// subtracted from the block at once; the block hollowed from below (a thin
// wall all round, the pockets too); the rim rounded; ICE in letters raised on
// the front. Each step held to its size and soundness.
import { readFileSync, writeFileSync } from 'node:fs';
import opentype from 'opentype.js';
import { makeBox, measureArea, type Shape3D } from 'replicad';
import { measureVolume } from '../src/kernel/ocFree';
import { arrangement, regionRef } from '../src/sketch/regions';
import { textOutlines } from '../src/sketch/textLayout';
import { after, bodies, check, done, health, near, rect, sketch, XY, XZ } from './kit';
import type { EdgeRef, FaceRef, Feature, SketchEntity, Vec3 } from '../src/doc/types';

const vol = (s: Shape3D) => Math.abs(measureVolume(s));
/** Whether a point is inside the solid. */
const inside = (s: Shape3D, p: Vec3): boolean => {
  const e = 0.01;
  const cube = makeBox([p[0] - e, p[1] - e, p[2] - e], [p[0] + e, p[1] + e, p[2] + e]);

  return vol(s.intersect(cube) as Shape3D) > 0.5 * (2 * e) ** 3;
};
const body = (id: string) => bodies().get(id) as Shape3D;
const profileOf = (sk: string, es: SketchEntity[]) => ({ kind: 'profile' as const, sketch: sk, regions: arrangement(es).regions.map(regionRef) });
const unit = (v: number[]): Vec3 => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;

  return [v[0] / l, v[1] / l, v[2] / l]; 
};
const faceOf = (id: string, test: (c: Vec3, n: Vec3) => boolean): FaceRef => {
  const f = body(id).faces.find((f: any) => test(f.center.toTuple(), unit(f.normalAt().toTuple())));
  if (!f) {
    throw new Error('no such face');
  }

  return { body: id, center: (f as any).center.toTuple(), normal: unit((f as any).normalAt().toTuple()), area: measureArea(f as any) } as FaceRef;
};
const edgesOf = (id: string, test: (m: Vec3, d: Vec3) => boolean): EdgeRef[] =>
  body(id).edges.filter(e => test(e.pointAt(0.5).toTuple() as Vec3, unit(e.tangentAt(0.5).toTuple()))).map(e => ({ body: id, mid: e.pointAt(0.5).toTuple() as Vec3, dir: e.tangentAt(0.5).toTuple() as Vec3, length: e.length }));

const L = 100, W = 60, H = 22; // the block
const PW = 20, PL = 24, PD = 18, DRAFT = 6; // a pocket: 20 x 24 at the top, 18 deep, sides leaning in 6°
const SX = 24, SY = 28; // pocket spacing: walls 4 between them, 4 round the outside
const WALL = 2, ROUND = 1.5, EMB = 0.6, CAP = 8;

// ----------------------------------------------------------------- the block
const blockEs = [rect('b', -L / 2, -W / 2, L / 2, W / 2)];
const steps: Feature[] = [sketch('Block', XY(), blockEs), { id: 'Tray', name: 'Tray', type: 'extrude', source: profileOf('Block', blockEs), distance: H, mode: 'new' } as Feature];
let { errors } = await after(steps);
check('the block: no errors', !errors.length, errors);
const vBlock = vol(body('Tray'));
check('the block: 100 x 60 x 22', near(vBlock, L * W * H, 1e-6), vBlock);

// ---------------------------------------------------------------- one pocket
// Drawn on the top at the first corner, pulled down 18 as a body of its own, its sides leaning in 6°.
const x0 = -1.5 * SX - PW / 2, y0 = -SY / 2 - PL / 2;
const pocketEs = [rect('p', x0, y0, x0 + PW, y0 + PL)];
steps.push(sketch('Pocket', XY(H), pocketEs), { id: 'Cube', name: 'Cube', type: 'extrude', source: profileOf('Pocket', pocketEs), distance: -PD, mode: 'new', draft: DRAFT } as Feature);
({ errors } = await after(steps));
check('the pocket: no errors', !errors.length, errors);
const t = PD * Math.tan((DRAFT * Math.PI) / 180);
// A frustum of a rectangle: the prismatoid rule, h/6 (top + bottom + 4 middle).
const vCubeWant = (PD / 6) * (PW * PL + (PW - 2 * t) * (PL - 2 * t) + 4 * (PW - t) * (PL - t));
const vCube = vol(body('Cube'));
check('the pocket: 20 x 24 at the top, 18 deep, narrowing 6° each side', near(vCube, vCubeWant, 1e-3), [vCube, vCubeWant]);
const [[cx0, cy0, cz0], [cx1, cy1, cz1]] = body('Cube').boundingBox.bounds;
check('the pocket: where it was drawn, its bottom 4 above the floor', near(cx0, x0, 1e-6) && near(cx1, x0 + PW, 1e-6) && near(cy0, y0, 1e-6) && near(cy1, y0 + PL, 1e-6) && near(cz0, H - PD, 1e-6) && near(cz1, H, 1e-6), body('Cube').boundingBox.bounds);

// ---------------------------------------------------- patterned: 4 x 2 of them
steps.push(
  { id: 'Along', name: 'Pattern along', type: 'transform', bodies: ['Cube'], copy: true, op: { kind: 'linear', dir: [1, 0, 0], spacing: SX, count: 4 } } as Feature
);
({ errors } = await after(steps));
const row = [...bodies().keys()].filter(k => k === 'Cube' || k.startsWith('Along:'));
steps.push({ id: 'Across', name: 'Pattern across', type: 'transform', bodies: row, copy: true, op: { kind: 'linear', dir: [0, 1, 0], spacing: SY, count: 2 } } as Feature);
({ errors } = await after(steps));
check('the pattern: no errors', !errors.length, errors);
const cubes = [...bodies().keys()].filter(k => k !== 'Tray');
const centres = cubes.map(k => body(k).boundingBox.center.map(v => +v.toFixed(6)).slice(0, 2).join(',')).sort();
const want = [-1.5, -0.5, 0.5, 1.5].flatMap(i => [-0.5, 0.5].map(j => `${i * SX},${j * SY}`)).sort();
check('the pattern: 8 pockets, 4 along and 2 across, 24 and 28 apart', cubes.length === 8 && JSON.stringify(centres) === JSON.stringify(want), centres);
check('the pattern: each pocket the same', cubes.every(k => near(vol(body(k)), vCube, 1e-6)), cubes.map(k => vol(body(k))));

// ------------------------------------------------------------ cut out of it
steps.push({ id: 'Pockets', name: 'Subtract', type: 'boolean', op: 'subtract', target: 'Tray', tools: cubes } as Feature);
({ errors } = await after(steps));
check('the pockets: no errors', !errors.length, errors);
const vCut = vol(body('Tray'));
check('the pockets: all eight out of the block, nothing else left', near(vCut, vBlock - 8 * vCube, 1e-3) && bodies().size === 1, [vCut, vBlock - 8 * vCube]);

// ------------------------------------------------------- hollowed from below
steps.push({ id: 'Hollow', name: 'Shell', type: 'shell', body: 'Tray', faces: [faceOf('Tray', (c, n) => near(c[2], 0, 1e-6) && n[2] < -0.99)], thickness: WALL } as Feature);
({ errors } = await after(steps));
check('the shell: no errors', !errors.length, errors);
const tray = () => body('Tray');
const vShell = vol(tray());
// A wall 2 thick everywhere: about (the outside's area less the open floor) x 2, a little less at the bends inside.
const outside = tray().faces.length;
check('the shell: hollow from below, sound, lighter', health(tray(), 'Tray').healthy && vShell < vCut * 0.7 && vShell > vCut * 0.5, [vShell / vCut, health(tray(), 'Tray').healthy, outside]);
// Across the front wall halfway up, through a pocket's middle (x -36): solid
// for 2 from the outside (y -30 to -28), hollow, then the pocket's own wall 2
// thick (its side, leaning 6°, is at y -24.84 there), then the pocket.
const at = (y: number) => inside(tray(), [-36, y, H / 2]);
const side = -W / 2 + 4 + (H / 2) * Math.tan((DRAFT * Math.PI) / 180);
check("the shell: the walls 2 thick - outside, hollow, the pocket's wall, the pocket", at(-29.9) && at(-28.1) && !at(-27.9) && !at(side - 2.1) && at(side - 1.9) && at(side - 0.1) && !at(side + 0.1), [-29.9, -28.1, -27.9, side - 2.1, side - 1.9, side - 0.1, side + 0.1].map(at));
const [[bx0, by0, bz0], [bx1, by1, bz1]] = tray().boundingBox.bounds;
check('the shell: the outside unchanged (100 x 60 x 22)', near(bx0, -L / 2, 1e-6) && near(bx1, L / 2, 1e-6) && near(by0, -W / 2, 1e-6) && near(by1, W / 2, 1e-6) && near(bz0, 0, 1e-6) && near(bz1, H, 1e-6), tray().boundingBox.bounds);
// The pockets' floors (4 up) have the hollow under them: the floor of the hollow at 4 - 2 = 2 under each pocket.
const under = tray().faces.filter((f: any) => near(f.center.toTuple()[2], H - PD - WALL, 1e-6) && unit(f.normalAt().toTuple())[2] < -0.99).length;
check("the shell: under each pocket's floor, the hollow 2 below it", under === 8, under);

// ---------------------------------------------------------------- the rim
// The four outside top edges rounded 1.5.
const rim = edgesOf('Tray', m => near(m[2], H, 1e-6) && (near(Math.abs(m[0]), L / 2, 1e-6) || near(Math.abs(m[1]), W / 2, 1e-6)));
steps.push({ id: 'Rim', name: 'Fillet', type: 'fillet', edges: rim, radius: ROUND } as Feature);
({ errors } = await after(steps));
check('the rim: no errors, its 4 edges', !errors.length && rim.length === 4, [errors, rim.length]);
const vRim = vol(tray());
// (At each corner the two rounds meet mitred; what both take off there, r³ (5/3 - π/2), only goes once.)
const rimWant = (1 - Math.PI / 4) * ROUND * ROUND * 2 * (L + W) - 4 * ROUND ** 3 * (5 / 3 - Math.PI / 2);
check('the rim: a round 1.5 off along the 320 round the top', near(vShell - vRim, rimWant, 0.01), [vShell - vRim, rimWant]);

// -------------------------------------------------------------- the lettering
// ICE, capitals 8 tall, on the front, raised 0.6.
const fontFile = readFileSync('node_modules/@fontsource/roboto/files/roboto-latin-400-normal.woff');
const font = opentype.parse(fontFile.buffer.slice(fontFile.byteOffset, fontFile.byteOffset + fontFile.byteLength));
const letters = textOutlines(font, 'ICE', [0, H / 2 - CAP / 2], CAP, 0, 'center').map((e, i) => ({ ...e, id: `t${i}` }) as SketchEntity);
const front = XZ(-W / 2);
steps.push(sketch('Letters', front, letters), { id: 'Ice', name: 'Extrude', type: 'extrude', source: profileOf('Letters', letters), distance: EMB, mode: 'join', target: 'Tray' } as Feature);
({ errors } = await after(steps));
check('the lettering: no errors', !errors.length, errors);
const textArea = arrangement(letters).regions.reduce((s, r) => s + Math.abs(r.area), 0);
const vText = vol(tray()) - vRim;
check("the lettering: its letters' area x 0.6 raised", near(vText, textArea * EMB, 1e-3), [vText, textArea * EMB]);
check('the lettering: on the front, standing out 0.6', near(tray().boundingBox.bounds[0][1], -W / 2 - EMB, 1e-6), tray().boundingBox.bounds);

const h = health(tray(), 'Tray');
check('the tray: sound, one body', h.healthy && bodies().size === 1, h.healthy ? `${Math.round(h.volume)} mm³` : h);
const codeVol = vol(tray());
const tray0Faces = tray().faces.length;
console.log('block', vBlock, 'cube', vCube.toFixed(1), 'cut', vCut.toFixed(1), 'shell', vShell.toFixed(1), 'rim', vRim.toFixed(1), 'text', vText.toFixed(1), 'final', codeVol.toFixed(1));

// -------------------------------------------------- the tray built by hand
// On a phone-sized screen (tests/fixtures/icetray-hand.json): the block and
// one pocket typed (Draft angle 6, New body), Pattern - Linear on it (X, 4,
// 24), then the four pockets picked in Items and patterned across (Y, 2, 28),
// Subtract with the block and the eight tapped, Shell with the floor tapped
// (2), the rim's four edges tapped (1.5), ICE typed on the front (Size 8,
// Centre) and raised 0.6 with All shapes. It comes out the same.
{
  const hand = JSON.parse(readFileSync(new URL('./fixtures/icetray-hand.json', import.meta.url), 'utf8')).features as Feature[];
  const { errors } = await after(hand);
  check('by hand: no errors', errors.length === 0, errors);
  const H = [...bodies().values()] as Shape3D[];
  check('by hand: one body, sound', H.length === 1 && health(H[0], 'hand').healthy, H.length);
  check('by hand: the same tray (to 0.1 %)', H.length === 1 && Math.abs(vol(H[0]) - codeVol) < codeVol * 1e-3, `${H[0] ? vol(H[0]).toFixed(1) : '-'} / ${codeVol.toFixed(1)}`);
  check('by hand: the same faces', H[0]?.faces.length === tray0Faces, [H[0]?.faces.length, tray0Faces]);
}

if (process.argv[2]) {
  writeFileSync(process.argv[2], JSON.stringify({ format: 'super', version: 2, name: 'Ice cube tray', features: steps }));
}
done();
