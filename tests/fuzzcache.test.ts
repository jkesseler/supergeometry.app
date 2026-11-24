// Run: npx tsx tests/fuzzcache.test.ts [seeds] [steps] [first seed] - random step lists,
// built the way the app builds them (each step added and rebuilt, its taps
// taken from the last rebuild's faces and edges), then held to what a rebuild
// must always do, whatever the steps:
//  - built again from nothing (no results kept), it comes out the same;
//  - an early number changed (warm: what can be kept is kept), the same as
//    that list built from nothing; changed back, the same as at first;
//  - each step switched off in turn, and each deleted: no crash, the same warm
//    as from nothing, the steps after it failing (if they do) with a message;
//  - a rebuild with no errors gives sound bodies.
import { measureVolume, type Shape3D } from 'replicad';
import { debugBodies, regenerate, resetKernel } from '../src/kernel/engine';
import { healthReport } from '../src/kernel/engine';
import { check, done, near, sketch, rect, circle, XY, profile } from './kit';
import type { Feature, Vec3 } from '../src/doc/types';
import type { BodyMesh, RegenResult } from '../src/kernel/protocol';

const SEEDS = Number(process.argv[2] ?? 6);
const STEPS = Number(process.argv[3] ?? 7);
const FROM = Number(process.argv[4] ?? 1);

let seed = 1;
const rnd = () => {
  seed = (seed * 1103515245 + 12345) % 2147483648;

  return seed / 2147483648;
};
const pick = <T>(a: T[]): T => a[Math.floor(rnd() * a.length)];
const between = (a: number, b: number) => a + (b - a) * rnd();
const r3 = (x: number) => Math.round(x * 1000) / 1000;

const faceRef = (b: BodyMesh, f: BodyMesh['faces'][number]) => ({ body: b.id, center: f.center, normal: f.normal, area: f.area, ...(f.step ? { step: f.step } : {}), ...(f.curve ? { curve: f.curve } : {}) });
const edgeRef = (b: BodyMesh, e: BodyMesh['edges'][number]) => ({ body: b.id, mid: e.mid, dir: e.dir, length: e.length, ...(e.steps ? { steps: e.steps } : {}), ...(e.curves ? { curves: e.curves } : {}) });

/** What a rebuild came to: each body's volume and face count, and which steps failed. */
function print(r: RegenResult): string {
  const out: string[] = [];
  for (const [id, s] of [...debugBodies()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    let v = NaN;
    try {
      v = Math.abs(measureVolume(s as Shape3D));
    } catch {
      /* counted as NaN */
    }
    const m = r.bodies.find(b => b.id === id);
    out.push(`${id}:${v.toPrecision(7)}/${m?.faces.length ?? '?'}`);
  }

  return out.join(' ') + ' | ' + r.errors.map(e => e.featureId).sort().join(',');
}

async function cold(fs: Feature[]) {
  resetKernel();
  const r = await regenerate(JSON.parse(JSON.stringify(fs)));

  return { r, p: print(r) };
}
async function warm(fs: Feature[]) {
  const r = await regenerate(JSON.parse(JSON.stringify(fs)));

  return { r, p: print(r) };
}

/** One random step on what's there now (null: nothing fits). */
function randomStep(n: number, r: RegenResult, fs: Feature[]): Feature[] | null {
  const bs = r.bodies.filter(b => b.faces.length);
  if (!bs.length) {
    return null;
  }
  const b = pick(bs);
  const planes = b.faces.filter(f => f.type === 'PLANE');
  const lines = b.edges.filter(e => e.type === 'LINE' && e.length > 2 && !e.seam);
  const rounds = b.faces.filter(f => f.type !== 'PLANE');
  const id = `s${n}`;
  const kind = pick(['fillet', 'chamfer', 'moveFace', 'tilt', 'deleteGeom', 'shell', 'hole', 'boss', 'scaleFace', 'split', 'move', 'mirror', 'imprint']);
  switch (kind) {
    case 'fillet':
    case 'chamfer': {
      if (!lines.length) {
        return null;
      }
      const es = [pick(lines)];
      if (rnd() < 0.5) {
        es.push(pick(lines));
      }
      const short = Math.min(...es.map(e => e.length));

      return [{ id, name: kind, type: kind, edges: [...new Set(es)].map(e => edgeRef(b, e)), radius: r3(between(0.1, 0.3) * Math.min(short, 6)) } as Feature];
    }
    case 'moveFace': {
      if (!planes.length) {
        return null;
      }
      const f = pick(planes);
      const d = between(-3, 3);

      return [{ id, name: kind, type: 'moveFace', face: faceRef(b, f), translate: f.normal.map(x => x * d) as Vec3 } as Feature];
    }
    case 'tilt': {
      if (!planes.length) {
        return null;
      }
      const f = pick(planes);
      // About a line in the face (level; on a face looking up or down, square to x).
      const [nx, ny, nz] = f.normal;
      const lv = Math.hypot(nx, ny);
      const ax: Vec3 = Math.abs(nz) > 0.9 ? [0, nz / Math.hypot(ny, nz), -ny / Math.hypot(ny, nz)] : [-ny / lv, nx / lv, 0];

      return [{ id, name: kind, type: 'moveFace', face: faceRef(b, f), translate: [0, 0, 0], rotate: { origin: f.center, axis: ax, angle: r3(between(-6, 6)) } } as Feature];
    }
    case 'deleteGeom': {
      if (!rounds.length) {
        return null;
      }

      return [{ id, name: kind, type: 'deleteGeom', body: b.id, faces: [faceRef(b, pick(rounds))], edges: [], vertices: [] } as Feature];
    }
    case 'shell': {
      if (!planes.length) {
        return null;
      }

      return [{ id, name: kind, type: 'shell', body: b.id, faces: rnd() < 0.8 ? [faceRef(b, pick(planes))] : [], thickness: r3(between(0.6, 1.5)) } as Feature];
    }
    case 'hole':
    case 'boss':
    case 'imprint': {
      // On the body's highest flat face looking up: a circle at its middle.
      const ups = planes.filter(f => f.normal[2] > 0.999).sort((p, q) => q.center[2] - p.center[2]);
      if (!ups.length) {
        return null;
      }
      const f = ups[0];
      const rr = r3(Math.min(Math.sqrt(f.area) / 5, 4) * between(0.5, 1));
      const z = f.center[2];
      const es = [circle(`c${n}`, r3(f.center[0]), r3(f.center[1]), rr)];
      const sk = { ...sketch(`k${n}`, XY(z), es), attachedTo: faceRef(b, f) } as Feature;
      if (kind === 'imprint') {
        return [sk, { id, name: kind, type: 'imprint', body: b.id, source: profile(`k${n}`, es) } as Feature];
      }
      const d = kind === 'hole' ? -r3(between(2, 6)) : r3(between(2, 6));

      return [sk, { id, name: kind, type: 'extrude', source: profile(`k${n}`, es), distance: d, mode: 'auto', byDirection: true, target: b.id } as Feature];
    }
    case 'scaleFace': {
      if (!planes.length) {
        return null;
      }
      const f = pick(planes);
      const u: Vec3 = Math.abs(f.normal[2]) > 0.9 ? [1, 0, 0] : [0, 0, 1];
      const s = r3(between(0.85, 1.15));

      return [{ id, name: kind, type: 'scaleFace', face: faceRef(b, f), u, factors: [s, s] } as Feature];
    }
    case 'split': {
      const [lo, hi] = [b.faces.reduce((m, f) => Math.min(m, f.center[0]), 1e9), b.faces.reduce((m, f) => Math.max(m, f.center[0]), -1e9)];

      return [{ id, name: kind, type: 'split', body: b.id, plane: { origin: [r3(between(lo, hi)), 0, 0], xDir: [0, 1, 0], normal: [1, 0, 0] } } as Feature];
    }
    case 'move':
      return [{ id, name: kind, type: 'transform', bodies: [b.id], copy: false, op: { kind: 'move', translate: [r3(between(-5, 5)), r3(between(-5, 5)), 0] } } as Feature];
    case 'mirror':
      return [{ id, name: kind, type: 'transform', bodies: [b.id], copy: true, op: { kind: 'mirror', plane: { origin: [0, 0, 0], xDir: [0, 1, 0], normal: [1, 0, 0] } } } as Feature];
  }
  void fs;

  return null;
}

let crashes = 0;
for (let k = FROM; k < FROM + SEEDS; k++) {
  seed = 7919 * k;
  const L = r3(between(20, 50)), W = r3(between(15, 35)), H = r3(between(8, 25));
  const es = [rect('r', 0, 0, L, W)];
  const fs: Feature[] = [sketch('base', XY(), es), { id: 'body', name: 'Block', type: 'extrude', source: profile('base', es), distance: H, mode: 'new' } as Feature];
  let r = await regenerate(fs);
  const log: string[] = [];
  for (let n = 1, tries = 0; n <= STEPS && tries < STEPS * 4; tries++) {
    const add = randomStep(n, r, fs);
    if (!add) {
      continue;
    }
    try {
      const r2 = await regenerate([...fs, ...add]);
      // A step that fails is dropped, as the user would undo it.
      if (r2.errors.length) {
        log.push(`(${add.at(-1)!.name} failed: ${r2.errors[0].message.slice(0, 60)})`);
        if (process.env.FUZZ_DUMP) {
          (await import('node:fs')).writeFileSync(`${process.env.FUZZ_DUMP}/k${k}-${n}-${add.at(-1)!.name}.json`, JSON.stringify({ features: [...fs, ...add], error: r2.errors[0] }));
        }
        r = await regenerate(fs);
        continue;
      }
      fs.push(...add);
      r = r2;
      log.push(add.at(-1)!.name);
      n++;
    } catch (e) {
      crashes++;
      check(`seed ${k}: adding ${add.at(-1)!.name} doesn't throw`, false, String(e).slice(0, 200));
      r = await regenerate(fs);
    }
  }
  const label = `seed ${k} [${log.filter(s => !s.startsWith('(')).join(' ')}]`;
  console.log(`seed ${k}: ${log.join(', ')}`);

  // Sound.
  const sick = [...debugBodies()].map(([id, s]) => healthReport(id, id, s as Shape3D)).filter(h => !h.healthy);
  check(`${label}: every body sound`, !sick.length, sick.map(h => ({ id: h.id, valid: h.valid, open: h.openEdges, pinched: h.pinched, thin: h.thin, solids: h.solids })));

  const first = (await warm(fs)).p;
  const c0 = (await cold(fs)).p;
  check(`${label}: built from nothing, the same`, c0 === first, { warm: first, cold: c0 });

  // An early number changed: the block's height, then its length.
  for (const [what, change] of [
    ['taller', (f: Feature[]) => ((f[1] as unknown as { distance: number }).distance = r3(H + 2))],
    ['longer', (f: Feature[]) => {
      const sk = f[0] as unknown as { entities: { points: number[][] }[] };
      for (const p of sk.entities[0].points) {
        if (p[0] > 0) {
          p[0] = r3(L + 4);
        }
      }
    }]
  ] as const) {
    const changed = JSON.parse(JSON.stringify(fs)) as Feature[];
    change(changed);
    await warm(fs);
    const w = (await warm(changed)).p;
    const c = (await cold(changed)).p;
    check(`${label}: ${what}: warm = from nothing`, w === c, { warm: w, cold: c });
    await warm(changed);
    const back = (await warm(fs)).p;
    check(`${label}: ${what}, then back: as at first`, back === first, { back, first });
  }

  // Each step off in turn, and each deleted (a sketch's extrude with it).
  for (let i = 2; i < fs.length; i++) {
    for (const how of ['off', 'deleted'] as const) {
      const list = how === 'off' ? fs.map((f, j) => (j === i ? { ...f, suppressed: true } : f)) : fs.filter((_, j) => j !== i);
      await warm(fs);
      let w: string, c: string;
      try {
        const got = await warm(list);
        w = got.p;
        const bad = got.r.errors.filter(e => !e.message || !list.some(f => f.id === e.featureId));
        if (bad.length) {
          check(`${label}: ${fs[i].name} ${how}: errors name a step and say why`, false, bad);
        }
        c = (await cold(list)).p;
      } catch (e) {
        crashes++;
        check(`${label}: ${fs[i].name} (${fs[i].id}) ${how}: no crash`, false, String(e).slice(0, 200));
        continue;
      }
      check(`${label}: ${fs[i].name} (${fs[i].id}) ${how}: warm = from nothing`, w === c, { warm: w, cold: c });
    }
  }
}
check('no rebuild threw', crashes === 0, crashes);
void near;
done();
