// Run: npx tsx tests/hole.test.ts
// The Hole step: a screw's hole drilled into a flat face - plain, with a counterbore, with a countersink; right
// through or to a depth; and that it stays where it belongs when what is before it changes.
import { regenerate } from '../src/kernel/engine';
import { holeFor, screwSize, SCREW_SIZES, sinkDepth } from '../src/doc/holeSizes';
import { after, check, circle, done, extrude, health, near, rect, sketch, volume, XY, XZ } from './kit';
import type { Feature, HoleFeature, Vec3 } from '../src/doc/types';

const PI = Math.PI;
const faceRef = (body: string, f: any) => ({ body, center: f.center, normal: f.normal, area: f.area, step: f.step, curve: f.curve });
const edgeRef = (body: string, e: any) => ({ body, mid: e.mid, dir: e.dir, length: e.length, steps: e.steps, curves: e.curves });
const facing = (r: any, n: Vec3, body = 0) => r.bodies[body].faces.filter((f: any) => f.type === 'PLANE' && f.normal[0] * n[0] + f.normal[1] * n[1] + f.normal[2] * n[2] > 0.999);
const hole = (id: string, face: any, at: Vec3, more: Partial<HoleFeature> = {}): Feature =>
  ({ id, name: id, type: 'hole', face, at, ...holeFor(screwSize('M3')!, more.head ?? 'none'), through: true, depth: 5, head: 'none', ...more }) as Feature;

// ---------------------------------------------------------------- the table
check("the table: every size's hole is wider than its screw, its recesses wider than the hole", SCREW_SIZES.every(s => s.clearance > s.d && s.bore > s.clearance && s.sink > s.clearance && s.boreDepth > s.d));
check('the table: sizes go up', SCREW_SIZES.every((s, i) => !i || (s.d > SCREW_SIZES[i - 1].d && s.clearance > SCREW_SIZES[i - 1].clearance && s.bore > SCREW_SIZES[i - 1].bore)));
check("M3: 3.4 through, 6.5 x 3.4 for a cap screw's head", JSON.stringify(holeFor(screwSize('M3')!, 'counterbore')) === JSON.stringify({ size: 'M3', diameter: 3.4, headDiameter: 6.5, headDepth: 3.4 }));

// ---------------------------------------------------------------- a plate
const s = sketch('s', XY(), [rect('r', 0, 0, 40, 30)]);
const plate = (h = 10): Feature[] => [s, extrude('E', s, h)];
const r0: any = await regenerate(plate());
const top = faceRef('E', facing(r0, [0, 0, 1])[0]);
const V = 40 * 30 * 10;
const R = 1.7;

{
  const a = await after([...plate(), hole('H', top, [10, 10, 10])], 'E');
  check('M3 right through a 10 mm plate', !a.err && near(volume(a.body), V - PI * R * R * 10, 1e-6), `${volume(a.body)} ${a.errors}`);
  const h = health(a.body!);
  check('... a sound closed solid, one more face', h.healthy && h.faces === 7, h);
  const wall = a.r.bodies[0].faces.find((f: any) => f.round);
  check('... its wall is a hole of radius 1.7, made by the step', !!wall && wall.round.hole && near(wall.round.r, R) && wall.step === 'H', wall);
}
{
  const a = await after([...plate(), hole('H', top, [10, 10, 10], { through: false, depth: 4 })], 'E');
  check('to a depth of 4', !a.err && near(volume(a.body), V - PI * R * R * 4, 1e-6), `${volume(a.body)} ${a.errors}`);
}
{
  const a = await after([...plate(), hole('H', top, [10, 10, 10], { head: 'counterbore' })], 'E');
  const want = V - PI * R * R * 10 - PI * (3.25 * 3.25 - R * R) * 3.4;
  check('with a counterbore for a cap screw', !a.err && near(volume(a.body), want, 1e-6), `${volume(a.body)} / ${want} ${a.errors}`);
  check('... sound', health(a.body!).healthy);
}
{
  const f = hole('H', top, [10, 10, 10], { head: 'countersink' }) as HoleFeature;
  const a = await after([...plate(), f], 'E');
  const h = sinkDepth(f);
  const Rh = f.headDiameter / 2;
  const want = V - PI * R * R * 10 - ((PI * h) / 3) * (Rh * Rh + Rh * R + R * R) + PI * R * R * h;
  check('with a countersink: a 90° cone', !a.err && near(h, 1.55) && near(volume(a.body), want, 1e-6), `${volume(a.body)} / ${want} ${a.errors}`);
  check('... sound, with a cone', health(a.body!).healthy && a.r.bodies[0].faces.some((g: any) => g.type === 'CONE'));
}

// ---------------------------------------------------------------- what is wrong, in words
for (const [name, more, say] of [
  ['no diameter', { diameter: 0 }, 'diameter'],
  ['a recess no wider than the hole', { head: 'counterbore', headDiameter: 3 }, 'wider'],
  ['a blind hole no deeper than its recess', { head: 'counterbore', through: false, depth: 3 }, 'deeper'],
  ['no depth', { through: false, depth: 0 }, 'depth']
] as const) {
  const a = await after([...plate(), hole('H', top, [10, 10, 10], more as Partial<HoleFeature>)], 'E');
  check(`${name}: said`, !!a.err && a.err.includes(say) && near(volume(a.body), V), a.err);
}
{
  const a = await after([...plate(), hole('H', top, [100, 100, 10])], 'E');
  check('off the body: said, nothing cut', !!a.err && a.err.includes('off the body') && near(volume(a.body), V), a.err);
}

// ---------------------------------------------------------------- it stays where it belongs
{
  // The plate made thicker, thinner, and the other way: still right through, from the same face.
  for (const h of [20, 4, -10, -25]) {
    const a = await after([...plate(h), hole('H', top, [10, 10, 10], { head: 'counterbore' })], 'E');
    const want = 40 * 30 * Math.abs(h) - PI * R * R * Math.abs(h) - PI * (3.25 * 3.25 - R * R) * 3.4;
    const hh = a.body ? health(a.body) : null;
    check(`the plate made ${h}: the hole and its recess still there, on the far end`, !a.err && near(volume(a.body), want, 1e-6) && !!hh?.valid, `${volume(a.body)} / ${want} ${a.errors}`);
    // The recess is at the far end's face (not the sketch's side).
    const ring = a.r.bodies[0].faces.find((g: any) => g.type === 'PLANE' && g.step === 'H');
    check('... its recess 3.4 below the far end', !!ring && near(Math.abs(ring.center[2] - h), 3.4, 1e-6), ring?.center);
  }
}
{
  // On a boss's rim: the boss moved, the hole goes with it.
  const boss = (x: number): Feature[] => {
    const b = sketch('bs', XY(10), [circle('c', x, 15, 6)]);

    return [...plate(), b, extrude('B', b, 5, 'join', { target: 'E' })];
  };
  const r: any = await regenerate(boss(12));
  const btop = facing(r, [0, 0, 1]).find((f: any) => near(f.center[2], 15));
  const rim = r.bodies[0].edges.find((e: any) => e.type === 'CIRCLE' && near(e.mid[2], 15));
  check('a boss on the plate (its top, its rim found)', !!btop && !!rim && r.bodies.length === 1, r.errors);
  const H = hole('H', faceRef('E', btop), [12, 15, 15], { around: edgeRef('E', rim) });
  const a = await after([...boss(12), H], 'E');
  const Vb = V + PI * 36 * 5;
  check('a hole down the middle of the boss', !a.err && near(volume(a.body), Vb - PI * R * R * 15, 1e-6), `${volume(a.body)} ${a.errors}`);
  const b = await after([...boss(27), H], 'E');
  const wall = b.r.bodies[0].faces.find((f: any) => f.round?.hole);
  check('the boss moved 15 along: the hole is in its middle still', !b.err && near(volume(b.body), Vb - PI * R * R * 15, 1e-6) && !!wall && near(wall.center[0], 27, 1e-6) && near(wall.center[1], 15, 1e-6), `${wall?.center} ${b.errors}`);
  // On the plate's face under the boss (its foot is a round edge there): refused, not a hollow nothing shows.
  const ptop = facing(r, [0, 0, 1]).find((f: any) => near(f.center[2], 10));
  const foot = r.bodies[0].edges.find((e: any) => e.type === 'CIRCLE' && near(e.mid[2], 10));
  const u = await after([...boss(12), hole('H', faceRef('E', ptop), [12, 15, 10], { around: edgeRef('E', foot) })], 'E');
  check('on the plate under the boss: refused, in words, nothing cut', !!u.err && u.err.includes('covers the hole') && near(volume(u.body), Vb, 1e-6), u.err);
  // In the middle of the plate's face, which has the boss standing on it: the plate's middle, not where the face balances.
  const pm = await after([...boss(12), hole('H', faceRef('E', ptop), [20.8, 15, 10], { centered: true })], 'E');
  const pw = pm.r.bodies[0].faces.find((f: any) => f.round?.hole);
  check('the middle of a face with a boss on it: the middle of its outline', !pm.err && !!pw && near(pw.center[0], 20, 1e-6) && near(pw.center[1], 15, 1e-6), `${pw?.center} ${pm.errors}`);
  // A thread in it, and its mouth rounded: both find the hole by its step.
  const T = { id: 'T', name: 'T', type: 'thread', face: faceRef('E', a.r.bodies[0].faces.find((f: any) => f.round?.hole)), pitch: 0.5, round: { r: R, hole: true } } as Feature;
  const t = await after([...boss(12), H, T], 'E');
  check('a thread cut in the hole', !t.err && volume(t.body) < volume(a.body) - 0.5 && health(t.body!).valid, `${volume(a.body) - volume(t.body)} ${t.errors}`);
  const t2 = await after([...boss(27), H, T], 'E');
  check('... still in it with the boss moved', !t2.err && near(volume(t2.body), volume(t.body), 1e-2), `${volume(t2.body)} / ${volume(t.body)} ${t2.errors}`);
  const mouth = a.r.bodies[0].edges.find((e: any) => e.type === 'CIRCLE' && near(e.mid[2], 15) && near(e.length, 2 * PI * R, 1e-6));
  const C = { id: 'C', name: 'C', type: 'chamfer', edges: [edgeRef('E', mouth)], radius: 0.5 } as Feature;
  const c = await after([...boss(12), H, C], 'E');
  check('its mouth chamfered', !!mouth && !c.err && volume(c.body) < volume(a.body) && health(c.body!).valid, c.errors);
}
{
  // In the middle of the face: the plate made wider, the hole is in the middle still; a second hole does not move it.
  const wide = (w: number): Feature[] => {
    const sk = sketch('s', XY(), [rect('r', 0, 0, w, 30)]);

    return [sk, extrude('E', sk, 10)];
  };
  const H = hole('H', top, [20, 15, 10], { centered: true });
  const a = await after([...wide(60), H], 'E');
  const wall = a.r.bodies[0].faces.find((f: any) => f.round?.hole);
  check('in the middle of the face: the plate made 60 wide, the hole at 30', !a.err && !!wall && near(wall.center[0], 30, 1e-6) && near(wall.center[1], 15, 1e-6), `${wall?.center} ${a.errors}`);
  const r1: any = await regenerate([...plate(), hole('A', top, [5, 5, 10])]);
  const top1 = faceRef('E', facing(r1, [0, 0, 1])[0]);
  const b = await after([...plate(), hole('A', top, [5, 5, 10]), hole('H', top1, [20, 15, 10], { centered: true })], 'E');
  const walls = b.r.bodies[0].faces.filter((f: any) => f.round?.hole);
  check("a second hole, in the middle of a face that has one in a corner: in the plate's middle", !b.err && walls.length === 2 && walls.some((w: any) => near(w.center[0], 20, 1e-6) && near(w.center[1], 15, 1e-6)), walls.map((w: any) => w.center));
  // The first one moved: the second stays put.
  const c = await after([...plate(), hole('A', top, [33, 24, 10]), hole('B', top1, [20, 8, 10])], 'E');
  const w2 = c.r.bodies[0].faces.filter((f: any) => f.round?.hole);
  check('two holes, the first moved since: the second where it was put', !c.err && w2.length === 2 && w2.some((w: any) => near(w.center[0], 20, 1e-6) && near(w.center[1], 8, 1e-6)) && w2.some((w: any) => near(w.center[0], 33, 1e-6)), w2.map((w: any) => w.center));
}

{
  // Held 8 from the far side and 6 from the right end: the plate made wider and deeper, it is that far from them still.
  const sized = (w: number, d: number): Feature[] => {
    const sk = sketch('s', XY(), [rect('r', 0, 0, w, d)]);

    return [sk, extrude('E', sk, 10)];
  };
  const E = r0.bodies[0].edges;
  const right = E.find((e: any) => near(e.mid[0], 40) && near(e.mid[2], 10));
  const back = E.find((e: any) => near(e.mid[1], 30) && near(e.mid[2], 10));
  const H = hole('H', top, [34, 22, 10], { from: [{ edge: edgeRef('E', right), d: 6 }, { edge: edgeRef('E', back), d: 8 }] });
  for (const [w, d] of [[40, 30], [70, 30], [40, 55], [25, 18], [90, 80]]) {
    const a = await after([...sized(w, d), H], 'E');
    const wall = a.r.bodies[0].faces.find((f: any) => f.round?.hole);
    check(`held 6 and 8 from two edges, the plate ${w} x ${d}: at ${w - 6}, ${d - 8}`, !a.err && !!wall && near(wall.center[0], w - 6, 1e-6) && near(wall.center[1], d - 8, 1e-6), `${wall?.center} ${a.errors}`);
  }
  // The same sizes the other way round, and a place given far off: the sizes say where.
  const H2 = hole('H', top, [3, 3, 10], { from: [{ edge: edgeRef('E', back), d: 8 }, { edge: edgeRef('E', right), d: 6 }] });
  const b = await after([...sized(40, 30), H2], 'E');
  const wb = b.r.bodies[0].faces.find((f: any) => f.round?.hole);
  check('... given the other way round, from a place far off: the same hole', !b.err && !!wb && near(wb.center[0], 34, 1e-6) && near(wb.center[1], 22, 1e-6), `${wb?.center}`);
  // Two edges that run the same way hold nothing: where it was put.
  const left = E.find((e: any) => near(e.mid[0], 0) && near(e.mid[2], 10));
  const H3 = hole('H', top, [12, 9, 10], { from: [{ edge: edgeRef('E', right), d: 6 }, { edge: edgeRef('E', left), d: 6 }] });
  const c = await after([...sized(40, 30), H3], 'E');
  const wc = c.r.bodies[0].faces.find((f: any) => f.round?.hole);
  check('two edges that run the same way: where it was put', !c.err && !!wc && near(wc.center[0], 12, 1e-6) && near(wc.center[1], 9, 1e-6), `${wc?.center}`);
}

// ---------------------------------------------------------------- other faces
{
  // Into a side, and up from underneath.
  const side = faceRef('E', facing(r0, [1, 0, 0])[0]);
  const a = await after([...plate(), hole('H', side, [40, 15, 5], { through: false, depth: 12, head: 'counterbore' })], 'E');
  const want = V - PI * R * R * 12 - PI * (3.25 * 3.25 - R * R) * 3.4;
  check('into a side, 12 deep with a counterbore', !a.err && near(volume(a.body), want, 1e-6) && health(a.body!).valid, `${volume(a.body)} / ${want} ${a.errors}`);
  const under = faceRef('E', facing(r0, [0, 0, -1])[0]);
  const b = await after([...plate(), hole('H', under, [10, 10, 0], { head: 'countersink' })], 'E');
  const cone = b.r.bodies[0].faces.find((g: any) => g.type === 'CONE');
  check('from underneath with a countersink: the cone at the bottom', !b.err && !!cone && cone.center[2] < 2 && health(b.body!).valid, `${cone?.center} ${b.errors}`);
  // A point given off the face's plane is put on it.
  const c = await after([...plate(), hole('H', top, [10, 10, 37], { through: false, depth: 4 })], 'E');
  check('a place given above the face: drilled from the face', !c.err && near(volume(c.body), V - PI * R * R * 4, 1e-6), `${volume(c.body)} ${c.errors}`);
}
{
  // On a plate drawn on the front plane (its faces named the other way round), every size, every head.
  const sx = sketch('s', XZ(), [rect('r', 0, 0, 60, 40)]);
  const fs: Feature[] = [sx, extrude('E', sx, 30)];
  const r: any = await regenerate(fs);
  const far = r.bodies[0].faces.find((f: any) => f.curve?.startsWith('cap:1@'));
  let ok = 0;
  const bad: string[] = [];
  for (const size of SCREW_SIZES) {
    for (const head of ['none', 'counterbore', 'countersink'] as const) {
      const a = await after([...fs, hole('H', faceRef('E', far), [30, far.center[1], 20], { ...holeFor(size, head), head })], 'E');
      const h = a.body ? health(a.body) : null;
      if (!a.err && h?.healthy && volume(a.body) < 60 * 40 * 30 - PI * (size.clearance / 2) ** 2 * 30 + 1e-6) {
        ok++;
      } else {
        bad.push(`${size.name} ${head}: ${a.errors}`);
      }
    }
  }
  check('every size with every head, through a 30 mm block on the front plane', ok === SCREW_SIZES.length * 3, bad);
}

done();
