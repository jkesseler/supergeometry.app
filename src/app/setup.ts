// Wiring the App's collaborators to it: the busy spinner, VR/AR, the sentence bar, variable tags and the Items panel.

import { FeatureOp } from '../tools/featureOp';
import { FreeformTool } from '../tools/freeform';
import { TransformOp } from '../tools/ops';
import { settings } from '../settings';
import { isTouchDevice } from '../device';
import { SketchTool } from '../tools/sketch';
import { Ghost } from '../tools/ghost';
import { evaluate, setVariables } from '../units';
import { pickTolerance } from '../device';
import { isHeadset } from '../device';
import { VRMode, vrSupported } from '../view/xr';
import type { App } from '../app';
import type { ItemsHandlers } from '../ui/items';
import type { SentenceHost } from '../ui/sentence';
import type { VariableTagsHost } from '../tools/variableTags';

export function setupBusy(app: App): void {
  // A spinner while the geometry engine works on something that takes a moment.
  const busy = document.createElement('div');
  busy.id = 'busy';
  busy.hidden = true;
  busy.innerHTML = '<span class="spinner"></span><span>Working…</span><button type="button" class="busy-stop" title="Stop - takes back the last change">Stop</button>';
  document.body.append(busy);
  busy.querySelector('.busy-stop')!.addEventListener('click', () => app.stopWork());
  let busyTimer = 0;
  let busyWatch = 0;
  app.kernel.onBusy = (on) => {
    clearTimeout(busyTimer);
    clearInterval(busyWatch);
    // Only for waits you would notice (not every quick preview while dragging).
    if (on) {
      busyTimer = window.setTimeout(() => {
        if (!app.kernel.busy) {
          return;
        }
        busy.hidden = false;
        // Shown only while there is work: looked at again as it stands, so it can never stay up over nothing
        // (asked for: "sometimes the working icon still is showing even if there's nothing to work on").
        busyWatch = window.setInterval(() => {
          if (app.kernel.busy) {
            return;
          }
          busy.hidden = true;
          clearInterval(busyWatch);
        }, 400);
      }, 300);
    } else {
      busy.hidden = true;
    }
  };
  app.kernel.onLost = () => {
    app.ui.toast('The geometry engine stopped and was started again - the last change may need doing again', 'error');
    void app.regenerate();
  };
}

export function setupVR(app: App): void {
  // VR only in a headset's own browser (never on a computer, headset connected or not). A viewer: the model as a real thing in your room.
  // On a phone or tablet it's AR: the model in the room through the camera.
  const handheld = isTouchDevice && !isHeadset;
  const vr: VRMode = (app.vr = new VRMode({
    renderer: app.view.renderer,
    handheld,
    scene: app.view.scene,
    bounds: () => app.view.modelBounds(),
    xray: () => {
      const on = settings.value.shader !== 'xray';
      settings.set('shader', on ? 'xray' : 'shaded');

      return on ? 'X-Ray' : 'Shaded';
    },
    edges: () => {
      const on = !settings.value.showEdges;
      settings.set('showEdges', on);

      return on ? 'Edges shown' : 'Edges hidden';
    },
    looks: () => ({ xray: settings.value.shader === 'xray' ? 'Shaded' : 'X-Ray', edges: settings.value.showEdges ? 'Hide Edges' : 'Show Edges' }),
    beforeFrame: () => app.view.xrFrame(),
    onEnter: () => {
      app.setTool(null);
      app.setSelection([]);
      app.view.xrMode(true);
    },
    onExit: () => app.view.xrMode(false)
  }));
    // In the top bar, where it's seen, in a headset; under More on a phone or tablet (when its browser can show AR); never on a computer.
  const vrBtn = document.getElementById('vr-btn')!;
  if (handheld) {
    vrBtn.textContent = 'Enter AR';
    vrBtn.title = 'See the model in your room through the camera';
    // A phone or tablet: under More (History has its place in the top bar).
    vrBtn.className = '';
    vrBtn.addEventListener('click', () => (document.getElementById('more-menu')!.hidden = true));
    document.getElementById('more-menu')!.prepend(vrBtn);
  }
  const checkVR = () => void vrSupported(handheld).then(ok => (vrBtn.hidden = !isHeadset && !(handheld && ok)));
  if (isTouchDevice) {
    checkVR();
    (navigator as Navigator & { xr?: EventTarget }).xr?.addEventListener('devicechange', checkVR);
  } else {
    vrBtn.remove();
  }
  vrBtn.addEventListener('click', async () => {
    if (!(await vrSupported(handheld))) {
      return app.ui.toast(handheld ? "This browser can't show AR - try Chrome" : "This browser can't open VR here - open superGeometry.app in the headset's own browser");
    }
    vr.enter().catch((e: unknown) => app.ui.toast(`${handheld ? 'AR' : 'VR'} didn't start: ${e instanceof Error ? e.message : e}`));
  });
}

export function sentenceHost(app: App): SentenceHost {
  return {
    ui: app.ui,
    view: app.view,
    mainTools: () => app.mainTools(),
    selection: () => app.selection,
    mode: () => (app.tool === app.selectTool ? 'model' : app.tool instanceof SketchTool ? 'sketch' : app.tool instanceof FreeformTool ? 'freeform' : 'tool'),
    sketchPicked: () => (app.tool instanceof SketchTool ? app.tool.pickedCount : 0),
    waiting: () => (app.tool === app.selectTool ? app.selectTool.waiting : null),
    peek: (segs) => {
      app.peekGhost?.dispose();
      app.peekGhost = segs ? new Ghost(app.view, segs) : null;
    },
    pick: sel => app.setSelection(sel),
    adding: () => app.selectTool.adding,
    setAdding: on => ((app.selectTool.adding = on), app.sentence.changed()),
    stopWaiting: () => app.selectTool.stopWaiting(),
    anchor: () => app.pickAnchor(),
    retap: () => {
      const lastTapAt = app.lastTapAt;
      if (lastTapAt) {
        app.tool.tap?.({ x: lastTapAt.x, y: lastTapAt.y, type: lastTapAt.type, shift: false, tol: pickTolerance(lastTapAt.type) }, 1);
      }
    }
  };
}

export function variableTagHost(app: App): VariableTagsHost {
  return {
    variables: () => app.store.doc.variables,
    check: (name, expr, kind) => {
      const list = app.store.doc.variables;
      setVariables(list.map(variable => (variable.name === name ? { name, expr } : variable)));
      try {
        return evaluate(expr, 'number') === null ? null : evaluate(name, kind);
      } finally {
        setVariables(list);
      }
    },
    setVariable: (name, expr) => {
      const list = app.store.doc.variables;
      const next = list.map(variable => (variable.name === name ? { name, expr } : variable));
      setVariables(next);
      const bad = next.some(variable => evaluate(variable.expr) === null);
      setVariables(list);
      if (bad) {
        return false;
      }
      if (list.find(variable => variable.name === name)?.expr !== expr) {
        app.store.commit(draft => (draft.variables = next));
      }

      return true;
    }
  };
}

export function itemsHost(app: App): ItemsHandlers {
  return {
    // A phone: like taps in the view, each body tapped in Items joins the
    // selection (tapped again, it leaves) - Subtract needs two bodies, and
    // the second one replaced the first.
    selectBody: (id) => {
      if (app.tool === app.selectTool && app.selectTool.pickFromList({ kind: 'body', body: id })) {
        return;
      }
      // A pattern (mirror, move…) under way: the body joins it, or leaves it.
      // (After the first body the view's taps go to its direction: four
      // pockets to pattern across could only be had by starting again.)
      if (app.tool instanceof TransformOp && app.tool.toggleBody(id)) {
        return;
      }
      // Subtract, Shell… waiting for a body: it takes this one.
      if (app.tool instanceof FeatureOp && app.tool.pickBody(id)) {
        return;
      }
      app.togglePick({ kind: 'body', body: id });
    },
    editSketch: id => app.setTool(new SketchTool(app, { sketchId: id })),
    selectPlane: id => app.togglePick({ kind: 'plane', id }),
    deleteBody: id => app.store.add({ ...app.store.newIdentity('delete'), type: 'delete', bodies: [id] }),
    deleteFeature: id => app.store.remove(id),
    selectImage: id => app.togglePick({ kind: 'image', id }),
    rename: async (id, current, isBody) => {
      const answers = await app.ui.dialog('Rename', [{ key: 'name', label: 'Name', value: current }]);
      const name = answers?.name.trim();
      if (!name) {
        return;
      }
      if (isBody) {
        app.store.commit(draft => (draft.names = { ...(draft.names ?? {}), [id]: name }));
      } else {
        app.store.update(id, { name });
      }
    },
    askName: async (title, current) => (await app.ui.dialog(title, [{ key: 'name', label: 'Name', value: current }]))?.name.trim() || null,
    isolated: () => app.isolatedWithSketches()
  };
}
