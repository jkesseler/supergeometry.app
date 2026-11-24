// Run: npx tsx tests/leak.test.ts [fixture] [rounds] [limitMB] [from] [to]
//
// How much of the engine's memory each rebuild of a step costs. OpenCascade
// never hands memory back, so whatever a step leaks adds up over an editing
// session (a drag is a rebuild per move) until the engine has to be replaced.
// Each step of a real project gets one of its sizes nudged back and forth
// `rounds` times; a step that costs more than `limitMB` a time fails.
//
// What it found: the cost is OpenCascade's own (its booleans and fillets keep
// memory on some shapes even with every object freed: a fillet on a cone's
// rim ~45 MB, a thread ~75 MB a rebuild). The app lives with it by swapping
// in a fresh engine (kernel/client.ts) - this keeps an eye on it getting worse.
import { readFileSync } from 'node:fs';
import opencascade from 'replicad-opencascadejs';
import { getOC, setOC } from 'replicad';
import { regenerate } from '../src/kernel/engine';
import type { Feature } from '../src/doc/types';

setOC(await (opencascade as unknown as () => Promise<any>)());

const FIXTURE = process.argv[2] ?? 'lamp-hand';
const ROUNDS = Number(process.argv[3] ?? 6);
const LIMIT = Number(process.argv[4] ?? 150);
const FROM = Number(process.argv[5] ?? 0);
const TO = Number(process.argv[6] ?? 1e9);

const doc = JSON.parse(readFileSync(new URL(`./fixtures/${FIXTURE}.json`, import.meta.url), 'utf8'));
const features: Feature[] = doc.features;
const heapMB = () => ((getOC() as any).wasmMemory?.buffer.byteLength ?? (getOC() as any).HEAPU8?.buffer.byteLength ?? 0) / 2 ** 20;

type Path = (string | number)[];
/** A size of the step to nudge: the first number that isn't a count, a direction or a reference's. */
function size(value: unknown, path: Path): Path | null {
  if (typeof value === 'number') {
    const key = String(path[path.length - 1]);
    const top = String(path[0]);
    if (['face', 'faces', 'edges', 'edge', 'source', 'axis', 'plane', 'vertex', 'guide', 'path'].includes(top)) {
      return null;
    }
    if (/count|sides|grid|segments|steps/i.test(key) || Math.abs(value) < 1e-6) {
      return null;
    }

    return path;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < Math.min(value.length, 40); i++) {
      const found = size(value[i], [...path, i]);
      if (found) {
        return found;
      }
    }

    return null;
  }
  if (value && typeof value === 'object') {
    for (const [key, x] of Object.entries(value)) {
      if (path.length === 0 && ['id', 'name', 'type', 'suppressed', 'data', 'log', 'exprs', 'color'].includes(key)) {
        continue;
      }
      const found = size(x, [...path, key]);
      if (found) {
        return found;
      }
    }
  }

  return null;
}
const nudged = (feature: Feature, path: Path, factor: number): Feature => {
  const copy = structuredClone(feature) as any;
  let target = copy;
  for (const key of path.slice(0, -1)) {
    target = target[key];
  }
  target[path[path.length - 1]] *= factor;

  return copy;
};

await regenerate(features, true);
console.log(`${FIXTURE}: ${features.length} steps, engine at ${heapMB().toFixed(0)} MB`);
let failed = 0;
const rows: { i: number; type: string; name: string; per: number; ms: number }[] = [];
for (let i = FROM; i < features.length && i < TO; i++) {
  const feature = features[i];
  if (feature.suppressed || feature.type === 'sketch' || feature.type === 'image') {
    continue;
  }
  const path = size(feature, []);
  if (!path) {
    continue;
  }
  const prefix = features.slice(0, i);
  // Warm: whatever the step allocates once (tables, the first growth) isn't a leak.
  for (const factor of [1.001, 1.002, 1.003]) {
    await regenerate([...prefix, nudged(feature, path, factor)]);
  }
  const before = heapMB();
  const t0 = performance.now();
  for (let round = 0; round < ROUNDS; round++) {
    const res: any = await regenerate([...prefix, nudged(feature, path, 1.004 + round * 0.0005)]);
    if (process.env.GC) {
      (globalThis as any).gc?.(); await new Promise(resolve => setTimeout(resolve, 0)); 
    }
    if (process.env.TRACE) {
      console.log(`   [${i}] round ${round}: ${heapMB().toFixed(0)} MB ${res.errors.map((e: any) => e.message).join('/').slice(0, 80)}`);
    }
  }
  const per = (heapMB() - before) / ROUNDS;
  const ms = (performance.now() - t0) / ROUNDS;
  rows.push({ i, type: feature.type, name: feature.name, per, ms });
  if (per > LIMIT) {
    failed++;
    console.log(`FAIL [${i}] ${feature.type} "${feature.name}" (${path.join('.')}): ${per.toFixed(2)} MB a rebuild, ${ms.toFixed(0)} ms`);
  }
  await regenerate(features, true);
}
const byType = new Map<string, number[]>();
for (const row of rows) {
  byType.set(row.type, [...(byType.get(row.type) ?? []), row.per]);
}
for (const [t, values] of [...byType].sort((a, b) => Math.max(...b[1]) - Math.max(...a[1]))) {
  console.log(`  ${t.padEnd(12)} ${values.length} steps, worst ${Math.max(...values).toFixed(2)} MB a rebuild, mean ${(values.reduce((a, b) => a + b, 0) / values.length).toFixed(2)}`);
}
console.log(`${failed ? 'FAIL' : 'ok  '} ${FIXTURE}: ${rows.length} steps measured, ${failed} over ${LIMIT} MB a rebuild, engine at ${heapMB().toFixed(0)} MB`);
process.exit(failed ? 1 : 0);
