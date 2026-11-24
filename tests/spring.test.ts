// Run: npx tsx tests/spring.test.ts [out.json] - a coil spring: a wire 3
// across, its middle 12 out from the Z axis on the front plane, revolved five
// times round (1800°) while it climbs 30 (Travel: a 6 pitch). The volume is
// exactly the wire's area times the path of its middle round the axis (the
// climb is in the wire's own plane, so it adds nothing): π·1.5²·2π·12·5.
import { readFileSync, writeFileSync } from 'node:fs';
import { measureVolume } from '../src/kernel/ocFree';
import { arrangement, regionRef } from '../src/sketch/regions';
import { after, bodies, check, circle, done, health, near, sketch, XZ } from './kit';
import type { Shape3D } from 'replicad';
import type { Feature, SketchEntity } from '../src/doc/types';

const vol = (s: Shape3D) => Math.abs(measureVolume(s));
const profileOf = (sk: string, es: SketchEntity[]) => ({ kind: 'profile' as const, sketch: sk, regions: arrangement(es).regions.map(regionRef) });
const PI = Math.PI;

const W = 1.5; // the wire: 3 across
const R = 12; // its middle 12 out
const N = 5, P = 6; // five turns, 6 apart

const wireEs = [circle('w', R, 0, W)];
const steps: Feature[] = [
  sketch('Wire', XZ(), wireEs),
  { id: 'Coil', name: 'Revolve', type: 'revolve', source: profileOf('Wire', wireEs), axis: { origin: [0, 0, 0], dir: [0, 0, 1] }, angle: 360 * N, travel: P * N, mode: 'new' } as Feature
];
const { errors } = await after(steps);
const coil = [...bodies().values()][0] as Shape3D;
const want = PI * W * W * 2 * PI * R * N;
check("the coil: one body, the wire's area along its middle's path", !errors.length && bodies().size === 1 && near(vol(coil), want, 1e-4 * want), [errors, bodies().size, coil && vol(coil), want]);
// Round Z: out to R + W every way; from -W up to the last turn's top, N·P + W.
const [[x0, y0, z0], [x1, y1, z1]] = coil.boundingBox.bounds;
check('the coil: 27 across, from -1.5 up to 31.5', [x0, y0].every(v => near(v, -(R + W), 0.02)) && [x1, y1].every(v => near(v, R + W, 0.02)) && near(z0, -W, 0.02) && near(z1, N * P + W, 0.02), coil.boundingBox.bounds);

const h = health(coil, 'coil');
check('the coil: sound', h.healthy, h.healthy ? `${h.volume.toFixed(1)} mm³` : h);
const codeVol = vol(coil);
const codeFaces = coil.faces.length;
const codeBox = coil.boundingBox.bounds;
console.log('coil', codeVol.toFixed(2), 'want', want.toFixed(2), 'faces', codeFaces);

// ---------------------------------------------- the spring built by hand
// On a phone-sized screen (tests/fixtures/spring-hand.json): from the front,
// a Sketch (on the front plane, as it said) and a circle typed (X 12, Y 0,
// 3 across); Revolve, X · Y · Z: Z; Angle 1800 first - "More than one turn
// needs a Travel along the axis (or it overlaps itself)", plainly - then
// Travel 30. Nothing to fix; it comes out the same.
{
  const hand = JSON.parse(readFileSync(new URL('./fixtures/spring-hand.json', import.meta.url), 'utf8')).features as Feature[];
  const { errors } = await after(hand);
  check('by hand: no errors', errors.length === 0, errors);
  const Bs = [...bodies().values()].map(s => s as Shape3D);
  check('by hand: one body, sound', Bs.length === 1 && health(Bs[0], 'hand').healthy, Bs.length);
  check('by hand: the same spring (to 0.1 %)', Bs.length === 1 && Math.abs(vol(Bs[0]) - codeVol) < codeVol * 1e-3, `${Bs[0] ? vol(Bs[0]).toFixed(1) : '-'} / ${codeVol.toFixed(1)}`);
  check('by hand: as many faces, the same box', Bs[0]?.faces.length === codeFaces && Bs[0].boundingBox.bounds.flat().every((x, i) => near(x, codeBox.flat()[i], 1e-2)), [Bs[0]?.faces.length, codeFaces, Bs[0]?.boundingBox.bounds]);
}

if (process.argv[2]) {
  writeFileSync(process.argv[2], JSON.stringify({ format: 'super', version: 2, name: 'Spring', features: steps }));
}
done();
