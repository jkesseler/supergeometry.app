// Curves of a sketch that follow a body's edge have moved (the body changed):
// what is dimensioned to them is carried along before the sketch is solved
// again. A distance says how far, not which side: a pin 8 mm from a wall that
// moved 40 mm was left on the wall's other side, 8 mm from it there.
import { refsOf } from './constraints';
import { transformEntity } from './edit';
import type { SketchConstraint, SketchEntity, Vec2 } from '../doc/types';

/** Where a curve is, as one point (a line's middle, a circle's centre, the mean of a curve's points). */
function middle(e: SketchEntity): Vec2 {
  switch (e.kind) {
    case 'line':
      return [(e.a[0] + e.b[0]) / 2, (e.a[1] + e.b[1]) / 2];
    case 'arc':
      return [(e.a[0] + e.m[0] + e.b[0]) / 3, (e.a[1] + e.m[1] + e.b[1]) / 3];
    case 'spline':
    case 'polyline': {
      const count = Math.max(1, e.points.length);

      return [e.points.reduce((sum, point) => sum + point[0], 0) / count, e.points.reduce((sum, point) => sum + point[1], 0) / count];
    }
    default:
      return e.center;
  }
}

/**
 * `now` (the sketch with its edge-following curves where the edges are now)
 * with the other curves moved along: each group of curves tied together by
 * constraints is shifted by what the followed curves it is tied to moved.
 * A line that moved along itself (the edge got longer) shifts nothing.
 */
export function carried(old: SketchEntity[], now: SketchEntity[], constraints: SketchConstraint[], held: Set<string>): SketchEntity[] {
  const was = new Map(old.map(e => [e.id, e]));
  // What each followed curve asks of what is tied to it: a shift along a direction (a line: square to it), or a shift outright.
  const asks = new Map<string, { n?: Vec2; v: Vec2 }>();
  for (const e of now) {
    const previous = was.get(e.id);
    if (!held.has(e.id) || !previous || previous === e) {
      continue;
    }
    const [m0, m1] = [middle(previous), middle(e)];
    if (previous.kind === 'line' && e.kind === 'line') {
      const length = Math.hypot(previous.b[0] - previous.a[0], previous.b[1] - previous.a[1]) || 1;
      const normal: Vec2 = [-(previous.b[1] - previous.a[1]) / length, (previous.b[0] - previous.a[0]) / length];
      const distance = normal[0] * (m1[0] - previous.a[0]) + normal[1] * (m1[1] - previous.a[1]);
      asks.set(e.id, { n: normal, v: [normal[0] * distance, normal[1] * distance] });
    } else {
      asks.set(e.id, { v: [m1[0] - m0[0], m1[1] - m0[1]] });
    }
  }
  if (!asks.size) {
    return now;
  }
  // Groups of free curves tied to each other.
  const parent = new Map<string, string>();
  const find = (a: string): string => {
    let root = a;
    while (parent.has(root) && parent.get(root) !== root) {
      root = parent.get(root)!;
    }
    parent.set(a, root);

    return root;
  };
  const ids = new Set(now.map(e => e.id));
  for (const constraint of constraints) {
    const free = refsOf(constraint).filter(id => ids.has(id) && !held.has(id));
    for (const id of free) {
      find(id);
    }
    for (let i = 1; i < free.length; i++) {
      parent.set(find(free[0]), find(free[i]));
    }
  }
  // The shift that best gives each group what its followed curves ask (least squares, the smallest such shift).
  const sums = new Map<string, { a: number; b: number; c: number; x: number; y: number; seen: Set<string> }>();
  for (const constraint of constraints) {
    const refs = refsOf(constraint);
    const free = refs.find(id => ids.has(id) && !held.has(id));
    if (!free) {
      continue;
    }
    const root = find(free);
    let sum = sums.get(root);
    if (!sum) {
      sums.set(root, (sum = { a: 0, b: 0, c: 0, x: 0, y: 0, seen: new Set() }));
    }
    for (const id of refs) {
      const ask = asks.get(id);
      if (!ask || sum.seen.has(id)) {
        continue;
      }
      sum.seen.add(id);
      // (n n^T) t = n d for a line; t = v otherwise.
      const [nx, ny] = ask.n ?? [1, 0];
      if (ask.n) {
        sum.a += nx * nx;
        sum.b += nx * ny;
        sum.c += ny * ny;
      } else {
        sum.a += 1;
        sum.c += 1;
      }
      sum.x += ask.v[0];
      sum.y += ask.v[1];
    }
  }
  const shift = new Map<string, Vec2>();
  for (const [root, sum] of sums) {
    if (!sum.seen.size) {
      continue;
    }
    const epsilon = 1e-9;
    const [a, b, sumC] = [sum.a + epsilon, sum.b, sum.c + epsilon];
    const det = a * sumC - b * b;
    const t: Vec2 = [(sumC * sum.x - b * sum.y) / det, (a * sum.y - b * sum.x) / det];
    if (Math.hypot(t[0], t[1]) > 1e-9) {
      shift.set(root, t);
    }
  }
  if (!shift.size) {
    return now;
  }

  return now.map((e) => {
    const t = !held.has(e.id) && parent.has(e.id) ? shift.get(find(e.id)) : undefined;

    return t ? transformEntity(e, point => [point[0] + t[0], point[1] + t[1]]) : e;
  });
}
