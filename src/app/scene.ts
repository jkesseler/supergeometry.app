// What the view shows of the project's sketches and construction geometry after each rebuild.

import { sketchesUsed } from '../tools/featureOp';
import { definedCurves } from '../sketch/constraints';
import type { Feature, ImageFeature, SketchEntity, SketchFeature } from '../doc/types';
import type { RegenResult } from '../kernel/protocol';
import type { App } from '../app';

export class Scene {
  constructor(private app: App) {}

  private shownErrors = '';

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

  apply(result: RegenResult, features: readonly Feature[]): void {
    this.app.result = result;
    this.solved = new WeakMap();
    if (result.sketchEntities) {
      const moved = result.sketchEntities;
      for (const feature of features) {
        if (moved[feature.id]) {
          this.solved.set(feature, moved[feature.id]);
        }
      }
      // The project as it is (not a preview of a change): they are the sketch's curves from now on.
      if (features === this.app.store.doc.features) {
        this.app.store.adopt((draft) => {
          for (const feature of draft.features) {
            if (feature.type === 'sketch' && moved[feature.id]) {
              feature.entities = moved[feature.id];
            }
          }
        });
        features = this.app.store.doc.features;
      }
    }
    // Which patterns a step used whole, as it was made: kept with it (they stay whole when a count changes).
    if (result.whole && features === this.app.store.doc.features) {
      const whole = result.whole;
      this.app.store.adopt((draft) => {
        for (const feature of draft.features) {
          if ((feature.type === 'boolean' || feature.type === 'delete') && whole[feature.id] && !feature.whole) {
            feature.whole = whole[feature.id];
          }
        }
      });
      features = this.app.store.doc.features;
    }
    const now = new Set([...result.bodies.map(b => b.id), ...features.map(feature => feature.id)]);
    if (this.app.isolated) {
      // Made while isolating (a copy, a new sketch or plane): it belongs with what's shown.
      if (this.app.known) {
        for (const id of now) {
          if (!this.app.known.has(id)) {
            this.app.isolated.push(id);
          }
        }
      }
      this.app.isolated = this.app.isolated.filter(id => now.has(id));
      if (!this.app.isolated.some(id => result.bodies.some(b => b.id === id))) {
        this.app.isolated = null;
      }
    }
    this.app.known = now;
    this.app.view.setBodies(result.bodies);
    this.app.applyVisibility();
    this.refreshConstruction(features);
    this.refreshSketches(features);
    // Drop selections that point at geometry that no longer exists.
    this.app.selection = this.app.selection.filter((highlight) => {
      if (highlight.kind === 'profile' || highlight.kind === 'curve' || highlight.kind === 'point') {
        return !!this.app.store.find(highlight.sketch) || features.some(feature => feature.id === highlight.sketch);
      }
      if (highlight.kind === 'plane' || highlight.kind === 'axis') {
        return !!this.app.view.planeOf(highlight.id) || !!this.app.view.axisOf(highlight.id);
      }
      if (highlight.kind === 'image') {
        return features.some(feature => feature.id === highlight.id);
      }
      if (highlight.kind === 'origin') {
        return true;
      }
      const b = this.app.view.body(highlight.body);
      if (!b) {
        return false;
      }
      if (highlight.kind === 'face') {
        return highlight.face < b.faces.length;
      }
      if (highlight.kind === 'edge') {
        return highlight.edge < b.edges.length;
      }
      if (highlight.kind === 'vertex') {
        return !!this.app.view.vertexOf(highlight.body, highlight.vertex);
      }

      return true;
    });
    this.app.refreshHighlights();
    // (Once: the selection tool's own refresh was run a second time after this.app.)
    this.app.tool.refresh?.();
    this.app.showPose();
    this.app.history.render();
    this.app.items.render(result);
    this.app.showVariableTags();
    const open = this.app.history.openBodies(result);
    this.app.ui.setWarning(
      open.length
        ? `⚠ ${open.length === 1 ? (this.app.store.doc.names?.[open[0].id] ?? open[0].name) : `${open.length} bodies`} not closed - ${open.reduce((total, b) => total + b.openEdges.length, 0)} open edge(s) shown in orange`
        : this.app.store.problems[0]
          ? `⚠ ${this.app.store.problems[0]}`
          : null
    );
    // (Steps of the project only: one being tried - a Delete Face its
    // neighbours can't close - isn't in History, and says why itself.)
    const ids = new Set(this.app.store.features.map(feature => feature.id));
    const failed = result.errors.filter(e => ids.has(e.featureId));
    const errs = failed.map(e => e.featureId + e.message).join();
    if (errs && errs !== this.shownErrors && this.app.tool === this.app.selectTool) {
      this.app.ui.toast(`${failed.length} step${failed.length > 1 ? 's' : ''} failed to rebuild - see History`, 'error');
    }
    this.shownErrors = errs;
  }
}
