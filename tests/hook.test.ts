// Run: npx tsx tests/hook.test.ts [out.json] - a headphone hook that clamps
// on a desk, with the extrude options the other build tests use least: the
// C-shaped clamp drawn on the front plane and pulled both ways at once
// (Symmetric); the arm drawn on the clamp's back and pulled Up to a plane
// set 50 out; a lip raised on the arm's end, its top edges rounded; a screw
// hole up through the clamp's lower jaw, threaded M6. Each step held to its
// size and soundness.
import { readFileSync, writeFileSync } from 'node:fs';
import { measureArea, type Shape3D } from 'replicad';
import { measureVolume } from '../src/kernel/ocFree';
import { arrangement, regionRef } from '../src/sketch/regions';
import { after, bodies, check, circle, done, health, near, poly, rect, sketch, XY, XZ } from './kit';
import type { EdgeRef, FaceRef, Feature, PlaneDef, SketchEntity, Vec3 } from '../src/doc/types';

const vol = (s: Shape3D) => Math.abs(measureVolume(s));
const body = (id: string) => bodies().get(id) as Shape3D;
const profileOf = (sk: string, es: SketchEntity[]) => ({ kind: 'profile' as const, sketch: sk, regions: arrangement(es).regions.map(regionRef) });
const unit = (v: number[]): Vec3 => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;

  return [v[0] / l, v[1] / l, v[2] / l]; 
};
const faceOf = (id: string, test: (c: Vec3, n: Vec3, f: any) => boolean): FaceRef => {
  const f: any = body(id).faces.find((f: any) => test(f.center.toTuple(), unit(f.normalAt().toTuple()), f));
  if (!f) {
    throw new Error('no such face');
  }

  return { body: id, center: f.center.toTuple(), normal: unit(f.normalAt().toTuple()), area: measureArea(f) } as FaceRef;
};
const edgesOf = (id: string, test: (m: Vec3, d: Vec3) => boolean): EdgeRef[] =>
  body(id).edges.filter(e => test(e.pointAt(0.5).toTuple() as Vec3, unit(e.tangentAt(0.5).toTuple()))).map(e => ({ body: id, mid: e.pointAt(0.5).toTuple() as Vec3, dir: e.tangentAt(0.5).toTuple() as Vec3, length: e.length }));

const JAW = 40, T = 6, DESK = 25, WIDE = 30; // the clamp: jaws 40 long, 6 thick, a 25 desk between, 30 wide
const ARM = 50, AW = 20, AH = 12; // the arm: 50 out from the clamp's back, 20 wide, 12 high (level with the top)
const LIP = 6, LIPH = 10, ROUND = 2, HOLE = 3, PITCH = 1;
const TOP = DESK + 2 * T;

// ----------------------------------------------------------------- the clamp
// A C on the front plane (x along, z up), opening towards +x; pulled 15 each way.
const clampEs = [poly('c', [[0, 0], [JAW, 0], [JAW, T], [T, T], [T, T + DESK], [JAW, T + DESK], [JAW, TOP], [0, TOP]])];
const steps: Feature[] = [sketch('Clamp', XZ(), clampEs), { id: 'Hook', name: 'Hook', type: 'extrude', source: profileOf('Clamp', clampEs), distance: WIDE / 2, symmetric: true, mode: 'new' } as Feature];
let { errors } = await after(steps);
check('the clamp: no errors', !errors.length, errors);
const vClamp = vol(body('Hook'));
const clampArea = JAW * TOP - (JAW - T) * DESK;
check("the clamp: the C's area x 30", near(vClamp, clampArea * WIDE, 1e-6), [vClamp, clampArea * WIDE]);
const [[, y0], [, y1]] = body('Hook').boundingBox.bounds;
check('the clamp: 15 each side of the front plane (Symmetric)', near(y0, -WIDE / 2, 1e-6) && near(y1, WIDE / 2, 1e-6), body('Hook').boundingBox.bounds);

// ------------------------------------------------------------------- the arm
// A plane 50 out behind the clamp; the arm drawn on the clamp's back and pulled Up to it.
const out: PlaneDef = { origin: [-ARM, 0, 0], xDir: [0, 1, 0], normal: [-1, 0, 0] };
const back: PlaneDef = { origin: [0, 0, 0], xDir: [0, -1, 0], normal: [-1, 0, 0] };
// (On the back, x across is -y and up is z.)
const armEs = [rect('a', -AW / 2, TOP - AH, AW / 2, TOP)];
steps.push(
  { id: 'Out', name: 'Plane', type: 'plane', kind: 'offset', plane: out, offset: 0 } as Feature,
  sketch('Arm', back, armEs),
  { id: 'ArmOut', name: 'Extrude', type: 'extrude', source: profileOf('Arm', armEs), distance: 1, extent: 'to', to: { plane: out }, mode: 'join', target: 'Hook' } as Feature
);
({ errors } = await after(steps));
check('the arm: no errors', !errors.length, errors);
const vArm = vol(body('Hook')) - vClamp;
check('the arm: 20 x 12, out 50 to the plane', near(vArm, AW * AH * ARM, 1e-6), vArm);
const [[ax0, , az0], [, , az1]] = body('Hook').boundingBox.bounds;
check("the arm: its end on the plane, its top level with the clamp's", near(ax0, -ARM, 1e-6) && near(az0, 0, 1e-6) && near(az1, TOP, 1e-6), body('Hook').boundingBox.bounds);

// -------------------------------------------------------------------- the lip
// On the arm's top at its end, 6 deep, raised 10; its top edges rounded 2.
const lipEs = [rect('l', -ARM, -AW / 2, -ARM + LIP, AW / 2)];
steps.push(sketch('Lip', XY(TOP), lipEs), { id: 'LipUp', name: 'Extrude', type: 'extrude', source: profileOf('Lip', lipEs), distance: LIPH, mode: 'join', target: 'Hook' } as Feature);
({ errors } = await after(steps));
check('the lip: no errors', !errors.length, errors);
const vLip = vol(body('Hook')) - vClamp - vArm;
check('the lip: 6 x 20 x 10', near(vLip, LIP * AW * LIPH, 1e-6), vLip);
const lipTop = edgesOf('Hook', (m, d) => near(m[2], TOP + LIPH, 1e-6) && Math.abs(d[1]) > 0.99);
steps.push({ id: 'LipRound', name: 'Fillet', type: 'fillet', edges: lipTop, radius: ROUND } as Feature);
({ errors } = await after(steps));
check("the lip's top: rounded, no errors, both edges", !errors.length && lipTop.length === 2, [errors, lipTop.length]);
const vRound = vol(body('Hook'));
check("the lip's top: two rounds 2 off, 20 long", near(vClamp + vArm + vLip - vRound, 2 * (1 - Math.PI / 4) * ROUND * ROUND * AW, 1e-3), vClamp + vArm + vLip - vRound);

// --------------------------------------------------------------- the screw hole
// Up through the lower jaw from below, 20 in and on the middle; then threaded, 1 mm a turn.
const holeEs = [circle('h', JAW / 2, 0, HOLE)];
steps.push(sketch('Screw', XY(), holeEs), { id: 'ScrewHole', name: 'Extrude', type: 'extrude', source: profileOf('Screw', holeEs), distance: T, mode: 'cut', target: 'Hook' } as Feature);
({ errors } = await after(steps));
check('the hole: no errors', !errors.length, errors);
const vHole = vol(body('Hook'));
check('the hole: 6 round through the 6 thick jaw', near(vRound - vHole, Math.PI * HOLE * HOLE * T, 1e-3), vRound - vHole);
steps.push({ id: 'ScrewThread', name: 'Thread', type: 'thread', face: faceOf('Hook', (c, _n, f) => near(Math.hypot(c[0] - JAW / 2, c[1]), 0, 0.5) && near(c[2], T / 2, 0.5) && f.geomType === 'CYLINDRE'), pitch: PITCH, round: { r: HOLE, hole: true } } as Feature);
({ errors } = await after(steps));
check('the thread: no errors', !errors.length, errors);
const vThread = vol(body('Hook'));
check("the thread: cut into the hole's wall (a little less, many more faces)", vThread < vHole && vThread > vHole - Math.PI * ((HOLE + PITCH) ** 2 - HOLE ** 2) * T && body('Hook').faces.length > 20, [vHole - vThread, body('Hook').faces.length]);

const h = health(body('Hook'), 'Hook');
check('the hook: sound, one body', h.healthy && bodies().size === 1, h.healthy ? `${Math.round(h.volume)} mm³` : h);
const codeVol = vol(body('Hook'));
const codeFaces = body('Hook').faces.length;
console.log('clamp', vClamp, 'arm', vArm.toFixed(1), 'lip', vLip.toFixed(1), 'round', vRound.toFixed(1), 'hole', vHole.toFixed(1), 'final', codeVol.toFixed(1), 'faces', codeFaces);

// ------------------------------------------------- the hook built by hand
// On a phone-sized screen (tests/fixtures/hook-hand.json): the C drawn on the
// front, pulled Symmetric 15 each side; a Plane 50 out; the arm drawn on the
// clamp's back and pulled Up to it; the lip drawn on the arm's top and raised
// 10, its top edges rounded 2; a circle 6 across on the jaw's underside, cut
// 6; the hole's wall threaded (it named it M7 x 1). It comes out the same.
{
  const hand = JSON.parse(readFileSync(new URL('./fixtures/hook-hand.json', import.meta.url), 'utf8')).features as Feature[];
  const { errors } = await after(hand);
  check('by hand: no errors', errors.length === 0, errors);
  const H = [...bodies().values()].map(s => s as Shape3D);
  check('by hand: one body, sound', H.length === 1 && health(H[0], 'hand').healthy, H.length);
  check('by hand: the same hook (to 0.1 %)', H.length === 1 && Math.abs(vol(H[0]) - codeVol) < codeVol * 1e-3, `${H[0] ? vol(H[0]).toFixed(1) : '-'} / ${codeVol.toFixed(1)}`);
  check('by hand: as many faces', H[0]?.faces.length === codeFaces, [H[0]?.faces.length, codeFaces]);
}

if (process.argv[2]) {
  writeFileSync(process.argv[2], JSON.stringify({ format: 'super', version: 2, name: 'Headphone hook', features: steps }));
}
done();
