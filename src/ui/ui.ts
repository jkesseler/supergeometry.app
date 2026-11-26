import { mergingCommits } from '../doc/store';
import { screenClass, watchScreenClass } from '../device';
import { evaluate, toDisplay, trim, UNIT_LABEL, units } from '../units';
import { settings } from '../settings';
import { selectAll } from './textField';
import { numpadInput, typingInto } from './numpad';
import { HistoryPanel } from './historyPanel';
import { renderHint, renderLeftColumn, renderPointerLabel, renderTools } from './toolList';
import { askDialog, formDialog, showContextMenu, type Choice, type DialogField } from './dialogs';
import { icons, type IconName } from './icons';
import type { FeatureError } from '../kernel/protocol';
import type { Feature, HistoryGroup } from '../doc/types';

export interface ToolItem {
  id: string;
  label: string;
  icon: IconName;
  /** Small second line, e.g. the current variant ("Diagonal"). */
  sub?: string;
  /** A shorter name for the wheel, where a long one runs over the button ("Perpendicular to Edge at Point": "Square to Edge"). */
  short?: string;
  shortcut?: string;
  active?: boolean;
  /** Draw the eye to it: a ring pulses round it (Exit Sketch once a shape is closed). */
  pulse?: boolean;
  disabled?: boolean;
  /** Reason shown when disabled. */
  why?: string;
  /** Not made yet: dimmed in its place with a "soon" tag, and a tap does nothing. */
  soon?: boolean;
  /** Opens a flyout with variants / sub-tools instead of running. */
  children?: ToolItem[];
  /**
   * A tool with variants: a tap starts it (the variant used last); a tap on
   * it while it's the one in use opens the variants.
   */
  variantsWhenActive?: boolean;
  /** Show a colour circle instead of the icon (colour choices). */
  swatch?: string;
  /** Small icons after the label (e.g. ⟲ + what a toggle switches to). */
  trailing?: IconName[];
  /**
   * The id of the kind a tap starts by itself (Plane: Offset Plane, from the
   * face or plane tapped next) while its kinds show to pick another instead.
   */
  startsDefault?: string;
  /** Still being tried out: a BETA tag on it. */
  beta?: boolean;
  /**
   * A look ahead at what it would do to what is picked: line segments (pairs
   * of points, flat) drawn dashed on the model while the pointer is over it.
   */
  peek?: () => number[];
  /** On the wheel, a tap opens a box by it to type a number into (`run` is what a column or menu does instead). */
  value?: { now: string; put(v: number): void; /** Whole numbers only (a drag steps by 1). */ int?: boolean; /** The least and most it can be. */ min?: number; max?: number };
  /** Its kinds go round the wheel in the order listed (Solid, 25%, 50%, 75%), not most used first. */
  inOrder?: boolean;
  run?(): void;
}

export type FieldKind = 'length' | 'angle' | 'number' | 'int';

/** A row of a right-click menu (UI.menu). */
export interface MenuRow {
  label: string;
  shortcut?: string;
  /** On/off rows: a tick when on. */
  checked?: boolean;
  disabled?: boolean;
  run(): void;
}

export type PanelItem =
  | {
    type: 'number';
    label: string;
    value: number;
    kind?: FieldKind;
    min?: number;
    onInput(v: number): void;
    /** Expression currently driving the value (shown instead of the number). */
    expr?: string;
    /** Set when the field may hold an expression: called with it, or null for a plain number. */
    onExpr?(expr: string | null): void;
    /** The same value as the value box on the model: left out of the list attached to it. */
    inBox?: boolean;
    /**
       * Nothing set yet: the value only shows where the pointer is (a line's
       * Across / Up). Digits typed start it over, sign and all - a set value
       * keeps its minus.
       */
    follows?: boolean;
  }
  | { type: 'slot'; label: string; value: string; active: boolean; filled: boolean; onClick(): void }
  | {
    type: 'choice';
    label?: string;
    options: { id: string; label: string }[];
    value: string;
    onChange(id: string): void;
    /** Always a drop-down. */
    list?: boolean;
  }
  | { type: 'toggle'; label: string; value: boolean; onChange(v: boolean): void }
  /**
   * Drag to set (no typing, no maths): how much a spout bends, a handle
   * arches… The value shows beside it (`show` formats it).
   */
  | { type: 'slider'; label: string; value: number; min: number; max: number; step?: number; show?(v: number): string; onInput(v: number): void }
  | { type: 'button'; label: string; icon?: IconName; onClick(): void; /** Blue: the step to take next (Apply). */ primary?: boolean }
  /** A row of one-tap chips (e.g. the constraints that fit a selection); `on` ones are lit. */
  | { type: 'chips'; label?: string; chips: { label: string; glyph?: string; on?: boolean; title?: string; onClick(): void }[]; empty?: string };

/** Kept for older call sites: a numeric field. */
export interface ValueField {
  label: string;
  value: number;
  unit?: string;
  min?: number;
  step?: number;
  integer?: boolean;
  kind?: FieldKind;
  onInput(v: number): void;
}

export interface ValuePanel {
  title: string;
  /** A tool still being tried out: a BETA tag by the title. */
  beta?: boolean;
  fields?: ValueField[];
  items?: PanelItem[];
  onDone?(): void;
  onCancel?(): void;
  /** Extra buttons shown in the panel (e.g. Delete). */
  actions?: ToolItem[];
  /**
   * Enter in a field only applies the value (the card stays open). For cards
   * whose fields are steps of a longer edit - Freeform's exact moves: Enter
   * after a ΔZ ended the whole cage edit.
   */
  enterApplies?: boolean;
}

export interface HistoryHandlers {
  edit(id: string, pick?: string[]): void;
  /** Pointer over a step (null: left it): show what it works on. */
  hover?(id: string | null): void;
  toggle(id: string): void;
  /** Shown in the view, or hidden (a sketch, plane or axis: its eye hides it, never switches it off). */
  isHidden?(id: string): boolean;
  toggleHidden?(id: string): void;
  remove(id: string): void;
  /** History groups (runs of steps under one name), and changing them. */
  groups: HistoryGroup[];
  setGroups(next: HistoryGroup[]): void;
  /** Switch several steps off (true) or on. */
  suppress(ids: string[], off: boolean): void;
  askName(title: string, current: string): Promise<string | null>;
  /** The breakpoint after this step (the later ones off), or none (null). */
  breakAfter?(id: string | null): void;
  /** Flatten the history into the bodies as they are. */
  merge?(): void;
}

const query = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;
/** A tool card on a phone is at most this wide (px): a narrow strip, not one across the screen. */
const PHONE_CARD_MAX = 300;

/** All DOM chrome around the viewport. Deliberately framework-free and small. */
export class UI {
  private toolbar = query<HTMLElement>('#toolbar');
  private bottomLeft = query<HTMLElement>('#bottom-left');
  private flyout = query<HTMLElement>('#flyout');
  private hint = query<HTMLElement>('#hint');
  private panel = query<HTMLElement>('#panel');
  private historyEl = query<HTMLElement>('#history');
  private historyList = query<HTMLElement>('#history-list');
  private toastEl = query<HTMLElement>('#toast');
  private labelEl = query<HTMLElement>('#label');
  private status = query<HTMLElement>('#status');
  private rightCol = query<HTMLElement>('#right-col');
  private popover = query<HTMLElement>('#popover');
  readonly pins = query<HTMLElement>('#pins');
  private toastTimer = 0;
  private panelSpec: ValuePanel | null = null;
  private flyoutOwner: string | null = null;
  private popoverOwner: string | null = null;

  constructor() {
    document.getElementById('history-pick')?.addEventListener('click', () => this.history.setPicking(!this.history.isPicking));
    // Phone / tablet & small laptop / monitor & TV: <html data-screen> for the stylesheet.
    watchScreenClass(() => (this.panelSide = -1));
    document.addEventListener(
      'pointerdown',
      (e) => {
        if ((e.target as HTMLElement).tagName === 'CANVAS') {
          this.lastPress = { x: e.clientX, y: e.clientY };
        }
      },
      true
    );
    document.addEventListener(
      'pointermove',
      (e) => {
        this.pointerAt = { x: e.clientX, y: e.clientY };
        if ((e.target as HTMLElement).tagName === 'CANVAS') {
          this.lastPointer = { x: e.clientX, y: e.clientY };
        }
      },
      true
    );
    query('#history-close').innerHTML = icons.close;
    query('#history-close').addEventListener('click', () => this.toggleHistory(false));
    document.addEventListener('pointerdown', (e) => {
      const t = e.target as HTMLElement;
      if (!t.closest('#flyout, #toolbar, #bottom-left')) {
        this.closeFlyout();
      }
    });
    // History opens by default everywhere (on phones it floats and can be closed).
    this.toggleHistory(true);
    this.holdLabels();
    this.besidePanels();
    window.addEventListener('resize', () => (this.fitToolbar(), this.fitPanel()));
  }

  /**
   * The columns at the middle of the left and right edges, and undo / redo in their corner, move over for Items and
   * History only when those come down as far as they stand (asked for: "they should be there only if they are that
   * long"). Items and History are as tall as what is in them now: a short one leaves the edge under it free, and
   * the column stays at the edge. Said to the stylesheet as classes on the body, set when a window opens, closes,
   * grows or shrinks, or the screen changes size.
   */
  private besidePanels(): void {
    const items = document.getElementById('items');
    const history = document.getElementById('history');
    if (!items || !history) {
      return;
    }
    let queued = false;
    const check = () => {
      queued = false;
      const box = (el: HTMLElement | null) => {
        if (!el) {
          return null;
        }
        const rect = el.getBoundingClientRect();

        return rect.width && rect.height ? rect : null;
      };
      const it = items.classList.contains('open') ? box(items) : null;
      const hi = history.classList.contains('open') ? box(history) : null;
      const left = box(document.getElementById('left-col'));
      const right = box(document.getElementById('right-col'));
      const undo = box(document.getElementById('undo-dock'));
      const set = (name: string, on: boolean) => document.body.classList.contains(name) !== on && document.body.classList.toggle(name, on);
      // (Short of it by a finger's gap: the column's top, undo's top. The view cube is at the top, where History always is: it moves over as before.)
      // (Where a column stands with nothing beside it: the middle of the edge. With History open some screens move
      // the right one up beside History - going by where it is then, it never came back for a short History.)
      const mid = (rect: DOMRect) => innerHeight / 2 - rect.height / 2;
      set('items-clear-col', !!it && !!left && it.bottom < mid(left) - 8);
      set('items-clear-undo', !!it && !!undo && it.bottom < undo.top - 8);
      set('history-clear-col', !!hi && !!right && hi.bottom < mid(right) - 8);
      // (A narrow screen: History is a card across the top, over the left column too when it is long.)
      set('history-clear-left', !!hi && !!left && hi.bottom < mid(left) - 8);
    };
    const later = () => {
      if (queued) {
        return;
      }
      queued = true;
      requestAnimationFrame(check);
    };
    const ro = new ResizeObserver(later);
    ro.observe(items);
    ro.observe(history);
    new MutationObserver(later).observe(items, { attributes: true, attributeFilter: ['class'] });
    new MutationObserver(later).observe(history, { attributes: true, attributeFilter: ['class'] });
    window.addEventListener('resize', later);
    later();
  }

  /**
   * Touch screens show buttons as icons only: press and hold one (a tool, a
   * right-column button, the view cube's, undo...) to see its name in the
   * middle of the screen. Let go on it to use it; slide off it to not.
   */
  private holdLabels(): void {
    const ghost = el('div', 'tool-ghost');
    ghost.hidden = true;
    document.body.append(ghost);
    let held: { btn: HTMLElement; id: number; timer: number; off: boolean } | null = null;
    let swallow: HTMLElement | null = null;
    const end = () => {
      if (!held) {
        return;
      }
      clearTimeout(held.timer);
      ghost.hidden = true;
      if (held.off) {
        swallow = held.btn;
      }
      held = null;
    };
    document.addEventListener(
      'pointerdown',
      (e) => {
        if (e.pointerType === 'mouse') {
          return;
        }
        const btn = (e.target as HTMLElement).closest<HTMLElement>('.tool, button, [role=button]');
        // Icon buttons only (one with its name written on it says it already).
        if (!btn || !btn.querySelector('svg') || btn.closest('.dialog, .menu')) {
          return;
        }
        // Just the name: "Undo (Ctrl Z)" reads "Undo", "Zoom to fit (F)" "Zoom to fit".
        const name = (btn.dataset.label || btn.title || btn.getAttribute('aria-label') || '').replace(/\s*\([^)]*\)$/, '');
        if (!name) {
          return;
        }
        swallow = null;
        held = {
          btn,
          id: e.pointerId,
          off: false,
          timer: window.setTimeout(() => {
            ghost.textContent = name;
            ghost.hidden = false;
          }, 220)
        };
      },
      true
    );
    document.addEventListener(
      'pointermove',
      (e) => {
        if (!held || e.pointerId !== held.id) {
          return;
        }
        const rect = held.btn.getBoundingClientRect();
        const out = e.clientX < rect.left - 6 || e.clientX > rect.right + 6 || e.clientY < rect.top - 6 || e.clientY > rect.bottom + 6;
        if (out && !held.off) {
          // Slid off: it won't be used.
          held.off = true;
          ghost.hidden = true;
          clearTimeout(held.timer);
        }
      },
      true
    );
    document.addEventListener('pointerup', e => held && e.pointerId === held.id && end(), true);
    document.addEventListener('pointercancel', (e) => {
      if (held && e.pointerId === held.id) {
        held.off = true;
        end();
      }
    }, true);
    // A press that slid off the button doesn't count as a tap on it.
    document.addEventListener(
      'click',
      (e) => {
        if (swallow && swallow.contains(e.target as Node)) {
          e.stopImmediatePropagation();
          e.preventDefault();
        }
        swallow = null;
      },
      true
    );
    // The long press shouldn't open the browser's own menu.
    document.addEventListener('contextmenu', e => (e.target as HTMLElement).closest?.('.tool, button') && e.preventDefault());
  }

  toggleHistory(open?: boolean): void {
    const on = this.historyEl.classList.toggle('open', open);
    // Phones and narrow tablets (an iPad mini upright): one panel at a time (History or Items).
    if (on && window.innerWidth < 760) {
      document.getElementById('items')?.classList.remove('open');
      document.body.classList.remove('items-open');
    }
    // Everything on the right makes room for the docked History panel.
    document.body.classList.toggle('history-open', on);
    // Things placed beside the right-hand bar (panel, constraint column) re-fit.
    window.dispatchEvent(new Event('resize'));
  }

  // ------------------------------------------------------------- left column

  setTools(items: ToolItem[]): void {
    this.closeFlyout();
    this.toolItems = items;
    // During a tool the strip only holds its ✕: on phones that goes next to
    // undo/redo (one row of buttons instead of a near-empty bar).
    const onlyCancel = items.length === 1 && items[0].id === 'cancel';
    document.body.classList.toggle('tool-cancel-dock', onlyCancel);
    let x = document.getElementById('cancel-dock-btn');
    if (!x) {
      x = el('button', 'dock-btn');
      x.id = 'cancel-dock-btn';
      x.title = 'Cancel (Esc)';
      x.innerHTML = icons.close;
      x.addEventListener('click', () => this.toolItems.find(t => t.id === 'cancel')?.run?.());
      document.getElementById('undo-dock')?.append(x);
    }
    renderTools(this.toolbar, items, (item, btn) => this.runAndOpen(item, btn, this.toolbar, () => this.toolItems));
    this.fitToolbar();
    this.onTools?.();
  }

  setBottom(items: ToolItem[]): void {
    this.bottomItems = items;
    renderTools(this.bottomLeft, items, (item, btn) => this.runAndOpen(item, btn, this.bottomLeft, () => this.bottomItems));
    this.fitToolbar();
    this.showLeft();
    this.onTools?.();
  }

  /**
   * Isolate, Measure and Section, always on screen at the middle of the left edge - as Fit, Display and Settings
   * are at the right (asked for: "I want isolate, measure and section buttons to always be on screen ... I find
   * myself clicking More way too much ... put them on middle left"). Each lit while it is on; Isolate with nothing
   * picked says what to pick.
   */
  private leftSig = '';
  private showLeft(): void {
    const host = document.getElementById('left-col');
    if (!host) {
      return;
    }
    const items = LEFT.map(id => this.bottomItems.find(it => it.id === id)).filter((it): it is ToolItem => !!it);
    // (A tool with a strip of its own: the three stay as they were.)
    if (!items.length) {
      return;
    }
    this.leftItems = items;
    const sig = items.map(it => `${it.id}|${it.active ? 1 : 0}|${it.disabled ? 1 : 0}|${it.pulse ? 1 : 0}`).join();
    if (sig === this.leftSig) {
      return;
    }
    this.leftSig = sig;
    renderLeftColumn(host, items, (index) => {
      const now = this.leftItems[index];
      if (!now) {
        return;
      }
      if (now.disabled) {
        return this.toast(now.why ?? `${now.label} can't be used now`);
      }
      now.run?.();
    });
  }
  private leftItems: ToolItem[] = [];

  /** What the column and the bottom bar hold now (the tool wheel shows the same). The three at the left edge are not said twice. */
  shown(): { column: ToolItem[]; bar: ToolItem[] } {
    return { column: this.toolItems, bar: this.bottomItems.filter(it => !LEFT.includes(it.id)) };
  }
  /** Called when the column or the bottom bar is given new tools. */
  onTools: (() => void) | null = null;

  /** What is offered now: the left column, the bottom bar and the open window's buttons. */
  offered(): ToolItem[] {
    return [...this.toolItems, ...this.bottomItems, ...(this.panelSpec?.actions ?? [])];
  }
  private toolItems: ToolItem[] = [];
  private bottomItems: ToolItem[] = [];

  /**
   * A tool with options (Spline: fit / control points…): a click starts it
   * straight away with the option used last, and opens the options beside it.
   */
  private runAndOpen(item: ToolItem, btn: HTMLElement, host: HTMLElement, items: () => ToolItem[]): void {
    if (!item.run || this.flyoutOwner === item.id) {
      return this.openFlyout(item, btn);
    }
    const rect = btn.getBoundingClientRect();
    item.run();
    // Running it may have redrawn the column: open the options on the new button
    // (or where the button was, if a tool took the column over).
    const fresh = items().find(toolItem => toolItem.id === item.id) ?? item;
    const nb = host.querySelector<HTMLElement>(`[data-tool="${CSS.escape(item.id)}"]`) ?? ({ getBoundingClientRect: () => rect } as HTMLElement);
    if (fresh.children?.length) {
      this.openFlyout(fresh, nb);
    }
  }

  /**
   * The tool column is centred on the left edge; keep it clear of the top bar
   * and of the buttons at the bottom-left, with a gap like the other panels.
   */
  /**
   * The value panel is centred at the bottom: keep it between the left tool
   * columns and the right column / History, wrapping onto more rows if needed.
   */
  fitPanel(): void {
    // The list sizes itself (and is placed by placePanel).
    if (this.panel.classList.contains('as-list')) {
      return void (this.panel.style.maxWidth = '');
    }
    if (window.innerWidth <= 720) {
      return void (this.panel.style.maxWidth = '');
    }
    const GAP = 12;
    const visible = (e: HTMLElement) => !e.hidden && e.childElementCount > 0 && getComputedStyle(e).display !== 'none';
    const left = Math.max(0, ...[this.toolbar, this.bottomLeft, document.getElementById('undo-dock')!].filter(visible).map(e => e.getBoundingClientRect().right));
    const rights = [this.rightCol, ...(this.historyEl.classList.contains('open') ? [this.historyEl] : [])].map(e => e.getBoundingClientRect().left);
    const right = window.innerWidth - Math.min(window.innerWidth, ...rights);
    const reserve = Math.max(left, right) + GAP;
    this.panel.style.maxWidth = `${Math.max(260, window.innerWidth - 2 * reserve)}px`;
  }

  fitToolbar(): void {
    if (window.innerWidth <= 720) {
      return void (this.toolbar.style.maxHeight = '');
    }
    const GAP = 14;
    // Whatever is stacked at the bottom-left (section/measure buttons, the undo dock).
    const stack = [this.bottomLeft, document.getElementById('undo-dock')!].filter(e => e.childElementCount && getComputedStyle(e).display !== 'none');
    const below = stack.length ? window.innerHeight - Math.min(...stack.map(e => e.getBoundingClientRect().top)) + GAP : 0;
    const above = 52 + GAP;
    this.toolbar.style.maxHeight = `${Math.max(160, window.innerHeight - 2 * Math.max(below, above))}px`;
  }

  /** Back-compat: the context list now lives in the main column. */
  setContext(_items: ToolItem[]): void {}

  private openFlyout(item: ToolItem, anchor: HTMLElement): void {
    if (this.flyoutOwner === item.id) {
      return this.closeFlyout();
    }
    this.flyoutOwner = item.id;
    // Measure before re-rendering: a nested anchor lives inside this flyout.
    const rect = anchor.getBoundingClientRect();
    renderTools(this.flyout, item.children ?? [], (child, btn) => this.openFlyout(child, btn), () => this.closeFlyout());
    // Colour choices show as a grid of circles.
    this.flyout.classList.toggle('swatch-grid', !!item.children?.length && item.children.every(child => child.swatch));
    this.flyout.hidden = false;
    // A strip of tools along the bottom (phones, main tools): the options open
    // above it. A column of tools (the sketch tools, also on phones): beside it.
    const col = anchor.closest?.('#toolbar, #bottom-left')?.getBoundingClientRect();
    const strip = !!col && col.width > col.height;
    const narrow = window.innerWidth <= 720 && (strip || !col);
    if (narrow) {
      // Above the bottom strip and the buttons stacked over it (undo, section…).
      const stack = [this.bottomLeft, document.getElementById('undo-dock')!].filter(e => e.childElementCount && getComputedStyle(e).display !== 'none').map(e => e.getBoundingClientRect().top);
      const above = Math.min(rect.top, ...stack.filter(t => t < rect.top));
      this.flyout.style.left = '8px';
      this.flyout.style.top = '';
      this.flyout.style.bottom = `${window.innerHeight - above + 8}px`;
    } else {
      // Clear of the whole column (it can be wider than its buttons, with a scrollbar).
      this.flyout.style.left = `${Math.max(rect.right, col?.right ?? 0) + 6}px`;
      this.flyout.style.bottom = '';
      // Short screens (phones sideways): within the tool column's height, never over the
      // top bar or the undo buttons, scrolling if longer. Elsewhere: clear of the top bar.
      const toolbar = this.toolbar.getBoundingClientRect();
      const short = window.innerHeight <= 500 && toolbar.height > 0;
      const top = short ? toolbar.top : 52;
      // …and above the buttons at the bottom left (section, measure, undo).
      const stackTop = Math.min(window.innerHeight, ...[this.bottomLeft, document.getElementById('undo-dock')!].filter(e => e.childElementCount && getComputedStyle(e).display !== 'none').map(e => e.getBoundingClientRect().top));
      const bottom = short ? toolbar.bottom : Math.min(window.innerHeight - 12, stackTop - 8);
      this.flyout.style.maxHeight = `${Math.max(120, bottom - top)}px`;
      const height = Math.min(this.flyout.scrollHeight, bottom - top);
      this.flyout.style.top = `${Math.max(top, Math.min(rect.top, bottom - height))}px`;
    }
  }

  closeFlyout(): void {
    this.flyout.hidden = true;
    this.flyoutOwner = null;
  }

  // ------------------------------------------------------------ right column

  addRight(id: string, icon: IconName, title: string, open: (host: HTMLElement) => void, label?: () => string, place?: { host: HTMLElement; className: string }): HTMLButtonElement {
    const b = document.createElement('button');
    b.className = place ? place.className : 'right-btn';
    b.dataset.right = id;
    this.rightEntries.set(id, { open, label });
    b.title = title;
    b.innerHTML = icons[icon];
    if (label) {
      const span = document.createElement('span');
      span.className = 'right-label';
      b.append(span);
      b.dataset.dynamic = '1';
      (b as HTMLButtonElement & { refresh?: () => void }).refresh = () => (span.textContent = label());
      (b as HTMLButtonElement & { refresh?: () => void }).refresh!();
    }
    b.addEventListener('click', () => {
      // Popovers stay open until their button is clicked again.
      if (this.popoverOwner === id) {
        return this.closePopover();
      }
      this.popoverOwner = id;
      this.popoverFill = () => {
        this.popover.innerHTML = '';
        open(this.popover);
      };
      this.popoverFill();
      if (!this.popover.childElementCount) {
        return this.closePopover();
      }
      this.popover.hidden = false;
      this.popoverAt = { button: b, cube: !!place };
      this.placePopover();
      document.querySelectorAll('.pop-open').forEach(element => element.classList.remove('pop-open'));
      b.classList.add('pop-open');
      // Things placed beside the right column (the constraint column) move over.
      window.dispatchEvent(new Event('resize'));
    });
    (place?.host ?? this.rightCol).append(b);

    return b;
  }

  refreshRight(): void {
    this.rightCol.querySelectorAll<HTMLButtonElement & { refresh?: () => void }>('button').forEach(b => b.refresh?.());
  }

  private popoverFill: (() => void) | null = null;
  /** The button the open window came from (and whether that is the view cube's). */
  private popoverAt: { button: HTMLElement; cube: boolean } | null = null;
  private popoverWatch: ResizeObserver | null = null;

  /**
   * Where the window opened from the right column (Shaded, Settings, Views...) stands: beside its button, and in
   * the room there is - under the top bar and whatever else is above it there (the view cube, History, Items),
   * over the line at the bottom, undo / redo and the guide text. Longer than that room, it scrolls inside. Worked
   * out from where those are now, on every screen (asked for: "when a window opens from those, to not override
   * anything else (should be dynamic)"): it stood by fixed sizes, and on a phone came down over the line.
   */
  private placePopover(): void {
    const at = this.popoverAt;
    const pop = this.popover;
    if (!at || pop.hidden) {
      return;
    }
    const innerWidth = window.innerWidth;
    const innerHeight = window.innerHeight;
    const rect = at.button.getBoundingClientRect();
    const col = this.rightCol.getBoundingClientRect();
    pop.style.maxHeight = '';
    // Sideways: beside the column (the stylesheet's place), or under the cube with its right edge at the button.
    pop.style.right = at.cube ? `${Math.max(innerWidth - rect.right, col.width ? innerWidth - col.left + 8 : 8)}px` : '';
    let box = pop.getBoundingClientRect();
    const seen = (sel: string): DOMRect | null => {
      const e = document.querySelector<HTMLElement>(sel);
      if (!e || e === at.button || e.contains(at.button)) {
        return null;
      }
      const cs = getComputedStyle(e);
      if (cs.display === 'none' || cs.visibility === 'hidden') {
        return null;
      }
      const q = e.getBoundingClientRect();

      return q.width && q.height && q.right > box.left + 2 && q.left < box.right - 2 ? q : null;
    };
    // (What stands above it gives way to nothing; what stands below neither: the window takes what is between.)
    let top = 8;
    let bottom = innerHeight - 8;
    const between = () => {
      top = 8;
      bottom = innerHeight - 8;
      for (const sel of ['#topbar', '#viewcube-host', '#history.open', '#items.open', '#hint', '.sn-line', '#undo-dock', '#numpad']) {
        const q = seen(sel);
        if (!q) {
          continue;
        }
        // (Above the middle: over it. Below: under it. One down the whole edge - a long History - is beside it.)
        if (q.bottom < innerHeight * 0.55) {
          top = Math.max(top, q.bottom + 6);
        } else if (q.top > innerHeight * 0.45) {
          bottom = Math.min(bottom, q.top - 6);
        }
      }
    };
    between();
    // Hardly any room under the view cube (a phone on its side): beside the cube, not a slit under it.
    const cube = !at.cube && bottom - top < 170 ? seen('#viewcube-host') : null;
    if (cube && cube.left - 8 >= box.width) {
      pop.style.right = `${Math.round(innerWidth - cube.left + 6)}px`;
      box = pop.getBoundingClientRect();
      between();
    }
    const room = Math.max(120, bottom - top);
    pop.style.maxHeight = `${room}px`;
    const height = Math.min(pop.offsetHeight, room);
    const want = at.cube ? rect.bottom + 6 : rect.top;
    pop.style.top = `${Math.round(Math.max(top, Math.min(want, bottom - height)))}px`;
    // Its size or the line's changes (a choice inside it, a list opened from the line): placed again.
    if (!this.popoverWatch) {
      let queued = false;
      const again = () => {
        if (queued) {
          return;
        }
        queued = true;
        requestAnimationFrame(() => ((queued = false), this.placePopover()));
      };
      this.popoverWatch = new ResizeObserver(again);
      for (const sel of ['.sn-line', '#history', '#items', '#hint']) {
        const e = document.querySelector(sel);
        if (e) {
          this.popoverWatch.observe(e);
        }
      }
      window.addEventListener('resize', again);
    }
  }

  /** The right column's lists and switches, by id (Settings opens the ones that have no button of their own). */
  private rightEntries = new Map<string, { open: (host: HTMLElement) => void; label?: () => string }>();

  /** One of the right column's actions run by id (Screenshot, from Print / Share). */
  runRight(id: string): void {
    this.rightEntries.get(id)?.open(el('div', ''));
  }

  closePopover(): void {
    // An action button (no popover shown) must not stay the owner: its next click would only "close".
    this.popoverOwner = null;
    if (this.popover.hidden) {
      return;
    }
    this.popover.style.left = '';
    this.popover.style.maxHeight = '';
    this.popover.hidden = true;
    this.popoverFill = null;
    this.popoverAt = null;
    document.querySelectorAll('.pop-open').forEach(element => element.classList.remove('pop-open'));
    window.dispatchEvent(new Event('resize'));
  }

  /** Re-draw the open popover (after one of its choices changed). */
  refreshPopover(): void {
    this.popoverFill?.();
    this.placePopover();
  }

  // ------------------------------------------------------- hint/status/toast

  setHint(text: string | null): void {
    // (A small × puts the guide text away for good - More → Guide text brings it back. Asked for: "there is no way to remove them" - the switch in More was not found.)
    renderHint(this.hint, text ?? '', () => {
      settings.set('showHints', false);
      this.refreshHint();
      this.toast('Guide text is off. More → Guide text turns it on again.');
    });
    this.hintText = text;
    this.hint.hidden = !text || !settings.value.showHints;
    // How tall it is (a long hint wraps to more lines): the sketch tools column keeps clear of it.
    if (!this.hint.hidden) {
      document.documentElement.style.setProperty('--hint-h', `${Math.ceil(this.hint.offsetHeight)}px`);
    }
  }


  private hintText: string | null = null;

  /** More → Guide text switched: show (or hide) what's there now. */
  refreshHint(): void {
    this.setHint(this.hintText);
  }

  /** A small persistent note (e.g. "body not closed"), never blocking. */
  setWarning(text: string | null): void {
    const element = document.getElementById('warn')!;
    element.textContent = text ?? '';
    element.hidden = !text;
  }

  setStatus(text: string | null): void {
    this.status.textContent = text ?? '';
    this.status.hidden = !text;
  }

  /**
   * A right-click menu at (x, y) in page pixels: rows of commands (with a
   * key hint, a tick for on/off ones), "-" for a dim line. Closes on a pick,
   * Esc, or a press anywhere else. Kept on screen (phones, a corner click).
   */
  menu(x: number, y: number, rows: (MenuRow | '-')[]): void {
    this.closeMenu();
    this.menuClose = showContextMenu(x, y, rows);
  }

  private menuClose: (() => void) | null = null;

  private panelWarning: string | null = null;

  /**
   * The tool card's problem (null: none): a red line under its title and a
   * warning mark by the title. Changed in place (typing in the card goes on).
   */
  setPanelWarning(text: string | null): void {
    this.panelWarning = text;
    const element = this.panel.querySelector<HTMLElement>('.panel-warn');
    if (!element) {
      return;
    }
    element.textContent = text ? `⚠ ${text}` : '';
    element.hidden = !text;
    this.panel.querySelector('.panel-title')?.classList.toggle('warned', !!text);
  }

  closeMenu(): void {
    this.menuClose?.();
    this.menuClose = null;
  }

  /** The last few toasts (the console's sg.state() shows them: they fade before you can read them). */
  readonly recentToasts: string[] = [];

  toast(text: string, kind: 'info' | 'error' = 'info'): void {
    this.recentToasts.push(text);
    if (this.recentToasts.length > 20) {
      this.recentToasts.shift();
    }
    this.toastEl.textContent = text;
    this.toastEl.className = `show ${kind}`;
    // Never over what's being typed into (a value box, the numpad, the tool panel): then it shows up top.
    // Nor over History or Items when they're open ("2 regions selected" landed on History's steps).
    const over = (t: DOMRect) =>
      [...document.querySelectorAll<HTMLElement>('.numpad:not([hidden]), .dim-widget, #panel:not([hidden]), #history, #items')]
        .map(el => el.getBoundingClientRect())
        .filter(rect => rect.width > 0 && rect.height > 0 && rect.left < t.right && rect.right > t.left && rect.top < t.bottom && rect.bottom > t.top);
    // Placed without its slide-in (measured mid-slide, it was where it had been).
    this.toastEl.style.transition = 'none';
    requestAnimationFrame(() => (this.toastEl.style.transition = ''));
    this.toastEl.style.left = this.toastEl.style.maxWidth = '';
    const hits = over(this.toastEl.getBoundingClientRect());

    if (hits.length) {
      // Side panels (History, Items) in the way: in the middle of the space between them.
      const t = this.toastEl.getBoundingClientRect();
      const mid = (t.left + t.right) / 2;
      const lo = Math.max(0, ...hits.filter(hit => (hit.left + hit.right) / 2 < mid).map(hit => hit.right));
      const hi = Math.min(innerWidth, ...hits.filter(hit => (hit.left + hit.right) / 2 >= mid).map(hit => hit.left));
      // (Narrower there, the text wraps: a tablet with both open has 240 px between them.)
      if (hi - lo >= 160) {
        this.toastEl.style.left = `${(lo + hi) / 2}px`;
        this.toastEl.style.maxWidth = `${hi - lo - 16}px`;
      }
      // Still over something (a value box, the tool card): up top.
      if (over(this.toastEl.getBoundingClientRect()).length) {
        this.toastEl.style.left = this.toastEl.style.maxWidth = '';

        this.toastEl.classList.add('top');
      }
    }

    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => (this.toastEl.className = ''), 3600);
  }

  /** Floating label next to the pointer, e.g. live dimensions while drawing. */
  setLabel(x: number, y: number, text: string | null): void {
    if (!text) {
      this.labelEl.hidden = true;

      return;
    }
    // Callers mark typeable values with a trailing "· type a value". The value is
    // already in a box on screen (the value box or the tool's list): no second label.
    const value = text.replace(/\s+· type a value$/, '');
    const typeable = value !== text;
    const typing = value.includes('▌');
    const shownElsewhere = !this.panel.hidden || !!document.querySelector('.dim-widget.editable:not([hidden])');
    if (typeable && !typing && shownElsewhere) {
      this.labelEl.hidden = true;

      return;
    }
    this.labelEl.hidden = false;
    const tip = typing ? 'Enter ↵ apply · Esc cancel' : null;
    renderPointerLabel(this.labelEl, value, tip);
    this.labelEl.classList.toggle('typing', typing);
    this.labelEl.style.transform = `translate(${Math.round(x + 18)}px, ${Math.round(y + 14)}px)`;
  }

  /** Hides the label by the pointer, unless a value is being typed into it. */
  clearPointerLabel(): void {
    if (!this.labelEl.classList.contains('typing')) {
      this.labelEl.hidden = true;
    }
  }

  /**
   * A window of fields; resolves with their values, or null (Cancel / Esc / X).
   * `action`: a button at the top (e.g. New Variable); it resolves with the values too, and ACTION set.
   */
  dialog(title: string, fields: DialogField[], note?: string, action?: { label: string; icon: IconName }): Promise<Record<string, string> | null> {
    return formDialog(title, fields, note, action);
  }

  /** A question with a few answers (buttons); resolves with the chosen id, or null (Esc / Cancel). */
  ask(title: string, note: string, choices: Choice[]): Promise<string | null> {
    return askDialog(title, note, choices);
  }

  // ------------------------------------------------------------------- panel

  get panelOpen(): boolean {
    return this.panelSpec !== null;
  }

  /** Called when the tool's window opens, closes or is drawn again (the Options wheel follows it). */
  onPanel: (() => void) | null = null;

  /** What the tool's window holds now: its parts in order, Done and Cancel, its own actions. */
  panelContent(): { title: string; items: PanelItem[]; actions: ToolItem[]; done?: () => void; cancel?: () => void } | null {
    const spec = this.panelSpec;
    if (!spec) {
      return null;
    }
    const items: PanelItem[] = [
      ...(spec.fields ?? []).map((valueField): PanelItem => ({ type: 'number', label: valueField.label, value: valueField.value, kind: valueField.kind ?? (valueField.integer ? 'int' : valueField.unit ? 'length' : 'number'), min: valueField.min, onInput: valueField.onInput })),
      ...(spec.items ?? [])
    ];

    return { title: spec.title, items, actions: spec.actions ?? [], done: spec.onDone, cancel: spec.onCancel };
  }

  /**
   * A value of the tool's window set from the Options wheel: the window's
   * own record of it and its box follow (a tool doesn't always draw its
   * window again), so the next step starts from it.
   */
  syncPanelValue(item: PanelItem, value: number): void {
    const spec = this.panelSpec;
    if (!spec || !('label' in item)) {
      return;
    }
    const field = spec.fields?.find(field => field.label === item.label);
    if (field) {
      field.value = value;
    }
    const it = spec.items?.find((panelItem): panelItem is PanelItemOf<'number' | 'slider'> => (panelItem.type === 'number' || panelItem.type === 'slider') && panelItem.label === item.label);
    if (it) {
      it.value = value;
    }
    for (const box of Array.from(this.panel.querySelectorAll<HTMLElement>('.field'))) {
      if (box.querySelector('.field-label')?.textContent !== item.label) {
        continue;
      }
      const input = box.querySelector('input');
      if (!input) {
        continue;
      }
      input.value = input.type === 'range' ? String(value) : shown(value, (input.dataset.kind as FieldKind) || 'length');
      const out = box.querySelector('.slider-value');
      if (out && item.type === 'slider') {
        out.textContent = sliderText(item, value);
      }
    }
  }

  /**
   * With the Options wheel up the tool's window stays out of sight; Values on
   * the wheel brings it back for typing (and again puts it away).
   */
  showPanelWindow(on: boolean): void {
    document.body.classList.toggle('panel-shown', on);
    if (on) {
      this.panel.classList.remove('folded');
    }
  }

  showPanel(spec: ValuePanel | null): void {
    this.panelSpec = spec;
    this.panelVersion++;
    this.panel.innerHTML = '';
    this.panel.hidden = !spec;
    // A tool's window open: the tool's icon pulses, so it's clear what the window belongs to.
    document.body.classList.toggle('panel-open', !!spec);
    // Closed: next time it's placed afresh (and whole). Folded stays folded
    // (a sketch closes and reopens its card for each thing tapped) until
    // another tool starts: unfoldPanel.
    // (After this, the Options wheel shows what the window holds now.)
    queueMicrotask(() => this.onPanel?.());
    // A window with nothing in it but Cancel and Done (Move Vertex) isn't shown with the wheel on:
    // a tap on empty space is Done, Undo takes it back, Esc and Enter still work.
    document.body.classList.toggle('panel-empty', !!spec && !spec.fields?.length && !spec.items?.length && !spec.actions?.length);
    if (!spec) {
      this.panelWarning = null;
      document.body.classList.remove('panel-shown');

      return void (this.panelSide = -1);
    }
    // A short list, like a right-click menu: each value with its box after the
    // name. It hangs under the tool's value box on the model (or by the pointer).
    this.panel.classList.add('as-list');
    this.followPanel();
    const row = el('div', 'panel-fields');
    const items: PanelItem[] = [
      ...(spec.fields ?? []).map((valueField): PanelItem => ({ type: 'number', label: valueField.label, value: valueField.value, kind: valueField.kind ?? kindOfField(valueField), min: valueField.min, onInput: valueField.onInput })),
      ...(spec.items ?? [])
    ];
    // Phones: a card that is just one button (the Values chip while drawing)
    // has nothing to fold or move - no grip. Folded, a card shows a Values
    // chip that unfolds it (its title isn't shown on a phone: it was an empty bar).
    const phone = document.documentElement.dataset.screen === 'phone';
    const chipOnly = items.length === 1 && items[0].type === 'button' && !spec.fields?.length && !spec.actions?.length;
    this.appendPanelHead(spec, !(phone && chipOnly));
    let numberIndex = 0;
    for (const it of items) {
      if (it.type !== 'number') {
        row.append(panelItem(it));
        continue;
      }
      const element = this.numberField(it, numberIndex++, spec);
      if (it.inBox) {
        element.dataset.inbox = '1';
      }
      row.append(element);
    }
    this.panel.append(row);
    // The card's own actions (Select all, Add detail…) in a row of their own,
    // inside the card (sharing the Cancel / Done row they were pushed out of it).
    if (spec.actions?.length) {
      this.panel.append(panelActions(spec.actions));
    }
    this.panel.append(panelButtons(spec));
    // Phones: a window with nothing to set (only Done, Cancel being the ✕ by
    // undo) isn't shown - a tap on empty space finishes, as Done would; Enter
    // and Esc still work.
    if (document.documentElement.dataset.screen === 'phone' && !items.length && !spec.actions?.length) {
      this.panel.hidden = true;
      document.body.classList.remove('panel-open');
    }
  }

  /** Grip, title, warning line and Values chip. */
  private appendPanelHead(spec: ValuePanel, hasGrip: boolean): void {
    if (hasGrip) {
      this.panel.append(this.panelGrip());
    }
    const title = el('div', 'panel-title', spec.title);
    if (spec.beta) {
      title.append(betaTag());
    }
    this.panel.append(title);
    // What stops the tool ("2 profiles needed"): a red line at the top of its card.
    const warn = el('div', 'panel-warn');
    warn.setAttribute('role', 'alert');
    this.panel.append(warn);
    this.setPanelWarning(this.panelWarning);
    const unfold = el('button', 'text-btn panel-unfold');
    unfold.innerHTML = icons.numpad;
    unfold.append('Values');
    unfold.addEventListener('click', () => {
      this.panel.classList.remove('folded');
      this.putPanel(this.panel.offsetLeft, this.panel.offsetTop);
    });
    this.panel.append(unfold);
  }

  private numberField(field: Extract<PanelItem, { type: 'number' }>, index: number, spec: ValuePanel): HTMLElement {
    const kind = field.kind ?? 'length';
    const label = el('label', 'field');
    label.append(el('span', 'field-label', field.label));
    const input = document.createElement('input');
    input.type = 'text';
    input.inputMode = 'decimal';
    numpadInput(input);
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.value = field.expr ?? shown(field.value, kind);
    input.dataset.index = String(index);
    input.dataset.kind = kind;
    if (field.follows) {
      input.dataset.follows = '1';
    }
    if (field.expr) {
      input.classList.add('has-expr');
    }
    const apply = () => {
      const value = evaluate(input.value, kind === 'length' ? 'length' : kind === 'angle' ? 'angle' : 'number');
      const ok = value !== null && (field.min === undefined || value >= field.min);
      input.classList.toggle('invalid', !ok);
      if (!ok) {
        return;
      }
      // Text with a variable name stays an expression (parametric); plain numbers don't.
      const isExpr = isExpression(input.value);
      input.classList.toggle('has-expr', isExpr);
      // Key by key into this box: one undo step for the value typed.
      mergingCommits(input, () => {
        field.onExpr?.(isExpr ? input.value.trim() : null);
        field.onInput(kind === 'int' ? Math.round(value!) : value!);
      });
    };
    input.addEventListener('input', apply);
    // Clicking a value selects it: typing replaces it (no "020").
    input.addEventListener('focus', () => requestAnimationFrame(() => document.activeElement === input && selectAll(input)));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        apply();
        if (spec.enterApplies) {
          selectAll(input);
        } else {
          spec.onDone?.();
        }
      } else if (e.key === 'Escape') {
        e.preventDefault();
        spec.onCancel?.();
      } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        input.value = nudged(input.value, kind, (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 10 : 1));
        apply();
      }
      e.stopPropagation();
    });
    label.append(input);
    const unit = kind === 'length' ? UNIT_LABEL[units()] : kind === 'angle' ? '°' : '';
    if (unit) {
      label.append(el('span', 'field-unit', unit));
    }
    if (field.onExpr && this.variableFactory) {
      const fx = el('button', 'fx-btn', 'ƒx');
      fx.title = 'Variables: use one here, or make a new one from this value';
      fx.addEventListener('click', async (e) => {
        e.preventDefault();
        // One button, two ways: an existing variable, or a new one.
        const names = this.variableNames();
        let name: string | null = null;
        if (names.length) {
          const pick = await this.ask('Variables', 'Use a variable for this value, or make a new one from it.', [
            ...names.slice(0, 8).map(name => ({ id: `v:${name}`, label: name })),
            { id: 'new', label: 'New variable', primary: true }
          ]);
          if (!pick) {
            return;
          }
          name = pick === 'new' ? await this.variableFactory!(input.value) : pick.slice(2);
        } else {
          name = await this.variableFactory!(input.value);
        }
        if (!name) {
          return;
        }
        input.value = name;
        apply();
      });
      label.append(fx);
    }

    return label;
  }

  /** Where the pointer last pressed on the model (the list goes near it when there's no value box). */
  private lastPress: { x: number; y: number } | null = null;
  private following = false;

  /**
   * Keep the tool's list beside what you're working on, every frame: under the
   * value box on the model if there is one (it moves with the view), else just
   * past where you last pressed, and always on screen.
   */
  private followPanel(): void {
    if (this.following) {
      return;
    }
    this.following = true;
    const step = () => {
      if (this.panel.hidden) {
        this.following = false;

        return;
      }
      this.placePanel();
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  /** Where the pointer is over the model (the card keeps out of its way). */
  private lastPointer: { x: number; y: number } | null = null;
  /** Where the pointer is anywhere on the page. */
  private pointerAt: { x: number; y: number } | null = null;
  /** Which side the card went last time (kept while it's still clear: no jumping about). */
  private panelSide = -1;

  /**
   * Phones (upright or sideways): the card goes in one fixed place along the
   * bottom - the widest clear gap between what's already there (the Items
   * panel, undo/redo, the tool strip, the view column), as low as it fits; if
   * the bottom row is too full, just above it (over the hint text). As wide as
   * its contents, never wider than the gap.
   */
  private placeOnPhone(element: HTMLElement): void {
    const innerWidth = window.innerWidth;
    const innerHeight = window.innerHeight;
    const margin = 8;
    const obstacles = ['#items', '#history', '#toolbar', '#undo-dock', '#bottom-left', '#right-col', '#hint']
      .map(q => document.querySelector<HTMLElement>(q))
      .filter((e): e is HTMLElement => !!e && !e.hidden && e.offsetHeight > 0 && e.offsetWidth > 0 && getComputedStyle(e).display !== 'none')
      .map(e => e.getBoundingClientRect());
    element.style.maxWidth = '';
    const natural = Math.min(element.offsetWidth, innerWidth - 2 * margin);
    const need = Math.min(natural, 240);
    // Free stretches of a horizontal band [y0, y1].
    const gaps = (y0: number, y1: number): [number, number][] => {
      const blocked = obstacles.filter(obstacle => obstacle.bottom > y0 && obstacle.top < y1).map(obstacle => [obstacle.left - margin, obstacle.right + margin] as [number, number]).sort((a, b) => a[0] - b[0]);
      const out: [number, number][] = [];
      let x = margin;
      for (const [a, b] of blocked) {
        if (a > x) {
          out.push([x, a]);
        }
        x = Math.max(x, b);
      }
      if (innerWidth - margin > x) {
        out.push([x, innerWidth - margin]);
      }

      return out;
    };
    // Bottom edges to try: the screen's, then just above each thing along the bottom.
    const edges = [innerHeight - margin, ...obstacles.filter(obstacle => obstacle.top > innerHeight * 0.4).map(obstacle => obstacle.top - margin)].sort((a, b) => b - a);
    for (const y1 of edges) {
      const offsetHeight = element.offsetHeight;
      const firstGap = gaps(y1 - offsetHeight, y1).sort((a, b) => b[1] - b[0] - (a[1] - a[0]))[0];
      if (!firstGap || firstGap[1] - firstGap[0] < need) {
        continue;
      }
      // (No wider than a phone card is: fields wrap onto a second row instead.)
      element.style.maxWidth = `${Math.floor(Math.min(firstGap[1] - firstGap[0], PHONE_CARD_MAX))}px`;
      this.hugContents(element);
      const h2 = element.offsetHeight;
      element.style.left = `${Math.round(firstGap[0])}px`;
      element.style.top = `${Math.round(Math.max(52, y1 - h2))}px`;

      return;
    }
    // Nowhere clear: the bottom left, over whatever is there.
    element.style.left = `${margin}px`;
    element.style.top = `${Math.round(Math.max(52, innerHeight - margin - element.offsetHeight))}px`;
  }

  /**
   * A card whose contents wrap onto more rows keeps the width of the widest
   * row (a browser doesn't shrink it): trim it to what's really in it.
   */
  private hugContents(element: HTMLElement): void {
    element.style.width = '';
    const left = element.getBoundingClientRect().left;
    let right = left;
    // (Done is pushed to the row's end: measure where the others end, plus its own width.)
    let tail = 0;
    for (const row of element.querySelectorAll<HTMLElement>(':scope > .panel-fields > *, :scope > .panel-buttons > *')) {
      if (!row.offsetWidth) {
        continue;
      }
      if (row.parentElement?.classList.contains('panel-buttons')) {
        tail += row.offsetWidth + 6;
      } else {
        right = Math.max(right, row.getBoundingClientRect().right);
      }
    }
    right += tail;
    const pad = parseFloat(getComputedStyle(element).paddingRight) || 0;
    if (right > left) {
      element.style.width = `${Math.ceil(right - left + pad + 1)}px`;
    }
  }

  /** Where the card was dragged to, per kind of screen (it stays there). */
  private static PANEL_POS = 'sg-panel-pos';
  private panelSpot(): { x: number; y: number } | null {
    try {
      return JSON.parse(localStorage.getItem(UI.PANEL_POS) ?? '{}')?.[screenClass()] ?? null;
    } catch {
      return null;
    }
  }
  private savePanelSpot(spot: { x: number; y: number } | null): void {
    this.panelVersion++;
    try {
      const all = JSON.parse(localStorage.getItem(UI.PANEL_POS) ?? '{}') ?? {};
      if (spot) {
        all[screenClass()] = spot;
      } else {
        delete all[screenClass()];
      }
      localStorage.setItem(UI.PANEL_POS, JSON.stringify(all));
    } catch {
      // private window: not remembered
    }
  }
  private panelDragging = false;

  /**
   * The grip along the card's top (like the numpad's): drag it to put the card
   * where you want - it opens there from then on, on this kind of screen.
   * Double-tap it: the card folds to just its name (and back again).
   */
  private panelGrip(): HTMLElement {
    const grip = el('div', 'panel-grip');
    grip.title = 'Drag to move · double-tap to fold or unfold';
    grip.append(el('span', ''));
    let drag: { id: number; dx: number; dy: number; moved: boolean } | null = null;
    grip.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const rect = this.panel.getBoundingClientRect();
      drag = { id: e.pointerId, dx: e.clientX - rect.left, dy: e.clientY - rect.top, moved: false };
      this.panelDragging = true;
      grip.setPointerCapture(e.pointerId);
    });
    grip.addEventListener('pointermove', (e) => {
      if (!drag || e.pointerId !== drag.id) {
        return;
      }
      drag.moved = true;
      this.putPanel(e.clientX - drag.dx, e.clientY - drag.dy);
    });
    const end = (e: PointerEvent) => {
      if (!drag || e.pointerId !== drag.id) {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      if (drag.moved) {
        this.savePanelSpot({ x: parseFloat(this.panel.style.left), y: parseFloat(this.panel.style.top) });
      } else if (performance.now() - this.lastGripTap < 350) {
        this.lastGripTap = 0;
        this.panel.classList.toggle('folded');
        // Kept whole on screen, folded or not.
        this.putPanel(this.panel.offsetLeft, this.panel.offsetTop);
      } else {
        this.lastGripTap = performance.now();
      }
      drag = null;
      this.panelDragging = false;
    };
    grip.addEventListener('pointerup', end);
    grip.addEventListener('pointercancel', end);

    return grip;
  }
  private lastGripTap = 0;

  /** A new tool's card opens whole (a folded one stays folded while the same tool goes on). */
  unfoldPanel(): void {
    this.panel.classList.remove('folded');
  }

  /** The card at this spot, kept whole on screen. */
  private putPanel(x: number, y: number): void {
    const panel = this.panel;
    panel.style.left = `${Math.round(Math.max(4, Math.min(window.innerWidth - panel.offsetWidth - 4, x)))}px`;
    panel.style.top = `${Math.round(Math.max(4, Math.min(window.innerHeight - panel.offsetHeight - 4, y)))}px`;
  }

  /** Bumped when the card's contents change (it may need placing again). */
  private panelVersion = 0;
  /** What the card was last placed for: the same again, nothing to do (no measuring every frame). */
  private panelKey = '';

  private placePanel(): void {
    const panel = this.panel;
    const box = [...document.querySelectorAll<HTMLElement>('.dim-widget.editable')].filter(e => !e.hidden && e.offsetWidth).pop();
    // Being dragged, or put somewhere by hand: it stays there.
    if (this.panelDragging) {
      return;
    }
    const key = this.panelPlaceKey(box);
    if (key === this.panelKey) {
      return;
    }
    this.panelKey = key;
    panel.classList.toggle('attached', !!box);
    const spot = this.panelSpot();
    if (spot) {
      if (screenClass() === 'phone') {
        panel.style.maxWidth = `${Math.min(window.innerWidth - 16, PHONE_CARD_MAX)}px`;
        this.hugContents(panel);
      }
      this.putPanel(spot.x, spot.y);
      this.panelSide = 0;

      return;
    }
    // Phones: one fixed place, right above the hint text (or the bottom
    // buttons) - never chasing the model across a small screen.
    if (screenClass() === 'phone') {
      this.placeOnPhone(panel);
      this.panelSide = 0;

      return;
    }
    // Heading for the card (or typing in it): it holds still, so it can be clicked.
    if (this.panelSide >= 0 && panel.style.left && this.isHeadingForPanel()) {
      return;
    }
    this.placePanelClear(box);
  }

  private panelPlaceKey(box: HTMLElement | undefined): string {
    const panel = this.panel;
    const rectText = (e: Element | null) => {
      if (!e || (e as HTMLElement).hidden) {
        return '-';
      }
      const b = e.getBoundingClientRect();

      return `${Math.round(b.left)},${Math.round(b.top)},${Math.round(b.width)},${Math.round(b.height)}`;
    };
    const q = (value: number) => Math.round(value / 16);
    const phone = screenClass() === 'phone';

    return [
      window.innerWidth,
      window.innerHeight,
      this.panelVersion,
      panel.offsetWidth,
      panel.offsetHeight,
      rectText(box ?? null),
      box?.dataset.seg ?? '',
      phone ? ['#items', '#history', '#toolbar', '#undo-dock', '#bottom-left', '#right-col', '#hint'].map(selector => rectText(document.querySelector(selector))).join('|') : '',
      phone || !this.lastPointer ? '' : `${q(this.lastPointer.x)},${q(this.lastPointer.y)}`,
      phone || !this.pointerAt ? '' : `${q(this.pointerAt.x)},${q(this.pointerAt.y)}`,
      this.lastPress ? `${this.lastPress.x},${this.lastPress.y}` : '',
      panel.contains(document.activeElement) ? 'f' : ''
    ].join(';');
  }

  private isHeadingForPanel(): boolean {
    const panel = this.panel;
    const cardRect = panel.getBoundingClientRect();
    const pointer = this.pointerAt;
    const near = pointer && pointer.x > cardRect.left - 60 && pointer.x < cardRect.right + 60 && pointer.y > cardRect.top - 60 && pointer.y < cardRect.bottom + 60;

    return !!near || panel.contains(document.activeElement) || panel.matches(':hover');
  }

  /** Where the card covers least of the line, the pointer and the app's columns. */
  private placePanelClear(box: HTMLElement | undefined): void {
    const panel = this.panel;
    // What the card must not cover: the dimension (the line being drawn, the
    // drag arrow) and the pointer.
    const avoid: [number, number][][] = [];
    const seg = box?.dataset.seg?.split(',').map(Number);
    if (box && seg && seg.length === 4 && seg.every(Number.isFinite)) {
      avoid.push([[seg[0], seg[1]], [seg[2], seg[3]]]);
    }
    if (this.lastPointer) {
      avoid.push([[this.lastPointer.x, this.lastPointer.y]]);
    }
    // The app's own columns and bars: a card over the tool column hides the
    // tools (a tablet with Items open has the tools right beside it).
    const chrome = ['#toolbar', '#items', '#history', '#right-col', '#topbar', '#undo-dock', '#bottom-left', '#viewcube-host', '#hint']
      .map(selector => document.querySelector<HTMLElement>(selector))
      .filter((e): e is HTMLElement => !!e && !e.hidden && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden')
      .map(e => e.getBoundingClientRect());
    const room: PanelRoom = { width: panel.offsetWidth, height: panel.offsetHeight, innerWidth: window.innerWidth, innerHeight: window.innerHeight, chrome, avoid };
    // Places to try, in order of preference.
    const spots = [...this.panelSpotsToTry(box, room), ...spotsClearOfChrome(room)];
    // Where it is stays as long as it's clear of the line (the pointer only steers where it goes next).
    const lineOnly = { ...room, avoid: room.avoid.filter(shape => shape.length > 1) };
    const isStillClear = this.panelSide >= 0 && this.panelSide < spots.length && spotCost(lineOnly, spots[this.panelSide]) === 0;
    const pick = isStillClear ? this.panelSide : cheapestSpot(room, spots);
    this.panelSide = pick;
    const [x, y] = spots[pick];
    panel.style.left = `${Math.round(clampPanelX(room, x))}px`;
    panel.style.top = `${Math.round(clampPanelY(room, y))}px`;
  }

  private panelSpotsToTry(box: HTMLElement | undefined, room: PanelRoom): [number, number][] {
    const { width, height } = room;
    if (box) {
      const rect = box.getBoundingClientRect();

      return [
        [rect.right + 4, rect.top],
        [rect.left - 4 - width, rect.top],
        [rect.left, rect.top - 4 - height],
        [rect.left, rect.bottom + 4],
        [rect.right + 4, rect.bottom - height],
        [rect.left - 4 - width, rect.bottom - height]
      ];
    }
    if (this.lastPress) {
      const press = this.lastPress;

      return [
        [press.x + 28, press.y + 20],
        [press.x - 28 - width, press.y + 20],
        [press.x + 28, press.y - 20 - height],
        [press.x - 28 - width, press.y - 20 - height],
        // Straight under / over the tap: fits between columns too narrow for beside it.
        [press.x - width / 2, press.y + 36],
        [press.x - width / 2, press.y - 36 - height]
      ];
    }

    return [[(room.innerWidth - width) / 2, room.innerHeight - height - 70]];
  }

  /** Creates a variable from a field's current text; returns its name (set by the app). */
  variableFactory: ((current: string) => Promise<string | null>) | null = null;
  /** The project's variable names (set by the app). */
  variableNames: () => string[] = () => [];

  /** Update displayed values without rebuilding (keeps focus while dragging). */
  updatePanelValues(values: number[]): void {
    this.panel.querySelectorAll<HTMLInputElement>('input[data-index]').forEach((input) => {
      const value = values[Number(input.dataset.index)];
      if (value !== undefined && !typingInto(input)) {
        input.value = shown(value, input.dataset.kind as FieldKind);
      }
    });
    // The line at the bottom says the same numbers (it read them once, as the tool opened: dragged to -22, it still
    // said -5). Told at most once a frame.
    let changed = false;
    (this.panelSpec?.items ?? []).filter((it): it is Extract<PanelItem, { type: 'number' }> => it.type === 'number').forEach((it, i) => {
      if (values[i] !== undefined && it.value !== values[i]) {
        ((it.value = values[i]), (changed = true));
      }
    });
    if (changed && !this.valuesFrame) {
      this.valuesFrame = requestAnimationFrame(() => {
        this.valuesFrame = 0;
        this.onPanel?.();
      });
    }
  }
  private valuesFrame = 0;

  focusPanel(): void {
    // Only focus with a keyboard; on touch it would pop the on-screen keyboard.
    if (matchMedia('(pointer: fine)').matches) {
      this.panel.querySelector<HTMLInputElement>('input')?.select();
    }
  }

  // ----------------------------------------------------------------- history

  private history = new HistoryPanel({ list: this.historyList, toast: text => this.toast(text), menu: (x, y, rows) => this.menu(x, y, rows) });

  renderHistory(features: readonly Feature[], errors: FeatureError[], activeId: string | null, historyHandlers: HistoryHandlers, warnings: Map<string, string> = new Map()): void {
    this.history.render(features, errors, activeId, historyHandlers, warnings);
  }

}

/** The tools kept on screen at the left edge, top to bottom. */
const LEFT = ['isolate', 'measure', 'section'];

/** Does the text use a variable (a name that isn't a unit suffix)? */
export function isExpression(text: string): boolean {
  // A variable name in it; units, pi and sqrt(...)-style functions alone are just a number.
  return /[a-z_]/i.test(text.replace(/(\d|\))\s*(mm|cm|m|in|ft|deg)\b/gi, '$1').replace(/\b(sqrt|abs|sin|cos|tan|asin|acos|atan|floor|ceil|round|min|max)\s*\(|\bpi\b/gi, '('));
}

function unitScale(): number {
  return { mm: 1, cm: 10, m: 1000, in: 25.4, ft: 304.8 }[units()];
}

function shown(value: number, kind: FieldKind): string {
  if (kind === 'length') {
    return trim(toDisplay(value), 4);
  }
  if (kind === 'int') {
    return String(Math.round(value));
  }

  return trim(value, 4);
}

/**
 * Only what can be used right now: tools that can't (greyed before) are left
 * out, and so are groups with nothing usable inside.
 */
export function usable(items: ToolItem[]): ToolItem[] {
  const out: ToolItem[] = [];
  for (const item of items) {
    if (item.disabled) {
      continue;
    }
    if (item.children?.length) {
      const children = usable(item.children);
      if (!children.length && !item.run) {
        continue;
      }
      out.push({ ...item, children });
    } else {
      out.push(item);
    }
  }

  // No separators at the ends or twice in a row.
  return out.filter((toolItem, i, a) => !toolItem.id.startsWith('---') || (i > 0 && i < a.length - 1 && !a[i - 1].id.startsWith('---')));
}

/** The small BETA tag on a tool still being tried out. */
type PanelItemOf<T extends PanelItem['type']> = Extract<PanelItem, { type: T }>;

function kindOfField(valueField: ValueField): FieldKind {
  if (valueField.integer) {
    return 'int';
  }

  return valueField.unit ? 'length' : 'number';
}

function sliderText(item: PanelItemOf<'slider'>, value: number): string {
  return item.show ? item.show(value) : String(value);
}

/** Steps are of the unit shown, for a length. */
function nudged(text: string, kind: FieldKind, steps: number): string {
  const value = evaluate(text, kind === 'length' ? 'length' : 'number') ?? 0;

  return shown(value + steps * (kind === 'length' ? unitScale() : 1), kind);
}

function panelItem(item: Exclude<PanelItem, { type: 'number' }>): HTMLElement {
  switch (item.type) {
    case 'slot':
      return slotButton(item);
    case 'choice':
      // Many options (e.g. fonts, more with every imported one): a drop-down that stays in the panel.
      return item.options.length > 4 || item.list ? choiceList(item) : choiceButtons(item);
    case 'slider':
      return sliderField(item);
    case 'chips':
      return chipsField(item);
    case 'toggle':
      return toggleButton(item);
    default:
      return panelButton(item);
  }
}

function slotButton(item: PanelItemOf<'slot'>): HTMLElement {
  const button = el('button', `slot${item.active ? ' active' : ''}${item.filled ? ' filled' : ''}`);
  button.append(el('span', 'slot-label', item.label), el('span', 'slot-value', item.value));
  button.addEventListener('click', item.onClick);

  return button;
}

function choiceList(item: PanelItemOf<'choice'>): HTMLElement {
  const label = el('label', 'field choice-list');
  if (item.label) {
    label.append(el('span', 'field-label', item.label));
  }
  const select = document.createElement('select');
  for (const option of item.options) {
    const optionElement = document.createElement('option');
    optionElement.value = option.id;
    optionElement.textContent = option.label;
    select.append(optionElement);
  }
  select.value = item.value;
  select.addEventListener('change', () => item.onChange(select.value));
  select.addEventListener('pointerdown', e => e.stopPropagation());
  label.append(select);

  return label;
}

function choiceButtons(item: PanelItemOf<'choice'>): HTMLElement {
  const element = el('div', 'choice');
  if (item.label) {
    element.append(el('span', 'field-label', item.label));
  }
  for (const option of item.options) {
    const button = el('button', option.id === item.value ? 'active' : '', option.label);
    button.addEventListener('click', () => item.onChange(option.id));
    element.append(button);
  }

  return element;
}

function sliderField(item: PanelItemOf<'slider'>): HTMLElement {
  const label = el('label', 'field slider-field');
  label.append(el('span', 'field-label', item.label));
  const input = document.createElement('input');
  input.type = 'range';
  input.min = String(item.min);
  input.max = String(item.max);
  input.step = String(item.step ?? (item.max - item.min) / 100);
  input.value = String(item.value);
  const out = el('span', 'slider-value', sliderText(item, item.value));
  input.addEventListener('input', () => {
    const value = Number(input.value);
    out.textContent = sliderText(item, value);
    item.onInput(value);
  });
  // The card's grip and the view must not take the drag.
  input.addEventListener('pointerdown', e => e.stopPropagation());
  label.append(input, out);

  return label;
}

function chipsField(item: PanelItemOf<'chips'>): HTMLElement {
  const element = el('div', 'chips');
  if (item.label) {
    element.append(el('span', 'field-label', item.label));
  }
  const list = el('div', 'chip-list');
  for (const chip of item.chips) {
    const button = el('button', `chip${chip.on ? ' on' : ''}`);
    if (chip.glyph) {
      button.append(el('span', 'chip-glyph', chip.glyph));
    }
    button.append(chip.label);
    if (chip.title) {
      button.title = chip.title;
    }
    button.addEventListener('click', chip.onClick);
    list.append(button);
  }
  if (!item.chips.length && item.empty) {
    list.append(el('span', 'chip-empty', item.empty));
  }
  element.append(list);

  return element;
}

function toggleButton(item: PanelItemOf<'toggle'>): HTMLElement {
  const button = el('button', `toggle${item.value ? ' on' : ''}`, item.label);
  button.addEventListener('click', () => item.onChange(!item.value));

  return button;
}

function panelButton(item: PanelItemOf<'button'>): HTMLElement {
  const button = el('button', item.primary ? 'text-btn primary' : 'text-btn');
  if (item.icon) {
    button.innerHTML = icons[item.icon];
  }
  button.append(item.label);
  button.addEventListener('click', item.onClick);

  return button;
}

function panelActions(actions: ToolItem[]): HTMLElement {
  const actionRow = el('div', 'panel-actions');
  for (const action of actions) {
    const button = el('button', 'text-btn');
    button.innerHTML = icons[action.icon] ?? '';
    button.append(action.label);
    if (action.disabled) {
      button.disabled = true;
    }
    button.addEventListener('click', () => action.run?.());
    actionRow.append(button);
  }

  return actionRow;
}

function panelButtons(spec: ValuePanel): HTMLElement {
  const buttons = el('div', 'panel-buttons');
  if (spec.onCancel) {
    const button = textButton('Cancel', 'Esc', spec.onCancel);
    button.classList.add('panel-cancel');
    buttons.append(button);
  }
  if (spec.onDone) {
    buttons.append(textButton('Done', 'Enter', spec.onDone, true));
  }

  return buttons;
}

interface PanelRoom {
  width: number;
  height: number;
  innerWidth: number;
  innerHeight: number;
  /** The app's own columns and bars. */
  chrome: DOMRect[];
  /** A line (its two ends) or the pointer (one point). */
  avoid: [number, number][][];
}

const PANEL_MARGIN = 8;

const clampPanelX = (room: PanelRoom, x: number) => Math.max(PANEL_MARGIN, Math.min(room.innerWidth - room.width - PANEL_MARGIN, x));
const clampPanelY = (room: PanelRoom, y: number) => Math.max(52, Math.min(room.innerHeight - room.height - PANEL_MARGIN, y));

/** Somewhere clear of the app's tall columns, should every spot by the tap be covered. */
function spotsClearOfChrome(room: PanelRoom): [number, number][] {
  const { width, height, innerWidth, innerHeight } = room;
  const free = { l: PANEL_MARGIN, r: innerWidth - PANEL_MARGIN };
  for (const rect of room.chrome) {
    if (rect.height <= innerHeight * 0.2 || rect.width >= innerWidth * 0.5) {
      continue;
    }
    if (rect.left < innerWidth / 2) {
      free.l = Math.max(free.l, rect.right + PANEL_MARGIN);
    } else {
      free.r = Math.min(free.r, rect.left - PANEL_MARGIN);
    }
  }

  return [[(free.l + free.r - width) / 2, innerHeight - height - 70], [(free.l + free.r - width) / 2, 60]];
}

/** How badly a spot is in the way: off screen (moved back on), over the line, over the pointer. */
function spotCost(room: PanelRoom, [x0, y0]: [number, number]): number {
  const x = clampPanelX(room, x0);
  const y = clampPanelY(room, y0);
  let penalty = Math.abs(x - x0) + Math.abs(y - y0) > 1 ? 1 : 0;
  for (const rect of room.chrome) {
    if (x < rect.right && x + room.width > rect.left && y < rect.bottom && y + room.height > rect.top) {
      penalty += 3;
    }
  }
  const pad = 14;
  const isInside = (px: number, py: number) => px > x - pad && px < x + room.width + pad && py > y - pad && py < y + room.height + pad;
  for (const shape of room.avoid) {
    if (shape.length === 1 && isInside(shape[0][0], shape[0][1])) {
      penalty += 2;
    }
    if (shape.length > 1 && crossesLine(shape, isInside)) {
      penalty += 4;
    }
  }

  return penalty;
}

function crossesLine([from, to]: [number, number][], isInside: (x: number, y: number) => boolean): boolean {
  for (let step = 0; step <= 24; step++) {
    const t = step / 24;
    if (isInside(from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t)) {
      return true;
    }
  }

  return false;
}

/** The first of the cheapest: spots come in order of preference. */
function cheapestSpot(room: PanelRoom, spots: [number, number][]): number {
  let pick = -1;
  let best = Infinity;
  spots.forEach((spot, i) => {
    const cost = spotCost(room, spot);
    if (cost < best) {
      best = cost;
      pick = i;
    }
  });

  return pick;
}

function betaTag(): HTMLElement {
  const tag = el('span', 'beta-tag', 'BETA');
  tag.title = 'New and still being tried out: it may change, or not work on every shape';

  return tag;
}

/**
 * A delete button: the first tap turns it red ("tap again to delete"), the
 * second deletes - one stray tap never removes anything. It goes back after 3 s,
 * or at a tap anywhere else. `key` names the button, so it stays armed if its
 * window is drawn again between the taps.
 */
let armed: { key: string; until: number } | null = null;
let armTimer = 0;
const ARM_MS = 3000;
function disarm(): void {
  clearTimeout(armTimer);
  armed = null;
  for (const b of document.querySelectorAll<HTMLElement>('.armed[data-arm-key]')) {
    b.classList.remove('armed');
    if (b.dataset.armTitle !== undefined) {
      b.title = b.dataset.armTitle;
    }
  }
}
export function twoTap(b: HTMLElement, key: string, run: () => void): void {
  b.dataset.armKey = key;
  const isArmed = () => !!armed && armed.key === key && Date.now() < armed.until;
  const show = () => {
    b.classList.add('armed');
    if (b.dataset.armTitle === undefined) {
      b.dataset.armTitle = b.title;
    }
    b.title = 'Tap again to delete';
  };
  if (isArmed()) {
    show();
  }
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    if (isArmed()) {
      disarm();
      run();

      return;
    }
    disarm();
    armed = { key, until: Date.now() + ARM_MS };
    show();
    armTimer = window.setTimeout(disarm, ARM_MS);
  });
}
// A tap anywhere but the armed button calls it off.
document.addEventListener(
  'pointerdown',
  (e) => {
    if (!armed) {
      return;
    }
    const on = (e.target as Element | null)?.closest?.<HTMLElement>('[data-arm-key]');
    if (on?.dataset.armKey !== armed.key) {
      disarm();
    }
  },
  true
);

export function textButton(label: string, kbd: string, run: () => void, primary = false): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = primary ? 'text-btn primary' : 'text-btn';
  b.append(label);
  if (kbd && matchMedia('(pointer: fine)').matches) {
    b.append(el('kbd', '', kbd));
  }
  b.addEventListener('click', run);

  return b;
}

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) {
    e.className = cls;
  }
  if (text) {
    e.textContent = text;
  }

  return e;
}

export function fmt(value: number): string {
  return String(Math.round(value * 1000) / 1000);
}
