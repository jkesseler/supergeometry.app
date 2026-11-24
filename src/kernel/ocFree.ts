// A face's point and normal at a place on its surface, read straight off it.
//
// face.normalAt(point) finds where the point is on the surface first (a point
// projection), and on a detailed spline surface each projection keeps about
// half a megabyte of the engine's memory for good, freed or not. Tidying a
// gear's outline swept with a twist (362 spline faces, 25 places each) ran
// the engine out of memory (0.2 GB to 3.8 GB) and broke it. Where the place
// on the surface is known, ask there.
import { getOC, type Edge, type Face, type Shape3D } from 'replicad';

type Tuple = [number, number, number];
type Vec3 = Tuple;

/** Point and normal (outward, not of unit length) at (s, t), each 0..1 across the face's surface. */
export function surfaceAt(face: Face, s: number, t: number): { p: Tuple; n: Tuple } {
  const oc = getOC();
  const { uMin, uMax, vMin, vMax } = face.UVBounds;
  const p = new oc.gp_Pnt();
  const n = new oc.gp_Vec();
  const g = new oc.BRepGProp_Face(face.wrapped, false);
  try {
    g.Normal(uMin + (uMax - uMin) * s, vMin + (vMax - vMin) * t, p, n);

    return { p: [p.X(), p.Y(), p.Z()], n: [n.X(), n.Y(), n.Z()] };
  } finally {
    g.delete();
    n.delete();
    p.delete();
  }
}

/**
 * A face's normal (of unit length) where one of its edges is, at `s` (0..1)
 * along the edge (as edge.pointAt counts): read through the edge's own curve
 * on the face, so nothing is projected. Null if the edge isn't on the face.
 */
export function normalOnEdge(face: Face, edge: Edge, s: number): Tuple | null {
  const oc = getOC();
  let c: InstanceType<typeof oc.BRepAdaptor_Curve2d> | null = null;
  let uv: { X(): number; Y(): number; delete(): void } | null = null;
  const p = new oc.gp_Pnt();
  const n = new oc.gp_Vec();
  const g = new oc.BRepGProp_Face(face.wrapped, false);
  try {
    c = new oc.BRepAdaptor_Curve2d(edge.wrapped, face.wrapped);
    const t0 = c.FirstParameter();
    uv = c.Value(t0 + (c.LastParameter() - t0) * s);
    g.Normal(uv!.X(), uv!.Y(), p, n);
    const l = Math.hypot(n.X(), n.Y(), n.Z());

    return l > 0 ? [n.X() / l, n.Y() / l, n.Z() / l] : null;
  } catch {
    return null;
  } finally {
    uv?.delete();
    c?.delete();
    g.delete();
    n.delete();
    p.delete();
  }
}

// Volumes and areas, measured to a millionth.
//
// replicad's measureVolume / measureArea integrate each face at a fixed
// fineness, which on many-patched spline faces is well off: a propeller (lofted
// blades, rounded roots) measured 203 698 mm³ for 201 310 (1.2 % over), its
// centre of mass 0.2 mm off its axis. Asked to a relative accuracy instead,
// OpenCascade keeps refining until it's there (about twice the time).
const EPS = 1e-6;
type Measurable = Shape3D | Face;

function props(s: Measurable, kind: 'volume' | 'area') {
  const oc = getOC();
  const p = new oc.GProp_GProps();
  let ok = true;
  try {
    const err = kind === 'volume' ? oc.BRepGProp.VolumeProperties(s.wrapped, p, EPS, false, false) : oc.BRepGProp.SurfaceProperties(s.wrapped, p, EPS, false);
    ok = Number.isFinite(err) && Number.isFinite(p.Mass());
  } catch {
    ok = false;
  }
  if (ok) {
    return p;
  }
  // (Where the adaptive measure won't settle, the plain one.)
  p.delete();
  const q = new oc.GProp_GProps();
  if (kind === 'volume') {
    oc.BRepGProp.VolumeProperties(s.wrapped, q, false, false, false);
  } else {
    oc.BRepGProp.SurfaceProperties(s.wrapped, q, false, false);
  }

  return q;
}

/** The volume (signed: below 0 for a solid inside out), as replicad's but to a millionth. */
export function measureVolume(s: Measurable): number {
  const own = ownSums(s);
  if (own) {
    return own.vol;
  }
  const p = props(s, 'volume');
  try {
    return p.Mass();
  } finally {
    p.delete();
  }
}

/**
 * The volume to a thousandth or so (measured: within 0.15 %), for checks that need no more: which way out a solid
 * is, whether it is empty, whether a join or a cut came to about what it should. The measure to a millionth takes
 * seconds on curved bodies (a mug: 1.7 s; a jet engine's cowl: 10.6 s) where this takes 0.2 s and 0.06 s - and such
 * checks, asked several times a step, were most of what a join, a cut or a thread on such a body took.
 * (The exact one where it is known already.)
 */
const quick = new WeakMap<object, number>();
export function quickVolume(s: Measurable): number {
  const exact = measured.get(s);
  if (exact) {
    return exact.vol;
  }
  const had = quick.get(s);
  if (had !== undefined) {
    return had;
  }
  const oc = getOC();
  let v = NaN;
  const p = new oc.GProp_GProps();
  try {
    const err = oc.BRepGProp.VolumeProperties(s.wrapped, p, 1e-3, false, false);
    if (Number.isFinite(err)) {
      v = p.Mass();
    }
  } catch {
    // The plain one, below.
  } finally {
    p.delete();
  }
  if (!Number.isFinite(v)) {
    v = roughVolume(s);
  }
  quick.set(s, v);

  return v;
}

/**
 * The volume roughly (OpenCascade's plain measure, a percent or so out on
 * curved sweeps): enough to tell a solid's sign, or that it isn't empty. The
 * exact measure of a mug handle's sweep took 3.5 s each time, asked twice for
 * every way tried.
 */
export function roughVolume(s: Measurable): number {
  const oc = getOC();
  const q = new oc.GProp_GProps();
  try {
    oc.BRepGProp.VolumeProperties(s.wrapped, q, false, false, false);

    return q.Mass();
  } finally {
    q.delete();
  }
}

// Faces swept from a curve (an extruded or revolved spline, and offsets of
// them) are integrated by OpenCascade over the whole sweep at one fineness,
// blind to the curve's own pieces: the side of an extruded closed spline
// measured 14 049 mm² for 13 820, its solid 316 000 mm³ for 284 800 (11 %).
// (OpenCascade's Gauss-Kronrod measure gets volumes right but took 11 s on a
// shelled mouse; its areas have no such measure.) Bodies and faces with such
// faces are integrated here instead, piece by piece:
// Green's theorem round each face's outline in its own (u, v), so
// ∫∫ f du dv = ∮ (∫ f du) dv, with f = |Su × Sv| for area and the divergence
// theorem's (X - R)·N / 3 for volume.
//
// (Five points a piece: every piece is smooth, cut at the surface's and the
// outline's joints and where the outline crosses the surface's.)
const GAUSS: [number, number][] = [
  [-0.906179845938664, 0.2369268850561891],
  [-0.5384693101056831, 0.4786286704993665],
  [0, 0.5688888888888889],
  [0.5384693101056831, 0.4786286704993665],
  [0.906179845938664, 0.2369268850561891]
];

function sweptFace(f: Face): boolean {
  const oc = getOC();
  const T = oc.GeomAbs_SurfaceType;
  const a = new oc.BRepAdaptor_Surface(f.wrapped, true);
  try {
    const t = a.GetType();

    return t === T.GeomAbs_SurfaceOfExtrusion || t === T.GeomAbs_SurfaceOfRevolution || t === T.GeomAbs_OffsetSurface || t === T.GeomAbs_OtherSurface;
  } finally {
    a.delete();
  }
}

/** Breaks of [a, b]: its ends and the given joints inside, each piece cut in `k`. */
function pieces(a: number, b: number, joints: number[], k: number): number[] {
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  const at = [lo, ...joints.filter(x => x > lo + 1e-12 * (1 + Math.abs(lo)) && x < hi - 1e-12 * (1 + Math.abs(hi))), hi];
  const out: number[] = [];
  for (let i = 0; i + 1 < at.length; i++) {
    for (let j = 0; j < k; j++) {
      out.push(at[i] + ((at[i + 1] - at[i]) * j) / k);
    }
  }
  out.push(hi);

  return a <= b ? out : out.reverse();
}

/** A face's sums: area, ∫ X dA, its share of the volume (taken from R) and of ∫ (X - R) dV. */
type Sums = { area: number; m: Vec3; vol: number; mv: Vec3 };

/** A face's sums, integrated piece by piece, the pieces halved until two finenesses agree to a millionth. */
function faceSums(f: Face, R: Vec3, size: number): Sums {
  const oc = getOC();
  const S = oc.GeomAbs_Shape.GeomAbs_C2;
  const surf = new oc.BRepAdaptor_Surface(f.wrapped, true);
  const g = new oc.BRepGProp_Face(f.wrapped, false);
  const p = new oc.gp_Pnt();
  const n = new oc.gp_Vec();
  const q = new oc.gp_Pnt2d();
  const d = new oc.gp_Vec2d();
  const ex = new oc.TopExp_Explorer(f.wrapped, oc.TopAbs_ShapeEnum.TopAbs_EDGE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
  const intervals = (count: number, fill: (arr: InstanceType<typeof oc.NCollection_Array1_double>) => void) => {
    const arr = new oc.NCollection_Array1_double(1, count + 1);
    try {
      fill(arr);
      const out: number[] = [];
      for (let i = 1; i <= count + 1; i++) {
        out.push(arr.Value(i));
      }

      return out;
    } finally {
      arr.delete();
    }
  };
  const edges: { c: InstanceType<typeof oc.BRepAdaptor_Curve2d>; sign: number; t0: number; t1: number; joints: number[] }[] = [];
  try {
    // The inner sums run the way the surface has fewer pieces (along an
    // extrusion's straight side, round a revolve), as each point of the
    // outline needs one: the other way, across a spline's every piece, a
    // shelled mouse took 5 s to measure (1 s this way). (Which way round
    // the outline is then integrated only changes the sign, set below.)
    const nu = surf.NbUIntervals(S);
    const nv = surf.NbVIntervals(S);
    const alongV = nv < nu;
    const w0 = alongV ? surf.FirstVParameter() : surf.FirstUParameter();
    const joints = alongV ? intervals(nv, a => surf.VIntervals(a, S)) : intervals(nu, a => surf.UIntervals(a, S));
    // The surface's joints the other way: where the outline crosses one, the
    // sums bend there, so the outline is cut there too.
    const across = (alongV ? intervals(nu, a => surf.UIntervals(a, S)) : intervals(nv, a => surf.VIntervals(a, S))).slice(1, -1);
    for (; ex.More(); ex.Next()) {
      const cur = ex.Current();
      const e = oc.TopoDS.Edge(cur);
      const sign = e.Orientation() === oc.TopAbs_Orientation.TopAbs_REVERSED ? -1 : 1;
      const c = new oc.BRepAdaptor_Curve2d(e, f.wrapped);
      e.delete();
      cur.delete();
      const tJoints = intervals(c.NbIntervals(S), a => c.Intervals(a, S));
      edges.push({ c, sign, t0: c.FirstParameter(), t1: c.LastParameter(), joints: tJoints });
      if (!across.length) {
        continue;
      }
      const other = (t: number) => {
        c.D1(t, q, d);

        return alongV ? q.X() : q.Y();
      };
      const base = [...tJoints];
      for (let i = 0; i + 1 < base.length; i++) {
        // (Sampled, then each crossing found by false position.)
        const N = 4;
        let ta = base[i];
        let oa = other(ta);
        for (let j = 1; j <= N; j++) {
          const tb = base[i] + ((base[i + 1] - base[i]) * j) / N;
          const ob = other(tb);
          for (const J of across) {
            if ((oa - J) * (ob - J) >= 0) {
              continue;
            }
            let [lo, hi, flo, fhi] = [ta, tb, oa - J, ob - J];
            let side = 0;
            let t = lo;
            for (let it = 0; it < 60; it++) {
              t = (lo * fhi - hi * flo) / (fhi - flo);
              const ft = other(t) - J;
              if (Math.abs(ft) <= 1e-13 * (1 + Math.abs(J)) || hi - lo <= 1e-14 * (1 + Math.abs(hi))) {
                break;
              }
              if (ft * flo < 0) {
                [hi, fhi] = [t, ft];
                if (side === -1) {
                  flo /= 2;
                }
                side = -1;
              } else {
                [lo, flo] = [t, ft];
                if (side === 1) {
                  fhi /= 2;
                }
                side = 1;
              }
            }
            tJoints.push(t);
          }
          ta = tb;
          oa = ob;
        }
      }
      tJoints.sort((x, y) => x - y);
    }
    const r = new Float64Array(8);
    const tot = new Float64Array(8);
    // Both ways each piece is one Gauss pass, checked against its two
    // halves' and halved again only where they differ, to a tenth of the
    // millionth (a slow stretch - a blade's trailing edge - doesn't make
    // every other piece finer: halving all of them, again and again, the
    // jet's sixteen blade faces took 4 s each and still hadn't agreed).
    // A first rough pass (five points a piece) sets the scale.
    // (Each half held to half the tolerance - but never below a thousandth
    // of it, and no more than a budget of points a face: where the sums can't
    // settle - rounding, a pole - halving the tolerance on and on split every
    // piece to the bottom, 2^24 of them, and a lofted grid never finished.)
    let rough = true;
    let tolArea = Infinity;
    let budget = 100000;
    const gauss = (wa: number, wb: number, o: number) => {
      budget--;
      const out = new Float64Array(8);
      const h = (wb - wa) / 2;
      const c = (wb + wa) / 2;
      for (const [x, wt] of GAUSS) {
        if (alongV) {
          g.Normal(o, c + h * x, p, n);
        } else {
          g.Normal(c + h * x, o, p, n);
        }
        const nx = n.X();
        const ny = n.Y();
        const nz = n.Z();
        const X = p.X();
        const Y = p.Y();
        const Z = p.Z();
        const dx = X - R[0];
        const dy = Y - R[1];
        const dz = Z - R[2];
        const wh = wt * h;
        const a = Math.hypot(nx, ny, nz) * wh;
        out[0] += a;
        out[1] += a * X;
        out[2] += a * Y;
        out[3] += a * Z;
        out[4] += ((dx * nx + dy * ny + dz * nz) / 3) * wh;
        out[5] += ((dx * dx) / 2) * nx * wh;
        out[6] += ((dy * dy) / 2) * ny * wh;
        out[7] += ((dz * dz) / 2) * nz * wh;
      }

      return out;
    };
    const refine = (whole: Float64Array, wa: number, wb: number, o: number, tolA: number, depth: number) => {
      const m = (wa + wb) / 2;
      const l = gauss(wa, m, o);
      const rr = gauss(m, wb, o);
      if ((Math.abs(l[0] + rr[0] - whole[0]) <= tolA && Math.abs(l[4] + rr[4] - whole[4]) <= tolA * size) || depth >= 20 || budget <= 0) {
        for (let j = 0; j < 8; j++) {
          r[j] += l[j] + rr[j];
        }

        return;
      }
      const half = Math.max(tolA / 2, floor);
      refine(l, wa, m, o, half, depth + 1);
      refine(rr, m, wb, o, half, depth + 1);
    };
    // ∫ from w0 to w, at the other parameter o, of each sum's integrand.
    let floor = 0;
    const inner = (w: number, o: number) => {
      r.fill(0);
      const ws = pieces(w0, w, joints, 1);
      const parts: Float64Array[] = [];
      let scale = 0;
      for (let i = 0; i + 1 < ws.length; i++) {
        const got = gauss(ws[i], ws[i + 1], o);
        parts.push(got);
        scale += Math.abs(got[0]);
      }
      if (rough) {
        for (const got of parts) {
          for (let j = 0; j < 8; j++) {
            r[j] += got[j];
          }
        }

        return r;
      }
      const span = Math.abs(w - w0) || 1;
      const tol = scale * EPS * 0.1;
      floor = tol * 1e-3;
      for (let i = 0; i + 1 < ws.length; i++) {
        refine(parts[i], ws[i], ws[i + 1], o, (tol * Math.abs(ws[i + 1] - ws[i])) / span, 0);
      }

      return r;
    };
    type Curve2d = (typeof edges)[number]['c'];
    const piece = (c: Curve2d, sign: number, a: number, b: number) => {
      const out = new Float64Array(8);
      const h = (b - a) / 2;
      const m = (b + a) / 2;
      for (const [x, wt] of GAUSS) {
        c.D1(m + h * x, q, d);
        const dOther = alongV ? d.X() : d.Y();
        if (dOther === 0) {
          continue;
        }
        const got = alongV ? inner(q.Y(), q.X()) : inner(q.X(), q.Y());
        const f2 = sign * dOther * wt * h;
        for (let j = 0; j < 8; j++) {
          out[j] += got[j] * f2;
        }
      }

      return out;
    };
    const add = (whole: Float64Array, c: Curve2d, sign: number, a: number, b: number, tolA: number, depth: number) => {
      const m = (a + b) / 2;
      const l = piece(c, sign, a, m);
      const rr = piece(c, sign, m, b);
      if ((Math.abs(l[0] + rr[0] - whole[0]) <= tolA && Math.abs(l[4] + rr[4] - whole[4]) <= tolA * size) || depth >= 24 || budget <= 0) {
        for (let j = 0; j < 8; j++) {
          tot[j] += l[j] + rr[j];
        }

        return;
      }
      const half = Math.max(tolA / 2, tolArea * 1e-4);
      add(l, c, sign, a, m, half, depth + 1);
      add(rr, c, sign, m, b, half, depth + 1);
    };
    const sums = (): Sums => {
      tot.fill(0);
      for (const { c, sign, t0, t1, joints: tj } of edges) {
        const ts = pieces(t0, t1, tj, 1);
        const span = Math.abs(t1 - t0) || 1;
        for (let i = 0; i + 1 < ts.length; i++) {
          const share = Math.abs(ts[i + 1] - ts[i]) / span / edges.length;
          add(piece(c, sign, ts[i], ts[i + 1]), c, sign, ts[i], ts[i + 1], tolArea * share, 0);
        }
      }
      // (Which way round the outline runs depends on the face's own way
      // round: the area must come out above 0.)
      const s = tot[0] < 0 ? -1 : 1;

      return { area: s * tot[0], m: [s * tot[1], s * tot[2], s * tot[3]], vol: s * tot[4], mv: [s * tot[5], s * tot[6], s * tot[7]] };
    };
    // (A face an offset closed to nothing - 1e-15 mm² - adds nothing: held
    // to a tenth of a millionth of its own no area, it never settled, 3 s each
    // in a split box's shell.)
    const first = sums();
    if (Math.abs(first.area) < size * size * 1e-12) {
      return first;
    }
    tolArea = Math.max(Math.abs(first.area), size * size * 1e-6) * EPS * 0.1;
    rough = false;

    return sums();
  } finally {
    for (const e of edges) {
      e.c.delete();
    }
    ex.delete();
    d.delete();
    q.delete();
    n.delete();
    p.delete();
    g.delete();
    surf.delete();
  }
}

/** Sums over all its faces, integrated here - or null when none is swept (OpenCascade measures the rest right). */
function ownSums(s: Measurable): (Sums & { R: Vec3 }) | null {
  // (Kept per shape: a shell's checks measure the same body several times.)
  const known = measured.get(s);
  if (known !== undefined) {
    return known;
  }
  const got = ownSumsNow(s);
  measured.set(s, got);

  return got;
}
const measured = new WeakMap<object, (Sums & { R: Vec3 }) | null>();

function ownSumsNow(s: Measurable): (Sums & { R: Vec3 }) | null {
  const faces = s.faces;
  if (!faces.some(sweptFace)) {
    return null;
  }
  const b = s.boundingBox;
  const R = [...b.center] as Vec3;
  const size = Math.max(1e-9, Math.hypot(b.width, b.height, b.depth));
  const out: Sums = { area: 0, m: [0, 0, 0], vol: 0, mv: [0, 0, 0] };
  for (const f of faces) {
    const r = faceSums(f, R, size);
    out.area += r.area;
    out.vol += r.vol;
    for (let j = 0; j < 3; j++) {
      out.m[j] += r.m[j];
      out.mv[j] += r.mv[j];
    }
  }

  return { ...out, R };
}

/** The area of all its faces, to a millionth. */
export function measureArea(s: Measurable): number {
  const own = ownSums(s);
  if (own) {
    return own.area;
  }
  const p = props(s, 'area');
  try {
    return p.Mass();
  } finally {
    p.delete();
  }
}

/** A face's area and its middle (centre of area), measured once - at the plain fineness (for showing, not for checks). */
export function areaProperties(f: Face): { area: number; center: Vec3 } {
  const own = ownSums(f);
  if (own) {
    return { area: own.area, center: own.m.map(x => x / own.area) as Vec3 };
  }
  const oc = getOC();
  const p = new oc.GProp_GProps();
  oc.BRepGProp.SurfaceProperties(f.wrapped, p, false, false);
  const c = p.CentreOfMass();
  try {
    return { area: p.Mass(), center: [c.X(), c.Y(), c.Z()] };
  } finally {
    c.delete();
    p.delete();
  }
}

/** Volume and centre of mass, to a millionth. */
export function volumeProperties(s: Shape3D): { volume: number; centerOfMass: Vec3 } {
  const own = ownSums(s);
  if (own) {
    return { volume: own.vol, centerOfMass: own.mv.map((x, j) => own.R[j] + x / own.vol) as Vec3 };
  }
  const p = props(s, 'volume');
  const c = p.CentreOfMass();
  try {
    return { volume: p.Mass(), centerOfMass: [c.X(), c.Y(), c.Z()] };
  } finally {
    c.delete();
    p.delete();
  }
}
