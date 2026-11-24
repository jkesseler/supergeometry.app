// Quick actions: a short row of round buttons right beside whatever is
// picked - on the model a face, an edge, a point, a body, a sketch's shape, a
// plane, an axis, an image; in a sketch its curves and points - with the two
// tools most likely next for it (a flat face: Sketch, Move; a round one:
// Thread, Fillet; an edge: Chamfer, Move; a body: Fillet, Mirror; a sketch's
// curves: Construction, Delete). The most likely of all already has its handle
// on it (a face's arrow, an edge's fillet dot, a gimbal): these are the next
// ones. On the model the row ends with Delete and More, which opens every
// other tool the pick has (Shell among them); they are the very tools the line
// at the bottom offers for the pick (the same ToolItems).

import { icons } from '../ui/icons';
import { clampToFree } from './annotate';
import type { Vec3 } from '../doc/types';
import type { ToolItem } from '../ui/ui';
import type { Viewport } from '../view/viewport';

/** By kind of pick: the tools to offer, best first (the first two there are and can be used now). */
export const QUICK = {
  // (A freeform surface's face: Edit Freeform first - shaping it again is what it is for.)
  face: ['editFreeform', 'thread', 'sketch', 'move', 'fillet', 'thicken'],
  // (Fillet first, before Chamfer - asked for: "when I select an edge, I also want the fillet tool icon ... before
  // chamfer". Its dot is on the edge to drag as well.)
  edge: ['fillet', 'chamfer', 'move', 'thread', 'connect'],
  vertex: ['moveVertex', 'delete'],
  // (A body that is, or began as, a freeform: Edit Freeform first - asked for: "when I double click a freeform body,
  // I want the edit freeform button there".)
  body: ['editFreeform', 'fillet', 'mirror'],
  profile: ['extrude', 'revolve'],
  plane: ['sketch', 'plane'],
  axis: ['delete'],
  image: ['scale', 'delete'],
  // In a sketch: its picked curves and points (the sketch tool's own buttons).
  curve: ['construction', 'delete'],
  point: ['delete']
} satisfies Record<string, string[]>;

export type QuickKind = keyof typeof QUICK;

export interface QuickPlace {
  /** The pick's outward normal (a face's, a shape's): they go the other way from its arrow on the screen. */
  facing?: Vec3;
  /** Turned away (seen from behind): hidden (a body's face; a sketch's shape is seen from both sides). */
  hideBack?: boolean;
  /** How far from the point (px): further for a gimbal round it. */
  gap?: number;
}

/** At most this many: only the important things (the rest is under More at the row's end). */
const MOST = 2;
/**
 * An edge has three: Fillet, Chamfer and Move/Rotate Edge (asked for: "if I select an edge I want the move and
 * rotate edge icon there"). Move/Rotate Edge is for one straight edge: with a curved one, or several, it is not
 * offered and the row is the two.
 */
const MOST_OF: Partial<Record<QuickKind, number>> = { edge: 3 };

export class QuickActions {
  private readonly box = document.createElement('div');
  private readonly hook = () => this.layout();

  /** `items`: what the pick offers (the wheel's own list, its kinds' items too); `at`: the point it is shown beside. */
  static show(view: Viewport, kind: QuickKind, items: ToolItem[], at: Vec3, place: QuickPlace = {}, all = false): QuickActions | null {
    const byId = new Map<string, ToolItem>();
    const walk = (its: ToolItem[]) => {
      for (const it of its) {
        if (!byId.has(it.id)) {
          byId.set(it.id, it);
        }
        if (it.children?.length) {
          walk(it.children);
        }
      }
    };
    walk(items);
    const picked = (QUICK[kind] as readonly string[]).map(id => byId.get(id)).filter((it): it is ToolItem => !!it && !it.disabled && !!it.run && (!it.beta || it.id === 'editFreeform')).slice(0, MOST_OF[kind] ?? MOST);
    if (!all) {
      return picked.length ? new QuickActions(view, picked, at, place) : null;
    }
    // On the model: Delete beside them, and a last button that opens every other tool the pick has (asked for: "I
    // also want to have other tools there that could be used on that element. And also delete"). The few most likely
    // stay the row; the rest come up under it only when asked for, so nothing is crowded.
    const usable = (it: ToolItem | undefined): it is ToolItem => !!it && !it.disabled && !!it.run;
    const del = [byId.get('delete'), byId.get('deleteBody')].find(usable);
    const row = del && !picked.includes(del) ? [...picked, del] : picked;
    const rest: ToolItem[] = [];
    // (Beside a corner, not Move/Rotate Body: it moves the whole body, which is not what a corner was picked for -
    // asked for: "it doesn't make sense to be there". It is still under Transform on the line.)
    const skip = new Set(['deselect', 'reveal', 'color', 'opacity', 'material', 'wholePattern', ...(kind === 'vertex' ? ['move'] : [])]);
    const gather = (its: ToolItem[]) => {
      for (const it of its) {
        if (!it.label || it.id.startsWith('---') || skip.has(it.id) || it.disabled) {
          continue;
        }
        // (A tool that starts by itself is one button, its kinds a tap further inside it; a bare group is its tools.)
        if (it.run) {
          if (!row.includes(it) && !rest.some(r => r.label === it.label) && !row.some(r => r.label === it.label)) {
            rest.push(it);
          }
        } else if (it.children?.length) {
          gather(it.children);
        }
      }
    };
    gather(items);
    // (Just one more: it is a button of the row, before Delete - a More that opens a single button is a tap wasted.)
    if (rest.length === 1) {
      const one = rest.pop()!;
      row.splice(del && row.includes(del) ? row.indexOf(del) : row.length, 0, one);
    }

    return row.length || rest.length ? new QuickActions(view, row, at, place, rest) : null;
  }

  /** These very buttons (a tool's own choices, the one in use lit), beside `at`. */
  static of(view: Viewport, items: ToolItem[], at: Vec3, place: QuickPlace = {}): QuickActions {
    return new QuickActions(view, items, at, place);
  }

  private readonly facing?: Vec3;

  private constructor(
    private readonly view: Viewport,
    items: ToolItem[],
    private readonly at: Vec3,
    private readonly place: QuickPlace,
    rest: ToolItem[] = []
  ) {
    this.facing = place.facing;
    this.box.className = 'quick-actions';
    const button = (it: ToolItem) => {
      const b = document.createElement('button');
      b.className = `quick-action${it.active ? ' on' : ''}${it.id === 'delete' || it.id === 'deleteBody' ? ' danger' : ''}`;
      b.title = it.shortcut ? `${it.label} (${it.shortcut})` : it.label;
      b.setAttribute('aria-label', it.label);
      const icon = icons[it.icon as keyof typeof icons];
      b.innerHTML = `${icon ?? ''}<span>${shortName(it.label)}</span>`;
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        it.run?.();
      });

      return b;
    };
    const row = document.createElement('div');
    row.className = 'quick-row';
    for (const it of items) {
      row.append(button(it));
    }
    this.box.append(row);
    if (rest.length) {
      // The rest of what the pick offers: under the row, opened by its last button (and shut by it again).
      const more = document.createElement('button');
      more.className = 'quick-action quick-more';
      more.title = 'Every other tool for this';
      more.setAttribute('aria-label', 'More tools for this');
      more.innerHTML = `${icons.more ?? ''}<span>More</span>`;
      const grid = document.createElement('div');
      grid.className = 'quick-rest';
      grid.hidden = true;
      for (const it of rest) {
        grid.append(button(it));
      }
      more.addEventListener('click', (e) => {
        e.stopPropagation();
        grid.hidden = !grid.hidden;
        more.classList.toggle('on', !grid.hidden);
        this.layout();
      });
      row.append(more);
      this.box.append(grid);
    }
    // A press on them is theirs: never a pick on the model behind, nor the view turning.
    this.box.addEventListener('pointerdown', e => e.stopPropagation());
    document.body.append(this.box);
    view.frameHooks.add(this.hook);
    this.layout();
  }

  /** Below the point, clear of the handle on it (moved on with the view: only when the view is drawn again). */
  private layout(): void {
    const s = this.view.toScreen(this.at);
    let shown = !!s;
    if (s && this.facing && this.place.hideBack !== false) {
      const v = this.view.cam.viewDir();
      if (v.x * this.facing[0] + v.y * this.facing[1] + v.z * this.facing[2] > 0.05) {
        shown = false;
      }
    }
    this.box.hidden = !shown;
    if (!s || !shown) {
      return;
    }
    const hw = this.box.offsetWidth / 2;
    const hh = this.box.offsetHeight / 2;
    // (A face's arrow points out along its normal: they go the other way on the screen, not under it.)
    const first: [number, number][] = [];
    if (this.facing) {
      const k = this.view.cam.worldPerPixel(this.view.height) * 60;
      const tip = this.view.toScreen([this.at[0] + this.facing[0] * k, this.at[1] + this.facing[1] * k, this.at[2] + this.facing[2] * k]);
      const dx = tip ? s[0] - tip[0] : 0;
      const dy = tip ? s[1] - tip[1] : 0;
      const l = Math.hypot(dx, dy);
      if (l > 8) {
        const d = Math.abs((dx / l) * hw) + Math.abs((dy / l) * hh) + (this.place.gap ?? 34);
        first.push([s[0] + (dx / l) * d, s[1] + (dy / l) * d]);
      }
    }
    const g = this.place.gap ?? 46;
    const spots: [number, number][] = [
      ...first,
      [s[0], s[1] + g + hh],
      [s[0], s[1] - g - hh],
      [s[0] - g - hw, s[1]],
      [s[0] + g + hw, s[1]]
    ].map(p => clampToFree(p as [number, number], hw, hh));
    // (Nor under a value box on the model - an extrude's distance, beside its arrow.)
    const boxes = [...document.querySelectorAll<HTMLElement>('.dim-widget')].map(b => b.getBoundingClientRect()).filter(r => r.width > 0);
    const clear = ([x, y]: [number, number]) => !boxes.some(r => x + hw + 6 > r.left && x - hw - 6 < r.right && y + hh + 6 > r.top && y - hh - 6 < r.bottom);
    const [x, y] = spots.find(clear) ?? spots[0];
    this.box.style.transform = `translate(${Math.round(x - hw)}px, ${Math.round(y - hh)}px)`;
  }

  dispose(): void {
    this.view.frameHooks.delete(this.hook);
    this.box.remove();
  }
}

/** A short name under the icon ("Move/Rotate Edge" → "Move"). */
function shortName(label: string): string {
  const s = label.replace(/…$/, '').split(/[/ –]/)[0];

  return s.length > 12 ? s.slice(0, 11) + '…' : s;
}
