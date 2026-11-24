// The cage Freeform Face shapes a flat face with: a grid of quads over the
// face whose border runs round the face's edge (on a rectangle, a plain grid;
// on a round or odd-shaped face, a grid stretched to fit it). The border
// points stay where they are - the face's edges don't move - and the inside
// points are moved like any freeform cage's.

import { cross, dot, norm, sub, xDirFor } from '../geom';
import type { Vec3 } from '../doc/types';
import type { Cage } from './cage';

type P2 = [number, number];

/** The outer outline of a set of triangles, in order (anticlockwise about `normal`), in the plane's 2D. */
function outline(tris: [Vec3, Vec3, Vec3][], uv: (p: Vec3) => P2): P2[] {
  const key = (point: P2) => `${Math.round(point[0] * 1e5)},${Math.round(point[1] * 1e5)}`;
  const at = new Map<string, P2>();
  const uses = new Map<string, number>();
  const dir = new Map<string, string>();
  for (const t of tris) {
    const q = t.map(uv);
    // Each triangle anticlockwise in the plane.
    const area = (q[1][0] - q[0][0]) * (q[2][1] - q[0][1]) - (q[2][0] - q[0][0]) * (q[1][1] - q[0][1]);
    if (Math.abs(area) < 1e-14) {
      continue;
    }
    const ordered = area > 0 ? q : [q[0], q[2], q[1]];
    for (let corner = 0; corner < 3; corner++) {
      const a = key(ordered[corner]);
      const b = key(ordered[(corner + 1) % 3]);
      if (a === b) {
        continue;
      }
      at.set(a, ordered[corner]);
      const e = a < b ? `${a}|${b}` : `${b}|${a}`;
      uses.set(e, (uses.get(e) ?? 0) + 1);
      dir.set(`${a}>${b}`, b);
    }
  }
  // Border edges (used once), followed head to tail.
  const next = new Map<string, string>();
  for (const [key, b] of dir) {
    const a = key.slice(0, key.indexOf('>'));
    const e = a < b ? `${a}|${b}` : `${b}|${a}`;
    if (uses.get(e) === 1) {
      next.set(a, b);
    }
  }
  const loops: P2[][] = [];
  const seen = new Set<string>();
  for (const start of next.keys()) {
    if (seen.has(start)) {
      continue;
    }
    const loop: P2[] = [];
    let key: string | undefined = start;
    while (key && !seen.has(key)) {
      seen.add(key);
      loop.push(at.get(key)!);
      key = next.get(key);
    }
    if (loop.length >= 3) {
      loops.push(loop);
    }
  }
  const signed = (loop: P2[]) => loop.reduce((total, point, i) => total + point[0] * loop[(i + 1) % loop.length][1] - loop[(i + 1) % loop.length][0] * point[1], 0) / 2;
  // The outer one: the biggest (anticlockwise).
  loops.sort((a, b) => Math.abs(signed(b)) - Math.abs(signed(a)));
  const outer = loops[0] ?? [];

  return signed(outer) < 0 ? outer.reverse() : outer;
}

/**
 * `n` + 1 points along a polyline, both ends included: evenly by length, then
 * the one nearest each corner on the way moved onto it - the grid's border
 * goes through the face's corners (an L's inward one too), so the smooth
 * surface laid on the grid can have its border on the face's edges.
 */
function resample(pts: P2[], count: number): P2[] {
  const out = evenly(pts, count);
  const acc = [0];
  for (let i = 1; i < pts.length; i++) {
    acc.push(acc[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  }
  const total = acc[acc.length - 1];
  const used = new Set<number>();
  for (let i = 1; i < pts.length - 1 && total > 0; i++) {
    const d1 = [pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]];
    const d2 = [pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]];
    const turn = Math.abs(Math.atan2(d1[0] * d2[1] - d1[1] * d2[0], d1[0] * d2[0] + d1[1] * d2[1]));
    if (turn < (25 * Math.PI) / 180) {
      continue;
    }
    // (The sample whose place along the side is nearest: the order of the points stays.)
    const slot = Math.round((acc[i] / total) * count);
    if (slot < 1 || slot > count - 1 || used.has(slot)) {
      continue;
    }
    used.add(slot);
    out[slot] = [pts[i][0], pts[i][1]];
  }

  return out;
}

/** `count` + 1 points evenly along a polyline (by length), both ends included. */
function evenly(pts: P2[], count: number): P2[] {
  const acc = [0];
  for (let i = 1; i < pts.length; i++) {
    acc.push(acc[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  }
  const total = acc[acc.length - 1];
  const out: P2[] = [];
  let i = 1;
  for (let index = 0; index <= count; index++) {
    const want = (total * index) / count;
    while (i < pts.length - 1 && acc[i] < want) {
      i++;
    }
    const fraction = acc[i] > acc[i - 1] ? (want - acc[i - 1]) / (acc[i] - acc[i - 1]) : 0;
    const t = Math.max(0, Math.min(1, fraction));
    out.push([pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t]);
  }

  return out;
}

/**
 * Ways to choose the four points of the outline where the grid's sides meet
 * (best first): the face's own
 * outward corners when it has four or more (the four best spread), else
 * spread evenly (a round face).
 */
function fourCorners(loop: P2[], acc: number[], total: number): number[][] {
  const count = loop.length;
  const turn = loop.map((point, i) => {
    const a = loop[(i + count - 1) % count];
    const b = loop[(i + 1) % count];
    const d1 = [point[0] - a[0], point[1] - a[1]];
    const d2 = [b[0] - point[0], b[1] - point[1]];

    // (Signed: turning in, at a corner going into the face like an L's, is negative.)
    return Math.atan2(d1[0] * d2[1] - d1[1] * d2[0], d1[0] * d2[0] + d1[1] * d2[1]);
  });
  // Only outward corners: an inward one (an L's) stays along a side.
  let corners = loop.map((_, i) => i).filter(i => turn[i] > (25 * Math.PI) / 180);
  if (corners.length > 16) {
    corners = corners.sort((a, b) => turn[b] - turn[a]).slice(0, 16).sort((a, b) => a - b);
  }
  const cand = [...corners];
  // Too few corners: points evenly round it to choose from too.
  if (corners.length < 4) {
    for (let attempt = 0; attempt < 32; attempt++) {
      const want = (total * attempt) / 32;
      let i = 0;
      while (i < count - 1 && acc[i + 1] <= want) {
        i++;
      }
      if (!cand.includes(i)) {
        cand.push(i);
      }
    }
  }
  cand.sort((a, b) => a - b);
  const isCorner = new Set(corners);
  const gap = (i: number, j: number) => (acc[j] - acc[i] + total) % total;
  const all: { q: number[]; score: number }[] = [];
  const countC = cand.length;
  for (let a = 0; a < countC; a++) {
    for (let b = a + 1; b < countC; b++) {
      for (let cornerC = b + 1; cornerC < countC; cornerC++) {
        for (let cornerD = cornerC + 1; cornerD < countC; cornerD++) {
          const q = [cand[a], cand[b], cand[cornerC], cand[cornerD]];
          const shortest = Math.min(gap(q[0], q[1]), gap(q[1], q[2]), gap(q[2], q[3]), gap(q[3], q[0]));
          const score = shortest / total + 0.2 * q.filter(i => isCorner.has(i)).length;
          all.push({ q, score });
        }
      }
    }
  }

  // Best first (the next ones are tried when a grid on the best won't fit the face).
  return all.sort((a, b) => b.score - a.score).slice(0, 12).map(scored => scored.q);
}

/**
 * A cage over the flat face made of `tris` (points relative to `center`):
 * `divisions` cells across its longer way.
 */
export function faceCage(tris: [Vec3, Vec3, Vec3][], center: Vec3, normal: Vec3, divisions = 5): Cage | null {
  const nn = norm(normal);
  const xDir = xDirFor(nn);
  const vAxis = norm(cross(nn, xDir));
  const uv = (point: Vec3): P2 => [dot(sub(point, center), xDir), dot(sub(point, center), vAxis)];
  const drawn = outline(tris, uv);
  if (drawn.length < 3) {
    return null;
  }
  // Points along its straight edges too (a triangle's outline is three points:
  // nowhere for a fourth corner of the grid to go but a point along an edge).
  const around = drawn.reduce((t, point, i) => t + Math.hypot(drawn[(i + 1) % drawn.length][0] - point[0], drawn[(i + 1) % drawn.length][1] - point[1]), 0);
  const loop: P2[] = [];
  drawn.forEach((point, i) => {
    const q = drawn[(i + 1) % drawn.length];
    const pieces = Math.max(1, Math.ceil((Math.hypot(q[0] - point[0], q[1] - point[1]) / around) * 32));
    for (let piece = 0; piece < pieces; piece++) {
      loop.push([point[0] + ((q[0] - point[0]) * piece) / pieces, point[1] + ((q[1] - point[1]) * piece) / pieces]);
    }
  });
  const count = loop.length;
  const acc = [0];
  for (let i = 1; i <= count; i++) {
    acc.push(acc[i - 1] + Math.hypot(loop[i % count][0] - loop[i - 1][0], loop[i % count][1] - loop[i - 1][1]));
  }
  const total = acc[count];
  for (const cs of fourCorners(loop, acc, total)) {
    // The four sides, each from one corner to the next.
    const side = (a: number, b: number): P2[] => {
      const out: P2[] = [];
      for (let i = a; ; i = (i + 1) % count) {
        out.push(loop[i]);
        if (i === b) {
          break;
        }
      }

      return out;
    };
    const sides = [0, 1, 2, 3].map(corner => side(cs[corner], cs[(corner + 1) % 4]));
    const length = (side: P2[]) => side.reduce((t, point, i) => (i ? t + Math.hypot(point[0] - side[i - 1][0], point[1] - side[i - 1][1]) : 0), 0);
    const Lu = (length(sides[0]) + length(sides[2])) / 2;
    const Lv = (length(sides[1]) + length(sides[3])) / 2;
    const big = Math.max(Lu, Lv);
    const nu = Math.max(2, Math.round((divisions * Lu) / big));
    const nv = Math.max(2, Math.round((divisions * Lv) / big));
    const bottom = resample(sides[0], nu);
    const right = resample(sides[1], nv);
    const top = resample(sides[2], nu).reverse();
    const left = resample(sides[3], nv).reverse();
    // Coons: the inside blended from the four sides.
    const id = (i: number, j: number) => j * (nu + 1) + i;
    const at: P2[] = [];
    for (let j = 0; j <= nv; j++) {
      for (let i = 0; i <= nu; i++) {
        const fraction = i / nu;
        const t = j / nv;
        if (j === 0) {
          at.push(bottom[i]);
        } else if (j === nv) {
          at.push(top[i]);
        } else if (i === 0) {
          at.push(left[j]);
        } else if (i === nu) {
          at.push(right[j]);
        } else {
          const coordinate = (axis: 0 | 1) =>
            (1 - t) * bottom[i][axis] + t * top[i][axis] + (1 - fraction) * left[j][axis] + fraction * right[j][axis]
            - ((1 - fraction) * (1 - t) * bottom[0][axis] + fraction * (1 - t) * bottom[nu][axis] + (1 - fraction) * t * top[0][axis] + fraction * t * top[nu][axis]);
          at.push([coordinate(0), coordinate(1)]);
        }
      }
    }
    // A face that isn't convex (an L): the blend can put points outside it.
    // Evened out (each inside point to the middle of its four neighbours) a
    // step at a time, till they're all on the face (evened out all the way they
    // can end up outside again); never: null (a coarser grid may do).
    const inside = (point: P2) => {
      let isInside = false;
      for (let a = 0, b = count - 1; a < count; b = a++) {
        const [pa, pb] = [loop[a], loop[b]];
        if (pa[1] > point[1] !== pb[1] > point[1] && point[0] < ((pb[0] - pa[0]) * (point[1] - pa[1])) / (pb[1] - pa[1]) + pa[0]) {
          isInside = !isInside;
        }
      }

      return isInside;
    };
    const allIn = () => at.every((point, index) => index % (nu + 1) === 0 || index % (nu + 1) === nu || index <= nu || index >= nv * (nu + 1) || inside(point));
    for (let round = 0; round < 400 && !allIn(); round++) {
      for (let j = 1; j < nv; j++) {
        for (let i = 1; i < nu; i++) {
          const q = [at[id(i - 1, j)], at[id(i + 1, j)], at[id(i, j - 1)], at[id(i, j + 1)]];
          at[id(i, j)] = [(q[0][0] + q[1][0] + q[2][0] + q[3][0]) / 4, (q[0][1] + q[1][1] + q[2][1] + q[3][1]) / 4];
        }
      }
    }
    if (!allIn()) {
      continue;
    }
    const verts: Vec3[] = at.map(point => [xDir[0] * point[0] + vAxis[0] * point[1], xDir[1] * point[0] + vAxis[1] * point[1], xDir[2] * point[0] + vAxis[2] * point[1]]);
    const faces: [number, number, number, number][] = [];
    for (let j = 0; j < nv; j++) {
      for (let i = 0; i < nu; i++) {
        faces.push([id(i, j), id(i + 1, j), id(i + 1, j + 1), id(i, j + 1)]);
      }
    }

    return { verts, faces };
  }

  return null;
}

/**
 * Freeform Face over several faces side by side (a top and the side it bends
 * into): one way they all face - the middle of their normals - to lay one grid
 * over all of them, seen along it.
 */
export function facesNormal(normals: Vec3[]): Vec3 {
  const sum = normals.reduce((a, normal) => {
    const unit = norm(normal);

    return [a[0] + unit[0], a[1] + unit[1], a[2] + unit[2]] as Vec3;
  }, [0, 0, 0] as Vec3);

  return norm(sum);
}

/**
 * How far along `normal` from `point` the faces made of `tris` are (the nearest
 * way; null when no triangle is under or over it).
 */
export function toFaces(point: Vec3, normal: Vec3, tris: [Vec3, Vec3, Vec3][]): number | null {
  let best: number | null = null;
  for (const [a, b, vertexC] of tris) {
    // Where the line point + t·normal meets the triangle's plane, and whether that is inside it.
    const e1 = sub(b, a);
    const e2 = sub(vertexC, a);
    const normalCross = cross(normal, e2);
    const det = dot(e1, normalCross);
    if (Math.abs(det) < 1e-12) {
      continue;
    }
    const offset = sub(point, a);
    const baryU = dot(offset, normalCross) / det;
    const q = cross(offset, e1);
    const baryV = dot(normal, q) / det;
    const eps = 1e-6;
    if (baryU < -eps || baryV < -eps || baryU + baryV > 1 + eps) {
      continue;
    }
    const t = dot(e2, q) / det;
    if (best === null || Math.abs(t) < Math.abs(best)) {
      best = t;
    }
  }

  return best;
}

/** A grid laid flat (points relative to `center`) put down onto the faces it was laid over, each point straight along `normal`. */
export function liftOnto(cage: Cage, center: Vec3, normal: Vec3, tris: [Vec3, Vec3, Vec3][]): Cage {
  const unitNormal = norm(normal);

  return {
    faces: cage.faces,
    verts: cage.verts.map((vertex) => {
      const t = toFaces([center[0] + vertex[0], center[1] + vertex[1], center[2] + vertex[2]], unitNormal, tris);

      return t === null || Math.abs(t) < 1e-9 ? vertex : ([vertex[0] + unitNormal[0] * t, vertex[1] + unitNormal[1] * t, vertex[2] + unitNormal[2] * t] as Vec3);
    })
  };
}

/**
 * Where the outline of faces side by side turns sharply (a top meeting the
 * side it bends into: its outline turns down there), the nearest border point
 * of the grid goes right onto that corner - the smooth surface's border bends
 * only at its points, and would cut the corner off the body's edge. (Points
 * relative to `center`.)
 */
export function onCorners(cage: Cage, center: Vec3, tris: [Vec3, Vec3, Vec3][]): Cage {
  const key = (point: Vec3) => point.map(x => Math.round(x * 1e4)).join(',');
  const at = new Map<string, Vec3>();
  const uses = new Map<string, number>();
  for (const t of tris) {
    for (let corner = 0; corner < 3; corner++) {
      const a = key(t[corner]);
      const b = key(t[(corner + 1) % 3]);
      if (a === b) {
        continue;
      }
      at.set(a, t[corner]);
      const e = a < b ? `${a}|${b}` : `${b}|${a}`;
      uses.set(e, (uses.get(e) ?? 0) + 1);
    }
  }
  const nb = new Map<string, string[]>();
  for (const [e, use] of uses) {
    if (use !== 1) {
      continue;
    }
    const [a, b] = e.split('|');
    nb.set(a, [...(nb.get(a) ?? []), b]);
    nb.set(b, [...(nb.get(b) ?? []), a]);
  }
  const corners: Vec3[] = [];
  for (const [key, ns] of nb) {
    if (ns.length !== 2) {
      continue;
    }
    const point = at.get(key)!;
    const d1 = norm(sub(point, at.get(ns[0])!));
    const d2 = norm(sub(at.get(ns[1])!, point));
    if (dot(d1, d2) < Math.cos((25 * Math.PI) / 180)) {
      corners.push(point);
    }
  }
  const border = new Set<number>();
  const count = new Map<string, number>();
  for (const face of cage.faces) {
    for (let corner = 0; corner < 4; corner++) {
      const a = face[corner];
      const b = face[(corner + 1) % 4];
      const e = a < b ? `${a}|${b}` : `${b}|${a}`;
      count.set(e, (count.get(e) ?? 0) + 1);
    }
  }
  for (const [e, uses] of count) {
    if (uses === 1) {
      for (const vertexKey of e.split('|')) {
        border.add(Number(vertexKey));
      }
    }
  }
  const verts = cage.verts.map(vertex => [...vertex] as Vec3);
  const taken = new Set<number>();
  for (const corner of corners) {
    const rel = sub(corner, center);
    let best = -1;
    let bd = Infinity;
    for (const i of border) {
      const distance = Math.hypot(verts[i][0] - rel[0], verts[i][1] - rel[1], verts[i][2] - rel[2]);
      if (distance < bd) {
        ((bd = distance), (best = i));
      }
    }
    if (best < 0 || taken.has(best)) {
      continue;
    }
    taken.add(best);
    verts[best] = rel;
  }

  return { faces: cage.faces, verts };
}
