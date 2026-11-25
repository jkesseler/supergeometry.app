import { cast, getOC, measureArea } from 'replicad';
import { fillEdgeKey } from '../../doc/types';
import { resolveEdge } from '../references';
import { isEmpty, need } from '../bodies';
import { pathWire } from '../sources';
import { dist, dot, norm, scale, sub } from '../../geom';
import { subShapes } from '../health';
import { measureVolume, surfaceAt } from '../ocFree';
import { halfSpace } from '../booleans';
import { editNotes, unify } from '../faceEdit';
import { repairShape } from '../repair';
import type { AnyShape, Edge, Face, Shape3D } from 'replicad';
import type { EdgeRef, Feature, PathRef, PlaneDef, Vec3 } from '../../doc/types';
import type { Ctx } from '../types';

/**
 * Fill: a surface over a network of curves (BRepOffsetAPI_MakeFilling). The
 * boundary's edges bound it; along a body's edge it can meet that body's face
 * tangentially (G1) or with matching curvature (G2). Guides are curves it
 * passes through. The surface is an open body of its own.
 */
export function fillNetwork(fillFeature: Extract<Feature, { type: 'fill' }>, ctx: Ctx): Shape3D {
  if (!fillFeature.boundary.length) {
    throw new Error('Pick the curves or edges round the surface');
  }
  const oc = getOC();
  const orderOf = (continuity?: string) => (continuity === 'g2' ? oc.GeomAbs_Shape.GeomAbs_G2 : continuity === 'g1' ? oc.GeomAbs_Shape.GeomAbs_G1 : oc.GeomAbs_Shape.GeomAbs_C0);
  // Each body edge: its own continuity, else the one for all.
  const cont = (edgeRef?: EdgeRef) => (edgeRef && fillFeature.edgeContinuity?.[fillEdgeKey(edgeRef)]) ?? fillFeature.continuity;
  let g2 = fillFeature.continuity === 'g2';
  const edgesOf = (pathRef: PathRef): Edge[] => {
    if (pathRef.kind === 'edges') {
      return pathRef.edges.map(edge => resolveEdge(need(ctx.bodies, edge.body), edge));
    }

    return pathWire(pathRef, ctx).edges;
  };
  const fill = new oc.BRepOffsetAPI_MakeFilling(3, 15, 2, false, 1e-5, 1e-4, 0.01, 0.1, 8, 9);
  try {
    let count = 0;
    for (const pathRef of fillFeature.boundary) {
      edgesOf(pathRef).forEach((e, edgeIndex) => {
      // A body's edge, held to the face beside it (the first one of that body that has it).
        const continuity = pathRef.kind === 'edges' ? cont(pathRef.edges[edgeIndex]) : undefined;
        if (continuity === 'g2') {
          g2 = true;
        }
        const beside = pathRef.kind === 'edges' && continuity && continuity !== 'g0' ? need(ctx.bodies, pathRef.edges[edgeIndex].body).faces.find(fc => fc.edges.some(edge => edge.isSame(e))) : undefined;
        if (beside) {
          fill.Add(e.wrapped, beside.wrapped, orderOf(continuity), true);
        } else {
          fill.Add(e.wrapped, oc.GeomAbs_Shape.GeomAbs_C0, true);
        }
        count++;
      });
    }
    const only = count === 1 ? edgesOf(fillFeature.boundary[0])[0] : null;
    if (count === 0 || (only && dist(only.startPoint.toTuple() as Vec3, only.endPoint.toTuple() as Vec3) > 1e-6)) {
      throw new Error('The boundary needs curves that close a loop');
    }
    for (const pathRef of fillFeature.guides ?? []) {
      for (const e of edgesOf(pathRef)) {
        fill.Add(e.wrapped, oc.GeomAbs_Shape.GeomAbs_C0, false);
      }
    }
    fill.Build(new oc.Message_ProgressRange());
    if (!fill.IsDone()) {
      throw new Error('no fill');
    }
    const made = cast(fill.Shape()) as AnyShape;
    const faces = 'faces' in made ? (made as unknown as { faces: Face[] }).faces : [made as unknown as Face];
    if (!faces.length) {
      throw new Error('no fill');
    }
    const builder = new oc.TopoDS_Builder();
    const shell = new oc.TopoDS_Shell();
    builder.MakeShell(shell);
    for (const fc of faces) {
      builder.Add(shell, fc.wrapped);
    }
    builder.delete();

    return cast(shell) as Shape3D;
  } catch (err) {
    if (err instanceof Error && /boundary needs/.test(err.message)) {
      throw err;
    }
    if (g2) {
      throw new Error("Curvature (G2) couldn't be held along these edges - Tangent (G1) can be tried");
    }
    throw new Error("These curves don't make a surface - the boundary must close a loop (end to end), and guides lie across it");
  } finally {
    fill.delete();
  }
}

/**
 * An open surface filled down to a plane: the surface swept straight towards
 * the plane (along its normal) and past it, then everything beyond the plane
 * cut away - sides straight down, the bottom its outline projected onto the
 * plane. Parts of the surface beyond the plane are left out.
 */
export function fillToPlane(sheet: Shape3D, plane: PlaneDef): Shape3D {
  const oc = getOC();
  if (subShapes(sheet, 'SOLID').length) {
    throw new Error('Fill to Plane fills an open surface - this body is already a solid');
  }
  if (!sheet.faces.length) {
    throw new Error('This body has no surface to fill from');
  }
  const normal = norm(plane.normal);
  // Which side the surface is on (most of it): the fill goes from there to the plane.
  const side = Math.sign(dot(sub(sheet.boundingBox.center as Vec3, plane.origin), normal));
  if (!side) {
    throw new Error('The surface lies across the plane - move the plane to one side of it');
  }
  // Seen from the plane, the surface must have some area: a plane side-on to it
  // (facing its edge) has nothing to fill.
  let facing = 0;
  let total = 0;
  // And which way it faces the plane, all over: both ways means it folds back
  // over itself as seen from the plane (the blocks under it overlap).
  let up = 0;
  let down = 0;
  for (const face of sheet.faces) {
    const a = measureArea(face);
    for (const [paramU, paramV] of [[0.5, 0.5], [0.15, 0.15], [0.85, 0.15], [0.15, 0.85], [0.85, 0.85]]) {
      let fn: Vec3;
      try {
        fn = norm(surfaceAt(face, paramU, paramV).n);
      } catch {
        continue;
      }
      const cosine = dot(fn, normal);
      facing += (Math.abs(cosine) * a) / 5;
      total += a / 5;
      if (cosine > 0.02) {
        up += a;
      } else if (cosine < -0.02) {
        down += a;
      }
    }
  }
  const folds = Math.min(up, down) > Math.max(up, down) * 1e-3;
  if (facing < total * 0.3) {
    throw new Error('The plane is side-on to the surface (facing its edge) - pick a plane the surface lies over, like the ground under it');
  }
  const bb = sheet.boundingBox;
  const reach = (Math.hypot(bb.width, bb.height, bb.depth) + Math.abs(dot(sub(bb.center as Vec3, plane.origin), normal))) * 2 + 1;
  const vector = new oc.gp_Vec(-side * normal[0] * reach, -side * normal[1] * reach, -side * normal[2] * reach);
  const mk = new oc.BRepPrimAPI_MakePrism(sheet.wrapped, vector, true, true);
  let swept: Shape3D;
  try {
    swept = cast(mk.Shape()) as Shape3D;
  } finally {
    mk.delete();
    vector.delete();
  }
  // The surface's side of the plane only - one cut for the whole sweep.
  const keep = halfSpace(side > 0 ? plane : { ...plane, normal: scale(normal, -1) as Vec3 }, swept);
  const cut = swept.intersect(keep);
  if (isEmpty(cut)) {
    throw new Error("The surface doesn't reach over the plane (seen along the plane's normal, there's nothing to fill)");
  }
  // One block per surface patch, side by side: the walls between them (each
  // shared by two blocks) go, and the outside is sewn into one solid.
  const blocks = subShapes(cut, 'SOLID').map(solid => cast(solid) as Shape3D);
  const seen: { f: Face; n: number }[] = [];
  for (const b of blocks) {
    for (const face of b.faces) {
      const had = seen.find(entry => entry.f.isSame(face));
      if (had) {
        had.n++;
      } else {
        seen.push({ f: face, n: 1 });
      }
    }
  }
  const outside = seen.filter(entry => entry.n === 1).map(entry => entry.f.wrapped);
  /** The blocks joined by unions (slow, but right where they overlap). */
  const joinAll = (): Shape3D => {
    try {
      // Each patch's sweep cut on its own (cutting them all at once mixes up the overlaps).
      const own = subShapes(swept, 'SOLID').map(solid => (cast(solid) as Shape3D).intersect(keep)).filter(shape => !isEmpty(shape));
      const j = own.reduce((a, b) => a.fuse(b));
      if (isEmpty(j)) {
        throw new Error('empty');
      }

      return j;
    } catch {
      throw new Error(facing < total * 0.6 ? 'The plane is too side-on to the surface - pick a plane the surface lies over, like the ground under it' : 'The surface folds back over itself as seen from the plane too much to fill - pick a plane it lies flatter over');
    }
  };
  const size = Math.hypot(bb.width, bb.height, bb.depth);
  const sw = new oc.BRepBuilderAPI_Sewing(size * 1e-7, true, true, true, false);
  let solid: Shape3D;
  try {
    for (const face of outside) {
      sw.Add(face);
    }
    sw.Perform(new oc.Message_ProgressRange());
    const shells = subShapes(cast(sw.SewedShape()) as Shape3D, 'SHELL');
    if (shells.length !== 1) {
      solid = joinAll();
    } else {
      const fix = new oc.ShapeFix_Solid();
      const made = fix.SolidFromShell(shells[0]);
      fix.delete();
      oc.BRepLib.OrientClosedSolid(oc.TopoDS.Solid(made));
      solid = cast(made) as Shape3D;
    }
  } finally {
    sw.delete();
  }
  // The surface folds back over itself as seen from the plane: the blocks
  // overlap instead of just touching - joined the slow, sure way instead.
  if (folds) {
    solid = joinAll();
  }
  // The bottom (one flat piece per patch) and flat sides become whole faces.
  try {
    solid = unify(solid);
  } catch {
    // keep it as sewn
  }
  const v0 = Math.abs(measureVolume(solid));
  if (!(v0 > reach ** 3 * 1e-12)) {
    throw new Error("There's nothing between the surface and the plane to fill");
  }
  const repaired = repairShape(solid);
  if (!repaired) {
    throw new Error("The fill didn't come out as a clean solid (the surface folds back over itself as seen from the plane?)");
  }
  if (repaired.fixes.length) {
    editNotes.push(`Repaired automatically: ${repaired.fixes.join(', ')}.`);
  }

  return repaired.shape;
}
