import { useEffect, useRef, useState } from 'preact/hooks';
import { DIALOG_ACTION } from './dialogAction';
import { TextButton, TextField, Modal, openOverlay } from './components';
import { icons, type IconName } from './icons';
import type { MenuRow } from './ui';

export interface DialogField {
  key: string;
  label: string;
  value: string;
  placeholder?: string;
  /** A tick box: value "1" ticked, "" not. */
  check?: boolean;
}

interface FormDialogProps {
  title: string;
  fields: DialogField[];
  note?: string;
  action?: { label: string; icon: IconName };
  onDone: (values: Record<string, string> | null) => void;
}

function FormDialog({ title, fields, note, action, onDone }: FormDialogProps) {
  const [values, setValues] = useState(() => Object.fromEntries(fields.map(field => [field.key, field.check ? (field.value ? '1' : '') : field.value])));
  const firstTextRef = useRef<HTMLElement | null>(null);
  const okRef = useRef<HTMLButtonElement>(null);
  const firstTextKey = fields.find(field => !field.check)?.key;
  const setValue = (key: string, value: string) => setValues(current => ({ ...current, [key]: value }));
  useEffect(() => {
    (firstTextRef.current ?? okRef.current)?.focus();
  }, []);

  return (
    <Modal title={title} className="form-dialog" onClose={() => onDone(null)}>
      <form
        style={{ display: 'contents' }}
        onSubmit={(event) => {
          event.preventDefault();
          onDone(values);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            onDone(null);
          }
          if (event.key === 'Enter') {
            event.preventDefault();
            onDone(values);
          }
          event.stopPropagation();
        }}
      >
        {action && (
          <button type="button" class="text-btn dialog-action" onClick={() => onDone({ ...values, [DIALOG_ACTION]: '1' })}>
            <span style={{ display: 'contents' }} dangerouslySetInnerHTML={{ __html: icons[action.icon] }} />
            {action.label}
          </button>
        )}
        {note && <div class="dialog-note">{note}</div>}
        <div class="dialog-list">
          {fields.map(field =>
            field.check
              ? (
                <label class="dialog-check" key={field.key}>
                  <input type="checkbox" checked={!!values[field.key]} onChange={event => setValue(field.key, (event.target as HTMLInputElement).checked ? '1' : '')} />
                  <span>{field.label}</span>
                </label>
              )
              : (
                <label class="dialog-field" key={field.key}>
                  <span class="field-label">{field.label}</span>
                  <TextField
                    value={field.value}
                    placeholder={field.placeholder}
                    onInput={value => setValue(field.key, value)}
                    onReady={(element) => {
                      if (field.key === firstTextKey) {
                        firstTextRef.current = element;
                      }
                    }}
                  />
                </label>
              ))}
        </div>
        <div class="panel-buttons">
          <TextButton label="Cancel" keyHint="Esc" onClick={() => onDone(null)} />
          <button ref={okRef} type="button" class="text-btn primary" onClick={() => onDone(values)}>
            OK
            {matchMedia('(pointer: fine)').matches && <kbd>Enter</kbd>}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** A window of fields; resolves with their values, or null (Cancel / Esc / X). */
export function formDialog(title: string, fields: DialogField[], note?: string, action?: { label: string; icon: IconName }): Promise<Record<string, string> | null> {
  return new Promise((resolve) => {
    const close = openOverlay(() => (
      <FormDialog
        title={title}
        fields={fields}
        note={note}
        action={action}
        onDone={(values) => {
          close();
          resolve(values);
        }}
      />
    ));
  });
}

export interface Choice {
  id: string;
  label: string;
  primary?: boolean;
  /** Runs inside the tap itself (for things a browser only allows on a tap, like sharing). */
  run?: () => void;
}

function ChoiceDialog({ title, note, choices, onDone }: { title: string; note: string; choices: Choice[]; onDone: (id: string | null) => void }) {
  const primary = choices.find(choice => choice.primary);
  const primaryRef = useRef<HTMLButtonElement>(null);
  useEffect(() => primaryRef.current?.focus(), []);
  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Enter' && primary) {
        event.preventDefault();
        primaryRef.current?.click();
      }
    };
    window.addEventListener('keydown', handleKey, true);

    return () => window.removeEventListener('keydown', handleKey, true);
  }, [primary]);
  const pick = (choice: Choice) => {
    choice.run?.();
    onDone(choice.id);
  };

  return (
    <Modal title={title} className="" onClose={() => onDone(null)} isKeyTrap>
      {note && <div class="dialog-note">{note}</div>}
      <div class="panel-buttons">
        <TextButton label="Cancel" keyHint="Esc" onClick={() => onDone(null)} />
        {choices.map(choice =>
          choice.primary
            ? (
              <button key={choice.id} ref={primaryRef} type="button" class="text-btn primary" onClick={() => pick(choice)}>
                {choice.label}
                {matchMedia('(pointer: fine)').matches && <kbd>Enter</kbd>}
              </button>
            )
            : <TextButton key={choice.id} label={choice.label} onClick={() => pick(choice)} />)}
      </div>
    </Modal>
  );
}

/** A question with a few answers (buttons); resolves with the chosen id, or null (Esc / Cancel). */
export function askDialog(title: string, note: string, choices: Choice[]): Promise<string | null> {
  return new Promise((resolve) => {
    const close = openOverlay(() => (
      <ChoiceDialog
        title={title}
        note={note}
        choices={choices}
        onDone={(id) => {
          close();
          resolve(id);
        }}
      />
    ));
  });
}

function ContextMenu({ x, y, rows, onClose }: { x: number; y: number; rows: (MenuRow | '-')[]; onClose: () => void }) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState({ left: x, top: y });
  useEffect(() => {
    const menu = menuRef.current!;
    setPlace({ left: Math.max(8, Math.min(x, innerWidth - menu.offsetWidth - 8)), top: Math.max(8, Math.min(y, innerHeight - menu.offsetHeight - 8)) });
    menu.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true });
    const away = (event: Event) => {
      if (event.type === 'keydown' && (event as KeyboardEvent).key !== 'Escape') {
        return;
      }
      if (event.type === 'pointerdown' && menu.contains(event.target as Node)) {
        return;
      }
      if (event.type === 'keydown') {
        event.stopPropagation();
      }
      onClose();
    };
    // Next tick: the right-click that opened it doesn't close it.
    const timer = setTimeout(() => {
      for (const type of ['pointerdown', 'keydown', 'wheel']) {
        addEventListener(type, away, true);
      }
    });

    return () => {
      clearTimeout(timer);
      for (const type of ['pointerdown', 'keydown', 'wheel']) {
        removeEventListener(type, away, true);
      }
    };
  }, []);

  return (
    <div class="ctx-menu" id="ctx-menu" role="menu" ref={menuRef} style={{ left: `${place.left}px`, top: `${place.top}px` }}>
      {rows.map((row, index) =>
        row === '-'
          ? <div class="ctx-sep" key={index} />
          : (
            <button
              key={index}
              class="ctx-row"
              role={row.checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
              aria-checked={row.checked}
              disabled={!!row.disabled}
              onClick={(event) => {
                event.stopPropagation();
                onClose();
                row.run();
              }}
            >
              <span class="ctx-tick">{row.checked ? '✓' : ''}</span>
              <span class="ctx-label">{row.label}</span>
              <span class="ctx-key">{row.shortcut ?? ''}</span>
            </button>
          ))}
    </div>
  );
}

/** A menu at (x, y) in page pixels, kept on screen; closes on a pick, Esc, or a press elsewhere. Returns its closer. */
export function showContextMenu(x: number, y: number, rows: (MenuRow | '-')[]): () => void {
  const close = openOverlay(() => <ContextMenu x={x} y={y} rows={rows} onClose={() => close()} />);

  return close;
}

