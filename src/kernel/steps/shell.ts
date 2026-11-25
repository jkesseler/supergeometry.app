import { Vector, basicFaceExtrusion, cast, getOC, makeBox, makeCompound, makeFace, makeLine, makeSolid, makeVertex, measureDistanceBetween } from 'replicad';
import { isEmpty, need } from '../bodies';
import { resolveFace } from '../references';
import { editNotes, onFace as pointOnFace, sizeOf, unify } from '../faceEdit';
import { measureVolume, quickVolume } from '../ocFree';
import { fuseAll, fuzzyBoolean, insideOf, volumeOf } from '../booleans';
import { deepCopy, hairThin, openEdges, shapeValid, subShapes } from '../health';
import { repairShape } from '../repair';
import { applyAffine } from '../affine';
import { deleteFaces, subdivide } from '../../freeform/cage';
import { add, dist, dot, norm, scale, sub } from '../../geom';
import { cageToShape } from '../freeform';
import { faceTriangles } from '../meshing';
import { isFault } from '../faults';
import type { AnyShape, Face, Shape3D } from 'replicad';
import type { Feature, ShellFeature, Vec3 } from '../../doc/types';
import type { Affine, Ctx } from '../types';

export function applyShell(feature: ShellFeature, ctx: Ctx) {
  const { bodies } = ctx;
  const body = need(bodies, feature.body);
  let faces = feature.faces.map(face => resolveFace(body, face));
  // Every face picked (a ball's one round face) leaves no wall to keep: hollow it sealed instead.
  if (faces.length && body.faces.every(face => faces.some(removed => removed.isSame(face)))) {
    faces = [];
    editNotes.push("Every face of the body was picked, so there's no opening: it's hollow inside, sealed. Pick fewer faces for an opening.");
  }
  // A freeform: drop the picked cage faces and thicken the rest inward -
  // exact, where shelling its smooth surfaces is unreliable.
  const ff = ctx.freeforms.get(feature.body);
  if (ff && faces.length) {
    bodies.set(feature.body, shellFreeform(ff, faces, Math.abs(feature.thickness)));
    ctx.freeforms.delete(feature.body);

    return;
  }
  // Positive thickness shells inward (negative grows outward with rounded corners).
  const t = Math.abs(feature.thickness);
  // (To a thousandth first: a hollowed body is well off what it was. Only one within a hundredth is measured exactly.)
  const q0 = Math.abs(quickVolume(body));
  const hollowed = (shape: Shape3D | null): shape is Shape3D => !!shape && (Math.abs(Math.abs(quickVolume(shape)) - q0) > 0.01 * q0 || Math.abs(Math.abs(volumeOf(shape)) - Math.abs(volumeOf(body))) > 1e-6 * Math.abs(volumeOf(body)));
  // A shell to trust: hollow, a sound solid, a wall behind every face it
  // kept and nothing left deep inside. OpenCascade can "succeed" without
  // hollowing anything, or hollowing only a corner of it - or hollow it
  // and leave a wall out: where two faces are closer together than two
  // walls (a pocket 1.7 mm from a hole, 1 mm walls) it dropped the
  // pocket's walls without a word, the pocket a window into the hollow.
  const kept = body.faces.filter(face => !faces.some(removed => removed.isSame(face)));
  const gaps = openEdges(body).length;
  // (No hair-thin faces either, as every edit is held to: the exact case
  // above comes out "fine" with its inside rounds shrunk to slivers.)
  const thin0 = hairThin(body);
  const fine = (shape: Shape3D) => {
    if (hairThin(shape) <= thin0) {
      return true;
    }
    try {
      return hairThin(unify(shape)) <= thin0;
    } catch {
      return false;
    }
  };
  // (The quick checks first: measuring the volume of a way that came out
  // wrong took 6.6 s in a split box's shell, the hair-thin faces that
  // turned it down a fifth of a second.)
  const good = (shape: Shape3D | null): shape is Shape3D => !!shape && shapeValid(shape) && openEdges(shape).length <= gaps && fine(shape) && hollowed(shape) && wallsStand(body, shape, kept, t) && hollowInside(body, shape, kept, t);
  // The ways there are, in turn: in one step (no face picked: that gives
  // only the inner core back - a battery case came out solid); hollowed
  // with an offset copy of the body, the openings cut through (many-faced
  // shapes trip the one-step shell); and that a hair thicker - a wall
  // exactly as thick as the corners are round (2 mm walls in a box with
  // 2 mm corners) has inside corners that shrink to nothing, and that
  // exact case defeats both: a hair thicker gives the sharp inside corner
  // it should have.
  const ways: (() => Shape3D | null)[] = [
    () => {
      if (!faces.length) {
        return null;
      }
      try {
        return body.shell(t, finder => finder.inList(faces));
      } catch {
        return null;
      }
    },
    () => shellByOffset(body, faces, t),
    // (Sealed too: a closed box with 2 mm rounds hollowed 2 thick.)
    ...[1 + 1e-4, 1 + 1e-3].map(factor => () => shellByOffset(body, faces, t * factor)),
    // ...and the hollow put together from what is cut out of the body, each
    // cut-out grown on its own: where two of them are closer than two walls
    // (a pocket 1.7 mm from a hole, 1 mm walls) offsetting the whole body fails.
    () => shellByOffset(body, faces, t, true)
  ];
  let out: Shape3D | null = null;
  // (Hollow, but torn or broken: put right below, if nothing better comes -
  // the first of them, found only then: its volume can be slow to measure.)
  const tried: Shape3D[] = [];
  for (const way of ways) {
    const made = way();
    if (good(made)) {
      out = made;
      break;
    }
    if (made) {
      tried.push(made);
    }
  }
  const rough = out ? null : (tried.find(shape => hollowed(shape)) ?? null);
  if (!out && rough) {
    // Put right as any edit's result is - and then held to the same: a
    // broken shell "repaired" came out sound and a sixth too light, the
    // walls round two bores gone.
    const fixed = repairShape(rough, { maxSolids: Math.max(1, subShapes(body, 'SOLID').length) });
    if (fixed && good(fixed.shape)) {
      if (fixed.fixes.length) {
        editNotes.push(`Repaired automatically: ${fixed.fixes.join(', ')}.`);
      }
      out = fixed.shape;
    }
  }
  // (A pocket or a blind hole cut into the face being opened hangs from that face alone.)
  const loose = faces.some(face => face.clone().innerWires().length > 0);
  if (!out) {
    throw new Error(!rough ? "Shell didn't work on this shape (try a smaller thickness)" : loose ? `${WALLS_CLASH} - or what is cut into the opened face would be left standing loose (open another face)` : WALLS_CLASH);
  }
  bodies.set(feature.body, out);
}

/** Shell a freeform: remove the cage quads under the picked faces, thicken the sheet inward. */
function shellFreeform(ff: { feature: Extract<Feature, { type: 'freeform' }>; m: Affine }, faces: Face[], t: number): Shape3D {
  const cage = { ...ff.feature.cage, verts: ff.feature.cage.verts.map(vertex => applyAffine(ff.m, vertex)) };
  // Each body face is one cage quad's patch: match by the patch's middle point.
  const sub3 = subdivide(cage, 3);
  const mid = sub3.n / 2;
  const centres = sub3.grids.map(grid => sub3.points[grid[mid][mid]]);
  const drop = new Set<number>();
  for (const face of faces) {
    const center = face.center.toTuple() as Vec3;
    let best = 0;
    centres.forEach((q, i) => {
      if (dist(q, center) < dist(centres[best], center)) {
        best = i;
      }
    });
    drop.add(best);
  }
  if (drop.size >= cage.faces.length) {
    throw new Error('Shell needs at least one face to stay');
  }
  const open = deleteFaces(cage, [...drop]);

  // Closed cages face outward, so "down" (against the normals) is inward.
  return cageToShape(open, 3, { thickness: t, side: 'down' });
}

export const WALLS_CLASH
  = "Walls this thick don't fit everywhere: somewhere two faces are closer together than two walls (a hole near a side, a pocket near a hole), and their walls would run into each other - try a thinner wall";

/**
 * Does a shell have a wall behind every face it kept? Spots half a wall deep
 * behind points spread over each face (so in the wall wherever it is in the
 * body): every one of them that is in the body must be in the shell too.
 * (600 spots at most, shared out among the faces. Asked point by point: done
 * with booleans against little cubes, the check of a shelled mouse - spline
 * walls, offset faces inside - took half a minute.)
 */
function wallsStand(body: Shape3D, shell: Shape3D, kept: Face[], t: number): boolean {
  if (!kept.length || !(t > 0)) {
    return true;
  }
  try {
    const each = Math.max(1, Math.min(6, Math.floor(600 / kept.length)));
    const every = Math.ceil(kept.length / 600);
    const at: Vec3[] = [];
    // (Each told by a segment out through the face it is behind, to just past it: outside both.)
    const past: Vec3[] = [];
    for (const [i, face] of kept.entries()) {
      if (i % every) {
        continue;
      }
      for (const { p, n } of spotsOn(body, face, each)) {
        at.push(sub(p, scale(n, t / 2)));
        past.push(add(p, scale(n, t / 50)));
      }
    }
    if (!at.length) {
      return true;
    }
    const inBody = insideAlong(body, at, past, true);
    const keep = at.map((_, index) => index).filter(index => inBody[index]);
    const inShell = insideAlong(shell, keep.map(index => at[index]), keep.map(index => past[index]));

    return inShell.every(Boolean);
  } catch {
    // Can't tell: the usual checks speak for it.
    return true;
  }
}

/**
 * Which of the points are inside the solid, each told by a short segment from
 * it to a point known to be outside (just past the face the point sits
 * behind): inside when the segment crosses the solid's boundary an odd number
 * of times. All the segments go into one section with the solid, which only
 * looks at the faces near each one - where measuring each point's distance to
 * the whole solid (insideOf) took 50 s for a guitar's shelled body. A segment
 * the section can't tell about (it runs along a face, or a crossing lands on
 * one of its ends) is asked the slow way.
 */
function insideAlong(shape: Shape3D, from: Vec3[], to: Vec3[], sound = false): boolean[] {
  const oc = getOC();
  const out: (boolean | undefined)[] = from.map(() => undefined);
  const size = sizeOf(shape);
  const tol = Math.max(1e-6, size * 1e-6);
  // ...and each one again the other way, right out of the solid: a sound
  // solid gives both the same answer. (A shell whose walls ran into each
  // other kept a pocket's face with no wall behind it - air on both sides:
  // the short way through it counted it, and said "inside".)
  // (Out the shortest way, square to the nearest side of its box: through
  // the middle of a guitar's body every ray crossed so many faces that this
  // took as long as asking each point the slow way.)
  const [lo, hi] = shape.boundingBox.bounds;
  const margin = size * 0.01 + 1e-3;
  const back = from.map((a): Vec3 => {
    let best = Infinity;
    let end: Vec3 = a;
    for (let axis = 0; axis < 3; axis++) {
      for (const [edge, way] of [[lo[axis], -1], [hi[axis], 1]] as const) {
        const distance = way * (edge - a[axis]);
        if (distance < best) {
          best = distance;
          end = [...a] as Vec3;
          end[axis] = edge + way * margin;
        }
      }
    }

    return end;
  });
  const count = from.length;
  // (A solid known to be sound - a step's input, checked when it was made - needs only the short way.)
  const ends = sound ? to : [...to, ...back];
  const segs = (sound ? from : [...from, ...from]).map((a, i) => ({ a, b: ends[i], d: sub(ends[i], a), l: Math.hypot(...sub(ends[i], a)) }));
  const usable = segs.map(segment => segment.l > 10 * tol);
  const lines = segs.filter((_, i) => usable[i]).map(segment => makeLine(segment.a, segment.b));
  if (lines.length) {
    const sec = new oc.BRepAlgoAPI_Section();
    const progress = new oc.Message_ProgressRange();
    const args = new oc.NCollection_List_TopoDS_Shape();
    const tools = new oc.NCollection_List_TopoDS_Shape();
    const comp = makeCompound(lines) as unknown as Shape3D;
    try {
      args.Append(comp.wrapped);
      tools.Append(shape.wrapped);
      sec.SetArguments(args);
      sec.SetTools(tools);
      sec.SetNonDestructive(true);
      sec.Build(progress);
      if (sec.IsDone()) {
        const made = cast(sec.Shape());
        // Where each segment crosses: its parameter along it (0 at the point, 1 outside).
        const hits: number[][] = segs.map(() => []);
        const bad = segs.map(() => false);
        const onto = (point: Vec3): number[] => {
          const at: number[] = [];
          segs.forEach((segment, i) => {
            if (!usable[i]) {
              return;
            }
            const fraction = dot(sub(point, segment.a), segment.d) / (segment.l * segment.l);
            if (fraction < -1e-9 || fraction > 1 + 1e-9) {
              return;
            }
            const off = sub(point, add(segment.a, scale(segment.d, fraction)));
            if (Math.hypot(...off) < tol * 10) {
              at.push(i, fraction);
            }
          });

          return at;
        };
        // (A segment lying along a face comes back as an edge: that one can't be told by counting.)
        for (const e of 'edges' in made ? made.edges : []) {
          const at = onto(e.pointAt(0.5).toTuple() as Vec3);
          for (let index = 0; index < at.length; index += 2) {
            bad[at[index]] = true;
          }
        }
        const ex = new oc.TopExp_Explorer(made.wrapped, oc.TopAbs_ShapeEnum.TopAbs_VERTEX, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
        const pts: Vec3[] = [];
        for (; ex.More(); ex.Next()) {
          const item = ex.Current();
          const q = oc.BRep_Tool.Pnt(oc.TopoDS.Vertex(item));
          pts.push([q.X(), q.Y(), q.Z()]);
          q.delete();
          item.delete();
        }
        ex.delete();
        for (const point of pts) {
          const at = onto(point);
          for (let index = 0; index < at.length; index += 2) {
            const [i, fraction] = [at[index], at[index + 1]];
            // On an end: the point itself on the boundary, or the outside point not outside.
            if (fraction * segs[i].l < tol * 10 || (1 - fraction) * segs[i].l < tol * 10) {
              bad[i] = true;
            } else if (!hits[i].some(found => Math.abs(found - fraction) * segs[i].l < tol * 10)) {
              // (The same crossing twice: two faces meeting there.)
              hits[i].push(fraction);
            }
          }
        }
        for (let i = 0; i < count; i++) {
          const j = sound ? i : i + count;
          if (usable[i] && usable[j] && !bad[i] && !bad[j] && hits[i].length % 2 === hits[j].length % 2) {
            out[i] = hits[i].length % 2 === 1;
          }
        }
      }
    } catch {
      // (Asked the slow way below.)
    } finally {
      sec.delete();
      progress.delete();
      args.delete();
      tools.delete();
    }
  }
  const left = from.map((_, i) => i).filter(i => out[i] === undefined);
  if (left.length) {
    const slow = insideOf(shape, left.map(i => from[i]));
    left.forEach((i, index) => (out[i] = slow[index]));
  }

  return out as boolean[];
}

/** Up to `spotCount` points spread over a face (the middles of triangles of its mesh, taken evenly through them), each with the face's outward normal there. */
function spotsOn(body: Shape3D, face: Face, spotCount: number): { p: Vec3; n: Vec3 }[] {
  const one = () => [pointOnFace(body, face)];
  if (spotCount <= 1) {
    return one();
  }
  const tri = faceTriangles(face, sizeOf(body));
  if (!tri) {
    return one();
  }
  const count = tri.trianglesIndexes.length / 3;
  const vertexAt = (i: number): Vec3 => [tri!.vertices[3 * i], tri!.vertices[3 * i + 1], tri!.vertices[3 * i + 2]];
  const out: { p: Vec3; n: Vec3 }[] = [];
  for (let index = 0; index < Math.min(spotCount, count); index++) {
    const at = Math.floor(((index + 0.5) * count) / Math.min(spotCount, count)) * 3;
    const [a, b, vertexC] = [0, 1, 2].map(j => vertexAt(tri!.trianglesIndexes[at + j]));
    const centroid = scale(add(add(a, b), vertexC), 1 / 3);
    try {
      out.push({ p: centroid, n: norm(face.normalAt(centroid).toTuple() as Vec3) });
    } catch {
      // (A spot the surface gives no normal at: the others will do.)
    }
  }

  return out.length ? out : one();
}

/**
 * Is a shell hollow where it should be? Spots three walls deep behind its
 * faces that are well clear of every face of the body (more than two walls:
 * past the sharpest inside corner a shell can have) must be empty - a shell
 * that hollowed one corner of a part and left the rest solid passed for one.
 */
function hollowInside(body: Shape3D, shell: Shape3D, kept: Face[], t: number): boolean {
  if (!kept.length || !(t > 0)) {
    return true;
  }
  try {
    const skin = subShapes(body, 'SHELL');
    if (!skin.length) {
      return true;
    }
    const every = Math.ceil(kept.length / 40);
    const at: Vec3[] = [];
    const past: Vec3[] = [];
    // (One measurer for each skin, asked about every spot: one made for each
    // spot kept what it worked out about the whole skin, for good - release.ts.)
    const oc = getOC();
    const far = skin.map((sk) => {
      const measure = new oc.BRepExtrema_DistShapeShape();
      measure.LoadS1(sk);

      return measure;
    });
    try {
      for (const [i, face] of kept.entries()) {
        if (i % every) {
          continue;
        }
        const { p, n } = pointOnFace(body, face);
        const q = sub(p, scale(n, 3 * t));
        const point = makeVertex(q);
        let near = Infinity;
        for (const measure of far) {
          measure.LoadS2(point.wrapped);
          measure.Perform();
          near = Math.min(near, measure.Value());
        }
        if (near < 2.1 * t) {
          continue;
        }
        at.push(q);
        past.push(add(p, scale(n, t / 50)));
      }
    } finally {
      for (const measure of far) {
        measure.delete();
      }
    }
    if (!at.length) {
      return true;
    }
    const inBody = insideAlong(body, at, past, true);
    const keep = at.map((_, index) => index).filter(index => inBody[index]);

    return !insideAlong(shell, keep.map(index => at[index]), keep.map(index => past[index])).some(Boolean);
  } catch {
    // Can't tell: the usual checks speak for it.
    return true;
  }
}

/**
 * A shape offset by `by` (outward, or inward when negative) as a solid: with
 * sharp corners where its offset faces meet, else round ones. Null: no go.
 */
export function offsetSolid(off: any, shape: Shape3D, by: number): Shape3D | null {
  const oc = getOC();
  for (const join of [oc.GeomAbs_JoinType.GeomAbs_Intersection, oc.GeomAbs_JoinType.GeomAbs_Arc]) {
    const progress = new oc.Message_ProgressRange();
    try {
      off.PerformByJoin(shape.wrapped, by, 1e-6, oc.BRepOffset_Mode.BRepOffset_Skin, true, false, join, false, progress);
      if (!off.IsDone()) {
        continue;
      }
      let got = cast(off.Shape());
      // It can come back as a closed shell: make that a solid. (Asked of the
      // shape itself - class names are renamed in the app's build, so a
      // constructor.name test never matched there and the cut came out null.)
      if (got.wrapped.ShapeType() === oc.TopAbs_ShapeEnum.TopAbs_SHELL) {
        got = makeSolid([got as never]);
      }
      if (Math.abs(quickVolume(got as Shape3D)) > 0) {
        return tightenEdges(got as Shape3D);
      }
    } catch (err) {
      if (isFault(err)) {
        throw err;
      }
    } finally {
      progress.delete();
    }
  }

  return null;
}

/**
 * An offset solid with its loose edges made again. Where two offset faces
 * meet smoothly (a shelled mouse's top and the round along its rim), the
 * kernel's edge between them strays (0.2 mm off, 0.14 mm allowed) while its
 * curves on the two faces are exact: any cut across that edge left the faces
 * "not meeting up", at every tolerance. Each such edge is made again from its
 * curve on each face (one edge per face), the faces with them, all sewn back
 * together. Kept only if that comes out one sound solid of the same volume;
 * else the solid as it was.
 */
function tightenEdges(shape: Shape3D): Shape3D {
  const oc = getOC();
  const size = sizeOf(shape);
  const loose = size * 1e-5;
  if (!shape.edges.some(e => oc.BRep_Tool.Tolerance(e.wrapped) > loose)) {
    return shape;
  }
  const gc: { delete(): void }[] = [];
  const keep = <T extends { delete(): void }>(x: T): T => (gc.push(x), x);
  try {
    const copy = deepCopy(shape);
    const faces = copy.faces;
    // Per face: its loose edges and what takes their place there.
    const swaps = new Map<number, [any, any][]>();
    for (const e of copy.edges) {
      if (oc.BRep_Tool.Tolerance(e.wrapped) <= loose) {
        continue;
      }
      const owners = faces.map((face, i) => [face, i] as const).filter(([face]) => face.edges.some(edge => edge.wrapped.IsSame(e.wrapped)));
      // (A seam - one face on both sides - or an edge of three faces: left as it is.)
      if (owners.length !== 2) {
        continue;
      }
      const made = owners.map(([face]) => {
        const c2 = keep(new oc.BRepAdaptor_Curve2d(e.wrapped, face.wrapped));
        const mk = keep(new oc.BRepBuilderAPI_MakeEdge(c2.Curve(), oc.BRep_Tool.Surface(face.wrapped), c2.FirstParameter(), c2.LastParameter()));
        const edge = mk.Edge();
        oc.BRepLib.BuildCurve3d(edge, 1e-7, oc.GeomAbs_Shape.GeomAbs_C1, 14, 200);

        return edge;
      });
      // The two must be the same curve (exact curves on both faces), within what an edge may be off.
      const [a, b] = made.map(edge => keep(new oc.BRepAdaptor_Curve(edge)));
      let apart = 0;
      for (let step = 0; step <= 32; step++) {
        const curvePoint = a.Value(a.FirstParameter() + ((a.LastParameter() - a.FirstParameter()) * step) / 32);
        const q = b.Value(b.FirstParameter() + ((b.LastParameter() - b.FirstParameter()) * step) / 32);
        apart = Math.max(apart, curvePoint.Distance(q));
        curvePoint.delete();
        q.delete();
      }
      if (apart > loose) {
        continue;
      }
      owners.forEach(([, i], ownerIndex) => swaps.set(i, [...(swaps.get(i) ?? []), [e.wrapped, made[ownerIndex]]]));
    }
    if (!swaps.size) {
      return shape;
    }
    // A face's wire with its loose edges swapped, in its own order and directions (a seam twice).
    const rewire = (wire: any, swap: [any, any][]) => {
      const tb = keep(new oc.TopoDS_Builder());
      const nw = new oc.TopoDS_Wire();
      tb.MakeWire(nw);
      const ex = keep(new oc.TopExp_Explorer(wire, oc.TopAbs_ShapeEnum.TopAbs_EDGE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE));
      for (; ex.More(); ex.Next()) {
        const ed = ex.Current();
        const to = swap.find(([original]) => ed.IsSame(original));
        tb.Add(nw, to ? to[1].Oriented(ed.Orientation()) : ed);
      }

      return nw;
    };
    const sew = keep(new oc.BRepBuilderAPI_Sewing(size * 1e-6, true, true, true, false));
    faces.forEach((face, i) => {
      const swap = swaps.get(i);
      if (!swap) {
        return void sew.Add(face.wrapped);
      }
      const fwd = oc.TopoDS.Face(face.wrapped.Oriented(oc.TopAbs_Orientation.TopAbs_FORWARD));
      const outer = oc.BRepTools.OuterWire(fwd);
      const mk = keep(new oc.BRepBuilderAPI_MakeFace(oc.BRep_Tool.Surface(fwd), rewire(outer, swap), true));
      const ex = keep(new oc.TopExp_Explorer(fwd, oc.TopAbs_ShapeEnum.TopAbs_WIRE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE));
      for (; ex.More(); ex.Next()) {
        if (!ex.Current().IsSame(outer)) {
          mk.Add(rewire(oc.TopoDS.Wire(ex.Current()), swap));
        }
      }
      if (!mk.IsDone()) {
        throw new Error('face');
      }
      const nf = mk.Face();
      sew.Add(face.wrapped.Orientation() === oc.TopAbs_Orientation.TopAbs_REVERSED ? nf.Reversed() : nf);
    });
    sew.Perform(keep(new oc.Message_ProgressRange()));
    const shells = subShapes(cast(sew.SewedShape()) as Shape3D, 'SHELL');
    if (shells.length !== 1) {
      return shape;
    }
    const ms = keep(new oc.BRepBuilderAPI_MakeSolid());
    ms.Add(oc.TopoDS.Shell(shells[0]));
    const solid = ms.Solid();
    oc.BRepLib.OrientClosedSolid(solid);
    const fix = keep(new oc.ShapeFix_Solid());
    fix.Init(solid);
    fix.Perform(keep(new oc.Message_ProgressRange()));
    const out = cast(fix.Solid()) as Shape3D;
    const v0 = Math.abs(measureVolume(shape));
    const ok = shapeValid(out) && subShapes(out, 'SOLID').length === 1 && openEdges(out).length === 0 && Math.abs(Math.abs(measureVolume(out)) - v0) <= v0 * 1e-4;

    return ok ? out : shape;
  } catch (err) {
    if (isFault(err)) {
      throw err;
    }

    return shape;
  } finally {
    for (const x of gc.reverse()) {
      x.delete();
    }
  }
}

/**
 * A body brought in by t all round, worked out from what is cut out of it:
 * the box round the body brought in by t, less every lump of what the box
 * holds besides the body (a pocket's room, a hole's) grown by t. The same
 * shape as the body offset inward - which OpenCascade gives up on when the
 * offsets of two cut-outs run into each other (a pocket and a hole less than
 * two walls apart). Grown one by one and joined, they just overlap.
 */
function innerByCutouts(off: any, body: Shape3D, t: number): Shape3D | null {
  const [lo, hi] = body.boundingBox.bounds as [Vec3, Vec3];
  if ([0, 1, 2].some(axis => hi[axis] - lo[axis] <= 2 * t)) {
    return null;
  }
  const room = makeBox([lo[0] + t, lo[1] + t, lo[2] + t], [hi[0] - t, hi[1] - t, hi[2] - t]) as Shape3D;
  const beside = fuzzyBoolean('cut', makeBox(lo, hi) as Shape3D, body);
  if (isEmpty(beside)) {
    return room;
  }
  const lumps = subShapes(beside, 'SOLID').map(solid => cast(solid) as Shape3D);
  if (!lumps.length || lumps.length > 60) {
    return null;
  }
  const grown: Shape3D[] = [];
  for (const lump of lumps) {
    const offsetLump = offsetSolid(off, lump, t);
    if (!offsetLump) {
      return null;
    }
    grown.push(offsetLump);
  }
  const inner = fuzzyBoolean('cut', room, fuseAll(grown));
  if (isEmpty(inner) || !(Math.abs(quickVolume(inner)) > 0)) {
    return null;
  }
  // Held to what it is for: nowhere nearer the body's skin than t (a lump that
  // didn't grow all the way round - one ending in a knife edge - would leave the wall thin there).
  const clear = Math.min(...subShapes(body, 'SHELL').map(skin => measureDistanceBetween(inner, cast(skin) as AnyShape)));

  return clear >= t * (1 - 1e-3) ? inner : null;
}

/**
 * Shell without BRepOffsetAPI_MakeThickSolid: body − (body offset inward by t)
 * leaves a closed skin; each removed flat face then gets a hole cut through
 * it (its outline shrunk by t, pushed through the skin). `cutouts`: the body
 * offset inward is put together from what is cut out of it (innerByCutouts).
 */
function shellByOffset(body: Shape3D, faces: Face[], t: number, cutouts = false): Shape3D | null {
  const oc = getOC();
  const off = new oc.BRepOffsetAPI_MakeOffsetShape();
  try {
    const src = unify(body);
    const inner = cutouts ? innerByCutouts(off, src, t) : offsetSolid(off, src, -t);
    if (!inner) {
      return null;
    }
    const tol = sizeOf(body) * 1e-6;
    // The openings: the hollow's own floor behind each opened face, carried on
    // out through the wall (the hollow and its way out, cut away as one). So
    // what stands in the hollow there keeps its walls right down to the
    // opening - a bore through the floor, its tube: cut by the face's outline
    // brought in, as it was, the tube ended a wall and a half short of it.
    let hollow: Shape3D = inner;
    const byOutline: { face: Face; n: Vec3 }[] = [];
    for (const face of faces) {
      if (face.geomType !== 'PLANE') {
        return null;
      }
      const normal = norm(face.normalAt().toTuple() as Vec3);
      const at = face.pointOnSurface(0.5, 0.5).toTuple() as Vec3;
      const floors = inner.faces.filter((otherFace) => {
        if (otherFace.geomType !== 'PLANE' || dot(norm(otherFace.normalAt().toTuple() as Vec3), normal) < 1 - 1e-6) {
          return false;
        }
        const { p } = pointOnFace(inner!, otherFace);
        if (Math.abs(dot(sub(p, at), normal) + t) > tol * 10) {
          return false;
        }

        // (Another face of the body on the same plane, not opened: its floor stays.)
        return measureDistanceBetween(makeVertex(add(p, scale(normal, t))), face) < tol * 10;
      });
      if (!floors.length) {
        byOutline.push({ face, n: normal });
      }
      for (const floor of floors) {
        hollow = hollow.fuse(basicFaceExtrusion(floor.clone(), new Vector(scale(normal, t * 1.5))) as Shape3D);
      }
    }
    let skin = body.cut(hollow);
    for (const { face, n } of byOutline) {
      // (No such floor found: the face's outline brought in by the wall thickness, pushed through.)
      const wire = face.clone().outerWire().offset2D(-t, 'intersection');
      const start = new Vector(scale(n, t * 0.5));
      const hole = basicFaceExtrusion(makeFace(wire).translate(start), new Vector(scale(n, -t * 2)));
      skin = skin.cut(hole);
    }

    return skin;
  } catch {
    return null;
  } finally {
    off.delete();
  }
}
