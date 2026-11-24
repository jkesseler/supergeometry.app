// Assemblies: how the bodies of a project are held together, and where each is when they move.
//
// The bodies are modelled where they belong, so nothing is put in place: a joint only says how two bodies may
// move against each other - not at all (fixed), round an axis (hinge), along it (slide), or both at once as a
// nut on its thread (screw). Where everything was modelled is home: a joint's value is how far it is from
// there (degrees, or mm for a slide), and all of them at 0 is the model as it was built.
//
// Kinematics only: no weight, no forces. A joint can follow another by a ratio (a gear turning its neighbour).

import type { FaceRef, Vec3 } from '../doc/types';

export type JointType = 'fixed' | 'hinge' | 'slide' | 'screw';

export interface Joint {
  id: string;
  name: string;
  type: JointType;
  /** The two bodies: `b` moves against `a` (which of them stays still is told by what is grounded). */
  a: string;
  b: string;
  /** The joint's line, where the bodies were modelled: a point on it and its direction. */
  origin: Vec3;
  axis: Vec3;
  /** How far it may go (degrees; mm for a slide). Missing: as far as it is dragged. */
  min?: number;
  max?: number;
  /** A screw's: mm along the axis for each full turn. */
  pitch?: number;
  /** It follows another joint: its value is that one's, times `ratio` (a gear: minus the teeth's ratio). */
  drive?: { joint: string; ratio: number };
  /** The faces it was picked by, so its line follows them when the model changes. */
  refA?: FaceRef;
  refB?: FaceRef;
}

/** A 4 x 4 matrix, column by column (as three.js keeps it). */
export type Mat4 = number[];

export const IDENTITY: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

export function mul(a: Mat4, b: Mat4): Mat4 {
  const o = new Array<number>(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
  }

  return o;
}

export function translation(v: Vec3): Mat4 {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, v[0], v[1], v[2], 1];
}

export function apply(m: Mat4, p: Vec3): Vec3 {
  return [m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12], m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13], m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]];
}

/** A direction through a matrix (its turning only). */
export function turn(m: Mat4, d: Vec3): Vec3 {
  return [m[0] * d[0] + m[4] * d[1] + m[8] * d[2], m[1] * d[0] + m[5] * d[1] + m[9] * d[2], m[2] * d[0] + m[6] * d[1] + m[10] * d[2]];
}

const unit = (v: Vec3): Vec3 => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;

  return [v[0] / l, v[1] / l, v[2] / l];
};

/** A turn of `deg` round the line through `origin` along `axis`, and `along` mm along it. */
export function about(origin: Vec3, axis: Vec3, deg: number, along = 0): Mat4 {
  const [x, y, z] = unit(axis);
  const t = (deg * Math.PI) / 180;
  const c = Math.cos(t);
  const s = Math.sin(t);
  const k = 1 - c;
  // Rodrigues, column by column.
  const r = [c + x * x * k, y * x * k + z * s, z * x * k - y * s, x * y * k - z * s, c + y * y * k, z * y * k + x * s, x * z * k + y * s, y * z * k - x * s, c + z * z * k];
  const ro: Vec3 = [r[0] * origin[0] + r[3] * origin[1] + r[6] * origin[2], r[1] * origin[0] + r[4] * origin[1] + r[7] * origin[2], r[2] * origin[0] + r[5] * origin[1] + r[8] * origin[2]];

  return [r[0], r[1], r[2], 0, r[3], r[4], r[5], 0, r[6], r[7], r[8], 0, origin[0] - ro[0] + x * along, origin[1] - ro[1] + y * along, origin[2] - ro[2] + z * along, 1];
}

/** What a joint does to its `b` at a value: the move from home. */
export function motion(j: Joint, value: number): Mat4 {
  if (j.type === 'hinge') {
    return about(j.origin, j.axis, value);
  }
  if (j.type === 'slide') {
    return about(j.origin, j.axis, 0, value);
  }
  if (j.type === 'screw') {
    return about(j.origin, j.axis, value, ((j.pitch ?? 1) * value) / 360);
  }

  return IDENTITY;
}

const clamp = (j: Joint, v: number): number => Math.min(j.max ?? Infinity, Math.max(j.min ?? -Infinity, v));

/** Each joint's value as it is: its own, kept in its limits - or what the joint it follows gives it. */
export function effective(joints: Joint[], values: Record<string, number>): Record<string, number> {
  const by = new Map(joints.map(j => [j.id, j]));
  const out: Record<string, number> = {};
  const of = (j: Joint, depth: number): number => {
    if (j.id in out) {
      return out[j.id];
    }
    const d = j.drive && depth < 32 ? by.get(j.drive.joint) : undefined;
    const v = j.type === 'fixed' ? 0 : d && d.id !== j.id ? of(d, depth + 1) * j.drive!.ratio : clamp(j, values[j.id] ?? 0);

    return (out[j.id] = v);
  };
  for (const j of joints) {
    of(j, 0);
  }

  return out;
}

/** The joint whose own value sets this one's (itself, when it follows no other), and by how much. */
export function driverOf(joints: Joint[], id: string): { joint: Joint; ratio: number } | null {
  const by = new Map(joints.map(j => [j.id, j]));
  let j = by.get(id);
  let ratio = 1;
  for (let i = 0; j && i < 32; i++) {
    const d = j.drive ? by.get(j.drive.joint) : undefined;
    if (!d || d.id === j.id) {
      return { joint: j, ratio };
    }
    ratio *= j.drive!.ratio;
    j = d;
  }

  return null;
}

export interface Tree {
  /** Each body's joint towards what is grounded, the body on its other side, and how many joints away the ground is. */
  up: Map<string, { joint: Joint; parent: string; depth: number }>;
  roots: string[];
}

/**
 * The bodies as a tree from what stands still: `ground` when it is given and there, else - in each group of
 * bodies joined together - the one that comes first in the project. A joint that would close a ring of bodies
 * is left out (the ring's other joints carry it).
 */
export function tree(joints: Joint[], bodies: string[], ground?: string): Tree {
  const have = new Set(bodies);
  const live = joints.filter(j => have.has(j.a) && have.has(j.b) && j.a !== j.b);
  const up: Tree['up'] = new Map();
  const seen = new Set<string>();
  const roots: string[] = [];
  const order = ground && have.has(ground) ? [ground, ...bodies.filter(b => b !== ground)] : bodies;
  for (const root of order) {
    if (seen.has(root) || !live.some(j => j.a === root || j.b === root)) {
      continue;
    }
    roots.push(root);
    seen.add(root);
    const queue = [root];
    while (queue.length) {
      const p = queue.shift()!;
      const depth = (up.get(p)?.depth ?? 0) + 1;
      for (const j of live) {
        const c = j.a === p ? j.b : j.b === p ? j.a : null;
        if (!c || seen.has(c)) {
          continue;
        }
        seen.add(c);
        up.set(c, { joint: j, parent: p, depth });
        queue.push(c);
      }
    }
  }

  return { up, roots };
}

export interface Explode {
  /** 0: together. 1: each body a body's width from its neighbour. */
  factor: number;
  /** Each body's middle and how big it is (the radius of a ball round it), where it was modelled. */
  centers: Record<string, Vec3>;
  sizes: Record<string, number>;
}

/**
 * Where every body is: its move from where it was modelled. Bodies no joint holds (and what is grounded) stay.
 * Exploded, each body is pushed off its neighbour along their joint's line (a fixed joint: from middle to middle).
 */
export function solve(joints: Joint[], bodies: string[], values: Record<string, number>, ground?: string, explode?: Explode): Map<string, Mat4> {
  const t = tree(joints, bodies, ground);
  const v = effective(joints, values);
  const out = new Map<string, Mat4>();
  const push = new Map<string, Vec3>();
  for (const r of t.roots) {
    out.set(r, IDENTITY);
  }
  // (Parents before children: by how far from the ground they are.)
  const order = [...t.up.entries()].sort((p, q) => p[1].depth - q[1].depth);
  for (const [body, { joint, parent }] of order) {
    const m = motion(joint, joint.b === body ? v[joint.id] : -v[joint.id]);
    out.set(body, mul(out.get(parent) ?? IDENTITY, m));
    if (!explode || !(explode.factor > 0)) {
      continue;
    }
    const cp = explode.centers[parent];
    const cc = explode.centers[body];
    const between: Vec3 = cp && cc ? [cc[0] - cp[0], cc[1] - cp[1], cc[2] - cp[2]] : [0, 0, 0];
    let dir = unit(joint.axis);
    const side = dir[0] * between[0] + dir[1] * between[1] + dir[2] * between[2];
    if (joint.type === 'fixed' && Math.hypot(...between) > 1e-9) {
      dir = unit(between);
    } else if (side < 0) {
      dir = [-dir[0], -dir[1], -dir[2]];
    }
    const far = explode.factor * ((explode.sizes[parent] ?? 0) + (explode.sizes[body] ?? 0));
    const base = push.get(parent) ?? [0, 0, 0];
    push.set(body, [base[0] + dir[0] * far, base[1] + dir[1] * far, base[2] + dir[2] * far]);
  }
  for (const [body, p] of push) {
    out.set(body, mul(translation(p), out.get(body)!));
  }

  return out;
}

/** What a face gives a joint: a line (a round face's axis; a flat face's normal through its middle), or nothing. */
export interface PickLine {
  origin: Vec3;
  dir: Vec3;
  round: boolean;
  /** Found from the face's drawn points (a thread's flank), not known exactly: good to a twentieth of a millimetre. */
  rough?: boolean;
}

/**
 * The joint two picks make, as they stand: on one line (two round faces on one axis, two flat faces one above the
 * other) - a hinge, or a screw when one of the bodies is threaded; two flat faces side by side - a slide along
 * the first's normal; anything else - fixed. Its line is the first pick's.
 */
export function propose(a: PickLine | null, b: PickLine | null, pitch?: number): { type: JointType; origin: Vec3; axis: Vec3; pitch?: number } {
  // (The joint's line is the first pick's - or the second's, where only that one is known exactly.)
  const line = a && b && a.rough && !b.rough ? b : (a ?? b);
  if (!line) {
    return { type: 'fixed', origin: [0, 0, 0], axis: [0, 0, 1] };
  }
  const axis = unit(line.dir);
  const base = { origin: line.origin, axis };
  if (!a || !b) {
    return { type: 'fixed', ...base };
  }
  const da = unit(a.dir);
  const d = unit(b.dir);
  const parallel = Math.abs(da[0] * d[0] + da[1] * d[1] + da[2] * d[2]) > (a.rough || b.rough ? 0.995 : 0.999);
  if (!parallel) {
    return { type: 'fixed', ...base };
  }
  const w: Vec3 = [b.origin[0] - a.origin[0], b.origin[1] - a.origin[1], b.origin[2] - a.origin[2]];
  const along = w[0] * axis[0] + w[1] * axis[1] + w[2] * axis[2];
  const off = Math.hypot(w[0] - axis[0] * along, w[1] - axis[1] * along, w[2] - axis[2] * along);
  const size = Math.max(1, Math.hypot(...w));
  // (To a hundredth of a millimetre and a thousandth of how far apart they are: faces are found by their drawn points.)
  if (off < 1e-3 * size + (a.rough || b.rough ? 0.15 : 1e-2)) {
    return pitch ? { type: 'screw', ...base, pitch } : { type: 'hinge', ...base };
  }

  return a.round || b.round ? { type: 'fixed', ...base } : { type: 'slide', ...base };
}

/**
 * The line a face is turned round, from its points and the way it faces at each: a thread's flank, a cone, any
 * face made by turning a curve round a line (or screwing it along one). Along that line the face's normals all
 * lean the same - so it is the direction their leaning varies least in - and seen along it they all point at it.
 * Null where there is no such line (a flat face, a ball, a freeform face).
 */
export function turnAxis(points: Vec3[], normals: Vec3[]): { origin: Vec3; dir: Vec3 } | null {
  const n = Math.min(points.length, normals.length);
  if (n < 6) {
    return null;
  }
  const mean: Vec3 = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < 3; k++) {
      mean[k] += normals[i][k] / n;
    }
  }
  // How the normals spread, as a symmetric 3 x 3; its axes by Jacobi turns.
  const a = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let i = 0; i < n; i++) {
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) {
        a[r][c] += ((normals[i][r] - mean[r]) * (normals[i][c] - mean[c])) / n;
      }
    }
  }
  const v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let sweep = 0; sweep < 24; sweep++) {
    for (const [p, q] of [[0, 1], [0, 2], [1, 2]] as const) {
      if (Math.abs(a[p][q]) < 1e-15) {
        continue;
      }
      const th = (a[q][q] - a[p][p]) / (2 * a[p][q]);
      const tt = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1));
      const c = 1 / Math.sqrt(tt * tt + 1);
      const s = tt * c;
      for (let k = 0; k < 3; k++) {
        const akp = a[k][p];
        const akq = a[k][q];
        a[k][p] = c * akp - s * akq;
        a[k][q] = s * akp + c * akq;
      }
      for (let k = 0; k < 3; k++) {
        const apk = a[p][k];
        const aqk = a[q][k];
        a[p][k] = c * apk - s * aqk;
        a[q][k] = s * apk + c * aqk;
      }
      for (let k = 0; k < 3; k++) {
        const vkp = v[k][p];
        const vkq = v[k][q];
        v[k][p] = c * vkp - s * vkq;
        v[k][q] = s * vkp + c * vkq;
      }
    }
  }
  const ev = [a[0][0], a[1][1], a[2][2]];
  const lo = ev.indexOf(Math.min(...ev));
  const hi = Math.max(...ev);
  const mid = ev.filter((_, i) => i !== lo).reduce((p, q) => Math.min(p, q));
  // Round a line: no spread along it, and a spread both ways across it (a face that only bends one way has none).
  if (!(hi > 1e-6) || ev[lo] > 0.02 * hi || mid < 0.05 * hi) {
    return null;
  }
  const dir = unit([v[0][lo], v[1][lo], v[2][lo]]);
  // Across the line: each normal's part there points along a line through the axis. Where those lines meet.
  const x = unit(Math.abs(dir[0]) < 0.9 ? [0, -dir[2], dir[1]] : [-dir[2], 0, dir[0]]);
  const y: Vec3 = [dir[1] * x[2] - dir[2] * x[1], dir[2] * x[0] - dir[0] * x[2], dir[0] * x[1] - dir[1] * x[0]];
  const d3 = (p: Vec3, q: Vec3) => p[0] * q[0] + p[1] * q[1] + p[2] * q[2];
  let m00 = 0;
  let m01 = 0;
  let m11 = 0;
  let b0 = 0;
  let b1 = 0;
  let used = 0;
  for (let i = 0; i < n; i++) {
    const nx = d3(normals[i], x);
    const ny = d3(normals[i], y);
    const l = Math.hypot(nx, ny);
    if (l < 0.2) {
      continue;
    }
    // (The line through the point along its normal: every point c of it has u.c = u.p, u across the normal.)
    const ux = -ny / l;
    const uy = nx / l;
    const k = ux * d3(points[i], x) + uy * d3(points[i], y);
    m00 += ux * ux;
    m01 += ux * uy;
    m11 += uy * uy;
    b0 += ux * k;
    b1 += uy * k;
    used++;
  }
  const det = m00 * m11 - m01 * m01;
  if (used < 6 || Math.abs(det) < 1e-9 * used * used) {
    return null;
  }
  const cx = (b0 * m11 - b1 * m01) / det;
  const cy = (m00 * b1 - m01 * b0) / det;
  // (A point of the line, level with the face's points.)
  let along = 0;
  for (let i = 0; i < n; i++) {
    along += d3(points[i], dir) / n;
  }

  return { origin: [x[0] * cx + y[0] * cy + dir[0] * along, x[1] * cx + y[1] * cy + dir[1] * along, x[2] * cx + y[2] * cy + dir[2] * along], dir };
}

export const JOINT_NAMES: Record<JointType, string> = { fixed: 'Fixed', hinge: 'Hinge', slide: 'Slide', screw: 'Screw' };
