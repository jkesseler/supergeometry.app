// Run: npx tsx tests/exports.test.ts
// Every way a model leaves the app, made from one project (the flange built by hand, with a small block beside it)
// and read back: is the file what its format says, is it the same part, the same size, closed, in millimetres?
//   STL - STEP - 3MF - GLB - one body of several - the project file itself.
// (A sketch as DXF and SVG, and a drawing's sheet: dxf, svgexport and drawing tests.)
import { readFileSync } from 'node:fs';
import { parseProject } from '../src/doc/store';
import { resolveDoc } from '../src/doc/params';
import { exportBodies } from '../src/kernel/engine';
import { glb, read3mf, unzip } from '../src/io/formats';
import { exportThreeMF } from '../src/io/threemf';
import { after, block, bodies, check, done, near, volume } from './kit';
import type { Feature, ProjectDoc } from '../src/doc/types';
import type { Shape3D } from 'replicad';

const doc = JSON.parse(readFileSync(new URL('./fixtures/flange-variables.json', import.meta.url), 'utf8')) as ProjectDoc;
resolveDoc(doc);
const features = [...(doc.features as Feature[]), ...block('Block', 20, 10, 5, [200, 0, 0])];
const { errors } = await after(features);
const all = [...bodies().entries()] as [string, Shape3D][];
const flangeId = all.find(([id]) => id !== 'Block')![0];
const V = { flange: volume(bodies().get(flangeId) as Shape3D), block: volume(bodies().get('Block') as Shape3D) };
check('the model: a flange and a block, no errors', !errors.length && all.length === 2 && near(V.block, 1000, 1e-6) && near(V.flange, 429515.41, 0.05), `${all.length} bodies, ${V.flange.toFixed(2)} + ${V.block}`);

// ---- what a mesh is worth: its volume, its box, whether it is closed
type Mesh = { p: number[]; t: number[] };
function measure(m: Mesh) {
  let vol = 0;
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  const key = (i: number) => `${m.p[3 * i].toFixed(4)},${m.p[3 * i + 1].toFixed(4)},${m.p[3 * i + 2].toFixed(4)}`;
  const edges = new Map<string, number>();
  for (let k = 0; k < m.t.length; k += 3) {
    const [a, b, c] = [m.t[k], m.t[k + 1], m.t[k + 2]];
    const P = (i: number) => [m.p[3 * i], m.p[3 * i + 1], m.p[3 * i + 2]];
    const [A, B, C] = [P(a), P(b), P(c)];
    vol += (A[0] * (B[1] * C[2] - B[2] * C[1]) - A[1] * (B[0] * C[2] - B[2] * C[0]) + A[2] * (B[0] * C[1] - B[1] * C[0])) / 6;
    for (const q of [A, B, C]) {
      for (let j = 0; j < 3; j++) {
        (lo[j] = Math.min(lo[j], q[j])), (hi[j] = Math.max(hi[j], q[j]));
      }
    }
    // Each side of each triangle, with its direction: a closed skin has every side once each way.
    for (const [u, v] of [[a, b], [b, c], [c, a]]) {
      const [ku, kv] = [key(u), key(v)];
      if (ku === kv) {
        continue;
      }
      edges.set(`${ku}>${kv}`, (edges.get(`${ku}>${kv}`) ?? 0) + 1);
    }
  }
  let open = 0;
  for (const [e, n] of edges) {
    const [u, v] = e.split('>');
    if ((edges.get(`${v}>${u}`) ?? 0) !== n) {
      open++;
    }
  }

  return { vol, lo, hi, open, tris: m.t.length / 3 };
}
// (A mesh of flat facets inside a round body holds a little less than the body: within 0.01 mm of it everywhere.)
const sameVolume = (got: number, want: number) => got <= want + 1e-3 && got > want * 0.998;

// ---- STL
function readSTL(bytes: Uint8Array): Mesh {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const n = dv.getUint32(80, true);
  if (bytes.length !== 84 + n * 50) {
    throw new Error(`an STL of ${n} triangles is ${84 + n * 50} bytes, not ${bytes.length}`);
  }
  const p: number[] = [];
  const t: number[] = [];
  for (let i = 0; i < n; i++) {
    const o = 84 + i * 50;
    for (let k = 0; k < 9; k++) {
      p.push(dv.getFloat32(o + 12 + k * 4, true));
    }
    t.push(i * 3, i * 3 + 1, i * 3 + 2);
  }

  return { p, t };
}
const bytesOf = async (b: Blob) => new Uint8Array(await b.arrayBuffer());
{
  const stl = measure(readSTL(await bytesOf(await exportBodies(features, 'stl'))));
  check('STL: a binary file of the right length, both bodies in it', stl.tris > 1000, `${stl.tris} triangles`);
  check("STL: the model's volume (the two together)", sameVolume(stl.vol, V.flange + V.block), `${stl.vol.toFixed(1)} / ${(V.flange + V.block).toFixed(1)}`);
  check("STL: closed all over (every side of every triangle met by its neighbour's)", stl.open === 0, `${stl.open} sides unmatched`);
  check('STL: millimetres, where the model is (the flange 160 across, the block out at 200 to 220)', near(stl.lo[0], -80, 0.02) && near(stl.hi[0], 220, 1e-3) && near(stl.lo[2], 0, 1e-3) && near(stl.hi[2], 65, 1e-3), `${stl.lo.map(v => v.toFixed(2))} .. ${stl.hi.map(v => v.toFixed(2))}`);
  const one = measure(readSTL(await bytesOf(await exportBodies(features, 'stl', ['Block']))));
  check('STL of one chosen body: that body alone (the block: 12 triangles, 1,000 mm³)', one.tris === 12 && near(one.vol, 1000, 1e-3) && one.open === 0, `${one.tris} triangles, ${one.vol}`);
}

// ---- STEP: read back in as a model, it is the same solids
{
  const blob = await exportBodies(features, 'step');
  const text = new TextDecoder().decode(await bytesOf(blob));
  check('STEP: a STEP file, with both bodies named', text.startsWith('ISO-10303-21;') && /END-ISO-10303-21;\s*$/.test(text) && text.includes("'Body 1'") && text.includes("'Body 2'"), `${text.length} characters`);
  check('STEP: in millimetres', /SI_UNIT\(\s*\.MILLI\.\s*,\s*\.METRE\.\s*\)/.test(text));
  const back: Feature = { id: 'In', name: 'Imported', type: 'import', format: 'step', fileName: 'x.step', data: Buffer.from(text, 'utf8').toString('base64'), apart: true } as Feature;
  const r = await after([back]);
  const got = [...bodies().values()].map(b => volume(b as Shape3D)).sort((a, b) => a - b);
  check('STEP read back in: two bodies again, the same solids, exact (round faces still round)', !r.errors.length && got.length === 2 && near(got[0], V.block, 1e-3) && near(got[1], V.flange, 0.05), `${got.map(v => v.toFixed(2))} ${r.errors.join('; ')}`);
  // (A file put in before bodies came in apart: one body of the two pieces, as it was.)
  const old = await after([{ ...back, apart: undefined } as Feature]);
  check('  a file put in before that: still one body of both pieces', !old.errors.length && bodies().size === 1 && near(volume([...bodies().values()][0] as Shape3D), V.flange + V.block, 0.05));
  const one = new TextDecoder().decode(await bytesOf(await exportBodies(features, 'step', [flangeId])));
  const oneBack = await after([{ ...back, data: Buffer.from(one, 'utf8').toString('base64') } as Feature]);
  check('STEP of one chosen body: that body alone', !oneBack.errors.length && bodies().size === 1 && near(volume([...bodies().values()][0] as Shape3D), V.flange, 0.05) && one.length < text.length);
}

// ---- 3MF: the meshes, and the exact model packed with them
{
  const meshes = JSON.parse(await (await exportBodies(features, 'mesh')).text()) as { id: string; positions: number[]; indices: number[] }[];
  check("the print mesh of each body: closed, the body's volume", meshes.length === 2 && meshes.every((m) => {
    const x = measure({ p: m.positions, t: m.indices });

    return x.open === 0 && sameVolume(x.vol, m.id === 'Block' ? V.block : V.flange);
  }), meshes.map(m => `${m.id.slice(0, 8)} ${measure({ p: m.positions, t: m.indices }).vol.toFixed(1)}`).join(', '));
  const file = await bytesOf(await exportThreeMF(meshes.map(m => ({ name: m.id === 'Block' ? 'Block' : 'Flange', positions: new Float32Array(m.positions), indices: new Uint32Array(m.indices), color: m.id === 'Block' ? '#ff8800' : undefined })), 'Flange & <block>', await exportBodies(features, 'step')));
  check('3MF: a ZIP (starts PK)', file[0] === 0x50 && file[1] === 0x4b);
  const parts = await unzip(file);
  const model = new TextDecoder().decode(parts.get('3D/3dmodel.model') ?? new Uint8Array());
  check('3MF: its parts are there (types, relations, the model, the STEP attached)', ['[Content_Types].xml', '_rels/.rels', '3D/3dmodel.model', 'Attachments/model.step'].every(n => parts.has(n)), [...parts.keys()].join(', '));
  check('3MF: millimetres, a title that is safe to read, two objects built', /unit="millimeter"/.test(model) && model.includes('Flange &amp; &lt;block&gt;') && (model.match(/<object /g) ?? []).length === 2 && (model.match(/<item /g) ?? []).length === 2);
  // Each object's mesh, read out of the file.
  const objects = [...model.matchAll(/<object [^>]*name="([^"]*)"[^>]*>([\s\S]*?)<\/object>/g)].map((m) => {
    const p = [...m[2].matchAll(/<vertex x="([^"]+)" y="([^"]+)" z="([^"]+)"/g)].flatMap(v => [+v[1], +v[2], +v[3]]);
    const t = [...m[2].matchAll(/<triangle v1="(\d+)" v2="(\d+)" v3="(\d+)"/g)].flatMap(v => [+v[1], +v[2], +v[3]]);

    return { name: m[1], ...measure({ p, t }), max: Math.max(...t), count: p.length / 3 };
  });
  check("3MF: each object closed, its volume the body's, every corner it names there", objects.every(o => o.open === 0 && o.max < o.count && sameVolume(o.vol, o.name === 'Block' ? V.block : V.flange)), objects.map(o => `${o.name} ${o.vol.toFixed(1)} (${o.tris} triangles, ${o.open} open)`).join(', '));
  check("3MF: the block's colour is in it", /displaycolor="#FF8800FF"/.test(model) && /name="Block" pid="1" pindex="0"/.test(model));
  const inside = await read3mf(file);
  check('3MF opened again in the app: the exact model inside is what is read', inside.format === 'step' && new TextDecoder().decode(inside.bytes).startsWith('ISO-10303-21;'));
}

// ---- GLB
{
  const meshes = JSON.parse(await (await exportBodies(features, 'mesh')).text()) as { id: string; positions: number[]; indices: number[] }[];
  const out = glb(meshes.map(m => ({ name: m.id === 'Block' ? 'Block' : 'Flange', positions: new Float32Array(m.positions), indices: new Uint32Array(m.indices), color: '#3d8bff', opacity: m.id === 'Block' ? 0.5 : 1 })), 'Flange');
  const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
  const jsonLen = dv.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(out.subarray(20, 20 + jsonLen)));
  const binAt = 20 + jsonLen;
  const binLen = dv.getUint32(binAt, true);
  check('GLB: glTF 2, as long as it says, its two parts on four-byte bounds', dv.getUint32(0, true) === 0x46546c67 && dv.getUint32(4, true) === 2 && dv.getUint32(8, true) === out.length && dv.getUint32(16, true) === 0x4e4f534a && dv.getUint32(binAt + 4, true) === 0x004e4942 && jsonLen % 4 === 0 && binLen % 4 === 0 && binAt + 8 + binLen === out.length, `${out.length} bytes`);
  check('GLB: two meshes named, under a root that makes Z up into Y up and millimetres into metres', json.meshes.length === 2 && json.nodes[0].scale.every((s: number) => s === 0.001) && near(json.nodes[0].rotation[0], -Math.SQRT1_2, 1e-9) && json.nodes.slice(1).map((n: any) => n.name).join() === 'Flange,Block');
  // Its numbers read back out of the binary part.
  const bin = out.subarray(binAt + 8, binAt + 8 + binLen);
  const read = (acc: number) => {
    const a = json.accessors[acc];
    const v = json.bufferViews[a.bufferView];
    const n = a.count * (a.type === 'VEC3' ? 3 : 1);
    const at = bin.byteOffset + v.byteOffset;

    return a.componentType === 5126 ? Array.from(new Float32Array(bin.buffer.slice(at, at + n * 4))) : Array.from(new Uint32Array(bin.buffer.slice(at, at + n * 4)));
  };
  const got = json.meshes.map((m: any) => ({ name: m.name, ...measure({ p: read(m.primitives[0].attributes.POSITION), t: read(m.primitives[0].indices) }), normals: read(m.primitives[0].attributes.NORMAL), acc: json.accessors[m.primitives[0].attributes.POSITION] }));
  check("GLB: each mesh closed, its volume the body's, its box as the file says", got.every((g: any) => g.open === 0 && sameVolume(g.vol, g.name === 'Block' ? V.block : V.flange) && g.lo.every((v: number, j: number) => near(v, g.acc.min[j], 1e-4)) && g.hi.every((v: number, j: number) => near(v, g.acc.max[j], 1e-4))), got.map((g: any) => `${g.name} ${g.vol.toFixed(1)}`).join(', '));
  check('GLB: a normal of length 1 at every corner', got.every((g: any) => g.normals.length === g.acc.count * 3 && g.normals.every((_: number, i: number) => i % 3 || near(Math.hypot(g.normals[i], g.normals[i + 1], g.normals[i + 2]), 1, 1e-4))));
  check('GLB: the see-through block says so', json.materials[1].alphaMode === 'BLEND' && near(json.materials[1].pbrMetallicRoughness.baseColorFactor[3], 0.5, 1e-9) && json.materials[0].alphaMode === undefined);
}

// ---- the project file
{
  const saved = JSON.stringify({ ...doc, features });
  const opened = parseProject(saved);
  check('the project saved and opened: every step and variable as it was', JSON.stringify(opened.features) === JSON.stringify(features) && JSON.stringify(opened.variables) === JSON.stringify(doc.variables) && opened.units === doc.units);
  const again = await after(opened.features as Feature[]);
  const vols = [...bodies().values()].map(b => volume(b as Shape3D)).sort((a, b) => a - b);
  check('  and built again: the same two bodies', !again.errors.length && near(vols[0], V.block, 1e-6) && near(vols[1], V.flange, 1e-6));
}
done();
