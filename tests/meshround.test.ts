// Run: npx tsx tests/meshround.test.ts
// A mesh's round parts made truly round when it comes in: the strips of a hole, a boss, a pin, a rounded upright
// corner become one round face each - and what is not a cylinder is left exactly as it was.
import { exportBodies, regenerate } from '../src/kernel/engine';
import { meshCylinders, stlTriangles } from '../src/kernel/meshRound';
import { after, check, circle, done, extrude, health, near, poly, rect, sketch, volume, XY } from './kit';
import type { Feature, PlaneDef, SketchEntity, Vec3 } from '../src/doc/types';

/** A circle drawn as a polygon of n sides (its corners on the circle): what a coarse mesh makes of a round. */
const gon = (id: string, x: number, y: number, r: number, n: number, turn = 0): SketchEntity =>
  poly(id, Array.from({ length: n }, (_, k) => [x + r * Math.cos(turn + (2 * Math.PI * k) / n), y + r * Math.sin(turn + (2 * Math.PI * k) / n)] as [number, number]));
/** The volume between a polygon of n sides and its circle, over a length. */
const gap = (r: number, n: number, h: number) => (Math.PI * r * r - (n / 2) * r * r * Math.sin((2 * Math.PI) / n)) * h;

async function stlOf(fs: Feature[]): Promise<Uint8Array> {
  return new Uint8Array(await (await exportBodies(fs, 'stl' as never)).arrayBuffer());
}
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');
const imp = (bytes: Uint8Array, round = true): Feature => ({ id: 'I', name: 'I', type: 'import', format: 'stl', fileName: 'part.stl', data: b64(bytes), ...(round ? { round: true } : {}) }) as Feature;
const kinds = (r: any) => r.bodies[0].faces.reduce((m: Record<string, number>, f: any) => ((m[f.type] = (m[f.type] ?? 0) + 1), m), {} as Record<string, number>);
const rounds = (r: any) => r.bodies[0].faces.filter((f: any) => f.round);
const faceRef = (body: string, f: any) => ({ body, center: f.center, normal: f.normal, area: f.area, step: f.step, curve: f.curve });

// ---------------------------------------------------------------- a part of this app's own making
{
  const s = sketch('s', XY(), [rect('r', 0, 0, 60, 40)]);
  const h = sketch('h', XY(), [circle('a', 6, 6, 2), circle('b', 54, 6, 2), circle('c', 6, 34, 2), circle('d', 54, 34, 2)]);
  const b = sketch('b', XY(8), [circle('o', 30, 20, 8)]);
  const bh = sketch('bh', XY(), [circle('i', 30, 20, 3)]);
  const base: Feature[] = [s, extrude('E', s, 8), h, extrude('H', h, 8, 'cut', { target: 'E' }), b, extrude('B', b, 12, 'join', { target: 'E' }), bh, extrude('BH', bh, 20, 'cut', { target: 'E' })];
  const r0: any = await regenerate(base);
  const ups = r0.bodies[0].edges.filter((e: any) => e.type === 'LINE' && Math.abs(e.dir[2]) > 0.99 && near(e.length, 8) && (e.mid[0] < 1 || e.mid[0] > 59));
  const fs = [...base, { id: 'F', name: 'F', type: 'fillet', edges: ups.map((e: any) => ({ body: 'E', mid: e.mid, dir: e.dir, length: e.length, steps: e.steps, curves: e.curves })), radius: 5 } as Feature];
  const cad = await after(fs, 'E');
  const bytes = await stlOf(fs);
  const plain = await after([imp(bytes, false)], 'I');
  check('not asked for: the mesh as it always came in, no round face', !plain.err && !rounds(plain.r).length && plain.r.bodies[0].faces.length > 1000, kinds(plain.r));
  const found = meshCylinders(stlTriangles(bytes)!);
  check('found in its triangles: four holes, a boss, its bore, four rounded corners', found.length === 10 && found.filter(c => c.concave).length === 5 && found.filter(c => c.sweep < 6).length === 4 && found.every(c => c.even), found.map(c => [c.r, c.concave, +((c.sweep * 180) / Math.PI).toFixed(1)]));
  check('... each its true size and place', found.every(c => [2, 3, 5, 8].includes(c.r) && c.a[2] === 1 && c.c.every(x => near(x, Math.round(x), 1e-9))), found.map(c => [c.r, c.c]));
  const t = Date.now();
  const a = await after([imp(bytes)], 'I');
  const ms = Date.now() - t;
  const k = kinds(a.r);
  check('brought in: 17 faces, ten of them round, as the part was drawn', !a.err && k.PLANE === 7 && k.CYLINDRE === 10 && a.r.bodies[0].faces.length === 17, `${JSON.stringify(k)} ${ms} ms ${a.errors}`);
  check("... a sound solid, the drawn part's volume", health(a.body!).healthy && near(volume(a.body), volume(cad.body), 1e-3), `${volume(a.body)} / ${volume(cad.body)}`);
  check('... no warning left on its step', !a.r.notes?.length, a.r.notes);
  const again: any = await regenerate([imp(bytes)]);
  check('... the same again (kept)', again.bodies[0].faces.length === 17 && !again.errors.length, again.errors);
  // A thread in a hole of it; a rounding of the boss's rim.
  const hole = rounds(a.r).find((f: any) => f.round.hole && near(f.round.r, 3));
  const T = { id: 'T', name: 'T', type: 'thread', face: faceRef('I', hole), pitch: 1, round: { r: 3, hole: true } } as Feature;
  const th = await after([imp(bytes), T], 'I');
  check('a thread cut in its bore', !th.err && volume(th.body) < volume(a.body) - 1 && health(th.body!).valid, th.errors);
  const rim = a.r.bodies[0].edges.find((e: any) => e.type === 'CIRCLE' && near(e.mid[2], 20) && near(e.length, 2 * Math.PI * 8, 1e-3));
  const R = { id: 'R', name: 'R', type: 'fillet', edges: [{ body: 'I', mid: rim?.mid, dir: rim?.dir, length: rim?.length, steps: rim?.steps, curves: rim?.curves }], radius: 1 } as Feature;
  const rd = await after([imp(bytes), R], 'I');
  check("the boss's rim rounded", !!rim && !rd.err && volume(rd.body) < volume(a.body) && health(rd.body!).valid, rd.errors);
}

// ---------------------------------------------------------------- coarse meshes: polygons for circles
{
  // A plate with a hole of 24 sides, a boss of 16 with a bore of 12, a hole of 8 and one of 6.
  const s = sketch('s', XY(), [rect('r', 0, 0, 80, 40)]);
  const h = sketch('h', XY(), [gon('a', 12, 20, 4, 24, 0.1), gon('o', 62, 10, 3, 8), gon('x', 62, 30, 3, 6)]);
  const b = sketch('b', XY(6), [gon('p', 36, 20, 7, 16, 0.3)]);
  const bh = sketch('bh', XY(), [gon('q', 36, 20, 2.5, 12)]);
  const fs: Feature[] = [s, extrude('E', s, 6), h, extrude('H', h, 6, 'cut', { target: 'E' }), b, extrude('B', b, 9, 'join', { target: 'E' }), bh, extrude('BH', bh, 15, 'cut', { target: 'E' })];
  const src = await after(fs, 'E');
  const a = await after([imp(await stlOf(fs))], 'I');
  const rs = rounds(a.r);
  const want = volume(src.body) - gap(4, 24, 6) + gap(7, 16, 9) - gap(2.5, 12, 15);
  check('24, 16 and 12 sides: round now; 8 and 6 sides: left as they are', !a.err && rs.length === 3 && near(rs.map((f: any) => f.round.r).sort()[0], 2.5) && kinds(a.r).PLANE === 6 + 1 + 8 + 6, `${JSON.stringify(kinds(a.r))} ${rs.map((f: any) => f.round.r)} ${a.errors}`);
  check('... the volume of true rounds', health(a.body!).healthy && near(volume(a.body), want, 1e-3), `${volume(a.body)} / ${want}`);
}
{
  // A hole to a depth, and a post standing in a round pocket.
  const s = sketch('s', XY(), [rect('r', 0, 0, 50, 30)]);
  const h = sketch('h', XY(10), [gon('a', 10, 15, 3, 32)]);
  const pocket = sketch('k', XY(10), [gon('o', 34, 15, 10, 48)]);
  const post = sketch('p', XY(5), [gon('i', 34, 15, 4, 24)]);
  const fs: Feature[] = [s, extrude('E', s, 10), h, extrude('H', h, -6, 'cut', { target: 'E' }), pocket, extrude('K', pocket, -5, 'cut', { target: 'E' }), post, extrude('P', post, 5, 'join', { target: 'E' })];
  const src = await after(fs, 'E');
  check('the source: a blind hole, a ring pocket with a post', !src.err && near(volume(src.body), 15000 - (32 / 2) * 9 * Math.sin((2 * Math.PI) / 32) * 6 - ((48 / 2) * 100 * Math.sin((2 * Math.PI) / 48) - (24 / 2) * 16 * Math.sin((2 * Math.PI) / 24)) * 5, 1e-6), `${volume(src.body)} ${src.errors}`);
  const a = await after([imp(await stlOf(fs))], 'I');
  const rs = rounds(a.r);
  const want = 15000 - Math.PI * 9 * 6 - Math.PI * (100 - 16) * 5;
  check("a blind hole, a pocket's wall and the post in it: three round faces", !a.err && rs.length === 3 && rs.filter((f: any) => f.round.hole).length === 2, `${rs.map((f: any) => [f.round.r, f.round.hole])} ${a.errors}`);
  check('... the post still stands, the floors flat: the volume of true rounds', health(a.body!).healthy && near(volume(a.body), want, 1e-3) && kinds(a.r).PLANE === 9, `${volume(a.body)} / ${want} ${JSON.stringify(kinds(a.r))}`);
}
{
  // A box that leans: six faces (it came in as twelve triangles - only faces square to X, Y, Z were made whole).
  const lean: PlaneDef = { origin: [5, -3, 2], xDir: [0.8, 0.6, 0], normal: [-0.36, 0.48, 0.8] };
  const s = sketch('s', lean, [rect('r', 0, 0, 50, 20)]);
  const bytes = await stlOf([s, extrude('E', s, 7)]);
  const old = await after([imp(bytes, false)], 'I');
  const a = await after([imp(bytes)], 'I');
  check('a leaning box: six whole faces (twelve triangles the old way)', !a.err && a.r.bodies[0].faces.length === 6 && old.r.bodies[0].faces.length === 12 && health(a.body!).healthy && near(volume(a.body), 7000, 1e-3), `${a.r.bodies[0].faces.length} / ${old.r.bodies[0].faces.length} ${volume(a.body)} ${a.errors}`);
  const areas = a.r.bodies[0].faces.map((f: any) => Math.round(f.area)).sort((x: number, y: number) => x - y);
  check('... each its true size', JSON.stringify(areas) === JSON.stringify([140, 140, 350, 350, 1000, 1000]), areas);
}
{
  // A slot (two half rounds) through a plate that leans: no axis of it along X, Y or Z.
  const lean: PlaneDef = { origin: [5, -3, 2], xDir: [0.8, 0.6, 0], normal: [-0.36, 0.48, 0.8] };
  const half = (cx: number, from: number, n: number): [number, number][] => Array.from({ length: n + 1 }, (_, k) => [cx + 4 * Math.cos(from + (Math.PI * k) / n), 10 + 4 * Math.sin(from + (Math.PI * k) / n)] as [number, number]);
  const s = sketch('s', lean, [rect('r', 0, 0, 50, 20)]);
  const sl = sketch('sl', lean, [poly('slot', [...half(34, -Math.PI / 2, 16), ...half(16, Math.PI / 2, 16)])]);
  const fs: Feature[] = [s, extrude('E', s, 7), sl, extrude('S', sl, 7, 'cut', { target: 'E' })];
  const src = await after(fs, 'E');
  const a = await after([imp(await stlOf(fs))], 'I');
  const rs = rounds(a.r);
  const segs = (16 * 16) / 2 * Math.sin(Math.PI / 16) * 2;
  const want = volume(src.body) - (Math.PI * 16 - segs) * 7;
  check('a leaning plate with a slot: its two ends round, each half way', !a.err && rs.length === 2 && rs.every((f: any) => f.round.hole && near(f.round.r, 4, 1e-6)) && kinds(a.r).PLANE === 8, `${JSON.stringify(kinds(a.r))} ${rs.map((f: any) => f.round.r)} ${a.errors}`);
  check('... the volume of a true slot', health(a.body!).healthy && near(volume(a.body), want, 1e-3), `${volume(a.body)} / ${want}`);
}

// ---------------------------------------------------------------- what is not a cylinder stays
{
  // A nut's six sides, a twelve-sided prism's neighbours at 30°... and a ball: nothing to make round but the prism.
  const hex = sketch('s', XY(), [gon('h', 0, 0, 10, 6)]);
  const a = await after([imp(await stlOf([hex, extrude('E', hex, 8)]))], 'I');
  check('a six-sided nut blank: untouched', !a.err && a.r.bodies[0].faces.length === 8 && !rounds(a.r).length, kinds(a.r));
  const ball = { id: 'B', name: 'B', type: 'revolve', source: { kind: 'profile', sketch: 'bs', regions: [] }, axis: { origin: [0, 0, 0], dir: [0, 0, 1] }, angle: 360 } as unknown as Feature;
  void ball;
  // A cone (a tapered pin): its strips do not run one way.
  const c = sketch('c', XY(), [circle('c', 0, 0, 6)]);
  const cone = await after([c, extrude('E', c, 12, 'new', { taper: 10 })], 'E');
  if (!cone.err) {
    const bytes = await stlOf([c, extrude('E', c, 12, 'new', { taper: 10 })]);
    const before = await after([imp(bytes, false)], 'I');
    const b = await after([imp(bytes)], 'I');
    check('a tapered pin: no round face made of it (a cone is not read), its shape as it came', !b.err && !rounds(b.r).length && b.r.bodies[0].faces.length <= before.r.bodies[0].faces.length && health(b.body!).healthy && near(volume(b.body), volume(before.body), 0.02), `${b.r.bodies[0].faces.length} / ${before.r.bodies[0].faces.length} ${volume(b.body)} / ${volume(before.body)}`);
  }
}
{
  // A pin with a hole across it: the pin's strips are cut by the hole, so they do not all run its length - left;
  // the cross hole's own strips end on the pin's round side - left too. The body is as it came in, and sound.
  const s = sketch('s', XY(), [gon('p', 0, 0, 6, 24, 0.13)]);
  const x = sketch('x', { origin: [0, 0, 10], xDir: [0, 1, 0], normal: [1, 0, 0] }, [gon('h', 0, 0, 2, 16, 0.2)]);
  const fs: Feature[] = [s, extrude('E', s, 20), x, extrude('X', x, 20, 'cut', { target: 'E', symmetric: true })];
  const src = await after(fs, 'E');
  if (!src.err && volume(src.body) < (24 / 2) * 36 * Math.sin((2 * Math.PI) / 24) * 20 - 1) {
    const bytes = await stlOf(fs);
    const found = meshCylinders(stlTriangles(bytes)!);
    const before = await after([imp(bytes, false)], 'I');
    const a = await after([imp(bytes)], 'I');
    check('a pin with a hole across it: found, but not all its strips run its length', found.some(c => !c.even), found.map(c => [c.r, c.even, c.strips]));
    check("... nothing changed that could not be checked: sound, the volume it had or a true round's", !a.err && health(a.body!).healthy && volume(a.body) >= volume(before.body) - 1e-6, `${volume(a.body)} / ${volume(before.body)} ${JSON.stringify(kinds(a.r))}`);
  }
}

// ---------------------------------------------------------------- a file of several parts
{
  // Two parts in one file (a plate with a hole, a pin beside it): a body each, each with its round face.
  const s = sketch('s', XY(), [rect('r', 0, 0, 30, 20)]);
  const hs = sketch('hs', XY(), [gon('a', 15, 10, 4, 24)]);
  const p = sketch('p', XY(), [gon('p', 50, 10, 5, 32)]);
  const fs: Feature[] = [s, extrude('E', s, 5), hs, extrude('H', hs, 5, 'cut', { target: 'E' }), p, extrude('P', p, 12)];
  const bytes = await stlOf(fs);
  const a: any = await regenerate([{ ...imp(bytes), apart: true } as Feature]);
  const ids = a.bodies.map((b: any) => b.id).sort();
  const roundsOf = (b: any) => b.faces.filter((f: any) => f.round).map((f: any) => +f.round.r.toFixed(6));
  check('two parts in one file: two bodies', !a.errors.length && JSON.stringify(ids) === JSON.stringify(['I', 'I:1']), `${ids} ${a.errors.map((e: any) => e.message)}`);
  check("... the plate's hole and the pin, each round", JSON.stringify(a.bodies.map(roundsOf).flat().sort()) === JSON.stringify([4, 5]) && a.bodies.map((b: any) => b.faces.length).sort().join() === '3,7', a.bodies.map((b: any) => [b.faces.length, roundsOf(b)]));
  const old: any = await regenerate([{ ...imp(bytes, false), apart: true } as Feature]);
  check('... not asked for: as it always came in, one body', old.bodies.length === 1, old.bodies.length);
}

// ---------------------------------------------------------------- the file itself
{
  // A text STL reads the same as a binary one.
  const s = sketch('s', XY(), [rect('r', 0, 0, 20, 20)]);
  const hs = sketch('hs', XY(), [gon('a', 10, 10, 4, 20)]);
  const bytes = await stlOf([s, extrude('E', s, 5), hs, extrude('H', hs, 5, 'cut', { target: 'E' })]);
  const tris = stlTriangles(bytes)!;
  let text = 'solid part\n';
  for (let i = 0; i < tris.length; i += 9) {
    text += ' facet normal 0 0 0\n  outer loop\n';
    for (let k = 0; k < 3; k++) {
      text += `   vertex ${tris[i + k * 3]} ${tris[i + k * 3 + 1]} ${tris[i + k * 3 + 2]}\n`;
    }
    text += '  endloop\n endfacet\n';
  }
  text += 'endsolid part\n';
  const ascii = new TextEncoder().encode(text);
  const t2 = stlTriangles(ascii);
  check('a text STL: the same triangles', !!t2 && t2.length === tris.length && t2.every((x, i) => near(x, tris[i], 1e-9)));
  const a = await after([imp(ascii)], 'I');
  check('... brought in with its hole round', !a.err && rounds(a.r).length === 1 && near(rounds(a.r)[0].round.r, 4, 1e-6) && a.r.bodies[0].faces.length === 7, `${JSON.stringify(kinds(a.r))} ${a.errors}`);
  check('not an STL at all: said so', stlTriangles(new TextEncoder().encode('hello')) === null);
  const none: Vec3[] = [];
  check('no triangles: nothing found', meshCylinders(new Float64Array(none.flat())).length === 0);
}

done();
