// Run: npx tsx tests/mutate.slow.test.ts [fixture] [perStep] [seed] [from] [to]
//
// Mutation sweep of the geometry engine. Real projects (tests/fixtures) are
// replayed with one value of one step changed at a time to what people type
// by mistake and what damaged files hold: 0, the sign flipped, a millionth,
// a thousand times, a billion, nothing at all, an empty list, a reference to
// something that isn't there. Each changed step must either
//   - be refused, with a message a person can read (no engine words), or
//   - leave every body it changed a valid, closed solid with a real volume,
// and never crash the engine, or take minutes.
import { readFileSync, appendFileSync, writeFileSync } from 'node:fs';
import opencascade from 'replicad-opencascadejs';
import { measureVolume, setOC, type Shape3D } from 'replicad';
import { debugBodies, regenerate, shapeValid, withFreshKernel } from '../src/kernel/engine';
import { rng, solids } from './fuzzkit';
import type { Feature } from '../src/doc/types';

let restarts = 0;
const load = async () => setOC(await (opencascade as unknown as () => Promise<any>)());
await load();
/** A rebuild as the app does it: the engine loaded afresh if it breaks down. */
const rebuild = (fs: Feature[], saved = false) => withFreshKernel(async () => (restarts++, await load()), () => regenerate(fs, saved));

const FIXTURE = process.argv[2] ?? 'valve';
const PER_STEP = Number(process.argv[3] ?? 3);
const SEED = Number(process.argv[4] ?? 1);
const FROM = Number(process.argv[5] ?? 0);
const TO = Number(process.argv[6] ?? 1e9);
const LOG = process.env.MUTATE_LOG;
const SLOW_MS = 30000;

const doc = JSON.parse(readFileSync(new URL(`./fixtures/${FIXTURE}.json`, import.meta.url), 'utf8'));
const features: Feature[] = doc.features;
const random = rng(SEED);

type Path = (string | number)[];
/** Every value of a step worth changing: numbers, references (ids), lists. */
function leaves(value: unknown, path: Path, out: { path: Path; v: unknown }[]): void {
  if (path.length === 1 && ['id', 'name', 'type', 'suppressed', 'color', 'folder'].includes(String(path[0]))) {
    return;
  }
  if (typeof value === 'number') {
    out.push({ path, v: value });
  } else if (typeof value === 'string') {
    // (Ids of other things; not text, modes or file contents.)
    const key = String(path[path.length - 1]);
    if (['body', 'sketch', 'target', 'plane', 'axis', 'step'].includes(key) || (typeof path[path.length - 1] === 'number' && ['tools', 'bodies', 'regions', 'entities', 'steps'].includes(String(path[path.length - 2])))) {
      out.push({ path, v: value });
    }
  } else if (Array.isArray(value)) {
    if (value.length && path.length) {
      out.push({ path, v: value });
    }
    // (A sketch's or a cage's hundreds of points: a few of them.)
    const some = value.length > 6 ? [0, Math.floor(value.length / 2), value.length - 1] : value.map((_, i) => i);
    for (const i of some) {
      leaves(value[i], [...path, i], out);
    }
  } else if (value && typeof value === 'object') {
    for (const [key, x] of Object.entries(value)) {
      if (key !== 'data' && key !== 'log') {
        leaves(x, [...path, key], out);
      }
    }
  }
}
function changes(value: unknown): unknown[] {
  if (typeof value === 'number') {
    const x = value === 0 ? 1 : value;

    return [0, -x, x * 1e-6, x * 1000, 1e9, null, value === 0 ? 1e-7 : x * 1.0000001];
  }
  if (typeof value === 'string') {
    return ['nope', ''];
  }

  return [[], null];
}
const set = (feature: Feature, path: Path, value: unknown): Feature => {
  const copy = structuredClone(feature) as any;
  let target = copy;
  for (const key of path.slice(0, -1)) {
    target = target[key];
  }
  target[path[path.length - 1]] = value;

  return copy;
};

/** Words of the engine's, not a person's. */
const ENGINE_WORDS = /undefined|\bNaN\b|\bnull\b|\[object|Standard_|BRep|TopoDS|Geom_|gp_|is not a function|is not iterable|Cannot read|Cannot set|not defined|exception|wasm|unreachable|out of bounds|\bptr\b|abort|^\s*$|^\d+$|stack/i;

const found: string[] = [];
const say = (kind: string, i: number, feature: Feature, path: Path, value: unknown, info: string) => {
  const line = `${kind} | ${FIXTURE}[${i}] ${feature.type} "${feature.name}" ${path.join('.')} = ${JSON.stringify(value)} | ${info}`;
  found.push(line);
  console.log(line);
  if (LOG) {
    appendFileSync(LOG, line + '\n');
  }
};

const t00 = performance.now();
const base: any = await rebuild(features, true);
const baseErr = new Set(base.errors.map((e: any) => e.featureId));
console.log(`${FIXTURE}: ${features.length} steps, ${base.errors.length} failing as saved, rebuilt in ${((performance.now() - t00) / 1000).toFixed(1)} s`);

let tried = 0;
let refused = 0;
let fine = 0;
let before = new Map<string, Shape3D>();
for (let i = 0; i < features.length && i < TO; i++) {
  const feature = features[i];
  if (i >= FROM && !feature.suppressed && !baseErr.has(feature.id)) {
    const all: { path: Path; v: unknown }[] = [];
    leaves(feature, [], all);
    // A few of them, chosen by the seed.
    const pick = all.length <= PER_STEP ? all : Array.from({ length: PER_STEP }, () => all[Math.floor(random() * all.length)]);
    // (MUTATE_ALL: every value of the step, every change of it.)
    const todo = process.env.MUTATE_ALL ? all.flatMap(leaf => changes(leaf.v).map(to => ({ ...leaf, to }))) : pick.map(leaf => ({ ...leaf, to: changes(leaf.v)[Math.floor(random() * changes(leaf.v).length)] }));
    for (const { path, v, to } of todo) {
      const mutated = set(feature, path, to);
      if (LOG) {
        writeFileSync(LOG + '.now', `${FIXTURE}[${i}] ${feature.type} ${path.join('.')} = ${JSON.stringify(to)}\n`);
      }
      tried++;
      const t0 = performance.now();
      let result: any;
      const restartsBefore = restarts;
      try {
        result = await rebuild([...features.slice(0, i), mutated]);
      } catch (err) {
        say('CRASH', i, feature, path, to, String((err as Error)?.message ?? err).slice(0, 200));
        continue;
      }
      const ms = performance.now() - t0;
      if (restarts > restartsBefore) {
        console.log(`  restart: [${i}] ${feature.type} ${path.join('.')} = ${JSON.stringify(to)} (${(ms / 1000).toFixed(0)} s)`);
      }
      if (ms > SLOW_MS) {
        say('SLOW', i, feature, path, to, `${(ms / 1000).toFixed(0)} s`);
      }
      const errs = result.errors.filter((e: any) => !baseErr.has(e.featureId));
      const own = errs.find((e: any) => e.featureId === feature.id);
      const others = errs.filter((e: any) => e.featureId !== feature.id);
      if (others.length) {
        say('OTHER', i, feature, path, to, others.map((e: any) => `${e.featureId}: ${e.message}`).join(' / ').slice(0, 200));
      }
      if (own) {
        refused++;
        if (ENGINE_WORDS.test(own.message)) {
          say('WORDS', i, feature, path, to, own.message.slice(0, 200));
        }
        continue;
      }
      // It went through: what it changed must be sound.
      const bad: string[] = [];
      for (const [id, debugBody] of debugBodies()) {
        if (before.get(id) === debugBody) {
          continue;
        }
        try {
          const info = result.bodies.find((b: any) => b.id === id);
          const open = info?.openEdges?.length ?? 0;
          const sheet = !solids(debugBody as Shape3D);
          // (An open freeform surface is a sheet on purpose.)
          if (sheet && (feature.type === 'freeform' || feature.type === 'transform' || feature.type === 'import' || feature.type === 'deleteGeom' || feature.type === 'delete')) {
            continue;
          }
          if (sheet) {
            bad.push(`${id}: no solid`);
          } else {
            if (open) {
              bad.push(`${id}: ${open} open edges`);
            }
            if (!shapeValid(debugBody as Shape3D)) {
              bad.push(`${id}: invalid`);
            }
            const vol = measureVolume(debugBody as Shape3D);
            if (!(Math.abs(vol) > 1e-9) || !Number.isFinite(vol)) {
              bad.push(`${id}: volume ${vol}`);
            }
          }
          if (info && Array.from(info.positions as Float32Array).some(x => !Number.isFinite(x))) {
            bad.push(`${id}: mesh has NaN`);
          }
        } catch (err) {
          bad.push(`${id}: check threw ${String((err as Error)?.message ?? err).slice(0, 80)}`);
        }
      }
      if (bad.length) {
        say('BROKEN', i, feature, path, to, bad.join(', ').slice(0, 300));
      } else {
        fine++;
        if (process.env.MUTATE_VERBOSE) {
          console.log(`  sound: [${i}] ${feature.type} ${path.join('.')} = ${JSON.stringify(to)} (was ${JSON.stringify(v)?.slice(0, 40)})`);
        }
      }
    }
  }
  // The bodies as they are before the next step (unchanged: from the cache).
  await rebuild(features.slice(0, i + 1));
  before = new Map(debugBodies() as Map<string, Shape3D>);
}
console.log(`${found.length ? 'FAIL' : 'ok  '} ${FIXTURE}: ${tried} changes tried, ${refused} refused in words, ${fine} went through sound, ${found.length} findings, ${restarts} engine restarts, ${((performance.now() - t00) / 1000).toFixed(0)} s`);
process.exit(found.length ? 1 : 0);
