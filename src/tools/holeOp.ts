// Hole: a screw's hole in a flat face, by the screw's size.
//
// Asked for after the app was posted ("drop in pre-defined, common 3D features, similarly to ... a hole designer ...
// holes and bores for a pre-defined screw size"). A hole for an M3 screw was a sketch, a circle, knowing that 3.4 is
// the size that lets it through, a cut - and a second circle for the head. Here: tap the face where the screw goes,
// choose the screw and the head. Every size it fills in can be typed over.
//
// Where it is: the tap, moved by its dot. It catches on the middle of the face and on the centre of a round edge
// (a boss's rim), and stays there when the model changes; anywhere else it is held from the two nearest straight
// edges, by the two sizes shown - typed over, they place it exactly, and it keeps them when the face is resized.

import { distanceFrom, headFor, holeFor, holeFromLines, screwSize, SCREW_SIZES, sideOf, sinkDepth } from '../doc/holeSizes';
import { add, cross, dist, dot, len, niceStep, norm, scale, sub } from '../geom';
import { fmtLen } from '../units';
import { DimWidget } from './annotate';
import { FeatureOp } from './featureOp';
import { Handle } from './handles';
import { faceIndexOf, type AppContext } from './tool';
import type { ToolPointer } from '../view/input';
import type { PanelItem } from '../ui/ui';
import type { EdgeRef, FaceRef, HoleFeature, Vec3 } from '../doc/types';

type Head = HoleFeature['head'];
const HEADS: { id: Head; label: string }[] = [
  { id: 'none', label: 'None' },
  { id: 'counterbore', label: 'Counterbore' },
  { id: 'countersink', label: 'Countersink' }
];

/** The hole made last: the next one starts as the same screw, head and depth (four of them are one choice, not four). */
let lastHole: Pick<HoleFeature, 'size' | 'diameter' | 'head' | 'headDiameter' | 'headDepth' | 'through' | 'depth'> | null = null;

interface Line {
  a: Vec3;
  b: Vec3;
  ref: EdgeRef;
}
interface Round {
  c: Vec3;
  ref: EdgeRef;
}

export class HoleOp extends FeatureOp<HoleFeature> {
  readonly id = 'hole';

  /** The face's plane: a point of it, and the way out of the body. */
  private on: Vec3;
  private out: Vec3;
  private middle: Vec3;
  /** What it can catch on and be held from: the round and straight edges lying in the face's plane. */
  private rounds: Round[] = [];
  private lines: Line[] = [];
  /** The two edges its sizes are measured from (shown also when it sits on a centre: typed over, they take it off). */
  private edges2: [Line, Line] | null = null;

  /**
   * Where the hole really is, read off the model once it is made: on a centre or the middle of the face the engine
   * says where that is (the middle of a face with a boss on it is not where its picture balances).
   */
  private actual: Vec3 | null = null;

  private get at(): Vec3 {
    return this.actual ?? this.feature.at;
  }

  refresh(): void {
    const feature = this.feature;
    if (this.dragging || (!feature.around && !feature.centered)) {
      return;
    }
    const wall = this.app.view.body(feature.face.body)?.faces.find(face => face.step === feature.id && face.round?.hole && Math.abs(dot(face.normal, this.out)) < 0.01);
    if (!wall) {
      return;
    }
    const flattened = this.flatten(wall.center);
    if (dist(flattened, this.at) < 1e-7) {
      return;
    }
    this.actual = flattened;
    this.show();
  }

  private handle: Handle | null = null;
  private dims: DimWidget[] = [];
  private dragging = false;

  constructor(app: AppContext, face: FaceRef, at: Vec3, tolPx = 12, existing?: HoleFeature) {
    const size = screwSize('M3')!;
    super(app, { ...app.store.newIdentity('hole'), type: 'hole', face, at, ...(lastHole ?? { ...holeFor(size, 'none'), head: 'none', through: true, depth: 10 }) }, existing);
    this.out = norm(face.normal);
    this.middle = face.center;
    this.on = face.center;
    const body = app.view.body(face.body);
    // (Opened again: the face as it is now - it may have moved since - and the hole where it really is.)
    if (existing && body) {
      const i = faceIndexOf(app, face);
      if (i !== null) {
        this.on = body.faces[i].center;
      }
      const wall = body.faces.find(face => face.step === existing.id && face.round?.hole && Math.abs(dot(face.normal, this.out)) < 0.01);
      if (wall) {
        this.feature.at = wall.center;
      }
    }
    const size0 = Math.sqrt(face.area) || 1;
    const flat = (point: Vec3) => Math.abs(dot(sub(point, this.on), this.out)) < 1e-4 * Math.max(1, size0);
    body?.edges.forEach((e) => {
      // (Not the hole's own rim.)
      if (existing && e.steps?.includes(existing.id)) {
        return;
      }
      if (!flat(e.start) || !flat(e.mid) || !flat(e.end) || Math.abs(dot(norm(e.dir), this.out)) > 1e-3) {
        return;
      }
      const ref: EdgeRef = { body: face.body, mid: e.mid, dir: e.dir, length: e.length, ...(e.steps ? { steps: e.steps } : {}), ...(e.curves ? { curves: e.curves } : {}) };
      if (e.type === 'LINE' && dist(e.start, e.end) > 1e-6) {
        this.lines.push({ a: e.start, b: e.end, ref });
      } else if (e.type === 'CIRCLE') {
        const centre = centreOf(e.start, e.mid, e.end);
        if (centre && !this.rounds.some(round => dist(round.c, centre) < 1e-6)) {
          this.rounds.push({ c: centre, ref });
        }
      }
    });
    this.feature.at = this.flatten(this.feature.at);
    if (!existing) {
      this.place(this.feature.at, app.view.cam.worldPerPixel(app.view.height) * Math.max(12, tolPx));
    } else {
      this.hold();
    }
  }

  private flatten(point: Vec3): Vec3 {
    return sub(point, scale(this.out, dot(sub(point, this.on), this.out)));
  }

  // ------------------------------------------------------------ where it is

  /** The two straight edges nearest a point that do not run the same way (the nearest first). */
  private nearest(point: Vec3): [Line, Line] | null {
    const far = (line: Line): number => {
      const t = sub(line.b, line.a);
      const length = len(t);
      const along = dot(sub(point, line.a), t) / (length * length);
      const square = len(cross(sub(point, line.a), t)) / length;

      // (An edge the point is not beside counts as further off: the one it is beside is the one meant.)
      return square + (along < 0 ? -along * length : along > 1 ? (along - 1) * length : 0);
    };
    const sorted = [...this.lines].sort((x, y) => far(x) - far(y));
    const first = sorted[0];
    if (!first) {
      return null;
    }
    const t1 = norm(sub(first.b, first.a));
    const second = sorted.find(line => len(cross(t1, norm(sub(line.b, line.a)))) > 0.3);

    return second ? [first, second] : null;
  }

  /** How far it is from each of the edges it is measured from. */
  private distances(): [number, number] | null {
    const edges2 = this.edges2;
    if (!edges2) {
      return null;
    }
    const distances = edges2.map(line => distanceFrom(line, this.at, this.middle, this.out));

    return distances[0] === null || distances[1] === null ? null : [distances[0], distances[1]];
  }

  /** The edges a hole opened again is held from (or, with none, the nearest: only to show its sizes). */
  private hold(): void {
    const feature = this.feature;
    const tol = 1e-4 * Math.max(1, Math.sqrt(feature.face.area));
    const mine = feature.from?.map(x => this.lines.find(line => dist(line.ref.mid, x.edge.mid) < tol));
    this.edges2 = mine?.[0] && mine[1] ? [mine[0], mine[1]] : this.nearest(feature.at);
  }

  /**
   * Put down at a point of the face: on the face's middle or a round edge's centre when within `catchAt` of one,
   * else held from the two nearest straight edges, their sizes in steps of `step`.
   */
  private place(target: Vec3, catchAt: number, step = 0): void {
    const feature = this.feature;
    target = this.flatten(target);
    this.actual = null;
    delete feature.around;
    delete feature.centered;
    delete feature.from;
    let best: { c: Vec3; d: number; round?: Round } | null = null;
    for (const candidate of [{ c: this.flatten(this.middle) }, ...this.rounds.map(round => ({ c: round.c, round }))]) {
      const distance = dist(candidate.c, target);
      if (distance <= catchAt && (!best || distance < best.d)) {
        best = { ...candidate, d: distance };
      }
    }
    if (best) {
      feature.at = best.c;
      if (best.round) {
        feature.around = best.round.ref;
      } else {
        feature.centered = true;
      }
      this.edges2 = this.nearest(feature.at);
      this.caught = best.round ? 'On the centre of the round edge' : 'In the middle of the face';

      return;
    }
    this.caught = null;
    feature.at = target;
    this.edges2 = this.nearest(target);
    this.keepSizes(step);
  }

  /** What it caught on last (said by the pointer while it is dragged). */
  private caught: string | null = null;

  /** Held from its two edges at the sizes it has now (in steps of `step`), or at `typed` for one of them. */
  private keepSizes(step = 0, typed?: { i: number; v: number }): void {
    const feature = this.feature;
    const edges2 = this.edges2;
    const distances = this.distances();
    if (!edges2 || !distances) {
      return;
    }
    feature.at = this.at;
    this.actual = null;
    const size = distances.map((x, i) => {
      if (typed?.i === i) {
        return (x < 0 ? -1 : 1) * typed.v;
      }

      return Math.round((step > 0 ? Math.round(x / step) * step : x) * 1e9) / 1e9;
    });
    const at = holeFromLines(feature.at, this.middle, this.out, { ...edges2[0], d: size[0] }, { ...edges2[1], d: size[1] });
    if (!at) {
      return;
    }
    feature.at = this.flatten(at);
    delete feature.around;
    delete feature.centered;
    feature.from = [
      { edge: edges2[0].ref, d: size[0] },
      { edge: edges2[1].ref, d: size[1] }
    ];
  }

  // ------------------------------------------------------------ the tool

  enter(): void {
    super.enter();
    this.handle = new Handle(this.app.view, 'dot');
    this.show();
  }

  exit(): void {
    this.handle?.dispose();
    this.handle = null;
    for (const dimension of this.dims) {
      dimension.dispose();
    }
    this.dims = [];
    super.exit();
  }

  protected restored(): void {
    this.actual = null;
    this.hold();
    this.show();
  }

  /** The dot on the hole, and its two sizes from the edges. */
  private show(): void {
    if (!this.handle) {
      return;
    }
    const at = this.at;
    this.handle.set(at, this.out);
    const edges2 = this.edges2;
    const distances = this.distances();
    if (!edges2 || !distances) {
      for (const dimension of this.dims) {
        dimension.dispose();
      }
      this.dims = [];

      return;
    }
    edges2.forEach((line, i) => {
      const side = sideOf(line, this.middle, at, this.out);
      if (!side) {
        return;
      }
      this.dims[i] ??= new DimWidget(this.app.view, {
        value: Math.abs(distances[i]),
        // (Its box past the edge, off the face: on the line it sat on the hole.)
        boxAt: 'beyond',
        boxGap: 6,
        dir: scale(side, -1),
        facing: this.out,
        onInput: value => this.typed(i, value),
        onCommit: () => this.done()
      });
      this.dims[i].set(at, sub(at, scale(side, distances[i])));
      this.dims[i].setValue(Math.abs(distances[i]));
    });
  }

  /** A size typed by one of its edges: that far from it, as far from the other as it was. */
  private typed(i: number, value: number): void {
    if (!(value >= 0)) {
      return;
    }
    this.keepSizes(0, { i, v: value });
    this.show();
    this.update();
  }

  private moved(): void {
    this.show();
    this.update();
  }

  private catchAt(pointer: ToolPointer): number {
    return this.app.view.cam.worldPerPixel(this.app.view.height) * Math.max(12, pointer.tol);
  }

  private pointOn(pointer: ToolPointer): Vec3 | null {
    return this.app.view.rayToPlane(pointer.x, pointer.y, { origin: this.on, normal: this.out, xDir: [1, 0, 0] });
  }

  hover(pointer: ToolPointer | null): void {
    this.handle?.setHot(!!pointer && (this.dragging || !!this.handle?.hit(pointer)));
    this.app.setHover(null);
  }

  down(pointer: ToolPointer): boolean {
    if (!this.handle?.hit(pointer)) {
      return false;
    }
    this.dragging = true;

    return true;
  }

  drag(pointer: ToolPointer): void {
    if (!this.dragging) {
      return;
    }
    const at = this.pointOn(pointer);
    if (!at) {
      return;
    }
    this.place(at, this.catchAt(pointer), niceStep(this.app.view.cam.worldPerPixel(this.app.view.height) * 4));
    const distances = this.distances();
    this.app.ui.setLabel(pointer.x, pointer.y, this.caught ?? (distances && this.feature.from ? `${fmtLen(Math.abs(distances[0]))} and ${fmtLen(Math.abs(distances[1]))} from the edges` : null));
    this.moved();
  }

  up(): void {
    this.dragging = false;
    this.app.ui.setLabel(0, 0, null);
    this.handle?.setHot(false);
    this.setHint();
  }

  /** A tap on the body puts the hole there; a tap on nothing ends the tool (the hole is kept). */
  tap(pointer: ToolPointer): void {
    const hit = this.app.view.pick(pointer.x, pointer.y, { edgeTolPx: pointer.tol });
    if (!hit || !('body' in hit) || hit.body !== this.feature.face.body) {
      return super.tap(pointer);
    }
    // On its face (or in the hole itself): there. Another face of the body - a side wall - is not a place on this one.
    const mine = hit.kind === 'face' && this.app.view.body(hit.body)?.faces[hit.face]?.step === this.feature.id;
    const flat = Math.abs(dot(sub(hit.point, this.on), this.out)) < 1e-3 * Math.max(1, Math.sqrt(this.feature.face.area));
    const at = mine || flat ? this.pointOn(pointer) : null;
    if (!at) {
      return void this.app.ui.toast('Tap the face the hole is in to move it there');
    }
    this.place(at, this.catchAt(pointer), niceStep(this.app.view.cam.worldPerPixel(this.app.view.height) * 4));
    if (this.caught) {
      this.app.ui.toast(this.caught);
    }
    this.moved();
    this.setHint();
  }

  protected hint(): string {
    const feature = this.feature;
    const what = `${feature.size ? `${feature.size} hole` : `Hole ${fmtLen(feature.diameter)} across`}${feature.head === 'none' ? '' : `, ${feature.head}`}${feature.through ? ', right through' : `, ${fmtLen(feature.depth)} deep`}`;
    const where = feature.around ? 'It is on the centre of the round edge, and stays there.' : feature.centered ? 'It is in the middle of the face, and stays there.' : feature.from ? 'Type its two sizes from the edges, or drag its dot.' : 'Drag its dot to move it.';

    return `${what}. ${where}`;
  }

  protected ready(): boolean {
    return this.feature.diameter > 0;
  }

  protected items(): PanelItem[] {
    const feature = this.feature;
    const items: PanelItem[] = [
      { type: 'choice', label: 'Screw', list: true, options: [...SCREW_SIZES.map(screwSize => ({ id: screwSize.name, label: screwSize.name })), { id: '', label: 'Other' }], value: feature.size ?? '', onChange: id => this.setScrew(id) },
      this.num('Diameter', 'diameter', 'length', { min: 0.01, onInput: () => this.changed() }),
      { type: 'choice', label: 'Head', options: HEADS, value: feature.head, onChange: id => this.setHead(id as Head) }
    ];
    if (feature.head !== 'none') {
      items.push(this.num('Head diameter', 'headDiameter', 'length', { min: 0.01, onInput: () => this.changed() }));
    }
    if (feature.head === 'counterbore') {
      items.push(this.num('Head depth', 'headDepth', 'length', { min: 0.01, onInput: () => this.changed() }));
    }
    items.push({ type: 'toggle', label: 'Through', value: feature.through, onChange: isOn => ((feature.through = isOn), this.changed(true)) });
    if (!feature.through) {
      items.push(this.num('Depth', 'depth', 'length', { min: 0.01, onInput: () => this.changed() }));
    }

    return items;
  }

  private setScrew(name: string): void {
    const feature = this.feature;
    const size = screwSize(name);
    if (size) {
      Object.assign(feature, holeFor(size, feature.head));
    } else {
      delete feature.size;
    }
    this.fitDepth();
    // (Sizes from the table: no longer what a formula typed for the last screw said.)
    for (const field of ['diameter', 'headDiameter', 'headDepth']) {
      this.setExpr(field, null);
    }
    this.changed(true);
  }

  private setHead(head: Head): void {
    const feature = this.feature;
    feature.head = head;
    const size = screwSize(feature.size);
    if (head !== 'none') {
      const made = size ? holeFor(size, head) : headFor(feature.diameter, head);
      feature.headDiameter = made.headDiameter;
      feature.headDepth = made.headDepth;
      for (const field of ['headDiameter', 'headDepth']) {
        this.setExpr(field, null);
      }
    }
    this.fitDepth();
    this.changed(true);
  }

  /** A hole to a depth goes deeper than the recess for its head (choosing a bigger screw made it "too shallow"). */
  private fitDepth(): void {
    const feature = this.feature;
    if (feature.through || feature.head === 'none') {
      return;
    }
    const recess = feature.head === 'counterbore' ? feature.headDepth : sinkDepth(feature);
    if (!(feature.depth > recess)) {
      feature.depth = Math.ceil(recess + feature.diameter);
    }
  }

  private changed(panel = false): void {
    const feature = this.feature;
    lastHole = { ...(feature.size ? { size: feature.size } : {}), diameter: feature.diameter, head: feature.head, headDiameter: feature.headDiameter, headDepth: feature.headDepth, through: feature.through, depth: feature.depth };
    if (panel) {
      this.render();
    }
    this.update();
    if (!panel) {
      this.setHint();
    }
  }
}

/** The centre of a round edge from its start, middle and end (a whole circle: half way from start to middle). */
function centreOf(a: Vec3, midpoint: Vec3, b: Vec3): Vec3 | null {
  if (dist(a, b) < 1e-7 * Math.max(1, dist(a, midpoint))) {
    return scale(add(a, midpoint), 0.5);
  }
  const ab = sub(midpoint, a);
  const ac = sub(b, a);
  const normal = cross(ab, ac);
  const n2 = dot(normal, normal);
  if (n2 < 1e-18) {
    return null;
  }
  const to = add(scale(cross(normal, ab), dot(ac, ac)), scale(cross(ac, normal), dot(ab, ab)));

  return add(a, scale(to, 1 / (2 * n2)));
}
