// Run: npx tsx tests/contact.test.ts
// Assemblies: do two bodies run into each other where they are shown? A corner of one more than a little inside
// the other. Bodies that touch, or overlap by less than the tolerance, do not.
import { inverse, penetrates, Solid } from '../src/assembly/contact';
import { about, apply, mul, translation } from '../src/assembly/joints';
import type { Vec3 } from '../src/doc/types';

let failed = 0;
const check = (name: string, ok: boolean, info: unknown = '') => {
  if (!ok) {
    failed++;
  }
  console.log(ok ? 'ok  ' : 'FAIL', name, info);
};

/** A box as a mesh, each side cut `divisions` by `divisions` (so it has corners all over it, as a real mesh does). */
function box(lo: Vec3, hi: Vec3, divisions = 4): Solid {
  const positions: number[] = [];
  const indices: number[] = [];
  const face = (origin: Vec3, edgeU: Vec3, edgeV: Vec3) => {
    const base = positions.length / 3;
    for (let j = 0; j <= divisions; j++) {
      for (let i = 0; i <= divisions; i++) {
        positions.push(origin[0] + (edgeU[0] * i + edgeV[0] * j) / divisions, origin[1] + (edgeU[1] * i + edgeV[1] * j) / divisions, origin[2] + (edgeU[2] * i + edgeV[2] * j) / divisions);
      }
    }
    for (let j = 0; j < divisions; j++) {
      for (let i = 0; i < divisions; i++) {
        const a = base + j * (divisions + 1) + i;
        indices.push(a, a + 1, a + divisions + 2, a, a + divisions + 2, a + divisions + 1);
      }
    }
  };
  const size: Vec3 = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
  face(lo, [size[0], 0, 0], [0, size[1], 0]);
  face([lo[0], lo[1], hi[2]], [size[0], 0, 0], [0, size[1], 0]);
  face(lo, [size[0], 0, 0], [0, 0, size[2]]);
  face([lo[0], hi[1], lo[2]], [size[0], 0, 0], [0, 0, size[2]]);
  face(lo, [0, size[1], 0], [0, 0, size[2]]);
  face([hi[0], lo[1], lo[2]], [0, size[1], 0], [0, 0, size[2]]);

  return new Solid(new Float32Array(positions), new Uint32Array(indices));
}

const solidA = box([0, 0, 0], [10, 10, 10]);
check('a point in the box is inside, one beside it is not', solidA.inside([5, 5, 5]) && solidA.inside([0.5, 9.5, 0.2]) && !solidA.inside([11, 5, 5]) && !solidA.inside([5, -0.1, 5]) && !solidA.inside([5, 5, 10.01]));
check('deep inside: not a point just under the skin', solidA.deepInside([5, 5, 5], 0.25) && !solidA.deepInside([5, 5, 9.9], 0.25));

const solidB = box([0, 0, 0], [4, 4, 4]);
const at = (x: number, y: number, z: number) => translation([x, y, z]);
check('apart: no', !penetrates(solidA, solidB, at(12, 3, 3), 0.25));
check('face to face, touching: no', !penetrates(solidA, solidB, at(10, 3, 3), 0.25));
check('a tenth of a millimetre in (less than the tolerance): no', !penetrates(solidA, solidB, at(9.9, 3, 3), 0.25));
check('two millimetres in: yes', penetrates(solidA, solidB, at(8, 3, 3), 0.25));
check('the small one wholly inside the big one: yes', penetrates(solidA, solidB, at(3, 3, 3), 0.25));
check('the big one over the small one (asked the other way round): yes', penetrates(solidB, solidA, at(-3, -3, -3), 0.25));
check('corner to corner, past each other: no', !penetrates(solidA, solidB, at(10.5, 10.5, 10.5), 0.25));

// Turned: the small box swung on a hinge at the big one's edge, into it and clear of it.
{
  const hinge = (deg: number) => mul(about([10, 0, 0], [0, 0, 1], deg), at(10, 0, 3));
  check('swung clear on a hinge: no', !penetrates(solidA, solidB, hinge(0), 0.25) && !penetrates(solidA, solidB, hinge(-45), 0.25));
  check('swung into the body: yes', penetrates(solidA, solidB, hinge(120), 0.25));
}
// A pin in a hole with play: a square pin 3.6 wide in a 4 wide square hole through a plate (four bars round it).
{
  const pin = box([0.2, 0.2, -5], [3.8, 3.8, 15], 6);
  const bars = [box([-3, -3, 0], [7, 0, 4]), box([-3, 4, 0], [7, 7, 4]), box([-3, 0, 0], [0, 4, 4]), box([4, 0, 0], [7, 4, 4])];
  check('a pin in its hole with 0.2 of play each side: no, at any height', [0, 3, -4].every(z => bars.every(bar => !penetrates(bar, pin, at(0, 0, z), 0.25))));
  check('the pin pushed sideways 1.5 into the wall: yes', bars.some(bar => penetrates(bar, pin, at(1.5, 0, 0), 0.25)));
}
// A move undone.
{
  const matrix = mul(about([3, 1, 2], [0.3, 0.5, 0.8], 70), at(4, -2, 9));
  const point = apply(inverse(matrix), apply(matrix, [1, 2, 3]));
  check('a move and its undoing: back where it was', Math.hypot(point[0] - 1, point[1] - 2, point[2] - 3) < 1e-9);
}
// Speed: a fine mesh against another.
{
  const big = box([0, 0, 0], [50, 50, 50], 40);
  const other = box([0, 0, 0], [20, 20, 20], 40);
  const t0 = performance.now();
  let hits = 0;
  for (let i = 0; i < 20; i++) {
    if (penetrates(big, other, at(49.5 - i * 0.01, 10, 10), 0.25)) {
      hits++;
    }
  }
  const each = (performance.now() - t0) / 20;
  check('two meshes of 19 200 triangles each, asked 20 times: under 20 ms a time', each < 20, `${each.toFixed(2)} ms, ${hits} hits`);
}

console.log(failed ? `${failed} FAILED` : 'all passed');
process.exit(failed ? 1 : 0);
