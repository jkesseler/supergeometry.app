// The technical sheet: the project as a document. A title block (who, what,
// which revision), the parts list - each body with its item number, material,
// volume, area, mass, centre of mass and size - and the technical data of
// every material used. The item numbers are the ones the drawings' balloons
// point to: the drawings show the shapes, this sheet says what they are made of.
//
// It prints (or saves as a PDF from the print window) and its parts list
// downloads as a spreadsheet (CSV).

import { el } from '../ui/ui';
import { textField } from '../ui/textField';
import { trim, UNIT_LABEL, UNIT_MM, units } from '../units';
import { dataTable, fmtArea, fmtMass, fmtVolume, measureBodies } from './bimTool';
import { massOf, materialOf } from './materials';
import type { AppContext } from '../tools/tool';
import type { BodyProps } from '../kernel/protocol';
import type { ProjectInfo } from '../doc/types';

/** One row of the parts list. */
export interface PartRow {
  item: number;
  id: string;
  name: string;
  material: string;
  volume: number;
  area: number;
  /** kg; undefined without a material. */
  mass?: number;
  center: [number, number, number];
  size: [number, number, number];
}

/** The parts list: every body shown, numbered as in the drawings. */
export function partsList(app: AppContext, props: Map<string, BodyProps>): PartRow[] {
  const doc = app.store.doc;

  return app.view.bodyList
    .filter(b => !doc.hidden.includes(b.id) && props.has(b.id))
    .map((b, i) => {
      const bodyProps = props.get(b.id)!;
      const material = materialOf(doc, b.id);

      return {
        item: i + 1,
        id: b.id,
        name: doc.names?.[b.id] ?? b.name,
        material: material?.name ?? '',
        volume: bodyProps.volume,
        area: bodyProps.area,
        mass: material ? massOf(material, bodyProps.volume) : undefined,
        center: bodyProps.center,
        size: [bodyProps.box[1][0] - bodyProps.box[0][0], bodyProps.box[1][1] - bodyProps.box[0][1], bodyProps.box[1][2] - bodyProps.box[0][2]]
      };
    });
}

const len = (mm: number) => trim(mm / UNIT_MM[units()], 2);

let afterPrint: (() => void) | null = null;
/**
 * The print window, with `cls` on the page while it is up (the styles for printing go by it) and `extra` (a style,
 * the sheets to print) in the page that long. Put right when printing is over, not when print() returns: on a phone
 * print() returns at once, before the preview has drawn the page - what it then drew was the page put back already
 * (a blank sheet, or the app itself).
 */
export function printPage(cls: string, ...extra: HTMLElement[]): void {
  afterPrint?.();
  let over = false;
  const tidy = () => {
    if (over) {
      return;
    }
    over = true;
    afterPrint = null;
    removeEventListener('afterprint', tidy);
    removeEventListener('focus', late);
    document.body.classList.remove(cls);
    for (const e of extra) {
      e.remove();
    }
  };
  // (A browser that never says printing is over: tidied when the app is come back to, a moment after.)
  const late = () => setTimeout(() => !matchMedia('print').matches && tidy(), 1500);
  afterPrint = tidy;
  document.body.classList.add(cls);
  addEventListener('afterprint', tidy);
  const t0 = performance.now();
  try {
    window.print();
  } catch {
    tidy();

    return;
  }
  // (print() that waited for the window to close - a computer's browser: over now, whether or not it said so.)
  if (performance.now() - t0 > 400) {
    tidy();
  } else {
    addEventListener('focus', late);
  }
}

export async function openSheet(app: AppContext): Promise<void> {
  document.querySelector('.bim-sheet')?.remove();
  const back = el('div', 'bim-sheet');
  const bar = el('div', 'bim-sheet-bar');
  const close = el('button', 'text-btn', 'Close');
  const print = el('button', 'text-btn', 'Print / PDF');
  const csv = el('button', 'text-btn', 'Parts list (CSV)');
  bar.append(el('span', 'bim-sheet-name', 'Technical Sheet'), print, csv, close);
  const paper = el('div', 'bim-paper');
  paper.append(el('div', 'bim-sub', 'Measuring the bodies…'));
  back.append(bar, paper);
  document.body.append(back);
  const shut = () => {
    back.remove();
    window.removeEventListener('keydown', onKey, true);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      (e.preventDefault(), e.stopPropagation(), shut());
    }
  };
  window.addEventListener('keydown', onKey, true);
  close.addEventListener('click', shut);
  print.addEventListener('click', () => printPage('printing-sheet'));

  let rows: PartRow[] = [];
  try {
    rows = partsList(app, await measureBodies(app));
  } catch (err) {
    paper.innerHTML = '';
    paper.append(el('div', 'bim-sub', `The bodies could not be measured: ${err instanceof Error ? err.message : String(err)}`));

    return;
  }
  csv.addEventListener('click', () => {
    const unit = UNIT_LABEL[units()];
    const q = (quote: string) => `"${quote.replace(/"/g, '""')}"`;
    const factor = UNIT_MM[units()];
    const lines = [
      ['Item', 'Name', 'Material', `Volume (${unit}3)`, `Area (${unit}2)`, 'Mass (kg)', `Centre of mass X (${unit})`, `Y (${unit})`, `Z (${unit})`, `Size X (${unit})`, `Size Y (${unit})`, `Size Z (${unit})`].join(','),
      ...rows.map(row =>
        [row.item, q(row.name), q(row.material), trim(row.volume / factor ** 3, 4), trim(row.area / factor ** 2, 4), row.mass === undefined ? '' : trim(row.mass, 4), ...row.center.map(len), ...row.size.map(len)].join(',')
      )
    ];
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([lines.join('\r\n')], { type: 'text/csv' }));
    a.download = `${app.store.doc.name || 'project'} - parts list.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  });
  paper.innerHTML = '';
  render(app, paper, rows);
}

function render(app: AppContext, paper: HTMLElement, rows: PartRow[]): void {
  const doc = app.store.doc;
  const info: ProjectInfo = doc.info ?? {};

  // ---- Title block
  const head = el('div', 'bim-title-block');
  const field = (label: string, value: string, key?: keyof ProjectInfo) => {
    const field = el('label', 'bim-tb-field');
    field.append(el('span', 'bim-tb-label', label));
    if (!key) {
      field.append(el('span', 'bim-tb-value', value));
    } else {
      const input = textField('bim-tb-value');
      input.value = value;
      input.placeholder = '-';
      input.addEventListener('change', () => app.store.commit(draft => (draft.info = { ...(draft.info ?? {}), [key]: input.value.trim() || undefined })));
      field.append(input);
    }
    head.append(field);
  };
  field('Project', doc.name || 'Untitled');
  field('Document', 'Technical sheet');
  field('Number', info.number ?? '', 'number');
  field('Revision', info.revision ?? '', 'revision');
  field('Author', info.author ?? '', 'author');
  field('Company', info.company ?? '', 'company');
  field('Date', new Date().toISOString().slice(0, 10));
  field('Units', `${UNIT_LABEL[units()]}, kg`);
  paper.append(head);

  // ---- Parts list
  paper.append(el('h2', 'bim-h', '1. Parts list'));
  const missing = rows.filter(row => row.mass === undefined).length;
  if (missing) {
    paper.append(el('div', 'bim-warn', `${missing === 1 ? '1 body has' : `${missing} bodies have`} no material yet: no mass for ${missing === 1 ? 'it' : 'them'}. Give each body a material in BIM - Materials.`));
  }
  const unit = UNIT_LABEL[units()];
  const t = el('table', 'bim-table');
  const hr = el('tr', '');
  for (const heading of ['Item', 'Name', 'Material', 'Volume', 'Surface area', 'Mass', `Centre of mass (${unit})`, `Size X × Y × Z (${unit})`]) {
    hr.append(el('th', '', heading));
  }
  t.append(hr);
  for (const row of rows) {
    const tr = el('tr', '');
    for (const value of [String(row.item), row.name, row.material || '-', fmtVolume(row.volume), fmtArea(row.area), row.mass === undefined ? '-' : fmtMass(row.mass), row.center.map(len).join(', '), row.size.map(len).join(' × ')]) {
      tr.append(el('td', '', value));
    }
    t.append(tr);
  }
  const total = rows.reduce((total, row) => total + (row.mass ?? 0), 0);
  const tf = el('tr', 'bim-total');
  for (const value of ['', `${rows.length} ${rows.length === 1 ? 'part' : 'parts'}`, '', fmtVolume(rows.reduce((total, row) => total + row.volume, 0)), '', `${fmtMass(total)}${missing ? ' +' : ''}`, '', '']) {
    tf.append(el('td', '', value));
  }
  t.append(tf);
  const wrap = el('div', 'bim-table-wrap');
  wrap.append(t);
  paper.append(wrap);

  // ---- Materials used, with their data
  paper.append(el('h2', 'bim-h', '2. Materials'));
  const used = new Map<string, number[]>();
  for (const row of rows) {
    const material = materialOf(doc, row.id);
    if (material) {
      used.set(material.id, [...(used.get(material.id) ?? []), row.item]);
    }
  }
  if (!used.size) {
    paper.append(el('div', 'bim-sub', 'No materials given yet.'));
  }
  const grid = el('div', 'bim-material-grid');
  for (const [, items] of used) {
    const material = materialOf(doc, rows.find(row => row.item === items[0])!.id)!;
    const element = el('div', 'bim-material-card');
    const head = el('div', 'bim-material-head');
    const sw = el('span', 'bim-swatch');
    sw.style.background = material.color;
    head.append(sw, el('b', '', material.name));
    element.append(head, el('div', 'bim-sub', `Items ${items.join(', ')}`), dataTable(material));
    grid.append(element);
  }
  paper.append(grid);
  paper.append(
    el(
      'div',
      'bim-foot',
      "Strengths are the minimums of the standard named, where the grade has one; other values are typical (thermal values of building materials: ISO 10456 design values). A supplier's data sheet comes first where it differs. Masses are worked out from each body's measured volume and its material's density."
    )
  );
}
