import { assembleWire, cast, getOC, isShape3D, loft, makeBSplineApproximation } from 'replicad';
import { add, dot, len, norm, scale, sub } from '../../geom';
import { noSketch, pathWire, sourceWires } from '../sources';
import { railLoft } from '../loftRails';
import { loftInLine } from '../loftAlign';
import { shapeValid } from '../health';
import { quickVolume } from '../ocFree';
import { combine } from '../booleans';
import { resolveFace } from '../references';
import { need } from '../bodies';
import type { Shape3D, Wire } from 'replicad';
import type { ExtrudeSource, LoftFeature, Vec3 } from '../../doc/types';
import type { Ctx } from '../types';

export function applyLoft(feature: LoftFeature, ctx: Ctx) {
  if (feature.sections.length < 2) {
    throw new Error('Pick at least two profiles');
  }
  // Each section's own plane (a profile's sketch, or the face).
  const frames = feature.sections.map(section => sectionFrame(section, ctx));
  let order = feature.sections.map((_, i) => i);
  const n0 = frames[0].normal;
  // Parallel sections go in their order along the normal, whatever order they were picked in
  // (a loft that doubles back on itself isn't a solid).
  if (!feature.closed && !feature.guide && frames.every(fr => Math.abs(dot(fr.normal, n0)) > 0.999)) {
    const height = (i: number) => dot(sub(frames[i].origin, frames[0].origin), n0);
    order.sort((a, b) => height(a) - height(b));
    for (let index = 1; index < order.length; index++) {
      if (Math.abs(height(order[index]) - height(order[index - 1])) < 1e-6) {
        throw new Error('Two profiles lie on the same plane: loft needs them one above another');
      }
    }
  }
  // The same profile picked twice counts once.
  order = order.filter((i, index) => index === 0 || JSON.stringify(feature.sections[i]) !== JSON.stringify(feature.sections[order[index - 1]]));
  if (order.length < 2) {
    throw new Error('Pick at least two different profiles');
  }
  let wires = order.map(i => sourceWires(feature.sections[i], ctx)[0]);
  if ((feature.startContinuity || feature.endContinuity) && !feature.guide && !feature.closed) {
    if (feature.ruled) {
      throw new Error("Straight sides can't also leave a profile smoothly: switch off Straight sides");
    }
    const nrm = order.map(i => frames[i].normal);
    wires = withEndPulls(wires, nrm, feature.startContinuity, feature.startWeight ?? 1, feature.endContinuity, feature.endWeight ?? 1);
  }
  let shape: Shape3D;
  if (feature.rails?.length || feature.connections?.length) {
    if (feature.guide || feature.closed) {
      throw new Error("Guide curves and connections can't be used with a centre line or a closed loop");
    }
    const rails = (feature.rails ?? []).map(pathRef => pathWire(pathRef, ctx));
    const conns = (feature.connections ?? []).map(connection => order.map(i => connection[i]));
    shape = railLoft(wires, rails, conns);
  } else if (feature.guide || feature.closed) {
    if (feature.closed && wires.length < 3 && !feature.guide) {
      throw new Error('A closed loop needs at least three profiles');
    }
    shape = loftAlong(wires, feature.guide ? pathWire(feature.guide, ctx) : null, !!feature.closed);
  } else {
    try {
    // One smooth side where the sections' starts are in line already (see loftAlign.ts).
      const inLine = loftInLine(wires, feature.ruled);
      shape = inLine && shapeValid(inLine) && quickVolume(inLine) > 0 ? inLine : loft(wires, { ruled: feature.ruled });
    } catch {
      throw new Error("These profiles can't be lofted together");
    }
  }
  combine(feature.id, feature.mode, feature.target, shape, false, ctx);
}

/**
 * Loft end continuity: copies of the first (last) profile set a little way
 * along its normal, towards the next one, so the smooth loft leaves it
 * straight out (G1); a second copy further on holds the curve too (G2).
 */
function withEndPulls(wires: Wire[], normals: Vec3[], start: 'g1' | 'g2' | undefined, sw: number, end: 'g1' | 'g2' | undefined, ew: number): Wire[] {
  const centre = (wire: Wire) => wire.boundingBox.center as Vec3;
  const pulls = (wire: Wire, normal: Vec3, next: Wire, kind: 'g1' | 'g2', weight: number): Wire[] => {
    const toward = sub(centre(next), centre(wire));
    const gap = Math.abs(dot(toward, normal)) || len(toward);
    const dir = dot(toward, normal) < 0 ? scale(normal, -1) : normal;
    const distance = (gap * 0.25 * Math.max(weight, 0.05)) / (kind === 'g2' ? 2 : 1);

    return (kind === 'g2' ? [1, 2] : [1]).map(step => wire.clone().translate(scale(dir, distance * step)));
  };
  const last = wires.length - 1;
  const head = start ? pulls(wires[0], norm(normals[0]), wires[1], start, sw) : [];
  const tail = end ? pulls(wires[last], norm(normals[last]), wires[last - 1], end, ew).reverse() : [];

  return [wires[0], ...head, ...wires.slice(1, last), ...tail, wires[last]];
}

/** Plane of a loft section. */
function sectionFrame(src: ExtrudeSource, ctx: Ctx): { origin: Vec3; normal: Vec3 } {
  if (src.kind === 'profile') {
    const sketch = ctx.sketches.get(src.sketch);
    if (!sketch) {
      throw noSketch(src.sketch);
    }

    return { origin: sketch.plane.origin, normal: norm(sketch.plane.normal) };
  }
  const face = resolveFace(need(ctx.bodies, src.face.body), src.face);

  return { origin: face.center.toTuple() as Vec3, normal: norm(face.normalAt().toTuple() as Vec3) };
}

/**
 * A loft carried along a spine: the guide curve, or (a closed loop with no
 * guide) a smooth closed curve through the profiles' middles in the order
 * they were picked. Each profile sits where it is drawn; the body passes
 * through them in their order along the spine.
 */
function loftAlong(wires: Wire[], guide: Wire | null, closed: boolean): Shape3D {
  const oc = getOC();
  const mid = (wire: Wire): Vec3 => {
    const [lo, hi] = wire.boundingBox.bounds as [Vec3, Vec3];

    return scale(add(lo, hi), 0.5);
  };
  let spine = guide;
  let order = wires;
  if (!spine) {
    // A closed curve through the middles (Catmull-Rom: through each one, smooth all round).
    const centers = wires.map(mid);
    const count = centers.length;
    const pts: Vec3[] = [];
    const steps = 24;
    for (let i = 0; i < count; i++) {
      const [p0, p1, p2, p3] = [centers[(i - 1 + count) % count], centers[i], centers[(i + 1) % count], centers[(i + 2) % count]];
      for (let step = 0; step < steps; step++) {
        const t = step / steps;
        const t2 = t * t;
        const t3 = t2 * t;
        const weights = [-t3 + 2 * t2 - t, 3 * t3 - 5 * t2 + 2, -3 * t3 + 4 * t2 + t, t3 - t2].map(x => x / 2);
        pts.push(add(add(scale(p0, weights[0]), scale(p1, weights[1])), add(scale(p2, weights[2]), scale(p3, weights[3]))));
      }
    }
    pts.push(pts[0]);
    const size = Math.max(...centers.map(point => len(sub(point, centers[0]))), 1);
    spine = assembleWire([makeBSplineApproximation(pts, { tolerance: size * 1e-5, degMax: 5, degMin: 3 })]);
  } else {
    // Along a guide: in the order they lie along it.
    const ad = new oc.BRepAdaptor_CompCurve(spine.wrapped, true);
    const u0 = ad.FirstParameter();
    const u1 = ad.LastParameter();
    const samples: Vec3[] = [];
    for (let i = 0; i <= 200; i++) {
      const curvePoint = ad.Value(u0 + ((u1 - u0) * i) / 200);
      samples.push([curvePoint.X(), curvePoint.Y(), curvePoint.Z()]);
      curvePoint.delete();
    }
    ad.delete();
    const at = (wire: Wire) => {
      const middle = mid(wire);
      let best = 0;
      samples.forEach((sample, i) => len(sub(sample, middle)) < len(sub(samples[best], middle)) && (best = i));

      return best;
    };
    order = [...wires].sort((a, b) => at(a) - at(b));
  }
  const builder = new oc.BRepOffsetAPI_MakePipeShell(spine.wrapped);
  try {
    builder.SetMode(false);
    for (const wire of order) {
      builder.Add(wire.wrapped, false, false);
    }
    if (closed && guide) {
      builder.Add(order[0].wrapped, false, false);
    }
    builder.Build(new oc.Message_ProgressRange());
    if (!builder.IsDone()) {
      throw new Error('no shape');
    }
    builder.MakeSolid();
    const shape = cast(builder.Shape());
    if (!isShape3D(shape)) {
      throw new Error('no solid');
    }

    return shape;
  } catch {
    throw new Error(guide ? "The profiles can't be carried along that guide - each one needs to sit across it" : "These profiles can't be joined into a closed loop");
  } finally {
    builder.delete();
  }
}
