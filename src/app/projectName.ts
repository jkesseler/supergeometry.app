// The project name in the top bar: click to rename, with the saved mark.

import type { App } from '../app';

/** The page's own title, from index.html (it names the app for search results). */
const PAGE_TITLE = document.title;

export function wireProjectName(app: App): void {
  // Project name: click and type; Enter or leaving the field renames.
  // (Editable text, not an input: a phone's browser hung its autofill bar -
  // passwords, cards, addresses - over the screen for an input.)
  const name = document.getElementById('project-name') as HTMLElement;
  name.contentEditable = 'plaintext-only';
  if (name.contentEditable !== 'plaintext-only') {
    name.contentEditable = 'true';
  }
  const typed = () => (name.textContent ?? '').replace(/\s+/g, ' ').trim();
  const show = () => {
    if (document.activeElement !== name) {
      name.textContent = app.store.doc.name;
    }
    // A new, unnamed project keeps the page's own title (what search results show).
    document.title = app.store.doc.name === 'Untitled' ? PAGE_TITLE : `${app.store.doc.name} – superGeometry.app`;
  };
  const rename = () => {
    const value = typed();
    if (value && value !== app.store.doc.name) {
      app.store.commit(draft => (draft.name = value));
    }
    name.textContent = app.store.doc.name;
    name.scrollLeft = 0;
  };
  name.addEventListener('blur', rename);
  // On a small screen, while it is being renamed, it opens over the buttons
  // beside it (File, Items, History, More) to the bar's end; they stay where
  // they are under it, kept in place by a spot of its old width.
  const spot = document.createElement('span');
  spot.className = 'project-name-spot';
  name.addEventListener('focus', () => {
    if (!matchMedia('(max-width: 720px), (pointer: coarse)').matches) {
      return;
    }
    const bar = name.parentElement!;
    spot.style.width = `${name.offsetWidth}px`;
    spot.style.marginRight = getComputedStyle(name).marginRight;
    const left = name.offsetLeft;
    name.before(spot);
    name.classList.add('wide');
    name.style.left = `${left}px`;
    name.style.width = `${bar.clientWidth - left - 4}px`;
  });
  name.addEventListener('blur', () => {
    if (!name.classList.contains('wide')) {
      return;
    }
    name.classList.remove('wide');
    name.style.left = name.style.width = '';
    spot.remove();
  });
  name.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault(), name.blur();
    }
    if (e.key === 'Escape') {
      (name.textContent = app.store.doc.name), name.blur();
    }
  });
  // Pasted: as plain text on one line.
  name.addEventListener('paste', (e) => {
    e.preventDefault();
    document.execCommand('insertText', false, (e.clipboardData?.getData('text/plain') ?? '').replace(/\s+/g, ' '));
  });
  // A mouse selects the whole name to type over; a finger gets the caret
  // where it tapped (selecting all brought up the phone's Cut / Copy bar).
  name.addEventListener('focus', () => {
    if (!matchMedia('(pointer: fine)').matches) {
      return;
    }
    requestAnimationFrame(() => {
      if (document.activeElement !== name) {
        return;
      }
      const range = document.createRange();
      range.selectNodeContents(name);
      getSelection()?.removeAllRanges();
      getSelection()?.addRange(range);
    });
  });
  app.store.onChange(show);
  show();
  // The saved mark at the end of the name: a tick once every change is on this device.
  const mark = () => {
    const saved = app.store.saved;
    name.classList.toggle('saving', !saved);
    name.title = `Project name - click to rename\n${saved ? 'Saved on this device' : 'Saving…'}`;
  };
  app.store.onSavedState(mark);
  mark();
}
