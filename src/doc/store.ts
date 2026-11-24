import { entityPolylines } from '../sketch/curves';
import { arrangement, regionRef } from '../sketch/regions';
import { pointInPoly } from '../sketch/curves';
import { resolveDoc } from './params';
import { emptyDoc, type Feature, type FeatureType, type ProjectDoc, type SketchEntity } from './types';

/** While set, commits made under the same key join into one undo step. */
let mergeKey: object | null = null;

/**
 * Run `fn` with its commits merged with the ones made before under the same
 * key (and nothing else in between): a value typed key by key into one box -
 * 3, 30, 30.5 - is one undo step, not three.
 */
export function mergingCommits(key: object, fn: () => void): void {
  const was = mergeKey;
  mergeKey = key;
  try {
    fn();
  } finally {
    mergeKey = was;
  }
}

// Earlier builds were called "Tessel": their autosave is still picked up.
const LEGACY_KEY = 'tessel.autosave.v1';
const DB_NAME = 'supergeometry';
const OLD_DB_NAME = 'tessel';
const MAX_UNDO = 200;

type Listener = () => void;

const LABELS: Record<FeatureType, string> = {
  sketch: 'Sketch',
  extrude: 'Extrude',
  fillet: 'Fillet',
  chamfer: 'Chamfer',
  boolean: 'Boolean',
  delete: 'Delete',
  revolve: 'Revolve',
  sweep: 'Sweep',
  loft: 'Loft',
  shell: 'Shell',
  transform: 'Transform',
  split: 'Split',
  plane: 'Plane',
  axis: 'Axis',
  import: 'Import',
  image: 'Image',
  deleteGeom: 'Delete',
  moveFace: 'Move Face',
  freeform: 'Freeform',
  scaleFace: 'Scale Face',
  replaceFace: 'Replace Face',
  repair: 'Repair',
  fillToPlane: 'Fill to Plane',
  fill: 'Fill',
  connect: 'Connect',
  faceFreeform: 'Freeform Face',
  freeformEdit: 'Edit Freeform',
  thread: 'Thread',
  imprint: 'Project as Edge',
  wrap: 'Wrap & Emboss'
};

/** Steps still being tried out: shown with a BETA tag wherever they appear. */
export const BETA_TYPES: ReadonlySet<string> = new Set(['connect', 'faceFreeform', 'imprint', 'wrap']);

/**
 * Holds the document and its undo/redo history. Every change goes through
 * `commit`, which snapshots the previous state, so undo is exact.
 */
/**
 * Undo snapshots are whole documents as text. Big values in them (an imported
 * model, an image - megabytes of base64) are kept once, and each snapshot
 * holds only a short reference: otherwise 200 undo steps would hold 200 copies.
 */
const BIG = 50_000;
const bigById = new Map<string, string>();
const idOfBig = new Map<string, string>();
const REF = '\u0000sg-big:';

function pack(doc: ProjectDoc): string {
  return JSON.stringify(doc, (_k, value) => {
    if (typeof value !== 'string' || value.length < BIG) {
      return value;
    }
    let id = idOfBig.get(value);
    if (!id) {
      id = `${REF}${idOfBig.size}`;
      idOfBig.set(value, id);
      bigById.set(id, value);
    }

    return id;
  });
}

function unpack(text: string): ProjectDoc {
  return JSON.parse(text, (_k, value) => (typeof value === 'string' && value.startsWith(REF) ? (bigById.get(value) ?? value) : value));
}

export class DocStore {
  doc: ProjectDoc = emptyDoc();
  private undoStack: string[] = [];
  private redoStack: string[] = [];
  private listeners = new Set<Listener>();
  private saveTimer = 0;

  /** Restore the autosaved project (IndexedDB, or the old localStorage slot). */
  async load(): Promise<void> {
    const saved = (await idbGet('autosave')) ?? (await idbGet('autosave', OLD_DB_NAME)) ?? legacyAutosave();
    if (saved) {
      try {
        this.doc = migrate(JSON.parse(saved));
        await this.loadHistory(saved);
      } catch {
        // A broken autosave must never block the app.
      }
    }
    this.loaded = true;
    this.listeners.forEach(fn => fn());
  }
  /** Until the saved project is read, saving would overwrite it with an empty one. */
  private loaded = false;

  /**
   * Undo survives a reload (a phone drops the page whenever it likes): the
   * stacks are saved beside the project, and taken back only if they end at
   * exactly the project that was loaded.
   */
  private async loadHistory(saved: string): Promise<void> {
    const text = await idbGet('undo');
    if (!text) {
      return;
    }
    const savedHistory = JSON.parse(text) as SavedHistory;
    if (savedHistory.head !== hashText(saved) || !Array.isArray(savedHistory.undo) || !Array.isArray(savedHistory.redo)) {
      return;
    }
    for (const [id, bigValue] of savedHistory.big ?? []) {
      bigById.set(id, bigValue);
      idOfBig.set(bigValue, id);
    }
    this.undoStack = savedHistory.undo;
    this.redoStack = savedHistory.redo;
  }

  private historyTimer = 0;
  private saveHistory(docText: string): Promise<void> {
    clearTimeout(this.historyTimer);
    // The newest steps first, up to a few MB (200 snapshots of a big model would be hundreds).
    const keep = (stack: string[]) => {
      const out: string[] = [];
      let left = HISTORY_BYTES / 2;
      for (let i = stack.length - 1; i >= 0 && left - stack[i].length >= 0; i--) {
        left -= stack[i].length;
        out.unshift(stack[i]);
      }

      return out;
    };
    const undo = keep(this.undoStack), redo = keep(this.redoStack);
    const refs = new Set<string>();
    for (const t of [...undo, ...redo]) {
      for (const match of t.matchAll(/\\u0000sg-big:(\d+)/g)) {
        refs.add(REF + match[1]);
      }
    }
    const big = [...refs].filter(id => bigById.has(id)).map(id => [id, bigById.get(id)!] as [string, string]);
    const savedHistory: SavedHistory = { head: hashText(docText), undo, redo, big };

    return idbSet('undo', JSON.stringify(savedHistory));
  }

  onChange(fn: Listener): () => void {
    this.listeners.add(fn);

    return () => this.listeners.delete(fn);
  }

  get features(): readonly Feature[] {
    return this.doc.features;
  }

  find<T extends Feature = Feature>(id: string): T | undefined {
    return this.doc.features.find(feature => feature.id === id) as T | undefined;
  }

  /** Unique id + "Extrude 03"-style name for a new feature. */
  newIdentity(type: FeatureType, label = LABELS[type]): { id: string; name: string } {
    // One past the highest number in use (a step deleted from the middle doesn't free its number for a duplicate).
    // Only "<label> <number>": "Freeform surface 01" isn't one of the "Freeform"s.
    const mine = this.doc.features.filter(feature => feature.name.startsWith(label + ' ') && /^\d+$/.test(feature.name.slice(label.length + 1)));
    const nextNumber = Math.max(0, mine.length, ...mine.map(feature => Number(feature.name.slice(label.length + 1)))) + 1;

    return { id: newId(type), name: `${label} ${String(nextNumber).padStart(2, '0')}` };
  }

  /** Expressions that couldn't be evaluated / sketches that can't be solved. */
  problems: string[] = [];
  private transientBase: string | null = null;

  /** Apply a mutation as one undoable step. */
  commit(mutate: (doc: ProjectDoc) => void): void {
    const before = this.transientBase ?? pack(this.doc);
    const next = unpack(pack(this.doc));
    mutate(next);
    // With a breakpoint: what's after it stays last, so a new step goes in at the breakpoint.
    if (next.features.some(feature => feature.rolledBack)) {
      next.features = [...next.features.filter(feature => !feature.rolledBack), ...next.features.filter(feature => feature.rolledBack)];
    }
    this.problems = resolveDoc(next);
    const wasLive = this.transientBase !== null;
    this.transientBase = null;
    if (pack(next) === before) {
      // No change overall - but after a drag that came back to where it began,
      // the document must still end up there (not at the drag's last frame).
      if (wasLive) {
        this.doc = next;
        this.listeners.forEach(fn => fn());
      }

      return;
    }
    // The same box typed into again: still the step it began (its first undo state stays).
    const joins = mergeKey !== null && mergeKey === this.lastMerge && this.undoStack.length > 0;
    if (!joins) {
      this.undoStack.push(before);
    }
    this.lastMerge = mergeKey;
    if (this.undoStack.length > MAX_UNDO) {
      this.undoStack.shift();
    }
    this.redoStack = [];
    this.doc = next;
    this.changed();
  }

  /** The merge key of the last commit (see mergingCommits). */
  private lastMerge: object | null = null;

  /**
   * Live edits during a drag: update the document and notify, but leave undo
   * alone; the next `commit` records everything since the drag began as one step.
   */
  transient(mutate: (doc: ProjectDoc) => void): void {
    this.transientBase ??= pack(this.doc);
    const next = unpack(pack(this.doc));
    mutate(next);
    this.doc = next;
    this.listeners.forEach(fn => fn());
  }

  /**
   * What the engine worked out for the project as it is (a sketch's curves
   * where the edges they follow are now): taken in as it stands - not a step
   * to undo, and nothing for the engine to do again.
   */
  adopt(mutate: (doc: ProjectDoc) => void): void {
    const next = unpack(pack(this.doc));
    mutate(next);
    this.doc = next;
    this.changed(false);
  }

  add(feature: Feature): void {
    this.commit(draft => draft.features.push(feature));
  }

  update(id: string, patch: Partial<Feature>): void {
    this.commit((draft) => {
      const i = draft.features.findIndex(feature => feature.id === id);
      if (i >= 0) {
        draft.features[i] = { ...draft.features[i], ...patch } as Feature;
      }
    });
  }

  remove(id: string): void {
    this.commit((draft) => {
      const gone = draft.features.find(feature => feature.id === id);
      draft.features = draft.features.filter(feature => feature.id !== id);
      // Its sketches, now used by nothing, come back into view to be used again
      // (they were hidden once used: deleting a cut left its sketch invisible).
      const used = (feature: Feature) => sketchesOf(feature);
      const still = new Set(draft.features.flatMap(used));
      const free = gone ? used(gone).filter(sketchId => !still.has(sketchId)) : [];
      if (free.length) {
        draft.hidden = draft.hidden.filter(hiddenId => !free.includes(hiddenId));
      }
    });
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }
  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /** How many states the history holds (the one now included). */
  get historyLength(): number {
    return this.undoStack.length + 1 + this.redoStack.length;
  }
  /** Where the document now is in the history: 0 is the oldest state. */
  get historyPosition(): number {
    return this.undoStack.length;
  }

  /** Go straight to a state of the history (see historyPosition); the rest stays undoable and redoable. */
  jumpTo(position: number): void {
    const timeline = [...this.undoStack, pack(this.doc), ...[...this.redoStack].reverse()];
    if (!Number.isInteger(position) || position < 0 || position >= timeline.length || position === this.undoStack.length) {
      return;
    }
    this.lastMerge = null;
    this.undoStack = timeline.slice(0, position);
    this.redoStack = timeline.slice(position + 1).reverse();
    this.doc = unpack(timeline[position]);
    this.changed();
  }

  undo(): void {
    const prev = this.undoStack.pop();
    if (!prev) {
      return;
    }
    this.lastMerge = null;
    this.redoStack.push(pack(this.doc));
    this.doc = unpack(prev);
    this.changed();
  }

  redo(): void {
    const next = this.redoStack.pop();
    if (!next) {
      return;
    }
    this.lastMerge = null;
    this.undoStack.push(pack(this.doc));
    this.doc = unpack(next);
    this.changed();
  }

  /**
   * Switch to another project (from the library, a file, or a new one): its
   * own document, with no undo history - undo never reaches into another project.
   */
  openDoc(doc: ProjectDoc): void {
    this.doc = migrate(structuredClone(doc));
    this.problems = resolveDoc(this.doc);
    this.transientBase = null;
    this.undoStack = [];
    this.redoStack = [];
    this.lastMerge = null;
    this.changed();
  }

  /** Called with the project's text each time it is autosaved (the library keeps its copy). */
  onSaved: ((text: string) => void) | null = null;

  /** Replace the whole document (open file / new project). Undoable. */
  replace(doc: ProjectDoc): void {
    this.commit((draft) => {
      // Drop every key first: anything the new document doesn't have (folders,
      // colours, custom names…) must not linger from the old one.
      for (const key of Object.keys(draft)) {
        delete (draft as unknown as Record<string, unknown>)[key];
      }
      Object.assign(draft, structuredClone(doc));
    });
  }

  /** Save the project now (before the page reloads). */
  async flush(): Promise<void> {
    if (!this.loaded) {
      return;
    }
    clearTimeout(this.saveTimer);
    const edits = this.edits;
    const text = JSON.stringify(this.doc);
    await idbSet('autosave', text);
    this.wrote(edits);
    this.onSaved?.(text);
    await this.saveHistory(text);
  }

  /** Every change made is written to this device (false from a change until its save is done). */
  saved = true;
  private edits = 0;
  private savedListeners = new Set<Listener>();
  onSavedState(fn: Listener): void {
    this.savedListeners.add(fn);
  }
  private setSaved(on: boolean): void {
    if (this.saved === on) {
      return;
    }
    this.saved = on;
    this.savedListeners.forEach(fn => fn());
  }
  /** A save of the state after change `version` is written: saved, unless more came since. */
  private wrote(version: number): void {
    if (version === this.edits) {
      this.setSaved(true);
    }
  }

  private changed(tell = true): void {
    this.edits++;
    this.setSaved(false);
    if (tell) {
      this.listeners.forEach(fn => fn());
    }
    clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      const edits = this.edits;
      const text = JSON.stringify(this.doc);
      // (A write that failed is tried again: left, the name's mark said "Saving…" from then on.)
      const write = (tries: number): void =>
        void idbSet('autosave', text).then(
          () => this.wrote(edits),
          () => tries > 0 && edits === this.edits && window.setTimeout(() => write(tries - 1), 2000)
        );
      write(3);
      this.onSaved?.(text);
      // The undo steps less eagerly: they're bigger, and only matter after a reload.
      clearTimeout(this.historyTimer);
      this.historyTimer = window.setTimeout(() => void this.saveHistory(text), 1200);
    }, 400);
  }
}

/** Undo history as saved: the stacks, the big values they refer to, and the project they lead up to. */
interface SavedHistory {
  head: string;
  undo: string[];
  redo: string[];
  big: [string, string][];
}
const HISTORY_BYTES = 8_000_000;

/** A short fingerprint of a saved project (FNV-1a, plus the length). */
function hashText(t: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < t.length; i++) {
    hash = Math.imul(hash ^ t.charCodeAt(i), 0x01000193);
  }

  return `${t.length}:${(hash >>> 0).toString(36)}`;
}

/** The sketches a step makes something from (its profiles). */
function sketchesOf(feature: Feature): string[] {
  const srcs = feature.type === 'extrude' || feature.type === 'revolve' || feature.type === 'sweep' ? [feature.source] : feature.type === 'loft' ? feature.sections : [];

  return srcs.flatMap(source => (source.kind === 'profile' ? [source.sketch] : []));
}

export function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

export function parseProject(text: string): ProjectDoc {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    // (Not the parser's "Expected ',' or '}' at position 47".)
    throw new Error('The file is damaged - cut short, or not a project file');
  }

  return migrate(raw);
}

// ------------------------------------------------------------------ migration

/** Bring any saved project up to the current format. */
/**
 * A project file can come from anyone: what the app later puts on the page as a colour is kept to what a colour
 * is ("#rrggbb"), and what it uses as a number is a number. Anything else is dropped (the body is the default grey).
 */
function cleanLooks(doc: ProjectDoc): void {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
  const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
  if (doc.colors !== undefined) {
    doc.colors = record(doc.colors) ? Object.fromEntries(Object.entries(doc.colors).filter((e): e is [string, string] => typeof e[1] === 'string' && hex.test(e[1]))) : undefined;
  }
  if (doc.opacity !== undefined) {
    doc.opacity = record(doc.opacity) ? Object.fromEntries(Object.entries(doc.opacity).filter((e): e is [string, number] => typeof e[1] === 'number' && Number.isFinite(e[1]))) : undefined;
  }
  if (Array.isArray(doc.customMaterials)) {
    for (const customMaterial of doc.customMaterials) {
      if (typeof customMaterial.color !== 'string' || !hex.test(customMaterial.color)) {
        customMaterial.color = '#9aa3ad';
      }
    }
  }
}

export function migrate(raw: unknown): ProjectDoc {
  const out = migrate0(raw);
  cleanLooks(out);

  return out;
}

function migrate0(raw: unknown): ProjectDoc {
  const doc = raw as ProjectDoc & { version: number };
  // "tessel" is the format name of files saved before the rename.
  if (!doc || (doc.format !== 'super' && (doc.format as string) !== 'tessel') || !Array.isArray(doc.features)) {
    throw new Error('Not a superGeometry.app project file');
  }
  if (doc.version === 2) {
    return { ...emptyDoc(), ...doc, format: 'super' };
  }
  // A newer app saved it: read as an old one, it would come out mangled.
  if (doc.version > 2) {
    throw new Error('This project was saved by a newer version of the app - reload the page to update');
  }

  // v1: rect {a, b}; extrude profiles referenced entity ids.
  const sketches = new Map<string, SketchEntity[]>();
  for (const feature of doc.features as unknown as Array<Record<string, any>>) {
    if (feature.type === 'sketch') {
      feature.entities = feature.entities.map((e: any) => {
        if (e.kind === 'rect' && e.a) {
          return { id: e.id, kind: 'rect', center: [(e.a[0] + e.b[0]) / 2, (e.a[1] + e.b[1]) / 2], w: Math.abs(e.b[0] - e.a[0]), h: Math.abs(e.b[1] - e.a[1]), rotation: 0 };
        }

        return e;
      });
      sketches.set(feature.id, feature.entities);
    }
    if (feature.type === 'extrude' && feature.source?.kind === 'profile' && feature.source.entities) {
      const entities = sketches.get(feature.source.sketch) ?? [];
      feature.source = { kind: 'profile', sketch: feature.source.sketch, regions: regionsForEntities(entities, feature.source.entities) };
    }
  }

  return { ...emptyDoc(), ...doc, format: 'super', version: 2 } as ProjectDoc;
}

/** v1 profiles were "entity minus what's inside it": pick the regions that matches. */
function regionsForEntities(entities: SketchEntity[], ids: string[]) {
  const arr = arrangement(entities);
  const outline = (e: SketchEntity) => entityPolylines(e).flat();
  const areaOf = (pts: [number, number][]) => {
    let a = 0;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      a += (pts[j][0] + pts[i][0]) * (pts[j][1] - pts[i][1]);
    }

    return Math.abs(a / 2);
  };

  return arr.regions
    .filter((region) => {
      const owners = entities.filter(e => pointInPoly(region.centroid, outline(e)));
      if (!owners.length) {
        return false;
      }
      const smallest = owners.reduce((a, b) => (areaOf(outline(a)) < areaOf(outline(b)) ? a : b));

      return ids.includes(smallest.id);
    })
    .map(regionRef);
}

// ---------------------------------------------------------------- IndexedDB

function db(name = DB_NAME): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(name, 1);
      req.onupgradeneeded = () => req.result.createObjectStore('kv');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export async function idbGet(key: string, dbName = DB_NAME): Promise<string | null> {
  const database = await db(dbName);
  if (!database) {
    return null;
  }

  return new Promise((resolve) => {
    const req = database.transaction('kv').objectStore('kv').get(key);
    req.onsuccess = () => resolve((req.result as string) ?? null);
    req.onerror = () => resolve(null);
  });
}

export async function idbSet(key: string, value: string): Promise<void> {
  const database = await db();
  if (!database) {
    return;
  }
  await new Promise<void>((resolve) => {
    const t = database.transaction('kv', 'readwrite');
    t.objectStore('kv').put(value, key);
    t.oncomplete = t.onerror = t.onabort = () => resolve();
  });
}

export async function idbDel(key: string): Promise<void> {
  const database = await db();
  if (!database) {
    return;
  }
  await new Promise<void>((resolve) => {
    const t = database.transaction('kv', 'readwrite');
    t.objectStore('kv').delete(key);
    t.oncomplete = t.onerror = t.onabort = () => resolve();
  });
}

function legacyAutosave(): string | null {
  try {
    return localStorage.getItem(LEGACY_KEY);
  } catch {
    return null;
  }
}
