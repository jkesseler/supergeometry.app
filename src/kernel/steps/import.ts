import { assembleWire, cast, getOC, importSTEP, makeCompound, makeLine, makePolygon, revolution } from 'replicad';
import { isFault } from '../faults';
import { MESH_MAX, TooBig } from '../protocol';
import { isEmpty } from '../bodies';
import { openEdges, shapeValid, subShapes } from '../health';
import { sizeOf, unify } from '../faceEdit';
import { measureVolume } from '../ocFree';
import { insideOf, volumeOf, volumes } from '../booleans';
import { meshFlatFaces, meshModel, meshParts, stlTriangles } from '../meshRound';
import { add, cross, len, norm, scale, sub } from '../../geom';
import { withoutInternals } from '../safeBooleans';
import type { Shape3D } from 'replicad';
import type { ImportFeature, Vec3 } from '../../doc/types';
import type { Ctx } from '../types';
import type { MeshCylinder, MeshFace, MeshModel, MeshStandIn } from '../meshRound';

export const importCache = new Map<string, Shape3D>();

export async function applyImport(feature: ImportFeature, ctx: Ctx) {
  const { bodies } = ctx;
  const rounding = feature.format === 'stl' && !!feature.round;
  const cacheKey = rounding ? `round:${feature.data}` : feature.data;
  let shape = importCache.get(cacheKey);
  if (!shape) {
    const bytes = Uint8Array.from(atob(feature.data), char => char.charCodeAt(0));
    const blob = new Blob([bytes]);
    try {
      // (A mesh asked to be made into faces: its flat faces built whole here, whichever way they face; where
      // that cannot be done, the kernel's own reading of the file.)
      const whole = rounding ? meshBodyOf(bytes) : null;
      shape = whole?.shape ?? ((feature.format === 'step' ? await importSTEP(blob) : readSTL(bytes)) as Shape3D);
    } catch (err) {
      // (The engine itself breaking down is for whoever runs it - it was
      // taken for a file that couldn't be read, and the broken engine kept.
      // A mesh too big says so in its own words.)
      if (isFault(err) || err instanceof TooBig) {
        throw err;
      }
      // (OpenCascade's own words were "This shape has not type, it is null".)
      throw new Error(feature.format === 'step' ? "This STEP file couldn't be read - it may be damaged" : "This STL file couldn't be read");
    }
    if (isEmpty(shape)) {
      throw new Error('The file contains no solid geometry');
    }
    importCache.set(cacheKey, shape);
  }
  // A file of several solids (an assembly; this app's own STEP of two bodies): each a body of its own, to pick,
  // hide, move and cut by itself. (They came in as one body of several pieces: the two bodies of a project
  // saved as STEP and opened again were one, that nothing could take apart.)
  const solids = feature.apart && (feature.format === 'step' || rounding) ? subShapes(shape, 'SOLID') : [];
  if (solids.length > 1) {
    solids.forEach((solid, i) => bodies.set(i ? `${feature.id}:${i}` : feature.id, cast(solid) as Shape3D));

    return;
  }
  bodies.set(feature.id, shape);
}

/**
 * An STL file as a body. OpenCascade's reader hands back the triangles loose
 * (a pile of faces, no two sharing an edge - replicad's importSTL wanted a
 * shell and threw on every file, the app's own STL exports too). Sewn here:
 * one closed skin is a solid, its flat triangles merged; anything else (open,
 * several lumps) stays loose faces for Repair to close. (The reader used to
 * hand back a shell, and this looked for one: with none to find, every STL
 * came in as loose faces - a block of 12 triangles too - and nothing could be
 * joined to it or cut from it until it was Repaired.)
 */
function readSTL(bytes: Uint8Array): Shape3D {
  const oc = getOC();
  // A binary file is known by its length: 84 bytes and 50 for each triangle
  // it says it has (one with too many isn't read at all). OpenCascade's reader
  // goes by its first 134 bytes instead - binary if one of them is no letter
  // of plain text - and took for text a file with a blank or plain heading
  // whose first triangle's numbers were all such bytes (round sizes and no
  // normal: a 10 mm cube out of a 3MF) - "couldn't be read". Its heading,
  // which nothing reads, is given such a byte.
  let file = bytes;
  if (bytes.length >= 134) {
    const said = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(80, true);
    if (84 + said * 50 === bytes.length) {
      if (said > MESH_MAX) {
        throw new TooBig(said);
      }
      file = bytes.slice();
      file[79] = 0xff;
    }
  }
  const name = `stl-${Math.random().toString(36).slice(2)}.stl`;
  oc.FS.writeFile(`/${name}`, file);
  const reader = new oc.StlAPI_Reader();
  const read = new oc.TopoDS_Shell();
  try {
    if (!reader.Read(read, name)) {
      throw new Error("This STL file couldn't be read");
    }
    const loose = cast(read) as Shape3D;
    // (Counted straight off the shape: replicad's iterTopo checks each one against
    // all before it - 6 of the 10 s ten thousand triangles took to come in.)
    let count = 0;
    const each = new oc.TopExp_Explorer(read, oc.TopAbs_ShapeEnum.TopAbs_FACE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
    for (; each.More(); each.Next()) {
      count++;
    }
    each.delete();
    if (count > MESH_MAX) {
      throw new TooBig(count);
    }
    if (count) {
      const size = sizeOf(loose);
      const sew = new oc.BRepBuilderAPI_Sewing(Math.max(1e-7, size * 1e-7), true, true, true, false);
      const progress = new oc.Message_ProgressRange();
      try {
        sew.Add(read);
        sew.Perform(progress);
        const shells = subShapes(cast(sew.SewedShape()) as Shape3D, 'SHELL');
        if (shells.length === 1 && sew.NbFreeEdges() === 0) {
          const mk = new oc.BRepBuilderAPI_MakeSolid();
          mk.Add(shells[0]);
          const made = cast(mk.Solid()) as Shape3D;
          mk.delete();
          // Flat triangles made one face each, as Repair leaves them. A file's
          // numbers are to seven digits, so a corner can be a hair off the
          // plane of the face it now belongs to, which the check calls damage
          // (a faceted ball came in "invalid"): its edges are given that room,
          // as Repair's first step does - or the triangles are kept as they are.
          let solid = unify(made, size);
          if (solid !== made && !shapeValid(solid)) {
            try {
              oc.BRepLib.BuildCurves3d(solid.wrapped);
              oc.BRepLib.SameParameter(solid.wrapped, size * 1e-7, true);
              oc.BRepLib.UpdateTolerances(solid.wrapped, true);
            } catch (err) {
              if (isFault(err)) {
                throw err;
              }
            }
            // (Looked at afresh: what a shape was found to be is remembered.)
            solid = cast(solid.wrapped) as Shape3D;
            if (!shapeValid(solid)) {
              solid = made;
            }
          }
          let volume = measureVolume(solid);
          if (volume < 0) {
            oc.BRepLib.OrientClosedSolid(solid.wrapped);
            volume = measureVolume(solid);
          }
          if (volume > 0 && !openEdges(solid).length) {
            // (Measured once: a body of a hundred thousand faces takes seconds to.)
            volumes.set(solid, volume);

            return solid;
          }
        }
      } catch (err) {
        if (isFault(err)) {
          throw err;
        }
        // fall through: loose faces
      } finally {
        sew.delete();
        progress.delete();
      }
    }

    return loose;
  } finally {
    oc.FS.unlink(`/${name}`);
    reader.delete();
    read.delete();
  }
}

/**
 * A mesh file as a body: its flat faces each one face, whichever way they face, and its round parts truly round
 * (see meshRound.ts). Null when the mesh cannot be read that way (open, tangled, nothing flat in it) - it then
 * comes in as the kernel reads it.
 */
function meshBodyOf(bytes: Uint8Array): { shape: Shape3D; made: number } | null {
  const all = stlTriangles(bytes);
  if (!all) {
    return null;
  }
  if (all.length / 9 > MESH_MAX) {
    throw new TooBig(all.length / 9);
  }
  // A file of several separate parts (a box and its lid): each read by itself, and together again as its solids -
  // a body each (see "import"). A part inside another (a hollow's inner skin) is not a part of its own: the old way.
  const parts = meshParts(all);
  if (!parts) {
    return null;
  }
  // Read first, all of it, which is quick; built only if it is worth building.
  const models = parts.map(part => meshModel(part));
  if (models.some(model => !model)) {
    return null;
  }
  // (A mesh with little flat in it - a figure, a scan, a bowl whose curves are cut into four-sided flats, two
  // triangles each: nearly a face a triangle, or a face to two. Building that face by face took as long again as
  // the kernel's own reader, for nothing - 11 s more on a bowl of 62,000 triangles, in one part or in four. Counted
  // after the round parts' strips are taken out, so a part that is mostly holes and bosses is not taken for one.)
  const count = all.length / 9;
  if (count > 5000 && models.reduce((total, model) => total + model!.faces.length, 0) > count * 0.4) {
    return null;
  }
  const made = parts.map((part, i) => meshPartBody(part, models[i]!));
  if (made.some(body => !body)) {
    return null;
  }
  if (made.length === 1) {
    return made[0];
  }

  return { shape: makeCompound(made.map(body => body!.shape.clone())) as unknown as Shape3D, made: made.reduce((total, body) => total + body!.made, 0) };
}

/** One part of a mesh, read (see meshModel), as a body: round parts stood in for and made round with a ring each. */
function meshPartBody(tris: Float64Array, model: MeshModel): { shape: Shape3D; made: number } | null {
  // Should any of the quick way not come out sound, the plain way: every strip a face, the round parts made round
  // one after another.
  const quick = model.rounds.length ? facesSolid(model.faces) : null;
  const rounded = quick && ringsOn(quick, model.rounds);
  if (rounded) {
    const more = model.rest.length ? roundMeshSolid(rounded, model.rest) : { shape: rounded, made: 0 };

    return { shape: more.shape, made: model.rounds.length + more.made };
  }
  const flat = model.rounds.length ? meshFlatFaces(tris) : model.faces;
  const plain = flat && facesSolid(flat);
  if (!plain) {
    return null;
  }
  const cyls = [...model.rounds.map(round => round.cy), ...model.rest];

  return cyls.length ? roundMeshSolid(plain, cyls) : { shape: plain, made: 0 };
}

/** Flat faces, each given by its outline and holes, sewn into one closed skin: a solid - or null if they do not close into one sound solid. */
function facesSolid(faces: MeshFace[]): Shape3D | null {
  const oc = getOC();
  const lo: Vec3 = [Infinity, Infinity, Infinity];
  const hi: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const face of faces) {
    for (const point of face.outer) {
      for (let axis = 0; axis < 3; axis++) {
        (lo[axis] = Math.min(lo[axis], point[axis])), (hi[axis] = Math.max(hi[axis], point[axis]));
      }
    }
  }
  const size = len(sub(hi, lo)) || 1;
  const sew = new oc.BRepBuilderAPI_Sewing(Math.max(1e-7, size * 1e-7), true, true, true, false);
  const progress = new oc.Message_ProgressRange();
  try {
    const wire = (ring: Vec3[]) => assembleWire(ring.map((point, i) => makeLine(point, ring[(i + 1) % ring.length])));
    for (const face of faces) {
      // (On its own plane, said outright: found again from the outline, a face with holes was "not flat".)
      const pln = new oc.gp_Pln(new oc.gp_Pnt(...face.outer[0]), new oc.gp_Dir(...face.n));
      const mk = new oc.BRepBuilderAPI_MakeFace(pln, wire(face.outer).wrapped, true);
      for (const hole of face.holes) {
        mk.Add(wire(hole).wrapped);
      }
      if (!mk.IsDone()) {
        return null;
      }
      sew.Add(mk.Face());
    }
    sew.Perform(progress);
    const shells = subShapes(cast(sew.SewedShape()) as Shape3D, 'SHELL');
    if (shells.length !== 1 || sew.NbFreeEdges() !== 0) {
      return null;
    }
    const mk = new oc.BRepBuilderAPI_MakeSolid();
    mk.Add(shells[0]);
    let solid = cast(mk.Solid()) as Shape3D;
    mk.delete();
    if (measureVolume(solid) < 0) {
      oc.BRepLib.OrientClosedSolid(solid.wrapped);
    }
    // (Straight edges cut where a neighbour's corner met them: each one edge again.)
    const tidy = unify(solid, size);
    if (shapeValid(tidy)) {
      solid = tidy;
    }
    const volume = measureVolume(solid);
    if (!(volume > 0) || openEdges(solid).length || !shapeValid(solid)) {
      return null;
    }
    volumes.set(solid, volume);

    return solid;
  } catch (err) {
    if (isFault(err)) {
      throw err;
    }

    return null;
  } finally {
    sew.delete();
    progress.delete();
  }
}

/**
 * The round parts of a mesh body that were stood in for (meshModel) made round: a ring from inside each stand-in
 * out to its true radius, cut from the body round a hole, joined to it round a boss - all the holes at once, all
 * the bosses at once. Null unless the body is then one sound solid whose volume changed by what lay between the
 * stand-ins and the round faces.
 */
function ringsOn(solid: Shape3D, rounds: MeshStandIn[]): Shape3D | null {
  const size = sizeOf(solid);
  let spare = 0;
  try {
    const tools = rounds.map((round) => {
      const cy = round.cy;
      const perpendicular = norm(cross(cy.a, cy.u));
      const at = (radius: number, ang: number, t: number): Vec3 => add(add(cy.c, scale(cy.a, t)), add(scale(cy.u, radius * Math.cos(ang)), scale(perpendicular, radius * Math.sin(ang))));
      // An end with nothing past it: a cut goes a hair past it. An end with the body past it: a join goes a hair in.
      const hair = Math.max(2e-3, (cy.r - round.inner) * 0.25);
      const rp = round.inner + (cy.r - round.inner) * 0.25;
      const angs = [0.25, 0.5, 0.75].map(fraction => cy.sweep * fraction);
      const ends: [number, number] = [...round.ends];
      [round.ends[0] - hair * 0.5, round.ends[1] + hair * 0.5].forEach((t, e) => {
        const inside = insideOf(solid, angs.map(ang => at(rp, ang, t)));
        if (!inside.every(x => x === !cy.concave)) {
          return;
        }
        ends[e] += e ? hair : -hair;
        // (The most that hair can take or add past the end, where the end is not as clean as a plate's face.)
        spare += ((cy.r * cy.r - round.inner * round.inner) * cy.sweep * hair) / 2;
      });
      const outline = makePolygon([at(round.inner, 0, ends[0]), at(cy.r, 0, ends[0]), at(cy.r, 0, ends[1]), at(round.inner, 0, ends[1])]);

      return revolution(outline, cy.c, cy.a, Math.min(360, (cy.sweep * 180) / Math.PI)) as Shape3D;
    });
    const holes = tools.filter((_, i) => rounds[i].cy.concave);
    const bosses = tools.filter((_, i) => !rounds[i].cy.concave);
    let out = solid;
    if (holes.length) {
      out = booleanWith('cut', out, holes, size);
    }
    if (bosses.length) {
      out = booleanWith('fuse', out, bosses, size);
    }
    const expect = rounds.reduce((sum, round) => sum + (round.cy.concave ? -round.volume : round.volume), 0);
    const most = rounds.reduce((sum, round) => sum + round.volume, 0);
    const change = measureVolume(out) - volumeOf(solid);
    if (Math.abs(change - expect) > Math.max(most * 0.01, size ** 3 * 1e-10) + spare) {
      return null;
    }
    if (subShapes(out, 'SOLID').length !== 1 || openEdges(out).length || !shapeValid(out)) {
      return null;
    }

    return out;
  } catch (err) {
    if (isFault(err)) {
      throw err;
    }

    return null;
  }
}

/**
 * A mesh's cylinders made truly round (see meshRound.ts for how they are found).
 *
 * The flat strips lie just inside their cylinder, touching it at the creases - a hair's breadth from it where the
 * mesh is cut fine (a 4 mm hole in 252 strips: 0.00015 mm), which is nothing the kernel can cut along. So the
 * strips are first buried or cut away with room to spare, then the round face is made in clean material:
 *  - a hole: a ring that covers its wall, a little either side, is joined on (the hole is now too small, its strips
 *    inside the body), then a ring from inside that out to the true radius is cut away;
 *  - a boss: the same ring is cut away (the boss is now too thin), then one out to the true radius joined on.
 * Rings, not whole cylinders: a boss with a bore keeps its bore, a post standing in a hole stays. A ring ends
 * exactly where its strips end, or a hair past that where it does no harm (a cut into the open, a join into the body).
 *
 * All of them in three passes; checked: the body is still one sound solid, and its volume changed by what lay
 * between the strips and the round faces, no more. If not, one at a time, each checked, those that fail left as
 * strips. Returns how many were made round.
 */
const SLOW_ROUNDS_AT_ONCE = 24;
/**
 * How many round parts are tried one at a time the slow way: each try is two or three cuts of the whole body, and
 * that takes as long as the body has faces - two seconds on one of two thousand. Eight on a small body, none
 * on one of over 1500 faces. (By the body's size, not by the clock: the same file gives the same faces on a phone as on a desktop.)
 */
const slowRounds = (faces: number) => Math.min(8, Math.floor(1500 / Math.max(1, faces)));
export function roundMeshSolid(solid: Shape3D, cyls: MeshCylinder[]): { shape: Shape3D; made: number } {
  const size = sizeOf(solid);
  interface Job {
    cy: MeshCylinder;
    /** The most a ring's hair past an end can take or add there (a round that ends on a cone's flats: a little of them). */
    spare: number;
    /** The ring that buries (a hole) or removes (a boss) the strips, and the one that makes the round face. */
    rough: () => Shape3D;
    fine: () => Shape3D;
  }
  const jobs: Job[] = [];
  // Which to try: all of them where they are few enough to do at once; else the biggest few, by how big the body
  // is (see slowRounds) - chosen before anything is asked of the kernel about them (it was asked what lies past
  // each end of a hundred and fifty rounds, of which it then tried one).
  // (Strips that end at different heights - on a slope, at another feature - are not tried: a ring their whole
  // length would add or take where there is nothing of them.)
  // (A body too big for even one try: none - at once is a try like any other.)
  if (!slowRounds(solid.faces.length)) {
    return { shape: solid, made: 0 };
  }
  const even = cyls.filter(cy => cy.even);
  const worth = (cy: MeshCylinder) => (cy.sweep > 2 * Math.PI - 1e-9 ? 1e6 : 1) * cy.r * cy.sweep * (cy.t1 - cy.t0);
  const atOnce = even.length <= SLOW_ROUNDS_AT_ONCE;
  const chosen = atOnce ? even : [...even].sort((x, y) => worth(y) - worth(x)).slice(0, slowRounds(solid.faces.length));
  for (const cy of chosen) {
    const half = cy.step / 2;
    const sag = cy.r * (1 - Math.cos(half));
    const room = Math.max(sag * 4, size * 2e-4);
    const inner = cy.r * Math.cos(half) - room;
    if (!(inner > 0) || !(sag > 0)) {
      continue;
    }
    const perpendicular = norm(cross(cy.a, cy.u));
    const at = (radius: number, ang: number, t: number): Vec3 => add(add(cy.c, scale(cy.a, t)), add(scale(cy.u, radius * Math.cos(ang)), scale(perpendicular, radius * Math.sin(ang))));
    // What is past each end, just inside the strips: the body, or nothing.
    const hair = Math.max(2e-3, sag);
    const rp = cy.r * Math.cos(half) - sag * 0.25;
    const angs = [0.25, 0.5, 0.75].map(fraction => cy.sweep * fraction);
    const past = [cy.t0 - hair * 0.5, cy.t1 + hair * 0.5].map(t => insideOf(solid, angs.map(ang => at(rp, ang, t))));
    const open = past.map(samples => samples.every(x => !x));
    const filled = past.map(samples => samples.every(x => x));
    const ring = (r0: number, r1: number, ends: [number, number]): Shape3D => {
      const outline = makePolygon([at(r0, 0, ends[0]), at(r1, 0, ends[0]), at(r1, 0, ends[1]), at(r0, 0, ends[1])]);

      return revolution(outline, cy.c, cy.a, Math.min(360, (cy.sweep * 180) / Math.PI)) as Shape3D;
    };
    const exact: [number, number] = [cy.t0, cy.t1];
    const intoOpen: [number, number] = [cy.t0 - (open[0] ? hair : 0), cy.t1 + (open[1] ? hair : 0)];
    const intoBody: [number, number] = [cy.t0 - (filled[0] ? hair : 0), cy.t1 + (filled[1] ? hair : 0)];
    const within = Math.max(0, inner - room);
    const spare = (((cy.r * cy.r - within * within) * cy.sweep * hair) / 2) * (cy.concave ? open : filled).filter(Boolean).length;
    jobs.push(
      cy.concave
        ? { cy, spare, rough: () => ring(inner, cy.r + room, exact), fine: () => ring(within, cy.r, intoOpen) }
        : { cy, spare, rough: () => ring(inner, cy.r + room, intoOpen), fine: () => ring(within, cy.r, intoBody) }
    );
  }
  const apply = (body: Shape3D, list: Job[]): Shape3D | null => {
    try {
      const holes = list.filter(j => j.cy.concave);
      const bosses = list.filter(j => !j.cy.concave);
      let out = body;
      if (holes.length) {
        out = booleanWith('fuse', out, holes.map(j => j.rough()), size);
      }
      out = booleanWith('cut', out, [...holes.map(j => j.fine()), ...bosses.map(j => j.rough())], size);
      if (bosses.length) {
        out = booleanWith('fuse', out, bosses.map(j => j.fine()), size);
      }
      const expect = list.reduce((total, j) => total + (j.cy.concave ? -j.cy.sliver : j.cy.sliver), 0);
      const most = list.reduce((total, j) => total + j.cy.sliver, 0);
      const change = measureVolume(out) - volumeOf(body);
      // (By what lay between the strips and the round faces - and no more than the hairs past the ends besides:
      // taken at holes, added at bosses.)
      const slack = Math.max(most * 0.03, size ** 3 * 1e-10);
      const took = holes.reduce((total, j) => total + j.spare, 0);
      const gave = bosses.reduce((total, j) => total + j.spare, 0);
      if (change - expect > slack + gave || expect - change > slack + took) {
        return null;
      }
      if (subShapes(out, 'SOLID').length !== 1 || openEdges(out).length || !shapeValid(out)) {
        return null;
      }

      return out;
    } catch (err) {
      if (isFault(err)) {
        throw err;
      }

      return null;
    }
  };
  if (!jobs.length) {
    return { shape: solid, made: 0 };
  }
  // All at once where there are few enough for that to be likely; else, and if that fails, one at a time - the
  // biggest first, and no more than a handful: each try is two or three cuts of the whole body, and a part with
  // lettering has a hundred and fifty rounds a fifth of a millimetre across (a guitar pick: 18 s, for 3 made).
  // (By count, not by the clock: the same file gives the same faces on a phone as on a desktop.)
  const all = atOnce ? apply(solid, jobs) : null;
  if (all) {
    return { shape: all, made: jobs.length };
  }
  jobs.sort((x, y) => worth(y.cy) - worth(x.cy));
  let body = solid;
  let made = 0;
  for (const job of jobs.slice(0, slowRounds(solid.faces.length))) {
    const next = apply(body, [job]);
    if (next) {
      (body = next), made++;
    }
  }

  return { shape: body, made };
}

/** A join or cut of a body with several tools at once (that do not overlap each other), faces on one surface merged. */
function booleanWith(op: 'cut' | 'fuse', a: Shape3D, list: Shape3D[], size: number): Shape3D {
  const oc = getOC();
  const algo = op === 'cut' ? new oc.BRepAlgoAPI_Cut() : new oc.BRepAlgoAPI_Fuse();
  const args = new oc.NCollection_List_TopoDS_Shape();
  const tools = new oc.NCollection_List_TopoDS_Shape();
  const progress = new oc.Message_ProgressRange();
  try {
    args.Append(a.wrapped);
    for (const b of list) {
      tools.Append(b.wrapped);
    }
    algo.SetArguments(args);
    algo.SetTools(tools);
    algo.SetFuzzyValue(Math.max(1e-7, size * 1e-6));
    algo.SetNonDestructive(true);
    algo.Build(progress);
    if (!algo.IsDone()) {
      throw new Error('boolean failed');
    }
    const made = algo.Shape();
    try {
      return unify(cast(withoutInternals(made)) as Shape3D, size);
    } finally {
      made.delete();
    }
  } finally {
    algo.delete();
    args.delete();
    tools.delete();
    progress.delete();
  }
}
