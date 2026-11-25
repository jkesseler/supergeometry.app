// The constraints of what is picked in a sketch, as a list: each named, with what it ties the pick to, a size that
// can be typed over, and a bin of its own - and one button that takes them all off.
//
// Suggested by a user: 'The "delete constraints" button could be a "constraints" button that: show the list of the
// constraints of the selected object; allow to modify or delete some or all of them'. Before, the card of a pick
// had the constraints that could be added or taken off as chips, and one button that removed every constraint on
// it at once - to take off one dimension, its small mark had to be found and tapped on the drawing.

import { useEffect, useRef, useState } from 'preact/hooks';
import { Modal, openOverlay } from '../ui/components';
import { icons } from '../ui/icons';
import { numpadInput } from '../ui/numpad';

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

function SizeBox({ row, onTaken }: { row: ConstraintRow; onTaken: (text: string) => boolean }) {
  const value = row.value!;
  const [isInvalid, setIsInvalid] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    numpadInput(inputRef.current!);
  }, []);
  const take = () => {
    const input = inputRef.current!;
    if (input.value.trim() !== value.text) {
      setIsInvalid(!onTaken(input.value));
    }
  };

  return (
    <label class="constraint-value">
      <input
        ref={inputRef}
        class={isInvalid ? 'invalid' : ''}
        inputMode="decimal"
        spellcheck={false}
        value={value.text}
        title="Type a size (or a formula with variables), then Enter"
        onInput={() => setIsInvalid(false)}
        onChange={take}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === 'Enter') {
            event.preventDefault();
            take();
          }
          if (event.key === 'Escape') {
            inputRef.current!.value = value.text;
            inputRef.current!.blur();
          }
        }}
      />
      <span>{value.unit}</span>
    </label>
  );
}

function ConstraintList({ host, onClose }: { host: ConstraintListHost; onClose: () => void }) {
  const [, redraw] = useState(0);
  const rows = host.rows();
  const isEmpty = !rows.length;
  useEffect(() => {
    if (isEmpty) {
      onClose();
    }
  }, [isEmpty]);
  useEffect(() => () => host.point(null), []);
  if (isEmpty) {
    return null;
  }

  return (
    <Modal title={`${host.title} (${rows.length})`} className="constraint-list" onClose={onClose} isKeyTrap>
      <div class="constraint-rows">
        {rows.map(row => (
          <div class="constraint-row" key={row.id} onPointerEnter={() => host.point(row.id)} onPointerLeave={() => host.point(null)}>
            <span class="constraint-glyph">{row.glyph}</span>
            <div class="constraint-what">
              <b>{row.name}</b>
              <span>{row.note}</span>
            </div>
            {row.value && (
              <SizeBox
                row={row}
                onTaken={(text) => {
                  const isTaken = host.setValue(row.id, text);
                  if (isTaken) {
                    redraw(count => count + 1);
                  }

                  return isTaken;
                }}
              />
            )}
            <button
              type="button"
              class="icon-btn"
              title={`Delete this ${row.name.toLowerCase()}`}
              onClick={() => {
                host.remove(row.id);
                redraw(count => count + 1);
              }}
            >
              <span style={{ display: 'contents' }} dangerouslySetInnerHTML={{ __html: icons.trash }} />
            </button>
          </div>
        ))}
      </div>
      <button
        type="button"
        class="text-btn danger"
        onClick={() => {
          host.removeAll();
          onClose();
        }}
      >
        {rows.length > 1 ? `Delete all ${rows.length}` : 'Delete it'}
      </button>
    </Modal>
  );
}

/** The list, open until closed (or until nothing is left in it). */
export function showConstraintList(host: ConstraintListHost): void {
  openOverlay(close => <ConstraintList host={host} onClose={close} />);
}
