import { Vector3 } from 'three';
import type { Vec3 } from '../doc/types';

/**
 * The corners of a body: its edges' ends, each once (within 1e-6), in the
 * order first met - selections refer to corners by that number. Found by
 * position in a grid of cells (comparing each end with every corner so far
 * took 0.3 s for a ruler's 11 000 edges).
 */
export function uniqueEnds(edges: readonly { start: Vec3; end: Vec3 }[]): Vector3[] {
  const out: Vector3[] = [];
  // Cells by a hash of their coordinates (two cells sharing a hash is
  // harmless: the distance check still decides).
  const cells = new Map<number, number[]>();
  const hashCell = (x: number, y: number, z: number) => (Math.imul(x | 0, 73856093) ^ Math.imul(y | 0, 19349663) ^ Math.imul(z | 0, 83492791)) | 0;
  const cellSize = 1e-6;
  for (const e of edges) {
    for (const point of [e.start, e.end]) {
      const vector = new Vector3(point[0], point[1], point[2]);
      const cx = Math.floor(point[0] / cellSize), cy = Math.floor(point[1] / cellSize), cz = Math.floor(point[2] / cellSize);
      let found = false;
      for (let dx = -1; dx <= 1 && !found; dx++) {
        for (let dy = -1; dy <= 1 && !found; dy++) {
          for (let dz = -1; dz <= 1 && !found; dz++) {
            const cell = cells.get(hashCell(cx + dx, cy + dy, cz + dz));
            if (cell) {
              for (const i of cell) {
                if (out[i].distanceToSquared(vector) < 1e-12) {
                  found = true; break; 
                }
              }
            }
          }
        }
      }
      if (found) {
        continue;
      }
      const key = hashCell(cx, cy, cz);
      const bucket = cells.get(key);
      if (bucket) {
        bucket.push(out.length);
      } else {
        cells.set(key, [out.length]);
      }
      out.push(vector);
    }
  }

  return out;
}
