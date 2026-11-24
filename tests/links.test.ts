// Run: npx tsx tests/links.test.ts
// A sketch curve projected from a body's edge follows that edge: when the
// body changes, the curve is where the edge is now, and what the sketch
// dimensions to it moves with it - a pin 8 mm in from a plate's side stays
// 8 mm in when the plate is made wider.
import opencascade from 'replicad-opencascadejs';
import { setOC, type Shape3D } from 'replicad';
import { debugBodies, rebuildStats, regenerate } from '../src/kernel/engine';
import { arrangement, regionRef } from '../src/sketch/regions';
import { solve } from '../src/sketch/constraints';
import type { Feature, PlaneDef, SketchEntity, SketchFeature } from '../src/doc/types';

setOC(await (opencascade as unknown as () => Promise<any>)());
let failed = 0;
const check = (name: string, ok: boolean, info = '') => {
  if (!ok) {
    failed++;
  }
  console.log(ok ? 'ok  ' : 'FAIL', name, info);
};
const XY: PlaneDef = { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, 0, 1] };
const ABOVE: PlaneDef = { origin: [0, 0, 20], xDir: [1, 0, 0], normal: [0, 0, 1] };
const said = (result: any) => [...result.errors, ...(result.notes ?? [])].map((e: any) => e.message).join(' / ');

/** A plate `width` wide, 30 deep, 10 thick. */
const plate = (width: number): Feature[] => {
  const es = [{ id: 'p', kind: 'polyline', points: [[0, 0], [width, 0], [width, 30], [0, 30]], closed: true }];

  return [
    { id: 'sA', name: 'sA', type: 'sketch', plane: XY, entities: es } as Feature,
    { id: 'A', name: 'A', type: 'extrude', source: { kind: 'profile', sketch: 'sA', regions: arrangement(es as any).regions.map(regionRef) }, distance: 10, mode: 'new' } as Feature
  ];
};
const pickEdge = (result: any, body: string, at: [number, number, number]) => {
  const e = result.bodies.find((b: any) => b.id === body).edges.find((edge: any) => Math.hypot(edge.mid[0] - at[0], edge.mid[1] - at[1], edge.mid[2] - at[2]) < 0.01);

  return e && { body, mid: e.mid, dir: e.dir, length: e.length, steps: e.steps, curves: e.curves };
};
const pinAt = () => {
  const b = (debugBodies().get('pin') as Shape3D).boundingBox.bounds;

  return [(b[0][0] + b[1][0]) / 2, (b[0][1] + b[1][1]) / 2];
};

{
  let result: any = await regenerate(plate(40));
  const side = pickEdge(result, 'A', [40, 15, 10]);
  const front = pickEdge(result, 'A', [20, 0, 10]);
  check("the plate's edges are there to follow", !!side?.steps && !!front?.steps);
  // A sketch above the plate: its side and front edges projected, a circle 8 from the side and 12 from the front.
  const es: SketchEntity[] = [
    { id: 'ref-side', kind: 'line', a: [40, 0], b: [40, 30] },
    { id: 'ref-front', kind: 'line', a: [0, 0], b: [40, 0] },
    { id: 'c', kind: 'circle', center: [32, 12], radius: 3 }
  ];
  const sketch = (entities: SketchEntity[]): SketchFeature => ({
    id: 's', name: 's', type: 'sketch', plane: ABOVE, entities,
    constraints: [
      { id: 'd1', type: 'distance', pts: [{ e: 'c', p: 'c' }], curves: ['ref-side'], value: 8 },
      { id: 'd2', type: 'distance', pts: [{ e: 'c', p: 'c' }], curves: ['ref-front'], value: 12 }
    ],
    links: [{ id: 'ref-side', edge: side }, { id: 'ref-front', edge: front }]
  });
  const pin: Feature = { id: 'pin', name: 'pin', type: 'extrude', source: { kind: 'profile', sketch: 's', regions: arrangement([es[2]]).regions.map(regionRef) }, distance: 5, mode: 'new' } as Feature;
  result = await regenerate([...plate(40), sketch(es), pin]);
  let at = pinAt();
  check('the pin is 8 in from the side, 12 from the front', !result.errors.length && Math.abs(at[0] - 32) < 1e-6 && Math.abs(at[1] - 12) < 1e-6, `${said(result)} at ${at}`);
  check('nothing to tell the page: the curves are where the edges are', !result.sketchEntities);

  // The plate made 60 wide: the side edge is at x = 60 now.
  result = await regenerate([...plate(60), sketch(es), pin]);
  at = pinAt();
  check('plate widened: the pin is still 8 in from its side', !result.errors.length && Math.abs(at[0] - 52) < 1e-6 && Math.abs(at[1] - 12) < 1e-6, `${said(result)} at ${at}`);
  const now: SketchEntity[] | undefined = result.sketchEntities?.s;
  const line = now?.find(e => e.id === 'ref-side') as any;
  const front2 = now?.find(e => e.id === 'ref-front') as any;
  check('the page is told the curves as they are now', !!line && Math.abs(line.a[0] - 60) < 1e-9 && Math.abs(line.b[0] - 60) < 1e-9 && Math.abs(Math.max(front2.a[0], front2.b[0]) - 60) < 1e-9, JSON.stringify(now));

  // The page takes them as the sketch's own: only the sketch is gone over again, what's made from it stays.
  const taken = JSON.parse(JSON.stringify(now)) as SketchEntity[];
  result = await regenerate([...plate(60), sketch(taken), pin]);
  at = pinAt();
  check('taken into the project: nothing more to tell, the pin where it was', !result.errors.length && !result.sketchEntities && Math.abs(at[0] - 52) < 1e-6, `${said(result)} ${JSON.stringify(result.sketchEntities)}`);
  check('and only the sketch was gone over again', rebuildStats.ran === 1 && rebuildStats.reused === 1, JSON.stringify(rebuildStats));

  // Narrower than the pin's distance allows nothing odd: 20 wide, the pin at 12.
  result = await regenerate([...plate(20), sketch(taken), pin]);
  at = pinAt();
  check('plate narrowed: the pin follows back', !result.errors.length && Math.abs(at[0] - 12) < 1e-6, `${said(result)} at ${at}`);

  // The body it follows deleted from before it: the curve stays, and the step says so.
  const lone = sketch(es);
  lone.links = [{ id: 'ref-side', edge: { ...side, body: 'none' } }];
  result = await regenerate([...plate(40), lone, pin]);
  check('the body gone: the curve stays where it was, with a note', !result.errors.length && /gone/.test(said(result)) && !result.sketchEntities && Math.abs(pinAt()[0] - 32) < 1e-6, said(result));
}

// In the sketch itself a curve that follows an edge doesn't move: the rest moves to it.
{
  const es: SketchEntity[] = [
    { id: 'ref-a', kind: 'line', a: [0, 0], b: [0, 10] },
    { id: 'c', kind: 'circle', center: [5, 5], radius: 1 }
  ];
  const solution = solve(es, [{ id: 'd', type: 'distance', pts: [{ e: 'c', p: 'c' }], curves: ['ref-a'], value: 9 }]);
  const line = solution.entities.find(e => e.id === 'ref-a') as any;
  const entity = solution.entities.find(e => e.id === 'c') as any;
  check('a dimension to it moves the other curve, not it', solution.ok && line.a[0] === 0 && line.b[0] === 0 && Math.abs(entity.center[0] - 9) < 1e-6, JSON.stringify(solution.entities));
  const pulled = solve(es, [], { drag: [{ ref: { e: 'ref-a', p: 'a' }, to: [4, 4] }] });
  check('dragged, it stays', (pulled.entities.find(e => e.id === 'ref-a') as any).a[0] === 0);
}
process.exit(failed ? 1 : 0);
