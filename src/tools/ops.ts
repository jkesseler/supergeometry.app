// Solid, transform and construction operations. Each is a FeatureOp:
// pick slots + values + live preview; see featureOp.ts.

import { fillEdgeKey } from '../doc/types';
import { defaultPitch, threadLabel } from '../kernel/threads';
import { FRONT, GROUND, RIGHT, add, cross, dot, len, norm, niceStep, patternSpacing, roundSig, scale, sub, xDirFor } from '../geom';
import { evaluate, fmtLen } from '../units';
import { screenClass } from '../device';
import { entityPolylines } from '../sketch/curves';
import { arrangement, drawnRegions, regionRef } from '../sketch/regions';
import { isTouchDevice } from '../device';
import { detachFreeformCopy, freeformBodies } from '../doc/freeformCopies';
import { CopyToggle, copyMode, linkMode } from './copyToggle';
import { DragTyping, type DragTypingTarget } from './dragTyping';
import { Gimbal, GIMBAL_AXES, IN_PLANE, SCALE_PARTS, type GimbalPart } from './gimbal';
import { Ghost, ringGhost, rowGhost } from './ghost';
import { DimWidget } from './annotate';
import { faceBeforeShell } from './shellFace';
import { SketchTool } from './sketch';
import { edgeRefOf, edgesOfFace, faceIndexOf, faceRefOf, goneRefs, oppositeFace, sourceFrame, targetOf, type AppContext, type Sel } from './tool';
import { axisSlot, chainThrough, curvesSlot, directionSlot, faceOfName, facesSlot, pathSlot, planeSlot, pointSlot, sectionsSlot } from './slots';
import { axisDrag, Handle } from './handles';
import { FeatureOp, type Slot } from './featureOp';
import { QuickActions } from './quickActions';
import type { ToolPointer } from '../view/input';
import type { PanelItem, ToolItem } from '../ui/ui';
import type { AxisFeature, AxisKind, AxisRef, ConnectFeature, EdgeFeature, EdgeRef, ExtrudeFeature, ExtrudeSource, FaceRef, FillFeature, FillToPlaneFeature, ImageFeature, LoftFeature, MoveFaceFeature, PathRef, PlaneDef, PlaneFeature, ReplaceFaceFeature, RevolveFeature, ScaleFaceFeature, ShellFeature, SketchFeature, SplitFeature, SweepFeature, TransformFeature, Vec3 } from '../doc/types';
import type { ThreadFeature } from '../doc/types';

type Mode = 'auto' | 'new' | 'join' | 'cut' | 'intersect';
const MODES = [
  { id: 'auto', label: 'Auto' },
  { id: 'new', label: 'New body' },
  { id: 'join', label: 'Add' },
  { id: 'cut', label: 'Cut' },
  { id: 'intersect', label: 'Intersect' }
];

/** Any body in the project: with none, a new shape can only be a body of its own (no Operation to choose). */
const anyBody = (app: AppContext, self?: string) => app.view.bodyList.some(b => b.id !== self);  // (its own preview is not one)

/**
 * The result choice, "Operation"; `plain`: without Intersect (a tool that only
 * adds, cuts or stands alone). `auto`: what Auto does here now ("Cut", "Add",
 * "New body") - said on its option.
 */
function modeChoice<M extends Mode>(get: () => M, set: (m: M) => void, rerender: () => void, plain = false, auto?: () => string): PanelItem {
  const effect = auto?.();
  const options = (plain ? MODES.filter(mode => mode.id !== 'intersect') : MODES).map(mode => (mode.id === 'auto' && effect ? { id: mode.id, label: `Auto: ${effect}` } : mode));
  const now = get();

  return { type: 'choice', label: 'Operation', options, value: now, onChange: mode => (set(mode as M), rerender()) };
}

/** What Auto does for a revolve, sweep or loft: adds to the body it is drawn on, else a body of its own. */
const autoAddsOrNew = (target: string | undefined) => (target ? 'Add' : 'New body');

// ------------------------------------------------------------------ extrude

export interface ExtrudeOptions {
  /** Face push/pull: edit the total thickness or the offset. */
  measure?: 'total' | 'offset';
  distance?: number;
  /** Text being typed when the tool took over (restored into the widget). */
  typed?: string;
  /** The distance as an expression (e.g. a variable, or "wall - 4"). */
  expr?: string;
}

/**
 * Extrude profiles or push/pull a flat face. Drag the arrow or type a value in
 * the dimension next to it; for faces choose Total (thickness to the opposite
 * face) or Offset (how far the face moves). Negative offsets cut.
 */
/** The last extrude distance used: a new one from the Extrude button starts there. */
export const lastExtrude = { distance: 10 };

export class ExtrudeOp extends FeatureOp<ExtrudeFeature> {
  readonly id = 'extrude';
  private handle: Handle;
  private frame: { base: Vec3; normal: Vec3 };
  private dragging: { from: ToolPointer; d0: number } | null = null;
  private dim: DimWidget | null = null;
  private measure: 'total' | 'offset';
  private thick: { distance: number; point: Vec3 } | null = null;

  constructor(app: AppContext, source: ExtrudeSource, existing?: ExtrudeFeature, mode: Mode = 'auto', private opts: ExtrudeOptions = {}) {
    // Pushing a face of its own body is an Offset Face step in the history.
    const label = source.kind === 'face' && mode !== 'new' ? 'Offset Face' : undefined;
    super(app, { ...app.store.newIdentity('extrude', label), type: 'extrude', source, distance: opts.distance ?? 0, mode, target: targetOf(app, source) }, existing);
    // Auto by the way it goes: + a new body (or added to the body it is drawn on), - a cut.
    if (!existing) {
      this.feature.byDirection = true;
    }
    this.frame = sourceFrame(app, this.feature.source);
    this.handle = new Handle(app.view, 'arrow');
    if (this.feature.extent === 'to') {
      this.slots = [this.upToSlot()];
    }
    if (source.kind === 'face') {
      const faceIndex = faceIndexOf(app, source.face);
      if (faceIndex !== null) {
        this.thick = oppositeFace(app, source.face.body, faceIndex);
      }
    }
    this.measure = this.thick ? (opts.measure ?? 'total') : 'offset';
    // A digit typed on a selected face: the value so far (Total: the wall it leaves).
    if (opts.typed !== undefined && opts.distance === undefined && !existing) {
      const value = Number(opts.typed);
      if (Number.isFinite(value) && value > 0) {
        this.feature.distance = this.measure === 'total' && this.thick ? value - this.thick.distance : value;
      }
    }
    if (opts.expr && !existing) {
      this.feature.exprs = { distance: opts.expr };
    }
    // Typed (on the face, before the tool started) as a formula: kept as one.
    else if (opts.typed && !existing) {
      this.typedInto('distance', opts.typed, t => (this.thick && this.measure === 'total' ? `${t} - ${Math.round(this.thick.distance * 1e6) / 1e6}mm` : t));
    }
  }

  /** A variable picked for the value: total thickness = that variable (or the offset, in Offset mode). */
  private useVariable(name: string): void {
    const value = evaluate(name, 'length');
    if (value === null) {
      return;
    }
    const total = this.measure === 'total' && this.thick;
    const distance = total ? value - this.thick!.distance : value;
    this.feature.exprs = { ...(this.feature.exprs ?? {}), distance: total ? `${name} - ${Math.round(this.thick!.distance * 1e6) / 1e6}mm` : name };
    this.setDistance(distance);
    this.render();
  }

  enter(): void {
    super.enter();
    // A new one: the other tools that can start from the same shape, beside it
    // in the column (drag the arrow: Extrude; tap one of these: that tool).
    if (this.offsetsFace()) {
      // Offset Face: the face moves (its neighbours follow) - not an extrusion, so none of those tools.
      this.app.ui.setTools([
        ...(screenClass() === 'phone' ? [{ id: 'cancel', label: 'Cancel', icon: 'close' as const, shortcut: 'Esc', run: () => this.cancel() }] : []),
        { id: 'offsetFace', label: 'Offset Face', icon: 'offsetFace', active: true, sub: 'drag the arrow', run: () => {} }
      ]);
    } else if (!this.existing) {
      const src = this.feature.source;
      const sections: ExtrudeSource[] = src.kind === 'profile' ? src.regions.map(region => ({ ...src, regions: [region] })) : [src];
      this.app.ui.setTools([
        ...(screenClass() === 'phone' ? [{ id: 'cancel', label: 'Cancel', icon: 'close' as const, shortcut: 'Esc', run: () => this.cancel() }] : []),
        { id: 'extrude', label: 'Extrude', icon: 'extrude', active: true, sub: 'drag the arrow', run: () => {} },
        { id: 'revolve', label: 'Revolve', icon: 'revolve', run: () => this.app.setTool(new RevolveOp(this.app, src)) },
        { id: 'sweep', label: 'Sweep', icon: 'sweep', run: () => this.app.setTool(new SweepOp(this.app, src)) },
        { id: 'loft', label: 'Loft', icon: 'loft', sub: 'then tap the next shape', run: () => this.app.setTool(new LoftOp(this.app, sections, [])) }
      ]);
    }
    // From a sketch: the new solid is see-through while you size it, so the profile stays in view.
    if (this.feature.source.kind === 'profile') {
      this.app.view.setGhost(true);
    }
    this.dim = new DimWidget(this.app.view, {
      // Past the tip of the drag arrow (at the far end of the dimension).
      boxAt: 'beyond',
      boxGap: 96,
      dir: this.frame.normal,
      value: this.shown(),
      modes: this.thick ? [{ id: 'total', label: 'Total' }, { id: 'offset', label: 'Offset' }] : undefined,
      mode: this.measure,
      onMode: (mode) => {
        this.measure = mode as 'total' | 'offset';
        this.dim?.setValue(this.shown());
        this.onDraftChanged();
      },
      onInput: (value, text) => {
        const total = this.measure === 'total' && this.thick;
        this.typedInto('distance', text, t => (total ? `${t} - ${Math.round(this.thick!.distance * 1e6) / 1e6}mm` : t));
        this.setDistance(total ? value - this.thick!.distance : value);
      },
      onCommit: () => this.done(),
      onPin: () => this.pin(),
      variables: this.app.store.doc.variables.map(variable => variable.name),
      onVariable: name => this.useVariable(name),
      typed: this.opts.typed,
      focus: this.opts.typed !== undefined
    });
    this.onDraftChanged();
    this.showOps();
  }

  /** The value the widget shows: total thickness or offset. */
  private shown(): number {
    return this.measure === 'total' && this.thick ? this.thick.distance + this.feature.distance : this.feature.distance;
  }

  private dimEnds(): [Vec3, Vec3] {
    const { base, normal } = this.frame;
    const top = add(base, scale(normal, this.feature.distance));

    return this.measure === 'total' && this.thick ? [this.thick.point, top] : [base, top];
  }

  private pin(): void {
    const [a, b] = this.dimEnds();
    this.app.addPin({ text: fmtLen(Math.abs(this.shown())), a, b, at: scale(add(a, b), 0.5) });
  }

  get activeSketch(): string | undefined {
    return this.feature.source.kind === 'profile' ? this.feature.source.sketch : undefined;
  }

  /** A face of its own body pushed or pulled: Offset Face (the face moves; the faces around it follow). */
  private offsetsFace(): boolean {
    const src = this.feature.source;

    return src.kind === 'face' && this.feature.mode !== 'new' && this.feature.target === src.face.body;
  }

  protected hint(): string {
    if (this.offsetsFace()) {
      return 'Drag the arrow or type a distance to push or pull the face. The faces around it follow.';
    }
    if (this.feature.extent === 'through') {
      return 'It goes through every body in its way. Flip direction turns it the other way.';
    }
    if (this.feature.extent === 'to') {
      return 'It stops at the face or plane picked (a round face too).';
    }
    // (A bin drafted 5 came out narrowing to the top: which way a sign leans wasn't said.)
    if (this.feature.draft) {
      return `Draft ${Math.abs(this.feature.draft)}°: the sides lean ${this.feature.draft > 0 ? 'in' : 'out'} towards the far end - type ${this.feature.draft > 0 ? 'a minus angle to lean them out' : 'a plus angle to lean them in'}.`;
    }
    if (this.feature.symmetric) {
      return 'Symmetric: the distance goes each way from the shape - type half the whole width.';
    }
    // (Auto goes by the way it is pulled: which way does what.)
    if (this.feature.mode !== 'auto') {
      return 'Drag the arrow or type a distance.';
    }
    if (!this.feature.byDirection) {
      return 'Drag the arrow or type a distance; - cuts.';
    }

    return this.feature.target || this.feature.source.kind === 'face' ? 'Drag the arrow or type a distance: out adds, in cuts.' : anyBody(this.app, this.feature.id) ? 'Drag the arrow or type a distance: + a new body, - a cut.' : 'Drag the arrow or type a distance.';
  }

  protected items(): PanelItem[] {
    const src = this.feature.source;
    // Symmetric: what's typed goes each way (30 typed made a clamp 60 wide, the box said "Distance").
    const distance = this.num(this.feature.symmetric && !this.offsetsFace() ? 'Each side' : 'Distance', 'distance', 'length', { onInput: value => this.setDistance(value), inBox: true });
    // (No Join / Cut / New or taper: those make it an extrusion.)
    if (this.offsetsFace()) {
      return [distance];
    }
    const ext = this.feature.extent ?? 'distance';

    return [
      ...(ext === 'distance' ? [distance] : []),
      ...this.extentItems(),
      // One side, or both ways from the shape (the distance each side).
      {
        type: 'choice' as const,
        label: 'Sides',
        options: [
          { id: 'one', label: 'One side' },
          { id: 'sym', label: 'Symmetric' }
        ],
        value: this.feature.symmetric ? 'sym' : 'one',
        onChange: (id: string) => {
          this.feature.symmetric = id === 'sym' || undefined;
          this.setHint();
          this.render();
          this.update();
          this.showOps();
        }
      },
      ...(anyBody(this.app, this.feature.id)
        ? [modeChoice(
          () => this.feature.mode,
          mode => this.setMode(mode),
          () => this.render(),
          false,
          () => (this.shownEffect = this.autoEffect())
        )]
        : []),
      // Every shape in the sketch at once (a scale, lettering: hundreds of them,
      // far too many to tap) - holes stay holes.
      ...(src.kind === 'profile' && !this.existing ? [{ type: 'button' as const, label: 'All shapes', onClick: () => this.allShapes() }] : []),
      ...this.startDraftItems(),
      // Lean the sides in towards a smaller end (a spire, a pyramid) - no angle to work out.
      // How big the far end is, in % of the shape: 100 none, 0 to a point. A
      // value box: type it, or press on it and drag left / right.
      {
        type: 'number' as const,
        label: 'Taper end %',
        value: Math.round((this.feature.taper ?? 1) * 1000) / 10,
        kind: 'number' as const,
        min: 0,
        // With variables (a shade's mouth over its neck: "shadeR / neckR * 100"): kept as the
        // fraction it stands for ("(…) / 100"), shown as typed.
        expr: /^\((.*)\) \/ 100$/.exec(this.feature.exprs?.taper ?? '')?.[1] ?? (this.feature.exprs?.taper ? `(${this.feature.exprs.taper}) * 100` : undefined),
        onExpr: (x: string | null) => this.typedInto('taper', x ?? '', t => `(${t}) / 100`),
        onInput: (value: number) => {
          // Up to 10 times as big (a lamp shade from a narrow neck flares more than 3 times).
          const t = Math.min(1000, value) / 100;
          this.feature.taper = Math.abs(t - 1) < 1e-9 ? undefined : t;
          this.onDraftChanged();
        }
      }
    ];
  }

  private setMode(mode: Mode): void {
    this.feature.mode = mode;
    // Through all with no way picked yet: a cut goes into the body.
    if (this.feature.extent === 'through' && !this.throughFlipped) {
      this.feature.distance = this.throughInto(mode) ? -1 : 1;
    }
    // A new body from a face (a spire on a tower): its own height is what's typed,
    // not the total through the body - 68 typed came out 102 down into the tower.
    if (mode === 'new' && this.measure === 'total') {
      this.measure = 'offset';
      this.dim?.setMode('offset');
      this.dim?.setValue(this.shown());
    }
    this.update();
    this.showOps();
  }

  /**
   * From a body's face (pushed or pulled, or a sketch drawn on it): what it can
   * do, as round buttons beside the face on the far side from the arrow - out,
   * Add or New body; in, Cut, Intersect or New body. The one it does now is
   * lit; a tap makes it that. Made again only when the way or the choice changes.
   */
  private ops: QuickActions | null = null;
  private opsSig = '';

  private showOps(): void {
    const feature = this.feature;
    const fromFace = (feature.source.kind === 'face' || !!feature.target) && (feature.extent ?? 'distance') === 'distance' && !feature.symmetric;
    const out = feature.distance >= 0;
    const now = feature.mode === 'auto' ? ({ Add: 'join', Cut: 'cut', 'New body': 'new' } as Record<string, Mode>)[this.autoEffect()] ?? 'auto' : feature.mode;
    const sig = fromFace && feature.distance !== 0 ? `${out}|${now}` : '';
    if (sig === this.opsSig) {
      return;
    }
    this.opsSig = sig;
    this.ops?.dispose();
    this.ops = null;
    if (!sig) {
      return;
    }
    const pick = (mode: Mode) => () => {
      this.setMode(mode);
      this.setHint();
      this.render();
    };
    const items: ToolItem[] = (
      out
        ? [
          { id: 'join', label: 'Add', icon: 'union' },
          { id: 'new', label: 'New body', icon: 'newBody' }
        ]
        : [
          { id: 'cut', label: 'Cut', icon: 'subtract' },
          { id: 'intersect', label: 'Intersect', icon: 'intersect' },
          { id: 'new', label: 'New body', icon: 'newBody' }
        ]
    ).map(it => ({ ...it, icon: it.icon as ToolItem['icon'], active: it.id === now, run: pick(it.id as Mode) }));
    const normal = this.frame.normal;
    this.ops = QuickActions.of(this.app.view, items, this.frame.base, { facing: out ? normal : [-normal[0], -normal[1], -normal[2]], hideBack: false });
  }

  /**
   * Where it ends (a set distance, through everything, or up to a face or
   * plane), where it starts, and how much its sides lean (a draft).
   */
  private extentItems(): PanelItem[] {
    const feature = this.feature;
    const ext = feature.extent ?? 'distance';

    return [
      {
        type: 'choice' as const,
        label: 'Ends',
        // (Through all: through the bodies there are - with none, not offered.)
        options: [
          { id: 'distance', label: 'Distance' },
          ...(ext === 'through' || anyBody(this.app, feature.id) ? [{ id: 'through', label: 'Through all' }] : []),
          { id: 'to', label: 'Up to' }
        ],
        value: ext,
        onChange: (id: string) => this.setExtent(id as 'distance' | 'through' | 'to')
      },
      // Through all: which way (the arrow's).
      ...(ext === 'through'
        ? [{ type: 'button' as const, label: 'Flip direction', onClick: () => ((this.throughFlipped = true), (feature.distance = -(feature.distance || 1)), this.onDraftChanged(), this.render(), this.update()) }]
        : [])
    ];
  }

  /** Where it starts (from the shape, along its normal) and how far its sides lean. */
  private startDraftItems(): PanelItem[] {
    const feature = this.feature;

    return [
      this.num('Start', 'start', 'length', { onInput: value => ((feature.start = value || undefined), this.onDraftChanged(), this.update()) }),
      this.num('Draft angle', 'draft', 'angle', { onInput: value => ((feature.draft = value || undefined), this.update()) })
    ];
  }

  /** Flip direction pressed: Through all goes the way the user chose, whatever the mode. */
  private throughFlipped = false;

  /** Through all with no way picked: into the body for a cut, or for Auto on a body's face (it faces out). */
  private throughInto(mode: ExtrudeFeature['mode']): boolean {
    if (mode === 'cut') {
      return true;
    }
    if (mode !== 'auto') {
      return false;
    }
    const src = this.feature.source;
    const sk = src.kind === 'profile' ? this.app.store.find<SketchFeature>(src.sketch) : undefined;

    return !!sk?.attachedTo && dot(sk.attachedTo.normal, sk.plane.normal) > 0.5;
  }

  private setExtent(ext: 'distance' | 'through' | 'to'): void {
    const feature = this.feature;
    feature.extent = ext === 'distance' ? undefined : ext;
    if (ext !== 'to') {
      feature.to = undefined;
    }
    // Up to: a face or plane to pick (the next tap takes it).
    this.slots = ext === 'to' ? [this.upToSlot()] : [];
    this.active = ext === 'to' && !feature.to ? 0 : -1;
    if (ext === 'to' && feature.symmetric) {
      feature.symmetric = undefined;
    }
    if (ext === 'distance' && !feature.distance) {
      feature.distance = lastExtrude.distance;
    }
    // Through all, no way picked yet: a cut goes into the body (a sketch on a
    // face faces out of it: a hole "through all" went off into the air, cut nothing).
    // (So does Auto on a body's face: up off it, Through all only made a tower 350 high.)
    if (ext === 'through' && !this.throughFlipped && (!feature.distance || this.throughInto(feature.mode))) {
      feature.distance = this.throughInto(feature.mode) ? -1 : 1;
    }
    this.onDraftChanged();
    this.render();
    this.update();
    this.showOps();
  }

  /** Up to: any face of a body (flat or round), or a plane. */
  private upToSlot(): Slot {
    let shown: Sel | null = null;
    let name = this.feature.to?.face ? 'Face' : this.feature.to?.plane ? 'Plane' : '';
    const take = (to: { face?: FaceRef; plane?: PlaneDef }, label: string, sel: Sel | null) => {
      this.feature.to = to;
      name = label;
      shown = sel;
    };

    return {
      label: 'Up to',
      describe: () => (this.feature.to ? name || 'Face' : 'Tap a face or a plane'),
      filled: () => !!(this.feature.to?.face || this.feature.to?.plane),
      originPlanes: true,
      rejectHint: 'Tap a face of a body, or a plane',
      pick: { profiles: false, edges: false, planes: true },
      presets: [
        ...['XY', 'XZ', 'YZ'].map(id => ({ label: id, apply: () => take({ plane: this.app.view.planeOf(id)! }, `${id} plane`, null) })),
        ...this.app.view.construction.planes.map(plane => ({ label: plane.name, apply: () => take({ plane: plane.plane }, plane.name, null) }))
      ],
      shows: () => (shown ? [shown] : []),
      accept: (hit) => {
        if (hit.kind === 'plane') {
          const plane = this.app.view.planeOf(hit.id);
          if (!plane) {
            return false;
          }
          take({ plane: plane }, ['XY', 'XZ', 'YZ'].includes(hit.id) ? `${hit.id} plane` : 'Plane', { kind: 'plane', id: hit.id });

          return true;
        }
        if (hit.kind === 'face') {
          const ref = faceRefOf(this.app, hit);
          if (!ref) {
            return false;
          }
          take({ face: ref }, 'Face', { kind: 'face', body: hit.body, face: hit.face });

          return true;
        }

        return false;
      }
    };
  }

  private allShapes(): void {
    const src = this.feature.source;
    if (src.kind !== 'profile') {
      return;
    }
    // What was drawn (not the outline of the face the sketch is on).
    const drawn = this.app.store.find<SketchFeature>(src.sketch)?.entities ?? [];
    const regs = drawnRegions(arrangement(this.app.sketchCurves(src.sketch)), arrangement(drawn));
    if (!regs.length) {
      return;
    }
    this.feature.source = { ...src, regions: regs.map(regionRef) };
    this.frame = sourceFrame(this.app, this.feature.source);
    this.app.setSelection(regs.map(region => ({ kind: 'profile' as const, sketch: src.sketch, region: region.index })));
    this.app.ui.toast(`${regs.length} shapes`);
    this.onDraftChanged();
  }

  protected ready(): boolean {
    const ext = this.feature.extent ?? 'distance';
    if (ext === 'to') {
      return !!(this.feature.to?.face || this.feature.to?.plane);
    }

    return ext === 'through' || this.feature.distance !== 0;
  }

  exit(): void {
    this.exited = true;
    this.handle.dispose();
    this.dim?.dispose();
    this.ops?.dispose();
    this.ops = null;
    this.opsSig = '';
    this.app.view.setGhost(false);
    super.exit();
  }

  hover(pointer: ToolPointer | null): void {
    const on = !!pointer && (!!this.dragging || this.handle.hit(pointer));
    this.handle.setHot(on);
    this.app.view.canvas.style.cursor = on ? 'grab' : '';
    if (!on) {
      super.hover(pointer);
    }
  }

  /**
   * Another region of the same sketch tapped while the arrow is still at 0
   * (on a phone a tapped region opens Extrude straight away): it joins the
   * profile - tapped again, it leaves. So several regions go up together.
   */
  tap(pointer: ToolPointer, count = 1): void {
    // The second tap of a double tap on a shape: open its sketch to edit it
    // (the first tap already opened Extrude, which took the second as "leave
    // the profile" - double-tapping to edit a shape worked only now and then).
    if (count >= 2 && this.feature.distance === 0 && this.feature.source.kind === 'profile') {
      // On its outline or inside it (the middle of a 7 × 2 blade section is
      // too far from its edges for a finger): the piece of it nearest the tap.
      // (Worked out on the sketch's plane: its curves aren't picked while Extrude is open.)
      const sk = this.app.store.doc.features.find((feature): feature is SketchFeature => feature.id === (this.feature.source as { sketch: string }).sketch && feature.type === 'sketch');
      const at = sk && this.app.view.rayToPlane(pointer.x, pointer.y, sk.plane);
      if (sk && at) {
        const y = cross(sk.plane.normal, sk.plane.xDir);
        const offset = sub(at, sk.plane.origin);
        const uv = [dot(offset, sk.plane.xDir), dot(offset, y)];
        let best: { id: string; d: number } | null = null;
        for (const e of sk.entities) {
          for (const poly of entityPolylines(e)) {
            for (let i = 1; i < poly.length; i++) {
              const [a, b] = [poly[i - 1], poly[i]];
              const ab = [b[0] - a[0], b[1] - a[1]];
              const t = Math.max(0, Math.min(1, ((uv[0] - a[0]) * ab[0] + (uv[1] - a[1]) * ab[1]) / (ab[0] ** 2 + ab[1] ** 2 || 1)));
              const dd = Math.hypot(a[0] + ab[0] * t - uv[0], a[1] + ab[1] * t - uv[1]);
              if (!best || dd < best.d) {
                best = { id: e.id, d: dd };
              }
            }
          }
        }
        if (best) {
          const tool = new SketchTool(this.app, { sketchId: sk.id });
          this.app.setSelection([]);
          this.app.setTool(tool);
          tool.preselect([best.id]);

          return;
        }
      }
    }
    if (this.feature.distance === 0 && this.regionTap(pointer)) {
      return;
    }
    super.tap(pointer);
  }

  protected regionsChanged(): void {
    this.frame = sourceFrame(this.app, this.feature.source);
  }

  /** When a tap on a shape opened it (straight away); not when a drag of its arrow did. */
  private openedAt = -Infinity;

  /** Opened by a tap: a second tap right after is the double tap's (not a grab of the arrow). */
  markTapped(): this {
    this.openedAt = performance.now();

    return this;
  }

  /**
   * The tool open, the shape or the face it pulls dragged by itself (not its arrow): that drag pulls it, as it does
   * before the tool is open. (On a phone a tap on a shape opens Extrude at once: the next thing a hand does is drag
   * the shape - which turned the view.)
   */
  dragStart(pointer: ToolPointer): boolean {
    if (this.dragging || this.feature.extent === 'to' || this.feature.extent === 'through') {
      return false;
    }
    const src = this.feature.source;
    const hit = this.app.view.pick(pointer.x, pointer.y, { planes: false, axes: false, edgeTolPx: pointer.tol });
    const mine = src.kind === 'profile' ? hit?.kind === 'profile' && hit.sketch === src.sketch : hit?.kind === 'face' && hit.body === src.face.body && faceIndexOf(this.app, src.face) === hit.face;
    if (!mine) {
      return false;
    }
    this.dragging = { from: pointer, d0: this.feature.distance };
    this.handle.setHot(true);

    return true;
  }

  /** Started by dragging the face or shape itself: the press that opened this drags it, wherever on it it is. */
  private grabbed = false;
  grabAnywhere(): this {
    this.grabbed = true;

    return this;
  }

  down(pointer: ToolPointer): boolean {
    if (this.grabbed) {
      this.grabbed = false;
      this.dragging = { from: pointer, d0: this.feature.distance };
      this.handle.setHot(true);

      return true;
    }
    if (!this.handle.hit(pointer)) {
      return false;
    }
    // The second tap of a double tap on a small shape lands on the arrow just
    // drawn there: a tap still (to open the sketch), not a grab of the arrow.
    if (this.feature.distance === 0 && performance.now() - this.openedAt < 450) {
      return false;
    }
    this.dragging = { from: pointer, d0: this.feature.distance };
    this.handle.setHot(true);

    return true;
  }

  drag(pointer: ToolPointer): void {
    if (!this.dragging) {
      return;
    }
    this.typing.track(pointer);
    if (this.typing.active) {
      return;
    } // a typed value wins over the pointer
    const { d0, from } = this.dragging;
    const raw = d0 + axisDrag(this.app.view, add(this.frame.base, scale(this.frame.normal, d0)), this.frame.normal, from, pointer);
    const step = niceStep(this.app.view.cam.worldPerPixel(this.app.view.height) * 4);
    this.typedInto('distance', '');
    this.setDistance(Math.round(raw / step) * step);
    this.app.ui.setLabel(pointer.x, pointer.y, `${this.measure === 'total' && this.thick ? 'Total ' : ''}${fmtLen(this.shown())}  · type a value`);
  }

  up(): void {
    this.dragging = null;
    this.typing.reset();
    this.app.ui.setLabel(0, 0, null);
    this.handle.setHot(false);
  }

  private typing = new DragTyping(this.app);

  dragKey(e: KeyboardEvent): boolean {
    const dr = this.dragging;
    if (!dr) {
      return false;
    }

    return this.typing.key(e, {
      kind: 'length',
      apply: value => this.setDistance(this.measure === 'total' && this.thick ? value - this.thick.distance : value),
      commit: () => ((this.dragging = null), this.done()),
      cancel: () => this.setDistance(dr.d0)
    });
  }

  /** What Auto does with the extrude as it is now. */
  private autoEffect(): string {
    const feature = this.feature;
    const into = feature.distance < 0;
    // On a face of a body (a sketch on it, or the face itself pushed): out adds to it, in cuts it.
    if (feature.target || feature.source.kind === 'face') {
      return into ? 'Cut' : 'Add';
    }
    // On its own: going - it cuts what it runs into (a new body if nothing); + a new body (made before: a cut either way).
    if (!feature.byDirection) {
      return this.app.view.bodyList.length ? 'Cut or new' : 'New body';
    }

    return into && this.app.view.bodyList.length ? 'Cut' : 'New body';
  }

  /** What the Operation row says Auto does, as it was last drawn. */
  private shownEffect = '';
  private exited = false;

  private setDistance(distance: number): void {
    this.feature.distance = distance;
    // Auto now does the other thing (dragged through the shape's plane, or
    // typed below 0): the Operation says so. (Against what it says, not the
    // distance before: the box writes the value in first - -8 typed for a
    // pocket cut it, the Operation still said "Auto: Add".)
    // (Typed in the window's own box: once it's left - drawn again now, the
    // window would be rebuilt under the finger, the box with what's typed gone.)
    if (this.feature.mode === 'auto' && this.autoEffect() !== this.shownEffect) {
      const typing = document.activeElement instanceof HTMLElement && document.activeElement.closest('#panel') ? document.activeElement : null;
      if (typing) {
        typing.addEventListener('blur', () => !this.exited && this.render(), { once: true });
      } else {
        queueMicrotask(() => this.render());
      }
    }
    this.app.ui.updatePanelValues([distance]);
    this.dim?.setValue(this.shown());
    this.update();
    this.showOps();
  }

  protected onDraftChanged(): void {
    this.handle.set(add(this.frame.base, scale(this.frame.normal, this.feature.distance)), this.frame.normal);
    const [a, b] = this.dimEnds();
    this.dim?.set(a, b);
  }

  protected done(): void {
    // Nothing pulled: nothing made. (Up to a face or plane, or through all, has
    // no distance of its own: Done there made nothing and said nothing.)
    // (A shape from a sketch left at 0 - Symmetric's box is "Each side", and
    // a 60 meant for it went nowhere: Done closed without a word.)
    if (this.feature.distance === 0 && (this.feature.extent ?? 'distance') === 'distance') {
      if (!this.existing && this.feature.source.kind === 'profile') {
        this.app.ui.toast(`Nothing made: the ${this.feature.symmetric ? 'distance each side' : 'distance'} was 0`);
      }

      return this.app.setTool(null);
    }
    if (!this.existing && this.feature.source.kind === 'profile') {
      lastExtrude.distance = this.feature.distance;
    }
    super.done();
  }

}

// ---------------------------------------------------------- fillet/chamfer

/**
 * The edges with the other pieces of their circle: a loft from a square to a
 * round mouth has the mouth's circle in five pieces, and one tapped was a
 * quarter of the rim - its fillet could not be made ("would damage the body").
 */
function withCircleKin(app: AppContext, edges: EdgeRef[]): EdgeRef[] {
  const out = [...edges];
  const has = (body: string, midpoint: Vec3) => out.some(e => e.body === body && Math.hypot(...sub(e.mid, midpoint)) < 1e-6);
  for (const e of edges) {
    const all = app.view.body(e.body)?.edges;
    const me = all?.find(edgeInfo => Math.hypot(...sub(edgeInfo.mid, e.mid)) < 1e-6);
    if (!all || !me || me.type !== 'CIRCLE') {
      continue;
    }
    // The circle through its ends and middle (a whole circle, its ends one point, is already whole).
    const a = sub(me.start, me.end), b = sub(me.mid, me.end);
    const normal = cross(a, b);
    const nn = dot(normal, normal);
    if (nn < 1e-12 || Math.hypot(...a) < 1e-6) {
      continue;
    }
    const center = add(me.end, scale(cross(sub(scale(b, dot(a, a)), scale(a, dot(b, b))), normal), 1 / (2 * nn)));
    const radius = Math.hypot(...sub(me.mid, center));
    const axis = norm(normal);
    const tol = 1e-5 * Math.max(1, radius);
    const on = (q: Vec3) => Math.abs(Math.hypot(...sub(q, center)) - radius) < tol && Math.abs(dot(sub(q, center), axis)) < tol;
    for (const x of all) {
      if (x.type !== 'CIRCLE' || !on(x.start) || !on(x.mid) || !on(x.end) || has(e.body, x.mid)) {
        continue;
      }
      out.push({ body: e.body, mid: x.mid, dir: x.dir, length: x.length, ...(x.steps ? { steps: x.steps } : {}) });
    }
  }

  return out;
}

export class EdgeOp extends FeatureOp<EdgeFeature> {
  readonly id: string;
  private handle: Handle;
  private origin: Vec3;
  private axis: Vec3;
  private dragging: { from: ToolPointer; r0: number; onDot?: boolean; moved?: boolean } | null = null;

  /** Text typed on the selected edges before the tool took over (restored into the size box). */
  private typed?: string;

  constructor(app: AppContext, kind: 'fillet' | 'chamfer', edges: EdgeRef[], existing?: EdgeFeature, variable?: string, typed?: string) {
    // Started from a variable: the size is that variable (and follows it when it changes).
    // Started by typing: the first digit is the size so far.
    const t = typed !== undefined && !variable ? Number(typed) : NaN;
    const value = variable ? evaluate(variable, 'length') : t > 0 ? t : null;
    super(app, { ...app.store.newIdentity(kind), type: kind, edges: existing ? edges : withCircleKin(app, edges), radius: value ?? 1, ...(variable && value !== null ? { exprs: { radius: variable } } : {}) }, existing);
    this.id = kind;
    this.typed = typed;
    this.names = { fillet: existing?.type === 'fillet' ? existing.name : app.store.newIdentity('fillet').name, chamfer: existing?.type === 'chamfer' ? existing.name : app.store.newIdentity('chamfer').name };
    const e = this.feature.edges[0];
    this.origin = e.mid;
    this.axis = outwardOf(app, e) ?? (() => {
      const view = app.view.camera.position.clone().sub(app.view.cam.target).normalize().toArray() as Vec3;
      const perp = norm(cross(cross(e.dir, view), e.dir));

      return dot(perp, view) < 0 ? scale(perp, -1) : perp;
    })();
    this.handle = new Handle(app.view, 'dot');
    this.groupKin(this.feature.edges);
  }

  private names: { fillet: string; chamfer: string };

  /** Fillets sit outside the edge (+), chamfers inside (−): dragging across the edge switches. */
  private signed(): number {
    return this.feature.type === 'fillet' ? this.feature.radius : -this.feature.radius;
  }

  protected hint(): string {
    return this.feature.type === 'fillet' ? 'Drag the dot or type a size to round the edge. Tap more edges to round them too (a face: all round it).' : 'Drag the dot or type a size to cut the edge off at a slant. Tap more edges to add them (a face: all round it).';
  }

  protected items(): PanelItem[] {
    const feature = this.feature;
    // Fillet: one radius, or one that runs from a start radius to an end one.
    // Chamfer: the same distance along both faces, or a different one along each.
    const fillet = feature.type === 'fillet';
    const two = fillet ? feature.radius2 !== undefined : feature.distance2 !== undefined;
    const word = feature.chord ? 'width' : 'radius';
    const size = this.num(fillet ? (two ? `Start ${word}` : feature.chord ? 'Width' : 'Radius') : two ? 'Distance 1' : 'Distance', 'radius', 'length', { min: 0.0001, onInput: value => this.setRadius(value), inBox: true });
    // Fillet size: the radius, or the chord - straight across the round, face to face.
    // Round (circular) or Smooth (G2: the bend eases in from the faces).
    const blend: PanelItem = {
      type: 'choice',
      label: 'Blend',
      options: [
        { id: 'round', label: 'Round' },
        { id: 'g2', label: 'Smooth (G2)' }
      ],
      value: feature.g2 ? 'g2' : 'round',
      onChange: (id) => {
        feature.g2 = id === 'g2' || undefined;
        if (feature.g2) {
          ((feature.radius2 = undefined), (feature.chord = undefined), (feature.flip = undefined));
        }
        this.render();
        this.update();
      }
    };
    if (fillet && feature.g2) {
      return [blend, size];
    }
    const sizeBy: PanelItem[] = fillet
      ? [
        blend,
        {
          type: 'choice',
          label: 'Size',
          options: [
            { id: 'radius', label: 'Radius' },
            { id: 'chord', label: 'Chord width' }
          ],
          value: feature.chord ? 'chord' : 'radius',
          onChange: (id) => {
            feature.chord = id === 'chord' || undefined;
            this.render();
            this.update();
          }
        }
      ]
      : [];

    return [
      {
        type: 'choice',
        label: 'Type',
        options: fillet
          ? [
            { id: 'equal', label: 'Constant' },
            { id: 'two', label: 'Variable' }
          ]
          : [
            { id: 'equal', label: 'Equal distance' },
            { id: 'two', label: 'Two distances' }
          ],
        value: two ? 'two' : 'equal',
        onChange: (id) => {
          if (id === 'two') {
            if (fillet) {
              feature.radius2 = feature.radius2 ?? roundSig(feature.radius / 2);
            } else {
              feature.distance2 = feature.distance2 ?? feature.radius;
            }
          } else {
            feature.distance2 = undefined;
            feature.radius2 = undefined;
            feature.flip = undefined;
          }
          this.render();
          this.update();
        }
      },
      ...sizeBy,
      size,
      ...(two
        ? [
          fillet ? this.num(`End ${word}`, 'radius2', 'length', { min: 0.0001 }) : this.num('Distance 2', 'distance2', 'length', { min: 0.0001 }),
          { type: 'button' as const, label: fillet ? 'Flip ends' : 'Flip sides', icon: 'flip' as const, onClick: () => ((feature.flip = !feature.flip || undefined), this.update()) }
        ]
        : []),
      // (Setback is for a corner where three rounded edges meet: offered once three are picked, or while it is set.)
      ...(fillet && ((feature.edges?.length ?? 0) >= 3 || (feature.setback ?? 0) > 0) ? [this.num('Corner setback', 'setback', 'length', { min: 0 })] : [])
    ];
  }

  /** The size, typed right at the edge (past the dot). */
  private dim: DimWidget | null = null;

  enter(): void {
    super.enter();
    // Edges it was built on that are gone (it said "pick the edges again"):
    // dropped, so the edges tapped now are what it rounds.
    const gone = this.existing ? goneRefs(this.app, this.feature.edges, this.feature.id) : [];
    if (gone.length) {
      this.feature.edges = this.feature.edges.filter(e => !gone.includes(e));
      this.app.ui.toast(`${gone.length} of its edges ${gone.length > 1 ? 'are' : 'is'} gone - tap the edges to ${this.feature.type === 'fillet' ? 'round' : 'cut'} now`);
    }
    this.app.setSelection(this.edgeSels());

    this.dim = new DimWidget(this.app.view, {
      boxAt: 'beyond',
      boxGap: 40,
      dir: this.axis,
      value: this.feature.radius,
      onInput: (value, text) => {
        if (!(value > 0)) {
          return;
        }
        this.typedInto('radius', text);
        this.setRadius(value);
      },
      onCommit: () => this.done(),
      typed: this.typed,
      focus: this.typed !== undefined,
      variables: this.app.store.doc.variables.map(variable => variable.name),
      onVariable: (name) => {
        const value = evaluate(name, 'length');
        if (value === null || value <= 0) {
          return;
        }
        this.feature.exprs = { ...(this.feature.exprs ?? {}), radius: name };
        this.setRadius(value);
        this.render();
      }
    });
    this.onDraftChanged();
  }

  exit(): void {
    this.handle.dispose();
    this.dim?.dispose();
    this.dim = null;
    super.exit();
  }

  /** Tapping edges while filleting adds/removes them. */
  tap(pointer: ToolPointer): void {
    const hit = this.app.view.pick(pointer.x, pointer.y, { edgeTolPx: pointer.tol, profiles: false, planes: false, axes: false, vertices: false });
    // A picked edge, tapped again: dropped. Its preview has rounded it away
    // (the view shows the result), so it's found by where it was - when it's
    // nearer the finger than any edge the view has there (the lip's other top
    // edge, 6 mm off, tapped, is that one, not the first one again; the
    // chamfer's own new edge beside where the first was is not).
    {
      const shown = hit?.kind === 'edge' ? this.app.view.body(hit.body)?.edges[hit.edge] : undefined;
      const hitD = shown ? this.screenDist(shown, pointer.x, pointer.y) : Infinity;
      // (A face under the finger: a picked edge counts only right by it - on a
      // plate's 8 mm side, seen at a slant, its rounded top edge was always
      // within a finger's reach, so the side never got added.)
      let again = this.pickedNear(pointer.x, pointer.y, Math.min(hit?.kind === 'face' ? pointer.tol / 3 : pointer.tol, hitD));
      // Or the edge where its preview's rounding meets a face (a 1 mm round's,
      // a hair nearer the finger than the edge it rounds: it was added, not
      // the edge dropped) - along it, the radius off it.
      if (again < 0 && shown) {
        again = this.roundedInto(shown);
      }
      if (again >= 0) {
        this.dropWithKin(again);
        this.app.setSelection(this.edgeSels());
        this.update();

        return;
      }
    }
    if (!hit) {
      return this.done();
    }
    // A face: all the edges round it (a nut's top, its six edges in one tap) -
    // or, all of them picked already, none of them.
    // (What this step's own preview made - a round's border, where it runs
    // out onto a face - isn't an edge of the body it rounds: a block's top,
    // tapped with three of its upright edges picked, brought in the three
    // corner arcs of their rounds as edges to round too.)
    const own = (steps?: string[]) => !!steps?.includes(this.feature.id);
    if (hit.kind === 'face') {
      const refs = edgesOfFace(this.app, hit.body, hit.face)
        .filter(edgeIndex => !this.app.view.body(hit.body)?.edges[edgeIndex]?.seam)
        .flatMap(edgeIndex => edgeRefOf(this.app, { body: hit.body, edge: edgeIndex }) ?? []);
      const at = (edgeRef: EdgeRef) => this.feature.edges.findIndex(e => e.body === edgeRef.body && Math.hypot(...sub(e.mid, edgeRef.mid)) < 1e-6);
      if (!refs.length) {
        return;
      }
      // The face tapped again, as its preview shows it - its edges rounded
      // in, new ones (they were added on top: a gusset's side tapped by
      // mistake couldn't be undone). It's that face when every edge it shows
      // is a picked one's rounded border (or picked itself): those are
      // dropped. (Not the face beside a picked edge: its other edges aren't.)
      const was = refs.map(ref => (at(ref) >= 0 ? at(ref) : this.roundedInto(ref)));
      if (refs.some(ref => at(ref) < 0) && was.every(i => i >= 0)) {
        const drop = new Set(was);
        this.feature.edges = this.feature.edges.filter((_, i) => !drop.has(i));
        this.app.setSelection(this.edgeSels());
        this.update();

        return;
      }
      if (refs.every(ref => at(ref) >= 0)) {
        this.feature.edges = this.feature.edges.filter(e => !refs.some(ref => ref.body === e.body && Math.hypot(...sub(e.mid, ref.mid)) < 1e-6));
      } else {
        // (Not a picked edge's rounded border, as the preview shows it: the
        // face beside a picked edge brought it in as an edge of its own.)
        const kin = withCircleKin(this.app, refs.filter(ref => at(ref) < 0 && this.roundedInto(ref) < 0 && !own(ref.steps)));
        this.groupKin(kin);
        for (const edgeRef of kin) {
          if (at(edgeRef) < 0) {
            this.feature.edges.push(edgeRef);
          }
        }
      }
      this.app.setSelection(this.edgeSels());
      this.update();

      return;
    }
    if (hit.kind !== 'edge') {
      return;
    }
    const info = this.app.view.body(hit.body)?.edges[hit.edge];
    if (!info) {
      return;
    }
    // A seam: the line where a round face starts and ends, the same face
    // either side - nothing there to round. (Picked, it broke the step: "an
    // edge it was built on is gone", and a tap again didn't take it out.)
    if (own(info.steps)) {
      return;
    }
    if (info.seam) {
      return this.app.ui.toast('That line is a seam - where a round face starts and ends, no corner there to ' + (this.feature.type === 'chamfer' ? 'chamfer' : 'round') + '. Tap a real edge.');
    }
    const i = this.feature.edges.findIndex(e => e.body === hit.body && Math.hypot(...sub(e.mid, info.mid)) < 1e-6);
    if (i >= 0) {
      this.dropWithKin(i);
    } else {
      // (With the rest of its circle, where the circle is in pieces.)
      const have = (midpoint: Vec3) => this.feature.edges.some(e => e.body === hit.body && Math.hypot(...sub(e.mid, midpoint)) < 1e-6);
      const kin = withCircleKin(this.app, [{ body: hit.body, mid: info.mid, dir: info.dir, length: info.length, ...(info.steps ? { steps: info.steps } : {}) }]);
      this.groupKin(kin);
      for (const edgeRef of kin) {
        if (!have(edgeRef.mid)) {
          this.feature.edges.push(edgeRef);
        }
      }
    }

    this.app.setSelection(this.edgeSels());
    this.update();
  }

  /** The picked straight edge whose preview's round (or cut) `e` is a border of: parallel, the size off it; else -1. */
  private roundedInto(e: { mid: Vec3; dir: Vec3 }): number {
    const radius = this.feature.radius;
    const direction = norm(e.dir);

    return this.feature.edges.findIndex((edge) => {
      const xd = norm(edge.dir);
      if (Math.abs(dot(xd, direction)) < 0.9999) {
        return false;
      }
      const off = len(cross(sub(e.mid, edge.mid), xd));

      // (Along it too: not the next edge over that happens to be in line.)
      return Math.abs(off - radius) < 1e-3 * Math.max(1, radius) && Math.abs(dot(sub(e.mid, edge.mid), xd)) < edge.length / 2;
    });
  }

  /** A picked edge dropped, and the other pieces of its circle with it (found before the preview rounded them away). */
  private dropWithKin(i: number): void {
    const key = (e: EdgeRef) => `${e.body}:${e.mid.map(value => value.toFixed(5)).join(',')}`;
    const group = this.kinGroups.get(key(this.feature.edges[i]));
    this.feature.edges = this.feature.edges.filter((e, j) => j !== i && (group === undefined || this.kinGroups.get(key(e)) !== group));
  }

  /** Which picked edges are pieces of one circle (each piece's key: its group). */
  private kinGroups = new Map<string, number>();

  private groupKin(edges: EdgeRef[]): void {
    const key = (e: EdgeRef) => `${e.body}:${e.mid.map(value => value.toFixed(5)).join(',')}`;
    for (const e of edges) {
      if (this.kinGroups.has(key(e))) {
        continue;
      }
      const kin = withCircleKin(this.app, [e]);
      if (kin.length < 2) {
        continue;
      }
      const groupNumber = this.kinGroups.size + 1;
      for (const edgeRef of kin) {
        this.kinGroups.set(key(edgeRef), groupNumber);
      }
    }
  }

  hover(): void {}

  /**
   * The picked edge (index) within `tol` px of the screen point, by its own
   * line (a straight edge's, or a curved one's middle), or -1. Only while the
   * view shows the preview: otherwise the edge is there to be picked.
   */
  private pickedNear(x: number, y: number, tol: number): number {
    const view = this.app.view;
    let best = -1;
    let bestD = tol;
    this.feature.edges.forEach((e, i) => {
      if (view.body(e.body)?.edges.some(q => Math.hypot(...sub(q.mid, e.mid)) < 1e-6)) {
        return;
      }
      const dist = this.screenDist(e, x, y);
      if (dist < bestD) {
        [best, bestD] = [i, dist];
      }
    });

    return best;
  }

  /** How far (px) a screen point is from an edge drawn as the line through its middle along its direction. */
  private screenDist(e: { mid: Vec3; dir: Vec3; length?: number }, x: number, y: number): number {
    const view = this.app.view;
    const direction = norm(e.dir);
    const half = (e.length ?? 0) / 2;
    const straight = Math.abs(len(e.dir)) > 0 && half > 0;
    const a = view.toScreen(straight ? sub(e.mid, scale(direction, half)) : e.mid);
    const b = view.toScreen(straight ? add(e.mid, scale(direction, half)) : e.mid);
    if (!a || !b) {
      return Infinity;
    }
    const [vx, vy] = [b[0] - a[0], b[1] - a[1]];
    const l2 = vx * vx + vy * vy;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - a[0]) * vx + (y - a[1]) * vy) / l2)) : 0;

    return Math.hypot(x - (a[0] + t * vx), y - (a[1] + t * vy));
  }

  private edgeSels(): Sel[] {
    return this.feature.edges.flatMap((e) => {
      const b = this.app.view.body(e.body);
      const edgeIndex = b?.edges.findIndex(edge => Math.hypot(...sub(edge.mid, e.mid)) < 1e-6) ?? -1;

      return edgeIndex >= 0 ? [{ kind: 'edge', body: e.body, edge: edgeIndex } as Sel] : [];
    });
  }

  protected ready(): boolean {
    return this.feature.edges.length > 0;
  }

  /** Started by dragging the dot on the edge itself: the size grows from the edge. */
  private fromEdge = false;

  /** The next press (the one that opened this from the edge's dot) drags from zero. */
  grabFromEdge(): this {
    this.fromEdge = true;

    return this;
  }

  down(pointer: ToolPointer): boolean {
    const first = this.fromEdge && !this.existing;
    this.fromEdge = false;
    if (first) {
      this.dragging = { from: pointer, r0: 0 };

      return true;
    }
    if (!this.handle.hit(pointer)) {
      return false;
    }
    this.dragging = { from: pointer, r0: this.signed(), onDot: true };

    return true;
  }

  drag(pointer: ToolPointer): void {
    if (!this.dragging) {
      return;
    }
    if (Math.hypot(pointer.x - this.dragging.from.x, pointer.y - this.dragging.from.y) > 4) {
      this.dragging.moved = true;
    }
    this.typing.track(pointer);
    if (this.typing.active) {
      return;
    }
    const { r0, from } = this.dragging;
    const raw = r0 + axisDrag(this.app.view, add(this.origin, scale(this.axis, r0)), this.axis, from, pointer);
    const step = niceStep(this.app.view.cam.worldPerPixel(this.app.view.height) * 3);
    // Outward: a fillet; pulled in past the edge: a chamfer.
    const kind = raw >= 0 ? 'fillet' : 'chamfer';
    if (kind !== this.feature.type) {
      this.feature.type = kind;
      this.feature.name = this.names[kind];
      this.render();
    }
    this.typedInto('radius', '');
    this.setRadius(Math.max(step, Math.round(Math.abs(raw) / step) * step));
    this.app.ui.setLabel(pointer.x, pointer.y, `${kind === 'fillet' ? 'Fillet' : 'Chamfer'} ${fmtLen(this.feature.radius)}  · type a value`);
  }

  up(): void {
    const dragging = this.dragging;
    this.dragging = null;
    this.typing.reset();
    this.app.ui.setLabel(0, 0, null);
    // The dot only touched, not dragged: a tap (on a lip 6 mm deep the dot on
    // one top edge sits a finger's width from the other, which took no taps there).
    // (Right on the dot it stays a touch of the dot.)
    const grab = dragging?.onDot && !dragging.moved ? this.handle.grabPoint() : null;
    if (grab && Math.hypot(grab[0] - dragging!.from.x, grab[1] - dragging!.from.y) > 14) {
      this.tap(dragging!.from);
    }
  }

  private typing = new DragTyping(this.app);

  dragKey(e: KeyboardEvent): boolean {
    const dr = this.dragging;
    if (!dr) {
      return false;
    }

    return this.typing.key(e, {
      kind: 'length',
      apply: value => value > 0 && this.setRadius(value),
      commit: () => ((this.dragging = null), this.done()),
      cancel: () => this.setRadius(dr.r0)
    });
  }

  private setRadius(radius: number): void {
    this.feature.radius = radius;
    this.app.ui.updatePanelValues([radius]);
    this.dim?.setValue(radius);
    this.update();
  }

  protected onDraftChanged(): void {
    const tip = add(this.origin, scale(this.axis, this.signed()));
    this.handle.set(tip);
    this.dim?.set(this.origin, tip);
    this.dim?.setValue(this.feature.radius);
  }
}

/** Away from the material at an edge: between the normals of the two flat faces it joins. */
function outwardOf(app: AppContext, e: EdgeRef): Vec3 | null {
  const b = app.view.body(e.body);
  if (!b) {
    return null;
  }
  const tol = Math.max(1e-6, e.length * 1e-4);
  const ns = b.faces.filter(face => face.plane && Math.abs(dot(face.normal, e.dir)) < 1e-4 && Math.abs(dot(face.normal, sub(e.mid, face.center))) < tol).map(face => face.normal);
  if (ns.length < 2) {
    return null;
  }
  const sum = add(ns[0], ns[1]);

  return len(sum) < 1e-6 ? null : norm(sum);
}

// ----------------------------------------------------------------- revolve

export class RevolveOp extends FeatureOp<RevolveFeature> {
  readonly id = 'revolve';
  private axisSet = false;

  constructor(app: AppContext, source: ExtrudeSource, existing?: RevolveFeature) {
    super(app, { ...app.store.newIdentity('revolve'), type: 'revolve', source, axis: { origin: [0, 0, 0], dir: [0, 0, 1] }, angle: 360, mode: 'auto', target: targetOf(app, source) }, existing);
    this.axisSet = !!existing;
    this.moreRegions = true;
    this.slots = [axisSlot(app, 'Axis', () => (this.axisSet ? this.feature.axis : null), a => ((this.feature.axis = a), (this.axisSet = true)))];
  }

  get activeSketch(): string | undefined {
    return this.feature.source.kind === 'profile' ? this.feature.source.sketch : undefined;
  }

  private handle: Handle | null = null;
  private dim: DimWidget | null = null;
  private dragging: { from: ToolPointer; t0: number } | null = null;
  private typing = new DragTyping(this.app);

  protected hint(): string {
    return 'Set how far the shape spins around the axis (360° is a full turn). Drag the arrow along the axis to make a spring.';
  }

  protected items(): PanelItem[] {
    return [
      this.num('Angle', 'angle', 'angle'),
      this.num('Travel', 'travel', 'length', { onInput: value => this.setTravel(value), inBox: true }),
      ...(anyBody(this.app, this.feature.id) ? [modeChoice(() => this.feature.mode, bodyMode => ((this.feature.mode = bodyMode), this.update()), () => this.render(), false, () => autoAddsOrNew(this.feature.target))] : [])
    ];
  }

  enter(): void {
    super.enter();
    this.onDraftChanged();
  }

  exit(): void {
    this.handle?.dispose();
    this.dim?.dispose();
    super.exit();
  }

  /** Where the profile sits on the axis (the arrow starts there). */
  private axisBase(): Vec3 {
    const { origin, dir } = this.feature.axis;
    const direction = norm(dir);
    const base = sourceFrame(this.app, this.feature.source).base;

    return add(origin, scale(direction, dot(sub(base, origin), direction)));
  }

  protected onDraftChanged(): void {
    if (!this.axisSet) {
      return;
    }
    const direction = norm(this.feature.axis.dir);
    const base = this.axisBase();
    const travel = this.feature.travel ?? 0;
    if (!this.handle) {
      this.handle = new Handle(this.app.view, 'arrow');
      this.dim = new DimWidget(this.app.view, { boxAt: 'beyond', boxGap: 96, dir: direction, value: travel, onInput: (value, text) => (this.typedInto('travel', text), this.setTravel(value)), onCommit: () => this.done() });
    }
    const tip = add(base, scale(direction, travel));
    this.handle.set(tip, travel < 0 ? scale(direction, -1) : direction);
    this.dim!.set(base, tip);
  }

  private setTravel(value: number): void {
    this.feature.travel = value || undefined;
    // Travelling with just a part of a turn is fine; a full turn is the usual start for a thread.
    this.app.ui.updatePanelValues([this.feature.angle, value]);
    this.dim?.setValue(value);
    this.update();
  }

  hover(pointer: ToolPointer | null): void {
    const on = !!pointer && !!this.handle && (!!this.dragging || this.handle.hit(pointer));
    this.handle?.setHot(on);
    if (!on) {
      super.hover(pointer);
    }
  }

  down(pointer: ToolPointer): boolean {
    if (!this.handle?.hit(pointer)) {
      return false;
    }
    this.dragging = { from: pointer, t0: this.feature.travel ?? 0 };

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
    const direction = norm(this.feature.axis.dir);
    const raw = dr.t0 + axisDrag(this.app.view, add(this.axisBase(), scale(direction, dr.t0)), direction, dr.from, pointer);
    const step = niceStep(this.app.view.cam.worldPerPixel(this.app.view.height) * 4);
    this.typedInto('travel', '');
    this.setTravel(Math.round(raw / step) * step);
    this.app.ui.setLabel(pointer.x, pointer.y, `Travel ${fmtLen(this.feature.travel ?? 0)}  · type a value`);
  }

  up(): void {
    this.dragging = null;
    this.typing.reset();
    this.app.ui.setLabel(0, 0, null);
    this.handle?.setHot(false);
  }

  dragKey(e: KeyboardEvent): boolean {
    const dr = this.dragging;
    if (!dr) {
      return false;
    }

    return this.typing.key(e, {
      kind: 'length',
      apply: value => this.setTravel(value),
      commit: () => ((this.dragging = null), this.done()),
      cancel: () => this.setTravel(dr.t0)
    });
  }
}

// ------------------------------------------------------------------- sweep

export class SweepOp extends FeatureOp<SweepFeature> {
  readonly id = 'sweep';
  private path: PathRef | null = null;

  constructor(app: AppContext, source: ExtrudeSource, existing?: SweepFeature) {
    super(app, { ...app.store.newIdentity('sweep'), type: 'sweep', source, path: { kind: 'sketch', sketch: '', entities: [] }, mode: 'auto', target: targetOf(app, source) }, existing);
    if (existing) {
      this.path = existing.path;
    }
    this.moreRegions = true;
    this.slots = [pathSlot(app, () => this.path, pathRef => ((this.path = pathRef), (this.feature.path = pathRef)))];
  }

  protected hint(): string {
    return 'The shape follows the path. Tap more lines to make the path longer.';
  }

  /** The path turns a corner somewhere: more than one piece, or a polyline. */
  private cornered(): boolean {
    const path = this.path;
    if (!path) {
      return false;
    }
    if (path.kind === 'edges') {
      return path.edges.length > 1;
    }
    if (path.entities.length > 1) {
      return true;
    }
    const sk = this.app.store.features.find(feature => feature.id === path.sketch) as { entities?: { id: string; kind: string }[] } | undefined;

    return sk?.entities?.find(e => e.id === path.entities[0])?.kind === 'polyline';
  }

  protected items(): PanelItem[] {
    // (Nothing to set before there is a path: how the shape goes along it comes once it has one.)
    const path = this.path;
    if (!path || (path.kind === 'sketch' ? !path.entities.length : !path.edges.length)) {
      return [];
    }

    return [
      { type: 'number', label: 'End size', value: this.feature.scale ?? 1, kind: 'number', min: 0.01, onInput: value => ((this.feature.scale = value > 0 ? value : 1), this.update()) },
      { type: 'number', label: 'Twist', value: this.feature.twist ?? 0, kind: 'angle', onInput: value => ((this.feature.twist = value || undefined), this.update()) },
      {
        type: 'choice',
        label: 'Profile position',
        options: [
          { id: 'auto', label: 'Where it is' },
          { id: 'start', label: "On the path's start" }
        ],
        value: this.feature.position ?? 'auto',
        onChange: value => ((this.feature.position = value === 'start' ? 'start' : undefined), this.update())
      },
      {
        type: 'choice',
        label: 'Orientation',
        options: [
          { id: 'normal', label: 'Normal to path' },
          { id: 'parallel', label: 'Parallel to profile' }
        ],
        value: this.feature.orientation ?? 'normal',
        onChange: value => ((this.feature.orientation = value === 'parallel' ? 'parallel' : undefined), this.update())
      },
      // (Round or mitred where the path turns a corner: only for a path of more than one piece.)
      ...(this.cornered()
        ? [{
          type: 'choice' as const,
          label: 'Corners',
          options: [
            { id: 'round', label: 'Round' },
            { id: 'mitre', label: 'Mitre' }
          ],
          value: this.feature.corner ?? 'round',
          onChange: (value: string) => ((this.feature.corner = value === 'mitre' ? 'mitre' : undefined), this.update())
        }]
        : []),
      ...(anyBody(this.app, this.feature.id) ? [modeChoice(() => this.feature.mode, bodyMode => ((this.feature.mode = bodyMode), this.update()), () => this.render(), false, () => autoAddsOrNew(this.feature.target))] : [])
    ];
  }
}

// -------------------------------------------------------------------- loft

export class LoftOp extends FeatureOp<LoftFeature> {
  readonly id = 'loft';

  /** Which optional slots are open: the centre-line guide, guide curves along the sides, connections. */
  private extra: { guide: boolean; rails: boolean; conns: boolean };
  /** A connection being picked: its points so far, one per profile. */
  private pending: Vec3[] = [];

  constructor(app: AppContext, sections: ExtrudeSource[], initial: Sel[], existing?: LoftFeature) {
    super(app, { ...app.store.newIdentity('loft'), type: 'loft', sections, ruled: false, mode: 'new' }, existing);
    this.extra = { guide: !!existing?.guide, rails: !!existing?.rails?.length, conns: !!existing?.connections?.length };
    this.slots = this.makeSlots(initial);
  }

  private makeSlots(initial: Sel[] = []): Slot[] {
    const first = this.slots[0] ?? sectionsSlot(this.app, () => this.feature.sections, sections => (this.feature.sections = sections), initial);

    return [first, ...(this.extra.guide ? [this.guideSlot()] : []), ...(this.extra.rails ? [this.railsSlot()] : []), ...(this.extra.conns ? [this.connSlot()] : [])];
  }

  /** Guide curves along the sides: each a curve tapped (with the curves joined to it end to end), or an edge. */
  private railsSlot(): Slot {
    const feature = this.feature;
    const app = this.app;
    const rails = () => feature.rails ?? [];
    const set = (rails: PathRef[]) => ((feature.rails = rails.length ? rails : undefined), (feature.ruled = false));

    return {
      label: 'Guide curves',
      multi: true,
      describe: () => (rails().length ? `${rails().length} guide${rails().length > 1 ? 's' : ''}` : 'Tap curves that run through every profile'),
      filled: () => true,
      pick: { profiles: false, curves: true, planes: false, axes: false },
      shows: () => rails().flatMap(rail => (rail.kind === 'sketch' ? rail.entities.map(entity => ({ kind: 'curve', sketch: rail.sketch, entity }) as Sel) : [])),
      get presets() {
        return rails().length ? [{ label: 'Clear', apply: () => set([]) }] : [];
      },
      accept: (hit) => {
        if (hit.kind === 'curve') {
          // Tapped again: that guide goes.
          const i = rails().findIndex(rail => rail.kind === 'sketch' && rail.sketch === hit.sketch && rail.entities.includes(hit.entity));
          if (i >= 0) {
            return set(rails().filter((_, railIndex) => railIndex !== i)), true;
          }
          const sk = app.store.find<SketchFeature>(hit.sketch);
          const chain = sk?.type === 'sketch' ? chainThrough(sk.entities, hit.entity) : [hit.entity];
          set([...rails(), { kind: 'sketch', sketch: hit.sketch, entities: chain.length ? chain : [hit.entity] }]);

          return true;
        }
        if (hit.kind === 'edge') {
          const ref = edgeRefOf(app, hit);
          if (!ref) {
            return false;
          }
          const same = (pathRef: PathRef) => pathRef.kind === 'edges' && JSON.stringify(pathRef.edges[0]) === JSON.stringify(ref);
          set(rails().some(same) ? rails().filter(rail => !same(rail)) : [...rails(), { kind: 'edges', edges: [ref] }]);

          return true;
        }

        return false;
      }
    };
  }

  /** Connections: a point on each profile in turn (the loft joins them). */
  private connSlot(): Slot {
    const feature = this.feature;
    const sectionCount = () => feature.sections.length;
    const base = pointSlot(this.app, 'Connections', () => null, (point) => {
      this.pending.push(point);
      if (this.pending.length >= sectionCount()) {
        feature.connections = [...(feature.connections ?? []), this.pending];
        this.pending = [];
        feature.ruled = false;
      }
    });
    const done = () => feature.connections?.length ?? 0;
    const pending = () => this.pending;
    const pendingClear = () => (this.pending = []);

    return {
      ...base,
      multi: true,
      describe: () =>
        this.pending.length
          ? `Now a point on profile ${this.pending.length + 1} of ${sectionCount()}`
          : done()
            ? `${done()} connection${done() > 1 ? 's' : ''} - tap a point on profile 1 for another`
            : 'Tap a point on profile 1 (a corner snaps), then one on each next profile',
      filled: () => true,
      get presets() {
        return done() || pending().length ? [{ label: 'Clear', apply: () => ((feature.connections = undefined), (pendingClear())) }] : [];
      }
    };
  }

  private continuityItems(): PanelItem[] {
    const feature = this.feature;
    const opts = [
      { id: 'free', label: 'Free' },
      { id: 'g1', label: 'Tangent (G1)' },
      { id: 'g2', label: 'Smooth (G2)' }
    ];
    const end = (which: 'start' | 'end'): PanelItem[] => {
      const key = which === 'start' ? 'startContinuity' : 'endContinuity';
      const wkey = which === 'start' ? 'startWeight' : 'endWeight';
      const on = feature[key];

      return [
        {
          type: 'choice',
          label: which === 'start' ? 'Start' : 'End',
          options: opts,
          value: on ?? 'free',
          onChange: value => ((feature[key] = value === 'free' ? undefined : (value as 'g1' | 'g2')), this.render(), this.update())
        },
        ...(on
          ? [{ type: 'slider' as const, label: 'Magnitude', value: feature[wkey] ?? 1, min: 0.1, max: 3, step: 0.05, show: (value: number) => value.toFixed(2), onInput: (value: number) => ((feature[wkey] = value === 1 ? undefined : value), this.update()) }]
          : [])
      ];
    };

    return [...end('start'), ...end('end')];
  }

  /** The optional guide: a curve the body follows from profile to profile. */
  private guideSlot() {
    return { ...pathSlot(this.app, () => this.feature.guide ?? null, pathRef => (this.feature.guide = pathRef)), label: 'Centre line' };
  }

  protected hint(): string {
    if (this.extra.conns) {
      return 'Connections: tap a point on each profile in turn - the loft joins them (a corner of a square to a point on a circle).';
    }
    if (this.extra.rails) {
      return 'Guide curves: each runs through every profile, and the sides follow it. Tap one again to take it off.';
    }
    if (this.feature.guide) {
      return 'The body follows the guide through each shape. Tap more curves to make the guide longer.';
    }

    return 'Tap the shapes in order: the body passes through each one.';
  }

  /** An optional slot switched on (and the others it can't go with off) or off. */
  private toggleExtra(key: 'guide' | 'rails' | 'conns'): void {
    const feature = this.feature;
    const on = !this.extra[key];
    this.extra[key] = on;
    if (on && key === 'guide') {
      (this.extra.rails = this.extra.conns = false), (feature.rails = feature.connections = undefined), (feature.closed = undefined);
    }
    if (on && key !== 'guide') {
      (this.extra.guide = false), (feature.guide = undefined), (feature.closed = undefined);
    }
    if (!on) {
      if (key === 'guide') {
        feature.guide = undefined;
      }
      if (key === 'rails') {
        feature.rails = undefined;
      }
      if (key === 'conns') {
        (feature.connections = undefined), (this.pending = []);
      }
    }
    this.slots = this.makeSlots();
    this.active = on ? this.slots.length - 1 : -1;
    this.render();
    this.update();
  }

  protected items(): PanelItem[] {
    const feature = this.feature;
    const guided = this.extra.guide;
    const held = this.extra.rails || this.extra.conns;

    return [
      ...(feature.closed || guided || held ? [] : [{ type: 'toggle' as const, label: 'Straight sides', value: feature.ruled, onChange: (ruled: boolean) => ((feature.ruled = ruled), this.render(), this.update()) }]),
      // (A closed loop needs three shapes at least: with two it would only come back the way it went.)
      ...(held || (feature.sections.length < 3 && !feature.closed) ? [] : [{ type: 'toggle' as const, label: 'Closed loop', value: !!feature.closed, onChange: (isOn: boolean) => ((feature.closed = isOn || undefined), this.render(), this.update()) }]),
      // How it leaves the first shape and meets the last (free, tangent, or smoother still).
      ...(feature.closed || guided || held || feature.ruled ? [] : this.continuityItems()),
      { type: 'button', label: guided ? 'Remove centre line' : 'Centre line', icon: guided ? 'close' : 'sweep', onClick: () => this.toggleExtra('guide') },
      { type: 'button', label: this.extra.rails ? 'Remove guide curves' : 'Guide curves', icon: this.extra.rails ? 'close' : 'sweep', onClick: () => this.toggleExtra('rails') },
      { type: 'button', label: this.extra.conns ? 'Remove connections' : 'Connections', icon: this.extra.conns ? 'close' : 'sweep', onClick: () => this.toggleExtra('conns') },
      ...(anyBody(this.app, this.feature.id) ? [modeChoice(() => this.feature.mode, bodyMode => ((this.feature.mode = bodyMode), this.update()), () => this.render(), false, () => autoAddsOrNew(this.feature.target))] : [])
    ];
  }
}

// ------------------------------------------------------------------- shell

export class ShellOp extends FeatureOp<ShellFeature> {
  readonly id = 'shell';

  /** The body's faces before it's hollowed (the screen shows the preview once a face is picked). */
  private original: FaceRef[];

  constructor(app: AppContext, body: string, faces: FaceRef[], existing?: ShellFeature) {
    super(app, { ...app.store.newIdentity('shell'), type: 'shell', body, faces, thickness: 1 }, existing);
    this.original = (app.view.body(body)?.faces ?? []).map(faceInfo => ({ body, center: faceInfo.center, normal: faceInfo.normal, area: faceInfo.area, ...(faceInfo.step ? { step: faceInfo.step } : {}), ...(faceInfo.curve ? { curve: faceInfo.curve } : {}) }));

    this.slots = [facesSlot(app, 'Open faces', () => this.feature.faces, faces => (this.feature.faces = faces.map(faceRef => this.onOriginal(faceRef))), true)];
    this.active = 0;
  }

  /**
   * A face tapped on the preview, as the face of the body it came from: with
   * one end already open, the next end is seen - and tapped - from inside, on
   * the hollowed preview's inner wall (a core cowl's front stayed shut: that
   * face isn't on the body being shelled). The flat face of the body parallel
   * to it, at most a wall away.
   */
  private onOriginal(faceRef: FaceRef): FaceRef {
    return faceRef.body === this.feature.body ? faceBeforeShell(this.original, faceRef, this.feature.thickness) : faceRef;
  }

  enter(): void {
    super.enter();
    // Faces to open that are gone (it said "pick the face again"): dropped, so the faces tapped now are used.
    const gone = this.existing ? goneRefs(this.app, this.feature.faces, this.feature.id) : [];
    if (gone.length) {
      this.feature.faces = this.feature.faces.filter(face => !gone.includes(face));
      this.app.ui.toast(`${gone.length} of the faces it opened ${gone.length > 1 ? 'are' : 'is'} gone - tap the faces to leave open now`);
    }
    this.active = 0;
    this.render();
  }


  protected hint(): string {
    return this.feature.faces.length ? 'Drag the arrow into the body, or type, to set how thick the walls are. Tap more faces to open them too.' : 'Tap the faces to leave open: an arrow comes up to set how thick the walls are.';
  }

  protected items(): PanelItem[] {
    return [this.num('Thickness', 'thickness', 'length', { min: 0.0001, onInput: value => this.setThickness(value), inBox: true })];
  }

  /** The wall thickness, typed on the open face tapped last - and dragged, by the arrow that points into the body there. */
  private dim: DimWidget | null = null;
  private dimFace = '';
  private handle: Handle | null = null;
  private dragging: { from: ToolPointer; t0: number; at: Vec3; into: Vec3 } | null = null;
  private typing = new DragTyping(this.app);

  hover(pointer: ToolPointer | null): void {
    const on = !!pointer && !!this.handle && (!!this.dragging || this.handle.hit(pointer));
    this.handle?.setHot(on);
    if (!on) {
      super.hover(pointer);
    }
  }

  down(pointer: ToolPointer): boolean {
    const lastFace = this.feature.faces[this.feature.faces.length - 1];
    if (!lastFace || !this.handle?.hit(pointer)) {
      return false;
    }
    this.dragging = { from: pointer, t0: this.feature.thickness, at: lastFace.center, into: scale(lastFace.normal, -1) };

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
    const raw = dr.t0 + axisDrag(this.app.view, add(dr.at, scale(dr.into, dr.t0)), dr.into, dr.from, pointer);
    const step = niceStep(this.app.view.cam.worldPerPixel(this.app.view.height) * 4);
    this.typedInto('thickness', '');
    // (A wall has some thickness: never less than a step.)
    this.setThickness(Math.max(step, Math.round(raw / step) * step));
    this.app.ui.setLabel(pointer.x, pointer.y, `Wall ${fmtLen(this.feature.thickness)}  · type a value`);
  }

  up(): void {
    this.dragging = null;
    this.typing.reset();
    this.app.ui.setLabel(0, 0, null);
    this.handle?.setHot(false);
  }

  dragKey(e: KeyboardEvent): boolean {
    const dr = this.dragging;
    if (!dr) {
      return false;
    }

    return this.typing.key(e, {
      kind: 'length',
      apply: value => this.setThickness(value),
      commit: () => ((this.dragging = null), this.done()),
      cancel: () => this.setThickness(dr.t0)
    });
  }

  private setThickness(thickness: number): void {
    if (!(thickness > 0)) {
      return;
    }
    this.feature.thickness = thickness;
    this.app.ui.updatePanelValues([thickness]);
    this.dim?.setValue(thickness);
    this.update();
  }

  protected onDraftChanged(): void {
    // The face tapped last: the one being looked at. (On the first, a duct's
    // top, it was hidden from below when its other end was tapped there -
    // turned away - and the thickness was out of reach.)
    const lastFace = this.feature.faces[this.feature.faces.length - 1];
    if (!lastFace) {
      this.dim?.dispose();
      this.dim = null;
      this.handle?.dispose();
      this.handle = null;

      return;
    }
    // (Another face: the box goes with it, and turns away with it.)
    const key = `${lastFace.body}:${lastFace.center.map(x => x.toFixed(6))}:${lastFace.normal.map(x => x.toFixed(6))}`;
    if (this.dim && this.dimFace !== key) {
      this.dim.dispose();
      this.dim = null;
    }
    this.dimFace = key;
    this.dim ??= new DimWidget(this.app.view, {
      noLine: true,
      facing: lastFace.normal,
      value: this.feature.thickness,
      onInput: (value, text) => {
        if (!(value > 0)) {
          return;
        }
        this.typedInto('thickness', text);
        this.setThickness(value);
      },
      onCommit: () => this.done()
    });
    // Just inside the face: the wall goes inwards from it.
    const a = add(lastFace.center, scale(lastFace.normal, -this.feature.thickness));
    this.dim.set(a, lastFace.center);
    this.dim.setValue(this.feature.thickness);
    // The arrow: at the wall's inner side, pointing further in (dragged in, the wall gets thicker).
    this.handle ??= new Handle(this.app.view, 'arrow');
    this.handle.set(a, scale(lastFace.normal, -1));
  }

  exit(): void {
    this.dim?.dispose();
    this.dim = null;
    this.handle?.dispose();
    this.handle = null;
    super.exit();
  }
}

// --------------------------------------------------------------- transforms

type TransformKind = 'move' | 'translate' | 'rotate' | 'scale' | 'mirror' | 'linear' | 'circular';
const TITLES: Record<TransformKind, string> = {
  move: 'Move/Rotate',
  translate: 'Translate',
  rotate: 'Rotate Around Axis',
  scale: 'Scale',
  mirror: 'Mirror',
  linear: 'Pattern – Linear',
  circular: 'Pattern – Circular'
};

/** Move/rotate, translate, rotate around axis, scale, mirror and patterns of bodies. */
export class TransformOp extends FeatureOp<TransformFeature> {
  readonly id = 'transform';
  private dir: Vec3 | null = null;
  private axis: AxisRef | null = null;
  private plane: PlaneDef | null = null;
  private distance = 10;
  private gimbal: Gimbal | null = null;
  private dragging: { from: ToolPointer; part: GimbalPart; t0: Vec3; a0: number; center: Vec3 } | null = null;
  /** Body centre before this move (rotation pivot; the gimbal sits at centre + translate). */
  private center: Vec3;

  constructor(
    app: AppContext,
    private kind: TransformKind,
    bodies: string[],
    existing?: TransformFeature,
    /** Gimbal/rotation pivot (e.g. a selected vertex); default the bodies' centre. */
    pivot?: Vec3,
    /** Move makes a copy (the gimbal's Copy switch). */
    copy = false,
    /** A pattern started from a hole's round wall: the hole is repeated in its body, not the body. */
    hole?: FaceRef,
    /** That hole's radius: the first spacing is three of them (the body's own length would put the next hole off it). */
    holeR?: number
  ) {
    const center = pivot ?? bodyCenter(app, bodies);
    const op: TransformFeature['op']
      = kind === 'scale'
        ? { kind: 'scale', center, factor: 1 }
        : kind === 'mirror'
          ? { kind: 'mirror', plane: { origin: [0, 0, 0], xDir: [0, 1, 0], normal: [1, 0, 0] } }
          : kind === 'linear'
            ? { kind: 'linear', dir: [1, 0, 0], spacing: hole && holeR ? Math.max(1, Math.round(holeR * 3 * 100) / 100) : patternSpacing(bodyExtent(app, bodies, [1, 0, 0]), 20), count: 3 }
            : kind === 'circular'
              ? { kind: 'circular', axis: { origin: [0, 0, 0], dir: [0, 0, 1] }, count: 6, angle: 360 }
              : { kind: 'move', translate: [0, 0, 0], rotate: { origin: center, axis: [0, 0, 1], angle: 0 } };
    const label = kind === 'linear' || kind === 'circular' ? 'Pattern' : TITLES[kind].split(' ')[0].replace('/Rotate', '');
    super(app, { ...app.store.newIdentity('transform', copy ? 'Copy' : hole ? 'Hole Pattern' : label), type: 'transform', bodies, copy: kind === 'mirror' || copy, op, ...(hole && (kind === 'linear' || kind === 'circular') ? { hole } : {}) }, existing);
    const transformOp = this.feature.op;
    if (existing) {
      if (transformOp.kind === 'mirror') {
        this.plane = transformOp.plane;
      }
      if (transformOp.kind === 'linear') {
        this.dir = transformOp.dir;
      }
      if (transformOp.kind === 'circular') {
        this.axis = transformOp.axis;
      }
      if (transformOp.kind === 'move' && transformOp.rotate) {
        this.axis = { origin: transformOp.rotate.origin, dir: transformOp.rotate.axis };
      }
    }
    if (kind === 'mirror') {
      this.slots = [planeSlot(app, 'Mirror plane', () => this.plane, plane => ((this.plane = plane), ((this.feature.op as { plane: PlaneDef }).plane = plane)))];
    }
    if (kind === 'linear') {
      this.slots = [directionSlot(app, 'Direction', () => this.dir, direction => ((this.dir = norm(direction)), this.applyDir()))];
    }
    // Translate: from a point on it to where that point should go (size unchanged).
    if (kind === 'translate') {
      this.slots = [
        pointSlot(app, 'From point', () => this.from, from => ((this.from = from), this.applyPoints())),
        pointSlot(app, 'To point', () => this.to, to => ((this.to = to), this.applyPoints()))
      ];
    }
    if (kind === 'circular' || kind === 'rotate') {
      this.slots = [axisSlot(app, 'Axis', () => this.axis, a => ((this.axis = a), this.applyAxis()))];
    }
    this.center = transformOp.kind === 'move' && transformOp.rotate ? transformOp.rotate.origin : center;
    if (copy && !existing && linkMode.on) {
      this.feature.link = true;
    }
    // (A new pattern: linked if Link was left on the last time.)
    if ((kind === 'linear' || kind === 'circular') && !existing && linkMode.on) {
      this.feature.link = true;
    }
    if (kind === 'move') {
      this.gimbal = new Gimbal(app.view);
      const gimbal = this.gimbal;
      this.copyToggle = new CopyToggle(app.view, () => gimbal.origin, on => ((this.feature.copy = on), (this.feature.link = on && linkMode.on ? true : undefined), this.render(), this.update()));
    }
  }

  /** A body tapped in Items: added to what's moved / patterned, or (there already) taken out - never the last (that tap does nothing). */
  toggleBody(id: string): boolean {
    const bs = this.feature.bodies;
    const i = bs.indexOf(id);
    if (i >= 0 && bs.length === 1) {
      return true;
    }
    this.feature.bodies = i >= 0 ? bs.filter(b => b !== id) : [...bs, id];
    this.app.setSelection(this.feature.bodies.map(body => ({ kind: 'body' as const, body })));
    this.app.ui.toast(`${this.feature.bodies.length} bodies`);
    this.render();
    this.update();

    return true;
  }

  /**
   * A body tapped in the view that the plane or direction can't use (the next
   * pip of a row, to mirror with the first): it joins what's moved, as a tap
   * on it in Items does. (The only way was Items; in the view it said "tap a
   * flat face".)
   */
  protected otherBody(body: string): boolean {
    if (this.kind === 'move' || this.kind === 'translate' || !this.app.view.body(body)) {
      return false;
    }

    return this.toggleBody(body);
  }

  private copyToggle: CopyToggle | null = null;
  private from: Vec3 | null = null;
  private to: Vec3 | null = null;

  private applyPoints(): void {
    const op = this.feature.op;
    if (op.kind === 'move' && this.from && this.to) {
      op.translate = sub(this.to, this.from);
      op.rotate = undefined;
    }
  }

  /** A finished copy is selected, gimbal and all, so the next drag copies it again. */
  protected done(): void {
    const feature = this.feature;
    const copied = feature.copy && this.ready() && !this.existing && (this.kind === 'move' || this.kind === 'rotate' || this.kind === 'translate' || this.kind === 'mirror' || this.kind === 'scale');
    if (!copied) {
      return super.done();
    }
    if (feature.link) {
      feature.link = true;
    } else {
      delete feature.link;
    }
    // Unlinked copies of freeforms: freeforms of their own (editing one leaves the other alone).
    let doc = { ...this.app.store.doc, features: [...this.app.store.features, feature] };
    const ids = new Map<string, string>();
    if (!feature.link) {
      const tracked = freeformBodies(doc.features);
      for (const b of feature.bodies) {
        const body = `${feature.id}:${b}:0`;
        if (!tracked.has(body)) {
          continue;
        }
        const out = detachFreeformCopy(doc, body, this.app.store.newIdentity('freeform').id + ids.size);
        if (out) {
          ((doc = out.doc), ids.set(body, out.id));
        }
      }
    }
    this.app.store.commit((draft) => {
      draft.features = doc.features;
      draft.names = doc.names;
      draft.hidden = doc.hidden;
      if (doc.colors) {
        draft.colors = doc.colors;
      }
      if (doc.materials) {
        draft.materials = doc.materials;
      }
    });
    this.app.setTool(null);
    this.app.setSelection(feature.bodies.map(b => ({ kind: 'body' as const, body: ids.get(`${feature.id}:${b}:0`) ?? `${feature.id}:${b}:0` })));
  }

  protected hint(): string {
    switch (this.kind) {
      case 'move':
        return 'Drag an arrow to slide it, an arc to turn it, or type exact values. Drag the dot in the middle to move the point it turns about - it snaps to corners and edges. Tap empty space when done.';
      case 'mirror':
        return 'The body is flipped across the plane. A copy is made unless you turn Copy off.';
      case 'translate':
        return 'Tap a point on the body, then the point it should move to.';
      default:
        return ({ rotate: 'Set the angle to turn the body around the axis.', linear: this.dir ? 'Drag the arrow, or type, to set how far apart the copies are; Count is how many.' : 'Tap an edge, an axis or a face: the copies go along it (point at one to see how, in dashed yellow).', circular: this.axis ? 'Drag the dot round the axis, or type, to set the angle the copies are spread over; Count is how many.' : 'Tap an axis, or a round edge or face: the copies go round it (point at an axis to see how).' } as Record<string, string>)[this.kind] ?? `${TITLES[this.kind]}: set the values, then tap empty space.`;
    }
  }

  private applyDir(): void {
    const op = this.feature.op;
    if (op.kind === 'linear' && this.dir) {
      // A new pattern's spacing (not typed yet) follows the direction: the copies just clear of the bodies.
      const was = patternSpacing(bodyExtent(this.app, this.feature.bodies, op.dir), 20);
      if (!this.existing && Math.abs(op.spacing - was) < 1e-9) {
        op.spacing = patternSpacing(bodyExtent(this.app, this.feature.bodies, this.dir), 20);
      }
      op.dir = this.dir;
    }
    if (this.kind === 'translate' && op.kind === 'move' && this.dir) {
      op.translate = scale(this.dir, this.distance);
    }
  }

  private applyAxis(): void {
    const op = this.feature.op;
    if (op.kind === 'circular' && this.axis) {
      op.axis = this.axis;
    }
    if (op.kind === 'move' && this.axis) {
      op.rotate = { origin: this.axis.origin, axis: this.axis.dir, angle: op.rotate?.angle ?? 90 };
    }
  }

  protected items(): PanelItem[] {
    const op = this.feature.op;
    const up = () => this.update();
    const copyToggle: PanelItem = { type: 'toggle', label: 'Copy', value: this.feature.copy, onChange: copy => ((this.feature.copy = copy), this.render(), up()) };
    // With Copy on: Link keeps the copy connected to its original (a freeform
    // copy then changes when either is shaped); off, it is a body of its own.
    const link: PanelItem = {
      type: 'toggle',
      label: 'Link',
      value: !!this.feature.link,
      onChange: (isOn) => {
        linkMode.on = isOn;
        this.feature.link = isOn;
        this.render();
      }
    };
    const copy: PanelItem[] = this.feature.copy && !this.existing ? [copyToggle, link] : [copyToggle];
    // A pattern's Link: its copies and what they were made from change together afterwards - a hole cut in one is
    // cut in all (asked for: "we should also have this in patterns"). Off, each is a body of its own.
    const patternLink: PanelItem = {
      type: 'toggle',
      label: 'Link',
      value: !!this.feature.link,
      onChange: (isOn) => {
        linkMode.on = isOn;
        if (isOn) {
          this.feature.link = true;
        } else {
          delete this.feature.link;
        }
        this.render();
        up();
      }
    };
    // ΔX ΔY ΔZ: when changing a step opened from History, and on touch screens
    // (with a mouse, moving is dragging or typing while dragging - the numbers
    // are clutter there; a finger has no keyboard mid-drag, so exact moves need them).
    const deltas = (): PanelItem[] => (this.existing || isTouchDevice ? (['X', 'Y', 'Z'] as const).map((axisLabel, i): PanelItem => this.num(`Δ${axisLabel}`, `op.translate.${i}`, 'length')) : []);
    switch (op.kind) {
      case 'scaleXYZ':
        return [];
      case 'move':
        if (this.kind === 'translate') {
          return [...deltas(), ...copy];
        }
        {
          // The angle and the point it turns about can use variables (a joint
          // that turns by "a2" about "p2" high, and moves up when an arm gets
          // longer) - set when it's made, and when it's opened again from History.
          const pivot = (): PanelItem[] => (['X', 'Y', 'Z'] as const).map((axisLabel, i): PanelItem => this.num(`Pivot ${axisLabel}`, `op.rotate.origin.${i}`, 'length'));
          if (this.kind === 'rotate') {
            op.rotate ??= { origin: this.center, axis: [0, 0, 1], angle: 0 };

            return [this.num('Angle', 'op.rotate.angle', 'angle'), ...(this.axis ? pivot() : []), ...copy];
          }

          return [
            ...deltas(),
            op.rotate
              ? this.num(`Rotate ${axisName(op.rotate.axis)}`, 'op.rotate.angle', 'angle')
              : { type: 'number', label: 'Rotate Z', value: 0, kind: 'angle', onExpr: e => this.setExpr('op.rotate.angle', e), onInput: angle => ((op.rotate = { origin: this.center, axis: [0, 0, 1], angle: angle }), up()) },
            ...(this.existing && op.rotate?.angle ? pivot() : []),
            ...copy
          ];
        }
      case 'scale':
        return [this.num('Factor', 'op.factor', 'number', { min: 0.0001 }), ...copy];
      case 'mirror':
        return [...copy];
      case 'linear':
        return [
          this.num('Count', 'op.count', 'int', { min: 2 }),
          this.num('Spacing', 'op.spacing', 'length'),
          patternLink
        ];
      case 'circular':
        return [
          this.num('Count', 'op.count', 'int', { min: 2 }),
          this.num('Angle', 'op.angle', 'angle'),
          patternLink
        ];
    }
  }

  protected ready(): boolean {
    const op = this.feature.op;
    // An untouched move is not worth a history step.
    if (this.kind === 'move' && op.kind === 'move' && len(op.translate) < 1e-9 && !op.rotate?.angle && !this.feature.copy) {
      return false;
    }

    return super.ready() && this.feature.bodies.length > 0;
  }

  exit(): void {
    this.gimbal?.dispose();
    this.copyToggle?.dispose();
    this.dropPatternGrip();
    this.patGhost?.dispose();
    this.patGhost = null;
    super.exit();
  }

  // A pattern's size is dragged where the copies are: an arrow on the first copy of a row (how far apart), a dot on
  // the last copy of a ring (the angle they are spread over) - each with its value in a box beside it.
  private patHandle: Handle | null = null;
  private patDim: DimWidget | null = null;
  private patDrag: { from: ToolPointer; v0: number } | null = null;

  private dropPatternGrip(): void {
    this.patHandle?.dispose();
    this.patHandle = null;
    this.patDim?.dispose();
    this.patDim = null;
  }

  /** The ring's frame: the foot of the bodies' centre on the axis, out to the centre, and round. */
  private ring(): { foot: Vec3; d: Vec3; u: Vec3; v: Vec3; r: number } | null {
    if (!this.axis) {
      return null;
    }
    const direction = norm(this.axis.dir);
    const foot = add(this.axis.origin, scale(direction, dot(sub(this.center, this.axis.origin), direction)));
    const out = sub(this.center, foot);
    const radius = len(out);
    if (radius < 1e-6) {
      return null;
    }
    const radial = scale(out, 1 / radius);

    return { foot, d: direction, u: radial, v: cross(direction, radial), r: radius };
  }

  private setSpacing(spacing: number): void {
    const op = this.feature.op;
    if (op.kind !== 'linear' || !(Math.abs(spacing) > 1e-9)) {
      return;
    }
    op.spacing = spacing;
    this.app.ui.updatePanelValues([op.count, spacing]);
    this.patDim?.setValue(spacing);
    this.update();
  }

  private setSpread(angle: number): void {
    const op = this.feature.op;
    if (op.kind !== 'circular' || !(Math.abs(angle) > 1e-9)) {
      return;
    }
    op.angle = angle;
    this.app.ui.updatePanelValues([op.count, angle]);
    this.patDim?.setValue(angle);
    this.update();
  }

  protected onDraftChanged(): void {
    const op = this.feature.op;
    if (this.gimbal && op.kind === 'move') {
      this.gimbal.setCenter(add(this.center, op.translate));
    }
    if (op.kind === 'linear' && this.dir) {
      const dir = this.dir;
      if (!this.patHandle) {
        this.patHandle = new Handle(this.app.view, 'arrow');
        this.patDim = new DimWidget(this.app.view, { boxAt: 'beyond', boxGap: 96, dir: dir, value: op.spacing, onInput: (value, text) => (this.typedInto('op.spacing', text), this.setSpacing(value)), onCommit: () => this.done() });
      }
      const first = add(this.center, scale(dir, op.spacing));
      this.patHandle.set(first, op.spacing < 0 ? scale(dir, -1) : dir);
      this.patDim!.set(this.center, first);
      this.patDim!.setValue(op.spacing);
    } else if (op.kind === 'circular' && this.ring()) {
      const ring = this.ring()!;
      // (Where the last copy is: a full turn shares the ring out evenly, a part of one ends on its angle.)
      const full = Math.abs(Math.abs(op.angle) - 360) < 1e-6;
      const last = ((full ? (op.angle * (op.count - 1)) / op.count : op.angle) * Math.PI) / 180;
      const at = add(ring.foot, add(scale(ring.u, ring.r * Math.cos(last)), scale(ring.v, ring.r * Math.sin(last))));
      if (!this.patHandle) {
        this.patHandle = new Handle(this.app.view, 'dot');
        this.patDim = new DimWidget(this.app.view, { boxAt: 'beyond', boxGap: 40, angle: true, noLine: true, value: op.angle, onInput: (value, text) => (this.typedInto('op.angle', text), this.setSpread(value)), onCommit: () => this.done() });
      }
      this.patHandle.set(at);
      this.patDim!.set(ring.foot, at);
      this.patDim!.setValue(op.angle);
    } else {
      this.dropPatternGrip();
    }
  }

  /** How the pattern would go along what is under the pointer, before its direction (or axis) is picked. */
  private patGhost: Ghost | null = null;
  private patGhostSig = '';
  private lookAhead(pointer: ToolPointer | null): void {
    const op = this.feature.op;
    const view = this.app.view;
    let segs: number[] = [];
    let sig = '';
    if (pointer && op.kind === 'linear' && !this.dir) {
      const hit = view.pick(pointer.x, pointer.y, { edgeTolPx: pointer.tol, profiles: false, planes: false, axes: true, worldAxes: true });
      const dir = hit?.kind === 'axis' ? view.axisOf(hit.id)?.plane.normal : hit?.kind === 'edge' ? view.body(hit.body)?.edges[hit.edge]?.dir : hit?.kind === 'face' ? view.body(hit.body)?.faces[hit.face]?.normal : undefined;
      if (dir) {
        sig = `l|${dir.map(x => x.toFixed(4))}|${op.count}`;
        if (sig !== this.patGhostSig) {
          segs = rowGhost(this.app, this.feature.bodies, dir, patternSpacing(bodyExtent(this.app, this.feature.bodies, norm(dir)), 20), op.count);
        }
      }
    } else if (pointer && op.kind === 'circular' && !this.axis) {
      const hit = view.pick(pointer.x, pointer.y, { edgeTolPx: pointer.tol, profiles: false, planes: false, axes: true, worldAxes: true });
      const ax = hit?.kind === 'axis' ? view.axisOf(hit.id)?.plane : undefined;
      if (ax) {
        sig = `c|${ax.origin.map(x => x.toFixed(4))}|${ax.normal.map(x => x.toFixed(4))}|${op.count}|${op.angle}`;
        if (sig !== this.patGhostSig) {
          segs = ringGhost(this.app, this.feature.bodies, { origin: ax.origin, dir: ax.normal }, op.angle, op.count);
        }
      }
    }
    if (sig === this.patGhostSig) {
      return;
    }
    this.patGhostSig = sig;
    this.patGhost?.dispose();
    this.patGhost = segs.length ? new Ghost(view, segs) : null;
  }

  hover(pointer: ToolPointer | null): void {
    this.lookAhead(pointer);
    if (this.patHandle) {
      const on = !!pointer && (!!this.patDrag || this.patHandle.hit(pointer));
      this.patHandle.setHot(on);
      if (on) {
        return;
      }
    }
    if (this.gimbal) {
      this.gimbal.setHot(pointer && !this.dragging ? this.gimbal.hit(pointer) : this.dragging?.part ?? null);
    } else {
      super.hover(pointer);
    }
  }

  /** Started by dragging the body itself: the press that opened this slides it over the floor (seen from the side: across the screen). */
  private grabbed = false;
  /** The gimbal's middle dot is being moved (the point it turns about), not the body. */
  private pivotDrag = false;
  grabAnywhere(): this {
    this.grabbed = true;

    return this;
  }

  down(pointer: ToolPointer): boolean {
    const op = this.feature.op;
    if (this.patHandle?.hit(pointer) && (op.kind === 'linear' || op.kind === 'circular')) {
      this.patDrag = { from: pointer, v0: op.kind === 'linear' ? op.spacing : op.angle };
      this.patHandle.setHot(true);

      return true;
    }
    const flat = Math.abs(this.app.view.cam.viewDir().z) > 0.25;
    const grabbed = this.grabbed;
    const part: GimbalPart | null | undefined = grabbed ? (flat ? { kind: 'plane', i: 2 } : { kind: 'center' }) : this.gimbal?.hit(pointer);
    this.grabbed = false;
    if (!part || op.kind !== 'move') {
      return false;
    }
    // The dot in the middle, grabbed: it is the point everything turns about, and it is moved - to a corner, onto
    // an edge or a face (it snaps there), or anywhere - like the centre the view turns about. The body stays.
    if (part.kind === 'center' && !grabbed) {
      this.pivotDrag = true;
      this.gimbal!.setHot(part);

      return true;
    }
    // A different rotation axis than the one already used: start from the current angle 0 on that axis.
    if (part.kind === 'ring' && op.rotate && op.rotate.angle && axisIndex(op.rotate.axis) !== part.i) {
      this.app.ui.toast('One rotation axis per move - press Done, then rotate around the next axis');

      return true;
    }
    this.dragging = { from: pointer, part, t0: [...op.translate] as Vec3, a0: op.rotate?.angle ?? 0, center: add(this.center, op.translate) };
    this.gimbal!.setHot(part);

    return true;
  }

  drag(pointer: ToolPointer): void {
    const op = this.feature.op;
    const pd = this.patDrag;
    if (pd && op.kind === 'linear' && this.dir) {
      this.typing.track(pointer);
      if (this.typing.active) {
        return;
      }
      const raw = pd.v0 + axisDrag(this.app.view, add(this.center, scale(this.dir, pd.v0)), this.dir, pd.from, pointer);
      const step = niceStep(this.app.view.cam.worldPerPixel(this.app.view.height) * 4);
      this.typedInto('op.spacing', '');
      this.setSpacing(Math.round(raw / step) * step || step);
      this.app.ui.setLabel(pointer.x, pointer.y, `${fmtLen(op.spacing)} apart  · type a value`);

      return;
    }
    if (pd && op.kind === 'circular') {
      this.typing.track(pointer);
      if (this.typing.active) {
        return;
      }
      const ring = this.ring();
      const at = ring && this.app.view.rayToPlane(pointer.x, pointer.y, { origin: ring.foot, normal: ring.d, xDir: ring.u });
      if (!ring || !at) {
        return;
      }
      const offset = sub(at, ring.foot);
      // Round the axis from where the bodies are, 0 to 360 (Shift: not snapped to 5 degrees); nearly all the way: a full turn.
      let a = (Math.atan2(dot(offset, ring.v), dot(offset, ring.u)) * 180) / Math.PI;
      if (a <= 0) {
        a += 360;
      }
      if (!pointer.shift) {
        a = Math.round(a / 5) * 5;
      }
      if (a > 357 || a < 1) {
        a = 360;
      }
      this.typedInto('op.angle', '');
      this.setSpread(a);
      this.app.ui.setLabel(pointer.x, pointer.y, `${Math.round(a * 10) / 10}°${a === 360 ? ' (all the way round)' : ''}  · type a value`);

      return;
    }
    if (this.pivotDrag && op.kind === 'move') {
      const view = this.app.view;
      const hit = view.pick(pointer.x, pointer.y, { profiles: false, planes: false, axes: false, edgeTolPx: Math.max(10, pointer.tol) });
      const now = add(this.center, op.translate);
      const viewDir = view.cam.viewDir().toArray() as Vec3;
      const at: Vec3 | null
        = hit?.kind === 'vertex' ? (view.vertexOf(hit.body, hit.vertex) ?? hit.point) : hit?.kind === 'edge' || hit?.kind === 'face' ? hit.point : view.rayToPlane(pointer.x, pointer.y, { origin: now, normal: viewDir, xDir: xDirFor(viewDir) });
      if (!at) {
        return;
      }
      this.app.setHover(hit?.kind === 'vertex' ? { kind: 'vertex', body: hit.body, vertex: hit.vertex } : hit?.kind === 'edge' ? { kind: 'edge', body: hit.body, edge: hit.edge } : null);
      // (Where the dot is shown is the centre moved with the body so far.)
      this.center = sub(at, op.translate);
      if (op.rotate) {
        op.rotate.origin = this.center;
      }
      this.gimbal?.setCenter(at);
      this.app.ui.setLabel(pointer.x, pointer.y, hit?.kind === 'vertex' ? 'Centre: on the corner' : hit?.kind === 'edge' ? 'Centre: on the edge' : hit?.kind === 'face' ? 'Centre: on the face' : 'Centre');
      if (op.rotate?.angle) {
        this.update();
      }

      return;
    }
    const dr = this.dragging;
    if (!dr || op.kind !== 'move') {
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
    if (part.kind === 'axis') {
      const dir = GIMBAL_AXES[part.i];
      const distance = snap(axisDrag(view, dr.center, dir, dr.from, pointer));
      op.translate = add(dr.t0, scale(dir, distance));
      this.boxAt(pointer, fmtLen(distance));
    } else if (part.kind === 'plane' || part.kind === 'center') {
      // Move in the plane of the square (or the screen plane for the centre).
      const normal: Vec3 = part.kind === 'plane' ? GIMBAL_AXES[part.i] : (view.cam.viewDir().toArray() as Vec3);
      const plane = { origin: dr.center, normal: normal, xDir: xDirFor(normal) };
      const a = view.rayToPlane(dr.from.x, dr.from.y, plane);
      const b = view.rayToPlane(pointer.x, pointer.y, plane);
      if (!a || !b) {
        return;
      }
      const delta = sub(b, a);
      op.translate = add(dr.t0, [snap(delta[0]), snap(delta[1]), snap(delta[2])]);
      this.boxAt(pointer, fmtLen(len(sub(op.translate, dr.t0))));
    } else {
      const axis = GIMBAL_AXES[part.i];
      const screenPoint = view.toScreen(dr.center);
      if (!screenPoint) {
        return;
      }
      const ang = (q: { x: number; y: number }) => Math.atan2(q.y - screenPoint[1], q.x - screenPoint[0]);
      // Screen y points down, so a visual counter-clockwise turn is a negative atan2 change.
      const facing = dot(axis, view.cam.viewDir().toArray() as Vec3) < 0 ? 1 : -1;
      let deg = (-(ang(pointer) - ang(dr.from)) * 180) / Math.PI * facing;
      deg = ((deg + 540) % 360) - 180;
      const total = pointer.shift ? dr.a0 + deg : Math.round((dr.a0 + deg) / 5) * 5;
      op.rotate = { origin: this.center, axis, angle: total };
      this.boxAt(pointer, `${Math.round(total * 10) / 10}°`);
    }
    this.app.ui.updatePanelValues([op.translate[0], op.translate[1], op.translate[2], op.rotate?.angle ?? 0]);
    this.update();
  }

  up(): void {
    if (this.patDrag) {
      this.patDrag = null;
      this.typing.reset();
      this.app.ui.setLabel(0, 0, null);
      this.patHandle?.setHot(false);

      return;
    }
    if (this.pivotDrag) {
      this.pivotDrag = false;
      this.app.setHover(null);
      this.app.ui.setLabel(0, 0, null);
      this.gimbal?.setHot(null);

      return;
    }
    const dragged = !!this.dragging;
    this.dragging = null;
    this.typing.reset();
    this.app.ui.setLabel(0, 0, null);
    this.gimbal?.setHot(null);
    // Letting go keeps the tool and its panel: change the values (Copy, Link…),
    // drag again, or tap empty space / Done to finish.
    void dragged;
    this.render();
  }

  private typing = new DragTyping(this.app);

  /** Typed while dragging: distance for arrows/squares/centre, angle for arcs. */
  /** What a typed value does to the part being dragged (typed during the drag, or in its value box after). */
  private dragTarget(): DragTypingTarget | null {
    const op = this.feature.op;
    const dr = this.dragging;
    if (!dr || op.kind !== 'move') {
      return null;
    }
    const part = dr.part;
    const refresh = () => {
      this.app.ui.updatePanelValues([op.translate[0], op.translate[1], op.translate[2], op.rotate?.angle ?? 0]);
      this.update();
    };
    // Squares/centre: along the direction dragged so far.
    const dragDir = norm(sub(op.translate, dr.t0));

    return {
      kind: part.kind === 'ring' ? 'angle' : 'length',
      apply: (value) => {
        if (part.kind === 'ring') {
          op.rotate = { origin: this.center, axis: GIMBAL_AXES[part.i], angle: dr.a0 + value };
        } else if (part.kind === 'axis') {
          op.translate = add(dr.t0, scale(GIMBAL_AXES[part.i], value));
        } else if (len(dragDir) > 0.5) {
          op.translate = add(dr.t0, scale(dragDir, value));
        }
        refresh();
      },
      commit: () => ((this.dragging = null), this.gimbal?.setHot(null), this.done()),
      cancel: () => ((op.translate = [...dr.t0] as Vec3), op.rotate && (op.rotate.angle = dr.a0), refresh())
    };
  }

  /** The drag's value in a box by the pointer (typeable, and it stays after letting go). */
  private boxAt(pointer: ToolPointer, text: string): void {
    const t = this.dragTarget();
    if (t) {
      this.typing.box(pointer, text, t);
    }
  }

  dragKey(e: KeyboardEvent): boolean {
    const pd = this.patDrag;
    const op = this.feature.op;
    if (pd && (op.kind === 'linear' || op.kind === 'circular')) {
      const set = (value: number) => (op.kind === 'linear' ? this.setSpacing(value) : this.setSpread(value));

      return this.typing.key(e, { kind: op.kind === 'linear' ? 'length' : 'angle', apply: set, commit: () => ((this.patDrag = null), this.done()), cancel: () => set(pd.v0) });
    }
    const t = this.dragTarget();

    return !!t && this.typing.key(e, t);
  }
}

// --------------------------------------------------------- move face/edge

/**
 * Move/rotate just one flat face or one straight edge: the gimbal sits on it,
 * the rest of the body stretches to follow. Only the parts that change the
 * geometry are shown (a face can't slide within its own plane).
 */
export class MoveFaceOp extends FeatureOp<MoveFaceFeature> {
  readonly id = 'moveFace';
  private gimbal: Gimbal;
  private axes: Vec3[];
  private center: Vec3;
  private dragging: { from: ToolPointer; part: GimbalPart; t0: Vec3; a0: number; center: Vec3 } | null = null;

  constructor(app: AppContext, target: { face: FaceRef; plane: PlaneDef } | { edge: EdgeRef } | { vertex: { body: string; at: Vec3 } }, existing?: MoveFaceFeature) {
    const isFace = 'face' in target;
    const isVertex = 'vertex' in target;
    const center = isFace ? target.face.center : isVertex ? target.vertex.at : target.edge.mid;
    super(
      app,
      {
        ...app.store.newIdentity('moveFace', isFace ? 'Move Face' : isVertex ? 'Move Vertex' : 'Move Edge'),
        type: 'moveFace',
        ...(isFace ? { face: target.face } : isVertex ? { vertex: target.vertex } : { edge: target.edge }),
        translate: [0, 0, 0]
      },
      existing
    );
    if (isVertex) {
      // A point just moves (turning it about itself would do nothing).
      this.axes = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
      this.gimbal = new Gimbal(app.view, { parts: gimbalPart => gimbalPart.kind !== 'ring' });
      this.center = center;

      return;
    }
    if (isFace) {
      const normal = norm(target.plane.normal);
      const x = norm(target.plane.xDir);
      this.axes = [x, cross(normal, x), normal];
    } else {
      this.axes = MoveFaceOp.edgeAxes(target.edge.dir);
    }
    // Face: push it, slide it in its plane, tilt it, turn it about its normal
    // (a body of flat faces: the faces round it follow). Edge: move across it, tilt it.
    const parts = isFace ? () => true : MoveFaceOp.edgeParts;
    this.gimbal = new Gimbal(app.view, { axes: this.axes, parts });
    this.center = this.feature.rotate?.origin ?? center;
  }

  /** An edge's gimbal: across it, and tilting it (along itself changes nothing). */
  static edgeParts = (gimbalPart: GimbalPart): boolean => (gimbalPart.kind === 'axis' && gimbalPart.i > 0) || (gimbalPart.kind === 'plane' && gimbalPart.i === 0) || (gimbalPart.kind === 'ring' && gimbalPart.i > 0);

  /** The axes of an edge's gimbal: along it, then two across. */
  static edgeAxes(dir: Vec3): Vec3[] {
    const direction = norm(dir);
    const xDir = xDirFor(direction);

    return [direction, xDir, cross(direction, xDir)];
  }

  protected hint(): string {
    return 'Drag an arrow to move the face, or an arc to tilt it. You can type a value while dragging.';
  }

  protected items(): PanelItem[] {
    const feature = this.feature;
    // ΔX ΔY ΔZ only when changing a step opened from History.
    const xyz = this.existing ? (['X', 'Y', 'Z'] as const).map((axisLabel, i): PanelItem => this.num(`Δ${axisLabel}`, `translate.${i}`, 'length')) : [];
    if (feature.vertex) {
      return xyz;
    }

    return [
      ...xyz,
      feature.rotate ? this.num('Tilt', 'rotate.angle', 'angle') : { type: 'number', label: 'Tilt', value: 0, kind: 'angle', onExpr: e => this.setExpr('rotate.angle', e), onInput: angle => ((feature.rotate = { origin: this.center, axis: this.axes[0], angle: angle }), this.update()) }
    ];
  }

  protected ready(): boolean {
    return len(this.feature.translate) > 1e-9 || Math.abs(this.feature.rotate?.angle ?? 0) > 1e-9;
  }

  exit(): void {
    this.gimbal.dispose();
    super.exit();
  }

  protected onDraftChanged(): void {
    this.gimbal.setCenter(add(this.center, this.feature.translate));
  }

  hover(pointer: ToolPointer | null): void {
    this.gimbal.setHot(pointer && !this.dragging ? this.gimbal.hit(pointer) : (this.dragging?.part ?? null));
  }

  down(pointer: ToolPointer): boolean {
    const part = this.gimbal.hit(pointer);
    if (!part) {
      return false;
    }
    const rotate = this.feature.rotate;
    if (part.kind === 'ring' && rotate && rotate.angle && dot(rotate.axis, this.axes[part.i]) < 0.999) {
      this.app.ui.toast('One tilt axis per move - press Done, then tilt around the next axis');

      return true;
    }
    this.dragging = { from: pointer, part, t0: [...this.feature.translate] as Vec3, a0: rotate?.angle ?? 0, center: add(this.center, this.feature.translate) };
    this.gimbal.setHot(part);

    return true;
  }

  drag(pointer: ToolPointer): void {
    const feature = this.feature;
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
    if (part.kind === 'axis') {
      const dir = this.axes[part.i];
      const distance = snap(axisDrag(view, dr.center, dir, dr.from, pointer));
      feature.translate = add(dr.t0, scale(dir, distance));
      this.boxAt(pointer, `${fmtLen(distance)}`);
    } else if (part.kind === 'center') {
      // Free move in the screen plane.
      const viewDir = view.cam.viewDir().toArray() as Vec3;
      const plane = { origin: dr.center, normal: viewDir, xDir: xDirFor(viewDir) };
      const a = view.rayToPlane(dr.from.x, dr.from.y, plane);
      const b = view.rayToPlane(pointer.x, pointer.y, plane);
      if (!a || !b) {
        return;
      }
      const delta = sub(b, a);
      feature.translate = add(dr.t0, [snap(delta[0]), snap(delta[1]), snap(delta[2])]);
      this.boxAt(pointer, `${fmtLen(len(sub(feature.translate, dr.t0)))}`);    
    } else if (part.kind === 'plane') {
      const axis = this.axes[part.i];
      const plane = { origin: dr.center, normal: axis, xDir: xDirFor(axis) };
      const a = view.rayToPlane(dr.from.x, dr.from.y, plane);
      const b = view.rayToPlane(pointer.x, pointer.y, plane);
      if (!a || !b) {
        return;
      }
      const delta = sub(b, a);
      feature.translate = add(dr.t0, [snap(delta[0]), snap(delta[1]), snap(delta[2])]);
      this.boxAt(pointer, `${fmtLen(len(sub(feature.translate, dr.t0)))}`);
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
      const total = pointer.shift ? dr.a0 + deg : Math.round(dr.a0 + deg);
      feature.rotate = { origin: this.center, axis, angle: total };
      this.boxAt(pointer, `${Math.round(total * 10) / 10}°`);
    }
    this.app.ui.updatePanelValues([feature.translate[0], feature.translate[1], feature.translate[2], feature.rotate?.angle ?? 0]);
    this.update();
  }

  up(): void {
    this.dragging = null;
    this.typing.reset();
    this.app.ui.setLabel(0, 0, null);
    this.gimbal.setHot(null);
    this.render();
  }

  private typing = new DragTyping(this.app);

  /** What a typed value does to the part being dragged (typed during the drag, or in its value box after). */
  private dragTarget(): DragTypingTarget | null {
    const feature = this.feature;
    const dr = this.dragging;
    if (!dr) {
      return null;
    }
    const part = dr.part;
    const refresh = () => {
      this.app.ui.updatePanelValues([feature.translate[0], feature.translate[1], feature.translate[2], feature.rotate?.angle ?? 0]);
      this.update();
    };
    const dragDir = norm(sub(feature.translate, dr.t0));

    return {
      kind: part.kind === 'ring' ? 'angle' : 'length',
      apply: (value) => {
        if (part.kind === 'ring') {
          feature.rotate = { origin: this.center, axis: this.axes[part.i], angle: dr.a0 + value };
        } else if (part.kind === 'axis') {
          feature.translate = add(dr.t0, scale(this.axes[part.i], value));
        } else if (len(dragDir) > 0.5) {
          feature.translate = add(dr.t0, scale(dragDir, value));
        }
        refresh();
      },
      commit: () => ((this.dragging = null), this.gimbal.setHot(null), this.done()),
      cancel: () => ((feature.translate = [...dr.t0] as Vec3), feature.rotate && (feature.rotate.angle = dr.a0), refresh())
    };
  }

  /** The drag's value in a box by the pointer (typeable, and it stays after letting go). */
  private boxAt(pointer: ToolPointer, text: string): void {
    const t = this.dragTarget();
    if (t) {
      this.typing.box(pointer, text, t);
    }
  }

  dragKey(e: KeyboardEvent): boolean {
    const t = this.dragTarget();

    return !!t && this.typing.key(e, t);
  }
}

// ------------------------------------------------------------------ scale

/**
 * Scale bodies with the cube-ended scale gimbal: drag the centre (or type) for
 * a uniform factor; in XYZ mode drag one axis to stretch along it.
 * The factor follows the drag: the handle's distance from the centre, relative
 * to where it started.
 */
export class ScaleOp extends FeatureOp<TransformFeature> {
  readonly id = 'scale';
  private gimbal: Gimbal;
  private dragging: { part: GimbalPart; from: ToolPointer; k0: Vec3; r0: number } | null = null;
  private typing = new DragTyping(this.app);

  constructor(
    app: AppContext,
    private xyz: boolean,
    bodies: string[],
    existing?: TransformFeature
  ) {
    const center = bodyCenter(app, bodies);
    const op: TransformFeature['op'] = xyz ? { kind: 'scaleXYZ', center, factors: [1, 1, 1] } : { kind: 'scale', center, factor: 1 };
    super(app, { ...app.store.newIdentity('transform', xyz ? 'Scale XYZ' : 'Scale'), type: 'transform', bodies, copy: false, op }, existing);
    this.xyz = this.feature.op.kind === 'scaleXYZ';
    this.gimbal = new Gimbal(app.view, { cubes: true, parts: this.xyz ? SCALE_PARTS : gimbalPart => gimbalPart.kind === 'center' || gimbalPart.kind === 'axis' });
    this.gimbal.setCenter((this.feature.op as { center: Vec3 }).center);
  }

  private get factors(): Vec3 {
    const op = this.feature.op;

    return op.kind === 'scaleXYZ' ? op.factors : op.kind === 'scale' ? [op.factor, op.factor, op.factor] : [1, 1, 1];
  }

  private setFactors(factors: Vec3): void {
    const op = this.feature.op;
    if (op.kind === 'scaleXYZ') {
      op.factors = factors;
    } else if (op.kind === 'scale') {
      op.factor = factors[0];
    }
    this.app.ui.updatePanelValues(this.xyz ? factors : [factors[0]]);
    this.update();
  }

  protected hint(): string {
    return this.xyz
      ? 'Drag one handle to stretch the body that way, or the centre to resize it evenly. Type a number while dragging (2 = twice).'
      : 'Drag a handle to resize. Type a number while dragging (2 = twice as big).';
  }

  protected items(): PanelItem[] {
    if (this.xyz) {
      return (['X', 'Y', 'Z'] as const).map((axisLabel, i): PanelItem => this.num(`Scale ${axisLabel}`, `op.factors.${i}`, 'number', { min: 0.0001 }));
    }

    return [this.num('Factor', 'op.factor', 'number', { min: 0.0001 }), { type: 'toggle', label: 'Copy', value: this.feature.copy, onChange: copy => ((this.feature.copy = copy), this.render(), this.update()) }];
  }

  protected ready(): boolean {
    return this.factors.some(factor => Math.abs(factor - 1) > 1e-9) || this.feature.copy;
  }

  exit(): void {
    this.gimbal.dispose();
    super.exit();
  }

  hover(pointer: ToolPointer | null): void {
    this.gimbal.setHot(pointer && !this.dragging ? this.gimbal.hit(pointer) : (this.dragging?.part ?? null));
  }

  down(pointer: ToolPointer): boolean {
    const part = this.gimbal.hit(pointer);
    if (!part) {
      return false;
    }
    const screenPoint = this.app.view.toScreen(this.gimbal.origin);
    // Distance of the press from the centre on screen = "factor 1" for this drag.
    const r0 = screenPoint ? Math.max(24, Math.hypot(pointer.x - screenPoint[0], pointer.y - screenPoint[1])) : 60;
    this.dragging = { part, from: pointer, k0: [...this.factors] as Vec3, r0 };
    this.gimbal.setHot(part);

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
    const screenPoint = view.toScreen(this.gimbal.origin);
    if (!screenPoint) {
      return;
    }
    let factor: number;
    if (dr.part.kind === 'axis') {
      // Along the axis on screen: how far the handle has been pulled out or pushed in.
      const pxPerUnit = view.cam.worldPerPixel(view.height);
      const along = axisDrag(view, this.gimbal.origin, GIMBAL_AXES[dr.part.i], dr.from, pointer) / pxPerUnit;
      factor = (dr.r0 + along) / dr.r0;
    } else {
      factor = Math.hypot(pointer.x - screenPoint[0], pointer.y - screenPoint[1]) / dr.r0;
    }
    factor = Math.max(0.01, pointer.shift ? factor : Math.round(factor * 100) / 100);
    const factors = [...dr.k0] as Vec3;
    if (dr.part.kind === 'axis' && this.xyz) {
      factors[dr.part.i] = dr.k0[dr.part.i] * factor;
    } else {
      for (let i = 0; i < 3; i++) {
        factors[i] = dr.k0[i] * factor;
      }
    }
    this.setFactors(factors);
    this.boxAt(pointer, `×${(dr.part.kind === 'axis' && this.xyz ? factors[dr.part.i] : factors[0]).toFixed(2)}`);
  }

  up(): void {
    this.dragging = null;
    this.typing.reset();
    this.app.ui.setLabel(0, 0, null);
    this.gimbal.setHot(null);
  }

  /** What a typed value does to the part being dragged (typed during the drag, or in its value box after). */
  private dragTarget(): DragTypingTarget | null {
    const dr = this.dragging;
    if (!dr) {
      return null;
    }

    return {
      kind: 'number',
      apply: (value) => {
        if (value <= 0) {
          return;
        }
        const factors = [...dr.k0] as Vec3;
        if (dr.part.kind === 'axis' && this.xyz) {
          factors[dr.part.i] = value;
        } else {
          factors.fill(value);
        }
        this.setFactors(factors);
      },
      commit: () => ((this.dragging = null), this.gimbal.setHot(null), this.done()),
      cancel: () => this.setFactors(dr.k0)
    };
  }

  /** The drag's value in a box by the pointer (typeable, and it stays after letting go). */
  private boxAt(pointer: ToolPointer, text: string): void {
    const t = this.dragTarget();
    if (t) {
      this.typing.box(pointer, text, t);
    }
  }

  dragKey(e: KeyboardEvent): boolean {
    const t = this.dragTarget();

    return !!t && this.typing.key(e, t);
  }
}

/**
 * Scale by reference: tap two points on the bodies (corners, edges, faces),
 * type what the distance between them should be - the bodies scale about the
 * first point so it is (everything on them with it).
 */
export class ScaleRefOp extends FeatureOp<TransformFeature> {
  readonly id = 'scale';
  private a: Vec3 | null = null;
  private b: Vec3 | null = null;
  private dim: DimWidget | null = null;

  constructor(app: AppContext, bodies: string[], existing?: TransformFeature) {
    super(app, { ...app.store.newIdentity('transform', 'Scale'), type: 'transform', bodies, copy: false, op: { kind: 'scale', center: [0, 0, 0], factor: 1 } }, existing);
    const op = this.feature.op;
    if (op.kind === 'scale' && op.ref) {
      [this.a, this.b] = op.ref;
    }
    this.slots = [
      pointSlot(app, 'First point (stays put)', () => this.a, point => ((this.a = point), this.placed())),
      pointSlot(app, 'Second point', () => this.b, point => ((this.b = point), this.placed()))
    ];
  }

  /** Distance between the two points before scaling. */
  private get d0(): number {
    return this.a && this.b ? len(sub(this.b, this.a)) : 0;
  }

  private placed(): void {
    const op = this.feature.op;
    if (op.kind !== 'scale' || !this.a) {
      return;
    }
    op.center = this.a;
    if (this.b) {
      op.ref = [this.a, this.b];
    }
  }

  protected hint(): string {
    return 'Type the new distance between the two points. The body resizes to match.';
  }

  protected items(): PanelItem[] {
    const op = this.feature.op;
    if (op.kind !== 'scale' || this.d0 < 1e-9) {
      return [];
    }

    return [
      { type: 'number', label: 'Distance', value: this.d0 * op.factor, kind: 'length', onInput: value => this.setLength(value) },
      this.num('Factor', 'op.factor', 'number', { min: 0.0001, onInput: () => (this.dim?.setValue(this.d0 * (this.feature.op as { factor: number }).factor), this.update()) })
    ];
  }

  private setLength(value: number): void {
    const op = this.feature.op;
    if (op.kind !== 'scale' || !(value > 0) || this.d0 < 1e-9) {
      return;
    }
    op.factor = value / this.d0;
    this.app.ui.updatePanelValues([value, op.factor]);
    this.update();
  }

  protected ready(): boolean {
    const op = this.feature.op;

    return super.ready() && this.d0 > 1e-9 && op.kind === 'scale' && Math.abs(op.factor - 1) > 1e-9;
  }

  /** Both points: the dimension between them, its value box ready to type into. */
  protected onDraftChanged(): void {
    const op = this.feature.op;
    if (!this.a || !this.b || this.d0 < 1e-9 || op.kind !== 'scale') {
      this.dim?.dispose();
      this.dim = null;

      return;
    }
    const fresh = !this.dim;
    this.dim ??= new DimWidget(this.app.view, {
      value: this.d0 * op.factor,
      focus: true,
      onInput: value => (this.setLength(value), this.app.ui.updatePanelValues([value, (this.feature.op as { factor: number }).factor])),
      onCommit: () => this.done()
    });
    // Where the second point ends up: the line between them grows with the body.
    this.dim.set(this.a, add(this.a, scale(sub(this.b, this.a), op.factor)));
    if (fresh) {
      this.render();
    }
  }

  exit(): void {
    this.dim?.dispose();
    super.exit();
  }
}

/**
 * Scale a flat face within its plane: two in-plane handles (along the face's
 * own axes) and the centre for both at once. The sides tilt to follow.
 */
export class ScaleFaceOp extends FeatureOp<ScaleFaceFeature> {
  readonly id = 'scaleFace';
  private gimbal: Gimbal;
  private axes: Vec3[];
  private dragging: { part: GimbalPart; from: ToolPointer; k0: [number, number]; r0: number } | null = null;
  private typing = new DragTyping(this.app);

  constructor(app: AppContext, face: FaceRef, plane: PlaneDef, existing?: ScaleFaceFeature) {
    const normal = norm(plane.normal);
    const xAxis = norm(plane.xDir);
    super(app, { ...app.store.newIdentity('scaleFace'), type: 'scaleFace', face, u: xAxis, factors: [1, 1] }, existing);
    const uu = norm(this.feature.u);
    this.axes = [uu, cross(normal, uu), normal];
    this.gimbal = new Gimbal(app.view, { axes: this.axes, cubes: true, parts: gimbalPart => gimbalPart.kind === 'center' || (gimbalPart.kind === 'axis' && gimbalPart.i < 2) });
    this.gimbal.setCenter(face.center);
  }

  protected hint(): string {
    return 'Drag a handle to stretch the face one way, or the centre for both. The sides tilt to follow.';
  }

  protected items(): PanelItem[] {
    // Along which way, said in X / Y / Z when it lines up ("U" and "V" mean
    // nothing to a beginner narrowing a pylon's top along the engine).
    const along = (direction: Vec3) => {
      const axis = direction.findIndex(x => Math.abs(x) > 0.999);

      return axis >= 0 ? ` (along ${'XYZ'[axis]})` : '';
    };
    const vAxis = cross(this.feature.face.normal, this.feature.u);

    return [
      this.num(`Scale U${along(this.feature.u)}`, 'factors.0', 'number', { min: 0.0001 }),
      this.num(`Scale V${along(vAxis)}`, 'factors.1', 'number', { min: 0.0001 })
    ];
  }

  protected ready(): boolean {
    return this.feature.factors.some(factor => Math.abs(factor - 1) > 1e-9);
  }

  exit(): void {
    this.gimbal.dispose();
    super.exit();
  }

  hover(pointer: ToolPointer | null): void {
    this.gimbal.setHot(pointer && !this.dragging ? this.gimbal.hit(pointer) : (this.dragging?.part ?? null));
  }

  down(pointer: ToolPointer): boolean {
    const part = this.gimbal.hit(pointer);
    if (!part) {
      return false;
    }
    const screenPoint = this.app.view.toScreen(this.gimbal.origin);
    const r0 = screenPoint ? Math.max(24, Math.hypot(pointer.x - screenPoint[0], pointer.y - screenPoint[1])) : 60;
    this.dragging = { part, from: pointer, k0: [...this.feature.factors] as [number, number], r0 };

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
    const screenPoint = view.toScreen(this.gimbal.origin);
    if (!screenPoint) {
      return;
    }
    let factor: number;
    if (dr.part.kind === 'axis') {
      factor = (dr.r0 + axisDrag(view, this.gimbal.origin, this.axes[dr.part.i], dr.from, pointer) / view.cam.worldPerPixel(view.height)) / dr.r0;
    } else {
      factor = Math.hypot(pointer.x - screenPoint[0], pointer.y - screenPoint[1]) / dr.r0;
    }
    factor = Math.max(0.01, pointer.shift ? factor : Math.round(factor * 100) / 100);
    const factors: [number, number] = [...dr.k0];
    if (dr.part.kind === 'axis') {
      factors[dr.part.i as 0 | 1] = dr.k0[dr.part.i as 0 | 1] * factor;
    } else {
      ((factors[0] = dr.k0[0] * factor), (factors[1] = dr.k0[1] * factor));
    }
    this.feature.factors = factors;
    this.app.ui.updatePanelValues(factors);
    this.update();
    this.boxAt(pointer, `×${(dr.part.kind === 'axis' ? factors[dr.part.i as 0 | 1] : factors[0]).toFixed(2)}`);
  }

  up(): void {
    this.dragging = null;
    this.typing.reset();
    this.app.ui.setLabel(0, 0, null);
  }

  /** What a typed value does to the part being dragged (typed during the drag, or in its value box after). */
  private dragTarget(): DragTypingTarget | null {
    const dr = this.dragging;
    if (!dr) {
      return null;
    }

    return {
      kind: 'number',
      apply: (value) => {
        if (value <= 0) {
          return;
        }
        const factors: [number, number] = [...dr.k0];
        if (dr.part.kind === 'axis') {
          factors[dr.part.i as 0 | 1] = value;
        } else {
          ((factors[0] = value), (factors[1] = value));
        }
        this.feature.factors = factors;
        this.app.ui.updatePanelValues(factors);
        this.update();
      },
      commit: () => ((this.dragging = null), this.done()),
      cancel: () => ((this.feature.factors = dr.k0), this.update())
    };
  }

  /** The drag's value in a box by the pointer (typeable, and it stays after letting go). */
  private boxAt(pointer: ToolPointer, text: string): void {
    const t = this.dragTarget();
    if (t) {
      this.typing.box(pointer, text, t);
    }
  }

  dragKey(e: KeyboardEvent): boolean {
    const t = this.dragTarget();

    return !!t && this.typing.key(e, t);
  }
}

/** Replace a flat face: it moves onto another flat face or plane, the rest follows. */
export class ReplaceFaceOp extends FeatureOp<ReplaceFaceFeature> {
  readonly id = 'replaceFace';
  protected finishWhenPicked = true;

  constructor(app: AppContext, face: FaceRef, existing?: ReplaceFaceFeature) {
    super(app, { ...app.store.newIdentity('replaceFace'), type: 'replaceFace', face, plane: { origin: face.center, normal: face.normal, xDir: xDirFor(face.normal) } }, existing);
    let picked = !!existing;
    this.slots = [
      planeSlot(app, 'Replace with', () => (picked ? this.feature.plane : null), (pl, target) => {
        picked = true;
        this.feature.plane = pl;
        this.feature.target = target;
      })
    ];
  }

  protected hint(): string {
    return 'Tap the face or plane this face should move onto.';
  }

  protected items(): PanelItem[] {
    return [];
  }
}

function axisIndex(a: Vec3): number {
  return a.findIndex(value => Math.abs(value) > 0.99);
}

function axisName(a?: Vec3): string {
  return ['X', 'Y', 'Z'][a ? Math.max(0, axisIndex(a)) : 2];
}

/** How far the bodies reach along a direction (their size that way). */
export function bodyExtent(app: AppContext, bodies: string[], dir: Vec3): number {
  let lo = Infinity;
  let hi = -Infinity;
  for (const id of bodies) {
    const positions = app.view.body(id)?.positions;
    if (!positions) {
      continue;
    }
    for (let i = 0; i < positions.length; i += 3) {
      const t = positions[i] * dir[0] + positions[i + 1] * dir[1] + positions[i + 2] * dir[2];
      if (t < lo) {
        lo = t;
      }
      if (t > hi) {
        hi = t;
      }
    }
  }

  return hi > lo ? hi - lo : 0;
}

export function bodyCenter(app: AppContext, bodies: string[]): Vec3 {
  const pts = bodies.flatMap(id => app.view.body(id)?.faces.map(face => face.center) ?? []);
  if (!pts.length) {
    return [0, 0, 0];
  }

  return scale(pts.reduce((a, b) => add(a, b), [0, 0, 0] as Vec3), 1 / pts.length);
}

// ------------------------------------------------------------------- image

/** Move / rotate (gimbal), scale and fade a reference image. */
export class ImageOp extends FeatureOp<ImageFeature> {
  readonly id = 'image';
  private gimbal: Gimbal;
  private dragging: { from: ToolPointer; part: GimbalPart; origin: Vec3; xDir: Vec3 } | null = null;
  private aspect: number;

  constructor(app: AppContext, existing: ImageFeature) {
    super(app, existing, existing);
    this.aspect = existing.height / existing.width;
    const plane = existing.plane;
    this.gimbal = new Gimbal(app.view, { axes: [plane.xDir, cross(plane.normal, plane.xDir), plane.normal], parts: IN_PLANE });
  }

  protected hint(): string {
    return 'Drag the arrows to place the image. Set its width and how see-through it is on the line at the bottom.';
  }

  protected items(): PanelItem[] {
    // Which of the three main planes it stands on, and where its middle is on
    // it (from the origin, as in a sketch there): a side view to trace has to
    // stand up on the front plane at its real size - dragging couldn't turn it
    // off the floor, nor put it anywhere exactly.
    const pl = this.feature.plane;
    const on = ([['floor', GROUND], ['front', FRONT], ['side', RIGHT]] as const).find(([, q]) => Math.abs(dot(q.normal, pl.normal)) > 0.999)?.[0] ?? '';
    const y = cross(pl.normal, pl.xDir);
    const place = (along: number, across: number, base = pl) => {
      const yy = cross(base.normal, base.xDir);
      this.feature.plane = { ...base, origin: add(add(scale(base.xDir, along), scale(yy, across)), scale(base.normal, dot(pl.origin, pl.normal) * (base === pl ? 1 : 0))) };
      this.onDraftChanged();
      this.update();
    };
    const u0 = dot(pl.origin, pl.xDir);
    const v0 = dot(pl.origin, y);

    return [
      { type: 'choice', label: 'On', options: [{ id: 'floor', label: 'Floor' }, { id: 'front', label: 'Front' }, { id: 'side', label: 'Side' }], value: on, onChange: id => (place(u0, v0, { floor: GROUND, front: FRONT, side: RIGHT }[id as 'floor']), this.render()) },
      { type: 'number', label: 'X', value: u0, kind: 'length', onInput: value => place(value, dot(this.feature.plane.origin, cross(this.feature.plane.normal, this.feature.plane.xDir))) },
      { type: 'number', label: 'Y', value: v0, kind: 'length', onInput: value => place(dot(this.feature.plane.origin, this.feature.plane.xDir), value) },
      this.num('Width', 'width', 'length', { min: 0.001, onInput: value => ((this.feature.height = value * this.aspect), this.update()) }),
      { type: 'number', label: 'Opacity', value: this.feature.opacity, kind: 'number', min: 0.05, onInput: value => ((this.feature.opacity = Math.min(1, value)), this.update()) }
    ];
  }

  protected onDraftChanged(): void {
    this.gimbal.setCenter(this.feature.plane.origin);
  }

  exit(): void {
    this.gimbal.dispose();
    super.exit();
  }

  hover(pointer: ToolPointer | null): void {
    this.gimbal.setHot(pointer && !this.dragging ? this.gimbal.hit(pointer) : null);
  }

  down(pointer: ToolPointer): boolean {
    const part = this.gimbal.hit(pointer);
    if (!part) {
      return false;
    }
    this.dragging = { from: pointer, part, origin: [...this.feature.plane.origin] as Vec3, xDir: [...this.feature.plane.xDir] as Vec3 };

    return true;
  }

  drag(pointer: ToolPointer): void {
    const dr = this.dragging;
    if (!dr) {
      return;
    }
    const view = this.app.view;
    const pl = { ...this.feature.plane, origin: dr.origin };
    if (dr.part.kind === 'ring') {
      const screenPoint = view.toScreen(dr.origin);
      if (!screenPoint) {
        return;
      }
      const ang = (q: { x: number; y: number }) => Math.atan2(q.y - screenPoint[1], q.x - screenPoint[0]);
      const facing = dot(pl.normal, view.cam.viewDir().toArray() as Vec3) < 0 ? 1 : -1;
      const a = -(ang(pointer) - ang(dr.from)) * facing;
      const y = cross(pl.normal, dr.xDir);
      this.feature.plane = { ...this.feature.plane, xDir: norm(add(scale(dr.xDir, Math.cos(a)), scale(y, Math.sin(a)))) };
    } else {
      const a = view.rayToPlane(dr.from.x, dr.from.y, pl);
      const b = view.rayToPlane(pointer.x, pointer.y, pl);
      if (!a || !b) {
        return;
      }
      let delta = sub(b, a);
      if (dr.part.kind === 'axis') {
        const ax = this.gimbal.axes[dr.part.i];
        delta = scale(ax, dot(delta, ax));
      }
      this.feature.plane = { ...this.feature.plane, origin: add(dr.origin, delta) };
    }
    this.update();
  }

  up(): void {
    this.dragging = null;
    this.gimbal.setHot(null);
  }
}

// ------------------------------------------------------------- move plane

/** `vector` turned by ang (radians) about the unit `axis`. */
function turn(vector: Vec3, axis: Vec3, ang: number): Vec3 {
  const cos = Math.cos(ang);
  const sin = Math.sin(ang);

  return add(add(scale(vector, cos), scale(cross(axis, vector), sin)), scale(axis, dot(axis, vector) * (1 - cos)));
}

/**
 * Move / turn a construction plane with its gimbal (its own axes: the plane's
 * x, y and normal). With Copy on, the original stays and a new plane is made;
 * the new one is selected after, so the next drag copies again. A plane that
 * follows a face keeps following it while it's only moved along its normal
 * (its offset changes); any other move makes it a plane of its own.
 */
export class PlaneMoveOp extends FeatureOp<PlaneFeature> {
  readonly id = 'plane';
  private gimbal: Gimbal;
  private copyToggle: CopyToggle;
  private typing = new DragTyping(this.app);
  /** The plane at the start (resolved), and where its square is drawn: the pivot. */
  private base: PlaneDef;
  private pivot: Vec3;
  /** The move so far, along the gimbal's axes, and the turn (about one axis at a time). */
  private moved: Vec3 = [0, 0, 0];
  private turned: { axis: Vec3; angle: number } | null = null;
  /** Turned once already (then turned about another axis): no longer on its face. */
  private detached = false;
  private dragging: { from: ToolPointer; part: GimbalPart; t0: Vec3; turned: { axis: Vec3; angle: number } | null } | null = null;
  private copy = copyMode.on;
  private copyId: { id: string; name: string };

  constructor(app: AppContext, existing: PlaneFeature) {
    super(app, existing, existing);
    this.base = app.view.planeOf(existing.id) ?? existing.plane;
    this.pivot = app.view.planeShownAt(existing.id) ?? this.base.origin;
    this.copyId = app.store.newIdentity('plane', 'Plane');
    this.gimbal = new Gimbal(app.view, { axes: planeAxes(this.base) });
    this.gimbal.setCenter(this.pivot);
    this.copyToggle = new CopyToggle(app.view, () => this.gimbal.origin, on => ((this.copy = on), this.render(), this.update()));
  }

  protected hint(): string {
    return this.copy ? 'Drag the arrows to place a copy of the plane. Tap empty space when done.' : 'Drag the arrows to move or turn the plane. Tap empty space when done.';
  }

  protected items(): PanelItem[] {
    return [{ type: 'toggle', label: 'Copy', value: this.copy, onChange: isOn => ((this.copy = copyMode.on = isOn), this.render(), this.update()) }];
  }

  protected ready(): boolean {
    return this.copy || len(this.moved) > 1e-9 || !!this.turned?.angle || this.detached;
  }

  private worldMove(): Vec3 {
    const [ax, ay, an] = planeAxes(this.base);

    return add(add(scale(ax, this.moved[0]), scale(ay, this.moved[1])), scale(an, this.moved[2]));
  }

  /** The plane after the move: turned about the pivot, then moved. */
  private apply(): void {
    const b = this.base;
    const existing = this.existing!;
    const t = this.turned;
    const rot = (vector: Vec3) => (t && t.angle ? turn(vector, t.axis, (t.angle * Math.PI) / 180) : vector);
    const move = this.worldMove();
    const feature = this.feature;
    if (!this.detached && !t?.angle && Math.hypot(this.moved[0], this.moved[1]) < 1e-9) {
      // Only along the normal: just its offset changes (a plane on a face stays on it).
      feature.face = existing.face;
      feature.plane = existing.plane;
      feature.offset = existing.offset + this.moved[2];
    } else {
      feature.face = undefined;
      feature.offset = 0;
      feature.plane = { origin: add(add(this.pivot, rot(sub(b.origin, this.pivot))), move), xDir: norm(rot(b.xDir)), normal: norm(rot(b.normal)) };
    }
    if (feature.exprs?.offset) {
      delete feature.exprs.offset;
      if (!Object.keys(feature.exprs).length) {
        feature.exprs = undefined;
      }
    }
    const at = add(this.pivot, move);
    this.gimbal.setCenter(at);
    this.app.view.showPlaneAt(this.copy ? this.copyId.id : existing.id, at, existing.id);
  }

  protected onDraftChanged(): void {
    this.apply();
  }

  /** With Copy: the moved plane is a new one, the original stays. */
  protected featuresWith() {
    return this.copy ? [...this.app.store.features, this.copied()] : super.featuresWith();
  }

  private copied(): PlaneFeature {
    return { ...structuredClone(this.feature), ...this.copyId, kind: this.feature.kind ?? 'offset' };
  }

  protected done(): void {
    if (!this.ready()) {
      return this.app.setTool(null);
    }
    const plane = this.copy ? this.copied() : this.feature;
    if (this.copy) {
      this.app.store.add(plane);
    } else {
      this.app.store.update(plane.id, plane);
    }
    this.app.setTool(null);
    // Selected, gimbal and all: the next drag moves (or copies) it again.
    this.app.setSelection([{ kind: 'plane', id: plane.id }]);
  }

  exit(): void {
    this.gimbal.dispose();
    this.copyToggle.dispose();
    super.exit();
  }

  hover(pointer: ToolPointer | null): void {
    this.gimbal.setHot(pointer && !this.dragging ? this.gimbal.hit(pointer) : this.dragging?.part ?? null);
  }

  down(pointer: ToolPointer): boolean {
    const part = this.gimbal.hit(pointer);
    if (!part) {
      return false;
    }
    // A turn about another axis than the last one: what's done so far becomes the start.
    if (part.kind === 'ring' && this.turned?.angle && len(sub(this.turned.axis, this.gimbal.axes[part.i])) > 1e-6) {
      this.apply();
      this.pivot = add(this.pivot, this.worldMove());
      this.base = this.feature.plane;
      this.moved = [0, 0, 0];
      this.turned = null;
      this.detached = true;
      this.gimbal.dispose();
      this.gimbal = new Gimbal(this.app.view, { axes: planeAxes(this.base) });
      this.gimbal.setCenter(this.pivot);
    }
    this.dragging = { from: pointer, part, t0: [...this.moved] as Vec3, turned: this.turned && { ...this.turned } };
    this.gimbal.setHot(part);

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
    const ax = this.gimbal.axes;
    const at = add(this.pivot, add(add(scale(ax[0], dr.t0[0]), scale(ax[1], dr.t0[1])), scale(ax[2], dr.t0[2])));
    if (part.kind === 'axis') {
      const distance = snap(axisDrag(view, at, ax[part.i], dr.from, pointer));
      this.moved = [...dr.t0] as Vec3;
      this.moved[part.i] += distance;
      this.boxAt(pointer, fmtLen(distance));
    } else if (part.kind === 'plane' || part.kind === 'center') {
      // In the square's plane (the screen's for the centre).
      const normal: Vec3 = part.kind === 'plane' ? ax[part.i] : (view.cam.viewDir().toArray() as Vec3);
      const pl = { origin: at, normal: normal, xDir: xDirFor(normal) };
      const a = view.rayToPlane(dr.from.x, dr.from.y, pl);
      const b = view.rayToPlane(pointer.x, pointer.y, pl);
      if (!a || !b) {
        return;
      }
      const delta = sub(b, a);
      this.moved = [0, 1, 2].map(i => dr.t0[i] + snap(dot(delta, ax[i]))) as Vec3;
      this.boxAt(pointer, fmtLen(len(sub(this.moved, dr.t0))));
    } else {
      const axis = ax[part.i];
      const screenPoint = view.toScreen(at);
      if (!screenPoint) {
        return;
      }
      const ang = (q: { x: number; y: number }) => Math.atan2(q.y - screenPoint[1], q.x - screenPoint[0]);
      // Screen y points down, so a visual counter-clockwise turn is a negative atan2 change.
      const facing = dot(axis, view.cam.viewDir().toArray() as Vec3) < 0 ? 1 : -1;
      let deg = ((-(ang(pointer) - ang(dr.from)) * 180) / Math.PI) * facing;
      deg = ((deg + 540) % 360) - 180;
      const a0 = dr.turned?.angle ?? 0;
      this.turned = { axis, angle: pointer.shift ? a0 + deg : Math.round((a0 + deg) / 5) * 5 };
      this.boxAt(pointer, `${Math.round(this.turned.angle * 10) / 10}°`);
    }
    this.update();
  }

  up(): void {
    this.dragging = null;
    this.typing.reset();
    this.app.ui.setLabel(0, 0, null);
    this.gimbal.setHot(null);
    this.render();
  }

  /** A value typed while dragging (or in its box after): the distance or angle of that part. */
  private dragTarget(): DragTypingTarget | null {
    const dr = this.dragging;
    if (!dr) {
      return null;
    }
    const part = dr.part;
    const dragDir = norm(sub(this.moved, dr.t0));

    return {
      kind: part.kind === 'ring' ? 'angle' : 'length',
      apply: (value) => {
        if (part.kind === 'ring') {
          this.turned = { axis: this.gimbal.axes[part.i], angle: (dr.turned?.angle ?? 0) + value };
        } else if (part.kind === 'axis') {
          this.moved = [...dr.t0] as Vec3;
          this.moved[part.i] += value;
        } else if (len(dragDir) > 0.5) {
          this.moved = add(dr.t0, scale(dragDir, value));
        }
        this.update();
      },
      commit: () => ((this.dragging = null), this.gimbal.setHot(null), this.done()),
      cancel: () => ((this.moved = [...dr.t0] as Vec3), (this.turned = dr.turned), this.update())
    };
  }

  private boxAt(pointer: ToolPointer, text: string): void {
    const t = this.dragTarget();
    if (t) {
      this.typing.box(pointer, text, t);
    }
  }

  dragKey(e: KeyboardEvent): boolean {
    const t = this.dragTarget();

    return !!t && this.typing.key(e, t);
  }
}

/** A plane's own gimbal axes: its x, its y and its normal. */
export function planeAxes(plane: PlaneDef): Vec3[] {
  return [plane.xDir, cross(plane.normal, plane.xDir), plane.normal];
}

// ------------------------------------------------------------------- split

export class SplitOp extends FeatureOp<SplitFeature> {
  readonly id = 'split';
  private plane: PlaneDef | null = null;

  constructor(app: AppContext, body: string, existing?: SplitFeature, plane?: PlaneDef) {
    super(app, { ...app.store.newIdentity('split'), type: 'split', body, plane: plane ?? { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, 0, 1] } }, existing);
    this.plane = existing && !existing.noPlane ? existing.plane : (plane ?? null);
    const feature = this.feature;
    const first = planeSlot(app, 'Split with', () => this.plane, plane => ((this.plane = plane), (feature.plane = plane), (feature.noPlane = undefined)));
    // More planes at once (a body cut in slices).
    const more = planeSlot(app, 'More planes', () => feature.planes?.at(-1) ?? null, plane => (feature.planes = [...(feature.planes ?? []), plane]));
    const own = (b: string) => b === feature.id || b.startsWith(`${feature.id}:`);
    const tools: Slot = {
      label: 'Split with bodies',
      multi: true,
      describe: () => (feature.tools?.length ? `${feature.tools.length} bod${feature.tools.length > 1 ? 'ies' : 'y'}` : 'Optional - tap bodies to cut along'),
      filled: () => true,
      pick: { profiles: false, planes: false, axes: false },
      shows: () => (feature.tools ?? []).map(b => ({ kind: 'body' as const, body: b })),
      rejectHint: 'Tap another body',
      accept: (hit) => {
        const b = hit.kind === 'face' || hit.kind === 'edge' || hit.kind === 'vertex' ? hit.body : null;
        if (!b || b === feature.body || own(b)) {
          return false;
        }
        const t = feature.tools ?? [];
        feature.tools = t.includes(b) ? t.filter(tool => tool !== b) : [...t, b];
        if (!feature.tools.length) {
          feature.tools = undefined;
        }
        feature.noPlane = !this.plane || undefined;

        return true;
      }
    };
    // (Bodies to cut along: only when there is another body to cut along.)
    const others = !!feature.tools?.length || app.view.bodyList.some(b => b.id !== body && !own(b.id));
    this.slots = [
      first,
      { ...more, multi: true, describe: () => (feature.planes?.length ? `${feature.planes.length} more` : 'Optional - tap more planes or flat faces'), filled: () => true },
      ...(others ? [tools] : [])
    ];
  }

  /** A plane, or a body to cut along, is enough. */
  protected ready(): boolean {
    return !!this.plane || !!this.feature.tools?.length;
  }

  protected hint(): string {
    return 'The body is cut where the planes, and the surfaces of the bodies picked, cross it. Those bodies stay as they are.';
  }

  protected items(): PanelItem[] {
    return [];
  }
}

// ----------------------------------------------------------------- connect

/**
 * Connect: a smooth freeform bridge from one face to another (of two bodies,
 * or two faces of one), joined to them, cut out of them or a body of its own.
 */
export class ConnectOp extends FeatureOp<ConnectFeature> {
  readonly id = 'connect';
  private picked: (Sel | null)[] = [null, null];

  constructor(app: AppContext, faces: Sel[], existing?: ConnectFeature) {
    const refs = faces.flatMap(face => (face.kind === 'face' ? [faceRefOf(app, face)] : [])).filter((faceRef): faceRef is FaceRef => !!faceRef);
    super(app, { ...app.store.newIdentity('connect'), type: 'connect', faces: [refs[0], refs[1]] as [FaceRef, FaceRef], mode: 'auto', bulge: 1, size: 1 }, existing);
    if (!existing) {
      this.picked = [faces[0] ?? null, faces[1] ?? null];
    }
    const slot = (index: 0 | 1, label: string): Slot => ({
      label,
      describe: () => (this.feature.faces[index] ? '1 face' : 'Tap a face'),
      filled: () => !!this.feature.faces[index],
      pick: { profiles: false, edges: false, planes: false, axes: false },
      shows: () => (this.picked[index] ? [this.picked[index]!] : []),
      rejectHint: 'Tap a face',
      accept: (hit) => {
        if (hit.kind !== 'face') {
          return false;
        }
        const ref = faceRefOf(app, hit);
        if (!ref) {
          return false;
        }
        this.picked[index] = { kind: 'face', body: hit.body, face: hit.face };
        this.feature.faces[index] = ref;

        return true;
      }
    });
    // A curve for the bridge to follow (a spline drawn from one face to the
    // other), if there is one: without, it bows from face to face by Bend.
    const guide = pathSlot(app, () => this.feature.guide ?? null, pathRef => (this.feature.guide = pathRef));
    this.slots = [slot(0, 'From'), slot(1, 'To'), { ...guide, label: 'Guide', describe: () => (this.feature.guide ? guide.describe() : 'None - tap a sketch curve for the bridge to follow') }];
  }

  /** Two faces are enough: the bridge shows at once (the guide is a choice). */
  protected ready(): boolean {
    return !!this.feature.faces[0] && !!this.feature.faces[1];
  }

  protected hint(): string {
    return this.feature.guide
      ? 'The bridge runs along the guide from face to face. Size: how big it is against the faces.'
      : 'Bend: how far the bridge bows out of the faces. Tap a sketch curve (a spline from face to face) to have it follow that instead.';
  }

  protected items(): PanelItem[] {
    const feature = this.feature;

    return [
      ...(anyBody(this.app, feature.id) ? [modeChoice(() => feature.mode, mode => (feature.mode = mode), () => (this.render(), this.update()), true)] : []),
      // Without a guide it bows out by Bend; with one, the guide can be let go again.
      ...(feature.guide
        ? [{ type: 'button' as const, label: 'No guide', icon: 'close' as const, onClick: () => ((feature.guide = undefined), this.render(), this.update()) }]
        : [{ type: 'slider' as const, label: 'Bend', value: feature.bulge ?? 1, min: 0.2, max: 2.5, step: 0.05, show: (value: number) => value.toFixed(2), onInput: (bulge: number) => ((feature.bulge = bulge), this.update()) }]),
      { type: 'slider', label: 'Size', value: feature.size ?? 1, min: 0.1, max: 1, step: 0.01, show: value => `${Math.round(value * 100)}%`, onInput: size => ((feature.size = size), this.update()) }
    ];
  }
}

// -------------------------------------------------------------------- fill

/**
 * Fill: a surface over a network of curves - a boundary that closes a loop
 * (sketch curves, body edges) and, if wanted, guide curves across it.
 */
export class FillOp extends FeatureOp<FillFeature> {
  readonly id = 'fill';

  constructor(app: AppContext, boundary: PathRef[] = [], existing?: FillFeature) {
    super(app, { ...app.store.newIdentity('fill'), type: 'fill', boundary }, existing);
    this.slots = [
      curvesSlot(app, 'Boundary', () => this.feature.boundary, paths => (this.feature.boundary = paths)),
      curvesSlot(app, 'Guides', () => this.feature.guides ?? [], paths => (this.feature.guides = paths.length ? paths : undefined), true)
    ];
  }

  protected hint(): string {
    return this.feature.boundary.length ? 'Tap more curves or edges until they close a loop. Guides are curves inside it the surface passes through.' : 'Tap the curves or edges round the surface.';
  }

  protected items(): PanelItem[] {
    const feature = this.feature;
    const edges = feature.boundary.flatMap(pathRef => (pathRef.kind === 'edges' ? pathRef.edges : []));
    const opts = [
      { id: 'g0', label: 'Touch (G0)' },
      { id: 'g1', label: 'Tangent (G1)' },
      { id: 'g2', label: 'Curvature (G2)' }
    ];
    if (!edges.length) {
      return [];
    }
    const all: PanelItem = {
      type: 'choice',
      label: edges.length > 1 ? 'At body edges (all)' : 'At body edges',
      options: opts,
      value: feature.continuity ?? 'g0',
      // (Setting all of them clears the ones set edge by edge.)
      onChange: value => ((feature.continuity = value === 'g0' ? undefined : (value as 'g1' | 'g2')), (feature.edgeContinuity = undefined), this.render(), this.update())
    };
    if (edges.length < 2) {
      return [all];
    }
    const names = this.app.store.doc.names ?? {};

    // Each edge its own (an edge tapped in the list lights up on the model).
    return [
      all,
      ...edges.map(
        (edge, i): PanelItem => ({
          type: 'choice',
          label: `Edge ${i + 1}${names[edge.body] ? ` (${names[edge.body]})` : ''}`,
          options: opts,
          value: feature.edgeContinuity?.[fillEdgeKey(edge)] ?? feature.continuity ?? 'g0',
          onChange: (value) => {
            const next = { ...(feature.edgeContinuity ?? {}), [fillEdgeKey(edge)]: value as 'g0' | 'g1' | 'g2' };
            feature.edgeContinuity = next;
            this.update();
          }
        })
      )
    ];
  }
}

// ------------------------------------------------------------ fill to plane

/**
 * Fill to Plane: an open surface (a freeform sheet) becomes a solid by
 * filling down to a plane - an origin plane, a construction plane or a flat face.
 */
export class FillToPlaneOp extends FeatureOp<FillToPlaneFeature> {
  readonly id = 'fillToPlane';
  private plane: PlaneDef | null = null;

  constructor(app: AppContext, body: string, existing?: FillToPlaneFeature, plane?: PlaneDef) {
    super(app, { ...app.store.newIdentity('fillToPlane'), type: 'fillToPlane', body, plane: plane ?? { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, 0, 1] } }, existing);
    this.plane = existing?.plane ?? plane ?? null;
    this.slots = [planeSlot(app, 'Fill to', () => this.plane, plane => ((this.plane = plane), (this.feature.plane = plane)))];
  }

  protected hint(): string {
    return this.plane ? 'The space between the face and the plane is filled in.' : 'Tap the plane or flat face to fill up to.';
  }

  protected items(): PanelItem[] {
    return [];
  }
}

// ------------------------------------------------------------------ thread

/**
 * Thread a round face: a shank drawn at the nominal size gets an outside
 * thread, a hole drawn at the tap-drill size an inside one. The pitch starts
 * at the ISO coarse pitch for the size; the panel shows which size that makes.
 */
/**
 * The pitch (and hand) used last, for its size: the next hole or shank of
 * that size starts with it. Four boss holes at a fine 0.35 were four times
 * typing 0.35 over the standard 0.5.
 */
let lastThread: { r: number; hole: boolean; pitch: number; left?: boolean } | null = null;

export class ThreadOp extends FeatureOp<ThreadFeature> {
  readonly id = 'thread';

  private round: { r: number; hole: boolean };

  constructor(app: AppContext, face: FaceRef, round: { r: number; hole: boolean }, existing?: ThreadFeature) {
    const same = lastThread && Math.abs(lastThread.r - round.r) < 1e-6 && lastThread.hole === round.hole ? lastThread : null;
    super(app, { ...app.store.newIdentity('thread'), type: 'thread', face, pitch: same?.pitch ?? defaultPitch(round.r * 2, round.hole), round, ...(same?.left ? { left: true } : {}) }, existing);
    this.round = existing?.round ?? round;
  }

  private remember(): void {
    lastThread = { r: this.round.r, hole: this.round.hole, pitch: this.feature.pitch, left: this.feature.left };
  }

  enter(): void {
    super.enter();
    this.update();
  }

  private label(): string {
    return `${threadLabel(this.round.r * 2, this.round.hole, this.feature.pitch)} ${this.round.hole ? 'inside' : 'outside'} thread${this.feature.left ? ', left-hand' : ''}`;
  }

  protected hint(): string {
    return this.round.hole
      ? `${this.label()}. The thread is cut into the wall of the hole.`
      : `${this.label()}. A smaller pitch makes a finer thread.`;
  }

  protected items(): PanelItem[] {
    return [
      this.num('Pitch', 'pitch', 'length', { min: 0.05, onInput: value => this.setPitch(value) }),
      // How many threads side by side: 1 is a bolt's; 2 to 4, a jar lid's - on in half a turn or a quarter, the
      // crests still a pitch apart.
      { type: 'number', label: 'Starts', value: this.feature.starts ?? 1, kind: 'int', min: 1, onInput: value => ((this.feature.starts = value > 1 ? Math.min(8, Math.round(value)) : undefined), this.render(), this.update()) },
      { type: 'toggle', label: 'Left-hand', value: !!this.feature.left, onChange: isOn => ((this.feature.left = isOn || undefined), this.remember(), this.render(), this.update()) }
    ];
  }

  protected ready(): boolean {
    return this.feature.pitch > 0;
  }

  private setPitch(pitch: number): void {
    if (!(pitch > 0)) {
      return;
    }
    this.feature.pitch = pitch;
    this.remember();
    this.app.ui.updatePanelValues([pitch]);
    this.update();
  }
}

// ------------------------------------------------------------ construction

/** What a plane is made from, by name: "XZ plane", "Plane 02", "Face of Body 1". */
function baseName(app: AppContext, plane: PlaneFeature): string | undefined {
  if (plane.face) {
    return faceOfName(app, plane.face.body);
  }
  const same = (candidatePlane: PlaneDef) => len(sub(candidatePlane.origin, plane.plane.origin)) < 1e-6 && dot(norm(candidatePlane.normal), norm(plane.plane.normal)) > 1 - 1e-9;
  const origin = ['XY', 'XZ', 'YZ'].find((id) => {
    const originPlane = app.view.planeOf(id);

    return originPlane && same(originPlane);
  });
  if (origin) {
    return `${origin} plane`;
  }

  return app.view.construction.planes.find(constructionInfo => constructionInfo.id !== plane.id && same(constructionInfo.plane))?.name;
}

export class PlaneOp extends FeatureOp<PlaneFeature> {
  readonly id = 'plane';
  private base: PlaneDef | null = null;

  constructor(app: AppContext, base: PlaneDef | null, face: FaceRef | undefined, existing?: PlaneFeature) {
    super(app, { ...app.store.newIdentity('plane'), type: 'plane', kind: 'offset', plane: base ?? { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, 0, 1] }, face, offset: 10 }, existing);
    this.base = existing ? existing.plane : base;
    // Being edited: not from itself, nor from a plane made after it (that
    // one is built from this one, or comes later in the history).
    const at = existing ? app.store.doc.features.findIndex(feature => feature.id === existing.id) : -1;
    const skip = (id: string) => {
      const index = app.store.doc.features.findIndex(feature => feature.id === id);

      return at >= 0 && index >= at;
    };
    this.slots = [planeSlot(app, 'From', () => this.base, (plane, faceRef) => ((this.base = plane), (this.feature.plane = plane), (this.feature.face = faceRef)), { named: existing ? baseName(app, existing) : undefined, skip })];
  }

  private handle: Handle | null = null;
  private dim: DimWidget | null = null;
  private dragging: { from: ToolPointer; d0: number } | null = null;
  private typing = new DragTyping(this.app);

  protected hint(): string {
    return this.base ? 'Drag the arrow or type how far away the new plane goes (negative: the other way).' : 'Tap a face or plane to start the new plane from.';
  }

  protected items(): PanelItem[] {
    return [this.num('Offset', 'offset', 'length', { onInput: value => this.setOffset(value), inBox: true })];
  }

  enter(): void {
    super.enter();
    this.onDraftChanged();
  }

  exit(): void {
    this.handle?.dispose();
    this.dim?.dispose();
    super.exit();
  }

  /** The arrow and value box come out once there's a face or plane to offset from. */
  protected onDraftChanged(): void {
    const b = this.base;
    if (!b) {
      return;
    }
    if (!this.handle) {
      this.handle = new Handle(this.app.view, 'arrow');
      this.dim = new DimWidget(this.app.view, {
        boxAt: 'beyond',
        boxGap: 96,
        dir: b.normal,
        value: this.feature.offset,
        onInput: (value, text) => (this.typedInto('offset', text), this.setOffset(value)),
        onCommit: () => this.done()
      });
    }
    const top = add(b.origin, scale(b.normal, this.feature.offset));
    // The arrow keeps pointing out of the face; the value's sign says which side.
    this.handle.set(top, b.normal);
    this.dim!.set(b.origin, top);
  }

  private setOffset(offset: number): void {
    this.feature.offset = offset;
    this.app.ui.updatePanelValues([offset]);
    this.dim?.setValue(offset);
    this.update();
  }

  hover(pointer: ToolPointer | null): void {
    const on = !!pointer && !!this.handle && (!!this.dragging || this.handle.hit(pointer));
    this.handle?.setHot(on);
    if (!on) {
      super.hover(pointer);
    }
  }

  down(pointer: ToolPointer): boolean {
    if (!this.handle?.hit(pointer)) {
      return false;
    }
    this.dragging = { from: pointer, d0: this.feature.offset };

    return true;
  }

  drag(pointer: ToolPointer): void {
    const dr = this.dragging;
    const b = this.base;
    if (!dr || !b) {
      return;
    }
    this.typing.track(pointer);
    if (this.typing.active) {
      return;
    }
    const raw = dr.d0 + axisDrag(this.app.view, add(b.origin, scale(b.normal, dr.d0)), b.normal, dr.from, pointer);
    const step = niceStep(this.app.view.cam.worldPerPixel(this.app.view.height) * 4);
    this.typedInto('offset', '');
    this.setOffset(Math.round(raw / step) * step);
    this.app.ui.setLabel(pointer.x, pointer.y, `${fmtLen(this.feature.offset)}  · type a value`);
  }

  up(): void {
    this.dragging = null;
    this.typing.reset();
    this.app.ui.setLabel(0, 0, null);
    this.handle?.setHot(false);
  }

  dragKey(e: KeyboardEvent): boolean {
    const dr = this.dragging;
    if (!dr) {
      return false;
    }

    return this.typing.key(e, {
      kind: 'length',
      apply: value => this.setOffset(value),
      commit: () => ((this.dragging = null), this.done()),
      cancel: () => this.setOffset(dr.d0)
    });
  }
}

/** Midplane between two parallel planes/faces. */
export function midplane(a: PlaneDef, b: PlaneDef): PlaneDef | null {
  if (Math.abs(dot(a.normal, b.normal)) < 0.999) {
    return null;
  }

  return { ...a, origin: scale(add(a.origin, b.origin), 0.5) };
}

export class MidplaneOp extends FeatureOp<PlaneFeature> {
  readonly id = 'plane';
  private a: PlaneDef | null = null;
  private b: PlaneDef | null = null;

  constructor(app: AppContext) {
    super(app, { ...app.store.newIdentity('plane', 'Midplane'), type: 'plane', kind: 'mid', plane: { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, 0, 1] }, offset: 0 });
    const apply = () => {
      const plane = this.a && this.b ? midplane(this.a, this.b) : null;
      if (plane) {
        this.feature.plane = plane;
      } else if (this.a && this.b) {
        this.app.ui.toast('The two planes must be parallel');
      }
    };
    this.slots = [
      planeSlot(app, 'First', () => this.a, plane => ((this.a = plane), apply())),
      planeSlot(app, 'Second', () => this.b, plane => ((this.b = plane), apply()))
    ];
  }

  protected ready(): boolean {
    return !!(this.a && this.b && midplane(this.a, this.b));
  }

  protected hint(): string {
    return 'Tap two facing faces or planes: the new plane goes halfway between them.';
  }

  protected items(): PanelItem[] {
    return [];
  }
}

export class AxisOp extends FeatureOp<AxisFeature> {
  readonly id = 'axis';

  constructor(app: AppContext, origin: Vec3, dir: Vec3, existing?: AxisFeature, kind?: AxisKind) {
    super(app, { ...app.store.newIdentity('axis'), type: 'axis', origin, dir, ...(kind ? { kind } : {}) }, existing);
  }

  protected hint(): string {
    return 'A helper line to turn or mirror around. Type X / Y / Z to move it, then tap empty space.';
  }

  /**
   * Where it passes through, typed: it used to be kept at once through the
   * middle of the face tapped (a fan's axis level with its pivot, 215 up,
   * couldn't be made).
   */
  protected items(): PanelItem[] {
    return [this.num('X', 'origin.0', 'length'), this.num('Y', 'origin.1', 'length'), this.num('Z', 'origin.2', 'length')];
  }

}

