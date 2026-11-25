// Planar arrangement of sketch curves → selectable regions.
//
// All curves are split where they cross, the pieces form a planar graph, and
// every bounded face of that graph is a region (with holes for anything nested
// inside it). This is what lets overlapping shapes be extruded piece by piece.

import { closestOnPrim, entityPrims, evalPrim, isClosedPrim, pointInPoly, polyArea, polyCentroid, primSegments, samplePrim, type Prim } from './curves';
import type { RegionRef, SketchEntity, Vec2 } from '../doc/types';

export interface Piece {
  prim: number;
  t0: number;
  t1: number;
  n0: number;
  n1: number;
  /** Polyline from node n0 to node n1 (endpoints are the node positions). */
  poly: Vec2[];
}

export interface LoopRef {
  piece: number;
  reversed: boolean;
}

export interface Loop {
  pieces: LoopRef[];
  poly: Vec2[];
}

export interface Region {
  index: number;
  outer: Loop;
  holes: Loop[];
  area: number;
  centroid: Vec2;
  /** The ids of the curves round it (outline and holes), sorted. */
  curves: string[];
  /** For each of those, where along that curve the outline runs (its pieces' middles, averaged). */
  spots: number[];
}

export interface Arrangement {
  prims: Prim[];
  nodes: Vec2[];
  pieces: Piece[];
  regions: Region[];
}

export type { RegionRef } from '../doc/types';

const cache = new Map<string, Arrangement>();

/** Regions of a sketch. Memoised on the entity list, so callers can call freely. */
export function arrangement(entities: SketchEntity[]): Arrangement {
  const key = JSON.stringify(entities);
  const hit = cache.get(key);
  if (hit) {
    return hit;
  }
  const result = compute(entities.filter(e => !e.construction));
  cache.set(key, result);
  if (cache.size > 64) {
    cache.delete(cache.keys().next().value!);
  }

  return result;
}

export function regionRef(region: Region): RegionRef {
  return { c: region.centroid, a: region.area, k: region.curves, s: region.spots };
}

/**
 * The region best matching a stored reference (survives edits that move it a
 * bit). Outlined by the same curves: the closest of those, however far it
 * moved - a sketch driven by variables can move a piece a long way (an arm's
 * round end, 40 mm up when the arm was made longer, was "no longer there").
 */
export function resolveRegion(arr: Arrangement, ref: RegionRef): Region | null {
  const scale = Math.sqrt(Math.max(ref.a, 1e-9));
  const score = (region: Region) => Math.hypot(region.centroid[0] - ref.c[0], region.centroid[1] - ref.c[1]) / scale + Math.abs(Math.log((region.area + 1e-12) / (ref.a + 1e-12)));
  if (ref.k?.length) {
    const key = ref.k.join(',');
    const same = arr.regions.filter(region => region.curves.join(',') === key);
    // Several outlined by the same curves (a circle's half inside a strip and
    // the half outside it): which stretch of those curves, then size, then place.
    if (same.length === 1) {
      return same[0];
    }
    if (same.length > 1) {
      const along = (region: Region) => (ref.s?.length === region.spots.length ? region.spots.reduce((t, spot, i) => t + Math.abs(spot - ref.s![i]), 0) : 0);

      return same.reduce((a, b) => (along(b) * 10 + sizeScore(b, ref) + score(b) * 0.1 < along(a) * 10 + sizeScore(a, ref) + score(a) * 0.1 ? b : a));
    }
  }
  let best: { r: Region; s: number } | null = null;
  for (const region of arr.regions) {
    const regionScore = score(region);
    if (!best || regionScore < best.s) {
      best = { r: region, s: regionScore };
    }
  }

  return best && best.s < 3 ? best.r : null;
}

const sizeScore = (region: Region, ref: RegionRef) => Math.abs(Math.log((region.area + 1e-12) / (ref.a + 1e-12)));

function compute(entities: SketchEntity[]): Arrangement {
  const prims = entities.flatMap(entityPrims);
  const empty: Arrangement = { prims, nodes: [], pieces: [], regions: [] };
  if (!prims.length) {
    return empty;
  }

  // ---- discretise
  const samples = prims.map((prim) => {
    const segmentCount = primSegments(prim);
    const ts = Array.from({ length: segmentCount + 1 }, (_, i) => i / segmentCount);

    return { ts, pts: ts.map(t => evalPrim(prim, t)) };
  });
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const sample of samples) {
    for (const [x, y] of sample.pts) {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  const size = Math.hypot(maxX - minX, maxY - minY) || 1;
  const eps = size * 1e-7;

  // ---- intersections (sweep over segments sorted by min x)
  interface Seg {
    p: number;
    i: number;
    a: Vec2;
    b: Vec2;
    x0: number;
    x1: number;
    y0: number;
    y1: number;
  }
  const segs: Seg[] = [];
  samples.forEach((sample, sampleIndex) => {
    for (let i = 0; i < sample.pts.length - 1; i++) {
      const a = sample.pts[i];
      const b = sample.pts[i + 1];
      segs.push({ p: sampleIndex, i, a, b, x0: Math.min(a[0], b[0]) - eps, x1: Math.max(a[0], b[0]) + eps, y0: Math.min(a[1], b[1]) - eps, y1: Math.max(a[1], b[1]) + eps });
    }
  });
  segs.sort((firstSegment, secondSegment) => firstSegment.x0 - secondSegment.x0);
  const splits: number[][] = prims.map(() => []);
  const tParam = (sampleIndex: number, i: number, fraction: number) => samples[sampleIndex].ts[i] + (samples[sampleIndex].ts[i + 1] - samples[sampleIndex].ts[i]) * fraction;
  for (let i = 0; i < segs.length; i++) {
    const segA = segs[i];
    for (let j = i + 1; j < segs.length && segs[j].x0 <= segA.x1; j++) {
      const segB = segs[j];
      if (segB.y0 > segA.y1 || segB.y1 < segA.y0) {
        continue;
      }
      if (segA.p === segB.p) {
        // A spline crossing itself (a loop drawn by hand that runs past its
        // start, a figure 8) is split there like two curves crossing: it had
        // no region at all. Neighbouring pieces of it always touch, so skip those.
        if (prims[segA.p].t !== 'spline') {
          continue;
        }
        const lastIndex = samples[segA.p].pts.length - 1;
        const gap = Math.abs(segA.i - segB.i);
        if (gap <= 1 || (isClosedPrim(prims[segA.p]) && gap >= lastIndex - 1)) {
          continue;
        }
      }
      // Lines lying on each other (e.g. drawn over a face's edge): each is split
      // where the other one ends, and the doubled pieces merge below.
      const lap = overlap(segA.a, segA.b, segB.a, segB.b, eps);
      if (lap) {
        for (const fractionA of lap[0]) {
          splits[segA.p].push(tParam(segA.p, segA.i, fractionA));
        }
        for (const fractionB of lap[1]) {
          splits[segB.p].push(tParam(segB.p, segB.i, fractionB));
        }
        continue;
      }
      const hit = segHit(segA.a, segA.b, segB.a, segB.b, eps);
      if (!hit) {
        continue;
      }
      let ta = tParam(segA.p, segA.i, hit[0]);
      let tb = tParam(segB.p, segB.i, hit[1]);
      [ta, tb] = refine(prims[segA.p], prims[segB.p], ta, tb);
      splits[segA.p].push(ta);
      splits[segB.p].push(tb);
    }
  }

  // ---- ends that lie on another curve
  // A line drawn up to a circle, its end held on it, meets the circle - but not the straight pieces the circle is
  // looked at as above: its end is on the true round, a hair outside them, and nothing crossed. The shape the line
  // closed was no shape (reported: "Points are coincidents. The area under the circle doesn't fill, unless the
  // circle crosses the bottom line"). So each open curve's ends are looked for on every other curve itself, and
  // that curve is cut where one lies on it.
  const onTol = eps * 50;
  const endBoxes = samples.map((sample) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, step = 0;
    sample.pts.forEach(([x, y], i) => {
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
      if (i) {
        step = Math.max(step, Math.hypot(x - sample.pts[i - 1][0], y - sample.pts[i - 1][1]));
      }
    });
    // (A round curve bulges past its own sample points: by less than one of its pieces is long.)
    const pad = onTol + (sample.pts.length > 2 ? step : 0);

    return { x0: x0 - pad, y0: y0 - pad, x1: x1 + pad, y1: y1 + pad };
  });
  prims.forEach((prim, pi) => {
    if (isClosedPrim(prim)) {
      return;
    }
    for (const end of [evalPrim(prim, 0), evalPrim(prim, 1)]) {
      prims.forEach((q, qi) => {
        if (qi === pi) {
          return;
        }
        const b = endBoxes[qi];
        if (end[0] < b.x0 || end[0] > b.x1 || end[1] < b.y0 || end[1] > b.y1) {
          return;
        }
        const near = closestOnPrim(q, end);
        if (near.d > onTol) {
          return;
        }
        // (At that curve's own end: they meet end to end already.)
        if (!isClosedPrim(q) && (near.t < 1e-9 || near.t > 1 - 1e-9)) {
          return;
        }
        splits[qi].push(near.t);
      });
    }
  });

  // ---- pieces
  const nodes: Vec2[] = [];
  // (Looked up by the cell they're in, and the cells around it: a sketch of
  // hundreds of curves compared every end with every node.)
  const cells = new Map<string, number[]>();
  const nodeOf = (pt: Vec2): number => {
    const tol = eps * 50;
    const cx = Math.floor(pt[0] / tol);
    const cy = Math.floor(pt[1] / tol);
    let best = -1;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const nodeIndex of cells.get(`${cx + dx},${cy + dy}`) ?? []) {
          if (Math.abs(nodes[nodeIndex][0] - pt[0]) < tol && Math.abs(nodes[nodeIndex][1] - pt[1]) < tol && (best < 0 || nodeIndex < best)) {
            best = nodeIndex;
          }
        }
      }
    }
    if (best >= 0) {
      return best;
    }
    nodes.push(pt);
    const key = `${cx},${cy}`;
    const list = cells.get(key);
    if (list) {
      list.push(nodes.length - 1);
    } else {
      cells.set(key, [nodes.length - 1]);
    }

    return nodes.length - 1;
  };
  let pieces: Piece[] = [];
  prims.forEach((prim, pi) => {
    const closed = isClosedPrim(prim);
    let ts = [...splits[pi]].map(t => Math.min(1, Math.max(0, t))).sort((a, b) => a - b);
    if (closed) {
      ts = ts.map(t => (t >= 1 - 1e-9 ? 0 : t)).sort((a, b) => a - b);
      if (ts.length === 0) {
        ts = [0, 0.5];
      } else if (ts.length === 1) {
        ts.push(ts[0] + 0.5 > 1 ? ts[0] - 0.5 : ts[0] + 0.5), ts.sort((a, b) => a - b);
      }
    } else {
      ts.unshift(0);
      ts.push(1);
    }
    const uniq = ts.filter((t, paramIndex) => paramIndex === 0 || t - ts[paramIndex - 1] > 1e-9);
    const bounds: [number, number][] = [];
    for (let paramIndex = 0; paramIndex < uniq.length - 1; paramIndex++) {
      bounds.push([uniq[paramIndex], uniq[paramIndex + 1]]);
    }
    if (closed) {
      bounds.push([uniq[uniq.length - 1], uniq[0] + 1]);
    }
    for (const [t0, t1] of bounds) {
      const a = evalPrim(prim, t0 % 1);
      const b = evalPrim(prim, t1 > 1 ? t1 - 1 : t1);
      const poly = closed && t1 > 1 ? [...samplePrim(prim, t0, 1).slice(0, -1), ...samplePrim(prim, 0, t1 - 1)] : samplePrim(prim, t0, t1);
      if (polyLength(poly) < eps * 10) {
        continue;
      }
      const n0 = nodeOf(a);
      const n1 = nodeOf(b);
      poly[0] = nodes[n0];
      poly[poly.length - 1] = nodes[n1];
      pieces.push({ prim: pi, t0, t1, n0, n1, poly });
    }
  });

  // ---- the same stretch drawn twice counts once
  {
    // (Kept by their two ends: only pieces between the same two nodes are compared.)
    const seen = new Map<string, Vec2[]>();
    pieces = pieces.filter((pc) => {
      const key = pc.n0 < pc.n1 ? `${pc.n0}:${pc.n1}` : `${pc.n1}:${pc.n0}`;
      const mid = pc.poly[Math.floor(pc.poly.length / 2)];
      const midpoint = pc.poly.length > 2 ? mid : [(pc.poly[0][0] + pc.poly[1][0]) / 2, (pc.poly[0][1] + pc.poly[1][1]) / 2] as Vec2;
      const had = seen.get(key);
      if (had?.some(q => Math.hypot(q[0] - midpoint[0], q[1] - midpoint[1]) < eps * 1e3)) {
        return false;
      }
      if (had) {
        had.push(midpoint);
      } else {
        seen.set(key, [midpoint]);
      }

      return true;
    });
  }

  // ---- drop dangling pieces (they can't bound a region)
  for (;;) {
    const deg = new Array(nodes.length).fill(0);
    for (const pc of pieces) {
      deg[pc.n0]++;
      deg[pc.n1]++;
    }
    const keep = pieces.filter(pc => deg[pc.n0] > 1 && deg[pc.n1] > 1);
    if (keep.length === pieces.length) {
      break;
    }
    pieces = keep;
  }
  if (!pieces.length) {
    return { prims, nodes, pieces, regions: [] };
  }

  // ---- half-edge traversal
  const halfEdgeCount = pieces.length * 2;
  const from = (halfEdge: number) => (halfEdge % 2 === 0 ? pieces[halfEdge >> 1].n0 : pieces[halfEdge >> 1].n1);
  const hpoly = (halfEdge: number) => (halfEdge % 2 === 0 ? pieces[halfEdge >> 1].poly : [...pieces[halfEdge >> 1].poly].reverse());
  const angleOf = (halfEdge: number) => {
    const pl = hpoly(halfEdge);
    const a = pl[0];
    const b = pl[1];
    const thirdPoint = pl[Math.min(2, pl.length - 1)];
    const main = Math.atan2(b[1] - a[1], b[0] - a[0]);
    // Tie-break tangent pieces by where they head next.
    const next = Math.atan2(thirdPoint[1] - a[1], thirdPoint[0] - a[0]);

    return main + angleDiff(main, next) * 1e-3;
  };
  const out: number[][] = nodes.map(() => []);
  for (let halfEdge = 0; halfEdge < halfEdgeCount; halfEdge++) {
    out[from(halfEdge)].push(halfEdge);
  }
  const ang = new Float64Array(halfEdgeCount);
  for (let halfEdge = 0; halfEdge < halfEdgeCount; halfEdge++) {
    ang[halfEdge] = angleOf(halfEdge);
  }
  for (const list of out) {
    list.sort((x, y) => ang[x] - ang[y]);
  }
  const next = (halfEdge: number) => {
    const twin = halfEdge ^ 1;
    const list = out[from(twin)];
    const twinIndex = list.indexOf(twin);

    return list[(twinIndex - 1 + list.length) % list.length];
  };
  const seen = new Uint8Array(halfEdgeCount);
  const cycles: { hs: number[]; poly: Vec2[]; area: number }[] = [];
  for (let h0 = 0; h0 < halfEdgeCount; h0++) {
    if (seen[h0]) {
      continue;
    }
    const hs: number[] = [];
    let halfEdge = h0;
    let guard = 0;
    while (!seen[halfEdge] && guard++ < halfEdgeCount + 1) {
      seen[halfEdge] = 1;
      hs.push(halfEdge);
      halfEdge = next(halfEdge);
    }
    const poly: Vec2[] = [];
    for (const x of hs) {
      poly.push(...hpoly(x).slice(0, -1));
    }
    cycles.push({ hs, poly, area: polyArea(poly) });
  }

  // ---- components (union-find over nodes)
  const parent = nodes.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (const pc of pieces) {
    parent[find(pc.n0)] = find(pc.n1);
  }
  const comp = (cycle: { hs: number[] }) => find(from(cycle.hs[0]));

  const minArea = eps * eps * 100;
  const faces = cycles.filter(cycle => cycle.area > minArea);
  const outers = cycles.filter(cycle => cycle.area <= minArea);
  const holes = new Map<(typeof faces)[number], typeof outers>();
  // (Each face's box first: a plate with hundreds of holes tested every hole's
  // outline against every other hole's, point by point.)
  const boxes = faces.map((face) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of face.poly) {
      if (x < x0) {
        x0 = x;
      }
      if (x > x1) {
        x1 = x;
      }
      if (y < y0) {
        y0 = y;
      }
      if (y > y1) {
        y1 = y;
      }
    }

    return [x0, y0, x1, y1];
  });
  const compOf = faces.map(comp);
  for (const outer of outers) {
    const firstPoint = outer.poly[0];
    const co = comp(outer);
    let best: (typeof faces)[number] | null = null;
    for (let faceIndex = 0; faceIndex < faces.length; faceIndex++) {
      const face = faces[faceIndex];
      const b = boxes[faceIndex];
      if (firstPoint[0] < b[0] || firstPoint[0] > b[2] || firstPoint[1] < b[1] || firstPoint[1] > b[3]) {
        continue;
      }
      if (best && face.area >= best.area) {
        continue;
      }
      if (compOf[faceIndex] === co) {
        continue;
      }
      if (!pointInPoly(firstPoint, face.poly)) {
        continue;
      }
      best = face;
    }
    if (!best) {
      continue;
    }
    const list = holes.get(best);
    if (list) {
      list.push(outer);
    } else {
      holes.set(best, [outer]);
    }
  }

  const toLoop = (cycle: { hs: number[]; poly: Vec2[] }): Loop => ({
    pieces: cycle.hs.map(halfEdge => ({ piece: halfEdge >> 1, reversed: halfEdge % 2 === 1 })),
    poly: cycle.poly
  });
  // Each primitive's place among its curve's own (a rectangle's four sides: 0-3).
  const seenOf = new Map<string, number>();
  const primOrdinal = prims.map((prim) => {
    const sourceId = prim.src ?? '';
    const i = seenOf.get(sourceId) ?? 0;
    seenOf.set(sourceId, i + 1);

    return i;
  });
  const regions: Region[] = faces.map((face, index) => {
    const hs = holes.get(face) ?? [];
    const holeArea = hs.reduce((total, hole) => total + Math.abs(hole.area), 0);
    const area = face.area - holeArea;
    // Area-weighted centroid of the face minus its holes.
    const c0 = polyCentroid(face.poly);
    let cx = c0[0] * face.area;
    let cy = c0[1] * face.area;
    for (const hole of hs) {
      const ch = polyCentroid(hole.poly);
      cx -= ch[0] * Math.abs(hole.area);
      cy -= ch[1] * Math.abs(hole.area);
    }
    const outer = toLoop(face);
    const inner = hs.map(toLoop);
    const loopPieces = [outer, ...inner].flatMap(loop => loop.pieces.map(piece => pieces[piece.piece]));
    const curves = [...new Set(loopPieces.map(loopPiece => prims[loopPiece.prim].src ?? ''))].filter(Boolean).sort();
    // Where along each curve: which of its parts (a rectangle's side, …) plus how far along that part.
    const spots = curves.map((id) => {
      const ps = loopPieces.filter(loopPiece => prims[loopPiece.prim].src === id);

      return ps.reduce((t, piece) => t + primOrdinal[piece.prim] + (piece.t0 + piece.t1) / 2, 0) / ps.length;
    });

    return { index, outer, holes: inner, area, centroid: [cx / area, cy / area], curves, spots };
  });

  return { prims, nodes, pieces, regions };
}

/**
 * Two collinear, overlapping segments → where (as fractions along each) the
 * other one's ends fall inside it. Null when they don't lie on each other.
 */
function overlap(a: Vec2, b: Vec2, otherStart: Vec2, otherEnd: Vec2, eps: number): [number[], number[]] | null {
  const rx = b[0] - a[0];
  const ry = b[1] - a[1];
  const sx = otherEnd[0] - otherStart[0];
  const sy = otherEnd[1] - otherStart[1];
  const lu = Math.hypot(rx, ry);
  const lv = Math.hypot(sx, sy);
  if (lu < eps || lv < eps) {
    return null;
  }
  if (Math.abs(rx * sy - ry * sx) > lu * lv * 1e-6) {
    return null;
  }
  // Both ends of the other segment on the line through ab?
  const off = (point: Vec2) => Math.abs((point[0] - a[0]) * ry - (point[1] - a[1]) * rx) / lu;
  if (off(otherStart) > eps * 10 || off(otherEnd) > eps * 10) {
    return null;
  }
  const along = (point: Vec2, origin: Vec2, x: number, y: number, length: number) => ((point[0] - origin[0]) * x + (point[1] - origin[1]) * y) / (length * length);
  const inside = (fraction: number, length: number) => fraction > (eps * 10) / length && fraction < 1 - (eps * 10) / length;
  const ua = [along(otherStart, a, rx, ry, lu), along(otherEnd, a, rx, ry, lu)].filter(fraction => inside(fraction, lu));
  const vb = [along(a, otherStart, sx, sy, lv), along(b, otherStart, sx, sy, lv)].filter(fraction => inside(fraction, lv));
  const lo = Math.min(along(otherStart, a, rx, ry, lu), along(otherEnd, a, rx, ry, lu));
  const hi = Math.max(along(otherStart, a, rx, ry, lu), along(otherEnd, a, rx, ry, lu));
  if (hi < 0 || lo > 1) {
    return null;
  }

  return [ua, vb];
}

function segHit(a: Vec2, b: Vec2, otherStart: Vec2, otherEnd: Vec2, eps: number): [number, number] | null {
  const rx = b[0] - a[0];
  const ry = b[1] - a[1];
  const sx = otherEnd[0] - otherStart[0];
  const sy = otherEnd[1] - otherStart[1];
  const den = rx * sy - ry * sx;
  if (Math.abs(den) < 1e-18) {
    return null;
  } // parallel / collinear overlaps ignored
  const qx = otherStart[0] - a[0];
  const qy = otherStart[1] - a[1];
  const fractionA = (qx * sy - qy * sx) / den;
  const fractionB = (qx * ry - qy * rx) / den;
  const lu = Math.hypot(rx, ry) || 1;
  const lv = Math.hypot(sx, sy) || 1;
  const tu = eps / lu;
  const tv = eps / lv;
  if (fractionA < -tu || fractionA > 1 + tu || fractionB < -tv || fractionB > 1 + tv) {
    return null;
  }

  return [Math.min(1, Math.max(0, fractionA)), Math.min(1, Math.max(0, fractionB))];
}

/** Newton-refine an intersection on the exact curves. */
function refine(prim: Prim, q: Prim, t: number, otherParam: number): [number, number] {
  if (prim.t === 'spline' && q.t === 'spline') {
    return [t, otherParam];
  }
  const step = 1e-7;
  for (let iteration = 0; iteration < 8; iteration++) {
    const pointOnFirst = evalPrim(prim, t);
    const pointOnSecond = evalPrim(q, otherParam);
    const fx = pointOnFirst[0] - pointOnSecond[0];
    const fy = pointOnFirst[1] - pointOnSecond[1];
    if (Math.abs(fx) + Math.abs(fy) < 1e-12) {
      break;
    }
    const Pt = evalPrim(prim, Math.min(1, t + step));
    const Qs = evalPrim(q, Math.min(1, otherParam + step));
    const a = (Pt[0] - pointOnFirst[0]) / step;
    const dyDt = (Pt[1] - pointOnFirst[1]) / step;
    const b = -(Qs[0] - pointOnSecond[0]) / step;
    const dyDs = -(Qs[1] - pointOnSecond[1]) / step;
    const det = a * dyDs - b * dyDt;
    if (Math.abs(det) < 1e-14) {
      break;
    }
    const dt = (dyDs * fx - b * fy) / det;
    const ds = (-dyDt * fx + a * fy) / det;
    t = Math.min(1, Math.max(0, t - dt));
    otherParam = Math.min(1, Math.max(0, otherParam - ds));
  }

  return [t, otherParam];
}

function polyLength(points: Vec2[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
  }

  return total;
}

function angleDiff(a: number, b: number): number {
  let difference = b - a;
  while (difference > Math.PI) {
    difference -= Math.PI * 2;
  }
  while (difference < -Math.PI) {
    difference += Math.PI * 2;
  }

  return difference;
}

/** Parameter + distance of the closest point on any primitive of an entity. */
export function closestOnEntity(e: SketchEntity, q: Vec2): { t: number; d: number; pt: Vec2; prim: number } {
  const prims = entityPrims(e);
  let best = { t: 0, d: Infinity, pt: q, prim: 0 };
  prims.forEach((prim, i) => {
    const closest = closestOnPrim(prim, q);
    if (closest.d < best.d) {
      best = { ...closest, prim: i };
    }
  });

  return best;
}

function insidePoly(polygon: Vec2[], q: Vec2): boolean {
  let isInside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    if (polygon[i][1] > q[1] !== polygon[j][1] > q[1] && q[0] < ((polygon[j][0] - polygon[i][0]) * (q[1] - polygon[i][1])) / (polygon[j][1] - polygon[i][1]) + polygon[i][0]) {
      isInside = !isInside;
    }
  }

  return isInside;
}

/** A point truly inside a region (its centroid may be in a hole: a ring, a "0"). */
export function pointInRegion(region: Region): Vec2 {
  const ok = (q: Vec2) => insidePoly(region.outer.poly, q) && !region.holes.some(hole => insidePoly(hole.poly, q));
  if (ok(region.centroid)) {
    return region.centroid;
  }
  const poly = region.outer.poly;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const edgeLength = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const midpoint: Vec2 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    for (const nudge of [1e-4 * edgeLength, -1e-4 * edgeLength, 1e-3, -1e-3]) {
      const q: Vec2 = [midpoint[0] - ((b[1] - a[1]) / edgeLength) * nudge, midpoint[1] + ((b[0] - a[0]) / edgeLength) * nudge];
      if (ok(q)) {
        return q;
      }
    }
  }

  return region.centroid;
}

/**
 * The regions that are material when the sketch is read the usual way: inside
 * an even number of other regions' outlines (a "0" is its ring; the island in
 * its middle is the hole, not a part). Every shape of a scale or a lettering.
 */
export function materialRegions(arr: Arrangement): Region[] {
  return arr.regions.filter((region) => {
    const q = pointInRegion(region);
    let depth = 0;
    for (const otherRegion of arr.regions) {
      if (otherRegion !== region && insidePoly(otherRegion.outer.poly, q)) {
        depth++;
      }
    }

    return depth % 2 === 0;
  });
}

/**
 * "All shapes" in a sketch on a face: the pieces of the whole sketch (the
 * face's outline included, so the regions match what can be tapped) that lie
 * inside what was drawn - by nesting among the drawn shapes alone. With the
 * outline counted, windows drawn on a wall came out as holes in the wall, and
 * the cut took the wall instead of the windows.
 */
export function drawnRegions(all: Arrangement, drawn: Arrangement): Region[] {
  const solid = materialRegions(drawn);

  return all.regions.filter((region) => {
    const q = pointInRegion(region);

    return solid.some(solidRegion => insidePoly(solidRegion.outer.poly, q) && !solidRegion.holes.some(hole => insidePoly(hole.poly, q)));
  });
}
