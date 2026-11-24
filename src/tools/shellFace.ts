import { dot, scale, sub } from '../geom';
import type { FaceRef } from '../doc/types';

/**
 * A face tapped on a shell's preview, as the face of the body before it was
 * hollowed: the same face, or else the flat face parallel to it at most a wall
 * away (the inside of an end, seen through the end already opened).
 */
export function faceBeforeShell(original: FaceRef[], faceRef: FaceRef, thickness: number): FaceRef {
  const same = (face: FaceRef) => Math.hypot(...sub(face.center, faceRef.center)) < 1e-3 && dot(face.normal, faceRef.normal) > 0.999;
  if (!original.length || original.some(same)) {
    return faceRef;
  }
  let best: { o: FaceRef; d: number } | null = null;
  for (const face of original) {
    if (Math.abs(dot(face.normal, faceRef.normal)) < 0.999) {
      continue;
    }
    const off = sub(face.center, faceRef.center);
    const distance = Math.abs(dot(off, face.normal));
    const side = Math.hypot(...sub(off, scale(face.normal, dot(off, face.normal))));
    if (distance <= thickness + 0.5 && side < Math.sqrt(face.area) && (!best || distance < best.d)) {
      best = { o: face, d: distance };
    }
  }

  return best?.o ?? faceRef;
}
