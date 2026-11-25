// Run: npx tsx tests/threadstarts.slow.test.ts
// Threads with several starts (a jar's neck and its lid): that many grooves side by side, the crests still a pitch
// apart, one turn taking a lid `starts` pitches along. Cut right, sound, and a lid cut from the neck with a
// clearance stands that far off it.
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
const bodyShape = (id: string) => bodies().get(id) as Shape3D;
// A jar's neck: 40 across, 12 high. Its thread: 3 from crest to crest.
const neck = cylinder('neck', 20, 12, 0, 0, 0);
const first = await after(neck);
const side = first.r.bodies.find(b => b.id === 'neck')!.faces.find(face => face.type === 'CYLINDRE')!;
const thread = (starts?: number, extra: object = {}): Feature => ({ id: 'thr', name: 'Thread', type: 'thread', face: { body: 'neck', center: side.center, normal: side.normal, area: side.area }, pitch: 3, ...(starts ? { starts } : {}), ...extra }) as Feature;
const plain = Math.PI * 400 * 12;

const taken: Record<number, number> = {};
for (const starts of [1, 2, 4, 6]) {
  const t0 = performance.now();
  const result = await after([...neck, thread(starts === 1 ? undefined : starts)]);
  const ok = !result.errors.length && !!bodyShape('neck');
  taken[starts] = ok ? plain - volume(bodyShape('neck')) : 0;
  check(`${starts} start${starts > 1 ? 's' : ''}: cut, one sound solid`, ok && health(bodyShape('neck')).healthy && taken[starts] > 0, `${taken[starts].toFixed(1)} mm³ taken, ${Math.round(performance.now() - t0)} ms ${result.errors.join('; ')}`);
}
// The same crests a pitch apart, whatever the starts: the same taken (a V swept round an axis takes its area times
// the way round, however steeply it climbs).
check('two, four and six starts take what one does (within 2 %)', [2, 4, 6].every(starts => Math.abs(taken[starts] - taken[1]) < taken[1] * 0.02), Object.entries(taken).map(([key, value]) => `${key}: ${value.toFixed(0)}`).join(', '));
// What tells them apart: a neck with `starts` starts is the same neck turned 1/starts of a turn - one with a single start is not.
// (Two solids exactly the same, one laid on the other: the kernel finds nothing between their faces to keep, and
// says the result is empty - which only happens when every face lies on its twin.)
for (const [starts, same] of [[1, false], [2, false], [4, true]] as const) {
  const turned: Feature = { id: 'T', name: 'T', type: 'transform', bodies: ['neck'], copy: true, op: { kind: 'move', translate: [0, 0, 0], rotate: { origin: [0, 0, 0], axis: [0, 0, 1], angle: 90 } } } as unknown as Feature;
  const both: Feature = { id: 'I', name: 'I', type: 'boolean', op: 'intersect', target: 'neck', tools: ['T:neck:0'] } as unknown as Feature;
  const result = await after([...neck, thread(starts === 1 ? undefined : starts), turned, both]);
  const lost = plain - taken[starts] - volume(bodyShape('neck'));
  check(`${starts} start${starts > 1 ? 's' : ''}, turned a quarter and laid over itself: ${same ? 'the very same neck' : 'not the same (its grooves are elsewhere)'}`, (same ? (!result.errors.length && Math.abs(lost) < 2) || /empty/i.test(result.errors.join()) : !result.errors.length && lost > 100), `${lost.toFixed(1)} mm³ not shared ${result.errors.join('; ')}`);
}
{
  // How many grooves pass one line down the neck: a section through the axis has the same count of notches for any starts.
  const result = await after([...neck, thread(4, { left: true })]);
  check('four starts, left-hand: cut, sound', !result.errors.length && health(bodyShape('neck')).healthy && near(plain - volume(bodyShape('neck')), taken[4], taken[4] * 0.02), `${(plain - volume(bodyShape('neck'))).toFixed(1)} ${result.errors.join('; ')}`);
}
{
  // A lid: a block over the neck, the neck cut out of it with a clearance - the lid's thread stands that far off the neck's.
  const lid = block('lid', 60, 60, 12, [-30, -30, 0]);
  const cut: Feature = { id: 'cut', name: 'Subtract', type: 'boolean', op: 'subtract', target: 'lid', tools: ['neck'], keepTools: true, clearance: 0.3 } as unknown as Feature;
  const t0 = performance.now();
  const result = await after([...lid, ...neck, thread(4), cut]);
  const ok = !result.errors.length && !!bodyShape('lid');
  const clearanceGap = ok ? gap(bodyShape('lid'), bodyShape('neck')) : -1;
  check('a lid cut from a four-start neck with 0.3 clearance: made, sound, 0.3 off the neck at its nearest', ok && health(bodyShape('lid')).healthy && near(clearanceGap, 0.3, 3e-3), `gap ${clearanceGap.toFixed(4)}, ${Math.round(performance.now() - t0)} ms ${result.errors.join('; ')}`);
}
{
  const result = await after([...neck, thread(99)]);
  check('a silly count of starts is taken as 8, or said in plain words', !result.errors.length ? health(bodyShape('neck')).healthy : !/null|undefined|memory|exception/i.test(result.errors.join()), result.errors.join('; '));
}
done();
