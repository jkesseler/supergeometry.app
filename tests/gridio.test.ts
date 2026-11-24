// In and out, and what goes with it: extrudes up to a face or a plane; a part sent out as
// STEP or STL and brought back; meshes brought in (closed: a solid, open: loose faces, too
// big: said so at once); a body split by another; and bodies of thousands of faces, meshed
// without the engine's memory growing. Each result held to a volume worked out by hand.
import { getOC, makeCompound, makeCylinder, type Shape3D } from 'replicad';
import { exportBodies } from '../src/kernel/engine';
import { deepCopy } from '../src/kernel/health';
import { meshEdgeLines, meshFaces, meshOff } from '../src/kernel/meshing';
import { build, faceRef, near, say } from './grid';
import { block, bodies, check, circle, cylinder, done, extrude, health, rect, sketch, volume, XY, after } from './kit';
import type { Feature, PlaneDef } from '../src/doc/types';

type Got = Awaited<ReturnType<typeof build>>;
const told = (got: Got, id: string) => `${got.errors.join(' | ')} ${got.unsound} got ${got.vol[id]?.toFixed(2)}`;
const sound = (got: Got) => !got.errors.length && !got.unsound.length;
const memory = () => Math.round((getOC() as any).wasmMemory.buffer.byteLength / 2 ** 20);

// ------------------------------------------------------------------ meshes, written by hand

type P = [number, number, number];
const b64 = (bytes: Uint8Array) => {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }

  return btoa(bin);
};
/** Triangles as a binary STL. */
const stl = (tris: P[][]): Uint8Array => {
  const buf = new ArrayBuffer(84 + tris.length * 50);
  const dv = new DataView(buf);
  dv.setUint32(80, tris.length, true);
  tris.forEach((t, triangleIndex) => {
    let offset = 84 + triangleIndex * 50 + 12;
    for (const point of t) {
      for (const x of point) {
        (dv.setFloat32(offset, x, true), (offset += 4));
      }
    }
  });

  return new Uint8Array(buf);
};
/** The triangles of a binary STL, and the volume they close in (counted outward-facing). */
const read = (bytes: Uint8Array) => {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const triangleCount = dv.getUint32(80, true);
  let vol = 0;
  let normals = true;
  for (let index = 0; index < triangleCount; index++) {
    const offset = 84 + index * 50;
    const floatAt = (i: number) => dv.getFloat32(offset + i * 4, true);
    const [a, b, vertexC] = [3, 6, 9].map(i => [floatAt(i), floatAt(i + 1), floatAt(i + 2)]);
    vol += a[0] * (b[1] * vertexC[2] - b[2] * vertexC[1]) - a[1] * (b[0] * vertexC[2] - b[2] * vertexC[0]) + a[2] * (b[0] * vertexC[1] - b[1] * vertexC[0]);
    const [edgeU, edgeV] = [b.map((x, i) => x - a[i]), vertexC.map((x, i) => x - a[i])];
    const x = [edgeU[1] * edgeV[2] - edgeU[2] * edgeV[1], edgeU[2] * edgeV[0] - edgeU[0] * edgeV[2], edgeU[0] * edgeV[1] - edgeU[1] * edgeV[0]];
    const length = Math.hypot(x[0], x[1], x[2]);
    // Each triangle's own normal, of length one, the way its corners turn.
    if (length > 1e-12 && Math.hypot(floatAt(0) - x[0] / length, floatAt(1) - x[1] / length, floatAt(2) - x[2] / length) > 1e-4) {
      normals = false;
    }
  }

  return { n: triangleCount, vol: vol / 6, normals, whole: bytes.length === 84 + triangleCount * 50 };
};
const box = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): P[][] => {
  const corner = (i: number, j: number, cornerZ: number): P => [i ? x1 : x0, j ? y1 : y0, cornerZ ? z1 : z0];

  return [
    [corner(0, 0, 0), corner(0, 1, 0), corner(1, 1, 0)], [corner(0, 0, 0), corner(1, 1, 0), corner(1, 0, 0)],
    [corner(0, 0, 1), corner(1, 0, 1), corner(1, 1, 1)], [corner(0, 0, 1), corner(1, 1, 1), corner(0, 1, 1)],
    [corner(0, 0, 0), corner(1, 0, 0), corner(1, 0, 1)], [corner(0, 0, 0), corner(1, 0, 1), corner(0, 0, 1)],
    [corner(0, 1, 0), corner(0, 1, 1), corner(1, 1, 1)], [corner(0, 1, 0), corner(1, 1, 1), corner(1, 1, 0)],
    [corner(0, 0, 0), corner(0, 0, 1), corner(0, 1, 1)], [corner(0, 0, 0), corner(0, 1, 1), corner(0, 1, 0)],
    [corner(1, 0, 0), corner(1, 1, 0), corner(1, 1, 1)], [corner(1, 0, 0), corner(1, 1, 1), corner(1, 0, 1)]
  ];
};
/** A ball of radius 10 as flat facets: `rings` bands from pole to pole, twice as many round. */
const ball = (rings: number): P[][] => {
  const seg = rings * 2;
  const at = (i: number, j: number): P => {
    const [th, ph] = [(Math.PI * i) / rings, (2 * Math.PI * (j % seg)) / seg];

    return [10 * Math.sin(th) * Math.cos(ph), 10 * Math.sin(th) * Math.sin(ph), 10 * Math.cos(th)];
  };
  const tris: P[][] = [];
  for (let i = 0; i < rings; i++) {
    for (let j = 0; j < seg; j++) {
      const [a, b, cornerC, cornerD] = [at(i, j), at(i + 1, j), at(i + 1, j + 1), at(i, j + 1)];
      if (i > 0) {
        tris.push([a, b, cornerD]);
      }
      if (i < rings - 1) {
        tris.push([b, cornerC, cornerD]);
      }
    }
  }

  return tris;
};
const brought = (bytes: Uint8Array, format: 'stl' | 'step' = 'stl'): Feature => ({ id: 'I', name: 'I', type: 'import', format, fileName: `x.${format}`, data: b64(bytes) }) as Feature;

// ------------------------------------------------------------------ up to a face, up to a plane
{
  // A base, and above it a lid whose underside is flat, or round.
  const base = block('A', 60, 40, 10);
  const lidFlat = block('B', 60, 40, 5, [0, 0, 40]);
  const tilt: PlaneDef = { origin: [30, 20, 45], xDir: [1, 0, 0], normal: [0, -Math.sin(0.2), Math.cos(0.2)] };
  const feature = sketch('s', XY(10), [circle('c', 30, 20, 6)]);
  const sr = sketch('s', XY(10), [rect('r', 20, 12, 40, 28)]);
  for (const [pname, sk, ar] of [['a circle', feature, Math.PI * 36], ['a rectangle', sr, 320]] as const) {
    // Up to the lid's underside (z = 40): 30 high.
    await build([...base, ...lidFlat]);
    const under = faceRef('B', normal => normal[2] < -0.99);
    let got = await build([...base, ...lidFlat, sk, extrude('E', sk, 5, 'new', { extent: 'to', to: { face: under } })]);
    say(sound(got) && near(got.vol.E, ar * 30, 2e-4), `${pname} up to the flat underside of a lid`, `${told(got, 'E')} want ${(ar * 30).toFixed(2)}`);
    got = await build([...base, ...lidFlat, sk, extrude('E', sk, 5, 'join', { target: 'A', extent: 'to', to: { face: under } })]);
    say(sound(got) && near(got.vol.A, 24000 + ar * 30, 2e-4), `${pname} up to the lid, joined to the base`, `${told(got, 'A')} want ${(24000 + ar * 30).toFixed(2)}`);
    // Up to a plane 25 above the sketch.
    got = await build([...base, sk, extrude('E', sk, 5, 'new', { extent: 'to', to: { plane: { origin: [0, 0, 35], xDir: [1, 0, 0], normal: [0, 0, 1] } } })]);
    say(sound(got) && near(got.vol.E, ar * 25, 2e-4), `${pname} up to a plane 25 above`, `${told(got, 'E')} want ${(ar * 25).toFixed(2)}`);
    // Up to a tilted plane through (30, 20, 45): over a shape centred under that point, 35 high on average.
    got = await build([...base, sk, extrude('E', sk, 5, 'new', { extent: 'to', to: { plane: tilt } })]);
    say(sound(got) && near(got.vol.E, ar * 35, 2e-4), `${pname} up to a tilted plane`, `${told(got, 'E')} want ${(ar * 35).toFixed(2)}`);
    // Down to a plane below the sketch, into the base (a cut 6 deep).
    got = await build([...base, sk, extrude('E', sk, -1, 'cut', { target: 'A', extent: 'to', to: { plane: { origin: [0, 0, 4], xDir: [1, 0, 0], normal: [0, 0, 1] } } })]);
    say(sound(got) && near(got.vol.A, 24000 - ar * 6, 2e-4), `${pname} cut down to a plane 6 below`, `${told(got, 'A')} want ${(24000 - ar * 6).toFixed(2)}`);
    // Up to the round underside of a big cylinder lying across above it (its axis along x at z = 60, r = 30: lowest at z = 30).
    const sc = sketch('sc', { origin: [0, 20, 60], xDir: [0, 1, 0], normal: [1, 0, 0] }, [circle('c', 0, 0, 30)]);
    const lidRound = [sc, extrude('B', sc, 60)];
    await build([...base, ...lidRound]);
    const roundFace = faceRef('B', (_n, _c, face) => face.geomType === 'CYLINDRE');
    got = await build([...base, ...lidRound, sk, extrude('E', sk, 5, 'new', { extent: 'to', to: { face: roundFace } })]);
    say(sound(got) && got.vol.E > ar * 20 && got.vol.E < ar * 21.5, `${pname} up to the round underside of a cylinder across it`, `${told(got, 'E')} between ${(ar * 20).toFixed(1)} and ${(ar * 21.5).toFixed(1)}`);
  }
  // Through all: a cut right through whatever is that way.
  const two = [...base, ...block('B', 60, 40, 5, [0, 0, 20])];
  const built = await build([...two, feature, extrude('E', feature, -1, 'cut', { extent: 'through' })]);
  say(sound(built) && near(built.vol.A, 24000 - Math.PI * 36 * 10, 2e-4), 'a circle cut through all, downwards: through the base', told(built, 'A'));
  const g2 = await build([...two, feature, extrude('E', feature, 1, 'cut', { extent: 'through' })]);
  say(sound(g2) && near(g2.vol.B, 12000 - Math.PI * 36 * 5, 2e-4) && near(g2.vol.A, 24000, 1e-9), 'a circle cut through all, upwards: through the lid only', `${told(g2, 'B')} A ${g2.vol.A}`);
}

// ------------------------------------------------------------------ out and back in: STEP, STL
{
  const s1 = sketch('h', XY(20), [circle('c', 20, 15, 5)]);
  const part: Feature[] = [...block('A', 40, 30, 20), s1, extrude('hc', s1, -20, 'cut', { target: 'A' })];
  await build(part);
  const v0 = volume(bodies().get('A')!);
  const s2 = sketch('h2', XY(20), [circle('c', 8, 8, 3)]);
  const lump = block('L', 10, 10, 10, [35, 10, 5]);
  for (const format of ['step', 'stl'] as const) {
    // (The STL's round hole is flat facets: a little smaller than the hole.)
    const rel = format === 'step' ? 1e-6 : 2e-4;
    const bytes = new Uint8Array(await (await exportBodies(part, format)).arrayBuffer());
    let got = await build([brought(bytes, format)]);
    say(sound(got) && near(got.vol.I, v0, rel), `out as ${format.toUpperCase()} and back in: one solid of the same volume`, `${told(got, 'I')} want ${v0.toFixed(2)}`);
    // ...and still a body to work on: a hole more, a lump joined on (half of it inside).
    got = await build([brought(bytes, format), s2, extrude('h2c', s2, -20, 'cut', { target: 'I' })]);
    say(sound(got) && near(got.vol.I, v0 - 9 * Math.PI * 20, rel), `...the ${format.toUpperCase()} part takes another hole`, `${told(got, 'I')} want ${(v0 - 9 * Math.PI * 20).toFixed(2)}`);
    got = await build([brought(bytes, format), ...lump, { id: 'J', name: 'J', type: 'boolean', op: 'union', target: 'I', tools: ['L'] } as Feature]);
    say(sound(got) && near(got.vol.I, v0 + 500, rel), '...and a lump joined on', `${told(got, 'I')} want ${(v0 + 500).toFixed(2)}`);
  }
  // The STL as written: every triangle with its own normal, facing out; the volume the part's.
  const out = read(new Uint8Array(await (await exportBodies(part, 'stl')).arrayBuffer()));
  say(out.whole && out.n > 100 && out.normals && near(out.vol, v0, 2e-4), "the STL written: whole, its triangles facing out with their normals, the part's volume", JSON.stringify(out));
  // Two bodies in one file: both there.
  const both = read(new Uint8Array(await (await exportBodies([...part, ...lump], 'stl')).arrayBuffer()));
  say(both.whole && both.normals && near(both.vol, v0 + 1000, 2e-4), 'two bodies in one STL: the volume of both', JSON.stringify(both));
  // For a 3MF: the same triangles as numbers.
  const mesh = JSON.parse(await (await exportBodies(part, 'mesh')).text()) as { id: string; positions: number[]; indices: number[] }[];
  say(mesh.length === 1 && mesh[0].id === 'A' && Array.isArray(mesh[0].positions) && mesh[0].indices.length / 3 === out.n && mesh[0].indices.every(i => i < mesh[0].positions.length / 3), 'the mesh for a 3MF: the same triangles, as plain lists', `${mesh[0]?.indices.length / 3} / ${out.n}`);
}

// ------------------------------------------------------------------ meshes brought in
{
  // A block of 12 triangles: one solid of 6 faces.
  let got = await build([brought(stl(box(0, 0, 0, 10, 20, 30)))]);
  let bodyHealth = health(bodies().get('I')!);
  say(sound(got) && near(got.vol.I, 6000, 1e-9) && bodyHealth.faces === 6, 'a block of 12 triangles comes in as a solid of 6 faces', `${told(got, 'I')} faces ${bodyHealth.faces}`);
  // ...its triangles turned inside out: the same solid.
  got = await build([brought(stl(box(0, 0, 0, 10, 20, 30).map(([a, b, coordC]) => [a, coordC, b])))]);
  say(sound(got) && near(got.vol.I, 6000, 1e-9), '...inside out: the same solid, right side out', told(got, 'I'));
  // ...and worked on like any body: a hole through it.
  const hole = sketch('hs', XY(30), [circle('c', 5, 10, 3)]);
  got = await build([brought(stl(box(0, 0, 0, 10, 20, 30))), hole, extrude('hc', hole, -30, 'cut', { target: 'I' })]);
  say(sound(got) && near(got.vol.I, 6000 - 9 * Math.PI * 30, 1e-5), '...and takes a hole through it', told(got, 'I'));
  // A pyramid of 4 triangles.
  const [a, b, pointC, pointD]: P[] = [[0, 0, 0], [12, 0, 0], [0, 9, 0], [0, 0, 6]];
  got = await build([brought(stl([[a, pointC, b], [a, b, pointD], [b, pointC, pointD], [pointC, a, pointD]]))]);
  say(sound(got) && near(got.vol.I, (12 * 9 * 6) / 6, 1e-9), 'a pyramid of 4 triangles: a solid', told(got, 'I'));
  // The same as text.
  const text = `solid p\n${[[a, pointC, b], [a, b, pointD], [b, pointC, pointD], [pointC, a, pointD]].map(t => `facet normal 0 0 0\n outer loop\n${t.map(point => `  vertex ${point.join(' ')}`).join('\n')}\n endloop\nendfacet`).join('\n')}\nendsolid p\n`;
  got = await build([brought(new TextEncoder().encode(text))]);
  say(sound(got) && near(got.vol.I, 108, 1e-9), '...written as text: the same solid', told(got, 'I'));
  // A ball of 760 facets: one solid, the volume its facets close in.
  const round = ball(14);
  got = await build([brought(stl(round))]);
  say(sound(got) && near(got.vol.I, Math.abs(read(stl(round)).vol), 1e-6), 'a ball of 760 facets: one solid of their volume', `${told(got, 'I')} want ${Math.abs(read(stl(round)).vol).toFixed(2)}`);
  // Open (a block without its lid): no solid - loose faces, said to be open, and no error.
  got = await build([brought(stl(box(0, 0, 0, 10, 20, 30).filter((_, i) => i !== 2 && i !== 3)))], { I: 0 });
  bodyHealth = health(bodies().get('I')!);
  say(!got.errors.length && bodyHealth.solids === 0 && bodyHealth.openEdges > 0 && bodyHealth.faces === 10, 'a block without its lid: loose faces, open, no error', `${got.errors.join(' | ')} solids ${bodyHealth.solids} open ${bodyHealth.openEdges} faces ${bodyHealth.faces}`);
  // Two lumps in one file: loose faces as they come, two solids once repaired.
  const pair = [...box(0, 0, 0, 10, 10, 10), ...box(20, 0, 0, 30, 10, 10)];
  got = await build([brought(stl(pair))], { I: 0 });
  bodyHealth = health(bodies().get('I')!);
  say(!got.errors.length && bodyHealth.solids === 0, 'two lumps in one file: loose faces as they come', `${got.errors.join(' | ')} solids ${bodyHealth.solids}`);
  got = await build([brought(stl(pair)), { id: 'fix', name: 'Repair', type: 'repair', bodies: ['I'] } as Feature], { I: 2 });
  say(sound(got) && near(got.vol.I, 2000, 1e-9), '...and two solids once repaired', told(got, 'I'));
  // Far too many triangles: said at once, in words (it ran the engine out of memory).
  const huge = new Uint8Array(84 + 300000 * 50);
  new DataView(huge.buffer).setUint32(80, 300000, true);
  const t0 = performance.now();
  got = await build([brought(huge)]);
  say(/300,000 triangles/.test(got.errors[0] ?? '') && performance.now() - t0 < 5000, '300 000 triangles: refused at once, with the count', `${got.errors.join(' | ')} after ${Math.round(performance.now() - t0)} ms`);
  // Not an STL at all.
  got = await build([brought(new TextEncoder().encode('this is not a mesh'))]);
  say(got.errors.length === 1 && /STL/.test(got.errors[0]), "a file that isn't a mesh: said so", got.errors.join(' | '));
}

// ------------------------------------------------------------------ split by another body
{
  const featuresA = block('A', 40, 30, 20);
  const tool = cylinder('T', 6, 40, 20, 15, -10);
  let got = await build([...featuresA, ...tool, { id: 'S', name: 'S', type: 'split', body: 'A', plane: { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, 0, 1] }, noPlane: true, tools: ['T'] } as Feature], { T: 1 });
  const vs = Object.entries(got.vol).filter(([key]) => key !== 'T').map(([, volume]) => volume).sort((x, y) => y - x);
  say(sound(got) && vs.length === 2 && near(vs[0], 24000 - Math.PI * 36 * 20, 1e-5) && near(vs[1], Math.PI * 36 * 20, 1e-5), 'a block split by a cylinder through it: the block with a hole, and the plug', `${got.errors.join(' | ')} ${got.unsound} ${JSON.stringify(got.vol)}`);
  got = await build([...featuresA, ...tool, { id: 'S', name: 'S', type: 'split', body: 'A', plane: { origin: [20, 0, 0], xDir: [0, 1, 0], normal: [1, 0, 0] }, tools: ['T'] } as Feature], { T: 1 });
  const all = Object.entries(got.vol).filter(([key]) => key !== 'T').map(([, volume]) => volume);
  say(sound(got) && all.length === 4 && near(all.reduce((x, y) => x + y, 0), 24000, 1e-6), '...by the cylinder and a plane through its axis: four pieces', `${got.errors.join(' | ')} ${got.unsound} ${JSON.stringify(got.vol)}`);
}

// ------------------------------------------------------------------ bodies of thousands of faces
{
  // Meshed a few hundred faces at a time: the same triangles and lines as the whole body at once.
  const many = () => makeCompound(Array.from({ length: 120 }, (_, i) => makeCylinder(2 + (i % 5), 10 + (i % 7), [(i % 12) * 20, Math.floor(i / 12) * 20, 0], [0, 0, 1]))) as unknown as Shape3D;
  const [whole, lots] = [many(), many()];
  const mesh = whole.mesh({ tolerance: 0.05, angularTolerance: 0.25 });
  const we = whole.meshEdges({ tolerance: 0.05, angularTolerance: 0.25 });
  const faceMesh = meshFaces(lots, 0.05, 0.25);
  const e = meshEdgeLines(lots, 0.05, 0.25);
  const same = (x: ArrayLike<number>, y: ArrayLike<number>) => x.length === y.length && Array.prototype.every.call(x, (value: number, i: number) => value === y[i]);
  say(lots.faces.length === 360 && same(mesh.vertices, faceMesh.vertices) && same(mesh.normals, faceMesh.normals) && same(mesh.triangles, faceMesh.triangles), '360 faces meshed in lots: the points, normals and triangles of the body meshed whole', `${lots.faces.length} faces, ${mesh.triangles.length / 3} / ${faceMesh.triangles.length / 3} triangles`);
  say(faceMesh.faceGroups.length === 360 && same(mesh.faceGroups.flatMap(faceGroup => [faceGroup.start, faceGroup.count]), faceMesh.faceGroups.flatMap(faceGroup => [faceGroup.start, faceGroup.count])), "...each face's triangles where the whole body's are", `${faceMesh.faceGroups.length} groups`);
  say(same(we.lines, e.lines) && same(we.edgeGroups.flatMap(edgeGroup => [edgeGroup.start, edgeGroup.count]), e.edgeGroups.flatMap(edgeGroup => [edgeGroup.start, edgeGroup.count])), '...and the same edge lines', `${we.lines.length} / ${e.lines.length}`);
  // Edge lines asked for first (nothing meshed yet): the same.
  const alone = meshEdgeLines(many(), 0.05, 0.25);
  say(same(we.lines, alone.lines), '...edge lines asked for before the faces: the same', `${we.lines.length} / ${alone.lines.length}`);

  // A ball of 16 000 facets (9 700 faces once its flat pairs are merged): a solid, shown,
  // with the engine's memory where it was (it went past 1.6 GB meshing it whole).
  const facets = ball(64);
  const before = memory();
  const { r, errors } = await after([brought(stl(facets))]);
  const body = bodies().get('I')!;
  const shown = r.bodies[0];
  const hb = health(body);
  say(!errors.length && hb.solids === 1 && hb.valid && !hb.openEdges && near(hb.volume, Math.abs(read(stl(facets)).vol), 1e-6), 'a ball of 16 000 facets comes in as one solid of their volume', `${errors.join(' | ')} solids ${hb.solids} open ${hb.openEdges} vol ${hb.volume}`);
  say(!!shown && shown.faces.length === hb.faces && shown.faceGroups.length === hb.faces && shown.indices.length / 3 === facets.length && shown.faceGroups.every(faceGroup => faceGroup.count > 0) && shown.edgeGroups.length === shown.edges.length, '...shown: every face with its triangles, every edge with its line', `${shown?.faces.length} faces, ${shown?.faceGroups.length} groups, ${shown ? shown.indices.length / 3 : 0} triangles`);
  say(memory() < before + 400, "...with the engine's memory where it was", `${before} MB before, ${memory()} MB after`);
  // Sent out as STL: the facets it came in with, the same volume; memory still where it was.
  const out = read(new Uint8Array(await (await exportBodies([brought(stl(facets))], 'stl')).arrayBuffer()));
  say(out.n === facets.length && out.normals && near(out.vol, hb.volume, 1e-5) && memory() < before + 400, '...and out again as STL: its facets, its volume, the memory where it was', `${JSON.stringify(out)} ${memory()} MB`);
  // The check that counts a volume off a mesh, on a copy not meshed yet.
  const copy = deepCopy(body);
  const coarse = meshFaces(copy, 0.02, 0.3);
  say(coarse.faceGroups.length === hb.faces && memory() < before + 400, '...a copy of it meshed afresh: memory where it was', `${coarse.faceGroups.length} groups, ${memory()} MB`);
}

// ------------------------------------------------------------------ plates with a great many holes
{
  // A flat face with very many holes is cut into triangles by the engine itself (the kernel's mesher
  // takes time and memory by the square of the holes: 400 holes 5 s and 700 MB). Round holes and square
  // ones: the mesh closed (every side of a triangle met by one other, going the other way), the volume
  // the part's, every face and edge shown; and the same part is still worked on (a face pushed, a shell).
  const closed = (positions: ArrayLike<number>, t: ArrayLike<number>) => {
    const sides = new Map<string, number>();
    const key = (i: number) => `${positions[3 * i]},${positions[3 * i + 1]},${positions[3 * i + 2]}`;
    let vol = 0;
    for (let index = 0; index < t.length; index += 3) {
      const [a, b, offsetC] = [3 * t[index], 3 * t[index + 1], 3 * t[index + 2]];
      vol += positions[a] * (positions[b + 1] * positions[offsetC + 2] - positions[b + 2] * positions[offsetC + 1]) - positions[a + 1] * (positions[b] * positions[offsetC + 2] - positions[b + 2] * positions[offsetC]) + positions[a + 2] * (positions[b] * positions[offsetC + 1] - positions[b + 1] * positions[offsetC]);
      for (const [from, to] of [[t[index], t[index + 1]], [t[index + 1], t[index + 2]], [t[index + 2], t[index]]]) {
        sides.set(`${key(from)}|${key(to)}`, (sides.get(`${key(from)}|${key(to)}`) ?? 0) + 1);
      }
    }
    let open = 0;
    for (const [key, side] of sides) {
      const [from, to] = key.split('|');
      if (from !== to && (sides.get(`${to}|${from}`) ?? 0) !== side) {
        open++;
      }
    }

    return { open, vol: vol / 6 };
  };
  for (const [kind, sideCount, each] of [['round', 12, Math.PI * 9], ['square', 12, 25], ['round', 20, Math.PI * 9]] as const) {
    const holes = sketch('hs', XY(6), Array.from({ length: sideCount * sideCount }, (_, i) => (kind === 'round' ? circle(`c${i}`, 5 + (i % sideCount) * 10, 5 + Math.floor(i / sideCount) * 10, 3) : rect(`r${i}`, 2.5 + (i % sideCount) * 10, 2.5 + Math.floor(i / sideCount) * 10, 7.5 + (i % sideCount) * 10, 7.5 + Math.floor(i / sideCount) * 10))));
    const plate: Feature[] = [...block('P', sideCount * 10, sideCount * 10, 6), holes, extrude('hc', holes, -6, 'cut', { target: 'P' })];
    const before = memory();
    const t0 = performance.now();
    const { r, errors } = await after(plate);
    const ms = performance.now() - t0;
    const shown = r.bodies[0];
    const want = sideCount * sideCount * 600 - sideCount * sideCount * each * 6;
    const mesh = shown ? closed(shown.positions, shown.indices) : { open: -1, vol: 0 };
    const name = `a plate with ${sideCount * sideCount} ${kind} holes`;
    say(!errors.length && !!shown && shown.faces.length === sideCount * sideCount * (kind === 'round' ? 1 : 4) + 6 && shown.faceGroups.every(faceGroup => faceGroup.count > 0) && shown.edgeGroups.length === shown.edges.length && shown.edgeGroups.every(edgeGroup => edgeGroup.count > 1), `${name}: every face with its triangles, every edge with its line`, `${errors.join(' | ')} ${shown?.faces.length} faces`);
    say(mesh.open === 0 && near(mesh.vol, want, kind === 'round' ? 5e-3 : 1e-6), '...its mesh closed, of the part\'s volume', `${mesh.open} open sides, volume ${mesh.vol.toFixed(2)} (the part: ${want.toFixed(2)})`);
    say(ms < 20000 && memory() - before < 500, '...shown without the engine\'s memory growing by hundreds of megabytes', `${Math.round(ms)} ms, ${before} -> ${memory()} MB`);
    if (sideCount > 12) {
      continue;
    }
    // Out as STL: closed too.
    const out = new Uint8Array(await (await exportBodies(plate, 'stl')).arrayBuffer());
    const dv = new DataView(out.buffer);
    const count = dv.getUint32(80, true);
    const values = new Float32Array(count * 9);
    for (let index = 0; index < count; index++) {
      for (let j = 0; j < 9; j++) {
        values[index * 9 + j] = dv.getFloat32(84 + index * 50 + 12 + j * 4, true);
      }
    }
    const printed = closed(values, Array.from({ length: count * 3 }, (_, i) => i));
    say(printed.open === 0 && near(printed.vol, want, kind === 'round' ? 5e-4 : 1e-6), '...out as STL: closed, the part\'s volume', `${printed.open} open sides, volume ${printed.vol.toFixed(2)}`);
    // Still a part to work on: its top pushed down by 1, then hollowed from below.
    await build(plate);
    const top = faceRef('P', (nn, center) => nn[2] > 0.99 && center[2] > 5.9);
    let got = await build([...plate, { id: 'M', name: 'M', type: 'moveFace', face: top, translate: [0, 0, -1] } as Feature]);
    say(sound(got) && near(got.vol.P, (want * 5) / 6, 1e-6), '...its top pushed down by 1', `${told(got, 'P')} want ${((want * 5) / 6).toFixed(2)}`);
    if (kind === 'round') {
      const side = faceRef('P', nn => nn[0] > 0.99);
      got = await build([...plate, { id: 'M', name: 'M', type: 'moveFace', face: side, translate: [4, 0, 0] } as Feature]);
      say(sound(got) && near(got.vol.P, want + 4 * sideCount * 10 * 6, 1e-6), '...a side pulled out by 4', `${told(got, 'P')} want ${(want + 4 * sideCount * 10 * 6).toFixed(2)}`);
    }
  }
}

// ------------------------------------------------------------------ a body's copy
{
  // Every step that works on a copy of a body (a fillet, a shell, a face moved) gets one of these:
  // its own shape, the same faces and edges in the same order (what a step knows of a face goes by that), no mesh.
  const hole = sketch('h', XY(20), [circle('c', 20, 15, 5)]);
  const upright = (id: string) => ({ id, name: id, type: 'fillet', radius: 3, edges: [] as unknown[] }) as unknown as Feature;
  await build([...block('A', 40, 30, 20), hole, extrude('hc', hole, -20, 'cut', { target: 'A' })]);
  const fillet = { ...upright('F'), edges: (await import('./grid')).edgeRefs('A', (_m, direction) => Math.abs(direction[2]) > 0.99 && true).filter(e => e.length > 19) };
  const moved = { id: 'M', name: 'M', type: 'transform', bodies: ['A'], copy: false, op: { kind: 'move', translate: [7, -3, 11], rotate: { origin: [0, 0, 0], axis: [0, 0, 1], angle: 30 } } } as unknown as Feature;
  const got = await build([...block('A', 40, 30, 20), hole, extrude('hc', hole, -20, 'cut', { target: 'A' }), fillet, moved]);
  const body = bodies().get('A')!;
  // (Shown, the body keeps none of the view's triangles: left on, they stayed in the kernel for good.)
  const bare = body.faces.every(face => !face.triangulation());
  meshFaces(body, 0.05, 0.25);
  const copy = deepCopy(body);
  const at = (shape: Shape3D) => [...shape.faces.map(face => [...(face.center.toTuple() as number[]), face.geomType]), ...shape.edges.map(e => [...(e.pointAt(0.5).toTuple() as number[]), e.geomType])];
  const [a, b] = [at(body), at(copy)];
  const order = a.length === b.length && a.every((row, i) => row.every((value, index) => (typeof value === 'number' ? Math.abs(value - (b[i][index] as number)) < 1e-12 : value === b[i][index])));
  say(sound(got) && order && body.faces.length === copy.faces.length, 'a copy of a body: the same faces and edges, in the same order', `${got.errors.join(' | ')} ${got.unsound} ${body.faces.length}/${copy.faces.length} faces`);
  const hb = health(body), hc = health(copy);
  say(near(hb.volume, hc.volume, 1e-12) && hc.valid && hc.solids === hb.solids && !hc.openEdges && copy.constructor === body.constructor, '...the same volume to the last digit, sound, the same kind of shape', `${hb.volume} / ${hc.volume}, ${copy.constructor.name}`);
  say(!copy.faces.some(face => body.faces.some(other => other.isSame(face))) && copy.faces.every(face => !face.triangulation()) && body.faces.every(face => !!face.triangulation()), "...its own faces, none of the first's triangles", `${copy.faces.filter(face => face.triangulation()).length} meshed faces on the copy, ${body.faces.filter(face => face.triangulation()).length} on the first`);
  meshOff(body);
  say(bare && body.faces.every(face => !face.triangulation()), "a body that was shown keeps none of the view's triangles (nor one whose mesh was taken off)", `${bare}`);
  // A cut on the copy leaves the first as it was.
  (copy as any).cut(makeCylinder(2, 100, [10, 5, -50], [0, 0, 1]));
  say(near(health(body).volume, hb.volume, 1e-12), '...and what is done to it leaves the first alone', `${health(body).volume}`);
}

// ------------------------------------------------------------------ the engine's memory over many rebuilds
{
  // A hole's size changed 400 times: each rebuild used to leave a third of a megabyte behind for good
  // (nothing the kernel was told to delete was let go of) - 100 MB to 230 MB here; now a quarter of that.
  const before = memory();
  for (let round = 0; round < 400; round++) {
    const feature = sketch('h', XY(20), [circle('c', 30, 20, 5 + (round % 50) * 0.05)]);
    await after([...block('A', 60, 40, 20), feature, extrude('hc', feature, -20, 'cut', { target: 'A' })]);
    if (round % 20 === 19) {
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  }
  check("a hole's size changed 400 times: the engine's memory grows by under 100 MB", memory() - before < 100, `${before} -> ${memory()} MB`);
}

check("the engine's memory at the end, MB", memory() < 1200, memory());
done();
