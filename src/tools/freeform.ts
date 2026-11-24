// Freeform: shape a smooth body by pulling its control cage. Tap cage points,
// edges or faces (Shift adds; on a touch screen every tap adds), then drag the
// gimbal - or type a value while dragging, or exact Move / Turn / Scale values
// in the card. The smooth surface updates live; Done turns it into a body.
// Undo/Redo step through the cage changes made here.
//
// Freeform Face uses it too: a flat face of a body gets a cage laid over it
// (its border round the face's edge, which stays put) and the inside points,
// edges and faces are moved the same way; Done makes the face that shape.

import { Box3, BufferAttribute, BufferGeometry, DoubleSide, Sprite, LineBasicMaterial, LineSegments, type Material, Mesh, MeshBasicMaterial, MeshStandardMaterial, Points, Raycaster, Vector2, Vector3 } from 'three';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { faceCage, facesNormal, liftOnto, onCorners, toFaces } from '../freeform/faceGrid';
import { carryCreases, edgeLoopOf, removeEdgeLoop, withCreases } from '../freeform/cage';
import { applyPlan, archBridge, planeCage, borderChains, cachedPlan, planIndices, smoothNormals, type SubdivPlan, bridgeChains, bridgeFaces, moveTurnScale, shapeCage, sweepFace, type Chain, boundaryEdges, bridgeLoops, cageEdgeKey, extendBorder, cageEdges, deleteFaces, extrudeFaces, fillHole, holeLoops, insertEdgeLoop, insetFaces, isClosed, primitiveCage, refineCage, selfCrossings, subdivide, type Cage, type CagePrimitive } from '../freeform/cage';
import { add, cross, dot, len, niceStep, norm, scale, sub, xDirFor } from '../geom';
import { fmtLen } from '../units';
import { dotMaterial, planeMarkMaterial, PLANE_MARK_SIZE } from '../view/viewport';
import { isCoarse, screenClass } from '../device';
import { DragTyping, type DragTypingTarget } from './dragTyping';
import { Gimbal, GIMBAL_AXES, SCALE_PARTS, type GimbalPart } from './gimbal';
import { axisDrag } from './handles';
import { FillToPlaneOp } from './ops';
import type { ToolPointer } from '../view/input';
import type { PanelItem } from '../ui/ui';
import type { FaceFreeformFeature, Feature, FreeformEditFeature, FreeformFeature, PlaneDef, TransformFeature, Vec3 } from '../doc/types';
import type { AppContext, Sel, Tool } from './tool';

type Pick = { kind: 'vert'; i: number } | { kind: 'edge'; e: [number, number] } | { kind: 'face'; f: number };

/**
 * The step just taken, still being adjusted with sliders in the card (no
 * values to work out): the new shape's size, a face pulled out in steps
 * (Length, Bend, Taper), an inset (how far in), a bridge (how far it arches).
 * Re-made from `base` on every slider move; the next tap or step keeps it.
 */
type Live =
  | { kind: 'shape'; prim: 'box' | 'cylinder' | 'sphere' | 'torus'; size: Vec3; rows: number }
  /** A new flat surface on the plane picked: its width, depth and faces in the card. */
  | { kind: 'sheet'; size: [number, number]; rows: number; at: Vec3; x: Vec3; y: Vec3; n: Vec3 }
  | { kind: 'sweep'; base: Cage; face: number; steps: number; length: number; bend: number; taper: number; size: number }
  | { kind: 'inset'; base: Cage; faces: number[]; amount: number }
  | { kind: 'bridge'; base: Cage; fa: number; fb: number; arch: number; segments: number; span: number };

const SEL = 0xffa31a;
const HOVER = 0xffd27a;
/** Freeform Face's cage presets: this many cells across the face's longer way. */
export const FACE_GRIDS = [3, 5, 7, 9];

/** A face being shaped (Freeform Face): its step (cage relative to the face's middle), and the face's triangles to lay a cage over. */
export interface FaceShaping {
  feature: FaceFreeformFeature;
  /** Editing a step already in History (else a new one). */
  existing: boolean;
  tris: [Vec3, Vec3, Vec3][];
  /** How an edit is kept (see FreeformTool's `keep`). */
  keep?: EditKeep;
}

/**
 * How Done keeps an edit of a freeform made earlier: as a new Edit Freeform
 * step in History (the default), into an Edit Freeform step opened from
 * History (`edit`: its id), or into the step itself (`inPlace`: the step
 * opened from History).
 */
export type EditKeep = { edit?: string; inPlace?: boolean };

/**
 * A cage `n` across over a face's triangles (relative to `center`) - or, if
 * the face's outline won't take that many, the nearest coarser preset. Over
 * several faces side by side: laid seen along `normal` (their middle way), then
 * put down onto them - where they meet, the cage bends, and the smooth surface
 * through it rounds the corner off.
 */
export function layFaceCage(tris: [Vec3, Vec3, Vec3][], center: Vec3, normal: Vec3, divisions: number, several = false): { cage: Cage; n: number } | null {
  for (const grid of FACE_GRIDS.filter(gridSize => gridSize <= divisions).reverse()) {
    const cage = faceCage(tris, center, normal, grid);
    if (cage) {
      return { cage: several ? onCorners(liftOnto(cage, center, normal, tris), center, tris) : cage, n: grid };
    }
  }

  return null;
}

/** The way a Freeform Face step's faces face (one face: its normal; several: the middle of theirs). */
export function faceStepNormal(faceFreeform: FaceFreeformFeature): Vec3 {
  return faceFreeform.more?.length ? facesNormal([faceFreeform.face.normal, ...faceFreeform.more.map(faceRef => faceRef.normal)]) : norm(faceFreeform.face.normal);
}

/** "Pick in a box" (a finger draws the box): on until switched off. */
let boxByFinger = false;
/** Soft: how far round the picked points a move reaches (0: not at all). Kept for the next shape. */
let softRadius = 0;

export class FreeformTool implements Tool {
  readonly id = 'freeform';
  private cage: Cage;
  private existing?: FreeformFeature;
  private picks: Pick[] = [];
  private hovered: Pick | null = null;
  private gimbal: Gimbal | null = null;
  private dragging: { part: GimbalPart; from: ToolPointer; base: Vec3[]; center: Vec3; d: Vec3; ang: number; k: Vec3; r0: number; along?: Vec3; soft?: Map<number, number> } | null = null;
  /** What the gimbal up now is for (Move, Turn or Scale: its handles are that one's). */
  private gimbalFor = '';
  private typing: DragTyping;
  /** The card's exact values: what they act on (Move, Turn, Scale), and the points as they were before typing. */
  private xform: 'move' | 'turn' | 'scale' | 'place' = 'move';
  /**
   * A finger drawing a box picks the points inside it (seen through: the
   * ones behind too) - a whole slice of a shape in one go from a side view.
   * Off, a finger orbits as usual. (Kept on for the next shape.)
   */
  get boxByFinger(): boolean {
    return boxByFinger;
  }
  private fieldBase: Map<number, Vec3> | null = null;
  private fieldVals = [0, 0, 0, 1];
  private live: Live | null = null;
  private primKind: CagePrimitive | null = null;
  /** The last tap that picked a face (tap there again: the face behind it). */
  private lastFaceTap: { x: number; y: number; t: number; f: number } | null = null;
  /** Cage changes made in this edit, for Undo/Redo. */
  private past: { cage: Cage; picks: Pick[] }[] = [];
  private future: { cage: Cage; picks: Pick[] }[] = [];
  /** Moves applied to the body later in History: the cage is shown (and edited) where the body is. */
  private place: Placement = { fwd: vector => vector, inv: vector => vector };
  private surfaceSheet = false;
  private thickness = 0;
  private thickSide: 'up' | 'down' | 'both' = 'up';
  /** A new shape that spawned inside another body: first moved into place as a whole. */
  private placing = false;
  /** A new surface waiting for the plane it goes on. */
  private choosingPlane = false;
  /** Shaping a face of a body (Freeform Face), not a body of its own. */
  private face: FaceShaping | null = null;
  /** The gimbal's (and the drag's) axes: the world's, or along the face and out of it. */
  private axes: Vec3[] = GIMBAL_AXES;
  private lockedFor: Cage | null = null;
  private lockedSet = new Set<number>();
  /** The error the last preview of the face gave (shown in the hint). */
  private error: string | null = null;
  /** Closed (a preview that comes back after is dropped). */
  private gone = false;

  // Scene objects.
  private surface = new Mesh(new BufferGeometry(), new MeshStandardMaterial({ color: 0xb9c6dc, roughness: 0.5, metalness: 0.05, side: DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 }));
  /**
   * Where one face meets the next, drawn on the smooth surface itself:
   * without them the faces of a smooth shape all ran together, hard to tell
   * apart while picking. Hidden behind the surface where it turns away.
   */
  private faceEdges: LineSegments2;
  /** The cage's sharp edges, drawn over its lines. */
  private creaseLines: LineSegments2;
  /** Which surface points the face outlines join (pairs), for the layout shown. */
  private faceEdgeIdx: Uint32Array = new Uint32Array(0);
  /**
   * The cage: what's in front of the shape bright, what's behind it faint
   * (all of it equally bright, the far side's points crowded the near ones).
   * The bright pass is depth-tested, pulled toward the eye by `pull` (a tenth
   * of the shape's size): a point just under the surface in a hollow still
   * counts as in front. The faint pass is the same points drawn through everything.
   */
  private pull = { value: 1 };
  private lines = new LineSegments(new BufferGeometry(), pulled(new LineBasicMaterial({ color: 0x5f8fe8, transparent: true, opacity: 0.85 }), this.pull));
  private dots = new Points(new BufferGeometry(), pulled(dotMaterial({ color: 0xffffff, size: isCoarse ? 13 : 9, depthTest: true }), this.pull));
  private backLines = new LineSegments(this.lines.geometry, new LineBasicMaterial({ color: 0x5f8fe8, transparent: true, opacity: 0.16, depthTest: false }));
  private backDots = new Points(this.dots.geometry, faint(dotMaterial({ color: 0xffffff, size: isCoarse ? 11 : 8, opacity: 0.28 })));
  // Picked points / edges / faces stand out: thick lines (a plain line is
  // always 1 px), bigger dots, and picked faces filled.
  private marks: LineSegments2;
  private markDots = new Points(new BufferGeometry(), dotMaterial({ color: SEL, size: isCoarse ? 20 : 15 }));
  private hoverMarks: LineSegments2;
  private hoverDots = new Points(new BufferGeometry(), dotMaterial({ color: HOVER, size: isCoarse ? 18 : 14 }));
  /**
   * Symmetry: every point moved moves its mirror image too (across this plane);
   * points on the plane stay on it. `symPicking`: waiting for X / Y / Z or a
   * tapped cage edge (the plane across its middle).
   */
  private sym: { origin: Vec3; normal: Vec3 } | null = null;
  private symPicking = false;
  private symPairs: Map<number, number> | null = null;
  private symMark = new Sprite(planeMarkMaterial('symmetry'));
  private symPlane = new Mesh(new BufferGeometry(), new MeshBasicMaterial({ color: 0xb36bff, transparent: true, opacity: 0.1, depthTest: false, side: DoubleSide, depthWrite: false }));
  private markFill = new Mesh(new BufferGeometry(), new MeshBasicMaterial({ color: SEL, transparent: true, opacity: 0.35, depthTest: false, side: DoubleSide }));

  constructor(
    private app: AppContext,
    from: { primitive: CagePrimitive } | { feature: FreeformFeature; keep?: EditKeep } | { face: FaceShaping }
  ) {
    this.keep = ('keep' in from ? from.keep : 'face' in from ? from.face.keep : undefined) ?? {};
    if ('face' in from) {
      this.face = from.face;
      const feature = from.face.feature;
      this.cage = { faces: structuredClone(feature.cage.faces), verts: feature.cage.verts.map(vertex => add(feature.face.center, vertex)) };
      this.surfaceSheet = true;
      const normal = faceStepNormal(feature);
      const xDir = xDirFor(normal);
      this.axes = [xDir, norm(cross(normal, xDir)), normal];
    } else if ('feature' in from) {
      this.existing = from.feature;
      this.place = placementOf(app.store.features, from.feature.id);
      const copy = structuredClone(from.feature.cage);
      this.cage = { faces: copy.faces, verts: copy.verts.map(this.place.fwd), ...(copy.creases ? { creases: copy.creases } : {}) };
      this.surfaceSheet = !!from.feature.surface;
      this.thickness = from.feature.thickness ?? 0;
      this.thickSide = from.feature.thickSide ?? 'up';
      // The symmetry plane set last time: still there (and shown).
      const sy = from.feature.symmetry;
      if (sy) {
        const origin = this.place.fwd(sy.origin);
        this.sym = { origin: origin, normal: norm(sub(this.place.fwd(add(sy.origin, sy.normal)), origin)) };
      }
    } else {
      this.cage = primitiveCage(from.primitive);
      this.surfaceSheet = from.primitive === 'plane';
      this.primKind = from.primitive;
      // A new surface: first pick the plane (or flat face) it lies on, like a new sketch.
      this.choosingPlane = from.primitive === 'plane';
    }
    this.typing = new DragTyping(app);
    this.marks = new LineSegments2(new LineSegmentsGeometry(), app.view.lineMaterial(SEL, 4, false));
    this.hoverMarks = new LineSegments2(new LineSegmentsGeometry(), app.view.lineMaterial(HOVER, 2.5, false));
    this.faceEdges = new LineSegments2(new LineSegmentsGeometry(), app.view.lineMaterial(0x2f3b52, 1.6, true));
    this.creaseLines = new LineSegments2(new LineSegmentsGeometry(), app.view.lineMaterial(0xff8a3d, 3.2, true));
    this.creaseLines.renderOrder = 12;
    this.creaseLines.visible = false;
    this.markFill.renderOrder = 67;
    // Zoom to fit frames the cage being shaped (its points: the smooth shape lies inside them).
    this.dots.userData.fit = true;
    // The cage on top of everything (planes, other bodies, the gimbal).
    this.lines.renderOrder = 68;
    this.dots.renderOrder = 70;
    this.backLines.renderOrder = 66;
    this.backDots.renderOrder = 66.5;
    for (const lines of [this.marks, this.hoverMarks]) {
      lines.renderOrder = 69;
    }
    for (const points of [this.markDots, this.hoverDots]) {
      points.renderOrder = 71;
    }
  }

  private keep: EditKeep;

  get editingId(): string | undefined {
    return this.keep.edit ?? this.existing?.id ?? (this.face?.existing ? this.face.feature.id : undefined);
  }

  /** The edit of a step made earlier, kept as `keep` says. */
  private saveEdit(target: string, patch: FreeformEditFeature['patch']): void {
    const store = this.app.store;
    if (this.keep.edit) {
      store.update(this.keep.edit, { patch } as Partial<FreeformEditFeature>);
    } else if (this.keep.inPlace) {
      store.update(target, patch as Partial<FreeformFeature>);
    } else {
      store.add({ ...store.newIdentity('freeformEdit'), type: 'freeformEdit', target, patch });
    }
  }

  /** The steps as they would be with this edit kept (for a preview). */
  private withEdit(target: string, patch: FreeformEditFeature['patch']): Feature[] {
    const list = [...this.app.store.features];
    const at = (id: string) => list.findIndex(feature => feature.id === id);
    if (this.keep.edit && at(this.keep.edit) >= 0) {
      list[at(this.keep.edit)] = { ...(list[at(this.keep.edit)] as FreeformEditFeature), patch };
    } else if (this.keep.inPlace && at(target) >= 0) {
      list[at(target)] = { ...list[at(target)], ...patch } as Feature;
    } else {
      list.push({ id: 'freeform-edit-draft', name: 'Edit Freeform', type: 'freeformEdit', target, patch } as FreeformEditFeature);
    }

    return list;
  }

  /**
   * Freeform Face: the cage's border points (round the face's edge), which
   * stay put - picking them moves nothing. Worked out once per cage.
   */
  private locked(): Set<number> {
    if (!this.face) {
      return this.lockedSet;
    }
    if (this.lockedFor !== this.cage) {
      this.lockedFor = this.cage;
      this.lockedSet = new Set(boundaryEdges(this.cage).flat());
    }

    return this.lockedSet;
  }

  enter(): void {
    const view = this.app.view;
    if (this.sym) {
      queueMicrotask(() => this.drawSymPlane());
    }
    this.symMark.renderOrder = 72;
    this.symMark.visible = false;
    view.overlay.add(this.creaseLines);
    view.overlay.add(this.symPlane, this.symMark, this.surface, this.faceEdges, this.backLines, this.backDots, this.lines, this.dots, this.markFill, this.marks, this.markDots, this.hoverMarks, this.hoverDots);
    // Editing an existing freeform: hide its finished body while the cage is out.
    if (this.existing) {
      view.setHidden(new Set([...this.app.store.doc.hidden, this.existing.id]));
    }
    // A face: the body itself shows the shape (previewed), not a surface of the cage's own on top of it.
    if (this.face) {
      this.surface.visible = false;
    }
    this.app.setSelection([]);
    // Cancel is in the card (on a phone the card is one row without it: there it's in the column).
    this.app.ui.setTools(screenClass() === 'phone' ? [{ id: 'cancel', label: 'Cancel', icon: 'close', shortcut: 'Esc', run: () => this.cancel() }] : []);
    this.app.ui.setBottom([]);
    if (this.choosingPlane) {
      // Nothing shown yet: the origin planes (and flat faces) to put it on.
      for (const object of [this.surface, this.faceEdges, this.lines, this.dots, this.backLines, this.backDots]) {
        object.visible = false;
      }
      view.setOriginPlanesVisible(true);
      this.app.ui.setHint('Tap a plane or a flat face to put the shape on.');
      // The planes as buttons too (like Sketch): a plane behind a body, or the
      // floor among the three near the origin, is hard to hit with a finger.
      const on = (id: string) => () => {
        const plane = this.app.view.planeOf(id);
        if (plane && this.choosingPlane) {
          this.placeOn({ plane, at: plane.origin });
        }
      };
      this.app.ui.showPanel({
        title: 'Freeform surface',
        items: [
          { type: 'button', label: 'XY (floor)', onClick: on('XY') },
          { type: 'button', label: 'XZ (front)', onClick: on('XZ') },
          { type: 'button', label: 'YZ (side)', onClick: on('YZ') },
          ...view.construction.planes.map(plane => ({ type: 'button' as const, label: plane.name, onClick: on(plane.id) }))
        ],
        onCancel: () => this.cancel()
      });

      return;
    }
    this.startEditing();
  }

  /** Show the cage and the shape, ready to edit. */
  private startEditing(): void {
    // A new box, cylinder or sphere: its size and rows in the card first.
    if (!this.existing && this.primKind && this.primKind !== 'plane') {
      const prim = this.primKind;
      const size: Vec3 = prim === 'torus' ? [40, 40, 12] : [40, 40, 40];
      this.live = { kind: 'shape', prim, size, rows: 2 };
      this.cage = shapeCage(prim, size, 2);
    }
    this.rebuild();
    // A new shape inside another body (or a flat surface, which you'll want to place first): move it as a whole first.
    if (!this.existing && !this.face && (this.surfaceSheet || this.overlapsBodies())) {
      // Grab the whole shape first; point editing starts after it's been moved.
      this.placing = true;
      this.picks = this.cage.verts.map((_, i) => ({ kind: 'vert' as const, i }));
      this.drawMarks();
      this.placeGimbal();
    }
    this.panel();
    this.hint();
    // A new shape: framed, clear of the card (it used to appear tiny, half under it on a phone).
    if (!this.existing && !this.face) {
      const box = new Box3().setFromPoints(this.cage.verts.map(vertex => new Vector3(...vertex)));
      this.app.view.cam.fit(box, true, this.app.view.coveredInsets());
    }
  }

  /** Does the cage's box overlap any visible body's box? */
  private overlapsBodies(): boolean {
    const lo = [0, 1, 2].map(axis => Math.min(...this.cage.verts.map(vertex => vertex[axis])));
    const hi = [0, 1, 2].map(axis => Math.max(...this.cage.verts.map(vertex => vertex[axis])));
    const hidden = new Set(this.app.store.doc.hidden);

    return this.app.view.bodyList.some((b) => {
      if (hidden.has(b.id) || !b.positions.length) {
        return false;
      }
      for (let axis = 0; axis < 3; axis++) {
        let mn = Infinity;
        let mx = -Infinity;
        for (let i = axis; i < b.positions.length; i += 3) {
          mn = Math.min(mn, b.positions[i]);
          mx = Math.max(mx, b.positions[i]);
        }
        if (mx < lo[axis] || mn > hi[axis]) {
          return false;
        }
      }

      return true;
    });
  }

  exit(): void {
    this.gone = true;
    const view = this.app.view;
    view.setOriginPlanesVisible(false);
    // (A sprite's geometry is shared by every sprite: only taken off, not disposed.)
    view.overlay.remove(this.symMark);
    view.overlay.remove(this.faceEdges);
    view.overlay.remove(this.creaseLines);
    // (They share the front pass's points and lines: disposed with those.)
    view.overlay.remove(this.backLines, this.backDots);
    for (const object of [this.symPlane, this.surface, this.lines, this.dots, this.markFill, this.marks, this.markDots, this.hoverMarks, this.hoverDots]) {
      view.overlay.remove(object);
      object.geometry.dispose();
    }
    this.gimbal?.dispose();
    this.gimbal = null;
    view.setHidden(new Set(this.app.store.doc.hidden));
    this.app.ui.showPanel(null);
    this.app.ui.setHint(null);
    this.app.ui.setLabel(0, 0, null);
    this.typing.hideBox();
    for (const lines of [this.marks, this.hoverMarks, this.faceEdges, this.creaseLines]) {
      lines.geometry.dispose();
      view.releaseLineMaterial(lines.material);
    }
    view.requestRender();
  }

  private hint(): void {
    if (this.face) {
      const more = isCoarse ? 'tap more to add' : 'Shift+tap adds';

      return this.app.ui.setHint(
        this.error
          ? `⚠ ${this.error}`
          : this.selectedVerts().length
            ? `Drag the arrows (along the face, or out of it), or type exact values; ${more}. Tap empty space to let go.`
            : this.picks.length
              ? "Those are on the face's edge, which stays put - pick points, edges or faces inside it."
              : "Tap the frame's points, edges or faces to pick them, then drag. Its border stays on the face's edge."
      );
    }
    if (this.placing) {
      return this.app.ui.setHint('First drag the arrows to put it in place. Then tap its points, edges or faces to shape it.');
    }
    // A phone has no Shift: there every tap adds, a second tap drops it.
    if (this.live && this.live.kind !== 'shape' && this.live.kind !== 'sheet') {
      return this.app.ui.setHint('Shape it with its values on the line at the bottom. Tap the model to keep it.');
    }
    if (this.live) {
      return this.app.ui.setHint('Set the size and rows on the line at the bottom, then tap faces to shape it.');
    }
    const more = isCoarse ? 'Tap more to add; tap a face again for the one behind it' : 'Shift+tap adds; click a face again for the one behind it';
    this.app.ui.setHint(
      this.picks.length
        ? `Drag the arrows, or type exact values. ${more}. Tap empty space to let go.`
        : 'Tap the points, edges or faces of the frame around it to pick them, then drag. Done turns it into a body.'
    );
  }

  private panel(): void {
    const count = this.selectedVerts().length;
    const items: PanelItem[] = this.liveItems();
    if (count && (!this.live || this.live.kind === 'shape' || this.live.kind === 'sheet')) {
      // Exact values (a phone can't type while dragging), from where the points are now.
      this.fieldBase = null;
      // Nothing moved yet: no offset, no turn - and every scale factor 1 (0 flattened the points).
      this.fieldVals = this.xform === 'scale' ? [1, 1, 1, 1] : [0, 0, 0, 1];
      items.push({ type: 'choice', options: [{ id: 'move', label: 'Move' }, { id: 'turn', label: 'Turn' }, { id: 'scale', label: 'Scale' }, { id: 'place', label: 'Place at' }], value: this.xform, onChange: value => ((this.xform = value as typeof this.xform), this.panel(), this.placeGimbal()) });
      if (this.xform === 'place') {
        // Where the picked points are (their middle), to type where they should be: X, Y and Z from the origin.
        const at = this.centroid(this.selectedVerts());
        for (const [axis, a] of ['X', 'Y', 'Z'].entries()) {
          items.push({ type: 'number', label: a, value: Math.round(at[axis] * 1000) / 1000, kind: 'length', onInput: value => this.placeAt(axis, value) });
        }
      } else if (this.xform === 'scale') {
        items.push({ type: 'number', label: 'All', value: 1, kind: 'number', min: 0.01, onInput: value => this.setField(3, value) });
        for (const [axis, a] of ['X', 'Y', 'Z'].entries()) {
          items.push({ type: 'number', label: a, value: 1, kind: 'number', min: 0.01, onInput: value => this.setField(axis, value) });
        }
      } else {
        const turn = this.xform === 'turn';
        for (const [axis, a] of ['X', 'Y', 'Z'].entries()) {
          items.push({ type: 'number', label: turn ? `${a}°` : `Δ${a}`, value: 0, kind: turn ? 'angle' : 'length', onInput: value => this.setField(axis, value) });
        }
      }
    }
    // Soft: the points round the picked ones go along with a move, less the further off they are - a bump raised
    // by one point, not a spike. (0: only what is picked moves.)
    if (count && !this.face && (!this.live || this.live.kind === 'shape' || this.live.kind === 'sheet') && (this.xform === 'move' || this.xform === 'place')) {
      items.push({ type: 'number', label: 'Soft', value: softRadius, kind: 'length', min: 0, onInput: value => (softRadius = Math.max(0, value)) });
    }
    // A phone has no mouse to draw a box round the points: a finger draws it while this is on.
    if (isCoarse && !this.placing && (!this.live || this.live.kind === 'shape' || this.live.kind === 'sheet')) {
      items.push({
        type: 'toggle',
        label: 'Pick in a box',
        value: this.boxByFinger,
        onChange: (on) => {
          boxByFinger = on;
          // (Its switch on the line shows how it is now: it was read once, and stayed as it was however it was set.)
          this.panel();
          this.app.ui.setHint(on ? 'Draw a box with your finger round the points to pick (the ones behind are picked too). Two fingers still move the view.' : 'A finger turns the view again.');
        }
      });
    }
    if (this.face) {
      return this.facePanel(items);
    }
    if (!this.live && !this.placing) {
      items.push({
        type: 'toggle',
        label: 'Symmetry',
        value: !!this.sym || this.symPicking,
        onChange: (on) => {
          // Two facing (parallel) faces picked: the mirror goes midway between them.
          const fs = this.picks.filter((pick): pick is Extract<Pick, { kind: 'face' }> => pick.kind === 'face');
          if (on && fs.length === 2) {
            const mid = (face: number) => this.centroid([...this.cage.faces[face]]);
            const nrm = (face: number) => {
              const [a, b, cornerC, cornerD] = this.cage.faces[face].map(i => this.cage.verts[i]);

              return norm(cross(sub(cornerC, a), sub(cornerD, b)));
            };
            const [n0, n1] = [nrm(fs[0].f), nrm(fs[1].f)];
            if (Math.abs(dot(n0, n1)) > 0.995) {
              return this.setSymmetry(scale(add(mid(fs[0].f), mid(fs[1].f)), 0.5), n0);
            }
          }
          this.sym = null;
          this.symPairs = null;
          this.symPicking = on;
          this.drawSymPlane();
          if (on) {
            this.app.ui.setHint('Symmetry: pick X / Y / Z (through the middle), tap a cage edge (across its middle) - or pick two facing faces first: midway between them.');
          }
          this.panel();
        }
      });
      if (this.symPicking) {
        // (The middle of its size, not of its points: more detail on one side - an inset face - pulled the mirror
        // towards it, and nothing on the two sides matched.)
        const vs = this.cage.verts;
        const mid = [0, 1, 2].map(axis => (Math.min(...vs.map(vertex => vertex[axis])) + Math.max(...vs.map(vertex => vertex[axis]))) / 2) as Vec3;
        items.push({ type: 'choice', label: 'Mirror across', options: [{ id: 'x', label: 'X' }, { id: 'y', label: 'Y' }, { id: 'z', label: 'Z' }], value: '', onChange: axisKey => this.setSymmetry(mid, axisKey === 'x' ? [1, 0, 0] : axisKey === 'y' ? [0, 1, 0] : [0, 0, 1]) });
      }
    }
    // Points on an open border picked (two or more along it): new faces beyond them.
    const pickedVerts = this.picks.filter((pick): pick is Extract<Pick, { kind: 'vert' }> => pick.kind === 'vert').map(pick => pick.i);
    if (pickedVerts.length >= 2 && !this.placing && !this.live && extendBorder(this.cage, pickedVerts)) {
      items.push({
        type: 'button',
        label: 'Extend surface',
        icon: 'extrude',
        onClick: () => {
          const extended = extendBorder(this.cage, pickedVerts);
          if (extended) {
            this.changeCage(extended.cage, extended.verts.map(i => ({ kind: 'vert' as const, i })));
          }
        }
      });
    }
    const faces = this.picks.filter(pick => pick.kind === 'face').length;
    if (faces && !this.placing) {
      items.push(
        { type: 'button', label: `Extrude face${faces > 1 ? 's' : ''}`, icon: 'extrude', onClick: () => this.extrudeSelected() },
        { type: 'button', label: 'Inset', icon: 'offset', onClick: () => this.insetSelected() }
      );
    }
    if (faces) {
      items.push({ type: 'button', label: `Delete face${faces > 1 ? 's' : ''}`, icon: 'trash', onClick: () => this.deleteSelectedFaces() });
    }
    // Two faces: a tube between them (a handle, a tunnel) - both open up and join.
    if (faces === 2 && !this.placing) {
      items.push({ type: 'button', label: 'Bridge faces', icon: 'loft', onClick: () => this.bridgeSelectedFaces() });
    }
    // One edge picked: a new loop of points across the faces it runs through.
    const edges = this.picks.filter(pick => pick.kind === 'edge');
    // Edges picked: made sharp - the surface keeps a crease along them instead of rounding over - or smooth again.
    if (edges.length && !faces && !this.placing && !this.face) {
      const key = (e: [number, number]) => cageEdgeKey(e[0], e[1]);
      const sharp = new Set((this.cage.creases ?? []).map(key));
      const picked = edges.map(edge => (edge as Extract<Pick, { kind: 'edge' }>).e);
      const allSharp = picked.every(e => sharp.has(key(e)));
      const many = picked.length > 1;
      items.push({
        type: 'button',
        label: allSharp ? (many ? 'Smooth edges' : 'Smooth edge') : many ? 'Sharp edges' : 'Sharp edge',
        icon: 'chamfer',
        onClick: () => {
          const drop = new Set(picked.map(key));
          this.setCreases(allSharp ? (this.cage.creases ?? []).filter(e => !drop.has(key(e))) : [...(this.cage.creases ?? []), ...picked]);
          this.app.ui.toast(allSharp ? 'Smooth again' : 'Sharp: the surface keeps a crease along it (shown orange)');
        }
      });
      // (One edge: the whole loop it is part of, in one tap.)
      if (!many) {
        const loop = edgeLoopOf(this.cage, picked[0][0], picked[0][1], true) ?? [];
        if (loop.length > 1) {
          const loopSharp = loop.every(e => sharp.has(key(e)));
          items.push({
            type: 'button',
            label: loopSharp ? 'Smooth loop' : 'Sharp loop',
            icon: 'chamfer',
            onClick: () => {
              const drop = new Set(loop.map(key));
              this.setCreases(loopSharp ? (this.cage.creases ?? []).filter(e => !drop.has(key(e))) : [...(this.cage.creases ?? []), ...loop]);
              this.app.ui.toast(loopSharp ? 'Smooth again' : `Sharp all the way along (${loop.length} edges)`);
            }
          });
        }
      }
    }
    if (edges.length === 1 && !faces && !this.placing) {
      items.push({ type: 'button', label: 'Add edge loop', icon: 'splitLine', onClick: () => this.addEdgeLoop(edges[0].e) });
      // (The other way: the loop this edge is part of taken out, the faces either side of it made one.)
      if (removeEdgeLoop(this.cage, edges[0].e[0], edges[0].e[1])) {
        items.push({
          type: 'button',
          label: 'Remove edge loop',
          icon: 'trash',
          onClick: () => {
            const cage = removeEdgeLoop(this.cage, edges[0].e[0], edges[0].e[1]);
            if (!cage) {
              return this.app.ui.toast('That loop cannot be taken out');
            }
            this.changeCage(cage, []);
            this.app.ui.toast('Edge loop removed - the faces either side of it are one');
          }
        });
      }
    }
    // Rim edges of holes picked: one hole → Fill, two facing holes → Bridge.
    // (Not while the whole shape is being placed: then every point is picked.)
    const loops = this.placing ? [] : this.pickedLoops();
    if (loops.length === 1) {
      items.push({ type: 'button', label: 'Fill hole', icon: 'fill', onClick: () => this.fillHoles(loops) });
    }
    if (loops.length === 2) {
      items.push({ type: 'button', label: 'Bridge holes', icon: 'loft', onClick: () => this.fillHoles(loops) });
    }
    // Two runs of border edges (two edges, two rows): a strip of faces between them.
    {
      const runs = this.placing ? [] : this.pickedRuns();
      if (runs.length === 2 && !runs.every(run => run.closed)) {
        items.push({ type: 'button', label: 'Connect edges', icon: 'loft', onClick: () => this.connectRuns(runs) });
      }
    }
    // An open shape can be given a thickness to become a solid.
    if (!isClosed(this.cage)) {
      items.push(
        { type: 'number', label: 'Thickness', value: this.thickness, kind: 'length', min: 0, onInput: value => ((this.thickness = Math.max(0, value)), this.panelHint()) },
        { type: 'choice', options: [{ id: 'up', label: 'Up' }, { id: 'down', label: 'Down' }, { id: 'both', label: 'Symmetric' }], value: this.thickSide, onChange: (value) => {
          this.thickSide = value as typeof this.thickSide;
          // A side picked with no thickness yet makes it solid (2 thick), not nothing.
          if (!(this.thickness > 0)) {
            this.thickness = 2;
          }
          this.panel();
        }
        },
        // Or solid down to a plane (no thickness): finish the surface, then pick the plane.
        {
          type: 'button',
          label: 'Fill to a plane…',
          icon: 'fill',
          onClick: () => {
            this.thickness = 0;
            const id = this.done();
            if (id) {
              this.app.setTool(new FillToPlaneOp(this.app, id));
            }
          }
        }
      );
    }
    const liveTitle = { shape: 'New shape', sheet: 'New surface', sweep: 'Pulled out', inset: 'Inset', bridge: 'Bridge' };
    this.app.ui.showPanel({
      title: this.live ? `Freeform · ${liveTitle[this.live.kind]}` : `Freeform${count ? ` · ${count} point${count > 1 ? 's' : ''}` : ''}`,
      items,
      actions: [
        { id: 'all', label: 'Select all', icon: 'pointer', run: () => ((this.picks = this.cage.verts.map((_, i) => ({ kind: 'vert' as const, i }))), this.selectionChanged()) },
        // Twice as many cage points everywhere, same shape (for finer shaping).
        { id: 'refine', label: 'Add detail', icon: 'patternLinear', run: () => this.addDetail() }
      ],
      onDone: () => this.done(),
      onCancel: () => this.cancel(),
      enterApplies: true
    });
  }

  /** Freeform Face's card: the cage presets, an edge loop, finer detail; nothing that changes the face's outline. */
  private facePanel(items: PanelItem[]): void {
    const face = this.face!;
    if (face.tris.length) {
      items.push({
        type: 'choice',
        label: 'Cells across',
        options: FACE_GRIDS.map(grid => ({ id: String(grid), label: String(grid) })),
        value: String(face.feature.grid ?? ''),
        onChange: (value) => {
          const laid = layFaceCage(face.tris, face.feature.face.center, faceStepNormal(face.feature), Number(value), !!face.feature.more?.length);
          if (!laid) {
            return this.app.ui.toast("This face's outline won't take a grid that fine");
          }
          const moved = !this.flat();
          face.feature.grid = laid.n;
          this.changeCage({ faces: laid.cage.faces, verts: laid.cage.verts.map(vertex => add(face.feature.face.center, vertex)) }, []);
          if (laid.n !== Number(value)) {
            this.app.ui.toast(`This face's outline takes ${laid.n} across at most`);
          } else if (moved) {
            this.app.ui.toast('A new grid: the face starts flat again (Undo brings the last one back)');
          }
        }
      });
    }
    const edges = this.picks.filter(pick => pick.kind === 'edge');
    if (edges.length === 1 && !this.picks.some(pick => pick.kind === 'face')) {
      items.push({ type: 'button', label: 'Add edge loop', icon: 'splitLine', onClick: () => this.addEdgeLoop(edges[0].e) });
    }
    const count = this.selectedVerts().length;
    this.app.ui.showPanel({
      title: `Freeform Face${count ? ` · ${count} point${count > 1 ? 's' : ''}` : ''}`,
      beta: true,
      items,
      actions: [
        { id: 'all', label: 'Select all', icon: 'pointer', run: () => ((this.picks = this.cage.verts.map((_, i) => ({ kind: 'vert' as const, i }))), this.selectionChanged()) },
        { id: 'refine', label: 'Add detail', icon: 'patternLinear', run: () => this.addDetail() }
      ],
      onDone: () => this.done(),
      onCancel: () => this.cancel(),
      enterApplies: true
    });
  }

  /** Is every cage point still on the face's plane (nothing shaped)? */
  private flat(): boolean {
    const face = this.face!.feature.face;
    // Several faces (a new step): every point still on them.
    const more = this.face!.feature.more;
    if (more?.length) {
      const normal = faceStepNormal(this.face!.feature);

      return !this.face!.existing && this.cage.verts.every(vertex => Math.abs(toFaces(vertex, normal, this.face!.tris) ?? 1) < 1e-6);
    }

    return this.cage.verts.every(vertex => Math.abs(dot(sub(vertex, face.center), face.normal)) < 1e-9);
  }

  /** The step as it is now (its cage relative to the face's middle). */
  private faceDraft(): FaceFreeformFeature {
    const feature = this.face!.feature;

    return { ...feature, cage: { faces: structuredClone(this.cage.faces), verts: this.cage.verts.map(vertex => sub(vertex, feature.face.center)) } };
  }

  /** The body previewed with the face shaped as the cage is now. */
  private previewFace(): void {
    const draft = this.faceDraft();
    let list = [...this.app.store.features];
    if (this.face?.existing) {
      list = this.withEdit(draft.id, { cage: draft.cage, grid: draft.grid, ...(draft.more ? { more: draft.more } : {}) });
    } else {
      list.push(draft);
    }
    void this.app.preview(list).then((result) => {
      if (!result || this.gone) {
        return;
      }
      const e = result.errors.find(error => error.featureId === draft.id)?.message ?? null;
      if (e !== this.error) {
        ((this.error = e), this.hint());
      }
    });
  }

  private panelHint(): void {
    if (this.face) {
      return this.hint();
    }
    if (!isClosed(this.cage)) {
      this.app.ui.setHint(this.thickness > 0 ? `Done makes a solid ${fmtLen(this.thickness)} thick.` : 'Open shape: Done makes a surface. Give it a Thickness to make a solid.');
    }
  }

  /** Holes whose rim edges are all picked (edges, or the points along them). */
  private pickedLoops(): number[][] {
    const verts = new Set(this.selectedVerts());
    const chosen = new Set<string>();
    const border = boundaryEdges(this.cage);
    for (const [a, b] of border) {
      if (verts.has(a) && verts.has(b)) {
        chosen.add(cageEdgeKey(a, b));
      }
    }
    if (!chosen.size) {
      return [];
    }
    // One edge of a hole's rim is enough: the hole is the whole rim it is on. (It took every edge of the rim picked,
    // which nothing said - one edge tapped offered only Add edge loop.)
    // (A hole, not a sheet's own outline: that is most of the sheet's points, and "filling" it would lay a second
    // face over the whole sheet. An outline with every edge picked is still taken, as before.)
    const exact = holeLoops(this.cage, chosen);
    const all = holeLoops(this.cage, new Set(border.map(([a, b]) => cageEdgeKey(a, b))));
    const whole = all.filter(loop => loop.length * 2 <= this.cage.verts.length && loop.some((a, index) => chosen.has(cageEdgeKey(a, loop[(index + 1) % loop.length]))));

    return [...whole, ...exact.filter(loop => !whole.some(wholeLoop => wholeLoop.length === loop.length && wholeLoop.every(x => loop.includes(x))))];
  }

  /** Picked border edges grouped into runs (edges picked, or the points along them). */
  private pickedRuns(): Chain[] {
    const verts = new Set(this.selectedVerts());
    const picked = new Set(this.picks.flatMap(pick => (pick.kind === 'edge' ? [cageEdgeKey(pick.e[0], pick.e[1])] : [])));
    const chosen = new Set<string>();
    for (const [a, b] of boundaryEdges(this.cage)) {
      if (picked.has(cageEdgeKey(a, b)) || (verts.has(a) && verts.has(b) && !picked.size)) {
        chosen.add(cageEdgeKey(a, b));
      }
    }

    return chosen.size ? borderChains(this.cage, chosen) : [];
  }

  private connectRuns(runs: Chain[]): void {
    const edges = (chain: Chain) => (chain.closed ? chain.verts.length : chain.verts.length - 1);
    if (runs[0].closed !== runs[1].closed) {
      return this.app.ui.toast('Connect a hole with a hole, or a row of edges with a row');
    }
    if (edges(runs[0]) !== edges(runs[1])) {
      return this.app.ui.toast(`Both sides need the same number of edges (${edges(runs[0])} and ${edges(runs[1])})`);
    }
    const next = bridgeChains(this.cage, runs[0], runs[1]);
    if (!next) {
      return this.app.ui.toast("These edges can't be connected (they touch each other)");
    }
    this.remember();
    this.cage = carryCreases(this.cage, next);
    this.picks = [];
    this.rebuild();
    this.selectionChanged();
    this.panelHint();
  }

  /** A cage change: the new cage, what's picked after it, and a fresh preview. */
  private changeCage(next: Cage, picks: Pick[]): void {
    this.remember();
    this.cage = carryCreases(this.cage, next);
    this.picks = picks;
    this.rebuild();
    this.selectionChanged();
    this.panelHint();
  }

  /** Typical cage edge length (for default sizes). */
  private edgeSize(): number {
    const es = cageEdges(this.cage);
    const t = es.reduce((sum, [a, b]) => sum + len(sub(this.cage.verts[a], this.cage.verts[b])), 0);

    return t / Math.max(1, es.length);
  }

  private pickedFaces(): number[] {
    return this.picks.flatMap(pick => (pick.kind === 'face' ? [pick.f] : []));
  }

  /** The picked faces lift out a little, with new side faces; they stay picked to drag further. */
  private extrudeSelected(): void {
    const picked = this.pickedFaces();
    if (picked.length === 1) {
      // One face: pulled out in steps, with Length / Bend / Taper sliders.
      const q = this.cage.faces[picked[0]].map(vertex => this.cage.verts[vertex]);
      const size = (len(sub(q[0], q[2])) + len(sub(q[1], q[3]))) / 2 / Math.SQRT2;
      this.startLive({ kind: 'sweep', base: this.cage, face: picked[0], steps: 4, length: Math.round(size * 2), bend: 0, taper: 1, size });
      this.app.ui.toast('Pulled out - Length, Bend and Taper on the line at the bottom shape it (a spout: bend it up)');

      return;
    }
    const out = extrudeFaces(this.cage, this.pickedFaces(), this.edgeSize() * 0.4);
    if (!out) {
      return;
    }
    this.changeCage(out.cage, out.faces.map(face => ({ kind: 'face' as const, f: face })));
    this.app.ui.toast('Extruded - drag the gimbal to pull the faces further (or push them in)');
  }

  /** A smaller face inside each picked one (ringed by new faces), picked to shape on its own. */
  private insetSelected(): void {
    this.startLive({ kind: 'inset', base: this.cage, faces: this.pickedFaces(), amount: 0.3 });
  }

  /** A new loop of points across every face the edge's ring runs through; the new points get picked. */
  private addEdgeLoop(e: [number, number]): void {
    const before = this.cage.verts.length;
    const next = insertEdgeLoop(this.cage, e[0], e[1]);
    if (!next) {
      return this.app.ui.toast('No clean loop runs through this edge (its ring of faces crosses itself) - try a neighbouring edge');
    }
    this.changeCage(next, next.verts.slice(before).map((_, vertexIndex) => ({ kind: 'vert' as const, i: before + vertexIndex })));
    this.app.ui.toast('Edge loop added - its new points are picked (drag or scale them)');
  }

  /** The whole cage twice as fine: the shape doesn't change, there's just more to pull. */
  private addDetail(): void {
    if (this.cage.faces.length > 600) {
      return this.app.ui.toast('The cage is fine enough already (it would get slow)');
    }
    this.changeCage(refineCage(this.cage), []);
  }

  private bridgeSelectedFaces(): void {
    const [a, b] = this.pickedFaces();
    if (!bridgeFaces(this.cage, a, b)) {
      return this.app.ui.toast("These two faces can't be bridged (they touch each other)");
    }
    const ca = scale(this.cage.faces[a].reduce((sum, vertex) => add(sum, this.cage.verts[vertex]), [0, 0, 0] as Vec3), 0.25);
    const cb = scale(this.cage.faces[b].reduce((sum, vertex) => add(sum, this.cage.verts[vertex]), [0, 0, 0] as Vec3), 0.25);
    const span = len(sub(ca, cb));
    // Faces looking the same way (two on the back of a can): a handle, arched out.
    // Facing each other (a tunnel): straight across.
    const same = dot(this.faceNormalOf(a), this.faceNormalOf(b)) > 0.3;
    this.startLive({ kind: 'bridge', base: this.cage, fa: a, fb: b, arch: same ? Math.round(span * 0.9) : 0, segments: same ? 6 : 1, span });
    this.app.ui.toast(same ? 'Bridged into a handle - Arch on the line at the bottom sets how far it reaches out' : 'Bridged - the two faces are joined by a tube');
  }

  private faceNormalOf(face: number): Vec3 {
    const [first, q, third, t] = this.cage.faces[face].map(vertex => this.cage.verts[vertex]);

    return norm(cross(sub(third, first), sub(t, q)));
  }

  // ---------------------------------------------------------- live steps

  private startLive(live: Live): void {
    this.remember();
    this.live = live;
    if (!this.applyLive()) {
      this.live = null;
      this.past.pop();
      this.app.refreshUndo();

      return;
    }
    this.panel();
    this.hint();
  }

  /** Re-make the live step from its base with the card's current values. */
  private applyLive(): boolean {
    const live = this.live;
    if (!live) {
      return false;
    }
    let next: Cage | null = null;
    let picks: Pick[] = [];
    if (live.kind === 'shape') {
      next = shapeCage(live.prim, live.size, live.rows);
      if (this.placing) {
        picks = next.verts.map((_, i) => ({ kind: 'vert' as const, i }));
      }
    } else if (live.kind === 'sheet') {
      const flat = planeCage(live.size, Math.max(1, Math.round(live.rows)));
      next = { faces: flat.faces, verts: flat.verts.map(vertex => add(live.at, add(add(scale(live.x, vertex[0]), scale(live.y, vertex[1])), scale(live.n, vertex[2])))) };
      if (this.placing) {
        picks = next.verts.map((_, i) => ({ kind: 'vert' as const, i }));
      }
    } else if (live.kind === 'sweep') {
      const swept = sweepFace(live.base, live.face, live);
      if (swept) {
        ((next = swept.cage), (picks = [{ kind: 'face', f: swept.face }]));
      }
    } else if (live.kind === 'inset') {
      const inset = insetFaces(live.base, live.faces, live.amount);
      if (inset) {
        ((next = inset.cage), (picks = inset.faces.map(face => ({ kind: 'face' as const, f: face }))));
      }
    } else {
      next = archBridge(live.base, live.fa, live.fb, live);
      if (!next) {
        this.app.ui.toast('That would twist the handle - try less arch or more segments');
      }
    }
    if (!next) {
      return false;
    }
    // (A live step is made again from the cage it began on: that one's sharp edges, each time.)
    this.cage = 'base' in live ? carryCreases(live.base, next) : next;
    this.picks = picks;
    this.rebuild();
    this.placeGimbal();
    this.drawMarks();

    return true;
  }

  private setLive(patch: Partial<Record<string, number | Vec3>>): void {
    if (!this.live) {
      return;
    }
    const before = { ...this.live };
    Object.assign(this.live, patch);
    // Not possible (a handle that would twist): stay as it was.
    if (!this.applyLive()) {
      ((this.live = before as Live), this.applyLive());
    }
  }

  private frameTimer = 0;
  /** After a size change: frame the new size (once typing pauses). */
  private frameSoon(): void {
    clearTimeout(this.frameTimer);
    this.frameTimer = window.setTimeout(() => {
      const box = new Box3().setFromPoints(this.cage.verts.map(vertex => new Vector3(...vertex)));
      this.app.view.cam.fit(box, true, this.app.view.coveredInsets());
    }, 500);
  }

  /** The live step's controls, at the top of the card. */
  private liveItems(): PanelItem[] {
    const live = this.live;
    if (!live) {
      return [];
    }
    if (live.kind === 'sheet') {
      return [
        { type: 'number', label: 'Width', value: live.size[0], kind: 'length', min: 0.01, onInput: value => (this.setLive({ size: [value, live.size[1]] as unknown as Vec3 }), this.frameSoon()) },
        { type: 'number', label: 'Depth', value: live.size[1], kind: 'length', min: 0.01, onInput: value => (this.setLive({ size: [live.size[0], value] as unknown as Vec3 }), this.frameSoon()) },
        { type: 'slider', label: 'Faces', value: live.rows, min: 1, max: 8, step: 1, onInput: rows => this.setLive({ rows: rows }) },
        // Where its middle is, from the origin: it lands on the middle of the
        // face tapped, which is rarely a round number (a base plate's top was
        // 1.43 off centre once a bumper ran along one edge) - ΔX / ΔY from there
        // were sums to do.
        ...([0, 1, 2] as const).map(axis => ({
          type: 'number' as const,
          label: `Centre ${'XYZ'[axis]}`,
          value: Math.round(live.at[axis] * 1000) / 1000,
          kind: 'length' as const,
          onInput: (value: number) => this.setLive({ at: live.at.map((x, i) => (i === axis ? value : x)) as Vec3 })
        }))
      ];
    }
    if (live.kind === 'shape') {
      const round = live.prim !== 'box';
      const out: PanelItem[] = [
        { type: 'number', label: round ? 'Diameter' : 'Width', value: live.size[0], kind: 'length', min: 0.01, onInput: value => (this.setLive({ size: round ? [value, value, live.prim === 'sphere' ? value : live.size[2]] : [value, live.size[1], live.size[2]] }), this.frameSoon()) }
      ];
      if (live.prim === 'box') {
        out.push({ type: 'number', label: 'Depth', value: live.size[1], kind: 'length', min: 0.01, onInput: value => (this.setLive({ size: [live.size[0], value, live.size[2]] }), this.frameSoon()) });
      }
      // A ring: how thick its tube is, and how many faces round the tube.
      if (live.prim === 'torus') {
        out.push({ type: 'number', label: 'Thickness', value: live.size[2], kind: 'length', min: 0.01, onInput: value => (this.setLive({ size: [live.size[0], live.size[1], Math.min(value, live.size[0] * 0.98)] }), this.frameSoon()) });
        out.push({ type: 'slider', label: 'Rows', value: live.rows, min: 2, max: 6, step: 1, onInput: rows => this.setLive({ rows: rows }) });
      } else if (live.prim !== 'sphere') {
        out.push({ type: 'number', label: 'Height', value: live.size[2], kind: 'length', min: 0.01, onInput: value => (this.setLive({ size: [live.size[0], live.size[1], value] }), this.frameSoon()) });
        out.push({ type: 'slider', label: live.prim === 'box' ? 'Faces' : 'Rows', value: live.rows, min: 1, max: 8, step: 1, onInput: rows => this.setLive({ rows: rows }) });
      }

      return out;
    }
    if (live.kind === 'sweep') {
      return [
      // (A length like any other: typed and shown in the unit in use. As a slider it was typed in millimetres
      // whatever the unit, and stopped at ten times the face's size.)
        { type: 'number', label: 'Length', value: live.length, kind: 'length', min: 0.01, onInput: length => this.setLive({ length: length }) },
        { type: 'slider', label: 'Bend', value: live.bend, min: -150, max: 150, step: 1, show: value => `${value}°`, onInput: bend => this.setLive({ bend: bend }) },
        { type: 'slider', label: 'Taper', value: live.taper, min: 0.2, max: 2.5, step: 0.05, show: value => `${value.toFixed(2)}×`, onInput: taper => this.setLive({ taper: taper }) },
        { type: 'slider', label: 'Steps', value: live.steps, min: 1, max: 12, step: 1, onInput: steps => this.setLive({ steps: steps }) }
      ];
    }
    // (In percent, as it is shown: typed as a number it was taken as a fraction - 40 gave 90 %, the most there is.)
    if (live.kind === 'inset') {
      return [{ type: 'slider', label: 'Inset', value: Math.round(live.amount * 100), min: 5, max: 90, step: 1, show: value => `${Math.round(value)}%`, onInput: value => this.setLive({ amount: value / 100 }) }];
    }

    return [
      { type: 'number', label: 'Arch', value: live.arch, kind: 'length', min: 0, onInput: arch => this.setLive({ arch: arch, segments: arch > 0 && live.segments < 2 ? 6 : live.segments }) },
      { type: 'slider', label: 'Segments', value: live.segments, min: 1, max: 12, step: 1, onInput: segments => this.setLive({ segments: segments }) }
    ];
  }

  private deleteSelectedFaces(): void {
    const faces = this.picks.flatMap(pick => (pick.kind === 'face' ? [pick.f] : []));
    if (!faces.length) {
      return;
    }
    if (faces.length >= this.cage.faces.length) {
      return this.app.ui.toast('At least one face has to stay');
    }
    this.remember();
    this.cage = deleteFaces(this.cage, faces);
    this.picks = [];
    this.hovered = null;
    this.rebuild();
    this.selectionChanged();
    this.panelHint();
  }

  /**
   * From the select tool: fill the hole whose rim passes nearest the given
   * points (a tapped edge of the hole). Returns false if there's no hole.
   */
  fillHoleAt(points: Vec3[]): boolean {
    const rim = boundaryEdges(this.cage);
    if (!rim.length) {
      return false;
    }
    const loops = holeLoops(this.cage, new Set(rim.map(([a, b]) => cageEdgeKey(a, b))));
    if (!loops.length) {
      return false;
    }
    // The hole nearest the tap (by its rim points on the smooth surface).
    const sub3 = subdivide(this.cage, 3);
    const near = (loop: number[]) => {
      let best = Infinity;
      for (const q of points) {
        for (const vertex of loop) {
          best = Math.min(best, Math.hypot(...(sub(sub3.points[vertex], q) as [number, number, number])));
        }
      }

      return best;
    };
    const loop = loops.reduce((nearest, candidate) => (near(candidate) < near(nearest) ? candidate : nearest), loops[0]);
    this.fillHoles([loop]);

    return true;
  }

  private fillHoles(loops: number[][]): void {
    let next: Cage | null;
    if (loops.length === 2) {
      next = bridgeLoops(this.cage, loops[0], loops[1]);
    } else {
      const filled = fillHole(this.cage, loops[0]);
      next = filled?.cage ?? null;
      if (filled?.refined) {
        this.app.ui.toast('The cage got twice as fine so this hole could be closed - the shape stays the same');
      }
    }
    if (!next) {
      return this.app.ui.toast(loops.length === 2 ? 'Bridging needs two holes with the same number of edges' : "That hole can't be filled");
    }
    this.remember();
    this.cage = carryCreases(this.cage, next);
    this.picks = [];
    this.rebuild();
    this.selectionChanged();
  }

  // --------------------------------------------------------------- picking

  private selectedVerts(): number[] {
    const ids = new Set<number>();
    for (const pick of this.picks) {
      if (pick.kind === 'vert') {
        ids.add(pick.i);
      } else if (pick.kind === 'edge') {
        pick.e.forEach(i => ids.add(i));
      } else {
        this.cage.faces[pick.f].forEach(i => ids.add(i));
      }
    }
    const lock = this.locked();

    return [...ids].filter(i => !lock.has(i));
  }

  /** How far along the pointer's ray the smooth surface is (∞ if missed). */
  private surfaceDepth(pointer: ToolPointer): number {
    const view = this.app.view;
    const rect = view.canvas.getBoundingClientRect();
    this.ray.setFromCamera(new Vector2((pointer.x / rect.width) * 2 - 1, -(pointer.y / rect.height) * 2 + 1), view.cam.camera);

    return this.ray.intersectObject(this.surface, false)[0]?.distance ?? Infinity;
  }
  private ray = new Raycaster();

  /** Is a cage point well behind the smooth surface, seen from the eye? */
  private hiddenPoint(q: Vec3, eye: Vec3): boolean {
    const delta = sub(q, eye);
    const length = len(delta);
    if (length < 1e-9) {
      return false;
    }
    this.ray.set(new Vector3(...eye), new Vector3(delta[0] / length, delta[1] / length, delta[2] / length));
    const hit = this.ray.intersectObject(this.surface, false)[0]?.distance ?? Infinity;
    const boundingSphere = this.surface.geometry.boundingSphere;
    const margin = (boundingSphere?.radius ?? 10) * 0.15;

    return hit < length - margin;
  }

  /**
   * The cage point, edge or (frontmost) face the tap is closest to. Points and
   * edges behind the smooth surface (the far side) don't count.
   */
  private pickAt(pointer: ToolPointer): Pick | null {
    const view = this.app.view;
    const scr = this.cage.verts.map(vertex => view.toScreen(vertex));
    // Points are drawn on top of everything, and are picked that way too: a
    // generous reach, and one hidden behind the surface still counts (a point
    // in plain view nearby wins over it).
    const tol = Math.max(16, pointer.tol * 1.8);
    const eye = view.cam.camera.position.toArray() as Vec3;
    const wall = this.surfaceDepth(pointer);
    // In front of the smooth surface along the tap's ray, give or take a little:
    // a cage edge can lie just millimetres outside the surface (a cylinder's
    // sides), and where along it the tap falls is only estimated - with no
    // allowance, half the edges of a tall cylinder couldn't be picked.
    const reach = (this.surface.geometry.boundingSphere?.radius ?? 10) * 0.08;
    const visible = (q: Vec3) => len(sub(q, eye)) < wall + reach;
    let best: { d: number; i: number } | null = null;
    scr.forEach((screenPoint, i) => {
      if (!screenPoint) {
        return;
      }
      const distance = Math.hypot(screenPoint[0] - pointer.x, screenPoint[1] - pointer.y);
      if (distance >= tol) {
        return;
      }
      const hidden = this.hiddenPoint(this.cage.verts[i], eye);
      // Behind the shape while the tap lands on it: that's a tap on the near
      // side - the spout's points showing through the can took taps meant for
      // the face in front of them.
      if (hidden && wall < Infinity) {
        return;
      }
      const score = distance + (hidden ? tol : 0);
      if (!best || score < best.d) {
        best = { d: score, i };
      }
    });
    let bestE: { d: number; e: [number, number] } | null = null;
    for (const e of cageEdges(this.cage)) {
      const a = scr[e[0]];
      const b = scr[e[1]];
      if (!a || !b) {
        continue;
      }
      const { d, t } = segDist(pointer.x, pointer.y, a, b);
      const at = add(this.cage.verts[e[0]], scale(sub(this.cage.verts[e[1]], this.cage.verts[e[0]]), t));
      if (d < pointer.tol && visible(at) && (!bestE || d < bestE.d)) {
        bestE = { d, e };
      }
    }
    // Faces: inside the projected quad; nearest to the camera wins.
    let bestF: { d: number; f: number; mid: number } | null = null;
    this.cage.faces.forEach((face, fi) => {
      const q = face.map(i => scr[i]);
      if (q.some(screenPoint => !screenPoint) || !inPoly(pointer.x, pointer.y, q as [number, number][])) {
        return;
      }
      const center = scale(face.reduce((sum, i) => add(sum, this.cage.verts[i]), [0, 0, 0] as Vec3), 0.25);
      const distance = len(sub(center, eye));
      const faceScreen = view.toScreen(center);
      if (!bestF || distance < bestF.d) {
        bestF = { d: distance, f: fi, mid: faceScreen ? Math.hypot(faceScreen[0] - pointer.x, faceScreen[1] - pointer.y) : Infinity };
      }
    });
    // Whichever the tap is closest to: a point, an edge, or the middle of the
    // face under it. (Points always won within a fingertip's reach: on a
    // phone, among a detailed cage, a face's middle couldn't be tapped.)
    const pt = best as { d: number; i: number } | null;
    const ed = bestE as { d: number; e: [number, number] } | null;
    const fc = bestF as { d: number; f: number; mid: number } | null;
    const faceAt = fc ? fc.mid : Infinity;
    // A point gets a few pixels' start on the edges running out of it: a tap a
    // fingertip's wobble from a point lies right on those edges (aiming at the
    // nine inner points of a sheet picked three edges).
    const slack = Math.min(10, pointer.tol * 0.4);
    if (pt && pt.d <= Math.min((ed?.d ?? Infinity) + slack, faceAt)) {
      return { kind: 'vert', i: pt.i };
    }
    if (ed && ed.d < faceAt) {
      return { kind: 'edge', e: ed.e };
    }
    if (fc) {
      return { kind: 'face', f: fc.f };
    }
    if (pt) {
      return { kind: 'vert', i: pt.i };
    }

    return ed ? { kind: 'edge', e: ed.e } : null;
  }

  /** Every cage face under the pointer, nearest first. */
  private facesUnder(pointer: ToolPointer): number[] {
    const view = this.app.view;
    const scr = this.cage.verts.map(vertex => view.toScreen(vertex));
    const eye = view.cam.camera.position.toArray() as Vec3;
    const out: { f: number; d: number }[] = [];
    this.cage.faces.forEach((face, fi) => {
      const q = face.map(i => scr[i]);
      if (q.some(screenPoint => !screenPoint) || !inPoly(pointer.x, pointer.y, q as [number, number][])) {
        return;
      }
      const center = scale(face.reduce((sum, i) => add(sum, this.cage.verts[i]), [0, 0, 0] as Vec3), 0.25);
      out.push({ f: fi, d: len(sub(center, eye)) });
    });

    return out.sort((a, b) => a.d - b.d).map(entry => entry.f);
  }

  /** Which plane / flat face is under the pointer (choosing where a new surface goes). */
  private planeAt(pointer: ToolPointer): { plane: PlaneDef; at: Vec3; sel: Sel } | null {
    const hit = this.app.view.pick(pointer.x, pointer.y, { edges: false, vertices: false, planes: true, planesFirst: true, profiles: false, edgeTolPx: 0 });
    if (hit?.kind === 'plane') {
      const plane = this.app.view.planeOf(hit.id);

      return plane ? { plane, at: plane.origin, sel: { kind: 'plane', id: hit.id } } : null;
    }
    if (hit?.kind === 'face') {
      const info = this.app.view.body(hit.body)?.faces[hit.face];
      // On a face: centred on it.
      if (info?.plane) {
        return { plane: info.plane, at: info.center, sel: { kind: 'face', body: hit.body, face: hit.face } };
      }
    }

    return null;
  }

  hover(pointer: ToolPointer | null): void {
    if (this.choosingPlane) {
      this.app.setHover(pointer ? (this.planeAt(pointer)?.sel ?? null) : null);

      return;
    }
    if (this.dragging) {
      return;
    }
    const part = pointer && this.gimbal?.hit(pointer);
    this.gimbal?.setHot(part ?? null);
    this.hovered = pointer && !part ? this.pickAt(pointer) : null;
    this.app.view.canvas.style.cursor = part ? 'grab' : '';
    this.drawMarks();
  }

  tap(pointer: ToolPointer, count = 1): void {
    if (this.symPicking && !this.choosingPlane) {
      const hit = this.pickAt(pointer);
      if (hit?.kind === 'edge') {
        const [a, b] = hit.e.map(i => this.cage.verts[i]);
        this.setSymmetry(scale(add(a, b), 0.5), sub(b, a));

        return;
      }

      return this.app.ui.toast('Tap a cage edge (the mirror goes across its middle), or pick X / Y / Z under Symmetry on the line at the bottom');
    }
    if (this.choosingPlane) {
      const at = this.planeAt(pointer);
      if (!at) {
        return this.app.ui.toast('Select a plane or a flat face');
      }

      return this.placeOn(at);
    }
    // Tapped again where a face was just picked: the face behind it (a face
    // hidden behind another part - a handle's end behind its own arm - could
    // never be reached). Past the last one, it's dropped.
    this.tapCage(pointer, count);
  }

  /** The new flat sheet put on a plane or flat face (centred at `at`). */
  private placeOn(at: { plane: PlaneDef; at: Vec3 }): void {
    // The flat sheet (made on XY at the origin) laid onto that plane.
    const x = norm(at.plane.xDir);
    const normal = norm(at.plane.normal);
    const y = cross(normal, x);
    this.cage = { faces: this.cage.faces, verts: this.cage.verts.map(vertex => add(at.at, add(add(scale(x, vertex[0]), scale(y, vertex[1])), scale(normal, vertex[2])))) };
    // Its size and faces in the card, like a new box (a 50 × 30 pad was a
    // 60 × 60 sheet to be scaled by 0.83 and 0.5).
    this.live = { kind: 'sheet', size: [60, 60], rows: 4, at: at.at, x, y, n: normal };
    this.choosingPlane = false;
    this.app.setHover(null);
    this.app.view.setOriginPlanesVisible(false);
    for (const object of [this.surface, this.faceEdges, this.lines, this.dots, this.backLines, this.backDots]) {
      object.visible = true;
    }
    this.startEditing();
  }

  private tapCage(pointer: ToolPointer, count: number): void {
    const lt = this.lastFaceTap;
    if (lt && Math.hypot(pointer.x - lt.x, pointer.y - lt.y) < 14 && performance.now() - lt.t < 4000 && this.picks.some(pick => pick.kind === 'face' && pick.f === lt.f)) {
      const under = this.facesUnder(pointer);
      const index = under.indexOf(lt.f);
      this.live = null;
      this.picks = this.picks.filter(pick => !(pick.kind === 'face' && pick.f === lt.f));
      if (index >= 0 && index + 1 < under.length) {
        const face = under[index + 1];
        this.picks.push({ kind: 'face', f: face });
        this.lastFaceTap = { x: pointer.x, y: pointer.y, t: performance.now(), f: face };
        this.app.ui.toast(index + 2 < under.length ? 'The face behind - tap again for the next one' : 'The face behind (tap again to drop it)');
      } else {
        this.lastFaceTap = null;
      }
      this.selectionChanged();

      return;
    }
    // Double-tap on empty space: finish and select the whole body (e.g. to move
    // or colour it). On a point, edge or face it's just quick tapping: keep it picked.
    if (count >= 2) {
      const again = this.pickAt(pointer);
      if (again) {
        if (!this.picks.some(pick => JSON.stringify(pick) === JSON.stringify(again))) {
          this.live = null;
          if (pointer.shift || pointer.add || pointer.type === 'touch') {
            this.picks.push(again);
          } else {
            this.picks = [again];
          }
          this.selectionChanged();
        }

        return;
      }
      const id = this.done();
      if (id) {
        this.app.setSelection([{ kind: 'body', body: id }]);
      }

      return;
    }
    this.lastFaceTap = null;
    this.live = null;
    // A tap while placing: they'd rather edit right away.
    if (this.placing) {
      this.placing = false;
      this.picks = [];
    }
    const hit = this.pickAt(pointer);
    if (!hit) {
      // Empty space: deselect. With nothing selected it used to finish the
      // whole edit - one stray tap on a phone (meant to deselect) ended it
      // half made. Done, or a double-tap on empty space, finishes.
      if (this.picks.length) {
        return ((this.picks = []), this.selectionChanged());
      }
      this.app.ui.toast('Nothing picked. Done (or a double-tap on empty space) finishes the shape');

      return;
    }
    const key = JSON.stringify(hit);
    const i = this.picks.findIndex(pick => JSON.stringify(pick) === key);
    // A touch screen has no Shift: there every tap adds, and a second tap drops it.
    if (pointer.shift || pointer.add || pointer.type === 'touch') {
      if (i >= 0) {
        this.picks.splice(i, 1);
      } else {
        this.picks.push(hit);
      }
    } else {
      this.picks = i >= 0 && this.picks.length === 1 ? [] : [hit];
    }
    if (hit.kind === 'face' && this.picks.some(pick => pick.kind === 'face' && pick.f === hit.f)) {
      this.lastFaceTap = { x: pointer.x, y: pointer.y, t: performance.now(), f: hit.f };
    }
    this.selectionChanged();
  }

  private selectionChanged(): void {
    this.drawMarks();
    this.placeGimbal();
    this.panel();
    this.hint();
  }

  private centroid(ids: number[]): Vec3 {
    return scale(ids.reduce((sum, i) => add(sum, this.cage.verts[i]), [0, 0, 0] as Vec3), 1 / Math.max(1, ids.length));
  }

  private placeGimbal(): void {
    const ids = this.selectedVerts();
    if (!ids.length) {
      this.gimbal?.dispose();
      this.gimbal = null;

      return;
    }
    // Move: the arrows and planes; Turn: the rings; Scale: the cube-ended handles and the middle.
    if (this.gimbal && this.gimbalFor !== this.xform) {
      (this.gimbal.dispose(), (this.gimbal = null));
    }
    this.gimbalFor = this.xform;
    const parts = this.xform === 'turn' ? (q: GimbalPart) => q.kind === 'ring' : this.xform === 'scale' ? SCALE_PARTS : (q: GimbalPart) => q.kind !== 'ring';
    this.gimbal ??= new Gimbal(this.app.view, { axes: this.axes, parts, cubes: this.xform === 'scale' });
    this.gimbal.setCenter(this.centroid(ids));
  }

  // ------------------------------------------------------------ dragging

  /**
   * A mouse drag from empty space: the blue box - the cage points inside it
   * are picked (with Shift / Ctrl added to what's picked).
   */
  box(a: { x: number; y: number }, b: { x: number; y: number }, final: boolean, add: boolean): void {
    if (!final || this.choosingPlane || this.dragging) {
      return;
    }
    const [x0, x1] = [Math.min(a.x, b.x), Math.max(a.x, b.x)];
    const [y0, y1] = [Math.min(a.y, b.y), Math.max(a.y, b.y)];
    if (x1 - x0 < 3 && y1 - y0 < 3) {
      return;
    }
    const inside = this.cage.verts.flatMap((vertex, i) => {
      const q = this.app.view.toScreen(vertex);

      return q && q[0] >= x0 && q[0] <= x1 && q[1] >= y0 && q[1] <= y1 ? [i] : [];
    });
    const keep = add ? this.picks.filter(pick => pick.kind === 'vert' && !inside.includes(pick.i)) : [];
    this.picks = [...keep, ...inside.map(i => ({ kind: 'vert' as const, i }))];
    this.selectionChanged();
  }

  down(pointer: ToolPointer): boolean {
    if (this.choosingPlane) {
      return false;
    }
    const part = this.gimbal?.hit(pointer);
    if (!part || !this.gimbal) {
      return false;
    }
    // Another cage point right under the pointer: that's a tap on it, not a drag
    // of the gimbal's middle (arrows and rings still drag).
    if (part.kind === 'center' || part.kind === 'plane') {
      const hit = this.pickAt(pointer);
      const sel = new Set(this.selectedVerts());
      if (hit?.kind === 'vert' && !sel.has(hit.i)) {
        const screenPoint = this.app.view.toScreen(this.cage.verts[hit.i]);
        if (screenPoint && Math.hypot(screenPoint[0] - pointer.x, screenPoint[1] - pointer.y) < Math.max(10, pointer.tol)) {
          return false;
        }
      }
    }
    // One point turned about itself wouldn't move: it turns about the shape's centre instead.
    const ids = this.selectedVerts();
    const center = part.kind === 'ring' && ids.length === 1 ? this.centroid(this.cage.verts.map((_, i) => i)) : this.gimbal.origin;
    this.remember();
    this.fieldBase = null;
    // (Scale: the press's distance from the middle on screen is "as it is" for this drag.)
    const screenCenter = this.app.view.toScreen(this.gimbal.origin);
    const r0 = screenCenter ? Math.max(24, Math.hypot(pointer.x - screenCenter[0], pointer.y - screenCenter[1])) : 60;
    this.dragging = { part, from: pointer, base: this.cage.verts.map(vertex => [...vertex] as Vec3), center, d: [0, 0, 0], ang: 0, k: [1, 1, 1], r0, soft: this.softWeights(ids, this.cage.verts) };
    this.gimbal.setHot(part);

    return true;
  }

  /**
   * A picked face pressed and dragged by itself (not by the gimbal): pushed in
   * or pulled out along its own normal - several picked: along their average.
   * (As everywhere else on the model: the thing picked is dragged.)
   */
  dragStart(pointer: ToolPointer): boolean {
    if (this.dragging || this.choosingPlane || this.symPicking || this.placing || (this.live && this.live.kind !== 'shape' && this.live.kind !== 'sheet')) {
      return false;
    }
    const hit = this.pickAt(pointer);
    const faces = this.picks.filter((pick): pick is Extract<Pick, { kind: 'face' }> => pick.kind === 'face');
    if (hit?.kind !== 'face' || !faces.some(face => face.f === hit.f)) {
      return false;
    }
    const normal = norm(faces.reduce((sum, face) => add(sum, this.faceNormalOf(face.f)), [0, 0, 0] as Vec3));
    if (len(normal) < 0.5) {
      return false;
    }
    const ids = this.selectedVerts();
    this.remember();
    this.fieldBase = null;
    this.dragging = { part: { kind: 'axis', i: 2 }, from: pointer, base: this.cage.verts.map(vertex => [...vertex] as Vec3), center: this.centroid(ids), d: [0, 0, 0], ang: 0, k: [1, 1, 1], r0: 60, along: normal, soft: this.softWeights(ids, this.cage.verts) };

    return true;
  }

  drag(pointer: ToolPointer): void {
    const dr = this.dragging;
    if (!dr) {
      return;
    }
    this.typing.track(pointer);
    if (this.typing.active) {
      return;
    }
    const view = this.app.view;
    const step = niceStep(view.cam.worldPerPixel(view.height) * 4);
    const snap = (value: number) => (pointer.shift ? value : Math.round(value / step) * step);
    const part = dr.part;
    if (dr.along) {
      const distance = snap(axisDrag(view, dr.center, dr.along, dr.from, pointer));
      this.apply(scale(dr.along, distance), 0);
      this.boxAt(pointer, fmtLen(distance));

      return;
    }
    if (this.xform === 'scale' && (part.kind === 'axis' || part.kind === 'center')) {
      const screenPoint = view.toScreen(dr.center);
      if (!screenPoint) {
        return;
      }
      let factor = part.kind === 'axis' ? (dr.r0 + axisDrag(view, dr.center, this.axes[part.i], dr.from, pointer) / view.cam.worldPerPixel(view.height)) / dr.r0 : Math.hypot(pointer.x - screenPoint[0], pointer.y - screenPoint[1]) / dr.r0;
      factor = Math.max(0.01, pointer.shift ? factor : Math.round(factor * 100) / 100);
      this.scaleBy(part.kind === 'axis' ? ([0, 1, 2].map(i => (i === part.i ? factor : 1)) as Vec3) : [factor, factor, factor]);
      this.boxAt(pointer, `×${factor.toFixed(2)}`);

      return;
    }
    if (part.kind === 'axis') {
      const dir = this.axes[part.i];
      const distance = snap(axisDrag(view, dr.center, dir, dr.from, pointer));
      this.apply(scale(dir, distance), 0);
      this.boxAt(pointer, fmtLen(distance));
    } else if (part.kind === 'plane' || part.kind === 'center') {
      const normal: Vec3 = part.kind === 'plane' ? this.axes[part.i] : (view.cam.viewDir().toArray() as Vec3);
      const plane = { origin: dr.center, normal: normal, xDir: xDirFor(normal) };
      const a = view.rayToPlane(dr.from.x, dr.from.y, plane);
      const b = view.rayToPlane(pointer.x, pointer.y, plane);
      if (!a || !b) {
        return;
      }
      const delta = sub(b, a);
      this.apply([snap(delta[0]), snap(delta[1]), snap(delta[2])], 0);
      this.boxAt(pointer, fmtLen(len(dr.d)));
    } else if (part.kind === 'ring') {
      const axis = this.axes[part.i];
      const screenPoint = view.toScreen(dr.center);
      if (!screenPoint) {
        return;
      }
      const ang = (q: { x: number; y: number }) => Math.atan2(q.y - screenPoint[1], q.x - screenPoint[0]);
      const facing = dot(axis, view.cam.viewDir().toArray() as Vec3) < 0 ? 1 : -1;
      let deg = ((-(ang(pointer) - ang(dr.from)) * 180) / Math.PI) * facing;
      deg = ((deg + 540) % 360) - 180;
      const total = pointer.shift ? deg : Math.round(deg);
      this.apply([0, 0, 0], total);
      this.boxAt(pointer, `${total}°`);
    }
  }

  /** Scale the selected points from where the drag began, about the gimbal's middle, by `factors` along its three axes. */
  private scaleBy(factors: Vec3): void {
    const dr = this.dragging;
    if (!dr) {
      return;
    }
    dr.k = factors;
    const ids = this.selectedVerts();
    for (const i of ids) {
      const offset = sub(dr.base[i], dr.center);
      this.cage.verts[i] = this.axes.reduce((q, a, j) => add(q, scale(a, dot(offset, a) * factors[j])), dr.center);
    }
    this.mirrorMoved(ids);
    this.gimbal?.setCenter(this.centroid(ids));
    this.rebuild();
  }

  /** Move the selected points from where the drag began: translate `delta`, then turn `deg` about the gimbal axis. */
  private apply(delta: Vec3, deg: number): void {
    const dr = this.dragging;
    if (!dr) {
      return;
    }
    dr.d = delta;
    dr.ang = deg;
    const ids = this.selectedVerts();
    const axis = dr.part.kind === 'ring' ? this.axes[dr.part.i] : null;
    const t = (deg * Math.PI) / 180;
    for (const i of ids) {
      let q = dr.base[i];
      if (axis && deg) {
        // Rodrigues' rotation about the axis through the centre.
        const offset = sub(q, dr.center);
        const rotated = add(add(scale(offset, Math.cos(t)), scale(cross(axis, offset), Math.sin(t))), scale(axis, dot(axis, offset) * (1 - Math.cos(t))));
        q = add(dr.center, rotated);
      }
      this.cage.verts[i] = add(q, delta);
    }
    // (The points round them go along with a move, by their share - not with a turn.)
    const soft = dr.soft?.size && !deg ? this.softened(dr.soft, delta, dr.base) : [];
    this.mirrorMoved([...ids, ...soft]);
    this.gimbal?.setCenter(this.centroid(ids));
    this.rebuild();
  }

  // ----------------------------------------------------------- symmetry

  /** Mirror a point across the symmetry plane. */
  private mirrored(q: Vec3): Vec3 {
    const { origin, normal } = this.sym!;

    return sub(q, scale(normal, 2 * dot(sub(q, origin), normal)));
  }

  private setSymmetry(origin: Vec3, normal: Vec3): void {
    const unitNormal = norm(normal);
    if (len(unitNormal) < 0.5) {
      return;
    }
    this.sym = { origin, normal: unitNormal };
    this.symPicking = false;
    this.symPairs = null;
    this.drawSymPlane();
    this.panel();
    this.app.ui.toast('Symmetry on: what you move on one side moves on the other');
  }

  /** Which point mirrors which (worked out from where the points are before a change). */
  private pairs(base: Vec3[]): Map<number, number> {
    if (this.symPairs && this.symPairs.size === base.length) {
      return this.symPairs;
    }
    const box = new Box3().setFromPoints(base.map(vertex => new Vector3(...vertex)));
    const tol = Math.max(1e-6, box.getSize(new Vector3()).length() * 1e-4);
    const pairs = new Map<number, number>();
    base.forEach((vertex, i) => {
      const mirrored = this.mirrored(vertex);
      let best = -1;
      let bd = tol;
      base.forEach((other, j) => {
        const dd = Math.hypot(other[0] - mirrored[0], other[1] - mirrored[1], other[2] - mirrored[2]);
        if (dd <= bd) {
          ((bd = dd), (best = j));
        }
      });
      if (best >= 0) {
        pairs.set(i, best);
      }
    });
    this.symPairs = pairs;

    return pairs;
  }

  /** After points moved: their mirror images follow; points on the plane stay on it. */
  private mirrorMoved(ids: number[]): void {
    if (!this.sym || !ids.length) {
      return;
    }
    const base = this.dragging?.base ?? this.past[this.past.length - 1]?.cage.verts ?? this.cage.verts;
    if (base.length !== this.cage.verts.length) {
      return;
    }
    const pair = this.pairs(base);
    const moved = new Set(ids);
    const { origin, normal } = this.sym;
    for (const i of ids) {
      const j = pair.get(i);
      if (j === undefined) {
        continue;
      }
      if (j === i) {
        const vertex = this.cage.verts[i];
        this.cage.verts[i] = sub(vertex, scale(normal, dot(sub(vertex, origin), normal)));
      } else if (!moved.has(j) || i < j) {
        this.cage.verts[j] = this.mirrored(this.cage.verts[i]);
      }
    }
  }

  /** The symmetry plane, a see-through square round the shape. */
  private drawSymPlane(): void {
    const geometry = this.symPlane.geometry;
    this.symMark.visible = !!this.sym;
    if (!this.sym) {
      geometry.setAttribute('position', new BufferAttribute(new Float32Array(0), 3));

      return;
    }
    const box = new Box3().setFromPoints(this.cage.verts.map(vertex => new Vector3(...vertex)));
    const radius = box.getSize(new Vector3()).length() * 0.6 + 1;
    const normal = this.sym.normal;
    const xDir = xDirFor(normal);
    const vAxis = cross(normal, xDir);
    const center = sub(this.sym.origin, scale(normal, 0));
    const planePoint = (a: number, b: number) => add(center, add(scale(xDir, a * radius), scale(vAxis, b * radius)));
    const q = [planePoint(-1, -1), planePoint(1, -1), planePoint(1, 1), planePoint(-1, -1), planePoint(1, 1), planePoint(-1, 1)].flat();
    geometry.setAttribute('position', new BufferAttribute(new Float32Array(q), 3));
    geometry.computeBoundingSphere();
    this.symPlane.renderOrder = 66;
    // Its mark at a corner (the symmetry symbol), so it reads as the mirror, not a plane of the model.
    this.symMark.position.set(...planePoint(-0.97, 0.97));
    this.symMark.scale.set(2 * radius * PLANE_MARK_SIZE, 2 * radius * PLANE_MARK_SIZE, 1);
    this.app.view.requestRender();
  }

  up(): void {
    const moved = !!this.dragging && (len(this.dragging.d) > 0 || this.dragging.ang !== 0 || this.dragging.k.some(x => x !== 1));
    const from = this.dragging?.from;
    // A press on the gimbal that moved nothing isn't a step to undo…
    if (this.dragging && !moved) {
      (this.past.pop(), this.app.refreshUndo());
    }
    this.dragging = null;
    // …it's a tap on what's under it: the gimbal's arrows lie over the faces
    // next to the picked one, and picking the four faces of a cap one after
    // another only ever got the first.
    if (from && !moved && !this.typing.active && this.pickAt(from)) {
      this.typing.reset();
      this.app.ui.setLabel(0, 0, null);
      this.typing.hideBox();
      this.gimbal?.setHot(null);
      this.tap(from);

      return;
    }
    this.typing.reset();
    this.app.ui.setLabel(0, 0, null);
    this.typing.hideBox();
    this.gimbal?.setHot(null);
    if (this.placing && moved) {
      // In place: on to editing points, edges and faces.
      this.placing = false;
      this.picks = [];
      this.selectionChanged();

      return;
    }
    this.placeGimbal();
    // The card's exact values start again from where the drag left the points.
    if (moved) {
      this.panel();
    }
  }

  /** What a typed value does to the drag under way. */
  private dragTarget(): DragTypingTarget | null {
    const dr = this.dragging;
    if (!dr) {
      return null;
    }
    const part = dr.part;
    const dragDir = norm(dr.d);
    if (this.xform === 'scale' && (part.kind === 'axis' || part.kind === 'center')) {
      return {
        kind: 'number',
        apply: value => value > 0 && this.scaleBy(part.kind === 'axis' ? ([0, 1, 2].map(i => (i === part.i ? value : 1)) as Vec3) : [value, value, value]),
        commit: () => this.up(),
        cancel: () => this.scaleBy([1, 1, 1])
      };
    }

    return {
      kind: part.kind === 'ring' ? 'angle' : 'length',
      apply: (value) => {
        if (part.kind === 'ring') {
          this.apply([0, 0, 0], value);
        } else if (part.kind === 'axis') {
          this.apply(scale(this.axes[part.i], value), 0);
        } else if (len(dr.d) > 1e-9) {
          this.apply(scale(dragDir, value), 0);
        }
      },
      commit: () => this.up(),
      cancel: () => this.apply([0, 0, 0], 0)
    };
  }

  dragKey(e: KeyboardEvent): boolean {
    const t = this.dragTarget();

    return !!t && this.typing.key(e, t);
  }

  /** The drag's value in a box by the pointer (type into it while dragging). */
  private boxAt(pointer: ToolPointer, text: string): void {
    const t = this.dragTarget();
    if (t) {
      this.typing.box(pointer, text, t);
    }
  }

  /**
   * A typed Move, Turn or Scale of the picked points (see moveTurnScale),
   * always from where they were when typing began.
   */
  private setField(field: number, value: number): void {
    if (this.xform === 'scale' && !(value > 0)) {
      return;
    }
    const ids = this.selectedVerts();
    if (!ids.length) {
      return;
    }
    if (!this.fieldBase) {
      this.remember();
      this.fieldBase = new Map(ids.map(i => [i, [...this.cage.verts[i]] as Vec3]));
      this.fieldSoft = this.softWeights(ids, this.cage.verts);
      this.fieldSoftBase = this.cage.verts.map(vertex => [...vertex] as Vec3);
    }
    this.fieldVals[field] = value;
    if (this.xform === 'place') {
      return;
    }
    const base = [...this.fieldBase];
    const moved = moveTurnScale(base.map(([, point]) => point), this.xform, this.fieldVals as [number, number, number, number]);
    base.forEach(([i], index) => (this.cage.verts[i] = moved[index]));
    const soft = this.xform === 'move' ? this.softened(this.fieldSoft, [this.fieldVals[0], this.fieldVals[1], this.fieldVals[2]]) : [];
    this.mirrorMoved([...base.map(([i]) => i), ...soft]);
    this.rebuild();
    this.placeGimbal();
  }

  /** The cage's sharp edges set to these (a step to undo). */
  private setCreases(list: [number, number][]): void {
    this.remember();
    this.cage = withCreases(this.cage, list);
    this.rebuild();
    this.panel();
  }

  /** The points round the picked ones that go along with a move, each with how much of it (see Soft). */
  private fieldSoft = new Map<number, number>();
  private fieldSoftBase: Vec3[] = [];

  /** How much of a move each unpicked point within the Soft distance of a picked one takes: 1 beside it, 0 at that distance. */
  private softWeights(ids: number[], verts: Vec3[]): Map<number, number> {
    const out = new Map<number, number>();
    if (!(softRadius > 0) || this.face) {
      return out;
    }
    const picked = new Set(ids);
    for (let j = 0; j < verts.length; j++) {
      if (picked.has(j)) {
        continue;
      }
      let distance = Infinity;
      for (const i of ids) {
        distance = Math.min(distance, len(sub(verts[j], verts[i])));
      }
      if (distance >= softRadius) {
        continue;
      }
      const falloff = 1 - (distance / softRadius) ** 2;
      out.set(j, falloff * falloff);
    }

    return out;
  }

  /** Move the soft points by their share of `delta` from where they were; those moved. */
  private softened(weights: Map<number, number>, delta: Vec3, base: Vec3[] = this.fieldSoftBase): number[] {
    for (const [j, weight] of weights) {
      if (base[j]) {
        this.cage.verts[j] = add(base[j], scale(delta, weight));
      }
    }

    return [...weights.keys()];
  }

  /** The picked points put where their middle is at `value` on `axis` (X, Y or Z from the origin). */
  private placeAt(axis: number, value: number): void {
    const ids = this.selectedVerts();
    if (!ids.length || !Number.isFinite(value)) {
      return;
    }
    if (!this.fieldBase) {
      this.remember();
      this.fieldBase = new Map(ids.map(i => [i, [...this.cage.verts[i]] as Vec3]));
    }
    const delta: Vec3 = [0, 0, 0];
    delta[axis] = value - this.centroid(ids)[axis];
    for (const i of ids) {
      this.cage.verts[i] = add(this.cage.verts[i], delta);
    }
    const soft = this.softWeights(ids, this.cage.verts);
    for (const [j, weight] of soft) {
      this.cage.verts[j] = add(this.cage.verts[j], scale(delta, weight));
    }
    this.mirrorMoved([...ids, ...soft.keys()]);
    this.rebuild();
    this.placeGimbal();
  }

  // ---------------------------------------------------------------- undo

  /** Keep the cage as it is now, before a change (Undo goes back to it). */
  private remember(): void {
    this.live = null;
    this.past.push({ cage: structuredClone(this.cage), picks: structuredClone(this.picks) });
    if (this.past.length > 100) {
      this.past.shift();
    }
    this.future = [];
    this.app.refreshUndo();
  }
  get canUndo(): boolean {
    return this.past.length > 0;
  }
  get canRedo(): boolean {
    return this.future.length > 0;
  }
  undo(): boolean {
    const prev = !this.dragging && this.past.pop();
    if (!prev) {
      return false;
    }
    this.live = null;
    this.future.push({ cage: structuredClone(this.cage), picks: structuredClone(this.picks) });
    this.restore(prev);

    return true;
  }
  redo(): boolean {
    const next = !this.dragging && this.future.pop();
    if (!next) {
      return false;
    }
    this.live = null;
    this.past.push({ cage: structuredClone(this.cage), picks: structuredClone(this.picks) });
    this.restore(next);

    return true;
  }
  private restore(st: { cage: Cage; picks: Pick[] }): void {
    this.cage = st.cage;
    this.picks = st.picks;
    this.rebuild();
    this.selectionChanged();
    this.panelHint();
    this.app.refreshUndo();
  }

  // --------------------------------------------------------------- drawing

  /** The plan the preview mesh was last built from (same layout: refill in place). */
  private shownPlan: SubdivPlan | null = null;
  private crossing = false;
  private crossTimer = 0;
  private crossAt = 0;

  /** Does the shape pass through itself? Red surface + a hint if so (kept cheap while dragging). */
  private checkCrossing(): void {
    const run = () => {
      this.crossAt = performance.now();
      this.crossTimer = 0;
      const was = this.crossing;
      this.crossing = selfCrossings(this.cage, this.cage.faces.length > 150 ? 1 : 2, 1).length > 0;
      (this.surface.material as MeshStandardMaterial).color.setHex(this.crossing ? 0xe06c6c : 0xb9c6dc);
      if (this.crossing !== was) {
        if (this.crossing) {
          this.app.ui.setHint("The shape passes through itself here - pull the point back (it can't become a body like this).");
        } else {
          this.hint();
        }
      }
      this.app.view.requestRender();
    };
    if (performance.now() - this.crossAt > 150) {
      return run();
    }
    if (!this.crossTimer) {
      this.crossTimer = window.setTimeout(run, 150);
    }
  }

  private rebuild(): void {
    this.checkCrossing();
    // The same smooth surface the body will have (points on the limit surface),
    // from weights kept per layout: while points are dragged or a slider moves,
    // the buffers are refilled in place (~0.3 ms, it was ~21 ms for a
    // watering can - 70–100 ms a finger move on a phone).
    const plan = cachedPlan(this.cage, 3);
    const geometry = this.surface.geometry;
    if (plan !== this.shownPlan) {
      this.shownPlan = plan;
      const pos = applyPlan(plan, this.cage.verts);
      const tri = planIndices(plan);
      geometry.setAttribute('position', new BufferAttribute(pos, 3));
      geometry.setAttribute('normal', new BufferAttribute(smoothNormals(pos, tri), 3));
      geometry.setIndex(new BufferAttribute(tri, 1));
      // The faces' outlines: each face's grid border, once per shared edge.
      this.faceEdgeIdx = faceBorders(plan);
    } else {
      const pa = geometry.getAttribute('position') as BufferAttribute;
      const na = geometry.getAttribute('normal') as BufferAttribute;
      applyPlan(plan, this.cage.verts, pa.array as Float32Array);
      smoothNormals(pa.array as Float32Array, geometry.getIndex()!.array as Uint32Array, na.array as Float32Array);
      pa.needsUpdate = true;
      na.needsUpdate = true;
    }
    geometry.computeBoundingSphere();
    this.pull.value = (geometry.boundingSphere?.radius || 10) * 0.1;
    const sp = geometry.getAttribute('position').array as Float32Array;
    const fe: number[] = new Array(this.faceEdgeIdx.length * 3);
    this.faceEdgeIdx.forEach((vertex, index) => ((fe[index * 3] = sp[vertex * 3]), (fe[index * 3 + 1] = sp[vertex * 3 + 1]), (fe[index * 3 + 2] = sp[vertex * 3 + 2])));
    setLines(this.faceEdges, fe);
    // (While a new surface's plane is still being chosen: not shown yet.)
    this.faceEdges.visible = this.surface.visible && fe.length > 0;
    const edges = cageEdges(this.cage).flatMap(([a, b]) => [...this.cage.verts[a], ...this.cage.verts[b]]);
    setPositions(this.lines, edges);
    setPositions(this.dots, this.cage.verts.flat());
    this.drawMarks();
    if (this.face) {
      this.previewFace();
    }
  }

  private drawMarks(): void {
    const seg = (ps: Pick[]) =>
      ps.flatMap((pick) => {
        const vertices = this.cage.verts;
        // (A pick of a part the cage no longer has - a face just deleted: nothing to mark.)
        if (pick.kind === 'edge') {
          return vertices[pick.e[0]] && vertices[pick.e[1]] ? [...vertices[pick.e[0]], ...vertices[pick.e[1]]] : [];
        }
        if (pick.kind === 'face') {
          const face = this.cage.faces[pick.f];
          if (!face) {
            return [];
          }

          return face.flatMap((i, corner) => [...vertices[i], ...vertices[face[(corner + 1) % 4]]]);
        }

        return [];
      });
    const pts = (ps: Pick[]) => ps.flatMap(pick => (pick.kind === 'vert' && this.cage.verts[pick.i] ? [...this.cage.verts[pick.i]] : []));
    setLines(this.creaseLines, (this.cage.creases ?? []).flatMap(([a, b]) => (this.cage.verts[a] && this.cage.verts[b] ? [...this.cage.verts[a], ...this.cage.verts[b]] : [])));
    setLines(this.marks, seg(this.picks));
    setPositions(this.markDots, pts(this.picks));
    const hovered = this.hovered ? [this.hovered] : [];
    setLines(this.hoverMarks, seg(hovered));
    setPositions(this.hoverDots, pts(hovered));
    // Picked faces filled (two triangles each).
    const fill = this.picks.flatMap((pick) => {
      if (pick.kind !== 'face' || !this.cage.faces[pick.f]) {
        return [];
      }
      const [a, b, cornerC, cornerD] = this.cage.faces[pick.f].map(i => this.cage.verts[i]);

      return [...a, ...b, ...cornerC, ...a, ...cornerC, ...cornerD];
    });
    const fg = this.markFill.geometry;
    fg.setAttribute('position', new BufferAttribute(new Float32Array(fill), 3));
    fg.computeBoundingSphere();
    this.app.view.requestRender();
  }

  // ------------------------------------------------------------- finishing

  /** Right-click: let go of the picked points/edges/faces; then finish (keeping the shape). */
  context(): void {
    if (this.dragging) {
      return;
    }
    if (this.picks.length) {
      return ((this.picks = []), this.selectionChanged());
    }
    if (this.choosingPlane) {
      return this.cancel();
    }
    this.done();
  }

  key(e: KeyboardEvent): boolean {
    if (e.key === 'Escape') {
      if (this.picks.length) {
        ((this.picks = []), this.selectionChanged());
      } else {
        this.cancel();
      }

      return true;
    }
    // Still choosing where it goes: nothing to finish yet.
    if (e.key === 'Enter' && this.choosingPlane) {
      return true;
    }
    if (e.key === 'Enter') {
      return (this.done(), true);
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && !this.face && this.picks.some(pick => pick.kind === 'face')) {
      return (this.deleteSelectedFaces(), true);
    }
    if (e.key.toLowerCase() === 'a' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      this.picks = this.cage.verts.map((_, i) => ({ kind: 'vert' as const, i }));
      this.selectionChanged();

      return true;
    }

    return false;
  }

  /** Save and close; returns the body id. */
  private done(): string | null {
    if (selfCrossings(this.cage, 2, 1).length) {
      this.app.ui.toast('The shape passes through itself (shown red) - pull the point back first', 'error');

      return null;
    }
    if (this.face) {
      if (this.error) {
        this.app.ui.toast(this.error, 'error');

        return null;
      }
      const faceFreeform = this.faceDraft();
      // A new step that shapes nothing: no step at all.
      if (this.face.existing) {
        this.saveEdit(faceFreeform.id, { cage: faceFreeform.cage, grid: faceFreeform.grid, ...(faceFreeform.more ? { more: faceFreeform.more } : {}) });
      } else if (!this.flat() || faceFreeform.more?.length) {
        this.app.store.add(faceFreeform);
      } // (several faces: made one smooth surface even as laid)
      this.app.setTool(null);

      return faceFreeform.face.body;
    }
    // Stored where it was made: later move steps in History still apply on top.
    const cage = { faces: structuredClone(this.cage.faces), verts: this.cage.verts.map(this.place.inv), ...(this.cage.creases?.length ? { creases: structuredClone(this.cage.creases) } : {}) };
    const open = !isClosed(cage);
    const symmetry = this.sym
      ? (() => {
        const origin = this.place.inv(this.sym!.origin);

        return { origin: origin, normal: norm(sub(this.place.inv(add(this.sym!.origin, this.sym!.normal)), origin)) };
      })()
      : undefined;
    const extra = { surface: this.surfaceSheet || undefined, thickness: open && this.thickness > 0 ? this.thickness : undefined, thickSide: open && this.thickness > 0 ? this.thickSide : undefined, symmetry };
    let id: string;
    if (this.existing) {
      id = this.existing.id;
      this.saveEdit(id, { cage, ...extra });
    } else {
      const freeform: FreeformFeature = { ...this.app.store.newIdentity('freeform', isClosed(cage) ? 'Freeform' : 'Freeform surface'), type: 'freeform', cage, ...extra };
      this.app.store.add(freeform);
      id = freeform.id;
    }
    // Left open with no thickness: a surface, which nothing solid can be done with - said as it is made, with the ways on.
    if (open && !(this.thickness > 0)) {
      this.app.ui.toast('This is an open surface, not a solid yet. Edit Freeform to give it a Thickness or fill its hole - or Fill to Plane.');
    }
    this.app.setTool(null);

    return id;
  }

  private cancel(): void {
    this.app.setTool(null);
  }

  /** Select the cage element under the pointer (used when a tap on the body opens the tool). */
  /**
   * Delete the cage faces under picked body geometry (from the select tool):
   * a face → its patch; an edge or a point → every patch that touches it.
   * The shape opens up, so the Thickness choice shows.
   */
  deleteAt(points: Vec3[], kind: 'face' | 'edge' | 'vertex'): void {
    const sub3 = subdivide(this.cage, 3);
    const count = sub3.n;
    const size = Math.max(1e-9, ...[0, 1, 2].map(axis => Math.max(...this.cage.verts.map(vertex => vertex[axis])) - Math.min(...this.cage.verts.map(vertex => vertex[axis]))));
    const dist3 = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    const doomed = new Set<number>();
    for (const q of points) {
      if (kind === 'face') {
        let best = -1;
        let bd = Infinity;
        sub3.grids.forEach((grid, gridIndex) => {
          const distance = dist3(sub3.points[grid[count >> 1][count >> 1]], q);
          if (distance < bd) {
            [bd, best] = [distance, gridIndex];
          }
        });
        if (best >= 0) {
          doomed.add(best);
        }
        continue;
      }
      // Patches whose rim passes through the edge / point.
      const rim = sub3.grids.map((grid) => {
        let distance = Infinity;
        for (let i = 0; i <= count; i++) {
          for (const [a, b] of [[0, i], [count, i], [i, 0], [i, count]]) {
            distance = Math.min(distance, dist3(sub3.points[grid[a][b]], q));
          }
        }

        return distance;
      });
      const min = Math.min(...rim);
      rim.forEach((distance, face) => distance < min + size * 0.01 && doomed.add(face));
    }
    if (!doomed.size) {
      return;
    }
    if (doomed.size >= this.cage.faces.length) {
      return this.app.ui.toast('At least one face has to stay');
    }
    this.cage = deleteFaces(this.cage, [...doomed]);
    this.picks = [];
    this.hovered = null;
    this.rebuild();
    this.selectionChanged();
    this.app.ui.toast('The shape is no longer closed: give it a Thickness to make a solid, or Done for a surface.');
    this.panelHint();
  }

  selectAt(pointer: ToolPointer): void {
    const hit = this.pickAt(pointer);
    if (!hit) {
      return;
    }
    this.picks = [hit];
    this.selectionChanged();
  }
}

/** Thick lines (segment pairs). */
/** Drawn as if `pull` (world units) nearer the eye - for the depth test only (never past halfway). */
function pulled<M extends Material>(material: M, pull: { value: number }): M {
  material.onBeforeCompile = (sh) => {
    sh.uniforms.pull = pull;
    sh.vertexShader
      = 'uniform float pull;\n'
      + sh.vertexShader.replace('#include <project_vertex>', '#include <project_vertex>\n  mvPosition.z = min(mvPosition.z + pull, mvPosition.z * 0.5);\n  gl_Position = projectionMatrix * mvPosition;');
  };
  material.customProgramCacheKey = () => 'pulled';

  return material;
}

/** A see-through dot: its texture's edge is cut at a lower alpha (the faint dot's whole alpha is under 0.5). */
function faint<M extends Material>(material: M): M {
  material.alphaTest = 0.05;

  return material;
}

function setLines(lines: LineSegments2, xyz: number[]): void {
  const geometry = lines.geometry as LineSegmentsGeometry;
  // (No segments: an empty instanced line draws nothing.)
  geometry.setPositions(xyz.length ? xyz : [0, 0, 0, 0, 0, 0]);
  lines.visible = xyz.length > 0;
}

function setPositions(lines: LineSegments | Points, xyz: number[]): void {
  const geometry = lines.geometry;
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(xyz), 3));
  geometry.computeBoundingSphere();
  geometry.computeBoundingBox();
}

/** Screen distance from (x, y) to segment a–b, and where along it (0…1). */
function segDist(x: number, y: number, a: [number, number], b: [number, number]): { d: number; t: number } {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / l2));

  return { d: Math.hypot(x - (a[0] + dx * t), y - (a[1] + dy * t)), t };
}

function inPoly(x: number, y: number, q: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = q.length - 1; i < q.length; j = i++) {
    const [xi, yi] = q[i];
    const [xj, yj] = q[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }

  return inside;
}

interface Placement {
  fwd(v: Vec3): Vec3;
  inv(v: Vec3): Vec3;
}

/**
 * Where later History steps put this body: moves, scales and mirrors that
 * act on it (not copies). `inv` undoes them, to store edits in the cage's own place.
 */
function placementOf(features: readonly Feature[], id: string): Placement {
  const i = features.findIndex(feature => feature.id === id);
  const steps = features
    .slice(i + 1)
    .filter((feature): feature is TransformFeature => feature.type === 'transform' && !feature.suppressed && !feature.copy && feature.bodies.includes(id) && ['move', 'scale', 'mirror'].includes(feature.op.kind));
  const turn = (point: Vec3, origin: Vec3, axis: Vec3, deg: number): Vec3 => {
    const unitAxis = norm(axis);
    const offset = sub(point, origin);
    const t = (deg * Math.PI) / 180;

    return add(origin, add(add(scale(offset, Math.cos(t)), scale(cross(unitAxis, offset), Math.sin(t))), scale(unitAxis, dot(unitAxis, offset) * (1 - Math.cos(t)))));
  };
  const reflect = (point: Vec3, origin: Vec3, normal: Vec3): Vec3 => {
    const unitNormal = norm(normal);

    return sub(point, scale(unitNormal, 2 * dot(sub(point, origin), unitNormal)));
  };
  const apply = (op: TransformFeature['op'], point: Vec3, back: boolean): Vec3 => {
    if (op.kind === 'move') {
      const rotate = op.rotate;
      if (!back) {
        return add(rotate && rotate.angle ? turn(point, rotate.origin, rotate.axis, rotate.angle) : point, op.translate);
      }
      const q = sub(point, op.translate);

      return rotate && rotate.angle ? turn(q, rotate.origin, rotate.axis, -rotate.angle) : q;
    }
    if (op.kind === 'scale') {
      return add(op.center, scale(sub(point, op.center), back ? 1 / op.factor : op.factor));
    }
    if (op.kind === 'mirror') {
      return reflect(point, op.plane.origin, op.plane.normal);
    }

    return point;
  };

  return {
    fwd: vector => steps.reduce((point, step) => apply(step.op, point, false), vector),
    inv: vector => [...steps].reverse().reduce((point, step) => apply(step.op, point, true), vector)
  };
}

/** The smooth surface's face outlines (each cage face's grid border), as line segment indices, shared edges once. */
function faceBorders(plan: SubdivPlan): Uint32Array {
  const seen = new Set<string>();
  const out: number[] = [];
  const seg = (a: number, b: number) => {
    const key = a < b ? `${a},${b}` : `${b},${a}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    out.push(a, b);
  };
  const count = plan.n;
  for (const grid of plan.grids) {
    for (let row = 0; row < count; row++) {
      seg(grid[row][0], grid[row + 1][0]);
      seg(grid[row][count], grid[row + 1][count]);
      seg(grid[0][row], grid[0][row + 1]);
      seg(grid[count][row], grid[count][row + 1]);
    }
  }

  return Uint32Array.from(out);
}
