// Run: npx tsx tests/knob.test.ts [out.json] - a cabinet knob: a stem 12
// across and 10 tall under a cap 30 across and 8 thick, drawn on the front
// plane and revolved round Z; the inside corner where they meet rounded 2;
// twelve grip notches round the cap's rim (one circle 4 across on its edge,
// the rest a circular pattern of it), cut through. Each step held to its size
// (the round by Pappus, the notches by the lens two circles share) and
// soundness.
import { readFileSync, writeFileSync } from 'node:fs';
import { measureVolume } from '../src/kernel/ocFree';
import { arrangement, regionRef } from '../src/sketch/regions';
import { after, bodies, check, circle, done, health, near, poly, sketch, XY, XZ } from './kit';
import type { Shape3D } from 'replicad';
import type { EdgeRef, Feature, SketchEntity, Vec3 } from '../src/doc/types';

const vol = (shape: Shape3D) => Math.abs(measureVolume(shape));
const body = (id: string) => bodies().get(id) as Shape3D;
const profileOf = (sk: string, es: SketchEntity[]) => ({ kind: 'profile' as const, sketch: sk, regions: arrangement(es).regions.map(regionRef) });
const unit = (vector: number[]): Vec3 => {
  const length = Math.hypot(vector[0], vector[1], vector[2]) || 1;

  return [vector[0] / length, vector[1] / length, vector[2] / length]; 
};
const edgesOf = (id: string, test: (m: Vec3, d: Vec3, len: number) => boolean): EdgeRef[] =>
  body(id).edges.filter(e => test(e.pointAt(0.5).toTuple() as Vec3, unit(e.tangentAt(0.5).toTuple()), e.length)).map(e => ({ body: id, mid: e.pointAt(0.5).toTuple() as Vec3, dir: e.tangentAt(0.5).toTuple() as Vec3, length: e.length }));
const Z_AXIS = { origin: [0, 0, 0] as Vec3, dir: [0, 0, 1] as Vec3 };
const PI = Math.PI;

const RS = 6, HS = 10; // the stem: 12 across, 10 tall
const RC = 15, HC = 8; // the cap: 30 across, 8 thick
const FILLET = 2; // the inside corner's round
const RN = 2, NOTCHES = 12; // the notches: 4 across, twelve, centred on the rim

// ---------------------------------------------------------------- the knob
const secEs = [poly('sec', [[0, 0], [RS, 0], [RS, HS], [RC, HS], [RC, HS + HC], [0, HS + HC]])];
const steps: Feature[] = [sketch('Section', XZ(), secEs), { id: 'Knob', name: 'Revolve', type: 'revolve', source: profileOf('Section', secEs), axis: Z_AXIS, angle: 360, mode: 'new' } as Feature];
let { errors } = await after(steps);
const vRev = vol(body('Knob'));
check('the knob: a stem 12 x 10 under a cap 30 x 8', !errors.length && near(vRev, PI * (RS * RS * HS + RC * RC * HC), 1e-6), [errors, vRev]);

// ------------------------------------------------------------ the inside corner
// Where the stem meets the cap's underside, rounded 2: the corner's spandrel
// ((1 - π/4)·r²) turned round Z, its middle (10 - 3π)/(12 - 3π)·r out from the stem.
const corner = edgesOf('Knob', midpoint => near(midpoint[2], HS, 1e-6) && near(Math.hypot(midpoint[0], midpoint[1]), RS, 1e-6));
steps.push({ id: 'Neck', name: 'Fillet', type: 'fillet', edges: corner, radius: FILLET } as Feature);
({ errors } = await after(steps));
const vNeck = vol(body('Knob'));
const added = 2 * PI * (RS + ((10 - 3 * PI) / (12 - 3 * PI)) * FILLET) * (1 - PI / 4) * FILLET * FILLET;
check('the inside corner: rounded 2 (Pappus)', !errors.length && corner.length >= 1 && near(vNeck - vRev, added, 1e-4), [errors, corner.length, vNeck - vRev, added]);

// ---------------------------------------------------------------- the notches
// Each takes the lens a circle 2 round on the rim shares with the cap, 8 deep.
const lens = (bigRadius: number, smallRadius: number, distance: number) =>
  smallRadius * smallRadius * Math.acos((distance * distance + smallRadius * smallRadius - bigRadius * bigRadius) / (2 * distance * smallRadius)) + bigRadius * bigRadius * Math.acos((distance * distance + bigRadius * bigRadius - smallRadius * smallRadius) / (2 * distance * bigRadius)) - 0.5 * Math.sqrt((-distance + smallRadius + bigRadius) * (distance + smallRadius - bigRadius) * (distance - smallRadius + bigRadius) * (distance + smallRadius + bigRadius));
const notchEs = Array.from({ length: NOTCHES }, (_, i) => circle(`n${i}`, RC * Math.cos((2 * PI * i) / NOTCHES), RC * Math.sin((2 * PI * i) / NOTCHES), RN));
steps.push(sketch('Grip', XY(HS + HC), notchEs), { id: 'Notches', name: 'Extrude', type: 'extrude', source: profileOf('Grip', notchEs), distance: -1, extent: 'through', mode: 'cut', target: 'Knob' } as Feature);
({ errors } = await after(steps));
const vNotch = vol(body('Knob'));
check('the notches: twelve round the rim, through the cap', !errors.length && bodies().size === 1 && near(vNeck - vNotch, NOTCHES * lens(RC, RN, RC) * HC, 1e-3), [errors, vNeck - vNotch, NOTCHES * lens(RC, RN, RC) * HC]);
const [[bx0, , bz0], [bx1, , bz1]] = body('Knob').boundingBox.bounds;
// (A notch at 0° takes the rim off where X is greatest: between notches it's still 15 out.)
check('the knob: 18 tall, the rim notched where X is greatest', bx1 < RC && bx1 > RC * Math.cos(PI / NOTCHES) - 1e-3 && near(bx0, -bx1, 1e-6) && near(bz1 - bz0, HS + HC, 1e-4), body('Knob').boundingBox.bounds);

const bodyHealth = health(body('Knob'), 'Knob');
check('the knob: sound, one body', bodyHealth.healthy && bodies().size === 1, bodyHealth.healthy ? `${Math.round(bodyHealth.volume)} mm³` : bodyHealth);
const codeVol = vol(body('Knob'));
const codeFaces = body('Knob').faces.length;
const codeBox = body('Knob').boundingBox.bounds;
console.log('revolve', vRev.toFixed(1), 'neck', vNeck.toFixed(1), 'final', codeVol.toFixed(1), 'faces', codeFaces);

// ---------------------------------------------- the knob built by hand
// On a phone-sized screen (tests/fixtures/knob-hand.json): Sketch, More →
// Other plane, XZ (front) by name; the section tapped as one outline (the
// grid took 6 as 5 and 18 as 20), then its sizes typed: the bottom 6, the
// cap's side 8, the stem's side 10 (a side typed with both its ends free
// moves both: the stem went to 11 until it had a size of its own); Revolve
// round its left line; Fillet, the inside corner from below, 2; Sketch on
// the top, a circle at X 15 Y 0, 4 across, Pattern → Circular round the
// middle, 12; Extrude, All shapes (24: the rim splits each circle), Through
// all. It comes out the same.
{
  const hand = JSON.parse(readFileSync(new URL('./fixtures/knob-hand.json', import.meta.url), 'utf8')).features as Feature[];
  const { errors } = await after(hand);
  check('by hand: no errors', errors.length === 0, errors);
  const shapesB = [...bodies().values()].map(body => body as Shape3D);
  check('by hand: one body, sound', shapesB.length === 1 && health(shapesB[0], 'hand').healthy, shapesB.length);
  check('by hand: the same knob (to 0.1 %)', shapesB.length === 1 && Math.abs(vol(shapesB[0]) - codeVol) < codeVol * 1e-3, `${shapesB[0] ? vol(shapesB[0]).toFixed(1) : '-'} / ${codeVol.toFixed(1)}`);
  check('by hand: as many faces, the same box', shapesB[0]?.faces.length === codeFaces && shapesB[0].boundingBox.bounds.flat().every((x, i) => near(x, codeBox.flat()[i], 1e-3)), [shapesB[0]?.faces.length, codeFaces, shapesB[0]?.boundingBox.bounds]);
}

if (process.argv[2]) {
  writeFileSync(process.argv[2], JSON.stringify({ format: 'super', version: 2, name: 'Cabinet knob', features: steps }));
}
done();
