// Run: npx tsx tests/sketchrepeat.test.ts
// A sketch pattern whose count is a variable: the copies are made again when the variable comes to another number,
// each where it belongs and tied to its original. And a fill pattern follows its shape when a variable resizes it.
import { resolveDoc } from '../src/doc/params';
import { renameVariable } from '../src/doc/renameVariable';
import { fillOf, refill } from '../src/sketch/fill';
import { arrangement, regionRef } from '../src/sketch/regions';
import { after, bodies, check, done, health, near, volume } from './kit';
import type { Feature, ProjectDoc, SketchEntity, SketchFeature, SketchFill, Vec2 } from '../src/doc/types';
import type { Shape3D } from 'replicad';

const XY = { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, 0, 1] };
const base = (features: unknown[], variables: { name: string; expr: string }[]): ProjectDoc => ({ format: 'super', version: 2, name: 't', units: 'mm', variables, features, views: [], hidden: [], pins: [], names: {} }) as unknown as ProjectDoc;
const sk = (doc: ProjectDoc) => doc.features[0] as SketchFeature;
const circles = (doc: ProjectDoc) => sk(doc).entities.filter(e => e.kind === 'circle' && e.id !== 'plate') as Extract<SketchEntity, { kind: 'circle' }>[];
const put = (doc: ProjectDoc, name: string, expr: string) => (doc.variables.find(v => v.name === name)!.expr = expr);

// ---- round a circle: n holes on a 20 mm circle
{
  const doc = base(
    [{ id: 'S', name: 'Sketch 01', type: 'sketch', plane: XY, entities: [{ id: 'plate', kind: 'circle', center: [0, 0], radius: 30 }, { id: 'h', kind: 'circle', center: [20, 0], radius: 3 }], repeats: [{ id: 'r1', src: ['h'], kind: 'circular', count: 1, countExpr: 'n', at: [0, 0], angle: 360 }] }],
    [{ name: 'n', expr: '4' }]
  );
  let problems = resolveDoc(doc);
  const at = () => circles(doc).map(c => `${Math.round((Math.atan2(c.center[1], c.center[0]) * 180) / Math.PI + 360) % 360}@${Math.hypot(c.center[0], c.center[1]).toFixed(3)}`).sort().join(' ');
  check('n = 4: four holes, a quarter turn apart, all 20 from the middle', !problems.length && circles(doc).length === 4 && at() === ['0@20.000', '180@20.000', '270@20.000', '90@20.000'].sort().join(' '), `${at()} ${problems.join()}`);
  check('  each copy tied to the original', (sk(doc).constraints ?? []).filter(c => c.type === 'pattern' && c.curves?.[0] === 'h').length === 3);
  put(doc, 'n', '6');
  problems = resolveDoc(doc);
  check('n = 6: six holes, 60 degrees apart', !problems.length && circles(doc).length === 6 && at() === ['0@20.000', '60@20.000', '120@20.000', '180@20.000', '240@20.000', '300@20.000'].sort().join(' ') && (sk(doc).constraints ?? []).length === 5, at());
  put(doc, 'n', '2');
  resolveDoc(doc);
  check('n = 2: two, opposite', circles(doc).length === 2 && at() === ['0@20.000', '180@20.000'].sort().join(' ') && (sk(doc).constraints ?? []).length === 1, at());
  put(doc, 'n', '1');
  resolveDoc(doc);
  check('n = 1: the original alone', circles(doc).length === 1 && !(sk(doc).constraints ?? []).length);
  put(doc, 'n', '0');
  problems = resolveDoc(doc);
  check('n = 0: said in plain words, the sketch left as it was', problems.length === 1 && /at least 1/.test(problems[0]) && circles(doc).length === 1, problems.join());
  put(doc, 'n', '8');
  resolveDoc(doc);
  // The original held further out: the copies follow it (their links), and stay 8.
  sk(doc).constraints = [...(sk(doc).constraints ?? []), { id: 'hold', type: 'fix', pts: [{ e: 'h', p: 'c' }], at: [25, 0] }];
  problems = resolveDoc(doc);
  check('the original held out at 25: all eight are 25 from the middle', !problems.length && circles(doc).length === 8 && circles(doc).every(c => near(Math.hypot(c.center[0], c.center[1]), 25, 1e-6)), at());
  // Built: the plate with its eight holes.
  const regions = arrangement(sk(doc).entities).regions;
  const plate = regions.sort((a, b) => b.area - a.area)[0];
  const ext = { id: 'E', name: 'E', type: 'extrude', source: { kind: 'profile', sketch: 'S', regions: [regionRef(plate)] }, distance: 2, mode: 'new' } as unknown as Feature;
  const r = await after([...(doc.features as Feature[]), ext]);
  const v = [...bodies().values()].reduce((s, b) => s + volume(b as Shape3D), 0);
  check('extruded 2: the disc less eight holes', !r.errors.length && near(v, (Math.PI * 900 - 8 * Math.PI * 9) * 2, 1e-2) && [...bodies().values()].every(b => health(b as Shape3D).healthy), `${v.toFixed(2)} ${r.errors.join('; ')}`);
  // Renamed: the pattern still follows it.
  renameVariable(doc, 'n', 'holes');
  put(doc, 'holes', '3');
  problems = resolveDoc(doc);
  check('the variable renamed, then made 3: three holes', !problems.length && sk(doc).repeats![0].countExpr === 'holes' && circles(doc).length === 3);
}
// ---- in a row, the count worked out from a length
{
  const doc = base(
    [{ id: 'S', name: 'Sketch 01', type: 'sketch', plane: XY, entities: [{ id: 's', kind: 'rect', center: [0, 0], w: 4, h: 10, rotation: 0 }], repeats: [{ id: 'r2', src: ['s'], kind: 'linear', count: 1, countExpr: 'floor(len / 10 mm)', step: [10, 0] }] }],
    [{ name: 'len', expr: '55 mm' }]
  );
  const problems = resolveDoc(doc);
  const xs = () => sk(doc).entities.map(e => +(e as { center: Vec2 }).center[0].toFixed(6)).sort((a, b) => a - b).join();
  check('as many as fit 10 apart in 55: five slots, at 0, 10, 20, 30, 40', !problems.length && xs() === '0,10,20,30,40', xs());
  put(doc, 'len', '32 mm');
  resolveDoc(doc);
  check('in 32: three', xs() === '0,10,20', xs());
  // Built again without a change: nothing rewritten (no rebuild for nothing).
  const before = JSON.stringify(sk(doc).entities);
  const same = sk(doc).entities;
  resolveDoc(doc);
  check('resolved again with nothing changed: the very same curves', sk(doc).entities === same && JSON.stringify(sk(doc).entities) === before);
}
// ---- a fill pattern follows a shape resized by a variable
{
  const f: SketchFill = { id: 'f1', at: [0, 0], kind: 'lines', spacing: 5, angle: 0, size: 3 };
  const rect = { id: 'r', kind: 'rect', center: [0, 0], w: 40, h: 20, rotation: 0 } as SketchEntity;
  const doc = base(
    [{ id: 'S', name: 'Sketch 01', type: 'sketch', plane: XY, entities: refill([rect], [f]), fills: [f], constraints: [{ id: 'c1', type: 'dim', curves: ['r'], prop: 'h', value: 20, expr: 'H' }, { id: 'c2', type: 'fix', pts: [{ e: 'r', p: 'c' }], at: [0, 0] }] }],
    [{ name: 'H', expr: '20 mm' }]
  );
  const lines = () => sk(doc).entities.filter(e => fillOf(e.id) === 'f1');
  let problems = resolveDoc(doc);
  check('a 40 x 20 rectangle filled with lines 5 apart: three', !problems.length && lines().length === 3, `${lines().length} ${problems.join()}`);
  put(doc, 'H', '42 mm');
  problems = resolveDoc(doc);
  const h = (sk(doc).entities.find(e => e.id === 'r') as { h: number }).h;
  check('its height made 42 by its variable: nine lines now', !problems.length && near(h, 42, 1e-6) && lines().length === 9, `h ${h}, ${lines().length} lines ${problems.join()}`);
  const same = sk(doc).entities;
  resolveDoc(doc);
  check('resolved again with nothing changed: the very same curves', sk(doc).entities === same);
}
done();
