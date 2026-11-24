// Run: npx tsx tests/ellipsearc.test.ts - a sketch's ellipse can be a part of
// an ellipse (a0, sweep): two ends like any open curve. A shape bounded by one
// extrudes to the volume it should; moved, mirrored and offset it stays the
// part it was.
import { pointsOf } from '../src/sketch/constraints';
import { offsetEntity } from '../src/sketch/edit';
import { arrangement } from '../src/sketch/regions';
import { check, done, near, sketch, line, XY, extrude, after, volume } from './kit';
import type { Feature, SketchEntity } from '../src/doc/types';

// A quarter of an ellipse 20 by 10, closed by two lines to its middle.
const arc = { id: 'q', kind: 'ellipse', center: [0, 0], rx: 20, ry: 10, rotation: 0, a0: 0, sweep: Math.PI / 2 } as SketchEntity;
const es = [arc, line('l1', [0, 0], [20, 0]), line('l2', [0, 10], [0, 0])];
const ends = pointsOf(arc);
check('its two ends and its middle are its points', ends.length === 3 && near(ends[0].at[0], 20) && near(ends[0].at[1], 0) && near(ends[1].at[0], 0) && near(ends[1].at[1], 10), ends);
const regions = arrangement(es).regions;
check('with the two lines it closes one shape', regions.length === 1, regions.length);
const s = sketch('s', XY(), es);
const fs: Feature[] = [s, extrude('E', s, 5)];
const { body, err } = await after(fs, 'E');
const want = (Math.PI * 20 * 10 * 5) / 4;
check("extruded 5: a quarter of the ellipse's area times 5", !err && near(volume(body), want, want * 2e-4), { err, got: volume(body), want });

// The whole ellipse still a whole one.
const whole = { id: 'w', kind: 'ellipse', center: [50, 0], rx: 8, ry: 4, rotation: 0.3 } as SketchEntity;
check('a whole ellipse: only its middle is a point', pointsOf(whole).length === 1);
const s2 = sketch('s2', XY(), [whole]);
const r2 = await after([s2, extrude('E2', s2, 2)], 'E2');
check('... and extrudes as before', !r2.err && near(volume(r2.body), Math.PI * 8 * 4 * 2, 0.05), volume(r2.body));

// Offset: the same part, 2 bigger.
const off = offsetEntity(arc, 2);
check('offset by 2: the same quarter of an ellipse 22 by 12', off?.kind === 'ellipse' && near(off.rx, 22) && near(off.ry, 12) && near(off.sweep ?? 0, Math.PI / 2), off);
// A sketch that follows a round edge seen at a slant: the curve is part of an ellipse with two ends, and stays
// that when the body changes. (A half disc 20 round, 10 thick; a sketch on a plane tipped 60 degrees about x.)
{
  const { regenerate } = await import('../src/kernel/engine');
  const half = (r: number): Feature[] => {
    const hs = [{ id: 'a', kind: 'arc', a: [r, 0], m: [0, r], b: [-r, 0] }, line('c', [-r, 0], [r, 0])] as SketchEntity[];
    const sk = sketch('hs', XY(), hs);

    return [sk, extrude('H', sk, 10)];
  };
  const edgeOf = (r: any) => {
    const e = r.bodies.find((b: any) => b.id === 'H').edges.find((x: any) => x.type === 'CIRCLE' && Math.abs(x.mid[2] - 10) < 0.01);

    return e && { body: 'H', mid: e.mid, dir: e.dir, length: e.length, steps: e.steps, curves: e.curves };
  };
  let r: any = await regenerate(half(20));
  const rim = edgeOf(r);
  check('the half disc has a round edge on top', !!rim, r.errors);
  const tipped = { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, -Math.sin(Math.PI / 3), Math.cos(Math.PI / 3)] } as any;
  const follow = (): Feature => ({ id: 'f', name: 'f', type: 'sketch', plane: tipped, entities: [{ id: 'ref-rim', kind: 'line', a: [0, 0], b: [1, 0] }], links: [{ id: 'ref-rim', edge: rim }] }) as any;
  r = await regenerate([...half(20), follow()]);
  const e = r.sketchEntities?.f?.find((x: any) => x.id === 'ref-rim');
  check('followed from a tipped plane: half an ellipse 20 by 10', e?.kind === 'ellipse' && near(Math.max(e.rx, e.ry), 20, 1e-5) && near(Math.min(e.rx, e.ry), 10, 1e-5) && near(Math.abs(e.sweep), Math.PI, 1e-5), e);
  const p0 = e ? pointsOf(e) : [];
  check('... its ends where the edge ends', p0.length === 3 && near(Math.abs(p0[0].at[0]), 20, 1e-5) && near(Math.abs(p0[1].at[0]), 20, 1e-5) && near(p0[0].at[0] + p0[1].at[0], 0, 1e-5), p0);
  r = await regenerate([...half(30), { ...follow(), entities: [e] } as any]);
  const e2 = r.sketchEntities?.f?.find((x: any) => x.id === 'ref-rim');
  check('the disc made 30 round: half an ellipse 30 by 15, from the same end', e2?.kind === 'ellipse' && near(Math.max(e2.rx, e2.ry), 30, 1e-5) && near(Math.min(e2.rx, e2.ry), 15, 1e-5) && Math.sign(pointsOf(e2)[0].at[0]) === Math.sign(p0[0].at[0]), e2);
}
done();
