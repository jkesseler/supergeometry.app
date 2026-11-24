// 3D dimension annotations: a dimension line with arrowheads, an optional
// floating input (Total/Offset + value + pin), and the layer of pinned measurements.

import { BufferGeometry, ConeGeometry, Group, Line, LineBasicMaterial, LineDashedMaterial, Mesh, MeshBasicMaterial, Vector3 } from 'three';
import { mergingCommits } from '../doc/store';
import { el } from '../ui/ui';
import { numpadInput, openNumpad, typingInto } from '../ui/numpad';
import { settings } from '../settings';
import { evaluate, toDisplay, trim, UNIT_LABEL, units } from '../units';
import type { PinDef, Vec3 } from '../doc/types';
import type { Viewport } from '../view/viewport';

const COLOR = 0xdfe6f3;

/** Dashed line a→b with screen-constant arrowheads at both ends. */
class DimLine {
  readonly group = new Group();
  private line: Line;
  private heads: Mesh[];
  private a = new Vector3();
  private b = new Vector3();

  constructor(
    private view: Viewport,
    color = COLOR,
    private solid = false
  ) {
    const opts = { color, depthTest: false, transparent: true };
    this.line = new Line(new BufferGeometry(), solid ? new LineBasicMaterial(opts) : new LineDashedMaterial({ ...opts, dashSize: 1, gapSize: 1 }));
    this.line.renderOrder = 11;
    const mat = new MeshBasicMaterial({ color, depthTest: false, transparent: true });
    this.heads = [0, 1].map(() => {
      const mesh = new Mesh(new ConeGeometry(0.35, 1, 12), mat);
      mesh.renderOrder = 11;

      return mesh;
    });
    this.group.add(this.line, ...this.heads);
  }

  set(a: Vec3, b: Vec3): void {
    this.a.set(...a);
    this.b.set(...b);
    this.line.geometry.setFromPoints([this.a, this.b]);
    this.layout();
  }

  layout(): void {
    const wpp = this.view.cam.worldPerPixel(this.view.height);
    if (!this.solid) {
      const mat = this.line.material as LineDashedMaterial;
      mat.dashSize = wpp * 6;
      mat.gapSize = wpp * 4;
      this.line.computeLineDistances();
    }
    const dir = this.b.clone().sub(this.a);
    const len = dir.length();
    const show = len > wpp * 20;
    dir.normalize();
    const arrowSize = wpp * 11;
    for (const [i, head] of this.heads.entries()) {
      head.visible = show;
      head.scale.setScalar(arrowSize);
      // Cone points +Y; tips sit on the ends, pointing outwards.
      const out = i === 0 ? dir.clone().negate() : dir.clone();
      head.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), out);
      head.position.copy(i === 0 ? this.a : this.b).addScaledVector(out, -arrowSize / 2);
    }
  }

  dispose(): void {
    this.line.geometry.dispose();
    this.heads.forEach(head => head.geometry.dispose());
  }
}

export interface DimWidgetOptions {
  value: number;
  modes?: { id: string; label: string }[];
  mode?: string;
  onMode?(id: string): void;
  /** The value typed (and the text, for a formula with variables). */
  onInput?(v: number, text: string): void;
  onCommit?(): void;
  onPin?(): void;
  /** Text to restore into the input (when another tool takes over while typing). */
  typed?: string;
  focus?: boolean;
  /** Draw the dimension as a solid line of this colour (it *is* the geometry, e.g. a line being drawn). */
  solidColor?: number;
  /**
   * Keep the value box off the geometry: "side" puts it beside the middle of
   * the dimension, "beyond" past its end b (e.g. outside a fillet arc).
   * "clear": beside the middle where the line is long enough on screen for
   * the box to sit there, else back past its start a (a line just drawn:
   * the way it came from, not over its end, where the next point is tapped).
   */
  boxAt?: 'middle' | 'side' | 'beyond' | 'clear';
  /** Extra screen distance past the end for "beyond" (e.g. to clear a drag arrow there). */
  boxGap?: number;
  /** Which way "beyond" goes when the dimension has no length yet (e.g. the arrow's direction). */
  dir?: Vec3;
  /** An angle in degrees (no unit conversion, ° label) instead of a length. */
  angle?: boolean;
  /** No dimension line (just the box, e.g. at the corner between two lines). */
  noLine?: boolean;
  /**
   * The face the value belongs to, by its outward normal: seen from behind,
   * the box steps aside (the value is in the tool's card then). It sat over
   * whatever is in front of that face: a funnel's spout end, tapped from
   * below to open it too, went to Shell's thickness box on the top face.
   */
  facing?: Vec3;
  /** Variables to choose from (a ƒx menu before the pin): the value becomes that variable. */
  variables?: string[];
  onVariable?(name: string): void;
}

/**
 * A dimension in the viewport: dashed line with arrows and, at its middle,
 * a small editable value with an optional mode dropdown and a pin button.
 */
export class DimWidget {
  private line: DimLine;
  private box = el('div', 'dim-widget');
  private input = document.createElement('input');
  private mid = new Vector3();
  private ends: [Vector3, Vector3] = [new Vector3(), new Vector3()];
  private boxAt: 'middle' | 'side' | 'beyond' | 'clear';
  private boxGap: number;
  private dir?: Vec3;
  private facing?: Vec3;
  private hook = () => this.layout();

  constructor(
    private view: Viewport,
    opts: DimWidgetOptions
  ) {
    this.line = opts.solidColor !== undefined ? new DimLine(view, opts.solidColor, true) : new DimLine(view);
    this.boxAt = opts.boxAt ?? 'middle';
    this.boxGap = opts.boxGap ?? 0;
    this.dir = opts.dir;
    this.facing = opts.facing;
    view.overlay.add(this.line.group);
    if (opts.modes) {
      const sel = document.createElement('select');
      for (const mode of opts.modes) {
        const option = document.createElement('option');
        option.value = mode.id;
        option.textContent = mode.label;
        sel.append(option);
      }
      sel.value = opts.mode ?? opts.modes[0].id;
      sel.addEventListener('change', () => opts.onMode?.(sel.value));
      this.box.append(sel);
      this.modeSel = sel;
    }
    this.input.inputMode = 'decimal';
    numpadInput(this.input);
    this.input.spellcheck = false;
    this.angle = !!opts.angle;
    this.line.group.visible = !opts.noLine;
    this.input.value = opts.typed ?? this.show(opts.value);
    this.input.readOnly = !opts.onInput;
    // A box you type into (the tool's other values attach under it as a list).
    this.box.classList.toggle('editable', !!opts.onInput);
    this.input.addEventListener('input', () => {
      const value = evaluate(this.input.value, this.angle ? 'angle' : 'length');
      this.input.classList.toggle('invalid', value === null);
      // Key by key into this box: one undo step for the value typed.
      if (value !== null) {
        mergingCommits(this, () => opts.onInput?.(value, this.input.value));
      }
    });
    this.input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        opts.onCommit?.();
      }
      if (e.key === 'Escape') {
        this.input.blur();
      }
    });
    this.box.append(this.input, el('span', 'dim-unit', this.angle ? '°' : UNIT_LABEL[units()]));
    if (opts.onVariable && opts.variables?.length) {
      // ƒx: pick one of the project's variables for this value.
      const sel = document.createElement('select');
      sel.className = 'dim-var';
      sel.title = 'Use a variable';
      const head = document.createElement('option');
      head.value = '';
      head.textContent = 'ƒx';
      sel.append(head);
      for (const name of opts.variables) {
        const option = document.createElement('option');
        option.value = name;
        option.textContent = name;
        sel.append(option);
      }
      sel.addEventListener('change', () => {
        if (sel.value) {
          opts.onVariable!(sel.value);
        }
      });
      this.box.append(sel);
    }
    if (opts.onPin) {
      const pin = el('button', 'dim-pin', '📌');
      pin.title = 'Pin this measurement';
      pin.addEventListener('click', () => opts.onPin!());
      this.box.append(pin);
    }
    // Clicks on the widget must not reach the viewport.
    this.box.addEventListener('pointerdown', e => e.stopPropagation());
    document.body.append(this.box);
    view.frameHooks.add(this.hook);
    view.helpers.add(this);
    if (opts.focus) {
      setTimeout(() => {
        // The numpad opens on it straight away (on touch screens focus alone may not happen) -
        // unless it opened because keys were typed: then the keyboard carries on in it.
        if (settings.value.numpad && opts.typed === undefined) {
          return openNumpad(this.input);
        }
        this.input.focus();
        const count = this.input.value.length;
        this.input.setSelectionRange(count, count);
      }, 0);
    }
  }

  private angle = false;

  private show(value: number): string {
    return this.angle ? trim(value, 2) : trim(toDisplay(value), 3);
  }

  get text(): string {
    return this.input.value;
  }

  set(a: Vec3, b: Vec3): void {
    this.line.set(a, b);
    this.ends[0].set(...a);
    this.ends[1].set(...b);
    this.mid.set((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2);
    this.layout();
    this.view.requestRender();
  }

  private modeSel: HTMLSelectElement | null = null;
  /** Show another of its modes (the tool switched it). */
  setMode(id: string): void {
    if (this.modeSel) {
      this.modeSel.value = id;
    }
  }

  setValue(value: number): void {
    if (!typingInto(this.input)) {
      this.input.value = this.show(value);
    }
    this.box.classList.remove('typing', 'invalid');
  }

  /** Start typing into the box with this first character (keys pressed elsewhere). */
  focusWith(ch: string): void {
    this.input.value = ch;
    this.input.focus();
    this.input.setSelectionRange(1, 1);
    this.input.dispatchEvent(new Event('input'));
  }

  /** Mark the value as not usable (e.g. a fillet radius too big for the lines). */
  markInvalid(bad: boolean): void {
    this.box.classList.toggle('invalid', bad);
  }

  /** Text typed elsewhere (keys while drawing), shown in the box with a caret. */
  setText(text: string, invalid = false): void {
    if (document.activeElement === this.input) {
      return;
    }
    this.input.value = text;
    this.box.classList.add('typing');
    this.box.classList.toggle('invalid', invalid);
  }

  private layout(): void {
    this.line.layout();
    let screenPoint = this.view.toScreen(this.mid);
    const sa = this.view.toScreen(this.ends[0]);
    const sb = this.view.toScreen(this.ends[1]);
    if (screenPoint && sa && sb && this.boxAt !== 'middle') {
      let dx = sb[0] - sa[0];
      let dy = sb[1] - sa[1];
      // No length yet: use the given direction on screen.
      if (Math.hypot(dx, dy) < 2 && this.dir) {
        const e = this.view.toScreen(this.ends[1].clone().add(new Vector3(...this.dir).multiplyScalar(this.view.cam.worldPerPixel(this.view.height) * 50)));
        if (e) {
          [dx, dy] = [e[0] - sb[0], e[1] - sb[1]];
        }
      }
      const length = Math.hypot(dx, dy) || 1;
      const half = { w: this.box.offsetWidth / 2 + 10, h: this.box.offsetHeight / 2 + 10 };
      // Too short for the box beside it (it would cover both ends): behind the start.
      const behind = this.boxAt === 'clear' && length < 2 * Math.hypot(half.w, half.h) + 24;
      if (behind) {
        const clearance = Math.abs((dx / length) * half.w) + Math.abs((dy / length) * half.h) + 6;
        screenPoint = [sa[0] - (dx / length) * clearance, sa[1] - (dy / length) * clearance];
      } else if (this.boxAt === 'beyond') {
        // Past the end, far enough that the box's own size clears it.
        const clearance = Math.abs((dx / length) * half.w) + Math.abs((dy / length) * half.h) + this.boxGap;
        screenPoint = [sb[0] + (dx / length) * clearance, sb[1] + (dy / length) * clearance];
      } else {
        // Beside the middle, on the upper side of the line.
        let normal: [number, number] = [-dy / length, dx / length];
        if (normal[1] > 0) {
          normal = [-normal[0], -normal[1]];
        }
        const reach = Math.abs(normal[0] * half.w) + Math.abs(normal[1] * half.h);
        screenPoint = [screenPoint[0] + normal[0] * reach, screenPoint[1] + normal[1] * reach];
      }
    }
    // Its face turned away (seen from behind): out of the way - and out of
    // the numpad's hands (on a phone it has it from the start), the value
    // then typed in the tool's card.
    if (screenPoint && this.facing) {
      const viewDir = this.view.cam.viewDir();
      if (viewDir.x * this.facing[0] + viewDir.y * this.facing[1] + viewDir.z * this.facing[2] > 0.05) {
        screenPoint = null;
        if (this.input === document.activeElement) {
          this.input.blur();
        }
      }
    }
    this.box.hidden = !screenPoint;
    // The dimension on screen (the tool's options card keeps off it).
    if (sa && sb) {
      this.box.dataset.seg = `${Math.round(sa[0])},${Math.round(sa[1])},${Math.round(sb[0])},${Math.round(sb[1])}`;
    } else {
      delete this.box.dataset.seg;
    }
    if (screenPoint && this.input === document.activeElement && this.held) {
      screenPoint = this.held;
    }
    if (screenPoint) {
      // Always where you can reach it: on screen, clear of the side panels.
      screenPoint = clampToFree(screenPoint, this.box.offsetWidth / 2, this.box.offsetHeight / 2);
      this.held = screenPoint;
      this.box.style.transform = `translate(${Math.round(screenPoint[0])}px, ${Math.round(screenPoint[1])}px) translate(-50%, -50%)`;
    }
  }

  /** Where the box was last put (it stays put while you type in it). */
  private held: [number, number] | null = null;

  dispose(): void {
    this.view.helpers.delete(this);
    this.view.frameHooks.delete(this.hook);
    this.view.overlay.remove(this.line.group);
    this.line.dispose();
    this.box.remove();
    this.view.requestRender();
  }
}

/** A screen point moved (if needed) so a box of these half sizes is on screen and off the open side panels. */
/** The side panels' and the tool card's places, measured at most every 120 ms (not per box per frame). */
let freeCache: { t: number; sides: DOMRect[]; panel: DOMRect | null; low: DOMRect[] } | null = null;
function freeAreas(): { sides: DOMRect[]; panel: DOMRect | null; low: DOMRect[] } {
  const now = performance.now();
  if (freeCache && now - freeCache.t < 120) {
    return freeCache;
  }
  const sides: DOMRect[] = [];
  for (const id of ['items', 'history']) {
    const e = document.getElementById(id);
    if (e && !e.hidden && e.offsetWidth) {
      sides.push(e.getBoundingClientRect());
    }
  }
  const element = document.getElementById('panel');
  const panel = document.documentElement.dataset.screen === 'phone' && element && !element.hidden && element.offsetHeight ? element.getBoundingClientRect() : null;
  // What sits along the bottom - the line with its tools, and on a phone undo and the guide text over it: a value
  // box stays above them (pulled down into a cut on a phone, the box sat on the guide text).
  const low: DOMRect[] = [];
  for (const id of ['sentence', 'undo-dock', 'hint']) {
    const e = document.getElementById(id);
    const rect = e && !e.hidden && e.offsetHeight && getComputedStyle(e).visibility !== 'hidden' ? e.getBoundingClientRect() : null;
    if (rect && rect.top > window.innerHeight * 0.5) {
      low.push(rect);
    }
  }
  low.sort((a, b) => b.top - a.top);
  freeCache = { t: now, sides, panel, low };

  return freeCache;
}

export function clampToFree(screenPoint: [number, number], hw: number, hh: number): [number, number] {
  let left = 8;
  let right = window.innerWidth - 8;
  const free = freeAreas();
  for (const side of free.sides) {
    if (side.width > window.innerWidth * 0.6) {
      continue;
    } // a phone sheet over everything: ignore
    if (side.left < window.innerWidth / 2) {
      left = Math.max(left, side.right + 8);
    } else {
      right = Math.min(right, side.left - 8);
    }
  }
  if (right - left < hw * 2) {
    [left, right] = [8, window.innerWidth - 8];
  }
  const x = Math.max(left + hw, Math.min(right - hw, screenPoint[0]));
  let y = Math.max(52 + hh, Math.min(window.innerHeight - 8 - hh, screenPoint[1]));
  // Phones: the tool's options card sits fixed along the bottom - the box stays above it.
  if (free.panel) {
    const panel = free.panel;
    if (x + hw > panel.left - 6 && x - hw < panel.right + 6 && y + hh > panel.top - 6) {
      y = Math.max(52 + hh, panel.top - 8 - hh);
    }
  }
  for (const rect of free.low) {
    if (x + hw > rect.left - 6 && x - hw < rect.right + 6 && y + hh > rect.top - 6 && y - hh < rect.bottom + 6) {
      y = Math.max(52 + hh, rect.top - 8 - hh);
    }
  }

  return [x, y];
}

/** Pinned measurements: label + (optional) dimension line, always on top. */
export class PinLayer {
  private group = new Group();
  private lines: DimLine[] = [];
  private labels: HTMLElement[] = [];
  private pins: PinDef[] = [];
  private visible = true;
  private host = document.getElementById('pins')!;

  constructor(private view: Viewport) {
    view.overlay.add(this.group);
    view.frameHooks.add(() => this.layout());
  }

  set(pins: PinDef[], visible: boolean): void {
    this.lines.forEach(line => (this.group.remove(line.group), line.dispose()));
    this.labels.forEach(label => label.remove());
    this.pins = pins;
    this.visible = visible;
    this.lines = [];
    this.labels = pins.map((pin) => {
      if (pin.a && pin.b) {
        const dimensionLine = new DimLine(this.view, 0x8fb4ff);
        dimensionLine.set(pin.a, pin.b);
        this.group.add(dimensionLine.group);
        this.lines.push(dimensionLine);
      }
      const tag = el('div', 'pin', pin.text);
      this.host.append(tag);

      return tag;
    });
    this.group.visible = visible;
    this.view.requestRender();
  }

  private layout(): void {
    this.lines.forEach(line => line.layout());
    this.pins.forEach((pin, i) => {
      const screenPoint = this.view.toScreen(pin.at);
      const tag = this.labels[i];
      tag.hidden = !this.visible || !screenPoint;
      if (screenPoint) {
        tag.style.transform = `translate(${Math.round(screenPoint[0])}px, ${Math.round(screenPoint[1])}px) translate(-50%, -50%)`;
      }
    });
  }
}
