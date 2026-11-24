// Run: npx tsx tests/shoe.test.ts [out.json] - a sneaker made of freeforms, the
// way the Freeform tool makes them (box / surface / cylinder shapes, slices of
// points picked and moved or scaled by typed values, faces deleted, a
// thickness): a foam sole with a toe spring and a higher heel, a hollow upper
// open at the collar sitting down in it, a tongue, three lace bars (one, and
// a pattern of it). The upper is cut back where it sits in the sole (Subtract,
// the sole kept). Each part held to its size and soundness.
import { readFileSync, writeFileSync } from 'node:fs';
import { measureVolume, type Shape3D } from 'replicad';
import { boxCage, deleteFaces, insertEdgeLoop, isClosed, moveTurnScale, planeCage, selfCrossings, shapeCage, windingAgrees, type Cage } from '../src/freeform/cage';
import { after, bodies, check, done, extrude, health, rect, sketch, XY } from './kit';
import type { Feature, Vec3 } from '../src/doc/types';

/** The points of `cage` that `pick` takes (a box drawn round them in a view). */
const pts = (cage: Cage, pick: (p: Vec3) => boolean) => cage.verts.map((vertex, i) => (pick(vertex) ? i : -1)).filter(i => i >= 0);
/** Move / turn / scale those points by typed values, as the card does. */
function xform(cage: Cage, ids: number[], mode: 'move' | 'turn' | 'scale', values: [number, number, number, number?]): Cage {
  const moved = moveTurnScale(ids.map(i => cage.verts[i]), mode, [values[0], values[1], values[2], values[3] ?? 1]);
  const verts = cage.verts.map(vertex => [...vertex] as Vec3);
  ids.forEach((i, idIndex) => (verts[i] = moved[idIndex]));

  return { verts, faces: cage.faces };
}
const at = (x: number) => (point: Vec3) => Math.abs(point[0] - x) < 1e-6;
const all = (cage: Cage) => cage.verts.map((_, i) => i);
/** Faces whose points all pass `pick`. */
const facesWhere = (cage: Cage, pick: (p: Vec3) => boolean) => cage.faces.map((face, i) => (face.every(vertex => pick(cage.verts[vertex])) ? i : -1)).filter(i => i >= 0);

// ------------------------------------------------------------------ the sole
// A box 270 long (heel at -x, toe at +x), 104 wide, 26 thick, 4 faces a side:
// slices of points at x -135, -67.5, 0, 67.5, 135.
let sole = boxCage([270, 104, 26], 4);
sole = xform(sole, pts(sole, at(-135)), 'scale', [1, 0.7, 1.3]); // heel: narrower, higher
sole = xform(sole, pts(sole, at(-67.5)), 'scale', [1, 0.8, 1.2]); // the waist under the arch
sole = xform(sole, pts(sole, at(135)), 'scale', [1, 0.52, 0.8]); // toe: narrow, thinner
sole = xform(sole, pts(sole, at(135)), 'move', [0, 5, 22]); // the toe spring (and towards the big toe)
sole = xform(sole, pts(sole, at(67.5)), 'move', [0, 2, 2]);

// ----------------------------------------------------------------- the upper
// A box 244 x 90 x 76, 2 faces a side (round in section), an edge loop added
// across each half (slices of points at x -122, -61, 0, 61, 122); its bottom
// taken off (it stands in the sole) and the top behind the instep (the collar).
let upper = boxCage([244, 90, 76], 2);
const vAt = (cage: Cage, point: Vec3) => cage.verts.findIndex(q => Math.hypot(q[0] - point[0], q[1] - point[1], q[2] - point[2]) < 1e-6);
upper = insertEdgeLoop(upper, vAt(upper, [-122, -45, 76]), vAt(upper, [0, -45, 76]))!;
upper = insertEdgeLoop(upper, vAt(upper, [0, -45, 76]), vAt(upper, [122, -45, 76]))!;
upper = deleteFaces(upper, [...facesWhere(upper, point => point[2] < 1e-6), ...facesWhere(upper, point => point[0] < 1e-6 && point[2] > 75)]);
upper = xform(upper, pts(upper, at(122)), 'scale', [1, 0.56, 0.45]); // toe box
upper = xform(upper, pts(upper, at(61)), 'scale', [1, 0.97, 0.78]); // the vamp falling to it
upper = xform(upper, pts(upper, at(-122)), 'scale', [1, 0.72, 1]); // the heel, rounder
upper = xform(upper, pts(upper, point => point[0] > -1 && point[0] < 1 && point[2] > 75), 'scale', [1, 0.8, 1]); // the instep, narrower on top
upper = xform(upper, pts(upper, point => Math.abs(point[0] + 61) < 1e-6 && point[2] > 75), 'move', [0, 0, -16]); // the collar dips below the ankle
upper = xform(upper, pts(upper, at(122)), 'move', [0, 5, 21]); // follows the toe spring
upper = xform(upper, pts(upper, at(61)), 'move', [0, 2, 2]);
upper = xform(upper, pts(upper, point => point[0] < -60), 'move', [0, 0, 6.5]); // the heel stands higher
upper = xform(upper, pts(upper, point => point[0] < -121 && Math.abs(point[2] - 44.5) < 1e-6), 'move', [-6, 0, 0]); // the heel counter rounds out at the back
upper = xform(upper, all(upper), 'move', [0, 0, 14]); // down in the sole

// ----------------------------------------------------------------- the tongue
// A surface 70 x 50, 2 faces each way, over the front of the opening; its back
// edge lifted, its sides curved down over the foot, 3 thick (down).
let tongue = planeCage([60, 60], 2, [-30, 0, 88]);
tongue = xform(tongue, pts(tongue, at(-60)), 'move', [0, 0, 12]);
tongue = xform(tongue, pts(tongue, point => Math.abs(Math.abs(point[1]) - 30) < 1e-6), 'move', [0, 0, -10]);

// ------------------------------------------------------------------ the laces
// A cylinder 5 across, 84 long, laid across the opening (turned 90° about X),
// its middle raised over the tongue; then two more along X, 16 apart.
let lace = shapeCage('cylinder', [5, 5, 84], 2);
lace = xform(lace, all(lace), 'turn', [90, 0, 0]);
lace = xform(lace, all(lace), 'move', [-46, 0, 46]); // (its middle at 88)
lace = xform(lace, pts(lace, point => Math.abs(point[1]) < 1e-6), 'move', [0, 0, 5]);

const freeform = (id: string, cage: Cage, extra: Record<string, unknown> = {}): Feature => ({ id, name: id, type: 'freeform', cage, ...extra }) as Feature;
// The tread: grooves 3 wide across the bottom, 20 apart, cut 3 up into it
// from the floor (shallower where the bottom curves up to the toe, none under it).
const tread = sketch('Tread', XY(), [...Array(12)].map((_, index) => rect(`g${index}`, -118 + 20 * index, -60, -115 + 20 * index, 60)));
const steps: Feature[] = [
  freeform('Sole', sole),
  freeform('Upper', upper, { thickness: 2.5, thickSide: 'down' }),
  freeform('Tongue', tongue, { thickness: 3, thickSide: 'down' }),
  freeform('Lace', lace),
  { id: 'Laces', name: 'Laces', type: 'transform', bodies: ['Lace'], copy: true, op: { kind: 'linear', dir: [1, 0, 0], spacing: 16, count: 3 } } as Feature,
  { id: 'Seat', name: 'Seat', type: 'boolean', op: 'subtract', target: 'Upper', tools: ['Sole'], keepTools: true } as Feature,
  tread,
  extrude('Grooves', tread, 3, 'cut')
];

for (const [name, cage] of [['sole', sole], ['upper', upper], ['tongue', tongue], ['lace', lace]] as [string, Cage][]) {
  check(`${name}: cage wound right, doesn't pass through itself`, windingAgrees(cage) && !selfCrossings(cage).length);
}
check('sole and lace closed, upper and tongue open', isClosed(sole) && isClosed(lace) && !isClosed(upper) && !isClosed(tongue));

const { errors } = await after(steps);
check('no errors', errors.length === 0, errors);
const shapes = bodies();
for (const [id, shape] of shapes) {
  const bodyHealth = health(shape as Shape3D, id);
  check(`${id}: sound`, bodyHealth.healthy, bodyHealth.healthy ? `${Math.round(bodyHealth.volume)} mm³` : bodyHealth);
}
const codeVols = [...shapes.values()].map(shape => Math.abs(measureVolume(shape as Shape3D)));
check('the upper is cut back where it sits in the sole (the sole kept)', shapes.has('Sole') && shapes.has('Upper') && (shapes.get('Upper') as Shape3D).boundingBox.bounds[0][2] > 25);

// ------------------------------------------------------ the shoe built by hand
// On a phone-sized screen (tests/fixtures/shoe-hand.json): each slice of points
// picked with a finger's box in a side view (Pick in a box), moved or scaled
// by typed values; faces tapped and deleted; the surface's centre typed. Each
// part comes out the same as above.
{
  const hand = JSON.parse(readFileSync(new URL('./fixtures/shoe-hand.json', import.meta.url), 'utf8')).features as Feature[];
  const { errors } = await after(hand);
  check('by hand: no errors', errors.length === 0, errors);
  const volumes = [...bodies().values()].map(body => Math.abs(measureVolume(body as Shape3D)));
  const parts = ['sole', 'upper', 'tongue', 'lace', 'lace 2', 'lace 3'];
  check('by hand: the same parts', volumes.length === codeVols.length, `${volumes.length} / ${codeVols.length}`);
  parts.forEach((name, i) => check(`by hand: the ${name} the same (to 0.1 %)`, Math.abs(volumes[i] - codeVols[i]) < codeVols[i] * 1e-3, `${volumes[i]?.toFixed(1)} / ${codeVols[i]?.toFixed(1)}`));
  const free = hand.filter(feature => feature.type === 'freeform').map(freeform => freeform.cage);
  check('by hand: the same cages, point for point', free.length === 4 && [sole, upper, tongue, lace].every((cage, i) => JSON.stringify(cage.verts.map(vertex => vertex.map(x => +x.toFixed(6)))) === JSON.stringify(free[i].verts.map((vertex: Vec3) => vertex.map(x => +x.toFixed(6))))));
}

// ---------------------------------------------------- names of the new steps
// A box after two surfaces is "Freeform 02" (the surfaces' names were counted:
// the lace by hand came out "Freeform 04").
{
  (globalThis as any).window ??= globalThis;
  const { DocStore } = await import('../src/doc/store');
  const st = new DocStore();
  const add = (label: string) => st.add({ ...st.newIdentity('freeform', label), type: 'freeform', cage: { verts: [], faces: [] } } as Feature);
  for (const label of ['Freeform', 'Freeform surface', 'Freeform surface']) {
    add(label);
  }
  check('names: a second box is Freeform 02 after two surfaces', st.newIdentity('freeform', 'Freeform').name === 'Freeform 02', st.newIdentity('freeform', 'Freeform').name);
  check('names: the third surface is Freeform surface 03', st.newIdentity('freeform', 'Freeform surface').name === 'Freeform surface 03');
}

if (process.argv[2]) {
  writeFileSync(process.argv[2], JSON.stringify({ format: 'super', version: 2, name: 'Shoe', features: steps }));
}
done();
