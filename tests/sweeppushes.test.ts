// Run: npx tsx tests/sweeppushes.test.ts - a user's S-curve tube whose ends
// were pushed in again and again (Offset Face on a sweep's end, 19 times;
// tests/fixtures/sweeppushes.json). Pushes on the bend failed: the end's plane
// cuts an S-shaped path in more than one place and only the first was tried,
// and the cutting disc was far wider than the tube (on a tight bend it folded
// over itself, or bit into the tube's next turn: "break into pieces").
import { readFileSync } from 'node:fs';
import opencascade from 'replicad-opencascadejs';
import { measureArea, measureVolume, setOC } from 'replicad';
import { debugBodies, regenerate } from '../src/kernel/engine';
import { healthOf, isHealthy } from '../src/kernel/repair';

setOC(await (opencascade as unknown as () => Promise<any>)());
let failed = 0;
const check = (name: string, ok: boolean, info = '') => {
  if (!ok) {
    failed++;
  }
  console.log(ok ? 'ok  ' : 'FAIL', name, info);
};
const doc = JSON.parse(readFileSync(new URL('./fixtures/sweeppushes.json', import.meta.url), 'utf8'));
const BODY = 'sweep-mw6p7ni3-sy2n';
const AREA = Math.PI * 2.5 * 2.5;
const name = (id: string) => doc.features.find((feature: any) => feature.id === id)?.name;
const tube = () => {
  const shape = debugBodies().get(BODY)!;
  const ends = shape.faces.filter(face => face.geomType === 'PLANE');

  return { s: shape, length: Math.abs(measureVolume(shape)) / AREA, round: ends.length === 2 && ends.every(end => Math.abs(measureArea(end) - AREA) < AREA * 2e-3), ends: ends.map(end => measureArea(end).toFixed(2)).join(', ') };
};

// As the user saw it: the pushes that failed then (11, 12, 18, 20) left out.
{
  const skip = new Set(['Offset Face 11', 'Offset Face 12', 'Offset Face 18', 'Offset Face 20']);
  const result: any = await regenerate(doc.features.filter((feature: any) => !skip.has(feature.name)));
  const t = tube();
  check('as the user built it: every push builds', !result.errors.length, result.errors.map((e: any) => `${name(e.featureId)}: ${e.message}`).join('; '));
  check('…one clean tube, both ends round', isHealthy(healthOf(t.s)) && t.round, `${t.length.toFixed(2)} long; ends ${t.ends}`);
}

// Everything: 11 and 12 build now; by 18 the tube is shorter than the push (an honest error).
{
  const t0 = performance.now();
  const result: any = await regenerate(doc.features);
  const ms = performance.now() - t0;
  const failedNames = result.errors.map((e: any) => name(e.featureId));
  check("all on: Offset Face 11 and 12 build (they're on the bend)", !failedNames.includes('Offset Face 11') && !failedNames.includes('Offset Face 12'), failedNames.join(', '));
  check("…no kernel failures, only pushes past what's left", result.errors.every((e: any) => /remove/.test(e.message)), result.errors.map((e: any) => `${name(e.featureId)}: ${e.message}`).join('; '));
  check('…19 pushes rebuild in reasonable time', ms < 12000, `${Math.round(ms)} ms`);
  const upto = doc.features.slice(0, doc.features.findIndex((feature: any) => feature.name === 'Offset Face 17') + 1);
  await regenerate(upto);
  const t = tube();
  check('…up to 17 the tube is 3 mm long (18 pushes 6.4)', t.length < 6.4 && t.round, `${t.length.toFixed(2)}; ends ${t.ends}`);
}

console.log(failed ? `${failed} FAILED` : 'all passed');
process.exit(failed ? 1 : 0);
