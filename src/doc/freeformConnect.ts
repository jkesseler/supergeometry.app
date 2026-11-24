// Connect border edges of freeform surfaces (pure document logic): two rows of
// edges get a strip of quads between them, two hole rims a tube. Edges on two
// different freeforms make them one freeform (so the whole thing can then be
// given a thickness). Like making a face from edges in a mesh modeller.

import { borderChains, borderEdgeMids, bridgeChains, cageEdgeKey, joinCages, flipFaces, windingAgrees, type Cage, type Chain } from '../freeform/cage';
import { applyAffine, freeformBodies, invertAffine } from './freeformCopies';
import type { Feature, FreeformFeature, ProjectDoc, TransformFeature, Vec3 } from './types';

/** A picked edge of a finished body: which body, and its middle point (world). */
export interface PickedEdge {
  body: string;
  mid: Vec3;
}

const dist = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** The cage of a freeform body where the body is (moves later in History applied). */
function worldCage(doc: ProjectDoc, body: string): { feature: FreeformFeature; cage: Cage; m: number[] } | null {
  const ff = freeformBodies(doc.features).get(body);
  if (!ff || ff.feature.id !== body) {
    return null;
  }

  return { feature: ff.feature, m: ff.m, cage: { ...ff.feature.cage, verts: ff.feature.cage.verts.map(vertex => applyAffine(ff.m, vertex)) } };
}

/** The open-border cage edges under the picked body edges (null if one isn't on a border). */
function cageEdgesAt(cage: Cage, picks: Vec3[]): Set<string> | null {
  const mids = borderEdgeMids(cage);
  if (!mids.length) {
    return null;
  }
  const chosen = new Set<string>();
  for (const pick of picks) {
    let best = mids[0];
    for (const mid of mids) {
      if (dist(mid.at, pick) < dist(best.at, pick)) {
        best = mid;
      }
    }
    // Far from every border edge: an inner edge, or another part of the shape.
    const [a, b] = best.e;
    const edgeLength = dist(cage.verts[a], cage.verts[b]);
    if (dist(best.at, pick) > Math.max(edgeLength * 0.35, 1e-6)) {
      return null;
    }
    chosen.add(cageEdgeKey(a, b));
  }

  return chosen;
}

export type ConnectResult = { doc: ProjectDoc; body: string } | { error: string };

/**
 * Connect the picked border edges. They must make two runs with the same
 * number of edges (two edges, two rows, or two hole rims), on one freeform or
 * on two. Two freeforms become one: the later one in History keeps the result
 * and the earlier one goes.
 */
export function connectEdges(doc: ProjectDoc, picks: PickedEdge[]): ConnectResult {
  const bodies = [...new Set(picks.map(pick => pick.body))];
  if (bodies.length > 2) {
    return { error: 'Pick edges on one or two freeform surfaces' };
  }
  const parts = bodies.map(b => worldCage(doc, b));
  if (parts.some(part => !part)) {
    return { error: "Connect works on freeform surfaces - edit the shape's cage first" };
  }
  const [firstPart, secondPart] = parts as NonNullable<(typeof parts)[number]>[];
  // One cage holding everything, and the chosen border edges in it.
  let cage = firstPart.cage;
  let offset = 0;
  if (secondPart) {
    ({ cage, offset } = joinCages(firstPart.cage, secondPart.cage));
  }
  const chosen = new Set<string>();
  for (const [index, part] of parts.entries()) {
    const at = cageEdgesAt(part!.cage, picks.filter(pick => pick.body === bodies[index]).map(pick => pick.mid));
    if (!at) {
      return { error: 'Pick edges along an open border (the rim of a surface or of a hole)' };
    }
    const partOffset = index === 0 ? 0 : offset;
    for (const key of at) {
      const [a, b] = key.split(',').map(Number);
      chosen.add(cageEdgeKey(a + partOffset, b + partOffset));
    }
  }
  const runs = borderChains(cage, chosen);
  if (runs.length !== 2) {
    return { error: runs.length < 2 ? 'Pick the edges on both sides you want to connect' : 'Pick two runs of edges (one on each side) to connect' };
  }
  const [chainA, chainB] = runs as [Chain, Chain];
  const edges = (chain: Chain) => (chain.closed ? chain.verts.length : chain.verts.length - 1);
  if (chainA.closed !== chainB.closed) {
    return { error: 'Connect a hole with a hole, or a row of edges with a row' };
  }
  if (edges(chainA) !== edges(chainB)) {
    return { error: `Both sides need the same number of edges (${edges(chainA)} and ${edges(chainB)})` };
  }
  let next = bridgeChains(cage, chainA, chainB);
  if (!next) {
    return { error: "These edges can't be connected (they touch each other)" };
  }
  // Two surfaces facing opposite ways: turn the second one round so they join up.
  if (secondPart && !windingAgrees(next)) {
    const flipped = bridgeChains(flipFaces(cage, i => i >= firstPart.cage.faces.length), chainA, chainB);
    if (flipped && windingAgrees(flipped)) {
      next = flipped;
    }
  }
  if (!secondPart) {
    return { doc: store(doc, firstPart.feature, next, firstPart.m), body: firstPart.feature.id };
  }
  // Two freeforms → one: the later step keeps it, the earlier one goes.
  // (By id: an edited freeform's feature here is its step with the edits put in, not the step itself.)
  const at = (id: string) => doc.features.findIndex(feature => feature.id === id);
  const [keep, drop, mKeep] = at(firstPart.feature.id) < at(secondPart.feature.id) ? [secondPart.feature, firstPart.feature, secondPart.m] : [firstPart.feature, secondPart.feature, firstPart.m];
  // Its Edit Freeform steps and its own moves are in the merged cage: they don't keep it from going.
  const users = doc.features.filter(
    feature =>
      feature.id !== drop.id
      && !(feature.type === 'freeformEdit' && (feature.target === drop.id || feature.target === keep.id))
      && JSON.stringify(feature).includes(`"${drop.id}"`)
      && !(feature.type === 'transform' && !feature.copy && ['move', 'scale', 'mirror', 'scaleXYZ'].includes(feature.op.kind))
  );
  if (users.length) {
    return { error: `“${drop.name}” is used by “${users[0].name}” later on - it can't be merged into the other surface` };
  }
  const out = store({ ...doc, features: doc.features.filter(feature => !(feature.type === 'freeformEdit' && feature.target === drop.id)) }, keep, next, mKeep, { surface: !!(keep.surface || drop.surface) });
  // The dropped one's own moves go with it (they are already in the merged cage).
  out.features = out.features
    .filter(feature => feature.id !== drop.id)
    .map(feature => (feature.type === 'transform' && feature.bodies.includes(drop.id) ? ({ ...feature, bodies: feature.bodies.filter(b => b !== drop.id) } as TransformFeature) : feature))
    .filter(feature => !(feature.type === 'transform' && !feature.bodies.length));
  out.hidden = out.hidden.filter(hiddenId => hiddenId !== drop.id);

  return { doc: out, body: keep.id };
}

/**
 * Put a world-space cage back into a freeform step (in its own coordinates).
 * Its Edit Freeform steps go: their edits are in that cage already (and a
 * later one would otherwise put its own cage back over it).
 */
function store(doc: ProjectDoc, freeform: FreeformFeature, cage: Cage, matrix: number[], extra: Partial<FreeformFeature> = {}): ProjectDoc {
  const inv = invertAffine(matrix);
  const updated: FreeformFeature = { ...freeform, ...extra, cage: { ...cage, verts: cage.verts.map(vertex => applyAffine(inv, vertex)) } };

  return { ...doc, features: doc.features.filter(feature => !(feature.type === 'freeformEdit' && feature.target === freeform.id)).map((feature): Feature => (feature.id === freeform.id ? updated : feature)) };
}
