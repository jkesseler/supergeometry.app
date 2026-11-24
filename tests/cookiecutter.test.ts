// Run: npx tsx tests/cookiecutter.test.ts [out.json] - a cookie cutter: a
// hexagon 60 across its corners, offset out 1.2 (the wall) and out 5 (the
// flange), all in one sketch; the wall and the flange extruded 2 (a new body),
// the wall on up to 15 (Add); the wall's top edges rounded 0.5 inside and out.
// Each step held to its size (hexagons by their areas, the rounds by the
// length of each loop at the spandrel's middle) and soundness.
import { readFileSync, writeFileSync } from 'node:fs';
import { measureVolume } from '../src/kernel/ocFree';
import { arrangement, regionRef } from '../src/sketch/regions';
import { after, bodies, check, done, health, near, sketch, XY } from './kit';
import type { Shape3D } from 'replicad';
import type { EdgeRef, Feature, SketchEntity, Vec3 } from '../src/doc/types';

const vol = (s: Shape3D) => Math.abs(measureVolume(s));
const body = (id: string) => bodies().get(id) as Shape3D;
const edgesOf = (id: string, test: (m: number[], d: number[]) => boolean): EdgeRef[] =>
  body(id).edges.filter(e => test(e.pointAt(0.5).toTuple(), e.tangentAt(0.5).toTuple())).map(e => ({ body: id, mid: e.pointAt(0.5).toTuple() as Vec3, dir: e.tangentAt(0.5).toTuple() as Vec3, length: e.length }));
const PI = Math.PI;
const SQ3 = Math.sqrt(3);

const R = 30; // the hexagon: 30 to its corners (a corner on +X)
const W = 1.2; // the wall: offset out 1.2
const FL = 5; // the flange: offset out 5
const FH = 2, H = 15; // the flange 2 high, the wall 15
const F = 0.5; // the wall's top edges rounded 0.5

// A hexagon's apothem a: area 2·√3·a², perimeter 4·√3·a.
const a0 = (R * SQ3) / 2;
const hexArea = (a: number) => 2 * SQ3 * a * a;
const hexLoop = (a: number) => 4 * SQ3 * a;
const hex = (id: string, a: number): SketchEntity => ({ id, kind: 'polygon', center: [0, 0], radius: (2 * a) / SQ3, sides: 6, angle: 0 }) as SketchEntity;

// ---------------------------------------------------------------- the rings
const es = [hex('in', a0), hex('wall', a0 + W), hex('flange', a0 + FL)];
const regions = arrangement(es).regions.map(regionRef);
// Which ring a region is: by the two hexagons round it.
const ringOf = (inner: string, outer: string) => ({ kind: 'profile' as const, sketch: 'Outline', regions: regions.filter(r => JSON.stringify([...r.k].sort()) === JSON.stringify([inner, outer].sort())) });
const steps: Feature[] = [sketch('Outline', XY(), es)];
const wallSrc = ringOf('in', 'wall');
const flangeSrc = ringOf('wall', 'flange');
check('the sketch: three hexagons, a ring for the wall and one for the flange', wallSrc.regions.length === 1 && flangeSrc.regions.length === 1, [regions.length, wallSrc.regions.length, flangeSrc.regions.length]);

steps.push({ id: 'Base', name: 'Extrude', type: 'extrude', source: { ...wallSrc, regions: [...wallSrc.regions, ...flangeSrc.regions] }, distance: FH, mode: 'new' } as Feature);
let { errors } = await after(steps);
const vBase = vol(body('Base'));
const baseArea = hexArea(a0 + FL) - hexArea(a0);
check('the wall and the flange: 2 high', !errors.length && near(vBase, baseArea * FH, 1e-6 * vBase), [errors, vBase, baseArea * FH]);

steps.push({ id: 'Wall', name: 'Extrude', type: 'extrude', source: wallSrc, distance: H, mode: 'join', target: 'Base' } as Feature);
({ errors } = await after(steps));
const vWall = vol(body('Base'));
const wallArea = hexArea(a0 + W) - hexArea(a0);
check('the wall on up to 15', !errors.length && bodies().size === 1 && near(vWall - vBase, wallArea * (H - FH), 1e-6 * vWall), [errors, vWall - vBase, wallArea * (H - FH)]);

// ---------------------------------------------------------------- the rounds
// The wall's top: two loops of six. Each round's spandrel ((1 - π/4)·r²) has its
// middle d = r·(10 - 3π)/(3·(4 - π)) in from its edge, into the wall.
const top = edgesOf('Base', m => near(m[2], H, 1e-6));
steps.push({ id: 'Round', name: 'Fillet', type: 'fillet', edges: top, radius: F } as Feature);
({ errors } = await after(steps));
const vRound = vol(body('Base'));
const d = (F * (10 - 3 * PI)) / (3 * (4 - PI));
const lost = (1 - PI / 4) * F * F * (hexLoop(a0 + W - d) + hexLoop(a0 + d));
check("the wall's top edges: rounded 0.5 inside and out", !errors.length && top.length === 12 && near(vWall - vRound, lost, 1e-4 * lost), [errors, top.length, vWall - vRound, lost]);
const [[x0, y0, z0], [x1, y1, z1]] = body('Base').boundingBox.bounds;
const rF = (2 * (a0 + FL)) / SQ3;
check("the cutter: the flange's corners across X, its flats across Y, 15 high", near(x0, -rF, 1e-3) && near(x1, rF, 1e-3) && near(y0, -(a0 + FL), 1e-3) && near(y1, a0 + FL, 1e-3) && near(z0, 0, 1e-4) && near(z1, H, 1e-4), body('Base').boundingBox.bounds);

// Rounds more than half the wall run into each other: refused in words, not patched.
{
  const big = steps.map(f => (f.id === 'Round' ? { ...f, radius: 1 } : f)) as Feature[];
  const { errors } = await after(big);
  check('rounds 1 on a 1.2 wall: too big, said so', errors.length === 1 && /too big/.test(errors[0]), errors);
  await after(steps);
}

const h = health(body('Base'), 'Base');
check('the cutter: sound, one body', h.healthy && bodies().size === 1, h.healthy ? `${Math.round(h.volume)} mm³` : h);
const codeVol = vol(body('Base'));
const codeFaces = body('Base').faces.length;
const codeBox = body('Base').boundingBox.bounds;
console.log('base', vBase.toFixed(1), 'wall', vWall.toFixed(1), 'final', codeVol.toFixed(1), 'faces', codeFaces);

// ---------------------------------------------- the cutter built by hand
// On a phone-sized screen (tests/fixtures/cookiecutter-hand.json): from the
// top, a Sketch and a polygon typed (6 sides, 30 to its corners), Offset Edge
// out 1.2 and out 5; both rings tapped, Extrude 2; from below the sketch shown
// again (Items), the inner ring tapped, Extrude 15 on Auto - which cut the ring
// out of the flange and added nothing past it, without a word (the sketch
// isn't on a face, so Auto saw a body in the way); Auto now adds to the body
// made from that same ring. From the top, Fillet, the wall's top face tapped
// (all twelve edges), Radius 0.5: on the way the rounds stood at 1, more than
// half the 1.2 wall, and came out "Repaired automatically" with a flat patch
// over where they met - now it says the size is too big. It comes out the same.
{
  const hand = JSON.parse(readFileSync(new URL('./fixtures/cookiecutter-hand.json', import.meta.url), 'utf8')).features as Feature[];
  const { errors } = await after(hand);
  check('by hand: no errors', errors.length === 0, errors);
  const Bs = [...bodies().values()].map(s => s as Shape3D);
  check('by hand: one body, sound', Bs.length === 1 && health(Bs[0], 'hand').healthy, Bs.length);
  check('by hand: the same cutter (to 0.1 %)', Bs.length === 1 && Math.abs(vol(Bs[0]) - codeVol) < codeVol * 1e-3, `${Bs[0] ? vol(Bs[0]).toFixed(1) : '-'} / ${codeVol.toFixed(1)}`);
  check('by hand: as many faces, the same box', Bs[0]?.faces.length === codeFaces && Bs[0].boundingBox.bounds.flat().every((x, i) => near(x, codeBox.flat()[i], 1e-3)), [Bs[0]?.faces.length, codeFaces, Bs[0]?.boundingBox.bounds]);
}

if (process.argv[2]) {
  writeFileSync(process.argv[2], JSON.stringify({ format: 'super', version: 2, name: 'Cookie cutter', features: steps }));
}
done();
