// Run: npx tsx tests/thickfillet.test.ts
// A freeform sheet given a thickness is a body like any other: the edges of its rim can be rounded and chamfered.
// Reported: every such rounding was refused with "That edit would turn the body inside out" - the solid's faces
// looked inwards. And an edge between two of its patches, with no corner along it, says so (not "radius too big").
import { planeCage } from '../src/freeform/cage';
import { after, check, done, health, volume } from './kit';
import type { Feature } from '../src/doc/types';

for (const bump of [0, 8]) {
  for (const side of ['up', 'down', 'both'] as const) {
    const cage = planeCage([40, 40], 4);
    for (const vertex of cage.verts) {
      vertex[2] += bump * Math.exp(-(vertex[0] * vertex[0] + vertex[1] * vertex[1]) / 200);
    }
    const ff = { id: 'FF', name: 'FF', type: 'freeform', cage: { verts: cage.verts, faces: cage.faces }, surface: true, thickness: 3, thickSide: side } as Feature;
    const name = `${bump ? 'a domed' : 'a flat'} sheet thickened ${side}`;
    const base = await after([ff], 'FF');
    const v0 = volume(base.body);
    check(`${name}: a sound solid`, !base.err && health(base.body!).healthy && v0 > 4000, v0.toFixed(1));
    const edges: any[] = (base.r as any).bodies[0].edges;
    const ref = (e: any) => ({ body: 'FF', mid: e.mid, dir: e.dir, length: e.length, steps: e.steps, curves: e.curves });
    // The rim's edges are the long ones (a patch's side, about 10); the short ones (3) are between the wall's patches.
    const rim = edges.filter(e => e.length > 5);
    const wall = edges.filter(e => e.length < 3.5);
    let ok = 0;
    let said = '';
    const tried = rim.filter((_, i) => i % 5 === 0);
    for (const e of tried) {
      const a = await after([ff, { id: 'F', name: 'F', type: 'fillet', edges: [ref(e)], radius: 1 } as Feature], 'FF');
      const bodyVolume = volume(a.body);
      if (!a.err && health(a.body!).healthy && bodyVolume < v0 && bodyVolume > v0 - 60) {
        ok++;
      } else {
        said ||= a.err ?? `volume ${bodyVolume.toFixed(1)} of ${v0.toFixed(1)}`;
      }
    }
    // (Some of the long edges are the lines between the sheet's own patches: smooth, and said to be.)
    const smoothSaid = tried.length - ok;
    check(`${name}: edges of the rim rounded 1 mm`, ok >= 2 && (!said || /smooth already/.test(said)), `${ok} of ${tried.length} rounded${smoothSaid ? `, the others: ${said}` : ''}`);
    const chamfered = await after([ff, { id: 'C', name: 'C', type: 'chamfer', edges: [ref(rim.find(e => Math.abs(e.mid[0]) > 19 || Math.abs(e.mid[1]) > 19)!)], radius: 1 } as Feature], 'FF');
    check(`${name}: an edge of the rim chamfered`, !chamfered.err && health(chamfered.body!).healthy && volume(chamfered.body) < v0, chamfered.err ?? volume(chamfered.body).toFixed(1));
    const filleted = await after([ff, { id: 'F', name: 'F', type: 'fillet', edges: [ref(wall[0])], radius: 1 } as Feature], 'FF');
    check(`${name}: an edge between two patches of the wall is said to be smooth`, /smooth already/.test(filleted.err ?? ''), filleted.err);
  }
}
done();
