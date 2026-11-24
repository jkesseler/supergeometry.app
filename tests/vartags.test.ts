// Run: npx tsx tests/vartags.test.ts - variable tags in the view: each sits
// where its variable acts on the model as it is now (the desk lamp built by
// hand: arms turned at their joints), with its kind (length / angle / number).
import { readFileSync } from 'node:fs';
import opencascade from 'replicad-opencascadejs';
import { setOC } from 'replicad';
import { regenerate } from '../src/kernel/engine';
import { resolveDoc } from '../src/doc/params';
import { kindOfVariable, madeFrom, namesIn, usesOf, variableTags } from '../src/doc/varAnchors';
import type { ProjectDoc, Vec3 } from '../src/doc/types';

setOC(await (opencascade as unknown as () => Promise<any>)());
let failed = 0;
const check = (name: string, ok: boolean, info = '') => {
  if (!ok) {
    failed++;
  }
  console.log(ok ? 'ok  ' : 'FAIL', name, info);
};
const f3 = (point: Vec3 | null) => (point ? point.map(x => x.toFixed(1)).join(', ') : 'none');

check('names in a formula, not units', JSON.stringify(namesIn('2*kR + 3 mm - (p1)mm')) === '["kR","p1"]' && JSON.stringify(namesIn('mm + 4')) === '["mm"]', JSON.stringify(namesIn('2*kR + 3 mm - (p1)mm')));

const doc = JSON.parse(readFileSync(new URL('./fixtures/desklamp-hand.json', import.meta.url), 'utf8')) as ProjectDoc;
resolveDoc(doc);
const result = await regenerate(doc.features as any);
const tags = variableTags(doc.variables, doc.features, result);
const tag = (name: string) => tags.find(t => t.name === name)!;
const box = (id: string) => {
  const b = result.bodies.find(body => body.id === id)!;
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < b.positions.length; i += 3) {
    for (let axis = 0; axis < 3; axis++) {
      (lo[axis] = Math.min(lo[axis], b.positions[i + axis])), (hi[axis] = Math.max(hi[axis], b.positions[i + axis]));
    }
  }

  return { lo, hi };
};
const inside = (point: Vec3 | null, id: string, pad = 2) => {
  if (!point) {
    return false;
  }
  const { lo, hi } = box(id);

  return point.every((x, axis) => x > lo[axis] - pad && x < hi[axis] + pad);
};
const arm1 = 'extrude-mw6zldl8-77ke';
const arm2 = 'extrude-mw6zp54w-vwb2';
const head = 'transform-mw6zpz65-gpm1:extrude-mw6zpv4o-7q9b:0';
const base = 'extrude-mw6z9bsk-dfvp';

check('arm1: on the lower arm, turned up at its joint', inside(tag('arm1').at, arm1), f3(tag('arm1').at));
check('arm2: on the upper arm, turned twice', inside(tag('arm2').at, arm2), f3(tag('arm2').at));
check('shadeL: on the shade (turned three times, and the swivel)', inside(tag('shadeL').at, head), f3(tag('shadeL').at));
check('baseH: on the base', inside(tag('baseH').at, base), f3(tag('baseH').at));
check("baseR: on the base's rim", inside(tag('baseR').at, base), f3(tag('baseR').at));
check("p1 and a1: at the lower joint (the turn's pivot), on the arm's end", inside(tag('p1').at, arm1) && inside(tag('a1').at, arm1), f3(tag('p1').at));
check("p2 and p3: at the elbow and the head's joint, on the upper arm", inside(tag('p2').at, arm2) && inside(tag('p3').at, arm2), `${f3(tag('p2').at)} / ${f3(tag('p3').at)}`);
const segLen = (mark: Vec3[]) => Math.hypot(mark[1][0] - mark[0][0], mark[1][1] - mark[0][1], mark[1][2] - mark[0][2]);
const valueOf = (name: string) => Number(/[\d.]+/.exec(doc.variables.find(variable => variable.name === name)!.expr)![0]);
check("baseR's mark: the base's radius (2*baseR on its diameter), from its centre", tag('baseR').marks.length === 1 && Math.abs(segLen(tag('baseR').marks[0]) - valueOf('baseR')) < 1e-6 && Math.hypot(...tag('baseR').marks[0][0]) < 1e-6, JSON.stringify(tag('baseR').marks.map(segLen)));
check("arm1: one line, as long as arm1, along the turned arm (not both sides, not the formulas it's in)", tag('arm1').marks.length === 1 && Math.abs(segLen(tag('arm1').marks[0]) - valueOf('arm1')) < 1e-6 && tag('arm1').marks[0].every(point => inside(point, arm1)), JSON.stringify(tag('arm1').marks.map(segLen)));
check('one thing marked per variable (an angle: its arc and two arms)', tags.every(t => t.marks.length === (t.kind === 'angle' ? 3 : 1)), tags.map(t => `${t.name}:${t.marks.length}`).join(' '));
check('made from arm1: p2 (and p3 through it, not listed)', JSON.stringify(tag('arm1').to) === '["p2"]' && JSON.stringify(tag('p1').to) === '["p2"]', JSON.stringify(tag('arm1').to));
check("p1's mark: the lower joint's height (from 0 up to the pivot)", tag('p1').marks.some(mark => mark.length === 2 && Math.abs(segLen(mark) - 66) < 1e-6), JSON.stringify(tag('p1').marks.map(segLen)));
check("a1's mark: an arc round the joint with its two arms", tag('a1').marks.length === 3 && tag('a1').marks[1].length > 3);
check("baseH's mark: the base's height", tag('baseH').marks.some(mark => Math.abs(segLen(mark) - 16) < 1e-6));
check('every variable of the lamp has a spot', tags.every(t => t.at), tags.filter(t => !t.at).map(t => t.name).join(', '));

const uses = usesOf(doc.features);
const kinds = Object.fromEntries(doc.variables.map(variable => [variable.name, kindOfVariable(variable.name, doc.variables, uses)]));
check("kinds: lengths, and the turns' angles (typed as plain numbers)", ['baseR', 'arm1', 'p1', 'p3', 'kR', 'shadeR'].every(name => kinds[name] === 'length') && ['a1', 'a2', 'a3', 'swivel'].every(name => kinds[name] === 'angle'), JSON.stringify(kinds));
check('kinds: not used, a formula of lengths is a length; a plain number, a number', kindOfVariable('w2', [{ name: 'w', expr: '3 mm' }, { name: 'w2', expr: 'w * 2' }], new Map()) === 'length' && kindOfVariable('n', [{ name: 'n', expr: '4' }], new Map()) === 'number');
check('made from: p2 = p1 + arm1', JSON.stringify(madeFrom('p2', doc.variables)) === '["p1","arm1"]');

// Turned another way: the tags follow.
const turned = structuredClone(doc);
turned.variables = turned.variables.map(variable => (variable.name === 'a1' ? { ...variable, expr: '60' } : variable.name === 'swivel' ? { ...variable, expr: '-40' } : variable));
resolveDoc(turned);
const r2 = await regenerate(turned.features as any);
const t2 = variableTags(turned.variables, turned.features, r2);
const box2 = (id: string) => {
  const b = r2.bodies.find(body => body.id === id)!;
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < b.positions.length; i += 3) {
    for (let axis = 0; axis < 3; axis++) {
      (lo[axis] = Math.min(lo[axis], b.positions[i + axis])), (hi[axis] = Math.max(hi[axis], b.positions[i + axis]));
    }
  }

  return { lo, hi };
};
const in2 = (name: string, id: string) => {
  const at = t2.find(t => t.name === name)!.at;
  const { lo, hi } = box2(id);

  return !!at && at.every((x, axis) => x > lo[axis] - 2 && x < hi[axis] + 2);
};
check('lower arm raised, lamp swivelled: arm1, arm2 and shadeL still on their parts', in2('arm1', arm1) && in2('arm2', arm2) && in2('shadeL', head), f3(t2.find(t => t.name === 'shadeL')!.at));

console.log(failed ? `${failed} FAILED` : 'all passed');
process.exit(failed ? 1 : 0);
