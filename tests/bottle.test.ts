// Run: npx tsx tests/bottle.test.ts [out.json] - a bottle: its half section
// drawn on the front plane and revolved round Z (a body, a sloped shoulder, a
// neck); the bottom's edge rounded, the shoulder's two edges rounded; shelled
// 2 thick, open at the neck; a thread cut round the neck. Each step held to
// its size and soundness.
import { readFileSync, writeFileSync } from 'node:fs';
import { measureArea, type Face, type Shape3D } from 'replicad';
import { measureVolume } from '../src/kernel/ocFree';
import { arrangement, regionRef } from '../src/sketch/regions';
import { after, bodies, check, done, health, near, poly, sketch, XZ } from './kit';
import type { EdgeRef, FaceRef, Feature, SketchEntity, Vec3 } from '../src/doc/types';

const vol = (s: Shape3D) => Math.abs(measureVolume(s));
const body = (id: string) => bodies().get(id) as Shape3D;
const profileOf = (sk: string, es: SketchEntity[]) => ({ kind: 'profile' as const, sketch: sk, regions: arrangement(es).regions.map(regionRef) });
const unit = (v: number[]): Vec3 => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;

  return [v[0] / l, v[1] / l, v[2] / l]; 
};
const edgesOf = (id: string, test: (m: Vec3, d: Vec3, len: number) => boolean): EdgeRef[] =>
  body(id).edges.filter(e => test(e.pointAt(0.5).toTuple() as Vec3, unit(e.tangentAt(0.5).toTuple()), e.length)).map(e => ({ body: id, mid: e.pointAt(0.5).toTuple() as Vec3, dir: e.tangentAt(0.5).toTuple() as Vec3, length: e.length }));
const ref = (id: string, f: Face): FaceRef => ({ body: id, center: f.center.toTuple() as Vec3, normal: f.normalAt().toTuple() as Vec3, area: measureArea(f) });
const faceOf = (id: string, pick: (f: Face) => boolean) => {
  const f = body(id).faces.find(pick); if (!f) {
    throw new Error(`no such face on ${id}`);
  }

  return ref(id, f); 
};
const radiusOf = (f: Face) => {
  const p = f.pointOnSurface(0.5, 0.5).toTuple();

  return Math.hypot(p[0], p[1]); 
};
const Z = { origin: [0, 0, 0] as Vec3, dir: [0, 0, 1] as Vec3 };
const PI = Math.PI;

const RB = 25, HB = 60; // the body: 50 across, straight up to 60
const RN = 12, HS = 72, HT = 88; // the neck: 24 across, from 72 up to 88
const FB = 5, FS = 3; // the bottom's round, the shoulder's
const T = 2; // the wall
const P = 2; // the thread's pitch

// ---------------------------------------------------------------- the body
const section: [number, number][] = [[0, 0], [RB, 0], [RB, HB], [RN, HS], [RN, HT], [0, HT]];
const ixA = section.reduce((s, [x0, y0], i) => {
  const [x1, y1] = section[(i + 1) % section.length];

  return s + ((x0 * y1 - x1 * y0) * (x0 + x1)) / 6; 
}, 0);
const secEs = [poly('sec', section)];
const steps: Feature[] = [sketch('Section', XZ(), secEs), { id: 'Bottle', name: 'Revolve', type: 'revolve', source: profileOf('Section', secEs), axis: Z, angle: 360, mode: 'new' } as Feature];
let { errors } = await after(steps);
const vRev = vol(body('Bottle'));
check('the body: the section turned round (Pappus)', !errors.length && bodies().size === 1 && near(vRev, 2 * PI * Math.abs(ixA), 1e-3), [errors, vRev, 2 * PI * Math.abs(ixA)]);

// --------------------------------------------------------------- the bottom
// Its outer edge rounded 5: a ring of the corner (1 - π/4)·r², its middle
// (10 - 3π) / (3·(4 - π))·r in from each side.
const bottom = edgesOf('Bottle', m => near(m[2], 0, 1e-6) && near(Math.hypot(m[0], m[1]), RB, 1e-4));
steps.push({ id: 'Bottom', name: 'Fillet', type: 'fillet', edges: bottom, radius: FB } as Feature);
({ errors } = await after(steps));
const vBottom = vol(body('Bottle'));
const k = (10 - 3 * PI) / (3 * (4 - PI));
const ring = (1 - PI / 4) * FB * FB * 2 * PI * (RB - k * FB);
check('the bottom: its edge rounded 5', !errors.length && bottom.length >= 1 && near(vRev - vBottom, ring, 1e-3), [errors, bottom.length, vRev - vBottom, ring]);

// ------------------------------------------------------------- the shoulder
// Its two edges (out at the body's top, in at the neck's foot) rounded 3.
const shoulder = edgesOf('Bottle', m => (near(m[2], HB, 1e-6) && near(Math.hypot(m[0], m[1]), RB, 1e-4)) || (near(m[2], HS, 1e-6) && near(Math.hypot(m[0], m[1]), RN, 1e-4)));
steps.push({ id: 'Shoulder', name: 'Fillet', type: 'fillet', edges: shoulder, radius: FS } as Feature);
({ errors } = await after(steps));
const vShoulder = vol(body('Bottle'));
// The outer round takes off, the inner one fills in; at a 45° bend each
// corner's sliver is r²·(tan(θ/2) - θ/2), θ = 45°, round its ring.
const th = PI / 4, sliver = FS * FS * (Math.tan(th / 2) - th / 2);
check('the shoulder: both edges rounded 3', !errors.length && shoulder.length >= 2 && vShoulder < vBottom && vBottom - vShoulder < sliver * 2 * PI * RB * 1.1 && vBottom - vShoulder > sliver * 2 * PI * (RB - RN) * 0.8, [errors, shoulder.length, vBottom - vShoulder, sliver * 2 * PI * RB, sliver * 2 * PI * RN]);

// ---------------------------------------------------------------- the shell
// 2 thick, open at the neck's top.
const mouth = faceOf('Bottle', f => f.geomType === 'PLANE' && near(f.center.z, HT, 1e-6));
const skin = measureArea(body('Bottle')) - PI * RN * RN;
steps.push({ id: 'Hollow', name: 'Shell', type: 'shell', body: 'Bottle', faces: [mouth], thickness: T } as Feature);
({ errors } = await after(steps));
const vShell = vol(body('Bottle'));
// About its skin times 2 (a little less: the inside is smaller).
check('the shell: 2 thick, open at the top', !errors.length && bodies().size === 1 && vShell < skin * T && vShell > skin * T * 0.9, [errors, vShell, skin * T]);
const [[bx0, , bz0], [bx1, , bz1]] = body('Bottle').boundingBox.bounds;
check('the shell: the same outside, 50 across, 88 tall', near(bx0, -RB, 1e-4) && near(bx1, RB, 1e-4) && near(bz0, 0, 1e-4) && near(bz1, HT, 1e-4), body('Bottle').boundingBox.bounds);

// --------------------------------------------------------------- the thread
// Round the neck's outside, pitch 2.
const neck = faceOf('Bottle', f => f.geomType === 'CYLINDRE' && f.center.z > HS && near(radiusOf(f), RN, 1e-4));
steps.push({ id: 'Thread', name: 'Thread', type: 'thread', face: neck, pitch: P, round: { r: RN, hole: false } } as Feature);
({ errors } = await after(steps));
const vThread = vol(body('Bottle'));
// The groove: about a V 2·d·tan30 wide and d deep round the neck, one per pitch.
const d = (5 / 8) * P * Math.sqrt(3) / 2;
const groove = d * d * Math.tan(PI / 6) * 2 * PI * RN * ((HT - HS) / P);
check('the thread: cut round the neck', !errors.length && bodies().size === 1 && vShell - vThread > 0.3 * groove && vShell - vThread < 2 * groove, [errors, vShell - vThread, groove]);

const h = health(body('Bottle'), 'Bottle');
check('the bottle: sound, one body', h.healthy && bodies().size === 1, h.healthy ? `${Math.round(h.volume)} mm³` : h);
const codeVol = vol(body('Bottle'));
const codeFaces = body('Bottle').faces.length;
const codeBox = body('Bottle').boundingBox.bounds;
console.log('revolve', vRev.toFixed(1), 'bottom', vBottom.toFixed(1), 'shoulder', vShoulder.toFixed(1), 'shell', vShell.toFixed(1), 'final', codeVol.toFixed(1), 'faces', codeFaces);

// ---------------------------------------------- the bottle built by hand
// On a phone-sized screen (tests/fixtures/bottle-hand.json): the section's
// six sides typed (across and up) on the front plane, closed on its first
// point, revolved round Z; the bottom's edge tapped and rounded 5; the
// shoulder's two edges rounded 3; the neck's top tapped for Shell, 2 thick;
// the neck tapped for Thread (it offers M24 x 3), pitch 2. It comes out the
// same.
{
  const hand = JSON.parse(readFileSync(new URL('./fixtures/bottle-hand.json', import.meta.url), 'utf8')).features as Feature[];
  const { errors } = await after(hand);
  check('by hand: no errors', errors.length === 0, errors);
  const H = [...bodies().values()].map(s => s as Shape3D);
  check('by hand: one body, sound', H.length === 1 && health(H[0], 'hand').healthy, H.length);
  check('by hand: the same bottle (to 0.1 %)', H.length === 1 && Math.abs(vol(H[0]) - codeVol) < codeVol * 1e-3, `${H[0] ? vol(H[0]).toFixed(1) : '-'} / ${codeVol.toFixed(1)}`);
  check('by hand: as many faces, the same box', H[0]?.faces.length === codeFaces && H[0].boundingBox.bounds.flat().every((x, i) => near(x, codeBox.flat()[i], 1e-3)), [H[0]?.faces.length, codeFaces, H[0]?.boundingBox.bounds]);
}

if (process.argv[2]) {
  writeFileSync(process.argv[2], JSON.stringify({ format: 'super', version: 2, name: 'Bottle', features: steps }));
}
done();
