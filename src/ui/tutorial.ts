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
    const te = e as TouchEvent;
    const at = (te.touches?.[0] ?? te.changedTouches?.[0] ?? e) as { clientX?: number; clientY?: number };
    const x = at.clientX;
    const y = at.clientY;
    const lit = e.type !== 'wheel' && x !== undefined && y !== undefined && this.open.some(b => x >= b.left && x <= b.right && y >= b.top && y <= b.bottom);
    // A touch that began on a lit spot is let finish, wherever what is lit has gone by then. (A point of a sketch is
    // placed as the finger comes down: the next spot was lit at once, the finger's lifting - at the old one - was
    // stopped, and the app was left with a finger it thought still down: no tap did anything from then on, not
    // even after the tutorial was left. Reported: "I cant go past step 3 on mobile ... if i exit tutorial, it goes
    // into a mode that doesnt let me do anything".)
    const id = (e as PointerEvent).pointerId;
    switch (e.type) {
      case 'pointerdown':
        this.clickable = lit;
        if (lit) {
          this.through.add(id);
        }
        break;
      case 'pointermove':
        if (this.through.has(id)) {
          return;
        }
        break;
      case 'pointerup':
      case 'pointercancel':
        if (this.through.delete(id)) {
          return;
        }
        break;
      case 'touchstart':
        if (lit) {
          this.touching = true;
        }
        break;
      case 'touchmove':
        if (this.touching) {
          return;
        }
        break;
      case 'touchend':
      case 'touchcancel': {
        const was = this.touching;
        if (!te.touches?.length) {
          this.touching = false;
        }
        if (was) {
          return;
        }
        break;
      }
      case 'mousedown':
        this.pressing = lit;
        break;
      case 'mouseup': {
        const was = this.pressing;
        this.pressing = false;
        if (was) {
          return;
        }
        break;
      }
      case 'click':
        if (this.clickable) {
          return;
        }
        break;
    }
    if (lit) {
      return;
    }
    e.stopImmediatePropagation();
    if (e.type !== 'pointermove' && e.cancelable) {
      e.preventDefault();
    }
  };

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
    return Array.from(document.querySelectorAll<HTMLElement>('.sn-sheet:not([hidden]) .sn-word')).find(w => (w.textContent ?? '').trim().startsWith(name)) ?? null;
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
  private at(p: Vec3, half = 24): Box | null {
    const s = this.host.toScreen(p);
    const r = this.host.canvas().getBoundingClientRect();

    return s ? box(r.left + s[0], r.top + s[1], half) : null;
  }
  // ------------------------------------------------------------------ where the beginner is

  private step(): Step | null {
    const h = this.host;
    const tool = h.tool();
    const features = h.features().filter(f => !f.suppressed);
    const extrudes = features.filter(f => f.type === 'extrude');
    const sketches = features.filter((f): f is Extract<Feature, { type: 'sketch' }> => f.type === 'sketch');
    const threaded = features.some(f => f.type === 'thread');
    const bevels = features.filter(f => f.type === 'chamfer').length;
    const fitted = features.some(f => f.type === 'boolean');
    const sel = h.selection();
    const lit = (id: StepId, text: string, targets: (Element | Box | null | undefined)[], keys = false): Step => ({ n: ORDER.indexOf(id) + 1, text, targets: targets.filter((t): t is Element | Box => !!t), keys });
    const bolt = extrudes[0]?.id;
    const nut = extrudes[2]?.id;
    /** Of a body: the flat side face nearest the eye (to tap the body by), above `zMin`. */
    const side = (body: string | undefined, zMin = -Infinity): Vec3 | null => {
      if (!body) {
        return null;
      }
      const eye = h.eye();

      return (
        h
          .faces(body)
          .filter(f => f.type === 'PLANE' && Math.abs(f.normal[2]) < 0.2 && f.center[2] > zMin)
          .map(f => ({ c: f.center, d: Math.hypot(f.center[0] - eye.x, f.center[1] - eye.y, f.center[2] - eye.z) }))
          .sort((a, b) => a.d - b.d)[0]?.c ?? null
      );
    };
    // The rod as it was made: its radius, and how high its top is.
    const rodSketch = sketches[0];
    const rod = rodSketch?.entities.find(e => e.kind === 'circle') as Extract<SketchEntity, { kind: 'circle' }> | undefined;
    const R = rod?.radius ?? ROD_R;
    const H = Math.abs((extrudes[0] as { distance?: number } | undefined)?.distance ?? ROD_L);

    // A shape being drawn in the sketch that is open: Draw, the shape, its two taps, Exit.
    const drawing = (ids: { draw: StepId; shape: StepId; centre: StepId; edge: StepId; exit: StepId }, kind: 'circle' | 'polygon', name: string, centre: Vec3, edge: Vec3, say: { draw: string; centre: string; edge: string; exit: string }): Step => {
      const made = (tool.entities ?? []).some(e => e.kind === kind);
      // (Drawn: put exactly where the two spots were, whatever the finger found inside them.)
      if (made) {
        h.exact(kind, centre, edge);
      }
      if (made) {
        return lit(ids.exit, say.exit, [document.querySelector('#sentence .sn-exit')]);
      }
      if (tool.kind === kind) {
        return (tool.pts?.length ?? 0) === 0 ? lit(ids.centre, say.centre, [this.at(centre, 22)]) : lit(ids.edge, say.edge, [this.at(edge, 22)]);
      }
      const inList = this.listed(name);
      if (inList) {
        return lit(ids.shape, `Tap ${name}.`, [inList]);
      }

      return lit(ids.draw, say.draw, [this.word('g-draw')]);
    };
    // A shape pulled up: Extrude beside it, its height typed, Done.
    // (No `distance` step: the height is set for them - asked for: "make the thickness of the bolt head and nut a
    // default because they can type a ridiculous value and it will break".)
    const pulling = (ids: { extrude: StepId; all?: StepId; distance?: StepId; type?: StepId; done: StepId }, pick: Vec3, mm: number, say: { extrude: string; done: string }, from = 0): Step => {
      if (tool.id === 'extrude') {
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
            h.setNumber('distance', mm);
          }
          if (Math.abs((tool.feature?.start ?? 0) - from) > 1e-9) {
            h.setNumber('start', from);
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
          h.setNumber('distance', mm);
        }

        return lit(ids.done, off ? `That is set to ${mm} mm for you. ${say.done}` : say.done, [this.done()]);
      }
      if (sel.some(s => s.kind === 'profile')) {
        return lit(ids.extrude, say.extrude, [this.quick('Extrude')]);
      }
      if (sel.length) {
        h.setSelection([]);
      }

      return lit(ids.extrude, 'Tap your shape to pick it.', [this.at(pick, 20)]);
    };

    // A body's flat top given a chamfer all round: its top tapped, Modify, Chamfer, Done.
    const bevelling = (ids: { face: StepId; modify: StepId; tool: StepId; done: StepId }, body: string | undefined, top: Vec3, under: number, say: { face: string; done: string }): Step => {
      // (The hexagon's other side - the one that can't be seen to tap - is chamfered with it: asked for: "chamfer the
      // other sides also".)
      if (tool.id === 'chamfer') {
        h.chamferAt(under);

        return lit(ids.done, say.done, [this.done()]);
      }
      const isTop = (f: { center: Vec3; normal: Vec3; type: string } | undefined): boolean =>
        f?.type === 'PLANE' && f.normal[2] > 0.9 && Math.abs(f.center[2] - top[2]) < 1e-3 * Math.max(1, Math.abs(top[2]));
      const all = body ? h.faces(body) : [];
      const face = sel.length === 1 && sel[0].kind === 'face' && sel[0].body === body ? all[sel[0].face] : undefined;
      // (A finger on the lit spot can take a corner or an edge of the top instead of the top: any tap on the body
      // there is its top - asked for: "so they can't screw up by ... clicking somewhere else".)
      if (sel.length === 1 && (sel[0] as { body?: string }).body === body && !isTop(face)) {
        const i = all.findIndex(isTop);
        if (i >= 0) {
          h.setSelection([{ kind: 'face', body: body!, face: i }]);

          return lit(ids.modify, 'Tap Modify.', [this.word('g-modify')]);
        }
      }
      if (isTop(face)) {
        const inList = this.listed('Chamfer');
        if (inList) {
          return lit(ids.tool, "Tap Chamfer: it cuts the face's edges at a slant.", [inList]);
        }

        return lit(ids.modify, 'Tap Modify.', [this.word('g-modify')]);
      }
      if (sel.length) {
        h.setSelection([]);
      }

      return lit(ids.face, say.face, [this.at(top, 16)]);
    };
    // (A spot on a flat top, towards the eye from its middle - clear of the rod that stands in the middle of the nut.)
    const towardsEye = (r: number, z: number): Vec3 => {
      const eye = h.eye();
      const a = Math.atan2(eye.y, eye.x);

      return [r * Math.cos(a), r * Math.sin(a), z];
    };
    const headH = Math.abs((extrudes[1] as { distance?: number } | undefined)?.distance ?? HEAD_H);
    const nutH = Math.abs((extrudes[2] as { distance?: number } | undefined)?.distance ?? NUT_H);
    const nutUp = (extrudes[2] as { start?: number } | undefined)?.start ?? 0;

    // ---- the nut fits the bolt: done.
    if (fitted && tool.id === 'select') {
      return null;
    }

    // ---- the two made to fit (Combine)
    if (extrudes.length >= 3 && bevels >= 2 && (tool.id === 'select' || tool.id === 'boolean')) {
      if (tool.id === 'boolean') {
        const f = tool.feature ?? {};
        if (!f.target) {
          return lit('fit-nut', 'Tap the nut: the body to cut into.', [this.at(side(nut) ?? [2 * R, 0, 3], 20)]);
        }
        if (!f.tools?.length) {
          return lit('fit-bolt', "Now tap the bolt's head: the body to cut away.", [this.at(side(bolt, H) ?? [2 * R, 0, H + 2], 20)]);
        }
        // The room a printed nut needs to turn: set for them (asked for: "put 0.2 mm by default and that's it").
        if (Math.abs((f.clearance ?? 0) - 0.2) > 1e-9) {
          h.setNumber('clearance', 0.2);
        }
        if (!f.keepTools) {
          const keep = this.option('p-toggle-Keep subtracted bodies', 'Keep subtracted bodies');

          return lit('fit-keep', keep.opened ? 'Clearance is set to 0.2 mm for you: room for a printed nut to turn. Tap Keep subtracted bodies, so the bolt stays.' : 'Tap Options.', [keep.el]);
        }

        return lit('fit-done', "Tap Done. The bolt's thread is cut into the nut, 0.2 mm bigger: this one takes a while.", [this.done()]);
      }
      if (sel.length) {
        h.setSelection([]);
      }
      const sub = this.listed('Subtract');
      if (sub) {
        return lit('fit-subtract', 'Tap Subtract: it cuts one body out of another.', [sub]);
      }

      return lit('fit-combine', 'The nut is a solid block round the bolt. Tap Combine.', [this.word('g-combine')]);
    }

    // ---- the nut's top edges chamfered (Modify)
    if (extrudes.length >= 3 && bevels < 2 && (tool.id === 'select' || tool.id === 'chamfer')) {
      return bevelling({ face: 'bevel2-face', modify: 'bevel2-modify', tool: 'bevel2-tool', done: 'bevel2-done' }, nut, towardsEye(1.35 * R, nutUp + nutH), nutUp, { face: 'A hexagon block round the bolt. Chamfer it too: tap its flat top.', done: 'Its underside is chamfered with it. Tap Done.' });
    }

    // ---- the nut (a hexagon on the floor, pulled up round the rod)
    if (threaded && extrudes.length === 2) {
      if (tool.id === 'sketch') {
        if (tool.phase === 'plane') {
          return lit('nut-plane', 'Tap XY: the nut is drawn on the floor.', [Array.from(document.querySelectorAll('#sentence .sn-word')).find(w => (w.textContent ?? '').trim().startsWith('XY'))]);
        }

        return drawing({ draw: 'nut-draw', shape: 'nut-polygon', centre: 'nut-centre', edge: 'nut-corner', exit: 'nut-exit' }, 'polygon', 'Polygon', [0, 0, 0], [HEX_R, 0, 0], { draw: 'Tap Draw.', centre: 'Tap the middle of the bolt.', edge: 'Tap here: a corner of the nut.', exit: 'Tap Exit.' });
      }
      const nutSketch = sketches[2];
      if (nutSketch?.entities.length || tool.id === 'extrude') {
        return pulling({ extrude: 'nut-extrude', done: 'nut-done' }, [1.3 * R, 0, 0], NUT_H, { extrude: 'Tap Extrude.', done: `It is set ${NUT_H} mm thick for you, as an M10 nut is, and ${NUT_UP} mm up the thread. Tap Done.` }, NUT_UP);
      }
      if (tool.id === 'select') {
        if (sel.length) {
          h.setSelection([]);
        }

        return lit('nut-sketch', 'The bolt is done. Now its nut: tap Sketch.', [this.word('g-sketch')]);
      }
    }

    // ---- the head's top edges chamfered (Modify)
    if (extrudes.length === 2 && !bevels && !threaded && (tool.id === 'select' || tool.id === 'chamfer')) {
      return bevelling({ face: 'bevel1-face', modify: 'bevel1-modify', tool: 'bevel1-tool', done: 'bevel1-done' }, bolt, towardsEye(1.2 * R, H + headH), H, { face: "The bolt has its head. Give it a finished look: tap the head's flat top.", done: "The head's underside is chamfered with it. Tap Done." });
    }

    // ---- the thread (Modify)
    if (extrudes.length === 2 && bevels >= 1 && !threaded && (tool.id === 'select' || tool.id === 'thread')) {
      if (tool.id === 'thread') {
        const f = tool.feature ?? {};
        if (Math.abs((f.pitch ?? 0) - PITCH) > 1e-9 || f.left || f.starts) {
          h.setNumber('pitch', PITCH);
        }

        return lit('thread-done', 'An M10 thread, 1.5 mm from turn to turn. Tap Done: cutting it takes a moment.', [this.done()]);
      }
      const face = sel.length === 1 && sel[0].kind === 'face' ? h.faces(sel[0].body)[sel[0].face] : null;
      if (face?.type === 'CYLINDRE') {
        return lit('thread-tool', 'Tap Thread.', [this.quick('Thread')]);
      }
      if (sel.length) {
        h.setSelection([]);
      }
      // (The rod's round wall, on the side that faces the eye - not on the line where the wall is joined.)
      const eye = h.eye();
      const a = Math.atan2(eye.y, eye.x) + 0.45;

      return lit('thread-wall', "A bolt needs a thread. Tap the rod's round wall.", [this.at([R * Math.cos(a), R * Math.sin(a), H * 0.35], 16)]);
    }

    // ---- the head (a hexagon on the rod's top, pulled up)
    if (extrudes.length === 1 || (extrudes.length === 2 && tool.id === 'extrude' && !threaded)) {
      if (tool.id === 'sketch') {
        return drawing({ draw: 'head-draw', shape: 'head-polygon', centre: 'head-centre', edge: 'head-corner', exit: 'head-exit' }, 'polygon', 'Polygon', [0, 0, H], [HEX_R, 0, H], { draw: 'Tap Draw.', centre: 'Tap the middle of the rod.', edge: 'Tap here: a corner of the head.', exit: 'A hexagon. Tap Exit.' });
      }
      const headSketch = sketches[1];
      if (headSketch?.entities.length || tool.id === 'extrude') {
        return pulling({ extrude: 'head-extrude', all: 'head-all', done: 'head-done' }, [1.3 * R, 0, H], HEAD_H, { extrude: 'Tap Extrude.', done: `It is set ${HEAD_H} mm thick for you, as an M10 bolt's head is. Tap Done.` });
      }
      if (tool.id === 'select') {
        const top = sel.length === 1 && sel[0].kind === 'face' ? h.faces(sel[0].body)[sel[0].face] : null;
        if (top?.type === 'PLANE' && top.normal[2] > 0.9) {
          return lit('head-sketch', 'Tap Sketch: you can draw on a face.', [this.quick('Sketch')]);
        }
        if (sel.length) {
          h.setSelection([]);
        }

        return lit('head-face', "A rod. Now its head: tap the rod's flat top.", [this.at([0, 0, H], 18)]);
      }
    }

    // ---- the rod (a circle on the floor, pulled up)
    if (!extrudes.length) {
      if (tool.id === 'sketch') {
        if (tool.phase === 'plane') {
          return lit('rod-draw', 'Tap XY: you will draw on the floor.', [Array.from(document.querySelectorAll('#sentence .sn-word')).find(w => (w.textContent ?? '').trim().startsWith('XY'))]);
        }

        return drawing({ draw: 'rod-draw', shape: 'rod-circle', centre: 'rod-centre', edge: 'rod-rim', exit: 'rod-exit' }, 'circle', 'Circle', [0, 0, 0], [ROD_R, 0, 0], { draw: 'You will build a bolt and its nut. A part starts as a flat drawing: tap Draw.', centre: 'Tap here: the middle of the circle.', edge: 'Now tap here: how big it is.', exit: "That is the rod's outline. Tap Exit." });
      }
      if (rodSketch?.entities.length || tool.id === 'extrude') {
        return pulling({ extrude: 'rod-extrude', distance: 'rod-distance', type: 'rod-type', done: 'rod-done' }, [R * 0.5, 0, 0], ROD_L, { extrude: 'Tap Extrude: it pulls a flat shape up into a solid.', done: 'Tap Done to keep it.' });
      }
      if (tool.id === 'select') {
        return lit('rod-draw', 'A part starts as a flat drawing. Tap Sketch.', [this.word('g-sketch')]);
      }
    }

    // (Something else is open - a tool the tutorial has no use for: nothing lit, and the card says so after a moment.)
    return { n: 0, text: '', targets: [] };
  }

  // ------------------------------------------------------------------ drawing it

  private frame(): void {
    // (Until the rod's circle is drawn the view is held at the tutorial's zoom: a new project's own view comes in
    // a moment after it opens, and would undo it.)
    if (!this.zoomed) {
      if (this.host.features().some(f => f.type === 'sketch' && f.entities.length)) {
        this.zoomed = true;
      } else {
        this.host.zoomTo(5, 52);
      }
    }
    const step = this.finished ? null : this.step();
    if (!step) {
      if (!this.finished) {
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

      return;
    }
    this.keysOpen = !!step.keys;
    const boxes = step.targets
      .map((t) => {
        if (!(t instanceof Element)) {
          return t;
        }
        const r = t.getBoundingClientRect();

        return r.width && r.height ? { left: r.left - 4, top: r.top - 4, right: r.right + 4, bottom: r.bottom + 4 } : null;
      })
      .filter((b): b is Box => !!b);
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

  private show(text: string, count: string, lit: Box[], finish: string): void {
    const W = window.innerWidth;
    const H = window.innerHeight;
    // Two boxes that run into each other: the lower one starts where the upper one ends (two openings over the same
    // spot would close it again there - the number pad's bottom row, where it stands over the box being typed in,
    // took no taps). One wholly over another: the two as one.
    const boxes: Box[] = [];
    for (const b of [...lit].sort((p, q) => p.top - q.top)) {
      let m: Box | null = { ...b };
      for (const u of boxes) {
        if (!m || !overlap(u, m)) {
          continue;
        }
        if (m.bottom > u.bottom + 4) {
          m.top = u.bottom;
        } else {
          u.left = Math.min(u.left, m.left);
          u.right = Math.max(u.right, m.right);
          m = null;
        }
      }
      if (m) {
        boxes.push(m);
      }
    }
    // (A little over each: a finger on the rim of a lit spot is on it.)
    this.open = finish ? [{ left: 0, top: 0, right: W, bottom: H }] : boxes.map(b => ({ left: b.left - 3, top: b.top - 3, right: b.right + 3, bottom: b.bottom + 3 }));
    const sig = `${text}|${count}|${finish}|${W}x${H}|${boxes.map(b => [b.left, b.top, b.right, b.bottom].map(Math.round).join()).join(';')}`;
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
    this.shade.style.clipPath = `path(evenodd, "M0 0 H${W} V${H} H0 Z ${holes}")`;
    const first = boxes[0];
    this.ring.hidden = !first;
    if (first) {
      Object.assign(this.ring.style, { left: `${first.left}px`, top: `${first.top}px`, width: `${first.right - first.left}px`, height: `${first.bottom - first.top}px` });
    }
    // The card. A narrow screen: across the top (under the bar), or across the lower part when what is lit is up
    // there - never beside the spot, where it would cover the model. A wide one: beside what is lit.
    const narrow = W < 720;
    const cw = narrow ? W - 16 : Math.min(360, W - 24);
    this.card.style.width = `${cw}px`;
    this.card.classList.toggle('tut-narrow', narrow);
    const ch = this.card.offsetHeight;
    let left = (W - cw) / 2;
    let top = (H - ch) / 2;
    const free = (t: number) => !boxes.some(b => overlap(b, { left, top: t - 6, right: left + cw, bottom: t + ch + 6 }));
    if (narrow) {
      const spots = [54, Math.round(H * 0.3), Math.round(H * 0.52)];
      top = boxes.length ? (spots.find(free) ?? 54) : Math.round(H * 0.3);
    } else if (boxes.length) {
      const all = { left: Math.min(...boxes.map(b => b.left)), top: Math.min(...boxes.map(b => b.top)), right: Math.max(...boxes.map(b => b.right)), bottom: Math.max(...boxes.map(b => b.bottom)) };
      left = Math.max(12, Math.min(W - cw - 12, (all.left + all.right) / 2 - cw / 2));
      const above = all.top - ch - 14;
      const below = all.bottom + 14;
      top = (all.top + all.bottom) / 2 > H / 2 ? (above >= 8 ? above : below) : below + ch <= H - 8 ? below : above;
      top = Math.max(8, Math.min(H - ch - 8, top));
    }
    // (The end: the card is low, over the line at the bottom, so what was built is in full view.)
    if (finish) {
      top = Math.max(8, H - ch - 112);
    }
    Object.assign(this.card.style, { left: `${Math.round(left)}px`, top: `${Math.round(top)}px` });
  }
}
