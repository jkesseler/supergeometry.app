// Run: npx tsx tests/ductadapter.test.ts [out.json] - a square-to-round duct
// adapter: a 40 square on the floor lofted up to a circle 30 across on a plane
// 40 up, shelled 2 thick, open at both ends. Each step held to its size (the
// loft between the shapes it joins, the shell to its skin times its wall) and
// soundness.
import { readFileSync, writeFileSync } from 'node:fs';
import { measureArea, type Face, type Shape3D } from 'replicad';
import { measureVolume } from '../src/kernel/ocFree';
import { arrangement, regionRef } from '../src/sketch/regions';
import { after, bodies, check, circle, done, health, near, rect, sketch, XY } from './kit';
import type { FaceRef, Feature, SketchEntity, Vec3 } from '../src/doc/types';

const vol = (shape: Shape3D) => Math.abs(measureVolume(shape));
const body = (id: string) => bodies().get(id) as Shape3D;
const profileOf = (sk: string, es: SketchEntity[]) => ({ kind: 'profile' as const, sketch: sk, regions: arrangement(es).regions.map(regionRef) });
const ref = (id: string, face: Face): FaceRef => ({ body: id, center: face.center.toTuple() as Vec3, normal: face.normalAt().toTuple() as Vec3, area: measureArea(face) });
const faceOf = (id: string, pick: (f: Face) => boolean) => {
  const face = body(id).faces.find(pick); if (!face) {
    throw new Error(`no such face on ${id}`);
  }

  return ref(id, face); 
};
const PI = Math.PI;

const SIDE = 40; // the square: 40 x 40
const RADIUS = 15; // the circle: 30 across
const HEIGHT = 40; // 40 up
const THICKNESS = 2; // the wall

// ---------------------------------------------------------------- the loft
const sqEs = [rect('sq', -SIDE / 2, -SIDE / 2, SIDE / 2, SIDE / 2)], ciEs = [circle('ci', 0, 0, RADIUS)];
const top = { origin: [0, 0, HEIGHT] as Vec3, xDir: [1, 0, 0] as Vec3, normal: [0, 0, 1] as Vec3 };
const steps: Feature[] = [
  sketch('Square', XY(), sqEs),
  { id: 'Top', name: 'Plane', type: 'plane', plane: top, offset: HEIGHT } as Feature,
  sketch('Round', top, ciEs),
  { id: 'Duct', name: 'Loft', type: 'loft', sections: [profileOf('Square', sqEs), profileOf('Round', ciEs)], ruled: false, mode: 'new' } as Feature
];
let { errors } = await after(steps);
const vLoft = vol(body('Duct'));
// Between a straight blend of the two (the prismoidal sum, its middle the
// average outline) and the circle's cylinder up to the square's prism.
const Am = (SIDE * SIDE + PI * RADIUS * RADIUS) / 2; // about the middle's area
const blend = (HEIGHT / 6) * (SIDE * SIDE + 4 * Am + PI * RADIUS * RADIUS);
check('the loft: square to round, 40 tall', !errors.length && bodies().size === 1 && vLoft > PI * RADIUS * RADIUS * HEIGHT && vLoft < SIDE * SIDE * HEIGHT && Math.abs(vLoft - blend) < 0.05 * blend, [errors, vLoft, blend]);
const [[x0, y0, z0], [x1, y1, z1]] = body('Duct').boundingBox.bounds;
check('the loft: 40 square at the foot, 40 tall', near(x1 - x0, SIDE, 1e-3) && near(y1 - y0, SIDE, 1e-3) && near(z0, 0, 1e-6) && near(z1, HEIGHT, 1e-6), body('Duct').boundingBox.bounds);

// ---------------------------------------------------------------- the shell
const foot = faceOf('Duct', face => face.geomType === 'PLANE' && near(face.center.z, 0, 1e-6));
const mouth = faceOf('Duct', face => face.geomType === 'PLANE' && near(face.center.z, HEIGHT, 1e-6));
const skin = measureArea(body('Duct')) - SIDE * SIDE - PI * RADIUS * RADIUS;
steps.push({ id: 'Hollow', name: 'Shell', type: 'shell', body: 'Duct', faces: [foot, mouth], thickness: THICKNESS } as Feature);
({ errors } = await after(steps));
const vShell = vol(body('Duct'));
check('the shell: 2 thick, open at both ends', !errors.length && bodies().size === 1 && vShell > skin * THICKNESS * 0.9 && vShell < skin * THICKNESS * 1.05, [errors, vShell, skin * THICKNESS]);
const [[sx0, sy0, sz0], [sx1, sy1, sz1]] = body('Duct').boundingBox.bounds;
check('the shell: the same outside', near(sx1 - sx0, SIDE, 1e-3) && near(sy1 - sy0, SIDE, 1e-3) && near(sz0, 0, 1e-6) && near(sz1, HEIGHT, 1e-6), body('Duct').boundingBox.bounds);
// Open: only the two rims are flat, a thin ring each (wider than 2 across:
// the walls lean, and the rims cut them level).
const flats = body('Duct').faces.filter(face => face.geomType === 'PLANE');
check('the shell: open at both ends (two flat rims, thin)', flats.length === 2 && flats.every(flat => measureArea(flat) < 6 * SIDE * THICKNESS), flats.map(flat => measureArea(flat)));

const bodyHealth = health(body('Duct'), 'Duct');
check('the adapter: sound, one body', bodyHealth.healthy && bodies().size === 1, bodyHealth.healthy ? `${Math.round(bodyHealth.volume)} mm³` : bodyHealth);
const codeVol = vol(body('Duct'));
const codeFaces = body('Duct').faces.length;
const codeBox = body('Duct').boundingBox.bounds;
console.log('loft', vLoft.toFixed(1), 'blend', blend.toFixed(1), 'skin', skin.toFixed(1), 'final', codeVol.toFixed(1), 'faces', codeFaces);

// ---------------------------------------------- the adapter built by hand
// On a phone-sized screen (tests/fixtures/ductadapter-hand.json): Sketch from
// the top, a rectangle typed (X -20, Y -20, 40 x 40); Offset Plane, From XY
// on the options wheel (it was called "Kind" there: XY, XZ and YZ behind a
// name that said nothing), 40; Sketch, Plane 01 by name, a circle 30 across;
// Loft, the square then the circle; Shell, the top tapped, then the bottom
// from below (the thickness box stayed on the top, turned away and hidden:
// it goes on the face tapped last now), 2. It comes out the same.
{
  const hand = JSON.parse(readFileSync(new URL('./fixtures/ductadapter-hand.json', import.meta.url), 'utf8')).features as Feature[];
  const { errors } = await after(hand);
  check('by hand: no errors', errors.length === 0, errors);
  const shapesB = [...bodies().values()].map(body => body as Shape3D);
  check('by hand: one body, sound', shapesB.length === 1 && health(shapesB[0], 'hand').healthy, shapesB.length);
  check('by hand: the same adapter (to 0.1 %)', shapesB.length === 1 && Math.abs(vol(shapesB[0]) - codeVol) < codeVol * 1e-3, `${shapesB[0] ? vol(shapesB[0]).toFixed(1) : '-'} / ${codeVol.toFixed(1)}`);
  check('by hand: as many faces, the same box', shapesB[0]?.faces.length === codeFaces && shapesB[0].boundingBox.bounds.flat().every((x, i) => near(x, codeBox.flat()[i], 1e-3)), [shapesB[0]?.faces.length, codeFaces, shapesB[0]?.boundingBox.bounds]);
}

if (process.argv[2]) {
  writeFileSync(process.argv[2], JSON.stringify({ format: 'super', version: 2, name: 'Duct adapter', features: steps }));
}
done();
