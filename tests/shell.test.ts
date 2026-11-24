// Run: npx tsx tests/shell.test.ts - Shell on shapes with many faces.
import opencascade from 'replicad-opencascadejs';
import { setOC } from 'replicad';
import { regenerate } from '../src/kernel/engine';
import { arrangement, regionRef } from '../src/sketch/regions';
import type { Feature, PlaneDef } from '../src/doc/types';
import type { BodyMesh } from '../src/kernel/protocol';

setOC(await (opencascade as unknown as () => Promise<any>)());

const XY: PlaneDef = { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, 0, 1] };
const sketch = (id: string, entities: any[], plane = XY): Feature => ({ id, name: id, type: 'sketch', plane: plane, entities });
const extrude = (id: string, sk: string, entities: any[], distance: number, mode: 'new' | 'auto' = 'new'): Feature => ({ id, name: id, type: 'extrude', source: { kind: 'profile', sketch: sk, regions: arrangement(entities).regions.map(regionRef) }, distance: distance, mode });

function volume(b: BodyMesh): number {
  const positions = b.positions;
  const ix = b.indices;
  let volume = 0;
  for (let i = 0; i < ix.length; i += 3) {
    const [a, offsetB, offsetC] = [ix[i] * 3, ix[i + 1] * 3, ix[i + 2] * 3];
    volume += (positions[a] * (positions[offsetB + 1] * positions[offsetC + 2] - positions[offsetB + 2] * positions[offsetC + 1]) - positions[a + 1] * (positions[offsetB] * positions[offsetC + 2] - positions[offsetB + 2] * positions[offsetC]) + positions[a + 2] * (positions[offsetB] * positions[offsetC + 1] - positions[offsetB + 1] * positions[offsetC])) / 6;
  }

  return volume;
}

let failed = 0;
/** Shell the body's top-most face and check it hollowed (volume went well down) and stayed closed. */
async function check(name: string, feats: Feature[], body: string, t = 1): Promise<void> {
  const r0 = await regenerate(feats);
  const b0 = r0.bodies.find(b => b.id === body)!;
  // The biggest upward face (the lid you'd open).
  const top = b0.faces.reduce((bi, face, i) => (face.normal[2] > 0.99 && (b0.faces[bi].normal[2] <= 0.99 || face.area > b0.faces[bi].area) ? i : bi), 0);
  const faceInfo = b0.faces[top];
  const result = await regenerate([...feats, { id: 'sh', name: 'Shell', type: 'shell', body, faces: [{ body, center: faceInfo.center, normal: faceInfo.normal, area: faceInfo.area }], thickness: t }]);
  const b = result.bodies.find(bodyMesh => bodyMesh.id === body);
  const v0 = volume(b0);
  const bodyVolume = b ? volume(b) : NaN;
  const ok = !result.errors.length && !!b && bodyVolume < v0 * 0.8 && bodyVolume > 0 && b.openEdges.length === 0;
  if (!ok) {
    failed++;
  }
  console.log(ok ? 'ok  ' : 'FAIL', name, `${b0.faces.length} faces, vol ${v0.toFixed(0)} → ${bodyVolume.toFixed(0)}`, result.errors.map(e => e.message).join('; '));
}

const box = [{ id: 'r', kind: 'rect', center: [0, 0], w: 40, h: 30, rotation: 0 }];
const base = [sketch('s', box), extrude('b', 's', box, 20)];
const edgesOfBox = (z: number) => [
  { body: 'b', mid: [0, -15, z], dir: [1, 0, 0], length: 40 }, { body: 'b', mid: [0, 15, z], dir: [1, 0, 0], length: 40 },
  { body: 'b', mid: [-20, 0, z], dir: [0, 1, 0], length: 30 }, { body: 'b', mid: [20, 0, z], dir: [0, 1, 0], length: 30 }
];
const verticals = [[-20, -15], [20, -15], [20, 15], [-20, 15]].map(([x, y]) => ({ body: 'b', mid: [x, y, 10], dir: [0, 0, 1], length: 20 }));

await check('plain box', base, 'b');
await check('box, vertical edges rounded', [...base, { id: 'f', name: 'f', type: 'fillet', edges: verticals as any, radius: 4 }], 'b');
await check('box, every edge rounded', [...base, { id: 'f1', name: 'f', type: 'fillet', edges: verticals as any, radius: 4 }, { id: 'f2', name: 'f', type: 'fillet', edges: [{ body: 'b', mid: [0, -15, 0], dir: [1, 0, 0], length: 32 }] as any, radius: 2 }], 'b');
await check('box, bottom edges chamfered', [...base, { id: 'c', name: 'c', type: 'chamfer', edges: edgesOfBox(0) as any, radius: 2 }], 'b');
// Many small faces: a box with ribs joined on top, then a 24-sided column.
const ribs = Array.from({ length: 6 }, (_, i) => ({ id: `k${i}`, kind: 'rect', center: [-15 + i * 6, 0], w: 2, h: 30, rotation: 0 }));
await check('box with 6 ribs joined', [...base, sketch('s2', ribs, { ...XY, origin: [0, 0, 20] }), { ...extrude('j', 's2', ribs, 5, 'auto'), target: 'b' } as any], 'b');
const poly = [{ id: 'p', kind: 'polygon', center: [0, 0], radius: 20, sides: 24, angle: 0 }];
await check('24-sided prism', [sketch('s', poly), extrude('b', 's', poly, 20)], 'b');
const star = [{ id: 'st', kind: 'polyline', closed: true, points: Array.from({ length: 20 }, (_, i) => {
  const a = (i / 20) * Math.PI * 2; const radius = i % 2 ? 9 : 20;

  return [radius * Math.cos(a), radius * Math.sin(a)]; 
}) }];
await check('10-point star prism', [sketch('s', star), extrude('b', 's', star, 15)], 'b', 0.8);

// A ball tapped and shelled: its one round face picked leaves no wall, so it's hollowed sealed, with a note (it said "try a smaller thickness").
{
  const XZ: PlaneDef = { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, -1, 0] };
  const es = [{ id: 'c', kind: 'circle', center: [0, 0], radius: 15.8 }, { id: 'l', kind: 'line', a: [-35, 0], b: [35, 0] }];
  const up = arrangement(es as any).regions.map(regionRef).filter((region: any) => region.c[1] > 0);
  const ball: Feature[] = [sketch('s', es, XZ), { id: 'b', name: 'b', type: 'revolve', source: { kind: 'profile', sketch: 's', regions: up }, axis: { origin: [0, 0, 0], dir: [1, 0, 0] }, angle: 360, mode: 'new' } as any];
  const r0 = await regenerate(ball);
  const firstFace = r0.bodies[0].faces[0];
  const result = await regenerate([...ball, { id: 'sh', name: 'Shell', type: 'shell', body: 'b', faces: [{ body: 'b', center: firstFace.center, normal: firstFace.normal, area: firstFace.area }], thickness: 1 }]);
  const bodyVolume = volume(result.bodies[0]);
  const want = (4 / 3) * Math.PI * (15.8 ** 3 - 14.8 ** 3);
  const ok = !result.errors.length && r0.bodies[0].faces.length === 1 && Math.abs(bodyVolume - want) < want * 0.01 && (result as any).notes?.some((note: any) => note.featureId === 'sh');
  if (!ok) {
    failed++;
  }
  console.log(ok ? 'ok  ' : 'FAIL', 'ball with its one face picked: hollow, sealed, with a note', `vol ${bodyVolume.toFixed(0)} (${want.toFixed(0)})`, result.errors.map(e => e.message).join('; '));
}

process.exit(failed ? 1 : 0);
