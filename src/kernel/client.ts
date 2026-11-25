import type { Feature } from '../doc/types';
import type { BodyHealth, BodyMesh, BodyProps, ProjectedView, ViewSpec, Envelope, ExportFormat, RegenResult, Request, Response } from './protocol';

/**
 * The steps as the engine needs them: a reference image without its picture
 * (megabytes the engine never reads, copied across and hashed on every rebuild
 * - every step of a drag). The same for every kind of call, so the engine sees
 * the same steps each time.
 */
function lean(features: Feature[]): Feature[] {
  return features.some(feature => feature.type === 'image' && feature.src) ? features.map(feature => (feature.type === 'image' ? { ...feature, src: '' } : feature)) : features;
}

/** Promise-based wrapper around the kernel worker. */
export class KernelClient {
  private worker!: Worker;
  private nextId = 1;
  private pending = new Map<number, (r: Response) => void>();
  ready!: Promise<void>;
  /** The features the running regeneration is for (null when idle). */
  running: Feature[] | null = null;

  // Coalesce regenerations: while one runs, only the most recent request waits.
  private regenRunning = false;
  private regenQueued: { features: Feature[]; saved: boolean; resolve: (r: RegenResult | null) => void } | null = null;
  /** The last answer's meshes by key: the worker sends a mesh once, then just its key. */
  private meshes = new Map<number, BodyMesh>();

  /**
   * The engine (OpenCascade) never hands memory back, and some of its
   * operations leak (a union with a freeform body: ~10 MB each time). Past
   * this much a spare engine is started, brought up to date in the
   * background, and swapped in while nothing is running - a phone would
   * otherwise run out after a while of editing.
   */
  static RECYCLE_MB = 500;
  private last: { features: Feature[]; saved: Feature[] | null } = { features: [], saved: null };
  /**
   * Some steps cost the engine tens of MB each time they are rebuilt (memory
   * it never gets back): dragging one of their sizes, a rebuild per move,
   * would fill it in seconds. After a rebuild seen to cost a lot, the next
   * previews wait a moment - fewer of them, the drag's last one always shown.
   */
  private memoryMB = 0;
  /** What the last few rebuilds cost, each (MB; the engine's memory grows in jumps, so one rebuild's own cost says little). */
  private costMB = 0;
  private restUntil = 0;
  /** How long previews rest after a rebuild that cost `mb` of the engine's memory (ms). */
  static restFor(mb: number): number {
    return mb < 4 ? 0 : Math.min(400, mb * 8);
  }
  private spare: { worker: Worker; bodies: BodyMesh[] | null } | null = null;

  constructor() {
    this.start();
  }

  private handler = (e: MessageEvent<Envelope<Response>>) => {
    const cb = this.pending.get(e.data.id);
    this.pending.delete(e.data.id);
    cb?.(e.data.msg);
  };

  private start(): void {
    // A fresh worker sends every mesh again.
    this.meshes = new Map();
    this.setWorker(new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' }));
    this.ready = this.call({ type: 'init' }).then((response) => {
      if (response.type === 'error') {
        throw new Error(response.message);
      }
    });
  }

  private setWorker(worker: Worker): void {
    this.worker = worker;
    worker.onmessage = this.handler;
    // Died without an answer (out of memory): whatever waits on it, "Working…" too, would wait for ever.
    worker.onerror = (e) => {
      if (worker !== this.worker) {
        return;
      }
      console.error('[KernelClient] the geometry engine stopped, starting a fresh one:', e.message);
      this.stop();
      this.onLost?.();
    };
  }

  /** A spare engine, given the last saved project (and the last preview): it's ready to take over. */
  private warmSpare(): void {
    if (this.spare) {
      return;
    }
    const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    const spare: { worker: Worker; bodies: BodyMesh[] | null } = { worker, bodies: null };
    this.spare = spare;
    let count = 0;
    const waiting = new Map<number, (r: Response) => void>();
    worker.onmessage = (e: MessageEvent<Envelope<Response>>) => waiting.get(e.data.id)?.(e.data.msg);
    // Died while warming: dropped, so a later rebuild can warm another.
    worker.onerror = () => {
      worker.terminate();
      if (this.spare === spare) {
        this.spare = null;
      }
    };
    const ask = (msg: Request) =>
      new Promise<Response>((resolve) => {
        waiting.set(++count, resolve);
        worker.postMessage({ id: count, msg } satisfies Envelope<Request>);
      });
    const { features, saved } = this.last;
    (async () => {
      if ((await ask({ type: 'init' })).type !== 'ready') {
        throw new Error('init');
      }
      const got = new Map<number, BodyMesh>();
      const regen = async (fs: Feature[], asSaved: boolean) => {
        const response = await ask({ type: 'regenerate', features: lean(fs), saved: asSaved });
        if (response.type !== 'regenerated') {
          throw new Error('regenerate');
        }
        const bodies = response.result.bodies.map(b => ((b as { same?: boolean }).same ? got.get(b.key)! : b));
        for (const b of bodies) {
          got.set(b.key, b);
        }

        return bodies;
      };
      let bodies = saved ? await regen(saved, true) : [];
      if (!saved || features !== saved) {
        bodies = await regen(features, false);
      }
      if (this.spare !== spare) {
        throw new Error('stopped');
      }
      spare.bodies = bodies;
      this.swapIfIdle();
    })().catch(() => {
      worker.terminate();
      if (this.spare === spare) {
        this.spare = null;
      }
    });
  }

  /** The spare engine takes over, if it's ready and nothing is running. */
  private swapIfIdle(): void {
    const spare = this.spare;
    if (!spare?.bodies || this.regenRunning || this.pending.size) {
      return;
    }
    this.spare = null;
    this.worker.terminate();
    this.setWorker(spare.worker);
    this.ready = Promise.resolve();
    // It sends meshes it already sent (to us, while warming) as keys only.
    this.meshes = new Map(spare.bodies.map(b => [b.key, b]));
  }

  /**
   * Stop whatever the engine is working on (it can't be interrupted mid-way:
   * the worker is thrown away and a fresh one started). Waiting calls end empty.
   */
  stop(): void {
    this.spare?.worker.terminate();
    this.spare = null;
    this.worker.terminate();
    const waiting = [...this.pending.values()];
    this.pending.clear();
    this.regenQueued?.resolve(null);
    this.regenQueued = null;
    for (const cb of waiting) {
      cb({ type: 'error', message: 'Stopped' } as Response);
    }
    this.regenRunning = false;
    this.running = null;
    this.start();
    this.onBusy?.(false);
  }

  /** Told when the kernel starts and stops being busy (to show a busy indicator). */
  onBusy: ((busy: boolean) => void) | null = null;
  /** Told when the engine died and was started again (what was being made is not made). */
  onLost: (() => void) | null = null;
  /** Is anything being worked on, or waiting to be? (What the busy indicator is checked against.) */
  get busy(): boolean {
    return this.pending.size > 0 || this.regenRunning || !!this.regenQueued;
  }

  private call(msg: Request): Promise<Response> {
    const id = this.nextId++;
    if (this.pending.size === 0) {
      this.onBusy?.(true);
    }

    return new Promise((resolve) => {
      this.pending.set(id, (response) => {
        resolve(response);
        if (this.pending.size === 0 && !this.regenQueued) {
          this.onBusy?.(false);
        }
      });
      this.worker.postMessage({ id, msg } satisfies Envelope<Request>);
    });
  }

  /**
   * Rebuild geometry. If calls arrive faster than the kernel can answer, the
   * intermediate ones resolve with null (they were superseded).
   */
  regenerate(features: Feature[], saved = false): Promise<RegenResult | null> {
    return new Promise((resolve) => {
      if (this.regenRunning) {
        this.regenQueued?.resolve(null);
        this.regenQueued = { features, saved, resolve };

        return;
      }
      this.runRegen(features, saved, resolve);
    });
  }

  /** `saved`: the project as saved (not a tool's preview) - the engine keeps its steps for Cancel. */
  private async runRegen(features: Feature[], saved: boolean, resolve: (r: RegenResult | null) => void) {
    this.regenRunning = true;
    try {
      await this.ready;
    } catch (error) {
      console.error('[KernelClient.runRegen] the geometry engine did not start, nothing rebuilt:', error);
      this.regenRunning = false;
      this.regenQueued?.resolve(null);
      this.regenQueued = null;

      return resolve(null);
    }
    this.running = features;
    this.last = { features, saved: saved ? features : this.last.saved };
    const worker = this.worker;
    const response = await this.call({ type: 'regenerate', features: lean(features), saved });
    // Stopped meanwhile: the fresh worker has its own queue.
    if (worker !== this.worker) {
      return resolve(null);
    }
    this.running = null;
    resolve(response.type === 'regenerated' ? this.withMeshes(response.result) : null);
    if (response.type === 'error') {
      console.error(response.message);
    }
    if (response.type === 'regenerated' && response.result.memoryMB !== undefined) {
      // (A fresh engine starts small again: that isn't a rebuild giving memory back.)
      const cost = this.memoryMB ? Math.max(0, response.result.memoryMB - this.memoryMB) : 0;
      if (response.result.memoryMB < this.memoryMB) {
        this.costMB = 0;
      }
      this.memoryMB = response.result.memoryMB;
      this.costMB = this.costMB * 0.7 + cost * 0.3;
      this.restUntil = performance.now() + KernelClient.restFor(this.costMB);
    }
    // A preview waiting its turn rests first (whatever is asked meanwhile takes its place).
    const rest = this.restUntil - performance.now();
    if (this.regenQueued && !this.regenQueued.saved && rest > 0) {
      await new Promise(done => setTimeout(done, rest));
      if (worker !== this.worker) {
        return;
      }
    }
    this.regenRunning = false;
    // A big engine: a spare is got ready (also in the middle of a drag, where
    // it used to wait for the drag to end), and takes over between two rebuilds.
    if (response.type === 'regenerated' && (response.result.memoryMB ?? 0) > KernelClient.RECYCLE_MB) {
      this.warmSpare();
    }
    this.swapIfIdle();
    const q = this.regenQueued;
    this.regenQueued = null;
    if (q) {
      this.runRegen(q.features, q.saved, q.resolve);
    }
  }

  /** Meshes sent as their key only (unchanged bodies): the ones the page has. */
  private withMeshes(result: RegenResult): RegenResult {
    const bodies = result.bodies.map((b) => {
      if (!(b as { same?: boolean }).same) {
        return b;
      }
      const had = this.meshes.get(b.key)!;

      // (The same object when nothing about it changed: the view keeps what it drew.)
      return had.id === b.id && had.name === b.name ? had : { ...had, id: b.id, name: b.name };
    });
    this.meshes = new Map(bodies.map(b => [b.key, b]));

    return { ...result, bodies };
  }

  /** The bodies drawn in views, hidden lines found (for BIM drawings). */
  async drawing(features: Feature[], views: ViewSpec[], bodies?: string[]): Promise<ProjectedView[]> {
    await this.ready;
    const response = await this.call({ type: 'drawing', features: lean(features), views, bodies });
    if (response.type === 'drawing') {
      return response.views;
    }
    throw new Error(response.type === 'error' ? response.message : 'Could not draw the views');
  }

  /** Each body's volume, area, centre of mass and box (for BIM). */
  async properties(features: Feature[]): Promise<BodyProps[]> {
    await this.ready;
    const response = await this.call({ type: 'properties', features: lean(features) });
    if (response.type === 'properties') {
      return response.bodies;
    }
    throw new Error(response.type === 'error' ? response.message : 'Could not measure the bodies');
  }

  /** Each body's health: valid, closed, solids, faces, volume (the console's sg.health()). */
  async health(features: Feature[]): Promise<BodyHealth[]> {
    await this.ready;
    const response = await this.call({ type: 'health', features: lean(features) });
    if (response.type === 'health') {
      return response.bodies;
    }
    throw new Error(response.type === 'error' ? response.message : 'Could not check the bodies');
  }

  async export(features: Feature[], format: ExportFormat, bodies?: string[]): Promise<Blob> {
    await this.ready;
    const response = await this.call({ type: 'export', features: lean(features), format, bodies });
    if (response.type === 'exported') {
      return response.blob;
    }
    throw new Error(response.type === 'error' ? response.message : 'Export failed');
  }
}
