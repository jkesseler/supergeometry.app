// Run: npx tsx tests/pushfollows.test.ts - a face pushed out (or tilted about
// a line in it) after an earlier step tilted it, then that earlier tilt
// changed: the push stays a push, square to the face as it is now (it was
// taken for a slide: a sheared move, or "Sliding or turning a face within its
// plane..." on a body with a round face); the tilt stays a tilt. The earlier
// tilt turned to 0 or switched off: the push still finds its face.
import { measureVolume, type Shape3D } from 'replicad';
import { after, bodies, check, done, near, rect, circle, sketch, XY, profile, health } from './kit';
import type { Feature, Vec3 } from '../src/doc/types';

const radians = (a: number) => (a * Math.PI) / 180;
const PUSH = 3; // the push
for (const hole of [false, true]) {
  const es = [rect('r', 0, 0, 40, 30), ...(hole ? [circle('h', 15, 15, 4)] : [])];
  const v0 = (hole ? 1200 - Math.PI * 16 : 1200) * 20;
  const base: Feature[] = [sketch('s', XY(), es), { id: 'b', name: 'Block', type: 'extrude', source: profile('s', es, rs => rs.filter(regionRef => regionRef.a > 500)), distance: 20, mode: 'new' } as Feature];
  const tilt = (a: number): Feature => ({ id: 't', name: 'Tilt', type: 'moveFace', face: { body: 'b', center: [40, 15, 10], normal: [1, 0, 0], area: 600 }, translate: [0, 0, 0], rotate: { origin: [40, 15, 10], axis: [0, 0, 1], angle: a } }) as Feature;
  // Made after a 5° tilt, from the face as it was then.
  const n5: Vec3 = [Math.cos(radians(5)), Math.sin(radians(5)), 0];
  const ref = { body: 'b', center: [40, 15, 10] as Vec3, normal: n5, area: 600 / Math.cos(radians(5)), step: 't' };
  const push: Feature = { id: 'p', name: 'Push', type: 'moveFace', face: ref, translate: [PUSH * n5[0], PUSH * n5[1], 0] } as Feature;
  const lean: Feature = { id: 'l', name: 'Lean', type: 'moveFace', face: ref, translate: [0, 0, 0], rotate: { origin: [40, 15, 10], axis: [-n5[1], n5[0], 0], angle: 4 } } as Feature;
  const label = hole ? 'with a hole' : 'plain';
  for (const a of [5, 8, -3, 0, 'off'] as const) {
    const t = a === 'off' ? { ...tilt(5), suppressed: true } : tilt(a);
    const ang = a === 'off' ? 0 : a;
    let { errors } = await after([...base, t, push]);
    let b = bodies().get('b') as Shape3D;
    let volume = b ? Math.abs(measureVolume(b)) : NaN;
    check(`${label}, first tilt ${a}: the push adds its face times ${PUSH}`, !errors.length && near(volume - v0, (PUSH * 600) / Math.cos(radians(ang)), 1e-6), [errors, volume - v0]);
    await after([...base, t]);
    const x0 = (bodies().get('b') as Shape3D).boundingBox.bounds[1][0];
    ({ errors } = await after([...base, t, lean]));
    b = bodies().get('b') as Shape3D;
    volume = b ? Math.abs(measureVolume(b)) : NaN;
    const out = b ? b.boundingBox.bounds[1][0] - x0 : NaN;
    check(`${label}, first tilt ${a}: the lean about its middle line keeps the volume, its top edge out`, !errors.length && near(volume, v0, 1e-6) && near(out, 10 * Math.tan(radians(4)) * Math.cos(radians(ang)), 0.05) && health(b).healthy, [errors, volume - v0, out]);
  }
}
done();
