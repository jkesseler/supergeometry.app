// Run: npx tsx tests/faceff.test.ts
// Freeform Face: a flat face of a body made a smooth surface by a cage laid
// over it, its edges kept - raised, pushed in, on a round face, on an
// L-shaped face, after fillets, followed when an earlier step moves the face,
// joined to another body after, and refused on a face with a hole.
import opencascade from 'replicad-opencascadejs';
import { getOC, measureVolume, setOC, type Shape3D } from 'replicad';
import { debugBodies, regenerate, shapeValid } from '../src/kernel/engine';
import { arrangement, regionRef } from '../src/sketch/regions';
import { faceCage } from '../src/freeform/faceGrid';
import { boundaryEdges, type Cage } from '../src/freeform/cage';
import type { Feature, PlaneDef, Vec3 } from '../src/doc/types';

setOC(await (opencascade as unknown as () => Promise<any>)());
const oc = getOC();
let failed = 0;
const check = (name: string, ok: boolean, info = '') => {
  if (!ok) {
    failed++;
  }
  console.log(ok ? 'ok  ' : 'FAIL', name, info);
};
const solids = (shape: Shape3D) => {
  const ex = new oc.TopExp_Explorer(shape.wrapped, oc.TopAbs_ShapeEnum.TopAbs_SOLID, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
  let count = 0;
  for (; ex.More(); ex.Next()) {
    count++;
  }
  ex.delete();

  return count;
};
const vol = (id: string) => Math.abs(measureVolume(debugBodies().get(id) as Shape3D));
const XY: PlaneDef = { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, 0, 1] };
const body = (id: string, es: any[], height: number, plane = XY): Feature[] => [
  { id: `s${id}`, name: `s${id}`, type: 'sketch', plane, entities: es } as Feature,
  { id, name: id, type: 'extrude', source: { kind: 'profile', sketch: `s${id}`, regions: arrangement(es as any).regions.map(regionRef) }, distance: height, mode: 'new' } as Feature
];
const rect = (cx: number, cy: number, width: number, height: number, id = 'r') => ({ id, kind: 'rect', center: [cx, cy], w: width, h: height, rotation: 0 });

async function build(fs: Feature[]) {
  const result: any = await regenerate(fs);
  const errors = result.errors.map((e: any) => `${e.featureId}: ${e.message}`).join(' | ');
  const bad: string[] = [];
  for (const [id, debugBody] of debugBodies()) {
    if (!shapeValid(debugBody as Shape3D)) {
      bad.push(`${id} invalid`);
    }
    if (solids(debugBody as Shape3D) !== 1) {
      bad.push(`${id}: ${solids(debugBody as Shape3D)} solids`);
    }
    const info = result.bodies.find((b: any) => b.id === id);
    if (info?.openEdges?.length) {
      bad.push(`${id}: ${info.openEdges.length} open edges`);
    }
  }

  return { r: result, errors, bad: bad.join(', ') };
}

/** The (first) face of a body facing `normal`: its ref and cage. */
function faceOf(result: any, id: string, normal: Vec3, divisions = 5) {
  const b = result.bodies.find((body: any) => body.id === id);
  const i = b.faces.findIndex((face: any) => face.normal[0] * normal[0] + face.normal[1] * normal[1] + face.normal[2] * normal[2] > 0.999);
  const candidate = b.faces[i];
  const faceGroup = b.faceGroups.find((faceGroup: any) => faceGroup.face === i);
  const vertexAt = (index: number): Vec3 => [b.positions[3 * index], b.positions[3 * index + 1], b.positions[3 * index + 2]];
  const tris: [Vec3, Vec3, Vec3][] = [];
  for (let t = faceGroup.start; t < faceGroup.start + faceGroup.count; t += 3) {
    tris.push([vertexAt(b.indices[t]), vertexAt(b.indices[t + 1]), vertexAt(b.indices[t + 2])]);
  }
  const ref = { body: id, center: candidate.center, normal: candidate.normal, area: candidate.area, ...(candidate.step ? { step: candidate.step } : {}) };
  const cage = faceCage(tris, candidate.center, candidate.normal, divisions)!;
  const border = new Set(boundaryEdges(cage).flat());

  // (`grid`: the inside points, which are the ones moved.)
  return { ref, cage, grid: cage.verts.filter((_, i) => !border.has(i)) };
}
/** The cage with each inside point moved by `move` (its border stays). */
const ff = (face: any, cage: Cage, move: (at: Vec3, i: number) => Vec3, id = 'ff'): Feature => {
  const border = new Set(boundaryEdges(cage).flat());
  let index = 0;
  const verts = cage.verts.map((vertex, i) => (border.has(i) ? vertex : (([a, b, offsetZ]) => [vertex[0] + a, vertex[1] + b, vertex[2] + offsetZ] as Vec3)(move(vertex, index++))));

  return { id, name: id, type: 'faceFreeform', face, cage: { faces: cage.faces, verts } } as Feature;
};
const up = (lift: number) => (at: Vec3): Vec3 => [0, 0, lift * Math.max(0, 1 - Math.hypot(at[0], at[1]) / 18)];

// A 40 x 30 x 20 box, its top raised in the middle like a pillow.
const box = body('A', [rect(0, 0, 40, 30)], 20);
let built = await build(box);
const { ref, cage, grid } = faceOf(built.r, 'A', [0, 0, 1]);
const bx = cage.verts.filter(vertex => !grid.includes(vertex));
check('a 5-across cage on a 40 x 30 top: its border round the edge, points inside', cage.faces.length >= 12 && grid.length >= 6 && bx.every(point => Math.abs(Math.abs(point[0]) - 20) < 1e-6 || Math.abs(Math.abs(point[1]) - 15) < 1e-6) && grid.every(point => Math.abs(point[0]) < 19 && Math.abs(point[1]) < 14), `${cage.faces.length} faces, ${grid.length} inside`);
built = await build([...box, ff(ref, cage, up(6))]);
const vUp = vol('A');
const top = (debugBodies().get('A') as Shape3D).boundingBox.bounds[1][2];
// (The smooth surface lies inside its cage: a little lower than the raised points.)
check('top raised: a valid closed body, bigger, nearly as high as the raised points', !built.errors && !built.bad && vUp > 24000 + 500 && top > 23 && top < 27.5, `${built.errors}${built.bad} ${vUp.toFixed(0)} top ${top.toFixed(2)}`);
const bb = (debugBodies().get('A') as Shape3D).boundingBox.bounds;
check('...its edges stay put (the sides are as they were)', Math.abs(bb[0][0] + 20) < 1e-3 && Math.abs(bb[1][0] - 20) < 1e-3 && Math.abs(bb[1][1] - 15) < 1e-3, JSON.stringify(bb));
built = await build([...box, ff(ref, cage, up(-6))]);
check('top pushed in: smaller', !built.errors && !built.bad && vol('A') < 24000 - 500, `${built.errors}${built.bad} ${vol('A').toFixed(0)}`);
built = await build([...box, ff(ref, cage, () => [0, 0, 0])]);
check('nothing moved: the body as it was', !built.errors && !built.bad && Math.abs(vol('A') - 24000) < 1e-6, `${built.errors}${built.bad}`);
built = await build([...box, ff(ref, cage, (_, i) => [0, 0, i % 2 ? 3 : -3])]);
check('points up and down in turn: a wavy top', !built.errors && !built.bad, `${built.errors}${built.bad}`);
built = await build([...box, ff(ref, cage, at => [at[0] * 0.1, 0, 4])]);
check('points moved sideways as well as up', !built.errors && !built.bad, `${built.errors}${built.bad}`);

// The face follows: the box made taller after.
{
  const taller = body('A', [rect(0, 0, 40, 30)], 30);
  built = await build([...taller, ff(ref, cage, up(6))]);
  const t = (debugBodies().get('A') as Shape3D).boundingBox.bounds[1][2];
  check('box made 30 tall after: the raised top goes with it', !built.errors && !built.bad && t > 33 && t < 37.5, `${built.errors}${built.bad} top ${t.toFixed(2)}`);
}

// A side face, a round top, an L-shaped top.
{
  const side = faceOf((await build(box)).r, 'A', [1, 0, 0]);
  built = await build([...box, ff(side.ref, side.cage, () => [5, 0, 0])]);
  check('a side face pushed out', !built.errors && !built.bad && vol('A') > 24000, `${built.errors}${built.bad}`);
  const cyl = body('C', [{ id: 'c', kind: 'circle', center: [0, 0], radius: 15 }], 10);
  const face = faceOf((await build(cyl)).r, 'C', [0, 0, 1]);
  built = await build([...cyl, ff(face.ref, face.cage, up(8))]);
  check("a cylinder's round top made a dome", !built.errors && !built.bad && vol('C') > Math.PI * 225 * 10, `${built.errors}${built.bad} ${face.grid.length} points`);
  // Its cage's border on the circle (four sides of it, no corners to go by).
  const cb = face.cage.verts.filter(vertex => !face.grid.includes(vertex));
  check("...its cage's border lies on the round edge", cb.every(vertex => Math.abs(Math.hypot(vertex[0], vertex[1]) - 15) < 0.2), cb.map(vertex => Math.hypot(vertex[0], vertex[1]).toFixed(2)).join(' '));
  const features = body('L', [{ id: 'p', kind: 'polyline', points: [[0, 0], [40, 0], [40, 15], [15, 15], [15, 40], [0, 40]], closed: true }], 10);
  const lFace = faceOf((await build(features)).r, 'L', [0, 0, 1], 7);
  const outside = lFace.cage.verts.filter(vertex => vertex[0] + lFace.ref.center[0] > 15.5 && vertex[1] + lFace.ref.center[1] > 15.5);
  built = await build([...features, ff(lFace.ref, lFace.cage, () => [0, 0, 3])]);
  check('an L-shaped top: its cage only on the L, raised', outside.length === 0 && lFace.grid.length > 5 && !built.errors && !built.bad, `${built.errors}${built.bad} ${lFace.grid.length} points, ${outside.length} outside`);
}

// After fillets on the top's edges; and joined to / cut by another body after.
{
  const fil: Feature = { id: 'f', name: 'f', type: 'fillet', radius: 3, edges: [[0, 15], [0, -15]].map(([x, y]) => ({ body: 'A', mid: [x, y, 20], dir: [1, 0, 0], length: 40, steps: ['A'] })) } as Feature;
  const t = faceOf((await build([...box, fil])).r, 'A', [0, 0, 1]);
  built = await build([...box, fil, ff(t.ref, t.cage, up(5))]);
  check('top rounded along two edges first, then raised', !built.errors && !built.bad, `${built.errors}${built.bad}`);
  const other = body('B', [rect(30, 0, 30, 10, 'r2')], 10);
  built = await build([...box, ff(ref, cage, up(6)), ...other, { id: 'u', name: 'u', type: 'boolean', op: 'union', target: 'A', tools: ['B'] } as Feature]);
  check('the raised box joined to another box after', !built.errors && !built.bad && [...debugBodies().keys()].length === 1, `${built.errors}${built.bad}`);
  built = await build([...box, ff(ref, cage, up(6)), ...body('H', [{ id: 'c', kind: 'circle', center: [0, 0], radius: 5 }], 40, { origin: [0, 0, -5], xDir: [1, 0, 0], normal: [0, 0, 1] }), { id: 's', name: 's', type: 'boolean', op: 'subtract', target: 'A', tools: ['H'] } as Feature]);
  check('...a hole cut down through the raised top', !built.errors && !built.bad && vol('A') < vUp, `${built.errors}${built.bad}`);
}

// A face with a hole: refused, saying so. A point pushed through the bottom: refused, not broken.
{
  const res = [rect(0, 0, 40, 40), { id: 'c', kind: 'circle', center: [0, 0], radius: 6 }];
  const ring: Feature[] = [
    { id: 'sR', name: 'sR', type: 'sketch', plane: XY, entities: res } as Feature,
    { id: 'R', name: 'R', type: 'extrude', source: { kind: 'profile', sketch: 'sR', regions: arrangement(res as any).regions.filter((region: any) => region.area > 1000 || Math.abs(regionRef(region).a) > 1000).map(regionRef) }, distance: 10, mode: 'new' } as Feature
  ];
  const t = faceOf((await build(ring)).r, 'R', [0, 0, 1]);
  built = await build([...ring, ff(t.ref, t.cage, () => [0, 0, 3])]);
  check('a face with a hole in it: refused, saying so', /holes/.test(built.errors), built.errors);
  built = await build([...box, ff(ref, cage, (_, i) => (i === Math.floor(grid.length / 2) ? [0, 0, -120] : [0, 0, 0]))]);
  check('a point pushed right through the bottom: refused (not a broken body)', !!built.errors && !built.bad, `${built.errors}${built.bad}`);
}

// The finest preset (9 across), every inside point raised: still quick enough to drag.
{
  const nine = faceOf((await build(box)).r, 'A', [0, 0, 1], 9);
  const t0 = performance.now();
  built = await build([...box, ff(nine.ref, nine.cage, up(6))]);
  const ms = performance.now() - t0;
  check('a 9-across cage raised: fine, and built in under 2 s', !built.errors && !built.bad && ms < 2000, `${built.errors}${built.bad} ${ms.toFixed(0)} ms, ${nine.cage.faces.length} faces`);
}

// One point at a time, pulled well out: on outlines with inward corners (an
// L, a T, a U) the cage's smooth surface has points past the corner, outside
// the face - one point by the corner pulled 5 mm folded the face over.
{
  const outlines: Record<string, [number, number][]> = {
    L: [[0, 50], [40, 50], [40, 65], [15, 65], [15, 90], [0, 90]],
    T: [[0, 0], [40, 0], [40, 10], [25, 10], [25, 40], [15, 40], [15, 10], [0, 10]],
    U: [[0, 0], [40, 0], [40, 30], [30, 30], [30, 10], [10, 10], [10, 30], [0, 30]]
  };
  for (const [name, points] of Object.entries(outlines)) {
    const part = body('L', [{ id: 'p', kind: 'polyline', points, closed: true }], 10);
    const face = faceOf((await build(part)).r, 'L', [0, 0, 1], 5);
    const bad: number[] = [];
    for (let index = 0; index < face.grid.length; index++) {
      built = await build([...part, ff(face.ref, face.cage, (_, i) => [0, 0, i === index ? 5 : 0])]);
      if (built.errors || built.bad) {
        bad.push(index);
      }
    }
    check(`${name}-shaped top: each inside point pulled out 5 mm on its own`, face.grid.length > 3 && !bad.length, `${face.grid.length} points, failing: ${bad.join(',')}`);
  }
  // A triangle: three points of outline, the grid's fourth corner goes along an edge.
  const tri = body('T', [{ id: 'p', kind: 'polyline', points: [[0, 0], [40, 0], [10, 30]], closed: true }], 10);
  const base = await build(tri);
  const b = base.r.bodies.find((body: any) => body.id === 'T');
  const i = b.faces.findIndex((face: any) => face.normal[2] > 0.999);
  const faceGroup = b.faceGroups.find((faceGroup: any) => faceGroup.face === i);
  const vertexAt = (index: number): Vec3 => [b.positions[3 * index], b.positions[3 * index + 1], b.positions[3 * index + 2]];
  const tris: [Vec3, Vec3, Vec3][] = [];
  for (let t = faceGroup.start; t < faceGroup.start + faceGroup.count; t += 3) {
    tris.push([vertexAt(b.indices[t]), vertexAt(b.indices[t + 1]), vertexAt(b.indices[t + 2])]);
  }
  const cage = faceCage(tris, b.faces[i].center, b.faces[i].normal, 5);
  check('a triangular top takes a cage', !!cage && cage.verts.length > 8, `${cage?.verts.length ?? 0} points`);
  if (cage) {
    const t = faceOf(base.r, 'T', [0, 0, 1], 5);
    built = await build([...tri, ff(t.ref, t.cage, () => [0, 0, 3])]);
    check('...and is raised', !built.errors && !built.bad && vol('T') > 6000, `${built.errors}${built.bad} ${vol('T').toFixed(0)}`);
  }
}

// The shaped face is the cage's own smooth surface (a patch per cell of the
// cage, like a freeform body's), not one surface fitted through points: the
// same every time, and its border exactly on the face's edges.
{
  const patches = (id: string) => (debugBodies().get(id) as Shape3D).faces.filter(face => face.geomType === 'BSPLINE_SURFACE').length;
  built = await build([...box, ff(ref, cage, up(6))]);
  check('a raised box top: one patch for each cell of its cage', !built.errors && !built.bad && patches('A') === cage.faces.length, `${built.errors}${built.bad} ${patches('A')} patches, ${cage.faces.length} cells`);
  const round = body('C', [{ id: 'c', kind: 'circle', center: [0, 0], radius: 15 }], 10);
  const circleFace = faceOf((await build(round)).r, 'C', [0, 0, 1]);
  built = await build([...round, ff(circleFace.ref, circleFace.cage, up(6))]);
  const rim = (debugBodies().get('C') as Shape3D).edges.filter(e => Math.abs(e.pointAt(0.3).z - 10) < 1e-6 && Math.abs(Math.hypot(e.pointAt(0.3).x, e.pointAt(0.3).y) - 15) < 0.03).length;
  check('a round top: patches too, meeting the round wall at its rim', !built.errors && !built.bad && patches('C') === circleFace.cage.faces.length && rim > 0, `${built.errors}${built.bad} ${patches('C')} patches, ${circleFace.cage.faces.length} cells`);
  const features = body('L', [{ id: 'p', kind: 'polyline', points: [[0, 0], [40, 0], [40, 15], [15, 15], [15, 40], [0, 40]], closed: true }], 10);
  const lFace = faceOf((await build(features)).r, 'L', [0, 0, 1], 7);
  const corner = lFace.cage.verts.some(vertex => Math.abs(vertex[0] + lFace.ref.center[0] - 15) < 1e-6 && Math.abs(vertex[1] + lFace.ref.center[1] - 15) < 1e-6);
  built = await build([...features, ff(lFace.ref, lFace.cage, () => [0, 0, 3])]);
  check("an L's cage has a point on its inward corner; raised, the surface keeps to the L", corner && !built.errors && !built.bad && patches('L') === lFace.cage.faces.length, `${built.errors}${built.bad} corner ${corner}, ${patches('L')} patches`);
}

process.exit(failed ? 1 : 0);
