import { need } from '../bodies';
import { resolveEdge, resolveFace } from '../references';
import { add, dot, norm, scale, sub } from '../../geom';
import { planeOf } from '../faceEdit';
import { faceMiddle, holeCutter, holeFault, roundCentre } from '../hole';
import { holeFromLines } from '../../doc/holeSizes';
import { insideOf, volumeOf } from '../booleans';
import type { Shape3D } from 'replicad';
import type { HoleFeature, Vec3 } from '../../doc/types';
import type { Ctx } from '../types';

export function applyHole(feature: HoleFeature, ctx: Ctx) {
  const { bodies } = ctx;
  const body = need(bodies, feature.face.body);
  const face = resolveFace(body, feature.face, candidate => candidate.geomType === 'PLANE');
  const out = norm(face.normalAt().toTuple() as Vec3);
  const on = planeOf(face).origin;
  // Where: the centre of the round edge it was put on, the face's middle, or the place itself - on the face's
  // plane as it is now (the face moved out or in since: the hole starts at it still).
  let at = feature.at;
  if (feature.around) {
    try {
      at = roundCentre(resolveEdge(body, feature.around)) ?? at;
    } catch {
      // The edge is gone: where it was put.
    }
  } else if (feature.centered) {
    at = faceMiddle(face);
  } else if (feature.from) {
    try {
      const lines = feature.from.map((x) => {
        const e = resolveEdge(body, x.edge);
        if (e.geomType !== 'LINE') {
          throw new Error('not straight');
        }

        return { a: e.pointAt(0).toTuple() as Vec3, b: e.pointAt(1).toTuple() as Vec3, d: x.d };
      });
      at = holeFromLines(at, faceMiddle(face), out, lines[0], lines[1]) ?? at;
    } catch {
      // An edge is gone, or round now: where it was put.
    }
  }
  at = sub(at, scale(out, dot(sub(at, on), out)));
  const into = scale(out, -1);
  // Right through: past the far side of the body, wherever that is.
  let depth = feature.depth;
  if (feature.through) {
    const [lo, hi] = body.boundingBox.bounds as [Vec3, Vec3];
    depth = 0;
    for (const x of [lo[0], hi[0]]) {
      for (const y of [lo[1], hi[1]]) {
        for (const z of [lo[2], hi[2]]) {
          depth = Math.max(depth, dot(sub([x, y, z], at), into));
        }
      }
    }
    depth += Math.max(1, feature.diameter);
  }
  const fault = holeFault(feature, depth);
  if (fault) {
    throw new Error(fault);
  }
  // Its mouth is open: nothing of the body over it. (Put on the plate under a boss - the boss's foot is a round
  // edge to catch on - it was drilled from the plate's face down, a hollow under the boss that nothing showed.)
  if (insideOf(body, [add(at, scale(out, Math.max(2e-3, feature.diameter * 0.05)))])[0]) {
    throw new Error('The body covers the hole there: tap the face the screw goes in from.');
  }
  const made = body.cut(holeCutter(feature, at, into, depth, Math.max(1e-3, feature.diameter * 0.01))) as Shape3D;
  if (!(volumeOf(body) - volumeOf(made) > 1e-9)) {
    throw new Error('The hole is off the body there: nothing to drill into. Drag it onto the face.');
  }
  bodies.set(feature.face.body, made);
}
