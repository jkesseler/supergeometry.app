// More file formats: GLB out (glTF's one-file form, for the web, AR and
// renderers) and 3MF in (slicer files: the exact model packed in one of ours,
// else its meshes).

import { MESH_MAX, TooBig } from '../kernel/protocol';

// ------------------------------------------------------------------ unzip

/** A small file can unpack to gigabytes (a "ZIP bomb"): past this much it is refused. */
const MAX_UNPACKED_BYTES = 512 * 2 ** 20;
const TOO_BIG_UNPACKED = 'it unpacks to more than 512 MB';

/** The files of a ZIP archive (what 3MF is), by name. */
export async function unzip(bytes: Uint8Array): Promise<Map<string, Uint8Array>> {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) {
    throw new Error("it isn't a ZIP-based file, or it is damaged");
  }
  const count = dv.getUint16(end + 10, true);
  let at = dv.getUint32(end + 16, true);
  const out = new Map<string, Uint8Array>();
  const dec = new TextDecoder();
  let unpacked = 0;
  for (let entry = 0; entry < count; entry++) {
    if (dv.getUint32(at, true) !== 0x02014b50) {
      throw new Error('the file is damaged');
    }
    const method = dv.getUint16(at + 10, true);
    const packed = dv.getUint32(at + 20, true);
    const nameLength = dv.getUint16(at + 28, true);
    const extra = dv.getUint16(at + 30, true);
    const comment = dv.getUint16(at + 32, true);
    const local = dv.getUint32(at + 42, true);
    const name = dec.decode(bytes.subarray(at + 46, at + 46 + nameLength));
    const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
    const data = bytes.subarray(start, start + packed);
    if (!name.endsWith('/')) {
      const file = method === 8 ? await inflate(data, MAX_UNPACKED_BYTES - unpacked) : data;
      unpacked += file.length;
      if (unpacked > MAX_UNPACKED_BYTES) {
        throw new Error(TOO_BIG_UNPACKED);
      }
      out.set(name, file);
    }
    at += 46 + nameLength + extra + comment;
  }

  return out;
}

async function inflate(bytes: Uint8Array, maxBytes: number): Promise<Uint8Array> {
  const reader = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    size += value.length;
    if (size > maxBytes) {
      await reader.cancel();
      throw new Error(TOO_BIG_UNPACKED);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }

  return out;
}

// -------------------------------------------------------------------- 3MF

const UNIT_MM: Record<string, number> = { micron: 0.001, millimeter: 1, centimeter: 10, inch: 25.4, foot: 304.8, meter: 1000 };
const attrs = (text: string) => Object.fromEntries([...text.matchAll(/([\w:]+)\s*=\s*"([^"]*)"/g)].map(match => [match[1].replace(/^\w+:/, ''), match[2]]));
type M = number[];
/** 3MF's 3×4 matrix ("m00 m01 m02 m10 … m32"), points as rows: point·matrix. */
const matrix = (t?: string): M => (t ? t.trim().split(/\s+/).map(Number) : [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]);
const apply = (matrix: M, point: number[]) => [point[0] * matrix[0] + point[1] * matrix[3] + point[2] * matrix[6] + matrix[9], point[0] * matrix[1] + point[1] * matrix[4] + point[2] * matrix[7] + matrix[10], point[0] * matrix[2] + point[1] * matrix[5] + point[2] * matrix[8] + matrix[11]];
/** a then b. */
const compose = (a: M, b: M): M => {
  const product: M = [];
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      product[3 * i + j] = a[3 * i] * b[j] + a[3 * i + 1] * b[3 + j] + a[3 * i + 2] * b[6 + j];
    }
  }
  const t = apply(b, [a[9], a[10], a[11]]);

  return [...product, ...t];
};

/** An object's triangles and placements, its parts' included. */
interface PartCount {
  triangles: number;
  placements: number;
}

/**
 * A 3MF file as something to import: the exact STEP model when it carries one
 * (ours do), else its meshes - each build item, its components placed - as a
 * binary STL, in millimetres.
 */
export async function read3mf(bytes: Uint8Array): Promise<{ format: 'step' | 'stl'; bytes: Uint8Array }> {
  const files = await unzip(bytes);
  for (const [name, data] of files) {
    if (/\.(step|stp)$/i.test(name)) {
      return { format: 'step', bytes: data };
    }
  }
  const modelName = [...files.keys()].find(name => /^\/?3D\/.*\.model$/i.test(name));
  if (!modelName) {
    throw new Error('it has no 3D model in it');
  }
  const xml = new TextDecoder().decode(files.get(modelName));
  const unit = UNIT_MM[attrs(xml.match(/<(?:\w+:)?model\b([^>]*)>/)?.[1] ?? '').unit ?? 'millimeter'] ?? 1;
  type Obj = { v: number[][]; t: number[][]; parts: { id: string; m: M }[] };
  const objects = new Map<string, Obj>();
  for (const match of xml.matchAll(/<(?:\w+:)?object\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?object>)/g)) {
    const body = match[2] ?? '';
    const vertices = [...body.matchAll(/<(?:\w+:)?vertex\b([^>]*)>/g)].map((vertexMatch) => {
      const a = attrs(vertexMatch[1]);

      return [Number(a.x), Number(a.y), Number(a.z)];
    });
    const t = [...body.matchAll(/<(?:\w+:)?triangle\b([^>]*)>/g)].map((triangleMatch) => {
      const a = attrs(triangleMatch[1]);

      return [Number(a.v1), Number(a.v2), Number(a.v3)];
    });
    const parts = [...body.matchAll(/<(?:\w+:)?component\b([^>]*)>/g)].map((componentMatch) => {
      const a = attrs(componentMatch[1]);

      return { id: a.objectid, m: matrix(a.transform) };
    });
    objects.set(attrs(match[1]).id, { v: vertices, t, parts });
  }
  const tris: number[][][] = [];
  const add = (id: string, matrix: M, depth: number) => {
    const obj = objects.get(id);
    if (!obj || depth > 16) {
      return;
    }
    for (const [a, b, indexC] of obj.t) {
      if (![a, b, indexC].every(vertex => Number.isInteger(vertex) && vertex >= 0 && vertex < obj.v.length)) {
        continue;
      }
      tris.push([a, b, indexC].map(vertex => apply(matrix, obj.v[vertex]).map(x => x * unit)));
    }
    for (const part of obj.parts) {
      add(part.id, compose(part.m, matrix), depth + 1);
    }
  };
  const items = [...xml.matchAll(/<(?:\w+:)?item\b([^>]*)>/g)].map(match => attrs(match[1]));
  const roots = items.length
    ? items.map(it => ({ id: it.objectid, m: matrix(it.transform) }))
    : [...objects.keys()].map(id => ({ id, m: matrix() }));
  // Parts placed inside parts multiply (ten per level, sixteen deep: 10^16), so they are counted before any is made.
  const counted = new Map<string, PartCount>();
  const countOf = (id: string, depth: number): PartCount => {
    const obj = objects.get(id);
    if (!obj || depth > 16) {
      return { triangles: 0, placements: 0 };
    }
    const key = `${id} ${depth}`;
    let count = counted.get(key);
    if (!count) {
      count = { triangles: obj.t.length, placements: 1 };
      for (const part of obj.parts) {
        const inner = countOf(part.id, depth + 1);
        count.triangles += inner.triangles;
        count.placements += inner.placements;
      }
      counted.set(key, count);
    }

    return count;
  };
  const total: PartCount = { triangles: 0, placements: 0 };
  for (const root of roots) {
    const count = countOf(root.id, 0);
    total.triangles += count.triangles;
    total.placements += count.placements;
  }
  if (total.triangles > MESH_MAX) {
    throw new TooBig(total.triangles);
  }
  if (total.placements > MESH_MAX) {
    throw new Error(`it places its parts ${total.placements.toLocaleString('en-US')} times - more than can be brought in`);
  }
  for (const root of roots) {
    add(root.id, root.m, 0);
  }
  if (!tris.length) {
    throw new Error('it has no triangles in it');
  }

  return { format: 'stl', bytes: stlOf(tris) };
}

/** Triangles as a binary STL (normals left zero: readers work them out). */
function stlOf(tris: number[][][]): Uint8Array {
  const buf = new ArrayBuffer(84 + tris.length * 50);
  const dv = new DataView(buf);
  dv.setUint32(80, tris.length, true);
  let offset = 84;
  for (const t of tris) {
    offset += 12;
    for (const point of t) {
      for (const x of point) {
        (dv.setFloat32(offset, x, true), (offset += 4));
      }
    }
    offset += 2;
  }

  return new Uint8Array(buf);
}

// -------------------------------------------------------------------- GLB

export interface GlbBody {
  name: string;
  positions: Float32Array;
  indices: Uint32Array;
  /** "#rrggbb" */
  color?: string;
  opacity?: number;
}

/** sRGB "#rrggbb" to glTF's linear colour. */
const linear = (hex: string) =>
  [1, 3, 5].map((i) => {
    const channel = parseInt(hex.slice(i, i + 2), 16) / 255;

    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });

/**
 * The bodies as one GLB: a mesh each (smooth normals, its colour), named,
 * under a root that turns Z up into glTF's Y up and millimetres into metres.
 */
export function glb(bodies: GlbBody[], title: string): Uint8Array {
  const chunks: Uint8Array[] = [];
  let length = 0;
  const views: object[] = [];
  const accessors: object[] = [];
  const push = (data: ArrayBufferView, target: number) => {
    const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    views.push({ buffer: 0, byteOffset: length, byteLength: bytes.length, target });
    chunks.push(bytes);
    length += bytes.length;
    const pad = (4 - (length % 4)) % 4;
    if (pad) {
      (chunks.push(new Uint8Array(pad)), (length += pad));
    }

    return views.length - 1;
  };
  const meshes: object[] = [];
  const materials: object[] = [];
  const nodes: object[] = [{ name: title, rotation: [-Math.SQRT1_2, 0, 0, Math.SQRT1_2], scale: [0.001, 0.001, 0.001], children: bodies.map((_, i) => i + 1) }];
  bodies.forEach((b, i) => {
    const positions = b.positions;
    const values = new Float32Array(positions.length);
    // Smooth normals: each corner's, from the triangles round it (weighted by their size).
    for (let t = 0; t < b.indices.length; t += 3) {
      const [a, indexB, indexC] = [b.indices[t], b.indices[t + 1], b.indices[t + 2]];
      const edgeU = [positions[3 * indexB] - positions[3 * a], positions[3 * indexB + 1] - positions[3 * a + 1], positions[3 * indexB + 2] - positions[3 * a + 2]];
      const edgeV = [positions[3 * indexC] - positions[3 * a], positions[3 * indexC + 1] - positions[3 * a + 1], positions[3 * indexC + 2] - positions[3 * a + 2]];
      const x = [edgeU[1] * edgeV[2] - edgeU[2] * edgeV[1], edgeU[2] * edgeV[0] - edgeU[0] * edgeV[2], edgeU[0] * edgeV[1] - edgeU[1] * edgeV[0]];
      for (const vertex of [a, indexB, indexC]) {
        for (let j = 0; j < 3; j++) {
          values[3 * vertex + j] += x[j];
        }
      }
    }
    for (let offset = 0; offset < values.length; offset += 3) {
      const length = Math.hypot(values[offset], values[offset + 1], values[offset + 2]) || 1;
      values[offset] /= length;
      values[offset + 1] /= length;
      values[offset + 2] /= length;
    }
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let offset = 0; offset < positions.length; offset += 3) {
      for (let j = 0; j < 3; j++) {
        min[j] = Math.min(min[j], positions[offset + j]);
        max[j] = Math.max(max[j], positions[offset + j]);
      }
    }
    const count = positions.length / 3;
    accessors.push({ bufferView: push(new Float32Array(positions), 34962), componentType: 5126, count, type: 'VEC3', min, max });
    accessors.push({ bufferView: push(values, 34962), componentType: 5126, count, type: 'VEC3' });
    accessors.push({ bufferView: push(new Uint32Array(b.indices), 34963), componentType: 5125, count: b.indices.length, type: 'SCALAR' });
    const alpha = b.opacity ?? 1;
    materials.push({
      name: b.name,
      pbrMetallicRoughness: { baseColorFactor: [...linear(b.color ?? '#b8bcc6'), alpha], metallicFactor: 0, roughnessFactor: 0.6 },
      ...(alpha < 1 ? { alphaMode: 'BLEND' } : {})
    });
    meshes.push({ name: b.name, primitives: [{ attributes: { POSITION: 3 * i, NORMAL: 3 * i + 1 }, indices: 3 * i + 2, material: i }] });
    nodes.push({ name: b.name, mesh: i });
  });
  const json = {
    asset: { version: '2.0', generator: 'superGeometry.app' },
    scene: 0,
    scenes: [{ name: title, nodes: [0] }],
    nodes,
    meshes,
    materials,
    accessors,
    bufferViews: views,
    buffers: [{ byteLength: length }]
  };
  let jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const jpad = (4 - (jsonBytes.length % 4)) % 4;
  if (jpad) {
    const padded = new Uint8Array(jsonBytes.length + jpad).fill(0x20);
    padded.set(jsonBytes);
    jsonBytes = padded;
  }
  const total = 12 + 8 + jsonBytes.length + 8 + length;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true); // "glTF"
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, jsonBytes.length, true);
  dv.setUint32(16, 0x4e4f534a, true); // "JSON"
  out.set(jsonBytes, 20);
  let cursor = 20 + jsonBytes.length;
  dv.setUint32(cursor, length, true);
  dv.setUint32(cursor + 4, 0x004e4942, true); // "BIN"
  cursor += 8;
  for (const chunk of chunks) {
    (out.set(chunk, cursor), (cursor += chunk.length));
  }

  return out;
}
