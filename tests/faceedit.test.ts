// Run: npx tsx tests/faceedit.test.ts - direct face edits on real OpenCascade solids.
import opencascade from 'replicad-opencascadejs';
import { basicFaceExtrusion, makeCylinder, makeBox, measureVolume, setOC, Vector, type Shape3D } from 'replicad';
import { deleteFace, offsetFace, replaceFacePlane } from '../src/kernel/faceEdit';
import { regionFaces } from '../src/kernel/sketchGeom';
import { arrangement, regionRef } from '../src/sketch/regions';

setOC(await (opencascade as unknown as () => Promise<any>)());
const XY = { origin: [0, 0, 0] as [number, number, number], xDir: [1, 0, 0] as [number, number, number], normal: [0, 0, 1] as [number, number, number] };
const near = (a: number, b: number, tol = 1e-3) => Math.abs(a - b) < tol * Math.max(1, Math.abs(b));
const faceWith = (shape: Shape3D, pred: (n: number[], c: number[], t: string) => boolean) =>
  shape.faces.find(face => pred(face.normalAt().toTuple(), face.center.toTuple(), face.geomType))!;

const checks: [string, () => string][] = [
  ['box: offset top +5 keeps a box', () => {
    const box = makeBox([0, 0, 0], [20, 10, 10]) as Shape3D;
    const shape = offsetFace(box, faceWith(box, normal => normal[2] > 0.9), 5);
    if (!near(measureVolume(shape), 20 * 10 * 15) || shape.faces.length !== 6) {
      throw new Error(`vol ${measureVolume(shape)} faces ${shape.faces.length}`);
    }

    return `vol ${measureVolume(shape).toFixed(1)}, ${shape.faces.length} faces`;
  }],
  ['D-shape: flat face pushed out extends the round side', () => {
    // Half disc (radius 10) extruded; push the flat side outward by 3.
    const es: any[] = [{ id: 'l', kind: 'line', a: [-10, 0], b: [10, 0] }, { id: 'a', kind: 'arc', a: [10, 0], m: [0, 10], b: [-10, 0] }];
    const firstRegionFace = regionFaces(es, XY, arrangement(es).regions.map(regionRef))[0];
    const shape = basicFaceExtrusion(firstRegionFace, new Vector([0, 0, 5])) as Shape3D;
    const flat = faceWith(shape, (normal, _c, t) => t === 'PLANE' && normal[1] < -0.9);
    const result = offsetFace(shape, flat, 3);
    // Extending the arc downward by 3 (not a prism): faces stay 4, and the round face continues the circle.
    const round = result.faces.filter(face => face.geomType === 'CYLINDRE');
    if (result.faces.length !== 4 || round.length !== 1) {
      throw new Error(`${result.faces.length} faces, ${round.length} round`);
    }

    return `${result.faces.length} faces, vol ${measureVolume(result).toFixed(1)}`;
  }],
  ['cylinder radius 5 → 7', () => {
    const cylinder = makeCylinder(5, 10) as Shape3D;
    const shape = offsetFace(cylinder, faceWith(cylinder, (_n, _c, t) => t === 'CYLINDRE'), 2);
    if (!near(measureVolume(shape), Math.PI * 49 * 10, 2e-3)) {
      throw new Error(`vol ${measureVolume(shape)}`);
    }

    return `vol ${measureVolume(shape).toFixed(1)}`;
  }],
  ['hole radius 3 → 2 (offset +1 adds material)', () => {
    const plate = (makeBox([-10, -10, 0], [10, 10, 4]) as Shape3D).cut(makeCylinder(3, 4) as Shape3D);
    const wall = faceWith(plate, (_n, _c, t) => t === 'CYLINDRE');
    const shape = offsetFace(plate, wall, 1);
    if (!near(measureVolume(shape), 400 * 4 - Math.PI * 4 * 4, 2e-3)) {
      throw new Error(`vol ${measureVolume(shape)}`);
    }

    return `vol ${measureVolume(shape).toFixed(1)}`;
  }],
  ['delete a fillet face → sharp box', () => {
    const box = makeBox([0, 0, 0], [20, 10, 10]) as Shape3D;
    const fil = box.fillet(2, e => e.inDirection('Y').ofCurveType('LINE').containsPoint([20, 5, 10]));
    const ff = faceWith(fil, (_n, _c, t) => t === 'CYLINDRE');
    const shape = deleteFace(fil, ff);
    if (!near(measureVolume(shape), 2000)) {
      throw new Error(`vol ${measureVolume(shape)}, faces ${shape.faces.length}`);
    }

    return `vol ${measureVolume(shape).toFixed(1)}, ${shape.faces.length} faces`;
  }],
  ['delete an inside-corner fillet → sharp L again (no extra block)', () => {
    // L-shape: a 20×20×10 block with a 10×10 notch out of one corner, inner edge filleted.
    const shape = (makeBox([0, 0, 0], [20, 20, 10]) as Shape3D).cut(makeBox([10, 10, -1], [21, 21, 11]) as Shape3D);
    const fil = shape.fillet(3, e => e.inDirection('Z').containsPoint([10, 10, 5]));
    const before = measureVolume(shape);
    const ff = faceWith(fil, (_n, _c, t) => t === 'CYLINDRE');
    const result = deleteFace(fil, ff);
    if (!near(measureVolume(result), before)) {
      throw new Error(`vol ${measureVolume(result)} vs ${before} (filleted ${measureVolume(fil)})`);
    }

    return `vol ${measureVolume(result).toFixed(1)}, ${result.faces.length} faces`;
  }],
  ['delete a hole wall → solid plate', () => {
    const plate = (makeBox([-10, -10, 0], [10, 10, 4]) as Shape3D).cut(makeCylinder(3, 4) as Shape3D);
    const shape = deleteFace(plate, faceWith(plate, (_n, _c, t) => t === 'CYLINDRE'));
    if (!near(measureVolume(shape), 1600)) {
      throw new Error(`vol ${measureVolume(shape)}`);
    }

    return `vol ${measureVolume(shape).toFixed(1)}`;
  }],
  ['tilt the top face 10° about its edge', () => {
    const box = makeBox([0, 0, 0], [20, 10, 10]) as Shape3D;
    const a = (10 * Math.PI) / 180;
    // Plane through the top edge at x=0, tilted down towards +x.
    const shape = replaceFacePlane(box, faceWith(box, normal => normal[2] > 0.9), { origin: [0, 5, 10], normal: [Math.sin(a), 0, Math.cos(a)], xDir: [1, 0, 0] });
    const expect = 20 * 10 * 10 - 0.5 * 20 * (20 * Math.tan(a)) * 10;
    if (!near(measureVolume(shape), expect, 2e-3)) {
      throw new Error(`vol ${measureVolume(shape)} vs ${expect}`);
    }

    return `vol ${measureVolume(shape).toFixed(1)}, ${shape.faces.length} faces`;
  }],
  ['zigzag (inward corners): top offset ±3 and moved up 4 keep the whole outline', () => {
    const line = (id: string, a: number[], b: number[]) => ({ id, kind: 'line', a, b });
    const es: any[] = [line('1', [0, 0], [0, 50]), line('2', [0, 50], [20, 50]), line('3', [20, 50], [10, 40]), line('4', [10, 40], [20, 30]), line('5', [20, 30], [10, 20]), line('6', [10, 20], [20, 10]), line('7', [20, 10], [20, 0]), line('8', [20, 0], [0, 0])];
    const firstRegionFace = regionFaces(es, XY, arrangement(es).regions.map(regionRef))[0];
    const z = basicFaceExtrusion(firstRegionFace, new Vector([0, 0, 43])) as Shape3D;
    const top = () => faceWith(z, normal => normal[2] > 0.9);
    const up = offsetFace(z, top(), 3);
    const down = offsetFace(z, top(), -3);
    const moved = replaceFacePlane(z, top(), { origin: [0, 0, 47], xDir: [1, 0, 0], normal: [0, 0, 1] });
    const volumes = [up, down, moved].map(shape => measureVolume(shape));
    if (!near(volumes[0], 800 * 46) || !near(volumes[1], 800 * 40) || !near(volumes[2], 800 * 47)) {
      throw new Error(`volumes ${volumes.map(x => x.toFixed(0))}`);
    }

    return `volumes ${volumes.map(x => x.toFixed(0)).join(' / ')}`;
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
