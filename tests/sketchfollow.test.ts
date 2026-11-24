// Run: npx tsx tests/sketchfollow.test.ts
// What is made from a sketch's curves follows them: an offset is still the offset, a mirrored copy still the mirror
// image, after the original is given another size (a dimension, a variable); and a curve projected into a later
// sketch is put where the earlier sketch has it now. Changed in History, everything after keeps up.
import { resolveDoc } from '../src/doc/params';
import { solve } from '../src/sketch/constraints';
import { carryConstraints, mirrorXf, offsetChain, offsetEntity, transformEntity, trim } from '../src/sketch/edit';
import { arcFrom3 } from '../src/sketch/curves';
import type { ProjectDoc, SketchConstraint, SketchEntity, SketchFeature, Vec2 } from '../src/doc/types';

let failed = 0;
const check = (name: string, ok: boolean, info: unknown = '') => {
  if (!ok) {
    failed++;
  }
  console.log(ok ? 'ok  ' : 'FAIL', name, info);
};
const near = (a: number, b: number, tol = 1e-6) => Math.abs(a - b) <= tol;
const pt = (a: Vec2, b: Vec2, tol = 1e-6) => near(a[0], b[0], tol) && near(a[1], b[1], tol);
type E<K extends SketchEntity['kind']> = Extract<SketchEntity, { kind: K }>;
const follow = (src: string, copy: string, how: SketchConstraint['how']): SketchConstraint => ({ id: `f-${src}-${copy}`, type: 'follow', curves: [src, copy], how });
const get = <K extends SketchEntity['kind']>(es: SketchEntity[], id: string) => es.find(e => e.id === id) as E<K>;

// ---- a line and its offset: the line made longer by its dimension, the offset is longer too
{
  const a: SketchEntity = { id: 'a', kind: 'line', a: [0, 0], b: [40, 0] };
  const offsetLine = { ...offsetEntity(a, 5)!, id: 'o' };
  const cs: SketchConstraint[] = [follow('a', 'o', { offset: 5 }), { id: 'len', type: 'dim', curves: ['a'], prop: 'length', value: 70 }, { id: 'pin', type: 'fix', pts: [{ e: 'a', p: 'a' }], at: [0, 0] }, { id: 'h', type: 'horizontal', curves: ['a'] }];
  const solution = solve([a, offsetLine], cs);
  const [original, offset] = [get<'line'>(solution.entities, 'a'), get<'line'>(solution.entities, 'o')];
  check('a line 40 long with its offset, made 70 by its dimension: the offset is 70 too, 5 away, end for end', solution.ok && pt(original.b, [70, 0]) && pt(offset.a, [0, 5]) && pt(offset.b, [70, 5]), JSON.stringify([original.a, original.b, offset.a, offset.b]));
}
// ---- a circle and its offset; a rectangle and its offset
{
  const sketchEntity: SketchEntity = { id: 'c', kind: 'circle', center: [10, 10], radius: 8 };
  const offsetCircle = { ...offsetEntity(sketchEntity, 3)!, id: 'o' };
  const solution = solve([sketchEntity, offsetCircle], [follow('c', 'o', { offset: 3 }), { id: 'd', type: 'dim', curves: ['c'], prop: 'diameter', value: 30 }, { id: 'pin', type: 'fix', pts: [{ e: 'c', p: 'c' }], at: [25, -5] }]);
  const offset = get<'circle'>(solution.entities, 'o');
  check('a circle made 30 across and moved: its offset is 18 in radius, about the same middle', solution.ok && near(offset.radius, 18) && pt(offset.center, [25, -5]), `${offset.radius} ${offset.center}`);
  const q: SketchEntity = { id: 'q', kind: 'rect', center: [0, 0], w: 40, h: 20, rotation: 0 };
  const qo = { ...offsetEntity(q, -4)!, id: 'qo' };
  const r2 = solve([q, qo], [follow('q', 'qo', { offset: -4 }), { id: 'w', type: 'dim', curves: ['q'], prop: 'w', value: 100 }, { id: 'h', type: 'dim', curves: ['q'], prop: 'h', value: 50 }]);
  const offsetRect = get<'rect'>(r2.entities, 'qo');
  check('a rectangle made 100 x 50: its offset 4 inside is 92 x 42', r2.ok && near(offsetRect.w, 92) && near(offsetRect.h, 42), `${offsetRect.w} x ${offsetRect.h}`);
}
// ---- an arc and its offset
{
  const a: SketchEntity = { id: 'a', kind: 'arc', a: [10, 0], m: [0, 10], b: [-10, 0] };
  const offsetArc = { ...offsetEntity(a, 2)!, id: 'o' };
  const solution = solve([a, offsetArc], [follow('a', 'o', { offset: 2 }), { id: 'rad', type: 'dim', curves: ['a'], prop: 'radius', value: 25 }]);
  const [originalArc, offsetCircle] = [arcFrom3(...(['a', 'm', 'b'] as const).map(key => get<'arc'>(solution.entities, 'a')[key]) as [Vec2, Vec2, Vec2])!, arcFrom3(...(['a', 'm', 'b'] as const).map(key => get<'arc'>(solution.entities, 'o')[key]) as [Vec2, Vec2, Vec2])!];
  check('an arc made 25 in radius: its offset is 27, about the same centre', solution.ok && near(originalArc.r, 25, 1e-5) && near(offsetCircle.r, 27, 1e-5) && pt(originalArc.c, offsetCircle.c, 1e-5), `${originalArc.r} ${offsetCircle.r}`);
}
// ---- a closed outline of four lines and its offset outline: the outline resized, the offset is still 3 outside it all round
{
  const corners: Vec2[] = [[0, 0], [40, 0], [40, 20], [0, 20]];
  const lines: SketchEntity[] = corners.map((point, i) => ({ id: `l${i}`, kind: 'line', a: point, b: corners[(i + 1) % 4] }) as SketchEntity);
  const all = offsetChain(lines, 'l0', 3)!;
  const made = all.slice(lines.length).map((e, i) => ({ ...e, id: `o${i}` }));
  const joins: SketchConstraint[] = [0, 1, 2, 3].flatMap(i => [
    { id: `j${i}`, type: 'coincident', pts: [{ e: `l${i}`, p: 'b' }, { e: `l${(i + 1) % 4}`, p: 'a' }] } as SketchConstraint,
    { id: `k${i}`, type: 'coincident', pts: [{ e: `o${i}`, p: 'b' }, { e: `o${(i + 1) % 4}`, p: 'a' }] } as SketchConstraint
  ]);
  // Which original each piece is the offset of, and which way: found as the app finds it (by where it lies).
  const links: SketchConstraint[] = [];
  for (const piece of made as E<'line'>[]) {
    for (const line of lines as E<'line'>[]) {
      for (const distance of [3, -3]) {
        const offsetLine = offsetEntity(line, distance) as E<'line'>;
        const mid: Vec2 = [(piece.a[0] + piece.b[0]) / 2, (piece.a[1] + piece.b[1]) / 2];
        const off = Math.abs((mid[0] - offsetLine.a[0]) * (offsetLine.b[1] - offsetLine.a[1]) - (mid[1] - offsetLine.a[1]) * (offsetLine.b[0] - offsetLine.a[0])) / Math.hypot(offsetLine.b[0] - offsetLine.a[0], offsetLine.b[1] - offsetLine.a[1]);
        const par = Math.abs((piece.b[0] - piece.a[0]) * (offsetLine.b[1] - offsetLine.a[1]) - (piece.b[1] - piece.a[1]) * (offsetLine.b[0] - offsetLine.a[0]));
        if (off < 1e-6 && par < 1e-6 && !links.some(link => link.curves![1] === piece.id)) {
          links.push(follow(line.id, piece.id, { offset: distance, loose: true }));
        }
      }
    }
  }
  check('each piece of the offset outline is found to be the offset of one side', links.length === 4, links.map(link => link.curves!.join('>') + ':' + link.how!.offset).join(' '));
  const sized: SketchConstraint[] = [
    { id: 'w', type: 'dim', curves: ['l0'], prop: 'length', value: 90 },
    { id: 'hh', type: 'dim', curves: ['l1'], prop: 'length', value: 35 },
    { id: 'h0', type: 'horizontal', curves: ['l0'] },
    { id: 'v1', type: 'vertical', curves: ['l1'] },
    { id: 'h2', type: 'horizontal', curves: ['l2'] },
    { id: 'v3', type: 'vertical', curves: ['l3'] },
    { id: 'pin', type: 'fix', pts: [{ e: 'l0', p: 'a' }], at: [0, 0] }
  ];
  const solution = solve([...lines, ...made], [...joins, ...links, ...sized]);
  const xs = (solution.entities.filter(e => e.id.startsWith('o')) as E<'line'>[]).flatMap(e => [e.a, e.b]);
  const box = [Math.min(...xs.map(point => point[0])), Math.min(...xs.map(point => point[1])), Math.max(...xs.map(point => point[0])), Math.max(...xs.map(point => point[1]))];
  check('the outline made 90 x 35: its offset outline is 96 x 41, 3 outside it all round, still closed', solution.ok && [-3, -3, 93, 38].every((value, i) => near(box[i], value, 1e-5)), box.map(value => value.toFixed(4)).join());
}
// ---- a mirrored copy: the original moved and resized, the copy is its mirror image still
{
  const line: [Vec2, Vec2] = [[0, -50], [0, 50]];
  const sketchEntity: SketchEntity = { id: 'c', kind: 'circle', center: [20, 5], radius: 6 };
  const lineEntity: SketchEntity = { id: 'l', kind: 'line', a: [10, 0], b: [30, 15] };
  const mc = { ...transformEntity(sketchEntity, mirrorXf(...line)), id: 'mc' };
  const ml = { ...transformEntity(lineEntity, mirrorXf(...line)), id: 'ml' };
  const solution = solve([sketchEntity, lineEntity, mc, ml], [follow('c', 'mc', { mirror: line }), follow('l', 'ml', { mirror: line }), { id: 'd', type: 'dim', curves: ['c'], prop: 'radius', value: 11 }, { id: 'pin', type: 'fix', pts: [{ e: 'c', p: 'c' }], at: [33, -8] }, { id: 'pa', type: 'fix', pts: [{ e: 'l', p: 'a' }], at: [12, 4] }, { id: 'pb', type: 'fix', pts: [{ e: 'l', p: 'b' }], at: [40, 9] }]);
  const [MC, ML] = [get<'circle'>(solution.entities, 'mc'), get<'line'>(solution.entities, 'ml')];
  check('a mirrored circle and line, the originals moved and resized: the copies are their mirror images', solution.ok && pt(MC.center, [-33, -8]) && near(MC.radius, 11) && pt(ML.a, [-12, 4]) && pt(ML.b, [-40, 9]), JSON.stringify([MC.center, MC.radius, ML.a, ML.b]));
}
// ---- an offset trimmed afterwards is its own curve: it isn't pulled back to its whole length
{
  const a: SketchEntity = { id: 'a', kind: 'line', a: [0, 0], b: [40, 0] };
  const offsetLine = { ...offsetEntity(a, 5)!, id: 'o' };
  const cross: SketchEntity = { id: 'x', kind: 'line', a: [20, 2], b: [20, 9] };
  const cs = [follow('a', 'o', { offset: 5 })];
  const before = [a, offsetLine, cross];
  const after = trim(before, 'o', [30, 5]);
  const kept = carryConstraints(before, after, cs);
  check('the offset trimmed at a crossing line: its link is let go (it would stretch it back)', kept.length === 0 && after.some(e => e.kind === 'line' && near(Math.hypot(e.b[0] - e.a[0], e.b[1] - e.a[1]), 20)), `${kept.length} links, ${after.length} curves`);
  const untouched = carryConstraints(before, trim(before, 'x', [20, 7]), cs);
  check("another curve trimmed: the offset's link stays", untouched.length === 1);
}
// ---- a second sketch with curves projected from the first: the first changed, the second follows
{
  const XY = { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, 0, 1] };
  const UP = { origin: [5, 0, 30], xDir: [1, 0, 0], normal: [0, 0, 1] };
  const doc = {
    format: 'super', version: 2, name: 't', units: 'mm', variables: [{ name: 'W', expr: '40 mm' }], views: [], hidden: [], pins: [], names: {},
    features: [
      { id: 'S1', name: 'Sketch 01', type: 'sketch', plane: XY, entities: [{ id: 'r', kind: 'rect', center: [0, 0], w: 40, h: 20, rotation: 0 }, { id: 'c', kind: 'circle', center: [10, 0], radius: 4 }], constraints: [{ id: 'w', type: 'dim', curves: ['r'], prop: 'w', value: 40, expr: 'W' }, { id: 'pin', type: 'fix', pts: [{ e: 'r', p: 'c' }], at: [0, 0] }] },
      { id: 'S2', name: 'Sketch 02', type: 'sketch', plane: UP, entities: [{ id: 'pr', kind: 'rect', center: [-5, 0], w: 40, h: 20, rotation: 0 }, { id: 'po', kind: 'rect', center: [-5, 0], w: 46, h: 26, rotation: 0 }, { id: 'own', kind: 'line', a: [0, 30], b: [10, 30] }], refs: [{ id: 'pr', sketch: 'S1', entity: 'r' }], constraints: [follow('pr', 'po', { offset: 3 })] }
    ]
  } as unknown as ProjectDoc;
  const s2 = () => (doc.features[1] as SketchFeature).entities;
  let problems = resolveDoc(doc);
  check('as made: nothing changes', !problems.length && near(get<'rect'>(s2(), 'pr').w, 40) && near(get<'rect'>(s2(), 'po').w, 46), problems.join());
  doc.variables[0].expr = '100 mm';
  problems = resolveDoc(doc);
  const [PR, PO] = [get<'rect'>(s2(), 'pr'), get<'rect'>(s2(), 'po')];
  check("the first sketch's width made 100 by its variable: the projected rectangle in the second is 100, and its offset 106", !problems.length && near(PR.w, 100) && pt(PR.center, [-5, 0]) && near(PO.w, 106) && near(PO.h, 26), `${PR.w} ${PO.w} x ${PO.h} ${problems.join()}`);
  check("  the second sketch's own line is where it was", pt(get<'line'>(s2(), 'own').a, [0, 30]) && pt(get<'line'>(s2(), 'own').b, [10, 30]));
  const same = s2();
  resolveDoc(doc);
  check('resolved again with nothing changed: the very same curves', s2() === same);
  // The source curve deleted from the first sketch: the projected one stays as it is.
  (doc.features[0] as SketchFeature).entities = (doc.features[0] as SketchFeature).entities.filter(e => e.id !== 'r');
  (doc.features[0] as SketchFeature).constraints = [];
  problems = resolveDoc(doc);
  check('its original deleted from the first sketch: it stays as it was', !problems.length && near(get<'rect'>(s2(), 'pr').w, 100));
}
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
