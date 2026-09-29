import type { BuildInfo } from '../version';
import './about.css';

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

/**
 * The About panel: which build each side of the game is (this bundle, the Mac
 * helper, the bridge) and which renderer backend is drawing. It used to be a
 * badge over the corner of the canvas at all times; it sat on top of the HUD.
 * A modal `<dialog>` like the Music credits; Esc or Close shuts it, and the
 * game's keys do nothing while it is open. It follows the build info live.
 */
export class AboutDialog {
  private readonly dialog = el('dialog', 'credits about');
  private readonly list = el('dl', 'about-list');
  private readonly note = el('p', 'about-note');
  private opener: HTMLElement | null = null;
  private readonly off: () => void;

  constructor(
    parent: HTMLElement,
    private readonly info: BuildInfo,
  ) {
    const head = el('header', 'panel-head');
    const titles = el('div', 'panel-titles');
    const h = el('h2', '', 'About');
    h.id = 'about-title';
    titles.append(h, el('p', '', 'Which build is running'));
    const close = el('button', 'btn btn--icon panel-close');
    close.type = 'button';
    close.setAttribute('aria-label', 'Close');
    close.title = 'Close (Esc)';
    close.append(closeIcon());
    close.addEventListener('click', () => this.close());
    head.append(titles, close);

    const body = el('div', 'panel-body credits-body about-body');
    body.tabIndex = -1;
    body.append(this.list, this.note);

    this.dialog.setAttribute('aria-labelledby', 'about-title');
    this.dialog.append(head, body);
    this.dialog.addEventListener('keydown', (e) => e.stopPropagation());
    this.dialog.addEventListener('close', () => {
      this.opener?.focus();
      this.opener = null;
    });
    this.dialog.addEventListener('click', (e) => {
      if (e.target === this.dialog) this.close();
    });
    parent.append(this.dialog);
    this.off = info.onChange(() => this.render());
    this.render();
  }

  get isOpen(): boolean {
    return this.dialog.open;
  }

  open(from: HTMLElement | null = null): void {
    if (this.dialog.open) return;
    this.opener = from;
    this.render();
    this.dialog.showModal();
    this.dialog.querySelector<HTMLElement>('.about-body')?.focus();
  }

  close(): void {
    if (this.dialog.open) this.dialog.close();
  }

  dispose(): void {
    this.off();
    this.close();
    this.dialog.remove();
  }

  private render(): void {
    const { info } = this;
    const rows: Array<[string, string | null]> = [
      ['Game', info.game],
      ['Helper', info.helper],
      ['Bridge', info.bridge],
      ['Renderer', info.backend],
    ];
    this.list.replaceChildren(
      ...rows.flatMap(([k, v]) => {
        const dd = el('dd', 'about-value', v ?? 'not connected');
        dd.classList.toggle('about-value--none', v === null);
        return [el('dt', 'about-key', k), dd];
      }),
    );
    const s = info.summary();
    this.note.hidden = !s.mismatch;
    this.note.textContent = s.mismatch ? 'The versions differ: one side is a stale install. Run h3d-update to bring them together.' : '';
  }
}
