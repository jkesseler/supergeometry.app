import { Vector3 } from 'three';
import type { Vec3 } from '../doc/types';

/** Also the grid's cell size, so a matching corner is never more than one cell away. */
const MERGE_DISTANCE = 1e-6;
/** A cell and the 26 around it. */
const neighbourOffsets = [-1, 0, 1].flatMap(dx => [-1, 0, 1].flatMap(dy => [-1, 0, 1].map(dz => [dx, dy, dz])));

/** A cell's key; two cells sharing a key is harmless, the distance check still decides. */
function hashCell(x: number, y: number, z: number) {
  return (Math.imul(x | 0, 73856093) ^ Math.imul(y | 0, 19349663) ^ Math.imul(z | 0, 83492791)) | 0;
}

/**
 * The corners of a body: its edges' ends, each once (within MERGE_DISTANCE), in the
 * order first met - selections refer to corners by that number. Found by
 * position in a grid of cells (comparing each end with every corner so far
 * took 0.3 s for a ruler's 11 000 edges).
 */
export function uniqueEnds(edges: readonly { start: Vec3; end: Vec3 }[]): Vector3[] {
  const corners: Vector3[] = [];
  const cells = new Map<number, Vector3[]>();
  for (const position of edges.flatMap(edge => [edge.start, edge.end])) {
    const point = new Vector3(...position);
    const x = Math.floor(position[0] / MERGE_DISTANCE);
    const y = Math.floor(position[1] / MERGE_DISTANCE);
    const z = Math.floor(position[2] / MERGE_DISTANCE);
    const hasCornerNearby = neighbourOffsets.some(([dx, dy, dz]) => {
      const neighbours = cells.get(hashCell(x + dx, y + dy, z + dz));

      return neighbours !== undefined && neighbours.some(corner => corner.distanceToSquared(point) < MERGE_DISTANCE ** 2);
    });
    if (hasCornerNearby) {
      continue;
    }
    const key = hashCell(x, y, z);
    const cell = cells.get(key);
    if (cell) {
      cell.push(point);
    } else {
      cells.set(key, [point]);
    }
    corners.push(point);
  }

  return corners;
}
