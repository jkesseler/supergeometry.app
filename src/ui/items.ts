// Items panel: every body, sketch, plane, axis and image, with visibility
// toggles - plus folders (at the bottom) to group any of them.

import { icons, type IconName } from './icons';
import { el, twoTap } from './ui';
import type { DocStore } from '../doc/store';
import type { Feature, ItemFolder } from '../doc/types';
import type { RegenResult } from '../kernel/protocol';

export interface ItemsHandlers {
  selectBody(id: string): void;
  editSketch(id: string): void;
  selectPlane(id: string): void;
  selectImage(id: string): void;
  deleteBody(id: string): void;
  deleteFeature(id: string): void;
  /** Rename a body (custom name) or a feature (its history name). */
  rename(id: string, current: string, isBody: boolean): void;
  /** Ask for a name (folders). */
  askName(title: string, current: string): Promise<string | null>;
  isolated(): string[] | null;
}

interface Row {
  id: string;
  name: string;
  icon: IconName;
  open(): void;
  remove(): void;
  extra?: string;
  isBody?: boolean;
}

export class ItemsPanel {
  private el = document.getElementById('items')!;
  private list = document.getElementById('items-list')!;
  /** Rows ticked for grouping (Ctrl/Shift+click, or the checkboxes in Select mode). */
  private checked = new Set<string>();
  private picking = false;
  /** Move pressed: the folders get ticks - the one ticked takes the ticked items. */
  private moving = false;
  private collapsed = new Set<string>();
  private last: RegenResult | null = null;

  constructor(
    private store: DocStore,
    private h: ItemsHandlers
  ) {
    document.getElementById('items-btn')!.addEventListener('click', () => this.toggle());
    document.getElementById('items-close')!.innerHTML = icons.close;
    document.getElementById('items-close')!.addEventListener('click', () => this.toggle(false));
    const pick = document.getElementById('items-pick')!;
    pick.addEventListener('click', () => {
      // Ticks made with Ctrl/Shift+click (Select off): Select clears them.
      if (!this.picking && this.checked.size) {
        this.checked.clear();
        this.render(this.last);

        return;
      }
      this.picking = !this.picking;
      if (!this.picking) {
        this.checked.clear();
      }
      pick.classList.toggle('on', this.picking);
      this.render(this.last);
    });
  }

  toggle(open?: boolean): void {
    const on = this.el.classList.toggle('open', open);
    // Phones and narrow tablets (an iPad mini upright): one panel at a time (Items or History).
    if (on && window.innerWidth < 760) {
      document.getElementById('history')?.classList.remove('open');
      document.body.classList.remove('history-open');
    }
    // The tool column steps aside while Items is open.
    document.body.classList.toggle('items-open', on);
    // The value panel and tool column re-fit around it.
    window.dispatchEvent(new Event('resize'));
  }

  private get folders(): ItemFolder[] {
    return this.store.doc.folders ?? [];
  }

  private shown = '';

  render(result: RegenResult | null): void {
    this.last = result;
    // Nothing that the list shows changed: keep the rows (rebuilding them under a
    // click that's in progress would swallow that click).
    const doc = this.store.doc;
    const sig = JSON.stringify([
      doc.hidden, doc.names, doc.folders, this.h.isolated(), [...this.checked], this.picking, this.moving, [...this.collapsed],
      result?.bodies.map(b => [b.id, b.name]),
      doc.features.filter(feature => ['sketch', 'plane', 'axis', 'image'].includes(feature.type)).map(feature => [feature.id, feature.name, feature.type])
    ]);
    if (sig === this.shown) {
      return;
    }
    this.shown = sig;
    this.list.innerHTML = '';
    const hidden = new Set(this.store.doc.hidden);
    const iso = this.h.isolated();
    const inFolder = new Set(this.folders.flatMap(folder => folder.items));
    const section = (title: string) => this.list.append(el('li', 'items-heading', title));

    // Everything there is, by kind.
    const bodies = result?.bodies ?? [];
    const names = this.store.doc.names ?? {};
    const feats = this.store.doc.features;
    const of = <T extends Feature['type']>(t: T) => feats.filter(feature => feature.type === t);
    const rows: Record<string, Row[]> = {
      Bodies: bodies.map(b => ({ id: b.id, name: names[b.id] ?? b.name, icon: 'body' as IconName, open: () => this.h.selectBody(b.id), remove: () => this.h.deleteBody(b.id), extra: iso && !iso.includes(b.id) ? ' isolated-out' : '', isBody: true })),
      // Greyed while something else is isolated (they're hidden until Isolate is off).
      Sketches: of('sketch').map(feature => ({ id: feature.id, name: feature.name, icon: 'sketch' as IconName, open: () => this.h.editSketch(feature.id), remove: () => this.h.deleteFeature(feature.id), extra: iso && !iso.includes(feature.id) ? ' isolated-out' : '' })),
      'Planes & axes': [...of('plane'), ...of('axis')].map(feature => ({ id: feature.id, name: feature.name, icon: (feature.type === 'plane' ? PLANE_ICON[(feature as { kind?: string }).kind ?? 'offset'] ?? 'plane' : AXIS_ICON[(feature as { kind?: string }).kind ?? ''] ?? 'axis') as IconName, open: () => this.h.selectPlane(feature.id), remove: () => this.h.deleteFeature(feature.id), extra: iso && !iso.includes(feature.id) ? ' isolated-out' : '' })),
      Images: of('image').map(i => ({ id: i.id, name: i.name, icon: 'image' as IconName, open: () => this.h.selectImage(i.id), remove: () => this.h.deleteFeature(i.id) }))
    };
    const byId = new Map(Object.values(rows).flat().map(row => [row.id, row]));

    // Each kind folds away under its heading (a long list of sketches and
    // planes buried the bodies).
    const category = (title: string, count: number) => {
      const key = `cat:${title}`;
      const li = el('li', 'items-heading items-category');
      const b = el('button', 'items-category-btn', `${this.collapsed.has(key) ? '▸' : '▾'} ${title} (${count})`);
      b.title = this.collapsed.has(key) ? 'Show' : 'Fold away';
      b.addEventListener('click', () => {
        if (this.collapsed.has(key)) {
          this.collapsed.delete(key);
        } else {
          this.collapsed.add(key);
        }
        this.render(this.last);
      });
      li.append(b);
      this.list.append(li);

      return !this.collapsed.has(key);
    };
    for (const [title, list] of Object.entries(rows)) {
      const loose = list.filter(row => !inFolder.has(row.id));
      if (title !== 'Bodies' && !loose.length) {
        continue;
      }
      if (!category(title, loose.length)) {
        continue;
      }
      if (!loose.length) {
        this.list.append(el('li', 'items-empty', bodies.length ? 'All in folders' : 'No bodies yet'));
      }
      for (const row of loose) {
        this.row(row, hidden, 0);
      }
    }

    // Folders last, each with its subfolders and then what it holds.
    const ids = new Set(this.folders.map(folder => folder.id));
    const top = this.folders.filter(folder => !folder.parent || !ids.has(folder.parent));
    const subs = (itemFolder: ItemFolder) => this.folders.filter(folder => folder.parent === itemFolder.id && folder.id !== itemFolder.id);
    const rowsOf = (itemFolder: ItemFolder) => itemFolder.items.map(id => byId.get(id)).filter((row): row is Row => !!row);
    const allRows = (itemFolder: ItemFolder, seen = new Set<string>()): Row[] => {
      if (seen.has(itemFolder.id)) {
        return [];
      }
      seen.add(itemFolder.id);

      return [...rowsOf(itemFolder), ...subs(itemFolder).flatMap(subfolder => allRows(subfolder, seen))];
    };
    const drawFolder = (itemFolder: ItemFolder, depth: number, seen: Set<string>) => {
      if (seen.has(itemFolder.id)) {
        return;
      }
      seen.add(itemFolder.id);
      this.folderRow(itemFolder, allRows(itemFolder), hidden, depth);
      if (this.collapsed.has(itemFolder.id)) {
        return;
      }
      for (const subfolder of subs(itemFolder)) {
        drawFolder(subfolder, depth + 1, seen);
      }
      for (const row of rowsOf(itemFolder)) {
        this.row(row, hidden, depth + 1);
      }
    };
    if (top.length) {
      section(`Folders (${top.length})`);
    }
    const drawn = new Set<string>();
    for (const itemFolder of top) {
      drawFolder(itemFolder, 0, drawn);
    }

    // Grouping bar.
    if (!this.checked.size) {
      this.moving = false;
    }
    if (this.checked.size) {
      const bar = el('li', 'items-groupbar');
      // All ticked items in the same folder: the new folder goes inside it.
      const homes = new Set([...this.checked].map(id => this.folders.find(folder => folder.items.includes(id))?.id ?? ''));
      const parent = homes.size === 1 ? [...homes][0] || undefined : undefined;
      const make = el('button', 'text-btn primary', `${parent ? 'New subfolder' : 'New folder'} (${this.checked.size})`);
      make.addEventListener('click', () => void this.makeFolder(parent));
      // (No Clear: Select at the top again clears the ticks.)
      bar.append(make);
      // Ticked items that are in a folder: Remove takes them out - one level up
      // (into the folder around a subfolder), or back among the loose ones.
      const filed = [...this.checked].filter(id => inFolder.has(id));
      if (filed.length) {
        const remove = el('button', 'text-btn', `Remove (${filed.length})`);
        remove.title = 'Take the ticked items out of their folders';
        remove.addEventListener('click', () => {
          this.checked.clear();
          this.store.commit((draft) => {
            const fs = draft.folders ?? [];
            const up = new Map<string, string[]>();
            for (const itemFolder of fs) {
              const out = itemFolder.items.filter(item => filed.includes(item));
              if (out.length && itemFolder.parent && fs.some(otherFolder => otherFolder.id === itemFolder.parent)) {
                up.set(itemFolder.parent, [...(up.get(itemFolder.parent) ?? []), ...out]);
              }
            }
            draft.folders = fs.map(itemFolder => ({ ...itemFolder, items: [...itemFolder.items.filter(item => !filed.includes(item)), ...(up.get(itemFolder.id) ?? [])] }));
          });
        });
        bar.append(remove);
      }
      // Move: then tick the folder (or subfolder) they go into.
      if (this.folders.length) {
        const move = el('button', `text-btn${this.moving ? ' primary' : ''}`, this.moving ? 'Cancel move' : `Move (${this.checked.size})`);
        move.title = 'Move the ticked items into another folder';
        move.addEventListener('click', () => ((this.moving = !this.moving), this.render(this.last)));
        bar.append(move);
        if (this.moving) {
          bar.append(el('span', 'items-groupbar-hint', 'Tick the folder to move them into.'));
        }
      }
      this.list.append(bar);
    } else if (this.picking) {
      this.list.append(el('li', 'items-empty', 'Tick items, then make a folder of them.'));
    }
  }

  private row(row: Row, hidden: Set<string>, depth: number): void {
    const li = el('li', `items-row${hidden.has(row.id) ? ' hidden-item' : ''}${row.extra ?? ''}${this.checked.has(row.id) ? ' checked' : ''}${depth ? ' in-folder' : ''}`);
    // Deeper in subfolders: a step further in each level.
    if (depth > 1) {
      li.style.paddingLeft = `${18 * depth}px`;
    }
    if (this.picking) {
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.className = 'items-check';
      box.checked = this.checked.has(row.id);
      box.addEventListener('change', () => this.check(row.id, box.checked));
      li.append(box);
    }
    const eye = el('button', 'icon-btn');
    eye.title = hidden.has(row.id) ? 'Show' : 'Hide';
    eye.innerHTML = icons[hidden.has(row.id) ? 'eyeOff' : 'eye'];
    eye.addEventListener('click', (e) => {
      e.stopPropagation();
      this.store.commit(draft => (draft.hidden = hidden.has(row.id) ? draft.hidden.filter(hiddenId => hiddenId !== row.id) : [...draft.hidden, row.id]));
    });
    const label = el('button', 'items-name');
    label.innerHTML = icons[row.icon];
    label.append(row.name);
    // Ctrl/Cmd/Shift+click ticks the row for grouping; a plain click opens it.
    label.addEventListener('click', e => (e.ctrlKey || e.metaKey || e.shiftKey || this.picking ? this.check(row.id, !this.checked.has(row.id)) : row.open()));
    const ren = el('button', 'icon-btn');
    ren.title = 'Rename';
    ren.innerHTML = icons.rename;
    ren.addEventListener('click', e => (e.stopPropagation(), this.h.rename(row.id, row.name, !!row.isBody)));
    const del = el('button', 'icon-btn');
    del.title = 'Delete';
    del.innerHTML = icons.trash;
    twoTap(del, `items:${row.id}`, () => row.remove());
    li.append(eye, label, ren, del);
    li.dataset.id = row.id;
    li.classList.toggle('selected', this.selectedIds.has(row.id));
    li.classList.toggle('flash', this.revealed.has(row.id));
    this.list.append(li);
  }

  /**
   * Reveal in Items: the panel opens, the folders and headings holding the
   * rows unfold, and the first is scrolled to. The rows pulse until the
   * next thing done (a tap anywhere, a key).
   */
  private revealed = new Set<string>();
  private unreveal: (() => void) | null = null;
  reveal(ids: string[]): void {
    this.toggle(true);
    const want = new Set(ids);
    this.unreveal?.();
    this.revealed = want;
    const stop = () => {
      this.unreveal = null;
      this.revealed = new Set();
      removeEventListener('pointerdown', stop, true);
      removeEventListener('keydown', stop, true);
      for (const li of this.list.querySelectorAll<HTMLElement>('li.flash')) {
        li.classList.remove('flash');
      }
    };
    this.unreveal = stop;
    // (After the tap that asked for it has ended.)
    setTimeout(() => {
      if (this.unreveal !== stop) {
        return;
      }
      addEventListener('pointerdown', stop, true);
      addEventListener('keydown', stop, true);
    });
    const byId = new Map(this.folders.map(folder => [folder.id, folder]));
    for (const folder of this.folders) {
      if (folder.items.some(i => want.has(i))) {
        for (let itemFolder: ItemFolder | undefined = folder; itemFolder; itemFolder = itemFolder.parent ? byId.get(itemFolder.parent) : undefined) {
          this.collapsed.delete(itemFolder.id);
        }
      }
    }
    this.render(this.last);
    const find = () => [...this.list.querySelectorAll<HTMLElement>('li[data-id]')].find(li => want.has(li.dataset.id!));
    let li = find();
    if (!li) {
      // Under a heading folded away: the headings open.
      for (const collapsedKey of [...this.collapsed]) {
        if (collapsedKey.startsWith('cat:')) {
          this.collapsed.delete(collapsedKey);
        }
      }
      this.render(this.last);
      li = find();
    }
    for (const element of this.list.querySelectorAll<HTMLElement>('li[data-id]')) {
      element.classList.toggle('flash', want.has(element.dataset.id!));
    }
    li?.scrollIntoView({ block: 'center' });
  }

  /** What's selected in the view (a body double-clicked, a plane…): its row lights up. */
  private selectedIds = new Set<string>();
  markSelected(ids: string[]): void {
    const next = new Set(ids);
    if (next.size === this.selectedIds.size && ids.every(id => this.selectedIds.has(id))) {
      return;
    }
    this.selectedIds = next;
    let first: HTMLElement | null = null;
    for (const li of this.list.querySelectorAll<HTMLElement>('li[data-id]')) {
      const on = next.has(li.dataset.id!);
      li.classList.toggle('selected', on);
      if (on && !first) {
        first = li;
      }
    }
    // Scrolled out of sight in a long list: brought into view.
    if (first && !this.el.hidden) {
      first.scrollIntoView({ block: 'nearest' });
    }
  }

  /** A folder's row; `items` is everything in it, its subfolders' too. */
  private folderRow(itemFolder: ItemFolder, items: Row[], hidden: Set<string>, depth = 0): void {
    const li = el('li', `items-row folder-row${depth ? ' in-folder' : ''}${this.moving ? ' move-target' : ''}`);
    if (depth > 1) {
      li.style.paddingLeft = `${18 * depth}px`;
    }
    // Moving: tick this folder to put the ticked items in it.
    if (this.moving) {
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.className = 'items-check';
      box.title = `Move into ${itemFolder.name}`;
      box.addEventListener('change', () => this.moveInto(itemFolder.id));
      li.append(box);
    }
    const allHidden = items.length > 0 && items.every(item => hidden.has(item.id));
    const eye = el('button', 'icon-btn');
    eye.title = allHidden ? 'Show all in folder' : 'Hide all in folder';
    eye.innerHTML = icons[allHidden ? 'eyeOff' : 'eye'];
    eye.addEventListener('click', () =>
      this.store.commit((draft) => {
        const ids = new Set(items.map(item => item.id));
        draft.hidden = allHidden ? draft.hidden.filter(hiddenId => !ids.has(hiddenId)) : [...new Set([...draft.hidden, ...ids])];
      })
    );
    const label = el('button', 'items-name');
    label.innerHTML = icons.folder;
    label.append(itemFolder.name, el('span', 'items-count', ` ${items.length}`), el('span', 'items-caret', this.collapsed.has(itemFolder.id) ? ' ▸' : ' ▾'));
    label.title = 'Show / hide its contents';
    label.addEventListener('click', () => {
      if (this.collapsed.has(itemFolder.id)) {
        this.collapsed.delete(itemFolder.id);
      } else {
        this.collapsed.add(itemFolder.id);
      }
      this.render(this.last);
    });
    const ren = el('button', 'icon-btn');
    ren.title = 'Rename folder';
    ren.innerHTML = icons.rename;
    ren.addEventListener('click', async () => {
      const name = await this.h.askName('Rename folder', itemFolder.name);
      if (name) {
        this.store.commit(draft => (draft.folders = (draft.folders ?? []).map(folder => (folder.id === itemFolder.id ? { ...folder, name } : folder))));
      }
    });
    const del = el('button', 'icon-btn');
    del.title = "Remove folder (keeps what's in it)";
    del.innerHTML = icons.trash;
    // What it held - items and subfolders - moves up to where it was.
    twoTap(del, `folder:${itemFolder.id}`, () =>
      this.store.commit((draft) => {
        const fs = draft.folders ?? [];
        const parent = itemFolder.parent && fs.some(otherFolder => otherFolder.id === itemFolder.parent) ? itemFolder.parent : undefined;
        draft.folders = fs
          .filter(folder => folder.id !== itemFolder.id)
          .map(folder => (folder.id === parent ? { ...folder, items: [...folder.items, ...itemFolder.items] } : folder.parent === itemFolder.id ? { ...folder, parent } : folder));
      })
    );
    li.append(eye, label, ren, del);
    this.list.append(li);
  }

  /** The ticked items into folder `id` (out of whichever folder they were in). */
  private moveInto(id: string): void {
    const ids = [...this.checked];
    this.checked.clear();
    this.moving = false;
    this.store.commit(draft => (draft.folders = (draft.folders ?? []).map(itemFolder => ({ ...itemFolder, items: itemFolder.id === id ? [...itemFolder.items.filter(item => !ids.includes(item)), ...ids] : itemFolder.items.filter(item => !ids.includes(item)) }))));
  }

  private check(id: string, on: boolean): void {
    if (on) {
      this.checked.add(id);
    } else {
      this.checked.delete(id);
    }
    this.render(this.last);
  }

  /** A folder of the ticked items; `parent`: inside that folder (a subfolder). */
  private async makeFolder(parent?: string): Promise<void> {
    const ids = [...this.checked];
    const name = await this.h.askName(parent ? 'New subfolder' : 'New folder', `Folder ${this.folders.length + 1}`);
    if (!name) {
      return;
    }
    this.checked.clear();
    this.picking = false;
    document.getElementById('items-pick')!.classList.remove('on');
    // An item lives in one folder at a time.
    this.store.commit((draft) => {
      const rest = (draft.folders ?? []).map(itemFolder => ({ ...itemFolder, items: itemFolder.items.filter(item => !ids.includes(item)) }));
      draft.folders = [...rest, { id: `folder-${Date.now().toString(36)}`, name, items: ids, ...(parent ? { parent } : {}) }];
    });
  }
}

/** Each kind of construction plane's icon (its mark big, the plane small). */
/** Each kind of axis's icon (an axis from before they were told apart: the plain one). */
const AXIS_ICON: Record<string, IconName> = { face: 'axisFace', edge: 'axisEdge', round: 'axisRound', '2pt': 'axis2pt', planes: 'axisPlanes' };

const PLANE_ICON: Record<string, IconName> = { offset: 'planeOffset', mid: 'planeMid', '3pt': 'plane3pt', curve: 'planeCurve', perp: 'planePerp', angle: 'planeAngle', parallel: 'planeParallel' };
