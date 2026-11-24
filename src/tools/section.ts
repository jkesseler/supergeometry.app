import { add, niceStep, scale } from '../geom';
import { fmtLen } from '../units';
import { DragTyping } from './dragTyping';
import { axisDrag, Handle } from './handles';
import { hitToSel, type AppContext, type Tool } from './tool';
import type { ToolPointer } from '../view/input';
import type { PlaneDef, Vec3 } from '../doc/types';

export interface SectionState {
  plane: PlaneDef;
  offset: number;
  flipped: boolean;
  /** Cut from a face: how far inside it the cut starts (a hair, so the face shows the cut); a plane placed there goes on the face. */
  inset?: number;
  /** Only the cut faces shown, the rest of the model gone. */
  only?: boolean;
  /** 2D: seen straight on, flat like a drawing, the edges beyond the cut drawn. */
  flat?: boolean;
}

export interface SectionHost extends AppContext {
  section: SectionState | null;
  setSection(s: SectionState | null): void;
}

/** The plane the view is cut with (offset and flip applied). */
export function sectionPlane(sectionState: SectionState): PlaneDef {
  const normal: Vec3 = sectionState.flipped ? scale(sectionState.plane.normal, -1) : sectionState.plane.normal;

  return { origin: add(sectionState.plane.origin, scale(sectionState.plane.normal, sectionState.offset)), normal: normal, xDir: sectionState.plane.xDir };
}

/** Section view: pick a plane or flat face, then drag the cut along its normal. */
export class SectionTool implements Tool {
  readonly id = 'section';
  private handle: Handle | null = null;
  private dragging: { from: ToolPointer; o0: number } | null = null;

  constructor(private app: SectionHost) {}

  enter(): void {
    this.app.ui.setTools([{ id: 'exit', label: 'Exit Section', icon: 'exit', shortcut: 'Esc', run: () => this.app.setTool(null) }]);
    // The view tools stay, this one lit and pulsing (tap it again to close it).
    this.app.ui.setBottom(this.app.bottomTools());
    if (this.app.section) {
      this.showControls();
    } else {
      this.askForPlane();
    }
  }

  exit(): void {
    this.handle?.dispose();
    this.handle = null;
    this.app.view.setOriginPlanesVisible(false);
    this.app.ui.showPanel(null);
    this.app.ui.setHint(null);
    this.app.ui.setLabel(0, 0, null);
  }

  private askForPlane(): void {
    this.app.view.setOriginPlanesVisible(true);
    this.app.ui.showPanel(null);
    this.app.ui.setHint('Tap a plane or a flat face to cut the view there, so you can see inside.');
  }

  hover(pointer: ToolPointer | null): void {
    if (!pointer || this.app.section) {
      return this.app.setHover(null);
    }
    const hit = this.app.view.pick(pointer.x, pointer.y, { edges: false, vertices: false, profiles: false, planes: true, planesFirst: true });
    const ok = hit && (hit.kind === 'plane' || (hit.kind === 'face' && !!this.app.view.body(hit.body)?.faces[hit.face]?.plane));
    this.app.setHover(ok ? hitToSel(hit) : null);
  }

  tap(pointer: ToolPointer): void {
    // With a section set, tapping empty space leaves the tool (the section stays on).
    if (this.app.section) {
      if (!this.app.view.pick(pointer.x, pointer.y, { profiles: false })) {
        this.app.setTool(null);
      }

      return;
    }
    const hit = this.app.view.pick(pointer.x, pointer.y, { edges: false, profiles: false, planes: true, planesFirst: true });
    if (!hit) {
      return this.app.setTool(null);
    }
    let plane: PlaneDef | undefined;
    if (hit?.kind === 'plane') {
      plane = this.app.view.planeOf(hit.id);
    }
    if (hit?.kind === 'face') {
      plane = this.app.view.body(hit.body)?.faces[hit.face]?.plane;
    }
    if (!plane) {
      return;
    }
    this.app.view.setOriginPlanesVisible(false);
    // A face is cut slightly inside so the face itself shows the section.
    const inset = hit?.kind === 'face' ? -this.app.view.cam.worldPerPixel(this.app.view.height) : 0;
    this.app.setSection({ plane, offset: inset, flipped: false, inset });
    this.showControls();
  }

  private showControls(): void {
    const section = this.app.section!;
    this.handle ??= new Handle(this.app.view, 'arrow');
    this.placeHandle();
    this.app.ui.setHint('Drag the arrow to move the cut. It stays until you delete it in History.');
    this.app.ui.showPanel({
      title: 'Section View',
      items: [
        { type: 'number', label: 'Offset', value: section.offset, kind: 'length', onInput: value => this.setOffset(value) },
        { type: 'button', label: 'Flip', icon: 'flip', onClick: () => (this.app.setSection({ ...section, flipped: !this.app.section!.flipped }), this.showControls()) },
        { type: 'toggle', label: 'Section only', value: !!section.only, onChange: isOn => this.restyle({ only: isOn || undefined, flat: isOn ? undefined : section.flat }) },
        {
          type: 'toggle',
          label: '2D section',
          value: !!section.flat,
          onChange: (isOn) => {
            this.restyle({ flat: isOn || undefined, only: isOn ? undefined : section.only });
            if (isOn) {
              this.lookAtCut();
            }
          }
        },
        { type: 'button', label: 'Normal to Section', icon: 'normal', onClick: () => this.lookAtCut() },
        { type: 'button', label: 'Add Plane', icon: 'plane', onClick: () => this.placePlane() }
      ],
      actions: [{ id: 'delete', label: 'Delete Section', icon: 'trash', run: () => (this.app.setSection(null), this.handle?.dispose(), (this.handle = null), this.askForPlane()) }],
      onDone: () => this.app.setTool(null)
    });
  }

  private restyle(patch: Partial<SectionState>): void {
    const section = this.app.section;
    if (!section) {
      return;
    }
    this.app.setSection({ ...section, ...patch });
    this.showControls();
  }

  /** Look straight at the cut, from the side that's cut away. */
  private lookAtCut(): void {
    const section = this.app.section;
    if (!section) {
      return;
    }
    const plane = sectionPlane(section);
    this.app.view.cam.lookAlong(plane.normal, plane.xDir);
    this.app.view.fitAll();
  }

  /** A construction plane where the cut is now (to sketch on, split with...). */
  private placePlane(): void {
    const section = this.app.section;
    if (!section) {
      return;
    }
    const id = this.app.store.newIdentity('plane', 'Section Plane');
    // Exactly where the cut is - on the face itself while the cut is still the hair inside it.
    const untouched = section.inset !== undefined && Math.abs(section.offset - section.inset) < 1e-9;
    this.app.store.add({ ...id, type: 'plane', kind: 'offset', plane: section.plane, offset: untouched ? 0 : section.offset });
    this.app.ui.toast(`${id.name} placed on the cut`);
  }

  private setOffset(offset: number): void {
    const section = this.app.section;
    if (!section) {
      return;
    }
    this.app.setSection({ ...section, offset: offset });
    this.app.ui.updatePanelValues([offset]);
    this.placeHandle();
  }

  private placeHandle(): void {
    const section = this.app.section;
    if (!section || !this.handle) {
      return;
    }
    this.handle.set(add(section.plane.origin, scale(section.plane.normal, section.offset)), section.plane.normal);
  }

  down(pointer: ToolPointer): boolean {
    if (!this.handle?.hit(pointer) || !this.app.section) {
      return false;
    }
    this.dragging = { from: pointer, o0: this.app.section.offset };

    return true;
  }

  private get typing(): DragTyping {
    return (this._typing ??= new DragTyping(this.app));
  }
  private _typing: DragTyping | null = null;

  dragKey(e: KeyboardEvent): boolean {
    const dr = this.dragging;
    if (!dr) {
      return false;
    }

    return this.typing.key(e, {
      kind: 'length',
      apply: value => this.setOffset(value),
      commit: () => ((this.dragging = null), this.app.setTool(null)),
      cancel: () => this.setOffset(dr.o0)
    });
  }

  drag(pointer: ToolPointer): void {
    const section = this.app.section;
    if (!this.dragging || !section) {
      return;
    }
    this.typing.track(pointer);
    if (this.typing.active) {
      return;
    }
    const base = add(section.plane.origin, scale(section.plane.normal, this.dragging.o0));
    const raw = this.dragging.o0 + axisDrag(this.app.view, base, section.plane.normal, this.dragging.from, pointer);
    const step = niceStep(this.app.view.cam.worldPerPixel(this.app.view.height) * 4);
    this.setOffset(Math.round(raw / step) * step);
    this.app.ui.setLabel(pointer.x, pointer.y, fmtLen(this.app.section!.offset));
  }

  up(): void {
    this.dragging = null;
    this.typing.reset();
    this.app.ui.setLabel(0, 0, null);
  }

  key(e: KeyboardEvent): boolean {
    if (e.key === 'Escape' || e.key === 'Enter') {
      this.app.setTool(null);

      return true;
    }

    return false;
  }
}
