// Run: npx tsx tests/shellrim.test.ts - a user's part (tests/fixtures/shellrim.json):
// a box with a fillet and a chamfer, shelled open at the chamfer, then the
// rim the shell left (a frame round the opening) offset 3 mm in. The rim's
// corners each slid along one wall only and were averaged: off both walls,
// so slanted patches stood up past the new rim as fins. A corner now slides
// along the body's edge where its two walls meet.
import { readFileSync } from 'node:fs';
import opencascade from 'replicad-opencascadejs';
import { measureVolume, setOC } from 'replicad';
import { debugBodies, regenerate } from '../src/kernel/engine';

setOC(await (opencascade as unknown as () => Promise<any>)());
const doc = JSON.parse(readFileSync(new URL('./fixtures/shellrim.json', import.meta.url), 'utf8'));
const fs = doc.features;
const BODY = 'extrude-mw6obrns-xqpb';
let failed = 0;
const check = (name: string, ok: boolean, info = '') => {
  if (!ok) {
    failed++;
  }
  console.log(ok ? 'ok  ' : 'FAIL', name, info);
};
const n0 = [0, -Math.SQRT1_2, Math.SQRT1_2];
const depth = (center: { y: number; z: number }) => n0[1] * 7 + n0[2] * 43 - (n0[1] * center.y + n0[2] * center.z);

await regenerate(fs.slice(0, -1));
const s0 = debugBodies().get(BODY)!;
const v0 = Math.abs(measureVolume(s0));
for (const distance of [-3, 3]) {
  fs[fs.length - 1].distance = distance;
  const result: any = await regenerate(fs);
  const shape = debugBodies().get(BODY)!;
  check(`offset ${distance}: rebuilds`, !result.errors.length, result.errors.map((e: any) => e.message).join('; '));
  check('…only flat and round faces (no slanted patches)', shape.faces.every(face => face.geomType === 'PLANE' || face.geomType === 'CYLINDRE'), shape.faces.map(face => face.geomType).join(','));
  check('…no more faces than before', shape.faces.length <= s0.faces.length + 1, `${s0.faces.length} → ${shape.faces.length}`);
  const rim = shape.faces.filter(face => face.geomType === 'PLANE' && Math.abs(face.normalAt().y + Math.SQRT1_2) < 1e-6 && Math.abs(face.normalAt().z - Math.SQRT1_2) < 1e-6);
  check('…one rim, moved by the offset', rim.length === 1 && Math.abs(depth(rim[0].center) + distance) < 1e-6, rim.map(face => depth(face.center).toFixed(3)).join(','));
  const bb = shape.boundingBox.bounds;
  check("…stays inside the walls' own planes (box unchanged)", Math.abs(bb[0][1]) < 1e-6 && Math.abs(bb[1][2] - 50) < 1e-6, JSON.stringify(bb));
  const volume = Math.abs(measureVolume(shape));
  check(distance < 0 ? '…smaller' : '…bigger', distance < 0 ? volume < v0 : volume > v0, `${v0.toFixed(1)} → ${volume.toFixed(1)}`);
}
process.exit(failed ? 1 : 0);
