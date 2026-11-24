// Run: npx tsx tests/clearance.test.ts
// Subtract with a clearance: the cut leaves a gap between the bodies, taken
// from the body (a hole a little bigger than its peg), from the bodies it's
// subtracted with (the peg gives way), or from all of them (half each). Each
// held to its exact volume, to the gap between what's left, and to being sound.
import { getOC, type Shape3D } from 'replicad';
import { measureVolume } from '../src/kernel/ocFree';
import { after, bodies, block, check, circle, cylinder, done, extrude, health, near, plane, poly, sketch, XY } from './kit';
import type { BooleanFeature, Feature } from '../src/doc/types';

const oc = getOC();
const gap = (a: Shape3D, b: Shape3D) => {
  const d = new oc.BRepExtrema_DistShapeShape(a.wrapped, b.wrapped);
  try {
    return d.IsDone() ? d.Value() : -1;
  } finally {
    d.delete();
  }
};
const B = (id: string) => bodies().get(id) as Shape3D;
const V = (id: string) => Math.abs(measureVolume(B(id)));
const pieces = (id: string) => countSolids(B(id));
function countSolids(s: Shape3D): number {
  const ex = new oc.TopExp_Explorer(s.wrapped, oc.TopAbs_ShapeEnum.TopAbs_SOLID, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
  let n = 0;
  for (; ex.More(); ex.Next()) {
    n++;
  }
  ex.delete();

  return n;
}
const sound = (id: string) => health(B(id), id).healthy;

const PI = Math.PI;
// A plate 40 x 30 x 10, a peg r5 standing 20 tall right through it (z -5..15).
const plate = block('plate', 40, 30, 10);
const peg = cylinder('peg', 5, 20, 20, 15, -5);
const cut = (extra: Partial<BooleanFeature>): Feature => ({ id: 'cut', name: 'Subtract', type: 'boolean', op: 'subtract', target: 'plate', tools: ['peg'], ...extra }) as Feature;

async function run(label: string, extra: Partial<BooleanFeature>) {
  const { errors } = await after([...plate, ...peg, cut(extra)]);
  check(`${label}: no errors`, errors.length === 0, errors);

  return errors.length === 0;
}

// No clearance: the usual subtract (the peg used up).
if (await run('no clearance', {})) {
  check('no clearance: the hole is the peg', near(V('plate'), 12000 - PI * 25 * 10, 1e-6), V('plate'));
  check('no clearance: the peg is used up', !bodies().has('peg'));
}

// From the body, 0.2: a hole r5.2, the peg kept as it was.
if (await run('from the plate', { clearance: 0.2, keepTools: true })) {
  check('from the plate: a hole r5.2', near(V('plate'), 12000 - PI * 5.2 ** 2 * 10, 1e-6), V('plate'));
  check('from the plate: the peg as it was', near(V('peg'), PI * 25 * 20, 1e-6), V('peg'));
  check('from the plate: 0.2 apart', near(gap(B('plate'), B('peg')), 0.2, 1e-6), gap(B('plate'), B('peg')));
  check('from the plate: sound', sound('plate'));
}

// From the body, the peg not kept: a hole r5.2 all the same.
if (await run('from the plate, peg not kept', { clearance: 0.2 })) {
  check('from the plate, peg not kept: a hole r5.2', near(V('plate'), 12000 - PI * 5.2 ** 2 * 10, 1e-6), V('plate'));
  check('from the plate, peg not kept: the peg is used up', !bodies().has('peg'));
}

// From the peg, 0.2: the plate stays, the peg loses its middle (10.4 of it,
// the plate grown 0.2 above and below) - two stubs, 4.8 tall each.
if (await run('from the peg', { clearance: 0.2, cutFrom: 'tools' })) {
  check('from the peg: the plate as it was', near(V('plate'), 12000, 1e-6), V('plate'));
  check('from the peg: two stubs, 4.8 each', near(V('peg'), PI * 25 * 9.6, 1e-6) && pieces('peg') === 2, [V('peg'), pieces('peg')]);
  check('from the peg: 0.2 apart', near(gap(B('plate'), B('peg')), 0.2, 1e-6), gap(B('plate'), B('peg')));
  check('from the peg: sound', sound('peg'));
}

// From both, 0.2: half each - a hole r5.1 and a pin r4.9 through it (the
// peg's ends, outside the plate grown 0.2, as they were).
if (await run('from both', { clearance: 0.2, cutFrom: 'all' })) {
  check('from both: a hole r5.1', near(V('plate'), 12000 - PI * 5.1 ** 2 * 10, 1e-6), V('plate'));
  check('from both: a pin r4.9 through it, in one piece', near(V('peg'), PI * (25 * 9.6 + 4.9 ** 2 * 10.4), 1e-6) && pieces('peg') === 1, [V('peg'), pieces('peg')]);
  check('from both: 0.2 apart', near(gap(B('plate'), B('peg')), 0.2, 1e-6), gap(B('plate'), B('peg')));
  check('from both: sound', sound('plate') && sound('peg'));
}

// Three bodies, all of them: a second peg r3 crossing the first one sideways.
// Each pair ends 0.3 apart.
{
  // A bar r3 along x at y 15, z 5, from x -5 to 45: through the plate's ends and the peg.
  const s2 = sketch('s2', plane([-5, 0, 5], [1, 0, 0], [0, 1, 0]), [circle('c', 15, 0, 3)]);
  const bar = [s2, extrude('bar', s2, 50)];
  const { errors } = await after([...plate, ...peg, ...bar, { ...cut({ clearance: 0.3, cutFrom: 'all' }), tools: ['peg', 'bar'] } as Feature]);
  check('three bodies: no errors', errors.length === 0, errors);
  if (!errors.length) {
    const ids = ['plate', 'peg', 'bar'];
    for (let i = 0; i < 3; i++) {
      for (let j = i + 1; j < 3; j++) {
        const g = gap(B(ids[i]), B(ids[j]));
        check(`three bodies: ${ids[i]} and ${ids[j]} 0.3 apart`, g >= 0.3 - 1e-6 && g < 0.3 + 1e-3, g);
      }
    }
    check('three bodies: all sound', ids.every(sound));
  }
}

// A hex shaft (8 across flats) through the plate, both giving way 0.25: a
// hex hole 8.25 across, a shaft 7.75 across in it, 0.25 apart.
{
  const hex = (id: string, across: number): [number, number][] =>
    [...Array(6)].map((_, i) => [20 + (across / Math.sqrt(3)) * Math.cos((i * Math.PI) / 3), 15 + (across / Math.sqrt(3)) * Math.sin((i * Math.PI) / 3)] as [number, number]);
  const area = (across: number) => (Math.sqrt(3) / 2) * across * across;
  const sh = sketch('hs', XY(-5), [poly('h', hex('h', 8))]);
  const { errors } = await after([...plate, sh, extrude('shaft', sh, 20), { ...cut({ clearance: 0.25, cutFrom: 'all' }), tools: ['shaft'] } as Feature]);
  check('hex shaft: no errors', errors.length === 0, errors);
  if (!errors.length) {
    check('hex shaft: a hex hole 8.25 across', near(V('plate'), 12000 - area(8.25) * 10, 1e-6), V('plate'));
    check('hex shaft: a shaft 7.75 across through it', near(V('shaft'), area(8) * 9.5 + area(7.75) * 10.5, 1e-6), V('shaft'));
    const g = gap(B('plate'), B('shaft'));
    check('hex shaft: 0.25 apart', g >= 0.25 - 1e-6 && g < 0.25 + 1e-4, g);
    check('hex shaft: sound', sound('plate') && sound('shaft'));
  }
}

// Two in a row (the second one with no gap): no trouble.
{
  const { errors } = await after([...plate, ...peg, cut({ clearance: 0.2, cutFrom: 'tools' }), { ...cut({ clearance: 0, cutFrom: 'tools' }), id: 'cut2' } as Feature]);
  check('twice in a row: no errors', errors.length === 0, errors);
}

done();
