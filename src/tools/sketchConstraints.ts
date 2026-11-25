// Sketch constraint UI: the constraint button column, building constraints from
// the selection, and the badges/dimension labels drawn next to the geometry.

import { applicable, pointOf, pointsOf, sizeOf } from '../sketch/constraints';
import { arcFrom3 } from '../sketch/curves';
import { uid } from '../sketch/edit';
import { el } from '../ui/ui';
import { fmtLen, trim } from '../units';
import { sketchToWorld } from '../view/viewport';
import type { Viewport } from '../view/viewport';
import type { ConstraintType, PlaneDef, PointRef, SketchConstraint, SketchEntity, Vec2 } from '../doc/types';

export const CONSTRAINT_BUTTONS: { type: ConstraintType | 'hv'; label: string; glyph: string; key: string }[] = [
  // Lock / unlock first: the one reached for most.
  { type: 'fix', label: 'Lock', glyph: '🔒', key: 'L' },
  { type: 'parallel', label: 'Parallel', glyph: '∥', key: 'A' },
  { type: 'perpendicular', label: 'Perpendicular', glyph: '⟂', key: 'P' },
  { type: 'tangent', label: 'Tangent', glyph: 'T', key: 'T' },
  { type: 'coincident', label: 'Coincident', glyph: '●', key: 'N' },
  { type: 'midpoint', label: 'Midpoint', glyph: 'M', key: 'M' },
  { type: 'concentric', label: 'Concentric', glyph: '◎', key: 'C' },
  { type: 'hv', label: 'Horizontal/Vertical', glyph: 'H/V', key: 'V' },
  { type: 'equal', label: 'Equal', glyph: '=', key: 'E' },
  { type: 'symmetric', label: 'Symmetry', glyph: '⇋', key: 'S' },
  { type: 'distance', label: 'Distance', glyph: '↔', key: 'D' }
];

const GLYPH: Partial<Record<ConstraintType, string>> = {
  coincident: '●',
  horizontal: 'H',
  vertical: 'V',
  parallel: '∥',
  perpendicular: '⟂',
  equal: '=',
  tangent: 'T',
  concentric: '◎',
  midpoint: 'M',
  symmetric: '⇋',
  fix: '🔒'
};

/** The small sign a constraint goes by (a size: its arrow). */
export function constraintGlyph(c: SketchConstraint): string {
  if (c.type === 'dim' || c.type === 'distance') {
    return c.prop === 'angle' ? '∠' : '↔';
  }
  if (c.type === 'pattern' || c.type === 'follow') {
    return '⛓';
  }

  return GLYPH[c.type] ?? '•';
}

/** Constraints for a button press, from the current selection (empty if it doesn't fit). */
export function buildConstraints(type: ConstraintType | 'hv', pts: PointRef[], curves: SketchEntity[], all?: SketchEntity[]): SketchConstraint[] {
  if (type === 'hv') {
    if (curves.length === 1 && curves[0].kind === 'line' && !pts.length) {
      const firstCurve = curves[0];
      const horiz = Math.abs(firstCurve.b[0] - firstCurve.a[0]) >= Math.abs(firstCurve.b[1] - firstCurve.a[1]);

      return [{ id: uid(), type: horiz ? 'horizontal' : 'vertical', curves: [firstCurve.id] }];
    }
    // Two points (a circle's centre and a corner, two ends): level with each other, or one above the other -
    // whichever they are nearer to. (The solver had it; no button gave it.)
    if (pts.length === 2 && !curves.length && all) {
      const [a, b] = pts.map((point) => {
        const e = all.find(sketchEntity => sketchEntity.id === point.e);

        return e ? pointOf(e, point.p) : null;
      });
      if (a && b && Math.hypot(a[0] - b[0], a[1] - b[1]) > 1e-9) {
        return [{ id: uid(), type: Math.abs(b[0] - a[0]) >= Math.abs(b[1] - a[1]) ? 'horizontal' : 'vertical', pts }];
      }
    }

    return [];
  }
  if (!applicable(type, pts, curves)) {
    return [];
  }
  const ids = curves.map(curve => curve.id);
  switch (type) {
    case 'coincident':
      return pts.length === 2 ? [{ id: uid(), type, pts }] : [{ id: uid(), type, pts, curves: ids }];
    case 'midpoint':
    case 'symmetric':
      return [{ id: uid(), type, pts, curves: ids }];
    case 'distance': {
      const distance = distanceOf(pts, curves);

      return distance === null ? [] : [{ id: uid(), type, pts, curves: ids.length ? ids : undefined, value: distance }];
    }
    case 'fix': {
      // Locking a curve holds all of its points (and a circle's size).
      const all = [...pts, ...curves.flatMap(e => pointsOf(e).map(q => ({ e: e.id, p: q.p })))];
      const sizes = curves.flatMap((e): SketchConstraint[] => (e.kind === 'circle' ? [{ id: uid(), type: 'dim', curves: [e.id], prop: 'diameter', value: 2 * e.radius, held: true }] : []));

      return [...all.map(pointRef => ({ id: uid(), type, pts: [pointRef] })), ...sizes];
    }
    default:
      return [{ id: uid(), type, curves: ids }];
  }
}

/** Current distance between two points, or a point and a line. */
export function distanceOf(pts: PointRef[], curves: SketchEntity[], all: SketchEntity[] = curves): number | null {
  const pointAt = (pointRef: PointRef) => {
    const e = all.find(sketchEntity => sketchEntity.id === pointRef.e);

    return e ? pointOf(e, pointRef.p) : null;
  };
  if (pts.length === 2 && !curves.length) {
    const [a, b] = pts.map(pointAt);

    return a && b ? Math.hypot(a[0] - b[0], a[1] - b[1]) : null;
  }
  const firstCurve = curves[0];
  const point = pts[0] && pointAt(pts[0]);
  if (pts.length === 1 && curves.length === 1 && firstCurve.kind === 'line' && point) {
    const dx = firstCurve.b[0] - firstCurve.a[0];
    const dy = firstCurve.b[1] - firstCurve.a[1];

    return Math.abs((point[0] - firstCurve.a[0]) * dy - (point[1] - firstCurve.a[1]) * dx) / (Math.hypot(dx, dy) || 1);
  }
  // Two lines that run the same way (within a degree): how far apart they are - the second's middle from the first.
  // (Asked for: a distance between two lines. Two lines that cross have an angle between them, not a distance.)
  const curve = curves[1];
  if (!pts.length && curves.length === 2 && firstCurve.kind === 'line' && curve.kind === 'line') {
    const [dx, dy, ex, ey] = [firstCurve.b[0] - firstCurve.a[0], firstCurve.b[1] - firstCurve.a[1], curve.b[0] - curve.a[0], curve.b[1] - curve.a[1]];
    const [lengthA, lengthB] = [Math.hypot(dx, dy), Math.hypot(ex, ey)];
    if (!(lengthA > 1e-12) || !(lengthB > 1e-12) || Math.abs(dx * ey - dy * ex) / (lengthA * lengthB) > Math.sin(Math.PI / 180)) {
      return null;
    }
    const mid = [(curve.a[0] + curve.b[0]) / 2, (curve.a[1] + curve.b[1]) / 2];

    return Math.abs((mid[0] - firstCurve.a[0]) * dy - (mid[1] - firstCurve.a[1]) * dx) / lengthA;
  }

  return null;
}

/**
 * Constraints already on the selection for a button: the column shows them
 * as on, and tapping the button removes them.
 */
export function existingConstraints(type: ConstraintType | 'hv', constraints: SketchConstraint[], pts: PointRef[], curves: SketchEntity[]): SketchConstraint[] {
  const ids = new Set(curves.map(e => e.id));
  const ptKeys = new Set(pts.map(point => `${point.e}:${point.p}`));
  const types: string[] = type === 'hv' ? ['horizontal', 'vertical'] : [type];
  // A point counts as selected when it is, or when its curve is.
  const ptIn = (pointRef: PointRef) => ptKeys.has(`${pointRef.e}:${pointRef.p}`) || ids.has(pointRef.e);

  return constraints.filter((constraint) => {
    // (The size Lock put on a circle goes with its lock; it was left behind, and the circle unlocked kept its size.)
    if (type === 'fix' && constraint.type === 'dim' && constraint.held && constraint.curves?.length === 1 && ids.has(constraint.curves[0])) {
      return true;
    }
    if (!types.includes(constraint.type)) {
      return false;
    }
    const cv = constraint.curves ?? [];
    const cp = constraint.pts ?? [];
    if (!cv.length && !cp.length) {
      return false;
    }
    if (type === 'fix') {
      return cp.every(ptIn);
    }

    // Every curve and point it involves is in the selection.
    return cv.every(id => ids.has(id)) && cp.every(ptIn) && (cv.length + cp.length > 1 || ids.size + pts.length === 1);
  });
}

/** Upsert a driving dimension on one entity (length / radius / w / h / …). */
export function setDim(list: SketchConstraint[], entity: string, prop: string, value: number, expr?: string | null): SketchConstraint[] {
  const i = list.findIndex(sketchConstraint => sketchConstraint.type === 'dim' && sketchConstraint.curves?.[0] === entity && sketchConstraint.curves.length === 1 && sketchConstraint.prop === prop);
  const constraint: SketchConstraint = { id: i >= 0 ? list[i].id : uid(), type: 'dim', curves: [entity], prop, value, ...(expr ? { expr } : {}) };

  return i >= 0 ? list.map((sketchConstraint, index) => (index === i ? constraint : sketchConstraint)) : [...list, constraint];
}

/** The dimension constraint on an entity's property, if any. */
export function dimOf(list: SketchConstraint[], entity: string, prop: string): SketchConstraint | undefined {
  return list.find(sketchConstraint => sketchConstraint.type === 'dim' && sketchConstraint.curves?.[0] === entity && sketchConstraint.curves.length === 1 && sketchConstraint.prop === prop);
}

/** Badges + dimension labels for the constraints of the sketch being edited. */
export class ConstraintGlyphs {
  private host = el('div', 'cglyphs');
  private chips = new Map<string, HTMLElement>();
  private hook = () => this.layout();
  /** Each mark: where on the drawing, which way is "outside" there (sketch units), and how far out (px). */
  private items: { c: SketchConstraint; at: Vec2; dir: Vec2; dist: number }[] = [];
  private plane: PlaneDef | null = null;
  selected: string | null = null;

  constructor(
    private view: Viewport,
    private onClick: (id: string) => void
  ) {
    document.body.append(this.host);
    view.frameHooks.add(this.hook);
  }

  set(plane: PlaneDef, entities: SketchEntity[], constraints: SketchConstraint[]): void {
    this.plane = plane;
    const get = (id: string) => entities.find(e => e.id === id);
    const mid = (e: SketchEntity): Vec2 | null => {
      if (e.kind === 'line') {
        return [(e.a[0] + e.b[0]) / 2, (e.a[1] + e.b[1]) / 2];
      }
      if (e.kind === 'arc') {
        return e.m;
      }
      if (e.kind === 'circle' || e.kind === 'ellipse' || e.kind === 'rect' || e.kind === 'polygon') {
        return e.center;
      }

      return e.points[0] ?? null;
    };
    this.items = [];
    const inside = shapeCentres(entities);
    const norm = (vector: Vec2): Vec2 | null => {
      const length = Math.hypot(vector[0], vector[1]);

      return length > 1e-9 ? [vector[0] / length, vector[1] / length] : null;
    };
    // Away from the middle of the shape it belongs to (off the blue fill of a closed one).
    const away = (e: SketchEntity, point: Vec2, fallback: Vec2): Vec2 => {
      const center = inside.get(e.id);
      const direction = center && norm([point[0] - center[0], point[1] - center[1]]);

      return direction ?? fallback;
    };
    // Several badges at one spot are fanned out (further out) so they stay readable.
    const counts = new Map<string, number>();
    for (const constraint of constraints) {
      // (A pattern's copies have no badge each: there'd be one on every copy.)
      if (constraint.type === 'pattern' || constraint.type === 'follow') {
        continue;
      }
      // A mark only while everything it ties together is still drawn.
      if (![...(constraint.pts ?? []).map(pointRef => pointRef.e), ...(constraint.curves ?? [])].every(id => get(id))) {
        continue;
      }
      let at: Vec2 | null = null;
      let dir: Vec2 = [Math.SQRT1_2, -Math.SQRT1_2];
      if (constraint.pts?.length) {
        const e = get(constraint.pts[0].e);
        at = e ? pointOf(e, constraint.pts[0].p) : null;
        if (e && at) {
          dir = away(e, at, dir);
        }
      } else if (constraint.curves?.length) {
        const e = get(constraint.curves[0]);
        at = e ? mid(e) : null;
        if (e && at) {
          if (e.kind === 'line') {
            // Square off the line, on the side away from its shape's middle.
            const normal = norm([-(e.b[1] - e.a[1]), e.b[0] - e.a[0]]) ?? dir;
            const c0 = inside.get(e.id);
            const flip = c0 && (at[0] - c0[0]) * normal[0] + (at[1] - c0[1]) * normal[1] < 0;
            dir = flip ? [-normal[0], -normal[1]] : normal;
          } else if (e.kind === 'arc') {
            const ac = arcFrom3(e.a, e.m, e.b)?.c;
            const out = ac ? norm([e.m[0] - ac[0], e.m[1] - ac[1]]) : null;
            dir = away(e, at, out ?? dir);
          } else if (e.kind === 'circle' || e.kind === 'polygon') {
            // Closed round shapes: on the rim at the top right, outside it.
            dir = [Math.SQRT1_2, Math.SQRT1_2];
            at = [e.center[0] + e.radius * dir[0], e.center[1] + e.radius * dir[1]];
          } else if (e.kind === 'ellipse' || e.kind === 'rect') {
            const [hx, hy] = e.kind === 'ellipse' ? [e.rx * Math.SQRT1_2, e.ry * Math.SQRT1_2] : [e.w / 2, e.h / 2];
            const cs = Math.cos(e.rotation);
            const sn = Math.sin(e.rotation);
            at = [e.center[0] + hx * cs - hy * sn, e.center[1] + hx * sn + hy * cs];
            dir = norm([at[0] - e.center[0], at[1] - e.center[1]]) ?? dir;
          } else {
            dir = away(e, at, dir);
          }
        }
        if (e && constraint.type === 'dim' && (constraint.prop === 'radius' || constraint.prop === 'diameter')) {
          const radius = e.kind === 'circle' ? e.radius : e.kind === 'arc' ? (arcFrom3(e.a, e.m, e.b)?.r ?? 0) : e.kind === 'polygon' ? e.radius : 0;
          const ctr = e.kind === 'arc' ? (arcFrom3(e.a, e.m, e.b)?.c ?? at!) : at!;
          at = [ctr[0] + radius * 0.707, ctr[1] + radius * 0.707];
          dir = [Math.SQRT1_2, Math.SQRT1_2];
        }
        if (e && constraint.type === 'dim' && e.kind === 'rect' && (constraint.prop === 'w' || constraint.prop === 'h')) {
          const cs = Math.cos(e.rotation);
          const sn = Math.sin(e.rotation);
          const off = constraint.prop === 'w' ? [0, -e.h / 2] : [e.w / 2, 0];
          at = [e.center[0] + off[0] * cs - off[1] * sn, e.center[1] + off[0] * sn + off[1] * cs];
          dir = norm([at[0] - e.center[0], at[1] - e.center[1]]) ?? dir;
        }
      }
      if (!at) {
        continue;
      }
      const key = `${at[0].toFixed(4)},${at[1].toFixed(4)}`;
      const count = counts.get(key) ?? 0;
      counts.set(key, count + 1);
      const isDim = constraint.type === 'dim' || constraint.type === 'distance';
      this.items.push({ c: constraint, at, dir, dist: isDim ? 18 + count * 20 : 14 + count * 18 });
    }
    // Sync chips.
    const live = new Set(this.items.map(i => i.c.id));
    for (const [id, chip] of this.chips) {
      if (!live.has(id)) {
        (chip.remove(), this.chips.delete(id));
      }
    }
    for (const { c } of this.items) {
      let chip = this.chips.get(c.id);
      if (!chip) {
        chip = el('button', 'cglyph');
        chip.addEventListener('pointerdown', e => e.stopPropagation());
        chip.addEventListener('click', e => (e.stopPropagation(), this.onClick(c.id)));
        this.host.append(chip);
        this.chips.set(c.id, chip);
      }
      chip.className = `cglyph${c.type === 'dim' || c.type === 'distance' ? ' dim' : ''}${c.id === this.selected ? ' sel' : ''}${c.expr ? ' expr' : ''}`;
      chip.textContent = label(c, get);
      // Each kind its own colour (recognised at a glance).
      chip.dataset.type = c.type;
      chip.title = c.type === 'dim' ? `${c.prop} dimension${c.expr ? ` = ${c.expr}` : ''} (click to edit)` : `${c.type} (click to select)`;
    }
    this.layout();
  }

  /**
   * The constraint mark (not a dimension) at a screen point, if any. Marks
   * don't catch taps themselves - the drawing under them always comes first;
   * the sketch asks here when a tap found nothing else.
   */
  hitAt(x: number, y: number): string | null {
    if (this.host.hidden) {
      return null;
    }
    for (const [id, chip] of this.chips) {
      if (chip.hidden || chip.classList.contains('dim')) {
        continue;
      }
      const rect = chip.getBoundingClientRect();
      if (x > rect.left - 4 && x < rect.right + 4 && y > rect.top - 4 && y < rect.bottom + 4) {
        return id;
      }
    }

    return null;
  }

  /** Show or hide all the badges (the "Show constraints" switch). */
  setVisible(on: boolean): void {
    this.host.hidden = !on;
  }

  /**
   * Tapped to select (in the Select tool), or let through to the drawing under
   * them: a rectangle's width label under its edge took Mirror's tap on the
   * circle there, and the shapes picked so far were let go.
   */
  setTappable(on: boolean): void {
    this.host.classList.toggle('passive', !on);
  }

  private layout(): void {
    if (!this.plane) {
      return;
    }
    for (const it of this.items) {
      const chip = this.chips.get(it.c.id);
      if (!chip) {
        continue;
      }
      const screenPoint = this.view.toScreen(sketchToWorld(this.plane, it.at));
      chip.hidden = !screenPoint;
      if (!screenPoint) {
        continue;
      }
      // "Outside" on screen: the sketch direction as the view shows it (any turn, any zoom).
      const s2 = this.view.toScreen(sketchToWorld(this.plane, [it.at[0] + it.dir[0] * 1e-3, it.at[1] + it.dir[1] * 1e-3]));
      let dx = s2 ? s2[0] - screenPoint[0] : 1;
      let dy = s2 ? s2[1] - screenPoint[1] : 1;
      const length = Math.hypot(dx, dy);
      // Looking along the sketch (edge-on): no way out on screen - right and below.
      [dx, dy] = length > 1e-9 ? [dx / length, dy / length] : [Math.SQRT1_2, Math.SQRT1_2];
      // A mark is ~16 px across: its centre goes far enough out that all of it clears the line.
      const distance = it.dist + 4;
      chip.style.transform = `translate(${Math.round(screenPoint[0] + dx * distance)}px, ${Math.round(screenPoint[1] + dy * distance)}px) translate(-50%, -50%)`;
    }
  }

  dispose(): void {
    this.view.frameHooks.delete(this.hook);
    this.host.remove();
  }
}

function label(sketchConstraint: SketchConstraint, get: (id: string) => SketchEntity | undefined): string {
  if (sketchConstraint.type === 'dim') {
    const e = sketchConstraint.curves?.[0] ? get(sketchConstraint.curves[0]) : undefined;
    const value = sketchConstraint.value ?? (e && sketchConstraint.prop ? sizeOf(e, sketchConstraint.prop) : 0) ?? 0;
    const name = sketchConstraint.expr && /[a-z_]/i.test(sketchConstraint.expr) ? `${sketchConstraint.expr} = ` : '';
    if (sketchConstraint.prop === 'angle') {
      return `${name}${trim(value, 2)}°`;
    }
    if (sketchConstraint.prop === 'radius') {
      return `${name}R ${fmtLen(value)}`;
    }
    if (sketchConstraint.prop === 'diameter') {
      return `${name}⌀ ${fmtLen(value)}`;
    }

    return `${name}${fmtLen(value)}`;
  }
  if (sketchConstraint.type === 'distance') {
    return fmtLen(sketchConstraint.value ?? 0);
  }

  return GLYPH[sketchConstraint.type] ?? '?';
}

/**
 * The middle of the shape each curve belongs to: curves joined end to end
 * make one shape (a rectangle of four lines, a slot of lines and arcs); a
 * circle, ellipse, rectangle or polygon is its own. Marks go away from it.
 */
function shapeCentres(entities: SketchEntity[]): Map<string, Vec2> {
  const parent = entities.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const ends = (e: SketchEntity): Vec2[] => {
    if (e.kind === 'line' || e.kind === 'arc') {
      return [e.a, e.b];
    }
    if ((e.kind === 'spline' || e.kind === 'polyline') && !e.closed && e.points.length) {
      return [e.points[0], e.points[e.points.length - 1]];
    }

    return [];
  };
  // Ends at the same spot (joined): one shape. (Hashed, so big sketches stay quick.)
  const at = new Map<string, number>();
  entities.forEach((e, i) => {
    for (const end of ends(e)) {
      const key = `${end[0].toFixed(5)},${end[1].toFixed(5)}`;
      const j = at.get(key);
      if (j === undefined) {
        at.set(key, i);
      } else {
        parent[find(i)] = find(j);
      }
    }
  });
  const samples = (e: SketchEntity): Vec2[] => {
    if (e.kind === 'line') {
      return [e.a, e.b];
    }
    if (e.kind === 'arc') {
      return [e.a, e.m, e.b];
    }
    if (e.kind === 'spline' || e.kind === 'polyline') {
      return e.points;
    }

    return [e.center];
  };
  const sum = new Map<number, [number, number, number]>();
  entities.forEach((e, i) => {
    const root = find(i);
    const total = sum.get(root) ?? [0, 0, 0];
    for (const sample of samples(e)) {
      (total[0] += sample[0]), (total[1] += sample[1]), (total[2] += 1);
    }
    sum.set(root, total);
  });
  const out = new Map<string, Vec2>();
  entities.forEach((e, i) => {
    const total = sum.get(find(i))!;
    if (total[2]) {
      out.set(e.id, [total[0] / total[2], total[1] / total[2]]);
    }
  });

  return out;
}
