// Copies of freeform bodies as their own freeforms (pure document logic).
//
// A Move/Copy step copies a body; for a freeform that copy would still be
// built from the original's cage, so editing either one changed both. Unless
// the copy is linked, it becomes an independent freeform feature with its own
// (moved) cage - edits on it stay on it.

import type { Feature, FreeformFeature, ProjectDoc, TransformFeature, Vec3 } from './types';

/** x' = A x + t as rows [a00 a01 a02 t0, …]. */
export type Affine = number[];
const ID: Affine = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];

export const applyAffine = (affine: Affine, point: Vec3): Vec3 => [0, 1, 2].map(row => affine[row * 4] * point[0] + affine[row * 4 + 1] * point[1] + affine[row * 4 + 2] * point[2] + affine[row * 4 + 3]) as Vec3;

function then(affine: Affine, after: Affine): Affine {
  const out: number[] = [];
  for (let row = 0; row < 3; row++) {
    for (let column = 0; column < 3; column++) {
      out.push(after[row * 4] * affine[column] + after[row * 4 + 1] * affine[4 + column] + after[row * 4 + 2] * affine[8 + column]);
    }
    out.push(after[row * 4] * affine[3] + after[row * 4 + 1] * affine[7] + after[row * 4 + 2] * affine[11] + after[row * 4 + 3]);
  }

  return out;
}

export const det = (affine: Affine) => affine[0] * (affine[5] * affine[10] - affine[6] * affine[9]) - affine[1] * (affine[4] * affine[10] - affine[6] * affine[8]) + affine[2] * (affine[4] * affine[9] - affine[5] * affine[8]);

function rotate(point: Vec3, origin: Vec3, axis: Vec3, deg: number): Vec3 {
  const length = Math.hypot(...axis) || 1;
  const unitAxis: Vec3 = [axis[0] / length, axis[1] / length, axis[2] / length];
  const offset: Vec3 = [point[0] - origin[0], point[1] - origin[1], point[2] - origin[2]];
  const t = (deg * Math.PI) / 180;
  const cos = Math.cos(t);
  const sin = Math.sin(t);
  const kv = unitAxis[0] * offset[0] + unitAxis[1] * offset[1] + unitAxis[2] * offset[2];
  const x: Vec3 = [unitAxis[1] * offset[2] - unitAxis[2] * offset[1], unitAxis[2] * offset[0] - unitAxis[0] * offset[2], unitAxis[0] * offset[1] - unitAxis[1] * offset[0]];

  return [0, 1, 2].map(i => origin[i] + offset[i] * cos + x[i] * sin + unitAxis[i] * kv * (1 - cos)) as Vec3;
}

function fromMap(map: (p: Vec3) => Vec3): Affine {
  const origin = map([0, 0, 0]);
  const cols = ([[1, 0, 0], [0, 1, 0], [0, 0, 1]] as Vec3[]).map(e => map(e).map((x, i) => x - origin[i]));

  return [0, 1, 2].flatMap(row => [cols[0][row], cols[1][row], cols[2][row], origin[row]]);
}

/** The map of a move / scale / mirror step (null for patterns). */
export function stepAffine(op: TransformFeature['op']): Affine | null {
  switch (op.kind) {
    case 'move': {
      const rotation = op.rotate && Math.abs(op.rotate.angle) > 1e-9 ? op.rotate : null;

      return fromMap((point) => {
        const q = rotation ? rotate(point, rotation.origin, rotation.axis, rotation.angle) : point;

        return [q[0] + op.translate[0], q[1] + op.translate[1], q[2] + op.translate[2]];
      });
    }
    case 'scale':
      return fromMap(point => point.map((x, i) => op.center[i] + (x - op.center[i]) * op.factor) as Vec3);
    case 'scaleXYZ':
      return fromMap(point => point.map((x, i) => op.center[i] + (x - op.center[i]) * op.factors[i]) as Vec3);
    case 'mirror': {
      const normal = op.plane.normal;
      const length = Math.hypot(...normal) || 1;
      const unitNormal: Vec3 = [normal[0] / length, normal[1] / length, normal[2] / length];

      return fromMap((point) => {
        const distance = (point[0] - op.plane.origin[0]) * unitNormal[0] + (point[1] - op.plane.origin[1]) * unitNormal[1] + (point[2] - op.plane.origin[2]) * unitNormal[2];

        return [point[0] - 2 * distance * unitNormal[0], point[1] - 2 * distance * unitNormal[1], point[2] - 2 * distance * unitNormal[2]];
      });
    }
    default:
      return null;
  }
}

/**
 * Which bodies are (still) a freeform's cage moved about, after the first
 * `upto` features: like the engine, anything other than a move/scale/mirror
 * touching a body makes it an ordinary body.
 */
export function freeformBodies(features: readonly Feature[], upto = features.length): Map<string, { feature: FreeformFeature; m: Affine }> {
  const out = new Map<string, { feature: FreeformFeature; m: Affine }>();
  for (const feature of features.slice(0, upto)) {
    if (feature.suppressed) {
      continue;
    }
    if (feature.type === 'freeform') {
      out.set(feature.id, { feature: feature, m: ID });
      continue;
    }
    // An Edit Freeform step: the freeform (and its copies) with the new cage.
    if (feature.type === 'freeformEdit') {
      for (const [id, ff] of out) {
        if (ff.feature.id === feature.target) {
          out.set(id, { ...ff, feature: { ...ff.feature, ...feature.patch } });
        }
      }
      continue;
    }
    if (feature.type === 'transform') {
      const step = stepAffine(feature.op);
      for (const id of feature.bodies) {
        const ff = out.get(id);
        if (!ff) {
          continue;
        }
        if (!step) {
          continue;
        } // a pattern: the copies are ordinary bodies
        if (feature.copy) {
          out.set(`${feature.id}:${id}:0`, { feature: ff.feature, m: then(ff.m, step) });
        } else {
          out.set(id, { feature: ff.feature, m: then(ff.m, step) });
        }
      }
      continue;
    }
    const text = JSON.stringify(feature);
    for (const id of [...out.keys()]) {
      if (text.includes(`"${id}"`)) {
        out.delete(id);
      }
    }
  }

  return out;
}

/** Body ids inside a JSON text: `old` (alone or as part of a copy's id) becomes `now`. */
function renameIn(text: string, old: string, now: string): string {
  const esc = old.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  return text.replace(new RegExp(`([":])${esc}(?=[":])`, 'g'), `$1${now}`);
}

/**
 * Turn a freeform body made by a copy step into its own freeform feature (in
 * the copy step's place). Later steps that use the copy use the new feature.
 * Returns the new features and the new body id (null when it isn't a
 * freeform copy).
 */
export function detachFreeformCopy(doc: ProjectDoc, bodyId: string, newId: string): { doc: ProjectDoc; id: string } | null {
  const [tid, ...rest] = bodyId.split(':');
  if (rest.length < 2) {
    return null;
  }
  const src = rest.slice(0, -1).join(':');
  const i = doc.features.findIndex(feature => feature.id === tid);
  const t = doc.features[i] as TransformFeature | undefined;
  if (!t || t.type !== 'transform' || !t.copy || t.link || !t.bodies.includes(src)) {
    return null;
  }
  const ff = freeformBodies(doc.features, i + 1).get(bodyId);
  if (!ff) {
    return null;
  }
  const flip = det(ff.m) < 0;
  const clone: FreeformFeature = {
    ...structuredClone(ff.feature),
    id: newId,
    name: t.name,
    cage: {
      verts: ff.feature.cage.verts.map(vertex => applyAffine(ff.m, vertex)),
      // A mirror turns the shape inside out: wind the quads the other way.
      faces: ff.feature.cage.faces.map(q => (flip ? ([q[0], q[3], q[2], q[1]] as typeof q) : ([...q] as typeof q))),
      ...(ff.feature.cage.creases ? { creases: structuredClone(ff.feature.cage.creases) } : {})
    }
  };
  const features = [...doc.features];
  const left = t.bodies.filter(b => b !== src);
  if (left.length) {
    features.splice(i, 1, { ...t, bodies: left }, clone);
  } else {
    features.splice(i, 1, clone);
  }
  const rename = <T>(x: T): T => JSON.parse(renameIn(JSON.stringify(x), bodyId, newId)) as T;
  const at = features.indexOf(clone);
  const out: ProjectDoc = {
    ...doc,
    features: [...features.slice(0, at + 1), ...features.slice(at + 1).map(rename)],
    hidden: rename(doc.hidden),
    names: Object.fromEntries(Object.entries(doc.names ?? {}).map(([key, value]) => [renameIn(`"${key}"`, bodyId, newId).slice(1, -1), value]))
  };
  if (doc.colors) {
    out.colors = Object.fromEntries(Object.entries(doc.colors).map(([key, value]) => [renameIn(`"${key}"`, bodyId, newId).slice(1, -1), value]));
  }
  if (doc.materials) {
    out.materials = Object.fromEntries(Object.entries(doc.materials).map(([key, value]) => [renameIn(`"${key}"`, bodyId, newId).slice(1, -1), value]));
  }
  // The copy's name in Items stays what it was.
  if (!out.names?.[newId] && doc.names?.[bodyId]) {
    out.names = { ...out.names, [newId]: doc.names[bodyId] };
  }

  return { doc: out, id: newId };
}

/** The map that undoes `affine`. */
export function invertAffine(affine: Affine): Affine {
  const [a, b, m02, , m10, e, m12, , m20, m21, i] = affine;
  const determinant = det(affine);
  const inv = [(e * i - m12 * m21) / determinant, (m02 * m21 - b * i) / determinant, (b * m12 - m02 * e) / determinant, (m12 * m20 - m10 * i) / determinant, (a * i - m02 * m20) / determinant, (m02 * m10 - a * m12) / determinant, (m10 * m21 - e * m20) / determinant, (b * m20 - a * m21) / determinant, (a * e - b * m10) / determinant];
  const t = [affine[3], affine[7], affine[11]];
  const out: Affine = [];
  for (let row = 0; row < 3; row++) {
    out.push(inv[row * 3], inv[row * 3 + 1], inv[row * 3 + 2], -(inv[row * 3] * t[0] + inv[row * 3 + 1] * t[1] + inv[row * 3 + 2] * t[2]));
  }

  return out;
}
