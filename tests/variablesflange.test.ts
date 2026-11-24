// Run: npx tsx tests/variablesflange.test.ts
// A pipe flange built by hand in the app, every size of it a variable (outer size, bore, thickness, hub, bolt
// holes and how many, the chamfer). Each variable changed - alone, several at once, to awkward values and back - and
// the whole of it has to follow: its volume is what the formula gives, to the hundredth of a cubic millimetre.
import { readFileSync } from 'node:fs';
import { resolveDoc } from '../src/doc/params';
import { keepSizes } from '../src/doc/unitChange';
import { after, bodies, check, done, health, near, volume } from './kit';
import type { Feature, ProjectDoc, Units } from '../src/doc/types';
import type { Shape3D } from 'replicad';

const fresh = () => JSON.parse(readFileSync(new URL('./fixtures/flange-variables.json', import.meta.url), 'utf8')) as ProjectDoc;
type V = { od: number; bore: number; thick: number; wall: number; hubH: number; n: number; boltD: number; cham: number };
/** The flange's volume: the disc, the hub, the bore through both, n bolt holes, the chamfer round the top. */
const formula = (v: V) => {
  const hubD = v.bore + 2 * v.wall;

  return (Math.PI / 4) * ((v.od ** 2 - v.bore ** 2) * v.thick + (hubD ** 2 - v.bore ** 2) * v.hubH - v.n * v.boltD ** 2 * v.thick) - Math.PI * v.cham ** 2 * (v.od / 2 - v.cham / 3);
};

let doc = fresh();
const now: V = { od: 160, bore: 40, thick: 20, wall: 10, hubH: 45, n: 6, boltD: 13, cham: 3 };
const put = (name: string, expr: string) => (doc.variables.find(v => v.name === name)!.expr = expr);

async function built(): Promise<{ vol: number; sound: boolean; count: number; errors: string[]; problems: string[] }> {
  const problems = resolveDoc(doc);
  const { errors } = await after(doc.features as Feature[]);
  const all = [...bodies().values()] as Shape3D[];

  return { vol: all.reduce((s, b) => s + volume(b), 0), sound: all.every(b => health(b).healthy), count: all.length, errors, problems };
}

async function expect(name: string, change: Partial<Record<keyof V, string>>, values: Partial<V>): Promise<void> {
  for (const [k, e] of Object.entries(change)) {
    put(k, e as string);
  }
  Object.assign(now, values);
  const t = performance.now();
  const r = await built();
  const want = formula(now);
  check(name, near(r.vol, want, 0.02) && r.sound && r.count === 1 && !r.errors.length && !r.problems.length, `${r.vol.toFixed(2)} mm³ (the formula: ${want.toFixed(2)}), ${Math.round(performance.now() - t)} ms${r.errors.length ? ' ' + r.errors.join('; ') : ''}${r.problems.length ? ' ' + r.problems.join('; ') : ''}`);
}

await expect('as it was built', {}, {});
await expect('eight bolt holes', { n: '8' }, { n: 8 });
await expect('three', { n: '3' }, { n: 3 });
await expect('twelve', { n: '12' }, { n: 12 });
await expect('a bigger flange: the bolt circle goes out with it', { od: '220 mm' }, { od: 220 });
await expect('thicker: the hub rides up, the bore and the holes still go through', { thick: '32 mm' }, { thick: 32 });
await expect('a smaller bore: the hub follows it', { bore: '25 mm' }, { bore: 25 });
await expect('a thicker hub wall', { wall: '18 mm' }, { wall: 18 });
await expect('a short hub, small bolts, a small chamfer', { hubH: '6 mm', boltD: '6.5 mm', cham: '0.5 mm' }, { hubH: 6, boltD: 6.5, cham: 0.5 });
await expect('everything at once', { od: '300 mm', bore: '110 mm', thick: '24 mm', wall: '14 mm', hubH: '60 mm', n: '16', boltD: '18 mm', cham: '4 mm' }, { od: 300, bore: 110, thick: 24, wall: 14, hubH: 60, n: 16, boltD: 18, cham: 4 });
// A value given as a formula of the others, and in another unit.
await expect('the thickness a quarter of the bore; the bolts half an inch', { thick: 'bore / 4 - 2 mm', boltD: '0.5 in' }, { thick: 110 / 4 - 2, boltD: 12.7 });
await expect('the count worked out: as many as fit 45 apart round the bolt circle', { n: 'floor(pi * pcd / 45 mm)' }, { n: Math.floor((Math.PI * ((300 + 110 + 28) / 2)) / 45) });
// Awkward values, then back: nothing is left broken.
put('n', '0');
let r = await built();
check('no holes at all (0): it says so at the pattern, and nothing else', r.errors.length === 1 && /count/i.test(r.errors[0]), r.errors);
put('bore', '400 mm');
put('n', '6');
r = await built();
check('a bore bigger than the flange: still a sound body, no crash', r.count >= 1 && r.sound, `${r.count} bodies, ${r.errors.join('; ')}`);
await expect('and back: as the formula says again', { bore: '110 mm', n: '16', thick: '24 mm', boltD: '18 mm' }, { bore: 110, n: 16, thick: 24, boltD: 18 });

// The project's unit changed: nothing changes size, in any unit and back.
doc = fresh();
Object.assign(now, { od: 160, bore: 40, thick: 20, wall: 10, hubH: 45, n: 6, boltD: 13, cham: 3 });
for (const v of doc.variables) {
  v.expr = v.expr.replace(/^(\d+(?:\.\d+)?) mm$/, '$1');
}
put('wall', '10 mm');
let unit: Units = 'mm';
for (const to of ['in', 'cm', 'mm'] as Units[]) {
  const k = keepSizes(doc, unit, to);
  doc.units = unit = to;
  await expect(`the unit changed to ${to}: the same flange`, {}, {});
  check('  (no formula lost; n still a plain 6)', !k.lost && doc.variables.find(v => v.name === 'n')!.expr === '6', doc.variables.map(v => `${v.name}=${v.expr}`).join(', '));
}
// And a size typed in the new unit is in that unit.
doc.units = 'in';
await expect('in inches, a plain 8 typed for the flange is 8 inches', { od: '8' }, { od: 203.2 });
doc.units = 'mm';
done();
