import { add, cross, dist, dot, norm, scale, sub } from '../geom';
import { closestOnEntity } from '../sketch/regions';
import { resolveAxis } from './references';
import type { Feature, Vec3 } from '../doc/types';
import type { Ctx } from './types';
import type { OriginOf } from './provenance';

/**
 * For a step made from a sketch (an extrusion, a revolve): which of its faces
 * a face is - the sketch curve its surface was drawn out of ("line3:0": the
 * curve's id and which piece of it), or an end ("cap:0" on the sketch's plane,
 * "cap:1" away from it, and the curve nearest its middle). Told from the face
 * as it is, so a face trimmed or cut by later steps still says the same.
 */
export function originsOf(feature: Feature, ctx: Ctx): OriginOf | undefined {
  if ((feature.type !== 'extrude' && feature.type !== 'revolve') || feature.source.kind !== 'profile') {
    return undefined;
  }
  if (feature.type === 'extrude' && feature.taper !== undefined && Math.abs(feature.taper - 1) > 1e-9) {
    return undefined;
  }
  const sketchState = ctx.sketches.get(feature.source.sketch);
  if (!sketchState) {
    return undefined;
  }
  // The curves round the shapes it was made from (all of the sketch's, when not known).
  const ids = new Set(feature.source.regions.flatMap(region => region.k ?? []));
  const known = feature.source.regions.every(region => region.k?.length);
  const curves = sketchState.entities.filter(e => !e.construction && (!known || ids.has(e.id)));
  if (!curves.length || curves.length > 400) {
    return undefined;
  }
  const { origin, normal } = sketchState.plane;
  const unitNormal = norm(normal);
  const uAxis = norm(sketchState.plane.xDir);
  const vAxis = norm(cross(unitNormal, uAxis));
  const flat = (point: Vec3): [number, number] => [dot(sub(point, origin), uAxis), dot(sub(point, origin), vAxis)];
  const nearest = (q: [number, number]) => {
    let best: { key: string; d: number } | null = null;
    for (const e of curves) {
      const closest = closestOnEntity(e, q);
      if (!best || closest.d < best.d) {
        best = { key: `${e.id}:${closest.prim}`, d: closest.d };
      }
    }

    return best!;
  };
  const axis = feature.type === 'revolve' ? resolveAxis(feature.axis, ctx) : null;

  return (face, back) => {
    const point = face.pointOnSurface(0.5, 0.5);
    let at = point.toTuple() as Vec3;
    point.delete();
    let fn = face.geomType === 'PLANE' ? norm(face.normalAt().toTuple() as Vec3) : null;
    // (A face of a body moved since: taken back to where this step made it.)
    if (back) {
      at = back(at);
      if (fn) {
        fn = norm(back(fn, true));
      }
    }
    if (axis) {
      // An end of a part turn: a flat face the axis lies in.
      if (fn && Math.abs(dot(fn, axis.dir)) < 1e-6 && Math.abs(dot(sub(at, axis.origin), fn)) < 1e-4) {
        return `cap:${Math.abs(dot(fn, unitNormal)) > 0.999 ? 0 : 1}`;
      }
      // Turned back into the sketch's plane (either side of the axis).
      const along = dot(sub(at, axis.origin), axis.dir);
      const foot = add(axis.origin, scale(axis.dir, along));
      const radius = dist(at, foot);
      const out = norm(cross(unitNormal, axis.dir));
      const a = nearest(flat(add(foot, scale(out, radius))));
      const b = nearest(flat(add(foot, scale(out, -radius))));
      const best = a.d <= b.d ? a : b;

      return best.d < 1e-3 + radius * 1e-6 ? best.key : null;
    }
    const q = flat(at);
    const hit = nearest(q);
    if (fn && Math.abs(dot(fn, unitNormal)) > 0.999) {
      const height = dot(sub(at, origin), unitNormal);

      return `cap:${Math.abs(height) < 1e-4 ? 0 : height > 0 ? 1 : 2}@${hit.key}`;
    }

    return hit.d < 1e-3 ? hit.key : null;
  };
}
