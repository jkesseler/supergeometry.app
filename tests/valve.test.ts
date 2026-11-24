// Run: npx tsx tests/valve.test.ts [out.json] - a 1" brass ball valve at full
// size, the geometry engine's stress test. Chosen for what's hard to model:
//   Body: a ball-shaped middle on two round ends (a sphere meeting cylinders,
//     the creases rounded), hex flats cut into the ends, a stem boss on top
//     (a cylinder rising out of the sphere, rounded where they meet); cored -
//     a seat pocket, the flow bore, M33 threads inside both ends, the stem
//     hole; an M18 thread up the boss (a face that ends in a fillet); split
//     in two where the end piece screws in (right next to a rounded crease);
//     an imported (STL) flow arrow, repaired and joined onto a hex flat.
//   Ball: a sphere, bored, its top and bottom split off and thrown away, a
//     slot for the stem's tang; a vent hole drilled, then plugged again
//     (Delete faces).
//   Seats: rings with the ball's own shape cut out of them, mirrored.
//   Stem: turned (revolved), a tang, flats for the lever, an M8 thread over
//     the flats; its nut (hex, M8 inside, chamfered); the gland nut on the
//     boss (hex, M18 inside, notches patterned round the stem's axis).
//   Lever: swept along a bending path, a hub joined on, a double-D hole made
//     from the stem itself, OPEN lettering, its end pushed out and narrowed,
//     its bottom brought down onto a plane; a vinyl sleeve lofted between two
//     planes square to the path, hollowed, grooves patterned along it, a
//     freeform cap filled down to the sleeve's tilted end plane; the whole
//     handle turned a quarter round the stem's axis (parallel to the pipe:
//     open).
// x runs along the pipe, z up the stem; the ball's centre is at the origin.
import { readFileSync, writeFileSync } from 'node:fs';
import opencascade from 'replicad-opencascadejs';
import { getOC, makeVertex, measureArea, measureVolume, setOC } from 'replicad';
import opentype from 'opentype.js';
const { parse } = opentype as any;
import { debugBodies, regenerate } from '../src/kernel/engine';
import { healthOf, isHealthy } from '../src/kernel/repair';
import { arrangement, regionRef } from '../src/sketch/regions';
import { textOutlines } from '../src/sketch/textLayout';
import { resolveDoc } from '../src/doc/params';
import type { PlaneDef, Vec3 } from '../src/doc/types';

setOC(await (opencascade as unknown as () => Promise<any>)());
let failed = 0;
const check = (name: string, ok: boolean, info = '') => {
  if (!ok) {
    failed++;
  }
  console.log(ok ? 'ok  ' : 'FAIL', name, info);
};

type P2 = [number, number];
const XY = (z = 0): PlaneDef => ({ origin: [0, 0, z], normal: [0, 0, 1], xDir: [1, 0, 0] }); // u = x, v = y
const XZ = (y = 0): PlaneDef => ({ origin: [0, y, 0], normal: [0, -1, 0], xDir: [1, 0, 0] }); // u = x, v = z
const YZ = (x = 0): PlaneDef => ({ origin: [x, 0, 0], normal: [1, 0, 0], xDir: [0, 1, 0] }); // u = y, v = z (extrudes go +x)
const PY = (y: number): PlaneDef => ({ origin: [0, y, 0], normal: [0, 1, 0], xDir: [-1, 0, 0] }); // u = -x, v = z
const all = (es: any[]) => arrangement(es).regions.map(regionRef);
const feats: any[] = [];
const variables = [
  { name: 'bore', expr: '22 mm' },
  { name: 'pitch', expr: '2 mm' }
];
const doc = () => {
  const doc: any = { format: 'super', version: 2, name: 'Ball valve', features: structuredClone(feats), variables, views: [], units: 'mm', hidden: [], pins: [], names: {} };
  const problems = resolveDoc(doc);
  if (problems.length) {
    console.log('problems:', problems);
  }

  return doc;
};
const sections: { name: string; from: number }[] = [];
const section = (name: string) => sections.push({ name, from: feats.length });
const nameOf = (fid: string) => feats.find(feature => feature.id === fid)?.name ?? fid;
const build = async (quiet = false) => {
  const result: any = await regenerate(doc().features);
  if (result.errors.length && !quiet) {
    console.log('errors:', result.errors.map((e: any) => `${nameOf(e.featureId)}: ${e.message}`).join('; '));
  }

  return result;
};
const stage = async (label: string) => {
  const t = Date.now();
  const result = await build();
  check(`${label} builds`, !result.errors.length, `${result.bodies.length} bodies, ${Date.now() - t} ms`);
  const bad = result.bodies.map((b: any) => b.id).filter((id: string) => bodyShape(id) && !isHealthy(healthOf(bodyShape(id))));
  check(`${label}: every body a clean solid`, !bad.length, bad.join(' '));

  return result;
};
const bodyShape = (body: string) => debugBodies().get(body) as any;
const unit = (vector: number[]): Vec3 => {
  const length = Math.hypot(vector[0], vector[1], vector[2]) || 1;

  return [vector[0] / length, vector[1] / length, vector[2] / length]; 
};
/** A face's normal at its middle, of length 1. */
const nrm = (face: any) => unit(face.normalAt().toTuple());
const faceRef = (body: string, face: any) => ({ body, center: face.center.toTuple() as Vec3, normal: nrm(face), area: measureArea(face) });
const facesWhere = (body: string, test: (f: any) => boolean) => {
  const fs = bodyShape(body).faces.filter(test);
  if (!fs.length) {
    throw new Error(`no such face on ${body}`);
  }

  return fs.map((face: any) => faceRef(body, face));
};
const faceBy = (body: string, test: (f: any) => boolean) => facesWhere(body, test)[0];
const edgeRef = (body: string, e: any) => ({ body, mid: e.pointAt(0.5).toTuple() as Vec3, dir: e.tangentAt(0.5).toTuple() as Vec3, length: e.length as number });
const edgesWhere = (body: string, test: (p: number[], e: any) => boolean) => {
  const es = bodyShape(body).edges.filter((e: any) => test(e.pointAt(0.5).toTuple(), e));
  if (!es.length) {
    throw new Error(`no such edge on ${body}`);
  }

  return es.map((e: any) => edgeRef(body, e));
};
/** A round face of `radius` (a cylinder; `inside`: a hole, its normal pointing at the axis). */
const roundFace = (body: string, radius: number, axis: Vec3, at: Vec3, inside: boolean) =>
  faceBy(body, (face: any) => {
    if (face.geomType !== 'CYLINDRE') {
      return false;
    }
    const center = face.center.toTuple();
    const offset = [center[0] - at[0], center[1] - at[1], center[2] - at[2]];
    const along = offset[0] * axis[0] + offset[1] * axis[1] + offset[2] * axis[2];
    const off = Math.hypot(offset[0] - along * axis[0], offset[1] - along * axis[1], offset[2] - along * axis[2]);
    if (off > 0.5) {
      return false;
    }
    // ...and near `at` along it (both ports are on one axis: the left port's thread went into the right one).
    if (Math.abs(along) > 3) {
      return false;
    }
    // Its radius, from a point on it.
    const point = face.pointOnSurface(0.5, 0.5).toTuple();
    const q = [point[0] - at[0], point[1] - at[1], point[2] - at[2]];
    const qa = q[0] * axis[0] + q[1] * axis[1] + q[2] * axis[2];
    const rr = Math.hypot(q[0] - qa * axis[0], q[1] - qa * axis[1], q[2] - qa * axis[2]);
    if (Math.abs(rr - radius) > 0.05) {
      return false;
    }
    const normal = face.normalAt(face.pointOnSurface(0.5, 0.5)).toTuple();
    const out = (normal[0] * (q[0] - qa * axis[0]) + normal[1] * (q[1] - qa * axis[1]) + normal[2] * (q[2] - qa * axis[2])) > 0;

    return out !== inside;
  });
const volumeOf = (body: string) => Math.abs(measureVolume(bodyShape(body)));
const box = (body: string) => bodyShape(body).boundingBox.bounds as [number[], number[]];
const overlap = (a: string, b: string) => {
  try {
    return Math.abs(measureVolume(bodyShape(a).clone().intersect(bodyShape(b).clone())));
  } catch {
    return -1;
  }
};
/**
 * The overlap counted point by point (6000 points spread through the box the
 * two share): the kernel's intersect of two meshing threads can be wrong - with
 * their free ends chamfered, the stem and its nut "overlapped" 34 mm³ where
 * not one point is in both.
 */
const sampledOverlap = (a: string, b: string): number => {
  const oc = getOC();
  const [boundsA, Bb] = [bodyShape(a).boundingBox.bounds, bodyShape(b).boundingBox.bounds];
  const lo = [0, 1, 2].map(axis => Math.max(boundsA[0][axis], Bb[0][axis]));
  const hi = [0, 1, 2].map(axis => Math.min(boundsA[1][axis], Bb[1][axis]));
  if (lo.some((value, axis) => value >= hi[axis])) {
    return 0;
  }
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const SAMPLES = 6000;
  const pts = Array.from({ length: SAMPLES }, () => lo.map((value, axis) => value + rnd() * (hi[axis] - value)) as Vec3);
  const inside = (id: string) => {
    const measure = new oc.BRepExtrema_DistShapeShape();
    measure.LoadS1(bodyShape(id).wrapped);
    const out = pts.map(q => (measure.LoadS2(makeVertex(q).wrapped), measure.Perform(), measure.IsDone() && measure.InnerSolution()));
    measure.delete();

    return out;
  };
  const ia = inside(a);
  const ib = inside(b);
  const both = ia.filter((isInA, i) => isInA && ib[i]).length;

  return (both / SAMPLES) * lo.reduce((product, low, axis) => product * (hi[axis] - low), 1);
};
const range = (count: number, nameAt: (k: number) => string) => Array.from({ length: count }, (_, index) => nameAt(index));
const sketch = (id: string, name: string, plane: PlaneDef, entities: any[]) => feats.push({ id, name, type: 'sketch', plane, entities });
const extrude = (id: string, name: string, plane: PlaneDef, entities: any[], distance: number, opts: any = {}) => {
  sketch(`s_${id}`, `${name} sketch`, plane, entities);
  feats.push({ id, name, type: 'extrude', source: { kind: 'profile', sketch: `s_${id}`, regions: opts.regions ?? all(entities) }, distance, mode: opts.mode ?? 'new', ...(opts.target ? { target: opts.target } : {}), ...(opts.exprs ? { exprs: opts.exprs } : {}) });
};
const revolve = (id: string, name: string, plane: PlaneDef, profile: any[], axis: { origin: Vec3; dir: Vec3 }, opts: any = {}) => {
  sketch(`s_${id}`, `${name} profile`, plane, profile);
  feats.push({ id, name, type: 'revolve', source: { kind: 'profile', sketch: `s_${id}`, regions: all(profile) }, axis, angle: 360, mode: opts.mode ?? 'new', ...(opts.target ? { target: opts.target } : {}) });
};
const union = (id: string, name: string, target: string, tools: string[]) => feats.push({ id, name, type: 'boolean', op: 'union', target, tools });
const subtract = (id: string, name: string, target: string, tools: string[], keepTools = false) => feats.push({ id, name, type: 'boolean', op: 'subtract', target, tools, keepTools });
const circle = (id: string, center: P2, radius: number) => ({ id, kind: 'circle', center: center, radius: radius });
const rect = (id: string, center: P2, width: number, height: number, rotation = 0) => ({ id, kind: 'rect', center: center, w: width, h: height, rotation });
const hexagon = (id: string, center: P2, acrossFlats: number, angle = 0) => ({ id, kind: 'polygon', center: center, radius: acrossFlats / Math.sqrt(3), sides: 6, angle });
const poly = (id: string, points: P2[]) => ({ id, kind: 'polyline', closed: true, points });
const line = (id: string, a: P2, b: P2) => ({ id, kind: 'line', a, b });
const arc = (id: string, a: P2, middle: P2, b: P2) => ({ id, kind: 'arc', a, m: middle, b });
const ellipse = (id: string, center: P2, rx: number, ry: number) => ({ id, kind: 'ellipse', center: center, rx, ry, rotation: 0 });
const X_AXIS = { origin: [0, 0, 0] as Vec3, dir: [1, 0, 0] as Vec3 };
const Z_AXIS = { origin: [0, 0, 0] as Vec3, dir: [0, 0, 1] as Vec3 };
const near = (a: number, b: number, tol = 1e-3) => Math.abs(a - b) < tol;

const END = 44; // the body's ends (x = ±44)
const R_END = 20.5; // the round ends
const R_BALL = 25; // the ball-shaped middle
const HEX_AF = 36; // the hex across its flats
const BOSS_TOP = 34;

// --- 1. Body: a ball-shaped middle on two round ends (revolved), the stem
// boss on top, the creases rounded, hex flats cut into the ends (one cutter,
// mirrored across the midplane).
section('Body');
const xc = Math.sqrt(R_BALL ** 2 - R_END ** 2); // where the ball meets the ends
revolve('body', 'Body', XZ(0), [
  line('b0', [-END, 0], [END, 0]),
  line('b1', [END, 0], [END, R_END]),
  line('b2', [END, R_END], [xc, R_END]),
  arc('b3', [xc, R_END], [0, R_BALL], [-xc, R_END]),
  line('b4', [-xc, R_END], [-END, R_END]),
  line('b5', [-END, R_END], [-END, 0])
], X_AXIS);
extrude('boss', 'Stem boss', XY(16), [circle('c', [0, 0], 9)], BOSS_TOP - 16, { mode: 'join', target: 'body' });
await stage('body and boss');
check('the boss rises out of the ball', near(box('body')[1][2], BOSS_TOP, 1e-2), `${box('body')[1][2].toFixed(3)}`);
// Round where the ball meets the ends, and where the boss rises out of it.
feats.push({ id: 'creases', name: 'Round the creases', type: 'fillet', edges: edgesWhere('body', point => near(Math.abs(point[0]), xc, 0.05)), radius: 3 });
feats.push({ id: 'bossRound', name: "Round the boss's foot", type: 'fillet', edges: edgesWhere('body', point => point[2] > 16 && point[2] < 24 && Math.hypot(point[0], point[1]) < 9.05 && Math.hypot(point[0], point[1]) > 8.95), radius: 2.5 });
await stage('rounded body');
feats.push({ id: 'pMid', name: 'Midplane', type: 'plane', plane: YZ(0), offset: 0, kind: 'mid' });
// The cutter: a square with the hex taken out, 14 deep at the +x end.
const hexCutter = [rect('r', [0, 0], 60, 60), hexagon('h', [0, 0], HEX_AF, 0)];
extrude('hexCut', 'Hex cutter', YZ(END - 14), hexCutter, 14, { regions: all(hexCutter).filter(regionRef => regionRef.a > 2000) });
feats.push({ id: 'hexMirror', name: 'Mirror the cutter', type: 'transform', bodies: ['hexCut'], copy: true, op: { kind: 'mirror', plane: YZ(0) } });
subtract('hexFlats', 'Hex flats', 'body', ['hexCut', 'hexMirror:hexCut:0']);
await stage('hex ends');
const flats = bodyShape('body').faces.filter((face: any) => face.geomType === 'PLANE' && Math.abs(Math.abs(face.center.toTuple()[0]) - (END - 7)) < 1 && Math.abs(Math.hypot(face.center.toTuple()[1], face.center.toTuple()[2]) - HEX_AF / 2) < 0.05);
check('six flats on each end (36 across)', flats.length === 12, `${flats.length}`);

// --- 2. Cored: the seat pocket (revolved cut), the flow bore, the thread
// bores at both ends, the stem hole; the bore mouths chamfered; M33 threads
// in the ends, an M18 thread up the boss.
section('Cored');
revolve('pocket', 'Seat pocket', XZ(0), [rect('p', [0, 8.25], 32, 16.5)], X_AXIS, { mode: 'cut', target: 'body' });
extrude('flow', 'Flow bore', YZ(-END), [circle('c', [0, 0], 11)], 2 * END, { mode: 'cut', target: 'body', exprs: { distance: '2*44 mm' } });
// The bore's size follows the variable.
feats.find(feature => feature.id === 's_flow').exprs = { 'entities.0.radius': 'bore/2' };
extrude('portL', 'Left port', YZ(-END), [circle('c', [0, 0], 15.5)], 16, { mode: 'cut', target: 'body' });
extrude('portR', 'Right port', YZ(END - 16), [circle('c', [0, 0], 15.5)], 16, { mode: 'cut', target: 'body' });
extrude('stemHole', 'Stem hole', XY(10), [circle('c', [0, 0], 5)], BOSS_TOP - 10, { mode: 'cut', target: 'body' });
await stage('cored body');
feats.push({ id: 'mouths', name: 'Chamfer the port mouths', type: 'chamfer', edges: edgesWhere('body', point => near(Math.abs(point[0]), END, 1e-3) && near(Math.hypot(point[1], point[2]), 15.5, 0.05)), radius: 1 });
await stage('chamfered mouths');
feats.push({ id: 'threadL', name: 'Thread the left port', type: 'thread', face: roundFace('body', 15.5, [1, 0, 0], [-36, 0, 0], true), pitch: 2, round: { r: 15.5, hole: true }, exprs: { pitch: 'pitch' } });
feats.push({ id: 'threadR', name: 'Thread the right port', type: 'thread', face: roundFace('body', 15.5, [1, 0, 0], [36, 0, 0], true), pitch: 2, round: { r: 15.5, hole: true }, exprs: { pitch: 'pitch' } });
await stage('threaded ports');
feats.push({ id: 'bossThread', name: 'Thread the boss', type: 'thread', face: roundFace('body', 9, [0, 0, 1], [0, 0, 28], false), pitch: 1.5, round: { r: 9, hole: false } });
await stage('threaded boss');
// The end piece screws in here: split right next to the rounded crease.
feats.push({ id: 'endPiece', name: 'End piece off', type: 'split', body: 'body', plane: { origin: [14, 0, 0], normal: [1, 0, 0], xDir: [0, 1, 0] } });
await stage('split body');
const endId = box('endPiece')[0][0] > 13 ? 'endPiece' : 'body';
const mainId = endId === 'endPiece' ? 'body' : 'endPiece';
check('the end piece is the +x side', box(endId)[0][0] > 13.99 && box(mainId)[1][0] < 14.01);

// --- 3. Ball: a sphere, bored, top and bottom split off and deleted, a slot
// for the stem's tang; a vent hole drilled through it and plugged again.
section('Ball');
const R_B = 15.8;
revolve('ball', 'Ball', XZ(0), [arc('a', [-R_B, 0], [0, R_B], [R_B, 0]), line('l', [R_B, 0], [-R_B, 0])], X_AXIS);
extrude('ballBore', 'Bore the ball', YZ(-20), [circle('c', [0, 0], 11)], 40, { mode: 'cut', target: 'ball' });
feats.push({ id: 'ballTop', name: 'Top off the ball', type: 'split', body: 'ball', plane: { origin: [0, 0, 13], normal: [0, 0, 1], xDir: [1, 0, 0] } });
feats.push({ id: 'ballBottom', name: 'Bottom off the ball', type: 'split', body: 'ball', plane: { origin: [0, 0, -13], normal: [0, 0, -1], xDir: [1, 0, 0] } });
await stage('ball split');
const capsOf = () => ['ball', 'ballTop', 'ballBottom'].filter(b => bodyShape(b) && (box(b)[1][2] - box(b)[0][2]) < 5);
const caps = capsOf();
check('two caps split off', caps.length === 2, caps.join(' '));
const ballId = ['ball', 'ballTop', 'ballBottom'].find(b => !caps.includes(b))!;
feats.push({ id: 'capsGone', name: 'Throw the caps away', type: 'delete', bodies: caps });
extrude('slot', 'Tang slot', XY(9), [rect('r', [0, 0], 40, 4)], 5, { mode: 'cut', target: ballId });
await stage('ball with its slot');
const ballV = volumeOf(ballId);
extrude('vent', 'Vent hole', YZ(-20), [circle('c', [13.4, 0], 1)], 40, { mode: 'cut', target: ballId });
await stage('vent drilled');
check('the vent took some out', volumeOf(ballId) < ballV - 1, `${(ballV - volumeOf(ballId)).toFixed(2)} mm³`);
feats.push({ id: 'plug', name: 'Plug the vent', type: 'deleteGeom', body: ballId, faces: facesWhere(ballId, (face: any) => face.geomType === 'CYLINDRE' && (() => {
  const point = face.pointOnSurface(0.5, 0.5).toTuple();

  return near(Math.hypot(point[1] - 13.4, point[2]), 1, 0.02); 
})()), edges: [], vertices: [] });
await stage('vent plugged');
check('plugging brings the ball back', near(volumeOf(ballId), ballV, 0.05), `${volumeOf(ballId).toFixed(3)} vs ${ballV.toFixed(3)}`);

// --- 4. Seats: rings with the ball's shape cut out of them, mirrored.
section('Seats');
revolve('seat', 'Seat', XZ(0), [rect('r', [12.5, 14.2], 7, 4.4)], X_AXIS);
subtract('seatFit', "Ball's shape out of the seat", 'seat', [ballId], true);
feats.push({ id: 'seatMirror', name: 'The other seat', type: 'transform', bodies: ['seat'], copy: true, op: { kind: 'mirror', plane: YZ(0) } });
await stage('seats');
const seats = ['seat', 'seatMirror:seat:0'];

// --- 5. Stem (turned), its tang, flats, an M8 thread; its nut; the gland nut.
section('Stem');
feats.push({ id: 'stemAxis', name: 'Stem axis', type: 'axis', origin: [0, 0, 0], dir: [0, 0, 1] });
revolve('stem', 'Stem', XZ(0), [poly('p', [[0, 13], [4.9, 13], [4.9, 36], [4, 36], [4, 48], [0, 48]])], Z_AXIS);
extrude('tang', 'Tang', XY(9.2), [rect('r', [0, 0], 3.8, 13)], 3.9, { mode: 'join', target: 'stem' });
extrude('flats', 'Stem flats', XY(36), [rect('a', [8, 0], 10, 20), rect('b', [-8, 0], 10, 20)], 5, { mode: 'cut', target: 'stem' });
await stage('stem');
// Gland nut: hex with the M18 bore, a top plate with the stem's hole; notches round it.
extrude('gland', 'Gland nut', XY(28), [hexagon('h', [0, 0], 22.5, 0), circle('c', [0, 0], 8.25)], 6, { regions: all([hexagon('h', [0, 0], 22.5, 0), circle('c', [0, 0], 8.25)]).filter(regionRef => regionRef.a > 219) });
extrude('glandTop', 'Gland top', XY(34), [hexagon('h', [0, 0], 22.5, 0), circle('c', [0, 0], 5)], 2, { mode: 'join', target: 'gland', regions: all([hexagon('h', [0, 0], 22.5, 0), circle('c', [0, 0], 5)]).filter(regionRef => regionRef.a > 200) });
await stage('gland nut blank');
feats.push({ id: 'glandThread', name: 'Thread the gland nut', type: 'thread', face: roundFace('gland', 8.25, [0, 0, 1], [0, 0, 31], true), pitch: 1.5, round: { r: 8.25, hole: true } });
extrude('notch', 'Notch', XY(34), [rect('r', [12.6, 0], 3, 2)], 2);
feats.push({ id: 'notches', name: 'Notches round', type: 'transform', bodies: ['notch'], copy: false, op: { kind: 'circular', axis: { ...Z_AXIS, ref: { kind: 'axis', feature: 'stemAxis' } }, count: 6, angle: 360 } });
subtract('notched', 'Notch the gland nut', 'gland', ['notch', ...range(5, index => `notches:notch:${index}`)]);
feats.push({ id: 'glandChamfer', name: "Chamfer the gland's top", type: 'chamfer', edges: edgesWhere('gland', point => near(point[2], 36, 1e-3) && Math.hypot(point[0], point[1]) > 9), radius: 0.6 });
await stage('gland nut');

// --- 6. Lever: swept along a bending path, the hub, the stem's own shape as
// its hole, lettering, the end pushed out and narrowed, its bottom brought down.
section('Lever');
const LZ = 38.5; // the lever's middle, at the hub
// A bend of radius 80 tangent to both straights: down by 9 in 40 after it.
const BEND = 80, TH = Math.atan2(9, 40);
const bendAt = (t: number): P2 => [40 + BEND * Math.sin(t), LZ - BEND + BEND * Math.cos(t)];
const B1 = bendAt(TH);
const TIP: P2 = [110, B1[1] - (9 / 40) * (110 - B1[0])];
const path = [line('p0', [0, LZ], [40, LZ]), arc('p1', [40, LZ], bendAt(TH / 2), B1), line('p2', B1, TIP)];
sketch('sPath', 'Lever path', YZ(0), path);
sketch('sLever', 'Lever section', PY(0), [rect('r', [0, LZ], 14, 4)]);
feats.push({ id: 'lever', name: 'Lever', type: 'sweep', source: { kind: 'profile', sketch: 'sLever', regions: all([rect('r', [0, LZ], 14, 4)]) }, path: { kind: 'sketch', sketch: 'sPath', entities: ['p0', 'p1', 'p2'] }, mode: 'new' });
extrude('hub', 'Hub', XY(LZ - 2), [circle('c', [0, 0], 10)], 4, { mode: 'join', target: 'lever' });
await stage('lever');
subtract('leverHole', "Stem's shape out of the hub", 'lever', ['stem'], true);
// Lettering on a plane through three points on the lever's top.
feats.push({ id: 'pText', name: 'Lever top', type: 'plane', plane: XY(LZ + 2), offset: 0, kind: '3pt' });
const fontFile = readFileSync('node_modules/@fontsource/roboto/files/roboto-latin-700-normal.woff');
const font = parse(fontFile.buffer.slice(fontFile.byteOffset, fontFile.byteOffset + fontFile.byteLength));
const letters = textOutlines(font, 'OPEN', [0, 26], 5, 90, 'center').map((e: any, i: number) => ({ ...e, id: `t${i}` }));
extrude('text', 'Lettering', XY(LZ + 2), letters, 0.6, { mode: 'join', target: 'lever' });
await stage('lever lettering');
// The end: pushed out 4 along the path, then narrowed.
const d2: Vec3 = (() => {
  const length = Math.hypot(40, -9);

  return [0, 40 / length, -9 / length]; 
})();
const endFace = () => faceBy('lever', (face: any) => {
  const normal = nrm(face);

  return normal[1] * d2[1] + normal[2] * d2[2] > 0.999; 
});
feats.push({ id: 'leverLonger', name: 'Lever longer', type: 'moveFace', face: endFace(), translate: [0, d2[1] * 4, d2[2] * 4] });
await stage('lever longer');
feats.push({ id: 'leverTip', name: 'Narrow the tip', type: 'scaleFace', face: endFace(), u: [1, 0, 0], factors: [1, 0.8] });
await stage('lever tip');
// Its bottom (hub and the straight part, one face) down onto a plane just above the gland nut.
feats.push({ id: 'pGland', name: 'Above the gland nut', type: 'plane', plane: XY(36), offset: 0.2, kind: 'offset', face: faceBy('gland', (face: any) => nrm(face)[2] > 0.99 && near(face.center.toTuple()[2], 36, 1e-3)) });
feats.push({ id: 'leverDown', name: 'Lever bottom down', type: 'replaceFace', face: faceBy('lever', (face: any) => nrm(face)[2] < -0.99 && near(face.center.toTuple()[2], LZ - 2, 1e-3)), plane: { origin: [0, 0, 36.2], normal: [0, 0, -1], xDir: [1, 0, 0] } });
await stage('lever bottom down');
check('the hub sits on the plane', bodyShape('lever').faces.some((face: any) => face.geomType === 'PLANE' && nrm(face)[2] < -0.999 && near(face.center.toTuple()[2], 36.2, 1e-4) && measureArea(face) > 300));

// --- 7. Sleeve: lofted between two planes square to the path's last stretch,
// hollowed, grooves patterned along it, a freeform cap filled to its end plane.
section('Sleeve');
const at = (t: number): Vec3 => [0, B1[0] + (TIP[0] - B1[0]) * t, B1[1] + (TIP[1] - B1[1]) * t];
// The sleeve reaches past the tip, made 4 longer (Move Face, above).
const T_END = 1 + 7 / Math.hypot(TIP[0] - B1[0], TIP[1] - B1[1]);
const sq = (t: number): PlaneDef => ({ origin: at(t), normal: d2, xDir: [1, 0, 0] });
feats.push({ id: 'pS1', name: 'Sleeve start', type: 'plane', plane: sq(0.12), offset: 0, kind: 'curve' });
feats.push({ id: 'pS2', name: 'Sleeve end', type: 'plane', plane: sq(T_END), offset: 0, kind: 'curve' });
sketch('sS1', 'Sleeve start section', sq(0.12), [ellipse('e', [0, 0], 10, 6.2)]);
sketch('sS2', 'Sleeve end section', sq(T_END), [ellipse('e', [0, 0], 11, 7)]);
feats.push({ id: 'sleeve', name: 'Sleeve', type: 'loft', sections: [{ kind: 'profile', sketch: 'sS1', regions: all([ellipse('e', [0, 0], 10, 6.2)]) }, { kind: 'profile', sketch: 'sS2', regions: all([ellipse('e', [0, 0], 11, 7)]) }], ruled: false, mode: 'new' });
await stage('sleeve');
feats.push({ id: 'sleeveShell', name: 'Hollow the sleeve', type: 'shell', body: 'sleeve', faces: [faceBy('sleeve', (face: any) => {
  const normal = nrm(face);

  return normal[1] * d2[1] + normal[2] * d2[2] < -0.999; 
})], thickness: 1.6 });
await stage('hollow sleeve');
// Grooves: a thin elliptic ring, three along the sleeve.
const ringAt = 0.35;
const groove = [ellipse('o', [0, 0], 13, 8), ellipse('i', [0, 0], 9.7, 5.9)];
extrude('groove', 'Groove cutter', sq(ringAt), groove, 1, { regions: all(groove).filter(regionRef => Math.abs(regionRef.a - Math.PI * (13 * 8 - 9.7 * 5.9)) < 1) });
feats.push({ id: 'grooves', name: 'Grooves along', type: 'transform', bodies: ['groove'], copy: false, op: { kind: 'linear', dir: d2, spacing: 7, count: 3 } });
subtract('grooved', 'Groove the sleeve', 'sleeve', ['groove', 'grooves:groove:0', 'grooves:groove:1']);
await stage('grooved sleeve');
// The cap: a freeform dome over the end, filled down to the sleeve's end plane.
const e2 = sq(T_END);
const vAx: Vec3 = [0, -d2[2], d2[1]]; // across, square to x and the path
const world = (along: number, across: number, out: number): Vec3 => [along, e2.origin[1] + across * vAx[1] + out * d2[1], e2.origin[2] + across * vAx[2] + out * d2[2]];
const verts: Vec3[] = [];
for (let j = 0; j < 4; j++) {
  for (let i = 0; i < 4; i++) {
    const across = -7 + (14 * i) / 3, up = -3.6 + (7.2 * j) / 3;
    const inner = (i === 1 || i === 2) && (j === 1 || j === 2);
    verts.push(world(across, up, inner ? 4 : 0.6));
  }
}
const faces: [number, number, number, number][] = [];
for (let j = 0; j < 3; j++) {
  for (let i = 0; i < 3; i++) {
    faces.push([j * 4 + i, j * 4 + i + 1, (j + 1) * 4 + i + 1, (j + 1) * 4 + i]);
  }
}
feats.push({ id: 'cap', name: 'Sleeve cap', type: 'freeform', cage: { verts, faces }, surface: true });
feats.push({ id: 'capFill', name: "Fill the cap to the sleeve's end", type: 'fillToPlane', body: 'cap', plane: e2 });
union('capOn', 'Cap onto the sleeve', 'sleeve', ['cap']);
await stage('capped sleeve');

// --- 8. The handle turned a quarter round the stem's axis: parallel to the pipe (open).
section('Open');
const handle = ['lever', 'sleeve', 'stem'];
feats.push({ id: 'turn', name: 'Turn the handle to open', type: 'transform', bodies: handle, copy: false, op: { kind: 'move', translate: [0, 0, 0], rotate: { origin: [0, 0, 0], axis: [0, 0, 1], angle: -90 } } });
await stage('handle turned');
check('the lever lies along the pipe', box('lever')[1][0] > 100 && Math.abs(box('lever')[1][1]) < 12, `x to ${box('lever')[1][0].toFixed(1)}`);
// The stem's M8 thread, now that the lever's hole is cut from it; its nut.
feats.push({ id: 'stemThread', name: 'Thread the stem', type: 'thread', face: roundFace('stem', 4, [0, 0, 1], [0, 0, 44], false), pitch: 1.25, round: { r: 4, hole: false } });
extrude('nut', 'Nut', XY(LZ + 2.6), [hexagon('h', [0, 0], 13, 0), circle('c', [0, 0], 3.4)], 6.5, { regions: all([hexagon('h', [0, 0], 13, 0), circle('c', [0, 0], 3.4)]).filter(regionRef => regionRef.a > 60) });
await stage('nut blank');
feats.push({ id: 'nutThread', name: 'Thread the nut', type: 'thread', face: roundFace('nut', 3.4, [0, 0, 1], [0, 0, 44], true), pitch: 1.25, round: { r: 3.4, hole: true } });
await stage('stem and nut');
feats.push({ id: 'nutChamfer', name: 'Chamfer the nut', type: 'chamfer', edges: edgesWhere('nut', point => near(point[2], LZ + 2.6 + 6.5, 1e-3) && Math.hypot(point[0], point[1]) > 5), radius: 0.6 });
await stage('chamfered nut');

// --- 9. The flow arrow: an STL, imported, repaired, joined onto a hex flat.
section('Arrow');
const tri = (a: Vec3, b: Vec3, pointC: Vec3) => [a, b, pointC];
const prism = (pts: [number, number][], z0: number, z1: number) => {
  const ts: Vec3[][] = [];
  const count = pts.length;
  // A fan (the outline is convex in two parts: shaft and head).
  for (let i = 1; i < count - 1; i++) {
    ts.push(tri([pts[0][0], pts[0][1], z1], [pts[i][0], pts[i][1], z1], [pts[i + 1][0], pts[i + 1][1], z1]));
    ts.push(tri([pts[0][0], pts[0][1], z0], [pts[i + 1][0], pts[i + 1][1], z0], [pts[i][0], pts[i][1], z0]));
  }
  for (let i = 0; i < count; i++) {
    const a = pts[i], b = pts[(i + 1) % count];
    ts.push(tri([a[0], a[1], z0], [b[0], b[1], z0], [b[0], b[1], z1]));
    ts.push(tri([a[0], a[1], z0], [b[0], b[1], z1], [a[0], a[1], z1]));
  }

  return ts;
};
// On the top hex flat of the end piece (z = 18), pointing down the pipe.
const arrowTris = [...prism([[31, -1.2], [38, -1.2], [38, 1.2], [31, 1.2]], 17.9, 18.7), ...prism([[38, -3], [42.5, 0], [38, 3]], 17.9, 18.7)];
const stl = (ts: Vec3[][]) => {
  const buf = Buffer.alloc(84 + ts.length * 50);
  buf.writeUInt32LE(ts.length, 80);
  ts.forEach((t, index) => {
    const offset = 84 + index * 50;
    t.forEach((point, j) => point.forEach((x, axis) => buf.writeFloatLE(x, offset + 12 + j * 12 + axis * 4)));
  });

  return buf.toString('base64');
};
feats.push({ id: 'arrow', name: 'Flow arrow', type: 'import', format: 'stl', fileName: 'arrow.stl', data: stl(arrowTris) });
feats.push({ id: 'arrowFix', name: 'Repair the arrow', type: 'repair', bodies: ['arrow'] });
await stage('arrow imported');
union('arrowOn', 'Arrow onto the end piece', endId, ['arrow']);
await stage('arrow on');
// A reference picture of the valve on a plane tilted off the hex's top edge.
feats.push({ id: 'pImg', name: 'Picture plane', type: 'plane', plane: { origin: [0, 0, 18], normal: [0, -Math.SQRT1_2, Math.SQRT1_2], xDir: [1, 0, 0] }, offset: 0, kind: 'angle' });
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><rect x="20" y="40" width="160" height="30" fill="#c9a227"/><circle cx="100" cy="55" r="28" fill="#c9a227"/><rect x="95" y="10" width="80" height="8" fill="#d42a2a"/></svg>';
feats.push({ id: 'photo', name: 'Reference picture', type: 'image', plane: { origin: [0, -60, 0], normal: [0, -1, 0], xDir: [1, 0, 0] }, src: 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64'), width: 120, height: 60, opacity: 0.4 });

const final = await stage('the whole valve');

// --- Checks.
const bodies: string[] = final.bodies.map((b: any) => b.id);
console.log('bodies:', bodies.join(' '));
const parts = [mainId, endId, ballId, ...seats, 'stem', 'gland', 'lever', 'sleeve', 'nut'];
check('every part there', parts.every(part => bodyShape(part)), parts.filter(part => !bodyShape(part)).join(' '));
check('88 long end to end', near(box(mainId)[0][0], -END, 0.01) && near(box(endId)[1][0], END, 0.01));
// Nothing that moves runs into anything else (threaded pairs are allowed a touch).
const pairs: [string, string, number][] = [
  [ballId, mainId, 0.5], [ballId, endId, 0.5], [ballId, seats[0], 0.5], [ballId, seats[1], 0.5], [ballId, 'stem', 0.5],
  ['stem', mainId, 0.5], ['stem', 'gland', 0.5], ['lever', 'gland', 0.5], ['lever', mainId, 0.5], ['lever', endId, 0.5],
  ['lever', 'sleeve', 0.5], ['lever', 'nut', 0.5], [seats[0], endId, 0.5], [seats[1], mainId, 0.5], [seats[0], mainId, 0.5], [seats[1], endId, 0.5],
  ['stem', 'nut', 3], ['gland', mainId, 25]
];
for (const [a, b, tol] of pairs) {
  let overlapVolume = overlap(a, b);
  let how = '';
  // (More than allowed: counted point by point too - the intersect can be wrong on threads.)
  if (overlapVolume > tol) {
    [overlapVolume, how] = [sampledOverlap(a, b), ` (intersect said ${overlapVolume.toFixed(2)}; counted by points)`];
  }
  check(`${a} clear of ${b}`, overlapVolume >= 0 && overlapVolume <= tol, `${overlapVolume.toFixed(2)} mm³${how}`);
}
// The ball turns in its seats: the stem's tang sits in its slot.
check('the tang is in the slot', overlap('stem', ballId) < 0.5 && box('stem')[0][2] < 9.5);
// Threads really cut: the ports' faces aren't plain cylinders any more.
// (Counted at each port: the main body's boss thread used to hide a left port left plain.)
const grooveFaces = (id: string, side: number) => bodyShape(id).faces.filter((face: any) => face.geomType === 'BSPLINE_SURFACE' && face.center.toTuple()[0] * side > 25).length;
check('the ports are threaded', grooveFaces(mainId, -1) >= 2 && grooveFaces(endId, 1) >= 2, `${grooveFaces(mainId, -1)} / ${grooveFaces(endId, 1)} groove faces`);
// The bore follows its variable.
variables[0].expr = '20 mm';
const narrow = await build(true);
check('a 20 mm bore still builds', !narrow.errors.length, narrow.errors.map((e: any) => `${nameOf(e.featureId)}: ${e.message}`).join('; '));
variables[0].expr = '22 mm';
const used = new Set(feats.map(feature => feature.type));
console.log(`${feats.length} steps, ${bodies.length} bodies; tools: ${[...used].sort().join(' ')}`);

if (process.argv[2]) {
  const fin = await build(true);
  const project = doc();
  const brass = '#c9a227', ptfe = '#f2efe6', steel = '#b9bdc2', red = '#d42a2a', chrome = '#d4d8dc';
  project.colors = { [mainId]: brass, [endId]: brass, [ballId]: chrome, seat: ptfe, 'seatMirror:seat:0': ptfe, stem: steel, gland: brass, lever: steel, sleeve: red, nut: steel };
  project.names = { [mainId]: 'Body', [endId]: 'End piece', [ballId]: 'Ball', seat: 'Seat (left)', 'seatMirror:seat:0': 'Seat (right)', stem: 'Stem', gland: 'Gland nut', lever: 'Lever', sleeve: 'Grip sleeve', nut: 'Nut' };
  const missing = fin.bodies.map((b: any) => b.id).filter((b: string) => !project.names[b]);
  check('every body named', !missing.length, missing.join(' '));
  project.hidden = feats.filter(feature => feature.type === 'sketch' || feature.type === 'plane' || feature.type === 'axis' || feature.type === 'image').map(feature => feature.id);
  project.historyGroups = sections.map((section, sectionIndex) => ({ id: `g${sectionIndex}`, name: section.name, steps: feats.slice(section.from, sections[sectionIndex + 1]?.from ?? feats.length).map(feature => feature.id) })).filter(group => group.steps.length > 1);
  writeFileSync(process.argv[2], JSON.stringify(project));
  console.log('written', process.argv[2]);
}
process.exit(failed ? 1 : 0);
