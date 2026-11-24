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

/** Point and normal (outward, not of unit length) at (paramS, t), each 0..1 across the face's surface. */
export function surfaceAt(face: Face, paramS: number, t: number): { p: Tuple; n: Tuple } {
  const oc = getOC();
  const { uMin, uMax, vMin, vMax } = face.UVBounds;
  const point = new oc.gp_Pnt();
  const normal = new oc.gp_Vec();
  const faceProps = new oc.BRepGProp_Face(face.wrapped, false);
  try {
    faceProps.Normal(uMin + (uMax - uMin) * paramS, vMin + (vMax - vMin) * t, point, normal);

    return { p: [point.X(), point.Y(), point.Z()], n: [normal.X(), normal.Y(), normal.Z()] };
  } finally {
    faceProps.delete();
    normal.delete();
    point.delete();
  }
}

/**
 * A face's normal (of unit length) where one of its edges is, at `s` (0..1)
 * along the edge (as edge.pointAt counts): read through the edge's own curve
 * on the face, so nothing is projected. Null if the edge isn't on the face.
 */
export function normalOnEdge(face: Face, edge: Edge, param: number): Tuple | null {
  const oc = getOC();
  let curve2d: InstanceType<typeof oc.BRepAdaptor_Curve2d> | null = null;
  let uv: { X(): number; Y(): number; delete(): void } | null = null;
  const point = new oc.gp_Pnt();
  const normal = new oc.gp_Vec();
  const faceProps = new oc.BRepGProp_Face(face.wrapped, false);
  try {
    curve2d = new oc.BRepAdaptor_Curve2d(edge.wrapped, face.wrapped);
    const t0 = curve2d.FirstParameter();
    uv = curve2d.Value(t0 + (curve2d.LastParameter() - t0) * param);
    faceProps.Normal(uv!.X(), uv!.Y(), point, normal);
    const length = Math.hypot(normal.X(), normal.Y(), normal.Z());

    return length > 0 ? [normal.X() / length, normal.Y() / length, normal.Z() / length] : null;
  } catch {
    return null;
  } finally {
    uv?.delete();
    curve2d?.delete();
    faceProps.delete();
    normal.delete();
    point.delete();
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

function props(measurable: Measurable, kind: 'volume' | 'area') {
  const oc = getOC();
  const props = new oc.GProp_GProps();
  let ok = true;
  try {
    const err = kind === 'volume' ? oc.BRepGProp.VolumeProperties(measurable.wrapped, props, EPS, false, false) : oc.BRepGProp.SurfaceProperties(measurable.wrapped, props, EPS, false);
    ok = Number.isFinite(err) && Number.isFinite(props.Mass());
  } catch {
    ok = false;
  }
  if (ok) {
    return props;
  }
  // (Where the adaptive measure won't settle, the plain one.)
  props.delete();
  const q = new oc.GProp_GProps();
  if (kind === 'volume') {
    oc.BRepGProp.VolumeProperties(measurable.wrapped, q, false, false, false);
  } else {
    oc.BRepGProp.SurfaceProperties(measurable.wrapped, q, false, false);
  }

  return q;
}

/** The volume (signed: below 0 for a solid inside out), as replicad's but to a millionth. */
export function measureVolume(measurable: Measurable): number {
  const own = ownSums(measurable);
  if (own) {
    return own.vol;
  }
  const measured = props(measurable, 'volume');
  try {
    return measured.Mass();
  } finally {
    measured.delete();
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
export function quickVolume(measurable: Measurable): number {
  const exact = measured.get(measurable);
  if (exact) {
    return exact.vol;
  }
  const had = quick.get(measurable);
  if (had !== undefined) {
    return had;
  }
  const oc = getOC();
  let volume = NaN;
  const props = new oc.GProp_GProps();
  try {
    const err = oc.BRepGProp.VolumeProperties(measurable.wrapped, props, 1e-3, false, false);
    if (Number.isFinite(err)) {
      volume = props.Mass();
    }
  } catch {
    // The plain one, below.
  } finally {
    props.delete();
  }
  if (!Number.isFinite(volume)) {
    volume = roughVolume(measurable);
  }
  quick.set(measurable, volume);

  return volume;
}

/**
 * The volume roughly (OpenCascade's plain measure, a percent or so out on
 * curved sweeps): enough to tell a solid's sign, or that it isn't empty. The
 * exact measure of a mug handle's sweep took 3.5 s each time, asked twice for
 * every way tried.
 */
export function roughVolume(measurable: Measurable): number {
  const oc = getOC();
  const q = new oc.GProp_GProps();
  try {
    oc.BRepGProp.VolumeProperties(measurable.wrapped, q, false, false, false);

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

function sweptFace(face: Face): boolean {
  const oc = getOC();
  const surfaceTypes = oc.GeomAbs_SurfaceType;
  const a = new oc.BRepAdaptor_Surface(face.wrapped, true);
  try {
    const t = a.GetType();

    return t === surfaceTypes.GeomAbs_SurfaceOfExtrusion || t === surfaceTypes.GeomAbs_SurfaceOfRevolution || t === surfaceTypes.GeomAbs_OffsetSurface || t === surfaceTypes.GeomAbs_OtherSurface;
  } finally {
    a.delete();
  }
}

/** Breaks of [a, b]: its ends and the given joints inside, each piece cut in `depth`. */
function pieces(a: number, b: number, joints: number[], depth: number): number[] {
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  const at = [lo, ...joints.filter(x => x > lo + 1e-12 * (1 + Math.abs(lo)) && x < hi - 1e-12 * (1 + Math.abs(hi))), hi];
  const out: number[] = [];
  for (let i = 0; i + 1 < at.length; i++) {
    for (let j = 0; j < depth; j++) {
      out.push(at[i] + ((at[i + 1] - at[i]) * j) / depth);
    }
  }
  out.push(hi);

  return a <= b ? out : out.reverse();
}

/** A face's sums: area, ∫ X dA, its share of the volume (taken from `reference`) and of ∫ (X - reference) dV. */
type Sums = { area: number; m: Vec3; vol: number; mv: Vec3 };

/** A face's sums, integrated piece by piece, the pieces halved until two finenesses agree to a millionth. */
function faceSums(face: Face, reference: Vec3, size: number): Sums {
  const oc = getOC();
  const continuity = oc.GeomAbs_Shape.GeomAbs_C2;
  const surf = new oc.BRepAdaptor_Surface(face.wrapped, true);
  const faceProps = new oc.BRepGProp_Face(face.wrapped, false);
  const point = new oc.gp_Pnt();
  const normal = new oc.gp_Vec();
  const q = new oc.gp_Pnt2d();
  const tangent2d = new oc.gp_Vec2d();
  const ex = new oc.TopExp_Explorer(face.wrapped, oc.TopAbs_ShapeEnum.TopAbs_EDGE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
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
    const nu = surf.NbUIntervals(continuity);
    const nv = surf.NbVIntervals(continuity);
    const alongV = nv < nu;
    const w0 = alongV ? surf.FirstVParameter() : surf.FirstUParameter();
    const joints = alongV ? intervals(nv, a => surf.VIntervals(a, continuity)) : intervals(nu, a => surf.UIntervals(a, continuity));
    // The surface's joints the other way: where the outline crosses one, the
    // sums bend there, so the outline is cut there too.
    const across = (alongV ? intervals(nu, a => surf.UIntervals(a, continuity)) : intervals(nv, a => surf.VIntervals(a, continuity))).slice(1, -1);
    for (; ex.More(); ex.Next()) {
      const cur = ex.Current();
      const e = oc.TopoDS.Edge(cur);
      const sign = e.Orientation() === oc.TopAbs_Orientation.TopAbs_REVERSED ? -1 : 1;
      const curve2d = new oc.BRepAdaptor_Curve2d(e, face.wrapped);
      e.delete();
      cur.delete();
      const tJoints = intervals(curve2d.NbIntervals(continuity), a => curve2d.Intervals(a, continuity));
      edges.push({ c: curve2d, sign, t0: curve2d.FirstParameter(), t1: curve2d.LastParameter(), joints: tJoints });
      if (!across.length) {
        continue;
      }
      const other = (t: number) => {
        curve2d.D1(t, q, tangent2d);

        return alongV ? q.X() : q.Y();
      };
      const base = [...tJoints];
      for (let i = 0; i + 1 < base.length; i++) {
        // (Sampled, then each crossing found by false position.)
        const samples = 4;
        let ta = base[i];
        let oa = other(ta);
        for (let j = 1; j <= samples; j++) {
          const tb = base[i] + ((base[i + 1] - base[i]) * j) / samples;
          const ob = other(tb);
          for (const joint of across) {
            if ((oa - joint) * (ob - joint) >= 0) {
              continue;
            }
            let [lo, hi, flo, fhi] = [ta, tb, oa - joint, ob - joint];
            let side = 0;
            let t = lo;
            for (let it = 0; it < 60; it++) {
              t = (lo * fhi - hi * flo) / (fhi - flo);
              const ft = other(t) - joint;
              if (Math.abs(ft) <= 1e-13 * (1 + Math.abs(joint)) || hi - lo <= 1e-14 * (1 + Math.abs(hi))) {
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
    const values = new Float64Array(8);
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
    const gauss = (wa: number, wb: number, otherParam: number) => {
      budget--;
      const out = new Float64Array(8);
      const halfWidth = (wb - wa) / 2;
      const middle = (wb + wa) / 2;
      for (const [x, wt] of GAUSS) {
        if (alongV) {
          faceProps.Normal(otherParam, middle + halfWidth * x, point, normal);
        } else {
          faceProps.Normal(middle + halfWidth * x, otherParam, point, normal);
        }
        const nx = normal.X();
        const ny = normal.Y();
        const nz = normal.Z();
        const pointX = point.X();
        const pointY = point.Y();
        const pointZ = point.Z();
        const dx = pointX - reference[0];
        const dy = pointY - reference[1];
        const dz = pointZ - reference[2];
        const wh = wt * halfWidth;
        const a = Math.hypot(nx, ny, nz) * wh;
        out[0] += a;
        out[1] += a * pointX;
        out[2] += a * pointY;
        out[3] += a * pointZ;
        out[4] += ((dx * nx + dy * ny + dz * nz) / 3) * wh;
        out[5] += ((dx * dx) / 2) * nx * wh;
        out[6] += ((dy * dy) / 2) * ny * wh;
        out[7] += ((dz * dz) / 2) * nz * wh;
      }

      return out;
    };
    const refine = (whole: Float64Array, wa: number, wb: number, otherParam: number, tolA: number, depth: number) => {
      const middle = (wa + wb) / 2;
      const left = gauss(wa, middle, otherParam);
      const rr = gauss(middle, wb, otherParam);
      if ((Math.abs(left[0] + rr[0] - whole[0]) <= tolA && Math.abs(left[4] + rr[4] - whole[4]) <= tolA * size) || depth >= 20 || budget <= 0) {
        for (let j = 0; j < 8; j++) {
          values[j] += left[j] + rr[j];
        }

        return;
      }
      const half = Math.max(tolA / 2, floor);
      refine(left, wa, middle, otherParam, half, depth + 1);
      refine(rr, middle, wb, otherParam, half, depth + 1);
    };
    // ∫ from w0 to `upTo`, at `otherParam`, of each sum's integrand.
    let floor = 0;
    const inner = (upTo: number, otherParam: number) => {
      values.fill(0);
      const ws = pieces(w0, upTo, joints, 1);
      const parts: Float64Array[] = [];
      let scale = 0;
      for (let i = 0; i + 1 < ws.length; i++) {
        const got = gauss(ws[i], ws[i + 1], otherParam);
        parts.push(got);
        scale += Math.abs(got[0]);
      }
      if (rough) {
        for (const got of parts) {
          for (let j = 0; j < 8; j++) {
            values[j] += got[j];
          }
        }

        return values;
      }
      const span = Math.abs(upTo - w0) || 1;
      const tol = scale * EPS * 0.1;
      floor = tol * 1e-3;
      for (let i = 0; i + 1 < ws.length; i++) {
        refine(parts[i], ws[i], ws[i + 1], otherParam, (tol * Math.abs(ws[i + 1] - ws[i])) / span, 0);
      }

      return values;
    };
    type Curve2d = (typeof edges)[number]['c'];
    const piece = (curve2d: Curve2d, sign: number, a: number, b: number) => {
      const out = new Float64Array(8);
      const halfWidth = (b - a) / 2;
      const middle = (b + a) / 2;
      for (const [x, wt] of GAUSS) {
        curve2d.D1(middle + halfWidth * x, q, tangent2d);
        const dOther = alongV ? tangent2d.X() : tangent2d.Y();
        if (dOther === 0) {
          continue;
        }
        const got = alongV ? inner(q.Y(), q.X()) : inner(q.X(), q.Y());
        const f2 = sign * dOther * wt * halfWidth;
        for (let j = 0; j < 8; j++) {
          out[j] += got[j] * f2;
        }
      }

      return out;
    };
    const add = (whole: Float64Array, curve2d: Curve2d, sign: number, a: number, b: number, tolA: number, depth: number) => {
      const middle = (a + b) / 2;
      const left = piece(curve2d, sign, a, middle);
      const rr = piece(curve2d, sign, middle, b);
      if ((Math.abs(left[0] + rr[0] - whole[0]) <= tolA && Math.abs(left[4] + rr[4] - whole[4]) <= tolA * size) || depth >= 24 || budget <= 0) {
        for (let j = 0; j < 8; j++) {
          tot[j] += left[j] + rr[j];
        }

        return;
      }
      const half = Math.max(tolA / 2, tolArea * 1e-4);
      add(left, curve2d, sign, a, middle, half, depth + 1);
      add(rr, curve2d, sign, middle, b, half, depth + 1);
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
      const orientation = tot[0] < 0 ? -1 : 1;

      return { area: orientation * tot[0], m: [orientation * tot[1], orientation * tot[2], orientation * tot[3]], vol: orientation * tot[4], mv: [orientation * tot[5], orientation * tot[6], orientation * tot[7]] };
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
    tangent2d.delete();
    q.delete();
    normal.delete();
    point.delete();
    faceProps.delete();
    surf.delete();
  }
}

/** Sums over all its faces, integrated here - or null when none is swept (OpenCascade measures the rest right). */
function ownSums(measurable: Measurable): (Sums & { R: Vec3 }) | null {
  // (Kept per shape: a shell's checks measure the same body several times.)
  const known = measured.get(measurable);
  if (known !== undefined) {
    return known;
  }
  const got = ownSumsNow(measurable);
  measured.set(measurable, got);

  return got;
}
const measured = new WeakMap<object, (Sums & { R: Vec3 }) | null>();

function ownSumsNow(measurable: Measurable): (Sums & { R: Vec3 }) | null {
  const faces = measurable.faces;
  if (!faces.some(sweptFace)) {
    return null;
  }
  const b = measurable.boundingBox;
  const reference = [...b.center] as Vec3;
  const size = Math.max(1e-9, Math.hypot(b.width, b.height, b.depth));
  const out: Sums = { area: 0, m: [0, 0, 0], vol: 0, mv: [0, 0, 0] };
  for (const face of faces) {
    const sums = faceSums(face, reference, size);
    out.area += sums.area;
    out.vol += sums.vol;
    for (let j = 0; j < 3; j++) {
      out.m[j] += sums.m[j];
      out.mv[j] += sums.mv[j];
    }
  }

  return { ...out, R: reference };
}

/** The area of all its faces, to a millionth. */
export function measureArea(measurable: Measurable): number {
  const own = ownSums(measurable);
  if (own) {
    return own.area;
  }
  const measured = props(measurable, 'area');
  try {
    return measured.Mass();
  } finally {
    measured.delete();
  }
}

/** A face's area and its middle (centre of area), measured once - at the plain fineness (for showing, not for checks). */
export function areaProperties(face: Face): { area: number; center: Vec3 } {
  const own = ownSums(face);
  if (own) {
    return { area: own.area, center: own.m.map(x => x / own.area) as Vec3 };
  }
  const oc = getOC();
  const props = new oc.GProp_GProps();
  oc.BRepGProp.SurfaceProperties(face.wrapped, props, false, false);
  const centre = props.CentreOfMass();
  try {
    return { area: props.Mass(), center: [centre.X(), centre.Y(), centre.Z()] };
  } finally {
    centre.delete();
    props.delete();
  }
}

/** Volume and centre of mass, to a millionth. */
export function volumeProperties(shape: Shape3D): { volume: number; centerOfMass: Vec3 } {
  const own = ownSums(shape);
  if (own) {
    return { volume: own.vol, centerOfMass: own.mv.map((x, j) => own.R[j] + x / own.vol) as Vec3 };
  }
  const measured = props(shape, 'volume');
  const centre = measured.CentreOfMass();
  try {
    return { volume: measured.Mass(), centerOfMass: [centre.X(), centre.Y(), centre.Z()] };
  } finally {
    centre.delete();
    measured.delete();
  }
}
