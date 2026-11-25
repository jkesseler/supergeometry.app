import { Vector, basicFaceExtrusion, cast, getOC, makePolygon, makeVertex, measureDistanceBetween } from 'replicad';
import { add, cross, dist, scale } from '../geom';
import { meshVolume, pinchedEdges, shapeValid, subShapes } from './health';
import { DAMAGED_TEXT } from './damaged';
import { editNotes, looseBox, sizeOf, unify } from './faceEdit';
import { isEmpty, need } from './bodies';
import { measureVolume, quickVolume } from './ocFree';
import { withoutInternals } from './safeBooleans';
import { isFault } from './faults';
import type { Shape3D } from 'replicad';
import type { PlaneDef, Vec3 } from '../doc/types';
import type { Ctx } from './types';

/**
 * Which of the points are inside the solid (or any of its solids). (The
 * kernel's distance measure says when a point is inside a solid; its classifier
 * isn't in this build.)
 */
export function insideOf(shape: Shape3D, at: Vec3[]): boolean[] {
  const oc = getOC();
  const out = at.map(() => false);
  const solids = subShapes(shape, 'SOLID');
  for (const solid of solids) {
    const measure = new oc.BRepExtrema_DistShapeShape();
    try {
      measure.LoadS1(solid);
      at.forEach((q, index) => {
        if (out[index]) {
          return;
        }
        const point = makeVertex(q);
        measure.LoadS2(point.wrapped);
        measure.Perform();
        if (measure.IsDone() && measure.InnerSolution()) {
          out[index] = true;
        }
      });
    } finally {
      measure.delete();
    }
  }

  return out;
}

/** A join that only touches along an edge. */
const PINCHED = 'This only touches the body along an edge, so the two hang together by nothing - let them overlap a little (start it inside the body).';

/** A cut that took nothing away: said (a pocket drawn on the wrong side did nothing, without a word). */
const MISSED_CUT = "This cut doesn't reach the body, so nothing was cut - check which way it goes (Flip), or make it longer.";

/** Put a new solid into the model: new body, or join/cut a target. */
export function combine(id: string, mode: string, target: string | undefined, solid: Shape3D, negative: boolean, ctx: Ctx): void {
  // (A mode that isn't one - a damaged file: the body was left as it was, and nothing said so.)
  if (typeof mode === 'string' && !['auto', 'new', 'join', 'cut', 'intersect'].includes(mode)) {
    throw new Error(DAMAGED_TEXT);
  }
  const resolvedMode = mode === 'auto' ? (target ? (negative ? 'cut' : 'join') : 'new') : mode;
  // Add or Cut picked, with no body named (drawn on the floor, not on a face):
  // it acts on what it runs into - Add on the body it touches, Cut on every
  // body it overlaps. (It used to make a separate body: a nave "added" to its
  // tower stood beside it as Body 2.)
  if (!target && resolvedMode === 'cut') {
    const hits = overlapping(solid, ctx);
    if (!hits.length) {
      editNotes.push(MISSED_CUT);
    }
    for (const hit of hits) {
      const t = ctx.bodies.get(hit)!;
      const out = checkedBoolean('cut', t, solid);
      if (isEmpty(out)) {
        ctx.bodies.delete(hit);
      } else {
        ctx.bodies.set(hit, out);
      }
      ctx.freeforms.delete(hit);
    }

    return;
  }
  // Intersect: only what's in both stays - of the body named, or (none named) of every body it overlaps.
  if (resolvedMode === 'intersect') {
    const hits = target ? [target] : overlapping(solid, ctx);
    if (!hits.length) {
      throw new Error("It overlaps no body - Intersect keeps only what's in both");
    }
    for (const hit of hits) {
      const out = fuzzyBoolean('common', need(ctx.bodies, hit), solid);
      if (isEmpty(out)) {
        ctx.bodies.delete(hit);
      } else {
        ctx.bodies.set(hit, out);
      }
      ctx.freeforms.delete(hit);
    }

    return;
  }
  if (!target && resolvedMode === 'join') {
    target = touching(solid, ctx)[0];
  }
  if (resolvedMode === 'new' || !target) {
    ctx.bodies.set(id, solid);

    return;
  }
  const t = need(ctx.bodies, target);
  const result = resolvedMode === 'join' ? checkedBoolean('fuse', t, solid) : resolvedMode === 'cut' ? checkedBoolean('cut', t, solid) : t;
  // Joined, but only touching along an edge (a back stood on the base's
  // edge): one body by name, two pieces held by nothing. Said, not refused.
  if (resolvedMode === 'join' && pinchedEdges(result) > pinchedEdges(t) + pinchedEdges(solid)) {
    editNotes.push(PINCHED);
  }
  // (Measured to a thousandth first: further apart than that, something was cut - and the exact measure isn't asked for.)
  if (resolvedMode === 'cut' && !isEmpty(result) && Math.abs(quickVolume(result) - quickVolume(t)) <= Math.abs(quickVolume(t)) * 0.01 && Math.abs(volumeOf(result) - volumeOf(t)) <= Math.abs(volumeOf(t)) * 1e-9) {
    editNotes.push(MISSED_CUT);
  }
  if (isEmpty(result)) {
    ctx.bodies.delete(target);
  } else {
    ctx.bodies.set(target, result);
  }
}

/**
 * A join or a cut held to a volume it can have. OpenCascade can get a boolean
 * wrong without saying so (a thread only just overlapping the core it's
 * joined to): its volume then can't be right - the plain way is tried, and
 * if that's wrong too, said. (Every cut and join of a new solid goes through
 * here: one aimed at a body, and one that takes whatever it runs into.)
 */
export function checkedBoolean(op: 'fuse' | 'cut', t: Shape3D, solid: Shape3D): Shape3D {
  const result = fuzzyBoolean(op, t, solid);
  if (booleanVolumeOk(op, t, solid, result)) {
    return result;
  }
  const plain = op === 'fuse' ? t.fuse(solid) : t.cut(solid);
  if (!booleanVolumeOk(op, t, solid, plain)) {
    throw new Error(op === 'fuse' ? "Joining these didn't work out - the shapes only just overlap here: let them overlap more" : "This cut didn't work out - the shapes only just overlap here: let them overlap more, or less");
  }

  return plain;
}

/**
 * A shape's (signed) volume, worked out once per shape: a cut asks for its
 * body's, its tool's and its result's in several checks, and again for the
 * same body on every move of a drag - slow on a freeform's curved faces.
 * (A shape turned right way out in place is measured again, not looked up.)
 */
export const volumes = new WeakMap<Shape3D, number>();
export function volumeOf(shape: Shape3D): number {
  let volume = volumes.get(shape);
  if (volume === undefined) {
    volume = measureVolume(shape);
    volumes.set(shape, volume);
  }

  return volume;
}

/**
 * Can this be the volume of a ∪ b (or a − b)? A union is at least the bigger
 * of the two and at most both together; a cut is at most a and at least a − b.
 */
export function booleanVolumeOk(op: 'fuse' | 'cut', a: Shape3D, b: Shape3D, shape: Shape3D): boolean {
  try {
    // Measured to a thousandth first: clear of the limits by more than that can be out, it fits - and the measure
    // to a millionth (seconds, on curved bodies) is not asked for.
    {
      const near = (candidate: Shape3D) => volumes.get(candidate) ?? quickVolume(candidate);
      const [qa, qb, q] = [Math.abs(near(a)), Math.abs(near(b)), isEmpty(shape) ? 0 : near(shape)];
      const tol = Math.min(qa, qb) * 0.6 - (qa + qb + Math.abs(q)) * 0.005;
      if (tol > 0 && Number.isFinite(q) && q >= -tol && (op === 'fuse' ? q >= Math.max(qa, qb) - tol && q <= qa + qb + tol : q <= qa + tol && q >= qa - qb - tol)) {
        return true;
      }
    }
    const va = Math.abs(volumeOf(a));
    const vb = Math.abs(volumeOf(b));
    const volume = isEmpty(shape) ? 0 : volumeOf(shape);
    // A big many-faced body measures a little differently once a join splits
    // its faces (a jet engine's casing: 2 to 75 mm³ in 1.9 litres) - more than
    // the name raised on its pylon (158 mm³) could stand under a closer check.
    // A boolean gone wrong is off by about the smaller shape, or more.
    const fits = (va: number, vb: number, combined: number) => {
      const tol = (va + vb) * 1e-5 + Math.min(va, vb) * 0.6 + 1e-9;
      if (!Number.isFinite(combined) || combined < -tol) {
        return false;
      }

      return op === 'fuse' ? combined >= Math.max(va, vb) - tol && combined <= va + vb + tol : combined <= va + tol && combined >= va - vb - tol;
    };
    if (fits(va, vb, volume)) {
      return true;
    }
    // The measured volume can be off by far more than a small tool on some
    // curved faces (a shelled loft: 455 mm³ either way on a drill's housing),
    // and differently once a cut splits a face near them - two terminal slots
    // (120 mm³) "took" 920. Counted from meshes, it's the true change - asked
    // only of a sound cut (a thread's failed joins, meshed, took 10 s each).
    if (op !== 'cut' || isEmpty(shape) || !shapeValid(shape)) {
      return false;
    }
    const size = Math.max(sizeOf(a), sizeOf(b));

    return fits(Math.abs(meshVolume(a, size)), Math.abs(meshVolume(b, size)), meshVolume(shape, size));
  } catch {
    return true; // can't tell: leave it to the usual checks
  }
}

/**
 * A boolean that treats surfaces within a small tolerance as the same (OCCT's
 * fuzzy option): geometry built from a body's own edges lines up with it.
 */
export function fuzzyBoolean(op: 'cut' | 'fuse' | 'common', a: Shape3D, b: Shape3D): Shape3D {
  const oc = getOC();
  const tol = Math.max(1e-7, sizeOf(a) * 1e-6);
  const algo = op === 'cut' ? new oc.BRepAlgoAPI_Cut() : op === 'fuse' ? new oc.BRepAlgoAPI_Fuse() : new oc.BRepAlgoAPI_Common();
  const args = new oc.NCollection_List_TopoDS_Shape();
  const tools = new oc.NCollection_List_TopoDS_Shape();
  const progress = new oc.Message_ProgressRange();
  try {
    args.Append(a.wrapped);
    tools.Append(b.wrapped);
    algo.SetArguments(args);
    algo.SetTools(tools);
    algo.SetFuzzyValue(tol);
    // (Never adjusting a or b: they're earlier steps' results.)
    algo.SetNonDestructive(true);
    algo.Build(progress);
    if (!algo.IsDone()) {
      throw new Error('boolean failed');
    }
    // (The kernel's handle to what it made is given back once the body has its own: release.ts.)
    const made = algo.Shape();
    let out: Shape3D;
    try {
      out = cast(withoutInternals(made)) as Shape3D;
    } finally {
      made.delete();
    }

    // Fuse and cut keep their faces tidy like the usual booleans do.
    return op === 'common' ? out : (unify(out, Math.max(sizeOf(a), sizeOf(b))) as Shape3D);
  } catch (err) {
    // (The engine itself breaking down is not a boolean to try another way.)
    if (isFault(err)) {
      throw err;
    }
    try {
      return op === 'cut' ? a.cut(b) : op === 'fuse' ? a.fuse(b) : a.intersect(b);
    } catch {
      // Neither way gave a shape (OpenCascade's "shape is null"): say so plainly.
      throw new Error("The geometry engine couldn't work this out where these meet - try moving one a little");
    }
  } finally {
    algo.delete();
    args.delete();
    tools.delete();
    progress.delete();
  }
}

/** Bodies (other than `skip`) that `solid` really overlaps (not just touches). */
export function overlapping(solid: Shape3D, ctx: Ctx, skip?: string): string[] {
  // (Quick boxes, never smaller than the bodies: two that are apart can't overlap. And volumes to a thousandth:
  // is what they share more than a millionth of the smaller? Exact, both took seconds on curved bodies.)
  const sb = looseBox(solid);
  const about = (shape: Shape3D) => volumes.get(shape) ?? quickVolume(shape);
  const vs = Math.abs(about(solid));
  const out: string[] = [];
  for (const [id, body] of ctx.bodies) {
    if (id === skip) {
      continue;
    }
    const bb = looseBox(body);
    const apart = [0, 1, 2].some(axis => bb[1][axis] < sb[0][axis] || bb[0][axis] > sb[1][axis]);
    if (apart) {
      continue;
    }
    try {
      // Tolerant: a wall drawn from the body's own edge (projected, offset…) sits a hair
      // off the body's surface, and an exact boolean then finds no overlap at all.
      const common = fuzzyBoolean('common', body, solid);
      if (!isEmpty(common) && Math.abs(quickVolume(common)) > Math.max(1e-9, Math.min(vs, Math.abs(about(body))) * 1e-6)) {
        out.push(id);
      }
    } catch {
      // can't tell: leave it alone
    }
  }

  return out;
}

/** Bodies the solid overlaps or touches, the most overlapped first. */
function touching(solid: Shape3D, ctx: Ctx): string[] {
  const over = overlapping(solid, ctx);
  const sb = looseBox(solid);
  const size = Math.max(1e-9, ...[0, 1, 2].map(axis => sb[1][axis] - sb[0][axis]));
  const tol = size * 1e-6 + 1e-7;
  const near: string[] = [];
  for (const [id, body] of ctx.bodies) {
    if (over.includes(id)) {
      continue;
    }
    const bb = looseBox(body);
    const apart = [0, 1, 2].some(axis => bb[1][axis] < sb[0][axis] - tol || bb[0][axis] > sb[1][axis] + tol);
    if (apart) {
      continue;
    }
    try {
      if (measureDistanceBetween(body, solid) <= tol) {
        near.push(id);
      }
    } catch {
      // can't tell: not counted
    }
  }

  return [...over, ...near];
}

export function fuseAll(parts: Shape3D[]): Shape3D {
  if (!parts.length) {
    throw new Error('Nothing to build');
  }
  // In pairs, then pairs of those…: each fuse joins two pieces of about the
  // same size. One by one onto a growing result, the scale of a ruler (170
  // ticks and digits) took over a minute; this way a few seconds.
  let level = parts;
  while (level.length > 1) {
    const next: Shape3D[] = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(i + 1 < level.length ? level[i].fuse(level[i + 1]) : level[i]);
    }
    level = next;
  }

  return level[0];
}

/** Solid filling the positive side of a plane, big enough to contain `body`. */
export function halfSpace(plane: PlaneDef, body: Shape3D): Shape3D {
  const bb = body.boundingBox;
  const length = (Math.hypot(bb.width, bb.height, bb.depth) + dist(bb.center as Vec3, plane.origin)) * 2 + 10;
  const x = plane.xDir;
  const y = cross(plane.normal, x);
  const origin = plane.origin;
  const corner = (along: number, across: number): Vec3 => add(origin, add(scale(x, along * length), scale(y, across * length)));
  const face = makePolygon([corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)]);

  return basicFaceExtrusion(face, new Vector(plane.normal).multiply(length));
}
