import { Vector3 } from 'three';
import { FeatureOp, sketchesUsed } from './tools/featureOp';
import { BooleanOp } from './tools/booleanOp';
import { SelectTool } from './tools/select';
import { sectionPlane, SectionTool, type SectionState } from './tools/section';
import { FreeformTool } from './tools/freeform';
import { entityWorldPolylines } from './sketch/curves';
import { add, dist, scale, xDirFor } from './geom';
import { bodyCenter, AxisOp, ConnectOp, EdgeOp, ExtrudeOp, FillOp, FillToPlaneOp, ThreadOp, ImageOp, LoftOp, MidplaneOp, MoveFaceOp, PlaneOp, ReplaceFaceOp, ScaleFaceOp, ScaleOp, ScaleRefOp, RevolveOp, ShellOp, SplitOp, SweepOp, TransformOp } from './tools/ops';
import { faceFreeformTool } from './tools/faceFreeform';
import { OffsetEdgeOp } from './tools/offsetEdge';
import { ItemsPanel } from './ui/items';
import { openDrawing } from './bim/drawing';
import { openSheet } from './bim/sheet';
import { BimTool } from './bim/bimTool';
import { MeasureTool } from './tools/measure';
import { PinLayer } from './tools/annotate';
import { settings } from './settings';
import { KernelClient } from './kernel/client';
import { freeformBodies } from './doc/freeformCopies';
import { VariablesTool } from './tools/variablesTool';
import { VariableTags } from './tools/variableTags';
import { variableTags } from './doc/varAnchors';
import { numpadVariables } from './ui/numpad';
import { WebWindow } from './ui/webWindow';
import { RefImages } from './ui/refImages';
import { createVariable, insertFile, insertImage, acceptFor } from './io/insert';
import { editedStep } from './doc/freeformEdits';
import { emptyDoc } from './doc/types';
import { findAction, openCommandSearch, showShortcuts } from './ui/commands';
import { showAbout } from './ui/about';
import { showLibrary } from './ui/library';
import { currentProjectId, forgetProject, keepProject, libraryEntries, newProjectId, projectText, renameProject, setCurrentProject } from './doc/library';
import { SUPPORT, openSupport } from './ui/support';
import { DocStore, parseProject } from './doc/store';
import { ImprintOp, WrapOp } from './tools/wrapOps';
import { PlanesAxisOp, TwoPointAxisOp, surfaceAxis } from './tools/axisOps';
import { CurvePointPlaneOp, EdgeAnglePlaneOp, FacePointPlaneOp, ThreePointPlaneOp } from './tools/planeOps';
import { circleAxis } from './tools/slots';
import { isTouchDevice } from './device';
import { SketchTool, sketchSides, sketchVariant } from './tools/sketch';
import { Tutorial, type TutorialHost } from './ui/tutorial';
import { AssemblyTool } from './assembly/assemblyTool';
import { definedCurves } from './sketch/constraints';
import { keepSizes } from './doc/unitChange';
import { bodiesOf, edgeRefOf, edgesOfFace, faceRefOf, sameSel, sourceFrame, sourcesOf, type AppContext, type Sel, type Tool } from './tools/tool';
import { setupRightColumn } from './ui/panels';
import { el, UI } from './ui/ui';
import { Sentence } from './ui/sentence';
import { Ghost } from './tools/ghost';
import { arrangement, drawnRegions, materialRegions } from './sketch/regions';
import { evaluate, setUnits, setVariables, fmtLen } from './units';
import { InputRouter } from './view/input';
import { pickTolerance } from './device';
import { ViewCube } from './view/viewcube';
import { PivotButton } from './ui/pivot';
import { HelpPanel } from './ui/help';
import { icons } from './ui/icons';
import { Updates } from './ui/update';
import { Offline } from './ui/offline';
import { Install } from './ui/install';
import { Exporter, canShareType, download } from './app/exporting';
import { isHeadset, screenClass } from './device';
import { Viewport } from './view/viewport';
import { VRMode, vrSupported } from './view/xr';
import type { ToolItem } from './ui/ui';
import type { RegenResult } from './kernel/protocol';
import type { EdgeFeature, EdgeRef, ExtrudeFeature, ExtrudeSource, Feature, FillToPlaneFeature, ImageFeature, LoftFeature, PathRef, PinDef, PlaneDef, PlaneFeature, ProjectDoc, RevolveFeature, ShellFeature, SketchEntity, SketchFeature, SplitFeature, SweepFeature, TransformFeature, Units, Vec3 } from './doc/types';

/** The page's own title, from index.html (it names the app for search results). */
const PAGE_TITLE = document.title;


export class App implements AppContext {
  readonly store = new DocStore();
  readonly kernel = new KernelClient();
  readonly view: Viewport;
  readonly ui = new UI();
  private readonly exporter = new Exporter(this);
  /** The sentence bar: the pick, then what it offers, on one line - the way to the tools. */
  sentence!: Sentence;
  /** The look ahead a tool under the pointer is showing on the model (see ghost.ts). */
  private peekGhost: Ghost | null = null;
  /** Where the view was last tapped (the sentence bar starts a sketch tool that acts where it is tapped right there). */
  private lastTapAt: { x: number; y: number; type: 'mouse' | 'pen' | 'touch' } | null = null;
  /** Pictures to look at while modelling, each in a window over the model (under the buttons). */
  readonly refImages = new RefImages((text, kind) => this.ui.toast(text, kind));
  readonly web = new WebWindow();
  private input: InputRouter;
  result: RegenResult | null = null;
  selection: Sel[] = [];
  section: SectionState | null = null;
  isolated: string[] | null = null;
  /** Variables switched on: their tags in the view. */
  varsOn = false;
  private varTags!: VariableTags;
  private hover: Sel | null = null;
  private selectTool: SelectTool;
  /** The headset mode (its pictures can be checked on the page: vr.snapshot). */
  vr: VRMode | null = null;
  tool: Tool;
  /** The tutorial begun (More > Tutorial, and the welcome window's button). */
  private startTutorial: () => void = () => {};
  /** The tutorial (for the debug handle: a test steps it by hand where the browser draws seldom). */
  tutorial: Tutorial | null = null;
  private shownErrors = '';
  private pinLayer: PinLayer;
  items: ItemsPanel;

  constructor(canvas: HTMLCanvasElement) {
    this.view = new Viewport(canvas);
    this.input = new InputRouter(this.view);
    this.selectTool = new SelectTool(this);
    this.tool = this.selectTool;
    this.input.handler = this.tool;
    this.sentence = new Sentence({
      ui: this.ui,
      view: this.view,
      mainTools: () => this.mainTools(),
      selection: () => this.selection,
      mode: () => (this.tool === this.selectTool ? 'model' : this.tool instanceof SketchTool ? 'sketch' : this.tool instanceof FreeformTool ? 'freeform' : 'tool'),
      sketchPicked: () => (this.tool instanceof SketchTool ? this.tool.pickedCount : 0),
      waiting: () => (this.tool === this.selectTool ? this.selectTool.waiting : null),
      peek: (segs) => {
        this.peekGhost?.dispose();
        this.peekGhost = segs ? new Ghost(this.view, segs) : null;
      },
      pick: sel => this.setSelection(sel),
      adding: () => this.selectTool.adding,
      setAdding: on => ((this.selectTool.adding = on), this.sentence.changed()),
      stopWaiting: () => this.selectTool.stopWaiting(),
      anchor: () => this.pickAnchor(),
      retap: () => {
        const lastTapAt = this.lastTapAt;
        if (lastTapAt) {
          this.tool.tap?.({ x: lastTapAt.x, y: lastTapAt.y, type: lastTapAt.type, shift: false, tol: pickTolerance(lastTapAt.type) }, 1);
        }
      }
    });
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
    // A spinner while the geometry engine works on something that takes a moment.
    const busy = document.createElement('div');
    busy.id = 'busy';
    busy.hidden = true;
    busy.innerHTML = '<span class="spinner"></span><span>Working…</span><button type="button" class="busy-stop" title="Stop - takes back the last change">Stop</button>';
    document.body.append(busy);
    busy.querySelector('.busy-stop')!.addEventListener('click', () => this.stopWork());
    let busyTimer = 0;
    let busyWatch = 0;
    this.kernel.onBusy = (on) => {
      clearTimeout(busyTimer);
      clearInterval(busyWatch);
      // Only for waits you would notice (not every quick preview while dragging).
      if (on) {
        busyTimer = window.setTimeout(() => {
          if (!this.kernel.busy) {
            return;
          }
          busy.hidden = false;
          // Shown only while there is work: looked at again as it stands, so it can never stay up over nothing
          // (asked for: "sometimes the working icon still is showing even if there's nothing to work on").
          busyWatch = window.setInterval(() => {
            if (this.kernel.busy) {
              return;
            }
            busy.hidden = true;
            clearInterval(busyWatch);
          }, 400);
        }, 300);
      } else {
        busy.hidden = true;
      }
    };
    this.kernel.onLost = () => {
      this.ui.toast('The geometry engine stopped and was started again - the last change may need doing again', 'error');
      void this.regenerate();
    };
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
    // VR only in a headset's own browser (never on a computer, headset connected or not). A viewer: the model as a real thing in your room.
    // On a phone or tablet it's AR: the model in the room through the camera.
    const handheld = isTouchDevice && !isHeadset;
    const vr: VRMode = (this.vr = new VRMode({
      renderer: this.view.renderer,
      handheld,
      scene: this.view.scene,
      bounds: () => this.view.modelBounds(),
      xray: () => {
        const on = settings.value.shader !== 'xray';
        settings.set('shader', on ? 'xray' : 'shaded');

        return on ? 'X-Ray' : 'Shaded';
      },
      edges: () => {
        const on = !settings.value.showEdges;
        settings.set('showEdges', on);

        return on ? 'Edges shown' : 'Edges hidden';
      },
      looks: () => ({ xray: settings.value.shader === 'xray' ? 'Shaded' : 'X-Ray', edges: settings.value.showEdges ? 'Hide Edges' : 'Show Edges' }),
      beforeFrame: () => this.view.xrFrame(),
      onEnter: () => {
        this.setTool(null);
        this.setSelection([]);
        this.view.xrMode(true);
      },
      onExit: () => this.view.xrMode(false)
    }));
    // In the top bar, where it's seen, in a headset; under More on a phone or tablet (when its browser can show AR); never on a computer.
    const vrBtn = document.getElementById('vr-btn')!;
    if (handheld) {
      vrBtn.textContent = 'Enter AR';
      vrBtn.title = 'See the model in your room through the camera';
      // A phone or tablet: under More (History has its place in the top bar).
      vrBtn.className = '';
      vrBtn.addEventListener('click', () => (document.getElementById('more-menu')!.hidden = true));
      document.getElementById('more-menu')!.prepend(vrBtn);
    }
    const checkVR = () => void vrSupported(handheld).then(ok => (vrBtn.hidden = !isHeadset && !(handheld && ok)));
    if (isTouchDevice) {
      checkVR();
      (navigator as Navigator & { xr?: EventTarget }).xr?.addEventListener('devicechange', checkVR);
    } else {
      vrBtn.remove();
    }
    vrBtn.addEventListener('click', async () => {
      if (!(await vrSupported(handheld))) {
        return this.ui.toast(handheld ? "This browser can't show AR - try Chrome" : "This browser can't open VR here - open superGeometry.app in the headset's own browser");
      }
      vr.enter().catch((e: unknown) => this.ui.toast(`${handheld ? 'AR' : 'VR'} didn't start: ${e instanceof Error ? e.message : e}`));
    });
    this.pinLayer = new PinLayer(this.view);
    this.varTags = new VariableTags(this.view, {
      variables: () => this.store.doc.variables,
      check: (name, expr, kind) => {
        const list = this.store.doc.variables;
        setVariables(list.map(variable => (variable.name === name ? { name, expr } : variable)));
        try {
          return evaluate(expr, 'number') === null ? null : evaluate(name, kind);
        } finally {
          setVariables(list);
        }
      },
      setVariable: (name, expr) => {
        const list = this.store.doc.variables;
        const next = list.map(variable => (variable.name === name ? { name, expr } : variable));
        setVariables(next);
        const bad = next.some(variable => evaluate(variable.expr) === null);
        setVariables(list);
        if (bad) {
          return false;
        }
        if (list.find(variable => variable.name === name)?.expr !== expr) {
          this.store.commit(draft => (draft.variables = next));
        }

        return true;
      }
    });
    // ƒx buttons on number fields create named variables.
    this.ui.variableFactory = current => createVariable(this, current);
    this.ui.variableNames = () => this.store.doc.variables.map(variable => variable.name);
    numpadVariables({ names: () => this.store.doc.variables.map(variable => variable.name), create: value => createVariable(this, value) });
    settings.onChange(() => this.showPins());
    this.items = new ItemsPanel(this.store, {
      // A phone: like taps in the view, each body tapped in Items joins the
      // selection (tapped again, it leaves) - Subtract needs two bodies, and
      // the second one replaced the first.
      selectBody: (id) => {
        if (this.tool === this.selectTool && this.selectTool.pickFromList({ kind: 'body', body: id })) {
          return;
        }
        // A pattern (mirror, move…) under way: the body joins it, or leaves it.
        // (After the first body the view's taps go to its direction: four
        // pockets to pattern across could only be had by starting again.)
        if (this.tool instanceof TransformOp && this.tool.toggleBody(id)) {
          return;
        }
        // Subtract, Shell… waiting for a body: it takes this one.
        if (this.tool instanceof FeatureOp && this.tool.pickBody(id)) {
          return;
        }
        this.togglePick({ kind: 'body', body: id });
      },
      editSketch: id => this.setTool(new SketchTool(this, { sketchId: id })),
      selectPlane: id => this.togglePick({ kind: 'plane', id }),
      deleteBody: id => this.store.add({ ...this.store.newIdentity('delete'), type: 'delete', bodies: [id] }),
      deleteFeature: id => this.store.remove(id),
      selectImage: id => this.togglePick({ kind: 'image', id }),
      rename: async (id, current, isBody) => {
        const answers = await this.ui.dialog('Rename', [{ key: 'name', label: 'Name', value: current }]);
        const name = answers?.name.trim();
        if (!name) {
          return;
        }
        if (isBody) {
          this.store.commit(draft => (draft.names = { ...(draft.names ?? {}), [id]: name }));
        } else {
          this.store.update(id, { name });
        }
      },
      askName: async (title, current) => (await this.ui.dialog(title, [{ key: 'name', label: 'Name', value: current }]))?.name.trim() || null,
      isolated: () => this.isolatedWithSketches()
    });
    // Computers and tablets start with Items open (phones: History only, there's no room for both).
    // (A phone on its side is wider than 720 px but only ~375 tall: Items would cover a third of it.)
    if (screenClass() !== 'phone') {
      this.items.toggle(true);
    }

    this.store.onChange(() => this.docChanged());
    window.addEventListener('keydown', e => this.onKey(e));
    this.view.canvas.addEventListener('pointermove', (e) => {
      const rect = this.view.canvas.getBoundingClientRect();
      this.pointerAt = [e.clientX - rect.left, e.clientY - rect.top];
    });
    this.view.canvas.addEventListener('pointerleave', () => (this.pointerAt = null));
    // A phone may drop the page once it's in the background: save now, undo steps included.
    document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && void this.store.flush());
    window.addEventListener('pagehide', () => void this.store.flush());
    this.wireTopbar();
    this.tool.enter?.();

    this.ui.setStatus('Loading geometry kernel…');
    const loaded = this.store.load().then(() => this.attachLibrary());
    // Every visit starts at the projects, with a welcome: shown as soon as the
    // projects are read, while the geometry kernel is still loading behind it.
    void loaded.then(() => this.showProjects(true, true));
    Promise.all([this.kernel.ready, loaded])
      .then(async () => {
        this.ui.setStatus(null);
        await this.regenerate();
        this.view.fitAll(false);
        // A project never pictured (kept before it was ever drawn) showed a
        // blank shape on its card: now that it's drawn, it gets its picture -
        // in the welcome window too, if that's still open.
        const entry = (await libraryEntries()).find(e => e.id === this.projectId);
        if (entry && !entry.thumb && this.store.features.length) {
          await this.keepInLibrary(JSON.stringify(this.store.doc), true);
          const thumb = (await libraryEntries()).find(e => e.id === this.projectId)?.thumb;
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
  private showPose(): void {
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

  /**
   * Print / Share: is the model fit to print (each body closed, no hair-thin
   * faces, one piece), and the files to take it away as. (Export was only in
   * File, under names a first-timer does not know.)
   */
  async printShare(): Promise<void> {
    const back = document.createElement('div');
    back.className = 'dialog-back';
    const box = document.createElement('div');
    box.className = 'dialog print-share';
    const head = document.createElement('div');
    head.className = 'library-head';
    const title = document.createElement('div');
    title.className = 'panel-title';
    title.textContent = 'Print / Share';
    const x = document.createElement('button');
    x.className = 'icon-btn library-close';
    x.title = 'Close';
    x.innerHTML = icons.close;
    const close = () => back.remove();
    x.addEventListener('click', close);
    head.append(title, x);
    const check = document.createElement('div');
    check.className = 'print-check';
    check.textContent = 'Checking the model…';
    const row = document.createElement('div');
    row.className = 'print-files';
    const file = (label: string, note: string, run: () => void) => {
      const b = document.createElement('button');
      b.className = 'text-btn print-file';
      b.type = 'button';
      const element = document.createElement('b');
      element.textContent = label;
      const span = document.createElement('span');
      span.textContent = note;
      b.append(element, span);
      b.addEventListener('click', () => (close(), run()));
      row.append(b);
    };
    file('3MF', 'For 3D printing (keeps sizes and colours)', () => void this.exporter.export3mf());
    file('STL', 'For 3D printing (every slicer opens it)', () => void this.exporter.export('stl'));
    file('STEP', 'For other CAD programs', () => void this.exporter.export('step'));
    file('Picture', 'A PNG of the view as it is now', () => this.ui.runRight('shot'));
    box.append(head, check, row);
    back.append(box);
    back.addEventListener('pointerdown', e => e.target === back && close());
    box.addEventListener('keydown', e => e.key === 'Escape' && close());
    document.body.append(back);
    try {
      const health = await this.kernel.health(this.store.doc.features);
      if (!back.isConnected) {
        return;
      }
      const hidden = new Set(this.store.doc.hidden ?? []);
      const bodies = health.filter(bodyHealth => !hidden.has(bodyHealth.id));
      const bad = bodies.filter(body => !body.healthy);
      check.replaceChildren();
      const line = (text: string, ok: boolean) => {
        const element = document.createElement('div');
        element.className = ok ? 'print-ok' : 'print-warn';
        element.textContent = text;
        check.append(element);
      };
      if (!bodies.length) {
        line('Nothing to print yet: there is no solid body.', false);
      } else if (!bad.length) {
        line(bodies.length === 1 ? 'Ready to print: the body is closed and solid.' : `Ready to print: all ${bodies.length} bodies are closed and solid.`, true);
      }
      for (const bodyHealth of bad) {
        const why = [bodyHealth.openEdges ? 'it is not closed (open edges)' : '', bodyHealth.thin ? 'it has hair-thin faces' : '', bodyHealth.pinched ? 'parts of it only touch along an edge' : '', bodyHealth.solids > 1 ? `it is ${bodyHealth.solids} separate pieces` : '', !bodyHealth.valid ? 'its shape has a fault' : ''].filter(Boolean);
        line(`${bodyHealth.name}: ${why.join(', ') || 'it may not print as it is'}. Modify, Fix, Repair Body may mend it.`, false);
      }
      if (bodies.length) {
        const lo = [Infinity, Infinity, Infinity];
        const hi = [-Infinity, -Infinity, -Infinity];
        for (const body of bodies) {
          for (let axis = 0; axis < 3; axis++) {
            ((lo[axis] = Math.min(lo[axis], body.box[0][axis])), (hi[axis] = Math.max(hi[axis], body.box[1][axis])));
          }
        }
        line(`Size: ${[0, 1, 2].map(axis => fmtLen(hi[axis] - lo[axis], 1)).join(' x ')}`, true);
      }
    } catch {
      if (back.isConnected) {
        check.textContent = 'The model could not be checked. The files can still be saved.';
      }
    }
  }

  /** Where the last thing picked is on the model (the sentence bar's thread runs to it). */
  private pickAnchor(): Vec3 | null {
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
      this.refreshSketches();
    }
    this.renderHistory();
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
  private lastSection: SectionState | null = null;

  /**
   * Section View button: on → off (remembered); off → the remembered section,
   * or a new one - straight from a selected flat face if there is one.
   */
  private toggleSection(): void {
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

  /** Thread the selected round face (a shank or a hole). */
  startThread(): void {
    let highlight = this.selection[0];
    // A round edge (a hole's rim): the round face of the same radius it bounds.
    if (highlight?.kind === 'edge') {
      const body = this.view.body(highlight.body);
      const e = body?.edges[highlight.edge];
      if (body && e?.type === 'CIRCLE') {
        const center = scale(add(e.start, e.mid), 0.5);
        const radius = dist(e.start, e.mid) / 2;
        let best = -1;
        let bestD = Infinity;
        body.faces.forEach((face, i) => {
          if (!face.round || Math.abs(face.round.r - radius) > radius * 1e-4) {
            return;
          }
          const distance = dist(face.center, center);
          if (distance < bestD) {
            (bestD = distance), (best = i);
          }
        });
        if (best >= 0) {
          highlight = { kind: 'face', body: highlight.body, face: best };
        }
      }
    }
    // Any other edge (a revolved shank's seam runs right along its top): the
    // round face under the finger.
    const at = this.selectTool.tapPoint;
    if (highlight?.kind === 'edge' && at) {
      const body = highlight.body;
      const under = this.view.facesAt(at.x, at.y).find(face => face.kind === 'face' && face.body === body && this.view.body(body)?.faces[face.face]?.round);
      if (under?.kind === 'face') {
        highlight = { kind: 'face', body, face: under.face };
      }
    }
    if (highlight?.kind !== 'face') {
      return void this.ui.toast('Threads go on round faces: tap a shank or a hole');
    }
    const info = this.view.body(highlight.body)?.faces[highlight.face];
    const ref = faceRefOf(this, highlight);
    if (!info?.round || !ref) {
      return void this.ui.toast('Threads go on round faces: tap a shank or a hole');
    }
    this.setSelection([highlight]);
    this.setTool(new ThreadOp(this, ref, info.round));
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
  private known: Set<string> | null = null;

  revealInItems(ids: string[]): void {
    this.items.reveal(ids);
  }

  /** A pick from the Items list: it joins what's picked (picked already: it leaves), as taps in the view do. */
  private togglePick(highlight: Sel): void {
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
    this.refreshConstruction();
    this.refreshSketches();
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
  private applyVisibility(): void {
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
  private stopWork(): void {
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
      this.apply(result, features);
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
      return this.apply(this.result, this.store.doc.features);
    }
    this.madeFor = steps;
    void this.regenerate();
  }

  /** The steps (and variables) the model on the screen was asked for, as text; and how many askings are under way. */
  private madeFor = '';
  private made: RegenResult | null = null;
  private regenerating = 0;

  /** The tags where the variables act on the model as it is now (Variables on). */
  private showVariableTags(): void {
    if (this.varsOn && this.result) {
      this.varTags.set(variableTags(this.store.doc.variables, this.store.doc.features, this.result));
    }
  }

  /** The Variables button: on (tags and their card), or off. */
  private toggleVariables(): void {
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

  private async regenerate(): Promise<void> {
    const features = this.store.doc.features;
    this.regenerating++;
    let result: RegenResult | null = null;
    try {
      result = await this.kernel.regenerate(features, true);
    } finally {
      this.regenerating--;
    }
    if (result) {
      ((this.made = result), this.apply(result, features));
    }
    // (Not made - stopped, or overtaken: the next change asks again, whatever it is.)
    else {
      this.madeFor = '';
    }
  }

  /** Sketches the engine moved the curves of (they follow a body): those curves, by the sketch as it was sent. */
  private solved = new WeakMap<Feature, SketchEntity[]>();

  private apply(result: RegenResult, features: readonly Feature[]): void {
    this.result = result;
    this.solved = new WeakMap();
    if (result.sketchEntities) {
      const moved = result.sketchEntities;
      for (const feature of features) {
        if (moved[feature.id]) {
          this.solved.set(feature, moved[feature.id]);
        }
      }
      // The project as it is (not a preview of a change): they are the sketch's curves from now on.
      if (features === this.store.doc.features) {
        this.store.adopt((draft) => {
          for (const feature of draft.features) {
            if (feature.type === 'sketch' && moved[feature.id]) {
              feature.entities = moved[feature.id];
            }
          }
        });
        features = this.store.doc.features;
      }
    }
    // Which patterns a step used whole, as it was made: kept with it (they stay whole when a count changes).
    if (result.whole && features === this.store.doc.features) {
      const whole = result.whole;
      this.store.adopt((draft) => {
        for (const feature of draft.features) {
          if ((feature.type === 'boolean' || feature.type === 'delete') && whole[feature.id] && !feature.whole) {
            feature.whole = whole[feature.id];
          }
        }
      });
      features = this.store.doc.features;
    }
    const now = new Set([...result.bodies.map(b => b.id), ...features.map(feature => feature.id)]);
    if (this.isolated) {
      // Made while isolating (a copy, a new sketch or plane): it belongs with what's shown.
      if (this.known) {
        for (const id of now) {
          if (!this.known.has(id)) {
            this.isolated.push(id);
          }
        }
      }
      this.isolated = this.isolated.filter(id => now.has(id));
      if (!this.isolated.some(id => result.bodies.some(b => b.id === id))) {
        this.isolated = null;
      }
    }
    this.known = now;
    this.view.setBodies(result.bodies);
    this.applyVisibility();
    this.refreshConstruction(features);
    this.refreshSketches(features);
    // Drop selections that point at geometry that no longer exists.
    this.selection = this.selection.filter((highlight) => {
      if (highlight.kind === 'profile' || highlight.kind === 'curve' || highlight.kind === 'point') {
        return !!this.store.find(highlight.sketch) || features.some(feature => feature.id === highlight.sketch);
      }
      if (highlight.kind === 'plane' || highlight.kind === 'axis') {
        return !!this.view.planeOf(highlight.id) || !!this.view.axisOf(highlight.id);
      }
      if (highlight.kind === 'image') {
        return features.some(feature => feature.id === highlight.id);
      }
      if (highlight.kind === 'origin') {
        return true;
      }
      const b = this.view.body(highlight.body);
      if (!b) {
        return false;
      }
      if (highlight.kind === 'face') {
        return highlight.face < b.faces.length;
      }
      if (highlight.kind === 'edge') {
        return highlight.edge < b.edges.length;
      }
      if (highlight.kind === 'vertex') {
        return !!this.view.vertexOf(highlight.body, highlight.vertex);
      }

      return true;
    });
    this.refreshHighlights();
    // (Once: the selection tool's own refresh was run a second time after this.)
    this.tool.refresh?.();
    this.showPose();
    this.renderHistory();
    this.items.render(result);
    this.showVariableTags();
    const open = this.openBodies(result);
    this.ui.setWarning(
      open.length
        ? `⚠ ${open.length === 1 ? (this.store.doc.names?.[open[0].id] ?? open[0].name) : `${open.length} bodies`} not closed - ${open.reduce((total, b) => total + b.openEdges.length, 0)} open edge(s) shown in orange`
        : this.store.problems[0]
          ? `⚠ ${this.store.problems[0]}`
          : null
    );
    // (Steps of the project only: one being tried - a Delete Face its
    // neighbours can't close - isn't in History, and says why itself.)
    const ids = new Set(this.store.features.map(feature => feature.id));
    const failed = result.errors.filter(e => ids.has(e.featureId));
    const errs = failed.map(e => e.featureId + e.message).join();
    if (errs && errs !== this.shownErrors && this.tool === this.selectTool) {
      this.ui.toast(`${failed.length} step${failed.length > 1 ? 's' : ''} failed to rebuild - see History`, 'error');
    }
    this.shownErrors = errs;
  }

  private refreshConstruction(features: readonly Feature[] = this.store.doc.features): void {
    const result = this.result;
    if (!result) {
      return;
    }
    const hidden = new Set(this.store.doc.hidden);
    // Isolating: only what's isolated (or was made since) shows.
    const shown = (id: string) => !hidden.has(id) && (!this.isolated || this.isolated.includes(id));
    this.view.setConstruction(result.planes.filter(plane => shown(plane.id)), result.axes.filter(a => shown(a.id)));
    this.view.setImages(features.filter((feature): feature is ImageFeature => feature.type === 'image' && !feature.suppressed && !feature.rolledBack && shown(feature.id)));
  }

  /** The sketch being edited: which curves its constraints hold completely (worked out once per change). */
  private definedCache: { entities: unknown; constraints: unknown; defined: Set<string> | undefined; all: boolean } | null = null;

  private definedOf(sketch: SketchFeature): Set<string> | undefined {
    const definedCache = this.definedCache;
    if (definedCache && definedCache.entities === sketch.entities && definedCache.constraints === sketch.constraints) {
      return definedCache.defined;
    }
    const defined = definedCurves(sketch.entities, sketch.constraints ?? []);
    const all = !!defined?.all && sketch.entities.some(e => !e.construction);
    // Just became fully defined: say so (the curves have turned green).
    if (all && definedCache && !definedCache.all) {
      this.ui.toast('Sketch fully defined');
    }
    this.definedCache = { entities: sketch.entities, constraints: sketch.constraints, defined: defined?.defined, all };

    return defined?.defined;
  }

  /** Sketches hidden (after use) that were shown again: meant to be used again, so tappable through bodies. */
  private revealed = new Set<string>();
  private wasHidden = new Set<string>();

  private refreshSketches(features: readonly Feature[] = this.store.doc.features): void {
    const hidden = new Set(this.store.doc.hidden);
    for (const id of this.wasHidden) {
      if (!hidden.has(id)) {
        this.revealed.add(id);
      }
    }
    for (const id of hidden) {
      this.revealed.delete(id);
    }
    this.wasHidden = hidden;
    const iso = this.isolatedWithSketches();
    const sketches = features
      .filter((feature): feature is SketchFeature => feature.type === 'sketch' && !feature.suppressed && !feature.rolledBack && ((!hidden.has(feature.id) && (!iso || iso.includes(feature.id))) || feature.id === this.tool.activeSketch))
      .map(feature => ({ ...feature, entities: this.solved.get(feature) ?? feature.entities, plane: this.result?.sketchPlanes[feature.id] ?? feature.plane, boundary: this.result?.sketchBoundaries[feature.id] }))
      .map(sketch => (sketch.id === this.tool.activeSketch ? { ...sketch, defined: this.definedOf(sketch) } : sketch));
    // Drawn but not made into anything yet: shown through bodies, and a tap on it finds it there
    // (a pocket sketched on a plane through the middle of a body is inside it). The same
    // for one used, hidden, and shown again in Items: the pocket's sketch shown to fill
    // the pocket with a core couldn't be tapped through the frame round it.
    const used = new Set(features.filter(feature => !feature.suppressed && !feature.rolledBack).flatMap(sketchesUsed));
    this.view.setSketches(sketches, this.tool.activeSketch, new Set(sketches.filter(sketch => !used.has(sketch.id) || this.revealed.has(sketch.id)).map(sketch => sketch.id)));
  }

  private refreshHighlights(): void {
    this.view.setHighlights(this.selection, this.hover);
  }

  // ------------------------------------------------------------ history

  /**
   * Bodies with open edges - except freeform surfaces that are meant to be
   * open sheets (not thickened): those aren't a problem.
   */
  private openBodies(result: RegenResult | null) {
    return (result?.bodies ?? []).filter((b) => {
      if (!b.openEdges?.length) {
        return false;
      }
      // A surface on purpose (or a copy of one) isn't meant to be closed.
      const feature = this.store.find(b.id);
      const ff = feature?.type === 'freeform' ? editedStep<typeof feature>(this.store.features, feature.id) : freeformBodies(this.store.features).get(b.id)?.feature;

      return !(ff?.surface && !ff.thickness);
    });
  }

  /** What the History rows were last made from (everything a row shows). */
  private historyShown = '';

  private renderHistory(): void {
    const warnings = new Map<string, string>();
    for (const b of this.openBodies(this.result)) {
      warnings.set(b.id.split(':')[0], `${b.name}: not closed - ${b.openEdges.length} open edge(s)`);
    }
    for (const featureError of this.result?.notes ?? []) {
      warnings.set(featureError.featureId, warnings.has(featureError.featureId) ? `${warnings.get(featureError.featureId)} ${featureError.message}` : featureError.message);
    }
    // The same rows as are there: left as they are (every step of a drag's
    // preview rebuilt the whole list - 5 ms for 200 steps, far more on a phone).
    const doc = this.store.doc;
    const shown = JSON.stringify([
      doc.features.map(feature => [feature.id, feature.name, feature.type, feature.suppressed ? 1 : 0, feature.rolledBack ? 1 : 0, feature.type === 'sketch' ? (feature.log ?? 0) : 0]),
      this.result?.errors ?? [],
      this.tool.editingId ?? this.tool.activeSketch ?? null,
      [...warnings],
      doc.hidden,
      doc.historyGroups ?? []
    ]);
    if (shown === this.historyShown) {
      return;
    }
    this.historyShown = shown;
    // The rows are rebuilt: a hover on an old row is over.
    this.view.setStepHover(null);
    this.ui.renderHistory(this.store.doc.features, this.result?.errors ?? [], this.tool.editingId ?? this.tool.activeSketch ?? null, {
      edit: (id, pick) => this.editFeature(id, pick),
      hover: id => this.view.setStepHover(id ? this.stepTargets(id) : null),
      toggle: (id) => {
        const feature = this.store.find(id);
        if (feature) {
          this.store.update(id, { suppressed: !feature.suppressed });
        }
      },
      isHidden: id => this.store.doc.hidden.includes(id),
      toggleHidden: id => this.store.commit(draft => (draft.hidden = draft.hidden.includes(id) ? draft.hidden.filter(hiddenId => hiddenId !== id) : [...draft.hidden, id])),
      remove: (id) => {
        if (this.tool !== this.selectTool) {
          this.setTool(null);
        }
        this.store.remove(id);
      },
      groups: this.store.doc.historyGroups ?? [],
      setGroups: next => this.store.commit(draft => (draft.historyGroups = next.length ? next : undefined)),
      suppress: (ids, off) =>
        this.store.commit((draft) => {
          for (const feature of draft.features) {
            if (ids.includes(feature.id)) {
              feature.suppressed = off || undefined;
            }
          }
        }),
      askName: async (title, current) => (await this.ui.dialog(title, [{ key: 'name', label: 'Name', value: current }]))?.name.trim() || null,
      breakAfter: id => this.breakAfter(id),
      merge: () => void this.mergeHistory()
    }, warnings);
  }

  /**
   * The History's breakpoint: the steps after `id` off (the model as it was
   * there) until it's removed (null). New steps go in at the breakpoint.
   */
  private breakAfter(id: string | null): void {
    if (this.tool !== this.selectTool) {
      this.setTool(null);
    }
    const at = id ? this.store.features.findIndex(feature => feature.id === id) : Infinity;
    const later = id ? this.store.features.length - 1 - at : 0;
    if (id && !later) {
      return void this.ui.toast("It's the last step - there's nothing after it to roll back");
    }
    this.store.commit((draft) => {
      draft.features.forEach((feature, i) => {
        if (i > at) {
          feature.rolledBack = true;
        } else {
          delete feature.rolledBack;
        }
      });
    });
    this.ui.toast(id ? `Rolled back to here: ${later} later step${later === 1 ? '' : 's'} off until you remove the breakpoint` : 'Breakpoint removed: every step is on again');
  }

  /**
   * Merge: the history flattened into the bodies as they are now (each kept
   * as its exact shape, its name, colour and material kept). Sketches and
   * variables can stay; every other step goes. Undo takes it back.
   */
  private async mergeHistory(): Promise<void> {
    const bodies = this.view.bodyList;
    if (!bodies.length) {
      return void this.ui.toast('There are no bodies yet - nothing to merge into');
    }
    const off = this.store.features.filter(feature => feature.rolledBack || feature.suppressed).length;
    const answers = await this.ui.dialog(
      'Merge history',
      [
        { key: 'sketches', label: 'Keep the sketches', value: '1', check: true },
        { key: 'variables', label: 'Keep the variables', value: '1', check: true }
      ],
      `Every step becomes the bodies as they are now: they can't be edited by their steps any more.${off ? ` The ${off} step${off === 1 ? '' : 's'} switched off or after the breakpoint go too.` : ''} Undo takes it back.`
    );
    if (!answers) {
      return;
    }
    if (this.tool !== this.selectTool) {
      this.setTool(null);
    }
    const features = this.store.doc.features.filter(feature => !feature.rolledBack);
    const made: Feature[] = [];
    const renamed = new Map<string, string>();
    for (const b of bodies) {
      const blob = await this.kernel.export(features, 'step', [b.id]);
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let bin = '';
      for (let i = 0; i < bytes.length; i += 0x8000) {
        bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      }
      // The body keeps its id where it can be a step's (names, colours, folders stay with it).
      const id = /^[\w-]+$/.test(b.id) && !made.some(feature => feature.id === b.id) ? b.id : this.store.newIdentity('import').id;
      if (id !== b.id) {
        renamed.set(b.id, id);
      }
      const name = this.store.doc.names[b.id] ?? b.name;
      made.push({ id, name, type: 'import', format: 'step', fileName: `${name}.step`, data: btoa(bin) });
    }
    const keepSketches = !!answers.sketches;
    const keepVars = !!answers.variables;
    this.store.commit((draft) => {
      const sketches = keepSketches
        ? draft.features.flatMap((feature): Feature[] => {
          if (feature.type !== 'sketch' || feature.rolledBack) {
            return [];
          }
          // Nothing left to follow: a merged body has no steps to point at.
          const sketch: SketchFeature = { ...feature, attachedTo: undefined, outlineOffsets: undefined, links: undefined };
          sketch.constraints = sketch.constraints?.filter(constraint => !/"(ref|lnk)-/.test(JSON.stringify(constraint)));
          if (!keepVars) {
            delete sketch.exprs;
          }

          return [sketch];
        })
        : [];
      draft.features = [...made, ...sketches];
      if (!keepVars) {
        draft.variables = [];
      }
      draft.historyGroups = undefined;
      const re = (id: string) => renamed.get(id) ?? id;
      const reKeys = <T>(record: Record<string, T> | undefined) => (record ? Object.fromEntries(Object.entries(record).map(([key, x]) => [re(key), x])) : record);
      draft.names = reKeys(draft.names)!;
      draft.colors = reKeys(draft.colors);
      draft.opacity = reKeys(draft.opacity);
      draft.materials = reKeys(draft.materials);
      draft.hidden = draft.hidden.map(re);
      draft.folders = draft.folders?.map(folder => ({ ...folder, items: folder.items.map(re) }));
    });
    this.ui.toast(`History merged: ${made.length} bod${made.length === 1 ? 'y' : 'ies'}${keepSketches ? ', the sketches kept' : ''}`);
  }

  /** What a History step works on: its bodies (made or changed), sketches, and the edges it names. */
  private stepTargets(id: string): { bodies: string[]; lines: Vec3[][] } {
    const feature = this.store.find(id);
    const bodies = new Set<string>();
    const sketches = new Set<string>();
    const edges: [Vec3, Vec3][] = [];
    if (!feature) {
      return { bodies: [], lines: [] };
    }
    if (feature.type === 'sketch') {
      sketches.add(feature.id);
    }
    // Bodies this step made (its own id, or copies "id:…").
    for (const b of this.result?.bodies ?? []) {
      if (b.id === feature.id || b.id.startsWith(`${feature.id}:`)) {
        bodies.add(b.id);
      }
    }
    const walk = (value: unknown, key = ''): void => {
      if (Array.isArray(value)) {
        return value.forEach(item => walk(item, key));
      }
      if (!value || typeof value !== 'object') {
        if (typeof value === 'string' && (key === 'body' || key === 'bodies' || key === 'target')) {
          bodies.add(value);
        }
        if (typeof value === 'string' && key === 'sketch') {
          sketches.add(value);
        }

        return;
      }
      const record = value as Record<string, unknown>;
      // An edge reference: draw the edge itself.
      if (Array.isArray(record.mid) && Array.isArray(record.dir) && typeof record.length === 'number') {
        const mid = record.mid as Vec3;
        const dir = record.dir as Vec3;
        const halfLength = (record.length as number) / 2;
        edges.push([[mid[0] - dir[0] * halfLength, mid[1] - dir[1] * halfLength, mid[2] - dir[2] * halfLength], [mid[0] + dir[0] * halfLength, mid[1] + dir[1] * halfLength, mid[2] + dir[2] * halfLength]]);
      }
      for (const [key, x] of Object.entries(record)) {
        if (key !== 'exprs') {
          walk(x, key);
        }
      }
    };
    walk(feature);
    // Only what's still there.
    const have = new Set((this.result?.bodies ?? []).map(b => b.id));
    // Sketch curves in 3D.
    const lines: Vec3[][] = [...edges];
    for (const sid of sketches) {
      const plane = this.sketchPlane(sid);
      const sk = this.store.find<SketchFeature>(sid);
      if (!plane || !sk) {
        continue;
      }
      for (const e of sk.entities) {
        lines.push(...entityWorldPolylines(e, plane));
      }
    }

    return { bodies: [...bodies].filter(b => have.has(b)), lines };
  }

  editStep(id: string): void {
    this.editFeature(id);
  }

  private editFeature(id: string, pick?: string[]): void {
    const existing = this.store.find(id);
    if (!existing) {
      return;
    }
    this.setSelection([]);
    // What the step works on can be off screen (or under History): once its
    // tool shows its picks, bring them into view. A sketch frames itself.
    if (existing.type !== 'sketch') {
      const before = this.tool;
      setTimeout(() => this.tool !== before && this.view.keepInView(), 400);
    }
    switch (existing.type) {
      case 'boolean':
        // Subtract / Intersect open their tool (picks, Keep options); Union has nothing to set.
        if (existing.op !== 'union') {
          return this.setTool(new BooleanOp(this, existing.op, existing.target, existing.tools, existing));
        }
        break;
      case 'sketch': {
        // (From one of its steps in History: open with what that step made picked, ready to change.)
        const tool = new SketchTool(this, { sketchId: existing.id });
        this.setTool(tool);
        if (pick?.length) {
          tool.stopDrawing();
          tool.preselect(pick);
        }

        return;
      }
      case 'extrude':
        return this.setTool(new ExtrudeOp(this, existing.source, existing as ExtrudeFeature));
      case 'fillet':
      case 'chamfer':
        return this.setTool(new EdgeOp(this, existing.type, existing.edges, existing as EdgeFeature));
      case 'revolve':
        return this.setTool(new RevolveOp(this, existing.source, existing as RevolveFeature));
      case 'sweep':
        return this.setTool(new SweepOp(this, existing.source, existing as SweepFeature));
      case 'loft':
        return this.setTool(new LoftOp(this, existing.sections, [], existing as LoftFeature));
      case 'shell':
        return this.setTool(new ShellOp(this, existing.body, existing.faces, existing as ShellFeature));
      case 'split':
        return this.setTool(new SplitOp(this, existing.body, existing as SplitFeature));
      case 'fillToPlane':
        return this.setTool(new FillToPlaneOp(this, existing.body, existing as FillToPlaneFeature));
      case 'fill':
        return this.setTool(new FillOp(this, existing.boundary, existing));
      case 'imprint':
        return this.setTool(new ImprintOp(this, existing.source ? { source: existing.source } : { edges: existing.edges ?? [] }, existing));
      case 'wrap':
        return this.setTool(new WrapOp(this, existing.source, existing));
      case 'thread':
        return this.setTool(new ThreadOp(this, existing.face, existing.round ?? { r: 5, hole: false }, existing));
      case 'plane':
        return this.setTool(new PlaneOp(this, existing.plane, existing.face, existing as PlaneFeature));
      case 'transform': {
        if (existing.op.kind === 'scale' && existing.op.ref) {
          return this.setTool(new ScaleRefOp(this, existing.bodies, existing as TransformFeature));
        }
        if (existing.op.kind === 'scale' || existing.op.kind === 'scaleXYZ') {
          return this.setTool(new ScaleOp(this, existing.op.kind === 'scaleXYZ', existing.bodies, existing as TransformFeature));
        }

        return this.setTool(new TransformOp(this, existing.op.kind, existing.bodies, existing as TransformFeature));
      }
      case 'scaleFace':
        return this.setTool(new ScaleFaceOp(this, existing.face, { origin: existing.face.center, normal: existing.face.normal, xDir: existing.u }, existing));
      case 'replaceFace':
        return this.setTool(new ReplaceFaceOp(this, existing.face, existing));
      case 'image':
        return this.setTool(new ImageOp(this, existing as ImageFeature));
      // (Opened from History: that step itself is edited.)
      case 'freeform':
        return this.setTool(new FreeformTool(this, { feature: existing, keep: { inPlace: true } }));
      case 'freeformEdit': {
        // The shape as this edit left it; Done keeps the change in this step.
        const t = editedStep(this.store.features, existing.target, existing.id);
        if (t?.type === 'freeform') {
          return this.setTool(new FreeformTool(this, { feature: t, keep: { edit: existing.id } }));
        }
        if (t?.type === 'faceFreeform') {
          const tool = faceFreeformTool(this, null, t, { edit: existing.id });

          return tool ? this.setTool(tool) : undefined;
        }

        return this.ui.toast('The freeform this edits is gone');
      }
      case 'connect':
        return this.setTool(new ConnectOp(this, [], existing));
      case 'faceFreeform':
        return this.setTool(faceFreeformTool(this, null, existing, { inPlace: true }));
      case 'moveFace': {
        const target = existing.face ? { face: existing.face, plane: { origin: existing.face.center, normal: existing.face.normal, xDir: xDirFor(existing.face.normal) } } : existing.edge ? { edge: existing.edge } : existing.vertex ? { vertex: existing.vertex } : null;
        if (target) {
          return this.setTool(new MoveFaceOp(this, target, existing));
        }
        break;
      }
      default:
        this.ui.toast(`${existing.name} has no values to edit. You can suppress or delete it.`);
    }
  }

  // ------------------------------------------------------------ menus

  /** Nothing selected: the top-level menu (the left tool column). */
  /** The edges picked for a fillet or chamfer: each edge, and every edge round each face. */
  private pickedEdges(): EdgeRef[] {
    const out: EdgeRef[] = [];
    const have = (edgeRef: EdgeRef) => out.some(e => e.body === edgeRef.body && Math.hypot(e.mid[0] - edgeRef.mid[0], e.mid[1] - edgeRef.mid[1], e.mid[2] - edgeRef.mid[2]) < 1e-6);
    // (A round face's seam - the same face either side - is nothing to round:
    // picked, the step broke with "an edge it was built on is gone".)
    const seam = (body: string, edgeIndex: number) => !!this.view.body(body)?.edges[edgeIndex]?.seam;
    let seams = 0;
    for (const highlight of this.selection) {
      if (highlight.kind === 'edge' && seam(highlight.body, highlight.edge)) {
        seams++;
      }
      const refs = highlight.kind === 'edge' ? (seam(highlight.body, highlight.edge) ? [] : [edgeRefOf(this, highlight)]) : highlight.kind === 'face' ? edgesOfFace(this, highlight.body, highlight.face).filter(edgeIndex => !seam(highlight.body, edgeIndex)).map(edgeIndex => edgeRefOf(this, { body: highlight.body, edge: edgeIndex })) : [];
      for (const ref of refs) {
        if (ref && !have(ref)) {
          out.push(ref);
        }
      }
    }
    if (seams) {
      this.ui.toast('That line is a seam - where a round face starts and ends, no corner there to round or chamfer. Tap a real edge.');
    }

    return out;
  }

  firstShape(): boolean {
    return !this.result?.bodies.length && this.view.profileCount > 0;
  }

  mainTools(): ToolItem[] {
    // (Marked: it asks for a pick after it is tapped. The sentence bar leaves those out - there the pick comes first.)
    const wait = (label: string, accepts: Sel['kind'][], run: () => void) =>
      Object.assign(
        () => {
          this.selectTool.waitFor(label, accepts, run);
          this.selectTool.refresh();
        },
        { needsPick: true }
      );
    const bodies = () => bodiesOf(this.selection);
    const transform = (kind: ConstructorParameters<typeof TransformOp>[1], label: string) =>
      wait(label, ['body', 'face', 'edge'], () => this.setTool(new TransformOp(this, kind, bodies())));
    const src = () => sourcesOf(this, this.selection)[0];

    return [
      // An empty project: Sketch pulses - that's where to start.
      { id: 'sketch', label: 'Sketch', icon: 'sketch', shortcut: 'S', pulse: this.store.features.length === 0, run: () => this.setTool(new SketchTool(this)) },
      {
        // A shape from a sketch's: pulled, turned, swept, lofted.
        id: 'create',
        label: 'Create',
        icon: 'extrude',
        children: [
          // (The first shape drawn, nothing solid yet: this is the next step, it pulses.)
          { id: 'extrude', label: 'Extrude', icon: 'extrude', pulse: this.firstShape(), run: wait('Extrude', ['profile', 'face'], () => src() && this.setTool(new ExtrudeOp(this, src()!))) },
          { id: 'revolve', label: 'Revolve', icon: 'revolve', run: wait('Revolve', ['profile', 'face'], () => src() && this.setTool(new RevolveOp(this, src()!))) },
          { id: 'sweep', label: 'Sweep', icon: 'sweep', run: wait('Sweep', ['profile', 'face'], () => src() && this.setTool(new SweepOp(this, src()!))) },
          { id: 'loft', label: 'Loft', icon: 'loft', run: wait('Loft', ['profile', 'face'], () => this.setTool(new LoftOp(this, sourcesOf(this, this.selection).flatMap((source): ExtrudeSource[] => (source.kind === 'profile' ? source.regions.map(region => ({ ...source, regions: [region] })) : [source])), this.selection))) }
        ]
      },
      {
        // A body changed where it is: edges, faces, walls, details.
        id: 'modify',
        label: 'Modify',
        icon: 'fillet',
        children: [
          { id: 'fillet', label: 'Fillet', icon: 'fillet', run: wait('Fillet', ['edge', 'face'], () => this.setTool(new EdgeOp(this, 'fillet', this.pickedEdges()))) },
          { id: 'chamfer', label: 'Chamfer', icon: 'chamfer', run: wait('Chamfer', ['edge', 'face'], () => this.setTool(new EdgeOp(this, 'chamfer', this.pickedEdges()))) },
          { id: 'shell', label: 'Shell', icon: 'shell', run: wait('Shell', ['face', 'body'], () => {
            const highlight = this.selection[0];
            const faces = this.selection.flatMap(highlight => (highlight.kind === 'face' ? [faceRefOf(this, highlight)!] : []));
            this.setTool(new ShellOp(this, bodiesOf([highlight])[0], faces));
          }) },
          { id: 'offsetFace', label: 'Offset Face', icon: 'offsetFace', run: wait('Offset Face', ['face'], () => src() && this.setTool(new ExtrudeOp(this, src()!))) },
          { id: 'offsetEdge', label: 'Offset Edge', icon: 'offsetEdge', run: () => {
            const edgePick = this.selection.find(highlight => highlight.kind === 'edge');
            this.setTool(new OffsetEdgeOp(this, edgePick?.kind === 'edge' ? edgePick : undefined));
          } },
          { id: 'thread', label: 'Thread', icon: 'thread', run: wait('Thread (tap a round face or its rim)', ['face', 'edge'], () => this.startThread()) },
          { id: 'wrap', label: 'Wrap & Emboss', icon: 'wrap', beta: true, run: wait("Wrap & Emboss (tap a sketch's shape)", ['profile'], () => src() && this.setTool(new WrapOp(this, src()!))) },
          // Holes filled, surfaces closed, broken bodies mended.
          {
            id: 'fix',
            label: 'Fix',
            icon: 'check',
            children: [
              { id: 'fillNetwork', label: 'Fill', icon: 'fill', sub: 'a surface over curves', run: () => this.setTool(new FillOp(this, this.pickedCurves())) },
              { id: 'fillToPlane', label: 'Fill to Plane', icon: 'fill', run: wait('Fill to Plane (tap the surface)', ['body', 'face', 'edge'], () => this.setTool(new FillToPlaneOp(this, bodiesOf(this.selection)[0]))) },
              {
                id: 'repair',
                label: 'Repair Body',
                icon: 'check',
                run: wait('Repair Body', ['body', 'face', 'edge'], () => {
                  const ids = bodiesOf(this.selection);
                  if (!ids.length) {
                    return;
                  }
                  this.store.add({ ...this.store.newIdentity('repair'), type: 'repair', bodies: ids });
                  this.ui.toast('Repair added to History - it notes what it fixed');
                })
              }
            ]
          },
          { id: 'replace', label: 'Replace Face', icon: 'replaceFace', run: wait('Replace Face', ['face'], () => {
            const highlight = this.selection[0];
            const ref = highlight?.kind === 'face' ? faceRefOf(this, highlight) : null;
            if (ref) {
              this.setTool(new ReplaceFaceOp(this, ref));
            }
          }) }
        ]
      },
      {
        // Bodies together, apart, or cut in two.
        id: 'combine',
        label: 'Combine',
        icon: 'union',
        children: [
          { id: 'union', label: 'Union', icon: 'union', run: wait('Union (double-tap bodies)', ['body'], () => this.selectTool.refresh()) },
          { id: 'subtract', label: 'Subtract', icon: 'subtract', run: () => this.setTool(new BooleanOp(this, 'subtract')) },
          { id: 'intersect', label: 'Intersect', icon: 'intersect', run: () => this.setTool(new BooleanOp(this, 'intersect')) },
          { id: 'split', label: 'Split Body', icon: 'split', run: wait('Split Body', ['body', 'face'], () => this.setTool(new SplitOp(this, bodiesOf(this.selection)[0]))) }
        ]
      },
      {
        id: 'transform',
        label: 'Transform',
        icon: 'transform',
        children: [
          // Moved: freely, along a line, round an axis.
          {
            id: 'moveKinds',
            label: 'Move',
            icon: 'move',
            children: [
              { id: 'move', label: 'Move/Rotate', icon: 'move', shortcut: 'M', run: transform('move', 'Move/Rotate') },
              { id: 'translate', label: 'Translate', icon: 'translate', run: transform('translate', 'Translate') },
              { id: 'rotate', label: 'Rotate Around Axis', icon: 'rotateAxis', run: transform('rotate', 'Rotate Around Axis') }
            ]
          },
          { id: 'scale', label: 'Scale', icon: 'scale', run: wait('Scale', ['body', 'face', 'edge'], () => this.setTool(new ScaleOp(this, false, bodies()))) },
          { id: 'mirror', label: 'Mirror', icon: 'mirror', run: transform('mirror', 'Mirror') },
          {
            id: 'pattern',
            label: 'Pattern',
            icon: 'patternLinear',
            children: [
              { id: 'linear', label: 'Linear', icon: 'patternLinear', run: transform('linear', 'Pattern – Linear') },
              { id: 'circular', label: 'Circular', icon: 'patternCircular', run: transform('circular', 'Pattern – Circular') }
            ]
          }
        ]
      },
      {
        id: 'construct',
        label: 'Construct',
        icon: 'construct',
        children: [
          {
            // A tap: Offset Plane from the face or plane tapped next - or one of the other kinds, picked on the wheel.
            id: 'plane',
            label: 'Plane',
            icon: 'plane',
            startsDefault: 'offset',
            run: wait('Offset Plane', ['face', 'plane'], () => {
              const highlight = this.selection[0];
              if (highlight?.kind === 'face') {
                const face = this.view.body(highlight.body)?.faces[highlight.face];
                if (face?.plane) {
                  this.setTool(new PlaneOp(this, face.plane, faceRefOf(this, highlight)!));
                } else {
                  this.ui.toast('An Offset Plane starts from a flat face or a plane', 'error');
                }
              } else if (highlight?.kind === 'plane') {
                const plane = this.view.planeOf(highlight.id);
                if (plane) {
                  this.setTool(new PlaneOp(this, plane, undefined));
                }
              }
            }),
            children: [
              { id: 'offset', label: 'Offset Plane', short: 'Offset', icon: 'planeOffset', run: () => this.setTool(new PlaneOp(this, null, undefined)) },
              { id: 'mid', label: 'Midplane', icon: 'planeMid', run: () => this.setTool(new MidplaneOp(this)) },
              { id: '3pt', label: 'Through 3 Points', short: '3 Points', icon: 'plane3pt', run: () => this.setTool(new ThreePointPlaneOp(this)) },
              { id: 'curve', label: 'On Curve at Point', short: 'On Curve', icon: 'planeCurve', run: () => this.setTool(new CurvePointPlaneOp(this, false)) },
              { id: 'perp', label: 'Perpendicular to Edge at Point', short: 'Perpendicular', icon: 'planePerp', run: () => this.setTool(new CurvePointPlaneOp(this, true)) },
              { id: 'angle', label: 'Through Edge at Angle', short: 'At Angle', icon: 'planeAngle', run: () => this.setTool(new EdgeAnglePlaneOp(this)) },
              { id: 'parallel', label: 'Parallel to Face at Point', short: 'Parallel', icon: 'planeParallel', run: () => this.setTool(new FacePointPlaneOp(this)) }
            ]
          },
          {
            id: 'axis',
            label: 'Axis',
            icon: 'axis',
            // (Along X, Y or Z: the origin's own axes, tapped in the view.)
            children: [
              { id: 'axisFace', label: 'Square to Face', short: 'Face', icon: 'axisFace' as const, run: wait('Axis Square to Face', ['face'], () => {
                const highlight = this.selection[0];
                const faceInfo = highlight?.kind === 'face' ? this.view.body(highlight.body)?.faces[highlight.face] : undefined;
                if (faceInfo) {
                  this.setTool(new AxisOp(this, faceInfo.center, faceInfo.plane?.normal ?? faceInfo.normal, undefined, 'face'));
                }
              }) },
              { id: 'axisEdge', label: 'Along Edge', short: 'Edge', icon: 'axisEdge' as const, run: wait('Axis Along Edge', ['edge'], () => {
                const highlight = this.selection[0];
                const e = highlight?.kind === 'edge' ? this.view.body(highlight.body)?.edges[highlight.edge] : undefined;
                // A round edge: through its centre, square to it.
                const ax = e && (e.type === 'CIRCLE' ? circleAxis(e.start, e.mid, e.end, e.dir) : { origin: e.start, dir: e.dir });
                if (ax) {
                  this.setTool(new AxisOp(this, ax.origin, ax.dir, undefined, e.type === 'CIRCLE' ? 'round' : 'edge'));
                }
              }) },
              { id: 'axisRound', label: 'Cylinder / Cone', icon: 'axisRound' as const, run: wait('Axis of Cylinder / Cone', ['face'], () => {
                const highlight = this.selection[0];
                const ax = highlight?.kind === 'face' ? surfaceAxis(this, highlight.body, highlight.face) : null;
                if (ax) {
                  this.setTool(new AxisOp(this, ax.origin, ax.dir, undefined, 'round'));
                } else {
                  this.ui.toast('Tap a round face - a cylinder, a hole or a cone - for the axis through its middle', 'error');
                }
              }) },
              { id: 'axis2pt', label: 'Point to Point', icon: 'axis2pt' as const, run: () => this.setTool(new TwoPointAxisOp(this)) },
              { id: 'axisPlanes', label: 'Intersection of 2 Planes', short: '2 Planes', icon: 'axisPlanes' as const, run: () => this.setTool(new PlanesAxisOp(this)) }
            ]
          }
        ]
      },
      {
        // Smooth shapes from a control cage.
        id: 'freeform',
        label: 'Freeform',
        icon: 'freeform',
        children: [
          ...(['box', 'sphere', 'cylinder', 'torus', 'plane'] as const).map(primitive => ({
            id: `ff-${primitive}`,
            label: { box: 'Box', sphere: 'Sphere', cylinder: 'Cylinder', torus: 'Torus', plane: 'Surface' }[primitive],
            icon: ({ box: 'ffBox', sphere: 'ffSphere', cylinder: 'ffCylinder', torus: 'ffTorus', plane: 'ffSurface' } as const)[primitive],
            run: () => this.setTool(new FreeformTool(this, { primitive: primitive }))
          })),
          // A flat face of a body made smooth (its edges stay put).
          {
            id: 'faceFreeform',
            beta: true,
            label: 'Freeform Face',
            icon: 'faceFreeform' as const,
            sub: 'a face of a body',
            run: wait('Freeform Face (tap a flat face)', ['face'], () => {
              const highlight = this.selection[0];
              if (highlight?.kind !== 'face' || !this.view.body(highlight.body)?.faces[highlight.face]?.plane) {
                return void this.ui.toast('Freeform Face works on flat faces for now');
              }
              const t = faceFreeformTool(this, highlight);
              if (t) {
                this.setTool(t);
              }
            })
          },
          // A smooth bridge between two faces.
          { id: 'connect', label: 'Connect', icon: 'connect' as const, sub: 'two faces', beta: true, run: () => this.setTool(new ConnectOp(this, this.selection.filter(highlight => highlight.kind === 'face').slice(0, 2))) }
        ]
      },
      {
        // Less often: a file or picture brought in, and the project as a building model.
        id: 'more',
        label: 'More',
        icon: 'more',
        children: [
          {
            id: 'insert',
            label: 'Insert',
            icon: 'insert',
            children: [
              { id: 'image', label: 'Image on plane', icon: 'image', run: () => void insertImage(this).then(image => image && this.setTool(new ImageOp(this, image))) },
              { id: 'file', label: 'File', icon: 'file', sub: 'STEP, STL, OBJ, 3MF, DXF, SVG', run: () => void insertFile(this) },
              { id: 'project', label: 'Project', icon: 'file', sub: '.super', run: () => void insertFile(this) },
              { id: 'refImage', label: 'Reference Image', icon: 'refImage', sub: 'a picture in its own window, over the model', run: () => void this.refImages.open() },
              // A web page or a video in a window over the model (open already: brought up again).
              { id: 'browser', label: 'Browser', icon: 'browser', sub: 'a web page or a video, in a window over the model', active: this.web.isOpen, run: () => this.web.open() }
            ]
          },
          {
            // The project as a building information model: real materials, and
            // from them the technical sheet and the drawings.
            id: 'bim',
            label: 'BIM',
            icon: 'bim',
            children: [
              { id: 'bimMaterials', label: 'Materials', icon: 'bim', sub: 'a real material for each body', run: () => this.setTool(new BimTool(this)) },
              { id: 'bimSheet', label: 'Technical Sheet', icon: 'sheet', sub: 'parts list, masses, data', run: () => void openSheet(this) },
              { id: 'bimDrawings', label: 'Drawings', icon: 'drawing', sub: 'views with dimensions', run: () => void openDrawing(this) },
              { id: 'bimAssemblies', label: 'Assemblies', icon: 'assembly', sub: 'joints: how the parts move', run: () => this.setTool(new AssemblyTool(this)) }
            ]
          }
        ]
      }
    ];
  }

  bottomTools(): ToolItem[] {
    return [
      // The one whose card is open pulses (as a tool does while its window is open).
      { id: 'section', label: 'Section View', icon: 'section', sub: this.section ? 'On' : this.lastSection ? 'Off · tap to show' : 'Off', active: !!this.section, pulse: this.tool instanceof SectionTool, run: () => this.toggleSection() },
      { id: 'measure', label: 'Measure', icon: 'measure', active: this.tool instanceof MeasureTool, pulse: this.tool instanceof MeasureTool, run: () => this.setTool(this.tool instanceof MeasureTool ? null : new MeasureTool(this)) },
      // On: a tag per variable in the view (tap one to change it), and their card. Off again.
      { id: 'variables', label: 'Variables', icon: 'variable', sub: this.varsOn ? 'On' : this.store.doc.variables.length ? `Off · ${this.store.doc.variables.length}` : 'Off', active: this.varsOn, pulse: this.tool instanceof VariablesTool, run: () => this.toggleVariables() },
      this.isolated
        ? { id: 'isolate', label: 'Isolate', icon: 'isolate', sub: 'On - tap to show all', active: true, run: () => this.isolate(null) }
        : {
          id: 'isolate',
          label: 'Isolate',
          icon: 'isolate',
          sub: 'Off',
          disabled: !bodiesOf(this.selection).length,
          why: 'Select a body, face or edge to isolate',
          run: () => this.isolate(bodiesOf(this.selection))
        },
      // The way out with what was made: is it fit to print, and the files to take it away as.
      { id: 'printShare', label: 'Print / Share', icon: 'share', run: () => void this.printShare() }
    ];
  }

  private onKey(e: KeyboardEvent): void {
    // Typing while holding a drag sets an exact value; Enter applies it and finishes.
    // (Checked first: a panel field may still have focus from before the drag.)
    if (this.input.dragging && this.tool.dragKey?.(e)) {
      e.preventDefault();
      (document.activeElement as HTMLElement | null)?.blur?.();
      if (e.key === 'Enter') {
        this.input.endDrag();
      }

      return;
    }
    const target = e.target as HTMLElement;
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) {
      return;
    }
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    if (mod && key === 'z') {
      e.preventDefault();
      if (e.shiftKey) {
        this.redo();
      } else {
        this.undo();
      }

      return;
    }
    if (mod && key === 'y') {
      e.preventDefault();
      this.redo();

      return;
    }
    // Select Through: pick what's behind the faces in front.
    if (mod && e.shiftKey && key === 's') {
      e.preventDefault();
      this.view.setSelectThrough(!this.view.selectThrough);
      this.ui.toast(this.view.selectThrough ? 'Select Through on: edges and sketches behind the faces can be picked' : 'Select Through off');

      return;
    }
    if (mod && key === 's') {
      e.preventDefault();
      this.exporter.save();

      return;
    }
    // Everything: Ctrl+A (the bodies, or with none the sketches' shapes; in a sketch, its curves).
    if (mod && !e.shiftKey && key === 'a') {
      e.preventDefault();
      this.tool.selectAll?.();

      return;
    }
    // Search commands: Ctrl+F anywhere (X too, outside a sketch - see below).
    if (mod && key === 'f') {
      e.preventDefault();
      this.searchCommands();

      return;
    }
    // The standard views: Ctrl (or Alt, where the browser keeps Ctrl+1… for its tabs) + 1 to 7.
    if ((mod || e.altKey) && /^[1-7]$/.test(e.key)) {
      e.preventDefault();
      this.viewByNumber(Number(e.key));

      return;
    }
    if (this.tool.key?.(e)) {
      e.preventDefault();

      return;
    }
    // Space over a face: zoom to it.
    if (key === ' ' && !mod && this.pointerAt) {
      const hit = this.view.pick(this.pointerAt[0], this.pointerAt[1], { edges: false, planes: false, profiles: false });
      if (hit?.kind === 'face' && this.view.zoomToFace(hit.body, hit.face)) {
        e.preventDefault();
      }

      return;
    }
    if (this.tool !== this.selectTool) {
      return;
    }
    // The booleans: Ctrl+U / B / I.
    if (mod && !e.shiftKey && (key === 'u' || key === 'b' || key === 'i')) {
      if (this.runCommand([{ u: 'Union', b: 'Subtract', i: 'Intersect' }[key]])) {
        e.preventDefault();
      }

      return;
    }
    if (mod || e.altKey) {
      return;
    }
    if (key === 'x') {
      return void (e.preventDefault(), this.searchCommands());
    }
    if (e.key === '?') {
      return void showShortcuts();
    }
    const none = !this.selection.length;
    if (key === 's' && none) {
      return void this.setTool(new SketchTool(this));
    }
    if (key === 'f' && none) {
      return void this.fit();
    }
    // A drawing tool's letter with nothing picked: a sketch, with that tool (once its plane is picked).
    const draw: Record<string, 'line' | 'arc' | 'circle' | 'rect' | 'polygon' | 'spline' | 'offset' | 'trim'> = { l: 'line', a: 'arc', c: 'circle', r: 'rect', g: 'polygon', i: 'spline', o: 'offset', t: 'trim' };
    if (draw[key] && none && !e.shiftKey) {
      return void this.setTool(new SketchTool(this, { kind: draw[key] }));
    }
    // A modeling tool's letter: that tool, for what's picked (or waiting for it).
    const tools: Record<string, string[]> = {
      e: ['Extrude', 'Offset Face'],
      f: ['Fillet'],
      h: ['Shell'],
      m: ['Move/Rotate'],
      n: ['Translate'],
      p: ['Project as Sketch'],
      s: ['Scale', 'Scale Sketch'],
      v: ['Revolve'],
      w: ['Sweep'],
      o: ['Offset Edge']
    };
    if (tools[key] && !e.shiftKey && this.runCommand(tools[key])) {
      e.preventDefault();
    }
  }

  /** Where the pointer was last over the view (Space zooms to the face there). */
  private pointerAt: [number, number] | null = null;

  /** The picked sketch curves and edges, as paths (one per sketch, one per body): what Fill starts with. */
  private pickedCurves(): PathRef[] {
    const out: PathRef[] = [];
    for (const highlight of this.selection) {
      if (highlight.kind === 'curve') {
        const sketchPath = out.find((pathRef): pathRef is Extract<PathRef, { kind: 'sketch' }> => pathRef.kind === 'sketch' && pathRef.sketch === highlight.sketch);
        if (sketchPath) {
          sketchPath.entities.push(highlight.entity);
        } else {
          out.push({ kind: 'sketch', sketch: highlight.sketch, entities: [highlight.entity] });
        }
      } else if (highlight.kind === 'edge') {
        const ref = edgeRefOf(this, highlight);
        if (!ref) {
          continue;
        }
        const edgePath = out.find((pathRef): pathRef is Extract<PathRef, { kind: 'edges' }> => pathRef.kind === 'edges' && pathRef.edges[0]?.body === ref.body);
        if (edgePath) {
          edgePath.edges.push(ref);
        } else {
          out.push({ kind: 'edges', edges: [ref] });
        }
      }
    }

    return out;
  }

  /** Run the first of these commands that's offered now (the picked thing's tools first). */
  private runCommand(labels: string[]): boolean {
    const hit = findAction(this.ui.offered(), this.mainTools(), labels);
    if (!hit) {
      return false;
    }
    hit.item.run!();

    return true;
  }

  private searchCommands(): void {
    openCommandSearch(
      () => this.ui.offered(),
      () => [...this.mainTools(), { id: 'shortcuts', label: 'Keyboard shortcuts', icon: 'menu', shortcut: '?', run: () => showShortcuts() }]
    );
  }

  /** 1 the default view; 2-7 front, back, top, bottom, right, left. */
  private viewByNumber(viewNumber: number): void {
    const cam = this.view.cam;
    if (viewNumber === 1) {
      cam.iso();
      this.view.fitAll();

      return;
    }
    const views: [Vec3, Vec3?][] = [
      [[0, -1, 0]],
      [[0, 1, 0], [-1, 0, 0]],
      [[0, 0, 1]],
      [[0, 0, -1]],
      [[1, 0, 0], [0, 1, 0]],
      [[-1, 0, 0], [0, -1, 0]]
    ];
    const [normal, xDir] = views[viewNumber - 2];
    cam.lookAlong(normal, xDir);
  }

  private fit(): void {
    this.view.fitAll();
  }

  // ------------------------------------------------------------ files

  private wireTopbar(): void {
    const on = (id: string, fn: () => void) => document.getElementById(id)!.addEventListener('click', fn);
    const menu = document.getElementById('file-menu')!;
    const more = document.getElementById('more-menu')!;
    // Phones: one thing open at a time at the left - a menu closes Items.
    // Phones: one thing open at a time - a menu takes the place of Items and of History.
    const phoneItemsAway = () => {
      if (window.innerWidth > 720) {
        return;
      }
      if (document.getElementById('items')!.classList.contains('open')) {
        this.items.toggle(false);
      }
      if (document.body.classList.contains('history-open')) {
        this.ui.toggleHistory(false);
      }
    };
    on('file-btn', () => ((more.hidden = true), menu.toggleAttribute('hidden'), !menu.hidden && phoneItemsAway()));
    on('more-btn', () => ((menu.hidden = true), more.toggleAttribute('hidden'), !more.hidden && phoneItemsAway()));
    on('history-btn', () => ((menu.hidden = more.hidden = true), this.ui.toggleHistory()));
    document.getElementById('m-version')!.textContent = `Version ${__APP_VERSION__}`;
    const moreItem = (id: string, fn: () => void) => on(id, () => ((more.hidden = true), fn()));
    // Fullscreen (the label follows the state; Esc also leaves it).
    const fs = document.getElementById('m-fullscreen')!;
    const doc = document as Document & { webkitFullscreenElement?: Element; webkitExitFullscreen?: () => void };
    const root = document.documentElement as HTMLElement & { webkitRequestFullscreen?: () => void };
    const isFull = () => !!(document.fullscreenElement ?? doc.webkitFullscreenElement);
    const paint = () => {
      fs.firstChild!.textContent = isFull() ? 'Exit fullscreen' : 'Fullscreen';
      // Tablets draw their own close button at the top left in fullscreen: the top bar makes room.
      document.body.classList.toggle('is-fullscreen', isFull());
    };
    document.addEventListener('fullscreenchange', paint);
    document.addEventListener('webkitfullscreenchange', paint);
    const goFull = () => {
      if (root.requestFullscreen) {
        void root.requestFullscreen().catch(() => this.ui.toast("This browser won't go fullscreen here"));
      } else if (root.webkitRequestFullscreen) {
        root.webkitRequestFullscreen();
      }
      // iPhone Safari has no fullscreen for pages: the Home Screen app is.
      else {
        this.ui.toast('Tip: Share → Add to Home Screen opens superGeometry.app full screen');
      }
    };
    moreItem('m-fullscreen', () => {
      if (isFull()) {
        return void (document.exitFullscreen?.() ?? doc.webkitExitFullscreen?.());
      }
      goFull();
    });
    // The welcome window (and File → Open) has a Full screen button too (a
    // browser only allows it from a tap). Everywhere but an app that already
    // has the whole screen; where a browser has none (iPhone), it says how.
    this.fullscreen = !matchMedia('(display-mode: fullscreen)').matches ? { isFull, toggle: () => (isFull() ? void (document.exitFullscreen?.() ?? doc.webkitExitFullscreen?.()) : goFull()) } : null;
    // Help and Tutorial: placeholders for now.
    // A newer build out? More pulses and its Update item says NEW.
    this.updates = new Updates(() => this.store.flush());
    moreItem('m-update', () => void this.confirmReset());
    // Phones and tablets: an offer to add the app to the home screen (More → Install app too).
    const install = new Install(t => this.ui.toast(t));
    const inst = document.getElementById('m-install')!;
    document.getElementById('more-btn')!.addEventListener('click', () => (inst.hidden = !install.available));
    moreItem('m-install', () => install.offer(true));
    // Help: a panel explaining every button (toggle it from More → Help).
    const help = new HelpPanel();
    moreItem('m-help', () => help.toggle());
    // The guide text (what to tap next): on or off.
    // (Each a switch on its row - they said On or Off in words. Asked for: "make the two buttons (guide text and
    // offline mode) have a toggle icon. I don't like how right now it's only on or off in text".)
    const switchOf = (id: string, on: boolean) => {
      const b = document.getElementById(id)!;
      b.classList.toggle('on', on);
      b.setAttribute('aria-checked', String(on));
    };
    const paintHints = () => switchOf('m-hints', settings.value.showHints);
    paintHints();
    // (Also switched off by the × on the guide text itself.)
    settings.onChange(paintHints);
    moreItem('m-hints', () => {
      settings.set('showHints', !settings.value.showHints);
      paintHints();
      this.ui.refreshHint();
    });
    // Offline mode: the app kept on this device, so it works with no connection.
    const offlineState = document.getElementById('m-offline-state')!;
    // (Its switch; beside it only how far the download is while it runs.)
    const offline = new Offline((t, kind) => this.ui.toast(t, kind), state => ((offlineState.textContent = state === 'On' || state === 'Off' ? '' : state), switchOf('m-offline', settings.value.offline)));
    this.updates.offline = { get on() {
      return settings.value.offline; 
    }, download: fresh => offline.download(fresh) };
    moreItem('m-offline', () => void offline.toggle());
    // The tutorial: a first part, built one lit tap at a time (see ui/tutorial.ts).
    const tutorial = new Tutorial({
      tool: () => this.tool as unknown as ReturnType<TutorialHost['tool']>,
      selection: () => this.selection,
      setSelection: sel => this.setSelection(sel),
      features: () => this.store.features,
      toScreen: point => this.view.toScreen(new Vector3(point[0], point[1], point[2])),
      canvas: () => this.view.canvas,
      faces: body => (this.view.body(body)?.faces ?? []).map(faceInfo => ({ center: faceInfo.center, normal: faceInfo.normal, type: faceInfo.type })),
      bodies: () => this.view.bodyList.map(b => b.id),
      eye: () => this.view.cam.camera.position,
      newProject: () => this.newProject(),
      setUp: () => (sketchVariant('circle', 'center'), sketchSides(6)),
      closePanels: () => (this.ui.toggleHistory(false), this.items.toggle(false)),
      zoomTo: (mm, px) => {
        const now = this.view.cam.worldPerPixel(this.view.height);
        const want = mm / px;
        const off = this.view.cam.target.lengthSq() > 1e-12;
        // (Asked for each frame until the first circle is drawn: nothing is done when the view is there already.)
        if (!(now > 0) || (!off && Math.abs(now / want - 1) < 1e-3)) {
          return;
        }
        this.view.cam.target.set(0, 0, 0);
        this.view.cam.zoom(want / now);
        this.view.requestRender();
      },
      chamferAt: (z) => {
        const t = this.tool as unknown as { id: string; feature?: { edges: EdgeRef[] }; edgeSels?(): Sel[]; update?(): void };
        const body = t.feature?.edges[0]?.body;
        if (t.id !== 'chamfer' || !t.feature || !body) {
          return;
        }
        const flat = (point: Vec3) => Math.abs(point[2] - z) < 1e-6;
        // (Once: with them chamfered, the body as it is shown has new edges at that height - the cuts' own.)
        if (t.feature.edges.some(e => flat(e.mid))) {
          return;
        }
        const have = (midpoint: Vec3) => t.feature!.edges.some(e => e.body === body && Math.hypot(e.mid[0] - midpoint[0], e.mid[1] - midpoint[1], e.mid[2] - midpoint[2]) < 1e-6);
        let added = false;
        (this.view.body(body)?.edges ?? []).forEach((e, i) => {
          if (e.type !== 'LINE' || !flat(e.start) || !flat(e.end) || have(e.mid)) {
            return;
          }
          const ref = edgeRefOf(this, { body, edge: i });
          if (ref) {
            (t.feature!.edges.push(ref), (added = true));
          }
        });
        if (!added) {
          return;
        }
        if (t.edgeSels) {
          this.setSelection(t.edgeSels());
        }
        t.update?.();
      },
      plainTaps: on => void (this.input.plainTaps = on),
      exact: (kind, centre, edge) => void (this.tool instanceof SketchTool && this.tool.exact(kind, centre, edge)),
      setNumber: (field, mm) => {
        const t = this.tool as unknown as { id: string; feature?: Record<string, unknown>; render?(): void; update?(): void; setPitch?(v: number): void };
        if (!t.feature || t.id !== { clearance: 'boolean', distance: 'extrude', start: 'extrude', pitch: 'thread' }[field]) {
          return;
        }
        // (A thread: a plain right-hand one of one start, whatever the thread made last on a rod this size was.)
        if (field === 'pitch') {
          t.feature.left = undefined;
          t.feature.starts = undefined;
          t.setPitch?.(mm);

          return;
        }
        t.feature[field] = mm;
        t.render?.();
        t.update?.();
      }
    });
    this.tutorial = tutorial;
    moreItem('m-tutorial', () => this.startTutorial());
    this.startTutorial = () => {
      // (The question whether to start it, should it be up: answered.)
      document.querySelector('.dialog.tutorial-ask')?.closest('.dialog-back')?.remove();
      void tutorial.start();
    };
    // About: the README, in the app. Support links open in a new tab (no access back to this page).
    moreItem('m-about', () => showAbout());
    // Feedback: a bug report, suggestion or discussion, posted on r/supergeometry (Reddit's page, in a new tab).
    // (Loaded on the first tap: most visits never open it.)
    moreItem('m-feedback', () => void import('./ui/feedback').then(({ showFeedback }) => showFeedback()));
    // Support: a short list of ways (each opens in a new tab). One without a link yet says so.
    const donateList = document.getElementById('m-donate-list')!;
    on('m-donate', () => {
      donateList.hidden = !donateList.hidden;
      document.getElementById('m-donate-arrow')!.textContent = donateList.hidden ? '▸' : '▾';
    });
    for (const { id, url } of SUPPORT) {
      const b = document.getElementById(`m-support-${id}`);
      if (!b) {
        continue;
      }
      if (!url) {
        b.querySelector('.menu-soon')!.textContent = 'soon';
        b.classList.add('disabled');
      }
      moreItem(`m-support-${id}`, () => (url ? openSupport(url) : this.ui.toast('Coming soon')));
    }
    document.addEventListener('pointerdown', (e) => {
      if (!(e.target as HTMLElement).closest('#file-menu, #file-btn')) {
        menu.hidden = true;
      }
      if (!(e.target as HTMLElement).closest('#more-menu, #more-btn')) {
        more.hidden = true;
      }
    });
    const item = (id: string, fn: () => void) =>
      on(id, () => {
        menu.hidden = true;
        fn();
      });
    item('m-new', () => void this.newProject());
    item('m-open', () => void this.showProjects());
    item('m-save', () => this.exporter.save());
    item('m-stl', () => void this.exporter.export('stl'));
    item('m-step', () => void this.exporter.export('step'));
    item('m-3mf', () => void this.exporter.export3mf());
    item('m-glb', () => void this.exporter.exportGLB());
    item('m-each', () => {
      // Which format each body is saved in: a menu where the File menu was.
      const rect = document.getElementById('file-btn')!.getBoundingClientRect();
      const row = (format: 'stl' | 'step' | '3mf' | 'glb', label: string) => ({ label, run: () => void this.exporter.exportEach(format) });
      this.ui.menu(rect.left, rect.bottom + 4, [row('stl', 'Each body as STL'), row('step', 'Each body as STEP'), row('3mf', 'Each body as 3MF'), row('glb', 'Each body as GLB')]);
    });
    item('m-dxf', () => this.exporter.exportDXF());
    item('m-svg', () => this.exporter.exportDXF('download', 'svg'));
    // A share button at the right of each export (and Save): straight to the share sheet.
    // Only for the file types this browser will really share (Chrome on Android,
    // for one, refuses 3D and CAD files: a button there would only download).
    {
      const shares: [string, string, () => void][] = [
        ['m-save', 'super', () => this.exporter.save('share')],
        ['m-stl', 'stl', () => void this.exporter.export('stl', 'share')],
        ['m-step', 'step', () => void this.exporter.export('step', 'share')],
        ['m-3mf', '3mf', () => void this.exporter.export3mf('share')],
        ['m-glb', 'glb', () => void this.exporter.exportGLB('share')],
        ['m-dxf', 'dxf', () => this.exporter.exportDXF('share')],
        ['m-svg', 'svg', () => this.exporter.exportDXF('share', 'svg')]
      ];
      // Android's share sheet turns these files away or mangles them: downloads only there.
      const android = /Android/i.test(navigator.userAgent);
      for (const [id, ext, run] of shares) {
        if (android || !canShareType(ext)) {
          continue;
        }
        const btn = document.getElementById(id)!;
        const sh = document.createElement('span');
        sh.className = 'menu-share';
        sh.setAttribute('role', 'button');
        sh.title = 'Share';
        sh.innerHTML = icons.share;
        sh.addEventListener('click', (e) => {
          e.stopPropagation();
          menu.hidden = true;
          run();
        });
        btn.append(sh);
      }
    }
    on('undo-btn', () => this.undo());
    on('redo-btn', () => this.redo());
    this.store.onChange(() => this.updateUndo());
    this.updateUndo();

    // Project name: click and type; Enter or leaving the field renames.
    // (Editable text, not an input: a phone's browser hung its autofill bar -
    // passwords, cards, addresses - over the screen for an input.)
    const name = document.getElementById('project-name') as HTMLElement;
    name.contentEditable = 'plaintext-only';
    if (name.contentEditable !== 'plaintext-only') {
      name.contentEditable = 'true';
    }
    const typed = () => (name.textContent ?? '').replace(/\s+/g, ' ').trim();
    const show = () => {
      if (document.activeElement !== name) {
        name.textContent = this.store.doc.name;
      }
      // A new, unnamed project keeps the page's own title (what search results show).
      document.title = this.store.doc.name === 'Untitled' ? PAGE_TITLE : `${this.store.doc.name} – superGeometry.app`;
    };
    const rename = () => {
      const value = typed();
      if (value && value !== this.store.doc.name) {
        this.store.commit(draft => (draft.name = value));
      }
      name.textContent = this.store.doc.name;
      name.scrollLeft = 0;
    };
    name.addEventListener('blur', rename);
    // On a small screen, while it is being renamed, it opens over the buttons
    // beside it (File, Items, History, More) to the bar's end; they stay where
    // they are under it, kept in place by a spot of its old width.
    const spot = document.createElement('span');
    spot.className = 'project-name-spot';
    name.addEventListener('focus', () => {
      if (!matchMedia('(max-width: 720px), (pointer: coarse)').matches) {
        return;
      }
      const bar = name.parentElement!;
      spot.style.width = `${name.offsetWidth}px`;
      spot.style.marginRight = getComputedStyle(name).marginRight;
      const left = name.offsetLeft;
      name.before(spot);
      name.classList.add('wide');
      name.style.left = `${left}px`;
      name.style.width = `${bar.clientWidth - left - 4}px`;
    });
    name.addEventListener('blur', () => {
      if (!name.classList.contains('wide')) {
        return;
      }
      name.classList.remove('wide');
      name.style.left = name.style.width = '';
      spot.remove();
    });
    name.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault(), name.blur();
      }
      if (e.key === 'Escape') {
        (name.textContent = this.store.doc.name), name.blur();
      }
    });
    // Pasted: as plain text on one line.
    name.addEventListener('paste', (e) => {
      e.preventDefault();
      document.execCommand('insertText', false, (e.clipboardData?.getData('text/plain') ?? '').replace(/\s+/g, ' '));
    });
    // A mouse selects the whole name to type over; a finger gets the caret
    // where it tapped (selecting all brought up the phone's Cut / Copy bar).
    name.addEventListener('focus', () => {
      if (!matchMedia('(pointer: fine)').matches) {
        return;
      }
      requestAnimationFrame(() => {
        if (document.activeElement !== name) {
          return;
        }
        const range = document.createRange();
        range.selectNodeContents(name);
        getSelection()?.removeAllRanges();
        getSelection()?.addRange(range);
      });
    });
    this.store.onChange(show);
    show();
    // The saved mark at the end of the name: a tick once every change is on this device.
    const mark = () => {
      const saved = this.store.saved;
      name.classList.toggle('saving', !saved);
      name.title = `Project name - click to rename\n${saved ? 'Saved on this device' : 'Saving…'}`;
    };
    this.store.onSavedState(mark);
    mark();
  }

  /**
   * Undo: a tool with steps of its own (a freeform cage being shaped) takes
   * those back, and leaves the project alone while it's open - Ctrl+Z used to
   * throw the whole cage edit away and undo the step before it too.
   */
  private undo(): void {
    if (this.tool.undo) {
      if (!this.tool.undo()) {
        this.ui.toast('Nothing to undo in this edit yet (Cancel leaves it unchanged)');
      }

      return this.updateUndo();
    }
    if (this.tool instanceof SketchTool) {
      if (this.tool.undoPoint()) {
        return;
      }
      this.tool.stopDrawing();
    } else if (this.tool !== this.selectTool) {
      this.setTool(null);
    }
    this.store.undo();
  }
  private redo(): void {
    if (this.tool.redo) {
      this.tool.redo();

      return this.updateUndo();
    }
    if (this.tool instanceof SketchTool) {
      this.tool.stopDrawing();
    } else if (this.tool !== this.selectTool) {
      this.setTool(null);
    }
    this.store.redo();
  }
  refreshUndo(): void {
    this.updateUndo();
  }

  private updateUndo(): void {
    const t = this.tool?.undo ? this.tool : null;
    (document.getElementById('undo-btn') as HTMLButtonElement).disabled = t ? !t.canUndo : !this.store.canUndo;
    (document.getElementById('redo-btn') as HTMLButtonElement).disabled = t ? !t.canRedo : !this.store.canRedo;
  }

  private updates!: Updates;

  /** More → Update: asked first (it reloads the app), with the option to save a copy. */
  private async confirmReset(): Promise<void> {
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

  /**
   * New project: the current one can be saved (downloaded) or discarded
   * first. Then the app checks for a newer version and, if there is one,
   * clears its cached files and reloads - a new project starts on the latest.
   */
  private async newProject(): Promise<void> {
    const was = this.store.features.length ? this.store.doc.name : null;
    await this.switchProject(emptyDoc(), newProjectId());
    if (was) {
      this.ui.toast(`“${was}” is kept in File → Open`);
    }
    // The first minute makes something: a new project opens in a sketch on the floor with Line on, as every new
    // sketch does - tap, tap, back to the start: a shape; Exit pulses, the shape is pulled up.
    if (!this.store.features.length && this.tool === this.selectTool) {
      this.setTool(new SketchTool(this, { plane: { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, 0, 1] }, kind: 'line' }));
    }
    if (await this.updates.check()) {
      await this.updates.reset();
    }
  }

  // ------------------------------------------------------------ library

  /** Which library project is open; null until the saved project is read. */
  private projectId: string | null = null;
  /** The open project has an entry in the library (an empty new one doesn't, yet). */
  private projectKept = false;

  /** Startup: the open project is the library's current one (work from before the library is kept now). */
  private async attachLibrary(): Promise<void> {
    let id = await currentProjectId();
    if (!id) {
      id = newProjectId();
      await setCurrentProject(id);
    }
    this.projectId = id;
    this.projectKept = (await libraryEntries()).some(e => e.id === id);
    // The library's copy follows when the app goes to the background (the
    // autosave holds the newest state meanwhile, and is copied in at the next
    // start if need be) - no extra saving or drawing while modelling.
    this.store.onSaved = text => document.visibilityState === 'hidden' && void this.keepInLibrary(text);
    // Its newest state is the autosave (a page closed mid-save left the library a step behind).
    const text = JSON.stringify(this.store.doc);
    // (No picture: nothing is drawn yet.)
    if ((this.projectKept || this.store.features.length) && (await projectText(id)) !== text) {
      this.projectKept = true;
      await keepProject(id, this.store.doc.name, text);
    }
  }

  /** The open project into the library: with a new picture of the view now and then (it costs a moment). */
  private async keepInLibrary(text: string, picture = false): Promise<void> {
    const id = this.projectId;
    if (!id || (!this.projectKept && !this.store.features.length)) {
      return;
    }
    // A new picture: opening the gallery, leaving the project, or the app going to the background.
    const snap = picture || document.visibilityState === 'hidden';
    this.projectKept = true;
    await keepProject(id, this.store.doc.name, text, snap ? this.viewPicture() : undefined);
  }

  /** A small picture of the model (as the view looks at it, framed to fit), for the library. */
  private viewPicture(): string | undefined {
    try {
      return this.view.snapshot(320, 240, getComputedStyle(document.body).backgroundColor || '#2b2d31');
    } catch {
      return undefined;
    }
  }

  /** Close the open project (it's kept, with a fresh picture) and open another. */
  private async switchProject(doc: ProjectDoc, id: string): Promise<void> {
    this.setTool(null);
    this.setSection(null);
    this.isolate(null);
    if (this.projectId) {
      await this.keepInLibrary(JSON.stringify(this.store.doc), true);
    }
    const kept = (await libraryEntries()).some(e => e.id === id);
    await setCurrentProject(id);
    // The id and the document change together: an autosave due meanwhile went to the old project.
    this.projectId = id;
    this.projectKept = kept;
    // The last one's rebuild, if it is still going, is no use now: dropped, not waited for
    // (opening a small project while a guitar was still being built took the guitar's 90 s).
    if (this.kernel.running) {
      this.kernel.stop();
    }
    this.store.openDoc(doc);
    // A new one starts from the default view (not looking up from below, as the last was left).
    if (!doc.features.length) {
      this.view.cam.iso();
    }
    setTimeout(() => this.fit(), 400);
  }

  /** File → Open: the projects kept on this device, and Open file… for any other. */
  /** Full screen from the projects window (null: not offered here). */
  private fullscreen: { isFull(): boolean; toggle(): void } | null = null;

  private async showProjects(welcome = false, starting = false): Promise<void> {
    // The open one with its picture as it looks now (starting: nothing has changed, nor is it drawn yet).
    if (this.projectId && !starting) {
      await this.keepInLibrary(JSON.stringify(this.store.doc), true);
    }
    const entries = await libraryEntries();
    showLibrary(entries, this.projectId, {
      open: id => void this.openKept(id),
      tutorial: () => (this.tutorialAsked(), this.startTutorial()),
      newProject: () => void this.newProject(),
      openFile: () => this.open(),
      download: id => void this.downloadKept(id),
      remove: id => forgetProject(id),
      rename: async (id, current) => {
        const name = (await this.ui.dialog('Rename project', [{ key: 'name', label: 'Name', value: current }]))?.name.trim();
        if (!name || name === current) {
          return null;
        }
        // The open one through its document (the top bar and its autosave follow).
        if (id === this.projectId) {
          this.store.commit(draft => (draft.name = name));
        } else {
          await renameProject(id, name);
        }

        return name;
      }
    }, { welcome, fullscreen: this.fullscreen, onClose: welcome ? () => this.offerTutorial() : undefined });
  }

  /** The tutorial has been offered on this device (or begun): it isn't offered again. */
  private tutorialAsked(): void {
    try {
      localStorage.setItem('sg.tutorialAsked', '1');
    } catch {
      /* a private window: asked again next time */
    }
  }

  /**
   * The first time the app is opened on a device, once the welcome window is closed: would they like the tutorial?
   * Asked once, whatever the answer (More > Tutorial has it from then on). (Asked for: "a popup only for the first
   * time someone opens the app, after they close the welcome window, that asks them if they want to start the
   * tutorial".)
   */
  private offerTutorial(): void {
    let asked = true;
    try {
      asked = localStorage.getItem('sg.tutorialAsked') === '1';
    } catch {
      /* no storage: not offered (it would be offered every time) */
    }
    if (asked) {
      return;
    }
    this.tutorialAsked();
    // (After what closing the window started - a new project, a file being opened - has had its turn.)
    setTimeout(() => {
      // (The welcome window was closed by its own Tutorial button: the tutorial is running, there is nothing to
      // ask - the question came up over it, where the tutorial lets nothing be tapped but its lit spot. Reported:
      // "now i cant do the tutorial on PC. i cant click draw", in a private window - a first visit.)
      if (this.tutorial?.running) {
        return;
      }
      const back = el('div', 'dialog-back');
      const box = el('div', 'dialog tutorial-ask');
      box.append(el('div', 'panel-title', 'New here?'), el('div', 'tutorial-ask-text', 'The tutorial builds a bolt and the nut that fits it with you, one tap at a time. It takes a few minutes.'));
      const row = el('div', 'dialog-actions');
      const no = el('button', 'text-btn', 'Not now');
      const yes = el('button', 'text-btn primary', 'Start the tutorial');
      const close = () => back.remove();
      no.addEventListener('click', close);
      yes.addEventListener('click', () => (close(), this.startTutorial()));
      row.append(no, yes);
      box.append(row, el('div', 'tutorial-ask-note', 'It is under More > Tutorial whenever you want it.'));
      back.append(box);
      document.body.append(back);
    }, 350);
  }

  private async openKept(id: string): Promise<void> {
    const text = await projectText(id);
    if (!text) {
      return this.ui.toast("That project couldn't be read", 'error');
    }
    try {
      await this.switchProject(parseProject(text), id);
    } catch (err) {
      this.ui.toast(`Could not open: ${(err as Error).message}`, 'error');
    }
  }

  private async downloadKept(id: string): Promise<void> {
    const text = await projectText(id);
    const e = (await libraryEntries()).find(libraryEntry => libraryEntry.id === id);
    if (text && e) {
      download(new Blob([text], { type: 'application/json' }), `${e.name}.super`);
    }
  }

  private open(): void {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = acceptFor('.super,.tessel,application/json');
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) {
        return;
      }
      try {
        const doc = parseProject(await file.text());
        doc.name = file.name.replace(/\.(super|tessel)$/i, '');
        // A project of its own in the library (the open one is kept as it was).
        await this.switchProject(doc, newProjectId());
      } catch (err) {
        this.ui.toast(`Could not open: ${(err as Error).message}`, 'error');
      }
    };
    input.click();
  }
}
