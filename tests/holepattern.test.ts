// Run: npx tsx tests/holepattern.test.ts
// A pattern started from a hole's round wall repeats the hole in its body - a hole right through, a blind one (the
// same depth), in a row and round an axis - and does not copy the body.
import { regenerate } from '../src/kernel/engine';
import { after, block, bodies, check, cylinder, done, health, near, volume } from './kit';
import type { Feature, Vec3 } from '../src/doc/types';
import type { Shape3D } from 'replicad';

const bodyShape = (id: string) => bodies().get(id) as Shape3D | undefined;
const cut = (id: string, target: string, tool: string): Feature => ({ id, name: id, type: 'boolean', op: 'subtract', target, tools: [tool] }) as unknown as Feature;
// A 100 x 40 x 10 plate with one hole (radius 3) near its corner: right through, or 6 deep from the top.
const plate = block('A', 100, 40, 10);
const through = [...plate, ...cylinder('P', 3, 14, 10, 10, -2), cut('c', 'A', 'P')];
const blind = [...plate, ...cylinder('P', 3, 8, 10, 10, 4), cut('c', 'A', 'P')];
const VOLUME = 40000;
const hole = Math.PI * 9;

/** The hole's wall, as the app would name it (its mesh's face: the round one that is a hole). */
async function wall(features: Feature[], body = 'A') {
  const result = await regenerate(structuredClone(features));
  const mesh = result.bodies.find(b => b.id === body)!;
  const face = mesh.faces.find(face => face.round?.hole)!;

  return { body, center: face.center, normal: face.normal, area: face.area };
}
const pattern = (hole: unknown, op: unknown, extra: Record<string, unknown> = {}): Feature => ({ id: 'pat', name: 'Hole Pattern', type: 'transform', bodies: ['A'], copy: false, hole, op, ...extra }) as unknown as Feature;

{
  const holeWall = await wall(through);
  const result = await after([...through, pattern(holeWall, { kind: 'linear', dir: [1, 0, 0], spacing: 20, count: 5 })]);
  check('a hole right through, five in a row 20 apart: one body, five holes, sound', !result.errors.length && bodies().size === 1 && near(volume(bodyShape('A')), VOLUME - 5 * hole * 10, 1e-2) && health(bodyShape('A')!).healthy, `${bodies().size} bodies, ${volume(bodyShape('A')).toFixed(2)} for ${(VOLUME - 5 * hole * 10).toFixed(2)} ${result.errors.join('; ')}`);
  const mesh = (await regenerate(structuredClone([...through, pattern(holeWall, { kind: 'linear', dir: [1, 0, 0], spacing: 20, count: 5 })]))).bodies[0];
  const xs = mesh.faces.filter(face => face.round?.hole).map(face => Math.round(face.center[0])).sort((a, b) => a - b).join();
  check('  the holes are at 10, 30, 50, 70 and 90', xs === '10,30,50,70,90', xs);
  check('  the plate is still 10 thick and flat (nothing dug below or above it)', JSON.stringify(bodyShape('A')!.boundingBox.bounds.map(bound => bound.map(value => Math.round(value * 1000) / 1000))) === '[[0,0,0],[100,40,10]]');
}
{
  const holeWall = await wall(blind);
  const result = await after([...blind, pattern(holeWall, { kind: 'linear', dir: [0, 1, 0], spacing: 10, count: 3 })]);
  check('a blind hole 6 deep, three in a row: each 6 deep', !result.errors.length && near(volume(bodyShape('A')), VOLUME - 3 * hole * 6, 1e-2) && health(bodyShape('A')!).healthy, `${volume(bodyShape('A')).toFixed(2)} for ${(VOLUME - 3 * hole * 6).toFixed(2)} ${result.errors.join('; ')}`);
}
{
  const holeWall = await wall(through);
  const ring = pattern(holeWall, { kind: 'circular', axis: { origin: [50, 20, 0], dir: [0, 0, 1] }, count: 4, angle: 360 });
  const result = await after([...through, ring]);
  // (10,10) turned about (50,20): (60,-20) and (40,60) are off the plate; (90,30) is on it.
  check('round an axis, four: the two that fall on the plate are cut, the two off it are said', near(volume(bodyShape('A')), VOLUME - 2 * hole * 10, 1e-2) && !result.errors.length, `${volume(bodyShape('A')).toFixed(2)} ${result.errors.join('; ')}`);
  const res = await regenerate(structuredClone([...through, ring]));
  check('  and a note says how many were off the body', (res.notes ?? []).some(featureError => /2 of the 3 new holes are off the body/.test(featureError.message)), JSON.stringify(res.notes));
}
{
  const hole = await wall(through);
  const off = await after([...through, pattern(hole, { kind: 'linear', dir: [0, 0, 1], spacing: 50, count: 3 })]);
  check('every new hole off the body: refused in plain words', off.errors.length === 1 && /None of those holes is on the body/.test(off.errors[0]), off.errors.join('; '));
  const zero = await after([...through, pattern(hole, { kind: 'linear', dir: [1, 0, 0], spacing: 0, count: 3 })]);
  check('a spacing of 0: refused in plain words', zero.errors.length === 1 && /spacing is zero/.test(zero.errors[0]));
  const flat = (await regenerate(structuredClone(through))).bodies[0].faces.find(face => face.plane)!;
  const notHole = await after([...through, pattern({ body: 'A', center: flat.center, normal: flat.normal, area: flat.area }, { kind: 'linear', dir: [1, 0, 0], spacing: 20, count: 3 })]);
  check("not a hole's wall: refused in plain words", notHole.errors.length === 1 && /round wall of a hole/.test(notHole.errors[0]), notHole.errors.join('; '));
}
{
  // The count changed afterwards: the holes are that many.
  const holeWall = await wall(through);
  for (const count of [2, 4, 3]) {
    const result = await after([...through, pattern(holeWall, { kind: 'linear', dir: [1, 0, 0], spacing: 20, count: count })]);
    check(`the count made ${count}: ${count} holes`, !result.errors.length && near(volume(bodyShape('A')), VOLUME - count * hole * 10, 1e-2));
  }
}
{
  // On a linked copy's original: the copy gets the holes too.
  const copy: Feature = { id: 'C', name: 'C', type: 'transform', bodies: ['A'], copy: true, link: true, op: { kind: 'move', translate: [0, 60, 0] as Vec3 } } as unknown as Feature;
  const steps = [...through, copy];
  const holeWall = await wall(steps);
  const result = await after([...steps, pattern(holeWall, { kind: 'linear', dir: [1, 0, 0], spacing: 20, count: 5 })]);
  check('the plate has a linked copy: the copy has the five holes too', !result.errors.length && near(volume(bodyShape('C:A:0')), VOLUME - 5 * hole * 10, 1e-2) && near(volume(bodyShape('A')), VOLUME - 5 * hole * 10, 1e-2), `${volume(bodyShape('C:A:0')).toFixed(2)}`);
}
done();
