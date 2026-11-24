// Run: npx tsx tests/freeformtools.test.ts - adding cage detail (edge loops,
// extrude, inset), and a part built with them, joined to other bodies.
import opencascade from 'replicad-opencascadejs';
import { measureVolume, setOC } from 'replicad';
import { applyPlan, archBridge, boxCage, limitPoints, subdivide, subdivisionPlan, bridgeFaces, cylinderCage, moveTurnScale, shapeCage, sweepFace, deleteFaces, extrudeFaces, holeLoops, bridgeLoops, boundaryEdges, cageEdgeKey, insertEdgeLoop, insetFaces, isClosed, planeCage, refineCage, selfCrossings, sphereCage, windingAgrees, type Cage } from '../src/freeform/cage';
import { cageToShape } from '../src/kernel/freeform';
import { debugBodies, regenerate, shapeValid } from '../src/kernel/engine';
import { arrangement, regionRef } from '../src/sketch/regions';
import type { Feature, PlaneDef } from '../src/doc/types';

setOC(await (opencascade as unknown as () => Promise<any>)());

let failed = 0;
const check = (name: string, ok: boolean, info = '') => {
  if (!ok) {
    failed++;
  }
  console.log(ok ? 'ok  ' : 'FAIL', name, info);
};
const solidOk = (cage: Cage) => {
  const shape = cageToShape(cage);

  return { s: shape, ok: shapeValid(shape) && measureVolume(shape) > 0, v: measureVolume(shape) };
};
const faceWith = (cage: Cage, test: (n: [number, number, number], m: [number, number, number]) => boolean): number[] => {
  const out: number[] = [];
  cage.faces.forEach((face, i) => {
    const corners = face.map(vertex => cage.verts[vertex]);
    const middle = [0, 1, 2].map(axis => (corners[0][axis] + corners[1][axis] + corners[2][axis] + corners[3][axis]) / 4) as [number, number, number];
    const diagonalA = [0, 1, 2].map(axis => corners[2][axis] - corners[0][axis]);
    const diagonalB = [0, 1, 2].map(axis => corners[3][axis] - corners[1][axis]);
    const normal = [diagonalA[1] * diagonalB[2] - diagonalA[2] * diagonalB[1], diagonalA[2] * diagonalB[0] - diagonalA[0] * diagonalB[2], diagonalA[0] * diagonalB[1] - diagonalA[1] * diagonalB[0]];
    const length = Math.hypot(...normal) || 1;
    if (test(normal.map(x => x / length) as [number, number, number], middle)) {
      out.push(i);
    }
  });

  return out;
};

// ------------------------------------------------------------ edge loops
{
  const b = boxCage([40, 40, 40], 2);
  const [a, cornerC] = b.faces[0];
  const cage = insertEdgeLoop(b, a, cornerC)!;
  check('edge loop round a box: closed, wound right, more faces', !!cage && isClosed(cage) && windingAgrees(cage) && cage.faces.length > b.faces.length, cage ? `${b.faces.length} → ${cage.faces.length} faces` : 'refused');
  const result = cage && solidOk(cage);
  check('  …and it still makes a clean solid', !!result?.ok && !selfCrossings(cage!).length, result ? `vol ${result.v.toFixed(0)} (was ${measureVolume(cageToShape(b)).toFixed(0)})` : '');
  const two = cage && insertEdgeLoop(cage, cage.faces[3][0], cage.faces[3][1], 0.2);
  check('a second loop near the first (closer to one side)', !!two && isClosed(two) && solidOk(two).ok);
  const plane = planeCage([40, 40], 3);
  const pl = insertEdgeLoop(plane, plane.faces[4][0], plane.faces[4][1]);
  check('edge loop across a sheet, border to border', !!pl && pl.faces.length === plane.faces.length + 3 && windingAgrees(pl), pl ? `${pl.faces.length} faces` : 'refused');
  const sphere = sphereCage(40);
  const sl = insertEdgeLoop(sphere, sphere.faces[0][0], sphere.faces[0][1]);
  check('edge loop on a sphere cage (around its odd points)', !sl || (isClosed(sl) && solidOk(sl).ok), sl ? `${sl.faces.length} faces` : 'refused (ring crosses itself)');
  const cy = cylinderCage(30, 40, 2);
  const side = faceWith(cy, normal => Math.abs(normal[2]) < 0.3)[0];
  const cl = insertEdgeLoop(cy, cy.faces[side][0], cy.faces[side][1]);
  check('edge loop round a cylinder (a new ring of points)', !!cl && isClosed(cl) && solidOk(cl).ok, cl ? `${cy.faces.length} → ${cl.faces.length}` : 'refused');
}

// ------------------------------------------------- subdivision plan
{
  // The precomputed weights give exactly the points subdivide + limitPoints do,
  // for closed, open, holed and uneven cages (spheres have 3-edge corners).
  const { readFileSync } = await import('node:fs');
  const fx = (fileName: string) => JSON.parse(readFileSync(new URL(`./fixtures/${fileName}`, import.meta.url), 'utf8'))[0].cage;
  const cyl = shapeCage('cylinder', [160, 160, 200], 4);
  const cases: [string, Cage][] = [
    ['box', boxCage([40, 30, 20], 2)],
    ['sphere', sphereCage(40)],
    ['sheet', planeCage([60, 40], 3)],
    ['open cylinder', deleteFaces(cyl, faceWith(cyl, normal => normal[2] > 0.9))],
    ['watering can (hand)', fx('wateringcan-hand.json')],
    ['watering can (no numbers)', fx('wateringcan-beginner.json')]
  ];
  for (const [name, cage] of cases) {
    const want = limitPoints(subdivide(cage, 3));
    const plan = subdivisionPlan(cage, 3);
    const got = applyPlan(plan, cage.verts);
    let worst = 0;
    want.forEach((point, i) => (worst = Math.max(worst, Math.abs(point[0] - got[3 * i]), Math.abs(point[1] - got[3 * i + 1]), Math.abs(point[2] - got[3 * i + 2]))));
    const grids = subdivide(cage, 3).grids;
    check(`subdivision plan = subdivide + limitPoints: ${name}`, got.length === want.length * 3 && worst < 1e-3 && JSON.stringify(grids) === JSON.stringify(plan.grids), `${want.length} points, worst ${worst.toExponential(1)}`);
  }
}

// ---------------------------------------------- exact Move / Turn / Scale
{
  const sq: [number, number, number][] = [[10, 0, 50], [20, 0, 50], [20, 10, 50], [10, 10, 50]];
  const near = (a: number[][], b: number[][]) => a.every((point, i) => point.every((value, axis) => Math.abs(value - b[i][axis]) < 1e-9));
  check("Scale with only All typed: every factor starts at 1 (the face isn't flattened)", near(moveTurnScale(sq, 'scale', [1, 1, 1, 0.5]), [[12.5, 2.5, 50], [17.5, 2.5, 50], [17.5, 7.5, 50], [12.5, 7.5, 50]]));
  check('Scale X only stretches along X', near(moveTurnScale(sq, 'scale', [2, 1, 1, 1]), [[5, 0, 50], [25, 0, 50], [25, 10, 50], [5, 10, 50]]));
  check('Move adds the offset', near(moveTurnScale(sq, 'move', [1, 2, 3, 1]), sq.map(point => [point[0] + 1, point[1] + 2, point[2] + 3])));
  check('Turn 90° about Z through the middle', near(moveTurnScale(sq, 'turn', [0, 0, 90, 1]), [[20, 0, 50], [20, 10, 50], [10, 10, 50], [10, 0, 50]]));
  const ground = cylinderCage(40, 40, 2).verts;
  const tall = moveTurnScale(ground, 'scale', [1, 1, 5, 1]);
  check('a shape standing on the ground grows up from it', Math.min(...tall.map(point => point[2])) === 0 && Math.abs(Math.max(...tall.map(point => point[2])) - 200) < 1e-9);
}

// ---------------------------------- sized shapes, sweep, arched bridge
{
  const cy = shapeCage('cylinder', [160, 160, 200], 4);
  const front = faceWith(cy, normal => normal[0] > 0.99);
  const zs = cy.verts.map(vertex => vertex[2]);
  check('a sized cylinder: 4 rows, standing on the ground, a face straight to the front', front.length === 4 && Math.min(...zs) === 0 && Math.max(...zs) === 200, `${front.length} front faces`);
  const face = faceWith(cy, (normal, middle) => normal[0] > 0.99 && middle[2] > 50 && middle[2] < 100)[0];
  const c0 = faceWith(cy, () => true).length;
  const sw = sweepFace(cy, face, { steps: 6, length: 150, bend: 60, taper: 0.6 })!;
  const corners = sw.cage.faces[sw.face].map(vertex => sw.cage.verts[vertex]);
  const end = [0, 1, 2].map(axis => corners.reduce((a, point) => a + point[axis], 0) / 4);
  const RADIUS = 150 / (Math.PI / 3);
  const want = [79.8 + RADIUS * Math.sin(Math.PI / 3), 0, 75 + RADIUS * (1 - Math.cos(Math.PI / 3))];
  const near = Math.hypot(end[0] - want[0], end[1] - want[1], end[2] - want[2]) < 1;
  check('sweep: 6 steps along a 60° arc, 150 long - the end face lands where the arc ends', !!sw && sw.cage.faces.length === c0 + 6 * 4 && near, `end at ${end.map(x => x.toFixed(1))}, want ${want.map(x => x.toFixed(1))}`);
  const result = solidOk(sw.cage);
  check("  …a clean solid that doesn't pass through itself", result.ok && !selfCrossings(sw.cage).length, `vol ${result.v.toFixed(0)}`);
  const w0 = Math.hypot(...[0, 1, 2].map(axis => cy.verts[cy.faces[face][0]][axis] - cy.verts[cy.faces[face][2]][axis]));
  const w1 = Math.hypot(...[0, 1, 2].map(axis => corners[0][axis] - corners[2][axis]));
  check('  …and ends 0.6 times as big', Math.abs(w1 / w0 - 0.6) < 1e-6, `${(w1 / w0).toFixed(3)}`);
  // A handle: two back faces, inset, bridged with an arch.
  const up = faceWith(cy, (normal, middle) => normal[0] < -0.99 && middle[2] > 150)[0];
  const lo = faceWith(cy, (normal, middle) => normal[0] < -0.99 && middle[2] > 50 && middle[2] < 100)[0];
  const ins = insetFaces(cy, [up, lo], 0.3)!;
  const cage = archBridge(ins.cage, ins.faces[0], ins.faces[1], { arch: 90, segments: 6 });
  const minX = cage ? Math.min(...cage.verts.map(vertex => vertex[0])) : 0;
  check('arched bridge: a closed, consistently wound handle that arches well out', !!cage && isClosed(cage) && windingAgrees(cage) && minX < -130, cage ? `${ins.cage.faces.length} → ${cage.faces.length} faces, out to x ${minX.toFixed(0)}` : 'refused');
  const hr = cage && solidOk(cage);
  check("  …a clean solid that doesn't pass through itself", !!hr?.ok && !selfCrossings(cage!).length, hr ? `vol ${hr.v.toFixed(0)}` : '');
  const flat = archBridge(ins.cage, ins.faces[0], ins.faces[1], { arch: 0, segments: 1 });
  check('  …arch 0 in one segment is the straight bridge', !!flat && flat.faces.length === ins.cage.faces.length - 2 + 4);
}

// ------------------------------------------------------------ bridge faces
{
  // A tunnel through a box: top and bottom faces bridged.
  // (3×3 a side: the middle faces, clear of the box's edges.)
  const b = boxCage([40, 40, 40], 3);
  const top = faceWith(b, (normal, middle) => normal[2] > 0.9 && Math.hypot(middle[0], middle[1]) < 1)[0];
  const bot = faceWith(b, (normal, middle) => normal[2] < -0.9 && Math.hypot(middle[0], middle[1]) < 1)[0];
  const t = bridgeFaces(b, top, bot);
  check('bridge two faces: a closed, consistently wound cage with a tunnel', !!t && isClosed(t) && windingAgrees(t) && t.faces.length === b.faces.length - 2 + 4, t ? `${b.faces.length} → ${t.faces.length} faces` : 'refused');
  const touching = bridgeFaces(boxCage([40, 40, 40], 2), 0, 1);
  check("faces that share a point can't be bridged", touching === null);
  const result = t && solidOk(t);
  check('  …and the box with a hole through it is a clean solid, smaller than the box', !!result?.ok && result.v < measureVolume(cageToShape(b)), result ? `vol ${result.v.toFixed(0)} vs ${measureVolume(cageToShape(b)).toFixed(0)}` : '');
}

// -------------------------------------------------------- extrude, inset
{
  const b = boxCage([40, 40, 40], 2);
  const top = faceWith(b, normal => normal[2] > 0.9);
  const v0 = measureVolume(cageToShape(b));
  const ex = extrudeFaces(b, [top[0]], 20)!;
  const result = solidOk(ex.cage);
  check('extrude one face out: closed, bigger, clean', isClosed(ex.cage) && windingAgrees(ex.cage) && result.ok && result.v > v0 && !selfCrossings(ex.cage).length, `vol ${v0.toFixed(0)} → ${result.v.toFixed(0)}`);
  const ex2 = extrudeFaces(b, top, 15)!;
  check('extrude a patch of faces together', isClosed(ex2.cage) && solidOk(ex2.cage).ok && ex2.cage.faces.length === b.faces.length + 8, `${ex2.cage.faces.length} faces`);
  const dent = extrudeFaces(b, [top[0]], -10)!;
  check('extrude inward (a dent)', isClosed(dent.cage) && solidOk(dent.cage).v < v0);
  const ins = insetFaces(b, [top[0]], 0.4)!;
  const ri = solidOk(ins.cage);
  check('inset a face: closed, about the same shape', isClosed(ins.cage) && windingAgrees(ins.cage) && ri.ok && Math.abs(ri.v - v0) / v0 < 0.15, `vol ${ri.v.toFixed(0)}`);
  const sh = planeCage([40, 40], 2);
  const se = extrudeFaces(sh, [0], 10)!;
  check('extrude a face of a sheet: still one open sheet, no stray points', !isClosed(se.cage) && windingAgrees(se.cage) && se.cage.verts.length === sh.verts.length + 4, `${se.cage.verts.length} points`);
}

// ---------------------------------------------- build something: a mug
let mug: Cage;
{
  let cage = cylinderCage(40, 50, 3);
  // Cavity: inset the top, push it down.
  const top = faceWith(cage, normal => normal[2] > 0.9);
  const ins = insetFaces(cage, top, 0.25)!;
  cage = extrudeFaces(ins.cage, ins.faces, -40)!.cage;
  // Handle: two side faces in one column pulled out, opened up and bridged.
  const sides = faceWith(cage, (normal, middle) => normal[0] > 0.8 && middle[1] > 0 && middle[2] > 0 && middle[2] < 50);
  sides.sort((i, j) => cage.faces[i].reduce((sum, vertex) => sum + cage.verts[vertex][2], 0) - cage.faces[j].reduce((sum, vertex) => sum + cage.verts[vertex][2], 0));
  const lo = sides[0];
  const hi = sides[sides.length - 1];
  const out = extrudeFaces(cage, [lo, hi], 14)!;
  cage = out.cage;
  const ends = out.faces;
  const open = deleteFaces(cage, ends);
  const loops = holeLoops(open, new Set(boundaryEdges(open).map(([a, b]) => cageEdgeKey(a, b))));
  const bridged = loops.length === 2 ? bridgeLoops(open, loops[0], loops[1]) : null;
  check('mug: cavity + handle bridged into a closed cage', !!bridged && isClosed(bridged) && windingAgrees(bridged), `${loops.length} holes, ${bridged?.faces.length ?? 0} faces`);
  mug = bridged ?? cage;
  const crossings = selfCrossings(mug);
  const result = solidOk(mug);
  check("mug: a clean solid (handle doesn't cut through the cup)", result.ok && !crossings.length, `vol ${result.v.toFixed(0)}, ${crossings.length} self-crossings`);
  // A hole through the handle: one solid with a tunnel (genus 1).
  const shape = cageToShape(mug);
  check('mug: one body, a real handle loop', shape.faces.length === mug.faces.length, `${shape.faces.length} surface patches`);
}

// ------------------------------------------ joined to other bodies
{
  const XY: PlaneDef = { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, 0, 1] };
  const plate = [{ id: 'r', kind: 'rect', center: [0, 0], w: 90, h: 70, rotation: 0 }];
  const sk: Feature = { id: 'sk', name: 'Sketch', type: 'sketch', plane: { ...XY, origin: [0, 0, -6] }, entities: plate } as Feature;
  const base: Feature = { id: 'plate', name: 'Plate', type: 'extrude', source: { kind: 'profile', sketch: 'sk', regions: arrangement(plate as any).regions.map(regionRef) }, distance: 8, mode: 'new' } as Feature;
  const cup: Feature = { id: 'mug', name: 'Mug', type: 'freeform', cage: mug } as Feature;
  const blob: Feature = { id: 'blob', name: 'Blob', type: 'freeform', cage: refineCage(sphereCage(26, [-30, 0, 8])) } as Feature;
  const run = async (fs: Feature[], name: string, want: number) => {
    const result: any = await regenerate(fs);
    const bodies = [...debugBodies()];
    const bad = bodies.filter(([, shape]) => !shapeValid(shape) || !(measureVolume(shape) > 0));
    check(name, !result.errors.length && !bad.length && bodies.length === want, result.errors.length ? result.errors[0].message : `${bodies.length} bodies, vols ${bodies.map(([, shape]) => measureVolume(shape).toFixed(0)).join(', ')}`);

    return result;
  };
  await run([cup, sk, base, { id: 'u', name: 'Union', type: 'boolean', op: 'union', target: 'plate', tools: ['mug'] } as Feature], 'mug welded onto a plate (union)', 1);
  await run([cup, blob, { id: 'u2', name: 'Union', type: 'boolean', op: 'union', target: 'mug', tools: ['blob'] } as Feature], 'mug + another freeform (union)', 1);
  await run([cup, blob, { id: 'c', name: 'Cut', type: 'boolean', op: 'subtract', target: 'mug', tools: ['blob'] } as Feature], 'another freeform cut out of the mug', 1);
  await run([cup, sk, base, { id: 'i', name: 'Common', type: 'boolean', op: 'intersect', target: 'mug', tools: ['plate'] } as Feature], 'mug ∩ plate (just the bottom)', 1);
  await run([cup, { id: 't', name: 'Stretch', type: 'transform', bodies: ['mug'], copy: false, op: { kind: 'scaleXYZ', center: [0, 0, 0], factors: [1.5, 1, 1] } } as Feature], 'mug stretched 1.5× along X (rebuilt from its cage)', 1);
}

process.exit(failed ? 1 : 0);
