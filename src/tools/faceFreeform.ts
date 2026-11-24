// Freeform Face: a flat face of a body made a smooth surface. A cage is laid
// over the face - a grid whose border runs round the face's edge - and shaped
// in the Freeform tool: tap its points, edges or faces and move them with the
// gimbal (along the face, or out of it). The border stays put, so the face's
// edges, and the rest of the body, don't move.

import { editedStep } from '../doc/freeformEdits';
import { facesNormal } from '../freeform/faceGrid';
import { faceStepNormal, FreeformTool, layFaceCage, type EditKeep } from './freeform';
import { faceRefOf, type AppContext, type Sel, type Tool } from './tool';
import type { FaceFreeformFeature, FaceRef, Vec3 } from '../doc/types';

/** The triangles of face `i` of a body as shown (the cage goes only where the face is). */
function faceTriangles(app: AppContext, body: string, i: number): [Vec3, Vec3, Vec3][] {
  const b = app.view.body(body);
  const faceGroup = b?.faceGroups.find(faceGroup => faceGroup.face === i);
  if (!b || !faceGroup) {
    return [];
  }
  const vertexAt = (vertex: number): Vec3 => [b.positions[3 * vertex], b.positions[3 * vertex + 1], b.positions[3 * vertex + 2]];
  const out: [Vec3, Vec3, Vec3][] = [];
  for (let t = faceGroup.start; t < faceGroup.start + faceGroup.count; t += 3) {
    out.push([vertexAt(b.indices[t]), vertexAt(b.indices[t + 1]), vertexAt(b.indices[t + 2])]);
  }

  return out;
}

/** Do the faces (each as its triangles) all hang together, each sharing an edge with another? */
function joined(faces: [Vec3, Vec3, Vec3][][]): boolean {
  const key = (point: Vec3) => point.map(x => Math.round(x * 1e4)).join(',');
  const edgesOf = (tris: [Vec3, Vec3, Vec3][]) => {
    const edges = new Set<string>();
    for (const t of tris) {
      for (let corner = 0; corner < 3; corner++) {
        const a = key(t[corner]);
        const b = key(t[(corner + 1) % 3]);
        edges.add(a < b ? `${a}|${b}` : `${b}|${a}`);
      }
    }

    return edges;
  };
  const sets = faces.map(edgesOf);
  const reached = new Set([0]);
  for (let grew = true; grew; ) {
    grew = false;
    for (let i = 0; i < sets.length; i++) {
      if (reached.has(i)) {
        continue;
      }
      if ([...reached].some(j => [...sets[i]].some(e => sets[j].has(e)))) {
        (reached.add(i), (grew = true));
      }
    }
  }

  return reached.size === sets.length;
}

/**
 * A Freeform Face step (as its edits leave it) whose surface on the picked
 * faces' body shares an edge with them, and that surface's triangles.
 */
function touchedStep(app: AppContext, picked: Extract<Sel, { kind: 'face' }>[]): { step: FaceFreeformFeature; tris: [Vec3, Vec3, Vec3][] } | null {
  const body = picked[0].body;
  if (picked.some(pick => pick.body !== body)) {
    return null;
  }
  const faces = app.view.body(body)?.faces ?? [];
  const mine = new Set(picked.map(pick => pick.face));
  const steps = [...new Set(faces.flatMap((face, faceIndex) => (face.step && !mine.has(faceIndex) ? [face.step] : [])))];
  const pickedTris = picked.map(pick => faceTriangles(app, body, pick.face));
  for (const id of steps) {
    const faceFreeform = editedStep<FaceFreeformFeature>(app.store.features, id);
    if (faceFreeform?.type !== 'faceFreeform' || faceFreeform.face.body !== body) {
      continue;
    }
    const tris = faces.flatMap((face, faceIndex) => (face.step === id && !mine.has(faceIndex) ? faceTriangles(app, body, faceIndex) : []));
    if (tris.length && joined([tris, ...pickedTris])) {
      return { step: faceFreeform, tris };
    }
  }

  return null;
}

/** The face most like a saved one (facing the same way, its middle nearest), or -1. */
function nearestFace(faces: { center: Vec3; normal: Vec3 }[], ref: FaceRef): number {
  let best = -1;
  let distance = Infinity;
  faces.forEach((face, faceIndex) => {
    if (face.normal[0] * ref.normal[0] + face.normal[1] * ref.normal[1] + face.normal[2] * ref.normal[2] < 0.999) {
      return;
    }
    const e = Math.hypot(face.center[0] - ref.center[0], face.center[1] - ref.center[1], face.center[2] - ref.center[2]);
    if (e < distance) {
      ((distance = e), (best = faceIndex));
    }
  });

  return best;
}

/**
 * The Freeform tool on a face: `face`, a flat face to shape (a new step), or
 * `existing`, a Freeform Face step to change (its face found on the body by
 * the step that made it). Null (after saying why) when no cage fits the face.
 */
export function faceFreeformTool(app: AppContext, face: Extract<Sel, { kind: 'face' }> | Extract<Sel, { kind: 'face' }>[] | null, existing?: FaceFreeformFeature, keep?: EditKeep): Tool | null {
  if (existing) {
    const faces = app.view.body(existing.face.body)?.faces ?? [];
    // (Several faces made one: the surface may be in pieces, all made by the step.)
    let at = faces.flatMap((face, faceIndex) => (face.step === existing.id ? [faceIndex] : []));
    if (!existing.more?.length) {
      at = at.slice(0, 1);
    }
    // The step didn't work (so its face isn't there): the flat faces it was made on.
    if (!at.length) {
      at = [existing.face, ...(existing.more ?? [])].map(faceRef => nearestFace(faces, faceRef)).filter(faceIndex => faceIndex >= 0);
    }
    // (Over a face already shaped the cage is laid on its outline, which is the flat face's.)
    const tris = at.flatMap(faceIndex => faceTriangles(app, existing.face.body, faceIndex));
    const feature = structuredClone(existing);
    if (!feature.cage?.verts?.length) {
      // Made before faces had cages: a fresh one over it.
      const laid = layFaceCage(tris, feature.face.center, faceStepNormal(feature), 5, !!feature.more?.length);
      if (!laid) {
        return (app.ui.toast("This face's outline won't take a grid - pick it again with Freeform Face"), null);
      }
      feature.cage = laid.cage;
      feature.grid = laid.n;
    }

    return new FreeformTool(app, { face: { feature, existing: true, tris, keep } });
  }
  const picked = !face ? [] : Array.isArray(face) ? face : [face];
  const refs = picked.map(pick => faceRefOf(app, pick) as FaceRef | null);
  if (!picked.length || refs.some(ref => !ref)) {
    return null;
  }
  const [ref, ...more] = refs as FaceRef[];
  const tris = picked.flatMap(pick => faceTriangles(app, pick.body, pick.face));
  // Several faces: they must touch, one after another (a grid can't jump a gap).
  if (more.length && !joined(picked.map(pick => faceTriangles(app, pick.body, pick.face)))) {
    return (app.ui.toast('Pick faces that touch each other - side by side, sharing an edge'), null);
  }
  // Touching a surface a Freeform Face step made on the same body: that step
  // grows to take these faces in - one surface, no edge where they meet (an
  // Edit Freeform step in History: delete it and they are apart again).
  const grow = touchedStep(app, picked);
  if (grow) {
    const step = grow.step;
    const all: FaceRef[] = [...(step.more ?? []), ...(refs as FaceRef[])];
    const feature: FaceFreeformFeature = { ...structuredClone(step), more: all };
    const both = [...grow.tris, ...tris];
    // (Laid over the surface as it is shaped now and the new faces: what was shaped stays so, near enough.)
    const laid = layFaceCage(both, step.face.center, faceStepNormal(feature), Math.max(5, step.grid ?? 5), true);
    if (!laid) {
      return (app.ui.toast("These faces won't take one grid with the freeform beside them (seen together they fold back over each other)"), null);
    }
    feature.cage = laid.cage;
    feature.grid = laid.n;
    app.ui.toast(`Joined to ${step.name}: one smooth surface`);

    return new FreeformTool(app, { face: { feature, existing: true, tris: both } });
  }
  const normal = more.length ? facesNormal([ref.normal, ...more.map(faceRef => faceRef.normal)]) : ref.normal;
  const laid = layFaceCage(tris, ref.center, normal, 5, more.length > 0);
  if (!laid) {
    return (app.ui.toast(more.length ? "These faces won't take one grid (seen together they fold back over each other) - pick fewer" : "This face's outline won't take a grid (too small, or too odd a shape)"), null);
  }
  const feature: FaceFreeformFeature = { ...app.store.newIdentity('faceFreeform'), type: 'faceFreeform', face: ref, ...(more.length ? { more } : {}), cage: laid.cage, grid: laid.n };

  return new FreeformTool(app, { face: { feature, existing: false, tris } });
}
