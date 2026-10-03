import { isMac, reference, type ReferenceGroup } from '../input/shortcuts';
import './credits.css';
import './shortcuts.css';
import { backdropPolicy } from './dismiss';

const NS = 'http://www.w3.org/2000/svg';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function closeIcon(): SVGSVGElement {
  const s = document.createElementNS(NS, 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('fill', 'none');
  s.setAttribute('stroke', 'currentColor');
  s.setAttribute('stroke-width', '2');
  s.setAttribute('stroke-linecap', 'round');
  s.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(NS, 'path');
  p.setAttribute('d', 'M6.5 6.5l11 11M17.5 6.5l-11 11');
  s.append(p);
  return s;
}

/** One alternative of a binding: `<kbd>Shift</kbd>+<kbd>R</kbd>`, read as "Shift plus R". */
function caps(list: readonly string[]): HTMLElement {
  const g = el('span', 'sc-chord');
  list.forEach((c, i) => {
    if (i) g.append(el('span', 'sc-plus', '+'));
    g.append(el('kbd', '', c));
  });
  return g;
}

/**
 * #124: the shortcut reference (`?`, or Ctrl/⌘+/ from inside a field): every binding of the table in input/shortcuts.ts,
 * grouped by where it works, the modifier as this platform names it (⌘ on a Mac) and each key as this keyboard labels it
 * (`navigator.keyboard.getLayoutMap()` where the browser has it, else the key's code name). A modal `<dialog>` like About
 * and the music credits: the page behind it is inert (the focus stays inside), Esc or Close shuts it, and the focus goes
 * back to where it was. Read-only; it is drawn afresh each time it opens, so a layout map that arrived late shows.
 */
export class ShortcutsDialog {
  private readonly dialog = el('dialog', 'credits shortcuts');
  private readonly body = el('div', 'panel-body credits-body sc-body');
  private opener: HTMLElement | null = null;

  constructor(parent: HTMLElement) {
    const head = el('header', 'panel-head');
    const titles = el('div', 'panel-titles');
    const h = el('h2', '', 'Keyboard shortcuts');
    h.id = 'shortcuts-title';
    titles.append(h, el('p', '', 'Everything you can do without the mouse'));
    const close = el('button', 'btn btn--icon panel-close');
    close.type = 'button';
    close.setAttribute('aria-label', 'Close');
    close.title = 'Close (Esc)';
    close.append(closeIcon());
    close.addEventListener('click', () => this.close());
    head.append(titles, close);

    this.body.tabIndex = 0;
    this.body.setAttribute('role', 'region');
    this.body.setAttribute('aria-label', 'Shortcuts by place');

    this.dialog.setAttribute('aria-labelledby', 'shortcuts-title');
    this.dialog.append(head, this.body);
    // What is pressed here is this dialog's (Esc closes it by itself); the game must not walk or open something behind it.
    this.dialog.addEventListener('keydown', (e) => e.stopPropagation());
    this.dialog.addEventListener('close', () => {
      const back = this.opener;
      this.opener = null;
      // Back to where the keyboard was (a button of a dialog under this one, the scene's canvas, a field); gone: the page.
      // (This runs a task after the close: not over a focus that has already moved on.)
      const now = document.activeElement;
      if (back?.isConnected && (!now || now === document.body || this.dialog.contains(now))) back.focus();
    });
    // A read-only sheet: the backdrop closes it only when the press and the click both began there (#51).
    backdropPolicy(this.dialog, 'sheet', () => this.close());
    parent.append(this.dialog);
  }

  get isOpen(): boolean {
    return this.dialog.open;
  }

  open(from: HTMLElement | null = null): void {
    if (this.dialog.open) return;
    this.opener = from;
    this.render();
    this.dialog.showModal();
    this.body.focus();
  }

  close(): void {
    if (this.dialog.open) this.dialog.close();
  }

  dispose(): void {
    this.close();
    this.dialog.remove();
  }

  private render(): void {
    const mac = isMac();
    const intro = el('p', 'sc-intro');
    intro.append(
      'Single keys work while the scene has the keyboard and pause the moment a text field has it, so typing never fires one. ',
      caps([mac ? '⌘' : 'Ctrl', '/']),
      ' opens this list from inside a field.',
    );
    this.body.replaceChildren(intro, ...reference(mac).map((g, i) => this.group(g, i)));
  }

  private group(g: ReferenceGroup, i: number): HTMLElement {
    const sec = el('section', 'sc-group');
    const hid = `shortcuts-g${i}`;
    sec.setAttribute('aria-labelledby', hid);
    const h = el('h3', 'sc-title', g.title);
    h.id = hid;
    const list = el('dl', 'sc-list');
    for (const e of g.entries) {
      const row = el('div', 'sc-row');
      const keys = el('dd', 'sc-keys');
      e.caps.forEach((c, n) => {
        if (n) keys.append(el('span', 'sc-or', 'or'));
        keys.append(caps(c));
      });
      row.append(el('dt', 'sc-what', e.label), keys);
      list.append(row);
    }
    sec.append(h, el('p', 'sc-note', g.note), list);
    return sec;
  }
}
