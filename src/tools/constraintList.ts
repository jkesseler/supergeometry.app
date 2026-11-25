// The constraints of what is picked in a sketch, as a list: each named, with what it ties the pick to, a size that
// can be typed over, and a bin of its own - and one button that takes them all off.
//
// Suggested by a user: 'The "delete constraints" button could be a "constraints" button that: show the list of the
// constraints of the selected object; allow to modify or delete some or all of them'. Before, the card of a pick
// had the constraints that could be added or taken off as chips, and one button that removed every constraint on
// it at once - to take off one dimension, its small mark had to be found and tapped on the drawing.

import { icons } from '../ui/icons';
import { numpadInput } from '../ui/numpad';
import { el } from '../ui/ui';

export interface ConstraintRow {
  id: string;
  glyph: string;
  /** "Horizontal", "Length", "Coincident". */
  name: string;
  /** What else it involves: "with a circle", "locked". */
  note: string;
  /** A size that can be typed: as shown, and its unit. */
  value?: { text: string; unit: string };
}

export interface ConstraintListHost {
  title: string;
  rows(): ConstraintRow[];
  /** A size typed for one: true if it was taken. */
  setValue(id: string, text: string): boolean;
  remove(id: string): void;
  removeAll(): void;
  /** One pointed at in the list (null: none): lit on the drawing. */
  point(id: string | null): void;
}

/** The list, open until closed (or until nothing is left in it). */
export function showConstraintList(host: ConstraintListHost): void {
  const back = el('div', 'dialog-back');
  const box = el('div', 'dialog constraint-list');
  const head = el('div', 'library-head');
  const title = el('div', 'panel-title', host.title);
  const closeBtn = el('button', 'icon-btn library-close');
  closeBtn.type = 'button';
  closeBtn.title = 'Close';
  closeBtn.innerHTML = icons.close;
  head.append(title, closeBtn);
  const list = el('div', 'constraint-rows');
  const all = el('button', 'text-btn danger');
  all.type = 'button';
  box.append(head, list, all);
  back.append(box);

  const close = () => {
    host.point(null);
    back.remove();
    window.removeEventListener('keydown', onKey, true);
  };
  const onKey = (e: KeyboardEvent) => {
    // (Keys typed into one of its sizes are that box's own: Enter takes the size, Esc puts the old one back.)
    if (e.target instanceof HTMLInputElement && box.contains(e.target)) {
      return;
    }
    if (e.key === 'Escape') {
      (e.preventDefault(), close());
    }
    e.stopPropagation();
  };
  const draw = () => {
    const rows = host.rows();
    if (!rows.length) {
      return close();
    }
    title.textContent = `${host.title} (${rows.length})`;
    all.textContent = rows.length > 1 ? `Delete all ${rows.length}` : 'Delete it';
    list.replaceChildren(
      ...rows.map((r) => {
        const row = el('div', 'constraint-row');
        const text = el('div', 'constraint-what');
        text.append(el('b', '', r.name), el('span', '', r.note));
        row.append(el('span', 'constraint-glyph', r.glyph), text);
        if (r.value) {
          const field = el('label', 'constraint-value');
          const input = document.createElement('input');
          input.inputMode = 'decimal';
          input.spellcheck = false;
          input.value = r.value.text;
          input.title = 'Type a size (or a formula with variables), then Enter';
          numpadInput(input);
          const take = () => {
            if (input.value.trim() === r.value!.text) {
              return;
            }
            if (host.setValue(r.id, input.value)) {
              draw();
            } else {
              input.classList.add('invalid');
            }
          };
          input.addEventListener('input', () => input.classList.remove('invalid'));
          input.addEventListener('keydown', (e) => {
            e.stopPropagation();
            if (e.key === 'Enter') {
              (e.preventDefault(), take());
            }
            if (e.key === 'Escape') {
              ((input.value = r.value!.text), input.blur());
            }
          });
          input.addEventListener('change', take);
          field.append(input, el('span', '', r.value.unit));
          row.append(field);
        }
        const bin = el('button', 'icon-btn');
        bin.type = 'button';
        bin.title = `Delete this ${r.name.toLowerCase()}`;
        bin.innerHTML = icons.trash;
        bin.addEventListener('click', () => (host.remove(r.id), draw()));
        row.append(bin);
        row.addEventListener('pointerenter', () => host.point(r.id));
        row.addEventListener('pointerleave', () => host.point(null));

        return row;
      })
    );
  };
  all.addEventListener('click', () => (host.removeAll(), close()));
  closeBtn.addEventListener('click', close);
  back.addEventListener('pointerdown', ev => ev.target === back && close());
  window.addEventListener('keydown', onKey, true);
  document.body.append(back);
  draw();
}
