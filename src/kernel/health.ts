// Health checks for solids, shared by the engine's edit guard and the repair tool.

import { cast, getOC, measureArea, type Edge, type Shape3D } from 'replicad';
import { meshFaces, meshOff } from './meshing';

/** OpenCascade's own check (self-crossing faces, bad edges…). */
const validCache = new WeakMap<Shape3D, boolean>();
export function shapeValid(shape: Shape3D): boolean {
  const known = validCache.get(shape);
  if (known !== undefined) {
    return known;
  }
  const ok = checkValid(shape);
  validCache.set(shape, ok);

  return ok;
}

function checkValid(shape: Shape3D): boolean {
  try {
    return validNow(shape.wrapped);
  } catch {
    return true;
  }
}

/**
 * OpenCascade's check of a shape, made now (nothing remembered). Its checker
 * keeps what it found on every face, edge and corner, and deleting it doesn't
 * give that back: each check of an everyday body left over half a megabyte
 * behind for good. A plate of 35 faces checked 3 000 times took the engine
 * from 100 MB to 1.9 GB - and every edit checks its result, so a long session
 * ran the engine out of memory. Pointed at nothing before it goes, the checker
 * lets go of it all.
 */
export function validNow(wrapped: unknown): boolean {
  const oc = getOC();
  const check = new oc.BRepCheck_Analyzer(wrapped as never, true, false, false);
  try {
    return (check as unknown as { IsValid(): boolean }).IsValid();
  } finally {
    const builder = new oc.TopoDS_Builder();
    const nothing = new oc.TopoDS_Compound();
    try {
      builder.MakeCompound(nothing);
      check.Init(nothing, false);
    } catch {
      // As it is: the check itself is done.
    }
    builder.delete();
    nothing.delete();
    check.delete();
  }
}


/**
 * Edges with a face on one side only (gaps), by index. Worked out once per
 * shape, like the checks below: every edit asks it of the body as it was
 * before, which is the same body on each move of a drag.
 */
const openCache = new WeakMap<Shape3D, { open: number[]; pinched: number }>();
export function openEdges(shape: Shape3D): number[] {
  return edgeUse(shape).open;
}

/**
 * Edges with more than two faces round them: two pieces that only meet
 * along an edge (a slab stood on a block's edge and "joined"), held
 * together by nothing - one body by name, two by any printer or saw.
 */
export function pinchedEdges(shape: Shape3D): number {
  return edgeUse(shape).pinched;
}

function edgeUse(shape: Shape3D): { open: number[]; pinched: number } {
  let known = openCache.get(shape);
  if (!known) {
    openCache.set(shape, (known = findEdgeUse(shape)));
  }

  return known;
}

function findEdgeUse(shape: Shape3D): { open: number[]; pinched: number } {
  const { uses, degenerated } = edgeFaces(shape);
  const open: number[] = [];
  let pinched = 0;
  uses.forEach((list, i) => {
    // A seam (cylinder/torus) belongs to its face twice but is listed once.
    const n = list.reduce((s, u) => s + (u.closed ? 2 : 1), 0);
    // A pole (where a revolved profile touches the axis) is a point-edge, not a gap.
    if (n < 2 && !degenerated[i]) {
      open.push(i);
    }
    if (new Set(list.map(u => u.face)).size > 2) {
      pinched++;
    }
  });

  return { open, pinched };
}

/** Which faces each edge of a body lies on (by index, in the order of shape.edges and shape.faces). */
export interface EdgeFaces {
  /** For each edge: the faces it is an edge of, and whether it is that face's seam. */
  uses: { face: number; closed: boolean }[][];
  /** For each edge: a point-edge (a pole). */
  degenerated: boolean[];
}
const edgeFacesCache = new WeakMap<Shape3D, EdgeFaces>();

/**
 * Each edge's faces, worked out once for a body. (Four things asked this, each going through every face's edges
 * again - which steps an edge lies between, which sketch curves, whether it is a seam, whether it is open: on a
 * body of two thousand faces that was half of what every rebuild took.)
 */
export function edgeFaces(shape: Shape3D): EdgeFaces {
  const known = edgeFacesCache.get(shape);
  if (known) {
    return known;
  }
  const oc = getOC();
  const edges = shape.edges;
  const buckets = new Map<number, { e: Edge; i: number }[]>();
  edges.forEach((e, i) => {
    const hashCode = e.hashCode;
    const entries = buckets.get(hashCode);
    if (entries) {
      entries.push({ e, i });
    } else {
      buckets.set(hashCode, [{ e, i }]);
    }
  });
  const uses: EdgeFaces['uses'] = edges.map(() => []);
  shape.faces.forEach((face, faceIndex) => {
    for (const fe of face.edges) {
      const match = buckets.get(fe.hashCode)?.find(entry => entry.e.isSame(fe));
      if (match) {
        uses[match.i].push({ face: faceIndex, closed: oc.BRep_Tool.IsClosed(fe.wrapped, face.wrapped) });
      }
    }
  });
  const out = { uses, degenerated: edges.map(e => oc.BRep_Tool.Degenerated(e.wrapped)) };
  edgeFacesCache.set(shape, out);

  return out;
}

/**
 * A real copy: its own topology and its own curves and surfaces (replicad's
 * clone() only wraps the same shape again), its faces and edges in the same
 * order. Written out and read back. The kernel's own copier ("moving" it
 * nowhere with copying on) keeps every piece of the shape and of the copy,
 * and can't be made to let go of them (release.ts): each edit of a step that
 * works on a copy - a fillet's size dragged - lost a whole body for good.
 * What is read from a file is held by its handle alone. (The mesh goes out
 * and in with it, and is taken off: a copy has none.)
 */
let copies = 0;
export function deepCopy(shape: Shape3D): Shape3D {
  const oc = getOC();
  const name = `/copy-${copies++}.bin`;
  const progress = new oc.Message_ProgressRange();
  const read = new oc.TopoDS_Shape();
  try {
    if (oc.BinTools.Write(shape.wrapped, name, progress) && oc.BinTools.Read(read, name, progress) && !read.IsNull()) {
      oc.BRepTools.Clean(read, true);

      return cast(read) as Shape3D;
    }
  } catch (err) {
    // (The engine itself breaking down is not a copy that couldn't be made.)
    if (typeof WebAssembly !== 'undefined' && err instanceof WebAssembly.RuntimeError) {
      throw err;
    }
  } finally {
    try {
      oc.FS.unlink(name);
    } catch {
      // never written
    }
    progress.delete();
    read.delete();
  }
  // The old way, if it can't be written.
  const t = new oc.gp_Trsf();
  const mk = new oc.BRepBuilderAPI_Transform(shape.wrapped, t, true, false);
  try {
    return cast(mk.ModifiedShape(shape.wrapped)) as Shape3D;
  } finally {
    mk.delete();
    t.delete();
  }
}

export function subShapes(shape: Shape3D, kind: 'SOLID' | 'SHELL'): any[] {
  const oc = getOC();
  const ex = new oc.TopExp_Explorer(shape.wrapped, kind === 'SOLID' ? oc.TopAbs_ShapeEnum.TopAbs_SOLID : oc.TopAbs_ShapeEnum.TopAbs_SHELL, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
  const out: any[] = [];
  for (; ex.More(); ex.Next()) {
    const item = ex.Current();
    out.push(kind === 'SOLID' ? oc.TopoDS.Solid(item) : oc.TopoDS.Shell(item));
    item.delete();
  }
  ex.delete();

  return out;
}

/** How many faces are next to nothing in area (once per shape: every face's area is slow on curved faces). */
const thinCache = new WeakMap<Shape3D, number>();
export function hairThin(shape: Shape3D): number {
  let known = thinCache.get(shape);
  if (known === undefined) {
    thinCache.set(shape, (known = countHairThin(shape)));
  }

  return known;
}

function countHairThin(shape: Shape3D): number {
  const areas = shape.faces.map(face => measureArea(face));
  const total = areas.reduce((a, b) => a + b, 0);

  return areas.filter(a => a < total * 1e-7).length;
}

/** A solid's volume counted from a mesh of it (coarse, so the view's own finer mesh still gets made). */
export function meshVolume(shape: Shape3D, size: number): number {
  const faceMesh = meshFaces(shape, size * 1e-3, 0.3);
  meshOff(shape);
  const vertices = faceMesh.vertices;
  const t = faceMesh.triangles;
  let volume = 0;
  for (let index = 0; index < t.length; index += 3) {
    const [i, j, indexC] = [3 * t[index], 3 * t[index + 1], 3 * t[index + 2]];
    volume += vertices[i] * (vertices[j + 1] * vertices[indexC + 2] - vertices[j + 2] * vertices[indexC + 1]) - vertices[i + 1] * (vertices[j] * vertices[indexC + 2] - vertices[j + 2] * vertices[indexC]) + vertices[i + 2] * (vertices[j] * vertices[indexC + 1] - vertices[j + 1] * vertices[indexC]);
  }

  return volume / 6;
}
