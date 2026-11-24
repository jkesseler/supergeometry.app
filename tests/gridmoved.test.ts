// A body moved, turned, mirrored or copied in a pattern: its faces are still the faces of the
// steps that made them (they used to become the Move's own), so a pick on it follows the body
// when an earlier step changes, a Move put in before a step leaves the step its picks, and
// picks saved the old way (naming the Move) are still found.
import { block, circle, done, extrude, sketch, XY, after } from './kit';
import { build, near, say } from './grid';
import type { Feature, Vec3 } from '../src/doc/types';
import type { BodyMesh, EdgeInfo, FaceInfo } from '../src/kernel/protocol';

const dist = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
/** The block: `width` x 20 x `height` from the origin, its sketch's curves named by the kit. */
const base = (width = 20, height = 10) => block('A', width, 20, height);
const move = (by: Vec3, turn = 0): Feature => ({ id: 'M', name: 'M', type: 'transform', bodies: ['A'], copy: false, op: { kind: 'move', translate: by, ...(turn ? { rotate: { origin: [0, 0, 0], axis: [0, 0, 1], angle: turn } } : {}) } }) as unknown as Feature;
const shown = async (fs: Feature[]) => {
  const { r, errors } = await after(fs);

  return { errors, bodies: new Map(r.bodies.map(b => [b.id, b] as [string, BodyMesh])) };
};
const faceRef = (body: string, faceInfo: FaceInfo) => ({ body, center: faceInfo.center, normal: faceInfo.normal, area: faceInfo.area, ...(faceInfo.step ? { step: faceInfo.step } : {}), ...(faceInfo.curve ? { curve: faceInfo.curve } : {}) });
const edgeRef = (body: string, e: EdgeInfo) => ({ body, mid: e.mid, dir: e.dir, length: e.length, ...(e.steps ? { steps: e.steps } : {}), ...(e.curves ? { curves: e.curves } : {}) });
const fillet = (edges: unknown[], radius = 3): Feature => ({ id: 'F', name: 'F', type: 'fillet', radius, edges }) as unknown as Feature;
/** Where a body's one rounded (fillet) face is. */
const roundAt = (b: BodyMesh | undefined) => b?.faces.find(face => face.type === 'CYLINDRE')?.center;
const ROUND = (1 - Math.PI / 4) * 9;

// ------------------------------------------------------------------ whose faces a moved body's are
{
  const still = await shown(base());
  const was = still.bodies.get('A')!;
  for (const [name, by, turn] of [['moved', [100, 0, 0], 0], ['moved and turned', [30, -40, 7], 35]] as const) {
    const now = (await shown([...base(), move(by as unknown as Vec3, turn)])).bodies.get('A')!;
    const same = now.faces.length === was.faces.length && now.faces.every((face, i) => face.step === was.faces[i].step && face.curve === was.faces[i].curve && face.type === was.faces[i].type);
    say(same && now.faces.every(face => face.step === 'A' && !!face.curve), `a block ${name}: each face still the extrude's, and the same one of its faces`, JSON.stringify(now.faces.map(face => [face.step, face.curve])));
    say(now.faces.every(face => face.was === 'M') && now.edges.every(e => e.was?.every(origin => origin === 'M')), '...with the Move kept beside, as what picks saved before name it by', JSON.stringify(now.faces.map(face => face.was)));
    say(now.edges.every((e, i) => e.steps?.join() === was.edges[i].steps?.join() && e.curves?.join() === was.edges[i].curves?.join()) && now.edges.every(e => !!e.curves), '...and each edge between the same two of them', JSON.stringify(now.edges.map(e => e.curves)));
  }
}

// ------------------------------------------------------------------ a pick on a moved body follows the body
{
  const by: Vec3 = [100, 0, 0];
  const first = (await shown([...base(), move(by)])).bodies.get('A')!;
  // The upright edge at the corner that was (20, 20), now (120, 20).
  const corner = first.edges.find(e => dist(e.mid, [120, 20, 5]) < 1e-6)!;
  const ref = edgeRef('A', corner);
  let got = await build([...base(), move(by), fillet([ref])]);
  let at = roundAt((await shown([...base(), move(by), fillet([ref])])).bodies.get('A'));
  say(!got.errors.length && !got.unsound.length && near(got.vol.A, 4000 - ROUND * 10) && !!at && at[0] > 115, 'a corner of a moved block rounded', `${got.errors.join(' | ')} ${got.unsound} ${got.vol.A} at ${at}`);
  // The block made three times as wide: the corner is at (160, 20) now, and the pick's old place is
  // nearer the corner at (100, 20) - which is the one that used to be rounded, with no word.
  got = await build([...base(60), move(by), fillet([ref])]);
  at = roundAt((await shown([...base(60), move(by), fillet([ref])])).bodies.get('A'));
  say(!got.errors.length && !got.unsound.length && near(got.vol.A, 12000 - ROUND * 10) && !!at && at[0] > 155, '...the block made three times as wide: the same corner, where it is now', `${got.errors.join(' | ')} ${got.unsound} ${got.vol.A} at ${at}`);
  // Taller as well: still that corner, its whole height.
  got = await build([...base(60, 25), move(by), fillet([ref])]);
  say(!got.errors.length && !got.unsound.length && near(got.vol.A, 30000 - ROUND * 25), '...and taller: the same corner, all the way up', `${got.errors.join(' | ')} ${got.unsound} ${got.vol.A}`);
  // A face picked on it: its top pushed up by 5 - and still its top when the block is made taller.
  const top = first.faces.find(face => face.normal[2] > 0.99)!;
  const push: Feature = { id: 'P', name: 'P', type: 'moveFace', face: faceRef('A', top), translate: [0, 0, 5] } as unknown as Feature;
  got = await build([...base(), move(by), push]);
  say(!got.errors.length && !got.unsound.length && near(got.vol.A, 6000), 'the top of a moved block pushed up by 5', `${got.errors.join(' | ')} ${got.unsound} ${got.vol.A}`);
  got = await build([...base(20, 40), move(by), push]);
  say(!got.errors.length && !got.unsound.length && near(got.vol.A, 18000), '...the block made four times as tall: still its top', `${got.errors.join(' | ')} ${got.unsound} ${got.vol.A}`);
}

// ------------------------------------------------------------------ picks saved before (they name the Move)
{
  const by: Vec3 = [100, 0, 0];
  const old = { body: 'A', mid: [120, 20, 5], dir: [0, 0, 1], length: 10, steps: ['M', 'M'] };
  let got = await build([...base(), move(by), fillet([old])]);
  const at = roundAt((await shown([...base(), move(by), fillet([old])])).bodies.get('A'));
  say(!got.errors.length && !got.unsound.length && near(got.vol.A, 4000 - ROUND * 10) && !!at && at[0] > 115, 'an edge pick saved the old way (it names the Move): found as before', `${got.errors.join(' | ')} ${got.unsound} ${got.vol.A} at ${at}`);
  const oldTop = { body: 'A', center: [110, 10, 10], normal: [0, 0, 1], area: 400, step: 'M' };
  got = await build([...base(), move(by), { id: 'P', name: 'P', type: 'moveFace', face: oldTop, translate: [0, 0, 5] } as unknown as Feature]);
  say(!got.errors.length && !got.unsound.length && near(got.vol.A, 6000), 'a face pick saved the old way: found as before', `${got.errors.join(' | ')} ${got.unsound} ${got.vol.A}`);
}

// ------------------------------------------------------------------ a Move put in before a step
{
  // A corner rounded on the block where it was made; then a Move put in before the rounding.
  const still = (await shown(base())).bodies.get('A')!;
  const corner = still.edges.find(e => dist(e.mid, [20, 20, 5]) < 1e-6)!;
  const ref = edgeRef('A', corner);
  let got = await build([...base(), fillet([ref])]);
  say(!got.errors.length && near(got.vol.A, 4000 - ROUND * 10), 'a corner rounded on the block as made', `${got.errors.join(' | ')} ${got.vol.A}`);
  for (const [name, by, turn, want] of [['moved 100 along', [100, 0, 0], 0, [120, 20]], ['turned a quarter and moved', [0, 50, 0], 90, [-20, 70]]] as const) {
    got = await build([...base(), move(by as unknown as Vec3, turn), fillet([ref])]);
    const at = roundAt((await shown([...base(), move(by as unknown as Vec3, turn), fillet([ref])])).bodies.get('A'));
    say(!got.errors.length && !got.unsound.length && near(got.vol.A, 4000 - ROUND * 10) && !!at && Math.hypot(at[0] - want[0], at[1] - want[1]) < 4, `...the block ${name} before the rounding: the same corner rounded, where it went`, `${got.errors.join(' | ')} ${got.unsound} ${got.vol.A} at ${at}`);
  }
}

// ------------------------------------------------------------------ a pattern's copies, a mirrored copy
{
  const row: Feature = { id: 'R', name: 'R', type: 'transform', bodies: ['A'], copy: true, op: { kind: 'linear', dir: [1, 0, 0], spacing: 40, count: 3 } } as unknown as Feature;
  const all = await shown([...base(), row]);
  const [a, c1, c2] = [all.bodies.get('A')!, all.bodies.get('R:A:0')!, all.bodies.get('R:A:1')!];
  say(!!c1 && !!c2 && [c1, c2].every(bodyMesh => bodyMesh.faces.every((face, i) => face.step === 'A' && face.curve === a.faces[i].curve && face.was === 'R')), "a row's copies: each face the extrude's, the same one as the first's", JSON.stringify(c2?.faces.map(face => [face.step, face.curve, face.was])));
  // The second copy's top pushed up; then the first made taller: the copy's top still.
  const top = c2.faces.find(face => face.normal[2] > 0.99)!;
  const push: Feature = { id: 'P', name: 'P', type: 'moveFace', face: faceRef('R:A:1', top), translate: [0, 0, 5] } as unknown as Feature;
  let got = await build([...base(), row, push]);
  say(!got.errors.length && !got.unsound.length && near(got.vol['R:A:1'], 6000) && near(got.vol.A, 4000), "the top of a row's second copy pushed up by 5", `${got.errors.join(' | ')} ${got.unsound} ${JSON.stringify(got.vol)}`);
  got = await build([...base(20, 30), row, push]);
  say(!got.errors.length && !got.unsound.length && near(got.vol['R:A:1'], 14000) && near(got.vol.A, 12000), "...the first made three times as tall: the copy's top still", `${got.errors.join(' | ')} ${got.unsound} ${JSON.stringify(got.vol)}`);
  // Mirrored in the plane x = -10: the side that was at x = 20 is at x = -40, and known for the same side.
  const mirror: Feature = { id: 'Mi', name: 'Mi', type: 'transform', bodies: ['A'], copy: true, op: { kind: 'mirror', plane: { origin: [-10, 0, 0], xDir: [0, 1, 0], normal: [1, 0, 0] } } } as unknown as Feature;
  const both = await shown([...base(), mirror]);
  const twin = both.bodies.get('Mi:A:0')!;
  const side = both.bodies.get('A')!.faces.find(face => face.normal[0] > 0.99)!;
  const there = twin?.faces.filter(face => face.curve === side.curve && face.step === side.step);
  say(there?.length === 1 && Math.abs(there[0].center[0] + 40) < 1e-6 && there[0].normal[0] < -0.99, 'a mirrored copy: the side that was at x = 20 known for the same side, at x = -40', JSON.stringify(there?.map(faceInfo => [faceInfo.center, faceInfo.normal, faceInfo.curve])));
  got = await build([...base(), mirror, { id: 'P', name: 'P', type: 'moveFace', face: faceRef('Mi:A:0', there[0]), translate: [-5, 0, 0] } as unknown as Feature]);
  say(!got.errors.length && !got.unsound.length && near(got.vol['Mi:A:0'], 5000), '...and pulled out by 5', `${got.errors.join(' | ')} ${got.unsound} ${JSON.stringify(got.vol)}`);
}

// ------------------------------------------------------------------ worked on after it was moved
{
  // A hole cut into the moved block: the hole's wall is the cut's, the rest still the extrude's same faces.
  const by: Vec3 = [100, 0, 0];
  const hole = sketch('h', XY(10), [circle('c', 110, 10, 4)]);
  const fs = [...base(), move(by), hole, extrude('hc', hole, -10, 'cut', { target: 'A' })];
  const still = (await shown(base())).bodies.get('A')!;
  const cut = (await shown(fs)).bodies.get('A')!;
  const got = await build(fs);
  const topWas = still.faces.find(face => face.normal[2] > 0.99)!;
  const topNow = cut.faces.find(face => face.normal[2] > 0.99 && face.type === 'PLANE')!;
  say(!got.errors.length && near(got.vol.A, 4000 - Math.PI * 16 * 10) && cut.faces.filter(face => face.step === 'hc').length === 1 && topNow.step === 'A' && topNow.curve === topWas.curve && topNow.was === 'M', "a hole cut into a moved block: its wall the cut's, the top (now with a hole) still the extrude's top", JSON.stringify(cut.faces.map(face => [face.step, face.curve, face.was])));
}

done();
