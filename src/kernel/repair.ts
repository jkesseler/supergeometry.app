// Repair: turn a damaged solid (or a pile of faces, an imported mesh) into a
// clean one without changing its shape. A series of fixes, each tried on a
// copy and kept only if it makes the body healthier while its volume and
// size stay the same: tolerances and edge curves rebuilt, faces fixed, gaps
// sewn shut (at growing tolerances), missing flat faces filled from their
// open edges, hair-thin faces dropped and their slot closed, faces split on
// one surface merged, skins made solid, inside-out solids turned round.

import { assembleWire, cast, getOC, makeCompound, makeFace, makeLine, makeThreePointArc, measureArea, type Shape3D, type Wire } from 'replicad';
import { measureVolume, quickVolume } from './ocFree';
import { unify } from './faceEdit';
import { deepCopy, hairThin, meshVolume, openEdges, pinchedEdges, shapeValid, subShapes } from './health';

export interface Health {
  valid: boolean;
  solids: number;
  shells: number;
  openEdges: number;
  /** Edges more than two faces meet at (pieces touching only along an edge). */
  pinched: number;
  thin: number;
  volume: number;
  faces: number;
}

export function healthOf(shape: Shape3D): Health {
  const health: Health = { valid: false, solids: 0, shells: 0, openEdges: 0, pinched: 0, thin: 0, volume: 0, faces: 0 };
  try {
    health.faces = shape.faces.length;
    health.valid = shapeValid(shape);
    health.solids = subShapes(shape, 'SOLID').length;
    health.shells = subShapes(shape, 'SHELL').length;
    health.openEdges = openEdges(shape).length;
    health.pinched = pinchedEdges(shape);
    health.thin = hairThin(shape);
    health.volume = health.solids ? measureVolume(shape) : 0;
  } catch {
    health.valid = false;
  }

  return health;
}

export interface RepairOptions {
  /** How many separate solids it may be (default: any). */
  maxSolids?: number;
  /** The volume it should keep (default: its own, when it has one). */
  volume?: number;
}

/** A clean solid: valid, closed, no pieces meeting only at an edge, no hair-thin faces, real volume. */
export function isHealthy(health: Health, repairOptions: RepairOptions = {}): boolean {
  return health.valid && health.solids >= 1 && (!repairOptions.maxSolids || health.solids <= repairOptions.maxSolids) && health.openEdges === 0 && !health.pinched && health.thin === 0 && health.volume > 0;
}

/** How broken (0: healthy) - to tell whether a fix helped. */
function badness(health: Health, repairOptions: RepairOptions): number {
  return (health.valid ? 0 : 1000) + (health.solids ? 0 : 400) + (repairOptions.maxSolids && health.solids > repairOptions.maxSolids ? 300 : 0) + (health.volume > 0 ? 0 : 200) + Math.min(health.openEdges, 50) * 4 + Math.min(health.thin, 50) * 2;
}

function sizeOf(shape: Shape3D): number {
  try {
    const b = shape.boundingBox;

    return Math.hypot(b.width, b.height, b.depth) || 1;
  } catch {
    return 1;
  }
}

// ------------------------------------------------------------- the fixes

type Fix = { label: string; run: (s: Shape3D, size: number) => Shape3D | null };

/** Faces → shell(s) by sewing at `tol`; every closed shell → a solid (turned outward). */
/**
 * Flat faces with an edge next to nothing in length (the end of a sliver
 * that was closed: two roundings that meet, 4 mm each side of an 8 mm
 * block) made again without it, their outline's two neighbours brought
 * together. Left in, that speck is an edge to pick, and one the engine
 * stumbles on in every later cut and fillet there. Null: none to drop.
 */
function withoutSpecks(shape: Shape3D, tol: number): Shape3D | null {
  type P = [number, number, number];
  const far = (pointA: P, q: P) => Math.hypot(pointA[0] - q[0], pointA[1] - q[1], pointA[2] - q[2]);
  const remade = (wire: Wire): Wire => {
    const all = wire.edges.map(e => ({ e, a: e.startPoint.toTuple() as P, b: e.endPoint.toTuple() as P, m: e.pointAt(0.5).toTuple() as P, type: e.geomType as string, speck: e.length < tol, moved: false }));
    const specks = all.filter(piece => piece.speck);
    if (!specks.length) {
      return wire;
    }
    // The ends that were on a speck: both at its middle now.
    const snap = (point: P): P | null => {
      for (const speck of specks) {
        if (far(point, speck.a) < tol || far(point, speck.b) < tol) {
          return [(speck.a[0] + speck.b[0]) / 2, (speck.a[1] + speck.b[1]) / 2, (speck.a[2] + speck.b[2]) / 2];
        }
      }

      return null;
    };
    const rest = all.filter(piece => !piece.speck);
    for (const x of rest) {
      const [a, b] = [snap(x.a), snap(x.b)];
      if (!a && !b) {
        continue;
      }
      if (x.type !== 'LINE' && x.type !== 'CIRCLE') {
        throw new Error('not a line or an arc');
      }
      x.a = a ?? x.a;
      x.b = b ?? x.b;
      x.moved = true;
    }
    // In order round the outline (each begins where the one before ends).
    const chain = [rest.shift()!];
    while (rest.length) {
      const end = chain[chain.length - 1].b;
      let i = rest.findIndex(piece => far(piece.a, end) < tol);
      if (i < 0) {
        i = rest.findIndex(piece => far(piece.b, end) < tol);
        if (i < 0) {
          throw new Error("the outline doesn't close");
        }
        [rest[i].a, rest[i].b] = [rest[i].b, rest[i].a];
      }
      chain.push(rest.splice(i, 1)[0]);
    }

    return assembleWire(chain.map(piece => (!piece.moved ? piece.e : piece.type === 'LINE' ? makeLine(piece.a, piece.b) : makeThreePointArc(piece.a, piece.m, piece.b))));
  };
  let any = false;
  const faces = shape.faces.map((face) => {
    if (face.geomType !== 'PLANE' || !face.edges.some(e => e.length < tol)) {
      return face.wrapped;
    }
    try {
      const made = makeFace(remade(face.clone().outerWire()), face.clone().innerWires().map(remade));
      any = true;

      return made.wrapped;
    } catch {
      return face.wrapped;
    }
  });

  return any ? sewToSolid(faces, tol) : null;
}

/** Faces on the same surface to within `tol` made one (null: it can't be done). */
function merged(shape: Shape3D, tol: number): Shape3D | null {
  const oc = getOC();
  const unifier = new oc.ShapeUpgrade_UnifySameDomain(shape.wrapped, true, true, false);
  try {
    unifier.SetLinearTolerance(tol);
    unifier.SetAngularTolerance(1e-5);
    unifier.Build();
    const made = unifier.Shape();
    try {
      return cast(made) as Shape3D;
    } finally {
      made.delete();
    }
  } catch {
    return null;
  } finally {
    unifier.delete();
  }
}

function sewToSolid(faces: unknown[], tol: number): Shape3D | null {
  const oc = getOC();
  const sw = new oc.BRepBuilderAPI_Sewing(tol, true, true, true, false);
  try {
    for (const face of faces) {
      sw.Add(face as never);
    }
    sw.Perform(new oc.Message_ProgressRange());
    const sewed = cast(sw.SewedShape()) as Shape3D;
    const shells = subShapes(sewed, 'SHELL');
    if (!shells.length) {
      return null;
    }
    const solids: unknown[] = [];
    for (const sh of shells) {
      const fix = new oc.ShapeFix_Solid();
      try {
        const solid = fix.SolidFromShell(sh);
        oc.BRepLib.OrientClosedSolid(oc.TopoDS.Solid(solid));
        solids.push(solid);
      } finally {
        fix.delete();
      }
    }
    if (solids.length === 1) {
      return cast(solids[0] as never) as Shape3D;
    }

    return makeCompound(solids.map(solid => cast(solid as never))) as Shape3D;
  } catch {
    return null;
  } finally {
    sw.delete();
  }
}

const facesOf = (shape: Shape3D) => shape.faces.map(face => face.wrapped);

/** Chains of open edges into closed loops → flat faces filling them (holes where a face is missing). */
function fillFlatHoles(shape: Shape3D, size: number): unknown[] {
  const open = openEdges(shape).map(i => shape.edges[i]);
  if (!open.length) {
    return [];
  }
  const tol = size * 1e-6;
  const ends = open.map(e => [e.startPoint.toTuple(), e.endPoint.toTuple()] as [number, number, number][]);
  const same = (point: number[], q: number[]) => Math.hypot(point[0] - q[0], point[1] - q[1], point[2] - q[2]) < tol;
  const used = new Set<number>();
  const out: unknown[] = [];
  for (let start = 0; start < open.length; start++) {
    if (used.has(start)) {
      continue;
    }
    const loop = [start];
    used.add(start);
    let tip = ends[start][1];
    for (let guard = 0; guard < open.length && !same(tip, ends[start][0]); guard++) {
      const index = open.findIndex((_, i) => !used.has(i) && (same(ends[i][0], tip) || same(ends[i][1], tip)));
      if (index < 0) {
        break;
      }
      used.add(index);
      loop.push(index);
      tip = same(ends[index][0], tip) ? ends[index][1] : ends[index][0];
    }
    if (!same(tip, ends[start][0])) {
      continue;
    }
    try {
      // Only flat holes: a face is guessed, never a curved one.
      const face = makeFace(assembleWire(loop.map(i => open[i])));
      if (face.geomType === 'PLANE') {
        out.push(face.wrapped);
      }
    } catch {
      // not a closed flat loop
    }
  }

  return out;
}

const FIXES: Fix[] = [
  {
    label: 'rebuilt edge curves and tolerances',
    run: (shape, size) => {
      const oc = getOC();
      const copy = deepCopy(shape);
      try {
        oc.BRepLib.BuildCurves3d(copy.wrapped);
      } catch {
        /* overload differs */
      }
      try {
        oc.BRepLib.SameParameter(copy.wrapped, size * 1e-7, true);
      } catch {
        /* overload differs */
      }
      try {
        oc.BRepLib.UpdateTolerances(copy.wrapped, true);
      } catch {
        /* overload differs */
      }

      return copy;
    }
  },
  {
    label: 'fixed faces',
    run: (shape, size) => {
      const oc = getOC();
      const fixed: unknown[] = [];
      for (const face of shape.faces) {
        const fx = new oc.ShapeFix_Face(face.wrapped);
        try {
          fx.SetPrecision(size * 1e-7);
          fx.Perform();
          fixed.push(fx.Face());
        } finally {
          fx.delete();
        }
      }

      return sewToSolid(fixed, size * 1e-7);
    }
  },
  // Gaps between faces: sewn shut, the smallest tolerance that does it.
  ...[1e-6, 1e-5, 1e-4, 1e-3].map(factor => ({ label: 'sewed up gaps between faces', run: (shape: Shape3D, size: number) => sewToSolid(facesOf(shape), size * factor) })),
  {
    label: 'filled missing flat faces',
    run: (shape, size) => {
      const add = fillFlatHoles(shape, size);

      return add.length ? sewToSolid([...facesOf(shape), ...add], size * 1e-6) : null;
    }
  },
  {
    label: 'removed hair-thin faces',
    run: (shape, size) => {
      const areas = shape.faces.map(face => measureArea(face));
      const total = areas.reduce((a, b) => a + b, 0);
      const thin = areas.map(a => a < total * 1e-7);
      if (!thin.some(Boolean)) {
        return null;
      }
      // Their neighbours close the slot: sewn with a tolerance about as wide as the slivers.
      const width = Math.max(...shape.faces.filter((_, i) => thin[i]).map((face) => {
        const b = face.boundingBox;

        return Math.min(...[b.width, b.height, b.depth].filter(x => x > 0), size * 1e-3);
      }));
      const kept = shape.faces.filter((_, i) => !thin[i]).map(face => face.wrapped);
      const tol = Math.min(size * 1e-3, Math.max(size * 1e-6, width * 2));
      const closed = sewToSolid(kept, tol);
      if (!closed) {
        return null;
      }
      // The sliver's ends are still there, as edges next to nothing in length on the faces it ended at.
      try {
        const clean = withoutSpecks(closed, tol);
        if (clean && !clean.edges.some(e => e.length < tol)) {
          // What the sliver lay between is one surface but for its width (the two
          // roundings of a full round: one half cylinder): one face, with no line down it.
          const joined = merged(clean, tol);
          const one = joined && FIXES[0].run(joined, size);
          const volume = measureVolume(closed);
          const good = (x: Shape3D) => shapeValid(x) && !openEdges(x).length && Math.abs(measureVolume(x) - volume) < Math.abs(volume) * 1e-4;
          if (one && one.faces.length < clean.faces.length && good(one)) {
            return one;
          }
          if (good(clean)) {
            return clean;
          }
        }
      } catch {
        // as it is, then
      }

      return closed;
    }
  },
  {
    label: 'merged faces split on one surface',
    run: (shape) => {
      try {
        return unify(shape);
      } catch {
        return null;
      }
    }
  },
  {
    label: 'made a solid from its skin',
    run: (shape, size) => (subShapes(shape, 'SOLID').length ? null : sewToSolid(facesOf(shape), size * 1e-6))
  },
  {
    label: 'turned it the right way out',
    run: (shape) => {
      const oc = getOC();
      if (!(quickVolume(shape) < 0)) {
        return null;
      }
      const copy = deepCopy(shape);
      for (const x of subShapes(copy, 'SOLID')) {
        oc.BRepLib.OrientClosedSolid(x);
      }

      return copy;
    }
  }
];

/** Healthy now: faces left split on one surface (a mesh's triangles) merged, if that keeps it so. */
function tidy(shape: Shape3D, health: Health, repairOptions: RepairOptions, fixes: string[]): Shape3D {
  try {
    const unified = unify(shape);
    const hu = healthOf(unified);
    if (isHealthy(hu, repairOptions) && hu.faces < health.faces && Math.abs(hu.volume - health.volume) <= health.volume * 1e-6) {
      fixes.push('merged faces split on one surface');

      return unified;
    }
  } catch {
    /* keep it as it is */
  }

  return shape;
}

/**
 * Repair a shape: the fixes are tried in turn on what the last good one left,
 * each kept only if it helps and doesn't change the shape (volume within
 * 0.5%, same size). Returns the repaired shape and what was done, or null if
 * it can't be made a clean solid.
 */
export function repairShape(input: Shape3D, repairOptions: RepairOptions = {}): { shape: Shape3D; fixes: string[] } | null {
  let cur = input;
  let health = healthOf(cur);
  if (isHealthy(health, repairOptions)) {
    return { shape: cur, fixes: [] };
  }
  const size = sizeOf(input);
  const v0 = repairOptions.volume ?? (health.volume > 0 && health.valid ? health.volume : undefined);
  // Not valid: its measured volume can't be trusted, but one counted from a
  // mesh can (when it's closed). Without it, "fixed faces" was free to change
  // the shape: a slot cut into a drill's housing came back 764 mm³ bigger,
  // and the housing split in half later left pieces inside out.
  let m0: number | undefined;
  if (v0 === undefined && health.solids && !health.openEdges) {
    try {
      const meshed = meshVolume(input, size);
      if (meshed > 0) {
        m0 = meshed;
      }
    } catch {
      m0 = undefined;
    }
  }
  const sameShape = (shape: Shape3D, hs: Health) => {
    if (Math.abs(sizeOf(shape) - size) > size * 1e-3) {
      return false;
    }
    // A sound solid measuring below nothing or more than its box is a broken
    // "fix": said at once. (Meshed to compare, each took 13 s - a cut through a
    // shelled mouse's curved top spent three minutes here before it said no.)
    if (hs.valid && hs.solids) {
      const b = shape.boundingBox;
      if (!(hs.volume > 0) || hs.volume > b.width * b.height * b.depth * 1.001) {
        return false;
      }
    }
    if (m0 !== undefined) {
      try {
        return Math.abs(meshVolume(shape, size) - m0) <= m0 * 5e-3;
      } catch {
        return false;
      }
    }
    if (v0 === undefined || !(hs.volume > 0)) {
      return true;
    }

    return Math.abs(hs.volume - v0) <= v0 * 5e-3;
  };
  const fixes: string[] = [];
  // Two rounds: one fix can open the way for another (sewn first, then merged).
  for (let round = 0; round < 2; round++) {
    for (const fix of FIXES) {
      let next: Shape3D | null = null;
      try {
        next = fix.run(cur, size);
      } catch {
        next = null;
      }
      if (!next) {
        continue;
      }
      const hn = healthOf(next);
      if (badness(hn, repairOptions) < badness(health, repairOptions) && sameShape(next, hn)) {
        cur = next;
        health = hn;
        if (!fixes.includes(fix.label)) {
          fixes.push(fix.label);
        }
        if (isHealthy(health, repairOptions)) {
          return { shape: tidy(cur, health, repairOptions, fixes), fixes };
        }
      }
    }
  }

  return null;
}
