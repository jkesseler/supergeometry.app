// Run: npx tsx tests/freeformstress.slow.test.ts [rounds] [seed]
//
// Pushes freeforms to the limit: random cage pulls (small, huge, through the
// body, onto each other), refined cages, holes filled, sheets thickened - and
// the results combined with boxes, cylinders and other freeforms. A step may
// be refused with a message; one that's accepted must leave valid, closed,
// single solids (or a clean sheet for an open surface).
import opencascade from 'replicad-opencascadejs';
import { getOC, measureArea, measureVolume, setOC, type Shape3D } from 'replicad';
import { debugBodies, regenerate, shapeValid } from '../src/kernel/engine';
import { arrangement, regionRef } from '../src/sketch/regions';
import { boxCage, cylinderCage, isClosed, planeCage, refineCage, sphereCage, type Cage } from '../src/freeform/cage';
import type { Feature, PlaneDef, Vec3 } from '../src/doc/types';

setOC(await (opencascade as unknown as () => Promise<any>)());
const oc = getOC();

const ROUNDS = Number(process.argv[2] ?? 12);
let seed = Number(process.argv[3] ?? 1);
const random = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const pick = <T>(a: T[]): T => a[Math.floor(random() * a.length)];
const XY: PlaneDef = { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, 0, 1] };

function count(shape: Shape3D, kind: 'SOLID' | 'SHELL'): number {
  const ex = new oc.TopExp_Explorer(shape.wrapped, oc.TopAbs_ShapeEnum[`TopAbs_${kind}`], oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
  let count = 0;
  for (; ex.More(); ex.Next()) {
    count++;
  }
  ex.delete();

  return count;
}

function problems(shape: Shape3D, solid: boolean, oe: number, mayPart = false): string[] {
  const out: string[] = [];
  if (!shapeValid(shape)) {
    out.push('invalid');
  }
  if (solid) {
    const solidCount = count(shape, 'SOLID');
    if (solidCount < 1 || (solidCount > 1 && !mayPart)) {
      out.push(`${solidCount} solids`);
    }
    if (oe) {
      out.push(`${oe} open edges`);
    }
    const volume = measureVolume(shape);
    if (!(volume > 1e-6)) {
      out.push(`volume ${volume.toFixed(3)}`);
    }
  } else if (count(shape, 'SHELL') < 1) {
    out.push('no surface');
  }
  const areas = shape.faces.map(face => measureArea(face));
  const total = areas.reduce((a, b) => a + b, 0);
  const tiny = areas.filter(a => a < total * 1e-7).length;
  if (tiny) {
    out.push(`${tiny} hair-thin faces`);
  }

  return out;
}

// --------------------------------------------------------- cage mischief

const base = (): { cage: Cage; name: string } =>
  pick([
    () => ({ cage: boxCage([40, 30, 20], 2), name: 'box' }),
    () => ({ cage: boxCage([30, 30, 30], 3), name: 'box 3×3' }),
    () => ({ cage: sphereCage(40), name: 'sphere' }),
    () => ({ cage: cylinderCage(30, 40, 3), name: 'cylinder' }),
    () => ({ cage: refineCage(boxCage([40, 40, 20], 2)), name: 'refined box' }),
    () => ({ cage: planeCage([40, 40], 4), name: 'sheet' })
  ])();

/** One random edit of the cage (returns a label). */
function mischief(cage: Cage): string {
  const vertex = Math.floor(random() * cage.verts.length);
  const kind = pick(['pull', 'pull', 'pull far', 'through', 'onto neighbour', 'flatten face', 'squash all', 'twist']);
  const vertices = cage.verts;
  const centre = vertices.reduce((sum, point) => [sum[0] + point[0] / vertices.length, sum[1] + point[1] / vertices.length, sum[2] + point[2] / vertices.length] as Vec3, [0, 0, 0] as Vec3);
  switch (kind) {
    case 'pull':
      vertices[vertex] = vertices[vertex].map(x => x + (random() - 0.5) * 20) as Vec3;

      return `pull point ${vertex}`;
    case 'pull far':
      vertices[vertex] = vertices[vertex].map(x => x + (random() - 0.5) * 400) as Vec3;

      return `pull point ${vertex} far away`;
    case 'through': {
      // Out the other side of the body.
      vertices[vertex] = vertices[vertex].map((x, axis) => centre[axis] - (x - centre[axis]) * 1.5) as Vec3;

      return `push point ${vertex} through the body`;
    }
    case 'onto neighbour': {
      const face = cage.faces.find(q => q.includes(vertex))!;
      const neighbour = face[(face.indexOf(vertex) + 1) % 4];
      vertices[vertex] = [...vertices[neighbour]] as Vec3;

      return `point ${vertex} onto its neighbour ${neighbour}`;
    }
    case 'flatten face': {
      const face = pick(cage.faces);
      const middle = face.reduce((sum, i) => [sum[0] + vertices[i][0] / 4, sum[1] + vertices[i][1] / 4, sum[2] + vertices[i][2] / 4] as Vec3, [0, 0, 0] as Vec3);
      for (const i of face) {
        vertices[i] = [...middle] as Vec3;
      }

      return 'a face squashed to a point';
    }
    case 'squash all': {
      const axis = Math.floor(random() * 3);
      for (const point of vertices) {
        point[axis] = centre[axis] + (point[axis] - centre[axis]) * 0.01;
      }

      return 'whole cage squashed flat';
    }
    default: {
      // Top half turned 170° against the bottom.
      const a = (170 * Math.PI) / 180;
      for (const point of vertices) {
        if (point[2] > centre[2]) {
          const x = point[0] - centre[0];
          const y = point[1] - centre[1];
          point[0] = centre[0] + x * Math.cos(a) - y * Math.sin(a);
          point[1] = centre[1] + x * Math.sin(a) + y * Math.cos(a);
        }
      }

      return 'top twisted 170°';
    }
  }
}

// ----------------------------------------------------------------- runs

const fails: string[] = [];
const refusedBy = new Map<string, number>();
let accepted = 0;
let slow = 0;
const XYrect = (width: number, height: number, cx = 0, cy = 0) => [{ id: 'r', kind: 'rect', center: [cx, cy], w: width, h: height, rotation: 0 }];

for (let round = 0; round < ROUNDS; round++) {
  const b = base();
  const cage = structuredClone(b.cage);
  const trail = [b.name];
  const edits = 1 + Math.floor(random() * 3);
  for (let i = 0; i < edits; i++) {
    trail.push(mischief(cage));
  }
  const solid = isClosed(cage);
  const ff: Feature = { id: 'ff', name: 'Freeform', type: 'freeform', cage, ...(solid ? {} : { surface: true, ...(random() < 0.7 ? { thickness: 1 + random() * 4, thickSide: pick(['up', 'down', 'both'] as const) } : {}) }) } as Feature;
  const thick = solid || !!(ff as any).thickness;
  // Something to combine it with.
  const partner = pick(['none', 'box', 'cylinder', 'freeform']);
  const features: Feature[] = [ff];
  if (partner === 'box' || partner === 'cylinder') {
    const es = partner === 'box' ? XYrect(20, 20, 10, 5) : [{ id: 'c', kind: 'circle', center: [5, 0], radius: 8 }];
    features.push({ id: 'sk', name: 'Sketch', type: 'sketch', plane: XY, entities: es } as Feature);
    features.push({ id: 'b2', name: 'Other', type: 'extrude', source: { kind: 'profile', sketch: 'sk', regions: arrangement(es as any).regions.map(regionRef) }, distance: 35, mode: 'new' } as Feature);
  } else if (partner === 'freeform') {
    const other = sphereCage(30, [12, 6, 4]);
    features.push({ id: 'b2', name: 'Blob', type: 'freeform', cage: other } as Feature);
  }
  if (partner !== 'none' && thick) {
    const op = pick(['union', 'subtract', 'intersect'] as const);
    trail.push(`${op} with a ${partner}`);
    features.push({ id: 'bo', name: 'Boolean', type: 'boolean', op, target: random() < 0.5 ? 'ff' : 'b2', tools: [random() < 0.5 ? 'b2' : 'ff'].filter(tool => tool !== '') } as Feature);
    const last = features[features.length - 1] as any;
    if (last.tools[0] === last.target) {
      last.tools = [last.target === 'ff' ? 'b2' : 'ff'];
    }
  }
  const t0 = performance.now();
  let res: any;
  try {
    res = await regenerate(features);
  } catch (e) {
    fails.push(`round ${round}: threw ${(e as Error).message} - ${trail.join(', ')}`);
    continue;
  }
  const dt = performance.now() - t0;
  if (dt > 8000) {
    slow++;
  }
  const errs = (res?.errors ?? []) as { feature: string; message: string }[];
  for (const e of errs) {
    refusedBy.set(e.message.slice(0, 70), (refusedBy.get(e.message.slice(0, 70)) ?? 0) + 1);
  }
  if (errs.length) {
    continue;
  }
  accepted++;
  for (const [id, debugBody] of debugBodies()) {
    const isSheet = id === 'ff' && !thick && !features.some(feature => feature.type === 'boolean');
    const info = (res.bodies ?? []).find((bodyInfo: any) => bodyInfo.id === id);
    const bad = problems(debugBody, !isSheet, info?.openEdges?.length ?? 0, features.some(feature => feature.type === 'boolean' && (feature as any).op !== 'union'));
    if (bad.length) {
      fails.push(`round ${round}: body ${id}: ${bad.join(', ')} - ${trail.join(', ')}`);
      if (process.env.FF_DUMP) {
        (await import('node:fs')).writeFileSync(process.env.FF_DUMP, JSON.stringify(features));
      }
      break;
    }
  }
}

for (const fail of fails) {
  console.log('FAIL', fail);
}
console.log(`${accepted} accepted, ${ROUNDS - accepted - fails.filter(fail => fail.includes('threw')).length} refused, ${fails.length} broke${slow ? `, ${slow} took over 8 s` : ''}`);
for (const [message, count] of [...refusedBy].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${count}× ${message}`);
}
process.exit(fails.length ? 1 : 0);
