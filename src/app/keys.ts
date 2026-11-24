// Keyboard shortcuts, the pointer position they use, the standard views and the command search.

import { findAction, openCommandSearch, showShortcuts } from '../ui/commands';
import { SketchTool } from '../tools/sketch';
import type { Vec3 } from '../doc/types';
import type { App } from '../app';

export class Keys {
  constructor(private app: App) {}

  attach(): void {
    window.addEventListener('keydown', e => this.onKey(e));
    this.app.view.canvas.addEventListener('pointermove', (e) => {
      const rect = this.app.view.canvas.getBoundingClientRect();
      this.pointerAt = [e.clientX - rect.left, e.clientY - rect.top];
    });
    this.app.view.canvas.addEventListener('pointerleave', () => (this.pointerAt = null));
  }

  private onKey(e: KeyboardEvent): void {
    // Typing while holding a drag sets an exact value; Enter applies it and finishes.
    // (Checked first: a panel field may still have focus from before the drag.)
    if (this.app.input.dragging && this.app.tool.dragKey?.(e)) {
      e.preventDefault();
      (document.activeElement as HTMLElement | null)?.blur?.();
      if (e.key === 'Enter') {
        this.app.input.endDrag();
      }

      return;
    }
    const target = e.target as HTMLElement;
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) {
      return;
    }
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    if (mod && key === 'z') {
      e.preventDefault();
      if (e.shiftKey) {
        this.app.redo();
      } else {
        this.app.undo();
      }

      return;
    }
    if (mod && key === 'y') {
      e.preventDefault();
      this.app.redo();

      return;
    }
    // Select Through: pick what's behind the faces in front.
    if (mod && e.shiftKey && key === 's') {
      e.preventDefault();
      this.app.view.setSelectThrough(!this.app.view.selectThrough);
      this.app.ui.toast(this.app.view.selectThrough ? 'Select Through on: edges and sketches behind the faces can be picked' : 'Select Through off');

      return;
    }
    if (mod && key === 's') {
      e.preventDefault();
      this.app.exporter.save();

      return;
    }
    // Everything: Ctrl+A (the bodies, or with none the sketches' shapes; in a sketch, its curves).
    if (mod && !e.shiftKey && key === 'a') {
      e.preventDefault();
      this.app.tool.selectAll?.();

      return;
    }
    // Search commands: Ctrl+F anywhere (X too, outside a sketch - see below).
    if (mod && key === 'f') {
      e.preventDefault();
      this.searchCommands();

      return;
    }
    // The standard views: Ctrl (or Alt, where the browser keeps Ctrl+1… for its tabs) + 1 to 7.
    if ((mod || e.altKey) && /^[1-7]$/.test(e.key)) {
      e.preventDefault();
      this.viewByNumber(Number(e.key));

      return;
    }
    if (this.app.tool.key?.(e)) {
      e.preventDefault();

      return;
    }
    // Space over a face: zoom to it.
    if (key === ' ' && !mod && this.pointerAt) {
      const hit = this.app.view.pick(this.pointerAt[0], this.pointerAt[1], { edges: false, planes: false, profiles: false });
      if (hit?.kind === 'face' && this.app.view.zoomToFace(hit.body, hit.face)) {
        e.preventDefault();
      }

      return;
    }
    if (this.app.tool !== this.app.selectTool) {
      return;
    }
    // The booleans: Ctrl+U / B / I.
    if (mod && !e.shiftKey && (key === 'u' || key === 'b' || key === 'i')) {
      if (this.runCommand([{ u: 'Union', b: 'Subtract', i: 'Intersect' }[key]])) {
        e.preventDefault();
      }

      return;
    }
    if (mod || e.altKey) {
      return;
    }
    if (key === 'x') {
      return void (e.preventDefault(), this.searchCommands());
    }
    if (e.key === '?') {
      return void showShortcuts();
    }
    const none = !this.app.selection.length;
    if (key === 's' && none) {
      return void this.app.setTool(new SketchTool(this.app));
    }
    if (key === 'f' && none) {
      return void this.app.fit();
    }
    // A drawing tool's letter with nothing picked: a sketch, with that tool (once its plane is picked).
    const draw: Record<string, 'line' | 'arc' | 'circle' | 'rect' | 'polygon' | 'spline' | 'offset' | 'trim'> = { l: 'line', a: 'arc', c: 'circle', r: 'rect', g: 'polygon', i: 'spline', o: 'offset', t: 'trim' };
    if (draw[key] && none && !e.shiftKey) {
      return void this.app.setTool(new SketchTool(this.app, { kind: draw[key] }));
    }
    // A modeling tool's letter: that tool, for what's picked (or waiting for it).
    const tools: Record<string, string[]> = {
      e: ['Extrude', 'Offset Face'],
      f: ['Fillet'],
      h: ['Shell'],
      m: ['Move/Rotate'],
      n: ['Translate'],
      p: ['Project as Sketch'],
      s: ['Scale', 'Scale Sketch'],
      v: ['Revolve'],
      w: ['Sweep'],
      o: ['Offset Edge']
    };
    if (tools[key] && !e.shiftKey && this.runCommand(tools[key])) {
      e.preventDefault();
    }
  }

  /** Where the pointer was last over the view (Space zooms to the face there). */
  private pointerAt: [number, number] | null = null;

  /** Run the first of these commands that's offered now (the picked thing's tools first). */
  private runCommand(labels: string[]): boolean {
    const hit = findAction(this.app.ui.offered(), this.app.mainTools(), labels);
    if (!hit) {
      return false;
    }
    hit.item.run!();

    return true;
  }

  private searchCommands(): void {
    openCommandSearch(
      () => this.app.ui.offered(),
      () => [...this.app.mainTools(), { id: 'shortcuts', label: 'Keyboard shortcuts', icon: 'menu', shortcut: '?', run: () => showShortcuts() }]
    );
  }

  /** 1 the default view; 2-7 front, back, top, bottom, right, left. */
  private viewByNumber(viewNumber: number): void {
    const cam = this.app.view.cam;
    if (viewNumber === 1) {
      cam.iso();
      this.app.view.fitAll();

      return;
    }
    const views: [Vec3, Vec3?][] = [
      [[0, -1, 0]],
      [[0, 1, 0], [-1, 0, 0]],
      [[0, 0, 1]],
      [[0, 0, -1]],
      [[1, 0, 0], [0, 1, 0]],
      [[-1, 0, 0], [0, -1, 0]]
    ];
    const [normal, xDir] = views[viewNumber - 2];
    cam.lookAlong(normal, xDir);
  }
}
