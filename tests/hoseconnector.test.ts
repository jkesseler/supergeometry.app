// Run: npx tsx tests/hoseconnector.test.ts - a garden hose connector: a hex
// nut (24 across flats, 15 high) pulled up from the floor with Auto (drawn on
// its own, going +: a new body), a blind socket 12 deep cut down into it with
// Auto (going -: a cut), a barbed shank (three barbs) revolved below it and
// joined on, a 4 mm bore down through both with Auto, the socket threaded
// inside (M20 x 2.5: the open top end gets its lead-in, the blind bottom
// doesn't), and the nut's top edges chamfered. Each step held to its volume.
import { measureArea, type Face, type Shape3D } from 'replicad';
import { measureVolume } from '../src/kernel/ocFree';
import { arrangement, regionRef } from '../src/sketch/regions';
import { after, bodies, check, circle, done, health, near, poly, sketch, XY, XZ } from './kit';
import type { FaceRef, Feature, SketchEntity, Vec3 } from '../src/doc/types';

const vol = (s: Shape3D) => Math.abs(measureVolume(s));
const body = (id: string) => bodies().get(id) as Shape3D;
const profileOf = (sk: string, es: SketchEntity[]) => ({ kind: 'profile' as const, sketch: sk, regions: arrangement(es).regions.map(regionRef) });
const ref = (id: string, f: Face): FaceRef => ({ body: id, center: f.center.toTuple() as Vec3, normal: f.normalAt().toTuple() as Vec3, area: measureArea(f) });
const radiusOf = (f: Face) => {
  const p = f.pointOnSurface(0.5, 0.5).toTuple();

  return Math.hypot(p[0], p[1]); 
};
const PI = Math.PI;
const auto = (id: string, sk: string, es: SketchEntity[], distance: number): Feature => ({ id, name: id, type: 'extrude', source: profileOf(sk, es), distance, mode: 'auto', byDirection: true }) as Feature;

const AF = 24, H = 15; // the hex: 24 across flats, 15 high
const R_HEX = AF / Math.sqrt(3); // its corners
const A_HEX = 2 * Math.sqrt(3) * (AF / 2) ** 2;
const RS = 8.75, DS = 12; // the socket: M20's tap drill (17.5), 12 deep (a 3 mm floor)
const RB = 4; // the bore
const P = 2.5; // M20 coarse

// ---------------------------------------------------------------- the nut
const hexEs = [{ id: 'h', kind: 'polygon', center: [0, 0], radius: R_HEX, sides: 6, angle: 0 } as SketchEntity];
const steps: Feature[] = [sketch('Hex', XY(), hexEs), auto('Nut', 'Hex', hexEs, H)];
let { errors } = await after(steps);
check('the nut: Auto going + from the floor makes a new body', !errors.length && bodies().size === 1 && bodies().has('Nut') && near(vol(body('Nut')), A_HEX * H, 1e-6 * A_HEX * H), [errors, [...bodies().keys()], vol(body('Nut')), A_HEX * H]);

// ---------------------------------------------------------------- the socket
// Drawn on a plane at the nut's top (not on its face): Auto going - cuts what it runs into.
const sockEs = [circle('s', 0, 0, RS)];
steps.push(sketch('Socket', XY(H), sockEs), auto('SocketCut', 'Socket', sockEs, -DS));
({ errors } = await after(steps));
const v1 = vol(body('Nut'));
check('the socket: Auto going - cuts it, no new body', !errors.length && bodies().size === 1 && near(A_HEX * H - v1, PI * RS * RS * DS, 1e-6 * v1), [errors, [...bodies().keys()], A_HEX * H - v1, PI * RS * RS * DS]);

// ---------------------------------------------------------------- the shank
// Half its section on the front plane (x out from the axis, z down from the floor):
// a 6.5 shank, three barbs out to 7.5 that lean back towards the nut, the bore left open.
const half: [number, number][] = [[RB, 0], [6.5, 0], [6.5, -6], [7.5, -6], [6.5, -14], [7.5, -14], [6.5, -22], [7.5, -22], [6.5, -30], [RB, -30]];
const ixA = half.reduce((s, [x0, y0], i) => {
  const [x1, y1] = half[(i + 1) % half.length];

  return s + ((x0 * y1 - x1 * y0) * (x0 + x1)) / 6; 
}, 0);
const shankEs = [poly('sh', half)];
steps.push(sketch('Shank', XZ(), shankEs), { id: 'Shank', name: 'Revolve', type: 'revolve', source: profileOf('Shank', shankEs), axis: { origin: [0, 0, 0], dir: [0, 0, 1] }, angle: 360, mode: 'new' } as Feature);
({ errors } = await after(steps));
const vShank = vol(body('Shank'));
check('the shank: its section turned round (Pappus)', !errors.length && bodies().size === 2 && near(vShank, 2 * PI * Math.abs(ixA), 1e-5 * vShank), [errors, vShank, 2 * PI * Math.abs(ixA)]);

steps.push({ id: 'Join', name: 'Union', type: 'boolean', op: 'union', target: 'Nut', tools: ['Shank'] } as Feature);
({ errors } = await after(steps));
const v2 = vol(body('Nut'));
check('joined: one body, the two volumes added', !errors.length && bodies().size === 1 && near(v2, v1 + vShank, 1e-6 * v2), [errors, [...bodies().keys()], v2, v1 + vShank]);

// ---------------------------------------------------------------- the bore
// Down from the socket's floor (a plane at z 3) through the floor and the shank: Auto going - cuts.
const boreEs = [circle('b', 0, 0, RB)];
steps.push(sketch('Bore', XY(H - DS), boreEs), auto('BoreCut', 'Bore', boreEs, -(H - DS) - 30));
({ errors } = await after(steps));
const v3 = vol(body('Nut'));
// (The shank's own bore is open already: only the floor's 3 mm of it is taken.)
check("the bore: through the floor into the shank's", !errors.length && bodies().size === 1 && near(v2 - v3, PI * RB * RB * (H - DS), 1e-6 * v3), [errors, v2 - v3, PI * RB * RB * (H - DS)]);
const hThrough = health(body('Nut'), 'Nut');
check('still sound', hThrough.healthy, hThrough);

// ---------------------------------------------------------------- the thread
const sock = body('Nut').faces.find(f => f.geomType === 'CYLINDRE' && f.center.z > H - DS && near(radiusOf(f), RS, 1e-4));
check("the socket's wall is one round face", !!sock);
steps.push({ id: 'Thread', name: 'Thread', type: 'thread', face: ref('Nut', sock!), pitch: P, round: { r: RS, hole: true } } as Feature);
({ errors } = await after(steps));
const v4 = vol(body('Nut'));
// An inside thread grooves out into the nut: some 60° V, depth about 0.54·P, all the way round.
const d = 0.541 * P;
const groove = d * d * Math.tan(PI / 6) * 2 * PI * (RS + d / 3) * (DS / P);
check("the thread: cut out into the nut, about one groove's worth", !errors.length && bodies().size === 1 && v3 - v4 > groove * 0.5 && v3 - v4 < groove * 1.6, [errors, v3 - v4, groove]);
// (Round the socket only: the barbs' sloped sides are cones too.)
const cones = body('Nut').faces.filter(f => f.geomType === 'CONE' && f.center.z > 0);
const coneZ = cones.map(f => f.center.z);
check('its lead-in at the open top only (not at the blind floor)', cones.length >= 1 && coneZ.every(z => z > H - 3), coneZ);
const hThread = health(body('Nut'), 'Nut');
check('threaded: sound', hThread.healthy, hThread);

// ---------------------------------------------------------------- the chamfer
// The nut's top outer edges (the six of the hexagon) taken off 1.
const topEdges = body('Nut').edges.filter((e) => {
  const m = e.pointAt(0.5).toTuple();

  return near(m[2], H, 1e-6) && Math.hypot(m[0], m[1]) > RS + 2; 
});
check('six top edges of the hexagon', topEdges.length === 6, topEdges.length);
steps.push({ id: 'Bevel', name: 'Chamfer', type: 'chamfer', edges: topEdges.map(e => ({ body: 'Nut', mid: e.pointAt(0.5).toTuple() as Vec3, dir: e.tangentAt(0.5).toTuple() as Vec3, length: e.length })), radius: 1 } as Feature);
({ errors } = await after(steps));
const v5 = vol(body('Nut'));
// Each a 1x1 triangle along a 24/√3 edge, less what the corners share (small): about 6 · ½ · R_HEX.
check('chamfered: about a 1 mm triangle along each edge', !errors.length && v4 - v5 > 6 * 0.5 * R_HEX * 0.8 && v4 - v5 < 6 * 0.5 * R_HEX * 1.05, [errors, v4 - v5, 6 * 0.5 * R_HEX]);
const h = health(body('Nut'), 'Nut');
check('the connector: sound, one body', h.healthy && bodies().size === 1, h.healthy ? `${Math.round(h.volume)} mm³` : h);
const [[x0, , z0], [x1, , z1]] = body('Nut').boundingBox.bounds;
check("the connector: 30 down, 15 up, the hex's corners across", near(z0, -30, 1e-4) && near(z1, H, 1e-4) && near(x1 - x0, 2 * R_HEX, 1e-3), body('Nut').boundingBox.bounds);
console.log('nut', (A_HEX * H).toFixed(1), 'socket', v1.toFixed(1), 'joined', v2.toFixed(1), 'bored', v3.toFixed(1), 'threaded', v4.toFixed(1), 'chamfered', v5.toFixed(1), 'faces', body('Nut').faces.length);
done();
