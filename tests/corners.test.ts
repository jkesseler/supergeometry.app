// Run: npx tsx tests/corners.test.ts - a body's corners from its edges' ends: ends within 1e-6 are one corner,
// numbered in the order first met (selections refer to corners by that number).
import { uniqueEnds } from '../src/view/corners';
import type { Vec3 } from '../src/doc/types';

let failed = 0;
const check = (name: string, ok: boolean, info: unknown = '') => {
  if (!ok) {
    failed++;
  }
  console.log(ok ? 'ok  ' : 'FAIL', name, typeof info === 'string' ? info : JSON.stringify(info));
};
const cornersOf = (...ends: [Vec3, Vec3][]) => uniqueEnds(ends.map(([start, end]) => ({ start, end }))).map(corner => corner.toArray());

const acrossBorder = cornersOf([[4.6e-6, 0, 0], [5.4e-6, 0, 0]]);
check('ends 0.8e-6 apart in neighbouring cells are one corner, the first one met', JSON.stringify(acrossBorder) === JSON.stringify([[4.6e-6, 0, 0]]), acrossBorder);
check('ends 2e-6 apart are two corners', cornersOf([[0, 0, 0], [2e-6, 0, 0]]).length === 2);
// 2^32 cells along x apart: both cells get the same key.
check('far-apart ends whose cells share a key are two corners', cornersOf([[0, 0, 0], [4294.967296, 0, 0]]).length === 2);
const triangle = cornersOf([[1, 0, 0], [0, 0, 0]], [[0, 0, 0], [0, 1, 0]], [[0, 1, 0], [1, 0, 0]]);
check('corners are numbered in the order first met', JSON.stringify(triangle) === JSON.stringify([[1, 0, 0], [0, 0, 0], [0, 1, 0]]), triangle);

console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
