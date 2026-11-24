// Run: npx tsx tests/spline3d.test.ts
// A spline whose points are off its sketch's plane (the gimbal's third arrow, or a Height typed): it runs through
// space - drawn there, and a sweep follows it there. A flat one is as it always was.
import { entityPolylines, entityWorldPolylines, splineHeightSamples, splineHeights } from '../src/sketch/curves';
import { splitAny, transformEntity } from '../src/sketch/edit';
import { solve } from '../src/sketch/constraints';
import { after, bodies, check, circle, done, health, near, profile, sketch, volume, XY, YZ } from './kit';
import type { Feature, SketchEntity } from '../src/doc/types';
import type { Shape3D } from 'replicad';

const flat: SketchEntity = { id: 'p', kind: 'spline', points: [[0, 0], [40, 0], [80, 0], [120, 0]], closed: false, mode: 'fit' };
const high: SketchEntity = { ...flat, z: [0, 30, 30, 0] } as SketchEntity;

check('a flat spline has no heights', splineHeights(flat) === null && splineHeightSamples(flat) === null);
check("heights that don't fit its points are not used", splineHeights({ ...flat, z: [0, 5] } as SketchEntity) === null);
check('all zero is flat', splineHeights({ ...flat, z: [0, 0, 0, 0] } as SketchEntity) === null);
const hs = splineHeightSamples(high)!;
const poly = entityPolylines(high)[0];
check('one height for each point it is drawn through', hs.length === poly.length, `${hs.length} / ${poly.length}`);
check('it passes through its points at their heights', near(hs[0], 0) && near(hs[16], 30) && near(hs[32], 30) && near(hs[hs.length - 1], 0), [hs[0], hs[16], hs[32], hs[hs.length - 1]]);
check("its shadow on the plane is the flat one's", JSON.stringify(poly) === JSON.stringify(entityPolylines(flat)[0]));

// Moved in the plane, turned, mirrored: as far off it. Scaled: that much nearer or further.
const moved = transformEntity(high, q => [q[0] + 10, q[1] - 5]) as typeof high & { z?: number[] };
check('moved in the plane: the heights stay', JSON.stringify(moved.z) === '[0,30,30,0]');
const scaled = transformEntity(high, q => [q[0] * 2, q[1] * 2]) as typeof high & { z?: number[] };
check('scaled 2: twice as high', JSON.stringify(scaled.z) === '[0,60,60,0]');
// The solver moves its points in the plane and leaves the heights.
const pinned = solve([high], [{ id: 'f', type: 'fix', pts: [{ e: 'p', p: 'k3' }], at: [130, 10] }]);
check('a constraint moves a point in the plane; the heights stay', pinned.ok && JSON.stringify((pinned.entities[0] as any).z) === '[0,30,30,0]' && near((pinned.entities[0] as any).points[3][0], 130, 1e-6));

// A round rod swept along it: flat, it lies in the plane; with heights, it rises 30 and is longer.
const rod = (path: SketchEntity): Feature[] => {
  const p = sketch('path', XY(), [path]);
  const c = sketch('prof', YZ(0), [circle('c', 0, 0, 3)]);

  return [p, c, { id: 'S', name: 'Sweep', type: 'sweep', source: profile('prof', [circle('c', 0, 0, 3)]), path: { kind: 'sketch', sketch: 'path', entities: ['p'] }, mode: 'new' } as Feature];
};
let r = await after(rod(flat), 'S');
const vFlat = volume(r.body);
const boxOf = (s: Shape3D) => s.boundingBox.bounds;
check('flat path: a straight rod 120 long', !r.err && near(vFlat, Math.PI * 9 * 120, 1), `${vFlat.toFixed(1)} ${r.err ?? ''}`);
r = await after(rod(high), 'S');
const body = [...bodies().values()][0] as Shape3D;
const vHigh = volume(body);
const [lo, hi] = boxOf(body);
check('lifted path: the rod is swept, sound', !r.err && !!body && health(body).healthy, r.err ?? '');
check('it rises off the plane: to about 30 + its radius', hi[2] > 31 && hi[2] < 36 && lo[2] > -3.5, `z ${lo[2].toFixed(2)} .. ${hi[2].toFixed(2)}`);
// Its length: along the curve drawn (the sum of its pieces), so its volume is that times the rod's section.
let run = 0;
for (let i = 1; i < poly.length; i++) {
  run += Math.hypot(poly[i][0] - poly[i - 1][0], poly[i][1] - poly[i - 1][1], hs[i] - hs[i - 1]);
}
check('as long as the curve through space', run > 125 && near(vHigh, Math.PI * 9 * run, Math.PI * 9 * run * 0.01), `${vHigh.toFixed(1)} / ${(Math.PI * 9 * run).toFixed(1)} (${run.toFixed(2)} long)`);

// A path drawn by hand in the app (five points, each up or down off a plane that stands upright), and a round
// profile on a plane put on the curve's end - where the curve is in space, square to it there. The tube is then
// as thick all the way along: its volume is its section times the curve's length. (The plane was put on the curve's
// shadow: the profile sat 25 off the curve and 22 degrees askew to it, and the tube came out lumpy and 1.4 % short.)
{
  const plane = { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, -1, 0] } as const;
  const path: SketchEntity = { id: 'w', kind: 'spline', points: [[163, 0], [145, 25], [171, 55], [174, 90], [135, 135]], closed: false, mode: 'fit', z: [31, -22, 22, 0, -25] } as SketchEntity;
  const pts = entityWorldPolylines(path, plane as any)[0];
  let len = 0;
  for (let i = 1; i < pts.length; i++) {
    len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1], pts[i][2] - pts[i - 1][2]);
  }
  const end = pts[pts.length - 1];
  const before = pts[pts.length - 2];
  const tl = Math.hypot(end[0] - before[0], end[1] - before[1], end[2] - before[2]);
  const tan = [(end[0] - before[0]) / tl, (end[1] - before[1]) / tl, (end[2] - before[2]) / tl] as [number, number, number];
  check("in space: its end is 25 off the plane, and the curve leaves the plane's direction there", near(end[1], 25, 1e-6) && Math.abs(tan[1]) > 0.3, `${end.map(v => v.toFixed(2))} tangent ${tan.map(v => v.toFixed(3))}`);
  // Any direction square to the tangent for the plane's x.
  const xl = Math.hypot(tan[2], tan[0]);
  const onCurve = { origin: end, normal: tan, xDir: [tan[2] / xl, 0, -tan[0] / xl] as [number, number, number] };
  const tube = (prof: typeof onCurve, at: [number, number]): Feature[] => [
    sketch('path', plane as any, [path]),
    sketch('prof', prof as any, [circle('c', at[0], at[1], 10)]),
    { id: 'S', name: 'Sweep', type: 'sweep', source: profile('prof', [circle('c', at[0], at[1], 10)]), path: { kind: 'sketch', sketch: 'path', entities: ['w'] }, mode: 'new' } as Feature
  ];
  let t = await after(tube(onCurve, [0, 0]), 'S');
  const said = t.r.notes.map(n => n.message).join(' ');
  check('this path bends tighter than the tube is thick (3.3 against 10): the sweep is made, and says so', !t.err && !!t.body && /bends tighter \(a radius of about 3(\.\d)? mm\).*\(10 mm\)/.test(said), said || t.err || 'no note');
  // The same path with gentler rises (a fifth of them) and a thinner rod: as thick all the way - its volume is
  // its section times the curve's length - and nothing to say.
  (path as any).z = [6, -4, 4, 0, -5];
  const soft = entityWorldPolylines(path, plane as any)[0];
  let run2 = 0;
  for (let i = 1; i < soft.length; i++) {
    run2 += Math.hypot(soft[i][0] - soft[i - 1][0], soft[i][1] - soft[i - 1][1], soft[i][2] - soft[i - 1][2]);
  }
  const e2 = soft[soft.length - 1];
  const b2 = soft[soft.length - 2];
  const l2 = Math.hypot(e2[0] - b2[0], e2[1] - b2[1], e2[2] - b2[2]);
  const t2 = [(e2[0] - b2[0]) / l2, (e2[1] - b2[1]) / l2, (e2[2] - b2[2]) / l2] as [number, number, number];
  const x2 = Math.hypot(t2[2], t2[0]);
  const square = { origin: e2, normal: t2, xDir: [t2[2] / x2, 0, -t2[0] / x2] as [number, number, number] };
  const thin = (prof: typeof square, at: [number, number]): Feature[] => [
    sketch('path', plane as any, [path]),
    sketch('prof', prof as any, [circle('c', at[0], at[1], 3)]),
    { id: 'S', name: 'Sweep', type: 'sweep', source: profile('prof', [circle('c', at[0], at[1], 3)]), path: { kind: 'sketch', sketch: 'path', entities: ['w'] }, mode: 'new' } as Feature
  ];
  t = await after(thin(square, [0, 0]), 'S');
  const good = volume(t.body);
  check('a profile on the curve, square to it: a rod as thick all the way, nothing to say', !t.err && !!t.body && health(t.body!).healthy && near(good, Math.PI * 9 * run2, Math.PI * 9 * run2 * 0.004) && !t.r.notes.length, `${good.toFixed(0)} / ${(Math.PI * 9 * run2).toFixed(0)} (${run2.toFixed(2)} long) ${t.err ?? ''} ${t.r.notes.map(n => n.message).join(' ')}`);
}

// Split in two: each piece keeps its points' heights, and where they part the two are as high as the curve was.
{
  const whole: SketchEntity = { id: 'w', kind: 'spline', points: [[0, 0], [40, 0], [80, 0], [120, 0]], closed: false, mode: 'fit', z: [0, 30, 30, 0] } as SketchEntity;
  let n = 0;
  const out = splitAny([whole], 'w', [60, 0], 1, true, () => `n${++n}`)!;
  const [a, b] = out.entities as any[];
  const at = (e: any, i: number) => [e.points[i][0], e.z?.[i]];
  check('split: two pieces, both with heights for each of their points', out.entities.length === 2 && a.z?.length === a.points.length && b.z?.length === b.points.length, JSON.stringify(out.entities.map((e: any) => [e.points.length, e.z])));
  const hA = splineHeightSamples(a)!;
  const hB = splineHeightSamples(b)!;
  check("split: they meet at the same height, the curve's own there (30 at its top)", near(hA[hA.length - 1], hB[0], 1e-9) && hA[hA.length - 1] > 29 && hA[hA.length - 1] < 34, `${hA[hA.length - 1]} / ${hB[0]}`);
  check('split: the far ends are as they were (on the plane)', near(at(a, 0)[1], 0) && near(at(b, b.points.length - 1)[1], 0));
  // A flat one split stays flat (no heights made up).
  const flat2 = splitAny([{ ...whole, z: undefined } as SketchEntity], 'w', [60, 0], 1, true, () => `m${++n}`)!;
  check('split of a flat spline: flat pieces', (flat2.entities as any[]).every(e => e.z === undefined));
}

// A loft's guide through space: a small circle to a bigger one 30 up, along a curve that bows 12 out of its plane.
{
  const lo = sketch('a', XY(), [circle('ca', 0, 0, 3)]);
  const hi = sketch('b', XY(30), [circle('cb', 0, 0, 3)]);
  const sec = (s: Feature, id: string) => ({ kind: 'profile', sketch: s.id, regions: (profile(s.id, [circle(id, 0, 0, 3)]) as any).regions });
  const guide = (z?: number[]): Feature => ({ id: 'g', name: 'g', type: 'sketch', plane: { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, -1, 0] }, entities: [{ id: 's', kind: 'spline', points: [[0, 0], [0, 10], [0, 20], [0, 30]], closed: false, mode: 'fit', ...(z ? { z } : {}) }] }) as unknown as Feature;
  const loft = { id: 'L', name: 'Loft', type: 'loft', sections: [sec(lo, 'ca'), sec(hi, 'cb')], ruled: false, mode: 'new', guide: { kind: 'sketch', sketch: 'g', entities: ['s'] } } as unknown as Feature;
  let r = await after([lo, hi, guide(), loft], 'L');
  const straight = r.body ? r.body.boundingBox.bounds : null;
  check('a loft along a flat guide: a straight rod', !r.err && !!straight && near(straight[0][1], -3, 0.05) && near(straight[1][1], 3, 0.05), r.err ?? JSON.stringify(straight));
  r = await after([lo, hi, guide([0, 12, 12, 0]), loft], 'L');
  const bowed = r.body ? r.body.boundingBox.bounds : null;
  // (The plane's normal is -Y: 12 off it is 12 towards -Y.)
  check('along the same guide bowed 12 off its plane: the rod bows out with it, and is sound', !r.err && !!bowed && bowed[0][1] < -12 && bowed[0][1] > -17 && near(bowed[1][1], 3, 0.6) && health(r.body!).healthy, r.err ?? JSON.stringify(bowed));
}
done();
