// Reference images: pictures to look at while modelling (a drawing, a photo
// of the part), each in a window over the model - under the buttons, the
// wheels and the panels, so moving it about never hides them. A window is dragged by
// its top bar or its picture, resized from its corner, minimized to its bar
// (then dragged by its tabs) and closed. More
// pictures in one window are tabs along its top; a tab dragged out of the bar
// becomes a window of its own, and dropped on another window's bar it joins it.
// They are kept on this device (not in the project) until closed.

import { render as mount } from 'preact';
import { idbGet, idbSet } from '../doc/store';
import { RefButton } from './components';
import { icons } from './icons';

interface Ref {
  name: string;
  src: string;
}

interface Win {
  host: HTMLElement;
  /** The window's parts, set once it is drawn. */
  root: HTMLElement;
  bar: HTMLElement;
  tabs: HTMLElement;
  body: HTMLElement;
  grip: HTMLElement;
  img: HTMLImageElement;
  refs: Ref[];
  active: number;
  x: number;
  y: number;
  w: number;
  h: number;
  min: boolean;
  /** Where it is among the others (higher: in front). */
  z: number;
  /** Another window's tab is over its bar. */
  isDropTarget: boolean;
  /** The tab being dragged out of it. */
  draggedTab: number | null;
  /** The picture shown now (a new one starts whole). */
  shownSrc: string | null;
  /** The picture zoomed in its window: how much, and moved how far from the middle (px). */
  zoom: { k: number; x: number; y: number };
  /** Fingers on the picture now (two pinch it: the window stops moving). */
  fingers: number;
}

interface Saved {
  x: number;
  y: number;
  w: number;
  h: number;
  min: boolean;
  active: number;
  refs: Ref[];
}

const KEY = 'sg-ref-images';
/** Big enough to read a drawing, small enough to keep (a phone photo is 4000 px). */
const MAX = 2048;
const BAR = 34;
const zOf = (floatingWindow: Win) => floatingWindow.z;
const MIN_W = 160;
/** As far as a picture zooms in its window. */
const MAX_ZOOM = 12;
const MIN_H = 120;

const clamp = (value: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, value));

interface RefWindowViewProps {
  win: Win;
  onFront: () => void;
  onAdd: () => void;
  onFold: () => void;
  onClose: () => void;
  onTabDown: (event: PointerEvent, index: number) => void;
}

function RefWindowView({ win, onFront, onAdd, onFold, onClose, onTabDown }: RefWindowViewProps) {
  const ref = win.refs[win.active];
  const zoom = win.zoom;
  const style = {
    left: `${Math.round(win.x)}px`,
    top: `${Math.round(win.y)}px`,
    '--z': String(win.z),
    // (Minimized: just as wide as its tabs and the three buttons.)
    width: win.min ? '' : `${Math.round(win.w)}px`,
    height: win.min ? '' : `${Math.round(win.h)}px`
  };
  const className = ['ref-win', win.min && 'min', win.refs.length === 1 && 'single', zoom.k > 1 && 'zoomed'].filter(Boolean).join(' ');

  return (
    <div ref={(element) => {
      if (element) {
        win.root = element; 
      } 
    }} class={className} style={style} onPointerDownCapture={onFront}>
      <div
        ref={(element) => {
          if (element) {
            win.bar = element; 
          } 
        }}
        class={`ref-bar${win.isDropTarget ? ' drop' : ''}`}
        // (A double click on the bar minimizes or restores it, as the button does.)
        onDblClick={event => !(event.target as HTMLElement).closest('button, .ref-tab') && onFold()}
      >
        <div ref={(element) => {
          if (element) {
            win.tabs = element; 
          } 
        }} class="ref-tabs">
          {win.refs.map((tab, index) => (
            <div key={index} class={`ref-tab${index === win.active ? ' on' : ''}${win.draggedTab === index ? ' dragged' : ''}`} title={tab.name} onPointerDown={event => onTabDown(event, index)}>
              {tab.name}
            </div>
          ))}
        </div>
        <RefButton html={icons.insert} title="Add a picture" onClick={onAdd} />
        <RefButton html={win.min ? icons.restore : icons.minimize} title={win.min ? 'Restore' : 'Minimize'} onClick={onFold} />
        <RefButton html={icons.close} title={win.refs.length > 1 ? 'Close this picture' : 'Close'} onClick={onClose} />
      </div>
      <div ref={(element) => {
        if (element) {
          win.body = element; 
        } 
      }} class="ref-body">
        <img
          ref={(element) => {
            if (element) {
              win.img = element; 
            } 
          }}
          src={ref?.src}
          draggable={false}
          alt=""
          style={{ transform: zoom.k === 1 ? '' : `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.k})` }}
        />
      </div>
      <div ref={(element) => {
        if (element) {
          win.grip = element; 
        } 
      }} class="ref-grip" />
    </div>
  );
}

export class RefImages {
  private wins: Win[] = [];
  /** The last window touched: a new picture goes in there as a tab. */
  private last: Win | null = null;
  private saveTimer = 0;
  private z = 0;
  /** Where the windows are: over the model, under every button (a window moved about never hides them). */
  private readonly layer = (() => {
    const element = document.createElement('div');
    element.id = 'ref-layer';
    document.body.append(element);

    return element;
  })();

  constructor(private toast: (text: string, kind?: 'info' | 'error') => void) {
    void this.load();
    window.addEventListener('resize', () => this.wins.forEach(win => this.fit(win, true)));
  }

  /** Pick one or more pictures; each opens as a tab of the last window used (or a new window). */
  async open(): Promise<void> {
    const files = await pickImages();
    if (!files.length) {
      return;
    }
    let win = this.last && this.wins.includes(this.last) ? this.last : null;
    for (const file of files) {
      const src = await readImage(file);
      if (!src) {
        this.toast(`${file.name} can't be shown here - save it as JPG or PNG first (an iPhone's HEIC photos too)`, 'error');
        continue;
      }
      win = this.add(file.name.replace(/\.[^.]+$/, ''), src, win);
    }
  }

  /** A picture as a new tab of `win` (none: a new window); the window it is in. */
  add(name: string, src: string, win: Win | null = this.last && this.wins.includes(this.last) ? this.last : null): Win {
    const ref = { name, src };
    if (!win) {
      win = this.make([ref], this.spot());
    } else {
      win.refs.push(ref);
      win.active = win.refs.length - 1;
      win.min = false;
      this.draw(win);
    }
    this.front(win);
    this.save();

    return win;
  }

  // ------------------------------------------------------------- windows

  private spot(): { x: number; y: number; w: number; h: number } {
    const width = Math.min(360, innerWidth - 24);
    const height = Math.min(300, innerHeight - 120);
    const count = this.wins.length;

    return { x: clamp(innerWidth / 2 - width / 2 + count * 24, 8, innerWidth - width - 8), y: clamp(80 + count * 24, 8, innerHeight - height - 8), w: width, h: height };
  }

  private make(refs: Ref[], at: { x: number; y: number; w: number; h: number }, active = 0, min = false): Win {
    const win = { host: document.createElement('div'), refs, active, min, ...at, z: 0, isDropTarget: false, draggedTab: null, shownSrc: null, zoom: { k: 1, x: 0, y: 0 }, fingers: 0 } as unknown as Win;
    this.layer.append(win.host);
    this.wins.push(win);
    this.paint(win);
    this.dragBy(win.bar, win, e => !(e.target as HTMLElement).closest('button, .ref-tab'));
    // (The picture itself is a handle too: the bar is a small target, a finger's
    // especially. Zoomed in, it moves the picture in its window instead.)
    this.zoomBy(win.body, win);
    this.dragBy(win.body, win, () => win.zoom.k <= 1 && win.fingers < 2);
    this.resizeBy(win.grip, win);
    this.draw(win);
    this.front(win);

    return win;
  }

  private paint(win: Win): void {
    mount(
      <RefWindowView
        win={win}
        onFront={() => this.front(win)}
        onAdd={() => {
          this.last = win;
          void this.open();
        }}
        onFold={() => {
          win.min = !win.min;
          this.draw(win);
          this.save();
        }}
        onClose={() => this.closeTab(win, win.active, true)}
        onTabDown={(event, index) => this.tabDrag(event, win, index)}
      />,
      win.host
    );
  }

  private draw(win: Win): void {
    win.active = clamp(win.active, 0, win.refs.length - 1);
    const ref = win.refs[win.active];
    if (ref && win.shownSrc !== ref.src) {
      win.shownSrc = ref.src;
      // (Another picture: it starts whole again.)
      win.zoom = { k: 1, x: 0, y: 0 };
    }
    this.fit(win);
  }

  /**
   * Kept on the screen: dragged, it may hang off an edge as long as some of
   * its bar can be reached; `whole` (the screen changed, or it came back after
   * a reload) brings it all in.
   */
  private fit(win: Win, whole = false): void {
    win.w = clamp(win.w, MIN_W, Math.max(MIN_W, innerWidth - 16));
    win.h = clamp(win.h, MIN_H, Math.max(MIN_H, innerHeight - 16));
    if (whole) {
      win.x = clamp(win.x, 8, Math.max(8, innerWidth - win.w - 8));
      win.y = clamp(win.y, 8, Math.max(8, innerHeight - (win.min ? BAR : win.h) - 8));
    }
    win.x = clamp(win.x, 8 - win.w + 80, innerWidth - 80);
    win.y = clamp(win.y, 0, innerHeight - BAR);
    this.paint(win);
  }

  private front(win: Win): void {
    this.last = win;
    win.z = ++this.z;
    this.paint(win);
  }

  private closeTab(win: Win, i: number, save: boolean): void {
    win.refs.splice(i, 1);
    if (!win.refs.length) {
      mount(null, win.host);
      win.host.remove();
      this.wins = this.wins.filter(floatingWindow => floatingWindow !== win);
      if (this.last === win) {
        this.last = this.wins[this.wins.length - 1] ?? null;
      }
    } else {
      if (win.active >= i) {
        win.active = Math.max(0, win.active - 1);
      }
      this.draw(win);
    }
    if (save) {
      this.save();
    }
  }

  // ------------------------------------------------------------- pointer

  /** Moved with the pointer, from a press on `handle` that `ok` accepts. */
  private dragBy(handle: HTMLElement, win: Win, ok: (e: PointerEvent) => boolean): void {
    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || !ok(e)) {
        return;
      }
      e.preventDefault();
      const dx = e.clientX - win.x;
      const dy = e.clientY - win.y;
      handle.setPointerCapture(e.pointerId);
      const move = (event: PointerEvent) => {
        // (A second finger came down on the picture: a pinch, not a move.)
        if (win.fingers > 1) {
          return up();
        }
        win.x = event.clientX - dx;
        win.y = event.clientY - dy;
        this.fit(win);
      };
      const up = () => {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
        handle.removeEventListener('pointercancel', up);
        this.save();
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
      handle.addEventListener('pointercancel', up);
    });
  }

  /**
   * The picture zoomed in its window: the mouse wheel zooms about the pointer,
   * two fingers pinch (and move it as they go); zoomed in, one finger or the
   * mouse moves it about. A double click or double tap shows it whole again.
   */
  private zoomBy(body: HTMLElement, win: Win): void {
    // Where a point of the window is, from the middle of the picture's box.
    const rel = (cx: number, cy: number) => {
      const rect = body.getBoundingClientRect();

      return { x: cx - rect.left - rect.width / 2, y: cy - rect.top - rect.height / 2 };
    };
    // Zoomed to `zoom` about `point` (from the middle): what is under the point stays under it.
    const about = (zoom: number, point: { x: number; y: number }) => {
      const z = win.zoom;
      const ratio = clamp(zoom, 1, MAX_ZOOM) / z.k;
      this.zoomTo(win, z.k * ratio, point.x - (point.x - z.x) * ratio, point.y - (point.y - z.y) * ratio);
    };
    body.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        e.stopPropagation();
        // (A trackpad's pinch comes as a wheel with Ctrl, in small steps.)
        const step = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
        about(win.zoom.k * Math.exp(-step * (e.ctrlKey ? 0.01 : 0.0015)), rel(e.clientX, e.clientY));
      },
      { passive: false }
    );
    body.addEventListener('dblclick', () => this.zoomTo(win, 1, 0, 0));
    const down = new Map<number, { x: number; y: number }>();
    let pinch: { d: number; k: number; m: { x: number; y: number }; z: { x: number; y: number } } | null = null;
    let pan: { x: number; y: number; zx: number; zy: number } | null = null;
    const start = () => {
      const [a, b] = [...down.values()];
      pan = null;
      pinch = null;
      if (a && b) {
        const midpoint = rel((a.x + b.x) / 2, (a.y + b.y) / 2);
        pinch = { d: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), k: win.zoom.k, m: midpoint, z: { x: win.zoom.x, y: win.zoom.y } };
      } else if (a && win.zoom.k > 1) {
        pan = { x: a.x, y: a.y, zx: win.zoom.x, zy: win.zoom.y };
      }
    };
    body.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) {
        return;
      }
      try {
        body.setPointerCapture(e.pointerId);
      } catch {
        /* (a pointer already gone) */
      }
      down.set(e.pointerId, { x: e.clientX, y: e.clientY });
      win.fingers = down.size;
      start();
    });
    body.addEventListener('pointermove', (e) => {
      if (!down.has(e.pointerId)) {
        return;
      }
      down.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pinch) {
        const [a, b] = [...down.values()];
        const zoom = clamp((pinch.k * Math.hypot(a.x - b.x, a.y - b.y)) / pinch.d, 1, MAX_ZOOM);
        const midpoint = rel((a.x + b.x) / 2, (a.y + b.y) / 2);
        // The point first between the fingers stays between them.
        const ratio = zoom / pinch.k;
        this.zoomTo(win, zoom, midpoint.x - (pinch.m.x - pinch.z.x) * ratio, midpoint.y - (pinch.m.y - pinch.z.y) * ratio);
      } else if (pan) {
        this.zoomTo(win, win.zoom.k, pan.zx + e.clientX - pan.x, pan.zy + e.clientY - pan.y);
      }
    });
    const up = (e: PointerEvent) => {
      if (!down.delete(e.pointerId)) {
        return;
      }
      win.fingers = down.size;
      start();
    };
    body.addEventListener('pointerup', up);
    body.addEventListener('pointercancel', up);
  }

  /** The picture at `zoom`, moved (x, y) from the middle - kept so some of it is always in the window. */
  private zoomTo(win: Win, zoom: number, x: number, y: number): void {
    zoom = clamp(zoom, 1, MAX_ZOOM);
    const halfWidth = ((win.img?.offsetWidth ?? 0) * zoom) / 2;
    const halfHeight = ((win.img?.offsetHeight ?? 0) * zoom) / 2;
    win.zoom = zoom <= 1.001 ? { k: 1, x: 0, y: 0 } : { k: zoom, x: clamp(x, -halfWidth, halfWidth), y: clamp(y, -halfHeight, halfHeight) };
    this.paint(win);
  }

  private resizeBy(grip: HTMLElement, win: Win): void {
    grip.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      const from = { x: e.clientX, y: e.clientY, w: win.w, h: win.h };
      grip.setPointerCapture(e.pointerId);
      const move = (event: PointerEvent) => {
        win.w = from.w + event.clientX - from.x;
        win.h = from.h + event.clientY - from.y;
        this.fit(win);
      };
      const up = () => {
        grip.removeEventListener('pointermove', move);
        grip.removeEventListener('pointerup', up);
        grip.removeEventListener('pointercancel', up);
        this.save();
      };
      grip.addEventListener('pointermove', move);
      grip.addEventListener('pointerup', up);
      grip.addEventListener('pointercancel', up);
    });
  }

  /**
   * A tab: a tap shows its picture; dragged, a ghost of it follows the
   * pointer. Let go on a window's bar, it joins that window (its own: moved
   * along it); let go anywhere else, it is a window of its own there (the only
   * tab of a window: the window goes there).
   */
  private tabDrag(e: PointerEvent, win: Win, i: number): void {
    if (e.button !== 0) {
      return;
    }
    const tab = e.currentTarget as HTMLElement;
    e.preventDefault();
    tab.setPointerCapture(e.pointerId);
    // Minimized, its tabs are all there is of it: dragged, the window goes with them; a tap opens it.
    if (win.min) {
      return this.moveMinimized(tab, win, i, e);
    }
    const start = { x: e.clientX, y: e.clientY };
    const off = tab.getBoundingClientRect();
    let ghost: HTMLElement | null = null;
    const setDropTarget = (over: Win | null) => {
      for (const other of this.wins) {
        if (other.isDropTarget !== (other === over)) {
          other.isDropTarget = other === over;
          this.paint(other);
        }
      }
    };
    const move = (event: PointerEvent) => {
      if (!ghost && Math.hypot(event.clientX - start.x, event.clientY - start.y) < 8) {
        return;
      }
      if (!ghost) {
        ghost = document.createElement('div');
        ghost.className = 'ref-tab on ref-ghost';
        ghost.textContent = tab.textContent;
        document.body.append(ghost);
        win.draggedTab = i;
        this.paint(win);
      }
      ghost.style.left = `${event.clientX - (start.x - off.left)}px`;
      ghost.style.top = `${event.clientY - (start.y - off.top)}px`;
      setDropTarget(this.barAt(event.clientX, event.clientY));
    };
    const finish = () => {
      tab.removeEventListener('pointermove', move);
      tab.removeEventListener('pointerup', up);
      tab.removeEventListener('pointercancel', cancel);
      setDropTarget(null);
      ghost?.remove();
      win.draggedTab = null;
    };
    const up = (event: PointerEvent) => {
      const wasDragged = !!ghost;
      finish();
      if (!wasDragged) {
        win.active = i;
        win.min = false;
        this.draw(win);
        this.save();

        return;
      }
      this.dropTab(win, i, event.clientX, event.clientY, event.clientX - (start.x - off.left), event.clientY - (start.y - off.top));
      if (this.wins.includes(win)) {
        this.paint(win);
      }
    };
    const cancel = () => {
      finish();
      this.paint(win);
    };
    tab.addEventListener('pointermove', move);
    tab.addEventListener('pointerup', up);
    tab.addEventListener('pointercancel', cancel);
  }

  private moveMinimized(tab: HTMLElement, win: Win, i: number, e: PointerEvent): void {
    const start = { x: e.clientX, y: e.clientY };
    const dx = e.clientX - win.x;
    const dy = e.clientY - win.y;
    let moved = false;
    const move = (event: PointerEvent) => {
      if (!moved && Math.hypot(event.clientX - start.x, event.clientY - start.y) < 8) {
        return;
      }
      moved = true;
      win.x = event.clientX - dx;
      win.y = event.clientY - dy;
      this.fit(win);
    };
    const up = () => {
      tab.removeEventListener('pointermove', move);
      tab.removeEventListener('pointerup', up);
      tab.removeEventListener('pointercancel', up);
      if (!moved) {
        win.active = i;
        win.min = false;
        this.draw(win);
      }
      this.save();
    };
    tab.addEventListener('pointermove', move);
    tab.addEventListener('pointerup', up);
    tab.addEventListener('pointercancel', up);
  }

  /** The window whose bar is under the point (the one in front). */
  private barAt(x: number, y: number): Win | null {
    let best: Win | null = null;
    for (const win of this.wins) {
      const b = win.bar.getBoundingClientRect();
      if (x >= b.left && x <= b.right && y >= b.top && y <= b.bottom && (!best || zOf(win) > zOf(best))) {
        best = win;
      }
    }

    return best;
  }

  private dropTab(from: Win, i: number, x: number, y: number, gx: number, gy: number): void {
    const ref = from.refs[i];
    const to = this.barAt(x, y);
    if (to) {
      // Along a bar: before the tab it is dropped on (or at the end).
      const tabs = [...to.tabs.children] as HTMLElement[];
      let at = tabs.findIndex((t) => {
        const b = t.getBoundingClientRect();

        return x < b.left + b.width / 2;
      });
      if (at < 0) {
        at = tabs.length;
      }
      if (to === from) {
        if (at > i) {
          at--;
        }
        from.refs.splice(i, 1);
        from.refs.splice(at, 0, ref);
        from.active = at;
        this.draw(from);
      } else {
        this.closeTab(from, i, false);
        to.refs.splice(at, 0, ref);
        to.active = at;
        to.min = false;
        this.draw(to);
        this.front(to);
      }

      return this.save();
    }
    // Out in the open: a window of its own, its bar where the tab was let go.
    if (from.refs.length === 1) {
      from.x = gx - 6;
      from.y = gy - 4;
      this.fit(from);

      return this.save();
    }
    this.closeTab(from, i, false);
    this.make([ref], { x: gx - 6, y: gy - 4, w: from.w, h: from.h });
    this.save();
  }

  // ------------------------------------------------------------- kept

  private save(): void {
    clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      const all: Saved[] = this.wins
        .slice()
        .sort((a, b) => zOf(a) - zOf(b))
        .map(win => ({ x: win.x / innerWidth, y: win.y / innerHeight, w: win.w, h: win.h, min: win.min, active: win.active, refs: win.refs }));
      void idbSet(KEY, JSON.stringify(all));
    }, 300);
  }

  private async load(): Promise<void> {
    try {
      const raw = await idbGet(KEY);
      const all = raw ? (JSON.parse(raw) as Saved[]) : [];
      for (const saved of all) {
        if (saved.refs?.length) {
          this.fit(this.make(saved.refs, { x: saved.x * innerWidth, y: saved.y * innerHeight, w: saved.w, h: saved.h }, saved.active, saved.min), true);
        }
      }
    } catch {
      // nothing kept, or unreadable: start with none
    }
  }

  /** For checking from the console: the windows and their tabs. */
  describe(): { x: number; y: number; w: number; h: number; min: boolean; active: number; tabs: string[] }[] {
    return this.wins.map(win => ({ x: Math.round(win.x), y: Math.round(win.y), w: Math.round(win.w), h: Math.round(win.h), min: win.min, active: win.active, tabs: win.refs.map(ref => ref.name) }));
  }
}

function pickImages(): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.multiple = true;
    input.onchange = () => resolve([...(input.files ?? [])]);
    input.click();
  });
}

/** The picture as a data URL, made smaller when it is huge (null: the browser can't show it). */
async function readImage(file: File): Promise<string | null> {
  let src = await new Promise<string>((resolve) => {
    const fileReader = new FileReader();
    fileReader.onload = () => resolve(fileReader.result as string);
    fileReader.readAsDataURL(file);
  });
  const img = new Image();
  img.src = src;
  try {
    await img.decode();
  } catch {
    return null;
  }
  const scale = Math.min(1, MAX / Math.max(img.width, img.height));
  if (scale < 1 || file.size > 2e6) {
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.width * scale);
    canvas.height = Math.round(img.height * scale);
    canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height);
    src = file.type === 'image/png' ? canvas.toDataURL('image/png') : canvas.toDataURL('image/jpeg', 0.85);
  }

  return src;
}
