// Subtract / Intersect as a tool: the body to change (+) and the bodies to
// change it with (−), picked in turn; keep either side if wanted.

import { add, scale } from '../geom';
import { DimWidget } from './annotate';
import { FeatureOp, type Slot } from './featureOp';
import { bodyCenter } from './ops';
import type { PanelItem } from '../ui/ui';
import type { BooleanFeature, Vec3 } from '../doc/types';
import type { AppContext } from './tool';

const cap = (text: string) => text[0].toUpperCase() + text.slice(1);

export class BooleanOp extends FeatureOp<BooleanFeature> {
  readonly id = 'boolean';
  private marks: HTMLDivElement[] = [];
  private centers = new Map<string, Vec3>();
  private hook = () => this.placeMarks();

  constructor(app: AppContext, op: 'subtract' | 'intersect', target = '', tools: string[] = [], existing?: BooleanFeature) {
    super(app, { ...app.store.newIdentity('boolean', cap(op)), type: 'boolean', op, target, tools: tools.filter(t => t !== target) }, existing);
    const sub = this.feature.op === 'subtract';
    // Not this subtract's own result: with "Keep modified body" on, its preview
    // shows beside the original, and a tap on it made it one of its own tools.
    const own = (b: string) => b === this.feature.id || b.startsWith(`${this.feature.id}:`);
    const bodyOf = (hit: { kind: string; body?: string }) => {
      const b = hit.kind === 'body' || hit.kind === 'face' || hit.kind === 'edge' || hit.kind === 'vertex' ? hit.body ?? null : null;

      return b && !own(b) ? b : null;
    };
    const targetSlot: Slot = {
      label: sub ? 'Remove from' : 'Body',
      describe: () => (this.feature.target ? this.nameOf(this.feature.target) : 'Tap a body'),
      filled: () => !!this.feature.target,
      pick: { profiles: false, planes: false, axes: false },
      shows: () => (this.feature.target ? [{ kind: 'body', body: this.feature.target }] : []),
      accept: (hit) => {
        const b = bodyOf(hit);
        if (!b) {
          return false;
        }
        this.feature.target = b;
        this.feature.tools = this.feature.tools.filter(t => t !== b);
        // (Worked out again for the bodies as now picked.)
        this.feature.whole = undefined;

        return true;
      }
    };
    const toolsSlot: Slot = {
      label: sub ? 'Subtract' : 'With',
      multi: true,
      describe: () => (this.feature.tools.length ? `${this.feature.tools.length} bod${this.feature.tools.length > 1 ? 'ies' : 'y'}` : 'Tap bodies'),
      filled: () => this.feature.tools.length > 0,
      pick: { profiles: false, planes: false, axes: false },
      shows: () => this.feature.tools.map(body => ({ kind: 'body' as const, body })),
      accept: (hit) => {
        const b = bodyOf(hit);
        if (!b || b === this.feature.target) {
          return false;
        }
        const t = this.feature.tools;
        this.feature.tools = t.includes(b) ? t.filter(tool => tool !== b) : [...t, b];
        this.feature.whole = undefined;

        return true;
      }
    };
    this.slots = [targetSlot, toolsSlot];
  }

  /** Names seen (while its preview is being made, a body can be missing from the list). */
  private names = new Map<string, string>();

  private nameOf(id: string): string {
    const name = this.app.store.doc.names?.[id] ?? this.app.view.bodyList.find(b => b.id === id)?.name ?? this.names.get(id);
    if (name) {
      this.names.set(id, name);
    }

    return name ?? 'Body';
  }

  protected hint(): string {
    return this.feature.op === 'subtract'
      ? 'Tap the body to cut, then the bodies to cut away from it.'
      : 'Tap a body, then the bodies it overlaps. Only the part they share is kept.';
  }

  /** Which bodies give way to the clearance, named after the bodies picked. */
  private sides(): { id: string; label: string }[] {
    const t = this.feature.tools;

    return [
      { id: 'body', label: this.feature.target ? this.nameOf(this.feature.target) : 'Body' },
      { id: 'tools', label: t.length === 1 ? this.nameOf(t[0]) : 'The others' },
      { id: 'all', label: t.length > 1 ? 'All' : 'Both' }
    ];
  }

  private setSide(id: string): void {
    this.feature.cutFrom = id === 'body' ? undefined : (id as 'tools' | 'all');
    this.render();
    this.update();
  }

  private setClearance(value: number): void {
    if (!(value >= 0)) {
      return;
    }
    this.feature.clearance = value || undefined;
    this.app.ui.updatePanelValues([value]);
    this.dim?.setValue(value);
    this.update();
  }

  protected items(): PanelItem[] {
    const feature = this.feature;
    const sub = feature.op === 'subtract';
    const gap: PanelItem[] = sub
      ? [
        { ...this.num('Clearance', 'clearance', 'length', { min: 0, onInput: value => this.setClearance(value), inBox: true }), value: feature.clearance ?? 0 } as PanelItem,
        { type: 'choice', label: 'Cut from', options: this.sides(), value: feature.cutFrom ?? 'body', onChange: id => this.setSide(id) }
      ]
      : [];
    // The others give way (or all do): every body stays, changed.
    if (sub && feature.cutFrom) {
      return gap;
    }

    return [
      ...gap,
      { type: 'toggle', label: 'Keep modified body', value: !!feature.keepTarget, onChange: isOn => ((feature.keepTarget = isOn || undefined), this.render(), this.update()) },
      { type: 'toggle', label: sub ? 'Keep subtracted bodies' : 'Keep intersecting bodies', value: !!feature.keepTools, onChange: isOn => ((feature.keepTools = isOn || undefined), this.render(), this.update()) }
    ];
  }

  enter(): void {
    super.enter();
    this.app.view.frameHooks.add(this.hook);
    this.placeMarks();
  }

  exit(): void {
    this.dim?.dispose();
    this.dim = null;
    this.app.view.frameHooks.delete(this.hook);
    for (const mark of this.marks) {
      mark.remove();
    }
    this.marks = [];
    super.exit();
  }

  /** The clearance, typed between the body and the first body it's subtracted with. */
  private dim: DimWidget | null = null;
  /** The names in its drop-down (made again when the bodies picked change). */
  private dimSides = '';

  protected onDraftChanged(): void {
    this.placeMarks();
    const feature = this.feature;
    const a = this.centers.get(feature.target), b = feature.tools[0] ? this.centers.get(feature.tools[0]) : undefined;
    const sides = this.sides();
    const key = JSON.stringify(sides);
    if (feature.op !== 'subtract' || !a || !b || key !== this.dimSides) {
      this.dim?.dispose();
      this.dim = null;
    }
    if (feature.op !== 'subtract' || !a || !b) {
      return;
    }
    this.dimSides = key;
    this.dim ??= new DimWidget(this.app.view, {
      noLine: true,
      value: feature.clearance ?? 0,
      modes: sides,
      mode: feature.cutFrom ?? 'body',
      onMode: id => this.setSide(id),
      onInput: (value, text) => {
        if (!(value >= 0)) {
          return;
        }
        this.typedInto('clearance', text);
        this.setClearance(value);
      },
      onCommit: () => this.done()
    });
    const [boxPoint, q] = this.boxAt(scale(add(a, b), 0.5));
    this.boxPoint = boxPoint;
    this.dim.set(boxPoint, q);
    this.dim.setMode(feature.cutFrom ?? 'body');
    this.dim.setValue(feature.clearance ?? 0);
    // (The signs again, clear of the box just made.)
    this.placeMarks();
  }

  /**
   * The sign on `body` turned the other way: a "−" body becomes the one
   * changed, the one that was takes its place among the others; the "+" body
   * swaps with the first of the others.
   */
  private swap(body: string): void {
    const feature = this.feature;
    if (!feature.target || !feature.tools.length) {
      return;
    }
    const other = body === feature.target ? feature.tools[0] : body;
    if (!feature.tools.includes(other)) {
      return;
    }
    feature.tools = feature.tools.map(t => (t === other ? feature.target : t));
    feature.target = other;
    feature.whole = undefined;
    this.render();
    this.update();
    this.placeMarks();
  }

  /** "+" on the body that's changed, "−" on each body it's changed with. */
  /**
   * Where the clearance box goes: between the two bodies, or - when that's
   * over a body (a tray's middle, its pockets still to be tapped) - further
   * down the screen, clear of them. (It sat on the pockets; its number pad,
   * opened by a tap meant for one, covered half the tray.)
   */
  private boxPoint: Vec3 | null = null;

  private boxAt(mid: Vec3): [Vec3, Vec3] {
    const view = this.app.view;
    const screenPoint = view.toScreen(mid);
    if (!screenPoint) {
      return [mid, mid];
    }
    const over = (y: number) => [-90, 0, 90].some(dx => view.pick(screenPoint[0] + dx, y, { edgeTolPx: 24, planes: false }));
    if (!over(screenPoint[1])) {
      return [mid, mid];
    }
    let y = screenPoint[1];
    while (y < view.height - 160 && over(y)) {
      y += 20;
    }
    if (over(y)) {
      return [mid, mid];
    }
    const worldPoint = view.worldUnder(screenPoint[0], y).toArray() as Vec3;

    return [worldPoint, worldPoint];
  }

  private placeMarks(): void {
    const want: [string, string][] = [];
    if (this.feature.target) {
      want.push([this.feature.target, '+']);
    }
    // Many taken away (eight pockets out of a tray): only the first keeps its
    // sign - the rest, pushed aside to clear each other, landed on bodies still
    // to be tapped, and a tap meant for a pocket swapped the tray out instead.
    for (const t of this.feature.tools.length > 2 ? this.feature.tools.slice(0, 1) : this.feature.tools) {
      want.push([t, '−']);
    }
    while (this.marks.length > want.length) {
      this.marks.pop()!.remove();
    }
    while (this.marks.length < want.length) {
      const element = document.createElement('div');
      element.className = 'bool-mark';
      // A tap on a sign turns it the other way round: picked in the wrong order, fixed in one tap.
      element.addEventListener('pointerdown', e => e.stopPropagation());
      element.addEventListener('click', (e) => {
        e.stopPropagation();
        if (element.dataset.body) {
          this.swap(element.dataset.body);
        }
      });
      document.body.append(element);
      this.marks.push(element);
    }
    const rect = this.app.view.canvas.getBoundingClientRect();
    // (Bodies sharing a middle - a peg through a plate - get their signs side by side, each one tappable.)
    const placed: [number, number][] = [];
    // (And clear of the clearance's box, which sits between the first two bodies.)
    const a = this.centers.get(this.feature.target), b = this.feature.tools[0] ? this.centers.get(this.feature.tools[0]) : undefined;
    const box = this.dim && a && b ? this.app.view.toScreen(this.boxPoint ?? scale(add(a, b), 0.5)) : null;
    want.forEach(([body, sign], i) => {
      const mark = this.marks[i];
      mark.dataset.body = body;
      mark.title = sign === '+' ? 'Changed - tap to change it with this one instead' : 'Changed with - tap to change this one instead';
      mark.classList.toggle('minus', sign !== '+');
      // (Where the body was: in the preview a subtracted body is used up.)
      if (this.app.view.bodyList.some(b => b.id === body)) {
        this.centers.set(body, bodyCenter(this.app, [body]));
      }
      const at = this.centers.get(body);
      const screenPoint = at ? this.app.view.toScreen(at) : null;
      mark.hidden = !screenPoint;
      if (!screenPoint) {
        return;
      }
      let x = screenPoint[0], y = screenPoint[1];
      if (box && Math.abs(box[0] - x) < 100 && Math.abs(box[1] - y) < 36) {
        y = box[1] - 36;
      }
      while (placed.some(([px, py]) => Math.abs(px - x) < 30 && Math.abs(py - y) < 30)) {
        x += 32;
      }
      placed.push([x, y]);
      mark.style.transform = `translate(${Math.round(rect.left + x - 14)}px, ${Math.round(rect.top + y - 14)}px)`;
    });
  }
}
