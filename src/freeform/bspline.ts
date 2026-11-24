// Uniform cubic B-spline interpolation of a point grid (pure math).
//
// Every freeform patch is an equal-sized grid with the same uniform
// parameters, so the knots and the interpolation matrix are shared - and two
// patches with the same border points get exactly the same border curve.

import type { Vec3 } from '../doc/types';

export interface CubicKnots {
  /** Distinct knot values and their multiplicities (clamped: ends ×4). */
  knots: number[];
  mults: number[];
  /** The full knot vector, for evaluation. */
  full: number[];
}

/** Knots for interpolating `count` points at uniform parameters (de Boor averaging). */
export function cubicKnots(count: number): CubicKnots {
  const last = count - 1;
  const t = Array.from({ length: count }, (_, index) => index / last);
  const inner: number[] = [];
  for (let j = 1; j <= last - 3; j++) {
    inner.push((t[j] + t[j + 1] + t[j + 2]) / 3);
  }
  const full = [0, 0, 0, 0, ...inner, 1, 1, 1, 1];

  return { knots: [0, ...inner, 1], mults: [4, ...inner.map(() => 1), 4], full };
}

/** Cox–de Boor: value of basis function i (degree 3) at `param`. */
function basis(full: number[], i: number, param: number): number {
  const blend = (j: number, degree: number): number => {
    if (degree === 0) {
      // The last span includes its right end.
      const last = param === 1 && full[j + 1] === 1 && full[j] < 1;

      return (full[j] <= param && param < full[j + 1]) || last ? 1 : 0;
    }
    const a = full[j + degree] - full[j];
    const b = full[j + degree + 1] - full[j + 1];

    return (a ? ((param - full[j]) / a) * blend(j, degree - 1) : 0) + (b ? ((full[j + degree + 1] - param) / b) * blend(j + 1, degree - 1) : 0);
  };

  return blend(i, 3);
}

/** Inverse of the interpolation matrix A[k][i] = N_i(t_k) for `count` uniform points. */
const inverses = new Map<number, number[][]>();
function interpolationInverse(count: number): number[][] {
  let inv = inverses.get(count);
  if (inv) {
    return inv;
  }
  const { full } = cubicKnots(count);
  const matrix = Array.from({ length: count }, (_, row) => Array.from({ length: count }, (_, i) => basis(full, i, row / (count - 1))));
  inv = invert(matrix);
  inverses.set(count, inv);

  return inv;
}

function invert(matrix: number[][]): number[][] {
  const count = matrix.length;
  const augmented = matrix.map((row, i) => [...row, ...Array.from({ length: count }, (_, j) => (i === j ? 1 : 0))]);
  for (let column = 0; column < count; column++) {
    let pivot = column;
    for (let row = column + 1; row < count; row++) {
      if (Math.abs(augmented[row][column]) > Math.abs(augmented[pivot][column])) {
        pivot = row;
      }
    }
    [augmented[column], augmented[pivot]] = [augmented[pivot], augmented[column]];
    const pivotValue = augmented[column][column];
    for (let entry = 0; entry < 2 * count; entry++) {
      augmented[column][entry] /= pivotValue;
    }
    for (let row = 0; row < count; row++) {
      if (row === column) {
        continue;
      }
      const factor = augmented[row][column];
      if (factor) {
        for (let entry = 0; entry < 2 * count; entry++) {
          augmented[row][entry] -= factor * augmented[column][entry];
        }
      }
    }
  }

  return augmented.map(row => row.slice(count));
}

/** Poles of the bicubic surface through grid[i][j] (both directions uniform). */
export function interpolateGrid(grid: Vec3[][]): Vec3[][] {
  const rows = grid.length;
  const cols = grid[0].length;
  const iu = interpolationInverse(rows);
  const iv = interpolationInverse(cols);
  // Rows first (along j), then columns (along i).
  const partial = grid.map(row => iv.map(weights => weights.reduce((sum, x, index) => [sum[0] + x * row[index][0], sum[1] + x * row[index][1], sum[2] + x * row[index][2]] as Vec3, [0, 0, 0] as Vec3)));

  return iu.map(weights => Array.from({ length: cols }, (_, j) => weights.reduce((sum, x, index) => [sum[0] + x * partial[index][j][0], sum[1] + x * partial[index][j][1], sum[2] + x * partial[index][j][2]] as Vec3, [0, 0, 0] as Vec3)));
}

/** Evaluate the interpolating surface (for tests): S(paramU, paramV). */
export function evalSurface(poles: Vec3[][], paramU: number, paramV: number): Vec3 {
  const ku = cubicKnots(poles.length).full;
  const kv = cubicKnots(poles[0].length).full;
  const out: Vec3 = [0, 0, 0];
  for (let i = 0; i < poles.length; i++) {
    const bu = basis(ku, i, paramU);
    if (!bu) {
      continue;
    }
    for (let j = 0; j < poles[0].length; j++) {
      const weight = bu * basis(kv, j, paramV);
      if (!weight) {
        continue;
      }
      for (let q = 0; q < 3; q++) {
        out[q] += weight * poles[i][j][q];
      }
    }
  }

  return out;
}
