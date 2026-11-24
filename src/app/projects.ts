// The project library: which project is open, switching between them, the Projects window, opening files and the first-visit tutorial question.

import { parseProject } from '../doc/store';
import { emptyDoc } from '../doc/types';
import { currentProjectId, forgetProject, keepProject, libraryEntries, newProjectId, projectText, renameProject, setCurrentProject } from '../doc/library';
import { acceptFor } from '../io/insert';
import { SketchTool } from '../tools/sketch';
import { showLibrary } from '../ui/library';
import { askAboutTutorial } from '../ui/tutorialAsk';
import { download } from './exporting';
import type { App } from '../app';
import type { ProjectDoc } from '../doc/types';

export class Projects {
  constructor(private app: App) {}

  /**
   * New project: the current one can be saved (downloaded) or discarded
   * first. Then the app checks for a newer version and, if there is one,
   * clears its cached files and reloads - a new project starts on the latest.
   */
  async newProject(): Promise<void> {
    const was = this.app.store.features.length ? this.app.store.doc.name : null;
    await this.switchTo(emptyDoc(), newProjectId());
    if (was) {
      this.app.ui.toast(`“${was}” is kept in File → Open`);
    }
    // The first minute makes something: a new project opens in a sketch on the floor with Line on, as every new
    // sketch does - tap, tap, back to the start: a shape; Exit pulses, the shape is pulled up.
    if (!this.app.store.features.length && this.app.tool === this.app.selectTool) {
      this.app.setTool(new SketchTool(this.app, { plane: { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, 0, 1] }, kind: 'line' }));
    }
    if (await this.app.updates.check()) {
      await this.app.updates.reset();
    }
  }

  /** Which library project is open; null until the saved project is read. */
  projectId: string | null = null;
  /** The open project has an entry in the library (an empty new one doesn't, yet). */
  private projectKept = false;

  /** Startup: the open project is the library's current one (work from before the library is kept now). */
  async attach(): Promise<void> {
    let id = await currentProjectId();
    if (!id) {
      id = newProjectId();
      await setCurrentProject(id);
    }
    this.projectId = id;
    this.projectKept = (await libraryEntries()).some(e => e.id === id);
    // The library's copy follows when the app goes to the background (the
    // autosave holds the newest state meanwhile, and is copied in at the next
    // start if need be) - no extra saving or drawing while modelling.
    this.app.store.onSaved = text => document.visibilityState === 'hidden' && void this.keep(text);
    // Its newest state is the autosave (a page closed mid-save left the library a step behind).
    const text = JSON.stringify(this.app.store.doc);
    // (No picture: nothing is drawn yet.)
    if ((this.projectKept || this.app.store.features.length) && (await projectText(id)) !== text) {
      this.projectKept = true;
      await keepProject(id, this.app.store.doc.name, text);
    }
  }

  /** The open project into the library: with a new picture of the view now and then (it costs a moment). */
  async keep(text: string, picture = false): Promise<void> {
    const id = this.projectId;
    if (!id || (!this.projectKept && !this.app.store.features.length)) {
      return;
    }
    // A new picture: opening the gallery, leaving the project, or the app going to the background.
    const snap = picture || document.visibilityState === 'hidden';
    this.projectKept = true;
    await keepProject(id, this.app.store.doc.name, text, snap ? this.viewPicture() : undefined);
  }

  /** A small picture of the model (as the view looks at it, framed to fit), for the library. */
  private viewPicture(): string | undefined {
    try {
      return this.app.view.snapshot(320, 240, getComputedStyle(document.body).backgroundColor || '#2b2d31');
    } catch {
      return undefined;
    }
  }

  /** Close the open project (it's kept, with a fresh picture) and open another. */
  async switchTo(doc: ProjectDoc, id: string): Promise<void> {
    this.app.setTool(null);
    this.app.setSection(null);
    this.app.isolate(null);
    if (this.projectId) {
      await this.keep(JSON.stringify(this.app.store.doc), true);
    }
    const kept = (await libraryEntries()).some(e => e.id === id);
    await setCurrentProject(id);
    // The id and the document change together: an autosave due meanwhile went to the old project.
    this.projectId = id;
    this.projectKept = kept;
    // The last one's rebuild, if it is still going, is no use now: dropped, not waited for
    // (opening a small project while a guitar was still being built took the guitar's 90 s).
    if (this.app.kernel.running) {
      this.app.kernel.stop();
    }
    this.app.store.openDoc(doc);
    // A new one starts from the default view (not looking up from below, as the last was left).
    if (!doc.features.length) {
      this.app.view.cam.iso();
    }
    setTimeout(() => this.app.fit(), 400);
  }

  /** File → Open: the projects kept on this device, and Open file… for any other. */
  /** Full screen from the projects window (null: not offered here). */
  fullscreen: { isFull(): boolean; toggle(): void } | null = null;

  async show(welcome = false, starting = false): Promise<void> {
    // The open one with its picture as it looks now (starting: nothing has changed, nor is it drawn yet).
    if (this.projectId && !starting) {
      await this.keep(JSON.stringify(this.app.store.doc), true);
    }
    const entries = await libraryEntries();
    showLibrary(entries, this.projectId, {
      open: id => void this.openKept(id),
      tutorial: () => (this.tutorialAsked(), this.app.startTutorial()),
      newProject: () => void this.newProject(),
      openFile: () => this.openFile(),
      download: id => void this.downloadKept(id),
      remove: id => forgetProject(id),
      rename: async (id, current) => {
        const name = (await this.app.ui.dialog('Rename project', [{ key: 'name', label: 'Name', value: current }]))?.name.trim();
        if (!name || name === current) {
          return null;
        }
        // The open one through its document (the top bar and its autosave follow).
        if (id === this.projectId) {
          this.app.store.commit(draft => (draft.name = name));
        } else {
          await renameProject(id, name);
        }

        return name;
      }
    }, { welcome, fullscreen: this.fullscreen, onClose: welcome ? () => this.offerTutorial() : undefined });
  }

  /** The tutorial has been offered on this device (or begun): it isn't offered again. */
  tutorialAsked(): void {
    try {
      localStorage.setItem('sg.tutorialAsked', '1');
    } catch {
      /* a private window: asked again next time */
    }
  }

  /**
   * The first time the app is opened on a device, once the welcome window is closed: would they like the tutorial?
   * Asked once, whatever the answer (More > Tutorial has it from then on). (Asked for: "a popup only for the first
   * time someone opens the app, after they close the welcome window, that asks them if they want to start the
   * tutorial".)
   */
  private offerTutorial(): void {
    let asked = true;
    try {
      asked = localStorage.getItem('sg.tutorialAsked') === '1';
    } catch {
      /* no storage: not offered (it would be offered every time) */
    }
    if (asked) {
      return;
    }
    this.tutorialAsked();
    // (After what closing the window started - a new project, a file being opened - has had its turn.)
    setTimeout(() => {
      // (The welcome window was closed by its own Tutorial button: the tutorial is running, there is nothing to
      // ask - the question came up over it, where the tutorial lets nothing be tapped but its lit spot. Reported:
      // "now i cant do the tutorial on PC. i cant click draw", in a private window - a first visit.)
      if (this.app.tutorial?.running) {
        return;
      }
      askAboutTutorial(() => this.app.startTutorial());
    }, 350);
  }

  private async openKept(id: string): Promise<void> {
    const text = await projectText(id);
    if (!text) {
      return this.app.ui.toast("That project couldn't be read", 'error');
    }
    try {
      await this.switchTo(parseProject(text), id);
    } catch (err) {
      this.app.ui.toast(`Could not open: ${(err as Error).message}`, 'error');
    }
  }

  private async downloadKept(id: string): Promise<void> {
    const text = await projectText(id);
    const e = (await libraryEntries()).find(libraryEntry => libraryEntry.id === id);
    if (text && e) {
      download(new Blob([text], { type: 'application/json' }), `${e.name}.super`);
    }
  }

  openFile(): void {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = acceptFor('.super,.tessel,application/json');
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) {
        return;
      }
      try {
        const doc = parseProject(await file.text());
        doc.name = file.name.replace(/\.(super|tessel)$/i, '');
        // A project of its own in the library (the open one is kept as it was).
        await this.switchTo(doc, newProjectId());
      } catch (err) {
        this.app.ui.toast(`Could not open: ${(err as Error).message}`, 'error');
      }
    };
    input.click();
  }
}
