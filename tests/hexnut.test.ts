// Run: npx tsx tests/hexnut.test.ts [out.json] - an M10 nut: a hexagon 17
// across its flats extruded 8, the edges round its top and bottom chamfered
// 1, a hole at M10's tap-drill size (8.5) through it, threaded inside. Each
// step held to its size and soundness.
import { readFileSync, writeFileSync } from 'node:fs';
import { measureArea, type Face, type Shape3D } from 'replicad';
import { measureVolume } from '../src/kernel/ocFree';
import { arrangement, regionRef } from '../src/sketch/regions';
import { after, bodies, check, circle, done, health, near, sketch, XY } from './kit';
import type { EdgeRef, FaceRef, Feature, SketchEntity, Vec3 } from '../src/doc/types';

const vol = (s: Shape3D) => Math.abs(measureVolume(s));
const body = (id: string) => bodies().get(id) as Shape3D;
const profileOf = (sk: string, es: SketchEntity[]) => ({ kind: 'profile' as const, sketch: sk, regions: arrangement(es).regions.map(regionRef) });
const unit = (v: number[]): Vec3 => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;

  return [v[0] / l, v[1] / l, v[2] / l]; 
};
const edgesOf = (id: string, test: (m: Vec3, d: Vec3, len: number) => boolean): EdgeRef[] =>
  body(id).edges.filter(e => test(e.pointAt(0.5).toTuple() as Vec3, unit(e.tangentAt(0.5).toTuple()), e.length)).map(e => ({ body: id, mid: e.pointAt(0.5).toTuple() as Vec3, dir: e.tangentAt(0.5).toTuple() as Vec3, length: e.length }));
const ref = (id: string, f: Face): FaceRef => ({ body: id, center: f.center.toTuple() as Vec3, normal: f.normalAt().toTuple() as Vec3, area: measureArea(f) });
const faceOf = (id: string, pick: (f: Face) => boolean) => {
  const f = body(id).faces.find(pick); if (!f) {
    throw new Error(`no such face on ${id}`);
  }

  return ref(id, f); 
};
const PI = Math.PI;

const AF = 17, T = 8; // 17 across the flats, 8 thick
const a = AF / 2; // the flats' distance from the middle
const C = 1; // the chamfers
const HR = 4.25; // the hole: M10's tap drill
const P = 1.5; // M10's pitch

// ------------------------------------------------------------------ the hex
const hexEs = [{ id: 'h', kind: 'polygon', center: [0, 0], radius: a / Math.cos(PI / 6), sides: 6, angle: 0 } as SketchEntity];
const steps: Feature[] = [sketch('Hex', XY(), hexEs), { id: 'Nut', name: 'Extrude', type: 'extrude', source: profileOf('Hex', hexEs), distance: T, mode: 'new' } as Feature];
let { errors } = await after(steps);
const vHex = vol(body('Nut'));
const hexArea = (ap: number) => 2 * Math.sqrt(3) * ap * ap; // a hexagon by its flats' distance
const [[x0, y0], [x1, y1]] = body('Nut').boundingBox.bounds;
check('the hex: 17 across the flats, 8 thick', !errors.length && near(vHex, hexArea(a) * T, 1e-6) && near(Math.min(x1 - x0, y1 - y0), AF, 1e-6), [errors, vHex, hexArea(a) * T, x1 - x0, y1 - y0]);

// ------------------------------------------------------------- the chamfers
// The twelve edges round the top and bottom, 1: each end's band is the hex
// shrunk in by up to 1 as it goes, ∫ (A(a) - A(a - s)) ds over 0..1.
const rims = edgesOf('Nut', m => near(m[2], 0, 1e-6) || near(m[2], T, 1e-6));
steps.push({ id: 'Chamfers', name: 'Chamfer', type: 'chamfer', edges: rims, radius: C } as Feature);
({ errors } = await after(steps));
const vCh = vol(body('Nut'));
const band = 2 * Math.sqrt(3) * (a * a * C - (a ** 3 - (a - C) ** 3) / 3);
check('the chamfers: all twelve edges, 1', !errors.length && rims.length === 12 && near(vHex - vCh, 2 * band, 1e-4), [errors, rims.length, vHex - vCh, 2 * band]);

// ----------------------------------------------------------------- the hole
const holeEs = [circle('d', 0, 0, HR)];
steps.push(sketch('Bore', XY(T), holeEs), { id: 'Hole', name: 'Extrude', type: 'extrude', source: profileOf('Bore', holeEs), distance: -1, extent: 'through', mode: 'cut', target: 'Nut' } as Feature);
({ errors } = await after(steps));
const vHole = vol(body('Nut'));
check('the hole: 8.5 across, through', !errors.length && near(vCh - vHole, PI * HR * HR * T, 1e-3), [errors, vCh - vHole, PI * HR * HR * T]);

// --------------------------------------------------------------- the thread
// M10 x 1.5 inside: taken from the wall round the hole, along its length.
const bore = faceOf('Nut', f => f.geomType === 'CYLINDRE');
steps.push({ id: 'Thread', name: 'Thread', type: 'thread', face: bore, pitch: P, round: { r: HR, hole: true } } as Feature);
({ errors } = await after(steps));
const vThread = vol(body('Nut'));
// The groove: a ring 5/8·H deep round the hole, the V filling about half of it.
const H = (P * Math.sqrt(3)) / 2;
const ring = PI * ((HR + (5 / 8) * H) ** 2 - HR * HR) * T;
check('the thread: cut into the wall round the hole', !errors.length && bodies().size === 1 && vHole - vThread > 0.25 * ring && vHole - vThread < 0.75 * ring, [errors, vHole - vThread, ring]);
const [[, , z0], [, , z1]] = body('Nut').boundingBox.bounds;
check('the thread: the nut still 8 thick, one body', near(z0, 0, 1e-4) && near(z1, T, 1e-4) && bodies().size === 1, [z0, z1]);

const h = health(body('Nut'), 'Nut');
check('the nut: sound, one body', h.healthy && bodies().size === 1, h.healthy ? `${Math.round(h.volume)} mm³` : h);
const codeVol = vol(body('Nut'));
const codeFaces = body('Nut').faces.length;
const codeBox = body('Nut').boundingBox.bounds;
console.log('hex', vHex.toFixed(1), 'chamfers', vCh.toFixed(1), 'hole', vHole.toFixed(1), 'final', codeVol.toFixed(1), 'faces', codeFaces);

// ---------------------------------------------- the nut built by hand
// On a phone-sized screen (tests/fixtures/hexnut-hand.json): Polygon, its
// Across flats typed 17, extruded 8; Chamfer with the top face tapped and the
// bottom one from below - six edges each (a face tapped did nothing before:
// twelve edges, three of them behind, one by one); the top tapped for a
// sketch, a circle 8.5 across, cut Through all; Thread on the hole (M10 x 1.5
// offered). It comes out the same.
{
  const hand = JSON.parse(readFileSync(new URL('./fixtures/hexnut-hand.json', import.meta.url), 'utf8')).features as Feature[];
  const { errors } = await after(hand);
  check('by hand: no errors', errors.length === 0, errors);
  const B = [...bodies().values()].map(s => s as Shape3D);
  check('by hand: one body, sound', B.length === 1 && health(B[0], 'hand').healthy, B.length);
  check('by hand: the same nut (to 0.1 %)', B.length === 1 && Math.abs(vol(B[0]) - codeVol) < codeVol * 1e-3, `${B[0] ? vol(B[0]).toFixed(1) : '-'} / ${codeVol.toFixed(1)}`);
  check('by hand: as many faces, the same box', B[0]?.faces.length === codeFaces && B[0].boundingBox.bounds.flat().every((x, i) => near(x, codeBox.flat()[i], 1e-3)), [B[0]?.faces.length, codeFaces, B[0]?.boundingBox.bounds]);
  const ch = hand.find(f => f.type === 'chamfer') as { edges: unknown[] } | undefined;
  check("by hand: the chamfer's twelve edges from two faces tapped", ch?.edges.length === 12, ch?.edges.length);
}

if (process.argv[2]) {
  writeFileSync(process.argv[2], JSON.stringify({ format: 'super', version: 2, name: 'M10 nut', features: steps }));
}
done();
