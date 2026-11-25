import { cast, getOC, isShape3D, makeCompound, makeCylinder, makeHelix, makePolygon, revolution } from 'replicad';
import { need } from '../bodies';
import { cylinderOf } from '../faceEdit';
import { add, cross, dot, norm, scale, sub } from '../../geom';
import { resolveFace } from '../references';
import { threadDepth } from '../threads';
import { fuzzyBoolean, insideOf, volumeOf } from '../booleans';
import { measureArea as trueArea, measureVolume } from '../ocFree';
import { subShapes } from '../health';
import type { Face, Shape3D, Wire } from 'replicad';
import type { Feature, ThreadFeature, Vec3 } from '../../doc/types';
import type { Ctx } from '../types';

export function applyThread(feature: ThreadFeature, ctx: Ctx) {
  const { bodies } = ctx;
  const body = need(bodies, feature.face.body);
  const face = threadTarget(body, feature);
  const cy = cylinderOf(face);
  // (How it was cut is kept by its step: a clearance round the body is the same thread cut on the body grown -
  // see grownThreaded.)
  if (cy) {
    const a = norm(cy.a);
    const ts: number[] = [];
    for (const e of face.edges) {
      for (const fraction of [0, 0.25, 0.5, 0.75, 1]) {
        ts.push(dot(sub(e.pointAt(fraction).toTuple() as Vec3, cy.c), a));
      }
    }
    const used: { phase?: number } = {};
    const made = threadFace(body, face, feature.pitch, !!feature.left, undefined, used, threadStarts(feature.starts));
    threadsCut.set(feature.id, { body: feature.face.body, c: cy.c, a, r: cy.r, inside: cy.s < 0, pitch: feature.pitch, left: !!feature.left, t0: Math.min(...ts), t1: Math.max(...ts), phase: used.phase, starts: threadStarts(feature.starts) });
    bodies.set(feature.face.body, made);

    return;
  }
  bodies.set(feature.face.body, threadFace(body, face, feature.pitch, !!feature.left, undefined, undefined, threadStarts(feature.starts)));
}

/** Sweep a profile along a path, keeping it square to `up` (a helix: the profile stays in planes through the axis). */
function pipeAlong(profile: Wire, path: Wire, up: Vec3): Shape3D {
  const oc = getOC();
  const builder = new oc.BRepOffsetAPI_MakePipeShell(path.wrapped);
  const bi = new oc.gp_Dir(up[0], up[1], up[2]);
  try {
    builder.SetMode(bi);
    builder.Add(profile.wrapped, false, false);
    builder.Build();
    if (!builder.IsDone()) {
      throw new Error("The thread's groove couldn't be made");
    }
    builder.MakeSolid();
    const shape = cast(builder.Shape());
    if (!isShape3D(shape)) {
      throw new Error("The thread's groove couldn't be made");
    }

    return shape;
  } finally {
    builder.delete();
    bi.delete();
  }
}

/** Turns of a thread's groove made in one piece (see threadFace). */
const MAX_THREAD_TURNS = 8;

/** The round face a thread step threads. */
export function threadTarget(body: Shape3D, thread: Extract<Feature, { type: 'thread' }>): Face {
  // Only a round face of the kind picked (a hole stays a hole): with the
  // boss its hole was in switched off, the nearest face was the box's
  // rounded corner - threaded, 60 turns of it, for over a minute. And
  // about its size: a shelled box's inside corner is a "hole" too.
  const round = (face: Face) => {
    if (face.geomType !== 'CYLINDRE') {
      return false;
    }
    const cy = cylinderOf(face);

    return !!cy && (!thread.round || ((cy.s < 0) === thread.round.hole && cy.r < thread.round.r * 2 && cy.r > thread.round.r / 2));
  };
  try {
    return resolveFace(body, thread.face, round);
  } catch {
    // Never a round face (a flat one picked): threadFace says threads go on round faces.
    if (!thread.round) {
      return resolveFace(body, thread.face);
    }
    throw new Error(thread.round.hole ? 'The hole it was cut in is gone' : 'The round face it was cut on is gone');
  }
}

/** A thread's starts as a whole number from 1 to 8 (missing, or nonsense: 1). */
const threadStarts = (count: number | undefined): number => (Number.isFinite(count) ? Math.max(1, Math.min(8, Math.round(count!))) : 1);

/**
 * Cut an ISO 60° thread into a round face: a V groove swept along a helix
 * round the face's axis (deepest at the minor diameter of a shank, the major
 * of a hole), kept to the face's own length, cut away. Cutting (never adding
 * a ridge) is the reliable way: a ridge only just overlapping its core can
 * come out of OpenCascade wrong without a word.
 */
export function threadFace(body: Shape3D, face: Face, pitch: number, left = false, like?: { t0: number; t1: number; anchor?: number; phase?: number; shallow?: number; c?: Vec3; a?: Vec3 }, used?: { phase?: number }, starts = 1): Shape3D {
  if (face.geomType !== 'CYLINDRE') {
    throw new Error('Threads go on round faces (a shank or a hole)');
  }
  if (!(pitch > 0)) {
    throw new Error('The pitch must be more than 0');
  }
  // (Finer than any standard thread: it failed with "try a slightly different pitch".)
  if (pitch < 0.2 - 1e-9) {
    throw new Error('That pitch is too fine - the finest is 0.2 mm');
  }
  const cy0 = cylinderOf(face);
  // (`like.c`, `like.a`: measured from the same point along the same axis as another thread. A face's own centre
  // and the way its axis points are the kernel's choice, and differ from one body to the same body grown - the
  // turns then started somewhere else, and ran into the first thread's.)
  const cy = cy0 && like?.c && like.a ? { ...cy0, c: like.c, a: like.a } : cy0;
  if (!cy) {
    throw new Error('Threads go on round faces (a shank or a hole)');
  }
  const inside = cy.s < 0;
  // (`like.shallow`: a groove that much less deep, and so that much narrower - the thread of a body grown by a
  // clearance. Its round face is already out by the clearance; with the V out by it once more, its sides stand
  // that clearance off the first thread's sides, not half of it.)
  const depth = threadDepth(pitch, inside) - (like?.shallow ?? 0);
  if (!(depth > 0)) {
    throw new Error('That clearance is more than the thread is deep');
  }
  if (!inside && depth >= cy.r * 0.9) {
    throw new Error('That pitch is too coarse for this diameter');
  }
  const a = norm(cy.a);
  // The face's length along its axis.
  const ts: number[] = [];
  for (const e of face.edges) {
    for (const fraction of [0, 0.25, 0.5, 0.75, 1]) {
      ts.push(dot(sub(e.pointAt(fraction).toTuple() as Vec3, cy.c), a));
    }
  }
  // (`like`: along the same stretch and from the same start as another thread - one cut again on the body grown,
  // so its turns lie over the first one's.)
  const t0 = like ? like.t0 : Math.min(...ts);
  const t1 = like ? like.t1 : Math.max(...ts);
  if (t1 - t0 < pitch) {
    throw new Error('This face is shorter than one turn of the thread');
  }
  // The groove's section in a plane through the axis: a 60° V from its tip
  // (the thread's depth) opening past the face.
  const out = inside ? -1 : 1;
  const tip = cy.r - out * depth;
  const mouth = cy.r + out * 0.2 * pitch;
  const hm = Math.abs(mouth - tip) * Math.tan(Math.PI / 6);
  // The groove stops just short of both ends: its ends never lie on a face of
  // the body (a groove run out through an end face makes OpenCascade's cut
  // take the wrong amount, every start tried), and under a head it mustn't
  // cut into the head anyway. That leaves a thin ring of the face at each end
  // and the groove's flat stub beside it: at an end with nothing past it (a
  // shank's free end, a hole's open end) - seen there as stray little faces
  // along its edge - a 45° chamfer down to the thread's root takes them away,
  // as a bolt's end (a nut's mouth) is made.
  const side = norm(cross(a, Math.abs(a[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]));
  const side2 = cross(a, side);
  const freeAt = (t: number, way: number): boolean => {
    const rr = (cy.r + tip) / 2;
    const at: Vec3[] = [];
    for (let index = 0; index < 6; index++) {
      const th = (index * Math.PI) / 3;
      at.push(add(add(cy.c, scale(a, t + way * 0.3 * pitch)), add(scale(side, rr * Math.cos(th)), scale(side2, rr * Math.sin(th)))));
    }
    try {
      return !insideOf(body, at).some(Boolean);
    } catch {
      return false;
    }
  };
  const res = threadCut(body, face, cy, a, pitch, left, inside, depth, tip, mouth, hm, t0, t1, like?.phase, used, like?.anchor, starts);
  if (res) {
    let shape = res;
    for (const [t, way] of [[t0, -1], [t1, 1]] as const) {
      if (freeAt(t, way)) {
        shape = threadEndChamfer(shape, cy.c, a, side, cy.r, tip, out, t, way, pitch) ?? shape;
      }
    }

    return shape;
  }
  // A very fine pitch on a wide face is where this happens: "slightly different" sent people from 0.2 to 0.21.
  throw new Error(pitch < 0.1 * cy.r ? "The thread couldn't be cut here - try a coarser pitch" : "The thread couldn't be cut here - try a slightly different pitch");
}

/**
 * A thread's free end chamfered at 45° from the face down to the thread's
 * root (in to the minor diameter of a shank, out to the major of a hole), so
 * the groove's stopped end is cut away. Null when the cut goes wrong.
 */
function threadEndChamfer(body: Shape3D, center: Vec3, a: Vec3, side: Vec3, radius: number, tip: number, out: number, t: number, way: number, pitch: number): Shape3D | null {
  try {
    const e = 0.5 * pitch;
    const air = radius + out * e;
    const at = (rr: number, tt: number): Vec3 => add(add(center, scale(a, tt)), scale(side, rr));
    // A triangle in a plane through the axis, its slope through (root, end), turned all the way round.
    // (Through a point a little below the root: through the root itself, a sliver of the groove's stub stayed.)
    const root = tip - out * 0.15 * pitch;
    const tri = makePolygon([at(root - out * e, t + way * e), at(air, t + way * e), at(air, t - way * Math.abs(air - root))]);
    const ring = revolution(tri, center, a, 360) as Shape3D;
    // (Each volume once: this body is the groove's result, measured there already.)
    const v0 = Math.abs(volumeOf(body));
    const res = body.cut(ring);
    const volume = Math.abs(volumeOf(res));
    // It takes a little (no more than the ring holds, at most the body's own share of it).
    const most = Math.abs(measureVolume(ring));
    if (!Number.isFinite(volume) || !(volume < v0) || v0 - volume > most || subShapes(res, 'SOLID').length !== subShapes(body, 'SOLID').length) {
      return null;
    }

    return res;
  } catch {
    return null;
  }
}

/** threadFace's groove, stopped just short of both ends; null when it can't be made right. */
function threadCut(
  body: Shape3D,
  face: Face,
  cy: NonNullable<ReturnType<typeof cylinderOf>>,
  a: Vec3,
  pitch: number,
  left: boolean,
  inside: boolean,
  depth: number,
  tip: number,
  mouth: number,
  hm: number,
  t0: number,
  t1: number,
  only?: number,
  used?: { phase?: number },
  anchor?: number,
  starts = 1
): Shape3D | null {
  // Several starts: that many grooves side by side, each going `lead` along in one turn, a pitch from the next.
  const lead = pitch * starts;
  const lo = t0 + 0.05 * pitch;
  const hi = t1 - 0.05 * pitch;
  // Only along the face (a shank's thread mustn't run into the head).
  const reach = Math.max(cy.r, tip, mouth) + pitch * 2;
  const slab = makeCylinder(reach, hi - lo, add(cy.c, scale(a, lo)), a) as Shape3D;
  const v0 = Math.abs(volumeOf(body));
  // What it must take away: the V inside the face (depth deep, 2·depth·tan30
  // wide at the face) along the helix through its centroid.
  const section = depth * depth * Math.tan(Math.PI / 6);
  const rc = inside ? cy.r + depth / 3 : cy.r - depth / 3;
  // (As many grooves pass any one place along the face as it is pitches long, whatever the starts: each groove is
  // longer in a turn, and there are fewer turns of it.)
  const expect = section * Math.hypot(2 * Math.PI * rc, lead) * ((hi - lo) / lead) * starts;
  // A face that isn't a whole ring (a shank with flats cut along it, a slot
  // across a hole) loses less: what the groove overlaps, if that's no more.
  // (A whole ring must lose all of it: a groove that came out broken - a
  // crankshaft's M24 at one start overlapped the pin by half what it should -
  // took half, and "what the groove overlaps" passed it.)
  const whole = trueArea(face) > 2 * Math.PI * cy.r * (t1 - t0) * (1 - 1e-4);
  const ok = (shape: Shape3D, cut: Shape3D) => {
    const volume = Math.abs(volumeOf(shape));
    if (!Number.isFinite(volume)) {
      return false;
    }
    if (Math.abs(v0 - volume - expect) < expect * 0.03) {
      return true;
    }
    if (whole) {
      return false;
    }
    try {
      const want = Math.abs(measureVolume(fuzzyBoolean('common', body, cut)));

      return want > expect * 0.05 && want < expect * 1.03 && Math.abs(v0 - volume - want) < want * 0.03;
    } catch {
      return false;
    }
  };
  // Where the thread starts round the face doesn't matter: if OpenCascade
  // trips on one start (a groove lining up with the face's seams), another
  // is tried.
  for (const phase of only !== undefined ? [only] : [0, 0.37, 0.71]) {
    // (`anchor`: where another thread's stretch began - the turns start from there, whatever stretch this one has.)
    const start = (anchor !== undefined ? anchor + 0.05 * pitch : lo) - lead * (1 + phase);
    const turns = Math.ceil((hi - start) / lead) + 1;
    // An exact helix (a line wound on a cylinder, not a fitted spline: those
    // drift over many turns and the sweep fails), through the groove's middle.
    // Long threads go in pieces of a few whole turns: one 40-turn groove in an
    // M3 boss hole made OpenCascade's cut find nothing to cut (after 40 s).
    // Whole turns, so each piece ends on the very face the next starts on.
    const per = Math.ceil(turns / Math.ceil(turns / MAX_THREAD_TURNS));
    let cut: Shape3D;
    try {
      const grooves: Shape3D[] = [];
      for (let startIndex = 0; startIndex < starts; startIndex++) {
        const pieces: Shape3D[] = [];
        for (let piece = 0; piece * per < turns; piece++) {
          const turnCount = Math.min(per, turns - piece * per);
          // (The next start's groove: the same, one pitch along.)
          const base = add(cy.c, scale(a, start + startIndex * pitch + piece * per * lead));
          const helix = makeHelix(lead, lead * turnCount, (tip + mouth) / 2, base, a, left);
          const r0 = sub(helix.startPoint.toTuple() as Vec3, base);
          const ur = norm(sub(r0, scale(a, dot(r0, a))));
          const at = (rr: number, t: number): Vec3 => add(add(base, scale(a, t)), scale(ur, rr));
          const profile = makePolygon([at(mouth, -hm), at(tip, 0), at(mouth, hm)]).outerWire();
          pieces.push(pipeAlong(profile, helix, a).intersect(slab));
        }
        // Fused into one groove where it can be: cut as pieces, a little flat
        // triangle stayed where each piece met the next (a stray face on the
        // thread, all of them in a line down one side).
        let one: Shape3D | null = pieces.length === 1 ? pieces[0] : null;
        if (!one) {
          try {
            let firstPiece = pieces[0];
            for (const q of pieces.slice(1)) {
              firstPiece = fuzzyBoolean('fuse', firstPiece, q);
            }
            if (subShapes(firstPiece, 'SOLID').length === 1) {
              one = firstPiece;
            }
          } catch {
          // the pieces, then
          }
        }
        grooves.push(one ?? (makeCompound(pieces) as unknown as Shape3D));
      }
      cut = grooves.length === 1 ? grooves[0] : (makeCompound(grooves) as unknown as Shape3D);
    } catch {
      continue;
    }
    for (const fuzzy of [true, false]) {
      try {
        const res = fuzzy ? fuzzyBoolean('cut', body, cut) : body.cut(cut);
        if (ok(res, cut)) {
          if (used) {
            used.phase = phase;
          }

          return res;
        }
      } catch {
        // the other way, or the next start
      }
    }
  }

  return null;
}

/** The threads cut in this project, by their step: on which body, the round face's axis, size and reach, the pitch. */
export const threadsCut = new Map<string, { body: string; c: Vec3; a: Vec3; r: number; inside: boolean; pitch: number; left: boolean; t0: number; t1: number; phase?: number; starts?: number }>();
