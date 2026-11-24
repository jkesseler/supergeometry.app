// Which step made each face (and so each edge) of a body.
//
// A step built on a face or edge remembers it by where it is and how big it
// is; when an earlier step changes, the best match is taken. With nothing
// better to go on, "best" could be a face of another kind altogether: the
// screw bosses went onto the top of the box when the shell that made the
// floor they stood on was switched off, and a fillet round the bosses' feet
// rounded other edges once the bosses were gone - with no word.
//
// So every face is tagged with the step that made it: a face a step leaves
// as it was, or only trims (a side face cut shorter by a fillet, a wall with
// a hole cut through it), keeps its tag; a face it makes new gets the step's
// id. A reference then looks only among faces from the same step, and when
// there are none, says so instead of guessing.

import { getOC, type Face, type Shape3D } from 'replicad';

interface Tagged {
  /** The step that made each face (in the order of shape.faces). */
  steps: string[];
  /** Each face's surface (plane, cylinder, …) as a key, for faces only trimmed. */
  keys: (string | null)[];
  /** Faces by hash, for faces a step left as they were. */
  byHash: Map<number, { face: Face; i: number }[]>;
  /**
   * The step a face used to be put down to, where that was another body's
   * (see tagBody) or a Move's (see movedTags): what projects saved before
   * then name it by.
   */
  alias?: (string | undefined)[];
  /**
   * Where each face is now, against where its step made it: the moves, turns
   * and mirrorings its body has been through since (a 3 x 4 matrix, row by
   * row; none: where it was made).
   */
  moves?: (Moved | undefined)[];
}

/** A 3 x 4 matrix, row by row: where a point is after a move. */
type Moved = number[];
/** First `moved`, then `after`. */
function then(moved: Moved, after: Moved): Moved {
  const out: number[] = [];
  for (let row = 0; row < 3; row++) {
    for (let column = 0; column < 3; column++) {
      out.push(after[row * 4] * moved[column] + after[row * 4 + 1] * moved[4 + column] + after[row * 4 + 2] * moved[8 + column]);
    }
    out.push(after[row * 4] * moved[3] + after[row * 4 + 1] * moved[7] + after[row * 4 + 2] * moved[11] + after[row * 4 + 3]);
  }

  return out;
}

/** A point (or a direction a face looks) taken back to where it was before a move. */
export type Back = (v: [number, number, number], direction?: boolean) => [number, number, number];
function backOf(moved: Moved): Back {
  const [a, b, m02, m10, e, m12, m20, m21, i] = [moved[0], moved[1], moved[2], moved[4], moved[5], moved[6], moved[8], moved[9], moved[10]];
  const det = a * (e * i - m12 * m21) - b * (m10 * i - m12 * m20) + m02 * (m10 * m21 - e * m20);
  // The matrix turned back (its inverse).
  const inv = [e * i - m12 * m21, m02 * m21 - b * i, b * m12 - m02 * e, m12 * m20 - m10 * i, a * i - m02 * m20, m02 * m10 - a * m12, m10 * m21 - e * m20, b * m20 - a * m21, a * e - b * m10].map(x => x / det);

  return (vector, direction) => {
    // (The way a face looks goes back by the matrix laid on its side: the same thing for a move, a turn, a mirroring.)
    if (direction) {
      return [a * vector[0] + m10 * vector[1] + m20 * vector[2], b * vector[0] + e * vector[1] + m21 * vector[2], m02 * vector[0] + m12 * vector[1] + i * vector[2]];
    }
    const q = [vector[0] - moved[3], vector[1] - moved[7], vector[2] - moved[11]];

    return [inv[0] * q[0] + inv[1] * q[1] + inv[2] * q[2], inv[3] * q[0] + inv[4] * q[1] + inv[5] * q[2], inv[6] * q[0] + inv[7] * q[1] + inv[8] * q[2]];
  };
}

const tags = new WeakMap<Shape3D, Tagged>();
const edgeTags = new WeakMap<Shape3D, string[][]>();
const oldEdgeTags = new WeakMap<Shape3D, string[][] | null>();

const r4 = (value: number) => {
  const x = Math.round(value * 1e4) / 1e4;

  return Object.is(x, -0) ? '0' : String(x);
};

/** A face's surface, the same however much of it the face covers (null: no key for this kind). */
function surfaceKey(face: Face): string | null {
  const oc = getOC();
  const surface = new oc.BRepAdaptor_Surface(face.wrapped, true);
  try {
    const surfaceTypes = oc.GeomAbs_SurfaceType;
    const type = surface.GetType();
    // A direction either way round (a face's orientation can flip in an edit).
    const dir = (gpDir: { X(): number; Y(): number; Z(): number }) => {
      let vector = [gpDir.X(), gpDir.Y(), gpDir.Z()];
      const axis = vector.findIndex(x => Math.abs(x) > 1e-9);
      if (axis >= 0 && vector[axis] < 0) {
        vector = vector.map(x => -x);
      }

      return vector;
    };
    // The point of a line through `point` along `direction` nearest the origin.
    const foot = (point: number[], direction: number[]) => {
      const t = point[0] * direction[0] + point[1] * direction[1] + point[2] * direction[2];

      return [point[0] - t * direction[0], point[1] - t * direction[1], point[2] - t * direction[2]];
    };
    const pt = (gpPoint: { X(): number; Y(): number; Z(): number }) => [gpPoint.X(), gpPoint.Y(), gpPoint.Z()];
    if (type === surfaceTypes.GeomAbs_Plane) {
      const pl = surface.Plane();
      const normal = dir(pl.Axis().Direction());
      const point = pt(pl.Location());

      return `P ${normal.map(r4)} ${r4(normal[0] * point[0] + normal[1] * point[1] + normal[2] * point[2])}`;
    }
    if (type === surfaceTypes.GeomAbs_Cylinder) {
      const cy = surface.Cylinder();
      const direction = dir(cy.Axis().Direction());

      return `C ${direction.map(r4)} ${foot(pt(cy.Location()), direction).map(r4)} ${r4(cy.Radius())}`;
    }
    if (type === surfaceTypes.GeomAbs_Sphere) {
      const sp = surface.Sphere();

      return `S ${pt(sp.Location()).map(r4)} ${r4(sp.Radius())}`;
    }
    if (type === surfaceTypes.GeomAbs_Cone) {
      const co = surface.Cone() as any;
      const direction = dir(co.Axis().Direction());

      return `K ${direction.map(r4)} ${pt(co.Apex()).map(r4)} ${r4(Math.abs(co.SemiAngle()))}`;
    }
    if (type === surfaceTypes.GeomAbs_Torus) {
      const to = surface.Torus() as any;
      const direction = dir(to.Axis().Direction());

      return `T ${direction.map(r4)} ${pt(to.Location()).map(r4)} ${r4(to.MajorRadius())} ${r4(to.MinorRadius())}`;
    }

    return null;
  } catch {
    return null;
  } finally {
    surface.delete();
  }
}

/**
 * Tag the faces of a body a step made or changed. `from`: the bodies it was
 * made from (the same body before the step, and those the step worked on).
 *
 * `others`: bodies that were there but had no part in it. A new face on the
 * same plane as a face of one of them (every body standing on the ground, a
 * block as tall as the one beside it) used to be put down to that body's
 * step: change that body and steps on this one lost their faces. It is this
 * step's now; the old answer is kept beside it, for projects saved with it.
 */
export function tagBody(shape: Shape3D, step: string, from: Shape3D[], others: Shape3D[] = []): void {
  if (tags.has(shape)) {
    return;
  }
  const hashes = new Map<number, { face: Face; step: string; key: string | null; alias?: string; move?: Moved }[]>();
  const byKey = new Map<string, { step: string; alias?: string; move?: Moved }>();
  for (const source of from) {
    const t = tags.get(source);
    if (!t || source === shape) {
      continue;
    }
    for (const list of t.byHash.values()) {
      for (const { face, i } of list) {
        const hashCode = face.hashCode;
        hashes.set(hashCode, [...(hashes.get(hashCode) ?? []), { face, step: t.steps[i], key: t.keys[i], alias: t.alias?.[i], move: t.moves?.[i] }]);
      }
    }
    t.keys.forEach((key, i) => key && !byKey.has(key) && byKey.set(key, { step: t.steps[i], alias: t.alias?.[i], move: t.moves?.[i] }));
  }
  const oldKey = new Map<string, string>();
  for (const other of others) {
    const t = tags.get(other);
    if (!t || other === shape || from.includes(other)) {
      continue;
    }
    t.keys.forEach((key, i) => key && !oldKey.has(key) && oldKey.set(key, t.alias?.[i] ?? t.steps[i]));
  }
  const faces = shape.faces;
  const out: Tagged = { steps: [], keys: [], byHash: new Map() };
  const alias: (string | undefined)[] = [];
  const moves: (Moved | undefined)[] = [];
  faces.forEach((face, i) => {
    const hashCode = face.hashCode;
    out.byHash.set(hashCode, [...(out.byHash.get(hashCode) ?? []), { face, i }]);
    const same = hashes.get(hashCode)?.find(entry => entry.face.isSame(face));
    if (same) {
      out.steps.push(same.step);
      out.keys.push(same.key);
      alias.push(same.alias);
      moves.push(same.move);

      return;
    }
    const key = surfaceKey(face);
    out.keys.push(key);
    const kept = key ? byKey.get(key) : undefined;
    out.steps.push(kept?.step ?? step);
    alias.push(kept ? kept.alias : key ? oldKey.get(key) : undefined);
    moves.push(kept?.move);
  });
  if (alias.some(a => a !== undefined)) {
    out.alias = alias;
  }
  if (moves.some(move => move !== undefined)) {
    out.moves = moves;
  }
  tags.set(shape, out);
}

/**
 * A body moved, turned or mirrored whole - by a Move, or as a pattern's copy
 * (`m`: where each point went; the same faces in the same order). Every face
 * is still the step's that made it, and the same one of that step's faces:
 * it used to become the Move's, so a pick on a moved body knew no more than
 * where its face was - and a Move put in before a step lost the step its
 * picks. What was saved then names the faces by the Move (`step`): kept
 * beside, as the old answer.
 */
export function movedTags(from: Shape3D, moved: Shape3D, step: string, matrix: number[]): void {
  const t = tags.get(from);
  if (!t || tags.has(moved)) {
    return;
  }
  const faces = moved.faces;
  if (faces.length !== t.steps.length) {
    return;
  }
  const byHash = new Map<number, { face: Face; i: number }[]>();
  faces.forEach((face, i) => byHash.set(face.hashCode, [...(byHash.get(face.hashCode) ?? []), { face, i }]));
  tags.set(moved, {
    steps: t.steps,
    keys: faces.map(surfaceKey),
    byHash,
    alias: faces.map(() => step),
    moves: faces.map((_, i) => (t.moves?.[i] ? then(t.moves[i]!, matrix) : matrix))
  });
}

/** The step each face used to be put down to, where that differs (see tagBody); undefined: none does. */
export function faceAliases(shape: Shape3D): (string | undefined)[] | undefined {
  return tags.get(shape)?.alias;
}

/** The step that made each face of a body (undefined: not tagged). */
export function faceSteps(shape: Shape3D): string[] | undefined {
  return tags.get(shape)?.steps;
}

/** Edge steps as projects saved before faces were told apart from other bodies' name them (undefined: the same as edgeSteps). */
export function oldEdgeSteps(shape: Shape3D): string[][] | undefined {
  const known = oldEdgeTags.get(shape);
  if (known !== undefined) {
    return known ?? undefined;
  }
  const t = tags.get(shape);
  const out = t?.alias ? stepsOfEdges(shape, t.steps.map((step, i) => t.alias![i] ?? step)) : null;
  oldEdgeTags.set(shape, out);

  return out ?? undefined;
}

/** For each edge of a body, the steps of the faces it lies between (sorted; one for a seam). */
export function edgeSteps(shape: Shape3D): string[][] | undefined {
  const known = edgeTags.get(shape);
  if (known) {
    return known;
  }
  const steps = faceSteps(shape);
  if (!steps) {
    return undefined;
  }
  const out = stepsOfEdges(shape, steps);
  edgeTags.set(shape, out);

  return out;
}

function stepsOfEdges(shape: Shape3D, steps: string[]): string[][] {
  const edges = shape.edges;
  const buckets = new Map<number, { i: number; s: Set<string> }[]>();
  edges.forEach((e, i) => buckets.set(e.hashCode, [...(buckets.get(e.hashCode) ?? []), { i, s: new Set<string>() }]));
  shape.faces.forEach((face, fi) => {
    for (const fe of face.edges) {
      const list = buckets.get(fe.hashCode);
      const match = list?.length === 1 ? list[0] : list?.find(entry => edges[entry.i].isSame(fe));
      match?.s.add(steps[fi]);
    }
  });
  const out: string[][] = new Array(edges.length).fill(null).map(() => []);
  for (const list of buckets.values()) {
    for (const { i, s } of list) {
      out[i] = [...s].sort();
    }
  }

  return out;
}

/**
 * Which of a step's faces a face is: told from the face itself and what the
 * step was made from (an extrusion's side by the sketch curve under it). One
 * per step that can tell; set by the engine as it replays the steps.
 */
export type OriginOf = (face: Face, back?: Back) => string | null;
let originOf: Map<string, OriginOf> = new Map();
export function setOrigins(of: Map<string, OriginOf>): void {
  originOf = of;
}

const originTags = new WeakMap<Shape3D, (string | undefined)[]>();
/** For each face of a body, which of its step's faces it is (undefined: can't be told). */
export function faceOrigins(shape: Shape3D): (string | undefined)[] | undefined {
  const known = originTags.get(shape);
  if (known) {
    return known;
  }
  const steps = faceSteps(shape);
  if (!steps) {
    return undefined;
  }
  const moves = tags.get(shape)?.moves;
  const out = shape.faces.map((face, i) => {
    const of = originOf.get(steps[i]);
    if (!of) {
      return undefined;
    }
    try {
      // (Told where its step made it: a face moved since is taken back there.)
      return of(face, moves?.[i] ? backOf(moves[i]!) : undefined) ?? undefined;
    } catch {
      return undefined;
    }
  });
  originTags.set(shape, out);

  return out;
}

const edgeOriginTags = new WeakMap<Shape3D, (string[] | undefined)[]>();
/** For each edge, the faces it lies between as "step|origin" (sorted); undefined when one of them can't be told. */
export function edgeOrigins(shape: Shape3D): (string[] | undefined)[] | undefined {
  const known = edgeOriginTags.get(shape);
  if (known) {
    return known;
  }
  const steps = faceSteps(shape);
  const origins = faceOrigins(shape);
  if (!steps || !origins) {
    return undefined;
  }
  const edges = shape.edges;
  const buckets = new Map<number, { i: number; s: Set<string>; all: boolean }[]>();
  edges.forEach((e, i) => buckets.set(e.hashCode, [...(buckets.get(e.hashCode) ?? []), { i, s: new Set<string>(), all: true }]));
  shape.faces.forEach((face, fi) => {
    for (const fe of face.edges) {
      const list = buckets.get(fe.hashCode);
      const match = list?.length === 1 ? list[0] : list?.find(entry => edges[entry.i].isSame(fe));
      if (!match) {
        continue;
      }
      if (origins[fi] === undefined) {
        match.all = false;
      } else {
        match.s.add(`${steps[fi]}|${origins[fi]}`);
      }
    }
  });
  const out: (string[] | undefined)[] = new Array(edges.length).fill(undefined);
  for (const list of buckets.values()) {
    for (const { i, s, all } of list) {
      out[i] = all && s.size ? [...s].sort() : undefined;
    }
  }
  edgeOriginTags.set(shape, out);

  return out;
}

const seamTags = new WeakMap<Shape3D, boolean[]>();

/**
 * Per edge: it has the same face on both sides (the seam of a cylinder or a
 * sphere). Nothing to round there - a fillet's corner that's gone mustn't
 * land on one (a lid's 4 corner edges all went to its seam when the lid
 * was made round: "radius too big", not "the edges are gone").
 */
export function seamEdges(shape: Shape3D): boolean[] {
  const known = seamTags.get(shape);
  if (known) {
    return known;
  }
  const edges = shape.edges;
  const buckets = new Map<number, { i: number; faces: Set<number> }[]>();
  edges.forEach((e, i) => buckets.set(e.hashCode, [...(buckets.get(e.hashCode) ?? []), { i, faces: new Set<number>() }]));
  shape.faces.forEach((face, fi) => {
    for (const fe of face.edges) {
      const list = buckets.get(fe.hashCode);
      const match = list?.length === 1 ? list[0] : list?.find(entry => edges[entry.i].isSame(fe));
      match?.faces.add(fi);
    }
  });
  const out: boolean[] = new Array(edges.length).fill(false);
  for (const list of buckets.values()) {
    for (const { i, faces } of list) {
      out[i] = faces.size === 1;
    }
  }
  seamTags.set(shape, out);

  return out;
}

/** Same steps, as stored in a reference. */

export function sameSteps(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((item, i) => item === b[i]);
}

/** A copy made face for face (same order): the same tags. */
export function inheritTags(from: Shape3D, copy: Shape3D): void {
  const t = tags.get(from);
  if (!t || tags.has(copy)) {
    return;
  }
  const faces = copy.faces;
  if (faces.length !== t.steps.length) {
    return;
  }
  const byHash = new Map<number, { face: Face; i: number }[]>();
  faces.forEach((face, i) => byHash.set(face.hashCode, [...(byHash.get(face.hashCode) ?? []), { face, i }]));
  tags.set(copy, { steps: t.steps, keys: t.keys, byHash, alias: t.alias, moves: t.moves });
}
