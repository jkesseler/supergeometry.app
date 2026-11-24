// Run: npx tsx tests/church.test.ts [out.json] - a small church inside
// 250 × 250 × 250 mm: a nave (100 × 150, walls 90 high) with a 45° gable, a
// 50 × 50 tower at the front 170 high, a pitched roof 6 mm thick with
// overhangs, a spire (a loft from a square to a point) and a cross on top;
// an arched door, three arched windows a side, arched belfry openings and a
// round window in the back gable, cut into the walls. Two bodies: the stone
// (walls, gable, tower) and the roof (roof, spire, cross).
import { writeFileSync } from 'node:fs';
import opencascade from 'replicad-opencascadejs';
import { measureVolume, setOC } from 'replicad';
import { debugBodies, regenerate } from '../src/kernel/engine';
import { healthOf, isHealthy } from '../src/kernel/repair';
import { arrangement, drawnRegions, pointInRegion, regionRef } from '../src/sketch/regions';
import type { Vec3 } from '../src/doc/types';

setOC(await (opencascade as unknown as () => Promise<any>)());
let failed = 0;
const check = (name: string, ok: boolean, info = '') => {
  if (!ok) {
    failed++;
  }
  console.log(ok ? 'ok  ' : 'FAIL', name, info);
};

let count = 0;
const id = () => `e${count++}`;
const rect = (cx: number, cy: number, width: number, height: number) => ({ id: id(), kind: 'rect', center: [cx, cy], w: width, h: height, rotation: 0 });
const circle = (cx: number, cy: number, radius: number) => ({ id: id(), kind: 'circle', center: [cx, cy], radius: radius });
const poly = (pts: number[][]) => ({ id: id(), kind: 'polyline', closed: true, points: pts });
/** An arched opening: a rectangle `width` wide, `height` tall from `bottom`, with a half circle on top. */
const arch = (cx: number, bottom: number, width: number, height: number) => [rect(cx, bottom + height / 2, width, height), circle(cx, bottom + height, width / 2)];
const plane = (origin: Vec3, normal: Vec3, xDir: Vec3) => ({ origin, normal, xDir });
const XY = (z = 0) => plane([0, 0, z], [0, 0, 1], [1, 0, 0]);

const feats: any[] = [];
/** A sketch and an extrude of every region in it (shapes drawn overlapping are one region set). */
const sketchExtrude = (name: string, pl: any, entities: any[], distance: number, mode: string, target?: string, bodyId?: string) => {
  const sketchId = `s${feats.length}`;
  feats.push({ id: sketchId, name: `${name} sketch`, type: 'sketch', plane: pl, entities });
  feats.push({ id: bodyId ?? `x${feats.length}`, name, type: 'extrude', source: { kind: 'profile', sketch: sketchId, regions: arrangement(entities as any).regions.map(regionRef) }, distance, mode, ...(target ? { target } : {}) });

  return sketchId;
};

const WIDTH = 100, LENGTH = 150, WALL = 90, GABLE = 50, TOWER = 50, TH = 170;
const y0 = -40, y1 = y0 + LENGTH; // nave from the front wall (y −40) to the back (y 110)
const ty0 = -75, ty1 = -25; // tower, standing out in front of the nave

// The stone: nave, gable along it, tower.
sketchExtrude('Nave', XY(), [rect(0, (y0 + y1) / 2, WIDTH, LENGTH)], WALL, 'new', undefined, 'stone');
sketchExtrude('Gable', plane([0, y1, 0], [0, -1, 0], [1, 0, 0]), [poly([[-WIDTH / 2, WALL], [WIDTH / 2, WALL], [0, WALL + GABLE]])], LENGTH, 'join', 'stone');
sketchExtrude('Tower', XY(), [rect(0, (ty0 + ty1) / 2, TOWER, ty1 - ty0)], TH, 'join', 'stone');

// The roof: a 45° chevron 6 mm thick, overhanging 8 mm at the eaves and 5 at each end.
const OVERHANG = 8, THICKNESS = 6;
const eave = WALL - OVERHANG; // the gable line carried out past the wall
sketchExtrude('Roof', plane([0, y1 + 5, 0], [0, -1, 0], [1, 0, 0]), [poly([[-(WIDTH / 2 + OVERHANG), eave], [0, WALL + GABLE], [WIDTH / 2 + OVERHANG, eave], [WIDTH / 2 + OVERHANG, eave + THICKNESS], [0, WALL + GABLE + THICKNESS], [-(WIDTH / 2 + OVERHANG), eave + THICKNESS]])], LENGTH + 10, 'new', undefined, 'roof');
// Where the tower rises through the roof, the roof stops at it.
sketchExtrude('Roof around the tower', XY(WALL - 20), [rect(0, (ty0 + ty1) / 2, TOWER, ty1 - ty0)], 80, 'cut', 'roof');
// The spire: a loft from a square over the tower's top to a small one at its point.
const tc = (ty0 + ty1) / 2;
const sBase = `s${feats.length}`;
const base = [rect(0, tc, TOWER + 4, TOWER + 4)];
feats.push({ id: sBase, name: 'Spire base', type: 'sketch', plane: XY(TH), entities: base });
const sTip = `s${feats.length}`;
const tip = [rect(0, tc, 2, 2)];
feats.push({ id: sTip, name: 'Spire tip', type: 'sketch', plane: XY(238), entities: tip });
feats.push({ id: 'spire', name: 'Spire', type: 'loft', sections: [{ kind: 'profile', sketch: sBase, regions: arrangement(base as any).regions.map(regionRef) }, { kind: 'profile', sketch: sTip, regions: arrangement(tip as any).regions.map(regionRef) }], ruled: true, mode: 'join', target: 'roof' });
// The cross: an upright 3 × 3 from 236 to 250, an arm across at 243.
sketchExtrude('Cross upright', XY(236), [rect(0, tc, 3, 3)], 14, 'join', 'roof');
sketchExtrude('Cross arm', plane([0, tc - 1.5, 0], [0, 1, 0], [-1, 0, 0]), [rect(0, 244, 11, 3)], 3, 'join', 'roof');

// Openings in the stone.
sketchExtrude('Door', plane([0, ty0, 0], [0, -1, 0], [1, 0, 0]), arch(0, 0, 20, 32), -5, 'cut', 'stone');
for (const [side, nx] of [['Right', 1], ['Left', -1]] as const) {
  // Side walls: x = ±50, looking out; their x axis runs along the nave.
  const pl = plane([nx * (WIDTH / 2), 0, 0], [nx, 0, 0], [0, nx, 0]);
  sketchExtrude(`${side} windows`, pl, [-10, 35, 80].flatMap(y => arch(nx * y, 30, 14, 28)), -4, 'cut', 'stone');
}
for (const [face, pl] of [
  ['front', plane([0, ty0, 0], [0, -1, 0], [1, 0, 0])],
  ['right', plane([TOWER / 2, 0, 0], [1, 0, 0], [0, 1, 0])],
  ['left', plane([-TOWER / 2, 0, 0], [-1, 0, 0], [0, -1, 0])]
] as const) {
  const across = face === 'front' ? 0 : face === 'right' ? tc : -tc;
  sketchExtrude(`Belfry ${face}`, pl, arch(across, 132, 16, 20), -6, 'cut', 'stone');
}
sketchExtrude('Round window', plane([0, y1, 0], [0, 1, 0], [-1, 0, 0]), [circle(0, 110, 11)], -4, 'cut', 'stone');

const t0 = Date.now();
const result: any = await regenerate(feats);
const ms = Date.now() - t0;
check('every step builds', !result.errors.length, result.errors.map((e: any) => `${feats.find(feature => feature.id === e.featureId)?.name ?? e.featureId}: ${e.message}`).join('; '));
const stone = debugBodies().get('stone');
const roof = debugBodies().get('roof');
check('two clean solids: the stone and the roof', result.bodies.length === 2 && !!stone && !!roof && isHealthy(healthOf(stone)) && isHealthy(healthOf(roof)), `${result.bodies.length} bodies, ${ms} ms`);
if (stone && roof) {
  const bb = [stone, roof].map(shape => shape.boundingBox.bounds);
  const lo = [0, 1, 2].map(axis => Math.min(...bb.map(b => b[0][axis])));
  const hi = [0, 1, 2].map(axis => Math.max(...bb.map(b => b[1][axis])));
  const size = [0, 1, 2].map(axis => hi[axis] - lo[axis]);
  check('inside 250 × 250 × 250, standing on the ground, 250 to the top of the cross', size.every(size => size <= 250 + 1e-6) && Math.abs(lo[2]) < 1e-6 && Math.abs(hi[2] - 250) < 1e-6, size.map(size => size.toFixed(1)).join(' × '));
  // Solid stone before the openings: nave + gable + the tower's part outside the nave.
  const solid = WIDTH * LENGTH * WALL + (WIDTH * GABLE / 2) * LENGTH + TOWER * (ty1 - ty0) * TH - TOWER * (ty1 - y0) * WALL - TOWER * (ty1 - y0) * (GABLE - TOWER / 4) * 0; // (tower inside the gable: counted below)
  const vs = Math.abs(measureVolume(stone));
  check('the openings are cut (less stone than without them)', vs < solid, `${(vs / 1000).toFixed(0)} cm³ of stone`);
  check('the roof, spire and cross are one piece', Math.abs(measureVolume(roof)) > 0, `${(Math.abs(measureVolume(roof)) / 1000).toFixed(0)} cm³`);
  const vr = Math.abs(measureVolume(roof));
  check('the stone and the roof only touch (no overlap)', Math.abs(measureVolume((stone as any).intersect(roof))) < 1, `${Math.abs(measureVolume((stone as any).intersect(roof))).toFixed(2)} mm³ shared, roof ${(vr / 1000).toFixed(0)} cm³`);
}
// Exactly the openings taken away: the same church without them, compared.
{
  const cuts = new Set(feats.filter(feature => feature.type === 'extrude' && feature.mode === 'cut' && feature.target === 'stone').map(feature => feature.id));
  const r0: any = await regenerate(feats.filter(feature => !cuts.has(feature.id)));
  const before = Math.abs(measureVolume(debugBodies().get('stone')!));
  await regenerate(feats);
  const after = Math.abs(measureVolume(debugBodies().get('stone')!));
  const archArea = (width: number, height: number) => width * height + (Math.PI * (width / 2) ** 2) / 2;
  const want = archArea(20, 32) * 5 + 6 * archArea(14, 28) * 4 + 3 * archArea(16, 20) * 6 + Math.PI * 11 ** 2 * 4;
  check('exactly the openings taken away (door, 6 windows, 3 belfry arches, round window)', !r0.errors.length && Math.abs(before - after - want) < want * 1e-3, `${(before - after).toFixed(1)} mm³, want ${want.toFixed(1)}`);
}

// Add / Cut with no body named act on what they run into (drawn on the floor,
// a beginner picks Add: the nave joined the tower, not a second body beside it).
{
  const es = [rect(0, 0, 100, 150), rect(0, -75, 50, 50)];
  const regs = arrangement(es as any).regions;
  // The tower: the part in front and the overlap (inside y < −50); the nave: the rest.
  const tower = regs.filter(region => pointInRegion(region)[1] < -50);
  const nave = regs.filter(region => pointInRegion(region)[1] >= -50);
  const f2: any[] = [
    { id: 'sk', name: 'Floor', type: 'sketch', plane: XY(), entities: es },
    { id: 't', name: 'Tower', type: 'extrude', source: { kind: 'profile', sketch: 'sk', regions: tower.map(regionRef) }, distance: 170, mode: 'auto' },
    { id: 'n', name: 'Nave', type: 'extrude', source: { kind: 'profile', sketch: 'sk', regions: nave.map(regionRef) }, distance: 90, mode: 'join' }
  ];
  const rj: any = await regenerate(f2);
  const one = debugBodies().get('t');
  check('Add with no body named joins the body it touches (one body: tower and nave)', !rj.errors.length && rj.bodies.length === 1 && !!one && Math.abs(Math.abs(measureVolume(one)) - (50 * 50 * 170 + (100 * 150 - 50 * 25) * 90)) < 1, `${rj.bodies.length} bodies`);
  f2.push({ id: 'sk2', name: 'Hole', type: 'sketch', plane: XY(), entities: [rect(30, 30, 10, 10)] }, { id: 'h', name: 'Hole', type: 'extrude', source: { kind: 'profile', sketch: 'sk2', regions: arrangement([rect(30, 30, 10, 10)] as any).regions.map(regionRef) }, distance: 50, mode: 'cut' });
  const rc: any = await regenerate(f2);
  check('Cut with no body named cuts what it runs into', !rc.errors.length && rc.bodies.length === 1 && Math.abs(Math.abs(measureVolume(debugBodies().get('t')!)) - (50 * 50 * 170 + (100 * 150 - 50 * 25) * 90 - 10 * 10 * 50)) < 1, `${rc.bodies.length} bodies`);
}

// "All shapes" on a sketch drawn on a wall: the windows (not the wall with
// window-shaped holes), and a letter's hole stays a hole.
{
  const outline = [rect(0, 45, 150, 90)];
  const windows = [-35, 10, 55].flatMap(y => arch(y, 30, 14, 28));
  const all = arrangement([...outline, ...windows] as any);
  const got = drawnRegions(all, arrangement(windows as any));
  const area = got.reduce((total, region) => total + region.area, 0);
  const want = 3 * (14 * 28 + (Math.PI * 7 ** 2) / 2);
  check('All shapes on a wall: the three windows, not the wall around them', Math.abs(area - want) < want * 2e-3, `${area.toFixed(1)} mm², want ${want.toFixed(1)}`);
  const ring = [circle(0, 45, 10), circle(0, 45, 6)];
  const regions = drawnRegions(arrangement([...outline, ...ring] as any), arrangement(ring as any));
  const oa = regions.reduce((total, region) => total + region.area, 0);
  check('  …and an O drawn there keeps its hole', Math.abs(oa - Math.PI * (100 - 36)) < 2, `${oa.toFixed(1)} mm²`);
}

// Extrude with Taper: a spire straight up from a square, to (nearly) a point -
// a frustum's volume, h/3·(A + a + √(A·a)).
{
  const sq = [rect(0, 0, 50, 50)];
  const regs = arrangement(sq as any).regions.map(regionRef);
  const base: any[] = [{ id: 'sq', name: 'Square', type: 'sketch', plane: XY(170), entities: sq }];
  for (const taper of [0.02, 0.5, 1.5]) {
    const rt: any = await regenerate([...base, { id: 'sp', name: 'Spire', type: 'extrude', source: { kind: 'profile', sketch: 'sq', regions: regs }, distance: 68, mode: 'new', taper: taper }]);
    const sp = debugBodies().get('sp');
    const BASE_AREA = 2500, a = 2500 * taper * taper;
    const want = (68 / 3) * (BASE_AREA + a + Math.sqrt(BASE_AREA * a));
    const volume = sp ? Math.abs(measureVolume(sp)) : 0;
    const top = sp ? sp.boundingBox.bounds[1][2] : 0;
    check(`Extrude with Taper ${taper}: a clean solid of the right volume, 68 high`, !rt.errors.length && !!sp && isHealthy(healthOf(sp)) && Math.abs(volume - want) < want * 1e-6 && Math.abs(top - 238) < 1e-6, `${volume.toFixed(1)} mm³, want ${want.toFixed(1)}`);
    // Its sloped sides are flat faces (planes), so Sketch / Move Face work on them.
    const kinds = sp ? sp.faces.map((face: any) => face.geomType) : [];
    check(`Extrude with Taper ${taper}: 6 flat faces`, kinds.length === 6 && kinds.every((t: string) => t === 'PLANE'), kinds.join(','));
  }
  // From a face (the tower's top), as a beginner would: select it, Extrude, Taper.
  const tw: any[] = [{ id: 'tsk', name: 'Tower', type: 'sketch', plane: XY(), entities: sq }, { id: 'tower', name: 'Tower', type: 'extrude', source: { kind: 'profile', sketch: 'tsk', regions: regs }, distance: 170, mode: 'new' }];
  await regenerate(tw);
  const topFace = (debugBodies().get('tower') as any).faces.find((face: any) => face.normalAt().z > 0.99);
  const center = topFace.center.toTuple();
  const ref = { body: 'tower', center: center, normal: [0, 0, 1], area: 2500 };
  const rf: any = await regenerate([...tw, { id: 'sp2', name: 'Spire', type: 'extrude', source: { kind: 'face', face: ref }, distance: 68, mode: 'new', taper: 0.02 }]);
  check("Taper from a face (the tower's top): a separate pointed spire", !rf.errors.length && rf.bodies.length === 2 && Math.abs(debugBodies().get('sp2')!.boundingBox.bounds[1][2] - 238) < 1e-6, rf.errors.map((e: any) => e.message).join('; '));
  const holed = [rect(0, 0, 50, 50), rect(0, 0, 10, 10)];
  const ring = arrangement(holed as any).regions.filter(region => region.area > 200).map(regionRef);
  const rh: any = await regenerate([{ id: 'hs', name: 'Holed', type: 'sketch', plane: XY(), entities: holed }, { id: 'hx', name: 'Holed', type: 'extrude', source: { kind: 'profile', sketch: 'hs', regions: ring }, distance: 20, mode: 'new', taper: 0.5 }]);
  check('Taper on a shape with a hole: a clear message', rh.errors.some((e: any) => /without holes/.test(e.message)), rh.errors.map((e: any) => e.message).join('; '));
}

// The same church built by hand on a phone-sized screen, as a beginner would
// (tests/fixtures/church-hand.json): one floor sketch (the nave 100 × 150 and
// the tower 50 × 50 on its front edge), tower 170, nave 90 (Add); a triangle
// on the back wall → gable; each roof slope Extrude 6 as a New body; the
// tower's top Extrude 68 with Taper to a point; arches (a rectangle and a
// circle) on the walls → All shapes → Cut; a round window; a cross drawn on
// the tower front, extruded and moved back onto the spire.
{
  const { readFileSync } = await import('node:fs');
  const hand = JSON.parse(readFileSync(new URL('./fixtures/church-hand.json', import.meta.url), 'utf8'));
  const rh: any = await regenerate(hand);
  check('by hand: every step builds', !rh.errors.length, rh.errors.map((e: any) => `${hand.find((feature: any) => feature.id === e.featureId)?.name}: ${e.message}`).join('; '));
  const hs = rh.bodies.map((b: any) => debugBodies().get(b.id)!);
  check('by hand: five clean solids (stone, two roof slopes, spire, cross)', hs.length === 5 && hs.every((shape: any) => isHealthy(healthOf(shape))), `${hs.length} bodies`);
  const bb = hs.map((shape: any) => shape.boundingBox.bounds);
  const lo = [0, 1, 2].map(axis => Math.min(...bb.map((b: any) => b[0][axis])));
  const hi = [0, 1, 2].map(axis => Math.max(...bb.map((b: any) => b[1][axis])));
  const size = [0, 1, 2].map(axis => hi[axis] - lo[axis]);
  check('by hand: inside 250 × 250 × 250, on the ground', size.every(x => x <= 250 + 1e-6) && Math.abs(lo[2]) < 1e-6, size.map(x => x.toFixed(1)).join(' × '));
  // Every opening cut, and only the openings: the stone without the cuts, compared.
  const cuts = new Set(hand.filter((feature: any) => feature.type === 'extrude' && feature.mode === 'cut').map((feature: any) => feature.id));
  await regenerate(hand.filter((feature: any) => !cuts.has(feature.id)));
  const before = Math.abs(measureVolume(debugBodies().get('extrude-mw5j163h-sfkc')!));
  await regenerate(hand);
  const after = Math.abs(measureVolume(debugBodies().get('extrude-mw5j163h-sfkc')!));
  const archArea = (width: number, height: number) => width * height + (Math.PI * (width / 2) ** 2) / 2;
  const want = archArea(20, 32) * 5 + 6 * archArea(14, 28) * 4 + 3 * archArea(16, 20) * 6 + Math.PI * 11 ** 2 * 4;
  check('by hand: exactly the openings cut - door, 6 windows, 3 belfry arches, round window', Math.abs(before - after - want) < want * 2e-3, `${(before - after).toFixed(1)} mm³, want ${want.toFixed(1)} (by code the same)`);
}

if (process.argv[2]) {
  writeFileSync(process.argv[2], JSON.stringify({ format: 'super', version: 2, name: 'Church', features: feats, variables: [], views: [], units: 'mm', hidden: feats.filter(feature => feature.type === 'sketch').map(feature => feature.id), pins: [], names: { stone: 'Stone', roof: 'Roof' }, colors: { stone: '#d9cfbf', roof: '#7a4a3a' } }));
}
process.exit(failed ? 1 : 0);
