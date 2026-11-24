// Assemblies: do two bodies run into each other where they are shown?
//
// Asked on every move of a drag, of bodies that are only moved (their meshes stay as they are), so each body's
// mesh is put in a tree of boxes once and the question is asked of the trees. Two bodies are in each other when
// a corner of one is inside the other by more than a little: parts that touch, or sit in each other with a hair
// of play (a nut on its thread), are not - their drawn facets cross here and there without the parts doing so.

import { apply, type Mat4 } from './joints';
import type { Vec3 } from '../doc/types';

/** A rigid move undone (a turn and a shift: the turn's transpose, the shift taken back through it). */
export function inverse(matrix: Mat4): Mat4 {
  const t: Vec3 = [matrix[12], matrix[13], matrix[14]];

  return [matrix[0], matrix[4], matrix[8], 0, matrix[1], matrix[5], matrix[9], 0, matrix[2], matrix[6], matrix[10], 0, -(matrix[0] * t[0] + matrix[1] * t[1] + matrix[2] * t[2]), -(matrix[4] * t[0] + matrix[5] * t[1] + matrix[6] * t[2]), -(matrix[8] * t[0] + matrix[9] * t[1] + matrix[10] * t[2]), 1];
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
    const triangleCount = Math.floor(I.length / 3);
    this.tris = new Uint32Array(triangleCount);
    const mid = new Float32Array(triangleCount * 3);
    for (let t = 0; t < triangleCount; t++) {
      this.tris[t] = t;
      for (let axis = 0; axis < 3; axis++) {
        mid[t * 3 + axis] = (P[I[t * 3] * 3 + axis] + P[I[t * 3 + 1] * 3 + axis] + P[I[t * 3 + 2] * 3 + axis]) / 3;
      }
    }
    for (let i = 0; i < P.length; i += 3) {
      for (let axis = 0; axis < 3; axis++) {
        (this.lo[axis] = Math.min(this.lo[axis], P[i + axis])), (this.hi[axis] = Math.max(this.hi[axis], P[i + axis]));
      }
    }
    if (triangleCount) {
      this.build(0, triangleCount, mid);
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
    const bounds = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    for (let triangleIndex = from; triangleIndex < to; triangleIndex++) {
      const t = this.tris[triangleIndex];
      for (let corner = 0; corner < 3; corner++) {
        const i = this.I[t * 3 + corner] * 3;
        for (let axis = 0; axis < 3; axis++) {
          (b[axis] = Math.min(b[axis], this.P[i + axis])), (b[3 + axis] = Math.max(b[3 + axis], this.P[i + axis]));
        }
      }
      for (let axis = 0; axis < 3; axis++) {
        (bounds[axis] = Math.min(bounds[axis], mid[t * 3 + axis])), (bounds[3 + axis] = Math.max(bounds[3 + axis], mid[t * 3 + axis]));
      }
    }
    this.boxes.push(...b);
    const axis = bounds[3] - bounds[0] > bounds[4] - bounds[1] ? (bounds[3] - bounds[0] > bounds[5] - bounds[2] ? 0 : 2) : bounds[4] - bounds[1] > bounds[5] - bounds[2] ? 1 : 2;
    const cut = (bounds[axis] + bounds[3 + axis]) / 2;
    let split = from;
    for (let triangleIndex = from; triangleIndex < to; triangleIndex++) {
      if (mid[this.tris[triangleIndex] * 3 + axis] < cut) {
        const triangle = this.tris[triangleIndex];
        this.tris[triangleIndex] = this.tris[split];
        this.tris[split++] = triangle;
      }
    }
    if (to - from <= LEAF || split === from || split === to) {
      // A leaf: its triangles, marked by a minus.
      this.kids[node * 2] = -(from + 1);
      this.kids[node * 2 + 1] = to - from;

      return node;
    }
    const left = this.build(from, split, mid);
    const right = this.build(split, to, mid);
    this.kids[node * 2] = left;
    this.kids[node * 2 + 1] = right;

    return node;
  }

  /** How many of the mesh's triangles a ray from `point` goes through: odd, the point is inside. */
  inside(point: Vec3): boolean {
    if (!this.tris.length) {
      return false;
    }
    for (let axis = 0; axis < 3; axis++) {
      if (point[axis] < this.lo[axis] || point[axis] > this.hi[axis]) {
        return false;
      }
    }
    let crossings = 0;
    const stack = [0];
    const values = this.P;
    const indices = this.I;
    while (stack.length) {
      const node = stack.pop()!;
      // The ray and the node's box (the ray goes the positive way along all three).
      let t0 = 0;
      let t1 = Infinity;
      for (let axis = 0; axis < 3; axis++) {
        const a = (this.boxes[node * 6 + axis] - point[axis]) / RAY[axis];
        const b = (this.boxes[node * 6 + 3 + axis] - point[axis]) / RAY[axis];
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
      for (let triangleIndex = from; triangleIndex < from + count; triangleIndex++) {
        const t = this.tris[triangleIndex] * 3;
        const i0 = indices[t] * 3;
        const i1 = indices[t + 1] * 3;
        const i2 = indices[t + 2] * 3;
        // Möller-Trumbore.
        const e1x = values[i1] - values[i0];
        const e1y = values[i1 + 1] - values[i0 + 1];
        const e1z = values[i1 + 2] - values[i0 + 2];
        const e2x = values[i2] - values[i0];
        const e2y = values[i2 + 1] - values[i0 + 1];
        const e2z = values[i2 + 2] - values[i0 + 2];
        const px = RAY[1] * e2z - RAY[2] * e2y;
        const py = RAY[2] * e2x - RAY[0] * e2z;
        const pz = RAY[0] * e2y - RAY[1] * e2x;
        const det = e1x * px + e1y * py + e1z * pz;
        if (Math.abs(det) < 1e-14) {
          continue;
        }
        const inv = 1 / det;
        const tx = point[0] - values[i0];
        const ty = point[1] - values[i0 + 1];
        const tz = point[2] - values[i0 + 2];
        const baryU = (tx * px + ty * py + tz * pz) * inv;
        if (baryU < 0 || baryU > 1) {
          continue;
        }
        const qx = ty * e1z - tz * e1y;
        const qy = tz * e1x - tx * e1z;
        const qz = tx * e1y - ty * e1x;
        const baryV = (RAY[0] * qx + RAY[1] * qy + RAY[2] * qz) * inv;
        if (baryV < 0 || baryU + baryV > 1) {
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
  deepInside(point: Vec3, tol: number): boolean {
    if (!this.inside(point)) {
      return false;
    }
    for (let axis = 0; axis < 3; axis++) {
      for (const offset of [-tol, tol]) {
        const q: Vec3 = [point[0], point[1], point[2]];
        q[axis] += offset;
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
  const one = (into: Solid, of: Solid, matrix: Mat4): boolean => {
    const valuesC = of.corners;
    for (let i = 0; i < valuesC.length; i += 3) {
      const point = apply(matrix, [valuesC[i], valuesC[i + 1], valuesC[i + 2]]);
      if (point[0] < into.lo[0] || point[1] < into.lo[1] || point[2] < into.lo[2] || point[0] > into.hi[0] || point[1] > into.hi[1] || point[2] > into.hi[2]) {
        continue;
      }
      if (into.deepInside(point, tol)) {
        return true;
      }
    }

    return false;
  };

  return one(a, b, bToA) || one(b, a, inverse(bToA));
}
