// The top bar: the File and More menus, fullscreen, the tutorial and the undo buttons.

import { Vector3 } from 'three';
import { settings } from '../settings';
import { SUPPORT, openSupport } from '../ui/support';
import { SketchTool, sketchSides, sketchVariant } from '../tools/sketch';
import { Tutorial, type TutorialHost } from '../ui/tutorial';
import { edgeRefOf, type Sel } from '../tools/tool';
import { HelpPanel } from '../ui/help';
import { icons } from '../ui/icons';
import { Updates } from '../ui/update';
import { Offline } from '../ui/offline';
import { Install } from '../ui/install';
import { canShareType } from '../app/exporting';
import { showWhatsNew } from '../ui/whatsNew';
import { wireProjectName } from './projectName';
import type { EdgeRef, Vec3 } from '../doc/types';
import type { App } from '../app';

export class Topbar {
  constructor(private app: App) {}

  private on = (id: string, fn: () => void) => document.getElementById(id)!.addEventListener('click', fn);
  private get menu() {
    return document.getElementById('file-menu')!;
  }
  private get more() {
    return document.getElementById('more-menu')!;
  }
  private moreItem = (id: string, fn: () => void) => this.on(id, () => ((this.more.hidden = true), fn()));

  attach(): void {
    this.menuButtons();
    this.fullscreen();
    this.moreMenu();
    this.wireTutorial();
    this.moreLinks();
    this.fileMenu();
    wireProjectName(this.app);
  }

  private menuButtons(): void {
    const { on, menu, more } = this;
    // Phones: one thing open at a time at the left - a menu closes Items.
    // Phones: one thing open at a time - a menu takes the place of Items and of History.
    const phoneItemsAway = () => {
      if (window.innerWidth > 720) {
        return;
      }
      if (document.getElementById('items')!.classList.contains('open')) {
        this.app.items.toggle(false);
      }
      if (document.body.classList.contains('history-open')) {
        this.app.ui.toggleHistory(false);
      }
    };
    on('file-btn', () => ((more.hidden = true), menu.toggleAttribute('hidden'), !menu.hidden && phoneItemsAway()));
    on('more-btn', () => ((menu.hidden = true), more.toggleAttribute('hidden'), !more.hidden && phoneItemsAway()));
    on('history-btn', () => ((menu.hidden = more.hidden = true), this.app.ui.toggleHistory()));
    document.getElementById('m-version')!.textContent = `Version ${__APP_VERSION__} · What's new`;
    this.on('m-version', () => ((this.more.hidden = true), showWhatsNew(__APP_VERSION__)));
  }

  private fullscreen(): void {
    const { moreItem } = this;
    // Fullscreen (the label follows the state; Esc also leaves it).
    const fs = document.getElementById('m-fullscreen')!;
    const doc = document as Document & { webkitFullscreenElement?: Element; webkitExitFullscreen?: () => void };
    const root = document.documentElement as HTMLElement & { webkitRequestFullscreen?: () => void };
    const isFull = () => !!(document.fullscreenElement ?? doc.webkitFullscreenElement);
    const paint = () => {
      fs.firstChild!.textContent = isFull() ? 'Exit fullscreen' : 'Fullscreen';
      // Tablets draw their own close button at the top left in fullscreen: the top bar makes room.
      document.body.classList.toggle('is-fullscreen', isFull());
    };
    document.addEventListener('fullscreenchange', paint);
    document.addEventListener('webkitfullscreenchange', paint);
    const goFull = () => {
      if (root.requestFullscreen) {
        void root.requestFullscreen().catch(() => this.app.ui.toast("This browser won't go fullscreen here"));
      } else if (root.webkitRequestFullscreen) {
        root.webkitRequestFullscreen();
      } else {
        // iPhone Safari has no fullscreen for pages: the Home Screen app is.
        this.app.ui.toast('Tip: Share → Add to Home Screen opens superGeometry.app full screen');
      }
    };
    moreItem('m-fullscreen', () => {
      if (isFull()) {
        return void (document.exitFullscreen?.() ?? doc.webkitExitFullscreen?.());
      }
      goFull();
    });
    // The welcome window (and File → Open) has a Full screen button too (a
    // browser only allows it from a tap). Everywhere but an app that already
    // has the whole screen; where a browser has none (iPhone), it says how.
    this.app.projects.fullscreen = !matchMedia('(display-mode: fullscreen)').matches ? { isFull, toggle: () => (isFull() ? void (document.exitFullscreen?.() ?? doc.webkitExitFullscreen?.()) : goFull()) } : null;
  }

  private moreMenu(): void {
    const { moreItem } = this;
    // Help and Tutorial: placeholders for now.
    // A newer build out? More pulses and its Update item says NEW.
    this.app.updates = new Updates(async () => {
      try {
        await this.app.store.flush();

        return true;
      } catch (error) {
        console.error('[Topbar] project not saved, so not reloading:', error);
        this.app.ui.toast('The project could not be saved on this device, so the app did not reload', 'error');

        return false;
      }
    });
    moreItem('m-update', () => void this.app.confirmReset());
    // Phones and tablets: an offer to add the app to the home screen (More → Install app too).
    const install = new Install(t => this.app.ui.toast(t));
    const inst = document.getElementById('m-install')!;
    document.getElementById('more-btn')!.addEventListener('click', () => (inst.hidden = !install.available));
    moreItem('m-install', () => install.offer(true));
    // Help: a panel explaining every button (toggle it from More → Help).
    const help = new HelpPanel();
    moreItem('m-help', () => help.toggle());
    // The guide text (what to tap next): on or off.
    // (Each a switch on its row - they said On or Off in words. Asked for: "make the two buttons (guide text and
    // offline mode) have a toggle icon. I don't like how right now it's only on or off in text".)
    const switchOf = (id: string, on: boolean) => {
      const b = document.getElementById(id)!;
      b.classList.toggle('on', on);
      b.setAttribute('aria-checked', String(on));
    };
    const paintHints = () => switchOf('m-hints', settings.value.showHints);
    paintHints();
    // (Also switched off by the × on the guide text itself.)
    settings.onChange(paintHints);
    moreItem('m-hints', () => {
      settings.set('showHints', !settings.value.showHints);
      paintHints();
      this.app.ui.refreshHint();
    });
    // Offline mode: the app kept on this device, so it works with no connection.
    const offlineState = document.getElementById('m-offline-state')!;
    // (Its switch; beside it only how far the download is while it runs.)
    const offline = new Offline((t, kind) => this.app.ui.toast(t, kind), state => ((offlineState.textContent = state === 'On' || state === 'Off' ? '' : state), switchOf('m-offline', settings.value.offline)));
    this.app.updates.offline = { get on() {
      return settings.value.offline; 
    }, download: fresh => offline.download(fresh) };
    moreItem('m-offline', () => void offline.toggle());
  }

  private wireTutorial(): void {
    const { moreItem } = this;
    // The tutorial: a first part, built one lit tap at a time (see ui/tutorial.ts).
    const tutorial = new Tutorial({
      tool: () => this.app.tool as unknown as ReturnType<TutorialHost['tool']>,
      selection: () => this.app.selection,
      setSelection: sel => this.app.setSelection(sel),
      features: () => this.app.store.features,
      toScreen: point => this.app.view.toScreen(new Vector3(point[0], point[1], point[2])),
      canvas: () => this.app.view.canvas,
      faces: body => (this.app.view.body(body)?.faces ?? []).map(faceInfo => ({ center: faceInfo.center, normal: faceInfo.normal, type: faceInfo.type })),
      bodies: () => this.app.view.bodyList.map(b => b.id),
      eye: () => this.app.view.cam.camera.position,
      newProject: () => this.app.projects.newProject(),
      setUp: () => (sketchVariant('circle', 'center'), sketchSides(6)),
      closePanels: () => (this.app.ui.toggleHistory(false), this.app.items.toggle(false)),
      zoomTo: (mm, px) => {
        const now = this.app.view.cam.worldPerPixel(this.app.view.height);
        const want = mm / px;
        const off = this.app.view.cam.target.lengthSq() > 1e-12;
        // (Asked for each frame until the first circle is drawn: nothing is done when the view is there already.)
        if (!(now > 0) || (!off && Math.abs(now / want - 1) < 1e-3)) {
          return;
        }
        this.app.view.cam.target.set(0, 0, 0);
        this.app.view.cam.zoom(want / now);
        this.app.view.requestRender();
      },
      chamferAt: (z) => {
        const t = this.app.tool as unknown as { id: string; feature?: { edges: EdgeRef[] }; edgeSels?(): Sel[]; update?(): void };
        const body = t.feature?.edges[0]?.body;
        if (t.id !== 'chamfer' || !t.feature || !body) {
          return;
        }
        const flat = (point: Vec3) => Math.abs(point[2] - z) < 1e-6;
        // (Once: with them chamfered, the body as it is shown has new edges at that height - the cuts' own.)
        if (t.feature.edges.some(e => flat(e.mid))) {
          return;
        }
        const have = (midpoint: Vec3) => t.feature!.edges.some(e => e.body === body && Math.hypot(e.mid[0] - midpoint[0], e.mid[1] - midpoint[1], e.mid[2] - midpoint[2]) < 1e-6);
        let added = false;
        (this.app.view.body(body)?.edges ?? []).forEach((e, i) => {
          if (e.type !== 'LINE' || !flat(e.start) || !flat(e.end) || have(e.mid)) {
            return;
          }
          const ref = edgeRefOf(this.app, { body, edge: i });
          if (ref) {
            (t.feature!.edges.push(ref), (added = true));
          }
        });
        if (!added) {
          return;
        }
        if (t.edgeSels) {
          this.app.setSelection(t.edgeSels());
        }
        t.update?.();
      },
      plainTaps: on => void (this.app.input.plainTaps = on),
      exact: (kind, centre, edge) => void (this.app.tool instanceof SketchTool && this.app.tool.exact(kind, centre, edge)),
      setNumber: (field, mm) => {
        const t = this.app.tool as unknown as { id: string; feature?: Record<string, unknown>; render?(): void; update?(): void; setPitch?(v: number): void };
        if (!t.feature || t.id !== { clearance: 'boolean', distance: 'extrude', start: 'extrude', pitch: 'thread' }[field]) {
          return;
        }
        // (A thread: a plain right-hand one of one start, whatever the thread made last on a rod this size was.)
        if (field === 'pitch') {
          t.feature.left = undefined;
          t.feature.starts = undefined;
          t.setPitch?.(mm);

          return;
        }
        t.feature[field] = mm;
        t.render?.();
        t.update?.();
      }
    });
    this.app.tutorial = tutorial;
    moreItem('m-tutorial', () => this.app.startTutorial());
    this.app.startTutorial = () => {
      // (The question whether to start it, should it be up: answered.)
      document.querySelector('.dialog.tutorial-ask')?.closest('.dialog-back')?.remove();
      void tutorial.start();
    };
  }

  private moreLinks(): void {
    const { on, moreItem } = this;
    // About: the README, in the app. Support links open in a new tab (no access back to this page).
    moreItem('m-about', () => import('../ui/about').then(({ showAbout }) => showAbout()));
    // Feedback: a bug report, suggestion or discussion, posted on r/supergeometry (Reddit's page, in a new tab).
    // (Loaded on the first tap: most visits never open it.)
    moreItem('m-feedback', () => void import('../ui/feedback').then(({ showFeedback }) => showFeedback()));
    // Support: a short list of ways (each opens in a new tab). One without a link yet says so.
    const donateList = document.getElementById('m-donate-list')!;
    on('m-donate', () => {
      donateList.hidden = !donateList.hidden;
      document.getElementById('m-donate-arrow')!.textContent = donateList.hidden ? '▸' : '▾';
    });
    for (const { id, url } of SUPPORT) {
      const b = document.getElementById(`m-support-${id}`);
      if (!b) {
        continue;
      }
      if (!url) {
        b.querySelector('.menu-soon')!.textContent = 'soon';
        b.classList.add('disabled');
      }
      moreItem(`m-support-${id}`, () => (url ? openSupport(url) : this.app.ui.toast('Coming soon')));
    }
  }

  private fileMenu(): void {
    const { on, menu, more } = this;
    document.addEventListener('pointerdown', (e) => {
      if (!(e.target as HTMLElement).closest('#file-menu, #file-btn')) {
        menu.hidden = true;
      }
      if (!(e.target as HTMLElement).closest('#more-menu, #more-btn')) {
        more.hidden = true;
      }
    });
    const item = (id: string, fn: () => void) =>
      on(id, () => {
        menu.hidden = true;
        fn();
      });
    item('m-new', () => void this.app.projects.newProject());
    item('m-open', () => void this.app.projects.show());
    item('m-save', () => this.app.exporter.save());
    item('m-stl', () => void this.app.exporter.export('stl'));
    item('m-step', () => void this.app.exporter.export('step'));
    item('m-3mf', () => void this.app.exporter.export3mf());
    item('m-glb', () => void this.app.exporter.exportGLB());
    item('m-each', () => {
      // Which format each body is saved in: a menu where the File menu was.
      const rect = document.getElementById('file-btn')!.getBoundingClientRect();
      const row = (format: 'stl' | 'step' | '3mf' | 'glb', label: string) => ({ label, run: () => void this.app.exporter.exportEach(format) });
      this.app.ui.menu(rect.left, rect.bottom + 4, [row('stl', 'Each body as STL'), row('step', 'Each body as STEP'), row('3mf', 'Each body as 3MF'), row('glb', 'Each body as GLB')]);
    });
    item('m-dxf', () => this.app.exporter.exportDXF());
    item('m-svg', () => this.app.exporter.exportDXF('download', 'svg'));
    // A share button at the right of each export (and Save): straight to the share sheet.
    // Only for the file types this browser will really share (Chrome on Android,
    // for one, refuses 3D and CAD files: a button there would only download).
    {
      const shares: [string, string, () => void][] = [
        ['m-save', 'super', () => this.app.exporter.save('share')],
        ['m-stl', 'stl', () => void this.app.exporter.export('stl', 'share')],
        ['m-step', 'step', () => void this.app.exporter.export('step', 'share')],
        ['m-3mf', '3mf', () => void this.app.exporter.export3mf('share')],
        ['m-glb', 'glb', () => void this.app.exporter.exportGLB('share')],
        ['m-dxf', 'dxf', () => this.app.exporter.exportDXF('share')],
        ['m-svg', 'svg', () => this.app.exporter.exportDXF('share', 'svg')]
      ];
      // Android's share sheet turns these files away or mangles them: downloads only there.
      const android = /Android/i.test(navigator.userAgent);
      for (const [id, ext, run] of shares) {
        if (android || !canShareType(ext)) {
          continue;
        }
        const btn = document.getElementById(id)!;
        const sh = document.createElement('span');
        sh.className = 'menu-share';
        sh.setAttribute('role', 'button');
        sh.title = 'Share';
        sh.innerHTML = icons.share;
        sh.addEventListener('click', (e) => {
          e.stopPropagation();
          menu.hidden = true;
          run();
        });
        btn.append(sh);
      }
    }
    on('undo-btn', () => this.app.undo());
    on('redo-btn', () => this.app.redo());
    this.app.store.onChange(() => this.app.updateUndo());
    this.app.updateUndo();

  }
}
