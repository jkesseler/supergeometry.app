// Starting a thread on the picked round face or hole rim.

import { add, dist, scale } from '../geom';
import { ThreadOp } from '../tools/ops';
import { faceRefOf } from '../tools/tool';
import { HoleOp } from '../tools/holeOp';
import type { App } from '../app';

/** Thread the selected round face (a shank or a hole). */
export function startThread(app: App): void {
  let highlight = app.selection[0];
  // A round edge (a hole's rim): the round face of the same radius it bounds.
  if (highlight?.kind === 'edge') {
    const body = app.view.body(highlight.body);
    const e = body?.edges[highlight.edge];
    if (body && e?.type === 'CIRCLE') {
      const center = scale(add(e.start, e.mid), 0.5);
      const radius = dist(e.start, e.mid) / 2;
      let best = -1;
      let bestD = Infinity;
      body.faces.forEach((face, i) => {
        if (!face.round || Math.abs(face.round.r - radius) > radius * 1e-4) {
          return;
        }
        const distance = dist(face.center, center);
        if (distance < bestD) {
          (bestD = distance), (best = i);
        }
      });
      if (best >= 0) {
        highlight = { kind: 'face', body: highlight.body, face: best };
      }
    }
  }
  // Any other edge (a revolved shank's seam runs right along its top): the
  // round face under the finger.
  const at = app.selectTool.tapPoint;
  if (highlight?.kind === 'edge' && at) {
    const body = highlight.body;
    const under = app.view.facesAt(at.x, at.y).find(face => face.kind === 'face' && face.body === body && app.view.body(body)?.faces[face.face]?.round);
    if (under?.kind === 'face') {
      highlight = { kind: 'face', body, face: under.face };
    }
  }
  if (highlight?.kind !== 'face') {
    return void app.ui.toast('Threads go on round faces: tap a shank or a hole');
  }
  const info = app.view.body(highlight.body)?.faces[highlight.face];
  const ref = faceRefOf(app, highlight);
  if (!info?.round || !ref) {
    return void app.ui.toast('Threads go on round faces: tap a shank or a hole');
  }
  app.setSelection([highlight]);
  app.setTool(new ThreadOp(app, ref, info.round));
}

/** Hole: a screw's hole in the flat face picked, where it was tapped (its middle when the tap is not known). */
export function startHole(app: App): void {
  const highlight = app.selection[0];
  const info = highlight?.kind === 'face' ? app.view.body(highlight.body)?.faces[highlight.face] : undefined;
  const ref = highlight?.kind === 'face' ? faceRefOf(app, highlight) : null;
  if (highlight?.kind !== 'face' || !info?.plane || !ref) {
    return void app.ui.toast('Holes go into flat faces: tap one where the screw goes');
  }
  const tap = app.selectTool.tapPoint;
  const hit = tap ? app.view.pick(tap.x, tap.y, { edgeTolPx: 0 }) : null;
  const at = hit?.kind === 'face' && hit.body === highlight.body && hit.face === highlight.face ? hit.point : info.center;
  app.setSelection([highlight]);
  app.setTool(new HoleOp(app, ref, at, tap?.tol));
}
