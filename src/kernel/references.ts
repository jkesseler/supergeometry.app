import { makeVertex, measureDistanceBetween } from 'replicad';
import { dist, dot, len, norm, sub, toWorld, xDirFor } from '../geom';
import { areaProperties } from './ocFree';
import { cylinderOf } from './faceEdit';
import { edgeOrigins, edgeSteps, faceAliases, faceOrigins, faceSteps, oldEdgeSteps, sameSteps, seamEdges } from './provenance';
import type { AxisRef, EdgeRef, FaceRef, Vec3 } from '../doc/types';
import type { Ctx } from './types';
import type { Edge, Face, Shape3D } from 'replicad';
import type { EdgeInfo, FaceInfo } from './protocol';

export function resolveAxis(a: AxisRef, ctx: Ctx): { origin: Vec3; dir: Vec3 } {
  if (a.ref?.kind === 'sketchLine') {
    const sketchState = ctx.sketches.get(a.ref.sketch);
    const e = sketchState?.entities.find(entity => entity.id === (a.ref as { entity: string }).entity);
    if (sketchState && e?.kind === 'line') {
      const worldPoint = toWorld(sketchState.plane, e.a);

      return { origin: worldPoint, dir: norm(sub(toWorld(sketchState.plane, e.b), worldPoint)) };
    }
  }
  if (a.ref?.kind === 'axis') {
    const ax = ctx.axes.get(a.ref.feature);
    if (ax) {
      return { origin: ax.plane.origin, dir: ax.plane.normal };
    }
  }

  return { origin: a.origin, dir: norm(a.dir) };
}

export function faceInfo(face: Face): FaceInfo {
  // (Middle and area from one measuring: each face of every body shown was measured twice.)
  const { area, center } = areaProperties(face);
  const normal = norm(face.normalAt().toTuple() as Vec3);
  const info: FaceInfo = { center, normal, area, type: face.geomType };
  if (face.geomType === 'PLANE') {
    info.plane = { origin: center, normal, xDir: xDirFor(normal) };
  }
  if (face.geomType === 'CYLINDRE') {
    const cy = cylinderOf(face);
    if (cy) {
      info.round = { r: cy.r, hole: cy.s < 0 };
    }
  }

  return info;
}

export function edgeInfo(edge: Edge): EdgeInfo {
  const info: EdgeInfo = {
    mid: edge.pointAt(0.5).toTuple() as Vec3,
    dir: norm(edge.tangentAt(0.5).toTuple() as Vec3),
    length: edge.length,
    start: edge.startPoint.toTuple() as Vec3,
    end: edge.endPoint.toTuple() as Vec3,
    type: edge.geomType
  };

  return info;
}

/** Best-matching face for a stored signature (survives upstream edits). */
export function resolveFace(body: Shape3D, ref: FaceRef, only?: (f: Face) => boolean): Face {
  const size = Math.sqrt(ref.area) || 1;
  let best: { face: Face; score: number } | null = null;
  // Only faces made by the step that made the one picked (see provenance.ts).
  let steps = ref.step ? faceSteps(body) : undefined;
  const faces = body.faces;
  // (Saved when a face on another body's plane was put down to that body's step: found by that.)
  const old = steps && !steps.includes(ref.step!) ? faceAliases(body) : undefined;
  if (old) {
    steps = steps!.map((step, i) => old[i] ?? step);
  }
  if (steps && !faces.some((_, i) => steps![i] === ref.step)) {
    // The step that made it makes no face here now (turned by 0, switched
    // off): the face that is plainly the same one - facing the same way within
    // a few degrees, its middle where it was, much the same size - else gone.
    let near: { face: Face; score: number } | null = null;
    for (const face of faces) {
      if (only && !only(face)) {
        continue;
      }
      const fi = faceInfo(face);
      const align = dot(fi.normal, ref.normal);
      const off = dist(fi.center, ref.center) / size;
      const grew = Math.abs(Math.log((fi.area + 1e-9) / (ref.area + 1e-9)));
      if (align < 0.99 || off > 0.25 || grew > 0.25) {
        continue;
      }
      const score = off + (1 - align) * 4 + grew;
      if (!near || score < near.score) {
        near = { face, score };
      }
    }
    if (near) {
      return near.face;
    }
    throw new Error(FACE_GONE);
  }
  // The one made from the same sketch curve, if that can be told: wherever it
  // is now. (Cut in two since: the nearer piece, below.)
  const origins = steps && ref.curve ? faceOrigins(body) : undefined;
  let curve = ref.curve;
  const sameAs = (origin: string) => faces.filter((face, i) => steps![i] === ref.step && origins![i] === origin && (!only || only(face)));
  let same = origins ? sameAs(curve!) : [];
  // The far end of an extrusion since turned to go the other way: still its far end.
  const turned = origins && !same.length ? otherEnd(curve!) : null;
  if (turned && !origins!.includes(curve!) && sameAs(turned).length) {
    same = sameAs((curve = turned));
  }
  if (same.length === 1) {
    return same[0];
  }
  for (const [i, face] of faces.entries()) {
    if (steps && steps![i] !== ref.step) {
      continue;
    }
    if (same.length && origins![i] !== curve) {
      continue;
    }
    if (only && !only(face)) {
      continue;
    }
    const fi = faceInfo(face);
    const align = dot(fi.normal, ref.normal);
    if (align < 0.5 && !same.length) {
      continue;
    }
    const score = dist(fi.center, ref.center) / size + (1 - align) * 4 + Math.abs(Math.log((fi.area + 1e-9) / (ref.area + 1e-9)));
    if (!best || score < best.score) {
      best = { face, score };
    }
  }
  if (!best) {
    throw new Error(FACE_GONE);
  }

  return best.face;
}

/** What a step says when what it was built on is gone (an earlier step was changed or switched off). */
const FACE_GONE = 'The face it was built on is gone (something before it changed). Tap this step and pick the face again.';
export const EDGE_GONE = 'An edge it was built on is gone (something before it changed). Tap this step and pick the edges again.';

/** How far a point is from an edge (its curve, between its ends). */
function pointToEdge(point: Vec3, edge: Edge): number {
  const vertex = makeVertex(point);
  try {
    return measureDistanceBetween(edge, vertex);
  } catch {
    return Infinity;
  } finally {
    vertex.delete();
  }
}

/** The edge (not a seam) whose curve runs through a picked edge's middle, along its direction (else null). */
function edgeByPlace(table: { edges: Edge[]; infoOf(i: number): EdgeInfo }, ref: EdgeRef, refDir: Vec3, seams?: boolean[]): Edge | null {
  let best: { edge: Edge; d: number } | null = null;
  for (const [i, edge] of table.edges.entries()) {
    if (seams?.[i]) {
      continue;
    }
    const ei = table.infoOf(i);
    const tol = Math.max(ref.length, ei.length) * 0.05;
    // (Too far for its middle to be on it at all.)
    if (dist(ei.mid, ref.mid) > ei.length / 2 + tol + 1e-9) {
      continue;
    }
    const distance = pointToEdge(ref.mid, edge);
    if (!(distance < tol) || (best && distance >= best.d)) {
      continue;
    }
    // Along it there: the nearest of a few points on it, its direction.
    let sampleIndex = 0;
    let kd = Infinity;
    for (let j = 0; j <= 20; j++) {
      const dj = dist(edge.pointAt(j / 20).toTuple() as Vec3, ref.mid);
      if (dj < kd) {
        [sampleIndex, kd] = [j, dj];
      }
    }
    if (Math.abs(dot(norm(edge.tangentAt(sampleIndex / 20).toTuple() as Vec3), refDir)) < 0.8) {
      continue;
    }
    best = { edge, d: distance };
  }

  return best?.edge ?? null;
}

/**
 * A body's edges and where each is, measured once. Finding the picked edges of
 * a 300-edge chamfer measured all the body's edges again for each (300 x 1000
 * on a gear), and each measuring leaves engine objects only freed after the
 * rebuild: 1.5 GB, and the next rebuild ran out of memory.
 */
const edgeTables = new WeakMap<Shape3D, { wrapped: unknown; edges: Edge[]; info: (EdgeInfo | undefined)[] }>();
function edgeTable(body: Shape3D): { edges: Edge[]; infoOf(i: number): EdgeInfo } {
  let t = edgeTables.get(body);
  if (!t || t.wrapped !== body.wrapped) {
    const edges = body.edges;
    t = { wrapped: body.wrapped, edges, info: new Array(edges.length) };
    edgeTables.set(body, t);
  }
  const table = t;

  return { edges: table.edges, infoOf: i => (table.info[i] ??= edgeInfo(table.edges[i])) };
}

/** An extrusion's far end named for the other side of its sketch ("…cap:1@…" for "…cap:2@…"); null: not a far end. */
function otherEnd(curve: string): string | null {
  const match = /^(.*\|)?cap:([12])@/.exec(curve);

  return match ? `${match[1] ?? ''}cap:${match[2] === '1' ? 2 : 1}@${curve.slice(match[0].length)}` : null;
}

/** `rounding`: for a fillet or chamfer - a seam (nothing to round) is never it. */
export function resolveEdge(body: Shape3D, ref: EdgeRef, rounding = false): Edge {
  const size = ref.length || 1;
  // (Saved directions are of unit length; one that isn't - written by hand, or by a
  // script from a curve's raw tangent - made the likeness below go negative: any edge fitted.)
  const refDir = len(ref.dir) > 1e-12 ? norm(ref.dir) : ref.dir;
  let best: { edge: Edge; score: number } | null = null;
  // A piece of it, or what it's now a piece of (below): only when nothing else is
  // much the same edge - a lid made 20 wider had its corners' rounds go to the
  // long side its old middle now lay on.
  let piece: { edge: Edge; score: number } | null = null;
  // Only edges between faces made by the same steps as the one picked.
  let steps = ref.steps ? edgeSteps(body) : undefined;
  const seams = rounding && steps ? seamEdges(body) : undefined;
  const table = edgeTable(body);
  const all = table.edges;
  // (Saved with a face put down to another body's step: found by that.)
  if (steps && !steps.some((step, i) => sameSteps(step, ref.steps!) && !seams?.[i])) {
    steps = oldEdgeSteps(body) ?? steps;
  }
  if (steps && !all.some((_, i) => sameSteps(steps[i], ref.steps!) && !seams?.[i])) {
    // No edge between faces of those steps now: a later step took the faces over (a blade's
    // root, its face trimmed at the tip when it was one face, not when lofted straight in
    // pieces). Still there if an edge runs through where it was, the same way.
    const there = edgeByPlace(table, ref, refDir, seams);
    if (there) {
      return there;
    }
    throw new Error(EDGE_GONE);
  }
  // The one between the same two faces (by the sketch curves they came from), wherever it is now.
  const origins = steps && ref.curves ? edgeOrigins(body) : undefined;
  let curves = ref.curves;
  const isIt = (i: number) => !!origins?.[i] && sameSteps(origins[i]!, curves!) && !seams?.[i];
  let same = origins ? all.filter((_, i) => isIt(i)) : [];
  // An edge of the far end of an extrusion since turned to go the other way (10 up edited to 20 down): still
  // that end's edge. (Its end was named by the side of the sketch it is on: a rounding of five edges was left
  // on four - the fifth was looked for by place, and found an edge already taken.)
  if (origins && !same.length && curves!.some(curve => otherEnd(curve))) {
    const turned = curves!.map(curve => otherEnd(curve) ?? curve).sort();
    const has = (cs: string[]) => origins.some((origin, i) => !!origin && sameSteps(origin, cs) && !seams?.[i]);
    const ends = (origin: string) => origins.some(tag => !!tag && tag.includes(origin));
    if (has(turned) && !curves!.some(curve => otherEnd(curve) && ends(curve))) {
      curves = turned;
      same = all.filter((_, i) => isIt(i));
    }
  }
  if (same.length === 1) {
    return same[0];
  }
  for (const [i, edge] of all.entries()) {
    if (steps && !sameSteps(steps[i], ref.steps!)) {
      continue;
    }
    if (same.length && !isIt(i)) {
      continue;
    }
    if (seams?.[i]) {
      continue;
    }
    const ei = table.infoOf(i);
    const align = Math.min(1, Math.abs(dot(ei.dir, refDir)));
    const like = (1 - align) * 2 + Math.abs(Math.log((ei.length + 1e-9) / (ref.length + 1e-9)));
    // Picked with its steps, the candidates are edges of the same kind: the
    // nearest is it, however far a resize moved it (a 3 mm lid's corner edges,
    // 20 mm out when the lid was made 40 wider, were "gone") - if it's still
    // much the same edge (the lid made round: its 3 mm corners aren't the rim circles).
    if (steps && like > 1.5 && !same.length) {
      // A piece of this edge when picked (a blade's root cut in two where the hub's seam
      // crossed it, whole once the blade moved), or the whole of what's now in pieces:
      // its middle lies on (or right by) this one.
      if (ei.length < ref.length && ei.length > ref.length * 0.05) {
        continue;
      }
      const near = pointToEdge(ref.mid, edge);
      if (!(near < Math.max(ref.length, ei.length) * 0.05)) {
        continue;
      }
      const score = near / size;
      if (!piece || score < piece.score) {
        piece = { edge, score };
      }
      continue;
    }
    const score = dist(ei.mid, ref.mid) / size + like;
    if (!best || score < best.score) {
      best = { edge, score };
    }
  }
  best ??= piece;
  // Without steps, only one close by.
  if (!best || (!steps && best.score > 3)) {
    throw new Error(EDGE_GONE);
  }


  return best.edge;
}
