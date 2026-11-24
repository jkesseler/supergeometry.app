// More → Feedback: a bug report, a suggestion or a discussion, posted on the
// app's subreddit. The app has no server and no account, so it can't post by
// itself: it opens Reddit's own "new post" page in a new tab with the title
// and the text filled in, and the person posts it there (signed in to Reddit).
// Nothing from the project goes along - only what's typed here and, if left
// on, a short line with the app version and the browser.

import { render as mount } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { TextButton, TextField } from './components';
import { icons } from './icons';
import { openSupport } from './support';
import type { TextField as TextFieldElement } from './textField';

export const SUBREDDIT = 'supergeometry';

type Kind = 'bug' | 'idea' | 'talk';
const KINDS: { id: Kind; label: string; tag: string; title: string; text: string }[] = [
  { id: 'bug', label: 'Bug report', tag: 'Bug', title: 'What went wrong, in a few words', text: 'What you did, what you expected, and what happened instead.' },
  { id: 'idea', label: 'Suggestion', tag: 'Suggestion', title: "What you'd like, in a few words", text: 'What it would do and where it would help.' },
  { id: 'talk', label: 'Discussion', tag: 'Discussion', title: 'The topic', text: "Anything you'd like to talk about." }
];

/** A browser address has a length limit: the text stops well short of it. */
const MAX_TEXT = 4000;

/** "Chrome 131, Android, phone": short, nothing that tells who it is. */
export function deviceLine(): string {
  const ua = navigator.userAgent;
  const browser
    = ua.match(/(Edg|OPR|SamsungBrowser|Firefox|FxiOS|CriOS|Chrome)\/(\d+)/)?.slice(1).join(' ').replace(/^Edg\b/, 'Edge').replace(/^OPR\b/, 'Opera').replace(/^CriOS\b/, 'Chrome').replace(/^FxiOS\b/, 'Firefox').replace(/^SamsungBrowser\b/, 'Samsung Internet')
    ?? (/Safari\//.test(ua) ? `Safari ${ua.match(/Version\/(\d+)/)?.[1] ?? ''}`.trim() : 'Browser');
  const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) ? 'iOS' : /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'macOS' : /CrOS/.test(ua) ? 'ChromeOS' : /Linux/.test(ua) ? 'Linux' : '';
  const touch = matchMedia('(pointer: coarse)').matches;
  const kind = touch ? (Math.min(screen.width, screen.height) < 600 ? 'phone' : 'tablet') : '';

  return [browser, os, kind].filter(Boolean).join(', ');
}

export function infoLine(): string {
  return `superGeometry.app ${__APP_VERSION__} · ${deviceLine()}`;
}

/** Reddit's "new text post" page for the subreddit, filled in. */
export function submitUrl(title: string, text: string): string {
  // %20 for spaces, not "+": every reader of the address takes it as a space.
  const q = Object.entries({ title, text, selftext: 'true', type: 'TEXT' }).map(([key, value]) => `${key}=${encodeURIComponent(value)}`);

  return `https://www.reddit.com/r/${SUBREDDIT}/submit?${q.join('&')}`;
}

interface FeedbackDialogProps {
  onClose: () => void;
}

function FeedbackDialog({ onClose }: FeedbackDialogProps) {
  const [kind, setKind] = useState<Kind>('bug');
  const [title, setTitle] = useState('');
  const [isInfoOn, setIsInfoOn] = useState(true);
  const titleFieldRef = useRef<TextFieldElement | undefined>(undefined);
  const textFieldRef = useRef<TextFieldElement | undefined>(undefined);
  const kindOption = KINDS.find(option => option.id === kind)!;

  const send = () => {
    const trimmedTitle = title.trim();
    if (!trimmedTitle) {
      titleFieldRef.current?.focus();

      return;
    }
    let body = (textFieldRef.current?.value ?? '').trim().slice(0, MAX_TEXT);
    if (isInfoOn) {
      body += `${body ? '\n\n' : ''}---\n${infoLine()}`;
    }
    openSupport(submitUrl(`[${kindOption.tag}] ${trimmedTitle}`, body));
    onClose();
  };
  const sendRef = useRef(send);
  sendRef.current = send;

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      } else if (event.key === 'Enter' && event.target === titleFieldRef.current) {
        // Enter in the title sends; in the description it's a new line.
        event.preventDefault();
        sendRef.current();
      }
      event.stopPropagation();
    };
    window.addEventListener('keydown', handleKey, true);

    return () => window.removeEventListener('keydown', handleKey, true);
  }, [onClose]);

  const handlePick = (id: Kind) => {
    setKind(id);
    // Version and browser help most with a bug: on for it, off for the others (it can still be ticked).
    setIsInfoOn(id === 'bug');
  };

  const handleTitleReady = (field: TextFieldElement) => {
    titleFieldRef.current = field;
    // Not on a touch screen: its keyboard would cover the window before it's read.
    if (matchMedia('(pointer: fine)').matches) {
      field.focus();
    }
  };

  return (
    <div class="dialog-back" onPointerDown={event => event.target === event.currentTarget && onClose()}>
      <form
        class="dialog feedback"
        onSubmit={(event) => {
          event.preventDefault();
          send();
        }}
      >
        <div class="library-head">
          <div class="panel-title">Feedback</div>
          <button type="button" class="icon-btn library-close" title="Close" onClick={onClose} dangerouslySetInnerHTML={{ __html: icons.close }} />
        </div>
        <div class="dialog-list">
          <div class="dialog-note">
            Report a bug, suggest something or start a discussion on r/{SUBREDDIT}. Reddit opens in a new tab with this filled in: sign in there and press Post.
          </div>
          <div class="chip-list feedback-kinds" role="radiogroup">
            {KINDS.map(option => (
              <button
                key={option.id}
                type="button"
                role="radio"
                aria-checked={option.id === kind}
                class={option.id === kind ? 'chip on' : 'chip'}
                onClick={() => handlePick(option.id)}
              >
                {option.label}
              </button>
            ))}
          </div>
          <label class="dialog-field">
            <span class="field-label">Title</span>
            <TextField placeholder={kindOption.title} maxLength={280} onInput={setTitle} onReady={handleTitleReady} />
          </label>
          <label class="dialog-field">
            <span class="field-label">Description</span>
            <TextField isMultiline placeholder={kindOption.text} maxLength={MAX_TEXT} onReady={field => (textFieldRef.current = field)} />
          </label>
          <label class="feedback-info">
            <input type="checkbox" checked={isInfoOn} onChange={event => setIsInfoOn(event.currentTarget.checked)} />
            <span>
              Add the app version and browser: <code>{infoLine()}</code>
            </span>
          </label>
        </div>
        <div class="panel-buttons">
          <TextButton label="Cancel" keyHint="Esc" onClick={onClose} />
          <button type="button" class="text-btn primary" disabled={!title.trim()} onClick={send}>
            Open Reddit
            <span class="feedback-out" aria-hidden="true">↗</span>
          </button>
        </div>
      </form>
    </div>
  );
}

export function showFeedback(): void {
  const host = document.createElement('div');
  const close = () => {
    mount(null, host);
    host.remove();
  };
  document.body.append(host);
  mount(<FeedbackDialog onClose={close} />, host);
}
