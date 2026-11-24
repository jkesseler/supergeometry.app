// Drawings: the model on a sheet of paper, the way a workshop or a site reads
// it. Orthographic views (front, top, side) in first-angle (ISO, the default)
// or third-angle projection, an isometric view, dimensions, balloons with the
// item numbers of the technical sheet's parts list, that parts list, and a
// title block inside a frame with grid zones (ISO 5457, ISO 7200). The views
// are the solids themselves, hidden lines found by the kernel - not a picture
// of the screen - so the sheet is at a true scale and prints as one.
//
// The drawing and the technical sheet are the two halves of one document: the
// balloons here and the rows there share their item numbers.
//
// This file makes the sheet (SVG, mm); drawing.ts shows it and edits it.

import { trim, UNIT_MM, units } from '../units';
import { fmtMass } from './materials';
import type { DrawingDetail, DrawingDim, DrawingImage, DrawingMark, DrawingNote, DrawingOptions, DrawingSection, DrawingView, ProjectDoc, ProjectInfo, ViewOrient } from '../doc/types';
import type { ProjectedView, ViewSpec } from '../kernel/protocol';
import type { PartRow } from './sheet';

/** Paper sizes, landscape, mm (ISO 216 and ANSI). */
export const SHEETS: Record<NonNullable<DrawingOptions['size']>, [number, number]> = {
  A4: [297, 210],
  A3: [420, 297],
  A2: [594, 420],
  A1: [841, 594],
  A0: [1189, 841],
  'ANSI A': [279.4, 215.9],
  'ANSI B': [431.8, 279.4],
  'ANSI C': [558.8, 431.8],
  'ANSI D': [863.6, 558.8],
  'ANSI E': [1117.6, 863.6]
};
export type SheetSize = keyof typeof SHEETS;

/** Every scale offered, largest first. */
export const SCALES = [
  10, 5, 4, 3, 2, 1, 1 / 2, 1 / 3, 1 / 4, 1 / 5, 1 / 6, 1 / 7, 1 / 8, 1 / 9, 1 / 10, 1 / 12, 1 / 16, 1 / 20, 1 / 25, 1 / 32, 1 / 40, 1 / 50, 1 / 75, 1 / 100, 1 / 200,
  1 / 500, 1 / 1000, 1 / 2000, 1 / 5000
];
/** The standard ones (ISO 5455), which the automatic scale picks from. */
export const AUTO_SCALES = [10, 5, 2, 1, 1 / 2, 1 / 5, 1 / 10, 1 / 20, 1 / 50, 1 / 100, 1 / 200, 1 / 500, 1 / 1000, 1 / 2000, 1 / 5000];

export const scaleLabel = (scale: number) => (scale >= 1 ? `${trim(scale, 3)}:1` : `1:${trim(1 / scale, 3)}`);

/** The views the kernel draws: Z is up in the model. */
export const VIEW_SPECS: ViewSpec[] = [
  { id: 'front', dir: [0, -1, 0], xAxis: [1, 0, 0] },
  { id: 'top', dir: [0, 0, 1], xAxis: [1, 0, 0] },
  // Seen from the left (first angle puts it on the right of the front view).
  { id: 'left', dir: [-1, 0, 0], xAxis: [0, -1, 0] },
  // Seen from the right (third angle puts it on the right).
  { id: 'right', dir: [1, 0, 0], xAxis: [0, 1, 0] },
  { id: 'iso', dir: [1, -1, 1], xAxis: [1, 1, 0] }
];

export const VIEW_NAMES: Record<string, string> = { front: 'Front view', top: 'Top view', left: 'Side view', right: 'Side view', iso: 'Isometric view' };

/** The options, with their defaults. */
export function drawingOptions(doc: ProjectDoc) {
  const drawingOptions: DrawingOptions = doc.drawing ?? {};
  const appUnits = units();

  return {
    title: drawingOptions.title ?? (doc.name || 'Untitled'),
    size: (drawingOptions.size ?? 'A3') as SheetSize,
    portrait: drawingOptions.portrait ?? false,
    angle: drawingOptions.angle ?? 'first',
    scale: drawingOptions.scale,
    hidden: drawingOptions.hidden ?? true,
    views: { front: drawingOptions.views?.front ?? true, top: drawingOptions.views?.top ?? true, side: drawingOptions.views?.side ?? true, iso: drawingOptions.views?.iso ?? drawingOptions.iso ?? true },
    bodies: drawingOptions.bodies,
    titleBlock: drawingOptions.titleBlock ?? 'table',
    revisions: drawingOptions.revisions ?? [],
    dateFormat: drawingOptions.dateFormat ?? 'iso',
    units: drawingOptions.units ?? (appUnits === 'ft' ? 'in' : appUnits),
    precision: drawingOptions.precision ?? 2,
    anglePrecision: drawingOptions.anglePrecision ?? 1,
    comma: drawingOptions.comma ?? false,
    lines: { visible: drawingOptions.lines?.visible ?? 0.5, hidden: drawingOptions.lines?.hidden ?? 0.25, dims: drawingOptions.lines?.dims ?? 0.25, center: drawingOptions.lines?.center ?? 0.25, section: drawingOptions.lines?.section ?? 0.18 },
    balloons: drawingOptions.balloons ?? true,
    balloonAt: drawingOptions.balloonAt ?? {},
    overall: drawingOptions.overall ?? true,
    overallDims: drawingOptions.overallDims ?? {},
    moved: drawingOptions.moved ?? {},
    dims: drawingOptions.dims ?? [],
    notes: drawingOptions.notes ?? [],
    sections: drawingOptions.sections ?? [],
    details: drawingOptions.details ?? [],
    marks: drawingOptions.marks ?? [],
    extra: drawingOptions.extra ?? [],
    isoScale: drawingOptions.isoScale,
    images: drawingOptions.images ?? []
  };
}
export type Opts = ReturnType<typeof drawingOptions>;

/** The paper, as it lies (portrait: turned). */
export function sheetSize(options: Opts): [number, number] {
  const [width, height] = SHEETS[options.size];

  return options.portrait ? [height, width] : [width, height];
}

/** A length (mm) as the drawing writes it: its units, its decimals (no trailing zeros), its decimal mark. */
export function lengthText(mm: number, options: Opts): string {
  const value = mm / UNIT_MM[options.units];
  let t = value.toFixed(options.precision);
  if (t.includes('.')) {
    t = t.replace(/0+$/, '').replace(/\.$/, '');
  }
  if (t === '-0') {
    t = '0';
  }

  return options.comma ? t.replace('.', ',') : t;
}

/** An angle (radians) as the drawing writes it: degrees, its decimals, its decimal mark. */
export function angleText(rad: number, options: Opts): string {
  let t = ((Math.abs(rad) * 180) / Math.PI).toFixed(options.anglePrecision);
  if (t.includes('.')) {
    t = t.replace(/0+$/, '').replace(/\.$/, '');
  }

  return `${options.comma ? t.replace('.', ',') : t}°`;
}

// ---- Section and detail views

type V3 = [number, number, number];
const v3 = {
  mul: (a: V3, factor: number): V3 => [a[0] * factor, a[1] * factor, a[2] * factor],
  sub: (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  cross: (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
  unit: (a: V3): V3 => {
    const length = Math.hypot(a[0], a[1], a[2]) || 1;

    return [a[0] / length, a[1] / length, a[2] / length];
  }
};

/** The way a section view sits from its view, on the paper: where its arrows point (first angle), the other way (third angle). */
export const placeDir = (sec: DrawingSection, options: Opts): [number, number] => (options.angle === 'first' ? sec.look : [-sec.look[0], -sec.look[1]]);

/** What a view is (a base view, a section of one, a view added by hand); null for one it can't say, or an isometric one (nothing is cut or projected square from those). */
export function specOf(id: string, options: Opts, depth = 0): ViewSpec | null {
  const base = VIEW_SPECS.find(viewSpec => viewSpec.id === id);
  if (base) {
    return id === 'iso' ? null : base;
  }
  if (depth >= 8) {
    return null;
  }
  const sec = options.sections.find(section => section.id === id);
  if (sec) {
    return sectionSpec(sec, options, depth + 1);
  }
  const ex = options.extra.find(drawingView => drawingView.id === id);

  return ex && !isIsoView(ex) ? extraSpec(ex, options, depth + 1) : null;
}

/** The ways a base view can look: towards the eye from the model (Z up), and the paper's x. */
export const ORIENTS: Record<ViewOrient, { dir: V3; xAxis: V3; name: string }> = {
  front: { dir: [0, -1, 0], xAxis: [1, 0, 0], name: 'Front' },
  back: { dir: [0, 1, 0], xAxis: [-1, 0, 0], name: 'Back' },
  top: { dir: [0, 0, 1], xAxis: [1, 0, 0], name: 'Top' },
  bottom: { dir: [0, 0, -1], xAxis: [1, 0, 0], name: 'Bottom' },
  left: { dir: [-1, 0, 0], xAxis: [0, -1, 0], name: 'Left' },
  right: { dir: [1, 0, 0], xAxis: [0, 1, 0], name: 'Right' },
  'iso-fr': { dir: [1, -1, 1], xAxis: [1, 1, 0], name: 'Isometric – Front Right' },
  'iso-fl': { dir: [-1, -1, 1], xAxis: [1, -1, 0], name: 'Isometric – Front Left' },
  'iso-br': { dir: [1, 1, 1], xAxis: [-1, 1, 0], name: 'Isometric – Back Right' },
  'iso-bl': { dir: [-1, 1, 1], xAxis: [-1, -1, 0], name: 'Isometric – Back Left' }
};

/** An added view seen from a corner: a base view of an isometric corner, or one projected to a corner of its view. */
export const isIsoView = (drawingView: DrawingView) => (drawingView.orient ? drawingView.orient.startsWith('iso') : !!(drawingView.dir && drawingView.dir[0] && drawingView.dir[1]));

/**
 * An added view's direction. A base view: its own. A projection square on (a
 * side of its view): first angle puts the view from the other side there,
 * third angle the view from that side, lined up with its view the way the
 * standard views are. A projection to a corner: the isometric view from that
 * corner of its view (front view, up and right: from the front, right, top).
 */
export function extraSpec(drawingView: DrawingView, options: Opts, depth = 0): ViewSpec | null {
  if (drawingView.orient) {
    const orient = ORIENTS[drawingView.orient];

    return orient ? { id: drawingView.id, dir: orient.dir, xAxis: orient.xAxis } : null;
  }
  if (!drawingView.view || !drawingView.dir || (!drawingView.dir[0] && !drawingView.dir[1])) {
    return null;
  }
  const parent = specOf(drawingView.view, options, depth);
  if (!parent) {
    return null;
  }
  const direction = v3.unit(parent.dir as V3);
  const xAxis = v3.unit(parent.xAxis as V3);
  const yAxis = v3.cross(direction, xAxis);
  const [p0, p1] = [Math.sign(drawingView.dir[0]), Math.sign(drawingView.dir[1])];
  const P3 = v3.sub(v3.mul(xAxis, p0), v3.mul(yAxis, p1));
  if (p0 && p1) {
    const dir = v3.unit([direction[0] + P3[0], direction[1] + P3[1], direction[2] + P3[2]]);

    return { id: drawingView.id, dir, xAxis: v3.unit(v3.cross(yAxis, dir)) };
  }
  const dir = options.angle === 'first' ? v3.mul(P3, -1) : P3;

  return { id: drawingView.id, dir, xAxis: p1 ? xAxis : v3.cross(yAxis, dir) };
}

/** What an added view is called on the sheet: the side it shows ("Back view"), or isometric. */
export function extraName(drawingView: DrawingView, options: Opts): string {
  if (isIsoView(drawingView)) {
    return 'Isometric view';
  }
  const sp = extraSpec(drawingView, options);
  if (!sp) {
    return 'View';
  }
  const direction = v3.unit(sp.dir as V3);
  for (const viewOrient of ['front', 'back', 'top', 'bottom', 'left', 'right'] as ViewOrient[]) {
    const dir = ORIENTS[viewOrient].dir;
    if (direction[0] * dir[0] + direction[1] * dir[1] + direction[2] * dir[2] > 0.9999) {
      return `${ORIENTS[viewOrient].name} view`;
    }
  }

  return 'View';
}

/** Every view the sheet asks the kernel for, past the standard ones: sections, then the added views. */
export function extraSpecs(options: Opts): ViewSpec[] {
  return [...options.sections.map(section => sectionSpec(section, options)), ...options.extra.map(drawingView => extraSpec(drawingView, options))].filter((viewSpec): viewSpec is ViewSpec => !!viewSpec);
}

/**
 * A section view's direction and cut: looking along its arrows, square to the
 * cut line, turned so that it lines up with the view it is cut from (along
 * the line) - the way a projected view lines up.
 */
export function sectionSpec(sec: DrawingSection, options: Opts, depth = 0): ViewSpec | null {
  const parent = specOf(sec.view, options, depth);
  if (!parent) {
    return null;
  }
  const direction = v3.unit(parent.dir as V3);
  const unitX = v3.unit(parent.xAxis as V3);
  const yAxis = v3.cross(direction, unitX);
  const to3 = (q: [number, number]): V3 => v3.sub(v3.mul(unitX, q[0]), v3.mul(yAxis, q[1]));
  const length = Math.hypot(sec.b[0] - sec.a[0], sec.b[1] - sec.a[1]);
  if (length < 1e-9) {
    return null;
  }
  const along: [number, number] = [(sec.b[0] - sec.a[0]) / length, (sec.b[1] - sec.a[1]) / length];
  const dir = v3.mul(to3(sec.look), -1);
  const pl = placeDir(sec, options);
  let xAxis: V3;
  if (Math.abs(pl[1]) >= Math.abs(pl[0])) {
    xAxis = to3(along[0] < 0 ? [-along[0], -along[1]] : along);
  } else {
    xAxis = v3.cross(v3.mul(to3(along[1] < 0 ? [-along[0], -along[1]] : along), -1), dir);
  }

  return { id: sec.id, dir, xAxis, cut: to3(sec.a) };
}

/** The next free letter for a section or a detail (I, O and Q are left out: they read as numbers). */
export function nextLetter(options: Opts): string {
  const used = new Set([...options.sections.map(section => section.letter), ...options.details.map(detail => detail.letter)]);
  const letters = 'ABCDEFGHJKLMNPRSTUVWXYZ'.split('');
  for (let index = 1; ; index++) {
    for (const letter of letters) {
      if (!used.has(letter.repeat(index))) {
        return letter.repeat(index);
      }
    }
  }
}

export function dateText(date: Date, format: Opts['dateFormat']): string {
  const dd = String(date.getDate()).padStart(2, '0');
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const yy = String(date.getFullYear() % 100).padStart(2, '0');
  if (format === 'dmy') {
    return `${dd}/${mm}/${yy}`;
  }
  if (format === 'mdy') {
    return `${mm}/${dd}/${yy}`;
  }

  return `${date.getFullYear()}-${mm}-${dd}`;
}

// ---- Layout (all in mm on the paper)

const FRAME_L = 20;
const FRAME = 10;
/** Title block: ISO 7200 width. */
export const TB_W = 180;
const TB_H = 36;
const ROW = 6;
/** Vertical title block: its width. */
const VB_W = 60;
/** Horizontal title block: the height of a row of it (two rows on a narrow sheet). */
const HB_ROW = 13;
const stripRows = (sheetWidth: number) => (sheetWidth - FRAME - FRAME_L < 330 ? 2 : 1);
/** Rows of the revision table, with its header (an empty one while there are none). */
const revRows = (options: Opts) => Math.max(1, options.revisions.length) + 1;

/**
 * The room the title block leaves the views: the drawing area's right and
 * bottom edges (a strip or a column takes its side) and the height of the
 * block in the corner (0: none).
 */
export function sheetRoom(options: Opts, parts: number, sheetWidth: number, sheetHeight: number): { R: number; B: number; cornerH: number } {
  const right = sheetWidth - FRAME;
  const bottom = sheetHeight - FRAME;
  if (options.titleBlock === 'horizontal') {
    return { R: right, B: bottom - HB_ROW * stripRows(sheetWidth) - 2, cornerH: 0 };
  }
  if (options.titleBlock === 'vertical') {
    return { R: right - VB_W - 2, B: bottom, cornerH: 0 };
  }
  const cornerH
    = options.titleBlock === 'table' ? TB_H + (parts ? ROW * (listRows(parts, sheetHeight) + 1) : 0) : options.titleBlock === 'simple' ? TB_H : options.titleBlock === 'block' ? TB_H + ROW * revRows(options) : 0;

  return { R: right, B: bottom, cornerH };
}
/** Room for dimensions around the orthographic views, and between them. */
const DIM = 14;
const GAP = 22;
/** Room for balloons around the isometric view. */
const ISO_PAD = 16;

type Box = [[number, number], [number, number]];
const bw = (b: Box | null) => (b ? b[1][0] - b[0][0] : 0);
const bh = (b: Box | null) => (b ? b[1][1] - b[0][1] : 0);

export interface Placed {
  id: string;
  /** An isometric view (no hidden lines, nothing measured on it). */
  iso?: boolean;
  /** The drawn view its lines come from (a detail's: its view's), if not its own. */
  src?: string;
  /** A detail: the circle it is cut to, on the paper. */
  clip?: { c: [number, number]; r: number };
  /** Where the view's box corner (lowest x, lowest y) goes on the paper. */
  x: number;
  y: number;
  s: number;
  box: Box;
}

export interface Layout {
  W: number;
  H: number;
  scale: number;
  /** Scale of the isometric view (it may be smaller than the others). */
  isoScale?: number;
  views: Placed[];
  /** The side view used: "left" (first angle) or "right" (third angle). */
  side: 'left' | 'right';
  /** Every view inside the frame, off the title block (a scale too big, or moved off it, doesn't). */
  fits: boolean;
}

/** Where a view's point (its own mm) is on the paper, and back. */
export const toPaper = (placed: Placed, q: [number, number]): [number, number] => [placed.x + (q[0] - placed.box[0][0]) * placed.s, placed.y + (q[1] - placed.box[0][1]) * placed.s];
export const fromPaper = (placed: Placed, q: [number, number]): [number, number] => [placed.box[0][0] + (q[0] - placed.x) / placed.s, placed.box[0][1] + (q[1] - placed.y) / placed.s];

/** The paper a placed view takes: its box, or a detail's circle. */
export function extent(placed: Placed): { x0: number; y0: number; x1: number; y1: number } {
  if (placed.clip) {
    return { x0: placed.clip.c[0] - placed.clip.r, y0: placed.clip.c[1] - placed.clip.r, x1: placed.clip.c[0] + placed.clip.r, y1: placed.clip.c[1] + placed.clip.r };
  }

  return { x0: placed.x, y0: placed.y, x1: placed.x + bw(placed.box) * placed.s, y1: placed.y + bh(placed.box) * placed.s };
}

/** Where each view goes, and at which scale: the largest standard scale at which they fit. Views moved by hand stay moved. */
export function layoutSheet(views: Map<string, ProjectedView>, options: Opts, parts: number): Layout {
  const [sheetWidth, sheetHeight] = sheetSize(options);
  const room = sheetRoom(options, parts, sheetWidth, sheetHeight);
  const frameRight = room.R;
  const frameBottom = room.B;
  const frameTop = FRAME;
  const blockH = room.cornerH ? room.cornerH + 2 : 0;
  const corner = { x0: frameRight - TB_W, y0: frameBottom - blockH };
  const side = options.angle === 'first' ? 'left' : 'right';
  const first = options.angle === 'first';
  const box = (id: string) => views.get(id)?.box ?? null;
  const front = options.views.front ? box('front') : null;
  const top = options.views.top ? box('top') : null;
  const sideBox = options.views.side ? box(side) : null;
  const iso = options.views.iso ? box('iso') : null;
  type Rect = { x0: number; y0: number; x1: number; y1: number };
  const overlaps = (a: Rect, b: Rect) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
  const cornerRect: Rect = { x0: corner.x0, y0: corner.y0, x1: frameRight, y1: frameBottom };
  // The orthographic views share their sizes: width with the top view, height with the side view.
  const W_ = bw(front ?? top ?? box('front'));
  const H_ = bh(front ?? sideBox ?? box('front'));
  const D_ = bh(top) || bw(sideBox);

  /** The orthographic views at `scale`: each placed, and the room it takes (with its dimensions). */
  const ortho = (scale: number) => {
    const x0 = FRAME_L + DIM;
    const y0 = frameTop + (first ? DIM : 3);
    const fw = W_ * scale;
    const fh = H_ * scale;
    const th = D_ * scale;
    const fy = top && !first ? y0 + th + GAP : y0;
    const ty = first ? y0 + (front || sideBox ? fh + GAP : 0) : y0;
    const sx = x0 + (front || top ? fw + GAP : 0);
    const out: { id: string; box: Box; x: number; y: number; room: Rect }[] = [];
    const dimTop = first ? DIM : 3;
    const dimBottom = first ? 3 : DIM;
    if (front) {
      out.push({ id: 'front', box: front, x: x0, y: fy, room: { x0: x0 - DIM, y0: fy - dimTop, x1: x0 + fw + 3, y1: fy + fh + dimBottom } });
    }
    if (sideBox) {
      out.push({ id: side, box: sideBox, x: sx, y: fy, room: { x0: sx - 3, y0: fy - dimTop, x1: sx + bw(sideBox) * scale + 3, y1: fy + bh(sideBox) * scale + dimBottom } });
    }
    if (top) {
      out.push({ id: 'top', box: top, x: x0, y: ty, room: { x0: x0 - 3, y0: ty - 3, x1: x0 + fw + 3, y1: ty + th + 3 } });
    }

    return out;
  };
  const orthoFits = (scale: number) => ortho(scale).every(view => view.room.x1 <= frameRight && view.room.y1 <= frameBottom && !overlaps(view.room, cornerRect));

  /** Free places for the isometric view, beside the orthographic ones. */
  const isoRooms = (scale: number): Rect[] => {
    const vs = ortho(scale);
    if (!vs.length) {
      return [{ x0: FRAME_L, y0: frameTop, x1: frameRight, y1: corner.y0 }];
    }
    const right = Math.max(...vs.map(view => view.room.x1));
    const bottom = Math.max(...vs.map(view => view.room.y1));
    const room = vs.find(view => view.id === 'front')?.room;
    const sd = vs.find(view => view.id === side)?.room;
    const rooms: Rect[] = [{ x0: right, y0: frameTop, x1: frameRight, y1: corner.y0 }];
    // The quadrant the projection leaves empty: below the side view (first angle), above it (third angle).
    if (room && sd) {
      rooms.push(first ? { x0: sd.x0, y0: room.y1, x1: frameRight, y1: corner.y0 } : { x0: sd.x0, y0: frameTop, x1: frameRight, y1: room.y0 });
    }
    // Below them all, left of the title block.
    rooms.push({ x0: FRAME_L, y0: bottom, x1: blockH ? corner.x0 : frameRight, y1: frameBottom });

    return rooms.filter(rect => rect.x1 > rect.x0 && rect.y1 > rect.y0);
  };
  const isoFor = (scale: number, least: number): { si: number; room: Rect } | undefined => {
    if (!iso) {
      return undefined;
    }
    const rooms = isoRooms(scale);
    for (const si of AUTO_SCALES) {
      if (si > scale || si < scale * least) {
        continue;
      }
      const room = rooms.find(room => bw(iso) * si + 2 * ISO_PAD <= room.x1 - room.x0 && bh(iso) * si + 2 * ISO_PAD + 5 <= room.y1 - room.y0);
      if (room) {
        return { si, room };
      }
    }

    return undefined;
  };
  let scale = options.scale;
  if (!scale) {
    // The largest scale the views fit at, with the isometric one no smaller than a fifth of it if it can be.
    // A standard one, unless the next standard one down is far smaller than one
    // in between (1:5 where 1:3 fits leaves most of the sheet empty).
    const ok = (scale: number) => (front || top || sideBox ? orthoFits(scale) : !!isoFor(scale, 1));
    const best = (list: number[]) => list.find(scale => ok(scale) && (!iso || options.isoScale || isoFor(scale, 1 / 5)));
    const std = best(AUTO_SCALES);
    const any = best(SCALES);
    scale = (std && (!any || std >= any * 0.7) ? std : any) ?? AUTO_SCALES.find(ok) ?? AUTO_SCALES[AUTO_SCALES.length - 1];
  }
  const chosen = scale;
  const placed: Placed[] = ortho(chosen).map(view => ({ id: view.id, x: view.x, y: view.y, s: chosen, box: view.box }));
  // The isometric view at the scale it was given (where it fits, if it does), or the largest that fits.
  const given = options.isoScale;
  const isoAt
    = iso && given
      ? { si: given, room: isoRooms(chosen).find(isoRoom => bw(iso) * given + 2 * ISO_PAD <= isoRoom.x1 - isoRoom.x0 && bh(iso) * given + 2 * ISO_PAD + 5 <= isoRoom.y1 - isoRoom.y0) ?? isoRooms(chosen)[0] ?? { x0: FRAME_L, y0: frameTop, x1: frameRight, y1: frameBottom } }
      : (isoFor(chosen, 1 / 20) ?? (iso ? { si: chosen, room: { x0: FRAME_L, y0: frameTop, x1: frameRight, y1: frameBottom } } : undefined));
  if (iso && isoAt) {
    const { si, room } = isoAt;
    placed.push({ id: 'iso', iso: true, x: (room.x0 + room.x1 - bw(iso) * si) / 2, y: (room.y0 + room.y1 - bh(iso) * si - 5) / 2, s: si, box: iso });
  }
  // Moved by hand: the front view takes the projected ones along; they move only along their line with it.
  const movedBy = (key: string) => options.moved[key] ?? [0, 0];
  for (const placedView of placed) {
    const [gx, gy] = placedView.id === 'iso' ? [0, 0] : movedBy('front');
    const [ox, oy] = placedView.id === 'iso' ? movedBy('iso') : placedView.id === 'top' ? [0, movedBy('top')[1]] : placedView.id === side ? [movedBy('side')[0], 0] : [0, 0];
    placedView.x += gx + ox;
    placedView.y += gy + oy;
  }
  // Base views added by hand: where they were put, at their own scale.
  const centred = (id: string, box: Box, at: [number, number], sc: number, isoView: boolean): Placed => ({ id, iso: isoView || undefined, x: at[0] - (bw(box) * sc) / 2, y: at[1] - (bh(box) * sc) / 2, s: sc, box });
  for (const drawingView of options.extra) {
    const box = views.get(drawingView.id)?.box;
    if (drawingView.orient && box) {
      placed.push(centred(drawingView.id, box, drawingView.at ?? [(FRAME_L + frameRight) / 2, (frameTop + frameBottom) / 2], drawingView.scale ?? chosen, isIsoView(drawingView)));
    }
  }
  // Sections and projections, each lined up with its view, as far off it as it
  // was put (`gap`: from its view's edge to its middle - never so little that it
  // would lie on its view, or a section on its arrows); a projection to a
  // corner where it was put.
  const aligned = (placed: Placed, box: Box, pl: [number, number], gap: number, least: number): [number, number] => {
    const width = bw(box) * placed.s;
    const height = bh(box) * placed.s;
    const pr = extent(placed);
    if (Math.abs(pl[1]) >= Math.abs(pl[0])) {
      const spacing = Math.max(gap, height / 2 + least);

      return [placed.x + (box[0][0] - placed.box[0][0]) * placed.s, pl[1] > 0 ? pr.y1 + spacing - height / 2 : pr.y0 - spacing - height / 2];
    }
    const sideSpacing = Math.max(gap, width / 2 + least);

    return [pl[0] > 0 ? pr.x1 + sideSpacing - width / 2 : pr.x0 - sideSpacing - width / 2, placed.y + (box[0][1] - placed.box[0][1]) * placed.s];
  };
  type Waiting = { id: string; view: string; place: (p: Placed, box: Box) => Placed };
  const waiting: Waiting[] = [
    ...options.sections.map(sec => ({ id: sec.id, view: sec.view, place: (placed: Placed, box: Box) => ({ id: sec.id, ...xy(aligned(placed, box, placeDir(sec, options), sec.gap, 16)), s: placed.s, box }) })),
    ...options.extra
      .filter(drawingView => !drawingView.orient && drawingView.view && drawingView.dir)
      .map(drawingView => ({
        id: drawingView.id,
        view: drawingView.view!,
        place: (placed: Placed, box: Box): Placed => {
          if (isIsoView(drawingView)) {
            const pr = extent(placed);
            const sc = drawingView.scale ?? placed.s;
            const at = drawingView.at ?? [(pr.x0 + pr.x1) / 2 + Math.sign(drawingView.dir![0]) * ((pr.x1 - pr.x0) / 2 + (bw(box) * sc) / 2 + 20), (pr.y0 + pr.y1) / 2 + Math.sign(drawingView.dir![1]) * ((pr.y1 - pr.y0) / 2 + (bh(box) * sc) / 2 + 20)];

            return centred(drawingView.id, box, at, sc, true);
          }

          return { id: drawingView.id, ...xy(aligned(placed, box, drawingView.dir!, drawingView.gap ?? 0, 8)), s: placed.s, box };
        }
      }))
  ];
  for (let grew = true; grew; ) {
    grew = false;
    for (let i = 0; i < waiting.length; i++) {
      const waiter = waiting[i];
      const placedView = placed.find(placed => placed.id === waiter.view);
      const box = views.get(waiter.id)?.box;
      if (!placedView || !box || placedView.clip) {
        continue;
      }
      waiting.splice(i--, 1);
      grew = true;
      placed.push(waiter.place(placedView, box));
    }
  }
  // Details: a circle of their view, bigger, where they were put.
  for (const det of options.details) {
    const placedView = placed.find(placed => placed.id === det.view);
    if (!placedView || placedView.clip) {
      continue;
    }
    const sd = det.scale ?? placedView.s * 2;
    placed.push({ id: det.id, src: placedView.src ?? placedView.id, x: det.at[0] - (det.c[0] - placedView.box[0][0]) * sd, y: det.at[1] - (det.c[1] - placedView.box[0][1]) * sd, s: sd, box: placedView.box, clip: { c: det.at, r: det.r * sd } });
  }
  const e = 0.01;
  const fits = placed.every((placed) => {
    const bounds = extent(placed);

    return bounds.x0 >= FRAME_L - e && bounds.y0 >= frameTop - e && bounds.x1 <= frameRight + e && bounds.y1 <= frameBottom + e && !(blockH && overlaps(bounds, { x0: cornerRect.x0 + e, y0: cornerRect.y0 + e, x1: frameRight, y1: frameBottom }));
  });

  return { W: sheetWidth, H: sheetHeight, scale: chosen, isoScale: isoAt?.si, views: placed, side, fits };
}

const xy = (q: [number, number]) => ({ x: q[0], y: q[1] });

/**
 * How many rows the parts list on the sheet has: all the parts, or - when
 * they would take more than half the sheet's height - as many as fit, the
 * last one saying how many more there are (the technical sheet lists them all).
 */
export function listRows(parts: number, sheetHeight: number): number {
  const most = Math.max(2, Math.floor(((sheetHeight - 2 * FRAME) * 0.5 - TB_H) / ROW) - 1);

  return Math.min(parts, most);
}

/** The key a view's hand move is kept under. */
export const moveKey = (id: string) => (id === 'left' || id === 'right' ? 'side' : id);

// ---- Drawing the sheet (SVG, mm)

const round2 = (value: number) => String(Math.round(value * 100) / 100);
const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const FONT = 'font-family="Arial, Helvetica, sans-serif"';
const SEL = '#1a73e8';

/**
 * A path from the kernel (mm, at 1:1) moved to its place on the paper. Kept
 * for the place it was last put at: dragging a note or a dimension redraws
 * the sheet each move, with the views where they were.
 */
const placedPaths = new Map<string, { at: string; d: string }>();
function placePath(pathData: string, placed: Placed): string {
  const at = `${placed.x} ${placed.y} ${placed.s} ${placed.box[0][0]} ${placed.box[0][1]}`;
  const had = placedPaths.get(pathData);
  if (had?.at === at) {
    return had.d;
  }
  const out = pathData.replace(/([ML])(-?[\d.]+) (-?[\d.]+)/g, (_, command: string, x: string, y: string) => `${command}${round2(placed.x + (Number(x) - placed.box[0][0]) * placed.s)} ${round2(placed.y + (Number(y) - placed.box[0][1]) * placed.s)}`);
  // (A few hundred paths at most on a sheet: dropped all at once past that.)
  if (placedPaths.size > 2000) {
    placedPaths.clear();
  }
  placedPaths.set(pathData, { at, d: out });

  return out;
}

function text(x: number, y: number, t: string, size: number, opts: { anchor?: string; angle?: number; weight?: string; fill?: string } = {}): string {
  const rot = opts.angle ? ` transform="rotate(${round2(opts.angle)} ${round2(x)} ${round2(y)})"` : '';

  return `<text x="${round2(x)}" y="${round2(y)}" font-size="${round2(+size)}" ${FONT} text-anchor="${esc(String(opts.anchor ?? 'start'))}"${opts.weight ? ` font-weight="${esc(String(opts.weight))}"` : ''} fill="${esc(String(opts.fill ?? '#000'))}"${rot}>${esc(t)}</text>`;
}

/** A rough width of a text (Arial: about 0.55 of its size a letter). */
const textWidth = (t: string, size: number) => t.length * size * 0.55;

/** A dimension's text: its value (`main`); a tolerance stacked after it (`up` over `down`), then `tail`; `boxed`: a basic size. */
export interface DimLabel {
  main: string;
  up?: string;
  down?: string;
  tail?: string;
  boxed?: boolean;
}
const labelOf = (label: string | DimLabel): DimLabel => (typeof label === 'string' ? { main: label } : label);
const labelWidth = (dimensionLabel: DimLabel, size: number) =>
  textWidth(dimensionLabel.main, size) + (dimensionLabel.up || dimensionLabel.down ? Math.max(textWidth(dimensionLabel.up ?? '', size * 0.7), textWidth(dimensionLabel.down ?? '', size * 0.7)) + 0.8 : 0) + textWidth(dimensionLabel.tail ?? '', size);

/** A dimension's text, its middle at (x, y) (its baseline), turned `angle` degrees. */
function labelSVG(x: number, y: number, label: string | DimLabel, size: number, color: string, angle = 0): string {
  const dimensionLabel = labelOf(label);
  if (!dimensionLabel.up && !dimensionLabel.down && !dimensionLabel.boxed && !dimensionLabel.tail) {
    return text(x, y, dimensionLabel.main, size, { anchor: 'middle', angle, fill: color });
  }
  const width = labelWidth(dimensionLabel, size);
  const x0 = x - width / 2;
  const wm = textWidth(dimensionLabel.main, size);
  let out = dimensionLabel.main ? text(x0, y, dimensionLabel.main, size, { fill: color }) : '';
  if (dimensionLabel.boxed) {
    out += `<rect x="${round2(x0 - 0.8)}" y="${round2(y - size * 0.9)}" width="${round2(wm + 1.6)}" height="${round2(size * 1.2)}" stroke="${color}" stroke-width="0.25" fill="none"/>`;
  }
  let xt = x0 + wm;
  if (dimensionLabel.up || dimensionLabel.down) {
    const smallSize = size * 0.7;
    const xs = x0 + wm + 0.8;
    out += text(xs, y - size * 0.45, dimensionLabel.up ?? '', smallSize, { fill: color }) + text(xs, y + size * 0.25, dimensionLabel.down ?? '', smallSize, { fill: color });
    xt = xs + Math.max(textWidth(dimensionLabel.up ?? '', smallSize), textWidth(dimensionLabel.down ?? '', smallSize));
  }
  if (dimensionLabel.tail) {
    out += text(xt, y, dimensionLabel.tail, size, { fill: color });
  }

  return angle ? `<g transform="rotate(${round2(angle)} ${round2(x)} ${round2(y)})">${out}</g>` : out;
}

/** A filled arrowhead, 3 mm long, its tip at (x, y), pointing along (dx, dy). */
function arrow(x: number, y: number, dx: number, dy: number, color: string): string {
  const length = 3;
  const width = 0.9;
  const bx = x - dx * length;
  const by = y - dy * length;

  return `<path d="M${round2(x)} ${round2(y)}L${round2(bx - dy * width)} ${round2(by + dx * width)}L${round2(bx + dy * width)} ${round2(by - dx * width)}Z" fill="${color}"/>`;
}

/**
 * A dimension between two points on the paper, its line `offset` mm off to
 * the left of a→b (negative: to the right), with extension lines and the
 * value written along it, readable from the bottom or the right (ISO 129).
 */
export function linearDim(pointA: [number, number], pointB: [number, number], offset: number, label: string | DimLabel, width: number, color = '#000', slide = 0): string {
  const length = Math.hypot(pointB[0] - pointA[0], pointB[1] - pointA[1]);
  if (length < 1e-9) {
    return '';
  }
  const along = [(pointB[0] - pointA[0]) / length, (pointB[1] - pointA[1]) / length];
  const normal = [along[1], -along[0]];
  const sg = Math.sign(offset) || 1;
  const thin = `stroke="${color}" stroke-width="${width}" fill="none"`;
  const offsetPoint = (point: [number, number], offset: number) => [point[0] + normal[0] * offset, point[1] + normal[1] * offset];
  const [a1, a2, b1, b2, da, db] = [offsetPoint(pointA, sg * 1), offsetPoint(pointA, offset + sg * 2), offsetPoint(pointB, sg * 1), offsetPoint(pointB, offset + sg * 2), offsetPoint(pointA, offset), offsetPoint(pointB, offset)];
  let out = Math.abs(offset) > 1 ? `<path d="M${round2(a1[0])} ${round2(a1[1])}L${round2(a2[0])} ${round2(a2[1])}M${round2(b1[0])} ${round2(b1[1])}L${round2(b2[0])} ${round2(b2[1])}" ${thin}/>` : '';
  out += `<path d="M${round2(da[0])} ${round2(da[1])}L${round2(db[0])} ${round2(db[1])}" ${thin}/>`;
  out += arrow(da[0], da[1], -along[0], -along[1], color) + arrow(db[0], db[1], along[0], along[1], color);
  let ang = (Math.atan2(along[1], along[0]) * 180) / Math.PI;
  if (ang > 90.01) {
    ang -= 180;
  }
  if (ang <= -90.01) {
    ang += 180;
  }
  const t = (ang * Math.PI) / 180;
  // The value slid along: past an end, the dimension line runs on under it.
  const half = labelWidth(labelOf(label), 3.5) / 2 + 1;
  if (Math.abs(slide) > length / 2 - half) {
    const sign = slide > 0 ? 1 : -1;
    const from = sign > 0 ? db : da;
    const reach = Math.abs(slide) + half - length / 2;
    if (reach > 0) {
      out += `<path d="M${round2(from[0])} ${round2(from[1])}L${round2(from[0] + along[0] * sign * reach)} ${round2(from[1] + along[1] * sign * reach)}" ${thin}/>`;
    }
  }
  const mid = [(da[0] + db[0]) / 2 + along[0] * slide + Math.sin(t) * 1.2, (da[1] + db[1]) / 2 + along[1] * slide - Math.cos(t) * 1.2];

  return out + labelSVG(mid[0], mid[1], label, 3.5, color, ang);
}

/**
 * An angle: an arc round C from ray C→A to ray C→B (the smaller way), R mm
 * out, arrows at its ends, the value outside its middle; the rays drawn on
 * (thin) when the arc lies beyond the edges.
 */
export function angleDim(pointC: [number, number], pointA: [number, number], pointB: [number, number], radius: number, label: string | DimLabel, width: number, color = '#000', sweep?: number): string {
  const a1 = Math.atan2(pointA[1] - pointC[1], pointA[0] - pointC[0]);
  const t = sweep ?? angleBetween(pointC, pointA, pointB);
  if (Math.abs(t) < 1e-6 || radius < 1) {
    return '';
  }
  const a2 = a1 + t;
  const at = (a: number, arcRadius: number): [number, number] => [pointC[0] + Math.cos(a) * arcRadius, pointC[1] + Math.sin(a) * arcRadius];
  const thin = `stroke="${color}" stroke-width="${width}" fill="none"`;
  const P1 = at(a1, radius);
  const P2 = at(a2, radius);
  let out = `<path d="M${round2(P1[0])} ${round2(P1[1])}A${round2(radius)} ${round2(radius)} 0 ${Math.abs(t) > Math.PI ? 1 : 0} ${t > 0 ? 1 : 0} ${round2(P2[0])} ${round2(P2[1])}" ${thin}/>`;
  for (const [a, end] of [
    [a1, pointA],
    [a2, pointB]
  ] as [number, [number, number]][]) {
    const len = Math.hypot(end[0] - pointC[0], end[1] - pointC[1]);
    if (radius > len + 1) {
      const start = at(a, len + 1);
      const e = at(a, radius + 2);
      out += `<path d="M${round2(start[0])} ${round2(start[1])}L${round2(e[0])} ${round2(e[1])}" ${thin}/>`;
    }
  }
  const sg = Math.sign(t);
  out += arrow(P1[0], P1[1], sg * Math.sin(a1), -sg * Math.cos(a1), color);
  out += arrow(P2[0], P2[1], -sg * Math.sin(a2), sg * Math.cos(a2), color);
  const midpoint = at(a1 + t / 2, radius + 3);

  return out + labelSVG(midpoint[0], midpoint[1] + 1.2, label, 3.5, color);
}

/** A radius or diameter: a leader through the centre to the circle, the value on a shoulder outside it. */
export function circleDim(center: [number, number], radius: number, angle: number, offset: number, label: string | DimLabel, diameter: boolean, width: number, color = '#000'): string {
  const direction = [Math.cos(angle), Math.sin(angle)];
  const at = (distance: number): [number, number] => [center[0] + direction[0] * distance, center[1] + direction[1] * distance];
  const tip = at(radius);
  const end = at(radius + Math.max(2, offset));
  const start = diameter ? at(-radius) : center;
  const thin = `stroke="${color}" stroke-width="${width}" fill="none"`;
  const boxWidth = labelWidth(labelOf(label), 3.5) + 2;
  const right = direction[0] >= 0;
  const sh = [end[0] + (right ? boxWidth : -boxWidth), end[1]];
  let out = `<path d="M${round2(start[0])} ${round2(start[1])}L${round2(end[0])} ${round2(end[1])}L${round2(sh[0])} ${round2(sh[1])}" ${thin}/>`;
  out += arrow(tip[0], tip[1], direction[0], direction[1], color);
  if (diameter) {
    out += arrow(start[0], start[1], -direction[0], -direction[1], color);
  }

  return out + labelSVG((end[0] + sh[0]) / 2, end[1] - 1.2, label, 3.5, color);
}

/** The projection method symbol (ISO 5456-2): a truncated cone, then its end view. */
function projectionSymbol(cx: number, cy: number, angle: 'first' | 'third', width: number): string {
  const line = `stroke="#000" stroke-width="${width}" fill="none"`;
  const outer = 2.4;
  const inner = 1.2;
  const length = 5.5;
  // First angle: the cone's wide end faces its end view; third angle: its narrow end.
  const [a, b] = angle === 'first' ? [inner, outer] : [outer, inner];
  const x = cx - 7;
  const cone = `<path d="M${round2(x)} ${round2(cy - a)}L${round2(x + length)} ${round2(cy - b)}L${round2(x + length)} ${round2(cy + b)}L${round2(x)} ${round2(cy + a)}Z" ${line}/>`;
  const ex = cx + 4;

  return cone + `<circle cx="${round2(ex)}" cy="${round2(cy)}" r="${outer}" ${line}/><circle cx="${round2(ex)}" cy="${round2(cy)}" r="${inner}" ${line}/>`;
}

export interface SheetData {
  doc: ProjectDoc;
  views: Map<string, ProjectedView>;
  parts: PartRow[];
  date: Date;
  /** On screen: views and annotations marked for picking, one shown picked. */
  interactive?: boolean;
  selected?: string | null;
}

/** The whole sheet as an SVG document (mm). */
export function drawingSVG(data: SheetData): { svg: string; layout: Layout; balloons: { id: string; x: number; y: number }[] } {
  const { doc, views, parts } = data;
  const options = drawingOptions(doc);
  const layout = layoutSheet(views, options, parts.length);
  const { W, H } = layout;
  const lw = options.lines;
  const out: string[] = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${round2(W)}mm" height="${round2(H)}mm" viewBox="0 0 ${round2(W)} ${round2(H)}">`);
  out.push(`<rect x="0" y="0" width="${round2(W)}" height="${round2(H)}" fill="#fff"/>`);
  // Hatching for the faces a section cuts (ISO 128-50): thin lines at 45°, the other way for every other body.
  const hatch = (id: string, angle: number) =>
    `<pattern id="${id}" width="2.5" height="2.5" patternUnits="userSpaceOnUse" patternTransform="rotate(${angle})"><path d="M0 0V2.5" stroke="#000" stroke-width="${options.lines.section}"/></pattern>`;
  if (options.sections.length) {
    out.push(`<defs>${hatch('hatch-a', 45)}${hatch('hatch-b', -45)}</defs>`);
  }
  const color = (id: string) => (data.interactive && data.selected === id ? SEL : '#000');

  // ---- Frame (ISO 5457): border, centring marks, grid zones.
  if (options.titleBlock !== 'none') {
    const right = W - FRAME;
    const bottom = H - FRAME;
    out.push(`<rect x="${FRAME_L}" y="${FRAME}" width="${round2(right - FRAME_L)}" height="${round2(bottom - FRAME)}" stroke="#000" stroke-width="0.7" fill="none"/>`);
    const thin = 'stroke="#000" stroke-width="0.35"';
    let ticks = '';
    // The fields (ISO 5457): 50 mm, measured out both ways from the centring
    // marks (the sheet's middle), so a centring mark is always a field line;
    // the end fields take what's left (one too thin joins the next).
    const cuts = (lo: number, hi: number, mid: number) => {
      const at = [mid];
      for (let step = 1; mid - 50 * step > lo; step++) {
        at.unshift(mid - 50 * step);
      }
      for (let step = 1; mid + 50 * step < hi; step++) {
        at.push(mid + 50 * step);
      }

      return [lo, ...at.filter(x => x - lo >= 15 && hi - x >= 15), hi];
    };
    const xs = cuts(FRAME_L, right, W / 2);
    const ys = cuts(FRAME, bottom, H / 2);
    for (let i = 0; i + 1 < xs.length; i++) {
      if (i > 0) {
        ticks += `M${round2(xs[i])} ${FRAME}L${round2(xs[i])} ${FRAME - 5}M${round2(xs[i])} ${round2(bottom)}L${round2(xs[i])} ${round2(bottom + 5)}`;
      }
      const cx = (xs[i] + xs[i + 1]) / 2;
      out.push(text(cx, FRAME - 3.2, String(i + 1), 3, { anchor: 'middle' }), text(cx, bottom + 6.8, String(i + 1), 3, { anchor: 'middle' }));
    }
    for (let j = 0; j + 1 < ys.length; j++) {
      if (j > 0) {
        ticks += `M${FRAME_L} ${round2(ys[j])}L${FRAME_L - 5} ${round2(ys[j])}M${round2(right)} ${round2(ys[j])}L${round2(right + 5)} ${round2(ys[j])}`;
      }
      const cy = (ys[j] + ys[j + 1]) / 2 + 1;
      const letter = String.fromCharCode(65 + j);
      out.push(text(FRAME_L - 5, cy, letter, 3, { anchor: 'middle' }), text(right + 5, cy, letter, 3, { anchor: 'middle' }));
    }
    out.push(`<path d="${ticks}" ${thin}/>`);
    // Centring marks, across the border.
    out.push(
      `<path d="M${round2(W / 2)} ${FRAME - 5}L${round2(W / 2)} ${FRAME + 5}M${round2(W / 2)} ${round2(bottom + 5)}L${round2(W / 2)} ${round2(bottom - 5)}M${FRAME_L - 5} ${round2(H / 2)}L${FRAME_L + 5} ${round2(H / 2)}M${round2(right + 5)} ${round2(H / 2)}L${round2(right - 5)} ${round2(H / 2)}" stroke="#000" stroke-width="0.7"/>`
    );
  }

  // ---- Views (and their dimensions and balloons): inside the frame, off the
  // title block - at a scale too big for the sheet they're cut there, not
  // drawn over them.
  const placed = new Map(layout.views.map(view => [view.id, view]));
  if (!layout.fits) {
    const { R, B, cornerH: blockH } = sheetRoom(options, parts.length, W, H);
    const area = blockH
      ? `M${FRAME_L} ${FRAME}H${R}V${round2(B - blockH)}H${R - TB_W}V${B}H${FRAME_L}Z`
      : `M${FRAME_L} ${FRAME}H${R}V${B}H${FRAME_L}Z`;
    out.push(`<clipPath id="sheet-area"><path d="${area}"/></clipPath><g clip-path="url(#sheet-area)">`);
  }
  // ---- Pictures (under the views).
  for (const im of options.images) {
    const sel = data.interactive && data.selected === im.id;
    const svg = `<image href="${esc(im.src)}" x="${round2(im.x)}" y="${round2(im.y)}" width="${round2(im.w)}" height="${round2(im.h)}" preserveAspectRatio="none"/>${sel ? `<rect x="${round2(im.x)}" y="${round2(im.y)}" width="${round2(im.w)}" height="${round2(im.h)}" fill="none" stroke="${SEL}" stroke-width="0.4" stroke-dasharray="2 1"/>` : ''}`;
    out.push(data.interactive ? `<g data-ann="${esc(String(im.id))}">${svg}</g>` : svg);
  }
  for (const view of layout.views) {
    const projectedView = views.get(view.src ?? view.id);
    if (!projectedView) {
      continue;
    }
    const iso = !!view.iso;
    const ex = options.extra.find(drawingView => drawingView.id === view.id);
    const stroke = color(`view:${view.id}`);
    const sec = options.sections.find(section => section.id === view.id);
    const det = options.details.find(detail => detail.id === view.id);
    const bounds = extent(view);
    const parts: string[] = [];
    if (data.interactive) {
      parts.push(
        view.clip
          ? `<circle cx="${round2(view.clip.c[0])}" cy="${round2(view.clip.c[1])}" r="${round2(view.clip.r + 2)}" fill="transparent" stroke="${stroke === SEL ? SEL : 'none'}" stroke-width="0.3" stroke-dasharray="2 1"/>`
          : `<rect x="${round2(bounds.x0 - 2)}" y="${round2(bounds.y0 - 2)}" width="${round2(bounds.x1 - bounds.x0 + 4)}" height="${round2(bounds.y1 - bounds.y0 + 4)}" fill="transparent" stroke="${stroke === SEL ? SEL : 'none'}" stroke-width="0.3" stroke-dasharray="2 1"/>`
      );
    }
    const lines: string[] = [];
    projectedView.bodies.forEach((b, i) => {
      if (b.section) {
        lines.push(`<path d="${placePath(b.section, view)}" fill="url(#hatch-${i % 2 ? 'b' : 'a'})" fill-rule="evenodd" stroke="none"/>`);
      }
      if (options.hidden && !iso && b.hidden) {
        lines.push(`<path d="${placePath(b.hidden, view)}" stroke="${stroke}" stroke-width="${lw.hidden}" stroke-dasharray="3 1" fill="none"/>`);
      }
      if (b.tangent) {
        lines.push(`<path d="${placePath(b.tangent, view)}" stroke="${stroke}" stroke-width="${lw.dims}" fill="none"/>`);
      }
      if (b.visible) {
        lines.push(`<path d="${placePath(b.visible, view)}" stroke="${stroke}" stroke-width="${lw.visible}" stroke-linecap="round" fill="none"/>`);
      }
    });
    if (view.clip) {
      // A detail: cut to its circle (drawn thin round it).
      const cid = `clip-${view.id.replace(/[^\w-]/g, '')}`;
      parts.push(`<clipPath id="${cid}"><circle cx="${round2(view.clip.c[0])}" cy="${round2(view.clip.c[1])}" r="${round2(view.clip.r)}"/></clipPath><g clip-path="url(#${cid})">${lines.join('')}</g>`);
      parts.push(`<circle cx="${round2(view.clip.c[0])}" cy="${round2(view.clip.c[1])}" r="${round2(view.clip.r)}" stroke="${stroke}" stroke-width="${lw.dims}" fill="none"/>`);
    } else {
      parts.push(...lines);
    }
    if (iso || ex) {
      const label = `${ex ? extraName(ex, options) : 'Isometric view'}${view.s !== layout.scale ? ` (${scaleLabel(view.s)})` : ''}`;
      parts.push(text(view.x + (bw(view.box) * view.s) / 2, view.y + bh(view.box) * view.s + (iso ? ISO_PAD + 2 : 7), label, 3, { anchor: 'middle', fill: stroke }));
    }
    if (sec) {
      parts.push(text((bounds.x0 + bounds.x1) / 2, bounds.y1 + 8, `${sec.letter}-${sec.letter}`, 5, { anchor: 'middle', fill: stroke }));
    }
    if (det) {
      parts.push(text((bounds.x0 + bounds.x1) / 2, bounds.y1 + 8, `${det.letter} (${scaleLabel(view.s)})`, 5, { anchor: 'middle', fill: stroke }));
    }
    out.push(data.interactive ? `<g data-view="${esc(String(view.id))}">${parts.join('')}</g>` : parts.join('\n'));
  }

  // ---- Where the sections are cut (ISO 128-40: a chain line, thick at its
  // ends, arrows the way it is looked at, its letter), and the circles the
  // details are drawn from (thin, with their letter).
  for (const sec of options.sections) {
    const placedView = placed.get(sec.view);
    if (!placedView || !placed.has(sec.id)) {
      continue;
    }
    const stroke = color(`view:${sec.id}`);
    out.push(`<g${data.interactive ? ` data-view="${esc(String(sec.id))}"` : ''}>${cutLine(toPaper(placedView, sec.a), toPaper(placedView, sec.b), sec.look, sec.letter, lw, stroke)}</g>`);
  }
  for (const det of options.details) {
    const placedView = placed.get(det.view);
    if (!placedView || !placed.has(det.id)) {
      continue;
    }
    const stroke = color(`view:${det.id}`);
    const paperPointC = toPaper(placedView, det.c);
    const radius = det.r * placedView.s;
    const at: [number, number] = [paperPointC[0] + (radius + 2.5) * Math.SQRT1_2, paperPointC[1] - (radius + 2.5) * Math.SQRT1_2];
    out.push(
      `<g${data.interactive ? ` data-view="${esc(String(det.id))}"` : ''}><circle cx="${round2(paperPointC[0])}" cy="${round2(paperPointC[1])}" r="${round2(radius)}" stroke="${stroke}" stroke-width="${lw.dims}" fill="none"/>${text(at[0], at[1], det.letter, 5, { fill: stroke })}</g>`
    );
  }

  // ---- Centre marks and centrelines (thin chain lines).
  for (const mark of options.marks) {
    const placedView = placed.get(mark.view);
    if (!placedView) {
      continue;
    }
    const svg = markSVG(mark, placedView, lw.center, color(mark.id));
    out.push(data.interactive ? `<g data-ann="${esc(String(mark.id))}">${svg}</g>` : svg);
  }

  // ---- Overall dimensions (width and height on the front view, depth on the
  // side view), then the dimensions put on by hand: each picked, moved, given text alike.
  for (const drawingDimension of [...overallDims(options, layout), ...options.dims]) {
    const placedView = placed.get(drawingDimension.view);
    if (!placedView) {
      continue;
    }
    const stroke = color(drawingDimension.id);
    const svg = dimSVG(drawingDimension, placedView, options, stroke);
    out.push(data.interactive ? `<g data-ann="${esc(String(drawingDimension.id))}">${svg}</g>` : svg);
  }

  // ---- Notes (pointing at what they are about).
  for (const note of options.notes) {
    const svg = noteSVG(note, note.to ? placed.get(note.to.view) : undefined, lw.dims, color(note.id));
    out.push(data.interactive ? `<g data-ann="${esc(String(note.id))}">${svg}</g>` : svg);
  }

  // ---- Balloons: item numbers of the parts list, each on the isometric view - or,
  // for a part hidden there, the first view it shows in. A part inside a
  // housing, seen in no view, points at its hidden lines.
  const hosts = ['iso', 'front', layout.side, 'top', ...options.extra.map(drawingView => drawingView.id)].map(id => placed.get(id)).filter((placed): placed is Placed => !!placed);
  const byHost = new Map<Placed, { item: number; at: [number, number] }[]>();
  const balloonsAt: { id: string; x: number; y: number }[] = [];
  const spot = (partRow: PartRow) => {
    for (const host of hosts) {
      const b = views.get(host.id)?.bodies.find(body => body.id === partRow.id);
      if (b?.anchor) {
        return { p: host, at: b.anchor };
      }
    }
    if (options.hidden) {
      for (const host of hosts) {
        const b = views.get(host.id)?.bodies.find(body => body.id === partRow.id);
        if (!host.iso && b?.under) {
          return { p: host, at: b.under };
        }
      }
    }

    return null;
  };
  if (options.balloons) {
    for (const part of parts) {
      const partSpot = spot(part);
      if (partSpot) {
        byHost.set(partSpot.p, [...(byHost.get(partSpot.p) ?? []), { item: part.item, at: toPaper(partSpot.p, partSpot.at) }]);
      }
    }
  }
  // Where balloons can't go: off the frame, on the title block, on another view or balloon.
  const taken: [number, number][] = [];
  const room = sheetRoom(options, parts.length, layout.W, layout.H);
  const block = room.cornerH;
  const freeFor = (host: Placed) => (x: number, y: number) => {
    if (x < FRAME_L + 4.5 || y < FRAME + 4.5 || x > room.R - 4.5 || y > room.B - 4.5) {
      return false;
    }
    if (block && x > layout.W - FRAME - TB_W - 4.5 && y > layout.H - FRAME - block - 4.5) {
      return false;
    }
    for (const view of layout.views) {
      if (view === host) {
        continue;
      }
      const bounds = extent(view);
      if (x > bounds.x0 - 4.5 && x < bounds.x1 + 4.5 && y > bounds.y0 - 4.5 && y < bounds.y1 + 4.5) {
        return false;
      }
    }

    return taken.every(([tx, ty]) => Math.hypot(x - tx, y - ty) >= 8.5);
  };
  for (const [host, items] of byHost) {
    // The sides the overall dimensions are on.
    const first = options.angle === 'first';
    const avoid: ('top' | 'right' | 'bottom' | 'left')[] = !options.overall ? [] : host.id === 'front' ? ['left', first ? 'top' : 'bottom'] : host.id === layout.side ? [first ? 'top' : 'bottom'] : [];
    // Round the view, 9 mm out - those with no room there, further out.
    const spots: ReturnType<typeof balloonSpots> = [];
    let left = items;
    for (let ring = 0; left.length; ring++) {
      const margin = 9 + ring * 10;
      const rect = { x0: host.x - margin, y0: host.y - margin, x1: host.x + bw(host.box) * host.s + margin, y1: host.y + bh(host.box) * host.s + margin };
      const got = balloonSpots(rect, left, ring ? [] : avoid, freeFor(host));
      for (const b of got) {
        if (b.clear) {
          (spots.push(b), taken.push([b.x, b.y]));
        }
      }
      left = left.filter(it => !got.find(b => b.item === it.item && b.clear));
      if (ring === 4) {
        break;
      }
    }
    // No room round the view (a small sheet, many parts): the free place on the
    // sheet nearest each, or at last on the frame's edge.
    const hx1 = host.x + bw(host.box) * host.s;
    const hy1 = host.y + bh(host.box) * host.s;
    const open = freeFor(host);
    for (const it of left) {
      let best: [number, number] | null = null;
      let bd = Infinity;
      for (let x = FRAME_L + 5; x <= layout.W - FRAME - 5; x += 2) {
        for (let y = FRAME + 5; y <= layout.H - FRAME - 5; y += 2) {
          if (x > host.x - 4.5 && x < hx1 + 4.5 && y > host.y - 4.5 && y < hy1 + 4.5) {
            continue;
          }
          const distance = Math.hypot(x - it.at[0], y - it.at[1]);
          if (distance < bd && open(x, y)) {
            (best = [x, y]), (bd = distance);
          }
        }
      }
      const [x, y] = best ?? [Math.min(layout.W - FRAME - 4.5, Math.max(FRAME_L + 4.5, hx1 + 9)), Math.min(layout.H - FRAME - 4.5, Math.max(FRAME + 4.5, host.y))];
      spots.push({ item: it.item, at: it.at, x, y, clear: !!best });
      taken.push([x, y]);
    }
    for (const b of spots) {
      // Put somewhere by hand: there (its line still runs to its part).
      const part = parts.find(part => part.item === b.item)?.id ?? String(b.item);
      const id = `balloon:${part}`;
      const [bx, by] = options.balloonAt[part] ?? [b.x, b.y];
      const stroke = color(id);
      const dx = b.at[0] - bx;
      const dy = b.at[1] - by;
      const distance = Math.hypot(dx, dy) || 1;
      const svg
        = `<path d="M${round2(bx + (dx / distance) * 4)} ${round2(by + (dy / distance) * 4)}L${round2(b.at[0])} ${round2(b.at[1])}" stroke="${stroke}" stroke-width="${lw.dims}"/>`
        + `<circle cx="${round2(b.at[0])}" cy="${round2(b.at[1])}" r="0.6" fill="${stroke}"/>`
        + `<circle cx="${round2(bx)}" cy="${round2(by)}" r="4" stroke="${stroke}" stroke-width="0.35" fill="#fff"/>`
        + text(bx, by + 1.4, String(b.item), 4, { anchor: 'middle', fill: stroke });
      out.push(data.interactive ? `<g data-ann="${esc(String(id))}">${svg}</g>` : svg);
      balloonsAt.push({ id, x: bx, y: by });
    }
  }

  if (!layout.fits) {
    out.push('</g>');
  }

  // ---- Title block (ISO 7200), and the parts list above it.
  if (options.titleBlock === 'simple' || options.titleBlock === 'table' || options.titleBlock === 'block') {
    out.push(titleBlock(options, doc.info ?? {}, data.date, layout, options.titleBlock === 'table' ? parts : []));
  } else if (options.titleBlock === 'horizontal') {
    out.push(stripBlock(options, doc.info ?? {}, data.date, layout));
  } else if (options.titleBlock === 'vertical') {
    out.push(columnBlock(options, doc.info ?? {}, data.date, layout));
  }
  out.push('</svg>');

  return { svg: out.join('\n'), layout: layout, balloons: balloonsAt };
}

/** Dimension lines (ISO 129-1): the first this far out from the view (mm on the paper), each next one this much further. */
export const DIM_FIRST = 10;
export const DIM_STEP = 7;

/**
 * The dimensions laid out the way a technical drawing has them (ISO 129-1):
 * - outside the view, on the side nearest what they measure (above or below,
 *   left or right);
 * - in rows 10 mm out, then 7 mm apart; the shorter nearer the view, the
 *   longer further out, so no extension line crosses a dimension line;
 *   dimensions that don't overlap share a row (a chain);
 * - the value in the middle, or just past the end when it doesn't fit between
 *   the arrows; no two values on top of each other;
 * - a radius's or diameter's leader pointing away from the middle of its view,
 *   out past the view, no two the same way.
 * Slanted ones stand 10 mm off; angles stay as they are. The same order back.
 */
export function arrangeDims(dims: DrawingDim[], layout: Pick<Layout, 'views'>, options: Opts): DrawingDim[] {
  const out = new Map<string, DrawingDim>();
  /** Its line from lo to hi (along the row), its value from tlo to thi. */
  type Row = { d: DrawingDim; A: [number, number]; n: [number, number]; horiz: boolean; lo: number; hi: number; tlo: number; thi: number; len: number; slide: number };
  const rows = new Map<string, { p: Placed; side: 'top' | 'bottom' | 'left' | 'right'; items: Row[] }>();
  const circles = new Map<string, DrawingDim[]>();
  for (const dimension of dims) {
    const view = layout.views.find(placed => placed.id === dimension.view);
    if (!view) {
      continue;
    }
    const bounds = extent(view);
    const mid: [number, number] = [(bounds.x0 + bounds.x1) / 2, (bounds.y0 + bounds.y1) / 2];
    if ((dimension.kind === 'length' || dimension.kind === 'distance') && dimension.b) {
      const paperPointA = toPaper(view, dimension.a);
      const paperPointB = toPaper(view, dimension.b);
      const len = Math.hypot(paperPointB[0] - paperPointA[0], paperPointB[1] - paperPointA[1]);
      if (len < 1e-6) {
        continue;
      }
      const along: [number, number] = [(paperPointB[0] - paperPointA[0]) / len, (paperPointB[1] - paperPointA[1]) / len];
      const normal: [number, number] = [along[1], -along[0]];
      const horiz = Math.abs(along[1]) < 1e-3;
      const vert = Math.abs(along[0]) < 1e-3;
      if (!horiz && !vert) {
        out.set(dimension.id, { ...dimension, offset: (Math.sign(dimension.offset) || 1) * DIM_FIRST, slide: undefined });
        continue;
      }
      const tw = labelWidth(labelOf(dimLabel(dimension, Math.hypot(dimension.b[0] - dimension.a[0], dimension.b[1] - dimension.a[1]), options)), 3.5);
      // Too short for its value between the arrows: the value just past b's end.
      const slide = len < tw + 8 ? len / 2 + tw / 2 + 4 : 0;
      const axis = horiz ? 0 : 1;
      const across = horiz ? (paperPointA[1] + paperPointB[1]) / 2 : (paperPointA[0] + paperPointB[0]) / 2;
      const side = horiz ? (across < mid[1] ? 'top' : 'bottom') : across < mid[0] ? 'left' : 'right';
      const tc = (paperPointA[axis] + paperPointB[axis]) / 2 + along[axis] * slide;
      const key = `${dimension.view}|${side}`;
      if (!rows.has(key)) {
        rows.set(key, { p: view, side, items: [] });
      }
      rows.get(key)!.items.push({ d: dimension, A: paperPointA, n: normal, horiz, lo: Math.min(paperPointA[axis], paperPointB[axis]), hi: Math.max(paperPointA[axis], paperPointB[axis]), tlo: tc - tw / 2 - 1.5, thi: tc + tw / 2 + 1.5, len, slide });
    } else if ((dimension.kind === 'radius' || dimension.kind === 'diameter') && dimension.c && dimension.r !== undefined) {
      if (!circles.has(dimension.view)) {
        circles.set(dimension.view, []);
      }
      circles.get(dimension.view)!.push(dimension);
    }
  }
  for (const { p, side, items } of rows.values()) {
    const bounds = extent(p);
    const lanes: Row[][] = [];
    // Two in one row: their lines may meet end to end (a chain), not overlap; their values clear of each other (a value past an end: of the other's line too).
    const meet = (a0: number, a1: number, b0: number, b1: number, gap: number) => a0 < b1 - gap && b0 < a1 - gap;
    const clash = (a: Row, b: Row) => meet(a.lo, a.hi, b.lo, b.hi, 0.5) || meet(a.tlo, a.thi, b.tlo, b.thi, 0) || (!!a.slide && meet(a.tlo, a.thi, b.lo, b.hi, 0)) || (!!b.slide && meet(b.tlo, b.thi, a.lo, a.hi, 0));
    items.sort((a, b) => a.len - b.len || a.lo - b.lo);
    for (const it of items) {
      let shift = 0;
      while (lanes[shift]?.some(row => clash(row, it))) {
        shift++;
      }
      (lanes[shift] ??= []).push(it);
      const out1 = DIM_FIRST + DIM_STEP * shift;
      const line = side === 'top' ? bounds.y0 - out1 : side === 'bottom' ? bounds.y1 + out1 : side === 'left' ? bounds.x0 - out1 : bounds.x1 + out1;
      const offset = it.horiz ? (line - it.A[1]) * it.n[1] : (line - it.A[0]) * it.n[0];
      out.set(it.d.id, { ...it.d, offset, slide: it.slide || undefined });
    }
  }
  for (const [view, list] of circles) {
    const placed = layout.views.find(candidate => candidate.id === view)!;
    const bounds = extent(placed);
    const mid: [number, number] = [(bounds.x0 + bounds.x1) / 2, (bounds.y0 + bounds.y1) / 2];
    const taken: number[] = [];
    const apart = (a: number, b: number) => Math.abs(((a - b + 3 * Math.PI) % (2 * Math.PI)) - Math.PI);
    for (const drawingDimension of list) {
      const paperPointC = toPaper(placed, drawingDimension.c!);
      const radius = drawingDimension.r! * placed.s;
      const away = Math.hypot(paperPointC[0] - mid[0], paperPointC[1] - mid[1]) > 1 ? Math.atan2(paperPointC[1] - mid[1], paperPointC[0] - mid[0]) : -Math.PI / 4;
      let a = away;
      for (let i = 1; i < 12 && taken.some(t => apart(t, a) < 0.4); i++) {
        a = away + (i % 2 ? 1 : -1) * Math.ceil(i / 2) * 0.45;
      }
      taken.push(a);
      // Out past the view along the leader: where it leaves the view's box.
      const dx = Math.cos(a);
      const dy = Math.sin(a);
      const ts = [dx > 1e-9 ? (bounds.x1 - paperPointC[0]) / dx : dx < -1e-9 ? (bounds.x0 - paperPointC[0]) / dx : Infinity, dy > 1e-9 ? (bounds.y1 - paperPointC[1]) / dy : dy < -1e-9 ? (bounds.y0 - paperPointC[1]) / dy : Infinity];
      const exit = Math.max(0, Math.min(...ts));
      out.set(drawingDimension.id, { ...drawingDimension, angle: a, offset: Math.max(4, exit - radius + 5) });
    }
  }

  return dims.map(dimension => out.get(dimension.id) ?? dimension);
}

/** The views a drawing's sheet shows (to be drawn by the kernel): the standard ones switched on, then those added. */
export function sheetViewSpecs(options: Opts): ViewSpec[] {
  const side = options.angle === 'first' ? 'left' : 'right';
  const base = VIEW_SPECS.filter(viewSpec => (viewSpec.id === 'front' || viewSpec.id === 'top' || viewSpec.id === 'iso' ? options.views[viewSpec.id] : options.views.side && viewSpec.id === side));

  return [...base, ...extraSpecs(options)];
}

/** What a drawing for other bodies takes from one before it: the sheet and how it's drawn, not what's on it. */
export function sheetSettings(drawingOptions: DrawingOptions): DrawingOptions {
  const keep: (keyof DrawingOptions)[] = ['size', 'portrait', 'angle', 'hidden', 'views', 'titleBlock', 'dateFormat', 'units', 'precision', 'anglePrecision', 'comma', 'lines', 'balloons', 'overall'];
  const out: DrawingOptions = {};
  for (const key of keep) {
    if (drawingOptions[key] !== undefined) {
      (out as Record<string, unknown>)[key] = structuredClone(drawingOptions[key]);
    }
  }

  return out;
}

/** The project's drawings, each with its id (a project saved with one drawing: that one). */
export function drawingsOf(doc: ProjectDoc): (DrawingOptions & { id: string })[] {
  const list = doc.drawings ?? (doc.drawing ? [doc.drawing] : []);

  return list.map((drawingOptions, i) => ({ ...drawingOptions, id: drawingOptions.id ?? `drawing-${i + 1}` }));
}

/** A drawing put into the project (added if new), or taken out (null); the project then keeps them as a list. */
export function putDrawing(doc: ProjectDoc, id: string, next: DrawingOptions | null): void {
  const list = drawingsOf(doc);
  const i = list.findIndex(drawing => drawing.id === id);
  if (!next) {
    if (i >= 0) {
      list.splice(i, 1);
    }
  } else if (i >= 0) {
    list[i] = { ...next, id };
  } else {
    list.push({ ...next, id });
  }
  doc.drawings = list;
  delete doc.drawing;
}

/** Is this one of the overall sizes (made by the drawing, not put on by hand)? */
export const isOverall = (id: string) => id.startsWith('overall-');

/**
 * The overall sizes as dimensions: width and height on the front view, depth
 * on the side view, along the view's box (so they follow the model), with
 * what was changed on them by hand; none taken off.
 */
export function overallDims(options: Opts, layout: Pick<Layout, 'views' | 'side'>): DrawingDim[] {
  if (!options.overall) {
    return [];
  }
  const first = options.angle === 'first';
  const out: DrawingDim[] = [];
  const add = (id: string, view: string, a: [number, number], b: [number, number], offset: number) => {
    const e = options.overallDims[id] ?? {};
    if (e.hidden) {
      return;
    }
    const { hidden: _h, ...edit } = e;
    out.push({ id, view, kind: 'length', a, b, offset, ...edit });
  };
  const front = layout.views.find(view => view.id === 'front');
  const side = layout.views.find(view => view.id === layout.side);
  if (front) {
    const [[x0, y0], [x1, y1]] = front.box;
    add('overall-width', 'front', [x0, first ? y0 : y1], [x1, first ? y0 : y1], first ? 9 : -9);
    add('overall-height', 'front', [x0, y1], [x0, y0], 9);
  }
  if (side) {
    const [[x0, y0], [x1, y1]] = side.box;
    add('overall-depth', side.id, [x0, first ? y0 : y1], [x1, first ? y0 : y1], first ? 9 : -9);
  }

  return out;
}

/** One dimension put on by hand, on its view. */
export function dimSVG(drawingDimension: DrawingDim, placed: Placed, options: Opts, color = '#000'): string {
  if ((drawingDimension.kind === 'length' || drawingDimension.kind === 'distance') && drawingDimension.b) {
    const paperPointA = toPaper(placed, drawingDimension.a);
    const paperPointB = toPaper(placed, drawingDimension.b);

    return linearDim(paperPointA, paperPointB, drawingDimension.offset, dimLabel(drawingDimension, Math.hypot(drawingDimension.b[0] - drawingDimension.a[0], drawingDimension.b[1] - drawingDimension.a[1]), options), options.lines.dims, color, drawingDimension.slide ?? 0);
  }
  if ((drawingDimension.kind === 'radius' || drawingDimension.kind === 'diameter') && drawingDimension.c && drawingDimension.r !== undefined) {
    const dia = drawingDimension.kind === 'diameter';
    const label = dimLabel(drawingDimension, dia ? 2 * drawingDimension.r : drawingDimension.r, options, dia ? 'Ø' : 'R');

    return circleDim(toPaper(placed, drawingDimension.c), drawingDimension.r * placed.s, drawingDimension.angle ?? -Math.PI / 4, drawingDimension.offset, label, dia, options.lines.dims, color);
  }
  if (drawingDimension.kind === 'angle' && drawingDimension.c && drawingDimension.b) {
    const paperPointC = toPaper(placed, drawingDimension.c);
    const paperPointA = toPaper(placed, drawingDimension.a);
    const paperPointB = toPaper(placed, drawingDimension.b);
    const t = arcSweep(drawingDimension.c, drawingDimension.a, drawingDimension.b, drawingDimension.through);

    return angleDim(paperPointC, paperPointA, paperPointB, drawingDimension.offset, dimLabel(drawingDimension, t, options), options.lines.dims, color, t);
  }

  return '';
}

/**
 * The angle at c from a to b the way an arc goes from a through `through` to b
 * (past 180° when it is the long way round); without `through`, the smaller
 * way. Signed: positive turning clockwise on the paper.
 */
export function arcSweep(center: [number, number], a: [number, number], b: [number, number], through?: [number, number]): number {
  const t = angleBetween(center, a, b);
  if (!through) {
    return t;
  }
  const angle = angleBetween(center, a, through);
  // `through` lies on the short way when it turns the same way, and less far.
  const onShort = Math.sign(angle) === Math.sign(t) && Math.abs(angle) <= Math.abs(t);
  if (onShort) {
    return t;
  }

  return t > 0 ? t - 2 * Math.PI : t + 2 * Math.PI;
}

/** Something a min-max distance is measured between, in its view's mm: a point, a straight edge, a circle or an arc (from a through m to b). */
export type Ent =
  | { kind: 'point'; p: [number, number] }
  | { kind: 'line'; a: [number, number]; b: [number, number] }
  | { kind: 'circle'; c: [number, number]; r: number; a: [number, number]; m: [number, number]; b: [number, number] };

/** A point along an entity, t from 0 to 1. */
function entAt(e: Ent): (t: number) => [number, number] {
  if (e.kind === 'point') {
    return () => e.p;
  }
  if (e.kind === 'line') {
    return t => [e.a[0] + (e.b[0] - e.a[0]) * t, e.a[1] + (e.b[1] - e.a[1]) * t];
  }
  const a0 = Math.atan2(e.a[1] - e.c[1], e.a[0] - e.c[0]);
  const whole = Math.hypot(e.a[0] - e.b[0], e.a[1] - e.b[1]) < 1e-9 * Math.max(1, e.r);
  const sw = whole ? 2 * Math.PI : arcSweep(e.c, e.a, e.b, e.m);

  return t => [e.c[0] + e.r * Math.cos(a0 + sw * t), e.c[1] + e.r * Math.sin(a0 + sw * t)];
}

/**
 * The nearest and the farthest two points of two entities (a point, an edge,
 * a circle or an arc): searched over both on a grid, then closed in on to far
 * below a thousandth of a millimetre.
 */
export function minMax(e1: Ent, e2: Ent): { min: [[number, number], [number, number]]; max: [[number, number], [number, number]] } {
  const f1 = entAt(e1);
  const f2 = entAt(e2);
  const n1 = e1.kind === 'point' ? 0 : 120;
  const n2 = e2.kind === 'point' ? 0 : 120;
  const dist = (paramA: number, t: number) => {
    const point = f1(paramA);
    const q = f2(t);

    return Math.hypot(point[0] - q[0], point[1] - q[1]);
  };
  const solve = (sign: 1 | -1): [[number, number], [number, number]] => {
    // Every grid cell's best, then each of the few best closed in on (a min or max may sit anywhere along a straight pair).
    const cand: [number, number, number][] = [];
    for (let i = 0; i <= n1; i++) {
      for (let j = 0; j <= n2; j++) {
        cand.push([n1 ? i / n1 : 0, n2 ? j / n2 : 0, sign * dist(n1 ? i / n1 : 0, n2 ? j / n2 : 0)]);
      }
    }
    cand.sort((first, second) => first[2] - second[2]);
    let best = cand[0];
    for (const c0 of cand.slice(0, 6)) {
      let [paramA, t, value] = c0;
      for (let step = 1 / Math.max(n1, n2, 1); step > 1e-13; step /= 2) {
        for (let moved = true; moved; ) {
          moved = false;
          for (const [ds, dt] of [[step, 0], [-step, 0], [0, step], [0, -step], [step, step], [-step, -step], [step, -step], [-step, step]]) {
            const s2 = n1 ? Math.min(1, Math.max(0, paramA + ds)) : 0;
            const t2 = n2 ? Math.min(1, Math.max(0, t + dt)) : 0;
            const v2 = sign * dist(s2, t2);
            if (v2 < value - 1e-15) {
              [paramA, t, value, moved] = [s2, t2, v2, true];
            }
          }
        }
      }
      if (value < best[2]) {
        best = [paramA, t, value];
      }
    }

    return [f1(best[0]), f2(best[1])];
  };

  return { min: solve(1), max: solve(-1) };
}

/** The angle at `center` from a to b (radians, the smaller way round, signed: positive turning clockwise on the paper). */
export function angleBetween(center: [number, number], a: [number, number], b: [number, number]): number {
  let t = Math.atan2(b[1] - center[1], b[0] - center[0]) - Math.atan2(a[1] - center[1], a[0] - center[0]);
  while (t > Math.PI) {
    t -= 2 * Math.PI;
  }
  while (t <= -Math.PI) {
    t += 2 * Math.PI;
  }

  return t;
}

/** A dimension's text: its value (a length in mm, or an angle), what goes before and after it, its tolerance. */
export function dimLabel(drawingDimension: DrawingDim, value: number, options: Opts, sign = ''): DimLabel {
  const angle = drawingDimension.kind === 'angle';
  const fmt = (value: number) => (angle ? angleText(value, options) : lengthText(value, options));
  // Tolerances to a thousandth whatever the drawing's precision (no trailing zeros).
  const fine = (value: number) => (angle ? angleText(value, { ...options, anglePrecision: Math.max(options.anglePrecision, 2) }) : lengthText(value, { ...options, precision: Math.max(options.precision, 3) }));
  const pre = `${drawingDimension.prefix ?? ''}${sign}`;
  const post = drawingDimension.suffix ?? '';
  const t = drawingDimension.tol;
  const up = t?.up ?? 0;
  const down = t?.down ?? up;
  if (t?.kind === 'sym') {
    return { main: `${pre}${fmt(value)} ±${fine(up)}${post}` };
  }
  if (t?.kind === 'dev') {
    return { main: `${pre}${fmt(value)}`, up: `+${fine(up)}`, down: `-${fine(down)}`, tail: post };
  }
  if (t?.kind === 'limits') {
    return { main: pre, up: fmt(value + up), down: fmt(value - down), tail: post };
  }
  if (t?.kind === 'basic') {
    return { main: `${pre}${fmt(value)}${post}`, boxed: true };
  }

  return { main: `${pre}${fmt(value)}${post}` };
}

/** A section's cut line on its view: `pointA` and `pointB` on the paper, `look` the way its arrows point. */
function cutLine(pointA: [number, number], pointB: [number, number], look: [number, number], letter: string, lw: Opts['lines'], color: string): string {
  const length = Math.hypot(pointB[0] - pointA[0], pointB[1] - pointA[1]) || 1;
  const along = [(pointB[0] - pointA[0]) / length, (pointB[1] - pointA[1]) / length];
  const a = [pointA[0] - along[0] * 3, pointA[1] - along[1] * 3];
  const b = [pointB[0] + along[0] * 3, pointB[1] + along[1] * 3];
  const thin = `stroke="${color}" stroke-width="${lw.center}" fill="none"`;
  let out = `<path d="M${round2(a[0])} ${round2(a[1])}L${round2(b[0])} ${round2(b[1])}" ${thin} stroke-dasharray="8 1.5 1.5 1.5"/>`;
  out += `<path d="M${round2(a[0])} ${round2(a[1])}l${round2(along[0] * 6)} ${round2(along[1] * 6)}M${round2(b[0])} ${round2(b[1])}l${round2(-along[0] * 6)} ${round2(-along[1] * 6)}" stroke="${color}" stroke-width="${lw.visible}" fill="none"/>`;
  for (const e of [a, b]) {
    const tip: [number, number] = [e[0] + look[0] * 8, e[1] + look[1] * 8];
    out += `<path d="M${round2(e[0])} ${round2(e[1])}L${round2(tip[0])} ${round2(tip[1])}" stroke="${color}" stroke-width="${lw.dims}"/>`;
    out += arrow(tip[0], tip[1], look[0], look[1], color);
    out += text(tip[0] + look[0] * 3.5, tip[1] + look[1] * 3.5 + 1.8, letter, 5, { anchor: 'middle', fill: color });
  }

  return out;
}

/** A centre mark (a cross a little past its circle) or a centreline (a little past its ends): thin chain lines. */
export function markSVG(drawingMark: DrawingMark, placed: Placed, width: number, color = '#000'): string {
  const line = (a: [number, number], b: [number, number]) => `M${round2(a[0])} ${round2(a[1])}L${round2(b[0])} ${round2(b[1])}`;
  const style = `stroke="${color}" stroke-width="${width}" fill="none"`;
  if (drawingMark.kind === 'center' && drawingMark.c && drawingMark.r !== undefined) {
    const paperPointC = toPaper(placed, drawingMark.c);
    const e = drawingMark.r * placed.s + 2.5;
    // Each arm from the middle out: the dashes cross at the centre.
    const arms = [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1]
    ].map(([x, y]) => line(paperPointC, [paperPointC[0] + x * e, paperPointC[1] + y * e]));

    return `<path d="${arms.join('')}" ${style}${drawingMark.r * placed.s > 4 ? ' stroke-dasharray="1.5 1 6 1"' : ''}/>`;
  }
  if (drawingMark.kind === 'cross' && drawingMark.c && drawingMark.a && drawingMark.b) {
    // Each edge drawn on, thin, to where they meet and a little past it.
    const paperPointC = toPaper(placed, drawingMark.c);
    let pathData = '';
    for (const end of [drawingMark.a, drawingMark.b]) {
      const paperPoint = toPaper(placed, end);
      const length = Math.hypot(paperPointC[0] - paperPoint[0], paperPointC[1] - paperPoint[1]);
      if (length < 1e-6) {
        continue;
      }
      const along = [(paperPointC[0] - paperPoint[0]) / length, (paperPointC[1] - paperPoint[1]) / length];
      pathData += line(paperPoint, [paperPointC[0] + along[0] * 2, paperPointC[1] + along[1] * 2]);
    }

    return `<path d="${pathData}" ${style}/>`;
  }
  if (drawingMark.kind === 'line' && drawingMark.a && drawingMark.b) {
    const paperPointA = toPaper(placed, drawingMark.a);
    const paperPointB = toPaper(placed, drawingMark.b);
    const length = Math.hypot(paperPointB[0] - paperPointA[0], paperPointB[1] - paperPointA[1]) || 1;
    const along = [(paperPointB[0] - paperPointA[0]) / length, (paperPointB[1] - paperPointA[1]) / length];
    const midpoint: [number, number] = [(paperPointA[0] + paperPointB[0]) / 2, (paperPointA[1] + paperPointB[1]) / 2];
    // From the middle out both ways: it looks the same at either end.
    const half = length / 2 + 2.5;

    return `<path d="${line(midpoint, [midpoint[0] + along[0] * half, midpoint[1] + along[1] * half])}${line(midpoint, [midpoint[0] - along[0] * half, midpoint[1] - along[1] * half])}" ${style} stroke-dasharray="1.5 1 6 1"/>`;
  }

  return '';
}

/** A note: its text; pointing at something, a leader from the near end of its text with an arrow there. */
export function noteSVG(drawingNote: DrawingNote, placed: Placed | undefined, width: number, color = '#000'): string {
  const size = drawingNote.size ?? 3.5;
  let out = text(drawingNote.x, drawingNote.y, drawingNote.text, size, { fill: color });
  if (drawingNote.to && placed) {
    const paperPoint = toPaper(placed, drawingNote.to.p);
    const noteWidth = textWidth(drawingNote.text, size);
    const toLeft = paperPoint[0] < drawingNote.x + noteWidth / 2;
    const elbow: [number, number] = [toLeft ? drawingNote.x - 1 : drawingNote.x + noteWidth + 1, drawingNote.y - size * 0.34];
    const shoulder: [number, number] = [elbow[0] + (toLeft ? -2.5 : 2.5), elbow[1]];
    const distance = Math.hypot(paperPoint[0] - shoulder[0], paperPoint[1] - shoulder[1]) || 1;
    out += `<path d="M${round2(elbow[0])} ${round2(elbow[1])}L${round2(shoulder[0])} ${round2(shoulder[1])}L${round2(paperPoint[0])} ${round2(paperPoint[1])}" stroke="${color}" stroke-width="${width}" fill="none"/>`;
    out += arrow(paperPoint[0], paperPoint[1], (paperPoint[0] - shoulder[0]) / distance, (paperPoint[1] - shoulder[1]) / distance, color);
  }

  return out;
}

function titleBlock(options: Opts, info: ProjectInfo, date: Date, layout: Layout, parts: PartRow[]): string {
  const out: string[] = [];
  const { W, H } = layout;
  const tbx = W - FRAME - TB_W;
  const tby = H - FRAME - TB_H;
  const line = 'stroke="#000" stroke-width="0.35" fill="none"';
  if (parts.length) {
    const cols: [string, number, string][] = [
      ['Item', 12, 'middle'],
      ['Qty', 10, 'middle'],
      ['Name', 60, 'start'],
      ['Material', 68, 'start'],
      ['Mass', 30, 'end']
    ];
    const rowCount = listRows(parts.length, H);
    const more = parts.length - (rowCount - 1);
    const shown: (PartRow | null)[] = rowCount < parts.length ? [...parts.slice(0, rowCount - 1), null] : parts;
    const rowsOf = [...shown].reverse();
    const top = tby - ROW * (rowCount + 1);
    out.push(`<rect x="${round2(tbx)}" y="${round2(top)}" width="${TB_W}" height="${ROW * (rowCount + 1)}" fill="#fff" stroke="#000" stroke-width="0.35"/>`);
    const cellText = (x: number, width: number, a: string, y: number, t: string, size: number, weight?: string) =>
      text(a === 'middle' ? x + width / 2 : a === 'end' ? x + width - 1.5 : x + 1.5, y + ROW - 1.8, fit(t, width - 3, size), size, { anchor: a, weight });
    rowsOf.forEach((partRow, i) => {
      const y = top + i * ROW;
      out.push(`<path d="M${round2(tbx)} ${round2(y + ROW)}L${round2(tbx + TB_W)} ${round2(y + ROW)}" stroke="#000" stroke-width="0.18"/>`);
      let x = tbx;
      if (!partRow) {
        return void out.push(text(tbx + 1.5, y + ROW - 1.8, `+ ${more} more parts: see the technical sheet`, 2.6));
      }
      const values = [String(partRow.item), '1', partRow.name, partRow.material || '-', partRow.mass === undefined ? '-' : fmtMass(partRow.mass)];
      cols.forEach(([, width, a], columnIndex) => {
        out.push(cellText(x, width, a, y, values[columnIndex], 2.6));
        x += width;
      });
    });
    const hy = tby - ROW;
    let x = tbx;
    for (const [label, width, a] of cols) {
      out.push(cellText(x, width, a, hy, label, 2.6, 'bold'));
      x += width;
      if (x < tbx + TB_W - 0.01) {
        out.push(`<path d="M${round2(x)} ${round2(top + (more > 0 && rowCount < parts.length ? ROW : 0))}L${round2(x)} ${round2(tby)}" stroke="#000" stroke-width="0.18"/>`);
      }
    }
    out.push(`<path d="M${round2(tbx)} ${round2(hy)}L${round2(tbx + TB_W)} ${round2(hy)}" ${line}/>`);
  }
  if (options.titleBlock === 'block') {
    out.push(revisionTable(options, tbx, tby - ROW * revRows(options), [['Rev.', 15], ['Description', 105], ['Date', 30], ['By', 30]], 2.6));
  }
  out.push(`<rect x="${round2(tbx)}" y="${round2(tby)}" width="${TB_W}" height="${TB_H}" fill="#fff" stroke="#000" stroke-width="0.7"/>`);
  const cell = (x: number, y: number, width: number, height: number, label: string, value: string, size = 3) => {
    out.push(`<rect x="${round2(tbx + x)}" y="${round2(tby + y)}" width="${width}" height="${height}" ${line}/>`);
    out.push(text(tbx + x + 1.2, tby + y + 2.6, label, 1.8, { fill: '#444' }));
    if (value) {
      out.push(text(tbx + x + 1.2, tby + y + height - 2, fit(value, width - 2.4, size), size));
    }
  };
  cell(0, 0, 60, 18, 'Owner', info.company ?? '');
  cell(60, 0, 120, 18, 'Title', options.title, 5);
  let x = 0;
  const row: [string, string, number, number?][] = [
    ['Created by', info.author ?? '', 30],
    ['Date of issue', dateText(date, options.dateFormat), 25, 2.6],
    ['Units', options.units, 12],
    ['Scale', scaleLabel(layout.scale), 18],
    ['Projection', '', 22],
    ['Size', options.size, 15, options.size.length > 3 ? 2.2 : 3],
    ['Drawing number', info.number ?? '', 33],
    ['Rev.', info.revision ?? '', 13],
    ['Sheet', '1/1', 12, 2.6]
  ];
  for (const [label, value, width, size] of row) {
    cell(x, 18, width, 18, label, value, size);
    if (label === 'Projection') {
      out.push(projectionSymbol(tbx + x + width / 2, tby + 28.5, options.angle, 0.35));
    }
    x += width;
  }

  return out.join('\n');
}

/** The revision table: a header and a row for each revision, from (x, y) down. */
function revisionTable(options: Opts, x: number, y: number, cols: [string, number][], size: number): string {
  const out: string[] = [];
  const width = cols.reduce((a, column) => a + column[1], 0);
  const rowCount = revRows(options);
  out.push(`<rect x="${round2(x)}" y="${round2(y)}" width="${round2(width)}" height="${ROW * rowCount}" fill="#fff" stroke="#000" stroke-width="0.35"/>`);
  const rows = [cols.map(column => column[0]), ...options.revisions.map(revision => [revision.rev, revision.note ?? '', revision.date ?? '', revision.by ?? ''])];
  rows.forEach((row, i) => {
    const ry = y + i * ROW;
    if (i) {
      out.push(`<path d="M${round2(x)} ${round2(ry)}H${round2(x + width)}" stroke="#000" stroke-width="${i === 1 ? 0.35 : 0.18}"/>`);
    }
    let cx = x;
    cols.forEach(([, cw], columnIndex) => {
      out.push(text(cx + 1.2, ry + ROW - 1.8, fit(row[columnIndex] ?? '', cw - 2.4, size), size, i ? {} : { weight: 'bold' }));
      cx += cw;
    });
  });
  if (rowCount > rows.length) {
    out.push(`<path d="M${round2(x)} ${round2(y + ROW)}H${round2(x + width)}" stroke="#000" stroke-width="0.35"/>`);
  }
  let cx = x;
  for (const [, cw] of cols.slice(0, -1)) {
    cx += cw;
    out.push(`<path d="M${round2(cx)} ${round2(y)}V${round2(y + ROW * rowCount)}" stroke="#000" stroke-width="0.18"/>`);
  }

  return out.join('\n');
}

/** A title block's fields: label and value. */
function blockFields(options: Opts, info: ProjectInfo, date: Date, layout: Layout): Record<string, [string, string]> {
  return {
    owner: ['Owner', info.company ?? ''],
    title: ['Title', options.title],
    by: ['Created by', info.author ?? ''],
    date: ['Date of issue', dateText(date, options.dateFormat)],
    units: ['Units', options.units],
    scale: ['Scale', scaleLabel(layout.scale)],
    projection: ['Projection', ''],
    size: ['Size', options.size],
    number: ['Drawing number', info.number ?? ''],
    rev: ['Rev.', info.revision ?? ''],
    sheet: ['Sheet', '1/1']
  };
}
type BlockRow = { h: number; cells: [string, number?][] };

/** Cells of a title block laid out in rows: each row's fields and widths (a field without one takes what's left). */
function blockCells(options: Opts, info: ProjectInfo, date: Date, layout: Layout, x0: number, y0: number, width: number, rows: BlockRow[], line: number): string {
  const out: string[] = [];
  const fields = blockFields(options, info, date, layout);
  let y = y0;
  for (const row of rows) {
    const fixed = row.cells.reduce((a, cell) => a + (cell[1] ?? 0), 0);
    const free = row.cells.filter(cell => cell[1] === undefined).length;
    // (Too wide for the sheet: all of them narrower.)
    const scale = fixed > width - 20 * free ? (width - 20 * free) / fixed : 1;
    let x = x0;
    for (const [key, cw] of row.cells) {
      const cwid = cw === undefined ? (width - fixed * scale) / Math.max(1, free) : cw * scale;
      const [label, value] = fields[key];
      out.push(`<rect x="${round2(x)}" y="${round2(y)}" width="${round2(cwid)}" height="${row.h}" stroke="#000" stroke-width="0.35" fill="none"/>`);
      out.push(text(x + 1.2, y + 2.6, label, 1.8, { fill: '#444' }));
      const size = key === 'title' ? Math.min(5, row.h * 0.33) : value.length > 8 ? 2.4 : 3;
      if (value) {
        out.push(text(x + 1.2, y + row.h - 2, fit(value, cwid - 2.4, size), size));
      }
      if (key === 'projection') {
        out.push(projectionSymbol(x + cwid / 2, y + row.h / 2 + 1.5, options.angle, 0.35));
      }
      x += cwid;
    }
    y += row.h;
  }
  out.push(`<rect x="${round2(x0)}" y="${round2(y0)}" width="${round2(width)}" height="${round2(y - y0)}" fill="none" stroke="#000" stroke-width="${line}"/>`);

  return out.join('\n');
}

/** Horizontal title block: a strip along the bottom of the frame (two rows on a narrow sheet). */
function stripBlock(options: Opts, info: ProjectInfo, date: Date, layout: Layout): string {
  const x0 = FRAME_L;
  const width = layout.W - FRAME - FRAME_L;
  const two = stripRows(layout.W) === 2;
  const rest: [string, number?][] = [['by', 30], ['date', 25], ['units', 12], ['scale', 18], ['projection', 22], ['size', 15], ['number', 33], ['rev', 13], ['sheet', 12]];
  const rows: BlockRow[] = two
    ? [
      { h: HB_ROW, cells: [['owner', 50], ['title']] },
      { h: HB_ROW, cells: rest }
    ]
    : [{ h: HB_ROW, cells: [['owner', 45], ['title'], ...rest] }];
  const y0 = layout.H - FRAME - HB_ROW * rows.length;

  return `<rect x="${round2(x0)}" y="${round2(y0)}" width="${round2(width)}" height="${HB_ROW * rows.length}" fill="#fff"/>` + blockCells(options, info, date, layout, x0, y0, width, rows, 0.7);
}

/** Vertical title block: a column down the right of the frame, the revision table at its top. */
function columnBlock(options: Opts, info: ProjectInfo, date: Date, layout: Layout): string {
  const x0 = layout.W - FRAME - VB_W;
  const bottom = layout.H - FRAME;
  const rows: BlockRow[] = [
    { h: 12, cells: [['owner']] },
    { h: 16, cells: [['title']] },
    { h: 10, cells: [['by']] },
    { h: 10, cells: [['date', 30], ['units', 15], ['size']] },
    { h: 12, cells: [['scale', 26], ['projection']] },
    { h: 12, cells: [['number', 34], ['rev', 13], ['sheet']] }
  ];
  const height = rows.reduce((a, row) => a + row.h, 0);

  return (
    `<rect x="${round2(x0)}" y="${FRAME}" width="${VB_W}" height="${round2(bottom - FRAME)}" fill="#fff" stroke="#000" stroke-width="0.7"/>`
    + revisionTable(options, x0, FRAME, [['Rev.', 9], ['Description', 25], ['Date', 15], ['By', 11]], 2.2)
    + blockCells(options, info, date, layout, x0, bottom - height, VB_W, rows, 0.7)
  );
}

/** Text cut to fit a width (a rough width per letter for a sans-serif). */
function fit(t: string, width: number, size: number): string {
  const max = Math.max(1, Math.floor(width / (size * 0.55)));

  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

/**
 * Balloons around a view: each on the rectangle around it, where a line from
 * the view's middle through the part it names meets it, spread at least 10 mm
 * apart - on the sides left free (a side with the overall dimensions on it is
 * left to them).
 */
export function balloonSpots(
  rect: { x0: number; y0: number; x1: number; y1: number },
  items: { item: number; at: [number, number] }[],
  avoid: ('top' | 'right' | 'bottom' | 'left')[] = [],
  free: (x: number, y: number) => boolean = () => true
): { item: number; at: [number, number]; x: number; y: number; clear: boolean }[] {
  const { x0, y0, x1, y1 } = rect;
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  // The free sides, clockwise from the top left corner, one after another.
  const all = [
    { side: 'top', a: [x0, y0], b: [x1, y0] },
    { side: 'right', a: [x1, y0], b: [x1, y1] },
    { side: 'bottom', a: [x1, y1], b: [x0, y1] },
    { side: 'left', a: [x0, y1], b: [x0, y0] }
  ] as const;
  const open = all.filter(side => !avoid.includes(side.side));
  const sides = open.length ? open : all;
  const lens = sides.map(side => Math.hypot(side.b[0] - side.a[0], side.b[1] - side.a[1]));
  const per = lens.reduce((a, b) => a + b, 0);
  const round = sides.length === 4;
  const pointAt = (t: number): [number, number] => {
    t = round ? ((t % per) + per) % per : Math.max(0, Math.min(per, t));
    for (let i = 0; i < sides.length; i++) {
      if (t <= lens[i] || i === sides.length - 1) {
        const fraction = lens[i] ? Math.min(1, t / lens[i]) : 0;
        const { a, b } = sides[i];

        return [a[0] + (b[0] - a[0]) * fraction, a[1] + (b[1] - a[1]) * fraction];
      }
      t -= lens[i];
    }

    return [x0, y0];
  };
  const spots = items.map((it) => {
    let dx = it.at[0] - cx;
    let dy = it.at[1] - cy;
    if (Math.hypot(dx, dy) < 1e-6) {
      (dx = 1), (dy = -1);
    }
    const scale = Math.min(dx ? Math.abs((x1 - x0) / 2 / dx) : Infinity, dy ? Math.abs((y1 - y0) / 2 / dy) : Infinity);
    const point = [Math.min(x1, Math.max(x0, cx + dx * scale)), Math.min(y1, Math.max(y0, cy + dy * scale))];
    // The nearest place on a free side.
    let best = { t: 0, d: Infinity };
    let off = 0;
    sides.forEach((side, i) => {
      const ab = [side.b[0] - side.a[0], side.b[1] - side.a[1]];
      const fraction = lens[i] ? Math.max(0, Math.min(1, ((point[0] - side.a[0]) * ab[0] + (point[1] - side.a[1]) * ab[1]) / (lens[i] * lens[i]))) : 0;
      const distance = Math.hypot(side.a[0] + ab[0] * fraction - point[0], side.a[1] + ab[1] * fraction - point[1]);
      if (distance < best.d) {
        best = { t: off + fraction * lens[i], d: distance };
      }
      off += lens[i];
    });

    return { ...it, t: best.t };
  });
  spots.sort((a, b) => a.t - b.t);
  // Spread: each at least 10 mm along from the one before (a few passes both ways).
  const gap = Math.min(10, per / Math.max(1, spots.length));
  for (let pass = 0; pass < 4; pass++) {
    for (let i = 1; i < spots.length; i++) {
      if (spots[i].t - spots[i - 1].t < gap) {
        spots[i].t = spots[i - 1].t + gap;
      }
    }
    if (!round && spots.length && spots[spots.length - 1].t > per) {
      spots[spots.length - 1].t = per;
    }
    for (let i = spots.length - 2; i >= 0; i--) {
      if (spots[i + 1].t - spots[i].t < gap) {
        spots[i].t = spots[i + 1].t - gap;
      }
    }
    if (!round && spots.length && spots[0].t < 0) {
      spots[0].t = 0;
    }
  }
  // Each where nothing else is (another view, another balloon, the title
  // block): moved along until it is, the nearest way.
  const put: [number, number][] = [];
  const clear = (x: number, y: number) => free(x, y) && put.every(([px, py]) => Math.hypot(x - px, y - py) >= 8.5);

  return spots.map((spot) => {
    let [x, y] = pointAt(spot.t);
    let ok = clear(x, y);
    if (!ok) {
      for (let step = 1; step <= per; step += 1) {
        const tries = [spot.t + step, spot.t - step].filter(t => round || (t >= 0 && t <= per));
        const at = tries.map(pointAt).find(([a, b]) => clear(a, b));
        if (at) {
          [x, y] = at;
          ok = true;
          break;
        }
        if (!tries.length) {
          break;
        }
      }
    }
    if (ok) {
      put.push([x, y]);
    }

    return { item: spot.item, at: spot.at, x, y, clear: ok };
  });
}

// ---- Picking on the sheet (for the dimension tools)

export interface EdgeHit {
  view: string;
  kind: 'line' | 'circle';
  a: [number, number];
  b: [number, number];
  c?: [number, number];
  r?: number;
  /** A circle or arc: a point on it between a and b. */
  m?: [number, number];
  /** How far from the pointer, mm on the paper. */
  d: number;
}

/** The seen edge nearest a point on the paper (within `tol` mm), over every view but the isometric one. */
export function edgeAt(views: Map<string, ProjectedView>, layout: Layout, q: [number, number], tol: number, want?: 'line' | 'circle'): EdgeHit | null {
  let best: EdgeHit | null = null;
  for (const view of layout.views) {
    if (view.iso || (view.clip && Math.hypot(q[0] - view.clip.c[0], q[1] - view.clip.c[1]) > view.clip.r)) {
      continue;
    }
    const projectedView = views.get(view.src ?? view.id);
    if (!projectedView) {
      continue;
    }
    for (const b of projectedView.bodies) {
      for (const e of b.edges) {
        if ('c' in e) {
          if (want === 'line') {
            continue;
          }
          const paperPoint = toPaper(view, e.c);
          const radius = e.r * view.s;
          const dc = Math.hypot(q[0] - paperPoint[0], q[1] - paperPoint[1]);
          const distance = Math.abs(dc - radius);
          if (distance <= tol && (!best || distance < best.d) && onArc(e, fromPaper(view, q))) {
            best = { view: view.id, kind: 'circle', a: e.a, b: e.b, c: e.c, r: e.r, m: e.m, d: distance };
          }
        } else {
          if (want === 'circle') {
            continue;
          }
          const paperPointA = toPaper(view, e.a);
          const paperPointB = toPaper(view, e.b);
          const distance = segDist(q, paperPointA, paperPointB);
          if (distance <= tol && (!best || distance < best.d)) {
            best = { view: view.id, kind: 'line', a: e.a, b: e.b, d: distance };
          }
        }
      }
    }
  }

  return best;
}

/** The end of an edge (a corner), the middle of a straight one or a circle's centre nearest a point on the paper, within `tol` mm. */
export function pointAt(views: Map<string, ProjectedView>, layout: Layout, q: [number, number], tol: number, view?: string): { view: string; p: [number, number] } | null {
  let best: { view: string; p: [number, number]; d: number } | null = null;
  for (const pl of layout.views) {
    if (pl.iso || (view && pl.id !== view)) {
      continue;
    }
    if (pl.clip && Math.hypot(q[0] - pl.clip.c[0], q[1] - pl.clip.c[1]) > pl.clip.r) {
      continue;
    }
    const projectedView = views.get(pl.src ?? pl.id);
    if (!projectedView) {
      continue;
    }
    const consider = (pt: [number, number]) => {
      const paperPoint = toPaper(pl, pt);
      const distance = Math.hypot(paperPoint[0] - q[0], paperPoint[1] - q[1]);
      if (distance <= tol && (!best || distance < best.d)) {
        best = { view: pl.id, p: pt, d: distance };
      }
    };
    for (const b of projectedView.bodies) {
      for (const e of b.edges) {
        consider(e.a);
        consider(e.b);
        if ('c' in e) {
          consider(e.c);
        } else {
          consider([(e.a[0] + e.b[0]) / 2, (e.a[1] + e.b[1]) / 2]);
        }
      }
    }
  }

  return best ? { view: (best as { view: string }).view, p: (best as { p: [number, number] }).p } : null;
}

function segDist(q: [number, number], pointA: [number, number], pointB: [number, number]): number {
  const ab = [pointB[0] - pointA[0], pointB[1] - pointA[1]];
  const lengthSquared = ab[0] * ab[0] + ab[1] * ab[1];
  const t = lengthSquared ? Math.max(0, Math.min(1, ((q[0] - pointA[0]) * ab[0] + (q[1] - pointA[1]) * ab[1]) / lengthSquared)) : 0;

  return Math.hypot(q[0] - (pointA[0] + t * ab[0]), q[1] - (pointA[1] + t * ab[1]));
}

/** Is point q (view mm) at an angle the arc a→m→b covers? A whole circle covers all. */
function onArc(e: { a: [number, number]; m: [number, number]; b: [number, number]; c: [number, number] }, q: [number, number]): boolean {
  if (e.a[0] === e.b[0] && e.a[1] === e.b[1]) {
    return true;
  }
  const ang = (point: [number, number]) => Math.atan2(point[1] - e.c[1], point[0] - e.c[0]);
  const norm = (t: number) => ((t % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  const a = ang(e.a);
  const span = norm(ang(e.b) - a);
  const mid = norm(ang(e.m) - a);
  const t = norm(ang(q) - a);

  // The arc goes the way its middle point lies.
  return mid <= span ? t <= span + 0.05 : t >= span - 0.05;
}

/** A new id for a dimension or a note. */
export const annId = (kind: string) => `${kind}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

/** Where a new length dimension goes: off its edge, away from the middle of its view. */
/**
 * A straight dimension's offset, snapped (within `snap` mm on the paper) so its
 * line is in line with a parallel one of the same view, or the standard step
 * (DIM_STEP) out or in from it: dimensions stacked evenly.
 */
export function spacedOffset(drawingDimension: DrawingDim, others: DrawingDim[], placed: Placed, snap = 1.5): number {
  if (!drawingDimension.b || drawingDimension.kind === 'angle' || drawingDimension.r !== undefined) {
    return drawingDimension.offset;
  }
  const frame = (x: DrawingDim) => {
    const paperPointA = toPaper(placed, x.a);
    const paperPointB = toPaper(placed, x.b!);
    const length = Math.hypot(paperPointB[0] - paperPointA[0], paperPointB[1] - paperPointA[1]) || 1;
    const along: [number, number] = [(paperPointB[0] - paperPointA[0]) / length, (paperPointB[1] - paperPointA[1]) / length];

    return { A: paperPointA, u: along, n: [along[1], -along[0]] as [number, number] };
  };
  const me = frame(drawingDimension);
  const base = me.A[0] * me.n[0] + me.A[1] * me.n[1];
  const at = base + drawingDimension.offset;
  let best: number | null = null;
  for (const x of others) {
    if (x.id === drawingDimension.id || x.view !== drawingDimension.view || !x.b || x.kind === 'angle' || x.r !== undefined) {
      continue;
    }
    const frameInfo = frame(x);
    const dot = frameInfo.u[0] * me.u[0] + frameInfo.u[1] * me.u[1];
    if (Math.abs(Math.abs(dot) - 1) > 1e-6) {
      continue;
    }
    // Its line, measured along this one's normal.
    const sign = frameInfo.n[0] * me.n[0] + frameInfo.n[1] * me.n[1] > 0 ? 1 : -1;
    const line = sign * (frameInfo.A[0] * frameInfo.n[0] + frameInfo.A[1] * frameInfo.n[1] + x.offset);
    for (const candidate of [line, line + DIM_STEP, line - DIM_STEP]) {
      if (Math.abs(candidate - at) < snap && (best === null || Math.abs(candidate - at) < Math.abs(best - at))) {
        best = candidate;
      }
    }
  }
  if (best === null) {
    return drawingDimension.offset;
  }
  const off = best - base;

  // (Never on what it measures.)
  return Math.abs(off) < 2 ? drawingDimension.offset : off;
}

export function outward(placed: Placed, a: [number, number], b: [number, number]): number {
  const paperPointA = toPaper(placed, a);
  const paperPointB = toPaper(placed, b);
  const length = Math.hypot(paperPointB[0] - paperPointA[0], paperPointB[1] - paperPointA[1]) || 1;
  const normal = [(paperPointB[1] - paperPointA[1]) / length, -(paperPointB[0] - paperPointA[0]) / length];
  const center = [placed.x + (bw(placed.box) * placed.s) / 2, placed.y + (bh(placed.box) * placed.s) / 2];
  const midpoint = [(paperPointA[0] + paperPointB[0]) / 2 - center[0], (paperPointA[1] + paperPointB[1]) / 2 - center[1]];

  return normal[0] * midpoint[0] + normal[1] * midpoint[1] >= 0 ? 8 : -8;
}

export type { DrawingDetail, DrawingDim, DrawingImage, DrawingMark, DrawingNote, DrawingSection, DrawingView };
