// A look ahead, drawn on the model in dashed yellow: what a tool would do to
// what is picked, shown while the pointer is over the tool (before anything
// is started) - a face's outline lifted for Extrude, the lines a round would
// run between for Fillet, a row of boxes for a pattern. Nothing is computed
// by the kernel for it: it is a sketch of the change, from what the view
// already has, so it comes up at once.

import { BufferGeometry, Float32BufferAttribute, LineDashedMaterial, LineSegments } from 'three';
import { add, cross, dot, len, norm, scale, sub, toWorld } from '../geom';
import { entityPolylines } from '../sketch/curves';
import { edgesOfFace, sourceFrame, sourcesOf, type AppContext, type Sel } from './tool';
import type { Viewport } from '../view/viewport';
import type { Vec3 } from '../doc/types';

const YELLOW = 0xffd23a;

/** Line segments (pairs of points, flat) in dashed yellow, over everything. Dashes keep their size on screen. */
export class Ghost {
  private mat = new LineDashedMaterial({ color: YELLOW, depthTest: false, transparent: true, opacity: 0.95, dashSize: 1, gapSize: 1 });
  private line = new LineSegments(new BufferGeometry(), this.mat);
  private wpp = 0;
  private onFrame = () => this.dashes();

  constructor(private view: Viewport, segs: number[]) {
    this.line.renderOrder = 48;
    this.line.frustumCulled = false;
    this.line.geometry.setAttribute('position', new Float32BufferAttribute(segs, 3));
    this.line.computeLineDistances();
    this.dashes();
    view.overlay.add(this.line);
    view.frameHooks.add(this.onFrame);
    view.helpers.add(this);
    view.requestRender();
  }

  private dashes(): void {
    const worldPerPixel = this.view.cam.worldPerPixel(this.view.height);
    if (Math.abs(worldPerPixel - this.wpp) < this.wpp * 0.02) {
      return;
    }
    this.wpp = worldPerPixel;
    this.mat.dashSize = worldPerPixel * 7;
    this.mat.gapSize = worldPerPixel * 5;
  }

  dispose(): void {
    this.view.helpers.delete(this);
    this.view.frameHooks.delete(this.onFrame);
    this.view.overlay.remove(this.line);
    this.line.geometry.dispose();
    this.mat.dispose();
    this.view.requestRender();
  }
}

type Segs = number[];
const seg = (out: Segs, a: Vec3, b: Vec3) => void out.push(a[0], a[1], a[2], b[0], b[1], b[2]);
const moved = (segs: Segs, offset: Vec3): Segs => segs.map((x, i) => x + offset[i % 3]);

/** The outline of a body's face, as the view drew its edges. */
function faceOutline(app: AppContext, body: string, face: number): Segs {
  const bodyMesh = app.view.body(body);
  if (!bodyMesh) {
    return [];
  }
  const out: Segs = [];
  const of = new Set(edgesOfFace(app, body, face));
  for (const edgeGroup of bodyMesh.edgeGroups) {
    if (of.has(edgeGroup.edge)) {
      for (let j = edgeGroup.start * 3; j < (edgeGroup.start + edgeGroup.count) * 3; j++) {
        out.push(bodyMesh.edgePositions[j]);
      }
    }
  }

  return out;
}

/** The box round some bodies: its twelve edges, and its middle. */
export function bodiesBox(app: AppContext, ids: string[]): { lo: Vec3; hi: Vec3; mid: Vec3; segs: Segs } | null {
  const lo: Vec3 = [Infinity, Infinity, Infinity];
  const hi: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const id of ids) {
    const positions = app.view.body(id)?.positions;
    if (!positions) {
      continue;
    }
    for (let i = 0; i < positions.length; i++) {
      const axis = i % 3;
      if (positions[i] < lo[axis]) {
        lo[axis] = positions[i];
      }
      if (positions[i] > hi[axis]) {
        hi[axis] = positions[i];
      }
    }
  }
  if (!Number.isFinite(lo[0])) {
    return null;
  }
  const corner = (i: number): Vec3 => [i & 1 ? hi[0] : lo[0], i & 2 ? hi[1] : lo[1], i & 4 ? hi[2] : lo[2]];
  const segs: Segs = [];
  for (const [a, b] of [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]]) {
    seg(segs, corner(a), corner(b));
  }

  return { lo, hi, mid: scale(add(lo, hi), 0.5), segs };
}

/** A row of copies: the bodies' box again and again along `dir`, and the line they go along. */
export function rowGhost(app: AppContext, ids: string[], dir: Vec3, spacing: number, count: number): Segs {
  const box = bodiesBox(app, ids);
  if (!box) {
    return [];
  }
  const direction = norm(dir);
  const out: Segs = [];
  for (let copyIndex = 1; copyIndex < count; copyIndex++) {
    out.push(...moved(box.segs, scale(direction, spacing * copyIndex)));
  }
  seg(out, box.mid, add(box.mid, scale(direction, spacing * (count - 1))));

  return out;
}

/** A ring of copies: the bodies' box turned about the axis, and the circle its middle goes round. */
export function ringGhost(app: AppContext, ids: string[], axis: { origin: Vec3; dir: Vec3 }, angle: number, count: number): Segs {
  const box = bodiesBox(app, ids);
  if (!box) {
    return [];
  }
  const direction = norm(axis.dir);
  const turn = (point: Vec3, deg: number): Vec3 => {
    const a = (deg * Math.PI) / 180;
    const offset = sub(point, axis.origin);
    const along = scale(direction, dot(offset, direction));
    const flat = sub(offset, along);

    return add(axis.origin, add(along, add(scale(flat, Math.cos(a)), scale(cross(direction, flat), Math.sin(a)))));
  };
  const full = Math.abs(Math.abs(angle) - 360) < 1e-6;
  const step = angle / (full ? count : Math.max(1, count - 1));
  const out: Segs = [];
  for (let copyIndex = 1; copyIndex < count; copyIndex++) {
    for (let i = 0; i < box.segs.length; i += 3) {
      out.push(...turn([box.segs[i], box.segs[i + 1], box.segs[i + 2]], step * copyIndex));
    }
  }
  // (The circle: only where the bodies are off the axis.)
  if (len(sub(box.mid, turn(box.mid, 180))) > 1e-6) {
    for (let step = 0; step < 48; step++) {
      seg(out, turn(box.mid, (angle * step) / 48), turn(box.mid, (angle * (step + 1)) / 48));
    }
  }

  return out;
}

/**
 * What the tool `id` would do to what is picked, as dashed lines - or nothing,
 * where there is no telling picture of it (most tools: those say what they do
 * by name).
 */
export function peekSegs(app: AppContext, id: string, sel: Sel[]): Segs {
  const highlight = sel[0];
  if (!highlight) {
    return [];
  }
  const out: Segs = [];
  if (highlight.kind === 'face' && (id === 'extrude' || id === 'offsetFace' || id === 'offset' || id === 'shell' || id === 'thicken')) {
    const face = app.view.body(highlight.body)?.faces[highlight.face];
    if (!face) {
      return [];
    }
    const outline = faceOutline(app, highlight.body, highlight.face);
    // (Out by about a third of the face's size; Shell: in, by a wall.)
    const depth = Math.sqrt(face.area) * (id === 'shell' ? -0.12 : 0.35);
    const offset = scale(face.normal, depth);
    out.push(...moved(outline, offset));
    // (Up from the outline's corners - every few points of a round one.)
    const stride = Math.max(1, Math.floor(outline.length / 6 / 12));
    for (let i = 0; i < outline.length; i += 6 * stride) {
      seg(out, [outline[i], outline[i + 1], outline[i + 2]], add([outline[i], outline[i + 1], outline[i + 2]], offset));
    }

    return out;
  }
  if (highlight.kind === 'profile' && (id === 'extrude' || id === 'revolve')) {
    if (id !== 'extrude') {
      return [];
    }
    const src = sourcesOf(app, sel)[0];
    const plane = app.sketchPlane(highlight.sketch);
    if (!src || !plane) {
      return [];
    }
    const fr = sourceFrame(app, src);
    const flat: Segs = [];
    for (const e of app.sketchCurves(highlight.sketch)) {
      if (e.construction) {
        continue;
      }
      for (const poly of entityPolylines(e)) {
        for (let i = 0; i + 1 < poly.length; i++) {
          seg(flat, toWorld(plane, poly[i]), toWorld(plane, poly[i + 1]));
        }
      }
    }
    let size = 0;
    for (let i = 0; i < flat.length; i += 3) {
      size = Math.max(size, len(sub([flat[i], flat[i + 1], flat[i + 2]], fr.base)));
    }
    const offset = scale(fr.normal, Math.max(size * 0.6, 1e-3));
    out.push(...moved(flat, offset));
    const stride = Math.max(1, Math.floor(flat.length / 6 / 12));
    for (let i = 0; i < flat.length; i += 6 * stride) {
      seg(out, [flat[i], flat[i + 1], flat[i + 2]], add([flat[i], flat[i + 1], flat[i + 2]], offset));
    }

    return out;
  }
  if (highlight.kind === 'edge' && (id === 'fillet' || id === 'chamfer')) {
    const bodyMesh = app.view.body(highlight.body);
    if (!bodyMesh || bodyMesh.faces.length > 400) {
      return [];
    }
    for (const one of sel) {
      if (one.kind !== 'edge' || one.body !== highlight.body) {
        continue;
      }
      const e = bodyMesh.edges[one.edge];
      if (!e || e.type !== 'LINE') {
        continue;
      }
      // The two flat faces the edge is between, and the way into each from the edge.
      const into: Vec3[] = [];
      for (let faceIndex = 0; faceIndex < bodyMesh.faces.length && into.length < 2; faceIndex++) {
        const face = bodyMesh.faces[faceIndex];
        if (!face.plane || Math.abs(dot(face.normal, e.dir)) > 1e-3 || Math.abs(dot(sub(e.mid, face.center), face.normal)) > 1e-4) {
          continue;
        }
        if (!edgesOfFace(app, highlight.body, faceIndex).includes(one.edge)) {
          continue;
        }
        const side = norm(cross(face.normal, e.dir));
        into.push(dot(side, sub(face.center, e.mid)) < 0 ? scale(side, -1) : side);
      }
      if (into.length < 2) {
        continue;
      }
      const setback = Math.min(e.length * 0.25, Math.sqrt(Math.min(...bodyMesh.faces.map(face => face.area))) * 0.5);
      const a = (point: Vec3) => add(point, scale(into[0], setback));
      const b = (point: Vec3) => add(point, scale(into[1], setback));
      seg(out, a(e.start), a(e.end));
      seg(out, b(e.start), b(e.end));
      for (const point of [e.start, e.end]) {
        if (id === 'chamfer') {
          seg(out, a(point), b(point));
        } else {
          // (The round's end: from one line to the other, bowed towards the edge.)
          const q = (t: number): Vec3 => add(add(scale(a(point), (1 - t) * (1 - t)), scale(point, 2 * t * (1 - t) * 0.83 + 0)), add(scale(add(a(point), b(point)), t * (1 - t) * 0.17), scale(b(point), t * t)));
          for (let step = 0; step < 8; step++) {
            seg(out, q(step / 8), q((step + 1) / 8));
          }
        }
      }
    }

    return out;
  }
  if (highlight.kind === 'body' && (id === 'patl' || id === 'patc')) {
    const ids = sel.flatMap(highlight => (highlight.kind === 'body' ? [highlight.body] : []));
    const box = bodiesBox(app, ids);
    if (!box) {
      return [];
    }
    if (id === 'patl') {
      return rowGhost(app, ids, [1, 0, 0], (box.hi[0] - box.lo[0]) * 1.5 || 10, 3);
    }

    return ringGhost(app, ids, { origin: [0, 0, 0], dir: [0, 0, 1] }, 360, 6);
  }

  return out;
}
