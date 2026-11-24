// Run: npx tsx tests/freeformedit.test.ts - Edit Freeform steps: a freeform's
// cage changed later in History, as a step of its own. Whatever is around it,
// the shape must be the one made with the edited cage straight away: edits
// stacked (the later one wins), with steps between (a subtract, a linked
// copy), switched off, rolled back to, deleted, the freeform itself switched
// off or deleted (the edit then says so). Each rebuild warm (results kept from
// the last) the same as built from nothing.
import { measureVolume, type Shape3D } from 'replicad';
import { debugBodies, regenerate, resetKernel } from '../src/kernel/engine';
import { boxCage, planeCage, type Cage } from '../src/freeform/cage';
import { check, done, near, sketch, rect, XY, profile } from './kit';
import type { Feature, Vec3 } from '../src/doc/types';
import type { RegenResult } from '../src/kernel/protocol';

const SIZE = 30;
const cage0 = boxCage([SIZE, SIZE, SIZE], 2, [0, 0, SIZE / 2]);
/** The cage with its points at the top middle (and, with `side`, the +x middle) pulled out. */
function pulled(cage: Cage, up: number, side = 0): Cage {
  const verts = cage.verts.map((vertex): Vec3 => {
    if (near(vertex[2], SIZE * 1.5) && near(vertex[0], 0) && near(vertex[1], 0)) {
      return [vertex[0], vertex[1], vertex[2] + up];
    }
    if (side && near(vertex[0], SIZE / 2) && near(vertex[1], 0) && near(vertex[2], SIZE)) {
      return [vertex[0] + side, vertex[1], vertex[2]];
    }

    return vertex;
  });

  return { verts, faces: cage.faces };
}
const c1 = pulled(cage0, 10);
const c2 = pulled(cage0, 10, 8);
check('the cages differ where they should', JSON.stringify(c1) !== JSON.stringify(cage0) && JSON.stringify(c2) !== JSON.stringify(c1));

const ff = (cage: Cage): Feature => ({ id: 'ff', name: 'Freeform 01', type: 'freeform', cage } as Feature);
const edit = (id: string, cage: Cage, extra: Record<string, unknown> = {}): Feature => ({ id, name: id, type: 'freeformEdit', target: 'ff', patch: { cage }, ...extra } as Feature);
const es = [rect('r', 5, -20, 30, 20)];
const cutter: Feature[] = [sketch('kb', XY(10), es), { id: 'blk', name: 'Block', type: 'extrude', source: profile('kb', es), distance: 40, mode: 'new' } as Feature];
const sub: Feature = { id: 'sub', name: 'Subtract', type: 'boolean', op: 'subtract', target: 'ff', tools: ['blk'] } as Feature;
const copy: Feature = { id: 'cp', name: 'Copy', type: 'transform', bodies: ['ff'], copy: true, link: true, op: { kind: 'move', translate: [60, 0, 0] } } as Feature;

/** Each body's volume (and the failing steps), in order. */
function print(result: RegenResult): string {
  const volumes = [...debugBodies()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([id, shape]) => `${id}:${Math.abs(measureVolume(shape as Shape3D)).toPrecision(9)}`);

  return volumes.join(' ') + ' | ' + result.errors.map(e => e.featureId).sort().join(',');
}
const copyOf = (fs: Feature[]) => JSON.parse(JSON.stringify(fs)) as Feature[];
const warm = async (fs: Feature[]) => {
  const result = await regenerate(copyOf(fs));

  return { r: result, p: print(result) };
};
const cold = async (fs: Feature[]) => {
  resetKernel();

  return warm(fs);
};
/** Built warm after `prev`, and from nothing: the same, and `want` when given. */
async function same(label: string, prev: Feature[], fs: Feature[], want?: Feature[]) {
  await warm(prev);
  const warmRun = await warm(fs);
  const coldRun = await cold(fs);
  check(`${label}: warm = from nothing`, warmRun.p === coldRun.p, { warm: warmRun.p, cold: coldRun.p });
  if (want) {
    const x = await cold(want);
    check(`${label}: as made with that cage straight away`, warmRun.p.split(' | ')[0] === x.p.split(' | ')[0], { got: warmRun.p, want: x.p });
  }

  return warmRun;
}

const plain = await cold([ff(cage0)]);
const pulledUp = await cold([ff(c1)]);
const vol = (print: string) => Number(print.split(' | ')[0].split(':')[1]);
check('pulled up, the freeform is bigger', vol(pulledUp.p) > vol(plain.p) + 100, [plain.p, pulledUp.p]);

// One edit, then a second on top (the later cage wins).
await same('one edit', [ff(cage0)], [ff(cage0), edit('e1', c1)], [ff(c1)]);
await same('two edits', [ff(cage0), edit('e1', c1)], [ff(cage0), edit('e1', c1), edit('e2', c2)], [ff(c2)]);

// With a subtract and a linked copy between the freeform and its edits.
const mid = [ff(cage0), ...cutter, sub, copy];
await same('subtract and copy, then an edit', mid, [...mid, edit('e1', c1)], [ff(c1), ...cutter, sub, copy]);
const both = [...mid, edit('e1', c1), edit('e2', c2)];
await same('... and a second edit', [...mid, edit('e1', c1)], both, [ff(c2), ...cutter, sub, copy]);

// The second edit switched off, rolled back to, deleted: the first edit's shape.
const want1 = [ff(c1), ...cutter, sub, copy];
await same('second edit off', both, both.map(feature => (feature.id === 'e2' ? { ...feature, suppressed: true } : feature)), want1);
await same('rolled back to before the second edit', both, both.map(feature => (feature.id === 'e2' ? { ...feature, rolledBack: true } : feature)), want1);
await same('second edit deleted', both, both.filter(feature => feature.id !== 'e2'), want1);
// The first one off: the second's cage (it holds the first's change too).
await same('first edit off', both, both.map(feature => (feature.id === 'e1' ? { ...feature, suppressed: true } : feature)), [ff(c2), ...cutter, sub, copy]);
// Both off, then on again.
const off = both.map(feature => (feature.type === 'freeformEdit' ? { ...feature, suppressed: true } : feature));
await same('both edits off', both, off, mid);
await same('both on again', off, both, [ff(c2), ...cutter, sub, copy]);

// The freeform itself switched off or deleted: its edits say so (warm too).
for (const [what, list] of [
  ['the freeform off', both.map(feature => (feature.id === 'ff' ? { ...feature, suppressed: true } : feature))],
  ['the freeform deleted', both.filter(feature => feature.id !== 'ff')]
] as const) {
  await warm(both);
  const warmRun = await warm(list as Feature[]);
  const coldRun = await cold(list as Feature[]);
  const said = new Set(warmRun.r.errors.map(e => e.featureId));
  check(`${what}: both edits say the freeform is gone`, said.has('e1') && said.has('e2'), warmRun.r.errors.map(e => `${e.featureId}: ${e.message}`));
  check(`${what}: warm = from nothing`, warmRun.p === coldRun.p, { warm: warmRun.p, cold: coldRun.p });
}

// A sheet given a thickness by an edit (not by its own step).
const sheet: Feature = { id: 'ff', name: 'Sheet', type: 'freeform', cage: planeCage([40, 40], 4, [0, 0, 0]), surface: true } as Feature;
const thick = { ...sheet, thickness: 2 } as Feature;
await same('a sheet made 2 thick by an edit', [sheet], [sheet, { id: 'e1', name: 'e1', type: 'freeformEdit', target: 'ff', patch: { thickness: 2 } } as Feature], [thick]);
const th = await cold([thick]);
check('... 2 thick: 40 x 40 x 2', near(vol(th.p), 3200, 1), th.p);
done();
