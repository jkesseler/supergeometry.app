// The tutorial (More > Tutorial): a real part built with a beginner, one tap at a time - a bolt with its thread,
// its edges chamfered, and the nut that fits it with room to turn - printable as they are - with tools from across
// the line: Sketch, Create, Modify, Combine. The whole screen is
// dimmed and takes no taps but for the one spot to tap next, which is lit, with a short sentence beside it.
// (Asked for: "building something with a beginner but you must guide them through and they can't click anything
// else. With simple guide text", then: "why don't we guide them to build something real, while using tools from
// each category? Something simple but impressive".)
//
// Where the beginner is, is read off the app itself each frame (what has been made, the tool that is open, what
// is picked) - not counted in taps taken. So a tap that went a little wrong (a list closed again, a face picked
// for an edge) is not a dead end: the tutorial shows what to tap from there.

import type { Vector3 } from 'three';
import type { Feature, SketchEntity, Vec3 } from '../doc/types';
import type { Sel } from '../tools/tool';

/** What the tutorial reads of the app, and the little it does to it. */
export interface TutorialHost {
  /** The tool that is open ("select" when none is). */
  tool(): {
    id: string;
    kind?: string;
    phase?: string;
    pts?: unknown[];
    entities?: SketchEntity[];
    feature?: { start?: number; distance?: number; source?: { regions?: unknown[] }; target?: string; tools?: string[]; keepTools?: boolean; clearance?: number; pitch?: number; left?: boolean; starts?: number };
  };
  selection(): Sel[];
  setSelection(sel: Sel[]): void;
  features(): readonly Feature[];
  /** A point of the model on the screen (canvas pixels), or null when it is behind the eye. */
  toScreen(p: Vec3): [number, number] | null;
  canvas(): HTMLElement;
  /** A body's faces as they are drawn: where each one's middle is, which way it faces, what kind it is. */
  faces(body: string): { center: Vec3; normal: Vec3; type: string }[];
  bodies(): string[];
  eye(): Vector3;
  /** A new, empty project, its first sketch open on the floor. */
  newProject(): Promise<void>;
  /** The drawing tools as the tutorial's taps expect them: a circle by its centre, a polygon of six sides. */
  setUp(): void;
  /** Items and History put away (a phone has no room for them and the card). */
  closePanels(): void;
  /** The view brought as near as shows `mm` of the model in `px` of the screen. */
  zoomTo(mm: number, px: number): void;
  /** A size of the tool that is open set (Extrude's distance, Subtract's clearance, Thread's pitch), and shown. */
  setNumber(field: 'distance' | 'start' | 'clearance' | 'pitch', mm: number): void;
  /** Chamfer open: the straight edges of its body that lie at the height `z` are chamfered with the rest. */
  chamferAt(z: number): void;
  /** A press however long is a tap (on), or press-and-hold is itself again (off). */
  plainTaps(on: boolean): void;
  /** The circle or polygon drawn last in the sketch that is open, put exactly: its middle and a point of its rim. */
  exact(kind: 'circle' | 'polygon', centre: Vec3, edge: Vec3): void;
}

type Box = { left: number; top: number; right: number; bottom: number };
interface Step {
  n: number;
  text: string;
  /** What may be tapped: elements, or boxes on the screen. None: nothing yet (the app is busy). */
  targets: (Element | Box)[];
  /** Typing goes through (a size is being typed). */
  keys?: boolean;
}

/** The steps, in order: each one's number is its place here. */
const ORDER = [
  // The rod
  'rod-draw', 'rod-circle', 'rod-centre', 'rod-rim', 'rod-exit', 'rod-extrude', 'rod-distance', 'rod-type', 'rod-done',
  // Its head
  'head-face', 'head-sketch', 'head-draw', 'head-polygon', 'head-centre', 'head-corner', 'head-exit', 'head-extrude', 'head-all', 'head-done',
  // The head's edges chamfered
  'bevel1-face', 'bevel1-modify', 'bevel1-tool', 'bevel1-done',
  // Its thread
  'thread-wall', 'thread-tool', 'thread-done',
  // The nut
  'nut-sketch', 'nut-plane', 'nut-draw', 'nut-polygon', 'nut-centre', 'nut-corner', 'nut-exit', 'nut-extrude', 'nut-done',
  // The nut's edges chamfered
  'bevel2-face', 'bevel2-modify', 'bevel2-tool', 'bevel2-done',
  // The two made to fit, with room to turn
  'fit-combine', 'fit-subtract', 'fit-nut', 'fit-bolt', 'fit-keep', 'fit-done'
] as const;
type StepId = (typeof ORDER)[number];
const STEPS = ORDER.length;

interface Progress {
  tool: ReturnType<TutorialHost['tool']>;
  sel: Sel[];
  extrudes: Feature[];
  sketches: Extract<Feature, { type: 'sketch' }>[];
  threaded: boolean;
  bevels: number;
  fitted: boolean;
  bolt: string | undefined;
  nut: string | undefined;
  rodRadius: number;
  rodLength: number;
  headH: number;
  nutH: number;
  nutUp: number;
}

interface ShapeSteps {
  ids: { draw: StepId; shape: StepId; centre: StepId; edge: StepId; exit: StepId };
  kind: 'circle' | 'polygon';
  /** The shape's name in the list of shapes. */
  name: string;
  centre: Vec3;
  edge: Vec3;
  say: { draw: string; centre: string; edge: string; exit: string };
}

interface PullSteps {
  ids: { extrude: StepId; all?: StepId; distance?: StepId; type?: StepId; done: StepId };
  /** Where the shape is tapped to pick it. */
  pick: Vec3;
  mm: number;
  say: { extrude: string; done: string };
  /** Extrude's start. */
  from?: number;
}

interface BevelSteps {
  ids: { face: StepId; modify: StepId; tool: StepId; done: StepId };
  body: string | undefined;
  top: Vec3;
  /** The height of the body's underside, chamfered with its top. */
  under: number;
  say: { face: string; done: string };
}

const box = (x: number, y: number, half: number): Box => ({ left: x - half, top: y - half, right: x + half, bottom: y + half });
// The sizes: an M10 bolt and nut as the standard has them. The rod 10 across; the hexagons 16 across their flats
// (18.48 corner to corner); the head 6.4 thick, the nut 8.4; the thread's pitch 1.5. (Asked for: "the dimensions
// should be exactly like from a real bolt and nut".)
const ROD_R = 5;
const ROD_L = 20;
const HEX_R = 16 / Math.sqrt(3);
const HEAD_H = 6.4;
const NUT_H = 8.4;
// The nut is made a little way up the rod, not at its end. The bolt's thread begins just above the rod's end, a
// partial turn first: a nut cut round the bolt there has, below where the thread begins, a plain bore the thread
// cannot pass - it could be turned a third of a turn towards the head and no further (found with Stop on contact).
// Up here the thread runs through the whole nut, and the nut turns both ways.
const NUT_UP = 4;
const PITCH = 1.5;

const overlap = (a: Box, b: Box) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

export class Tutorial {
  private shade = document.createElement('div');
  private ring = document.createElement('div');
  private card = document.createElement('div');
  private text = document.createElement('div');
  private count = document.createElement('div');
  private on = false;
  private raf = 0;
  private drawn = '';
  private finished = false;
  private lostSince = 0;

  constructor(private host: TutorialHost) {
    this.shade.className = 'tut-shade';
    this.ring.className = 'tut-ring';
    this.card.className = 'tut-card';
    this.text.className = 'tut-text';
    this.count.className = 'tut-count';
    const exit = document.createElement('button');
    exit.className = 'tut-exit';
    exit.textContent = 'Exit tutorial';
    exit.addEventListener('click', () => this.stop());
    const foot = document.createElement('div');
    foot.className = 'tut-foot';
    // At the end, beside Finish: straight on to a project of their own (this one is saved, in the list of projects).
    const fresh = document.createElement('button');
    fresh.className = 'tut-new';
    fresh.textContent = 'New project';
    fresh.hidden = true;
    fresh.addEventListener('click', () => (this.stop(), void this.host.newProject()));
    const ends = document.createElement('div');
    ends.className = 'tut-ends';
    ends.append(fresh, exit);
    foot.append(this.count, ends);
    this.card.append(this.text, foot);
    // (A browser that can't cut the openings in the dimmed screen - an older one: the screen is dimmed less, so what
    // is lit, under it, is still plain to see.)
    if (!CSS.supports?.('clip-path', 'path(evenodd, "M0 0 H1 V1 H0 Z")')) {
      this.shade.classList.add('tut-plain');
    }
  }

  /** What is lit now, on the screen: a tap there goes through, one anywhere else does nothing. */
  private open: Box[] = [];
  private static readonly GATED = ['pointerdown', 'pointerup', 'pointermove', 'pointercancel', 'mousedown', 'mouseup', 'click', 'dblclick', 'contextmenu', 'wheel', 'touchstart', 'touchmove', 'touchend', 'touchcancel'] as const;
  /** Touches that began on a lit spot (by their pointer's id): the rest of each goes through wherever it ends. */
  private through = new Set<number>();
  private touching = false;
  private pressing = false;
  private clickable = false;
  /**
   * Every tap, before the app has it: on a lit spot or on the card it goes on, anywhere else it stops here. Told by
   * where the tap is, not by what is under it - the dimmed screen is only looked at. (It took the taps itself, an
   * opening cut in it over each lit spot: a browser that doesn't cut such openings had a screen with nothing to tap
   * - reported: "nu poate da tap pe DRAW la step 1. Pur si simplu nu functioneaza".)
   */
  private gate = (e: Event): void => {
    const t = e.target;
    if (t instanceof Node && this.card.contains(t)) {
      return;
    }
    // (A window the app puts up meanwhile - a question, a warning: it is answered, not locked under the tutorial.)
    if (t instanceof Element && t.closest('.dialog-back')) {
      return;
    }
    const isLit = this.isOnLitSpot(e);
    if (this.followPress(e, isLit) || isLit) {
      return;
    }
    e.stopImmediatePropagation();
    if (e.type !== 'pointermove' && e.cancelable) {
      e.preventDefault();
    }
  };

  private isOnLitSpot(e: Event): boolean {
    const te = e as TouchEvent;
    const at = (te.touches?.[0] ?? te.changedTouches?.[0] ?? e) as { clientX?: number; clientY?: number };
    const x = at.clientX;
    const y = at.clientY;

    return e.type !== 'wheel' && x !== undefined && y !== undefined && this.open.some(b => x >= b.left && x <= b.right && y >= b.top && y <= b.bottom);
  }

  /**
   * A touch that began on a lit spot is let finish, wherever what is lit has gone by then. (A point of a sketch is
   * placed as the finger comes down: the next spot was lit at once, the finger's lifting - at the old one - was
   * stopped, and the app was left with a finger it thought still down: no tap did anything from then on, not
   * even after the tutorial was left. Reported: "I cant go past step 3 on mobile ... if i exit tutorial, it goes
   * into a mode that doesnt let me do anything".) True: `e` is part of a touch, press or click begun on a lit spot.
   */
  private followPress(e: Event, isLit: boolean): boolean {
    const id = (e as PointerEvent).pointerId;
    switch (e.type) {
      case 'pointerdown':
        this.clickable = isLit;
        if (isLit) {
          this.through.add(id);
        }

        return false;
      case 'pointermove':
        return this.through.has(id);
      case 'pointerup':
      case 'pointercancel':
        return this.through.delete(id);
      case 'touchstart':
        if (isLit) {
          this.touching = true;
        }

        return false;
      case 'touchmove':
        return this.touching;
      case 'touchend':
      case 'touchcancel': {
        const was = this.touching;
        if (!(e as TouchEvent).touches?.length) {
          this.touching = false;
        }

        return was;
      }
      case 'mousedown':
        this.pressing = isLit;

        return false;
      case 'mouseup': {
        const was = this.pressing;
        this.pressing = false;

        return was;
      }
      case 'click':
        return this.clickable;
      default:
        return false;
    }
  }

  /** Running, or on its way (its new project being opened). */
  get running(): boolean {
    return this.on || this.starting;
  }
  private starting = false;

  /** Begin: a new project (what is open is saved and stays in the list of projects), and the first thing to tap. */
  async start(): Promise<void> {
    if (this.on || this.starting) {
      return;
    }
    this.starting = true;
    try {
      await this.host.newProject();
    } finally {
      this.starting = false;
    }
    this.host.setUp();
    this.host.closePanels();
    // The same bolt on every screen: the view as near as makes its rod's 5 mm radius 52 px - a spot a finger
    // finds, and the grid's squares 1 mm, so the tap lands on 5 exactly. (At a phone's own zoom the same 52 px
    // were 20 mm: a rod as wide as it was tall, its head hiding the wall the thread goes on.)
    this.host.zoomTo(5, 52);
    this.zoomed = false;
    this.host.plainTaps(true);
    this.on = true;
    this.finished = false;
    this.lostSince = 0;
    this.drawn = '';
    document.body.append(this.shade, this.ring, this.card);
    document.body.classList.add('tut-on');
    window.addEventListener('keydown', this.onKey, true);
    for (const type of Tutorial.GATED) {
      window.addEventListener(type, this.gate, { capture: true, passive: false });
    }
    const loop = () => {
      if (!this.on) {
        return;
      }
      this.frame();
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
    // (And a few times a second whatever the screen is doing: a browser that draws seldom - a tab in the background,
    // a phone saving power - would leave the card a step behind.)
    this.tick = window.setInterval(() => this.on && this.frame(), 300);
  }

  private tick = 0;
  /** The rod's circle is drawn: the view is the beginner's from then on. */
  private zoomed = false;

  stop(): void {
    if (!this.on) {
      return;
    }
    this.on = false;
    cancelAnimationFrame(this.raf);
    clearInterval(this.tick);
    window.removeEventListener('keydown', this.onKey, true);
    for (const type of Tutorial.GATED) {
      window.removeEventListener(type, this.gate, { capture: true });
    }
    this.host.plainTaps(false);
    this.through.clear();
    this.touching = this.pressing = this.clickable = false;
    this.open = [];
    this.shade.remove();
    this.ring.remove();
    this.card.remove();
    document.body.classList.remove('tut-on');
  }

  /** Keys do nothing while it runs (a shortcut would start a tool the tutorial didn't ask for) - but a size being typed. */
  private keysOpen = false;
  private onKey = (e: KeyboardEvent): void => {
    // (Every key then: a phone's own keyboard sends its digits as keys with no name.)
    if (this.keysOpen && e.key !== 'Escape') {
      return;
    }
    e.stopImmediatePropagation();
    e.preventDefault();
  };

  // ------------------------------------------------------------------ what is on the screen

  private word(key: string): Element | null {
    return document.querySelector(`#sentence .sn-line [data-key="${key}"]`);
  }
  /** A tool in the list that is open over the line, by its name. */
  private listed(name: string): Element | null {
    return Array.from(document.querySelectorAll<HTMLElement>('.sn-sheet:not([hidden]) .sn-word')).find(element => (element.textContent ?? '').trim().startsWith(name)) ?? null;
  }
  private quick(name: string): Element | null {
    return Array.from(document.querySelectorAll<HTMLElement>('button.quick-action')).find(b => b.offsetParent && (b.title || b.textContent || '').startsWith(name)) ?? null;
  }
  /**
   * One of a tool's own settings: on the line where there is room for it, else in the list Options opens (a phone
   * held upright), else Options itself - `opened`: false then, and the card says to tap Options.
   */
  private option(key: string, name: string): { el: Element | null; opened: boolean } {
    const here = this.word(key) ?? this.listed(name);

    return here ? { el: here, opened: true } : { el: this.word('t-options'), opened: false };
  }
  private done(): Element | null {
    return document.querySelector('#sentence .sn-done');
  }
  private at(point: Vec3, half = 24): Box | null {
    const screenPoint = this.host.toScreen(point);
    const rect = this.host.canvas().getBoundingClientRect();

    return screenPoint ? box(rect.left + screenPoint[0], rect.top + screenPoint[1], half) : null;
  }
  // ------------------------------------------------------------------ where the beginner is

  /** What has been made, what is open and what is picked, read off the app once a frame. */
  private progress(): Progress {
    const host = this.host;
    const tool = host.tool();
    const features = host.features().filter(feature => !feature.suppressed);
    const extrudes = features.filter(feature => feature.type === 'extrude');
    const sketches = features.filter((feature): feature is Extract<Feature, { type: 'sketch' }> => feature.type === 'sketch');
    const sel = host.selection();
    // The rod as it was made: its radius, and how high its top is.
    const rod = sketches[0]?.entities.find(e => e.kind === 'circle') as Extract<SketchEntity, { kind: 'circle' }> | undefined;

    return {
      tool,
      sel,
      extrudes,
      sketches,
      threaded: features.some(feature => feature.type === 'thread'),
      bevels: features.filter(feature => feature.type === 'chamfer').length,
      fitted: features.some(feature => feature.type === 'boolean'),
      bolt: extrudes[0]?.id,
      nut: extrudes[2]?.id,
      rodRadius: rod?.radius ?? ROD_R,
      rodLength: Math.abs((extrudes[0] as { distance?: number } | undefined)?.distance ?? ROD_L),
      headH: Math.abs((extrudes[1] as { distance?: number } | undefined)?.distance ?? HEAD_H),
      nutH: Math.abs((extrudes[2] as { distance?: number } | undefined)?.distance ?? NUT_H),
      nutUp: (extrudes[2] as { start?: number } | undefined)?.start ?? 0
    };
  }

  private step(): Step | null {
    const progress = this.progress();
    const extruded = progress.extrudes.length;
    // ---- the nut fits the bolt: done.
    if (progress.fitted && progress.tool.id === 'select') {
      return null;
    }
    if (extruded >= 3) {
      return this.nutMade(progress);
    }
    if (extruded === 2) {
      return this.headMade(progress);
    }
    if (extruded === 1) {
      return this.head(progress);
    }

    return this.rod(progress);
  }

  /** The rod, its head and the nut made: the nut's edges chamfered, then the two made to fit. */
  private nutMade(progress: Progress): Step {
    const { tool, bevels } = progress;
    // ---- the two made to fit (Combine)
    if (bevels >= 2 && (tool.id === 'select' || tool.id === 'boolean')) {
      return this.fitting(progress);
    }
    // ---- the nut's top edges chamfered (Modify)
    if (bevels < 2 && (tool.id === 'select' || tool.id === 'chamfer')) {
      return this.bevelling(progress, {
        ids: { face: 'bevel2-face', modify: 'bevel2-modify', tool: 'bevel2-tool', done: 'bevel2-done' },
        body: progress.nut,
        top: this.towardsEye(1.35 * progress.rodRadius, progress.nutUp + progress.nutH),
        under: progress.nutUp,
        say: { face: 'A hexagon block round the bolt. Chamfer it too: tap its flat top.', done: 'Its underside is chamfered with it. Tap Done.' }
      });
    }

    return nothingToTap();
  }

  /** The rod and its head made: the head's edges chamfered, the thread, then the nut. */
  private headMade(progress: Progress): Step {
    const { tool, bevels } = progress;
    if (progress.threaded) {
      return this.nut(progress);
    }
    // ---- the head's top edges chamfered (Modify)
    if (!bevels && (tool.id === 'select' || tool.id === 'chamfer')) {
      return this.bevelling(progress, {
        ids: { face: 'bevel1-face', modify: 'bevel1-modify', tool: 'bevel1-tool', done: 'bevel1-done' },
        body: progress.bolt,
        top: this.towardsEye(1.2 * progress.rodRadius, progress.rodLength + progress.headH),
        under: progress.rodLength,
        say: { face: "The bolt has its head. Give it a finished look: tap the head's flat top.", done: "The head's underside is chamfered with it. Tap Done." }
      });
    }
    if (bevels >= 1 && (tool.id === 'select' || tool.id === 'thread')) {
      return this.threading(progress);
    }
    // The head's Extrude still open.
    if (tool.id === 'extrude') {
      return this.head(progress);
    }

    return nothingToTap();
  }

  /** The two made to fit (Combine). */
  private fitting(progress: Progress): Step {
    if (progress.tool.id === 'boolean') {
      return this.subtracting(progress);
    }
    if (progress.sel.length) {
      this.host.setSelection([]);
    }
    const sub = this.listed('Subtract');
    if (sub) {
      return lit('fit-subtract', 'Tap Subtract: it cuts one body out of another.', [sub]);
    }

    return lit('fit-combine', 'The nut is a solid block round the bolt. Tap Combine.', [this.word('g-combine')]);
  }

  /** Subtract open: the nut, the bolt, the bolt kept, Done. */
  private subtracting({ tool, nut, bolt, rodRadius, rodLength }: Progress): Step {
    const feature = tool.feature ?? {};
    if (!feature.target) {
      return lit('fit-nut', 'Tap the nut: the body to cut into.', [this.at(this.sideFacingEye(nut) ?? [2 * rodRadius, 0, 3], 20)]);
    }
    if (!feature.tools?.length) {
      return lit('fit-bolt', "Now tap the bolt's head: the body to cut away.", [this.at(this.sideFacingEye(bolt, rodLength) ?? [2 * rodRadius, 0, rodLength + 2], 20)]);
    }
    // The room a printed nut needs to turn: set for them (asked for: "put 0.2 mm by default and that's it").
    if (Math.abs((feature.clearance ?? 0) - 0.2) > 1e-9) {
      this.host.setNumber('clearance', 0.2);
    }
    if (!feature.keepTools) {
      const keep = this.option('p-toggle-Keep subtracted bodies', 'Keep subtracted bodies');

      return lit('fit-keep', keep.opened ? 'Clearance is set to 0.2 mm for you: room for a printed nut to turn. Tap Keep subtracted bodies, so the bolt stays.' : 'Tap Options.', [keep.el]);
    }

    return lit('fit-done', "Tap Done. The bolt's thread is cut into the nut, 0.2 mm bigger: this one takes a while.", [this.done()]);
  }

  /** The nut: a hexagon on the floor, pulled up round the rod. */
  private nut(progress: Progress): Step {
    const { tool, sel, rodRadius } = progress;
    if (tool.id === 'sketch' && tool.phase === 'plane') {
      return lit('nut-plane', 'Tap XY: the nut is drawn on the floor.', [this.floorWord()]);
    }
    if (tool.id === 'sketch') {
      return this.drawing(progress, {
        ids: { draw: 'nut-draw', shape: 'nut-polygon', centre: 'nut-centre', edge: 'nut-corner', exit: 'nut-exit' },
        kind: 'polygon',
        name: 'Polygon',
        centre: [0, 0, 0],
        edge: [HEX_R, 0, 0],
        say: { draw: 'Tap Draw.', centre: 'Tap the middle of the bolt.', edge: 'Tap here: a corner of the nut.', exit: 'Tap Exit.' }
      });
    }
    const nutSketch = progress.sketches[2];
    if (nutSketch?.entities.length || tool.id === 'extrude') {
      return this.pulling(progress, {
        ids: { extrude: 'nut-extrude', done: 'nut-done' },
        pick: [1.3 * rodRadius, 0, 0],
        mm: NUT_H,
        say: { extrude: 'Tap Extrude.', done: `It is set ${NUT_H} mm thick for you, as an M10 nut is, and ${NUT_UP} mm up the thread. Tap Done.` },
        from: NUT_UP
      });
    }
    if (tool.id !== 'select') {
      return nothingToTap();
    }
    if (sel.length) {
      this.host.setSelection([]);
    }

    return lit('nut-sketch', 'The bolt is done. Now its nut: tap Sketch.', [this.word('g-sketch')]);
  }

  /** The thread (Modify). */
  private threading({ tool, sel, rodRadius, rodLength }: Progress): Step {
    const host = this.host;
    if (tool.id === 'thread') {
      const feature = tool.feature ?? {};
      if (Math.abs((feature.pitch ?? 0) - PITCH) > 1e-9 || feature.left || feature.starts) {
        host.setNumber('pitch', PITCH);
      }

      return lit('thread-done', 'An M10 thread, 1.5 mm from turn to turn. Tap Done: cutting it takes a moment.', [this.done()]);
    }
    const face = sel.length === 1 && sel[0].kind === 'face' ? host.faces(sel[0].body)[sel[0].face] : null;
    if (face?.type === 'CYLINDRE') {
      return lit('thread-tool', 'Tap Thread.', [this.quick('Thread')]);
    }
    if (sel.length) {
      host.setSelection([]);
    }
    // (The rod's round wall, on the side that faces the eye - not on the line where the wall is joined.)
    const eye = host.eye();
    const a = Math.atan2(eye.y, eye.x) + 0.45;

    return lit('thread-wall', "A bolt needs a thread. Tap the rod's round wall.", [this.at([rodRadius * Math.cos(a), rodRadius * Math.sin(a), rodLength * 0.35], 16)]);
  }

  /** The head: a hexagon on the rod's top, pulled up. */
  private head(progress: Progress): Step {
    const { tool, sel, rodRadius, rodLength } = progress;
    const host = this.host;
    if (tool.id === 'sketch') {
      return this.drawing(progress, {
        ids: { draw: 'head-draw', shape: 'head-polygon', centre: 'head-centre', edge: 'head-corner', exit: 'head-exit' },
        kind: 'polygon',
        name: 'Polygon',
        centre: [0, 0, rodLength],
        edge: [HEX_R, 0, rodLength],
        say: { draw: 'Tap Draw.', centre: 'Tap the middle of the rod.', edge: 'Tap here: a corner of the head.', exit: 'A hexagon. Tap Exit.' }
      });
    }
    const headSketch = progress.sketches[1];
    if (headSketch?.entities.length || tool.id === 'extrude') {
      return this.pulling(progress, {
        ids: { extrude: 'head-extrude', all: 'head-all', done: 'head-done' },
        pick: [1.3 * rodRadius, 0, rodLength],
        mm: HEAD_H,
        say: { extrude: 'Tap Extrude.', done: `It is set ${HEAD_H} mm thick for you, as an M10 bolt's head is. Tap Done.` }
      });
    }
    if (tool.id !== 'select') {
      return nothingToTap();
    }
    const top = sel.length === 1 && sel[0].kind === 'face' ? host.faces(sel[0].body)[sel[0].face] : null;
    if (top?.type === 'PLANE' && top.normal[2] > 0.9) {
      return lit('head-sketch', 'Tap Sketch: you can draw on a face.', [this.quick('Sketch')]);
    }
    if (sel.length) {
      host.setSelection([]);
    }

    return lit('head-face', "A rod. Now its head: tap the rod's flat top.", [this.at([0, 0, rodLength], 18)]);
  }

  /** The rod: a circle on the floor, pulled up. */
  private rod(progress: Progress): Step {
    const { tool, rodRadius } = progress;
    if (tool.id === 'sketch' && tool.phase === 'plane') {
      return lit('rod-draw', 'Tap XY: you will draw on the floor.', [this.floorWord()]);
    }
    if (tool.id === 'sketch') {
      return this.drawing(progress, {
        ids: { draw: 'rod-draw', shape: 'rod-circle', centre: 'rod-centre', edge: 'rod-rim', exit: 'rod-exit' },
        kind: 'circle',
        name: 'Circle',
        centre: [0, 0, 0],
        edge: [ROD_R, 0, 0],
        say: { draw: 'You will build a bolt and its nut. A part starts as a flat drawing: tap Draw.', centre: 'Tap here: the middle of the circle.', edge: 'Now tap here: how big it is.', exit: "That is the rod's outline. Tap Exit." }
      });
    }
    if (progress.sketches[0]?.entities.length || tool.id === 'extrude') {
      return this.pulling(progress, {
        ids: { extrude: 'rod-extrude', distance: 'rod-distance', type: 'rod-type', done: 'rod-done' },
        pick: [rodRadius * 0.5, 0, 0],
        mm: ROD_L,
        say: { extrude: 'Tap Extrude: it pulls a flat shape up into a solid.', done: 'Tap Done to keep it.' }
      });
    }
    if (tool.id === 'select') {
      return lit('rod-draw', 'A part starts as a flat drawing. Tap Sketch.', [this.word('g-sketch')]);
    }

    return nothingToTap();
  }

  /** The XY plane's word on the line, to draw on the floor. */
  private floorWord(): Element | undefined {
    return Array.from(document.querySelectorAll('#sentence .sn-word')).find(element => (element.textContent ?? '').trim().startsWith('XY'));
  }

  /** A shape being drawn in the sketch that is open: Draw, the shape, its two taps, Exit. */
  private drawing({ tool }: Progress, shape: ShapeSteps): Step {
    const { ids, kind, centre, edge, say } = shape;
    // (Drawn: put exactly where the two spots were, whatever the finger found inside them.)
    if ((tool.entities ?? []).some(e => e.kind === kind)) {
      this.host.exact(kind, centre, edge);

      return lit(ids.exit, say.exit, [document.querySelector('#sentence .sn-exit')]);
    }
    if (tool.kind === kind) {
      return (tool.pts?.length ?? 0) === 0 ? lit(ids.centre, say.centre, [this.at(centre, 22)]) : lit(ids.edge, say.edge, [this.at(edge, 22)]);
    }
    const inList = this.listed(shape.name);
    if (inList) {
      return lit(ids.shape, `Tap ${shape.name}.`, [inList]);
    }

    return lit(ids.draw, say.draw, [this.word('g-draw')]);
  }

  /** A shape pulled up: Extrude beside it, its height typed, Done. */
  private pulling(progress: Progress, pull: PullSteps): Step {
    const { tool, sel } = progress;
    if (tool.id === 'extrude') {
      return this.extruding(progress, pull);
    }
    if (sel.some(highlight => highlight.kind === 'profile')) {
      return lit(pull.ids.extrude, pull.say.extrude, [this.quick('Extrude')]);
    }
    if (sel.length) {
      this.host.setSelection([]);
    }

    return lit(pull.ids.extrude, 'Tap your shape to pick it.', [this.at(pull.pick, 20)]);
  }

  /**
   * Extrude open: its height typed, then Done.
   * (No `distance` step: the height is set for them - asked for: "make the thickness of the bolt head and nut a
   * default because they can type a ridiculous value and it will break".)
   */
  private extruding({ tool }: Progress, pull: PullSteps): Step {
    const { ids, mm, say } = pull;
    const host = this.host;
    const typing = document.querySelector<HTMLElement>('.sn-sheet.sn-typing:not([hidden])');
    if (typing && ids.type) {
      return lit(ids.type, `Type ${mm}, then press Enter.`, [typing, document.querySelector('.numpad:not([hidden])')], true);
    }
    if (ids.all && (tool.feature?.source?.regions?.length ?? 0) < 2) {
      const all = this.option('p-button-All shapes', 'All shapes');

      return lit(ids.all, all.opened ? 'Tap All shapes: the whole hexagon, not only its rim.' : 'Tap Options.', [all.el]);
    }
    if (!ids.distance) {
      if (Math.abs((tool.feature?.distance ?? 0) - mm) > 1e-9) {
        host.setNumber('distance', mm);
      }
      const from = pull.from ?? 0;
      if (Math.abs((tool.feature?.start ?? 0) - from) > 1e-9) {
        host.setNumber('start', from);
      }

      return lit(ids.done, say.done, [this.done()]);
    }
    if (!tool.feature?.distance) {
      return lit(ids.distance, 'How tall? Tap Distance.', [this.word('p-number-Distance')]);
    }
    // Another size typed (a slip of the finger, a key too many): put right - the rest of the build goes by it.
    // (Asked for: "so they can't screw up by entering wrong values".)
    const off = Math.abs(tool.feature.distance - mm) > 1e-9;
    if (off) {
      host.setNumber('distance', mm);
    }

    return lit(ids.done, off ? `That is set to ${mm} mm for you. ${say.done}` : say.done, [this.done()]);
  }

  /** A body's flat top given a chamfer all round: its top tapped, Modify, Chamfer, Done. */
  private bevelling({ tool, sel }: Progress, bevel: BevelSteps): Step {
    const { ids, body, top, say } = bevel;
    const host = this.host;
    // (The hexagon's other side - the one that can't be seen to tap - is chamfered with it: asked for: "chamfer the
    // other sides also".)
    if (tool.id === 'chamfer') {
      host.chamferAt(bevel.under);

      return lit(ids.done, say.done, [this.done()]);
    }
    const isTop = (face: { center: Vec3; normal: Vec3; type: string } | undefined): boolean =>
      face?.type === 'PLANE' && face.normal[2] > 0.9 && Math.abs(face.center[2] - top[2]) < 1e-3 * Math.max(1, Math.abs(top[2]));
    const all = body ? host.faces(body) : [];
    const face = sel.length === 1 && sel[0].kind === 'face' && sel[0].body === body ? all[sel[0].face] : undefined;
    // (A finger on the lit spot can take a corner or an edge of the top instead of the top: any tap on the body
    // there is its top - asked for: "so they can't screw up by ... clicking somewhere else".)
    const isOnBodyBesideTop = sel.length === 1 && (sel[0] as { body?: string }).body === body && !isTop(face);
    const topIndex = isOnBodyBesideTop ? all.findIndex(isTop) : -1;
    if (topIndex >= 0) {
      host.setSelection([{ kind: 'face', body: body!, face: topIndex }]);

      return lit(ids.modify, 'Tap Modify.', [this.word('g-modify')]);
    }
    if (isTop(face)) {
      const inList = this.listed('Chamfer');
      if (inList) {
        return lit(ids.tool, "Tap Chamfer: it cuts the face's edges at a slant.", [inList]);
      }

      return lit(ids.modify, 'Tap Modify.', [this.word('g-modify')]);
    }
    if (sel.length) {
      host.setSelection([]);
    }

    return lit(ids.face, say.face, [this.at(top, 16)]);
  }

  /** Of a body: the flat side face nearest the eye (to tap the body by), above `zMin`. */
  private sideFacingEye(body: string | undefined, zMin = -Infinity): Vec3 | null {
    if (!body) {
      return null;
    }
    const eye = this.host.eye();

    return (
      this.host
        .faces(body)
        .filter(face => face.type === 'PLANE' && Math.abs(face.normal[2]) < 0.2 && face.center[2] > zMin)
        .map(face => ({ c: face.center, d: Math.hypot(face.center[0] - eye.x, face.center[1] - eye.y, face.center[2] - eye.z) }))
        .sort((a, b) => a.d - b.d)[0]?.c ?? null
    );
  }

  /** A spot on a flat top, towards the eye from its middle - clear of the rod that stands in the middle of the nut. */
  private towardsEye(radius: number, z: number): Vec3 {
    const eye = this.host.eye();
    const a = Math.atan2(eye.y, eye.x);

    return [radius * Math.cos(a), radius * Math.sin(a), z];
  }

  // ------------------------------------------------------------------ drawing it

  private frame(): void {
    // (Until the rod's circle is drawn the view is held at the tutorial's zoom: a new project's own view comes in
    // a moment after it opens, and would undo it.)
    if (!this.zoomed) {
      if (this.host.features().some(feature => feature.type === 'sketch' && feature.entities.length)) {
        this.zoomed = true;
      } else {
        this.host.zoomTo(5, 52);
      }
    }
    const step = this.finished ? null : this.step();
    if (!step) {
      if (!this.finished) {
        this.finish();
      }

      return;
    }
    this.keysOpen = !!step.keys;
    const boxes = boxesOf(step.targets);
    if (!boxes.length) {
      // Nothing to light just now: the app is building, or a list is on its way. Long with nothing: a way out.
      this.lostSince ||= performance.now();
      if (performance.now() - this.lostSince > 6000) {
        this.show('That went another way than the tutorial expected. Exit it, and start it again from More whenever you like.', '', [], '');
      } else {
        this.show(step.text || 'One moment...', step.n ? `Step ${step.n} of ${STEPS}` : '', [], '');
      }

      return;
    }
    this.lostSince = 0;
    this.show(step.text, `Step ${step.n} of ${STEPS}`, boxes, '');
  }

  private finish(): void {
    this.finished = true;
    this.keysOpen = false;
    // (The part is theirs to look at: nothing dimmed any more, only the card.)
    this.shade.remove();
    this.ring.remove();
    window.removeEventListener('keydown', this.onKey, true);
    for (const type of Tutorial.GATED) {
      window.removeEventListener(type, this.gate, { capture: true });
    }
    this.host.plainTaps(false);
    this.show("An M10 bolt and its nut, in their real sizes and ready to print: the nut's thread is 0.2 mm bigger all round, so it turns. Drag to look at them, pinch or use the wheel to zoom. You can export them now, from File.", 'Done', [], 'Finish');
  }

  private show(text: string, count: string, litBoxes: Box[], finish: string): void {
    const innerWidth = window.innerWidth;
    const innerHeight = window.innerHeight;
    const boxes = withoutOverlaps(litBoxes);
    // (A little over each: a finger on the rim of a lit spot is on it.)
    this.open = finish ? [{ left: 0, top: 0, right: innerWidth, bottom: innerHeight }] : boxes.map(b => ({ left: b.left - 3, top: b.top - 3, right: b.right + 3, bottom: b.bottom + 3 }));
    const sig = `${text}|${count}|${finish}|${innerWidth}x${innerHeight}|${boxes.map(b => [b.left, b.top, b.right, b.bottom].map(Math.round).join()).join(';')}`;
    if (sig === this.drawn) {
      return;
    }
    this.drawn = sig;
    this.text.textContent = text;
    this.count.textContent = count;
    this.card.querySelector<HTMLElement>('.tut-new')!.hidden = !finish;
    const exit = this.card.querySelector<HTMLElement>('.tut-exit')!;
    exit.textContent = finish || 'Exit tutorial';
    exit.classList.toggle('primary', !!finish);
    // The dimmed screen, a hole over each lit box (what is in a hole takes the tap itself).
    const holes = boxes.map(b => `M${Math.round(b.left)} ${Math.round(b.top)} H${Math.round(b.right)} V${Math.round(b.bottom)} H${Math.round(b.left)} Z`).join(' ');
    this.shade.style.clipPath = `path(evenodd, "M0 0 H${innerWidth} V${innerHeight} H0 Z ${holes}")`;
    const first = boxes[0];
    this.ring.hidden = !first;
    if (first) {
      Object.assign(this.ring.style, { left: `${first.left}px`, top: `${first.top}px`, width: `${first.right - first.left}px`, height: `${first.bottom - first.top}px` });
    }
    const narrow = innerWidth < 720;
    const cardWidth = narrow ? innerWidth - 16 : Math.min(360, innerWidth - 24);
    this.card.style.width = `${cardWidth}px`;
    this.card.classList.toggle('tut-narrow', narrow);
    const cardHeight = this.card.offsetHeight;
    const spot = cardSpot({ boxes, width: innerWidth, height: innerHeight, cardWidth, cardHeight, narrow });
    // (The end: the card is low, over the line at the bottom, so what was built is in full view.)
    const top = finish ? Math.max(8, innerHeight - cardHeight - 112) : spot.top;
    Object.assign(this.card.style, { left: `${Math.round(spot.left)}px`, top: `${Math.round(top)}px` });
  }
}

const lit = (id: StepId, text: string, targets: (Element | Box | null | undefined)[], keys = false): Step => ({ n: ORDER.indexOf(id) + 1, text, targets: targets.filter((t): t is Element | Box => !!t), keys });

/** Something else is open - a tool the tutorial has no use for: nothing lit, and the card says so after a moment. */
const nothingToTap = (): Step => ({ n: 0, text: '', targets: [] });

/** What a step lights, as boxes on the screen: an element a little bigger all round; one not shown, none. */
function boxesOf(targets: (Element | Box)[]): Box[] {
  return targets
    .map((t) => {
      if (!(t instanceof Element)) {
        return t;
      }
      const rect = t.getBoundingClientRect();

      return rect.width && rect.height ? { left: rect.left - 4, top: rect.top - 4, right: rect.right + 4, bottom: rect.bottom + 4 } : null;
    })
    .filter((b): b is Box => !!b);
}

/**
 * Two boxes that run into each other: the lower one starts where the upper one ends (two openings over the same
 * spot would close it again there - the number pad's bottom row, where it stands over the box being typed in,
 * took no taps). One wholly over another: the two as one.
 */
function withoutOverlaps(litBoxes: Box[]): Box[] {
  const boxes: Box[] = [];
  for (const litBox of [...litBoxes].sort((a, b) => a.top - b.top)) {
    const current = { ...litBox };
    let isMerged = false;
    for (const otherBox of boxes) {
      if (!overlap(otherBox, current)) {
        continue;
      }
      if (current.bottom > otherBox.bottom + 4) {
        current.top = otherBox.bottom;
        continue;
      }
      otherBox.left = Math.min(otherBox.left, current.left);
      otherBox.right = Math.max(otherBox.right, current.right);
      isMerged = true;
      break;
    }
    if (!isMerged) {
      boxes.push(current);
    }
  }

  return boxes;
}

interface CardRoom {
  boxes: Box[];
  width: number;
  height: number;
  cardWidth: number;
  cardHeight: number;
  narrow: boolean;
}

/**
 * Where the card goes. A narrow screen: across the top (under the bar), or across the lower part when what is lit
 * is up there - never beside the spot, where it would cover the model. A wide one: beside what is lit.
 */
function cardSpot(room: CardRoom): { left: number; top: number } {
  const { boxes, width, height, cardWidth, cardHeight } = room;
  const left = (width - cardWidth) / 2;
  if (room.narrow && !boxes.length) {
    return { left, top: Math.round(height * 0.3) };
  }
  if (room.narrow) {
    const isFree = (top: number) => !boxes.some(b => overlap(b, { left, top: top - 6, right: left + cardWidth, bottom: top + cardHeight + 6 }));
    const spots = [54, Math.round(height * 0.3), Math.round(height * 0.52)];

    return { left, top: spots.find(isFree) ?? 54 };
  }
  if (!boxes.length) {
    return { left, top: (height - cardHeight) / 2 };
  }

  return besideLit(room);
}

/** Above or below what is lit, whichever has room, centred on it. */
function besideLit({ boxes, width, height, cardWidth, cardHeight }: CardRoom): { left: number; top: number } {
  const all = { left: Math.min(...boxes.map(b => b.left)), top: Math.min(...boxes.map(b => b.top)), right: Math.max(...boxes.map(b => b.right)), bottom: Math.max(...boxes.map(b => b.bottom)) };
  const above = all.top - cardHeight - 14;
  const below = all.bottom + 14;
  const isLitLow = (all.top + all.bottom) / 2 > height / 2;
  let top: number;
  if (isLitLow) {
    top = above >= 8 ? above : below;
  } else {
    top = below + cardHeight <= height - 8 ? below : above;
  }

  return { left: Math.max(12, Math.min(width - cardWidth - 12, (all.left + all.right) / 2 - cardWidth / 2)), top: Math.max(8, Math.min(height - cardHeight - 8, top)) };
}
