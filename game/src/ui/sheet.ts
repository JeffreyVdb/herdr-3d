import { backdropPolicy } from './dismiss';
import './sheet.css';

const NS = 'http://www.w3.org/2000/svg';

export type SheetCloseReason = 'esc' | 'button' | 'backdrop' | 'api';

export interface SheetOptions {
  /** The dialog's accessible name (aria-label or a labelled heading). */
  label: string;
  /** Visible heading text in the header; defaults to `label`. */
  title?: string;
  /** Extra class(es) on the <dialog>, for the caller's own styling (e.g. 'tx-qsheet'). */
  className?: string;
  /** Runs once after every close, whatever closed it. */
  onClose?: (why: SheetCloseReason) => void;
  /** Where focus lands on open (default: the first focusable control in `body`, else the dialog itself). */
  initialFocus?: () => HTMLElement | null;
}

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [contenteditable="true"], [tabindex]:not([tabindex="-1"])';

let seq = 0;

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
 * #187: one modal `<dialog>` that is a centred dialog on a desktop and a bottom sheet on a phone (`pointer: coarse` or a
 * viewport under 640px: the switch is sheet.css's alone). It goes on `document.body`, in the top layer and sized to the
 * viewport, never to the laptop's screen (a phone's laptop can be under 200px tall). The caller fills `body` and owns
 * what it puts there; the header holds the title and the close button.
 *
 * Ways out, each reported once to `onClose`: Esc (the dialog's `cancel`, taken over so the reason is known), the close
 * button, a press and click both on the backdrop (dismiss.ts's `sheet` policy: what is typed inside survives a close,
 * the caller keeps it), and `close()`. A close the browser makes without a `cancel` (Chrome skips it on a repeated Esc
 * without a user gesture in between) is Esc too. `destroy()` closes without a word.
 *
 * Keys pressed inside are the sheet's: they stop at the dialog (the game's and the laptop's handlers listen on the
 * window, bubbling: a letter would walk, Esc would stand you up). Listeners on `el` or inside `body` still hear them,
 * and the capture-phase chords (palette, dictation, help) still reach the app, as under every dialog. A key release
 * goes on, so a held movement key is never left down.
 *
 * The on-screen keyboard: the page's viewport meta lets it cover the page rather than resize it, and `dvh` ignores it,
 * so while open the sheet follows `visualViewport`: `--sheet-kb` (the keyboard's height under the visible part) lifts
 * the bottom sheet above it, `--sheet-vv` caps its height, and the focused field is scrolled back into view.
 */
export class Sheet {
  readonly el: HTMLDialogElement;
  readonly body: HTMLElement;
  readonly header: HTMLElement;
  private readonly titleEl: HTMLElement;
  private opener: HTMLElement | null = null;
  /** Open by our own `open()` and not yet closed by one of our paths. */
  private shown = false;
  private destroyed = false;

  constructor(private readonly opts: SheetOptions) {
    const id = `sheet-${++seq}`;
    this.el = document.createElement('dialog');
    this.el.className = opts.className ? `sheet ${opts.className}` : 'sheet';
    this.el.id = id;
    // The fallback focus target when the body has no control.
    this.el.tabIndex = -1;

    const grab = document.createElement('div');
    grab.className = 'sheet-grab';
    grab.setAttribute('aria-hidden', 'true');

    this.header = document.createElement('header');
    this.header.className = 'sheet-head';
    this.titleEl = document.createElement('h2');
    this.titleEl.className = 'sheet-title';
    this.titleEl.id = `${id}-title`;
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'btn btn--icon sheet-close';
    close.setAttribute('aria-label', 'Close');
    close.title = 'Close (Esc)';
    close.append(closeIcon());
    close.addEventListener('click', () => this.shut('button'));
    this.header.append(this.titleEl, close);

    this.body = document.createElement('div');
    this.body.className = 'sheet-body';

    this.el.append(grab, this.header, this.body);
    this.setLabel(opts.label, opts.title);

    this.el.addEventListener('cancel', (e) => {
      e.preventDefault();
      this.shut('esc');
    });
    this.el.addEventListener('close', () => {
      // Closed by the browser, not by one of the paths below.
      if (this.shown && !this.el.open) this.finish('esc');
    });
    this.el.addEventListener('keydown', (e) => e.stopPropagation());
    this.el.addEventListener('focusin', (e) => this.reveal(e.target));
    backdropPolicy(this.el, 'sheet', () => this.shut('backdrop'));
  }

  get isOpen(): boolean {
    return this.el.open;
  }

  open(opener: HTMLElement | null = null): void {
    if (this.destroyed || this.el.open) return;
    const active = document.activeElement;
    this.opener = opener ?? (active instanceof HTMLElement && active !== document.body ? active : null);
    if (!this.el.isConnected) document.body.append(this.el);
    this.el.showModal();
    this.shown = true;
    this.followViewport(true);
    const target = this.opts.initialFocus?.() ?? this.body.querySelector<HTMLElement>(FOCUSABLE) ?? this.el;
    target.focus();
  }

  close(): void {
    this.shut('api');
  }

  setLabel(label: string, title: string = label): void {
    this.titleEl.textContent = title;
    if (title === label) {
      this.el.removeAttribute('aria-label');
      this.el.setAttribute('aria-labelledby', this.titleEl.id);
    } else {
      this.el.removeAttribute('aria-labelledby');
      this.el.setAttribute('aria-label', label);
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.el.open) {
      this.shown = false;
      this.el.close();
      this.settle();
    }
    this.el.remove();
  }

  private shut(why: SheetCloseReason): void {
    if (!this.el.open) return;
    this.shown = false;
    this.el.close();
    this.finish(why);
  }

  private finish(why: SheetCloseReason): void {
    this.shown = false;
    this.settle();
    this.opts.onClose?.(why);
  }

  /** After any close: stop following the viewport, and the focus back where it came from (still on the page). */
  private settle(): void {
    this.followViewport(false);
    const back = this.opener;
    this.opener = null;
    if (back?.isConnected) back.focus({ preventScroll: true });
  }

  private followViewport(on: boolean): void {
    const vv = window.visualViewport;
    if (!vv) return;
    if (on) {
      vv.addEventListener('resize', this.onViewport);
      vv.addEventListener('scroll', this.onViewport);
      this.onViewport();
    } else {
      vv.removeEventListener('resize', this.onViewport);
      vv.removeEventListener('scroll', this.onViewport);
    }
  }

  private readonly onViewport = (): void => {
    const vv = window.visualViewport;
    if (!vv) return;
    // A pinch zoom shrinks the visual viewport too; only an unzoomed one that is shorter than the page is a keyboard.
    const zoomed = vv.scale > 1.01;
    const kb = zoomed ? 0 : Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
    this.el.style.setProperty('--sheet-kb', `${Math.round(kb)}px`);
    this.el.style.setProperty('--sheet-vv', `${Math.round(zoomed ? window.innerHeight : vv.height)}px`);
    if (kb > 0) this.reveal(document.activeElement);
  };

  /** The focused control back into view inside the scrolling body (the keyboard came up over it, or it was tabbed to). */
  private reveal(t: EventTarget | null): void {
    if (t instanceof HTMLElement && t !== this.body && this.body.contains(t)) t.scrollIntoView?.({ block: 'nearest' });
  }
}
