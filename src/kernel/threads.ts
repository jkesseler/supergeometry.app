// ISO metric threads (60° V): sizes, coarse pitches, depths. No kernel deps,
// so the Thread tool's panel can use it too.

/** ISO 261 coarse pitch for each nominal diameter (mm). */
const COARSE: [number, number][] = [
  [1, 0.25], [1.2, 0.25], [1.4, 0.3], [1.6, 0.35], [2, 0.4], [2.5, 0.45], [3, 0.5], [3.5, 0.6], [4, 0.7], [5, 0.8], [6, 1], [7, 1], [8, 1.25], [10, 1.5],
  [12, 1.75], [14, 2], [16, 2], [18, 2.5], [20, 2.5], [22, 2.5], [24, 3], [27, 3], [30, 3.5], [33, 3.5], [36, 4], [39, 4], [42, 4.5], [45, 4.5], [48, 5],
  [52, 5], [56, 5.5], [60, 5.5], [64, 6]
];

/** The standard size nearest a diameter, and its coarse pitch. */
export function isoSize(diameter: number): { d: number; pitch: number } {
  let best = COARSE[0];
  for (const coarse of COARSE) {
    if (Math.abs(coarse[0] - diameter) < Math.abs(best[0] - diameter)) {
      best = coarse;
    }
  }

  return { d: best[0], pitch: best[1] };
}

/** Depth of the groove (ISO basic profile): outside threads 17/24·H, inside 5/8·H, H = 0.866 P. */
export function threadDepth(pitch: number, inside: boolean): number {
  const triangleHeight = (Math.sqrt(3) / 2) * pitch;

  return inside ? (5 / 8) * triangleHeight : (17 / 24) * triangleHeight;
}

/**
 * The nominal size a round face makes: an outside thread is cut into a
 * shank drawn at the nominal diameter; an inside one into a hole drawn at the
 * tap-drill size (nominal − pitch).
 */
export function nominalOf(faceDiameter: number, inside: boolean, pitch: number): number {
  return inside ? faceDiameter + pitch : faceDiameter;
}

/** For the panel: the pitch to start with for a round face. */
export function defaultPitch(faceDiameter: number, inside: boolean): number {
  // A hole: try sizes whose tap drill (nominal − pitch) is nearest the hole.
  if (inside) {
    let best = COARSE[0];
    for (const coarse of COARSE) {
      if (Math.abs(coarse[0] - coarse[1] - faceDiameter) < Math.abs(best[0] - best[1] - faceDiameter)) {
        best = coarse;
      }
    }

    return best[1];
  }

  return isoSize(faceDiameter).pitch;
}

/** "M10 × 1.5" (or "Ø10.3 × 1.5" when it isn't a standard size). */
export function threadLabel(faceDiameter: number, inside: boolean, pitch: number): string {
  const nominal = nominalOf(faceDiameter, inside, pitch);
  const std = isoSize(nominal);
  const fmt = (value: number) => String(Math.round(value * 100) / 100);

  return Math.abs(std.d - nominal) < 0.05 ? `M${fmt(std.d)} × ${fmt(pitch)}` : `Ø${fmt(nominal)} × ${fmt(pitch)}`;
}
