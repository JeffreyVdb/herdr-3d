import DOMPurify, { type Config } from 'dompurify';
import { Marked } from 'marked';

/**
 * M7: an issue's or PR's markdown as safe DOM. The text is a stranger's (issue authors, commenters): it is rendered with
 * `marked` and the HTML is then sanitised with DOMPurify against an allowlist, so nothing in it can run or load: no
 * script, style, form, frame, svg or image (a remote image would tell its host who reads the issue: it is shown as a
 * link), no `on*` handler, and only `http(s):` and `mailto:` links, all opened in a new context with
 * `rel="noopener noreferrer"`. Without a DOM to sanitise in, it shows the plain text instead: it never fails open.
 */

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const marked = new Marked({
  gfm: true,
  breaks: false,
  async: false,
  renderer: {
    // Never an <img>: a link that names it.
    image({ href, text }) {
      return `<a href="${escape(href)}">${escape(text || 'image')}</a>`;
    },
  },
});

const CONFIG: Config = {
  ALLOWED_TAGS: ['p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote', 'pre', 'code', 'em', 'strong', 'del', 's', 'a', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'sup', 'sub', 'details', 'summary'],
  ALLOWED_ATTR: ['href', 'title'],
  ALLOWED_URI_REGEXP: /^(?:https?:|mailto:)/i,
  ALLOW_DATA_ATTR: false,
  ALLOW_ARIA_ATTR: false,
  ALLOW_UNKNOWN_PROTOCOLS: false,
  RETURN_DOM_FRAGMENT: true,
};

let hooked = false;
function hook(): void {
  if (hooked) return;
  hooked = true;
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.nodeName !== 'A') return;
    const a = node as Element;
    if (!a.getAttribute('href')) {
      a.removeAttribute('href');
      return;
    }
    a.setAttribute('target', '_blank');
    a.setAttribute('rel', 'noopener noreferrer');
  });
}

/** Sanitised DOM for `md`; null when this environment cannot sanitise (no DOM). */
export function renderMarkdown(md: string): DocumentFragment | null {
  if (!DOMPurify.isSupported) return null;
  hook();
  const html = marked.parse(md ?? '', { async: false });
  return DOMPurify.sanitize(html, { ...CONFIG, RETURN_DOM_FRAGMENT: true });
}

/** Puts `md` into `el`: rendered and sanitised, else as plain text. */
export function setMarkdown(el: HTMLElement, md: string): void {
  const frag = renderMarkdown(md);
  if (frag) el.replaceChildren(frag);
  else el.textContent = md;
}
