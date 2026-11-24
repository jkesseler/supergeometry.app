// Run: npx tsx tests/planetary.test.ts - a print-in-place planetary gearbox,
// built the way a person would, to push the engine on tolerances between
// moving parts:
//   - a housing with an internal ring gear (48 teeth cut into it: involute
//     tooth spaces, 240 curves), a floor with the sun shaft's bore, threaded
//     M3 holes for the lid's screws, its foot rounded;
//   - a sun gear (12 teeth) on a shaft with a flat, three planets (18 teeth,
//     patterned round) on the carrier's pins, a carrier with an output shaft
//     and a hex socket, a lid screwed on with chamfered holes;
//   - checked: every gear's involute fills what it should, every pair of
//     parts that must move apart sits clear by at least the print gap (and the
//     meshes by their backlash, no more), the lid sits on the housing without
//     running into it, and turned as the gearbox runs (sun, carrier and planets
//     each by their own ratio), the gears still don't touch;
//   - then every gear made again herringbone (two twisted sweeps meeting in
//     the middle, the ring's spaces cut the same way) and checked again, and a
//     print-in-place ball bearing (revolved races with grooves, ten balls)
//     pressed into the lid: 0.05 into it all round, the balls 0.2 clear.
// Module 1.5, 20° pressure angle; the box's axis is z, the floor at z = 0.
import { getOC, type Shape3D } from 'replicad';
import { measureVolume } from '../src/kernel/ocFree';
import { arrangement, regionRef } from '../src/sketch/regions';
import { faceRef, edgeRefs } from './grid';
import { check, done, sketch, XY, after, bodies, health, circle, rect } from './kit';
import type { Feature, SketchEntity, Vec3 } from '../src/doc/types';

type P2 = [number, number];
const fs: Feature[] = [];
const sk = (id: string, plane: ReturnType<typeof XY>, es: SketchEntity[]) => {
  fs.push(sketch(id, plane, es));

  return es;
};

/** Rebuild; each body's health; the errors. */
async function stage(name: string) {
  const t = Date.now();
  const { errors } = await after(fs);
  const ms = Date.now() - t;
  const info: Record<string, { v: number; ok: boolean; solids: number; faces: number }> = {};
  for (const [id, body] of bodies()) {
    const bodyHealth = health(body);
    info[id] = { v: Math.round(bodyHealth.volume * 10) / 10, ok: bodyHealth.valid && !bodyHealth.openEdges && !bodyHealth.thin, solids: bodyHealth.solids, faces: bodyHealth.faces };
  }
  const bad = Object.entries(info).filter(([, i]) => !i.ok || i.solids !== 1);
  check(`${name}: builds`, !errors.length, errors.join('; '));
  check(`${name}: sound bodies`, !bad.length, bad);
  console.log(`      ${ms} ms`, JSON.stringify(info));

  return info;
}

const bodyShape = (id: string) => bodies().get(id) as Shape3D;
const oc = getOC();
/** The least distance between two bodies (0 when they touch or overlap). */
const gap = (a: Shape3D, b: Shape3D) => {
  const measure = new oc.BRepExtrema_DistShapeShape(a.wrapped, b.wrapped);
  try {
    return measure.IsDone() ? measure.Value() : -1;
  } finally {
    measure.delete();
  }
};
/** How much two bodies share (0: apart or only touching). */
const overlap = (a: Shape3D, b: Shape3D) => {
  try {
    return Math.abs(measureVolume(a.clone().intersect(b.clone()) as Shape3D));
  } catch {
    return -1;
  }
};

// ------------------------------------------------------------------ gears

const rad = (degrees: number) => (degrees * Math.PI) / 180;
const MODULE = 1.5, PA = rad(20), BACKLASH = 0.15;
const ZS = 12, ZP = 18, ZR = 48;
const RS = (MODULE * ZS) / 2, RP = (MODULE * ZP) / 2, RR = (MODULE * ZR) / 2; // 9, 13.5, 36
const CD = RS + RP; // 22.5, and RR - RP too
const inv = (a: number) => Math.tan(a) - a;
const GAP = 0.25; // the print gap: parts that move must stay this far apart
const Z0 = 3.5, Z1 = 21.5; // the gears' faces (the floor's top is at 3)

/**
 * An outline of z involute pieces round c: for an external gear its teeth, for
 * an internal gear its tooth spaces (the same shape: a space between a ring's
 * teeth is an external tooth's twin). Each piece: a radial line below the base
 * circle, a flank (a spline), the outer arc, the other flank, back down, and
 * the inner arc to the next piece.
 */
function involutes(pre: string, z: number, center: P2, turn: number, inner: number, outer: number, half: number) {
  const rp = (MODULE * z) / 2, rb = rp * Math.cos(PA);
  const phi = (radius: number) => half + inv(PA) - inv(Math.acos(Math.min(1, rb / radius)));
  const at = (radius: number, a: number): P2 => [center[0] + radius * Math.cos(a + turn), center[1] + radius * Math.sin(a + turn)];
  const r0 = Math.max(rb, inner);
  const flank = (mid: number, side: number) => Array.from({ length: 9 }, (_, i) => r0 + ((outer - r0) * i) / 8).map(radius => at(radius, mid + side * phi(radius)));
  const es: SketchEntity[] = [];
  for (let tooth = 0; tooth < z; tooth++) {
    const middle = (2 * Math.PI * tooth) / z;
    const right = flank(middle, -1), left = flank(middle, 1).reverse();
    if (inner < rb) {
      es.push({ id: `${pre}${tooth}a`, kind: 'line', a: at(inner, middle - phi(rb)), b: right[0] } as SketchEntity);
    }
    es.push({ id: `${pre}${tooth}b`, kind: 'spline', closed: false, mode: 'fit', points: right } as SketchEntity);
    es.push({ id: `${pre}${tooth}c`, kind: 'arc', a: right[8], m: at(outer, middle), b: left[0] } as SketchEntity);
    es.push({ id: `${pre}${tooth}d`, kind: 'spline', closed: false, mode: 'fit', points: left } as SketchEntity);
    if (inner < rb) {
      es.push({ id: `${pre}${tooth}e`, kind: 'line', a: left[8], b: at(inner, middle + phi(rb)) } as SketchEntity);
    }
    const next = (2 * Math.PI * (tooth + 1)) / z;
    es.push({ id: `${pre}${tooth}f`, kind: 'arc', a: at(inner, middle + phi(Math.max(rb, inner))), m: at(inner, (middle + next) / 2), b: at(inner, next - phi(Math.max(rb, inner))) } as SketchEntity);
  }

  return es;
}
/** The area such an outline holds, integrated finely. */
function involuteArea(z: number, inner: number, outer: number, half: number) {
  const rp = (MODULE * z) / 2, rb = rp * Math.cos(PA);
  const phi = (radius: number) => half + inv(PA) - inv(Math.acos(Math.min(1, rb / radius)));
  let a = Math.PI * inner * inner;
  const samples = 20000;
  for (let i = 0; i < samples; i++) {
    const radius = inner + ((outer - inner) * (i + 0.5)) / samples;
    a += z * 2 * phi(Math.max(radius, rb)) * radius * ((outer - inner) / samples);
  }

  return a;
}
// Each external tooth is thinner by half the backlash, each ring space wider.
const toothHalf = (z: number) => Math.PI / (2 * z) - BACKLASH / 4 / ((MODULE * z) / 2);
const spaceHalf = (z: number) => Math.PI / (2 * z) + BACKLASH / 4 / ((MODULE * z) / 2);
const ext = (z: number) => ({ inner: (MODULE * z) / 2 - 1.25 * MODULE, outer: (MODULE * z) / 2 + MODULE, half: toothHalf(z) });
// The ring's teeth reach in to RR - MODULE; its spaces go out to RR + 1.25 MODULE.
const ring = { inner: RR - MODULE, outer: RR + 1.25 * MODULE, half: spaceHalf(ZR) };

const all = (es: SketchEntity[], keep = (_: any) => true) => ({ kind: 'profile' as const, sketch: '', regions: arrangement(es).regions.filter(keep).map(regionRef) });
const src = (id: string, es: SketchEntity[], keep?: (r: any) => boolean) => ({ ...all(es, keep), sketch: id });
const tAt = (t0: number) => Date.now() - t0;

// --- 1. Housing: a round case, its ring gear's spaces cut into it.
const HR = 44, HTOP = 22;
sk('sCase', XY(0), [circle('case', 0, 0, HR)]);
fs.push({ id: 'housing', name: 'Housing', type: 'extrude', source: src('sCase', [circle('case', 0, 0, HR)]), distance: HTOP, mode: 'new' } as Feature);
// Planet at angle 0 shows a tooth outward (see below): the ring a space there... a tooth, so its spaces sit half a pitch round.
const ringEs = sk('sRing', XY(3), involutes('r', ZR, [0, 0], Math.PI / ZR, ring.inner, ring.outer, ring.half));
let t0 = Date.now();
fs.push({ id: 'ringCut', name: 'Ring gear', type: 'extrude', source: src('sRing', ringEs), distance: HTOP - 3, mode: 'cut', target: 'housing' } as Feature);
const s1 = await stage('housing with its ring gear cut');
console.log(`      (${ringEs.length} curves, ${tAt(t0)} ms)`);
check("the ring's outline is one shape", all(ringEs).regions.length === 1, all(ringEs).regions.length);
{
  const want = (Math.PI * HR * HR * HTOP) - involuteArea(ZR, ring.inner, ring.outer, ring.half) * (HTOP - 3);
  check('the housing holds what a 48-tooth ring in a case should (1e-4)', Math.abs(s1.housing.v - want) < want * 1e-4, [s1.housing.v, want]);
}

// The sun's shaft bore through the floor, 0.3 round the 8 mm shaft.
const bore = sk('sBore', XY(0), [circle('hb', 0, 0, 4.3)]);
fs.push({ id: 'boreCut', name: 'Shaft bore', type: 'extrude', source: src('sBore', bore), distance: 3, mode: 'cut', target: 'housing' } as Feature);
// Four holes for the lid's screws, 2.5 (to be threaded M3 x 0.5), 10 deep.
const holes: P2[] = [0, 1, 2, 3].map(index => [40 * Math.cos(rad(45 + 90 * index)), 40 * Math.sin(rad(45 + 90 * index))]);
const screwEs = sk('sScrew', XY(HTOP), holes.map((hole, holeIndex) => circle(`sh${holeIndex}`, hole[0], hole[1], 1.25)));
fs.push({ id: 'screwHoles', name: 'Screw holes', type: 'extrude', source: src('sScrew', screwEs), distance: -10, mode: 'cut', target: 'housing' } as Feature);
await stage('bore and screw holes');
for (let holeIndex = 0; holeIndex < 4; holeIndex++) {
  const [x, y] = holes[holeIndex];
  const face = faceRef('housing', (normal, center, face) => face.geomType === 'CYLINDRE' && Math.hypot(center[0] - x, center[1] - y) < 1.3 && center[2] > HTOP - 10.01 && Math.abs(normal[2]) < 1e-6);
  fs.push({ id: `thread${holeIndex}`, name: `Thread M3 ${holeIndex + 1}`, type: 'thread', face, pitch: 0.5, round: { r: 1.25, hole: true } } as Feature);
}
t0 = Date.now();
const s2 = await stage('four holes threaded M3');
check('the threads in under 60 s', tAt(t0) < 60000, tAt(t0));
// The foot rounded, 2.
fs.push({ id: 'footRound', name: 'Round the foot', type: 'fillet', edges: edgeRefs('housing', midpoint => Math.abs(midpoint[2]) < 1e-6 && Math.hypot(midpoint[0], midpoint[1]) > HR - 1), radius: 2 } as Feature);
const s3 = await stage('housing foot rounded');
check('the round took a little away', s3.housing.v < s2.housing.v && s3.housing.v > s2.housing.v - 2 * Math.PI * HR * 2, [s2.housing.v, s3.housing.v]);

// --- 2. Sun gear, 12 teeth, on an 8 mm shaft down through the floor with a flat.
const e = ext(ZS);
const sunEs = sk('sSun', XY(Z0), involutes('s', ZS, [0, 0], 0, e.inner, e.outer, e.half));
fs.push({ id: 'sun', name: 'Sun gear', type: 'extrude', source: src('sSun', sunEs), distance: Z1 - Z0, mode: 'new' } as Feature);
const shaft = sk('sShaft', XY(Z0), [circle('sh', 0, 0, 4)]);
fs.push({ id: 'shaft', name: 'Sun shaft', type: 'extrude', source: src('sShaft', shaft), distance: -(Z0 + 6), mode: 'join', target: 'sun' } as Feature);
const flat = sk('sFlat', XY(-6), [rect('fl', 3, -5, 5, 5)]);
fs.push({ id: 'flat', name: 'Shaft flat', type: 'extrude', source: src('sFlat', flat), distance: 7, mode: 'cut', target: 'sun' } as Feature);
const s4 = await stage('sun gear on its shaft');
{
  const want = involuteArea(ZS, e.inner, e.outer, e.half) * (Z1 - Z0) + Math.PI * 16 * (Z0 + 6) - 7 * (16 * Math.acos(3 / 4) - 3 * Math.sqrt(7));
  check('the sun holds what a 12-tooth involute and its shaft should (1e-4)', Math.abs(s4.sun.v - want) < want * 1e-4, [s4.sun.v, want]);
}

// --- 3. Planets, 18 teeth, round the sun at 22.5, on 6.5 bores (pins 6).
// The planet at angle 0 must show the sun a space (its teeth at 0 and 180°
// otherwise): turned half a tooth - and the ring then a tooth outward.
const planetSizes = ext(ZP);
const planetEs = sk('sPlanet', XY(Z0), [...involutes('p', ZP, [CD, 0], Math.PI / ZP, planetSizes.inner, planetSizes.outer, planetSizes.half), circle('pb', CD, 0, 3.25)]);
fs.push({ id: 'planet', name: 'Planet', type: 'extrude', source: src('sPlanet', planetEs, region => region.area > Math.PI * 3.25 * 3.25 + 1), distance: Z1 - Z0, mode: 'new' } as Feature);
fs.push({ id: 'planets', name: 'Planets', type: 'transform', bodies: ['planet'], copy: true, op: { kind: 'circular', axis: { origin: [0, 0, 0], dir: [0, 0, 1] }, count: 3, angle: 360 } } as Feature);
const s5 = await stage('three planets patterned round');
const planetIds = [...bodies().keys()].filter(key => key.startsWith('planet'));
check('three planets', planetIds.length === 3, planetIds);
{
  const want = (involuteArea(ZP, planetSizes.inner, planetSizes.outer, planetSizes.half) - Math.PI * 3.25 * 3.25) * (Z1 - Z0);
  check('each planet holds what an 18-tooth involute with its bore should (1e-4)', planetIds.every(id => Math.abs(s5[id].v - want) < want * 1e-4), [planetIds.map(id => s5[id].v), want]);
}

// --- 4. Carrier: a plate above the gears, three pins down into the planets,
// an output shaft up with a hex socket.
const CZ = Z1 + 0.5, CT = 3;
const plate = sk('sCarrier', XY(CZ), [circle('cp', 0, 0, 31)]);
fs.push({ id: 'carrier', name: 'Carrier', type: 'extrude', source: src('sCarrier', plate), distance: CT, mode: 'new' } as Feature);
const pinAt: P2[] = [0, 1, 2].map(index => [CD * Math.cos(rad(120 * index)), CD * Math.sin(rad(120 * index))]);
const pins = sk('sPins', XY(CZ), pinAt.map((q, index) => circle(`pin${index}`, q[0], q[1], 3)));
fs.push({ id: 'pins', name: 'Pins', type: 'extrude', source: src('sPins', pins), distance: -(CZ - 4), mode: 'join', target: 'carrier' } as Feature);
const out = sk('sOut', XY(CZ + CT), [circle('os', 0, 0, 5)]);
fs.push({ id: 'outShaft', name: 'Output shaft', type: 'extrude', source: src('sOut', out), distance: 15, mode: 'join', target: 'carrier' } as Feature);
const hex = sk('sHex', XY(CZ + CT + 15), [{ id: 'hx', kind: 'polyline', closed: true, points: Array.from({ length: 6 }, (_, index) => [(5 / Math.sqrt(3)) * Math.cos(rad(60 * index)), (5 / Math.sqrt(3)) * Math.sin(rad(60 * index))]) } as SketchEntity]);
fs.push({ id: 'hexCut', name: 'Hex socket', type: 'extrude', source: src('sHex', hex), distance: -6, mode: 'cut', target: 'carrier' } as Feature);
const s6 = await stage('carrier with pins, shaft and socket');
{
  const want = Math.PI * 31 * 31 * CT + 3 * Math.PI * 9 * (CZ - 4) + Math.PI * 25 * 15 - ((3 * Math.sqrt(3)) / 2) * (5 / Math.sqrt(3)) ** 2 * 6;
  check('the carrier holds what it should (1e-6)', Math.abs(measureVolume(bodyShape('carrier')) - want) < want * 1e-6, [measureVolume(bodyShape('carrier')), want, s6.carrier.v]);
}

// --- 5. Lid: a cap on the housing, room inside for the carrier, a hole for
// the output shaft, four chamfered screw holes; its top edge rounded.
const LT = 33; // (thick enough on top for the bearing's pocket)
const lidEs = sk('sLid', XY(HTOP), [circle('lo', 0, 0, HR)]);
fs.push({ id: 'lid', name: 'Lid', type: 'extrude', source: src('sLid', lidEs), distance: LT - HTOP, mode: 'new' } as Feature);
const room = sk('sRoom', XY(HTOP), [circle('lr', 0, 0, 32)]);
fs.push({ id: 'room', name: 'Room for the carrier', type: 'extrude', source: src('sRoom', room), distance: CZ + CT + 0.5 - HTOP, mode: 'cut', target: 'lid' } as Feature);
const lh = sk('sLidHoles', XY(LT), [circle('ls', 0, 0, 5.4), ...holes.map((q, holeIndex) => circle(`lh${holeIndex}`, q[0], q[1], 1.7))]);
fs.push({ id: 'lidHoles', name: 'Lid holes', type: 'extrude', source: src('sLidHoles', lh), distance: -(LT - HTOP), mode: 'cut', target: 'lid' } as Feature);
await stage('lid with its holes');
fs.push({ id: 'lidTop', name: 'Round the lid', type: 'fillet', edges: edgeRefs('lid', midpoint => Math.abs(midpoint[2] - LT) < 1e-6 && Math.hypot(midpoint[0], midpoint[1]) > HR - 1), radius: 2 } as Feature);
fs.push({ id: 'csk', name: 'Screw chamfers', type: 'chamfer', edges: edgeRefs('lid', midpoint => Math.abs(midpoint[2] - LT) < 1e-6 && holes.some(q => Math.abs(Math.hypot(midpoint[0] - q[0], midpoint[1] - q[1]) - 1.7) < 1e-3)), radius: 0.6 } as Feature);
const s7 = await stage('lid rounded and its holes chamfered');
check("the lid's chamfers took a little", s7.lid.v > 0, s7.lid.v);

// ------------------------------------------------------------------ fits

const MOVING: [string, string][] = [];
const ids = () => [...bodies().keys()];
function fits(label: string, gearsOnly = false) {
  const t = Date.now();
  try {
    fitsNow(label, gearsOnly);
  } finally {
    console.log(`      ${label}: fits ${Date.now() - t} ms`);
  }
}
function fitsNow(label: string, gearsOnly: boolean) {
  const planets = ids().filter(id => id.startsWith('planet'));
  const all: [string, string, number][] = [
    ['sun', 'housing', GAP],
    ['sun', 'carrier', GAP],
    ['carrier', 'housing', GAP],
    ['carrier', 'lid', GAP],
    ['sun', 'lid', GAP],
    ...planets.flatMap(q => [[q, 'carrier', GAP], [q, 'lid', GAP]] as [string, string, number][]),
    ...planets.flatMap((q, i) => planets.slice(i + 1).map(other => [q, other, GAP] as [string, string, number])),
    // Meshing gears: their backlash, no print gap.
    ...planets.flatMap(q => [[q, 'sun', 0.02], [q, 'housing', 0.02]] as [string, string, number][])
  ];
  // (Only the teeth changed: their pairs alone. A gap between twisted gears
  // takes the measurer some 20 s each, twenty times a straight gear's.)
  const gears = new Set(['sun', 'housing', ...planets]);
  const pairs = gearsOnly ? all.filter(([a, b]) => gears.has(a) && gears.has(b)) : all;
  const seen = new Map<string, number>();
  for (const [a, b, least] of pairs) {
    const clearance = gap(bodyShape(a), bodyShape(b));
    seen.set(`${a}|${b}`, clearance);
    check(`${label}: ${a} and ${b} clear by ${least}`, clearance >= least - 1e-6, clearance.toFixed(4));
  }
  // The meshes no looser than their backlash allows.
  for (const q of planets) {
    for (const other of ['sun', 'housing']) {
      const clearance = seen.get(`${q}|${other}`) ?? gap(bodyShape(q), bodyShape(other));
      check(`${label}: ${q} meshes with ${other} (gap under 0.15)`, clearance < 0.15, clearance.toFixed(4));
    }
  }
}

t0 = Date.now();
fits('assembled');
console.log(`      fits ${tAt(t0)} ms`);
// The lid sits on the housing (touching, not running in) and its screw holes
// clear the M3 threads.
check('the lid sits on the housing', gap(bodyShape('lid'), bodyShape('housing')) < 1e-6 && overlap(bodyShape('lid'), bodyShape('housing')) < 1e-6, [gap(bodyShape('lid'), bodyShape('housing')), overlap(bodyShape('lid'), bodyShape('housing'))]);
check('nothing else overlaps the housing', ['sun', 'carrier', ...ids().filter(id => id.startsWith('planet'))].every(key => overlap(bodyShape(key), bodyShape('housing')) < 1e-9));

// --- 6. Turned as it runs: the ring stays, the sun turns a, the carrier
// a·12/60, each planet about its pin by -(5/3) of the carrier's turn (on top
// of being carried round).
async function turning(what: string, angles = [7, 23, 41], gearsOnly = false) {
  for (const a of angles) {
    const turned = fs.length;
    const carrierAngle = (a * ZS) / (ZS + ZR);
    fs.push({ id: `turnSun${a}`, name: 'Turn sun', type: 'transform', bodies: ['sun'], copy: false, op: { kind: 'move', translate: [0, 0, 0], rotate: { origin: [0, 0, 0], axis: [0, 0, 1], angle: a } } } as Feature);
    fs.push({ id: `turnCarrier${a}`, name: 'Turn carrier', type: 'transform', bodies: ['carrier'], copy: false, op: { kind: 'move', translate: [0, 0, 0], rotate: { origin: [0, 0, 0], axis: [0, 0, 1], angle: carrierAngle } } } as Feature);
    ids().filter(id => id.startsWith('planet')).forEach((q, i) => {
      const at = pinAt[i] as P2;
      // (which pin: by where the planet is now)
      const box = bodyShape(q).boundingBox.center;
      const pin = pinAt.reduce((best, pin) => (Math.hypot(pin[0] - box[0], pin[1] - box[1]) < Math.hypot(best[0] - box[0], best[1] - box[1]) ? pin : best), at);
      fs.push({ id: `spin${a}_${i}`, name: 'Spin planet', type: 'transform', bodies: [q], copy: false, op: { kind: 'move', translate: [0, 0, 0], rotate: { origin: [pin[0], pin[1], 0], axis: [0, 0, 1], angle: -(ZR / ZP) * carrierAngle } } } as Feature);
      fs.push({ id: `orbit${a}_${i}`, name: 'Carry planet', type: 'transform', bodies: [q], copy: false, op: { kind: 'move', translate: [0, 0, 0], rotate: { origin: [0, 0, 0], axis: [0, 0, 1], angle: carrierAngle } } } as Feature);
    });
    await stage(`${what} turned: sun ${a}°`);
    fits(`${what}, sun at ${a}°`, gearsOnly);
    fs.splice(turned);
  }
}
await turning('straight');
void MOVING;
void ([] as Vec3[]);

// --- 7. Herringbone: every gear made again as two twisted sweeps meeting
// in the middle (a 20° helix at the pitch circles), the ring's spaces cut
// into the housing the same way. Each gear's twist is its share of the same
// slide along the pitch circles: the sun's one way, the planets' and the
// ring's the other.
const HELIX = rad(20), ZM = (Z0 + Z1) / 2;
const deg = (radians: number) => (radians * 180) / Math.PI;
const XZ = (y = 0) => ({ origin: [0, y, 0] as Vec3, xDir: [1, 0, 0] as Vec3, normal: [0, -1, 0] as Vec3 });
/** Replace the step `id` (an extrude of `sketchId`) by two sweeps twisting opposite ways, from z0 up to zm and on to z1, about the axis at x. */
function herringbone(id: string, name: string, sketchId: string, es: SketchEntity[], remade: (turn: number) => SketchEntity[], x: number, radius: number, z0: number, zm: number, z1: number, keep?: (r: any) => boolean) {
  const at = fs.findIndex(feature => feature.id === id);
  const old = fs[at] as any;
  const twistLo = -Math.sign(radius) * deg(((zm - z0) * Math.tan(HELIX)) / Math.abs(radius));
  const twistHi = Math.sign(radius) * deg(((z1 - zm) * Math.tan(HELIX)) / Math.abs(radius));
  const mid = remade(rad(twistLo));
  const steps: Feature[] = [
    sketch(`${id}PathLo`, XZ(0), [{ id: 'ax', kind: 'line', a: [x, z0], b: [x, zm] } as SketchEntity]),
    sketch(`${id}PathHi`, XZ(0), [{ id: 'ax', kind: 'line', a: [x, zm], b: [x, z1] } as SketchEntity]),
    sketch(`${id}Mid`, XY(zm), mid),
    { id, name: `${name} (lower)`, type: 'sweep', source: src(sketchId, es, keep), path: { kind: 'sketch', sketch: `${id}PathLo`, entities: ['ax'] }, mode: old.mode, target: old.target, twist: twistLo } as Feature,
    { id: `${id}Hi`, name: `${name} (upper)`, type: 'sweep', source: src(`${id}Mid`, mid, keep), path: { kind: 'sketch', sketch: `${id}PathHi`, entities: ['ax'] }, mode: old.mode === 'new' ? 'join' : old.mode, target: old.mode === 'new' ? id : old.target, twist: twistHi } as Feature
  ];
  fs.splice(at, 1, ...steps);
}
// (Signed radius: an external gear meshing with the sun slides the other way.)
herringbone('sun', 'Sun gear', 'sSun', sunEs, tn => involutes('s', ZS, [0, 0], tn, e.inner, e.outer, e.half), 0, RS, Z0, ZM, Z1);
herringbone('planet', 'Planet', 'sPlanet', planetEs, tn => [...involutes('p', ZP, [CD, 0], Math.PI / ZP + tn, planetSizes.inner, planetSizes.outer, planetSizes.half), circle('pb', CD, 0, 3.25)], CD, -RP, Z0, ZM, Z1, turn => turn.area > Math.PI * 3.25 * 3.25 + 1);
// The ring's spaces run past the gears (from the floor at 3 to the top at
// 22): their helix is the gears' carried on, the same twist per mm.
{
  const per = Math.tan(HELIX) / RR; // rad per mm, at the ring's pitch circle
  const at = fs.findIndex(feature => feature.id === 'ringCut');
  // (The planets' way: a ring and its planets slide the same way round.)
  const lo = deg((ZM - 3) * per), hi = -deg((HTOP - ZM) * per);
  // In step with the planets where they start (z 3.5, not the floor's 3):
  // started from the floor in their phase, the ring's teeth had slid 0.18 on
  // by then, more than the backlash, and the planets ran on them.
  const start = involutes('r', ZR, [0, 0], Math.PI / ZR - (Z0 - 3) * per, ring.inner, ring.outer, ring.half);
  const mid = involutes('r', ZR, [0, 0], Math.PI / ZR + (ZM - Z0) * per, ring.inner, ring.outer, ring.half);
  fs.splice(at, 1,
    sketch('ringStart', XY(3), start),
    sketch('ringPathLo', XZ(0), [{ id: 'ax', kind: 'line', a: [0, 3], b: [0, ZM] } as SketchEntity]),
    sketch('ringPathHi', XZ(0), [{ id: 'ax', kind: 'line', a: [0, ZM], b: [0, HTOP] } as SketchEntity]),
    sketch('ringMid', XY(ZM), mid),
    { id: 'ringCut', name: 'Ring gear (lower)', type: 'sweep', source: src('ringStart', start), path: { kind: 'sketch', sketch: 'ringPathLo', entities: ['ax'] }, mode: 'cut', target: 'housing', twist: lo } as Feature,
    { id: 'ringCutHi', name: 'Ring gear (upper)', type: 'sweep', source: src('ringMid', mid), path: { kind: 'sketch', sketch: 'ringPathHi', entities: ['ax'] }, mode: 'cut', target: 'housing', twist: hi } as Feature
  );
}
t0 = Date.now();
const h1 = await stage('herringbone gears');
check('herringbone: rebuilt in under 120 s', tAt(t0) < 120000, tAt(t0));
// Twisting doesn't change how much a gear holds.
check('herringbone: the sun holds what it did (1e-4)', Math.abs(h1.sun.v - s4.sun.v) < s4.sun.v * 1e-4, [s4.sun.v, h1.sun.v]);
check('herringbone: each planet holds what it did (1e-4)', planetIds.every(id => Math.abs(h1[id].v - s5[id].v) < s5[id].v * 1e-4), planetIds.map(id => h1[id].v));
check('herringbone: the housing holds what it did (1e-4)', Math.abs(h1.housing.v - s3.housing.v) < s3.housing.v * 1e-4, [s3.housing.v, h1.housing.v]);
fits('herringbone', true);
await turning('herringbone', [23], true);

// --- 8. A print-in-place ball bearing for the output shaft, pressed into a
// pocket in the lid's top: two races (rings revolved, a groove 0.2 round the
// balls), ten 3 mm balls patterned round. The outer race is 0.05 bigger than
// its pocket (a press fit); the inner race sits on the shaft, line to line.
const BZ = 30.5, BP = 7.75, BALL = 1.5;
const pocket = sk('sPocket', XY(LT), [circle('pk', 0, 0, 11)]);
fs.push({ id: 'pocket', name: 'Bearing pocket', type: 'extrude', source: src('sPocket', pocket), distance: -5, mode: 'cut', target: 'lid' } as Feature);
const races = sk('sRaces', XZ(0), [
  rect('ri', 5, BZ - 2, 7.25, BZ + 2),
  rect('ro', 8.25, BZ - 2, 11.05, BZ + 2),
  { id: 'groove', kind: 'circle', center: [BP, BZ], radius: BALL + 0.2 } as SketchEntity,
  { id: 'axis', kind: 'line', a: [0, 20], b: [0, 40], construction: true } as SketchEntity
]);
const zAxis = (sketchId: string, ent: string, x = 0) => ({ origin: [x, 0, 0] as Vec3, dir: [0, 0, 1] as Vec3, ref: { kind: 'sketchLine', sketch: sketchId, entity: ent } });
const raceRegions = (inner: boolean) => src('sRaces', races, (region) => {
  const [across, along] = regionRef(region).c as P2;

  return Math.hypot(across - BP, along - BZ) > BALL + 0.2 - 1e-6 && (inner ? across < BP : across > BP) && region.area > 1;
});
check('each race is one shape with its groove', raceRegions(true).regions.length === 1 && raceRegions(false).regions.length === 1, [raceRegions(true).regions.length, raceRegions(false).regions.length]);
fs.push({ id: 'innerRace', name: 'Inner race', type: 'revolve', source: raceRegions(true), axis: zAxis('sRaces', 'axis'), angle: 360, mode: 'new' } as Feature);
fs.push({ id: 'outerRace', name: 'Outer race', type: 'revolve', source: raceRegions(false), axis: zAxis('sRaces', 'axis'), angle: 360, mode: 'new' } as Feature);
const ballEs = sk('sBall', XZ(0), [
  { id: 'bArc', kind: 'arc', a: [BP, BZ - BALL], m: [BP + BALL, BZ], b: [BP, BZ + BALL] } as SketchEntity,
  { id: 'bAx', kind: 'line', a: [BP, BZ + BALL], b: [BP, BZ - BALL] } as SketchEntity
]);
fs.push({ id: 'ball', name: 'Ball', type: 'revolve', source: src('sBall', ballEs), axis: zAxis('sBall', 'bAx', BP), angle: 360, mode: 'new' } as Feature);
fs.push({ id: 'balls', name: 'Balls', type: 'transform', bodies: ['ball'], copy: true, op: { kind: 'circular', axis: { origin: [0, 0, 0], dir: [0, 0, 1] }, count: 10, angle: 360 } } as Feature);
t0 = Date.now();
await stage('ball bearing in the lid');
const ballIds = ids().filter(id => id.startsWith('ball'));
check('ten balls', ballIds.length === 10, ballIds.length);
check('each ball is a 3 mm sphere (1e-6)', ballIds.every(ballId => Math.abs(measureVolume(bodyShape(ballId)) - (4 / 3) * Math.PI * BALL ** 3) < 1e-6 * (4 / 3) * Math.PI * BALL ** 3), ballIds.map(ballId => measureVolume(bodyShape(ballId))));
{
  // The races: their rings less the groove's share (Pappus: the circle's
  // slice inside each ring, carried round at its own centroid).
  const ringVol = (r0: number, r1: number) => Math.PI * (r1 * r1 - r0 * r0) * 4;
  const vi = measureVolume(bodyShape('innerRace')), vo = measureVolume(bodyShape('outerRace'));
  check('the races hold less than their plain rings, by about a groove', vi < ringVol(5, 7.25) && vi > ringVol(5, 7.25) - 2 * Math.PI * BP * Math.PI * 1.7 ** 2 && vo < ringVol(8.25, 11.05) && vo > ringVol(8.25, 11.05) - 2 * Math.PI * BP * Math.PI * 1.7 ** 2, [vi, vo]);
}
{
  const want = Math.PI * (11.05 ** 2 - 11 ** 2) * 4;
  const got = overlap(bodyShape('outerRace'), bodyShape('lid'));
  check('the outer race is pressed in: 0.05 into the lid all round', Math.abs(got - want) < want * 0.01, [got, want]);
  check('the inner race sits on the shaft, line to line', gap(bodyShape('innerRace'), bodyShape('carrier')) < 1e-6 && overlap(bodyShape('innerRace'), bodyShape('carrier')) < 1e-6, [gap(bodyShape('innerRace'), bodyShape('carrier')), overlap(bodyShape('innerRace'), bodyShape('carrier'))]);
  for (const ballId of ballIds) {
    const gi = gap(bodyShape(ballId), bodyShape('innerRace')), go = gap(bodyShape(ballId), bodyShape('outerRace'));
    check(`${ballId} runs in its grooves, 0.2 clear`, Math.abs(gi - 0.2) < 1e-4 && Math.abs(go - 0.2) < 1e-4, [gi, go]);
  }
  check('the races are clear of each other', gap(bodyShape('innerRace'), bodyShape('outerRace')) >= 1 - 1e-6, gap(bodyShape('innerRace'), bodyShape('outerRace')));
  check('the balls are clear of each other', ballIds.every((ballId, i) => gap(bodyShape(ballId), bodyShape(ballIds[(i + 1) % 10])) > GAP), ballIds.map((ballId, i) => gap(bodyShape(ballId), bodyShape(ballIds[(i + 1) % 10]))));
  check('the inner race is clear of the lid, the balls of the lid and the carrier', gap(bodyShape('innerRace'), bodyShape('lid')) >= 0.4 - 1e-6 && ballIds.every(ballId => gap(bodyShape(ballId), bodyShape('lid')) > GAP && gap(bodyShape(ballId), bodyShape('carrier')) > GAP), [gap(bodyShape('innerRace'), bodyShape('lid'))]);
}
// (The gears are as they were: only the bearing's neighbours to check.)
for (const key of ['innerRace', 'outerRace', ...ballIds]) {
  for (const other of ['sun', 'housing', ...planetIds]) {
    check(`${key} is clear of the ${other}`, gap(bodyShape(key), bodyShape(other)) > GAP, gap(bodyShape(key), bodyShape(other)).toFixed(3));
  }
}

if (process.env.PLANETARY_OUT) {
  const { writeFileSync } = await import('node:fs');
  writeFileSync(process.env.PLANETARY_OUT, JSON.stringify({ format: 'super', version: 2, name: 'Planetary (stress)', features: fs, variables: [], views: [], units: 'mm', hidden: [], pins: [], names: {}, colors: {}, historyGroups: [] }));
}
done();
