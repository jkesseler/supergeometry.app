// Drawing views from the bodies' meshes: hidden line removal by a depth
// buffer, for models OpenCascade's exact one takes too long on (a freeform
// body took it 20 s a view). The edges are the mesh's own edge lines (which lie
// on its triangles), the outlines of curved faces come from the mesh normals.
import { getOC } from 'replicad';
import { cylinderOf } from './faceEdit';
import { normalOnEdge } from './ocFree';
import type { BodyMesh, ViewBody, ViewEdge, ViewSpec } from './protocol';
import type { Shape3D } from 'replicad';

type V3 = [number, number, number];
type P2 = [number, number];

const r3 = (value: number) => String(Math.round(value * 1000) / 1000);
const rr = (point: P2): P2 => [Math.round(point[0] * 1000) / 1000, Math.round(point[1] * 1000) / 1000];

/** A line, or a circle seen face on (its centre found from three of its points), as a view edge. */
export function viewEdge(kind: 'line' | 'circle' | 'other', pts: P2[]): ViewEdge | undefined {
  if (kind === 'line') {
    return { a: rr(pts[0]), b: rr(pts[pts.length - 1]) };
  }
  if (kind !== 'circle' || pts.length < 3) {
    return undefined;
  }
  const a = pts[0];
  const b = pts[pts.length - 1];
  const closed = Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-6;
  const p1 = pts[Math.round(pts.length / 3)];
  const p2 = pts[Math.min(pts.length - 1, Math.round((2 * pts.length) / 3))];
  const point = pts[Math.round(pts.length / 2)];
  // The circle through a, p1, p2.
  const [ax, ay] = a;
  const [bx, by] = p1;
  const [cx, cy] = p2;
  const denominator = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
  if (Math.abs(denominator) < 1e-12) {
    return undefined;
  }
  const ux = ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay) + (cx * cx + cy * cy) * (ay - by)) / denominator;
  const uy = ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx) + (cx * cx + cy * cy) * (bx - ax)) / denominator;
  const radius = Math.hypot(ax - ux, ay - uy);

  return { a: rr(a), m: rr(point), b: closed ? rr(a) : rr(b), c: rr([ux, uy]), r: Math.round(radius * 1000) / 1000 };
}

/** On the body's seen edges, the point nearest the middle of them (where a balloon's leader ends). */
export function anchorOf(lines: P2[][]): P2 | undefined {
  if (!lines.length) {
    return undefined;
  }
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const line of lines) {
    for (const [x, y] of line) {
      (x0 = Math.min(x0, x)), (x1 = Math.max(x1, x)), (y0 = Math.min(y0, y)), (y1 = Math.max(y1, y));
    }
  }
  const center: P2 = [(x0 + x1) / 2, (y0 + y1) / 2];
  let best = lines[0][0];
  let bd = Infinity;
  for (const line of lines) {
    for (let i = 1; i < line.length; i++) {
      const [a, b] = [line[i - 1], line[i]];
      const ab = [b[0] - a[0], b[1] - a[1]];
      const lengthSquared = ab[0] * ab[0] + ab[1] * ab[1];
      const t = lengthSquared ? Math.max(0, Math.min(1, ((center[0] - a[0]) * ab[0] + (center[1] - a[1]) * ab[1]) / lengthSquared)) : 0;
      const foot: P2 = [a[0] + t * ab[0], a[1] + t * ab[1]];
      const distanceSquared = (foot[0] - center[0]) ** 2 + (foot[1] - center[1]) ** 2;
      if (distanceSquared < bd) {
        (bd = distanceSquared), (best = foot);
      }
    }
  }

  return rr(best);
}

/** How an edge is drawn: where faces meet at an angle, where they meet smoothly (thin), or not (a seam). */
type EdgeKind = 'sharp' | 'smooth' | 'seam';
const kindsOf = new WeakMap<Shape3D, EdgeKind[]>();

function edgeKinds(shape: Shape3D): EdgeKind[] {
  const known = kindsOf.get(shape);
  if (known) {
    return known;
  }
  const oc = getOC();
  const edges = shape.edges;
  const faces = shape.faces;
  const buckets = new Map<number, { i: number; faces: number[] }[]>();
  edges.forEach((e, i) => buckets.set(e.hashCode, [...(buckets.get(e.hashCode) ?? []), { i, faces: [] }]));
  faces.forEach((face, fi) => {
    for (const fe of face.edges) {
      const list = buckets.get(fe.hashCode);
      const match = list?.length === 1 ? list[0] : list?.find(entry => edges[entry.i].isSame(fe));
      match?.faces.push(fi);
    }
  });
  const out: EdgeKind[] = new Array(edges.length).fill('sharp');
  for (const list of buckets.values()) {
    for (const { i, faces: fs } of list) {
      try {
        if (fs.length === 1) {
        // One face: the seam of a round one - or the open rim of a sheet.
          if (oc.BRep_Tool.IsClosed(edges[i].wrapped as never, faces[fs[0]].wrapped as never)) {
            out[i] = 'seam';
          }
        } else if (fs.length === 2) {
        // Read through the edge's curve on each face (a point projected onto
        // a face per edge kept the engine's memory: a gear's ran it out).
          const n1 = normalOnEdge(faces[fs[0]], edges[i], 0.5);
          const n2 = normalOnEdge(faces[fs[1]], edges[i], 0.5);
          if (n1 && n2 && n1[0] * n2[0] + n1[1] * n2[1] + n1[2] * n2[2] > 0.9995) {
            out[i] = 'smooth';
          }
        }
      } catch {
      // Kept sharp.
      }
    }
  }
  kindsOf.set(shape, out);

  return out;
}

/** Round faces' axes, by face (for outlines put right on them, not on the mesh's chords). */
const cylsOf = new WeakMap<Shape3D, Map<number, ReturnType<typeof cylinderOf>>>();
function cylinderAt(shape: Shape3D, face: number) {
  let cache = cylsOf.get(shape);
  if (!cache) {
    cylsOf.set(shape, (cache = new Map()));
  }
  if (!cache.has(face)) {
    let cyl: ReturnType<typeof cylinderOf> = null;
    try {
      cyl = cylinderOf(shape.faces[face]);
    } catch {
      // Left on the mesh.
    }
    cache.set(face, cyl);
  }

  return cache.get(face) ?? null;
}

/** The faces the exact hidden line removal is slow on (anything but planes, cylinders, cones, spheres and tori). */
export function freeformFaces(mesh: BodyMesh): number {
  return mesh.faces.filter(face => !['PLANE', 'CYLINDRE', 'CONE', 'SPHERE', 'TORUS'].includes(face.type)).length;
}

/** The views of the bodies, worked out on their meshes. Each view: its bodies, and the box of what it shows. */
export function meshViews(bodies: { id: string; shape: Shape3D; mesh: BodyMesh }[], views: ViewSpec[]): { id: string; bodies: ViewBody[]; box: [P2, P2] | null }[] {
  const kinds = bodies.map(b => edgeKinds(b.shape));

  return views.map(view => meshView(bodies, kinds, view));
}

function meshView(bodies: { id: string; shape: Shape3D; mesh: BodyMesh }[], kinds: EdgeKind[][], viewSpec: ViewSpec): { id: string; bodies: ViewBody[]; box: [P2, P2] | null } {
  const unit = (vector: V3): V3 => {
    const length = Math.hypot(vector[0], vector[1], vector[2]) || 1;

    return [vector[0] / length, vector[1] / length, vector[2] / length];
  };
  const direction = unit(viewSpec.dir as V3);
  const xAxis = unit(viewSpec.xAxis as V3);
  const yAxis: V3 = [direction[1] * xAxis[2] - direction[2] * xAxis[1], direction[2] * xAxis[0] - direction[0] * xAxis[2], direction[0] * xAxis[1] - direction[1] * xAxis[0]];
  // On the paper: x along xAxis, y down (-yAxis); depth towards the eye (+direction).
  const px2 = (x: number, y: number, z: number): [number, number, number] => [x * xAxis[0] + y * xAxis[1] + z * xAxis[2], -(x * yAxis[0] + y * yAxis[1] + z * yAxis[2]), x * direction[0] + y * direction[1] + z * direction[2]];

  // ---- The depth buffer.
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  const proj = bodies.map(({ mesh }) => {
    const positions = mesh.positions;
    const out = new Float64Array(positions.length);
    for (let i = 0; i < positions.length; i += 3) {
      const [a, b, depth] = px2(positions[i], positions[i + 1], positions[i + 2]);
      out[i] = a;
      out[i + 1] = b;
      out[i + 2] = depth;
      if (a < x0) {
        x0 = a;
      }
      if (a > x1) {
        x1 = a;
      }
      if (b < y0) {
        y0 = b;
      }
      if (b > y1) {
        y1 = b;
      }
      if (depth < z0) {
        z0 = depth;
      }
      if (depth > z1) {
        z1 = depth;
      }
    }

    return out;
  });
  if (!(x1 >= x0)) {
    return { id: viewSpec.id, bodies: bodies.map(b => ({ id: b.id, visible: '', tangent: '', hidden: '', edges: [] })), box: null };
  }
  const extent = Math.max(x1 - x0, y1 - y0, 1e-6);
  const px = extent / 2048;
  const gw = Math.ceil((x1 - x0) / px) + 5;
  const gh = Math.ceil((y1 - y0) / px) + 5;
  const ox = x0 - 2 * px;
  const oy = y0 - 2 * px;
  const zb = new Float32Array(gw * gh).fill(-Infinity);
  bodies.forEach(({ mesh }, bi) => {
    const indices = mesh.indices;
    const values = proj[bi];
    for (let t = 0; t < indices.length; t += 3) {
      const a = indices[t] * 3, b = indices[t + 1] * 3, offsetC = indices[t + 2] * 3;
      const ax = (values[a] - ox) / px, ay = (values[a + 1] - oy) / px, az = values[a + 2];
      const bx = (values[b] - ox) / px, by = (values[b + 1] - oy) / px, bz = values[b + 2];
      const cx = (values[offsetC] - ox) / px, cy = (values[offsetC + 1] - oy) / px, cz = values[offsetC + 2];
      const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
      if (Math.abs(area) < 1e-12) {
        continue;
      }
      const i0 = Math.max(0, Math.floor(Math.min(ax, bx, cx)));
      const i1 = Math.min(gw - 1, Math.ceil(Math.max(ax, bx, cx)));
      const j0 = Math.max(0, Math.floor(Math.min(ay, by, cy)));
      const j1 = Math.min(gh - 1, Math.ceil(Math.max(ay, by, cy)));
      // (The weights are fractions: a pixel's centre on a shared side belongs to both triangles.)
      const e = -1e-9;
      for (let j = j0; j <= j1; j++) {
        const y = j + 0.5;
        for (let i = i0; i <= i1; i++) {
          const x = i + 0.5;
          const w0 = ((bx - x) * (cy - y) - (by - y) * (cx - x)) / area;
          const w1 = ((cx - x) * (ay - y) - (cy - y) * (ax - x)) / area;
          const w2 = 1 - w0 - w1;
          if (w0 < e || w1 < e || w2 < e) {
            continue;
          }
          const z = w0 * az + w1 * bz + w2 * cz;
          const cell = j * gw + i;
          if (z > zb[cell]) {
            zb[cell] = z;
          }
        }
      }
    }
  });
  const eps = 2 * px + (z1 - z0) * 1e-6;
  /** Seen: nothing clearly in front of it (around it, a pixel either way: on an outline, the far side counts). */
  const seenAt = (x: number, y: number, z: number) => {
    const i = Math.floor((x - ox) / px);
    const j = Math.floor((y - oy) / px);
    let far = Infinity;
    for (let jj = j - 1; jj <= j + 1; jj++) {
      for (let ii = i - 1; ii <= i + 1; ii++) {
        const q = ii >= 0 && jj >= 0 && ii < gw && jj < gh ? zb[jj * gw + ii] : -Infinity;
        if (q < far) {
          far = q;
        }
      }
    }

    return z >= far - eps;
  };

  const pathOf = (pts: P2[]) => pts.map((point, i) => `${i ? 'L' : 'M'}${r3(point[0])} ${r3(point[1])}`).join('');
  const straight = (pts: P2[]) => {
    const [a, b] = [pts[0], pts[pts.length - 1]];
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (length < 1e-6) {
      return false;
    }
    const tol = Math.max(px, length * 1e-3);

    return pts.every(point => Math.abs((point[0] - a[0]) * (b[1] - a[1]) - (point[1] - a[1]) * (b[0] - a[0])) / length < tol);
  };

  // ---- Every line to draw, sampled a pixel apart: the bodies' edges, and the
  // outlines of their curved faces (where the surface turns away from the eye).
  type Line = { body: number; kind: EdgeKind | 'outline'; shape: 'line' | 'circle' | 'other'; xyz: number[]; vert: boolean[]; state: Int8Array };
  const lines: Line[] = [];
  const addLine = (body: number, kind: Line['kind'], shape: Line['shape'], pts: [number, number, number][]) => {
    const xyz: number[] = [];
    const vert: boolean[] = [];
    pts.forEach((point, pointIndex) => {
      if (pointIndex > 0) {
        const q = pts[pointIndex - 1];
        const steps = Math.max(1, Math.ceil(Math.hypot(point[0] - q[0], point[1] - q[1]) / px));
        for (let step = 1; step < steps; step++) {
          const t = step / steps;
          xyz.push(q[0] + (point[0] - q[0]) * t, q[1] + (point[1] - q[1]) * t, q[2] + (point[2] - q[2]) * t);
          vert.push(false);
        }
      }
      xyz.push(point[0], point[1], point[2]);
      vert.push(true);
    });
    lines.push({ body, kind, shape, xyz, vert, state: new Int8Array(vert.length) });
  };
  bodies.forEach(({ mesh }, bi) => {
    const edgePositions = mesh.edgePositions;
    mesh.edgeGroups.forEach((edgeGroup, ei) => {
      const kind = kinds[bi][ei] ?? 'sharp';
      if (kind === 'seam' || edgeGroup.count < 2) {
        return;
      }
      const pts: [number, number, number][] = [];
      for (let index = 0; index < edgeGroup.count; index++) {
        const offset = (edgeGroup.start + index) * 3;
        const q = px2(edgePositions[offset], edgePositions[offset + 1], edgePositions[offset + 2]);
        // (The mesh's edge lines come as pairs of points: each point twice.)
        const last = pts[pts.length - 1];
        if (!last || Math.abs(q[0] - last[0]) > 1e-9 || Math.abs(q[1] - last[1]) > 1e-9 || Math.abs(q[2] - last[2]) > 1e-9) {
          pts.push(q);
        }
      }
      if (pts.length < 2) {
        return;
      }
      if (pts.every(point => Math.abs(point[0] - pts[0][0]) < 1e-9 && Math.abs(point[1] - pts[0][1]) < 1e-9 && Math.abs(point[2] - pts[0][2]) < 1e-9)) {
        return;
      }
      const info = mesh.edges[ei];
      // A circle shows as one only seen face on.
      let shape: Line['shape'] = info?.type === 'LINE' ? 'line' : 'other';
      if (info?.type === 'CIRCLE' && edgeGroup.count >= 3) {
        const offsetOf = (i: number) => (edgeGroup.start + i) * 3;
        const [a, b, offsetC] = [offsetOf(0), offsetOf(Math.floor(edgeGroup.count / 3)), offsetOf(Math.floor((2 * edgeGroup.count) / 3))];
        const edgeU: V3 = [edgePositions[b] - edgePositions[a], edgePositions[b + 1] - edgePositions[a + 1], edgePositions[b + 2] - edgePositions[a + 2]];
        const edgeV: V3 = [edgePositions[offsetC] - edgePositions[a], edgePositions[offsetC + 1] - edgePositions[a + 1], edgePositions[offsetC + 2] - edgePositions[a + 2]];
        const normal = unit([edgeU[1] * edgeV[2] - edgeU[2] * edgeV[1], edgeU[2] * edgeV[0] - edgeU[0] * edgeV[2], edgeU[0] * edgeV[1] - edgeU[1] * edgeV[0]]);
        if (Math.abs(normal[0] * direction[0] + normal[1] * direction[1] + normal[2] * direction[2]) > 1 - 1e-6) {
          shape = 'circle';
        }
      }
      addLine(bi, kind, shape, pts);
    });
    const normals = mesh.normals;
    const indices = mesh.indices;
    const positions = mesh.positions;
    mesh.faceGroups.forEach((faceGroup) => {
      const type = mesh.faces[faceGroup.face]?.type;
      if (type === 'PLANE') {
        return;
      }
      // On a round face, the outline lies on the surface, straight along it.
      const cyl = type === 'CYLINDRE' ? cylinderAt(bodies[bi].shape, faceGroup.face) : null;
      const across = cyl ? unit([direction[1] * cyl.a[2] - direction[2] * cyl.a[1], direction[2] * cyl.a[0] - direction[0] * cyl.a[2], direction[0] * cyl.a[1] - direction[1] * cyl.a[0]]) : null;
      const onto = (point: V3): V3 => {
        if (!cyl || !across) {
          return point;
        }
        const a = unit(cyl.a as V3);
        const q: V3 = [point[0] - cyl.c[0], point[1] - cyl.c[1], point[2] - cyl.c[2]];
        const t = q[0] * a[0] + q[1] * a[1] + q[2] * a[2];
        const sg = q[0] * across[0] + q[1] * across[1] + q[2] * across[2] >= 0 ? 1 : -1;

        return [cyl.c[0] + a[0] * t + across[0] * cyl.r * sg, cyl.c[1] + a[1] * t + across[1] * cyl.r * sg, cyl.c[2] + a[2] * t + across[2] * cyl.r * sg];
      };
      // Crossing points, by the mesh edge they're on (so the pieces join up).
      const at = new Map<string, V3>();
      const links = new Map<string, string[]>();
      const link = (a: string, b: string) => {
        links.set(a, [...(links.get(a) ?? []), b]);
        links.set(b, [...(links.get(b) ?? []), a]);
      };
      const facing = (i: number) => normals[i * 3] * direction[0] + normals[i * 3 + 1] * direction[1] + normals[i * 3 + 2] * direction[2];
      for (let t = faceGroup.start; t < faceGroup.start + faceGroup.count; t += 3) {
        const vs = [indices[t], indices[t + 1], indices[t + 2]];
        const fs = vs.map(facing);
        if (fs.every(x => Math.abs(x) < 1e-7)) {
          continue;
        }
        const pos = fs.map(x => x >= -1e-7);
        if (pos[0] === pos[1] && pos[1] === pos[2]) {
          continue;
        }
        const cross: string[] = [];
        for (const [i, j] of [
          [0, 1],
          [1, 2],
          [2, 0]
        ]) {
          if (pos[i] === pos[j]) {
            continue;
          }
          const [va, vb] = vs[i] < vs[j] ? [vs[i], vs[j]] : [vs[j], vs[i]];
          const key = `${va}_${vb}`;
          if (!at.has(key)) {
            const fa = facing(va);
            const fb = facing(vb);
            const fraction = Math.abs(fa - fb) < 1e-12 ? 0.5 : Math.max(0, Math.min(1, fa / (fa - fb)));
            at.set(key, onto([positions[va * 3] + (positions[vb * 3] - positions[va * 3]) * fraction, positions[va * 3 + 1] + (positions[vb * 3 + 1] - positions[va * 3 + 1]) * fraction, positions[va * 3 + 2] + (positions[vb * 3 + 2] - positions[va * 3 + 2]) * fraction]));
          }
          cross.push(key);
        }
        if (cross.length === 2) {
          link(cross[0], cross[1]);
        }
      }
      // Joined into polylines.
      const used = new Set<string>();
      const ends = [...links.keys()].sort((a, b) => (links.get(a)!.length === 1 ? 0 : 1) - (links.get(b)!.length === 1 ? 0 : 1));
      for (const start of ends) {
        if (used.has(start)) {
          continue;
        }
        const chain = [start];
        used.add(start);
        let cur = start;
        for (;;) {
          const next = links.get(cur)!.find(neighbour => !used.has(neighbour));
          if (!next) {
            break;
          }
          used.add(next);
          chain.push(next);
          cur = next;
        }
        // A closed loop: back to its start.
        if (chain.length > 2 && links.get(cur)!.includes(start)) {
          chain.push(start);
        }
        if (chain.length < 2) {
          continue;
        }
        addLine(
          bi,
          'outline',
          'other',
          chain.map((key) => {
            const point = at.get(key)!;

            return px2(point[0], point[1], point[2]);
          })
        );
      }
    });
  });

  // ---- Seen or hidden, each sample. Then, nearest lines first: a sample
  // lying right under a line already drawn is left out, seen or not (the back
  // edge of a box seen straight on, a hole's far rim under its near one).
  for (const line of lines) {
    for (let index = 0; index < line.state.length; index++) {
      line.state[index] = seenAt(line.xyz[index * 3], line.xyz[index * 3 + 1], line.xyz[index * 3 + 2]) ? 1 : 0;
    }
  }
  const ink = new Float32Array(gw * gh).fill(-Infinity);
  // Which line (and which of its samples) put the ink there: a line steep in
  // depth must not hide its own next samples.
  const inkLine = new Int32Array(gw * gh).fill(-1);
  const inkK = new Int32Array(gw * gh);
  const pix = (x: number, y: number) => [Math.floor((x - ox) / px), Math.floor((y - oy) / px)];
  const underInk = (x: number, y: number, z: number, li = -1, index = 0) => {
    const [i, j] = pix(x, y);
    for (let jj = j - 1; jj <= j + 1; jj++) {
      for (let ii = i - 1; ii <= i + 1; ii++) {
        if (ii < 0 || jj < 0 || ii >= gw || jj >= gh) {
          continue;
        }
        const q = jj * gw + ii;
        if (ink[q] > z + eps && (inkLine[q] !== li || Math.abs(inkK[q] - index) > 8)) {
          return true;
        }
      }
    }

    return false;
  };
  /** Near a line's ends, where it meets the next one: never left out there. */
  const nearEnd = (line: Line, index: number) => {
    const last = line.state.length - 1;
    const x = line.xyz[index * 3];
    const y = line.xyz[index * 3 + 1];

    return Math.hypot(x - line.xyz[0], y - line.xyz[1]) < 2.5 * px || Math.hypot(x - line.xyz[last * 3], y - line.xyz[last * 3 + 1]) < 2.5 * px;
  };
  // Every seen sample, nearest first - the tangent lines after all the others:
  // one on a seen edge or outline (a face split in two, seen edge on) gives
  // way to it, nearer or not.
  const order: [number, number, number][] = [];
  lines.forEach((line, li) => {
    for (let index = 0; index < line.state.length; index++) {
      if (line.state[index] === 1) {
        order.push([line.xyz[index * 3 + 2], li, index]);
      }
    }
  });
  const soft = (li: number) => (lines[li].kind === 'smooth' ? 1 : 0);
  order.sort((a, b) => soft(a[1]) - soft(b[1]) || b[0] - a[0]);
  for (const [z, li, index] of order) {
    const line = lines[li];
    const x = line.xyz[index * 3];
    const y = line.xyz[index * 3 + 1];
    if (!nearEnd(line, index) && underInk(x, y, line.kind === 'smooth' ? -Infinity : z, li, index)) {
      line.state[index] = -1;
      continue;
    }
    const [i, j] = pix(x, y);
    if (i >= 0 && j >= 0 && i < gw && j < gh && z > ink[j * gw + i]) {
      const q = j * gw + i;
      ink[q] = z;
      inkLine[q] = li;
      inkK[q] = index;
    }
  }
  for (const line of lines) {
    for (let index = 0; index < line.state.length; index++) {
      if (line.state[index] === 0 && (line.kind === 'smooth' || underInk(line.xyz[index * 3], line.xyz[index * 3 + 1], line.xyz[index * 3 + 2]))) {
        line.state[index] = -1;
      }
    }
  }

  // ---- The runs, as paths and as edges to dimension.
  let lo: P2 = [Infinity, Infinity];
  let hi: P2 = [-Infinity, -Infinity];
  const out: ViewBody[] = bodies.map(({ id }) => ({ id, visible: '', tangent: '', hidden: '', edges: [] }));
  const seen = bodies.map(() => [] as P2[][]);
  const under = bodies.map(() => [] as P2[][]);
  for (const line of lines) {
    const b = out[line.body];
    let index = 0;
    while (index < line.state.length) {
      const st = line.state[index];
      let e = index;
      while (e + 1 < line.state.length && line.state[e + 1] === st) {
        e++;
      }
      // The run from the sample before it (no gap between a seen run and a hidden one).
      const from = index > 0 && line.state[index - 1] !== -1 ? index - 1 : index;
      if (st !== -1 && e > from) {
        const pts: P2[] = [];
        for (let q = from; q <= e; q++) {
          if (q === from || q === e || (line.shape !== 'line' && line.vert[q])) {
            pts.push([line.xyz[q * 3], line.xyz[q * 3 + 1]]);
          }
        }
        for (const point of pts) {
          lo = [Math.min(lo[0], point[0]), Math.min(lo[1], point[1])];
          hi = [Math.max(hi[0], point[0]), Math.max(hi[1], point[1])];
        }
        const long = Math.hypot(pts[pts.length - 1][0] - pts[0][0], pts[pts.length - 1][1] - pts[0][1]) > 3 * px || pts.length > 3;
        if (st === 0) {
          b.hidden += pathOf(pts);
          under[line.body].push(pts);
        } else {
          if (line.kind === 'smooth') {
            b.tangent += pathOf(pts);
          } else {
            b.visible += pathOf(pts);
          }
          seen[line.body].push(pts);
          if (long) {
            if (line.kind === 'outline') {
              if (straight(pts)) {
                b.edges.push({ a: rr(pts[0]), b: rr(pts[pts.length - 1]) });
              }
            } else {
              const ve = viewEdge(line.shape, pts);
              if (ve) {
                b.edges.push(ve);
              }
            }
          }
        }
      }
      index = e + 1;
    }
  }
  out.forEach((b, i) => {
    b.anchor = anchorOf(seen[i]);
    if (!b.anchor && under[i].length) {
      b.under = anchorOf(under[i]);
    }
  });

  return { id: viewSpec.id, bodies: out, box: lo[0] <= hi[0] ? exactBox(bodies, xAxis, yAxis) ?? [lo, hi] : null };
}

/**
 * Looking along an axis, the view's box from the solids themselves (the mesh
 * lies a little inside round faces: an overall size came out 0.01 short).
 */
function exactBox(bodies: { shape: Shape3D }[], xAxis: V3, yAxis: V3): [P2, P2] | null {
  const axial = (vector: V3) => vector.filter(component => Math.abs(component) > 1e-9).length === 1;
  if (!axial(xAxis) || !axial(yAxis)) {
    return null;
  }
  const lo3: V3 = [Infinity, Infinity, Infinity];
  const hi3: V3 = [-Infinity, -Infinity, -Infinity];
  for (const b of bodies) {
    const bb = boxOf(b.shape);
    if (!bb) {
      return null;
    }
    for (let axis = 0; axis < 3; axis++) {
      lo3[axis] = Math.min(lo3[axis], bb[0][axis]);
      hi3[axis] = Math.max(hi3[axis], bb[1][axis]);
    }
  }
  if (!(lo3[0] <= hi3[0])) {
    return null;
  }
  const xs: number[] = [];
  const ys: number[] = [];
  for (const i of [0, 1]) {
    for (const j of [0, 1]) {
      for (const cornerK of [0, 1]) {
        const corner: V3 = [i ? hi3[0] : lo3[0], j ? hi3[1] : lo3[1], cornerK ? hi3[2] : lo3[2]];
        xs.push(corner[0] * xAxis[0] + corner[1] * xAxis[1] + corner[2] * xAxis[2]);
        ys.push(-(corner[0] * yAxis[0] + corner[1] * yAxis[1] + corner[2] * yAxis[2]));
      }
    }
  }

  return [
    [Math.min(...xs), Math.min(...ys)],
    [Math.max(...xs), Math.max(...ys)]
  ];
}

/** A body's exact box, worked out once (it's slow on a big body, and every view wants it). */
const boxes = new WeakMap<Shape3D, [V3, V3] | null>();
function boxOf(shape: Shape3D): [V3, V3] | null {
  if (boxes.has(shape)) {
    return boxes.get(shape)!;
  }
  const oc = getOC();
  const box = new oc.Bnd_Box();
  let out: [V3, V3] | null = null;
  try {
    oc.BRepBndLib.AddOptimal(shape.wrapped as never, box, false, false);
    if (!box.IsVoid()) {
      const cornerMin = box.CornerMin();
      const q = box.CornerMax();
      out = [
        [cornerMin.X(), cornerMin.Y(), cornerMin.Z()],
        [q.X(), q.Y(), q.Z()]
      ];
      cornerMin.delete();
      q.delete();
    }
  } catch {
    out = null;
  } finally {
    box.delete();
  }
  boxes.set(shape, out);

  return out;
}
