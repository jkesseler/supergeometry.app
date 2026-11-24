// Run: npx tsx tests/autodirection.test.ts - Auto by the way it goes (new
// extrudes): a shape drawn on its own (on a plane, not on a face) going + is a
// new body, whatever it runs into; going - it cuts what it runs into (a new
// body when it runs into nothing). On a face: out adds, in cuts. And extrudes
// saved before (no byDirection) still cut what they run into either way, so
// old projects come out as they were.
import { measureVolume } from '../src/kernel/ocFree';
import { after, block, bodies, check, done, extrude, near, rect, sketch, XY } from './kit';
import type { Shape3D } from 'replicad';
import type { Feature } from '../src/doc/types';

const vol = (shape: Shape3D) => Math.abs(measureVolume(shape));
const box = block('Box', 40, 40, 20); // 32000
const slot = sketch('Slot', XY(10), [rect('s', 10, 10, 30, 30)]); // in the box's middle height
const sum = () => [...bodies().values()].reduce((total, body) => total + vol(body as Shape3D), 0);

{
  const { errors } = await after([...box, slot, extrude('Up', slot, 30, 'auto', { byDirection: true })]);
  // A new body 20x20x30 standing in the box, the box as it was.
  check('going +, drawn on its own: a new body, the box untouched', !errors.length && bodies().size === 2 && near(vol(bodies().get('Box') as Shape3D), 32000, 1e-6) && near(vol(bodies().get('Up') as Shape3D), 12000, 1e-6), [errors, bodies().size, sum()]);
}
{
  const { errors } = await after([...box, slot, extrude('Down', slot, -30, 'auto', { byDirection: true })]);
  // Down from z 10 through the floor: a 20x20x10 pocket out of the box, no new body.
  check('going -, drawn on its own: a cut of what it runs into', !errors.length && bodies().size === 1 && near(vol(bodies().get('Box') as Shape3D), 32000 - 4000, 1e-6), [errors, bodies().size, sum()]);
}
{
  const air = sketch('Air', XY(50), [rect('a', 10, 10, 30, 30)]);
  const { errors } = await after([...box, air, extrude('Below', air, -10, 'auto', { byDirection: true })]);
  check('going -, running into nothing: a new body', !errors.length && bodies().size === 2 && near(vol(bodies().get('Below') as Shape3D), 4000, 1e-6), [errors, bodies().size]);
}
{
  // Saved before: the same + extrude cut through the box (and made no body).
  const { errors } = await after([...box, slot, extrude('Old', slot, 30, 'auto')]);
  check('an extrude saved before: cuts as it did', !errors.length && bodies().size === 1 && near(vol(bodies().get('Box') as Shape3D), 32000 - 4000, 1e-6), [errors, bodies().size, sum()]);
}
{
  // On the box's top face: out adds, in cuts (target: the box).
  const top = { ...sketch('Top', XY(20), [rect('t', 10, 10, 30, 30)]), attachedTo: { body: 'Box', normal: [0, 0, 1] } } as Feature;
  let built = await after([...box, top, extrude('Boss', top, 5, 'auto', { byDirection: true, target: 'Box' })]);
  check('on a face, out: added to it', !built.errors.length && bodies().size === 1 && near(vol(bodies().get('Box') as Shape3D), 32000 + 2000, 1e-6), [built.errors, bodies().size, sum()]);
  built = await after([...box, top, extrude('Pocket', top, -5, 'auto', { byDirection: true, target: 'Box' })]);
  check('on a face, in: cut from it', !built.errors.length && bodies().size === 1 && near(vol(bodies().get('Box') as Shape3D), 32000 - 2000, 1e-6), [built.errors, bodies().size, sum()]);
}
done();
