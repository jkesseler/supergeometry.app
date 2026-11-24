// A computer mouse, built the way it's done by hand: a top outline (closed
// spline) extruded, a side profile (spline top) through it with Intersect, the
// top rim rounded, hollowed from underneath (Shell), split lines cut for the
// buttons, a scroll wheel with 24 knurls (Pattern Circular, Union) sitting in
// its slot, two thumb buttons on the side.
//
// It is here because each step is one that breaks in CAD: a fillet along a
// spline-on-spline edge, a shell of a rounded freeform-ish body, cuts through a
// thin curved wall, a union of two dozen small bodies.
import { meshVolume } from '../src/kernel/health';
import { measureArea as trueArea, measureVolume as trueVolume } from '../src/kernel/ocFree';
import { check, done, sketch, profile, XY, YZ, plane, rect, poly, after, bodies, health } from './kit';
import { near, faceRef, edgeRefs } from './grid';
import type { Feature, SketchEntity } from '../src/doc/types';

const fs: Feature[] = [];
let t0 = Date.now();
const sk = (id: string, pl: ReturnType<typeof XY>, es: SketchEntity[]) => {
  fs.push(sketch(id, pl, es));

  return es;
};
const prof = (id: string, es: SketchEntity[]) => profile(id, es);

/** Rebuild; each body's health; the first error. */
async function stage(name: string, want: Record<string, number> = {}) {
  const { errors } = await after(fs);
  const info: Record<string, { v: number; ok: boolean; solids: number; faces: number }> = {};
  for (const [id, s] of bodies()) {
    const h = health(s);
    info[id] = { v: Math.round(h.volume * 10) / 10, ok: h.valid && !h.openEdges && !h.thin, solids: h.solids, faces: h.faces };
  }
  const bad = Object.entries(info).filter(([id, i]) => !i.ok || i.solids !== (want[id] ?? 1));
  check(`${name}: builds`, !errors.length, errors.join('; '));
  check(`${name}: sound bodies`, !bad.length, bad);
  console.log('     ', JSON.stringify(info));

  return info;
}

// --- 1. Top outline: a closed spline, symmetric about Y (front at y = 0).
const outline = sk('sTop', XY(), [
  { id: 'ol', kind: 'spline', closed: true, mode: 'fit', points: [[0, -1], [21, 5], [28, 35], [31, 75], [26, 104], [0, 117], [-26, 104], [-31, 75], [-28, 35], [-21, 5]] } as SketchEntity
]);
fs.push({ id: 'mouse', name: 'Shape', type: 'extrude', source: prof('sTop', outline), distance: 45, mode: 'new' } as Feature);
const s1 = await stage('outline extruded');
check('outline block volume is plausible (about 6000 mm2 x 45)', s1.mouse?.v > 45 * 5000 && s1.mouse?.v < 45 * 7500, s1.mouse?.v);
// The block is its flat end times 45, and its side the outline times 45: the
// engine's measure had the block 11 % over (316 000 for 284 800) and the side
// 1.7 % over, integrating the spline's extruded side in one piece.
{
  const b = bodies().get('mouse')!;
  const cap = trueArea(b.faces.find(f => f.geomType === 'PLANE')!);
  const sideFace = b.faces.find(f => f.geomType !== 'PLANE')!;
  const rim = b.edges.filter(e => Math.abs(e.startPoint.z) < 1e-6 && Math.abs(e.endPoint.z) < 1e-6).reduce((a, e) => a + e.length, 0);
  check("the block's volume is its end x 45 (to a millionth)", Math.abs(trueVolume(b) - cap * 45) < cap * 45 * 1e-6, [trueVolume(b), cap * 45]);
  check("the block's side is its outline x 45 (to a millionth)", Math.abs(trueArea(sideFace) - rim * 45) < rim * 45 * 1e-6, [trueArea(sideFace), rim * 45]);
}

// --- 2. Side profile on YZ (u = world Y, v = world Z): flat bottom, spline top
// low at the front, a hump two thirds back, down at the tail. Intersect.
const side = sk('sSide', YZ(-40), [
  { id: 'bot', kind: 'line', a: [-5, 0], b: [122, 0] } as SketchEntity,
  { id: 'back', kind: 'line', a: [122, 0], b: [122, 11] } as SketchEntity,
  { id: 'topc', kind: 'spline', closed: false, mode: 'fit', points: [[122, 11], [104, 28], [74, 37.5], [40, 31], [10, 20], [-5, 15]] } as SketchEntity,
  { id: 'front', kind: 'line', a: [-5, 15], b: [-5, 0] } as SketchEntity
]);
const sideProf = prof('sSide', side);
check('the side profile is one closed shape', sideProf.regions.length === 1, sideProf.regions.length);
fs.push({ id: 'sideCut', name: 'Side shape', type: 'extrude', source: sideProf, distance: 80, mode: 'intersect', target: 'mouse' } as Feature);
const s2 = await stage('side profile intersected');
check('intersect took a good part away', s2.mouse && s2.mouse.v < s1.mouse.v * 0.75 && s2.mouse.v > s1.mouse.v * 0.4, [s1.mouse?.v, s2.mouse?.v]);

// --- 3. Round the top rim (the spline-on-spline edge), 6 mm.
const rim = edgeRefs('mouse', m => m[2] > 2);
check('the top rim has edges', rim.length > 0, rim.length);
fs.push({ id: 'rimRound', name: 'Round the top', type: 'fillet', edges: rim, radius: 6 } as Feature);
const s3 = await stage('top rim rounded 6');
check('the round took a little away', s3.mouse && s3.mouse.v < s2.mouse.v && s3.mouse.v > s2.mouse.v * 0.9, [s2.mouse?.v, s3.mouse?.v]);

// Bottom edge: a small 1 mm round as well.
const foot = edgeRefs('mouse', m => Math.abs(m[2]) < 1e-6);
fs.push({ id: 'footRound', name: 'Round the foot', type: 'fillet', edges: foot, radius: 1 } as Feature);
const s3b = await stage('foot rounded 1');

// --- 4. Hollow it from underneath, walls 1.6.
const under = faceRef('mouse', (n, c) => n[2] < -0.99 && Math.abs(c[2]) < 1e-6);
fs.push({ id: 'hollow', name: 'Hollow', type: 'shell', body: 'mouse', faces: [under], thickness: 1.6 } as Feature);
t0 = Date.now();
const s4 = await stage('shelled 1.6 from below');
check('the shell in under 30 s (its wall checks took 51 s)', Date.now() - t0 < 30000, Date.now() - t0);
check('the shell is a thin skin (under 25 % of the solid)', s4.mouse && s4.mouse.v < s3b.mouse.v * 0.25 && s4.mouse.v > s3b.mouse.v * 0.05, [s3b.mouse?.v, s4.mouse?.v]);
// Measured right on the offset faces too (it read 21 489 for 22 249): a fine
// mesh comes to it from above (22 310, 22 290, 22 255 as it gets finer).
const mesh4 = meshVolume(bodies().get('mouse')!, 130);
check("the shell's volume agrees with a mesh (0.5 %)", Math.abs(mesh4 - s4.mouse.v) < s4.mouse.v * 0.005, [s4.mouse.v, mesh4]);

// --- 5. Split lines for the buttons, cut down from above to z = 18: one
// between left and right button, one right across behind them, a slot for
// the wheel. (The line across used to fail: cut in two by it, the shell's
// inner faces "didn't meet up", at every tolerance - the edge where the inner
// top meets the inner round was 0.2 mm off. tightenEdges makes it again.)
const lines = sk('sLines', XY(60), [
  rect('gap', -0.4, -5, 0.4, 14),
  rect('gap2', -0.4, 36, 0.4, 52),
  rect('across', -40, 52, 40, 52.8),
  rect('slot', -4.5, 14, 4.5, 36)
]);
const across = lines.slice(2, 3);
fs.push({ id: 'splitLines', name: 'Button lines', type: 'extrude', source: prof('sLines', lines), distance: -42, mode: 'cut', target: 'mouse' } as Feature);
t0 = Date.now();
const s5 = await stage('button lines cut');
check('the button lines in under 20 s', Date.now() - t0 < 20000, Date.now() - t0);
// The lines and the slot take a few hundred mm3 of 1.6 mm walls, no more.
check('the lines took 100 to 600 mm3', s4.mouse.v - s5.mouse.v > 100 && s4.mouse.v - s5.mouse.v < 600, [s4.mouse?.v, s5.mouse?.v]);

// --- 6. The scroll wheel: a disc 7 wide about X at (y 25, z 24), r 9, with 24
// knurls (a little block on the rim, Pattern Circular, Union).
const wheel = sk('sWheel', YZ(-3.5), [{ id: 'wc', kind: 'circle', center: [25, 24], radius: 9 } as SketchEntity]);
fs.push({ id: 'wheel', name: 'Wheel', type: 'extrude', source: prof('sWheel', wheel), distance: 7, mode: 'new' } as Feature);
const knurl = sk('sKnurl', YZ(-3.5), [rect('kn', 24.5, 32.6, 25.5, 33.8)]);
fs.push({ id: 'knurl', name: 'Knurl', type: 'extrude', source: prof('sKnurl', knurl), distance: 7, mode: 'new' } as Feature);
const axis = { origin: [0, 25, 24] as [number, number, number], dir: [1, 0, 0] as [number, number, number] };
fs.push({ id: 'knurls', name: 'Knurls', type: 'transform', bodies: ['knurl'], copy: true, op: { kind: 'circular', axis, count: 24, angle: 360 } } as Feature);
fs.push({ id: 'wheelJoin', name: 'Knurls on the wheel', type: 'boolean', op: 'union', target: 'wheel', tools: ['knurl', ...Array.from({ length: 23 }, (_, k) => `knurls:knurl:${k}`)] } as Feature);
// An axle hole through it.
const axle = sk('sAxle', YZ(-3.5), [{ id: 'ax', kind: 'circle', center: [25, 24], radius: 1.5 } as SketchEntity]);
fs.push({ id: 'axleHole', name: 'Axle hole', type: 'extrude', source: prof('sAxle', axle), distance: 7, mode: 'cut', target: 'wheel' } as Feature);
const s6 = await stage('scroll wheel');
const disc = Math.PI * (81 - 2.25) * 7;
const knurls = 24 * 1 * 1.2 * 7;
check('the wheel is the disc, the hole out, 24 knurls on (the part of each inside the disc not counted)', s6.wheel && s6.wheel.v > disc && s6.wheel.v < disc + knurls, [s6.wheel?.v, disc, disc + knurls]);
check('only the mouse and the wheel are left', Object.keys(s6).sort().join() === 'mouse,wheel', Object.keys(s6));

// The wheel sits in its slot: clear of the shell.
fs.push({ id: 'clear', name: 'Clearance check', type: 'boolean', op: 'intersect', target: 'mouse', tools: ['wheel'], keepTarget: true, keepTools: true } as Feature);
const { errors: ce } = await after(fs);
const touching = [...bodies().keys()].filter(k => !['mouse', 'wheel'].includes(k));
const overlap = touching.reduce((a, k) => a + health(bodies().get(k)!).volume, 0);
check("the wheel doesn't run into the shell", overlap < 1e-3, { ce, touching, overlap });
fs.pop();

// --- 7. Thumb buttons: two holes through the left wall, cut from a plane
// beside it. Drawn first with the plane's up the wrong way (its v runs down:
// the shapes below the mouse) - the cut takes nothing, and must say so.
const wrong = sk('sThumbWrong', plane([-40, 0, 0], [-1, 0, 0], [0, 1, 0]), [rect('tw', 60, 12, 74, 18)]);
fs.push({ id: 'thumbWrong', name: 'Thumb (missed)', type: 'extrude', source: prof('sThumbWrong', wrong), distance: -15, mode: 'cut', target: 'mouse' } as Feature);
const { r: rw } = await after(fs);
check('a cut that misses says so', (rw.notes ?? []).some(n => n.featureId === 'thumbWrong' && /doesn't reach/.test(n.message)), rw.notes);
fs.pop();
fs.pop();
// (Plane x = -40 facing -x, its x along -y: v is up. u = -y.)
const thumb = sk('sThumb', plane([-40, 0, 0], [-1, 0, 0], [0, -1, 0]), [
  poly('t1', [[-60, 12], [-74, 13], [-74, 19], [-60, 18]]),
  poly('t2', [[-77, 13.2], [-91, 13.5], [-91, 19.5], [-77, 19.2]])
]);
fs.push({ id: 'thumbs', name: 'Thumb buttons', type: 'extrude', source: prof('sThumb', thumb), distance: -15, mode: 'cut', target: 'mouse' } as Feature);
const s7 = await stage('thumb button holes');
const { r: r7 } = await after(fs);
check('the holes took a little, and no note', s7.mouse && s7.mouse.v < s6.mouse.v && !(r7.notes ?? []).length, [s6.mouse?.v, s7.mouse?.v, r7.notes]);

// --- 8. A sensor hole in the bottom plate. The plate is the other part:
// the outline again, 1.6 thick, inset by the shell, a Ø6 hole.
const olPts = (outline[0] as any).points as [number, number][];
const inset = (d: number) => olPts.map((p, i) => {
  const a = olPts[(i + olPts.length - 1) % olPts.length], b = olPts[(i + 1) % olPts.length];
  const tx = b[0] - a[0], ty = b[1] - a[1], l = Math.hypot(tx, ty);

  // (Counter-clockwise outline: inward is the tangent turned left.)
  return [p[0] - (ty / l) * d, p[1] + (tx / l) * d] as [number, number];
});
const plate = sk('sPlate', XY(), [
  { id: 'pl', kind: 'spline', closed: true, mode: 'fit', points: inset(2.2) } as SketchEntity,
  { id: 'eye', kind: 'circle', center: [0, 45], radius: 3 } as SketchEntity
]);
fs.push({ id: 'base', name: 'Base plate', type: 'extrude', source: profile('sPlate', plate, rs => rs.filter((r: any) => !String(JSON.stringify(r)).includes('"eye"') || String(JSON.stringify(r)).includes('"pl"'))), distance: 1.6, mode: 'new' } as Feature);
const s8 = await stage('base plate');
check("the base plate has its hole (under the full outline's area x 1.6)", !!s8.base, s8.base);

// The plate fits inside the shell's foot.
fs.push({ id: 'clear2', name: 'Clearance check', type: 'boolean', op: 'intersect', target: 'mouse', tools: ['base'], keepTarget: true, keepTools: true } as Feature);
await after(fs);
const ov2 = [...bodies().keys()].filter(k => !['mouse', 'wheel', 'base'].includes(k)).reduce((a, k) => a + health(bodies().get(k)!).volume, 0);
check('the plate is clear of the shell (under 1 mm3 touching)', ov2 < 1, ov2);
fs.pop();

console.log('final', JSON.stringify(await stage('final')));
// MOUSE_OUT=<file>: the project, with the line across and the missed cut at the end (to open in the app).
if (process.env.MOUSE_OUT) {
  const { writeFileSync } = await import('node:fs');
  const extra = [sketch('sThumbWrong', plane([-40, 0, 0], [-1, 0, 0], [0, 1, 0]), wrong), { id: 'thumbWrong', name: 'Thumb (missed)', type: 'extrude', source: prof('sThumbWrong', wrong), distance: -15, mode: 'cut', target: 'mouse' }];
  writeFileSync(process.env.MOUSE_OUT, JSON.stringify({ format: 'super', version: 2, name: 'Mouse (stress)', features: [...fs, ...extra], variables: [], views: [], units: 'mm', hidden: [], pins: [], names: {}, colors: {}, historyGroups: [] }));
}
done();
