// Sketches put onto a body's faces: Project as Edge (the curves drawn onto the
// faces they land on, the faces split along them) and Wrap & Emboss (a sketch's
// shapes wrapped round a round face, raised from it or sunk into it).

import { cast, draw, getOC, makeCompound, makeLine, makeVertex, type Drawing, type Edge, type Face, type Shape3D } from 'replicad';
import { add, cross, dist, dot, len, norm, scale, sub } from '../geom';
import { cylinderOf } from './faceEdit';
import { measureVolume, quickVolume } from './ocFree';
import type { Vec3 } from '../doc/types';

const tup = (vector: { toTuple(): number[] }) => vector.toTuple() as Vec3;

type Src = { face: Face; normal: Vec3 }[];

/** A body's size: its bounding box's diagonal, and its middle. */
function sizeOf(body: Shape3D): { d: number; c: Vec3 } {
  const bb = body.boundingBox;
  const center = bb.center as unknown as number[];

  return { d: Math.hypot(bb.width, bb.height, bb.depth), c: [center[0], center[1], center[2]] };
}

/**
 * Project as Edge: curves (a sketch's outlines, or edges) drawn onto the body
 * along a direction, the faces split along them. Which of the lines found are
 * kept is `keep`'s to say (those seen from the sketch, those on one face).
 * Nothing else changes: the new edges are there to push, pull, fillet or
 * sketch from.
 */
export function imprint(body: Shape3D, curves: Edge[], dir: Vec3, keep: (e: Edge) => boolean): Shape3D {
  const oc = getOC();
  const { d: diameter, c: mid } = sizeOf(body);
  const normal = norm(dir);
  const kept: Edge[] = [];
  const progress = new oc.Message_ProgressRange();
  const sec = new oc.BRepAlgoAPI_Section();
  try {
    // Each curve swept both ways through the whole body: where those walls cross the body's faces.
    const walls = curves.map((e) => {
      const far = diameter + dist(tup(e.pointAt(0.5)), mid) + 1;
      const vector = new oc.gp_Vec(normal[0] * 2 * far, normal[1] * 2 * far, normal[2] * 2 * far);
      const pr = new oc.BRepPrimAPI_MakePrism(e.clone().translate(scale(normal, -far)).wrapped, vector, false, true);
      try {
        return cast(pr.Shape());
      } finally {
        pr.delete();
        vector.delete();
      }
    });
    sec.Init1(body.wrapped);
    sec.Init2(makeCompound(walls as never).wrapped);
    sec.Build(progress);
    const cut = cast(sec.Shape());
    for (const e of 'edges' in cut ? (cut.edges as Edge[]) : []) {
      if (keep(e)) {
        kept.push(e);
      }
    }
  } finally {
    sec.delete();
    progress.delete();
  }
  if (!kept.length) {
    throw new Error("Nothing lands on the body's faces seen from there");
  }

  return splitFaces(body, kept);
}

/** The lines seen from a sketch's plane (through `origin`, square to `normal`): not on the far side, nor behind other faces. */
export function seenFrom(body: Shape3D, origin: Vec3, normal: Vec3): (e: Edge) => boolean {
  const eps = Math.max(1e-4, sizeOf(body).d * 1e-5);

  return e => seen(e, origin, norm(normal), body, eps);
}

/** The lines on one face. */
export function onFace(body: Shape3D, face: Face): (e: Edge) => boolean {
  const oc = getOC();
  const eps = Math.max(1e-4, sizeOf(body).d * 1e-5);

  return (e) => {
    const ds = new oc.BRepExtrema_DistShapeShape(makeVertex(tup(e.pointAt(0.5))).wrapped, face.wrapped);
    try {
      return ds.IsDone() && ds.Value() < eps;
    } finally {
      ds.delete();
    }
  };
}

/**
 * Whether an edge is seen from the sketch's plane: nothing of the body between
 * them along the normal (a step just off the edge towards the plane is in the
 * open, and so is the way on to the plane).
 */
function seen(e: Edge, origin: Vec3, normal: Vec3, body: Shape3D, eps: number): boolean {
  const oc = getOC();
  const pm = tup(e.pointAt(0.5));
  const height = dot(sub(pm, origin), normal);
  if (Math.abs(height) < 2 * eps) {
    return true;
  }
  const sg = Math.sign(height);
  const q = sub(pm, scale(normal, sg * eps));
  const pp = sub(pm, scale(normal, height - sg * eps));
  const seg = makeLine(q, pp);
  const ds = new oc.BRepExtrema_DistShapeShape(seg.wrapped, body.wrapped);
  try {
    if (!(ds.IsDone() && ds.Value() > eps * 0.05)) {
      return false;
    }
  } finally {
    ds.delete();
  }
  // Run all the way inside the body, it's hidden too: the distance measured is
  // to the faces round it, not 0 (a circle drawn on a block's top went through
  // onto its bottom). Its middle inside, then.
  const mid = makeVertex(scale(add(q, pp), 0.5));
  const at = new oc.BRepExtrema_DistShapeShape();
  try {
    at.LoadS1(body.wrapped);
    at.LoadS2(mid.wrapped);
    at.Perform();

    return !(at.IsDone() && at.InnerSolution());
  } finally {
    at.delete();
    mid.delete();
  }
}

/** The body's faces split along edges lying on them (one solid still). */
function splitFaces(body: Shape3D, edges: Edge[]): Shape3D {
  const oc = getOC();
  const sp = new oc.BRepAlgoAPI_Splitter();
  const args = new oc.NCollection_List_TopoDS_Shape();
  const tools = new oc.NCollection_List_TopoDS_Shape();
  const progress = new oc.Message_ProgressRange();
  try {
    args.Append(body.wrapped);
    tools.Append(makeCompound(edges).wrapped);
    sp.SetArguments(args);
    sp.SetTools(tools);
    sp.Build(progress);
    if (!sp.IsDone()) {
      throw new Error("The faces couldn't be split along the sketch");
    }
    const out = cast(sp.Shape()) as Shape3D;
    const solids = out.constructor.name === 'Solid' ? [out] : ((out as unknown as { solids?: Shape3D[] }).solids ?? []);
    if (solids.length !== 1) {
      throw new Error("The faces couldn't be split along the sketch");
    }

    return solids[0];
  } finally {
    sp.delete();
    args.delete();
    tools.delete();
    progress.delete();
  }
}

/**
 * Wrap & Emboss: the sketch's shapes wrapped round a round face, lengths kept
 * (a line along the sketch goes as far round the face), then raised from it
 * (height > 0) or sunk into it (height < 0) square to the face. The sketch is
 * on a plane along the face's axis (touching it, or anywhere beside it): where
 * the plane is nearest the axis is where the wrap starts from.
 */
export function wrapOnto(body: Shape3D, round: Face, src: Src, height: number): Shape3D {
  if (Math.abs(height) < 1e-6) {
    throw new Error('Height is zero');
  }
  const cy = cylinderOf(round);
  if (!cy) {
    throw new Error('Wrap goes on a round face (a cylinder)');
  }
  const oc = getOC();
  const ad = new oc.BRepAdaptor_Surface(round.wrapped, true);
  const cyl = ad.Cylinder();
  const pos = cyl.Position();
  const Loc: Vec3 = [pos.Location().X(), pos.Location().Y(), pos.Location().Z()];
  const xAxis = norm([pos.XDirection().X(), pos.XDirection().Y(), pos.XDirection().Z()]);
  const zAxis = norm([pos.Direction().X(), pos.Direction().Y(), pos.Direction().Z()]);
  const radius = cyl.Radius();
  ad.delete();
  // The way the face's U goes round (replicad turns a left-handed one round).
  const yAxis = cross(zAxis, xAxis);
  const normal = norm(src[0].normal);
  if (Math.abs(dot(normal, zAxis)) > 1e-6) {
    throw new Error("Draw the sketch on a plane along the round face's axis");
  }
  const origin = tup(src[0].face.center);
  // The plane's nearest point to the axis: where the wrap starts.
  let R0 = sub(origin, Loc);
  R0 = sub(R0, scale(zAxis, dot(R0, zAxis)));
  // (Straight out from the axis to the plane, along its normal: not towards
  // the first shape, or a word centred on a mug's far side came out started
  // from its first letter's place, a quarter of the way round.)
  const side = dot(R0, normal);
  if (Math.abs(side) > 1e-9) {
    R0 = scale(normal, Math.sign(side));
  } else if (len(R0) < 1e-9) {
    R0 = normal;
  }
  R0 = norm(R0);
  const tangent = cross(zAxis, R0);
  const theta0 = (Math.atan2(dot(R0, yAxis), dot(R0, xAxis)) + 2 * Math.PI) % (2 * Math.PI);
  // Seen from outside the face, as it can only be read: a sketch facing in
  // towards the axis (drawn on a plane through the far side, looking out from
  // inside) is turned round, or its letters came out back to front.
  const across = dot(normal, R0) < 0 ? -1 : 1;
  const map = (point: Vec3): [number, number] => [radius * theta0 + across * dot(sub(point, Loc), tangent), dot(sub(point, Loc), zAxis)];

  const solids: Shape3D[] = [];
  for (const { face } of src) {
    const loops = [face.clone().outerWire(), ...face.clone().innerWires()].map(wire => chain(wire.edges as Edge[]));
    const all = loops.flat().flatMap(e => [0, 0.5, 1].map(t => map(e.at(t))[0]));
    const [lo, hi] = [Math.min(...all), Math.max(...all)];
    if (hi - lo > 2 * Math.PI * radius - 1e-6) {
      throw new Error('The sketch is longer than the way round the face');
    }
    const shift = lo < 0 ? 2 * Math.PI * radius : 0;
    const toPlane = (point: Vec3): [number, number] => {
      const q = map(point);

      return [q[0] + shift, q[1]];
    };
    const drawings = loops.map(loop => loopDrawing(loop, toPlane));
    let dr = drawings[0];
    for (const drawing of drawings.slice(1)) {
      dr = dr.cut(drawing);
    }
    const sk = dr.sketchOnFace(round, 'original') as unknown as { faces?: () => Face; face?: () => Face };
    const onFace = sk.faces ? sk.faces() : sk.face!();
    solids.push(thicken(onFace, height, cy));
  }
  let out = body;
  for (const solid of solids) {
    out = (height > 0 ? out.fuse(solid) : out.cut(solid)) as Shape3D;
  }

  return out;
}

type Run = { at: (t: number) => Vec3; kind: string };

/** A wire's edges one after another, each the way the loop goes. */
function chain(edges: Edge[]): Run[] {
  const left = edges.map(e => ({ e, a: tup(e.startPoint), b: tup(e.endPoint) }));
  const out: Run[] = [];
  let end: Vec3 | null = null;
  while (left.length) {
    let i = 0;
    let flip = false;
    if (end) {
      let best = Infinity;
      left.forEach((piece, index) => {
        const [da, db] = [dist(piece.a, end!), dist(piece.b, end!)];
        if (da < best) {
          [best, i, flip] = [da, index, false];
        }
        if (db < best) {
          [best, i, flip] = [db, index, true];
        }
      });
    }
    const { e, a, b } = left.splice(i, 1)[0];
    const at = (t: number) => tup(e.pointAt(flip ? 1 - t : t));
    out.push({ at, kind: e.geomType });
    end = flip ? a : b;
  }

  return out;
}

/** A loop in the unrolled face (lengths round it, heights along it): lines stay lines, circles circles. */
function loopDrawing(loop: Run[], toPlane: (p: Vec3) => [number, number]): Drawing {
  let pen = draw(toPlane(loop[0].at(0)));
  for (const run of loop) {
    const closed = dist(run.at(0), run.at(1)) < 1e-9;
    if (run.kind === 'LINE') {
      pen = pen.lineTo(toPlane(run.at(1)));
    } else if (run.kind === 'CIRCLE') {
      if (closed) {
        pen = pen.threePointsArcTo(toPlane(run.at(0.5)), toPlane(run.at(0.25))).threePointsArcTo(toPlane(run.at(1)), toPlane(run.at(0.75)));
      } else {
        pen = pen.threePointsArcTo(toPlane(run.at(1)), toPlane(run.at(0.5)));
      }
    } else {
      for (let step = 1; step <= 32; step++) {
        pen = pen.lineTo(toPlane(run.at(step / 32)));
      }
    }
  }

  return pen.close();
}

/** A face on the round face made solid: `height` out from it (away from the material) or into it. */
function thicken(face: Face, height: number, cy: { s: number }): Shape3D {
  const oc = getOC();
  // Away from the axis on a boss raised, or a hole sunk; towards it otherwise.
  const want = Math.sign(height) * cy.s;
  const make = (scale: number): Shape3D | null => {
    const th = new oc.BRepOffsetAPI_MakeThickSolid();
    try {
      th.MakeThickSolidBySimple(face.wrapped, scale);
      if (!th.IsDone()) {
        return null;
      }
      let shape = cast(th.Shape()) as Shape3D;
      if (quickVolume(shape) < 0) {
        shape = cast(shape.wrapped.Reversed()) as Shape3D;
      }

      return shape;
    } catch {
      return null;
    } finally {
      th.delete();
    }
  };
  // Made both ways: the one away from the axis is the bigger (it lies further out). (Not
  // told by its centre of mass: a slab bent round an arc has that nearer the axis than it is.)
  const both = [make(Math.abs(height)), make(-Math.abs(height))];
  if (both[0] && both[1]) {
    const [a, b] = both.map(shape => measureVolume(shape!));
    const outer = a > b ? both[0] : both[1];
    const inner = a > b ? both[1] : both[0];

    return want > 0 ? outer! : inner!;
  }
  throw new Error("The wrapped shape couldn't be made solid");
}
