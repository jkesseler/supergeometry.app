// Offset Edge: a line on a flat face, parallel to a straight edge at a
// distance, running across the face from one side of its outline to the other
// - cut back where it would run past the face, carried on where it would stop
// short. Works on the meshes the kernel sends (the face's triangles tell what
// is inside it, the body's edges where its outline is), so it needs no kernel
// call. Pure: tests/offsetedge.test.ts.

import { dot, len, norm, scale, sub, toPlane, toWorld } from '../geom';
import type { PlaneDef, Vec2, Vec3 } from '../doc/types';
import type { BodyMesh } from '../kernel/protocol';

export interface OffsetLine {
  /** Ends of the line, in the world. */
  a: Vec3;
  b: Vec3;
  /** The same in the face's plane (sketch coordinates). */
  a2: Vec2;
  b2: Vec2;
}

/**
 * The line parallel to edge `ea`-`eb`, `d` from it on face `face` of `body`
 * (towards the face's middle when d > 0), from the face's outline to its
 * outline. A string says why there is none.
 */
export function offsetLineOnFace(body: BodyMesh, face: number, plane: PlaneDef, ea: Vec3, eb: Vec3, distance: number): OffsetLine | string {
  const normal = norm(plane.normal);
  const dir0 = sub(eb, ea);
  if (len(dir0) < 1e-9) {
    return 'That edge has no length';
  }
  // The edge as seen on the face's plane: it has to run along the face.
  const along = sub(dir0, scale(normal, dot(dir0, normal)));
  if (len(along) < len(dir0) * 0.9999) {
    return 'The edge has to run along the face (parallel to it)';
  }
  const e2a = toPlane(plane, ea);
  const e2b = toPlane(plane, eb);
  const edgeDir = norm2(sub2(e2b, e2a));
  let perp: Vec2 = [-edgeDir[1], edgeDir[0]];
  // Positive distances go into the face (towards its middle).
  const tris = faceTriangles(body, face, plane);
  if (!tris.length) {
    return 'That face has no surface to draw on';
  }
  const mid = centroid(tris);
  if (dot2(sub2(mid, e2a), perp) < 0) {
    perp = [-perp[0], -perp[1]];
  }
  const p0 = add2(e2a, scale2(perp, distance));
  // Where the line crosses the face's outline (the body's edges lying in its plane).
  const size = Math.max(...tris.flat().map(triangle => Math.hypot(triangle[0] - mid[0], triangle[1] - mid[1])), 1e-6);
  const tol = size * 1e-6;
  const ts: number[] = [];
  for (const edgeGroup of body.edgeGroups) {
    const info = body.edges[edgeGroup.edge];
    const pts: Vec2[] = [];
    let flat = true;
    for (let i = edgeGroup.start; i < edgeGroup.start + edgeGroup.count; i++) {
      const worldPoint: Vec3 = [body.edgePositions[i * 3], body.edgePositions[i * 3 + 1], body.edgePositions[i * 3 + 2]];
      if (Math.abs(dot(sub(worldPoint, plane.origin), normal)) > size * 1e-4) {
        flat = false;
        break;
      }
      pts.push(toPlane(plane, worldPoint));
    }
    if (!flat || pts.length < 2) {
      continue;
    }
    // A round edge: crossed exactly on its circle (not on the chord drawn for it).
    const circle = info?.type === 'CIRCLE' ? circleIn(plane, info.start, info.mid, info.end) : null;
    for (let pointIndex = 0; pointIndex + 1 < pts.length; pointIndex++) {
      const t = crossSegment(p0, edgeDir, pts[pointIndex], pts[pointIndex + 1], tol);
      if (t === null) {
        continue;
      }
      ts.push(circle ? nearest(onCircle(p0, edgeDir, circle), t) : t);
    }
  }
  ts.sort((x, y) => x - y);
  const cuts = ts.filter((t, i) => i === 0 || t - ts[i - 1] > tol);
  // The spans between crossings that lie on the face, joined where they meet.
  const spans: [number, number][] = [];
  for (let i = 0; i + 1 < cuts.length; i++) {
    const middle = (cuts[i] + cuts[i + 1]) / 2;
    if (!inside(tris, add2(p0, scale2(edgeDir, middle)), tol)) {
      continue;
    }
    const last = spans[spans.length - 1];
    if (last && Math.abs(last[1] - cuts[i]) <= tol) {
      last[1] = cuts[i + 1];
    } else {
      spans.push([cuts[i], cuts[i + 1]]);
    }
  }
  if (!spans.length) {
    return 'At that distance the line misses the face';
  }
  // The span beside the edge (where the edge's middle is, moved over).
  const tm = dot2(sub2(scale2(add2(e2a, e2b), 0.5), e2a), edgeDir) + dot2(sub2(e2a, p0), edgeDir);
  const gap = (span: [number, number]) => (tm < span[0] ? span[0] - tm : tm > span[1] ? tm - span[1] : 0);
  const best = spans.reduce((best, span) => (gap(span) < gap(best) ? span : best));
  const a2 = add2(p0, scale2(edgeDir, best[0]));
  const b2 = add2(p0, scale2(edgeDir, best[1]));

  return { a: toWorld(plane, a2), b: toWorld(plane, b2), a2, b2 };
}

/** The face's triangles, in its plane. */
function faceTriangles(body: BodyMesh, face: number, plane: PlaneDef): [Vec2, Vec2, Vec2][] {
  const out: [Vec2, Vec2, Vec2][] = [];
  const vertexAt = (i: number): Vec2 => toPlane(plane, [body.positions[i * 3], body.positions[i * 3 + 1], body.positions[i * 3 + 2]]);
  for (const faceGroup of body.faceGroups) {
    if (faceGroup.face !== face) {
      continue;
    }
    for (let start = faceGroup.start; start + 2 < faceGroup.start + faceGroup.count; start += 3) {
      out.push([vertexAt(body.indices[start]), vertexAt(body.indices[start + 1]), vertexAt(body.indices[start + 2])]);
    }
  }

  return out;
}

function centroid(tris: [Vec2, Vec2, Vec2][]): Vec2 {
  let ax = 0;
  let ay = 0;
  let weight = 0;
  for (const [a, b, vertexC] of tris) {
    const area = Math.abs((b[0] - a[0]) * (vertexC[1] - a[1]) - (vertexC[0] - a[0]) * (b[1] - a[1])) / 2;
    ax += ((a[0] + b[0] + vertexC[0]) / 3) * area;
    ay += ((a[1] + b[1] + vertexC[1]) / 3) * area;
    weight += area;
  }

  return weight > 0 ? [ax / weight, ay / weight] : tris[0][0];
}

function inside(tris: [Vec2, Vec2, Vec2][], point: Vec2, tol: number): boolean {
  for (const [a, b, vertexC] of tris) {
    const area = (b[0] - a[0]) * (vertexC[1] - a[1]) - (vertexC[0] - a[0]) * (b[1] - a[1]);
    if (Math.abs(area) < 1e-18) {
      continue;
    }
    const baryS = ((point[0] - a[0]) * (vertexC[1] - a[1]) - (vertexC[0] - a[0]) * (point[1] - a[1])) / area;
    const t = ((b[0] - a[0]) * (point[1] - a[1]) - (point[0] - a[0]) * (b[1] - a[1])) / area;
    const e = tol / Math.sqrt(Math.abs(area));
    if (baryS >= -e && t >= -e && baryS + t <= 1 + e) {
      return true;
    }
  }

  return false;
}

/** Where line point + t·direction crosses segment q0-q1 (t), or null. */
function crossSegment(point: Vec2, direction: Vec2, q0: Vec2, q1: Vec2, tol: number): number | null {
  const edge = sub2(q1, q0);
  const den = direction[0] * edge[1] - direction[1] * edge[0];
  const lw = Math.hypot(edge[0], edge[1]);
  if (Math.abs(den) < 1e-12 * Math.max(1, lw)) {
    return null;
  } // along the line: its ends are other edges' crossings
  const offset = sub2(q0, point);
  const t = (offset[0] * edge[1] - offset[1] * edge[0]) / den;
  const along = (offset[0] * direction[1] - offset[1] * direction[0]) / den;
  const e = lw > 0 ? tol / lw : 0;

  return along >= -e && along <= 1 + e ? t : null;
}

interface Circle2 {
  c: Vec2;
  r: number;
}

/** The circle a round edge lies on, in the plane (a whole circle: start = end, mid across from it). */
function circleIn(plane: PlaneDef, start: Vec3, mid: Vec3, end: Vec3): Circle2 | null {
  const [a, middle, b] = [start, mid, end].map(point => toPlane(plane, point));
  let center: Vec2;
  if (Math.hypot(...sub2(a, b)) < 1e-6) {
    center = scale2(add2(a, middle), 0.5);
  } else {
    // Circumcentre of start, mid, end.
    const denominator = 2 * (a[0] * (middle[1] - b[1]) + middle[0] * (b[1] - a[1]) + b[0] * (a[1] - middle[1]));
    if (Math.abs(denominator) < 1e-12) {
      return null;
    }
    const sq = (point: Vec2) => point[0] * point[0] + point[1] * point[1];
    center = [(sq(a) * (middle[1] - b[1]) + sq(middle) * (b[1] - a[1]) + sq(b) * (a[1] - middle[1])) / denominator, (sq(a) * (b[0] - middle[0]) + sq(middle) * (a[0] - b[0]) + sq(b) * (middle[0] - a[0])) / denominator];
  }
  const radius = Math.hypot(...sub2(middle, center));

  return radius > 0 ? { c: center, r: radius } : null;
}

function onCircle(point: Vec2, direction: Vec2, circle2: Circle2): number[] {
  const offset = sub2(point, circle2.c);
  const b = dot2(offset, direction);
  const disc = b * b - (dot2(offset, offset) - circle2.r * circle2.r);
  if (disc < 0) {
    return [];
  }
  const root = Math.sqrt(disc);

  return [-b - root, -b + root];
}

function nearest(ts: number[], t: number): number {
  return ts.length ? ts.reduce((x, y) => (Math.abs(y - t) < Math.abs(x - t) ? y : x)) : t;
}

const sub2 = (a: Vec2, b: Vec2): Vec2 => [a[0] - b[0], a[1] - b[1]];
const add2 = (a: Vec2, b: Vec2): Vec2 => [a[0] + b[0], a[1] + b[1]];
const scale2 = (a: Vec2, factor: number): Vec2 => [a[0] * factor, a[1] * factor];
const dot2 = (a: Vec2, b: Vec2) => a[0] * b[0] + a[1] * b[1];
const norm2 = (a: Vec2): Vec2 => {
  const length = Math.hypot(a[0], a[1]);

  return [a[0] / length, a[1] / length];
};
