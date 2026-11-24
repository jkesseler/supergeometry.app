// Run: npx tsx tests/projectlean.test.ts - an edge projected into a sketch. A
// line is two ends, a circle a circle or an arc. Any other curve that follows
// its edge is the edge's own shape (24 points) with only its two ends to pick,
// snap to and drag - like the edge. A free copy (`lean`) is the user's to
// shape: a circle seen at a slant (or an ellipse) an ellipse, anything else a
// spline with as few points as hold it; unlinked, a follower becomes that.
import { leanSpline, offsetEntity, projectPolyline } from '../src/sketch/edit';
import { pointsOf } from '../src/sketch/constraints';
import { splinePoints } from '../src/sketch/curves';
import { check, done, near } from './kit';
import type { PlaneDef, SketchEntity, Vec2, Vec3 } from '../src/doc/types';

const XY: PlaneDef = { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, 0, 1] };
const SAMPLES = 64;
/** How far the spline strays from the points it was made from, at most. */
function strays(e: SketchEntity, pts: Vec3[]): number {
  if (e.kind !== 'spline') {
    return NaN;
  }
  const curve = splinePoints(e.points, e.closed, e.mode, 48);
  const seg = (point: Vec2, a: Vec2, b: Vec2) => {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const t = Math.max(0, Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)));

    return Math.hypot(point[0] - a[0] - t * dx, point[1] - a[1] - t * dy);
  };
  let worst = 0;
  for (const point of pts) {
    let distance = Infinity;
    for (let i = 1; i < curve.length; i++) {
      distance = Math.min(distance, seg([point[0], point[1]], curve[i - 1], curve[i]));
    }
    worst = Math.max(worst, distance);
  }

  return worst;
}

// A straight edge: a line.
const line = projectPolyline([[0, 0, 0], [5, 5, 3], [10, 10, 6]], XY, 'LINE');
check('a straight edge: a line', line?.kind === 'line', line);

// A circle flat on the plane: a circle; part of one: an arc.
const ring = Array.from({ length: SAMPLES + 1 }, (_, index): Vec3 => [20 * Math.cos((index / SAMPLES) * 2 * Math.PI), 20 * Math.sin((index / SAMPLES) * 2 * Math.PI), 4]);
check('a circle flat on the plane: a circle', projectPolyline(ring, XY, 'CIRCLE')?.kind === 'circle');
check('part of a circle: an arc', projectPolyline(ring.slice(0, SAMPLES / 4 + 1), XY, 'CIRCLE')?.kind === 'arc');

// A circle seen at a slant (tilted 60° about x): an ellipse 20 by 10, exactly.
const tilt = (point: Vec3): Vec3 => [point[0], point[1] * 0.5, point[1] * Math.sqrt(0.75)];
const slant = projectPolyline(ring.map(tilt), XY, 'CIRCLE', true);
check('a circle seen at a slant: an ellipse', slant?.kind === 'ellipse', slant);
if (slant?.kind === 'ellipse') {
  const [big, small] = [Math.max(slant.rx, slant.ry), Math.min(slant.rx, slant.ry)];
  check('... 20 by 10, about its middle', near(big, 20, 1e-6) && near(small, 10, 1e-6) && near(slant.center[0], 0, 1e-6) && near(slant.center[1], 0, 1e-6), slant);
}
// The same turned 30° in the plane and moved: still an ellipse, its long way at 30°.
const turned = ring.map(tilt).map((point): Vec3 => [point[0] * Math.cos(Math.PI / 6) - point[1] * Math.sin(Math.PI / 6) + 7, point[0] * Math.sin(Math.PI / 6) + point[1] * Math.cos(Math.PI / 6) - 3, 0]);
const el2 = projectPolyline(turned, XY, 'ELLIPSE', true);
check('turned and moved: an ellipse at 7, -3', el2?.kind === 'ellipse' && near(el2.center[0], 7, 1e-6) && near(el2.center[1], -3, 1e-6), el2);
if (el2?.kind === 'ellipse') {
  const long = el2.rx > el2.ry ? el2.rotation : el2.rotation + Math.PI / 2;
  check('... its long way at 30°', near(Math.abs(Math.cos(long - Math.PI / 6)), 1, 1e-6), el2);
}

// Part of an ellipse (a quarter of the slanted circle): a spline through a few points, on the edge.
const quarter = ring.map(tilt).slice(0, SAMPLES / 4 + 1);
// Part of an ellipse (a quarter of the slanted circle): part of an ellipse, exactly - two ends, like the edge.
const arc = projectPolyline(quarter, XY, 'ELLIPSE');
check('part of an ellipse: part of an ellipse', arc?.kind === 'ellipse' && arc.sweep !== undefined, arc);
if (arc?.kind === 'ellipse') {
  const ends = pointsOf(arc);
  const [big, small] = [Math.max(arc.rx, arc.ry), Math.min(arc.rx, arc.ry)];
  check('... 20 by 10, a quarter of it', near(big, 20, 1e-6) && near(small, 10, 1e-6) && near(Math.abs(arc.sweep!), Math.PI / 2, 1e-6), arc);
  check("... its two ends the edge's ends, and its middle", ends.length === 3 && near(ends[0].at[0], 20, 1e-6) && near(ends[0].at[1], 0, 1e-6) && near(ends[1].at[0], 0, 1e-6) && near(ends[1].at[1], 10, 1e-6), ends);
  // Run the other way (the edge's own direction), it is the same quarter from its other end.
  const back = projectPolyline([...quarter].reverse(), XY, 'CIRCLE');
  check('... the edge run the other way: from its other end', back?.kind === 'ellipse' && near(pointsOf(back)[0].at[1], 10, 1e-6) && near(pointsOf(back)[1].at[0], 20, 1e-6), back);
  // More than half way round: still the way the edge goes.
  const most = projectPolyline(ring.map(tilt).slice(0, (SAMPLES * 3) / 4 + 1), XY, 'CIRCLE');
  check('... three quarters of it: three quarters', most?.kind === 'ellipse' && near(Math.abs(most.sweep!), Math.PI * 1.5, 1e-6), most);
}
// (A curve of an older project, made as a spline, stays one.)
const q = projectPolyline(quarter, XY, 'ELLIPSE', true, false);
check('part of an ellipse, kept a spline (an older curve)', q?.kind === 'spline', q);
if (q?.kind === 'spline') {
  check('... through fewer than the 17 it was made from', q.points.length < 17, q.points.length);
  check("... its ends the edge's ends", near(q.points[0][0], 20, 1e-9) && near(q.points[q.points.length - 1][1], 10, 1e-9), [q.points[0], q.points[q.points.length - 1]]);
  check('... within a two-thousandth of its size of the edge', strays(q, quarter) < Math.hypot(20, 10) * 5e-4 * 1.5, strays(q, quarter));
}

// A wavy edge (an S): a spline with the points its bends ask for, far fewer than 24.
const wave = Array.from({ length: SAMPLES + 1 }, (_, index): Vec3 => [(index / SAMPLES) * 60, 8 * Math.sin((index / SAMPLES) * 2 * Math.PI), 0]);
const waveSpline = projectPolyline(wave, XY, 'BSPLINE_CURVE', true);
check('a wavy edge: a spline', waveSpline?.kind === 'spline', waveSpline?.kind);
if (waveSpline?.kind === 'spline') {
  check('... through 12 points at most', waveSpline.points.length <= 12, waveSpline.points.length);
  check('... on the edge', strays(waveSpline, wave) < 60 * 5e-4 * 1.5, strays(waveSpline, wave));
}
// A closed curve that is no ellipse (a rounded square): a closed spline, few points.
const sq = Array.from({ length: SAMPLES }, (_, index): Vec3 => {
  const a = (index / SAMPLES) * 2 * Math.PI;
  const radius = 10 / Math.pow(Math.pow(Math.abs(Math.cos(a)), 4) + Math.pow(Math.abs(Math.sin(a)), 4), 0.25);

  return [radius * Math.cos(a), radius * Math.sin(a), 0];
});
const squareSpline = projectPolyline([...sq, sq[0]], XY, 'BSPLINE_CURVE', true);
check('a closed curve that is no ellipse: a closed spline', squareSpline?.kind === 'spline' && squareSpline.closed, squareSpline?.kind);
if (squareSpline?.kind === 'spline') {
  check('... through fewer points than it was made from', squareSpline.points.length < SAMPLES, squareSpline.points.length);
}

// One that follows its edge: the edge's own shape, 24 points - and two ends to pick.
const long = ring.map(tilt).slice(0, SAMPLES / 2 + 1);
const follow = projectPolyline(long, XY, 'ELLIPSE', false, false);
check('a curve that follows its edge: 24 points of it', follow?.kind === 'spline' && follow.points.length === 24, follow?.kind === 'spline' ? follow.points.length : follow);
const oldRing = projectPolyline(ring.map(tilt), XY, 'CIRCLE');
check('... a slanted circle too: 24 points, closed', oldRing?.kind === 'spline' && oldRing.closed && oldRing.points.length === 24, oldRing?.kind);
if (follow?.kind === 'spline') {
  const linked = { ...follow, id: 'ref-abc' } as SketchEntity;
  const ends = pointsOf(linked);
  check('... linked, only its two ends are points', ends.length === 2 && ends[0].p === 'k0' && ends[1].p === 'k23' && near(ends[0].at[0], 20, 1e-9) && near(ends[1].at[0], -20, 1e-9), ends);
  check('... not linked (a free curve), all of them', pointsOf({ ...follow, id: 'abc' } as SketchEntity).length === 24);
  // Unlinked: the user's own curve, with only the points it needs.
  const freed = leanSpline({ ...follow, id: 'abc' } as SketchEntity);
  check('unlinked: fewer points, the same ends', freed.kind === 'spline' && freed.points.length < 24 && near(freed.points[0][0], 20, 1e-9) && near(freed.points[freed.points.length - 1][0], -20, 1e-9), freed.kind === 'spline' ? freed.points.length : freed);
  check('... still on the edge', strays(freed, long) < 40 * 5e-4 * 3, strays(freed, long));
}

// The offset of a curve that follows an edge (24 points, out of sight): its own curve, few points - it was 97.
if (follow?.kind === 'spline') {
  const off = offsetEntity({ ...follow, id: 'ref-abc' } as SketchEntity, 2);
  check('the offset of a projected curve: a spline of a third of the points it had (97), at most', off?.kind === 'spline' && off.points.length <= 32, off?.kind === 'spline' ? off.points.length : off);
  if (off?.kind === 'spline') {
    // Half an ellipse 20 by 10 moved 2 sideways: every point of it 2 from the curve it came from.
    const src = splinePoints((follow as { points: Vec2[] }).points, false, 'fit', 48);
    const far = (point: Vec2) => Math.min(...src.map(q => Math.hypot(point[0] - q[0], point[1] - q[1])));
    const worst = Math.max(...splinePoints(off.points, false, 'fit', 24).map(splinePoint => Math.abs(far(splinePoint) - 2)));
    check('... 2 from the curve all along', worst < 0.03, worst);
  }
}
done();
