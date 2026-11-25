import { makeCylinder } from 'replicad';
import { AFFINE_ID, affineFrom, affineIsSimilar, affineThen, rotateAbout, scaleAbout, shapeThrough } from '../affine';
import { add, dot, len, norm, scale, sub } from '../../geom';
import { isEmpty, need } from '../bodies';
import { resolveAxis, resolveFace } from '../references';
import { cylinderOf, editNotes } from '../faceEdit';
import { insideOf } from '../booleans';
import { quickVolume } from '../ocFree';
import { guardEdit } from '../editGuard';
import { freeformShape } from '../freeformShape';
import { stretchShape } from '../stretch';
import { movedTags } from '../provenance';
import type { Shape3D } from 'replicad';
import type { Feature, Vec3 } from '../../doc/types';
import type { Affine, Ctx } from '../types';

/** The affine map of a move/scale/mirror step (null for patterns). */
function opAffine(op: Extract<Feature, { type: 'transform' }>['op']): Affine | null {
  const fromPoints = affineFrom;
  switch (op.kind) {
    case 'move': {
      const rotation = op.rotate && Math.abs(op.rotate.angle) > 1e-9 ? op.rotate : null;

      return fromPoints(point => add(rotation ? rotateAbout(point, rotation.origin, rotation.axis, rotation.angle) : point, op.translate));
    }
    case 'scale':
      return scaleAbout(op.center, [op.factor, op.factor, op.factor]);
    case 'scaleXYZ':
      return scaleAbout(op.center, op.factors);
    case 'mirror': {
      const unitNormal = norm(op.plane.normal);

      return fromPoints(point => sub(point, scale(unitNormal, 2 * dot(sub(point, op.plane.origin), unitNormal))));
    }
    default:
      return null;
  }
}

/**
 * A pattern of a hole: the hole's round wall as a plug - as long as the wall, a hair longer at an end that is open
 * - cut out of the body again at each place of the pattern. (A pattern started from a hole's wall copied the whole
 * body: there was no way to repeat a hole.)
 */
function holePattern(transform: Extract<Feature, { type: 'transform' }>, ctx: Ctx): void {
  const op = transform.op;
  if (op.kind !== 'linear' && op.kind !== 'circular') {
    throw new Error('A hole is repeated with a pattern');
  }
  const id = transform.bodies[0];
  const body = need(ctx.bodies, id);
  const face = resolveFace(body, transform.hole!);
  const cy = cylinderOf(face);
  if (!cy || cy.s >= 0) {
    throw new Error('Pick the round wall of a hole to repeat the hole');
  }
  patternCount(op.count);
  const a = norm(cy.a);
  const ts: number[] = [];
  for (const e of face.edges) {
    for (const fraction of [0, 0.25, 0.5, 0.75, 1]) {
      ts.push(dot(sub(e.pointAt(fraction).toTuple() as Vec3, cy.c), a));
    }
  }
  let [t0, t1] = [Math.min(...ts), Math.max(...ts)];
  if (!(t1 - t0 > 1e-9)) {
    throw new Error('That hole has no depth to repeat');
  }
  // An end with nothing past it (the hole's mouth, the far side of a hole right through): a hair past it, so the
  // cut comes out clean. An end with the body past it (a hole's bottom): exactly there, the same depth.
  const hair = Math.max(1e-3, cy.r * 0.02);
  const probe = Math.max(1e-4, Math.min(cy.r, t1 - t0) * 0.01);
  const [past0, past1] = insideOf(body, [add(cy.c, scale(a, t0 - probe)), add(cy.c, scale(a, t1 + probe))]);
  if (!past0) {
    t0 -= hair;
  }
  if (!past1) {
    t1 += hair;
  }
  const plug = makeCylinder(cy.r, t1 - t0, add(cy.c, scale(a, t0)), a) as Shape3D;
  let step: (k: number) => Affine;
  if (op.kind === 'linear') {
    if (Math.abs(op.spacing) < 1e-9 || len(op.dir) < 1e-12) {
      throw new Error('The spacing is zero: the holes would all be in one place');
    }
    step = index => affineFrom(point => add(point, scale(norm(op.dir), op.spacing * index)));
  } else {
    if (Math.abs(op.angle) < 1e-9) {
      throw new Error('The angle is zero: the holes would all be in one place');
    }
    const ax = resolveAxis(op.axis, ctx);
    const full = Math.abs(Math.abs(op.angle) - 360) < 1e-6;
    const turn = op.angle / (full ? op.count : Math.max(1, op.count - 1));
    step = index => affineFrom(point => rotateAbout(point, ax.origin, ax.dir, turn * index));
  }
  let out = body;
  let missed = 0;
  for (let index = 1; index < op.count; index++) {
    const next = out.cut(shapeThrough(plug, step(index))) as Shape3D;
    if (isEmpty(next)) {
      throw new Error('That pattern would cut the whole body away');
    }
    // (A place off the body: nothing to cut there - said, and the others made.)
    if (Math.abs(quickVolume(next) - quickVolume(out)) <= Math.abs(quickVolume(out)) * 1e-9) {
      missed++;
    }
    out = next;
  }
  if (missed === op.count - 1) {
    throw new Error('None of those holes is on the body - check the direction and the spacing');
  }
  if (missed) {
    editNotes.push(`${missed} of the ${op.count - 1} new holes ${missed === 1 ? 'is' : 'are'} off the body: nothing was cut there.`);
  }
  const kept = guardEdit(body, out, true);
  if (!kept) {
    throw new Error('That pattern would cut the whole body away');
  }
  ctx.bodies.set(id, kept);
  ctx.freeforms.delete(id);
}

export function transform(transformFeature: Extract<Feature, { type: 'transform' }>, ctx: Ctx): void {
  const op = transformFeature.op;
  if (transformFeature.hole) {
    return holePattern(transformFeature, ctx);
  }
  const copies: [string, Shape3D][] = [];
  for (const id of transformFeature.bodies) {
    const body = need(ctx.bodies, id);
    const results: Shape3D[] = [];
    switch (op.kind) {
      case 'move': {
        let moved = body.clone();
        if (op.rotate && Math.abs(op.rotate.angle) > 1e-9) {
          moved = moved.rotate(op.rotate.angle, op.rotate.origin, op.rotate.axis);
        }
        if (len(op.translate) > 1e-9) {
          moved = moved.translate(op.translate);
        }
        results.push(moved);
        break;
      }
      case 'scale':
        if (op.factor <= 0) {
          throw new Error('Scale must be positive');
        }
        results.push(body.clone().scale(op.factor, op.center));
        break;
      case 'scaleXYZ': {
        if (op.factors.some(factor => factor <= 0)) {
          throw new Error('Scale factors must be positive');
        }
        const ff = ctx.freeforms.get(id);
        const [kx, ky, kz] = op.factors;
        // A freeform is rebuilt from its stretched cage (smooth as ever); any
        // other body is rebuilt face by face, stretched (all three the same: a plain scale).
        if (ff) {
          results.push(freeformShape(ff.feature, affineThen(ff.m, scaleAbout(op.center, op.factors))));
        } else if (Math.abs(kx - ky) < 1e-12 && Math.abs(ky - kz) < 1e-12) {
          results.push(body.clone().scale(kx, op.center));
        } else {
          results.push(stretchShape(body, op.center, op.factors));
        }
        break;
      }
      case 'mirror':
        results.push(body.clone().mirror(op.plane.normal, op.plane.origin));
        break;
      case 'linear':
        patternCount(op.count);
        if (Math.abs(op.spacing) < 1e-9 || len(op.dir) < 1e-12) {
          throw new Error('The spacing is zero: the copies would all sit in one place');
        }
        for (let index = 1; index < op.count; index++) {
          results.push(body.clone().translate(scale(norm(op.dir), op.spacing * index)));
        }
        break;
      case 'circular': {
        patternCount(op.count);
        if (Math.abs(op.angle) < 1e-9) {
          throw new Error('The angle is zero: the copies would all sit in one place');
        }
        const ax = resolveAxis(op.axis, ctx);
        const full = Math.abs(Math.abs(op.angle) - 360) < 1e-6;
        const step = op.angle / (full ? op.count : Math.max(1, op.count - 1));
        for (let index = 1; index < op.count; index++) {
          results.push(body.clone().rotate(step * index, ax.origin, ax.dir));
        }
        break;
      }
    }
    // Moved without changing shape: its mesh can be this body's, moved.
    const rigid = (index: number): Affine | null => {
      if (op.kind === 'move' || op.kind === 'mirror') {
        return opAffine(op);
      }
      if (op.kind === 'linear') {
        return affineFrom(point => add(point, scale(norm(op.dir), op.spacing * (index + 1))));
      }
      if (op.kind === 'circular') {
        const ax = resolveAxis(op.axis, ctx);
        const full = Math.abs(Math.abs(op.angle) - 360) < 1e-6;
        const step = op.angle / (full ? op.count : Math.max(1, op.count - 1));

        return affineFrom(point => rotateAbout(point, ax.origin, ax.dir, step * (index + 1)));
      }

      return null;
    };
    results.forEach((result, resultIndex) => {
      const affine = rigid(resultIndex);
      if (!affine) {
        return;
      }
      movedFrom.set(result, { from: new WeakRef(body), m: affine, flip: op.kind === 'mirror' });
      // (Its faces are still the steps' that made them: see movedTags.)
      movedTags(body, result, transformFeature.id, affine);
    });
    const isPattern = op.kind === 'linear' || op.kind === 'circular';
    // Linked: the copies and what they were made from are a group (one already of a group: its copies join it);
    // each stands where its move put it. A linked body moved, turned, mirrored or scaled evenly stands somewhere
    // else in its group; stretched, it is no longer the others' shape, and leaves it.
    const placed = (index: number): Affine | null => {
      const affine = rigid(index) ?? (isPattern ? null : opAffine(op));

      return affine && affineIsSimilar(affine) ? affine : null;
    };
    const mine = ctx.links.get(id);
    if (isPattern || transformFeature.copy) {
      if (transformFeature.link && results.every((_, resultIndex) => placed(resultIndex))) {
        const at = mine ?? { group: `${transformFeature.id}:${id}`, m: AFFINE_ID };
        if (!mine) {
          ctx.links.set(id, at);
        }
        results.forEach((_, resultIndex) => ctx.links.set(`${transformFeature.id}:${id}:${resultIndex}`, { group: at.group, m: affineThen(at.m, placed(resultIndex)!) }));
      }
    } else if (mine) {
      const affine = placed(0);
      if (affine) {
        ctx.links.set(id, { group: mine.group, m: affineThen(mine.m, affine) });
      } else {
        ctx.links.delete(id);
      }
    }
    // A freeform stays rebuildable through moves, scales and mirrors (copies too).
    const ff = ctx.freeforms.get(id);
    const step = ff && !isPattern ? opAffine(op) : null;
    if (isPattern || transformFeature.copy) {
      results.forEach((result, resultIndex) => copies.push([`${transformFeature.id}:${id}:${resultIndex}`, result]));
      if (ff && step) {
        ctx.freeforms.set(`${transformFeature.id}:${id}:0`, { feature: ff.feature, m: affineThen(ff.m, step) });
      }
    } else {
      ctx.bodies.set(id, results[0]);
      if (ff && step) {
        ctx.freeforms.set(id, { feature: ff.feature, m: affineThen(ff.m, step) });
      } else {
        ctx.freeforms.delete(id);
      }
    }
  }
  for (const [id, shape] of copies) {
    ctx.bodies.set(id, shape);
  }
}

/**
 * Bodies that are another body moved, turned or mirrored (a Move step, a
 * pattern's copies): their mesh is that body's, moved the same way - meshed
 * again, a fan's rotated casing took 3 s, and a pattern meshed every copy.
 * (The faces and edges come in the same order: the shape is the same.)
 */
// (The body it was moved from held weakly: a chain of moves mustn't keep every earlier body alive.)
export const movedFrom = new WeakMap<Shape3D, { from: WeakRef<Shape3D>; m: Affine; flip: boolean }>();

/**
 * A pattern's count, held to what a phone can build: a typo (3000 for 30)
 * stops at once with a message, not after minutes (and again each time the
 * project is opened).
 */
const MAX_COPIES = 1000;
function patternCount(count: number): void {
  if (!(count >= 1) || !Number.isFinite(count)) {
    throw new Error('The count must be 2 or more');
  }
  if (count > MAX_COPIES) {
    throw new Error(`${Math.round(count)} copies is too many - up to ${MAX_COPIES} at once`);
  }
}
