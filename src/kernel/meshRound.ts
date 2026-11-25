// Round faces found in a mesh.
//
// A mesh file (STL, and what OBJ and 3MF are turned into) has no round faces: a hole is a ring of flat strips. Flat
// neighbours are merged into real flat faces when the file comes in, but a boss came in as 250 strips, with no round
// face for Thread, Hole's centre, a joint or a measured diameter to find. Asked for after the app was posted: a way
// to turn a mesh into a solid that can be edited.
//
// Here, the triangles only (no geometry kernel): which runs of strips are a cylinder, and which cylinder. Flat
// triangles are grouped into flat regions; a strip is a region between two creases that run the same way with a
// small turn at each; seen along that way the creases are points, and a run of them on one circle is a cylinder -
// all the way round (a hole, a boss, a pin) or part of the way (a rounded upright corner). engine.ts then makes each
// one truly round.
//
// Not found, and left as they are: cones, balls and rounded rims (their strips do not run one way), cylinders of
// fewer than 12 sides (a real twelve-sided hole cannot be told from a round one, so that is where the line is), and
// meshes that were sculpted or thinned out, which have no strips.

import { add, cross, dot, len, norm, scale, sub, xDirFor } from '../geom';
import type { Vec3 } from '../doc/types';

export interface MeshCylinder {
  /** A point on the axis, the axis' direction, the radius. */
  c: Vec3;
  a: Vec3;
  r: number;
  /** From where to where along the axis (as dot(p - c, a)). */
  t0: number;
  t1: number;
  /** Where it starts round the axis: the direction of angle 0, and how far it goes on (radians; 2π: all the way). */
  u: Vec3;
  sweep: number;
  /** A hole's wall (the body is outside it); false: a boss's or pin's (the body is inside it). */
  concave: boolean;
  /** The widest turn from one strip to the next (radians), and how many strips. */
  step: number;
  strips: number;
  /** Every strip runs the whole length (false: some end early - on a slope, at another feature). */
  even: boolean;
  /** How much volume lies between the strips and the true round face. */
  sliver: number;
  /** Its strips (flat regions of the mesh it was found in). */
  regions?: number[];
}

/** The triangles of an STL file, nine numbers each; null when it is not one. */
export function stlTriangles(bytes: Uint8Array): Float64Array | null {
  if (bytes.length >= 84) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const n = view.getUint32(80, true);
    if (84 + n * 50 === bytes.length) {
      const out = new Float64Array(n * 9);
      for (let i = 0; i < n; i++) {
        for (let k = 0; k < 9; k++) {
          out[i * 9 + k] = view.getFloat32(84 + i * 50 + 12 + k * 4, true);
        }
      }

      return out;
    }
  }
  const text = new TextDecoder().decode(bytes);
  if (!/^\s*solid/.test(text)) {
    return null;
  }
  const nums: number[] = [];
  const re = /vertex\s+(\S+)\s+(\S+)\s+(\S+)/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    nums.push(Number(m[1]), Number(m[2]), Number(m[3]));
  }

  return nums.length && nums.length % 9 === 0 && nums.every(Number.isFinite) ? Float64Array.from(nums) : null;
}

/**
 * A mesh's separate parts (triangles that share no corner with the others), each as its own triangles - a file may
 * hold a box and its lid. Null when one of them is inside-out (the inner skin of a hollow: not a part of its own)
 * or there are a great many (loose crumbs: not a file this reads part by part).
 */
export function meshParts(tris: Float64Array): Float64Array[] | null {
  const nt = tris.length / 9;
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < tris.length; i++) {
    (lo = Math.min(lo, tris[i])), (hi = Math.max(hi, tris[i]));
  }
  const q = Math.max(1e-7, (hi - lo || 1) * 2e-7);
  const ids = new Map<string, number>();
  const parent: number[] = [];
  const find = (i: number): number => {
    while (parent[i] !== i) {
      i = parent[i] = parent[parent[i]];
    }

    return i;
  };
  const corner = new Int32Array(nt * 3);
  for (let i = 0; i < nt * 3; i++) {
    const key = `${Math.round(tris[i * 3] / q)},${Math.round(tris[i * 3 + 1] / q)},${Math.round(tris[i * 3 + 2] / q)}`;
    let id = ids.get(key);
    if (id === undefined) {
      (id = parent.length), ids.set(key, id), parent.push(id);
    }
    corner[i] = id;
  }
  for (let t = 0; t < nt; t++) {
    const a = find(corner[t * 3]);
    parent[find(corner[t * 3 + 1])] = a;
    parent[find(corner[t * 3 + 2])] = a;
  }
  const groups = new Map<number, number[]>();
  for (let t = 0; t < nt; t++) {
    const g = find(corner[t * 3]);
    const list = groups.get(g);
    if (list) {
      list.push(t);
    } else {
      groups.set(g, [t]);
    }
  }
  if (groups.size === 1) {
    return [tris];
  }
  if (groups.size > 64) {
    return null;
  }
  const out: Float64Array[] = [];
  for (const list of groups.values()) {
    const part = new Float64Array(list.length * 9);
    let volume = 0;
    list.forEach((t, k) => {
      const p = tris.subarray(t * 9, t * 9 + 9);
      part.set(p, k * 9);
      volume += (p[0] * (p[4] * p[8] - p[5] * p[7]) - p[1] * (p[3] * p[8] - p[5] * p[6]) + p[2] * (p[3] * p[7] - p[4] * p[6])) / 6;
    });
    if (!(volume > 0)) {
      return null;
    }
    out.push(part);
  }

  return out;
}

/** The widest turn between two strips of one cylinder: twelve sides and up. */
const MAX_TURN = (30.5 * Math.PI) / 180;
/** The least a part of a cylinder goes round. */
const MIN_SWEEP = (20 * Math.PI) / 180;
/** Flatter than this between two triangles: one flat region. */
const FLAT = (0.02 * Math.PI) / 180;

interface Region {
  n: Vec3;
  area: number;
  tris: number[];
}

/** A mesh read: its corners (each once), its triangles by corner, and its flat regions - triangles joined across edges with no turn. */
interface Mesh {
  size: number;
  /** How near two corners are one. */
  q: number;
  pts: Vec3[];
  corner: Int32Array;
  normal: Vec3[];
  area: Float64Array;
  /** The triangles on each edge, by `low corner * corners + high corner`. */
  onEdge: Map<number, number[]>;
  regions: Map<number, Region>;
  /** The region a triangle is in. */
  find(t: number): number;
}

function readMesh(tris: Float64Array): Mesh | null {
  const nt = tris.length / 9;
  if (!nt) {
    return null;
  }
  // ---- the corners, each once
  const lo: Vec3 = [Infinity, Infinity, Infinity];
  const hi: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < tris.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      (lo[k] = Math.min(lo[k], tris[i + k])), (hi[k] = Math.max(hi[k], tris[i + k]));
    }
  }
  const size = len(sub(hi, lo)) || 1;
  const q = Math.max(1e-7, size * 2e-7);
  const ids = new Map<string, number>();
  const pts: Vec3[] = [];
  const corner = new Int32Array(nt * 3);
  for (let i = 0; i < nt * 3; i++) {
    const p: Vec3 = [tris[i * 3], tris[i * 3 + 1], tris[i * 3 + 2]];
    const key = `${Math.round(p[0] / q)},${Math.round(p[1] / q)},${Math.round(p[2] / q)}`;
    let id = ids.get(key);
    if (id === undefined) {
      (id = pts.length), ids.set(key, id), pts.push(p);
    }
    corner[i] = id;
  }
  // ---- each triangle's normal and area; the triangles on each edge
  const normal: Vec3[] = new Array(nt);
  const area = new Float64Array(nt);
  const onEdge = new Map<number, number[]>();
  const np = pts.length;
  for (let t = 0; t < nt; t++) {
    const [a, b, c] = [corner[t * 3], corner[t * 3 + 1], corner[t * 3 + 2]];
    const n = cross(sub(pts[b], pts[a]), sub(pts[c], pts[a]));
    const l = len(n);
    area[t] = l / 2;
    normal[t] = l > 0 ? scale(n, 1 / l) : [0, 0, 0];
    if (a === b || b === c || a === c) {
      continue;
    }
    for (const [x, y] of [[a, b], [b, c], [c, a]]) {
      const key = Math.min(x, y) * np + Math.max(x, y);
      const list = onEdge.get(key);
      if (list) {
        list.push(t);
      } else {
        onEdge.set(key, [t]);
      }
    }
  }
  // ---- flat regions: triangles joined across edges with no turn
  const parent = new Int32Array(nt).map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      i = parent[i] = parent[parent[i]];
    }

    return i;
  };
  const flatDot = Math.cos(FLAT);
  for (const list of onEdge.values()) {
    if (list.length !== 2) {
      continue;
    }
    const [s, t] = list;
    if (area[s] > 0 && area[t] > 0 && dot(normal[s], normal[t]) > flatDot) {
      parent[find(s)] = find(t);
    }
  }
  const regions = new Map<number, Region>();
  for (let t = 0; t < nt; t++) {
    if (!(area[t] > 0)) {
      continue;
    }
    const r = find(t);
    let g = regions.get(r);
    if (!g) {
      regions.set(r, (g = { n: [0, 0, 0], area: 0, tris: [] }));
    }
    g.n = add(g.n, scale(normal[t], area[t]));
    g.area += area[t];
    g.tris.push(t);
  }
  for (const g of regions.values()) {
    g.n = norm(g.n);
  }
  // Flat means every corner in one plane - not only each triangle nearly in its neighbour's: a gentle curve cut
  // fine (a wide cone's flats, eighteen in a row each a hair off the last) was joined into one "flat" region, and
  // the shape pressed flat with it. Such a region is taken apart again, each triangle its own.
  const off = Math.max(1e-6, size * 3e-6);
  for (const [id, g] of [...regions]) {
    if (g.tris.length < 2) {
      continue;
    }
    let d = 0;
    for (const t of g.tris) {
      for (let k = 0; k < 3; k++) {
        d += (dot(g.n, pts[corner[t * 3 + k]]) * area[t]) / 3;
      }
    }
    d /= g.area;
    let flat = true;
    for (const t of g.tris) {
      for (let k = 0; k < 3 && flat; k++) {
        if (Math.abs(dot(g.n, pts[corner[t * 3 + k]]) - d) > off) {
          flat = false;
        }
      }
    }
    if (flat) {
      continue;
    }
    regions.delete(id);
    for (const t of g.tris) {
      parent[t] = t;
      regions.set(t, { n: normal[t], area: area[t], tris: [t] });
    }
  }

  return { size, q, pts, corner, normal, area, onEdge, regions, find };
}

/** The cylinders a mesh's strips make. `tris`: nine numbers a triangle. */
export function meshCylinders(tris: Float64Array): MeshCylinder[] {
  const mesh = readMesh(tris);

  return mesh ? cylindersOf(mesh) : [];
}

function cylindersOf(mesh: Mesh): MeshCylinder[] {
  const { size, q, pts, corner, onEdge, regions, find } = mesh;
  const np = pts.length;
  const flatDot = Math.cos(FLAT);
  // ---- creases with a small turn, by the way they run
  interface Crease {
    a: number;
    b: number;
    /** Its middle. */
    at: Vec3;
  }
  const ways: { d: Vec3; creases: Crease[] }[] = [];
  const wayOf = new Map<string, number>();
  const wayFor = (d: Vec3): number => {
    // (The same way whichever end it is told from; found again on either of two grids, so that a way on the line
    // between two cells of one is still one way.)
    const big = Math.abs(d[0]) > Math.abs(d[1]) ? (Math.abs(d[0]) > Math.abs(d[2]) ? 0 : 2) : Math.abs(d[1]) > Math.abs(d[2]) ? 1 : 2;
    if (d[big] < 0) {
      d = scale(d, -1);
    }
    const k1 = `a${Math.round(d[0] * 2000)},${Math.round(d[1] * 2000)},${Math.round(d[2] * 2000)}`;
    const k2 = `b${Math.round(d[0] * 2000 + 0.5)},${Math.round(d[1] * 2000 + 0.5)},${Math.round(d[2] * 2000 + 0.5)}`;
    const found = wayOf.get(k1) ?? wayOf.get(k2);
    const id = found ?? ways.push({ d, creases: [] }) - 1;
    wayOf.set(k1, id);
    wayOf.set(k2, id);

    return id;
  };
  const minDot = Math.cos(MAX_TURN);
  for (const [key, list] of onEdge) {
    if (list.length !== 2) {
      continue;
    }
    const a = find(list[0]);
    const b = find(list[1]);
    if (a === b) {
      continue;
    }
    const ra = regions.get(a);
    const rb = regions.get(b);
    if (!ra || !rb) {
      continue;
    }
    const turn = dot(ra.n, rb.n);
    if (turn < minDot || turn > flatDot) {
      continue;
    }
    const p = pts[Math.floor(key / np)];
    const p2 = pts[key % np];
    const d = sub(p2, p);
    const l = len(d);
    if (l < q * 4) {
      continue;
    }
    ways[wayFor(scale(d, 1 / l))].creases.push({ a, b, at: scale(add(p, p2), 0.5) });
  }

  const out: MeshCylinder[] = [];
  const used = new Set<number>();
  // (The ways with the most creases first: a cylinder's own way before a way that only crosses it.)
  for (const way of [...ways].sort((x, y) => y.creases.length - x.creases.length)) {
    if (way.creases.length < 3) {
      continue;
    }
    const axis = snapDir(norm(way.d));
    const u = norm(xDirFor(axis));
    const v = norm(cross(axis, u));
    const flatPt = (p: Vec3): [number, number] => [dot(p, u), dot(p, v)];
    // The creases seen along the way: points.
    const grid = Math.max(1e-6, size * 2e-6);
    const pointIds = new Map<string, number>();
    const points: [number, number][] = [];
    const pointOf = (p: Vec3): number => {
      const f = flatPt(p);
      const key = `${Math.round(f[0] / grid)},${Math.round(f[1] / grid)}`;
      let id = pointIds.get(key);
      if (id === undefined) {
        (id = points.length), pointIds.set(key, id), points.push(f);
      }

      return id;
    };
    // Strips joined by this way's creases: one piece each.
    const piece = new Map<number, number>();
    const top = (r: number): number => {
      let x = r;
      while (piece.get(x) !== undefined && piece.get(x) !== x) {
        x = piece.get(x)!;
      }

      return x;
    };
    const side = (r: number) => Math.abs(dot(regions.get(r)!.n, axis)) < 2e-3;
    const creasesOf = new Map<number, Set<number>>();
    for (const c of way.creases) {
      if (!side(c.a) || !side(c.b) || used.has(c.a) || used.has(c.b)) {
        continue;
      }
      const p = pointOf(c.at);
      for (const r of [c.a, c.b]) {
        if (!piece.has(r)) {
          piece.set(r, r);
        }
        let set = creasesOf.get(r);
        if (!set) {
          creasesOf.set(r, (set = new Set()));
        }
        set.add(p);
      }
      piece.set(top(c.a), top(c.b));
    }
    const pieces = new Map<number, number[]>();
    for (const r of piece.keys()) {
      const t = top(r);
      const list = pieces.get(t);
      if (list) {
        list.push(r);
      } else {
        pieces.set(t, [r]);
      }
    }
    for (const members of pieces.values()) {
      // A strip lies between two creases: a chord from one point to the other.
      const chords = new Map<string, { p: number; q: number; regions: number[] }>();
      const at = new Map<number, Set<number>>();
      for (const r of members) {
        const set = creasesOf.get(r)!;
        if (set.size !== 2) {
          continue;
        }
        const [p, q2] = [...set].sort((x, y) => x - y);
        const key = `${p}-${q2}`;
        const ch = chords.get(key);
        if (ch) {
          ch.regions.push(r);
        } else {
          chords.set(key, { p, q: q2, regions: [r] });
          for (const [x, y] of [[p, q2], [q2, p]]) {
            let set2 = at.get(x);
            if (!set2) {
              at.set(x, (set2 = new Set()));
            }
            set2.add(y);
          }
        }
      }
      if (chords.size < 3) {
        continue;
      }
      // (More than two strips at one crease: not something this reads.)
      if ([...at.values()].some(s => s.size > 2)) {
        continue;
      }
      // The points in order: a line of them from an end, or round a ring.
      const seen = new Set<number>();
      for (const start of [...[...at.keys()].filter(p => at.get(p)!.size === 1), ...at.keys()]) {
        if (seen.has(start)) {
          continue;
        }
        const order = [start];
        seen.add(start);
        let ring = false;
        for (let prev = -1, cur = start; ; ) {
          const next = [...at.get(cur)!].find(x => x !== prev && (!seen.has(x) || (x === start && order.length > 2)));
          if (next === undefined) {
            break;
          }
          if (next === start) {
            ring = true;
            break;
          }
          order.push(next);
          seen.add(next);
          prev = cur;
          cur = next;
        }
        const chordOf = (p: number, q2: number) => chords.get(`${Math.min(p, q2)}-${Math.max(p, q2)}`)!;
        // Runs of points on one circle.
        const n = order.length;
        const P = (i: number) => points[order[((i % n) + n) % n]];
        // How far off its circle a point may be: what a file's seven digits leave, no more. (Judged on the circle
        // nearest all the points of a run: one through three neighbours of a finely cut round is anyone's guess.)
        const tol = Math.max(2e-6, size * 2e-6);
        const fits = (from: number, count: number): boolean => {
          const list = Array.from({ length: count }, (_, k) => P(from + k));
          const c = fitCircle(list);

          return !!c && list.every(p => Math.abs(Math.hypot(p[0] - c.c[0], p[1] - c.c[1]) - c.r) <= tol);
        };
        const chordLen = (i: number) => Math.hypot(P(i)[0] - P(i + 1)[0], P(i)[1] - P(i + 1)[1]);
        const take = (from: number, count: number, whole: boolean): void => {
          const fit = fitCircle(Array.from({ length: count }, (_, k) => P(from + k)));
          if (!fit) {
            return;
          }
          const chordsHere = Array.from({ length: whole ? count : count - 1 }, (_, k) => chordOf(order[(from + k) % n], order[(from + k + 1) % n]));
          const regs = chordsHere.flatMap(c => c.regions);
          // The angle of each point, going round one way.
          const ang = Array.from({ length: count }, (_, k) => Math.atan2(P(from + k)[1] - fit.c[1], P(from + k)[0] - fit.c[0]));
          const turnOf = (x: number, y: number) => {
            let d = y - x;
            while (d <= -Math.PI) {
              d += 2 * Math.PI;
            }
            while (d > Math.PI) {
              d -= 2 * Math.PI;
            }

            return d;
          };
          const turns = chordsHere.map((_, k) => turnOf(ang[k], ang[(k + 1) % count]));
          const sign = Math.sign(turns[0]);
          if (!sign || turns.some(t => Math.sign(t) !== sign || Math.abs(t) > MAX_TURN)) {
            return;
          }
          const sweep = whole ? 2 * Math.PI : Math.abs(turns.reduce((s, t) => s + t, 0));
          if (!whole && sweep > 2 * Math.PI - 1e-6) {
            return;
          }
          // (A few strips of a gentle curve lie near a circle too: a round goes some way round.)
          if (sweep < MIN_SWEEP) {
            return;
          }
          // (Told from where it starts going the way the angle grows.)
          const start2 = sign > 0 ? ang[0] : ang[count - 1];
          const c3 = add(scale(u, fit.c[0]), scale(v, fit.c[1]));
          // Hole or boss: which way its strips face, from the axis.
          let outward = 0;
          let tLo = Infinity;
          let tHi = -Infinity;
          let even = true;
          let sliver = 0;
          const ends: [number, number][] = [];
          chordsHere.forEach((ch, k) => {
            const mid: [number, number] = [(points[ch.p][0] + points[ch.q][0]) / 2 - fit.c[0], (points[ch.p][1] + points[ch.q][1]) / 2 - fit.c[1]];
            const chord = Math.hypot(points[ch.p][0] - points[ch.q][0], points[ch.p][1] - points[ch.q][1]);
            const t = Math.abs(turns[k]);
            for (const r of ch.regions) {
              const g = regions.get(r)!;
              outward += Math.sign(dot(g.n, add(scale(u, mid[0]), scale(v, mid[1])))) * g.area;
              sliver += ((fit.r * fit.r) / 2) * (t - Math.sin(t)) * (g.area / chord);
              let a0 = Infinity;
              let a1 = -Infinity;
              for (const tri of g.tris) {
                for (let j = 0; j < 3; j++) {
                  const h = dot(pts[corner[tri * 3 + j]], axis);
                  a0 = Math.min(a0, h);
                  a1 = Math.max(a1, h);
                }
              }
              ends.push([a0, a1]);
              tLo = Math.min(tLo, a0);
              tHi = Math.max(tHi, a1);
            }
          });
          const total = regs.reduce((s, r) => s + regions.get(r)!.area, 0);
          // (All its strips facing one way: a hole's wall, or a boss's.)
          if (Math.abs(outward) < total * 0.999) {
            return;
          }
          for (const [a0, a1] of ends) {
            if (a0 - tLo > size * 1e-5 || tHi - a1 > size * 1e-5) {
              even = false;
            }
          }
          if (!(tHi - tLo > size * 1e-5)) {
            return;
          }
          const base = dot(c3, axis);
          const c = sub(c3, scale(axis, base));
          for (const r of regs) {
            used.add(r);
          }
          out.push({
            c: c.map(x => tidy(x)) as Vec3,
            a: axis,
            r: tidy(fit.r),
            t0: tLo,
            t1: tHi,
            u: norm(add(scale(u, Math.cos(start2)), scale(v, Math.sin(start2)))),
            sweep,
            concave: outward < 0,
            step: Math.max(...turns.map(Math.abs)),
            strips: chordsHere.length,
            even,
            sliver,
            regions: regs
          });
        };
        if (ring && n >= 12 && fits(0, n)) {
          take(0, n, true);
          continue;
        }
        // Part of the way round: at least three strips on one circle. (Round a ring: begun where one run ends.)
        let from = 0;
        let count2 = n;
        if (ring) {
          // (Begun at a strip much longer than the next: a flat side between two rounds.)
          from = -1;
          for (let i = 0; i < n && from < 0; i++) {
            if (chordLen(i - 1) > chordLen(i) * 3 || !fits(i - 2, 4)) {
              from = i;
            }
          }
          if (from < 0) {
            continue;
          }
          count2 = n + 1;
        }
        for (let i = 0; i + 3 < count2; ) {
          // Strips of much the same width, their creases on one circle: as far as that goes on.
          let j = i + 1;
          const w = chordLen(from + i);
          while (j + 1 < count2 && chordLen(from + j) < w * 3 && chordLen(from + j) > w / 3 && fits(from + i, j - i + 2)) {
            j++;
          }
          if (j - i + 1 >= 4) {
            take(from + i, j - i + 1, false);
            i = j;
          } else {
            i++;
          }
        }
      }
    }
  }

  return out;
}

/** A number a file's seven digits left a hair off a round one: the round one. */
function tidy(x: number): number {
  const r = Math.round(x * 1e4) / 1e4;

  return Math.abs(x - r) < 2e-5 * Math.max(1, Math.abs(x)) ? r : x;
}

/** A direction a hair off X, Y or Z: that one exactly. */
function snapDir(d: Vec3): Vec3 {
  for (let k = 0; k < 3; k++) {
    if (Math.abs(Math.abs(d[k]) - 1) < 1e-9) {
      const e: Vec3 = [0, 0, 0];
      e[k] = Math.sign(d[k]);

      return e;
    }
  }

  return d;
}

/** The circle nearest a set of points (three or more, not in a line). */
function fitCircle(p: [number, number][]): { c: [number, number]; r: number } | null {
  const n = p.length;
  if (n < 3) {
    return null;
  }
  let mx = 0;
  let my = 0;
  for (const [x, y] of p) {
    (mx += x / n), (my += y / n);
  }
  let suu = 0, suv = 0, svv = 0, suuu = 0, svvv = 0, suvv = 0, svuu = 0;
  for (const [x, y] of p) {
    const a = x - mx;
    const b = y - my;
    suu += a * a;
    suv += a * b;
    svv += b * b;
    suuu += a * a * a;
    svvv += b * b * b;
    suvv += a * b * b;
    svuu += b * a * a;
  }
  const det = suu * svv - suv * suv;
  if (Math.abs(det) < 1e-12 * Math.max(1, suu * svv)) {
    return null;
  }
  const e = (suuu + suvv) / 2;
  const f = (svvv + svuu) / 2;
  const cx = (e * svv - f * suv) / det;
  const cy = (f * suu - e * suv) / det;
  const r = Math.sqrt(cx * cx + cy * cy + (suu + svv) / n);

  return Number.isFinite(r) && r > 0 ? { c: [cx + mx, cy + my], r } : null;
}

// ------------------------------------------------------------ flat faces

/** A flat face of a mesh: which way it faces, its outline, and the outlines of the holes in it (each a ring of corners). */
export interface MeshFace {
  n: Vec3;
  outer: Vec3[];
  holes: Vec3[][];
}

/**
 * A mesh's flat faces, each whole: the triangles that lie in one plane as one face, with its outline and holes.
 *
 * The kernel merges flat neighbours itself only where a file's seven digits happen to leave them exactly in one
 * plane - faces square to X, Y or Z. A part that leans, or a chamfer, came in as loose triangles. Here each flat
 * region is given the plane nearest its triangles, and every corner is moved (by less than those seven digits are
 * off) onto the planes of all the regions that meet at it, so that the faces built from them are exactly flat and
 * exactly meet.
 *
 * Null when this cannot be done faithfully (an edge with more or fewer than two triangles: an open or tangled mesh;
 * an outline that crosses itself) - the mesh then comes in the old way.
 */
export function meshFlatFaces(tris: Float64Array): MeshFace[] | null {
  const mesh = readMesh(tris);
  const flat = mesh && flatOf(mesh);

  return flat ? facesOf(flat) : null;
}

/** A mesh's flat faces by corner: where each corner is put, and each face's rings of corners (its outline first). */
interface Flat {
  at: Vec3[];
  /** The regions round each corner of the mesh. */
  round: Set<number>[];
  plane: Map<number, { n: Vec3; d: number }>;
  faces: Map<number, { n: Vec3; outer: number[]; holes: number[][] }>;
  /** Faces put in since (the stand-ins of round parts). */
  more: { n: Vec3; outer: number[] }[];
}

const facesOf = (flat: Flat): MeshFace[] => [
  ...[...flat.faces.values()].map(f => ({ n: f.n, outer: f.outer.map(i => flat.at[i]), holes: f.holes.map(h => h.map(i => flat.at[i])) })),
  ...flat.more.map(f => ({ n: f.n, outer: f.outer.map(i => flat.at[i]), holes: [] }))
];

function flatOf(mesh: Mesh): Flat | null {
  const { size, pts, corner, area, onEdge, regions, find } = mesh;
  const np = pts.length;
  for (const list of onEdge.values()) {
    if (list.length !== 2) {
      return null;
    }
  }
  // Each region's plane: facing its triangles' way, through their middle.
  const plane = new Map<number, { n: Vec3; d: number }>();
  for (const [id, g] of regions) {
    let d = 0;
    for (const t of g.tris) {
      for (let k = 0; k < 3; k++) {
        d += (dot(g.n, pts[corner[t * 3 + k]]) * area[t]) / 3;
      }
    }
    plane.set(id, { n: g.n, d: d / g.area });
  }
  // The regions round each corner; the corner onto all their planes (each in turn, a few times round: they agree
  // to within what the file's digits are off, so this settles at once).
  const round: Set<number>[] = pts.map(() => new Set<number>());
  for (let t = 0; t < corner.length / 3; t++) {
    if (!(area[t] > 0)) {
      continue;
    }
    const r = find(t);
    for (let k = 0; k < 3; k++) {
      round[corner[t * 3 + k]].add(r);
    }
  }
  const at: Vec3[] = pts.map((p, i) => {
    let x = p;
    const planes = [...round[i]].map(r => plane.get(r)!);
    for (let pass = 0; pass < (planes.length > 1 ? 12 : 1); pass++) {
      for (const pl of planes) {
        x = sub(x, scale(pl.n, dot(pl.n, x) - pl.d));
      }
    }

    return x;
  });
  // (A corner that had to move further than a file's digits can be off: not a mesh this reads.)
  const most = size * 2e-5;
  for (let i = 0; i < pts.length; i++) {
    if (round[i].size && len(sub(at[i], pts[i])) > most) {
      return null;
    }
  }
  // Each region's outline: the edges with another region across them, each the way its triangle goes round.
  const next = new Map<number, Map<number, number[]>>();
  for (let t = 0; t < corner.length / 3; t++) {
    if (!(area[t] > 0)) {
      continue;
    }
    const r = find(t);
    for (let k = 0; k < 3; k++) {
      const a = corner[t * 3 + k];
      const b = corner[t * 3 + ((k + 1) % 3)];
      const pair = onEdge.get(Math.min(a, b) * np + Math.max(a, b));
      if (!pair) {
        continue;
      }
      const other = pair[0] === t ? pair[1] : pair[0];
      if (area[other] > 0 && find(other) === r) {
        continue;
      }
      let m = next.get(r);
      if (!m) {
        next.set(r, (m = new Map()));
      }
      const list = m.get(a);
      if (list) {
        list.push(b);
      } else {
        m.set(a, [b]);
      }
    }
  }
  const faces: Flat['faces'] = new Map();
  for (const [id, g] of regions) {
    const m = next.get(id);
    if (!m) {
      return null;
    }
    const u = norm(xDirFor(g.n));
    const v = norm(cross(g.n, u));
    const loops: { ring: number[]; area: number }[] = [];
    for (const start of [...m.keys()]) {
      while (m.get(start)?.length) {
        const ring = [start];
        let cur = start;
        for (let guard = 0; guard < corner.length + 2; guard++) {
          const list = m.get(cur);
          if (!list?.length) {
            return null;
          }
          // (Two ways on from one corner - the outline touches itself there: the one that turns most to the left of
          // the way it came, which keeps each ring simple.)
          let pick = 0;
          if (list.length > 1 && ring.length > 1) {
            const from = sub(at[cur], at[ring[ring.length - 2]]);
            let best = -Infinity;
            list.forEach((b, k) => {
              const to = sub(at[b], at[cur]);
              const turn = Math.atan2(dot(cross(from, to), g.n), dot(from, to));
              if (turn > best) {
                (best = turn), (pick = k);
              }
            });
          }
          const b = list.splice(pick, 1)[0];
          if (b === start) {
            break;
          }
          ring.push(b);
          cur = b;
          if (guard === corner.length + 1) {
            return null;
          }
        }
        if (ring.length < 3) {
          return null;
        }
        let a2 = 0;
        for (let i = 0; i < ring.length; i++) {
          const p = at[ring[i]];
          const q2 = at[ring[(i + 1) % ring.length]];
          a2 += dot(p, u) * dot(q2, v) - dot(q2, u) * dot(p, v);
        }
        loops.push({ ring, area: a2 / 2 });
      }
    }
    // One outline goes round the face's own way (the biggest); the rest, the other way, are holes.
    const outers = loops.filter(l => l.area > 0);
    if (outers.length !== 1) {
      return null;
    }
    faces.set(id, { n: g.n, outer: outers[0].ring, holes: loops.filter(l => l.area < 0).map(l => l.ring) });
  }

  return { at, round, plane, faces, more: [] };
}

// ------------------------------------------------------------ round parts stood in for

/** A round part of a mesh whose strips were taken out for a few flat faces a little inside it, to be made round by one ring. */
export interface MeshStandIn {
  cy: MeshCylinder;
  /** The ring that makes it round: from this radius out to the cylinder's own, between these heights along its axis. */
  inner: number;
  ends: [number, number];
  /** The volume between the stand-in and the true round face (what the ring takes from a hole, or adds to a boss). */
  volume: number;
}

/** A mesh as flat faces, its round parts found. */
export interface MeshModel {
  faces: MeshFace[];
  /** Round parts stood in for: one ring each makes them round. */
  rounds: MeshStandIn[];
  /** Round parts found whose strips are still among the faces (they end on something that is not one flat face). */
  rest: MeshCylinder[];
}

/**
 * A mesh as flat faces with its round parts found - and, where a round part ends on one flat face at each end (a
 * hole through a plate, a boss, a pin, a rounded upright corner), its hundreds of strips taken out for a few flat
 * faces a little inside the cylinder. The body built from that is small (a plate with 60 holes: fifteen thousand
 * faces as strips, fourteen hundred this way), and each round part is then one ring away from truly round - with
 * room between the stand-in and the round face, which the kernel needs: the strips themselves lie a hair from it.
 */
export function meshModel(tris: Float64Array): MeshModel | null {
  const mesh = readMesh(tris);
  const flat = mesh && flatOf(mesh);
  if (!mesh || !flat) {
    return null;
  }
  const cyls = cylindersOf(mesh);
  const rounds: MeshStandIn[] = [];
  const rest: MeshCylinder[] = [];
  /** Faces a round part ends on: not themselves taken out as another's strips. */
  const pinned = new Set<number>();
  for (const cy of cyls) {
    const made = cy.even && !cy.regions!.some(r => pinned.has(r) || !flat.faces.has(r)) ? standIn(mesh, flat, cy, pinned) : null;
    if (made) {
      rounds.push(made);
    } else {
      rest.push(cy);
    }
  }

  // (A round part left as strips that another's stand-in took an end of: its strips are not all there now.)
  return { faces: facesOf(flat), rounds, rest: rest.filter(cy => cy.regions!.every(r => flat.faces.has(r))) };
}

function standIn(mesh: Mesh, flat: Flat, cy: MeshCylinder, pinned: Set<number>): MeshStandIn | null {
  const { size, corner, regions } = mesh;
  const { at } = flat;
  const mine = new Set(cy.regions!);
  const full = cy.sweep > 2 * Math.PI - 1e-9;
  const v = norm(cross(cy.a, cy.u));
  const tOf = (p: Vec3) => dot(sub(p, cy.c), cy.a);
  const angOf = (p: Vec3) => {
    const d = sub(p, cy.c);
    const ang = Math.atan2(dot(d, v), dot(d, cy.u));

    return ang < -1e-6 ? ang + 2 * Math.PI : ang;
  };
  // Its corners: all at one end or the other.
  const ends: [Set<number>, Set<number>] = [new Set(), new Set()];
  const tolT = size * 1e-5;
  for (const r of mine) {
    for (const t of regions.get(r)!.tris) {
      for (let k = 0; k < 3; k++) {
        const id = corner[t * 3 + k];
        const h = tOf(at[id]);
        if (Math.abs(h - cy.t0) < tolT) {
          ends[0].add(id);
        } else if (Math.abs(h - cy.t1) < tolT) {
          ends[1].add(id);
        } else {
          return null;
        }
      }
    }
  }
  // How coarse the stand-in may be: its flats no further inside the round face than a little.
  const room = Math.max(size * 2e-4, 0.005);
  const deep = Math.max(0.02, cy.r * 0.004);
  if (!(cy.r > room * 4 + deep * 4)) {
    return null;
  }
  const halfStep = Math.acos(1 - deep / cy.r);
  const count = Math.max(full ? 8 : 2, Math.min(cy.strips, Math.ceil(cy.sweep / (2 * halfStep))));
  const step = cy.sweep / count;
  const rho = cy.r - room;
  // Each end: the one flat face it ends on, square to the axis, and that face's ring of corners that runs along it.
  const plan: { face: number; ring: number[]; from: number; ids: number[] }[] = [];
  const fresh: Vec3[] = [];
  for (const e of [0, 1]) {
    const set = ends[e];
    // (Going round: the corners between the first and last crease are met by this face only, besides the strips.)
    let face = -1;
    for (const id of set) {
      const ang = angOf(at[id]);
      const inner = full || (ang > step * 1e-3 && ang < cy.sweep - step * 1e-3);
      if (!inner) {
        continue;
      }
      const others = [...flat.round[id]].filter(r => !mine.has(r));
      if (others.length !== 1 || (face >= 0 && others[0] !== face)) {
        return null;
      }
      face = others[0];
    }
    const f = flat.faces.get(face);
    if (!f || Math.abs(Math.abs(dot(f.n, cy.a)) - 1) > 1e-9) {
      return null;
    }
    const ring = [f.outer, ...f.holes].find(ring2 => ring2.some(id => set.has(id)));
    if (!ring) {
      return null;
    }
    const n = ring.length;
    const on = ring.map(id => set.has(id));
    const have = on.filter(Boolean).length;
    if (have !== set.size) {
      return null;
    }
    let from = 0;
    if (full) {
      if (have !== n) {
        return null;
      }
    } else {
      // The run of its corners in the ring: one run, begun after a corner that is not its own.
      if (have === n) {
        return null;
      }
      from = on.findIndex((x, i) => x && !on[(i - 1 + n) % n]);
      for (let k = 0; k < n; k++) {
        if (on[(from + k) % n] !== k < have) {
          return null;
        }
      }
    }
    // The stand-in's corners at this end, by angle: the first and last of a part-round its own creases.
    const pl = flat.plane.get(face)!;
    const h = (pl.d - dot(pl.n, cy.c)) / dot(pl.n, cy.a);
    const ids: number[] = [];
    for (let j = 0; j <= (full ? count - 1 : count); j++) {
      const ang = j * step;
      if (!full && (j === 0 || j === count)) {
        const want = j === 0 ? 0 : cy.sweep;
        const own = [...set].find(id => Math.abs(angOf(at[id]) - want) < step * 1e-3);
        if (own === undefined) {
          return null;
        }
        ids.push(own);
        continue;
      }
      ids.push(at.length + fresh.length);
      fresh.push(add(add(cy.c, scale(cy.a, h)), add(scale(cy.u, rho * Math.cos(ang)), scale(v, rho * Math.sin(ang)))));
    }
    plan.push({ face, ring, from, ids });
  }
  // Both ends can be done: the new corners in, the rings rewritten, the strips out, the stand-in's flats in (two
  // triangles each: flat whatever a file's digits did to the creases a part-round begins and ends at).
  at.push(...fresh);
  plan.forEach((p, e) => {
    const set = ends[e];
    const ring = p.ring;
    const n = ring.length;
    if (full) {
      // (Round the way the ring went.)
      let turn = 0;
      for (let i = 0; i < n; i++) {
        let d = angOf(at[ring[(i + 1) % n]]) - angOf(at[ring[i]]);
        if (d > Math.PI) {
          d -= 2 * Math.PI;
        }
        if (d < -Math.PI) {
          d += 2 * Math.PI;
        }
        turn += d;
      }
      ring.splice(0, n, ...(turn > 0 ? p.ids : [...p.ids].reverse()));
    } else {
      const first = at[ring[p.from]];
      const forward = Math.abs(angOf(first)) < Math.abs(angOf(first) - cy.sweep);
      const kept = Array.from({ length: n - set.size }, (_, k) => ring[(p.from + set.size + k) % n]);
      ring.splice(0, n, ...(forward ? p.ids : [...p.ids].reverse()), ...kept);
    }
    pinned.add(p.face);
  });
  for (const r of mine) {
    flat.faces.delete(r);
  }
  const [low, high] = [plan[0].ids, plan[1].ids];
  for (let j = 0; j < count; j++) {
    const j2 = full ? (j + 1) % count : j + 1;
    const mid = (j + 0.5) * step;
    const out = scale(add(scale(cy.u, Math.cos(mid)), scale(v, Math.sin(mid))), cy.concave ? -1 : 1);
    for (const tri of [[low[j], low[j2], high[j2]], [low[j], high[j2], high[j]]]) {
      const n = cross(sub(at[tri[1]], at[tri[0]]), sub(at[tri[2]], at[tri[0]]));
      const facing = dot(n, out) > 0;
      flat.more.push({ n: norm(facing ? n : scale(n, -1)), outer: facing ? tri : [tri[0], tri[2], tri[1]] });
    }
  }
  // What lies between the stand-in and the round face.
  let inside = 0;
  for (let j = 0; j < count; j++) {
    const r0 = !full && j === 0 ? cy.r : rho;
    const r1 = !full && j === count - 1 ? cy.r : rho;
    inside += 0.5 * r0 * r1 * Math.sin(step);
  }
  const h0 = tOf(at[low[1]]);
  const h1 = tOf(at[high[1]]);

  return {
    cy,
    inner: rho * Math.cos(step) - room,
    ends: [Math.min(h0, h1), Math.max(h0, h1)],
    volume: ((cy.r * cy.r * cy.sweep) / 2 - inside) * Math.abs(h1 - h0)
  };
}
