import { settings } from '../settings';
import { cross, dist, dot, len, sub } from '../geom';
import { el } from '../ui/ui';
import { fmtLen, trim, UNIT_MM, UNIT_LABEL, units } from '../units';
import { hitToSel, sameSel, type AppContext, type Sel, type Tool } from './tool';
import type { ToolPointer } from '../view/input';
import type { BodyMesh } from '../kernel/protocol';
import type { PinDef, Vec3 } from '../doc/types';

export interface MeasureHost extends AppContext {
  readonly pins: PinDef[];
  setPins(p: PinDef[]): void;
}

interface Row {
  name: string;
  value: string;
  at: Vec3;
  a?: Vec3;
  b?: Vec3;
}

/**
 * Measure: tap faces, edges or bodies; a card lists what can be measured
 * about them (and between two of them). Pin any value to keep it visible.
 */
export class MeasureTool implements Tool {
  readonly id = 'measure';
  private items: Sel[] = [];
  private card: HTMLElement | null = null;
  private deltas = false;

  constructor(private app: MeasureHost) {}

  enter(): void {
    this.app.ui.setTools([{ id: 'exit', label: 'Exit Measure', icon: 'exit', shortcut: 'Esc', run: () => this.app.setTool(null) }]);
    // The view tools stay, this one lit and pulsing (tap it again to close it).
    this.app.ui.setBottom(this.app.bottomTools());
    this.app.ui.setHint('Tap faces, edges or points to see their sizes. Double-tap for a whole body.');
    this.card = el('div', 'measure-card');
    document.body.append(this.card);
    this.render();
  }

  exit(): void {
    this.card?.remove();
    this.app.ui.setHint(null);
    this.app.setSelection([]);
    this.app.setHover(null);
  }

  hover(pointer: ToolPointer | null): void {
    this.app.setHover(pointer ? hitToSel(this.app.view.pick(pointer.x, pointer.y, { edgeTolPx: pointer.tol, profiles: false, planes: false })) : null);
  }

  tap(pointer: ToolPointer, count: number): void {
    let selection = hitToSel(this.app.view.pick(pointer.x, pointer.y, { edgeTolPx: pointer.tol, profiles: false, planes: false }));
    if (!selection) {
      // Empty space: first clears, second leaves Measure.
      if (!this.items.length) {
        return this.app.setTool(null);
      }
      this.items = [];
    } else {
      if (count >= 2 && (selection.kind === 'face' || selection.kind === 'edge' || selection.kind === 'vertex')) {
        selection = { kind: 'body', body: selection.body };
      }
      const i = this.items.findIndex(item => sameSel(item, selection!));
      if (i >= 0) {
        this.items.splice(i, 1);
      } else {
        this.items = [...this.items.slice(-1), selection];
      }
    }
    this.app.setSelection(this.items);
    this.render();
  }

  key(e: KeyboardEvent): boolean {
    if (e.key === 'Escape') {
      if (this.items.length) {
        this.items = [];
        this.app.setSelection([]);
        this.render();
      } else {
        this.app.setTool(null);
      }

      return true;
    }

    return false;
  }

  private render(): void {
    if (!this.card) {
      return;
    }
    this.card.innerHTML = '';
    const rows = this.measurements();
    const head = el('label', 'measure-toggle');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = this.deltas;
    box.addEventListener('change', () => ((this.deltas = box.checked), this.render()));
    head.append(box, ' Include X, Y, Z deltas');
    const show = el('label', 'measure-toggle');
    const sbox = document.createElement('input');
    sbox.type = 'checkbox';
    sbox.checked = settings.value.showPinned;
    sbox.addEventListener('change', () => settings.set('showPinned', sbox.checked));
    show.append(sbox, ' Show pinned measurements');
    this.card.append(head, show);
    if (!rows.length) {
      this.card.append(el('div', 'measure-empty', 'Nothing selected'));
    }
    for (const tableRow of rows) {
      const row = el('div', 'measure-row');
      row.append(el('div', 'measure-value', tableRow.value), el('div', 'measure-name', tableRow.name));
      const pin = el('button', 'icon-btn', '📌');
      pin.title = 'Pin to always show';
      pin.addEventListener('click', () => (this.app.addPin({ text: tableRow.value, at: tableRow.at, a: tableRow.a, b: tableRow.b }), this.render()));
      row.append(pin);
      this.card.append(row);
    }
    if (this.app.pins.length) {
      const clear = el('button', 'text-btn', `Clear ${this.app.pins.length} pinned`);
      clear.addEventListener('click', () => (this.app.setPins([]), this.render()));
      this.card.append(clear);
    }
  }

  private measurements(): Row[] {
    const out: Row[] = [];
    const info = this.items.map(item => this.describe(item)).filter((described): described is Described => !!described);
    for (const described of info) {
      out.push(...described.rows);
    }
    if (info.length === 2) {
      const [a, b] = info;
      const mid = (point: Vec3, q: Vec3): Vec3 => [(point[0] + q[0]) / 2, (point[1] + q[1]) / 2, (point[2] + q[2]) / 2];
      out.push({ name: 'Distance (centers)', value: fmtLen(dist(a.anchor, b.anchor)), at: mid(a.anchor, b.anchor), a: a.anchor, b: b.anchor });
      const closest = closestPair(a.points, b.points);
      out.push({ name: 'Minimum distance', value: fmtLen(closest.d), at: mid(closest.p, closest.q), a: closest.p, b: closest.q });
      if (this.deltas) {
        const delta = sub(b.anchor, a.anchor);
        ['X', 'Y', 'Z'].forEach((axisName, i) => {
          const end = [...a.anchor] as Vec3;
          end[i] = b.anchor[i];
          out.push({ name: `Δ${axisName}`, value: fmtLen(Math.abs(delta[i])), at: mid(a.anchor, end), a: a.anchor, b: end });
        });
      }
      if (a.dir && b.dir) {
        const ang = (Math.acos(Math.min(1, Math.abs(dot(a.dir, b.dir)))) * 180) / Math.PI;
        out.push({ name: 'Angle', value: `${trim(ang, 2)}°`, at: mid(a.anchor, b.anchor) });
      }
    }

    return out;
  }

  private describe(highlight: Sel): Described | null {
    if (highlight.kind !== 'face' && highlight.kind !== 'edge' && highlight.kind !== 'body' && highlight.kind !== 'vertex') {
      return null;
    }
    const b = this.app.view.body(highlight.body);
    if (!b) {
      return null;
    }
    if (highlight.kind === 'vertex') {
      const vertex = this.app.view.vertexOf(highlight.body, highlight.vertex);
      if (!vertex) {
        return null;
      }
      const unitScale = UNIT_MM[units()];

      return { rows: [{ name: 'Point (X, Y, Z)', value: vertex.map(coordinate => trim(coordinate / unitScale, 3)).join(', '), at: vertex }], anchor: vertex, points: [vertex] };
    }
    if (highlight.kind === 'face') {
      const face = b.faces[highlight.face];
      const pts = facePoints(b, highlight.face);
      const rows: Row[] = [{ name: `Surface area · ${niceType(face.type)}`, value: fmtArea(face.area), at: face.center }];
      // A round face (a shaft, a hole): its diameter, pinned as a line straight across it.
      if (face.round) {
        const radius = face.round.r;
        const across = acrossCylinder(b, highlight.face, radius, face.round.hole, face.center);
        rows.push({ name: face.round.hole ? 'Diameter · hole' : 'Diameter', value: `Ø ${fmtLen(2 * radius)}`, at: across?.mid ?? face.center, ...(across ? { a: across.a, b: across.b } : {}) });
        rows.push({ name: 'Radius', value: `R ${fmtLen(radius)}`, at: across?.b ?? face.center, ...(across ? { a: across.mid, b: across.b } : {}) });
      }

      return { rows, anchor: face.center, points: pts, dir: face.plane ? face.normal : undefined };
    }
    if (highlight.kind === 'edge') {
      const e = b.edges[highlight.edge];
      const pts = edgePoints(b, highlight.edge);
      const rows: Row[] = [{ name: `Length · ${niceType(e.type)}`, value: fmtLen(e.length), at: e.mid, ...(e.type === 'LINE' ? { a: e.start, b: e.end } : {}) }];
      if (e.type === 'CIRCLE' && pts.length >= 3) {
        const radius = circumradius(pts[0], pts[Math.floor(pts.length / 3)], pts[Math.floor((2 * pts.length) / 3)]);
        if (radius) {
          rows.push({ name: 'Diameter', value: fmtLen(2 * radius), at: e.mid }, { name: 'Radius', value: fmtLen(radius), at: e.mid });
        }
      }

      return { rows, anchor: e.mid, points: pts, dir: e.type === 'LINE' ? e.dir : undefined };
    }
    const pts: Vec3[] = [];
    for (let i = 0; i < b.positions.length; i += 3) {
      pts.push([b.positions[i], b.positions[i + 1], b.positions[i + 2]]);
    }
    const min = [0, 1, 2].map(axis => Math.min(...pts.map(point => point[axis])));
    const max = [0, 1, 2].map(axis => Math.max(...pts.map(point => point[axis])));
    const center: Vec3 = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
    const area = b.faces.reduce((s2, face) => s2 + face.area, 0);

    return {
      rows: [
        { name: 'Size (X × Y × Z)', value: `${trim((max[0] - min[0]) / UNIT_MM[units()], 3)} × ${trim((max[1] - min[1]) / UNIT_MM[units()], 3)} × ${fmtLen(max[2] - min[2])}`, at: center },
        { name: 'Surface area', value: fmtArea(area), at: center },
        { name: 'Volume', value: fmtVolume(volume(b)), at: center }
      ],
      anchor: center,
      points: pts
    };
  }
}

interface Described {
  rows: Row[];
  anchor: Vec3;
  points: Vec3[];
  dir?: Vec3;
}

function facePoints(b: BodyMesh, face: number): Vec3[] {
  const faceGroup = b.faceGroups.find(faceGroup => faceGroup.face === face);
  if (!faceGroup) {
    return [];
  }
  const out: Vec3[] = [];
  for (let i = faceGroup.start; i < faceGroup.start + faceGroup.count; i++) {
    const offset = b.indices[i] * 3;
    out.push([b.positions[offset], b.positions[offset + 1], b.positions[offset + 2]]);
  }

  return out;
}

function edgePoints(b: BodyMesh, edge: number): Vec3[] {
  const edgeGroup = b.edgeGroups.find(edgeGroup => edgeGroup.edge === edge);
  if (!edgeGroup) {
    return [];
  }
  const out: Vec3[] = [];
  for (let i = edgeGroup.start; i < edgeGroup.start + edgeGroup.count; i++) {
    out.push([b.edgePositions[i * 3], b.edgePositions[i * 3 + 1], b.edgePositions[i * 3 + 2]]);
  }

  return out;
}

/**
 * A line straight across a round face, through its axis, level with the
 * middle of the face: its ends on the surface (null where the face's own
 * normals can't tell the axis).
 */
function acrossCylinder(b: BodyMesh, face: number, radius: number, hole: boolean, center: Vec3): { a: Vec3; b: Vec3; mid: Vec3 } | null {
  const faceGroup = b.faceGroups.find(faceGroup => faceGroup.face === face);
  if (!faceGroup || !faceGroup.count) {
    return null;
  }
  const at = (i: number): { p: Vec3; n: Vec3 } => {
    const offset = b.indices[i] * 3;

    return { p: [b.positions[offset], b.positions[offset + 1], b.positions[offset + 2]], n: [b.normals[offset], b.normals[offset + 1], b.normals[offset + 2]] };
  };
  const first = at(faceGroup.start);
  // The surface's normals all stand square to the axis: two far apart give it.
  let axis: Vec3 | null = null;
  let best = 0.2;
  for (let i = faceGroup.start; i < faceGroup.start + faceGroup.count; i++) {
    const normalCross = cross(first.n, at(i).n);
    const length = len(normalCross);
    if (length > best) {
      best = length;
      axis = [normalCross[0] / length, normalCross[1] / length, normalCross[2] / length];
    }
  }
  if (!axis) {
    return null;
  }
  // (A hole's surface faces its axis, a shaft's away from it.)
  const inward = hole ? radius : -radius;
  const onAxis: Vec3 = [first.p[0] + first.n[0] * inward, first.p[1] + first.n[1] * inward, first.p[2] + first.n[2] * inward];
  const t = dot(sub(center, onAxis), axis);
  const mid: Vec3 = [onAxis[0] + axis[0] * t, onAxis[1] + axis[1] * t, onAxis[2] + axis[2] * t];
  const side = dot(first.n, axis);
  const u0: Vec3 = [first.n[0] - axis[0] * side, first.n[1] - axis[1] * side, first.n[2] - axis[2] * side];
  const ul = len(u0);
  if (ul < 1e-9) {
    return null;
  }
  const unitU: Vec3 = [u0[0] / ul, u0[1] / ul, u0[2] / ul];

  return { a: [mid[0] - unitU[0] * radius, mid[1] - unitU[1] * radius, mid[2] - unitU[2] * radius], b: [mid[0] + unitU[0] * radius, mid[1] + unitU[1] * radius, mid[2] + unitU[2] * radius], mid };
}

function closestPair(a: Vec3[], b: Vec3[]): { d: number; p: Vec3; q: Vec3 } {
  let best = { d: Infinity, p: a[0], q: b[0] };
  const step = (count: number) => Math.max(1, Math.floor(count / 600));
  for (let i = 0; i < a.length; i += step(a.length)) {
    for (let j = 0; j < b.length; j += step(b.length)) {
      const distance = dist(a[i], b[j]);
      if (distance < best.d) {
        best = { d: distance, p: a[i], q: b[j] };
      }
    }
  }

  return best;
}

function circumradius(a: Vec3, b: Vec3, pointC: Vec3): number | null {
  const ab = len(sub(b, a));
  const bc = len(sub(pointC, b));
  const ca = len(sub(a, pointC));
  const area2 = len(cross(sub(b, a), sub(pointC, a)));

  return area2 > 1e-12 ? (ab * bc * ca) / (2 * area2) : null;
}

/** Signed-tetrahedron volume of the (closed) mesh. */
function volume(b: BodyMesh): number {
  let volume = 0;
  const positions = b.positions;
  for (let i = 0; i < b.indices.length; i += 3) {
    const a = b.indices[i] * 3;
    const offsetC = b.indices[i + 1] * 3;
    const offsetD = b.indices[i + 2] * 3;
    volume += (positions[a] * (positions[offsetC + 1] * positions[offsetD + 2] - positions[offsetC + 2] * positions[offsetD + 1]) - positions[a + 1] * (positions[offsetC] * positions[offsetD + 2] - positions[offsetC + 2] * positions[offsetD]) + positions[a + 2] * (positions[offsetC] * positions[offsetD + 1] - positions[offsetC + 1] * positions[offsetD])) / 6;
  }

  return Math.abs(volume);
}

function fmtArea(mm2: number): string {
  const factor = UNIT_MM[units()];

  return `${trim(mm2 / (factor * factor), 3)} ${UNIT_LABEL[units()]}²`;
}

function fmtVolume(mm3: number): string {
  const factor = UNIT_MM[units()];

  return `${trim(mm3 / (factor * factor * factor), 3)} ${UNIT_LABEL[units()]}³`;
}

function niceType(t: string): string {
  return t.toLowerCase().replace(/_/g, ' ').replace('bspline', 'free-form').replace('cylindre', 'cylinder');
}
