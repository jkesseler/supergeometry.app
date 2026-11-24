// Every sketch edit tool, checked for exact, closed, usable results.
// Run: npx tsx tests/sketchtools.test.ts [fuzzRounds] [seed]
import { arcFrom3, closestOnPrim, entityPrims, evalPrim } from '../src/sketch/curves';
import { alignLine, extend, filletCorner, filletEnds, joinCollinear, joinEnds, offsetChain, offsetEntity, splitAny, splitEntity, transformEntity, trim, uid } from '../src/sketch/edit';
import { mirrorXf, rotateXf, scaleXf } from '../src/sketch/edit';
import { arrangement } from '../src/sketch/regions';
import { pointsOf } from '../src/sketch/constraints';
import type { SketchEntity, Vec2 } from '../src/doc/types';

const ROUNDS = Number(process.argv[2] ?? 300);
let seed = Number(process.argv[3] ?? 1);
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const pick = <T>(a: T[]): T => a[Math.floor(rnd() * a.length)];

const line = (a: Vec2, b: Vec2, id = uid()): SketchEntity => ({ id, kind: 'line', a, b });
const circle = (center: Vec2, radius: number, id = uid()): SketchEntity => ({ id, kind: 'circle', center: center, radius: radius });
const rectLines = (x: number, y: number, width: number, height: number): SketchEntity[] => {
  const corners: Vec2[] = [[x, y], [x + width, y], [x + width, y + height], [x, y + height]];

  return corners.map((q, i) => line(q, corners[(i + 1) % 4]));
};

/** How far `point` is from the curve (exact for lines, arcs, circles). */
function distTo(e: SketchEntity, point: Vec2): number {
  if (e.kind === 'line') {
    const direction: Vec2 = [e.b[0] - e.a[0], e.b[1] - e.a[1]];
    const l2 = direction[0] * direction[0] + direction[1] * direction[1];
    const t = Math.max(0, Math.min(1, ((point[0] - e.a[0]) * direction[0] + (point[1] - e.a[1]) * direction[1]) / l2));

    return Math.hypot(point[0] - e.a[0] - direction[0] * t, point[1] - e.a[1] - direction[1] * t);
  }
  if (e.kind === 'circle') {
    return Math.abs(Math.hypot(point[0] - e.center[0], point[1] - e.center[1]) - e.radius);
  }
  if (e.kind === 'arc') {
    const arc = arcFrom3(e.a, e.m, e.b)!;

    return Math.abs(Math.hypot(point[0] - arc.c[0], point[1] - arc.c[1]) - arc.r);
  }

  return Math.min(...entityPrims(e).map(pr => closestOnPrim(pr, point).d));
}

const ends = (e: SketchEntity): Vec2[] => (e.kind === 'line' || e.kind === 'arc' ? [e.a, e.b] : []);

const fails: string[] = [];
const check = (name: string, ok: boolean, why = '') => {
  if (!ok) {
    fails.push(`${name}${why ? ': ' + why : ''}`);
  }
  console.log(ok ? 'ok  ' : 'FAIL', name, ok ? '' : why);
};

// ---------------------------------------------------------------- trim
{
  // Two overlapping circles: trimming one's inside piece leaves an arc whose
  // ends sit exactly on the other circle (else the outline has a gap).
  const a = circle([0, 0], 10, 'ca');
  const b = circle([12, 0], 10, 'cb');
  const out = trim([a, b], 'ca', [10, 0]);
  const arc = out.find(e => e.kind === 'arc')!;
  const err = Math.max(...ends(arc).map(end => distTo(b, end)));
  check('trim: arc ends exactly on the crossing circle', err < 1e-9, `off by ${err.toExponential(2)}`);
  const out2 = trim(out, 'cb', [2, 0]);
  const arcs = out2.filter(e => e.kind === 'arc');
  const gap = Math.max(...arcs[0] ? ends(arcs[0]).map(end => Math.min(...ends(arcs[1]).map(q => Math.hypot(end[0] - q[0], end[1] - q[1])))) : [Infinity]);
  check('trim: two circles trimmed to one outline meet exactly', gap < 1e-9, `gap ${gap.toExponential(2)}`);
  const reg = arrangement(out2).regions;
  check('trim: that outline is one region', reg.length === 1, `${reg.length} regions`);
}
{
  // A line across a circle, trimmed between: ends exactly on the circle.
  const sketchEntity = circle([0, 0], 7);
  const lineEntity = line([-20, 3], [20, 3.5]);
  const out = trim([sketchEntity, lineEntity], lineEntity.id, [0, 3.2]);
  const err = Math.max(...out.filter(e => e.kind === 'line').flatMap(e => ends(e).filter(end => Math.abs(end[0]) < 15).map(end => distTo(sketchEntity, end))));
  check('trim: line ends exactly on the circle', err < 1e-9, `off by ${err.toExponential(2)}`);
}
{
  // Two overlapping rectangles made of lines: trimming the inside pieces gives one region with the union's area.
  const r1 = rectLines(0, 0, 10, 10);
  const r2 = rectLines(5, 5, 10, 10);
  let es = [...r1, ...r2];
  const cut = (id: string, at: Vec2) => (es = trim(es, id, at));
  cut(r1[1].id, [10, 7]); // right side of r1, inside r2
  cut(r1[2].id, [7, 10]);
  const r2b = es.find(e => e.kind === 'line' && Math.abs(e.a[1] - 5) < 1e-9 && Math.abs(e.b[1] - 5) < 1e-9 && Math.max(e.a[0], e.b[0]) > 9)!;
  cut(r2b.id, [7, 5]);
  const r2l = es.find(e => e.kind === 'line' && Math.abs(e.a[0] - 5) < 1e-9 && Math.abs(e.b[0] - 5) < 1e-9 && Math.max(e.a[1], e.b[1]) > 9)!;
  cut(r2l.id, [5, 7]);
  const reg = arrangement(es).regions;
  check('trim: union of two rectangles is one region of area 175', reg.length === 1 && Math.abs(reg[0].area - 175) < 1e-6, `${reg.length} regions, areas ${reg.map(region => region.area.toFixed(3))}`);
}
{
  // Trimming a line keeps its id on the piece that keeps its start, so
  // constraints on that end (joins, dimensions) aren't thrown away.
  const sketchEntity = line([0, 0], [20, 0], 'keep');
  const x = line([10, -5], [10, 5]);
  const out = trim([sketchEntity, x], 'keep', [15, 0]);
  check("trim: the remaining piece keeps the curve's id", out.some(e => e.id === 'keep'), 'piece got a new id (its constraints are lost)');
}
{
  // Trim a rectangle entity's side: the other three sides stay, as lines.
  const sketchEntity: SketchEntity = { id: 'r', kind: 'rect', center: [0, 0], w: 10, h: 6, rotation: 0 };
  const out = trim([sketchEntity], 'r', [5, 0]);
  check('trim: rectangle side removed, three sides left', out.length === 3 && out.every(e => e.kind === 'line'), `${out.length} curves`);
}

// --------------------------------------------------------------- extend
{
  const sketchEntity = circle([30, 0], 5);
  const lineEntity = line([0, 1], [10, 1], 'e');
  const out = extend([lineEntity, sketchEntity], 'e', [9, 1])!;
  const e = out.find(sketchEntity => sketchEntity.id === 'e')!;
  const err = distTo(sketchEntity, (e as any).b);
  check('extend: line end lands exactly on the circle', err < 1e-9, `off by ${err.toExponential(2)}`);
}
{
  // Extend onto an ellipse / spline: lands on it (to drawing precision).
  const el: SketchEntity = { id: 'el', kind: 'ellipse', center: [30, 0], rx: 6, ry: 3, rotation: 0.4 };
  const sketchEntity = line([0, 0.5], [10, 0.5], 'e');
  const out = extend([sketchEntity, el], 'e', [9, 0.5])!;
  const err = distTo(el, (out.find(sketchEntity => sketchEntity.id === 'e') as any).b);
  check('extend: line end lands on an ellipse', err < 1e-6, `off by ${err.toExponential(2)}`);
}
{
  // An arc can extend too (along its circle), not only lines.
  const arc: SketchEntity = { id: 'a', kind: 'arc', a: [10, 0], m: [Math.SQRT1_2 * 10, Math.SQRT1_2 * 10], b: [0, 10] };
  const wall = line([-20, -5], [20, -5]);
  const out = extend([arc, wall], 'a', [1, 10]);
  check('extend: an arc extends along its circle to the next curve', !!out && distTo(wall, (out.find(sketchEntity => sketchEntity.id === 'a') as any).b) < 1e-9, out ? 'end not on the line' : 'refused');
}

// ------------------------------------------------------------- joinEnds
{
  const l1 = line([0, 0], [8, 0], 'p');
  const l2 = line([10, 2], [10, 10], 'q');
  const out = joinEnds([l1, l2], { id: 'p', at: [7, 0] }, { id: 'q', at: [10, 3] })!;
  const joined = out.find(e => e.id === 'p') as any;
  const q = out.find(e => e.id === 'q') as any;
  check('extend two: lines meet exactly at the corner', Math.hypot(joined.b[0] - 10, joined.b[1]) < 1e-12 && Math.hypot(q.a[0] - 10, q.a[1]) < 1e-12);
}

// ---------------------------------------------------------------- split
{
  const arc: SketchEntity = { id: 'a', kind: 'arc', a: [10, 0], m: [0, 10], b: [-10, 0] };
  const out = splitEntity([arc], 'a', 'n', [7.07, 7.07])!;
  const [first, q] = out as any[];
  const c1 = arcFrom3(first.a, first.m, first.b)!;
  const c2 = arcFrom3(q.a, q.m, q.b)!;
  check('split: arc halves meet and stay on the circle', Math.hypot(first.b[0] - q.a[0], first.b[1] - q.a[1]) < 1e-12 && Math.abs(c1.r - 10) < 1e-9 && Math.abs(c2.r - 10) < 1e-9);
  const circ = splitAny([circle([0, 0], 5, 'c')], 'c', [5, 0], 1, true, uid)!;
  check('split: circle becomes two arcs', circ.entities.length === 2 && circ.entities.every(e => e.kind === 'arc'));
}

// --------------------------------------------------------------- fillet
{
  const es = [line([0, 0], [20, 0], 'h'), line([20, 0], [20, 20], 'v')];
  const out = filletCorner(es, [20, 0], 4, 1e-6)!;
  const arc = out.find(e => e.kind === 'arc') as any;
  const arcInfo = arcFrom3(arc.a, arc.m, arc.b)!;
  check('fillet: arc tangent to both lines, radius exact', Math.abs(arcInfo.r - 4) < 1e-9 && Math.abs(arcInfo.c[1] - 4) < 1e-9 && Math.abs(20 - arcInfo.c[0] - 4) < 1e-9);
  // Fillet two lines that don't touch: extended to meet, then rounded.
  const gap = [line([0, 0], [15, 0], 'h'), line([20, 5], [20, 20], 'v')];
  const f2 = filletEnds(gap, { id: 'h', at: [14, 0] }, { id: 'v', at: [20, 6] }, 3);
  check("fillet: lines that don't meet are extended and rounded", !!f2 && f2.some(e => e.kind === 'arc'));
  // A fillet bigger than the corner allows: refused, not mangled.
  check('fillet: too big a radius is refused', filletCorner(es, [20, 0], 50, 1e-6) === null);
  // Line meeting an arc: fillet there too.
  const la = [line([-6, 18], [0, 10], 'l'), { id: 'a', kind: 'arc', a: [0, 10], m: [Math.SQRT1_2 * 10, Math.SQRT1_2 * 10], b: [10, 0] } as SketchEntity];
  const fla = filletCorner(la, [0, 10], 1, 1e-6);
  const fa = fla?.find(e => e.kind === 'arc' && e.id !== 'a') as any;
  const fc = fa && arcFrom3(fa.a, fa.m, fa.b);
  // Tangent to the line (centre 1 below it) and to the circle (centre 9 from its centre).
  const ln = fla?.find(e => e.id === 'l') as any;
  const dl = fc && Math.abs(((fc.c[0] - ln.a[0]) * (ln.b[1] - ln.a[1]) - (fc.c[1] - ln.a[1]) * (ln.b[0] - ln.a[0])) / Math.hypot(ln.b[0] - ln.a[0], ln.b[1] - ln.a[1]));
  const dc = fc && Math.abs(Math.hypot(...fc.c) - 10);
  const joined = fc && Math.hypot(ln.b[0] - fa.a[0], ln.b[1] - fa.a[1]) < 1e-9 && distTo(la[1], fa.b) < 1e-9;
  check('fillet: a line meeting an arc can be filleted, tangent to both', !!fc && Math.abs(fc.r - 1) < 1e-9 && Math.abs(dl - 1) < 1e-9 && Math.abs(dc - 1) < 1e-9 && !!joined, fc ? JSON.stringify({ fc, dl, dc, joined }) : 'refused');
  // Two arcs meeting at a corner.
  const aa = [{ id: 'p', kind: 'arc', a: [-10, 0], m: [-5, 5], b: [0, 0] } as SketchEntity, { id: 'q', kind: 'arc', a: [0, 0], m: [5, 5], b: [10, 0] } as SketchEntity];
  check('fillet: two arcs meeting can be filleted', !!filletCorner(aa, [0, 0], 1, 1e-6));
  const big = filletCorner(la, [0, 10], 500, 1e-6);
  check('fillet: line–arc fillet too big for the curves is refused', big === null);
}

// --------------------------------------------------------------- offset
{
  const rectangle = rectLines(0, 0, 10, 6);
  const out = offsetChain(rectangle, rectangle[0].id, 1)!;
  const made = out.slice(4);
  const reg = arrangement(made).regions;
  check('offset chain: rectangle grows to 12×8, still closed', reg.length === 1 && Math.abs(reg[0].area - 96) < 1e-9, `${reg.length} regions ${reg.map(region => region.area)}`);
  const inner = offsetChain(rectangle, rectangle[0].id, -1)!.slice(4);
  const ri = arrangement(inner).regions;
  check('offset chain: inward to 8×4', ri.length === 1 && Math.abs(ri[0].area - 32) < 1e-9, `${ri.map(region => region.area)}`);
  // Inward past half the width: refused (not an inside-out outline).
  const bad = offsetChain(rectangle, rectangle[0].id, -4);
  const br = bad ? arrangement(bad.slice(4)).regions : [];
  check('offset chain: too far inward is refused', !bad || br.length === 0, `gave ${br.length} regions of ${br.map(region => region.area.toFixed(2))}`);
  // Rounded rectangle (lines + fillets) offset out: stays closed, arcs grow.
  let rr: SketchEntity[] = rectLines(0, 0, 20, 10);
  for (const at of [[20, 0], [20, 10], [0, 10], [0, 0]] as Vec2[]) {
    rr = filletCorner(rr, at, 2, 1e-6)!;
  }
  const ro = offsetChain(rr, rr[0].id, 1)!.slice(rr.length);
  const rreg = arrangement(ro).regions;
  const want = 22 * 12 - (4 - Math.PI) * 9;
  check('offset chain: rounded rectangle stays closed, exact area', rreg.length === 1 && Math.abs(rreg[0].area - want) < 0.05, `${rreg.map(region => region.area.toFixed(3))} want ${want.toFixed(3)}`);
  // Offset inward by more than the fillet radius: the arc would turn inside out.
  const rin = offsetChain(rr, rr[0].id, -3);
  const rinr = rin ? arrangement(rin.slice(rr.length)).regions : [];
  check("offset chain: inward past a fillet's radius gives a sharp 14×4 outline", !!rin && rinr.length === 1 && Math.abs(rinr[0].area - 56) < 1e-6, rin ? `${rinr.length} regions ${rinr.map(region => region.area.toFixed(2))}` : 'refused');
  // Single circle / line offsets.
  const oc = offsetEntity(circle([0, 0], 3), -3);
  check('offset: circle offset to nothing is refused', oc === null);
}

// ------------------------------------------------------- align / join
{
  const es = [line([0, 0], [10, 0], 'a'), line([10, 0], [10.2, 8], 's'), line([10.2, 8], [0, 8], 't'), line([20, -3], [20, 20], 'target')];
  const out = alignLine(es, 's', es[3])!;
  const aligned = out.find(e => e.id === 's') as any;
  const a = out.find(e => e.id === 'a') as any;
  check("align: side moves onto the target's line, neighbours follow", Math.abs(aligned.a[0] - 20) < 1e-9 && Math.abs(aligned.b[0] - 20) < 1e-9 && Math.abs(a.b[0] - 20) < 1e-9);
  const j = joinCollinear([line([0, 0], [5, 0], 'x'), line([5, 0], [9, 0], 'y')], 'x')!;
  check('join: two lines on one axis become one', j.entities.length === 1 && (j.entities[0] as any).b[0] === 9);
}

// ------------------------------------------- mirror / rotate / scale
{
  const arc: SketchEntity = { id: 'a', kind: 'arc', a: [10, 0], m: [Math.SQRT1_2 * 10, Math.SQRT1_2 * 10], b: [0, 10] };
  const mirrored = transformEntity(arc, mirrorXf([0, 0], [0, 1]), true) as any;
  const arcInfo = arcFrom3(mirrored.a, mirrored.m, mirrored.b)!;
  check('mirror: arc mirrored stays the same circle', Math.abs(arcInfo.r - 10) < 1e-3 && Math.abs(arcInfo.c[0]) < 1e-3);
  const el: SketchEntity = { id: 'e', kind: 'ellipse', center: [5, 0], rx: 4, ry: 2, rotation: 0.3 };
  const me = transformEntity(el, mirrorXf([0, 0], [0, 1]), true) as any;
  check('mirror: ellipse mirrored keeps its size, flips its tilt', me.kind === 'ellipse' && Math.abs(me.center[0] + 5) < 1e-9 && Math.abs(Math.sin(me.rotation + 0.3)) < 1e-9, JSON.stringify(me));
  const rc: SketchEntity = { id: 'r', kind: 'rect', center: [5, 0], w: 4, h: 2, rotation: 0 };
  const rr = transformEntity(rc, rotateXf([0, 0], Math.PI / 2), true) as any;
  check('rotate: rectangle turns about the pivot', rr.kind === 'rect' && Math.abs(rr.center[1] - 5) < 1e-9 && Math.abs(rr.center[0]) < 1e-9, JSON.stringify(rr));
  const sc = transformEntity(circle([2, 0], 3), scaleXf([0, 0], 2), true) as any;
  check('scale: circle scales about the centre', Math.abs(sc.radius - 6) < 1e-12 && Math.abs(sc.center[0] - 4) < 1e-12);
}


// ------------------------------------------- constraints follow edits
{
  const { carryConstraints } = await import('../src/sketch/edit');
  const rectangle = rectLines(0, 0, 10, 6);
  const cut = line([5, -3], [5, 9], 'cut');
  const co = (a: string, pa: string, b: string, pb: string) => ({ id: uid(), type: 'coincident' as const, pts: [{ e: a, p: pa }, { e: b, p: pb }] });
  const cs = [co(rectangle[0].id, 'b', rectangle[1].id, 'a'), co(rectangle[1].id, 'b', rectangle[2].id, 'a'), co(rectangle[2].id, 'b', rectangle[3].id, 'a'), co(rectangle[3].id, 'b', rectangle[0].id, 'a'),
    { id: 'hb', type: 'horizontal' as const, curves: [rectangle[0].id] }, { id: 'len', type: 'dim' as const, curves: [rectangle[0].id], prop: 'length', value: 10 }];
  const before = [...rectangle, cut];
  // Cut away the bottom side's right half: the left piece keeps the join at (0,0) and Horizontal; the length no longer holds.
  const after = trim(before, rectangle[0].id, [8, 0]);
  const kept = carryConstraints(before, after, cs);
  const has = (id: string) => kept.some(sketchConstraint => sketchConstraint.id === id);
  check('trim keeps the join at the kept end and Horizontal, drops the stale length', has(cs[3].id) && has('hb') && !has('len') && !has(cs[0].id), JSON.stringify(kept.map(sketchConstraint => sketchConstraint.id)));
  // Cut the middle out of the bottom: both corner joins carry over, each to its own piece.
  const after2 = trim(trim([...before, line([3, -3], [3, 9], 'cut2')], rectangle[0].id, [4, 0]), 'cut2', [3, 20]);
  const kept2 = carryConstraints(before, after2, cs);
  check('trim out the middle: both corners stay joined (to their pieces)', kept2.some(sketchConstraint => sketchConstraint.id === cs[0].id) && kept2.some(sketchConstraint => sketchConstraint.id === cs[3].id), JSON.stringify(kept2.map(sketchConstraint => sketchConstraint.pts)));
}


// --------------------------------------------- chamfer, centre arcs
{
  const { chamferCorner, chamferEnds, chamferConstraints, centreArc, filletConstraints } = await import('../src/sketch/edit');
  const { solve, constraintError } = await import('../src/sketch/constraints');
  const es = [line([0, 0], [20, 0], 'h'), line([20, 0], [20, 20], 'v')];
  const ch = chamferCorner(es, [20, 0], 3, 1e-6)!;
  const cut = ch.find(e => e.id !== 'h' && e.id !== 'v') as any;
  check('chamfer: corner cut back 3 on each line', !!cut && Math.hypot(cut.a[0] - 17, cut.a[1]) < 1e-12 && Math.hypot(cut.b[0] - 20, cut.b[1] - 3) < 1e-12, JSON.stringify(cut));
  check('chamfer: too far back is refused', chamferCorner(es, [20, 0], 25, 1e-6) === null);
  const rect: SketchEntity = { id: 'r', kind: 'rect', center: [0, 0], w: 10, h: 6, rotation: 0 };
  const rc = chamferCorner([rect], [5, 3], 1, 1e-6);
  check("chamfer: a rectangle's corner (it comes apart into lines)", !!rc && rc.length === 5);
  const gap = [line([0, 0], [15, 0], 'h'), line([20, 5], [20, 20], 'v')];
  check("chamfer: two lines that don't meet are extended, then cut", !!chamferEnds(gap, { id: 'h', at: [14, 0] }, { id: 'v', at: [20, 6] }, 2));
  const cs = chamferConstraints(ch, [{ id: 'k', type: 'coincident', pts: [{ e: 'h', p: 'b' }, { e: 'v', p: 'a' }] }], new Set(['h', 'v']));
  check('chamfer: joined to both lines, old corner join gone', cs.length === 2 && !cs.some(sketchConstraint => sketchConstraint.id === 'k') && constraintError(ch, cs) < 1e-12);
  const arc = centreArc('x', [0, 0], [10, 0], [0, 5])! as any;
  const arcInfo = arcFrom3(arc.a, arc.m, arc.b)!;
  check('centre arc: radius from the start point, a quarter turn to the end direction', Math.abs(arcInfo.r - 10) < 1e-12 && Math.abs(arcInfo.sweep - Math.PI / 2) < 1e-9 && Math.abs(arc.b[1] - 10) < 1e-9);
  const cw = centreArc('y', [0, 0], [10, 0], [0, -5])! as any;
  check('centre arc: the other way round', (arcFrom3(cw.a, cw.m, cw.b)!.sweep) < 0);
  // A line–arc fillet gets joins + tangency + its radius, and solves as it stands.
  const la = [line([-6, 18], [0, 10], 'l'), { id: 'a', kind: 'arc', a: [0, 10], m: [Math.SQRT1_2 * 10, Math.SQRT1_2 * 10], b: [10, 0] } as SketchEntity];
  const fl = filletCorner(la, [0, 10], 1, 1e-6)!;
  const fcs = filletConstraints(fl, [{ id: 'j', type: 'coincident', pts: [{ e: 'l', p: 'b' }, { e: 'a', p: 'a' }] }], new Set(['l', 'a']));
  check('fillet line–arc: constraints hold (joined, tangent, radius) and the old join is gone', !fcs.some(face => face.id === 'j') && fcs.filter(face => face.type === 'tangent').length === 2 && constraintError(fl, fcs) < 1e-9 && solve(fl, fcs).ok, JSON.stringify(fcs.map(face => face.type)));
}

// ------------------------------------------------------------ fuzz
// Random curves, random tools: nothing may come out broken.
let opsOk = 0;
let dumped = false;
let opsNull = 0;
const why = new Map<string, number>();
for (let round = 0; round < ROUNDS; round++) {
  const es: SketchEntity[] = [];
  const count = 2 + Math.floor(rnd() * 4);
  const randomPoint = (): Vec2 => [(rnd() - 0.5) * 40, (rnd() - 0.5) * 40];
  for (let i = 0; i < count; i++) {
    const kind = pick(['line', 'line', 'circle', 'arc', 'rect']);
    if (kind === 'line') {
      es.push(line(randomPoint(), randomPoint()));
    } else if (kind === 'circle') {
      es.push(circle(randomPoint(), 2 + rnd() * 10));
    } else if (kind === 'rect') {
      es.push({ id: uid(), kind: 'rect', center: randomPoint(), w: 3 + rnd() * 15, h: 3 + rnd() * 15, rotation: rnd() * 3 });
    } else {
      const center = randomPoint();
      const radius = 3 + rnd() * 10;
      const a0 = rnd() * 6;
      const sw = 0.5 + rnd() * 4;
      const at = (t: number): Vec2 => [center[0] + radius * Math.cos(t), center[1] + radius * Math.sin(t)];
      es.push({ id: uid(), kind: 'arc', a: at(a0), m: at(a0 + sw / 2), b: at(a0 + sw) });
    }
  }
  const e = pick(es);
  const tap = (): Vec2 => {
    const pr = entityPrims(e)[0];

    return evalPrim(pr, 0.05 + rnd() * 0.9);
  };
  const op = pick(['trim', 'extend', 'split', 'offset', 'fillet', 'join']);
  let out: SketchEntity[] | null = null;
  try {
    if (op === 'trim') {
      out = trim(es, e.id, tap());
    } else if (op === 'extend') {
      out = extend(es, e.id, tap());
    } else if (op === 'split') {
      out = splitAny(es, e.id, tap(), 1, rnd() < 0.5, uid)?.entities ?? null;
    } else if (op === 'offset') {
      out = e.kind === 'line' || e.kind === 'arc'
        ? offsetChain(es, e.id, (rnd() - 0.5) * 6)
        : (() => {
          const offset = offsetEntity(e, (rnd() - 0.5) * 6);

          return offset ? [...es, offset] : null; 
        })();
    } else if (op === 'fillet') {
      const pts = es.flatMap(ends);
      out = pts.length ? filletCorner(es, pick(pts), 0.5 + rnd() * 3, 1e-6) : null;
    } else {
      const sketchEntity = pick(es);
      out = joinEnds(es, { id: e.id, at: tap() }, { id: sketchEntity.id, at: evalPrim(entityPrims(sketchEntity)[0], rnd()) });
    }
  } catch (err) {
    fails.push(`fuzz ${op}: threw ${(err as Error).message}`);
    continue;
  }
  if (!out) {
    opsNull++;
    continue;
  }
  opsOk++;
  // Broken: NaN, a curve of no size, a degenerate arc.
  let bad = '';
  for (const x of out) {
    const nums: unknown[] = [];
    JSON.parse(JSON.stringify(x, (_k, value) => (typeof value === 'number' && !Number.isFinite(value) ? 'NaN' : value)), (_k, value) => (nums.push(value), value));
    if (nums.some(number => number === 'NaN' || number === null)) {
      bad = `${x.kind} has NaN`;
    }
    if (x.kind === 'line' && Math.hypot(x.b[0] - x.a[0], x.b[1] - x.a[1]) < 1e-9) {
      bad = 'zero-length line';
    }
    if (x.kind === 'arc' && !arcFrom3(x.a, x.m, x.b)) {
      bad = 'degenerate arc';
    }
    if (x.kind === 'circle' && !(x.radius > 1e-9)) {
      bad = 'zero circle';
    }
  }
  // Trim / extend: every new end sits exactly on another curve (else the outline has a gap).
  if (!bad && (op === 'trim' || op === 'extend')) {
    const before = es.flatMap(sketchEntity => pointsOf(sketchEntity).map(q => q.at));
    for (const x of out) {
      for (const end of ends(x)) {
        if (before.some(q => Math.hypot(q[0] - end[0], q[1] - end[1]) < 1e-9)) {
          continue;
        }
        const distance = Math.min(...out.filter(sketchEntity => sketchEntity.id !== x.id && !(sketchEntity.kind === 'line' && x.kind === 'line' && false)).map(sketchEntity => distTo(sketchEntity, end)));
        const sc = Math.max(1, Math.abs(end[0]), Math.abs(end[1]));
        if (distance > 1e-9 * sc) {
          bad = 'new end off the curve it meets';
          if (process.env.ST_DUMP && !dumped) {
            dumped = true;
            console.log('DUMP', e.id, JSON.stringify(es), ' OUT', JSON.stringify(out), ' END', JSON.stringify(end), x.id);
          }
        }
      }
    }
  }
  if (bad) {
    why.set(`${op}: ${bad}`, (why.get(`${op}: ${bad}`) ?? 0) + 1);
    fails.push(`fuzz ${op} on ${e.kind}: ${bad}`);
  }
}
console.log(`fuzz: ${opsOk} edits made, ${opsNull} not possible there; broken: ${JSON.stringify([...why])}`);
console.log(fails.length ? `${fails.length} FAILED` : 'all ok');
process.exit(fails.length ? 1 : 0);
