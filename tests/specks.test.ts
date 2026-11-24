// Run: npx tsx tests/specks.test.ts
// From a project that stopped working half way: blocks drawn side by side on
// the ground, one of them rounded 4 mm on both corners of its 8 mm end.
//
// 1. The two roundings meet with nothing between; the sliver left there was
//    closed, but its ends stayed on the top and bottom faces as edges four
//    millionths of a mm long - picked with the rest of the top's outline,
//    and what every later fillet, cut and edge move there stumbled on.
// 2. A new block's top and bottom were put down to the step that made
//    another block (the same height, on the same ground): change that other
//    block and the steps on this one lost their faces.
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
const said = (result: any) => [...result.errors, ...(result.notes ?? [])].map((e: any) => e.message).join(' / ');
const block = (id: string, x0: number, y0: number, x1: number, y1: number, height: number): Feature[] => {
  const es = [{ id: `p${id}`, kind: 'polyline', points: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]], closed: true }];

  return [
    { id: `s${id}`, name: `s${id}`, type: 'sketch', plane: XY, entities: es } as Feature,
    { id, name: id, type: 'extrude', source: { kind: 'profile', sketch: `s${id}`, regions: arrangement(es as any).regions.map(regionRef) }, distance: height, mode: 'auto' } as Feature
  ];
};
const near = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < 0.01;
const edgeAt = (result: any, body: string, at: number[]) => {
  const e = result.bodies.find((b: any) => b.id === body).edges.find((edge: any) => near(edge.mid, at));

  return e && { body, mid: e.mid, dir: e.dir, length: e.length, steps: e.steps, curves: e.curves };
};
const faceAt = (result: any, body: string, at: number[]) => {
  const face = result.bodies.find((b: any) => b.id === body).faces.find((face: any) => near(face.center, at));

  return face && { body, center: face.center, normal: face.normal, area: face.area, step: face.step, curve: face.curve };
};

const topOf = (result: any) => {
  const face = result.bodies.find((body: any) => body.id === 'B').faces.find((face: any) => face.normal[2] > 0.99);

  return { body: 'B', center: face.center, normal: face.normal, area: face.area, step: face.step, curve: face.curve };
};

// A block 23 tall, and beside it a bar 50 x 8, as tall, on the same ground.
const two = (height: number) => [...block('A', 0, 0, 30, 30, height), ...block('B', -100, 77, -50, 85, 23)];
{
  let result: any = await regenerate(two(23));
  const b = result.bodies.find((body: any) => body.id === 'B');
  check("the bar's top and bottom are the bar's own (not the block's beside it)", b.faces.every((face: any) => face.step === 'B'), b.faces.map((face: any) => face.step).join(' '));

  // Both corners of the bar's 8 mm end rounded 4 mm, one after the other.
  const f1: Feature = { id: 'f1', name: 'f1', type: 'fillet', edges: [edgeAt(result, 'B', [-50, 85, 11.5])], radius: 4 } as Feature;
  result = await regenerate([...two(23), f1]);
  const f2: Feature = { id: 'f2', name: 'f2', type: 'fillet', edges: [edgeAt(result, 'B', [-50, 77, 11.5])], radius: 4 } as Feature;
  result = await regenerate([...two(23), f1, f2]);
  const edges = result.bodies.find((body: any) => body.id === 'B').edges;
  const shortest = Math.min(...edges.map((e: any) => e.length));
  check('a full round: no edge next to nothing in length is left', !result.errors.length && shortest > 0.01, `${said(result)} shortest ${shortest}`);

  const full = result;
  // The top's whole outline rounded 0.5: what failed in that project.
  const top = edges.filter((e: any) => Math.abs(e.mid[2] - 23) < 1e-6).map((e: any) => ({ body: 'B', mid: e.mid, dir: e.dir, length: e.length, steps: e.steps, curves: e.curves }));
  const f3: Feature = { id: 'f3', name: 'f3', type: 'fillet', edges: top, radius: 0.5 } as Feature;
  result = await regenerate([...two(23), f1, f2, f3]);
  check("the top's outline rounded", !result.errors.length, said(result));
  const up: Feature = { id: 'up', name: 'up', type: 'extrude', source: { kind: 'face', face: topOf(full) }, distance: 5, mode: 'auto', target: 'B' } as Feature;
  // ...and its top pulled up (without that rounding).
  result = await regenerate([...two(23), f1, f2, up]);
  const zTop = (debugBodies().get('B') as Shape3D).boundingBox.bounds[1][2];
  check('its top pulled up 5', !result.errors.length && Math.abs(zTop - 28) < 1e-6, `${said(result)} top at ${zTop}`);

  // The block beside it made taller: nothing built on the bar loses its face.
  result = await regenerate([...two(40), f1, f2, up, { ...f3, edges: f3.edges.filter((e: any) => e.length > 40) } as Feature]);
  check('the other block changed: the steps on the bar still find their faces', !result.errors.length, said(result));
}

// A project saved when the bar's top was put down to the block's step: its picks are still found.
{
  let result: any = await regenerate(two(23));
  const top = faceAt(result, 'B', [-75, 81, 23]);
  const old = { ...top, step: 'A', curve: 'cap:1@pA:2' };
  const up: Feature = { id: 'up', name: 'up', type: 'extrude', source: { kind: 'face', face: old }, distance: 5, mode: 'auto', target: 'B' } as Feature;
  result = await regenerate([...two(23), up]);
  const zTop = (debugBodies().get('B') as Shape3D).boundingBox.bounds[1][2];
  check("a face saved under the other body's step is found", !result.errors.length && Math.abs(zTop - 28) < 1e-6, `${said(result)} top at ${zTop}`);
  const e = edgeAt(result, 'B', [-100, 81, 0]);
  const round: Feature = { id: 'rd', name: 'rd', type: 'fillet', edges: [{ ...e, steps: ['A', 'B'], curves: undefined }], radius: 1 } as Feature;
  result = await regenerate([...two(23), round]);
  check("an edge saved under the other body's step is found", !result.errors.length, said(result));
}
process.exit(failed ? 1 : 0);
