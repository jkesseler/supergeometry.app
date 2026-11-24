// The model in the headset, as a real thing in your room (passthrough where
// the headset has it, else a dark room). A viewer: nothing is edited here.
//
// Right trigger: put the model down where the ray meets a table or the floor.
// Grip: pick it up, move and turn it (both grips: pull apart / together to
// size it; it stops at real size on the way). A: real size / hand size.
// B: bring it back in front of you. Y: X-Ray. Hold X: the wheel (Real size,
// Hand size, Bring here, X-Ray, Edges, Exit) - tilt the stick to a button and
// let go, or point the right hand at it and pull the trigger. A tap on X:
// bring it here. Left stick up / down: raise / lower it. Right stick: turn
// it (left / right), size it (up / down).
//
// On a phone or tablet (AR through its camera): point it at the floor or a
// table and tap to put the model there (tap again to move it); two fingers
// pinch to size it and twist to turn it. The scale sits at the left edge.
import { BufferGeometry, CanvasTexture, Color, DoubleSide, Euler, Group, Line, LineBasicMaterial, Matrix4, Mesh, MeshBasicMaterial, PlaneGeometry, Quaternion, RingGeometry, Scene, SRGBColorSpace, Vector3, type WebGLRenderer, type XRTargetRaySpace } from 'three';
import { icons, type IconName } from '../ui/icons';

type Vec3 = [number, number, number];

export interface VRItem {
  label: string;
  icon?: IconName;
  disabled?: boolean;
  run(): void;
}

export interface XRHost {
  renderer: WebGLRenderer;
  /** A phone or tablet (AR through its camera, the screen as the hands) rather than a headset. */
  handheld: boolean;
  /** The page's scene (z up, millimetres): carried into the headset's room as it is. */
  scene: Scene;
  /** The model's box, in the scene's own units. */
  bounds(): { min: Vec3; max: Vec3 } | null;
  /** X-Ray on / off; returns what to say ("X-Ray", "Shaded"). */
  xray(): string;
  /** Edges shown / hidden; returns what to say. */
  edges(): string;
  /** The look buttons' labels now ("X-Ray" or "Shaded", "Show Edges" or "Hide Edges"). */
  looks(): { xray: string; edges: string };
  /** Before each frame in the headset (the page's own per-frame work). */
  beforeFrame(): void;
  onEnter(): void;
  onExit(): void;
}

type XRSystemLike = { isSessionSupported(mode: string): Promise<boolean>; requestSession(mode: string, init?: object): Promise<XRSession> };
const xrSystem = (): XRSystemLike | undefined => (navigator as Navigator & { xr?: XRSystemLike }).xr;

/** Whether this browser can open the headset view (a headset's browser, or a PC with a headset). */
export async function vrSupported(handheld = false): Promise<boolean> {
  const xr = xrSystem();
  if (!xr) {
    return false;
  }
  // A phone's "VR" is a cardboard viewer: only its AR counts.
  for (const mode of handheld ? ['immersive-ar'] : ['immersive-ar', 'immersive-vr']) {
    try {
      if (await xr.isSessionSupported(mode)) {
        return true;
      }
    } catch {
    /* try the next */
    }
  }

  return false;
}

// ----------------------------------------------------------------- drawing

const FONT = '-apple-system, "SF Pro Text", system-ui, "Segoe UI", Roboto, sans-serif';
const ACCENT = '#0a84ff';
const GLASS = 'rgba(28, 28, 30, 0.82)';
const LINE = 'rgba(255, 255, 255, 0.14)';

/** White icon pictures, made once each (drawn on canvases). */
const iconPics = new Map<string, HTMLImageElement>();
function iconPic(name: IconName, onLoad: () => void): HTMLImageElement | null {
  const have = iconPics.get(name);
  if (have) {
    return have.complete && have.naturalWidth ? have : null;
  }
  const img = new Image();
  const svg = icons[name].replace('<svg ', '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" ').split('currentColor').join('#ffffff');
  img.onload = onLoad;
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  iconPics.set(name, img);

  return null;
}

/** A flat picture in the room: a canvas on a plane `w` metres wide. Redrawn only when asked. */
class Board {
  readonly mesh: Mesh;
  readonly context: CanvasRenderingContext2D;
  private tex: CanvasTexture;
  constructor(
    readonly px: number,
    readonly py: number,
    readonly w: number
  ) {
    const canvas = document.createElement('canvas');
    canvas.width = px;
    canvas.height = py;
    this.context = canvas.getContext('2d')!;
    this.tex = new CanvasTexture(canvas);
    this.tex.colorSpace = SRGBColorSpace;
    this.mesh = new Mesh(new PlaneGeometry(w, (w * py) / px), new MeshBasicMaterial({ map: this.tex, transparent: true, depthWrite: false, depthTest: false, side: DoubleSide }));
    this.mesh.renderOrder = 20;
  }
  clear(): CanvasRenderingContext2D {
    this.context.clearRect(0, 0, this.px, this.py);

    return this.context;
  }
  show(): void {
    this.tex.needsUpdate = true;
  }
}

/** A wheel of round buttons above one controller. */
class Wheel {
  readonly board = new Board(768, 768, 0.2);
  items: VRItem[] = [];
  hot = -1;
  title = '';
  constructor() {
    this.board.mesh.visible = false;
    // Above the controller, tilted toward you.
    this.board.mesh.position.set(0, 0.07, -0.06);
    this.board.mesh.rotation.x = -0.75;
  }
  get open(): boolean {
    return this.board.mesh.visible;
  }
  /** Where button i sits (canvas pixels): round the ring from the top, clockwise. */
  private at(i: number): [number, number] {
    const count = Math.max(this.items.length, 1);
    const a = (i / count) * Math.PI * 2;

    return [384 + Math.sin(a) * 250, 384 - Math.cos(a) * 250];
  }
  /** The button at a stick angle (0: up, clockwise), or -1. */
  slotAt(x: number, y: number): number {
    if (Math.hypot(x, y) < 0.55 || !this.items.length) {
      return -1;
    }
    const a = (Math.atan2(x, -y) + Math.PI * 2) % (Math.PI * 2);
    const count = this.items.length;

    return Math.round((a / (Math.PI * 2)) * count) % count;
  }
  /** The button under a point of the board (-1..1 across, -1..1 up), or -1. */
  slotAtPoint(across: number, up: number): number {
    const px = 384 + across * 384;
    const py = 384 - up * 384;
    let best = -1;
    let bd = 80;
    this.items.forEach((_, i) => {
      const [x, y] = this.at(i);
      const distance = Math.hypot(px - x, py - y);
      if (distance < bd) {
        ((bd = distance), (best = i));
      }
    });

    return best;
  }
  draw(): void {
    const canvasContext = this.board.clear();
    canvasContext.fillStyle = GLASS;
    canvasContext.beginPath();
    canvasContext.arc(384, 384, 360, 0, Math.PI * 2);
    canvasContext.fill();
    canvasContext.strokeStyle = LINE;
    canvasContext.lineWidth = 3;
    canvasContext.stroke();
    this.items.forEach((it, i) => {
      const [x, y] = this.at(i);
      const hot = i === this.hot;
      canvasContext.fillStyle = hot ? ACCENT : 'rgba(255,255,255,0.08)';
      canvasContext.beginPath();
      canvasContext.arc(x, y, hot ? 74 : 66, 0, Math.PI * 2);
      canvasContext.fill();
      canvasContext.globalAlpha = it.disabled ? 0.35 : 1;
      const pic = it.icon ? iconPic(it.icon, () => this.draw()) : null;
      if (pic) {
        canvasContext.drawImage(pic, x - 34, y - 34, 68, 68);
      } else {
        canvasContext.fillStyle = '#fff';
        canvasContext.font = `600 30px ${FONT}`;
        canvasContext.textAlign = 'center';
        canvasContext.textBaseline = 'middle';
        canvasContext.fillText(it.label.slice(0, 2), x, y);
      }
      canvasContext.globalAlpha = 1;
    });
    // The middle: what the chosen button does (or the wheel's name).
    const text = this.items[this.hot] ? this.items[this.hot].label : this.items.length ? this.title : 'Pick a face, edge or corner first';
    canvasContext.fillStyle = '#fff';
    canvasContext.textAlign = 'center';
    canvasContext.textBaseline = 'middle';
    canvasContext.font = `600 ${text.length > 16 ? 30 : 38}px ${FONT}`;
    wrap(canvasContext, text, 384, 384, 230, 42);
    this.board.show();
  }
}

/** Text in at most two lines, centred on (x, y). */
function wrap(canvasContext: CanvasRenderingContext2D, text: string, x: number, y: number, max: number, lh: number): void {
  const lines: string[] = [];
  let cur = '';
  for (const word of text.split(' ')) {
    const next = cur ? `${cur} ${word}` : word;
    if (canvasContext.measureText(next).width > max && cur) {
      lines.push(cur);
      cur = word;
    } else {
      cur = next;
    }
  }
  if (cur) {
    lines.push(cur);
  }
  const shown = lines.slice(0, 2);
  shown.forEach((line, i) => canvasContext.fillText(line, x, y + (i - (shown.length - 1) / 2) * lh));
}


/**
 * The model's scale as a moving tape: real size (1:1) is the zero, each mark
 * up is twice as big (2:1, 4:1), each mark down half (1:2, 1:4). The tape
 * slides under a fixed pointer; the number on top is the scale now.
 */
class Tape {
  readonly board = new Board(300, 560, 0.06);
  private key = '';
  draw(ratio: number): void {
    const logRatio = Math.log2(Math.max(1e-6, ratio));
    const key = `${ratioText(ratio)}|${logRatio.toFixed(2)}`;
    if (key === this.key) {
      return;
    }
    this.key = key;
    const canvasContext = this.board.clear();
    canvasContext.fillStyle = GLASS;
    canvasContext.beginPath();
    canvasContext.roundRect(4, 4, 292, 552, 48);
    canvasContext.fill();
    canvasContext.strokeStyle = LINE;
    canvasContext.lineWidth = 3;
    canvasContext.stroke();
    // The number now.
    canvasContext.textAlign = 'center';
    canvasContext.textBaseline = 'middle';
    canvasContext.fillStyle = '#fff';
    canvasContext.font = `600 64px ${FONT}`;
    canvasContext.fillText(ratioText(ratio), 150, 72);
    canvasContext.fillStyle = 'rgba(235,235,245,0.55)';
    canvasContext.font = `500 26px ${FONT}`;
    canvasContext.fillText(Math.abs(logRatio) < 0.005 ? 'real size' : logRatio > 0 ? 'bigger' : 'smaller', 150, 122);
    // The tape: one mark a doubling, 80 px apart, the pointer in the middle of the window.
    const top = 156;
    const bottom = 540;
    const mid = (top + bottom) / 2;
    const step = 80;
    canvasContext.save();
    canvasContext.beginPath();
    canvasContext.rect(0, top, 300, bottom - top);
    canvasContext.clip();
    for (let tick = Math.floor(logRatio) - 3; tick <= Math.ceil(logRatio) + 3; tick++) {
      for (const half of [0, 0.5]) {
        const y = mid - (tick + half - logRatio) * step;
        if (y < top - 20 || y > bottom + 20) {
          continue;
        }
        const zero = tick === 0 && !half;
        canvasContext.strokeStyle = zero ? ACCENT : half ? 'rgba(255,255,255,0.25)' : 'rgba(255,255,255,0.6)';
        canvasContext.lineWidth = zero ? 5 : 3;
        canvasContext.beginPath();
        canvasContext.moveTo(40, y);
        canvasContext.lineTo(half ? 72 : 96, y);
        canvasContext.stroke();
        if (half) {
          continue;
        }
        canvasContext.textAlign = 'left';
        canvasContext.fillStyle = zero ? ACCENT : 'rgba(235,235,245,0.8)';
        canvasContext.font = `${zero ? 700 : 500} 34px ${FONT}`;
        canvasContext.fillText(tick >= 0 ? `${2 ** tick}:1` : `1:${2 ** -tick}`, 116, y);
      }
    }
    canvasContext.restore();
    // The pointer: where the model is now.
    canvasContext.fillStyle = '#fff';
    canvasContext.beginPath();
    canvasContext.moveTo(12, mid - 14);
    canvasContext.lineTo(34, mid);
    canvasContext.lineTo(12, mid + 14);
    canvasContext.fill();
    canvasContext.strokeStyle = '#fff';
    canvasContext.lineWidth = 2;
    canvasContext.beginPath();
    canvasContext.moveTo(34, mid);
    canvasContext.lineTo(104, mid);
    canvasContext.stroke();
    this.board.show();
  }
  reset(): void {
    this.key = '';
  }
}

/** A scale as people write it: 1:1, 2:1, 1:4, 1:2.5 (a tenth when it's not whole, under ten). */
function ratioText(ratio: number): string {
  const one = (value: number) => (value >= 10 || Math.abs(value - Math.round(value)) < 0.05 ? String(Math.round(value)) : value.toFixed(1));

  return ratio >= 1 ? `${one(ratio)}:1` : `1:${one(1 / ratio)}`;
}

// --------------------------------------------------------------- the mode

/** One millimetre, in the room's metres: real size. */
const REAL = 0.001;

interface Hand {
  side: 'left' | 'right';
  ray: XRTargetRaySpace;
  line: Line;
  wheel: Wheel;
  squeezing: boolean;
  grabFrom: Matrix4 | null;
  /** Face buttons last frame: [A/X, B/Y]. */
  was: [boolean, boolean];
  heldSince: number;
  /** Where real surfaces are along this hand's ray (the headset's own room scan), when it offers that. */
  hits: XRHitTestSource | null;
  /** The controller the room scan was asked for. */
  asked: XRInputSource | null;
}

export class VRMode {
  private room = new Scene();
  /** Holds the page's scene: placed, turned and sized in the room. */
  private holder = new Group();
  private hands: Hand[] = [];
  private grabStart: Matrix4 | null = null;
  private pinch: { d0: number; s0: number; snapped: boolean } | null = null;
  private session: XRSession | null = null;
  private passthrough = false;
  private clear = { color: new Color(), alpha: 1 };
  /** Where the model would go: a ring on the table or floor the right hand points at. */
  private reticle = new Mesh(new RingGeometry(0.035, 0.045, 48).rotateX(-Math.PI / 2), new MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85, depthTest: false }));
  /** A soft shadow under the model while it stands on something. */
  private shadow = new Mesh(new PlaneGeometry(1, 1).rotateX(-Math.PI / 2), new MeshBasicMaterial({ map: shadowTexture(), transparent: true, depthWrite: false }));
  /** The card above the right hand: a short message. */
  private card = new Board(640, 200, 0.15);
  /** The scale above the left hand: 1:1 in the middle, bigger up, smaller down. */
  private tape = new Tape();
  /** The right stick stopped at real size: it sizes again once let go. */
  private stickHeld = false;
  private toast: { text: string; until: number } | null = null;
  private cardKey = '';
  /** The model's bottom middle, in the holder's own (y up, millimetres) coordinates. */
  private base = new Vector3();
  /** The model's size (millimetres, its longest diagonal). */
  private size = 100;
  private glide: { from: Vector3; to: Vector3; qFrom: Quaternion; qTo: Quaternion; t0: number } | null = null;
  private placed = false;
  private needsFirstPlace = true;
  /** A phone or tablet: taps and pinches on the screen, no controllers. */
  private handheld = false;
  /** Where real surfaces are straight ahead of the phone (the middle of its screen). */
  private viewerHits: XRHitTestSource | null = null;
  /** On the phone: the page's own layer over the camera (Exit, the hint, the scale). */
  private overlay: HTMLDivElement | null = null;
  private hint: HTMLDivElement | null = null;
  /** Two fingers down: where they started (to size and turn from). */
  private two: { d0: number; a0: number; s0: number; q0: Quaternion; base: Vector3 } | null = null;
  /** Two fingers were down during this touch: lifting them doesn't move the model. */
  private pinchUsed = false;
  private onTap = (e: Event) => this.phoneTap(e as XRInputSourceEvent);
  private last = 0;

  constructor(private host: XRHost) {
    this.room.add(this.holder, this.reticle);
    this.reticle.visible = false;
    this.reticle.renderOrder = 30;
    this.shadow.renderOrder = -1;
    this.card.mesh.visible = false;
  }

  get active(): boolean {
    return !!this.session;
  }

  /** Pictures of the wheel (the stick on button `hot`) and of the card saying `text`, as the headset shows them (to check their look). */
  snapshot(hot = -1, text = 'X-Ray', ratio = 1): { wheel: string; card: string; tape: string } {
    const wheel = new Wheel();
    wheel.items = this.items();
    wheel.title = 'View';
    wheel.hot = hot;
    wheel.draw();
    this.say(text);
    this.cardKey = '';
    this.drawCard();
    this.toast = null;
    this.cardKey = '';
    const t = new Tape();
    t.draw(ratio);

    return { wheel: wheel.board.context.canvas.toDataURL(), card: this.card.context.canvas.toDataURL(), tape: t.board.context.canvas.toDataURL() };
  }

  async enter(): Promise<void> {
    const xr = xrSystem();
    if (!xr || this.session) {
      return;
    }
    // Passthrough first (the model in your real room), else a plain dark room.
    let session: XRSession | null = null;
    this.passthrough = false;
    this.handheld = this.host.handheld;
    if (this.handheld) {
      this.makeOverlay();
    }
    try {
      if (await xr.isSessionSupported('immersive-ar')) {
        session = await xr.requestSession(
          'immersive-ar',
          this.handheld ? { optionalFeatures: ['local-floor', 'hit-test', 'dom-overlay'], domOverlay: { root: this.overlay } } : { optionalFeatures: ['local-floor', 'hit-test'] }
        );
        this.passthrough = true;
      }
    } catch {
      session = null;
    }
    if (!session && this.handheld) {
      this.dropOverlay();
      throw new Error("this browser can't show AR");
    }
    if (!session) {
      session = await xr.requestSession('immersive-vr', { optionalFeatures: ['local-floor'] });
    }
    const { renderer, scene } = this.host;
    renderer.xr.enabled = true;
    renderer.xr.setReferenceSpaceType('local-floor');
    try {
      await renderer.xr.setSession(session);
    } catch (err) {
      renderer.xr.enabled = false;
      this.dropOverlay();
      void session.end().catch(() => {});
      throw err;
    }
    this.session = session;
    renderer.getClearColor(this.clear.color);
    this.clear.alpha = renderer.getClearAlpha();
    if (this.passthrough) {
      this.room.background = null;
      renderer.setClearColor(0x000000, 0);
    } else {
      this.room.background = scene.background instanceof Color ? scene.background.clone() : new Color(0x2b2d31);
    }
    // The page's scene is z up in millimetres; the room is y up in metres.
    this.holder.add(scene, this.shadow);
    scene.rotation.set(-Math.PI / 2, 0, 0);
    this.measure();
    // Real size, unless it's bigger than a room (then about half a metre).
    this.holder.scale.setScalar(this.size * REAL > 2.5 ? 0.5 / this.size : REAL);
    this.holder.quaternion.identity();
    this.holder.position.set(0, -100, 0);
    this.placed = false;
    // A headset: the model waits in front of you. A phone: it shows once you tap where it goes.
    this.needsFirstPlace = !this.handheld;
    this.holder.visible = !this.handheld;
    this.host.onEnter();
    if (this.handheld) {
      this.startPhone(session);
    } else {
      for (const i of [0, 1]) {
        this.addHand(i);
      }
    }
    session.addEventListener('end', () => this.leave());
    this.last = 0;
    renderer.setAnimationLoop((t: number, frame?: XRFrame) => this.frame(t, frame));
  }

  exit(): void {
    void this.session?.end();
  }

  private get real(): boolean {
    return Math.abs(this.holder.scale.x / REAL - 1) < 1e-3;
  }

  /** The wheel's buttons. */
  private items(): VRItem[] {
    const looks = this.host.looks();

    return [
      { label: 'Real size', icon: 'ruler', disabled: this.real, run: () => this.resize(REAL) },
      { label: 'Hand size', icon: 'scale', run: () => this.resize(0.25 / this.size) },
      { label: 'Bring here', icon: 'fit', run: () => this.bringHere() },
      { label: looks.xray, icon: 'display', run: () => this.say(this.host.xray()) },
      { label: looks.edges, icon: looks.edges.startsWith('Hide') ? 'eyeOff' : 'eye', run: () => this.say(this.host.edges()) },
      { label: 'Exit', icon: 'exit', run: () => this.exit() }
    ];
  }

  /** The model's bottom middle and size, from what's shown now. */
  private measure(): void {
    const b = this.host.bounds();
    const min = b?.min ?? [-50, -50, 0];
    const max = b?.max ?? [50, 50, 100];
    this.size = Math.max(1, Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]));
    // z up (the page) to y up (the room): (x, y, z) -> (x, z, -y).
    this.base.set((min[0] + max[0]) / 2, min[2], -(min[1] + max[1]) / 2);
    this.shadow.scale.set(Math.max(1, (max[0] - min[0]) * 1.5), 1, Math.max(1, (max[1] - min[1]) * 1.5));
    this.shadow.position.set(this.base.x, this.base.y + 0.2, this.base.z);
  }

  /** Where the model's bottom middle is in the room. */
  private baseInRoom(): Vector3 {
    this.holder.updateMatrix();

    return this.base.clone().applyMatrix4(this.holder.matrix);
  }

  /** Stand the model upright with its bottom middle at `at`, its front toward `face` (gliding there). */
  private putAt(at: Vector3, face: Vector3, glide = true): void {
    const yaw = Math.atan2(face.x - at.x, face.z - at.z);
    const q = new Quaternion().setFromEuler(new Euler(0, yaw, 0));
    const scale = this.holder.scale.x;
    const to = at.clone().sub(this.base.clone().multiplyScalar(scale).applyQuaternion(q));
    if (glide) {
      this.glide = { from: this.holder.position.clone(), to, qFrom: this.holder.quaternion.clone(), qTo: q, t0: performance.now() };
    } else {
      this.glide = null;
      this.holder.position.copy(to);
      this.holder.quaternion.copy(q);
    }
  }

  /** In front of you: at table height if it's small, on the floor if it's big. */
  private bringHere(glide = true): void {
    const cam = this.host.renderer.xr.getCamera();
    const head = new Vector3().setFromMatrixPosition(cam.matrixWorld);
    const look = new Vector3(0, 0, -1).applyQuaternion(new Quaternion().setFromRotationMatrix(cam.matrixWorld));
    look.y = 0;
    if (look.lengthSq() < 1e-6) {
      look.set(0, 0, -1);
    }
    look.normalize();
    const big = this.size * this.holder.scale.x;
    const at = head.clone().addScaledVector(look, Math.max(0.55, 0.35 + big * 0.7));
    at.y = big > 0.9 ? 0 : Math.max(0, head.y - 0.55);
    this.putAt(at, head, glide);
    this.placed = at.y === 0;
  }

  /** A new size, keeping the model's bottom middle where it is. */
  private resize(scale: number, say?: string): void {
    const keep = this.baseInRoom();
    this.holder.scale.setScalar(scale);
    this.holder.position.add(keep.sub(this.baseInRoom()));
    if (this.glide) {
      this.glide = null;
    }
    if (say) {
      this.say(say);
    }
  }

  private addHand(i: number): void {
    const ray = this.host.renderer.xr.getController(i);
    const line = new Line(new BufferGeometry().setFromPoints([new Vector3(0, 0, 0), new Vector3(0, 0, -1)]), new LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.45 }));
    line.scale.z = 2;
    ray.add(line);
    const wheel = new Wheel();
    ray.add(wheel.board.mesh);
    this.room.add(ray);
    const hand: Hand = { side: i === 0 ? 'right' : 'left', ray, line, wheel, squeezing: false, grabFrom: null, was: [false, false], heldSince: 0, hits: null, asked: null };
    // The card rides above the right hand, the scale above the left (which hand is which comes with the controller).
    const placeCard = () => {
      if (hand.side === 'right') {
        ray.add(this.card.mesh);
        this.card.mesh.position.set(0, 0.06, -0.1);
        this.card.mesh.rotation.x = -0.6;
      } else {
        ray.add(this.tape.board.mesh);
        this.tape.board.mesh.position.set(0, 0.06, -0.07);
        this.tape.board.mesh.rotation.x = -0.6;
      }
    };
    ray.addEventListener('connected', (e) => {
      const src = (e as unknown as { data?: XRInputSource }).data;
      if (src?.handedness === 'left' || src?.handedness === 'right') {
        hand.side = src.handedness;
      }
      placeCard();
    });
    ray.addEventListener('disconnected', () => {
      hand.hits?.cancel();
      hand.hits = null;
      hand.asked = null;
    });
    placeCard();
    this.hands.push(hand);
    ray.addEventListener('selectstart', () => this.trigger(hand));
    ray.addEventListener('squeezestart', () => {
      hand.squeezing = true;
      this.startGrab();
    });
    ray.addEventListener('squeezeend', () => {
      hand.squeezing = false;
      this.startGrab();
    });
  }

  /** The trigger: a button of the open wheel, else put the model down where the ring is. */
  private trigger(hand: Hand): void {
    for (const other of this.hands) {
      if (other === hand || !other.wheel.open) {
        continue;
      }
      const slot = this.wheelUnderRay(hand, other.wheel);
      if (slot >= 0) {
        other.wheel.board.mesh.visible = false;
        this.run(other.wheel.items[slot]);

        return;
      }
    }
    if (hand.side !== 'right' || !this.reticle.visible) {
      return;
    }
    const head = new Vector3().setFromMatrixPosition(this.host.renderer.xr.getCamera().matrixWorld);
    this.putAt(this.reticle.position.clone(), head);
    this.placed = true;
    this.buzz(hand, 0.4, 30);
  }

  /** Where a hand's ray meets a wheel: the button there, or -1. */
  private wheelUnderRay(hand: Hand, wheel: Wheel): number {
    const { o, d } = this.rayOf(hand);
    const mesh = wheel.board.mesh;
    mesh.updateMatrixWorld();
    const normal = new Vector3(0, 0, 1).applyQuaternion(mesh.getWorldQuaternion(new Quaternion()));
    const center = new Vector3().setFromMatrixPosition(mesh.matrixWorld);
    const den = normal.dot(d);
    if (Math.abs(den) < 1e-6) {
      return -1;
    }
    const t = center.clone().sub(o).dot(normal) / den;
    if (t < 0) {
      return -1;
    }
    const local = o.clone().addScaledVector(d, t).applyMatrix4(mesh.matrixWorld.clone().invert());
    const half = wheel.board.w / 2;

    return wheel.slotAtPoint(local.x / half, local.y / half);
  }

  private run(item: VRItem | undefined): void {
    if (item && !item.disabled) {
      item.run();
    }
  }

  private startGrab(): void {
    const held = this.hands.filter(hand => hand.squeezing);
    this.glide = null;
    this.holder.updateMatrix();
    this.grabStart = this.holder.matrix.clone();
    for (const hand of this.hands) {
      hand.grabFrom = hand.squeezing ? hand.ray.matrixWorld.clone() : null;
    }
    this.pinch = held.length === 2 ? { d0: held[0].ray.position.distanceTo(held[1].ray.position), s0: this.holder.scale.x, snapped: false } : null;
    if (held.length) {
      this.placed = false;
    }
  }

  private rayOf(hand: Hand): { o: Vector3; d: Vector3 } {
    hand.ray.updateMatrixWorld();
    const origin = new Vector3().setFromMatrixPosition(hand.ray.matrixWorld);
    const direction = new Vector3(0, 0, -1).applyQuaternion(new Quaternion().setFromRotationMatrix(hand.ray.matrixWorld)).normalize();

    return { o: origin, d: direction };
  }

  private buzz(hand: Hand, strength: number, ms: number): void {
    const src = [...(this.session?.inputSources ?? [])].find(source => source.handedness === hand.side);
    const act = (src?.gamepad as (Gamepad & { hapticActuators?: { pulse(v: number, ms: number): void }[] }) | undefined)?.hapticActuators?.[0];
    act?.pulse(strength, ms);
  }

  private say(text: string): void {
    if (text) {
      this.toast = { text, until: performance.now() + 1500 };
    }
  }

  private frame(t: number, frame?: XRFrame): void {
    const dt = this.last ? Math.min(0.1, (t - this.last) / 1000) : 0;
    this.last = t;
    // The first frame knows where your head is: the model goes in front of you.
    if (this.needsFirstPlace && frame) {
      const space = this.host.renderer.xr.getReferenceSpace();
      const pose = space ? frame.getViewerPose(space) : null;
      if (pose) {
        const cam = this.host.renderer.xr.getCamera();
        cam.matrixWorld.fromArray(pose.transform.matrix);
        this.bringHere(false);
        this.needsFirstPlace = false;
      }
    }
    if (this.glide) {
      const progress = Math.min(1, (performance.now() - this.glide.t0) / 260);
      const e = 1 - Math.pow(1 - progress, 3);
      this.holder.position.lerpVectors(this.glide.from, this.glide.to, e);
      this.holder.quaternion.slerpQuaternions(this.glide.qFrom, this.glide.qTo, e);
      if (progress >= 1) {
        this.glide = null;
      }
    }
    const held = this.hands.filter(hand => hand.squeezing);
    if (held.length === 1 && this.grabStart && held[0].grabFrom) {
      const matrix = held[0].ray.matrixWorld.clone().multiply(held[0].grabFrom.clone().invert()).multiply(this.grabStart);
      matrix.decompose(this.holder.position, this.holder.quaternion, this.holder.scale);
    } else if (held.length === 2 && this.pinch && this.pinch.d0 > 1e-3) {
      const distance = held[0].ray.position.distanceTo(held[1].ray.position);
      let scale = this.pinch.s0 * (distance / this.pinch.d0);
      // Real size holds for a moment on the way (a little click in the hands).
      const near = Math.abs(scale / REAL - 1) < 0.07;
      if (near) {
        scale = REAL;
      }
      if (near && !this.pinch.snapped) {
        for (const hand of held) {
          this.buzz(hand, 0.5, 30);
        }
      }
      this.pinch.snapped = near;
      if (scale !== this.holder.scale.x) {
        this.resize(scale);
      }
    }
    for (const src of this.session?.inputSources ?? []) {
      const hand = this.hands.find(hand => hand.side === src.handedness);
      if (!hand) {
        continue;
      }
      if (hand.asked !== src) {
        this.askScan(hand, src);
      }
      if (src.gamepad) {
        this.buttons(hand, src.gamepad, t, dt);
      }
    }
    if (this.handheld && frame) {
      this.touch(frame);
    }
    this.aim(frame);
    this.shadow.visible = this.placed && !held.length;
    this.drawCard();
    this.tape.draw(this.holder.scale.x / REAL);
    this.host.beforeFrame();
    this.host.renderer.render(this.room, this.host.renderer.xr.getCamera());
  }

  /** The headset's own scan of the room (tables, floor) along this hand's ray, when it offers that. */
  private askScan(hand: Hand, src: XRInputSource): void {
    hand.asked = src;
    const session = this.session as (XRSession & { requestHitTestSource?(o: { space: XRSpace }): Promise<XRHitTestSource> | undefined }) | null;
    session?.requestHitTestSource?.({ space: src.targetRaySpace })
      ?.then((hitSource) => {
        if (hand.asked !== src || !this.session) {
          return void hitSource.cancel();
        }
        hand.hits?.cancel();
        hand.hits = hitSource;
      })
      .catch(() => {});
  }

  /** One hand's buttons and stick this frame. */
  private buttons(hand: Hand, pad: Gamepad, t: number, dt: number): void {
    const sx = pad.axes[2] ?? 0;
    const sy = pad.axes[3] ?? 0;
    const ax = !!pad.buttons[4]?.pressed;
    const by = !!pad.buttons[5]?.pressed;
    if (hand.side === 'left') {
      // X held: the wheel opens; the stick chooses; letting go runs it. A tap: bring it here.
      if (ax && !hand.was[0]) {
        hand.heldSince = t;
      }
      if (ax && !hand.wheel.open && t - hand.heldSince > 140) {
        hand.wheel.items = this.items();
        hand.wheel.title = 'View';
        hand.wheel.hot = -1;
        hand.wheel.board.mesh.visible = true;
        this.tape.board.mesh.visible = false;
        hand.wheel.draw();
      }
      if (hand.wheel.open && ax) {
        const slot = hand.wheel.slotAt(sx, sy);
        if (slot !== hand.wheel.hot) {
          hand.wheel.hot = slot;
          hand.wheel.draw();
          if (slot >= 0) {
            this.buzz(hand, 0.2, 12);
          }
        }
      }
      if (!ax && hand.was[0]) {
        const item = hand.wheel.open ? hand.wheel.items[hand.wheel.hot] : undefined;
        hand.wheel.board.mesh.visible = false;
        this.tape.board.mesh.visible = true;
        if (item) {
          this.run(item);
        } else if (t - hand.heldSince < 300) {
          this.bringHere();
        }
      }
      // Y: X-Ray on / off.
      if (by && !hand.was[1]) {
        this.say(this.host.xray());
      }
      if (!hand.wheel.open && Math.abs(sy) > 0.15) {
        this.glide = null;
        this.holder.position.y -= sy * 0.5 * dt;
        this.placed = false;
      }
    } else {
      // A: real size or hand size. B: back in front of you.
      if (ax && !hand.was[0]) {
        this.resize(this.real ? 0.25 / this.size : REAL);
      }
      if (by && !hand.was[1]) {
        this.bringHere();
      }
      // Stick: left / right turns it about its middle, up / down sizes it.
      if (Math.abs(sx) > 0.2 && Math.abs(sx) > Math.abs(sy)) {
        this.glide = null;
        const keep = this.baseInRoom();
        this.holder.quaternion.premultiply(new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), -sx * 1.6 * dt));
        this.holder.position.add(keep.sub(this.baseInRoom()));
      } else if (Math.abs(sy) > 0.2 && !this.stickHeld) {
        // Up: bigger, down: smaller; it stops at real size on the way (let go and push again to go on).
        const scale = this.holder.scale.x;
        let next = scale * Math.pow(2, -sy * dt);
        if (!this.real && (scale - REAL) * (next - REAL) <= 0) {
          next = REAL;
          this.stickHeld = true;
          this.buzz(hand, 0.5, 30);
        }
        this.resize(next);
      } else if (Math.abs(sy) < 0.15) {
        this.stickHeld = false;
      }
    }
    hand.was = [ax, by];
  }

  /** The ring where the right hand points (a phone: the middle of its screen): a table or the floor (only things that face up). */
  private aim(frame?: XRFrame): void {
    let hand: Hand | undefined;
    let ray: { o: Vector3; d: Vector3 } | null;
    let hits: XRHitTestSource | null;
    if (this.handheld) {
      ray = this.viewerRay(frame);
      hits = this.viewerHits;
    } else {
      hand = this.hands.find(hand => hand.side === 'right');
      ray = hand ? this.rayOf(hand) : null;
      hits = hand?.hits ?? null;
    }
    if (!ray) {
      return;
    }
    const { o, d } = ray;
    let at: Vector3 | null = null;
    const space = this.host.renderer.xr.getReferenceSpace();
    if (frame && hits && space) {
      for (const hitTestResult of frame.getHitTestResults(hits)) {
        const pose = hitTestResult.getPose(space);
        if (!pose) {
          continue;
        }
        const q = pose.transform.orientation;
        const up = new Vector3(0, 1, 0).applyQuaternion(new Quaternion(q.x, q.y, q.z, q.w));
        if (up.y < 0.8) {
          continue;
        }
        const position = pose.transform.position;
        at = new Vector3(position.x, position.y, position.z);
        break;
      }
    }
    // No room scan (or none there yet): the floor.
    if (!at && d.y < -0.05) {
      at = o.clone().addScaledVector(d, -o.y / d.y);
    }
    if (at && at.distanceTo(o) > 8) {
      at = null;
    }
    this.reticle.visible = !!at && !this.two && !this.hands.some(hand => hand.wheel.open || hand.squeezing);
    if (at) {
      this.reticle.position.set(at.x, at.y + 0.002, at.z);
    }
    if (hand) {
      hand.line.scale.z = at ? Math.max(0.02, at.distanceTo(o)) : 2;
    }
  }

  // ------------------------------------------------------------ phone, tablet

  private startPhone(session: XRSession): void {
    session.addEventListener('select', this.onTap);
    const hitSession = session as XRSession & { requestHitTestSource?(o: { space: XRSpace }): Promise<XRHitTestSource> | undefined };
    session
      .requestReferenceSpace('viewer')
      .then(space => hitSession.requestHitTestSource?.({ space }))
      .then((hitSource) => {
        if (!hitSource) {
          return;
        }
        if (this.session !== session) {
          hitSource.cancel();
        } else {
          this.viewerHits = hitSource;
        }
      })
      .catch(() => {});
    // Without the page's layer over the camera, the scale floats at the lower left instead.
    if (!(session as XRSession & { domOverlayState?: unknown }).domOverlayState) {
      this.room.add(this.tape.board.mesh);
    }
    this.setHint('Point at the floor or a table, then tap');
  }

  /** Where the phone looks: its position and straight ahead. */
  private viewerRay(frame?: XRFrame): { o: Vector3; d: Vector3; q: Quaternion } | null {
    const space = this.host.renderer.xr.getReferenceSpace();
    const pose = frame && space ? frame.getViewerPose(space) : null;
    if (!pose) {
      return null;
    }
    const position = pose.transform.position;
    const orientation = pose.transform.orientation;
    const q = new Quaternion(orientation.x, orientation.y, orientation.z, orientation.w);

    return { o: new Vector3(position.x, position.y, position.z), d: new Vector3(0, 0, -1).applyQuaternion(q), q };
  }

  /** A tap on the screen: the model goes where the ring is (not after a pinch). */
  private phoneTap(e: XRInputSourceEvent): void {
    if (e.inputSource.targetRayMode !== 'screen' || this.pinchUsed || !this.reticle.visible) {
      return;
    }
    const head = new Vector3().setFromMatrixPosition(this.host.renderer.xr.getCamera().matrixWorld);
    this.putAt(this.reticle.position.clone(), head, this.holder.visible);
    this.holder.visible = true;
    this.placed = true;
    this.setHint('Pinch to size it, twist to turn it, tap to move it');
  }

  /** Fingers on the screen: two of them size the model (pinch) and turn it (twist) about its foot. */
  private touch(frame: XRFrame): void {
    const space = this.host.renderer.xr.getReferenceSpace();
    const view = this.viewerRay(frame);
    if (!space || !view) {
      return;
    }
    // The 3D scale (no page layer): low on the left, facing you.
    if (this.tape.board.mesh.parent === this.room) {
      this.tape.board.mesh.position.copy(view.o).add(new Vector3(-0.07, -0.1, -0.35).applyQuaternion(view.q));
      this.tape.board.mesh.quaternion.copy(view.q);
    }
    const back = view.q.clone().invert();
    const pts: [number, number][] = [];
    for (const src of this.session?.inputSources ?? []) {
      if (src.targetRayMode !== 'screen') {
        continue;
      }
      const pose = frame.getPose(src.targetRaySpace, space);
      if (!pose) {
        continue;
      }
      const orientation = pose.transform.orientation;
      const direction = new Vector3(0, 0, -1).applyQuaternion(new Quaternion(orientation.x, orientation.y, orientation.z, orientation.w)).applyQuaternion(back);
      if (direction.z < -1e-3) {
        pts.push([direction.x / -direction.z, direction.y / -direction.z]);
      }
    }
    if (!pts.length) {
      this.pinchUsed = false;
    }
    if (pts.length < 2 || !this.holder.visible) {
      this.two = null;

      return;
    }
    const [a, b] = pts;
    const dist = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
    if (!this.two) {
      this.glide = null;
      this.two = { d0: Math.max(1e-4, dist), a0: ang, s0: this.holder.scale.x, q0: this.holder.quaternion.clone(), base: this.baseInRoom() };
      this.pinchUsed = true;

      return;
    }
    let scale = (this.two.s0 * dist) / this.two.d0;
    // Real size holds for a moment on the way.
    if (Math.abs(scale / REAL - 1) < 0.07) {
      scale = REAL;
    }
    let da = ang - this.two.a0;
    da = Math.atan2(Math.sin(da), Math.cos(da));
    this.holder.scale.setScalar(scale);
    this.holder.quaternion.setFromAxisAngle(new Vector3(0, 1, 0), da).multiply(this.two.q0);
    this.holder.position.add(this.two.base.clone().sub(this.baseInRoom()));
  }

  /** The phone's layer over the camera: Exit at the top, the hint at the bottom, the scale at the left. */
  private makeOverlay(): void {
    this.dropOverlay();
    const glass = 'background:rgba(28,28,30,0.72);-webkit-backdrop-filter:blur(20px);backdrop-filter:blur(20px);border:1px solid rgba(255,255,255,0.14);color:#fff;border-radius:999px';
    const root = document.createElement('div');
    root.style.cssText = `position:fixed;inset:0;pointer-events:none;font:500 15px ${FONT};z-index:1000`;
    const exit = document.createElement('button');
    exit.textContent = 'Exit AR';
    exit.style.cssText = `position:absolute;top:calc(env(safe-area-inset-top, 0px) + 16px);right:16px;pointer-events:auto;${glass};font:600 15px ${FONT};padding:10px 18px`;
    // A tap on Exit isn't a tap in the room.
    exit.addEventListener('beforexrselect', e => e.preventDefault());
    exit.addEventListener('click', () => this.exit());
    const hint = document.createElement('div');
    hint.style.cssText = `position:absolute;left:50%;bottom:calc(env(safe-area-inset-bottom, 0px) + 24px);transform:translateX(-50%);${glass};padding:10px 18px;white-space:nowrap`;
    const tape = this.tape.board.context.canvas;
    tape.style.cssText = 'position:absolute;left:16px;top:50%;transform:translateY(-50%);width:84px;height:auto';
    root.append(exit, hint, tape);
    document.body.append(root);
    this.overlay = root;
    this.hint = hint;
  }

  private dropOverlay(): void {
    this.overlay?.remove();
    this.overlay = null;
    this.hint = null;
  }

  private setHint(text: string): void {
    if (this.hint && this.hint.textContent !== text) {
      this.hint.textContent = text;
    }
  }

  /** The card: a short message for a moment. */
  private drawCard(): void {
    const toast = this.toast && performance.now() < this.toast.until ? this.toast.text : '';
    if (toast === this.cardKey) {
      return;
    }
    this.cardKey = toast;
    this.card.mesh.visible = !!toast;
    if (!toast) {
      return;
    }
    const canvasContext = this.card.clear();
    canvasContext.fillStyle = GLASS;
    canvasContext.beginPath();
    canvasContext.roundRect(4, 4, 632, 192, 44);
    canvasContext.fill();
    canvasContext.strokeStyle = LINE;
    canvasContext.lineWidth = 3;
    canvasContext.stroke();
    canvasContext.textAlign = 'center';
    canvasContext.textBaseline = 'middle';
    canvasContext.fillStyle = '#fff';
    canvasContext.font = `600 52px ${FONT}`;
    wrap(canvasContext, toast, 320, 100, 560, 58);
    this.card.show();
  }

  private leave(): void {
    const { renderer, scene } = this.host;
    renderer.setAnimationLoop(null);
    renderer.xr.enabled = false;
    renderer.setClearColor(this.clear.color, this.clear.alpha);
    for (const hand of this.hands) {
      hand.hits?.cancel();
      hand.asked = null;
      hand.ray.removeFromParent();
      hand.line.geometry.dispose();
    }
    this.hands = [];
    this.grabStart = null;
    this.pinch = null;
    this.glide = null;
    this.toast = null;
    this.cardKey = '';
    this.card.mesh.removeFromParent();
    this.tape.board.mesh.removeFromParent();
    this.tape.reset();
    this.session?.removeEventListener('select', this.onTap);
    this.viewerHits?.cancel();
    this.viewerHits = null;
    this.two = null;
    this.pinchUsed = false;
    this.holder.visible = true;
    this.dropOverlay();
    this.stickHeld = false;
    this.shadow.removeFromParent();
    scene.removeFromParent();
    scene.rotation.set(0, 0, 0);
    scene.updateMatrixWorld(true);
    this.session = null;
    this.host.onExit();
  }
}

/** A soft round shadow (dark in the middle, gone at the edge). */
function shadowTexture(): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 128;
  const canvasContext = canvas.getContext('2d')!;
  const gradient = canvasContext.createRadialGradient(64, 64, 0, 64, 64, 64);
  gradient.addColorStop(0, 'rgba(0,0,0,0.42)');
  gradient.addColorStop(0.55, 'rgba(0,0,0,0.22)');
  gradient.addColorStop(1, 'rgba(0,0,0,0)');
  canvasContext.fillStyle = gradient;
  canvasContext.fillRect(0, 0, 128, 128);

  return new CanvasTexture(canvas);
}
