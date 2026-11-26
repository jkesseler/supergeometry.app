// More → About: the README (the one on GitHub), shown in the app. Built into
// the app (it's the same file), less the lines that only make sense on GitHub.

import DOMPurify from 'dompurify';
import { Marked, Renderer } from 'marked';
import { useRef } from 'preact/hooks';
import readme from '../../README.md?raw';
import { Modal, openOverlay } from './components';

const REPO = 'https://github.com/superGeometry/supergeometry.app';

/** Not shown: the link to open the app (you're in it) and the developer docs. */
function aboutText(): string {
  return readme
    .split(/\r?\n/)
    .filter(line => !/^👉\s*\*\*Open it/.test(line) && !/docs\/(ARCHITECTURE|FEATURES)\.md/.test(line))
    .join('\n');
}

const esc = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Heading text → the id GitHub gives it (for the Contents links). */
const slug = (text: string) =>
  text
    .toLowerCase()
    .replace(/<[^>]+>/g, '')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s/g, '-');

const readmeMarkdown = new Marked({
  renderer: {
    heading({ tokens, depth, text }) {
      return `<h${depth} id="${slug(text)}">${this.parser.parseInline(tokens)}</h${depth}>\n`;
    },
    link({ href, tokens }) {
      const text = this.parser.parseInline(tokens);
      if (href.startsWith('#')) {
        return `<a href="${esc(href)}" data-anchor="${esc(href.slice(1))}">${text}</a>`;
      }
      const url = /^https?:/.test(href) ? href : `${REPO}/blob/main/${href}`;

      return `<a href="${esc(url)}" target="_blank" rel="noopener">${text}</a>`;
    },
    table(token) {
      return `<div class="about-table">${Renderer.prototype.table.call(this, token)}</div>`;
    }
  }
});

interface AboutDialogProps {
  onClose: () => void;
}

function aboutHtml(): string {
  const html = readmeMarkdown.parse(aboutText(), { async: false });

  // DOMPurify drops `target` unless told to keep it.
  return DOMPurify.sanitize(html, { ADD_ATTR: ['target'] });
}

function AboutDialog({ onClose }: AboutDialogProps) {
  const bodyRef = useRef<HTMLDivElement>(null);

  const handleBodyClick = (event: MouseEvent) => {
    const link = (event.target as HTMLElement).closest<HTMLAnchorElement>('a[data-anchor]');
    if (!link) {
      return;
    }
    event.preventDefault();
    bodyRef.current?.querySelector(`#${CSS.escape(link.dataset.anchor!)}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <Modal title="About" className="about" onClose={onClose} isKeyTrap>
      <div class="about-body" ref={bodyRef} onClick={handleBodyClick} dangerouslySetInnerHTML={{ __html: aboutHtml() }} />
    </Modal>
  );
}

export function showAbout(): void {
  openOverlay(close => <AboutDialog onClose={close} />);
}
