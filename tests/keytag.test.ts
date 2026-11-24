// Run: npx tsx tests/keytag.test.ts [out.json] - a key tag: a plate with its
// corners rounded, a hole for the ring cut through, raised letters on top,
// and its top outer edge rounded all round. Each step held to its size and
// soundness.
import { readFileSync, writeFileSync } from 'node:fs';
import opentype from 'opentype.js';
import { measureVolume } from '../src/kernel/ocFree';
import { arrangement, materialRegions, regionRef } from '../src/sketch/regions';
import { textOutlines } from '../src/sketch/textLayout';
import { after, bodies, check, circle, done, health, near, rect, sketch, XY } from './kit';
import type { Shape3D } from 'replicad';
import type { EdgeRef, Feature, SketchEntity, Vec3 } from '../src/doc/types';

const { parse } = opentype as any;
const vol = (shape: Shape3D) => Math.abs(measureVolume(shape));
const body = (id: string) => bodies().get(id) as Shape3D;
const profileOf = (sk: string, es: SketchEntity[]) => ({ kind: 'profile' as const, sketch: sk, regions: arrangement(es).regions.map(regionRef) });
const unit = (vector: number[]): Vec3 => {
  const length = Math.hypot(vector[0], vector[1], vector[2]) || 1;

  return [vector[0] / length, vector[1] / length, vector[2] / length]; 
};
const edgesOf = (id: string, test: (m: Vec3, d: Vec3, len: number) => boolean): EdgeRef[] =>
  body(id).edges.filter(e => test(e.pointAt(0.5).toTuple() as Vec3, unit(e.tangentAt(0.5).toTuple()), e.length)).map(e => ({ body: id, mid: e.pointAt(0.5).toTuple() as Vec3, dir: e.tangentAt(0.5).toTuple() as Vec3, length: e.length }));

const LENGTH = 50, WIDTH = 24, THICKNESS = 3, RADIUS = 6; // the plate: 50 x 24 x 3, corners rounded 6
const HX = -18, HR = 3; // the ring's hole
const TXT = 'SG', TS = 10, TX = 5, TY = -5, TH = 1; // the letters: 10 tall, centred at x 5, raised 1
const EDGE = 1; // the top edge's round

// ---------------------------------------------------------------- the plate
const plateEs = [rect('p', -LENGTH / 2, -WIDTH / 2, LENGTH / 2, WIDTH / 2)];
const steps: Feature[] = [sketch('Plate', XY(), plateEs), { id: 'Tag', name: 'Extrude', type: 'extrude', source: profileOf('Plate', plateEs), distance: THICKNESS, mode: 'new' } as Feature];
let { errors } = await after(steps);
const corners = edgesOf('Tag', (midpoint, direction) => Math.abs(direction[2]) > 0.99 && near(Math.abs(midpoint[0]), LENGTH / 2) && near(Math.abs(midpoint[1]), WIDTH / 2));
steps.push({ id: 'Corners', name: 'Fillet', type: 'fillet', edges: corners, radius: RADIUS } as Feature);
({ errors } = await after(steps));
const vPlate = vol(body('Tag'));
check('the plate: 50 x 24 x 3, its corners rounded 6', !errors.length && corners.length === 4 && near(vPlate, (LENGTH * WIDTH - 4 * (1 - Math.PI / 4) * RADIUS * RADIUS) * THICKNESS, 1e-6), [errors, corners.length, vPlate]);

// ----------------------------------------------------------------- the hole
const holeEs = [circle('h', HX, 0, HR)];
steps.push(sketch('Ring', XY(THICKNESS), holeEs), { id: 'Hole', name: 'Extrude', type: 'extrude', source: profileOf('Ring', holeEs), distance: -1, extent: 'through', mode: 'cut', target: 'Tag' } as Feature);
({ errors } = await after(steps));
const vHole = vol(body('Tag'));
check('the hole: 6 round, through', !errors.length && near(vPlate - vHole, Math.PI * HR * HR * THICKNESS, 1e-3), [errors, vPlate - vHole]);

// -------------------------------------------------------------- the letters
// Sans (the app's own), 10 tall, centred; raised 1 off the top.
const fontFile = readFileSync('node_modules/@fontsource/roboto/files/roboto-latin-400-normal.woff');
const font = parse(fontFile.buffer.slice(fontFile.byteOffset, fontFile.byteOffset + fontFile.byteLength));
const textEs = textOutlines(font, TXT, [TX, TY], TS, 0, 'center').map((e, i) => ({ ...e, id: `t${i}` })) as SketchEntity[];
const letterRegions = materialRegions(arrangement(textEs)).map(regionRef);
steps.push(sketch('Letters', XY(THICKNESS), textEs), { id: 'Raised', name: 'Extrude', type: 'extrude', source: { kind: 'profile', sketch: 'Letters', regions: letterRegions }, distance: TH, mode: 'join', target: 'Tag' } as Feature);
({ errors } = await after(steps));
const vText = vol(body('Tag'));
// The letters' area: the sketch's own, each closed outline's (with the holes in them taken off).
const arr = arrangement(textEs);
const area = materialRegions(arr).reduce((total, materialRegion) => total + Math.abs(materialRegion.area ?? 0), 0);
check('the letters: raised 1, one body', !errors.length && bodies().size === 1 && vText > vHole && (area ? near(vText - vHole, area * TH, 0.02 * area) : true), [errors, vText - vHole, area]);
const [, [, , zTop]] = body('Tag').boundingBox.bounds;
check('the letters: 1 above the top', near(zTop, THICKNESS + TH, 1e-6), zTop);

// ---------------------------------------------------------------- the edge
// The plate's top outer edge (its sides and the four corners) rounded 1.
const rim = edgesOf('Tag', midpoint => near(midpoint[2], THICKNESS, 1e-6) && (near(Math.abs(midpoint[0]), LENGTH / 2, 1e-4) || near(Math.abs(midpoint[1]), WIDTH / 2, 1e-4) || near(Math.hypot(Math.abs(midpoint[0]) - (LENGTH / 2 - RADIUS), Math.abs(midpoint[1]) - (WIDTH / 2 - RADIUS)), RADIUS, 1e-4)));
steps.push({ id: 'Edge', name: 'Fillet', type: 'fillet', edges: rim, radius: EDGE } as Feature);
({ errors } = await after(steps));
const vEdge = vol(body('Tag'));
const perim = 2 * (LENGTH - 2 * RADIUS) + 2 * (WIDTH - 2 * RADIUS) + 2 * Math.PI * RADIUS;
check('the edge: all eight pieces, rounded 1', !errors.length && rim.length === 8 && vEdge < vText && vText - vEdge < (1 - Math.PI / 4) * EDGE * EDGE * perim * 1.01, [errors, rim.length, vText - vEdge, (1 - Math.PI / 4) * EDGE * EDGE * perim]);

const bodyHealth = health(body('Tag'), 'Tag');
check('the tag: sound, one body', bodyHealth.healthy && bodies().size === 1, bodyHealth.healthy ? `${Math.round(bodyHealth.volume)} mm³` : bodyHealth);
const codeVol = vol(body('Tag'));
const codeFaces = body('Tag').faces.length;
const codeBox = body('Tag').boundingBox.bounds;
console.log('plate', vPlate.toFixed(1), 'hole', vHole.toFixed(1), 'letters', vText.toFixed(1), 'final', codeVol.toFixed(1), 'faces', codeFaces);

// ---------------------------------------------- the tag built by hand
// On a phone-sized screen (tests/fixtures/keytag-hand.json): the plate's box
// typed, its four corners rounded 6 in the sketch (the Radius on the card
// sized the corner just tapped only after the fix; before, it set the next
// one's), extruded 3; the hole's circle cut Through all; Text "SG" 10 tall,
// centred, raised 1; one top edge filleted 1, which rounds the whole smooth
// outline. It comes out the same.
{
  const hand = JSON.parse(readFileSync(new URL('./fixtures/keytag-hand.json', import.meta.url), 'utf8')).features as Feature[];
  const { errors } = await after(hand);
  check('by hand: no errors', errors.length === 0, errors);
  const shapes = [...bodies().values()].map(body => body as Shape3D);
  check('by hand: one body, sound', shapes.length === 1 && health(shapes[0], 'hand').healthy, shapes.length);
  check('by hand: the same tag (to 0.1 %)', shapes.length === 1 && Math.abs(vol(shapes[0]) - codeVol) < codeVol * 1e-3, `${shapes[0] ? vol(shapes[0]).toFixed(1) : '-'} / ${codeVol.toFixed(1)}`);
  check('by hand: as many faces, the same box', shapes[0]?.faces.length === codeFaces && shapes[0].boundingBox.bounds.flat().every((x, i) => near(x, codeBox.flat()[i], 1e-3)), [shapes[0]?.faces.length, codeFaces, shapes[0]?.boundingBox.bounds]);
}

if (process.argv[2]) {
  writeFileSync(process.argv[2], JSON.stringify({ format: 'super', version: 2, name: 'Key tag', features: steps }));
}
done();
