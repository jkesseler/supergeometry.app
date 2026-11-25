import type { Shape3D } from 'replicad';
import type { OriginOf } from './provenance';
import type { Recorded } from './readTracking';
import type { Ctx } from './types';

export interface CacheEntry extends Recorded {
  key: string;
  ctx: Ctx;
  id?: string;
  /** Worked, but had to give something up (shown on the step in History). */
  note?: string;
  /** Which of its faces a face is (see provenance.ts): for steps made from a sketch. */
  origin?: OriginOf;
}

let current: CacheEntry[] = [];
/**
 * The saved project's steps, kept while a step is being changed (its previews
 * fill `current`): Cancel goes back to them at once, not after a rebuild of
 * every step after the one that was open.
 */
let saved: CacheEntry[] = [];
/** The project with its threads left plain, as drawings draw it (kept apart from `current`). */
let drawing: CacheEntry[] = [];
/** The solids of the last rebuild (for tests that check the real geometry, not just its mesh). */
let bodies: Map<string, Shape3D> = new Map();

/** Where a rebuild of the model looks for steps it has already built, nearest first. */
export function modelLookup(): CacheEntry[][] {
  return [current, saved];
}

/** For drawings: their own steps first, then the model's (the steps before its first thread are the same). */
export function drawingLookup(): CacheEntry[][] {
  return [drawing, saved, current];
}

export function keepModelRebuild(entries: CacheEntry[], rebuilt: Map<string, Shape3D>, isSaved: boolean): void {
  current = entries;
  if (isSaved) {
    saved = entries;
  }
  bodies = rebuilt;
}

export function keepDrawingRebuild(entries: CacheEntry[], rebuilt: Map<string, Shape3D>): void {
  drawing = entries;
  bodies = rebuilt;
}

export function lastRebuiltBodies(): Map<string, Shape3D> {
  return bodies;
}

export function resetRebuildCache(): void {
  current = [];
  saved = [];
  drawing = [];
  bodies = new Map();
}
