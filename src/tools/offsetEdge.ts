// Offset Edge: a straight edge picked, then a flat face: a line on that face,
// parallel to the edge at the distance typed, from one side of the face's
// outline to the other (cut back where it would run past the face, carried on
// where it would stop short). It's made as a sketch on the face, so it splits
// the face into regions to extrude, cut or offset. The line itself is worked
// out in offsetEdgeGeom.ts.

import { add, dot, len, niceStep, norm, roundSig, scale, sub } from '../geom';
import { fmtLen } from '../units';
import { DimWidget } from './annotate';
import { DragTyping } from './dragTyping';
import { FeatureOp, type Slot } from './featureOp';
import { axisDrag, Handle } from './handles';
import { offsetLineOnFace } from './offsetEdgeGeom';
import { faceRefOf, type AppContext, type Sel } from './tool';
import type { ToolPointer } from '../view/input';
import type { PanelItem } from '../ui/ui';
import type { BodyMesh } from '../kernel/protocol';
import type { PlaneDef, SketchFeature, Vec3 } from '../doc/types';

interface EdgePick {
  start: Vec3;
  end: Vec3;
  sel: Sel;
}

interface FacePick {
  body: BodyMesh;
  face: number;
  plane: PlaneDef;
  sel: Sel;
}

const placeholder = (): PlaneDef => ({ origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, 0, 1] });

export class OffsetEdgeOp extends FeatureOp<SketchFeature> {
  readonly id = 'offsetEdge';
  private edge: EdgePick | null = null;
  private face: FacePick | null = null;
  private distance = 5;
  private typed = false;
  /** Why there's no line (the edge across the face, the line off it). */
  private problem: string | null = null;
  /** The line as it is now, in the world (the arrow sits on its middle). */
  private line: { a: Vec3; b: Vec3 } | null = null;
  /** A double arrow on the line, dragged to set how far from the edge it runs; the distance in a box beside it. */
  private arrows: [Handle, Handle] | null = null;
  private dim: DimWidget | null = null;
  private dragging: { from: ToolPointer; d0: number; foot: Vec3; out: Vec3 } | null = null;
  private typing = new DragTyping(this.app);

  /** Started from an edge (Offset Edge) or from the face (Offset from Edge): the other is tapped next. */
  constructor(app: AppContext, start?: { body: string; edge: number }, onFace?: { body: string; face: number }) {
    super(app, { ...app.store.newIdentity('sketch', 'Offset Edge'), type: 'sketch', plane: placeholder(), entities: [], log: [{ op: 'Offset Edge', n: 1 }] });
    if (start) {
      this.takeEdge(start.body, start.edge);
    }
    if (onFace) {
      this.takeFace(onFace.body, onFace.face);
    }
    this.slots = [this.edgeSlot(), this.faceSlot()];
    this.finishWhenPicked = false;
  }

  private takeEdge(body: string, edge: number): boolean {
    const info = this.app.view.body(body)?.edges[edge];
    if (!info || info.type !== 'LINE') {
      return false;
    }
    this.edge = { start: info.start, end: info.end, sel: { kind: 'edge', body, edge } };
    // A tenth of the edge to start with (5 mm was lost on a big part), until one is typed.
    if (!this.typed) {
      this.distance = roundSig(len(sub(info.end, info.start)) * 0.1) || this.distance;
    }
    this.sync();

    return true;
  }

  private edgeSlot(): Slot {
    return {
      label: 'Edge',
      describe: () => (this.edge ? 'Straight edge' : 'Tap a straight edge'),
      filled: () => !!this.edge,
      pick: { profiles: false, planes: false, edges: true, vertices: false, curves: false },
      rejectHint: 'Tap a straight edge of a body',
      shows: () => (this.edge ? [this.edge.sel] : []),
      accept: hit => hit.kind === 'edge' && this.takeEdge(hit.body, hit.edge)
    };
  }

  private faceSlot(): Slot {
    return {
      label: 'On face',
      describe: () => (this.face ? 'Face' : 'Tap the flat face to draw on'),
      filled: () => !!this.face,
      pick: { profiles: false, planes: false, edges: false, vertices: false, curves: false },
      rejectHint: 'Tap a flat face',
      shows: () => (this.face ? [this.face.sel] : []),
      accept: hit => hit.kind === 'face' && this.takeFace(hit.body, hit.face)
    };
  }

  private takeFace(id: string, face: number): boolean {
    const body = this.app.view.body(id);
    const plane = body?.faces[face]?.plane;
    if (!body || !plane) {
      return false;
    }
    this.face = { body, face, plane, sel: { kind: 'face', body: id, face } };
    const ref = faceRefOf(this.app, { body: id, face });
    if (ref) {
      this.feature.attachedTo = ref;
    }
    this.feature.plane = plane;
    this.sync();

    return true;
  }

  /** The line from the picks and the distance, into the sketch. */
  private sync(): void {
    this.problem = null;
    this.line = null;
    if (!this.edge || !this.face) {
      return;
    }
    const l = offsetLineOnFace(this.face.body, this.face.face, this.face.plane, this.edge.start, this.edge.end, this.distance);
    if (typeof l === 'string') {
      this.problem = l;
      this.feature.entities = [];

      return;
    }
    this.feature.entities = [{ id: 'offset', kind: 'line', a: l.a2, b: l.b2 }];
    this.line = { a: l.a, b: l.b };
  }

  /**
   * Where the line's middle is measured from on the edge, and the way a
   * bigger distance goes (across the face, away from the edge).
   */
  private frame(): { foot: Vec3; out: Vec3 } | null {
    if (!this.edge || !this.face || !this.line) {
      return null;
    }
    const n = norm(this.face.plane.normal);
    const flat = (p: Vec3): Vec3 => sub(p, scale(n, dot(sub(p, this.face!.plane.origin), n)));
    const e0 = flat(this.edge.start);
    const along = norm(sub(flat(this.edge.end), e0));
    const mid = scale(add(this.line.a, this.line.b), 0.5);
    const foot = add(e0, scale(along, dot(sub(mid, e0), along)));
    const w = sub(mid, foot);
    if (len(w) < 1e-9 || !this.distance) {
      return null;
    }

    return { foot, out: scale(norm(w), Math.sign(this.distance)) };
  }

  private setDistance(v: number): void {
    this.typed = true;
    this.distance = v;
    this.sync();
    this.app.ui.updatePanelValues([v]);
    this.dim?.setValue(v);
    this.update();
  }

  /** The double arrow and the value box come up once there is a line. */
  protected onDraftChanged(): void {
    const fr = this.dragging ?? this.frame();
    if (!fr || !this.line) {
      // (Dragged off the face: they stay where they were, to drag back.)
      if (!this.dragging) {
        this.dropGrip();
      }

      return;
    }
    if (!this.arrows) {
      this.arrows = [new Handle(this.app.view, 'arrow', 34), new Handle(this.app.view, 'arrow', 34)];
      this.dim = new DimWidget(this.app.view, { boxAt: 'beyond', boxGap: 96, dir: fr.out, value: this.distance, onInput: v => this.setDistance(v), onCommit: () => this.done() });
    }
    const mid = scale(add(this.line.a, this.line.b), 0.5);
    this.arrows[0].set(mid, fr.out);
    this.arrows[1].set(mid, scale(fr.out, -1));
    this.dim!.set(fr.foot, mid);
    this.dim!.setValue(this.distance);
  }

  private dropGrip(): void {
    this.arrows?.forEach(h => h.dispose());
    this.arrows = null;
    this.dim?.dispose();
    this.dim = null;
  }

  exit(): void {
    this.dropGrip();
    super.exit();
  }

  hover(p: ToolPointer | null): void {
    const on = !!p && !!this.arrows && (!!this.dragging || this.arrows.some(h => h.hit(p)));
    this.arrows?.forEach(h => h.setHot(on));
    if (!on) {
      super.hover(p);
    }
  }

  down(p: ToolPointer): boolean {
    const fr = this.frame();
    if (!fr || !this.arrows?.some(h => h.hit(p))) {
      return false;
    }
    this.dragging = { from: p, d0: this.distance, ...fr };

    return true;
  }

  drag(p: ToolPointer): void {
    const dr = this.dragging;
    if (!dr) {
      return;
    }
    this.typing.track(p);
    if (this.typing.active) {
      return;
    }
    const raw = dr.d0 + axisDrag(this.app.view, add(dr.foot, scale(dr.out, dr.d0)), dr.out, dr.from, p);
    const step = niceStep(this.app.view.cam.worldPerPixel(this.app.view.height) * 4);
    this.setDistance(Math.round(raw / step) * step);
    this.app.ui.setLabel(p.x, p.y, `${fmtLen(this.distance)}  · type a value`);
  }

  up(): void {
    this.dragging = null;
    this.typing.reset();
    this.app.ui.setLabel(0, 0, null);
    this.arrows?.forEach(h => h.setHot(false));
    this.onDraftChanged();
  }

  dragKey(e: KeyboardEvent): boolean {
    const dr = this.dragging;
    if (!dr) {
      return false;
    }

    return this.typing.key(e, {
      kind: 'length',
      apply: v => this.setDistance(v),
      commit: () => ((this.dragging = null), this.done()),
      cancel: () => this.setDistance(dr.d0)
    });
  }

  protected ready(): boolean {
    return super.ready() && !this.problem && this.feature.entities.length > 0;
  }

  protected items(): PanelItem[] {
    return [
      {
        type: 'number',
        label: 'Distance',
        value: this.distance,
        kind: 'length',
        onInput: (v) => {
          this.typed = true;
          this.distance = v;
          this.sync();
          this.dim?.setValue(v);
          this.update();
        }
      }
    ];
  }

  protected hint(): string {
    if (this.problem) {
      return `⚠ ${this.problem}`;
    }
    if (!this.edge) {
      return this.face ? 'Tap a straight edge: the line on this face runs alongside it.' : 'Tap a straight edge: the line runs alongside it.';
    }
    if (!this.face) {
      return 'Tap the flat face to draw the line on.';
    }

    return 'The line runs across the face beside the edge. Drag the double arrow, or type, to set how far from the edge (negative: the other side).';
  }
}
