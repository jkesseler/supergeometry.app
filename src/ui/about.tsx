// More → About: the README (the one on GitHub), shown in the app. Built into
// the app (it's the same file), less the lines that only make sense on GitHub.

import { render as mount } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import readme from '../../README.md?raw';
import { icons } from './icons';

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

/** **bold**, *italic*, `code`, [links](...) - in already escaped text. */
function inline(markdown: string): string {
  const codes: string[] = [];
  let t = esc(markdown).replace(/`([^`]+)`/g, (_, code) => `\u0000${codes.push(code) - 1}\u0000`);
  t = t
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|[^*\w])\*([^*\s][^*]*)\*/g, '$1<i>$2</i>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, text, url) => {
      if (url.startsWith('#')) {
        return `<a href="${url}" data-anchor="${url.slice(1)}">${text}</a>`;
      }
      const href = /^https?:/.test(url) ? url : `${REPO}/blob/main/${url}`;

      return `<a href="${href}" target="_blank" rel="noopener">${text}</a>`;
    });

  return t.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[Number(i)]}</code>`);
}

/** The README's own kind of Markdown: headings, paragraphs, lists, tables, code blocks, rules. */
function render(md: string): string {
  const lines = md.split('\n');
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^```/.test(line)) {
      const code: string[] = [];
      for (i++; i < lines.length && !/^```/.test(lines[i]); i++) {
        code.push(lines[i]);
      }
      i++;
      out.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`);
      continue;
    }
    const match = line.match(/^(#{1,4})\s+(.*)$/);
    if (match) {
      const count = match[1].length;
      out.push(`<h${count} id="${slug(match[2])}">${inline(match[2])}</h${count}>`);
      i++;
      continue;
    }
    if (/^---+\s*$/.test(line)) {
      out.push('<hr>');
      i++;
      continue;
    }
    if (/^\|/.test(line)) {
      const rows: string[][] = [];
      for (; i < lines.length && /^\|/.test(lines[i]); i++) {
        const cells = lines[i].replace(/^\||\|\s*$/g, '').split('|').map(cell => cell.trim());
        if (cells.every(cell => /^:?-+:?$/.test(cell))) {
          continue;
        }
        rows.push(cells);
      }
      const [head, ...body] = rows;
      out.push(
        `<div class="about-table"><table><thead><tr>${head.map(cell => `<th>${inline(cell)}</th>`).join('')}</tr></thead><tbody>${body
          .map(row => `<tr>${row.map(cell => `<td>${inline(cell)}</td>`).join('')}</tr>`)
          .join('')}</tbody></table></div>`
      );
      continue;
    }
    const item = /^(\s*)([-*]|\d+\.)\s+/;
    if (item.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items: string[] = [];
      while (i < lines.length && item.test(lines[i])) {
        let text = lines[i].replace(item, '');
        // Its wrapped lines (indented, not a new item).
        for (i++; i < lines.length && /^\s+\S/.test(lines[i]) && !item.test(lines[i]); i++) {
          text += ' ' + lines[i].trim();
        }
        items.push(`<li>${inline(text)}</li>`);
      }
      out.push(ordered ? `<ol>${items.join('')}</ol>` : `<ul>${items.join('')}</ul>`);
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    const para: string[] = [];
    for (; i < lines.length && lines[i].trim() && !/^(#{1,4}\s|```|\||---+\s*$)/.test(lines[i]) && !item.test(lines[i]); i++) {
      para.push(lines[i].trim());
    }
    out.push(`<p>${inline(para.join(' '))}</p>`);
  }

  return out.join('\n');
}

interface AboutDialogProps {
  onClose: () => void;
}

function AboutDialog({ onClose }: AboutDialogProps) {
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
      event.stopPropagation();
    };
    window.addEventListener('keydown', handleKey, true);

    return () => window.removeEventListener('keydown', handleKey, true);
  }, [onClose]);

  const handleBodyClick = (event: MouseEvent) => {
    const link = (event.target as HTMLElement).closest<HTMLAnchorElement>('a[data-anchor]');
    if (!link) {
      return;
    }
    event.preventDefault();
    bodyRef.current?.querySelector(`#${CSS.escape(link.dataset.anchor!)}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <div class="dialog-back" onPointerDown={event => event.target === event.currentTarget && onClose()}>
      <div class="dialog about">
        <div class="library-head">
          <div class="panel-title">About</div>
          <button type="button" class="icon-btn library-close" title="Close" onClick={onClose} dangerouslySetInnerHTML={{ __html: icons.close }} />
        </div>
        <div class="about-body" ref={bodyRef} onClick={handleBodyClick} dangerouslySetInnerHTML={{ __html: render(aboutText()) }} />
      </div>
    </div>
  );
}

export function showAbout(): void {
  const host = document.createElement('div');
  const close = () => {
    mount(null, host);
    host.remove();
  };
  document.body.append(host);
  mount(<AboutDialog onClose={close} />, host);
}
