// Run: npx tsx tests/joints.test.ts
// Assemblies: where bodies are when their joints move. A joint's value is how far it is from where the bodies were
// modelled; all at 0 is the model as built.
import { apply, driverOf, effective, propose, solve, tree, turnAxis, type Joint } from '../src/assembly/joints';
import type { Vec3 } from '../src/doc/types';

let failed = 0;
const check = (name: string, ok: boolean, info: unknown = '') => {
  if (!ok) {
    failed++;
  }
  console.log(ok ? 'ok  ' : 'FAIL', name, info);
};
const near = (p: Vec3, q: Vec3, tol = 1e-9) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) < tol;
const J = (id: string, type: Joint['type'], a: string, b: string, origin: Vec3, axis: Vec3, more: Partial<Joint> = {}): Joint => ({ id, name: id, type, a, b, origin, axis, ...more });

// ---- one joint of each kind
{
  const hinge = J('h', 'hinge', 'base', 'door', [10, 0, 0], [0, 0, 1]);
  const at0 = solve([hinge], ['base', 'door'], {});
  check('all at 0: every body where it was modelled', near(apply(at0.get('door')!, [20, 0, 5]), [20, 0, 5]) && near(apply(at0.get('base')!, [1, 2, 3]), [1, 2, 3]));
  const at90 = solve([hinge], ['base', 'door'], { h: 90 });
  check("a hinge at 90: the door's point 10 out from the hinge line is 10 round it, its height kept", near(apply(at90.get('door')!, [20, 0, 5]), [10, 10, 5]), apply(at90.get('door')!, [20, 0, 5]));
  check('the base stays', near(apply(at90.get('base')!, [1, 2, 3]), [1, 2, 3]));

  const slide = J('s', 'slide', 'base', 'drawer', [0, 0, 0], [0, 2, 0]);
  check("a slide at 25: 25 mm along its line, whatever the line's length", near(apply(solve([slide], ['base', 'drawer'], { s: 25 }).get('drawer')!, [3, 4, 5]), [3, 29, 5]));

  const screw = J('n', 'screw', 'bolt', 'nut', [0, 0, 0], [0, 0, 1], { pitch: 1.5 });
  const two = solve([screw], ['bolt', 'nut'], { n: 720 }).get('nut')!;
  check('a screw of pitch 1.5, two turns: 3 mm along, the same way round', near(apply(two, [8, 0, 0]), [8, 0, 3], 1e-9), apply(two, [8, 0, 0]));
  const quarter = solve([screw], ['bolt', 'nut'], { n: 90 }).get('nut')!;
  check('a quarter turn: a quarter round, 0.375 along', near(apply(quarter, [8, 0, 0]), [0, 8, 0.375], 1e-9));

  const fixed = J('f', 'fixed', 'base', 'lid', [0, 0, 0], [0, 0, 1]);
  check('a fixed joint moves nothing, whatever its value', near(apply(solve([fixed], ['base', 'lid'], { f: 50 }).get('lid')!, [1, 1, 1]), [1, 1, 1]));
}

// ---- limits, and which body stands still
{
  const h = J('h', 'hinge', 'base', 'door', [0, 0, 0], [0, 0, 1], { min: 0, max: 90 });
  check('kept in its limits: 140 asked of 0 to 90 is 90, -20 is 0', effective([h], { h: 140 }).h === 90 && effective([h], { h: -20 }).h === 0);
  const flipped = solve([h], ['base', 'door'], { h: 90 }, 'door');
  check('the door grounded: the base turns the other way round the same line', near(apply(flipped.get('base')!, [10, 0, 0]), [0, -10, 0]) && near(apply(flipped.get('door')!, [10, 0, 0]), [10, 0, 0]));
  check('no ground named: the first body of the project stands', tree([h], ['door', 'base']).roots[0] === 'door' && tree([h], ['base', 'door']).roots[0] === 'base');
}

// ---- a chain: an arm on an arm
{
  const j1 = J('j1', 'hinge', 'base', 'arm1', [0, 0, 0], [0, 0, 1]);
  const j2 = J('j2', 'hinge', 'arm1', 'arm2', [10, 0, 0], [0, 0, 1]);
  const m = solve([j1, j2], ['base', 'arm1', 'arm2'], { j1: 90, j2: 90 });
  // arm2's tip at (20,0,0): round j2 by 90 -> (10,10,0); then with arm1 round the origin by 90 -> (-10,10,0).
  check('two hinges in a row: the second turns on the first, which carries it', near(apply(m.get('arm2')!, [20, 0, 0]), [-10, 10, 0]), apply(m.get('arm2')!, [20, 0, 0]));
  check('the joint between them goes with the first arm', near(apply(m.get('arm1')!, [10, 0, 0]), [0, 10, 0]));
  const none = solve([j1, j2], ['base', 'arm1', 'arm2', 'loose'], { j1: 30 });
  check('a body no joint holds is not moved', !none.has('loose'));
}

// ---- a ring of bodies: its last joint is left out, nothing is torn
{
  const a = J('a', 'hinge', 'p', 'q', [0, 0, 0], [0, 0, 1]);
  const b = J('b', 'hinge', 'q', 'r', [10, 0, 0], [0, 0, 1]);
  const c = J('c', 'hinge', 'r', 'p', [5, 5, 0], [0, 0, 1]);
  const t = tree([a, b, c], ['p', 'q', 'r']);
  check('three bodies in a ring: each held once', t.up.size === 2 && t.roots.length === 1);
}

// ---- one joint following another (gears)
{
  const g1 = J('g1', 'hinge', 'frame', 'gear1', [0, 0, 0], [0, 0, 1]);
  const g2 = J('g2', 'hinge', 'frame', 'gear2', [30, 0, 0], [0, 0, 1], { drive: { joint: 'g1', ratio: -0.5 } });
  const v = effective([g1, g2], { g1: 90, g2: 999 });
  check("a joint that follows another: its value is the other's times the ratio, its own ignored", v.g2 === -45, v);
  const m = solve([g1, g2], ['frame', 'gear1', 'gear2'], { g1: 90 });
  check('the second gear turns half as far the other way, round its own line', near(apply(m.get('gear2')!, [40, 0, 0]), [30 + 10 * Math.cos(-Math.PI / 4), 10 * Math.sin(-Math.PI / 4), 0]));
  const d = driverOf([g1, g2], 'g2');
  check('dragging the second drives the first, by the ratio', d?.joint.id === 'g1' && d.ratio === -0.5);
  const loop = [J('x', 'hinge', 'f', 'a', [0, 0, 0], [0, 0, 1], { drive: { joint: 'y', ratio: 2 } }), J('y', 'hinge', 'f', 'b', [0, 0, 0], [0, 0, 1], { drive: { joint: 'x', ratio: 2 } })];
  check('two joints set to follow each other: no endless loop', Number.isFinite(effective(loop, { x: 1, y: 1 }).x));
}

// ---- exploded
{
  const n = J('n', 'screw', 'bolt', 'nut', [0, 0, 0], [0, 0, 1], { pitch: 1.5 });
  const w = J('w', 'fixed', 'bolt', 'washer', [0, 0, 0], [0, 0, 1]);
  const ex = { factor: 1, centers: { bolt: [0, 0, 13] as Vec3, nut: [0, 0, 4] as Vec3, washer: [12, 0, 13] as Vec3 }, sizes: { bolt: 15, nut: 10, washer: 4 } };
  const m = solve([n, w], ['bolt', 'nut', 'washer'], {}, undefined, ex);
  check("exploded: the nut goes off the bolt along the thread's line, away from the bolt's middle", near(apply(m.get('nut')!, [0, 0, 4]), [0, 0, 4 - 25]), apply(m.get('nut')!, [0, 0, 4]));
  check('a fixed part goes off from middle to middle', near(apply(m.get('washer')!, [12, 0, 13]), [12 + 19, 0, 13]));
  check('what is grounded stays', near(apply(m.get('bolt')!, [0, 0, 13]), [0, 0, 13]));
  const half = solve([n, w], ['bolt', 'nut', 'washer'], {}, undefined, { ...ex, factor: 0.5 });
  check('half way: half as far', near(apply(half.get('nut')!, [0, 0, 4]), [0, 0, 4 - 12.5]));
}

// ---- what two picks make
{
  const z: Vec3 = [0, 0, 1];
  check('two round faces on one axis: a hinge', propose({ origin: [0, 0, 0], dir: z, round: true }, { origin: [0, 0, 30], dir: [0, 0, -1], round: true }).type === 'hinge');
  check("... a screw of the thread's pitch when one of the bodies is threaded", JSON.stringify(propose({ origin: [0, 0, 0], dir: z, round: false }, { origin: [0, 0, 8], dir: z, round: false }, 1.5)) === JSON.stringify({ type: 'screw', origin: [0, 0, 0], axis: z, pitch: 1.5 }));
  check("two flat faces side by side: a slide along the first's normal", propose({ origin: [0, 0, 0], dir: [0, 1, 0], round: false }, { origin: [40, 0, 0], dir: [0, -1, 0], round: false }).type === 'slide');
  check('two round faces on different axes: fixed', propose({ origin: [0, 0, 0], dir: z, round: true }, { origin: [30, 0, 0], dir: z, round: true }).type === 'fixed');
  check('faces that lean against each other: fixed', propose({ origin: [0, 0, 0], dir: z, round: false }, { origin: [0, 0, 5], dir: [0, 1, 0], round: false }).type === 'fixed');
  check('a face that gives no line (a freeform one): fixed', propose(null, null).type === 'fixed');
}

// ---- the line a face is turned round, from its points and normals
{
  // A thread's flank: a helicoid round the line through (3, -2, 0) along a slanted direction, its normal leaning 30 degrees.
  const dir: Vec3 = [0.36, 0.48, 0.8];
  const ex: Vec3 = [0.8, -0.6, 0];
  const ey: Vec3 = [dir[1] * ex[2] - dir[2] * ex[1], dir[2] * ex[0] - dir[0] * ex[2], dir[0] * ex[1] - dir[1] * ex[0]];
  const o: Vec3 = [3, -2, 0];
  const pts: Vec3[] = [];
  const nrm: Vec3[] = [];
  for (let i = 0; i < 60; i++) {
    const a = i * 0.21;
    const r = 4 + (i % 5) * 0.2;
    const h = (1.5 * a) / (2 * Math.PI) + (i % 5) * 0.1;
    const rad: Vec3 = [ex[0] * Math.cos(a) + ey[0] * Math.sin(a), ex[1] * Math.cos(a) + ey[1] * Math.sin(a), ex[2] * Math.cos(a) + ey[2] * Math.sin(a)];
    pts.push([o[0] + rad[0] * r + dir[0] * h, o[1] + rad[1] * r + dir[1] * h, o[2] + rad[2] * r + dir[2] * h]);
    nrm.push([rad[0] * 0.866 + dir[0] * 0.5, rad[1] * 0.866 + dir[1] * 0.5, rad[2] * 0.866 + dir[2] * 0.5]);
  }
  const ax = turnAxis(pts, nrm);
  const along = ax ? Math.abs(ax.dir[0] * dir[0] + ax.dir[1] * dir[1] + ax.dir[2] * dir[2]) : 0;
  const w: Vec3 = ax ? [ax.origin[0] - o[0], ax.origin[1] - o[1], ax.origin[2] - o[2]] : [9, 9, 9];
  const t = w[0] * dir[0] + w[1] * dir[1] + w[2] * dir[2];
  const off = Math.hypot(w[0] - dir[0] * t, w[1] - dir[1] * t, w[2] - dir[2] * t);
  check("a thread's flank: its line found, direction and place", !!ax && along > 1 - 1e-9 && off < 1e-6, { along, off });
  // A flat face, a ball, a face bent one way only: no such line.
  const flat = Array.from({ length: 20 }, (_, i): Vec3 => [i % 5, Math.floor(i / 5), 0]);
  check('a flat face has none', turnAxis(flat, flat.map((): Vec3 => [0, 0, 1])) === null);
  const ball = Array.from({ length: 40 }, (_, i): Vec3 => {
    const u = Math.acos(1 - (2 * (i + 0.5)) / 40);
    const v = i * 2.399963;

    return [Math.sin(u) * Math.cos(v), Math.sin(u) * Math.sin(v), Math.cos(u)];
  });
  check('a ball has none (it turns round every line through its middle)', turnAxis(ball, ball) === null);
  const cyl = Array.from({ length: 40 }, (_, i): { p: Vec3; n: Vec3 } => ({ p: [5 * Math.cos(i * 0.4), 5 * Math.sin(i * 0.4), i % 4], n: [Math.cos(i * 0.4), Math.sin(i * 0.4), 0] }));
  const c = turnAxis(cyl.map(q => q.p), cyl.map(q => q.n));
  check("a cylinder's wall: its own axis", !!c && Math.abs(c.dir[2]) > 1 - 1e-9 && Math.hypot(c.origin[0], c.origin[1]) < 1e-6, c);
}

console.log(failed ? `${failed} FAILED` : 'all passed');
process.exit(failed ? 1 : 0);
