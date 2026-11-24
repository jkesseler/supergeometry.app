// Run: npx tsx tests/faceffmulti.test.ts
// Freeform Face over two faces side by side (a box's top and one side): one
// cage laid over both and put down onto them, one smooth surface in their
// place - no edge left where they met - the rest of the box untouched.
import opencascade from 'replicad-opencascadejs';
import { setOC, type Shape3D } from 'replicad';
import { debugBodies, regenerate, shapeValid } from '../src/kernel/engine';
import { arrangement, regionRef } from '../src/sketch/regions';
import { faceCage, facesNormal, liftOnto, onCorners } from '../src/freeform/faceGrid';
import { boundaryEdges } from '../src/freeform/cage';
import type { Feature, PlaneDef, Vec3 } from '../src/doc/types';

setOC(await (opencascade as unknown as () => Promise<any>)());
let failed = 0;
const check = (name: string, ok: boolean, info = '') => {
  if (!ok) {
    failed++;
  }
  console.log(ok ? 'ok  ' : 'FAIL', name, info);
};
const XY: PlaneDef = { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, 0, 1] };
const es = [{ id: 'r', kind: 'rect', center: [0, 0], w: 40, h: 30, rotation: 0 }];
const box: Feature[] = [
  { id: 'sA', name: 'sA', type: 'sketch', plane: XY, entities: es } as Feature,
  { id: 'A', name: 'A', type: 'extrude', source: { kind: 'profile', sketch: 'sA', regions: arrangement(es as any).regions.map(regionRef) }, distance: 20, mode: 'new' } as Feature
];
let result: any = await regenerate(box);
const b = result.bodies.find((body: any) => body.id === 'A');
const pick = (normal: Vec3) => b.faces.findIndex((face: any) => face.normal[0] * normal[0] + face.normal[1] * normal[1] + face.normal[2] * normal[2] > 0.999);
const tri = (i: number) => {
  const faceGroup = b.faceGroups.find((faceGroup: any) => faceGroup.face === i);
  const vertexAt = (index: number): Vec3 => [b.positions[3 * index], b.positions[3 * index + 1], b.positions[3 * index + 2]];
  const out: [Vec3, Vec3, Vec3][] = [];
  for (let t = faceGroup.start; t < faceGroup.start + faceGroup.count; t += 3) {
    out.push([vertexAt(b.indices[t]), vertexAt(b.indices[t + 1]), vertexAt(b.indices[t + 2])]);
  }

  return out;
};
const [ia, ib] = [pick([0, 0, 1]), pick([1, 0, 0])];
const [fa, fb] = [b.faces[ia], b.faces[ib]];
const ref = (face: any) => ({ body: 'A', center: face.center, normal: face.normal, area: face.area });
const tris = [...tri(ia), ...tri(ib)];
const joinedNormal = facesNormal([fa.normal, fb.normal]);
const flat = faceCage(tris, fa.center, joinedNormal, 5);
check('one grid laid over the top and the side together', !!flat);
const cage = onCorners(liftOnto(flat!, fa.center, joinedNormal, tris), fa.center, tris);
const at = (vertex: Vec3): Vec3 => [vertex[0] + fa.center[0], vertex[1] + fa.center[1], vertex[2] + fa.center[2]];
const onBox = cage.verts.map(at).every(point => Math.abs(point[2] - 20) < 1e-6 || Math.abs(point[0] - 20) < 1e-6);
check('put down onto the faces: every point on the top or the side', onBox);
const border = new Set(boundaryEdges(cage).flat());
const corners: Vec3[] = [[20, -15, 20], [20, 15, 20]];
check('a border point right on each corner where the outline turns down', corners.every(corner => [...border].some(i => Math.hypot(...(at(cage.verts[i]).map((x, index) => x - corner[index]) as Vec3)) < 1e-6)));
const step = (verts: Vec3[]): Feature => ({ id: 'ff', name: 'ff', type: 'faceFreeform', face: ref(fa), more: [ref(fb)], cage: { faces: cage.faces, verts } }) as Feature;
for (const [name, verts] of [
  ['as laid', cage.verts],
  ['the middle pulled out 4', cage.verts.map((vertex, i) => (border.has(i) ? vertex : ([vertex[0] + 2.8, vertex[1], vertex[2] + 2.8] as Vec3)))]
] as [string, Vec3[]][]) {
  result = await regenerate([...box, step(verts)]);
  const shape = debugBodies().get('A') as Shape3D;
  const bodyA = result.bodies.find((body: any) => body.id === 'A');
  const planes = bodyA.faces.filter((face: any) => face.type === 'PLANE').length;
  // The edge the top and the side met along (x = 20, z = 20) is gone.
  const crease = bodyA.edges.some((e: any) => Math.abs(e.mid[0] - 20) < 1e-3 && Math.abs(e.mid[2] - 20) < 1e-3);
  check(`${name}: built, a valid closed solid`, !result.errors.length && !!shape && shapeValid(shape) && !bodyA.openEdges?.length, result.errors.map((e: any) => e.message).join(' | '));
  check(`${name}: the other four faces flat as they were, no edge where the two met`, planes === 4 && !crease, `${planes} flat faces, crease ${crease}`);
}
console.log(failed ? `${failed} FAILED` : 'all ok');
process.exit(failed ? 1 : 0);
