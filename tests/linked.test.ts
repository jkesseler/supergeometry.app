// Run: npx tsx tests/linked.test.ts
// Linked copies and linked patterns: a change made to any one of them (the original or a copy) is made to all the
// others the same way, each where it stands. Moving one only moves that one. Not linked: each is its own.
import { after, block, bodies, check, cylinder, done, health, near, volume } from './kit';
import type { Feature, Vec3 } from '../src/doc/types';
import type { Shape3D } from 'replicad';

const B = (id: string) => bodies().get(id) as Shape3D | undefined;
const box = (id: string) => {
  const [lo, hi] = B(id)!.boundingBox.bounds;

  return [...lo, ...hi].map(v => Math.round(v * 1000) / 1000);
};
const sound = () => [...bodies().values()].every(b => health(b as Shape3D).healthy);
const move = (id: string, body: string, translate: Vec3, extra: Record<string, unknown> = {}): Feature => ({ id, name: id, type: 'transform', bodies: [body], copy: true, link: true, op: { kind: 'move', translate }, ...extra }) as unknown as Feature;
const cut = (id: string, target: string, tool: string): Feature => ({ id, name: id, type: 'boolean', op: 'subtract', target, tools: [tool] }) as unknown as Feature;

// A 20 x 10 x 5 block (1000), and a peg to cut holes with: radius 2 through it (pi * 4 * 5 = 62.83).
const A = block('A', 20, 10, 5);
const hole = Math.PI * 4 * 5;
const peg = (id: string, x: number, y: number) => cylinder(id, 2, 9, x, y, -2);

// ---- a linked copy: a hole in the original is in the copy too
{
  const r = await after([...A, move('C', 'A', [50, 0, 0]), ...peg('P', 5, 5), cut('cut', 'A', 'P')]);
  check('a hole cut in the original: the linked copy has it too', !r.errors.length && near(volume(B('A')), 1000 - hole, 1e-3) && near(volume(B('C:A:0')), 1000 - hole, 1e-3) && sound(), `${volume(B('A')).toFixed(2)} ${volume(B('C:A:0')).toFixed(2)} ${r.errors.join('; ')}`);
  check('  the copy still where it was put', box('C:A:0').join() === [50, 0, 0, 70, 10, 5].join(), box('C:A:0').join());
}
// ---- the other way: a hole in the copy is in the original
{
  const r = await after([...A, move('C', 'A', [50, 0, 0]), ...peg('P', 65, 5), cut('cut', 'C:A:0', 'P')]);
  check('a hole cut in the copy: the original has it too', !r.errors.length && near(volume(B('A')), 1000 - hole, 1e-3) && near(volume(B('C:A:0')), 1000 - hole, 1e-3) && sound(), `${volume(B('A')).toFixed(2)} ${volume(B('C:A:0')).toFixed(2)} ${r.errors.join('; ')}`);
  // Where: 15 along the copy from its own corner, so 15 along the original.
  const probe = await after([...A, move('C', 'A', [50, 0, 0]), ...peg('P', 65, 5), cut('cut', 'C:A:0', 'P'), ...peg('Q', 15, 5), cut('again', 'A', 'Q')]);
  check('  and in the same place on it (a peg put there cuts nothing more)', !probe.errors.length || /nothing|didn't|missed/i.test(probe.errors.join()), `${volume(B('A')).toFixed(2)}`);
  check("  (the original's volume after that second cut: as before it)", near(volume(B('A')), 1000 - hole, 1e-2), volume(B('A')).toFixed(2));
}
// ---- not linked: each its own
{
  const r = await after([...A, move('C', 'A', [50, 0, 0], { link: undefined }), ...peg('P', 5, 5), cut('cut', 'A', 'P')]);
  check('a copy that is not linked stays as it was', !r.errors.length && near(volume(B('A')), 1000 - hole, 1e-3) && near(volume(B('C:A:0')), 1000, 1e-3), `${volume(B('A')).toFixed(2)} ${volume(B('C:A:0')).toFixed(2)}`);
}
// ---- a copy turned: the change turns with it
{
  const turned: Feature = { id: 'R', name: 'R', type: 'transform', bodies: ['A'], copy: true, link: true, op: { kind: 'move', translate: [0, 40, 0], rotate: { origin: [0, 0, 0], axis: [0, 0, 1], angle: 90 } } } as unknown as Feature;
  // A notch off the original's far end (x 16 to 20): on the copy, turned a quarter, that is its far end in y.
  const notch = block('N', 4, 10, 5, [16, 0, 0]);
  const r = await after([...A, turned, ...notch, cut('cut', 'A', 'N')]);
  check('a copy turned a quarter: the end cut off the original is cut off its own end', !r.errors.length && near(volume(B('R:A:0')), 800, 1e-3) && box('R:A:0').join() === [-10, 40, 0, 0, 56, 5].join() && sound(), `${volume(B('R:A:0')).toFixed(2)} ${box('R:A:0').join()} ${r.errors.join('; ')}`);
}
// ---- a mirrored copy: the change is mirrored
{
  const mir: Feature = { id: 'M', name: 'M', type: 'transform', bodies: ['A'], copy: true, link: true, op: { kind: 'mirror', plane: { origin: [-5, 0, 0], normal: [1, 0, 0], xDir: [0, 1, 0] } } } as unknown as Feature;
  const notch = block('N', 4, 10, 5, [16, 0, 0]);
  const r = await after([...A, mir, ...notch, cut('cut', 'A', 'N')]);
  // The original now 0..16; mirrored about x = -5: -26..-10.
  check('a mirrored copy: the far end cut off the original is cut off its far end, mirrored', !r.errors.length && near(volume(B('M:A:0')), 800, 1e-3) && box('M:A:0').join() === [-26, 0, 0, -10, 10, 5].join() && sound() && volume(B('M:A:0')) > 0, `${volume(B('M:A:0')).toFixed(2)} ${box('M:A:0').join()} ${r.errors.join('; ')}`);
}
// ---- a linked pattern: one changed, all changed
{
  const pat: Feature = { id: 'L', name: 'L', type: 'transform', bodies: ['A'], copy: false, link: true, op: { kind: 'linear', dir: [0, 1, 0], spacing: 20, count: 4 } } as unknown as Feature;
  const r = await after([...A, pat, ...peg('P', 5, 45), cut('cut', 'L:A:1', 'P')]);
  const ids = ['A', 'L:A:0', 'L:A:1', 'L:A:2'];
  check('a linked pattern of four, a hole cut in the third: all four have it', !r.errors.length && ids.every(id => near(volume(B(id)), 1000 - hole, 1e-3)) && sound(), ids.map(id => volume(B(id)).toFixed(1)).join(' ') + ' ' + r.errors.join('; '));
  check('  each where the pattern put it', ids.map(id => box(id)[1]).join() === '0,20,40,60', ids.map(id => box(id)[1]).join());
  const plain = await after([...A, { ...pat, link: undefined } as Feature, ...peg('P', 5, 45), cut('cut', 'L:A:1', 'P')]);
  check('  not linked: only the one cut', !plain.errors.length && near(volume(B('L:A:1')), 1000 - hole, 1e-3) && ['A', 'L:A:0', 'L:A:2'].every(id => near(volume(B(id)), 1000, 1e-3)));
  const ring: Feature = { id: 'O', name: 'O', type: 'transform', bodies: ['A'], copy: false, link: true, op: { kind: 'circular', axis: { origin: [-30, 0, 0], dir: [0, 0, 1] }, count: 5, angle: 360 } } as unknown as Feature;
  const rr = await after([...A, ring, ...peg('P', 5, 5), cut('cut', 'A', 'P')]);
  const all = ['A', 'O:A:0', 'O:A:1', 'O:A:2', 'O:A:3'];
  check('a linked pattern round an axis, a hole cut in the first: all five have it', !rr.errors.length && all.every(id => near(volume(B(id)), 1000 - hole, 1e-3)) && sound(), all.map(id => volume(B(id)).toFixed(1)).join(' ') + ' ' + rr.errors.join('; '));
}
// ---- one of them moved afterwards: only it moves, and it still follows
{
  const shift: Feature = { id: 'S', name: 'S', type: 'transform', bodies: ['C:A:0'], copy: false, op: { kind: 'move', translate: [0, 0, 30] } } as unknown as Feature;
  const r = await after([...A, move('C', 'A', [50, 0, 0]), shift, ...peg('P', 5, 5), cut('cut', 'A', 'P')]);
  check('a linked copy moved later: only it moved, and it still follows', !r.errors.length && box('A').join() === [0, 0, 0, 20, 10, 5].join() && box('C:A:0').join() === [50, 0, 30, 70, 10, 35].join() && near(volume(B('C:A:0')), 1000 - hole, 1e-3), `${box('C:A:0').join()} ${volume(B('C:A:0')).toFixed(2)}`);
}
// ---- a copy of a copy is of the same group
{
  const r = await after([...A, move('C', 'A', [50, 0, 0]), move('D', 'C:A:0', [0, 30, 0]), ...peg('P', 55, 35), cut('cut', 'D:C:A:0:0', 'P')]);
  check('a linked copy of a linked copy, cut: the copy and the original follow', !r.errors.length && ['A', 'C:A:0', 'D:C:A:0:0'].every(id => near(volume(B(id)), 1000 - hole, 1e-3)), ['A', 'C:A:0', 'D:C:A:0:0'].map(id => volume(B(id)).toFixed(1)).join(' ') + ' ' + r.errors.join('; '));
}
// ---- one deleted: the others stay, and still follow each other
{
  const del: Feature = { id: 'X', name: 'X', type: 'delete', bodies: ['C:A:0'] } as unknown as Feature;
  const r = await after([...A, move('C', 'A', [50, 0, 0]), move('D', 'A', [0, 30, 0]), del, ...peg('P', 5, 5), cut('cut', 'A', 'P')]);
  check('one of three deleted: gone, the other two still follow', !r.errors.length && !B('C:A:0') && near(volume(B('A')), 1000 - hole, 1e-3) && near(volume(B('D:A:0')), 1000 - hole, 1e-3));
}
// ---- changed again and built again: the same (what is kept from the last build is right)
{
  const steps = (x: number) => [...A, move('C', 'A', [50, 0, 0]), ...peg('P', x, 5), cut('cut', 'A', 'P')];
  await after(steps(5));
  const first = box('C:A:0').join();
  const r = await after(steps(21.5));
  // The peg half off the end: a half hole (half of 62.83, about) - the copy's too.
  check('the hole moved half off the end and built again: the copy has that', !r.errors.length && near(volume(B('C:A:0')), volume(B('A')), 1e-6) && volume(B('A')) > 1000 - hole + 1 && box('C:A:0').join() === first, `${volume(B('A')).toFixed(2)} ${volume(B('C:A:0')).toFixed(2)}`);
  const back = await after(steps(5));
  check('and back', !back.errors.length && near(volume(B('C:A:0')), 1000 - hole, 1e-3));
}
done();
