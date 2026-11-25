import { ProjectionCamera, cast, getOC } from 'replicad';
import { add, cross, dist, dot, norm, scale, sub, xDirFor } from '../geom';
import { run, runWithPlainThreads } from './engine';
import { halfSpace } from './booleans';
import { isEmpty } from './bodies';
import { cylinderOf, planeOf } from './faceEdit';
import { anchorOf, freeformFaces, meshViews, viewEdge } from './viewLines';
import { threadTarget } from './steps/thread';
import { threadDepth } from './threads';
import { drawingMesh, smoothStepsOf } from './viewMesh';
import type { AnyShape, Edge, Shape3D } from 'replicad';
import type { Feature, Vec3 } from '../doc/types';
import type { ProjectedView, ViewBody, ViewEdge, ViewSpec } from './protocol';
import type { Ctx } from './types';

/**
 * Drawings: the bodies seen along each view's direction, with hidden line
 * removal (OpenCascade's exact HLR), each body's edges kept apart so a balloon
 * can point at it. Edges come out as SVG path data in mm, y down.
 */
export async function projectViews(features: Feature[], views: ViewSpec[], only?: string[], method: 'auto' | 'exact' | 'mesh' = 'auto'): Promise<ProjectedView[]> {
  // Threads are drawn the way drawings show them (ISO 6410): the plain round
  // face, and a thin line at the thread's depth. Modelled, a valve's six
  // threads took the hidden line removal minutes.
  const threads = features.filter((feature): feature is Extract<Feature, { type: 'thread' }> => feature.type === 'thread' && !feature.suppressed);
  let ctx: Ctx;
  if (!threads.length) {
    ctx = (await run(features)).ctx;
  } else {
    ctx = await runWithPlainThreads(features);
  }
  const bodies = [...ctx.bodies.entries()].filter(([id]) => !only || only.includes(id));
  const smoothSteps = smoothStepsOf(features);
  const marks = threadMarks(threads, ctx);
  const withMarks = (out: ProjectedView[], views: ViewSpec[]) => {
    out.forEach((pv, viewIndex) =>
      pv.bodies.forEach((vb) => {
        for (const mark of marks.filter(threadMark => threadMark.body === vb.id)) {
          const line = threadLines(mark, views[viewIndex], vb.edges);
          if (!line) {
            continue;
          }
          if (line.seen) {
            vb.tangent += line.d;
          } else {
            vb.hidden += line.d;
          }
        }
      })
    );

    return out;
  };
  // Section views: the bodies cut, each on its own.
  const plain = views.filter(view => !view.cut);
  const drawn = new Map<ViewSpec, ProjectedView>();
  if (plain.length) {
    withMarks(drawViews(bodies, plain, method, smoothSteps), plain).forEach((pv, withMarkIndex) => drawn.set(plain[withMarkIndex], pv));
  }
  for (const view of views) {
    if (view.cut) {
      drawn.set(view, sectionView(bodies, view, method, smoothSteps));
    }
  }

  return views.map(view => drawn.get(view)!);
}

/**
 * A section view: each body cut by the plane through `cut` square to the
 * view, the part between the eye and the plane taken off. The faces the cut
 * makes come back as closed outlines, to hatch; hidden lines aren't drawn in
 * a section (ISO 128-40).
 */
function sectionView(bodies: [string, Shape3D][], viewSpec: ViewSpec, method: 'auto' | 'exact' | 'mesh', smoothSteps: Set<string>): ProjectedView {
  const direction = norm(viewSpec.dir as Vec3);
  const look = scale(direction, -1);
  const xAxis = norm(viewSpec.xAxis as Vec3);
  const yAxis = cross(direction, xAxis);
  const at = viewSpec.cut as Vec3;
  const to2 = (point: Vec3): [number, number] => [dot(point, xAxis), -dot(point, yAxis)];
  const cut: [string, Shape3D][] = [];
  const faces = new Map<string, string>();
  for (const [id, shape] of bodies) {
    let part: Shape3D;
    try {
      part = shape.intersect(halfSpace({ origin: at, xDir: xDirFor(look), normal: look }, shape));
    } catch {
      continue;
    }
    if (isEmpty(part)) {
      continue;
    }
    cut.push([id, part]);
    let path = '';
    for (const face of part.faces) {
      if (face.geomType !== 'PLANE') {
        continue;
      }
      const pl = planeOf(face);
      if (Math.abs(Math.abs(dot(pl.normal, look)) - 1) > 1e-6 || Math.abs(dot(sub(pl.origin, at), look)) > 1e-4) {
        continue;
      }
      path += closedLoops(face.edges.map(e => edgePoints(e).map(to2)));
    }
    if (path) {
      faces.set(id, path);
    }
  }
  if (!cut.length) {
    return { id: viewSpec.id, bodies: [], box: null };
  }
  const [pv] = drawViews(cut, [{ ...viewSpec, cut: undefined }], method, smoothSteps);
  for (const b of pv.bodies) {
    b.hidden = '';
    delete b.under;
    const faceSvg = faces.get(b.id);
    if (faceSvg) {
      b.section = faceSvg;
    }
  }

  return pv;
}

/** An edge's points in space: its ends for a line, more along a curve. */
function edgePoints(e: Edge): Vec3[] {
  const oc = getOC();
  const ad = new oc.BRepAdaptor_Curve(e.wrapped as never);
  try {
    const u0 = ad.FirstParameter();
    const u1 = ad.LastParameter();
    const at = (param: number): Vec3 => {
      const curvePoint = ad.Value(param);
      const point: Vec3 = [curvePoint.X(), curvePoint.Y(), curvePoint.Z()];
      curvePoint.delete();

      return point;
    };
    if (ad.GetType() === oc.GeomAbs_CurveType.GeomAbs_Line) {
      return [at(u0), at(u1)];
    }
    let length = 0;
    for (let i = 1; i <= 8; i++) {
      length += dist(at(u0 + ((u1 - u0) * (i - 1)) / 8), at(u0 + ((u1 - u0) * i) / 8));
    }
    const samples = Math.max(8, Math.min(96, Math.ceil(length / 0.5)));

    return Array.from({ length: samples + 1 }, (_, i) => at(u0 + ((u1 - u0) * i) / samples));
  } finally {
    ad.delete();
  }
}

/** Edges (as point runs, any order and way round) joined end to end into closed outlines: SVG path data. */
export function closedLoops(runs: [number, number][][]): string {
  const left = runs.filter(run => run.length > 1);
  const same = (a: [number, number], b: [number, number]) => Math.abs(a[0] - b[0]) < 1e-3 && Math.abs(a[1] - b[1]) < 1e-3;
  let pathData = '';
  while (left.length) {
    const loop = [...left.shift()!];
    for (let grew = true; grew && !same(loop[0], loop[loop.length - 1]); ) {
      grew = false;
      const end = loop[loop.length - 1];
      const i = left.findIndex(run => same(run[0], end) || same(run[run.length - 1], end));
      if (i < 0) {
        break;
      }
      const taken = left.splice(i, 1)[0];
      loop.push(...(same(taken[0], end) ? taken : [...taken].reverse()).slice(1));
      grew = true;
    }
    pathData += loop.map((point, i) => `${i ? 'L' : 'M'}${r3(point[0])} ${r3(point[1])}`).join('') + 'Z';
  }

  return pathData;
}

/** Views drawn the usual way: exact hidden line removal, or from the meshes for freeform or very big models. */
function drawViews(bodies: [string, Shape3D][], views: ViewSpec[], method: 'auto' | 'exact' | 'mesh', smoothSteps: Set<string>): ProjectedView[] {
  // Freeform faces (or a great many faces) take the exact hidden line removal
  // seconds to minutes a view: those models are drawn from their meshes.
  const meshes = bodies.map(([id, shape]) => ({ id, shape: shape, mesh: drawingMesh(id, shape, smoothSteps) }));
  const faces = meshes.reduce((total, mesh) => total + mesh.mesh.faces.length, 0);
  const free = meshes.reduce((total, mesh) => total + freeformFaces(mesh.mesh), 0);
  const how = method === 'auto' ? (free > 0 || faces > 600 ? 'mesh' : 'exact') : method;
  if (how === 'mesh') {
    return meshViews(meshes, views);
  }
  const oc = getOC();

  return views.map((view) => {
    const cam = new ProjectionCamera([0, 0, 0], view.dir, view.xAxis);
    const algo = new oc.HLRBRep_Algo();
    for (const [, shape] of bodies) {
      algo.Add(shape.wrapped, 0);
    }
    const projector = new oc.HLRAlgo_Projector(cam.wrapped);
    algo.Projector(projector);
    algo.Update();
    algo.Hide();
    const out = new oc.HLRBRep_HLRToShape(algo);
    let lo: [number, number] = [Infinity, Infinity];
    let hi: [number, number] = [-Infinity, -Infinity];
    // Hidden edges lying exactly under seen ones (the back of a box, seen
    // straight on) are left out: they would only be drawn over.
    const drawn = new Set<string>();
    const key = (a: [number, number], b: [number, number]) => {
      const [from, q] = [`${r3(a[0])} ${r3(a[1])}`, `${r3(b[0])} ${r3(b[1])}`].sort();

      return `${from}|${q}`;
    };
    const result: ViewBody[] = bodies.map(([id, bodyShape]) => {
      const seen: [number, number][][] = [];
      const edges: ViewEdge[] = [];
      const paths = (parts: unknown[], keep: boolean) => {
        let pathData = '';
        for (const part of parts) {
          const shape = part as { IsNull(): boolean };
          if (shape.IsNull()) {
            continue;
          }
          for (const e of (cast(shape as never) as AnyShape).edges) {
            oc.BRepLib.BuildCurves3d(e.wrapped as never);
            const { pts, kind } = edgeSamples(e);
            const edgeKey = key(pts[0], pts[pts.length - 1]);
            if (keep) {
              drawn.add(edgeKey);
            } else if (pts.length === 2 && drawn.has(edgeKey)) {
              continue;
            }
            for (const point of pts) {
              lo = [Math.min(lo[0], point[0]), Math.min(lo[1], point[1])];
              hi = [Math.max(hi[0], point[0]), Math.max(hi[1], point[1])];
            }
            if (keep) {
              seen.push(pts);
              const edge = viewEdge(kind, pts);
              if (edge) {
                edges.push(edge);
              }
            }
            pathData += pts.map((point, i) => `${i ? 'L' : 'M'}${r3(point[0])} ${r3(point[1])}`).join('');
          }
        }

        return pathData;
      };
      const wrapped = bodyShape.wrapped;
      const visible = paths([out.VCompound(wrapped), out.OutLineVCompound(wrapped)], true);
      const tangent = paths([out.Rg1LineVCompound(wrapped)], true);

      return { id, visible, tangent, hidden: '', anchor: anchorOf(seen), edges };
    });
    // Hidden edges once every body's seen ones are known. A body hidden
    // whole (inside a housing) still gets a spot a balloon can point at.
    bodies.forEach(([, shape], i) => {
      let hiddenPath = '';
      const under: [number, number][][] = [];
      for (const part of [out.HCompound(shape.wrapped), out.OutLineHCompound(shape.wrapped)]) {
        if (part.IsNull()) {
          continue;
        }
        for (const e of (cast(part) as AnyShape).edges) {
          oc.BRepLib.BuildCurves3d(e.wrapped as never);
          const { pts } = edgeSamples(e);
          if (pts.length === 2 && drawn.has(key(pts[0], pts[1]))) {
            continue;
          }
          if (!result[i].anchor) {
            under.push(pts);
          }
          hiddenPath += pts.map((point, j) => `${j ? 'L' : 'M'}${r3(point[0])} ${r3(point[1])}`).join('');
        }
      }
      result[i].hidden = hiddenPath;
      if (!result[i].anchor && under.length) {
        result[i].under = anchorOf(under);
      }
    });
    out.delete();
    projector.delete();
    algo.delete();
    cam.delete();

    return { id: view.id, bodies: result, box: lo[0] <= hi[0] ? [lo, hi] : null };
  });
}

const r3 = (value: number) => String(Math.round(value * 1000) / 1000);

/** A thread as a drawing marks it: its round face's axis and length, and the radius of its thin line. */
type ThreadMark = { body: string; c: Vec3; a: Vec3; r: number; rc: number; t0: number; t1: number };

/** Where the threads are, on the plain bodies (a face that moved since its thread step is left unmarked). */
function threadMarks(threads: Extract<Feature, { type: 'thread' }>[], ctx: Ctx): ThreadMark[] {
  const out: ThreadMark[] = [];
  for (const thread of threads) {
    const body = ctx.bodies.get(thread.face.body);
    if (!body) {
      continue;
    }
    try {
      const face = threadTarget(body, thread);
      const cy = cylinderOf(face);
      if (!cy) {
        continue;
      }
      const a = norm(cy.a);
      const ts: number[] = [];
      for (const e of face.edges) {
        for (const fraction of [0, 0.5, 1]) {
          ts.push(dot(sub(e.pointAt(fraction).toTuple() as Vec3, cy.c), a));
        }
      }
      const inside = cy.s < 0;
      const depth = threadDepth(thread.pitch, inside);
      out.push({ body: thread.face.body, c: cy.c, a, r: cy.r, rc: inside ? cy.r + depth : cy.r - depth, t0: Math.min(...ts), t1: Math.max(...ts) });
    } catch {
      // Not found: no mark.
    }
  }

  return out;
}

/**
 * A thread's thin line in a view, as path data: along its axis, two lines at
 * the thread's depth (seen where the round face's outline is); looking down
 * it, three quarters of a circle (seen where its edge circle is).
 */
function threadLines(threadMark: ThreadMark, viewSpec: ViewSpec, edges: ViewEdge[]): { d: string; seen: boolean } | null {
  const direction = norm(viewSpec.dir);
  const xAxis = norm(viewSpec.xAxis);
  const yAxis = cross(direction, xAxis);
  const to2 = (point: Vec3): [number, number] => [dot(point, xAxis), -dot(point, yAxis)];
  const along = Math.abs(dot(threadMark.a, direction));
  const tol = Math.max(0.02, threadMark.r * 0.02);
  if (along < 1e-6) {
    const p0 = to2(add(threadMark.c, scale(threadMark.a, threadMark.t0)));
    const p1 = to2(add(threadMark.c, scale(threadMark.a, threadMark.t1)));
    const along = norm([p1[0] - p0[0], p1[1] - p0[1], 0]);
    const normal: [number, number] = [-along[1], along[0]];
    let path = '';
    let seen = false;
    for (const sgn of [1, -1]) {
      const off = (point: [number, number], offset: number): [number, number] => [point[0] + normal[0] * offset * sgn, point[1] + normal[1] * offset * sgn];
      // The round face's outline on this side, among the seen straight edges.
      const o0 = off(p0, threadMark.r);
      const across = (q: [number, number]) => Math.abs((q[0] - o0[0]) * normal[0] + (q[1] - o0[1]) * normal[1]);
      if (edges.some(e => !('m' in e) && across(e.a) < tol && across(e.b) < tol)) {
        seen = true;
      }
      const [a, b] = [off(p0, threadMark.rc), off(p1, threadMark.rc)];
      path += `M${r3(a[0])} ${r3(a[1])}L${r3(b[0])} ${r3(b[1])}`;
    }

    return { d: path, seen };
  }
  if (along > 1 - 1e-6) {
    // The end the view looks at.
    const near = dot(threadMark.a, direction) > 0 ? threadMark.t0 : threadMark.t1;
    const center = to2(add(threadMark.c, scale(threadMark.a, near)));
    const seen = edges.some(e => 'm' in e && Math.abs(e.r - threadMark.r) < tol && Math.hypot(e.c[0] - center[0], e.c[1] - center[1]) < tol);
    const segments = 48;
    const pts = Array.from({ length: segments + 1 }, (_, i) => {
      const t = (i / segments) * 1.5 * Math.PI;

      return [center[0] + threadMark.rc * Math.cos(t), center[1] - threadMark.rc * Math.sin(t)];
    });

    return { d: pts.map((point, i) => `${i ? 'L' : 'M'}${r3(point[0])} ${r3(point[1])}`).join(''), seen };
  }

  return null;
}

/**
 * Points along a projected edge (y flipped, for the paper): a line's two
 * ends, a curve sampled finely enough to print - read from one curve adaptor
 * (a drawing of a big assembly has thousands of edges).
 */
function edgeSamples(e: Edge): { pts: [number, number][]; kind: 'line' | 'circle' | 'other' } {
  const oc = getOC();
  const ad = new oc.BRepAdaptor_Curve(e.wrapped as never);
  try {
    const curveTypes = oc.GeomAbs_CurveType;
    const type = ad.GetType();
    const u0 = ad.FirstParameter();
    const u1 = ad.LastParameter();
    const at = (param: number): [number, number] => {
      const curvePoint = ad.Value(param);
      const point: [number, number] = [curvePoint.X(), -curvePoint.Y()];
      curvePoint.delete();

      return point;
    };
    if (type === curveTypes.GeomAbs_Line) {
      return { pts: [at(u0), at(u1)], kind: 'line' };
    }
    // As many points as its length asks for (one every half millimetre, 8 to 96).
    let len = 0;
    let prev = at(u0);
    for (let i = 1; i <= 8; i++) {
      const q = at(u0 + ((u1 - u0) * i) / 8);
      len += Math.hypot(q[0] - prev[0], q[1] - prev[1]);
      prev = q;
    }
    const samples = Math.max(8, Math.min(96, Math.ceil(len / 0.5)));

    return { pts: Array.from({ length: samples + 1 }, (_, i) => at(u0 + ((u1 - u0) * i) / samples)), kind: type === curveTypes.GeomAbs_Circle ? 'circle' : 'other' };
  } finally {
    ad.delete();
  }
}
