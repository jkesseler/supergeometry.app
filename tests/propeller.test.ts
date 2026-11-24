// Run: npx tsx tests/propeller.test.ts [out.json] - a three-bladed boat
// propeller, 240 across, built the way a person would, to push the geometry
// engine where it bends:
//   - the hub revolved from a profile (a rounded nose, a straight barrel);
//   - one blade lofted through six sections out from the hub (each an
//     ellipse on its own plane, narrower and flatter the further out, turned
//     to a 200 mm pitch and swept back), its root buried in the hub;
//   - the blade patterned round three times and joined to the hub;
//   - the blade roots rounded where they meet the hub (curves where a lofted
//     surface runs into a cylinder), the blade tips trimmed by a revolved
//     ring (Intersect), a bore with a keyway, the nose threaded for its nut.
// The shaft runs along z; the blades stand out along y (and round).
import { writeFileSync } from 'node:fs';
import opencascade from 'replicad-opencascadejs';
import { measureArea, setOC } from 'replicad';
import { measureVolume, volumeProperties } from '../src/kernel/ocFree';
import { debugBodies, regenerate } from '../src/kernel/engine';
import { healthOf, isHealthy } from '../src/kernel/repair';
import { arrangement, regionRef } from '../src/sketch/regions';
import type { PlaneDef, Vec3 } from '../src/doc/types';

setOC(await (opencascade as unknown as () => Promise<any>)());
let failed = 0;
const check = (name: string, ok: boolean, info = '') => {
  if (!ok) {
    failed++;
  }
  console.log(ok ? 'ok  ' : 'FAIL', name, info);
};
const XZ = (y = 0): PlaneDef => ({ origin: [0, y, 0], normal: [0, -1, 0], xDir: [1, 0, 0] }); // u = x, v = z
const XY = (z = 0): PlaneDef => ({ origin: [0, 0, z], normal: [0, 0, 1], xDir: [1, 0, 0] });
/** Square to the blade at `radius` (a plane y = radius): u = x, v = z. */
const across = (radius: number): PlaneDef => ({ origin: [0, radius, 0], normal: [0, 1, 0], xDir: [-1, 0, 0] });
const all = (es: any[]) => arrangement(es).regions.map(regionRef);
const feats: any[] = [];
const doc = () => ({ format: 'super', version: 2, name: 'Propeller', features: structuredClone(feats), variables: [], views: [], units: 'mm', hidden: [], pins: [], names: {} });
const nameOf = (fid: string) => feats.find(feature => feature.id === fid)?.name ?? fid;
const build = async (quiet = false) => {
  const result: any = await regenerate(doc().features as any);
  if (result.errors.length && !quiet) {
    console.log('   errors:', result.errors.map((e: any) => `${nameOf(e.featureId)}: ${e.message}`).join('; '));
  }

  return result;
};
const stage = async (label: string) => {
  const t = Date.now();
  const result = await build();
  check(`${label} builds`, !result.errors.length, `${result.bodies.length} bodies, ${Date.now() - t} ms`);

  return result;
};
const bodyShape = (body: string) => debugBodies().get(body) as any;
const volumeOf = (body: string) => Math.abs(measureVolume(bodyShape(body)));
const box = (body: string) => bodyShape(body).boundingBox.bounds as [number[], number[]];
const faceRef = (body: string, face: any) => ({ body, center: face.center.toTuple() as Vec3, normal: face.normalAt().toTuple() as Vec3, area: measureArea(face) });
const rad = (degrees: number) => (degrees * Math.PI) / 180;
/** Edges as the app picks them: from the engine's own list (direction of unit length, the steps either side). */
const asPicked = (result: any, body: string, edges: any[]) => {
  const infos = result.bodies.find((b: any) => b.id === body).edges;
  const all = bodyShape(body).edges;
  if (infos.length !== all.length) {
    throw new Error('edge lists differ');
  }

  return edges.map((e: any) => {
    const i = all.findIndex((edge: any) => edge.isSame(e));
    const { mid, dir, length, steps, curves } = infos[i];

    return { body, mid, dir, length, ...(steps ? { steps } : {}), ...(curves ? { curves } : {}) };
  });
};


const HUB_R = 25, HUB_L = 60, PITCH = 200, TIP = 120;

// --- 1. The hub: a barrel 50 across, 60 long, a rounded nose on the front (+z), revolved.
const hubProfile = [
  { id: 'h1', kind: 'line', a: [0, 0], b: [HUB_R, 0] },
  { id: 'h2', kind: 'line', a: [HUB_R, 0], b: [HUB_R, HUB_L] },
  { id: 'h3', kind: 'arc', a: [HUB_R, HUB_L], m: [HUB_R * Math.cos(rad(45)), HUB_L + HUB_R * Math.sin(rad(45)) * 0.8], b: [0, HUB_L + 20] },
  { id: 'h4', kind: 'line', a: [0, HUB_L + 20], b: [0, 0] }
];
feats.push({ id: 's_hub', name: 'Hub profile', type: 'sketch', plane: XZ(0), entities: hubProfile });
feats.push({ id: 'prop', name: 'Hub', type: 'revolve', source: { kind: 'profile', sketch: 's_hub', regions: all(hubProfile) }, axis: { origin: [0, 0, 0], dir: [0, 0, 1] }, angle: 360, mode: 'new' });
await stage('the hub');
const hubV = volumeOf('prop');

// --- 2. One blade: six sections from inside the hub to the tip.
// At radius r: chord c, thickness t, turned to the pitch (the blade's angle to the
// hub's face: atan(pitch / 2πr)), swept back (its middle moved round) and raked aft.
const sections = [
  { r: 12, c: 30, t: 9 }, // buried in the hub: its corners at r 19
  { r: 35, c: 52, t: 8 },
  { r: 60, c: 70, t: 6.5 },
  { r: 85, c: 74, t: 5 },
  { r: 105, c: 60, t: 3.5 },
  { r: 124, c: 30, t: 2 }
];
const pitchDeg = (radius: number) => (Math.atan(PITCH / (2 * Math.PI * radius)) * 180) / Math.PI;
const skew = (radius: number) => 0.12 * (radius - 12); // the middle moved round (along u)
const rake = (radius: number) => HUB_L / 2 - 0.06 * (radius - 12); // and aft (down z)
sections.forEach((section, i) => {
  // The ellipse's long axis lies along the blade's chord: turned from the hub's face by the pitch angle.
  const ent = { id: `e${i}`, kind: 'ellipse', center: [skew(section.r), rake(section.r)], rx: section.c / 2, ry: section.t / 2, rotation: rad(pitchDeg(section.r)) };
  feats.push({ id: `s_b${i}`, name: `Blade section ${i + 1} (r ${section.r})`, type: 'sketch', plane: across(section.r), entities: [ent] });
});
feats.push({
  id: 'blade',
  name: 'Blade',
  type: 'loft',
  sections: sections.map((_, i) => ({ kind: 'profile', sketch: `s_b${i}`, regions: all([{ id: `e${i}`, kind: 'ellipse', center: [skew(sections[i].r), rake(sections[i].r)], rx: sections[i].c / 2, ry: sections[i].t / 2, rotation: rad(pitchDeg(sections[i].r)) }]) })),
  ruled: false,
  mode: 'new'
});
await stage('one blade lofted through six turned sections');
check('…a clean solid', isHealthy(healthOf(bodyShape('blade'))), JSON.stringify(healthOf(bodyShape('blade'))));
{
  // A smooth loft lies near the sections' areas times the gaps between them (Simpson, roughly).
  const areas = sections.map(section => (Math.PI * section.c * section.t) / 4);
  let est = 0;
  for (let i = 0; i + 1 < sections.length; i++) {
    est += ((areas[i] + areas[i + 1]) / 2) * (sections[i + 1].r - sections[i].r);
  }
  check('…about as big as its sections say', Math.abs(volumeOf('blade') - est) < est * 0.06, `${volumeOf('blade').toFixed(0)} vs ~${est.toFixed(0)}`);
  const [lo, hi] = box('blade');
  check('…from inside the hub out to r 124', Math.abs(lo[1] - 12) < 0.01 && Math.abs(hi[1] - 124) < 0.01, `${lo[1].toFixed(2)} .. ${hi[1].toFixed(2)}`);
}
const bladeV = volumeOf('blade');

// --- 3. Three blades round, joined to the hub.
feats.push({ id: 'blades', name: 'Blades round', type: 'transform', bodies: ['blade'], copy: true, op: { kind: 'circular', axis: { origin: [0, 0, 0], dir: [0, 0, 1] }, count: 3, angle: 360 } });
feats.push({ id: 'join', name: 'Join blades to the hub', type: 'boolean', op: 'union', target: 'prop', tools: ['blade', 'blades:blade:0', 'blades:blade:1'] });
await stage('three blades joined to the hub');
check('…one body', [...debugBodies().keys()].join() === 'prop', [...debugBodies().keys()].join());
const inHub = (() => {
  // What of a blade lies inside the hub (counted from the blade and the hub themselves).
  return bladeV + hubV - 0; // filled in below from the join
})();
check("…the hub and the three blades less where they're buried in it", volumeOf('prop') < hubV + 3 * bladeV && volumeOf('prop') > hubV + 3 * bladeV * 0.85, `${volumeOf('prop').toFixed(0)} (hub ${hubV.toFixed(0)}, blades 3 x ${bladeV.toFixed(0)})`);
{
  const centerOfMass = volumeProperties(bodyShape('prop')).centerOfMass;
  check('…balanced: its centre of mass on the shaft', Math.hypot(centerOfMass[0], centerOfMass[1]) < 0.01, centerOfMass.map((value: number) => value.toFixed(4)).join(', '));
}
void inHub;

// --- 4. Trim the tips round: keep what's inside a 240 disc (a cylinder, intersected).
feats.push({ id: 's_trim', name: 'Tip circle', type: 'sketch', plane: XY(-20), entities: [{ id: 'c', kind: 'circle', center: [0, 0], radius: TIP }] });
feats.push({ id: 'trim', name: 'Tip circle', type: 'extrude', source: { kind: 'profile', sketch: 's_trim', regions: all([{ id: 'c', kind: 'circle', center: [0, 0], radius: TIP }]) }, distance: 120, mode: 'new' });
feats.push({ id: 'cut', name: 'Trim the tips', type: 'boolean', op: 'intersect', target: 'prop', tools: ['trim'] });
const preTrim = volumeOf('prop');
await stage('the tips trimmed to 240 across');
{
  const [lo, hi] = box('prop');
  const reach = Math.max(-lo[0], hi[0], -lo[1], hi[1]);
  check('…240 across the tips', Math.abs(reach - TIP) < 0.01, `${(2 * reach).toFixed(2)}`);
  check('…a little taken off each tip', volumeOf('prop') < preTrim - 30 && volumeOf('prop') > preTrim - 3000, `${(preTrim - volumeOf('prop')).toFixed(0)} mm³`);
}

// --- 5. Round the blade roots: the curves where the blades run into the hub (r 4).
const r5 = await build(true);
const roots = bodyShape('prop').edges.filter((e: any) => {
  if (e.geomType === 'CIRCLE' || e.geomType === 'LINE') {
    return false;
  }

  return [0, 0.25, 0.5, 0.75, 1].every((t) => {
    const point = e.pointAt(t).toTuple();

    return Math.abs(Math.hypot(point[0], point[1]) - HUB_R) < 1e-3;
  });
});
check('the root edges found (round each blade, on the hub)', roots.length >= 3 && roots.length <= 9, `${roots.length}: ${roots.map((e: any) => `${e.geomType} ${e.length.toFixed(1)}`).join(', ')}`);
const preRoot = volumeOf('prop');
feats.push({ id: 'rootFil', name: 'Root fillets', type: 'fillet', radius: 4, edges: asPicked(r5, 'prop', roots) });
await stage('the blade roots rounded r 4');
check('…they add metal in the corners', volumeOf('prop') > preRoot + 50 && volumeOf('prop') < preRoot + 3000, `+${(volumeOf('prop') - preRoot).toFixed(0)} mm³`);
check('…still clean', isHealthy(healthOf(bodyShape('prop'))));

// --- 6. A bore with a keyway, the nose drilled and threaded for the nut.
const bore = [{ id: 'b', kind: 'circle', center: [0, 0], radius: 10 }];
feats.push({ id: 's_bore', name: 'Bore', type: 'sketch', plane: XY(0), entities: bore });
feats.push({ id: 'bore', name: 'Bore', type: 'extrude', source: { kind: 'profile', sketch: 's_bore', regions: all(bore) }, distance: HUB_L, mode: 'cut', target: 'prop' });
const key = [{ id: 'k', kind: 'rect', center: [0, 11], w: 6, h: 4, rotation: 0 }];
feats.push({ id: 's_key', name: 'Keyway', type: 'sketch', plane: XY(0), entities: key });
feats.push({ id: 'key', name: 'Keyway', type: 'extrude', source: { kind: 'profile', sketch: 's_key', regions: all(key) }, distance: HUB_L, mode: 'cut', target: 'prop' });
const nut = [{ id: 'n', kind: 'circle', center: [0, 0], radius: 7 }];
// From the nose's tip down into the bore.
feats.push({ id: 's_nut', name: 'Nut hole', type: 'sketch', plane: XY(HUB_L + 20), entities: nut });
feats.push({ id: 'nut', name: 'Nut hole', type: 'extrude', source: { kind: 'profile', sketch: 's_nut', regions: all(nut) }, distance: -24, mode: 'cut', target: 'prop' });
const preBore = volumeOf('prop');
await stage("bore, keyway and the nose's hole");
await build(true);
const nutF = bodyShape('prop').faces.find((face: any) => face.geomType === 'CYLINDRE' && face.center.z > HUB_L && Math.hypot(face.center.x, face.center.y) < 1e-3);
check("the nose's hole is a cylinder to thread", !!nutF);
if (nutF) {
  feats.push({ id: 'thr', name: 'Thread M16', type: 'thread', face: faceRef('prop', nutF), pitch: 1.5, round: { r: 7, hole: true } });
  await stage('the nose threaded');
}
check('…bore, keyway and hole took what they should', preBore - volumeOf('prop') > Math.PI * 100 * HUB_L && preBore - volumeOf('prop') < Math.PI * 100 * HUB_L + 6 * 4 * HUB_L + Math.PI * 49 * 20 + 50, `${(preBore - volumeOf('prop')).toFixed(0)} mm³`);

// --- Checks on the whole, and changes upstream.
const final = await build();
check('one clean solid', final.bodies.length === 1 && isHealthy(healthOf(bodyShape('prop'))), JSON.stringify(healthOf(bodyShape('prop'))));
console.log(`${feats.length} steps, ${(volumeOf('prop') / 1000).toFixed(1)} cm³ (${((volumeOf('prop') * 8.5e-3) / 1000).toFixed(2)} kg of bronze)`);
{
  const centerOfMass = volumeProperties(bodyShape('prop')).centerOfMass;
  check('…balanced (the keyway pulls it a hair: 0.06 its way)', Math.hypot(centerOfMass[0], centerOfMass[1]) < 0.12 && centerOfMass[1] < 0, centerOfMass.map((value: number) => value.toFixed(3)).join(', '));
}
for (const [label, change] of [
  ['a coarser pitch (300): every section turned, everything after rebuilds', () => sections.forEach((section, i) => (feats.find(feature => feature.id === `s_b${i}`).entities[0].rotation = Math.atan(300 / (2 * Math.PI * section.r))))],
  ['roots rounded r 6', () => (feats.find(feature => feature.id === 'rootFil').radius = 6)],
  ['a ruled loft (straight between sections)', () => (feats.find(feature => feature.id === 'blade').ruled = true)]
] as [string, () => void][]) {
  const was = structuredClone(feats);
  change();
  const t = Date.now();
  const result = await build();
  check(label, !result.errors.length, `${Date.now() - t} ms ${(result.notes ?? []).map((note: any) => note.message).join(' | ')}`);
  feats.length = 0;
  feats.push(...was);
}

{
  // Four blades: two of the three roots it rounded are where no blade is now - it asks for them again.
  const was = structuredClone(feats);
  feats.find(feature => feature.id === 'blades').op.count = 4;
  const result = await build(true);
  check("four blades: the root fillet asks for its edges again (two blades it rounded aren't there)", result.errors.length === 1 && /pick the edges again/.test(result.errors[0].message), result.errors.map((e: any) => e.message).join('; '));
  feats.length = 0;
  feats.push(...was);
}

if (process.argv[2]) {
  const project: any = doc();
  project.colors = { prop: '#c9a227' };
  project.names = { prop: 'Propeller' };
  project.hidden = feats.filter(feature => feature.type === 'sketch').map(feature => feature.id);
  writeFileSync(process.argv[2], JSON.stringify(project));
  console.log('written', process.argv[2]);
}
process.exit(failed ? 1 : 0);
