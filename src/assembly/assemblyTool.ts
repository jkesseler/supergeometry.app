// Assemblies, in the app: joints between the project's bodies, and the bodies dragged by them.
//
// The bodies are where they were modelled, so there is nothing to put in place. A joint is two taps - a face on
// each of two bodies - and the app says what kind it is from the faces as they stand (see `propose`). A body
// dragged then moves the way its joint lets it. Moving is a pose, not an edit: Home, or leaving Assemblies, has
// every body where it was modelled again.

import { BufferGeometry, Line, LineBasicMaterial, Vector3 } from 'three';
import { add, cross, dot, len, norm, scale, sub } from '../geom';
import { fmtLen } from '../units';
import { axisDrag } from '../tools/handles';
import { roundAxis } from '../tools/select';
import { faceIndexOf, faceRefOf, type AppContext, type Tool } from '../tools/tool';
import { inverse, penetrates, Solid } from './contact';
import { apply, driverOf, effective, JOINT_NAMES, propose, solve, tree, mul, turn, turnAxis, type Joint, type JointType, type Mat4, type PickLine } from './joints';
import type { ToolPointer } from '../view/input';
import type { PanelItem } from '../ui/ui';
import type { ThreadFeature, Vec3 } from '../doc/types';

interface Pick {
  body: string;
  face: number;
  line: PickLine | null;
}

/** Stop on contact, as it was last set (for this visit to the page). */
let stopOnContact = false;
/** How far into each other two parts may be shown before they count as run into each other (mm): what touches, or sits with a hair of play, is not. */
const CONTACT_TOL = 0.25;

const uid = () => `joint-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
const AXIS_COLOR = 0xff9d2e;

export class AssemblyTool implements Tool {
  readonly id = 'assembly';
  /** How far each joint is from home (degrees; mm for a slide). Gone when the tool is left. */
  private values: Record<string, number> = {};
  /** 0 to 1: how far the bodies are pulled apart. */
  private exploded = 0;
  private mode: 'list' | 'add' | 'edit' = 'list';
  private first: Pick | null = null;
  private editing: string | null = null;
  private axisLine: Line | null = null;
  private dragging: {
    from: ToolPointer;
    joint: Joint;
    /** The joint whose own value is set (the dragged one, or the one it follows), and by how much it is followed. */
    driver: Joint;
    ratio: number;
    sign: number;
    v0: number;
    /** Where it was taken hold of, and the joint's line as it is now (its parent moved, it moved with it). */
    grab: Vec3;
    origin: Vec3;
    axis: Vec3;
    /** Round the line: the turn so far, and where the pointer was on the last move. */
    turned: number;
    last: Vec3 | null;
    /** Stop on contact: the pairs of bodies in each other as the drag began (left alone), how each pair stood then, and the last value nothing ran into anything at. */
    inEachOther: Set<string>;
    stood: Map<string, Mat4>;
    free: number;
  } | null = null;
  private solids = new Map<string, { key: unknown; solid: Solid }>();
  /** Each body's middle and size, by its mesh (measured once for each). */
  private measured = new Map<string, { key: unknown; center: Vec3; size: number }>();

  constructor(private app: AppContext, private start?: { a: { body: string; face: number }; b: { body: string; face: number } }) {}

  private get joints(): Joint[] {
    return this.app.store.doc.joints ?? [];
  }
  private get bodies(): string[] {
    return this.app.view.bodyList.map(b => b.id);
  }
  private nameOf(body: string): string {
    return this.app.store.doc.names?.[body] ?? this.app.view.body(body)?.name ?? 'a part';
  }

  enter(): void {
    this.app.ui.setTools([{ id: 'exit', label: 'Exit Assemblies', icon: 'exit', shortcut: 'Esc', run: () => this.leave() }]);
    this.app.ui.setBottom(this.app.bottomTools());
    this.app.setSelection([]);
    this.app.setHover(null);
    // Where the parts were left (asked for: "if i click on assembly again ... it doesnt show what i made before").
    this.values = { ...(this.app.store.doc.pose?.values ?? {}) };
    this.exploded = this.app.store.doc.pose?.exploded ?? 0;
    const start = this.start;
    this.start = undefined;
    if (start && start.a.body !== start.b.body) {
      this.make(this.pickOf(start.a.body, start.a.face), this.pickOf(start.b.body, start.b.face));
    } else {
      this.render();
    }
    this.show();
  }

  /** The pose as it is, kept in the project: what is shown after Assemblies is left, and when it is opened again. */
  private save(): void {
    const values: Record<string, number> = {};
    for (const j of this.joints) {
      if (Math.abs(this.values[j.id] ?? 0) > 1e-9) {
        values[j.id] = this.values[j.id];
      }
    }
    const pose = Object.keys(values).length || this.exploded > 0 ? { values, ...(this.exploded > 0 ? { exploded: this.exploded } : {}) } : undefined;
    if (JSON.stringify(pose) === JSON.stringify(this.app.store.doc.pose)) {
      return;
    }
    this.app.store.commit((draft) => {
      if (pose) {
        draft.pose = pose;
      } else {
        delete draft.pose;
      }
    });
  }

  private leave(): void {
    this.save();
    this.app.setTool(null);
  }

  exit(): void {
    // (The parts stay as they were left: the app shows the project's pose while nothing is being worked on.)
    this.dropAxis();
    this.app.ui.showPanel(null);
    this.app.ui.setHint(null);
    this.app.ui.setLabel(0, 0, null);
    this.app.setSelection([]);
    this.app.setHover(null);
  }

  key(e: KeyboardEvent): boolean {
    if (e.key !== 'Escape') {
      return false;
    }
    if (this.mode === 'list') {
      this.leave();
    } else {
      this.toList();
    }

    return true;
  }

  /** The model was made again: the bodies are shown at their joints' values still. */
  refresh(): void {
    // (A pose undone or redone: the parts go where the project has them.)
    if (!this.dragging) {
      this.values = { ...(this.app.store.doc.pose?.values ?? {}) };
    }
    this.show();
    this.render();
  }

  /** The project's pose, for the app to show when Assemblies is not open (null: all as modelled). */
  static posesOf(app: AppContext): Map<string, Mat4> | null {
    const pose = app.store.doc.pose;
    if (!pose || !app.store.doc.joints?.length) {
      return null;
    }
    const t = new AssemblyTool(app);
    t.values = { ...pose.values };
    t.exploded = pose.exploded ?? 0;

    return t.poses();
  }

  // ------------------------------------------------------------------ what is shown

  /** A joint with its line where the faces it was picked by are now (the model changed since: it follows them). */
  private live(j: Joint): Joint {
    if (!j.refA) {
      return j;
    }
    const i = faceIndexOf(this.app, j.refA);
    const line = i === null ? null : this.pickOf(j.refA.body, i).line;
    if (!line) {
      return j;
    }
    const flipped = dot(norm(line.dir), norm(j.axis)) < 0;

    return { ...j, origin: line.origin, axis: flipped ? scale(norm(line.dir), -1) : norm(line.dir) };
  }

  private liveJoints(): Joint[] {
    return this.joints.map(j => this.live(j));
  }

  private measure(body: string): { center: Vec3; size: number } | null {
    const b = this.app.view.body(body);
    if (!b) {
      return null;
    }
    const was = this.measured.get(body);
    if (was && was.key === b.key) {
      return was;
    }
    const positions = b.positions;
    const lo: Vec3 = [Infinity, Infinity, Infinity];
    const hi: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < positions.length; i += 3) {
      for (let axis = 0; axis < 3; axis++) {
        (lo[axis] = Math.min(lo[axis], positions[i + axis])), (hi[axis] = Math.max(hi[axis], positions[i + axis]));
      }
    }
    const measured = { key: b.key, center: scale(add(lo, hi), 0.5), size: len(sub(hi, lo)) / 2 };
    this.measured.set(body, measured);

    return measured;
  }

  private poses(): Map<string, Mat4> {
    const bodies = this.bodies;
    const centers: Record<string, Vec3> = {};
    const sizes: Record<string, number> = {};
    if (this.exploded > 0) {
      for (const b of bodies) {
        const measured = this.measure(b);
        if (measured) {
          (centers[b] = measured.center), (sizes[b] = measured.size);
        }
      }
    }

    return solve(this.liveJoints(), bodies, this.values, this.app.store.doc.ground, this.exploded > 0 ? { factor: this.exploded * 0.8, centers, sizes } : undefined);
  }

  private solid(body: string): Solid | null {
    const b = this.app.view.body(body);
    if (!b) {
      return null;
    }
    const was = this.solids.get(body);
    if (was && was.key === b.key) {
      return was.solid;
    }
    const solid = new Solid(b.positions, b.indices);
    this.solids.set(body, { key: b.key, solid });

    return solid;
  }

  /** Each pair of bodies shown: how the second stands against the first (the second's move, seen from the first). */
  private standing(poses: Map<string, Mat4>): Map<string, Mat4> {
    const ids = this.bodies.filter(b => !this.app.view.isHidden(b));
    const out = new Map<string, Mat4>();
    const matrix: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = poses.get(ids[i]);
        const b = poses.get(ids[j]);
        out.set(`${ids[i]}|${ids[j]}`, a || b ? mul(inverse(a ?? matrix), b ?? matrix) : matrix);
      }
    }

    return out;
  }

  /** The pairs of bodies run into each other, of those in `pairs` (all of them; or only those that stand otherwise than in `than`). */
  private clashes(pairs: Map<string, Mat4>, than?: Map<string, Mat4>, skip?: Set<string>): Set<string> {
    const out = new Set<string>();
    for (const [key, pair] of pairs) {
      if (skip?.has(key)) {
        continue;
      }
      const was = than?.get(key);
      if (was && was.every((value, i) => Math.abs(value - pair[i]) < 1e-9)) {
        continue;
      }
      const [a, b] = key.split('|');
      const sa = this.solid(a);
      const sb = this.solid(b);
      if (sa && sb && penetrates(sa, sb, pair, CONTACT_TOL)) {
        out.add(key);
      }
    }

    return out;
  }

  private show(): void {
    const poses = this.poses();
    this.app.view.setPoses(poses);
    this.placeAxis(poses);
  }

  private dropAxis(): void {
    if (!this.axisLine) {
      return;
    }
    this.app.view.overlay.remove(this.axisLine);
    this.axisLine.geometry.dispose();
    (this.axisLine.material as LineBasicMaterial).dispose();
    this.axisLine = null;
  }

  /** The line of the joint that is open, drawn through the model (with the body that carries it, when that moved). */
  private placeAxis(poses: Map<string, Mat4>): void {
    this.dropAxis();
    const j0 = this.joints.find(joint => joint.id === this.editing);
    if (!j0 || j0.type === 'fixed' || this.mode !== 'edit') {
      return;
    }
    const j = this.live(j0);
    const t = tree(this.liveJoints(), this.bodies, this.app.store.doc.ground);
    const child = t.up.get(j.b)?.joint.id === j.id ? j.b : j.a;
    const parent = t.up.get(child)?.parent;
    const matrix = (parent && poses.get(parent)) || null;
    const origin = matrix ? apply(matrix, j.origin) : j.origin;
    const a = norm(matrix ? turn(matrix, j.axis) : j.axis);
    const reach = Math.max(this.measure(j.a)?.size ?? 10, this.measure(j.b)?.size ?? 10) * 1.6;
    const geometry = new BufferGeometry().setFromPoints([new Vector3(...add(origin, scale(a, -reach))), new Vector3(...add(origin, scale(a, reach)))]);
    this.axisLine = new Line(geometry, new LineBasicMaterial({ color: AXIS_COLOR, depthTest: false, transparent: true }));
    this.axisLine.renderOrder = 60;
    this.app.view.overlay.add(this.axisLine);
    this.app.view.requestRender();
  }

  // ------------------------------------------------------------------ picks

  /**
   * A flat face's middle: the middle of the box round it (measured along the face). Not its centre of area - a
   * nut's top is a ring whose hole the thread runs out of, a little to one side, and its centre of area is a
   * quarter of a millimetre off the nut's line; its outline's middle is on it.
   */
  private centroid(body: string, face: number): Vec3 | null {
    const b = this.app.view.body(body);
    const faceInfo = b?.faces[face];
    const faceGroup = b?.faceGroups.find(faceGroup => faceGroup.face === face);
    if (!b || !faceInfo?.plane || !faceGroup) {
      return null;
    }
    const positions = b.positions;
    const indices = b.indices;
    const x = norm(faceInfo.plane.xDir);
    const y = norm(cross(faceInfo.plane.normal, faceInfo.plane.xDir));
    const origin = faceInfo.plane.origin;
    let u0 = Infinity;
    let u1 = -Infinity;
    let v0 = Infinity;
    let v1 = -Infinity;
    for (let start = faceGroup.start; start < faceGroup.start + faceGroup.count; start++) {
      const i = indices[start];
      const offset: Vec3 = [positions[3 * i] - origin[0], positions[3 * i + 1] - origin[1], positions[3 * i + 2] - origin[2]];
      const alongX = dot(offset, x);
      const alongY = dot(offset, y);
      u0 = Math.min(u0, alongX);
      u1 = Math.max(u1, alongX);
      v0 = Math.min(v0, alongY);
      v1 = Math.max(v1, alongY);
    }
    if (!(u1 >= u0)) {
      return null;
    }
    // (On the face's own plane: the drawn points are kept to seven digits, the plane is exact.)
    const normal = norm(faceInfo.plane.normal);
    const flat = add(add(origin, scale(x, (u0 + u1) / 2)), scale(y, (v0 + v1) / 2));

    return add(flat, scale(normal, dot(sub(faceInfo.center, flat), normal)));
  }

  private pickOf(body: string, face: number): Pick {
    const faceInfo = this.app.view.body(body)?.faces[face];
    let line: PickLine | null = null;
    if (faceInfo?.round) {
      const ax = roundAxis(this.app, body, face);
      if (ax) {
        line = { origin: ax.origin, dir: ax.dir, round: true };
      }
    } else if (faceInfo?.plane) {
      line = { origin: this.centroid(body, face) ?? faceInfo.center, dir: faceInfo.normal, round: false };
    } else if (faceInfo) {
      // Any other face that is turned round a line - a thread's flank, a cone: that line, found from its points.
      const b = this.app.view.body(body)!;
      const faceGroup = b.faceGroups.find(faceGroup => faceGroup.face === face);
      if (faceGroup) {
        const seen = new Set<number>();
        const pts: Vec3[] = [];
        const nrm: Vec3[] = [];
        for (let start = faceGroup.start; start < faceGroup.start + faceGroup.count; start++) {
          const i = b.indices[start];
          if (seen.has(i)) {
            continue;
          }
          seen.add(i);
          pts.push([b.positions[3 * i], b.positions[3 * i + 1], b.positions[3 * i + 2]]);
          nrm.push([b.normals[3 * i], b.normals[3 * i + 1], b.normals[3 * i + 2]]);
        }
        const ax = turnAxis(pts, nrm);
        if (ax) {
          line = { origin: ax.origin, dir: ax.dir, round: true, rough: true };
        }
      }
    }

    return { body, face, line };
  }

  private faceAt(pointer: ToolPointer): { body: string; face: number; point: Vec3 } | null {
    const firstFace = this.app.view.facesAt(pointer.x, pointer.y)[0];

    return firstFace && firstFace.kind === 'face' ? { body: firstFace.body, face: firstFace.face, point: firstFace.point } : null;
  }

  hover(pointer: ToolPointer | null): void {
    if (this.mode !== 'add') {
      return this.app.setHover(null);
    }
    const hit = pointer ? this.faceAt(pointer) : null;
    this.app.setHover(hit ? { kind: 'face', body: hit.body, face: hit.face } : null);
  }

  tap(pointer: ToolPointer): void {
    const face = this.faceAt(pointer);
    if (this.mode === 'add') {
      if (!face) {
        return;
      }
      if (!this.first) {
        this.first = this.pickOf(face.body, face.face);
        this.app.setSelection([{ kind: 'face', body: face.body, face: face.face }]);

        return this.render();
      }
      if (face.body === this.first.body) {
        return this.app.ui.toast('Tap a face of another part: a joint is between two');
      }

      return this.make(this.first, this.pickOf(face.body, face.face));
    }
    // A part tapped: the joint that holds it is opened. Nothing tapped: back to the list.
    if (!face) {
      return this.mode === 'edit' ? this.toList() : undefined;
    }
    const t = tree(this.liveJoints(), this.bodies, this.app.store.doc.ground);
    const j = t.up.get(face.body)?.joint ?? this.joints.find(joint => joint.a === face.body || joint.b === face.body);
    if (j) {
      this.open(j.id);
    } else {
      this.app.ui.toast('No joint holds that part yet. Add joint, then tap it and the part it moves against.');
    }
  }

  // ------------------------------------------------------------------ joints made and changed

  private change(mutate: (joints: Joint[]) => void): void {
    this.app.store.commit((draft) => {
      draft.joints ??= [];
      mutate(draft.joints);
      if (!draft.joints.length) {
        delete draft.joints;
      }
    });
  }

  private patch(id: string, changes: Partial<Joint>): void {
    this.change((js) => {
      const j = js.find(joint => joint.id === id);
      if (j) {
        Object.assign(j, changes);
      }
    });
    this.show();
    this.render();
  }

  /** The pitch of a thread on either body (mm for each full turn), when one of them is threaded. */
  private threadOn(a: string, b: string): number | undefined {
    const t = this.app.store.doc.features.find((feature): feature is ThreadFeature => feature.type === 'thread' && !feature.suppressed && (feature.face.body === a || feature.face.body === b));

    return t ? t.pitch * (t.starts ?? 1) : undefined;
  }

  private make(a: Pick, b: Pick): void {
    const proposal = propose(a.line, b.line, this.threadOn(a.body, b.body));
    const jointNumber = this.joints.length + 1;
    const refA = faceRefOf(this.app, a.line ? a : b) ?? undefined;
    const refB = faceRefOf(this.app, a.line ? b : a) ?? undefined;
    const joint: Joint = { id: uid(), name: `Joint ${jointNumber}`, type: proposal.type, a: a.body, b: b.body, origin: proposal.origin, axis: proposal.axis, ...(proposal.pitch ? { pitch: proposal.pitch } : {}), ...(refA ? { refA } : {}), ...(refB ? { refB } : {}) };
    this.change(js => js.push(joint));
    this.first = null;
    this.app.setSelection([]);
    this.app.ui.toast(`${JOINT_NAMES[proposal.type]} joint: ${this.nameOf(a.body)} and ${this.nameOf(b.body)}`);
    this.open(joint.id);
  }

  private open(id: string): void {
    this.mode = 'edit';
    this.editing = id;
    this.show();
    this.render();
  }

  private toList(): void {
    this.save();
    this.mode = 'list';
    this.editing = null;
    this.first = null;
    this.app.setSelection([]);
    this.show();
    this.render();
  }

  private home(): void {
    this.values = {};
    this.exploded = 0;
    this.show();
    this.save();
    this.render();
  }

  private setType(j: Joint, type: JointType): void {
    delete this.values[j.id];
    const pitch = type === 'screw' ? (j.pitch ?? this.threadOn(j.a, j.b) ?? 1.5) : undefined;
    // (Limits are in the joint's own measure - degrees or mm: another kind of joint starts without them.)
    this.patch(j.id, { type, pitch, min: undefined, max: undefined, ...(type === 'fixed' ? { drive: undefined } : {}) });
  }

  private setValue(j: Joint, value: number): void {
    const driver = driverOf(this.liveJoints(), j.id);
    if (!driver || !driver.ratio) {
      return;
    }
    this.values[driver.joint.id] = value / driver.ratio;
    // (Kept in its limits: what is stored is where it is.)
    this.values[driver.joint.id] = effective(this.liveJoints(), this.values)[driver.joint.id] ?? 0;
    this.show();
  }

  // ------------------------------------------------------------------ dragging a part

  dragStart(from: ToolPointer): boolean {
    if (this.mode === 'add' || this.exploded > 0) {
      return false;
    }
    const face = this.faceAt(from);
    if (!face) {
      return false;
    }
    const joints = this.liveJoints();
    const t = tree(joints, this.bodies, this.app.store.doc.ground);
    // The joint that lets it move: its own, or - held fast to another part - that part's.
    let body = face.body;
    let up = t.up.get(body);
    while (up && up.joint.type === 'fixed') {
      (body = up.parent), (up = t.up.get(body));
    }
    if (!up) {
      if (joints.some(j => j.a === face.body || j.b === face.body)) {
        this.app.ui.toast('That part stands still: drag the part that moves against it');
      }

      return false;
    }
    const driver = driverOf(joints, up.joint.id);
    if (!driver || !driver.ratio) {
      return false;
    }
    const poses = this.poses();
    const matrix = poses.get(up.parent) ?? null;
    const origin = matrix ? apply(matrix, up.joint.origin) : up.joint.origin;
    const axis = norm(matrix ? turn(matrix, up.joint.axis) : up.joint.axis);
    // Stop on contact: what is in each other already is left to be (parts modelled into each other, or touching).
    const stood = stopOnContact ? this.standing(poses) : new Map<string, Mat4>();
    const inEachOther = stopOnContact ? this.clashes(stood) : new Set<string>();
    this.dragging = { from, joint: up.joint, driver: driver.joint, ratio: driver.ratio, sign: up.joint.b === body ? 1 : -1, v0: effective(joints, this.values)[up.joint.id] ?? 0, grab: face.point, origin, axis, turned: 0, last: null, inEachOther, stood, free: this.values[driver.joint.id] ?? 0 };

    return true;
  }

  drag(pointer: ToolPointer): void {
    const dragging = this.dragging;
    if (!dragging) {
      return;
    }
    let moved: number;
    if (dragging.joint.type === 'slide') {
      moved = axisDrag(this.app.view, dragging.grab, dragging.axis, dragging.from, pointer);
    } else {
      // Round the line. Seen along it (enough): by where the pointer is on the plane across it, turn by turn.
      // Seen from the side: by how far the pointer went the way the grabbed point goes round.
      const centre = add(dragging.origin, scale(dragging.axis, dot(sub(dragging.grab, dragging.origin), dragging.axis)));
      const arm = sub(dragging.grab, centre);
      const ray = this.app.view.pointerRay(pointer.x, pointer.y);
      const facing = dot(ray.d, dragging.axis);
      if (Math.abs(facing) > 0.3 && len(arm) > 1e-6) {
        const distance = dot(sub(centre, ray.o), dragging.axis) / facing;
        const at = sub(add(ray.o, scale(ray.d, distance)), centre);
        const prev = dragging.last ?? arm;
        dragging.turned += (Math.atan2(dot(cross(prev, at), dragging.axis), dot(prev, at)) * 180) / Math.PI;
        dragging.last = at;
        moved = dragging.turned;
      } else {
        const armLength = len(arm) || 1;
        moved = (axisDrag(this.app.view, dragging.grab, norm(cross(dragging.axis, arm)), dragging.from, pointer) / armLength) * (180 / Math.PI);
      }
    }
    const want = dragging.v0 + dragging.sign * moved;
    this.values[dragging.driver.id] = want / dragging.ratio;
    // (Kept in the limits: what is stored is what it is, so the next drag starts from there.)
    let values = effective(this.liveJoints(), this.values);
    this.values[dragging.driver.id] = values[dragging.driver.id];
    // Stop on contact: a move that runs a part into another goes only as far as it can - found by halving, between
    // the last value nothing was run into at and the one asked for.
    let stopped = false;
    if (stopOnContact) {
      const hits = (value: number): boolean => {
        this.values[dragging.driver.id] = value;

        return this.clashes(this.standing(this.poses()), dragging.stood, dragging.inEachOther).size > 0;
      };
      const asked = this.values[dragging.driver.id];
      // (The way there is gone in steps - a millimetre, or three degrees, of the dragged joint - so a part is not
      // carried through another and out of its far side by one long move.)
      const pace = (dragging.joint.type === 'slide' ? 1 : 3) / Math.abs(dragging.ratio || 1);
      const steps = Math.min(40, Math.max(1, Math.ceil(Math.abs(asked - dragging.free) / pace)));
      let lo = dragging.free;
      let hi: number | null = null;
      for (let i = 1; i <= steps; i++) {
        const at = dragging.free + ((asked - dragging.free) * i) / steps;
        if (hits(at)) {
          hi = at;
          break;
        }
        lo = at;
      }
      if (hi !== null) {
        stopped = true;
        let top: number = hi;
        for (let i = 0; i < 7; i++) {
          const mid: number = (lo + top) / 2;
          if (hits(mid)) {
            top = mid;
          } else {
            lo = mid;
          }
        }
      }
      this.values[dragging.driver.id] = lo;
      dragging.free = this.values[dragging.driver.id];
      values = effective(this.liveJoints(), this.values);
    }
    this.show();
    const now = values[dragging.joint.id] ?? 0;
    this.app.ui.setLabel(pointer.x, pointer.y, `${dragging.joint.type === 'slide' ? fmtLen(now) : `${+now.toFixed(1)}°`}${stopped ? ' · contact' : ''}`);
  }

  up(): void {
    if (!this.dragging) {
      return;
    }
    this.dragging = null;
    this.app.ui.setLabel(0, 0, null);
    this.save();
    this.render();
  }

  breakOff(): void {
    const dragging = this.dragging;
    if (!dragging) {
      return;
    }
    this.values[dragging.driver.id] = (dragging.v0 * 1) / dragging.ratio;
    this.dragging = null;
    this.app.ui.setLabel(0, 0, null);
    this.show();
  }

  // ------------------------------------------------------------------ the line at the bottom

  private render(): void {
    const ui = this.app.ui;
    const joints = this.joints;
    if (this.mode === 'add') {
      ui.setHint(this.first ? 'Now tap a face of the part it moves against.' : 'Tap a face of the first part. A round face or a flat one gives the joint its line.');
      ui.showPanel({
        title: 'New joint',
        items: [
          { type: 'slot', label: 'First part', value: this.first ? this.nameOf(this.first.body) : '', active: !this.first, filled: !!this.first, onClick: () => ((this.first = null), this.app.setSelection([]), this.render()) },
          { type: 'slot', label: 'Second part', value: '', active: !!this.first, filled: false, onClick: () => undefined }
        ],
        onCancel: () => this.toList()
      });

      return;
    }
    const j0 = this.mode === 'edit' ? joints.find(joint => joint.id === this.editing) : undefined;
    if (j0) {
      const j = j0;
      const turns = j.type === 'hinge' || j.type === 'screw';
      const now = effective(this.liveJoints(), this.values)[j.id] ?? 0;
      const limited = j.min !== undefined || j.max !== undefined;
      const others = joints.filter(joint => joint.id !== j.id && joint.type !== 'fixed' && joint.drive?.joint !== j.id);
      const items: PanelItem[] = [{ type: 'choice', label: 'Type', list: true, options: (Object.keys(JOINT_NAMES) as JointType[]).map(id => ({ id, label: JOINT_NAMES[id] })), value: j.type, onChange: id => this.setType(j, id as JointType) }];
      if (j.type !== 'fixed') {
        items.push({ type: 'number', label: turns ? 'Angle' : 'Distance', value: now, kind: turns ? 'angle' : 'length', onInput: value => (this.setValue(j, value), this.save(), this.render()) });
        if (j.type === 'screw') {
          items.push({ type: 'number', label: 'Pitch', value: j.pitch ?? 1.5, kind: 'length', min: 0.01, onInput: pitch => pitch > 0 && this.patch(j.id, { pitch: pitch }) });
        }
        items.push({ type: 'toggle', label: 'Limits', value: limited, onChange: on => this.patch(j.id, on ? { min: turns ? 0 : 0, max: turns ? 90 : 20 } : { min: undefined, max: undefined }) });
        if (limited) {
          items.push({ type: 'number', label: 'From', value: j.min ?? 0, kind: turns ? 'angle' : 'length', onInput: value => this.patch(j.id, { min: Math.min(value, j.max ?? value) }) });
          items.push({ type: 'number', label: 'To', value: j.max ?? 0, kind: turns ? 'angle' : 'length', onInput: value => this.patch(j.id, { max: Math.max(value, j.min ?? value) }) });
        }
        items.push({ type: 'button', label: 'Flip', icon: 'flip', onClick: () => this.patch(j.id, { axis: scale(j.axis, -1) }) });
        if (others.length) {
          items.push({ type: 'choice', label: 'Follows', list: true, options: [{ id: '', label: 'Nothing' }, ...others.map(other => ({ id: other.id, label: other.name }))], value: j.drive?.joint ?? '', onChange: id => this.patch(j.id, { drive: id ? { joint: id, ratio: j.drive?.ratio ?? 1 } : undefined }) });
          if (j.drive) {
            items.push({ type: 'number', label: 'Ratio', value: j.drive.ratio, kind: 'number', onInput: ratio => ratio && this.patch(j.id, { drive: { joint: j.drive!.joint, ratio: ratio } }) });
          }
        }
      }
      ui.setHint(j.type === 'fixed' ? `${this.nameOf(j.a)} and ${this.nameOf(j.b)} are held together. Change its Type to let them move.` : `Drag ${this.nameOf(j.b)} to move it. Home puts every part back where it was modelled.`);
      ui.showPanel({
        title: `${j.name}: ${this.nameOf(j.a)} and ${this.nameOf(j.b)}`,
        beta: true,
        items,
        actions: [
          {
            id: 'delete',
            label: 'Delete joint',
            icon: 'trash',
            run: () => {
              this.change((js) => {
                const i = js.findIndex(joint => joint.id === j.id);
                if (i >= 0) {
                  js.splice(i, 1);
                }
                for (const x of js) {
                  if (x.drive?.joint === j.id) {
                    delete x.drive;
                  }
                }
              });
              delete this.values[j.id];
              this.toList();
            }
          }
        ],
        onDone: () => this.toList()
      });

      return;
    }
    this.mode = 'list';
    const held = [...new Set(joints.flatMap(joint => [joint.a, joint.b]))].filter(b => this.app.view.body(b));
    const ground = this.app.store.doc.ground && held.includes(this.app.store.doc.ground) ? this.app.store.doc.ground : (tree(joints, this.bodies).roots[0] ?? '');
    const moved = this.exploded > 0 || Object.values(this.values).some(value => Math.abs(value) > 1e-9);
    const items: PanelItem[] = [
      { type: 'button', label: 'Add joint', icon: 'assembly', primary: !joints.length, onClick: () => (this.home(), (this.mode = 'add'), (this.first = null), this.render()) },
      { type: 'chips', label: 'Joints', empty: 'None yet', chips: joints.map(joint => ({ label: `${joint.name} · ${JOINT_NAMES[joint.type]}`, title: `${this.nameOf(joint.a)} and ${this.nameOf(joint.b)}`, onClick: () => this.open(joint.id) })) }
    ];
    if (joints.length) {
      items.push({ type: 'slider', label: 'Explode', value: Math.round(this.exploded * 100), min: 0, max: 100, step: 1, show: percent => `${percent}%`, onInput: percent => ((this.exploded = percent / 100), this.show()) });
      if (held.length > 1) {
        items.push({ type: 'choice', label: 'Stands still', list: true, options: held.map(b => ({ id: b, label: this.nameOf(b) })), value: ground, onChange: id => (this.app.store.commit(draft => void (draft.ground = id)), this.show(), this.render()) });
      }
      items.push({ type: 'toggle', label: 'Stop on contact', value: stopOnContact, onChange: on => ((stopOnContact = on), this.render()) });
      if (moved) {
        items.push({ type: 'button', label: 'Home', onClick: () => this.home() });
      }
    }
    ui.setHint(joints.length ? 'Drag a part to move it by its joint. Tap a part to change its joint.' : 'The parts stay where you modelled them. Add a joint to say how two of them move.');
    ui.showPanel({ title: 'Assemblies', beta: true, items, onDone: () => this.leave() });
  }
}
