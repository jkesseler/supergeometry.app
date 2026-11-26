// Items panel: every body, sketch, plane, axis and image, with visibility
// toggles - plus folders (at the bottom) to group any of them.

import { render as mount } from 'preact';
import { TwoTapButton } from './components';
import { icons, type IconName } from './icons';
import type { DocStore } from '../doc/store';
import type { Feature, ItemFolder, ProjectDoc } from '../doc/types';
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

interface ItemsState {
  checked: Set<string>;
  isPicking: boolean;
  isMoving: boolean;
  collapsed: Set<string>;
  selected: Set<string>;
  revealed: Set<string>;
}

interface ItemsActions {
  check(id: string, on: boolean): void;
  toggleCollapsed(key: string): void;
  toggleHidden(id: string, isHidden: boolean): void;
  toggleFolderHidden(ids: string[], allHidden: boolean): void;
  renameFolder(folder: ItemFolder): void;
  deleteFolder(folder: ItemFolder): void;
  removeFromFolders(ids: string[]): void;
  toggleMoving(): void;
  moveInto(id: string): void;
  makeFolder(parent?: string): void;
  rename(id: string, current: string, isBody: boolean): void;
}

interface ItemsListProps {
  doc: ProjectDoc;
  result: RegenResult | null;
  isolated: string[] | null;
  state: ItemsState;
  handlers: ItemsHandlers;
  actions: ItemsActions;
}

interface ItemRowProps {
  row: Row;
  isHidden: boolean;
  depth: number;
  state: ItemsState;
  actions: ItemsActions;
}

function indent(depth: number) {
  // Deeper in subfolders: a step further in each level.
  return depth > 1 ? { paddingLeft: `${18 * depth}px` } : undefined;
}

function ItemRow({ row, isHidden, depth, state, actions }: ItemRowProps) {
  const isChecked = state.checked.has(row.id);
  const className = [
    'items-row',
    isHidden && 'hidden-item',
    row.extra?.trim(),
    isChecked && 'checked',
    depth && 'in-folder',
    state.selected.has(row.id) && 'selected',
    state.revealed.has(row.id) && 'flash'
  ].filter(Boolean).join(' ');

  return (
    <li class={className} style={indent(depth)} data-id={row.id}>
      {state.isPicking && <input type="checkbox" class="items-check" checked={isChecked} onChange={event => actions.check(row.id, event.currentTarget.checked)} />}
      <button
        class="icon-btn"
        title={isHidden ? 'Show' : 'Hide'}
        onClick={(event) => {
          event.stopPropagation();
          actions.toggleHidden(row.id, isHidden);
        }}
        dangerouslySetInnerHTML={{ __html: icons[isHidden ? 'eyeOff' : 'eye'] }}
      />
      {/* Ctrl/Cmd/Shift+click ticks the row for grouping; a plain click opens it. */}
      <button
        class="items-name"
        onClick={event => (event.ctrlKey || event.metaKey || event.shiftKey || state.isPicking ? actions.check(row.id, !isChecked) : row.open())}
      >
        <span style={{ display: 'contents' }} dangerouslySetInnerHTML={{ __html: icons[row.icon] }} />
        {row.name}
      </button>
      <button
        class="icon-btn"
        title="Rename"
        onClick={(event) => {
          event.stopPropagation();
          actions.rename(row.id, row.name, !!row.isBody);
        }}
        dangerouslySetInnerHTML={{ __html: icons.rename }}
      />
      <TwoTapButton armKey={`items:${row.id}`} class="icon-btn" title="Delete" html={icons.trash} onConfirm={row.remove} />
    </li>
  );
}

interface FolderRowProps {
  folder: ItemFolder;
  items: Row[];
  hidden: Set<string>;
  depth: number;
  state: ItemsState;
  actions: ItemsActions;
}

/** A folder's row; `items` is everything in it, its subfolders' too. */
function FolderRow({ folder, items, hidden, depth, state, actions }: FolderRowProps) {
  const allHidden = items.length > 0 && items.every(item => hidden.has(item.id));
  const isCollapsed = state.collapsed.has(folder.id);

  return (
    <li class={`items-row folder-row${depth ? ' in-folder' : ''}${state.isMoving ? ' move-target' : ''}`} style={indent(depth)}>
      {/* Moving: tick this folder to put the ticked items in it. */}
      {state.isMoving && <input type="checkbox" class="items-check" title={`Move into ${folder.name}`} onChange={() => actions.moveInto(folder.id)} />}
      <button
        class="icon-btn"
        title={allHidden ? 'Show all in folder' : 'Hide all in folder'}
        onClick={() => actions.toggleFolderHidden(items.map(item => item.id), allHidden)}
        dangerouslySetInnerHTML={{ __html: icons[allHidden ? 'eyeOff' : 'eye'] }}
      />
      <button class="items-name" title="Show / hide its contents" onClick={() => actions.toggleCollapsed(folder.id)}>
        <span style={{ display: 'contents' }} dangerouslySetInnerHTML={{ __html: icons.folder }} />
        {folder.name}
        <span class="items-count">{` ${items.length}`}</span>
        <span class="items-caret">{isCollapsed ? ' ▸' : ' ▾'}</span>
      </button>
      <button class="icon-btn" title="Rename folder" onClick={() => actions.renameFolder(folder)} dangerouslySetInnerHTML={{ __html: icons.rename }} />
      <TwoTapButton armKey={`folder:${folder.id}`} class="icon-btn" title="Remove folder (keeps what's in it)" html={icons.trash} onConfirm={() => actions.deleteFolder(folder)} />
    </li>
  );
}

/** Everything there is, by kind. Sketches and the rest are greyed while something else is isolated. */
function rowsByKind({ doc, result, isolated, handlers }: ItemsListProps): Record<string, Row[]> {
  const bodies = result?.bodies ?? [];
  const names = doc.names ?? {};
  const features = doc.features;
  const of = <T extends Feature['type']>(type: T) => features.filter(feature => feature.type === type);
  const dimmed = (id: string) => (isolated && !isolated.includes(id) ? ' isolated-out' : '');

  return {
    Bodies: bodies.map(body => ({ id: body.id, name: names[body.id] ?? body.name, icon: 'body' as IconName, open: () => handlers.selectBody(body.id), remove: () => handlers.deleteBody(body.id), extra: dimmed(body.id), isBody: true })),
    Sketches: of('sketch').map(feature => ({ id: feature.id, name: feature.name, icon: 'sketch' as IconName, open: () => handlers.editSketch(feature.id), remove: () => handlers.deleteFeature(feature.id), extra: dimmed(feature.id) })),
    'Planes & axes': [...of('plane'), ...of('axis')].map(feature => ({
      id: feature.id,
      name: feature.name,
      icon: (feature.type === 'plane' ? PLANE_ICON[(feature as { kind?: string }).kind ?? 'offset'] ?? 'plane' : AXIS_ICON[(feature as { kind?: string }).kind ?? ''] ?? 'axis') as IconName,
      open: () => handlers.selectPlane(feature.id),
      remove: () => handlers.deleteFeature(feature.id),
      extra: dimmed(feature.id)
    })),
    Images: of('image').map(image => ({ id: image.id, name: image.name, icon: 'image' as IconName, open: () => handlers.selectImage(image.id), remove: () => handlers.deleteFeature(image.id) }))
  };
}

interface GroupBarOptions {
  state: ItemsState;
  folders: ItemFolder[];
  inFolder: Set<string>;
  actions: ItemsActions;
}

/** Shown while items are ticked: a new folder of them, or out of their folders, or moved into another. */
function groupBar({ state, folders, inFolder, actions }: GroupBarOptions) {
  // All ticked items in the same folder: the new folder goes inside it.
  const homes = new Set([...state.checked].map(id => folders.find(folder => folder.items.includes(id))?.id ?? ''));
  const parent = homes.size === 1 ? [...homes][0] || undefined : undefined;
  const filed = [...state.checked].filter(id => inFolder.has(id));

  return (
    <li key="groupbar" class="items-groupbar">
      {/* (No Clear: Select at the top again clears the ticks.) */}
      <button class="text-btn primary" onClick={() => actions.makeFolder(parent)}>
        {`${parent ? 'New subfolder' : 'New folder'} (${state.checked.size})`}
      </button>
      {/* Ticked items that are in a folder: Remove takes them out - one level up (into the folder around a subfolder), or back among the loose ones. */}
      {filed.length > 0 && (
        <button class="text-btn" title="Take the ticked items out of their folders" onClick={() => actions.removeFromFolders(filed)}>
          {`Remove (${filed.length})`}
        </button>
      )}
      {/* Move: then tick the folder (or subfolder) they go into. */}
      {folders.length > 0 && (
        <button class={state.isMoving ? 'text-btn primary' : 'text-btn'} title="Move the ticked items into another folder" onClick={actions.toggleMoving}>
          {state.isMoving ? 'Cancel move' : `Move (${state.checked.size})`}
        </button>
      )}
      {folders.length > 0 && state.isMoving && <span class="items-groupbar-hint">Tick the folder to move them into.</span>}
    </li>
  );
}

function ItemsList(props: ItemsListProps) {
  const { doc, result, state, actions } = props;
  const hidden = new Set(doc.hidden);
  const folders = doc.folders ?? [];
  const inFolder = new Set(folders.flatMap(folder => folder.items));
  const bodies = result?.bodies ?? [];
  const rows = rowsByKind(props);
  const byId = new Map(Object.values(rows).flat().map(row => [row.id, row]));
  const nodes: preact.ComponentChildren[] = [];

  // Each kind folds away under its heading (a long list of sketches and planes buried the bodies).
  const drawCategory = (title: string, count: number): boolean => {
    const key = `cat:${title}`;
    const isCollapsed = state.collapsed.has(key);
    nodes.push(
      <li key={key} class="items-heading items-category">
        <button class="items-category-btn" title={isCollapsed ? 'Show' : 'Fold away'} onClick={() => actions.toggleCollapsed(key)}>
          {`${isCollapsed ? '▸' : '▾'} ${title} (${count})`}
        </button>
      </li>
    );

    return !isCollapsed;
  };
  const drawRow = (row: Row, depth: number) => {
    nodes.push(<ItemRow key={`row:${row.id}`} row={row} isHidden={hidden.has(row.id)} depth={depth} state={state} actions={actions} />);
  };

  for (const [title, list] of Object.entries(rows)) {
    const loose = list.filter(row => !inFolder.has(row.id));
    if (title !== 'Bodies' && !loose.length) {
      continue;
    }
    if (!drawCategory(title, loose.length)) {
      continue;
    }
    if (!loose.length) {
      nodes.push(<li key={`empty:${title}`} class="items-empty">{bodies.length ? 'All in folders' : 'No bodies yet'}</li>);
    }
    loose.forEach(row => drawRow(row, 0));
  }

  // Folders last, each with its subfolders and then what it holds.
  const ids = new Set(folders.map(folder => folder.id));
  const top = folders.filter(folder => !folder.parent || !ids.has(folder.parent));
  const subs = (itemFolder: ItemFolder) => folders.filter(folder => folder.parent === itemFolder.id && folder.id !== itemFolder.id);
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
    nodes.push(<FolderRow key={`folder:${itemFolder.id}`} folder={itemFolder} items={allRows(itemFolder)} hidden={hidden} depth={depth} state={state} actions={actions} />);
    if (state.collapsed.has(itemFolder.id)) {
      return;
    }
    subs(itemFolder).forEach(subfolder => drawFolder(subfolder, depth + 1, seen));
    rowsOf(itemFolder).forEach(row => drawRow(row, depth + 1));
  };
  if (top.length) {
    nodes.push(<li key="folders-heading" class="items-heading">{`Folders (${top.length})`}</li>);
  }
  const drawn = new Set<string>();
  top.forEach(itemFolder => drawFolder(itemFolder, 0, drawn));

  if (state.checked.size) {
    nodes.push(groupBar({ state, folders, inFolder, actions }));
  } else if (state.isPicking) {
    nodes.push(<li key="pick-hint" class="items-empty">Tick items, then make a folder of them.</li>);
  }

  return <>{nodes}</>;
}

export class ItemsPanel {
  private el = document.getElementById('items')!;
  private list = document.getElementById('items-list')!;
  private state: ItemsState = { checked: new Set(), isPicking: false, isMoving: false, collapsed: new Set(), selected: new Set(), revealed: new Set() };
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
      if (!this.state.isPicking && this.state.checked.size) {
        this.state.checked.clear();
        this.render(this.last);

        return;
      }
      this.state.isPicking = !this.state.isPicking;
      if (!this.state.isPicking) {
        this.state.checked.clear();
      }
      pick.classList.toggle('on', this.state.isPicking);
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

  render(result: RegenResult | null): void {
    this.last = result;
    if (!this.state.checked.size) {
      this.state.isMoving = false;
    }
    mount(<ItemsList doc={this.store.doc} result={result} isolated={this.h.isolated()} state={this.state} handlers={this.h} actions={this.actions} />, this.list);
  }

  private actions: ItemsActions = {
    check: (id, on) => {
      if (on) {
        this.state.checked.add(id);
      } else {
        this.state.checked.delete(id);
      }
      this.render(this.last);
    },
    toggleCollapsed: (key) => {
      if (this.state.collapsed.has(key)) {
        this.state.collapsed.delete(key);
      } else {
        this.state.collapsed.add(key);
      }
      this.render(this.last);
    },
    toggleHidden: (id, isHidden) => {
      this.store.commit(draft => (draft.hidden = isHidden ? draft.hidden.filter(hiddenId => hiddenId !== id) : [...draft.hidden, id]));
    },
    toggleFolderHidden: (ids, allHidden) => {
      const idSet = new Set(ids);
      this.store.commit((draft) => {
        draft.hidden = allHidden ? draft.hidden.filter(hiddenId => !idSet.has(hiddenId)) : [...new Set([...draft.hidden, ...ids])];
      });
    },
    renameFolder: async (itemFolder) => {
      const name = await this.h.askName('Rename folder', itemFolder.name);
      if (name) {
        this.store.commit(draft => (draft.folders = (draft.folders ?? []).map(folder => (folder.id === itemFolder.id ? { ...folder, name } : folder))));
      }
    },
    // What it held - items and subfolders - moves up to where it was.
    deleteFolder: (itemFolder) => {
      this.store.commit((draft) => {
        const fs = draft.folders ?? [];
        const parent = itemFolder.parent && fs.some(otherFolder => otherFolder.id === itemFolder.parent) ? itemFolder.parent : undefined;
        draft.folders = fs
          .filter(folder => folder.id !== itemFolder.id)
          .map(folder => (folder.id === parent ? { ...folder, items: [...folder.items, ...itemFolder.items] } : folder.parent === itemFolder.id ? { ...folder, parent } : folder));
      });
    },
    removeFromFolders: (filed) => {
      this.state.checked.clear();
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
    },
    toggleMoving: () => {
      this.state.isMoving = !this.state.isMoving;
      this.render(this.last);
    },
    moveInto: (id) => {
      const ids = [...this.state.checked];
      this.state.checked.clear();
      this.state.isMoving = false;
      this.store.commit(draft => (draft.folders = (draft.folders ?? []).map(itemFolder => ({ ...itemFolder, items: itemFolder.id === id ? [...itemFolder.items.filter(item => !ids.includes(item)), ...ids] : itemFolder.items.filter(item => !ids.includes(item)) }))));
    },
    makeFolder: async (parent) => {
      const ids = [...this.state.checked];
      const name = await this.h.askName(parent ? 'New subfolder' : 'New folder', `Folder ${this.folders.length + 1}`);
      if (!name) {
        return;
      }
      this.state.checked.clear();
      this.state.isPicking = false;
      document.getElementById('items-pick')!.classList.remove('on');
      // An item lives in one folder at a time.
      this.store.commit((draft) => {
        const rest = (draft.folders ?? []).map(itemFolder => ({ ...itemFolder, items: itemFolder.items.filter(item => !ids.includes(item)) }));
        draft.folders = [...rest, { id: `folder-${Date.now().toString(36)}`, name, items: ids, ...(parent ? { parent } : {}) }];
      });
    },
    rename: (id, current, isBody) => this.h.rename(id, current, isBody)
  };

  /**
   * Reveal in Items: the panel opens, the folders and headings holding the
   * rows unfold, and the first is scrolled to. The rows pulse until the
   * next thing done (a tap anywhere, a key).
   */
  private unreveal: (() => void) | null = null;
  reveal(ids: string[]): void {
    this.toggle(true);
    const want = new Set(ids);
    this.unreveal?.();
    this.state.revealed = want;
    const stop = () => {
      this.unreveal = null;
      this.state.revealed = new Set();
      removeEventListener('pointerdown', stop, true);
      removeEventListener('keydown', stop, true);
      this.render(this.last);
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
          this.state.collapsed.delete(itemFolder.id);
        }
      }
    }
    this.render(this.last);
    const find = () => [...this.list.querySelectorAll<HTMLElement>('li[data-id]')].find(li => want.has(li.dataset.id!));
    let li = find();
    if (!li) {
      // Under a heading folded away: the headings open.
      for (const collapsedKey of [...this.state.collapsed]) {
        if (collapsedKey.startsWith('cat:')) {
          this.state.collapsed.delete(collapsedKey);
        }
      }
      this.render(this.last);
      li = find();
    }
    li?.scrollIntoView({ block: 'center' });
  }

  /** What's selected in the view (a body double-clicked, a plane…): its row lights up. */
  markSelected(ids: string[]): void {
    const next = new Set(ids);
    if (next.size === this.state.selected.size && ids.every(id => this.state.selected.has(id))) {
      return;
    }
    this.state.selected = next;
    this.render(this.last);
    // Scrolled out of sight in a long list: brought into view.
    const first = this.list.querySelector<HTMLElement>('li.selected');
    if (first && !this.el.hidden) {
      first.scrollIntoView({ block: 'nearest' });
    }
  }
}

/** Each kind of construction plane's icon (its mark big, the plane small). */
/** Each kind of axis's icon (an axis from before they were told apart: the plain one). */
const AXIS_ICON: Record<string, IconName> = { face: 'axisFace', edge: 'axisEdge', round: 'axisRound', '2pt': 'axis2pt', planes: 'axisPlanes' };

const PLANE_ICON: Record<string, IconName> = { offset: 'planeOffset', mid: 'planeMid', '3pt': 'plane3pt', curve: 'planeCurve', perp: 'planePerp', angle: 'planeAngle', parallel: 'planeParallel' };
