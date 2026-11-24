// Run: npx tsx tests/enclosure.test.ts
// An electronics box the usual way (rounded box, shelled, screw bosses with
// threaded holes, vents patterned and subtracted), and what people then do to
// it: sizes made to fit exactly, a pattern's count changed, a step switched off.
import opencascade from 'replicad-opencascadejs';
import { setOC, measureVolume } from 'replicad';
import { debugBodies, regenerate } from '../src/kernel/engine';
import { arrangement, regionRef } from '../src/sketch/regions';
setOC(await (opencascade as unknown as () => Promise<any>)());

const XY = { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, 0, 1] };
const regs = (es: any[], pick?: (r: any) => boolean) => arrangement(es).regions.filter(region => !pick || pick(region)).map(regionRef);
const vol = (id: string) => {
  const b = debugBodies().get(id);

  return b ? Math.abs(measureVolume(b as any)) : NaN;
};
let failed = 0;
const check = (name: string, ok: boolean, info = '') => {
  if (!ok) {
    failed++;
  }
  console.log(ok ? 'ok  ' : 'FAIL', name, info);
};
const run = async (fs: any[]) => {
  const t = performance.now();
  const result: any = await regenerate(fs);

  return { ...result, ms: Math.round(performance.now() - t), msg: result.errors.map((e: any) => `${e.featureId}: ${e.message}`).join(' | '), notes: (result.notes ?? []).map((e: any) => e.message).join(' | ') };
};

// --- Sizes that fit exactly: 4 mm roundings on both edges of an 8 mm block (a full round).
{
  const LENGTH = 40, WIDTH = 8, HEIGHT = 10;
  const block = [
    { id: 's', name: 's', type: 'sketch', plane: XY, entities: [{ id: 'r', kind: 'rect', center: [0, 0], w: LENGTH, h: WIDTH, rotation: 0 }], constraints: [] },
    { id: 'b', name: 'b', type: 'extrude', source: { kind: 'profile', sketch: 's', regions: [{ c: [0, 0], a: LENGTH * WIDTH }] }, distance: HEIGHT, mode: 'new' }
  ];
  const e = (y: number, z: number) => ({ body: 'b', mid: [0, y, z], dir: [1, 0, 0], length: LENGTH });
  const round = LENGTH * (WIDTH * HEIGHT - (8 - 2 * Math.PI) * 4);
  let result = await run([...block, { id: 'f', name: 'f', type: 'fillet', radius: 4, edges: [e(4, HEIGHT), e(-4, HEIGHT)] }]);
  check('8 mm block, both top edges rounded 4 mm at once', !result.msg && Math.abs(vol('b') - round) < 0.01, `${result.msg} ${vol('b').toFixed(2)} want ${round.toFixed(2)}`);
  result = await run([...block, { id: 'f', name: 'f', type: 'fillet', radius: 4, edges: [e(4, HEIGHT)] }, { id: 'g', name: 'g', type: 'fillet', radius: 4, edges: [e(-4, HEIGHT)] }]);
  check('…one edge, then the other (the second used to fail; 3.999 worked)', !result.msg && Math.abs(vol('b') - round) < 0.01, `${result.msg} ${vol('b').toFixed(2)}`);
  result = await run([...block, { id: 'f', name: 'f', type: 'chamfer', radius: 4, edges: [e(4, HEIGHT), e(-4, HEIGHT)] }]);
  check('…chamfered 4 mm both sides (a roof ridge)', !result.msg && Math.abs(vol('b') - (LENGTH * WIDTH * HEIGHT - 2 * 8 * LENGTH)) < 0.05, `${result.msg} ${vol('b').toFixed(2)}`);
  result = await run([...block, { id: 'f', name: 'f', type: 'fillet', radius: 5, edges: [e(4, HEIGHT), e(-4, HEIGHT)] }]);
  check("…5 mm still says it doesn't fit", /doesn't fit/.test(result.msg), result.msg);
}

// --- The box.
const box = (options: { r?: number; wall?: number; count?: number; boss?: boolean } = {}) => {
  const { r: radius = 6, wall = 2, count = 7, boss = true } = options;
  const rect = [{ id: 'r', kind: 'rect', center: [0, 0], w: 80, h: 50, rotation: 0 }];
  const bosses = [[1, 1], [-1, 1], [1, -1], [-1, -1]].flatMap(([sx, sy], i) => [
    { id: `bo${i}`, kind: 'circle', center: [sx * 31, sy * 16], radius: 3.5 },
    { id: `bi${i}`, kind: 'circle', center: [sx * 31, sy * 16], radius: 1.5 }
  ]);
  const slot = [{ id: 'v', kind: 'rect', center: [-15, 0], w: 2.5, h: 14, rotation: 0 }];
  const corners = [[40, 25], [-40, 25], [40, -25], [-40, -25]];

  return [
    { id: 's1', name: 'Sketch 01', type: 'sketch', plane: XY, entities: rect, constraints: [] },
    { id: 'box', name: 'Extrude 01', type: 'extrude', source: { kind: 'profile', sketch: 's1', regions: regs(rect) }, distance: 30, mode: 'new' },
    { id: 'f1', name: 'Fillet 01', type: 'fillet', radius: radius, edges: corners.map(([x, y]) => ({ body: 'box', mid: [x, y, 15], dir: [0, 0, 1], length: 30 })) },
    { id: 'sh', name: 'Shell 01', type: 'shell', body: 'box', faces: [{ body: 'box', center: [0, 0, 30], normal: [0, 0, 1], area: 4000 - (4 - Math.PI) * 36 }], thickness: wall },
    { id: 's2', name: 'Sketch 02', type: 'sketch', plane: { origin: [0, 0, 2], xDir: [1, 0, 0], normal: [0, 0, 1] }, attachedTo: { body: 'box', center: [0, 0, 2], normal: [0, 0, 1], area: 3476 }, entities: bosses, constraints: [], suppressed: !boss || undefined },
    { id: 'e2', name: 'Extrude 02', type: 'extrude', source: { kind: 'profile', sketch: 's2', regions: regs(bosses, x => x.area > 20) }, distance: 20, mode: 'join', target: 'box', suppressed: !boss || undefined },
    { id: 'th', name: 'Thread 01', type: 'thread', face: holeRef, pitch: 0.5, round: { r: 1.5, hole: true } },
    { id: 's4', name: 'Sketch 04', type: 'sketch', plane: { origin: [0, 25, 15], xDir: [-1, 0, 0], normal: [0, 1, 0] }, entities: slot, constraints: [] },
    { id: 'vt', name: 'Extrude 04', type: 'extrude', source: { kind: 'profile', sketch: 's4', regions: regs(slot) }, distance: -5, mode: 'new' },
    { id: 'pt', name: 'Pattern 01', type: 'transform', bodies: ['vt'], copy: true, op: { kind: 'linear', dir: [1, 0, 0], spacing: 5, count } },
    // Picked as "Whole Pattern" when the pattern had 7 (the page keeps that with the step).
    { id: 'bs', name: 'Subtract 01', type: 'boolean', op: 'subtract', target: 'box', tools: ['vt', 'pt:vt:0', 'pt:vt:1', 'pt:vt:2', 'pt:vt:3', 'pt:vt:4', 'pt:vt:5'], whole: ['pt:vt'] }
  ];
};

// The hole face as picked: from the box built up to its bosses.
let holeRef: any = null;
const r0: any = await regenerate(box().slice(0, 6));
const hf = r0.bodies[0].faces.find((face: any) => face.type === 'CYLINDRE' && face.round?.hole && Math.abs(face.round.r - 1.5) < 1e-6 && face.center[0] > 0 && face.center[1] > 0);
holeRef = { body: 'box', center: hf.center, normal: hf.normal, area: hf.area };
let built = await run(box());
const v7 = vol('box');
check('the box builds: shelled, 4 bosses, an M3-size thread 20 mm deep, 7 vents', !built.msg && [...debugBodies().keys()].join() === 'box', `${built.msg} ${built.ms}ms`);
check('…the 40-turn thread in under 10 s (it failed after 40 s)', built.ms < 10000, `${built.ms}ms`);

built = await run(box({ r: 2 }));
check('corners rounded 2 mm, walls 2 mm: it shells (sharp inside corners)', !built.msg, built.msg);
built = await run(box({ r: 3, wall: 3 }));
check('…and 3 and 3', !built.msg, built.msg);

built = await run(box({ count: 3 }));
const v3 = vol('box');
check('vent pattern made 3: the subtract still works, with fewer vents cut', !built.msg && v3 > v7 + 100, `${built.msg} ${v3.toFixed(0)} vs ${v7.toFixed(0)}`);
built = await run(box({ count: 5 }).map((feature: any) => (feature.id === 'pt' ? { ...feature, op: { ...feature.op, spacing: 4 } } : feature)));
const v5 = vol('box');
built = await run(box({ count: 6 }).map((feature: any) => (feature.id === 'pt' ? { ...feature, op: { ...feature.op, spacing: 4 } } : feature)));
check('…made 6 from 7 at a closer spacing: every vent cut', !built.msg && vol('box') < v5 - 50, `${built.msg} ${vol('box').toFixed(0)} vs ${v5.toFixed(0)}`);
built = await run(box().map((feature: any) => (feature.id === 'pt' ? { ...feature, op: { ...feature.op, count: 9, spacing: 3 } } : feature)));
check('…made 9: all nine are cut, none left lying about', !built.msg && [...debugBodies().keys()].join() === 'box', `${built.msg} ${[...debugBodies().keys()].join()}`);
built = await run(box().map((feature: any) => (feature.id === 'pt' ? { ...feature, suppressed: true } : feature)));
check('…pattern switched off: the one vent left is cut', !built.msg && vol('box') > v3 && [...debugBodies().keys()].join() === 'box', `${built.msg} ${vol('box').toFixed(0)}`);
// Copies picked one by one (not the whole pattern): those gone are left out, with a note.
built = await run(box({ count: 3 }).map((feature: any) => (feature.id === 'bs' ? { ...feature, tools: ['pt:vt:1', 'pt:vt:3', 'pt:vt:5'], whole: undefined } : feature)));
check('…two of three copies picked by hand gone: the rest is cut, with a note', !built.msg && /2 of the bodies it used no longer exist/.test(built.notes), `${built.msg} / ${built.notes}`);

// Each piece is a body: the vent and two of its copies picked cut those three, and
// the other four stay as bodies of their own.
{
  const some = box().map((feature: any) => (feature.id === 'bs' ? { ...feature, tools: ['vt', 'pt:vt:0', 'pt:vt:1'], whole: undefined } : feature));
  built = await run(some);
  const left = [...debugBodies().keys()].filter(key => key !== 'box').sort();
  check('three of seven vents picked: three cut, four left as bodies', !built.msg && left.join() === 'pt:vt:2,pt:vt:3,pt:vt:4,pt:vt:5', `${built.msg} ${left.join()}`);
  check('…and the step is told it used no pattern whole', JSON.stringify(built.whole) === JSON.stringify({ bs: [] }), JSON.stringify(built.whole));
  const all = box().map((feature: any) => (feature.id === 'bs' ? { ...feature, whole: undefined } : feature));
  built = await run(all);
  check("all seven picked, nothing saved with it yet: every vent cut, and it's told it used the pattern whole", !built.msg && [...debugBodies().keys()].join() === 'box' && JSON.stringify(built.whole) === JSON.stringify({ bs: ['pt:vt'] }), `${built.msg} ${JSON.stringify(built.whole)}`);
  built = await run(box());
  check('…saved with it: nothing more to tell', !built.msg && built.whole === undefined, JSON.stringify(built.whole));
}

built = await run(box({ boss: false }));
check("bosses switched off: the thread says its hole is gone, quickly (it threaded the box's corner for 75 s)", /hole it was cut in is gone/.test(built.msg) && built.ms < 5000, `${built.msg} ${built.ms}ms`);

process.exit(failed ? 1 : 0);
