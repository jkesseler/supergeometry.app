// Run: npx tsx tests/soapdish2.test.ts - an oval soap dish held to a
// millionth all the way, its sides swept faces (an ellipse extruded: measured
// by our own integrator, not OpenCascade's): pulled up, shelled open at the
// top (the wall an inward offset of the ellipse: A - P·t + π·t²), drain slots
// patterned along the floor and taken away, cut in two down the middle and
// joined again, scaled up by half. Then the ellipse made wider at the start:
// every step after follows.
import { measureArea, type Face } from 'replicad';
import { measureVolume } from '../src/kernel/ocFree';
import { after, bodies, check, done, health, near, rect, sketch, XY, YZ, profile } from './kit';
import type { Shape3D } from 'replicad';
import type { FaceRef, Feature, SketchEntity, Vec3 } from '../src/doc/types';

const vol = (id: string) => Math.abs(measureVolume(bodies().get(id) as Shape3D));
const PI = Math.PI;
const HALF_WIDTH = 25, HEIGHT = 22, t = 2.5; // the half-width, height, wall
const SW = 3, SL = 16, NS = 5, SP = 7; // slots: width, length, how many, spacing

/** The ellipse's perimeter, integrated (Gauss, many pieces: exact to far below a millionth). */
function perimeter(a: number, b: number) {
  const GAUSS: [number, number][] = [[-0.906179845938664, 0.2369268850561891], [-0.5384693101056831, 0.4786286704993665], [0, 0.5688888888888889], [0.5384693101056831, 0.4786286704993665], [0.906179845938664, 0.2369268850561891]];
  let sum = 0;
  const steps = 400;
  for (let i = 0; i < steps; i++) {
    const step = PI / steps;
    const middle = (2 * i + 1) * step;
    for (const [x, weight] of GAUSS) {
      const angle = middle + step * x;
      sum += weight * step * Math.hypot(a * Math.sin(angle), b * Math.cos(angle));
    }
  }

  return sum;
}

const faceRef = (id: string, face: Face): FaceRef => ({ body: id, center: face.center.toTuple() as Vec3, normal: face.normalAt().toTuple() as Vec3, area: measureArea(face) });

function steps(halfLength: number): Feature[] {
  const oval = [{ id: 'e', kind: 'ellipse', center: [0, 0], rx: halfLength, ry: HALF_WIDTH, rotation: 0 } as SketchEntity];

  return [sketch('sOval', XY(), oval), { id: 'dish', name: 'Dish', type: 'extrude', source: profile('sOval', oval), distance: HEIGHT, mode: 'new' } as Feature];
}

async function run(label: string, halfLength: number, more: Feature[] | null) {
  const area = PI * halfLength * HALF_WIDTH;
  const perimeterLength = perimeter(halfLength, HALF_WIDTH);
  const fs = steps(halfLength);
  let { errors } = await after(fs);
  check(`${label}: the oval pulled up (π·a·b·h)`, !errors.length && near(vol('dish'), area * HEIGHT, 1e-6 * area * HEIGHT), [errors, vol('dish'), area * HEIGHT]);
  // Shelled open at the top.
  if (!more) {
    const top = (bodies().get('dish') as Shape3D).faces.find(face => face.geomType === 'PLANE' && near(face.center.z, HEIGHT, 1e-6))!;
    fs.push({ id: 'hollow', name: 'Shell', type: 'shell', body: 'dish', faces: [faceRef('dish', top)], thickness: t } as Feature);
  } else {
    fs.push(more[0]);
  }
  ({ errors } = await after(fs));
  const inner = area - perimeterLength * t + PI * t * t;
  const vShell = area * HEIGHT - inner * (HEIGHT - t);
  check(`${label}: shelled open (the wall an inward offset: A - P·t + π·t²)`, !errors.length && near(vol('dish'), vShell, 1e-6 * vShell), [errors, vol('dish'), vShell]);
  // Drain slots: one slot body through the floor, patterned along x, taken away.
  const x0 = -((NS - 1) * SP) / 2;
  const slot = [rect('sl', x0 - SW / 2, -SL / 2, x0 + SW / 2, SL / 2)];
  if (!more) {
    fs.push(
      sketch('sSlot', XY(-1), slot),
      { id: 'slot', name: 'Slot', type: 'extrude', source: profile('sSlot', slot), distance: t + 2, mode: 'new' } as Feature,
      { id: 'slots', name: 'Slots', type: 'transform', bodies: ['slot'], copy: true, op: { kind: 'linear', dir: [1, 0, 0], spacing: SP, count: NS } } as Feature
    );
  } else {
    fs.push(...more.slice(1, 4));
  }
  ({ errors } = await after(fs));
  const slotIds = [...bodies().keys()].filter(key => key.startsWith('slot'));
  check(`${label}: ${NS} slot bodies in a row`, !errors.length && slotIds.length === NS, [errors, slotIds]);
  if (!more) {
    fs.push({ id: 'drain', name: 'Drain', type: 'boolean', op: 'subtract', target: 'dish', tools: slotIds } as Feature);
  } else {
    fs.push(more[4]);
  }
  ({ errors } = await after(fs));
  const vDrain = vShell - NS * SW * SL * t;
  check(`${label}: the slots through the floor`, !errors.length && bodies().size === 1 && near(vol('dish'), vDrain, 1e-6 * vDrain), [errors, [...bodies().keys()], vol('dish'), vDrain]);
  // Cut in two down the middle (across the slots' row: the middle slot is cut too).
  if (!more) {
    fs.push({ id: 'halve', name: 'Split', type: 'split', body: 'dish', plane: YZ() } as Feature);
  } else {
    fs.push(more[5]);
  }
  ({ errors } = await after(fs));
  const halves = [...bodies().keys()];
  const vs = halves.map(vol);
  check(`${label}: split in two halves, each half of it`, !errors.length && halves.length === 2 && vs.every(volume => near(volume, vDrain / 2, 1e-6 * vDrain)), [errors, halves, vs, vDrain / 2]);
  if (!more) {
    fs.push({ id: 'rejoin', name: 'Union', type: 'boolean', op: 'union', target: halves[0], tools: [halves[1]] } as Feature);
  } else {
    fs.push(more[6]);
  }
  ({ errors } = await after(fs));
  const one = [...bodies().keys()];
  check(`${label}: joined again, all of it`, !errors.length && one.length === 1 && near(vol(one[0]), vDrain, 1e-6 * vDrain), [errors, one, one.map(vol), vDrain]);
  if (!more) {
    fs.push({ id: 'bigger', name: 'Scale', type: 'transform', bodies: [one[0]], copy: false, op: { kind: 'scale', center: [0, 0, 0], factor: 1.5 } } as Feature);
  } else {
    fs.push(more[7]);
  }
  ({ errors } = await after(fs));
  const end = [...bodies().keys()];
  check(`${label}: scaled by 1.5 (the volume 3.375 times)`, !errors.length && end.length === 1 && near(vol(end[0]), vDrain * 3.375, 1e-6 * vDrain * 3.375), [errors, end, end.map(vol), vDrain * 3.375]);
  const bodyHealth = health(bodies().get(end[0]) as Shape3D, end[0]);
  check(`${label}: sound`, bodyHealth.healthy, bodyHealth.healthy ? `${Math.round(bodyHealth.volume)} mm³` : bodyHealth);

  return fs.slice(2);
}

const later = await run('first', 40, null);
await run('wider', 48, later);
await run('rounder', 30, later);
done();
