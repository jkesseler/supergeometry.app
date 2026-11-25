import { SelectTool } from './tools/select';
import { sectionPlane, SectionTool, type SectionState } from './tools/section';
import { bodyCenter } from './tools/ops';
import { ItemsPanel } from './ui/items';
import { PinLayer } from './tools/annotate';
import { settings } from './settings';
import { KernelClient } from './kernel/client';
import { VariablesTool } from './tools/variablesTool';
import { VariableTags } from './tools/variableTags';
import { variableTags } from './doc/varAnchors';
import { numpadVariables } from './ui/numpad';
import { WebWindow } from './ui/webWindow';
import { RefImages } from './ui/refImages';
import { createVariable } from './io/insert';
import { libraryEntries } from './doc/library';
import { DocStore } from './doc/store';
import { SketchTool } from './tools/sketch';
import { Tutorial } from './ui/tutorial';
import { AssemblyTool } from './assembly/assemblyTool';
import { keepSizes } from './doc/unitChange';
import { bodiesOf, sameSel, sourceFrame, sourcesOf, type AppContext, type Sel, type Tool } from './tools/tool';
import { setupRightColumn } from './ui/panels';
import { UI } from './ui/ui';
import { Sentence } from './ui/sentence';
import { Ghost } from './tools/ghost';
import { arrangement, drawnRegions, materialRegions } from './sketch/regions';
import { setUnits, setVariables } from './units';
import { InputRouter } from './view/input';
import { ViewCube } from './view/viewcube';
import { PivotButton } from './ui/pivot';
import { Updates } from './ui/update';
import { Exporter } from './app/exporting';
import { History } from './app/history';
import { Keys } from './app/keys';
import { startHole, startThread } from './app/thread';
import { Undoing } from './app/undoing';
import { Scene } from './app/scene';
import { itemsHost, sentenceHost, setupBusy, setupVR, variableTagHost } from './app/setup';
import { Menus } from './app/menus';
import { Topbar } from './app/topbar';
import { holdEditorLock } from './app/editorLock';
import { Projects } from './app/projects';
import { isHeadset, screenClass } from './device';
import { Viewport } from './view/viewport';
import { VRMode } from './view/xr';
import type { ToolItem } from './ui/ui';
import type { RegenResult } from './kernel/protocol';
import type { Feature, PinDef, PlaneDef, SketchEntity, SketchFeature, Units, Vec3 } from './doc/types';

export class App implements AppContext {
  readonly store = new DocStore();
  readonly kernel = new KernelClient();
  readonly view: Viewport;
  readonly ui = new UI();
  readonly projects = new Projects(this);
  readonly history = new History(this);
  private readonly keys = new Keys(this);
  private readonly undoing = new Undoing(this);
  private readonly scene = new Scene(this);
  private readonly menus = new Menus(this);
  private readonly topbar = new Topbar(this);
  readonly exporter = new Exporter(this);
  /** The sentence bar: the pick, then what it offers, on one line - the way to the tools. */
  sentence!: Sentence;
  /** The look ahead a tool under the pointer is showing on the model (see ghost.ts). */
  peekGhost: Ghost | null = null;
  /** Where the view was last tapped (the sentence bar starts a sketch tool that acts where it is tapped right there). */
  lastTapAt: { x: number; y: number; type: 'mouse' | 'pen' | 'touch' } | null = null;
  /** Pictures to look at while modelling, each in a window over the model (under the buttons). */
  readonly refImages = new RefImages((text, kind) => this.ui.toast(text, kind));
  readonly web = new WebWindow();
  input: InputRouter;
  result: RegenResult | null = null;
  selection: Sel[] = [];
  section: SectionState | null = null;
  isolated: string[] | null = null;
  /** Variables switched on: their tags in the view. */
  varsOn = false;
  private varTags!: VariableTags;
  private hover: Sel | null = null;
  selectTool: SelectTool;
  /** The headset mode (its pictures can be checked on the page: vr.snapshot). */
  vr: VRMode | null = null;
  tool: Tool;
  /** The tutorial begun (More > Tutorial, and the welcome window's button). */
  startTutorial: () => void = () => {};
  /** The tutorial (for the debug handle: a test steps it by hand where the browser draws seldom). */
  tutorial: Tutorial | null = null;
  private pinLayer: PinLayer;
  items: ItemsPanel;

  constructor(canvas: HTMLCanvasElement) {
    this.view = new Viewport(canvas);
    this.input = new InputRouter(this.view);
    this.selectTool = new SelectTool(this);
    this.tool = this.selectTool;
    this.input.handler = this.tool;
    this.sentence = new Sentence(sentenceHost(this));
    canvas.addEventListener(
      'pointerup',
      (e) => {
        const rect = canvas.getBoundingClientRect();
        this.lastTapAt = { x: e.clientX - rect.left, y: e.clientY - rect.top, type: (e.pointerType || 'mouse') as 'mouse' | 'pen' | 'touch' };
      },
      true
    );
    // Headsets: bigger targets everywhere (CSS) - aiming a controller is less precise than a mouse.
    if (isHeadset) {
      document.body.classList.add('headset');
    }
    setupBusy(this);
    const cube = new ViewCube(this.view);
    document.getElementById('viewcube-host')!.append(cube.el);
    // The orbit centre button sits at the cube's bottom left (Views at its bottom right).
    cube.el.append(new PivotButton(this.view, t => this.ui.toast(t)).el);
    // Screenshots name the isolated bodies and surfaces (when isolating).
    const isolatedNames = () =>
      (this.isolated ?? []).flatMap((id) => {
        const b = this.view.bodyList.find(bodyMesh => bodyMesh.id === id);

        return b ? [this.store.doc.names?.[id] ?? b.name ?? 'Body'] : [];
      });
    setupRightColumn(this.ui, this.view, this.store, units => this.setUnits(units), isolatedNames);
    setupVR(this);
    this.pinLayer = new PinLayer(this.view);
    this.varTags = new VariableTags(this.view, variableTagHost(this));
    // ƒx buttons on number fields create named variables.
    this.ui.variableFactory = current => createVariable(this, current);
    this.ui.variableNames = () => this.store.doc.variables.map(variable => variable.name);
    numpadVariables({ names: () => this.store.doc.variables.map(variable => variable.name), create: value => createVariable(this, value) });
    settings.onChange(() => this.showPins());
    this.items = new ItemsPanel(this.store, itemsHost(this));
    // Computers and tablets start with Items open (phones: History only, there's no room for both).
    // (A phone on its side is wider than 720 px but only ~375 tall: Items would cover a third of it.)
    if (screenClass() !== 'phone') {
      this.items.toggle(true);
    }

    this.store.onChange(() => this.docChanged());
    this.keys.attach();
    // A phone may drop the page once it's in the background: save now, undo steps included.
    const flush = () => this.store.flush().catch(error => console.error('[App] save on leaving not written:', error));
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        flush();
      }
    });
    window.addEventListener('pagehide', flush);
    this.topbar.attach();
    this.tool.enter?.();

    this.ui.setStatus('Loading geometry kernel…');
    const loaded = holdEditorLock(() => this.ui.ask('Open in another tab', 'superGeometry.app works in one tab at a time, so two tabs never save over each other. Close the other tab, then tap Try again.', [{ id: 'retry', label: 'Try again', primary: true }]))
      .then(() => this.store.load())
      .then(() => this.projects.attach().catch(error => console.error('[App] project library not attached, the autosave still works:', error)));
    // Every visit starts at the projects, with a welcome: shown as soon as the
    // projects are read, while the geometry kernel is still loading behind it.
    void loaded.then(() => this.projects.show(true, true));
    Promise.all([this.kernel.ready, loaded])
      .then(async () => {
        this.ui.setStatus(null);
        await this.regenerate();
        this.view.fitAll(false);
        // A project never pictured (kept before it was ever drawn) showed a
        // blank shape on its card: now that it's drawn, it gets its picture -
        // in the welcome window too, if that's still open.
        const entry = (await libraryEntries()).find(e => e.id === this.projects.projectId);
        if (entry && !entry.thumb && this.store.features.length) {
          await this.projects.keep(JSON.stringify(this.store.doc), true).catch(error => console.error('[App] first picture of the project not saved:', error));
          const thumb = (await libraryEntries()).find(e => e.id === this.projects.projectId)?.thumb;
          const pic = document.querySelector<HTMLElement>('.library-card.current .library-pic');
          if (thumb && pic && !pic.querySelector('img')) {
            const img = document.createElement('img');
            img.src = thumb;
            img.alt = '';
            img.draggable = false;
            pic.querySelector('svg')?.replaceWith(img);
          }
        }
      })
      .catch(err => this.ui.setStatus(`Could not start the geometry kernel: ${err.message ?? err}`));
  }

  // ------------------------------------------------------------ state

  /**
   * An assembly's pose - where its parts were left - is on the screen while nothing is being worked on: no tool
   * open, nothing picked. With something picked or a tool open the parts are where they were modelled (a tool's
   * arrows and sizes are there). Assemblies itself shows its own. (Asked for: "when i click OK, it resets to the
   * original stance".)
   */
  showPose(): void {
    if (this.tool instanceof AssemblyTool) {
      return;
    }
    this.view.setPoses(this.tool === this.selectTool && !this.selection.length ? AssemblyTool.posesOf(this) : null);
  }

  setSelection(sel: Sel[]): void {
    this.selection = sel;
    this.showPose();
    this.refreshHighlights();
    // Selected bodies, planes, axes and images light up in Items too.
    this.items?.markSelected(sel.flatMap(highlight => (highlight.kind === 'body' ? [highlight.body] : highlight.kind === 'plane' || highlight.kind === 'axis' || highlight.kind === 'image' ? [highlight.id] : [])));
    if (this.tool === this.selectTool) {
      this.selectTool.refresh();
    }
  }

  setHover(highlight: Sel | null): void {
    if (highlight === this.hover || (highlight && this.hover && sameSel(highlight, this.hover))) {
      return;
    }
    this.hover = highlight;
    this.refreshHighlights();
  }

  /** Where the last thing picked is on the model (the sentence bar's thread runs to it). */
  pickAnchor(): Vec3 | null {
    const sel = this.selection;
    const highlight = sel[sel.length - 1];
    if (!highlight) {
      return null;
    }
    const view = this.view;
    if (highlight.kind === 'face') {
      return view.body(highlight.body)?.faces[highlight.face]?.center ?? null;
    }
    if (highlight.kind === 'edge') {
      return view.body(highlight.body)?.edges[highlight.edge]?.mid ?? null;
    }
    if (highlight.kind === 'vertex') {
      return view.vertexOf(highlight.body, highlight.vertex) ?? null;
    }
    if (highlight.kind === 'body') {
      return bodyCenter(this, bodiesOf(sel));
    }
    if (highlight.kind === 'profile') {
      const src = sourcesOf(this, [highlight])[0];

      return src ? sourceFrame(this, src).base : null;
    }
    if (highlight.kind === 'plane') {
      return view.planeShownAt(highlight.id) ?? view.planeOf(highlight.id)?.origin ?? null;
    }
    if (highlight.kind === 'axis') {
      return view.axisOf(highlight.id)?.plane.origin ?? null;
    }

    return null;
  }

  setTool(tool: Tool | null): void {
    const next = tool ?? this.selectTool;
    const leavingOp = this.tool !== this.selectTool;
    // A sketch left right after a shape was closed in it: that shape is what comes next (see below).
    const closed = next === this.selectTool && this.tool instanceof SketchTool ? this.tool.justClosed : null;
    this.tool.exit?.();
    this.tool = next;
    this.input.handler = next;
    this.showPose();
    this.hover = null;
    this.ui.closeFlyout();
    this.ui.unfoldPanel();
    // A phone: History and Items go, so the tool, its arrows and its value
    // boxes aren't drawn under them (they can be opened again while it runs).
    if (next !== this.selectTool && window.innerWidth <= 720) {
      if (document.body.classList.contains('history-open')) {
        this.ui.toggleHistory(false);
      }
      if (document.getElementById('items')?.classList.contains('open')) {
        this.items.toggle(false);
      }
    }
    next.enter?.();
    this.updateUndo();
    // Leaving an operation drops its preview.
    if (leavingOp && next === this.selectTool) {
      void this.regenerate();
    } else {
      this.scene.refreshSketches();
    }
    this.history.render();
    // Drawing goes straight on to 3D: the shape just closed is picked as the sketch is left, so its arrow is up
    // already - drag it, no tap on the shape first. (The last shape made of the sketch's curves: the one just drawn.)
    if (closed && this.tool === this.selectTool && !this.selection.length) {
      // (What was drawn - on a face the sketch's curves hold the face's outline too, and the last shape of them all
      // is the face less the shape: a circle drawn on a box's top had the top picked round it, not the circle.)
      const all = arrangement(this.sketchCurves(closed));
      const mine = drawnRegions(all, arrangement(this.store.find<SketchFeature>(closed)?.entities ?? []));
      const solid = mine.length ? mine : materialRegions(all);
      const region = all.regions.indexOf(solid[solid.length - 1]);
      if (region >= 0) {
        this.setSelection([{ kind: 'profile', sketch: closed, region }]);
        // Seen straight on (as it was drawn), a pull has nowhere to show: the view swings round to see it rise.
        const pl = this.sketchPlane(closed);
        const dir = this.view.cam.viewDir();
        if (pl && Math.abs(dir.x * pl.normal[0] + dir.y * pl.normal[1] + dir.z * pl.normal[2]) > 0.95) {
          // (A floor sketch: the usual three-quarter view. Any other: from a little to its side and above.)
          if (Math.abs(pl.normal[2]) > 0.9) {
            this.view.cam.iso();
          } else {
            this.view.cam.lookAlong([pl.normal[0] * 0.7 + pl.xDir[0] * 0.45, pl.normal[1] * 0.7 + pl.xDir[1] * 0.45, pl.normal[2] * 0.7 + pl.xDir[2] * 0.45 + 0.5]);
          }
        }
      }
    }
  }

  /** The last section used: Section View off and on again brings it back. */
  lastSection: SectionState | null = null;

  /**
   * Section View button: on → off (remembered); off → the remembered section,
   * or a new one - straight from a selected flat face if there is one.
   */
  toggleSection(): void {
    if (this.section) {
      const keep = this.section;
      if (this.tool instanceof SectionTool) {
        this.setTool(null);
      }
      this.setSection(null);
      this.lastSection = keep;
      this.refreshTools();

      return;
    }
    const highlight = this.selection[0];
    const face = highlight?.kind === 'face' ? this.view.body(highlight.body)?.faces[highlight.face] : undefined;
    if (face?.plane) {
      // Cut a hair inside the face so the face itself shows the cut.
      const inset = -this.view.cam.worldPerPixel(this.view.height);
      this.setSection({ plane: face.plane, offset: inset, flipped: false, inset });
    } else if (this.lastSection) {
      this.setSection(this.lastSection);
    }
    this.setTool(new SectionTool(this));
  }

  /** Re-draw the tool columns (e.g. after Section View changed). */
  private refreshTools(): void {
    if (this.tool === this.selectTool) {
      this.selectTool.refresh();
    } else {
      this.ui.setBottom(this.bottomTools());
    }
  }

  startThread(): void {
    startThread(this);
  }

  startHole(): void {
    startHole(this);
  }

  setSection(sectionState: SectionState | null): void {
    this.section = sectionState;
    // A section on screen is the one to remember (a deleted one is forgotten).
    if (sectionState) {
      this.lastSection = null;
    }
    this.view.setSection(sectionState ? sectionPlane(sectionState) : null);
    this.view.setSectionStyle(sectionState?.flat ? 'flat' : sectionState?.only ? 'only' : 'normal');
  }

  get pins(): PinDef[] {
    return this.store.doc.pins;
  }

  setPins(pins: PinDef[]): void {
    this.store.commit(draft => (draft.pins = pins));
  }

  addPin(pin: PinDef): void {
    this.setPins([...this.pins, pin]);
    this.ui.toast(`Pinned ${pin.text}`);
  }

  private showPins(): void {
    this.pinLayer.set(this.pins, settings.value.showPinned);
  }

  /** Bodies and features seen at the last rebuild: anything new while isolating joins the isolated set. */
  known: Set<string> | null = null;

  revealInItems(ids: string[]): void {
    this.items.reveal(ids);
  }

  /** A pick from the Items list: it joins what's picked (picked already: it leaves), as taps in the view do. */
  togglePick(highlight: Sel): void {
    // (Another tool's highlights aren't picks.)
    const had = this.tool === this.selectTool ? this.selection : [];
    this.setTool(null);
    const i = had.findIndex(picked => sameSel(picked, highlight));
    this.setSelection(i >= 0 ? had.filter((_, index) => index !== i) : [...had, highlight]);
  }

  isolate(bodies: string[] | null): void {
    this.isolated = bodies?.length ? [...bodies] : null;
    // What exists now; anything made from here on joins the isolated set.
    this.known = new Set([...(this.result?.bodies ?? []).map(b => b.id), ...this.store.doc.features.map(feature => feature.id)]);
    this.applyVisibility();
    // Isolated bodies are all there is: sketches, planes, axes and images step out too.
    this.scene.refreshConstruction();
    this.scene.refreshSketches();
    if (this.tool === this.selectTool) {
      this.selectTool.refresh();
    }
    this.items.render(this.result);
  }

  /**
   * What isolating shows: the isolated bodies (and what was made since), plus
   * the sketches drawn on a face of one of those bodies - they belong to it,
   * so their shapes can be picked (extrude, offset…) like on any face.
   */
  isolatedWithSketches(): string[] | null {
    if (!this.isolated) {
      return null;
    }
    const iso = new Set(this.isolated);
    const onIsolated = this.store.doc.features.filter(feature => feature.type === 'sketch' && !!feature.attachedTo && iso.has(feature.attachedTo.body) && !iso.has(feature.id)).map(feature => feature.id);

    return onIsolated.length ? [...this.isolated, ...onIsolated] : this.isolated;
  }

  /** Hidden (Items) + not isolated → invisible and unpickable. */
  applyVisibility(): void {
    const hidden = new Set(this.store.doc.hidden);
    if (this.isolated) {
      for (const b of this.result?.bodies ?? []) {
        if (!this.isolated.includes(b.id)) {
          hidden.add(b.id);
        }
      }
    }
    this.view.setHidden(hidden);
  }

  sketchPlane(id: string): PlaneDef | undefined {
    return this.result?.sketchPlanes[id] ?? this.store.find<SketchFeature>(id)?.plane;
  }

  sketchCurves(id: string): SketchEntity[] {
    return [...(this.store.find<SketchFeature>(id)?.entities ?? []), ...(this.result?.sketchBoundaries[id] ?? [])];
  }

  /**
   * The Stop button by the spinner: the engine drops what it's doing and the
   * change that started it is taken back (a live preview is cancelled; a
   * committed change is undone).
   */
  stopWork(): void {
    const running = this.kernel.running;
    const committed = !running || running === this.store.doc.features;
    this.kernel.stop();
    if (this.tool !== this.selectTool && !(this.tool instanceof SketchTool)) {
      this.setTool(null);
    }
    if (committed && this.store.canUndo) {
      this.store.undo();
    } else {
      void this.regenerate();
    }
    this.ui.toast('Stopped - the last change was taken back');
  }

  async preview(features: Feature[]): Promise<RegenResult | null> {
    const result = await this.kernel.regenerate(features);
    if (result) {
      this.scene.apply(result, features);
    }

    return result;
  }

  private docChanged(): void {
    setUnits(this.store.doc.units);
    setVariables(this.store.doc.variables);
    this.ui.refreshRight();
    this.showPins();
    this.view.setBodyColors(this.store.doc.colors ?? {}, this.store.doc.opacity ?? {});
    // New planes, sketches and names show in Items now, not once a long rebuild
    // has finished (a plane just made wasn't there to tap for seconds).
    this.items.render(this.result);
    // A change that leaves the model's steps as they were - a body renamed, coloured or hidden, a material, a joint,
    // an assembly's pose, a pin, a saved view - needs no model made again: what is shown is brought up to date from
    // the model there is. (Each of them went to the engine and back: a fifth of a second on a ten-step part.)
    const steps = JSON.stringify([this.store.doc.features, this.store.doc.variables]);
    // (Only the project's own model: one a tool is trying out is not the project's.)
    if (this.result && this.result === this.made && !this.regenerating && steps === this.madeFor) {
      return this.scene.apply(this.result, this.store.doc.features);
    }
    this.madeFor = steps;
    void this.regenerate();
  }

  /** The steps (and variables) the model on the screen was asked for, as text; and how many askings are under way. */
  private madeFor = '';
  private made: RegenResult | null = null;
  private regenerating = 0;

  /** The tags where the variables act on the model as it is now (Variables on). */
  showVariableTags(): void {
    if (this.varsOn && this.result) {
      this.varTags.set(variableTags(this.store.doc.variables, this.store.doc.features, this.result));
    }
  }

  /** The Variables button: on (tags and their card), or off. */
  toggleVariables(): void {
    if (this.varsOn) {
      return this.variablesOff();
    }
    this.varsOn = true;
    this.showVariableTags();
    this.varTags.setVisible(true);
    this.setTool(new VariablesTool(this));
  }

  /** The tags on or off, the card staying (its On switch). */
  showVariables(on: boolean): void {
    this.varsOn = on;
    if (on) {
      this.showVariableTags();
    }
    this.varTags.setVisible(on);
    this.refreshTools();
  }

  variablesOff(): void {
    this.varsOn = false;
    this.varTags.setVisible(false);
    if (this.tool instanceof VariablesTool) {
      this.setTool(null);
    }
    this.refreshTools();
  }

  private setUnits(units: Units): void {
    let kept = { changed: 0, lost: 0 };
    this.store.commit((draft) => {
      // Every formula keeps the size it had: its plain lengths now say the unit they were typed in.
      kept = keepSizes(draft, draft.units ?? 'mm', units);
      draft.units = units;
    });
    if (kept.lost) {
      this.ui.toast(`${kept.lost} formula${kept.lost === 1 ? '' : 's'} could not be kept as ${kept.lost === 1 ? 'it was' : 'they were'}: check the sizes that use ${kept.lost === 1 ? 'it' : 'them'}`, 'error');
    } else if (kept.changed) {
      this.ui.toast(`Nothing changes size: the plain numbers in ${kept.changed === 1 ? 'a formula' : `${kept.changed} formulas`} now say their unit`);
    }
  }

  async regenerate(): Promise<void> {
    const features = this.store.doc.features;
    this.regenerating++;
    let result: RegenResult | null = null;
    try {
      result = await this.kernel.regenerate(features, true);
    } finally {
      this.regenerating--;
    }
    if (result) {
      ((this.made = result), this.scene.apply(result, features));
    } else {
      // Not made - stopped, or overtaken: the next change asks again, whatever it is.
      this.madeFor = '';
    }
  }

  refreshHighlights(): void {
    this.view.setHighlights(this.selection, this.hover);
  }

  editStep(id: string): void {
    this.history.edit(id);
  }

  // ------------------------------------------------------------ menus

  firstShape(): boolean {
    return this.menus.firstShape();
  }

  mainTools(): ToolItem[] {
    return this.menus.mainTools();
  }

  bottomTools(): ToolItem[] {
    return this.menus.bottomTools();
  }

  fit(): void {
    this.view.fitAll();
  }

  undo(): void {
    this.undoing.undo();
  }

  redo(): void {
    this.undoing.redo();
  }

  refreshUndo(): void {
    this.undoing.update();
  }

  updateUndo(): void {
    this.undoing.update();
  }

  updates!: Updates;

  /** More → Update: asked first (it reloads the app), with the option to save a copy. */
  async confirmReset(): Promise<void> {
    const choice = await this.ui.ask(
      'Update?',
      'The app reloads with its newest version. Your project stays on this device - you can also save a copy to a file first.',
      [
        { id: 'reset', label: 'Yes, update' },
        { id: 'save', label: 'Save a copy & update', primary: true }
      ]
    );
    if (!choice) {
      return;
    }
    if (choice === 'save') {
      this.exporter.save();
      // Give the download a moment to start before the page reloads.
      await new Promise(resolve => setTimeout(resolve, 800));
    }
    await this.updates.reset();
  }
}
