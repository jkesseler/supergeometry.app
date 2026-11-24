// Run: npx tsx tests/deleteheal.test.ts - deleting faces, fillets, chamfers and
// holes as if they'd never been there: the neighbours carry on until they meet,
// and the result must be exactly the part without that feature.
import opencascade from 'replicad-opencascadejs';
import { makeBaseBox, makeCylinder, measureVolume, setOC, type Face, type Shape3D } from 'replicad';
import { cylinderOf, deleteFace, deleteFaces, blendChain } from '../src/kernel/faceEdit';
import { useSafeBooleans } from '../src/kernel/safeBooleans';
import { healthOf, isHealthy } from '../src/kernel/repair';

setOC(await (opencascade as unknown as () => Promise<any>)());
useSafeBooleans();

let failed = 0;
const check = (name: string, ok: boolean, info = '') => {
  if (!ok) {
    failed++;
  }
  console.log(ok ? 'ok  ' : 'FAIL', name, info);
};
const near = (a: number, b: number, rel = 1e-6) => Math.abs(a - b) <= Math.abs(b) * rel + 1e-9;
const volumeOf = (shape: Shape3D) => Math.abs(measureVolume(shape));
const curved = (shape: Shape3D) => shape.faces.filter(face => face.geomType !== 'PLANE');
const run = (name: string, fn: () => [boolean, string]) => {
  try {
    const [ok, info] = fn();
    check(name, ok, info);
  } catch (e) {
    check(name, false, `threw: ${(e as Error).message}`);
  }
};
const clean = (shape: Shape3D) => isHealthy(healthOf(shape));

const box = () => makeBaseBox(40, 30, 20) as unknown as Shape3D;
const BOX = 40 * 30 * 20;

run('box with its 4 upright edges filleted: delete one fillet → that corner sharp again', () => {
  const b = (box() as any).fillet(4, (e: any) => e.inDirection('Z')) as Shape3D;
  const face = curved(b)[0];
  const out = deleteFace(b, face);
  const want = BOX - 3 * 16 * (1 - Math.PI / 4) * 20;

  return [clean(out) && near(volumeOf(out), want) && curved(out).length === 3 && out.faces.length === b.faces.length - 1, `vol ${volumeOf(out).toFixed(3)} want ${want.toFixed(3)}, ${out.faces.length} faces`];
});

run('box with every edge filleted: delete the fillet → a sharp box (the whole blend goes)', () => {
  const b = (box() as any).fillet(3) as Shape3D;
  const chain = blendChain(b, curved(b)[0]);
  const out = deleteFace(b, curved(b)[0]);

  return [clean(out) && near(volumeOf(out), BOX) && out.faces.length === 6, `chain of ${chain.length}, vol ${volumeOf(out).toFixed(3)}, ${out.faces.length} faces`];
});

run('chamfered edge: delete the chamfer → sharp edge', () => {
  const b = (box() as any).chamfer(5, (e: any) => e.inDirection('X').containsPoint([0, 15, 20])) as Shape3D;
  const ch = b.faces.find((face: Face) => {
    const normal = face.normalAt().toTuple();

    return Math.abs(normal[1]) > 0.1 && Math.abs(normal[2]) > 0.1;
  })!;
  const out = deleteFace(b, ch);

  return [clean(out) && near(volumeOf(out), BOX) && out.faces.length === 6, `vol ${volumeOf(out).toFixed(3)}, ${out.faces.length} faces`];
});

run("plate with a hole through it: delete the hole's wall → solid plate", () => {
  const b = (box() as any).cut(makeCylinder(5, 40, [0, 0, -10])) as Shape3D;
  const wall = curved(b)[0];
  const out = deleteFace(b, wall);

  return [clean(out) && near(volumeOf(out), BOX) && out.faces.length === 6, `vol ${volumeOf(out).toFixed(3)}, ${out.faces.length} faces`];
});

run('blind hole: delete its wall → filled (its floor goes too)', () => {
  const b = (box() as any).cut(makeCylinder(5, 12, [0, 0, 8])) as Shape3D;
  const out = deleteFace(b, curved(b)[0]);

  return [clean(out) && near(volumeOf(out), BOX) && out.faces.length === 6, `vol ${volumeOf(out).toFixed(3)}, ${out.faces.length} faces`];
});

run('hole near the edge of the plate: filled exactly, nothing sticking out', () => {
  const b = (box() as any).cut(makeCylinder(4, 40, [15, 0, -10])) as Shape3D;
  const out = deleteFace(b, curved(b)[0]);
  const bb = out.boundingBox;

  return [clean(out) && near(volumeOf(out), BOX) && near(bb.width, 40), `vol ${volumeOf(out).toFixed(3)}, width ${bb.width.toFixed(4)}`];
});

run('inside corner (L shape) with a fillet: delete it → sharp inside corner', () => {
  const shape = (makeBaseBox(40, 30, 10) as any).fuse((makeBaseBox(10, 30, 30) as any).translate([-15, 0, 0])) as Shape3D;
  const base = volumeOf(shape);
  const filleted = (shape as any).fillet(4, (e: any) => e.inDirection('Y').containsPoint([-10, 0, 10])) as Shape3D;
  const out = deleteFace(filleted, curved(filleted)[0]);

  return [clean(out) && near(volumeOf(out), base) && curved(out).length === 0, `vol ${volumeOf(out).toFixed(3)} want ${base.toFixed(3)}`];
});

run('boss on a plate: delete its side → the boss goes (or a clear message)', () => {
  const b = (box() as any).fuse(makeCylinder(6, 15, [0, 0, 20])) as Shape3D;
  try {
    const out = deleteFace(b, curved(b)[0]);

    return [clean(out) && (near(volumeOf(out), BOX) || volumeOf(out) > BOX), `vol ${volumeOf(out).toFixed(3)}`];
  } catch (e) {
    return [/can't be removed/.test((e as Error).message), (e as Error).message];
  }
});

run('a plain side of a box: refused (nothing would close it)', () => {
  const b = box();
  try {
    deleteFace(b, b.faces[0]);

    return [false, 'accepted'];
  } catch (e) {
    return [/can't be removed/.test((e as Error).message), (e as Error).message];
  }
});

run('filleted hole edge: delete the fillet → sharp hole rim', () => {
  const holed = (box() as any).cut(makeCylinder(6, 40, [0, 0, -10])) as Shape3D;
  const base = volumeOf(holed);
  const shape = (holed as any).fillet(2, (e: any) => e.ofCurveType('CIRCLE').containsPoint([6, 0, 20])) as Shape3D;
  const fil = shape.faces.find((face: Face) => face.geomType === 'TORUS');
  if (!fil) {
    return [false, `no torus face (${shape.faces.map((face: Face) => face.geomType).join(',')})`];
  }
  const out = deleteFace(shape, fil);

  return [clean(out) && near(volumeOf(out), base, 1e-5), `vol ${volumeOf(out).toFixed(3)} want ${base.toFixed(3)}`];
});

run('two fillets deleted together', () => {
  const b = (box() as any).fillet(4, (e: any) => e.inDirection('Z')) as Shape3D;
  const out = deleteFaces(b, curved(b).slice(0, 2));
  const want = BOX - 2 * 16 * (1 - Math.PI / 4) * 20;

  return [clean(out) && near(volumeOf(out), want), `vol ${volumeOf(out).toFixed(3)} want ${want.toFixed(3)}`];
});

// ------------------------------------------------------------ harder ones
run('fillets meeting at corners (upright edges, then the top ring): delete an upright one', () => {
  const b0 = (box() as any).fillet(4, (e: any) => e.inDirection('Z')) as Shape3D;
  const b = (b0 as any).fillet(2, (e: any) => e.inPlane('XY', 20)) as Shape3D;
  const volume = volumeOf(b);
  const up = curved(b).find(face => face.geomType === 'CYLINDRE' && Math.abs(face.normalAt().toTuple()[2]) < 0.1 && face.boundingBox.depth > 10)!;
  const out = deleteFace(b, up);

  return [clean(out) && volumeOf(out) > volume && curved(out).length < curved(b).length, `vol ${volume.toFixed(1)} → ${volumeOf(out).toFixed(1)}, curved faces ${curved(b).length} → ${curved(out).length}`];
});

run('boss with a filleted base: delete the base fillet → sharp where the boss meets the plate', () => {
  const plain = (box() as any).fuse(makeCylinder(6, 15, [0, 0, 20])) as Shape3D;
  const want = volumeOf(plain);
  const b = (plain as any).fillet(2, (e: any) => e.ofCurveType('CIRCLE').containsPoint([6, 0, 20])) as Shape3D;
  const fil = b.faces.find((face: Face) => face.geomType === 'TORUS');
  if (!fil) {
    return [false, 'no fillet made'];
  }
  const out = deleteFace(b, fil);

  return [clean(out) && near(volumeOf(out), want, 1e-5), `vol ${volumeOf(out).toFixed(3)} want ${want.toFixed(3)}`];
});

run('pocket with filleted floor edges: delete the floor fillet → sharp pocket floor', () => {
  const pocket = (box() as any).cut((makeBaseBox(20, 14, 10) as any).translate([0, 0, 12])) as Shape3D;
  const want = volumeOf(pocket);
  const b = (pocket as any).fillet(2, (e: any) => e.inPlane('XY', 12)) as Shape3D;
  const fil = curved(b)[0];
  const out = deleteFace(b, fil);

  return [clean(out) && near(volumeOf(out), want, 1e-5), `vol ${volumeOf(out).toFixed(3)} want ${want.toFixed(3)}, chain ${blendChain(b, fil).length}`];
});

run('one chamfer of a ring of chamfers round the top: delete it', () => {
  const b = (box() as any).chamfer(3, (e: any) => e.inPlane('XY', 20)) as Shape3D;
  const ch = b.faces.find((face: Face) => {
    const normal = face.normalAt().toTuple();

    return normal[0] > 0.3 && normal[2] > 0.3;
  })!;
  const out = deleteFace(b, ch);

  return [clean(out) && volumeOf(out) > volumeOf(b) && out.faces.length <= b.faces.length, `vol ${volumeOf(b).toFixed(1)} → ${volumeOf(out).toFixed(1)}, faces ${b.faces.length} → ${out.faces.length}`];
});

// (The hole 0.2 clear of the top and the side: at z 17 it touched the top along a line, and
// the part without the fillet was itself pinched there.)
run('fillet next to a hole (the hole cuts into it): delete the fillet', () => {
  const f0 = (box() as any).fillet(5, (e: any) => e.inDirection('Y').containsPoint([20, 0, 20])) as Shape3D;
  const b = (f0 as any).cut(makeCylinder(3, 60, [16.8, -30, 16.8], [0, 1, 0])) as Shape3D;
  const fil = b.faces.find((face: Face) => Math.abs((cylinderOf(face)?.r ?? 0) - 5) < 1e-6)!;
  const want = volumeOf((box() as any).cut(makeCylinder(3, 60, [16.8, -30, 16.8], [0, 1, 0])));
  const out = deleteFace(b, fil);

  return [clean(out) && near(volumeOf(out), want, 1e-4), `vol ${volumeOf(out).toFixed(3)} want ${want.toFixed(3)}`];
});

run('a whole side wall of a box with a boss through it: refused (not "just the boss is left")', () => {
  const b = (box() as any).fuse(makeCylinder(6, 36, [10, 0, 0])) as Shape3D;
  const side = b.faces.find((face: Face) => face.geomType === 'PLANE' && face.normalAt().toTuple()[0] < -0.99)!;
  try {
    const out = deleteFace(b, side);

    return [false, `accepted: vol ${volumeOf(b).toFixed(1)} → ${volumeOf(out).toFixed(1)}`];
  } catch (e) {
    return [/can't be removed/.test((e as Error).message), (e as Error).message];
  }
});

process.exit(failed ? 1 : 0);
