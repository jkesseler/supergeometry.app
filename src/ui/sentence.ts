// The sentence bar: the app worked by finishing a sentence.
//
// One line at the bottom of the screen always says where things stand, and it
// is written by touching the model: the pick is its subject ("1 face"), what
// can be done with that pick are the words offered after it (only those - a
// tool that needs something else picked is not there), the tool chosen is its
// verb, and the tool's options are the rest of the sentence: a blank to fill by
// tapping the model ("Axis ____"), a word to swap ("One side"), a number to
// type or to drag sideways ("12 mm"). The tick ends the sentence (Done), the
// eraser takes the last part back (Cancel, then the pick itself).
//
// The line holds the tools by group (Sketch, Freeform, Transform, Construct,
// Modify, Combine, Create), each group what the pick offers - with nothing
// picked every tool, each asking for its pick as it starts. A group is dimmed
// only when nothing in it can be used. A thread runs from the
// subject to the thing it names on the model, so it is always plain what the
// sentence is about.
//
// It shows the very ToolItems and window parts the other ways of working
// hold (`ui.shown()`, `ui.panelContent()`), so a tool added to the app is in
// the sentence by itself. Always on (the setting is kept for the code that
// asks): it is the only way to the tools.

import { settings } from '../settings';
import { evaluate, RESERVED, toDisplay, UNIT_LABEL, units } from '../units';
import { iconNameFor, icons, type IconName } from './icons';
import { numpadInput, openNumpad } from './numpad';
import { selectAll } from './textField';
import { el, isExpression, usable, type ToolItem, type UI } from './ui';
import { ALIAS, GROUP_OF, RANK } from './toolGroups';
import type { Viewport } from '../view/viewport';
import type { Sel } from '../tools/tool';
import type { Vec3 } from '../doc/types';

export interface SentenceHost {
  readonly ui: UI;
  readonly view: Viewport;
  mainTools(): ToolItem[];
  /** What is picked on the model. */
  selection(): Sel[];
  /** Where the work is: the model, a sketch, a freeform shape, or another tool. */
  mode(): 'model' | 'sketch' | 'freeform' | 'tool';
  /** In a sketch: how many curves and points are picked. */
  sketchPicked(): number;
  /** Each tap adds to the pick (else a tap picks that thing alone), and switching that. */
  adding(): boolean;
  setAdding(on: boolean): void;
  /** Pick this instead of what is picked. */
  pick(sel: Sel[]): void;
  /** A look ahead drawn on the model (dashed line segments), or none. */
  peek(segs: number[] | null): void;
  /** A tool started with nothing picked that is waiting for its pick (its name), and letting it go. */
  waiting(): string | null;
  stopWaiting(): void;
  /** Where the pick is on the model (for the thread to it). */
  anchor(): Vec3 | null;
  /** In a sketch: tap the view again where it was last tapped (a tool that acts where it is tapped, started for the piece picked there). */
  retap(): void;
}

/** One word of the sentence. */
interface Word {
  /** The same word, drawn again: it stays where it is (a new one comes in). */
  key: string;
  /** What it would do to the pick, as dashed lines on the model, shown while the pointer is over it. */
  peek?: () => number[];
  /** A group with something picked: its other tools - not for this pick as it is, each asks for its own as it starts - under the pick's own in its list. */
  rest?: Word[];
  kind: 'subject' | 'verb' | 'slot' | 'choice' | 'toggle' | 'value' | 'button';
  label: string;
  /** A small name over it (what the option is: "Ends", "Distance"). */
  cap?: string;
  icon?: IconName;
  swatch?: string;
  /** Lit: the tool in use, a switch that is on, the option chosen. */
  on?: boolean;
  /** A blank waiting for a tap on the model. */
  blank?: boolean;
  /** The step to take next. */
  pulse?: boolean;
  /** The subject with nothing picked, a group's name: said, not tapped. */
  quiet?: boolean;
  kbd?: string;
  run?: () => void;
  /** Done as its list is opened (a sketch's Draw: Line is on, to draw at once). */
  opens?: () => void;
  /** What it opens: a tool's kinds, a choice's other options. */
  kids?: Word[];
  /** A number: typed, or dragged sideways. */
  value?: {
    now: number;
    text: string;
    kind: 'length' | 'angle' | 'number' | 'int';
    put(v: number): void;
    min?: number;
    max?: number;
    step?: number;
    /** The formula it follows ("od / 2"), if it follows one. */
    expr?: string;
    /** It may follow a formula: called with the one typed, or null for a plain number, before `put`. */
    putExpr?(expr: string | null): void;
  };
  /** Takes the subject away (the pick let go). */
  lets?: boolean;
  /** In its place, with nothing for what is picked now: dimmed, and a tap says this. */
  off?: string;
  /** Not made yet: dimmed, tagged "soon", and a tap does nothing. */
  soon?: boolean;
  /** A tool with kinds that starts as it was used last on a tap (a sketch's Rectangle); its kinds on a second tap or a held press. */
  first?: boolean;
}

/** A word as the sweep sees it. */
export interface SweepWord {
  key: string;
  kind: string;
  label: string;
  cap?: string;
  on?: boolean;
  run?: () => void;
  kids?: SweepWord[];
  value?: { now: number; kind: string; put(v: number): void; min?: number; max?: number };
}

interface Built {
  subject: Word;
  words: Word[];
  /** Everything there is for this pick, by what it is for (the sheet over the line). */
  groups: { cap: string; words: Word[] }[];
  done?: { label: string; run: () => void; pulse?: boolean };
  cancel?: { label: string; run: () => void };
  /** A sketch's way out (its own tick: the sentence there is the whole drawing). */
  exit?: { label: string; run: () => void; pulse?: boolean };
  /** After the subject, in its tag: what of it is being worked on (a sketch's picked line, its drawing tool). */
  title?: Word;
  /** After the subject, in its tag: the + that makes each tap add to the pick. */
  more?: Word;
  /** After those: other things to pick from here (a face or an edge picked: its whole body). */
  also?: Word[];
  /** The line holds groups, each in its place (not a tool's options): when they do not all fit, they close up to fit - a row of small buttons, never slid. */
  grouped?: boolean;
  /** Whose sentence it is: a new subject brings every word in afresh. */
  about: string;
  /** Tools this pick has no use for, each with what it needs instead (said under everything it does offer). */
  others?: string[];
}

const calm = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
/** A tick under the finger (phones that have it). */
const buzz = (ms: number | number[] = 5) => {
  try {
    navigator.vibrate?.(ms);
  } catch {
    // (not allowed here: nothing lost)
  }
};
const notSep = (it: ToolItem) => !it.id.startsWith('---');
/** In a sketch: the tools that act where the view is tapped. With a curve picked they start on it, at the place it was picked (no second tap). */
const SK_RETAP = new Set(['trim', 'extend', 'split', 'offset', 'fillet']);
/** And of those, the ones done at that tap (nothing more to set): picking is on again after it. */
const SK_ONCE = new Set(['trim', 'split']);
/** The model's groups, in the order they are on the line (the tool wheel's own, each always in its place). */
const GROUPS = ['create', 'combine', 'modify', 'construct', 'transform', 'freeform', 'sketch'];
/** A sketch's groups (as its wheel has them): what each holds, most used first; anything else is under More. */
const SK_GROUPS: { id: string; label: string; icon: IconName; tools: string[] }[] = [
  { id: 'draw', label: 'Draw', icon: 'line', tools: ['line', 'rect', 'circle', 'arc', 'spline', 'polygon', 'ellipse', 'text', 'project', 'fill'] },
  { id: 'modify', label: 'Modify', icon: 'trim', tools: ['trim', 'fillet', 'offset', 'extend', 'split', 'align'] },
  { id: 'transform', label: 'Transform', icon: 'transform', tools: ['move', 'mirror', 'rotate', 'pattern', 'scale'] }
];

export class Sentence {
  private readonly root = el('div', '');
  private readonly sheet = el('div', 'sn-sheet');
  /** What the sentence is about (the pick, the tool at work): a tag over the line's start, so the line itself keeps all its room for what is offered. */
  private readonly tag = el('div', 'sn-tag');
  private readonly line = el('div', 'sn-line');
  private readonly row = el('div', 'sn-row');
  private readonly end = el('div', 'sn-end');
  /** More of the line to the left, to the right: a button each (a mouse has no finger to slide it with). */
  private readonly back = el('button', 'sn-edge sn-edge-back');
  private readonly fore = el('button', 'sn-edge sn-edge-fore');
  private readonly thread = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  private readonly threadPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  private readonly threadDot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  private queued = false;
  private built: Built | null = null;
  /** What the sheet shows: every word for the pick, one word's kinds, or a number being typed. */
  private open: { kind: 'all' } | { kind: 'kids'; key: string } | { kind: 'type'; key: string } | null = null;
  private typing: { end(keep: boolean): void } | null = null;
  private about = '';
  /** The thread's ends as last drawn (drawn again only when one moved). */
  private threadSig = '';
  private anchor: Vec3 | null = null;
  /** Where the view is on the page (measured again only when the page is laid out anew). */
  private viewAt: { left: number; top: number } | null = null;
  /** What was picked when the tool now running was started: the sentence still starts with it. */
  private lastPick = '';

  constructor(private readonly host: SentenceHost) {
    this.root.id = 'sentence';
    this.root.hidden = true;
    this.back.innerHTML = this.fore.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 5l7 7-7 7"/></svg>';
    this.back.title = 'Earlier in the line';
    this.fore.title = 'More of the line';
    this.line.append(this.back, this.row, this.fore, this.end);
    const slide = (by: number) => this.row.scrollBy({ left: by * Math.max(160, this.row.clientWidth * 0.7), behavior: calm() ? 'auto' : 'smooth' });
    this.back.addEventListener('click', () => slide(-1));
    this.fore.addEventListener('click', () => slide(1));
    // A mouse's wheel slides the line (it has only up and down to give).
    this.row.addEventListener(
      'wheel',
      (e) => {
        if (this.row.classList.contains('sn-wrap') || this.row.scrollWidth <= this.row.clientWidth + 1) {
          return;
        }
        e.preventDefault();
        this.row.scrollLeft += Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
        this.edges();
      },
      { passive: false }
    );
    this.root.append(this.sheet, this.tag, this.line);
    this.sheet.hidden = true;
    this.thread.id = 'sentence-thread';
    this.thread.setAttribute('aria-hidden', 'true');
    this.threadDot.setAttribute('r', '3.5');
    this.thread.append(this.threadPath, this.threadDot);
    document.body.append(this.thread, this.root);
    // (Never through to the model: a press on the line is the line's.)
    for (const type of ['pointerdown', 'pointerup', 'click', 'dblclick', 'wheel', 'contextmenu'] as const) {
      this.root.addEventListener(type, e => e.stopPropagation());
    }
    this.root.addEventListener('contextmenu', e => e.preventDefault());
    // A press anywhere else puts the sheet away (and is whatever it is there) - but not one on the view that turns,
    // moves or zooms it: a list opened from the line (Transform > Pattern > ...) stays up while the model is looked
    // at from another side, until something in it is chosen or the model is tapped.
    let viewPress: { id: number; x: number; y: number; moved: boolean } | null = null;
    document.addEventListener(
      'pointerdown',
      (e) => {
        if (!this.open || this.root.contains(e.target as Node) || (e.target as HTMLElement).closest?.('.numpad')) {
          return;
        }
        if (e.target === this.host.view.canvas && this.open.kind !== 'type') {
          // (A second finger down: a pinch - never a tap.)
          viewPress = viewPress ? { ...viewPress, moved: true } : { id: e.pointerId, x: e.clientX, y: e.clientY, moved: false };

          return;
        }
        this.typing?.end(true);
        this.close();
      },
      true
    );
    document.addEventListener(
      'pointermove',
      (e) => {
        if (viewPress && !viewPress.moved && e.pointerId === viewPress.id && Math.hypot(e.clientX - viewPress.x, e.clientY - viewPress.y) > (e.pointerType === 'touch' ? 10 : 4)) {
          viewPress.moved = true;
        }
      },
      true
    );
    const lifted = (e: PointerEvent) => {
      const p = viewPress;
      if (!p || e.pointerId !== p.id) {
        return;
      }
      viewPress = null;
      // (A tap on the model: it picks, or lets go - the list was for what was picked before.)
      if (!p.moved && e.type === 'pointerup' && e.button !== 2) {
        this.close();
      }
    };
    document.addEventListener('pointerup', lifted, true);
    document.addEventListener('pointercancel', lifted, true);
    // Esc puts the sheet away first (then it is the tool's, as ever).
    document.addEventListener(
      'keydown',
      (e) => {
        if (e.key !== 'Escape' || !this.open || this.typing) {
          return;
        }
        e.stopPropagation();
        e.preventDefault();
        this.close();
      },
      true
    );
    // The column, the bar or the tool's window changed: the sentence is said again.
    const ui = host.ui;
    const tools = ui.onTools;
    ui.onTools = () => (tools?.(), this.changed());
    const panel = ui.onPanel;
    ui.onPanel = () => (panel?.(), this.changed());
    settings.onChange(() => this.sync());
    // (How tall the line is now - a tool's sentence can run to a second line: undo and the guide text on a phone sit just over it.)
    const tall = new ResizeObserver(() => this.measure());
    tall.observe(this.line);
    tall.observe(this.tag);
    // (How much of the screen an open list takes over the line: on a phone undo, the tag and the guide text move up over it.)
    new ResizeObserver(() => this.lift()).observe(this.sheet);
    host.view.frameHooks.add(() => this.drawThread());
    // (The line slid along: the thread still starts at its subject, or at the line's near end once that is out of sight.)
    this.row.addEventListener('scroll', () => ((this.threadSig = ''), this.drawThread(), this.edges()), { passive: true });
    new ResizeObserver(() => this.edges()).observe(this.row);
    // (Items or History opened or closed: the room for the line changed.)
    new MutationObserver(() => this.place()).observe(document.body, { attributes: true, attributeFilter: ['class'] });
    // (And the kind of screen: a phone's line is laid out by the stylesheet.)
    new MutationObserver(() => this.place()).observe(document.documentElement, { attributes: true, attributeFilter: ['data-screen'] });
    addEventListener('resize', () => {
      this.changed();
      this.place();
      this.viewAt = null;
      if (this.on) {
        ((this.threadSig = ''), this.drawThread());
      }
    });
    this.sync();
  }

  get on(): boolean {
    return settings.value.sentence;
  }

  /** On or off: off, the line and its thread are away and the page is as it was. */
  private sync(): void {
    const on = this.on;
    document.body.classList.toggle('sentence-ui', on);
    if (this.root.hidden === !on) {
      return void (on && this.changed());
    }
    this.root.hidden = !on;
    if (!on) {
      this.typing?.end(false);
      this.open = null;
      this.sheet.hidden = true;
      this.thread.classList.remove('on');
      this.threadSig = '';
      document.body.classList.remove('sn-open');

      return;
    }
    this.changed();
  }

  /**
   * Where the line goes on a wide screen: in the middle of the room between
   * undo (which steps aside for Items) and History when that is open, never
   * over either. (A phone's line has the whole bottom edge: the stylesheet's.)
   */
  private placed = '';
  /** How wide the line was with its groups at full size, when it last did not fit. */
  private natural = 0;
  /** The room and the words it was closed up for (see `edges`). */
  private closedAt = '';
  private place(): void {
    if (!this.on) {
      return;
    }
    let to = '';
    // (A phone held upright: the stylesheet's - the whole bottom edge.)
    const upright = document.documentElement.dataset.screen === 'phone' && matchMedia('(max-width: 720px) and (orientation: portrait)').matches;
    if (!upright) {
      const dock = document.getElementById('undo-dock')?.getBoundingClientRect();
      // (History only where it comes down as far as the line: it is as tall as its steps now, and on a tablet never that far.)
      const histAll = document.body.classList.contains('history-open') ? document.getElementById('history')?.getBoundingClientRect() : undefined;
      const hist = histAll && histAll.bottom > innerHeight - (62 + (this.tag.hidden ? 0 : 44) + 8) ? histAll : undefined;
      // (The right column, where it comes down as far as the line - a phone on its side.)
      const col = document.getElementById('right-col')?.getBoundingClientRect();
      const low = col && col.width && col.bottom > innerHeight - (62 + (this.tag.hidden ? 0 : 44) + 18) ? innerWidth - col.left + 8 : 0;
      const left = Math.round((dock && dock.width ? dock.right : 0) + 10);
      let right = Math.round(Math.max(low, hist && hist.width && hist.left > innerWidth / 2 ? innerWidth - hist.left + 10 : left > 140 || low ? 12 : left));
      // (Items and History both open on a small screen leave no room to speak of: the line then runs over History's last
      // rows rather than shrink to buttons too small for a finger.)
      if (innerWidth - left - right < 400) {
        right = Math.max(low, 12);
      }
      to = `${left}|${right}|${innerWidth}`;
    }
    if (to === this.placed) {
      return;
    }
    this.placed = to;
    const [l, r] = to.split('|');
    this.root.style.left = to ? `${l}px` : '';
    this.root.style.right = to ? `${r}px` : '';
    // (No wider than that room: past it the line slides. All of that room, though: it stopped at 980 on a wide
    // screen, and a sketch's picked line had to be slid to reach its last buttons.)
    this.root.style.maxWidth = to ? `${Math.max(200, innerWidth - Number(l) - Number(r))}px` : '';
    this.threadSig = '';
  }

  /** Something it shows changed: drawn again once, after whatever else changes with it. */
  changed(): void {
    if (!this.on || this.queued) {
      return;
    }
    this.queued = true;
    queueMicrotask(() => {
      this.queued = false;
      if (this.on) {
        this.render();
      }
    });
  }

  // ------------------------------------------------------------ what it says

  private build(): Built {
    const { ui } = this.host;
    const mode = this.host.mode();
    const { column, bar } = ui.shown();
    const panel = ui.panelContent();
    if (mode === 'sketch') {
      return this.sketch(column, bar, panel);
    }
    if (mode === 'model' && !panel) {
      return this.model(column, bar);
    }

    return this.tool(column, panel, mode);
  }

  /** A tool or action as a word (its kinds, the words it opens). */
  private verb(it: ToolItem, pre = 'v'): Word {
    const kids = (it.children ?? []).filter(notSep).map(c => this.verb(c, `${pre}-${it.id}`));
    const v = it.value;

    return {
      key: `${pre}-${it.id}`,
      kind: v ? 'value' : 'verb',
      label: it.short ?? it.label,
      icon: it.swatch ? undefined : it.icon,
      swatch: it.swatch,
      on: it.active,
      pulse: it.pulse,
      kbd: it.shortcut,
      run: it.run && !it.soon ? () => it.run!() : undefined,
      kids: kids.length ? kids : undefined,
      soon: it.soon,
      peek: it.peek,
      first: !!it.variantsWhenActive && !!it.run,
      value: v ? { now: Number(v.now) || 0, text: v.now, kind: v.int ? 'int' : 'number', put: n => v.put(n), min: v.min, max: v.max } : undefined
    };
  }

  /** A group on the line: its tools a tap away, or - with nothing in it for this pick - dimmed in its place, saying why. */
  private group(id: string, label: string, icon: IconName, words: Word[], why: string, rest: Word[] = []): Word {
    // (Sketch with nothing picked is the tool itself: a tap starts it.)
    if (words.length === 1 && !rest.length && words[0].label === label && !words[0].kids) {
      return { ...words[0], key: `g-${id}` };
    }
    // (Nothing in it for the pick: its other tools are the list.)
    const kids = words.length ? words : rest;

    return { key: `g-${id}`, kind: 'verb', label, icon, kids: kids.length ? kids : undefined, rest: words.length && rest.length ? rest : undefined, pulse: words.some(w => w.pulse), off: kids.length ? undefined : why };
  }

  /**
   * The model: what is picked, then the eight groups the tool wheel has, each
   * in its place - Create, Combine, Modify, Construct, Transform, Freeform,
   * Sketch, More - holding what the pick offers (with nothing picked: only
   * what makes something new, and the view's tools under More).
   */
  private model(column: ToolItem[], bar: ToolItem[]): Built {
    const sel = this.host.selection();
    const main = this.host.mainTools();
    let items = usable(column).filter(notSep);
    const view = usable(bar).filter(notSep);
    const by = new Map<string, ToolItem[]>();
    const put = (g: string, it: ToolItem) => by.set(g, [...(by.get(g) ?? []), it]);
    const rank = (it: ToolItem) => {
      const k = RANK.indexOf(ALIAS[it.id] ?? it.id);

      return k < 0 ? RANK.length : k;
    };
    let subject: Word;
    let name = '';
    let others: string[] | undefined;
    if (!sel.length) {
      // Nothing picked: every main tool that can be started now (one that needs a pick asks for it as it starts).
      // (A group is dimmed only when nothing in it can be used - asked for: Create, Combine and Transform were
      // dimmed with nothing picked though their tools start and then say what to tap.)
      for (const g of items) {
        for (const it of g.children?.length ? g.children.filter(notSep) : [g]) {
          put(g.id, it);
        }
      }
      // (A tool waiting for its pick: said over the line, with an x to let it go - the guide text says what to tap.)
      const waits = this.host.waiting();
      subject = waits ? { key: 's-wait', kind: 'subject', label: `${waits.replace(/ \(.*\)$/, '')}: tap the model`, lets: true, on: true, run: () => this.host.stopWaiting() } : { key: 's-make', kind: 'subject', label: 'Make', quiet: true };
    } else {
      const des = items.find(it => it.id === 'deselect');
      items = items.filter(it => it !== des);
      name = des?.sub ?? `${sel.length} picked`;
      // Each of its tools with the main tools of its kind (as the wheel has them); its own (Delete, Color) under More.
      const where = new Map<string, string>();
      const walk = (its: ToolItem[], g: string) => {
        for (const it of its) {
          if (!where.has(it.id)) {
            where.set(it.id, g);
          }
          walk(it.children ?? [], g);
        }
      };
      for (const g of main) {
        walk([g], g.id);
      }
      for (const it of items) {
        put(GROUP_OF[it.id] ?? where.get(ALIAS[it.id] ?? it.id) ?? 'own', it);
      }
      subject = { key: 's-pick', kind: 'subject', label: name, lets: true, run: () => des?.run?.() };
      // What it has no use for, and what those need instead: said, never offered.
      others = [];
      const whys = (its: ToolItem[]) => {
        for (const it of its) {
          if (it.disabled && it.why && it.label) {
            others!.push(`${it.label}: ${it.why.charAt(0).toLowerCase()}${it.why.slice(1)}`);
          } else if (!it.disabled) {
            whys(it.children ?? []);
          }
        }
      };
      whys(column);
    }
    const why = sel.length ? `Nothing here for ${name}. Pick something else, or let go of it.` : 'Pick something on the model first.';
    const words: Word[] = [];
    const groups: Built['groups'] = [];
    for (const id of GROUPS) {
      const g = main.find(m => m.id === id);
      const mine = [...(by.get(id) ?? [])].sort((x, y) => rank(x) - rank(y));
      const its = mine.map(it => this.verb(it));
      // Something picked: every other tool of the group is there too, under the pick's own (asked for: "it shows only
      // a certain suite of tools. I want to show all available tools") - one that cannot use this pick asks for its
      // own as it starts. (Not one the pick has under a longer name: Pattern, with Pattern - Linear there.)
      const have = new Set(mine.flatMap(it => [it.id, ALIAS[it.id] ?? it.id, it.label]));
      const rest = sel.length ? usable(g?.children ?? []).filter(notSep).filter(it => !have.has(it.id) && !have.has(it.label) && !mine.some(m => m.label.startsWith(it.label))).map(it => this.verb(it, 'r')) : [];
      words.push(this.group(id, g?.label ?? id, g?.icon ?? 'more', its, why, rest));
      if (its.length) {
        groups.push({ cap: g?.label ?? id, words: its });
      }
    }
    // More: the pick's own (Delete, Color), what is brought in, and the view's tools.
    const more = [...(by.get('own') ?? []), ...(by.get('more') ?? []), ...view].map(it => this.verb(it));
    // (Not a word on the line: the button at its end, with everything at once, is where More is.)
    if (more.length) {
      groups.push({ cap: sel.length ? name : 'More', words: more });
    }
    // (On the line from More to Create - the wheel's order the other way round, as asked for.)
    words.reverse();
    groups.reverse();
    // (No + to add with: every tap adds, and a tap on a picked one lets it go.)
    const plus: Word | undefined = undefined;
    // One face, edge or corner picked: its whole body is a tap away (a double tap on the model does it too - which
    // nothing said).
    const part = sel.length === 1 && sel[0].kind !== 'body' && 'body' in sel[0] ? sel[0].body : null;
    const also: Word[] | undefined = part ? [{ key: 's-body', kind: 'button', label: 'Whole body', icon: 'body' as IconName, run: () => this.host.pick([{ kind: 'body', body: part }]) }] : undefined;

    return { subject, words, groups, others, more: plus, also, grouped: true, about: sel.length ? `pick:${sel.map(x => JSON.stringify(x)).join()}` : subject.key === 's-wait' ? `wait:${subject.label}` : 'make' };
  }

  /** A sketch: what draws something new - and, with curves picked, what can be done with them. */
  private sketch(column: ToolItem[], bar: ToolItem[], panel: ReturnType<UI['panelContent']>): Built {
    const picked = this.host.sketchPicked();
    const items = usable(column).filter(notSep);
    const exit = items.find(it => it.id === 'exit');
    const select = items.find(it => it.id === 'select');
    const tools = items.filter(it => it !== exit && it !== select);
    const drawing = tools.some(it => it.active);
    const at = tools.find(it => it.active);
    const retapped = (it: ToolItem): Word => {
      const w = this.verb(it);
      // (It acts where the view is tapped. A curve picked: on that piece, where it was picked - and one done at that
      // tap leaves picking on. Nothing picked: it is on, and the next tap is its.)
      if (picked > 0 && SK_RETAP.has(it.id) && it.run) {
        const start = (run: () => void) => () => {
          run();
          this.host.retap();
          if (SK_ONCE.has(it.id)) {
            select?.run?.();
          }
        };
        w.run = start(w.run!);
        for (const k of w.kids ?? []) {
          if (k.run) {
            k.run = start(k.run);
          }
        }
      }

      return w;
    };
    const words: Word[] = [];
    const groups: Built['groups'] = [];
    // A tool is on: Select puts it down (the way back to picking).
    if (drawing && select && !select.active) {
      words.push({ ...this.verb(select), label: 'Stop' });
    }
    // The ways the tool that is on can be used (Circle: Center, 2 Points, 3 Points), right on the line: the one in
    // use lit, another a tap away - not back through Draw > Circle. (More than three, or a line too narrow to give
    // each a finger's width - a phone held upright: one word, named for the one in use, that opens them.)
    const ways = (at?.children ?? []).filter(notSep).map(c => this.verb(c, 'k'));
    const tight = (5 + ways.length) * 44 + 124 > window.innerWidth;
    if (ways.length > 3 || (ways.length > 1 && tight)) {
      words.push({ key: 'k-ways', kind: 'choice', cap: at!.label, label: ways.find(w => w.on)?.label ?? ways[0].label, icon: at!.icon, on: true, kids: ways });
    } else if (ways.length > 1) {
      words.push(...ways);
    }
    const mine = panel ? this.said(panel) : [];
    words.push(...mine);
    // (Said once: the window's own Delete, not the column's too.)
    const said = new Set(mine.map(w => w.label));
    if (tools.length) {
      // (None while its plane is still being chosen: there is nothing to draw on yet.)
      // Its groups, each in its place: Draw, Modify, Transform - all its tools, whatever is picked (each can be started
      // now: with nothing picked it asks for its curve as it starts).
      const offered = (it: ToolItem) => !said.has(it.label);
      const placed = new Set<ToolItem>();
      for (const g of SK_GROUPS) {
        const its = g.tools.map(id => tools.find(it => it.id === id)).filter((it): it is ToolItem => !!it && offered(it));
        for (const it of its) {
          placed.add(it);
        }
        const w = its.map(retapped);
        const word = this.group(g.id, g.label, g.icon, w, 'Pick a line or a shape of the sketch first.');
        // Draw opened with no tool on: Line is on, its list open as ever - a tap on the grid draws at once, a tap
        // in the list takes another (asked for: "when I click draw, line should be automatically selected (but
        // the window with different line types should open normally) so I can start drawing right away").
        if (g.id === 'draw' && !drawing && picked === 0) {
          const line = w.find(x => x.key.endsWith('line') || x.label === 'Line');
          if (line?.run) {
            word.opens = line.run;
          }
        }
        words.push(word);
        if (w.length) {
          groups.push({ cap: g.label, words: w });
        }
      }
      // (Delete: a tap - the curves picked, else the tool that deletes what is tapped; unless their window has it already.)
      const del = tools.find(it => it.id === 'delete');
      if (del && offered(del)) {
        words.push(this.verb(del));
      }
      if (del) {
        placed.add(del);
      }
      const rest = [...tools.filter(it => !placed.has(it) && offered(it)), ...usable(bar).filter(notSep)].map(it => this.verb(it));
      // (Not a word on the line: the button at its end is where More is.)
      if (rest.length) {
        groups.push({ cap: 'More', words: rest });
      }
    }

    return {
      subject: { key: 's-sketch', kind: 'subject', label: 'Sketch', icon: 'sketch', quiet: true },
      words,
      groups,
      done: panel?.done ? { label: 'Done', run: panel.done } : undefined,
      cancel: panel?.cancel ? { label: 'Cancel', run: panel.cancel } : undefined,
      exit: exit?.run ? { label: 'Exit Sketch', run: () => exit.run!(), pulse: exit.pulse } : undefined,
      // (What of the sketch is being worked on: the curves picked, else the tool that is on - "Sketch > Line".)
      title: panel && mine.length ? { key: 't-title', kind: 'subject', label: panel.title, quiet: true, on: true } : at ? { key: 't-title', kind: 'subject', label: at.label, quiet: true, on: true } : undefined,
      grouped: !mine.length,
      about: `sketch:${picked > 0 ? 'picked' : drawing ? 'draw' : 'idle'}`
    };
  }

  /** A tool at work: its name, then its window's parts as the rest of the sentence. */
  private tool(column: ToolItem[], panel: ReturnType<UI['panelContent']>, mode: string): Built {
    const items = usable(column).filter(notSep);
    const out = items.find(it => it.id === 'cancel') ?? items.find(it => it.id === 'exit');
    const rest = items.filter(it => it !== out && it.id !== 'deselect').map(it => this.verb(it, 'c'));
    // (Its window says it all; a tool with none - Measure, Section View - has its own buttons.)
    let words = panel ? this.said(panel) : mode === 'model' ? [] : rest;
    // A phone held upright: a tool says its size (the number that is dragged) and what it still needs tapped; the
    // rest - how it ends, which side, draft, what it does to the bodies it meets - is one word, Options, a tap away.
    // (Extrude's first line was seven things; Fillet put three choices before its radius. They ran to two rows, and
    // a first-timer read every one.) Anything in Options changed from here is still said on the model as before.
    // (Not Freeform: its line is what is done to the points picked - Extrude face, Inset, Delete - and all three of
    // ΔX, ΔY, ΔZ; folded, its tools were a tap further away than the values.)
    if (panel && !/^Freeform/.test(panel.title) && document.documentElement.dataset.screen === 'phone' && matchMedia('(max-width: 720px) and (orientation: portrait)').matches) {
      let sizes = 0;
      const main = (w: Word) => (w.kind === 'value' && sizes++ < 2) || w.kind === 'slot' || w.blank || (w.kind === 'button' && /^(Apply|Add|Flip)/.test(w.label));
      const keep = words.filter(main);
      const fold = words.filter(w => !keep.includes(w));
      if (keep.length && fold.length > 1) {
        words = [...keep, { key: 't-options', kind: 'verb', label: 'Options', icon: 'settings', kids: fold }];
      }
    }
    const title = panel?.title ?? (out?.label.startsWith('Exit ') ? out.label.slice(5) : (items.find(it => it.active)?.label ?? out?.label ?? 'Tool'));
    const cancel = panel?.cancel ?? (out?.run ? () => out.run!() : undefined);
    const name = panel?.cancel ? 'Cancel' : (out?.label ?? 'Cancel');

    return {
      subject: { key: 's-tool', kind: 'subject', label: title, on: true, quiet: true },
      // (Its own name is said once.)
      words: words.filter(w => !(w.label === title && w.on && !w.kids)),
      groups: [],
      done: panel?.done ? { label: 'Done', run: panel.done } : undefined,
      // (A way out named Done beside the tick would be the tick twice.)
      cancel: cancel && !(panel?.done && name === 'Done') ? { label: name, run: cancel } : undefined,
      about: `tool:${title}`
    };
  }

  /** A tool's window as words: blanks, words to swap, switches, numbers, things to tap. */
  private said(p: NonNullable<ReturnType<UI['panelContent']>>): Word[] {
    const ui = this.host.ui;
    const out: Word[] = [];
    let k = 0;
    for (const it of p.items) {
      const key = `p-${it.type}-${'label' in it && it.label ? it.label : k}`;
      k++;
      // (Not filled: a blank - what to tap for it is the guide text's to say. Filled: what it holds.)
      if (it.type === 'slot') {
        out.push({ key, kind: 'slot', cap: it.label, label: it.filled ? it.value : '', blank: it.active, on: it.filled, run: () => it.onClick() });
      } else if (it.type === 'choice') {
        if (!it.options.length) {
          continue;
        }
        const now = it.options.find(o => o.id === it.value);
        const kids = it.options.map((o): Word => ({ key: `${key}-${o.id}`, kind: 'verb', label: o.label, on: o.id === it.value, run: () => it.onChange(o.id) }));
        // (One thing to do and no name - a slot's Clear: a tap.)
        if (it.options.length === 1 && !it.label) {
          out.push({ key, kind: 'button', label: it.options[0].label, run: kids[0].run });
        } else {
          out.push({ key, kind: 'choice', cap: it.label, label: now?.label ?? it.options.map(o => o.label).slice(0, 3).join(' · '), kids });
        }
      } else if (it.type === 'toggle') {
        out.push({ key, kind: 'toggle', label: it.label, on: it.value, run: () => it.onChange(!it.value) });
      } else if (it.type === 'number' || it.type === 'slider') {
        const kind = it.type === 'slider' || it.kind === 'number' ? 'number' : (it.kind ?? 'length');
        const len = kind === 'length';
        const text = it.type === 'slider' ? (it.show?.(it.value) ?? String(+it.value.toFixed(2))) : len ? `${+toDisplay(it.value).toFixed(3)} ${UNIT_LABEL[units()]}` : kind === 'angle' ? `${+it.value.toFixed(2)}°` : String(+it.value.toFixed(3));
        const put = (to: number) => {
          let v = to;
          // (A slider's value goes in its own steps - Steps and Faces are whole numbers, typed 3.4 or dragged part way.)
          if (it.type === 'slider') {
            v = Math.min(it.max, Math.max(it.min, it.step ? +(Math.round(v / it.step) * it.step).toFixed(6) : v));
          } else if (it.min !== undefined) {
            v = Math.max(it.min, v);
          }
          if (kind === 'int') {
            v = Math.round(v);
          }
          it.onInput(v);
          // (A tool that does not draw its window again keeps this part: it holds the new value from now on.)
          it.value = v;
          ui.syncPanelValue(it, v);
          this.changed();
        };
        // A size that follows a variable says so: the formula, then what it comes to ("od / 2 = 60 mm").
        const expr = it.type === 'number' ? it.expr : undefined;
        // (Kept on the part too: a tool that does not draw its window again still shows what the size follows now.)
        const putExpr = it.type === 'number' && it.onExpr ? (e: string | null) => (it.onExpr!(e), (it.expr = e ?? undefined)) : undefined;
        const says = expr ? `${expr.length > 16 ? `${expr.slice(0, 15)}…` : expr} = ${text}` : text;
        out.push({ key, kind: 'value', cap: it.label, label: says, value: { now: it.value, text, kind, put, min: it.type === 'slider' ? it.min : it.min, max: it.type === 'slider' ? it.max : undefined, step: it.type === 'slider' ? it.step : undefined, expr, putExpr } });
      } else if (it.type === 'button') {
        out.push({ key, kind: 'button', label: it.label, icon: it.icon ?? iconNameFor(it.label), pulse: it.primary, run: () => it.onClick() });
      } else if (it.type === 'chips') {
        if (!it.chips.length) {
          continue;
        }
        const kids = it.chips.map((c, i): Word => ({ key: `${key}-${i}`, kind: 'toggle', label: c.glyph ? `${c.glyph} ${c.label}` : c.label, on: !!c.on, run: () => c.onClick() }));
        if (kids.length <= 2) {
          out.push(...kids);
        } else {
          out.push({ key, kind: 'choice', label: it.label ?? 'Add', kids });
        }
      }
    }
    for (const a of usable(p.actions).filter(notSep)) {
      out.push(this.verb(a, 'a'));
    }

    return out;
  }

  // ------------------------------------------------------------------ drawing

  /** A list kept open through the next change of sentence (opening it started a tool). */
  private stays = '';

  private render(): void {
    const b = (this.built = this.build());
    const fresh = b.about !== this.about;
    this.about = b.about;
    // The pick, then its tool: the sentence goes on from the word it started with.
    if (b.about.startsWith('pick:')) {
      this.lastPick = b.subject.label;
    } else if (!b.about.startsWith('tool:')) {
      this.lastPick = '';
    }
    const lead: Word[] = b.about.startsWith('tool:') && this.lastPick ? [{ key: 's-was', kind: 'subject', label: this.lastPick, quiet: true }] : [];
    // (Another sentence: whatever was open belonged to the last one.)
    if (fresh && this.open && !(this.open.kind === 'kids' && this.open.key === this.stays)) {
      this.typing?.end(false);
      this.open = null;
    }
    if (fresh) {
      this.stays = '';
    }
    // (Nothing picked: no subject - the groups say it all.)
    const about = [...lead, ...(b.subject.key === 's-make' ? [] : [b.subject]), ...(b.more ? [b.more] : []), ...(b.also ?? []), ...(b.title ? [b.title] : [])];
    this.fill(this.tag, about, fresh);
    this.tag.hidden = !about.length;
    this.fill(this.row, b.words, fresh);
    this.row.classList.toggle('sn-groups', !!b.grouped);
    // (A tool's sentence is read whole: it runs on to the next line, as writing does. What a pick offers is one line to slide along.)
    // (Not on a screen too low for it - a phone on its side: there it is one line to slide along too.)
    this.row.classList.toggle('sn-wrap', b.about.startsWith('tool:') && innerHeight > 480);
    // A phone held upright, in a sketch with a tool's own parts on the line (Line on, a point placed: Stop, Values,
    // Draw, Modify, Transform, Delete): two rows of buttons, each a picture over its name, all in view (asked for:
    // "it's so small and I have to scroll right in a box that is only a button wide. Maybe you can make that option
    // window 2 buttons tall?"). It was one row to slide, a button and a half wide beside More and Exit.
    const upright = document.documentElement.dataset.screen === 'phone' && matchMedia('(max-width: 720px) and (orientation: portrait)').matches;
    this.line.classList.toggle('sn-two', upright && b.about.startsWith('sketch:') && !b.grouped);
    if (fresh) {
      this.row.scrollLeft = 0;
    }
    // The end of the line: everything for this pick, the eraser, the tick.
    this.end.replaceChildren();
    if (this.beyond(b).length) {
      const all = this.endButton('grid', 'More', () => this.toggle({ kind: 'all' }));
      all.classList.add('sn-all');
      all.append(el('span', 'sn-end-name', 'More'));
      all.classList.toggle('on', this.open?.kind === 'all');
      this.end.append(all);
    }
    if (b.cancel) {
      this.end.append(this.endButton('close', b.cancel.label, () => (buzz(), b.cancel!.run())));
    }
    if (b.done) {
      const ok = this.endButton('check', b.done.label, () => this.finish(b.done!.run));
      ok.classList.add('sn-done');
      this.end.append(ok);
    }
    if (b.exit) {
      const x = this.endButton('exit', b.exit.label, () => this.finish(b.exit!.run));
      x.classList.add('sn-exit');
      x.classList.toggle('pulse', !!b.exit.pulse);
      x.append(el('span', 'sn-end-name', 'Exit'));
      this.end.append(x);
    }
    this.drawSheet();
    this.place();
    this.edges();
    this.anchor = b.subject.key === 's-pick' ? this.host.anchor() : null;
    this.threadSig = '';
    this.viewAt = null;
    this.drawThread(fresh);
    // (A blank to fill: it is brought into sight.)
    const blank = this.row.querySelector<HTMLElement>('.sn-word.blank');
    if (fresh) {
      this.line.classList.remove('sn-compact');
    }
    this.edges();
    this.measure();
    if (blank) {
      this.reveal(blank);
    }
  }

  /** How tall the line and its tag are now, for what sits over them on a phone (set only when it changed). */
  private tall = '';
  /** The room an open list takes over the line (none while it is shut): what sits over the line on a phone is lifted by it. */
  private lifted = '';
  private lift(): void {
    const h = this.sheet.hidden ? '0px' : `${Math.max(0, this.line.offsetTop - this.sheet.offsetTop)}px`;
    if (h === this.lifted) {
      return;
    }
    this.lifted = h;
    document.body.style.setProperty('--sn-sheet', h);
  }

  private barTall = '';
  private measure(): void {
    // (A phone held upright has the tag at the line's far end, beside undo: only the line's own height counts there.)
    const beside = document.documentElement.dataset.screen === 'phone' && matchMedia('(max-width: 720px) and (orientation: portrait)').matches;
    const tag = this.tag.hidden || beside ? 0 : this.tag.offsetHeight;
    const h = `${this.line.offsetHeight + (tag ? tag + 6 : 0)}px`;
    // (The line's own height, for undo / redo beside it: the same bar, the same height.)
    const bar = `${this.line.offsetHeight}px`;
    if (bar !== this.barTall) {
      document.body.style.setProperty('--sn-bar', (this.barTall = bar));
    }
    if (h === this.tall) {
      return;
    }
    this.tall = h;
    document.body.style.setProperty('--sn-line', h);
  }

  /** Is there more of the line out of sight, either way? Its end buttons show only then. */
  private edges(): void {
    const r = this.row;
    // Groups that do not all fit close up (a small picture over a small name each, sharing the line evenly) - and open
    // out again once there is room for them as they were.
    // (All of it is decided from the room the line is given - the screen less what is beside it - and what it says,
    // never from how it is drawn now: closing up changes the line's own size, and a choice made from that size can
    // undo itself on the next layout, over and over - on a tablet the line then jumps between the two.)
    const avail = Math.round(document.documentElement.dataset.screen === 'phone' ? this.root.clientWidth : parseFloat(this.root.style.maxWidth) || this.root.clientWidth);
    const says = Array.from(r.children, c => (c as HTMLElement).dataset.key).join(' ');
    if (!r.classList.contains('sn-groups')) {
      (this.line.classList.remove('sn-compact'), (this.closedAt = ''));
    } else if (!this.line.classList.contains('sn-compact')) {
      if (r.scrollWidth > r.clientWidth + 1) {
        this.natural = r.scrollWidth + this.end.offsetWidth + 24;
        this.closedAt = `${avail}|${says}`;
        this.line.classList.add('sn-compact');
      }
    } else if (avail >= this.natural + 8 && this.closedAt !== `${avail}|${says}`) {
      this.line.classList.remove('sn-compact');
    }
    // (Closed up for this room and these words: it stays closed up until one of them changes.)
    // (Closed up with room to spare for each - a tablet, a phone on its side: bigger names than on a phone held upright.)
    // (Reckoned from the line's own width and the end buttons at their bigger size, never from the row as it is now:
    // bigger names widen the end buttons, which narrowed the row, which made the names small again - on a phone
    // 390 wide, in a sketch with a tool on, it flipped on every layout and the line shook.)
    const n = r.childElementCount;
    const room = avail - this.end.childElementCount * 62 - 12;
    this.line.classList.toggle('sn-roomy', this.line.classList.contains('sn-compact') && n > 0 && room / n >= 66);
    const more = !r.classList.contains('sn-wrap') && r.scrollWidth > r.clientWidth + 1;
    // (Both keep their room while there is more either way: one coming or going must not change how much fits.)
    this.line.classList.toggle('sn-more', more);
    this.back.classList.toggle('show', more && r.scrollLeft > 2);
    this.fore.classList.toggle('show', more && r.scrollLeft < r.scrollWidth - r.clientWidth - 2);
  }

  private endButton(icon: IconName, title: string, run: () => void): HTMLButtonElement {
    const b = el('button', 'sn-end-btn');
    b.innerHTML = icons[icon] ?? '';
    b.title = title;
    b.setAttribute('aria-label', title);
    b.addEventListener('click', run);

    return b;
  }

  /** The words in `box`, each kept if it was there (only what is new comes in). */
  private fill(box: HTMLElement, words: Word[], fresh: boolean): void {
    const old = new Map<string, HTMLElement>();
    for (const c of Array.from(box.children) as HTMLElement[]) {
      old.set(c.dataset.key ?? '', c);
    }
    let n = 0;
    let at: Element | null = box.firstElementChild;
    for (const w of words) {
      let d = fresh ? undefined : old.get(w.key);
      const sig = `${w.kind}|${w.label}|${w.cap ?? ''}|${w.on ? 1 : 0}|${w.blank ? 1 : 0}|${w.pulse ? 1 : 0}|${w.kids?.length ?? 0}|${w.swatch ?? ''}|${w.off ? 1 : 0}|${w.soon ? 1 : 0}`;
      if (!d) {
        d = this.wordEl(w);
        if (!calm()) {
          d.classList.add('sn-in');
          d.style.animationDelay = `${Math.min(n++, 14) * 16}ms`;
        }
      } else {
        old.delete(w.key);
        if (d.dataset.sig !== sig) {
          this.paint(d, w);
        }
      }
      d.dataset.sig = sig;
      (d as HTMLElement & { word?: Word }).word = w;
      if (d !== at) {
        box.insertBefore(d, at);
      } else {
        at = at.nextElementSibling;
      }
    }
    for (const d of fresh ? Array.from(box.children).filter(c => !words.some(w => (c as HTMLElement & { word?: Word }).word === w)) : old.values()) {
      d.remove();
    }
  }

  private wordEl(w: Word): HTMLElement {
    const d = el('button', 'sn-word');
    d.dataset.key = w.key;
    this.paint(d, w);
    const word = () => (d as HTMLElement & { word?: Word }).word ?? w;
    // A tap; a number dragged sideways; a press held on a word with kinds opens them.
    let down: { x: number; y: number; t: number; v: number; scrub: boolean; id: number } | null = null;
    let held = 0;
    // The pointer over a tool: what it would do, drawn on the model in dashed yellow, for as long as it is there.
    // (A finger has no hover: on a touch screen the tool's own preview, as it starts, is the picture.)
    d.addEventListener('pointerenter', (e) => {
      if (e.pointerType === 'touch') {
        return;
      }
      const segs = word().peek?.();
      this.host.peek(segs?.length ? segs : null);
    });
    d.addEventListener('pointerleave', () => this.host.peek(null));
    d.addEventListener('pointerdown', (e) => {
      this.host.peek(null);
      const now = word();
      down = { x: e.clientX, y: e.clientY, t: performance.now(), v: now.value?.now ?? 0, scrub: false, id: e.pointerId };
      clearTimeout(held);
      if (now.kids?.length && now.first) {
        held = window.setTimeout(() => ((down = null), buzz(8), this.toggle({ kind: 'kids', key: now.key })), 480);
      }
    });
    d.addEventListener('pointermove', (e) => {
      const now = word();
      if (!down || e.pointerId !== down.id) {
        return;
      }
      const dx = e.clientX - down.x;
      // (Not one that follows a variable: a finger sliding off it would cut it loose. Tapped, it is typed.)
      if (!down.scrub && now.value && !now.value.expr && Math.abs(dx) > 9 && Math.abs(dx) > Math.abs(e.clientY - down.y) * 1.5) {
        down.scrub = true;
        clearTimeout(held);
        d.setPointerCapture(e.pointerId);
        d.classList.add('scrub');
        this.typing?.end(false);
        this.close();
      }
      if (down.scrub && now.value) {
        this.scrub(d, now, down.v, dx);
      } else if (Math.hypot(dx, e.clientY - down.y) > 9) {
        clearTimeout(held);
      }
    });
    const up = (e: PointerEvent) => {
      clearTimeout(held);
      if (down?.scrub) {
        d.classList.remove('scrub');
        try {
          d.releasePointerCapture(e.pointerId);
        } catch {
          // (already let go)
        }
        this.changed();
      }
    };
    d.addEventListener('pointerup', up);
    d.addEventListener('pointercancel', e => (up(e), (down = null)));
    d.addEventListener('click', () => {
      const was = down;
      down = null;
      // (A drag ended on it, or the held press already opened its kinds.)
      if (!was || was.scrub) {
        return;
      }
      this.tap(word(), d);
    });

    return d;
  }

  private paint(d: HTMLElement, w: Word): void {
    d.className = `sn-word sn-${w.kind}${d.classList.contains('sn-in') ? ' sn-in' : ''}`;
    d.classList.toggle('on', !!w.on);
    d.classList.toggle('blank', !!w.blank);
    d.classList.toggle('pulse', !!w.pulse);
    d.classList.toggle('quiet', !!w.quiet);
    d.classList.toggle('capped', !!w.cap);
    d.classList.toggle('off', !!w.off || !!w.soon);
    d.classList.toggle('opened', w.key === this.openTop);
    (d as HTMLButtonElement).disabled = (!!w.quiet && !w.run && !w.kids) || !!w.soon;
    d.replaceChildren();
    if (w.cap) {
      d.append(el('span', 'sn-cap', w.cap));
    }
    const body = el('span', 'sn-body');
    if (w.swatch) {
      const sw = el('span', 'sn-swatch');
      sw.style.background = w.swatch;
      body.append(sw);
    } else if (w.icon && icons[w.icon] && w.kind !== 'value' && w.kind !== 'choice' && w.kind !== 'slot') {
      const ic = el('span', 'sn-icon');
      ic.innerHTML = icons[w.icon];
      body.append(ic);
    }
    body.append(el('span', 'sn-text', w.label));
    if (w.kids?.length && !w.first) {
      body.append(el('span', 'sn-more', '▾'));
    }
    if (w.lets) {
      body.append(el('span', 'sn-x', '×'));
    }
    if (w.soon) {
      body.append(el('span', 'sn-kbd sn-soon', 'soon'));
    }
    if (w.kbd && matchMedia('(hover: hover) and (pointer: fine)').matches) {
      body.append(el('kbd', 'sn-kbd', w.kbd));
    }
    d.append(body);
    d.title = w.key === 's-add' ? 'Pick more: each tap adds to the pick' : w.lets ? 'Let go of it' : w.value ? `${w.cap ?? w.label}: tap to type, drag sideways to change` : (w.cap ?? '');
  }

  /** A word tapped: it opens what it holds, takes a number, or does what it says. */
  private tap(w: Word, d: HTMLElement): void {
    if (w.soon) {
      return;
    }
    if (w.off) {
      return void (buzz(), this.host.ui.toast(w.off));
    }
    if (w.value) {
      return void this.toggle({ kind: 'type', key: w.key });
    }
    // A tool with kinds starts as it was used last; while it is the one in use, a tap shows its kinds.
    if (w.kids?.length && (!w.first || w.on)) {
      const opening = !(this.open?.kind === 'kids' && this.open.key === w.key);
      this.toggle({ kind: 'kids', key: w.key });
      if (opening && w.opens) {
        // (What it does makes another sentence - Line is on: this list stays open through that.)
        this.stays = w.key;
        w.opens();
      }

      return;
    }
    if (!w.run) {
      return;
    }
    buzz();
    const stays = w.kind === 'toggle' || w.kind === 'slot' || d.closest('.sn-sheet') === null;
    if (!stays || this.open?.kind === 'all') {
      this.close();
    }
    w.run();
    this.changed();
  }

  /** A number dragged sideways: so much a step, a tick under the finger at each. */
  private scrub(d: HTMLElement, w: Word, from: number, dx: number): void {
    const v = w.value!;
    // (A length steps in the unit shown; slower past the first stretch would be finer, but a step a few px wide is felt.)
    const unit = v.kind === 'length' ? 1 / toDisplay(1) : 1;
    const px = v.kind === 'int' || (v.step ?? 0) >= 1 ? 14 : 7;
    const steps = Math.trunc(dx / px);
    const size = v.step ? v.step : v.kind === 'int' ? 1 : v.kind === 'angle' ? 1 : v.kind === 'length' ? unit * (Math.abs(toDisplay(from)) >= 100 ? 5 : from !== 0 && Math.abs(toDisplay(from)) < 2 ? 0.1 : 1) : Math.abs(from) >= 20 ? 1 : 0.05;
    let to = from + steps * size;
    if (v.min !== undefined) {
      to = Math.max(v.min, to);
    }
    if (v.max !== undefined) {
      to = Math.min(v.max, to);
    }
    if (to === v.now) {
      return;
    }
    v.now = to;
    buzz(3);
    v.put(to);
    const t = d.querySelector('.sn-text');
    if (t) {
      t.textContent = v.kind === 'length' ? `${+toDisplay(to).toFixed(3)} ${UNIT_LABEL[units()]}` : v.kind === 'angle' ? `${+to.toFixed(2)}°` : String(+to.toFixed(3));
    }
  }

  /** The tick: the sentence is said - it lifts away as it is done. */
  private finish(run: () => void): void {
    buzz([6, 40, 10]);
    this.typing?.end(true);
    this.close();
    if (!calm()) {
      const r = this.row.getBoundingClientRect();
      const ghost = this.row.cloneNode(true) as HTMLElement;
      ghost.className = 'sn-row sn-ghost';
      Object.assign(ghost.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
      ghost.scrollLeft = this.row.scrollLeft;
      document.body.append(ghost);
      ghost.animate([{ opacity: 0.9, transform: 'none' }, { opacity: 0, transform: 'translateY(-46px) scale(0.96)' }], { duration: 380, easing: 'cubic-bezier(.2,.7,.2,1)' }).finished.then(() => ghost.remove(), () => ghost.remove());
      setTimeout(() => ghost.remove(), 600);
    }
    run();
    this.changed();
  }

  // -------------------------------------------------------------- the sheet

  private toggle(to: NonNullable<Sentence['open']>): void {
    const same = this.open && this.open.kind === to.kind && (to.kind === 'all' || (this.open as { key: string }).key === (to as { key: string }).key);
    this.typing?.end(true);
    this.open = same ? null : to;
    buzz();
    this.drawSheet(true);
    this.end.querySelector('.sn-all')?.classList.toggle('on', this.fromMore());
  }

  private close(): void {
    if (!this.open) {
      return;
    }
    this.open = null;
    this.drawSheet();
    this.end.querySelector('.sn-all')?.classList.remove('on');
  }

  /** The word on the line that the open list came from (it, or the one it is under), lit while the list is up. */
  private openTop: string | null = null;

  /** The words from the line down to `key` (Transform, Pattern). */
  /**
   * Is what is open More's list, or a list opened from inside it (More > BIM, More > Insert)? More stays lit for
   * those too: a list two or three deep still shows which button it came from (asked for: "if I open a level 3
   * window, the effect stops showing from what button I started"). A list under one of the line's own words has
   * that word lit (see `openTop`); one from More is under no word of the line, and nothing was lit.
   */
  private fromMore(): boolean {
    const o = this.open;
    if (!o) {
      return false;
    }
    if (o.kind === 'all') {
      return true;
    }

    return o.kind === 'kids' && !this.pathTo(o.key).length;
  }

  private pathTo(key: string): Word[] {
    const seek = (ws: Word[]): Word[] | null => {
      for (const w of ws) {
        if (w.key === key) {
          return [w];
        }
        const k = (w.kids && seek(w.kids)) ?? (w.rest && seek(w.rest));
        if (k) {
          return [w, ...k];
        }
      }

      return null;
    };

    return seek(this.built?.words ?? []) ?? [];
  }

  /**
   * What More holds: only what is not on the line already (asked for: "in More there should only be tools that are
   * not already in the bar"). A group that is a word on the line is opened there - More repeated every one of them
   * under the few things that were its own.
   */
  private beyond(b: Built): Built['groups'] {
    const there = new Set(b.words.map(w => w.cap ?? w.label));

    return b.groups.filter(g => !there.has(g.cap));
  }

  /** The thread from the pick to its name is drawn (off: see `drawThread`). */
  private threads = false;

  private find(key: string): Word | null {
    const b = this.built;
    if (!b) {
      return null;
    }
    const seek = (ws: Word[]): Word | null => {
      for (const w of ws) {
        if (w.key === key) {
          return w;
        }
        const k = (w.kids && seek(w.kids)) ?? (w.rest && seek(w.rest));
        if (k) {
          return k;
        }
      }

      return null;
    };

    return seek([b.subject, ...b.words]) ?? seek(b.groups.flatMap(g => g.words));
  }

  /** Over the line: everything for the pick by what it is for, one word's kinds, or a number's box. */
  private drawSheet(rise = false): void {
    const o = this.open;
    const b = this.built;
    // (Open over the model: the round buttons beside the pick step back for it.)
    document.body.classList.toggle('sn-open', !!o && !!b && this.on);
    const path = o && o.kind !== 'all' ? this.pathTo(o.key) : [];
    const top = path[0]?.key ?? null;
    if (top !== this.openTop) {
      this.openTop = top;
      for (const d of Array.from(this.row.querySelectorAll<HTMLElement>('.sn-word'))) {
        d.classList.toggle('opened', !!top && d.dataset.key === top);
      }
    }
    if (!o || !b) {
      this.sheet.hidden = true;
      this.sheet.replaceChildren();
      document.body.classList.remove('sn-crowd');
      this.lift();

      return;
    }
    if (o.kind === 'type') {
      if (this.typing) {
        return;
      }
      const w = this.find(o.key);
      if (!w?.value) {
        return void this.close();
      }
      this.sheet.hidden = false;
      this.sheet.className = 'sn-sheet sn-typing';
      this.sheet.style.width = this.sheet.style.maxWidth = this.sheet.style.alignSelf = '';
      this.sheet.style.marginLeft = '';

      return this.type(w);
    }
    const blocks: { cap: string; words: Word[] }[] = [];
    if (o.kind === 'all') {
      blocks.push(...this.beyond(b));
    } else {
      const w = this.find(o.key);
      if (!w?.kids?.length) {
        return void this.close();
      }
      // (Under another: where it is - "Transform › Pattern".)
      // (From inside More: "More › BIM" - where it is, as a list under a word of the line says.)
      blocks.push({ cap: path.length > 1 ? path.map(x => x.cap ?? x.label).join(' › ') : `${path.length ? '' : 'More › '}${w.cap ?? w.label}`, words: w.kids });
      if (w.rest?.length) {
        blocks.push({ cap: `Other ${(w.cap ?? w.label).toLowerCase()} tools (each asks for its own pick)`, words: w.rest });
      }
    }
    this.sheet.hidden = false;
    // (More is a list like any other on the line: a card over its button, as big as what is in it. It was the whole
    // line's width, for a handful of buttons.)
    this.sheet.className = 'sn-sheet sn-kids';
    const old = Array.from(this.sheet.children) as HTMLElement[];
    const had = old.filter(c => c.classList.contains('sn-group'));
    const same = !rise && had.length === blocks.length && had.every((c, i) => c.dataset.cap === blocks[i].cap);
    if (!same) {
      this.sheet.replaceChildren();
    }
    blocks.forEach((g, i) => {
      let box = same ? had[i] : null;
      if (!box) {
        box = el('div', 'sn-group');
        box.dataset.cap = g.cap;
        box.append(el('div', 'sn-group-cap', g.cap), el('div', 'sn-group-words'));
        this.sheet.append(box);
      }
      this.fill(box.lastElementChild as HTMLElement, g.words, !same);
    });
    this.sheet.querySelector('.sn-others')?.remove();
    this.fit();
    // A phone held upright (the list is as wide as the screen): no taller than leaves the buttons at the right edge
    // clear above it - it scrolls instead.
    this.sheet.style.maxHeight = '';
    const col = document.getElementById('right-col');
    if (col && document.documentElement.dataset.screen === 'phone' && matchMedia('(max-width: 720px) and (orientation: portrait)').matches) {
      const room = this.line.getBoundingClientRect().top - col.getBoundingClientRect().bottom - 16;
      if (col.offsetHeight && room < this.sheet.offsetHeight) {
        this.sheet.style.maxHeight = `${Math.max(150, Math.round(room))}px`;
      }
      // (A screen too short for both - a small phone with a tool's two lines: those buttons step aside while the list is up.)
      document.body.classList.toggle('sn-crowd', !!col.offsetHeight && room < Math.min(150, this.sheet.offsetHeight));
    } else {
      document.body.classList.remove('sn-crowd');
    }
    if (rise && !calm()) {
      this.sheet.animate([{ opacity: 0, transform: 'translateY(10px)' }, { opacity: 1, transform: 'none' }], { duration: 140, easing: 'ease-out' });
    }
    // (One word's kinds: over that word.)
    this.sheet.style.setProperty('--sn-at', '50%');
    {
      const d = o.kind === 'all' ? this.end.querySelector<HTMLElement>('.sn-all') : this.row.querySelector<HTMLElement>(`[data-key="${CSS.escape((o as { key: string }).key)}"]`);
      const lr = this.line.getBoundingClientRect();
      // (The line's own width: with a list standing past its end, the line is as wide as the two together.)
      const room = this.sheet.querySelector('.sn-group-words') && this.lineWidth ? this.lineWidth : lr.width;
      if (d) {
        const r = d.getBoundingClientRect();
        this.sheet.style.setProperty('--sn-at', `${Math.round(Math.min(lr.width - 20, Math.max(20, r.left + r.width / 2 - lr.left)))}px`);
        // Right over its word: its middle on the word's middle, as far as the line's ends allow. (By its own width as
        // drawn - the stylesheet's guess at it left a wide list off to one side. A phone held upright: the stylesheet's.)
        const w = this.sheet.offsetWidth;
        this.sheet.style.marginLeft = getComputedStyle(this.sheet).alignSelf === 'stretch' ? '' : `${Math.round(Math.max(0, Math.min(room - w, r.left + r.width / 2 - lr.left - w / 2)))}px`;
      } else {
        // A list opened from inside another (Construct > Axis): it has no word on the line to stand over - where
        // the one before it stood, as far as its own width allows. (It kept that one's place whatever its width: a
        // wider list then ran off the edge of the screen, its last buttons with it.)
        const w = this.sheet.offsetWidth;
        const was = parseFloat(this.sheet.style.marginLeft) || 0;
        this.sheet.style.marginLeft = `${Math.round(Math.max(0, Math.min(room - w, was)))}px`;
      }
    }
    this.lift();
  }

  /**
   * The open list made the size of what is in it (asked for: "auto adjustable based on how many buttons are in that
   * window. Right now it opens and it has empty space"). Its buttons in even rows - as many across as fit, the rows
   * as near the same length as they come - each as wide as the widest, and a last row that is short has its buttons
   * wider, so no row ends in a gap. The list is then just as wide as its rows. (It was one width for any number of
   * buttons, each row ending where its words happened to.)
   */
  /** The line's own width, as last measured with the list out of the way (0: not measured). */
  private lineWidth = 0;

  private fit(): void {
    const sheet = this.sheet;
    const groups = Array.from(sheet.querySelectorAll<HTMLElement>('.sn-group-words'));
    if (!groups.length) {
      return;
    }
    const phone = document.documentElement.dataset.screen === 'phone';
    // How wide the line is by itself, the list out of the way: left as it comes, the list is as wide as all its
    // buttons in one row, and the box the two share - and the line with it - widened to that. (The line may be as
    // wide as there is room for now: a list opened from More stretched it right across the screen.)
    // (Nor where the list before it stood: a list opened from inside another keeps that place for now, and a wider
    // one there reached past the line's end.)
    const stood = sheet.style.marginLeft;
    sheet.style.maxWidth = '';
    sheet.style.width = '0px';
    sheet.style.marginLeft = '0px';
    const lineWidth = (this.lineWidth = this.line.getBoundingClientRect().width);
    sheet.style.marginLeft = stood;
    // As they come, to see how wide the widest is.
    sheet.style.width = sheet.style.maxWidth = sheet.style.alignSelf = '';
    for (const g of groups) {
      g.style.display = 'flex';
      g.style.flexWrap = 'wrap';
      g.style.gridTemplateColumns = '';
      for (const k of Array.from(g.children) as HTMLElement[]) {
        k.style.gridColumn = '';
      }
    }
    let widest = 0;
    let most = 0;
    for (const g of groups) {
      most = Math.max(most, g.children.length);
      for (const k of Array.from(g.children) as HTMLElement[]) {
        widest = Math.max(widest, k.offsetWidth);
      }
    }
    const gap = parseFloat(getComputedStyle(groups[0]).columnGap) || 5;
    const cs = getComputedStyle(sheet);
    const frame = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight) + parseFloat(cs.borderLeftWidth) + parseFloat(cs.borderRightWidth);
    const room = lineWidth - frame;
    const cell = Math.min(room, Math.max(widest, phone ? 92 : 84));
    // (Up to five in one row; more than that, four across - a card, not a strip.)
    const fits = Math.max(1, Math.min(most <= 5 ? 5 : 4, Math.floor((room + gap) / (cell + gap))));
    const rows = Math.ceil(most / fits);
    const cols = Math.max(1, Math.ceil(most / rows));
    const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
    for (const g of groups) {
      const kids = Array.from(g.children) as HTMLElement[];
      // (A short last row: its buttons share the row between them - but one button alone keeps its own width, at
      // the row's start: stretched right across, it was a bar, not a button.)
      const over = kids.length % cols;
      const left = over === 1 && cols > 1 ? 0 : over;
      const tracks = left ? (cols * left) / gcd(cols, left) : cols;
      g.style.display = 'grid';
      g.style.flexWrap = '';
      g.style.gridTemplateColumns = `repeat(${tracks}, minmax(0, 1fr))`;
      kids.forEach((k, i) => (k.style.gridColumn = `span ${i >= kids.length - left ? tracks / left : tracks / cols}`));
    }
    const width = cols * cell + (cols - 1) * gap + frame;
    sheet.style.maxWidth = '100%';
    // Never wider than the line itself. (All but as wide as it, it was left to stretch - and what it stretched to was
    // the box the line sits in, which on a tablet runs under the panels at the sides: one wide window, its buttons
    // off the edge of the workspace.)
    const full = room + frame;
    sheet.style.width = `${Math.floor(width > full - cell * 0.4 ? full : Math.min(full, Math.ceil(width)))}px`;
    sheet.style.alignSelf = 'flex-start';
  }

  /** A number typed right there: Enter (or a tap elsewhere) sets it, Esc leaves it as it was. */
  private type(w: Word): void {
    const v = w.value!;
    const box = el('div', 'sn-type');
    box.append(el('span', 'sn-type-label', w.cap ?? w.label));
    const input = document.createElement('input');
    input.type = 'text';
    input.inputMode = 'decimal';
    input.autocomplete = 'off';
    input.spellcheck = false;
    // (What it follows, if it follows a variable: shown as its number, Enter made it that number and the link was gone.)
    const was = v.expr ?? (v.kind === 'length' ? String(+toDisplay(v.now).toFixed(4)) : String(+v.now.toFixed(4)));
    input.value = was;
    input.dataset.kind = v.kind;
    if (v.min !== undefined) {
      input.dataset.min = String(v.min);
    }
    if (v.max !== undefined) {
      input.dataset.max = String(v.max);
    }
    numpadInput(input);
    box.append(input);
    const unit = v.kind === 'length' ? UNIT_LABEL[units()] : v.kind === 'angle' ? '°' : '';
    if (unit) {
      box.append(el('span', 'sn-type-unit', unit));
    }
    // A size that can follow a variable: ƒx beside the box - one of the project's variables, or a new one made from
    // what is typed. (A phone's number keys have no letters to type a name with.)
    let picking = false;
    const ui = this.host.ui;
    if (v.putExpr && ui.variableFactory) {
      const fx = el('button', 'fx-btn', 'ƒx');
      fx.title = 'Variables: use one here, or make a new one from this value';
      fx.addEventListener('pointerdown', () => (picking = true));
      fx.addEventListener('click', async (e) => {
        e.preventDefault();
        picking = true;
        const names = ui.variableNames();
        let name: string | null = null;
        if (names.length) {
          const pick = await ui.ask('Variables', 'Use a variable for this value, or make a new one from it.', [...names.slice(0, 8).map(n => ({ id: `v:${n}`, label: n })), { id: 'new', label: 'New variable', primary: true }]);
          name = !pick ? null : pick === 'new' ? await ui.variableFactory!(input.value) : pick.slice(2);
        } else {
          name = await ui.variableFactory!(input.value);
        }
        picking = false;
        if (!name) {
          return input.focus();
        }
        input.value = name;
        end(true);
      });
      box.append(fx);
    }
    this.sheet.replaceChildren(box);
    let over = false;
    const end = (keep: boolean) => {
      if (over) {
        return;
      }
      over = true;
      this.typing = null;
      const text = input.value.trim();
      // (Left as it was: nothing to do - a size that follows a variable is not made a plain number by looking at it.)
      if (keep && text !== was) {
        const n = evaluate(text, v.kind === 'int' ? 'number' : v.kind);
        if (n === null) {
          // Said as it is: a name no variable has, else what was typed.
          const names = new Set(this.host.ui.variableNames());
          const unknown = [...text.matchAll(/[a-z_][a-z0-9_]*/gi)].map(m => m[0]).filter(x => !names.has(x) && !RESERVED.test(x));
          this.host.ui.toast(unknown.length ? `${[...new Set(unknown)].join(', ')}: no variable has that name` : `"${text}" isn't a value that can be worked out`, 'error');
        } else {
          // A variable's name in it: the size follows it from now on (it was made the number it came to, and the
          // link never kept); a plain number: it follows none.
          v.putExpr?.(isExpression(text) ? text : null);
          v.put(Math.min(v.max ?? Infinity, Math.max(v.min ?? -Infinity, v.kind === 'int' ? Math.round(n) : n)));
        }
      }
      if (this.open?.kind === 'type') {
        this.open = null;
      }
      this.sheet.hidden = true;
      this.sheet.replaceChildren();
      this.changed();
    };
    this.typing = { end };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        (e.preventDefault(), end(true));
      } else if (e.key === 'Escape') {
        (e.preventDefault(), end(false));
      }
      e.stopPropagation();
    });
    input.addEventListener('blur', () => setTimeout(() => document.activeElement !== input && !picking && end(true), 150));
    input.focus();
    selectAll(input);
    openNumpad(input);
  }

  /** A word brought into sight on the line (a blank to fill, the tool in use). */
  private reveal(d: HTMLElement): void {
    const r = d.getBoundingClientRect();
    const box = this.row.getBoundingClientRect();
    if (r.left < box.left + 8 || r.right > box.right - 8) {
      this.row.scrollTo({ left: this.row.scrollLeft + r.left - box.left - 24, behavior: calm() ? 'auto' : 'smooth' });
    }
  }

  // ------------------------------------------------------------- the thread

  /**
   * From the subject to what it names on the model: one curve, drawn again
   * only when one of its ends moved (each frame: one point projected and
   * compared).
   */
  private drawThread(fresh = false): void {
    if (!this.on) {
      return;
    }
    // (No line from the pick to its name: the name with its + says what is picked, and the pick is lit - the line was
    // one more thing over the model. Kept for a tool's blank it may be wanted for.)
    const a = this.threads ? this.anchor : null;
    const subject = a && this.tag.querySelector('[data-key="s-pick"]');
    const s = a && this.host.view.toScreen(a);
    if (!a || !subject || !s) {
      if (this.threadSig !== 'off') {
        this.threadSig = 'off';
        this.thread.classList.remove('on');
      }

      return;
    }
    const c = (this.viewAt ??= this.host.view.canvas.getBoundingClientRect());
    const x1 = Math.round(c.left + s[0]);
    const y1 = Math.round(c.top + s[1]);
    const sig = `${x1},${y1}`;
    if (sig === this.threadSig && !fresh) {
      return;
    }
    const r = subject.getBoundingClientRect();
    const lr = this.line.getBoundingClientRect();
    const x0 = Math.round(Math.min(Math.max(r.left + r.width / 2, lr.left + 14), lr.right - 14));
    const y0 = Math.round(r.top);
    this.threadSig = sig;
    // (Up out of the word, then over to the thing: a hanging curve, never a straight wire.)
    const lift = Math.max(30, Math.min(140, (y0 - y1) * 0.55));
    this.threadPath.setAttribute('d', `M${x0} ${y0} C${x0} ${y0 - lift} ${x1} ${y1 + lift * 0.35} ${x1} ${y1}`);
    this.threadDot.setAttribute('cx', String(x1));
    this.threadDot.setAttribute('cy', String(y1));
    this.thread.classList.add('on');
    if (fresh && !calm()) {
      const len = this.threadPath.getTotalLength();
      this.threadPath.animate([{ strokeDasharray: `${len}`, strokeDashoffset: `${-len}` }, { strokeDasharray: `${len}`, strokeDashoffset: '0' }], { duration: 260, easing: 'ease-out' });
      this.threadDot.animate([{ r: '9', opacity: 0 }, { r: '3.5', opacity: 1 }], { duration: 300, easing: 'ease-out' });
    }
  }

  // ------------------------------------------------------------- for checks

  /** What it holds now, as built - every word with what it runs and opens (for `sg.sweep()`, which tries them all). */
  get state(): { about: string; words: SweepWord[]; groups: { cap: string; words: SweepWord[] }[]; done?: () => void; cancel?: () => void } | null {
    this.built = this.build();
    const b = this.built;

    return { about: b.about, words: b.words, groups: b.groups, done: b.done?.run, cancel: b.cancel?.run };
  }

  /** What it says now (for `sg.sentence()`): the line's words, the sheet's, the end buttons. */
  describe() {
    const b = this.built;
    const at = (d: Element) => {
      const r = d.getBoundingClientRect();

      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), w: Math.round(r.width), h: Math.round(r.height) };
    };
    const words = (box: Element) =>
      Array.from(box.querySelectorAll<HTMLElement>('.sn-word')).map((d) => {
        const w = (d as HTMLElement & { word?: Word }).word;

        return { key: d.dataset.key, kind: w?.kind, cap: w?.cap, label: w?.label, ...(w?.on ? { on: true } : {}), ...(w?.blank ? { blank: true } : {}), ...(w?.kids ? { opens: w.kids.map(k => k.label) } : {}), ...(w?.quiet ? { quiet: true } : {}), ...at(d) };
      });

    return {
      on: this.on,
      about: b?.about,
      tag: words(this.tag),
      line: words(this.row),
      compact: this.line.classList.contains('sn-compact'),
      end: Array.from(this.end.children).map(d => ({ label: (d as HTMLElement).title, ...at(d) })),
      open: this.open?.kind ?? null,
      sheet: this.sheet.hidden ? [] : Array.from(this.sheet.querySelectorAll<HTMLElement>('.sn-group')).map(g => ({ cap: g.dataset.cap, words: words(g) })),
      thread: this.thread.classList.contains('on')
    };
  }
}
