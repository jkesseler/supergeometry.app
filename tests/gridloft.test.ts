// Run: npx tsx tests/gridloft.test.ts
// Lofts between every pair of six outlines (a circle, a square, a triangle, a
// hexagon, an L, a star) - straight above, to the side, half the size; smooth
// and straight-sided; and through a waist, with the ends left straight - and
// sweeps of four profiles (a circle, a square, a triangle, a ring) along six
// paths, plain, facing the same way, ending at half size, twisted: each held
// to its volume (the same outline at both ends of a loft is exactly a prism or
// a frustum; a sweep is its profile's area times the path, by Pappus).
//
// What a sweep can't do it says: facing the same way along a leg that lies in
// the profile's own plane (that leg came out missing, or the engine never came
// back), a profile that changes size or turns round a sharp corner of the path
// (two pieces run through each other).
import { circle, done, line, poly, profile, rect, sketch, XY, XZ } from './kit';
import { build, near, say } from './grid';
import type { Feature, SketchEntity } from '../src/doc/types';

const ngon = (sides: number, radius: number, cx: number, cy: number, turn = 0): [number, number][] => Array.from({ length: sides }, (_, i) => [cx + radius * Math.cos(turn + (i * 2 * Math.PI) / sides), cy + radius * Math.sin(turn + (i * 2 * Math.PI) / sides)]);
const area = (pts: [number, number][]) => Math.abs(pts.reduce((total, point, i) => total + point[0] * pts[(i + 1) % pts.length][1] - pts[(i + 1) % pts.length][0] * point[1], 0)) / 2;

// ------------------------------------------------------------ lofts
{
  const star: [number, number][] = Array.from({ length: 10 }, (_, i) => {
    const radius = i % 2 ? 6 : 12;
    const a = (i * Math.PI) / 5;

    return [radius * Math.cos(a), radius * Math.sin(a)] as [number, number];
  });
  const L_SHAPE: [number, number][] = [[-12, -12], [12, -12], [12, -2], [-2, -2], [-2, 12], [-12, 12]];
  const shapes: [string, (dx: number, k: number) => SketchEntity[], number][] = [
    ['a circle', (dx, scale) => [circle('c', dx, 0, 10 * scale)], Math.PI * 100],
    ['a square', (dx, scale) => [rect('r', dx - 10 * scale, -10 * scale, dx + 10 * scale, 10 * scale)], 400],
    ['a triangle', (dx, scale) => [poly('p', ngon(3, 12 * scale, dx, 0, Math.PI / 2))], area(ngon(3, 12, 0, 0))],
    ['a hexagon', (dx, scale) => [poly('p', ngon(6, 11 * scale, dx, 0))], area(ngon(6, 11, 0, 0))],
    ['an L', (dx, scale) => [poly('p', L_SHAPE.map(([x, y]) => [dx + x * scale, y * scale] as [number, number]))], area(L_SHAPE)],
    ['a star', (dx, scale) => [poly('p', star.map(([x, y]) => [dx + x * scale, y * scale] as [number, number]))], area(star)]
  ];
  for (const [na, shapeA, areaA] of shapes) {
    for (const [nb, shapeB, areaB] of shapes) {
      for (const [where, dx, scale] of [['straight above', 0, 1], ['above and 15 to the side', 15, 1], ['above, half the size', 0, 0.5]] as const) {
        const s1 = sketch('s1', XY(0), shapeA(0, 1));
        const s2 = sketch('s2', XY(30), shapeB(dx, scale));
        const sections = [profile('s1', shapeA(0, 1)), profile('s2', shapeB(dx, scale))];
        for (const ruled of [false, true]) {
          const got = await build([s1, s2, { id: 'Lf', name: 'Lf', type: 'loft', sections, ruled, mode: 'new' } as Feature]);
          const a1 = areaB * scale * scale;
          // The same outline at both ends: exactly a prism (leaning, to the side) or a frustum.
          const exact = na === nb ? (30 / 3) * (areaA + a1 + Math.sqrt(areaA * a1)) : null;
          const lo = Math.min(areaA, a1) * 30 * 0.9;
          const hi = Math.max(areaA, a1) * 30 * 1.1;
          const ok = !got.errors.length && !got.unsound.length && (exact !== null ? near(got.vol.Lf, exact, 3e-4) : got.vol.Lf > lo && got.vol.Lf < hi);
          say(ok, `loft ${ruled ? 'straight-sided' : 'smooth'}: ${na} to ${nb}, ${where}`, `${got.errors.join(' | ')} ${got.unsound} got ${got.vol.Lf?.toFixed(1)} ${exact !== null ? 'want ' + exact.toFixed(1) : `between ${lo.toFixed(0)} and ${hi.toFixed(0)}`}`);
        }
      }
    }
    // Through a waist (the middle one half the size).
    const s1 = sketch('s1', XY(0), shapeA(0, 1));
    const s2 = sketch('s2', XY(20), shapeA(0, 0.5));
    const s3 = sketch('s3', XY(40), shapeA(0, 1));
    const sections = [profile('s1', shapeA(0, 1)), profile('s2', shapeA(0, 0.5)), profile('s3', shapeA(0, 1))];
    for (const [label, extra] of [['smooth', {}], ['straight-sided', { ruled: true }], ['leaving both ends straight (G1)', { startContinuity: 'g1', endContinuity: 'g1' }], ['holding the curve at both ends (G2)', { startContinuity: 'g2', endContinuity: 'g2' }]] as const) {
      const got = await build([s1, s2, s3, { id: 'Lf', name: 'Lf', type: 'loft', sections, ruled: false, mode: 'new', ...extra } as Feature]);
      // (Straight-sided: two frustums, exactly.)
      const two = 2 * (20 / 3) * (areaA + areaA / 4 + areaA / 2);
      const ok = !got.errors.length && !got.unsound.length && (label === 'straight-sided' ? near(got.vol.Lf, two, 3e-4) : got.vol.Lf > areaA * 40 * 0.3 && got.vol.Lf < areaA * 40 * 1.1);
      say(ok, `loft through a waist, ${label}: ${na}`, `${got.errors.join(' | ')} ${got.unsound} got ${got.vol.Lf?.toFixed(1)} ${label === 'straight-sided' ? 'want ' + two.toFixed(1) : `of ${(areaA * 40).toFixed(0)}`}`);
    }
  }
}

// ------------------------------------------------------------ sweeps
{
  // Profiles on the ground plane round the origin; paths on the front plane, leaving the origin straight up.
  const profiles: [string, SketchEntity[], number][] = [
    ['a circle', [circle('c', 0, 0, 3)], Math.PI * 9],
    ['a square', [rect('r', -3, -3, 3, 3)], 36],
    ['a triangle', [poly('p', ngon(3, 4, 0, 0, Math.PI / 2))], area(ngon(3, 4, 0, 0))],
    ['a ring', [circle('c', 0, 0, 4), circle('d', 0, 0, 2)], Math.PI * 12]
  ];
  const arc = (id: string, a: [number, number], middle: [number, number], b: [number, number]) => ({ id, kind: 'arc', a, m: middle, b }) as unknown as SketchEntity;
  const halfRoot = Math.SQRT1_2;
  // name, the curves, its length and how far up it gets (null: a spline - not worked out), a sharp corner?
  const paths: [string, SketchEntity[], number | null, number, boolean][] = [
    ['a straight line', [line('l', [0, 0], [0, 40])], 40, 40, false],
    ['a quarter circle', [arc('a', [0, 0], [30 - 30 * halfRoot, 30 * halfRoot], [30, 30])], (Math.PI * 30) / 2, 30, false],
    ['a line then a quarter circle', [line('l', [0, 0], [0, 20]), arc('a2', [0, 20], [20 - 20 * halfRoot, 20 + 20 * halfRoot], [20, 40])], 20 + (Math.PI * 20) / 2, 40, false],
    ['an S of two arcs', [arc('a', [0, 0], [20 - 20 * halfRoot, 20 * halfRoot], [20, 20]), arc('a2', [20, 20], [20 + 20 * halfRoot, 40 - 20 * halfRoot], [40, 40])], Math.PI * 20, 40, false],
    ['a smooth spline', [{ id: 'sp', kind: 'spline', points: [[0, 0], [2, 15], [15, 30], [35, 35]], closed: false, mode: 'fit' } as unknown as SketchEntity], null, 35, false],
    ['an L with a sharp corner', [poly('p', [[0, 0], [0, 30], [30, 30]], false)], null, 30, true]
  ];
  for (const [np, profileEntities, ar] of profiles) {
    for (const [nq, pathEntities, length, rise, sharp] of paths) {
      const sp = sketch('sp', XY(0), profileEntities);
      const sq = sketch('sq', XZ(), pathEntities);
      let src = profile('sp', profileEntities);
      if (np === 'a ring') {
        src = { ...src, regions: src.regions.filter(region => region.a > 20) };
      }
      const path = { kind: 'sketch', sketch: 'sq', entities: pathEntities.map(e => e.id) };
      const sweep = (extra: object) => build([sp, sq, { id: 'Sw', name: 'Sw', type: 'sweep', source: src, path, mode: 'new', ...extra } as Feature]);
      const fine = (got: Awaited<ReturnType<typeof build>>, want: number | null) => !got.errors.length && !got.unsound.length && (want !== null ? near(got.vol.Sw, want, 5e-4) : got.vol.Sw > 0);
      const told = (got: Awaited<ReturnType<typeof build>>, want: number | null) => `${got.errors.join(' | ')} ${got.unsound} got ${got.vol.Sw?.toFixed(2)}${want !== null ? ' want ' + want.toFixed(2) : ''}`;
      const round = np === 'a circle' || np === 'a ring';

      // Plain: the profile's area times the path's length.
      const plain = length !== null ? ar * length : null;
      let built = await sweep({});
      say(fine(built, plain), `sweep ${np} along ${nq}`, told(built, plain));
      if (sharp) {
        built = await sweep({ corner: 'mitre' });
        say(fine(built, null), `sweep ${np} along ${nq}, mitred corner`, told(built, null));
      }
      // Facing the same way: the area times how far the path gets along the way the profile faces.
      built = await sweep({ orientation: 'parallel' });
      if (sharp) {
        say(/slides along its own plane/.test(built.errors.join()), `sweep ${np} along ${nq}, facing the same way: no thickness along the second leg - said so`, told(built, null));
      } else {
        say(fine(built, ar * rise), `sweep ${np} along ${nq}, facing the same way`, told(built, ar * rise));
      }
      // Ending at half size: the size runs evenly from 1 to 1/2 - 7/12 of the plain sweep.
      built = await sweep({ scale: 0.5 });
      if (sharp && np !== 'a circle') {
        say(/sharp corner/.test(built.errors.join()), `sweep ${np} along ${nq}, ending at half size: not round a sharp corner - said so`, told(built, null));
      } else {
        say(fine(built, plain !== null ? (plain * 7) / 12 : null), `sweep ${np} along ${nq}, ending at half size`, told(built, plain !== null ? (plain * 7) / 12 : null));
      }
      // Twisted a quarter turn: the same volume (the profile turns about its own middle).
      built = await sweep({ twist: 90 });
      if (sharp && !round) {
        say(/sharp corner/.test(built.errors.join()), `sweep ${np} along ${nq}, twisted 90: not round a sharp corner - said so`, told(built, null));
      } else {
        say(fine(built, plain), `sweep ${np} along ${nq}, twisted 90`, told(built, plain));
      }
    }
  }
}
done();
