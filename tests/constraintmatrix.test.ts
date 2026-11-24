// Run: npx tsx tests/constraintmatrix.test.ts
// Every constraint on every kind of curve it is offered for: once it is taken, it has to be TRUE - measured here
// from the curves themselves, not by the solver's own residuals (a constraint whose residual is always 0 "solves"
// and does nothing). And one constraint on free curves can always be met: none may be refused.
import { addForUser, applicable, pointOf, pointsOf, sizeOf, solve } from '../src/sketch/constraints';
import { arcFrom3, entityPolylines } from '../src/sketch/curves';
import type { ConstraintType, PointRef, SketchConstraint, SketchEntity, Vec2 } from '../src/doc/types';

let seed = 7;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
const between = (lo: number, hi: number) => lo + (hi - lo) * rnd();
const randomPoint = (): Vec2 => [between(-40, 40), between(-40, 40)];

const KINDS = ['line', 'arc', 'circle', 'ellipse', 'ellarc', 'rect', 'polygon', 'spline', 'polyline'] as const;
type Kind = (typeof KINDS)[number];

function make(kind: Kind, id: string): SketchEntity {
  const center = randomPoint();
  switch (kind) {
    case 'line': {
      const a = between(0, 6.28);
      const length = between(8, 30);

      return { id, kind: 'line', a: center, b: [center[0] + length * Math.cos(a), center[1] + length * Math.sin(a)] };
    }
    case 'arc': {
      const radius = between(5, 20);
      const a0 = between(0, 6.28);
      const sw = between(0.6, 4) * (rnd() < 0.5 ? -1 : 1);
      const at = (t: number): Vec2 => [center[0] + radius * Math.cos(t), center[1] + radius * Math.sin(t)];

      return { id, kind: 'arc', a: at(a0), m: at(a0 + sw / 2), b: at(a0 + sw) };
    }
    case 'circle':
      return { id, kind: 'circle', center: center, radius: between(4, 18) };
    case 'ellipse':
      return { id, kind: 'ellipse', center: center, rx: between(8, 20), ry: between(3, 7), rotation: between(0, 3.14) };
    case 'ellarc':
      return { id, kind: 'ellipse', center: center, rx: between(8, 20), ry: between(3, 7), rotation: between(0, 3.14), a0: between(0, 6.28), sweep: between(1, 4) };
    case 'rect':
      return { id, kind: 'rect', center: center, w: between(6, 30), h: between(6, 30), rotation: between(0, 3.14) };
    case 'polygon':
      return { id, kind: 'polygon', center: center, radius: between(6, 18), sides: 3 + Math.floor(rnd() * 5), angle: between(0, 6.28) };
    case 'spline':
      return { id, kind: 'spline', points: [center, [center[0] + 10, center[1] + between(-8, 8)], [center[0] + 20, center[1] + between(-8, 8)], [center[0] + 30, center[1] + between(-8, 8)]], closed: false, mode: 'fit' };
    case 'polyline':
      return { id, kind: 'polyline', points: [center, [center[0] + 10, center[1] + between(-8, 8)], [center[0] + 20, center[1] + between(-8, 8)]], closed: false };
  }
}

// ---- measured from the curves themselves
const dPL = (point: Vec2, a: Vec2, b: Vec2) => Math.abs((point[0] - a[0]) * (b[1] - a[1]) - (point[1] - a[1]) * (b[0] - a[0])) / Math.hypot(b[0] - a[0], b[1] - a[1]);
const dPS = (point: Vec2, a: Vec2, b: Vec2) => {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const t = Math.max(0, Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)));

  return Math.hypot(point[0] - a[0] - t * dx, point[1] - a[1] - t * dy);
};
const round = (e: SketchEntity) => (e.kind === 'circle'
  ? { c: e.center, r: e.radius }
  : e.kind === 'arc'
    ? (() => {
      const a = arcFrom3(e.a, e.m, e.b)!;

      return { c: a.c, r: a.r }; 
    })()
    : null);
/** A whole ellipse's points (its own formula), finely. */
const ellPts = (e: Extract<SketchEntity, { kind: 'ellipse' }>, count = 20000): Vec2[] =>
  Array.from({ length: count }, (_, i) => {
    const t = (i / count) * 2 * Math.PI;
    const x = e.rx * Math.cos(t);
    const y = e.ry * Math.sin(t);

    return [e.center[0] + x * Math.cos(e.rotation) - y * Math.sin(e.rotation), e.center[1] + x * Math.sin(e.rotation) + y * Math.cos(e.rotation)] as Vec2;
  });
/** How far a point is from the curve as it is drawn (a line, a circle and an ellipse: the whole of it, as CAD does). */
function distTo(point: Vec2, e: SketchEntity): number {
  if (e.kind === 'line') {
    return dPL(point, e.a, e.b);
  }
  const circle = round(e);
  if (circle) {
    return Math.abs(Math.hypot(point[0] - circle.c[0], point[1] - circle.c[1]) - circle.r);
  }
  if (e.kind === 'ellipse') {
    const q = ellPts(e, 4000);

    return Math.min(...q.map((a, i) => dPS(point, a, q[(i + 1) % q.length])));
  }
  let best = Infinity;
  for (const poly of entityPolylines(e)) {
    for (let i = 0; i + 1 < poly.length; i++) {
      best = Math.min(best, dPS(point, poly[i], poly[i + 1]));
    }
  }

  return best;
}
const dir = (e: SketchEntity) => (e.kind === 'line' ? ([e.b[0] - e.a[0], e.b[1] - e.a[1]] as Vec2) : null);
const centre = (e: SketchEntity): Vec2 | null => ('center' in e ? e.center : (round(e)?.c ?? null));

const TOL = 1e-5;
/** Is the constraint true of these curves? (null: nothing here knows how to measure it - a finding by itself.) */
function holds(sketchConstraint: SketchConstraint, es: SketchEntity[]): boolean | null {
  const get = (id: string) => es.find(e => e.id === id)!;
  const pt = (pointRef: PointRef) => pointOf(get(pointRef.e), pointRef.p)!;
  const cv = (sketchConstraint.curves ?? []).map(get);
  const pts = (sketchConstraint.pts ?? []).map(pt);
  switch (sketchConstraint.type) {
    case 'coincident':
      if (pts.length === 2) {
        return Math.hypot(pts[0][0] - pts[1][0], pts[0][1] - pts[1][1]) < TOL;
      }

      return distTo(pts[0], cv[0]) < (cv[0].kind === 'ellipse' ? 1e-4 : TOL);
    case 'horizontal':
    case 'vertical': {
      const axis = sketchConstraint.type === 'horizontal' ? 1 : 0;
      if (cv.length) {
        return Math.abs(dir(cv[0])![axis]) < TOL;
      }

      return Math.abs(pts[0][axis] - pts[1][axis]) < TOL;
    }
    case 'parallel':
    case 'perpendicular': {
      const [dirA, dirB] = cv.map(e => dir(e)!);
      const lu = Math.hypot(...dirA);
      const lv = Math.hypot(...dirB);

      return Math.abs(sketchConstraint.type === 'parallel' ? (dirA[0] * dirB[1] - dirA[1] * dirB[0]) / lu / lv : (dirA[0] * dirB[0] + dirA[1] * dirB[1]) / lu / lv) < TOL;
    }
    case 'equal': {
      const sizeAt = (e: SketchEntity) => (e.kind === 'line' ? sizeOf(e, 'length')! : round(e)!.r);

      return Math.abs(sizeAt(cv[0]) - sizeAt(cv[1])) < TOL;
    }
    case 'tangent': {
      const line = cv.find(e => e.kind === 'line');
      const rs = cv.map(round).filter(round => !!round) as { c: Vec2; r: number }[];
      const ell = cv.find(e => e.kind === 'ellipse') as Extract<SketchEntity, { kind: 'ellipse' }> | undefined;
      if (line && rs.length === 1) {
        return Math.abs(dPL(rs[0].c, (line as any).a, (line as any).b) - rs[0].r) < TOL;
      }
      if (rs.length === 2) {
        const distance = Math.hypot(rs[0].c[0] - rs[1].c[0], rs[0].c[1] - rs[1].c[1]);

        return Math.min(Math.abs(distance - rs[0].r - rs[1].r), Math.abs(distance - Math.abs(rs[0].r - rs[1].r))) < TOL;
      }
      if (line && ell) {
        // The line touches the ellipse: the nearest it comes is 0, and it does not cross (all of it on one side).
        const tangentLine = line as Extract<SketchEntity, { kind: 'line' }>;
        const sd = ellPts(ell, 4000).map(q => ((q[0] - tangentLine.a[0]) * (tangentLine.b[1] - tangentLine.a[1]) - (q[1] - tangentLine.a[1]) * (tangentLine.b[0] - tangentLine.a[0])) / Math.hypot(tangentLine.b[0] - tangentLine.a[0], tangentLine.b[1] - tangentLine.a[1]));
        const lo = Math.min(...sd);
        const hi = Math.max(...sd);

        return Math.min(Math.abs(lo), Math.abs(hi)) < 1e-3 && lo * hi > -1e-3;
      }

      return null;
    }
    case 'concentric': {
      const [a, b] = cv.map(centre);

      return !!a && !!b && Math.hypot(a[0] - b[0], a[1] - b[1]) < TOL;
    }
    case 'midpoint': {
      const line = cv[0] as Extract<SketchEntity, { kind: 'line' }>;

      return Math.hypot(pts[0][0] - (line.a[0] + line.b[0]) / 2, pts[0][1] - (line.a[1] + line.b[1]) / 2) < TOL;
    }
    case 'symmetric': {
      const line = cv[0] as Extract<SketchEntity, { kind: 'line' }>;
      const direction = dir(line)!;
      const length = Math.hypot(...direction);
      const midpoint: Vec2 = [(pts[0][0] + pts[1][0]) / 2, (pts[0][1] + pts[1][1]) / 2];

      return dPL(midpoint, line.a, line.b) < TOL && Math.abs(((pts[1][0] - pts[0][0]) * direction[0] + (pts[1][1] - pts[0][1]) * direction[1]) / length) < TOL;
    }
    case 'distance':
      if (pts.length === 2) {
        return Math.abs(Math.hypot(pts[0][0] - pts[1][0], pts[0][1] - pts[1][1]) - sketchConstraint.value!) < TOL;
      }

      return Math.abs(dPL(pts[0], (cv[0] as any).a, (cv[0] as any).b) - sketchConstraint.value!) < TOL;
    case 'fix':
      return Math.hypot(pts[0][0] - sketchConstraint.at![0], pts[0][1] - sketchConstraint.at![1]) < TOL;
    case 'dim': {
      const size = sizeOf(cv[0], sketchConstraint.prop!);

      return size !== null && Math.abs(size - sketchConstraint.value!) < TOL;
    }
  }

  return null;
}

const findings = new Map<string, number>();
const detail = new Map<string, string>();
let cur = '';
const note = (text: string) => {
  findings.set(text, (findings.get(text) ?? 0) + 1);
  if (!detail.has(text)) {
    detail.set(text, cur);
  }
};
let tried = 0;
let good = 0;
let slowest = 0;

function run(label: string, es: SketchEntity[], sketchConstraint: SketchConstraint): void {
  tried++;
  const t0 = performance.now();
  const result = addForUser(es, [], [sketchConstraint], sketchConstraint.curves?.[0] ?? sketchConstraint.pts?.[0]?.e);
  slowest = Math.max(slowest, performance.now() - t0);
  cur = JSON.stringify({ es, c: sketchConstraint, err: result.result.error, out: result.result.entities });
  if (result.result.entities.some(e => pointsOf(e).some(q => !Number.isFinite(q.at[0]) || !Number.isFinite(q.at[1])))) {
    return note(`${label}: not a number`);
  }
  if (!result.ok) {
    return note(`${label}: refused`);
  }
  const held = holds(sketchConstraint, result.result.entities);
  if (held === null) {
    return note(`${label}: offered, and nothing can say whether it is true`);
  }
  if (!held) {
    return note(`${label}: taken, and not true`);
  }
  // And it stays true when solved again from there (nothing drifts).
  const again = solve(result.result.entities, [sketchConstraint]);
  if (!again.ok || !holds(sketchConstraint, again.entities)) {
    return note(`${label}: lost when solved again`);
  }
  good++;
}

const TRIALS = 25;
const id = () => `c${tried}`;
const pick = (e: SketchEntity): PointRef => {
  const ps = pointsOf(e);

  return { e: e.id, p: ps[Math.floor(rnd() * ps.length)].p };
};

for (const k1 of KINDS) {
  for (const k2 of KINDS) {
    for (let trial = 0; trial < TRIALS; trial++) {
      const a = make(k1, 'A');
      const b = make(k2, 'B');
      const es = [a, b];
      // two curves
      for (const type of ['parallel', 'perpendicular', 'equal', 'tangent', 'concentric'] as ConstraintType[]) {
        if (applicable(type, [], es)) {
          run(`${type} ${k1}+${k2}`, es, { id: id(), type, curves: ['A', 'B'] });
        }
      }
      // a point of one, and the other curve
      const pa = pick(a);
      for (const type of ['coincident', 'midpoint'] as ConstraintType[]) {
        if (applicable(type, [pa], [b])) {
          run(`${type} point of ${k1} on ${k2}`, es, { id: id(), type, pts: [pa], curves: ['B'] });
        }
      }
      if (applicable('distance', [pa], [b])) {
        run(`distance point of ${k1} to ${k2}`, es, { id: id(), type: 'distance', pts: [pa], curves: ['B'], value: between(2, 25) });
      }
      // two points
      const pb = pick(b);
      if (applicable('coincident', [pa, pb], [])) {
        run(`coincident ${k1}.${pa.p}+${k2}.${pb.p}`, es, { id: id(), type: 'coincident', pts: [pa, pb] });
      }
      for (const type of ['horizontal', 'vertical'] as ConstraintType[]) {
        if (applicable(type, [pa, pb], [])) {
          run(`${type} points ${k1}+${k2}`, es, { id: id(), type, pts: [pa, pb] });
        }
      }
      if (applicable('distance', [pa, pb], [])) {
        run(`distance points ${k1}+${k2}`, es, { id: id(), type: 'distance', pts: [pa, pb], value: between(2, 40) });
      }
      // two points about a line
      const sketchEntity = make('line', 'L');
      if (applicable('symmetric', [pa, pb], [sketchEntity])) {
        run(`symmetric ${k1}+${k2}`, [a, b, sketchEntity], { id: id(), type: 'symmetric', pts: [pa, pb], curves: ['L'] });
      }
    }
  }
}

for (const kind of KINDS) {
  for (let trial = 0; trial < TRIALS; trial++) {
    const a = make(kind, 'A');
    for (const type of ['horizontal', 'vertical'] as ConstraintType[]) {
      if (applicable(type, [], [a])) {
        run(`${type} ${kind}`, [a], { id: id(), type, curves: ['A'] });
      }
    }
    for (const q of pointsOf(a)) {
      run(`lock ${kind}.${q.p.replace(/\d+/, '')}`, [a], { id: id(), type: 'fix', pts: [{ e: 'A', p: q.p }], at: randomPoint() });
    }
    for (const prop of ['length', 'radius', 'diameter', 'w', 'h', 'rx', 'ry', 'dx', 'dy', 'angle']) {
      if (sizeOf(a, prop) !== null) {
        run(`size ${prop} of ${kind}`, [a], { id: id(), type: 'dim', curves: ['A'], prop, value: prop === 'angle' ? between(-170, 170) : between(3, 35) });
      }
    }
  }
}

const list = [...findings].sort((firstFinding, secondFinding) => firstFinding[0].localeCompare(secondFinding[0]));
for (const [finding, count] of list) {
  console.log(`  ${String(count).padStart(4)} x  ${finding}`);
}
console.log(`${good} of ${tried} true once taken; slowest ${slowest.toFixed(1)} ms; ${list.length} kinds of finding`);
if (process.env.SHOW) {
  for (const [finding, detailText] of detail) {
    if (finding.includes(process.env.SHOW)) {
      console.log(finding + ' >> ' + detailText);
    }
  }
}
if (list.length) {
  process.exit(1);
}
