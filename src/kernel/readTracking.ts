import type { Ctx } from './types';

// These bypass the read log: asking the model through them is not a read of it.
export const rawGet = <V>(map: Map<string, V>, key: string): V | undefined => Map.prototype.get.call(map, key) as V | undefined;
export const rawHas = (map: Map<string, unknown>, key: string): boolean => Map.prototype.has.call(map, key) as boolean;
export const rawEntries = <V>(map: Map<string, V>): [string, V][] => [...(Map.prototype.entries.call(map) as IterableIterator<[string, V]>)];

/**
 * What a step read of the model before it, as it ran: so that when an
 * earlier step changes, a step that read nothing of what changed is not
 * rebuilt - its result is put on the model as it is now.
 */
export interface Reads {
  /** Each thing it asked for ("bodies|id") and what it got (undefined: not there). */
  one: Map<string, unknown>;
  /** Kinds it looked through all of (any change among them is a change for it). */
  all: Set<keyof Ctx>;
  written: Set<string>;
}

/** What a step changed in the model: kind, id, the value there afterwards, and whether it is there at all. */
export type Delta = [keyof Ctx, string, unknown, boolean][];

/** What is kept of a step's run to tell later whether it can be put back as it was. */
export interface Recorded {
  /** The step's values as text (hashed): the same step, unchanged? */
  json?: string;
  /** What it read of the model before it, that model, and what it changed in it. */
  reads?: Reads;
  input?: Ctx;
  delta?: Delta;
  /** The steps switched off when it ran (a failed step's words depend on it). */
  off?: string;
  error?: string;
}

let reading: Reads | null = null;

/** From here until `stopReading`, whatever is asked of the model's maps (through any step's copy of it) goes in `reads`. */
export function startReading(reads: Reads): void {
  reading = reads;
}

export function stopReading(): void {
  reading = null;
}

export const KINDS = ['bodies', 'sketches', 'planes', 'axes', 'freeforms', 'sweeps', 'links'] as const;

/** A map of the model (its bodies, sketches…) that notes what a step reads of it. */
export class Noted<V> extends Map<string, V> {
  private live = false;
  constructor(readonly kind: keyof Ctx, from?: Map<string, V>) {
    super();
    if (from) {
      for (const [key, value] of rawEntries(from)) {
        super.set(key, value);
      }
    }
    this.live = true;
  }
  private saw(entryKey: string, value: unknown): void {
    const key = `${this.kind}|${entryKey}`;
    if (reading && !reading.written.has(key) && !reading.one.has(key)) {
      reading.one.set(key, value);
    }
  }
  get(key: string): V | undefined {
    const value = super.get(key);
    this.saw(key, value);

    return value;
  }
  has(key: string): boolean {
    this.saw(key, super.get(key));

    return super.has(key);
  }
  set(key: string, value: V): this {
    if (this.live) {
      reading?.written.add(`${this.kind}|${key}`);
    }

    return super.set(key, value);
  }
  delete(key: string): boolean {
    reading?.written.add(`${this.kind}|${key}`);

    return super.delete(key);
  }
  clear(): void {
    reading?.all.add(this.kind);
    super.clear();
  }
  get size(): number {
    reading?.all.add(this.kind);

    return super.size;
  }
  keys(): MapIterator<string> {
    reading?.all.add(this.kind);

    return super.keys();
  }
  values(): MapIterator<V> {
    reading?.all.add(this.kind);

    return super.values();
  }
  entries(): MapIterator<[string, V]> {
    reading?.all.add(this.kind);

    return super.entries();
  }
  forEach(fn: (value: V, key: string, map: Map<string, V>) => void, thisArg?: unknown): void {
    reading?.all.add(this.kind);
    super.forEach(fn, thisArg);
  }
  [Symbol.iterator](): MapIterator<[string, V]> {
    reading?.all.add(this.kind);

    return super[Symbol.iterator]();
  }
}
/** The model for the next step to work on: a copy to change, the one before it left as it is. */
export function fork(ctx: Ctx): Ctx {
  return {
    bodies: new Noted('bodies', ctx.bodies),
    sketches: new Noted('sketches', ctx.sketches),
    planes: new Noted('planes', ctx.planes),
    axes: new Noted('axes', ctx.axes),
    freeforms: new Noted('freeforms', ctx.freeforms),
    sweeps: new Noted('sweeps', ctx.sweeps),
    links: new Noted('links', ctx.links)
  };
}

/** Is a step as it was last rebuilt, and everything it read of the model then still what is there now? */
export function unchangedFor(was: Recorded, json: string, ctx: Ctx, off: string): boolean {
  if (was.json !== json || !was.reads || !was.delta || !was.input) {
    return false;
  }
  // (What a failed step says can depend on which steps are switched off.)
  if (was.error && was.off !== off) {
    return false;
  }
  for (const [key, value] of was.reads.one) {
    const at = key.indexOf('|');
    if (rawGet(ctx[key.slice(0, at) as keyof Ctx] as Map<string, unknown>, key.slice(at + 1)) !== value) {
      return false;
    }
  }
  for (const kind of was.reads.all) {
    const [a, b] = [rawEntries(ctx[kind] as Map<string, unknown>), was.input[kind] as Map<string, unknown>];
    if (a.length !== rawEntries(b).length || a.some(([key, value]) => rawGet(b, key) !== value || !rawHas(b, key))) {
      return false;
    }
  }

  return true;
}

/** What a step changed in the model (and each of those as it was is something it went by, added to its reads). */
export function recordDelta(after: Ctx, before: Ctx, reads: Reads): Delta {
  const delta: Delta = [];
  for (const kind of KINDS) {
    const [changed, original] = [after[kind] as Map<string, unknown>, before[kind] as Map<string, unknown>];
    if (changed === original) {
      continue;
    }
    for (const key of new Set([...rawEntries(changed).map(rawEntry => rawEntry[0]), ...rawEntries(original).map(rawEntry => rawEntry[0])])) {
      if (rawGet(changed, key) === rawGet(original, key) && rawHas(changed, key) === rawHas(original, key)) {
        continue;
      }
      delta.push([kind, key, rawGet(changed, key), rawHas(changed, key)]);
      if (!reads.one.has(`${kind}|${key}`)) {
        reads.one.set(`${kind}|${key}`, rawGet(original, key));
      }
    }
  }

  return delta;
}
