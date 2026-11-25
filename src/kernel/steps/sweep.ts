import { Vector, assembleWire, basicFaceExtrusion, cast, genericSweep, getOC, isShape3D, makeBSplineApproximation, makeCylinder, makeFace, makeSolid, measureArea } from 'replicad';
import { pathWire, sourceFaces, withHoles } from '../sources';
import { add, cross, dist, dot, len, norm, scale, sub } from '../../geom';
import { combine, fuseAll, volumeOf } from '../booleans';
import { shapeValid, subShapes } from '../health';
import { isFault } from '../faults';
import { editNotes, sizeOf, unify } from '../faceEdit';
import { surfaceAt } from '../ocFree';
import type { Face, Shape3D, Wire } from 'replicad';
import type { SweepFeature, Vec3 } from '../../doc/types';
import type { Ctx } from '../types';

export function applySweep(feature: SweepFeature, ctx: Ctx) {
  const spine = pathWire(feature.path, ctx);
  // The profile keeps its turn round the path as it goes (OpenCascade's
  // corrected Frenet), not the path's own Frenet frame: that one flips
  // half a turn where a bend changes side (an S curve) and is undefined
  // where the path runs straight, so the tube broke into pieces that
  // jumped sideways there - a profile off the path's centre most of all.
  const scale = feature.scale ?? 1;
  if (!(scale > 0)) {
    throw new Error('The end size must be more than 0');
  }
  const twist = feature.twist ?? 0;
  const parallel = feature.orientation === 'parallel';
  if (parallel && Math.abs(twist) > 1e-9) {
    throw new Error('A twist turns the profile with the path: set Orientation to Normal to path');
  }
  const corner = feature.corner === 'mitre' ? 'right' : 'round';
  // Moved onto the path: its centre to the path's nearer end, turned square to the path there.
  const place = feature.position === 'start' ? onPathStart(sourceFaces(feature.source, ctx), spine) : null;
  // Along a straight line square to the profiles, from one of its ends,
  // unturned and the same size all the way: an extrusion, made as one (the
  // sweep's faces looked the same but wouldn't take a chamfer round a
  // gear's teeth that the extrusion's took).
  const ends = Math.abs(scale - 1) < 1e-9 && Math.abs(twist) < 1e-9 && !place ? straightRun(spine) : null;
  if (ends) {
    const faces = sourceFaces(feature.source, ctx);
    const [a, b] = ends;
    const length = dist(a, b);
    const runs = faces.map(({ face, normal }) => {
      const unitNormal = norm(normal);
      if (len(cross(norm(sub(b, a)), unitNormal)) > 1e-9) {
        return null;
      }
      const center = face.center.toTuple() as Vec3;
      if (Math.abs(dot(sub(a, center), unitNormal)) < length * 1e-9) {
        return sub(b, a);
      }
      if (Math.abs(dot(sub(b, center), unitNormal)) < length * 1e-9) {
        return sub(a, b);
      }

      return null;
    });
    if (runs.every(run => run)) {
      const parts = faces.map(({ face }, i) => basicFaceExtrusion(face, new Vector(runs[i]!)) as Shape3D);
      combine(feature.id, feature.mode, feature.target, fuseAll(parts), false, ctx);
      ctx.sweeps.set(feature.id, spine);

      return;
    }
  }
  const scaled = Math.abs(scale - 1) > 1e-9;
  const twisted = Math.abs(twist) > 1e-9;
  // Facing the same way all along, the profile has no thickness where the
  // path runs in the profile's own plane (up a post, then sideways): that
  // leg came out missing without a word, or as a body "damaged", and a
  // ring's never came back at all (the engine hung). Said, before it's tried.
  if (parallel) {
    const src = sourceFaces(feature.source, ctx);
    const facing = place ? norm(spine.tangentAt(dist(src[0].face.center.toTuple() as Vec3, spine.startPoint.toTuple() as Vec3) <= dist(src[0].face.center.toTuple() as Vec3, spine.endPoint.toTuple() as Vec3) ? 0 : 1).toTuple() as Vec3) : norm(src[0]?.normal ?? [0, 0, 1]);
    if (runsAcross(spine, facing) > 0.02) {
      throw new Error('Facing the same way, the profile slides along its own plane on part of this path and has no thickness there - turn the profile to face along that part, or set Orientation to Normal to path');
    }
  }
  // One profile along one path is one solid. Round a sharp corner of the
  // path a profile that changes size, or turns as it goes, came out in two
  // pieces run through each other (or broken): said as what it is.
  const corners = (scaled || twisted) && sharpCorners(spine);
  const cornerTrouble = () =>
    new Error(`A profile that ${scaled && twisted ? 'changes size and turns' : scaled ? 'changes size' : 'turns'} as it goes can't get round a sharp corner of the path - round the corner (a small fillet in the path's sketch), or set ${scaled && twisted ? 'End size back to 100% and Twist to 0' : scaled ? 'End size back to 100%' : 'Twist back to 0'}`);
  const whole = (part: Shape3D): Shape3D => {
    const pieces = subShapes(part, 'SOLID').length;
    if (pieces === 1 && !(corners && !shapeValid(part))) {
      return part;
    }
    if (corners) {
      throw cornerTrouble();
    }
    if (twisted) {
      throw new Error("The twist didn't build along this path - try a smoother path (no sharp corners) or less twist");
    }
    throw new Error('The sweep came apart along this path - try a smoother path (no sharp corners, no tight turns)');
  };
  // (With holes - a tube: each wire's sweep may be sound and the one cut from the other still not.)
  const made = () => withHoles(feature.source, ctx, (w0, outer0) => {
    const wire = place ? place(w0) : w0;
    const outer = place ? place(outer0) : outer0;
    const law = scaled ? scaleLaw(spine, scale) : null;
    if (parallel) {
      return whole(flatFaces(fixedSweep(wire, spine, corner, law)));
    }
    // A circle round the path's start, square to it, is the same twisted or not (a gear's bore): swept
    // plainly it stays a true cylinder (twisted, a spline with a winding seam that threads couldn't use).
    if (!twisted || roundAboutPath(wire, spine)) {
      return whole(flatFaces(genericSweep(wire, spine, { frenet: false, transitionMode: corner, law }) as Shape3D));
    }
    // Twisted: the profile's sideways direction follows a curve wound round the path.
    const reach = Math.max(1, len(sub(...(outer.boundingBox.bounds as [Vec3, Vec3]))));
    try {
      return whole(flatFaces(genericSweep(wire, spine, { auxiliarySpine: twistGuide(spine, twist, reach), transitionMode: 'right', law }) as Shape3D));
    } catch (err) {
      if (err instanceof Error && /Could not sweep/.test(err.message)) {
        throw new Error("The twist didn't build along this path - try a smoother path (no sharp corners) or less twist");
      }
      throw err;
    }
  });
  let parts: Shape3D[];
  try {
    parts = made();
  } catch (err) {
    if (!corners || isFault(err) || (err instanceof Error && /sharp corner/.test(err.message))) {
      throw err;
    }
    throw cornerTrouble();
  }
  if (corners && parts.some(part => subShapes(part, 'SOLID').length !== 1 || !shapeValid(part))) {
    throw cornerTrouble();
  }
  // Mitred: each leg of the path is a piece of its own, so a flat side
  // running round (a picture frame's front) was four faces meeting along
  // the mitres - a chamfer round its inside edge "didn't fit", a round
  // round its outside took more than it should at the corners. One face each.
  if (corner === 'right') {
    parts = parts.map(part => unify(part));
  }
  // A curve of the path that bends tighter than the profile is wide: the body folds over itself on the inside of
  // the bend and comes out lumpy there - said, with both sizes (it is no fault of the build; it looked like one).
  if (!parallel) {
    const bend = tightestBend(spine);
    const reach = Math.max(0, ...sourceFaces(feature.source, ctx).map(({ face }) => {
      const center = face.center.toTuple() as Vec3;
      let far = 0;
      for (const e of face.edges) {
        for (let i = 0; i <= 8; i++) {
          far = Math.max(far, dist(e.pointAt(i / 8).toTuple() as Vec3, center));
        }
      }

      return far;
    })) * Math.max(1, scale);
    if (bend < reach * 0.98) {
      const mm = (value: number) => String(Math.round(value * 10) / 10);
      editNotes.push(`The path bends tighter (a radius of about ${mm(bend)} mm) than the profile reaches from its middle (${mm(reach)} mm): the body folds over itself inside that bend. A gentler bend, or a smaller profile, keeps it even.`);
    }
  }
  combine(feature.id, feature.mode, feature.target, fuseAll(parts), false, ctx);
  ctx.sweeps.set(feature.id, spine);
}

/** Sweep a profile along a path without turning it (Orientation: Parallel to profile). */
function fixedSweep(wire: Wire, spine: Wire, corner: 'round' | 'right', law: ReturnType<typeof scaleLaw> | null): Shape3D {
  const oc = getOC();
  const builder = new oc.BRepOffsetAPI_MakePipeShell(spine.wrapped);
  const origin = new oc.gp_Pnt(0, 0, 0);
  const direction = new oc.gp_Dir(0, 0, 1);
  const ax = new oc.gp_Ax2(origin, direction);
  try {
    builder.SetMode(ax);
    builder.SetTransitionMode(corner === 'right' ? oc.BRepBuilderAPI_TransitionMode.BRepBuilderAPI_RightCorner : oc.BRepBuilderAPI_TransitionMode.BRepBuilderAPI_RoundCorner);
    if (law) {
      builder.SetLaw(wire.wrapped, law, false, false);
    } else {
      builder.Add(wire.wrapped, false, false);
    }
    builder.Build();
    if (!builder.IsDone()) {
      throw new Error("The profile can't be swept along this path facing the same way - try Normal to path");
    }
    builder.MakeSolid();
    const shape = cast(builder.Shape());
    if (!isShape3D(shape)) {
      throw new Error("The profile can't be swept along this path facing the same way - try Normal to path");
    }

    return shape;
  } finally {
    builder.delete();
    ax.delete();
    origin.delete();
    direction.delete();
  }
}

/**
 * Profile Position "start": a function that moves a wire of the profile so
 * the profile's centre is on the path's end nearer to it, and turns it square
 * to the path there (its normal along the path, pointing on along it).
 */
function onPathStart(faces: { face: Face; normal: Vec3 }[], spine: Wire): (w: Wire) => Wire {
  if (!faces.length) {
    return wire => wire;
  }
  const center = faces[0].face.center.toTuple() as Vec3;
  const normal = norm(faces[0].normal);
  const a = spine.startPoint.toTuple() as Vec3;
  const b = spine.endPoint.toTuple() as Vec3;
  const atStart = dist(center, a) <= dist(center, b);
  const point = atStart ? a : b;
  // On along the path, from that end.
  let t = norm(spine.tangentAt(atStart ? 0 : 1).toTuple() as Vec3);
  if (!atStart) {
    t = scale(t, -1);
  }
  // The profile's side that faces along the path stays its front (normal·t > 0 after turning).
  const from = dot(normal, t) < 0 ? scale(normal, -1) : normal;
  const axis = cross(from, t);
  const length = len(axis);
  const angle = (Math.atan2(length, dot(from, t)) * 180) / Math.PI;

  return (wire) => {
    let out = wire.clone();
    if (length > 1e-9 && Math.abs(angle) > 1e-9) {
      out = out.rotate(angle, center, scale(axis, 1 / length));
    }

    return out.translate(sub(point, center));
  };
}

/** The smallest radius any curve of the wire bends with (its corners between curves don't count; a straight wire: Infinity). */
function tightestBend(wire: Wire): number {
  let least = Infinity;
  for (const e of wire.edges) {
    if (e.geomType === 'LINE') {
      continue;
    }
    const samples = 240;
    const points: Vec3[] = [];
    for (let i = 0; i <= samples; i++) {
      points.push(e.pointAt(i / samples).toTuple() as Vec3);
    }
    for (let i = 1; i < samples; i++) {
      const ab = dist(points[i - 1], points[i]);
      const bc = dist(points[i], points[i + 1]);
      const ac = dist(points[i - 1], points[i + 1]);
      const semiPerimeter = (ab + bc + ac) / 2;
      const area = Math.sqrt(Math.max(0, semiPerimeter * (semiPerimeter - ab) * (semiPerimeter - bc) * (semiPerimeter - ac)));
      if (area > 1e-14 * ab * bc) {
        least = Math.min(least, (ab * bc * ac) / (4 * area));
      }
    }
  }

  return least;
}



/** Is the face flat (every point on one plane, every normal the same)? */
function isFlat(face: Face, tol: number): boolean {
  try {
    const mid = surfaceAt(face, 0.5, 0.5);
    const n0 = norm(mid.n);
    const tuple = mid.p;
    for (let i = 0; i <= 4; i++) {
      for (let j = 0; j <= 4; j++) {
        const { p, n } = surfaceAt(face, i / 4, j / 4);
        if (Math.abs(dot(sub(p, tuple), n0)) > tol) {
          return false;
        }
        if (len(cross(norm(n), n0)) > 1e-7) {
          return false;
        }
      }
    }

    return true;
  } catch {
    return false;
  }
}

/** The cylinder a face lies on (its axis and radius), if it's one: every normal square to one direction, meeting one line. */
function cylinderFit(face: Face, tol: number): { c: Vec3; a: Vec3; r: number } | null {
  const points: Vec3[] = [];
  const normals: Vec3[] = [];
  for (let i = 0; i <= 4; i++) {
    for (let j = 0; j <= 4; j++) {
      const { p, n } = surfaceAt(face, i / 4, j / 4);
      points.push(p);
      normals.push(norm(n));
    }
  }
  // The axis: square to the two normals furthest apart.
  let best = 0;
  let a: Vec3 = [0, 0, 0];
  for (let index = 1; index < normals.length; index++) {
    const normalCross = cross(normals[0], normals[index]);
    if (len(normalCross) > best) {
      [best, a] = [len(normalCross), normalCross];
    }
  }
  if (best < 1e-3) {
    return null;
  }
  a = norm(a);
  if (normals.some(normal => Math.abs(dot(normal, a)) > 1e-7)) {
    return null;
  }
  // Where the normals at 0 and the furthest one meet (seen along the axis): the centre.
  const farIndex = normals.findIndex(normal => len(cross(normals[0], normal)) === best);
  const flat = (point: Vec3) => sub(point, scale(a, dot(point, a)));
  const [p0, pk, n0, nk] = [flat(points[0]), flat(points[farIndex]), flat(normals[0]), flat(normals[farIndex])];
  // p0 + t n0 = pk + s nk: solved in the plane square to the axis.
  const offset = sub(pk, p0);
  const den = dot(cross(n0, nk), a);
  if (Math.abs(den) < 1e-9) {
    return null;
  }
  const t = dot(cross(offset, nk), a) / den;
  const center = add(p0, scale(n0, t));
  const radius = Math.abs(t);
  if (points.some(point => Math.abs(len(sub(flat(point), center)) - radius) > tol * 10)) {
    return null;
  }

  return { c: center, a, r: radius };
}

/** The face rebuilt on a true cylinder, within its own edges (null if that doesn't work out). */
function asCylinder(face: Face, cyl: { c: Vec3; a: Vec3; r: number }, size: number): Face | null {
  const oc = getOC();
  const length = size * 4 + cyl.r;
  const solid = makeCylinder(cyl.r, 2 * length, sub(cyl.c, scale(cyl.a, length)), cyl.a);
  const side = solid.faces.find(face => face.geomType === 'CYLINDRE');
  if (!side) {
    return null;
  }
  const surface = oc.BRep_Tool.Surface(side.wrapped);
  const wires = [face.clone().outerWire(), ...face.clone().innerWires()];
  const maker = new oc.BRepBuilderAPI_MakeFace(surface, wires[0].wrapped, true);
  try {
    for (const wire of wires.slice(1)) {
      maker.Add(wire.wrapped);
    }
    if (!maker.IsDone()) {
      return null;
    }
    const fix = new oc.ShapeFix_Face(maker.Face());
    try {
      fix.Perform();
      fix.FixOrientation();
      const out = cast(fix.Face()) as Face;

      return out.geomType === 'CYLINDRE' && Math.abs(measureArea(out) - measureArea(face)) < Math.max(1e-9, measureArea(face) * 1e-5) ? out : null;
    } finally {
      fix.delete();
    }
  } finally {
    maker.delete();
  }
}

/**
 * Faces that are flat but not stored as planes - a straight side swept round
 * an arc is a "surface of revolution" - made planes: they merge with the flat
 * faces either side, and Move / Scale / Replace Face can tilt and trim them
 * (a lever's tip couldn't be narrowed, its bottom couldn't be brought down:
 * "the neighbouring faces don't enclose it"). The shape stays as it was if
 * anything doesn't come out exactly the same.
 */
function flatFaces(shape: Shape3D): Shape3D {
  const size = sizeOf(shape);
  const tol = size * 1e-7 + 1e-9;
  let changed = false;
  const faces = shape.faces.map((face) => {
    if (face.geomType === 'PLANE' || face.geomType === 'CYLINDRE') {
      return face;
    }
    try {
      if (isFlat(face, tol)) {
        // (outerWire uses up the face it is asked of.)
        const flat = makeFace(face.clone().outerWire(), face.clone().innerWires());
        if (flat.geomType !== 'PLANE') {
          return face;
        }
        changed = true;

        return flat;
      }
      // A straight line swept round an arc, along its axis: a cylinder.
      const cyl = cylinderFit(face, tol);
      if (!cyl) {
        return face;
      }
      const round = asCylinder(face, cyl, size);
      if (!round) {
        return face;
      }
      changed = true;

      return round;
    } catch {
      return face;
    }
  });
  if (!changed) {
    return shape;
  }
  try {
    const solid = makeSolid(faces) as unknown as Shape3D;
    const volume = Math.abs(volumeOf(shape));
    if (!shapeValid(solid) || Math.abs(Math.abs(volumeOf(solid)) - volume) > Math.max(1e-9, volume * 1e-6)) {
      return shape;
    }

    return unify(solid, size) as Shape3D;
  } catch {
    return shape;
  }
}

/** A size that runs evenly from 1 at the path's start to `endScale` at its end (a sweep's end scale). */
function scaleLaw(spine: Wire, endScale: number) {
  const oc = getOC();
  const ad = new oc.BRepAdaptor_CompCurve(spine.wrapped, false);
  const t0 = ad.FirstParameter();
  const t1 = ad.LastParameter();
  ad.delete();
  const law = new oc.Law_Linear();
  law.Set(t0, 1, t1, endScale);

  return law;
}

/**
 * How much of a path (as a share of its length) runs across `facing` - in the
 * plane of a profile that faces that way: a profile held facing the same way
 * has no thickness along those parts.
 */
function runsAcross(spine: Wire, facing: Vec3): number {
  let total = 0;
  let across = 0;
  for (const e of spine.edges) {
    const count = e.length as number;
    const samples = e.geomType === 'LINE' ? 1 : 32;
    for (let i = 0; i < samples; i++) {
      const t = norm(e.tangentAt((i + 0.5) / samples).toTuple() as Vec3);
      if (Math.abs(dot(t, facing)) < 0.005) {
        across += count / samples;
      }
    }
    total += count;
  }

  return total > 0 ? across / total : 0;
}

/** Does a path have a sharp corner (two of its edges meeting at an angle)? */
function sharpCorners(spine: Wire): boolean {
  const edges = spine.edges;
  const size = edges.reduce((sum, e) => sum + (e.length as number), 0) || 1;
  const ends = edges.flatMap(e => [0, 1].map(end => ({ e, p: e.pointAt(end).toTuple() as Vec3, t: norm(e.tangentAt(end).toTuple() as Vec3) })));
  for (let i = 0; i < ends.length; i++) {
    for (let j = i + 1; j < ends.length; j++) {
      if (ends[i].e === ends[j].e || dist(ends[i].p, ends[j].p) > size * 1e-7) {
        continue;
      }
      // (The same line through the point, whichever way each edge runs: within about two degrees.)
      if (Math.abs(dot(ends[i].t, ends[j].t)) < 0.9994) {
        return true;
      }
    }
  }

  return false;
}

/** A path that runs straight from its start to its end: its ends (else null). */
function straightRun(spine: Wire): [Vec3, Vec3] | null {
  const oc = getOC();
  const ad = new oc.BRepAdaptor_CompCurve(spine.wrapped, true);
  const a = new oc.gp_Pnt();
  const b = new oc.gp_Pnt();
  try {
    ad.D0(ad.FirstParameter(), a);
    ad.D0(ad.LastParameter(), b);
    const start: Vec3 = [a.X(), a.Y(), a.Z()];
    const run = sub([b.X(), b.Y(), b.Z()], start);
    const length = len(run);
    if (length < 1e-9 || spine.edges.some(e => e.geomType !== 'LINE')) {
      return null;
    }
    const direction = norm(run);
    for (const e of spine.edges) {
      for (const t of [0, 1]) {
        const q = sub(e.pointAt(t).toTuple() as Vec3, start);
        if (len(cross(q, direction)) > length * 1e-9) {
          return null;
        }
      }
    }

    return [start, add(start, run)];
  } finally {
    b.delete();
    a.delete();
    ad.delete();
  }
}

/** Every point of the wire as far from the path's start, in the plane square to the path there (a circle round it). */
function roundAboutPath(wire: Wire, spine: Wire): boolean {
  const oc = getOC();
  const ad = new oc.BRepAdaptor_CompCurve(spine.wrapped, true);
  const point = new oc.gp_Pnt();
  const tangent = new oc.gp_Vec();
  try {
    ad.D1(ad.FirstParameter(), point, tangent);
    const origin: Vec3 = [point.X(), point.Y(), point.Z()];
    const t = norm([tangent.X(), tangent.Y(), tangent.Z()]);
    let radius = -1;
    const tol = Math.max(1e-9, len(sub(...(wire.boundingBox.bounds as [Vec3, Vec3]))) * 1e-7);
    for (const e of wire.edges) {
      for (let i = 0; i <= 8; i++) {
        const q = sub(e.pointAt(i / 8).toTuple() as Vec3, origin);
        if (Math.abs(dot(q, t)) > tol) {
          return false;
        }
        if (radius < 0) {
          radius = len(q);
        } else if (Math.abs(len(q) - radius) > tol) {
          return false;
        }
      }
    }

    return radius > tol;
  } finally {
    tangent.delete();
    point.delete();
    ad.delete();
  }
}

/**
 * A curve wound round a sweep's path that turns `deg` degrees from start to
 * end, evenly by length, `reach` out from the path: a sweep that keeps the
 * profile pointing at it twists. It starts from the path's own frame that
 * doesn't spin (rotation minimizing, by double reflection), so a twist of 0
 * would be the plain sweep.
 */
function twistGuide(spine: Wire, deg: number, reach: number): Wire {
  const oc = getOC();
  const ad = new oc.BRepAdaptor_CompCurve(spine.wrapped, true);
  const u0 = ad.FirstParameter();
  const u1 = ad.LastParameter();
  const samples = Math.min(600, 64 + Math.ceil((Math.abs(deg) / 360) * 32));
  const pts: Vec3[] = [];
  for (let i = 0; i <= samples; i++) {
    const curvePoint = ad.Value(u0 + ((u1 - u0) * i) / samples);
    pts.push([curvePoint.X(), curvePoint.Y(), curvePoint.Z()]);
    curvePoint.delete();
  }
  ad.delete();
  const tan = pts.map((_, i) => norm(sub(pts[Math.min(samples, i + 1)], pts[Math.max(0, i - 1)])));
  // Any square-on direction to start with.
  const t0 = tan[0];
  let radial = norm(cross(t0, Math.abs(t0[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]));
  const along = [0];
  for (let i = 1; i <= samples; i++) {
    along.push(along[i - 1] + len(sub(pts[i], pts[i - 1])));
  }
  const total = along[samples] || 1;
  const out: Vec3[] = [];
  for (let i = 0; i <= samples; i++) {
    if (i > 0) {
      const v1 = sub(pts[i], pts[i - 1]);
      const c1 = dot(v1, v1);
      if (c1 > 1e-18) {
        const rL = sub(radial, scale(v1, (2 / c1) * dot(v1, radial)));
        const tL = sub(tan[i - 1], scale(v1, (2 / c1) * dot(v1, tan[i - 1])));
        const v2 = sub(tan[i], tL);
        const c2 = dot(v2, v2);
        radial = norm(c2 > 1e-18 ? sub(rL, scale(v2, (2 / c2) * dot(v2, rL))) : rL);
      }
    }
    const a = ((deg * Math.PI) / 180) * (along[i] / total);
    const b = cross(tan[i], radial);
    out.push(add(pts[i], scale(add(scale(radial, Math.cos(a)), scale(b, Math.sin(a))), reach)));
  }

  return assembleWire([makeBSplineApproximation(out, { tolerance: reach * 1e-5, degMax: 5, degMin: 3 })]);
}
