// The drawing workspace: the sheet in the middle; its tools at the left
// (views, dimensions, notes, delete, exit); its properties at the right
// (sheet, scale, projection, title block, dimension style, line widths).
// Tap an edge with a dimension tool and its dimension is there; drag a view,
// a dimension or a note to move it. Everything is saved with the project and
// undoes like any other change. The sheet itself is made in drawingSheet.ts.

import { icons, type IconName } from '../ui/icons';
import { el, textButton } from '../ui/ui';
import { textField as typingBox } from '../ui/textField';
import { UNIT_MM } from '../units';
import { sheetToDXF } from '../io/sheetDxf';
import { zip } from '../io/threemf';
import { SheetCamera } from './sheetCamera';
import { measureBodies } from './bimTool';
import { partsList, printPage, type PartRow } from './sheet';
import {
  arrangeDims,
  drawingsOf,
  putDrawing,
  sheetSettings,
  sheetViewSpecs,
  isOverall,
  overallDims,
  annId,
  drawingOptions,
  drawingSVG,
  dateText,
  edgeAt,
  extent,
  fromPaper,
  moveKey,
  nextLetter,
  outward,
  placeDir,
  pointAt,
  scaleLabel,
  SCALES,
  extraName,
  isIsoView,
  minMax,
  ORIENTS,
  SHEETS,
  type Ent,
  sheetSize,
  spacedOffset,
  specOf,
  toPaper,
  VIEW_NAMES,
  VIEW_SPECS,
  type EdgeHit,
  type Layout,
  type Opts,
  type SheetSize
} from './drawingSheet';
import type { AppContext } from '../tools/tool';
import type { ProjectedView, ViewSpec } from '../kernel/protocol';
import type { DimText, DrawingDim, DrawingMark, DrawingNote, DrawingOptions, ProjectDoc, ProjectInfo, ViewOrient } from '../doc/types';

type ToolId =
  | 'length'
  | 'distance'
  | 'pointLine'
  | 'lineLine'
  | 'angle'
  | 'angle3'
  | 'arcAngle'
  | 'minmax'
  | 'radius'
  | 'diameter'
  | 'note'
  | 'section'
  | 'detail'
  | 'base'
  | 'projection'
  | 'center'
  | 'cline'
  | 'clineLines'
  | 'cross';
const TOOL_HINT: Record<ToolId, string> = {
  arcAngle: 'Tap an arc for the angle it goes round',
  minmax: 'Tap a point, an edge or a circle, then another: the distance between them (nearest; Max in the bar for the farthest)',
  base: 'Tap where the view goes',
  projection: 'Tap the view to project from (not an isometric one or a detail)',
  length: 'Tap a straight edge to dimension its length',
  distance: 'Tap a point (a corner, the middle of an edge, a centre), then another: the distance between them',
  pointLine: 'Tap a point, then a straight edge: the distance square to it',
  lineLine: 'Tap a straight edge, then one parallel to it: the distance between them',
  angle: 'Tap a straight edge, then another: the angle between them',
  angle3: 'Tap a point, then the corner the angle is at, then another point',
  radius: 'Tap a circle or an arc for its radius',
  diameter: 'Tap a circle or an arc for its diameter',
  note: 'Tap an edge for a note that points at it, or the empty paper for a note on its own',
  section: 'Tap where the cut line starts on a view (corners, middles and centres snap)',
  detail: 'Tap the middle of the area to show bigger',
  center: 'Tap a circle or an arc for its centre mark',
  cline: 'Tap a point, then another: a centreline through them',
  clineLines: 'Tap a straight edge, then the one opposite it: the centreline between them',
  cross: "Tap a straight edge, then another: a mark where they'd meet (a rounded corner's sharp corner)"
};

type P2 = [number, number];
/** A point or an edge picked on a view, on the way to a dimension, a section, a centreline. */
type Pick = { view: string; p: P2; line?: { a: P2; b: P2 }; ent?: Ent };
const sub2 = (a: P2, b: P2): P2 => [a[0] - b[0], a[1] - b[1]];
const len2 = (a: P2) => Math.hypot(a[0], a[1]);
const unit2 = (a: P2): P2 => {
  const length = len2(a) || 1;

  return [a[0] / length, a[1] / length];
};
/** The point of the line through a and b nearest `point`. */
const foot = (point: P2, a: P2, b: P2): P2 => {
  const ab = sub2(b, a);
  const t = ((point[0] - a[0]) * ab[0] + (point[1] - a[1]) * ab[1]) / (ab[0] * ab[0] + ab[1] * ab[1] || 1);

  return [a[0] + ab[0] * t, a[1] + ab[1] * t];
};
const cross2 = (a: P2, b: P2) => a[0] * b[1] - a[1] * b[0];
/** Two edges this close to parallel (sin of 1°) are taken as parallel. */
const PARALLEL = Math.sin(Math.PI / 180);

/** The drawing open last (Drawings opens it again). */
let lastOpened: string | null = null;

/**
 * A drawing of the project: `which` (an id), or "new" for one more, or the
 * one open last (else the first; a project with none: its first, new).
 */
export async function openDrawing(app: AppContext, which?: string): Promise<void> {
  document.querySelector('.bim-sheet')?.remove();
  const store = app.store;
  const existing = drawingsOf(store.doc);
  // Bodies picked as Drawings is tapped: their drawing (the one of just them; a new one if there's none).
  const picked = which ? [] : [...new Set(app.selection.flatMap(highlight => ('body' in highlight ? [highlight.body] : [])))];
  const bodyName = (id: string) => store.doc.names?.[id] ?? app.view.bodyList.find(b => b.id === id)?.name ?? 'Body';
  const pickedTitle = picked.length ? picked.map(bodyName).join(', ') : '';
  const ofPicked = picked.length ? existing.find(drawing => drawing.bodies?.length === picked.length && picked.every(id => drawing.bodies!.includes(id))) : undefined;
  const want = which === 'new' ? null : picked.length ? (ofPicked ?? null) : (existing.find(drawing => drawing.id === (which ?? lastOpened)) ?? existing[0] ?? null);
  /** Which drawing this is. */
  const current = want?.id ?? annId('drawing');
  // Picked bodies with no drawing of their own, beside other drawings: one made now, set out like the last one.
  if (!want && picked.length && existing.length) {
    const like = existing.find(drawing => drawing.id === lastOpened) ?? existing[existing.length - 1];
    store.commit(draft => putDrawing(draft, current, { ...sheetSettings(like), title: pickedTitle, bodies: picked }));
    app.ui.toast(`A new drawing of ${pickedTitle}`);
  }
  lastOpened = current;
  const curDrawing = (): DrawingOptions | undefined => drawingsOf(store.doc).find(drawing => drawing.id === current);

  // A new drawing: its preferences asked first (and nothing kept if they're cancelled).
  const fresh = !curDrawing();
  /** A new drawing: its own title to start with (the picked bodies', or the project's and its number). */
  const startTitle = fresh ? pickedTitle || (existing.length ? `${store.doc.name || 'Untitled'} ${existing.length + 1}` : undefined) : undefined;

  // ---- The workspace
  const back = el('div', 'bim-sheet bim-drawing');
  const bar = el('div', 'bim-sheet-bar');
  const name = el('span', 'bim-sheet-name', 'Drawing');
  const print = el('button', 'text-btn', 'Print / PDF');
  const svgBtn = el('button', 'text-btn', 'SVG');
  const dxfBtn = el('button', 'text-btn', 'DXF');
  dxfBtn.title = 'This drawing as a DXF file (for CAD programs)';
  const propsBtn = el('button', 'text-btn on', 'Properties');
  const close = el('button', 'bim-close');
  close.innerHTML = icons.close;
  close.title = 'Exit Drawing';
  close.setAttribute('aria-label', 'Exit Drawing');
  bar.append(name, print, svgBtn, dxfBtn, propsBtn, close);
  const work = el('div', 'bim-dwork');
  const tools = el('div', 'bim-dtools');
  const stage = el('div', 'bim-dstage');
  const paper = el('div', 'bim-drawing-paper');
  const hint = el('div', 'bim-dhint');
  hint.hidden = true;
  stage.append(paper, hint);
  const props = el('div', 'bim-props');
  work.append(tools, stage, props);
  back.append(bar, work);
  document.body.append(back);
  paper.append(el('div', 'bim-sub', 'Drawing the views…'));

  // ---- Zoom and move round the sheet: the wheel or two fingers zoom where
  // they are; dragging the empty paper (or with the middle or right button)
  // moves it; a double tap on the empty paper goes closer there, or back to
  // all of it. Only the SVG's viewBox changes (the sheet isn't drawn again).
  const camera = new SheetCamera();
  const zoomBox = el('div', 'bim-dzoom');
  const zoomOut = el('button', 'bim-dzoom-btn', '−');
  const zoomLabel = el('button', 'bim-dzoom-btn bim-dzoom-fit', '100%');
  const zoomIn = el('button', 'bim-dzoom-btn', '+');
  zoomOut.title = 'Zoom out (−)';
  zoomLabel.title = 'All of the sheet (F)';
  zoomIn.title = 'Zoom in (+)';
  zoomBox.append(zoomOut, zoomLabel, zoomIn);
  stage.append(zoomBox);
  const applyCamera = () => {
    paper.querySelector('svg')?.setAttribute('viewBox', camera.viewBox());
    zoomLabel.textContent = `${Math.round(camera.ratio() * 100)}%`;
    placeHandle();
    drawHover();
  };
  /** A screen point (px) in the paper's area. */
  const local = (e: { clientX: number; clientY: number }): [number, number] => {
    const rect = paper.getBoundingClientRect();

    return [e.clientX - rect.left, e.clientY - rect.top];
  };
  const copyCamera = () => Object.assign(new SheetCamera(), { vw: camera.vw, vh: camera.vh, sheetWidth: camera.sheetWidth, sheetHeight: camera.sheetHeight, z: camera.z, cx: camera.cx, cy: camera.cy });
  let glide = 0;
  /** To another zoom smoothly (a fifth of a second). */
  const glideTo = (to: { z: number; cx: number; cy: number }, fitted = false) => {
    cancelAnimationFrame(glide);
    const from = camera.state;
    const t0 = performance.now();
    const step = (t: number) => {
      const progress = Math.min(1, (t - t0) / 180);
      camera.blend(from, to, 1 - Math.pow(1 - progress, 3));
      camera.fitted = fitted && progress === 1;
      applyCamera();
      if (progress < 1) {
        glide = requestAnimationFrame(step);
      }
    };
    glide = requestAnimationFrame(step);
  };
  const fitAll = () => {
    const camera = copyCamera();
    camera.fit();
    glideTo(camera.state, true);
  };
  const zoomBy = (factor: number, at: [number, number] = [camera.vw / 2, camera.vh / 2]) => {
    const camera = copyCamera();
    camera.zoomAt(at[0], at[1], factor);
    glideTo(camera.state);
  };
  zoomOut.addEventListener('click', () => zoomBy(1 / 1.5));
  zoomIn.addEventListener('click', () => zoomBy(1.5));
  zoomLabel.addEventListener('click', fitAll);
  /** The area's exact size (not rounded to whole pixels: the paper under the cursor would creep). */
  const sizeCamera = () => {
    const rect = paper.getBoundingClientRect();
    camera.resize(rect.width, rect.height);
  };
  const resized = new ResizeObserver(() => {
    sizeCamera();
    applyCamera();
  });
  resized.observe(paper);
  paper.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      cancelAnimationFrame(glide);
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
      const at = local(e);
      // A touchpad swiped sideways moves the sheet; a wheel (or a touchpad pinch: ctrl) zooms, about 8 % a notch.
      if (!e.ctrlKey && !e.metaKey && Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        camera.panBy(-e.deltaX * unit, -e.deltaY * unit);
      } else {
        camera.zoomAt(at[0], at[1], Math.exp(-e.deltaY * unit * (e.ctrlKey ? 0.01 : 0.0008)));
      }
      applyCamera();
    },
    { passive: false }
  );
  // The right button moves the sheet (no menu).
  paper.addEventListener('contextmenu', e => e.preventDefault());

  // ---- A picked view: a handle in its middle to move it by, and its scale
  // under it (tap for the list). Screen-sized, whatever the zoom; it rides
  // on the paper (put back after each redraw) and follows the camera.
  const handle = el('div', 'bim-dhandle');
  const grip = el('div', 'bim-dhandle-grip');
  grip.innerHTML = icons.move;
  grip.title = 'Drag to move the view';
  const chip = el('select', 'bim-dhandle-scale');
  chip.title = "The view's scale";
  handle.append(grip, chip);
  handle.hidden = true;
  const placeHandle = () => {
    const id = !tool && selected?.startsWith('view:') ? selected.slice(5) : null;
    const placed = id ? layout?.views.find(view => view.id === id) : undefined;
    if (!placed) {
      handle.hidden = true;

      return;
    }
    const bounds = extent(placed);
    const [x, y] = camera.toScreen((bounds.x0 + bounds.x1) / 2, (bounds.y0 + bounds.y1) / 2);
    handle.hidden = false;
    handle.style.transform = `translate(${x}px, ${y}px)`;
  };

  let views = new Map<string, ProjectedView>();
  let parts: PartRow[] = [];
  let allParts: PartRow[] = [];
  let layout: Layout | null = null;
  let tool: ToolId | null = null;
  let selected: string | null = null;
  let picks: Pick[] = [];
  /** While dragging: the drawing as it would be (committed when let go). */
  let draft: DrawingOptions | null = null;
  /** Where each item number's circle is drawn now (dragged from there). */
  let balloonsNow: { id: string; x: number; y: number }[] = [];
  /** Where the one being dragged started. */
  let balloonFrom: [number, number] | null = null;
  const date = new Date();
  /** The sheet as printed or saved (made then: each redraw needn't). */
  const sheetOut = () => drawingSVG({ doc: docNow(), views, parts, date }).svg;

  /** The project as this drawing sees it: this drawing as its one (while dragging: as it would be). */
  const docNow = (): ProjectDoc => ({ ...store.doc, drawing: draft ?? curDrawing() ?? (startTitle ? { title: startTitle } : {}) });
  const opts = (): Opts => drawingOptions(docNow());
  const set = (patch: Partial<DrawingOptions>) =>
    store.commit((draft) => {
      const now = drawingsOf(draft).find(drawing => drawing.id === current) ?? (startTitle ? { title: startTitle } : {});
      const next: DrawingOptions = { ...now, ...patch };
      for (const key of Object.keys(next) as (keyof DrawingOptions)[]) {
        if (next[key] === undefined) {
          delete next[key];
        }
      }
      putDrawing(draft, current, next);
    });

  const shut = () => {
    resized.disconnect();
    cancelAnimationFrame(glide);
    back.remove();
    window.removeEventListener('keydown', onKey, true);
    off();
  };
  close.addEventListener('click', shut);

  // ---- Kernel: the views of the bodies drawn.
  const load = async () => {
    paper.innerHTML = '';
    const status = el('div', 'bim-sub', 'Measuring the bodies…');
    paper.append(status);
    try {
      allParts = partsList(app, await measureBodies(app));
      const want = opts().bodies?.filter(id => allParts.some(allPart => allPart.id === id));
      parts = want?.length ? allParts.filter(allPart => want.includes(allPart.id)) : allParts;
      if (!parts.length) {
        paper.innerHTML = '';
        paper.append(el('div', 'bim-sub', 'No bodies to draw: make one first (hidden bodies are left off the drawing).'));

        return;
      }
      views = new Map();
      failed.clear();
      // One view at a time, saying how far it got (a big assembly takes seconds a view).
      const first = wanted();
      const list = first.length ? first : VIEW_SPECS.slice(0, 1);
      const got: ProjectedView[] = [];
      for (const [i, viewSpec] of list.entries()) {
        status.textContent = `Drawing the views: ${i + 1} of ${list.length}…`;
        got.push(...(await app.kernel.drawing(store.doc.features as never, [viewSpec], parts.map(part => part.id))));
      }
      views = new Map(got.map(projectedView => [projectedView.id, projectedView]));
      drawnAs.clear();
      for (const viewSpec of list) {
        drawnAs.set(viewSpec.id, JSON.stringify(viewSpec));
      }
    } catch (err) {
      paper.innerHTML = '';
      paper.append(el('div', 'bim-sub', `The views could not be drawn: ${err instanceof Error ? err.message : String(err)}`));

      return;
    }
    render();
  };

  // ---- Only the views the sheet shows are drawn (a big assembly takes seconds
  // a view); one switched on later, the other side view, a section, is drawn then.
  const failed = new Set<string>();
  /** What each drawn view was drawn as (a section flipped is drawn again). */
  const drawnAs = new Map<string, string>();
  let fetching = false;
  const wanted = (): ViewSpec[] => sheetViewSpecs(opts());
  const fetchMissing = async () => {
    const miss = wanted().filter(viewSpec => (!views.has(viewSpec.id) || drawnAs.get(viewSpec.id) !== JSON.stringify(viewSpec)) && !failed.has(JSON.stringify(viewSpec)));
    if (!miss.length || fetching) {
      return;
    }
    fetching = true;
    const of = views;
    name.textContent = `Drawing · ${opts().title} · drawing the views…`;
    try {
      const got = await app.kernel.drawing(store.doc.features as never, miss, parts.map(part => part.id));
      if (of !== views) {
        return;
      }
      for (const projectedView of got) {
        views.set(projectedView.id, projectedView);
      }
      for (const viewSpec of miss) {
        drawnAs.set(viewSpec.id, JSON.stringify(viewSpec));
      }
    } catch {
      for (const viewSpec of miss) {
        failed.add(JSON.stringify(viewSpec));
      }
    } finally {
      fetching = false;
    }
    if (of === views) {
      render();
    } else {
      void fetchMissing();
    }
  };

  // ---- The sheet
  const render = () => {
    if (!views.size) {
      return;
    }
    void fetchMissing();
    const doc = docNow();
    const made = drawingSVG({ doc, views, parts, date, interactive: true, selected });
    layout = made.layout;
    balloonsNow = made.balloons;
    paper.innerHTML = made.svg;
    const element = paper.querySelector('svg');
    if (element) {
      // The sheet fills the area; what of it is seen is the camera's.
      const vb = element.viewBox.baseVal;
      camera.setSheet(vb.width, vb.height);
      if (camera.vw <= 1) {
        sizeCamera();
      }
      element.setAttribute('width', '100%');
      element.setAttribute('height', '100%');
      element.setAttribute('preserveAspectRatio', 'xMidYMid meet');
      element.classList.add('bim-drawing-svg');
      paper.append(handle);
      applyCamera();
    }
    if (!fetching) {
      name.textContent = `Drawing · ${drawingOptions(doc).title}`;
    }
    // Its number or its words are what a dimension or a note is grabbed by: a see-through pad round each, a finger
    // wide on the screen (the text of a dimension is 3 mm tall on the paper - a few pixels with the sheet all in view).
    if (element) {
      const pad = Math.max(1.2, tolerance() * 0.6);
      for (const svgGroup of Array.from(element.querySelectorAll<SVGGElement>('[data-ann]'))) {
        for (const tx of Array.from(svgGroup.querySelectorAll<SVGTextElement>('text'))) {
          let b: DOMRect;
          try {
            b = tx.getBBox();
          } catch {
            continue;
          }
          if (!b.width && !b.height) {
            continue;
          }
          const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
          rect.setAttribute('x', String(b.x - pad));
          rect.setAttribute('y', String(b.y - pad));
          rect.setAttribute('width', String(b.width + pad * 2));
          rect.setAttribute('height', String(b.height + pad * 2));
          rect.setAttribute('fill', 'transparent');
          rect.setAttribute('class', 'bim-ann-pad');
          const tf = tx.getAttribute('transform');
          if (tf) {
            rect.setAttribute('transform', tf);
          }
          tx.before(rect);
        }
      }
    }
    if (element) {
      element.insertAdjacentHTML('beforeend', picksSVG());
    }
    hoverKey = '';
    drawHover();
    if (!draft) {
      (renderTools(), renderProps(), showSelection());
    }
  };
  /** What the tool has picked so far, shown on the sheet. */
  const picksSVG = (): string => {
    if (!tool || !picks.length || !layout) {
      return '';
    }
    const at = (pick: Pick) => {
      const view = layout!.views.find(placed => placed.id === pick.view);

      return view ? toPaper(view, pick.p) : null;
    };
    const blue = 'stroke="#1a73e8" stroke-width="0.5" fill="none"';
    let out = '';
    if (tool === 'detail' && picks.length === 2) {
      const center = at(picks[0]);
      const view = layout.views.find(placed => placed.id === picks[0].view);
      if (center && view) {
        out += `<circle cx="${center[0]}" cy="${center[1]}" r="${picks[1].p[0] * view.s}" ${blue} stroke-dasharray="2 1"/>`;
      }
    }
    if (tool === 'section' && picks.length === 2) {
      const a = at(picks[0]);
      const b = at(picks[1]);
      if (a && b) {
        out += `<path d="M${a[0]} ${a[1]}L${b[0]} ${b[1]}" ${blue} stroke-dasharray="4 1 1 1"/>`;
      }
    }
    for (const pick of picks) {
      if (tool === 'detail' && pick === picks[1]) {
        continue;
      }
      const view = layout.views.find(placed => placed.id === pick.view);
      if (pick.line && view) {
        const a = toPaper(view, pick.line.a);
        const b = toPaper(view, pick.line.b);
        out += `<path d="M${a[0]} ${a[1]}L${b[0]} ${b[1]}" stroke="#1a73e8" stroke-width="0.8"/>`;
      } else {
        const center = at(pick);
        if (center) {
          out += `<circle cx="${center[0]}" cy="${center[1]}" r="1" fill="#1a73e8"/>`;
        }
      }
    }

    return out;
  };
  const off = store.onChange(() => {
    if (!draft) {
      render();
    }
  });

  // ---- Where the pointer is on the paper (mm)
  const sheetPoint = (e: { clientX: number; clientY: number }): [number, number] | null => {
    const element = paper.querySelector('svg');
    const screenMatrix = element?.getScreenCTM();
    if (!element || !screenMatrix) {
      return null;
    }
    const point = new DOMPoint(e.clientX, e.clientY).matrixTransform(screenMatrix.inverse());

    return [point.x, point.y];
  };
  /** A point on the paper, on the screen. */
  const clientOf = (q: P2): P2 => {
    const screenMatrix = paper.querySelector('svg')?.getScreenCTM();
    if (!screenMatrix) {
      return [0, 0];
    }
    const point = new DOMPoint(q[0], q[1]).matrixTransform(screenMatrix);

    return [point.x, point.y];
  };
  /** 12 screen pixels, in mm on the paper. */
  const tolerance = () => 12 / camera.z;

  // ---- Tapping and dragging on the sheet
  let frame = 0;
  let drag: { id: number; x: number; y: number; target: string; moved: boolean; start: DrawingOptions; tap?: { q: P2; e: PointerEvent } } | null = null;
  /** The fingers (or the mouse) down on the paper, where they are (px). */
  const fingers = new Map<number, [number, number]>();
  let pinch: { d: number; mid: [number, number] } | null = null;
  let pan: { id: number; x: number; y: number; moved: boolean; deselect: boolean } | null = null;
  const pair = (): [[number, number], [number, number]] => {
    const [a, b] = [...fingers.values()];

    return [a, b];
  };
  const startPan = (e: PointerEvent, deselect: boolean) => {
    const [x, y] = local(e);
    pan = { id: e.pointerId, x, y, moved: false, deselect };
  };
  paper.addEventListener('pointerdown', (e) => {
    // The scale chip opens its own list.
    if ((e.target as Element).closest?.('.bim-dhandle-scale')) {
      return;
    }
    fingers.set(e.pointerId, local(e));
    try {
      paper.setPointerCapture(e.pointerId);
    } catch {
      // Already let go.
    }
    if (fingers.size >= 2) {
      // A second finger: no dragging of what the first one held; the two zoom and move the sheet.
      if (drag) {
        drag = null;
        draft = null;
        render();
      }
      pan = null;
      const [a, b] = pair();
      pinch = { d: Math.hypot(b[0] - a[0], b[1] - a[1]), mid: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] };
      cancelAnimationFrame(glide);

      return;
    }
    // The middle or right button: the sheet moves, whatever is under it.
    if (e.button === 1 || e.button === 2) {
      e.preventDefault();

      return startPan(e, false);
    }
    const q = sheetPoint(e);
    if (!q || !layout) {
      return;
    }
    if (tool) {
      // A dimension, a note or a picture already on the sheet, pressed with a tool still on: dragged from there it
      // moves (the tool stays on); just tapped, the tap is the tool's as ever. (A dimension is put on, and the next
      // thing a hand does is drag it where it reads well - which put on another, or did nothing.)
      const there = (e.target as Element).closest?.('[data-ann]')?.getAttribute('data-ann');
      if (there && !picks.length) {
        e.preventDefault();
        drag = { id: e.pointerId, x: q[0], y: q[1], target: there, moved: false, start: structuredClone(curDrawing() ?? {}), tap: { q, e } };

        return;
      }
      // Off the paper (the grey round it): nothing to pick, no note out there.
      const [sheetWidth, sheetHeight] = sheetSize(opts());
      if (q[0] < 0 || q[1] < 0 || q[0] > sheetWidth || q[1] > sheetHeight) {
        return;
      }

      return void useTool(q, e);
    }
    const t = e.target as Element;
    const onGrip = !!t.closest('.bim-dhandle-grip');
    const ann = t.closest('[data-ann]')?.getAttribute('data-ann');
    const view = t.closest('[data-view]')?.getAttribute('data-view');
    const target = onGrip ? selected : (ann ?? (view ? `view:${view}` : null));
    if (!target) {
      // The empty paper: dragged, it moves; tapped, nothing is picked any more.
      e.preventDefault();

      return startPan(e, true);
    }
    e.preventDefault();
    if (target !== selected) {
      // A tap picks it. A view: a drag from there moves the sheet, not it
      // (nothing big moves by accident while looking round); picked, it moves
      // by its handle. A dimension or note moves as soon as it's dragged.
      selected = target;
      if (!ann) {
        render();

        return startPan(e, false);
      }
    }
    // A picked view held anywhere but its handle: the sheet moves.
    if (target.startsWith('view:') && !onGrip) {
      return startPan(e, false);
    }
    drag = { id: e.pointerId, x: q[0], y: q[1], target, moved: false, start: structuredClone(curDrawing() ?? {}) };
    try {
      paper.setPointerCapture(e.pointerId);
    } catch {
      // Already let go.
    }
    render();
  });
  paper.addEventListener('pointermove', (e) => {
    if (fingers.has(e.pointerId)) {
      fingers.set(e.pointerId, local(e));
    }
    // A mouse or pen over the sheet with a tool on: what a tap would take lights up.
    if (tool && !pan && !pinch && e.pointerType !== 'touch') {
      hoverClient = { clientX: e.clientX, clientY: e.clientY };
      drawHover();
    }
    if (pinch && fingers.size >= 2) {
      const [a, b] = pair();
      const distance = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const mid: [number, number] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      camera.panBy(mid[0] - pinch.mid[0], mid[1] - pinch.mid[1]);
      if (pinch.d > 0 && distance > 0) {
        camera.zoomAt(mid[0], mid[1], distance / pinch.d);
      }
      pinch = { d: distance, mid };
      applyCamera();

      return;
    }
    if (pan && e.pointerId === pan.id) {
      const [x, y] = local(e);
      if (!pan.moved && Math.hypot(x - pan.x, y - pan.y) < 4) {
        return;
      }
      if (!pan.moved) {
        cancelAnimationFrame(glide);
      }
      pan.moved = true;
      paper.classList.add('panning');
      camera.panBy(x - pan.x, y - pan.y);
      pan.x = x;
      pan.y = y;
      applyCamera();

      return;
    }
    if (!drag || e.pointerId !== drag.id || !layout) {
      return;
    }
    const q = sheetPoint(e);
    if (!q) {
      return;
    }
    // (A dimension, a note or a picture stays on the paper: dragged past its edge it stops there - one pulled off
    // the sheet was out of the print, and with a tool on could not be got back.)
    if (!drag.target.startsWith('view:')) {
      const [sheetWidth, sheetHeight] = sheetSize(opts());
      q[0] = Math.min(sheetWidth - 2, Math.max(2, q[0]));
      q[1] = Math.min(sheetHeight - 2, Math.max(2, q[1]));
    }
    const dx = q[0] - drag.x;
    const dy = q[1] - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < tolerance() / 4) {
      return;
    }
    if (!drag.moved) {
      balloonFrom = null;
    }
    drag.moved = true;
    const next: DrawingOptions = structuredClone(drag.start);
    const options = drawingOptions({ ...store.doc, drawing: drag.start });
    if (drag.target.startsWith('view:')) {
      const viewId = drag.target.slice(5);
      const sec = options.sections.find(section => section.id === viewId);
      const det = options.details.find(detail => detail.id === viewId);
      const ex = options.extra.find(drawingView => drawingView.id === viewId);
      const placed = layout.views.find(view => view.id === viewId);
      if (ex && (ex.orient || isIsoView(ex))) {
        // A base view or an isometric projection: anywhere.
        const at: P2 = ex.at ?? (placed ? [placed.x + ((placed.box[1][0] - placed.box[0][0]) * placed.s) / 2, placed.y + ((placed.box[1][1] - placed.box[0][1]) * placed.s) / 2] : [0, 0]);
        next.extra = options.extra.map(drawingView => (drawingView === ex ? { ...drawingView, at: [at[0] + dx, at[1] + dy] } : drawingView));
      } else if (ex && ex.dir && placed) {
        // A projection square on: along its line from its view only (it stays lined up).
        const vert = Math.abs(ex.dir[1]) >= Math.abs(ex.dir[0]);
        const along = vert ? dy * Math.sign(ex.dir[1]) : dx * Math.sign(ex.dir[0]);
        const half = (vert ? placed.box[1][1] - placed.box[0][1] : placed.box[1][0] - placed.box[0][0]) * placed.s * 0.5 + 8;
        next.extra = options.extra.map(drawingView => (drawingView === ex ? { ...drawingView, gap: Math.max(half, ex.gap ?? 0) + along } : drawingView));
      } else if (sec) {
        // A section slides along its line from its view only (it stays lined up).
        const pl = placeDir(sec, options);
        const along = Math.abs(pl[1]) >= Math.abs(pl[0]) ? dy * Math.sign(pl[1]) : dx * Math.sign(pl[0]);
        const placed = layout.views.find(view => view.id === sec.id);
        const half = placed ? (Math.abs(pl[1]) >= Math.abs(pl[0]) ? placed.box[1][1] - placed.box[0][1] : placed.box[1][0] - placed.box[0][0]) * placed.s * 0.5 + 16 : 0;
        next.sections = options.sections.map(section => (section === sec ? { ...section, gap: Math.max(half, sec.gap) + along } : section));
      } else if (det) {
        next.details = options.details.map(detail => (detail === det ? { ...detail, at: [det.at[0] + dx, det.at[1] + dy] } : detail));
      } else {
        const key = moveKey(viewId);
        const [mx, my] = options.moved[key] ?? [0, 0];
        next.moved = { ...options.moved, [key]: [mx + dx, my + dy] };
      }
    } else {
      const id = drag.target;
      if (id.startsWith('balloon:')) {
        // An item number: its circle goes where it is dragged (its line still runs to its part).
        if (!drag.moved || !balloonFrom) {
          const b = balloonsNow.find(balloon => balloon.id === id);
          balloonFrom = b ? [b.x, b.y] : [drag.x, drag.y];
        }
        next.balloonAt = { ...options.balloonAt, [id.slice(8)]: [balloonFrom[0] + dx, balloonFrom[1] + dy] };
      }
      const dim = dimsOf(options).find(dimension => dimension.id === id);
      const note = options.notes.find(note => note.id === id);
      const img = options.images.find(image => image.id === id);
      if (note) {
        next.notes = options.notes.map(drawingNote => (drawingNote === note ? { ...drawingNote, x: note.x + dx, y: note.y + dy } : drawingNote));
      }
      if (img) {
        next.images = options.images.map(image => (image === img ? { ...image, x: img.x + dx, y: img.y + dy } : image));
      }
      if (dim) {
        const view = layout.views.find(placed => placed.id === dim.view);
        if (view) {
          Object.assign(next, withDim(options, movedDim(dim, view, q, [dx, dy], dimsOf(options))));
        }
      }
    }
    draft = next;
    // Once a frame at most (a mouse moves more often than the screen shows).
    if (!frame) {
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (draft) {
          render();
        }
      });
    }
  });
  const endDrag = (e: PointerEvent) => {
    fingers.delete(e.pointerId);
    if (pinch) {
      // The pinch is over once a finger lifts (the other doesn't start a drag).
      if (fingers.size < 2) {
        pinch = null;
      }

      return;
    }
    if (pan && e.pointerId === pan.id) {
      const panStart = pan;
      pan = null;
      paper.classList.remove('panning');
      if (!panStart.moved && panStart.deselect && selected) {
        (selected = null), render();
      }

      return;
    }
    if (!drag || e.pointerId !== drag.id) {
      return;
    }
    const moved = drag.moved;
    const tap = drag.tap;
    drag = null;
    const drawingOptions = draft;
    draft = null;
    if (moved && drawingOptions) {
      store.commit(doc => putDrawing(doc, current, drawingOptions));
    } else if (tap && tool) {
      useTool(tap.q, tap.e);
    } else {
      render();
    }
  };
  paper.addEventListener('pointerup', endDrag);
  paper.addEventListener('pointercancel', endDrag);
  // A double tap: on a note, write it again; on a dimension, its text and tolerance; on the empty paper, see it closer (or all of it again).
  paper.addEventListener('dblclick', (e) => {
    if (tool) {
      return;
    }
    const id = (e.target as Element).closest('[data-ann]')?.getAttribute('data-ann');
    const note = opts().notes.find(note => note.id === id);
    if (note) {
      return noteInput([note.x, note.y], e.clientX, e.clientY, note);
    }
    const dimension = dimsOf(opts()).find(dimension => dimension.id === id);
    if (dimension) {
      return void editDim(dimension);
    }
    if ((e.target as Element).closest('[data-ann],[data-view],.bim-dhandle')) {
      return;
    }
    if (camera.ratio() < 1.5) {
      zoomBy(2.5, local(e));
    } else {
      fitAll();
    }
  });

  /**
   * A dimension dragged by (dx, dy) to q: a length's line out or in by as much
   * as the pointer went across it, its value along by as much as it went
   * along (back in the middle when near it); an angle's arc through q; a
   * circle's leader towards q.
   */
  const movedDim = (drawingDimension: DrawingDim, placed: Layout['views'][number], q: [number, number], by: [number, number], others: DrawingDim[] = []): DrawingDim => {
    if (drawingDimension.kind === 'angle' && drawingDimension.c) {
      const paperPoint = toPaper(placed, drawingDimension.c);

      return { ...drawingDimension, offset: Math.max(3, Math.hypot(q[0] - paperPoint[0], q[1] - paperPoint[1])) };
    }
    if (drawingDimension.c && drawingDimension.r !== undefined) {
      const paperPoint = toPaper(placed, drawingDimension.c);

      return { ...drawingDimension, angle: Math.atan2(q[1] - paperPoint[1], q[0] - paperPoint[0]), offset: Math.max(2, Math.hypot(q[0] - paperPoint[0], q[1] - paperPoint[1]) - drawingDimension.r * placed.s) };
    }
    if (!drawingDimension.b) {
      return drawingDimension;
    }
    const paperPointA = toPaper(placed, drawingDimension.a);
    const paperPointB = toPaper(placed, drawingDimension.b);
    const length = Math.hypot(paperPointB[0] - paperPointA[0], paperPointB[1] - paperPointA[1]) || 1;
    const along = [(paperPointB[0] - paperPointA[0]) / length, (paperPointB[1] - paperPointA[1]) / length];
    const normal = [along[1], -along[0]];
    const offset = drawingDimension.offset + by[0] * normal[0] + by[1] * normal[1];
    let slide = (drawingDimension.slide ?? 0) + by[0] * along[0] + by[1] * along[1];
    if (Math.abs(slide) < 2) {
      slide = 0;
    }
    // Never across what it measures (it flips side instead of sitting on it).
    const moved = { ...drawingDimension, offset: Math.abs(offset) < 2 ? 2 * (Math.sign(offset) || Math.sign(drawingDimension.offset) || 1) : offset, slide: slide || undefined };

    // In line with a parallel dimension, or evenly spaced from it.
    return { ...moved, offset: spacedOffset(moved, others, placed) };
  };

  // ---- The dimension and note tools
  const startTool = (t: ToolId | null) => {
    tool = t;
    picks = [];
    selected = null;
    hint.hidden = !t;
    paper.classList.toggle('picking', !!t);
    if (t) {
      showHint(TOOL_HINT[t]);
    }
    render();
  };
  const showHint = (msg: string) => {
    hint.innerHTML = '';
    const done = el('button', 'text-btn on', 'Done');
    done.addEventListener('click', () => startTool(null));
    hint.append(el('span', '', msg), done);
  };
  const addDim = (drawingDimension: DrawingDim) => {
    // The same edge (or circle) dimensioned again: the one it has is picked instead.
    const straight = (kind: string) => kind === 'length' || kind === 'distance';
    const near = (point?: [number, number], q?: [number, number]) => (!point && !q) || (!!point && !!q && Math.hypot(point[0] - q[0], point[1] - q[1]) < 1e-3);
    const same = opts().dims.find(
      dimension =>
        dimension.view === drawingDimension.view
        && (dimension.kind === drawingDimension.kind || (straight(dimension.kind) && straight(drawingDimension.kind)))
        && (drawingDimension.kind === 'radius' || drawingDimension.kind === 'diameter'
          ? near(dimension.c, drawingDimension.c) && Math.abs((dimension.r ?? 0) - (drawingDimension.r ?? 0)) < 1e-3
          : near(dimension.c, drawingDimension.c) && ((near(dimension.a, drawingDimension.a) && near(dimension.b, drawingDimension.b)) || (near(dimension.a, drawingDimension.b) && near(dimension.b, drawingDimension.a))))
    );
    if (same) {
      selected = same.id;
      render();

      return app.ui.toast('That one is dimensioned already');
    }
    set({ dims: [...opts().dims, drawingDimension] });
  };
  const placedOf = (id: string) => layout!.views.find(view => view.id === id)!;
  /** A point picked: a corner, a middle or a centre near the tap (in `view` if given). */
  const pointPick = (q: P2, view?: string): Pick | null => pointAt(views, layout!, q, tolerance() * 1.5, view);
  /** A point picked, or where the tap is on the view under it (not the isometric one, not a detail). */
  const freePick = (q: P2, view?: string): Pick | null => {
    const hit = pointPick(q, view);
    if (hit && !placedOf(hit.view).clip) {
      return hit;
    }
    for (const placed of layout!.views) {
      if (placed.iso || placed.clip || (view && placed.id !== view)) {
        continue;
      }
      const bounds = extent(placed);
      if (q[0] > bounds.x0 - 3 && q[0] < bounds.x1 + 3 && q[1] > bounds.y0 - 3 && q[1] < bounds.y1 + 3) {
        return { view: placed.id, p: fromPaper(placed, q) };
      }
    }

    return null;
  };
  const linePick = (q: P2, view?: string): (EdgeHit & { line: { a: P2; b: P2 } }) | null => {
    const hit = edgeAt(views, layout!, q, tolerance(), 'line');

    return hit && (!view || hit.view === view) ? { ...hit, line: { a: hit.a, b: hit.b } } : null;
  };
  const step = (msg: string) => (showHint(msg), render());

  // ---- What the tool would take, lit up under the pointer before the tap:
  // the edge, the circle or arc, the point (a corner, a middle, a centre), the view.
  const HOVER = '#2f8cff';
  /** Where the pointer is (screen), while it's over the sheet with a tool on. */
  let hoverClient: { clientX: number; clientY: number } | null = null;
  /** What is lit now (redrawn only when it changes). */
  let hoverKey = '';
  const hoverSVG = (q: P2): string => {
    if (!layout || !tool) {
      return '';
    }
    const view = picks[0]?.view;
    const px = 1 / camera.z;
    const round3 = (value: number) => Math.round(value * 1000) / 1000;
    const polyline = (pts: P2[]) => `<path d="${pts.map((point, i) => `${i ? 'L' : 'M'}${round3(point[0])} ${round3(point[1])}`).join('')}" stroke="${HOVER}" stroke-width="${round3(3.5 * px)}" stroke-linecap="round" stroke-linejoin="round" fill="none" opacity="0.85"/>`;
    const lineOf = (kind: string, a: P2, b: P2) => {
      const placed = placedOf(kind);

      return polyline([toPaper(placed, a), toPaper(placed, b)]);
    };
    const dot = (kind: string, pt: P2) => {
      const paperPoint = toPaper(placedOf(kind), pt);

      return `<circle cx="${round3(paperPoint[0])}" cy="${round3(paperPoint[1])}" r="${round3(5 * px)}" fill="${HOVER}" stroke="#fff" stroke-width="${round3(1.5 * px)}"/>`;
    };
    /** A circle, or an arc from a through m to b, in the view's own units. */
    const arc = (edgeHit: EdgeHit) => {
      const center = edgeHit.c!;
      const ang = (x: P2) => Math.atan2(x[1] - center[1], x[0] - center[0]);
      const TAU = Math.PI * 2;
      const turn = (t: number) => ((t % TAU) + TAU) % TAU;
      const whole = len2(sub2(edgeHit.a, edgeHit.b)) < 1e-12;
      const a0 = ang(edgeHit.a);
      const tm = edgeHit.m ? turn(ang(edgeHit.m) - a0) : 0;
      const tb = whole ? TAU : turn(ang(edgeHit.b) - a0);
      const sweep = whole || tm <= tb ? tb : tb - TAU;
      const segmentCount = Math.max(12, Math.ceil((Math.abs(sweep) / TAU) * 72));
      const placed = placedOf(edgeHit.view);
      const pts: P2[] = [];
      for (let i = 0; i <= segmentCount; i++) {
        const t = a0 + (sweep * i) / segmentCount;
        pts.push(toPaper(placed, [center[0] + edgeHit.r! * Math.cos(t), center[1] + edgeHit.r! * Math.sin(t)]));
      }

      return polyline(pts);
    };
    const edge = (edgeHit: EdgeHit | null) => (!edgeHit ? '' : edgeHit.kind === 'circle' && edgeHit.c && edgeHit.r !== undefined ? arc(edgeHit) : lineOf(edgeHit.view, edgeHit.a, edgeHit.b));
    const tol = tolerance();
    switch (tool) {
      case 'length':
        return edge(edgeAt(views, layout, q, tol, 'line'));
      case 'lineLine':
      case 'angle':
      case 'clineLines':
      case 'cross': {
        const lineHit = linePick(q, view);

        return lineHit ? lineOf(lineHit.view, lineHit.a, lineHit.b) : '';
      }
      case 'distance':
      case 'cline':
      case 'angle3': {
        const pointHit = pointPick(q, view);

        return pointHit ? dot(pointHit.view, pointHit.p) : '';
      }
      case 'pointLine': {
        if (!picks.length) {
          const pointHit = pointPick(q);

          return pointHit ? dot(pointHit.view, pointHit.p) : '';
        }
        const lineHit = linePick(q, view);

        return lineHit ? lineOf(lineHit.view, lineHit.a, lineHit.b) : '';
      }
      case 'arcAngle':
      case 'radius':
      case 'diameter':
      case 'center':
        return edge(edgeAt(views, layout, q, tol, 'circle'));
      case 'minmax': {
        const pt = pointAt(views, layout, q, tol * 0.7, view);
        if (pt) {
          return dot(pt.view, pt.p);
        }
        const e = edgeAt(views, layout, q, tol);

        return e && (!view || e.view === view) ? edge(e) : '';
      }
      case 'section': {
        if (picks.length >= 2) {
          return '';
        }
        const pointHit = pointPick(q, view);

        return pointHit && !placedOf(pointHit.view).clip ? dot(pointHit.view, pointHit.p) : '';
      }
      case 'projection': {
        if (picks.length) {
          return '';
        }
        const view = layout.views.find((placed) => {
          const bounds = extent(placed);

          return q[0] >= bounds.x0 - 2 && q[0] <= bounds.x1 + 2 && q[1] >= bounds.y0 - 2 && q[1] <= bounds.y1 + 2;
        });
        if (!view || !specOf(view.id, opts())) {
          return '';
        }
        const viewBounds = extent(view);

        return `<rect x="${round3(viewBounds.x0 - 2)}" y="${round3(viewBounds.y0 - 2)}" width="${round3(viewBounds.x1 - viewBounds.x0 + 4)}" height="${round3(viewBounds.y1 - viewBounds.y0 + 4)}" fill="${HOVER}" fill-opacity="0.08" stroke="${HOVER}" stroke-width="${round3(2 * px)}"/>`;
      }
      default:
        return '';
    }
  };
  /** Light up what's under the pointer now (nothing when it has left, or no tool is on). */
  const drawHover = () => {
    const element = paper.querySelector('svg');
    if (!element) {
      return;
    }
    const q = tool && hoverClient ? sheetPoint(hoverClient) : null;
    const svg = q ? hoverSVG(q) : '';
    let svgGroup = element.querySelector<SVGGElement>('#d-hover');
    if (svg === hoverKey && (svgGroup || !svg)) {
      return;
    }
    hoverKey = svg;
    if (!svgGroup) {
      svgGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      svgGroup.id = 'd-hover';
      svgGroup.setAttribute('pointer-events', 'none');
      element.append(svgGroup);
    }
    svgGroup.innerHTML = svg;
    paper.classList.toggle('can-pick', !!svg);
  };
  paper.addEventListener('pointerleave', () => {
    hoverClient = null;
    drawHover();
  });
  const addMark = (drawingMark: DrawingMark) => {
    const near = (point?: P2, q?: P2) => (!point && !q) || (!!point && !!q && len2(sub2(point, q)) < 1e-3);
    const options = opts();
    const same = options.marks.find(mark => mark.view === drawingMark.view && mark.kind === drawingMark.kind && near(mark.c, drawingMark.c) && ((near(mark.a, drawingMark.a) && near(mark.b, drawingMark.b)) || (near(mark.a, drawingMark.b) && near(mark.b, drawingMark.a))));
    if (same) {
      selected = same.id;
      render();

      return app.ui.toast('That one is there already');
    }
    set({ marks: [...options.marks, drawingMark] });
  };
  /** A dimension's arc for an angle: half the shorter ray, on the paper, 8 to 30 mm. */
  const arcFor = (view: string, center: P2, a: P2, b: P2) => Math.min(30, Math.max(8, 0.5 * Math.min(len2(sub2(a, center)), len2(sub2(b, center))) * placedOf(view).s));

  const useTool = (q: [number, number], e: PointerEvent) => {
    if (!layout) {
      return;
    }
    const tol = tolerance();
    const view = picks[0]?.view;
    const again = (msg: string) => app.ui.toast(picks.length ? `${msg} in the same view` : msg);
    if (tool === 'length') {
      const hit = edgeAt(views, layout, q, tol, 'line');
      if (!hit) {
        return app.ui.toast('Tap right on a straight edge of a view');
      }
      const view = layout.views.find(placed => placed.id === hit.view)!;
      addDim({ id: annId('dim'), view: hit.view, kind: 'length', a: hit.a, b: hit.b, offset: outward(view, hit.a, hit.b) });
    } else if (tool === 'distance' || tool === 'cline') {
      const hit = pointPick(q, view);
      if (!hit) {
        return again('Tap a corner, the middle of an edge or a centre');
      }
      if (!picks.length) {
        return (picks.push(hit), step('Now tap the second point'));
      }
      if (len2(sub2(hit.p, picks[0].p)) < 1e-6) {
        return;
      }
      const a = picks[0].p;
      picks = [];
      if (tool === 'cline') {
        addMark({ id: annId('mark'), view: hit.view, kind: 'line', a, b: hit.p });
      } else {
        addDim({ id: annId('dim'), view: hit.view, kind: 'distance', a, b: hit.p, offset: outward(placedOf(hit.view), a, hit.p) });
      }
      showHint(TOOL_HINT[tool]);
    } else if (tool === 'pointLine') {
      if (!picks.length) {
        const hit = pointPick(q);
        if (!hit) {
          return app.ui.toast('Tap a corner, the middle of an edge or a centre');
        }

        return (picks.push(hit), step('Now tap a straight edge'));
      }
      const hit = linePick(q, view);
      if (!hit) {
        return again('Tap a straight edge');
      }
      const a = picks[0].p;
      const b = foot(a, hit.a, hit.b);
      picks = [];
      if (len2(sub2(a, b)) < 1e-6) {
        return (app.ui.toast('That point is on the edge'), step(TOOL_HINT.pointLine));
      }
      addDim({ id: annId('dim'), view: hit.view, kind: 'distance', a, b, offset: outward(placedOf(hit.view), a, b) });
      showHint(TOOL_HINT.pointLine);
    } else if (tool === 'lineLine' || tool === 'angle' || tool === 'clineLines' || tool === 'cross') {
      const hit = linePick(q, view);
      if (!hit) {
        return again('Tap a straight edge');
      }
      if (!picks.length) {
        return (picks.push({ view: hit.view, p: foot(fromPaper(placedOf(hit.view), q), hit.a, hit.b), line: hit.line }), step('Now tap the second edge'));
      }
      const first = picks[0];
      const l1 = first.line!;
      const u1 = unit2(sub2(l1.b, l1.a));
      const u2 = unit2(sub2(hit.b, hit.a));
      const parallel = Math.abs(cross2(u1, u2)) < PARALLEL;
      picks = [];
      if (tool === 'cross') {
        if (parallel) {
          return (app.ui.toast("Those edges are parallel: they don't meet"), step(TOOL_HINT.cross));
        }
        const t = cross2(sub2(hit.a, l1.a), u2) / cross2(u1, u2);
        const corner: P2 = [l1.a[0] + u1[0] * t, l1.a[1] + u1[1] * t];
        const nearer = (line: { a: P2; b: P2 }): P2 => (len2(sub2(line.a, corner)) < len2(sub2(line.b, corner)) ? line.a : line.b);
        addMark({ id: annId('mark'), view: hit.view, kind: 'cross', c: corner, a: nearer(l1), b: nearer(hit) });

        return showHint(TOOL_HINT.cross);
      }
      if (tool === 'angle') {
        if (parallel) {
          return (app.ui.toast('Those edges are parallel: they make no angle'), step(TOOL_HINT.angle));
        }
        // Where they meet, and a point on each the side tapped.
        const offset = sub2(hit.a, l1.a);
        const t = cross2(offset, u2) / cross2(u1, u2);
        const corner: P2 = [l1.a[0] + u1[0] * t, l1.a[1] + u1[1] * t];
        const far = (line: { a: P2; b: P2 }, tap: P2): P2 => {
          const footPoint = foot(tap, line.a, line.b);
          if (len2(sub2(footPoint, corner)) > 1e-6) {
            return footPoint;
          }

          return len2(sub2(line.a, corner)) > len2(sub2(line.b, corner)) ? line.a : line.b;
        };
        const a = far(l1, first.p);
        const b = far(hit.line, foot(fromPaper(placedOf(hit.view), q), hit.a, hit.b));
        addDim({ id: annId('dim'), view: hit.view, kind: 'angle', c: corner, a, b, offset: arcFor(hit.view, corner, a, b) });
      } else {
        if (!parallel) {
          return (app.ui.toast(tool === 'lineLine' ? "Those edges aren't parallel: use Line-to-Line Angle" : "Those edges aren't parallel"), step(TOOL_HINT[tool]));
        }
        if (tool === 'lineLine') {
          const a: P2 = [(l1.a[0] + l1.b[0]) / 2, (l1.a[1] + l1.b[1]) / 2];
          const b = foot(a, hit.a, hit.b);
          if (len2(sub2(a, b)) < 1e-6) {
            return (app.ui.toast('Those edges are on one line'), step(TOOL_HINT.lineLine));
          }
          addDim({ id: annId('dim'), view: hit.view, kind: 'distance', a, b, offset: outward(placedOf(hit.view), a, b) });
        } else {
          // Midway between them, from the first end to the last of the two.
          const normal: P2 = [-u1[1], u1[0]];
          const dot = (point: P2, vector: P2) => point[0] * vector[0] + point[1] * vector[1];
          const dm = (dot(l1.a, normal) + dot(hit.a, normal)) / 2;
          const ts = [l1.a, l1.b, hit.a, hit.b].map(point => dot(point, u1));
          const at = (t: number): P2 => [u1[0] * t + normal[0] * dm, u1[1] * t + normal[1] * dm];
          addMark({ id: annId('mark'), view: hit.view, kind: 'line', a: at(Math.min(...ts)), b: at(Math.max(...ts)) });
        }
      }
      showHint(TOOL_HINT[tool]);
    } else if (tool === 'angle3') {
      const hit = pointPick(q, view);
      if (!hit) {
        return again('Tap a corner, the middle of an edge or a centre');
      }
      if (picks.some(pick => len2(sub2(pick.p, hit.p)) < 1e-6)) {
        return;
      }
      picks.push(hit);
      if (picks.length === 1) {
        return step('Now tap the corner the angle is at');
      }
      if (picks.length === 2) {
        return step('Now tap the third point');
      }
      const [a, vertex, b] = picks.map(pick => pick.p);
      picks = [];
      if (Math.abs(cross2(unit2(sub2(a, vertex)), unit2(sub2(b, vertex)))) < 1e-9) {
        return (app.ui.toast('Those points are on one line'), step(TOOL_HINT.angle3));
      }
      addDim({ id: annId('dim'), view: hit.view, kind: 'angle', c: vertex, a, b, offset: arcFor(hit.view, vertex, a, b) });
      showHint(TOOL_HINT.angle3);
    } else if (tool === 'arcAngle') {
      const hit = edgeAt(views, layout, q, tol, 'circle');
      if (!hit || !hit.c || hit.r === undefined || !hit.m) {
        return app.ui.toast('Tap right on an arc of a view (seen face on)');
      }
      if (len2(sub2(hit.a, hit.b)) < 1e-6 * Math.max(1, hit.r)) {
        return app.ui.toast('That is a whole circle (360°): tap an arc');
      }
      addDim({ id: annId('dim'), view: hit.view, kind: 'angle', c: hit.c, a: hit.a, b: hit.b, through: hit.m, offset: hit.r * placedOf(hit.view).s + 6 });
    } else if (tool === 'minmax') {
      // A point when the tap is right on one (a corner, a centre), else the edge or circle under it.
      const pt = pointAt(views, layout, q, tol * 0.7, view);
      const edge = pt ? null : edgeAt(views, layout, q, tol);
      const ent: (Ent & { view: string }) | null = pt
        ? { kind: 'point', p: pt.p, view: pt.view }
        : edge && (!view || edge.view === view)
          ? edge.kind === 'circle' && edge.c && edge.r !== undefined && edge.m
            ? { kind: 'circle', c: edge.c, r: edge.r, a: edge.a, m: edge.m, b: edge.b, view: edge.view }
            : { kind: 'line', a: edge.a, b: edge.b, view: edge.view }
          : null;
      if (!ent) {
        return again('Tap a point, an edge or a circle');
      }
      if (!picks.length) {
        return (picks.push({ view: ent.view, p: [0, 0], ent }), step('Now tap the second one'));
      }
      const first = picks[0].ent!;
      picks = [];
      const mm = minMax(first, ent);
      const gap = (pr: [P2, P2]) => len2(sub2(pr[0], pr[1]));
      const max = gap(mm.min) < 1e-6;
      const [a, b] = max ? mm.max : mm.min;
      if (gap([a, b]) < 1e-6) {
        return (app.ui.toast('Those two meet: there is no distance between them'), step(TOOL_HINT.minmax));
      }
      addDim({ id: annId('dim'), view: ent.view, kind: 'distance', a, b, minmax: mm, ...(max ? { max } : {}), offset: outward(placedOf(ent.view), a, b) });
      showHint(TOOL_HINT.minmax);
    } else if (tool === 'base') {
      const options = opts();
      const id = annId('view');
      set({ extra: [...options.extra, { id, orient: pendingBase.orient, at: q, ...(pendingBase.scale ? { scale: pendingBase.scale } : {}) }] });
      startTool(null);
      selected = `view:${id}`;
      render();
    } else if (tool === 'projection') {
      if (!picks.length) {
        const view = layout.views.find((placed) => {
          const bounds = extent(placed);

          return q[0] >= bounds.x0 - 2 && q[0] <= bounds.x1 + 2 && q[1] >= bounds.y0 - 2 && q[1] <= bounds.y1 + 2;
        });
        if (!view) {
          return app.ui.toast('Tap on a view');
        }
        if (!specOf(view.id, opts())) {
          return app.ui.toast('Views are projected from the front, top and side views, added ones and sections (not an isometric one or a detail)');
        }

        return (picks.push({ view: view.id, p: [0, 0] }), step('Tap beside it (left, right, above, below) for a view square on, or past a corner for an isometric one'));
      }
      const placedView = placedOf(picks[0].view);
      const viewBounds = extent(placedView);
      const dir: P2 = [q[0] > viewBounds.x1 ? 1 : q[0] < viewBounds.x0 ? -1 : 0, q[1] > viewBounds.y1 ? 1 : q[1] < viewBounds.y0 ? -1 : 0];
      if (!dir[0] && !dir[1]) {
        return app.ui.toast('Tap outside the view: beside it, or past a corner');
      }
      const options = opts();
      const id = annId('view');
      const corner = dir[0] && dir[1];
      const gap = dir[1] ? (dir[1] > 0 ? q[1] - viewBounds.y1 : viewBounds.y0 - q[1]) : dir[0] > 0 ? q[0] - viewBounds.x1 : viewBounds.x0 - q[0];
      picks = [];
      set({ extra: [...options.extra, corner ? { id, view: placedView.id, dir, at: q } : { id, view: placedView.id, dir, gap: Math.max(0, gap) }] });
      startTool(null);
      selected = `view:${id}`;
      render();
    } else if (tool === 'radius' || tool === 'diameter' || tool === 'center') {
      const hit = edgeAt(views, layout, q, tol, 'circle');
      if (!hit || !hit.c || hit.r === undefined) {
        return app.ui.toast('Tap right on a circle or an arc of a view (seen face on)');
      }
      const view = layout.views.find(placed => placed.id === hit.view)!;
      const paperPoint = toPaper(view, hit.c);
      if (tool === 'center') {
        addMark({ id: annId('mark'), view: hit.view, kind: 'center', c: hit.c, r: hit.r });
      } else {
        addDim({ id: annId('dim'), view: hit.view, kind: tool, a: hit.a, c: hit.c, r: hit.r, offset: 6, angle: Math.atan2(q[1] - paperPoint[1], q[0] - paperPoint[0]) || -Math.PI / 4 });
      }
    } else if (tool === 'section') {
      if (picks.length < 2) {
        const hit = freePick(q, view);
        if (!hit) {
          return again('Tap on a view (not the isometric one or a detail)');
        }
        if (!specOf(hit.view, opts())) {
          return app.ui.toast('Sections are cut from the front, top and side views, or from another section');
        }
        picks.push(hit);
        if (picks.length === 1) {
          return step('Now tap where the cut line ends');
        }
        // Nearly level or upright: made exactly so.
        const [a, b] = [picks[0].p, picks[1].p];
        const ang = Math.abs(Math.atan2(b[1] - a[1], b[0] - a[0]));
        if (Math.abs(Math.sin(ang)) < Math.sin((3 * Math.PI) / 180)) {
          picks[1].p = [b[0], a[1]];
        } else if (Math.abs(Math.cos(ang)) < Math.sin((3 * Math.PI) / 180)) {
          picks[1].p = [a[0], b[1]];
        }
        if (len2(sub2(picks[1].p, a)) * placedOf(hit.view).s < 2) {
          return (picks.pop(), app.ui.toast('Draw a longer line'));
        }

        return step('Tap the side of the line the section view goes on');
      }
      const [a, b] = [picks[0].p, picks[1].p];
      const placed = placedOf(picks[0].view);
      const paperPointA = toPaper(placed, a);
      const along = unit2(sub2(toPaper(placed, b), paperPointA));
      const normal: P2 = [-along[1], along[0]];
      const sg = Math.sign((q[0] - paperPointA[0]) * normal[0] + (q[1] - paperPointA[1]) * normal[1]) || 1;
      const place: P2 = [normal[0] * sg, normal[1] * sg];
      const options = opts();
      const look: P2 = options.angle === 'first' ? place : [-place[0], -place[1]];
      const bounds = extent(placed);
      const vertical = Math.abs(place[1]) >= Math.abs(place[0]);
      const gap = vertical ? (place[1] > 0 ? q[1] - bounds.y1 : bounds.y0 - q[1]) : place[0] > 0 ? q[0] - bounds.x1 : bounds.x0 - q[0];
      const id = annId('sec');
      picks = [];
      set({ sections: [...options.sections, { id, letter: nextLetter(options), view: placed.id, a, b, look, gap: Math.max(0, gap) }] });
      startTool(null);
      selected = `view:${id}`;
      render();
    } else if (tool === 'detail') {
      if (!picks.length) {
        const hit = freePick(q);
        if (!hit) {
          return app.ui.toast('Tap on a view (not the isometric one or a detail)');
        }

        return (picks.push(hit), step('Now tap how far round it goes'));
      }
      const placed = placedOf(picks[0].view);
      if (picks.length === 1) {
        const radius = len2(sub2(q, toPaper(placed, picks[0].p)));
        if (radius < 2) {
          return app.ui.toast('Make the circle bigger');
        }

        return (picks.push({ view: placed.id, p: [radius / placed.s, 0] }), step('Tap where the detail view goes'));
      }
      const options = opts();
      const id = annId('det');
      const det = { id, letter: nextLetter(options), view: placed.id, c: picks[0].p, r: picks[1].p[0], at: q };
      picks = [];
      set({ details: [...options.details, det] });
      startTool(null);
      selected = `view:${id}`;
      render();
    } else if (tool === 'note') {
      // On an edge: a note pointing at it, a little up and out from it.
      const hit = edgeAt(views, layout, q, tol);
      if (!hit) {
        return noteInput(q, e.clientX, e.clientY);
      }
      const placed = placedOf(hit.view);
      const local = fromPaper(placed, q);
      let at: P2;
      if (hit.kind === 'circle' && hit.c && hit.r !== undefined) {
        const direction = unit2(sub2(local, hit.c));
        at = [hit.c[0] + direction[0] * hit.r, hit.c[1] + direction[1] * hit.r];
      } else {
        const ab = sub2(hit.b, hit.a);
        const t = Math.max(0, Math.min(1, ((local[0] - hit.a[0]) * ab[0] + (local[1] - hit.a[1]) * ab[1]) / (ab[0] * ab[0] + ab[1] * ab[1] || 1)));
        at = [hit.a[0] + ab[0] * t, hit.a[1] + ab[1] * t];
      }
      const paperPoint = toPaper(placed, at);
      const center = [placed.x + ((placed.box[1][0] - placed.box[0][0]) * placed.s) / 2, placed.y + ((placed.box[1][1] - placed.box[0][1]) * placed.s) / 2];
      const out = paperPoint[0] >= center[0] ? 1 : -1;
      const spot: P2 = [paperPoint[0] + out * 12 - (out < 0 ? 20 : 0), paperPoint[1] - 10];
      const [cx, cy] = clientOf(spot);
      noteInput(spot, cx, cy, undefined, { view: hit.view, p: at });
    }
  };
  /** Ends the note being written (kept). */
  let closeNote: (() => void) | null = null;
  const noteInput = (q: [number, number], cx: number, cy: number, edit?: DrawingNote, to?: DrawingNote['to']) => {
    // One being written already: kept as it is.
    closeNote?.();
    const input = typingBox('bim-note-input');
    input.placeholder = 'Note';
    input.value = edit?.text ?? '';
    const rect = stage.getBoundingClientRect();
    stage.append(input);
    // On the screen whole (a phone is narrow): moved in from the right edge when it would run off.
    input.style.left = `${Math.max(4, Math.min(cx - rect.left, rect.width - input.offsetWidth - 4))}px`;
    input.style.top = `${Math.max(4, Math.min(cy - rect.top - 14, rect.height - input.offsetHeight - 4))}px`;
    setTimeout(() => input.focus(), 0);
    let done = false;
    const finish = (keep: boolean) => {
      if (done) {
        return;
      }
      done = true;
      closeNote = null;
      const t = input.value.trim();
      input.remove();
      if (keep) {
        const options = opts();
        if (edit) {
          set({ notes: t ? options.notes.map(note => (note.id === edit.id ? { ...note, text: t } : note)) : options.notes.filter(note => note.id !== edit.id) });
        } else if (t) {
          set({ notes: [...options.notes, { id: annId('note'), x: q[0], y: q[1], text: t, ...(to ? { to } : {}) }] });
        }
      }
      if (tool === 'note') {
        startTool(null);
      }
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        finish(true);
      }
      if (e.key === 'Escape') {
        finish(false);
      }
    });
    closeNote = () => finish(true);
    input.addEventListener('blur', () => finish(true));
  };

  const removeSelected = () => {
    const id = selected;
    if (!id) {
      return;
    }
    selected = null;
    const options = opts();
    if (id.startsWith('balloon:')) {
      // (An item number is the parts list's: it is not taken off here - Balloons, in Properties, does that for all
      // of them. One moved by hand goes back to where the sheet puts it.)
      const { [id.slice(8)]: _gone, ...rest } = options.balloonAt;

      return void set({ balloonAt: Object.keys(rest).length ? rest : undefined });
    }
    if (id.startsWith('view:')) {
      const viewId = id.slice(5);
      // A section, a detail or an added view: gone with what was put on it, and the views made from it.
      // A standard view taken off: the same for what was made from it (its switch in Views brings it back).
      const gone = new Set([viewId]);
      for (let grew = true; grew; ) {
        grew = false;
        for (const x of [...options.sections, ...options.details, ...options.extra]) {
          if (!gone.has(x.id) && x.view && gone.has(x.view)) {
            (gone.add(x.id), (grew = true));
          }
        }
      }
      const keep = <T extends { id: string; view?: string }>(list: T[]) => list.filter(item => !gone.has(item.id) && !(item.view && gone.has(item.view)));
      const madeOf = gone.size > 1 || options.sections.some(section => section.id === viewId) || options.details.some(detail => detail.id === viewId) || options.extra.some(drawingView => drawingView.id === viewId);
      if (madeOf) {
        set({
          ...(VIEW_SPECS.some(viewSpec => viewSpec.id === viewId) ? { views: { ...options.views, [viewId === 'left' || viewId === 'right' ? 'side' : viewId]: false } } : {}),
          sections: keep(options.sections),
          details: keep(options.details),
          extra: keep(options.extra),
          dims: keep(options.dims),
          marks: keep(options.marks),
          notes: options.notes.map(note => (note.to && gone.has(note.to.view) ? { id: note.id, x: note.x, y: note.y, text: note.text, ...(note.size ? { size: note.size } : {}) } : note))
        });

        return;
      }
      // A view taken off: back with its switch in Views.
      const key = viewId === 'left' || viewId === 'right' ? 'side' : (viewId as 'front' | 'top' | 'iso');
      set({ views: { ...options.views, [key]: false } });
    } else if (isOverall(id)) {
      set({ overallDims: { ...options.overallDims, [id]: { ...options.overallDims[id], hidden: true } } });
      app.ui.toast('Overall size taken off: Overall sizes, off and on again, brings it back');
    } else {
      set({ dims: options.dims.filter(dimension => dimension.id !== id), notes: options.notes.filter(note => note.id !== id), marks: options.marks.filter(mark => mark.id !== id), images: options.images.filter(image => image.id !== id) });
    }
  };
  /** Every dimension on the sheet laid out by the book: rows out from the views, shorter inside longer, values clear. */
  const arrange = () => {
    if (!layout) {
      return;
    }
    const options = opts();
    const all = dimsOf(options);
    if (!all.length) {
      return app.ui.toast('No dimensions to arrange');
    }
    let cur = options;
    let patch: Partial<DrawingOptions> = {};
    for (const arrangeDimension of arrangeDims(all, layout, options)) {
      const changes = withDim(cur, arrangeDimension);
      patch = { ...patch, ...changes };
      cur = { ...cur, ...changes } as typeof options;
    }
    set(patch);
    app.ui.toast(`${all.length} dimension${all.length === 1 ? '' : 's'} arranged`);
  };
  /** Every dimension on the sheet: the overall sizes, then those put on by hand. */
  const dimsOf = (options: ReturnType<typeof opts>): DrawingDim[] => [...(layout ? overallDims(options, layout) : []), ...options.dims];
  /** A dimension changed: one put on by hand in its list; an overall size, as what was changed on it. */
  const withDim = (options: ReturnType<typeof opts>, drawingDimension: DrawingDim): Partial<DrawingOptions> => {
    if (!isOverall(drawingDimension.id)) {
      return { dims: options.dims.map(dimension => (dimension.id === drawingDimension.id ? drawingDimension : dimension)) };
    }
    const edit: NonNullable<DrawingOptions['overallDims']>[string] = { offset: drawingDimension.offset, slide: drawingDimension.slide, prefix: drawingDimension.prefix, suffix: drawingDimension.suffix, tol: drawingDimension.tol };
    for (const key of Object.keys(edit) as (keyof typeof edit)[]) {
      if (edit[key] === undefined) {
        delete edit[key];
      }
    }

    return { overallDims: { ...options.overallDims, [drawingDimension.id]: edit } };
  };

  /** With something picked and no tool on: what it is, and what can be done to it. */
  const showSelection = () => {
    chip.hidden = true;
    if (tool) {
      return;
    }
    hint.innerHTML = '';
    hint.hidden = false;
    if (!selected) {
      // Nothing picked, no tool on: what can be done from here (it said nothing, and the sheet looked like a picture).
      hint.append(el('span', 'bim-idle-hint', 'Drag a dimension or a note to move it. Tap a view for its handle. Double-tap text to edit it. Tools are on the left.'));

      return;
    }
    const id = selected;
    const options = opts();
    const button = (label: string, run: () => void, on = false) => {
      const b = el('button', `text-btn${on ? ' on' : ''}`, label);
      b.addEventListener('click', run);
      hint.append(b);
    };
    /** A view's scale, picked from the standard ones: on the chip under its handle. */
    const scaleSelect = (now: number, change: (s: number) => void) => {
      const select = chip;
      select.innerHTML = '';
      for (const sc of SCALES) {
        const op = el('option', '', scaleLabel(sc));
        op.value = String(sc);
        op.selected = Math.abs(sc - now) < 1e-9;
        select.append(op);
      }
      if (![...select.options].some(option => option.selected)) {
        const op = el('option', '', scaleLabel(now));
        op.value = String(now);
        op.selected = true;
        select.prepend(op);
      }
      select.onchange = () => change(Number(select.value));
      select.hidden = false;
    };
    if (id.startsWith('view:')) {
      const viewId = id.slice(5);
      const sec = options.sections.find(section => section.id === viewId);
      const det = options.details.find(detail => detail.id === viewId);
      const ex = options.extra.find(drawingView => drawingView.id === viewId);
      const now = layout?.views.find(view => view.id === viewId)?.s ?? 1;
      if (ex) {
        hint.append(el('span', '', extraName(ex, options)));
        // A view lined up with another is at its scale (the lines run on from one to the other).
        if (ex.orient || isIsoView(ex)) {
          scaleSelect(now, scale => set({ extra: options.extra.map(drawingView => (drawingView === ex ? { ...drawingView, scale: scale } : drawingView)) }));
        } else {
          hint.append(el('span', 'bim-sub', "Scale: its view's"));
        }
      } else if (viewId === 'iso') {
        hint.append(el('span', '', 'Isometric view'));
        scaleSelect(now, scale => set({ isoScale: scale }));
      } else if (VIEW_SPECS.some(viewSpec => viewSpec.id === viewId)) {
        // The front, top and side views share one scale: they line up.
        hint.append(el('span', '', VIEW_NAMES[viewId] ?? 'View'));
        scaleSelect(now, scale => set({ scale: scale }));
      } else if (sec) {
        hint.append(el('span', '', `Section ${sec.letter}-${sec.letter}`));
        button('Flip', () => set({ sections: options.sections.map(section => (section === sec ? { ...section, look: [-section.look[0], -section.look[1]] as P2 } : section)) }));
      } else if (det) {
        hint.append(el('span', '', `Detail ${det.letter}`));
        scaleSelect(now, scale => set({ details: options.details.map(detail => (detail === det ? { ...detail, scale: scale } : detail)) }));
      } else {
        hint.append(el('span', '', VIEW_NAMES[viewId] ?? 'View'));
      }
    } else {
      const dimension = dimsOf(options).find(dimension => dimension.id === id);
      const note = options.notes.find(note => note.id === id);
      const img = options.images.find(image => image.id === id);
      if (id.startsWith('balloon:')) {
        hint.append(el('span', '', 'Item number'));
        hint.append(el('span', 'bim-sub', 'Drag it where it reads well'));
        // (Put by hand: back to where the sheet puts it.)
        if (options.balloonAt[id.slice(8)]) {
          button('Put back', () => {
            const { [id.slice(8)]: _gone, ...rest } = options.balloonAt;
            selected = null;
            set({ balloonAt: Object.keys(rest).length ? rest : undefined });
          });
        }
        button('Done', () => ((selected = null), render()), true);

        return;
      }
      if (img) {
        hint.append(el('span', '', 'Picture'));
        // Bigger or smaller about its middle.
        const resize = (factor: number) => set({ images: options.images.map(image => (image === img ? { ...image, x: img.x - (img.w * (factor - 1)) / 2, y: img.y - (img.h * (factor - 1)) / 2, w: img.w * factor, h: img.h * factor } : image)) });
        button('Smaller', () => resize(1 / 1.25));
        button('Bigger', () => resize(1.25));
      } else if (dimension) {
        hint.append(el('span', '', dimension.minmax ? 'Min-Max Distance' : isOverall(dimension.id) ? 'Overall size' : 'Dimension'));
        const mm = dimension.minmax;
        if (mm) {
          const pv = layout?.views.find(view => view.id === dimension.view);
          const flip = (max: boolean) => {
            const [a, b] = max ? mm.max : mm.min;
            if (len2(sub2(a, b)) < 1e-6) {
              return app.ui.toast('They meet: the nearest is no distance');
            }
            set({ dims: options.dims.map(drawingDimension => (drawingDimension === dimension ? { ...drawingDimension, a, b, max: max || undefined, offset: pv ? outward(pv, a, b) : drawingDimension.offset } : drawingDimension)) });
          };
          button('Min', () => flip(false), !dimension.max);
          button('Max', () => flip(true), !!dimension.max);
        }
        // How far out from what it measures, typed (mm on the paper).
        const far = typingBox('bim-input bim-dim-far');
        far.inputMode = 'decimal';
        far.value = String(Math.round(Math.abs(dimension.offset) * 10) / 10);
        far.title = 'How far out from what it measures (mm on the paper)';
        far.addEventListener('change', () => {
          const value = Number(far.value);
          if (!(value > 0)) {
            return;
          }
          set(withDim(options, { ...dimension, offset: (dimension.kind === 'length' || dimension.kind === 'distance' ? Math.sign(dimension.offset) || 1 : 1) * value }));
        });
        far.addEventListener('keydown', e => e.stopPropagation());
        const lab = el('label', 'bim-dim-farlabel', 'Distance');
        lab.append(far);
        hint.append(lab);
        if (dimension.slide) {
          button('Centre text', () => set(withDim(options, { ...dimension, slide: undefined })));
        }
        button('Text and tolerance', () => void editDim(dimension));
      } else if (note) {
        hint.append(el('span', '', 'Note'));
        // How tall its letters are: a step smaller or bigger (2.5 to 14 mm on the paper).
        const SIZES = [2.5, 3.5, 5, 7, 10, 14];
        const now = note.size ?? 3.5;
        const at = SIZES.reduce((best, size, i) => (Math.abs(size - now) < Math.abs(SIZES[best] - now) ? i : best), 0);
        const resize = (to: number) => set({ notes: options.notes.map(drawingNote => (drawingNote === note ? { ...drawingNote, size: SIZES[to] === 3.5 ? undefined : SIZES[to] } : drawingNote)) });
        const smaller = el('button', 'text-btn', 'A−');
        smaller.title = 'Smaller text';
        (smaller as HTMLButtonElement).disabled = at === 0;
        smaller.addEventListener('click', () => resize(at - 1));
        const bigger = el('button', 'text-btn', 'A+');
        bigger.title = 'Bigger text';
        (bigger as HTMLButtonElement).disabled = at === SIZES.length - 1;
        bigger.addEventListener('click', () => resize(at + 1));
        hint.append(smaller, el('span', 'bim-sub', `${now} mm`), bigger);
        button('Edit', () => {
          const [cx, cy] = clientOf([note.x, note.y]);
          noteInput([note.x, note.y], cx, cy, note);
        });
      } else {
        hint.append(el('span', '', 'Centreline'));
      }
    }
    button('Delete', removeSelected);
    button('Done', () => ((selected = null), render()), true);
  };

  // ---- Base views: which way, at what scale, then where.
  let pendingBase: { orient: ViewOrient; scale?: number } = { orient: 'front' };
  const chooseBase = async () => {
    const orient = select(pendingBase.orient, Object.entries(ORIENTS).map(([key, orient]) => [key, orient.name]));
    const scale = select(String(pendingBase.scale ?? ''), [['', `The sheet's (${scaleLabel(layout?.scale ?? 1)})`], ...SCALES.map((scale): [string, string] => [String(scale), scaleLabel(scale)])]);
    if (!(await form('Base View', [['View from', orient], ['Scale', scale]]))) {
      return;
    }
    pendingBase = { orient: orient.value as ViewOrient, ...(scale.value ? { scale: Number(scale.value) } : {}) };
    startTool('base');
  };

  // ---- Pictures: a file from the device, made small enough to keep in the project.
  const addImage = async () => {
    const input = el('input', '');
    input.type = 'file';
    input.accept = 'image/*';
    const file = await new Promise<File | null>((resolve) => {
      input.addEventListener('change', () => resolve(input.files?.[0] ?? null));
      input.click();
    });
    if (!file) {
      return;
    }
    try {
      const url = await new Promise<string>((resolve, reject) => {
        const fileReader = new FileReader();
        fileReader.onload = () => resolve(String(fileReader.result));
        fileReader.onerror = () => reject(fileReader.error);
        fileReader.readAsDataURL(file);
      });
      const img = new Image();
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error('not a picture'));
        img.src = url;
      });
      // At most 1200 pixels across: plenty on paper, and the project stays small.
      const scale = Math.min(1, 1200 / Math.max(img.naturalWidth, img.naturalHeight));
      let src = url;
      if (scale < 1 || file.size > 400_000) {
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
        canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height);
        src = file.type === 'image/png' || file.type === 'image/svg+xml' ? canvas.toDataURL('image/png') : canvas.toDataURL('image/jpeg', 0.85);
      }
      const [sheetWidth, sheetHeight] = sheetSize(opts());
      const width = Math.min(60, sheetWidth / 4);
      const height = (width * img.naturalHeight) / Math.max(1, img.naturalWidth);
      const id = annId('img');
      set({ images: [...opts().images, { id, x: (sheetWidth - width) / 2, y: (sheetHeight - height) / 2, w: width, h: height, src }] });
      startTool(null);
      selected = id;
      render();
    } catch {
      app.ui.toast("That file isn't a picture this can show");
    }
  };

  /** A small window of rows; resolves true on OK. */
  const form = (title: string, rows: [string, HTMLElement][], note?: string): Promise<boolean> =>
    new Promise((resolve) => {
      const back = el('div', 'dialog-back over-sheet');
      const box = el('form', 'dialog');
      box.append(el('div', 'panel-title', title));
      if (note) {
        box.append(el('div', 'dialog-note', note));
      }
      const list = el('div', 'dialog-list');
      for (const [label, control] of rows) {
        const fieldLabel = el('label', 'dialog-field');
        fieldLabel.append(el('span', 'field-label', label), control);
        list.append(fieldLabel);
      }
      box.append(list);
      const done = (ok: boolean) => {
        back.remove();
        resolve(ok);
      };
      const buttons = el('div', 'panel-buttons');
      buttons.append(textButton('Cancel', 'Esc', () => done(false)), textButton('OK', 'Enter', () => done(true), true));
      for (const b of buttons.querySelectorAll('button')) {
        b.type = 'button';
      }
      box.append(buttons);
      box.addEventListener('submit', e => (e.preventDefault(), done(true)));
      box.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          done(false);
        }
        if (e.key === 'Enter' && !(e.target as HTMLElement).closest('select')) {
          (e.preventDefault(), done(true));
        }
        e.stopPropagation();
      });
      back.append(box);
      back.addEventListener('pointerdown', e => e.target === back && done(false));
      document.body.append(back);
      (list.querySelector('input, select, .text-field') as HTMLElement | null)?.focus();
    });
  const select = (value: string, options: [string, string][]) => {
    const select = el('select', 'bim-select');
    for (const [optionValue, t] of options) {
      const op = el('option', '', t);
      op.value = optionValue;
      op.selected = optionValue === value;
      select.append(op);
    }

    return select;
  };
  const input = (value: string, placeholder = '') => {
    const i = typingBox();
    i.value = value;
    i.placeholder = placeholder;

    return i;
  };

  /** A dimension's text before and after its value, and its tolerance. */
  const editDim = async (drawingDimension: DrawingDim) => {
    const options = opts();
    const angle = drawingDimension.kind === 'angle';
    // Tolerances are typed in the drawing's units (degrees for an angle), kept in mm (radians).
    const factor = angle ? Math.PI / 180 : UNIT_MM[options.units];
    const shown = (value?: number) => (value === undefined ? '' : String(Math.round((value / factor) * 1e6) / 1e6));
    const pre = input(drawingDimension.prefix ?? '', 'e.g. 4×');
    const post = input(drawingDimension.suffix ?? '', 'e.g. THRU');
    const kind = select(drawingDimension.tol?.kind ?? 'none', [
      ['none', 'None'],
      ['sym', 'Symmetrical (±)'],
      ['dev', 'Deviation (+ / -)'],
      ['limits', 'Limits (largest / smallest)'],
      ['basic', 'Basic (boxed)']
    ]);
    const up = input(shown(drawingDimension.tol?.up), '0');
    const down = input(shown(drawingDimension.tol?.down), 'same as upper');
    up.inputMode = down.inputMode = 'decimal';
    const unit = angle ? '°' : options.units;
    if (!(await form('Dimension text', [['Before the value', pre], ['After the value', post], ['Tolerance', kind], [`Upper (${unit})`, up], [`Lower (${unit})`, down]]))) {
      return;
    }
    const num = (text: string) => {
      const value = Number(text.trim().replace(',', '.'));

      return text.trim() && Number.isFinite(value) ? Math.abs(value) * factor : undefined;
    };
    const t = kind.value as NonNullable<DimText['tol']>['kind'] | 'none';
    const next: DrawingDim = { ...drawingDimension, prefix: pre.value || undefined, suffix: post.value || undefined, tol: t === 'none' ? undefined : { kind: t, up: num(up.value), down: num(down.value) } };
    for (const key of ['prefix', 'suffix', 'tol'] as const) {
      if (next[key] === undefined) {
        delete next[key];
      }
    }
    set(withDim(opts(), next));
  };

  /** The first drawing: title, sheet, scale, views - then the sheet. */
  const preferences = async (): Promise<boolean> => {
    const options = opts();
    const title = input(options.title);
    const orient = select(options.portrait ? 'portrait' : 'landscape', [
      ['landscape', 'Landscape'],
      ['portrait', 'Portrait']
    ]);
    const size = select(options.size, (Object.keys(SHEETS) as SheetSize[]).map(size => [size, `${size.startsWith('ANSI') ? size : `ISO ${size}`} (${SHEETS[size][0]} × ${SHEETS[size][1]} mm)`]));
    const scale = select('auto', [['auto', 'Largest that fits'], ...SCALES.map(scale => [String(scale), scaleLabel(scale)] as [string, string])]);
    const four = el('input', '');
    four.type = 'checkbox';
    four.checked = true;
    const ok = await form(
      'Drawing preferences',
      [
        ['Drawing title', title],
        ['Orientation', orient],
        ['Sheet size', size],
        ['View-to-sheet scale', scale],
        ['Include 4 views: front, top, side, isometric', four]
      ],
      'All of these can be changed later in Properties.'
    );
    if (!ok) {
      return false;
    }
    set({
      title: title.value.trim() && (title.value.trim() !== options.title || startTitle) ? title.value.trim() : undefined,
      portrait: orient.value === 'portrait' || undefined,
      size: size.value as SheetSize,
      scale: scale.value === 'auto' ? undefined : Number(scale.value),
      views: four.checked ? undefined : { front: true, top: false, side: false, iso: false }
    });

    return true;
  };

  const onKey = (e: KeyboardEvent) => {
    if ((e.target as HTMLElement).closest?.('input, select')) {
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (tool) {
        startTool(null);
      } else if (selected) {
        (selected = null), render();
      } else {
        shut();
      }
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && selected) {
      e.preventDefault();
      e.stopPropagation();
      removeSelected();
    } else if (e.key.startsWith('Arrow') && selected && !tool && !selected.startsWith('view:')) {
      // The arrows nudge what is picked: half a millimetre on the paper (Shift: five). A note or a picture any
      // way; a dimension nearer to or further from what it measures (up and right: further).
      e.preventDefault();
      e.stopPropagation();
      const step = e.shiftKey ? 5 : 0.5;
      const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
      const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
      const options = opts();
      const id = selected;
      const note = options.notes.find(note => note.id === id);
      const img = options.images.find(image => image.id === id);
      const dim = dimsOf(options).find(dimension => dimension.id === id);
      const ball = id.startsWith('balloon:') ? balloonsNow.find(b => b.id === id) : undefined;
      if (ball) {
        set({ balloonAt: { ...options.balloonAt, [id.slice(8)]: [ball.x + dx, ball.y + dy] } });
      } else if (note) {
        set({ notes: options.notes.map(drawingNote => (drawingNote === note ? { ...drawingNote, x: note.x + dx, y: note.y + dy } : drawingNote)) });
      } else if (img) {
        set({ images: options.images.map(image => (image === img ? { ...image, x: img.x + dx, y: img.y + dy } : image)) });
      } else if (dim) {
        const out = dx - dy;
        const far = Math.max(1, Math.abs(dim.offset) + out);
        set(withDim(options, { ...dim, offset: (Math.sign(dim.offset) || 1) * far }));
      }
    } else if (!e.ctrlKey && !e.metaKey && !e.altKey && ['+', '=', '-', '_', 'f', 'F', '0'].includes(e.key)) {
      // Zoom in / out, all of the sheet.
      e.preventDefault();
      e.stopPropagation();
      if (e.key === '+' || e.key === '=') {
        zoomBy(1.5);
      } else if (e.key === '-' || e.key === '_') {
        zoomBy(1 / 1.5);
      } else {
        fitAll();
      }
    }
  };
  window.addEventListener('keydown', onKey, true);

  // ---- The tools at the left
  let open: 'views' | 'dims' | 'marks' | null = null;
  const renderTools = () => {
    // The tools at the top; the sheets (the project's drawings) in their own pane under them, scrolling by itself.
    const keptScroll = tools.querySelector('.bim-dsheets-list')?.scrollTop;
    tools.innerHTML = '';
    const main = el('div', 'bim-dtools-main');
    const sheets = el('div', 'bim-dsheets');
    tools.append(main, sheets);
    let into: HTMLElement = main;
    const options = opts();
    const button = (label: string, icon: IconName, run: () => void, opt: { on?: boolean; disabled?: boolean; sub?: boolean } = {}) => {
      const b = el('button', `bim-dtool${opt.on ? ' on' : ''}${opt.sub ? ' sub' : ''}`);
      b.innerHTML = icons[icon];
      b.append(el('span', '', label));
      b.title = label;
      b.disabled = !!opt.disabled;
      b.addEventListener('click', run);
      into.append(b);
    };
    button('Exit Drawing', 'close', shut);
    // (A phone: a group's tools are listed by name over the sheet; one picked, the list folds away and the sheet is
    // clear to tap - the bar at the top says which tool is on.)
    const pick = (t: ToolId, label: string, icon: IconName) =>
      button(label, icon, () => {
        if (document.documentElement.dataset.screen === 'phone' && tool !== t) {
          open = null;
        }
        startTool(tool === t ? null : t);
      }, { on: tool === t, sub: true });
    button('Views', 'views', () => ((open = open === 'views' ? null : 'views'), renderTools()), { on: open === 'views' || tool === 'section' || tool === 'detail' || tool === 'base' || tool === 'projection' });
    if (open === 'views') {
      const toggle = (key: 'front' | 'top' | 'side' | 'iso', label: string) =>
        button(label, options.views[key] ? 'eye' : 'eyeOff', () => set({ views: { ...options.views, [key]: !options.views[key] } }), { on: options.views[key], sub: true });
      toggle('front', 'Front');
      toggle('top', 'Top');
      toggle('side', options.angle === 'first' ? 'Side (from the left)' : 'Side (from the right)');
      toggle('iso', 'Isometric');
      button('Base View', 'views', () => (tool === 'base' ? startTool(null) : void chooseBase()), { on: tool === 'base', sub: true });
      pick('projection', 'Projected View', 'project');
      pick('section', 'Section View', 'section');
      pick('detail', 'Detail View', 'isolate');
      button('Hidden lines', options.hidden ? 'eye' : 'eyeOff', () => set({ hidden: !options.hidden }), { on: options.hidden, sub: true });
      button('Put views back', 'undo', () => set({ moved: undefined }), { sub: true, disabled: !Object.keys(options.moved).length });
    }
    const dimTools: ToolId[] = ['length', 'distance', 'pointLine', 'lineLine', 'minmax', 'angle', 'angle3', 'arcAngle', 'radius', 'diameter'];
    button('Dimensions', 'ruler', () => ((open = open === 'dims' ? null : 'dims'), renderTools()), { on: open === 'dims' || (!!tool && dimTools.includes(tool)) });
    if (open === 'dims') {
      pick('length', 'Line Length', 'line');
      pick('distance', 'Point-to-Point', 'measure');
      pick('pointLine', 'Point-to-Line', 'alignLine');
      pick('lineLine', 'Line-to-Line', 'offsetEdge');
      pick('minmax', 'Min-Max Distance', 'ruler');
      pick('angle', 'Line-to-Line Angle', 'planeAngle');
      pick('angle3', '3-Point Angle', 'planeAngle');
      pick('arcAngle', 'Arc Angle', 'arc');
      pick('radius', 'Radius', 'arc');
      pick('diameter', 'Diameter', 'circle');
      // Switched on again, the overall sizes taken off one by one come back (where they were moved to).
      const back = () => Object.fromEntries(Object.entries(options.overallDims).map(([key, { hidden: _h, ...rest }]) => [key, rest]));
      button('Overall sizes', options.overall ? 'eye' : 'eyeOff', () => set(options.overall ? { overall: false } : { overall: true, overallDims: back() }), { on: options.overall, sub: true });
      button('Arrange', 'align', arrange, { sub: true });
    }
    const markTools: ToolId[] = ['center', 'cline', 'clineLines', 'cross'];
    button('Centrelines', 'lineDashed', () => ((open = open === 'marks' ? null : 'marks'), renderTools()), { on: open === 'marks' || (!!tool && markTools.includes(tool)) });
    if (open === 'marks') {
      pick('center', 'Centre Mark', 'axis');
      pick('cline', '2-Point Centreline', 'lineDashed');
      pick('clineLines', '2-Line Centreline', 'splitLine');
      pick('cross', 'Intersection Mark', 'close');
    }
    button('Note', 'text', () => startTool(tool === 'note' ? null : 'note'), { on: tool === 'note' });
    button('Image', 'image', () => void addImage());
    button('Delete', 'trash', removeSelected, { disabled: !selected });

    // ---- The project's drawings: tap one to open it; a new one, a copy of this one, this one deleted.
    const all = drawingsOf(store.doc);
    const listed = all.some(drawing => drawing.id === current) ? all : [...all, { id: current }];
    sheets.append(el('div', 'bim-dtools-head', `Sheets (${listed.length})`));
    // What's done with the sheets: small buttons in a row (their names as tips).
    const acts = el('div', 'bim-dsheets-acts');
    const act = (label: string, icon: IconName, run: () => void, disabled = false) => {
      const b = el('button', 'bim-dsheets-act');
      b.innerHTML = icons[icon];
      b.title = label;
      b.setAttribute('aria-label', label);
      b.disabled = disabled;
      b.addEventListener('click', run);
      acts.append(b);
    };
    act('New drawing', 'insert', () => switchTo('new'));
    act('Copy this drawing', 'copy', copyDrawing, !curDrawing());
    act('Delete this drawing', 'trash', () => void deleteDrawing(), !curDrawing());
    act(`Print / PDF all ${all.length}`, 'file', () => void printAll(), !all.length || !!busy);
    act(`DXF of all ${all.length} (one .zip)`, 'share', () => void dxfAll(), !all.length || !!busy);
    sheets.append(acts);
    // Many drawings: a box to find one by its title (the list narrows as it's typed).
    if (listed.length > 8) {
      const find = typingBox('bim-input bim-dfind');
      find.placeholder = `Find among ${listed.length}…`;
      find.value = listFilter;
      find.addEventListener('keydown', e => e.stopPropagation());
      find.addEventListener('input', () => {
        listFilter = find.value;
        narrow();
      });
      sheets.append(find);
    }
    const list = el('div', 'bim-dsheets-list');
    sheets.append(list);
    into = list;
    const rows: [HTMLElement, string][] = [];
    let mine: HTMLElement | null = null;
    for (const drawing of listed) {
      const title = drawing.id === current ? options.title : drawingOptions({ ...store.doc, drawing: drawing }).title;
      button(title, 'drawing', () => drawing.id !== current && switchTo(drawing.id), { on: drawing.id === current });
      const row = list.lastElementChild as HTMLElement;
      if (drawing.id === current) {
        mine = row;
      }
      rows.push([row, title.toLowerCase()]);
    }
    const narrow = () => {
      const q = listFilter.trim().toLowerCase();
      for (const [row, t] of rows) {
        row.hidden = !!q && !t.includes(q);
      }
    };
    narrow();
    // Where the list was scrolled to stays; opened, the open drawing is in sight.
    if (keptScroll !== undefined) {
      list.scrollTop = keptScroll;
    } else {
      requestAnimationFrame(() => mine?.scrollIntoView({ block: 'nearest' }));
    }
  };
  /** What the list of drawings is narrowed to. */
  let listFilter = '';

  // ---- The properties at the right
  propsBtn.addEventListener('click', () => {
    props.hidden = !props.hidden;
    propsBtn.classList.toggle('on', !props.hidden);
  });
  if (window.matchMedia('(max-width: 700px)').matches) {
    (props.hidden = true), propsBtn.classList.remove('on');
  }
  const renderProps = () => {
    const keep = props.scrollTop;
    props.innerHTML = '';
    const sheetOptions = opts();
    const section = (title: string) => props.append(el('div', 'bim-props-h', title));
    const row = (label: string, control: HTMLElement) => {
      const rowLabel = el('label', 'bim-props-row');
      rowLabel.append(el('span', '', label), control);
      props.append(rowLabel);
    };
    const choose = <T extends string | number>(value: T, options: [T, string][], change: (v: T) => void) => {
      const select = el('select', 'bim-select');
      for (const [optionValue, t] of options) {
        const op = el('option', '', t);
        op.value = String(optionValue);
        op.selected = optionValue === value;
        select.append(op);
      }
      select.addEventListener('change', () => change(options.find(([optionValue]) => String(optionValue) === select.value)![0]));

      return select;
    };
    const textField = (value: string, change: (v: string) => void) => {
      const i = typingBox('bim-input');
      i.value = value;
      i.placeholder = '-';
      i.addEventListener('change', () => change(i.value.trim()));

      return i;
    };

    section('Drawing');
    row('Title', textField(sheetOptions.title, value => set({ title: value || undefined })));
    const bodies = el('div', 'bim-props-bodies');
    bodies.append(el('span', '', `${parts.length} of ${allParts.length} ${allParts.length === 1 ? 'body' : 'bodies'}`));
    if (parts.length < allParts.length) {
      const all = el('button', 'text-btn', 'Draw all');
      all.addEventListener('click', () => (set({ bodies: undefined }), void load()));
      bodies.append(all);
    }
    row('Bodies', bodies);
    props.append(el('div', 'bim-sub bim-props-note', 'To draw only some bodies: pick them, then open Drawings.'));

    section('Sheet');
    const orient = el('div', 'bim-seg');
    for (const [value, t] of [
      [true, 'Portrait'],
      [false, 'Landscape']
    ] as [boolean, string][]) {
      const b = el('button', sheetOptions.portrait === value ? 'on' : '', t);
      b.addEventListener('click', () => set({ portrait: value || undefined }));
      orient.append(b);
    }
    row('Orientation', orient);
    row(
      'Sheet size',
      choose(
        sheetOptions.size,
        (Object.keys(SHEETS) as SheetSize[]).map(size => [size, `${size.startsWith('ANSI') ? size : `ISO ${size}`} (${SHEETS[size][0]} × ${SHEETS[size][1]} mm)`]),
        size => set({ size: size })
      )
    );
    row(
      'View scale',
      choose(String(sheetOptions.scale ?? 'auto'), [['auto', `Auto (${scaleLabel(layout?.scale ?? 1)})`], ...SCALES.map(scale => [String(scale), scaleLabel(scale)] as [string, string])], value =>
        set({ scale: value === 'auto' ? undefined : Number(value) })
      )
    );
    if (layout && !layout.fits) {
      props.append(el('div', 'bim-sub bim-props-note', sheetOptions.scale ? "The views don't fit the sheet at this scale: they're cut at the frame. Pick a smaller scale or a bigger sheet." : "A view is moved off the drawing area: it's cut at the frame."));
    }
    row(
      'Projection',
      choose(
        sheetOptions.angle,
        [
          ['first', 'First angle'],
          ['third', 'Third angle']
        ],
        value => set({ angle: value as 'first' | 'third' })
      )
    );
    row(
      'Title block',
      choose(
        sheetOptions.titleBlock,
        [
          ['none', 'Empty sheet'],
          ['border', 'Border only'],
          ['simple', 'Simple'],
          ['table', 'With parts list'],
          ['block', 'Block with revisions'],
          ['horizontal', 'Horizontal'],
          ['vertical', 'Vertical with revisions']
        ],
        value => set({ titleBlock: value as Opts['titleBlock'] })
      )
    );
    row(
      'Date format',
      choose(
        sheetOptions.dateFormat,
        [
          ['iso', 'YYYY-MM-DD'],
          ['dmy', 'DD/MM/YY'],
          ['mdy', 'MM/DD/YY']
        ],
        value => set({ dateFormat: value as Opts['dateFormat'] })
      )
    );
    const balloons = el('input', '');
    balloons.type = 'checkbox';
    balloons.checked = sheetOptions.balloons;
    balloons.addEventListener('change', () => set({ balloons: balloons.checked ? undefined : false }));
    row('Balloons (item numbers)', balloons);

    section('Title block');
    const info = (key: keyof ProjectInfo, label: string) =>
      row(label, textField(store.doc.info?.[key] ?? '', value => store.commit(draft => (draft.info = { ...(draft.info ?? {}), [key]: value || undefined }))));
    info('number', 'Drawing number');
    info('revision', 'Revision');
    info('author', 'Created by');
    info('company', 'Owner');
    // The revision table (Block and Vertical title blocks).
    if (sheetOptions.titleBlock === 'block' || sheetOptions.titleBlock === 'vertical') {
      const revs = el('div', 'bim-props-revs');
      sheetOptions.revisions.forEach((revision, i) => {
        const line = el('div', 'bim-props-rev');
        line.append(el('span', '', [revision.rev, revision.note, revision.date, revision.by].filter(Boolean).join(' · ')));
        const x = el('button', 'text-btn', 'Remove');
        x.addEventListener('click', () => set({ revisions: sheetOptions.revisions.filter((_, j) => j !== i) }));
        line.append(x);
        revs.append(line);
      });
      const add = el('button', 'text-btn', 'Add revision');
      add.addEventListener('click', async () => {
        const next = String.fromCharCode(65 + Math.min(25, sheetOptions.revisions.length));
        const answers = await app.ui.dialog('Add a revision', [
          { key: 'rev', label: 'Revision', value: next },
          { key: 'note', label: 'Description', value: '', placeholder: 'What changed' },
          { key: 'date', label: 'Date', value: dateText(new Date(), sheetOptions.dateFormat) },
          { key: 'by', label: 'By', value: store.doc.info?.author ?? '' }
        ]);
        if (!answers || !answers.rev.trim()) {
          return;
        }
        const revision = { rev: answers.rev.trim(), note: answers.note.trim() || undefined, date: answers.date.trim() || undefined, by: answers.by.trim() || undefined };
        set({ revisions: [...sheetOptions.revisions, revision] });
        // The title block's revision is the latest one.
        store.commit(draft => (draft.info = { ...(draft.info ?? {}), revision: revision.rev }));
      });
      revs.append(add);
      row('Revisions', revs);
    }

    section('Dimensions');
    row(
      'Units',
      choose(
        sheetOptions.units,
        [
          ['mm', 'Millimetre'],
          ['cm', 'Centimetre'],
          ['m', 'Metre'],
          ['in', 'Inch']
        ],
        value => set({ units: value as Opts['units'] })
      )
    );
    row(
      'Length precision',
      choose(
        sheetOptions.precision,
        [0, 1, 2, 3].map(digits => [digits, digits ? `0${sheetOptions.comma ? ',' : '.'}${'123'.slice(0, digits)}` : '0'] as [number, string]),
        precision => set({ precision: precision })
      )
    );
    row(
      'Angle precision',
      choose(
        sheetOptions.anglePrecision,
        [0, 1, 2].map(digits => [digits, digits ? `0${sheetOptions.comma ? ',' : '.'}${'12'.slice(0, digits)}°` : '0°'] as [number, string]),
        anglePrecision => set({ anglePrecision: anglePrecision })
      )
    );
    row(
      'Decimal separator',
      choose(
        sheetOptions.comma ? 'comma' : 'point',
        [
          ['point', 'Point'],
          ['comma', 'Comma']
        ],
        value => set({ comma: value === 'comma' || undefined })
      )
    );

    section('Line widths');
    const width = (key: 'visible' | 'hidden' | 'dims' | 'center' | 'section', label: string, list: number[]) =>
      row(
        label,
        choose(
          sheetOptions.lines[key],
          list.map(width => [width, `${width.toFixed(2)} mm`] as [number, string]),
          width => set({ lines: { ...(curDrawing()?.lines ?? {}), [key]: width } })
        )
      );
    width('visible', 'Visible outlines', [0.25, 0.35, 0.4, 0.5, 0.7]);
    width('hidden', 'Hidden lines', [0.13, 0.15, 0.18, 0.25, 0.35]);
    width('dims', 'Dimensions and thin lines', [0.13, 0.15, 0.18, 0.25, 0.35]);
    width('center', 'Centrelines and cut lines', [0.13, 0.15, 0.18, 0.25, 0.35]);
    width('section', 'Section hatching', [0.13, 0.15, 0.18, 0.25, 0.35]);
    props.scrollTop = keep;
  };

  // ---- Out: print / PDF at the paper's size, or an SVG file.
  print.addEventListener('click', () => {
    const [sheetWidth, sheetHeight] = sheetSize(opts());
    const page = document.createElement('style');
    page.textContent = `@page { size: ${sheetWidth}mm ${sheetHeight}mm; margin: 0; } body.printing-drawing .bim-drawing-print svg { width: ${sheetWidth}mm; height: ${sheetHeight}mm; display: block; }`;
    document.head.append(page);
    const holder = el('div', 'bim-drawing-print');
    holder.innerHTML = sheetOut();
    document.body.append(holder);
    printPage('printing-drawing', holder, page);
  });
  svgBtn.addEventListener('click', () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([`<?xml version="1.0" encoding="UTF-8"?>\n${sheetOut()}`], { type: 'image/svg+xml' }));
    a.download = `${opts().title} - drawing.svg`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  });

  // ---- Every drawing's sheet, made one after the other (each its own bodies and views), for printing or DXF.
  let busy = '';
  const allSheets = async (what: string): Promise<{ title: string; svg: string; W: number; H: number }[] | null> => {
    if (busy) {
      return null;
    }
    busy = what;
    renderTools();
    const list = drawingsOf(store.doc);
    const out: { title: string; svg: string; W: number; H: number }[] = [];
    try {
      if (!allParts.length) {
        allParts = partsList(app, await measureBodies(app));
      }
      for (const [i, drawing] of list.entries()) {
        const doc = { ...store.doc, drawing: drawing };
        const options = drawingOptions(doc);
        name.textContent = `${what}: drawing ${i + 1} of ${list.length} · ${options.title}…`;
        const want = options.bodies?.filter(id => allParts.some(allPart => allPart.id === id));
        const ps = want?.length ? allParts.filter(allPart => want.includes(allPart.id)) : allParts;
        if (!ps.length) {
          continue;
        }
        const specs = sheetViewSpecs(options);
        let vs: Map<string, ProjectedView>;
        if (drawing.id === current && specs.every(spec => views.has(spec.id) && drawnAs.get(spec.id) === JSON.stringify(spec))) {
          vs = views;
        } else {
          vs = new Map((specs.length ? await app.kernel.drawing(store.doc.features as never, specs, ps.map(partRow => partRow.id)) : []).map(projectedView => [projectedView.id, projectedView]));
        }
        const [sheetWidth, sheetHeight] = sheetSize(options);
        out.push({ title: options.title, svg: drawingSVG({ doc, views: vs, parts: ps, date }).svg, W: sheetWidth, H: sheetHeight });
      }

      return out;
    } catch (err) {
      app.ui.toast(`The drawings could not all be made: ${err instanceof Error ? err.message : String(err)}`);

      return null;
    } finally {
      busy = '';
      name.textContent = `Drawing · ${opts().title}`;
      renderTools();
    }
  };
  /** Sheets printed together, each on its own page of its own size (saved as one PDF from the print window). */
  const printSheets = (sheets: { svg: string; W: number; H: number }[]) => {
    const page = document.createElement('style');
    const sizes = [...new Set(sheets.map(sheet => `${sheet.W}x${sheet.H}`))];
    page.textContent
      = sizes.map((size, i) => `@page sheet${i} { size: ${size.split('x')[0]}mm ${size.split('x')[1]}mm; margin: 0; }`).join('\n')
      + '\n@page { margin: 0; } body.printing-drawing .bim-drawing-print > div { break-after: page; } body.printing-drawing .bim-drawing-print > div:last-child { break-after: auto; }'
      + sheets.map((sheet, i) => `\nbody.printing-drawing .bim-drawing-print > div:nth-child(${i + 1}) { page: sheet${sizes.indexOf(`${sheet.W}x${sheet.H}`)}; } body.printing-drawing .bim-drawing-print > div:nth-child(${i + 1}) svg { width: ${sheet.W}mm; height: ${sheet.H}mm; display: block; }`).join('');
    document.head.append(page);
    const holder = el('div', 'bim-drawing-print');
    for (const sheet of sheets) {
      const one = el('div', '');
      one.innerHTML = sheet.svg;
      holder.append(one);
    }
    document.body.append(holder);
    printPage('printing-drawing', holder, page);
  };
  const printAll = async () => {
    const sheets = await allSheets('Print');
    if (sheets?.length) {
      printSheets(sheets);
    }
  };
  const fileName = (t: string) => t.replace(/[\\/:*?"<>|]+/g, '-').trim() || 'Drawing';
  const download = (blob: Blob, file: string) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = file;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  };
  const dxfAll = async () => {
    const sheets = await allSheets('DXF');
    if (!sheets?.length) {
      return;
    }
    const used = new Map<string, number>();
    const enc = new TextEncoder();
    const files = sheets.map((sheet) => {
      const base = fileName(sheet.title);
      const count = (used.get(base.toLowerCase()) ?? 0) + 1;
      used.set(base.toLowerCase(), count);

      return { name: `${count > 1 ? `${base} (${count})` : base}.dxf`, data: enc.encode(sheetToDXF(sheet.svg)) };
    });
    download(await zip(files), `${fileName(store.doc.name || 'Project')} - drawings.zip`);
    app.ui.toast(`${files.length} drawing${files.length === 1 ? '' : 's'} saved as DXF (in one .zip)`);
  };
  dxfBtn.addEventListener('click', () => download(new Blob([sheetToDXF(sheetOut())], { type: 'application/dxf' }), `${fileName(opts().title)}.dxf`));

  // ---- The project's drawings (listed under the tools): another opened, a copy, this one deleted.
  const switchTo = (id: string) => {
    shut();
    void openDrawing(app, id);
  };
  const copyDrawing = () => {
    const me = curDrawing();
    if (!me) {
      return;
    }
    const id = annId('drawing');
    const title = `${opts().title} (copy)`;
    store.commit(draft => putDrawing(draft, id, { ...structuredClone(me), title }));
    switchTo(id);
  };
  const deleteDrawing = async () => {
    if (!(await form('Delete drawing', [], `“${opts().title}” goes from the project (Undo brings it back).`))) {
      return;
    }
    const rest = drawingsOf(store.doc).filter(drawing => drawing.id !== current);
    store.commit(draft => putDrawing(draft, current, null));
    app.ui.toast('Drawing deleted');
    if (rest.length) {
      switchTo(rest[0].id);
    } else {
      shut();
    }
  };

  renderTools();
  if (fresh) {
    if (!(await preferences())) {
      return shut();
    }
    if (picked.length) {
      set({ bodies: picked });
    }
  }
  await load();
}
