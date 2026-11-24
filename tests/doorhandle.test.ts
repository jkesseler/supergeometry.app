// Run: npx tsx tests/doorhandle.test.ts [out.json] - a lever door handle: a
// plate with its corners rounded; two screw holes (one drawn, mirrored in the
// sketch) cut through and countersunk; the lever a round bar swept from the
// plate up, round a bend and out along a line and an arc drawn on the side
// plane; its far end rounded. Each step held to its size and soundness.
import { readFileSync, writeFileSync } from 'node:fs';
import { measureVolume } from '../src/kernel/ocFree';
import { arrangement, regionRef } from '../src/sketch/regions';
import { after, bodies, check, circle, done, health, line, near, rect, sketch, XY, YZ } from './kit';
import type { Shape3D } from 'replicad';
import type { EdgeRef, Feature, SketchEntity, Vec3 } from '../src/doc/types';

const vol = (s: Shape3D) => Math.abs(measureVolume(s));
const body = (id: string) => bodies().get(id) as Shape3D;
const profileOf = (sk: string, es: SketchEntity[]) => ({ kind: 'profile' as const, sketch: sk, regions: arrangement(es).regions.map(regionRef) });
const unit = (v: number[]): Vec3 => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;

  return [v[0] / l, v[1] / l, v[2] / l]; 
};
const edgesOf = (id: string, test: (m: Vec3, d: Vec3, len: number) => boolean): EdgeRef[] =>
  body(id).edges.filter(e => test(e.pointAt(0.5).toTuple() as Vec3, unit(e.tangentAt(0.5).toTuple()), e.length)).map(e => ({ body: id, mid: e.pointAt(0.5).toTuple() as Vec3, dir: e.tangentAt(0.5).toTuple() as Vec3, length: e.length }));

const W = 30, L = 100, T = 6, CORNER = 5; // the plate
const HOLE = 2.5, HY = 38, SINK = 1.5; // the screw holes
const BAR = 7, AY = 20, Z0 = T, UP = 30, BEND = 15, OUT = 110; // the lever: a bar 14 across, from the plate's top at y 20 up to 30, a bend of 15, out to y 110
const ROUND = 3;

// ------------------------------------------------------------------ the plate
const plateEs = [rect('p', -W / 2, -L / 2, W / 2, L / 2)];
const steps: Feature[] = [sketch('Plate', XY(), plateEs), { id: 'Handle', name: 'Handle', type: 'extrude', source: profileOf('Plate', plateEs), distance: T, mode: 'new' } as Feature];
let { errors } = await after(steps);
check('the plate: no errors', !errors.length, errors);
const corners = edgesOf('Handle', (m, d) => Math.abs(d[2]) > 0.99 && near(Math.abs(m[0]), W / 2) && near(Math.abs(m[1]), L / 2));
steps.push({ id: 'Corners', name: 'Fillet', type: 'fillet', edges: corners, radius: CORNER } as Feature);
({ errors } = await after(steps));
const vPlate = vol(body('Handle'));
check('the plate: 30 x 100 x 6, four corners rounded 5', !errors.length && corners.length === 4 && near(vPlate, (W * L - 4 * (1 - Math.PI / 4) * CORNER * CORNER) * T, 1e-6), [errors, corners.length, vPlate]);

// ----------------------------------------------------------------- the holes
// One circle, and its mirror over the plate's middle; cut through all from the top.
const holeEs = [circle('h1', 0, HY, HOLE), circle('h2', 0, -HY, HOLE)];
steps.push(sketch('Screws', XY(T), holeEs), { id: 'Holes', name: 'Extrude', type: 'extrude', source: profileOf('Screws', holeEs), distance: -1, extent: 'through', mode: 'auto', target: 'Handle' } as Feature);
({ errors } = await after(steps));
const vHoles = vol(body('Handle'));
check('the holes: two, 5 round, through the plate', !errors.length && near(vPlate - vHoles, 2 * Math.PI * HOLE * HOLE * T, 1e-6), [errors, vPlate - vHoles]);
// Countersunk: their top edges chamfered 1.5.
const tops = edgesOf('Handle', m => near(m[2], T) && near(Math.hypot(m[0], Math.abs(m[1]) - HY), HOLE, 1e-3));
steps.push({ id: 'Sinks', name: 'Chamfer', type: 'chamfer', edges: tops, radius: SINK } as Feature);
({ errors } = await after(steps));
const vSink = vol(body('Handle'));
// A cone's ring round each: π·h·(R² + R·r + r²)/3 less the hole's cylinder there.
const ring = (Math.PI * SINK * ((HOLE + SINK) ** 2 + (HOLE + SINK) * HOLE + HOLE * HOLE)) / 3 - Math.PI * HOLE * HOLE * SINK;
check('the countersinks: both, 1.5 down', !errors.length && tops.length >= 2 && near(vHoles - vSink, 2 * ring, 1e-3), [errors, tops.length, vHoles - vSink, 2 * ring]);

// ----------------------------------------------------------------- the lever
// The path on the side plane (y across, z up): up from the plate's top, a bend, out along; the bar's circle on the top.
const pathEs = [line('p1', [AY, Z0], [AY, UP]), { id: 'p2', kind: 'arc', a: [AY, UP], m: [AY + BEND - BEND * Math.SQRT1_2, UP + BEND * Math.SQRT1_2], b: [AY + BEND, UP + BEND] } as SketchEntity, line('p3', [AY + BEND, UP + BEND], [OUT, UP + BEND])];
const barEs = [circle('b', 0, AY, BAR)];
steps.push(
  sketch('Path', YZ(), pathEs),
  sketch('Bar', XY(Z0), barEs),
  { id: 'Lever', name: 'Sweep', type: 'sweep', source: profileOf('Bar', barEs), path: { kind: 'sketch', sketch: 'Path', entities: ['p1', 'p2', 'p3'] }, mode: 'join', target: 'Handle' } as Feature
);
({ errors } = await after(steps));
check('the lever: no errors, one body', !errors.length && bodies().size === 1, errors);
const vLever = vol(body('Handle'));
const pathLen = UP - Z0 + (Math.PI / 2) * BEND + (OUT - AY - BEND);
check('the lever: a bar 14 across along the path', near(vLever - vSink, Math.PI * BAR * BAR * (pathLen - (T - Z0)), 1e-3), [vLever - vSink, Math.PI * BAR * BAR * (pathLen - (T - Z0))]);
const [, [, y1, z1]] = body('Handle').boundingBox.bounds;
check('the lever: out to 110, its top 52 up', near(y1, OUT, 1e-3) && near(z1, UP + BEND + BAR, 1e-3), body('Handle').boundingBox.bounds);

// ---------------------------------------------------------------- the end
const end = edgesOf('Handle', (m, _d, len) => near(m[1], OUT, 1e-3) && near(len, 2 * Math.PI * BAR, 1e-3));
steps.push({ id: 'End', name: 'Fillet', type: 'fillet', edges: end, radius: ROUND } as Feature);
({ errors } = await after(steps));
const vEnd = vol(body('Handle'));
check('the end: rounded 3, a little off', !errors.length && end.length === 1 && vEnd < vLever && vLever - vEnd < 2 * Math.PI * BAR * ROUND * ROUND, [errors, end.length, vLever - vEnd]);

const h = health(body('Handle'), 'Handle');
check('the handle: sound, one body', h.healthy && bodies().size === 1, h.healthy ? `${Math.round(h.volume)} mm³` : h);
const codeVol = vol(body('Handle'));
const codeFaces = body('Handle').faces.length;
const codeBox = body('Handle').boundingBox.bounds;
console.log('plate', vPlate.toFixed(1), 'holes', vHoles.toFixed(1), 'sinks', vSink.toFixed(1), 'lever', vLever.toFixed(1), 'final', codeVol.toFixed(1), 'faces', codeFaces);

// ---------------------------------------------- the handle built by hand
// On a phone-sized screen (tests/fixtures/doorhandle-hand.json): the plate
// typed and pulled up 6, its corners picked from two sides and rounded 5; on
// its top one circle, Mirror (Copy) across the X axis - a second tap on the
// axis made the same copy again on top of it, before - both cut Through all
// and countersunk 1.5; on the side plane a line, a centre arc and a line,
// typed; the bar's circle on the top, swept along them (Auto joined it); its
// end rounded 3. It comes out the same.
{
  const hand = JSON.parse(readFileSync(new URL('./fixtures/doorhandle-hand.json', import.meta.url), 'utf8')).features as Feature[];
  const { errors } = await after(hand);
  check('by hand: no errors', errors.length === 0, errors);
  const H = [...bodies().values()].map(s => s as Shape3D);
  check('by hand: one body, sound', H.length === 1 && health(H[0], 'hand').healthy, H.length);
  check('by hand: the same handle (to 0.1 %)', H.length === 1 && Math.abs(vol(H[0]) - codeVol) < codeVol * 1e-3, `${H[0] ? vol(H[0]).toFixed(1) : '-'} / ${codeVol.toFixed(1)}`);
  check('by hand: as many faces, the same box', H[0]?.faces.length === codeFaces && H[0].boundingBox.bounds.flat().every((x, i) => near(x, codeBox.flat()[i], 1e-3)), [H[0]?.faces.length, codeFaces, H[0]?.boundingBox.bounds]);
}

if (process.argv[2]) {
  writeFileSync(process.argv[2], JSON.stringify({ format: 'super', version: 2, name: 'Door handle', features: steps }));
}
done();
