// Saving and exporting: the project file, STL/STEP/3MF/GLB, DXF/SVG sketches - downloaded, or shared on phones and tablets.

import { sketchToDXF } from '../io/dxf';
import { glb } from '../io/formats';
import { sketchToSVG } from '../io/svg';
import { exportThreeMF, zip } from '../io/threemf';
import { bodiesOf } from '../tools/tool';
import { showPrintShare } from '../ui/printShare';
import type { App } from '../app';
import type { ExportFormat } from '../kernel/protocol';
import type { SketchFeature } from '../doc/types';

export class Exporter {
  constructor(private app: App) {}

  save(how: Delivery = 'download'): void {
    void this.deliver(new Blob([JSON.stringify(this.app.store.doc)], { type: 'application/json' }), `${this.app.store.doc.name}.super`, how);
  }

  /**
   * Hand a made file over: download it, or share it (phones and tablets:
   * the system share sheet - mail, messages, a slicer app…).
   */
  async deliver(blob: Blob, name: string, how: Delivery): Promise<void> {
    if (how === 'download') {
      return download(blob, name);
    }
    const ext = name.split('.').pop()!.toLowerCase();
    const file = new File([blob], name, { type: MIME[ext] ?? (blob.type || 'application/octet-stream') });
    if (!canShare(file)) {
      this.app.ui.toast(`This browser can't share .${ext} files - downloaded instead`, 'error');

      return download(blob, name);
    }
    const share = () => navigator.share({ files: [file], title: name });
    try {
      await share();
    } catch (err) {
      const why = (err as Error).name;
      if (why === 'AbortError') {
        return;
      } // closed the share sheet
      if (why !== 'NotAllowedError') {
        this.app.ui.toast("Sharing didn't work here - downloaded instead", 'error');

        return download(blob, name);
      }
      // Making the file took a moment and the browser no longer counts this as a
      // tap: one more tap shares it.
      // The share sheet is opened right in that tap (not after it), as iOS requires.
      let again: Promise<void> | null = null;
      const go = await this.app.ui.ask('Ready to share', name, [
        { id: 'share', label: 'Share', primary: true, run: () => (again = share()) },
        { id: 'dl', label: 'Download instead' }
      ]);
      if (go === 'share' && again) {
        try {
          await again;
        } catch (e) {
          if ((e as Error).name === 'AbortError') {
            return;
          }
          this.app.ui.toast("Sharing isn't available here - downloaded instead", 'error');
          download(blob, name);
        }
      } else if (go === 'dl') {
        download(blob, name);
      }
    }
  }

  /**
   * DXF of a sketch: the one open (e.g. picked in Items), or the one whose
   * curves or regions are selected. Without one, say how to pick it.
   */
  exportDXF(how: Delivery = 'download', as: 'dxf' | 'svg' = 'dxf'): void {
    const fromSel = this.app.selection.flatMap(highlight => (highlight.kind === 'curve' || highlight.kind === 'point' || highlight.kind === 'profile' ? [highlight.sketch] : []))[0];
    const id = this.app.tool.activeSketch ?? fromSel;
    const sk = id ? this.app.store.find<SketchFeature>(id) : undefined;
    if (!sk || sk.type !== 'sketch') {
      this.app.ui.toast(`Select a sketch first: open Items, tap the sketch, then File → Export ${as.toUpperCase()}.`);
      if (!document.getElementById('items')?.classList.contains('open')) {
        this.app.items.toggle(true);
      }

      return;
    }
    if (!sk.entities.length) {
      return this.app.ui.toast('That sketch is empty');
    }
    // (SVG: for a laser cutter, a plotter, a drawing program - millimetres, the page just round the drawing.)
    const file = as === 'svg' ? new Blob([sketchToSVG(sk.entities, `${this.app.store.doc.name} - ${sk.name}`)], { type: 'image/svg+xml' }) : new Blob([sketchToDXF(sk.entities)], { type: 'application/dxf' });
    void this.deliver(file, `${this.app.store.doc.name} - ${sk.name}.${as}`, how);
    this.app.ui.toast(`Exported “${sk.name}” as ${as.toUpperCase()}`);
  }

  /** The bodies to export (chosen, else shown) with their fine meshes - for GLB. */
  async fineMeshes(ids: string[]): Promise<{ name: string; positions: Float32Array; indices: Uint32Array; color?: string; opacity?: number }[]> {
    const fine = JSON.parse(await (await this.app.kernel.export(this.app.store.doc.features, 'mesh', ids)).text()) as { id: string; positions: number[]; indices: number[] }[];
    const names = this.app.store.doc.names ?? {};

    return ids.flatMap((id) => {
      const b = this.app.result?.bodies.find(body => body.id === id);
      const fineMesh = fine.find(bodyMesh => bodyMesh.id === id);
      if (!b) {
        return [];
      }

      return [{ name: names[id] ?? b.name, positions: fineMesh ? new Float32Array(fineMesh.positions) : b.positions, indices: fineMesh ? new Uint32Array(fineMesh.indices) : b.indices, color: this.app.store.doc.colors?.[id], opacity: this.app.store.doc.opacity?.[id] }];
    });
  }

  /** GLB (one-file glTF): for the web, AR and renderers - the bodies' meshes and colours. */
  async exportGLB(how: Delivery = 'download'): Promise<void> {
    const ids = chosenBodies(this.app);
    const bodies = (this.app.result?.bodies ?? []).filter(b => (ids.length ? ids.includes(b.id) : !this.app.view.isHidden(b.id)));
    if (!bodies.length) {
      return this.app.ui.toast('Nothing to export');
    }
    try {
      this.app.ui.setStatus('Exporting GLB…');
      const out = glb(await this.fineMeshes(bodies.map(b => b.id)), this.app.store.doc.name);
      await this.deliver(new Blob([out as BlobPart], { type: 'model/gltf-binary' }), `${this.app.store.doc.name}.glb`, how);
    } catch (err) {
      this.app.ui.toast(`Export failed: ${(err as Error).message}`, 'error');
    } finally {
      this.app.ui.setStatus(null);
    }
  }

  /** Each body in a file of its own (named after it), together in a ZIP. */
  async exportEach(format: 'stl' | 'step' | '3mf' | 'glb'): Promise<void> {
    const ids = chosenBodies(this.app);
    const bodies = (this.app.result?.bodies ?? []).filter(b => (ids.length ? ids.includes(b.id) : !this.app.view.isHidden(b.id)));
    if (!bodies.length) {
      return this.app.ui.toast('Nothing to export');
    }
    const names = this.app.store.doc.names ?? {};
    const used = new Set<string>();
    const fileName = (id: string, fallback: string) => {
      const base = (names[id] ?? fallback).replace(/[\\/:*?"<>|]+/g, '-').trim() || 'Body';
      let name = base;
      for (let suffix = 2; used.has(name.toLowerCase()); suffix++) {
        name = `${base} ${suffix}`;
      }
      used.add(name.toLowerCase());

      return `${name}.${format}`;
    };
    try {
      const files: { name: string; data: Uint8Array }[] = [];
      for (const [i, b] of bodies.entries()) {
        this.app.ui.setStatus(`Exporting body ${i + 1} of ${bodies.length}…`);
        let blob: Blob;
        if (format === 'glb') {
          blob = new Blob([glb(await this.fineMeshes([b.id]), names[b.id] ?? b.name) as BlobPart]);
        } else if (format === '3mf') {
          const [fineMesh] = await this.fineMeshes([b.id]);
          blob = await exportThreeMF([fineMesh], fineMesh.name, await this.app.kernel.export(this.app.store.doc.features, 'step', [b.id]));
        } else {
          blob = await this.app.kernel.export(this.app.store.doc.features, format, [b.id]);
        }
        files.push({ name: fileName(b.id, b.name), data: new Uint8Array(await blob.arrayBuffer()) });
      }
      const out = await zip(files);
      await this.deliver(new Blob([out], { type: 'application/zip' }), `${this.app.store.doc.name} - ${bodies.length} ${bodies.length === 1 ? 'body' : 'bodies'}.zip`, 'download');
      this.app.ui.toast(`${bodies.length} ${bodies.length === 1 ? 'body' : 'bodies'}, each its own ${format.toUpperCase()} file, in a ZIP`);
    } catch (err) {
      this.app.ui.toast(`Export failed: ${(err as Error).message}`, 'error');
    } finally {
      this.app.ui.setStatus(null);
    }
  }

  /** 3MF for slicers: the meshes, with the exact STEP model packed inside. */
  async export3mf(how: Delivery = 'download'): Promise<void> {
    const ids = chosenBodies(this.app);
    const bodies = (this.app.result?.bodies ?? []).filter(b => (ids.length ? ids.includes(b.id) : !this.app.view.isHidden(b.id)));
    if (!bodies.length) {
      return this.app.ui.toast('Nothing to export');
    }
    try {
      this.app.ui.setStatus('Exporting 3MF…');
      const step = await this.app.kernel.export(this.app.store.doc.features, 'step', bodies.map(b => b.id));
      // A fine mesh, as for STL (the view's is coarse: round faces came out faceted in the slicer).
      const fine = JSON.parse(await (await this.app.kernel.export(this.app.store.doc.features, 'mesh', bodies.map(b => b.id))).text()) as { id: string; positions: number[]; indices: number[] }[];
      const names = this.app.store.doc.names ?? {};
      const blob = await exportThreeMF(
        bodies.map((b) => {
          const fineMesh = fine.find(mesh => mesh.id === b.id);

          return { name: names[b.id] ?? b.name, positions: fineMesh ? new Float32Array(fineMesh.positions) : b.positions, indices: fineMesh ? new Uint32Array(fineMesh.indices) : b.indices, color: this.app.store.doc.colors?.[b.id] };
        }),
        this.app.store.doc.name,
        step
      );
      await this.deliver(blob, `${this.app.store.doc.name}.3mf`, how);
    } catch (err) {
      this.app.ui.toast(`Export failed: ${(err as Error).message}`, 'error');
    } finally {
      this.app.ui.setStatus(null);
    }
  }

  async export(format: ExportFormat, how: Delivery = 'download'): Promise<void> {
    // Selected bodies win; otherwise what's isolated; otherwise everything.
    const picked = bodiesOf(this.app.selection);
    const bodies = picked.length ? picked : (this.app.isolated ?? []).filter(id => this.app.result?.bodies.some(b => b.id === id));
    try {
      this.app.ui.setStatus(`Exporting ${bodies.length ? `${bodies.length} bod${bodies.length > 1 ? 'ies' : 'y'} as ` : ''}${format.toUpperCase()}…`);
      const blob = await this.app.kernel.export(this.app.store.doc.features, format, bodies.length ? bodies : undefined);
      await this.deliver(blob, `${this.app.store.doc.name}.${format === 'step' ? 'step' : 'stl'}`, how);
    } catch (err) {
      this.app.ui.toast(`Export failed: ${(err as Error).message}`, 'error');
    } finally {
      this.app.ui.setStatus(null);
    }
  }

  /** Print / Share: is the model fit to print, and the files to take it away as. */
  printShare(): void {
    const { app } = this;
    showPrintShare({
      checkModel: async () => {
        const hidden = new Set(app.store.doc.hidden ?? []);

        return (await app.kernel.health(app.store.doc.features)).filter(body => !hidden.has(body.id));
      },
      files: [
        { label: '3MF', note: 'For 3D printing (keeps sizes and colours)', run: () => this.export3mf() },
        { label: 'STL', note: 'For 3D printing (every slicer opens it)', run: () => this.export('stl') },
        { label: 'STEP', note: 'For other CAD programs', run: () => this.export('step') },
        { label: 'Picture', note: 'A PNG of the view as it is now', run: () => app.ui.runRight('shot') }
      ]
    });
  }
}


/** Same choice of bodies as the other exports: selected, else isolated, else all. */
export function chosenBodies(app: App): string[] {
  const picked = bodiesOf(app.selection);

  return picked.length ? picked : (app.isolated ?? []).filter(id => app.result?.bodies.some(b => b.id === id));
}

export type Delivery = 'download' | 'share';

/** The file types the exports are shared as (the share sheet picks apps by them). */
const MIME: Record<string, string> = {
  stl: 'model/stl',
  step: 'model/step',
  '3mf': 'model/3mf',
  glb: 'model/gltf-binary',
  dxf: 'image/vnd.dxf',
  svg: 'image/svg+xml',
  super: 'application/json'
};

function canShare(file: File): boolean {
  try {
    return typeof navigator.share === 'function' && !!navigator.canShare?.({ files: [file] });
  } catch {
    return false;
  }
}

/** Will this browser share a file of this kind (the system share sheet)? */
export function canShareType(ext: string): boolean {
  return canShare(new File(['x'], `x.${ext}`, { type: MIME[ext] ?? 'application/octet-stream' }));
}

export function download(blob: Blob, name: string): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
