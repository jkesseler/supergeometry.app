// Run: npx tsx tests/splitbox.test.ts [out.json] - a box with a lid: a block
// with its upright corners rounded and its top and bottom edges rounded, made
// hollow all round (a shell with no face open), then cut in two along a
// construction plane: a base and a lid. Each step held to its size (the
// rounds and the shell to Steiner's formula) and soundness.
import { readFileSync, writeFileSync } from 'node:fs';
import { measureVolume } from '../src/kernel/ocFree';
import { arrangement, regionRef } from '../src/sketch/regions';
import { after, bodies, check, done, health, near, rect, sketch, XY } from './kit';
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
const PI = Math.PI;

const L = 60, W = 40, H = 30; // the box
const RC = 8, RE = 2; // its upright corners' round, its top and bottom edges'
const T = 2; // the wall
const ZS = 22; // where the lid comes off

// The inside: the box 2 in all round, its corners 6, its edges sharp. The
// outside is that grown 2 all round (Steiner: V + S·r + M·r² + 4/3·π·r³, M
// its mean curvature: π/2 along its top and bottom edges, 1/(2·6) over its
// round corners - π times its height for the four).
const Li = L - 2 * T, Wi = W - 2 * T, Hi = H - 2 * T, Ri = RC - T;
const Ai = Li * Wi - 4 * (1 - PI / 4) * Ri * Ri;
const pi = 2 * (Li - 2 * Ri) + 2 * (Wi - 2 * Ri) + 2 * PI * Ri;
const Vi = Ai * Hi;
const Vout = Vi + (2 * Ai + pi * Hi) * T + (PI * pi / 2 + PI * Hi) * T * T + (4 / 3) * PI * T ** 3;
const Aout = L * W - 4 * (1 - PI / 4) * RC * RC;

// ---------------------------------------------------------------- the block
const boxEs = [rect('b', -L / 2, -W / 2, L / 2, W / 2)];
const steps: Feature[] = [sketch('Base', XY(), boxEs), { id: 'Box', name: 'Extrude', type: 'extrude', source: profileOf('Base', boxEs), distance: H, mode: 'new' } as Feature];
let { errors } = await after(steps);
const corners = edgesOf('Box', (m, d) => Math.abs(d[2]) > 0.99);
steps.push({ id: 'Corners', name: 'Fillet', type: 'fillet', edges: corners, radius: RC } as Feature);
({ errors } = await after(steps));
const vCorners = vol(body('Box'));
check('the block: 60 x 40 x 30, its upright corners rounded 8', !errors.length && corners.length === 4 && near(vCorners, Aout * H, 1e-6), [errors, corners.length, vCorners, Aout * H]);

// ---------------------------------------------------------------- the edges
// Top and bottom, all round, rounded 2.
const rims = edgesOf('Box', m => near(m[2], 0, 1e-6) || near(m[2], H, 1e-6));
steps.push({ id: 'Edges', name: 'Fillet', type: 'fillet', edges: rims, radius: RE } as Feature);
({ errors } = await after(steps));
const vEdges = vol(body('Box'));
check('the edges: top and bottom rounded 2 (Steiner)', !errors.length && rims.length === 16 && near(vEdges, Vout, 1e-3), [errors, rims.length, vEdges, Vout]);

// ---------------------------------------------------------------- the shell
// Hollow, 2 thick, no face open: what's left is the outside less the inside.
// (Walls as thick as the edges are round shrink those rounds inside to
// nothing; the kernel can't make that, so the wall comes out a thousandth
// thicker, with the sharp inside it should have - within 0.2 %.)
steps.push({ id: 'Hollow', name: 'Shell', type: 'shell', body: 'Box', faces: [], thickness: T } as Feature);
({ errors } = await after(steps));
const vShell = vol(body('Box'));
check('the shell: hollow all round, 2 thick', !errors.length && bodies().size === 1 && near(vShell, Vout - Vi, 2e-3 * (Vout - Vi)), [errors, bodies().size, vShell, Vout - Vi]);

// ---------------------------------------------------------------- the split
// A construction plane 22 up; the box cut along it: a base and a lid.
const at = { origin: [0, 0, ZS] as Vec3, xDir: [1, 0, 0] as Vec3, normal: [0, 0, 1] as Vec3 };
steps.push({ id: 'Cut', name: 'Plane', type: 'plane', plane: at, offset: ZS } as Feature, { id: 'Lid', name: 'Split', type: 'split', body: 'Box', plane: at } as Feature);
({ errors } = await after(steps));
const parts = [...bodies().values()].map(s => s as Shape3D);
const tops = parts.map(s => s.boundingBox.bounds[1][2]);
const lid = parts[tops.indexOf(Math.max(...tops))], base = parts[tops.indexOf(Math.min(...tops))];
// The lid: the wall's ring for 6, then the top (its own inside's section
// grown by √(4 - t²) as t goes 0 to 2).
const Vlid = (Aout - Ai) * (H - T - ZS) + T * Ai + pi * PI + PI * 16 / 3;
check('the split: two parts, nothing lost', !errors.length && parts.length === 2 && near(vol(lid) + vol(base), vShell, 1e-3), [errors, parts.length, parts.map(vol), vShell]);
check('the split: the lid from 22 up, its size', near(lid.boundingBox.bounds[0][2], ZS, 1e-4) && near(base.boundingBox.bounds[1][2], ZS, 1e-4) && near(vol(lid), Vlid, 2e-3 * Vlid), [lid.boundingBox.bounds, vol(lid), Vlid]);
const healthy = parts.every((s, i) => health(s, `part${i}`).healthy);
check('the parts: both sound', healthy);
const codeVols = parts.map(vol).sort((a, b) => a - b);
const codeFaces = parts.map(s => s.faces.length).sort((a, b) => a - b);
console.log('corners', vCorners.toFixed(1), 'edges', vEdges.toFixed(1), 'shell', vShell.toFixed(1), 'parts', codeVols.map(v => v.toFixed(1)).join(' '), 'faces', codeFaces.join(' '));

// ---------------------------------------------- the box built by hand
// On a phone-sized screen (tests/fixtures/splitbox-hand.json): the box's
// rectangle typed and extruded 30; three upright corners tapped and rounded 8,
// the fourth from the back; one top edge and one bottom edge rounded 2 (each
// runs on round its loop); Shell waiting, the body tapped in Items: no face
// open, 2 thick (walls as thick as the edges' rounds: it failed, after a
// minute and a half, saying two faces were too close together); an offset
// plane 22 up from XY; Split Body along it. It comes out the same.
{
  const hand = JSON.parse(readFileSync(new URL('./fixtures/splitbox-hand.json', import.meta.url), 'utf8')).features as Feature[];
  const { errors } = await after(hand);
  check('by hand: no errors', errors.length === 0, errors);
  const P = [...bodies().values()].map(s => s as Shape3D);
  check('by hand: two parts, both sound', P.length === 2 && P.every((s, i) => health(s, `hand${i}`).healthy), P.length);
  const vs = P.map(vol).sort((a, b) => a - b);
  check('by hand: the same base and lid (to 0.1 %)', P.length === 2 && vs.every((v, i) => Math.abs(v - codeVols[i]) < codeVols[i] * 1e-3), `${vs.map(v => v.toFixed(1)).join(' ')} / ${codeVols.map(v => v.toFixed(1)).join(' ')}`);
  check('by hand: as many faces', P.map(s => s.faces.length).sort((a, b) => a - b).join() === codeFaces.join(), P.map(s => s.faces.length));
}

if (process.argv[2]) {
  writeFileSync(process.argv[2], JSON.stringify({ format: 'super', version: 2, name: 'Box with a lid', features: steps }));
}
done();
