/** Small DOM helpers for the HUD panels: text is always set as text, never parsed. */

type Attrs = Record<string, string | number | boolean | null | undefined | ((e: Event) => void)>;
export type Child = Node | string | null | undefined | false;

/**
 * `h('button', { class: 'btn', onclick: fn, 'aria-label': 'Close' }, 'Close')`.
 * `on*` keys add listeners, `true` sets an empty attribute, null/false/undefined skip.
 */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (typeof v === 'function') e.addEventListener(k.slice(2), v);
    else if (v === true) e.setAttribute(k, '');
    else e.setAttribute(k, String(v));
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) e.append(c);
  if (tag === 'button' && !e.hasAttribute('type')) e.setAttribute('type', 'button');
  return e;
}

/** Authored 24×24 stroke icons, one weight (same family as the top bar's). */
export const ICON = {
  back: '<path d="M14.5 6 8.5 12l6 6"/>',
  close: '<path d="M6.5 6.5 17.5 17.5M17.5 6.5 6.5 17.5"/>',
  up: '<path d="M6.5 14.5 12 9l5.5 5.5"/>',
  down: '<path d="M6.5 9.5 12 15l5.5-5.5"/>',
  building: '<path d="M4.5 20.5h15"/><path d="M6.5 20.5V5.5a1.5 1.5 0 0 1 1.5-1.5h8a1.5 1.5 0 0 1 1.5 1.5v15"/><path d="M10 8h1M13 8h1M10 11.5h1M13 11.5h1M10 15h1M13 15h1"/><path d="M11 20.5v-2.5h2v2.5"/>',
  lift: '<path d="M12 4.5 8.5 8.5h7z" fill="currentColor"/><path d="M12 19.5l3.5-4h-7z" fill="currentColor"/>',
  moon: '<path d="M19 14.5A7.5 7.5 0 0 1 9.5 5a7.5 7.5 0 1 0 9.5 9.5z"/>',
  sun: '<circle cx="12" cy="12" r="3.6"/><path d="M12 3.5v2M12 18.5v2M3.5 12h2M18.5 12h2M6 6l1.4 1.4M16.6 16.6 18 18M6 18l1.4-1.4M16.6 7.4 18 6"/>',
  gear: '<circle cx="12" cy="12" r="2.8"/><path d="M12 3.8v2.1M12 18.1v2.1M20.2 12h-2.1M5.9 12H3.8M17.8 6.2l-1.5 1.5M7.7 16.3l-1.5 1.5M17.8 17.8l-1.5-1.5M7.7 7.7 6.2 6.2"/>',
  pencil: '<path d="M5 19l1-4.2L15.8 5a1.8 1.8 0 0 1 2.6 0l.6.6a1.8 1.8 0 0 1 0 2.6L9.2 18z"/><path d="M13.8 7l3.2 3.2"/>',
  trash: '<path d="M5 7h14M10 7V5h4v2M7 7l.8 12.2a1 1 0 0 0 1 .8h6.4a1 1 0 0 0 1-.8L17 7"/>',
  move: '<path d="M4.5 12h11M11.5 7.5 16 12l-4.5 4.5"/><path d="M19.5 5v14"/>',
  plus: '<path d="M12 5.5v13M5.5 12h13"/>',
  refresh: '<path d="M19 12a7 7 0 1 1-2.1-5"/><path d="M19.2 4.6v3.9h-3.9"/>',
  chevron: '<path d="M7 9.5l5 5 5-5"/>',
};

export function icon(paths: string): SVGSVGElement {
  const t = document.createElement('template');
  t.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths}</svg>`;
  return t.content.firstElementChild as SVGSVGElement;
}

/**
 * Replaces `parent`'s children and, when focus was inside, puts it back on the
 * element with the same `data-key` (else `fallback`'s, else the first
 * control), so a live re-render does not throw the user out of a list.
 */
export function replaceKeepingFocus(parent: HTMLElement, children: Node[], fallback?: string): void {
  const a = document.activeElement;
  const had = a instanceof HTMLElement && parent.contains(a);
  const key = had ? a.dataset.key : undefined;
  parent.replaceChildren(...children);
  if (!had) return;
  const find = (k: string | undefined) => (k ? parent.querySelector<HTMLElement>(`[data-key="${CSS.escape(k)}"]`) : null);
  (find(key) ?? find(fallback) ?? parent.querySelector<HTMLElement>('button, input, select'))?.focus();
}
