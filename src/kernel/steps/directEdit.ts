import { Vector, basicFaceExtrusion, cast, makeCompound, makePolygon, makeSolid, measureArea } from 'replicad';
import { need, staysClosed } from '../bodies';
import { edgeInfo, faceInfo, resolveEdge, resolveFace } from '../references';
import { add, cross, dist, dot, len, norm, scale, sub, xDirFor } from '../../geom';
import { facesNormal } from '../../freeform/faceGrid';
import { deleteFace, deleteFaces as deleteBodyFaces, freeformFace, inFlatFace, onFace as pointOnFace, planeOf, replaceFacePlane, sheetFace, sheetFaces, sizeOf, unify } from '../faceEdit';
import { isFault } from '../faults';
import { rotateAbout } from '../affine';
import { checkedBoolean, insideOf } from '../booleans';
import { shapeValid, subShapes } from '../health';
import { measureVolume } from '../ocFree';
import { applyPlan, boundaryEdges, cachedPlan } from '../../freeform/cage';
import { curvePoints } from './connect';
import type { Edge, Face, Shape3D } from 'replicad';
import type { DeleteGeomFeature, EdgeRef, FaceFreeformFeature, MoveFaceFeature, ReplaceFaceFeature, ScaleFaceFeature, Vec3 } from '../../doc/types';
import type { Ctx } from '../types';

export function applyFaceFreeform(feature: FaceFreeformFeature, ctx: Ctx) {
  const { bodies } = ctx;
  const body = need(bodies, feature.face.body);
  const face = resolveFace(body, feature.face);
  if (!feature.cage?.verts?.length) {
    throw new Error('Made before Freeform Face had a cage: tap the face, Edit Freeform, and shape it again');
  }
  // The cage follows the face (an earlier step moved it).
  const center = face.center.toTuple() as Vec3;
  const cage = { faces: feature.cage.faces, verts: feature.cage.verts.map(vertex => add(center, vertex)) };
  // Several faces side by side: one smooth surface over them all (no fitted way for those).
  if (feature.more?.length) {
    const Fs = [face, ...feature.more.map(faceRef => resolveFace(body, faceRef))];
    const normal = facesNormal(Fs.map(face => face.normalAt().toTuple() as Vec3));
    try {
      bodies.set(feature.face.body, staysClosed(body, sheetFaces(body, Fs, cage, normal)));
    } catch (err) {
      if (isFault(err) || (err instanceof Error && /holes in them/.test(err.message))) {
        throw err;
      }
      throw new Error("These faces can't be made one smooth surface like that - move the points less, or pick fewer faces");
    }

    return;
  }
  const unitNormal = norm(face.normalAt().toTuple() as Vec3);
  // Through the cage's surface twice as fine as the cage; if the face
  // can't be filled through that many points (a fine cage on an outline
  // with inward corners), through the cage's own.
  if (!faceCagePoints(cage, unitNormal, false)) {
    return;
  }
  // The cage's own smooth surface, its border on the face's edges. (A cage
  // whose border doesn't follow the edges - laid before it did - or a
  // body that won't close round it: fitted through its points instead.)
  try {
    bodies.set(feature.face.body, staysClosed(body, sheetFace(body, face, cage)));

    return;
  } catch (err) {
    if (isFault(err) || (err instanceof Error && /holes in them/.test(err.message))) {
      throw err;
    }
  }
  let last: unknown;
  for (const fine of [true, false]) {
    const pts = faceCagePoints(cage, unitNormal, fine);
    if (!pts) {
      return;
    }
    try {
      bodies.set(feature.face.body, staysClosed(body, freeformFace(body, face, onFace(face, pts))));

      return;
    } catch (err) {
      if (isFault(err)) {
        throw err;
      }
      last = err;
    }
  }
  throw last;
}

export function applyScaleFace(feature: ScaleFaceFeature, ctx: Ctx) {
  const body = need(ctx.bodies, feature.face.body);
  ctx.bodies.set(feature.face.body, staysClosed(body, scaleFace(body, resolveFace(body, feature.face), feature.u, feature.factors)));
}

export function applyReplaceFace(feature: ReplaceFaceFeature, ctx: Ctx) {
  const { bodies } = ctx;
  const body = need(bodies, feature.face.body);
  const face = resolveFace(body, feature.face);
  // Follow the target face if it's still there; else the plane as saved.
  let plane = feature.plane;
  if (feature.target) {
    const tb = bodies.get(feature.target.body);
    const tf = tb && (() => {
      try {
        return resolveFace(tb, feature.target!);
      } catch {
        return null;
      }
    })();
    if (tf?.geomType === 'PLANE') {
      plane = planeOf(tf);
    }
  }
  // Keep the face pointing the way it pointed (outward).
  const n0 = planeOf(face).normal;
  const normal = dot(plane.normal, n0) < 0 ? scale(plane.normal, -1) : plane.normal;
  bodies.set(feature.face.body, staysClosed(body, replaceFacePlane(body, face, { origin: plane.origin, normal: normal, xDir: xDirFor(normal) })));
}

export function applyDeleteGeom(feature: DeleteGeomFeature, ctx: Ctx) {
  const { bodies } = ctx;
  const start = need(bodies, feature.body);
  let body = start;
  // Picked together, taken out together: a slot's two walls and floor close
  // up as one gap (one wall alone has nothing to close it).
  let together: Shape3D | null = null;
  if (feature.faces.length > 1) {
    try {
      together = deleteBodyFaces(body, feature.faces.map(face => resolveFace(body, face)));
    } catch {
      together = null;
    }
  }
  if (together) {
    body = together;
  } else {
    for (const face of feature.faces) {
      body = deleteFace(body, resolveFace(body, face));
    }
  }
  for (const edge of feature.edges) {
    body = deleteEdge(body, edge);
  }
  for (const vertex of feature.vertices) {
    body = deleteVertex(body, vertex);
  }
  bodies.set(feature.body, staysClosed(start, body));
}

export function applyMoveFace(feature: MoveFaceFeature, ctx: Ctx) {
  const { bodies } = ctx;
  let rotation = feature.rotate && Math.abs(feature.rotate.angle) > 1e-9 ? feature.rotate : undefined;
  let translate = feature.translate;
  const move = (point: Vec3) => add(rotation ? rotateAbout(point, rotation.origin, rotation.axis, rotation.angle) : point, translate);
  const turn = (normal: Vec3) => (rotation ? norm(sub(rotateAbout(add(rotation.origin, normal), rotation.origin, rotation.axis, rotation.angle), rotation.origin)) : normal);
  if (feature.face) {
    const body = need(bodies, feature.face.body);
    const face = resolveFace(body, feature.face);
    const { origin, normal } = planeOf(face);
    const nn = norm(normal);
    // Pushed straight out (or tilted about a line in it) when it was made:
    // still that, square to the face as it is now - a step before it that
    // turns the face a little more mustn't make the push a slide.
    const was = feature.face.normal && len(feature.face.normal) > 1e-9 ? norm(feature.face.normal) : undefined;
    if (was) {
      const way = dot(nn, was) < 0 ? -1 : 1;
      const out = dot(translate, was);
      if (len(sub(translate, scale(was, out))) <= 1e-6 * Math.max(1, Math.abs(out))) {
        translate = scale(nn, out * way);
      }
      if (rotation && Math.abs(dot(norm(rotation.axis), was)) <= 1e-6) {
        const inPlane = sub(rotation.axis, scale(nn, dot(rotation.axis, nn)));
        if (len(inPlane) > 1e-9) {
          rotation = { ...rotation, axis: norm(inPlane) };
        }
      }
    }
    // Slid within its own plane, or turned about its normal: its corners
    // move and the faces round it follow (a plane alone can't show that -
    // the face stayed where it was).
    const slide = sub(translate, scale(nn, dot(translate, nn)));
    const twist = !!rotation && Math.abs(dot(norm(rotation.axis), nn)) > 1e-6;
    if (len(slide) > 1e-9 || twist) {
      const size = Math.hypot(body.boundingBox.width, body.boundingBox.height, body.boundingBox.depth) || 1;
      const loop = faceLoop(face, size * 1e-6);
      const out = loop ? movePolyhedronPoints(body, loop.map(vertex => [vertex, move(vertex)] as [Vec3, Vec3])) : null;
      if (!out) {
        throw new Error('Sliding or turning a face within its plane works on bodies of flat, straight-edged faces - push or tilt it instead');
      }
      bodies.set(feature.face.body, staysClosed(body, out));

      return;
    }
    // Drawn inside a bigger flat face (projected onto it): moving its plane
    // moves nothing - raised, it's a prism joined on; sunk, one cut out.
    if (inFlatFace(body, face)) {
      if (rotation) {
        throw new Error('This face lies in a bigger flat face: it can be pushed straight out or in, not tilted (Extrude it at an angle instead)');
      }
      const along = dot(translate, nn);
      if (Math.abs(along) < 1e-12) {
        return;
      }
      const prism = basicFaceExtrusion(face, new Vector(scale(nn, along))) as Shape3D;
      const size = Math.hypot(body.boundingBox.width, body.boundingBox.height, body.boundingBox.depth) || 1;
      const { p } = pointOnFace(body, face);
      const [into] = insideOf(body, [add(p, scale(nn, Math.sign(along) * Math.min(Math.abs(along) / 2, size * 1e-3)))]);
      bodies.set(feature.face.body, staysClosed(body, checkedBoolean(into ? 'cut' : 'fuse', body, prism)));

      return;
    }
    const turned = turn(normal);
    bodies.set(feature.face.body, staysClosed(body, replaceFacePlane(body, face, { origin: move(origin), normal: turned, xDir: xDirFor(turned) })));

    return;
  }
  if (feature.vertex) {
    if (ctx.freeforms.has(feature.vertex.body)) {
      throw new Error("A freeform's shape comes from its cage: use Edit Freeform to move its points");
    }
    const body = need(bodies, feature.vertex.body);
    bodies.set(feature.vertex.body, staysClosed(body, moveVertex(body, feature.vertex.at, move(feature.vertex.at))));

    return;
  }
  if (!feature.edge) {
    throw new Error('Nothing to move');
  }
  const eb = need(bodies, feature.edge.body);
  bodies.set(feature.edge.body, staysClosed(eb, moveEdge(eb, feature.edge, move)));
}

/**
 * Scale a flat face within its plane: each flat neighbour turns about its far
 * side so it passes through the face's moved edge (like a taper).
 */
export function scaleFace(body: Shape3D, face: Face, u0: Vec3, [su, sv]: [number, number]): Shape3D {
  if (face.geomType !== 'PLANE') {
    throw new Error('Scale Face works on flat faces');
  }
  if (su <= 0 || sv <= 0) {
    throw new Error('Scale factors must be positive');
  }
  const { normal: normal } = planeOf(face);
  const center = face.center.toTuple() as Vec3;
  const unitU = norm(sub(u0, scale(normal, dot(u0, normal))));
  const unitV = cross(normal, unitU);
  const map = (point: Vec3): Vec3 => {
    const offset = sub(point, center);

    return add(center, add(add(scale(unitU, su * dot(offset, unitU)), scale(unitV, sv * dot(offset, unitV))), scale(normal, dot(offset, normal))));
  };
  const targets = face.edges.map((edge) => {
    if (edge.geomType !== 'LINE') {
      throw new Error("Scale Face needs straight edges (round edges can't taper yet)");
    }
    const neighbour = body.faces.find(candidate => !candidate.isSame(face) && candidate.edges.some(e => e.isSame(edge)));
    if (!neighbour) {
      throw new Error('A neighbouring face is missing');
    }
    if (neighbour.geomType !== 'PLANE') {
      throw new Error('Scale Face works when the faces around it are flat');
    }
    const a = edge.startPoint.toTuple() as Vec3;
    const b = edge.endPoint.toTuple() as Vec3;
    const a2 = map(a);
    const b2 = map(b);
    const direction = norm(sub(b, a));
    const off = (point: Vec3) => len(sub(sub(point, a), scale(direction, dot(sub(point, a), direction))));
    const pts = neighbour.edges.flatMap(e => [e.startPoint.toTuple() as Vec3, e.endPoint.toTuple() as Vec3]);
    const far = pts.reduce((farthest, point) => (off(point) > off(farthest) ? point : farthest), pts[0]);
    const old = planeOf(neighbour);
    let nn = norm(cross(sub(b2, a2), sub(far, a2)));
    if (dot(nn, old.normal) < 0) {
      nn = scale(nn, -1);
    }

    return { sig: faceInfo(neighbour), plane: { origin: a2, normal: nn, xDir: xDirFor(nn) } };
  });
  let out = body;
  for (const t of targets) {
    // A side that stays where it is (scaled 1 that way): left alone - it may
    // run the whole length of the part (a lever's side, from the hub to the tip).
    const old = { origin: t.sig.center, normal: norm(t.sig.normal) };
    if (Math.abs(dot(norm(t.plane.normal), old.normal)) > 1 - 1e-12 && Math.abs(dot(sub(t.plane.origin, old.origin), old.normal)) < sizeOf(body) * 1e-9) {
      continue;
    }
    out = replaceFacePlane(out, resolveFace(out, { body: '', center: t.sig.center, normal: t.sig.normal, area: t.sig.area }), t.plane);
  }

  return out;
}

/**
 * Move a straight edge: each flat face on it turns about its far side so it
 * passes through the edge's new position.
 */
function moveEdge(body: Shape3D, ref: EdgeRef, move: (p: Vec3) => Vec3): Shape3D {
  const edge = resolveEdge(body, ref);
  if (edge.geomType !== 'LINE') {
    throw new Error('Only straight edges can be moved');
  }
  const a = edge.startPoint.toTuple() as Vec3;
  const b = edge.endPoint.toTuple() as Vec3;
  const a2 = move(a);
  const b2 = move(b);
  // A body of flat faces: just the edge's two corners move; every other corner
  // stays (bending faces are split) - repeated moves don't drift or pile up.
  const poly = movePolyhedronPoints(body, [[a, a2], [b, b2]]);
  if (poly) {
    return poly;
  }
  const d2 = norm(sub(b2, a2));
  const faces = body.faces.filter(face => face.edges.some(e => e.isSame(edge)));
  if (faces.some(face => face.geomType !== 'PLANE')) {
    throw new Error('Only edges between flat faces can be moved');
  }
  const targets = faces.map((face) => {
    const old = planeOf(face);
    // The face's point farthest from the edge stays put.
    const pts = face.edges.flatMap(e => [e.startPoint.toTuple() as Vec3, e.endPoint.toTuple() as Vec3]);
    const direction = norm(sub(b, a));
    const off = (point: Vec3) => len(sub(sub(point, a), scale(direction, dot(sub(point, a), direction))));
    const far = pts.reduce((farthest, point) => (off(point) > off(farthest) ? point : farthest), pts[0]);
    let normal = norm(cross(d2, sub(far, a2)));
    if (dot(normal, old.normal) < 0) {
      normal = scale(normal, -1);
    }

    return { sig: faceInfo(face), plane: { origin: a2, normal: normal, xDir: xDirFor(normal) } };
  });
  let out = body;
  for (const t of targets) {
    out = replaceFacePlane(out, resolveFace(out, { body: ref.body, center: t.sig.center, normal: t.sig.normal, area: t.sig.area }), t.plane);
  }

  return out;
}

/**
 * Move one corner: every flat face meeting at it turns about its far edge (the
 * one not touching the corner) so it passes through the corner's new place.
 */
function moveVertex(body: Shape3D, at: Vec3, to: Vec3): Shape3D {
  // A body of flat faces moves just the point: faces that would bend are split
  // into a triangle at the corner and the untouched rest.
  const poly = movePolyhedronVertex(body, at, to);
  if (poly) {
    return poly;
  }

  return moveVertexByPlanes(body, at, to);
}

/** Outer loop of a flat, straight-edged face as ordered corners (null if it isn't one). */
export function faceLoop(face: Face, tol: number): Vec3[] | null {
  // (outerWire / innerWires use up the face they're called on: ask clones.)
  if (face.geomType !== 'PLANE' || face.clone().innerWires().length) {
    return null;
  }
  const edges = face.clone().outerWire().edges;
  if (edges.some(e => e.geomType !== 'LINE')) {
    return null;
  }
  const segs = edges.map(e => [e.startPoint.toTuple() as Vec3, e.endPoint.toTuple() as Vec3]);
  const loop: Vec3[] = [segs[0][0], segs[0][1]];
  const used = new Set([0]);
  while (used.size < segs.length) {
    const last = loop[loop.length - 1];
    const index = segs.findIndex((sg, i) => !used.has(i) && (dist(sg[0], last) < tol || dist(sg[1], last) < tol));
    if (index < 0) {
      return null;
    }
    used.add(index);
    loop.push(dist(segs[index][0], last) < tol ? segs[index][1] : segs[index][0]);
  }
  if (dist(loop[0], loop[loop.length - 1]) > tol) {
    return null;
  }
  loop.pop();
  // Wind it so its normal is the face's outward normal.
  const normal = face.normalAt().toTuple() as Vec3;
  if (dot(polyNormal(loop), normal) < 0) {
    loop.reverse();
  }

  return loop;
}

function polyNormal(pts: Vec3[]): Vec3 {
  let normal: Vec3 = [0, 0, 0];
  for (let i = 0; i < pts.length; i++) {
    normal = add(normal, cross(pts[i], pts[(i + 1) % pts.length]));
  }

  return normal;
}

function coplanar(pts: Vec3[], tol: number): boolean {
  const normal = norm(polyNormal(pts));
  if (!Number.isFinite(normal[0]) || len(normal) < 0.5) {
    return false;
  }

  return pts.every(point => Math.abs(dot(sub(point, pts[0]), normal)) < tol);
}

function movePolyhedronVertex(body: Shape3D, at: Vec3, to: Vec3): Shape3D | null {
  return movePolyhedronPoints(body, [[at, to]]);
}

/**
 * A body of flat, straight-edged faces with some corners moved: every other
 * corner stays exactly where it is. A face whose corners no longer lie in one
 * plane keeps its unmoved part, and the moved corners get triangles (fanned
 * from the unmoved corner before them); coplanar pieces merge again after.
 */
function movePolyhedronPoints(body: Shape3D, moves: [Vec3, Vec3][]): Shape3D | null {
  const size = Math.hypot(body.boundingBox.width, body.boundingBox.height, body.boundingBox.depth) || 1;
  const tol = size * 1e-6;
  // A body in separate pieces (a block added that doesn't touch the rest): the
  // piece with the corners moves, the others stay as they are. (Made as one,
  // the pieces came out as a group, not a solid - every move of a corner failed.)
  const pieces = subShapes(body, 'SOLID');
  if (pieces.length > 1) {
    const on = (piece: Shape3D) => piece.edges.some(e => moves.some(([a]) => dist(e.startPoint.toTuple() as Vec3, a) < tol || dist(e.endPoint.toTuple() as Vec3, a) < tol));
    let hit = false;
    const out: Shape3D[] = [];
    for (const part of pieces) {
      const piece = cast(part) as Shape3D;
      if (!on(piece)) {
        out.push(piece);
        continue;
      }
      hit = true;
      const moved = movePolyhedronPoints(piece, moves);
      if (!moved) {
        return null;
      }
      out.push(moved);
    }

    return hit ? (makeCompound(out as never) as unknown as Shape3D) : null;
  }
  const loops = body.faces.map(face => faceLoop(face, tol));
  if (loops.some(loop => !loop)) {
    return null;
  }
  const movedTo = (point: Vec3): Vec3 | null => moves.find(([a]) => dist(a, point) < tol)?.[1] ?? null;
  const polys: Vec3[][] = [];
  let touched = 0;
  for (const loop of loops as Vec3[][]) {
    const isMoved = loop.map(point => movedTo(point) !== null);
    if (!isMoved.some(Boolean)) {
      polys.push(loop);
      continue;
    }
    touched++;
    const moved = loop.map(point => movedTo(point) ?? point);
    if (coplanar(moved, tol * 10)) {
      polys.push(moved);
      continue;
    }
    // Cut triangles off at the moved corners (ear clipping in the face's own
    // plane, so concave faces stay valid); what's left never moved and stays flat.
    const { tris, rest } = clipMovedCorners(loop, isMoved);
    if (rest.length >= 3) {
      polys.push(rest.map(index => loop[index]));
    }
    for (const t of tris) {
      polys.push(t.map(index => moved[index]));
    }
  }
  if (!touched) {
    throw new Error('That corner is no longer there');
  }
  // A body of flat faces: this is the way to move its corners. If the result
  // folds through itself, say so - another method would only give a mangled
  // shape (and dragging would jump between the two).
  const folded = 'That would fold the faces through each other - move it less far, or another way';
  let solid: Shape3D;
  let volume: number;
  try {
    const build = (list: Vec3[][]) => unify(makeSolid(list.map(pl => makePolygon(pl))) as unknown as Shape3D);
    solid = build(polys);
    volume = measureVolume(solid);
    // Inside out: wind every face the other way.
    if (volume < 0) {
      solid = build(polys.map(pl => [...pl].reverse()));
      volume = measureVolume(solid);
    }
  } catch {
    throw new Error(folded);
  }
  if (!Number.isFinite(volume) || volume < 1e-9 * size ** 3 || solid.faces.length < 4 || !shapeValid(solid)) {
    throw new Error(folded);
  }

  return solid;
}

/**
 * Ear clipping of a flat face's loop that removes the moved corners first:
 * triangles holding a moved corner, plus the untouched rest as one polygon.
 */
function clipMovedCorners(loop: Vec3[], isMoved: boolean[]): { tris: number[][]; rest: number[] } {
  const normal = norm(polyNormal(loop));
  const x = norm(sub(loop[1], loop[0]));
  const y = cross(normal, x);
  const flat = loop.map(point => [dot(sub(point, loop[0]), x), dot(sub(point, loop[0]), y)] as [number, number]);
  const area2 = (a: number, b: number, indexC: number) => (flat[b][0] - flat[a][0]) * (flat[indexC][1] - flat[a][1]) - (flat[b][1] - flat[a][1]) * (flat[indexC][0] - flat[a][0]);
  const idx = loop.map((_, index) => index);
  const tris: number[][] = [];
  const isEar = (i: number): boolean => {
    const count = idx.length;
    const a = idx[(i + count - 1) % count];
    const b = idx[i];
    const nextIndex = idx[(i + 1) % count];
    if (area2(a, b, nextIndex) <= 1e-12) {
      return false;
    }
    for (const index of idx) {
      if (index === a || index === b || index === nextIndex) {
        continue;
      }
      if (area2(a, b, index) >= -1e-12 && area2(b, nextIndex, index) >= -1e-12 && area2(nextIndex, a, index) >= -1e-12) {
        return false;
      }
    }

    return true;
  };
  const clip = (i: number) => {
    const count = idx.length;
    tris.push([idx[(i + count - 1) % count], idx[i], idx[(i + 1) % count]]);
    idx.splice(i, 1);
  };
  let guard = loop.length * 4;
  while (idx.length > 3 && idx.some(index => isMoved[index]) && guard-- > 0) {
    const count = idx.length;
    const order = idx.map((_, i) => i);
    // Ears at a moved corner first, then ears next to one, then any ear.
    const rank = (i: number) => (isMoved[idx[i]] ? 0 : isMoved[idx[(i + 1) % count]] || isMoved[idx[(i + count - 1) % count]] ? 1 : 2);
    order.sort((first, q) => rank(first) - rank(q));
    const ear = order.find(isEar);
    if (ear === undefined) {
      break;
    }
    clip(ear);
  }
  if (idx.some(index => isMoved[index])) {
    // Down to a triangle (or clipping got stuck): all of it moves.
    if (idx.length === 3) {
      tris.push([...idx]);
    } else {
      for (let q = 1; q + 1 < idx.length; q++) {
        tris.push([idx[0], idx[q], idx[q + 1]]);
      }
    }

    return { tris, rest: [] };
  }

  return { tris, rest: idx };
}

function moveVertexByPlanes(body: Shape3D, at: Vec3, to: Vec3): Shape3D {
  const size = Math.hypot(body.boundingBox.width, body.boundingBox.height, body.boundingBox.depth) || 1;
  const tol = size * 1e-6;
  const ends = (e: Edge): Vec3[] => [e.startPoint.toTuple() as Vec3, e.endPoint.toTuple() as Vec3];
  const faces = body.faces.filter(face => face.edges.some(e => ends(e).some(end => dist(end, at) < tol)));
  if (!faces.length) {
    throw new Error('That corner is no longer there');
  }
  if (faces.some(face => face.geomType !== 'PLANE')) {
    throw new Error('Only corners where flat faces meet can be moved');
  }
  const targets = faces.map((face) => {
    const old = planeOf(face);
    // The far edge: both ends away from the corner, the farthest such edge.
    const far = face.edges
      .filter(e => e.geomType === 'LINE' && ends(e).every(end => dist(end, at) > tol))
      .sort((a, b) => dist(b.pointAt(0.5).toTuple() as Vec3, at) - dist(a.pointAt(0.5).toTuple() as Vec3, at))[0];
    if (!far) {
      throw new Error('Moving this corner needs straight-edged faces around it');
    }
    const [p1, p2] = ends(far);
    let normal = norm(cross(sub(p1, to), sub(p2, to)));
    if (len(normal) < 1e-9 || !Number.isFinite(normal[0])) {
      throw new Error("The corner can't go there (a face would fold flat)");
    }
    if (dot(normal, old.normal) < 0) {
      normal = scale(normal, -1);
    }

    return { sig: faceInfo(face), plane: { origin: to, normal: normal, xDir: xDirFor(normal) } };
  });
  let out = body;
  for (const t of targets) {
    out = replaceFacePlane(out, resolveFace(out, { body: '', center: t.sig.center, normal: t.sig.normal, area: t.sig.area }), t.plane);
  }

  return out;
}

/**
 * Remove an edge: merge its faces when they lie on one surface, otherwise drop
 * the blend face it bounds (fillet/chamfer) so its neighbours meet again.
 */
function deleteEdge(body: Shape3D, ref: EdgeRef): Shape3D {
  const edge = resolveEdge(body, ref);
  const merged = unify(body);
  if (merged.edges.length < body.edges.length && !hasEdge(merged, ref)) {
    return merged;
  }
  const adjacent = body.faces.filter(face => face.edges.some(e => e.isSame(edge)));
  // Try the curved / smaller face first: that's the blend.
  adjacent.sort((a, b) => (a.geomType === 'PLANE' ? 1 : 0) - (b.geomType === 'PLANE' ? 1 : 0) || measureArea(a) - measureArea(b));
  for (const face of adjacent) {
    try {
      return deleteFace(body, face);
    } catch {
      // try the other face
    }
  }
  throw new Error("This edge can't be removed - the faces around it wouldn't close up");
}

function hasEdge(body: Shape3D, ref: EdgeRef): boolean {
  try {
    const e = edgeInfo(resolveEdge(body, ref));

    return dist(e.mid, ref.mid) < (ref.length || 1) * 1e-3 && Math.abs(e.length - ref.length) < (ref.length || 1) * 1e-3;
  } catch {
    return false;
  }
}

/** Remove a vertex that only splits an edge or face (merges what it separates). */
function deleteVertex(body: Shape3D, at: Vec3): Shape3D {
  const merged = unify(body);
  const tol = 1e-6 * (Math.hypot(body.boundingBox.width, body.boundingBox.height, body.boundingBox.depth) || 1);
  const still = merged.edges.some(e => dist(e.startPoint.toTuple() as Vec3, at) < tol || dist(e.endPoint.toTuple() as Vec3, at) < tol);
  if (still) {
    throw new Error("This corner can't be removed - it's where faces meet");
  }

  return merged;
}

/**
 * Those of `pts` that lie over the flat face itself (seen along its normal),
 * clear of its edge. A cage's smooth surface cuts an inward corner of the
 * face's outline (an L's) a little short: the points it has out there, past
 * the edge, would fold the face over when it is filled through them.
 */
function onFace(face: Face, pts: Vec3[]): Vec3[] {
  const normal = norm(face.normalAt().toTuple() as Vec3);
  const xDir = xDirFor(normal);
  const vAxis = norm(cross(normal, xDir));
  // (outerWire uses up the face it's called on: a clone.)
  const wire = face.clone().outerWire();
  const loop = curvePoints(wire.wrapped, 600, true).map(curvePoint => [dot(curvePoint, xDir), dot(curvePoint, vAxis)]);
  wire.delete();
  const count = loop.length;
  let area = 0;
  for (let a = 0, b = count - 1; a < count; b = a++) {
    area += loop[b][0] * loop[a][1] - loop[a][0] * loop[b][1];
  }
  const margin = Math.sqrt(Math.abs(area) / 2) * 0.01;
  const kept = pts.filter((point) => {
    const x = dot(point, xDir);
    const y = dot(point, vAxis);
    let inside = false;
    let near = Infinity;
    for (let a = 0, b = count - 1; a < count; b = a++) {
      const [ax, ay] = loop[a];
      const [bx, by] = loop[b];
      if (ay > y !== by > y && x < ((bx - ax) * (y - ay)) / (by - ay) + ax) {
        inside = !inside;
      }
      const lengthSquared = (bx - ax) ** 2 + (by - ay) ** 2;
      const t = lengthSquared > 0 ? Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / lengthSquared)) : 0;
      near = Math.min(near, Math.hypot(x - ax - t * (bx - ax), y - ay - t * (by - ay)));
    }

    return inside && near > margin;
  });

  // (None left - a sliver of a face: as they were, and the fill says what it can't do.)
  return kept.length ? kept : pts;
}

/**
 * Points on the smooth surface a Freeform Face cage makes (its border left
 * out: the face's own edges are kept), for the face to be filled through; null
 * when every inside point is still on the face (nothing to do).
 */
function faceCagePoints(cage: { verts: Vec3[]; faces: [number, number, number, number][] }, normal: Vec3, fine = true): Vec3[] | null {
  const border = new Set(boundaryEdges(cage).flat());
  const inside = cage.verts.map((_, i) => i).filter(i => !border.has(i));
  const vertex = cage.verts[[...border][0]];
  // All still in the face's plane: the smooth surface is the flat face itself.
  if (!vertex || !inside.some(i => Math.abs(dot(sub(cage.verts[i], vertex), normal)) > 1e-9)) {
    return null;
  }
  // Twice as fine as the cage, as long as that isn't too many to fill through.
  const plan = cachedPlan(cage, !fine || inside.length > 60 ? 0 : 1);
  const pos = applyPlan(plan, cage.verts);
  const { ptr, idx } = plan.rows;
  const out: Vec3[] = [];
  for (let row = 0; row < ptr.length - 1; row++) {
    let onBorder = true;
    for (let t = ptr[row]; t < ptr[row + 1] && onBorder; t++) {
      if (!border.has(idx[t])) {
        onBorder = false;
      }
    }
    if (!onBorder) {
      out.push([pos[3 * row], pos[3 * row + 1], pos[3 * row + 2]]);
    }
  }

  return out;
}
