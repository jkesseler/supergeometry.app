// A loft held by guide curves (rails) along its sides and by connection
// points (which point of each profile joins which).
//
// OpenCascade's loft takes no rails, so the profiles are resampled here on one
// shared parametrisation: each guide's or connection's point on a profile is at
// the same parameter on every profile, so the loft joins them. Between profiles
// that guides run along, extra sections are added: the two profiles blended,
// then moved so each guide's point lands on its guide - the sides follow the
// guides. Profiles become B-splines (within a ten-thousandth of their size).
import { cast, getOC, isShape3D, type Shape3D, type Wire } from 'replicad';
import { add, cross, dot, len, norm, scale, sub } from '../geom';
import type { Vec3 } from '../doc/types';

/** Dense points along a curve, with how far along each is (0…1 of its length). */
interface Curve {
  pts: Vec3[];
  s: number[];
  closed: boolean;
}

function sample(wire: Wire, count = 720): Curve {
  const oc = getOC();
  const ad = new oc.BRepAdaptor_CompCurve(wire.wrapped, true);
  const pts: Vec3[] = [];
  try {
    const u0 = ad.FirstParameter();
    const u1 = ad.LastParameter();
    for (let i = 0; i <= count; i++) {
      const curvePoint = ad.Value(u0 + ((u1 - u0) * i) / count);
      pts.push([curvePoint.X(), curvePoint.Y(), curvePoint.Z()]);
      curvePoint.delete();
    }
  } finally {
    ad.delete();
  }
  const lengths = [0];
  for (let i = 1; i < pts.length; i++) {
    lengths.push(lengths[i - 1] + len(sub(pts[i], pts[i - 1])));
  }
  const total = lengths[lengths.length - 1] || 1;

  return { pts, s: lengths.map(x => x / total), closed: len(sub(pts[0], pts[pts.length - 1])) < 1e-6 * total + 1e-9 };
}

const reversed = (curve: Curve): Curve => ({ pts: [...curve.pts].reverse(), s: [...curve.s].reverse().map(x => 1 - x), closed: curve.closed });

/** The point `fraction` of the way along (round again past the end of a closed one). */
function at(curve: Curve, fraction: number): Vec3 {
  if (curve.closed) {
    fraction = ((fraction % 1) + 1) % 1;
  } else {
    fraction = Math.min(1, Math.max(0, fraction));
  }
  let lo = 0;
  let hi = curve.s.length - 1;
  while (hi - lo > 1) {
    const middle = (lo + hi) >> 1;
    if (curve.s[middle] <= fraction) {
      lo = middle;
    } else {
      hi = middle;
    }
  }
  const span = curve.s[hi] - curve.s[lo];
  const t = span > 0 ? (fraction - curve.s[lo]) / span : 0;

  return add(curve.pts[lo], scale(sub(curve.pts[hi], curve.pts[lo]), t));
}

/** Where on the curve is nearest `point`: how far along, and how far off. */
function nearest(curve: Curve, point: Vec3): { f: number; d: number } {
  let best = { f: 0, d: Infinity };
  for (let i = 0; i + 1 < curve.pts.length; i++) {
    const a = curve.pts[i];
    const ab = sub(curve.pts[i + 1], a);
    const l2 = dot(ab, ab);
    const t = l2 > 0 ? Math.min(1, Math.max(0, dot(sub(point, a), ab) / l2)) : 0;
    const distance = len(sub(point, add(a, scale(ab, t))));
    if (distance < best.d) {
      best = { f: curve.s[i] + (curve.s[i + 1] - curve.s[i]) * t, d: distance };
    }
  }

  return best;
}

/** Where a guide meets a profile: how far along each. */
function meet(rail: Curve, sec: Curve): { onRail: number; onSec: number; d: number } {
  let best = { onRail: 0, onSec: 0, d: Infinity };
  // Coarse, then the best few of the guide's points refined.
  const step = Math.max(1, Math.floor(rail.pts.length / 240));
  const tries: { i: number; d: number }[] = [];
  for (let i = 0; i < rail.pts.length; i += step) {
    tries.push({ i, d: nearest(sec, rail.pts[i]).d });
  }
  tries.sort((a, b) => a.d - b.d);
  for (const { i } of tries.slice(0, 3)) {
    for (let pointIndex = Math.max(0, i - step); pointIndex <= Math.min(rail.pts.length - 1, i + step); pointIndex++) {
      const q = nearest(sec, rail.pts[pointIndex]);
      if (q.d < best.d) {
        best = { onRail: rail.s[pointIndex], onSec: q.f, d: q.d };
      }
    }
  }
  // And back: the profile's point onto the guide.
  const back = nearest(rail, at(sec, best.onSec));

  return { onRail: back.f, onSec: best.onSec, d: Math.min(best.d, back.d) };
}

const centroidOf = (ps: Vec3[]): Vec3 => scale(ps.reduce((a, point) => add(a, point), [0, 0, 0] as Vec3), 1 / Math.max(1, ps.length));
const centroid = (curve: Curve): Vec3 => scale(curve.pts.slice(0, -1).reduce((a, point) => add(a, point), [0, 0, 0] as Vec3), 1 / Math.max(1, curve.pts.length - 1));
/** Which way round a closed curve runs (Newell's normal, its size the area). */
function winding(curve: Curve): Vec3 {
  let normal: Vec3 = [0, 0, 0];
  for (let i = 0; i + 1 < curve.pts.length; i++) {
    normal = add(normal, cross(curve.pts[i], curve.pts[i + 1]));
  }

  return normal;
}

interface Anchor {
  /** A guide's index, or -1 for connection points. */
  rail: number;
  /** How far along each profile. */
  a: number[];
  /** How far along the guide, at each profile. */
  r: number[];
}

/** Does a section turn sharply anywhere (more than 20° from one point to the next)? */
function sharp(rows: Vec3[][]): boolean {
  const cos20 = Math.cos((20 * Math.PI) / 180);
  for (const row of rows) {
    for (let j = 0; j < row.length; j++) {
      const a = sub(row[j], row[(j - 1 + row.length) % row.length]);
      const b = sub(row[(j + 1) % row.length], row[j]);
      if (len(a) > 0 && len(b) > 0 && dot(norm(a), norm(b)) < cos20) {
        return true;
      }
    }
  }

  return false;
}

/**
 * The loft from its grid of points (a row per section, the same number round
 * each): one smooth side through them, the two ends capped flat with the
 * side's own end curves, sewn into a solid.
 */
function gridSolid(rows: Vec3[][], size: number): Shape3D {
  const oc = getOC();
  const nu = rows.length;
  const nv = rows[0].length + 1;
  const gc: { delete(): void }[] = [];
  const keep = <T extends { delete(): void }>(x: T): T => (gc.push(x), x);
  try {
    const grid = keep(new oc.NCollection_Array2_gp_Pnt(1, nu, 1, nv));
    rows.forEach((row, i) => {
      for (let j = 0; j < nv; j++) {
        const pole = keep(new oc.gp_Pnt(...row[j % row.length]));
        grid.SetValue(i + 1, j + 1, pole);
      }
    });
    // Through the points exactly (fitted within a tolerance, a square's corners came out rounded).
    // Smooth profiles: through the points, smooth (C2) all round. Profiles with
    // sharp corners (a square): fitted allowing a kink, so the corners stay
    // sharp - interpolated, they rippled 0.3 % of the size out past them.
    const fit = keep(sharp(rows) ? new oc.GeomAPI_PointsToBSplineSurface(grid, 3, 3, oc.GeomAbs_Shape.GeomAbs_C0, size * 1e-5) : new oc.GeomAPI_PointsToBSplineSurface());
    if (!sharp(rows)) {
      fit.Interpolate(grid, false);
    }
    const surf = fit.Surface();
    const sew = keep(new oc.BRepBuilderAPI_Sewing(size * 1e-6, true, true, true, false));
    const side = keep(new oc.BRepBuilderAPI_MakeFace(surf, 1e-6));
    sew.Add(side.Face());
    for (const [param, row] of [[surf.UKnot(1), rows[0]], [surf.UKnot(surf.NbUKnots()), rows[nu - 1]]] as const) {
      const edge = keep(new oc.BRepBuilderAPI_MakeEdge(surf.UIso(param)));
      const wire = keep(new oc.BRepBuilderAPI_MakeWire(edge.Edge()));
      // On the profile's own plane (from its points).
      const centroid = centroidOf(row);
      const normal = norm(row.reduce((a, point, j) => add(a, cross(sub(point, centroid), sub(row[(j + 1) % row.length], centroid))), [0, 0, 0] as Vec3));
      const pln = keep(new oc.gp_Pln(keep(new oc.gp_Pnt(...centroid)), keep(new oc.gp_Dir(...normal))));
      const cap = keep(new oc.BRepBuilderAPI_MakeFace(pln, wire.Wire(), true));
      if (!cap.IsDone()) {
        throw new Error("A profile isn't flat: the loft's end can't be closed");
      }
      sew.Add(cap.Face());
    }
    const progress = keep(new oc.Message_ProgressRange());
    sew.Perform(progress);
    const sewed = sew.SewedShape();
    if (sewed.ShapeType() !== oc.TopAbs_ShapeEnum.TopAbs_SHELL) {
      throw new Error("These profiles can't be lofted along those guides");
    }
    const fix = keep(new oc.ShapeFix_Solid());
    const solid = cast(fix.SolidFromShell(oc.TopoDS.Shell(sewed)));
    if (!isShape3D(solid)) {
      throw new Error("These profiles can't be lofted along those guides");
    }

    return solid;
  } finally {
    for (const object of gc.reverse()) {
      object.delete();
    }
  }
}

/**
 * Loft through closed profiles (in order), held by guide curves along its
 * sides and by connection points (one point near each profile per connection).
 * (Its sides are always smooth: Straight sides doesn't apply.)
 */
export function railLoft(wires: Wire[], rails: Wire[], connections: Vec3[][]): Shape3D {
  let secs = wires.map(wire => sample(wire));
  if (secs.some(section => !section.closed)) {
    throw new Error('Guide curves and connection points need closed profiles');
  }
  const size = Math.max(...secs.map(section => Math.max(...section.pts.map(point => len(sub(point, centroid(section)))))), 1e-6);
  // All one way round, seen down the loft.
  const axis = norm(sub(centroid(secs[secs.length - 1]), centroid(secs[0])));
  secs = secs.map(section => (dot(winding(section), axis) < 0 ? reversed(section) : section));

  const anchors: Anchor[] = [];
  const railCurves = rails.map(rail => sample(rail, 1200));
  const tol = Math.max(size * 0.03, 0.05);
  railCurves.forEach((rc, railCurveIndex) => {
    const meets = secs.map(sec => meet(rc, sec));
    const off = meets.findIndex(meet => meet.d > tol);
    if (off >= 0) {
      throw new Error(`Guide curve ${railCurveIndex + 1} doesn't touch profile ${off + 1}: each guide must run through every profile`);
    }
    anchors.push({ rail: railCurveIndex, a: meets.map(meet => meet.onSec), r: meets.map(meet => meet.onRail) });
  });
  for (const [index, pts] of connections.entries()) {
    if (pts.length !== secs.length) {
      throw new Error(`Connection ${index + 1} needs a point on every profile`);
    }
    anchors.push({ rail: -1, a: secs.map((sec, i) => nearest(sec, pts[i]).f), r: [] });
  }
  if (!anchors.length) {
    throw new Error('Add a guide curve or a connection');
  }

  // Round each profile from the first anchor; the anchors must come in the same order on all.
  anchors.sort((firstAnchor, secondAnchor) => firstAnchor.a[0] - secondAnchor.a[0]);
  const rel = (i: number, anchorIndex: number) => (((anchors[anchorIndex].a[i] - anchors[0].a[i]) % 1) + 1) % 1;
  for (let i = 1; i < secs.length; i++) {
    for (let anchorIndex = 1; anchorIndex < anchors.length; anchorIndex++) {
      if (rel(i, anchorIndex) <= rel(i, anchorIndex - 1)) {
        throw new Error('The guides or connections cross over between profiles: they must go round each profile in the same order');
      }
    }
  }

  // The same number of points between each two anchors on every profile.
  const samples = 160;
  const counts = anchors.map((_, anchorIndex) => Math.max(3, Math.round(samples * ((anchorIndex + 1 < anchors.length ? rel(0, anchorIndex + 1) : 1) - rel(0, anchorIndex)))));
  const start = counts.map((_, countIndex) => counts.slice(0, countIndex).reduce((a, b) => a + b, 0));
  const total = counts.reduce((a, b) => a + b, 0);
  const resampled = secs.map((sec, i) => {
    const out: Vec3[] = [];
    anchors.forEach((an, anchorIndex) => {
      const from = an.a[i];
      const to = from + ((anchorIndex + 1 < anchors.length ? rel(i, anchorIndex + 1) : 1) - rel(i, anchorIndex));
      for (let index = 0; index < counts[anchorIndex]; index++) {
        out.push(at(sec, from + ((to - from) * index) / counts[anchorIndex]));
      }
    });

    return out;
  });

  // Between profiles: sections that follow the guides.
  const railAnchors = anchors.map((an, anchorIndex) => ({ an, idx: start[anchorIndex] })).filter(entry => entry.an.rail >= 0);
  const sections: Vec3[][] = [resampled[0]];
  for (let i = 0; i + 1 < resampled.length; i++) {
    {
      const steps = railAnchors.length ? 6 : 3;
      for (let step = 1; step <= steps; step++) {
        const t = step / (steps + 1);
        const points = resampled[i].map((point, j) => add(point, scale(sub(resampled[i + 1][j], point), t)));
        if (!railAnchors.length) {
          sections.push(points);
          continue;
        }
        const moves = railAnchors.map(({ an, idx }) => ({ idx, d: sub(at(railCurves[an.rail], an.r[i] + (an.r[i + 1] - an.r[i]) * t), points[idx]) }));
        // Each point moved as the guides either side of it are, by how near it is to each.
        sections.push(
          points.map((point, j) => {
            if (moves.length === 1) {
              return add(point, moves[0].d);
            }
            let q = moves.length - 1;
            for (let moveIndex = 0; moveIndex < moves.length; moveIndex++) {
              if (moves[moveIndex].idx <= j) {
                q = moveIndex;
              }
            }
            const a = moves[q];
            const b = moves[(q + 1) % moves.length];
            const span = (b.idx - a.idx + total) % total || total;
            const weight = ((j - a.idx + total) % total) / span;

            return add(point, add(scale(a.d, 1 - weight), scale(b.d, weight)));
          })
        );
      }
    }
    sections.push(resampled[i + 1]);
  }

  return gridSolid(sections, size);
}
