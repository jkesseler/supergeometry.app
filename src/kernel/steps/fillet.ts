import { Vector, assembleWire, basicFaceExtrusion, cast, getOC, makeBezierCurve, makeFace, makeLine, makeSolid, makeSphere, makeThreePointArc, makeVertex, measureDistanceBetween, revolution } from 'replicad';
import { need } from '../bodies';
import { EDGE_GONE, resolveEdge } from '../references';
import { editNotes } from '../faceEdit';
import { add, cross, dot, len, norm, scale, sub } from '../../geom';
import { measureVolume, normalOnEdge } from '../ocFree';
import { openEdges, shapeValid } from '../health';
import type { AnyShape, Edge, Face, Shape3D } from 'replicad';
import type { EdgeFeature, EdgeRef, Vec3 } from '../../doc/types';
import type { Ctx } from '../types';

export function applyFilletOrChamfer(feature: EdgeFeature, ctx: Ctx) {
  const { bodies } = ctx;
  const byBody = new Map<string, EdgeRef[]>();
  for (const e of feature.edges) {
    byBody.set(e.body, [...(byBody.get(e.body) ?? []), e]);
  }
  for (const [bodyId, refs] of byBody) {
    const body = need(bodies, bodyId);
    // (An edge next to nothing in length - the end of a sliver, picked with the
    // rest of a face's outline before such ends were cleared away - isn't one to round.)
    const real = refs.filter(ref => ref.length > 1e-4);
    // A sliver of a picked run gone (a blade's root cut short where the hub's seam
    // crossed it, moved when the blade did) is skipped: the round runs on along the
    // smooth run it was part of. A whole edge gone still says so.
    const picked = real.length ? real : refs;
    const longest = Math.max(...picked.map(edgeRef => edgeRef.length));
    const found = picked.map((edgeRef) => {
      try {
        return resolveEdge(body, edgeRef, true);
      } catch (err) {
        if (err instanceof Error && err.message === EDGE_GONE && edgeRef.length < longest * 0.05) {
          return null;
        }
        throw err;
      }
    });
    const edges = found.filter((e): e is Edge => !!e);
    if (!edges.length) {
      throw new Error(EDGE_GONE);
    }
    if (edges.length < found.length) {
      editNotes.push(`${found.length - edges.length} tiny piece${found.length - edges.length > 1 ? 's' : ''} of the edges it was built on ${found.length - edges.length > 1 ? 'are' : 'is'} gone - the rest are ${feature.type === 'fillet' ? 'rounded' : 'chamfered'}.`);
    }
    let result: Shape3D | null = null;
    // Two-Distance chamfer: each edge's first distance runs along one of
    // its two faces (Flip: the other one), the second along the other.
    const d2 = feature.type === 'chamfer' && feature.distance2 !== undefined && feature.distance2 > 0 ? feature.distance2 : null;
    const sideOf = (e: Edge): Face => {
      const two = body.faces.filter(fc => fc.edges.some(edge => edge.isSame(e)));
      if (!two.length) {
        throw new Error('That edge has no face beside it to measure the chamfer along');
      }

      return two[feature.flip && two.length > 1 ? 1 : 0];
    };
    const twoDistance = (radius: number) =>
      body.chamfer((e: Edge) => (edges.some(edge => edge.isSame(e)) ? { distances: [radius, (d2! * radius) / feature.radius] as [number, number], selectedFace: finder => finder.inList([sideOf(e)]) } : null));
    // Variable fillet: the radius runs evenly from one end of each edge to the other.
    const r2 = feature.type === 'fillet' && feature.radius2 !== undefined && feature.radius2 > 0 && Math.abs(feature.radius2 - feature.radius) > 1e-9 ? feature.radius2 : null;
    const variable = (radius: number) =>
      body.fillet((e: Edge) => {
        if (!edges.some(edge => edge.isSame(e))) {
          return null;
        }
        const ends: [number, number] = [radius, (r2! * radius) / feature.radius];

        return feature.flip ? [ends[1], ends[0]] : ends;
      });
    if (feature.type === 'fillet' && feature.g2 && (r2 || feature.chord)) {
      throw new Error('Smooth (G2) takes one radius - set Type to Constant and Size to Radius');
    }
    const edge = (radius: number) =>
      feature.type === 'fillet' && feature.g2 ? g2Fillet(body, edges, radius) : feature.type === 'fillet' ? (feature.chord ? chordFillet(body, edges, radius, r2 ? (r2 * radius) / feature.radius : radius, !!feature.flip) : r2 ? variable(radius) : body.fillet(radius, finder => finder.inList(edges))) : d2 ? twoDistance(radius) : body.chamfer(radius, finder => finder.inList(edges));
    try {
      result = edge(feature.radius);
    } catch (err) {
      if (err instanceof Error && !/WebAssembly|kernel/i.test(err.message)) {
        throw err;
      }
      // Exactly the size that uses up a face (4 mm on both edges of an
      // 8 mm block: a full round): the two roundings meet with nothing
      // between, and that exact case fails where 3.999 works. A hair
      // less gives the same shape, to a millionth of a millimetre.
      for (const factor of [1 - 1e-6, 1 - 1e-5, 1 - 1e-4]) {
        try {
          result = edge(feature.radius * factor);
          break;
        } catch {
          // a bit less again
        }
      }
    }
    // Too big for a face beside it (OpenCascade gives up): built as a true round that
    // cuts on through that face's far edge (overflow: keep surface).
    if (!result && feature.type === 'fillet' && !feature.g2 && !r2 && !feature.chord) {
      try {
        result = blendFillet(body, edges, feature.radius, false);
        editNotes.push("The round was too big for a face beside it, so it cuts on through that face's far edge (still exactly round).");
      } catch {
        result = null;
      }
    }
    if (result && feature.type === 'fillet' && !feature.g2 && (feature.setback ?? 0) > 0) {
      result = setbackCorners(result, edges, feature.setback!, feature.radius * Math.max(1, r2 ? r2 / feature.radius : 1));
    }
    if (!result) {
      const what = feature.type === 'fillet' ? 'radius' : 'distance';
      // No corner there at all: the faces either side run smoothly into each other (the lines between a
      // freeform's patches, where a round already ends). Said as that - "too big" sent people to try smaller.
      if (edges.every(e => smoothEdge(body, e))) {
        throw new Error(`${edges.length > 1 ? 'Those edges are' : 'That edge is'} smooth already: the faces either side run into each other with no corner to ${feature.type === 'fillet' ? 'round' : 'cut'}. Pick an edge with a corner.`);
      }
      throw new Error(`That ${feature.type} doesn't fit here - the ${what} is too big for the faces around ${edges.length > 1 ? 'those edges' : 'that edge'}. Try a smaller ${what}.`);
    }
    bodies.set(bodyId, result);
  }
}

/** No corner along it: the two faces beside the edge look the same way at its middle (to about 3°). */
function smoothEdge(body: Shape3D, edge: Edge): boolean {
  const two = body.faces.filter(fc => fc.edges.some(faceEdge => faceEdge.isSame(edge)));
  if (two.length !== 2) {
    return false;
  }
  try {
    const mid = edge.pointAt(0.5);
    const [a, b] = two.map((fc) => {
      const normal = fc.normalAt(mid);

      return norm([normal.x, normal.y, normal.z]);
    });

    return Math.abs(dot(a, b)) > 0.9986;
  } catch {
    return false;
  }
}

/**
 * A fillet sized by its chord: the straight width across the round, from one
 * face to the other. Where the faces' outward normals are θ apart, a round of
 * radius r is 2·r·sin(θ/2) across, so r = width / (2·sin(θ/2)), worked out
 * along each edge (faces that meet at a changing angle get a changing radius).
 */
function chordFillet(body: Shape3D, edges: Edge[], c1: number, c2: number, flip: boolean): Shape3D {
  const oc = getOC();
  const builder = new oc.BRepFilletAPI_MakeFillet(body.wrapped, oc.ChFi3d_FilletShape.ChFi3d_Rational);
  try {
    for (const e of edges) {
      const two = body.faces.filter(fc => fc.edges.some(edge => edge.isSame(e)));
      if (two.length < 2) {
        throw new Error("That edge has a face on one side only: there's nothing to round across");
      }
      const samples = 9;
      const radii: number[] = [];
      for (let i = 0; i < samples; i++) {
        const fraction = i / (samples - 1);
        const n1 = normalOnEdge(two[0], e, fraction) ?? norm(two[0].normalAt(e.pointAt(fraction)).toTuple() as Vec3);
        const n2 = normalOnEdge(two[1], e, fraction) ?? norm(two[1].normalAt(e.pointAt(fraction)).toTuple() as Vec3);
        const half = len(sub(n1, n2)) / 2; // sin(θ/2)
        if (half < 1e-3) {
          throw new Error("The faces meet almost flat there, so a chord width can't size the round - switch Size to Radius");
        }
        const scale = flip ? c2 + (c1 - c2) * fraction : c1 + (c2 - c1) * fraction;
        radii.push(scale / (2 * half));
      }
      const even = radii.every((radius, i) => Math.abs(radius - (radii[0] + ((radii[samples - 1] - radii[0]) * i) / (samples - 1))) < 1e-7 * Math.max(1, radii[0]));
      if (even && Math.abs(radii[0] - radii[samples - 1]) < 1e-9) {
        builder.Add(radii[0], e.wrapped);
      } else if (even) {
        builder.Add(radii[0], radii[samples - 1], e.wrapped);
      } else {
        const table = new oc.NCollection_Array1_gp_Pnt2d(1, samples);
        radii.forEach((radius, i) => {
          const q = new oc.gp_Pnt2d(i / (samples - 1), radius);
          table.SetValue(i + 1, q);
          q.delete();
        });
        builder.Add(table, e.wrapped);
        table.delete();
      }
    }

    return cast(builder.Shape()) as Shape3D;
  } finally {
    builder.delete();
  }
}

/**
 * Smooth (G2) fillets: the blend's bend eases in from nothing at both faces
 * (no line in reflections where it starts), unlike a circular round whose
 * bend starts all at once. Its cross-section is a degree-5 Bezier whose first
 * and last three control points lie in the faces, so it leaves each face flat
 * (curvature 0) and tangent. It starts where a round of the same radius would.
 * Made for straight edges between flat faces (a prism of the corner, cut away
 * or, in an inside corner, added) and full circular edges between a flat face
 * and a cylinder (the same section spun round the axis).
 */
function g2Fillet(body: Shape3D, edges: Edge[], radius: number): Shape3D {
  return blendFillet(body, edges, radius, true);
}

/**
 * Rounds built from their own cross-section (see g2Fillet): `smooth`, the G2
 * Bezier; otherwise a true circular arc. Made with booleans, the round trims
 * whatever it runs into: a round too big for the face beside it cuts on
 * through that face's far edge, still exactly round (overflow, keep surface).
 */
function blendFillet(body: Shape3D, edges: Edge[], radius: number, smooth: boolean): Shape3D {
  const tuple = (vector: { toTuple(): number[] }) => vector.toTuple() as Vec3;
  const made: { tool: Shape3D; convex: boolean; along: Vec3 | null }[] = [];
  for (const e of edges) {
    const two = body.faces.filter(fc => fc.edges.some(edge => edge.isSame(e)));
    if (two.length < 2) {
      throw new Error("That edge has a face on one side only: there's nothing to round across");
    }
    const [fa, fb] = two;
    const kinds = [fa.geomType, fb.geomType];
    // A point on the edge, the edge's direction there, and each face's way in from it.
    let at: Vec3;
    let t: Vec3;
    let length = 0;
    let axis: { c: Vec3; dir: Vec3 } | null = null;
    if (e.geomType === 'LINE' && kinds.every(kind => kind === 'PLANE')) {
      const a = tuple(e.startPoint);
      const b = tuple(e.endPoint);
      length = len(sub(b, a));
      t = norm(sub(b, a));
      at = a;
    } else if (e.geomType === 'CIRCLE' && kinds.includes('PLANE') && kinds.includes('CYLINDRE') && len(sub(tuple(e.startPoint), tuple(e.endPoint))) < 1e-7) {
      const [p0, p1, p2] = [0, 1 / 3, 2 / 3].map(fraction => tuple(e.pointAt(fraction)));
      const normal = norm(cross(sub(p1, p0), sub(p2, p0)));
      // The circle's centre: equally far from all three points.
      const ab = sub(p1, p0);
      const ac = sub(p2, p0);
      const abXac = cross(ab, ac);
      const center = add(p0, scale(add(scale(cross(abXac, ab), dot(ac, ac)), scale(cross(ac, abXac), dot(ab, ab))), 1 / (2 * dot(abXac, abXac))));
      axis = { c: center, dir: normal };
      at = p0;
      t = norm(cross(normal, sub(p0, center)));
    } else {
      throw new Error(smooth ? 'Smooth (G2) works on straight edges between flat faces and on the round edges of cylinders - set Blend to Round for this edge' : 'unsupported edge');
    }
    const probe = Math.max(1e-4, radius * 1e-3);
    const inward = (face: Face): Vec3 => {
      const nrm = norm(tuple(face.normalAt(at)));
      let across = norm(cross(nrm, t));
      const q = makeVertex(add(at, scale(across, probe)));
      if (measureDistanceBetween(face, q) > probe * 0.5) {
        across = scale(across, -1);
      }
      q.delete();

      return across;
    };
    const u1 = inward(fa);
    const u2 = inward(fb);
    const n1 = norm(tuple(fa.normalAt(at)));
    const n2 = norm(tuple(fb.normalAt(at)));
    const convex = dot(n1, u2) < 0;
    const cosA = Math.max(-1, Math.min(1, dot(u1, u2)));
    const phi = Math.acos(cosA);
    if (phi > Math.PI - 1e-3) {
      throw new Error("The faces meet almost flat there: there's no corner to blend");
    }
    const setback = radius / Math.tan(phi / 2);
    // The corner's section, pushed past the faces on the side away from the blend (no faces lying on faces).
    const back = convex ? 1 : -1;
    const ext = axis ? 0 : Math.max(setback, length * 0.02);
    const corner = sub(at, scale(t, ext));
    const pointA = add(corner, scale(u1, setback));
    const pointB = add(corner, scale(u2, setback));
    // The round's middle: on the bisector, a radius short of its centre.
    const bis = norm(add(u1, u2));
    const curve = smooth
      ? makeBezierCurve([pointA, add(corner, scale(u1, 0.7 * setback)), add(corner, scale(u1, 0.4 * setback)), add(corner, scale(u2, 0.4 * setback)), add(corner, scale(u2, 0.7 * setback)), pointB])
      : makeThreePointArc(pointA, add(corner, scale(bis, radius / Math.sin(phi / 2) - radius)), pointB);
    const outB = add(pointB, scale(n2, back * setback));
    const outO = add(corner, scale(add(n1, n2), back * setback));
    const outA = add(pointA, scale(n1, back * setback));
    const wire = assembleWire([curve, makeLine(pointB, outB), makeLine(outB, outO), makeLine(outO, outA), makeLine(outA, pointA)]);
    const section = makeFace(wire);
    const tool = (axis ? revolution(section, axis.c, axis.dir, 360) : basicFaceExtrusion(section, new Vector(scale(t, length + 2 * ext)))) as Shape3D;
    made.push({ tool, convex, along: axis ? null : t });
  }
  // Two rounds side by side that run into each other along their length (both
  // edges of a block narrower than the two of them): that isn't a round that
  // overflows a face, it doesn't fit. (Rounds meeting at a corner are fine.)
  for (let i = 0; i < made.length; i++) {
    for (let j = i + 1; j < made.length; j++) {
      const [a, b] = [made[i], made[j]];
      if (!a.along || !b.along || Math.abs(dot(a.along, b.along)) < 0.999) {
        continue;
      }
      const both = a.tool.intersect(b.tool).intersect(body) as Shape3D;
      if (measureVolume(both) > 1e-6 * Math.pow(radius, 3)) {
        throw new Error('Those rounds run into each other - make the radius smaller');
      }
    }
  }
  let out = body;
  for (const tool of made) {
    out = (tool.convex ? out.cut(tool.tool) : out.fuse(tool.tool)) as Shape3D;
  }

  return out;
}

/**
 * Setback corners: where three or more of the rounded edges meet, the rounds
 * stop `s` from the corner and one smooth patch joins them (it meets every
 * face round it tangentially), instead of the rolling ball's corner. Made by
 * cutting a ball of radius s out of the rounded corner and filling the hole.
 */
function setbackCorners(body: Shape3D, edges: Edge[], setback: number, radius: number): Shape3D {
  const oc = getOC();
  const tuple = (vector: { toTuple(): number[] }) => vector.toTuple() as Vec3;
  // The corners: points where three or more of the edges end.
  const ends = edges.flatMap(e => [tuple(e.startPoint), tuple(e.endPoint)]);
  const tol = 1e-6 * (1 + Math.max(...ends.map(end => len(end))));
  const corners: Vec3[] = [];
  for (const end of ends) {
    if (!corners.some(corner => len(sub(corner, end)) < tol) && ends.filter(q => len(sub(q, end)) < tol).length >= 3) {
      corners.push(end);
    }
  }
  if (!corners.length) {
    throw new Error('Setback joins corners where three or more rounded edges meet - pick all the edges round a corner');
  }
  if (setback < radius * 1.8) {
    throw new Error(`The setback needs to be at least ${Math.ceil(radius * 1.8 * 100) / 100} for this radius (it must reach past the rounds' own corner)`);
  }
  for (const e of edges) {
    const at = corners.filter(corner => len(sub(corner, tuple(e.startPoint))) < tol || len(sub(corner, tuple(e.endPoint))) < tol).length;
    if (at && len(sub(tuple(e.endPoint), tuple(e.startPoint))) < setback * at * 1.05) {
      throw new Error('The setback is longer than an edge it runs along - make it smaller');
    }
  }
  let out = body;
  for (const corner of corners) {
    const ball = makeSphere(setback).translate(corner);
    const cut = out.cut(ball) as Shape3D;
    const near = (fc: Face) => fc.geomType === 'SPHERE' && Math.abs(len(sub(tuple(fc.center), corner)) - setback) < setback * 0.5 + tol;
    const hole = cut.faces.filter(near);
    const keep = cut.faces.filter(fc => !near(fc));
    if (!hole.length) {
      throw new Error('The setback missed the corner');
    }
    // The hole's rim, edge after edge, each held smooth to the face beside it.
    const rim = hole.flatMap(fc => fc.edges).filter(e => e.geomType !== 'LINE' || len(sub(tuple(e.startPoint), tuple(e.endPoint))) > tol);
    const fill = new oc.BRepOffsetAPI_MakeFilling(3, 15, 2, false, 1e-5, 1e-4, 0.01, 0.1, 8, 9);
    try {
      for (const e of rim) {
        const beside = keep.find(fc => fc.edges.some(edge => edge.isSame(e)));
        if (beside) {
          fill.Add(e.wrapped, beside.wrapped, oc.GeomAbs_Shape.GeomAbs_G1, true);
        } else {
          fill.Add(e.wrapped, oc.GeomAbs_Shape.GeomAbs_C0, true);
        }
      }
      fill.Build(new oc.Message_ProgressRange());
      if (!fill.IsDone()) {
        throw new Error('no patch');
      }
      const patch = cast(fill.Shape()) as AnyShape;
      const patchFaces = 'faces' in patch ? (patch as unknown as { faces: Face[] }).faces : [patch as unknown as Face];
      const made = makeSolid([...keep, ...patchFaces]);
      if (openEdges(made).length > 0 || !shapeValid(made)) {
        throw new Error('leaky');
      }
      out = made;
    } catch {
      throw new Error("The corner patch didn't fit - try a different setback");
    } finally {
      fill.delete();
    }
  }

  return out;
}
