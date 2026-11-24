// The right column: what is used while modelling - Fit, Display - and one
// Settings button for what is set now and then (units & grid, snapping, the
// number pad, appearance), each row there showing how it is set now. Views
// are on the view cube; Screenshot is in Print / Share; History has its own
// button at the top. (Their lists are still kept by id: other parts of the
// app open them.)

import { render as mount } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { MOUSE_PRESETS, mousePreset, settings, type Settings } from '../settings';
import { fmtLen as lenText, UNIT_LABEL, units } from '../units';
import { TextField } from './components';
import { el } from './ui';
import type { SavedView, Units, Vec3 } from '../doc/types';
import type { DocStore } from '../doc/store';
import type { Viewport } from '../view/viewport';
import type { UI } from './ui';

/** Draws a panel into the popover's host (drawn afresh each time it is opened or refreshed). */
function show(host: HTMLElement, content: preact.ComponentChildren): void {
  mount(null, host);
  host.replaceChildren();
  mount(<>{content}</>, host);
}

function Heading({ text }: { text: string }) {
  return <div class="pop-heading">{text}</div>;
}

function Note({ text }: { text: string }) {
  return <div class="pop-note">{text}</div>;
}

interface ToggleRowProps {
  label: string;
  isOn: boolean;
  onChange: (isOn: boolean) => void;
}

function ToggleRow({ label, isOn, onChange }: ToggleRowProps) {
  const [isChecked, setIsChecked] = useState(isOn);

  return (
    <button
      class={`pop-row toggle-row${isChecked ? ' on' : ''}`}
      onClick={() => {
        setIsChecked(!isChecked);
        onChange(!isChecked);
      }}
    >
      <span>{label}</span>
      <span class="switch" />
    </button>
  );
}

interface ChoiceRowProps {
  label: string;
  isActive: boolean;
  title?: string;
  onClick: () => void;
  children?: preact.ComponentChildren;
}

function ChoiceRow({ label, isActive, title, onClick, children }: ChoiceRowProps) {
  return (
    <button class={`pop-row choice-row${isActive ? ' active' : ''}`} title={title} onClick={onClick}>
      {label}
      {children}
    </button>
  );
}

interface SliderRowProps {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (value: number) => void;
  format: (value: number) => string;
}

/** A slider with its value beside it (set while dragging). */
function SliderRow({ label, min, max, step, value, onChange, format }: SliderRowProps) {
  const [shown, setShown] = useState(value);

  return (
    <label class="pop-row slider-row">
      <span class="slider-label">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={shown}
        onInput={(event) => {
          const next = Number(event.currentTarget.value);
          setShown(next);
          onChange(next);
        }}
      />
      <span class="slider-value">{format(shown)}</span>
    </label>
  );
}

interface NavRowProps {
  label: string;
  value: string;
  onClick: () => void;
}

function NavRow({ label, value, onClick }: NavRowProps) {
  return (
    <button class="pop-row pop-nav" onClick={onClick}>
      <span>{label}</span>
      <span class="pop-value">{value}</span>
      <span class="pop-chev">›</span>
    </button>
  );
}

function fmtLen(mm: number): string {
  const rounded = +mm.toPrecision(2);

  return rounded >= 1000 ? `${rounded / 1000} m` : `${rounded} mm`;
}

function fmtStep(mm: number): string {
  // (In the unit in use: 10 mm was said as "1 cm" in a project of millimetres.)
  return lenText(mm, 4);
}

interface PanelContext {
  ui: UI;
  view: Viewport;
  store: DocStore;
  onUnits: (u: Units) => void;
}

function SnapPanel() {
  const value = settings.value;
  const snapRow = (key: keyof Settings['snap'], label: string) => (
    <ToggleRow label={label} isOn={value.snap[key]} onChange={isOn => settings.set('snap', { ...settings.value.snap, [key]: isOn })} />
  );

  return (
    <>
      <Heading text="Snap to" />
      {snapRow('grid', 'Grid')}
      {snapRow('guideLines', 'Sketch guide lines')}
      {snapRow('guidePoints', 'Sketch guide points')}
      {snapRow('points3d', '3D guide points')}
      {snapRow('distantEdges', 'Distant edges')}
      <Heading text="Show" />
      <ToggleRow label="Guide points" isOn={value.showGuidePoints} onChange={isOn => settings.set('showGuidePoints', isOn)} />
      <ToggleRow label="Snapping hints" isOn={value.showSnapHints} onChange={isOn => settings.set('showSnapHints', isOn)} />
      <Note text="Hold Shift while drawing to place a point without snapping." />
    </>
  );
}

const UNIT_LIST: [Units, string][] = [
  ['mm', 'Millimeter'],
  ['cm', 'Centimeter'],
  ['m', 'Meter'],
  ['in', 'Inch'],
  ['ft', 'Foot']
];

const gridNoteText = (isLocked: boolean, step: number) =>
  isLocked
    ? 'The squares stay this size at any zoom, and a sketch snaps to them. Switch the lock off for a grid that follows the zoom.'
    : `The grid follows the zoom (now ${fmtStep(step)} a square), and a sketch snaps to the squares shown. Lock it to keep them as they are now.`;

function UnitsPanel({ ui, view, onUnits }: PanelContext) {
  const value = settings.value;
  const rootRef = useRef<HTMLDivElement>(null);
  const [step, setStep] = useState(view.grid.step);

  // Not locked, the size follows the zoom while this is open: the row, the box and the note say the squares'
  // size as it is now (asked for: "the lock grid size should change on the fly when I zoom so I can see what
  // size grid it is in that moment").
  useEffect(() => {
    if (value.gridLocked) {
      return;
    }
    const follow = () => {
      // (Closed, or drawn again: this one is done.)
      if (!rootRef.current?.isConnected || rootRef.current.closest('[hidden]')) {
        view.frameHooks.delete(follow);

        return;
      }
      setStep(view.grid.step);
    };
    view.frameHooks.add(follow);

    return () => {
      view.frameHooks.delete(follow);
    };
  }, []);

  const handleLock = (isOn: boolean) => {
    // Switched on, it keeps the squares as they are right now, at this zoom (asked for: "I want the lock grid size
    // toggle to adjust to whatever the zoom level is so I can just click toggle on").
    if (isOn) {
      settings.set('gridStep', +view.grid.step.toPrecision(6));
    }
    settings.set('gridLocked', isOn);
    ui.refreshPopover();
  };

  return (
    <div ref={rootRef} style={{ display: 'contents' }}>
      <Heading text="Units" />
      {UNIT_LIST.map(([unit, label]) => (
        <ChoiceRow
          key={unit}
          label={label}
          isActive={units() === unit}
          onClick={() => {
            onUnits(unit);
            ui.refreshPopover();
          }}
        />
      ))}
      <Heading text="Grid" />
      <ToggleRow label={value.gridLocked ? `Lock grid size (${fmtStep(value.gridStep)})` : `Lock grid size (now ${fmtStep(step)})`} isOn={value.gridLocked} onChange={handleLock} />
      <label class="pop-row">
        <span>Locked size (mm)</span>
        {/* (Not locked: the squares' size right now - what locking would keep.) */}
        <TextField
          className="pop-input"
          inputMode="decimal"
          value={String(value.gridLocked ? value.gridStep : +step.toPrecision(6))}
          onChange={(text) => {
            const typed = Number(text);
            if (typed > 0) {
              settings.set('gridStep', typed);
            }
          }}
        />
      </label>
      <Note text={gridNoteText(value.gridLocked, step)} />
      <Heading text="Degree format" />
      <ChoiceRow
        label="Decimal (27.15°)"
        isActive={value.degrees === 'decimal'}
        onClick={() => {
          settings.set('degrees', 'decimal');
          ui.refreshPopover();
        }}
      />
      <ChoiceRow
        label="Fractional (27° 15′)"
        isActive={value.degrees === 'fractional'}
        onClick={() => {
          settings.set('degrees', 'fractional');
          ui.refreshPopover();
        }}
      />
    </div>
  );
}

function AppearancePanel() {
  const value = settings.value;

  return (
    <>
      <Heading text="Appearance" />
      <ToggleRow label="Animate camera" isOn={value.animateCamera} onChange={isOn => settings.set('animateCamera', isOn)} />
      <ToggleRow label="Orthographic" isOn={value.ortho} onChange={isOn => settings.set('ortho', isOn)} />
      <ToggleRow label="Show grid" isOn={value.showGrid} onChange={isOn => settings.set('showGrid', isOn)} />
      <ToggleRow label="Show world axes" isOn={value.showAxes} onChange={isOn => settings.set('showAxes', isOn)} />
    </>
  );
}

// Mouse: which drags turn, move and zoom the view - the app's own way or another CAD program's, for hands used
// to it (asked for by many: "a setting menu with a list: default, Autodesk, onshape, etc", then "it should have
// controls presets from all major CAD apps"). Only where there is a mouse.
function MousePanel({ ui }: PanelContext) {
  const value = settings.value;
  const now = mousePreset(value.mouse);

  return (
    <>
      <Heading text="Mouse like in" />
      {MOUSE_PRESETS.map(preset => (
        <ChoiceRow
          key={preset.id}
          label={preset.apps}
          isActive={now.id === preset.id}
          title={preset.text}
          onClick={() => {
            settings.set('mouse', preset.id);
            ui.refreshPopover();
          }}
        />
      ))}
      <Note text={now.text} />
      <Heading text="Wheel" />
      <ToggleRow label="Forward zooms out" isOn={value.wheelReverse} onChange={isOn => settings.set('wheelReverse', isOn)} />
      <Note text="Always: the wheel zooms where the pointer is, a plain right drag turns the view, Alt + left drag turns it too (a trackpad), and a left drag on empty space draws a box to select with." />
    </>
  );
}

function ViewsPanel({ ui, view, store }: PanelContext) {
  const [, repaint] = useState(0);
  // Picking a view closes the list (it would only cover the view picked).
  const go = (label: string, direction: Vec3, x?: Vec3) => (
    <ChoiceRow
      label={label}
      isActive={false}
      onClick={() => {
        view.cam.flatUntilTurned();
        view.cam.lookAlong(direction, x);
        ui.closePopover();
      }}
    />
  );

  return (
    <>
      <Heading text="Views" />
      <div>
        <ChoiceRow
          label="⌂ Default view"
          isActive={false}
          onClick={() => {
            view.cam.iso();
            view.fitAll();
            ui.closePopover();
          }}
        />
        {go('Top', [0, 0, 1])}
        {go('Bottom', [0, 0, -1])}
        {go('Front', [0, -1, 0])}
        {go('Back', [0, 1, 0], [-1, 0, 0])}
        {go('Right', [1, 0, 0], [0, 1, 0])}
        {go('Left', [-1, 0, 0], [0, -1, 0])}
        <Heading text="Saved views" />
        {store.doc.views.map(savedView => (
          <ChoiceRow
            key={savedView.name}
            label={savedView.name}
            isActive={false}
            onClick={() => {
              view.cam.restore(savedView);
              ui.closePopover();
            }}
          >
            <button
              class="icon-btn small"
              title="Delete view"
              onClick={(event) => {
                event.stopPropagation();
                store.commit(draft => (draft.views = draft.views.filter(other => other.name !== savedView.name)));
                repaint(count => count + 1);
              }}
            >
              ✕
            </button>
          </ChoiceRow>
        ))}
        <ChoiceRow
          label="＋ Save current view"
          isActive={false}
          onClick={() => {
            const savedView: SavedView = view.cam.savedView(`View ${store.doc.views.length + 1}`);
            store.commit(draft => draft.views.push(savedView));
            repaint(count => count + 1);
          }}
        />
      </div>
    </>
  );
}

function DisplayPanel({ ui }: PanelContext) {
  const value = settings.value;
  const choose = <K extends 'shader' | 'analysis'>(key: K, id: Settings[K]) => {
    settings.set(key, id);
    ui.refreshPopover();
  };

  return (
    <>
      <Heading text="Shaders" />
      {([['wireframe', 'Wireframe'], ['xray', 'X-Ray'], ['shaded', 'Shaded']] as const).map(([id, label]) => (
        <ChoiceRow key={id} label={label} isActive={value.shader === id} onClick={() => choose('shader', id)} />
      ))}
      <Heading text="Options" />
      <ToggleRow label="Show edges" isOn={value.showEdges} onChange={isOn => settings.set('showEdges', isOn)} />
      <ToggleRow label="Show hidden edges" isOn={value.showHiddenEdges} onChange={isOn => settings.set('showHiddenEdges', isOn)} />
      {/* Surface analysis: how smoothly faces meet (zebra), how much they bend (curvature). */}
      <Heading text="Analysis" />
      {([['none', 'Off'], ['zebra', 'Zebra stripes'], ['curvature', 'Curvature map']] as const).map(([id, label]) => (
        <ChoiceRow key={id} label={label} isActive={value.analysis === id} onClick={() => choose('analysis', id)} />
      ))}
      {value.analysis === 'zebra' && (
        <>
          <ToggleRow label="Horizontal stripes" isOn={value.zebraDirection === 'horizontal'} onChange={isOn => settings.set('zebraDirection', isOn ? 'horizontal' : 'vertical')} />
          <SliderRow label="Stripes" min={4} max={48} step={1} value={value.zebraStripes} onChange={stripes => settings.set('zebraStripes', stripes)} format={String} />
        </>
      )}
      {value.analysis === 'curvature' && (
        <>
          {/* On a log scale: a 0.5 mm fillet and a 5 m roof both get a useful setting. */}
          <SliderRow
            label="Full colour at radius"
            min={Math.log10(0.5)}
            max={Math.log10(5000)}
            step={0.01}
            value={Math.log10(value.curvatureRadius)}
            onChange={logRadius => settings.set('curvatureRadius', +(10 ** logRadius).toPrecision(2))}
            format={logRadius => fmtLen(10 ** logRadius)}
          />
          <Note text="Red: domed. Green: flat. Blue: hollow." />
        </>
      )}
    </>
  );
}

type SettingsPage = 'units' | 'snap' | 'appearance' | 'mouse';

interface SettingsPanelProps extends PanelContext {
  page: SettingsPage | null;
  setPage: (page: SettingsPage | null) => void;
  pages: Record<SettingsPage, (context: PanelContext) => preact.ComponentChildren>;
}

// Settings: one row for each thing set now and then, saying how it is set; a tap opens its list (and back).
function SettingsPanel({ page, setPage, pages, ...context }: SettingsPanelProps) {
  const value = settings.value;
  if (page) {
    return (
      <>
        <button class="pop-row pop-back" onClick={() => setPage(null)}>
          ‹  Settings
        </button>
        {pages[page](context)}
      </>
    );
  }
  const snaps = Object.values(value.snap).filter(Boolean).length;

  return (
    <>
      <Heading text="Settings" />
      <NavRow label="Units & grid" value={`${UNIT_LABEL[units()]}${value.gridLocked ? ` · grid ${value.gridStep} mm` : ''}`} onClick={() => setPage('units')} />
      <NavRow label="Snapping" value={snaps ? `${snaps} of ${Object.keys(value.snap).length} on` : 'Off'} onClick={() => setPage('snap')} />
      <ToggleRow label="Number pad on screen" isOn={value.numpad} onChange={isOn => settings.set('numpad', isOn)} />
      <NavRow label="Appearance" value={`${value.ortho ? 'Orthographic' : 'Perspective'}${value.showGrid ? '' : ' · no grid'}`} onClick={() => setPage('appearance')} />
      {matchMedia('(any-pointer: fine)').matches && <NavRow label="Mouse" value={mousePreset(value.mouse).apps.split(',')[0]} onClick={() => setPage('mouse')} />}
    </>
  );
}

export function setupRightColumn(ui: UI, view: Viewport, store: DocStore, onUnits: (u: Units) => void, isolatedNames: () => string[] = () => []): void {
  const context: PanelContext = { ui, view, store, onUnits };
  ui.addRight('fit', 'fit', 'Zoom to fit (F)', () => view.fitAll(), () => 'Fit');
  // (Kept by id, with no button in the column: opened from Settings.)
  const stash = { host: el('div', ''), className: 'right-btn' };
  const pages: SettingsPanelProps['pages'] = {
    snap: () => <SnapPanel />,
    units: panelContext => <UnitsPanel {...panelContext} />,
    appearance: () => <AppearancePanel />,
    mouse: panelContext => <MousePanel {...panelContext} />
  };
  ui.addRight('snap', 'magnet', 'Snapping', host => show(host, <SnapPanel />), undefined, stash);
  ui.addRight('units', 'ruler', 'Units & grid', host => show(host, <UnitsPanel {...context} />), () => UNIT_LABEL[units()], stash);
  // Appearance (camera, projection, grid, axes): back in the right-hand column.
  ui.addRight('appearance', 'eye', 'Appearance', host => show(host, <AppearancePanel />), undefined, stash);

  // Views (standard and saved): the button at the view cube's bottom right.
  const cube = document.getElementById('viewcube')!;
  ui.addRight('views', 'views', 'Views (tap to open / close)', host => show(host, <ViewsPanel {...context} />), undefined, { host: cube, className: 'vc-roll bottom right vc-views' });

  ui.addRight(
    'display',
    'display',
    'Display modes',
    host => show(host, <DisplayPanel {...context} />),
    () => (settings.value.analysis === 'zebra' ? 'Zebra' : settings.value.analysis === 'curvature' ? 'Curv.' : ({ shaded: 'Shaded', wireframe: 'Wire', xray: 'X-Ray' })[settings.value.shader])
  );

  ui.addRight('shot', 'camera', 'Screenshot', () => {
    void view.screenshot({ project: store.doc.name, isolated: isolatedNames() }).then((blob) => {
      if (!blob) {
        return;
      }
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${store.doc.name} ${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      ui.toast('Screenshot saved');
    });
  }, undefined, stash);

  // On-screen numpad: one tap on, one tap off (lit while on).
  const pad = ui.addRight('numpad', 'numpad', 'On-screen numpad for typing values (tap to switch on / off)', () => {
    settings.set('numpad', !settings.value.numpad);
    ui.toast(settings.value.numpad ? 'On-screen numpad on' : 'On-screen numpad off');
  }, () => 'NumPad', stash);
  const markPad = () => pad.classList.toggle('on', settings.value.numpad);
  settings.onChange(() => (markPad(), ui.refreshRight()));
  markPad();
  ui.addRight('history', 'history', 'History', () => ui.toggleHistory(), undefined, stash);

  let page: SettingsPage | null = null;
  const gear = ui.addRight(
    'settings',
    'settings',
    'Settings',
    (host) => {
      show(host, (
        <SettingsPanel
          {...context}
          page={page}
          pages={pages}
          setPage={(next) => {
            page = next;
            ui.refreshPopover();
          }}
        />
      ));
    },
    () => UNIT_LABEL[units()]
  );
  // (Opened afresh: its first page.)
  gear.addEventListener('pointerdown', () => (page = null));
  // Sketch mode only (CSS shows it under body.sketching): show/hide the constraint column.
  const cons = ui.addRight('constraints', 'constraints', 'Constraints (sketch)', () => settings.set('showConstraints', !settings.value.showConstraints));
  cons.classList.add('sketch-only');
  const mark = () => cons.classList.toggle('on', settings.value.showConstraints);
  settings.onChange(mark);
  mark();
  settings.onChange(() => ui.refreshRight());
}
