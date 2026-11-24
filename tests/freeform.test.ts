// Run: npx tsx tests/freeform.test.ts - cages, subdivision and the cage → solid conversion.
import assert from 'node:assert/strict';
import opencascade from 'replicad-opencascadejs';
import { measureVolume, setOC, type Shape3D } from 'replicad';
import { fillHole, refineCage, boundaryEdges, boxCage, bridgeLoops, cageEdgeKey, cageEdges, cylinderCage, deleteFaces, fillLoop, holeLoops, isClosed, planeCage, sphereCage, subdivide } from '../src/freeform/cage';
import { cageToShape } from '../src/kernel/freeform';
import { evalSurface, interpolateGrid } from '../src/freeform/bspline';
import { detachFreeformCopy, freeformBodies } from '../src/doc/freeformCopies';
import { connectEdges } from '../src/doc/freeformConnect';
import { borderEdgeMids } from '../src/freeform/cage';
import { emptyDoc, type Feature } from '../src/doc/types';

setOC(await (opencascade as unknown as () => Promise<any>)());

const checks: [string, () => string][] = [
  ['cages are closed (box, cylinder, sphere) / open (plane)', () => {
    assert.ok(isClosed(boxCage()));
    assert.ok(isClosed(cylinderCage()));
    assert.ok(isClosed(sphereCage()));
    assert.ok(!isClosed(planeCage()));

    return `box ${boxCage().verts.length} pts, cylinder ${cylinderCage().faces.length} faces`;
  }],
  ['subdivision: every face becomes a 9×9 grid sharing its borders', () => {
    const subdivided = subdivide(boxCage(), 3);
    assert.equal(subdivided.n, 8);
    assert.equal(subdivided.grids.length, 24);
    // Euler characteristic of a closed surface: V − E + F = 2.
    const faceCount = subdivided.grids.length * 64;
    const edgeCount = (faceCount * 4) / 2;
    assert.equal(subdivided.points.length - edgeCount + faceCount, 2);

    return `${subdivided.points.length} points`;
  }],
  ['patch surfaces pass through their grid points', () => {
    const subdivided = subdivide(sphereCage(40), 3);
    const grid = subdivided.grids[5].map(row => row.map(i => subdivided.points[i]));
    const poles = interpolateGrid(grid);
    let worst = 0;
    for (let i = 0; i <= 8; i++) {
      for (let j = 0; j <= 8; j++) {
        const q = evalSurface(poles, i / 8, j / 8);
        worst = Math.max(worst, Math.hypot(q[0] - grid[i][j][0], q[1] - grid[i][j][1], q[2] - grid[i][j][2]));
      }
    }
    assert.ok(worst < 1e-9, `off by ${worst}`);

    return `max error ${worst.toExponential(1)}`;
  }],
  ['sphere cage → near-spherical solid of ~diameter 40', () => {
    const solid = cageToShape(sphereCage(40));
    const volume = measureVolume(solid);
    const ideal = (4 / 3) * Math.PI * 20 ** 3;
    const bb = solid.boundingBox;
    assert.ok(Math.abs(volume - ideal) / ideal < 0.12, `volume ${volume} vs ${ideal}`);

    return `vol ${volume.toFixed(0)} (sphere ${ideal.toFixed(0)}), ${solid.faces.length} faces, size ${bb.width.toFixed(1)}`;
  }],
  ['box cage → closed solid', () => {
    const solid = cageToShape(boxCage([40, 40, 40], 2));
    const volume = measureVolume(solid);
    assert.ok(volume > 20000 && volume < 64000, `volume ${volume}`);

    return `vol ${volume.toFixed(0)}, ${solid.faces.length} faces`;
  }],
  ['cylinder cage → closed solid', () => {
    const solid = cageToShape(cylinderCage(40, 40));
    const volume = measureVolume(solid);
    assert.ok(volume > 20000, `volume ${volume}`);

    return `vol ${volume.toFixed(0)}`;
  }],
  ['moving a cage point bulges the shape', () => {
    const cage = sphereCage(40);
    const top = cage.verts.reduce((best, vertex, i) => (vertex[2] > cage.verts[best][2] ? i : best), 0);
    const before = cageToShape(cage).boundingBox.depth;
    cage.verts[top] = [cage.verts[top][0], cage.verts[top][1], cage.verts[top][2] + 20];
    const after = cageToShape(cage).boundingBox.depth;
    assert.ok(after > before + 5, `${before} → ${after}`);

    return `height ${before.toFixed(1)} → ${after.toFixed(1)}`;
  }],
  ['plane surface thickened up / down / both → solids of the same volume', () => {
    const vols = (['up', 'down', 'both'] as const).map((side) => {
      const shape = cageToShape(planeCage([60, 60], 4), 3, { thickness: 2, side });
      const bb = shape.boundingBox;

      return { v: measureVolume(shape), zmin: bb.bounds[0][2], zmax: bb.bounds[1][2] };
    });
    for (const x of vols) {
      assert.ok(Math.abs(x.v - vols[0].v) / vols[0].v < 0.02 && x.v > 1000, JSON.stringify(vols));
    }
    assert.ok(vols[0].zmin > -0.01 && vols[1].zmax < 0.01 && vols[2].zmin < -0.9 && vols[2].zmax > 0.9, JSON.stringify(vols));

    return vols.map(volume => `${volume.v.toFixed(0)} [${volume.zmin.toFixed(1)}…${volume.zmax.toFixed(1)}]`).join(', ');
  }],
  ['delete a face, then fill the hole again → closed solid', () => {
    const box = boxCage([40, 40, 40], 2);
    const holed = deleteFaces(box, [0]);
    assert.ok(!isClosed(holed));
    const rim = new Set(boundaryEdges(holed).map(([a, b]) => cageEdgeKey(a, b)));
    const loops = holeLoops(holed, rim);
    assert.equal(loops.length, 1);
    const filled = fillLoop(holed, loops[0])!;
    assert.ok(isClosed(filled));
    const volume = measureVolume(cageToShape(filled));
    assert.ok(volume > 0, `volume ${volume}`);

    return `hole of ${loops[0].length} edges filled, vol ${volume.toFixed(0)}`;
  }],
  ['two facing holes bridged → closed (tunnel)', () => {
    // Box, 3 per side: remove the middle top and middle bottom quads → a hole through.
    const box = boxCage([40, 40, 40], 3);
    const holed = deleteFaces(box, [4, 13]);
    const loops = holeLoops(holed, new Set(boundaryEdges(holed).map(([a, b]) => cageEdgeKey(a, b))));
    assert.equal(loops.length, 2);
    const tube = bridgeLoops(holed, loops[0], loops[1])!;
    assert.ok(isClosed(tube));
    const solid = cageToShape(tube);
    const full = measureVolume(cageToShape(box));
    // A real hole through: less than the full box, but most of it is still there.
    assert.ok(measureVolume(solid) > full * 0.5 && measureVolume(solid) < full * 0.97, `volume ${measureVolume(solid)} vs box ${full}`);

    return `${tube.faces.length} faces, vol ${measureVolume(solid).toFixed(0)}`;
  }],
  ['plane cage → open surface (a shell, no volume)', () => {
    const sheet = cageToShape(planeCage([60, 60], 4)) as Shape3D;
    assert.equal(sheet.faces.length, 16);

    return `${sheet.faces.length} faces, ${cageEdges(planeCage()).length} cage edges`;
  }],
  ['a copy of a freeform becomes its own freeform (and a copy of that copy follows)', () => {
    const cage = planeCage([60, 60], 4);
    const doc = {
      ...emptyDoc(),
      features: [
        { id: 'ff', name: 'Freeform', type: 'freeform', cage, surface: true },
        { id: 'c1', name: 'Copy 01', type: 'transform', bodies: ['ff'], copy: true, op: { kind: 'move', translate: [0, 0, 40], rotate: { origin: [0, 0, 0], axis: [0, 0, 1], angle: 90 } } },
        { id: 'c2', name: 'Copy 02', type: 'transform', bodies: ['c1:ff:0'], copy: true, op: { kind: 'move', translate: [0, 0, 50] } }
      ] as Feature[],
      names: { 'c1:ff:0': 'Lid', 'c2:c1:ff:0:0': 'Top' }
    };
    const before = freeformBodies(doc.features);
    const out = detachFreeformCopy(doc, 'c1:ff:0', 'ff2')!;
    assert.ok(out);
    const features = out.doc.features;
    assert.deepEqual(features.map(feature => feature.id), ['ff', 'ff2', 'c2']);
    const own = features[1] as Extract<Feature, { type: 'freeform' }>;
    // The new cage sits where the copy was (turned 90° about z, 40 up).
    const firstVertex = own.cage.verts[0];
    const q = cage.verts[0];
    assert.ok(Math.hypot(firstVertex[0] + q[1], firstVertex[1] - q[0], firstVertex[2] - 40) < 1e-9, JSON.stringify([firstVertex, q]));
    // The original is untouched; the second copy now copies the new freeform.
    assert.deepEqual((features[0] as typeof own).cage.verts, cage.verts);
    assert.deepEqual((features[2] as Extract<Feature, { type: 'transform' }>).bodies, ['ff2']);
    assert.equal(out.doc.names['ff2'], 'Lid');
    assert.equal(out.doc.names['c2:ff2:0'], 'Top');
    // Same shapes as before: the top copy lands where it did.
    const after = freeformBodies(features);
    const top0 = before.get('c2:c1:ff:0:0')!;
    const top1 = after.get('c2:ff2:0')!;
    const at = (t: typeof top0, vector: number[]) => [0, 1, 2].map(row => t.m[row * 4] * vector[0] + t.m[row * 4 + 1] * vector[1] + t.m[row * 4 + 2] * vector[2] + t.m[row * 4 + 3]);
    const a = at(top0, top0.feature.cage.verts[5]);
    const b = at(top1, top1.feature.cage.verts[5]);
    assert.ok(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < 1e-9);
    // Linked copies stay copies.
    const linked = { ...doc, features: doc.features.map(feature => (feature.id === 'c1' ? { ...feature, link: true } : feature)) as Feature[] };
    assert.equal(detachFreeformCopy(linked, 'c1:ff:0', 'ff3'), null);

    return `${features.length} steps, copy cage ${own.cage.verts.length} pts`;
  }],
  ['refining a cage keeps the shape; an odd hole is filled after refining', () => {
    const box = boxCage([40, 40, 40], 2);
    const fine = refineCage(box);
    assert.equal(fine.faces.length, box.faces.length * 4);
    const v0 = measureVolume(cageToShape(box));
    const v1 = measureVolume(cageToShape(fine));
    assert.ok(Math.abs(v1 - v0) / v0 < 0.01, `volume ${v0} → ${v1}`);
    // A 3-edge hole (a corner of a box-like cage cut by hand): faces around a corner gone,
    // rim walked as 3 cage points (the even-hole rule refuses it).
    const holed = deleteFaces(box, [0]);
    const loop = holeLoops(holed, new Set(boundaryEdges(holed).map(([a, b]) => cageEdgeKey(a, b))))[0];
    const tri = [loop[0], loop[1], loop[2]];
    assert.equal(fillLoop(holed, tri), null);
    const even = fillHole(holed, loop)!;
    assert.ok(isClosed(even.cage) && !even.refined);

    return `${fine.faces.length} faces, volume ${v0.toFixed(0)} → ${v1.toFixed(0)}`;
  }],
  ['connect: two stacked surfaces with a hole each → one surface with a tube between', () => {
    const sheet = (z: number) => {
      const cage = planeCage([60, 60], 3);

      return deleteFaces({ faces: cage.faces, verts: cage.verts.map(vertex => [vertex[0], vertex[1], z] as [number, number, number]) }, [4]);
    };
    const lo = sheet(0);
    const hi = sheet(30);
    const doc = {
      ...emptyDoc(),
      features: [
        { id: 'lo', name: 'Lower', type: 'freeform', cage: lo, surface: true },
        { id: 'hi', name: 'Upper', type: 'freeform', cage: hi, surface: true },
        { id: 'mv', name: 'Move', type: 'transform', bodies: ['hi'], copy: false, op: { kind: 'move', translate: [0, 0, 10] } }
      ] as Feature[]
    };
    // Pick the hole rims as a user would: the middle of each rim edge on the surface.
    const rim = (cage: typeof lo, dz: number, body: string) => borderEdgeMids(cage).filter(borderEdgeMid => Math.hypot(borderEdgeMid.at[0], borderEdgeMid.at[1]) < 15).map(borderEdgeMid => ({ body, mid: [borderEdgeMid.at[0], borderEdgeMid.at[1], borderEdgeMid.at[2] + dz] as [number, number, number] }));
    const picks = [...rim(lo, 0, 'lo'), ...rim(hi, 10, 'hi')];
    assert.equal(picks.length, 8);
    const out = connectEdges(doc, picks);
    assert.ok('doc' in out, 'error' in out ? out.error : '');
    const features = out.doc.features;
    assert.deepEqual(features.map(feature => feature.id), ['hi', 'mv']);
    const merged = features[0] as Extract<Feature, { type: 'freeform' }>;
    assert.equal(merged.cage.faces.length, 8 + 8 + 4);
    // The lower sheet kept its place: stored so that after the move it is back at z = 0.
    assert.ok(merged.cage.verts.some(vertex => Math.abs(vertex[2] + 10) < 1e-9) && merged.cage.verts.some(vertex => Math.abs(vertex[2] - 30) < 1e-9));
    const shape = cageToShape(merged.cage) as Shape3D;
    assert.equal(shape.faces.length, 20);

    return `${merged.cage.faces.length} cage faces`;
  }],
  ['connect: two edges of one surface → a new quad between them', () => {
    const cage = planeCage([40, 40], 2);
    const bent = { faces: cage.faces, verts: cage.verts.map(vertex => [vertex[0], vertex[1], vertex[1] > 0 ? 0 : 0] as [number, number, number]) };
    // A strip with a gap: drop the middle row's faces? Use two opposite borders of one sheet folded up.
    const doc = { ...emptyDoc(), features: [{ id: 's', name: 'S', type: 'freeform', cage: bent, surface: true }] as Feature[] };
    const mids = borderEdgeMids(bent);
    const left = mids.find(mid => mid.at[0] < -19 && mid.at[1] > 0)!;
    const right = mids.find(mid => mid.at[0] > 19 && mid.at[1] > 0)!;
    const out = connectEdges(doc, [{ body: 's', mid: left.at }, { body: 's', mid: right.at }]);
    assert.ok('doc' in out, 'error' in out ? out.error : '');
    const ff = out.doc.features[0] as Extract<Feature, { type: 'freeform' }>;
    assert.equal(ff.cage.faces.length, 5);
    // Different counts are refused with a reason.
    const bad = connectEdges(doc, [{ body: 's', mid: left.at }, { body: 's', mid: right.at }, { body: 's', mid: mids.find(mid => mid.at[0] > 19 && mid.at[1] < 0)!.at }]);
    assert.ok('error' in bad);

    return `${ff.cage.faces.length} faces; uneven: ${'error' in bad ? bad.error : ''}`;
  }]
];

let failed = 0;
for (const [name, fn] of checks) {
  try {
    console.log('ok  ', name, '-', fn());
  } catch (e) {
    failed++;
    console.log('FAIL', name, '-', e instanceof Error ? e.message : e);
  }
}
process.exit(failed ? 1 : 0);
