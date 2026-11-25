import { cast, getOC, iterTopo, makeCylinder } from 'replicad';
import { bodyList, isEmpty, need } from '../bodies';
import { booleanVolumeOk, fuseAll, fuzzyBoolean } from '../booleans';
import { isFault } from '../faults';
import { openEdges, shapeValid, subShapes } from '../health';
import { cylinderOf, unify } from '../faceEdit';
import { measureVolume, quickVolume } from '../ocFree';
import { rebuild } from '../rebuildState';
import { threadDepth } from '../threads';
import { add, dot, len, norm, scale, sub } from '../../geom';
import { offsetSolid } from './shell';
import { threadFace, threadsCut } from './thread';
import type { Shape3D } from 'replicad';
import type { BooleanFeature, Vec3 } from '../../doc/types';
import type { Ctx } from '../types';

export function applyBoolean(feature: BooleanFeature, ctx: Ctx) {
  const { bodies } = ctx;
  let target = need(bodies, feature.target);
  const toolIds = bodyList(feature.tools, bodies, 'tools', feature.whole);
  const solidsIn = (x: Shape3D) => [...iterTopo(x.wrapped, 'solid')].length;
  // Subtract: every tool at once (see cutAway), each kept the clearance
  // away if one is set, cut from the body, the tools or all of them.
  if (feature.op === 'subtract' && toolIds.length) {
    const tools = toolIds.map(t => need(bodies, t));
    if (!solidsIn(target) || tools.some(t => !solidsIn(t))) {
      throw new Error('One of these is an open surface (e.g. a freeform with a hole), not a solid. Close it first: tap an edge of the hole → Fill hole, or give it a Thickness - then Union.');
    }
    const gap = Math.max(0, feature.clearance ?? 0);
    const from = feature.cutFrom ?? 'body';
    // Each body grown by the gap it keeps from the others (once each).
    const grown = new Map<Shape3D, Map<number, Shape3D[]>>();
    const grow = (shape: Shape3D, by: number): Shape3D[] => {
      if (!(by > 0)) {
        return [shape.clone()];
      }
      let shapes = grown.get(shape)?.get(by);
      if (!shapes) {
        // (A threaded body: the same thread cut on the body grown. The kernel can't grow a thread's own faces.)
        shapes = grownThreaded(shape, by, toolIds[tools.indexOf(shape)] ?? (shape === target ? feature.target : '')) ?? grownBy(shape, by) ?? undefined;
        if (!shapes) {
          throw new Error(`Couldn't keep ${+by.toFixed(4)} mm clear round one of the bodies - try a smaller clearance`);
        }
        grown.set(shape, (grown.get(shape) ?? new Map()).set(by, shapes));
      }

      return shapes.map(shape => shape.clone());
    };
    if (from === 'body') {
      const out = cutAway(target, tools.flatMap(t => grow(t, gap)));
      if (!feature.keepTools) {
        for (const t of toolIds) {
          bodies.delete(t);
        }
      }
      // Kept as it was: the result is a body of its own.
      bodies.set(feature.keepTarget ? feature.id : feature.target, out);

      return;
    }
    // The others give way: each cut by the body, grown by the gap.
    if (from === 'tools') {
      const outs = tools.map(t => cutAway(t, grow(target, gap)));
      outs.forEach((out, outIndex) => bodies.set(toolIds[outIndex], out));

      return;
    }
    // All of them, in turn: each gives way half the gap to the ones still
    // to come, and the ones before it what's left - itself less the
    // earlier ones grown by the whole gap, but its own core (itself
    // brought in by half the gap) kept. So any two end up the gap apart,
    // half from each where they overlapped: a peg through a plate, a hole
    // r + gap/2 and a pin r - gap/2. Only the bodies as they were are
    // grown or brought in (the kernel can't grow a cut one: its round
    // from the cut is the gap's own radius).
    const ids = [feature.target, ...toolIds];
    const was = [target, ...tools];
    const now = was.map((b, index) => {
      const by = was.slice(index + 1).flatMap(shape => grow(shape, gap / 2));
      if (index > 0) {
        let early = fuseAll(was.slice(0, index).flatMap(shape => grow(shape, gap)));
        const core = gap > 0 ? broughtIn(b, gap / 2) : b.clone();
        // (Its core not kept, if that cut fails: more is cut away, still the gap apart.)
        if (core) {
          try {
            early = fuzzyBoolean('cut', early, core);
          } catch (err) {
            if (isFault(err)) {
              throw err;
            }
          }
        }
        if (!isEmpty(early)) {
          by.push(early);
        }
      }

      return by.length ? cutAway(b, by) : b;
    });
    now.forEach((shape, index) => bodies.set(ids[index], shape));

    return;
  }
  let open: number | undefined;
  for (const t of toolIds) {
    const tool = need(bodies, t);
    const solids = (x: Shape3D) => [...iterTopo(x.wrapped, 'solid')].length;
    // An open freeform (a surface with a hole) isn't a solid: nothing to join into.
    if (!solids(target) || !solids(tool)) {
      throw new Error('One of these is an open surface (e.g. a freeform with a hole), not a solid. Close it first: tap an edge of the hole → Fill hole, or give it a Thickness - then Union.');
    }
    const before = feature.op === 'union' ? solids(target) + solids(tool) : 0;
    const prev = target;
    target = feature.op === 'union' ? target.fuse(tool) : feature.op === 'subtract' ? target.cut(tool) : target.intersect(tool);
    // A join that leaves a gap (a coil wound round a hollowed cowl: one
    // edge left open where the two met): the tolerant join closes it.
    if (feature.op === 'union') {
      open ??= openEdges(prev).length;
      let now = openEdges(target).length;
      if (now > open + openEdges(tool).length) {
        try {
          const fz = fuzzyBoolean('fuse', prev, tool);
          const nz = openEdges(fz).length;
          if (nz < now && booleanVolumeOk('fuse', prev, tool, fz)) {
            [target, now] = [fz, nz];
          }
        } catch {
          // keep the plain result: the usual checks speak for it
        }
      }
      open = now;
    }
    // A union joins: a body that doesn't touch would only be grouped with it, not joined.
    if (feature.op === 'union' && solids(target) >= before) {
      throw new Error("These bodies don't touch - Union needs them to overlap or touch (move one onto the other first)");
    }
    if (!(feature.op === 'intersect' && feature.keepTools)) {
      bodies.delete(t);
    }
  }
  if (isEmpty(target)) {
    throw new Error('The result is empty');
  }
  bodies.set(feature.op === 'intersect' && feature.keepTarget ? feature.id : feature.target, target);
}

/**
 * A body grown by `by` all round (what a clearance cut takes away), or brought
 * in when `by` is negative, as pieces that together are it - grown a piece at
 * a time: the kernel's offset of a body in two pieces (a peg cut into two
 * stubs) fails. Null: no go.
 */
function grownBy(shape: Shape3D, by: number): Shape3D[] | null {
  const oc = getOC();
  const off = new oc.BRepOffsetAPI_MakeOffsetShape();
  try {
    const parts = subShapes(shape, 'SOLID');
    const out: Shape3D[] = [];
    for (const x of parts.length > 1 ? parts.map(part => cast(part) as Shape3D) : [shape]) {
      const grown = offsetSolid(off, unify(x), by);
      const volume = grown ? Math.abs(measureVolume(grown)) : 0, v0 = Math.abs(measureVolume(x));
      if (!grown || !(by > 0 ? volume > v0 : volume < v0 && volume > 0)) {
        return null;
      }
      out.push(grown);
    }

    return out;
  } finally {
    off.delete();
  }
}

/**
 * A threaded body grown by `by` (the clearance a Subtract keeps round it). The kernel's own offset of a thread's
 * helical faces fails every time (asked: "when I want to subtract a thread and I put clearance, it always fails").
 * So: its grooves filled back in (a cylinder over the thread's reach - what it was before the thread), that
 * grown, and the same thread cut on its round face - a thread that much bigger all round (in a hole: that much
 * smaller), which is what a nut cut with it needs to turn on the bolt with that gap.
 * Null when the body has no thread of its own any more, or it doesn't work out (the plain way is tried then).
 */
function grownThreaded(shape: Shape3D, by: number, bodyId: string): Shape3D[] | null {
  const cut = [...threadsCut].filter(([step, t]) => t.body === bodyId && rebuild.stepsNow.has(step)).map(([, t]) => t);
  if (!cut.length) {
    return null;
  }
  try {
    // Its grooves filled in.
    let plain = shape;
    const v0 = Math.abs(measureVolume(shape));
    for (const t of cut) {
      // The whole band the thread is in - from under its roots to its round face - taken out and put back as one
      // clean ring. (A cylinder simply added over the grooves left their edges in the body: grown, that body broke
      // the engine.)
      const depth = threadDepth(t.pitch, t.inside) * 1.05 + 0.25 * t.pitch;
      const from = add(t.c, scale(t.a, t.t0));
      const height = t.t1 - t.t0;
      const [inner, outer] = t.inside ? [t.r, t.r + depth] : [Math.max(t.r - depth, t.r * 0.05), t.r];
      const ring = (makeCylinder(outer, height, from, t.a) as Shape3D).cut(makeCylinder(inner, height, from, t.a) as Shape3D) as Shape3D;
      plain = unify((plain.cut(ring.clone()) as Shape3D).fuse(ring) as Shape3D);
    }
    // (Nothing filled: there is no thread on it now - something else was done to it since.)
    if (!(Math.abs(measureVolume(plain)) > v0 * (1 + 1e-9))) {
      return null;
    }
    const grown = grownBy(plain, by);
    if (!grown || grown.length !== 1) {
      return null;
    }
    let out = grown[0];
    for (const t of cut) {
      const want = t.r + (t.inside ? -by : by);
      if (!(want > 0)) {
        return null;
      }
      const face = out.faces.find((face) => {
        if (face.geomType !== 'CYLINDRE') {
          return false;
        }
        const cy = cylinderOf(face);
        if (!cy || cy.s < 0 !== t.inside || Math.abs(cy.r - want) > 1e-4 * Math.max(1, want)) {
          return false;
        }
        if (Math.abs(dot(norm(cy.a), t.a)) < 0.9999) {
          return false;
        }
        // (The same axis: its centre is on the thread's axis line.)
        const offset = sub(cy.c, t.c);

        return len(sub(offset, scale(t.a, dot(offset, t.a)))) < 1e-4 * Math.max(1, want);
      });
      if (!face) {
        return null;
      }
      // Along the first thread's own stretch - but not into what has grown towards it: an end that stops at a
      // shoulder (under a bolt's head) stops the clearance short of where it did, the shoulder having come that
      // much nearer. (Run on to the old end, the groove cut into the grown head, and the hole had a ridge there.)
      const along: number[] = [];
      for (const e of face.edges) {
        for (const fraction of [0, 0.25, 0.5, 0.75, 1]) {
          along.push(dot(sub(e.pointAt(fraction).toTuple() as Vec3, t.c), t.a));
        }
      }
      const g0 = Math.min(...along);
      const g1 = Math.max(...along);
      out = threadFace(out, face, t.pitch, t.left, { t0: Math.max(t.t0, g0), t1: Math.min(t.t1, g1), anchor: t.t0, phase: t.phase, shallow: by, c: t.c, a: t.a }, undefined, t.starts ?? 1);
    }

    return Math.abs(quickVolume(out)) > 0 ? [out] : null;
  } catch (err) {
    if (isFault(err)) {
      throw err;
    }

    return null;
  }
}

/** A body brought in by `by` all round (one shape), or null when that doesn't work. */
function broughtIn(shape: Shape3D, by: number): Shape3D | null {
  const grown = grownBy(shape, -by);

  return grown ? (grown.length > 1 ? fuseAll(grown) : grown[0]) : null;
}

/**
 * The Subtract tool's cut: every tool at once - joined, then one tolerant cut
 * checked by its volume. Cut one by one, eight vents round a lamp shade left
 * it with no solid after the sixth, and the message blamed an "open surface".
 */
function cutAway(target: Shape3D, tools: Shape3D[]): Shape3D {
  const solidsIn = (x: Shape3D) => [...iterTopo(x.wrapped, 'solid')].length;
  const all = fuseAll(tools);
  let out = fuzzyBoolean('cut', target, all);
  if (!solidsIn(out) || !booleanVolumeOk('cut', target, all, out)) {
    const plain = target.cut(all);
    if (solidsIn(plain) && booleanVolumeOk('cut', target, all, plain)) {
      out = plain;
    } else if (isEmpty(out) && isEmpty(plain)) {
      throw new Error('The result is empty');
    } else {
      throw new Error("Subtracting these didn't work out - the geometry engine lost the shape. Try the tools one or two at a time");
    }
  } else if (!shapeValid(out) && shapeValid(target)) {
    // The tolerant cut can leave faces that don't meet up where the plain one
    // is clean (a direction switch's slot through the housing's shelled top).
    try {
      const plain = target.cut(all);
      if (solidsIn(plain) && shapeValid(plain) && booleanVolumeOk('cut', target, all, plain)) {
        out = plain;
      }
    } catch {
      // No plain cut either (it can come back empty): the tolerant one goes on to be checked.
    }
  }

  return out;
}
