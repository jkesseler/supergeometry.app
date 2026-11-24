// Run: npx tsx tests/renamevariable.test.ts
// A variable renamed: every formula that used it says the new name, and comes to what it came to before - the
// flange built with variables is the very same flange.
import { readFileSync } from 'node:fs';
import { resolveDoc } from '../src/doc/params';
import { nameProblem, renameIn, renameVariable } from '../src/doc/renameVariable';
import { after, bodies, check, done, near, volume } from './kit';
import type { Feature, ProjectDoc } from '../src/doc/types';
import type { Shape3D } from 'replicad';

check('a name alone', renameIn('w', 'w', 'width') === 'width');
check('in a formula, every time', renameIn('w * 2 + sqrt(w) - (w)', 'w', 'width') === 'width * 2 + sqrt(width) - (width)');
check('not inside a longer name', renameIn('w2 + aw + w_in + w', 'w', 'width') === 'w2 + aw + w_in + width');
check("not a unit or a number's e", renameIn('2 mm + m + 1e3 + 2.5e-2 * e', 'e', 'edge') === '2 mm + m + 1e3 + 2.5e-2 * edge' && renameIn('2 mm + m', 'm', 'len') === '2 mm + len');
check('capitals count', renameIn('W + w', 'w', 'x') === 'W + x');
check('with its unit beside it', renameIn('bore/2 + 3mm', 'bore', 'hole') === 'hole/2 + 3mm');

const fresh = () => JSON.parse(readFileSync(new URL('./fixtures/flange-variables.json', import.meta.url), 'utf8')) as ProjectDoc;
const vol = async (doc: ProjectDoc) => {
  const problems = resolveDoc(doc);
  const r = await after(doc.features as Feature[]);

  return { v: [...bodies().values()].reduce((s, b) => s + volume(b as Shape3D), 0), errors: [...r.errors, ...problems] };
};
const base = await vol(fresh());
const doc = fresh();
const text = () => JSON.stringify({ v: doc.variables, f: doc.features.map(f => [f.exprs, (f as { constraints?: unknown }).constraints]) });
const uses = (name: string) => (text().match(new RegExp(`[^A-Za-z0-9_.]${name}[^A-Za-z0-9_]`, 'g')) ?? []).length;
const before = { bore: uses('bore'), n: uses('n'), od: uses('od') };
const changed = [renameVariable(doc, 'bore', 'hole_d'), renameVariable(doc, 'n', 'count'), renameVariable(doc, 'od', 'outer')];
check('three variables renamed: formulas rewritten for each', changed.every(c => c > 0), changed.join());
check('the old names are nowhere, the new ones as often as the old were', uses('bore') === 0 && uses('n') === 0 && uses('od') === 0 && uses('hole_d') === before.bore && uses('count') === before.n && uses('outer') === before.od, `${JSON.stringify(before)} -> ${uses('hole_d')}, ${uses('count')}, ${uses('outer')}`);
const now = await vol(doc);
check('the flange is the same flange', !now.errors.length && near(now.v, base.v, 1e-6), `${now.v.toFixed(3)} for ${base.v.toFixed(3)} ${now.errors.join('; ')}`);
doc.variables.find(v => v.name === 'outer')!.expr = '220 mm';
const big = await vol(doc);
check('and still follows its variables under their new names (the outer size made 220)', !big.errors.length && big.v > base.v * 1.5, big.v.toFixed(1));

check('no such variable: nothing done', renameVariable(doc, 'nothere', 'x') === -1);
check('a name taken is refused', /already/.test(nameProblem(doc, 'count', 'outer') ?? '') && /capitals/.test(nameProblem(doc, 'count', 'Outer') ?? ''));
check('a unit, a function or a bad name is refused', !!nameProblem(doc, 'count', 'mm') && !!nameProblem(doc, 'count', 'sin') && !!nameProblem(doc, 'count', '2x') && !!nameProblem(doc, 'count', 'a b'));
check('its own name in other capitals is allowed', nameProblem(doc, 'count', 'Count') === null && nameProblem(doc, 'count', 'holes') === null);
done();
