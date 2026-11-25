// Run: npx tsx tests/helicalgears.slow.test.ts [out.json] - a pair of helical gears
// that mesh, built the way a person would, to push the geometry engine:
//   - each gear's outline drawn tooth by tooth (involute flanks as splines,
//     round tips and roots: 108 and 180 curves), swept up its axis with a
//     twist (a 20° helix; the two twist opposite ways, by their sizes);
//   - a bore with a keyway, a hub on the big gear, six lightening holes
//     patterned round and cut, every tooth's ends chamfered (hundreds of edges
//     on twisted faces), the pinion's bore threaded;
//   - checked: the teeth fill what an involute gear should, the gears sit
//     meshed without running into each other, and turned together (as they'd
//     run) they still don't - at the bottom face and at the top, where the
//     twist has carried the teeth round.
// The gears' axes are vertical (z), the pinion at the origin, the gear at x = 48.
import { writeFileSync } from 'node:fs';
import opencascade from 'replicad-opencascadejs';
import { measureArea, measureVolume, setOC } from 'replicad';
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
type P2 = [number, number];
const XY = (z = 0): PlaneDef => ({ origin: [0, 0, z], normal: [0, 0, 1], xDir: [1, 0, 0] });
const XZ = (y = 0): PlaneDef => ({ origin: [0, y, 0], normal: [0, -1, 0], xDir: [1, 0, 0] }); // u = x, v = z
const feats: any[] = [];
const doc = () => ({ format: 'super', version: 2, name: 'Helical gears', features: structuredClone(feats), variables: [], views: [], units: 'mm', hidden: [], pins: [], names: {} });
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
const circle = (id: string, center: P2, radius: number) => ({ id, kind: 'circle', center: center, radius: radius });
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

const rad = (degrees: number) => (degrees * Math.PI) / 180;
const deg = (radians: number) => (radians * 180) / Math.PI;
const overlap = (a: string, b: string, sa?: any, sb?: any) => {
  try {
    return Math.abs(measureVolume((sa ?? bodyShape(a)).clone().intersect((sb ?? bodyShape(b)).clone())));
  } catch {
    return -1;
  }
};

const MODULE = 2, PA = rad(20), HELIX = rad(20), WIDTH = 20, BACKLASH = 0.1;
const Z1 = 18, Z2 = 30;
const R1 = (MODULE * Z1) / 2, R2 = (MODULE * Z2) / 2; // 18, 30
const CD = R1 + R2; // 48
const inv = (a: number) => Math.tan(a) - a;

/** One gear's outline, tooth by tooth: a radial line below the base circle, the involute flank (a spline), the tip arc, back down, the root arc. */
const gearOutline = (pre: string, z: number, center: P2, turn = 0) => {
  const rp = (MODULE * z) / 2, rb = rp * Math.cos(PA), ra = rp + MODULE, rf = rp - 1.25 * MODULE;
  const psi = Math.PI / (2 * z) - BACKLASH / 2 / rp; // half the tooth at the pitch circle
  const phi = (radius: number) => psi + inv(PA) - inv(Math.acos(Math.min(1, rb / radius))); // flank's angle from the tooth's middle
  const at = (radius: number, a: number): P2 => [center[0] + radius * Math.cos(a + turn), center[1] + radius * Math.sin(a + turn)];
  const r0 = Math.max(rb, rf);
  const flank = (mid: number, side: number) => Array.from({ length: 9 }, (_, i) => r0 + ((ra - r0) * i) / 8).map(radius => at(radius, mid + side * phi(radius)));
  const es: any[] = [];
  for (let tooth = 0; tooth < z; tooth++) {
    const middle = (2 * Math.PI * tooth) / z;
    const right = flank(middle, -1), left = flank(middle, 1).reverse();
    if (rf < rb) {
      es.push({ id: `${pre}${tooth}a`, kind: 'line', a: at(rf, middle - phi(rb)), b: right[0] });
    }
    es.push({ id: `${pre}${tooth}b`, kind: 'spline', closed: false, mode: 'fit', points: right });
    es.push({ id: `${pre}${tooth}c`, kind: 'arc', a: right[8], m: at(ra, middle), b: left[0] });
    es.push({ id: `${pre}${tooth}d`, kind: 'spline', closed: false, mode: 'fit', points: left });
    if (rf < rb) {
      es.push({ id: `${pre}${tooth}e`, kind: 'line', a: left[8], b: at(rf, middle + phi(rb)) });
    }
    const next = (2 * Math.PI * (tooth + 1)) / z;
    es.push({ id: `${pre}${tooth}f`, kind: 'arc', a: at(rf, middle + phi(rb)), m: at(rf, (middle + next) / 2), b: at(rf, next - phi(rb)) });
  }

  return es;
};
/** The area an involute gear's outline holds (the same curves, integrated finely). */
const gearArea = (z: number) => {
  const rp = (MODULE * z) / 2, rb = rp * Math.cos(PA), ra = rp + MODULE, rf = rp - 1.25 * MODULE;
  const psi = Math.PI / (2 * z) - BACKLASH / 2 / rp;
  const phi = (radius: number) => psi + inv(PA) - inv(Math.acos(Math.min(1, rb / radius)));
  // ∫ r dr dθ: the tooth's width in angle at each radius.
  let a = Math.PI * rf * rf;
  const samples = 20000;
  for (let i = 0; i < samples; i++) {
    const radius = rf + ((ra - rf) * (i + 0.5)) / samples;
    a += z * 2 * phi(Math.max(radius, rb)) * radius * ((ra - rf) / samples);
  }

  return a;
};

// The twist that makes a 20° helix over the face width, at each gear's pitch circle.
const twist1 = deg((WIDTH * Math.tan(HELIX)) / R1); // ~23.2°
const twist2 = -twist1 * (R1 / R2);

const gear = (id: string, name: string, z: number, center: P2, turn: number, twist: number, bore: number) => {
  const es = [...gearOutline(`${id}t`, z, center, turn), circle(`${id}bore`, center, bore)];
  const regs = arrangement(es).regions.filter((region: any) => region.area > Math.PI * bore * bore + 1).map(regionRef);
  feats.push({ id: `s_${id}`, name: `${name} teeth`, type: 'sketch', plane: XY(0), entities: es });
  const path = [{ id: 'ax', kind: 'line', a: [center[0], 0], b: [center[0], WIDTH] }];
  feats.push({ id: `p_${id}`, name: `${name} axis`, type: 'sketch', plane: XZ(center[1]), entities: path });
  feats.push({ id, name, type: 'sweep', source: { kind: 'profile', sketch: `s_${id}`, regions: regs }, path: { kind: 'sketch', sketch: `p_${id}`, entities: ['ax'] }, mode: 'new', twist });

  return { regs, count: es.length };
};

// --- 1. The pinion, 18 teeth, and the gear, 30 teeth, turned half a tooth so a gap faces the pinion's tooth.
const g1 = gear('pinion', 'Pinion', Z1, [0, 0], 0, twist1, 5);
const g2 = gear('wheel', 'Gear', Z2, [CD, 0], Math.PI / Z2, twist2, 8);
const t0 = Date.now();
await stage('two helical gears swept with twist');
console.log(`     (${g1.count} + ${g2.count} curves, ${Date.now() - t0} ms)`);
check('…each sketch is one region with its bore', g1.regs.length === 1 && g2.regs.length === 1, `${g1.regs.length} ${g2.regs.length}`);
{
  // The twist doesn't change how much there is: the same gears swept straight hold the same.
  const [v1, v2] = [volumeOf('pinion'), volumeOf('wheel')];
  for (const id of ['pinion', 'wheel']) {
    feats.find(feature => feature.id === id).twist = 0;
  }
  await build();
  const [s1, s2] = [volumeOf('pinion'), volumeOf('wheel')];
  feats.find(feature => feature.id === 'pinion').twist = twist1;
  feats.find(feature => feature.id === 'wheel').twist = twist2;
  await build();
  check('…twisted, each holds what it does swept straight', Math.abs(v1 - s1) < s1 * 3e-4 && Math.abs(v2 - s2) < s2 * 3e-4, `${v1.toFixed(1)} / ${s1.toFixed(1)}, ${v2.toFixed(1)} / ${s2.toFixed(1)}`);
  // Swept straight, an involute gear's area (its flanks drawn as splines through 9 points each).
  const want1 = (gearArea(Z1) - Math.PI * 25) * WIDTH, want2 = (gearArea(Z2) - Math.PI * 64) * WIDTH;
  check('…and what an involute gear with a bore should', Math.abs(s1 - want1) < want1 * 3e-4 && Math.abs(s2 - want2) < want2 * 3e-4, `${s1.toFixed(1)} want ${want1.toFixed(1)}, ${s2.toFixed(1)} want ${want2.toFixed(1)}`);
  const bores = ['pinion', 'wheel'].map(id => bodyShape(id).faces.filter((face: any) => face.geomType === 'CYLINDRE').length);
  check("…their bores are true cylinders (twisted, they were splines a thread couldn't use)", bores.every(bore => bore >= 1), bores.join(' '));
}
check('…both clean solids', isHealthy(healthOf(bodyShape('pinion'))) && isHealthy(healthOf(bodyShape('wheel'))));
{
  const [lo, hi] = box('pinion');
  check('…the pinion 40 across its tips, 20 high', Math.abs(hi[2] - lo[2] - WIDTH) < 1e-3 && Math.abs(Math.max(hi[0], -lo[0], hi[1], -lo[1]) - (R1 + MODULE)) < 0.05, `${(hi[0] - lo[0]).toFixed(2)} x ${(hi[2] - lo[2]).toFixed(2)}`);
}
// The top face's teeth turned by the twist: the tip of tooth 0 is at angle twist1 there.
{
  const top = bodyShape('pinion').faces.find((face: any) => face.geomType === 'PLANE' && Math.abs(face.center.z - WIDTH) < 1e-6);
  const pts = top.edges.map((e: any) => e.pointAt(0.5).toTuple()).filter((point: number[]) => Math.abs(Math.hypot(point[0], point[1]) - (R1 + MODULE)) < 1e-3);
  const angs = pts.map((point: number[]) => deg(Math.atan2(point[1], point[0])));
  const near = angs.reduce((b: number, a: number) => (Math.abs(a - twist1) < Math.abs(b - twist1) ? a : b), 999);
  check("…its top face is turned by the twist (a tooth's tip at 23.2°)", Math.abs(near - twist1) < 0.05, `${near.toFixed(3)}° want ${twist1.toFixed(3)}°`);
}

// --- 2. Meshed: they don't run into each other; turned together, they still don't.
const o0 = overlap('pinion', 'wheel');
check("meshed: the teeth don't run into each other (0.1 backlash)", o0 >= 0 && o0 < 0.01, `${o0.toFixed(4)} mm³`);
for (const a of [3, 7, 11, 17]) {
  const pinion = bodyShape('pinion').clone().rotate(a, [0, 0, 0], [0, 0, 1]);
  const wheel = bodyShape('wheel').clone().rotate((-a * Z1) / Z2, [CD, 0, 0], [0, 0, 1]);
  const overlapVolume = overlap('', '', pinion, wheel);
  check(`…turned ${a}° together: still clear`, overlapVolume >= 0 && overlapVolume < 0.01, `${overlapVolume.toFixed(4)} mm³`);
}
{
  // Without the backlash they'd touch, and with a tooth too many degrees out they'd run in: the check bites.
  const pinion = bodyShape('pinion').clone().rotate(5, [0, 0, 0], [0, 0, 1]);
  const overlapVolume = overlap('', '', pinion, bodyShape('wheel'));
  check('…the pinion alone turned 5°: they run into each other (the check works)', overlapVolume > 1, `${overlapVolume.toFixed(2)} mm³`);
}

// --- 3. The gear: a hub, six lightening holes patterned round and cut.
feats.push({ id: 's_hub', name: 'Hub sketch', type: 'sketch', plane: XY(WIDTH), entities: [circle('h', [CD, 0], 14), circle('hb', [CD, 0], 8)] });
feats.push({ id: 'hub', name: 'Hub', type: 'extrude', source: { kind: 'profile', sketch: 's_hub', regions: arrangement([circle('h', [CD, 0], 14), circle('hb', [CD, 0], 8)]).regions.filter((region: any) => region.area > 300).map(regionRef) }, distance: 8, mode: 'join', target: 'wheel' });
feats.push({ id: 's_lh', name: 'Lightening hole', type: 'sketch', plane: XY(WIDTH), entities: [circle('l', [CD + 19, 0], 4)] });
feats.push({ id: 'lh', name: 'Lightening hole', type: 'extrude', source: { kind: 'profile', sketch: 's_lh', regions: arrangement([circle('l', [CD + 19, 0], 4)]).regions.map(regionRef) }, distance: -WIDTH, mode: 'new' });
feats.push({ id: 'lhs', name: 'Lightening holes round', type: 'transform', bodies: ['lh'], copy: true, op: { kind: 'circular', axis: { origin: [CD, 0, 0], dir: [0, 0, 1] }, count: 6, angle: 360 } });
feats.push({ id: 'cutl', name: 'Lightening holes cut', type: 'boolean', op: 'subtract', target: 'wheel', tools: ['lh', ...[0, 1, 2, 3, 4].map(index => `lhs:lh:${index}`)] });
// A keyway in the gear's bore, through the hub too.
feats.push({ id: 's_kw', name: 'Keyway', type: 'sketch', plane: XY(0), entities: [{ id: 'k', kind: 'rect', center: [CD + 8, 0], w: 5, h: 4, rotation: 0 }] });
feats.push({ id: 'kw', name: 'Keyway', type: 'extrude', source: { kind: 'profile', sketch: 's_kw', regions: arrangement([{ id: 'k', kind: 'rect', center: [CD + 8, 0], w: 5, h: 4, rotation: 0 }] as any).regions.map(regionRef) }, distance: WIDTH + 8, mode: 'cut', target: 'wheel' });
const pre3 = volumeOf('wheel');
await stage('hub, lightening holes and keyway');
// The keyway: the 5 x 4 from x 5.5 to 10.5 less what's inside the Ø16 bore, through gear and hub.
const kwV = (() => {
  let a = 0;
  for (let step = 0; step < 4000; step++) {
    const y = -2 + (4 * (step + 0.5)) / 4000;
    a += (10.5 - Math.max(5.5, Math.sqrt(64 - y * y))) * (4 / 4000);
  }

  return a * (WIDTH + 8);
})();
const want3 = pre3 + Math.PI * (14 * 14 - 64) * 8 - 6 * Math.PI * 16 * WIDTH;
check('…the hub added and six holes taken (and a keyway)', Math.abs(volumeOf('wheel') - (want3 - kwV)) < 0.5, `${volumeOf('wheel').toFixed(1)} want ~${(want3 - kwV).toFixed(1)}`);

// --- 4. Chamfer every tooth's ends: the tips' and the involute flanks' edges at both faces (0.5).
// (Not the short radial bit below the base circle: on a helix as steep as 33° the engine can't
// chamfer it at any size - the 23° gears here take it, but the change to 33° below wouldn't.)
const r4 = await build(true);
for (const [id, z] of [['pinion', Z1], ['wheel', Z2]] as const) {
  const rp = (MODULE * z) / 2;
  const cx = id === 'pinion' ? 0 : CD;
  const tooth = bodyShape(id).edges.filter((e: any) => {
    const point = e.pointAt(0.5).toTuple();
    const radius = Math.hypot(point[0] - cx, point[1]);

    return (Math.abs(point[2]) < 1e-6 || Math.abs(point[2] - WIDTH) < 1e-6) && radius > rp * Math.cos(PA) + 0.1;
  });
  const pre = volumeOf(id);
  feats.push({ id: `ch_${id}`, name: `Chamfer ${id} teeth`, type: 'chamfer', radius: 0.5, edges: asPicked(r4, id, tooth) });
  const t = Date.now();
  const result = await build();
  check(`${id}: ${tooth.length} tooth edges chamfered 0.5`, !result.errors.length && isHealthy(healthOf(bodyShape(id))), `${Date.now() - t} ms`);
  // Each tooth's outline above the root, at both faces, loses a 0.5 x 0.5 triangle along it.
  const flankLen = tooth.reduce((total: number, e: any) => total + e.length, 0);
  check(`…takes about 0.125 mm² along ${flankLen.toFixed(0)} mm of edge`, Math.abs(pre - volumeOf(id) - 0.125 * flankLen) < 0.125 * flankLen * 0.25, `${(pre - volumeOf(id)).toFixed(1)} want ~${(0.125 * flankLen).toFixed(1)}`);
}

// --- 5. Thread the pinion's bore (M10 x 1.5 tapped into the Ø10 drawn... a Ø8.5 tap drill).
feats.find(feature => feature.id === 's_pinion').entities = feats.find(feature => feature.id === 's_pinion').entities.map((e: any) => (e.id === 'pinionbore' ? { ...e, radius: 4.25 } : e));
{
  const es = feats.find(feature => feature.id === 's_pinion').entities;
  feats.find(feature => feature.id === 'pinion').source.regions = arrangement(es).regions.filter((region: any) => region.area > Math.PI * 4.25 ** 2 + 1).map(regionRef);
}
await build(true);
const boreF = bodyShape('pinion').faces.find((face: any) => face.geomType === 'CYLINDRE' && Math.abs(face.center.x) < 1e-3 && Math.abs(face.center.y) < 1e-3);
feats.push({ id: 'thr', name: 'Thread M10', type: 'thread', face: faceRef('pinion', boreF), pitch: 1.5, round: { r: 4.25, hole: true } });
const pre5 = volumeOf('pinion');
await stage("the pinion's bore threaded M10");
check('…the thread takes metal out of the bore', volumeOf('pinion') < pre5 - 50 && volumeOf('pinion') > pre5 - 600, `${(pre5 - volumeOf('pinion')).toFixed(1)} mm³`);
check('…still clear of the gear', overlap('pinion', 'wheel') < 0.01);

// --- Changes upstream: a steeper helix, fewer teeth.
{
  const was = structuredClone(feats);
  feats.find(feature => feature.id === 'pinion').twist = twist1 * 1.8;
  feats.find(feature => feature.id === 'wheel').twist = twist2 * 1.8;
  const result = await build();
  check('a 33° helix: everything after rebuilds', !result.errors.length);
  check('…still clear', overlap('pinion', 'wheel') < 0.01, `${overlap('pinion', 'wheel').toFixed(4)}`);
  feats.length = 0;
  feats.push(...was);
}
{
  const was = structuredClone(feats);
  feats.find(feature => feature.id === 'pinion').twist = 0;
  feats.find(feature => feature.id === 'wheel').twist = 0;
  const result = await build();
  check('twist 0 (spur gears): everything after rebuilds', !result.errors.length);
  feats.length = 0;
  feats.push(...was);
}
const final = await build();
check('two clean solids at the end', final.bodies.length === 2 && ['pinion', 'wheel'].every(b => isHealthy(healthOf(bodyShape(b)))));
console.log(`${feats.length} steps`);

if (process.argv[2]) {
  const project: any = doc();
  project.colors = { pinion: '#b9bdc2', wheel: '#c9a227' };
  project.names = { pinion: 'Pinion (18 teeth)', wheel: 'Gear (30 teeth)' };
  project.hidden = feats.filter(feature => feature.type === 'sketch').map(feature => feature.id);
  writeFileSync(process.argv[2], JSON.stringify(project));
  console.log('written', process.argv[2]);
}
process.exit(failed ? 1 : 0);
