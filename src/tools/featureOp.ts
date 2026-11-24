import { getPath, setPath } from '../doc/params';
import { BETA_TYPES } from '../doc/store';
import { isExpression } from '../ui/ui';
import { screenClass } from '../device';
import { arrangement, materialRegions, pointInRegion, resolveRegion, type Region } from '../sketch/regions';
import { pointInPoly } from '../sketch/curves';
import { hitToSel, sourcesOf, viewMenu, type AppContext, type Sel, type Tool } from './tool';
import { DragTyping } from './dragTyping';
import type { ExtrudeSource, Feature, SketchFeature, Vec2 } from '../doc/types';
import type { FieldKind, PanelItem, ToolItem } from '../ui/ui';
import type { ToolPointer } from '../view/input';
import type { PickHit, PickOptions } from '../view/viewport';

/** Something the user has to point at (an axis, a path, faces to remove, …). */
export interface Slot {
  label: string;
  /** What the slot shows: "X axis", "2 faces", "Select…". */
  describe(): string;
  filled(): boolean;
  pick: PickOptions;
  /** Store the hit into the draft; return false if it doesn't fit this slot. */
  accept(hit: PickHit): boolean;
  multi?: boolean;
  /** Quick choices shown next to the slot (e.g. X / Y / Z). */
  presets?: { label: string; apply(): void }[];
  /** Highlights of what the slot currently holds. */
  shows?(): Sel[];
  /** Show the XY/XZ/YZ planes while this slot is waiting for a pick. */
  originPlanes?: boolean;
  /** Said when a tap hits something this slot can't take. */
  rejectHint?: string;
}

/**
 * Base for tools that create or edit one feature: pick slots + numbers +
 * live preview + Done/Cancel. Subclasses describe the draft; this does the rest.
 */
export abstract class FeatureOp<F extends Feature> implements Tool {
  abstract readonly id: string;
  feature: F;
  protected slots: Slot[] = [];
  protected active = -1;
  protected error: string | null = null;

  constructor(
    protected app: AppContext,
    draft: F,
    protected existing?: F
  ) {
    this.feature = existing ? structuredClone(existing) : draft;
    this.startSelection = [...app.selection];
  }

  /** What was selected when the tool started (Esc / Cancel goes back to it). */
  private startSelection: Sel[];

  /** Esc / Cancel: one step back - the tool goes, what was selected before is selected again. */
  protected cancel(): void {
    const back = this.startSelection;
    this.app.setTool(null);
    if (back.length) {
      this.app.setSelection(back);
    }
  }

  get editingId(): string {
    return this.feature.id;
  }

  /** One-line instruction for the hint bar. */
  protected abstract hint(): string;
  /** Numbers / choices / toggles in the panel. */
  protected abstract items(): PanelItem[];
  /** Is the draft complete enough to preview and commit? */
  protected ready(): boolean {
    return this.slots.every(slot => slot.filled());
  }
  /** Extra panel buttons. */
  protected actions(): ToolItem[] {
    return [];
  }

  enter(): void {
    // Cancel is in the card (on a phone the card is one row without it: there it's in the column).
    this.app.ui.setTools(screenClass() === 'phone' ? [{ id: 'cancel', label: 'Cancel', icon: 'close', shortcut: 'Esc', run: () => this.cancel() }] : []);
    this.app.ui.setBottom([]);
    this.active = this.slots.findIndex(slot => !slot.filled());
    // A step opened again with everything picked: taps add to (or take from) its
    // list of picks, as they did when it was made. (They did nothing: the four
    // bolts left out of a Subtract couldn't be added without tapping its slot first.)
    if (this.active < 0) {
      this.active = this.slots.reduce((last, slot, i) => (slot.multi ? i : last), -1);
    }
    this.render();
    this.update();
    this.app.ui.focusPanel();
    this.steps = [JSON.stringify(this.feature)];
    this.redos = [];
    window.addEventListener('pointerdown', this.onDown, true);
    window.addEventListener('pointerup', this.onUp, true);
    window.addEventListener('pointercancel', this.onUp, true);
  }

  // ---- Undo inside the tool
  // Each change made while the tool is open - a drag of its handle, a value typed, an option chosen, something more
  // picked - is a step of its own that Undo takes back, one at a time, and Redo puts back (asked for: "when I ...
  // select a vertex and I move it around, and I hit undo, that undo should change the last modification, not go back
  // to the extruding action or the one before entirely ... I want full history control"). Undo used to close the tool,
  // throwing all of it away, and then take back the step before it as well. With nothing left to take back in the
  // tool, Undo closes it (nothing made); the next Undo is the project's.
  private steps: string[] = [];
  private redos: string[] = [];
  private held = false;
  private settle = 0;
  private restoring = false;
  private onDown = (): void => void (this.held = true);
  private onUp = (): void => {
    this.held = false;
    // (After the tool's own handlers for this lift have run.)
    window.setTimeout(() => this.record(), 0);
  };

  /** What the draft is now, as a step - if it differs from the last one. */
  private record(): void {
    if (this.restoring || !this.steps.length) {
      return;
    }
    const now = JSON.stringify(this.feature);
    if (now === this.steps[this.steps.length - 1]) {
      return;
    }
    this.steps.push(now);
    if (this.steps.length > 100) {
      this.steps.shift();
    }
    this.redos = [];
    (this.app as AppContext & { refreshUndo?(): void }).refreshUndo?.();
  }

  /** The draft changed: a step once the drag ends, or once typing stops for a moment (digit by digit is one step). */
  private noteChange(): void {
    if (this.restoring || this.held) {
      return;
    }
    clearTimeout(this.settle);
    this.settle = window.setTimeout(() => this.record(), 450);
  }

  /** The draft put back to a step (in place: the window's parts and the handles hold on to it). */
  private restore(step: string): void {
    this.restoring = true;
    try {
      const feature = this.feature as unknown as Record<string, unknown>;
      for (const key of Object.keys(feature)) {
        delete feature[key];
      }
      Object.assign(feature, JSON.parse(step));
      this.restored();
      this.render();
      this.update();
    } finally {
      this.restoring = false;
    }
  }

  /** After Undo / Redo put the draft back: for a tool that keeps something beside the draft in step with it. */
  protected restored(): void {}

  get canUndo(): boolean {
    return true;
  }
  get canRedo(): boolean {
    return this.redos.length > 0;
  }
  undo(): boolean {
    clearTimeout(this.settle);
    this.record();
    if (this.steps.length < 2) {
      this.cancel();

      return true;
    }
    this.redos.push(this.steps.pop()!);
    this.restore(this.steps[this.steps.length - 1]);

    return true;
  }
  redo(): boolean {
    const next = this.redos.pop();
    if (!next) {
      return false;
    }
    this.steps.push(next);
    this.restore(next);

    return true;
  }

  exit(): void {
    clearTimeout(this.settle);
    window.removeEventListener('pointerdown', this.onDown, true);
    window.removeEventListener('pointerup', this.onUp, true);
    window.removeEventListener('pointercancel', this.onUp, true);
    this.app.view.setOriginPlanesVisible(false);
    this.app.ui.showPanel(null);
    this.app.ui.setHint(null);
    this.app.ui.setLabel(0, 0, null);
    DragTyping.hideAll();
    this.app.setHover(null);
    this.app.setSelection([]);
  }

  hover(pointer: ToolPointer | null): void {
    const slot = this.slots[this.active];
    if (!pointer || !slot) {
      return this.app.setHover(null);
    }
    const hit = this.app.view.pick(pointer.x, pointer.y, { edgeTolPx: pointer.tol, ...slot.pick });
    this.lastHover = { x: pointer.x, y: pointer.y, hit };
    this.app.setHover(hitToSel(hit));
  }

  /** What hover highlighted: a tap at the same spot takes exactly that. */
  private lastHover: { x: number; y: number; hit: PickHit | null } | null = null;

  /** Tools turning / sweeping a sketch profile: tapping another shape of it adds it (or takes it out). */
  protected moreRegions = false;

  /**
   * Another region of the profile's sketch tapped (on a phone a tapped region
   * opens the tool straight away): it joins the profile - tapped again, it
   * leaves. So several regions go together. True when the tap was used.
   */
  protected regionTap(pointer: ToolPointer): boolean {
    const feature = this.feature as unknown as { source?: ExtrudeSource };
    const src = feature.source;
    if (src?.kind !== 'profile' || this.existing) {
      return false;
    }
    const hit = this.app.view.pick(pointer.x, pointer.y, { edgeTolPx: pointer.tol, profiles: true, planes: false, axes: false, vertices: false });
    if (hit?.kind !== 'profile' || hit.sketch !== src.sketch) {
      return false;
    }
    const arr = arrangement(this.app.sketchCurves(src.sketch));
    const have = src.regions.map(ref => resolveRegion(arr, ref)).map(region => (region ? arr.regions.indexOf(region) : -1)).filter(regionIndex => regionIndex >= 0);
    const sel = have.map(region => ({ kind: 'profile' as const, sketch: src.sketch, region }));
    const i = sel.findIndex(pick => pick.region === hit.region);
    const next = i >= 0 ? sel.filter((_, j) => j !== i) : [...sel, { kind: 'profile' as const, sketch: hit.sketch, region: hit.region }];
    if (!next.length) {
      this.app.setTool(null);

      return true;
    }
    const made = sourcesOf(this.app, next)[0];
    if (!made) {
      return false;
    }
    feature.source = made;
    this.regionsChanged();
    this.app.ui.toast(`${next.length} region${next.length > 1 ? 's' : ''} selected`);
    this.render();
    this.app.setSelection([...next, ...this.slots.flatMap(slot => slot.shows?.() ?? [])]);
    this.update();

    return true;
  }

  /** A tap on a body the step waiting can't use (a mirror's plane, a ball tapped): true if the tool took it some other way. */
  protected otherBody(_body: string): boolean {
    return false;
  }

  /** After regionTap changed the profile (e.g. Extrude moves its arrow). */
  protected regionsChanged(): void {}

  tap(pointer: ToolPointer): void {
    const slot = this.slots[this.active];
    const lastHover = this.lastHover;
    let hit = lastHover?.hit && Math.hypot(lastHover.x - pointer.x, lastHover.y - pointer.y) < 6 ? lastHover.hit : this.app.view.pick(pointer.x, pointer.y, { edgeTolPx: pointer.tol, ...(slot?.pick ?? {}) });
    // Not what this step is making (its preview): what's under it. (A Fill's
    // last boundary curve, tapped once the loop closed, took the edge of the
    // surface just made on it instead.)
    const mine = (b: string) => b === this.feature.id || b.startsWith(`${this.feature.id}:`);
    if (hit && 'body' in hit && hit.body && mine(hit.body)) {
      hit = this.app.view.pick(pointer.x, pointer.y, { edgeTolPx: pointer.tol, ...(slot?.pick ?? {}), bodies: false });
    }
    if (this.moreRegions && (!slot || !hit || hit.kind === 'plane' || hit.kind === 'profile') && this.regionTap(pointer)) {
      return;
    }
    // Tapping empty space ends the tool: keep the result if it's complete.
    if (!hit) {
      if (this.ready()) {
        this.done();
      } else {
        this.app.setTool(null);
      }

      return;
    }
    if (!slot) {
      return;
    }
    // Not this one - but another body's face in the same place is (the bolts
    // flush with the flange they're to cut: the flange came first every time).
    const body = 'body' in hit ? hit.body : null;
    if (!slot.accept(hit) && !(body && this.app.view.facesAt(pointer.x, pointer.y).some(face => face.kind === 'face' && face.body !== body && slot.accept(face)))) {
      if (this.moreRegions && this.regionTap(pointer)) {
        return;
      }
      if (body && !mine(body) && this.otherBody(body)) {
        return;
      }
      if (slot.rejectHint) {
        this.app.ui.toast(slot.rejectHint);
      }

      return;
    }
    if (!slot.multi) {
      this.active = this.slots.findIndex((slot, i) => i > this.active && !slot.filled());
    }
    this.render();
    if (this.finishWhenPicked && this.ready()) {
      return void this.finishIfOk();
    }
    this.update();
  }

  /**
   * A body tapped in Items: the slot waiting takes it, as a tap on it in the
   * view would. (Six pegs inside a pulley's web, to subtract, can't be tapped
   * there - and the tap in Items put Subtract away and selected the body.)
   */
  pickBody(id: string): boolean {
    const slot = this.slots[this.active];
    if (!slot || !slot.accept({ kind: 'body', body: id, point: [0, 0, 0] } as unknown as PickHit)) {
      return false;
    }
    if (!slot.multi) {
      this.active = this.slots.findIndex((slot, i) => i > this.active && !slot.filled());
    }
    this.render();
    if (this.finishWhenPicked && this.ready()) {
      void this.finishIfOk();

      return true;
    }
    this.update();

    return true;
  }

  /** Nothing left to set once the picks are made (e.g. Replace Face): the last pick finishes. */
  protected finishWhenPicked = false;

  private async finishIfOk(): Promise<void> {
    this.onDraftChanged();
    const result = await this.app.preview(this.featuresWith());
    const err = result?.errors.find(e => e.featureId === this.feature.id)?.message;
    if (err) {
      this.error = err;
      this.setHint();
      this.app.ui.toast(err);

      return;
    }
    this.done();
  }

  /**
   * Right-click: Done and Cancel (and the view's switches) by the pointer -
   * a stray right-click no longer throws the tool's work away.
   */
  context(pointer: ToolPointer): void {
    viewMenu(this.app, pointer.x, pointer.y, [
      { label: 'Done', shortcut: 'Enter', disabled: !this.ready() || !!this.error, run: () => this.done() },
      { label: 'Cancel', shortcut: 'Esc', run: () => this.cancel() }
    ]);
  }

  key(e: KeyboardEvent): boolean {
    if (e.key === 'Enter') {
      this.done();
    } else if (e.key === 'Escape') {
      this.cancel();
    } else {
      return false;
    }

    return true;
  }

  /** Rebuild the panel (after slots/choices change). */
  protected render(): void {
    const slotItems: PanelItem[] = this.slots.flatMap((slot, i): PanelItem[] => [
      { type: 'slot', label: slot.label, value: slot.describe(), active: i === this.active, filled: slot.filled(), onClick: () => ((this.active = i), this.render()) },
      ...(slot.presets?.length && i === this.active
        ? [{ type: 'choice' as const, options: slot.presets.map((preset, presetIndex) => ({ id: String(presetIndex), label: preset.label })), value: '', onChange: (presetIndex: string) => (slot.presets![Number(presetIndex)].apply(), this.advance(), this.render(), this.update()) }]
        : [])
    ]);
    this.app.ui.showPanel({
      title: this.feature.name,
      beta: BETA_TYPES.has(this.feature.type),
      items: [...slotItems, ...this.items()],
      actions: this.actions(),
      onDone: () => this.done(),
      onCancel: () => this.cancel()
    });
    this.showSlotHighlights();
    this.setHint();
    this.app.view.setOriginPlanesVisible(!!this.slots[this.active]?.originPlanes);
  }

  private advance(): void {
    const slot = this.slots[this.active];
    if (slot && !slot.multi) {
      this.active = this.slots.findIndex((slot, i) => i > this.active && !slot.filled());
    }
  }

  private showSlotHighlights(): void {
    this.app.setSelection(this.slots.flatMap(slot => slot.shows?.() ?? []));
  }

  protected setHint(): void {
    const slot = this.slots[this.active];
    const text = this.error ? `⚠ ${this.error}` : slot && !slot.filled() ? `${slot.label}: ${slot.describe()}` : this.hint();
    this.app.ui.setHint(text);
    this.app.ui.setPanelWarning(this.error);
  }

  /**
   * What the last preview asked for was: a drag snaps its value to steps and
   * asks again on every pointer move - the same draft on the same project is
   * on screen already (or on its way), not rebuilt and shown again.
   */
  private asked: { key: string; base: readonly Feature[]; pending: boolean; result: unknown } | null = null;

  /** Re-run the preview with the current draft. */
  protected update(): void {
    this.onDraftChanged();
    this.noteChange();
    const ready = this.ready();
    const base = this.app.store.features;
    // (The steps that aren't the project's own: the draft, or what a tool puts in its place.)
    const list = ready ? this.featuresWith() : null;
    const own = new Set(base);
    const key = list ? JSON.stringify(list.filter(feature => !own.has(feature))) : '';
    const was = this.asked;
    if (was && was.key === key && was.base === base && (was.pending || was.result === this.app.result)) {
      return;
    }
    const mine = { key, base, pending: true, result: null as unknown };
    this.asked = mine;
    const shown = (result: unknown) => {
      mine.pending = false;
      mine.result = result;
      // Overtaken by something else's rebuild: asked again next time.
      if (!result && this.asked === mine) {
        this.asked = null;
      }
    };
    if (!ready) {
      void this.app.preview([...base]).then(shown);

      return;
    }
    this.app.preview(list!).then((result) => {
      shown(result);
      this.error = result?.errors.find(e => e.featureId === this.feature.id)?.message ?? null;
      this.setHint();
      // What the step notes about itself (it cut where Add may have been
      // meant, a piece left off): said while it's being made, not only on
      // its History row, out of sight on a phone. Once per new note.
      const note = result ? (result.notes?.find(note => note.featureId === this.feature.id)?.message ?? null) : this.noted;
      if (note && note !== this.noted && !this.error) {
        this.app.ui.toast(note);
      }
      this.noted = note;
    });
  }

  /** The note the last preview had for this step (said once). */
  private noted: string | null = null;

  /** Hook for handles etc. */
  protected onDraftChanged(): void {}

  /**
   * A number field bound to a path in the feature (e.g. "distance",
   * "op.translate.2") that can also hold a variable expression.
   */
  protected num(label: string, path: string, kind: FieldKind, opts: { min?: number; onInput?: (v: number) => void; inBox?: boolean } = {}): PanelItem {
    const feature = this.feature as Feature;

    return {
      type: 'number',
      label,
      value: Number(getPath(feature, path) ?? 0),
      kind,
      min: opts.min,
      expr: feature.exprs?.[path],
      inBox: opts.inBox,
      onExpr: expr => this.setExpr(path, expr),
      onInput: (value) => {
        setPath(feature, path, value);
        if (opts.onInput) {
          opts.onInput(value);
        } else {
          this.update();
        }
      }
    };
  }

  /**
   * Text typed into a value box at the model: a formula with variables keeps
   * the value linked to them (as the panel's field does); a plain number unlinks it.
   */
  /** The value at `path` follows this formula (null: just a number). */
  protected setExpr(path: string, expr: string | null): void {
    const feature = this.feature as Feature;
    const exprs = { ...(feature.exprs ?? {}) };
    if (expr) {
      exprs[path] = expr;
    } else {
      delete exprs[path];
    }
    feature.exprs = Object.keys(exprs).length ? exprs : undefined;
  }

  protected typedInto(path: string, text: string, wrap: (t: string) => string = t => t): void {
    const feature = this.feature as Feature;
    const exprs = { ...(feature.exprs ?? {}) };
    if (isExpression(text)) {
      exprs[path] = wrap(text.trim());
    } else {
      delete exprs[path];
    }
    feature.exprs = Object.keys(exprs).length ? exprs : undefined;
  }

  protected featuresWith(): Feature[] {
    const list = [...this.app.store.features];
    if (!this.existing) {
      return [...list, this.feature];
    }
    list[list.findIndex(feature => feature.id === this.feature.id)] = this.feature;

    return list;
  }

  protected done(): void {
    if (!this.ready()) {
      const missing = this.slots.find(slot => !slot.filled());
      // Nothing left to pick means nothing changed: just close the tool.
      if (!missing) {
        return this.app.setTool(null);
      }
      this.app.ui.toast('Finish picking first: ' + missing.label);

      return;
    }
    if (this.existing) {
      this.app.store.update(this.feature.id, this.feature);
    } else {
      // A new solid from sketches: the sketches step out of the way (the eye in Items brings them back).
      const feature = this.feature as Feature;
      // An extrude: its sketch is hidden straight away (tap the eye to bring it
      // back for the next shape). Other steps: once all its regions are used -
      // one drawn with several parts stays in view until the last is made.
      const used = sketchesUsed(feature).filter(id => feature.type === 'extrude' || allRegionsUsed(this.app, id, [...this.app.store.doc.features, feature]));
      this.app.store.commit((draft) => {
        draft.features.push(feature);
        if (used.length) {
          draft.hidden = [...new Set([...draft.hidden, ...used])];
        }
      });
    }
    this.app.setTool(null);
  }
}

/** Has every region of a sketch been made into something (by these steps)? */
function allRegionsUsed(app: AppContext, sketch: string, features: Feature[]): boolean {
  try {
    const arr = arrangement(app.sketchCurves(sketch));
    // Only what was drawn counts (not the outline of the face it's on: window
    // sketches on a wall stayed in view after every window was cut).
    const drawn = materialRegions(arrangement(app.store.find<SketchFeature>(sketch)?.entities ?? []));
    if (drawn.length <= 1 && arr.regions.length <= 1) {
      return true;
    }
    const used: Region[] = [];
    const add = (extrudeSource: ExtrudeSource) => {
      if (extrudeSource.kind !== 'profile' || extrudeSource.sketch !== sketch) {
        return;
      }
      for (const ref of extrudeSource.regions) {
        const region = resolveRegion(arr, ref);
        if (region) {
          used.push(region);
        }
      }
    };
    // A full turn's axis in the sketch: what's drawn across it (a whole circle
    // for a ball, its lower half never picked) is in the solid too.
    const mirrors: ((q: Vec2) => Vec2)[] = [];
    const pl = app.sketchPlane(sketch);
    for (const feature of features) {
      if (feature.type === 'extrude' || feature.type === 'revolve' || feature.type === 'sweep') {
        add(feature.source);
      } else if (feature.type === 'loft') {
        feature.sections.forEach(add);
      }
      if (feature.type === 'revolve' && pl && Math.abs(feature.angle) >= 360 - 1e-9 && feature.source.kind === 'profile' && feature.source.sketch === sketch) {
        const normal = pl.normal;
        const y: [number, number, number] = [normal[1] * pl.xDir[2] - normal[2] * pl.xDir[1], normal[2] * pl.xDir[0] - normal[0] * pl.xDir[2], normal[0] * pl.xDir[1] - normal[1] * pl.xDir[0]];
        const d3 = feature.axis.dir;
        const dl = Math.hypot(d3[0], d3[1], d3[2]) || 1;
        const off = (d3[0] * normal[0] + d3[1] * normal[1] + d3[2] * normal[2]) / dl;
        const rel = [feature.axis.origin[0] - pl.origin[0], feature.axis.origin[1] - pl.origin[1], feature.axis.origin[2] - pl.origin[2]];
        if (Math.abs(off) > 1e-9 || Math.abs(rel[0] * normal[0] + rel[1] * normal[1] + rel[2] * normal[2]) > 1e-6) {
          continue;
        }
        const dot2 = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
        const origin: Vec2 = [dot2(rel, pl.xDir), dot2(rel, y)];
        const du = dot2(d3, pl.xDir) / dl;
        const dv = dot2(d3, y) / dl;
        mirrors.push((q) => {
          const t = (q[0] - origin[0]) * du + (q[1] - origin[1]) * dv;
          const foot: Vec2 = [origin[0] + t * du, origin[1] + t * dv];

          return [2 * foot[0] - q[0], 2 * foot[1] - q[1]];
        });
      }
    }
    // Every shape drawn has been made into something. (Matched shape by shape,
    // not piece by piece: where the drawing meets an edge in its plane - the
    // corner of a rounded button and the same corner of the body made from
    // it, sampled a little differently - slivers are left that no one would
    // use; the sketch stayed in view and its face-wide region took every later
    // tap on that face.)
    const inside = (region: Region, q: Vec2) => pointInPoly(q, region.outer.poly) && !region.holes.some(hole => pointInPoly(q, hole.poly));
    const covered = (region: Region) => used.some(usedRegion => inside(region, pointInRegion(usedRegion)));
    const turnedIn = (region: Region) => mirrors.some(mir => used.some(usedRegion => inside(usedRegion, mir(pointInRegion(region)))));

    return drawn.every(region => covered(region) || turnedIn(region));
  } catch {
    return true;
  }
}

/** The sketches an extrude / revolve / sweep / loft was made from. */
export function sketchesUsed(feature: Feature): string[] {
  const of = (extrudeSource: ExtrudeSource) => (extrudeSource.kind === 'profile' ? [extrudeSource.sketch] : []);
  switch (feature.type) {
    case 'extrude':
    case 'revolve':
      return of(feature.source);
    case 'sweep':
      return [...of(feature.source), ...(feature.path.kind === 'sketch' ? [feature.path.sketch] : [])];
    case 'loft':
      return feature.sections.flatMap(of);
    case 'fill':
      return [...feature.boundary, ...(feature.guides ?? [])].flatMap(pathRef => (pathRef.kind === 'sketch' ? [pathRef.sketch] : []));
    default:
      return [];
  }
}
