// Run: npx tsx tests/mug.test.ts [out.json] - a mug, with the tools the other
// build tests leave out: a body revolved from its profile and shelled open at
// the top; its floor made thicker (Move Face); two patches projected onto its
// side (Project as Edge) and a handle bridged between them along a curve drawn
// beside it (Connect); a word wrapped round the other side and raised from it
// (Wrap & Emboss, text). Each held to its size and soundness.
import { readFileSync, writeFileSync } from 'node:fs';
import opentype from 'opentype.js';
import { makeBox, measureArea, type Face, type Shape3D } from 'replicad';
import { measureVolume } from '../src/kernel/ocFree';
import { textOutlines } from '../src/sketch/textLayout';
import { arrangement, materialRegions, regionRef } from '../src/sketch/regions';
import { after, bodies, check, done, health, near, poly, profile, rect, sketch, XY, XZ } from './kit';
import type { Feature, FaceRef, PlaneDef, SketchEntity, Vec3 } from '../src/doc/types';

const PI = Math.PI;
const Z: Vec3 = [0, 0, 1];
const R = 42, H = 100, T = 4;

/** A face of the body as a step refers to it (as a tap on it gives). */
const ref = (body: string, f: Face): FaceRef => ({ body, center: f.center.toTuple() as Vec3, normal: f.normalAt().toTuple() as Vec3, area: measureArea(f) });
const faceOf = (body: string, pick: (f: Face) => boolean) => {
  const s = bodies().get(body) as Shape3D;
  const f = s.faces.find(pick);
  if (!f) {
    throw new Error(`no such face on ${body}`);
  }

  return ref(body, f);
};
const c = (f: Face) => f.center.toTuple();

// ------------------------------------------------------------------ the body
// Its profile on the front plane: a foot that steps in 4 at the bottom, 100 tall.
const profEs = [poly('p', [[0, 0], [R - 4, 0], [R, 6], [R, H], [0, H]])];
const steps: Feature[] = [
  sketch('Profile', XZ(), profEs),
  { id: 'Mug', name: 'Mug', type: 'revolve', source: profile('Profile', profEs), axis: { origin: [0, 0, 0], dir: Z }, angle: 360, mode: 'new' } as Feature
];
let { errors } = await after(steps);
check('revolved: no errors', !errors.length, errors);
const solid = (bodies().get('Mug') as Shape3D).clone();
const vSolid = Math.abs(measureVolume(solid));
// (A cone frustum for the foot, a cylinder above it.)
const vFoot = (PI * 6 * ((R - 4) ** 2 + (R - 4) * R + R * R)) / 3;
check('revolved: the right size', near(vSolid, vFoot + PI * R * R * (H - 6), 1e-3), vSolid);

// Shelled 4 thick, open at the top.
steps.push({ id: 'Shell', name: 'Shell', type: 'shell', body: 'Mug', faces: [faceOf('Mug', f => near(c(f)[2], H) && f.geomType === 'PLANE')], thickness: T } as Feature);
({ errors } = await after(steps));
check('shelled: no errors', !errors.length, errors);
const shelled = (bodies().get('Mug') as Shape3D).clone();
const vShell = Math.abs(measureVolume(shelled));
check('shelled: a wall about 4 thick', vShell > 0.9 * (PI * (R * R - (R - T) ** 2) * H) && vShell < vSolid * 0.3, vShell);

// The floor inside raised 8 (a heavier base).
const floor = faceOf('Mug', f => f.geomType === 'PLANE' && near(c(f)[2], T, 0.5) && f.normalAt().z > 0.9);
steps.push({ id: 'Floor', name: 'Move Face', type: 'moveFace', face: floor, translate: [0, 0, 8] } as Feature);
({ errors } = await after(steps));
check('floor raised: no errors', !errors.length, errors);
const vFloor = Math.abs(measureVolume(bodies().get('Mug') as Shape3D));
// (The inside filled up to 12: the floor sits where the foot tapers in, so it
// fills the taper and then the straight part above it.)
const filled = Math.abs(measureVolume(shelled.fuse(solid.intersect(makeBox([-60, -60, T], [60, 60, T + 8])))));
check('floor raised: the inside filled 8 higher', near(vFloor, filled, 1e-3), [vFloor, filled]);

// ----------------------------------------------------------------- the handle
// Two patches drawn on a plane beside the mug (facing it from +x), projected
// onto its side: the side face split round each.
const side: PlaneDef = { origin: [60, 0, 0], xDir: [0, 1, 0], normal: [1, 0, 0] };
const padEs = [rect('top', -9, 70, 9, 84), rect('low', -9, 22, 9, 36)];
steps.push(sketch('Pads', side, padEs), { id: 'Edges', name: 'Project as Edge', type: 'imprint', body: 'Mug', source: profile('Pads', padEs) } as Feature);
({ errors } = await after(steps));
check('pads projected: no errors', !errors.length, errors);
const outside = (f: Face) => f.geomType === 'CYLINDRE' && c(f)[0] > 30 && Math.abs(c(f)[1]) < 5;
const pads = (bodies().get('Mug') as Shape3D).faces.filter(outside);
// (Each in two halves: the pads lie across the seam where the revolved surface starts and ends.)
check('pads projected: two patches on the outside (in halves, on the seam)', pads.length === 4 && pads.filter(f => c(f)[2] > 60).length === 2, pads.map(f => c(f)));
check('pads projected: the size unchanged', near(Math.abs(measureVolume(bodies().get('Mug') as Shape3D)), vFloor, 1e-3));
// One half of each tapped: the handle starts from the whole pad all the same.
const top = faceOf('Mug', f => outside(f) && c(f)[2] > 60), low = faceOf('Mug', f => outside(f) && c(f)[2] < 40 && c(f)[1] > 0);

// The curve the handle follows, drawn on the front plane from one pad round to the other.
const guideEs: SketchEntity[] = [{ id: 'g', kind: 'spline', points: [[R, 77], [60, 78], [76, 66], [80, 53], [76, 40], [60, 28], [R, 29]], closed: false, mode: 'fit' } as SketchEntity];
steps.push(sketch('Handle curve', XZ(), guideEs), { id: 'Handle', name: 'Connect', type: 'connect', faces: [top, low], mode: 'join', guide: { kind: 'sketch', sketch: 'Handle curve', entities: ['g'] } } as Feature);
({ errors } = await after(steps));
check('handle: no errors', !errors.length, errors);
check('handle: joined to the mug, one body', bodies().size === 1 && bodies().has('Mug'), [...bodies().keys()]);
const withHandle = bodies().get('Mug') as Shape3D;
const vHandle = Math.abs(measureVolume(withHandle)) - vFloor;
// (About a 18 x 14 section along a curve some 75 long.)
check('handle: about the size of a handle', vHandle > 8000 && vHandle < 30000, vHandle);
const [[x0, y0, z0], [x1, y1, z1]] = withHandle.boundingBox.bounds;
check('handle: reaches out to the curve and no further', x1 > 78 && x1 < 92 && near(x0, -R, 0.5), [x0, x1]);
const outer = withHandle.intersect(makeBox([R + 2, -60, 0], [120, 60, H]));
const [[, hy0], [, hy1]] = outer.boundingBox.bounds;
check('handle: as wide as the pads (18)', hy0 > -9.5 && hy1 < 9.5 && hy1 - hy0 > 16, [hy0, hy1]);

// Written on a plane touching the far side (seen from -x), wrapped round it, raised 1.2.
const font = (() => {
  const b = readFileSync(new URL('../node_modules/@fontsource/roboto/files/roboto-latin-400-normal.woff', import.meta.url));

  return (opentype as any).parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
})();
const back: PlaneDef = { origin: [-R, 0, 0], xDir: [0, -1, 0], normal: [-1, 0, 0] };
const word = textOutlines(font, 'COFFEE', [0, 50], 16, 0, 'center');
steps.push(sketch('Word', back, word));
// (The letters as drawn, with their holes: All in the card.)
const letters = { kind: 'profile' as const, sketch: 'Word', regions: materialRegions(arrangement(word)).map(regionRef) };
const round = faceOf('Mug', f => f.geomType === 'CYLINDRE' && measureArea(f) > 20000 && f.normalAt([-R, 0, 50]).x < 0);
steps.push({ id: 'Emboss', name: 'Wrap & Emboss', type: 'wrap', source: letters, face: round, height: 1.2 } as Feature);
({ errors } = await after(steps));
check('word: no errors', !errors.length, errors);
const mug = bodies().get('Mug') as Shape3D;
const vWord = Math.abs(measureVolume(mug)) - vFloor - vHandle;
check('word: raised from the side (letters 1.2 proud)', vWord > 100 && near(mug.boundingBox.bounds[0][0], -R - 1.2, 0.05), [vWord, mug.boundingBox.bounds[0][0]]);
{
  // Centred on the far side (where the plane is nearest the axis), not
  // started from where its first letter is.
  const far = mug.intersect(makeBox([-60, -60, 40], [-R + 0.6, 60, 70]));
  const [[, fy0], [, fy1]] = far.boundingBox.bounds;
  check('word: centred on the far side', Math.abs(fy0 + fy1) < 0.5, [fy0, fy1]);
}
// Reads left to right from outside: a mark at the left end of a line written
// on the plane lands at +y (on the left, seen from -x). The plane drawn the
// other way round (facing in, as an offset of YZ gives it): the same.
const words = async (plane: PlaneDef, es: SketchEntity[]) => {
  const fs = [...steps.slice(0, -2), sketch('Word', plane, es), { id: 'Emboss', name: 'Wrap & Emboss', type: 'wrap', source: { kind: 'profile', sketch: 'Word', regions: materialRegions(arrangement(es)).map(regionRef) }, face: round, height: 1.2 } as Feature];
  const { errors } = await after(fs);

  return { errors, body: bodies().get('Mug') as Shape3D };
};
const facingIn: PlaneDef = { origin: [-R, 0, 0], xDir: [0, 1, 0], normal: [1, 0, 0] };
for (const [name, pl] of [['facing out', back], ['facing in', facingIn]] as [string, PlaneDef][]) {
  // (Written at the start of the line either way: the left as the sketch is seen.)
  const mark = await words(pl, [rect('m', -30, 20, -26, 24)]);
  // (The mug is the same either side of y = 0 but for the mark: the side it's on has more.)
  const half = (y0: number, y1: number) => Math.abs(measureVolume(mark.body.intersect(makeBox([-60, y0, 19], [0, y1, 25]))));
  const left = half(0, 60) - half(-60, 0);
  check(`a mark at the start of the line, plane ${name}: on the left (seen from outside)`, !mark.errors.length && left > 10, mark.errors.length ? mark.errors : left);
}
const flipped = await words(facingIn, textOutlines(font, 'COFFEE', [0, 50], 16, 0, 'center'));
check('the word on a plane facing in: the same as facing out', !flipped.errors.length && near(Math.abs(measureVolume(flipped.body)), Math.abs(measureVolume(mug)), 1e-3), [Math.abs(measureVolume(flipped.body)), Math.abs(measureVolume(mug))]);
await after(steps);
const h = health(mug, 'Mug');
check('the mug: sound', h.healthy, h.healthy ? `${Math.round(h.volume)} mm³` : h);
check('the mug: one body', bodies().size === 1);

const codeVol = Math.abs(measureVolume(mug));
const codeBox = mug.boundingBox.bounds;

// -------------------------------------------------------- the mug built by hand
// On a phone-sized screen (tests/fixtures/mug-hand.json): the profile, the
// pads and the curve typed point by point, the floor dragged up and 8 typed,
// both pads picked for Project as Edge, one half of each tapped for Connect,
// the word typed on an offset of the side plane (facing in) and All its
// shapes wrapped. It comes out the same.
{
  const hand = JSON.parse(readFileSync(new URL('./fixtures/mug-hand.json', import.meta.url), 'utf8')).features as Feature[];
  const { errors } = await after(hand);
  check('by hand: no errors', errors.length === 0, errors);
  const B = [...bodies().values()] as Shape3D[];
  const v = B.length === 1 ? Math.abs(measureVolume(B[0])) : NaN;
  check('by hand: one body, the same size (to 0.1 %)', Math.abs(v - codeVol) < codeVol * 1e-3, `${v.toFixed(1)} / ${codeVol.toFixed(1)}`);
  const box = B[0]?.boundingBox.bounds;
  check('by hand: the same extent (handle, word)', !!box && box.flat().every((x, i) => Math.abs(x - codeBox.flat()[i]) < 0.05), [box, codeBox]);
}
if (process.argv[2]) {
  writeFileSync(process.argv[2], JSON.stringify({ format: 'super', version: 2, name: 'Mug', features: steps }));
}
console.log('volume', codeVol.toFixed(1), 'word', vWord.toFixed(1), 'handle', vHandle.toFixed(1));
done();
