// Assemblies: do two bodies run into each other where they are shown?
//
// Asked on every move of a drag, of bodies that are only moved (their meshes stay as they are), so each body's
// mesh is put in a tree of boxes once and the question is asked of the trees. Two bodies are in each other when
// a corner of one is inside the other by more than a little: parts that touch, or sit in each other with a hair
// of play (a nut on its thread), are not - their drawn facets cross here and there without the parts doing so.

import { apply, type Mat4 } from './joints';
import type { Vec3 } from '../doc/types';

/** A rigid move undone (a turn and a shift: the turn's transpose, the shift taken back through it). */
export function inverse(m: Mat4): Mat4 {
  const t: Vec3 = [m[12], m[13], m[14]];

  return [m[0], m[4], m[8], 0, m[1], m[5], m[9], 0, m[2], m[6], m[10], 0, -(m[0] * t[0] + m[1] * t[1] + m[2] * t[2]), -(m[4] * t[0] + m[5] * t[1] + m[6] * t[2]), -(m[8] * t[0] + m[9] * t[1] + m[10] * t[2]), 1];
}

const LEAF = 6;
// (Not along an axis: a ray along one runs down the edges and corners of boxy parts, where "how many faces
// did it cross" has no clean answer.)
const RAY: Vec3 = [0.8017837257372732, 0.5345224838248488, 0.2672612419124244];

/** A body's mesh, ready to be asked whether a point is inside it. */
export class Solid {
  /** The mesh's corners, each once (or one in every few, of a very fine mesh). */
  readonly corners: Float32Array;
  readonly lo: Vec3 = [Infinity, Infinity, Infinity];
  readonly hi: Vec3 = [-Infinity, -Infinity, -Infinity];
  /** The tree: each node's box (6 numbers), and either its two children or its run of triangles. */
  private boxes: number[] = [];
  private kids: number[] = [];
  private tris: Uint32Array;

  constructor(private P: Float32Array, private I: Uint32Array) {
    const n = Math.floor(I.length / 3);
    this.tris = new Uint32Array(n);
    const mid = new Float32Array(n * 3);
    for (let t = 0; t < n; t++) {
      this.tris[t] = t;
      for (let k = 0; k < 3; k++) {
        mid[t * 3 + k] = (P[I[t * 3] * 3 + k] + P[I[t * 3 + 1] * 3 + k] + P[I[t * 3 + 2] * 3 + k]) / 3;
      }
    }
    for (let i = 0; i < P.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        (this.lo[k] = Math.min(this.lo[k], P[i + k])), (this.hi[k] = Math.max(this.hi[k], P[i + k]));
      }
    }
    if (n) {
      this.build(0, n, mid);
    }
    // Corners: one of each place (a mesh has a corner once for every face that meets there).
    const seen = new Set<string>();
    const out: number[] = [];
    const step = Math.max(1, Math.floor(P.length / 3 / 60000));
    for (let i = 0; i < P.length; i += 3 * step) {
      const key = `${Math.round(P[i] * 1e4)},${Math.round(P[i + 1] * 1e4)},${Math.round(P[i + 2] * 1e4)}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      out.push(P[i], P[i + 1], P[i + 2]);
    }
    this.corners = new Float32Array(out);
  }

  private build(from: number, to: number, mid: Float32Array): number {
    const node = this.kids.length / 2;
    this.kids.push(0, 0);
    const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    const c = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    for (let s = from; s < to; s++) {
      const t = this.tris[s];
      for (let v = 0; v < 3; v++) {
        const i = this.I[t * 3 + v] * 3;
        for (let k = 0; k < 3; k++) {
          (b[k] = Math.min(b[k], this.P[i + k])), (b[3 + k] = Math.max(b[3 + k], this.P[i + k]));
        }
      }
      for (let k = 0; k < 3; k++) {
        (c[k] = Math.min(c[k], mid[t * 3 + k])), (c[3 + k] = Math.max(c[3 + k], mid[t * 3 + k]));
      }
    }
    this.boxes.push(...b);
    const axis = c[3] - c[0] > c[4] - c[1] ? (c[3] - c[0] > c[5] - c[2] ? 0 : 2) : c[4] - c[1] > c[5] - c[2] ? 1 : 2;
    const cut = (c[axis] + c[3 + axis]) / 2;
    let m = from;
    for (let s = from; s < to; s++) {
      if (mid[this.tris[s] * 3 + axis] < cut) {
        const w = this.tris[s];
        this.tris[s] = this.tris[m];
        this.tris[m++] = w;
      }
    }
    if (to - from <= LEAF || m === from || m === to) {
      // A leaf: its triangles, marked by a minus.
      this.kids[node * 2] = -(from + 1);
      this.kids[node * 2 + 1] = to - from;

      return node;
    }
    const l = this.build(from, m, mid);
    const r = this.build(m, to, mid);
    this.kids[node * 2] = l;
    this.kids[node * 2 + 1] = r;

    return node;
  }

  /** How many of the mesh's triangles a ray from `p` goes through: odd, the point is inside. */
  inside(p: Vec3): boolean {
    if (!this.tris.length) {
      return false;
    }
    for (let k = 0; k < 3; k++) {
      if (p[k] < this.lo[k] || p[k] > this.hi[k]) {
        return false;
      }
    }
    let crossings = 0;
    const stack = [0];
    const P = this.P;
    const I = this.I;
    while (stack.length) {
      const node = stack.pop()!;
      // The ray and the node's box (the ray goes the positive way along all three).
      let t0 = 0;
      let t1 = Infinity;
      for (let k = 0; k < 3; k++) {
        const a = (this.boxes[node * 6 + k] - p[k]) / RAY[k];
        const b = (this.boxes[node * 6 + 3 + k] - p[k]) / RAY[k];
        t0 = Math.max(t0, a);
        t1 = Math.min(t1, b);
      }
      if (t1 < t0) {
        continue;
      }
      const a = this.kids[node * 2];
      if (a >= 0) {
        stack.push(a, this.kids[node * 2 + 1]);
        continue;
      }
      const from = -a - 1;
      const count = this.kids[node * 2 + 1];
      for (let s = from; s < from + count; s++) {
        const t = this.tris[s] * 3;
        const i0 = I[t] * 3;
        const i1 = I[t + 1] * 3;
        const i2 = I[t + 2] * 3;
        // Möller-Trumbore.
        const e1x = P[i1] - P[i0];
        const e1y = P[i1 + 1] - P[i0 + 1];
        const e1z = P[i1 + 2] - P[i0 + 2];
        const e2x = P[i2] - P[i0];
        const e2y = P[i2 + 1] - P[i0 + 1];
        const e2z = P[i2 + 2] - P[i0 + 2];
        const px = RAY[1] * e2z - RAY[2] * e2y;
        const py = RAY[2] * e2x - RAY[0] * e2z;
        const pz = RAY[0] * e2y - RAY[1] * e2x;
        const det = e1x * px + e1y * py + e1z * pz;
        if (Math.abs(det) < 1e-14) {
          continue;
        }
        const inv = 1 / det;
        const tx = p[0] - P[i0];
        const ty = p[1] - P[i0 + 1];
        const tz = p[2] - P[i0 + 2];
        const u = (tx * px + ty * py + tz * pz) * inv;
        if (u < 0 || u > 1) {
          continue;
        }
        const qx = ty * e1z - tz * e1y;
        const qy = tz * e1x - tx * e1z;
        const qz = tx * e1y - ty * e1x;
        const v = (RAY[0] * qx + RAY[1] * qy + RAY[2] * qz) * inv;
        if (v < 0 || u + v > 1) {
          continue;
        }
        if ((e2x * qx + e2y * qy + e2z * qz) * inv > 0) {
          crossings++;
        }
      }
    }

    return (crossings & 1) === 1;
  }

  /** Inside, and not within `tol` of the surface (as far as six points round it tell). */
  deepInside(p: Vec3, tol: number): boolean {
    if (!this.inside(p)) {
      return false;
    }
    for (let k = 0; k < 3; k++) {
      for (const s of [-tol, tol]) {
        const q: Vec3 = [p[0], p[1], p[2]];
        q[k] += s;
        if (!this.inside(q)) {
          return false;
        }
      }
    }

    return true;
  }
}

/**
 * Does `b`, moved by `bToA` into `a`'s own space, run into `a`: a corner of either more than `tol` inside the
 * other. (Both where they were modelled: `bToA` is none.)
 */
export function penetrates(a: Solid, b: Solid, bToA: Mat4, tol: number): boolean {
  const one = (into: Solid, of: Solid, m: Mat4): boolean => {
    const C = of.corners;
    for (let i = 0; i < C.length; i += 3) {
      const p = apply(m, [C[i], C[i + 1], C[i + 2]]);
      if (p[0] < into.lo[0] || p[1] < into.lo[1] || p[2] < into.lo[2] || p[0] > into.hi[0] || p[1] > into.hi[1] || p[2] > into.hi[2]) {
        continue;
      }
      if (into.deepInside(p, tol)) {
        return true;
      }
    }

    return false;
  };

  return one(a, b, bToA) || one(b, a, inverse(bToA));
}
