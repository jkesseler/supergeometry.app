import { arrangement, materialRegions, pointInRegion, regionRef, type Region } from '../sketch/regions';
import { pointInPoly } from '../sketch/curves';
import { settings } from '../settings';
import type { DocStore } from '../doc/store';
import type { EdgeRef, ExtrudeSource, FaceRef, Feature, PinDef, PlaneDef, SketchEntity, SketchFeature, Vec3 } from '../doc/types';
import type { KernelClient } from '../kernel/client';
import type { RegenResult } from '../kernel/protocol';
import type { MenuRow, ToolItem, UI } from '../ui/ui';
import type { PointerHandler } from '../view/input';
import type { Highlight, PickHit, Viewport } from '../view/viewport';

/** Something selected in the viewport. Same shape as a highlight. */
export type Sel = Highlight;

export interface Tool extends PointerHandler {
  readonly id: string;
  /** Sketch being edited, so the viewport can draw it as active. */
  readonly activeSketch?: string;
  /** Feature being created/edited (highlighted in History). */
  readonly editingId?: string;
  enter?(): void;
  exit?(): void;
  /** Return true when the key was handled. */
  key?(e: KeyboardEvent): boolean;
  /** Ctrl + A: pick everything the tool picks from. False: it has nothing of the kind. */
  selectAll?(): boolean;
  /** Keys typed while a drag is held (type an exact value; Enter finishes). */
  dragKey?(e: KeyboardEvent): boolean;
  /** Called after every regeneration (committed or preview). */
  refresh?(): void;
  /**
   * The tool's own steps, before anything is committed (a freeform cage being
   * shaped): Undo/Redo take these back first, and never the project's steps
   * underneath while the tool is open. Return true when a step was taken back.
   */
  undo?(): boolean;
  redo?(): boolean;
  readonly canUndo?: boolean;
  readonly canRedo?: boolean;
}

export interface AppContext {
  /** The row of view tools at the bottom (Section View, Measure, Variables, Isolate). */
  bottomTools(): ToolItem[];
  readonly store: DocStore;
  readonly kernel: KernelClient;
  readonly view: Viewport;
  readonly ui: UI;
  readonly result: RegenResult | null;
  readonly selection: Sel[];
  /** Thread the selected round face. */
  startThread(): void;
  /** Hole on the flat face picked, where it was tapped. */
  startHole(): void;
  /** Open a step of the history to change it (as tapping it in History does). */
  editStep(id: string): void;
  setSelection(sel: Sel[]): void;
  setHover(h: Sel | null): void;
  /** null returns to the selection tool. */
  setTool(tool: Tool | null): void;
  /** The tool's own undo steps changed: refresh the Undo/Redo buttons. */
  refreshUndo(): void;
  /** Show the model as if `features` were the document (live preview). */
  preview(features: Feature[]): Promise<RegenResult | null>;
  /** Current plane of a sketch (sketches on faces follow the face). */
  sketchPlane(id: string): PlaneDef | undefined;
  /** A sketch's curves plus the outline of the face it sits on (what regions are made of). */
  sketchCurves(id: string): SketchEntity[];
  mainTools(): ToolItem[];
  /** The first model on its way: a shape drawn, nothing solid yet - Extrude is the next step (it pulses). */
  firstShape(): boolean;
  bottomTools(): ToolItem[];
  /** Pin a measurement in 3D (saved with the project). */
  addPin(pin: PinDef): void;
  /** Bodies shown alone, or null when nothing is isolated. */
  readonly isolated: string[] | null;
  isolate(bodies: string[] | null): void;
  /** Reveal in Items: the Items panel opens at these rows. */
  revealInItems(ids: string[]): void;
}

/** Index of the body face matching a stored reference (by centre and normal). */
export function faceIndexOf(app: AppContext, ref: FaceRef): number | null {
  const faces = app.view.body(ref.body)?.faces ?? [];
  let best: { i: number; d: number } | null = null;
  faces.forEach((face, i) => {
    const align = face.normal[0] * ref.normal[0] + face.normal[1] * ref.normal[1] + face.normal[2] * ref.normal[2];
    if (align < 0.99) {
      return;
    }
    const distance = Math.hypot(face.center[0] - ref.center[0], face.center[1] - ref.center[1], face.center[2] - ref.center[2]);
    if (!best || distance < best.d) {
      best = { i, d: distance };
    }
  });

  return best ? (best as { i: number }).i : null;
}

/**
 * The nearest parallel face of the same body facing the other way, behind a
 * flat face: "total" thickness for push/pull (like the distance to the bottom).
 */
export function oppositeFace(app: AppContext, body: string, face: number): { distance: number; point: Vec3 } | null {
  const b = app.view.body(body);
  const faceInfo = b?.faces[face];
  if (!b || !faceInfo?.plane) {
    return null;
  }
  let best: number | null = null;
  for (const face of b.faces) {
    if (!face.plane) {
      continue;
    }
    const cosine = faceInfo.normal[0] * face.normal[0] + faceInfo.normal[1] * face.normal[1] + faceInfo.normal[2] * face.normal[2];
    if (cosine > -0.999) {
      continue;
    }
    const t = faceInfo.normal[0] * (faceInfo.center[0] - face.center[0]) + faceInfo.normal[1] * (faceInfo.center[1] - face.center[1]) + faceInfo.normal[2] * (faceInfo.center[2] - face.center[2]);
    if (t > 1e-9 && (best === null || t < best)) {
      best = t;
    }
  }
  if (best === null) {
    return null;
  }

  return { distance: best, point: [faceInfo.center[0] - faceInfo.normal[0] * best, faceInfo.center[1] - faceInfo.normal[1] * best, faceInfo.center[2] - faceInfo.normal[2] * best] };
}

export function sameSel(a: Sel, b: Sel): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function hitToSel(hit: PickHit | null): Sel | null {
  if (!hit) {
    return null;
  }
  const { point: _p, ...rest } = hit;

  return rest as Sel;
}

// -------------------------------------------------- selection → references

export function faceRefOf(app: AppContext, facePick: { body: string; face: number }): FaceRef | null {
  const info = app.view.body(facePick.body)?.faces[facePick.face];

  return info ? { body: facePick.body, center: info.center, normal: info.normal, area: info.area, ...(info.step ? { step: info.step } : {}), ...(info.curve ? { curve: info.curve } : {}) } : null;
}

/**
 * Picks whose face or edge is gone from the model as it is now (the step that
 * made it switched off or changed): what the step said with "pick it again".
 * Only picks that know their step can tell (older ones are kept).
 */
export function goneRefs<R extends FaceRef | EdgeRef>(app: AppContext, refs: R[], step: string): R[] {
  // Only for a step that says so: one that worked shows the model after it,
  // where what it worked on (an edge it rounded, a face it opened) is gone by design.
  if (!app.result?.errors.some(e => e.featureId === step && / is gone /.test(e.message))) {
    return [];
  }

  return refs.filter((ref) => {

    const b = app.view.body(ref.body);
    if (!b) {
      return true;
    }
    // (Or the step it was put down to when the pick was saved: a Move the body went through.)
    if ('step' in ref && ref.step) {
      return !b.faces.some(face => face.step === ref.step || face.was === ref.step);
    }
    if ('steps' in ref && ref.steps) {
      return !b.edges.some(e => e.steps?.join() === ref.steps!.join() || e.was?.join() === ref.steps!.join());
    }

    return false;
  });
}

export function edgeRefOf(
  app: AppContext, edgePick: { body: string; edge: number }): EdgeRef | null {
  const info = app.view.body(edgePick.body)?.edges[edgePick.edge];

  return info ? { body: edgePick.body, mid: info.mid, dir: info.dir, length: info.length, ...(info.steps ? { steps: info.steps } : {}), ...(info.curves ? { curves: info.curves } : {}) } : null;

}

/**
 * The edges round a face (its outline and its holes'), by index: those whose
 * drawn points are all corners of its triangles (the face's mesh and the
 * edges' lines are cut from one tessellation, so they share their points).
 */
export function edgesOfFace(app: AppContext, body: string, face: number): number[] {
  const bodyMesh = app.view.body(body);
  const faceGroup = bodyMesh?.faceGroups.find(faceGroup => faceGroup.face === face);
  if (!bodyMesh || !faceGroup) {
    return [];
  }
  const key = (a: ArrayLike<number>, i: number) => `${Math.round(a[3 * i] * 1e4)},${Math.round(a[3 * i + 1] * 1e4)},${Math.round(a[3 * i + 2] * 1e4)}`;
  const corners = new Set<string>();
  for (let start = faceGroup.start; start < faceGroup.start + faceGroup.count; start++) {
    corners.add(key(bodyMesh.positions, bodyMesh.indices[start]));
  }

  return bodyMesh.edgeGroups
    .filter((eg) => {
      if (!eg.count) {
        return false;
      }
      for (let j = eg.start; j < eg.start + eg.count; j++) {
        if (!corners.has(key(bodyMesh.edgePositions, j))) {
          return false;
        }
      }

      return true;
    })
    .map(eg => eg.edge);
}

/** A selected profile or flat face as something extrude/revolve/… can use. */
export function sourcesOf(app: AppContext, sel: Sel[]): ExtrudeSource[] {
  const out: ExtrudeSource[] = [];
  const bySketch = new Map<string, number[]>();
  for (const highlight of sel) {
    if (highlight.kind === 'profile') {
      bySketch.set(highlight.sketch, [...(bySketch.get(highlight.sketch) ?? []), highlight.region]);
    }
    if (highlight.kind === 'face') {
      const faceRef = faceRefOf(app, highlight);
      if (faceRef) {
        out.push({ kind: 'face', face: faceRef });
      }
    }
  }
  for (const [sketch, idx] of bySketch) {
    const sk = app.store.find<SketchFeature>(sketch);
    if (!sk) {
      continue;
    }
    const curves = app.sketchCurves(sketch);
    const regions = arrangement(curves).regions;
    out.unshift({ kind: 'profile', sketch, regions: wholeShapes(regions, idx.map(i => regions[i]).filter(Boolean), sk.entities, curves).map(regionRef) });
  }

  return out;
}

/**
 * In a sketch on a face, the face's outline cuts what was drawn into pieces. A
 * piece tapped off the face is the whole shape drawn (a flange drawn round a
 * pylon's top came out as a ring - the pylon's top left 6 deep in it); a piece
 * on the face stays just that piece (a window drawn on a wall).
 */
function wholeShapes(all: Region[], tapped: Region[], drawnEntities: SketchEntity[], curves: SketchEntity[]): Region[] {
  const outline = curves.filter(e => e.id.startsWith('bnd-'));
  if (!outline.length || !tapped.length) {
    return tapped;
  }
  const inside = (region: Region, q: [number, number]) => pointInPoly(q, region.outer.poly) && !region.holes.some(hole => pointInPoly(q, hole.poly));
  let onFace: Region[];
  let drawn: Region[];
  try {
    onFace = materialRegions(arrangement(outline));
    drawn = materialRegions(arrangement(drawnEntities));
  } catch {
    return tapped;
  }
  const out = new Set<Region>();
  for (const region of tapped) {
    const q = pointInRegion(region);
    const shape = onFace.some(candidate => inside(candidate, q)) ? null : drawn.find(candidate => inside(candidate, q));
    if (!shape) {
      out.add(region);
      continue;
    }
    for (const a of all) {
      if (inside(shape, pointInRegion(a))) {
        out.add(a);
      }
    }
  }

  return [...out];
}

/**
 * A point on a curved face (its centre is off the face - on a cylinder's axis)
 * and the normal there: the mesh vertex nearest the centre on the side facing the viewer.
 */
export function faceAnchor(app: AppContext, body: string, face: number): { base: Vec3; normal: Vec3 } | null {
  const b = app.view.body(body);
  const faceGroup = b?.faceGroups.find(faceGroup => faceGroup.face === face);
  const info = b?.faces[face];
  if (!b || !faceGroup || !info) {
    return null;
  }
  const view = app.view.cam.viewDir().toArray() as Vec3;
  let best: { base: Vec3; normal: Vec3; score: number } | null = null;
  // The way out of the material, from each triangle's winding (the stored
  // vertex normals point the wrong way on faces OpenCascade keeps reversed,
  // e.g. a hole's wall - the arrow then pointed into the material).
  const vertexAt = (i: number): Vec3 => {
    const offset = b.indices[i] * 3;

    return [b.positions[offset], b.positions[offset + 1], b.positions[offset + 2]];
  };
  for (let i = faceGroup.start; i + 2 < faceGroup.start + faceGroup.count; i += 3) {
    const [a, vertexB, e] = [vertexAt(i), vertexAt(i + 1), vertexAt(i + 2)];
    const edgeU: Vec3 = [vertexB[0] - a[0], vertexB[1] - a[1], vertexB[2] - a[2]];
    const edgeV: Vec3 = [e[0] - a[0], e[1] - a[1], e[2] - a[2]];
    const cr: Vec3 = [edgeU[1] * edgeV[2] - edgeU[2] * edgeV[1], edgeU[2] * edgeV[0] - edgeU[0] * edgeV[2], edgeU[0] * edgeV[1] - edgeU[1] * edgeV[0]];
    const length = Math.hypot(...cr);
    if (length < 1e-12) {
      continue;
    }
    const normal: Vec3 = [cr[0] / length, cr[1] / length, cr[2] / length];
    const centroid: Vec3 = [(a[0] + vertexB[0] + e[0]) / 3, (a[1] + vertexB[1] + e[1]) / 3, (a[2] + vertexB[2] + e[2]) / 3];
    const facing = normal[0] * view[0] + normal[1] * view[1] + normal[2] * view[2];
    const distance = Math.hypot(centroid[0] - info.center[0], centroid[1] - info.center[1], centroid[2] - info.center[2]);
    const score = distance + (facing > 0 ? 1e6 : 0);
    if (!best || score < best.score) {
      best = { base: centroid, normal: normal, score };
    }
  }

  return best && { base: best.base, normal: best.normal };
}

/** Point + normal of a source, for placing handles. */
export function sourceFrame(app: AppContext, src: ExtrudeSource): { base: Vec3; normal: Vec3 } {
  if (src.kind === 'face') {
    const faceIndex = faceIndexOf(app, src.face);
    const info = faceIndex !== null ? app.view.body(src.face.body)?.faces[faceIndex] : undefined;
    if (faceIndex !== null && info && !info.plane) {
      return faceAnchor(app, src.face.body, faceIndex) ?? { base: src.face.center, normal: src.face.normal };
    }

    return { base: src.face.center, normal: src.face.normal };
  }
  const plane = app.sketchPlane(src.sketch);
  if (!plane) {
    return { base: [0, 0, 0], normal: [0, 0, 1] };
  }
  const center = src.regions[0]?.c ?? [0, 0];
  const y: Vec3 = [
    plane.normal[1] * plane.xDir[2] - plane.normal[2] * plane.xDir[1],
    plane.normal[2] * plane.xDir[0] - plane.normal[0] * plane.xDir[2],
    plane.normal[0] * plane.xDir[1] - plane.normal[1] * plane.xDir[0]
  ];

  return {
    base: [plane.origin[0] + plane.xDir[0] * center[0] + y[0] * center[1], plane.origin[1] + plane.xDir[1] * center[0] + y[1] * center[1], plane.origin[2] + plane.xDir[2] * center[0] + y[2] * center[1]],
    normal: plane.normal
  };
}

/** Body that a source "sits on" (joins/cuts default to it). */
export function targetOf(app: AppContext, src: ExtrudeSource): string | undefined {
  if (src.kind === 'face') {
    return src.face.body;
  }
  const on = app.store.find<SketchFeature>(src.sketch)?.attachedTo?.body;
  if (on) {
    return on;
  }
  // Drawn on its own, but a body was made from the same region of it (a cookie
  // cutter's wall, 2 high with its flange, then taken on up to 15): that body.
  // Auto otherwise cut the region out of it, and what went past wasn't added.
  const key = (region: { c: number[]; k?: string[] }) => (region.k?.length ? [...region.k].sort().join('|') : region.c.map(value => value.toFixed(3)).join(','));
  const mine = new Set(src.regions.map(key));
  for (const feature of app.store.features) {
    if ((feature.type !== 'extrude' && feature.type !== 'revolve' && feature.type !== 'sweep') || feature.source.kind !== 'profile' || feature.source.sketch !== src.sketch || feature.mode === 'cut' || feature.mode === 'intersect') {
      continue;
    }
    if (!feature.source.regions.some(region => mine.has(key(region)))) {
      continue;
    }
    const body = feature.target ?? feature.id;
    if (app.view.body(body)) {
      return body;
    }
  }

  return undefined;
}

/** Bodies referenced by the selection (faces/edges/vertices count for their body). */
export function bodiesOf(sel: Sel[]): string[] {
  const ids = sel.flatMap(highlight => (highlight.kind === 'body' || highlight.kind === 'face' || highlight.kind === 'edge' || highlight.kind === 'vertex' ? [highlight.body] : []));

  return [...new Set(ids)];
}

/**
 * The right-click menu on the model: the caller's rows first (a tool's Done /
 * Cancel, a selection's tools), then the view's: Zoom to Fit and the
 * on/off view switches. (x, y): the pointer, in the canvas's pixels.
 */
export function viewMenu(app: AppContext, x: number, y: number, head: (MenuRow | '-')[]): void {
  const rect = app.view.canvas.getBoundingClientRect();
  const value = settings.value;
  const flip = (key: 'showGrid' | 'showAxes' | 'showEdges' | 'showHiddenEdges', label: string): MenuRow => ({ label, checked: value[key], run: () => settings.set(key, !settings.value[key]) });
  app.ui.menu(rect.left + x, rect.top + y, [
    ...head,
    ...(head.length ? (['-'] as const) : []),
    { label: 'Zoom to Fit', shortcut: 'F', run: () => app.view.fitAll() },
    { label: 'Select Through', shortcut: 'Ctrl+Shift+S', checked: app.view.selectThrough, run: () => app.view.setSelectThrough(!app.view.selectThrough) },
    flip('showGrid', 'Show Grid'),
    flip('showAxes', 'Show World Axes'),
    flip('showEdges', 'Show Edges'),
    flip('showHiddenEdges', 'Show Hidden Edges')
  ]);
}
