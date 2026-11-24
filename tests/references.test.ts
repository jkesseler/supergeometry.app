// Run: npx tsx tests/references.test.ts
// Faces and edges picked the way a tap picks them (with the step that made
// them), then earlier steps resized, edited and switched off: a step follows
// its face or edge when it's still there, and says it's gone when it isn't -
// it never quietly takes another one.
import opencascade from 'replicad-opencascadejs';
import { setOC, measureVolume } from 'replicad';
import { debugBodies, regenerate } from '../src/kernel/engine';
import { resolveDoc } from '../src/doc/params';
import { arrangement, regionRef } from '../src/sketch/regions';
setOC(await (opencascade as unknown as () => Promise<any>)());

const XY = { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, 0, 1] };
const regs = (es: any[], pick?: (r: any) => boolean) => arrangement(es).regions.filter(region => !pick || pick(region)).map(regionRef);
let failed = 0;
const check = (name: string, ok: boolean, info = '') => {
  if (!ok) {
    failed++;
  }
  console.log(ok ? 'ok  ' : 'FAIL', name, info);
};
const vol = (id: string) => {
  const b = debugBodies().get(id);

  return b ? Math.abs(measureVolume(b as any)) : NaN;
};
// A tap: what the app stores (tool.ts faceRefOf / edgeRefOf).
const faceTap = (result: any, body: string, pred: (f: any) => boolean) => {
  const hits = result.bodies.find((b: any) => b.id === body).faces.filter(pred);
  if (hits.length !== 1) {
    throw new Error(`face tap on ${body}: ${hits.length} faces`);
  }
  const firstHit = hits[0];

  return { body, center: firstHit.center, normal: firstHit.normal, area: firstHit.area, ...(firstHit.step ? { step: firstHit.step } : {}) };
};
const edgeTaps = (result: any, body: string, pred: (e: any) => boolean) =>
  result.bodies.find((b: any) => b.id === body).edges.filter(pred).map((e: any) => ({ body, mid: e.mid, dir: e.dir, length: e.length, ...(e.steps ? { steps: e.steps } : {}) }));

// The part, made step by step with taps, sizes from variables.
const doc: any = { variables: [{ name: 'W', expr: '80' }, { name: 'D', expr: '50' }, { name: 'H', expr: '30' }], features: [] };
const add = async (feature: any) => {
  doc.features.push(feature);
  resolveDoc(doc);
  const result: any = await regenerate(doc.features);
  if (result.errors.length) {
    throw new Error(`${feature.id}: ${result.errors.map((e: any) => e.message).join()}`);
  }

  return result;
};
const rect = [{ id: 'r', kind: 'rect', center: [0, 0], w: 80, h: 50, rotation: 0 }];
await add({ id: 's1', name: 'Sketch 01', type: 'sketch', plane: XY, entities: rect, constraints: [], exprs: { 'entities.0.w': 'W', 'entities.0.h': 'D' } });
let built = await add({ id: 'box', name: 'Extrude 01', type: 'extrude', source: { kind: 'profile', sketch: 's1', regions: regs(rect) }, distance: 30, mode: 'new', exprs: { distance: 'H' } });
built = await add({ id: 'f1', name: 'Fillet 01', type: 'fillet', radius: 6, edges: edgeTaps(built, 'box', e => Math.abs(e.dir[2]) > 0.99) });
built = await add({ id: 'sh', name: 'Shell 01', type: 'shell', body: 'box', faces: [faceTap(built, 'box', face => face.normal[2] > 0.99)], thickness: 2 });
const floor = faceTap(built, 'box', face => face.normal[2] > 0.99 && face.center[2] < 5);
check("the floor is tapped as the shell's face", floor.step === 'sh', floor.step);
const bosses = [[1, 1], [-1, 1], [1, -1], [-1, -1]].map(([sx, sy], i) => ({ id: `b${i}`, kind: 'circle', center: [sx * 31, sy * 16], radius: 3.5 }));
await add({ id: 's2', name: 'Sketch 02', type: 'sketch', plane: { origin: floor.center, xDir: [1, 0, 0], normal: [0, 0, 1] }, attachedTo: floor, entities: bosses, constraints: [] });
built = await add({ id: 'e2', name: 'Extrude 02', type: 'extrude', source: { kind: 'profile', sketch: 's2', regions: regs(bosses) }, distance: 15, mode: 'join', target: 'box' });
const feet = edgeTaps(built, 'box', e => e.type === 'CIRCLE' && Math.abs(e.mid[2] - 2) < 0.01 && Math.abs(e.length - 7 * Math.PI) < 0.01);
check("the bosses' feet: 4 edges between the bosses and the floor", feet.length === 4 && feet.every((e: any) => e.steps?.join() === 'e2,sh'), feet.map((e: any) => e.steps?.join('+')).join(' '));
built = await add({ id: 'f2', name: 'Fillet 02', type: 'fillet', radius: 1, edges: feet });
const lip = faceTap(built, 'box', face => face.normal[2] > 0.99 && Math.abs(face.center[2] - 30) < 0.01);
await add({ id: 's3', name: 'Sketch 03', type: 'sketch', plane: { origin: lip.center, xDir: [1, 0, 0], normal: [0, 0, 1] }, attachedTo: lip, entities: [{ id: 'c', kind: 'circle', center: [lip.center[0] - 39, lip.center[1]], radius: 0.6 }], constraints: [] });
const base = JSON.parse(JSON.stringify(doc));
const v0 = vol('box');

const run = async (label: string, edit: (d: any) => void) => {
  const doc = JSON.parse(JSON.stringify(base));
  edit(doc);
  resolveDoc(doc);
  const t = performance.now();
  const res: any = await regenerate(doc.features);

  return { msg: res.errors.map((e: any) => `${e.featureId}: ${e.message}`).join(' | '), notes: (res.notes ?? []).map((e: any) => `${e.featureId}: ${e.message}`).join(' | '), ms: performance.now() - t, label };
};

// Sizes changed: every tap still finds its face or edge (no false "gone").
for (const [name, expr] of [['W', '120'], ['W', '50'], ['D', '80'], ['H', '60'], ['H', '18']]) {
  const outcome = await run(`${name}=${expr}`, doc => (doc.variables.find((variable: any) => variable.name === name).expr = expr));
  check(`${name} = ${expr}: every step still builds`, !outcome.msg && !outcome.notes, outcome.msg + outcome.notes);
}
// A step's own value changed.
let nextOutcome = await run('fillet 12', doc => (doc.features.find((feature: any) => feature.id === 'f1').radius = 12));
check('corner fillet made 12: the rest follows', !nextOutcome.msg && !nextOutcome.notes, nextOutcome.msg + nextOutcome.notes);
nextOutcome = await run('shell 4', doc => (doc.features.find((feature: any) => feature.id === 'sh').thickness = 4));
check('walls made 4 thick: the bosses stay on the floor', !nextOutcome.msg && !nextOutcome.notes, nextOutcome.msg + nextOutcome.notes);

// Switched off: whatever was built on what's gone says so, the rest carries on.
nextOutcome = await run('shell off', doc => (doc.features.find((feature: any) => feature.id === 'sh').suppressed = true));
check('shell off: the boss sketch stays where it was, with a note (it used to jump to the top face)', /s2: The face this sketch was drawn on is gone/.test(nextOutcome.notes), nextOutcome.notes);
check("…the bosses' fillet says its edges are gone (it used to round other edges)", /f2: An edge it was built on is gone/.test(nextOutcome.msg), nextOutcome.msg);
nextOutcome = await run('bosses off', doc => (doc.features.find((feature: any) => feature.id === 'e2').suppressed = true));
check('bosses off: the fillet round their feet says its edges are gone', /f2: An edge it was built on is gone/.test(nextOutcome.msg) && !/s2|s3/.test(nextOutcome.msg + nextOutcome.notes), nextOutcome.msg + nextOutcome.notes);
nextOutcome = await run('corners off', doc => (doc.features.find((feature: any) => feature.id === 'f1').suppressed = true));
check('corner fillet off: everything after it still builds', !nextOutcome.msg && !nextOutcome.notes, nextOutcome.msg + nextOutcome.notes);

// Old projects (taps stored before steps were remembered) work as they did.
nextOutcome = await run('old taps', (doc) => {
  const strip = (value: any): any => (Array.isArray(value) ? value.map(strip) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'step' && key !== 'steps').map(([key, x]) => [key, strip(x)])) : value);
  doc.features = strip(doc.features);
});
check('taps without steps (older projects) still build', !nextOutcome.msg && Math.abs(vol('box') - v0) < 1e-6 * v0, nextOutcome.msg);

// The hand-built lid (tests/fixtures/lid-hand.json), its rectangle swapped
// for a circle: the corner fillet's 3 mm upright edges are gone - not the
// cylinder's seam (also 3 mm and upright) or its rim circles.
{
  const { readFileSync } = await import('node:fs');
  const hand = JSON.parse(readFileSync(new URL('./fixtures/lid-hand.json', import.meta.url), 'utf8'));
  hand.features[0].entities = [{ id: 'c1', kind: 'circle', center: [0, 0], radius: 40 }];
  hand.features[1].source.regions = regs(hand.features[0].entities);
  resolveDoc(hand);
  const result: any = await regenerate(hand.features);
  const msg = result.errors.map((e: any) => `${e.featureId}: ${e.message}`).join(' | ');
  const want = Math.PI * 1600 * 3 + Math.PI * (38 ** 2 - 36 ** 2) * 4;
  const volume = vol('extrude-mw9gghgi-u7ha');
  check("lid made round: its corner fillet says the edges are gone (it rounded the seam: 'radius too big')", result.errors.length === 1 && /fillet-mw9gjf18-wv70: An edge it was built on is gone/.test(msg), msg);
  check('…and the lip follows the circle', Math.abs(volume - want) < 0.5, `${volume.toFixed(1)} want ${want.toFixed(1)}`);
}


process.exit(failed ? 1 : 0);
