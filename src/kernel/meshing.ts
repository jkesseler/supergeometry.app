// A body as triangles and lines: for the view, for a printed file, and for the
// checks that go by a mesh.

import { getOC, type Face, type Shape3D } from 'replicad';
import { Earcut } from 'three/src/extras/Earcut.js';

/** A body's faces as triangles. `faceGroups[i]` is where face i's corners are in `triangles` (the body's faces in their own order). */
export interface FaceMesh {
  vertices: Float32Array;
  normals: Float32Array;
  triangles: Uint32Array;
  faceGroups: { start: number; count: number }[];
}

/** A body's edges as lines. `edgeGroups[i]` is where edge i's points are in `lines` (the body's edges in their own order). */
export interface EdgeLines {
  lines: Float32Array;
  edgeGroups: { start: number; count: number }[];
}

/**
 * Faces meshed in one go. OpenCascade's mesher keeps its working notes on every
 * face and edge of what it is given until all of it is done, tens of kilobytes
 * each: a body of 4 500 faces took the engine's memory from 100 MB to 1.3 GB
 * (and memory once taken is never given back), one of 40 000 - a scanned part
 * sewn into a solid - to the 4 GB a browser allows, where the engine breaks.
 * The same faces a few hundred at a time are the same triangles in the same
 * order, a little sooner, and the memory doesn't move.
 */
const LOT = 300;

/**
 * Outlines (the face's own, and one for each hole) from which a flat face is
 * cut into triangles here instead of by OpenCascade, whose mesher takes time
 * and memory by the square of a face's holes: a plate's two faces with 100
 * holes 0.3 s, with 400 holes 5 s and 700 MB - and again for every print file
 * and every check that wants a point on such a face. Here: a few milliseconds.
 */
const LOOPS = 30;

 

/** The shapes whose faces are meshed, and how finely (so its edge lines needn't mesh it again). */
const meshedAt = new WeakMap<object, string>();
/** The edge lines of a body some of whose faces were cut into triangles here: worked out with them. */
const linesReady = new WeakMap<object, { key: string; lines: EdgeLines }>();

/** One explorer for each kernel, pointed at shape after shape (each one made stays in the kernel for good: release.ts). */
const explorers = new WeakMap<object, { ex: any; nothing: any }>();
function explorer(): { ex: any; nothing: any } {
  const oc = getOC() as any;
  let e = explorers.get(oc);
  if (!e) {
    explorers.set(oc, (e = { ex: new oc.TopExp_Explorer(), nothing: new oc.TopoDS_Shape() }));
  }

  return e;
}

/** How many closed outlines a face has (its own, and one for each hole). */
function loopCount(face: { wrapped: unknown }): number {
  const oc = getOC() as any;
  const { ex, nothing } = explorer();
  const ANY = oc.TopAbs_ShapeEnum.TopAbs_SHAPE;
  let count = 0;
  for (ex.Init(face.wrapped, oc.TopAbs_ShapeEnum.TopAbs_WIRE, ANY); ex.More(); ex.Next()) {
    count++;
  }
  ex.Init(nothing, ANY, ANY);

  return count;
}

/** Is this a flat face with so many holes that it is cut into triangles here? */
const manyHoled = (face: Face): boolean => loopCount(face) >= LOOPS && face.geomType === 'PLANE';

/** A shape's edges, each once, in the order met - the kernel's own handles: `done()` gives them back. */
function edgesOf(wrapped: unknown): { edges: any[]; at: (edge: any) => number; done: () => void } {
  const oc = getOC() as any;
  const { ex, nothing } = explorer();
  const ANY = oc.TopAbs_ShapeEnum.TopAbs_SHAPE;
  const buckets = new Map<number, number[]>();
  const edges: any[] = [];
  const hash = (x: any): number => oc.ReplicadShapeHasher.HashCode(x, 2147483647);
  for (ex.Init(wrapped, oc.TopAbs_ShapeEnum.TopAbs_EDGE, ANY); ex.More(); ex.Next()) {
    const item = ex.Current();
    const hashCode = hash(item);
    const b = buckets.get(hashCode);
    if (b?.some(i => edges[i].IsSame(item))) {
      item.delete();
      continue;
    }
    if (b) {
      b.push(edges.length);
    } else {
      buckets.set(hashCode, [edges.length]);
    }
    edges.push(item);
  }
  ex.Init(nothing, ANY, ANY);

  return {
    edges,
    at: edge => buckets.get(hash(edge))?.find(i => edges[i].IsSame(edge)) ?? -1,
    done: () => edges.forEach(e => e.delete())
  };
}

/** The lines of a shape's edges as the kernel has them (in the order of the shape's edges). */
function readLines(wrapped: unknown, tolerance: number, angularTolerance: number): EdgeLines {
  const raw = (getOC() as any).ReplicadEdgeMeshExtractor.extract(wrapped, tolerance, angularTolerance);
  try {
    const groups = ints(raw.getEdgeGroupsPtr(), raw.getEdgeGroupsSize());
    const edgeGroups: EdgeLines['edgeGroups'] = [];
    for (let i = 0; i < groups.length; i += 3) {
      edgeGroups.push({ start: groups[i], count: groups[i + 1] });
    }

    return { lines: floats(raw.getLinesPtr(), raw.getLinesSize()), edgeGroups };
  } finally {
    raw.delete();
  }
}

/**
 * Edge lines joined end to end into closed outlines (each a run of x, y, z;
 * its last point not its first again). Null: they don't close up.
 */
function outlines(lines: Float32Array[], grain: number): Float32Array[] | null {
  const key = (values: Float32Array, offset: number) => `${Math.round(values[offset] / grain)},${Math.round(values[offset + 1] / grain)},${Math.round(values[offset + 2] / grain)}`;
  const out: Float32Array[] = [];
  // (A point given twice running - the kernel's lines have some, where a round face's seam is - is one point.)
  const add = (pts: ArrayLike<number>) => {
    const once: number[] = [];
    const apart = (offset: number, j: number) => Math.hypot(pts[offset] - once[j], pts[offset + 1] - once[j + 1], pts[offset + 2] - once[j + 2]) > grain;
    for (let pointIndex = 0; pointIndex < pts.length; pointIndex += 3) {
      if (!once.length || apart(pointIndex, once.length - 3)) {
        once.push(pts[pointIndex], pts[pointIndex + 1], pts[pointIndex + 2]);
      }
    }
    const count = once.length;
    if (count >= 6 && Math.hypot(once[count - 3] - once[0], once[count - 2] - once[1], once[count - 1] - once[2]) <= grain) {
      once.length = count - 3;
    }
    if (once.length >= 9) {
      out.push(Float32Array.from(once));
    }
  };
  const ends = new Map<string, number[]>();
  const open: number[] = [];
  lines.forEach((line, i) => {
    if (line.length < 6) {
      return;
    }
    const [a, b] = [key(line, 0), key(line, line.length - 3)];
    if (a === b) {
      // (An edge that closes on itself - a circle - is an outline; one that only goes there and back is nothing.)
      add(line);

      return;
    }
    open.push(i);
    for (const end of [a, b]) {
      ends.set(end, [...(ends.get(end) ?? []), i]);
    }
  });
  const used = new Set<number>();
  for (const first of open) {
    if (used.has(first)) {
      continue;
    }
    used.add(first);
    const pts: number[] = Array.from(lines[first]);
    const start = key(lines[first], 0);
    let tip = key(lines[first], lines[first].length - 3);
    for (let guard = 0; tip !== start; guard++) {
      const next = ends.get(tip)?.find(i => !used.has(i));
      if (next === undefined || guard > open.length) {
        return null;
      }
      used.add(next);
      const line = lines[next];
      if (key(line, 0) === tip) {
        for (let index = 3; index < line.length; index++) {
          pts.push(line[index]);
        }
        tip = key(line, line.length - 3);
      } else {
        for (let index = line.length - 6; index >= 0; index -= 3) {
          pts.push(line[index], line[index + 1], line[index + 2]);
        }
        tip = key(line, 0);
      }
    }
    add(pts);
  }

  return out;
}

/**
 * A flat face as triangles between the points of its outlines (no points of
 * its own: it meets its neighbours along the very points they have). Null
 * when it doesn't come out as the face's area.
 */
function flatTriangles(loops: Float32Array[], normal: [number, number, number]): FaceMesh | null {
  if (!loops.length) {
    return null;
  }
  const axis = normal;
  const length = Math.hypot(axis[0], axis[1], axis[2]);
  if (!(length > 0)) {
    return null;
  }
  // Two directions across the face (x, then y so that x, y, axis turn the usual way).
  const a = Math.abs(axis[0]) < 0.9 * length ? [1, 0, 0] : [0, 1, 0];
  let x = [a[1] * axis[2] - a[2] * axis[1], a[2] * axis[0] - a[0] * axis[2], a[0] * axis[1] - a[1] * axis[0]];
  const xl = Math.hypot(x[0], x[1], x[2]);
  x = x.map(value => value / xl);
  const y = [(axis[1] * x[2] - axis[2] * x[1]) / length, (axis[2] * x[0] - axis[0] * x[2]) / length, (axis[0] * x[1] - axis[1] * x[0]) / length];
  const flat = loops.map((loop) => {
    const q = new Float64Array((loop.length / 3) * 2);
    for (let index = 0, j = 0; index < loop.length; index += 3, j += 2) {
      q[j] = loop[index] * x[0] + loop[index + 1] * x[1] + loop[index + 2] * x[2];
      q[j + 1] = loop[index] * y[0] + loop[index + 1] * y[1] + loop[index + 2] * y[2];
    }

    return q;
  });
  const area = (q: Float64Array) => {
    let area = 0;
    for (let j = 0, count = q.length; j < count; j += 2) {
      area += q[j] * q[(j + 3) % count] - q[(j + 2) % count] * q[j + 1];
    }

    return area / 2;
  };
  const areas = flat.map(area);
  // The outline itself is the biggest; the others are its holes.
  let outer = 0;
  areas.forEach((area, i) => Math.abs(area) > Math.abs(areas[outer]) && (outer = i));
  const order = [outer, ...loops.map((_, i) => i).filter(i => i !== outer)];
  const count = order.reduce((total, i) => total + flat[i].length / 2, 0);
  const data = new Float64Array(count * 2);
  const vertices = new Float32Array(count * 3);
  const holes: number[] = [];
  let at = 0;
  for (const i of order) {
    if (i !== outer) {
      holes.push(at);
    }
    data.set(flat[i], at * 2);
    vertices.set(loops[i], at * 3);
    at += flat[i].length / 2;
  }
  // Earcut leaves out a point that lies on the straight line between its
  // neighbours (and its neighbours include the cuts it makes from hole to
  // hole): a row of square holes lost corners, and the face no longer met the
  // holes' walls at them. So no three points are in line for it - each is
  // moved a hair (for the cutting only) - and what that makes of points truly
  // in line, a triangle with no area, is taken out again below.
  let span = 1e-9;
  for (let j = 0; j < data.length; j++) {
    span = Math.max(span, Math.abs(data[j]));
  }
  const shaken = new Float64Array(data.length);
  for (let j = 0; j < data.length; j++) {
    shaken[j] = data[j] + span * 1e-9 * Math.sin(j * 12.9898 + 4.1414) * 0.5;
  }
  const cut = Earcut.triangulate(shaken as unknown as number[], holes, 2);
  if (cut.length < 3) {
    return null;
  }
  const twice = (indexP: number, q: number, indexR: number) => (data[2 * q] - data[2 * indexP]) * (data[2 * indexR + 1] - data[2 * indexP + 1]) - (data[2 * indexR] - data[2 * indexP]) * (data[2 * q + 1] - data[2 * indexP + 1]);
  const far2 = (indexP: number, q: number) => (data[2 * q] - data[2 * indexP]) ** 2 + (data[2 * q + 1] - data[2 * indexP + 1]) ** 2;
  // All turning the way the face looks (they all turn one way: as a whole, not
  // one by one - a triangle with next to no area can't say which way it turns).
  let tris: number[][] = [];
  let turn = 0;
  for (let offset = 0; offset < cut.length; offset += 3) {
    tris.push([cut[offset], cut[offset + 1], cut[offset + 2]]);
    turn += twice(cut[offset], cut[offset + 1], cut[offset + 2]);
  }
  if (turn < 0) {
    tris = tris.map(([indexP, q, indexR]) => [indexP, indexR, q]);
  }
  // No area: its third corner on its long side, to what a point's seven digits
  // can be out by, and well in from both its ends. (Not a long thin needle
  // between two holes far apart: that one has an area, small as it is.)
  const middle = (t: number[]): [number, number, number] | null => {
    let j = 0;
    for (let corner = 1; corner < 3; corner++) {
      if (far2(t[corner], t[(corner + 1) % 3]) > far2(t[j], t[(j + 1) % 3])) {
        j = corner;
      }
    }
    const [endU, endV, mid] = [t[j], t[(j + 1) % 3], t[(j + 2) % 3]];
    const long2 = far2(endU, endV);
    if (Math.abs(twice(endU, endV, mid)) > Math.sqrt(long2) * span * 4e-7) {
      return null;
    }

    return Math.min(far2(endU, mid), far2(endV, mid)) > long2 * 1e-6 ? [endU, endV, mid] : null;
  };
  // Such a triangle is a point lying on the long side of its neighbour: that
  // neighbour is cut in two at the point, and the flat one goes. (Points in a
  // row - the tops of a row of round holes - make a fan of flat triangles:
  // taken from the outside in, each next to a neighbour that has an area. Each
  // is dealt with once: what can't be put right this way stays as it is.)
  const dealt = new Set<string>();
  for (let pass = 0; pass < 4096; pass++) {
    const flatOnes: [number, [number, number, number]][] = [];
    tris.forEach((t, i) => {
      const center = middle(t);
      if (center && !dealt.has([...t].sort((x, y) => x - y).join())) {
        flatOnes.push([i, center]);
      }
    });
    if (!flatOnes.length) {
      break;
    }
    const side = new Map<number, number>();
    tris.forEach((t, i) => {
      for (let j = 0; j < 3; j++) {
        side.set(t[j] * count + t[(j + 1) % 3], i);
      }
    });
    const gone = new Set<number>();
    const more: number[][] = [];
    for (const [i, [endU, endV, mid]] of flatOnes) {
      if (gone.has(i)) {
        continue;
      }
      const neighbour = side.get(endV * count + endU);
      if (neighbour === undefined || neighbour === i || gone.has(neighbour)) {
        continue;
      }
      const other = tris[neighbour];
      if (middle(other)) {
        continue;
      }
      const x = other.find(corner => corner !== endU && corner !== endV)!;
      dealt.add([...tris[i]].sort((first, q) => first - q).join());
      gone.add(i);
      gone.add(neighbour);
      more.push([endV, mid, x], [mid, endU, x]);
    }
    if (!gone.size) {
      break;
    }
    tris = [...tris.filter((_, i) => !gone.has(i)), ...more];
  }
  // Along every piece of its outlines there must be a triangle: that is where it meets its neighbours.
  const sides = new Set<number>();
  for (const t of tris) {
    for (let j = 0; j < 3; j++) {
      sides.add(Math.min(t[j], t[(j + 1) % 3]) * count + Math.max(t[j], t[(j + 1) % 3]));
    }
  }
  at = 0;
  for (const i of order) {
    const pointCount = flat[i].length / 2;
    for (let index = 0; index < pointCount; index++) {
      const [start, q] = [at + index, at + ((index + 1) % pointCount)];
      if (!sides.has(Math.min(start, q) * count + Math.max(start, q))) {
        return null;
      }
    }
    at += pointCount;
  }
  const want = Math.abs(areas[outer]) - areas.reduce((sum, area, i) => (i === outer ? sum : sum + Math.abs(area)), 0);
  const triangles = new Uint32Array(tris.length * 3);
  let got = 0;
  tris.forEach((t, i) => {
    got += Math.abs(twice(t[0], t[1], t[2])) / 2;
    triangles.set(t, i * 3);
  });
  if (!(want > 0) || Math.abs(got - want) > want * 1e-4) {
    return null;
  }
  const normals = new Float32Array(count * 3);
  for (let index = 0; index < normals.length; index += 3) {
    normals.set([axis[0] / length, axis[1] / length, axis[2] / length], index);
  }

  return { vertices, normals, triangles, faceGroups: [{ start: 0, count: triangles.length }] };
}

/** One edge's points out of a set of edge lines. */
const lineOf = (e: EdgeLines, i: number): Float32Array => e.lines.subarray(e.edgeGroups[i].start * 3, (e.edgeGroups[i].start + e.edgeGroups[i].count) * 3);

function compoundOf(items: { wrapped: unknown }[]): any {
  const oc = getOC() as any;
  const builder = new oc.TopoDS_Builder();
  const compound = new oc.TopoDS_Compound();
  builder.MakeCompound(compound);
  for (const x of items) {
    builder.Add(compound, x.wrapped);
  }
  builder.delete();

  return compound;
}

// (Views of the engine's memory are made after each call: when it grows, its buffer is a new one.)
const floats = (ptr: number, size: number) => new Float32Array((getOC() as any).wasmMemory.buffer, ptr >>> 0, size).slice();
const ints = (ptr: number, size: number) => new Int32Array((getOC() as any).wasmMemory.buffer, ptr >>> 0, size).slice();
const indices = (ptr: number, size: number) => new Uint32Array((getOC() as any).wasmMemory.buffer, ptr >>> 0, size).slice();

/** The triangles of a shape handed to the mesher whole. */
function read(wrapped: unknown, tolerance: number, angularTolerance: number): FaceMesh {
  const raw = (getOC() as any).ReplicadMeshExtractor.extract(wrapped, tolerance, angularTolerance, false);
  try {
    const groups = ints(raw.getFaceGroupsPtr(), raw.getFaceGroupsSize());
    const faceGroups: FaceMesh['faceGroups'] = [];
    for (let i = 0; i < groups.length; i += 3) {
      faceGroups.push({ start: groups[i], count: groups[i + 1] });
    }

    return {
      vertices: floats(raw.getVerticesPtr(), raw.getVerticesSize()),
      normals: floats(raw.getNormalsPtr(), raw.getNormalsSize()),
      triangles: indices(raw.getTrianglesPtr(), raw.getTrianglesSize()),
      faceGroups
    };
  } finally {
    raw.delete();
  }
}

/** Meshes one after another as one. */
function joined(parts: FaceMesh[]): FaceMesh {
  if (parts.length === 1) {
    return parts[0];
  }
  const total = (pick: (m: FaceMesh) => { length: number }) => parts.reduce((total, part) => total + pick(part).length, 0);
  const out: FaceMesh = {
    vertices: new Float32Array(total(faceMesh => faceMesh.vertices)),
    normals: new Float32Array(total(faceMesh => faceMesh.normals)),
    triangles: new Uint32Array(total(faceMesh => faceMesh.triangles)),
    faceGroups: []
  };
  let points = 0;
  let corners = 0;
  for (const part of parts) {
    out.vertices.set(part.vertices, points * 3);
    out.normals.set(part.normals, points * 3);
    for (let triangleIndex = 0; triangleIndex < part.triangles.length; triangleIndex++) {
      out.triangles[corners + triangleIndex] = part.triangles[triangleIndex] + points;
    }
    for (const faceGroup of part.faceGroups) {
      out.faceGroups.push({ start: faceGroup.start + corners, count: faceGroup.count });
    }
    points += part.vertices.length / 3;
    corners += part.triangles.length;
  }

  return out;
}

/**
 * A body's faces as triangles, each face's own (none shared across an edge), in
 * the order of `shape.faces`.
 */
export function meshFaces(shape: Shape3D, tolerance: number, angularTolerance: number): FaceMesh {
  const faces = shape.faces;
  meshedAt.set(shape, `${tolerance}/${angularTolerance}`);
  linesReady.delete(shape);
  const flat = faces.map(manyHoled);
  if (flat.some(Boolean)) {
    const made = withFlatFaces(shape, faces, flat, tolerance, angularTolerance);
    if (made) {
      return made;
    }
  }
  if (faces.length <= LOT) {
    return read(shape.wrapped, tolerance, angularTolerance);
  }
  const parts: FaceMesh[] = [];
  for (let i = 0; i < faces.length; i += LOT) {
    const lot = faces.slice(i, i + LOT);
    const group = compoundOf(lot);
    try {
      let part = read(group, tolerance, angularTolerance);
      // A face that came to nothing left out of the count: each on its own, so the others keep their places.
      if (part.faceGroups.length !== lot.length) {
        part = joined(
          lot.map((face) => {
            const one = read(face.wrapped, tolerance, angularTolerance);

            return one.faceGroups.length === 1 ? one : { ...one, faceGroups: [{ start: 0, count: one.triangles.length }] };
          })
        );
      }
      parts.push(part);
    } finally {
      group.delete();
    }
  }

  return joined(parts);
}

/** Faces a few hundred at a time, as triangles (see LOT). */
function inLots(faces: Face[], tolerance: number, angularTolerance: number): FaceMesh[] {
  const parts: FaceMesh[] = [];
  for (let i = 0; i < faces.length; i += LOT) {
    const lot = faces.slice(i, i + LOT);
    const group = compoundOf(lot);
    try {
      const part = read(group, tolerance, angularTolerance);
      if (part.faceGroups.length !== lot.length) {
        throw new Error('a face without triangles');
      }
      parts.push(part);
    } finally {
      group.delete();
    }
  }

  return parts;
}

/**
 * A body with flat faces of very many holes (`flat`): those cut into triangles
 * here, between the points their neighbours' meshes have along their edges;
 * the rest by OpenCascade. Its edge lines are worked out with it (kept for
 * meshEdgeLines). Null when it can't be done this way (the usual way then).
 */
function withFlatFaces(shape: Shape3D, faces: Face[], flat: boolean[], tolerance: number, angularTolerance: number): FaceMesh | null {
  const trash: (() => void)[] = [];
  const rest = faces.filter((_, i) => !flat[i]);
  const others = rest.length ? compoundOf(rest) : null;
  try {
    // The other faces first: their meshes say where the points along the shared edges are.
    for (let i = 0; i < rest.length; i += LOT) {
      const group = compoundOf(rest.slice(i, i + LOT));
      try {
        (getOC() as any).ReplicadMeshExtractor.mesh(group, tolerance, angularTolerance);
      } finally {
        group.delete();
      }
    }
    const theirs: EdgeLines = others ? readLines(others, tolerance, angularTolerance) : { lines: new Float32Array(0), edgeGroups: [] };
    const known = others ? edgesOf(others) : null;
    if (known) {
      trash.push(known.done);
    }
    if (known && known.edges.length !== theirs.edgeGroups.length) {
      return null;
    }
    // Edges with no neighbour but such faces (the fold between two): their own lines.
    const all = edgesOf(shape.wrapped);
    trash.push(all.done);
    const lone = all.edges.filter(e => !known || known.at(e) < 0);
    let own: EdgeLines | null = null;
    let ownAt: ReturnType<typeof edgesOf> | null = null;
    if (lone.length) {
      const group = compoundOf(lone.map(e => ({ wrapped: e })));
      try {
        own = readLines(group, tolerance, angularTolerance);
        ownAt = edgesOf(group);
        trash.push(ownAt.done);
        if (ownAt.edges.length !== own.edgeGroups.length) {
          return null;
        }
      } finally {
        group.delete();
      }
    }
    const pointsOf = (edge: any): Float32Array | null => {
      const i = known ? known.at(edge) : -1;
      if (i >= 0) {
        return lineOf(theirs, i);
      }
      const j = ownAt ? ownAt.at(edge) : -1;

      return j >= 0 && own ? lineOf(own, j) : null;
    };
    const box = shape.boundingBox;
    const grain = (Math.hypot(box.width, box.height, box.depth) || 1) * 2e-6;
    // Each face in its place: runs of the others (in lots), the flat ones one by one.
    const parts: FaceMesh[] = [];
    let run: Face[] = [];
    const flush = () => {
      if (run.length) {
        parts.push(...inLots(run, tolerance, angularTolerance));
      }
      run = [];
    };
    for (const [i, face] of faces.entries()) {
      if (!flat[i]) {
        run.push(face);
        continue;
      }
      const mine = edgesOf(face.wrapped);
      let part: FaceMesh | null = null;
      try {
        const lines = mine.edges.map(pointsOf);
        const loops = lines.every(Boolean) ? outlines(lines as Float32Array[], grain) : null;
        part = loops && flatTriangles(loops, face.normalAt().toTuple() as [number, number, number]);
      } finally {
        mine.done();
      }
      if (!part) {
        return null;
      }
      flush();
      parts.push(part);
    }
    flush();
    // The body's edge lines, in the order of its edges.
    const each = all.edges.map(pointsOf);
    if (!each.every(Boolean)) {
      return null;
    }
    const lines = new Float32Array(each.reduce((total, values) => total + values!.length, 0));
    const edgeGroups: EdgeLines['edgeGroups'] = [];
    let at = 0;
    for (const values of each as Float32Array[]) {
      lines.set(values, at * 3);
      edgeGroups.push({ start: at, count: values.length / 3 });
      at += values.length / 3;
    }
    linesReady.set(shape, { key: `${tolerance}/${angularTolerance}`, lines: { lines, edgeGroups } });

    return joined(parts);
  } catch {
    return null;
  } finally {
    for (const done of trash) {
      done();
    }
    others?.delete();
  }
}

/**
 * A body's edges as lines, in the order of `shape.edges` - the lines its faces'
 * triangles meet along (so its faces are meshed first, if they aren't yet).
 */
export function meshEdgeLines(shape: Shape3D, tolerance: number, angularTolerance: number): EdgeLines {
  const oc = getOC() as any;
  const ready = linesReady.get(shape);
  if (ready?.key === `${tolerance}/${angularTolerance}`) {
    return ready.lines;
  }
  if (meshedAt.get(shape) !== `${tolerance}/${angularTolerance}`) {
    // (A body with faces cut into triangles here: its lines come with those.)
    const faces = shape.faces;
    if (faces.some(manyHoled)) {
      meshFaces(shape, tolerance, angularTolerance);
      const made = linesReady.get(shape);
      if (made) {
        return made.lines;
      }
    }
    // (In lots, as above: read off the whole body unmeshed, it is meshed whole.)
    for (let i = 0; faces.length > LOT && i < faces.length; i += LOT) {
      const group = compoundOf(faces.slice(i, i + LOT));
      try {
        oc.ReplicadMeshExtractor.mesh(group, tolerance, angularTolerance);
      } finally {
        group.delete();
      }
    }
    meshedAt.set(shape, `${tolerance}/${angularTolerance}`);
  }

  return readLines(shape.wrapped, tolerance, angularTolerance);
}

/**
 * A body's triangles taken off it again, once whoever asked for them has
 * them. Left on, they stay for as long as the kernel holds the body - and the
 * tool that made a body holds it for good (release.ts): every shape ever
 * shown kept its mesh. Nothing reads them later: each edit works on a copy
 * of the body, which has none, and a face that wants its own asks for them.
 */
export function meshOff(shape: Shape3D): void {
  meshedAt.delete(shape);
  linesReady.delete(shape);
  try {
    (getOC() as any).BRepTools.Clean(shape.wrapped, true);
  } catch {
    // Left as they are.
  }
}

/**
 * One face's own triangles, for what wants points on it: its corners (x, y, z
 * each) and which three make each triangle. Made for that face alone when it
 * has none yet (`size`: its body's, which says how fine) - the whole body used
 * to be meshed for the one face, seconds on a big body - and read out in one
 * go: asked for corner by corner, each corner cost four small things in the
 * kernel that are never given back (release.ts), a megabyte and more with
 * each check of a shell's walls.
 */
export function faceTriangles(face: Face, size: number): { vertices: Float32Array; trianglesIndexes: Uint32Array } | null {
  // (A flat face of very many holes: cut into triangles here, between points along its own edges - see LOOPS.)
  if (manyHoled(face)) {
    const mine = edgesOf(face.wrapped);
    const group = compoundOf(mine.edges.map(e => ({ wrapped: e })));
    try {
      const own = readLines(group, size * 1e-3, 0.3);
      if (own.edgeGroups.length === mine.edges.length) {
        const loops = outlines(mine.edges.map((_, i) => lineOf(own, i)), size * 2e-6);
        const part = loops && flatTriangles(loops, face.normalAt().toTuple() as [number, number, number]);
        if (part) {
          return { vertices: part.vertices, trianglesIndexes: part.triangles };
        }
      }
    } catch {
      // The usual way.
    } finally {
      mine.done();
      group.delete();
    }
  }
  const raw = (getOC() as any).ReplicadMeshExtractor.extract(face.wrapped, size * 1e-3, 0.3, true);
  try {
    const trianglesIndexes = indices(raw.getTrianglesPtr(), raw.getTrianglesSize());
    if (!trianglesIndexes.length) {
      return null;
    }

    return { vertices: floats(raw.getVerticesPtr(), raw.getVerticesSize()), trianglesIndexes };
  } finally {
    raw.delete();
  }
}

/** Meshes as one binary STL file (each triangle with its own flat normal, as a slicer reads it). */
export function binarySTL(meshes: FaceMesh[]): Uint8Array {
  const count = meshes.reduce((total, mesh) => total + mesh.triangles.length / 3, 0);
  const out = new Uint8Array(84 + count * 50);
  const view = new DataView(out.buffer);
  // (80 bytes of heading, never starting "solid": readers take that for the text kind.)
  out.set(new TextEncoder().encode('binary stl'), 0);
  view.setUint32(80, count, true);
  let at = 84;
  for (const mesh of meshes) {
    const vertices = mesh.vertices;
    for (let triangleIndex = 0; triangleIndex < mesh.triangles.length; triangleIndex += 3) {
      const [a, b, offsetC] = [mesh.triangles[triangleIndex] * 3, mesh.triangles[triangleIndex + 1] * 3, mesh.triangles[triangleIndex + 2] * 3];
      const [ux, uy, uz] = [vertices[b] - vertices[a], vertices[b + 1] - vertices[a + 1], vertices[b + 2] - vertices[a + 2]];
      const [vx, vy, vz] = [vertices[offsetC] - vertices[a], vertices[offsetC + 1] - vertices[a + 1], vertices[offsetC + 2] - vertices[a + 2]];
      let [nx, ny, nz] = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
      const length = Math.hypot(nx, ny, nz);
      if (length > 0) {
        [nx, ny, nz] = [nx / length, ny / length, nz / length];
      }
      view.setFloat32(at, nx, true);
      view.setFloat32(at + 4, ny, true);
      view.setFloat32(at + 8, nz, true);
      for (const [j, i] of [a, b, offsetC].entries()) {
        for (let x = 0; x < 3; x++) {
          view.setFloat32(at + 12 + j * 12 + x * 4, vertices[i + x], true);
        }
      }
      at += 50;
    }
  }

  return out;
}
