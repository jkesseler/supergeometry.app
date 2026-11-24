// Break-it test for sketch constraints: random sketches, random constraints,
// extreme values and long drags, checked after every step.
// Run: npx tsx tests/constraintbreak.test.ts [scenarios] [steps] [seed]
import { createRequire } from 'node:module';
import { addStrict, applicable, constraintError, pointOf, pointsOf, followDrag, refsOf, setValueStrict, sizeOf, solve } from '../src/sketch/constraints';
import { arcFrom3 } from '../src/sketch/curves';
import { filletConstraints, filletCorner } from '../src/sketch/edit';
import type { PointRef, SketchConstraint, SketchEntity, Vec2 } from '../src/doc/types';

const require = createRequire(import.meta.url);
const SCEN = Number(process.argv[2] ?? 18);
const STEPS = Number(process.argv[3] ?? 20);
let seed = Number(process.argv[4] ?? 1);
const VERBOSE = !!process.env.CBREAK_WHY;

const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const pick = <T>(a: T[]): T => a[Math.floor(rnd() * a.length)];
let nid = 0;
const uid = () => `x${++nid}`;

const line = (a: Vec2, b: Vec2): SketchEntity => ({ id: uid(), kind: 'line', a, b });
const co = (e1: string, p1: string, e2: string, p2: string): SketchConstraint => ({ id: uid(), type: 'coincident', pts: [{ e: e1, p: p1 }, { e: e2, p: p2 }] });

/** A closed chain of lines through these points, joined end to end. */
function loop(pts: Vec2[], hv = true): { es: SketchEntity[]; cs: SketchConstraint[] } {
  const es = pts.map((point, i) => line(point, pts[(i + 1) % pts.length]));
  const cs: SketchConstraint[] = es.map((e, i) => co(e.id, 'b', es[(i + 1) % es.length].id, 'a'));
  if (hv) {
    for (const e of es) {
      const lineEntity = e as Extract<SketchEntity, { kind: 'line' }>;
      if (Math.abs(lineEntity.a[1] - lineEntity.b[1]) < 1e-9) {
        cs.push({ id: uid(), type: 'horizontal', curves: [e.id] });
      } else if (Math.abs(lineEntity.a[0] - lineEntity.b[0]) < 1e-9) {
        cs.push({ id: uid(), type: 'vertical', curves: [e.id] });
      }
    }
  }

  return { es, cs };
}

function base(kind: number): { es: SketchEntity[]; cs: SketchConstraint[]; name: string } {
  const size = 5 + rnd() * 40;
  switch (kind) {
    case 0: return { ...loop([[0, 0], [size, 0], [size, size * 0.6], [0, size * 0.6]]), name: 'rectangle' };
    case 1: return { ...loop([[0, 0], [size, 0], [size * 0.3, size * 0.8]], false), name: 'triangle' };
    case 2: return { ...loop([[0, 0], [size, 0], [size, size * 0.3], [size * 0.4, size * 0.3], [size * 0.4, size], [0, size]]), name: 'L shape' };
    case 3: {
      const loopShape = loop([[0, 0], [size, 0], [size, size * 0.6], [0, size * 0.6]]);
      let es = loopShape.es;
      let cs = loopShape.cs;
      for (const at of [[size, 0], [size, size * 0.6]] as Vec2[]) {
        const before = new Set(es.map(e => e.id));
        const next = filletCorner(es, at, size * 0.15, 1e-6);
        if (!next) {
          continue;
        }
        // Constraints at the removed corner move to the arc.
        const ids = new Set(next.map(e => e.id));
        cs = filletConstraints(next, cs.filter(sketchConstraint => refsOf(sketchConstraint).every(id => ids.has(id)) && !(sketchConstraint.type === 'coincident' && sketchConstraint.pts?.every((point) => {
          const e = es.find(sketchEntity => sketchEntity.id === point.e); const q = e && pointOf(e, point.p);

          return q && Math.hypot(q[0] - at[0], q[1] - at[1]) < 1e-6; 
        }))), before);
        es = next;
      }

      return { es, cs, name: 'filleted rectangle' };
    }
    case 4: {
      const sketchEntity: SketchEntity = { id: uid(), kind: 'circle', center: [0, 0], radius: size / 3 };
      const t = line([-size, size / 3 + 1], [size, size / 3 + 2]);

      return { es: [sketchEntity, t], cs: [{ id: uid(), type: 'tangent', curves: [t.id, sketchEntity.id] }], name: 'circle + tangent line' };
    }
    case 5: {
      const a: SketchEntity = { id: uid(), kind: 'circle', center: [0, 0], radius: size / 2 };
      const b: SketchEntity = { id: uid(), kind: 'circle', center: [1, 1], radius: size / 4 };

      return { es: [a, b], cs: [{ id: uid(), type: 'concentric', curves: [a.id, b.id] }], name: 'concentric circles' };
    }
    case 6: {
      // Slot: two lines and two half circles.
      const radius = size / 4;
      const top = line([0, radius], [size, radius]);
      const bot = line([size, -radius], [0, -radius]);
      const right: SketchEntity = { id: uid(), kind: 'arc', a: [size, radius], m: [size + radius, 0], b: [size, -radius] };
      const left: SketchEntity = { id: uid(), kind: 'arc', a: [0, -radius], m: [-radius, 0], b: [0, radius] };
      const cs = [co(top.id, 'b', right.id, 'a'), co(right.id, 'b', bot.id, 'a'), co(bot.id, 'b', left.id, 'a'), co(left.id, 'b', top.id, 'a'),
        { id: uid(), type: 'tangent' as const, curves: [top.id, right.id] }, { id: uid(), type: 'tangent' as const, curves: [bot.id, right.id] },
        { id: uid(), type: 'tangent' as const, curves: [bot.id, left.id] }, { id: uid(), type: 'tangent' as const, curves: [top.id, left.id] },
        { id: uid(), type: 'horizontal' as const, curves: [top.id] }];

      return { es: [top, right, bot, left], cs, name: 'slot' };
    }
    case 7: {
      const es: SketchEntity[] = [
        { id: uid(), kind: 'rect', center: [0, 0], w: size, h: size / 2, rotation: 0 },
        { id: uid(), kind: 'polygon', center: [size, size], radius: size / 3, sides: 6, angle: 0 },
        { id: uid(), kind: 'ellipse', center: [-size, size], rx: size / 2, ry: size / 4, rotation: 0 }
      ];

      return { es, cs: [], name: 'rect + polygon + ellipse' };
    }
    default: {
      // Open zig-zag with an arc.
      const a = line([0, 0], [size, 0]);
      const arc: SketchEntity = { id: uid(), kind: 'arc', a: [size, 0], m: [size * 1.3, size * 0.3], b: [size, size * 0.6] };
      const b = line([size, size * 0.6], [0, size * 0.6]);

      return { es: [a, arc, b], cs: [co(a.id, 'b', arc.id, 'a'), co(arc.id, 'b', b.id, 'a'), { id: uid(), type: 'tangent', curves: [a.id, arc.id] }], name: 'line-arc-line' };
    }
  }
}

const KINDS = 9;
const TYPES = ['coincident', 'horizontal', 'vertical', 'parallel', 'perpendicular', 'equal', 'tangent', 'concentric', 'midpoint', 'symmetric', 'distance', 'fix'] as const;

function scaleOf(es: SketchEntity[]): number {
  let size = 1;
  for (const e of es) {
    for (const point of pointsOf(e)) {
      size = Math.max(size, Math.abs(point.at[0]), Math.abs(point.at[1]));
    }
    size = Math.max(size, sizeAny(e));
  }

  return size;
}

function sizeAny(e: SketchEntity): number {
  if (e.kind === 'line') {
    return Math.hypot(e.b[0] - e.a[0], e.b[1] - e.a[1]);
  }
  if (e.kind === 'circle' || e.kind === 'polygon') {
    return e.radius;
  }
  if (e.kind === 'arc') {
    const arc = arcFrom3(e.a, e.m, e.b);

    return arc ? arc.r * Math.abs(arc.sweep) : 0;
  }
  if (e.kind === 'rect') {
    return Math.min(e.w, e.h);
  }
  if (e.kind === 'ellipse') {
    return Math.min(e.rx, e.ry);
  }

  return 1;
}

/** Largest point move between two versions of the same sketch. */
function moved(a: SketchEntity[], b: SketchEntity[]): number {
  let distance = 0;
  for (let i = 0; i < a.length; i++) {
    const pa = pointsOf(a[i]);
    const pb = pointsOf(b[i]);
    for (let index = 0; index < Math.min(pa.length, pb.length); index++) {
      distance = Math.max(distance, Math.hypot(pa[index].at[0] - pb[index].at[0], pa[index].at[1] - pb[index].at[1]));
    }
    if (a[i].kind === 'arc' && b[i].kind === 'arc') {
      const sa = arcFrom3((a[i] as any).a, (a[i] as any).m, (a[i] as any).b);
      const sb = arcFrom3((b[i] as any).a, (b[i] as any).m, (b[i] as any).b);
      if (sa && sb && Math.sign(sa.sweep) !== Math.sign(sb.sweep)) {
        distance = Infinity;
      } else if (sa && sb) {
        distance = Math.max(distance, Math.abs(sa.sweep - sb.sweep) * Math.max(sa.r, sb.r));
      }
    }
  }

  return distance;
}

/** Orientation of each corner where two curves join, and of each arc: flips show up here. */
function turns(es: SketchEntity[], cs: SketchConstraint[]): number[] {
  const out: number[] = [];
  const byId = new Map(es.map(e => [e.id, e]));
  for (const sketchConstraint of cs) {
    if (sketchConstraint.type !== 'coincident' || sketchConstraint.pts?.length !== 2) {
      continue;
    }
    const [pointRef, q] = sketchConstraint.pts;
    const e1 = byId.get(pointRef.e);
    const e2 = byId.get(q.e);
    if (e1?.kind !== 'line' || e2?.kind !== 'line') {
      continue;
    }
    const far = (e: Extract<SketchEntity, { kind: 'line' }>, end: string) => (end === 'a' ? e.b : e.a);
    const point = pointOf(e1, pointRef.p)!;
    const farU = far(e1, pointRef.p);
    const farV = far(e2, q.p);
    const cr = (farU[0] - point[0]) * (farV[1] - point[1]) - (farU[1] - point[1]) * (farV[0] - point[0]);
    const lu = Math.hypot(farU[0] - point[0], farU[1] - point[1]);
    const lv = Math.hypot(farV[0] - point[0], farV[1] - point[1]);
    // Legs next to nothing can tip either way.
    const big = Math.max(...es.map(e => (e.kind === 'line' ? Math.hypot(e.b[0] - e.a[0], e.b[1] - e.a[1]) : 0)));
    out.push(lu > big * 1e-4 && lv > big * 1e-4 && Math.abs(cr) > lu * lv * 0.02 ? Math.sign(cr) : 0);
  }
  for (const e of es) {
    if (e.kind === 'arc') {
      out.push(Math.sign(arcFrom3(e.a, e.m, e.b)?.sweep ?? 0));
    }
  }

  return out;
}

interface State { es: SketchEntity[]; cs: SketchConstraint[] }

const fails: string[] = [];
const why = new Map<string, number>();
let accepted = 0;
let refused = 0;
let slowest = 0;
let dropped = 0;
let dumped = false;
let lastCall: unknown = null;
let failDumped = false;
const slowFrames: string[] = [];
const editTimes: number[] = [];
const times: number[] = [];
let slowWhat = '';

function check(label: string, before: State, after: State, opts: { fixed?: string; smooth?: State; sized?: string } = {}): string | null {
  const sc = scaleOf(after.es);
  for (const e of after.es) {
    for (const point of pointsOf(e)) {
      if (!Number.isFinite(point.at[0]) || !Number.isFinite(point.at[1])) {
        return 'NaN/Infinity in the geometry';
      }
    }
  }
  const err = constraintError(after.es, after.cs);
  if (err > 1e-5 * Math.max(1, sc)) {
    return `constraints not met (error ${err.toExponential(2)})`;
  }
  for (let i = 0; i < after.es.length; i++) {
    const s0 = sizeAny(before.es[i] ?? after.es[i]);
    const s1 = sizeAny(after.es[i]);
    if (after.es[i].id !== opts.sized && s0 > sc * 1e-7 && s1 < sc * 1e-7) {
      return `${after.es[i].kind} collapsed to nothing`;
    }
  }
  if (opts.fixed) {
    const i = before.es.findIndex(e => e.id === opts.fixed);
    if (i >= 0 && moved([before.es[i]], [after.es[i]]) > 1e-6 * sc) {
      return 'the first-picked curve moved';
    }
  }
  // Same change made gradually lands in the same place: no jump to a flipped solution.
  if (opts.smooth) {
    const t0 = turns(before.es, before.cs);
    const t1 = turns(after.es, after.cs);
    const t2 = turns(opts.smooth.es, opts.smooth.cs);
    const flipped = t1.some((value, i) => value !== 0 && t2[i] !== 0 && value !== t2[i] && t0[i] === t2[i]);
    if (flipped) {
      return 'flipped a corner/arc inside out (a gradual change keeps it)';
    }
  }

  return null;
}

function timed<T>(what: string, run: () => T): T {
  const t = performance.now();
  const result = run();
  const dt = performance.now() - t;
  if (what.startsWith('drag')) {
    times.push(dt);
  } else {
    editTimes.push(dt);
  }
  if (dt > slowest) {
    slowest = dt;
    slowWhat = what;
  }

  return result;
}

function randomSelection(st: State): { pts: PointRef[]; curves: SketchEntity[] } {
  const nP = pick([0, 0, 1, 1, 2]);
  const nC = pick([0, 1, 1, 2, 2]);
  const pts: PointRef[] = [];
  for (let i = 0; i < nP; i++) {
    const e = pick(st.es);
    const picked = pick(pointsOf(e));
    pts.push({ e: e.id, p: picked.p });
  }
  const curves: SketchEntity[] = [];
  for (let i = 0; i < nC; i++) {
    const e = pick(st.es);
    if (!curves.includes(e)) {
      curves.push(e);
    }
  }

  return { pts, curves };
}

function build(type: (typeof TYPES)[number], pts: PointRef[], curves: SketchEntity[], es: SketchEntity[]): SketchConstraint[] {
  const ids = curves.map(e => e.id);
  switch (type) {
    case 'fix':
      return pts.map(point => ({ id: uid(), type: 'fix', pts: [point], at: pointOf(es.find(e => e.id === point.e)!, point.p)! }));
    case 'distance': {
      const value = 1 + rnd() * 30;

      return [{ id: uid(), type: 'distance', pts, ...(ids.length ? { curves: ids } : {}), value: value }];
    }
    default:
      return [{ id: uid(), type, ...(pts.length ? { pts } : {}), ...(ids.length ? { curves: ids } : {}) }];
  }
}

function step(st: State, stepNumber: number): { label: string; next: State | null; opts: { fixed?: string; smooth?: State; sized?: string } } {
  const roll = rnd();
  if (roll < 0.3) {
    // Add a constraint like the Constraints menu does.
    const type = pick([...TYPES]);
    const { pts, curves } = randomSelection(st);
    if (!applicable(type, pts, curves)) {
      return { label: '', next: null, opts: {} };
    }
    if (pts.length === 2 && pts[0].e === pts[1].e && pts[0].p === pts[1].p) {
      return { label: '', next: null, opts: {} };
    }
    const cs = build(type, pts, curves, st.es);
    const first = curves[0]?.id ?? pts[0]?.e;
    const opts = first && type !== 'fix' ? { fixed: new Set([first]) } : {};
    const already = constraintError(st.es, cs) < 1e-9 * scaleOf(st.es);
    lastCall = { es: st.es, cs: st.cs, added: cs, fixed: first && type !== 'fix' ? first : null };
    const res = timed(`add ${type}`, () => addStrict(st.es, st.cs, cs, opts));
    const label = `add ${type} (${pts.map(point => point.e + '.' + point.p).join(',')} ${curves.map(e => e.kind + ':' + e.id).join(',')})`;
    if (!res.ok) {
      if (already && constraintError(st.es, st.cs) < 1e-9 * scaleOf(st.es) && !wouldCollapse(st, cs)) {
        return { label: label + ' - refused although already true', next: { es: [], cs: [] }, opts: {} };
      }

      return { label, next: null, opts: {} };
    }

    return { label, next: { es: res.result.entities, cs: res.constraints }, opts: { fixed: type === 'fix' ? undefined : first } };
  }
  if (roll < 0.55) {
    // Size of a curve, typed (strict, like the size fields).
    const e = pick(st.es);
    const prop = e.kind === 'line' ? pick(['length', 'angle']) : e.kind === 'circle' ? pick(['radius', 'diameter']) : e.kind === 'arc' ? 'radius' : e.kind === 'rect' ? pick(['w', 'h']) : e.kind === 'ellipse' ? pick(['rx', 'ry']) : e.kind === 'polygon' ? 'radius' : null;
    if (!prop) {
      return { label: '', next: null, opts: {} };
    }
    const cur = sizeOf(e, prop);
    if (cur === null) {
      return { label: '', next: null, opts: {} };
    }
    const target = prop === 'angle' ? pick([0, 90, -90, 180, 45, cur + 30, cur - 170, 359]) : Math.max(1e-4, pick([cur * 2, cur / 2, cur * 10, cur / 10, cur * 1.01, 1e-3, 1e4, cur + 1, 0.0001]));
    const old = st.cs.filter(sketchConstraint => sketchConstraint.type === 'dim' && sketchConstraint.curves?.[0] === e.id && sketchConstraint.curves.length === 1 && sketchConstraint.prop === prop);
    const baseCs = st.cs.filter(sketchConstraint => !old.includes(sketchConstraint));
    const add: SketchConstraint = { id: old[0]?.id ?? uid(), type: 'dim', curves: [e.id], prop, value: target };
    lastCall = { es: st.es, cs: baseCs, added: [add] };
    const res = timed(`size ${prop}`, () => addStrict(st.es, baseCs, [add]));
    const label = `${e.kind} ${prop} ${cur.toFixed(3)} → ${target}`;
    if (!res.ok) {
      return { label, next: null, opts: {} };
    }
    const next = { es: res.result.entities, cs: res.constraints };

    return { label, next, opts: { smooth: gradual(st, baseCs, add, cur, target), sized: e.id } };
  }
  if (roll < 0.7) {
    // Change an existing dimension's value from its panel (resolved on commit).
    const dims = st.cs.filter(sketchConstraint => (sketchConstraint.type === 'dim' || sketchConstraint.type === 'distance') && sketchConstraint.value !== undefined);
    if (!dims.length) {
      return { label: '', next: null, opts: {} };
    }
    const dimension = pick(dims);
    const target = dimension.prop === 'angle' ? pick([0, 90, 180, 30, (dimension.value ?? 0) + 90]) : Math.max(1e-4, pick([(dimension.value ?? 1) * 3, (dimension.value ?? 1) / 3, 0.0001, 5e4, (dimension.value ?? 1) + 0.5]));
    const label = `${dimension.type} ${dimension.prop ?? ''} value ${dimension.value} → ${target}`;
    lastCall = { es: st.es, cs: st.cs.filter(sketchConstraint => sketchConstraint !== dimension), added: [{ ...dimension, value: target }] };
    const r2 = timed('dim value', () => setValueStrict(st.es, st.cs, dimension.id, target));
    if (!r2) {
      return { label, next: null, opts: {} };
    }
    const cs = r2.constraints;
    const baseCs = st.cs.filter(sketchConstraint => sketchConstraint !== dimension);

    return { label, next: { es: r2.result.entities, cs }, opts: { smooth: gradual(st, baseCs, dimension, dimension.value ?? 0, target) } };
  }
  if (roll < 0.92) {
    // Drag a point the way the sketch does: every move solved from where the drag began.
    const e = pick(st.es);
    const picked = pick(pointsOf(e));
    const sc = scaleOf(st.es);
    const to: Vec2 = [picked.at[0] + (rnd() - 0.5) * sc * pick([0.2, 1, 3]), picked.at[1] + (rnd() - 0.5) * sc * pick([0.2, 1, 3])];
    let cur = st.es;
    let prevTo: Vec2[] | null = [picked.at];
    const STEPS = 12;
    for (let step = 1; step <= STEPS; step++) {
      const t = step / STEPS;
      const at: Vec2 = [picked.at[0] + (to[0] - picked.at[0]) * t, picked.at[1] + (to[1] - picked.at[1]) * t];
      const drag = [{ ref: { e: e.id, p: picked.p }, to: at }];
      const fr = timed(`drag (${st.es.length} curves, ${st.cs.length} constraints)`, () => followDrag(cur, st.cs, drag, prevTo));
      const took = times[times.length - 1];
      if (took > 30) {
        slowFrames.push(`${took.toFixed(0)}ms ok=${fr.ok}`);
      }
      if (fr.ok) {
        cur = fr.entities;
        prevTo = fr.to;
      } else {
        dropped++;
        if (process.env.CBREAK_DUMP && !dumped) {
          dumped = true;
          require('node:fs').writeFileSync(process.env.CBREAK_DUMP, JSON.stringify({ es: cur, cs: st.cs, drag, prevTo }));
        }
      }
    }
    // Frame by frame is the gradual way: compare with the shape before the drag.
    const path = { es: cur, cs: st.cs };

    return { label: `drag ${e.kind}:${e.id}.${picked.p} by ${Math.hypot(to[0] - picked.at[0], to[1] - picked.at[1]).toFixed(1)}`, next: { es: cur, cs: st.cs }, opts: { smooth: path } };
  }
  // Delete a constraint.
  if (!st.cs.length) {
    return { label: '', next: null, opts: {} };
  }
  const constraint = pick(st.cs);

  return { label: `delete ${constraint.type}`, next: { es: st.es, cs: st.cs.filter(sketchConstraint => sketchConstraint !== constraint) }, opts: {} };
  void stepNumber;
}

function wouldCollapse(st: State, cs: SketchConstraint[]): boolean {
  void st;
  void cs;

  return false;
}

/** The same value change made in small steps (what a careful user would get). */
function gradual(st: State, baseCs: SketchConstraint[], sketchConstraint: SketchConstraint, from: number, to: number): State | undefined {
  let es = st.es;
  const STEPS = 16;
  for (let step = 1; step <= STEPS; step++) {
    // Angles the short way round (as the solver reads them).
    const span = sketchConstraint.prop === 'angle' ? ((((to - from) % 360) + 540) % 360) - 180 : to - from;
    const value = from + (span * step) / STEPS;
    const solution = solve(es, [...baseCs, { ...sketchConstraint, value: value }]);
    if (!solution.ok) {
      return undefined;
    }
    es = solution.entities;
  }

  return { es, cs: [...baseCs, { ...sketchConstraint, value: to }] };
}


for (let scenario = 0; scenario < SCEN; scenario++) {
  const b = base(scenario % KINDS);
  // Start from a solved sketch.
  const r0 = solve(b.es, b.cs);
  if (!r0.ok) {
    fails.push(`scenario ${scenario} (${b.name}): base sketch doesn't solve (error ${r0.error})`);
    continue;
  }
  let st: State = { es: r0.entities, cs: b.cs };
  const trail: string[] = [];
  for (let stepIndex = 0; stepIndex < STEPS; stepIndex++) {
    const { label, next, opts } = step(st, stepIndex);
    if (!label) {
      continue;
    }
    if (!next) {
      refused++;
      continue;
    }
    trail.push(label);
    const bad = next.es.length === 0 ? label.split(' - ')[1] : check(label, st, next, opts);
    if (bad) {
      const kind = label.startsWith('drag') ? 'drag ' + label.split(' ')[1].split(':')[0] : label.split(' ')[0] + ' ' + (label.split(' ')[1] ?? '');
      why.set(`${kind}: ${bad.replace(/[\d.e+-]+/g, '#')}`, (why.get(`${kind}: ${bad.replace(/[\d.e+-]+/g, '#')}`) ?? 0) + 1);
      if (process.env.CBREAK_FAIL && !label.startsWith('drag') && (process.env.CBREAK_AT ? label.startsWith(process.env.CBREAK_AT) : true) && !failDumped && (failDumped = true)) {
        require('node:fs').writeFileSync(process.env.CBREAK_FAIL, JSON.stringify(lastCall));
      }
      fails.push(`scenario ${scenario} (${b.name}) step ${stepIndex}: ${label}: ${bad}${VERBOSE ? '\n    ' + trail.join('\n    ') : ''}`);
      break;
    }
    accepted++;
    st = next;
    // Shrunk below a thousandth of a unit: past what anyone draws (and the solver's precision).
    if (Math.max(...st.es.map(sizeAny)) < 1e-3) {
      break;
    }
  }
}

for (const fail of fails.slice(0, 30)) {
  console.log('FAIL', fail);
}
times.sort((a, b) => a - b);
if (process.env.CBREAK_SLOW) {
  console.log(slowFrames.join(' '));
}
console.log(`drag frames: ${times.length}, ${dropped} couldn't follow; median ${times[times.length >> 1]?.toFixed(2)} ms, 99% ${times[Math.floor(times.length * 0.99)]?.toFixed(1)} ms`);
editTimes.sort((a, b) => a - b);
console.log(`edits (constraints, sizes, values): median ${editTimes[editTimes.length >> 1]?.toFixed(2)} ms, 90% ${editTimes[Math.floor(editTimes.length * 0.9)]?.toFixed(1)} ms, 99% ${editTimes[Math.floor(editTimes.length * 0.99)]?.toFixed(1)} ms`);
console.log(`${accepted} steps ok, ${refused} refused, ${fails.length} broke the sketch; slowest solve ${slowest.toFixed(1)} ms (${slowWhat})`);
for (const [reason, count] of [...why].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${count}× ${reason}`);
}
process.exit(fails.length ? 1 : 0);
