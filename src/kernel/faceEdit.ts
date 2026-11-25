// Direct face editing with booleans: offset a face (neighbours extend along their
// own surfaces), move/tilt a flat face, delete a face (neighbours close the gap).
//
// The trick: near face F the body equals E ∩ "behind F", where E is the
// intersection of the *extended* neighbouring surfaces - each taken on the side
// the body is on (planes → half-spaces, cylinders → infinite cylinders). Changing
// F then only means adding/removing the right slab of E.

import { assembleWire, basicFaceExtrusion, getOC, loft, makeFace, makeBSplineApproximation, makeCylinder, makeLine, makePolygon, makeSphere, measureArea, cast, revolution, Vector, type Edge, type Face, type Shape3D } from 'replicad';
import { add, cross, dist, dot, len, norm, scale, sub, xDirFor } from '../geom';
import { borderPieces, borderThrough, boundaryEdges, limitPoints, subdivide, type Cage } from '../freeform/cage';
import { faceTriangles } from './meshing';
import { shapeValid, subShapes, validNow } from './health';
import { measureVolume, quickVolume } from './ocFree';
import { cageToShape } from './freeform';
import type { PlaneDef, Vec3 } from '../doc/types';

interface Cyl {
  c: Vec3;
  a: Vec3;
  r: number;
  /** +1: material inside (boss), −1: material outside (hole). */
  s: number;
}

const tup = (vector: { toTuple(): number[] }) => vector.toTuple() as Vec3;

/**
 * The body's size (its box's diagonal), worked out once per body: a box round
 * a big curved body is slow, and the steps here asked for it again and again
 * (2.8 s of deleting one hole in a jet engine's casing).
 */
const sizes = new WeakMap<object, number>();
export function sizeOf(body: Shape3D): number {
  const key = body.wrapped as object;
  let size = sizes.get(key);
  if (size === undefined) {
    size = looseSize(body);
    sizes.set(key, size);
  }

  return size;
}

/**
 * About how big a shape is (the diagonal of the kernel's quick box: never smaller than the shape, a few percent
 * bigger on curved faces). Its exact box takes 0.4 to 1 s on a body with curved faces (a mug with its handle, a
 * freeform) - asked for by every step that touched such a body, just to know how big a helper to make.
 */
function looseSize(body: Shape3D): number {
  const [lo, hi] = looseBox(body);

  return Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) || 1;
}

/**
 * The kernel's quick box of a shape, [low corner, high corner]: the shape is all inside it, and it is a little
 * bigger than the shape where its faces are curved. For telling shapes apart that can't touch, and how far
 * something reaches. (An empty shape: an upside-down box, as the exact one's.)
 */
const looseBoxes = new WeakMap<object, [Vec3, Vec3]>();
export function looseBox(body: Shape3D): [Vec3, Vec3] {
  const key = body.wrapped as object;
  const had = looseBoxes.get(key);
  if (had) {
    return had;
  }
  const oc = getOC();
  const box = new oc.Bnd_Box();
  let out: [Vec3, Vec3] | null = null;
  try {
    oc.BRepBndLib.Add(body.wrapped, box, false);
    if (!box.IsVoid()) {
      const [a, b] = [box.CornerMin(), box.CornerMax()];
      const got: [Vec3, Vec3] = [
        [a.X(), a.Y(), a.Z()],
        [b.X(), b.Y(), b.Z()]
      ];
      a.delete();
      b.delete();
      if ([...got[0], ...got[1]].every(Number.isFinite)) {
        out = got;
      }
    }
  } catch {
    // The exact one, below.
  } finally {
    box.delete();
  }
  if (!out) {
    const [lo, hi] = body.boundingBox.bounds;
    out = [[...lo] as Vec3, [...hi] as Vec3];
  }
  looseBoxes.set(key, out);

  return out;
}

// Each helper solid gets a slightly different size: when two of them end on the
// same far-away plane, the booleans split surfaces and they no longer re-merge.
let jitter = 0;
/** Each step starts the sizes over: what a step builds mustn't depend on which steps were rebuilt before it. */
export function sameSizesAgain(): void {
  jitter = 0;
}
const vary = (length: number) => length * (1 + 0.0137 * (jitter = (jitter + 1) % 37));

/** Solid on the positive side of a plane, big enough for `length`. */
export function halfSpace(plane: PlaneDef, L0: number): Shape3D {
  const length = vary(L0);
  const x = norm(plane.xDir);
  const y = cross(plane.normal, x);
  const origin = plane.origin;
  const corner = (along: number, across: number): Vec3 => add(origin, add(scale(x, along * length), scale(y, across * length)));
  // Off-centre on purpose (see `vary`).
  const face = makePolygon([corner(-1.09, -0.93), corner(0.97, -0.93), corner(0.97, 1.05), corner(-1.09, 1.05)]);

  return basicFaceExtrusion(face, new Vector(plane.normal).multiply(length));
}

/** Axis, radius and orientation of a cylindrical face (from surface samples). */
export function cylinderOf(face: Face): Cyl | null {
  if (face.geomType !== 'CYLINDRE') {
    return null;
  }
  // pointOnSurface takes UV normalised to the face's bounds.
  const at = (paramU: number, paramV: number) => {
    const point = tup(face.pointOnSurface(paramU, paramV));

    return { p: point, n: norm(tup(face.normalAt(point))) };
  };
  // Two points at the same height, apart around the axis.
  const s1 = at(0.25, 0.5);
  const s2 = at(0.6, 0.5);
  const ax = cross(s1.n, s2.n);
  if (len(ax) < 1e-9) {
    return null;
  }
  const a = norm(ax);
  const dn = len(sub(s1.n, s2.n));
  const radius = len(sub(s1.p, s2.p)) / (dn || 1);
  // Normals point away from the axis on a boss, towards it in a hole.
  const cOut = sub(s1.p, scale(s1.n, radius));
  const cIn = add(s1.p, scale(s1.n, radius));
  const out2 = sub(s2.p, scale(s2.n, radius));
  const side = dist(cOut, out2) < dist(cIn, add(s2.p, scale(s2.n, radius))) ? 1 : -1;
  const center = side > 0 ? cOut : cIn;

  return { c: center, a, r: radius, s: side };
}

/**
 * A point that lies on `face` itself (its center may be off the face - e.g. on
 * a cylinder's axis or inside a ring) and the outward normal there.
 */
export function onFace(body: Shape3D, face: Face): { p: Vec3; n: Vec3 } {
  // Curved faces: the middle of the face's own parameter range sits well inside
  // it (a fillet's mid-arc), away from the edges where its neighbours start.
  if (face.geomType !== 'PLANE') {
    const point = tup(face.pointOnSurface(0.5, 0.5));

    return { p: point, n: norm(tup(face.normalAt(point))) };
  }
  const t = faceTriangles(face, sizeOf(body));
  if (t) {
    // Centroid of the biggest triangle: well inside the face.
    const vertexAt = (i: number): Vec3 => [t!.vertices[3 * i], t!.vertices[3 * i + 1], t!.vertices[3 * i + 2]];
    let best: Vec3 = vertexAt(0);
    let area = -1;
    for (let index = 0; index < t.trianglesIndexes.length; index += 3) {
      const [a, b, vertexC] = [0, 1, 2].map(j => vertexAt(t!.trianglesIndexes[index + j]));
      const ar = len(cross(sub(b, a), sub(vertexC, a)));
      if (ar > area) {
        area = ar;
        best = scale(add(add(a, b), vertexC), 1 / 3);
      }
    }
    const normal = norm(tup(face.normalAt(best)));
    // (The mesh's corners are kept to seven digits: the point is put back on the face's own plane.)
    const on = tup(face.pointOnSurface(0.5, 0.5));

    return { p: sub(best, scale(normal, dot(sub(best, on), normal))), n: normal };
  }
  const surfacePoint = tup(face.pointOnSurface(0.5, 0.5));

  return { p: surfacePoint, n: norm(tup(face.normalAt(surfacePoint))) };
}

/** The exact plane of a flat face (a surface point, not a mesh point). */
export function planeOf(face: Face): PlaneDef {
  const origin = tup(face.pointOnSurface(0.5, 0.5));
  const normal = norm(tup(face.normalAt(origin)));

  return { origin, normal, xDir: xDirFor(normal) };
}

function infiniteCylinder(cy: Cyl, radius: number, L0: number): Shape3D {
  const length = vary(L0);

  return makeCylinder(radius, 2 * length, sub(cy.c, scale(cy.a, length)), cy.a) as Shape3D;
}

/**
 * A conical face's apex, its axis pointing into the half of the cone the face
 * is on, and the tangent of its half-angle - from points on it (this kernel
 * build can't hand over its cone).
 */
export function coneOf(face: Face): { apex: Vec3; a: Vec3; t: number } | null {
  if (face.geomType !== 'CONE') {
    return null;
  }
  try {
    const at = (paramU: number, paramV: number) => tup(face.pointOnSurface(paramU, paramV));
    // A circle round the axis: three points at one height, and its middle.
    const centre = (first: Vec3, q: Vec3, third: Vec3): Vec3 => {
      const ab = sub(q, first), ac = sub(third, first);
      const normal = cross(ab, ac);
      const nn = dot(normal, normal);
      if (nn < 1e-18) {
        throw new Error('flat');
      }

      return add(first, scale(add(scale(cross(normal, ab), dot(ac, ac)), scale(cross(ac, normal), dot(ab, ab))), 1 / (2 * nn)));
    };
    const ring = (paramV: number) => {
      const ps = [0.2, 0.5, 0.8].map(paramU => at(paramU, paramV));

      return { c: centre(ps[0], ps[1], ps[2]), p: ps[1] };
    };
    const lo = ring(0.2), hi = ring(0.8);
    const r1 = dist(lo.p, lo.c), r2 = dist(hi.p, hi.c);
    const height = dist(lo.c, hi.c);
    if (height < 1e-9 || Math.abs(r2 - r1) < 1e-9) {
      return null;
    }
    const up = norm(sub(hi.c, lo.c));
    // Radius r1 at lo, r2 at hi: none at the apex.
    const apex = sub(lo.c, scale(up, (r1 * height) / (r2 - r1)));
    const t = Math.abs(r2 - r1) / height;
    const a = dot(sub(lo.p, apex), up) > 0 ? up : scale(up, -1);

    return t > 1e-9 && t < 1e6 ? { apex, a, t } : null;
  } catch {
    return null;
  }
}

/** The solid inside a cone, from its apex out past `length` (a triangle turned round its axis). */
function infiniteCone(cone: { apex: Vec3; a: Vec3; t: number }, L0: number): Shape3D {
  const length = vary(L0);
  const perpendicular = norm(cross(cone.a, Math.abs(cone.a[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]));
  const end = add(cone.apex, scale(cone.a, length));
  const tri = makeFace(assembleWire([makeLine(cone.apex, end), makeLine(end, add(end, scale(perpendicular, length * cone.t))), makeLine(add(end, scale(perpendicular, length * cone.t)), cone.apex)]));

  return revolution(tri, cone.apex, cone.a) as Shape3D;
}

/**
 * g, a round face next to flat face F, is a convex fillet that ends on F
 * (its axis runs through F, and it rounds the edge between two flat faces it
 * is tangent to): those two faces' planes, outward. Null otherwise.
 */
function filletEnding(body: Shape3D, face: Face, neighbour: Face, cy: Cyl): [PlaneDef, PlaneDef] | null {
  if (Math.abs(dot(cy.a, planeOf(face).normal)) < 0.05) {
    return null;
  }
  const tol = sizeOf(body) * 1e-7;
  const sup = neighbours(body, neighbour).filter(candidate => candidate.geomType === 'PLANE' && !candidate.isSame(face) && tangentTo(cy, planeOf(candidate), tol));
  if (sup.length !== 2) {
    return null;
  }
  const pls = sup.map(support => planeOf(support)) as [PlaneDef, PlaneDef];
  // Convex: the axis lies inside the material, behind both faces.
  if (!pls.every(pl => dot(sub(cy.c, pl.origin), pl.normal) < 0)) {
    return null;
  }

  return pls;
}

/**
 * The plane a curved face `neighbour` touches all along its one straight edge with `face`
 * (its normal the same the whole way: a curve pulled straight), else null.
 */
function tangentPlaneAlong(face: Face, neighbour: Face): PlaneDef | null {
  const shared = neighbour.edges.filter(e => face.edges.some(fe => fe.isSame(e)));
  if (shared.length !== 1 || shared[0].geomType !== 'LINE') {
    return null;
  }
  const e = shared[0];
  try {
    const ns = [0, 0.5, 1].map(t => norm(tup(neighbour.normalAt(e.pointAt(t)))));
    if (ns.some(normal => dot(normal, ns[0]) < 1 - 1e-9)) {
      return null;
    }
    const dir = norm(tup(e.tangentAt(0.5)));
    if (Math.abs(dot(dir, ns[0])) > 1e-6) {
      return null;
    }

    return { origin: tup(e.pointAt(0.5)), normal: ns[1], xDir: dir };
  } catch {
    return null;
  }
}

/**
 * A flat face drawn inside a bigger flat one (a shape projected onto it): every
 * face round it lies in its plane, so moving its plane moves nothing.
 */
export function inFlatFace(body: Shape3D, face: Face): boolean {
  if (face.geomType !== 'PLANE') {
    return false;
  }
  const plane = planeOf(face);
  const tol = sizeOf(body) * 1e-7;
  const ns = neighbours(body, face);

  return ns.length > 0 && ns.every((neighbour) => {
    if (neighbour.geomType !== 'PLANE') {
      return false;
    }
    const q = planeOf(neighbour);

    return Math.abs(Math.abs(dot(q.normal, plane.normal)) - 1) < 1e-9 && Math.abs(dot(sub(q.origin, plane.origin), plane.normal)) < tol;
  });
}

/** Faces sharing an edge with `face`. */
function neighbours(body: Shape3D, face: Face): Face[] {
  const edges = face.edges;

  return body.faces.filter(otherFace => !otherFace.isSame(face) && otherFace.edges.some(e => edges.some(fe => fe.isSame(e))));
}

/**
 * E: the region bounded by `face`'s neighbours' extended surfaces, each on the side
 * that contains `q` (a point just inside the body under F). Bounded by a box.
 */
export function extendedRegion(body: Shape3D, face: Face, q: Vec3, reach: number, part?: Vec3[]): Shape3D {
  return regionAround(body, face, neighbours(body, face), q, reach, part);
}

/** As extendedRegion, bounded by the given faces round `face` (those along one of its outlines). */
function regionAround(body: Shape3D, face: Face, nb: Face[], q: Vec3, extent: number, part?: Vec3[]): Shape3D {
  const center = body.boundingBox.center as Vec3;
  // Bounding box, bigger than the other tools so no faces coincide with theirs.
  const big = () => halfSpace({ origin: sub(center, [0, 0, 1.5 * extent]), xDir: [1, 0, 0], normal: [0, 0, 1] }, 3 * extent);
  const keep: Shape3D[] = [];
  const remove: Shape3D[] = [];
  for (const neighbour of nb) {
    if (neighbour.geomType === 'PLANE') {
      const { origin: origin, normal: normal } = planeOf(neighbour);
      // Keep the side of g's plane that contains q.
      const side = dot(sub(q, origin), normal) < 0 ? scale(normal, -1) : normal;
      keep.push(halfSpace({ origin: origin, normal: side, xDir: xDirFor(side) }, extent));
    } else if (neighbour.geomType === 'CYLINDRE') {
      const cy = cylinderOf(neighbour);
      if (!cy) {
        continue;
      }
      // A rounded edge (a fillet) that ends on `face`: it carries on along itself,
      // between the two faces it rounds - not as an endless cylinder, which
      // carved a groove into the body and left a scrap of the old face standing.
      const corner = face.geomType === 'PLANE' ? filletEnding(body, face, neighbour, cy) : null;
      if (corner) {
        for (const pl of corner) {
          if (nb.some(neighbour => neighbour.geomType === 'PLANE' && Math.abs(dot(planeOf(neighbour).normal, pl.normal)) > 1 - 1e-9 && Math.abs(dot(sub(planeOf(neighbour).origin, pl.origin), pl.normal)) < 1e-6)) {
            continue;
          }
          keep.push(halfSpace({ origin: pl.origin, normal: scale(pl.normal, -1), xDir: xDirFor(scale(pl.normal, -1)) }, extent));
        }
        const wedge = halfSpace({ origin: cy.c, normal: corner[0].normal, xDir: xDirFor(corner[0].normal) }, extent).intersect(halfSpace({ origin: cy.c, normal: corner[1].normal, xDir: xDirFor(corner[1].normal) }, extent));
        remove.push(wedge.cut(infiniteCylinder(cy, cy.r, extent)));
        continue;
      }
      const rel = sub(q, cy.c);
      const radial = len(sub(rel, scale(cy.a, dot(rel, cy.a))));
      (radial < cy.r ? keep : remove).push(infiniteCylinder(cy, cy.r, extent));
      // A flat face ending on a round boss from one side (a lever's arm on its
      // hub): taking the boss out isn't enough, the arm's side faces carry on
      // past it and out the far side. The face lies all on one side of the
      // boss's axis: the region does too. (`part`: the piece of `face` it's for, one of `face`'s cells.)
      if (radial >= cy.r && face.geomType === 'PLANE') {
        const off = (point: Vec3) => {
          const offset = sub(point, cy.c);

          return sub(offset, scale(cy.a, dot(offset, cy.a)));
        };
        const pts = part ?? face.edges.flatMap(e => [0, 0.25, 0.5, 0.75].map(t => tup(e.pointAt(t))));
        const direction = off(scale(pts.reduce((a, b) => add(a, b), [0, 0, 0] as Vec3), 1 / pts.length));
        if (len(direction) > cy.r * 1e-3) {
          const dn = norm(direction);
          if (pts.every(point => dot(off(point), dn) > -cy.r * 1e-6)) {
            keep.push(halfSpace({ origin: cy.c, normal: dn, xDir: xDirFor(dn) }, extent));
          }
        }
      }
    } else if (coneOf(neighbour)) {
      // A tapered side (a foot stepping in under a cup): it carries on as the
      // cone it is - the inside of it kept or taken away as for a cylinder.
      // (Treated as any other surface, the region round a cup's floor was open
      // above and ran off out of the part.)
      const cone = coneOf(neighbour)!;
      const rel = sub(q, cone.apex);
      const along = dot(rel, cone.a);
      const radial = len(sub(rel, scale(cone.a, along)));
      const reach = len(sub(center, cone.apex)) + 2 * extent;
      (along > 0 && radial < along * cone.t ? keep : remove).push(infiniteCone(cone, reach));
    } else {
      // A curve pulled straight (a spline side extruded) meeting `face` along a
      // straight edge: it carries on along its tangent there. Bounded only by
      // the flat faces round it, a heel's foot moved down ran off along the heel.
      const tangent = tangentPlaneAlong(face, neighbour);
      if (tangent) {
        const side = dot(sub(q, tangent.origin), tangent.normal) < 0 ? scale(tangent.normal, -1) : tangent.normal;
        keep.push(halfSpace({ origin: tangent.origin, normal: side, xDir: xDirFor(side) }, extent));
        continue;
      }
      // Any other surface (a twisted corner patch where a chamfer meets a
      // fillet, a lofted side) has no one way to carry on: the flat faces
      // round it do, and bound the region there. Left open, it would run off
      // out of the part.
      for (const candidate of neighbours(body, neighbour)) {
        if (candidate.geomType !== 'PLANE' || candidate.isSame(face) || nb.some(neighbour => neighbour.isSame(candidate))) {
          continue;
        }
        const { origin: hp, normal: hn } = planeOf(candidate);
        const hs = dot(sub(q, hp), hn) < 0 ? scale(hn, -1) : hn;
        keep.push(halfSpace({ origin: hp, normal: hs, xDir: xDirFor(hs) }, extent));
      }
    }
  }
  let shape = keep.length ? keep[0] : big();
  for (const keeper of keep.slice(1)) {
    shape = shape.intersect(keeper);
  }
  for (const removal of remove) {
    shape = shape.cut(removal);
  }

  return shape;
}

/**
 * The face made a smooth surface through `points` (absolute), its own edges
 * kept: the rest of the body is untouched and closes round it again.
 */
export function freeformFace(body: Shape3D, face: Face, points: Vec3[]): Shape3D {
  const oc = getOC();
  const ex = new oc.TopExp_Explorer(face.wrapped, oc.TopAbs_ShapeEnum.TopAbs_WIRE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
  let wires = 0;
  for (; ex.More(); ex.Next()) {
    wires++;
  }
  ex.delete();
  if (wires !== 1) {
    throw new Error("Faces with holes in them can't be made freeform yet");
  }
  // Degree 2 overshoots least between points pulled out together; it can't
  // always follow an outline with inward corners (an L): then 3.
  for (const degree of [2, 3]) {
    try {
      const solid = filledFace(body, face, points, degree);
      if (validNow(solid.wrapped)) {
        return solid;
      }
    } catch {
      // the next degree
    }
  }
  throw new Error("This face can't be shaped like that (it would fold over itself) - move the points less, or not past each other");
}

/**
 * The face made the cage's own smooth surface (the same patches a freeform
 * body is made of), its border on the face's edges: no fitting through
 * points, so it comes out the same every time and on any outline the cage
 * follows. Throws when the cage's border isn't on the face's edge (a cage
 * from before its border followed the face's corners) or the body doesn't
 * close round the new surface - the fitted way is tried then.
 */
export function sheetFace(body: Shape3D, face: Face, cage: Cage): Shape3D {
  return sheetFaces(body, [face], cage, norm(face.normalAt().toTuple() as Vec3));
}

/**
 * Several faces side by side made one smooth surface (sheetFace's way): its
 * border on their outer edges, the edges between them gone. `n`: the way they
 * face together (the middle of their normals).
 */
export function sheetFaces(body: Shape3D, Fs: Face[], cage: Cage, normal: Vec3): Shape3D {
  const oc = getOC();
  for (const face of Fs) {
    const ex = new oc.TopExp_Explorer(face.wrapped, oc.TopAbs_ShapeEnum.TopAbs_WIRE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
    let wires = 0;
    for (; ex.More(); ex.Next()) {
      wires++;
    }
    ex.delete();
    if (wires !== 1) {
      throw new Error("Faces with holes in them can't be made freeform yet");
    }
  }
  const size = Math.sqrt(Fs.reduce((a, face) => a + measureArea(face), 0));
  // (Over several faces the border bends round their corners: it follows the edge a hair less closely.)
  const tol = Math.max(5e-3, size * (Fs.length > 1 ? 3e-3 : 1e-3));
  // The faces' outer edge, finely (a round edge as short straight pieces) - not the edges between them.
  const between = (e: Face['edges'][number]) => Fs.filter(face => face.edges.some(edge => edge.isSame(e))).length > 1;
  const outer = Fs.flatMap(face => face.edges).filter(e => !between(e));
  const edge: [Vec3, Vec3][] = outer.flatMap((e) => {
    const pts = Array.from({ length: 257 }, (_, i) => e.pointAt(i / 256).toTuple() as Vec3);

    return pts.slice(1).map((q, i) => [pts[i], q] as [Vec3, Vec3]);
  });
  const onPiece = (point: Vec3, [a, b]: [Vec3, Vec3]): Vec3 => {
    const segment = sub(b, a);
    const lengthSquared = dot(segment, segment);

    return add(a, scale(segment, lengthSquared > 0 ? Math.max(0, Math.min(1, dot(sub(point, a), segment) / lengthSquared)) : 0));
  };
  const nearest = (point: Vec3, pieces: [Vec3, Vec3][]) => {
    let best: Vec3 = point;
    let distance = Infinity;
    for (const q of pieces) {
      const at = onPiece(point, q);
      const e = dist(point, at);
      if (e < distance) {
        ((distance = e), (best = at));
      }
    }

    return { at: best, d: distance };
  };
  // The cage's border points onto the edge itself (they were laid on the
  // face as drawn on screen: a round edge's are a hair inside it).
  const borderVerts = new Set(boundaryEdges(cage).flat());
  const verts = cage.verts.map((vertex, i) => {
    if (!borderVerts.has(i)) {
      return vertex;
    }
    const hit = nearest(vertex, edge);
    if (hit.d > Math.max(0.2, size * 0.02)) {
      throw new Error('border off the edge');
    }

    return hit.at;
  });
  const through = borderThrough({ verts, faces: cage.faces });
  const subdivided = subdivide(through.cage, 3, through.sharp);
  subdivided.points = limitPoints(subdivided, through.sharp);
  // Its border against the face's edge, both ways round.
  const pieces = borderPieces(subdivided);
  for (const [a, b] of edge) {
    if (nearest(a, pieces).d > tol || nearest(b, pieces).d > tol) {
      throw new Error('border off the edge');
    }
  }
  for (const [a] of pieces) {
    if (nearest(a, edge).d > tol) {
      throw new Error('border off the edge');
    }
  }
  // Seen along the face's normal, all of it over the face. By an inward
  // corner of the outline a smooth surface swells a little past the edge (a
  // lip over it; pushed in, a cut through the wall): those points are drawn
  // back onto the edge, at their height. Far past it (a coarse cage whose
  // cells reach across the corner): not this way.
  const xDir = xDirFor(normal);
  const vAxis = norm(cross(normal, xDir));
  const flat = edge.map(([a, b]) => [dot(a, xDir), dot(a, vAxis), dot(b, xDir), dot(b, vAxis)]);
  const onBorder = new Set<Vec3>(pieces.flat());
  for (const [index, q] of subdivided.points.entries()) {
    // (The border is on the edge already.)
    if (onBorder.has(q)) {
      continue;
    }
    const x = dot(q, xDir);
    const y = dot(q, vAxis);
    let inside = false;
    for (const [ax, ay, bx, by] of flat) {
      if (ay > y !== by > y && x < ((bx - ax) * (y - ay)) / (by - ay) + ax) {
        inside = !inside;
      }
    }
    if (inside) {
      continue;
    }
    // (Counted along the other axis too: a ray through a corner of the outline, or along a piece of it, can miscount.)
    let also = false;
    for (const [ax, ay, bx, by] of flat) {
      if (ax > x !== bx > x && y < ((by - ay) * (x - ax)) / (bx - ax) + ay) {
        also = !also;
      }
    }
    if (also) {
      continue;
    }
    const height = dot(sub(q, edge[0][0]), normal);
    const hit = nearest(sub(q, scale(normal, height)), edge);
    if (hit.d > Math.max(0.5, size * 0.04)) {
      throw new Error('spills over the edge');
    }
    // (A little inside the edge, not on it: the surface between the points mustn't touch the wall below.)
    if (hit.d > tol / 4) {
      subdivided.points[index] = add(add(hit.at, scale(norm(sub(hit.at, sub(q, scale(normal, height)))), Math.max(0.05, size * 0.004))), scale(normal, height));
    }
  }
  const rim = edge;
  const sheet = cageToShape(through.cage, 3, undefined, subdivided);
  const progress = new oc.Message_ProgressRange();
  const sew = new oc.BRepBuilderAPI_Sewing(tol, true, true, true, false);
  try {
    const others = body.faces.filter(face => !Fs.some(picked => face.isSame(picked)));
    meetsOnlyAt(sheet.wrapped, others, rim, size);
    for (const other of others) {
      sew.Add(other.wrapped);
    }
    for (const face of sheet.faces) {
      sew.Add(face.wrapped);
    }
    sew.Perform(progress);
    const shells = subShapes(cast(sew.SewedShape()) as Shape3D, 'SHELL');
    if (shells.length !== 1) {
      throw new Error('sew');
    }
    const fix = new oc.ShapeFix_Solid();
    const made = fix.SolidFromShell(shells[0]);
    fix.delete();
    oc.BRepLib.OrientClosedSolid(oc.TopoDS.Solid(made));
    const solid = cast(made) as Shape3D;
    if (!(quickVolume(solid) > 0)) {
      throw new Error('volume');
    }
    if (!validNow(solid.wrapped)) {
      throw new Error('invalid');
    }

    return solid;
  } finally {
    sew.delete();
    progress.delete();
  }
}

/**
 * A new surface may meet the rest of the body only along the old face's
 * edges (`rim`): a point pushed through the far side passes the body's
 * checks, but crosses itself. Throws when it meets it anywhere else.
 */
function meetsOnlyAt(surface: unknown, others: Face[], rim: [Vec3, Vec3][], size: number): void {
  const away = (point: Vec3) => {
    let distance = Infinity;
    for (const [a, b] of rim) {
      const segment = sub(b, a);
      const lengthSquared = dot(segment, segment);
      distance = Math.min(distance, dist(point, add(a, scale(segment, lengthSquared > 0 ? Math.max(0, Math.min(1, dot(sub(point, a), segment) / lengthSquared)) : 0))));
    }

    return distance;
  };
  const oc = getOC();
  const progress = new oc.Message_ProgressRange();
  try {
    for (const other of others) {
      const sec = new oc.BRepAlgoAPI_Section();
      try {
        sec.Init1(surface as never);
        sec.Init2(other.wrapped);
        sec.Build(progress);
        const cut = cast(sec.Shape());
        for (const e of 'edges' in cut ? cut.edges : []) {
          for (const t of [0.25, 0.5, 0.75]) {
            const point = e.pointAt(t).toTuple() as Vec3;
            if (away(point) > Math.max(0.05, size * 0.01)) {
              throw new Error('crosses');
            }
          }
        }
      } finally {
        sec.delete();
      }
    }
  } finally {
    progress.delete();
  }
}

function filledFace(body: Shape3D, face: Face, points: Vec3[], degree: number): Shape3D {
  const oc = getOC();
  const fill = new oc.BRepOffsetAPI_MakeFilling(degree, 15, 2, false, 1e-5, 1e-4, 0.01, 0.1, 8, 9);
  const progress = new oc.Message_ProgressRange();
  const sew = new oc.BRepBuilderAPI_Sewing(1e-4, true, true, true, false);
  try {
    for (const e of face.edges) {
      fill.Add(e.wrapped, oc.GeomAbs_Shape.GeomAbs_C0, true);
    }
    for (const point of points) {
      const polePoint = new oc.gp_Pnt(point[0], point[1], point[2]);
      fill.Add(polePoint);
      polePoint.delete();
    }
    fill.Build(progress);
    if (!fill.IsDone()) {
      throw new Error('fill');
    }
    const filled = fill.Shape();
    const others = body.faces.filter(otherFace => !otherFace.isSame(face));
    // The new surface may meet the rest of the body only along its own edges
    // (a point pushed through the far side passes the body's checks, but
    // crosses itself).
    const rim = face.edges.flatMap(e => Array.from({ length: 41 }, (_, i) => e.pointAt(i / 40).toTuple() as Vec3));
    const size = Math.sqrt(measureArea(face));
    for (const other of others) {
      const sec = new oc.BRepAlgoAPI_Section();
      try {
        sec.Init1(filled);
        sec.Init2(other.wrapped);
        sec.Build(progress);
        const cut = cast(sec.Shape());
        for (const e of 'edges' in cut ? cut.edges : []) {
          for (const t of [0.25, 0.5, 0.75]) {
            const point = e.pointAt(t).toTuple() as Vec3;
            if (Math.min(...rim.map(q => dist(point, q))) > Math.max(0.05, size * 0.01)) {
              throw new Error('crosses');
            }
          }
        }
      } finally {
        sec.delete();
      }
    }
    for (const other of others) {
      sew.Add(other.wrapped);
    }
    sew.Add(filled);
    sew.Perform(progress);
    const shells = subShapes(cast(sew.SewedShape()) as Shape3D, 'SHELL');
    if (shells.length !== 1) {
      throw new Error('sew');
    }
    const fix = new oc.ShapeFix_Solid();
    const made = fix.SolidFromShell(shells[0]);
    fix.delete();
    oc.BRepLib.OrientClosedSolid(oc.TopoDS.Solid(made));
    const solid = cast(made) as Shape3D;
    if (!(quickVolume(solid) > 0)) {
      throw new Error('volume');
    }

    return solid;
  } finally {
    fill.delete();
    sew.delete();
    progress.delete();
  }
}

/**
 * Replace flat face F's plane with `to` (move/tilt); neighbours extend or trim.
 * Round blends (fillets) on F are taken off first and put back at the same
 * radius afterwards - extending a fillet's cylinder through the body would
 * carve a tunnel into it.
 */
export function replaceFacePlane(body: Shape3D, face: Face, to: PlaneDef): Shape3D {
  if (face.geomType !== 'PLANE') {
    throw new Error('Only flat faces can be moved or tilted');
  }
  const blends = blendsOf(body, face);
  if (blends.length) {
    // Never straight through a fillet: that leaves its old round face standing
    // in the body (a tunnel or a wall where the fillet was).
    try {
      return aroundBlends(body, face, blends, to);
    } catch {
      // A fillet running along this face can't be gone through; one that only ends on it can.
      if (blends.some(b => b.sides[0] === null)) {
        throw new Error("This face can't be moved cleanly around its fillet - try a smaller value, or remove the fillet first");
      }
    }
  }
  // A face with inward corners moved straight along its normal: edge by edge
  // (the half-space trick would clip it to its convex part).
  const old = planeOf(face);
  const nn = norm(to.normal);
  if (Math.abs(dot(nn, old.normal)) > 1 - 1e-9 && !convexFace(face) && !face.clone().innerWires().length) {
    const distance = dot(sub(to.origin, old.origin), old.normal);
    if (Math.abs(distance) < 1e-12) {
      return body;
    }
    try {
      return offsetByContinuation(body, face, distance);
    } catch {
      // fall back below
    }
  }

  return replacePlaneDirect(body, face, to);
}

interface Blend {
  r: number;
  /** The two flat faces the fillet runs between; `null` stands for the face being moved. */
  sides: [PlaneDef | null, PlaneDef];
  /** The blend's own signature, to find it again after earlier edits. */
  sig: { center: Vec3; area: number };
}

/** Is cylinder `cy` tangent to plane `pl` (a fillet's support face)? */
function tangentTo(cy: Cyl, pl: PlaneDef, tol: number): boolean {
  return Math.abs(dot(cy.a, pl.normal)) < 1e-6 && Math.abs(Math.abs(dot(sub(cy.c, pl.origin), pl.normal)) - cy.r) < cy.r * 1e-4 + tol;
}

/**
 * Fillets touching `face`: round faces next to it that run between two flat faces
 * (F itself may be one of them). They get taken off and put back around an edit.
 */
function blendsOf(body: Shape3D, face: Face): Blend[] {
  const tol = sizeOf(body) * 1e-7;
  const out: Blend[] = [];
  for (const neighbour of neighbours(body, face)) {
    if (neighbour.geomType !== 'CYLINDRE') {
      continue;
    }
    const cy = cylinderOf(neighbour);
    if (!cy) {
      continue;
    }
    const supports = neighbours(body, neighbour).filter(support => support.geomType === 'PLANE' && tangentTo(cy, planeOf(support), tol));
    if (supports.length !== 2) {
      continue;
    }
    const planes = supports.map(support => (support.isSame(face) ? null : planeOf(support)));
    // Keep F (if it is one) first.
    const sides = (planes[1] === null ? [planes[1], planes[0]] : planes) as [PlaneDef | null, PlaneDef];
    if (sides[1] === null) {
      continue;
    }
    out.push({ r: cy.r, sides, sig: { center: tup(neighbour.center), area: measureArea(neighbour) } });
  }

  return out;
}

function aroundBlends(body: Shape3D, face: Face, blends: Blend[], to: PlaneDef): Shape3D {
  const fp = planeOf(face);
  let b = body;
  // 1. Take the fillets off (their faces meet in sharp edges again).
  for (const bl of blends) {
    const blend = findFace(b, candidate => candidate.geomType === 'CYLINDRE', bl.sig.center, bl.sig.area);
    if (!blend) {
      throw new Error('blend lost');
    }
    try {
      b = takeOffBlend(b, blend);
    } catch {
      // That way can't (a fillet between faces at an odd angle): as if it was never there.
      b = deleteFaces(b, [blend]);
    }
  }
  // 2. Move the face, now bounded by flat neighbours only.
  const F1 = findFace(b, candidate => candidate.geomType === 'PLANE' && Math.abs(dot(planeOf(candidate).normal, fp.normal)) > 1 - 1e-9 && Math.abs(dot(sub(planeOf(candidate).origin, fp.origin), fp.normal)) < sizeOf(b) * 1e-7, tup(face.center), measureArea(face));
  if (!F1) {
    throw new Error('face lost');
  }
  b = replacePlaneDirect(b, F1, to);
  // 3. Round the edges between each fillet's two faces again, same radius.
  const moved: PlaneDef = { ...to, normal: norm(to.normal) };
  const tol = sizeOf(b) * 1e-6;
  const on = (point: Vec3, pl: PlaneDef) => Math.abs(dot(sub(point, pl.origin), norm(pl.normal))) < tol;
  for (const bl of blends) {
    const p1 = bl.sides[0] ?? moved;
    const p2 = bl.sides[1];
    const edges = b.edges.filter((e) => {
      // All along it, not just its middle (another edge's middle can happen to sit on both planes).
      return [0.15, 0.5, 0.85].every((t) => {
        const point = tup(e.pointAt(t));

        return on(point, p1) && on(point, p2);
      });
    });
    if (!edges.length) {
      throw new Error('edge lost');
    }
    try {
      b = b.fillet(bl.r, finder => finder.inList(edges)) as Shape3D;
    } catch {
      // It doesn't fit any more (the faces got too small for it): the edge stays sharp, and History says so.
      editNotes.push(`The ${fmtR(bl.r)} fillet next to this face doesn't fit any more, so that edge is sharp now.`);
    }
  }

  return sanity(body, b);
}

/** Things an edit had to give up on without failing (shown as a note on the step in History). */
export const editNotes: string[] = [];
const fmtR = (radius: number) => `R${Math.round(radius * 1000) / 1000} mm`;

/** Does `face` have fillets on it (it's moved around them, never straight through)? */
export function hasBlends(body: Shape3D, face: Face): boolean {
  // Only fillets that run along `face` (`face` is one of the two faces they round off):
  // one that just ends on `face` is fine to push straight past.
  return face.geomType === 'PLANE' && blendsOf(body, face).some(b => b.sides[0] === null);
}

/** The face that passes `ok`, nearest a remembered centre (and area). */
function findFace(body: Shape3D, ok: (f: Face) => boolean, center: Vec3, area: number): Face | null {
  let best: { f: Face; s: number } | null = null;
  const size = Math.sqrt(area) || 1;
  for (const face of body.faces) {
    if (!ok(face)) {
      continue;
    }
    const score = dist(tup(face.center), center) / size + Math.abs(Math.log((measureArea(face) + 1e-12) / (area + 1e-12)));
    if (!best || score < best.s) {
      best = { f: face, s: score };
    }
  }

  return best?.f ?? null;
}

function replacePlaneDirect(body: Shape3D, face: Face, to: PlaneDef): Shape3D {
  const reach = sizeOf(body) * 4;
  const shape = faceColumn(body, face, reach);
  const behind = (pl: PlaneDef) => halfSpace({ ...pl, normal: scale(pl.normal, -1), xDir: xDirFor(scale(pl.normal, -1)) }, reach);
  const front = (pl: PlaneDef) => halfSpace(pl, reach);
  const old = planeOf(face);
  const neu: PlaneDef = { ...to, normal: norm(to.normal), xDir: xDirFor(norm(to.normal)) };
  let out = body;
  const grow = shape.intersect(front(old)).intersect(behind(neu));
  if (!isEmpty(grow)) {
    out = out.fuse(grow);
  }
  const shrink = shape.intersect(behind(old)).intersect(front(neu));
  if (!isEmpty(shrink)) {
    out = out.cut(shrink);
  }

  return sanity(body, out);
}

/**
 * The space a face's neighbours enclose around it, carried on along their
 * own surfaces. A face with inward corners (an L, a notch cut into it) isn't
 * one convex piece: its neighbours' surfaces cut its plane into cells, and the
 * face is exactly the cells it covers - so take each of those (points spread
 * over the face tell which) and join them.
 */
function faceColumn(body: Shape3D, face: Face, reach: number): Shape3D {
  const { p, n } = onFace(body, face);
  const lift = sizeOf(body) * 1e-3;
  const q0 = sub(p, scale(n, lift));
  if (face.geomType === 'PLANE' && convexFace(face)) {
    return extendedRegion(body, face, q0, reach);
  }
  const holed = face.geomType === 'PLANE' ? framedColumn(body, face, n, lift, reach) : null;
  if (holed) {
    return holed;
  }
  const tol = sizeOf(body) * 1e-6;
  const sides = neighbours(body, face).map((neighbour): ((q: Vec3) => number) | null => {
    if (neighbour.geomType === 'PLANE') {
      const pl = planeOf(neighbour);

      return q => dot(sub(q, pl.origin), pl.normal);
    }
    if (neighbour.geomType === 'CYLINDRE') {
      const cy = cylinderOf(neighbour);
      if (!cy) {
        return null;
      }

      return (q) => {
        const rel = sub(q, cy.c);

        return len(sub(rel, scale(cy.a, dot(rel, cy.a)))) - cy.r;
      };
    }

    return null;
  });
  const t = faceTriangles(face, sizeOf(body));
  if (!t) {
    return extendedRegion(body, face, q0, reach);
  }
  const vertexAt = (i: number): Vec3 => [t!.vertices[3 * i], t!.vertices[3 * i + 1], t!.vertices[3 * i + 2]];
  const cells = new Map<string, Vec3>();
  const parts = new Map<string, Vec3[]>();
  for (let index = 0; index < t.trianglesIndexes.length; index += 3) {
    const [a, b, vertexC] = [0, 1, 2].map(j => vertexAt(t!.trianglesIndexes[index + j]));
    // The middle and near each corner: a triangle may straddle a line where a neighbour's surface crosses the face.
    for (const [wa, wb, wc] of [[1 / 3, 1 / 3, 1 / 3], [0.8, 0.1, 0.1], [0.1, 0.8, 0.1], [0.1, 0.1, 0.8]]) {
      const on = add(add(scale(a, wa), scale(b, wb)), scale(vertexC, wc));
      // Just inside the material: along the face's own normal there (a round face's turns).
      let nq = n;
      if (face.geomType !== 'PLANE') {
        try {
          nq = norm(tup(face.normalAt(on)));
        } catch {
          continue;
        }
      }
      const q = sub(on, scale(nq, lift));
      const ds = sides.map(side => (side ? side(q) : 0));
      if (ds.some((distance, i) => sides[i] && Math.abs(distance) < tol)) {
        continue;
      }
      const key = ds.map((distance, i) => (!sides[i] ? '' : distance < 0 ? '-' : '+')).join('');
      if (!cells.has(key)) {
        cells.set(key, q);
      }
      (parts.get(key) ?? parts.set(key, []).get(key)!).push(on);
    }
  }
  if (cells.size <= 1) {
    return extendedRegion(body, face, q0, reach);
  }
  let region: Shape3D | null = null;
  for (const [key, q] of cells) {
    const shape = extendedRegion(body, face, q, reach, parts.get(key));
    region = region ? fuseCells(region, shape) : shape;
  }

  return region!;
}

/**
 * A flat face with holes whose outline and holes are each convex (a rim left
 * round an opening, a plate with a window): the space its outline's
 * neighbours enclose, less the space each hole's neighbours enclose. Null for
 * any other face. (Cutting it into cells by every neighbour's surface and
 * joining them again failed on such a rim.)
 */
function framedColumn(body: Shape3D, face: Face, normal: Vec3, lift: number, reach: number): Shape3D | null {
  const holes = face.clone().innerWires();
  if (!holes.length) {
    return null;
  }
  const outer = face.clone().outerWire();
  const wireFace = (wire: typeof outer): Face | null => {
    try {
      return makeFace(wire);
    } catch {
      return null;
    }
  };
  const loops = [outer, ...holes].map(wire => ({ w: wire, f: wireFace(wire) }));
  if (loops.some(loop => !loop.f || !convexFace(loop.f))) {
    return null;
  }
  const all = neighbours(body, face);
  const along = (wire: typeof outer) => all.filter(neighbour => neighbour.edges.some(e => wire.edges.some(we => we.isSame(e))));
  // A point inside a convex loop, just under `face`.
  const inside = (wire: typeof outer): Vec3 => {
    const pts = wire.edges.flatMap(e => [0, 0.5].map(t => tup(e.pointAt(t))));
    const center = scale(pts.reduce((a, b) => add(a, b), [0, 0, 0] as Vec3), 1 / pts.length);

    return sub(center, scale(normal, lift));
  };
  try {
    let shape = regionAround(body, face, along(outer), inside(outer), reach);
    for (const hole of holes) {
      shape = shape.cut(regionAround(body, face, along(hole), inside(hole), reach));
    }

    return isEmpty(shape) ? null : shape;
  } catch {
    return null;
  }
}

/**
 * Two of a face's cells joined. They meet face to face, and the plain join
 * can fail on that (a U-shaped rim across a shell's walls): then once more
 * with a small tolerance, which lets the shared faces be one.
 */
function fuseCells(a: Shape3D, b: Shape3D): Shape3D {
  try {
    return a.fuse(b);
  } catch (err) {
    const oc = getOC();
    const algo = new oc.BRepAlgoAPI_Fuse();
    const args = new oc.NCollection_List_TopoDS_Shape();
    const tools = new oc.NCollection_List_TopoDS_Shape();
    try {
      args.Append(a.wrapped);
      tools.Append(b.wrapped);
      algo.SetArguments(args);
      algo.SetTools(tools);
      algo.SetFuzzyValue(Math.max(1e-7, Math.max(sizeOf(a), sizeOf(b)) * 1e-6));
      algo.SetNonDestructive(true);
      algo.Build(new oc.Message_ProgressRange());
      if (!algo.IsDone()) {
        throw err;
      }

      return cast(algo.Shape()) as Shape3D;
    } finally {
      algo.delete();
      args.delete();
      tools.delete();
    }
  }
}

/** Does a flat face's outline turn the same way at every corner (no inward corners, no holes)? */
export function convexFace(face: Face): boolean {
  if (face.clone().innerWires().length) {
    return false;
  }
  const normal = planeOf(face).normal;
  const edges = face.clone().outerWire().edges;
  if (edges.length < 3) {
    return true;
  }
  // The outline as points in order (curved edges sampled), walked end to end.
  const tol = 1e-6 * (1 + len(tup(face.center)) + Math.sqrt(measureArea(face)));
  const pts: Vec3[] = [];
  const used = new Set<number>();
  let at = tup(edges[0].startPoint);
  for (let step = 0; step < edges.length; step++) {
    const index = edges.findIndex((e, i) => !used.has(i) && (dist(tup(e.startPoint), at) < tol || dist(tup(e.endPoint), at) < tol));
    if (index < 0) {
      return false;
    }
    used.add(index);
    const e = edges[index];
    const rev = dist(tup(e.startPoint), at) >= tol;
    const samples = e.geomType === 'LINE' ? 1 : 8;
    for (let j = 0; j < samples; j++) {
      pts.push(tup(e.pointAt(rev ? 1 - j / samples : j / samples)));
    }
    at = tup(rev ? e.startPoint : e.endPoint);
  }
  let sign = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const point = pts[(i + 2) % pts.length];
    const t = dot(cross(sub(b, a), sub(point, b)), normal);
    if (Math.abs(t) < tol * tol) {
      continue;
    }
    if (sign && Math.sign(t) !== sign) {
      return false;
    }
    sign = Math.sign(t);
  }

  return true;
}

/**
 * Neighbours that the half-space trick can't extend: curved surfaces other
 * than cylinders standing straight on F (cones, lofted and revolved sides…).
 */
function needsContinuation(body: Shape3D, face: Face): boolean {
  const normal = planeOf(face).normal;

  return neighbours(body, face).some((neighbour) => {
    if (neighbour.geomType === 'PLANE') {
      return false;
    }
    if (neighbour.geomType === 'CYLINDRE') {
      const cy = cylinderOf(neighbour);

      // Upright walls, or fillets running along F (taken off and put back).
      return !cy || (Math.abs(Math.abs(dot(cy.a, normal)) - 1) > 1e-6 && Math.abs(dot(cy.a, normal)) > 1e-6);
    }

    return true;
  });
}

/** A face pulled past where its sides meet (a cone's end pulled past its point). */
export const SIDES_MEET = 'Pulled this far, its sides would meet in a point (they lean in) - pull it less, or draw the shape on the face and extrude that for straight sides';

/**
 * Offset flat face F by d when its neighbours are curved: each point of F's
 * outline carries on along its neighbour surface (the way that surface is
 * heading there) until it is d further out; the slab between the old and the
 * new outline is added (d > 0) or taken away (d < 0).
 */
function offsetByContinuation(body: Shape3D, face: Face, distance: number): Shape3D {
  const fp = planeOf(face);
  const normal = fp.normal;
  const size = sizeOf(body);
  const tol = size * 1e-6;
  const nbrs = neighbours(body, face);
  // The slab between one of F's outlines (its outer one, or a hole's) and
  // where that outline goes: the outline as a loop of edges, end to end.
  const column = (edges: Edge[]): Shape3D => {
    const ends = (e: { startPoint: { toTuple(): number[] }; endPoint: { toTuple(): number[] } }): [Vec3, Vec3] => [e.startPoint.toTuple() as Vec3, e.endPoint.toTuple() as Vec3];
    const order: { k: number; rev: boolean }[] = [{ k: 0, rev: false }];
    const used = new Set([0]);
    let at = ends(edges[0])[1];
    while (used.size < edges.length) {
      const index = edges.findIndex((e, i) => !used.has(i) && ends(e).some(q => dist(q, at) < tol * 10));
      if (index < 0) {
        throw new Error('outline not closed');
      }
      used.add(index);
      const [a, b] = ends(edges[index]);
      const rev = dist(b, at) < dist(a, at);
      order.push({ k: index, rev });
      at = rev ? a : b;
    }
    // Where a point on edge `edgeIndex` goes: along its neighbour, across the edge, out of F's plane.
    // Cutting: the cutter reaches a hair past the walls and above `face`, so no sliver stays on the coincident surfaces.
    const eps = distance < 0 ? size * 1e-4 : 0;
    const outward = (edgeIndex: number, t: number): Vec3 => {
      const e = edges[edgeIndex];
      const neighbour = nbrs.find(candidate => candidate.edges.some(he => he.isSame(e)))!;
      const ng = norm(tup(neighbour.normalAt(tup(e.pointAt(t)))));
      const flat = sub(ng, scale(normal, dot(ng, normal)));

      return len(flat) < 1e-9 ? [0, 0, 0] : scale(norm(flat), eps);
    };
    const movedAt = (edgeIndex: number, t: number): Vec3 => {
      const e = edges[edgeIndex];
      const neighbour = nbrs.find(candidate => candidate.edges.some(he => he.isSame(e)));
      if (!neighbour) {
        throw new Error('no neighbour');
      }
      const point = tup(e.pointAt(t));
      const dt = 1e-3;
      const tangent = norm(sub(tup(e.pointAt(Math.min(1, t + dt))), tup(e.pointAt(Math.max(0, t - dt)))));
      // Just inside the edge on `neighbour`: its normal there (exactly on the edge it can be the other face's).
      const ng = norm(tup(neighbour.normalAt(point)));
      let dir = norm(cross(ng, tangent));
      if (dot(dir, normal) < 0) {
        dir = scale(dir, -1);
      }
      const rise = dot(dir, normal);
      if (rise < 0.15) {
        throw new Error('neighbour runs along the face');
      }

      return add(add(point, scale(dir, distance / rise)), outward(edgeIndex, t));
    };
    const liftedAt = (edgeIndex: number, t: number): Vec3 => add(add(tup(edges[edgeIndex].pointAt(t)), scale(normal, eps)), outward(edgeIndex, t));
    // Corners: shared by two edges. Where the two neighbours meet along an edge
    // of the body (a box's corner edge), the corner slides along that edge to
    // the new plane - it stays on both neighbours. Each neighbour on its own
    // would move it its own way (a wall at 45° and one square to `face` disagree,
    // and halfway between them leaves both: slanted slivers stood up as fins).
    // Without such an edge: halfway between their two estimates.
    // Do the sides meet on the way (a cone's end pulled past its point)? Each
    // point of the outline goes in a straight line, so the area inside it is a
    // quadratic in how far it has gone: down to nothing on the way, or turned
    // inside out, and what's left is an hourglass (or nothing at all: the
    // kernel gave the body back unchanged, without a word).
    {
      const xDir = xDirFor(normal);
      const vAxis = cross(normal, xDir);
      const ps: Vec3[] = [];
      const vs: Vec3[] = [];
      for (const { k, rev } of order) {
        for (let j = 0; j < 8; j++) {
          const t = rev ? 1 - j / 8 : j / 8;
          const point = tup(edges[k].pointAt(t));
          ps.push(point);
          vs.push(sub(movedAt(k, t), point));
        }
      }
      const areaAt = (shift: number) => {
        let area = 0;
        for (let i = 0; i < ps.length; i++) {
          const j = (i + 1) % ps.length;
          const a = add(ps[i], scale(vs[i], shift));
          const b = add(ps[j], scale(vs[j], shift));
          area += dot(a, xDir) * dot(b, vAxis) - dot(b, xDir) * dot(a, vAxis);
        }

        return area / 2;
      };
      // (Counted the way round that makes it positive at the start.)
      const sg = Math.sign(areaAt(0)) || 1;
      const A0 = sg * areaAt(0);
      const Ah = sg * areaAt(0.5);
      const A1 = sg * areaAt(1);
      const qa = 2 * A1 - 4 * Ah + 2 * A0;
      const qb = 4 * Ah - A1 - 3 * A0;
      const sv = qa > 0 ? -qb / (2 * qa) : -1;
      const least = Math.min(A1, sv > 0 && sv < 1 ? qa * sv * sv + qb * sv + A0 : Infinity);
      if (A0 > 0 && least < A0 * 1e-3) {
        throw new Error(SIDES_MEET);
      }
    }
    const count = order.length;
    const fEdges = face.edges;
    const bodyEdges = body.edges.filter(e => !fEdges.some(fe => fe.isSame(e)));
    const alongEdge = (vector: Vec3): Vec3 | null => {
      for (const e of bodyEdges) {
        const [a, b] = ends(e);
        const atStart = dist(a, vector) < tol * 10;
        if (!atStart && dist(b, vector) >= tol * 10) {
          continue;
        }
        const dt = 1e-3;
        const q = tup(e.pointAt(atStart ? dt : 1 - dt));
        const dir = norm(sub(q, vector));
        const rise = dot(dir, normal);
        if (Math.abs(rise) < 0.15) {
          continue;
        }

        return add(vector, scale(dir, distance / rise));
      }

      return null;
    };
    const corner: Vec3[] = order.map(({ k, rev }, i) => {
      const prev = order[(i - 1 + count) % count];
      const a = movedAt(k, rev ? 1 : 0);
      const b = movedAt(prev.k, prev.rev ? 0 : 1);
      const end = ends(edges[k])[rev ? 1 : 0];

      return alongEdge(end) ?? scale(add(a, b), 0.5);
    });
    const lowerCorner: Vec3[] = order.map(({ k, rev }) => liftedAt(k, rev ? 1 : 0));
    const lowerEdges = eps
      ? order.map(({ k, rev }, i) => {
        // Cutting: F's outline nudged up and out (see eps).
        const c0 = lowerCorner[i];
        const c1 = lowerCorner[(i + 1) % count];
        if (edges[k].geomType === 'LINE') {
          return makeLine(c0, c1);
        }
        const pts: Vec3[] = [];
        for (let j = 0; j <= 24; j++) {
          pts.push(liftedAt(k, rev ? 1 - j / 24 : j / 24));
        }
        pts[0] = c0;
        pts[24] = c1;

        return makeBSplineApproximation(pts, { tolerance: size * 1e-6, degMax: 5, degMin: 2 });
      })
      : order.map(({ k }) => edges[k].clone());
    const upperEdges = order.map(({ k, rev }, i) => {
      const e = edges[k];
      const c0 = corner[i];
      const c1 = corner[(i + 1) % count];
      if (e.geomType === 'LINE') {
        return makeLine(c0, c1);
      }
      // A curved edge: a smooth curve through its moved points.
      const pts: Vec3[] = [];
      for (let j = 0; j <= 24; j++) {
        pts.push(movedAt(k, rev ? 1 - j / 24 : j / 24));
      }
      pts[0] = c0;
      pts[24] = c1;

      return makeBSplineApproximation(pts, { tolerance: size * 1e-6, degMax: 5, degMin: 2 });
    });
    const a = assembleWire(lowerEdges);
    const b = assembleWire(upperEdges);

    return loft(distance > 0 ? [a, b] : [b, a], { ruled: true }) as Shape3D;
  };
  let slab = column(face.clone().outerWire().edges);
  // A hole in `face` (or something standing on it): the slab stops at its walls,
  // carried on the same way. (Over the whole outline, a top pulled up closed
  // the hole through it with a lid; pushed down, it cut a boss off at its foot.)
  for (const hole of face.clone().innerWires()) {
    slab = slab.cut(column(hole.edges)) as Shape3D;
  }
  const out = distance > 0 ? body.fuse(slab) : body.cut(slab);

  return sanity(body, out);
}

/** Offset a face along its normal: flat faces move, cylinders change radius. */
export function offsetFace(body: Shape3D, face: Face, distance: number): Shape3D {
  // Curved neighbours, or a face with inward corners (a zigzag, an L): the
  // half-space trick would clip it to its convex part, so each edge carries on
  // along its own neighbour instead.
  // (A face with holes whose neighbours are flat or stand upright: the plane
  // trick first - it takes each hole's own walls on as they are, a round one
  // staying one true cylinder. Edge by edge is the way for it only if that fails.)
  const holed = face.geomType === 'PLANE' && face.clone().innerWires().length > 0;
  const curved = face.geomType === 'PLANE' && needsContinuation(body, face);
  if (face.geomType === 'PLANE' && (curved || (!holed && !convexFace(face)))) {
    try {
      return offsetByContinuation(body, face, distance);
    } catch (err) {
      // (Sides that meet meet with the plane trick too.)
      if (err instanceof Error && err.message === SIDES_MEET) {
        throw err;
      }
      // fall through to the plane trick
    }
  }
  if (holed && !curved) {
    const { origin, normal } = planeOf(face);
    try {
      return replaceFacePlane(body, face, { origin: add(origin, scale(normal, distance)), normal, xDir: xDirFor(normal) });
    } catch (err) {
      try {
        return offsetByContinuation(body, face, distance);
      } catch {
        throw err;
      }
    }
  }
  if (face.geomType === 'PLANE') {
    const { origin, normal } = planeOf(face);

    return replaceFacePlane(body, face, { origin: add(origin, scale(normal, distance)), normal, xDir: xDirFor(normal) });
  }
  const cy = cylinderOf(face);
  if (!cy) {
    throw new Error('Offset works on flat and cylindrical faces');
  }
  const r2 = cy.r + cy.s * distance;
  if (r2 <= 1e-6) {
    throw new Error('That offset would remove the whole round face');
  }
  const reach = sizeOf(body) * 4;
  // Bounded by its neighbours carried on (a round face swept past half a turn
  // isn't one wedge: the cells it covers, joined).
  const shape = faceColumn(body, face, reach);
  const ring = infiniteCylinder(cy, Math.max(cy.r, r2), reach).cut(infiniteCylinder(cy, Math.min(cy.r, r2), reach));
  const slab = shape.intersect(ring);
  if (isEmpty(slab)) {
    throw new Error('Nothing to offset');
  }
  if (distance < 0) {
    return sanity(body, body.cut(slab));
  }
  let out = body.fuse(slab);
  // Past where the round face ended there may be no material under it: the
  // ring added there would leave a hollow groove (its inside, on the old
  // surface, open to the air). Fill what's under those pieces too.
  const tol = sizeOf(body) * 1e-6;
  const onOld = (candidate: Face) => candidate.geomType === 'CYLINDRE' && samples(candidate).every(sample => Math.abs(radial(sample) - cy.r) < tol * 10);
  const radial = (point: Vec3) => {
    const rel = sub(point, cy.c);

    return len(sub(rel, scale(cy.a, dot(rel, cy.a))));
  };
  const left = out.faces.filter(onOld);
  if (left.length) {
    const under = shape.intersect(infiniteCylinder(cy, cy.r, reach)).cut(out);
    const pieces = isEmpty(under) ? [] : subShapes(under, 'SOLID').map((solid: any) => cast(solid) as Shape3D);
    for (const piece of pieces) {
      const touches = piece.faces.some(pieceFace => onOld(pieceFace) && left.some(leftFace => dist(tup(pieceFace.center), tup(leftFace.center)) < tol * 100 && Math.abs(measureArea(pieceFace) - measureArea(leftFace)) < measureArea(leftFace) * 1e-3 + tol));
      if (touches) {
        out = out.fuse(piece);
      }
    }
  }

  return sanity(body, out);
}

/**
 * Delete a face as if it had never been there: its neighbours carry on along
 * their own surfaces until they meet. A face that's part of a fillet (or any
 * smooth blend) that can't go on its own takes the whole blend with it.
 */
export function deleteFace(body: Shape3D, face: Face): Shape3D {
  try {
    return deleteFaces(body, samePieces(body, face));
  } catch (err) {
    const chain = blendChain(body, face);
    if (chain.length > 1) {
      try {
        return deleteFaces(body, chain);
      } catch {
        // try the whole fillet below
      }
    }
    // A fillet put on several edges at once meets itself at mitred corners
    // (no smooth run): all its pieces of the same radius go together.
    const group = filletGroup(body, face);
    if (group.length > chain.length) {
      return deleteFaces(body, group);
    }
    throw err;
  }
}

/**
 * `face` and the faces next to it on the very same surface (one round surface is
 * often split in two along its seam): they're one face to the user.
 */
function samePieces(body: Shape3D, face: Face): Face[] {
  const tol = sizeOf(body) * 1e-6;
  const out: Face[] = [face];
  // A round surface cut in pieces (by a seam, or a hole through a fillet) is
  // one feature wherever its pieces are; flat ones only where they touch (two
  // separate faces in one plane are often unrelated).
  const pool = face.geomType === 'PLANE' ? null : body.faces;
  for (let i = 0; i < out.length; i++) {
    for (const neighbour of pool ?? neighbours(body, out[i])) {
      if (neighbour.geomType !== face.geomType || out.some(face => face.isSame(neighbour))) {
        continue;
      }
      if (samples(neighbour).every(q => offSurface(face, q) < tol)) {
        out.push(neighbour);
      }
    }
  }

  return out;
}

/** Radius of a round face (cylinder), or null. */
function radiusOf(face: Face): number | null {
  return cylinderOf(face)?.r ?? null;
}

/**
 * The pieces of one fillet: F's smooth chain, plus round faces of the same
 * radius it meets (at a mitre) - and theirs, and so on.
 */
export function filletGroup(body: Shape3D, face: Face): Face[] {
  const radius = radiusOf(face);
  const out: Face[] = [...blendChain(body, face)];
  if (radius === null) {
    return out;
  }
  const tol = radius * 1e-4;
  for (let i = 0; i < out.length; i++) {
    for (const neighbour of neighbours(body, out[i])) {
      if (neighbour.geomType === 'PLANE' || out.some(face => face.isSame(neighbour))) {
        continue;
      }
      const rg = radiusOf(neighbour);
      if (rg !== null && Math.abs(rg - radius) < tol) {
        out.push(...blendChain(body, neighbour).filter(face => !out.some(other => other.isSame(face))));
      } else if (rg === null && tangentAlong(out[i], neighbour)) {
        out.push(neighbour);
      }
    }
  }

  return out;
}

/**
 * The smooth blend a face belongs to: it and the curved faces running on from
 * it with no crease (a fillet along several edges, its corner pieces).
 */
export function blendChain(body: Shape3D, face: Face): Face[] {
  if (face.geomType === 'PLANE') {
    return [face];
  }
  const out: Face[] = [face];
  for (let i = 0; i < out.length; i++) {
    const current = out[i];
    for (const neighbour of neighbours(body, current)) {
      if (neighbour.geomType === 'PLANE' || out.some(face => face.isSame(neighbour))) {
        continue;
      }
      if (tangentAlong(current, neighbour)) {
        out.push(neighbour);
      }
    }
  }

  return out;
}

/** Do two faces meet without a crease (same normal across their shared edge)? */
function tangentAlong(face: Face, other: Face): boolean {
  const shared = face.edges.find(e => other.edges.some(edge => edge.isSame(e)));
  if (!shared) {
    return false;
  }
  try {
    const point = tup(shared.pointAt(0.5));
    const nf = norm(tup(face.normalAt(point)));
    const ng = norm(tup(other.normalAt(point)));

    return dot(nf, ng) > 0.996;
  } catch {
    return false;
  }
}

/** How far a point is from a face's whole (untrimmed, extended) surface. */
function offSurface(face: Face, q: Vec3): number {
  const oc = getOC();
  const pt = new oc.gp_Pnt(q[0], q[1], q[2]);
  try {
    const proj = new oc.GeomAPI_ProjectPointOnSurf(pt, oc.BRep_Tool.Surface(face.wrapped), oc.Extrema_ExtAlgo.Extrema_ExtAlgo_Grad);
    try {
      return proj.NbPoints() ? proj.LowerDistance() : Infinity;
    } finally {
      proj.delete();
    }
  } catch {
    return Infinity;
  } finally {
    pt.delete();
  }
}

/** A few points spread over a face (on its surface). */
function samples(face: Face): Vec3[] {
  const out: Vec3[] = [];
  for (const [paramU, paramV] of [[0.5, 0.5], [0.2, 0.3], [0.8, 0.7], [0.3, 0.8], [0.7, 0.2]]) {
    try {
      out.push(tup(face.pointOnSurface(paramU, paramV)));
    } catch {
    /* off the face's range */
    }
  }

  return out;
}

/** Solid on the material side (behind the outward normal) of a face's surface - or null if that can't be made. */
function behind(face: Face, reach: number): Shape3D | null {
  if (face.geomType === 'PLANE') {
    const { origin, normal } = planeOf(face);

    return halfSpace({ origin, normal: scale(normal, -1), xDir: xDirFor(normal) }, reach);
  }
  if (face.geomType === 'CYLINDRE') {
    const cy = cylinderOf(face);
    if (!cy) {
      return null;
    }
    const inside = infiniteCylinder(cy, cy.r, reach);

    // A boss: the material is inside it; a hole: outside it.
    return cy.s > 0 ? inside : bigBox(reach, cy.c).cut(inside);
  }
  if (face.geomType === 'SPHERE') {
    const sp = sphereOf(face);
    if (!sp) {
      return null;
    }
    const ball = makeSphere(sp.r).translate(sp.c) as Shape3D;

    return sp.s > 0 ? ball : bigBox(reach, sp.c).cut(ball);
  }

  return null;
}

/** The air side of a face's surface (in front of it). */
function inFront(face: Face, reach: number): Shape3D | null {
  if (face.geomType === 'PLANE') {
    const { origin, normal } = planeOf(face);

    return halfSpace({ origin, normal, xDir: xDirFor(normal) }, reach);
  }
  const b = behind(face, reach);
  if (!b) {
    return null;
  }
  const center = face.boundingBox.center as Vec3;

  return bigBox(reach, center).cut(b);
}

function bigBox(reach: number, center: Vec3): Shape3D {
  const size = vary(reach);

  return halfSpace({ origin: sub(center, [0, 0, size]), xDir: [1, 0, 0], normal: [0, 0, 1] }, 2 * size);
}

/** Centre, radius and side of a spherical face (from two surface points and their normals). */
function sphereOf(face: Face): { c: Vec3; r: number; s: number } | null {
  const at = (paramU: number, paramV: number) => {
    const point = tup(face.pointOnSurface(paramU, paramV));

    return { p: point, n: norm(tup(face.normalAt(point))) };
  };
  const a = at(0.3, 0.4);
  const b = at(0.7, 0.6);
  const dn = len(sub(a.n, b.n));
  if (dn < 1e-9) {
    return null;
  }
  const radius = len(sub(a.p, b.p)) / dn;
  const cOut = sub(a.p, scale(a.n, radius));
  const cIn = add(a.p, scale(a.n, radius));
  const side = dist(cOut, sub(b.p, scale(b.n, radius))) < dist(cIn, add(b.p, scale(b.n, radius))) ? 1 : -1;

  return { c: side > 0 ? cOut : cIn, r: radius, s: side };
}

/**
 * Delete faces S together, as if they'd never been there: the gap they leave
 * is closed by their neighbours carried on along their own surfaces. Several
 * ways are tried - fill the space behind every neighbour (an outside fillet,
 * a chamfer, a hole), or take away what's in front of them (an inside fillet,
 * a boss) - bounded by S's own surface where it can be, else by a box round S.
 * One counts only if every face it leaves lies on a surface that was already
 * there (nothing new invented) and S is gone; the smallest change wins.
 */
export function deleteFaces(body: Shape3D, doomed: Face[]): Shape3D {
  const size = sizeOf(body);
  const extent = size * 4;
  const inS = (face: Face) => doomed.some(doomedFace => doomedFace.isSame(face));
  const touching = body.faces.filter(face => !inS(face) && doomed.some(doomedFace => neighbours(body, doomedFace).some(neighbour => neighbour.isSame(face))));
  if (!touching.length) {
    throw new Error("This face can't be removed - nothing around it to close the gap");
  }
  const kept = body.faces.filter(face => !inS(face));
  const tol = size * 1e-5;
  // Within the body's own extent (a little more): nothing is filled out into space.
  const bb = body.boundingBox;
  const lo = bb.bounds[0] as number[];
  const hi = bb.bounds[1] as number[];
  // Exactly its box: a fill ending flush with an outer face merges into it (a hair beyond would stick out).
  const pad = 0;
  const boxOf = (a: number[], b: number[]) =>
    basicFaceExtrusion(
      makePolygon([
        [a[0], a[1], a[2]],
        [b[0], a[1], a[2]],
        [b[0], b[1], a[2]],
        [a[0], b[1], a[2]]
      ]),
      new Vector([0, 0, b[2] - a[2]])
    );
  // Near `doomed`: its own box, a little bigger.
  const sLo = [0, 1, 2].map(axis => Math.min(...doomed.map(face => face.boundingBox.bounds[0][axis])) - size * 1e-3);
  const sHi = [0, 1, 2].map(axis => Math.max(...doomed.map(face => face.boundingBox.bounds[1][axis])) + size * 1e-3);
  const nearS = boxOf(sLo, sHi);
  // The corner a fillet rounded can stick out past the body's box (faces
  // meeting at an angle other than 90°): S's own size of room round it.
  const room = Math.hypot(sHi[0] - sLo[0], sHi[1] - sLo[1], sHi[2] - sLo[2]);
  const within = boxOf(
    lo.map((value, axis) => Math.min(value - pad, sLo[axis] - room)),
    hi.map((value, axis) => Math.max(value + pad, sHi[axis] + room))
  );

  const meet = (parts: (Shape3D | null)[]): Shape3D | null => {
    let result: Shape3D | null = null;
    for (const part of parts) {
      if (!part) {
        continue;
      }
      result = result ? result.intersect(part) : part;
      if (isEmpty(result)) {
        return null;
      }
    }

    return result;
  };
  /** Behind every neighbour (but `skip`): the space a fill may take. */
  const behindAll = (skip?: Face) => meet([within, ...touching.filter(face => face !== skip).map(face => behind(face, extent))]);
  /** In front of the given neighbours, behind the rest (but `skip`). */
  const frontOf = (front: (g: Face) => boolean, skip?: Face) => {
    let shape: Shape3D = within;
    for (const face of touching) {
      if (face === skip) {
        continue;
      }
      const b = behind(face, extent);
      if (!b) {
        continue;
      }
      shape = front(face) ? shape.cut(b) : shape.intersect(b);
      if (isEmpty(shape)) {
        return null;
      }
    }

    return shape;
  };
  // Faces `doomed` runs smoothly into (a fillet's walls) - not the ones it ends on.
  const tangent = new Set(touching.filter(face => doomed.some(doomedFace => tangentAlong(doomedFace, face))));
  const single = doomed.length === 1 ? doomed[0] : null;
  // A round fillet's corner lies beyond its chord - the plane through the two
  // lines where it meets its walls - on the side away from its axis: the
  // space it rounded off is between the fillet and that corner, nowhere else.
  const chord = (): Shape3D | null => {
    if (!single || single.geomType !== 'CYLINDRE') {
      return null;
    }
    const cy = cylinderOf(single);
    const walls = [...tangent].filter(face => face.geomType === 'PLANE');
    if (!cy || walls.length !== 2) {
      return null;
    }
    const on = walls.map(wall => single.edges.find(e => wall.edges.some(edge => edge.isSame(e))));
    if (on.some(e => !e)) {
      return null;
    }
    const p1 = tup(on[0]!.pointAt(0.5));
    const p2 = tup(on[1]!.pointAt(0.5));
    let normal = cross(cy.a, sub(p2, p1));
    if (len(normal) < 1e-12) {
      return null;
    }
    normal = norm(normal);
    // Away from the axis.
    if (dot(sub(cy.c, p1), normal) > 0) {
      normal = scale(normal, -1);
    }

    return halfSpace({ origin: p1, normal: normal, xDir: xDirFor(normal) }, extent);
  };
  const airOfS = () => (single ? meet([inFront(single, extent) ?? nearS, chord()]) : nearS);
  const matOfS = () => (single ? meet([behind(single, extent) ?? nearS, chord()]) : nearS);
  const fill = (e: Shape3D | null, bound: Shape3D | null) => (e && bound ? body.fuse(meet([e, bound])!) : null);
  const cut = (e: Shape3D | null, bound: Shape3D | null) => (e && bound ? body.cut(meet([e, bound])!) : null);
  // Each neighbour bounded on the side `doomed` itself is on: a fillet's walls from
  // behind (or in front, for an inside one), its end faces towards it -
  // whichever way they face (one may be a pocket's wall facing the fillet).
  const mid = tup(doomed[0].pointOnSurface(0.5, 0.5));
  const bySide = () => {
    let shape: Shape3D = within;
    for (const face of touching) {
      const b = behind(face, extent);
      if (!b) {
        continue;
      }
      let front = false;
      if (face.geomType === 'PLANE') {
        const { origin, normal } = planeOf(face);
        front = dot(sub(mid, origin), normal) > tol;
      }
      shape = front ? shape.cut(b) : shape.intersect(b);
      if (isEmpty(shape)) {
        return null;
      }
    }

    return shape;
  };
  const candidates: { name: string; make: () => Shape3D | null }[] = [
    { name: 'fill by side', make: () => fill(bySide(), airOfS()) },
    { name: 'cut by side', make: () => cut(bySide(), matOfS()) },
    // Fill: behind every neighbour, on the air side of `doomed` (a fillet's wedge, a chamfer, a hole).
    { name: 'fill', make: () => fill(behindAll(), airOfS()) },
    { name: 'fill near', make: () => fill(behindAll(), nearS) },
    // Take away: in front of the faces `doomed` blends into (and behind the ones it ends on), on `doomed`'s material side (an inside fillet).
    { name: 'cut blend', make: () => (tangent.size ? cut(frontOf(face => tangent.has(face)), matOfS()) : null) },
    // …or in front of all of them (a boss).
    { name: 'cut', make: () => cut(frontOf(() => true), matOfS()) },
    // One neighbour that goes along with `doomed` (a blind hole's floor, a boss's top): left out.
    ...touching.flatMap(face => [
      { name: 'fill but one', make: () => fill(behindAll(face), airOfS()) },
      { name: 'cut but one', make: () => cut(frontOf(() => true, face), matOfS()) }
    ])
  ];
  const v0 = Math.abs(measureVolume(body));
  const keptInfo = kept.map(face => ({ f: face, t: face.geomType, box: face.boundingBox.bounds as number[][], next: touching.some(neighbour => neighbour.isSame(face)), area: measureArea(face) }));
  const boxesMeet = (a: number[][], b: number[][], e: number) => [0, 1, 2].every(axis => a[0][axis] <= b[1][axis] + e && b[0][axis] <= a[1][axis] + e);
  let best: { out: Shape3D; change: number } | null = null;
  for (const candidate of candidates) {
    let out: Shape3D | null = null;
    try {
      out = candidate.make();
      if (out) {
        out = unify(out, size);
      }
    } catch {
      out = null;
    }
    if (!out || isEmpty(out)) {
      continue;
    }
    // The result's faces, read once (each read of out.faces makes them anew,
    // and the checks below went over them for every face of the body: deleting
    // one hole in a jet engine's casing took 8 s).
    const outFaces = out.faces.map(face => ({ g: face, t: face.geomType, pts: samples(face), box: face.boundingBox.bounds as number[][] }));
    // Nothing new: every face lies on a surface the body already had (S's aside).
    const honest = outFaces.every(({ t, pts }) => keptInfo.some(info => info.t === t && pts.every(q => offSurface(info.f, q) < tol)));
    if (!honest) {
      continue;
    }
    // And `doomed` is gone: no face left on `doomed`'s surface that isn't also on a kept one's.
    const left = outFaces.some(({ t, pts }) => doomed.some(face => face.geomType === t && pts.every(q => offSurface(face, q) < tol)) && !keptInfo.some(info => info.t === t && pts.every(q => offSurface(info.f, q) < tol)));
    if (left) {
      continue;
    }
    // The faces `doomed` ran smoothly into carry on: they're still there (deleting a
    // fillet never takes away the walls it rounded).
    const walls = [...tangent].every(face => outFaces.some(outFace => outFace.t === face.geomType && outFace.pts.every(q => offSurface(face, q) < tol)) && samples(face).length > 0);
    if (!walls) {
      continue;
    }
    // Every face that wasn't next to `doomed` is still there (on its own surface):
    // deleting a big wall must not just keep some other piece of the part.
    // (Only the result's faces overlapping it can be it.)
    const stays = keptInfo.every((info) => {
      if (info.next) {
        return true;
      }
      // (most of it: a scrap on the same plane doesn't count)
      const on = outFaces.filter(outFace => outFace.t === info.t && boxesMeet(outFace.box, info.box, tol) && outFace.pts.every(q => offSurface(info.f, q) < tol));

      return on.reduce((a, hit) => a + measureArea(hit.g), 0) >= info.area * 0.5;
    });
    if (!stays) {
      continue;
    }
    const change = Math.abs(Math.abs(measureVolume(out)) - v0);
    if (!(change > v0 * 1e-9)) {
      continue;
    }
    // Only what was round `doomed` changed: what was added or taken away lies within
    // S's own box (a "delete" that carves off half the part isn't one).
    try {
      const reach = room;
      for (const shape of [out.cut(body), body.cut(out)]) {
        if (isEmpty(shape) || Math.abs(measureVolume(shape)) < v0 * 1e-9) {
          continue;
        }
        const db = shape.boundingBox.bounds;
        if ([0, 1, 2].some(axis => db[0][axis] < sLo[axis] - reach || db[1][axis] > sHi[axis] + reach)) {
          throw new Error('reaches out');
        }
      }
    } catch {
      continue;
    }
    if (!best || change < best.change) {
      best = { out, change };
    }
  }
  if (!best) {
    throw new Error(doomed.length > 1 ? "This fillet can't be removed - the faces around it don't meet up when carried on" : "This face can't be removed - its neighbours don't close the gap");
  }

  return sanity(body, best.out);
}

/**
 * Take one fillet piece off while moving a face around it (Offset Face): the
 * original fill-or-cut within the piece's own box, which that step is tuned for.
 */
function takeOffBlend(body: Shape3D, face: Face): Shape3D {
  const reach = sizeOf(body) * 4;
  const { p, n } = onFace(body, face);
  const q = sub(p, scale(n, sizeOf(body) * 1e-3));
  // Only fill within the face's own box: the gap a face leaves lies inside it, and
  // any slack either falls inside the material or is cut off by a neighbour.
  const b = face.boundingBox;
  const lo = b.bounds[0] as number[];
  const hi = b.bounds[1] as number[];
  const pad = sizeOf(body) * 1e-3;
  const box = makePolygon([
    [lo[0] - pad, lo[1] - pad, lo[2] - pad],
    [hi[0] + pad, lo[1] - pad, lo[2] - pad],
    [hi[0] + pad, hi[1] + pad, lo[2] - pad],
    [lo[0] - pad, hi[1] + pad, lo[2] - pad]
  ]);
  const local = basicFaceExtrusion(box, new Vector([0, 0, hi[2] - lo[2] + 2 * pad]));
  const region = extendedRegion(body, face, q, reach).intersect(local);
  // Still has the face (or a copy of it a hair away): that way doesn't close the gap.
  const fn = norm(tup(face.normalAt()));
  const gone = (out: Shape3D) =>
    !out.faces.some(resultFace => resultFace.geomType === face.geomType && dot(norm(tup(resultFace.normalAt())), fn) > 0.999 && dist(tup(resultFace.center), tup(face.center)) < sizeOf(body) * 0.02);
  // A face on an outside corner (convex fillet, chamfer, hole wall) left material
  // out: fill it back in. One in an inside corner (concave fillet) added material:
  // take it away. Both are tried; the smallest change that removes the face wins.
  const v0 = measureVolume(body);
  const tries: { out: Shape3D; change: number }[] = [];
  for (const make of [() => body.fuse(region), () => body.cut(region)]) {
    try {
      const out = unify(make());
      // Removing a face never needs new faces: one that adds some cut a new shape in.
      if (!isEmpty(out) && gone(out) && out.faces.length < body.faces.length) {
        tries.push({ out, change: Math.abs(measureVolume(out) - v0) });
      }
    } catch {
      // that way doesn't work here
    }
  }
  if (!tries.length) {
    throw new Error("This face can't be removed - its neighbours don't close the gap");
  }
  tries.sort((a, b) => a.change - b.change);

  return sanity(body, tries[0].out);
}

/**
 * Merge faces/edges that lie on the same surface (removes imprinted edges).
 * `size`: how big the body is, when known (the result of a join is about as
 * big as what was joined) - boxing every result again was slow on big bodies.
 */
export function unify(body: Shape3D, size?: number, loose?: { linear: number; angular: number }): Shape3D {
  const oc = getOC();
  const unifier = new oc.ShapeUpgrade_UnifySameDomain(body.wrapped, true, true, false);
  try {
    // Surfaces rebuilt from samples match the originals only to ~1e-9 relative. (`loose`: a mesh's flat faces, their
    // corners as far off their plane as a file's seven digits leave them.)
    unifier.SetLinearTolerance(loose?.linear ?? (size ?? sizeOf(body)) * 1e-6);
    unifier.SetAngularTolerance(loose?.angular ?? 1e-6);
    unifier.Build();
    // (The kernel's handle to the result is given back once the body has its own: release.ts.)
    const made = unifier.Shape();
    let out: Shape3D;
    try {
      out = cast(made) as Shape3D;
    } finally {
      made.delete();
    }
    // Merged into a broken face: the pieces as they were. (A cut across a
    // shelled mouse's top was sound; merged again, the two pieces of the
    // round either side of its seam came out a face that "didn't meet up".)
    if (out.faces.length !== body.faces.length && !shapeValid(out) && shapeValid(body)) {
      return body;
    }

    return out;
  } catch {
    // Merging is tidying only: if OpenCascade can't (a fillet ending on a face split in two), keep the pieces.
    return body;
  } finally {
    unifier.delete();
  }
}

function isEmpty(shape: Shape3D): boolean {
  try {
    return shape.faces.length === 0;
  } catch {
    return true;
  }
}

/** Reject results that exploded (an unbounded region leaked out). */
function sanity(before: Shape3D, after: Shape3D): Shape3D {
  if (isEmpty(after)) {
    throw new Error('The result would be empty');
  }
  if (sizeOf(after) > sizeOf(before) * 3 + 1) {
    throw new Error("This change can't be made cleanly here (the neighbouring faces don't enclose it)");
  }

  return unify(after);
}
