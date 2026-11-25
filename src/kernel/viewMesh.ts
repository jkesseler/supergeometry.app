import { movedFrom } from './steps/transform';
import { sizeOf } from './faceEdit';
import { meshEdgeLines, meshFaces, meshOff } from './meshing';
import { edgeOrigins, edgeSteps, faceAliases, faceOrigins, faceSteps, oldEdgeSteps, seamEdges } from './provenance';
import { getFaceInfo } from './faceInfoCache';
import { edgeInfo } from './references';
import { openEdges } from './health';
import type { Shape3D } from 'replicad';
import type { Feature } from '../doc/types';
import type { BodyMesh, EdgeInfo, FaceInfo } from './protocol';

const meshCache = new WeakMap<Shape3D, BodyMesh>();

/** The next mesh's key (see BodyMesh.key). */
let meshKey = 1;

function movedMesh(shape: Shape3D) {
  const mv = movedFrom.get(shape);
  const was = mv?.from.deref();
  const src = was && (meshCache.get(was) ?? drawMeshes.get(was));
  if (!mv || !src) {
    return null;
  }
  const { m, flip } = mv;
  const at = (a: Float32Array, normal: boolean) => {
    const out = new Float32Array(a.length);
    for (let i = 0; i < a.length; i += 3) {
      const [x, y, z] = [a[i], a[i + 1], a[i + 2]];
      for (let row = 0; row < 3; row++) {
        out[i + row] = m[row * 4] * x + m[row * 4 + 1] * y + m[row * 4 + 2] * z + (normal ? 0 : m[row * 4 + 3]);
      }
    }

    return out;
  };
  let triangles = src.indices;
  if (flip) {
    // Mirrored: each triangle the other way round, or it faces inward.
    triangles = new Uint32Array(src.indices);
    for (let i = 0; i < triangles.length; i += 3) {
      [triangles[i + 1], triangles[i + 2]] = [triangles[i + 2], triangles[i + 1]];
    }
  }

  return {
    m: { vertices: at(src.positions, false), normals: at(src.normals, true), triangles, faceGroups: src.faceGroups },
    e: { lines: at(src.edgePositions, false), edgeGroups: src.edgeGroups }
  };
}

/** The triangles and edge lines of a body, as the view shows them. */
function meshLines(shape: Shape3D, smoothSteps: Set<string>) {
  const moved = movedMesh(shape);
  if (moved) {
    return moved;
  }
  // (About its size is enough for how fine to draw it: the exact box of a curved body takes up to a second.)
  const diag = sizeOf(shape);
  // (Never finer than 1/50 000 of its size: a 100 m arc at 0.1 mm is millions of triangles.)
  const tolerance = Math.max(Math.min(0.1, Math.max(0.001, diag * 0.0008)), diag * 2e-5);
  const angularTolerance = 0.25;
  const faceMesh = meshFaces(shape, tolerance, angularTolerance);
  const e = meshEdgeLines(shape, tolerance, angularTolerance);
  meshOff(shape);
  // A face made freeform is many patches, smooth across the lines between
  // them: those lines aren't edges to show or pick (drawn as nothing).
  const made = edgeSteps(shape);
  if (made && smoothSteps.size && e.edgeGroups.reduce((total, edgeGroup) => total + edgeGroup.count, 0) * 3 === e.lines.length) {
    const seams = seamEdges(shape);
    e.edgeGroups.forEach((edgeGroup, i) => {
      if (made[i]?.length !== 1 || !smoothSteps.has(made[i][0]) || seams[i]) {
        return;
      }
      for (let vertexIndex = 1; vertexIndex < edgeGroup.count; vertexIndex++) {
        for (let axis = 0; axis < 3; axis++) {
          e.lines[(edgeGroup.start + vertexIndex) * 3 + axis] = e.lines[edgeGroup.start * 3 + axis];
        }
      }
    });
  }

  return { m: faceMesh, e };
}

/**
 * For a drawing: the mesh with only what the drawing reads (the faces' and
 * edges' kinds) - the view's own when it has it. The model drawn without its
 * threads is bodies the view never showed: its full mesh took seconds more.
 */
const drawMeshes = new WeakMap<Shape3D, BodyMesh>();
export function drawingMesh(id: string, shape: Shape3D, smoothSteps: Set<string>): BodyMesh {
  const have = meshCache.get(shape) ?? drawMeshes.get(shape);
  if (have) {
    return { ...have, id, name: id };
  }
  const mesh: BodyMesh = {
    ...meshGeometry(id, id, shape, smoothSteps),
    faces: shape.faces.map(face => ({ type: face.geomType }) as FaceInfo),
    edges: shape.edges.map(edge => ({ type: edge.geomType }) as EdgeInfo),
    openEdges: []
  };
  drawMeshes.set(shape, mesh);

  return mesh;
}

/** The mesh without its faces' and edges' facts (what the view and the drawings each add their own of). */
function meshGeometry(id: string, name: string, shape: Shape3D, smoothSteps: Set<string>): Omit<BodyMesh, 'faces' | 'edges' | 'openEdges'> {
  const { m, e } = meshLines(shape, smoothSteps);

  return {
    id,
    name,
    key: meshKey++,
    positions: new Float32Array(m.vertices),
    normals: new Float32Array(m.normals),
    indices: new Uint32Array(m.triangles),
    faceGroups: m.faceGroups.map((faceGroup, i) => ({ start: faceGroup.start, count: faceGroup.count, face: i })),
    edgePositions: new Float32Array(e.lines),
    edgeGroups: e.edgeGroups.map((edgeGroup, i) => ({ start: edgeGroup.start, count: edgeGroup.count, edge: i }))
  };
}

/** The Freeform Face steps among these (their faces are patches of one smooth surface). */
export function smoothStepsOf(features: Feature[]): Set<string> {
  return new Set(features.filter(feature => feature.type === 'faceFreeform').map(feature => feature.id));
}

export function meshBody(id: string, name: string, shape: Shape3D, smoothSteps: Set<string>): BodyMesh {
  const cached = meshCache.get(shape);
  if (cached) {
    return { ...cached, id, name };
  }
  // Group order matches shape.faces / shape.edges order (verified); ids are hashes.
  const mesh: BodyMesh = {
    ...meshGeometry(id, name, shape, smoothSteps),
    faces: shape.faces.map((face, i) => ({ ...getFaceInfo(face), step: faceSteps(shape)?.[i], curve: faceOrigins(shape)?.[i], ...(faceAliases(shape)?.[i] ? { was: faceAliases(shape)![i] } : {}) })),
    edges: shape.edges.map((e, i) => ({ ...edgeInfo(e), steps: edgeSteps(shape)?.[i], curves: edgeOrigins(shape)?.[i], ...(oldEdgeSteps(shape) ? { was: oldEdgeSteps(shape)![i] } : {}), ...(seamEdges(shape)[i] ? { seam: true } : {}) })),
    openEdges: openEdges(shape)
  };
  meshCache.set(shape, mesh);

  return mesh;
}
