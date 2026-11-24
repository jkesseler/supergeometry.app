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
    const s = this.start;
    this.start = undefined;
    if (s && s.a.body !== s.b.body) {
      this.make(this.pickOf(s.a.body, s.a.face), this.pickOf(s.b.body, s.b.face));
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
    this.app.store.commit((d) => {
      if (pose) {
        d.pose = pose;
      } else {
        delete d.pose;
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
    const P = b.positions;
    const lo: Vec3 = [Infinity, Infinity, Infinity];
    const hi: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < P.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        (lo[k] = Math.min(lo[k], P[i + k])), (hi[k] = Math.max(hi[k], P[i + k]));
      }
    }
    const m = { key: b.key, center: scale(add(lo, hi), 0.5), size: len(sub(hi, lo)) / 2 };
    this.measured.set(body, m);

    return m;
  }

  private poses(): Map<string, Mat4> {
    const bodies = this.bodies;
    const centers: Record<string, Vec3> = {};
    const sizes: Record<string, number> = {};
    if (this.exploded > 0) {
      for (const b of bodies) {
        const m = this.measure(b);
        if (m) {
          (centers[b] = m.center), (sizes[b] = m.size);
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
    const I: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = poses.get(ids[i]);
        const b = poses.get(ids[j]);
        out.set(`${ids[i]}|${ids[j]}`, a || b ? mul(inverse(a ?? I), b ?? I) : I);
      }
    }

    return out;
  }

  /** The pairs of bodies run into each other, of those in `pairs` (all of them; or only those that stand otherwise than in `than`). */
  private clashes(pairs: Map<string, Mat4>, than?: Map<string, Mat4>, skip?: Set<string>): Set<string> {
    const out = new Set<string>();
    for (const [key, m] of pairs) {
      if (skip?.has(key)) {
        continue;
      }
      const was = than?.get(key);
      if (was && was.every((v, i) => Math.abs(v - m[i]) < 1e-9)) {
        continue;
      }
      const [a, b] = key.split('|');
      const sa = this.solid(a);
      const sb = this.solid(b);
      if (sa && sb && penetrates(sa, sb, m, CONTACT_TOL)) {
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
    const j0 = this.joints.find(x => x.id === this.editing);
    if (!j0 || j0.type === 'fixed' || this.mode !== 'edit') {
      return;
    }
    const j = this.live(j0);
    const t = tree(this.liveJoints(), this.bodies, this.app.store.doc.ground);
    const child = t.up.get(j.b)?.joint.id === j.id ? j.b : j.a;
    const parent = t.up.get(child)?.parent;
    const m = (parent && poses.get(parent)) || null;
    const o = m ? apply(m, j.origin) : j.origin;
    const a = norm(m ? turn(m, j.axis) : j.axis);
    const reach = Math.max(this.measure(j.a)?.size ?? 10, this.measure(j.b)?.size ?? 10) * 1.6;
    const g = new BufferGeometry().setFromPoints([new Vector3(...add(o, scale(a, -reach))), new Vector3(...add(o, scale(a, reach)))]);
    this.axisLine = new Line(g, new LineBasicMaterial({ color: AXIS_COLOR, depthTest: false, transparent: true }));
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
    const f = b?.faces[face];
    const g = b?.faceGroups.find(x => x.face === face);
    if (!b || !f?.plane || !g) {
      return null;
    }
    const P = b.positions;
    const I = b.indices;
    const x = norm(f.plane.xDir);
    const y = norm(cross(f.plane.normal, f.plane.xDir));
    const o = f.plane.origin;
    let u0 = Infinity;
    let u1 = -Infinity;
    let v0 = Infinity;
    let v1 = -Infinity;
    for (let k = g.start; k < g.start + g.count; k++) {
      const i = I[k];
      const d: Vec3 = [P[3 * i] - o[0], P[3 * i + 1] - o[1], P[3 * i + 2] - o[2]];
      const u = dot(d, x);
      const v = dot(d, y);
      u0 = Math.min(u0, u);
      u1 = Math.max(u1, u);
      v0 = Math.min(v0, v);
      v1 = Math.max(v1, v);
    }
    if (!(u1 >= u0)) {
      return null;
    }
    // (On the face's own plane: the drawn points are kept to seven digits, the plane is exact.)
    const n = norm(f.plane.normal);
    const flat = add(add(o, scale(x, (u0 + u1) / 2)), scale(y, (v0 + v1) / 2));

    return add(flat, scale(n, dot(sub(f.center, flat), n)));
  }

  private pickOf(body: string, face: number): Pick {
    const f = this.app.view.body(body)?.faces[face];
    let line: PickLine | null = null;
    if (f?.round) {
      const ax = roundAxis(this.app, body, face);
      if (ax) {
        line = { origin: ax.origin, dir: ax.dir, round: true };
      }
    } else if (f?.plane) {
      line = { origin: this.centroid(body, face) ?? f.center, dir: f.normal, round: false };
    }
    // Any other face that is turned round a line - a thread's flank, a cone: that line, found from its points.
    else if (f) {
      const b = this.app.view.body(body)!;
      const g = b.faceGroups.find(x => x.face === face);
      if (g) {
        const seen = new Set<number>();
        const pts: Vec3[] = [];
        const nrm: Vec3[] = [];
        for (let k = g.start; k < g.start + g.count; k++) {
          const i = b.indices[k];
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

  private faceAt(p: ToolPointer): { body: string; face: number; point: Vec3 } | null {
    const h = this.app.view.facesAt(p.x, p.y)[0];

    return h && h.kind === 'face' ? { body: h.body, face: h.face, point: h.point } : null;
  }

  hover(p: ToolPointer | null): void {
    if (this.mode !== 'add') {
      return this.app.setHover(null);
    }
    const h = p ? this.faceAt(p) : null;
    this.app.setHover(h ? { kind: 'face', body: h.body, face: h.face } : null);
  }

  tap(p: ToolPointer): void {
    const h = this.faceAt(p);
    if (this.mode === 'add') {
      if (!h) {
        return;
      }
      if (!this.first) {
        this.first = this.pickOf(h.body, h.face);
        this.app.setSelection([{ kind: 'face', body: h.body, face: h.face }]);

        return this.render();
      }
      if (h.body === this.first.body) {
        return this.app.ui.toast('Tap a face of another part: a joint is between two');
      }

      return this.make(this.first, this.pickOf(h.body, h.face));
    }
    // A part tapped: the joint that holds it is opened. Nothing tapped: back to the list.
    if (!h) {
      return this.mode === 'edit' ? this.toList() : undefined;
    }
    const t = tree(this.liveJoints(), this.bodies, this.app.store.doc.ground);
    const j = t.up.get(h.body)?.joint ?? this.joints.find(x => x.a === h.body || x.b === h.body);
    if (j) {
      this.open(j.id);
    } else {
      this.app.ui.toast('No joint holds that part yet. Add joint, then tap it and the part it moves against.');
    }
  }

  // ------------------------------------------------------------------ joints made and changed

  private change(mutate: (joints: Joint[]) => void): void {
    this.app.store.commit((d) => {
      d.joints ??= [];
      mutate(d.joints);
      if (!d.joints.length) {
        delete d.joints;
      }
    });
  }

  private patch(id: string, p: Partial<Joint>): void {
    this.change((js) => {
      const j = js.find(x => x.id === id);
      if (j) {
        Object.assign(j, p);
      }
    });
    this.show();
    this.render();
  }

  /** The pitch of a thread on either body (mm for each full turn), when one of them is threaded. */
  private threadOn(a: string, b: string): number | undefined {
    const t = this.app.store.doc.features.find((f): f is ThreadFeature => f.type === 'thread' && !f.suppressed && (f.face.body === a || f.face.body === b));

    return t ? t.pitch * (t.starts ?? 1) : undefined;
  }

  private make(a: Pick, b: Pick): void {
    const p = propose(a.line, b.line, this.threadOn(a.body, b.body));
    const n = this.joints.length + 1;
    const refA = faceRefOf(this.app, a.line ? a : b) ?? undefined;
    const refB = faceRefOf(this.app, a.line ? b : a) ?? undefined;
    const joint: Joint = { id: uid(), name: `Joint ${n}`, type: p.type, a: a.body, b: b.body, origin: p.origin, axis: p.axis, ...(p.pitch ? { pitch: p.pitch } : {}), ...(refA ? { refA } : {}), ...(refB ? { refB } : {}) };
    this.change(js => js.push(joint));
    this.first = null;
    this.app.setSelection([]);
    this.app.ui.toast(`${JOINT_NAMES[p.type]} joint: ${this.nameOf(a.body)} and ${this.nameOf(b.body)}`);
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

  private setValue(j: Joint, v: number): void {
    const d = driverOf(this.liveJoints(), j.id);
    if (!d || !d.ratio) {
      return;
    }
    this.values[d.joint.id] = v / d.ratio;
    // (Kept in its limits: what is stored is where it is.)
    this.values[d.joint.id] = effective(this.liveJoints(), this.values)[d.joint.id] ?? 0;
    this.show();
  }

  // ------------------------------------------------------------------ dragging a part

  dragStart(from: ToolPointer): boolean {
    if (this.mode === 'add' || this.exploded > 0) {
      return false;
    }
    const h = this.faceAt(from);
    if (!h) {
      return false;
    }
    const joints = this.liveJoints();
    const t = tree(joints, this.bodies, this.app.store.doc.ground);
    // The joint that lets it move: its own, or - held fast to another part - that part's.
    let body = h.body;
    let up = t.up.get(body);
    while (up && up.joint.type === 'fixed') {
      (body = up.parent), (up = t.up.get(body));
    }
    if (!up) {
      if (joints.some(j => j.a === h.body || j.b === h.body)) {
        this.app.ui.toast('That part stands still: drag the part that moves against it');
      }

      return false;
    }
    const d = driverOf(joints, up.joint.id);
    if (!d || !d.ratio) {
      return false;
    }
    const poses = this.poses();
    const m = poses.get(up.parent) ?? null;
    const origin = m ? apply(m, up.joint.origin) : up.joint.origin;
    const axis = norm(m ? turn(m, up.joint.axis) : up.joint.axis);
    // Stop on contact: what is in each other already is left to be (parts modelled into each other, or touching).
    const stood = stopOnContact ? this.standing(poses) : new Map<string, Mat4>();
    const inEachOther = stopOnContact ? this.clashes(stood) : new Set<string>();
    this.dragging = { from, joint: up.joint, driver: d.joint, ratio: d.ratio, sign: up.joint.b === body ? 1 : -1, v0: effective(joints, this.values)[up.joint.id] ?? 0, grab: h.point, origin, axis, turned: 0, last: null, inEachOther, stood, free: this.values[d.joint.id] ?? 0 };

    return true;
  }

  drag(p: ToolPointer): void {
    const g = this.dragging;
    if (!g) {
      return;
    }
    let moved: number;
    if (g.joint.type === 'slide') {
      moved = axisDrag(this.app.view, g.grab, g.axis, g.from, p);
    } else {
      // Round the line. Seen along it (enough): by where the pointer is on the plane across it, turn by turn.
      // Seen from the side: by how far the pointer went the way the grabbed point goes round.
      const centre = add(g.origin, scale(g.axis, dot(sub(g.grab, g.origin), g.axis)));
      const arm = sub(g.grab, centre);
      const ray = this.app.view.pointerRay(p.x, p.y);
      const facing = dot(ray.d, g.axis);
      if (Math.abs(facing) > 0.3 && len(arm) > 1e-6) {
        const s = dot(sub(centre, ray.o), g.axis) / facing;
        const at = sub(add(ray.o, scale(ray.d, s)), centre);
        const prev = g.last ?? arm;
        g.turned += (Math.atan2(dot(cross(prev, at), g.axis), dot(prev, at)) * 180) / Math.PI;
        g.last = at;
        moved = g.turned;
      } else {
        const r = len(arm) || 1;
        moved = (axisDrag(this.app.view, g.grab, norm(cross(g.axis, arm)), g.from, p) / r) * (180 / Math.PI);
      }
    }
    const want = g.v0 + g.sign * moved;
    this.values[g.driver.id] = want / g.ratio;
    // (Kept in the limits: what is stored is what it is, so the next drag starts from there.)
    let v = effective(this.liveJoints(), this.values);
    this.values[g.driver.id] = v[g.driver.id];
    // Stop on contact: a move that runs a part into another goes only as far as it can - found by halving, between
    // the last value nothing was run into at and the one asked for.
    let stopped = false;
    if (stopOnContact) {
      const hits = (value: number): boolean => {
        this.values[g.driver.id] = value;

        return this.clashes(this.standing(this.poses()), g.stood, g.inEachOther).size > 0;
      };
      const asked = this.values[g.driver.id];
      // (The way there is gone in steps - a millimetre, or three degrees, of the dragged joint - so a part is not
      // carried through another and out of its far side by one long move.)
      const pace = (g.joint.type === 'slide' ? 1 : 3) / Math.abs(g.ratio || 1);
      const steps = Math.min(40, Math.max(1, Math.ceil(Math.abs(asked - g.free) / pace)));
      let lo = g.free;
      let hi: number | null = null;
      for (let i = 1; i <= steps; i++) {
        const at = g.free + ((asked - g.free) * i) / steps;
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
      this.values[g.driver.id] = lo;
      g.free = this.values[g.driver.id];
      v = effective(this.liveJoints(), this.values);
    }
    this.show();
    const now = v[g.joint.id] ?? 0;
    this.app.ui.setLabel(p.x, p.y, `${g.joint.type === 'slide' ? fmtLen(now) : `${+now.toFixed(1)}°`}${stopped ? ' · contact' : ''}`);
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
    const g = this.dragging;
    if (!g) {
      return;
    }
    this.values[g.driver.id] = (g.v0 * 1) / g.ratio;
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
    const j0 = this.mode === 'edit' ? joints.find(x => x.id === this.editing) : undefined;
    if (j0) {
      const j = j0;
      const turns = j.type === 'hinge' || j.type === 'screw';
      const now = effective(this.liveJoints(), this.values)[j.id] ?? 0;
      const limited = j.min !== undefined || j.max !== undefined;
      const others = joints.filter(x => x.id !== j.id && x.type !== 'fixed' && x.drive?.joint !== j.id);
      const items: PanelItem[] = [{ type: 'choice', label: 'Type', list: true, options: (Object.keys(JOINT_NAMES) as JointType[]).map(id => ({ id, label: JOINT_NAMES[id] })), value: j.type, onChange: id => this.setType(j, id as JointType) }];
      if (j.type !== 'fixed') {
        items.push({ type: 'number', label: turns ? 'Angle' : 'Distance', value: now, kind: turns ? 'angle' : 'length', onInput: v => (this.setValue(j, v), this.save(), this.render()) });
        if (j.type === 'screw') {
          items.push({ type: 'number', label: 'Pitch', value: j.pitch ?? 1.5, kind: 'length', min: 0.01, onInput: v => v > 0 && this.patch(j.id, { pitch: v }) });
        }
        items.push({ type: 'toggle', label: 'Limits', value: limited, onChange: on => this.patch(j.id, on ? { min: turns ? 0 : 0, max: turns ? 90 : 20 } : { min: undefined, max: undefined }) });
        if (limited) {
          items.push({ type: 'number', label: 'From', value: j.min ?? 0, kind: turns ? 'angle' : 'length', onInput: v => this.patch(j.id, { min: Math.min(v, j.max ?? v) }) });
          items.push({ type: 'number', label: 'To', value: j.max ?? 0, kind: turns ? 'angle' : 'length', onInput: v => this.patch(j.id, { max: Math.max(v, j.min ?? v) }) });
        }
        items.push({ type: 'button', label: 'Flip', icon: 'flip', onClick: () => this.patch(j.id, { axis: scale(j.axis, -1) }) });
        if (others.length) {
          items.push({ type: 'choice', label: 'Follows', list: true, options: [{ id: '', label: 'Nothing' }, ...others.map(x => ({ id: x.id, label: x.name }))], value: j.drive?.joint ?? '', onChange: id => this.patch(j.id, { drive: id ? { joint: id, ratio: j.drive?.ratio ?? 1 } : undefined }) });
          if (j.drive) {
            items.push({ type: 'number', label: 'Ratio', value: j.drive.ratio, kind: 'number', onInput: v => v && this.patch(j.id, { drive: { joint: j.drive!.joint, ratio: v } }) });
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
                const i = js.findIndex(x => x.id === j.id);
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
    const held = [...new Set(joints.flatMap(x => [x.a, x.b]))].filter(b => this.app.view.body(b));
    const ground = this.app.store.doc.ground && held.includes(this.app.store.doc.ground) ? this.app.store.doc.ground : (tree(joints, this.bodies).roots[0] ?? '');
    const moved = this.exploded > 0 || Object.values(this.values).some(v => Math.abs(v) > 1e-9);
    const items: PanelItem[] = [
      { type: 'button', label: 'Add joint', icon: 'assembly', primary: !joints.length, onClick: () => (this.home(), (this.mode = 'add'), (this.first = null), this.render()) },
      { type: 'chips', label: 'Joints', empty: 'None yet', chips: joints.map(x => ({ label: `${x.name} · ${JOINT_NAMES[x.type]}`, title: `${this.nameOf(x.a)} and ${this.nameOf(x.b)}`, onClick: () => this.open(x.id) })) }
    ];
    if (joints.length) {
      items.push({ type: 'slider', label: 'Explode', value: Math.round(this.exploded * 100), min: 0, max: 100, step: 1, show: v => `${v}%`, onInput: v => ((this.exploded = v / 100), this.show()) });
      if (held.length > 1) {
        items.push({ type: 'choice', label: 'Stands still', list: true, options: held.map(b => ({ id: b, label: this.nameOf(b) })), value: ground, onChange: id => (this.app.store.commit(d => void (d.ground = id)), this.show(), this.render()) });
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
