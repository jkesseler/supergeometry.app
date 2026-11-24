// Offline mode (More → Offline mode). On: the app's files are downloaded to
// this device (public/sw.js keeps them), so it opens and works with no
// connection. While online it still checks the site for a new version and
// downloads that in the background, ready for the next start.
// Off: the stored files are removed and the app loads from the site as usual.

import { settings } from '../settings';
import { loadedBuild } from './update';

type Paint = (state: string) => void;

export class Offline {
  /** "" while idle, else what the More item shows (e.g. "42%"). */
  private progress = '';
  /** Toast the result of a download the person asked for (not a background one). */
  private announce = false;
  private waiters: ((ok: boolean) => void)[] = [];

  constructor(
    private toast: (text: string, kind?: 'info' | 'error') => void,
    private paint: Paint
  ) {
    this.repaint();
    // Only a built site has files to store (not the dev server).
    if (!this.supported) {
      return;
    }
    navigator.serviceWorker.addEventListener('message', e => this.onMessage(e.data));
    // On: make sure this version is stored (quick if it already is).
    if (settings.value.offline) {
      void this.download(false);
    }
    // Back online: look for a new version.
    window.addEventListener('online', () => settings.value.offline && void this.download(false));
  }

  get supported(): boolean {
    return 'serviceWorker' in navigator && 'caches' in window && !!loadedBuild() && window.isSecureContext;
  }

  private repaint(): void {
    this.paint(this.progress || (settings.value.offline ? 'On' : 'Off'));
  }

  private onMessage(message: { type?: string; done?: number; total?: number; reason?: string }): void {
    if (message?.type === 'offline-progress' && message.total) {
      this.progress = `${Math.round((100 * (message.done ?? 0)) / message.total)}%`;
      this.repaint();
    } else if (message?.type === 'offline-ready' || message?.type === 'offline-failed') {
      const ok = message.type === 'offline-ready';
      this.progress = '';
      this.repaint();
      if (this.announce) {
        this.announce = false;
        if (ok) {
          this.toast('Ready to work offline. The app opens even with no connection.');
        } else {
          this.toast(message.reason === 'offline' ? "No connection: turn Offline mode on again when you're online." : "The download stopped. It tries again next time you're online.", 'error');
        }
      }
      this.waiters.splice(0).forEach(waiter => waiter(ok));
    }
  }

  /** Switch Offline mode on or off (More → Offline mode). */
  async toggle(): Promise<void> {
    if (!this.supported) {
      this.toast("This browser can't keep the app for offline use.", 'error');

      return;
    }
    if (settings.value.offline) {
      settings.set('offline', false);
      await this.remove();
      this.repaint();
      this.toast('Offline mode off: the app loads from the site again.');

      return;
    }
    if (!navigator.onLine) {
      this.toast('Connect to the internet first: the app needs to download about 25 MB.', 'error');

      return;
    }
    settings.set('offline', true);
    // Ask the browser not to clear the stored files when space runs low.
    void navigator.storage?.persist?.().catch(() => false);
    this.toast('Downloading the app for offline use (about 25 MB)...');
    this.announce = true;
    void this.download(false);
  }

  /**
   * Download the site's current version (`fresh`: every file again). Resolves
   * when it's stored (true) or couldn't be (false). Nothing to do when off.
   */
  async download(fresh: boolean): Promise<boolean> {
    if (!settings.value.offline || !this.supported) {
      return false;
    }
    try {
      const reg = await navigator.serviceWorker.register('./sw.js');
      const worker = reg.active ?? (await navigator.serviceWorker.ready).active;
      if (!worker) {
        return false;
      }
      const done = new Promise<boolean>(resolve => this.waiters.push(resolve));
      this.progress = '0%';
      this.repaint();
      worker.postMessage({ type: 'download', fresh, keep: loadedBuild() });

      return await done;
    } catch {
      this.progress = '';
      this.repaint();

      return false;
    }
  }

  /** Remove the stored files and the service worker. */
  private async remove(): Promise<void> {
    try {
      for (const registration of await navigator.serviceWorker.getRegistrations()) {
        await registration.unregister();
      }
      for (const cacheName of await caches.keys()) {
        if (cacheName.startsWith('sg-offline-')) {
          await caches.delete(cacheName);
        }
      }
    } catch {
      // nothing stored
    }
  }
}
