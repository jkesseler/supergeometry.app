// The History panel: its rows, the breakpoint, merging, hover targets and opening a step to edit it.

import { BooleanOp } from '../tools/booleanOp';
import { FreeformTool } from '../tools/freeform';
import { entityWorldPolylines } from '../sketch/curves';
import { xDirFor } from '../geom';
import { ConnectOp, EdgeOp, ExtrudeOp, FillOp, FillToPlaneOp, ThreadOp, ImageOp, LoftOp, MoveFaceOp, PlaneOp, ReplaceFaceOp, ScaleFaceOp, ScaleOp, ScaleRefOp, RevolveOp, ShellOp, SplitOp, SweepOp, TransformOp } from '../tools/ops';
import { faceFreeformTool } from '../tools/faceFreeform';
import { freeformBodies } from '../doc/freeformCopies';
import { editedStep } from '../doc/freeformEdits';
import { ImprintOp, WrapOp } from '../tools/wrapOps';
import { SketchTool } from '../tools/sketch';
import type { RegenResult } from '../kernel/protocol';
import type { EdgeFeature, ExtrudeFeature, Feature, FillToPlaneFeature, ImageFeature, LoftFeature, PlaneFeature, RevolveFeature, ShellFeature, SketchFeature, SplitFeature, SweepFeature, TransformFeature, Vec3 } from '../doc/types';
import type { App } from '../app';

export class History {
  constructor(private app: App) {}

  /**
   * Bodies with open edges - except freeform surfaces that are meant to be
   * open sheets (not thickened): those aren't a problem.
   */
  openBodies(result: RegenResult | null) {
    return (result?.bodies ?? []).filter((b) => {
      if (!b.openEdges?.length) {
        return false;
      }
      // A surface on purpose (or a copy of one) isn't meant to be closed.
      const feature = this.app.store.find(b.id);
      const ff = feature?.type === 'freeform' ? editedStep<typeof feature>(this.app.store.features, feature.id) : freeformBodies(this.app.store.features).get(b.id)?.feature;

      return !(ff?.surface && !ff.thickness);
    });
  }

  /** What the History rows were last made from (everything a row shows). */
  private historyShown = '';

  render(): void {
    const warnings = new Map<string, string>();
    for (const b of this.openBodies(this.app.result)) {
      warnings.set(b.id.split(':')[0], `${b.name}: not closed - ${b.openEdges.length} open edge(s)`);
    }
    for (const featureError of this.app.result?.notes ?? []) {
      warnings.set(featureError.featureId, warnings.has(featureError.featureId) ? `${warnings.get(featureError.featureId)} ${featureError.message}` : featureError.message);
    }
    // The same rows as are there: left as they are (every step of a drag's
    // preview rebuilt the whole list - 5 ms for 200 steps, far more on a phone).
    const doc = this.app.store.doc;
    const shown = JSON.stringify([
      doc.features.map(feature => [feature.id, feature.name, feature.type, feature.suppressed ? 1 : 0, feature.rolledBack ? 1 : 0, feature.type === 'sketch' ? (feature.log ?? 0) : 0]),
      this.app.result?.errors ?? [],
      this.app.tool.editingId ?? this.app.tool.activeSketch ?? null,
      [...warnings],
      doc.hidden,
      doc.historyGroups ?? []
    ]);
    if (shown === this.historyShown) {
      return;
    }
    this.historyShown = shown;
    // The rows are rebuilt: a hover on an old row is over.
    this.app.view.setStepHover(null);
    this.app.ui.renderHistory(this.app.store.doc.features, this.app.result?.errors ?? [], this.app.tool.editingId ?? this.app.tool.activeSketch ?? null, {
      edit: (id, pick) => this.edit(id, pick),
      hover: id => this.app.view.setStepHover(id ? this.stepTargets(id) : null),
      toggle: (id) => {
        const feature = this.app.store.find(id);
        if (feature) {
          this.app.store.update(id, { suppressed: !feature.suppressed });
        }
      },
      isHidden: id => this.app.store.doc.hidden.includes(id),
      toggleHidden: id => this.app.store.commit(draft => (draft.hidden = draft.hidden.includes(id) ? draft.hidden.filter(hiddenId => hiddenId !== id) : [...draft.hidden, id])),
      remove: (id) => {
        if (this.app.tool !== this.app.selectTool) {
          this.app.setTool(null);
        }
        this.app.store.remove(id);
      },
      groups: this.app.store.doc.historyGroups ?? [],
      setGroups: next => this.app.store.commit(draft => (draft.historyGroups = next.length ? next : undefined)),
      suppress: (ids, off) =>
        this.app.store.commit((draft) => {
          for (const feature of draft.features) {
            if (ids.includes(feature.id)) {
              feature.suppressed = off || undefined;
            }
          }
        }),
      askName: async (title, current) => (await this.app.ui.dialog(title, [{ key: 'name', label: 'Name', value: current }]))?.name.trim() || null,
      breakAfter: id => this.breakAfter(id),
      merge: () => void this.mergeHistory()
    }, warnings);
  }

  /**
   * The History's breakpoint: the steps after `id` off (the model as it was
   * there) until it's removed (null). New steps go in at the breakpoint.
   */
  private breakAfter(id: string | null): void {
    if (this.app.tool !== this.app.selectTool) {
      this.app.setTool(null);
    }
    const at = id ? this.app.store.features.findIndex(feature => feature.id === id) : Infinity;
    const later = id ? this.app.store.features.length - 1 - at : 0;
    if (id && !later) {
      return void this.app.ui.toast("It's the last step - there's nothing after it to roll back");
    }
    this.app.store.commit((draft) => {
      draft.features.forEach((feature, i) => {
        if (i > at) {
          feature.rolledBack = true;
        } else {
          delete feature.rolledBack;
        }
      });
    });
    this.app.ui.toast(id ? `Rolled back to here: ${later} later step${later === 1 ? '' : 's'} off until you remove the breakpoint` : 'Breakpoint removed: every step is on again');
  }

  /**
   * Merge: the history flattened into the bodies as they are now (each kept
   * as its exact shape, its name, colour and material kept). Sketches and
   * variables can stay; every other step goes. Undo takes it back.
   */
  private async mergeHistory(): Promise<void> {
    const bodies = this.app.view.bodyList;
    if (!bodies.length) {
      return void this.app.ui.toast('There are no bodies yet - nothing to merge into');
    }
    const off = this.app.store.features.filter(feature => feature.rolledBack || feature.suppressed).length;
    const answers = await this.app.ui.dialog(
      'Merge history',
      [
        { key: 'sketches', label: 'Keep the sketches', value: '1', check: true },
        { key: 'variables', label: 'Keep the variables', value: '1', check: true }
      ],
      `Every step becomes the bodies as they are now: they can't be edited by their steps any more.${off ? ` The ${off} step${off === 1 ? '' : 's'} switched off or after the breakpoint go too.` : ''} Undo takes it back.`
    );
    if (!answers) {
      return;
    }
    if (this.app.tool !== this.app.selectTool) {
      this.app.setTool(null);
    }
    const features = this.app.store.doc.features.filter(feature => !feature.rolledBack);
    const made: Feature[] = [];
    const renamed = new Map<string, string>();
    for (const b of bodies) {
      const blob = await this.app.kernel.export(features, 'step', [b.id]);
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let bin = '';
      for (let i = 0; i < bytes.length; i += 0x8000) {
        bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      }
      // The body keeps its id where it can be a step's (names, colours, folders stay with it).
      const id = /^[\w-]+$/.test(b.id) && !made.some(feature => feature.id === b.id) ? b.id : this.app.store.newIdentity('import').id;
      if (id !== b.id) {
        renamed.set(b.id, id);
      }
      const name = this.app.store.doc.names[b.id] ?? b.name;
      made.push({ id, name, type: 'import', format: 'step', fileName: `${name}.step`, data: btoa(bin) });
    }
    const keepSketches = !!answers.sketches;
    const keepVars = !!answers.variables;
    this.app.store.commit((draft) => {
      const sketches = keepSketches
        ? draft.features.flatMap((feature): Feature[] => {
          if (feature.type !== 'sketch' || feature.rolledBack) {
            return [];
          }
          // Nothing left to follow: a merged body has no steps to point at.
          const sketch: SketchFeature = { ...feature, attachedTo: undefined, outlineOffsets: undefined, links: undefined };
          sketch.constraints = sketch.constraints?.filter(constraint => !/"(ref|lnk)-/.test(JSON.stringify(constraint)));
          if (!keepVars) {
            delete sketch.exprs;
          }

          return [sketch];
        })
        : [];
      draft.features = [...made, ...sketches];
      if (!keepVars) {
        draft.variables = [];
      }
      draft.historyGroups = undefined;
      const re = (id: string) => renamed.get(id) ?? id;
      const reKeys = <T>(record: Record<string, T> | undefined) => (record ? Object.fromEntries(Object.entries(record).map(([key, x]) => [re(key), x])) : record);
      draft.names = reKeys(draft.names)!;
      draft.colors = reKeys(draft.colors);
      draft.opacity = reKeys(draft.opacity);
      draft.materials = reKeys(draft.materials);
      draft.hidden = draft.hidden.map(re);
      draft.folders = draft.folders?.map(folder => ({ ...folder, items: folder.items.map(re) }));
    });
    this.app.ui.toast(`History merged: ${made.length} bod${made.length === 1 ? 'y' : 'ies'}${keepSketches ? ', the sketches kept' : ''}`);
  }

  /** What a History step works on: its bodies (made or changed), sketches, and the edges it names. */
  private stepTargets(id: string): { bodies: string[]; lines: Vec3[][] } {
    const feature = this.app.store.find(id);
    const bodies = new Set<string>();
    const sketches = new Set<string>();
    const edges: [Vec3, Vec3][] = [];
    if (!feature) {
      return { bodies: [], lines: [] };
    }
    if (feature.type === 'sketch') {
      sketches.add(feature.id);
    }
    // Bodies this step made (its own id, or copies "id:…").
    for (const b of this.app.result?.bodies ?? []) {
      if (b.id === feature.id || b.id.startsWith(`${feature.id}:`)) {
        bodies.add(b.id);
      }
    }
    const walk = (value: unknown, key = ''): void => {
      if (Array.isArray(value)) {
        return value.forEach(item => walk(item, key));
      }
      if (!value || typeof value !== 'object') {
        if (typeof value === 'string' && (key === 'body' || key === 'bodies' || key === 'target')) {
          bodies.add(value);
        }
        if (typeof value === 'string' && key === 'sketch') {
          sketches.add(value);
        }

        return;
      }
      const record = value as Record<string, unknown>;
      // An edge reference: draw the edge itself.
      if (Array.isArray(record.mid) && Array.isArray(record.dir) && typeof record.length === 'number') {
        const mid = record.mid as Vec3;
        const dir = record.dir as Vec3;
        const halfLength = (record.length as number) / 2;
        edges.push([[mid[0] - dir[0] * halfLength, mid[1] - dir[1] * halfLength, mid[2] - dir[2] * halfLength], [mid[0] + dir[0] * halfLength, mid[1] + dir[1] * halfLength, mid[2] + dir[2] * halfLength]]);
      }
      for (const [key, x] of Object.entries(record)) {
        if (key !== 'exprs') {
          walk(x, key);
        }
      }
    };
    walk(feature);
    // Only what's still there.
    const have = new Set((this.app.result?.bodies ?? []).map(b => b.id));
    // Sketch curves in 3D.
    const lines: Vec3[][] = [...edges];
    for (const sid of sketches) {
      const plane = this.app.sketchPlane(sid);
      const sk = this.app.store.find<SketchFeature>(sid);
      if (!plane || !sk) {
        continue;
      }
      for (const e of sk.entities) {
        lines.push(...entityWorldPolylines(e, plane));
      }
    }

    return { bodies: [...bodies].filter(b => have.has(b)), lines };
  }


  edit(id: string, pick?: string[]): void {
    const existing = this.app.store.find(id);
    if (!existing) {
      return;
    }
    this.app.setSelection([]);
    // What the step works on can be off screen (or under History): once its
    // tool shows its picks, bring them into view. A sketch frames itself.
    if (existing.type !== 'sketch') {
      const before = this.app.tool;
      setTimeout(() => this.app.tool !== before && this.app.view.keepInView(), 400);
    }
    switch (existing.type) {
      case 'boolean':
        // Subtract / Intersect open their tool (picks, Keep options); Union has nothing to set.
        if (existing.op !== 'union') {
          return this.app.setTool(new BooleanOp(this.app, existing.op, existing.target, existing.tools, existing));
        }
        break;
      case 'sketch': {
        // (From one of its steps in History: open with what that step made picked, ready to change.)
        const tool = new SketchTool(this.app, { sketchId: existing.id });
        this.app.setTool(tool);
        if (pick?.length) {
          tool.stopDrawing();
          tool.preselect(pick);
        }

        return;
      }
      case 'extrude':
        return this.app.setTool(new ExtrudeOp(this.app, existing.source, existing as ExtrudeFeature));
      case 'fillet':
      case 'chamfer':
        return this.app.setTool(new EdgeOp(this.app, existing.type, existing.edges, existing as EdgeFeature));
      case 'revolve':
        return this.app.setTool(new RevolveOp(this.app, existing.source, existing as RevolveFeature));
      case 'sweep':
        return this.app.setTool(new SweepOp(this.app, existing.source, existing as SweepFeature));
      case 'loft':
        return this.app.setTool(new LoftOp(this.app, existing.sections, [], existing as LoftFeature));
      case 'shell':
        return this.app.setTool(new ShellOp(this.app, existing.body, existing.faces, existing as ShellFeature));
      case 'split':
        return this.app.setTool(new SplitOp(this.app, existing.body, existing as SplitFeature));
      case 'fillToPlane':
        return this.app.setTool(new FillToPlaneOp(this.app, existing.body, existing as FillToPlaneFeature));
      case 'fill':
        return this.app.setTool(new FillOp(this.app, existing.boundary, existing));
      case 'imprint':
        return this.app.setTool(new ImprintOp(this.app, existing.source ? { source: existing.source } : { edges: existing.edges ?? [] }, existing));
      case 'wrap':
        return this.app.setTool(new WrapOp(this.app, existing.source, existing));
      case 'thread':
        return this.app.setTool(new ThreadOp(this.app, existing.face, existing.round ?? { r: 5, hole: false }, existing));
      case 'plane':
        return this.app.setTool(new PlaneOp(this.app, existing.plane, existing.face, existing as PlaneFeature));
      case 'transform': {
        if (existing.op.kind === 'scale' && existing.op.ref) {
          return this.app.setTool(new ScaleRefOp(this.app, existing.bodies, existing as TransformFeature));
        }
        if (existing.op.kind === 'scale' || existing.op.kind === 'scaleXYZ') {
          return this.app.setTool(new ScaleOp(this.app, existing.op.kind === 'scaleXYZ', existing.bodies, existing as TransformFeature));
        }

        return this.app.setTool(new TransformOp(this.app, existing.op.kind, existing.bodies, existing as TransformFeature));
      }
      case 'scaleFace':
        return this.app.setTool(new ScaleFaceOp(this.app, existing.face, { origin: existing.face.center, normal: existing.face.normal, xDir: existing.u }, existing));
      case 'replaceFace':
        return this.app.setTool(new ReplaceFaceOp(this.app, existing.face, existing));
      case 'image':
        return this.app.setTool(new ImageOp(this.app, existing as ImageFeature));
      // (Opened from History: that step itself is edited.)
      case 'freeform':
        return this.app.setTool(new FreeformTool(this.app, { feature: existing, keep: { inPlace: true } }));
      case 'freeformEdit': {
        // The shape as this edit left it; Done keeps the change in this step.
        const t = editedStep(this.app.store.features, existing.target, existing.id);
        if (t?.type === 'freeform') {
          return this.app.setTool(new FreeformTool(this.app, { feature: t, keep: { edit: existing.id } }));
        }
        if (t?.type === 'faceFreeform') {
          const tool = faceFreeformTool(this.app, null, t, { edit: existing.id });

          return tool ? this.app.setTool(tool) : undefined;
        }

        return this.app.ui.toast('The freeform this edits is gone');
      }
      case 'connect':
        return this.app.setTool(new ConnectOp(this.app, [], existing));
      case 'faceFreeform':
        return this.app.setTool(faceFreeformTool(this.app, null, existing, { inPlace: true }));
      case 'moveFace': {
        const target = existing.face ? { face: existing.face, plane: { origin: existing.face.center, normal: existing.face.normal, xDir: xDirFor(existing.face.normal) } } : existing.edge ? { edge: existing.edge } : existing.vertex ? { vertex: existing.vertex } : null;
        if (target) {
          return this.app.setTool(new MoveFaceOp(this.app, target, existing));
        }
        break;
      }
      default:
        this.app.ui.toast(`${existing.name} has no values to edit. You can suppress or delete it.`);
    }
  }
}
