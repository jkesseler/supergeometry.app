// Undo and redo: a tool with steps of its own takes them first, then the project's.

import { SketchTool } from '../tools/sketch';
import type { App } from '../app';

export class Undoing {
  constructor(private app: App) {}

  /**
   * Undo: a tool with steps of its own (a freeform cage being shaped) takes
   * those back, and leaves the project alone while it's open - Ctrl+Z used to
   * throw the whole cage edit away and undo the step before it too.
   */
  undo(): void {
    if (this.app.tool.undo) {
      if (!this.app.tool.undo()) {
        this.app.ui.toast('Nothing to undo in this edit yet (Cancel leaves it unchanged)');
      }

      return this.update();
    }
    if (this.app.tool instanceof SketchTool) {
      if (this.app.tool.undoPoint()) {
        return;
      }
      this.app.tool.stopDrawing();
    } else if (this.app.tool !== this.app.selectTool) {
      this.app.setTool(null);
    }
    this.app.store.undo();
  }
  redo(): void {
    if (this.app.tool.redo) {
      this.app.tool.redo();

      return this.update();
    }
    if (this.app.tool instanceof SketchTool) {
      this.app.tool.stopDrawing();
    } else if (this.app.tool !== this.app.selectTool) {
      this.app.setTool(null);
    }
    this.app.store.redo();
  }
  update(): void {
    const t = this.app.tool?.undo ? this.app.tool : null;
    (document.getElementById('undo-btn') as HTMLButtonElement).disabled = t ? !t.canUndo : !this.app.store.canUndo;
    (document.getElementById('redo-btn') as HTMLButtonElement).disabled = t ? !t.canRedo : !this.app.store.canRedo;
  }
}
