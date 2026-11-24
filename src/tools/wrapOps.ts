// Project as Edge and Wrap & Emboss: a sketch (or edges) put onto a body's faces.

import { projectRegions } from '../sketch/edit';
import { arrangement, materialRegions, regionRef, resolveRegion, type Region } from '../sketch/regions';
import { planeSlot } from './slots';
import { FeatureOp, type Slot } from './featureOp';
import { faceRefOf, type AppContext, type Sel } from './tool';
import type { PanelItem } from '../ui/ui';
import type { EdgeRef, ExtrudeSource, FaceRef, ImprintFeature, PlaneDef, SketchFeature, WrapFeature } from '../doc/types';

/** One face, of a kind `fits` says. */
function faceSlot(app: AppContext, label: string, get: () => FaceRef | null, set: (f: FaceRef, s: Sel) => void, fits: (s: Extract<Sel, { kind: 'face' }>) => boolean, rejectHint: string, picked = '1 face', empty = 'Tap a face'): Slot {
  let shown: Sel[] = [];

  return {
    label,
    describe: () => (get() ? picked : empty),
    filled: () => !!get(),
    pick: { profiles: false, edges: false, planes: false, axes: false },
    shows: () => shown,
    rejectHint,
    accept(hit) {
      if (hit.kind !== 'face') {
        return false;
      }
      const facePick = { kind: 'face' as const, body: hit.body, face: hit.face };
      if (!fits(facePick)) {
        return false;
      }
      const ref = faceRefOf(app, facePick);
      if (!ref) {
        return false;
      }
      shown = [facePick];
      set(ref, facePick);

      return true;
    }
  };
}

/**
 * The sketch's shapes a step puts onto the body: more of them tapped, one
 * tapped again taken back out, or All (every shape drawn, letters with their
 * holes). Started from the menu, the first shape tapped was all it took: a
 * word wrapped round a mug came out as its first letter, a handle's second pad
 * was never drawn onto it.
 */
function shapesSlot(app: AppContext, get: () => ExtrudeSource | undefined, set: (s: ExtrudeSource) => void): Slot {
  const regionsOf = (sketch: string) => arrangement(app.sketchCurves(sketch)).regions;
  const same = (a: { c: number[] }, b: { c: number[] }) => Math.hypot(a.c[0] - b.c[0], a.c[1] - b.c[1]) < 1e-6;
  const count = () => {
    const source = get();

    return source?.kind === 'profile' ? source.regions.length : 0;
  };

  return {
    label: 'Shapes',
    multi: true,
    describe: () => (count() ? `${count()} shape${count() > 1 ? 's' : ''} - tap more` : 'Tap the shapes'),
    filled: () => count() > 0,
    pick: { bodies: false, edges: false, vertices: false, planes: false, axes: false },
    shows: () => {
      const source = get();
      if (source?.kind !== 'profile') {
        return [];
      }
      const all = regionsOf(source.sketch).map(regionRef);

      return source.regions.map(region => ({ kind: 'profile' as const, sketch: source.sketch, region: all.findIndex(regionRef => same(regionRef, region)) })).filter(region => region.region >= 0);
    },
    presets: [
      {
        label: 'All',
        apply: () => {
          const source = get();
          if (source?.kind === 'profile') {
            set({ ...source, regions: materialRegions(arrangement(app.sketchCurves(source.sketch))).map(regionRef) });
          }
        }
      }
    ],
    accept(hit) {
      if (hit.kind !== 'profile') {
        return false;
      }
      const region = regionsOf(hit.sketch)[hit.region];
      if (!region) {
        return false;
      }
      const ref = regionRef(region);
      const source = get();
      // (Another sketch's shape: that sketch's instead.)
      if (source?.kind !== 'profile' || source.sketch !== hit.sketch) {
        set({ kind: 'profile', sketch: hit.sketch, regions: [ref] });
      } else {
        const i = source.regions.findIndex(region => same(region, ref));
        if (i >= 0 && source.regions.length === 1) {
          return true;
        }
        set({ ...source, regions: i >= 0 ? source.regions.filter((_, j) => j !== i) : [...source.regions, ref] });
      }

      return true;
    }
  };
}

/**
 * Project as Edge. A sketch: its shapes drawn onto the body's faces seen from
 * it, along its normal. Edges: drawn onto a face picked next, along its normal.
 * The faces are split there; nothing else changes.
 */
export class ImprintOp extends FeatureOp<ImprintFeature> {
  readonly id = 'imprint';
  private onto: FaceRef | null = null;

  constructor(app: AppContext, from: { source: ExtrudeSource } | { edges: EdgeRef[] }, existing?: ImprintFeature) {
    const source = 'source' in from ? from.source : undefined;
    // The body the sketch is on, if it is on one; with only one body, that one.
    const sk = source?.kind === 'profile' ? app.store.find<SketchFeature>(source.sketch) : undefined;
    const only = app.view.bodyList.length === 1 ? app.view.bodyList[0].id : '';
    const body = sk?.attachedTo?.body ?? (source?.kind === 'face' ? source.face.body : only);
    super(app, { ...app.store.newIdentity('imprint'), type: 'imprint', body, ...('source' in from ? { source: from.source } : { edges: from.edges }) }, existing);
    const feature = this.feature;
    this.onto = feature.face ?? null;
    if (feature.source) {
      this.slots = [
        shapesSlot(app, () => feature.source, src => (feature.source = src)),
        faceSlot(
          app,
          'Onto body',
          () => (feature.body ? ({ body: feature.body } as FaceRef) : null),
          (_, highlight) => highlight.kind === 'face' && (feature.body = highlight.body),
          () => true,
          'Tap the body to draw it onto',
          '1 body',
          'Tap a body'
        )
      ];
    } else {
      this.slots = [
        faceSlot(
          app,
          'Onto face',
          () => this.onto,
          ref => ((this.onto = ref), (feature.face = ref), (feature.body = ref.body)),
          () => true,
          'Tap the face to draw the edges onto'
        )
      ];
    }
  }

  protected hint(): string {
    if (this.feature.source) {
      return this.feature.body ? 'The sketch is drawn onto the faces seen from it: they are split along it.' : 'Tap the body to draw the sketch onto.';
    }

    return this.onto ? 'The edges are drawn onto the face, straight across to it: it is split along them.' : 'Tap the face to draw the edges onto.';
  }

  protected items(): PanelItem[] {
    return [];
  }
}

/** Wrap & Emboss: a sketch's shapes wrapped round a round face (lengths kept), raised from it or sunk into it. */
export class WrapOp extends FeatureOp<WrapFeature> {
  readonly id = 'wrap';
  private onto: FaceRef | null = null;

  constructor(app: AppContext, source: ExtrudeSource, existing?: WrapFeature) {
    super(app, { ...app.store.newIdentity('wrap'), type: 'wrap', source, face: { body: '', center: [0, 0, 0], normal: [0, 0, 1], area: 0 }, height: 1 }, existing);
    const feature = this.feature;
    this.onto = existing ? existing.face : null;
    this.slots = [
      shapesSlot(app, () => feature.source, src => (feature.source = src)),
      faceSlot(
        app,
        'Round face',
        () => this.onto,
        ref => ((this.onto = ref), (feature.face = ref)),
        facePick => !!app.view.body(facePick.body)?.faces[facePick.face]?.round,
        'Wrap goes on a round face (a cylinder)'
      )
    ];
  }

  protected hint(): string {
    if (!this.onto) {
      return 'Tap the round face to wrap the sketch round (the sketch on a plane along its axis).';
    }

    return this.feature.height > 0 ? 'Wrapped round the face, lengths kept, and raised from it.' : 'Wrapped round the face, lengths kept, and sunk into it.';
  }

  protected items(): PanelItem[] {
    const feature = this.feature;

    return [
      { type: 'number', label: 'Height', value: Math.abs(feature.height), kind: 'length', min: 0.01, onInput: value => ((feature.height = Math.sign(feature.height || 1) * Math.max(0.01, Math.abs(value))), this.update()) },
      { type: 'toggle', label: 'Sink in', value: feature.height < 0, onChange: isOn => ((feature.height = (isOn ? -1 : 1) * Math.abs(feature.height)), this.render(), this.update()) }
    ];
  }
}

/**
 * Project as Sketch (a sketch's shapes): a new sketch on a plane or flat face
 * picked next, the shapes drawn onto it square to it.
 */
export class ProjectSketchOp extends FeatureOp<SketchFeature> {
  readonly id = 'projectSketch';
  private onto: PlaneDef | null = null;

  constructor(app: AppContext, source: Extract<ExtrudeSource, { kind: 'profile' }>) {
    super(app, { ...app.store.newIdentity('sketch'), type: 'sketch', plane: { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, 0, 1] }, entities: [] });
    const from = app.sketchPlane(source.sketch);
    const arr = arrangement(app.sketchCurves(source.sketch));
    const regions = source.regions.map(region => resolveRegion(arr, region)).filter((region): region is Region => !!region);
    this.slots = [
      planeSlot(app, 'Onto', () => this.onto, (plane, face) => {
        this.onto = plane;
        const feature = this.feature;
        feature.plane = plane;
        if (face) {
          feature.attachedTo = face;
        } else {
          delete feature.attachedTo;
        }
        feature.entities = from ? projectRegions(arr, regions, from, plane) : [];
      })
    ];
  }

  protected hint(): string {
    return this.onto ? 'A new sketch on it, the shapes drawn onto it square to it.' : 'Tap the plane or flat face to draw the shapes onto (or pick XY / XZ / YZ).';
  }

  protected items(): PanelItem[] {
    return [];
  }
}
