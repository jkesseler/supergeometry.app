// Run: npx tsx tests/threadclearance.test.ts
// A threaded bolt subtracted from a block with a clearance: a threaded hole a little bigger than the bolt all
// round, so the printed bolt turns in it. (It failed every time: "Couldn't keep 0.2 mm clear ...".)
import { getOC, type Shape3D } from 'replicad';
import { after, bodies, block, check, cylinder, done, health, near, volume } from './kit';
import type { Feature } from '../src/doc/types';

const oc = getOC();
const gap = (a: Shape3D, b: Shape3D) => {
  const measure = new oc.BRepExtrema_DistShapeShape(a.wrapped, b.wrapped);
  try {
    return measure.IsDone() ? measure.Value() : -1;
  } finally {
    measure.delete();
  }
};
// A block 30 x 30 x 12 and an M10 bolt shank (r 5, 24 long) standing through its middle.
const blockF = block('blk', 30, 30, 12);
const bolt = cylinder('bolt', 5, 24, 15, 15, -6);
const first = await after([...blockF, ...bolt]);
const side = first.r.bodies.find(b => b.id === 'bolt')!.faces.find(face => face.type === 'CYLINDRE')!;
const thread: Feature = { id: 'thr', name: 'Thread', type: 'thread', face: { body: 'bolt', center: side.center, normal: side.normal, area: side.area }, pitch: 1.5 } as Feature;
const cut = (extra: object): Feature => ({ id: 'cut', name: 'Subtract', type: 'boolean', op: 'subtract', target: 'blk', tools: ['bolt'], keepTools: true, ...extra }) as Feature;
const bodyShape = (id: string) => bodies().get(id) as Shape3D;

let result = await after([...blockF, ...bolt, thread]);
const vBolt = volume(bodyShape('bolt'));
check('the bolt is threaded', !result.errors.length && health(bodyShape('bolt')).healthy && vBolt < Math.PI * 25 * 24, `${vBolt.toFixed(1)} ${result.errors.join('; ')}`);

result = await after([...blockF, ...bolt, thread, cut({})]);
const vTight = volume(bodyShape('blk'));
check("no clearance: a threaded hole the bolt's own size", !result.errors.length && health(bodyShape('blk')).healthy && near(gap(bodyShape('blk'), bodyShape('bolt')), 0, 1e-3), `${result.errors.join('; ')} gap ${gap(bodyShape('blk'), bodyShape('bolt')).toFixed(4)}`);

for (const clearance of [0.1, 0.2, 0.4]) {
  const t0 = performance.now();
  result = await after([...blockF, ...bolt, thread, cut({ clearance: clearance })]);
  const ok = !result.errors.length && !!bodyShape('blk');
  const clearanceGap = ok ? gap(bodyShape('blk'), bodyShape('bolt')) : -1;
  const bodyVolume = ok ? volume(bodyShape('blk')) : 0;
  // The hole is the thread that much bigger all round: nowhere nearer the bolt than the clearance (its sides and
  // its crests at just that; its roots have more).
  check(`clearance ${clearance}: the cut is made, sound, the bolt kept`, ok && health(bodyShape('blk')).healthy && near(volume(bodyShape('bolt')), vBolt, 1e-6), `${result.errors.join('; ')} ${Math.round(performance.now() - t0)} ms`);
  check(`clearance ${clearance}: the hole stands ${clearance} off the bolt at its nearest, and is bigger than the tight one`, ok && clearanceGap > clearance * 0.97 && clearanceGap < clearance * 1.03 && bodyVolume < vTight, `gap ${clearanceGap.toFixed(4)}, block ${bodyVolume.toFixed(1)} against ${vTight.toFixed(1)}`);
}
// A bolt with a head: the thread is on its shank only; the block is cut round shank and head alike.
{
  const head = cylinder('head', 9, 6, 15, 15, 18);
  const join: Feature = { id: 'j', name: 'Union', type: 'boolean', op: 'union', target: 'bolt', tools: ['head'] } as Feature;
  const tall = block('blk', 30, 30, 22);
  const base = [...tall, ...bolt, ...head, join];
  const r0 = await after(base);
  const shank = r0.r.bodies.find(b => b.id === 'bolt')!.faces.find(face => face.type === 'CYLINDRE' && Math.abs((face.round?.r ?? 0) - 5) < 1e-6)!;
  const th: Feature = { id: 'thr', name: 'Thread', type: 'thread', face: { body: 'bolt', center: shank.center, normal: shank.normal, area: shank.area }, pitch: 1.5 } as Feature;
  const rr = await after([...base, th, cut({ clearance: 0.2 })]);
  const okk = !rr.errors.length && !!bodyShape('blk');
  check('a headed bolt, clearance 0.2: cut, sound, 0.2 off at its nearest', okk && health(bodyShape('blk')).healthy && near(gap(bodyShape('blk'), bodyShape('bolt')), 0.2, 0.01), `${rr.errors.join('; ')} gap ${okk ? gap(bodyShape('blk'), bodyShape('bolt')).toFixed(4) : '-'}`);
  // Something done to the bolt after its thread (a chamfer on the head): it is no longer the thread's own result
  // in every part, yet its thread is still there - cut the same way.
  const top = rr.r.bodies.find(b => b.id === 'bolt')!;
  const rim = top.edges.find(e => e.type === 'CIRCLE' && Math.abs(e.start[2] - 24) < 1e-6 && Math.abs(Math.hypot(e.start[0] - 15, e.start[1] - 15) - 9) < 1e-6)!;
  const cham: Feature = { id: 'ch', name: 'Chamfer', type: 'chamfer', edges: [{ body: 'bolt', mid: rim.mid, dir: [0, 0, 1], length: rim.length }], radius: 1 } as unknown as Feature;
  const r2 = await after([...base, th, cham, cut({ clearance: 0.2 })]);
  const ok2 = !r2.errors.length && !!bodyShape('blk');
  check('the same with the head chamfered after the thread: cut, or said why in plain words', ok2 ? health(bodyShape('blk')).healthy && gap(bodyShape('blk'), bodyShape('bolt')) > 0.15 : /clear|smaller/i.test(r2.errors.join()), `${r2.errors.join('; ')} gap ${ok2 ? gap(bodyShape('blk'), bodyShape('bolt')).toFixed(4) : '-'}`);
}

// A nut (a thread in a hole) used as the cutter of a rod standing in it: the rod gets the outside thread, 0.2 smaller.
{
  const nut = block('nut', 24, 24, 8, [3, 3, 2]);
  const hole = cylinder('pin', 4.25, 8, 15, 15, 2);
  const bore: Feature = { id: 'bore', name: 'Subtract', type: 'boolean', op: 'subtract', target: 'nut', tools: ['pin'] } as Feature;
  const rod = cylinder('rod', 5, 14, 15, 15, -1);
  const r0 = await after([...nut, ...hole, bore]);
  const inner = r0.r.bodies.find(b => b.id === 'nut')!.faces.find(face => face.type === 'CYLINDRE')!;
  const th: Feature = { id: 'nt', name: 'Thread', type: 'thread', face: { body: 'nut', center: inner.center, normal: inner.normal, area: inner.area }, pitch: 1.5 } as Feature;
  const feature: Feature = { id: 'cut', name: 'Subtract', type: 'boolean', op: 'subtract', target: 'rod', tools: ['nut'], keepTools: true, clearance: 0.2 } as Feature;
  const rr = await after([...nut, ...hole, bore, th, ...rod, feature]);
  const okk = !rr.errors.length && !!bodyShape('rod');
  check('a rod cut by a threaded nut, clearance 0.2: made, sound, 0.2 off the nut at its nearest', okk && health(bodyShape('rod')).healthy && near(gap(bodyShape('rod'), bodyShape('nut')), 0.2, 0.01), `${rr.errors.join('; ')} gap ${okk ? gap(bodyShape('rod'), bodyShape('nut')).toFixed(4) : '-'}`);
}

// The clearance taken from the bolt instead of the block ("The others"), and shared between them ("All").
for (const from of ['tools', 'all'] as const) {
  result = await after([...blockF, ...bolt, thread, cut({ clearance: 0.2, cutFrom: from })]);
  const okk = !result.errors.length && !!bodyShape('blk') && !!bodyShape('bolt');
  check(`clearance 0.2 taken from ${from === 'tools' ? 'the bolt' : 'both'}: made and 0.2 apart, or said why in plain words`, okk ? gap(bodyShape('blk'), bodyShape('bolt')) > 0.15 && gap(bodyShape('blk'), bodyShape('bolt')) < 0.25 : /clear|smaller|thread/i.test(result.errors.join()), `${result.errors.join('; ')} gap ${okk ? gap(bodyShape('blk'), bodyShape('bolt')).toFixed(4) : '-'}`);
}
done();
