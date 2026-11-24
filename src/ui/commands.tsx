// Commands by name: what a shortcut key or the search box runs. Everything
// the app offers is a ToolItem somewhere - the picked thing's tools in the
// left column, the bottom bar, the open window's buttons, the main menus -
// so a command is found by its label there, and run as a tap would run it.

import { render as mount } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { TextField } from './components';
import { icons } from './icons';
import { caretAtEnd, caretToEnd, type TextField as TextFieldElement } from './textField';
import type { ToolItem } from './ui';

export interface Listed {
  label: string;
  /** Where it is: "Construct › Plane › Through 3 Points". */
  path: string;
  item: ToolItem;
}

/** Every item, sub-menus included (separators have no label). */
export function flatten(items: ToolItem[], path: string[] = []): Listed[] {
  return items.filter(it => it.label).flatMap(it => [{ label: it.label, path: [...path, it.label].join(' › '), item: it }, ...flatten(it.children ?? [], [...path, it.label])]);
}

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * The first of `labels` that can be run now: what the picked thing offers
 * first (so E on a face is its Extrude), then the main menus.
 */
export function findAction(offered: ToolItem[], main: ToolItem[], labels: string[]): Listed | null {
  const lists = [flatten(offered), flatten(main)];
  for (const label of labels) {
    for (const list of lists) {
      const hit = list.find(listed => same(listed.label, label) && listed.item.run && !listed.item.disabled);
      if (hit) {
        return hit;
      }
    }
  }

  return null;
}

/**
 * How well the typed letters fit a command, or null if they don't: every
 * letter in order, a letter at the start of a word or straight after the
 * last one counting more ("p3" finds Plane – Through 3 Points, "snu" Scale –
 * Non-uniform).
 */
export function score(query: string, text: string): number | null {
  const q = query.toLowerCase().replace(/\s+/g, '');
  if (!q) {
    return 0;
  }
  const t = text.toLowerCase();
  let at = -1;
  let total = 0;
  for (const ch of q) {
    const i = t.indexOf(ch, at + 1);
    if (i < 0) {
      return null;
    }
    const wordStart = i === 0 || !/[a-z0-9]/.test(t[i - 1]);
    total += (wordStart ? 3 : 1) + (i === at + 1 ? 2 : 0) - Math.min(1, (i - at - 1) * 0.05);
    at = i;
  }
  // A whole word typed, or the start of the name: better still.
  if (t.startsWith(q)) {
    total += 4;
  }

  return total - t.length * 0.01;
}

/** The commands used last (first: the latest), remembered on this device. */
const RECENT = 'sg.recentCommands';
function recent(): string[] {
  try {
    return JSON.parse(localStorage.getItem(RECENT) ?? '[]') as string[];
  } catch {
    return [];
  }
}
function remember(path: string): void {
  try {
    localStorage.setItem(RECENT, JSON.stringify([path, ...recent().filter(recentPath => recentPath !== path)].slice(0, 8)));
  } catch {
    // (No storage here: nothing remembered.)
  }
}

let openHost: HTMLElement | null = null;

/** Each command once (the left column's copy of a main tool is the same command). */
function allCommands(offered: ToolItem[], main: ToolItem[]): Listed[] {
  const seen = new Set<string>();

  return [...flatten(offered), ...flatten(main)].filter((listed) => {
    if (!listed.item.run || seen.has(listed.path)) {
      return false;
    }
    seen.add(listed.path);

    return true;
  });
}

function matching(query: string, offered: ToolItem[], main: ToolItem[]): Listed[] {
  const items = allCommands(offered, main);
  if (!query) {
    // Nothing typed: the ones used last, then what the picked thing offers.
    const byPath = new Map(items.map(item => [item.path, item]));
    const last = recent().flatMap(path => (byPath.has(path) ? [byPath.get(path)!] : []));
    const here = flatten(offered).filter(entry => entry.item.run && !last.some(listed => listed.path === entry.path));

    return [...last, ...here].slice(0, 12);
  }

  return items
    .map(item => ({ listed: item, rank: Math.max(score(query, item.label) ?? -Infinity, (score(query, item.path) ?? -Infinity) - 2) }))
    .filter(scored => scored.rank > -Infinity)
    .sort((a, b) => Number(!!a.listed.item.disabled) - Number(!!b.listed.item.disabled) || b.rank - a.rank || a.listed.path.length - b.listed.path.length)
    .slice(0, 12)
    .map(scored => scored.listed);
}

interface CommandSearchProps {
  offered: () => ToolItem[];
  main: () => ToolItem[];
  onClose: () => void;
}

function CommandSearch({ offered, main, onClose }: CommandSearchProps) {
  const [query, setQuery] = useState('');
  const [chosen, setChosen] = useState<number | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const fieldRef = useRef<TextFieldElement | undefined>(undefined);

  const shown = matching(query.trim(), offered(), main());
  // Until the arrows are used, the first command that can be run.
  const at = chosen !== null && chosen < shown.length ? chosen : Math.max(0, shown.findIndex(listed => !listed.item.disabled));

  const run = (index: number) => {
    const listed = shown[index];
    if (!listed || listed.item.disabled) {
      return;
    }
    onClose();
    remember(listed.path);
    listed.item.run!();
  };
  const handleKeyRef = useRef<(event: KeyboardEvent) => void>(() => {});
  handleKeyRef.current = (event) => {
    event.stopPropagation();
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      run(at);
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (shown.length) {
        setChosen((at + (event.key === 'ArrowDown' ? 1 : shown.length - 1)) % shown.length);
      }
    } else if (event.key === 'ArrowRight' && fieldRef.current && caretAtEnd(fieldRef.current) && shown[at]) {
      // → at the end of the text: the highlighted command's whole name.
      event.preventDefault();
      fieldRef.current.value = shown[at].label;
      caretToEnd(fieldRef.current);
      setQuery(shown[at].label);
      setChosen(null);
    }
  };

  useEffect(() => {
    const handleOutside = (event: PointerEvent) => {
      if (!boxRef.current?.contains(event.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('pointerdown', handleOutside, true);

    return () => document.removeEventListener('pointerdown', handleOutside, true);
  }, [onClose]);

  useEffect(() => {
    listRef.current?.querySelector('.on')?.scrollIntoView({ block: 'nearest' });
  }, [at, query]);

  const handleReady = (field: TextFieldElement) => {
    fieldRef.current = field;
    field.setAttribute('aria-label', 'Search commands');
    field.addEventListener('keydown', event => handleKeyRef.current(event));
    field.focus();
  };

  return (
    <div class="cmd-search" ref={boxRef}>
      <TextField className="cmd-input" placeholder="Search commands…" onInput={(value) => {
        setQuery(value); setChosen(null); 
      }} onReady={handleReady} />
      <div class="cmd-list" role="listbox" ref={listRef}>
        {shown.length === 0 && <div class="cmd-empty">{query.trim() ? 'No command by that name' : "Type a command's name"}</div>}
        {shown.map((listed, index) => {
          const where = listed.path.split(' › ').slice(0, -1).join(' › ');

          return (
            <button
              key={listed.path}
              type="button"
              role="option"
              class={`cmd-row${index === at ? ' on' : ''}${listed.item.disabled ? ' off' : ''}`}
              onPointerDown={event => event.preventDefault()}
              onClick={() => run(index)}
            >
              <span style={{ display: 'contents' }} dangerouslySetInnerHTML={{ __html: icons[listed.item.icon] ?? '' }} />
              <span class="cmd-words">
                <span class="cmd-label">{listed.label}</span>
                {(where || listed.item.disabled) && <span class="cmd-where">{listed.item.disabled ? (listed.item.why ?? 'Not now') : where}</span>}
              </span>
              {listed.item.shortcut && <kbd class="cmd-key">{listed.item.shortcut}</kbd>}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * The search box (X or Ctrl+F): type part of a command's name, the list
 * narrows; ↑ ↓ pick, Enter (or a click) runs it, → completes the name, Esc
 * closes. What the picked thing offers comes first.
 */
export function openCommandSearch(offered: () => ToolItem[], main: () => ToolItem[]): void {
  if (openHost) {
    openHost.querySelector<HTMLElement>('.cmd-input')?.focus();

    return;
  }
  const host = document.createElement('div');
  const close = () => {
    mount(null, host);
    host.remove();
    openHost = null;
  };
  document.body.append(host);
  openHost = host;
  mount(<CommandSearch offered={offered} main={main} onClose={close} />, host);
}

/** The keys, as the cheat sheet lists them. */
export const SHORTCUTS: [string, [string, string][]][] = [
  [
    'Sketch',
    [
      ['L', 'Line'],
      ['A', 'Arc'],
      ['C', 'Circle'],
      ['R', 'Rectangle'],
      ['G', 'Polygon'],
      ['I', 'Spline'],
      ['O', 'Offset Edge'],
      ['T', 'Trim'],
      ['Shift + letter', 'A constraint (Shift+A Parallel, P Perpendicular, T Tangent, N Coincident, M Midpoint, C Concentric, V Horizontal/Vertical, E Equal, S Symmetry, L Lock)'],
      ['Enter', 'Finish the shape'],
      ['Esc', 'Step back']
    ]
  ],
  [
    'Modeling',
    [
      ['E', 'Extrude'],
      ['F', 'Fillet (nothing picked: Zoom to Fit)'],
      ['H', 'Shell'],
      ['M', 'Move/Rotate'],
      ['N', 'Translate'],
      ['P', 'Project as Sketch'],
      ['S', 'Scale (nothing picked: Sketch)'],
      ['V', 'Revolve'],
      ['W', 'Sweep'],
      ['Ctrl + U / B / I', 'Union / Subtract / Intersect']
    ]
  ],
  [
    'View',
    [
      ['Ctrl (or Alt) + 1', 'Default view'],
      ['Ctrl (or Alt) + 2 … 7', 'Front, Back, Top, Bottom, Right, Left'],
      ['Space', 'Zoom to the face under the pointer']
    ]
  ],
  [
    'Edit',
    [
      ['X or Ctrl + F', 'Search commands'],
      ['Ctrl + Shift + S', "Select Through (pick what's behind)"],
      ['Tab / B / F / E / A', 'While box-selecting: what it takes'],
      ['Ctrl + Z / Ctrl + Shift + Z', 'Undo / Redo'],
      ['Ctrl + S', 'Save'],
      ['Delete', "Delete what's picked"],
      ['?', 'This list']
    ]
  ]
];

function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' || event.key === '?') {
        event.preventDefault();
        onClose();
      }
      event.stopPropagation();
    };
    window.addEventListener('keydown', handleKey, true);

    return () => window.removeEventListener('keydown', handleKey, true);
  }, [onClose]);

  return (
    <div class="dialog-back" onPointerDown={event => event.target === event.currentTarget && onClose()}>
      <div class="dialog shortcuts">
        <div class="library-head">
          <div class="panel-title">Keyboard shortcuts</div>
          <button type="button" class="icon-btn library-close" title="Close" onClick={onClose} dangerouslySetInnerHTML={{ __html: icons.close }} />
        </div>
        <div class="shortcuts-body">
          {SHORTCUTS.map(([group, rows]) => (
            <>
              <div class="shortcuts-group">{group}</div>
              {rows.map(([key, what]) => (
                <div key={key} class="shortcuts-row">
                  <kbd class="cmd-key">{key}</kbd>
                  <span>{what}</span>
                </div>
              ))}
            </>
          ))}
        </div>
      </div>
    </div>
  );
}

/** The cheat sheet (the ? key, or Shortcuts in the search). */
export function showShortcuts(): void {
  const host = document.createElement('div');
  const close = () => {
    mount(null, host);
    host.remove();
  };
  document.body.append(host);
  mount(<ShortcutsDialog onClose={close} />, host);
}
