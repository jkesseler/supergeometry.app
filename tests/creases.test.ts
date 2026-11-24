// Run: npx tsx tests/creases.test.ts - sharp edges on a freeform cage: the
// surface keeps a crease along them. The quick weights the editor draws with
// give the same points as the rules applied in full; a box with every edge
// sharp is that box exactly; one loop sharp is a cylinder-like end; tools that
// change the cage carry the sharp edges along.
import { applyPlan, boxCage, carryCreases, cageEdges, insertEdgeLoop, limitPoints, refineCage, removeEdgeLoop, subdivide, subdivisionPlan, edgeLoopOf, deleteFaces, type Cage } from '../src/freeform/cage';
import { check, done, near, after, volume, health } from './kit';
import type { Feature } from '../src/doc/types';

const same = (cage: Cage, levels = 3) => {
  const subdivided = subdivide(cage, levels);
  const exact = limitPoints(subdivided);
  const quick = applyPlan(subdivisionPlan(cage, levels), cage.verts);
  let worst = 0;
  exact.forEach((point, i) => (worst = Math.max(worst, Math.abs(point[0] - quick[i * 3]), Math.abs(point[1] - quick[i * 3 + 1]), Math.abs(point[2] - quick[i * 3 + 2]))));

  return { worst, n: exact.length, pts: exact };
};
const ff = (id: string, cage: Cage): Feature => ({ id, name: id, type: 'freeform', cage }) as Feature;

// A box, one face a side: all twelve edges sharp.
const box = boxCage([40, 30, 20], 1);
const all: Cage = { ...box, creases: cageEdges(box) };
check('a box has twelve edges', all.creases!.length === 12, all.creases!.length);
const a = same(all);
check('quick and full agree (every edge sharp)', a.worst < 1e-5, a.worst);
const lo = [0, 1, 2].map(axis => Math.min(...a.pts.map(point => point[axis])));
const hi = [0, 1, 2].map(axis => Math.max(...a.pts.map(point => point[axis])));
check('... and the surface is the box itself', near(hi[0] - lo[0], 40, 1e-9) && near(hi[1] - lo[1], 30, 1e-9) && near(hi[2] - lo[2], 20, 1e-9), [lo, hi]);
{
  const { body, err } = await after([ff('B', all)], 'B');
  check('made a solid: 40 x 30 x 20', !err && near(volume(body), 24000, 24), { err, v: volume(body) });
  check('... closed and sound', !!body && health(body).healthy, body && health(body));
}
// No sharp edges: as it always was (rounded, smaller).
{
  const match = same(box);
  check('quick and full agree (none sharp)', match.worst < 1e-5, match.worst);
  const { body } = await after([ff('R', box)], 'R');
  check('none sharp: a rounded lump, well under the box', volume(body) < 24000 * 0.75, volume(body));
}
// Only the top's four edges sharp: a flat top with a crisp rim, the bottom still round.
{
  const fine = boxCage([40, 40, 40], 2);
  const z = Math.max(...fine.verts.map(vertex => vertex[2]));
  const rim = cageEdges(fine).filter(([vertexA, q]) => near(fine.verts[vertexA][2], z) && near(fine.verts[q][2], z) && (near(Math.abs(fine.verts[vertexA][0]), 20) || near(Math.abs(fine.verts[vertexA][1]), 20)) && (near(Math.abs(fine.verts[q][0]), 20) || near(Math.abs(fine.verts[q][1]), 20)) && (near(fine.verts[vertexA][0], fine.verts[q][0]) ? near(Math.abs(fine.verts[vertexA][0]), 20) : near(Math.abs(fine.verts[vertexA][1]), 20)));
  const top: Cage = { ...fine, creases: rim };
  check("the top's rim is eight edges", rim.length === 8, rim.length);
  const match = same(top);
  check('quick and full agree (a rim sharp)', match.worst < 1e-5, match.worst);
  const { body: sharp, err } = await after([ff('T', top)], 'T');
  const { body: round } = await after([ff('T0', fine)], 'T0');
  check('a sharp rim: more of the box is kept than with none', !err && volume(sharp) > volume(round) * 1.03, { err, sharp: volume(sharp), round: volume(round) });
  check('... closed and sound', !!sharp && health(sharp).healthy, sharp && health(sharp));
  // The loop through one of its edges is the rim's side it is on... the whole loop of edges through it.
  const loop = edgeLoopOf(top, rim[0][0], rim[0][1], true);
  check('the loop through a rim edge can be followed', !!loop && loop.length >= 2, loop?.length);

  // Tools carry them: a loop added across the rim cuts two of its edges - both halves stay sharp.
  const side = cageEdges(top).find(([vertexA, q]) => near(top.verts[vertexA][0], top.verts[q][0]) && near(top.verts[vertexA][1], top.verts[q][1]) && !near(top.verts[vertexA][2], top.verts[q][2]))!;
  const cut = insertEdgeLoop(top, side[0], side[1]);
  check('a loop round the sides leaves the rim as it was', !!cut && (carryCreases(top, cut!).creases?.length ?? 0) === 8, cut && carryCreases(top, cut).creases?.length);
  const across = insertEdgeLoop(top, rim[0][0], rim[0][1]);
  const carried = across && carryCreases(top, across);
  check('a loop across the rim: its two cut edges are four sharp halves (ten in all)', (carried?.creases?.length ?? 0) === 10, carried?.creases?.length);
  check('... and quick and full still agree', !!carried && same(carried).worst < 1e-5, carried && same(carried).worst);
  // Taken out again: eight.
  const mid = carried!.verts.length - 1;
  const loopEdge = cageEdges(carried!).find(([vertexA, q]) => vertexA >= top.verts.length && q >= top.verts.length)!;
  const back = removeEdgeLoop(carried!, loopEdge[0], loopEdge[1]);
  check("the loop taken out again: the rim's eight", !!back && (back!.creases?.length ?? 0) === 8, { n: back?.creases?.length, mid });
  // Add detail: each sharp edge is two.
  const fine2 = refineCage(top);
  check('Add detail: sixteen sharp edges, the same shape', (fine2.creases?.length ?? 0) === 16, fine2.creases?.length);
  // A face deleted: sharp edges that are still edges stay.
  const less = deleteFaces(top, [0]);
  check('a face deleted: the sharp edges still there are kept', (less.creases?.length ?? 0) >= 6, less.creases?.length);
}
done();
