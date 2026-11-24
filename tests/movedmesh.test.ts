// Run: npx tsx tests/movedmesh.test.ts
// A body moved, turned, mirrored or patterned has the same shape: its mesh is
// the original's, moved the same way (not meshed again - seconds on a big
// body). Each face's triangles must still be that face: same area, same
// middle, facing out - also mirrored, where they're turned round.
import { regenerate } from '../src/kernel/engine';
import { check, done, sketch, rect, circle, poly, extrude, XY } from './kit';
import type { Feature, Vec3 } from '../src/doc/types';
import type { BodyMesh } from '../src/kernel/protocol';

// An L-shaped block with a round hole and a slot: faces of every kind, no two alike.
const feature = sketch('s', XY(), [poly('p', [[0, 0], [40, 0], [40, 15], [15, 15], [15, 30], [0, 30]])]);
const holes = sketch('h', XY(12), [circle('c', 7, 7, 4), rect('r', 25, 4, 35, 9)]);
const body: Feature[] = [feature, extrude('E', feature, 12), holes, { ...extrude('H', holes, 8, 'cut'), reverse: true } as Feature];

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Per face: the triangles' area and area-weighted middle, and how many triangles face against their vertex normals. */
function check1(name: string, bodyMesh: BodyMesh) {
  const positionAt = (i: number): Vec3 => [bodyMesh.positions[i * 3], bodyMesh.positions[i * 3 + 1], bodyMesh.positions[i * 3 + 2]];
  const normalAt = (i: number): Vec3 => [bodyMesh.normals[i * 3], bodyMesh.normals[i * 3 + 1], bodyMesh.normals[i * 3 + 2]];
  let worst = 0;
  let worstAt = '';
  let inward = 0;
  for (const faceGroup of bodyMesh.faceGroups) {
    let area = 0;
    const centroid: Vec3 = [0, 0, 0];
    for (let t = faceGroup.start; t < faceGroup.start + faceGroup.count; t += 3) {
      const [a, b, indexC] = [bodyMesh.indices[t], bodyMesh.indices[t + 1], bodyMesh.indices[t + 2]];
      const normal = cross(sub(positionAt(b), positionAt(a)), sub(positionAt(indexC), positionAt(a)));
      const triangleArea = Math.hypot(...normal) / 2;
      if (dot(normal, normalAt(a)) < 0) {
        inward++;
      }
      area += triangleArea;
      for (let axis = 0; axis < 3; axis++) {
        centroid[axis] += (triangleArea * (positionAt(a)[axis] + positionAt(b)[axis] + positionAt(indexC)[axis])) / 3;
      }
    }
    const face = bodyMesh.faces[faceGroup.face];
    const off = Math.hypot(...sub(centroid.map(x => x / area) as Vec3, face.center));
    const da = Math.abs(area - face.area) / face.area;
    if (off + da * 10 > worst) {
      (worst = off + da * 10), (worstAt = `face ${faceGroup.face} (${face.type}): middle ${off.toFixed(3)} mm off, area ${(da * 100).toFixed(2)} % off`);
    }
  }
  check(`${name}: every face's triangles are that face, facing out`, worst < 0.3 && inward === 0, `${worstAt}; ${inward} triangles facing in`);
  // Each edge's line is that edge: its ends are the edge's own (either way round).
  let far = 0;
  const edgeAt = (i: number): Vec3 => [bodyMesh.edgePositions[i * 3], bodyMesh.edgePositions[i * 3 + 1], bodyMesh.edgePositions[i * 3 + 2]];
  const distance = (a: Vec3, b: Vec3) => Math.hypot(...sub(a, b));
  for (const edgeGroup of bodyMesh.edgeGroups) {
    const e = bodyMesh.edges[edgeGroup.edge];
    const [start, q] = [edgeAt(edgeGroup.start), edgeAt(edgeGroup.start + edgeGroup.count - 1)];
    far = Math.max(far, Math.min(distance(start, e.start) + distance(q, e.end), distance(start, e.end) + distance(q, e.start)));
  }
  check(`${name}: every edge's line is that edge`, far < 0.05, `${far.toFixed(4)} mm off`);
}

const moves: [string, Feature, string[]][] = [
  ['moved and turned', { id: 'T', name: 'T', type: 'transform', bodies: ['E'], op: { kind: 'move', translate: [30, -20, 5], rotate: { origin: [10, 10, 0], axis: [0.3, 0.4, 1], angle: 37 } } } as Feature, ['E']],
  ['mirrored', { id: 'T', name: 'T', type: 'transform', bodies: ['E'], op: { kind: 'mirror', plane: { origin: [50, 0, 0], xDir: [0, 1, 0], normal: [1, 0.2, 0] } } } as Feature, ['E']],
  ['mirrored as a copy', { id: 'T', name: 'T', type: 'transform', bodies: ['E'], copy: true, op: { kind: 'mirror', plane: { origin: [0, -5, 0], xDir: [1, 0, 0], normal: [0, 1, 0] } } } as Feature, ['E', 'T:E:0']],
  ['a row of copies', { id: 'T', name: 'T', type: 'transform', bodies: ['E'], op: { kind: 'linear', dir: [1, 1, 0], spacing: 60, count: 3 } } as Feature, ['E', 'T:E:0', 'T:E:1']],
  ['copies round an axis', { id: 'T', name: 'T', type: 'transform', bodies: ['E'], op: { kind: 'circular', axis: { origin: [-20, 0, 0], dir: [0, 0, 1] }, angle: 360, count: 4 } } as Feature, ['E', 'T:E:0', 'T:E:1', 'T:E:2']]
];

for (const [name, step, ids] of moves) {
  // Once without the step (the body's own mesh, kept), once with it.
  await regenerate(structuredClone(body));
  const result = await regenerate([...structuredClone(body), step]);
  check(`${name}: built`, !result.errors.length && ids.every(id => result.bodies.some(b => b.id === id)), result.errors.map(e => e.message).join(' | '));
  for (const id of ids) {
    const body = result.bodies.find(b => b.id === id);
    if (body) {
      check1(`${name}, ${id}`, body);
    }
  }
}

// The same done from nothing (no mesh of the original to start from): meshed as usual, and the same.
{
  const result = await regenerate([...structuredClone(body), { ...moves[0][1], id: 'T2' }]);
  const bodyMesh = result.bodies.find(b => b.id === 'E');
  check('moved, built in one go: built', !result.errors.length && !!bodyMesh);
  if (bodyMesh) {
    check1('moved, built in one go', bodyMesh);
  }
}

done();
