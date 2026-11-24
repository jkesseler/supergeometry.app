// Run: npx tsx tests/phonestand.test.ts [out.json] - a phone stand, with the
// tools the other build tests leave out: a back leaning at 75° on a plane
// through the base's back edge at an angle; a lip along the front, its
// line drawn parallel to the front edge (Offset Edge) and the strip raised
// (Offset Face); a cable hole cut through the tilted back; the lip's top
// edges chamfered and the back's top rounded. Each held to its size and
// soundness.
import { readFileSync, writeFileSync } from 'node:fs';
import { getOC, makeBox, type Shape3D } from 'replicad';
import { measureVolume } from '../src/kernel/ocFree';
import { arrangement, regionRef } from '../src/sketch/regions';
import { solve } from '../src/sketch/constraints';
import { after, bodies, check, circle, done, health, line, near, rect, sketch, XY } from './kit';
import type { EdgeRef, Feature, PlaneDef, SketchEntity, Vec3 } from '../src/doc/types';

const vol = (s: Shape3D) => Math.abs(measureVolume(s));
const stand0 = () => bodies().get('Stand') as Shape3D;
/** Solids in the stand (one: not two pieces meeting at an edge). */
const solids = () => countSolids(stand0());
function countSolids(s: Shape3D): number {
  const oc = getOC();
  const ex = new oc.TopExp_Explorer(s.wrapped, oc.TopAbs_ShapeEnum.TopAbs_SOLID, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
  let n = 0;
  for (; ex.More(); ex.Next()) {
    n++;
  }
  ex.delete();

  return n;
}
const W = 80, D = 70, T = 8, ANG = 75, BACK = 6, TALL = 90, LIP = 12, LIPH = 10;
const rad = (ANG * Math.PI) / 180;
const profileOf = (sk: string, es: SketchEntity[]) => ({ kind: 'profile' as const, sketch: sk, regions: arrangement(es).regions.map(regionRef) });
const edgeOf = (body: string, pick: (mid: Vec3, dir: Vec3) => boolean): EdgeRef => {
  const e = (bodies().get(body) as Shape3D).edges.find(e => pick(e.pointAt(0.5).toTuple() as Vec3, e.tangentAt(0.5).normalized().toTuple() as Vec3));
  if (!e) {
    throw new Error('no such edge');
  }

  return { body, mid: e.pointAt(0.5).toTuple() as Vec3, dir: e.tangentAt(0.5).toTuple() as Vec3, length: e.length };
};

// ------------------------------------------------------------------ the base
const baseEs = [rect('b', -W / 2, 0, W / 2, D)];
const steps: Feature[] = [sketch('Base', XY(), baseEs), { id: 'Stand', name: 'Stand', type: 'extrude', source: profileOf('Base', baseEs), distance: T, mode: 'new' } as Feature];
let { errors } = await after(steps);
check('the base: no errors', !errors.length, errors);
const vBase = vol(bodies().get('Stand') as Shape3D);
check('the base: 80 x 70 x 8', near(vBase, W * D * T, 1e-6), vBase);

// ------------------------------------------------------------------ the back
// A plane through the base's top back edge, 75° up from the top, leaning back
// (its up direction away from the front); on it, the back 80 wide, from 3
// below the edge (down into the base's corner, to hold on to it) to 90 up,
// pulled 6 thick towards the front. (Only touching the base along the edge,
// a join made two solids meeting at an edge - and called them sound.)
const up: Vec3 = [0, Math.cos(rad), Math.sin(rad)];
const tilted: PlaneDef = { origin: [0, D, T], xDir: [1, 0, 0], normal: [0, -Math.sin(rad), Math.cos(rad)] };
const backEs = [rect('k', -W / 2, -3, W / 2, TALL)];
steps.push(
  { id: 'Tilt', name: 'Plane', type: 'plane', kind: 'angle', plane: tilted, offset: 0 } as Feature,
  sketch('Back', tilted, backEs),
  { id: 'BackUp', name: 'Extrude', type: 'extrude', source: profileOf('Back', backEs), distance: BACK, mode: 'join', target: 'Stand' } as Feature
);
({ errors } = await after(steps));
check('the back: no errors', !errors.length, errors);
let stand = bodies().get('Stand') as Shape3D;
const vBack = vol(stand) - vBase;
// (A slab 80 x 93 x 6, less the wedge of it down in the base.)
check('the back: a slab 80 x 93 x 6 joined on (a little of it in the base)', vBack < W * 93 * BACK && vBack > W * 93 * BACK - W * 3 * BACK && bodies().size === 1 && (stand0() as any).wrapped && solids() === 1, [vBack, solids()]);
const [, [, by1, bz1]] = stand.boundingBox.bounds;
check('the back: leaning back 75° (its top 90 up the slope)', near(bz1, T + TALL * up[2] + BACK * Math.cos(rad), 0.01) && near(by1, D + TALL * up[1], 0.01), stand.boundingBox.bounds);

// Only touching (the back from the edge up, not into the base): joined in
// name, two pieces by any printer - said, and not sound.
{
  const touchEs = [rect('k', -W / 2, 0, W / 2, TALL)];
  const { r } = await after([...steps.slice(0, 3), sketch('Touch', tilted, touchEs), { id: 'BackUp', name: 'Extrude', type: 'extrude', source: profileOf('Touch', touchEs), distance: BACK, mode: 'join', target: 'Stand' } as Feature]);
  const h = health(stand0(), 'Stand');
  check('only touching along an edge: said, and not sound', !!r.notes?.some(n => /only touches the body along an edge/.test(n.message)) && !h.healthy && h.pinched > 0, [r.notes, h.pinched, h.solids]);
}
// A rectangle's height typed 93 (from 90, dimensioned): exactly 93, not 92.999999999999.
{
  const res = solve([{ id: 'q', kind: 'rect', center: [0, 45], w: 80, h: 90, rotation: 0 } as SketchEntity], [{ id: 'd1', type: 'dim', curves: ['q'], prop: 'w', value: 80 }, { id: 'd2', type: 'dim', curves: ['q'], prop: 'h', value: 93 }] as any);
  check('a height typed 93 comes out exactly 93', (res.entities[0] as any).h === 93 && (res.entities[0] as any).w === 80, (res.entities[0] as any).h);
}

// ------------------------------------------------------------------ the lip
// A line on the top 12 in from the front edge, and the strip in front of it raised 10.
const lipEs = [rect('l', -W / 2, 0, W / 2, LIP)];
steps.push(sketch('Lip line', XY(T), lipEs), { id: 'Lip', name: 'Offset Face', type: 'extrude', source: profileOf('Lip line', lipEs), distance: LIPH, mode: 'join', target: 'Stand' } as Feature);
({ errors } = await after(steps));
check('the lip: no errors', !errors.length, errors);
stand = bodies().get('Stand') as Shape3D;
const vLip = vol(stand) - vBase - vBack;
check('the lip: 80 x 12 x 10', near(vLip, W * LIP * LIPH, 1e-3), vLip);

// ------------------------------------------------------------- the cable hole
// A circle 8 round on the back's face, 30 up it, cut through the back.
const holeEs = [circle('h', 0, 30, 8)];
steps.push(sketch('Hole', tilted, holeEs), { id: 'Cable', name: 'Extrude', type: 'extrude', source: profileOf('Hole', holeEs), distance: 1, extent: 'through', mode: 'cut', target: 'Stand' } as Feature);
({ errors } = await after(steps));
check('the hole: no errors', !errors.length, errors);
stand = bodies().get('Stand') as Shape3D;
const vHole = vBase + vBack + vLip - vol(stand);
check('the hole: 8 round through the 6 thick back', near(vHole, Math.PI * 64 * BACK, 0.5), vHole);

// ---------------------------------------------------------------- the edges
// The lip's two top edges chamfered 2; the back's top edge (the front one) rounded 3.
const lipTop = (y: number) => edgeOf('Stand', (m, d) => near(m[2], T + LIPH, 1e-3) && near(m[1], y, 1e-3) && Math.abs(d[0]) > 0.99);
steps.push({ id: 'LipEdges', name: 'Chamfer', type: 'chamfer', edges: [lipTop(0), lipTop(LIP)], radius: 2 } as Feature);
({ errors } = await after(steps));
check("the lip's edges: chamfered, no errors", !errors.length, errors);
stand = bodies().get('Stand') as Shape3D;
const vCham = vol(stand);
check("the lip's edges: two corners 2 x 2 off, 80 long", near(vBase + vBack + vLip - vHole - vCham, 2 * 2 * 2 * 0.5 * W, 0.5), vBase + vBack + vLip - vHole - vCham);
const topFront: Vec3 = [0, D + TALL * up[1] - BACK * Math.sin(rad), T + TALL * up[2] + BACK * Math.cos(rad)];
steps.push({ id: 'TopRound', name: 'Fillet', type: 'fillet', edges: [edgeOf('Stand', (m, d) => Math.hypot(m[0] - topFront[0], m[1] - topFront[1], m[2] - topFront[2]) < 1e-3 && Math.abs(d[0]) > 0.99)], radius: 3 } as Feature);
({ errors } = await after(steps));
check("the back's top: rounded, no errors", !errors.length, errors);
stand = bodies().get('Stand') as Shape3D;
const vRound = vol(stand);
check("the back's top: a round 3 off along it (80 long)", near(vCham - vRound, (1 - Math.PI / 4) * 9 * W, 0.5), vCham - vRound);

const h = health(stand, 'Stand');
check('the stand: sound, one body', h.healthy && bodies().size === 1, h.healthy ? `${Math.round(h.volume)} mm³` : h);
const codeVol = vol(stand);
console.log('base', vBase, 'back', vBack.toFixed(1), 'lip', vLip.toFixed(1), 'hole', vHole.toFixed(1), 'final', codeVol.toFixed(1));

// ------------------------------------------------- the stand built by hand
// On a phone-sized screen (tests/fixtures/phonestand-hand.json): the base
// typed, a Plane at Angle through its top back edge (105°, leaning back), the
// back drawn on it and pulled 6 - first only touching the base (it said so:
// "only touches the body along an edge"), then its rectangle typed 93 high
// and moved 1.5 down into the base; Offset Edge 12 in from the front edge on
// the top and the strip raised 10; a circle on the back's face cut through
// all; the lip's top edges chamfered 2 and the back's top rounded 3. It comes
// out the same.
{
  const hand = JSON.parse(readFileSync(new URL('./fixtures/phonestand-hand.json', import.meta.url), 'utf8')).features as Feature[];
  const { errors } = await after(hand);
  check('by hand: no errors', errors.length === 0, errors);
  const H = [...bodies().values()].map(s => s as Shape3D);
  check('by hand: one body, sound', H.length === 1 && health(H[0], 'hand').healthy, H.length);
  check('by hand: the same stand (to 0.1 %)', H.length === 1 && Math.abs(vol(H[0]) - codeVol) < codeVol * 1e-3, `${H[0] ? vol(H[0]).toFixed(1) : '-'} / ${codeVol.toFixed(1)}`);
  const hb = H[0]?.boundingBox.bounds;
  check('by hand: the same box', !!hb && hb.flat().every((x, i) => near(x, stand.boundingBox.bounds.flat()[i], 1e-3)), [hb, stand.boundingBox.bounds]);
}

if (process.argv[2]) {
  writeFileSync(process.argv[2], JSON.stringify({ format: 'super', version: 2, name: 'Phone stand', features: steps }));
}
done();
