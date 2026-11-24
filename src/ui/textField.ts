// Typing boxes that aren't form fields. A phone's browser hangs its autofill
// bar (passwords, cards, addresses) over the screen for every input it sees,
// whatever autocomplete says; editable text gets none. And a finger never gets
// the whole text selected for it: that brought up the phone's Cut / Copy bar.

/** A mouse (or a trackpad) points: selecting all to type over is fine there. */
const fine = () => matchMedia('(pointer: fine)').matches;

/** A typing box made by `textField`: it reads and writes like an input. */
export interface TextField extends HTMLElement {
  value: string;
  placeholder: string;
  /** At most this many characters (0: any). */
  maxLength: number;
  select(): void;
}

/**
 * The whole text, ready to be typed over - with a mouse; a finger gets the
 * caret at the end instead.
 */
export function selectAll(box: HTMLElement): void {
  if (box instanceof HTMLInputElement || box instanceof HTMLTextAreaElement) {
    if (fine()) {
      return box.select();
    }
    const count = box.value.length;
    try {
      box.setSelectionRange(count, count);
    } catch {
      // (not a text box)
    }

    return;
  }
  const range = document.createRange();
  range.selectNodeContents(box);
  if (!fine()) {
    range.collapse(false);
  }
  const selection = getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

/** The caret at the end of a box's text. */
export function caretToEnd(box: HTMLElement): void {
  if (box instanceof HTMLInputElement || box instanceof HTMLTextAreaElement) {
    const count = box.value.length;

    return box.setSelectionRange(count, count);
  }
  const range = document.createRange();
  range.selectNodeContents(box);
  range.collapse(false);
  const selection = getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

/** The caret sits at the end of the box's text (nothing selected). */
export function caretAtEnd(box: HTMLElement): boolean {
  if (box instanceof HTMLInputElement || box instanceof HTMLTextAreaElement) {
    return box.selectionStart === box.value.length && box.selectionEnd === box.value.length;
  }
  const selection = getSelection();
  if (!selection || !selection.rangeCount || !selection.isCollapsed || !box.contains(selection.anchorNode)) {
    return false;
  }
  const range = document.createRange();
  range.selectNodeContents(box);
  range.setStart(selection.anchorNode!, selection.anchorOffset);

  return range.toString() === '';
}

/**
 * A one-line typing box (or several lines: `multiline`). It has an input's
 * value, placeholder, maxLength and select(); "input" fires as it's typed and
 * "change" when it's left changed, as an input's do. Enter stays out of a
 * one-line box (its own keydown handlers still see it), and a paste comes in
 * as plain text.
 */
export function textField(className = '', opts: { multiline?: boolean } = {}): TextField {
  const multi = !!opts.multiline;
  const element = document.createElement(multi ? 'div' : 'span') as unknown as TextField;
  element.className = `text-field${multi ? ' multiline' : ''}${className ? ` ${className}` : ''}`;
  element.contentEditable = 'plaintext-only';
  if (element.contentEditable !== 'plaintext-only') {
    element.contentEditable = 'true';
  }
  element.setAttribute('role', 'textbox');
  if (multi) {
    element.setAttribute('aria-multiline', 'true');
  }
  element.tabIndex = 0;
  element.spellcheck = false;
  let max = 0;
  const read = () => {
    const t = multi ? element.innerText : (element.textContent ?? '');

    return multi ? t.replace(/\n$/, '') : t.replace(/\s*\n\s*/g, ' ');
  };
  Object.defineProperties(element, {
    value: {
      get: read,
      set: (value: string) => {
        element.textContent = String(value ?? '');
      }
    },
    placeholder: {
      get: () => element.dataset.placeholder ?? '',
      set: (placeholder: string) => {
        if (placeholder) {
          element.dataset.placeholder = placeholder;
        } else {
          delete element.dataset.placeholder;
        }
      }
    },
    maxLength: {
      get: () => max,
      set: (value: number) => {
        max = Math.max(0, value | 0);
      }
    },
    select: { value: () => selectAll(element) }
  });
  element.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !multi) {
      e.preventDefault();
    }
  });
  element.addEventListener('paste', (e) => {
    e.preventDefault();
    let t = e.clipboardData?.getData('text/plain') ?? '';
    if (!multi) {
      t = t.replace(/\s+/g, ' ');
    }
    document.execCommand('insertText', false, t);
  });
  element.addEventListener('input', () => {
    // Emptied: no stray line break left (the placeholder shows again).
    if (!read() && element.childNodes.length) {
      element.textContent = '';
    }
    if (max && read().length > max) {
      element.textContent = read().slice(0, max);
      caretToEnd(element);
    }
  });
  // "change" on leaving it changed, as an input does.
  let before = '';
  element.addEventListener('focus', () => (before = read()));
  element.addEventListener('blur', () => {
    if (read() !== before) {
      element.dispatchEvent(new Event('change', { bubbles: true }));
    }
  });

  return element;
}
