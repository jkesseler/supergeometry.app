// Run: npx tsx tests/freehand.test.ts - freehand strokes become a few clean curves.
import assert from 'node:assert/strict';
import { simplifyStroke, type FreehandPiece } from '../src/sketch/freehand';
import { splinePoints } from '../src/sketch/curves';
import { arrangement } from '../src/sketch/regions';
import type { Vec2 } from '../src/doc/types';

// A pointer reports every ~3 units (tol = 1 is about 2.5 px), with a little hand jitter.
let seed = 7;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 2;
function stroke(path: (t: number) => Vec2, len: number, jitter = 0.4): Vec2[] {
  const count = Math.ceil(len / 3);

  return Array.from({ length: count + 1 }, (_, i) => {
    const [x, y] = path(i / count);

    return [x + rnd() * jitter, y + rnd() * jitter] as Vec2;
  });
}
const poly = (corners: Vec2[]) => (t: number): Vec2 => {
  const segs = corners.length - 1;
  const segment = Math.min(segs - 1, Math.floor(t * segs));
  const fraction = t * segs - segment;
  const [a, b] = [corners[segment], corners[segment + 1]];

  return [a[0] + (b[0] - a[0]) * fraction, a[1] + (b[1] - a[1]) * fraction];
};
const kinds = (pieces: FreehandPiece[]) => pieces.map(piece => piece.kind).join(',');
const sample = (freehandPiece: FreehandPiece): Vec2[] =>
  freehandPiece.kind === 'line' ? [freehandPiece.a, freehandPiece.b] : freehandPiece.kind === 'spline' ? splinePoints(freehandPiece.points, freehandPiece.closed, 'fit', 16) : freehandPiece.kind === 'circle' ? Array.from({ length: 129 }, (_, i) => [freehandPiece.center[0] + freehandPiece.radius * Math.cos((i / 128) * 2 * Math.PI), freehandPiece.center[1] + freehandPiece.radius * Math.sin((i / 128) * 2 * Math.PI)] as Vec2) : arcPts(freehandPiece);
function arcPts(arc: Extract<FreehandPiece, { kind: 'arc' }>): Vec2[] {
  // Through a, m, b: a fine polyline is enough for distances.
  const [ax, ay] = arc.a, [bx, by] = arc.b, [cx, cy] = arc.m;
  const denominator = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
  const ux = ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay) + (cx * cx + cy * cy) * (ay - by)) / denominator;
  const uy = ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx) + (cx * cx + cy * cy) * (bx - ax)) / denominator;
  const radius = Math.hypot(ax - ux, ay - uy);
  const ang = (q: Vec2) => Math.atan2(q[1] - uy, q[0] - ux);
  const TAU = 2 * Math.PI, ccw = (x: number) => ((x % TAU) + TAU) % TAU;
  const toM = ccw(ang(arc.m) - ang(arc.a)), toB = ccw(ang(arc.b) - ang(arc.a));
  const sweep = toM < toB ? toB : toB - TAU;

  return Array.from({ length: 129 }, (_, i) => [ux + radius * Math.cos(ang(arc.a) + (sweep * i) / 128), uy + radius * Math.sin(ang(arc.a) + (sweep * i) / 128)] as Vec2);
}
const segD = (q: Vec2, a: Vec2, b: Vec2) => {
  const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy;
  const t = L2 ? Math.max(0, Math.min(1, ((q[0] - a[0]) * dx + (q[1] - a[1]) * dy) / L2)) : 0;

  return Math.hypot(q[0] - a[0] - dx * t, q[1] - a[1] - dy * t);
};
/** How far the stroke gets from the result (the worst point). */
function deviation(raw: Vec2[], pieces: FreehandPiece[]): number {
  const all = pieces.map(sample);
  let worst = 0;
  for (const q of raw) {
    let distance = Infinity;
    for (const run of all) {
      for (let i = 1; i < run.length; i++) {
        distance = Math.min(distance, segD(q, run[i - 1], run[i]));
      }
    }
    worst = Math.max(worst, distance);
  }

  return worst;
}
const fitPoints = (pieces: FreehandPiece[]) => pieces.reduce((total, piece) => total + (piece.kind === 'spline' ? piece.points.length : 0), 0);
const joined = (pieces: FreehandPiece[], closed: boolean) => {
  const end = (x: FreehandPiece) => (x.kind === 'spline' ? x.points[x.points.length - 1] : (x as any).b);
  const start = (x: FreehandPiece) => (x.kind === 'spline' ? x.points[0] : (x as any).a);
  for (let i = 1; i < pieces.length; i++) {
    assert.deepEqual(start(pieces[i]), end(pieces[i - 1]), `piece ${i} not joined`);
  }
  if (closed) {
    assert.deepEqual(start(pieces[0]), end(pieces[pieces.length - 1]), 'loop not closed');
  }
};
const toEntities = (pieces: FreehandPiece[]) =>
  pieces.map((piece, i) => (piece.kind === 'spline' ? { id: `e${i}`, kind: 'spline' as const, points: piece.points, closed: piece.closed, mode: 'fit' as const } : { id: `e${i}`, ...piece })) as any[];

const checks: [string, () => string][] = [
  ['a wobbly straight stroke is one line', () => {
    const raw = stroke(t => [t * 200, Math.sin(t * 9) * 1.2], 200);
    const freehand = simplifyStroke(raw, 1);
    assert.equal(kinds(freehand.pieces), 'line');
    assert.equal(freehand.closed, false);

    return `${raw.length} points → 1 line`;
  }],
  ['an L is two lines, joined at the corner', () => {
    const raw = stroke(poly([[0, 0], [150, 0], [150, 100]]), 250);
    const freehand = simplifyStroke(raw, 1);
    assert.equal(kinds(freehand.pieces), 'line,line');
    joined(freehand.pieces, false);
    const corner = (freehand.pieces[0] as any).b as Vec2;
    assert.ok(Math.hypot(corner[0] - 150, corner[1]) < 4, `corner at ${corner}`);

    return `corner at ${corner.map(value => value.toFixed(1))}`;
  }],
  ['a square drawn back to its start: four lines, closed, one region', () => {
    const raw = stroke(poly([[0, 0], [100, 0], [100, 100], [0, 100], [1.5, 2]]), 400);
    const freehand = simplifyStroke(raw, 1);
    assert.equal(freehand.closed, true);
    assert.equal(kinds(freehand.pieces), 'line,line,line,line');
    joined(freehand.pieces, true);
    const reg = arrangement(toEntities(freehand.pieces)).regions;
    assert.equal(reg.length, 1);
    assert.ok(Math.abs(reg[0].area - 10000) < 400, `area ${reg[0].area}`);

    return `${raw.length} points → 4 lines, area ${reg[0].area.toFixed(0)}`;
  }],
  ['a round loop is a circle', () => {
    const raw = stroke(t => [50 * Math.cos(t * 2 * Math.PI * 1.01), 50 * Math.sin(t * 2 * Math.PI * 1.01)], 320, 0.8);
    const freehand = simplifyStroke(raw, 1);
    assert.equal(kinds(freehand.pieces), 'circle');
    const firstPiece = freehand.pieces[0] as Extract<FreehandPiece, { kind: 'circle' }>;
    assert.ok(Math.abs(firstPiece.radius - 50) < 1.5 && Math.hypot(...firstPiece.center) < 1.5, JSON.stringify(firstPiece));

    return `r ${firstPiece.radius.toFixed(2)}`;
  }],
  ['a half circle is one arc', () => {
    const raw = stroke(t => [60 * Math.cos(t * Math.PI), 60 * Math.sin(t * Math.PI)], 190);
    const freehand = simplifyStroke(raw, 1);
    assert.equal(kinds(freehand.pieces), 'arc');
    assert.ok(deviation(raw, freehand.pieces) < 1.6);

    return `dev ${deviation(raw, freehand.pieces).toFixed(2)}`;
  }],
  ['a wave is one spline through few points, within the tolerance', () => {
    const raw = stroke(t => [t * 300, 40 * Math.sin(t * 3 * Math.PI)], 450);
    const freehand = simplifyStroke(raw, 1);
    assert.equal(kinds(freehand.pieces), 'spline');
    const pointCount = fitPoints(freehand.pieces);
    const dev = deviation(raw, freehand.pieces);
    assert.ok(pointCount <= 16, `${pointCount} fit points`);
    assert.ok(dev < 1.6, `dev ${dev}`);

    return `${raw.length} points → ${pointCount} fit points, dev ${dev.toFixed(2)}`;
  }],
  ['a blob loop is one closed spline with one region', () => {
    const raw = stroke((t) => {
      const a = t * 2 * Math.PI; const radius = 60 + 18 * Math.sin(3 * a);

      return [radius * Math.cos(a), radius * Math.sin(a)]; 
    }, 420);
    raw.push([...raw[0]] as Vec2);
    const freehand = simplifyStroke(raw, 1);
    assert.equal(kinds(freehand.pieces), 'spline');
    assert.equal(freehand.closed, true);
    const pointCount = fitPoints(freehand.pieces);
    assert.ok(pointCount <= 20, `${pointCount} fit points`);
    assert.ok(deviation(raw, freehand.pieces) < 1.6);
    assert.equal(arrangement(toEntities(freehand.pieces)).regions.length, 1);

    return `${raw.length} points → ${pointCount} fit points`;
  }],
  ['a D (a line and a curve) closes into one region', () => {
    const raw = [...stroke(t => [0, 100 - t * 100], 100), ...stroke(t => [70 * Math.sin(t * Math.PI), 50 - 50 * Math.cos(t * Math.PI)], 220).slice(1)];
    const freehand = simplifyStroke(raw, 1);
    assert.equal(freehand.closed, true);
    assert.equal(freehand.pieces.length, 2, kinds(freehand.pieces));
    joined(freehand.pieces, true);
    assert.equal(arrangement(toEntities(freehand.pieces)).regions.length, 1);

    return kinds(freehand.pieces);
  }],
  ['a tap or a tiny scribble makes nothing', () => {
    assert.equal(simplifyStroke([[0, 0], [0.5, 0.2], [0.3, 0.1]], 1).pieces.length, 0);
    assert.equal(simplifyStroke([[0, 0]], 1).pieces.length, 0);

    return 'ok';
  }],
  ['a long scribble stays cheap and within the tolerance', () => {
    const raw = stroke(t => [t * 800 + 30 * Math.sin(t * 40), 80 * Math.sin(t * 7) + 20 * Math.cos(t * 23)], 2400, 0.6);
    const t0 = performance.now();
    const freehand = simplifyStroke(raw, 1);
    const ms = performance.now() - t0;
    const dev = deviation(raw, freehand.pieces);
    assert.ok(dev < 2, `dev ${dev}`);
    assert.ok(ms < 400, `${ms} ms`);

    return `${raw.length} points → ${freehand.pieces.length} pieces, ${fitPoints(freehand.pieces)} fit points, ${ms.toFixed(0)} ms`;
  }]
];
let failed = 0;
for (const [name, fn] of checks) {
  try {
    console.log('ok  ', name, '-', fn());
  } catch (e) {
    failed++;
    console.log('FAIL', name, '-', e instanceof Error ? e.message : e);
  }
}
process.exit(failed ? 1 : 0);
