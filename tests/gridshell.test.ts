// Run: npx tsx tests/gridshell.test.ts
// Shell held to volumes worked out by hand: a block, a cylinder and an L with
// different faces open - and parts where two faces are closer together than
// two walls, so their walls run into each other (a hole near a side, a pocket
// near a side, two holes side by side). Those came out wrong without a word:
// a pocket's walls left out (the pocket a window into the hollow), the tube
// round a hole cut a wall and a half short of the opening, a broken shell
// "repaired" a sixth too light. Where it can't be built, it says so.
import { block, circle, cylinder, done, extrude, poly, rect, sketch, XY } from './kit';
import { build, faceRef, near, say } from './grid';
import type { Feature, SketchEntity } from '../src/doc/types';

const shell = (body: string, faces: any[], thickness: number): Feature => ({ id: 'S', name: 'S', type: 'shell', body, faces, thickness }) as Feature;
const told = (got: Awaited<ReturnType<typeof build>>, body = 'A') => `${got.errors.join(' | ')} ${got.unsound} got ${got.vol[body]?.toFixed(2)}`;
const sound = (got: Awaited<ReturnType<typeof build>>) => !got.errors.length && !got.unsound.length;

// ------------------------------------------------------------ plain shapes
{
  const WIDTH = 40, DEPTH = 30, HEIGHT = 20;
  const featuresA = block('A', WIDTH, DEPTH, HEIGHT);
  for (const t of [0.5, 2, 5, 9, 9.99]) {
    await build(featuresA);
    const top = faceRef('A', normal => normal[2] > 0.99);
    const side = faceRef('A', normal => normal[0] > 0.99);
    const bottom = faceRef('A', normal => normal[2] < -0.99);
    const cases: [string, any[], number][] = [
      ['its top open', [top], WIDTH * DEPTH * HEIGHT - (WIDTH - 2 * t) * (DEPTH - 2 * t) * (HEIGHT - t)],
      ['top and bottom open (a tube)', [top, bottom], WIDTH * DEPTH * HEIGHT - (WIDTH - 2 * t) * (DEPTH - 2 * t) * HEIGHT],
      ['its top and a side open', [top, side], WIDTH * DEPTH * HEIGHT - (WIDTH - t) * (DEPTH - 2 * t) * (HEIGHT - t)],
      ['sealed (no face open)', [], WIDTH * DEPTH * HEIGHT - (WIDTH - 2 * t) * (DEPTH - 2 * t) * (HEIGHT - 2 * t)]
    ];
    for (const [name, faces, volume] of cases) {
      const got = await build([...featuresA, shell('A', faces, t)]);
      say(sound(got) && near(got.vol.A, volume, 2e-4), `a block shelled ${t}, ${name}`, `${told(got)} want ${volume.toFixed(2)}`);
    }
  }
  const featuresC = cylinder('C', 15, 30);
  for (const t of [1, 5, 14]) {
    await build(featuresC);
    const got = await build([...featuresC, shell('C', [faceRef('C', normal => normal[2] > 0.99)], t)]);
    const volume = Math.PI * (225 * 30 - (15 - t) ** 2 * (30 - t));
    say(sound(got) && near(got.vol.C, volume, 3e-4), `a cylinder shelled ${t}, its top open`, `${told(got, 'C')} want ${volume.toFixed(2)}`);
  }
  // An L: the wall is as thick at its inside corner as anywhere (the hollow's corner there is round).
  const sL = sketch('s', XY(), [poly('p', [[0, 0], [40, 0], [40, 15], [15, 15], [15, 40], [0, 40]])]);
  const features = [sL, extrude('L', sL, 10)];
  for (const t of [1, 3, 7]) {
    await build(features);
    const got = await build([...features, shell('L', [faceRef('L', normal => normal[2] > 0.99)], t)]);
    const volume = 9750 - ((15 - 2 * t) * (65 - 2 * t) + (1 - Math.PI / 4) * t * t) * (10 - t);
    say(sound(got) && near(got.vol.L, volume, 3e-4), `an L shelled ${t}, its top open`, `${told(got, 'L')} want ${volume.toFixed(2)}`);
  }
}

// ------------------------------------------------------------ faces closer together than two walls
const blockA = block('A', 40, 30, 20);
const cutIn = (id: string, es: SketchEntity[], depth: number): Feature[] => {
  const feature = sketch(`${id}-s`, XY(20), es);

  return [feature, extrude(id, feature, -depth, 'cut', { target: 'A' })];
};
/** The part of a disc of `radius` beyond a line `distance` from its middle. */
const beyond = (radius: number, distance: number) => (distance >= radius ? 0 : radius * radius * Math.acos(distance / radius) - distance * Math.sqrt(radius * radius - distance * distance));
/** What two discs of `radius`, `distance` apart, cover together. */
const twoDiscs = (radius: number, distance: number) => 2 * Math.PI * radius * radius - (distance >= 2 * radius ? 0 : 2 * radius * radius * Math.acos(distance / (2 * radius)) - (distance / 2) * Math.sqrt(4 * radius * radius - distance * distance));
/** The hollow of the block with its bottom open, before what stands in it is taken out: its footprint and height. */
const room = (t: number) => ({ area: (40 - 2 * t) * (30 - 2 * t), high: 20 - t });

const close: [string, Feature[], (t: number) => number | null][] = [
  // name, the steps, the shell's volume with the bottom open (null: see below)
  [
    'a hole 2 mm from a side',
    cutIn('h', [circle('c', 5, 15, 3)], 20),
    // The tube round the hole (3 + t), less what of it is in the side wall already.
    t => 24000 - 9 * Math.PI * 20 - (room(t).area - (Math.PI * (3 + t) ** 2 - beyond(3 + t, 5 - t))) * room(t).high
  ],
  [
    'a hole half a millimetre from a side',
    cutIn('h', [circle('c', 3.5, 15, 3)], 20),
    t => 24000 - 9 * Math.PI * 20 - (room(t).area - (Math.PI * (3 + t) ** 2 - beyond(3 + t, 3.5 - t))) * room(t).high
  ],
  [
    'two holes 1.5 mm apart',
    [...cutIn('h', [circle('c', 15, 15, 3)], 20), ...cutIn('g', [circle('c', 22.5, 15, 3)], 20)],
    t => 24000 - 18 * Math.PI * 20 - (room(t).area - twoDiscs(3 + t, 7.5)) * room(t).high
  ],
  [
    'a pocket 2 mm from a side',
    cutIn('h', [rect('r', 2, 10, 12, 20)], 8),
    // Half a millimetre: clear of the side, its edges round (worked out by hand). Thicker, its wall
    // and the side's are one, and the hollow's inside corners come out sharp: the pocket grown by t,
    // as far as it is inside the room - x from t to 12 + t, y from 10 - t to 20 + t, z from 12 - t up.
    t => (t < 1 ? 2109.5 : 23200 - (room(t).area * room(t).high - 12 * (10 + 2 * t) * 8))
  ],
  [
    'a hole 1.7 mm from a pocket',
    [...cutIn('h', [circle('c', 20, 15, 5)], 20), ...cutIn('p', [rect('r', 26, 5, 36, 12)], 8)],
    // Half a millimetre: walls round both, clear of each other (worked out by hand). At 1 and 1.5 the
    // hole's tube and the pocket's walls run into each other: the tube (5 + t), the pocket grown by t
    // (corners sharp), less what the two share - the corner of the grown pocket inside the tube, 8 high.
    (t) => {
      if (t === 0.5) {
        return 2368.2;
      }
      if (t > 2) {
        return null;
      }
      const [radius, a, b] = [5 + t, 6 - t, 3 - t];
      const integral = (offset: number) => (offset / 2) * Math.sqrt(radius * radius - offset * offset) + ((radius * radius) / 2) * Math.asin(offset / radius);
      const u1 = Math.sqrt(radius * radius - a * a);
      const shared = u1 > b ? integral(u1) - integral(b) - a * (u1 - b) : 0;
      const hollow = room(t).area * room(t).high - Math.PI * radius * radius * room(t).high - (10 + 2 * t) * (7 + 2 * t) * 8 + shared * 8;

      return 24000 - 25 * Math.PI * 20 - 560 - hollow;
    }
  ]
];
for (const [name, extra, right] of close) {
  const fs = [...blockA, ...extra];
  for (const t of [0.5, 1, 1.5, 2.5]) {
    await build(fs);
    const bottom = faceRef('A', normal => normal[2] < -0.99);
    const got = await build([...fs, shell('A', [bottom], t)]);
    const want = right(t);
    if (name.startsWith('a hole 1.7')) {
      if (t === 0.5) {
        say(sound(got) && near(got.vol.A, 2368.2, 2e-4), `${name}, shelled ${t}: walls round both`, `${told(got)} want 2368.2`);
      }
      // (Between one wall and two apart: the whole part offset inward fails there - it is put together from the hole and the pocket, each grown on its own.)
      else if (t < 2.5) {
        say(sound(got) && near(got.vol.A, want!, 1e-4), `${name}, shelled ${t}: the hole's tube and the pocket's walls run into each other`, `${told(got)} want ${want?.toFixed(2)}`);
      }
      // (At 2.5 the two walls are one lump, and it builds again.)
      else {
        say(sound(got) && near(got.vol.A, 10804, 2e-3), `${name}, shelled ${t}: their walls one lump`, `${told(got)} want about 10804`);
      }
      continue;
    }
    say(sound(got) && want !== null && near(got.vol.A, want, 3e-4), `${name}, shelled ${t}`, `${told(got)} want ${want?.toFixed(1)}`);
  }
}

// More cut-outs closer than two walls, their walls one lump with sharp inside corners (each grown by t,
// what they share counted once): two pockets side by side, and a row of hole, hole, pocket.
{
  const pockets = [...blockA, ...cutIn('p', [rect('r', 5, 5, 15, 25)], 8), ...cutIn('q', [rect('r', 16.5, 5, 26.5, 25)], 8)];
  for (const t of [1, 1.5]) {
    await build(pockets);
    const got = await build([...pockets, shell('A', [faceRef('A', normal => normal[2] < -0.99)], t)]);
    const want = 20800 - (room(t).area * room(t).high - (21.5 + 2 * t) * (20 + 2 * t) * 8);
    say(sound(got) && near(got.vol.A, want, 1e-4), `two pockets 1.5 mm apart, shelled ${t}: one wall between them`, `${told(got)} want ${want.toFixed(2)}`);
  }
  const row = [...blockA, ...cutIn('h', [circle('c', 10, 15, 4)], 20), ...cutIn('g', [circle('c', 19.2, 15, 4)], 20), ...cutIn('p', [rect('r', 24.4, 8, 34, 22)], 8)];
  {
    const t = 1;
    await build(row);
    const got = await build([...row, shell('A', [faceRef('A', normal => normal[2] < -0.99)], t)]);
    // Two tubes of 5 (their middles 9.2 apart), the pocket grown to 11.6 x 16, and the bit of the second tube inside it.
    const tubes = twoDiscs(5, 9.2);
    const hollow = room(t).area * room(t).high - tubes * room(t).high - 11.6 * 16 * 8 + beyond(5, 4.2) * 8;
    const want = 24000 - 2 * Math.PI * 16 * 20 - 9.6 * 14 * 8 - hollow;
    say(sound(got) && near(got.vol.A, want, 1e-4), `a hole 1.2 mm from a hole 1.2 mm from a pocket, shelled ${t}: all three walls one lump`, `${told(got)} want ${want.toFixed(2)}`);
  }
}

// A pocket cut into the face that is opened hangs from that face alone: said, not left loose.
{
  const fs = [...blockA, ...cutIn('h', [rect('r', 15, 10, 25, 20)], 8)];
  await build(fs);
  const top = faceRef('A', (normal, center) => normal[2] > 0.99 && Math.abs(center[2] - 20) < 1e-6);
  const got = await build([...fs, shell('A', [top], 1)]);
  say(/standing loose/.test(got.errors.join()), 'a block with a pocket in its top, the top opened: refused (the pocket would come loose)', told(got));
  await build(fs);
  const bottom = faceRef('A', normal => normal[2] < -0.99);
  const b = await build([...fs, shell('A', [bottom], 1)]);
  // The room, less the pocket grown by 1 with its edges round (as the one-step shell makes them).
  const grown = (12 * 12 - (4 - Math.PI)) * 7 + (100 + 40 * (Math.PI / 4) + (2 / 3) * Math.PI);
  say(sound(b) && near(b.vol.A, 23200 - (38 * 28 * 19 - grown), 3e-4), '...its bottom opened instead: walls round the pocket too', `${told(b)} want ${(23200 - (38 * 28 * 19 - grown)).toFixed(1)}`);
}
done();
