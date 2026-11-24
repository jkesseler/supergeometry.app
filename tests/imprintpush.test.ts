// Run: npx tsx tests/imprintpush.test.ts - a circle projected onto a block's
// top (Project as Edge), its disc then pushed with Move Face: up 4 it is a
// round boss, down 4 a round pocket (it did nothing at all - the faces round
// the disc lie in its plane, so moving the plane moved nothing - and said
// nothing). Then the circle moved and made bigger, the block made taller: the
// push follows. Tilting the disc says why it can't.
import { measureVolume, type Shape3D } from 'replicad';
import { after, bodies, check, done, near, rect, circle, sketch, XY, profile, health } from './kit';
import type { Feature } from '../src/doc/types';

const build = (height: number, cx: number, radius: number, move: Partial<Feature>): Feature[] => {
  const es = [rect('r', 0, 0, 40, 30)];
  const ce = [circle('c', cx, 15, radius)];

  return [
    sketch('s', XY(), es),
    { id: 'b', name: 'Block', type: 'extrude', source: profile('s', es), distance: height, mode: 'new' } as Feature,
    sketch('k', XY(height), ce),
    { id: 'i', name: 'Project as Edge', type: 'imprint', body: 'b', source: profile('k', ce) } as Feature,
    // The disc as tapped (on the first block, 20 high, the circle at 15 with radius 5).
    { id: 'p', name: 'Move Face', type: 'moveFace', face: { body: 'b', center: [15, 15, 20], normal: [0, 0, 1], area: Math.PI * 25, step: 'b', curve: 'cap:1@r:0' }, translate: [0, 0, 4], ...move } as Feature
  ];
};
{
  // Projected from above, the circle lands on the top only: the bottom (out
  // of sight behind the block) stays whole.
  const { r, errors } = await after(build(20, 15, 5, {}).slice(0, 4));
  const faces = r.bodies[0].faces;
  const bottom = faces.filter(face => face.normal[2] < -0.99);
  check('projected: the top split in two, the bottom whole', !errors.length && faces.length === 7 && bottom.length === 1 && near(bottom[0].area, 1200, 1e-6), faces.map(face => [face.center, face.area]));
}
for (const distance of [4, -4]) {
  for (const [height, cx, radius] of [[20, 15, 5], [20, 25, 5], [20, 15, 7], [26, 15, 5], [26, 25, 3]]) {
    const { errors } = await after(build(height, cx, radius, { translate: [0, 0, distance] } as Partial<Feature>));
    const b = bodies().get('b') as Shape3D;
    const volume = Math.abs(measureVolume(b));
    const top = b.boundingBox.bounds[1][2];
    check(`pushed ${distance > 0 ? 'up' : 'down'} ${Math.abs(distance)}, block ${height} high, circle at ${cx} radius ${radius}: ${distance > 0 ? 'a boss' : 'a pocket'}`, !errors.length && near(volume - 1200 * height, Math.PI * radius * radius * distance, 1e-6) && near(top, height + Math.max(distance, 0), 1e-9) && health(b).healthy, [errors, volume - 1200 * height, top]);
  }
}
{
  const { errors } = await after(build(20, 15, 5, { translate: [0, 0, 0], rotate: { origin: [15, 15, 20], axis: [1, 0, 0], angle: 10 } } as Partial<Feature>));
  check('tilted: says it can only go straight out or in', errors.length === 1 && /pushed straight out or in/.test(errors[0]), errors);
}
done();
