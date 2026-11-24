// Run: npx tsx tests/fillmouse.test.ts [out.json] - a computer mouse, with the
// tools the other build tests leave out: its top a surface stretched over its
// outline and two arches drawn over it (Fill), filled down to the desk (Fill
// to Plane); a thumb rest pressed into its left side (Freeform Face); a slot
// cut for the wheel and the wheel in it. Each held to its size and soundness.
import { readFileSync, writeFileSync } from 'node:fs';
import { makeBox, measureArea, measureVolume as rVol, type Shape3D } from 'replicad';
import { measureVolume } from '../src/kernel/ocFree';
import { faceCage } from '../src/freeform/faceGrid';
import { boundaryEdges } from '../src/freeform/cage';
import { arrangement, regionRef } from '../src/sketch/regions';
import { after, bodies, check, circle, done, health, line, near, rect, sketch, XY, XZ, YZ } from './kit';
import type { Feature, PathRef, SketchEntity, Vec3 } from '../src/doc/types';

const W = 30, Y0 = -40, Y1 = 40, H = 18;
const vol = (s: Shape3D) => Math.abs(measureVolume(s));

// ---------------------------------------------------------------- the outline
// Drawn on a plane 18 up: straight sides 80 long, 60 apart; a round front
// (a half circle, out to y 70) and back (radius 34, to y -58).
const outlineEs: SketchEntity[] = [
  line('left', [-W, Y0], [-W, Y1]),
  { id: 'front', kind: 'arc', a: [-W, Y1], m: [0, 70], b: [W, Y1] } as SketchEntity,
  line('right', [W, Y1], [W, Y0]),
  { id: 'back', kind: 'arc', a: [W, Y0], m: [0, -58], b: [-W, Y0] } as SketchEntity
];
// Two arches over it, meeting at the top (0, 0, 40): one along it from the
// back to the front, one across it from side to side.
const alongEs: SketchEntity[] = [{ id: 'a', kind: 'spline', points: [[-58, H], [-40, 34], [0, 40], [40, 33], [70, H]], closed: false, mode: 'fit' } as SketchEntity];
const acrossEs: SketchEntity[] = [{ id: 'c', kind: 'spline', points: [[-W, H], [-18, 33], [0, 40], [18, 33], [W, H]], closed: false, mode: 'fit' } as SketchEntity];
const path = (sketch: string, entities: string[]): PathRef => ({ kind: 'sketch', sketch, entities }) as PathRef;

const steps: Feature[] = [
  sketch('Outline', XY(H), outlineEs),
  sketch('Along', YZ(), alongEs),
  sketch('Across', XZ(), acrossEs),
  { id: 'Shell', name: 'Fill', type: 'fill', boundary: [path('Outline', ['left', 'front', 'right', 'back'])], guides: [path('Along', ['a']), path('Across', ['c'])] } as Feature
];
let { errors } = await after(steps);
check('the top: no errors', !errors.length, errors);
const top = bodies().get('Shell') as Shape3D;
const [[tx0, ty0, tz0], [tx1, ty1, tz1]] = top.boundingBox.bounds;
check('the top: over the outline, up to the arches (40)', near(tx0, -W, 0.05) && near(tx1, W, 0.05) && near(ty0, -58, 0.1) && near(ty1, 70, 0.1) && near(tz0, H, 0.05) && near(tz1, 40, 0.3), top.boundingBox.bounds);
check('the top: one surface', top.faces.length === 1, top.faces.length);
const topArea = measureArea(top.faces[0]);

// Filled down to the desk: a solid with straight sides.
steps.push({ id: 'Floor', name: 'Fill to Plane', type: 'fillToPlane', body: 'Shell', plane: XY() } as Feature);
({ errors } = await after(steps));
check('filled down: no errors', !errors.length, errors);
let mouse = bodies().get('Shell') as Shape3D;
const vSolid = vol(mouse);
// (Under the outline, 18 of straight sides; above it, the dome.)
const plan = 2 * W * (Y1 - Y0) + (() => {
  // The two round ends: segments of their circles.
  const seg = (sag: number) => {
    const r = (W * W + sag * sag) / (2 * sag);
    const th = 2 * Math.asin(W / r);

    return (r * r * (th - Math.sin(th))) / 2;
  };

  return seg(70 - Y1) + seg(58 + Y0);
})();
const walls = plan * H;
check('filled down: the walls under the dome, the dome over them', vSolid > walls + 0.4 * plan * 22 * 0.5 && vSolid < walls + plan * 22, [vSolid, walls, plan]);
check('filled down: on the desk, as long and wide as the outline', near(mouse.boundingBox.bounds[0][2], 0, 1e-3) && near(mouse.boundingBox.bounds[1][2], tz1, 1e-3), mouse.boundingBox.bounds);

// ----------------------------------------------------------- the thumb rest
// The left side (flat, 80 x 18) laid with a grid, its inside points pushed in
// 4 at the middle, 2 towards the ends.
const leftFace = mouse.faces.find(f => f.geomType === 'PLANE' && f.normalAt().x < -0.99)!;
check('the left side: a flat face 80 x 18', !!leftFace && near(measureArea(leftFace), (Y1 - Y0) * H, 0.5), leftFace && measureArea(leftFace));
const lr = await after(steps);
const info = (lr.r as any).bodies.find((b: any) => b.id === 'Shell');
const fi = info.faces.findIndex((f: any) => f.normal[0] < -0.999);
const fInfo = info.faces[fi];
const g = info.faceGroups.find((x: any) => x.face === fi);
const P = (k: number): Vec3 => [info.positions[3 * k], info.positions[3 * k + 1], info.positions[3 * k + 2]];
const tris: [Vec3, Vec3, Vec3][] = [];
for (let t = g.start; t < g.start + g.count; t += 3) {
  tris.push([P(info.indices[t]), P(info.indices[t + 1]), P(info.indices[t + 2])]);
}
const cage = faceCage(tris, fInfo.center, fInfo.normal, 5)!;
const border = new Set(boundaryEdges(cage).flat());
// (Relative to the face's middle: u along it, the other way up it.)
const pushed = cage.verts.map((v, i): Vec3 => (border.has(i) ? v : [v[0] + (Math.abs(v[1]) < 10 ? 4 : 2), v[1], v[2]]));
const inside = cage.verts.filter((_, i) => !border.has(i)).length;
check('the thumb rest: a 5-across grid, its inside points to move', inside >= 4, `${inside} inside of ${cage.verts.length}`);
const leftRef = { body: 'Shell', center: fInfo.center, normal: fInfo.normal, area: fInfo.area };
steps.push({ id: 'Thumb', name: 'Freeform Face', type: 'faceFreeform', face: leftRef, cage: { verts: pushed, faces: cage.faces }, grid: 5 } as Feature);
({ errors } = await after(steps));
check('the thumb rest: no errors', !errors.length, errors);
mouse = bodies().get('Shell') as Shape3D;
const vThumb = vol(mouse);
check('the thumb rest: pressed in (smaller), its edges where they were', vThumb < vSolid - 100 && near(mouse.boundingBox.bounds[0][0], -W, 1e-3), [vThumb, vSolid, mouse.boundingBox.bounds[0][0]]);
{
  // Deepest at the middle: a cut across it, at half height, comes in from x -30.
  const mid = mouse.intersect(makeBox([-40, -2, H / 2 - 1], [0, 2, H / 2 + 1]));
  const x = mid.boundingBox.bounds[0][0];
  check('the thumb rest: about 3 deep at its middle (the surface lies inside its grid)', x > -W + 1.5 && x < -W + 4.2, x);
}

// ----------------------------------------------------- the wheel and its slot
// A slot 10 wide, 22 long, cut 18 down from 46 (to 28: some 6 to 10 deep).
const slotEs = [rect('s', -5, 22, 5, 44)];
steps.push(sketch('Slot', XY(46), slotEs), { id: 'SlotCut', name: 'Extrude', type: 'extrude', source: { kind: 'profile', sketch: 'Slot', regions: arrangement(slotEs).regions.map(regionRef) }, distance: -18, mode: 'cut', target: 'Shell' } as Feature);
({ errors } = await after(steps));
check('the slot: no errors', !errors.length, errors);
mouse = bodies().get('Shell') as Shape3D;
const vSlot = vol(mouse);
const slotGone = vThumb - vSlot;
check('the slot: cut into the top (some 10 x 22 x 6 to 10)', slotGone > 10 * 22 * 5 && slotGone < 10 * 22 * 10, slotGone);
const floorZ = Math.min(...mouse.faces.filter(f => f.geomType === 'PLANE' && f.normalAt().z > 0.99).map(f => f.center.z));
check('the slot: its floor at 28', near(floorZ, 28, 1e-3), floorZ);
// The wheel: a circle 7 round on the middle plane, 3.5 each side of it, a body of its own.
const wheelEs = [circle('w', 33, 36, 7)];
steps.push(sketch('Wheel', YZ(), wheelEs), { id: 'Wheel', name: 'Wheel', type: 'extrude', source: { kind: 'profile', sketch: 'Wheel', regions: arrangement(wheelEs).regions.map(regionRef) }, distance: 3.5, symmetric: true, mode: 'new' } as Feature);
({ errors } = await after(steps));
check('the wheel: no errors', !errors.length, errors);
const wheel = bodies().get('Wheel') as Shape3D;
check('the wheel: 7 round, 7 wide', !!wheel && near(vol(wheel), Math.PI * 49 * 7, 1e-2), wheel && vol(wheel));
check('the wheel: in the slot, clear of its sides, standing out of the top', !!wheel && near(wheel.boundingBox.bounds[0][0], -3.5, 1e-3) && wheel.boundingBox.bounds[1][2] > 40, wheel?.boundingBox.bounds);
check('the wheel: clear of the mouse', !!wheel && Math.abs(rVol(wheel.intersect(mouse))) < 1e-6);

// The slot's rim rounded 1.5, where its walls meet the domed top (four edges, curved).
const rim = mouse.edges.filter((e) => {
  const [x, y, z] = e.pointAt(0.5).toTuple();

  // (Not the slot's upright corners.)
  return z > 30 && (([a, b, c]) => Math.abs(c) < 0.9 * Math.hypot(a, b, c))(e.tangentAt(0.5).toTuple()) && Math.abs(x) < 5 + 1e-3 && y > 22 - 1e-3 && y < 44 + 1e-3;
});
check("the slot's rim: four edges", rim.length === 4, rim.length);
steps.push({ id: 'Rim', name: 'Fillet', type: 'fillet', edges: rim.map(e => ({ body: 'Shell', mid: e.pointAt(0.5).toTuple() as Vec3, dir: e.tangentAt(0.5).toTuple() as Vec3, length: e.length })), radius: 1.5 } as Feature);
({ errors } = await after(steps));
check("the slot's rim: rounded, no errors", !errors.length, errors);
mouse = bodies().get('Shell') as Shape3D;
const vRim = vol(mouse);
// (A round 1.5 takes off (1 - π/4) 1.5² along each edge: some 70 round the rim.)
check("the slot's rim: a little taken off (a round 1.5 along some 70)", vSlot - vRim > 0.5 * 0.483 * 70 && vSlot - vRim < 2 * 0.483 * 70, vSlot - vRim);
check('the wheel: still clear of the mouse', Math.abs(rVol(wheel.intersect(mouse))) < 1e-6);

for (const [id, s] of bodies()) {
  const h = health(s as Shape3D, id);
  check(`${id}: sound`, h.healthy, h.healthy ? `${Math.round(h.volume)} mm³` : h);
}
const codeVols = [...bodies().values()].map(s => vol(s as Shape3D));

// ------------------------------------------------------ the mouse built by hand
// On a phone-sized screen (tests/fixtures/fillmouse-hand.json): the outline
// drawn on a plane 18 up with lines and arcs typed (80 long at 90°; radius 30
// and 34), the arches' points typed, the outline and arches tapped for Fill,
// Fill to Plane onto XY, the thumb rest's four points picked and moved 4 and
// 2 by typed values, the slot and the wheel typed, the rim's edges tapped. It
// comes out the same.
{
  const hand = JSON.parse(readFileSync(new URL('./fixtures/fillmouse-hand.json', import.meta.url), 'utf8')).features as Feature[];
  const { errors } = await after(hand);
  check('by hand: no errors', errors.length === 0, errors);
  const H = [...bodies().values()].map(s => vol(s as Shape3D));
  check('by hand: the same parts', H.length === codeVols.length, `${H.length} / ${codeVols.length}`);
  ['mouse', 'wheel'].forEach((name, i) => check(`by hand: the ${name} the same (to 0.1 %)`, Math.abs(H[i] - codeVols[i]) < codeVols[i] * 1e-3, `${H[i]?.toFixed(1)} / ${codeVols[i]?.toFixed(1)}`));
  const ff = hand.find(f => f.type === 'faceFreeform') as any;
  const key = (vs: Vec3[]) => JSON.stringify(vs.map(v => v.map(x => +x.toFixed(6))).sort());
  check("by hand: the thumb rest's grid the same, point for point", !!ff && ff.grid === 5 && key(ff.cage.verts) === key(pushed), ff && ff.cage.verts.filter((v: Vec3) => Math.abs(v[0]) > 1e-6));
}
console.log('top', topArea.toFixed(1), 'solid', vSolid.toFixed(1), 'thumb', vThumb.toFixed(1), 'slot', vSlot.toFixed(1), 'rim', vRim.toFixed(1));

if (process.argv[2]) {
  writeFileSync(process.argv[2], JSON.stringify({ format: 'super', version: 2, name: 'Mouse', features: steps }));
}
done();
