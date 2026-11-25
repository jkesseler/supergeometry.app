import { assembleWire, cast, getOC, iterTopo, makeBSplineApproximation } from 'replicad';
import { need } from '../bodies';
import { faceInfo, resolveFace } from '../references';
import { pathWire } from '../sources';
import { arcSpine, carriedFrames, evenly, gentle, guideCurve, oriented, plainSpine, slideAxis, slidingSpine, smoothed } from '../../freeform/connect';
import { add, dist, dot, norm, scale, sub, xDirFor } from '../../geom';
import { combine } from '../booleans';
import { isFault } from '../faults';
import { sizeOf } from '../faceEdit';
import { measureVolume, quickVolume, roughVolume } from '../ocFree';
import { openEdges, shapeValid } from '../health';
import type { Face, Shape3D } from 'replicad';
import type { ConnectFeature, Vec3 } from '../../doc/types';
import type { Ctx } from '../types';

export function applyConnect(feature: ConnectFeature, ctx: Ctx) {
  const { bodies } = ctx;
  const [ra, rb] = feature.faces;
  const shapeA = need(bodies, ra.body);
  const shapeB = need(bodies, rb.body);
  const fa = resolveFace(shapeA, ra);
  const fb = resolveFace(shapeB, rb);
  if (ra.body === rb.body && fa.isSame(fb)) {
    throw new Error('Pick two different faces to connect');
  }
  const mode = feature.mode === 'auto' ? 'join' : feature.mode;
  const size = feature.size ?? 1;
  // Cut between two faces of one body: a tunnel, into the faces (else out of them).
  const inward = mode === 'cut' && ra.body === rb.body;
  // Cutting a face's whole outline out: the cutter a hair wider, so no sliver stays on the walls beside it.
  const cutSize = mode === 'cut' && !inward && size > 0.99 ? size * 1.002 : size;
  const ea = bridgeEnd(shapeA, fa, cutSize, inward, mode !== 'new');
  const eb = bridgeEnd(shapeB, fb, cutSize, inward, mode !== 'new');
  const reach = Math.max(ea.reach, eb.reach);
  // The bridge's outline at each end (the fold check carries them along the curve).
  const rings = { a: ea.ring, b: eb.ring };
  let along: (t: number) => Vec3;
  // Turning with its curve, the outline never runs back over itself (the
  // bridge folding through itself: a solid no join or cut can use). Where
  // it would - `slide`: the way the outline keeps facing instead, all the
  // way, sliding along the curve without turning.
  let sound = true;
  let slide: Vec3 | undefined;
  // Points taken along the curve for the sweep's path (two arcs: more, or the
  // path fitted through them wavers where the arcs meet and the sweep breaks).
  let samples = 60;
  if (feature.guide) {
    // Eased onto the guide over a longer stretch when it leaves the face
    // steeply; where the guide itself turns tighter than the bridge is
    // wide, rounded off a little at a time until it fits.
    const drawn = curvePoints(pathWire(feature.guide, ctx).wrapped, 200);
    const fit = (pts: Vec3[]) => [1.5, 2.5, 3.5, 5].map(factor => guideCurve(pts, ea.center, eb.center, ea.dir, eb.dir, factor * reach)).find(curve => gentle(curve, rings));
    let pts = oriented(evenly(drawn, 60), ea.center, eb.center);
    let found = fit(pts);
    for (let attempt = 0; attempt < 40 && !found; attempt++) {
      found = fit((pts = smoothed(pts, 10, ea.dir, eb.dir)));
    }
    along = found ?? guideCurve(drawn, ea.center, eb.center, ea.dir, eb.dir, 1.5 * reach);
    sound = !!found;
    if (!sound) {
      slide = slideAxis(along, ea.dir, scale(eb.dir, -1), reach) ?? undefined;
    }
  } else {
    const plain = plainSpine(ea.center, ea.dir, eb.center, eb.dir, feature.bulge ?? 1, rings);
    along = plain.along;
    sound = plain.gentle;
    if (!sound) {
      // Faces too wide for how close they are (or how far to the side of
      // each other): two arcs - the gentlest way from one to the other -
      // or, facing each other, a bridge that slides along the plain curve.
      const arcs = arcSpine(ea.center, ea.dir, eb.center, eb.dir);
      if (arcs && gentle(arcs, rings)) {
        (along = arcs), (sound = true), (samples = 180);
      } else {
        const sliding = slidingSpine(ea.center, ea.dir, eb.center, eb.dir, feature.bulge ?? 1, reach);
        if (sliding) {
          (along = sliding.along), (slide = sliding.axis);
        }
      }
    }
  }
  // Into both bodies (one, when both faces are on it).
  const into = (bridge: Shape3D) => {
    combine(feature.id, mode, ra.body, bridge, false, ctx);
    if (rb.body !== ra.body) {
      if (mode === 'join') {
        combine(feature.id, 'join', ra.body, need(bodies, rb.body), false, ctx);
        bodies.delete(rb.body);
        ctx.freeforms.delete(rb.body);
      } else {
        combine(feature.id, 'cut', rb.body, bridge, false, ctx);
      }
    }
    ctx.freeforms.delete(ra.body);
  };
  try {
    const made = sweepBridge(ea, eb, along, { guided: !!feature.guide, exact: true, slide, samples });
    if (mode === 'new') {
      bodies.set(feature.id, made.shape);

      return;
    }
    if (!made.exact) {
      return into(made.shape);
    }
    // Starting on the faces' very edges, its walls lie on the bodies' own:
    // where joining (or cutting) that fails, the bridge made the other way
    // (a little inside the edges) - on the bodies as they were.
    const was = [ra.body, rb.body].map(id => [id, bodies.get(id), ctx.freeforms.get(id)] as const);
    try {
      into(made.shape);
    } catch (err) {
      if (isFault(err)) {
        throw err;
      }
      for (const [id, body, ff] of was) {
        if (body) {
          bodies.set(id, body);
        }
        if (ff) {
          ctx.freeforms.set(id, ff);
        }
      }
      into(sweepBridge(ea, eb, along, { guided: !!feature.guide, exact: false, slide, samples }).shape);
    }
  } catch (err) {
    // On a curve too tight for it the bridge runs through itself: whatever
    // went wrong with it after that, this is why.
    if (isFault(err) || sound || slide) {
      throw err;
    }
    throw new Error(bridgeFailed(!!feature.guide));
  } finally {
    for (const e of [ea, eb]) {
      (e.outline.delete(), e.rim.delete());
    }
  }
}

/** `count` points along a wire (end to end; a closed one's start not repeated). */
export function curvePoints(wire: any, count: number, closed = false): Vec3[] {
  const oc = getOC();
  const curve = new oc.BRepAdaptor_CompCurve(wire, false);
  const out: Vec3[] = [];
  try {
    const a = curve.FirstParameter();
    const b = curve.LastParameter();
    for (let index = 0; index < (closed ? count : count + 1); index++) {
      const curvePoint = curve.Value(a + ((b - a) * index) / count);
      out.push([curvePoint.X(), curvePoint.Y(), curvePoint.Z()]);
      curvePoint.delete();
    }
  } finally {
    curve.delete();
  }

  return out;
}

/**
 * One end of a Connect bridge: the face's outer edge as points in order, its
 * middle and outward normal, and how far the bridge may go into the body
 * behind it (a third of the face's size, less than half the body's depth
 * there - a 3 mm plate's end doesn't poke out of its back).
 */
interface BridgeEnd {
  center: Vec3;
  /** The way the bridge leaves the face: out of it (into it, for a tunnel). */
  dir: Vec3;
  /** The outline swept (sized, and moved `depth` back against `dir`). */
  outline: any;
  /** The same outline on the face itself. */
  rim: any;
  depth: number;
  /** How far the outline reaches from the middle. */
  reach: number;
  /** Points round the outline (sized), from the middle. */
  ring: Vec3[];
  /** Made of two faces either side of a seam (its outline in more pieces than the face's own: a sweep pairs them up wrongly). */
  joined?: boolean;
  /** The face's area (sized). */
  area: number;
}

/**
 * A patch on a round face that crosses the seam of its surface (where a
 * revolved body's surface starts and ends) comes in two faces, one each side:
 * the piece on the other side of `face`'s, and the outline of the two as one.
 * (A handle's pad projected onto a mug's side, on the seam: one tap picked
 * half of it, and the handle was bridged from half a pad.)
 */
function acrossSeam(body: Shape3D, face: Face): { other: Face; wire: any } | null {
  if (!['CYLINDRE', 'CONE', 'SPHERE', 'TORUS', 'REVOLUTION_SURFACE'].includes(face.geomType)) {
    return null;
  }
  const TAU = 2 * Math.PI;
  const onSeam = (face: Face, point: Vec3) => {
    const angle = ((face.uvCoordinates(point)[0] % TAU) + TAU) % TAU;

    return angle < 1e-6 || TAU - angle < 1e-6;
  };
  try {
    for (const e of face.edges) {
      const mid = e.pointAt(0.5).toTuple() as Vec3;
      if (!onSeam(face, mid)) {
        continue;
      }
      const other = body.faces.find(otherFace => !otherFace.isSame(face) && otherFace.geomType === face.geomType && otherFace.edges.some(edge => edge.isSame(e)));
      // (The same surface going on smoothly across the edge.)
      if (!other || dot(norm(face.normalAt(mid).toTuple() as Vec3), norm(other.normalAt(mid).toTuple() as Vec3)) < 1 - 1e-6) {
        continue;
      }
      // The two outlines, the edge between them left out, end to end.
      const pool = [...face.clone().outerWire().edges, ...other.clone().outerWire().edges].filter(edge => !edge.isSame(e));
      const chain = [pool.shift()!];
      const tol = sizeOf(body) * 1e-5;
      while (pool.length) {
        const end = chain[chain.length - 1].endPoint.toTuple() as Vec3;
        const end0 = chain[chain.length - 1].startPoint.toTuple() as Vec3;
        const i = pool.findIndex(edge => [edge.startPoint, edge.endPoint].some(q => [end, end0].some(point => dist(q.toTuple() as Vec3, point) < tol)));
        if (i < 0) {
          return null;
        }
        chain.push(pool.splice(i, 1)[0]);
      }

      return { other, wire: assembleWire(chain).wrapped };
    }
  } catch {
    // (Not one to join: the face as it is.)
  }

  return null;
}

/**
 * One end of Connect's bridge: the face's outline (`size` of it, about its
 * middle), and the same moved a little way into its body when it's to be
 * joined or cut (so the bodies overlap it, not only touch) - never out of the
 * far side.
 */
function bridgeEnd(body: Shape3D, face: Face, size: number, inward: boolean, sink: boolean): BridgeEnd {
  const oc = getOC();
  const joined = acrossSeam(body, face);
  let info = faceInfo(face);
  if (joined) {
    // The middle, the area and the way out of the two pieces as one.
    const joinedInfo = faceInfo(joined.other);
    const area = info.area + joinedInfo.area;
    const center = scale(add(scale(info.center, info.area), scale(joinedInfo.center, joinedInfo.area)), 1 / area);
    info = { ...info, area, center, normal: norm(add(scale(info.normal, info.area), scale(joinedInfo.normal, joinedInfo.area))) };
  }
  const wire = joined?.wire ?? oc.BRepTools.OuterWire(face.wrapped);
  // (A joined outline evenly round by length: by the pieces' own measures, its
  // points bunched on the straight sides, few on the arcs, and the smooth
  // outline made through them bulged out past the pad.)
  const dense = joined ? curvePoints(wire, 512, true) : null;
  const ring = dense ? evenly([...dense, dense[0]], 65).slice(0, 64) : curvePoints(wire, 64, true);
  const reach = Math.max(...ring.map(point => dist(point, info.center))) * size;
  const around = ring.map(point => scale(sub(point, info.center), size));
  const dir = inward ? scale(info.normal, -1) : info.normal;
  // The ends start a little back from the faces so the bridge overlaps what it
  // joins (into the body, but not out of its back; for a tunnel, outside it).
  const [lo, hi] = body.boundingBox.bounds as [Vec3, Vec3];
  let behind = 0;
  for (const x of [lo[0], hi[0]]) {
    for (const y of [lo[1], hi[1]]) {
      for (const z of [lo[2], hi[2]]) {
        behind = Math.max(behind, dot(sub(info.center, [x, y, z]), info.normal));
      }
    }
  }
  const depth = !sink ? 0 : inward ? reach * 0.25 : Math.max(1e-3, Math.min(reach * 0.25, behind * 0.45 || reach * 0.1));
  const t = new oc.gp_Trsf();
  const at = new oc.gp_Pnt(info.center[0], info.center[1], info.center[2]);
  t.SetScale(at, size);
  const move = new oc.gp_Trsf();
  const vector = new oc.gp_Vec(-dir[0] * depth, -dir[1] * depth, -dir[2] * depth);
  move.SetTranslation(vector);
  const both = move.Multiplied(t);
  const mk = new oc.BRepBuilderAPI_Transform(wire, both, true);
  const outline = mk.Shape();
  const mr = new oc.BRepBuilderAPI_Transform(wire, t, true);
  const rim = mr.Shape();
  for (const x of [t, at, move, vector, both, mk, mr]) {
    x.delete();
  }

  return { center: info.center, dir, outline, rim, depth, reach, ring: around, area: info.area * size * size, joined: !!joined };
}

/** Why a bridge couldn't be made (its curve too tight for its width: the usual reason). */
const bridgeFailed = (guided: boolean) =>
  guided
    ? "The bridge can't be made along this curve (it turns too tightly for its width, or twists through itself) - try a gentler curve, or a smaller Size"
    : "The bridge can't be made between these two faces as they are (too close for its width, or outlines too unlike each other) - try a smaller Size or another Bend, or draw a curve for it to follow";

/**
 * Connect's bridge: face A's outline swept along `along` (0..1, from A's
 * middle to B's) turning into face B's - it starts and ends exactly on the
 * faces' edges (as sized by bridgeEnd), and goes on, straight, as far into
 * the bodies as bridgeEnd set it back.
 */
function sweepBridge(a: BridgeEnd, b: BridgeEnd, along: (t: number) => Vec3, how: { guided: boolean; exact: boolean; slide?: Vec3; samples: number }): { shape: Shape3D; exact: boolean } {
  const oc = getOC();
  const { guided, exact, slide, samples } = how;
  // A bridge is at least this big: its smaller end carried straight from one
  // face to the other (sliding, as little of that as the curve may lean). Less,
  // and the sweep went wrong without saying so - turned inside out part of the
  // way, its two halves cancelling (a solid of 128 mm3 for one of 30 000).
  const least = Math.min(a.area, b.area) * dist(a.center, b.center) * 0.15;
  // B's outline lined up with A's as A's arrives there carried along the
  // curve: the same way round, from the point A's first point comes to.
  // (Starting from another corner, or going round the other way, the bridge
  // twisted - half way round, or inside out to a solid of half a mm3.)
  const fr = carriedFrames(along, 120);
  const [f0, f1] = [fr[0], fr[fr.length - 1]];
  const arrived = a.ring.map((point): Vec3 => add(scale(f1.r, dot(point, f0.r)), scale(f1.s, dot(point, f0.s))));
  const flatten = (e: BridgeEnd, point: Vec3) => sub(point, scale(e.dir, dot(point, e.dir)));
  let bRing = b.ring;
  // (An outline joined across a seam is in more pieces than the face's own,
  // and the sweep pairs them up wrongly: only the lined-up ones are used.)
  const lined = !a.joined && !b.joined;
  {
    const count = b.ring.length;
    const step = Math.max(1, Math.round(count / a.ring.length));
    let best = Infinity;
    for (const ring of [b.ring, [...b.ring].reverse()]) {
      for (let shift = 0; shift < count; shift++) {
        let cost = 0;
        for (let i = 0; i < arrived.length; i++) {
          const delta = sub(flatten(b, arrived[i]), flatten(b, ring[(shift + i * step) % count]));
          cost += dot(delta, delta);
        }
        if (cost < best) {
          (best = cost), (bRing = [...ring.slice(shift), ...ring.slice(0, shift)]);
        }
      }
    }
  }
  const spine = (lead: boolean) => {
    // In from deep in A, straight out through its face; along the curve; and the same into B.
    const back = (e: BridgeEnd, rev: boolean) => {
      const depths = [0, 1, 2, 3].map(i => (e.depth * (rev ? i : 3 - i)) / 3);

      return lead && e.depth > 0 ? depths.filter(x => x > 0).map(x => sub(e.center, scale(e.dir, x))) : [];
    };
    const pts = [...back(a, false), ...Array.from({ length: samples + 1 }, (_, i) => along(i / samples)), ...back(b, true)];
    const span = dist(pts[0], pts[pts.length - 1]) + 1;

    return assembleWire([makeBSplineApproximation(pts, { tolerance: span * 1e-4, degMax: 5, degMin: 3 })]);
  };
  const pipe = (path: ReturnType<typeof spine>, sections: (() => any[])[]): Shape3D | null => {
    // The way the outline is carried along: each copes with curves the others don't.
    for (const section of sections) {
      for (const mode of slide ? ['slide'] : ['discrete', 'corrected']) {
        let ends: any[];
        try {
          ends = section();
        } catch {
          continue;
        }
        const mk = new oc.BRepOffsetAPI_MakePipeShell(path.wrapped);
        const progress = new oc.Message_ProgressRange();
        try {
          if (mode === 'slide') {
          // Every section facing the same way: the outline slides along the curve, not turning with it.
            const x = xDirFor(slide!);
            const origin = new oc.gp_Pnt(0, 0, 0);
            const direction = new oc.gp_Dir(slide![0], slide![1], slide![2]);
            const vx = new oc.gp_Dir(x[0], x[1], x[2]);
            const ax = new oc.gp_Ax2(origin, direction, vx);
            mk.SetMode(ax);
            for (const handle of [origin, direction, vx, ax]) {
              handle.delete();
            }
          } else if (mode === 'discrete') {
            mk.SetDiscreteMode();
          } else {
            mk.SetMode(false);
          }
          for (const end of ends) {
            mk.Add(end, false, false);
          }
          mk.Build(progress);
          if (!mk.IsDone()) {
            throw new Error('sweep');
          }
          mk.MakeSolid();
          let shape = cast(mk.Shape()) as Shape3D;
          // (Its sign and that it isn't empty: the rough measure tells both.)
          const volume = roughVolume(shape);
          if (volume < 0) {
            shape = cast(shape.wrapped.Reversed()) as Shape3D;
          }
          // (Ends that aren't flat aren't closed: a tube open at both ends.)
          if (!shapeValid(shape) || !(Math.abs(volume) > least) || openEdges(shape).length) {
            throw new Error('bad');
          }

          return shape;
        } catch {
        /* the next way, or none */
        } finally {
          mk.delete();
          progress.delete();
        }
      }
    }

    return null;
  };
  // Set back into the bodies: from face to face, then each face's outline
  // straight on into its body (a plug). Swept from where it was set back
  // instead, the outline was already part way to the other face's where it
  // left its own - a square end into a small round one started inside the
  // square's edges.
  if (exact && lined && (a.depth > 0 || b.depth > 0)) {
    const plug = (e: BridgeEnd): Shape3D => {
      const mf = new oc.BRepBuilderAPI_MakeFace(oc.TopoDS.Wire(e.rim), true);
      const vector = new oc.gp_Vec(-e.dir[0] * e.depth, -e.dir[1] * e.depth, -e.dir[2] * e.depth);
      try {
        if (!mf.IsDone()) {
          throw new Error('not flat');
        }
        const pr = new oc.BRepPrimAPI_MakePrism(mf.Face(), vector, true, true);
        const shape = cast(pr.Shape()) as Shape3D;
        pr.delete();

        return shape;
      } finally {
        mf.delete();
        vector.delete();
      }
    };
    const piped = pipe(spine(false), [() => [a.rim, b.rim]]);
    if (piped) {
      try {
        let out = piped;
        for (const e of [a, b]) {
          if (e.depth > 0) {
            out = out.fuse(plug(e));
          }
        }
        if (quickVolume(out) < 0) {
          out = cast(out.wrapped.Reversed()) as Shape3D;
        }
        if (shapeValid(out) && [...iterTopo(out.wrapped, 'solid')].length === 1 && measureVolume(out) > measureVolume(piped)) {
          return { shape: out, exact: true };
        }
      } catch {
        /* (a curved face, or a plug that won't join) the way below */
      }
    }
  }
  // The faces' own outlines; and, where one can't be turned into the other (a
  // square into an L: not the same number of sides, corners that don't pair
  // up), each as one smooth closed curve through points round it. `flat`: laid
  // flat across the way out of the face (a patch on a round face - a mug's
  // side - has an outline that isn't flat, and no sweep closes on it).
  const smooth = (e: BridgeEnd, flat = false, own = false) => {
    const base = sub(e.center, scale(e.dir, e.depth));
    const ring = e === b && !own ? bRing : e.ring;
    // (A little inside the face's own edge: walls a hair apart from the body's make its join leave gaps.)
    const round = ring.map(point => add(base, scale(flat ? flatten(e, point) : point, 0.97)));

    return assembleWire([makeBSplineApproximation([...round, round[0]], { tolerance: Math.max(1e-4, e.reach * 1e-3), degMax: 5, degMin: 3 })]).wrapped;
  };
  // (Faces' own outlines: tried first each the way it goes round;
  // then lined up. An L's outline lined up with a square's that way twisted the
  // bridge at its inward corner, and it wouldn't join.)
  const own = lined ? [() => [a.outline, b.outline], () => [smooth(a), smooth(b, false, true)]] : [];
  const smoothPiped = pipe(spine(true), [...own, () => [smooth(a), smooth(b)], () => [smooth(a, true), smooth(b, true)]]);
  if (smoothPiped) {
    return { shape: smoothPiped, exact: false };
  }
  throw new Error(bridgeFailed(guided));
}
