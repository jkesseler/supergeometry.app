import { add, dot, norm, scale, xDirFor } from '../../geom';
import { faceInfo, resolveFace } from '../references';
import type { AxisFeature, PlaneFeature } from '../../doc/types';
import type { Ctx } from '../types';

const PLANE_KINDS_BY_NAME: [RegExp, NonNullable<PlaneFeature['kind']>][] = [
  [/^Midplane/, 'mid'],
  [/3 Points/, '3pt'],
  [/Perp/, 'perp'],
  [/on Curve/, 'curve'],
  [/Angle/, 'angle'],
  [/Parallel/, 'parallel']
];

export function applyPlane(feature: PlaneFeature, ctx: Ctx) {
  let plane = feature.plane;
  if (feature.face) {
    const body = ctx.bodies.get(feature.face.body);
    if (body) {
      const info = faceInfo(resolveFace(body, feature.face));
      if (info.plane) {
        plane = { ...info.plane, xDir: dot(info.plane.normal, feature.plane.normal) > 0.999 ? feature.plane.xDir : info.plane.xDir };
      }
    }
  }
  plane = { ...plane, origin: add(plane.origin, scale(plane.normal, feature.offset)) };
  // (Older projects: how it was made, from its name.)
  const kind = feature.kind ?? PLANE_KINDS_BY_NAME.find(([pattern]) => pattern.test(feature.name))?.[1] ?? 'offset';
  ctx.planes.set(feature.id, { id: feature.id, name: feature.name, plane, kind });
}

export function applyAxis(feature: AxisFeature, ctx: Ctx) {
  ctx.axes.set(feature.id, { id: feature.id, name: feature.name, plane: { origin: feature.origin, normal: norm(feature.dir), xDir: xDirFor(norm(feature.dir)) } });
}
