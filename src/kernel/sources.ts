import { norm } from '../geom';
import { rebuild } from './rebuildState';
import { entitiesWire, pathOf, regionFaces, regionHoleWires, regionWire } from './sketchGeom';
import { resolveEdge, resolveFace } from './references';
import { need } from './bodies';
import { fuseAll } from './booleans';
import type { Edge, Face, Shape3D, Wire } from 'replicad';
import type { ExtrudeSource, PathRef, SketchEntity, Vec3 } from '../doc/types';
import type { Ctx, SketchState } from './types';

const allCurves = (sketchState: SketchState): SketchEntity[] => [...sketchState.entities, ...sketchState.boundary];

export const noSketch = (id: string) => new Error(rebuild.switchedOff.has(id) ? 'Its sketch is switched off - turn it back on in History' : 'Its sketch was deleted');

/** Faces (with their outward normal) for a profile or a body face. */
export function sourceFaces(src: ExtrudeSource, ctx: Ctx): { face: Face; normal: Vec3 }[] {
  if (src.kind === 'profile') {
    const sketch = ctx.sketches.get(src.sketch);
    if (!sketch) {
      throw noSketch(src.sketch);
    }

    return regionFaces(allCurves(sketch), sketch.plane, src.regions).map(face => ({ face, normal: sketch.plane.normal }));
  }
  const face = resolveFace(need(ctx.bodies, src.face.body), src.face);
  if (face.geomType !== 'PLANE') {
    throw new Error('Only flat faces can be used here');
  }

  return [{ face, normal: norm(face.normalAt().toTuple() as Vec3) }];
}

export function sourceWires(src: ExtrudeSource, ctx: Ctx): Wire[] {
  if (src.kind === 'profile') {
    const sketch = ctx.sketches.get(src.sketch);
    if (!sketch) {
      throw noSketch(src.sketch);
    }

    return src.regions.map(region => regionWire(allCurves(sketch), sketch.plane, region));
  }

  return [resolveFace(need(ctx.bodies, src.face.body), src.face).outerWire()];
}

/**
 * Each profile's body made from its outline, its holes made the same way and
 * cut out (a sweep or a coil only follows a wire: a gear's bore or a tube's
 * inside was filled in). `make` gets the outline too, to size things by it.
 */
export function withHoles(src: ExtrudeSource, ctx: Ctx, make: (w: Wire, outer: Wire) => Shape3D): Shape3D[] {
  const outers = sourceWires(src, ctx);
  let holes: Wire[][];
  if (src.kind === 'profile') {
    const sketch = ctx.sketches.get(src.sketch)!;
    holes = src.regions.map(region => regionHoleWires(allCurves(sketch), sketch.plane, region));
  } else {
    holes = [resolveFace(need(ctx.bodies, src.face.body), src.face).innerWires()];
  }

  return outers.map((outer, i) => {
    const body = make(outer, outer);
    const cuts = (holes[i] ?? []).map(hole => make(hole, outer));

    return cuts.length ? body.cut(fuseAll(cuts)) : body;
  });
}

export function pathWire(path: PathRef, ctx: Ctx): Wire {
  if (path.kind === 'sketch') {
    const sketch = ctx.sketches.get(path.sketch);
    if (!sketch) {
      throw new Error('The path sketch was deleted');
    }

    return entitiesWire(sketch.entities, path.entities, sketch.plane);
  }
  const edges: Edge[] = path.edges.map(edge => resolveEdge(need(ctx.bodies, edge.body), edge));

  return pathOf(edges);
}
