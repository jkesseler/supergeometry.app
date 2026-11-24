// Reusable pick slots: axis, plane, direction, path, faces, profiles.

import { Vector3 } from 'three';
import { cross, dot, len, norm, scale, sub, add, toPlane, toWorld } from '../geom';
import { closestOnPrim, entityPrims } from '../sketch/curves';
import { explode } from '../sketch/edit';
import { arrangement, regionRef } from '../sketch/regions';
import { edgeRefOf, faceRefOf, type AppContext, type Sel } from './tool';
import type { AxisFeature, AxisRef, EdgeRef, ExtrudeSource, FaceRef, PathRef, PlaneDef, SketchFeature, Vec3 } from '../doc/types';
import type { Slot } from './featureOp';

const WORLD_AXES: { label: string; dir: Vec3 }[] = [
  { label: 'X', dir: [1, 0, 0] },
  { label: 'Y', dir: [0, 1, 0] },
  { label: 'Z', dir: [0, 0, 1] }
];

export function axisSlot(app: AppContext, label: string, get: () => AxisRef | null, set: (a: AxisRef) => void): Slot {
  let shown: Sel | null = null;
  let name = '';

  return {
    label,
    describe: () => (get() ? name || 'Axis' : 'Tap a line, edge or axis'),
    filled: () => !!get(),
    pick: { profiles: false, curves: true, planes: false, axes: true, worldAxes: true },
    presets: [
      ...WORLD_AXES.map(a => ({ label: a.label, apply: () => ((name = `${a.label} axis`), (shown = null), set({ origin: [0, 0, 0], dir: a.dir })) })),
      // The project's own axes, by name: a thin dashed line far off is hard to
      // tap (a fan's axis tap caught the yoke's edge in front of it).
      ...app.store.features
        .filter((feature): feature is AxisFeature => feature.type === 'axis' && !feature.suppressed)
        .map(feature => ({ label: feature.name, apply: () => ((name = feature.name), (shown = { kind: 'axis', id: feature.id } as Sel), set({ origin: feature.origin, dir: feature.dir, ref: { kind: 'axis' as const, feature: feature.id } })) }))
    ],
    shows: () => (shown ? [shown] : []),
    accept(hit) {
      // A point of a sketch (a short axis line is mostly its ends, and the
      // circle it halves has its own points on it): the sketch line through it.
      // (Tapped, it was taken for nothing - the Axis waited on.)
      if (hit.kind === 'point') {
        const sketch = app.store.find<SketchFeature>(hit.sketch);
        const plane = app.sketchPlane(hit.sketch);
        if (!sketch || !plane) {
          return false;
        }
        const at = toPlane(plane, hit.point);
        const on = sketch.entities.find(e => e.kind === 'line' && closestOnPrim(entityPrims(e)[0], at).d < 1e-6 * Math.max(1, len(sub(toWorld(plane, e.b), toWorld(plane, e.a)))));
        if (!on || on.kind !== 'line') {
          return false;
        }
        const a = toWorld(plane, on.a);
        set({ origin: a, dir: norm(sub(toWorld(plane, on.b), a)), ref: { kind: 'sketchLine', sketch: sketch.id, entity: on.id } });
        name = 'Sketch line';
        shown = { kind: 'curve', sketch: sketch.id, entity: on.id } as Sel;

        return true;
      }
      if (hit.kind === 'curve') {
        const sketch = app.store.find<SketchFeature>(hit.sketch);
        const e = sketch?.entities.find(entity => entity.id === hit.entity);
        const plane = app.sketchPlane(hit.sketch);
        if (!sketch || !plane || !e) {
          return false;
        }
        if (e.kind === 'line') {
          const a = toWorld(plane, e.a);
          set({ origin: a, dir: norm(sub(toWorld(plane, e.b), a)), ref: { kind: 'sketchLine', sketch: sketch.id, entity: e.id } });
          name = 'Sketch line';
        } else if ((e.kind === 'rect' || e.kind === 'polygon' || e.kind === 'polyline') && hit.point) {
          // The side of a shape that was tapped (a profile drawn against the axis).
          const at = toPlane(plane, hit.point);
          const side = explode(e).reduce((sketchEntity, candidate) => (closestOnPrim(entityPrims(candidate)[0], at).d < closestOnPrim(entityPrims(sketchEntity)[0], at).d ? candidate : sketchEntity));
          if (side.kind !== 'line') {
            return false;
          }
          const a = toWorld(plane, side.a);
          set({ origin: a, dir: norm(sub(toWorld(plane, side.b), a)) });
          name = 'Side of the shape';
        } else {
          return false;
        }
      } else if (hit.kind === 'edge') {
        const info = app.view.body(hit.body)?.edges[hit.edge];
        if (!info) {
          return false;
        }
        if (info.type === 'LINE') {
          set({ origin: info.start, dir: info.dir });
          name = 'Edge';
        } else if (info.type === 'CIRCLE') {
          // A round edge: the line through its centre, square to it - what a
          // circular pattern round a lamp shade or a flange turns about.
          const ax = circleAxis(info.start, info.mid, info.end, info.dir);
          if (!ax) {
            return false;
          }
          set(ax);
          name = 'Centre of round edge';
        } else {
          return false;
        }
      } else if (hit.kind === 'axis') {
        const ax = app.view.axisOf(hit.id);
        if (!ax) {
          return false;
        }
        // World axes don't move; construction axes are followed by reference.
        const world = ['X', 'Y', 'Z'].includes(hit.id);
        set({ origin: ax.plane.origin, dir: ax.plane.normal, ...(world ? {} : { ref: { kind: 'axis' as const, feature: hit.id } }) });
        name = ax.name;
      } else {
        return false;
      }
      shown = { ...hit } as Sel;
      delete (shown as { point?: unknown }).point;

      return true;
    }
  };
}

export function planeSlot(
  app: AppContext,
  label: string,
  get: () => PlaneDef | null,
  set: (p: PlaneDef, face?: FaceRef) => void,
  // `named`: what's in it already, by name (a plane being edited: "XZ plane",
  // not "Plane"). `skip`: construction planes it can't be (a plane can't be
  // made from itself, nor from one made after it).
  opts: { named?: string; skip?: (planeId: string) => boolean } = {}
): Slot {
  let shown: Sel | null = null;
  let name = opts.named ?? '';

  return {
    label,
    describe: () => (get() ? name || 'Plane' : 'Tap a plane, flat face or sketched shape'),
    originPlanes: true,
    rejectHint: 'Tap a flat face, a plane or a closed sketched shape (or pick XY / XZ / YZ)',
    filled: () => !!get(),
    // A closed shape of any sketch counts too: its sketch's plane, there (a plane offset from a profile).
    pick: { profiles: true, edges: false, planes: true },
    // The project's own planes by name too (Replace Face onto a plane 320 up:
    // a thin sheet among the bodies, easy to miss with a finger).
    presets: [
      ...['XY', 'XZ', 'YZ'].map(id => ({ label: id, apply: () => ((name = `${id} plane`), (shown = null), set(app.view.planeOf(id)!)) })),
      ...app.view.construction.planes.filter(plane => !opts.skip?.(plane.id)).map(plane => ({ label: plane.name, apply: () => ((name = plane.name), (shown = null), set(plane.plane)) }))
    ],
    shows: () => (shown ? [shown] : []),
    accept(hit) {
      if (hit.kind === 'plane') {
        const plane = app.view.planeOf(hit.id);
        if (!plane || opts.skip?.(hit.id)) {
          return false;
        }
        set(plane);
        name = ['XY', 'XZ', 'YZ'].includes(hit.id) ? `${hit.id} plane` : (app.view.construction.planes.find(constructionInfo => constructionInfo.id === hit.id)?.name ?? 'Plane');
        shown = { kind: 'plane', id: hit.id };

        return true;
      }
      if (hit.kind === 'face') {
        const info = app.view.body(hit.body)?.faces[hit.face];
        if (!info?.plane) {
          return false;
        }
        set(info.plane, faceRefOf(app, hit) ?? undefined);
        name = faceOfName(app, hit.body);
        shown = { kind: 'face', body: hit.body, face: hit.face };

        return true;
      }
      if (hit.kind === 'profile') {
        const pl = app.sketchPlane(hit.sketch);
        if (!pl) {
          return false;
        }
        // Where the shape was tapped (on the sketch's plane), so the new plane shows over it.
        const q = hit.point ?? pl.origin;
        set({ ...pl, origin: sub(q, scale(pl.normal, dot(sub(q, pl.origin), pl.normal))) });
        name = 'Sketch shape';
        shown = { kind: 'profile', sketch: hit.sketch, region: hit.region };

        return true;
      }

      return false;
    }
  };
}

/** "Face of Body 3": which body a face is on, by the name it has in Items. */
export function faceOfName(app: AppContext, body: string): string {
  const name = app.store.doc.names?.[body] ?? app.result?.bodies.find(b => b.id === body)?.name;

  return name ? `Face of ${name}` : 'Face';
}

/** A direction: an edge, an axis, a face normal, or X/Y/Z. */
export function directionSlot(app: AppContext, label: string, get: () => Vec3 | null, set: (d: Vec3) => void): Slot {
  let shown: Sel | null = null;
  let name = '';

  return {
    label,
    describe: () => (get() ? name || 'Direction' : 'Tap an edge, axis or face'),
    filled: () => !!get(),
    pick: { profiles: false, planes: false, axes: true, worldAxes: true },
    presets: WORLD_AXES.map(a => ({ label: a.label, apply: () => ((name = a.label), (shown = null), set(a.dir)) })),
    shows: () => (shown ? [shown] : []),
    accept(hit) {
      if (hit.kind === 'edge') {
        const info = app.view.body(hit.body)?.edges[hit.edge];
        if (!info) {
          return false;
        }
        set(info.dir);
        name = 'Edge';
        shown = { kind: 'edge', body: hit.body, edge: hit.edge };
      } else if (hit.kind === 'face') {
        const info = app.view.body(hit.body)?.faces[hit.face];
        if (!info) {
          return false;
        }
        set(info.normal);
        name = 'Face normal';
        shown = { kind: 'face', body: hit.body, face: hit.face };
      } else if (hit.kind === 'axis') {
        const ax = app.view.axisOf(hit.id);
        if (!ax) {
          return false;
        }
        set(ax.plane.normal);
        name = ax.name;
        shown = { kind: 'axis', id: hit.id };
      } else {
        return false;
      }

      return true;
    }
  };
}

/** Sweep path: sketch curves (one sketch) or body edges. */
export function pathSlot(app: AppContext, get: () => PathRef | null, set: (p: PathRef) => void): Slot {
  return {
    label: 'Path',
    multi: true,
    describe: () => {
      const path = get();
      if (!path) {
        return 'Tap curves or edges';
      }

      return path.kind === 'sketch' ? `${path.entities.length} curve${path.entities.length > 1 ? 's' : ''}` : `${path.edges.length} edge${path.edges.length > 1 ? 's' : ''}`;
    },
    filled: () => !!get(),
    pick: { profiles: false, curves: true, planes: false, axes: false },
    shows: () => {
      const path = get();
      if (!path) {
        return [];
      }
      if (path.kind === 'sketch') {
        return path.entities.map(entity => ({ kind: 'curve', sketch: path.sketch, entity }) as Sel);
      }

      return [];
    },
    accept(hit) {
      const path = get();
      if (hit.kind === 'curve') {
        if (path?.kind === 'sketch' && path.sketch === hit.sketch) {
          const has = path.entities.includes(hit.entity);
          set({ ...path, entities: has ? path.entities.filter(e => e !== hit.entity) : [...path.entities, hit.entity] });
        } else {
          // The first tap takes the whole run the curve is part of (a stem
          // drawn as line, arc, line: one tap, not three - the short pieces
          // are hard to hit with a finger). Tapping a piece again drops it.
          const ents = app.store.find<SketchFeature>(hit.sketch)?.entities ?? [];
          const run = chainThrough(ents, hit.entity);
          set({ kind: 'sketch', sketch: hit.sketch, entities: run });
          if (run.length > 1) {
            app.ui.toast(`${run.length} joined curves - tap one to leave it out`);
          }
        }

        return true;
      }
      if (hit.kind === 'edge') {
        const ref = edgeRefOf(app, hit);
        if (!ref) {
          return false;
        }
        const edges: EdgeRef[] = path?.kind === 'edges' ? [...path.edges, ref] : [ref];
        set({ kind: 'edges', edges });

        return true;
      }

      return false;
    }
  };
}

/**
 * Curves from any sketches and edges of any bodies, as a list of paths (one
 * per sketch, one for the edges): Fill's boundary and guides. Tapping one
 * again leaves it out.
 */
export function curvesSlot(app: AppContext, label: string, get: () => PathRef[], set: (p: PathRef[]) => void, optional = false): Slot {
  const count = () => get().reduce((total, pathRef) => total + (pathRef.kind === 'sketch' ? pathRef.entities.length : pathRef.edges.length), 0);

  return {
    label,
    multi: true,
    describe: () => (count() ? `${count()} curve${count() > 1 ? 's' : ''}` : optional ? 'None' : 'Tap curves or edges'),
    filled: () => optional || count() > 0,
    pick: { profiles: false, curves: true, planes: false, axes: false },
    shows: () => get().flatMap(pathRef => (pathRef.kind === 'sketch' ? pathRef.entities.map(entity => ({ kind: 'curve', sketch: pathRef.sketch, entity }) as Sel) : [])),
    get presets() {
      return count() ? [{ label: 'Clear', apply: () => set([]) }] : [];
    },
    accept(hit) {
      const paths = get();
      if (hit.kind === 'curve') {
        const i = paths.findIndex(path => path.kind === 'sketch' && path.sketch === hit.sketch);
        if (i < 0) {
          return set([...paths, { kind: 'sketch', sketch: hit.sketch, entities: [hit.entity] }]), true;
        }
        const sketchPath = paths[i] as Extract<PathRef, { kind: 'sketch' }>;
        const entities = sketchPath.entities.includes(hit.entity) ? sketchPath.entities.filter(e => e !== hit.entity) : [...sketchPath.entities, hit.entity];
        set(entities.length ? paths.map((path, pathIndex) => (pathIndex === i ? { ...sketchPath, entities } : path)) : paths.filter((_, pathIndex) => pathIndex !== i));

        return true;
      }
      if (hit.kind === 'edge') {
        const ref = edgeRefOf(app, hit);
        if (!ref) {
          return false;
        }
        // One path per body (its face is found from its own body).
        const i = paths.findIndex(path => path.kind === 'edges' && path.edges[0]?.body === ref.body);
        if (i < 0) {
          return set([...paths, { kind: 'edges', edges: [ref] }]), true;
        }
        const edgePath = paths[i] as Extract<PathRef, { kind: 'edges' }>;
        const same = (e: EdgeRef) => JSON.stringify(e) === JSON.stringify(ref);
        const edges = edgePath.edges.some(same) ? edgePath.edges.filter(e => !same(e)) : [...edgePath.edges, ref];
        set(edges.length ? paths.map((path, pathIndex) => (pathIndex === i ? { ...edgePath, edges } : path)) : paths.filter((_, pathIndex) => pathIndex !== i));

        return true;
      }

      return false;
    }
  };
}

/** Faces of one body (e.g. faces to open in Shell). */
export function facesSlot(app: AppContext, label: string, get: () => FaceRef[], set: (f: FaceRef[]) => void, optional = false): Slot {
  const picked: Sel[] = [];

  return {
    label,
    multi: true,
    describe: () => (get().length ? `${get().length} face${get().length > 1 ? 's' : ''}` : optional ? 'None (closed)' : 'Tap faces'),
    filled: () => optional || get().length > 0,
    pick: { profiles: false, edges: false, planes: false, axes: false },
    shows: () => picked,
    // Start the list over: an open face isn't there to be tapped again (when
    // editing a shell, a wrong one couldn't be taken out).
    get presets() {
      return get().length ? [{ label: 'Clear', apply: () => ((picked.length = 0), set([])) }] : [];
    },
    accept(hit) {
      if (hit.kind !== 'face') {
        return false;
      }
      const ref = faceRefOf(app, hit);
      if (!ref) {
        return false;
      }
      const i = picked.findIndex(highlight => highlight.kind === 'face' && highlight.body === hit.body && highlight.face === hit.face);
      if (i >= 0) {
        picked.splice(i, 1);
        set(get().filter((_, index) => index !== i));
      } else {
        picked.push({ kind: 'face', body: hit.body, face: hit.face });
        set([...get(), ref]);
      }

      return true;
    }
  };
}

/** Profiles / flat faces for loft sections. */
export function sectionsSlot(app: AppContext, get: () => ExtrudeSource[], set: (s: ExtrudeSource[]) => void, initial: Sel[]): Slot {
  const picked: Sel[] = [...initial];

  return {
    label: 'Profiles',
    multi: true,
    describe: () => `${get().length} picked${get().length < 2 ? ' - tap more' : ''}`,
    filled: () => get().length >= 2,
    pick: { edges: false, planes: false, axes: false },
    shows: () => picked,
    accept(hit) {
      if (hit.kind === 'profile') {
        const region = arrangement(app.sketchCurves(hit.sketch)).regions[hit.region];
        if (!region) {
          return false;
        }
        // Tapped again: take it back out.
        const i = picked.findIndex(highlight => highlight.kind === 'profile' && highlight.sketch === hit.sketch && highlight.region === hit.region);
        const ref = regionRef(region);
        if (i >= 0) {
          picked.splice(i, 1);
          set(get().filter(extrudeSource => !(extrudeSource.kind === 'profile' && extrudeSource.sketch === hit.sketch && extrudeSource.regions.length === 1 && Math.hypot(extrudeSource.regions[0].c[0] - ref.c[0], extrudeSource.regions[0].c[1] - ref.c[1]) < 1e-6)));

          return true;
        }
        picked.push({ kind: 'profile', sketch: hit.sketch, region: hit.region });
        set([...get(), { kind: 'profile', sketch: hit.sketch, regions: [ref] }]);

        return true;
      }
      if (hit.kind === 'face') {
        const ref = faceRefOf(app, hit);
        if (!ref || !app.view.body(hit.body)?.faces[hit.face]?.plane) {
          return false;
        }
        const i = picked.findIndex(highlight => highlight.kind === 'face' && highlight.body === hit.body && highlight.face === hit.face);
        if (i >= 0) {
          picked.splice(i, 1);
          set(get().filter(extrudeSource => !(extrudeSource.kind === 'face' && extrudeSource.face.body === ref.body && Math.hypot(...(sub3(extrudeSource.face.center, ref.center) as [number, number, number])) < 1e-6)));

          return true;
        }
        picked.push({ kind: 'face', body: hit.body, face: hit.face });
        set([...get(), { kind: 'face', face: ref }]);

        return true;
      }

      return false;
    }
  };
}

const sub3 = (a: number[], b: number[]) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

/**
 * A point: a corner, a point on an edge (its ends and middle snap), a face
 * (its centre snaps), a sketch point or curve, or a plane.
 */
export function pointSlot(app: AppContext, label: string, get: () => Vec3 | null, set: (p: Vec3) => void): Slot {
  let shown: Sel | null = null;

  return {
    label,
    describe: () => {
      const point = get();

      return point ? (point.every(value => value === 0) ? 'Origin (0, 0, 0)' : point.map(value => Math.round(value * 1000) / 1000).join(', ')) : 'Tap a corner, edge, face, point or the origin';
    },
    filled: () => !!get(),
    pick: { profiles: false, curves: true, planes: true, origin: true },
    shows: () => (shown ? [shown] : []),
    accept(hit) {
      let at: Vec3 | null = 'point' in hit ? hit.point : null;
      if (!at) {
        return false;
      }
      // Snap to the obvious points when close on screen.
      const near = (q: Vec3) => {
        const a = app.view.toScreen(new Vector3(...q));
        const b = app.view.toScreen(new Vector3(...at!));

        return !!a && !!b && Math.hypot(a[0] - b[0], a[1] - b[1]) < 16;
      };
      if (hit.kind === 'vertex') {
        at = app.view.vertexOf(hit.body, hit.vertex) ?? at;
        shown = { kind: 'vertex', body: hit.body, vertex: hit.vertex };
      } else if (hit.kind === 'edge') {
        const e = app.view.body(hit.body)?.edges[hit.edge];
        const snap = e && [e.start, e.end, e.mid].find(near);
        if (snap) {
          at = snap;
        }
        shown = { kind: 'edge', body: hit.body, edge: hit.edge };
      } else if (hit.kind === 'face') {
        const face = app.view.body(hit.body)?.faces[hit.face];
        if (face?.plane && near(face.center)) {
          at = face.center;
        }
        shown = { kind: 'face', body: hit.body, face: hit.face };
      } else if (hit.kind === 'origin') {
        shown = { kind: 'origin' };
      } else {
        shown = null;
      }
      set(at);

      return true;
    }
  };
}

type Ent = SketchFeature['entities'][number];

/** The two ends of an open curve (null for closed shapes). */
function endsOf(e: Ent): [[number, number], [number, number]] | null {
  if (e.kind === 'line' || e.kind === 'arc') {
    return [e.a as [number, number], e.b as [number, number]];
  }
  if (e.kind === 'spline' && !e.closed && e.points.length > 1) {
    return [e.points[0] as [number, number], e.points[e.points.length - 1] as [number, number]];
  }
  if (e.kind === 'polyline' && !e.closed && e.points.length > 1) {
    return [e.points[0] as [number, number], e.points[e.points.length - 1] as [number, number]];
  }

  return null;
}

/**
 * The curves joined end to end with `id`, in order along the run - stopping
 * where three or more curves meet (a branch: which way would it go?).
 */
export function chainThrough(entities: Ent[], id: string): string[] {
  const open = entities.filter(e => !e.construction && endsOf(e));
  const key = (point: [number, number]) => `${Math.round(point[0] * 1e4)},${Math.round(point[1] * 1e4)}`;
  const at = new Map<string, string[]>();
  for (const e of open) {
    for (const end of endsOf(e)!) {
      at.set(key(end), [...(at.get(key(end)) ?? []), e.id]);
    }
  }
  const byId = new Map(open.map(e => [e.id, e]));
  if (!byId.has(id)) {
    return [id];
  }
  const used = new Set([id]);
  const walk = (from: [number, number]): string[] => {
    const out: string[] = [];
    let point = from;
    for (;;) {
      const there = at.get(key(point)) ?? [];
      if (there.length !== 2) {
        break;
      }
      const next = there.find(candidate => !used.has(candidate));
      if (!next) {
        break;
      }
      used.add(next);
      out.push(next);
      const [a, b] = endsOf(byId.get(next)!)!;
      point = key(a) === key(point) ? b : a;
    }

    return out;
  };
  const [a, b] = endsOf(byId.get(id)!)!;
  const back = walk(a);
  const ahead = walk(b);

  return [...back.reverse(), id, ...ahead];
}

/** The axis of a circle or arc through three of its points (`tangent` at `mid`, for a full circle). */
export function circleAxis(start: Vec3, mid: Vec3, end: Vec3, tangent: Vec3): AxisRef | null {
  const full = len(sub(start, end)) < 1e-6;
  if (full) {
    const center = scale(add(start, mid), 0.5);
    const normal = cross(sub(mid, center), tangent);

    return len(normal) < 1e-12 ? null : { origin: center, dir: norm(normal) };
  }
  // Circumcentre of start, mid, end.
  const a = sub(start, mid);
  const b = sub(end, mid);
  const planeNormal = cross(a, b);
  const nn = dot(planeNormal, planeNormal);
  if (nn < 1e-18) {
    return null;
  }
  const arcCenter = add(mid, scale(add(scale(cross(planeNormal, a), dot(b, b)), scale(cross(b, planeNormal), dot(a, a))), 1 / (2 * nn)));

  return { origin: arcCenter, dir: norm(planeNormal) };
}
