// The console's handle on the app: `sg` - read what's there and work the tools
// without tapping at pixels. For checking the app by hand or by script (the
// browser's console, or a test driving the page). Type sg.help() to list it.
//
//   sg.state()                      the project, tool, hint, panel, selection, errors, bodies
//   sg.select(sg.sel.body("Box"))   pick something (as a tap would)
//   sg.actions()                    what the picked thing offers (left column, bottom bar)
//   sg.run("Project as Sketch")     run one (by id or label, also in sub-menus)
//   sg.panel()                      the open tool's window: slots, values, choices
//   sg.set("XY")  sg.set("Height", 2)  sg.set("Sink in", true)
//   sg.pick(sg.sel.face("Box", 3))  give the waiting slot a face / edge / plane…
//   sg.done()   sg.cancel()   await sg.idle()   await sg.health()
import { parseProject } from './doc/store';
import { newProjectId } from './doc/library';
import type { App } from './app';
import type { ToolItem, PanelItem } from './ui/ui';
import type { Feature } from './doc/types';
import type { Sel } from './tools/tool';
import type { SweepWord } from './ui/sentence';
import type { PickHit } from './view/viewport';
import type { ProjectDoc } from './doc/types';

// (The app's insides it reads: kept out of the classes' public faces on purpose.)
interface Insides {
  tool: { id: string; editingId?: string; activeSketch?: string; slots?: { label: string; accept(h: PickHit): boolean; multi?: boolean }[]; active?: number; advance?(): void; render?(): void; update?(): void };
  regenerate(): Promise<void>;
  undo(): void;
  redo(): void;
  switchProject(doc: ProjectDoc, id: string): Promise<void>;
}
interface UIInsides {
  toolItems: ToolItem[];
  bottomItems: ToolItem[];
  panelSpec: { title: string; items?: PanelItem[]; fields?: { label: string; value: number; onInput(v: number): void }[]; actions?: ToolItem[]; onDone?(): void; onCancel?(): void } | null;
  hintText: string | null;
  recentToasts?: string[];
}

interface Listed {
  id: string;
  label: string;
  /** Where it sits: "Sketch › Rectangle". */
  path: string;
  disabled?: boolean;
  why?: string;
  item: ToolItem;
}

function flatten(items: ToolItem[], path: string[] = []): Listed[] {
  // (Separators have no label.)
  return items.filter(it => it.label).flatMap(it => [
    { id: it.id, label: it.label, path: [...path, it.label].join(' › '), ...(it.disabled ? { disabled: true, why: it.why } : {}), item: it },
    ...flatten(it.children ?? [], [...path, it.label])
  ]);
}
const plain = (l: Listed[]) => l.map(({ item: _, ...rest }) => rest);
const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

export function installDebug(app: App): void {
  const inside = app as unknown as Insides;
  const ui = app.ui as unknown as UIInsides;
  const features = () => app.store.doc.features;
  /** A step or body by id or name. */
  const featureOf = (key: string): Feature | undefined => features().find(f => f.id === key) ?? features().find(f => same(f.name, key));
  const bodyId = (key: string): string => {
    const list = app.view.bodyList;
    const names = app.store.doc.names ?? {};

    return list.find(b => b.id === key)?.id ?? list.find(b => same(names[b.id] ?? b.name, key))?.id ?? key;
  };

  const panelItems = (): PanelItem[] => {
    const spec = ui.panelSpec;
    if (!spec) {
      return [];
    }
    const fields: PanelItem[] = (spec.fields ?? []).map(f => ({ type: 'number', label: f.label, value: f.value, onInput: f.onInput }));

    return [...fields, ...(spec.items ?? [])];
  };

  const shown = (): ToolItem[] => [...ui.toolItems, ...ui.bottomItems, ...(ui.panelSpec?.actions ?? [])];

  const sg = {
    app,

    /** What's there now, in one look. */
    state() {
      const r = app.result;
      const byId = new Map(features().map(f => [f.id, f.name]));

      return {
        project: app.store.doc.name,
        tool: inside.tool.id,
        editing: inside.tool.editingId ?? inside.tool.activeSketch ?? null,
        hint: ui.hintText,
        panel: ui.panelSpec?.title ?? null,
        selection: app.selection,
        steps: features().length,
        errors: (r?.errors ?? []).map(e => `${byId.get(e.featureId) ?? e.featureId}: ${e.message}`),
        notes: (r?.notes ?? []).map(e => `${byId.get(e.featureId) ?? e.featureId}: ${e.message}`),
        toasts: ui.recentToasts?.slice(-5) ?? [],
        bodies: sg.bodies()
      };
    },

    /** The steps in History: id, name, type, switched off, its error. */
    steps() {
      const errs = new Map((app.result?.errors ?? []).map(e => [e.featureId, e.message]));

      return features().map((f, i) => ({ i: i + 1, id: f.id, name: f.name, type: f.type, ...(f.suppressed ? { off: true } : {}), ...(errs.has(f.id) ? { error: errs.get(f.id) } : {}) }));
    },

    /** A step as stored (by id or name). */
    step: (key: string) => featureOf(key),

    /** The bodies shown: id, name, how many faces and edges, hidden. */
    bodies() {
      const names = app.store.doc.names ?? {};
      const hidden = new Set(app.store.doc.hidden);

      return app.view.bodyList.map(b => ({ id: b.id, name: names[b.id] ?? b.name, faces: b.faces.length, edges: b.edges.length, ...(hidden.has(b.id) ? { hidden: true } : {}) }));
    },

    /** Each body measured on the solid: valid, closed, solids, faces, volume, box. */
    health: () => app.kernel.health(features()),

    /** The main tools (the left column with nothing picked, with their sub-menus). */
    tools: () => plain(flatten(app.mainTools())),

    /** What's offered now: the left column (what the picked thing offers), the bottom bar, the open window's buttons. */
    actions: () => plain(flatten(shown())),

    /** Run a tool or action by id or label (what's offered now first, then the main tools). */
    run(key: string): string {
      const all = [...flatten(shown()), ...flatten(app.mainTools())];
      const hit = all.find(x => x.id === key) ?? all.find(x => same(x.label, key)) ?? all.find(x => same(x.path, key));
      if (!hit) {
        return `No "${key}" here. sg.actions() / sg.tools() list what there is.`;
      }
      if (hit.disabled) {
        return `"${hit.label}" is off: ${hit.why ?? '(no reason given)'}`;
      }
      if (!hit.item.run) {
        return `"${hit.label}" opens a menu: ${(hit.item.children ?? []).map(c => c.label).join(', ')}`;
      }
      hit.item.run();

      return `ran ${hit.path}`;
    },

    /** The sentence bar: what it says now (its words, where each is). */
    sentence: () => app.sentence.describe(),

    /**
     * Every tool, from every kind of pick there is in the model, started
     * through the line at the bottom - and in each every option tried (each
     * choice, switch, number, blank). Lists what did nothing, what threw, and
     * for each tool whether it has a handle on the model, a value box, and
     * lit picks while it is open (what a tool that takes a distance should
     * have). Changes nothing for good: each tool is cancelled, each step
     * undone. `only`: just the picks named ("face", "edge", "body"...).
     * `options` false: the tools are only started and looked at (much quicker).
     */
    async sweep(only?: string[], options = true): Promise<{ started: number; nothing: string[]; errors: string[]; options: string[]; audit: { pick: string; tool: string; handle: boolean; box: boolean; lit: boolean; numbers: number }[] }> {
      const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
      const errors: string[] = [];
      const onError = (e: ErrorEvent) => errors.push(`${e.message}`);
      const onReject = (e: PromiseRejectionEvent) => errors.push(String((e.reason as Error)?.message ?? e.reason));
      addEventListener('error', onError);
      addEventListener('unhandledrejection', onReject);
      const steps = app.store.doc.features.length;
      const state = () => app.sentence.state;
      const settle = async () => {
        app.sentence.changed();
        await wait(120);
        await Promise.race([sg.idle(), wait(4000)]);
      };
      const reset = async () => {
        for (const d of Array.from(document.querySelectorAll<HTMLElement>('.dialog-back .dialog, .bim-sheet')).reverse()) {
          const b = Array.from(d.querySelectorAll('button')).find(x => /^(Cancel|Close)/i.test(x.textContent?.trim() ?? '') || /close/i.test(x.className) || /close/i.test(x.title));
          b?.click();
          await wait(120);
        }
        for (let i = 0; i < 4 && inside.tool.id !== 'select'; i++) {
          document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
          await wait(150);
        }
        for (let i = 0; i < 3; i++) {
          const s = state();
          if (!s?.about.startsWith('tool:')) {
            break;
          }
          (s.cancel ?? s.done)?.();
          await wait(200);
        }
        if (inside.tool.id !== 'select') {
          app.setTool(null);
        }
        while (app.store.doc.features.length > steps) {
          inside.undo();
          await wait(120);
        }
        if (app.isolated) {
          app.isolate(null);
        }
        await Promise.race([sg.idle(), wait(4000)]);
      };
      const snap = () => JSON.stringify([inside.tool.id, ui.panelSpec?.title ?? null, app.store.doc.features.length, app.selection, document.querySelectorAll('.dialog, .menu:not([hidden]), .ref-win, .bim-sheet').length, ui.recentToasts?.length ?? 0, !!app.isolated, !!app.section, app.varsOn, JSON.stringify(app.store.doc), ui.hintText]);
      const leaves = () => {
        const out: { path: string; key: string }[] = [];
        const walk = (ws: SweepWord[], path: string[]) => {
          for (const w of ws) {
            if (w.kids?.length) {
              walk(w.kids, [...path, w.label]);
            } else if (w.run || w.value) {
              out.push({ path: [...path, w.label].join(' > '), key: w.key });
            }
          }
        };
        for (const g of state()?.groups ?? []) {
          walk(g.words, [g.cap]);
        }

        return out;
      };
      const find = (key: string): SweepWord | null => {
        let hit: SweepWord | null = null;
        const walk = (ws: SweepWord[]) => {
          for (const w of ws) {
            if (w.key === key) {
              hit = w;
            }
            if (w.kids) {
              walk(w.kids);
            }
          }
        };
        for (const g of state()?.groups ?? []) {
          walk(g.words);
        }

        return hit;
      };
      // The picks there are in this model.
      const bodies = app.view.bodyList;
      const picks: [string, Sel[]][] = [['nothing', []]];
      const b0 = bodies[0];
      if (b0) {
        const flat = b0.faces.findIndex(f => f.type === 'PLANE');
        const straight = b0.edges.findIndex(e => e.type === 'LINE');
        if (flat >= 0) {
          picks.push(['face', [{ kind: 'face', body: b0.id, face: flat }]]);
        }
        if (straight >= 0) {
          picks.push(['edge', [{ kind: 'edge', body: b0.id, edge: straight }]]);
        }
        picks.push(['corner', [{ kind: 'vertex', body: b0.id, vertex: 0 }]], ['body', [{ kind: 'body', body: b0.id }]]);
        if (bodies[1]) {
          picks.push(['two bodies', [{ kind: 'body', body: b0.id }, { kind: 'body', body: bodies[1].id }]]);
        }
      }
      for (const b of bodies) {
        const round = b.faces.findIndex(f => f.type !== 'PLANE');
        const rim = b.edges.findIndex(e => e.type === 'CIRCLE');
        if (round >= 0 && !picks.some(p => p[0] === 'round face')) {
          picks.push(['round face', [{ kind: 'face', body: b.id, face: round }]]);
        }
        if (rim >= 0 && !picks.some(p => p[0] === 'round edge')) {
          picks.push(['round edge', [{ kind: 'edge', body: b.id, edge: rim }]]);
        }
      }
      const loose = features().find(f => f.type === 'sketch' && !features().some(g => JSON.stringify(g).includes(`"sketch":"${f.id}"`) && g.id !== f.id));
      if (loose) {
        picks.push(['sketch shape', [{ kind: 'profile', sketch: loose.id, region: 0 }]]);
      }
      picks.push(['plane', [{ kind: 'plane', id: 'XY' }]]);
      // (Things that open a chooser of the device's, which cannot be closed from here.)
      const skip = /-image$|-file$|insert-project$|refImage$|browser$|custom/i;
      const out = { started: 0, nothing: [] as string[], errors: [] as string[], options: [] as string[], audit: [] as { pick: string; tool: string; handle: boolean; box: boolean; lit: boolean; numbers: number }[] };
      for (const [name, sel] of picks) {
        if (only && !only.includes(name)) {
          continue;
        }
        await reset();
        app.setSelection(sel);
        await settle();
        for (const leaf of leaves()) {
          if (skip.test(leaf.key)) {
            continue;
          }
          await reset();
          app.setSelection(sel);
          await settle();
          const w = find(leaf.key);
          if (!w) {
            out.nothing.push(`${name}: ${leaf.path} (not offered a second time)`);
            continue;
          }
          const before = snap();
          const e0 = errors.length;
          try {
            if (w.value) {
              w.value.put(w.value.now + (w.value.max !== undefined && w.value.now >= w.value.max ? -1 : 1));
            } else {
              w.run?.();
            }
          } catch (err) {
            out.errors.push(`${name}: ${leaf.path}: ${(err as Error).message}`);
            continue;
          }
          await settle();
          if (errors.length > e0) {
            out.errors.push(`${name}: ${leaf.path}: ${errors.slice(e0).join('; ')}`);
          }
          if (snap() === before) {
            out.nothing.push(`${name}: ${leaf.path}`);
            continue;
          }
          out.started++;
          const s = state();
          if (!s?.about.startsWith('tool:')) {
            continue;
          }
          // What a tool that takes a size should have: a handle on the model, a box for the value, its picks lit.
          const numbers = s.words.filter(x => x.value && (x.value.kind === 'length' || x.value.kind === 'angle')).length;
          out.audit.push({ pick: name, tool: leaf.path.split(' > ').pop()!, handle: Array.from(app.view.helpers).some(h => /Handle|Gimbal/.test(h.constructor.name)), box: Array.from(document.querySelectorAll<HTMLElement>('.dim-widget')).some(d => d.getBoundingClientRect().width > 0), lit: app.selection.length > 0 || ((app.view as unknown as { highlightGroup?: { children: unknown[] } }).highlightGroup?.children.length ?? 0) > 0, numbers });
          if (!options) {
            continue;
          }
          // Every option of it.
          for (const key of s.words.map(x => x.key)) {
            const at = () => state()?.words.find(x => x.key === key);
            const it = at();
            if (!it) {
              continue;
            }
            const what = `${name}: ${leaf.path}: ${it.cap ?? it.label}`;
            const e1 = errors.length;
            try {
              if (it.kind === 'choice' && it.kids) {
                const first = it.kids.find(k => k.on)?.key;
                for (const kid of it.kids.map(k => k.key)) {
                  const k = at()?.kids?.find(x => x.key === kid);
                  if (!k || k.on) {
                    continue;
                  }
                  k.run?.();
                  await settle();
                  if (inside.tool.id === 'select') {
                    break;
                  }
                  const now = at()?.kids?.find(x => x.key === kid);
                  if (k.kind === 'verb' && now && !now.on) {
                    out.options.push(`${what} > ${k.label}: not set`);
                  }
                }
                const back = at()?.kids?.find(x => x.key === first);
                if (back && !back.on) {
                  (back.run?.(), await settle());
                }
              } else if (it.kind === 'toggle') {
                const was = !!it.on;
                it.run?.();
                await settle();
                const now = at();
                if (now && !!now.on === was) {
                  out.options.push(`${what}: switch did not flip`);
                }
                now?.run?.();
                await settle();
              } else if (it.kind === 'value' && it.value) {
                const v = it.value;
                v.put(v.kind === 'int' ? v.now + 1 : v.kind === 'angle' ? v.now + 5 : v.now === 0 ? 3 : v.now * 1.25);
                await settle();
                const now = at();
                if (now?.value && now.value.now === v.now && (v.max === undefined || v.now < v.max)) {
                  out.options.push(`${what}: value did not change`);
                }
              } else if (it.kind === 'slot') {
                it.run?.();
                await settle();
              }
            } catch (err) {
              out.options.push(`${what}: ${(err as Error).message}`);
            }
            if (errors.length > e1) {
              out.options.push(`${what}: ${errors.slice(e1).join('; ')}`);
            }
            if (inside.tool.id === 'select') {
              break;
            }
          }
        }
      }
      await reset();
      app.setSelection([]);
      removeEventListener('error', onError);
      removeEventListener('unhandledrejection', onReject);

      return out;
    },

    /** The reference image windows and their tabs; refAdd(name, dataUrl) opens one as Insert › Reference Image does. */
    refImages: () => app.refImages.describe(),
    refAdd: (name: string, src: string) => void app.refImages.add(name, src),

    /** Pick things, as taps would (sg.sel builds them). */
    select(...sel: Sel[]) {
      app.setSelection(sel);

      return app.selection;
    },

    /** Things to pick, by name or id. */
    sel: {
      body: (body: string): Sel => ({ kind: 'body', body: bodyId(body) }),
      face: (body: string, face: number): Sel => ({ kind: 'face', body: bodyId(body), face }),
      edge: (body: string, edge: number): Sel => ({ kind: 'edge', body: bodyId(body), edge }),
      vertex: (body: string, vertex: number): Sel => ({ kind: 'vertex', body: bodyId(body), vertex }),
      /** A sketch's closed shape (regions counted as the sketch finds them). */
      profile: (sketch: string, region = 0): Sel => ({ kind: 'profile', sketch: featureOf(sketch)?.id ?? sketch, region }),
      curve: (sketch: string, entity: string): Sel => ({ kind: 'curve', sketch: featureOf(sketch)?.id ?? sketch, entity }),
      plane: (id: string): Sel => ({ kind: 'plane', id: featureOf(id)?.id ?? id }),
      axis: (id: string): Sel => ({ kind: 'axis', id: featureOf(id)?.id ?? id }),
      origin: (): Sel => ({ kind: 'origin' })
    },

    /** A body's faces: index, type, centre, normal, area (to find the one to pick). */
    faces(body: string) {
      return (app.view.body(bodyId(body))?.faces ?? []).map((f, i) => ({ i, type: f.type, center: f.center, normal: f.normal, area: +f.area.toFixed(3), ...(f.round ? { round: f.round } : {}) }));
    },

    /** A body's edges: index, type, ends. */
    edges(body: string) {
      return (app.view.body(bodyId(body))?.edges ?? []).map((e, i) => ({ i, type: e.type, start: e.start, mid: e.mid, end: e.end, length: +e.length.toFixed(3) }));
    },

    /** The open tool's window: title, rows (slots, numbers, choices, toggles), buttons. */
    panel() {
      const spec = ui.panelSpec;
      if (!spec) {
        return null;
      }

      return {
        title: spec.title,
        rows: panelItems().map((it) => {
          switch (it.type) {
            case 'number':
            case 'slider':
            case 'toggle':
              return { type: it.type, label: it.label, value: it.value };
            case 'slot':
              return { type: it.type, label: it.label, value: it.value, ...(it.active ? { waiting: true } : {}), filled: it.filled };
            case 'choice':
              return { type: it.type, label: it.label ?? '', value: it.value, options: it.options.map(o => o.label) };
            case 'button':
              return { type: it.type, label: it.label };
            case 'chips':
              return { type: it.type, label: it.label ?? '', chips: it.chips.map(c => c.label + (c.on ? ' (on)' : '')) };
            default:
              return { type: (it as { type: string }).type };
          }
        }),
        buttons: (spec.actions ?? []).map(a => a.label)
      };
    },

    /**
     * Set a row of the open window by its label: a number, a toggle, a choice
     * (or just a choice's option: sg.set("XY")), a slot to fill next, a button.
     */
    set(label: string, value?: number | boolean | string): string {
      const items = panelItems();
      const row = items.find(it => 'label' in it && it.label && same(it.label, label));
      if (row) {
        switch (row.type) {
          case 'number':
          case 'slider':
            row.onInput(Number(value));

            return `${row.label} = ${value}`;
          case 'toggle':
            row.onChange(value === undefined ? !row.value : !!value);

            return `${row.label} ${value === undefined ? !row.value : !!value ? 'on' : 'off'}`;
          case 'choice': {
            const o = row.options.find(x => x.id === value || same(x.label, String(value)));
            if (!o) {
              return `${row.label}: no "${value}" (${row.options.map(x => x.label).join(', ')})`;
            }
            row.onChange(o.id);

            return `${row.label} = ${o.label}`;
          }
          case 'slot':
            row.onClick();

            return `${row.label}: waiting for a pick`;
          case 'button':
            row.onClick();

            return `pressed ${row.label}`;
        }
      }
      // An option of a choice with no label (the X / Y / Z, XY / XZ / YZ by a slot), or a chip.
      for (const it of items) {
        if (it.type === 'choice') {
          const o = it.options.find(x => same(x.label, label));
          if (o) {
            it.onChange(o.id);

            return `chose ${o.label}`;
          }
        }
        if (it.type === 'chips') {
          const c = it.chips.find(x => same(x.label, label));
          if (c) {
            c.onClick();

            return `tapped ${c.label}`;
          }
        }
      }
      const btn = ui.panelSpec?.actions?.find(a => same(a.label, label) || a.id === label);
      if (btn?.run) {
        btn.run();

        return `pressed ${btn.label}`;
      }

      return `No "${label}" in the window. sg.panel() lists its rows.`;
    },

    /** Give the open tool's waiting slot a pick (a face, edge, profile, plane…), as a tap on it would. */
    pick(sel: Sel, point?: [number, number, number]): string {
      const t = inside.tool;
      const slot = t.slots?.[t.active ?? -1];
      if (!slot) {
        return 'No slot waiting (sg.set(<slot label>) makes one wait).';
      }
      let at = point;
      if (!at && (sel.kind === 'face' || sel.kind === 'edge')) {
        const b = app.view.body(sel.body);
        at = sel.kind === 'face' ? b?.faces[sel.face]?.center : b?.edges[sel.edge]?.mid;
      }
      const hit = { ...sel, point: at ?? [0, 0, 0] } as PickHit;
      if (!slot.accept(hit)) {
        return `${slot.label} doesn't take that.`;
      }
      t.advance?.();
      t.render?.();
      t.update?.();

      return `${slot.label}: picked`;
    },

    /** Done / Cancel in the open tool's window. */
    done(): string {
      const spec = ui.panelSpec;
      if (!spec?.onDone) {
        return 'No window with Done open.';
      }
      spec.onDone();

      return `done: ${spec.title}`;
    },
    cancel(): string {
      const spec = ui.panelSpec;
      if (spec?.onCancel) {
        spec.onCancel();
      } else {
        app.setTool(null);
      }

      return 'cancelled';
    },

    undo: () => inside.undo(),
    redo: () => inside.redo(),

    /** Wait until the geometry engine has nothing left to do (and the page has drawn it). */
    async idle(timeoutMs = 30000): Promise<boolean> {
      const k = app.kernel as unknown as { pending: Map<number, unknown>; regenRunning: boolean };
      const t0 = performance.now();
      let quiet = 0;
      while (performance.now() - t0 < timeoutMs) {
        await new Promise(r => setTimeout(r, 50));
        quiet = k.pending.size || k.regenRunning ? 0 : quiet + 1;
        if (quiet >= 3) {
          return true;
        }
      }

      return false;
    },

    /** The project as saved (JSON). */
    save: () => JSON.stringify(app.store.doc),

    /**
     * Open a project (its JSON, as text or object) as a new one in the
     * library, as File → Open does; the one open now is kept. Resolves once
     * it is built.
     */
    async load(project: string | object, name?: string): Promise<string> {
      const doc = parseProject(typeof project === 'string' ? project : JSON.stringify(project));
      if (name) {
        doc.name = name;
      }
      await inside.switchProject(doc, newProjectId());
      await sg.idle();

      return doc.name;
    },

    /** What there is, with one line each. */
    help(): number {
      const lines: string[] = Object.entries(sg as Record<string, unknown>)
        .filter(([k]) => k !== 'app')
        .map(([k, v]) => (typeof v === 'function' ? `sg.${k}(${((v as () => void).toString().match(/^[^(]*\(([^)]*)\)/)?.[1] ?? '').replace(/\s+/g, ' ')})` : `sg.${k}`));
      console.log(lines.join('\n'));

      return lines.length;
    }
  };

  (window as unknown as { sg: typeof sg }).sg = sg;
}
