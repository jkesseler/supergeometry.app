import type { Shape3D, Wire } from 'replicad';
import type { Feature, SketchEntity, SketchFeature } from '../doc/types';
import type { ConstructionInfo } from './protocol';

export type Bodies = Map<string, Shape3D>;
export type SketchState = SketchFeature & { boundary: SketchEntity[] };

export interface Ctx {
  bodies: Bodies;
  sketches: Map<string, SketchState>;
  planes: Map<string, ConstructionInfo>;
  axes: Map<string, ConstructionInfo>;
  /**
   * Bodies that are still a freeform cage moved/scaled by an affine map: they can
   * be rebuilt exactly (e.g. stretched along X/Y/Z, which other bodies can't be).
   */
  freeforms: Map<string, { feature: Extract<Feature, { type: 'freeform' }>; m: Affine }>;
  /** The paths sweeps ran along (by sweep): an offset of a sweep's end follows its path back. */
  sweeps: Map<string, Wire>;
  /**
   * Bodies linked to one another (a copy or a pattern made with Link on, and what it was made from): which group
   * each is of, and where it stands in it - the map that takes the group's shape to this body. A step that changes
   * one of a group changes the others the same way (see `followLinks`).
   */
  links: Map<string, { group: string; m: Affine }>;
}

/** x' = A x + t, as [a00 a01 a02 t0, a10 a11 a12 t1, a20 a21 a22 t2]. */
export type Affine = number[];
