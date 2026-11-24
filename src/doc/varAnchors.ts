// Where each variable acts on the model, for its tag in the view (pure logic).
//
// A variable is used by a sketch dimension, a step's value (an extrude's
// distance, a turn's angle…) or another variable. Each use gets a spot: on
// the dimension, at the top of the extrusion, at the turn's pivot. The spot
// then follows the moves and turns made later to the body it's on, so a tag
// sits on the arm where the arm is now, not where it was sketched.

import { add, cross, norm, scale, toWorld } from '../geom';
import { arcFrom3 } from '../sketch/curves';
import { applyAffine, stepAffine, type Affine } from './freeformCopies';
import { kindOfPath } from './params';
import type { Feature, PlaneDef, SketchConstraint, SketchEntity, Variable, Vec2, Vec3 } from './types';

export type VarKind = 'length' | 'angle' | 'number';

export interface VarUse {
  /** The step (or sketch) that uses it. */
  feature: string;
  /** What in it: a value's path, or a sketch dimension's id. */
  where: string;
  kind: VarKind;
  /** The formula there ("arm1", "p1 + arm1 - 70 mm"). */
  expr: string;
}

/** The use is the variable itself ("arm1", or "2*baseR" on a diameter), not a formula it's part of. */
export function isDirect(varUse: VarUse, name: string): boolean {
  const esc = name.replace(/[^a-z0-9_]/gi, '');

  return new RegExp(`^\\s*(${esc}|2\\s*\\*\\s*${esc}|${esc}\\s*\\*\\s*2)\\s*$`).test(varUse.expr);
}

/** The kernel's answer, as far as tags need it. */
export interface AnchorWorld {
  sketchPlanes: Record<string, PlaneDef>;
  bodies: { id: string; positions: ArrayLike<number> }[];
  planes?: { id: string; plane: PlaneDef }[];
}

const UNIT_WORDS = new Set(['mm', 'cm', 'm', 'in', 'ft']);

/** The variable names in an expression ("2*kR + 3 mm" → kR). */
export function namesIn(expr: string): string[] {
  const out: string[] = [];
  for (const match of expr.matchAll(/[a-z_][a-z0-9_]*/gi)) {
    // A unit after a number ("3 mm", "3mm") is no name.
    const before = expr.slice(0, match.index).trimEnd();
    if (UNIT_WORDS.has(match[0].toLowerCase()) && /[\d.)]$/.test(before)) {
      continue;
    }
    if (!out.includes(match[0])) {
      out.push(match[0]);
    }
  }

  return out;
}

/** Every use of every variable (steps and sketch dimensions; not other variables). */
export function usesOf(features: readonly Feature[]): Map<string, VarUse[]> {
  const out = new Map<string, VarUse[]>();
  const add1 = (name: string, varUse: VarUse) => {
    const list = out.get(name) ?? [];
    list.push(varUse);
    out.set(name, list);
  };
  for (const feature of features) {
    if (feature.suppressed) {
      continue;
    }
    for (const [path, expr] of Object.entries(feature.exprs ?? {})) {
      for (const name of namesIn(expr)) {
        add1(name, { feature: feature.id, where: path, kind: kindOfPath(path), expr });
      }
    }
    if (feature.type === 'sketch') {
      for (const sketchConstraint of feature.constraints ?? []) {
        if (sketchConstraint.expr) {
          for (const name of namesIn(sketchConstraint.expr)) {
            add1(name, { feature: feature.id, where: sketchConstraint.id, kind: sketchConstraint.prop === 'angle' ? 'angle' : 'length', expr: sketchConstraint.expr! });
          }
        }
        for (const x of sketchConstraint.atExpr ?? []) {
          if (x) {
            for (const name of namesIn(x)) {
              add1(name, { feature: feature.id, where: sketchConstraint.id, kind: 'length', expr: x });
            }
          }
        }
      }
    }
  }

  return out;
}

/**
 * Length, angle or plain number: its unit ("40 mm"), else how it's used,
 * else what it's made from (p1 = baseH + post is a length).
 */
export function kindOfVariable(name: string, variables: readonly Variable[], uses: Map<string, VarUse[]>, seen = new Set<string>()): VarKind {
  // Its own unit first ("55 mm" is a length, even used in a ratio).
  const variable = variables.find(variable => variable.name === name);
  if (variable && /\d\s*(mm|cm|m|in|ft|"|')(?![a-z])/i.test(variable.expr)) {
    return 'length';
  }
  if (variable && /°/.test(variable.expr)) {
    return 'angle';
  }
  const nameUses = uses.get(name);
  if (nameUses?.length) {
    const kinds = new Set(nameUses.map(nameUse => nameUse.kind));

    return kinds.has('angle') && kinds.size === 1 ? 'angle' : kinds.has('length') ? 'length' : [...kinds][0];
  }
  if (!variable) {
    return 'number';
  }
  seen.add(name);
  for (const name of namesIn(variable.expr)) {
    if (!seen.has(name)) {
      const varKind = kindOfVariable(name, variables, uses, seen);
      if (varKind !== 'number') {
        return varKind;
      }
    }
  }

  return 'number';
}

/** The variables a variable is made from (directly). */
export function madeFrom(name: string, variables: readonly Variable[]): string[] {
  const variable = variables.find(variable => variable.name === name);

  return variable ? namesIn(variable.expr).filter(name => variables.some(variable => variable.name === name)) : [];
}

/** A sketch dimension's spot, in the sketch (like its label's). */
function dimSpot(sketchConstraint: SketchConstraint, entities: readonly SketchEntity[]): Vec2 | null {
  const e = entities.find(entity => entity.id === sketchConstraint.curves?.[0]);
  if (!e) {
    return null;
  }
  const turn = (center: Vec2, rot: number, off: Vec2): Vec2 => [center[0] + off[0] * Math.cos(rot) - off[1] * Math.sin(rot), center[1] + off[0] * Math.sin(rot) + off[1] * Math.cos(rot)];
  switch (e.kind) {
    case 'line':
      return [(e.a[0] + e.b[0]) / 2, (e.a[1] + e.b[1]) / 2];
    case 'circle':
    case 'polygon':
      return [e.center[0] + e.radius * Math.SQRT1_2, e.center[1] + e.radius * Math.SQRT1_2];
    case 'rect':
      return turn(e.center, e.rotation, sketchConstraint.prop === 'w' ? [0, -e.h / 2] : sketchConstraint.prop === 'h' ? [e.w / 2, 0] : [0, 0]);
    case 'ellipse':
      return turn(e.center, e.rotation, sketchConstraint.prop === 'ry' ? [0, e.ry] : [e.rx, 0]);
    case 'arc':
      return e.m;
    default:
      return 'points' in e ? (e.points[0] ?? null) : null;
  }
}

/** A string body id a step works on, if it has one. */
function bodyOf(feature: Feature): string | null {
  const x = feature as unknown as Record<string, unknown>;
  if (typeof x.target === 'string') {
    return x.target;
  }
  if (typeof x.body === 'string') {
    return x.body;
  }
  if (Array.isArray(x.bodies) && typeof x.bodies[0] === 'string') {
    return x.bodies[0];
  }
  const ref = (Array.isArray(x.edges) ? x.edges[0] : x.face) as { body?: string } | undefined;

  return ref?.body ?? null;
}

/** The middle of a body as it is now (its box). */
function bodyMiddle(world: AnchorWorld, id: string): Vec3 | null {
  const b = world.bodies.find(body => body.id === id);
  if (!b || b.positions.length < 3) {
    return null;
  }
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < b.positions.length; i += 3) {
    for (let axis = 0; axis < 3; axis++) {
      lo[axis] = Math.min(lo[axis], b.positions[i + axis]);
      hi[axis] = Math.max(hi[axis], b.positions[i + axis]);
    }
  }

  return [0, 1, 2].map(axis => (lo[axis] + hi[axis]) / 2) as Vec3;
}

/**
 * A spot carried through the steps after `from` that move the body it's on:
 * moves, turns and mirrors (not copies); joined into another body, it goes
 * with that one from then on.
 */
function carrier(body: string | null, features: readonly Feature[], from: number): (p: Vec3) => Vec3 {
  if (!body) {
    return point => point;
  }
  const on = new Set([body]);
  const steps: Affine[] = [];
  for (let i = from + 1; i < features.length; i++) {
    const feature = features[i];
    if (feature.suppressed) {
      continue;
    }
    if (feature.type === 'transform' && !feature.copy && feature.bodies.some(b => on.has(b))) {
      const affine = stepAffine(feature.op);
      if (affine) {
        steps.push(affine);
      }
    } else if (feature.type === 'boolean' && feature.tools.some(t => on.has(t))) {
      on.add(feature.target);
    }
  }

  return point => steps.reduce<Vec3>((q, step) => applyAffine(step, q), point);
}

function carried(point: Vec3, body: string | null, features: readonly Feature[], from: number): Vec3 {
  return carrier(body, features, from)(point);
}

/** A sketch's points as they are now: on the body made from it (construction lines stay where drawn). */
function sketchCarrier(sketch: Extract<Feature, { type: 'sketch' }>, curve: string | undefined, features: readonly Feature[], world: AnchorWorld): (uv: Vec2) => Vec3 {
  const plane = world.sketchPlanes[sketch.id] ?? sketch.plane;
  const j = features.findIndex(feature => 'source' in feature && (feature.source as { sketch?: string }).sketch === sketch.id);
  const keep = sketch.entities.find(e => e.id === curve)?.construction || j < 0;
  const move = keep ? (point: Vec3) => point : carrier(bodyOf(features[j]) ?? features[j].id, features, j);

  return uv => move(toWorld(plane, uv));
}

/** Points along a circle round `axis` at `origin`, starting toward `from` (a polyline). */
function arcPoints(origin: Vec3, axis: Vec3, from: Vec3, deg: number, radius: number): Vec3[] {
  const unitAxis = norm(axis);
  const unitStart = norm(from);
  const perpendicular = cross(unitAxis, unitStart);
  const segmentCount = Math.max(6, Math.ceil(Math.abs(deg) / 6));

  return Array.from({ length: segmentCount + 1 }, (_, i) => {
    const t = ((deg * Math.PI) / 180) * (i / segmentCount);

    return add(origin, add(scale(unitStart, radius * Math.cos(t)), scale(perpendicular, radius * Math.sin(t))));
  });
}

/**
 * What a use changes, drawn on the model as it is now (polylines): the radius
 * of the circle it sizes, the line it makes long, the height of an extrusion,
 * the arc of a turn, a pivot's height.
 */
export function useMarks(varUse: VarUse, name: string, features: readonly Feature[], world: AnchorWorld): Vec3[][] {
  const i = features.findIndex(feature => feature.id === varUse.feature);
  const usedFeature = features[i];
  if (!usedFeature) {
    return [];
  }
  if (usedFeature.type === 'sketch') {
    const constraint = usedFeature.constraints?.find(constraint => constraint.id === varUse.where);
    const e = constraint && usedFeature.entities.find(entity => entity.id === constraint.curves?.[0]);
    if (!constraint || !e) {
      return [];
    }
    const at = sketchCarrier(usedFeature, e.id, features, world);
    const line = (a: Vec2, b: Vec2) => [at(a), at(b)];
    const turn = (center: Vec2, rot: number, off: Vec2): Vec2 => [center[0] + off[0] * Math.cos(rot) - off[1] * Math.sin(rot), center[1] + off[0] * Math.sin(rot) + off[1] * Math.cos(rot)];
    // "2*baseR" on a diameter: baseR is the radius - that's what's shown.
    const esc = name.replace(/[^a-z0-9_]/gi, '');
    const half = new RegExp(`^\\s*(2\\s*\\*\\s*${esc}|${esc}\\s*\\*\\s*2)\\s*$`).test(constraint.expr ?? '');
    const round = (center: Vec2, radius: number): Vec3[][] => {
      const diagonal: Vec2 = [Math.SQRT1_2, Math.SQRT1_2];
      const rim: Vec2 = [center[0] + radius * diagonal[0], center[1] + radius * diagonal[1]];
      if (constraint.prop === 'radius' || half) {
        return [line(center, rim)];
      }

      return [line([center[0] - radius * diagonal[0], center[1] - radius * diagonal[1]], rim)];
    };
    switch (e.kind) {
      case 'line':
        return [line(e.a, e.b)];
      case 'circle':
      case 'polygon':
        return round(e.center, e.radius);
      case 'arc': {
        const ac = arcFrom3(e.a, e.m, e.b);

        return ac ? round(ac.c, ac.r) : [];
      }
      case 'rect': {
        const [hw, hh] = [e.w / 2, e.h / 2];
        const placePoint = (x: number, y: number) => turn(e.center, e.rotation, [x, y]);

        return constraint.prop === 'h' ? [line(placePoint(hw, -hh), placePoint(hw, hh))] : [line(placePoint(-hw, -hh), placePoint(hw, -hh))];
      }
      case 'ellipse':
        return [line(e.center, turn(e.center, e.rotation, constraint.prop === 'ry' ? [0, e.ry] : [e.rx, 0]))];
      default:
        return [];
    }
  }
  if (usedFeature.type === 'extrude') {
    // From the sketch up to the far end: the height it makes.
    const top = useSpot(varUse, features, world);
    const src = usedFeature.source;
    let base: Vec3 | null = null;
    if (src.kind === 'profile') {
      const pl = world.sketchPlanes[src.sketch] ?? (features.find(feature => feature.id === src.sketch) as { plane?: PlaneDef } | undefined)?.plane;
      const firstRegion = src.regions[0];
      if (pl && firstRegion) {
        base = carried(toWorld(pl, firstRegion.c), usedFeature.target ?? usedFeature.id, features, i);
      }
    } else {
      base = carried(src.face.center, usedFeature.target ?? usedFeature.id, features, i);
    }

    return base && top ? [[base, top]] : [];
  }
  if (usedFeature.type === 'transform' && usedFeature.op.kind === 'move' && usedFeature.op.rotate) {
    const rotate = usedFeature.op.rotate;
    const move = carrier(usedFeature.bodies[0] ?? null, features, i);
    // The pivot's height (or X, Y): from where that is 0 to the pivot.
    const match = /origin\.(\d)$/.exec(varUse.where);
    if (match) {
      const foot = [...rotate.origin] as Vec3;
      foot[Number(match[1])] = 0;

      return [[move(foot), move(rotate.origin)]];
    }
    // The angle: an arc round the axis at the pivot, with its two arms.
    const ax = norm(rotate.axis);
    const ref = Math.abs(ax[2]) < 0.9 ? cross(ax, [0, 0, 1]) : cross(ax, [1, 0, 0]);
    const pts = arcPoints(rotate.origin, ax, ref, rotate.angle, 30).map(move);
    const origin = move(rotate.origin);

    return [[origin, pts[0]], pts, [origin, pts[pts.length - 1]]];
  }

  return [];
}

/** Where one use is in the view now (null: nowhere to show it). */
export function useSpot(varUse: VarUse, features: readonly Feature[], world: AnchorWorld): Vec3 | null {
  const i = features.findIndex(feature => feature.id === varUse.feature);
  const usedFeature = features[i];
  if (!usedFeature) {
    return null;
  }
  if (usedFeature.type === 'sketch') {
    const constraint = usedFeature.constraints?.find(constraint => constraint.id === varUse.where);
    // (A point placed by it - X typed as "pcd / 2": at that point. It had no tag at all.)
    const at = constraint && (dimSpot(constraint, usedFeature.entities) ?? (constraint.type === 'fix' && constraint.at ? constraint.at : null));
    if (!at) {
      return null;
    }
    const worldPoint = toWorld(world.sketchPlanes[usedFeature.id] ?? usedFeature.plane, at);
    // A construction line is no part of a body: it stays where it was drawn
    // (the post's height, up the post - not swung out with the arm).
    if (usedFeature.entities.find(e => e.id === constraint.curves?.[0])?.construction) {
      return worldPoint;
    }
    // On the body made from this sketch (the first step that uses it), and with it from then on.
    const j = features.findIndex(feature => 'source' in feature && (feature.source as { sketch?: string }).sketch === usedFeature.id);
    if (j < 0) {
      return worldPoint;
    }
    const laterFeature = features[j];

    return carried(worldPoint, bodyOf(laterFeature) ?? laterFeature.id, features, j);
  }
  if (usedFeature.type === 'extrude') {
    const src = usedFeature.source;
    let base: Vec3 | null = null;
    let normal: Vec3 | null = null;
    if (src.kind === 'profile') {
      const pl = world.sketchPlanes[src.sketch] ?? (features.find(feature => feature.id === src.sketch) as { plane?: PlaneDef } | undefined)?.plane;
      const firstRegion = src.regions[0];
      if (pl && firstRegion) {
        [base, normal] = [toWorld(pl, firstRegion.c), pl.normal];
      }
    } else {
      [base, normal] = [src.face.center, src.face.normal];
    }
    if (!base || !normal) {
      return null;
    }

    // At the far end (where the arrow is): that's what distance and taper size.
    return carried(add(base, scale(normal, usedFeature.distance)), usedFeature.target ?? usedFeature.id, features, i);
  }
  if (usedFeature.type === 'transform' && usedFeature.op.kind === 'move' && usedFeature.op.rotate) {
    // A turn: at its pivot (it turns about it, so the turn itself doesn't move it).
    return carried(usedFeature.op.rotate.origin, usedFeature.bodies[0] ?? null, features, i);
  }
  const plane = world.planes?.find(plane => plane.id === usedFeature.id);
  if (plane) {
    return plane.plane.origin;
  }
  const b = bodyOf(usedFeature);
  const mid = b ? bodyMiddle(world, b) : null;
  if (mid) {
    return mid;
  }
  // A pattern whose copies have since gone into another body (holes cut with them): on what it turns about, or at
  // its first copy's place - the count of a ring of holes had no tag.
  if (usedFeature.type === 'transform' && usedFeature.op.kind === 'circular') {
    return usedFeature.op.axis.origin;
  }

  return null;
}

export interface VarTag {
  name: string;
  /** What it changes, drawn on the model (see useMarks): the one use its tag is on. */
  marks: Vec3[][];
  /** The variables made from it. */
  to: string[];
  kind: VarKind;
  /** Where its tag goes (its first use that has a spot), null: not on the model. */
  at: Vec3 | null;
  /** Its other uses' spots. */
  others: Vec3[];
  /** The variables it's made from. */
  from: string[];
}

/** One tag per variable. */
export function variableTags(variables: readonly Variable[], features: readonly Feature[], world: AnchorWorld): VarTag[] {
  const uses = usesOf(features);
  const tags: VarTag[] = variables.map((variable) => {
    // Its tag at the use that says most where it acts: a turn's pivot, then a
    // step's value, then a dimension of the shape, then a construction line -
    // where it's the value itself before where it's part of a formula.
    const rank = (varUse: VarUse) => {
      const feature = features.find(otherFeature => otherFeature.id === varUse.feature);
      const part = isDirect(varUse, variable.name) ? 0 : 10;
      if (feature?.type === 'transform') {
        return part;
      }
      if (feature?.type !== 'sketch') {
        return part + 1;
      }
      const constraint = feature.constraints?.find(constraint => constraint.id === varUse.where);

      return part + (feature.entities.find(e => e.id === constraint?.curves?.[0])?.construction ? 3 : 2);
    };
    const ordered = [...(uses.get(variable.name) ?? [])].sort((a, b) => rank(a) - rank(b));
    const spots = ordered.map(varUse => useSpot(varUse, features, world)).filter((point): point is Vec3 => !!point && point.every(Number.isFinite));
    // One thing shown (both sides of an arm the same length: one of them).
    let marks: Vec3[][] = [];
    for (const varUse of ordered) {
      marks = useMarks(varUse, variable.name, features, world).filter(useMark => useMark.length > 1 && useMark.every(point => point.every(Number.isFinite)));
      if (marks.length) {
        break;
      }
    }
    const to = variables.filter(otherVariable => madeFrom(otherVariable.name, variables).includes(variable.name)).map(otherVariable => otherVariable.name);

    return { name: variable.name, marks, to, kind: kindOfVariable(variable.name, variables, uses), at: spots[0] ?? null, others: spots.slice(1), from: madeFrom(variable.name, variables) };
  });
  // One that only other variables are made from (a wall that the hub's size is worked out from) has no place of its
  // own: it goes by the first of those that has one (the tags there fan out), so it can be tapped like the rest.
  for (let pass = 0; pass < tags.length; pass++) {
    let moved = false;
    for (const t of tags) {
      if (t.at) {
        continue;
      }
      const by = t.to.map(name => tags.find(tag => tag.name === name)).find(varTag => varTag?.at);
      if (by?.at) {
        (t.at = by.at), (moved = true);
      }
    }
    if (!moved) {
      break;
    }
  }

  return tags;
}
