import { meshFaces } from './meshing';
import { deepCopy } from './health';
import type { Shape3D } from 'replicad';
import type { FaceMesh } from './meshing';

/**
 * How finely a mesh for printing (STL, 3MF) follows curved surfaces: within
 * 0.01 mm, and a facet per 0.05 rad (under 3°). Slicers draw each facet flat,
 * so round faces showed as polygons at the view's coarser setting.
 */
const PRINT_TOLERANCE = 0.01;
const PRINT_ANGLE = 0.05;

/**
 * A body's mesh for printing - of a copy of it: meshed itself, the body kept
 * those triangles (ten times the view's, megabytes on a part of a few hundred
 * faces) for as long as it was there, and every later copy of it carried them.
 * Kept here with the body instead, for the next file made of it.
 */
const printMeshes = new WeakMap<Shape3D, FaceMesh>();
export function printMesh(shape: Shape3D): FaceMesh {
  let faceMesh = printMeshes.get(shape);
  if (!faceMesh) {
    printMeshes.set(shape, (faceMesh = meshFaces(deepCopy(shape), PRINT_TOLERANCE, PRINT_ANGLE)));
  }

  return faceMesh;
}
