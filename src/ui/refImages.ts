// Reference images: pictures to look at while modelling (a drawing, a photo
// of the part), each in a window over the model - under the buttons, the
// wheels and the panels, so moving it about never hides them. A window is dragged by
// its top bar or its picture, resized from its corner, minimized to its bar
// (then dragged by its tabs) and closed. More
// pictures in one window are tabs along its top; a tab dragged out of the bar
// becomes a window of its own, and dropped on another window's bar it joins it.
// They are kept on this device (not in the project) until closed.

import { idbGet, idbSet } from '../doc/store';
import { icons } from './icons';

interface Ref {
  name: string;
  src: string;
}

interface Win {
  el: HTMLElement;
  bar: HTMLElement;
  tabs: HTMLElement;
  img: HTMLImageElement;
  refs: Ref[];
  active: number;
  x: number;
  y: number;
  w: number;
  h: number;
  min: boolean;
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
/** Where a window is among the others (higher: in front). */
const zOf = (w: Win) => +(w.el.style.getPropertyValue('--z') || 0);
const MIN_W = 160;
/** As far as a picture zooms in its window. */
const MAX_ZOOM = 12;
const MIN_H = 120;

const div = (cls: string) => {
  const d = document.createElement('div');
  d.className = cls;

  return d;
};
const button = (cls: string, icon: string, title: string) => {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = cls;
  b.innerHTML = icon;
  b.title = title;
  b.setAttribute('aria-label', title);

  return b;
};
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export class RefImages {
  private wins: Win[] = [];
  /** The last window touched: a new picture goes in there as a tab. */
  private last: Win | null = null;
  private saveTimer = 0;
  private z = 0;
  /** Where the windows are: over the model, under every button (a window moved about never hides them). */
  private readonly layer = (() => {
    const d = div('');
    d.id = 'ref-layer';
    document.body.append(d);

    return d;
  })();

  constructor(private toast: (text: string, kind?: 'info' | 'error') => void) {
    void this.load();
    window.addEventListener('resize', () => this.wins.forEach(w => this.fit(w, true)));
  }

  /** Pick one or more pictures; each opens as a tab of the last window used (or a new window). */
  async open(): Promise<void> {
    const files = await pickImages();
    if (!files.length) {
      return;
    }
    let win = this.last && this.wins.includes(this.last) ? this.last : null;
    for (const f of files) {
      const src = await readImage(f);
      if (!src) {
        this.toast(`${f.name} can't be shown here - save it as JPG or PNG first (an iPhone's HEIC photos too)`, 'error');
        continue;
      }
      win = this.add(f.name.replace(/\.[^.]+$/, ''), src, win);
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
    const w = Math.min(360, innerWidth - 24);
    const h = Math.min(300, innerHeight - 120);
    const n = this.wins.length;

    return { x: clamp(innerWidth / 2 - w / 2 + n * 24, 8, innerWidth - w - 8), y: clamp(80 + n * 24, 8, innerHeight - h - 8), w, h };
  }

  private make(refs: Ref[], at: { x: number; y: number; w: number; h: number }, active = 0, min = false): Win {
    const el = div('ref-win');
    const bar = div('ref-bar');
    const tabs = div('ref-tabs');
    const add = button('ref-btn', icons.insert, 'Add a picture');
    const fold = button('ref-btn', icons.minimize, 'Minimize');
    const close = button('ref-btn', icons.close, 'Close');
    bar.append(tabs, add, fold, close);
    const body = div('ref-body');
    const img = document.createElement('img');
    img.draggable = false;
    img.alt = '';
    const grip = div('ref-grip');
    body.append(img);
    el.append(bar, body, grip);
    this.layer.append(el);
    const win: Win = { el, bar, tabs, img, refs, active, min, ...at, zoom: { k: 1, x: 0, y: 0 }, fingers: 0 };
    this.wins.push(win);

    el.addEventListener('pointerdown', () => this.front(win), true);
    add.addEventListener('click', () => ((this.last = win), void this.open()));
    fold.addEventListener('click', () => {
      win.min = !win.min;
      this.draw(win);
      this.save();
    });
    close.addEventListener('click', () => this.closeTab(win, win.active, true));
    this.dragBy(bar, win, e => !(e.target as HTMLElement).closest('button, .ref-tab'));
    // (The picture itself is a handle too: the bar is a small target, a finger's
    // especially. Zoomed in, it moves the picture in its window instead.)
    this.zoomBy(body, win);
    this.dragBy(body, win, () => win.zoom.k <= 1 && win.fingers < 2);
    this.resizeBy(grip, win);
    // (A double click on the bar minimizes or restores it, as the button does.)
    bar.addEventListener('dblclick', (e) => {
      if ((e.target as HTMLElement).closest('button, .ref-tab')) {
        return;
      }
      fold.click();
    });
    this.draw(win);
    this.front(win);

    return win;
  }

  private draw(win: Win): void {
    win.active = clamp(win.active, 0, win.refs.length - 1);
    win.el.classList.toggle('min', win.min);
    win.el.classList.toggle('single', win.refs.length === 1);
    const fold = win.bar.querySelectorAll('.ref-btn')[1] as HTMLElement;
    fold.innerHTML = win.min ? icons.restore : icons.minimize;
    fold.title = fold.ariaLabel = win.min ? 'Restore' : 'Minimize';
    const close = win.bar.querySelectorAll('.ref-btn')[2] as HTMLElement;
    close.title = win.refs.length > 1 ? 'Close this picture' : 'Close';
    win.tabs.replaceChildren(
      ...win.refs.map((r, i) => {
        const t = div(`ref-tab${i === win.active ? ' on' : ''}`);
        t.textContent = r.name;
        t.title = r.name;
        this.tabDrag(t, win, i);

        return t;
      })
    );
    const ref = win.refs[win.active];
    if (ref && win.img.getAttribute('src') !== ref.src) {
      win.img.src = ref.src;
      // (Another picture: it starts whole again.)
      this.zoomTo(win, 1, 0, 0);
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
    const s = win.el.style;
    s.left = `${Math.round(win.x)}px`;
    s.top = `${Math.round(win.y)}px`;
    // (Minimized: just as wide as its tabs and the three buttons.)
    s.width = win.min ? '' : `${Math.round(win.w)}px`;
    s.height = win.min ? '' : `${Math.round(win.h)}px`;
  }

  private front(win: Win): void {
    this.last = win;
    win.el.style.setProperty('--z', String(++this.z));
  }

  private closeTab(win: Win, i: number, save: boolean): void {
    win.refs.splice(i, 1);
    if (!win.refs.length) {
      win.el.remove();
      this.wins = this.wins.filter(w => w !== win);
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
      const move = (m: PointerEvent) => {
        // (A second finger came down on the picture: a pinch, not a move.)
        if (win.fingers > 1) {
          return up();
        }
        win.x = m.clientX - dx;
        win.y = m.clientY - dy;
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
      const r = body.getBoundingClientRect();

      return { x: cx - r.left - r.width / 2, y: cy - r.top - r.height / 2 };
    };
    // Zoomed to k about a point p (from the middle): the point under p stays under it.
    const about = (k: number, p: { x: number; y: number }) => {
      const z = win.zoom;
      const f = clamp(k, 1, MAX_ZOOM) / z.k;
      this.zoomTo(win, z.k * f, p.x - (p.x - z.x) * f, p.y - (p.y - z.y) * f);
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
        const m = rel((a.x + b.x) / 2, (a.y + b.y) / 2);
        pinch = { d: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), k: win.zoom.k, m, z: { x: win.zoom.x, y: win.zoom.y } };
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
        const k = clamp((pinch.k * Math.hypot(a.x - b.x, a.y - b.y)) / pinch.d, 1, MAX_ZOOM);
        const m = rel((a.x + b.x) / 2, (a.y + b.y) / 2);
        // The point first between the fingers stays between them.
        const f = k / pinch.k;
        this.zoomTo(win, k, m.x - (pinch.m.x - pinch.z.x) * f, m.y - (pinch.m.y - pinch.z.y) * f);
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

  /** The picture at zoom k, moved (x, y) from the middle - kept so some of it is always in the window. */
  private zoomTo(win: Win, k: number, x: number, y: number): void {
    k = clamp(k, 1, MAX_ZOOM);
    const w = (win.img.offsetWidth * k) / 2;
    const h = (win.img.offsetHeight * k) / 2;
    win.zoom = k <= 1.001 ? { k: 1, x: 0, y: 0 } : { k, x: clamp(x, -w, w), y: clamp(y, -h, h) };
    const z = win.zoom;
    win.img.style.transform = z.k === 1 ? '' : `translate(${z.x}px, ${z.y}px) scale(${z.k})`;
    win.el.classList.toggle('zoomed', z.k > 1);
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
      const move = (m: PointerEvent) => {
        win.w = from.w + m.clientX - from.x;
        win.h = from.h + m.clientY - from.y;
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
  private tabDrag(tab: HTMLElement, win: Win, i: number): void {
    tab.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) {
        return;
      }
      e.preventDefault();
      tab.setPointerCapture(e.pointerId);
      // Minimized, its tabs are all there is of it: dragged, the window goes with them; a tap opens it.
      if (win.min) {
        return this.moveMinimized(tab, win, i, e);
      }
      const start = { x: e.clientX, y: e.clientY };
      const off = tab.getBoundingClientRect();
      let ghost: HTMLElement | null = null;
      const move = (m: PointerEvent) => {
        if (!ghost && Math.hypot(m.clientX - start.x, m.clientY - start.y) < 8) {
          return;
        }
        if (!ghost) {
          ghost = div('ref-tab on ref-ghost');
          ghost.textContent = tab.textContent;
          document.body.append(ghost);
          tab.classList.add('dragged');
        }
        ghost.style.left = `${m.clientX - (start.x - off.left)}px`;
        ghost.style.top = `${m.clientY - (start.y - off.top)}px`;
        const over = this.barAt(m.clientX, m.clientY);
        for (const w of this.wins) {
          w.bar.classList.toggle('drop', w === over);
        }
      };
      const up = (u: PointerEvent) => {
        tab.removeEventListener('pointermove', move);
        tab.removeEventListener('pointerup', up);
        tab.removeEventListener('pointercancel', cancel);
        for (const w of this.wins) {
          w.bar.classList.remove('drop');
        }
        if (!ghost) {
          win.active = i;
          win.min = false;
          this.draw(win);
          this.save();

          return;
        }
        ghost.remove();
        tab.classList.remove('dragged');
        this.dropTab(win, i, u.clientX, u.clientY, u.clientX - (start.x - off.left), u.clientY - (start.y - off.top));
      };
      const cancel = () => {
        tab.removeEventListener('pointermove', move);
        tab.removeEventListener('pointerup', up);
        tab.removeEventListener('pointercancel', cancel);
        ghost?.remove();
        tab.classList.remove('dragged');
        for (const w of this.wins) {
          w.bar.classList.remove('drop');
        }
      };
      tab.addEventListener('pointermove', move);
      tab.addEventListener('pointerup', up);
      tab.addEventListener('pointercancel', cancel);
    });
  }

  private moveMinimized(tab: HTMLElement, win: Win, i: number, e: PointerEvent): void {
    const start = { x: e.clientX, y: e.clientY };
    const dx = e.clientX - win.x;
    const dy = e.clientY - win.y;
    let moved = false;
    const move = (m: PointerEvent) => {
      if (!moved && Math.hypot(m.clientX - start.x, m.clientY - start.y) < 8) {
        return;
      }
      moved = true;
      win.x = m.clientX - dx;
      win.y = m.clientY - dy;
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
    for (const w of this.wins) {
      const b = w.bar.getBoundingClientRect();
      if (x >= b.left && x <= b.right && y >= b.top && y <= b.bottom && (!best || zOf(w) > zOf(best))) {
        best = w;
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
        .map(w => ({ x: w.x / innerWidth, y: w.y / innerHeight, w: w.w, h: w.h, min: w.min, active: w.active, refs: w.refs }));
      void idbSet(KEY, JSON.stringify(all));
    }, 300);
  }

  private async load(): Promise<void> {
    try {
      const raw = await idbGet(KEY);
      const all = raw ? (JSON.parse(raw) as Saved[]) : [];
      for (const s of all) {
        if (s.refs?.length) {
          this.fit(this.make(s.refs, { x: s.x * innerWidth, y: s.y * innerHeight, w: s.w, h: s.h }, s.active, s.min), true);
        }
      }
    } catch {
      // nothing kept, or unreadable: start with none
    }
  }

  /** For checking from the console: the windows and their tabs. */
  describe(): { x: number; y: number; w: number; h: number; min: boolean; active: number; tabs: string[] }[] {
    return this.wins.map(w => ({ x: Math.round(w.x), y: Math.round(w.y), w: Math.round(w.w), h: Math.round(w.h), min: w.min, active: w.active, tabs: w.refs.map(r => r.name) }));
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
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.readAsDataURL(file);
  });
  const img = new Image();
  img.src = src;
  try {
    await img.decode();
  } catch {
    return null;
  }
  const k = Math.min(1, MAX / Math.max(img.width, img.height));
  if (k < 1 || file.size > 2e6) {
    const c = document.createElement('canvas');
    c.width = Math.round(img.width * k);
    c.height = Math.round(img.height * k);
    c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
    src = file.type === 'image/png' ? c.toDataURL('image/png') : c.toDataURL('image/jpeg', 0.85);
  }

  return src;
}
