// Run: npx tsx tests/deletefuzz.test.ts [rounds] [seed]
//
// Random parts, a random edge filleted or chamfered, then that fillet deleted
// again: if the delete is accepted, the part must be exactly what it was
// before the fillet (same volume, a clean solid) - "as if it was never there".
import opencascade from 'replicad-opencascadejs';
import { measureVolume, setOC } from 'replicad';
import { debugBodies, regenerate } from '../src/kernel/engine';
import { healthOf, isHealthy } from '../src/kernel/repair';
import { cylinderOf } from '../src/kernel/faceEdit';
import { base, rng } from './fuzzkit';
import type { Feature } from '../src/doc/types';

setOC(await (opencascade as unknown as () => Promise<any>)());
const ROUNDS = Number(process.argv[2] ?? 16);
const SEED = Number(process.argv[3] ?? 1);

let accepted = 0;
let refused = 0;
let notMade = 0;
const fails: string[] = [];
const why = new Map<string, number>();
for (let round = 0; round < ROUNDS; round++) {
  const random = rng(SEED * 4099 + round);
  const feats = base(random, round);
  const r0: any = await regenerate(feats);
  if (r0.errors.length || !r0.bodies.length) {
    continue;
  }
  const b = r0.bodies[0];
  const v0 = Math.abs(measureVolume(debugBodies().get(b.id)!));
  const edges = b.edges.filter((e: any) => e.length > 1);
  const e = edges[Math.floor(random() * edges.length)];
  if (!e) {
    continue;
  }
  const kind = random() < 0.65 ? 'fillet' : 'chamfer';
  const radius = Math.round((0.5 + random() * 3) * 100) / 100;
  const fil = { id: 'fil', name: kind, type: kind, edges: [{ body: b.id, mid: e.mid, dir: e.dir, length: e.length }], radius } as Feature;
  const r1: any = await regenerate([...feats, fil]);
  if (r1.errors.length) {
    notMade++;
    continue;
  }
  // The faces that fillet made: a chamfer's flat face points a way no face
  // did before; a fillet's round faces have its radius (or are new tori).
  const s1 = debugBodies().get(b.id)!;
  const oldNormals = b.faces.filter((face: any) => face.type === 'PLANE').map((face: any) => face.normal);
  const hadTorus = b.faces.some((face: any) => face.type === 'TORUS');
  const made = s1.faces
    .map((face, i) => ({ face, info: r1.bodies.find((body: any) => body.id === b.id).faces[i] }))
    .filter(({ face, info }) => {
      if (!info) {
        return false;
      }
      if (kind === 'chamfer') {
        return face.geomType === 'PLANE' && !oldNormals.some((oldNormal: number[]) => Math.abs(oldNormal[0] * info.normal[0] + oldNormal[1] * info.normal[1] + oldNormal[2] * info.normal[2]) > 0.9999);
      }
      if (face.geomType === 'TORUS') {
        return !hadTorus;
      }
      const faceRadius = cylinderOf(face)?.r;

      return faceRadius !== undefined && Math.abs(faceRadius - radius) < 1e-6;
    })
    .map(({ info }) => info);
  if (!made.length) {
    continue;
  }
  const feature = made[Math.floor(random() * made.length)];
  const del = { id: 'del', name: 'Delete', type: 'deleteGeom', body: b.id, faces: [{ body: b.id, center: feature.center, normal: feature.normal, area: feature.area }], edges: [], vertices: [] } as Feature;
  const r2: any = await regenerate([...feats, fil, del]);
  if (r2.errors.length) {
    refused++;
    const message = r2.errors[0].message.slice(0, 60);
    if (process.env.DF_WHY) {
      console.log('refused', round, `part ${round % 7}`, kind, feature.type, r2.errors[0].message.slice(0, 80));
    }
    why.set(`${kind}: ${message}`, (why.get(`${kind}: ${message}`) ?? 0) + 1);
    continue;
  }
  accepted++;
  const shape = debugBodies().get(b.id)!;
  const volume = Math.abs(measureVolume(shape));
  const ok = isHealthy(healthOf(shape)) && Math.abs(volume - v0) <= v0 * 1e-5;
  if (!ok) {
    fails.push(`round ${round} (${kind} r${radius} on part ${round % 7}): ${isHealthy(healthOf(shape)) ? '' : 'not a clean solid, '}volume ${volume.toFixed(3)}, before the ${kind} ${v0.toFixed(3)}`);
  }
}
for (const fail of fails) {
  console.log('FAIL', fail);
}
console.log(`${accepted} fillets/chamfers deleted, ${refused} refused, ${notMade} couldn't be made in the first place; ${fails.length} not back to the original`);
for (const [message, count] of [...why].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${count}× ${message}`);
}
process.exit(fails.length ? 1 : 0);
