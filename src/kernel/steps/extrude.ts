import { Vector, assembleWire, basicFaceExtrusion, cast, genericSweep, getOC, isShape3D, loft, makeBSplineApproximation, makeCircle, makeLine, makePolygon, makeSolid, makeVertex, measureArea, measureDistanceBetween } from 'replicad';
import { sourceFaces } from '../sources';
import { add, dist, dot, len, norm, scale, sub, xDirFor } from '../../geom';
import { checkedBoolean, combine, fuseAll, fuzzyBoolean, halfSpace, insideOf, overlapping } from '../booleans';
import { isEmpty, need, staysClosed } from '../bodies';
import { resolveFace } from '../references';
import { SIDES_MEET, editNotes, hasBlends, offsetFace, onFace as pointOnFace, planeOf, sizeOf, unify } from '../faceEdit';
import { measureVolume } from '../ocFree';
import { shapeValid, subShapes } from '../health';
import { faceLoop } from './directEdit';
import type { Face, Shape3D, Wire } from 'replicad';
import type { ExtrudeFeature, FaceRef, PlaneDef, Vec3 } from '../../doc/types';
import type { Ctx } from '../types';

export function applyExtrude(feature: ExtrudeFeature, ctx: Ctx) {
  const { bodies } = ctx;
  const ext = feature.extent ?? 'distance';
  if (ext === 'distance' && Math.abs(feature.distance) < 1e-6) {
    throw new Error('Distance is zero');
  }
  if (ext === 'to' && feature.symmetric) {
    throw new Error('Up to works one way only - switch Sides back to One side');
  }
  if (ext === 'to' && !feature.to?.face && !feature.to?.plane) {
    throw new Error('Pick the face or plane it goes up to');
  }
  // Where it starts: at the shape, or `start` from it along its normal.
  const startFaces = () => {
    const src = sourceFaces(feature.source, ctx);

    return feature.start ? src.map(({ face, normal }) => ({ face: face.clone().translate(scale(normal, feature.start!)) as Face, normal })) : src;
  };
  // Up to: the face (where it is now) or the plane it stops at.
  const upTo = ext === 'to' ? extrudeTarget(feature.to!, ctx) : null;
  // How far: the distance, or far enough to come out of everything (the way the distance's sign says, or towards the target).
  let distance = feature.distance;
  if (ext === 'through' && !ctx.bodies.size) {
    throw new Error('Through all goes through the bodies there are - there are none yet: set a Distance');
  }
  if (ext !== 'distance') {
    const src = startFaces();
    const reach = reachOf(ctx, src.map(source => source.face as unknown as Shape3D), upTo?.shape);
    const normal = src[0]?.normal ?? [0, 0, 1];
    const center = src[0]?.face.center.toTuple() as Vec3 | undefined;
    const way = upTo && center ? Math.sign(dot(sub(upTo.point, center), normal)) || 1 : Math.sign(feature.distance) || 1;
    distance = way * reach;
  }
  const plain = ext === 'distance' && !feature.start && !feature.draft;
  // Pushing/pulling a face of its own body offsets it: the neighbouring faces
  // extend along their own surfaces (a round side stays round).
  const tapered = feature.taper !== undefined && Math.abs(feature.taper - 1) > 1e-9;
  if (tapered && feature.symmetric) {
    throw new Error('Taper works one way only - switch Sides back to One side');
  }
  if (tapered) {
    // Sides leaning in (or out): each shape's outline to a scaled copy at the far end.
    // Pieces that meet are one shape first: a circle drawn on a small face
    // is split by the face's outline into a disc and a ring round it (the
    // ring was refused as "a shape with a hole", and each piece would have
    // shrunk towards its own middle).
    if (ext !== 'distance' || feature.draft) {
      throw new Error('Taper end % works with a set distance and no draft - set Taper end back to 100%');
    }
    const src = startFaces();
    const parts = mergedFaces(src.map(source => source.face), src[0]?.normal ?? [0, 0, 1]).map(face => ({ face, normal: src[0].normal })).map(({ face, normal }) => {
      // (replicad's outerWire() and innerWires() free the face they're asked
      // of: they're asked of copies.)
      const center = face.center.toTuple() as Vec3;
      if (face.clone().innerWires().length) {
        throw new Error('Taper works on shapes without holes');
      }
      const w0 = face.clone().outerWire();
      const taper = Math.max(0.002, feature.taper!);
      // Straight-edged shapes: flat sides (a loft makes them curved surfaces,
      // and then nothing that needs a flat face - sketch on it, move it - works).
      const flat = taperedPrism(face, center, normal, taper, distance);
      if (flat) {
        return flat;
      }
      const w1 = w0.clone().scale(taper, center).translate(scale(normal, distance));
      try {
        return loft([w0, w1], { ruled: true }) as Shape3D;
      } catch {
        throw new Error("This shape can't be tapered");
      }
    });
    combine(feature.id, feature.mode, feature.target, fuseAll(parts), distance < 0, ctx);

    return;
  }
  if (plain && feature.source.kind === 'face' && feature.mode !== 'new' && feature.mode !== 'intersect' && feature.target === feature.source.face.body && !feature.symmetric) {
    const body = need(bodies, feature.target);
    const face = resolveFace(body, feature.source.face);
    const distance = feature.mode === 'cut' ? -Math.abs(feature.distance) : feature.mode === 'join' ? Math.abs(feature.distance) : feature.distance;
    // The end of a sweep pushed in: shortened along its path, the new end
    // square to the path there (not the old end's plane slid along).
    const trimmed = distance < 0 ? trimSweepEnd(body, face, -distance, ctx) : null;
    if (trimmed) {
      bodies.set(feature.target, staysClosed(body, trimmed));

      return;
    }
    try {
      const out = staysClosed(body, offsetFace(body, face, distance));
      // Hair-thin faces left behind (a face pushed over a fillet): a straight push is cleaner.
      if (face.geomType === 'PLANE' && slivers(out) > slivers(body)) {
        throw new Error('slivers');
      }
      bodies.set(feature.target, out);

      return;
    } catch (err) {
      // Faces whose neighbours don't enclose them still get a straight push -
      // but not one with a fillet on it (the old fillet would stay standing).
      // (Nor one whose sides meet before it gets there: straight sides would be another shape.)
      if (face.geomType !== 'PLANE' || hasBlends(body, face) || (err instanceof Error && err.message === SIDES_MEET)) {
        throw err;
      }
    }
  }
  // Symmetric: from `distance` behind the shape to `distance` in front.
  const parts = startFaces().map(({ face, normal }) => {
    const straight = feature.symmetric ? basicFaceExtrusion(face.clone().translate(scale(normal, -distance)), new Vector(normal).multiply(2 * distance)) : basicFaceExtrusion(face, new Vector(normal).multiply(distance));

    // Draft: the sides lean from the shape's own plane (both ways from it, symmetric).
    return feature.draft ? drafted(straight, scale(normal, Math.sign(distance) || 1), face.center.toTuple() as Vec3, feature.draft) : straight;
  });
  let solid = fuseAll(parts);
  // Up to: what goes past the face or plane is cut off.
  if (upTo) {
    solid = trimmedTo(solid, upTo, startFaces()[0]?.face.center.toTuple() as Vec3);
  }
  // Auto: other bodies the extrusion runs into get cut through. Drawn on
  // its own (no body it belongs to), it then only cuts - no new body.
  // (By the way it goes: going +, a shape drawn on its own is a new body, whatever it runs into.)
  if (feature.mode === 'auto' && !(feature.byDirection && !feature.target && distance >= 0)) {
    const hit = overlapping(solid, ctx, feature.target);
    // Started inside a body (drawn on a plane through it) and reaching out
    // of it: cut, and the part outside left off - said so (a pipe's branch
    // drawn on the floor through the pipe came out a notch, no word why).
    if (hit.length && !feature.target && Math.abs(distance) > 1e-9) {
      const dir = Math.sign(distance);
      const starts = startFaces().flatMap(({ face, normal }) => {
        const { p } = pointOnFace(face as unknown as Shape3D, face); const e = 1e-3;

        return [add(p, scale(normal, e * dir)), add(p, scale(normal, -e * dir))]; 
      });
      const inside = hit.some(id => insideOf(need(bodies, id), starts).every(Boolean));
      if (inside) {
        let rest: Shape3D = solid;
        for (const id of hit) {
          rest = checkedBoolean('cut', rest, need(bodies, id));
        }
        if (!isEmpty(rest) && Math.abs(measureVolume(rest)) > 1e-3 * Math.abs(measureVolume(solid))) {
          editNotes.push(AUTO_CUT_INSIDE);
        }
      }
    }
    for (const id of hit) {
      const cut = checkedBoolean('cut', need(bodies, id), solid);
      if (isEmpty(cut)) {
        bodies.delete(id);
      } else {
        bodies.set(id, cut);
      }
      ctx.freeforms.delete(id);
    }
    if (hit.length && !feature.target) {
      return;
    }
  }
  combine(feature.id, feature.mode, feature.target, solid, distance < 0, ctx);
}

/**
 * A straight-edged shape tapered: its outline, the outline scaled about its
 * centre at the far end, and a flat four-sided face between each pair of
 * edges (a scaled edge stays parallel to its original, so each side is flat).
 * Null when the outline isn't all straight lines or it doesn't come out solid.
 */
function taperedPrism(face: Face, center: Vec3, normal: Vec3, taper: number, distance: number): Shape3D | null {
  const bb = face.boundingBox;
  const size = Math.hypot(bb.width, bb.height, bb.depth) || 1;
  const loop = faceLoop(face, size * 1e-6);
  if (!loop || loop.length < 3) {
    return null;
  }
  const off = scale(normal, distance);
  const top = loop.map(point => add(add(center, scale(sub(point, center), taper)), off));
  const count = loop.length;
  const polys: Vec3[][] = [[...loop].reverse(), top];
  for (let i = 0; i < count; i++) {
    const j = (i + 1) % count;
    polys.push([loop[i], loop[j], top[j], top[i]]);
  }
  try {
    const build = (list: Vec3[][]) => makeSolid(list.map(pl => makePolygon(pl))) as unknown as Shape3D;
    let solid = build(polys);
    if (measureVolume(solid) < 0) {
      solid = build(polys.map(pl => [...pl].reverse()));
    }
    const volume = measureVolume(solid);
    if (!Number.isFinite(volume) || volume <= 0 || !shapeValid(solid)) {
      return null;
    }

    return solid;
  } catch {
    return null;
  }
}

/** A wire's points in order along it, close together (curves sampled finely). */
function wirePoints(wire: Wire): Vec3[] {
  const pts: Vec3[] = [];
  for (const e of wire.edges) {
    const samples = e.geomType === 'LINE' ? 1 : 200;
    let seg: Vec3[] = [];
    for (let i = 0; i <= samples; i++) {
      seg.push(e.pointAt(i / samples).toTuple() as Vec3);
    }
    // Edges run end to end, each its own way round.
    if (pts.length && dist(seg[seg.length - 1], pts[pts.length - 1]) < dist(seg[0], pts[pts.length - 1])) {
      seg = seg.reverse();
    }
    if (pts.length === 0 && wire.edges.length > 1) {
      const next = wire.edges[1];
      const ends = [next.pointAt(0).toTuple() as Vec3, next.pointAt(1).toTuple() as Vec3];
      const near = (point: Vec3) => Math.min(...ends.map(q => dist(point, q)));
      if (near(seg[0]) < near(seg[seg.length - 1])) {
        seg = seg.reverse();
      }
    }
    pts.push(...(pts.length ? seg.slice(1) : seg));
  }

  return pts;
}

/**
 * Face F of `body` is the end of a sweep (square to its path's end, the path
 * ending on it): cut `by` off along the path, so the tube is that much
 * shorter and its new end is square to the path where it now ends. A disc
 * wider than the end is swept along that last piece of the path (starting a
 * little past the end) and cut away. Null when F isn't a sweep's end.
 */
function trimSweepEnd(body: Shape3D, face: Face, by: number, ctx: Ctx): Shape3D | null {
  if (face.geomType !== 'PLANE' || !ctx.sweeps.size) {
    return null;
  }
  const { origin, normal } = planeOf(face);
  const bb = face.boundingBox;
  const size = Math.hypot(bb.width, bb.height, bb.depth);
  const center = face.center.toTuple() as Vec3;
  for (const spine of ctx.sweeps.values()) {
    const all = wirePoints(spine);
    // Every place the path passes through `face`'s plane heading out through `face`
    // (the end itself, or where an earlier push left it): the one at `face`. On an
    // S-bend the plane cuts the path elsewhere too.
    const side = (point: Vec3) => dot(sub(point, origin), normal);
    const tolPlane = size * 0.05 + 1e-6;
    let best: { pts: Vec3[]; out: Vec3; d: number } | null = null;
    for (const way of [all, [...all].reverse()]) {
      for (let index = 0; index < way.length - 1; index++) {
        const a0 = side(way[index]);
        const a1 = side(way[index + 1]);
        if (!(a0 >= -tolPlane && a1 < a0 && a1 <= tolPlane)) {
          continue;
        }
        const out = norm(sub(way[index], way[index + 1]));
        if (Math.abs(dot(out, normal)) < 0.98) {
          continue;
        }
        // (The sweep turns its profile square to the path: a profile drawn a
        // little off square ends on a plane a hair off the path's end.)
        const t0 = a0 <= tolPlane && index === 0 ? 0 : Math.min(1, Math.max(0, a0 / (a0 - a1)));
        const q = add(way[index], scale(sub(way[index + 1], way[index]), t0));
        const distance = dist(q, center);
        if (distance <= size && (!best || distance < best.d)) {
          best = { pts: [q, ...way.slice(index + 1)], out, d: distance };
        }
      }
    }
    if (best) {
      const { pts, out } = best;
      const p0 = pts[0];
      // The piece of path to take off: from the end, `by` along it.
      const piece: Vec3[] = [p0];
      let run = 0;
      let i = 1;
      for (; i < pts.length; i++) {
        const step = dist(pts[i - 1], pts[i]);
        if (run + step >= by) {
          const t = (by - run) / step;
          piece.push(add(pts[i - 1], scale(sub(pts[i], pts[i - 1]), t)));
          run = by;
          break;
        }
        run += step;
        piece.push(pts[i]);
      }
      if (run < by - 1e-9 || i >= pts.length - 1) {
        throw new Error("That's as long as the sweep's whole path or more - it would remove it");
      }
      // Straight line pieces stay a line; a curve is fitted through its points.
      const straight = piece.every(point => len(sub(sub(point, p0), scale(norm(sub(piece[piece.length - 1], p0)), dot(sub(point, p0), norm(sub(piece[piece.length - 1], p0)))))) < size * 1e-6);
      const lead = size * 0.05 + 1e-3;
      const start = add(p0, scale(out, lead));
      const curve = straight || piece.length < 4 ? makeLine(p0, piece[piece.length - 1]) : makeBSplineApproximation(piece, { tolerance: size * 1e-4 + 1e-6, degMax: 5, degMin: 2 });
      const path = assembleWire([makeLine(start, p0), curve]);
      let reach0 = 0;
      for (const e of face.edges) {
        for (let j = 0; j <= 16; j++) {
          reach0 = Math.max(reach0, dist(e.pointAt(j / 16).toTuple() as Vec3, p0));
        }
      }
      const reach = reach0 * 1.1 + size * 0.02;
      const disc = assembleWire([makeCircle(reach, start, scale(out, -1))]);
      const cutter = genericSweep(disc, path, { frenet: false, transitionMode: 'round' }) as Shape3D;
      const result = fuzzyBoolean('cut', body, cutter);
      if (isEmpty(result)) {
        throw new Error('That would remove the whole sweep');
      }

      return result;
    }
  }

  return null;
}

/** Auto, drawn inside a body and reaching out of it: cut, not added. */
export const AUTO_CUT_INSIDE = "Auto cut this out of the body it starts inside - what reaches past that body isn't added. To add it (a branch, a boss), pick Add.";

/**
 * Flat pieces of one plane that meet, joined into one face each (pieces apart
 * stay apart): each lifted into a thin slab, the slabs joined, and the joined
 * slab's top brought back down (OpenCascade doesn't merge loose faces).
 */
function mergedFaces(faces: Face[], normal: Vec3): Face[] {
  if (faces.length < 2) {
    return faces;
  }
  try {
    const unitNormal = norm(normal);
    const step = Math.max(1e-3, Math.max(...faces.map(face => sizeOf(face as unknown as Shape3D))) * 0.01);
    const slab = unify(fuseAll(faces.map(face => basicFaceExtrusion(face, new Vector(scale(unitNormal, step))))));
    const top = slab.faces.filter(face => face.geomType === 'PLANE' && dot(norm(face.normalAt().toTuple() as Vec3), unitNormal) > 0.9999);
    const level = Math.max(...top.map(face => dot(face.center.toTuple() as Vec3, unitNormal)));
    const out = top.filter(face => Math.abs(dot(face.center.toTuple() as Vec3, unitNormal) - level) < step * 0.01).map(face => face.translate(scale(unitNormal, -step)) as Face);

    return out.length ? out : faces;
  } catch {
    return faces;
  }
}

/** What an extrusion goes up to: the face as it is now (a flat one: its whole plane), or a plane; and a point on it. */
function extrudeTarget(to: { face?: FaceRef; plane?: PlaneDef }, ctx: Ctx): { shape: Shape3D; point: Vec3; plane?: PlaneDef } {
  if (to.face) {
    const face = resolveFace(need(ctx.bodies, to.face.body), to.face);
    // A flat face: its whole plane (an extrusion wider than the face still stops there).
    if (face.geomType === 'PLANE') {
      const point = face.center.toTuple() as Vec3;
      const normal = norm(face.normalAt().toTuple() as Vec3);

      return { shape: face as unknown as Shape3D, point, plane: { origin: point, normal, xDir: xDirFor(normal) } };
    }

    return { shape: face as unknown as Shape3D, point: face.center.toTuple() as Vec3 };
  }
  const plane = to.plane!;

  return { shape: makeVertex(plane.origin) as unknown as Shape3D, point: plane.origin, plane };
}

/** Far enough to come out of every body, the shapes and the target: twice everything's span. */
function reachOf(ctx: Ctx, shapes: Shape3D[], extra?: Shape3D): number {
  const lo: Vec3 = [Infinity, Infinity, Infinity];
  const hi: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const shape of [...ctx.bodies.values(), ...shapes, ...(extra ? [extra] : [])]) {
    const [a, b] = shape.boundingBox.bounds;
    for (let axis = 0; axis < 3; axis++) {
      lo[axis] = Math.min(lo[axis], a[axis]);
      hi[axis] = Math.max(hi[axis], b[axis]);
    }
  }
  if (!Number.isFinite(lo[0])) {
    return 1000;
  }

  return Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) * 2 + 10;
}

/** An extrusion stopped at its target: a plane cuts off what's beyond it; a round face splits it and the part at the shape stays. */
function trimmedTo(solid: Shape3D, to: { shape: Shape3D; point: Vec3; plane?: PlaneDef }, from: Vec3): Shape3D {
  if (to.plane) {
    // The half beyond the plane (away from the shape) goes.
    const normal = dot(sub(from, to.plane.origin), to.plane.normal) > 0 ? scale(to.plane.normal, -1) : to.plane.normal;
    const beyond = halfSpace({ ...to.plane, normal: normal, xDir: xDirFor(normal) }, solid);
    const out = fuzzyBoolean('cut', solid, beyond);
    if (isEmpty(out)) {
      throw new Error("Nothing is left before that face or plane - it's behind the shape");
    }

    return out;
  }
  const oc = getOC();
  const sp = new oc.BRepAlgoAPI_Splitter();
  const args = new oc.NCollection_List_TopoDS_Shape();
  const tools = new oc.NCollection_List_TopoDS_Shape();
  const progress = new oc.Message_ProgressRange();
  try {
    args.Append(solid.wrapped);
    tools.Append(to.shape.wrapped);
    sp.SetArguments(args);
    sp.SetTools(tools);
    sp.Build(progress);
    if (!sp.IsDone()) {
      throw new Error("It couldn't be stopped at that face");
    }
    const pieces = subShapes(cast(sp.Shape()) as Shape3D, 'SOLID').map(solid => cast(solid) as Shape3D);
    if (pieces.length < 2) {
      throw new Error("It doesn't run all the way across that face - pick a face it passes through whole, or a plane");
    }
    // The piece the shape starts from: the one nearest it.
    const at = makeVertex(from) as unknown as Shape3D;
    const distances = pieces.map(piece => measureDistanceBetween(piece, at));
    const best = Math.min(...distances);

    return fuseAll(pieces.filter((_, i) => distances[i] <= best + 1e-6));
  } finally {
    sp.delete();
    args.delete();
    tools.delete();
    progress.delete();
  }
}

/** A straight extrusion's sides leaned `deg` degrees in (a draft) towards its far end along `dir`, hinged on the plane through `origin`. */
function drafted(solid: Shape3D, dir: Vec3, origin: Vec3, deg: number): Shape3D {
  const oc = getOC();
  const normal = norm(dir);
  const direction = new oc.gp_Dir(normal[0], normal[1], normal[2]);
  const at = new oc.gp_Pnt(origin[0], origin[1], origin[2]);
  const pln = new oc.gp_Pln(at, direction);
  const mk = new oc.BRepOffsetAPI_DraftAngle(solid.wrapped);
  const progress = new oc.Message_ProgressRange();
  const fail = "These sides can't lean that far - try a smaller draft angle";
  try {
    for (const face of solid.faces) {
      // The ends stay as they are; every side leans.
      if (face.geomType === 'PLANE' && Math.abs(dot(norm(face.normalAt().toTuple() as Vec3), normal)) > 0.999) {
        continue;
      }
      mk.Add(oc.TopoDS.Face(face.wrapped), direction, (DRAFT_SIGN * deg * Math.PI) / 180, pln, true);
      if (!mk.AddDone()) {
        throw new Error(fail);
      }
    }
    mk.Build(progress);
    if (!mk.IsDone()) {
      throw new Error(fail);
    }
    const out = cast(mk.Shape());
    if (!isShape3D(out) || !shapeValid(out)) {
      throw new Error(fail);
    }

    return out;
  } finally {
    mk.delete();
    pln.delete();
    at.delete();
    direction.delete();
    progress.delete();
  }
}
/** Which way OpenCascade's draft angle leans (checked in tests: a positive draft narrows the far end). */
const DRAFT_SIGN = 1;

/** How many faces are next to nothing in area (leftovers of an edit, not real faces). */
function slivers(shape: Shape3D): number {
  const areas = shape.faces.map(face => measureArea(face));
  const total = areas.reduce((a, b) => a + b, 0);

  return areas.filter(a => a < Math.max(1e-9, total * 1e-7)).length;
}
