// Shared pieces of the grid tests (gridbooleans, gridextrude, gridfillet, gridshapes,
// gridfaces, gridsizes, shellclose): one operation tried over a grid of shapes, places
// and sizes, each result held to a volume worked out by hand and to being one sound solid.
//
//   import { build, say, near, faceRef, edgeRefs } from "./grid";
//   const g = await build([...steps]);
//   say(!g.errors.length && !g.unsound.length && near(g.vol.A, 24000), "a block", `${g.errors} ${g.unsound} ${g.vol.A}`);
import { measureArea, type Shape3D } from 'replicad';
import { after, bodies, check, health } from './kit';
import type { Feature, Vec3 } from '../src/doc/types';

/** One case: ok or FAIL, with what was found when it fails. */
export const say = (ok: boolean, name: string, info: string) => check(name, ok, ok ? '' : info);

export interface Got {
  /** The steps' errors ("step: message"). */
  errors: string[];
  ids: string[];
  /** Each body's volume. */
  vol: Record<string, number>;
  /** What is wrong with the bodies (invalid, more solids than expected, open edges, hair-thin faces). */
  unsound: string[];
}

/** Build the steps: each body's volume, and whether it is one sound solid (`pieces`: bodies meant to be more, or 0 for any number). */
export async function build(fs: Feature[], pieces: Record<string, number> = {}): Promise<Got> {
  const { errors } = await after(fs);
  const vol: Record<string, number> = {};
  const unsound: string[] = [];
  for (const [id, body] of bodies()) {
    const bodyHealth = health(body);
    vol[id] = bodyHealth.volume;
    const want = pieces[id] ?? 1;
    if (!bodyHealth.valid) {
      unsound.push(`${id} invalid`);
    }
    if (want && bodyHealth.solids !== want) {
      unsound.push(`${id}: ${bodyHealth.solids} solids`);
    }
    if (bodyHealth.openEdges) {
      unsound.push(`${id}: ${bodyHealth.openEdges} open edges`);
    }
    if (bodyHealth.thin) {
      unsound.push(`${id}: ${bodyHealth.thin} thin faces`);
    }
  }

  return { errors, ids: [...bodies().keys()], vol, unsound };
}

/** The same number, to a part in ten thousand (or `rel`). */
export const near = (a: number, b: number, rel = 1e-4, abs = 1e-6) => Math.abs(a - b) <= Math.max(abs, rel * Math.max(Math.abs(a), Math.abs(b)));

const unit = (vector: Vec3): Vec3 => {
  const length = Math.hypot(vector[0], vector[1], vector[2]) || 1;

  return [vector[0] / length, vector[1] / length, vector[2] / length];
};

/**
 * A face of a body, as the last build left it, by a test on its (unit) normal
 * and its middle: the reference a step takes. Build the steps before it first -
 * the faces are those of the last build.
 */
export function faceRef(body: string, pick: (n: Vec3, c: Vec3, f: any) => boolean) {
  const shape = bodies().get(body) as Shape3D;
  // (replicad's normalAt isn't a unit vector on round faces.)
  const face = shape.faces.find(face => pick(unit(face.normalAt().toTuple() as Vec3), face.center.toTuple() as Vec3, face));
  if (!face) {
    throw new Error(`no such face on ${body}`);
  }

  return { body, center: face.center.toTuple() as Vec3, normal: unit(face.normalAt().toTuple() as Vec3), area: measureArea(face) };
}

/** Edges of a body, as the last build left it, by a test on their middle and direction. */
export function edgeRefs(body: string, pick: (mid: Vec3, dir: Vec3, e: any) => boolean) {
  const shape = bodies().get(body) as Shape3D;

  return shape.edges
    .filter(e => pick(e.pointAt(0.5).toTuple() as Vec3, e.tangentAt(0.5).toTuple() as Vec3, e))
    .map(e => ({ body, mid: e.pointAt(0.5).toTuple() as Vec3, dir: e.tangentAt(0.5).toTuple() as Vec3, length: e.length as number }));
}
