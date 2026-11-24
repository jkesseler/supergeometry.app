// Run: npx tsx tests/sweepend.test.ts - Offset Face on the end of a sweep
// (a user's S-curve tube, tests/fixtures/sweepgaps.json, its start pushed in
// 4 mm): the tube gets 4 mm shorter along its path and its new end is square
// to the path there - a round end, as big as the profile. It used to slide the
// old end's plane in, cutting the bending tube on a slant (an oval end).
import { readFileSync } from 'node:fs';
import opencascade from 'replicad-opencascadejs';
import { measureArea, measureVolume, setOC } from 'replicad';
import { debugBodies, regenerate } from '../src/kernel/engine';
import { healthOf, isHealthy } from '../src/kernel/repair';

setOC(await (opencascade as unknown as () => Promise<any>)());
let failed = 0;
const check = (name: string, ok: boolean, info = '') => {
  if (!ok) {
    failed++;
  }
  console.log(ok ? 'ok  ' : 'FAIL', name, info);
};
const doc = JSON.parse(readFileSync(new URL('./fixtures/sweepgaps.json', import.meta.url), 'utf8'));
const BODY = 'sweep-mw6p7ni3-sy2n';
const RADIUS = 2.5;
const AREA = Math.PI * RADIUS * RADIUS;
await regenerate(doc.features);
const s0 = debugBodies().get(BODY)!;
const L0 = Math.abs(measureVolume(s0)) / AREA;
for (const distance of [4, 20]) {
  const feats = [
    ...doc.features,
    { id: 'off', name: 'Offset Face 03', type: 'extrude', source: { kind: 'face', face: { body: BODY, center: [0, 86.28285598162046, 43.4103407849028], normal: [0, 0.6567807448042061, -0.7540815958863021], area: AREA } }, distance: -distance, mode: 'auto', target: BODY }
  ];
  const result: any = await regenerate(feats);
  const shape = debugBodies().get(BODY)!;
  check(`start pushed in ${distance}: builds, one clean solid`, !result.errors.length && isHealthy(healthOf(shape)), result.errors.map((e: any) => e.message).join('; '));
  // (By volume: the length along the tube's own centre, which runs 2.34 off
  // the path - on a bend a little longer or shorter than the path itself.)
  const length = Math.abs(measureVolume(shape)) / AREA;
  check(`…about ${distance} mm shorter`, Math.abs(L0 - length - distance) < distance * 0.06, `${L0.toFixed(2)} → ${length.toFixed(2)}`);
  const ends = shape.faces.filter(face => face.geomType === 'PLANE');
  check('…both ends round and profile-sized (square to the path, not a slanted oval)', ends.length === 2 && ends.every(end => Math.abs(measureArea(end) - AREA) < AREA * 1e-3), ends.map(end => measureArea(end).toFixed(3)).join(', '));
}

// Pushed in twice (the second push finds the end where the first left it).
{
  const off = (id: string, center: number[], normal: number[], distance: number) => ({ id, name: id, type: 'extrude', source: { kind: 'face', face: { body: BODY, center, normal, area: AREA } }, distance: -distance, mode: 'auto', target: BODY });
  const first = off('off1', [0, 86.28285598162046, 43.4103407849028], [0, 0.6567807448042061, -0.7540815958863021], 4);
  await regenerate([...doc.features, first]);
  const s1 = debugBodies().get(BODY)!;
  const end1 = s1.faces.filter(face => face.geomType === 'PLANE').sort((a, b) => a.center.z - b.center.z)[0];
  const L1 = Math.abs(measureVolume(s1)) / AREA;
  const result: any = await regenerate([...doc.features, first, off('off2', end1.center.toTuple(), end1.normalAt().toTuple(), 10)]);
  const shape = debugBodies().get(BODY)!;
  const length = Math.abs(measureVolume(shape)) / AREA;
  const ends = shape.faces.filter(face => face.geomType === 'PLANE');
  check('pushed in again: about 10 shorter still, both ends round', !result.errors.length && Math.abs(L1 - length - 10) < 0.6 && ends.length === 2 && ends.every(end => Math.abs(measureArea(end) - AREA) < AREA * 1e-3), `${L1.toFixed(2)} → ${length.toFixed(2)}; ends ${ends.map(end => measureArea(end).toFixed(3)).join(', ')}`);
}

// A profile centred on its path (the fan's guard spoke): exactly that much shorter.
{
  const r1 = 1.4;
  const a1 = Math.PI * r1 * r1;
  const base = [
    { id: 'sSpokePath', name: 'Spoke path', type: 'sketch', plane: { origin: [0, 0, 0], normal: [1, 0, 0], xDir: [0, 1, 0] }, entities: [{ id: 'sp1', kind: 'spline', points: [[-62, 320], [-64, 300], [-71, 262], [-77, 226]], closed: false, mode: 'fit' }] },
    { id: 'sSpoke', name: 'Spoke', type: 'sketch', plane: { origin: [0, 0, 320], normal: [0, 0, 1], xDir: [1, 0, 0] }, entities: [{ id: 'c', kind: 'circle', center: [0, -62], radius: r1 }] },
    { id: 'spoke', name: 'Spoke', type: 'sweep', source: { kind: 'profile', sketch: 'sSpoke', regions: [{ c: [0, -62], a: a1 }] }, path: { kind: 'sketch', sketch: 'sSpokePath', entities: ['sp1'] }, mode: 'new' }
  ];
  await regenerate(base);
  const L0 = Math.abs(measureVolume(debugBodies().get('spoke')!)) / a1;
  const result: any = await regenerate([...base, { id: 'off', name: 'Offset Face', type: 'extrude', source: { kind: 'face', face: { body: 'spoke', center: [0, -62, 320], normal: [0, 0, 1], area: a1 } }, distance: -10, mode: 'auto', target: 'spoke' }]);
  const shape = debugBodies().get('spoke')!;
  const length = Math.abs(measureVolume(shape)) / a1;
  check("fan spoke's top pushed in 10: exactly 10 shorter, ends round", !result.errors.length && Math.abs(L0 - length - 10) < 0.02 && shape.faces.filter(face => face.geomType === 'PLANE').every(face => Math.abs(measureArea(face) - a1) < a1 * 1e-3), `${L0.toFixed(3)} → ${length.toFixed(3)}`);
}
process.exit(failed ? 1 : 0);
