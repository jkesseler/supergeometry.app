// Browser: a web page in a window over the model (More › Insert › Browser) -
// moved by its bar, resized from its corner, minimized to its bar and closed,
// like a reference image's. An address box along the top takes a page's
// address, or a video's link (YouTube, Vimeo): the video plays right there,
// and its own full-screen button fills the screen with it.
//
// Many sites (YouTube's own pages, Google, most shops and social sites) won't
// be shown inside another page: for those the window says so and opens them
// in a tab of their own instead of showing an empty box.

import { createRef, render as mount } from 'preact';
import { RefButton, trackPointer } from './components';
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

type Page = ReturnType<typeof pageFor>;

interface WebWindowViewProps {
  state: Saved;
  addressText: string;
  page: Page | null;
  frameKey: number;
  isGrabOn: boolean;
  isMoving: boolean;
  isLifted: boolean;
  rootRef: ReturnType<typeof createRef<HTMLDivElement>>;
  addressRef: ReturnType<typeof createRef<HTMLInputElement>>;
  onAddressInput: (text: string) => void;
  onGo: (text: string) => void;
  onReload: () => void;
  onOpenOut: () => void;
  onFold: () => void;
  onClose: () => void;
  onBarDown: (event: PointerEvent) => void;
  onGripDown: (event: PointerEvent) => void;
  onGrabDown: (event: PointerEvent) => void;
}

function WebWindowView(props: WebWindowViewProps) {
  const { state, page } = props;
  const style = {
    '--z': '999',
    left: `${Math.round(state.x)}px`,
    top: `${Math.round(state.y)}px`,
    width: `${Math.round(state.w)}px`,
    height: state.min ? '' : `${Math.round(state.h)}px`
  };
  const refuse = page && 'refuse' in page ? page : null;

  return (
    <div ref={props.rootRef} class={`ref-win web-win${state.min ? ' min' : ''}${props.isMoving ? ' moving' : ''}${props.isLifted ? ' lifted' : ''}`} style={style}>
      <div
        class="ref-bar web-bar"
        onPointerDown={props.onBarDown}
        onDblClick={event => !(event.target as HTMLElement).closest('button, input') && props.onFold()}
      >
        <form
          class="web-go"
          onSubmit={(event) => {
            event.preventDefault();
            props.onGo(props.addressRef.current!.value);
            props.addressRef.current!.blur();
          }}
        >
          <input
            ref={props.addressRef}
            type="text"
            inputMode="url"
            autocomplete="off"
            spellcheck={false}
            placeholder="Address or video link"
            aria-label="Address"
            value={props.addressText}
            onInput={event => props.onAddressInput(event.currentTarget.value)}
            // (Typed in: everything selected, to type over.)
            onFocus={event => event.currentTarget.select()}
          />
        </form>
        <RefButton html={icons.reload} title="Reload" onClick={props.onReload} />
        <RefButton html={icons.share} title="Open in a new tab" onClick={props.onOpenOut} />
        <RefButton html={state.min ? icons.restore : icons.minimize} title={state.min ? 'Restore' : 'Minimize'} onClick={props.onFold} />
        <RefButton html={icons.close} title="Close" onClick={props.onClose} />
      </div>
      <div class="web-body">
        {page && 'src' in page && (
          <iframe
            key={props.frameKey}
            title="Browser"
            src={page.src}
            // (Video players need these to play and to go full screen; the page can't take this one's place.)
            allow="fullscreen; autoplay; encrypted-media; picture-in-picture; clipboard-write; web-share"
            allowFullScreen
            referrerPolicy="strict-origin-when-cross-origin"
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-presentation"
          />
        )}
        {/* Over the page: a press held (or dragged) there moves the window - the page itself never tells this one what the pointer does. */}
        <div class={`web-grab${props.isGrabOn ? ' on' : ''}`} onPointerDown={props.onGrabDown} />
        <div class="web-note" hidden={!refuse}>
          {refuse && <p>{refuse.refuse}</p>}
          {refuse?.open && (
            <button type="button" class="web-open" onClick={() => window.open(refuse.open, '_blank', 'noopener')}>
              Open it in a new tab
            </button>
          )}
        </div>
      </div>
      <div class="ref-grip" onPointerDown={props.onGripDown} />
    </div>
  );
}

export class WebWindow {
  private host: HTMLElement | null = null;
  private rootRef = createRef<HTMLDivElement>();
  private addressRef = createRef<HTMLInputElement>();
  private wired = false;
  private state: Saved = { url: '', x: 0, y: 0, w: 0, h: 0, min: false, open: false };
  private page: Page | null = null;
  private addressText = '';
  /** Changes to load the page again (the same address, or Reload). */
  private frameKey = 0;
  private isGrabOn = true;
  private isMoving = false;
  private isLifted = false;

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
    window.addEventListener('resize', () => {
      if (this.host) {
        this.fit(true);
        this.paint();
      }
    });
  }

  get isOpen(): boolean {
    return !!this.host;
  }

  /** The window up (made if it isn't), in front, its address box ready to type into when it is empty. */
  open(url?: string): void {
    if (!this.host) {
      this.make();
    }
    this.state.open = true;
    this.state.min = false;
    this.fit();
    this.paint();
    if (url !== undefined) {
      this.go(url);
    } else if (!this.state.url) {
      setTimeout(() => this.addressRef.current?.focus(), 0);
    }
    this.save();
  }

  close(): void {
    if (this.host) {
      mount(null, this.host);
      this.host.remove();
    }
    this.host = null;
    this.state.open = false;
    this.save();
  }

  private make(): void {
    this.host = document.createElement('div');
    (document.getElementById('ref-layer') ?? document.body).append(this.host);
    this.wirePage();
    if (!this.state.w) {
      const width = Math.min(640, innerWidth - 24);
      const height = Math.min(420, innerHeight - 140);
      this.state = { ...this.state, x: (innerWidth - width) / 2, y: 90, w: width, h: height };
    }
    this.fit(true);
    // (Nothing typed yet: what to type, in the window.)
    this.go(this.state.url);
  }

  private paint(): void {
    if (!this.host) {
      return;
    }
    mount(
      <WebWindowView
        state={this.state}
        addressText={this.addressText}
        page={this.page}
        frameKey={this.frameKey}
        isGrabOn={this.isGrabOn}
        isMoving={this.isMoving}
        isLifted={this.isLifted}
        rootRef={this.rootRef}
        addressRef={this.addressRef}
        onAddressInput={(text) => {
          this.addressText = text;
          this.paint();
        }}
        onGo={text => this.go(text)}
        onReload={() => this.state.url && this.go(this.state.url)}
        onOpenOut={() => {
          const page = pageFor(this.addressText || this.state.url);
          const href = 'src' in page ? page.shown : page.open;
          if (href) {
            window.open(href, '_blank', 'noopener');
          }
        }}
        onFold={() => {
          this.state.min = !this.state.min;
          this.fit();
          this.paint();
          this.save();
        }}
        onClose={() => this.close()}
        onBarDown={event => this.dragBy(event)}
        onGripDown={event => this.resizeBy(event)}
        onGrabDown={event => this.holdToMove(event)}
      />,
      this.host
    );
  }

  /** What was typed, shown: the page, or a note saying why it can't be (and a button to open it in a tab). */
  private go(text: string): void {
    if (!this.host) {
      return;
    }
    const page = pageFor(text);
    this.page = page;
    this.addressText = page.shown;
    if ('src' in page) {
      this.state.url = page.shown;
      this.frameKey++;
      this.isGrabOn = true;
    } else if (page.shown) {
      this.state.url = page.shown;
    }
    this.paint();
    this.save();
  }

  /** Kept on the screen (some of its bar always within reach); `whole` brings it all in. */
  private fit(whole = false): void {
    const state = this.state;
    if (!this.host) {
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
  }

  /**
   * The layer over the page: pressed and dragged, or held, the window moves
   * with the pointer. A tap lets the page or the video be used (the layer
   * steps aside: the player's own buttons, volume and all) until the pointer
   * is back on the model or anything else here.
   */
  private holdToMove(event: PointerEvent): void {
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
    const start = { x: event.clientX, y: event.clientY, dx: event.clientX - this.state.x, dy: event.clientY - this.state.y };
    let isDragging = false;
    const lift = () => {
      if (isDragging) {
        return;
      }
      isDragging = true;
      this.isMoving = true;
      this.isLifted = true;
      this.paint();
    };
    const hold = window.setTimeout(lift, 350);
    trackPointer(
      event.currentTarget as HTMLElement,
      event,
      (moveEvent) => {
        if (!isDragging && Math.hypot(moveEvent.clientX - start.x, moveEvent.clientY - start.y) < 8) {
          return;
        }
        lift();
        this.state.x = moveEvent.clientX - start.dx;
        this.state.y = moveEvent.clientY - start.dy;
        this.fit();
        this.paint();
      },
      (endEvent) => {
        clearTimeout(hold);
        this.isMoving = false;
        this.isLifted = false;
        if (isDragging) {
          this.paint();
          this.save();

          return;
        }
        // A tap: the page (or the video, with its own controls - volume, seek, full screen) is yours to use.
        this.arm(endEvent.type === 'pointerup' ? false : this.isGrabOn);
      }
    );
  }

  /** The page-wide listeners, once however often the window is opened again. */
  private wirePage(): void {
    if (this.wired) {
      return;
    }
    this.wired = true;
    // Back on anything else here (the model, a button, the window's bar): the layer is back over the page.
    const back = (event: Event) => {
      if (!this.host || this.isGrabOn) {
        return;
      }
      if (!this.rootRef.current?.querySelector('.web-body')?.contains(event.target as Node)) {
        this.arm(true);
      }
    };
    window.addEventListener('pointerdown', back, true);
    window.addEventListener('pointermove', back, true);
  }

  /** The layer over the page on (a hold or a drag there moves the window), or stepped aside (taps go to the page). */
  private arm(on: boolean): void {
    if (this.isGrabOn === on) {
      this.paint();

      return;
    }
    this.isGrabOn = on;
    this.paint();
  }

  /** Moved with a press on the bar (not on its box or buttons). While moving, the page doesn't take the pointer. */
  private dragBy(event: PointerEvent): void {
    if (event.button !== 0 || (event.target as HTMLElement).closest('button, input')) {
      return;
    }
    event.preventDefault();
    const dx = event.clientX - this.state.x;
    const dy = event.clientY - this.state.y;
    this.isMoving = true;
    this.paint();
    trackPointer(
      event.currentTarget as HTMLElement,
      event,
      (moveEvent) => {
        this.state.x = moveEvent.clientX - dx;
        this.state.y = moveEvent.clientY - dy;
        this.fit();
        this.paint();
      },
      () => {
        this.isMoving = false;
        this.paint();
        this.save();
      }
    );
  }

  private resizeBy(event: PointerEvent): void {
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const from = { x: event.clientX, y: event.clientY, w: this.state.w, h: this.state.h };
    this.isMoving = true;
    this.paint();
    trackPointer(
      event.currentTarget as HTMLElement,
      event,
      (moveEvent) => {
        this.state.w = from.w + moveEvent.clientX - from.x;
        this.state.h = from.h + moveEvent.clientY - from.y;
        this.fit();
        this.paint();
      },
      () => {
        this.isMoving = false;
        this.paint();
        this.save();
      }
    );
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
    const page = this.host ? this.page : null;

    return {
      open: !!this.host,
      url: this.state.url,
      min: this.state.min,
      src: page && 'src' in page ? page.src : null,
      note: page && 'refuse' in page ? page.refuse : null
    };
  }
}
