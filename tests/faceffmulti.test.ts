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
let r: any = await regenerate(box);
const b = r.bodies.find((x: any) => x.id === 'A');
const pick = (n: Vec3) => b.faces.findIndex((f: any) => f.normal[0] * n[0] + f.normal[1] * n[1] + f.normal[2] * n[2] > 0.999);
const tri = (i: number) => {
  const g = b.faceGroups.find((x: any) => x.face === i);
  const P = (k: number): Vec3 => [b.positions[3 * k], b.positions[3 * k + 1], b.positions[3 * k + 2]];
  const out: [Vec3, Vec3, Vec3][] = [];
  for (let t = g.start; t < g.start + g.count; t += 3) {
    out.push([P(b.indices[t]), P(b.indices[t + 1]), P(b.indices[t + 2])]);
  }

  return out;
};
const [ia, ib] = [pick([0, 0, 1]), pick([1, 0, 0])];
const [fa, fb] = [b.faces[ia], b.faces[ib]];
const ref = (f: any) => ({ body: 'A', center: f.center, normal: f.normal, area: f.area });
const tris = [...tri(ia), ...tri(ib)];
const n = facesNormal([fa.normal, fb.normal]);
const flat = faceCage(tris, fa.center, n, 5);
check('one grid laid over the top and the side together', !!flat);
const cage = onCorners(liftOnto(flat!, fa.center, n, tris), fa.center, tris);
const at = (v: Vec3): Vec3 => [v[0] + fa.center[0], v[1] + fa.center[1], v[2] + fa.center[2]];
const onBox = cage.verts.map(at).every(p => Math.abs(p[2] - 20) < 1e-6 || Math.abs(p[0] - 20) < 1e-6);
check('put down onto the faces: every point on the top or the side', onBox);
const border = new Set(boundaryEdges(cage).flat());
const corners: Vec3[] = [[20, -15, 20], [20, 15, 20]];
check('a border point right on each corner where the outline turns down', corners.every(c => [...border].some(i => Math.hypot(...(at(cage.verts[i]).map((x, k) => x - c[k]) as Vec3)) < 1e-6)));
const step = (verts: Vec3[]): Feature => ({ id: 'ff', name: 'ff', type: 'faceFreeform', face: ref(fa), more: [ref(fb)], cage: { faces: cage.faces, verts } }) as Feature;
for (const [name, verts] of [
  ['as laid', cage.verts],
  ['the middle pulled out 4', cage.verts.map((v, i) => (border.has(i) ? v : ([v[0] + 2.8, v[1], v[2] + 2.8] as Vec3)))]
] as [string, Vec3[]][]) {
  r = await regenerate([...box, step(verts)]);
  const s = debugBodies().get('A') as Shape3D;
  const A = r.bodies.find((x: any) => x.id === 'A');
  const planes = A.faces.filter((f: any) => f.type === 'PLANE').length;
  // The edge the top and the side met along (x = 20, z = 20) is gone.
  const crease = A.edges.some((e: any) => Math.abs(e.mid[0] - 20) < 1e-3 && Math.abs(e.mid[2] - 20) < 1e-3);
  check(`${name}: built, a valid closed solid`, !r.errors.length && !!s && shapeValid(s) && !A.openEdges?.length, r.errors.map((e: any) => e.message).join(' | '));
  check(`${name}: the other four faces flat as they were, no edge where the two met`, planes === 4 && !crease, `${planes} flat faces, crease ${crease}`);
}
console.log(failed ? `${failed} FAILED` : 'all ok');
process.exit(failed ? 1 : 0);
