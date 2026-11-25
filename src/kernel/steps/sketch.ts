import { outlineOffsetCurves, projectPolyline } from '../../sketch/edit';
import { resolveEdge, resolveFace } from '../references';
import { need } from '../bodies';
import { isFault } from '../faults';
import { editNotes } from '../faceEdit';
import { solveFine } from '../../sketch/constraints';
import { carried } from '../../sketch/follow';
import { add, dot, norm, scale, sub, xDirFor } from '../../geom';
import type { Face } from 'replicad';
import type { FaceRef, PlaneDef, SketchEntity, SketchFeature, Vec3 } from '../../doc/types';
import type { Bodies, Ctx, SketchState } from '../types';

export function applySketch(feature: SketchFeature, ctx: Ctx) {
  const { bodies } = ctx;
  const plane = feature.attachedTo ? followFace(feature, bodies) : feature.onPlane ? followPlane(feature, ctx) : feature.plane;
  // On a face, the face outline takes part in regions: a line across the face splits it.
  const outline = feature.attachedTo ? faceBoundary(feature.attachedTo, plane, bodies) : [];
  // Offsets of the outline, made from it as it is now (they follow the face).
  const boundary = [...outline, ...outlineOffsetCurves(outline, feature.outlineOffsets)];
  // Curves that follow a body's edge go where it is now, the rest by its dimensions to them.
  const entities = feature.links?.length ? followEdges(feature, plane, bodies) : feature.entities;
  const state: SketchState = { ...feature, entities, plane, boundary };
  // The same sketch as last time, to the last digit (the page took the
  // curves the engine moved as the sketch's own): it is that one, and
  // the steps made from it have nothing new to read.
  const text = JSON.stringify(state);
  const was = sketchWas.get(feature.id);
  if (was?.text === text) {
    ctx.sketches.set(feature.id, was.state);
  } else {
    sketchWas.set(feature.id, { text, state });
    ctx.sketches.set(feature.id, state);
  }
}

/** Each sketch as it was last made (see the sketch step). */
export const sketchWas = new Map<string, { text: string; state: SketchState }>();

/** The same thing, every number within `tol` of the other's. */
function sameNumbers(a: unknown, b: unknown, tol: number): boolean {
  if (typeof a === 'number' && typeof b === 'number') {
    return Math.abs(a - b) <= tol;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => sameNumbers(item, b[i], tol));
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a as object);

    return ka.length === Object.keys(b as object).length && ka.every(key => sameNumbers((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key], tol));
  }

  return a === b;
}

/**
 * A sketch's curves with those that follow a body's edge put where the edge
 * is now (seen straight onto the sketch's plane), and the rest moved by the
 * sketch's dimensions and constraints to them.
 */
function followEdges(sketch: SketchFeature, plane: PlaneDef, bodies: Bodies): SketchEntity[] {
  const links = new Map(sketch.links!.map(link => [link.id, link]));
  let lost = 0;
  let moved = false;
  const entities = sketch.entities.map((e) => {
    const link = links.get(e.id);
    if (!link) {
      return e;
    }
    let made: SketchEntity | null = null;
    try {
      const edge = resolveEdge(need(bodies, link.edge.body), link.edge);
      // (A curve made as a spline - an older project's - stays one: sizes may be tied to its points.)
      made = projectPolyline(Array.from({ length: 25 }, (_, index) => edge.pointAt(index / 24).toTuple() as Vec3), plane, edge.geomType, false, e.kind !== 'spline');
    } catch (err) {
      if (isFault(err)) {
        throw err;
      }
    }
    // Gone, or seen end-on from here (a point): the curve stays where it was.
    if (!made) {
      lost++;

      return e;
    }
    // Its ends the way round they were (what is tied to one end stays on that end).
    if ((made.kind === 'line' || made.kind === 'arc') && e.kind === made.kind) {
      const far = (point: number[], q: number[]) => Math.hypot(point[0] - q[0], point[1] - q[1]);
      if (far(made.a, e.b) + far(made.b, e.a) < far(made.a, e.a) + far(made.b, e.b)) {
        made = { ...made, a: made.b, b: made.a };
      }
    }
    // (Part of an ellipse the same: run from the end it ran from before.)
    if (made.kind === 'ellipse' && made.sweep !== undefined && e.kind === 'ellipse' && e.sweep !== undefined) {
      const end = (x: Extract<SketchEntity, { kind: 'ellipse' }>, t: number): [number, number] => {
        const px = x.rx * Math.cos(t);
        const py = x.ry * Math.sin(t);

        return [x.center[0] + px * Math.cos(x.rotation) - py * Math.sin(x.rotation), x.center[1] + px * Math.sin(x.rotation) + py * Math.cos(x.rotation)];
      };
      const far = (point: number[], q: number[]) => Math.hypot(point[0] - q[0], point[1] - q[1]);
      const [ma, mb] = [end(made, made.a0 ?? 0), end(made, (made.a0 ?? 0) + made.sweep)];
      const [ea, eb] = [end(e, e.a0 ?? 0), end(e, (e.a0 ?? 0) + e.sweep)];
      if (far(ma, eb) + far(mb, ea) < far(ma, ea) + far(mb, eb)) {
        made = { ...made, a0: (made.a0 ?? 0) + made.sweep, sweep: -made.sweep };
      }
    }
    const now = { ...made, id: e.id, ...(e.construction ? { construction: true } : {}) } as SketchEntity;
    if (sameNumbers(e, now, 1e-9)) {
      return e;
    }
    moved = true;

    return now;
  });
  if (lost) {
    editNotes.push(lost === 1 ? 'An edge this sketch follows is gone: that curve stays where it was.' : `${lost} edges this sketch follows are gone: those curves stay where they were.`);
  }
  if (!moved) {
    return sketch.entities;
  }
  if (!sketch.constraints?.length) {
    return entities;
  }
  // What is dimensioned to them goes with them first (a distance doesn't say which side).
  const solution = solveFine(carried(sketch.entities, entities, sketch.constraints, new Set(links.keys())), sketch.constraints);
  if (solution.ok) {
    return solution.entities;
  }
  editNotes.push("The edge this sketch follows moved to where the sketch's dimensions can't all be kept: its other curves stay where they were.");

  return entities;
}

/** The outline of the face a sketch sits on, as sketch curves (ids "bnd-…"). */
function faceBoundary(ref: FaceRef, plane: PlaneDef, bodies: Bodies): SketchEntity[] {
  const body = bodies.get(ref.body);
  if (!body) {
    return [];
  }
  let face: Face;
  try {
    face = resolveFace(body, ref);
  } catch {
    return [];
  }
  if (face.geomType !== 'PLANE') {
    return [];
  }

  return face.edges.flatMap((e, i) => {
    const pts = Array.from({ length: 25 }, (_, index) => e.pointAt(index / 24).toTuple() as Vec3);
    // (A face's own outline: as it always was - shapes are made of it.)
    const ent = projectPolyline(pts, plane, e.geomType, false, false);

    return ent ? [{ ...ent, id: `bnd-${i}` }] : [];
  });
}

/** A sketch drawn on a construction plane: where that plane is now (moved along it, or turned with it). */
function followPlane(sketch: SketchFeature, ctx: Ctx): PlaneDef {
  const plane = ctx.planes.get(sketch.onPlane!)?.plane;
  if (!plane) {
    return sketch.plane;
  }
  const normal = norm(plane.normal);
  if (Math.abs(dot(normal, norm(sketch.plane.normal))) < 0.9999) {
    return { origin: plane.origin, normal: plane.normal, xDir: plane.xDir };
  }

  // The same way round: the sketch's own origin and X kept, moved onto the plane.
  return { ...sketch.plane, origin: add(sketch.plane.origin, scale(normal, dot(normal, sub(plane.origin, sketch.plane.origin)))) };
}

/** A sketch drawn on a face moves with that face when earlier features change. */
function followFace(sketch: SketchFeature, bodies: Bodies): PlaneDef {
  const ref = sketch.attachedTo!;
  const body = bodies.get(ref.body);
  if (!body) {
    return sketch.plane;
  }
  let face: Face;
  try {
    face = resolveFace(body, ref);
  } catch {
    // Its face is gone (the step that made it switched off or changed): the
    // sketch stays where it was, and says so - rather than stopping every step after it.
    editNotes.push('The face this sketch was drawn on is gone: it stays where it was. Tap it and pick a face to move it onto one.');

    return sketch.plane;
  }

  const normal = norm(face.normalAt().toTuple() as Vec3);
  const center = face.center.toTuple() as Vec3;
  const offset = dot(normal, sub(center, sketch.plane.origin));
  const origin = add(sketch.plane.origin, scale(normal, offset));

  return dot(normal, sketch.plane.normal) > 0.999 ? { ...sketch.plane, origin } : { origin, normal: normal, xDir: xDirFor(normal) };
}
