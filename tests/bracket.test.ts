// Run: npx tsx tests/bracket.test.ts [out.json] - an L bracket: its side drawn
// on the side plane and pulled out both ways; the inside corner rounded; a
// gusset drawn on one side, mirrored to the other and joined; two slots in
// the foot (a box and two circles each) and a round hole in the upright cut
// through; the outer corners rounded. Each step held to its size and soundness.
import { readFileSync, writeFileSync } from 'node:fs';
import { measureVolume } from '../src/kernel/ocFree';
import { arrangement, regionRef } from '../src/sketch/regions';
import { after, bodies, check, circle, done, health, near, poly, rect, sketch, XY, YZ, plane } from './kit';
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

const HALF_WIDTH = 20, FOOT = 60, UPR = 50, THICKNESS = 5; // half the width; the foot's length; the upright's height; the plate
const IN = 5; // the inside corner's round
const G0 = 14, GT = 4, GL = 30; // the gusset: from x 14, 4 thick, its legs 30 along
const SX = 8, SY0 = 30, SY1 = 45, SR = 2.5; // the slots: x ±8, from y 30 to 45, 5 wide
const HZ = 32, HR = 4; // the upright's hole
const OUT = 6; // the outer corners

// ---------------------------------------------------------------- the L
// Its side on the side plane (y along, z up), pulled out 20 both ways.
const sideEs = [poly('L', [[0, 0], [FOOT, 0], [FOOT, THICKNESS], [THICKNESS, THICKNESS], [THICKNESS, UPR], [0, UPR]])];
const steps: Feature[] = [sketch('Side', YZ(), sideEs), { id: 'Bracket', name: 'Extrude', type: 'extrude', source: profileOf('Side', sideEs), distance: HALF_WIDTH, symmetric: true, mode: 'new' } as Feature];
let { errors } = await after(steps);
check('the L: no errors', !errors.length, errors);
const vL = vol(body('Bracket'));
check('the L: 60 x 50, 5 thick, 40 wide', near(vL, (FOOT * THICKNESS + (UPR - THICKNESS) * THICKNESS) * 2 * HALF_WIDTH, 1e-6), vL);

// ------------------------------------------------------------- the corner
const inner = edgesOf('Bracket', (midpoint, direction) => Math.abs(direction[0]) > 0.99 && near(midpoint[1], THICKNESS) && near(midpoint[2], THICKNESS));
steps.push({ id: 'Inside', name: 'Fillet', type: 'fillet', edges: inner, radius: IN } as Feature);
({ errors } = await after(steps));
const vIn = vol(body('Bracket'));
check('the inside corner: rounded 5', !errors.length && inner.length === 1 && near(vIn - vL, (1 - Math.PI / 4) * IN * IN * 2 * HALF_WIDTH, 1e-6), [errors, inner.length, vIn - vL]);

// ------------------------------------------------------------- the gussets
// A triangle on the side plane moved out to x 14, pulled 4; mirrored across the middle (a copy) and both joined on.
const gusEs = [poly('g', [[THICKNESS, THICKNESS], [THICKNESS + GL, THICKNESS], [THICKNESS, THICKNESS + GL]])];
steps.push(
  sketch('Gusset', YZ(G0), gusEs),
  { id: 'Rib', name: 'Extrude', type: 'extrude', source: profileOf('Gusset', gusEs), distance: GT, mode: 'new' } as Feature,
  { id: 'Mirror', name: 'Mirror', type: 'transform', bodies: ['Rib'], copy: true, op: { kind: 'mirror', plane: YZ() } } as Feature
);
({ errors } = await after(steps));
check('the gussets: two, no errors', !errors.length && bodies().size === 3, [errors, [...bodies().keys()]]);
const ribIds = [...bodies().keys()].filter(bodyId => bodyId !== 'Bracket');
const [[rx0], [rx1]] = [body(ribIds[0]).boundingBox.bounds[0], body(ribIds[1]).boundingBox.bounds[0]].sort((a, b) => a[0] - b[0]);
check('the gussets: at x -18 and 14', near(rx0, -G0 - GT, 1e-6) && near(rx1, G0, 1e-6), [rx0, rx1]);
steps.push({ id: 'Join', name: 'Join', type: 'boolean', op: 'union', target: 'Bracket', tools: ribIds } as Feature);
({ errors } = await after(steps));
const vG = vol(body('Bracket'));
// Each triangle less the bit of it inside the corner's round: (1 - π/4)·r² of it is filled there already.
const tri = (GL * GL) / 2 - (1 - Math.PI / 4) * IN * IN;
check('the gussets: joined on, one body', !errors.length && bodies().size === 1 && near(vG - vIn, 2 * tri * GT, 1e-3), [errors, bodies().size, vG - vIn, 2 * tri * GT]);

// ---------------------------------------------------------------- the holes
// On the foot's top: each slot a box with a circle at either end; cut through.
const slot = (id: string, x: number) => [rect(`${id}b`, x - SR, SY0, x + SR, SY1), circle(`${id}a`, x, SY0, SR), circle(`${id}c`, x, SY1, SR)];
const slotEs = [...slot('l', -SX), ...slot('r', SX)];
steps.push(sketch('Slots', XY(THICKNESS), slotEs), { id: 'SlotCut', name: 'Extrude', type: 'extrude', source: profileOf('Slots', slotEs), distance: -1, extent: 'through', mode: 'cut', target: 'Bracket' } as Feature);
({ errors } = await after(steps));
const vS = vol(body('Bracket'));
const slotArea = 2 * SR * (SY1 - SY0) + Math.PI * SR * SR;
check("the slots: two, 5 wide, 15 between the ends' centres, through", !errors.length && near(vG - vS, 2 * slotArea * THICKNESS, 1e-3), [errors, vG - vS, 2 * slotArea * THICKNESS]);
// On the upright's back: a round hole, cut through.
const holeEs = [circle('h', 0, HZ, HR)];
steps.push(sketch('Hole', plane([0, 0, 0], [0, -1, 0], [1, 0, 0]), holeEs));
steps.push({ id: 'HoleCut', name: 'Extrude', type: 'extrude', source: profileOf('Hole', holeEs), distance: -1, extent: 'through', mode: 'cut', target: 'Bracket' } as Feature);
({ errors } = await after(steps));
const vH = vol(body('Bracket'));
check('the hole: 8 round, through the upright', !errors.length && near(vS - vH, Math.PI * HR * HR * THICKNESS, 1e-3), [errors, vS - vH]);

// ---------------------------------------------------------- the outer corners
// The foot's two far corners (upright edges) and the upright's two top ones (edges along y), rounded 6.
const outer = edgesOf('Bracket', (midpoint, direction) => (Math.abs(direction[2]) > 0.99 && near(midpoint[1], FOOT) && near(Math.abs(midpoint[0]), HALF_WIDTH)) || (Math.abs(direction[1]) > 0.99 && near(midpoint[2], UPR) && near(Math.abs(midpoint[0]), HALF_WIDTH)));
steps.push({ id: 'Corners', name: 'Fillet', type: 'fillet', edges: outer, radius: OUT } as Feature);
({ errors } = await after(steps));
const vC = vol(body('Bracket'));
check('the outer corners: four, rounded 6', !errors.length && outer.length === 4 && near(vH - vC, 4 * (1 - Math.PI / 4) * OUT * OUT * THICKNESS, 1e-3), [errors, outer.length, vH - vC]);

const bodyHealth = health(body('Bracket'), 'Bracket');
check('the bracket: sound, one body', bodyHealth.healthy && bodies().size === 1, bodyHealth.healthy ? `${Math.round(bodyHealth.volume)} mm³` : bodyHealth);
const codeVol = vol(body('Bracket'));
const codeFaces = body('Bracket').faces.length;
const codeBox = body('Bracket').boundingBox.bounds;
check('the bracket: 40 x 60 x 50', near(codeBox[0][0], -HALF_WIDTH) && near(codeBox[1][0], HALF_WIDTH) && near(codeBox[0][1], 0) && near(codeBox[1][1], FOOT) && near(codeBox[0][2], 0) && near(codeBox[1][2], UPR), codeBox);
console.log('L', vL.toFixed(1), 'inside', vIn.toFixed(1), 'gussets', vG.toFixed(1), 'slots', vS.toFixed(1), 'hole', vH.toFixed(1), 'final', codeVol.toFixed(1), 'faces', codeFaces);

// ---------------------------------------------- the bracket built by hand
// On a phone-sized screen (tests/fixtures/bracket-hand.json): the L's six
// sides typed as lengths and angles on the side plane, pulled out 20 each
// side; the inside corner tapped and rounded 5; an Offset Plane 14 out, the
// gusset's corner typed and its two sides typed (Enter dropped the shape when
// the first point had been typed, before), a New body 4, mirrored (Copy)
// across YZ, the three tapped and joined; on the foot a rectangle and two
// circles typed, Mirror tapped and the three shapes, then the axis (the
// rectangle's width label under its edge took the circle's tap and let the
// shapes go; the axis tap, zoomed out, let the slot go - before), All shapes
// cut Through all; the hole on the upright's back, Through all; the four
// outer corners picked from both sides and rounded 6. It comes out the same.
{
  const hand = JSON.parse(readFileSync(new URL('./fixtures/bracket-hand.json', import.meta.url), 'utf8')).features as Feature[];
  const { errors } = await after(hand);
  check('by hand: no errors', errors.length === 0, errors);
  const shapes = [...bodies().values()].map(body => body as Shape3D);
  check('by hand: one body, sound', shapes.length === 1 && health(shapes[0], 'hand').healthy, shapes.length);
  check('by hand: the same bracket (to 0.1 %)', shapes.length === 1 && Math.abs(vol(shapes[0]) - codeVol) < codeVol * 1e-3, `${shapes[0] ? vol(shapes[0]).toFixed(1) : '-'} / ${codeVol.toFixed(1)}`);
  check('by hand: as many faces, the same box', shapes[0]?.faces.length === codeFaces && shapes[0].boundingBox.bounds.flat().every((x, i) => near(x, codeBox.flat()[i], 1e-3)), [shapes[0]?.faces.length, codeFaces, shapes[0]?.boundingBox.bounds]);
}

if (process.argv[2]) {
  writeFileSync(process.argv[2], JSON.stringify({ format: 'super', version: 2, name: 'Bracket', features: steps }));
}
done();
