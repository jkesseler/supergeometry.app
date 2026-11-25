import { assembleWire, cast, getOC, isShape3D, makeBSplineApproximation, revolution } from 'replicad';
import { resolveAxis } from '../references';
import { sourceFaces, withHoles } from '../sources';
import { add, cross, dot, len, norm, scale, sub } from '../../geom';
import { combine, fuseAll } from '../booleans';
import { withFittedSplines } from '../sketchGeom';
import type { Face, Shape3D, Wire } from 'replicad';
import type { RevolveFeature, Vec3 } from '../../doc/types';
import type { Ctx } from '../types';

export function applyRevolve(feature: RevolveFeature, ctx: Ctx) {
  if (Math.abs(feature.angle) < 1e-6) {
    throw new Error('Angle is zero');
  }
  const axis = resolveAxis(feature.axis, ctx);
  if (feature.travel && Math.abs(feature.travel) > 1e-9) {
    // Moving along the axis while turning: a helical sweep (threads, springs).
    const parts = withHoles(feature.source, ctx, wire => helicalSweep(wire, axis.origin, norm(axis.dir), feature.angle, feature.travel!));
    combine(feature.id, feature.mode, feature.target, fuseAll(parts), false, ctx);

    return;
  }
  if (Math.abs(feature.angle) > 360 + 1e-6) {
    throw new Error('More than one turn needs a Travel along the axis (or it overlaps itself)');
  }
  const whole = Math.abs(Math.abs(feature.angle) - 360) < 1e-6;
  const turnFace = (face: Face): Shape3D => {
    // A whole ellipse turned all the way round is a ring with one face and
    // no edges: later unions break it (a combustor ring took one fuel
    // nozzle, then came out inside out). Two halves, joined, are sound.
    if (whole && face.edges.length === 1 && face.edges[0].geomType === 'ELLIPSE') {
      const half = revolution(face, axis.origin, axis.dir, 180) as Shape3D;

      return half.fuse(half.clone().rotate(180, axis.origin, axis.dir));
    }

    return revolution(face, axis.origin, axis.dir, feature.angle) as Shape3D;
  };
  // A shape across the axis turns into itself (the kernel only said it
  // "could not compute this").
  for (const { face } of sourceFaces(feature.source, ctx)) {
    if (crossesAxis(face, axis.origin, norm(axis.dir))) {
      throw new Error('The shape crosses the axis - it has to stay on one side of it (touching it is fine)');
    }
  }
  const turn = () => sourceFaces(feature.source, ctx).map(({ face }) => turnFace(face));
  let parts: Shape3D[];
  try {
    parts = turn();
  } catch {
    // A profile whose exact spline won't turn (it touches the axis awkwardly): a close fit does.
    parts = withFittedSplines(turn);
  }
  combine(feature.id, feature.mode, feature.target, fuseAll(parts), false, ctx);
}

/**
 * A profile turned `angle` degrees about an axis while moving `travel` along
 * it: swept along a helix through the profile's centre, keeping its
 * orientation to the axis (binormal mode), as threads are made.
 */
function helicalSweep(wire: Wire, origin: Vec3, dir: Vec3, angle: number, travel: number): Shape3D {
  const bb = wire.boundingBox;
  const center = bb.center as Vec3;
  // The helix runs through the profile's centre (or, on the axis, its far side).
  const radial = (point: Vec3) => {
    const offset = sub(point, origin);

    return sub(offset, scale(dir, dot(offset, dir)));
  };
  let start = center;
  if (len(radial(center)) < 1e-6 * (1 + bb.width + bb.height + bb.depth)) {
    const far = wire.edges.flatMap(e => [0, 0.5, 1].map(t => e.pointAt(t).toTuple() as Vec3)).sort((a, b) => len(radial(b)) - len(radial(a)))[0];
    start = far;
  }
  const turns = Math.abs(angle) / 360;
  const segments = Math.max(16, Math.ceil(turns * 48));
  const pts: Vec3[] = [];
  const rel = sub(start, origin);
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const th = (angle * Math.PI * t) / 180;
    // Rodrigues' rotation about the axis, plus the travel so far.
    const rotated = add(add(scale(rel, Math.cos(th)), scale(cross(dir, rel), Math.sin(th))), scale(dir, dot(dir, rel) * (1 - Math.cos(th))));
    pts.push(add(add(origin, rotated), scale(dir, travel * t)));
  }
  const spine = assembleWire([makeBSplineApproximation(pts, { tolerance: 1e-5 * (1 + len(rel)), degMax: 5, degMin: 3 })]);
  const oc = getOC();
  const builder = new oc.BRepOffsetAPI_MakePipeShell(spine.wrapped);
  const bi = new oc.gp_Dir(dir[0], dir[1], dir[2]);
  try {
    builder.SetMode(bi);
    builder.Add(wire.wrapped, false, false);
    builder.Build();
    if (!builder.IsDone()) {
      throw new Error("The profile can't be swept round this axis");
    }
    builder.MakeSolid();
    const shape = cast(builder.Shape());
    if (!isShape3D(shape)) {
      throw new Error("The profile can't be swept round this axis");
    }

    return shape;
  } finally {
    builder.delete();
    bi.delete();
  }
}

/** Does a flat shape in a plane through the axis reach both sides of it? */
function crossesAxis(face: Face, origin: Vec3, dir: Vec3): boolean {
  const normal = norm(face.normalAt().toTuple() as Vec3);
  if (Math.abs(dot(normal, dir)) > 1e-6) {
    return false;
  } // tilted to the axis: not this question
  const side = cross(dir, normal);
  let lo = 0, hi = 0;
  for (const e of face.edges) {
    for (const fraction of [0, 0.25, 0.5, 0.75, 1]) {
      const sideDistance = dot(sub(e.pointAt(fraction).toTuple() as Vec3, origin), side);
      lo = Math.min(lo, sideDistance);
      hi = Math.max(hi, sideDistance);
    }
  }
  const tol = Math.max(1e-6, (hi - lo) * 1e-6);

  return lo < -tol && hi > tol;
}
