// Fill Pattern: a closed shape of a sketch filled with a pattern of curves - lines from edge to edge (straight,
// crossed, zigzag, waves) or small shapes inside it (dots, a honeycomb, squares, diamonds). The pattern's curves
// are curves of the sketch like any other, so the strips and cells they make can be extruded or cut: a texture on
// a model. (Asked for: "a new tool in sketch mode named fill pattern ... different line patterns that you can only
// put in closed shapes that go from edges to edges ... very useful when I want different textures on my models.
// Also I should be able to change the space between lines, or distance between shapes".)

import { arcFrom3, entityCorners, entityPrims, evalPrim, pointInPoly, type Prim } from './curves';
import { crossings, pieceEntity } from './edit';
import { arrangement, type Region } from './regions';
import type { SketchEntity, SketchFill, Vec2 } from '../doc/types';

/** The patterns, in the order they are offered. `lines`: whether it runs edge to edge (else: shapes inside). */
export const FILL_KINDS: { id: SketchFill['kind']; label: string; lines: boolean; sized: boolean }[] = [
  { id: 'lines', label: 'Lines', lines: true, sized: false },
  { id: 'cross', label: 'Crossed lines', lines: true, sized: false },
  { id: 'zigzag', label: 'Zigzag', lines: true, sized: true },
  { id: 'waves', label: 'Waves', lines: true, sized: true },
  { id: 'dots', label: 'Dots', lines: false, sized: true },
  { id: 'hex', label: 'Honeycomb', lines: false, sized: true },
  { id: 'squares', label: 'Squares', lines: false, sized: true },
  { id: 'diamonds', label: 'Diamonds', lines: false, sized: true }
];

/** A fill's curves are named for it: "fp-<fill>-<n>". */
export const FILL_PREFIX = 'fp-';
export const fillOf = (entityId: string): string | null => (entityId.startsWith(FILL_PREFIX) ? entityId.slice(FILL_PREFIX.length, entityId.lastIndexOf('-')) : null);
/** The sketch's own curves: all but the ones fills made. */
export const withoutFills = (entities: SketchEntity[]): SketchEntity[] => entities.filter(e => !e.id.startsWith(FILL_PREFIX));

/** No more curves than this in one fill (a spacing typed a hundred times too small). */
export const FILL_MOST = 2500;

const inRegion = (region: Region, q: Vec2): boolean => pointInPoly(q, region.outer.poly) && !region.holes.some(hole => pointInPoly(q, hole.poly));

/** The closed shape a point is in (the smallest, where shapes are one in another): null on none. */
export function fillRegion(entities: SketchEntity[], at: Vec2): Region | null {
  const regions = arrangement(withoutFills(entities)).regions.filter(region => inRegion(region, at));

  return regions.sort((a, b) => a.area - b.area)[0] ?? null;
}

/**
 * The curves of one fill, for the sketch as it is (its own curves; other fills' are left out). Null: no closed
 * shape there. `tooMany`: the spacing gives more curves than a sketch should hold - none made.
 */
export function fillCurves(entities: SketchEntity[], fill: SketchFill): { curves: SketchEntity[]; tooMany?: boolean } | null {
  const own = withoutFills(entities);
  const region = fillRegion(own, fill.at);
  if (!region) {
    return null;
  }
  const around = new Set(region.curves);
  const edge: Prim[] = own.filter(e => around.has(e.id) && !e.construction).flatMap(entityPrims);
  const kind = FILL_KINDS.find(kindOption => kindOption.id === fill.kind) ?? FILL_KINDS[0];
  const out: SketchEntity[] = [];
  const name = () => `${FILL_PREFIX}${fill.id}-${out.length}`;
  const th = (fill.angle * Math.PI) / 180;
  const direction: Vec2 = [Math.cos(th), Math.sin(th)];
  const normal: Vec2 = [-direction[1], direction[0]];
  // The shape's reach along the pattern's own two ways, and its middle there.
  const along = region.outer.poly.map(point => point[0] * direction[0] + point[1] * direction[1]);
  const across = region.outer.poly.map(point => point[0] * normal[0] + point[1] * normal[1]);
  const [a0, a1, c0, c1] = [Math.min(...along), Math.max(...along), Math.min(...across), Math.max(...across)];
  const mid: Vec2 = [(a0 + a1) / 2, (c0 + c1) / 2];
  const at = (along: number, across: number): Vec2 => [direction[0] * along + normal[0] * across, direction[1] * along + normal[1] * across];
  const reach = Math.hypot(a1 - a0, c1 - c0);
  const step = Math.max(1e-6, Math.abs(fill.spacing));
  const size = Math.max(1e-6, Math.abs(fill.size));

  /** The parts of a curve that are inside the shape, each from edge to edge. */
  const clipped = (prim: Prim): boolean => {
    const ts = [0, ...crossings(prim, edge), 1].filter((t, i, all) => i === 0 || t - all[i - 1] > 1e-7);
    for (let i = 0; i + 1 < ts.length; i++) {
      if (!inRegion(region, evalPrim(prim, (ts[i] + ts[i + 1]) / 2))) {
        continue;
      }
      if (out.length >= FILL_MOST) {
        return false;
      }
      out.push({ ...pieceEntity(prim, ts[i], ts[i + 1]), id: name() } as SketchEntity);
    }

    return true;
  };

  if (kind.lines) {
    // Rows `step` apart, the middle one through the shape's middle; cross: the same again, square to them.
    for (const turn of fill.kind === 'cross' ? [0, 1] : [0]) {
      const [u0, u1, v0, v1, um, vm] = turn ? [c0, c1, -a1, -a0, mid[1], -mid[0]] : [a0, a1, c0, c1, mid[0], mid[1]];
      const place = (along: number, across: number): Vec2 => (turn ? at(-across, along) : at(along, across));
      const pad = reach * 0.01 + 1e-3;
      const rows = Math.ceil((v1 - v0) / step / 2) + 1;
      if (rows * 2 > FILL_MOST) {
        return { curves: [], tooMany: true };
      }
      for (let row = -rows; row <= rows; row++) {
        const offset = vm + row * step;
        // (Zigzag and waves swing `size` either side of their row.)
        const swing = fill.kind === 'zigzag' || fill.kind === 'waves' ? size / 2 : 0;
        if (offset + swing <= v0 || offset - swing >= v1) {
          continue;
        }
        if (fill.kind === 'lines' || fill.kind === 'cross') {
          if (!clipped({ t: 'line', a: place(u0 - pad, offset), b: place(u1 + pad, offset), src: '' })) {
            return { curves: [], tooMany: true };
          }
          continue;
        }
        // A tooth or a wave every `size` along the row, up then down, starting a whole number of them from the middle.
        const first = um - Math.ceil((um - u0 + pad) / size) * size;
        const teeth = Math.ceil((u1 + pad - first) / size);
        if (teeth * rows > FILL_MOST * 4) {
          return { curves: [], tooMany: true };
        }
        for (let j = 0; j < teeth; j++) {
          const up = (Math.round((first - um) / size) + j) % 2 === 0 ? 1 : -1;
          const [x0, x1] = [first + j * size, first + (j + 1) * size];
          let prim: Prim;
          if (fill.kind === 'zigzag') {
            prim = { t: 'line', a: place(x0, offset - (up * size) / 2), b: place(x1, offset + (up * size) / 2), src: '' };
          } else {
            const arc = arcFrom3(place(x0, offset), place((x0 + x1) / 2, offset + up * size * 0.3), place(x1, offset));
            if (!arc) {
              continue;
            }
            prim = { t: 'circle', c: arc.c, r: arc.r, a0: arc.a0, sweep: arc.sweep, src: '' };
          }
          if (!clipped(prim)) {
            return { curves: [], tooMany: true };
          }
        }
      }
    }

    return { curves: out };
  }

  // Shapes: `size` across, `step` between one and the next, in rows - every other row half a step along for dots,
  // the honeycomb and diamonds. Only those wholly inside the shape.
  const pitch = size + step;
  const stagger = fill.kind !== 'squares';
  const rowGap = fill.kind === 'squares' ? pitch : fill.kind === 'diamonds' ? pitch / 2 : (pitch * Math.sqrt(3)) / 2;
  const rows = Math.ceil((c1 - c0) / rowGap / 2) + 1;
  const cols = Math.ceil((a1 - a0) / pitch / 2) + 1;
  if ((2 * rows + 1) * (2 * cols + 1) > FILL_MOST * 6) {
    return { curves: [], tooMany: true };
  }
  for (let row = -rows; row <= rows; row++) {
    for (let column = -cols; column <= cols; column++) {
      const along = mid[0] + column * pitch + (stagger && row % 2 !== 0 ? pitch / 2 : 0);
      const across = mid[1] + row * rowGap;
      const centre = at(along, across);
      let e: SketchEntity;
      let rim: Vec2[];
      if (fill.kind === 'dots') {
        e = { id: '', kind: 'circle', center: centre, radius: size / 2 } as SketchEntity;
        rim = Array.from({ length: 16 }, (_, i) => [centre[0] + (size / 2) * Math.cos((i * Math.PI) / 8), centre[1] + (size / 2) * Math.sin((i * Math.PI) / 8)] as Vec2);
      } else {
        // (Honeycomb: `size` across its flats, a flat towards its neighbours in the row. Squares: `size` a side.
        // Diamonds: `size` from point to point.)
        const [sides, radius, turn] = fill.kind === 'hex' ? [6, size / Math.sqrt(3), th] : fill.kind === 'squares' ? [4, size / Math.SQRT2, th + Math.PI / 4] : [4, size / 2, th];
        const poly = { id: '', kind: 'polygon' as const, center: centre, radius, sides, angle: turn };
        e = poly as SketchEntity;
        const corners = entityCorners(poly as Extract<SketchEntity, { kind: 'polygon' }>);
        rim = corners.flatMap((corner, i) => {
          const q = corners[(i + 1) % corners.length];

          return [corner, [(corner[0] + q[0]) / 2, (corner[1] + q[1]) / 2] as Vec2];
        });
      }
      if (!rim.every(point => inRegion(region, point))) {
        continue;
      }
      // (All its points inside, and its outline crossing nothing: not across a thin neck of the shape.)
      if (entityPrims(e).some(entityPrim => crossings(entityPrim, edge).length)) {
        continue;
      }
      if (out.length >= FILL_MOST) {
        return { curves: [], tooMany: true };
      }
      out.push({ ...e, id: name() });
    }
  }

  return { curves: out };
}

/**
 * The sketch's curves with every fill's made again for the shapes as they are now (a shape changed size: its
 * pattern follows). A fill whose shape is gone keeps the curves it had; curves of a fill that is no more go.
 */
export function refill(entities: SketchEntity[], fills: SketchFill[] | undefined): SketchEntity[] {
  const own = withoutFills(entities);
  if (!fills?.length) {
    return own.length === entities.length ? entities : own;
  }
  const made: SketchEntity[] = [];
  for (const fill of fills) {
    const got = fillCurves(own, fill);
    if (got && !got.tooMany) {
      made.push(...got.curves);
    } else {
      made.push(...entities.filter(e => fillOf(e.id) === fill.id));
    }
  }

  return [...own, ...made];
}
