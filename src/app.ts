import { FeatureOp } from './tools/featureOp';
import { SelectTool } from './tools/select';
import { sectionPlane, SectionTool, type SectionState } from './tools/section';
import { FreeformTool } from './tools/freeform';
import { add, dist, scale } from './geom';
import { bodyCenter, ThreadOp, TransformOp } from './tools/ops';
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
import { isTouchDevice } from './device';
import { SketchTool } from './tools/sketch';
import { Tutorial } from './ui/tutorial';
import { AssemblyTool } from './assembly/assemblyTool';
import { keepSizes } from './doc/unitChange';
import { bodiesOf, faceRefOf, sameSel, sourceFrame, sourcesOf, type AppContext, type Sel, type Tool } from './tools/tool';
import { setupRightColumn } from './ui/panels';
import { UI } from './ui/ui';
import { Sentence } from './ui/sentence';
import { Ghost } from './tools/ghost';
import { arrangement, drawnRegions, materialRegions } from './sketch/regions';
import { evaluate, setUnits, setVariables, fmtLen } from './units';
import { InputRouter } from './view/input';
import { pickTolerance } from './device';
import { ViewCube } from './view/viewcube';
import { PivotButton } from './ui/pivot';
import { icons } from './ui/icons';
import { Updates } from './ui/update';
import { Exporter } from './app/exporting';
import { History } from './app/history';
import { Keys } from './app/keys';
import { Scene } from './app/scene';
import { Menus } from './app/menus';
import { Topbar } from './app/topbar';
import { Projects } from './app/projects';
import { isHeadset, screenClass } from './device';
import { Viewport } from './view/viewport';
import { VRMode, vrSupported } from './view/xr';
import type { ToolItem } from './ui/ui';
import type { RegenResult } from './kernel/protocol';
import type { Feature, PinDef, PlaneDef, SketchEntity, SketchFeature, Units, Vec3 } from './doc/types';

export class App implements AppContext {
  readonly store = new DocStore();
  readonly kernel = new KernelClient();
  readonly view: Viewport;
  readonly ui = new UI();
  readonly projects = new Projects(this);
  private readonly history = new History(this);
  private readonly keys = new Keys(this);
  private readonly scene = new Scene(this);
  private readonly menus = new Menus(this);
  private readonly topbar = new Topbar(this);
  readonly exporter = new Exporter(this);
  /** The sentence bar: the pick, then what it offers, on one line - the way to the tools. */
  sentence!: Sentence;
  /** The look ahead a tool under the pointer is showing on the model (see ghost.ts). */
  private peekGhost: Ghost | null = null;
  /** Where the view was last tapped (the sentence bar starts a sketch tool that acts where it is tapped right there). */
  private lastTapAt: { x: number; y: number; type: 'mouse' | 'pen' | 'touch' } | null = null;
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
    this.keys.attach();
    // A phone may drop the page once it's in the background: save now, undo steps included.
    document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && void this.store.flush());
    window.addEventListener('pagehide', () => void this.store.flush());
    this.topbar.attach();
    this.tool.enter?.();

    this.ui.setStatus('Loading geometry kernel…');
    const loaded = this.store.load().then(() => this.projects.attach());
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
          await this.projects.keep(JSON.stringify(this.store.doc), true);
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
    } else {
      // Not made - stopped, or overtaken: the next change asks again, whatever it is.
      this.madeFor = '';
    }
  }

  private apply(result: RegenResult, features: readonly Feature[]): void {
    this.result = result;
    this.scene.solved = new WeakMap();
    if (result.sketchEntities) {
      const moved = result.sketchEntities;
      for (const feature of features) {
        if (moved[feature.id]) {
          this.scene.solved.set(feature, moved[feature.id]);
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
    this.scene.refreshConstruction(features);
    this.scene.refreshSketches(features);
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
    this.history.render();
    this.items.render(result);
    this.showVariableTags();
    const open = this.history.openBodies(result);
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

  private refreshHighlights(): void {
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

  // ------------------------------------------------------------ files

  /**
   * Undo: a tool with steps of its own (a freeform cage being shaped) takes
   * those back, and leaves the project alone while it's open - Ctrl+Z used to
   * throw the whole cage edit away and undo the step before it too.
   */
  undo(): void {
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
  redo(): void {
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

  updateUndo(): void {
    const t = this.tool?.undo ? this.tool : null;
    (document.getElementById('undo-btn') as HTMLButtonElement).disabled = t ? !t.canUndo : !this.store.canUndo;
    (document.getElementById('redo-btn') as HTMLButtonElement).disabled = t ? !t.canRedo : !this.store.canRedo;
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
