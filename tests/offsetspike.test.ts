// Run: npx tsx tests/offsetspike.test.ts
// Offset by chain of an outline with sharp corners (the user's Sketch 11: a
// 9-line outline with a narrow spike) must never cross over the original.
import assert from 'node:assert/strict';
import { defaultOffset, offsetChain } from '../src/sketch/edit';
import { closestOnPrim, entityPrims } from '../src/sketch/curves';
import { patternSpacing, roundSig } from '../src/geom';
import type { SketchEntity, Vec2 } from '../src/doc/types';

const line = (id: string, a: Vec2, b: Vec2): SketchEntity => ({ id, kind: 'line', a, b });
// Sketch 11's outline (closed, clockwise as drawn).
const OUTLINE: Vec2[] = [
  [4099.992124946016, -1000.0940924028508],
  [3200.0088891664545, -3300.0067232037127],
  [5400, -8800],
  [2149.9926430788155, -5983.329624025584],
  [1299.9999999999995, -9500],
  [4899.999999999999, -11800],
  [7700, -11300],
  [7402.335373455015, -5299.7272120100615],
  [6897.664625653082, -1000.0940924028508]
];
const loop = (pts: Vec2[]) => pts.map((point, i) => line(`e${i}`, point, pts[(i + 1) % pts.length]));

function segsCross(a: Vec2, b: Vec2, pointC: Vec2, pointD: Vec2): boolean {
  const orientation = (first: Vec2, q: Vec2, third: Vec2) => (q[0] - first[0]) * (third[1] - first[1]) - (q[1] - first[1]) * (third[0] - first[0]);
  const d1 = orientation(pointC, pointD, a), d2 = orientation(pointC, pointD, b), d3 = orientation(a, b, pointC), d4 = orientation(a, b, pointD);

  return d1 * d2 < 0 && d3 * d4 < 0;
}

/** Offset pieces: none crosses the original, each point stays about |`distance`| from it (never nearer). */
function checkOffset(orig: SketchEntity[], distance: number, label: string) {
  const out = offsetChain(orig, orig[0].id, distance);
  if (!out) {
    return;
  } // nothing left at this distance is fine
  const made = out.slice(orig.length) as Extract<SketchEntity, { kind: 'line' }>[];
  assert.ok(made.length >= 3, `${label}: a closed outline`);
  for (const madeLine of made) {
    for (const originalLine of orig as Extract<SketchEntity, { kind: 'line' }>[]) {
      assert.ok(!segsCross(madeLine.a, madeLine.b, originalLine.a, originalLine.b), `${label}: offset ${JSON.stringify([madeLine.a, madeLine.b])} crosses the original`);
    }
  }
  const dist = (q: Vec2) => Math.min(...orig.map(sketchEntity => closestOnPrim(entityPrims(sketchEntity)[0], q).d));
  for (const madeLine of made) {
    for (let t = 0; t <= 1; t += 0.05) {
      const q: Vec2 = [madeLine.a[0] + (madeLine.b[0] - madeLine.a[0]) * t, madeLine.a[1] + (madeLine.b[1] - madeLine.a[1]) * t];
      assert.ok(dist(q) > Math.abs(distance) * 0.98, `${label}: a point of the offset is only ${dist(q).toFixed(1)} from the original (d ${distance})`);
    }
  }
}

const checks: [string, () => void][] = [
  ['default offset is a tenth of the curve, rounded', () => {
    assert.equal(defaultOffset(line('a', [0, 0], [100, 0])), 10);
    assert.equal(defaultOffset(line('a', [0, 0], [2174, 0])), 220);
    assert.equal(defaultOffset({ id: 'c', kind: 'circle', center: [0, 0], radius: 5 }), 1);
    assert.equal(defaultOffset({ id: 'r', kind: 'rect', center: [0, 0], w: 3000, h: 400, rotation: 0 }), 40);
    // Sketch 11's first side (2470 long): 250, not 2.
    assert.equal(defaultOffset(line('s', OUTLINE[0], OUTLINE[1])), 250);
  }],
  ['inward past the notch: the lower lobe keeps its own outline (joined where the offsets meet)', () => {
    const orig = loop(OUTLINE);
    const out = offsetChain(orig, orig[0].id, -800)!;
    const made = out.slice(orig.length) as Extract<SketchEntity, { kind: 'line' }>[];
    // Some offset runs through the lobe (around x 2200..3000, y -7500..-9100).
    assert.ok(made.some(madeLine => [madeLine.a, madeLine.b].some(q => q[0] < 3000 && q[1] < -7400 && q[1] > -9200)), 'lobe offset missing');
    checkOffset(orig, -800, 'lobe');
  }],
  ['pattern spacing starts just clear of the shape', () => {
    assert.equal(patternSpacing(100), 120);
    assert.equal(patternSpacing(2350), 2800);
    assert.equal(patternSpacing(0), 10);
    assert.equal(patternSpacing(0, 20), 20);
    assert.ok(patternSpacing(37) > 37);
    assert.equal(roundSig(0.0347), 0.035);
  }],
  ["Sketch 11 outline offset inward 840 doesn't cross it", () => checkOffset(loop(OUTLINE), -840, 'in 840')],
  ['Sketch 11 outline at many distances, both ways', () => {
    for (const distance of [50, 200, 400, 600, 840, 1000, 1300]) {
      checkOffset(loop(OUTLINE), distance, `out ${distance}`);
      checkOffset(loop(OUTLINE), -distance, `in ${distance}`);
    }
  }],
  ['random star-ish outlines with sharp corners', () => {
    let seed = 3;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let t = 0; t < 120; t++) {
      const sides = 5 + Math.floor(rnd() * 6);
      const pts: Vec2[] = [];
      for (let i = 0; i < sides; i++) {
        const a = (i / sides) * 2 * Math.PI;
        const radius = i % 2 ? 30 + rnd() * 40 : 100 + rnd() * 60;
        pts.push([Math.cos(a) * radius, Math.sin(a) * radius]);
      }
      if (rnd() < 0.5) {
        pts.reverse();
      }
      for (const distance of [3, 8, 15]) {
        checkOffset(loop(pts), distance, `case ${t} out ${distance}`);
        checkOffset(loop(pts), -distance, `case ${t} in ${distance}`);
      }
    }
  }]
];

let failed = 0;
for (const [name, run] of checks) {
  try {
    run();
    console.log(`ok   ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${name}\n     ${(e as Error).message}`);
  }
}
if (failed) {
  process.exit(1);
}
console.log('all offset-spike checks passed');
