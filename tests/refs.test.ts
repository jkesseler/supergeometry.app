// Run: npx tsx tests/refs.test.ts
// A step built on a face or an edge finds it again by the sketch curve the
// face was made from - not by where it used to be. A comb's teeth moved
// apart, holes moved past each other: the boss on the second tooth stays on
// the second tooth, the step on hole a's wall stays on hole a.
import opencascade from 'replicad-opencascadejs';
import { setOC, type Shape3D } from 'replicad';
import { debugBodies, regenerate } from '../src/kernel/engine';
import { arrangement, regionRef } from '../src/sketch/regions';
import type { Feature, PlaneDef } from '../src/doc/types';

setOC(await (opencascade as unknown as () => Promise<any>)());
let failed = 0;
const check = (name: string, ok: boolean, info = '') => {
  if (!ok) {
    failed++;
  }
  console.log(ok ? 'ok  ' : 'FAIL', name, info);
};
const XY: PlaneDef = { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, 0, 1] };
const XZ: PlaneDef = { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, -1, 0] };
const part = (id: string, es: any[], distance: number, plane = XY): Feature[] => [
  { id: `s${id}`, name: `s${id}`, type: 'sketch', plane, entities: es } as Feature,
  { id, name: id, type: 'extrude', source: { kind: 'profile', sketch: `s${id}`, regions: arrangement(es as any).regions.map(regionRef) }, distance: distance, mode: 'new' } as Feature
];
/** A face of a body as the app would save a pick of it (from the mesh's own info). */
const pick = (result: any, body: string, like: (f: any) => boolean) => {
  const face = result.bodies.find((b: any) => b.id === body).faces.find(like);

  return face && { body, center: face.center, normal: face.normal, area: face.area, step: face.step, curve: face.curve };
};
const pickEdge = (result: any, body: string, like: (e: any) => boolean) => {
  const e = result.bodies.find((b: any) => b.id === body).edges.find(like);

  return e && { body, mid: e.mid, dir: e.dir, length: e.length, steps: e.steps, curves: e.curves };
};
const top = () => (debugBodies().get('A') as Shape3D).boundingBox.bounds[1][2];
const said = (result: any) => result.errors.map((e: any) => e.message).join(' / ');

// A comb seen from the front (drawn on XZ): three teeth 10 wide, their tops at z = 30.
const comb = (pitch: number): [number, number][] => {
  const pts: [number, number][] = [[0, 0]];
  for (let index = 0; index < 3; index++) {
    pts.push([index * pitch, 30], [index * pitch + 10, 30], [index * pitch + 10, 10]);
    if (index < 2) {
      pts.push([(index + 1) * pitch, 10]);
    }
  }
  pts.push([2 * pitch + 10, 0]);

  return pts;
};
const combPart = (pitch: number) => part('A', [{ id: 'p', kind: 'polyline', points: comb(pitch), closed: true }], 10, XZ);
const toothTop = (x: number) => (face: any) => face.normal[2] > 0.99 && Math.abs(face.center[0] - x) < 0.01 && Math.abs(face.center[2] - 30) < 0.01;
{
  let result: any = await regenerate(combPart(20));
  const tops = result.bodies[0].faces.filter((face: any) => face.normal[2] > 0.99 && Math.abs(face.center[2] - 30) < 0.01);
  check("the comb's tooth tops say which sketch line each came from", tops.length === 3 && new Set(tops.map((top: any) => top.curve)).size === 3 && tops.every((top: any) => /^p:\d+$/.test(top.curve ?? '')), tops.map((top: any) => top.curve).join(' '));
  // A boss pulled up from the middle tooth's top.
  const mid = pick(result, 'A', toothTop(25));
  const boss: Feature = { id: 'up', name: 'up', type: 'extrude', source: { kind: 'face', face: mid }, distance: 15, mode: 'join', target: 'A' } as Feature;
  result = await regenerate([...combPart(20), boss]);
  check('a boss on the middle tooth', !result.errors.length && Math.abs(top() - 45) < 0.01, said(result));
  // The teeth moved 50 apart: the first tooth is now the nearest to where the middle one was.
  result = await regenerate([...combPart(50), boss]);
  const high = result.bodies[0].faces.find((face: any) => face.normal[2] > 0.99 && Math.abs(face.center[2] - 45) < 0.01);
  check('teeth moved apart: the boss is still on the middle tooth (not the one nearest where it was)', !result.errors.length && !!high && Math.abs(high.center[0] - 55) < 0.01, `${said(result)} boss at x ${high?.center[0]}`);
  // An edge: the middle tooth's top edge at the front, chamfered.
  result = await regenerate(combPart(20));
  const e = pickEdge(result, 'A', x => Math.abs(x.mid[0] - 25) < 0.01 && Math.abs(x.mid[2] - 30) < 0.01 && Math.abs(Math.abs(x.dir[0]) - 1) < 0.01);
  const cham: Feature = { id: 'ch', name: 'ch', type: 'chamfer', radius: 2, edges: [e] } as Feature;
  result = await regenerate([...combPart(20), cham]);
  const before = !result.errors.length && !!result.bodies[0].faces.find((face: any) => face.step === 'ch' && Math.abs(face.center[0] - 25) < 0.01);
  result = await regenerate([...combPart(50), cham]);
  const slope = result.bodies[0].faces.find((face: any) => face.step === 'ch');
  check('...and a chamfer on its edge stays on its edge', before && !result.errors.length && !!slope && Math.abs(slope.center[0] - 55) < 0.01, `${said(result)} chamfer at x ${slope?.center[0]}; saved as between ${e?.curves}`);
}

// A plate with two holes cut by one step; hole a's wall pushed out (the hole made wider), then a moved past b.
{
  const plate = part('A', [{ id: 'r', kind: 'rect', center: [30, 0], w: 80, h: 30, rotation: 0 }], 5);
  const holes = (ax: number, bx: number): Feature[] => {
    const es = [
      { id: 'a', kind: 'circle', center: [ax, 0], radius: 3 },
      { id: 'b', kind: 'circle', center: [bx, 0], radius: 3 }
    ];

    return [
      { id: 'sh', name: 'sh', type: 'sketch', plane: { ...XY, origin: [0, 0, 5] }, entities: es } as Feature,
      { id: 'cut', name: 'cut', type: 'extrude', source: { kind: 'profile', sketch: 'sh', regions: arrangement(es as any).regions.map(regionRef) }, distance: -5, mode: 'cut', target: 'A' } as Feature
    ];
  };
  let result: any = await regenerate([...plate, ...holes(10, 20)]);
  const walls = result.bodies[0].faces.filter((face: any) => face.step === 'cut');
  check('two holes of one cut: each wall says which circle it came from', walls.length === 2 && walls.map((wall: any) => wall.curve).sort().join() === 'a:0,b:0', walls.map((wall: any) => wall.curve).join(' '));
  const wallA = pick(result, 'A', face => face.step === 'cut' && face.curve === 'a:0');
  const wider: Feature = { id: 'w', name: 'w', type: 'extrude', source: { kind: 'face', face: wallA }, distance: -2, mode: 'join', target: 'A' } as Feature;
  result = await regenerate([...plate, ...holes(10, 20), wider]);
  const radiusAt = (x: number) => result.bodies[0].faces.find((face: any) => face.round?.hole && Math.abs(face.center[0] - x) < 0.5)?.round.r;
  const first = `${said(result)} a ${radiusAt(10)}, b ${radiusAt(20)}`;
  const changed = !result.errors.length && radiusAt(10) !== undefined && Math.abs(radiusAt(10) - 3) > 0.5 && Math.abs(radiusAt(20) - 3) < 0.01;
  check("hole a's wall offset: a changes size, b doesn't", changed, first);
  // Hole a moved to x = 50, past hole b (which is now the nearer to where a was).
  result = await regenerate([...plate, ...holes(50, 20), wider]);
  check("hole a moved past hole b: the step is still on a's wall", !result.errors.length && radiusAt(50) !== undefined && Math.abs(radiusAt(50) - 3) > 0.5 && Math.abs(radiusAt(20) - 3) < 0.01, `${said(result)} first: ${first}; now a ${radiusAt(50)}, b ${radiusAt(20)}`);
}

// Picks saved before this (no curve with them): found as they were, by where they are.
{
  let result: any = await regenerate(combPart(20));
  const mid = pick(result, 'A', toothTop(25));
  delete mid.curve;
  const boss: Feature = { id: 'up', name: 'up', type: 'extrude', source: { kind: 'face', face: mid }, distance: 15, mode: 'join', target: 'A' } as Feature;
  result = await regenerate([...combPart(22), boss]);
  const high = result.bodies[0].faces.find((face: any) => face.normal[2] > 0.99 && Math.abs(face.center[2] - 45) < 0.01);
  check('an older pick (no curve saved): still found by where it is', !result.errors.length && !!high && Math.abs(high.center[0] - 27) < 0.01, `${said(result)} ${high?.center[0]}`);
}

process.exit(failed ? 1 : 0);
