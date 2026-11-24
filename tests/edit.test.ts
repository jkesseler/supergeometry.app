// Run: npx tsx tests/edit.test.ts
import assert from 'node:assert/strict';
import { splitAny, connectedChain, extend, filletCorner, filletEnds, joinEnds, offsetChain, splitEntity, mirrorXf, offsetEntity, transformEntity, trim } from '../src/sketch/edit';
import { arrangement } from '../src/sketch/regions';
import { splinePoints } from '../src/sketch/curves';
import type { SketchEntity } from '../src/doc/types';

const kinds = (es: SketchEntity[]) => es.map(e => e.kind).sort().join(',');
const checks: [string, () => void][] = [
  ['trim circle crossed by a line → arc remains', () => {
    const es: SketchEntity[] = [{ id: 'c', kind: 'circle', center: [0, 0], radius: 10 }, { id: 'l', kind: 'line', a: [-20, 0], b: [20, 0] }];
    const out = trim(es, 'c', [0, 10]);
    assert.equal(kinds(out), 'arc,line');
    assert.equal(arrangement(out).regions.length, 1); // half disc
  }],
  ['trim middle of a line between two crossings', () => {
    const es: SketchEntity[] = [{ id: 'l', kind: 'line', a: [0, 0], b: [30, 0] }, { id: 'v1', kind: 'line', a: [10, -5], b: [10, 5] }, { id: 'v2', kind: 'line', a: [20, -5], b: [20, 5] }];
    const out = trim(es, 'l', [15, 0]);
    assert.equal(out.filter(e => e.kind === 'line').length, 4);
  }],
  ['trim one side of a rect', () => {
    const es: SketchEntity[] = [{ id: 'r', kind: 'rect', center: [0, 0], w: 20, h: 10, rotation: 0 }];
    const out = trim(es, 'r', [0, 5]);
    assert.equal(out.length, 3);
  }],
  ['fillet a rect corner', () => {
    const es: SketchEntity[] = [{ id: 'r', kind: 'rect', center: [0, 0], w: 20, h: 10, rotation: 0 }];
    const out = filletCorner(es, [10, 5], 2, 0.5)!;
    assert.equal(kinds(out), 'arc,line,line,line,line');
    const regions = arrangement(out).regions;
    assert.equal(regions.length, 1);
    assert.ok(Math.abs(regions[0].area - (200 - (4 - Math.PI)) ) < 0.05, `area ${regions[0].area}`);
  }],
  ['offset rect outward', () => {
    const sketchEntity = offsetEntity({ id: 'r', kind: 'rect', center: [0, 0], w: 20, h: 10, rotation: 0 }, 2)!;
    assert.deepEqual([sketchEntity.kind, (sketchEntity as any).w, (sketchEntity as any).h], ['rect', 24, 14]);
  }],
  ['extend a line to a circle', () => {
    const es: SketchEntity[] = [{ id: 'l', kind: 'line', a: [-5, 0], b: [0, 0] }, { id: 'c', kind: 'circle', center: [20, 0], radius: 5 }];
    const out = extend(es, 'l', [0, 0])!;
    const line = out.find(e => e.id === 'l') as any;
    assert.ok(Math.abs(line.b[0] - 15) < 0.05, `x=${line.b[0]}`);
  }],
  ['join two lines into a corner (picked halves)', () => {
    const es: SketchEntity[] = [{ id: 'h', kind: 'line', a: [0, 0], b: [10, 0] }, { id: 'v', kind: 'line', a: [20, 5], b: [20, 15] }];
    const out = joinEnds(es, { id: 'h', at: [8, 0] }, { id: 'v', at: [20, 7] })!;
    const horizontal = out.find(e => e.id === 'h') as any;
    const vertical = out.find(e => e.id === 'v') as any;
    assert.deepEqual([horizontal.a, horizontal.b, vertical.a, vertical.b].map(point => point.map((x: number) => Math.round(x * 1e6) / 1e6)), [[0, 0], [20, 0], [20, 0], [20, 15]]);
    assert.equal(arrangement(out).regions.length, 0);
  }],
  ['join line to arc: arc follows its circle', () => {
    // Quarter arc of radius 10 around the origin, from (10,0) to (0,10); a line below it.
    const es: SketchEntity[] = [{ id: 'a', kind: 'arc', a: [10, 0], m: [7.0710678, 7.0710678], b: [0, 10] }, { id: 'l', kind: 'line', a: [-20, -5], b: [-12, -5] }];
    const out = joinEnds(es, { id: 'a', at: [1, 9.9] }, { id: 'l', at: [-13, -5] })!;
    const a = out.find(e => e.id === 'a') as any;
    const line = out.find(e => e.id === 'l') as any;
    const meet = [-Math.sqrt(75), -5];
    assert.ok(Math.hypot(a.b[0] - meet[0], a.b[1] - meet[1]) < 1e-6 && Math.hypot(line.b[0] - meet[0], line.b[1] - meet[1]) < 1e-6, JSON.stringify([a.b, line.b]));
    assert.ok(Math.abs(Math.hypot(...(a.m as [number, number])) - 10) < 1e-6 && a.m[1] > 0, 'mid stays on the circle, upper side');
  }],
  ['both halves of one arc close it into a circle', () => {
    const es: SketchEntity[] = [{ id: 'a', kind: 'arc', a: [10, 0], m: [0, 10], b: [-10, 0] }];
    const out = joinEnds(es, { id: 'a', at: [9, 3] }, { id: 'a', at: [-9, 3] })!;
    assert.equal(out[0].kind, 'circle');
  }],
  ['split a line at its middle', () => {
    const out = splitEntity([{ id: 'l', kind: 'line', a: [0, 0], b: [10, 0] }], 'l', 'l2')!;
    assert.deepEqual(out.map((e: any) => [e.id, e.a, e.b]), [['l', [0, 0], [5, 0]], ['l2', [5, 0], [10, 0]]]);
  }],
  ['split an arc at a tapped point', () => {
    const out = splitEntity([{ id: 'a', kind: 'arc', a: [10, 0], m: [0, 10], b: [-10, 0] }], 'a', 'a2', [7.07, 7.07])! as any[];
    assert.ok(Math.hypot(out[0].b[0] - 7.0710678, out[0].b[1] - 7.0710678) < 1e-3 && out[1].a === out[0].b);
    assert.ok(Math.abs(Math.hypot(...(out[0].m as [number, number])) - 10) < 1e-9 && out[0].m[1] > 0);
  }],
  ['fillet two separate lines picked by halves', () => {
    const es: SketchEntity[] = [{ id: 'h', kind: 'line', a: [0, 0], b: [10, 0] }, { id: 'v', kind: 'line', a: [20, 5], b: [20, 15] }];
    const out = filletEnds(es, { id: 'h', at: [8, 0] }, { id: 'v', at: [20, 7] }, 3)!;
    assert.equal(kinds(out), 'arc,line,line');
    const horizontal = out.find(e => e.id === 'h') as any;
    assert.ok(Math.abs(horizontal.b[0] - 17) < 1e-6, `h ends at ${horizontal.b}`);
  }],
  ['chain: a square of four lines is found and closed', () => {
    const sq: SketchEntity[] = [{ id: '1', kind: 'line', a: [0, 0], b: [10, 0] }, { id: '2', kind: 'line', a: [10, 10], b: [10, 0] }, { id: '3', kind: 'line', a: [10, 10], b: [0, 10] }, { id: '4', kind: 'line', a: [0, 10], b: [0, 0] }];
    const chain = connectedChain(sq, '3')!;
    assert.equal(chain.links.length, 4);
    assert.ok(chain.closed);
  }],
  ['offset a closed chain outward stays closed', () => {
    const sq: SketchEntity[] = [{ id: '1', kind: 'line', a: [0, 0], b: [10, 0] }, { id: '2', kind: 'line', a: [10, 10], b: [10, 0] }, { id: '3', kind: 'line', a: [10, 10], b: [0, 10] }, { id: '4', kind: 'line', a: [0, 10], b: [0, 0] }];
    const out = offsetChain(sq, '1', 1)!;
    const regions = arrangement(out.slice(4)).regions;
    assert.equal(regions.length, 1);
    assert.ok(Math.abs(regions[0].area - 144) < 1e-6, `area ${regions[0].area}`);
  }],
  ['offset a rounded chain (line–arc–line) inward', () => {
    // U shape closed: bottom line, right arc, top line, left line.
    const es: SketchEntity[] = [
      { id: 'b', kind: 'line', a: [0, 0], b: [10, 0] },
      { id: 'r', kind: 'arc', a: [10, 0], m: [15, 5], b: [10, 10] },
      { id: 't', kind: 'line', a: [10, 10], b: [0, 10] },
      { id: 'l', kind: 'line', a: [0, 10], b: [0, 0] }
    ];
    const out = offsetChain(es, 't', -1)!;
    const regions = arrangement(out.slice(4)).regions;
    assert.equal(regions.length, 1);
    const expect = 9 * 8 + (Math.PI * 16) / 2; // 9 x 8 box + half disc of radius 4
    assert.ok(Math.abs(regions[0].area - expect) < 0.05, `area ${regions[0].area} vs ${expect}`);
  }],
  ['mirror a rect keeps size', () => {
    const mirrored = transformEntity({ id: 'r', kind: 'rect', center: [10, 0], w: 4, h: 2, rotation: 0 }, mirrorXf([0, -1], [0, 1]), true) as any;
    assert.ok(Math.abs(mirrored.center[0] + 10) < 1e-9 && Math.abs(mirrored.w - 4) < 1e-9);
  }]
];

let count = 0;
const nid = () => `n${++count}`;
checks.push(
  ['split a rectangle side: it comes apart into lines, that side in two', () => {
    const es: SketchEntity[] = [{ id: 'r', kind: 'rect', center: [0, 0], w: 20, h: 10, rotation: 0 }];
    const out = splitAny(es, 'r', [3, 5.2], 1, false, nid)!;
    assert.equal(kinds(out.entities), 'line,line,line,line,line');
    assert.equal(arrangement(out.entities).regions.length, 1);
  }],
  ['split a circle where the grid crosses it: two half circles', () => {
    const es: SketchEntity[] = [{ id: 'c', kind: 'circle', center: [0.3, 0.2], radius: 5 }];
    const out = splitAny(es, 'c', [5.1, 1.4], 1, false, nid)!;
    assert.equal(kinds(out.entities), 'arc,arc');
    const a = out.entities[0] as any;
    // On a grid line (x or y a whole number).
    assert.ok([a.a[0], a.a[1]].some((value: number) => Math.abs(value - Math.round(value)) < 1e-6), JSON.stringify(a.a));
    assert.equal(arrangement(out.entities).regions.length, 1);
  }],
  ['split an open spline and open a closed one', () => {
    const open: SketchEntity = { id: 's', kind: 'spline', points: [[0, 0], [10, 5], [20, 0], [30, 5]], closed: false, mode: 'fit' };
    const openSplit = splitAny([open], 's', [14.8, 3], 1, false, nid)!;
    assert.equal(openSplit.entities.length, 2);
    const ring: SketchEntity = { id: 'k', kind: 'spline', points: [[0, 0], [10, 0], [10, 10], [0, 10]], closed: true, mode: 'fit' };
    const ringSplit = splitAny([ring], 'k', [5, -0.4], 1, false, nid)!;
    assert.equal(ringSplit.entities.length, 1);
    assert.equal((ringSplit.entities[0] as any).closed, false);
  }],
  ['control-point spline starts and ends on its first and last points', () => {
    const pts = splinePoints([[0, 0], [10, 10], [20, -5], [30, 0]], false, 'control');
    assert.deepEqual(pts[0], [0, 0]);
    assert.deepEqual(pts[pts.length - 1], [30, 0]);
  }]
);

let failed = 0;
for (const [name, fn] of checks) {
  try {
    fn();
    console.log('ok  ', name);
  } catch (e) {
    failed++;
    console.log('FAIL', name, '-', (e as Error).message);
  }
}
process.exit(failed ? 1 : 0);
