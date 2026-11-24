// Giving memory back to the kernel.
//
// This build of OpenCascade does not let go of most things when they are
// deleted: `delete()` on a shape's handle, an explorer, a boolean, a checker
// marks it deleted on this side and leaves it whole on the other. A deleted
// handle still counted as a user of its shape, so no body the engine ever
// made was freed, and each tool kept all it had worked out: the engine's
// memory only grew - by a megabyte or so with every rebuild of an everyday
// part - until it was replaced with a fresh one (worker.ts), every step built
// again from nothing. (Read off the kernel's memory: five handles to a box
// deleted, the box still had its five users; emptied first, none.)
//
// So each such thing is told to let go just before it is deleted - here, for
// its whole class, which covers the deleting done by replicad as well.

import { BoundingBox, getOC, Solid } from 'replicad';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** The kernels (one at a time: a fresh one after a breakdown) whose classes are done. */
const done = new WeakSet<object>();

/** The last handle to its object, not deleted yet? (A handle can be cloned: the object goes with the last.) */
function last(handle: any): boolean {
  if (handle.isDeleted()) {
    return false;
  }
  const record = handle[Object.getOwnPropertyNames(handle)[0]];

  return !record?.count || record.count.value === 1;
}

/**
 * A shape's box, worked out once. The kernel's exact box of a body with curved faces takes its time (a mug with its
 * handle: 0.95 s; a freeform shoe: 0.7 s) and was worked out again each time it was asked for - by every step that
 * touched the body, several times over, and once more to draw it. Kept by the shape's handle: another shape, or
 * the same one moved, is another handle. (Each asker gets a box of its own: some delete theirs.)
 */
const boxes = new WeakMap<object, [number, number, number, number, number, number]>();
let boxed = false;
function useBoxes(): void {
  if (boxed) {
    return;
  }
  boxed = true;
  let proto: any = Solid.prototype;
  while (proto && !Object.getOwnPropertyDescriptor(proto, 'boundingBox')) {
    proto = Object.getPrototypeOf(proto);
  }
  const exact = proto && Object.getOwnPropertyDescriptor(proto, 'boundingBox')?.get;
  if (!exact) {
    return;
  }
  Object.defineProperty(proto, 'boundingBox', {
    configurable: true,
    get(this: any) {
      const key = this.wrapped as object;
      const had = key && boxes.get(key);
      if (had) {
        return BoundingBox.fromBounds([had[0], had[1], had[2]], [had[3], had[4], had[5]]);
      }
      const box = exact.call(this);
      try {
        // (An empty shape's box is no box: asked again each time, as it was.)
        if (key && !box.wrapped.IsVoid()) {
          const [lo, hi] = box.bounds;
          if ([...lo, ...hi].every(Number.isFinite)) {
            boxes.set(key, [lo[0], lo[1], lo[2], hi[0], hi[1], hi[2]]);
          }
        }
      } catch {
        // As it came.
      }

      return box;
    }
  });
}

export function useReleases(): void {
  useBoxes();
  const oc = getOC() as any;
  if (done.has(oc)) {
    return;
  }
  done.add(oc);
  const nothing = new oc.TopoDS_Shape();
  const ANY = oc.TopAbs_ShapeEnum.TopAbs_SHAPE;
  const before = (name: string, release: (handle: any) => void): void => {
    const proto = oc[name]?.prototype;
    if (!proto || typeof proto.delete !== 'function') {
      return;
    }
    const remove = proto.delete as (this: unknown) => unknown;
    proto.delete = function (this: any) {
      if (last(this)) {
        try {
          release(this);
        } catch {
          // Deleted as it is.
        }
      }

      return remove.call(this);
    };
  };
  // A shape's handle (a face's, an edge's... are its kinds): emptied, it no longer uses the shape.
  before('TopoDS_Shape', h => h.Nullify());
  // An explorer keeps the shape it went through.
  before('TopExp_Explorer', h => h.Init(nothing, ANY, ANY));
  // A boolean keeps all it worked out about where its shapes meet (165 KB for
  // a hole through a block) - cleared - and the bodies it was given and the
  // body it made, which it has no way to be told to drop: it is given a last
  // job instead, one point less another, and holds those two points from then on.
  const [a, b] = [new oc.gp_Pnt(0, 0, 0), new oc.gp_Pnt(1, 0, 0)];
  const speck = (p: unknown) => {
    const list = new oc.NCollection_List_TopoDS_Shape();
    list.Append(new oc.BRepBuilderAPI_MakeVertex(p).Vertex());

    return list;
  };
  const [one, other] = [speck(a), speck(b)];
  const progress = new oc.Message_ProgressRange();
  for (const name of ['BRepAlgoAPI_Cut', 'BRepAlgoAPI_Fuse', 'BRepAlgoAPI_Common', 'BRepAlgoAPI_Section', 'BRepAlgoAPI_Splitter']) {
    before(name, (h) => {
      h.Clear();
      h.SetArguments(one);
      h.SetTools(other);
      h.Build(progress);
      h.Clear();
    });
  }
}
