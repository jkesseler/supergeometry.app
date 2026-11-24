// Browser: a web page in a window over the model (More › Insert › Browser) -
// moved by its bar, resized from its corner, minimized to its bar and closed,
// like a reference image's. An address box along the top takes a page's
// address, or a video's link (YouTube, Vimeo): the video plays right there,
// and its own full-screen button fills the screen with it.
//
// Many sites (YouTube's own pages, Google, most shops and social sites) won't
// be shown inside another page: for those the window says so and opens them
// in a tab of their own instead of showing an empty box.

import { icons } from './icons';

interface Saved {
  url: string;
  x: number;
  y: number;
  w: number;
  h: number;
  min: boolean;
  open: boolean;
}

const KEY = 'sg-browser';
const BAR = 34;
const MIN_W = 220;
const MIN_H = 160;
const clamp = (value: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, value));

/** Sites known to refuse being shown inside another page (by the end of their host name). */
const REFUSE = [
  'youtube.com', 'google.com', 'facebook.com', 'instagram.com', 'x.com', 'twitter.com', 'tiktok.com', 'reddit.com',
  'linkedin.com', 'amazon.com', 'github.com', 'netflix.com', 'twitch.tv', 'pinterest.com', 'bing.com', 'duckduckgo.com',
  'chatgpt.com', 'openai.com', 'apple.com', 'microsoft.com', 'whatsapp.com', 'spotify.com', 'ebay.com'
];

/** What the window shows for what was typed: a page, or why it can't (and what to do instead). */
export function pageFor(text: string): { src: string; shown: string; video?: 'youtube' | 'vimeo' } | { refuse: string; shown: string; open?: string } {
  let t = text.trim();
  if (!t) {
    return { refuse: "Type a page's address, or paste a video's link (YouTube, Vimeo).", shown: '' };
  }
  if (!/^[a-z][a-z0-9+.-]*:/i.test(t)) {
    // Words, not an address: nothing here can search (search sites refuse to be shown inside a page).
    if (/\s/.test(t) || !/\.[a-z]{2,}/i.test(t)) {
      return { refuse: "Type a page's address (like wikipedia.org), or paste a video's link.", shown: t };
    }
    t = `https://${t}`;
  }
  let url: URL;
  try {
    url = new URL(t);
  } catch {
    return { refuse: "That isn't an address this can open.", shown: text };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { refuse: 'Only web pages (http, https) open here.', shown: text };
  }
  const host = url.hostname.replace(/^(www|m|music)\./, '');
  // A YouTube video (watch, youtu.be, shorts, live, embed): its own player, which may be shown in a page.
  const yt
    = host === 'youtu.be' ? url.pathname.slice(1).split('/')[0] : host.endsWith('youtube.com') ? (url.searchParams.get('v') ?? url.pathname.match(/^\/(?:shorts|live|embed|v)\/([\w-]{6,})/)?.[1] ?? null) : null;
  if (yt && /^[\w-]{6,}$/.test(yt)) {
    const start = parseInt(url.searchParams.get('t') ?? url.searchParams.get('start') ?? '', 10);
    const list = url.searchParams.get('list');
    const q = new URLSearchParams({ autoplay: '1', rel: '0', ...(start > 0 ? { start: String(start) } : {}), ...(list ? { list } : {}) });

    return { src: `https://www.youtube.com/embed/${yt}?${q}`, shown: url.href, video: 'youtube' };
  }
  if (host.endsWith('youtube.com')) {
    return {
      refuse: "YouTube won't show its pages inside another page. Find the video in a tab of its own, then copy its link (Share › Copy) and paste it here: it plays in this window, full screen too.",
      shown: url.href,
      open: url.href
    };
  }
  const vimeo = host === 'vimeo.com' ? url.pathname.match(/^\/(\d+)/)?.[1] : null;
  if (vimeo) {
    return { src: `https://player.vimeo.com/video/${vimeo}?autoplay=1`, shown: url.href, video: 'vimeo' };
  }
  if (REFUSE.some(refused => host === refused || host.endsWith(`.${refused}`))) {
    return { refuse: `${host} won't show its pages inside another page.`, shown: url.href, open: url.href };
  }

  return { src: url.href, shown: url.href };
}

const button = (icon: string, title: string) => {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'ref-btn';
  b.innerHTML = icon;
  b.title = title;
  b.setAttribute('aria-label', title);

  return b;
};

export class WebWindow {
  private el: HTMLElement | null = null;
  private frame!: HTMLIFrameElement;
  private note!: HTMLElement;
  private address!: HTMLInputElement;
  private fold!: HTMLButtonElement;
  /** Over the page: a press held (or dragged) there moves the window - the page itself never tells this one what the pointer does. */
  private grab!: HTMLElement;
  private wired = false;
  private state: Saved = { url: '', x: 0, y: 0, w: 0, h: 0, min: false, open: false };

  constructor() {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) {
        const stored = JSON.parse(raw) as Saved;
        // (Kept as parts of the screen: a phone turned, a window resized since.)
        this.state = { ...this.state, ...stored, x: stored.x * innerWidth, y: stored.y * innerHeight };
      }
    } catch {
      // nothing kept
    }
    // Open when the page was left: open again, where it was.
    if (this.state.open) {
      setTimeout(() => this.open(), 0);
    }
    window.addEventListener('resize', () => this.el && this.fit(true));
  }

  get isOpen(): boolean {
    return !!this.el;
  }

  /** The window up (made if it isn't), in front, its address box ready to type into when it is empty. */
  open(url?: string): void {
    if (!this.el) {
      this.make();
    }
    this.state.open = true;
    this.state.min = false;
    this.draw();
    if (url !== undefined) {
      this.go(url);
    } else if (!this.state.url) {
      setTimeout(() => this.address.focus(), 0);
    }
    this.save();
  }

  close(): void {
    this.el?.remove();
    this.el = null;
    this.state.open = false;
    this.save();
  }

  private make(): void {
    const layer = document.getElementById('ref-layer') ?? document.body;
    const el = document.createElement('div');
    el.className = 'ref-win web-win';
    const bar = document.createElement('div');
    bar.className = 'ref-bar web-bar';
    const form = document.createElement('form');
    form.className = 'web-go';
    const address = document.createElement('input');
    address.type = 'text';
    address.inputMode = 'url';
    address.autocomplete = 'off';
    address.spellcheck = false;
    address.placeholder = 'Address or video link';
    address.setAttribute('aria-label', 'Address');
    form.append(address);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      this.go(address.value);
      address.blur();
    });
    // (Typed in: everything selected, to type over.)
    address.addEventListener('focus', () => address.select());
    const reload = button(icons.reload, 'Reload');
    const out = button(icons.share, 'Open in a new tab');
    const fold = button(icons.minimize, 'Minimize');
    const close = button(icons.close, 'Close');
    bar.append(form, reload, out, fold, close);
    const body = document.createElement('div');
    body.className = 'web-body';
    const frame = document.createElement('iframe');
    frame.title = 'Browser';
    // (Video players need these to play and to go full screen; the page can't take this one's place.)
    frame.allow = 'fullscreen; autoplay; encrypted-media; picture-in-picture; clipboard-write; web-share';
    frame.allowFullscreen = true;
    frame.referrerPolicy = 'strict-origin-when-cross-origin';
    frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-presentation');
    const note = document.createElement('div');
    note.className = 'web-note';
    const grab = document.createElement('div');
    grab.className = 'web-grab';
    body.append(frame, grab, note);
    const grip = document.createElement('div');
    grip.className = 'ref-grip';
    el.append(bar, body, grip);
    layer.append(el);
    Object.assign(this, { el, frame, note, address, fold, grab });
    this.holdToMove(grab);

    el.addEventListener('pointerdown', () => el.style.setProperty('--z', '999'), true);
    reload.addEventListener('click', () => this.state.url && this.go(this.state.url));
    out.addEventListener('click', () => {
      const page = pageFor(this.address.value || this.state.url);
      const href = 'src' in page ? page.shown : page.open;
      if (href) {
        window.open(href, '_blank', 'noopener');
      }
    });
    fold.addEventListener('click', () => {
      this.state.min = !this.state.min;
      this.draw();
      this.save();
    });
    close.addEventListener('click', () => this.close());
    bar.addEventListener('dblclick', e => !(e.target as HTMLElement).closest('button, input') && fold.click());
    this.dragBy(bar);
    this.resizeBy(grip);

    if (!this.state.w) {
      const width = Math.min(640, innerWidth - 24);
      const height = Math.min(420, innerHeight - 140);
      this.state = { ...this.state, x: (innerWidth - width) / 2, y: 90, w: width, h: height };
    }
    this.fit(true);
    // (Nothing typed yet: what to type, in the window.)
    this.go(this.state.url);
  }

  /** What was typed, shown: the page, or a note saying why it can't be (and a button to open it in a tab). */
  private go(text: string): void {
    if (!this.el) {
      return;
    }
    const page = pageFor(text);
    this.address.value = page.shown;
    if ('src' in page) {
      this.state.url = page.shown;
      this.note.hidden = true;
      this.frame.hidden = false;
      this.frame.src = page.src;
      this.arm(true);
    } else {
      this.frame.hidden = true;
      this.frame.removeAttribute('src');
      this.note.replaceChildren();
      const say = document.createElement('p');
      say.textContent = page.refuse;
      this.note.append(say);
      if (page.open) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'web-open';
        b.textContent = 'Open it in a new tab';
        const href = page.open;
        b.addEventListener('click', () => window.open(href, '_blank', 'noopener'));
        this.note.append(b);
      }
      this.note.hidden = false;
      if (page.shown) {
        this.state.url = page.shown;
      }
    }
    this.save();
  }

  private draw(): void {
    if (!this.el) {
      return;
    }
    this.el.classList.toggle('min', this.state.min);
    this.fold.innerHTML = this.state.min ? icons.restore : icons.minimize;
    this.fold.title = this.fold.ariaLabel = this.state.min ? 'Restore' : 'Minimize';
    this.el.style.setProperty('--z', '999');
    this.fit();
  }

  /** Kept on the screen (some of its bar always within reach); `whole` brings it all in. */
  private fit(whole = false): void {
    const state = this.state;
    if (!this.el) {
      return;
    }
    state.w = clamp(state.w, MIN_W, Math.max(MIN_W, innerWidth - 16));
    state.h = clamp(state.h, MIN_H, Math.max(MIN_H, innerHeight - 16));
    if (whole) {
      state.x = clamp(state.x, 8, Math.max(8, innerWidth - state.w - 8));
      state.y = clamp(state.y, 8, Math.max(8, innerHeight - (state.min ? BAR : state.h) - 8));
    }
    state.x = clamp(state.x, 8 - state.w + 80, innerWidth - 80);
    state.y = clamp(state.y, 0, innerHeight - BAR);
    const st = this.el.style;
    st.left = `${Math.round(state.x)}px`;
    st.top = `${Math.round(state.y)}px`;
    st.width = `${Math.round(state.w)}px`;
    st.height = state.min ? '' : `${Math.round(state.h)}px`;
  }

  /**
   * The layer over the page: pressed and dragged, or held, the window moves
   * with the pointer. A tap lets the page or the video be used (the layer
   * steps aside: the player's own buttons, volume and all) until the pointer
   * is back on the model or anything else here.
   */
  private holdToMove(grab: HTMLElement): void {
    grab.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) {
        return;
      }
      e.preventDefault();
      const start = { x: e.clientX, y: e.clientY, dx: e.clientX - this.state.x, dy: e.clientY - this.state.y };
      try {
        grab.setPointerCapture(e.pointerId);
      } catch {
        // (a pointer already gone)
      }
      let moving = false;
      const lift = () => {
        if (moving) {
          return;
        }
        moving = true;
        this.el?.classList.add('moving', 'lifted');
      };
      const hold = window.setTimeout(lift, 350);
      const move = (event: PointerEvent) => {
        if (!moving && Math.hypot(event.clientX - start.x, event.clientY - start.y) < 8) {
          return;
        }
        lift();
        this.state.x = event.clientX - start.dx;
        this.state.y = event.clientY - start.dy;
        this.fit();
      };
      const up = (event: PointerEvent) => {
        clearTimeout(hold);
        grab.removeEventListener('pointermove', move);
        grab.removeEventListener('pointerup', up);
        grab.removeEventListener('pointercancel', up);
        this.el?.classList.remove('moving', 'lifted');
        if (moving) {
          return this.save();
        }
        if (event.type !== 'pointerup') {
          return;
        }
        // A tap: the page (or the video, with its own controls - volume, seek, full screen) is yours to use.
        this.arm(false);
      };
      grab.addEventListener('pointermove', move);
      grab.addEventListener('pointerup', up);
      grab.addEventListener('pointercancel', up);
    });
    // (The page-wide listeners once, however often the window is opened again.)
    if (this.wired) {
      return;
    }
    this.wired = true;
    // Back on anything else here (the model, a button, the window's bar): the layer is back over the page.
    const back = (e: Event) => {
      if (!this.el || this.grab.classList.contains('on')) {
        return;
      }
      if (!this.el.querySelector('.web-body')!.contains(e.target as Node)) {
        this.arm(true);
      }
    };
    window.addEventListener('pointerdown', back, true);
    window.addEventListener('pointermove', back, true);
  }

  /** The layer over the page on (a hold or a drag there moves the window), or stepped aside (taps go to the page). */
  private arm(on: boolean): void {
    this.grab.classList.toggle('on', on);
  }

  /** Moved with a press on the bar (not on its box or buttons). While moving, the page doesn't take the pointer. */
  private dragBy(bar: HTMLElement): void {
    bar.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || (e.target as HTMLElement).closest('button, input')) {
        return;
      }
      e.preventDefault();
      const dx = e.clientX - this.state.x;
      const dy = e.clientY - this.state.y;
      bar.setPointerCapture(e.pointerId);
      this.el?.classList.add('moving');
      const move = (event: PointerEvent) => {
        this.state.x = event.clientX - dx;
        this.state.y = event.clientY - dy;
        this.fit();
      };
      const up = () => {
        bar.removeEventListener('pointermove', move);
        bar.removeEventListener('pointerup', up);
        bar.removeEventListener('pointercancel', up);
        this.el?.classList.remove('moving');
        this.save();
      };
      bar.addEventListener('pointermove', move);
      bar.addEventListener('pointerup', up);
      bar.addEventListener('pointercancel', up);
    });
  }

  private resizeBy(grip: HTMLElement): void {
    grip.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      const from = { x: e.clientX, y: e.clientY, w: this.state.w, h: this.state.h };
      grip.setPointerCapture(e.pointerId);
      this.el?.classList.add('moving');
      const move = (event: PointerEvent) => {
        this.state.w = from.w + event.clientX - from.x;
        this.state.h = from.h + event.clientY - from.y;
        this.fit();
      };
      const up = () => {
        grip.removeEventListener('pointermove', move);
        grip.removeEventListener('pointerup', up);
        grip.removeEventListener('pointercancel', up);
        this.el?.classList.remove('moving');
        this.save();
      };
      grip.addEventListener('pointermove', move);
      grip.addEventListener('pointerup', up);
      grip.addEventListener('pointercancel', up);
    });
  }

  private save(): void {
    try {
      const state = this.state;
      localStorage.setItem(KEY, JSON.stringify({ ...state, x: state.x / innerWidth, y: state.y / innerHeight }));
    } catch {
      // private window: not kept
    }
  }

  /** For checking from the console. */
  describe(): { open: boolean; url: string; min: boolean; src: string | null; note: string | null } {
    return { open: !!this.el, url: this.state.url, min: this.state.min, src: this.el && !this.frame.hidden ? this.frame.src : null, note: this.el && !this.note.hidden ? this.note.textContent : null };
  }
}
