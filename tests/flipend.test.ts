// Run: npx tsx tests/flipend.test.ts
// An extrusion edited to go the other way (10 up made 20 down): what was built on its far end - a rounding of its
// edges, a boss on its face - is still on its far end. Reported: a rounding of five edges was left on four.
import { regenerate } from '../src/kernel/engine';
import { after, check, done, extrude, near, rect, sketch, volume, XY, XZ } from './kit';
import type { Feature } from '../src/doc/types';

const ref = (e: any) => ({ body: 'E', mid: e.mid, dir: e.dir, length: e.length, steps: e.steps, curves: e.curves });
const round = (r: any) => r.bodies[0].faces.filter((f: any) => f.type !== 'PLANE').length;

for (const [name, pl] of [['on the ground', XY()], ['on the front plane', XZ()]] as const) {
  const s = sketch('s', pl, [rect('r', 0, 0, 30, 20)]);
  const base = (d: number): Feature[] => [s, extrude('E', s, d)];
  const r10: any = await regenerate(base(10));
  const E = r10.bodies[0].edges;
  // The four edges of the far end, and one upright.
  const far = E.map((e: any, i: number) => i).filter((i: number) => E[i].curves.some((c: string) => c.includes('cap:1@')));
  const up = E.findIndex((e: any) => !e.curves.some((c: string) => c.includes('cap:')));
  const F = { id: 'F', name: 'F', type: 'fillet', edges: [...far, up].map(i => ref(E[i])), radius: 2 } as Feature;
  const a0: any = await regenerate([...base(10), F]);
  check(`${name}: five edges rounded`, !a0.errors.length && far.length === 4 && round(a0) === 6, round(a0));
  for (const d of [20, -20, -10, -3]) {
    const a = await after([...base(d), F], 'E');
    const rd: any = await regenerate(base(d));
    const b = await after([...base(d), { ...F, edges: [...far, up].map(i => ref(rd.bodies[0].edges[i])) } as Feature], 'E');
    check(`${name}: made ${d} - the five still rounded, as if picked anew`, !a.err && round(a.r) === 6 && near(volume(a.body), volume(b.body), 1e-3), `${round(a.r)} round faces, ${volume(a.body).toFixed(2)} / ${volume(b.body).toFixed(2)} ${a.errors.join(' / ')}`);
  }
  // A boss on the far end's face.
  const top = r10.bodies[0].faces.find((f: any) => f.curve?.startsWith('cap:1@'));
  const boss = { id: 'B', name: 'B', type: 'extrude', source: { kind: 'face', face: { body: 'E', center: top.center, normal: top.normal, area: top.area, step: top.step, curve: top.curve } }, distance: 5, mode: 'auto', target: 'E' } as Feature;
  for (const d of [10, -20]) {
    const a = await after([...base(d), boss], 'E');
    check(`${name}: made ${d} - the far end pulled 5 further`, !a.err && near(volume(a.body), 30 * 20 * (Math.abs(d) + 5), 1e-3), `${volume(a.body).toFixed(2)} ${a.errors.join(' / ')}`);
  }
}
// Both ways at once: each end keeps its own name.
{
  const s = sketch('s', XY(), [rect('r', 0, 0, 30, 20)]);
  const base = (d: number): Feature[] => [s, extrude('E', s, d, 'new', { symmetric: true })];
  const r: any = await regenerate(base(10));
  const E = r.bodies[0].edges;
  const upper = E.map((e: any, i: number) => i).filter((i: number) => E[i].mid[2] > 1);
  const F = { id: 'F', name: 'F', type: 'fillet', edges: upper.map((i: number) => ref(E[i])), radius: 2 } as Feature;
  const a = await after([...base(30), F], 'E');
  const tops = a.r.bodies[0].faces.filter((f: any) => f.type !== 'PLANE');
  check('to both sides, made longer: the rounding stays on the end it was on', !a.err && tops.length > 0 && tops.every((f: any) => f.center[2] > 1), tops.map((f: any) => +f.center[2].toFixed(1)));
}
done();
