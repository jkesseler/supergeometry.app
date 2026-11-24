// Run: npx tsx tests/fillpattern.test.ts
// Fill Pattern: a closed shape of a sketch filled with lines from edge to edge, or with small shapes inside it.
// The lines end exactly on the shape's edge (so the strips between them are closed shapes to extrude), stay out of
// holes, follow the shape when it changes - and the engine builds solids from what they make.
import { FILL_KINDS, FILL_MOST, fillCurves, fillOf, fillRegion, refill, withoutFills } from '../src/sketch/fill';
import { arrangement, regionRef } from '../src/sketch/regions';
import { entityCorners, entityPrims, evalPrim } from '../src/sketch/curves';
import { after, bodies, check, done, health, near, sketch, volume, XY, circle, rect } from './kit';
import type { Feature, SketchEntity, SketchFill, Vec2 } from '../src/doc/types';
import type { Shape3D } from 'replicad';

const RECT = [rect('r', 0, 0, 40, 20)];
const fill = (kind: SketchFill['kind'], extra: Partial<SketchFill> = {}): SketchFill => ({ id: 'f1', at: [20, 10], kind, spacing: 5, angle: 0, size: 4, ...extra });
const ends = (e: SketchEntity): Vec2[] => entityPrims(e).flatMap(entityPrim => [evalPrim(entityPrim, 0), evalPrim(entityPrim, 1)]);
const onRect = (point: Vec2, width = 40, height = 20) => (Math.abs(point[0]) < 1e-7 || Math.abs(point[0] - width) < 1e-7 || Math.abs(point[1]) < 1e-7 || Math.abs(point[1] - height) < 1e-7) && point[0] > -1e-7 && point[0] < width + 1e-7 && point[1] > -1e-7 && point[1] < height + 1e-7;
const inRect = (point: Vec2, width = 40, height = 20) => point[0] > -1e-7 && point[0] < width + 1e-7 && point[1] > -1e-7 && point[1] < height + 1e-7;

check('a point in the rectangle is in a closed shape; one outside is in none', !!fillRegion(RECT, [20, 10]) && !fillRegion(RECT, [50, 10]));

// ---- lines
{
  const got = fillCurves(RECT, fill('lines'))!;
  const ys = got.curves.map(e => (e as { a: Vec2 }).a[1]).sort((a, b) => a - b);
  check('lines 5 apart in a 40 x 20 rectangle: three, at 5, 10 and 15, each from edge to edge', got.curves.length === 3 && ys.join() === '5,10,15' && got.curves.every(e => e.kind === 'line' && ends(e).every(end => onRect(end))), JSON.stringify(got.curves.map(e => ends(e))));
  check('  named for their fill', got.curves.every(e => fillOf(e.id) === 'f1'));
  const arr = arrangement([...RECT, ...got.curves]);
  check('  the rectangle is four strips now, 200 mm² each', arr.regions.length === 4 && arr.regions.every(region => near(region.area, 200, 1e-6)), arr.regions.map(region => region.area.toFixed(2)).join());
  const wide = fillCurves(RECT, fill('lines', { spacing: 2 }))!;
  check('  2 apart: nine', wide.curves.length === 9);
  const slant = fillCurves(RECT, fill('lines', { angle: 45 }))!;
  check("  at 45 degrees: every end on the rectangle's edge, each line at 45", slant.curves.length > 5 && slant.curves.every(e => ends(e).every(end => onRect(end)) && near(Math.abs(((e as { b: Vec2 }).b[1] - (e as { a: Vec2 }).a[1]) / ((e as { b: Vec2 }).b[0] - (e as { a: Vec2 }).a[0])), 1, 1e-9)), `${slant.curves.length} lines`);
}
// ---- crossed lines
{
  const got = fillCurves(RECT, fill('cross'))!;
  const arr = arrangement([...RECT, ...got.curves]);
  check('crossed lines 5 apart: three one way, seven the other, 32 squares of 25 mm²', got.curves.length === 10 && arr.regions.length === 32 && arr.regions.every(region => near(region.area, 25, 1e-6)), `${got.curves.length} lines, ${arr.regions.length} regions`);
}
// ---- in a circle: the ends on the circle exactly
{
  const circleEntities = [circle('c', 0, 0, 10)];
  const got = fillCurves(circleEntities, fill('lines', { at: [0, 0], spacing: 3, angle: 30 }))!;
  const worst = Math.max(...got.curves.flatMap(e => ends(e).map(end => Math.abs(Math.hypot(end[0], end[1]) - 10))));
  check('lines in a circle: every end on the circle (to a millionth of a mm)', got.curves.length === 7 && worst < 1e-6, `${got.curves.length} lines, worst ${worst.toExponential(1)}`);
  check('  and the circle is eight closed pieces', arrangement([...circleEntities, ...got.curves]).regions.length === 8);
}
// ---- a shape with a hole: the lines stop at the hole
{
  const holed = [...RECT, circle('h', 20, 10, 4)];
  const got = fillCurves(holed, fill('lines', { at: [5, 10] }))!;
  const mid = got.curves.filter(e => near((e as { a: Vec2 }).a[1], 10, 1e-9));
  check('a rectangle with a round hole: the middle line is two, stopping at the hole (x 16 and 24)', got.curves.length === 4 && mid.length === 2 && mid.flatMap(ends).map(point => +point[0].toFixed(6)).sort((a, b) => a - b).join() === '0,16,24,40', JSON.stringify(mid.map(ends)));
  check('  a point in the hole fills the hole, not the plate', fillRegion(holed, [20, 10])!.area < 60);
}
// ---- zigzag and waves: edge to edge, and closed strips between rows
for (const kind of ['zigzag', 'waves'] as const) {
  const got = fillCurves(RECT, fill(kind, { spacing: 6, size: 4 }))!;
  const all = got.curves.flatMap(ends);
  const arr = arrangement([...RECT, ...got.curves]);
  check(`${kind}: every piece inside, its loose ends on the edge, the rectangle in closed strips`, got.curves.length > 20 && all.every(point => inRect(point)) && all.filter(point => onRect(point)).length >= 6 && arr.regions.length >= 4 && near(arr.regions.reduce((total, region) => total + region.area, 0), 800, 1e-3), `${got.curves.length} pieces, ${arr.regions.length} regions, ${arr.regions.reduce((total, region) => total + region.area, 0).toFixed(3)} mm²`);
}
// ---- shapes: all wholly inside, the gap as asked
{
  const dots = fillCurves(RECT, fill('dots', { size: 4, spacing: 2 }))!;
  const cs = dots.curves.map(e => (e as { center: Vec2 }).center);
  let least = Infinity;
  for (let i = 0; i < cs.length; i++) {
    for (let j = i + 1; j < cs.length; j++) {
      least = Math.min(least, Math.hypot(cs[i][0] - cs[j][0], cs[i][1] - cs[j][1]));
    }
  }
  check('dots 4 across, 2 between: all inside the rectangle, none nearer another than 2', dots.curves.length >= 15 && dots.curves.every(e => e.kind === 'circle' && cs.every(center => center[0] >= 2 - 1e-9 && center[0] <= 38 + 1e-9 && center[1] >= 2 - 1e-9 && center[1] <= 18 + 1e-9)) && near(least, 6, 1e-9), `${dots.curves.length} dots, nearest centres ${least.toFixed(4)}`);
  for (const kind of ['hex', 'squares', 'diamonds'] as const) {
    const got = fillCurves(RECT, fill(kind, { size: 4, spacing: 1.5 }))!;
    const corners = got.curves.flatMap(e => entityCorners(e as Extract<SketchEntity, { kind: 'polygon' }>));
    const arr = arrangement([...RECT, ...got.curves]);
    check(`${kind}: all inside, each a closed shape of its own (${got.curves.length})`, got.curves.length >= 8 && corners.every(corner => inRect(corner)) && arr.regions.length === got.curves.length + 1, `${arr.regions.length} regions`);
  }
  const sq = fillCurves(RECT, fill('squares', { size: 4, spacing: 1 }))!;
  const first = entityCorners(sq.curves[0] as Extract<SketchEntity, { kind: 'polygon' }>);
  check('  squares 4 a side', near(Math.hypot(first[1][0] - first[0][0], first[1][1] - first[0][1]), 4, 1e-9));
  const hx = fillCurves(RECT, fill('hex', { size: 4, spacing: 1 }))!;
  const hc = entityCorners(hx.curves[0] as Extract<SketchEntity, { kind: 'polygon' }>);
  check('  a honeycomb cell 4 across its flats', near(Math.hypot(hc[0][0] - hc[2][0], hc[0][1] - hc[2][1]), 4, 1e-9), Math.hypot(hc[0][0] - hc[2][0], hc[0][1] - hc[2][1]).toFixed(4));
}
// ---- far too many: none made, and said
{
  const got = fillCurves(RECT, fill('lines', { spacing: 0.001 }))!;
  check('lines a thousandth apart: none made (too many)', !!got.tooMany && !got.curves.length);
  const most = fillCurves(RECT, fill('dots', { size: 0.05, spacing: 0.05 }))!;
  check('dots a twentieth across: none made (too many)', !!most.tooMany && most.curves.length <= FILL_MOST);
}
// ---- the shape changes: the pattern follows
{
  const sketchFill = fill('lines');
  const before = refill(RECT, [sketchFill]);
  const bigger = refill([rect('r', 0, 0, 60, 30), ...before.filter(e => e.id !== 'r')], [sketchFill]);
  const lines = bigger.filter(e => fillOf(e.id) === 'f1');
  check('the rectangle made 60 x 30: five lines now, each 60 long', withoutFills(bigger).length === 1 && lines.length === 5 && lines.every(e => ends(e).every(end => onRect(end, 60, 30))), `${lines.length} lines`);
  check('the fill taken away: its lines go', refill(bigger, []).length === 1);
  const gone = refill(before.filter(e => e.id !== 'r'), [sketchFill]);
  check('the shape itself deleted: the lines it had stay as they were', gone.length === 3);
  check('every kind is offered once', new Set(FILL_KINDS.map(kind => kind.id)).size === 8);
}
// ---- the engine: the strips are shapes to extrude
{
  const sketchFill = fill('lines');
  const ents = refill(RECT, [sketchFill]);
  const sk = { ...sketch('S', XY(), ents), fills: [sketchFill] } as Feature;
  const regions = arrangement(ents).regions.map(regionRef);
  const every = { id: 'E', name: 'E', type: 'extrude', source: { kind: 'profile', sketch: 'S', regions }, distance: 3, mode: 'new' } as unknown as Feature;
  const result = await after([sk, every]);
  const vol = [...bodies().values()].reduce((total, b) => total + volume(b as Shape3D), 0);
  check('all four strips extruded 3: 2400 mm³, sound', !result.errors.length && near(vol, 2400, 1e-3) && [...bodies().values()].every(b => health(b as Shape3D).healthy), `${vol.toFixed(2)} ${result.errors.join('; ')}`);
  const two = { ...every, source: { kind: 'profile', sketch: 'S', regions: regions.filter((_, i) => i % 2 === 0) } } as unknown as Feature;
  const r2 = await after([sk, two]);
  const v2 = [...bodies().values()].reduce((total, b) => total + volume(b as Shape3D), 0);
  check('every other strip: two ribs, 1200 mm³', !r2.errors.length && near(v2, 1200, 1e-3), `${v2.toFixed(2)} ${r2.errors.join('; ')}`);
  const hexes = refill(RECT, [fill('hex', { size: 4, spacing: 1.5 })]);
  const cells = arrangement(hexes).regions.filter(region => region.area < 100).map(regionRef);
  const r3 = await after([{ ...sketch('S', XY(), hexes) } as Feature, { ...every, source: { kind: 'profile', sketch: 'S', regions: cells } } as unknown as Feature]);
  const v3 = [...bodies().values()].reduce((total, b) => total + volume(b as Shape3D), 0);
  const cell = (Math.sqrt(3) / 2) * 16;
  check("a honeycomb's cells extruded 3: each cell's area times 3", !r3.errors.length && near(v3, cells.length * cell * 3, 1e-2), `${cells.length} cells, ${v3.toFixed(2)} for ${(cells.length * cell * 3).toFixed(2)} ${r3.errors.join('; ')}`);
}
done();
