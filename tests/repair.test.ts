// Run: npx tsx tests/repair.test.ts - the repair tool on shapes broken on purpose.
import opencascade from 'replicad-opencascadejs';
import { cast, getOC, makeBaseBox, makeCompound, makeCylinder, makePolygon, measureVolume, setOC, type Shape3D } from 'replicad';
import { healthOf, isHealthy, repairShape } from '../src/kernel/repair';

setOC(await (opencascade as unknown as () => Promise<any>)());
const oc = getOC();

let failed = 0;
const check = (name: string, ok: boolean, info = '') => {
  if (!ok) {
    failed++;
  }
  console.log(ok ? 'ok  ' : 'FAIL', name, info);
};
const pile = (faces: unknown[]) => makeCompound(faces.map(face => cast(face as never))) as unknown as Shape3D;
const vol = (shape: Shape3D) => measureVolume(shape);
const near = (a: number, b: number, rel = 5e-3) => Math.abs(a - b) <= Math.abs(b) * rel;

const box = makeBaseBox(40, 30, 20) as unknown as Shape3D;
const VOLUME = vol(box);

{
  const repaired = repairShape(box);
  check('a healthy body comes back as it is', !!repaired && repaired.shape === box && repaired.fixes.length === 0);
}
{
  // A face missing (an open box): the hole is flat, so it's filled.
  const repaired = repairShape(pile(box.faces.slice(1).map(face => face.wrapped)), { volume: VOLUME });
  check('box with a face missing → closed solid, same volume', !!repaired && isHealthy(healthOf(repaired.shape)) && near(vol(repaired.shape), VOLUME), repaired ? `${repaired.fixes.join(', ')}; vol ${vol(repaired.shape).toFixed(1)} / ${VOLUME}` : 'not repaired');
}
{
  // Faces pulled apart a little (as a STEP file from another program can be).
  const moved = box.faces.map((face, i) => {
    const center = face.center;
    const nudge = 0.02 * (i % 2 ? 1 : -1);

    return (face.translate([center.x * 0 + nudge, nudge * 0.5, -nudge * 0.3]) as any).wrapped;
  });
  const repaired = repairShape(pile(moved), { volume: VOLUME });
  check('faces 0.02 apart (gaps) → sewn into a solid', !!repaired && isHealthy(healthOf(repaired.shape)) && near(vol(repaired.shape), VOLUME, 0.02), repaired ? `${repaired.fixes.join(', ')}; vol ${vol(repaired.shape).toFixed(1)}` : 'not repaired');
}
{
  const inside = cast(box.wrapped.Reversed()) as unknown as Shape3D;
  const repaired = repairShape(inside);
  check('inside-out solid → turned round', !!repaired && vol(repaired.shape) > 0 && near(vol(repaired.shape), VOLUME), repaired ? repaired.fixes.join(', ') : 'not repaired');
}
{
  const cyl = makeCylinder(10, 30) as unknown as Shape3D;
  const repaired = repairShape(pile(cyl.faces.map(face => face.wrapped)), { volume: vol(cyl) });
  check('loose faces of a cylinder → solid', !!repaired && isHealthy(healthOf(repaired.shape)) && near(vol(repaired.shape), vol(cyl)), repaired ? repaired.fixes.join(', ') : 'not repaired');
}
{
  // A cube as 12 triangles (what an STL is): one solid, and its faces merged back to 6.
  const corners = [[0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0], [0, 0, 10], [10, 0, 10], [10, 10, 10], [0, 10, 10]] as [number, number, number][];
  const quads = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]];
  const tris = quads.flatMap(([a, b, cornerC, cornerD]) => [[a, b, cornerC], [a, cornerC, cornerD]]).map(t => makePolygon(t.map(i => corners[i])).wrapped);
  const repaired = repairShape(pile(tris), { volume: 1000 });
  check('cube as 12 triangles (an STL) → solid of 6 faces', !!repaired && isHealthy(healthOf(repaired.shape)) && near(vol(repaired.shape), 1000) && repaired.shape.faces.length === 6, repaired ? `${repaired.fixes.join(', ')}; ${repaired.shape.faces.length} faces` : 'not repaired');
}
{
  // Two boxes fused a hair apart: a sliver of a face where they almost meet.
  const a = makeBaseBox(20, 20, 20) as unknown as Shape3D;
  const b = (makeBaseBox(20, 20, 20) as any).translate([10, 0, 1e-5]) as Shape3D;
  const shape = (a as any).fuse(b) as Shape3D;
  const health = healthOf(shape);
  const repaired = repairShape(shape);
  check('fused with a 0.00001 step (hair-thin faces) → clean', health.thin > 0 && (!!repaired && healthOf(repaired.shape).thin === 0 && near(vol(repaired.shape), vol(shape), 0.01)), `before: ${health.thin} thin, ${health.solids} solids; ${repaired ? repaired.fixes.join(', ') : 'not repaired'}`);
}
{
  // An STL sphere mesh, imported: sewn into a real solid.
  const rings = 12;
  const pts: number[][][] = [];
  for (let i = 0; i <= rings; i++) {
    const row: number[][] = [];
    for (let j = 0; j < 2 * rings; j++) {
      const th = (i / rings) * Math.PI;
      const ph = (j / (2 * rings)) * 2 * Math.PI;
      row.push([10 * Math.sin(th) * Math.cos(ph), 10 * Math.sin(th) * Math.sin(ph), 10 * Math.cos(th)]);
    }
    pts.push(row);
  }
  // What an STL import gives: loose triangles.
  const tris: unknown[] = [];
  const tri = (a: number[], b: number[], pointC: number[]) => tris.push(makePolygon([a, b, pointC] as [number, number, number][]).wrapped);
  for (let i = 0; i < rings; i++) {
    for (let j = 0; j < 2 * rings; j++) {
      const j2 = (j + 1) % (2 * rings);
      if (i > 0) {
        tri(pts[i][j], pts[i + 1][j], pts[i][j2]);
      }
      if (i < rings - 1) {
        tri(pts[i][j2], pts[i + 1][j], pts[i + 1][j2]);
      }
    }
  }
  const mesh = pile(tris);
  const health = healthOf(mesh);
  const t0 = performance.now();
  const repaired = repairShape(mesh);
  const dt = performance.now() - t0;
  check('STL-style sphere mesh (loose triangles) → one solid', !!repaired && isHealthy(healthOf(repaired.shape)) && vol(repaired.shape) > 3500, `before: ${health.solids} solids, ${health.faces} faces; ${repaired ? `${repaired.fixes.join(', ')}, vol ${vol(repaired.shape).toFixed(0)}` : 'not repaired'}, ${dt.toFixed(0)} ms`);
}
{
  const one = pile([box.faces[0].wrapped]);
  check("a lone face can't be made a solid → refused", repairShape(one) === null);
}
void oc;
process.exit(failed ? 1 : 0);
