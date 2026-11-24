// Run: npx tsx tests/constraintmatrix.test.ts
// Every constraint on every kind of curve it is offered for: once it is taken, it has to be TRUE - measured here
// from the curves themselves, not by the solver's own residuals (a constraint whose residual is always 0 "solves"
// and does nothing). And one constraint on free curves can always be met: none may be refused.
import { addForUser, applicable, pointOf, pointsOf, sizeOf, solve } from '../src/sketch/constraints';
import { arcFrom3, entityPolylines } from '../src/sketch/curves';
import type { ConstraintType, PointRef, SketchConstraint, SketchEntity, Vec2 } from '../src/doc/types';

let seed = 7;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
const R = (lo: number, hi: number) => lo + (hi - lo) * rnd();
const P = (): Vec2 => [R(-40, 40), R(-40, 40)];

const KINDS = ['line', 'arc', 'circle', 'ellipse', 'ellarc', 'rect', 'polygon', 'spline', 'polyline'] as const;
type Kind = (typeof KINDS)[number];

function make(kind: Kind, id: string): SketchEntity {
  const c = P();
  switch (kind) {
    case 'line': {
      const a = R(0, 6.28);
      const l = R(8, 30);

      return { id, kind: 'line', a: c, b: [c[0] + l * Math.cos(a), c[1] + l * Math.sin(a)] };
    }
    case 'arc': {
      const r = R(5, 20);
      const a0 = R(0, 6.28);
      const sw = R(0.6, 4) * (rnd() < 0.5 ? -1 : 1);
      const at = (t: number): Vec2 => [c[0] + r * Math.cos(t), c[1] + r * Math.sin(t)];

      return { id, kind: 'arc', a: at(a0), m: at(a0 + sw / 2), b: at(a0 + sw) };
    }
    case 'circle':
      return { id, kind: 'circle', center: c, radius: R(4, 18) };
    case 'ellipse':
      return { id, kind: 'ellipse', center: c, rx: R(8, 20), ry: R(3, 7), rotation: R(0, 3.14) };
    case 'ellarc':
      return { id, kind: 'ellipse', center: c, rx: R(8, 20), ry: R(3, 7), rotation: R(0, 3.14), a0: R(0, 6.28), sweep: R(1, 4) };
    case 'rect':
      return { id, kind: 'rect', center: c, w: R(6, 30), h: R(6, 30), rotation: R(0, 3.14) };
    case 'polygon':
      return { id, kind: 'polygon', center: c, radius: R(6, 18), sides: 3 + Math.floor(rnd() * 5), angle: R(0, 6.28) };
    case 'spline':
      return { id, kind: 'spline', points: [c, [c[0] + 10, c[1] + R(-8, 8)], [c[0] + 20, c[1] + R(-8, 8)], [c[0] + 30, c[1] + R(-8, 8)]], closed: false, mode: 'fit' };
    case 'polyline':
      return { id, kind: 'polyline', points: [c, [c[0] + 10, c[1] + R(-8, 8)], [c[0] + 20, c[1] + R(-8, 8)]], closed: false };
  }
}

// ---- measured from the curves themselves
const dPL = (p: Vec2, a: Vec2, b: Vec2) => Math.abs((p[0] - a[0]) * (b[1] - a[1]) - (p[1] - a[1]) * (b[0] - a[0])) / Math.hypot(b[0] - a[0], b[1] - a[1]);
const dPS = (p: Vec2, a: Vec2, b: Vec2) => {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)));

  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
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
const ellPts = (e: Extract<SketchEntity, { kind: 'ellipse' }>, n = 20000): Vec2[] =>
  Array.from({ length: n }, (_, i) => {
    const t = (i / n) * 2 * Math.PI;
    const x = e.rx * Math.cos(t);
    const y = e.ry * Math.sin(t);

    return [e.center[0] + x * Math.cos(e.rotation) - y * Math.sin(e.rotation), e.center[1] + x * Math.sin(e.rotation) + y * Math.cos(e.rotation)] as Vec2;
  });
/** How far a point is from the curve as it is drawn (a line, a circle and an ellipse: the whole of it, as CAD does). */
function distTo(p: Vec2, e: SketchEntity): number {
  if (e.kind === 'line') {
    return dPL(p, e.a, e.b);
  }
  const r = round(e);
  if (r) {
    return Math.abs(Math.hypot(p[0] - r.c[0], p[1] - r.c[1]) - r.r);
  }
  if (e.kind === 'ellipse') {
    const q = ellPts(e, 4000);

    return Math.min(...q.map((a, i) => dPS(p, a, q[(i + 1) % q.length])));
  }
  let best = Infinity;
  for (const poly of entityPolylines(e)) {
    for (let i = 0; i + 1 < poly.length; i++) {
      best = Math.min(best, dPS(p, poly[i], poly[i + 1]));
    }
  }

  return best;
}
const dir = (e: SketchEntity) => (e.kind === 'line' ? ([e.b[0] - e.a[0], e.b[1] - e.a[1]] as Vec2) : null);
const centre = (e: SketchEntity): Vec2 | null => ('center' in e ? e.center : (round(e)?.c ?? null));

const TOL = 1e-5;
/** Is the constraint true of these curves? (null: nothing here knows how to measure it - a finding by itself.) */
function holds(c: SketchConstraint, es: SketchEntity[]): boolean | null {
  const get = (id: string) => es.find(e => e.id === id)!;
  const pt = (r: PointRef) => pointOf(get(r.e), r.p)!;
  const cv = (c.curves ?? []).map(get);
  const pts = (c.pts ?? []).map(pt);
  switch (c.type) {
    case 'coincident':
      if (pts.length === 2) {
        return Math.hypot(pts[0][0] - pts[1][0], pts[0][1] - pts[1][1]) < TOL;
      }

      return distTo(pts[0], cv[0]) < (cv[0].kind === 'ellipse' ? 1e-4 : TOL);
    case 'horizontal':
    case 'vertical': {
      const k = c.type === 'horizontal' ? 1 : 0;
      if (cv.length) {
        return Math.abs(dir(cv[0])![k]) < TOL;
      }

      return Math.abs(pts[0][k] - pts[1][k]) < TOL;
    }
    case 'parallel':
    case 'perpendicular': {
      const [u, v] = cv.map(e => dir(e)!);
      const lu = Math.hypot(...u);
      const lv = Math.hypot(...v);

      return Math.abs(c.type === 'parallel' ? (u[0] * v[1] - u[1] * v[0]) / lu / lv : (u[0] * v[0] + u[1] * v[1]) / lu / lv) < TOL;
    }
    case 'equal': {
      const s = (e: SketchEntity) => (e.kind === 'line' ? sizeOf(e, 'length')! : round(e)!.r);

      return Math.abs(s(cv[0]) - s(cv[1])) < TOL;
    }
    case 'tangent': {
      const line = cv.find(e => e.kind === 'line');
      const rs = cv.map(round).filter(x => !!x) as { c: Vec2; r: number }[];
      const ell = cv.find(e => e.kind === 'ellipse') as Extract<SketchEntity, { kind: 'ellipse' }> | undefined;
      if (line && rs.length === 1) {
        return Math.abs(dPL(rs[0].c, (line as any).a, (line as any).b) - rs[0].r) < TOL;
      }
      if (rs.length === 2) {
        const d = Math.hypot(rs[0].c[0] - rs[1].c[0], rs[0].c[1] - rs[1].c[1]);

        return Math.min(Math.abs(d - rs[0].r - rs[1].r), Math.abs(d - Math.abs(rs[0].r - rs[1].r))) < TOL;
      }
      if (line && ell) {
        // The line touches the ellipse: the nearest it comes is 0, and it does not cross (all of it on one side).
        const l = line as Extract<SketchEntity, { kind: 'line' }>;
        const sd = ellPts(ell, 4000).map(q => ((q[0] - l.a[0]) * (l.b[1] - l.a[1]) - (q[1] - l.a[1]) * (l.b[0] - l.a[0])) / Math.hypot(l.b[0] - l.a[0], l.b[1] - l.a[1]));
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
      const l = cv[0] as Extract<SketchEntity, { kind: 'line' }>;

      return Math.hypot(pts[0][0] - (l.a[0] + l.b[0]) / 2, pts[0][1] - (l.a[1] + l.b[1]) / 2) < TOL;
    }
    case 'symmetric': {
      const l = cv[0] as Extract<SketchEntity, { kind: 'line' }>;
      const d = dir(l)!;
      const n = Math.hypot(...d);
      const m: Vec2 = [(pts[0][0] + pts[1][0]) / 2, (pts[0][1] + pts[1][1]) / 2];

      return dPL(m, l.a, l.b) < TOL && Math.abs(((pts[1][0] - pts[0][0]) * d[0] + (pts[1][1] - pts[0][1]) * d[1]) / n) < TOL;
    }
    case 'distance':
      if (pts.length === 2) {
        return Math.abs(Math.hypot(pts[0][0] - pts[1][0], pts[0][1] - pts[1][1]) - c.value!) < TOL;
      }

      return Math.abs(dPL(pts[0], (cv[0] as any).a, (cv[0] as any).b) - c.value!) < TOL;
    case 'fix':
      return Math.hypot(pts[0][0] - c.at![0], pts[0][1] - c.at![1]) < TOL;
    case 'dim': {
      const s = sizeOf(cv[0], c.prop!);

      return s !== null && Math.abs(s - c.value!) < TOL;
    }
  }

  return null;
}

const findings = new Map<string, number>();
const detail = new Map<string, string>();
let cur = '';
const note = (s: string) => {
  findings.set(s, (findings.get(s) ?? 0) + 1);
  if (!detail.has(s)) {
    detail.set(s, cur);
  }
};
let tried = 0;
let good = 0;
let slowest = 0;

function run(label: string, es: SketchEntity[], c: SketchConstraint): void {
  tried++;
  const t0 = performance.now();
  const r = addForUser(es, [], [c], c.curves?.[0] ?? c.pts?.[0]?.e);
  slowest = Math.max(slowest, performance.now() - t0);
  cur = JSON.stringify({ es, c, err: r.result.error, out: r.result.entities });
  if (r.result.entities.some(e => pointsOf(e).some(q => !Number.isFinite(q.at[0]) || !Number.isFinite(q.at[1])))) {
    return note(`${label}: not a number`);
  }
  if (!r.ok) {
    return note(`${label}: refused`);
  }
  const h = holds(c, r.result.entities);
  if (h === null) {
    return note(`${label}: offered, and nothing can say whether it is true`);
  }
  if (!h) {
    return note(`${label}: taken, and not true`);
  }
  // And it stays true when solved again from there (nothing drifts).
  const again = solve(r.result.entities, [c]);
  if (!again.ok || !holds(c, again.entities)) {
    return note(`${label}: lost when solved again`);
  }
  good++;
}

const N = 25;
const id = () => `c${tried}`;
const pick = (e: SketchEntity): PointRef => {
  const ps = pointsOf(e);

  return { e: e.id, p: ps[Math.floor(rnd() * ps.length)].p };
};

for (const k1 of KINDS) {
  for (const k2 of KINDS) {
    for (let n = 0; n < N; n++) {
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
        run(`distance point of ${k1} to ${k2}`, es, { id: id(), type: 'distance', pts: [pa], curves: ['B'], value: R(2, 25) });
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
        run(`distance points ${k1}+${k2}`, es, { id: id(), type: 'distance', pts: [pa, pb], value: R(2, 40) });
      }
      // two points about a line
      const l = make('line', 'L');
      if (applicable('symmetric', [pa, pb], [l])) {
        run(`symmetric ${k1}+${k2}`, [a, b, l], { id: id(), type: 'symmetric', pts: [pa, pb], curves: ['L'] });
      }
    }
  }
}

for (const k of KINDS) {
  for (let n = 0; n < N; n++) {
    const a = make(k, 'A');
    for (const type of ['horizontal', 'vertical'] as ConstraintType[]) {
      if (applicable(type, [], [a])) {
        run(`${type} ${k}`, [a], { id: id(), type, curves: ['A'] });
      }
    }
    for (const q of pointsOf(a)) {
      run(`lock ${k}.${q.p.replace(/\d+/, '')}`, [a], { id: id(), type: 'fix', pts: [{ e: 'A', p: q.p }], at: P() });
    }
    for (const prop of ['length', 'radius', 'diameter', 'w', 'h', 'rx', 'ry', 'dx', 'dy', 'angle']) {
      if (sizeOf(a, prop) !== null) {
        run(`size ${prop} of ${k}`, [a], { id: id(), type: 'dim', curves: ['A'], prop, value: prop === 'angle' ? R(-170, 170) : R(3, 35) });
      }
    }
  }
}

const list = [...findings].sort((x, y) => x[0].localeCompare(y[0]));
for (const [s, n] of list) {
  console.log(`  ${String(n).padStart(4)} x  ${s}`);
}
console.log(`${good} of ${tried} true once taken; slowest ${slowest.toFixed(1)} ms; ${list.length} kinds of finding`);
if (process.env.SHOW) {
  for (const [s, d] of detail) {
    if (s.includes(process.env.SHOW)) {
      console.log(s + ' >> ' + d);
    }
  }
}
if (list.length) {
  process.exit(1);
}
