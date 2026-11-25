// File → Open: the projects kept on this device, as a gallery of pictures.
// Tap one to open it; New project starts one; Open file… still takes any
// .super file. It also opens by itself when the app starts, with a welcome
// and the ways to support the project.

import { render as mount } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { TwoTapButton } from './components';
import { icons } from './icons';
import { SUPPORT, openSupport } from './support';
import type { LibraryEntry } from '../doc/library';

export interface LibraryActions {
  open(id: string): void;
  /** The tutorial: a first part, built one tap at a time (offered in the window's head). */
  tutorial?(): void;
  newProject(): void;
  openFile(): void;
  download(id: string): void;
  /** Resolves with the new name (null: kept as it was). */
  rename(id: string, name: string): Promise<string | null>;
  /** False when it could not be removed (the card stays). */
  remove(id: string): Promise<boolean>;
}

const DOWNLOAD
  = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11"/><path d="m7 10 5 5 5-5"/><path d="M5 19h14"/></svg>';

/** "Today 14:32", "Yesterday 09:10", "3 Mar", "3 Mar 2025". */
function when(ms: number): string {
  const date = new Date(ms);
  const now = new Date();
  const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((day(now) - day(date)) / 864e5);
  if (days === 0) {
    return `Today ${time}`;
  }
  if (days === 1) {
    return `Yesterday ${time}`;
  }

  return date.toLocaleDateString([], { day: 'numeric', month: 'short', ...(date.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) });
}

/** The ways to support the project, each with room for its logo. */
function SupportBox() {
  return (
    <div class="library-support">
      <div class="library-support-text">
        This app is free, with no ads and no account, and one person makes it. If it's useful to you, a free MakerWorld Boost or a follow is very useful to me. Thank you!
      </div>
      <div class="library-support-row">
        {/* (Only the ways with a link.) */}
        {SUPPORT.filter(way => way.url).map(way => (
          <button key={way.id} type="button" class="library-support-btn" title={`${way.name} - opens in a new tab`} onClick={() => openSupport(way.url)}>
            {way.logo
              ? (
                <span class="library-support-logo has-logo" style={way.tile ? { background: way.tile } : undefined}>
                  <img src={way.logo} alt="" draggable={false} />
                </span>
              )
              : (
                <span class="library-support-logo" dangerouslySetInnerHTML={{ __html: way.mark }} />
              )}
            <span class="library-support-name">
              <b>{way.name}</b>
              <span>{way.sub}</span>
            </span>
            {way.tag && (
              <span class="library-support-tag">
                <span dangerouslySetInnerHTML={{ __html: way.tag.icon }} style={{ display: 'contents' }} />
                {way.tag.text}
              </span>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}

const FULL
  = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"/></svg>';
const UNFULL
  = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4v5H4M20 9h-5V4M15 20v-5h5M4 15h5v5"/></svg>';

export interface LibraryOptions {
  /** The app's opening: a welcome and a few words on it. */
  welcome?: boolean;
  /** A Full screen button (null: not offered). */
  fullscreen?: { isFull(): boolean; toggle(): void } | null;
  /** Told when the window is closed, however it was (its close button, a project picked, Esc). */
  onClose?(): void;
}

/** The page already fills the screen (the browser's own full screen, or an app window that has it all). */
function wholeScreen(): boolean {
  return matchMedia('(display-mode: fullscreen)').matches || (Math.abs(innerWidth - screen.width) < 2 && Math.abs(innerHeight - screen.height) < 2);
}

interface LibraryDialogProps {
  entries: LibraryEntry[];
  currentId: string | null;
  act: LibraryActions;
  opts: LibraryOptions;
  onClose: () => void;
}

function LibraryDialog({ entries, currentId, act, opts, onClose }: LibraryDialogProps) {
  const [items, setItems] = useState(entries);
  const [, repaint] = useState(0);
  const backRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const hasEntries = entries.length > 0;
  const fullscreen = opts.fullscreen;
  const isFull = !!fullscreen?.isFull();

  const closeThen = (next?: () => void) => {
    onClose();
    next?.();
  };

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      // A question asked over it (Delete?) has the keys.
      if (backRef.current?.nextElementSibling?.classList.contains('dialog-back')) {
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
      event.stopPropagation();
    };
    const handleFullChange = () => repaint(count => count + 1);
    window.addEventListener('keydown', handleKey, true);
    document.addEventListener('fullscreenchange', handleFullChange);
    document.addEventListener('webkitfullscreenchange', handleFullChange);
    window.addEventListener('resize', handleFullChange);

    return () => {
      window.removeEventListener('keydown', handleKey, true);
      document.removeEventListener('fullscreenchange', handleFullChange);
      document.removeEventListener('webkitfullscreenchange', handleFullChange);
      window.removeEventListener('resize', handleFullChange);
    };
  }, [onClose]);

  // A mouse wheel turned up and down moves the row side to side.
  useEffect(() => {
    const grid = gridRef.current;
    const handleWheel = (event: WheelEvent) => {
      if (!grid || Math.abs(event.deltaX) >= Math.abs(event.deltaY) || grid.scrollWidth <= grid.clientWidth) {
        return;
      }
      event.preventDefault();
      grid.scrollLeft += event.deltaY;
    };
    grid?.addEventListener('wheel', handleWheel, { passive: false });

    return () => grid?.removeEventListener('wheel', handleWheel);
  }, [items.length]);

  const handleRename = async (entry: LibraryEntry) => {
    const name = await act.rename(entry.id, entry.name);
    if (name) {
      setItems(current => current.map(item => (item.id === entry.id ? { ...item, name } : item)));
    }
  };

  const handleRemove = async (id: string) => {
    if (await act.remove(id)) {
      setItems(current => current.filter(item => item.id !== id));
    }
  };

  return (
    <div class="dialog-back" ref={backRef} onPointerDown={event => event.target === event.currentTarget && onClose()}>
      <div class={opts.welcome ? 'dialog library welcome' : 'dialog library'}>
        <div class="library-head">
          <div class="panel-title">{opts.welcome ? 'Welcome to superGeometry.app' : 'Projects'}</div>
          {fullscreen && (
            // The welcome points it out (it pulses) until the app has the whole screen - from this button, or the browser's own full screen (F11).
            <button
              type="button"
              class={opts.welcome && !isFull && !wholeScreen() ? 'text-btn library-full pulse' : 'text-btn library-full'}
              title={isFull ? 'Exit full screen' : 'Full screen'}
              onClick={() => fullscreen.toggle()}
            >
              <span style={{ display: 'contents' }} dangerouslySetInnerHTML={{ __html: isFull ? UNFULL : FULL }} />
              {/* (Phones show the icon alone.) */}
              <span class="library-full-text">{isFull ? 'Exit full screen' : 'Full screen'}</span>
            </button>
          )}
          {/* The tutorial: where someone new starts. */}
          {act.tutorial && (
            <button type="button" class="text-btn" title="Build a bolt and its nut, one tap at a time" onClick={() => closeThen(act.tutorial)}>
              Tutorial
            </button>
          )}
          {/* No projects yet: New project is the way in. */}
          <button type="button" class={hasEntries ? 'text-btn' : 'text-btn primary'} title="Start an empty project (the open one stays here)" onClick={() => closeThen(act.newProject)}>
            New project
          </button>
          <button type="button" class={hasEntries ? 'text-btn primary' : 'text-btn'} title="Open a .super file from this device or elsewhere" onClick={() => closeThen(act.openFile)}>
            Open file…
          </button>
          <button type="button" class="icon-btn library-close" title="Close" onClick={onClose} dangerouslySetInnerHTML={{ __html: icons.close }} />
        </div>
        {opts.welcome && (
          <>
            <div class="library-welcome">
              A free parametric, history-based 3D CAD app for every device: sketch an idea, turn it into a solid part and take it wherever it's going next. Everything stays on this device only.
            </div>
            {hasEntries && <div class="library-section">Your projects</div>}
          </>
        )}
        <div class={items.length ? 'library-grid' : 'library-grid empty'} ref={gridRef} data-own-bar="">
          {items.length === 0 && <div class="library-empty">No projects here yet. The one you're working on is kept here as soon as it has something in it.</div>}
          {items.map((entry) => {
            const isOpen = entry.id === currentId;
            const openTitle = isOpen ? 'Open now' : `Open “${entry.name}”`;

            return (
              <div key={entry.id} class={isOpen ? 'library-card current' : 'library-card'}>
                <button
                  type="button"
                  class="library-pic"
                  title={openTitle}
                  onClick={() => closeThen(() => !isOpen && act.open(entry.id))}
                >
                  {entry.thumb ? <img src={entry.thumb} alt="" draggable={false} /> : <span style={{ display: 'contents' }} dangerouslySetInnerHTML={{ __html: icons.body }} />}
                  {isOpen && <span class="library-badge">Open now</span>}
                </button>
                <div class="library-info">
                  <div class="library-text">
                    <div class="library-name" title={entry.name}>{entry.name}</div>
                    <div class="library-date">{when(entry.modified)}</div>
                  </div>
                  <button type="button" class="icon-btn" title="Rename" onClick={() => handleRename(entry)} dangerouslySetInnerHTML={{ __html: icons.rename }} />
                  <button type="button" class="icon-btn" title="Save as a .super file" onClick={() => act.download(entry.id)} dangerouslySetInnerHTML={{ __html: DOWNLOAD }} />
                  {!isOpen && (
                    <TwoTapButton armKey={`library:${entry.id}`} class="icon-btn danger" title="Delete from this device" html={icons.trash} onConfirm={() => handleRemove(entry.id)} />
                  )}
                </div>
              </div>
            );
          })}
        </div>
        <SupportBox />
        <div class="dialog-note library-note">Clearing this site's data in the browser's settings deletes your projects - save the ones that matter as files too.</div>
      </div>
    </div>
  );
}

export function showLibrary(entries: LibraryEntry[], currentId: string | null, act: LibraryActions, opts: LibraryOptions = {}): void {
  const host = document.createElement('div');
  let isClosed = false;
  const close = () => {
    if (isClosed) {
      return;
    }
    isClosed = true;
    opts.onClose?.();
    mount(null, host);
    host.remove();
  };
  document.body.append(host);
  mount(<LibraryDialog entries={entries} currentId={currentId} act={act} opts={opts} onClose={close} />, host);
}
