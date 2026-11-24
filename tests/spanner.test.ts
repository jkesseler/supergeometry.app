// Run: npx tsx tests/spanner.test.ts [out.json] - a spanner: an open jaw at
// one end, a hex ring at the other, a handle between. The shape is drawn as a
// beginner would, out of overlapping pieces (two circles and a bar) and
// pulled up all at once; the jaw cut through all with a rectangle; a hexagon
// (the Polygon tool) cut through the ring end; the inside corners where the
// bar meets the heads rounded; the hexagon's top edges chamfered. Each step
// held to its size and soundness.
import { readFileSync, writeFileSync } from 'node:fs';
import { makeBox, type Shape3D } from 'replicad';
import { measureVolume } from '../src/kernel/ocFree';
import { arrangement, regionRef } from '../src/sketch/regions';
import { after, bodies, check, circle, done, health, near, rect, sketch, XY } from './kit';
import type { EdgeRef, Feature, SketchEntity, Vec3 } from '../src/doc/types';

const vol = (s: Shape3D) => Math.abs(measureVolume(s));
const body = (id: string) => bodies().get(id) as Shape3D;
const profileOf = (sk: string, es: SketchEntity[]) => ({ kind: 'profile' as const, sketch: sk, regions: arrangement(es).regions.map(regionRef) });
const unit = (v: number[]): Vec3 => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;

  return [v[0] / l, v[1] / l, v[2] / l]; 
};
const edgesOf = (id: string, test: (m: Vec3, d: Vec3) => boolean): EdgeRef[] =>
  body(id).edges.filter(e => test(e.pointAt(0.5).toTuple() as Vec3, unit(e.tangentAt(0.5).toTuple()))).map(e => ({ body: id, mid: e.pointAt(0.5).toTuple() as Vec3, dir: e.tangentAt(0.5).toTuple() as Vec3, length: e.length }));
/** Is there material round this point (a tiny box kept by an intersect)? */
const inside = (s: Shape3D, p: Vec3) => {
  const probe = makeBox([p[0] - 0.05, p[1] - 0.05, p[2] - 0.05], [p[0] + 0.05, p[1] + 0.05, p[2] + 0.05]);

  return Math.abs(measureVolume(s.intersect(probe) as Shape3D)) > 1e-6;
};

const T = 6; // thick
const JX = -70, JR = 16; // the jaw end: a head 32 across
const RX = 70, RR = 13; // the ring end: 26 across
const BAR = 6; // the bar: 12 wide (6 each side)
const JAW = 13; // the jaw's opening (13 across flats)
const HEX = 10; // the ring's hexagon: 10 across flats
const ROUND = 3, CHAMF = 0.5;
const hexR = HEX / Math.sqrt(3); // its corners' radius

// ----------------------------------------------------------------- the outline
// Two circles and a bar over both, every piece pulled up 6 at once.
const outEs = [circle('j', JX, 0, JR), circle('r', RX, 0, RR), rect('b', JX, -BAR, RX, BAR)];
const steps: Feature[] = [sketch('Outline', XY(), outEs), { id: 'Spanner', name: 'Spanner', type: 'extrude', source: profileOf('Outline', outEs), distance: T, mode: 'new' } as Feature];
let { errors } = await after(steps);
check('the outline: no errors, one body', !errors.length && bodies().size === 1, errors);
// The area: two discs and the bar between them (less what of it is in the discs).
// (The strip |y| < 6 over half a disc: the bar runs from each disc's centre inwards.)
const seg = (r: number) => r * r * Math.asin(BAR / r) + BAR * Math.sqrt(r * r - BAR * BAR);
const inJ = seg(JR), inR = seg(RR);
const area = Math.PI * JR * JR + Math.PI * RR * RR + 2 * BAR * (RX - JX) - inJ - inR;
const vOut = vol(body('Spanner'));
check('the outline: the discs and the bar, 6 thick', near(vOut, area * T, 1e-3), [vOut, area * T]);

// -------------------------------------------------------------------- the jaw
// A rectangle 13 across from inside the head out past its end, cut through all.
const jawEs = [rect('w', JX - JR - 4, -JAW / 2, JX + 2, JAW / 2)];
steps.push(sketch('Jaw', XY(T), jawEs), { id: 'JawCut', name: 'Extrude', type: 'extrude', source: profileOf('Jaw', jawEs), distance: -1, extent: 'through', mode: 'cut', target: 'Spanner' } as Feature);
({ errors } = await after(steps));
check('the jaw: no errors', !errors.length, errors);
const vJaw = vol(body('Spanner'));
check('the jaw: open (no material in its mouth), the handle still there', !inside(body('Spanner'), [JX - JR + 1, 0, T / 2]) && !inside(body('Spanner'), [JX, 0, T / 2]) && inside(body('Spanner'), [0, 0, T / 2]) && inside(body('Spanner'), [JX, JAW / 2 + 1, T / 2]), vOut - vJaw);
check('the jaw: one body still', bodies().size === 1 && health(body('Spanner'), 's').solids === 1, health(body('Spanner'), 's').solids);
// Auto (as a beginner leaves it), Through all into the body from its top face: a cut, the same.
{
  const auto = steps.map(f => (f.id === 'JawCut' ? ({ ...f, mode: 'auto' } as Feature) : f));
  const { errors } = await after(auto);
  check('the jaw with Auto, through all into the body: the same cut', !errors.length && near(vol(body('Spanner')), vJaw, 1e-6), [errors, vol(body('Spanner')), vJaw]);
  await after(steps);
}

// -------------------------------------------------------------------- the ring
// A hexagon 10 across flats in the ring end, cut through all.
const hexEs = [{ id: 'h', kind: 'polygon', center: [RX, 0], radius: hexR, sides: 6, angle: 0 } as unknown as SketchEntity];
steps.push(sketch('Hex', XY(T), hexEs), { id: 'HexCut', name: 'Extrude', type: 'extrude', source: profileOf('Hex', hexEs), distance: -1, extent: 'through', mode: 'cut', target: 'Spanner' } as Feature);
({ errors } = await after(steps));
check('the ring: no errors', !errors.length, errors);
const vHex = vol(body('Spanner'));
check('the ring: a hexagon 10 across flats out of it, 6 deep', near(vJaw - vHex, ((3 * Math.sqrt(3)) / 2) * hexR * hexR * T, 1e-3), vJaw - vHex);

// ------------------------------------------------------------------- the edges
// The four inside corners where the bar meets the heads, rounded 3.
const xJ = JX + Math.sqrt(JR * JR - BAR * BAR), xR = RX - Math.sqrt(RR * RR - BAR * BAR);
const corners = edgesOf('Spanner', (m, d) => Math.abs(d[2]) > 0.99 && near(Math.abs(m[1]), BAR, 1e-6) && (near(m[0], xJ, 1e-6) || near(m[0], xR, 1e-6)));
steps.push({ id: 'Corners', name: 'Fillet', type: 'fillet', edges: corners, radius: ROUND } as Feature);
({ errors } = await after(steps));
check('the corners: four, rounded, no errors', !errors.length && corners.length === 4, [errors, corners.length]);
const vRound = vol(body('Spanner'));
check('the corners: filled in a little (more material, not less)', vRound > vHex && vRound - vHex < 4 * ROUND * ROUND * T, vRound - vHex);
// The hexagon's six top edges, chamfered 0.5.
const hexTop = edgesOf('Spanner', m => near(m[2], T, 1e-6) && near(Math.hypot(m[0] - RX, m[1]), HEX / 2, 1e-6));
steps.push({ id: 'HexEdges', name: 'Chamfer', type: 'chamfer', edges: hexTop, radius: CHAMF } as Feature);
({ errors } = await after(steps));
check("the hexagon's top: six edges chamfered, no errors", !errors.length && hexTop.length === 6, [errors, hexTop.length]);
const vCham = vol(body('Spanner'));
check("the hexagon's top: 0.5 x 0.5 off round it (6 sides, a little more at the corners)", vRound - vCham > 0.5 * CHAMF * CHAMF * 6 * hexR && vRound - vCham < 0.5 * CHAMF * CHAMF * 6 * (hexR + 1), vRound - vCham);

const h = health(body('Spanner'), 'Spanner');
check('the spanner: sound, one body', h.healthy && bodies().size === 1, h.healthy ? `${Math.round(h.volume)} mm³` : h);
const codeVol = vol(body('Spanner'));
const codeFaces = body('Spanner').faces.length;
const codeBox = body('Spanner').boundingBox.bounds;
console.log('outline', vOut.toFixed(1), 'jaw', vJaw.toFixed(1), 'hex', vHex.toFixed(1), 'round', vRound.toFixed(1), 'final', codeVol.toFixed(1), 'faces', codeFaces);

// ----------------------------------------------- the spanner built by hand
// On a phone-sized screen (tests/fixtures/spanner-hand.json): the two circles
// and the bar typed in Values, All shapes pulled up 6; on the head's top a
// rectangle typed, cut Through all (Auto: it went up into a tower 354 high,
// before); on the ring's top the Polygon tool, 10 typed Across flats (it
// only took a corner radius, before); the four inside corners picked from
// two sides and rounded 3; the hexagon's six top edges chamfered 0.5. It
// comes out the same.
{
  const hand = JSON.parse(readFileSync(new URL('./fixtures/spanner-hand.json', import.meta.url), 'utf8')).features as Feature[];
  const { errors } = await after(hand);
  check('by hand: no errors', errors.length === 0, errors);
  const H = [...bodies().values()].map(s => s as Shape3D);
  check('by hand: one body, sound', H.length === 1 && health(H[0], 'hand').healthy, H.length);
  check('by hand: the same spanner (to 0.1 %)', H.length === 1 && Math.abs(vol(H[0]) - codeVol) < codeVol * 1e-3, `${H[0] ? vol(H[0]).toFixed(1) : '-'} / ${codeVol.toFixed(1)}`);
  check('by hand: as many faces, the same box', H[0]?.faces.length === codeFaces && H[0].boundingBox.bounds.flat().every((x, i) => near(x, codeBox.flat()[i], 1e-3)), [H[0]?.faces.length, codeFaces, H[0]?.boundingBox.bounds]);
}

if (process.argv[2]) {
  writeFileSync(process.argv[2], JSON.stringify({ format: 'super', version: 2, name: 'Spanner', features: steps }));
}
done();
