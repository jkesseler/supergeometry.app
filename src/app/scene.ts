// What the view shows of the project's sketches and construction geometry after each rebuild.

import { sketchesUsed } from '../tools/featureOp';
import { definedCurves } from '../sketch/constraints';
import type { Feature, ImageFeature, SketchEntity, SketchFeature } from '../doc/types';
import type { App } from '../app';

export class Scene {
  constructor(private app: App) {}

  /** Sketches the engine moved the curves of (they follow a body): those curves, by the sketch as it was sent. */
  solved = new WeakMap<Feature, SketchEntity[]>();

  refreshConstruction(features: readonly Feature[] = this.app.store.doc.features): void {
    const result = this.app.result;
    if (!result) {
      return;
    }
    const hidden = new Set(this.app.store.doc.hidden);
    // Isolating: only what's isolated (or was made since) shows.
    const shown = (id: string) => !hidden.has(id) && (!this.app.isolated || this.app.isolated.includes(id));
    this.app.view.setConstruction(result.planes.filter(plane => shown(plane.id)), result.axes.filter(a => shown(a.id)));
    this.app.view.setImages(features.filter((feature): feature is ImageFeature => feature.type === 'image' && !feature.suppressed && !feature.rolledBack && shown(feature.id)));
  }

  /** The sketch being edited: which curves its constraints hold completely (worked out once per change). */
  definedCache: { entities: unknown; constraints: unknown; defined: Set<string> | undefined; all: boolean } | null = null;

  definedOf(sketch: SketchFeature): Set<string> | undefined {
    const definedCache = this.definedCache;
    if (definedCache && definedCache.entities === sketch.entities && definedCache.constraints === sketch.constraints) {
      return definedCache.defined;
    }
    const defined = definedCurves(sketch.entities, sketch.constraints ?? []);
    const all = !!defined?.all && sketch.entities.some(e => !e.construction);
    // Just became fully defined: say so (the curves have turned green).
    if (all && definedCache && !definedCache.all) {
      this.app.ui.toast('Sketch fully defined');
    }
    this.definedCache = { entities: sketch.entities, constraints: sketch.constraints, defined: defined?.defined, all };

    return defined?.defined;
  }

  /** Sketches hidden (after use) that were shown again: meant to be used again, so tappable through bodies. */
  revealed = new Set<string>();
  wasHidden = new Set<string>();

  refreshSketches(features: readonly Feature[] = this.app.store.doc.features): void {
    const hidden = new Set(this.app.store.doc.hidden);
    for (const id of this.wasHidden) {
      if (!hidden.has(id)) {
        this.revealed.add(id);
      }
    }
    for (const id of hidden) {
      this.revealed.delete(id);
    }
    this.wasHidden = hidden;
    const iso = this.app.isolatedWithSketches();
    const sketches = features
      .filter((feature): feature is SketchFeature => feature.type === 'sketch' && !feature.suppressed && !feature.rolledBack && ((!hidden.has(feature.id) && (!iso || iso.includes(feature.id))) || feature.id === this.app.tool.activeSketch))
      .map(feature => ({ ...feature, entities: this.solved.get(feature) ?? feature.entities, plane: this.app.result?.sketchPlanes[feature.id] ?? feature.plane, boundary: this.app.result?.sketchBoundaries[feature.id] }))
      .map(sketch => (sketch.id === this.app.tool.activeSketch ? { ...sketch, defined: this.definedOf(sketch) } : sketch));
    // Drawn but not made into anything yet: shown through bodies, and a tap on it finds it there
    // (a pocket sketched on a plane through the middle of a body is inside it). The same
    // for one used, hidden, and shown again in Items: the pocket's sketch shown to fill
    // the pocket with a core couldn't be tapped through the frame round it.
    const used = new Set(features.filter(feature => !feature.suppressed && !feature.rolledBack).flatMap(sketchesUsed));
    this.app.view.setSketches(sketches, this.app.tool.activeSketch, new Set(sketches.filter(sketch => !used.has(sketch.id) || this.revealed.has(sketch.id)).map(sketch => sketch.id)));
  }
}
