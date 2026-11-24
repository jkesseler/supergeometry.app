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
const volumes = { flange: volume(bodies().get(flangeId) as Shape3D), block: volume(bodies().get('Block') as Shape3D) };
check('the model: a flange and a block, no errors', !errors.length && all.length === 2 && near(volumes.block, 1000, 1e-6) && near(volumes.flange, 429515.41, 0.05), `${all.length} bodies, ${volumes.flange.toFixed(2)} + ${volumes.block}`);

// ---- what a mesh is worth: its volume, its box, whether it is closed
type Mesh = { p: number[]; t: number[] };
function measure(mesh: Mesh) {
  let vol = 0;
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  const key = (i: number) => `${mesh.p[3 * i].toFixed(4)},${mesh.p[3 * i + 1].toFixed(4)},${mesh.p[3 * i + 2].toFixed(4)}`;
  const edges = new Map<string, number>();
  for (let index = 0; index < mesh.t.length; index += 3) {
    const [a, b, indexC] = [mesh.t[index], mesh.t[index + 1], mesh.t[index + 2]];
    const point = (i: number) => [mesh.p[3 * i], mesh.p[3 * i + 1], mesh.p[3 * i + 2]];
    const [pointA, pointB, pointC] = [point(a), point(b), point(indexC)];
    vol += (pointA[0] * (pointB[1] * pointC[2] - pointB[2] * pointC[1]) - pointA[1] * (pointB[0] * pointC[2] - pointB[2] * pointC[0]) + pointA[2] * (pointB[0] * pointC[1] - pointB[1] * pointC[0])) / 6;
    for (const q of [pointA, pointB, pointC]) {
      for (let j = 0; j < 3; j++) {
        (lo[j] = Math.min(lo[j], q[j])), (hi[j] = Math.max(hi[j], q[j]));
      }
    }
    // Each side of each triangle, with its direction: a closed skin has every side once each way.
    for (const [from, to] of [[a, b], [b, indexC], [indexC, a]]) {
      const [ku, kv] = [key(from), key(to)];
      if (ku === kv) {
        continue;
      }
      edges.set(`${ku}>${kv}`, (edges.get(`${ku}>${kv}`) ?? 0) + 1);
    }
  }
  let open = 0;
  for (const [e, edge] of edges) {
    const [from, to] = e.split('>');
    if ((edges.get(`${to}>${from}`) ?? 0) !== edge) {
      open++;
    }
  }

  return { vol, lo, hi, open, tris: mesh.t.length / 3 };
}
// (A mesh of flat facets inside a round body holds a little less than the body: within 0.01 mm of it everywhere.)
const sameVolume = (got: number, want: number) => got <= want + 1e-3 && got > want * 0.998;

// ---- STL
function readSTL(bytes: Uint8Array): Mesh {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const triangleCount = dv.getUint32(80, true);
  if (bytes.length !== 84 + triangleCount * 50) {
    throw new Error(`an STL of ${triangleCount} triangles is ${84 + triangleCount * 50} bytes, not ${bytes.length}`);
  }
  const positions: number[] = [];
  const t: number[] = [];
  for (let i = 0; i < triangleCount; i++) {
    const offset = 84 + i * 50;
    for (let slot = 0; slot < 9; slot++) {
      positions.push(dv.getFloat32(offset + 12 + slot * 4, true));
    }
    t.push(i * 3, i * 3 + 1, i * 3 + 2);
  }

  return { p: positions, t };
}
const bytesOf = async (b: Blob) => new Uint8Array(await b.arrayBuffer());
{
  const stl = measure(readSTL(await bytesOf(await exportBodies(features, 'stl'))));
  check('STL: a binary file of the right length, both bodies in it', stl.tris > 1000, `${stl.tris} triangles`);
  check("STL: the model's volume (the two together)", sameVolume(stl.vol, volumes.flange + volumes.block), `${stl.vol.toFixed(1)} / ${(volumes.flange + volumes.block).toFixed(1)}`);
  check("STL: closed all over (every side of every triangle met by its neighbour's)", stl.open === 0, `${stl.open} sides unmatched`);
  check('STL: millimetres, where the model is (the flange 160 across, the block out at 200 to 220)', near(stl.lo[0], -80, 0.02) && near(stl.hi[0], 220, 1e-3) && near(stl.lo[2], 0, 1e-3) && near(stl.hi[2], 65, 1e-3), `${stl.lo.map(value => value.toFixed(2))} .. ${stl.hi.map(value => value.toFixed(2))}`);
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
  const result = await after([back]);
  const got = [...bodies().values()].map(b => volume(b as Shape3D)).sort((a, b) => a - b);
  check('STEP read back in: two bodies again, the same solids, exact (round faces still round)', !result.errors.length && got.length === 2 && near(got[0], volumes.block, 1e-3) && near(got[1], volumes.flange, 0.05), `${got.map(value => value.toFixed(2))} ${result.errors.join('; ')}`);
  // (A file put in before bodies came in apart: one body of the two pieces, as it was.)
  const old = await after([{ ...back, apart: undefined } as Feature]);
  check('  a file put in before that: still one body of both pieces', !old.errors.length && bodies().size === 1 && near(volume([...bodies().values()][0] as Shape3D), volumes.flange + volumes.block, 0.05));
  const one = new TextDecoder().decode(await bytesOf(await exportBodies(features, 'step', [flangeId])));
  const oneBack = await after([{ ...back, data: Buffer.from(one, 'utf8').toString('base64') } as Feature]);
  check('STEP of one chosen body: that body alone', !oneBack.errors.length && bodies().size === 1 && near(volume([...bodies().values()][0] as Shape3D), volumes.flange, 0.05) && one.length < text.length);
}

// ---- 3MF: the meshes, and the exact model packed with them
{
  const meshes = JSON.parse(await (await exportBodies(features, 'mesh')).text()) as { id: string; positions: number[]; indices: number[] }[];
  check("the print mesh of each body: closed, the body's volume", meshes.length === 2 && meshes.every((mesh) => {
    const x = measure({ p: mesh.positions, t: mesh.indices });

    return x.open === 0 && sameVolume(x.vol, mesh.id === 'Block' ? volumes.block : volumes.flange);
  }), meshes.map(mesh => `${mesh.id.slice(0, 8)} ${measure({ p: mesh.positions, t: mesh.indices }).vol.toFixed(1)}`).join(', '));
  const file = await bytesOf(await exportThreeMF(meshes.map(mesh => ({ name: mesh.id === 'Block' ? 'Block' : 'Flange', positions: new Float32Array(mesh.positions), indices: new Uint32Array(mesh.indices), color: mesh.id === 'Block' ? '#ff8800' : undefined })), 'Flange & <block>', await exportBodies(features, 'step')));
  check('3MF: a ZIP (starts PK)', file[0] === 0x50 && file[1] === 0x4b);
  const parts = await unzip(file);
  const model = new TextDecoder().decode(parts.get('3D/3dmodel.model') ?? new Uint8Array());
  check('3MF: its parts are there (types, relations, the model, the STEP attached)', ['[Content_Types].xml', '_rels/.rels', '3D/3dmodel.model', 'Attachments/model.step'].every(name => parts.has(name)), [...parts.keys()].join(', '));
  check('3MF: millimetres, a title that is safe to read, two objects built', /unit="millimeter"/.test(model) && model.includes('Flange &amp; &lt;block&gt;') && (model.match(/<object /g) ?? []).length === 2 && (model.match(/<item /g) ?? []).length === 2);
  // Each object's mesh, read out of the file.
  const objects = [...model.matchAll(/<object [^>]*name="([^"]*)"[^>]*>([\s\S]*?)<\/object>/g)].map((match) => {
    const positions = [...match[2].matchAll(/<vertex x="([^"]+)" y="([^"]+)" z="([^"]+)"/g)].flatMap(found => [+found[1], +found[2], +found[3]]);
    const t = [...match[2].matchAll(/<triangle v1="(\d+)" v2="(\d+)" v3="(\d+)"/g)].flatMap(found => [+found[1], +found[2], +found[3]]);

    return { name: match[1], ...measure({ p: positions, t }), max: Math.max(...t), count: positions.length / 3 };
  });
  check("3MF: each object closed, its volume the body's, every corner it names there", objects.every(object => object.open === 0 && object.max < object.count && sameVolume(object.vol, object.name === 'Block' ? volumes.block : volumes.flange)), objects.map(object => `${object.name} ${object.vol.toFixed(1)} (${object.tris} triangles, ${object.open} open)`).join(', '));
  check("3MF: the block's colour is in it", /displaycolor="#FF8800FF"/.test(model) && /name="Block" pid="1" pindex="0"/.test(model));
  const inside = await read3mf(file);
  check('3MF opened again in the app: the exact model inside is what is read', inside.format === 'step' && new TextDecoder().decode(inside.bytes).startsWith('ISO-10303-21;'));
}

// ---- GLB
{
  const meshes = JSON.parse(await (await exportBodies(features, 'mesh')).text()) as { id: string; positions: number[]; indices: number[] }[];
  const out = glb(meshes.map(mesh => ({ name: mesh.id === 'Block' ? 'Block' : 'Flange', positions: new Float32Array(mesh.positions), indices: new Uint32Array(mesh.indices), color: '#3d8bff', opacity: mesh.id === 'Block' ? 0.5 : 1 })), 'Flange');
  const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
  const jsonLen = dv.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(out.subarray(20, 20 + jsonLen)));
  const binAt = 20 + jsonLen;
  const binLen = dv.getUint32(binAt, true);
  check('GLB: glTF 2, as long as it says, its two parts on four-byte bounds', dv.getUint32(0, true) === 0x46546c67 && dv.getUint32(4, true) === 2 && dv.getUint32(8, true) === out.length && dv.getUint32(16, true) === 0x4e4f534a && dv.getUint32(binAt + 4, true) === 0x004e4942 && jsonLen % 4 === 0 && binLen % 4 === 0 && binAt + 8 + binLen === out.length, `${out.length} bytes`);
  check('GLB: two meshes named, under a root that makes Z up into Y up and millimetres into metres', json.meshes.length === 2 && json.nodes[0].scale.every((scale: number) => scale === 0.001) && near(json.nodes[0].rotation[0], -Math.SQRT1_2, 1e-9) && json.nodes.slice(1).map((node: any) => node.name).join() === 'Flange,Block');
  // Its numbers read back out of the binary part.
  const bin = out.subarray(binAt + 8, binAt + 8 + binLen);
  const read = (acc: number) => {
    const a = json.accessors[acc];
    const bufferView = json.bufferViews[a.bufferView];
    const count = a.count * (a.type === 'VEC3' ? 3 : 1);
    const at = bin.byteOffset + bufferView.byteOffset;

    return a.componentType === 5126 ? Array.from(new Float32Array(bin.buffer.slice(at, at + count * 4))) : Array.from(new Uint32Array(bin.buffer.slice(at, at + count * 4)));
  };
  const got = json.meshes.map((mesh: any) => ({ name: mesh.name, ...measure({ p: read(mesh.primitives[0].attributes.POSITION), t: read(mesh.primitives[0].indices) }), normals: read(mesh.primitives[0].attributes.NORMAL), acc: json.accessors[mesh.primitives[0].attributes.POSITION] }));
  check("GLB: each mesh closed, its volume the body's, its box as the file says", got.every((mesh: any) => mesh.open === 0 && sameVolume(mesh.vol, mesh.name === 'Block' ? volumes.block : volumes.flange) && mesh.lo.every((value: number, j: number) => near(value, mesh.acc.min[j], 1e-4)) && mesh.hi.every((value: number, j: number) => near(value, mesh.acc.max[j], 1e-4))), got.map((mesh: any) => `${mesh.name} ${mesh.vol.toFixed(1)}`).join(', '));
  check('GLB: a normal of length 1 at every corner', got.every((mesh: any) => mesh.normals.length === mesh.acc.count * 3 && mesh.normals.every((_: number, i: number) => i % 3 || near(Math.hypot(mesh.normals[i], mesh.normals[i + 1], mesh.normals[i + 2]), 1, 1e-4))));
  check('GLB: the see-through block says so', json.materials[1].alphaMode === 'BLEND' && near(json.materials[1].pbrMetallicRoughness.baseColorFactor[3], 0.5, 1e-9) && json.materials[0].alphaMode === undefined);
}

// ---- the project file
{
  const saved = JSON.stringify({ ...doc, features });
  const opened = parseProject(saved);
  check('the project saved and opened: every step and variable as it was', JSON.stringify(opened.features) === JSON.stringify(features) && JSON.stringify(opened.variables) === JSON.stringify(doc.variables) && opened.units === doc.units);
  const again = await after(opened.features as Feature[]);
  const vols = [...bodies().values()].map(b => volume(b as Shape3D)).sort((a, b) => a - b);
  check('  and built again: the same two bodies', !again.errors.length && near(vols[0], volumes.block, 1e-6) && near(vols[1], volumes.flange, 1e-6));
}
done();
