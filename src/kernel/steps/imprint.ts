import { need } from '../bodies';
import { resolveEdge, resolveFace } from '../references';
import { sourceFaces } from '../sources';
import { imprint, onFace as linesOnFace, seenFrom, wrapOnto } from '../wrap';
import type { ImprintFeature, Vec3, WrapFeature } from '../../doc/types';
import type { Ctx } from '../types';

export function applyImprint(feature: ImprintFeature, ctx: Ctx) {
  const { bodies } = ctx;
  const body = need(bodies, feature.body);
  if (feature.source) {
    const src = sourceFaces(feature.source, ctx);
    if (!src.length) {
      throw new Error('Nothing to project');
    }
    const normal = src[0].normal;
    bodies.set(feature.body, imprint(body, src.flatMap(source => source.face.edges), normal, seenFrom(body, src[0].face.center.toTuple() as Vec3, normal)));

    return;
  }
  if (!feature.edges?.length || !feature.face) {
    throw new Error('Pick the edges, then the face to project them onto');
  }
  const face = resolveFace(body, feature.face);
  const curves = feature.edges.map(edge => resolveEdge(need(bodies, edge.body), edge));
  bodies.set(feature.body, imprint(body, curves, face.normalAt(face.center).toTuple() as Vec3, linesOnFace(body, face)));
}

export function applyWrap(feature: WrapFeature, ctx: Ctx) {
  const { bodies } = ctx;
  const body = need(bodies, feature.face.body);
  const round = resolveFace(body, feature.face, face => face.geomType === 'CYLINDRE');
  bodies.set(feature.face.body, wrapOnto(body, round, sourceFaces(feature.source, ctx), feature.height));
}
