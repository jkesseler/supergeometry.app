// Which snap point a tap lands on, among those within reach (distances in
// screen pixels). Pure: tests/desklamp.test.ts.

export interface SnapCandidate {
  /** Screen distance from the pointer, in pixels. */
  distance: number;
  /** A point of a curve (drawing there adds a Coincident). */
  ref?: unknown;
  /** The middle of a line (kept there). */
  mid?: string;
  /** A point of the model or the origin (held there). */
  model?: boolean;
}

/**
 * The nearest candidate within `tolerance`. Two on one spot (within half a pixel,
 * e.g. a line's end and the middle of a rectangle's side): the one a drawing
 * there can be kept on wins - a circle centred there took the side's middle
 * (nothing to keep) and stayed behind when the line moved.
 */
export function nearestSnap<T extends SnapCandidate>(candidates: T[], tolerance: number): T | null {
  const keeps = (x: SnapCandidate) => !!(x.ref || x.mid || x.model);
  let best: T | null = null;
  for (const candidate of candidates) {
    if (candidate.distance >= tolerance) {
      continue;
    }
    if (!best || candidate.distance < best.distance - 0.5 || (candidate.distance < best.distance + 0.5 && keeps(candidate) && !keeps(best))) {
      best = candidate;
    }
  }

  return best;
}
