import { faceInfo } from './references';
import type { Face } from 'replicad';
import type { FaceInfo } from './protocol';

interface KeptFace {
  face: { IsEqual(o: unknown): boolean; IsNull(): boolean };
  info: FaceInfo;
}

/**
 * A face's facts, kept from the last time it was shown: a step changes a few of a body's faces and leaves the rest
 * the very same faces, and each one's exact area was measured again for the whole body all the same (a freeform
 * shoe with a hole cut in it: 1.7 s of measuring faces that hadn't changed).
 */
let infosNow = new Map<number, KeptFace[]>();
let infosWas = new Map<number, KeptFace[]>();
let infosKept = 0;

export function getFaceInfo(face: Face): FaceInfo {
  let hash = -1;
  try {
    hash = (face.wrapped as unknown as { HashCode(max: number): number }).HashCode(2147483647);
    for (const kept of [infosNow, infosWas]) {
      const hit = kept.get(hash)?.find(entry => !entry.face.IsNull() && entry.face.IsEqual(face.wrapped));
      if (hit) {
        if (kept === infosWas) {
          keepInfo(hash, hit);
        }

        return hit.info;
      }
    }
  } catch {
    // Measured, below.
  }
  const info = faceInfo(face);
  if (hash >= 0) {
    keepInfo(hash, { face: face.wrapped as never, info });
  }

  return info;
}

export function resetFaceInfos(): void {
  infosNow = new Map();
  infosWas = new Map();
  infosKept = 0;
}

function keepInfo(hash: number, entry: KeptFace): void {
  // (Not for ever: the faces of bodies long gone are let go, two lots back.)
  if (infosKept >= 6000) {
    infosWas = infosNow;
    infosNow = new Map();
    infosKept = 0;
  }
  const list = infosNow.get(hash);
  if (list) {
    list.push(entry);
  } else {
    infosNow.set(hash, [entry]);
  }
  infosKept++;
}
