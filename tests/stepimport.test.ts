// Run: npx tsx tests/stepimport.test.ts
// STEP files of several solids put in, written the ways other programs write them: in metres, in inches, bodies
// that touch, many bodies, CRLF line ends, a file cut short. Each solid has to come in as a body of its own, the
// right size in millimetres, sound - and each has to be usable afterwards (moved, cut, deleted by itself).
import { exportBodies } from '../src/kernel/engine';
import { after, block, bodies, check, cylinder, done, health, near, volume } from './kit';
import type { Feature } from '../src/doc/types';
import type { Shape3D } from 'replicad';

const text = async (fs: Feature[]) => new TextDecoder().decode(new Uint8Array(await (await exportBodies(fs, 'step')).arrayBuffer()));
const put = (t: string, id = 'In'): Feature => ({ id, name: 'Imported', type: 'import', format: 'step', fileName: 'x.step', data: Buffer.from(t, 'utf8').toString('base64'), apart: true }) as Feature;
const vols = () => [...bodies().values()].map(b => volume(b as Shape3D)).sort((a, b) => a - b);
const sound = () => [...bodies().values()].every(b => health(b as Shape3D).healthy);

// A block (1000), a cylinder (pi * 16 * 8) sunk 2 into it, a block apart, a block touching the first.
const parts = [...block('A', 20, 10, 5), ...cylinder('C', 4, 8, 10, 5, 3), ...block('B', 4, 4, 4, [100, 0, 0]), ...block('T', 6, 10, 5, [13, 0, 0])];
const V = [64, 300, Math.PI * 128, 1000].sort((a, b) => a - b);
const mm = await text(parts);
const MILLI = /SI_UNIT\(\s*\.MILLI\.\s*,\s*\.METRE\.\s*\)/g;
// (Each solid of the file has its own units: all of them changed.)
check('the file: four solids, in millimetres', (mm.match(MILLI) ?? []).length >= 1 && (mm.match(/MANIFOLD_SOLID_BREP/g) ?? []).length === 4, `${mm.length} characters`);

{
  const r = await after([put(mm)]);
  const got = vols();
  check('four solids (two touching, one standing on another): four bodies, each its own size, sound', !r.errors.length && got.length === 4 && got.every((v, i) => near(v, V[i], 1e-3)) && sound(), `${got.map(v => v.toFixed(2))} ${r.errors.join('; ')}`);
  check('  named In, In:1, In:2, In:3', [...bodies().keys()].join() === 'In,In:1,In:2,In:3', [...bodies().keys()].join());
}

// ---- in metres: every length a thousand times as long
{
  const m = mm.replace(MILLI, 'SI_UNIT($,.METRE.)');
  const r = await after([put(m)]);
  const got = vols();
  check('the same file in metres: four bodies, a thousand times the size each way', !r.errors.length && got.length === 4 && got.every((v, i) => near(v / 1e9, V[i], 1e-3)), `${got.map(v => (v / 1e9).toFixed(2))} ${r.errors.join('; ')}`);
}

// ---- in inches (a unit made from another, as most programs write it)
{
  let top = Math.max(...[...mm.matchAll(/#(\d+)\s*=/g)].map(x => Number(x[1])));
  const unit = /\(\s*LENGTH_UNIT\(\)\s*NAMED_UNIT\(\*\)\s*SI_UNIT\(\s*\.MILLI\.\s*,\s*\.METRE\.\s*\)\s*\)\s*;/g;
  const inch = mm.replace(unit, () => {
    const [a, b, c] = [++top, ++top, ++top];

    return `( CONVERSION_BASED_UNIT('INCH',#${a}) LENGTH_UNIT() NAMED_UNIT(#${c}) );
#${a} = LENGTH_MEASURE_WITH_UNIT(LENGTH_MEASURE(25.4),#${b});
#${b} = ( LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.MILLI.,.METRE.) );
#${c} = DIMENSIONAL_EXPONENTS(1.,0.,0.,0.,0.,0.,0.);`;
  });
  const r = await after([put(inch)]);
  const got = vols();
  const k = 25.4 ** 3;
  check('the same file in inches: four bodies, 25.4 times the size each way', inch !== mm && !r.errors.length && got.length === 4 && got.every((v, i) => near(v / k, V[i], 1e-3)), `${got.map(v => (v / k).toFixed(2))} ${r.errors.join('; ')}`);
}

// ---- CRLF line ends, as a file saved on Windows
{
  const r = await after([put(mm.replace(/\r?\n/g, '\r\n'))]);
  check('with Windows line ends: the same four', !r.errors.length && vols().length === 4, r.errors.join('; '));
}

// ---- each body used by itself afterwards
{
  await after([put(mm)]);
  const id = (v: number) => [...bodies().entries()].find(([, b]) => near(volume(b as Shape3D), v, 1e-2))![0];
  const [A, C, B, T] = [id(1000), id(Math.PI * 128), id(64), id(300)];
  const move: Feature = { id: 'mv', name: 'Move', type: 'transform', bodies: [B], copy: false, op: { kind: 'move', translate: [0, 0, 50] } } as unknown as Feature;
  const cut: Feature = { id: 'bo', name: 'Subtract', type: 'boolean', op: 'subtract', target: A, tools: [C] } as unknown as Feature;
  const del: Feature = { id: 'de', name: 'Delete', type: 'delete', bodies: [T] } as unknown as Feature;
  const r = await after([put(mm), move, cut, del]);
  const got = vols();
  check('then one moved, one cut by another (its 2 mm in it), one deleted: two bodies left, the cut one 1000 - 32 pi, sound', !r.errors.length && sound() && got.length === 2 && near(got[0], 64, 1e-3) && near(got[1], 1000 - Math.PI * 32, 1e-2), `${[...bodies().keys()].join()} ${got.map(v => v.toFixed(2))} ${r.errors.join('; ')}`);
}

// ---- two files put in: their bodies kept apart by name
{
  const two = await text([...block('P', 2, 2, 2), ...block('Q', 3, 3, 3, [10, 0, 0])]);
  const r = await after([put(mm, 'In'), put(two, 'In2')]);
  check("two files: six bodies, none over another's name", !r.errors.length && bodies().size === 6 && new Set(bodies().keys()).size === 6, [...bodies().keys()].join());
}

// ---- many bodies
{
  const many: Feature[] = [];
  for (let i = 0; i < 40; i++) {
    many.push(...block(`M${i}`, 2 + (i % 5), 3, 1 + (i % 3), [(i % 8) * 12, Math.floor(i / 8) * 12, 0]));
  }
  const t = await text(many);
  const t0 = performance.now();
  const r = await after([put(t)]);
  const want = many.length ? Array.from({ length: 40 }, (_, i) => (2 + (i % 5)) * 3 * (1 + (i % 3))).reduce((s, v) => s + v, 0) : 0;
  check('forty solids: forty bodies, their sizes kept', !r.errors.length && bodies().size === 40 && near(vols().reduce((s, v) => s + v, 0), want, 1e-2), `${bodies().size} bodies, ${Math.round(performance.now() - t0)} ms`);
}

// ---- a file cut short, and one that is not STEP at all: said in plain words
for (const [name, t] of [['cut short', mm.slice(0, Math.floor(mm.length * 0.6))], ['not a STEP file', 'hello, this is a text file\n'], ['empty', '']] as const) {
  const r = await after([put(t)]);
  check(`a file ${name}: said in plain words, or what could be read is sound`, r.errors.length ? r.errors.every(e => /STEP|solid|file/i.test(e) && !/null|undefined|memory|exception|\bat \w+\./i.test(e)) : sound(), `${bodies().size} bodies ${r.errors.join('; ')}`);
}
done();
