import { cast, getOC, makePolygon } from 'replicad';
import { isEmpty, need } from '../bodies';
import { fuzzyBoolean, halfSpace, volumeOf } from '../booleans';
import { shapeValid, subShapes } from '../health';
import { add, cross, dist, scale } from '../../geom';
import type { Shape3D } from 'replicad';
import type { PlaneDef, SplitFeature, Vec3 } from '../../doc/types';
import type { Ctx } from '../types';

export function applySplit(feature: SplitFeature, ctx: Ctx) {
  const { bodies } = ctx;
  const body = need(bodies, feature.body);
  // Several planes, or bodies, at once: every piece they cut it into. The
  // biggest stays the body; the others are new ones.
  if (feature.planes?.length || feature.tools?.length || feature.noPlane) {
    const planes = [...(feature.noPlane ? [] : [feature.plane]), ...(feature.planes ?? [])];
    const tools = (feature.tools ?? []).filter(t => t !== feature.body).map(t => need(bodies, t));
    if (!planes.length && !tools.length) {
      throw new Error('Pick a plane or a body to split it with');
    }
    const pieces = splitAll(body, planes, tools);
    if (pieces.length < 2) {
      throw new Error("Nothing it's split with cuts through the body");
    }
    bodies.set(feature.body, pieces[0]);
    pieces.slice(1).forEach((piece, pieceIndex) => bodies.set(pieceIndex ? `${feature.id}:${pieceIndex + 1}` : feature.id, piece));

    return;
  }
  const half = halfSpace(feature.plane, body);
  let a: Shape3D | null = null, b: Shape3D | null = null;
  try {
    a = body.intersect(half);
    b = body.cut(half);
  } catch {
    // Faces lying on the plane (a coil's end drawn on it) can stop the
    // plain split: the tolerant one treats them as on it.
  }
  // A plane crossing a round face's seam twice (the top off a ball turned
  // round the pipe's axis) gives the plain split an empty, broken half,
  // with no error: the halves must be sound and add up to the body.
  const whole = Math.abs(volumeOf(body));
  const sound = (shape: Shape3D | null) => !!shape && !isEmpty(shape) && shapeValid(shape);
  const addsUp = () => Math.abs(Math.abs(volumeOf(a!)) + Math.abs(volumeOf(b!)) - whole) <= Math.max(1e-9, whole * 1e-4);
  if (!sound(a) || !sound(b) || !addsUp()) {
    a = fuzzyBoolean('common', body, half);
    b = fuzzyBoolean('cut', body, half);
  }
  const [inside, outside] = [a as Shape3D, b as Shape3D];
  if (isEmpty(inside) || isEmpty(outside)) {
    throw new Error("The plane doesn't cut through the body");
  }
  bodies.set(feature.body, outside);
  bodies.set(feature.id, inside);
}

/** A body cut by planes and other bodies' surfaces at once (OpenCascade's Splitter): the pieces, biggest first. */
function splitAll(body: Shape3D, planes: PlaneDef[], tools: Shape3D[]): Shape3D[] {
  const oc = getOC();
  const sp = new oc.BRepAlgoAPI_Splitter();
  const args = new oc.NCollection_List_TopoDS_Shape();
  const list = new oc.NCollection_List_TopoDS_Shape();
  const progress = new oc.Message_ProgressRange();
  try {
    args.Append(body.wrapped);
    const bb = body.boundingBox;
    for (const plane of planes) {
      // A sheet of the plane wider than the body.
      const length = (Math.hypot(bb.width, bb.height, bb.depth) + dist(bb.center as Vec3, plane.origin)) * 2 + 10;
      const x = plane.xDir;
      const y = cross(plane.normal, x);
      const corner = (along: number, across: number): Vec3 => add(plane.origin, add(scale(x, along * length), scale(y, across * length)));
      list.Append(makePolygon([corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)]).wrapped);
    }
    for (const t of tools) {
      list.Append(t.wrapped);
    }
    sp.SetArguments(args);
    sp.SetTools(list);
    sp.SetFuzzyValue(1e-5);
    sp.Build(progress);
    if (!sp.IsDone()) {
      throw new Error("It couldn't be split with those");
    }
    const pieces = subShapes(cast(sp.Shape()) as Shape3D, 'SOLID').map(solid => cast(solid) as Shape3D);
    const vol = pieces.map(piece => Math.abs(volumeOf(piece)));

    return pieces.map((piece, i) => ({ p: piece, v: vol[i] })).filter(piece => piece.v > 1e-9).sort((a, b) => b.v - a.v).map(piece => piece.p);
  } finally {
    sp.delete();
    args.delete();
    list.delete();
    progress.delete();
  }
}
