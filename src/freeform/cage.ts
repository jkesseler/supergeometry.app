// Freeform control cages and Catmull–Clark subdivision (pure math, no OCCT).
//
// A cage is a quad mesh. The smooth shape is its subdivision surface; after a
// few levels every cage quad has become an n×n grid of points ("patch") that
// the kernel interpolates with one B-spline surface. Neighbouring patches share
// their boundary points exactly, so the surfaces sew into a clean shell/solid.

import type { Vec3 } from '../doc/types';

export interface Cage {
  verts: Vec3[];
  /** Quads, as vertex indices in order around the face. */
  faces: [number, number, number, number][];
  /**
   * Sharp edges: cage edges the surface keeps a crease along instead of
   * rounding over - it follows them as an open border is followed (a smooth
   * curve through the edge's points), and where three or more meet, or one
   * ends at a corner of the border, the point is a corner. One on its own,
   * ending in the middle of the surface, fades out there.
   */
  creases?: [number, number][];
}

export type CagePrimitive = 'box' | 'plane' | 'cylinder' | 'sphere' | 'torus';

// ------------------------------------------------------------- primitives

/** Box of w×d×h centred on the XY plane at `at` (bottom on z = at.z), `divisions` faces per side. */
export function boxCage(size: Vec3 = [40, 40, 40], divisions = 2, at: Vec3 = [0, 0, 0]): Cage {
  const pts = new Map<string, number>();
  const verts: Vec3[] = [];
  const faces: Cage['faces'] = [];
  const vid = (point: Vec3) => {
    const key = point.map(x => Math.round(x * 1e6)).join(',');
    let i = pts.get(key);
    if (i === undefined) {
      i = verts.push(point) - 1;
      pts.set(key, i);
    }

    return i;
  };
  // Unit cube [-1, 1]³; each side is a `divisions`×`divisions` grid, wound so normals point out.
  const sides: { o: Vec3; u: Vec3; v: Vec3 }[] = [
    { o: [-1, -1, 1], u: [2, 0, 0], v: [0, 2, 0] }, // top
    { o: [-1, 1, -1], u: [2, 0, 0], v: [0, -2, 0] }, // bottom
    { o: [-1, -1, -1], u: [2, 0, 0], v: [0, 0, 2] }, // front (−y)
    { o: [1, 1, -1], u: [-2, 0, 0], v: [0, 0, 2] }, // back (+y)
    { o: [1, -1, -1], u: [0, 2, 0], v: [0, 0, 2] }, // right (+x)
    { o: [-1, 1, -1], u: [0, -2, 0], v: [0, 0, 2] } // left (−x)
  ];
  const place = (q: Vec3): Vec3 => [at[0] + (q[0] * size[0]) / 2, at[1] + (q[1] * size[1]) / 2, at[2] + ((q[2] + 1) * size[2]) / 2];
  for (const { o, u, v } of sides) {
    const gridPoint = (i: number, j: number): Vec3 => [o[0] + (u[0] * i + v[0] * j) / divisions, o[1] + (u[1] * i + v[1] * j) / divisions, o[2] + (u[2] * i + v[2] * j) / divisions];
    for (let i = 0; i < divisions; i++) {
      for (let j = 0; j < divisions; j++) {
        faces.push([vid(gridPoint(i, j)), vid(gridPoint(i + 1, j)), vid(gridPoint(i + 1, j + 1)), vid(gridPoint(i, j + 1))]);
      }
    }
  }

  // Positions are placed after de-duplication (keys use the unit cube).
  return { verts: verts.map(place), faces };
}

/** Sphere of `diameter`: a box cage pushed onto a sphere. */
export function sphereCage(diameter = 40, at: Vec3 = [0, 0, 0]): Cage {
  const cage = boxCage([2, 2, 2], 2, [0, 0, -1]);
  // A cage a little bigger than the sphere: subdivision shrinks it.
  const radius = (diameter / 2) * 1.22;

  return { faces: cage.faces, verts: cage.verts.map((vertex) => {
    const length = Math.hypot(...vertex) || 1;

    return [at[0] + (vertex[0] / length) * radius, at[1] + (vertex[1] / length) * radius, at[2] + diameter / 2 + (vertex[2] / length) * radius];
  }) };
}

/** Flat `divisions`×`divisions` sheet of w×d on the XY plane at `at` (an open surface). */
export function planeCage(size: [number, number] = [40, 40], divisions = 4, at: Vec3 = [0, 0, 0]): Cage {
  const verts: Vec3[] = [];
  for (let j = 0; j <= divisions; j++) {
    for (let i = 0; i <= divisions; i++) {
      verts.push([at[0] + (i / divisions - 0.5) * size[0], at[1] + (j / divisions - 0.5) * size[1], at[2]]);
    }
  }
  const id = (i: number, j: number) => j * (divisions + 1) + i;
  const faces: Cage['faces'] = [];
  for (let j = 0; j < divisions; j++) {
    for (let i = 0; i < divisions; i++) {
      faces.push([id(i, j), id(i + 1, j), id(i + 1, j + 1), id(i, j + 1)]);
    }
  }

  return { verts, faces };
}

/** Cylinder of `diameter` and `height` standing on `at`: 8 around, `rows` up, quad caps. */
export function cylinderCage(diameter = 40, height = 40, rows = 2, at: Vec3 = [0, 0, 0]): Cage {
  const sides = 8;
  const radius = (diameter / 2) * 1.08;
  const verts: Vec3[] = [];
  const ring = (row: number) => row * sides;
  for (let row = 0; row <= rows; row++) {
    for (let i = 0; i < sides; i++) {
      const a = (i / sides) * Math.PI * 2;
      verts.push([at[0] + Math.cos(a) * radius, at[1] + Math.sin(a) * radius, at[2] + (row / rows) * height]);
    }
  }
  const faces: Cage['faces'] = [];
  for (let row = 0; row < rows; row++) {
    for (let i = 0; i < sides; i++) {
      const a = ring(row) + i;
      const b = ring(row) + ((i + 1) % sides);
      faces.push([a, b, b + sides, a + sides]);
    }
  }
  // Caps: a 2×2 grid of quads each, closing the bottom and top rings.
  capGrid(verts, faces, ring(0), sides, at[2], false, at);
  capGrid(verts, faces, ring(rows), sides, at[2] + height, true, at);

  return { verts, faces };
}

/**
 * A ring (a torus) lying on `at`: `d` across the outside, `t` thick (its
 * tube), 8 faces round the ring and 2·rows round the tube (4 at least).
 * Every point has four faces round it, so it comes out smooth all over.
 */
export function torusCage(diameter = 40, t = 12, rows = 2, at: Vec3 = [0, 0, 0]): Cage {
  const sides = 8;
  const tubeSides = Math.max(4, 2 * Math.round(rows));
  const majorRadius = Math.max(0.01, (diameter - t) / 2);
  // A cage a little bigger round the tube than the tube: subdivision shrinks it.
  const minorRadius = (t / 2) * (tubeSides <= 4 ? 1.3 : 1.12);
  const verts: Vec3[] = [];
  for (let i = 0; i < sides; i++) {
    for (let j = 0; j < tubeSides; j++) {
      const a = (i / sides) * Math.PI * 2;
      const b = (j / tubeSides) * Math.PI * 2;
      const ringRadius = majorRadius + Math.cos(b) * minorRadius;
      verts.push([at[0] + Math.cos(a) * ringRadius, at[1] + Math.sin(a) * ringRadius, at[2] + t / 2 + Math.sin(b) * minorRadius]);
    }
  }
  const id = (i: number, j: number) => (i % sides) * tubeSides + (j % tubeSides);
  const faces: Cage['faces'] = [];
  // (Wound so the normals point out of the tube.)
  for (let i = 0; i < sides; i++) {
    for (let j = 0; j < tubeSides; j++) {
      faces.push([id(i, j), id(i + 1, j), id(i + 1, j + 1), id(i, j + 1)]);
    }
  }

  return { verts, faces };
}

/**
 * Close an 8-point rim with a 2×2 grid of quads: its corners are rim points
 * 1, 3, 5, 7, its edge midpoints rim 0, 2, 4, 6, and a new centre point.
 */
function capGrid(verts: Vec3[], faces: Cage['faces'], radius: number, sides: number, z: number, up: boolean, at: Vec3): void {
  const centerIndex = verts.push([at[0], at[1], z]) - 1;
  // 2×2 grid: corner points = rim 1, 3, 5, 7; edge mid points = rim 0, 2, 4, 6; centre = centerIndex.
  for (let q = 0; q < 4; q++) {
    const mid0 = radius + ((2 * q) % sides);
    const corner = radius + ((2 * q + 1) % sides);
    const mid1 = radius + ((2 * q + 2) % sides);
    const quad: [number, number, number, number] = [centerIndex, mid0, corner, mid1];
    faces.push(up ? quad : [quad[0], quad[3], quad[2], quad[1]]);
  }
}

/**
 * A new shape at a size: width × depth × height (a cylinder's or sphere's
 * width is its diameter), `rows` faces up the side. A cylinder is turned so a
 * face looks straight to the front, back and sides (a spout or a handle starts
 * from one; its corners used to point there, and it took a 22.5° turn first).
 */
export function shapeCage(kind: Exclude<CagePrimitive, 'plane'>, size: Vec3, rows = 2): Cage {
  const rowCount = Math.max(1, Math.round(rows));
  if (kind === 'box') {
    return boxCage(size, rowCount);
  }
  if (kind === 'torus') {
    return torusCage(size[0], size[2], rowCount);
  }
  if (kind === 'sphere') {
    const cage = sphereCage(size[0]);

    return { faces: cage.faces, verts: cage.verts.map(vertex => [vertex[0], (vertex[1] * size[1]) / size[0], (vertex[2] * size[2]) / size[0]] as Vec3) };
  }
  const cylinder = cylinderCage(size[0], size[2], rowCount);
  const t = -Math.PI / 8;
  const sy = size[1] / size[0];

  return { faces: cylinder.faces, verts: cylinder.verts.map(([x, y, z]) => [x * Math.cos(t) - y * Math.sin(t), (x * Math.sin(t) + y * Math.cos(t)) * sy, z] as Vec3) };
}

export function primitiveCage(kind: CagePrimitive, at: Vec3 = [0, 0, 0]): Cage {
  switch (kind) {
    case 'box':
      return boxCage([40, 40, 40], 2, at);
    case 'plane':
      return planeCage([60, 60], 4, at);
    case 'cylinder':
      return cylinderCage(40, 40, 2, at);
    case 'sphere':
      return sphereCage(40, at);
    case 'torus':
      return torusCage(40, 12, 2, at);
  }
}

// ------------------------------------------------------------ subdivision

/** The subdivided surface: points, and per cage face the (n+1)×(n+1) grid of point indices. */
export interface Subdivided {
  points: Vec3[];
  /** grids[f][i][j]: point index; i runs from the face's corner 0 towards 1, j towards 3. */
  grids: number[][][];
  /** Size of each grid side in cells (2^levels). */
  n: number;
  /** The sharp edges at this level (as "a,b" with a < b), where the cage has some. */
  creased?: Set<string>;
}

const add3 = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul3 = (a: Vec3, factor: number): Vec3 => [a[0] * factor, a[1] * factor, a[2] * factor];

/**
 * Catmull–Clark, `levels` times. Boundary edges (open sheets) stay sharp
 * B-spline curves. `sharp`: border points the border passes through as a
 * corner (a sheet laid over a face: the face's own corners).
 */
export function subdivide(cage: Cage, levels = 3, sharp?: Set<number>): Subdivided {
  // Sharp edges, as they are at each level (each is two at the next).
  let creased = new Set((cage.creases ?? []).map(([a, b]) => (a < b ? `${a},${b}` : `${b},${a}`)));
  let points = cage.verts.map(vertex => [...vertex] as Vec3);
  let grids = cage.faces.map(face => [
    [face[0], face[3]],
    [face[1], face[2]]
  ]);
  let count = 1;
  for (let lvl = 0; lvl < levels; lvl++) {
    // Every current cell (quad) and the edges between grid points.
    const quads: number[][] = [];
    for (const grid of grids) {
      for (let i = 0; i < count; i++) {
        for (let j = 0; j < count; j++) {
          quads.push([grid[i][j], grid[i + 1][j], grid[i + 1][j + 1], grid[i][j + 1]]);
        }
      }
    }
    const ekey = (a: number, b: number) => (a < b ? `${a},${b}` : `${b},${a}`);
    const edgeFaces = new Map<string, number[]>();
    quads.forEach((q, qi) => {
      for (let corner = 0; corner < 4; corner++) {
        const key = ekey(q[corner], q[(corner + 1) % 4]);
        const list = edgeFaces.get(key);
        if (list) {
          list.push(qi);
        } else {
          edgeFaces.set(key, [qi]);
        }
      }
    });
    const facePt = quads.map(q => mul3(q.reduce((sum, i) => add3(sum, points[i]), [0, 0, 0] as Vec3), 0.25));
    // New point list: old vertices (moved), then edge points, then face points.
    const next: Vec3[] = [];
    const edgeIdx = new Map<string, number>();
    const faceIdx: number[] = [];
    // Edge points.
    const edgePos = new Map<string, Vec3>();
    for (const [key, fs] of edgeFaces) {
      const [a, b] = key.split(',').map(Number);
      const mid = mul3(add3(points[a], points[b]), 0.5);
      edgePos.set(key, fs.length === 2 && !creased.has(key) ? mul3(add3(add3(points[a], points[b]), add3(facePt[fs[0]], facePt[fs[1]])), 0.25) : mid);
    }
    // Vertex points.
    const vFaces = new Map<number, number[]>();
    const vEdges = new Map<number, string[]>();
    quads.forEach((q, qi) => q.forEach(vertex => vFaces.set(vertex, [...(vFaces.get(vertex) ?? []), qi])));
    for (const key of edgeFaces.keys()) {
      for (const vertex of key.split(',').map(Number)) {
        vEdges.set(vertex, [...(vEdges.get(vertex) ?? []), key]);
      }
    }
    const moved = points.map((point, pointIndex) => {
      const es = vEdges.get(pointIndex);
      const fs = vFaces.get(pointIndex);
      if (!es || !fs) {
        return point;
      }
      const border = es.filter(edgeKey => edgeFaces.get(edgeKey)!.length === 1);
      const crease = creased.size ? es.filter(edgeKey => creased.has(edgeKey) && edgeFaces.get(edgeKey)!.length === 2) : [];
      // (A sharp edge is followed as the border is. Three or more at a point, sharp or border: a corner.)
      if (crease.length && border.length + crease.length > 2) {
        return point;
      }
      const boundary = crease.length ? [...border, ...crease] : border;
      if (boundary.length >= 2) {
        // Boundary: a cubic B-spline along the border; a corner (two faces meet at an angle) stays put.
        // (Told which points are corners: only those - a sheet's own corner on a round edge isn't one.)
        if (!crease.length && (sharp ? sharp.has(pointIndex) : fs.length === 1)) {
          return point;
        }
        const others = boundary.slice(0, 2).map((edgeKey) => {
          const [a, b] = edgeKey.split(',').map(Number);

          return points[a === pointIndex ? b : a];
        });

        return add3(mul3(point, 0.75), mul3(add3(others[0], others[1]), 0.125));
      }
      const edgeCount = es.length;
      const faceAverage = mul3(fs.reduce((sum, face) => add3(sum, facePt[face]), [0, 0, 0] as Vec3), 1 / fs.length);
      const edgeAverage = mul3(es.reduce((sum, edgeKey) => {
        const [a, b] = edgeKey.split(',').map(Number);

        return add3(sum, mul3(add3(points[a], points[b]), 0.5));
      }, [0, 0, 0] as Vec3), 1 / edgeCount);

      return mul3(add3(add3(faceAverage, mul3(edgeAverage, 2)), mul3(point, edgeCount - 3)), 1 / edgeCount);
    });
    next.push(...moved);
    for (const [key, pos] of edgePos) {
      edgeIdx.set(key, next.push(pos) - 1);
    }
    for (const fp of facePt) {
      faceIdx.push(next.push(fp) - 1);
    }
    // New grids, twice as fine.
    let qi = 0;
    const gridSize = 2 * count;
    grids = grids.map((grid) => {
      const ng: number[][] = Array.from({ length: gridSize + 1 }, () => new Array<number>(gridSize + 1));
      for (let i = 0; i <= count; i++) {
        for (let j = 0; j <= count; j++) {
          ng[2 * i][2 * j] = grid[i][j];
        }
      }
      for (let i = 0; i <= count; i++) {
        for (let j = 0; j < count; j++) {
          ng[2 * i][2 * j + 1] = edgeIdx.get(ekey(grid[i][j], grid[i][j + 1]))!;
        }
      }
      for (let i = 0; i < count; i++) {
        for (let j = 0; j <= count; j++) {
          ng[2 * i + 1][2 * j] = edgeIdx.get(ekey(grid[i][j], grid[i + 1][j]))!;
        }
      }
      for (let i = 0; i < count; i++) {
        for (let j = 0; j < count; j++) {
          ng[2 * i + 1][2 * j + 1] = faceIdx[qi++];
        }
      }

      return ng;
    });
    if (creased.size) {
      const halves = new Set<string>();
      for (const key of creased) {
        const edgeIndex = edgeIdx.get(key);
        if (edgeIndex === undefined) {
          continue;
        }
        const [a, b] = key.split(',').map(Number);
        halves.add(ekey(a, edgeIndex)).add(ekey(edgeIndex, b));
      }
      creased = halves;
    }
    points = next;
    count = gridSize;
  }

  return { points, grids, n: count, ...(creased.size ? { creased } : {}) };
}

/**
 * Each subdivided point moved onto the smooth (limit) surface itself: the
 * surface the patches are fitted through. Fitting through these instead of
 * the control points keeps neighbouring patches meeting smoothly (no faint
 * creases along their borders) and puts the surface where the shape really is.
 *
 * Inside: (n²·p + 4·Σ edge neighbours + Σ diagonal neighbours) / (n(n+5)).
 * Along an open border: (prev + 4·p + next) / 6. Corners of a sheet stay.
 */
export function limitPoints(subdivided: Subdivided, sharp?: Set<number>): Vec3[] {
  const points = subdivided.points;
  const quads: number[][] = [];
  for (const grid of subdivided.grids) {
    for (let i = 0; i < subdivided.n; i++) {
      for (let j = 0; j < subdivided.n; j++) {
        quads.push([grid[i][j], grid[i + 1][j], grid[i + 1][j + 1], grid[i][j + 1]]);
      }
    }
  }
  const ekey = (a: number, b: number) => (a < b ? `${a},${b}` : `${b},${a}`);
  const edgeCount = new Map<string, number>();
  for (const q of quads) {
    for (let corner = 0; corner < 4; corner++) {
      edgeCount.set(ekey(q[corner], q[(corner + 1) % 4]), (edgeCount.get(ekey(q[corner], q[(corner + 1) % 4])) ?? 0) + 1);
    }
  }
  const nbE = points.map(() => new Set<number>());
  const nbF = points.map(() => [] as number[]);
  const border = points.map(() => [] as number[]);
  const faces = points.map(() => 0);
  for (const q of quads) {
    for (let corner = 0; corner < 4; corner++) {
      const vertex = q[corner];
      const a = q[(corner + 1) % 4];
      const b = q[(corner + 3) % 4];
      nbE[vertex].add(a).add(b);
      nbF[vertex].push(q[(corner + 2) % 4]);
      faces[vertex]++;
      if (edgeCount.get(ekey(vertex, a)) === 1) {
        border[vertex].push(a);
      }
      if (edgeCount.get(ekey(vertex, b)) === 1) {
        border[vertex].push(b);
      }
    }
  }
  // Sharp edges: followed as the border is.
  const sharpAt = points.map(() => [] as number[]);
  for (const key of subdivided.creased ?? []) {
    const [a, b] = key.split(',').map(Number);
    if (edgeCount.get(key) !== 2) {
      continue;
    }
    sharpAt[a].push(b);
    sharpAt[b].push(a);
  }

  return points.map((point, vertex) => {
    if (!faces[vertex]) {
      return point;
    }
    const open = [...new Set(border[vertex])];
    const cr = sharpAt[vertex];
    if (cr.length) {
      // Two (sharp or border) through the point: on that curve. More: a corner. One, in the middle: it fades out (smooth).
      const through = [...new Set([...open, ...cr])];
      if (through.length > 2) {
        return point;
      }
      if (through.length === 2) {
        return [0, 1, 2].map(axis => (points[through[0]][axis] + 4 * point[axis] + points[through[1]][axis]) / 6) as Vec3;
      }
    }
    const bd = open;
    if (bd.length) {
      // On an open border: a corner (one face) stays; otherwise the border curve's point.
      if ((sharp ? sharp.has(vertex) : faces[vertex] === 1) || bd.length !== 2) {
        return point;
      }

      return [0, 1, 2].map(axis => (points[bd[0]][axis] + 4 * point[axis] + points[bd[1]][axis]) / 6) as Vec3;
    }
    const size = nbE[vertex].size;
    if (size !== faces[vertex]) {
      return point;
    } // not a simple fan (shouldn't happen)
    const out: Vec3 = [point[0] * size * size, point[1] * size * size, point[2] * size * size];
    for (const e of nbE[vertex]) {
      for (let axis = 0; axis < 3; axis++) {
        out[axis] += 4 * points[e][axis];
      }
    }
    for (const face of nbF[vertex]) {
      for (let axis = 0; axis < 3; axis++) {
        out[axis] += points[face][axis];
      }
    }
    const denominator = size * (size + 5);

    return [out[0] / denominator, out[1] / denominator, out[2] / denominator];
  });
}

/**
 * A sheet whose smooth border runs THROUGH the cage's border points (as
 * drawn, a smooth surface's border only comes near them) and turns a corner
 * where they do: the cage with its border points moved to where they pull the
 * border onto the old ones, and the corners. For a sheet laid over a face,
 * whose border points lie on the face's edge - so does the surface's then.
 */
export function borderThrough(cage: Cage): { cage: Cage; sharp: Set<number> } {
  const next = new Map<number, number>();
  for (const [a, b] of boundaryEdges(cage)) {
    next.set(a, b);
  }
  const prev = new Map<number, number>();
  for (const [a, b] of next) {
    prev.set(b, a);
  }
  const vertices = cage.verts;
  const sharp = new Set<number>();
  for (const [vertex, nextVertex] of next) {
    const prevVertex = prev.get(vertex);
    if (prevVertex === undefined) {
      continue;
    }
    const d1 = [0, 1, 2].map(axis => vertices[vertex][axis] - vertices[prevVertex][axis]);
    const d2 = [0, 1, 2].map(axis => vertices[nextVertex][axis] - vertices[vertex][axis]);
    const lengths = Math.hypot(...d1) * Math.hypot(...d2);
    const cos = lengths > 0 ? (d1[0] * d2[0] + d1[1] * d2[1] + d1[2] * d2[2]) / lengths : 1;
    if (cos < Math.cos((25 * Math.PI) / 180)) {
      sharp.add(vertex);
    }
  }
  // The border's point at a control point is (before + 4·it + after) / 6:
  // solved for the control points that put it on the old point (it settles in
  // a few rounds: each point depends mostly on itself).
  const corrected = vertices.map(point => [...point] as Vec3);
  const free = [...next.keys()].filter(vertex => !sharp.has(vertex) && prev.has(vertex));
  for (let round = 0; round < 60; round++) {
    for (const vertex of free) {
      const a = corrected[prev.get(vertex)!];
      const b = corrected[next.get(vertex)!];
      corrected[vertex] = [0, 1, 2].map(axis => (6 * vertices[vertex][axis] - a[axis] - b[axis]) / 4) as Vec3;
    }
  }

  return { cage: { verts: corrected, faces: cage.faces }, sharp };
}

/** The points along a subdivided sheet's open border, as pieces [from, to]. */
export function borderPieces(subdivided: Subdivided): [Vec3, Vec3][] {
  const count = new Map<string, [number, number]>();
  const seen = new Map<string, number>();
  for (const grid of subdivided.grids) {
    for (let i = 0; i < subdivided.n; i++) {
      for (let j = 0; j < subdivided.n; j++) {
        const q = [grid[i][j], grid[i + 1][j], grid[i + 1][j + 1], grid[i][j + 1]];
        for (let corner = 0; corner < 4; corner++) {
          const a = q[corner];
          const b = q[(corner + 1) % 4];
          const key = a < b ? `${a},${b}` : `${b},${a}`;
          seen.set(key, (seen.get(key) ?? 0) + 1);
          count.set(key, [a, b]);
        }
      }
    }
  }

  return [...count].filter(([key]) => seen.get(key) === 1).map(([, [a, b]]) => [subdivided.points[a], subdivided.points[b]]);
}

// ------------------------------------------------------- subdivision plan
//
// Catmull–Clark and the limit points are fixed weighted sums of the cage
// points: which points and how much depends only on how the faces connect.
// Dragging points or moving a slider (Length, Bend…) keeps that the same, so
// the weights are worked out once per cage layout and every redraw is just
// the sums (~1 ms instead of ~13 for the watering can: 97 faces, 6254 points).

/** Weighted sums: point k of the result = Σ w[j]·src[idx[j]] for j in ptr[k]…ptr[k+1]. */
interface Rows {
  ptr: Int32Array;
  idx: Int32Array;
  w: Float64Array;
}

export interface SubdivPlan {
  /** Layout this plan was made for (same faces → same plan). */
  key: string;
  verts: number;
  /** The final grids per cage face, and their size. */
  grids: number[][][];
  n: number;
  /** Cage points → smooth (limit) points, all levels folded into one table. */
  rows: Rows;
}

class RowBuilder {
  private ptr: number[] = [0];
  private idx: number[] = [];
  private weights: number[] = [];
  add(terms: Map<number, number>): void {
    for (const [i, term] of terms) {
      if (term !== 0) {
        (this.idx.push(i), this.weights.push(term));
      }
    }
    this.ptr.push(this.idx.length);
  }
  done(): Rows {
    return { ptr: Int32Array.from(this.ptr), idx: Int32Array.from(this.idx), w: Float64Array.from(this.weights) };
  }
}

/** Fold two tables: (b after a) as one, in cage-point terms. */
function compose(a: Rows, b: Rows): Rows {
  const out = new RowBuilder();
  const rowCount = b.ptr.length - 1;
  for (let row = 0; row < rowCount; row++) {
    const weights = new Map<number, number>();
    for (let j = b.ptr[row]; j < b.ptr[row + 1]; j++) {
      const i = b.idx[j];
      const wb = b.w[j];
      for (let q = a.ptr[i]; q < a.ptr[i + 1]; q++) {
        weights.set(a.idx[q], (weights.get(a.idx[q]) ?? 0) + wb * a.w[q]);
      }
    }
    out.add(weights);
  }

  return out.done();
}

/** The layout key of a cage: its faces (positions don't matter). */
export function layoutKey(cage: Cage): string {
  return `${cage.verts.length}|${cage.faces.join(';')}${cage.creases?.length ? `|${cage.creases.join(';')}` : ''}`;
}

/**
 * The weights that take a cage's points to its smooth surface points, the
 * same as limitPoints(subdivide(cage, levels)) - exactly the same rules,
 * recorded instead of applied.
 */
export function subdivisionPlan(cage: Cage, levels = 3): SubdivPlan {
  const P0 = cage.verts.length;
  // Identity to start with: every point is itself.
  let acc: Rows = { ptr: Int32Array.from({ length: P0 + 1 }, (_, i) => i), idx: Int32Array.from({ length: P0 }, (_, i) => i), w: new Float64Array(P0).fill(1) };
  let count = P0;
  let grids = cage.faces.map(face => [
    [face[0], face[3]],
    [face[1], face[2]]
  ]);
  let nextId = 1;
  // Sharp edges (see subdivide), as pairs: the numbering of a level's edges changes with it.
  let sharpPairs: [number, number][] = (cage.creases ?? []).map(([a, b]) => [a, b]);
  const addTo = (weights: Map<number, number>, i: number, weight: number) => weights.set(i, (weights.get(i) ?? 0) + weight);
  for (let lvl = 0; lvl < levels; lvl++) {
    const quads: number[][] = [];
    for (const grid of grids) {
      for (let i = 0; i < nextId; i++) {
        for (let j = 0; j < nextId; j++) {
          quads.push([grid[i][j], grid[i + 1][j], grid[i + 1][j + 1], grid[i][j + 1]]);
        }
      }
    }
    const ekey = (a: number, b: number) => (a < b ? a * count + b : b * count + a);
    const creased = new Set(sharpPairs.map(([a, b]) => ekey(a, b)));
    // Edges in first-seen order (subdivide numbers its edge points that way).
    const edgeFaces = new Map<number, number[]>();
    quads.forEach((q, qi) => {
      for (let corner = 0; corner < 4; corner++) {
        const key = ekey(q[corner], q[(corner + 1) % 4]);
        const list = edgeFaces.get(key);
        if (list) {
          list.push(qi);
        } else {
          edgeFaces.set(key, [qi]);
        }
      }
    });
    const vFaces: number[][] = Array.from({ length: count }, () => []);
    const vEdges: number[][] = Array.from({ length: count }, () => []);
    quads.forEach((q, qi) => q.forEach(vertex => vFaces[vertex].push(qi)));
    for (const key of edgeFaces.keys()) {
      const a = Math.floor(key / count);
      const b = key % count;
      vEdges[a].push(key);
      vEdges[b].push(key);
    }
    const ends = (key: number): [number, number] => [Math.floor(key / count), key % count];
    const step = new RowBuilder();
    // Moved old points.
    for (let vEdgeIndex = 0; vEdgeIndex < count; vEdgeIndex++) {
      const es = vEdges[vEdgeIndex];
      const fs = vFaces[vEdgeIndex];
      const weights = new Map<number, number>();
      if (!es.length || !fs.length) {
        weights.set(vEdgeIndex, 1);
      } else {
        const border = es.filter(edgeKey => edgeFaces.get(edgeKey)!.length === 1);
        const crease = creased.size ? es.filter(edgeKey => creased.has(edgeKey) && edgeFaces.get(edgeKey)!.length === 2) : [];
        const boundary = crease.length ? [...border, ...crease] : border;
        if (crease.length && boundary.length > 2) {
          weights.set(vEdgeIndex, 1);
        } else if (boundary.length >= 2) {
          if (!crease.length && fs.length === 1) {
            weights.set(vEdgeIndex, 1);
          } else {
            addTo(weights, vEdgeIndex, 0.75);
            for (const edgeKey of boundary.slice(0, 2)) {
              const [a, b] = ends(edgeKey);
              addTo(weights, a === vEdgeIndex ? b : a, 0.125);
            }
          }
        } else {
          const mm = es.length;
          // F: the average of the face points; R: of the edge midpoints.
          for (const face of fs) {
            for (const q of quads[face]) {
              addTo(weights, q, 1 / (4 * fs.length * mm));
            }
          }
          for (const edgeKey of es) {
            const [a, b] = ends(edgeKey);
            addTo(weights, a, 1 / mm / mm);
            addTo(weights, b, 1 / mm / mm);
          }
          addTo(weights, vEdgeIndex, (mm - 3) / mm);
        }
      }
      step.add(weights);
    }
    // Edge points.
    for (const [key, fs] of edgeFaces) {
      const [a, b] = ends(key);
      const weights = new Map<number, number>();
      if (fs.length === 2 && !creased.has(key)) {
        addTo(weights, a, 0.25);
        addTo(weights, b, 0.25);
        for (const face of fs) {
          for (const q of quads[face]) {
            addTo(weights, q, 0.0625);
          }
        }
      } else {
        addTo(weights, a, 0.5);
        addTo(weights, b, 0.5);
      }
      step.add(weights);
    }
    // Face points.
    for (const q of quads) {
      const weights = new Map<number, number>();
      for (const vertex of q) {
        addTo(weights, vertex, 0.25);
      }
      step.add(weights);
    }
    acc = compose(acc, step.done());
    // New grids, twice as fine (same numbering as subdivide).
    const edgeIdx = new Map<number, number>();
    let e = count;
    for (const key of edgeFaces.keys()) {
      edgeIdx.set(key, e++);
    }
    if (sharpPairs.length) {
      const halves: [number, number][] = [];
      for (const [a, b] of sharpPairs) {
        const mid = edgeIdx.get(ekey(a, b));
        if (mid !== undefined) {
          halves.push([a, mid], [mid, b]);
        }
      }
      sharpPairs = halves;
    }
    let qi = 0;
    const gridSize = 2 * nextId;
    const faceBase = e;
    grids = grids.map((grid) => {
      const ng: number[][] = Array.from({ length: gridSize + 1 }, () => new Array<number>(gridSize + 1));
      for (let i = 0; i <= nextId; i++) {
        for (let j = 0; j <= nextId; j++) {
          ng[2 * i][2 * j] = grid[i][j];
        }
      }
      for (let i = 0; i <= nextId; i++) {
        for (let j = 0; j < nextId; j++) {
          ng[2 * i][2 * j + 1] = edgeIdx.get(ekey(grid[i][j], grid[i][j + 1]))!;
        }
      }
      for (let i = 0; i < nextId; i++) {
        for (let j = 0; j <= nextId; j++) {
          ng[2 * i + 1][2 * j] = edgeIdx.get(ekey(grid[i][j], grid[i + 1][j]))!;
        }
      }
      for (let i = 0; i < nextId; i++) {
        for (let j = 0; j < nextId; j++) {
          ng[2 * i + 1][2 * j + 1] = faceBase + qi++;
        }
      }

      return ng;
    });
    count = faceBase + quads.length;
    nextId = gridSize;
  }
  // The limit points (as limitPoints does).
  const quads: number[][] = [];
  for (const grid of grids) {
    for (let i = 0; i < nextId; i++) {
      for (let j = 0; j < nextId; j++) {
        quads.push([grid[i][j], grid[i + 1][j], grid[i + 1][j + 1], grid[i][j + 1]]);
      }
    }
  }
  const ek = (a: number, b: number) => (a < b ? a * count + b : b * count + a);
  const edgeCount = new Map<number, number>();
  for (const q of quads) {
    for (let corner = 0; corner < 4; corner++) {
      edgeCount.set(ek(q[corner], q[(corner + 1) % 4]), (edgeCount.get(ek(q[corner], q[(corner + 1) % 4])) ?? 0) + 1);
    }
  }
  const nbE = Array.from({ length: count }, () => new Set<number>());
  const nbF: number[][] = Array.from({ length: count }, () => []);
  const border: number[][] = Array.from({ length: count }, () => []);
  const faces = new Int32Array(count);
  for (const q of quads) {
    for (let corner = 0; corner < 4; corner++) {
      const vertex = q[corner];
      const a = q[(corner + 1) % 4];
      const b = q[(corner + 3) % 4];
      nbE[vertex].add(a).add(b);
      nbF[vertex].push(q[(corner + 2) % 4]);
      faces[vertex]++;
      if (edgeCount.get(ek(vertex, a)) === 1) {
        border[vertex].push(a);
      }
      if (edgeCount.get(ek(vertex, b)) === 1) {
        border[vertex].push(b);
      }
    }
  }
  const sharpAt: number[][] = Array.from({ length: count }, () => []);
  for (const [a, b] of sharpPairs) {
    if (edgeCount.get(ek(a, b)) !== 2) {
      continue;
    }
    sharpAt[a].push(b);
    sharpAt[b].push(a);
  }
  const lim = new RowBuilder();
  for (let vertex = 0; vertex < count; vertex++) {
    const weights = new Map<number, number>();
    const bd = [...new Set(border[vertex])];
    const nE = nbE[vertex].size;
    const through = sharpAt[vertex].length ? [...new Set([...bd, ...sharpAt[vertex]])] : [];
    if (through.length > 2) {
      weights.set(vertex, 1);
    } else if (through.length === 2) {
      addTo(weights, through[0], 1 / 6);
      addTo(weights, vertex, 4 / 6);
      addTo(weights, through[1], 1 / 6);
    } else if (!faces[vertex] || (bd.length && (faces[vertex] === 1 || bd.length !== 2)) || (!bd.length && nE !== faces[vertex])) {
      weights.set(vertex, 1);
    } else if (bd.length) {
      addTo(weights, bd[0], 1 / 6);
      addTo(weights, vertex, 4 / 6);
      addTo(weights, bd[1], 1 / 6);
    } else {
      const denominator = nE * (nE + 5);
      addTo(weights, vertex, (nE * nE) / denominator);
      for (const e of nbE[vertex]) {
        addTo(weights, e, 4 / denominator);
      }
      for (const face of nbF[vertex]) {
        addTo(weights, face, 1 / denominator);
      }
    }
    lim.add(weights);
  }

  return { key: layoutKey(cage), verts: P0, grids, n: nextId, rows: compose(acc, lim.done()) };
}

/** The smooth points for these cage positions (into `out` when given: no new arrays while dragging). */
export function applyPlan(plan: SubdivPlan, verts: Vec3[], out?: Float32Array): Float32Array {
  const { ptr, idx, w } = plan.rows;
  const rowCount = ptr.length - 1;
  const res = out && out.length === rowCount * 3 ? out : new Float32Array(rowCount * 3);
  for (let row = 0; row < rowCount; row++) {
    let x = 0, y = 0, z = 0;
    for (let j = ptr[row]; j < ptr[row + 1]; j++) {
      const vertex = verts[idx[j]];
      const weight = w[j];
      x += weight * vertex[0];
      y += weight * vertex[1];
      z += weight * vertex[2];
    }
    res[3 * row] = x;
    res[3 * row + 1] = y;
    res[3 * row + 2] = z;
  }

  return res;
}

/** The preview's triangles for a plan's grids (they only change with the layout). */
export function planIndices(plan: SubdivPlan): Uint32Array {
  const idx: number[] = [];
  for (const grid of plan.grids) {
    for (let i = 0; i < plan.n; i++) {
      for (let j = 0; j < plan.n; j++) {
        const a = grid[i][j];
        const b = grid[i + 1][j];
        const cornerC = grid[i + 1][j + 1];
        const cornerD = grid[i][j + 1];
        idx.push(a, b, cornerC, a, cornerC, cornerD);
      }
    }
  }

  return new Uint32Array(idx);
}

/** Smooth normals (area-weighted) for positions and triangles, into `out` when given. */
export function smoothNormals(pos: Float32Array, tri: Uint32Array, out?: Float32Array): Float32Array {
  const nrm = out && out.length === pos.length ? out.fill(0) : new Float32Array(pos.length);
  for (let t = 0; t < tri.length; t += 3) {
    const a = tri[t] * 3, b = tri[t + 1] * 3, offsetC = tri[t + 2] * 3;
    const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
    const vx = pos[offsetC] - pos[a], vy = pos[offsetC + 1] - pos[a + 1], vz = pos[offsetC + 2] - pos[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    nrm[a] += nx; nrm[a + 1] += ny; nrm[a + 2] += nz;
    nrm[b] += nx; nrm[b + 1] += ny; nrm[b + 2] += nz;
    nrm[offsetC] += nx; nrm[offsetC + 1] += ny; nrm[offsetC + 2] += nz;
  }
  for (let offset = 0; offset < nrm.length; offset += 3) {
    const length = Math.hypot(nrm[offset], nrm[offset + 1], nrm[offset + 2]) || 1;
    nrm[offset] /= length;
    nrm[offset + 1] /= length;
    nrm[offset + 2] /= length;
  }

  return nrm;
}

/** Cage edges (each once), for drawing and picking. */
export function cageEdges(cage: Cage): [number, number][] {
  const seen = new Set<string>();
  const out: [number, number][] = [];
  for (const face of cage.faces) {
    for (let corner = 0; corner < 4; corner++) {
      const a = face[corner];
      const b = face[(corner + 1) % 4];
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      if (!seen.has(key)) {
        (seen.add(key), out.push([a, b]));
      }
    }
  }

  return out;
}

/** Does every cage edge have two faces (a closed shape → a solid)? */
export function isClosed(cage: Cage): boolean {
  const count = new Map<string, number>();
  for (const face of cage.faces) {
    for (let corner = 0; corner < 4; corner++) {
      const a = face[corner];
      const b = face[(corner + 1) % 4];
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      count.set(key, (count.get(key) ?? 0) + 1);
    }
  }

  return [...count.values()].every(uses => uses === 2);
}

// ------------------------------------------------------------ cage editing

/**
 * Freeform's exact values on picked points: Move by [x, y, z] (mm); Turn by
 * x°, y°, z° about X, then Y, then Z through the points' middle; or Scale by
 * all × [x, y, z] about the middle - about the ground instead, upwards, when
 * the points stand on it (a cylinder made 5× taller sank 80 mm below the floor).
 */
export function moveTurnScale(pts: Vec3[], mode: 'move' | 'turn' | 'scale', [x, y, z, all]: [number, number, number, number]): Vec3[] {
  if (!pts.length) {
    return [];
  }
  const center = mul3(pts.reduce((sum, point) => add3(sum, point), [0, 0, 0] as Vec3), 1 / pts.length);
  if (mode === 'move') {
    return pts.map(point => [point[0] + x, point[1] + y, point[2] + z]);
  }
  if (mode === 'scale') {
    const low = Math.min(...pts.map(point => point[2]));
    const cz = Math.abs(low) < 1e-6 ? 0 : center[2];

    return pts.map(point => [center[0] + (point[0] - center[0]) * all * x, center[1] + (point[1] - center[1]) * all * y, cz + (point[2] - cz) * all * z]);
  }

  return pts.map((point) => {
    let q = sub3(point, center);
    for (const [ax, deg] of [[[1, 0, 0], x], [[0, 1, 0], y], [[0, 0, 1], z]] as [Vec3, number][]) {
      if (!deg) {
        continue;
      }
      const t = (deg * Math.PI) / 180;
      q = add3(add3(mul3(q, Math.cos(t)), mul3(cross3(ax, q), Math.sin(t))), mul3(ax, dot3(ax, q) * (1 - Math.cos(t))));
    }

    return add3(center, q);
  });
}

/** Remove faces; points no face uses any more go too (indices are renumbered). */
export function deleteFaces(cage: Cage, faces: number[]): Cage {
  const drop = new Set(faces);

  return compact({ verts: cage.verts, faces: cage.faces.filter((_, i) => !drop.has(i)), creases: cage.creases });
}

function compact(cage: Cage): Cage {
  const used = [...new Set(cage.faces.flat())].sort((a, b) => a - b);
  const map = new Map(used.map((vertex, i) => [vertex, i]));
  const out: Cage = { verts: used.map(vertex => cage.verts[vertex]), faces: cage.faces.map(face => face.map(vertex => map.get(vertex)!) as Cage['faces'][number]) };

  return withCreases(out, (cage.creases ?? []).flatMap(([a, b]) => (map.has(a) && map.has(b) ? [[map.get(a)!, map.get(b)!] as [number, number]] : [])));
}

/** The cage with these sharp edges - those that are edges of it (none: no list at all). */
export function withCreases(cage: Cage, creases: [number, number][]): Cage {
  const { creases: _old, ...rest } = cage;
  if (!creases.length) {
    return rest;
  }
  const edges = new Set<string>();
  for (const face of cage.faces) {
    for (let corner = 0; corner < 4; corner++) {
      edges.add(ekey(face[corner], face[(corner + 1) % 4]));
    }
  }
  const seen = new Set<string>();
  const kept = creases.filter(([a, b]) => edges.has(ekey(a, b)) && !seen.has(ekey(a, b)) && !!seen.add(ekey(a, b)));

  return kept.length ? { ...rest, creases: kept } : rest;
}

/**
 * A cage made from another by a tool (a loop added, faces pulled out, a hole
 * filled...) with the other's sharp edges on it: each where it still is - the
 * same edge, or, where the tool cut it (a loop across it), the pieces of it.
 * Found by where the points are: the tools number points as they please.
 */
export function carryCreases(prev: Cage, next: Cage): Cage {
  if (next.creases || !prev.creases?.length) {
    return next;
  }
  const at = new Map<string, number>();
  const pos = (point: Vec3) => `${point[0].toFixed(6)},${point[1].toFixed(6)},${point[2].toFixed(6)}`;
  next.verts.forEach((vertex, i) => at.set(pos(vertex), i));
  const edges = new Set<string>();
  for (const face of next.faces) {
    for (let corner = 0; corner < 4; corner++) {
      edges.add(ekey(face[corner], face[(corner + 1) % 4]));
    }
  }
  const out: [number, number][] = [];
  for (const [a, b] of prev.creases) {
    const [pa, pb] = [prev.verts[a], prev.verts[b]];
    const [ia, ib] = [at.get(pos(pa)), at.get(pos(pb))];
    if (ia === undefined || ib === undefined) {
      continue;
    }
    if (edges.has(ekey(ia, ib))) {
      out.push([ia, ib]);
      continue;
    }
    // Cut: the points of the new cage along it, in order, joined where they are edges.
    const direction: Vec3 = [pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]];
    const l2 = direction[0] * direction[0] + direction[1] * direction[1] + direction[2] * direction[2];
    if (l2 < 1e-18) {
      continue;
    }
    const on: { i: number; t: number }[] = [];
    next.verts.forEach((q, i) => {
      const offset: Vec3 = [q[0] - pa[0], q[1] - pa[1], q[2] - pa[2]];
      const t = (offset[0] * direction[0] + offset[1] * direction[1] + offset[2] * direction[2]) / l2;
      if (t < -1e-9 || t > 1 + 1e-9) {
        return;
      }
      const off = Math.hypot(offset[0] - direction[0] * t, offset[1] - direction[1] * t, offset[2] - direction[2] * t);
      if (off < Math.sqrt(l2) * 1e-6) {
        on.push({ i, t });
      }
    });
    on.sort((first, second) => first.t - second.t);
    for (let index = 0; index + 1 < on.length; index++) {
      if (edges.has(ekey(on[index].i, on[index + 1].i))) {
        out.push([on[index].i, on[index + 1].i]);
      }
    }
  }

  return withCreases(next, out);
}

const ekey = (a: number, b: number) => (a < b ? `${a},${b}` : `${b},${a}`);

/** Edges used by only one face (the rim of a sheet or of a hole), as that face winds them. */
export function boundaryEdges(cage: Cage): [number, number][] {
  const count = new Map<string, { n: number; dir: [number, number] }>();
  for (const face of cage.faces) {
    for (let corner = 0; corner < 4; corner++) {
      const a = face[corner];
      const b = face[(corner + 1) % 4];
      const e = count.get(ekey(a, b));
      if (e) {
        e.n++;
      } else {
        count.set(ekey(a, b), { n: 1, dir: [a, b] });
      }
    }
  }

  return [...count.values()].filter(e => e.n === 1).map(e => e.dir);
}

/**
 * Closed loops among the chosen boundary edges, each walked the opposite way
 * to the face it borders - the winding a new face filling it needs.
 */
export function holeLoops(cage: Cage, chosen: Set<string>): number[][] {
  const edges = boundaryEdges(cage).filter(([a, b]) => chosen.has(ekey(a, b)));
  // Reverse each: from b to a.
  const next = new Map<number, number>();
  for (const [a, b] of edges) {
    next.set(b, a);
  }
  const loops: number[][] = [];
  const seen = new Set<number>();
  for (const start of next.keys()) {
    if (seen.has(start)) {
      continue;
    }
    const loop: number[] = [];
    let vertex: number | undefined = start;
    while (vertex !== undefined && !seen.has(vertex)) {
      seen.add(vertex);
      loop.push(vertex);
      vertex = next.get(vertex);
    }
    if (vertex === start && loop.length >= 3) {
      loops.push(loop);
    }
  }

  return loops;
}

/** Fill a hole: 4 edges → one quad; an even number above 4 → quads around a new centre point. */
export function fillLoop(cage: Cage, loop: number[]): Cage | null {
  const count = loop.length;
  if (count === 4) {
    return { verts: cage.verts, faces: [...cage.faces, [loop[0], loop[1], loop[2], loop[3]]] };
  }
  if (count < 4 || count % 2) {
    return null;
  }
  const center = loop.reduce((sum, vertex) => [sum[0] + cage.verts[vertex][0] / count, sum[1] + cage.verts[vertex][1] / count, sum[2] + cage.verts[vertex][2] / count] as Vec3, [0, 0, 0] as Vec3);
  const ci = cage.verts.length;
  const faces = [...cage.faces];
  for (let index = 0; index < count; index += 2) {
    faces.push([ci, loop[index], loop[(index + 1) % count], loop[(index + 2) % count]]);
  }

  return { verts: [...cage.verts, center], faces };
}

/**
 * The same smooth shape with a cage twice as fine (one Catmull–Clark step:
 * the subdivision surface doesn't change). Old points keep their indices.
 */
export function refineCage(cage: Cage): Cage {
  const subdivided = subdivide(cage, 1);
  const faces: Cage['faces'] = [];
  for (const grid of subdivided.grids) {
    for (let i = 0; i < 2; i++) {
      for (let j = 0; j < 2; j++) {
        faces.push([grid[i][j], grid[i + 1][j], grid[i + 1][j + 1], grid[i][j + 1]]);
      }
    }
  }

  return compact({ verts: subdivided.points, faces, creases: [...(subdivided.creased ?? [])].map(edgeKey => edgeKey.split(',').map(Number) as [number, number]) });
}

/**
 * Fill a hole with any number of edges. An odd hole can't be closed with
 * quads alone (every quad adds an even number of edge ends), so the cage is
 * first made twice as fine - same shape, and the hole then has twice as many
 * edges. Returns the new cage and whether it had to be refined.
 */
export function fillHole(cage: Cage, loop: number[]): { cage: Cage; refined: boolean } | null {
  if (loop.length >= 4 && loop.length % 2 === 0) {
    const filled = fillLoop(cage, loop);

    return filled && { cage: filled, refined: false };
  }
  if (loop.length < 3) {
    return null;
  }
  const fine = refineCage(cage);
  // Old points keep their numbers (compact keeps the order): find the hole again by one of its points.
  const rim = boundaryEdges(fine);
  const loops = holeLoops(fine, new Set(rim.map(([a, b]) => ekey(a, b))));
  const ring = loops.find(candidate => candidate.includes(loop[0]) && candidate.includes(loop[1]));
  if (!ring) {
    return null;
  }
  const refilled = fillLoop(fine, ring);

  return refilled && { cage: refilled, refined: true };
}

/**
 * Bridge two holes with the same number of edges by a ring of quads (e.g. a
 * tunnel between a front and a back opening). The second loop is turned and
 * rotated to line up with the first so the quads don't twist.
 */
export function bridgeLoops(cage: Cage, a: number[], b: number[]): Cage | null {
  const count = a.length;
  if (b.length !== count) {
    return null;
  }
  // Facing holes run opposite ways round: walk b backwards, then pick the start that lines up best.
  const rb = [...b].reverse();
  const distance = (vertexA: number, q: number) => Math.hypot(...[0, 1, 2].map(axis => cage.verts[vertexA][axis] - cage.verts[q][axis]));
  let best = 0;
  let bestCost = Infinity;
  for (let shift = 0; shift < count; shift++) {
    let cost = 0;
    for (let i = 0; i < count; i++) {
      cost += distance(a[i], rb[(i + shift) % count]);
    }
    if (cost < bestCost) {
      (bestCost = cost), (best = shift);
    }
  }
  const shiftedB = (i: number) => rb[(i + best) % count];
  const faces = [...cage.faces];
  // Each a-edge (a_i → a_i+1) already runs as the new face needs it; the b side runs back.
  for (let i = 0; i < count; i++) {
    faces.push([a[i], a[(i + 1) % count], shiftedB(i + 1), shiftedB(i)]);
  }

  return { verts: cage.verts, faces };
}

/**
 * Bridge two faces: both are taken out and a tube of quads joins the two holes
 * (a handle between two faces pulled towards each other, a tunnel through a
 * body). One step instead of deleting both and picking every rim point.
 * The faces must have the same number of sides and share no point.
 */
export function bridgeFaces(cage: Cage, fa: number, fb: number): Cage | null {
  const faceA = cage.faces[fa];
  const faceB = cage.faces[fb];
  if (!faceA || !faceB || fa === fb || faceA.some(vertex => faceB.includes(vertex))) {
    return null;
  }
  // Holes as holeLoops gives them: wound like the face that filled them.
  const loopA = [...faceA];
  const loopB = [...faceB];
  const without = { verts: cage.verts, faces: cage.faces.filter((_, i) => i !== fa && i !== fb) };
  const out = bridgeLoops(without, loopA, loopB);

  // Same points, same numbers (nothing compacted: every rim point is still used by its neighbours).
  return out && windingAgrees(out) ? out : null;
}

/** Turn `vector` the least way that takes direction `fromDir` onto direction `toDir` (both unit). */
function turnLike(vector: Vec3, fromDir: Vec3, toDir: Vec3): Vec3 {
  const ax = cross3(fromDir, toDir);
  const sn = Math.hypot(...ax);
  const cs = dot3(fromDir, toDir);
  if (sn < 1e-12) {
    if (cs > 0) {
      return vector;
    }
    // Half a turn: about any line square to `fromDir`.
    const perpendicular = Math.abs(fromDir[0]) < 0.9 ? cross3(fromDir, [1, 0, 0]) : cross3(fromDir, [0, 1, 0]);
    const axis = mul3(perpendicular, 1 / Math.hypot(...perpendicular));

    return sub3(mul3(axis, 2 * dot3(axis, vector)), vector);
  }
  const rotationAxis = mul3(ax, 1 / sn);

  return add3(add3(mul3(vector, cs), mul3(cross3(rotationAxis, vector), sn)), mul3(rotationAxis, dot3(rotationAxis, vector) * (1 - cs)));
}

const unit3 = (vector: Vec3): Vec3 => mul3(vector, 1 / (Math.hypot(...vector) || 1));
const faceCentre = (cage: Cage, face: number): Vec3 => mul3(cage.faces[face].reduce((a, vertex) => add3(a, cage.verts[vertex]), [0, 0, 0] as Vec3), 0.25);

/**
 * Pull one face out in `steps` even steps, `length` long in all, bending
 * `bend` degrees on the way (upwards; negative: down - sideways for a face
 * that looks up or down) and ending `taper` times its size: a spout or an arm
 * in one go, with sliders instead of a value per step. Returns the cage and
 * the end face.
 */
export function sweepFace(cage: Cage, face: number, options: { steps: number; length: number; bend: number; taper: number }): { cage: Cage; face: number } | null {
  const q = cage.faces[face];
  if (!q) {
    return null;
  }
  const steps = Math.max(1, Math.round(options.steps));
  const center = faceCentre(cage, face);
  const normal = faceNormal(cage, q);
  // The way it bends: up, as seen square to the face (sideways for a face looking up or down).
  let b = sub3([0, 0, 1], mul3(normal, normal[2]));
  if (Math.hypot(...b) < 1e-6) {
    b = sub3([1, 0, 0], mul3(normal, normal[0]));
  }
  b = unit3(b);
  const P0 = q.map(vertex => sub3(cage.verts[vertex], center));
  const th = (options.bend * Math.PI) / 180;
  let cur = cage;
  let currentFace = face;
  for (let step = 1; step <= steps; step++) {
    const ex = extrudeFaces(cur, [currentFace], 1);
    if (!ex) {
      return null;
    }
    cur = ex.cage;
    currentFace = ex.faces[0];
    const t = step / steps;
    const phi = th * t;
    // Along a circular arc of the whole length (straight when it doesn't bend).
    const at: Vec3 = Math.abs(th) < 1e-9 ? add3(center, mul3(normal, options.length * t)) : add3(center, add3(mul3(normal, (options.length / th) * Math.sin(phi)), mul3(b, (options.length / th) * (1 - Math.cos(phi)))));
    const dir = unit3(add3(mul3(normal, Math.cos(phi)), mul3(b, Math.sin(phi))));
    const scale = 1 + (options.taper - 1) * t;
    const verts = cur.verts.map(vertex => [...vertex] as Vec3);
    cur.faces[currentFace].forEach((vertex, i) => (verts[vertex] = add3(at, mul3(turnLike(P0[i], normal, dir), scale))));
    cur = { verts, faces: cur.faces };
  }

  return { cage: cur, face: currentFace };
}

/**
 * Bridge two faces with a tube that arches out: it leaves each face along its
 * normal, `arch` far before turning (a cubic curve), in `segments` pieces -
 * a handle between two faces on the same side of a body, with one slider.
 * Arch 0 and one segment: the straight bridge.
 */
export function archBridge(cage: Cage, fa: number, fb: number, options: { arch: number; segments: number }): Cage | null {
  const segments = Math.max(1, Math.round(options.segments));
  if (segments === 1) {
    return bridgeFaces(cage, fa, fb);
  }
  const faceA = cage.faces[fa];
  const faceB = cage.faces[fb];
  if (!faceA || !faceB || fa === fb || faceA.some(vertex => faceB.includes(vertex))) {
    return null;
  }
  const cA = faceCentre(cage, fa);
  const cB = faceCentre(cage, fb);
  const nA = faceNormal(cage, faceA);
  const nB = faceNormal(cage, faceB);
  const arch = options.arch;
  const controls = [cA, add3(cA, mul3(nA, arch)), add3(cB, mul3(nB, arch)), cB];
  const bez = (t: number): Vec3 => {
    const oneMinusT = 1 - t;

    return add3(add3(mul3(controls[0], oneMinusT * oneMinusT * oneMinusT), mul3(controls[1], 3 * oneMinusT * oneMinusT * t)), add3(mul3(controls[2], 3 * oneMinusT * t * t), mul3(controls[3], t * t * t)));
  };
  const tan = (t: number): Vec3 => {
    const oneMinusT = 1 - t;
    const tangent = add3(add3(mul3(sub3(controls[1], controls[0]), 3 * oneMinusT * oneMinusT), mul3(sub3(controls[2], controls[1]), 6 * oneMinusT * t)), mul3(sub3(controls[3], controls[2]), 3 * t * t));

    return Math.hypot(...tangent) < 1e-9 ? unit3(sub3(cB, cA)) : unit3(tangent);
  };
  const off = faceA.map(vertex => sub3(cage.verts[vertex], cA));
  const rA = off.reduce((a, offset) => a + Math.hypot(...offset), 0) / 4;
  const rB = faceB.reduce((a, vertex) => a + Math.hypot(...sub3(cage.verts[vertex], cB)), 0) / 4;
  // The face's shape carried along the curve, turned a little at a time (so it never flips).
  let o0 = off;
  let prev = nA;
  const verts = cage.verts.map(vertex => [...vertex] as Vec3);
  const rings: number[][] = [];
  const fine = 8;
  for (let segment = 1; segment < segments; segment++) {
    for (let j = 1; j <= fine; j++) {
      const t = (segment - 1 + j / fine) / segments;
      const tangent = tan(t);
      o0 = o0.map(offset => turnLike(offset, prev, tangent));
      prev = tangent;
    }
    const t = segment / segments;
    const sc = 1 + (rB / rA - 1) * t;
    const center = bez(t);
    rings.push(o0.map(offset => verts.push(add3(center, mul3(offset, sc))) - 1));
  }
  const faces = cage.faces.filter((_, i) => i !== fa && i !== fb);
  const loops = [[...faceA], ...rings];
  for (let loopIndex = 0; loopIndex + 1 < loops.length; loopIndex++) {
    const L1 = loops[loopIndex];
    const L2 = loops[loopIndex + 1];
    for (let i = 0; i < 4; i++) {
      faces.push([L1[i], L1[(i + 1) % 4], L2[(i + 1) % 4], L2[i]]);
    }
  }
  const out = bridgeLoops({ verts, faces }, rings[rings.length - 1], [...faceB]);

  return out && windingAgrees(out) ? out : null;
}

/** A run of open-border edges, as its points in order (a hole's rim: closed). */
export interface Chain {
  verts: number[];
  closed: boolean;
}

/**
 * The chosen border edges (keys from cageEdgeKey) grouped into runs: each run
 * is a closed rim, or an open string of edges end to end.
 */
export function borderChains(cage: Cage, chosen: Set<string>): Chain[] {
  const edges = boundaryEdges(cage).filter(([a, b]) => chosen.has(ekey(a, b)));
  const nb = new Map<number, number[]>();
  for (const [a, b] of edges) {
    nb.set(a, [...(nb.get(a) ?? []), b]);
    nb.set(b, [...(nb.get(b) ?? []), a]);
  }
  const used = new Set<string>();
  const out: Chain[] = [];
  const walk = (start: number): Chain => {
    const verts = [start];
    let vertex = start;
    for (;;) {
      const next = (nb.get(vertex) ?? []).find(neighbour => !used.has(ekey(vertex, neighbour)));
      if (next === undefined) {
        return { verts, closed: false };
      }
      used.add(ekey(vertex, next));
      if (next === start) {
        return { verts, closed: true };
      }
      verts.push(next);
      vertex = next;
    }
  };
  // Open runs start at an end (a point with one chosen edge); what's left are rims.
  for (const [vertex, ws] of nb) {
    if (ws.length === 1 && ws.some(neighbour => !used.has(ekey(vertex, neighbour)))) {
      out.push(walk(vertex));
    }
  }
  for (const [a, b] of edges) {
    if (!used.has(ekey(a, b))) {
      out.push(walk(a));
    }
  }

  return out.filter(chain => chain.verts.length >= 2);
}

/** Two cages as one (the second's points renumbered after the first's). */
export function joinCages(a: Cage, b: Cage): { cage: Cage; offset: number } {
  const count = a.verts.length;

  return { cage: { verts: [...a.verts, ...b.verts], faces: [...a.faces, ...b.faces.map(face => face.map(vertex => vertex + count) as Cage['faces'][number])] }, offset: count };
}

/**
 * Connect two runs of border edges with a strip of quads (two edges → one
 * quad, like making a face from four points; two rims → a tube). Both runs
 * need the same number of edges; the second is turned and shifted so the
 * quads line up with the shape of the edges (no twist). The new faces are
 * wound to match the faces along the first run. Returns null if the runs
 * don't fit (different counts, sharing points, too short).
 */
export function bridgeChains(cage: Cage, chainA: Chain, chainB: Chain): Cage | null {
  if (chainA.closed !== chainB.closed) {
    return null;
  }
  const edgesOf = (chain: Chain) => (chain.closed ? chain.verts.length : chain.verts.length - 1);
  const edges = edgesOf(chainA);
  if (edges < 1 || edgesOf(chainB) !== edges) {
    return null;
  }
  if (chainA.verts.some(vertex => chainB.verts.includes(vertex))) {
    return null;
  }
  const vertexAt = (vertex: number) => cage.verts[vertex];
  const distance = (vertexA: number, q: number) => Math.hypot(vertexAt(vertexA)[0] - vertexAt(q)[0], vertexAt(vertexA)[1] - vertexAt(q)[1], vertexAt(vertexA)[2] - vertexAt(q)[2]);
  const count = chainA.verts.length;
  // Best match of chainB to chainA: either direction, and (rims) any starting point.
  let best: number[] = chainB.verts;
  let bestCost = Infinity;
  for (const dir of [chainB.verts, [...chainB.verts].reverse()]) {
    for (let shift = 0; shift < (chainA.closed ? count : 1); shift++) {
      const cand = chainA.closed ? dir.map((_, i) => dir[(i + shift) % count]) : dir;
      let cost = 0;
      for (let i = 0; i < count; i++) {
        cost += distance(chainA.verts[i], cand[i]);
      }
      if (cost < bestCost) {
        ((bestCost = cost), (best = cand));
      }
    }
  }
  const quads: Cage['faces'] = [];
  for (let i = 0; i < edges; i++) {
    const j = (i + 1) % count;
    quads.push([chainA.verts[i], chainA.verts[j], best[j], best[i]]);
  }
  // Winding: each border edge on chainA must run the other way round in its new
  // face than in the face it already has.
  const dirOf = new Map<string, [number, number]>();
  for (const face of cage.faces) {
    for (let corner = 0; corner < 4; corner++) {
      dirOf.set(ekey(face[corner], face[(corner + 1) % 4]), [face[corner], face[(corner + 1) % 4]]);
    }
  }
  const [a0, a1] = [chainA.verts[0], chainA.verts[1 % count]];
  const had = dirOf.get(ekey(a0, a1));
  const flip = !!had && had[0] === a0 && had[1] === a1;

  return { verts: cage.verts, faces: [...cage.faces, ...quads.map(q => (flip ? ([q[3], q[2], q[1], q[0]] as Cage['faces'][number]) : q))] };
}

/** Do the faces along run B now meet their new neighbours wound the right way round? */
export function windingAgrees(cage: Cage): boolean {
  const seen = new Set<string>();
  for (const face of cage.faces) {
    for (let corner = 0; corner < 4; corner++) {
      const key = `${face[corner]}>${face[(corner + 1) % 4]}`;
      if (seen.has(key)) {
        return false;
      } // the same edge, the same way, twice
      seen.add(key);
    }
  }

  return true;
}

/** Turn the given faces inside out (their points the other way round). */
export function flipFaces(cage: Cage, which: (i: number) => boolean): Cage {
  return { verts: cage.verts, faces: cage.faces.map((face, i) => (which(i) ? ([face[0], face[3], face[2], face[1]] as Cage['faces'][number]) : face)) };
}

/**
 * Where each open-border cage edge runs on the smooth surface: the point
 * halfway along it (to match a picked edge of the finished body to its cage edge).
 */
export function borderEdgeMids(cage: Cage): { e: [number, number]; at: Vec3 }[] {
  const subdivided = subdivide(cage, 3);
  const limit = limitPoints(subdivided);
  const half = subdivided.n / 2;
  const out: { e: [number, number]; at: Vec3 }[] = [];
  const border = new Set(boundaryEdges(cage).map(([a, b]) => ekey(a, b)));
  cage.faces.forEach((face, fi) => {
    const grid = subdivided.grids[fi];
    const sides: [number, number, number][] = [
      [face[0], face[1], grid[half][0]],
      [face[1], face[2], grid[subdivided.n][half]],
      [face[2], face[3], grid[half][subdivided.n]],
      [face[3], face[0], grid[0][half]]
    ];
    for (const [a, b, mid] of sides) {
      if (border.has(ekey(a, b))) {
        out.push({ e: [a, b], at: limit[mid] });
      }
    }
  });

  return out;
}

export { ekey as cageEdgeKey };

// ------------------------------------------------------ self-crossing

/**
 * Does the smooth surface pass through itself (a cage point pulled through the
 * body, a face folded over)? Checked on a lighter subdivision: triangles that
 * share no point must not cross. Returns the crossing spots (empty: clean).
 */
export function selfCrossings(cage: Cage, levels = 2, most = 24): Vec3[] {
  if (!cage.faces.length) {
    return [];
  }
  // Run every few frames while a point is dragged: the weights are kept per
  // layout, and the triangles bucketed with number keys (it took ~11 ms).
  const plan = cachedPlan(cage, levels);
  const values = applyPlan(plan, cage.verts);
  const points: Vec3[] = [];
  for (let i = 0; i < values.length; i += 3) {
    points.push([values[i], values[i + 1], values[i + 2]]);
  }
  const tris: [number, number, number][] = [];
  for (const grid of plan.grids) {
    for (let i = 0; i < plan.n; i++) {
      for (let j = 0; j < plan.n; j++) {
        const a = grid[i][j];
        const b = grid[i + 1][j];
        const cornerC = grid[i + 1][j + 1];
        const cornerD = grid[i][j + 1];
        tris.push([a, b, cornerC], [a, cornerC, cornerD]);
      }
    }
  }
  // Bucket triangles by the cells their boxes touch.
  let edge = 0;
  for (const t of tris) {
    edge += dist(points[t[0]], points[t[1]]);
  }
  const cell = Math.max(1e-9, (edge / tris.length) * 2);
  const triangleCount = tris.length;
  const lo = new Float64Array(triangleCount * 3);
  const hi = new Float64Array(triangleCount * 3);
  for (let t = 0; t < triangleCount; t++) {
    for (let corner = 0; corner < 3; corner++) {
      const x = points[tris[t][0]][corner], y = points[tris[t][1]][corner], z = points[tris[t][2]][corner];
      lo[3 * t + corner] = Math.min(x, y, z);
      hi[3 * t + corner] = Math.max(x, y, z);
    }
  }
  const grid = new Map<number, number[]>();
  const big: number[] = [];
  // Cell coordinates packed into one number.
  const span = 1 << 16; // ±65536 cells a side: the packed key stays under 2^51, exact in a double
  const key = (x: number, y: number, z: number) => ((x + span) * 2 * span + (y + span)) * 2 * span + (z + span);
  for (let t = 0; t < triangleCount; t++) {
    const ax = Math.floor(lo[3 * t] / cell), ay = Math.floor(lo[3 * t + 1] / cell), az = Math.floor(lo[3 * t + 2] / cell);
    const bx = Math.floor(hi[3 * t] / cell), by = Math.floor(hi[3 * t + 1] / cell), bz = Math.floor(hi[3 * t + 2] / cell);
    // A huge triangle (a point pulled far away) would fill many cells: tested against all.
    if ((bx - ax + 1) * (by - ay + 1) * (bz - az + 1) > 4096) {
      big.push(t);
      continue;
    }
    for (let x = ax; x <= bx; x++) {
      for (let y = ay; y <= by; y++) {
        for (let z = az; z <= bz; z++) {
          const cellKey = key(x, y, z);
          const list = grid.get(cellKey);
          if (list) {
            list.push(t);
          } else {
            grid.set(cellKey, [t]);
          }
        }
      }
    }
  }
  const tested = new Set<number>();
  const out: Vec3[] = [];
  const pair = (i: number, j: number) => {
    if (i === j) {
      return;
    }
    const pairKey = i < j ? i * triangleCount + j : j * triangleCount + i;
    if (tested.has(pairKey)) {
      return;
    }
    tested.add(pairKey);
    for (let q = 0; q < 3; q++) {
      if (hi[3 * i + q] < lo[3 * j + q] || hi[3 * j + q] < lo[3 * i + q]) {
        return;
      }
    }
    const triangleA = tris[i];
    const triangleB = tris[j];
    if (triangleA[0] === triangleB[0] || triangleA[0] === triangleB[1] || triangleA[0] === triangleB[2] || triangleA[1] === triangleB[0] || triangleA[1] === triangleB[1] || triangleA[1] === triangleB[2] || triangleA[2] === triangleB[0] || triangleA[2] === triangleB[1] || triangleA[2] === triangleB[2]) {
      return;
    }
    const hit = trisCross([points[triangleA[0]], points[triangleA[1]], points[triangleA[2]]], [points[triangleB[0]], points[triangleB[1]], points[triangleB[2]]]);
    if (hit) {
      out.push(hit);
    }
  };
  for (const list of grid.values()) {
    for (let a = 0; a < list.length && out.length < most; a++) {
      for (let b = a + 1; b < list.length; b++) {
        pair(list[a], list[b]);
      }
    }
  }
  for (const i of big) {
    for (let j = 0; j < triangleCount && out.length < most; j++) {
      pair(i, j);
    }
  }

  return out;
}

/** A few recent plans (the cage being dragged keeps its layout). */
const planCache = new Map<string, SubdivPlan>();
export function cachedPlan(cage: Cage, levels: number): SubdivPlan {
  const key = `${levels}#${layoutKey(cage)}`;
  let subdivPlan = planCache.get(key);
  if (!subdivPlan) {
    subdivPlan = subdivisionPlan(cage, levels);
    if (planCache.size >= 6) {
      planCache.delete(planCache.keys().next().value!);
    }
    planCache.set(key, subdivPlan);
  }

  return subdivPlan;
}

const dist = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** Where two triangles cross (an edge of one through the inside of the other), or null. */
function trisCross(triangleA: [Vec3, Vec3, Vec3], triangleB: [Vec3, Vec3, Vec3]): Vec3 | null {
  for (const [first, second] of [[triangleA, triangleB], [triangleB, triangleA]] as const) {
    for (let edge = 0; edge < 3; edge++) {
      const hit = segTri(first[edge], first[(edge + 1) % 3], second);
      if (hit) {
        return hit;
      }
    }
  }

  return null;
}

/** Segment pq through the inside of triangle t (Möller–Trumbore, strictly inside). */
function segTri(start: Vec3, q: Vec3, t: [Vec3, Vec3, Vec3]): Vec3 | null {
  const e1 = sub3(t[1], t[0]);
  const e2 = sub3(t[2], t[0]);
  const direction = sub3(q, start);
  const cross = cross3(direction, e2);
  const a = dot3(e1, cross);
  const scaleA = Math.hypot(...e1) * Math.hypot(...e2) * Math.hypot(...direction);
  if (Math.abs(a) < 1e-12 * scaleA) {
    return null;
  }
  const inverse = 1 / a;
  const offset = sub3(start, t[0]);
  const baryU = inverse * dot3(offset, cross);
  const eps = 1e-6;
  if (baryU < eps || baryU > 1 - eps) {
    return null;
  }
  const qv = cross3(offset, e1);
  const baryV = inverse * dot3(direction, qv);
  if (baryV < eps || baryU + baryV > 1 - eps) {
    return null;
  }
  const along = inverse * dot3(e2, qv);
  if (along < eps || along > 1 - eps) {
    return null;
  }

  return [start[0] + direction[0] * along, start[1] + direction[1] * along, start[2] + direction[2] * along];
}

const sub3 = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot3 = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross3 = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

// ------------------------------------------------- adding cage detail

/**
 * Take an edge loop out: the loop of edges through a-b (straight on through
 * each point four edges meet at, round the shape or from border to border)
 * goes, and the two faces either side of each of its edges become one. The
 * points of the loop go with it. Null where the loop cannot be followed (a
 * point on it where three or five edges meet), or where an edge of it is on
 * the border.
 */
/**
 * The loop of edges through a-b: straight on through each point four edges
 * meet at, round the shape or from border to border. Null where it cannot be
 * followed (a point where three or five edges meet) - or, `lenient`, the part
 * of it that can.
 */
export function edgeLoopOf(cage: Cage, a: number, b: number, lenient = false): [number, number][] | null {
  const efs = edgeFaceMap(cage);
  if (!efs.has(ekey(a, b))) {
    return null;
  }
  const around = new Map<number, number[]>();
  for (const key of efs.keys()) {
    const [vertexA, q] = key.split(',').map(Number);
    around.set(vertexA, [...(around.get(vertexA) ?? []), q]);
    around.set(q, [...(around.get(q) ?? []), vertexA]);
  }
  // From `from` on through `at`: the edge at `at` that shares no face with the one arrived by.
  const onward = (from: number, at: number): number | null | undefined => {
    const ns = around.get(at) ?? [];
    const border = ns.filter(neighbour => efs.get(ekey(at, neighbour))!.length === 1);
    // (At the border the loop ends: its last point has the two border edges and the one arrived by.)
    if (border.length) {
      return ns.length === 3 && border.length === 2 ? null : undefined;
    }
    if (ns.length !== 4) {
      return undefined;
    }
    const mine = new Set(efs.get(ekey(from, at)));
    const next = ns.filter(neighbour => neighbour !== from && !efs.get(ekey(at, neighbour))!.some(face => mine.has(face)));

    return next.length === 1 ? next[0] : undefined;
  };
  const loop: [number, number][] = [[a, b]];
  const seen = new Set([ekey(a, b)]);
  let closed = false;
  for (const dir of [0, 1]) {
    let [from, at] = dir ? [b, a] : [a, b];
    for (let guard = 0; guard < cage.verts.length + 2; guard++) {
      const next = onward(from, at);
      if (next === undefined) {
        if (lenient) {
          break;
        }

        return null;
      }
      if (next === null) {
        break;
      }
      if (seen.has(ekey(at, next))) {
        closed = true;
        break;
      }
      seen.add(ekey(at, next));
      loop.push([at, next]);
      [from, at] = [at, next];
    }
    if (closed) {
      break;
    }
  }

  return loop;
}

export function removeEdgeLoop(cage: Cage, a: number, b: number): Cage | null {
  const efs = edgeFaceMap(cage);
  const loop = edgeLoopOf(cage, a, b);
  if (!loop) {
    return null;
  }
  const gone = new Set<number>();
  const made: Quad[] = [];
  for (const [vertexA, q] of loop) {
    const fs = efs.get(ekey(vertexA, q))!;
    if (fs.length !== 2) {
      return null;
    }
    // The face that winds vertexA then q, and the one that winds q then vertexA: p-q-c-d and q-p-e-f.
    const turn = (quad: Quad, x: number, y: number): Quad | null => {
      for (let corner = 0; corner < 4; corner++) {
        if (quad[corner] === x && quad[(corner + 1) % 4] === y) {
          return [quad[corner], quad[(corner + 1) % 4], quad[(corner + 2) % 4], quad[(corner + 3) % 4]];
        }
      }

      return null;
    };
    const quadA = turn(cage.faces[fs[0]], vertexA, q) ?? turn(cage.faces[fs[1]], vertexA, q);
    const quadB = turn(cage.faces[fs[0]], q, vertexA) ?? turn(cage.faces[fs[1]], q, vertexA);
    if (!quadA || !quadB) {
      return null;
    }
    made.push([quadA[3], quadB[2], quadB[3], quadA[2]]);
    gone.add(fs[0]).add(fs[1]);
  }
  // (A face on both sides of two loop edges - a loop one face wide round a corner - cannot be merged twice.)
  if (gone.size !== loop.length * 2) {
    return null;
  }
  // Sharp edges the loop crossed: each was cut in two at a point of the loop - with that point gone, it is one again.
  const onLoop = new Set(loop.flat());
  const creases: [number, number][] = [];
  const cutAt = new Map<number, number[]>();
  for (const [vertexA, q] of cage.creases ?? []) {
    if (onLoop.has(vertexA) && onLoop.has(q)) {
      continue;
    }
    if (onLoop.has(vertexA)) {
      cutAt.set(vertexA, [...(cutAt.get(vertexA) ?? []), q]);
    } else if (onLoop.has(q)) {
      cutAt.set(q, [...(cutAt.get(q) ?? []), vertexA]);
    } else {
      creases.push([vertexA, q]);
    }
  }
  for (const ends of cutAt.values()) {
    if (ends.length === 2) {
      creases.push([ends[0], ends[1]]);
    }
  }
  const out = compact({ verts: cage.verts, faces: [...cage.faces.filter((_, i) => !gone.has(i)), ...made], creases });

  return out.faces.length ? out : null;
}

type Quad = Cage['faces'][number];

/** Faces using each edge. */
function edgeFaceMap(cage: Cage): Map<string, number[]> {
  const map = new Map<string, number[]>();
  cage.faces.forEach((face, i) => {
    for (let corner = 0; corner < 4; corner++) {
      const key = ekey(face[corner], face[(corner + 1) % 4]);
      const list = map.get(key);
      if (list) {
        list.push(i);
      } else {
        map.set(key, [i]);
      }
    }
  });

  return map;
}

/**
 * Add an edge loop: every face in the ring of quads that crosses edge a–b is
 * cut in two, with a new point on each edge it crosses (at `t` along it, from
 * the side `a` is on). The loop runs round the shape, or from border to border.
 * Returns null where the ring can't be followed cleanly (it comes back across
 * a face it already cut the other way).
 */
export function insertEdgeLoop(cage: Cage, a: number, b: number, t = 0.5): Cage | null {
  const efs = edgeFaceMap(cage);
  if (!efs.has(ekey(a, b))) {
    return null;
  }
  // Walk across faces: each step enters a face over one edge and leaves over the opposite one.
  // Crossed edges, each as [vertex on the a side, vertex on the b side].
  type Step = { face: number; enter: [number, number]; leave: [number, number] };
  const walk = (from: [number, number], face: number): { steps: Step[]; closed: boolean } | null => {
    const steps: Step[] = [];
    const seen = new Set<number>();
    let edge = from;
    let currentFace = face;
    for (;;) {
      if (seen.has(currentFace)) {
        return null;
      }
      seen.add(currentFace);
      const q = cage.faces[currentFace];
      const ia = q.indexOf(edge[0]);
      const ib = q.indexOf(edge[1]);
      if (ia < 0 || ib < 0) {
        return null;
      }
      // The opposite edge: a's neighbour away from b, and b's away from a.
      const na = (ia + 2) % 4 === ib ? -1 : ib === (ia + 1) % 4 ? (ia + 3) % 4 : (ia + 1) % 4;
      const nb = ib === (ia + 1) % 4 ? (ib + 1) % 4 : (ib + 3) % 4;
      if (na < 0) {
        return null;
      }
      const leave: [number, number] = [q[na], q[nb]];
      steps.push({ face: currentFace, enter: edge, leave });
      const next = (efs.get(ekey(leave[0], leave[1])) ?? []).filter(x => x !== currentFace);
      if (!next.length) {
        return { steps, closed: false };
      }
      if (next[0] === face) {
        return { steps, closed: true };
      }
      edge = leave;
      currentFace = next[0];
    }
  };
  const [f0, f1] = efs.get(ekey(a, b))!;
  const fwd = walk([a, b], f0);
  if (!fwd) {
    return null;
  }
  let steps = fwd.steps;
  if (!fwd.closed && f1 !== undefined) {
    // From border to border: also walk the other way from the picked edge.
    const back = walk([a, b], f1);
    if (!back || back.closed) {
      return null;
    }
    const used = new Set(steps.map(step => step.face));
    if (back.steps.some(step => used.has(step.face))) {
      return null;
    }
    steps = [...back.steps.reverse(), ...steps];
  }
  const verts = [...cage.verts];
  const mids = new Map<string, number>();
  const mid = ([vertexA, q]: [number, number]): number => {
    const key = ekey(vertexA, q);
    const had = mids.get(key);
    if (had !== undefined) {
      return had;
    }
    const vertex = cage.verts[vertexA];
    const otherPoint = cage.verts[q];
    const i = verts.push([vertex[0] + (otherPoint[0] - vertex[0]) * t, vertex[1] + (otherPoint[1] - vertex[1]) * t, vertex[2] + (otherPoint[2] - vertex[2]) * t]) - 1;
    mids.set(key, i);

    return i;
  };
  const cut = new Map<number, Quad[]>();
  for (const step of steps) {
    const q = cage.faces[step.face];
    // Turn the face so its first edge is the one entered by.
    let rotation = 0;
    while (!(new Set([q[rotation], q[(rotation + 1) % 4]]).has(step.enter[0]) && new Set([q[rotation], q[(rotation + 1) % 4]]).has(step.enter[1]))) {
      rotation++;
    }
    const rotated: Quad = [q[rotation], q[(rotation + 1) % 4], q[(rotation + 2) % 4], q[(rotation + 3) % 4]];
    const m1 = mid(step.enter);
    const m2 = mid(step.leave);
    cut.set(step.face, [
      [rotated[0], m1, m2, rotated[3]],
      [m1, rotated[1], rotated[2], m2]
    ]);
  }
  const faces: Quad[] = cage.faces.flatMap((face, i) => cut.get(i) ?? [face]);

  return { verts, faces };
}

/** Outward normal of a face (from its winding; the cage's faces face out). */
function faceNormal(cage: Cage, quad: Quad): Vec3 {
  const [first, q, third, fourth] = quad.map(i => cage.verts[i]);
  const diagonalA = sub3(third, first);
  const diagonalB = sub3(fourth, q);
  const normal = cross3(diagonalA, diagonalB);
  const length = Math.hypot(...normal) || 1;

  return [normal[0] / length, normal[1] / length, normal[2] / length];
}

/**
 * Extrude faces: the picked faces lift off by `dist` along their normals (a
 * patch of them moves together) and a wall of new faces joins them to where
 * they were. Returns the new cage and the indices of the moved faces.
 */
export function extrudeFaces(cage: Cage, faces: number[], dist: number): { cage: Cage; faces: number[] } | null {
  const sel = new Set(faces.filter(i => i >= 0 && i < cage.faces.length));
  if (!sel.size) {
    return null;
  }
  // Normals averaged at each point of the patch.
  const nAt = new Map<number, Vec3>();
  for (const i of sel) {
    const normal = faceNormal(cage, cage.faces[i]);
    for (const vertex of cage.faces[i]) {
      nAt.set(vertex, add3(nAt.get(vertex) ?? [0, 0, 0], normal));
    }
  }
  const verts = [...cage.verts];
  const copy = new Map<number, number>();
  for (const [vertex, normal] of nAt) {
    const length = Math.hypot(...normal) || 1;
    copy.set(vertex, verts.push(add3(cage.verts[vertex], mul3(normal, dist / length))) - 1);
  }
  // Edges on the rim of the patch (one picked face uses them), as that face winds them.
  const count = new Map<string, number>();
  for (const i of sel) {
    for (let corner = 0; corner < 4; corner++) {
      count.set(ekey(cage.faces[i][corner], cage.faces[i][(corner + 1) % 4]), (count.get(ekey(cage.faces[i][corner], cage.faces[i][(corner + 1) % 4])) ?? 0) + 1);
    }
  }
  const walls: Quad[] = [];
  for (const i of sel) {
    const face = cage.faces[i];
    for (let corner = 0; corner < 4; corner++) {
      const a = face[corner];
      const b = face[(corner + 1) % 4];
      if (count.get(ekey(a, b)) === 1) {
        walls.push([a, b, copy.get(b)!, copy.get(a)!]);
      }
    }
  }
  const moved = cage.faces.map((face, i) => (sel.has(i) ? (face.map(vertex => copy.get(vertex)!) as Quad) : face));
  // A border of an open sheet inside the patch: its old points are left with nothing - drop them.
  const out = compact({ verts, faces: [...moved, ...walls] });

  // compact keeps faces in order: the moved ones keep their indices.
  return { cage: out, faces: [...sel] };
}

/**
 * Inset faces: inside each picked face (or patch of them) a smaller copy, `f`
 * of the way in towards its middle, ringed by new faces - a place to pull out
 * a detail without dragging the rest. Returns the cage and the inner faces.
 */
export function insetFaces(cage: Cage, faces: number[], fraction = 0.3): { cage: Cage; faces: number[] } | null {
  const ex = extrudeFaces(cage, faces, 0);
  if (!ex) {
    return null;
  }
  const extruded = ex.cage;
  // Each new inner point moves towards the middle of the picked faces it belongs to.
  const centre = new Map<number, { s: Vec3; n: number }>();
  for (const i of ex.faces) {
    const q = extruded.faces[i];
    const midpoint = mul3(q.reduce((sum, vertex) => add3(sum, extruded.verts[vertex]), [0, 0, 0] as Vec3), 0.25);
    for (const vertex of q) {
      const e = centre.get(vertex) ?? { s: [0, 0, 0] as Vec3, n: 0 };
      centre.set(vertex, { s: add3(e.s, midpoint), n: e.n + 1 });
    }
  }
  const verts = extruded.verts.map((vertex, vertexIndex) => {
    const e = centre.get(vertexIndex);
    if (!e) {
      return vertex;
    }
    const midpoint = mul3(e.s, 1 / e.n);

    return add3(vertex, mul3(sub3(midpoint, vertex), fraction));
  });

  return { cage: { verts, faces: extruded.faces }, faces: ex.faces };
}

/**
 * Extend a surface from points on its open border: every border edge with
 * both ends picked gets a new face beyond it - outwards, in the surface's own
 * direction there, as long as the edges are. Returns the new outer points
 * (picked next, to drag on), or null when no border edge has both ends picked.
 */
export function extendBorder(cage: Cage, picked: number[]): { cage: Cage; verts: number[] } | null {
  const sel = new Set(picked);
  const border = boundaryEdges(cage).filter(([a, b]) => sel.has(a) && sel.has(b));
  if (!border.length) {
    return null;
  }
  // The face each border edge belongs to (it runs a→b in that face).
  const faceOf = (a: number, b: number) => cage.faces.find(face => face.some((vertex, corner) => vertex === a && face[(corner + 1) % 4] === b));
  const centroid = (quad: Quad) => mul3(quad.reduce((sum, i) => add3(sum, cage.verts[i]), [0, 0, 0] as Vec3), 0.25);
  // Outward, in the surface (away from the face, square to the edge), summed per point.
  const out = new Map<number, Vec3>();
  let total = 0;
  for (const [a, b] of border) {
    const face = faceOf(a, b);
    if (!face) {
      continue;
    }
    const vertexA = cage.verts[a];
    const vertexB = cage.verts[b];
    const e = sub3(vertexB, vertexA);
    const el = Math.hypot(...e) || 1;
    total += el;
    const mid = mul3(add3(vertexA, vertexB), 0.5);
    let direction = sub3(mid, centroid(face));
    direction = sub3(direction, mul3(e, dot3(direction, e) / (el * el)));
    const dl = Math.hypot(...direction) || 1;
    direction = mul3(direction, 1 / dl);
    for (const vertex of [a, b]) {
      out.set(vertex, add3(out.get(vertex) ?? [0, 0, 0], direction));
    }
  }
  const len = total / border.length;
  const verts = [...cage.verts];
  const copy = new Map<number, number>();
  for (const [vertex, direction] of out) {
    const length = Math.hypot(...direction) || 1;
    copy.set(vertex, verts.length);
    verts.push(add3(cage.verts[vertex], mul3(direction, len / length)));
  }
  // Each new face runs the border edge the other way (so it faces like its neighbour).
  const faces = [...cage.faces];
  for (const [a, b] of border) {
    faces.push([b, a, copy.get(a)!, copy.get(b)!]);
  }

  return { cage: { verts, faces }, verts: [...copy.values()] };
}
