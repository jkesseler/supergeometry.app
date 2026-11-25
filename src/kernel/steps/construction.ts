import { add, dot, norm, scale, xDirFor } from '../../geom';
import { faceInfo, resolveFace } from '../references';
import type { AxisFeature, PlaneFeature } from '../../doc/types';
import type { Ctx } from '../types';

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
  const kind = feature.kind ?? (/^Midplane/.test(feature.name) ? 'mid' : /3 Points/.test(feature.name) ? '3pt' : /Perp/.test(feature.name) ? 'perp' : /on Curve/.test(feature.name) ? 'curve' : /Angle/.test(feature.name) ? 'angle' : /Parallel/.test(feature.name) ? 'parallel' : 'offset');
  ctx.planes.set(feature.id, { id: feature.id, name: feature.name, plane, kind });
}

export function applyAxis(feature: AxisFeature, ctx: Ctx) {
  ctx.axes.set(feature.id, { id: feature.id, name: feature.name, plane: { origin: feature.origin, normal: norm(feature.dir), xDir: xDirFor(norm(feature.dir)) } });
}
