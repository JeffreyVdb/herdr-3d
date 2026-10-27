import { isMac } from '../input/shortcuts';
import { h } from '../ui/dom';
import { isAbsolutePath, resolveFileRef } from './fileRef';
import { zoomKey } from './keys';
import { duotone } from '../ui/duotone';

/**
 * #31: the popover of a file reference in the transcript (`.tx-file-ref`, an inert anchor whose path the sanitiser kept in
 * `data-tx-file`): its full path, selectable, and "Copy file path". A click on the reference, or Enter / Space on it,
 * opens it with the keyboard on the button; Esc closes it and gives the keyboard back to the reference, a click
 * elsewhere closes it. It sits in the transcript's root, not in the scroller, so the scroller never clips it, and follows
 * the reference as the timeline scrolls (out of view, it closes). Short of room, only the path (and its note) scrolls:
 * Copy is always in view. A relative path is joined to the worker's checkout,
 * read when it opens; unknown, it stays relative and says so.
 */

export interface FileRefHost {
  /** What the popover is placed in and kept inside (the transcript's root, positioned). */
  root: HTMLElement;
  /** The scroll box the references are in. */
  scroller: HTMLElement;
  /** The worker's checkout now (null: not known). */
  cwd(): string | null;
  /** Puts text on the clipboard; false when it was refused. */
  copy(text: string): Promise<boolean>;
}

export const FILE_REF = 'tx-file-ref';
const PAD = 6;
const GAP = 4;
/** How long the button says "Copied". */
const COPIED_MS = 2000;

let ids = 0;

/** Puts text on the clipboard; false when the browser refused (no permission, not a secure context, no clipboard). */
export async function clipboardCopy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** Makes the sanitiser's file references in `el` into the popover's buttons (keyboard-reachable, announced as such). */
export function markFileRefs(el: HTMLElement): void {
  for (const a of el.querySelectorAll<HTMLElement>('a[data-tx-file]')) {
    const path = a.dataset.txFile ?? '';
    a.classList.add(FILE_REF);
    a.setAttribute('role', 'button');
    a.setAttribute('tabindex', '0');
    a.setAttribute('aria-haspopup', 'dialog');
    a.setAttribute('aria-expanded', 'false');
    if (!a.hasAttribute('title')) a.setAttribute('title', path);
  }
}

/** Where the popover may be (screen pixels): the part of the root inside the window, less the margin. */
export interface Room {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export function popRoom(box: Room, winWidth: number, winHeight: number): Room {
  return {
    top: Math.max(box.top, 0) + PAD,
    bottom: Math.min(box.bottom, winHeight) - PAD,
    left: Math.max(box.left, 0) + PAD,
    right: Math.min(box.right, winWidth) - PAD,
  };
}

/**
 * Its height and top for a reference at `ref`: `ht` tall unhindered, never under `least` while the room has that.
 * Below the reference when it fits there or there is more room below, else above; capped to that side's room, or, when
 * that is under `least`, `least` tall and moved back inside the room (over the reference).
 */
export function placeY(ht: number, least: number, ref: { top: number; bottom: number }, room: Room): { top: number; height: number; side: 'below' | 'above' } {
  const below = room.bottom - (ref.bottom + GAP);
  const above = ref.top - GAP - room.top;
  const side = ht <= below || below >= above ? 'below' : 'above';
  const fits = Math.max(0, side === 'below' ? below : above);
  const height = Math.max(0, Math.min(ht, Math.max(fits, least), room.bottom - room.top));
  const want = side === 'below' ? ref.bottom + GAP : ref.top - GAP - height;
  return { top: Math.max(room.top, Math.min(want, room.bottom - height)), height, side };
}

export class FileRefPopover {
  readonly el: HTMLDivElement;
  /** The path and its note: what shrinks and scrolls when room is short. */
  private readonly body: HTMLDivElement;
  private readonly pathEl: HTMLDivElement;
  private readonly note: HTMLParagraphElement;
  private readonly btn: HTMLButtonElement;
  private readonly btnText: HTMLSpanElement;
  private readonly btnIcon: HTMLSpanElement;
  private readonly status: HTMLDivElement;
  /** The reference it is open for (null: closed), and where to find it again when its row is drawn anew. */
  private anchor: HTMLElement | null = null;
  private where: { row: string; index: number; path: string } | null = null;
  private text = '';
  /** Tells a late clipboard answer from one for this opening. */
  private gen = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly onDocDown = (e: Event) => {
    const t = e.target as Node | null;
    if (!t || this.el.contains(t) || this.anchor?.contains(t)) return;
    this.close(false);
  };
  private readonly onResize = () => this.place();

  constructor(private readonly host: FileRefHost) {
    const id = `tx-fref-${++ids}`;
    this.pathEl = h('div', { class: 'tx-fref-path', id: `${id}-path`, tabindex: '0', 'aria-label': 'Full path', onfocus: () => this.selectPath() });
    this.note = h('p', { class: 'tx-fref-note', hidden: true });
    this.btnIcon = h('span', { class: 'tx-fref-ic', 'aria-hidden': 'true' });
    this.btnText = h('span', {}, 'Copy file path');
    this.btn = h('button', { type: 'button', class: 'tx-fref-copy', onclick: () => void this.copy() }, this.btnIcon, this.btnText);
    this.status = h('div', { class: 'tx-fref-status', role: 'status', 'aria-live': 'polite' });
    this.body = h('div', { class: 'tx-fref-body' }, this.pathEl, this.note);
    this.el = h(
      'div',
      { class: 'tx-fref', id, role: 'dialog', 'aria-label': 'File path', 'aria-describedby': `${id}-path`, hidden: true },
      this.body,
      h('div', { class: 'tx-fref-row' }, this.btn),
      this.status,
    );
    this.el.addEventListener('keydown', (e) => this.onKey(e));
    this.el.addEventListener('focusout', (e) => {
      const to = e.relatedTarget as Node | null;
      if (to && !this.el.contains(to) && !this.anchor?.contains(to)) this.close(false);
    });
    host.scroller.addEventListener('click', (e) => this.onClick(e));
    host.scroller.addEventListener('keydown', (e) => this.onRefKey(e));
    host.scroller.addEventListener('scroll', () => this.place(), { passive: true });
    host.root.append(this.el);
  }

  get open(): boolean {
    return !!this.anchor;
  }

  /** Opens for a reference (its path read now, a relative one against the checkout now); the keyboard goes to Copy. */
  show(a: HTMLElement): void {
    if (this.anchor) this.close(false);
    const written = a.dataset.txFile ?? '';
    if (!written) return;
    const cwd = this.host.cwd();
    this.text = resolveFileRef(written, cwd);
    this.anchor = a;
    const row = a.closest<HTMLElement>('[data-id]');
    this.where = row?.dataset.id ? { row: row.dataset.id, index: [...row.querySelectorAll(`.${FILE_REF}`)].indexOf(a), path: written } : null;
    this.gen++;
    this.pathEl.textContent = this.text;
    const relative = !isAbsolutePath(written);
    this.note.hidden = !relative;
    this.note.textContent = !relative ? '' : this.text !== written ? `Written as ${written}, in the worker’s checkout.` : 'Relative to the worker’s checkout, which isn’t known here.';
    this.setState('idle');
    a.setAttribute('aria-expanded', 'true');
    a.setAttribute('aria-controls', this.el.id);
    this.el.hidden = false;
    this.body.scrollTop = 0;
    document.addEventListener('pointerdown', this.onDocDown, true);
    window.addEventListener('resize', this.onResize);
    this.place();
    this.btn.focus({ preventScroll: true });
  }

  /** Closes it; `refocus`: the keyboard back to the reference (else it stays where it went, or the timeline if it was inside). */
  close(refocus: boolean): void {
    const a = this.anchor;
    if (!a) return;
    const had = this.el.contains(document.activeElement);
    this.anchor = null;
    this.where = null;
    this.gen++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    a.setAttribute('aria-expanded', 'false');
    a.removeAttribute('aria-controls');
    this.el.hidden = true;
    document.removeEventListener('pointerdown', this.onDocDown, true);
    window.removeEventListener('resize', this.onResize);
    if (refocus && a.isConnected) a.focus({ preventScroll: true });
    else if (had) (a.isConnected ? a : this.host.scroller).focus({ preventScroll: true });
  }

  /**
   * Next to its reference, below it (above when there is more room there), inside the root and the window; closed when
   * the reference scrolled out of the timeline. A row drawn anew (an update) brings the same reference back: it follows
   * that one. Short of room on both sides it takes the roomier one and, rather than shrink below the least it may be
   * (Copy and two lines of the path), moves over the reference, still inside the root.
   */
  place(): void {
    let a = this.anchor;
    if (!a) return;
    if (!a.isConnected) {
      a = this.refind();
      if (!a) return this.close(false);
      a.setAttribute('aria-expanded', 'true');
      a.setAttribute('aria-controls', this.el.id);
      this.anchor = a;
    }
    const r = a.getClientRects()[0] ?? a.getBoundingClientRect();
    const view = this.host.scroller.getBoundingClientRect();
    if (view.height > 0 && (r.bottom <= view.top || r.top >= view.bottom)) return this.close(false);
    const root = this.host.root;
    const box = root.getBoundingClientRect();
    // A root drawn scaled (a CSS transform): boxes are in screen pixels, `left`/`top` in its own.
    const k = root.offsetWidth > 0 && box.width > 0 ? box.width / root.offsetWidth : 1;
    const room = popRoom(box, innerWidth, innerHeight);
    const pop = this.el;
    pop.style.maxWidth = `${Math.max(0, room.right - room.left) / k}px`;
    pop.style.maxHeight = '';
    const ht = pop.offsetHeight * k;
    const bodyHt = this.body.offsetHeight * k;
    // The least: all of it but the path and its note, and two lines of the path (all of them when that is less).
    const least = ht - bodyHt + Math.min(bodyHt, this.twoLines() * k);
    const { top, height, side } = placeY(ht, least, r, room);
    if (height < ht) pop.style.maxHeight = `${height / k}px`;
    const w = pop.offsetWidth * k;
    const left = Math.max(room.left, Math.min(r.left, room.right - w));
    pop.style.left = `${(left - box.left) / k}px`;
    pop.style.top = `${(top - box.top) / k}px`;
    pop.dataset.side = side;
  }

  destroy(): void {
    this.close(false);
    this.el.remove();
  }

  /** The body showing two lines of the path: their height with the path's and the body's padding (before the root's scale). */
  private twoLines(): number {
    const cs = getComputedStyle(this.pathEl);
    const bs = getComputedStyle(this.body);
    const px = (v: string) => parseFloat(v) || 0;
    const line = px(cs.lineHeight) || px(cs.fontSize) * 1.45 || 17;
    return 2 * line + px(cs.paddingTop) + px(cs.paddingBottom) + px(bs.paddingTop) + px(bs.paddingBottom);
  }

  private refind(): HTMLElement | null {
    const w = this.where;
    if (!w) return null;
    const row = [...this.host.scroller.querySelectorAll<HTMLElement>('[data-id]')].find((r) => r.dataset.id === w.row);
    const a = row?.querySelectorAll<HTMLElement>(`.${FILE_REF}`)[w.index];
    return a && a.dataset.txFile === w.path ? a : null;
  }

  private onClick(e: MouseEvent): void {
    const a = (e.target as Element | null)?.closest?.<HTMLElement>(`.${FILE_REF}`);
    if (!a || !this.host.scroller.contains(a)) return;
    e.preventDefault();
    // Selecting the label's text (a drag that ends on it) is not a click on it.
    const sel = document.getSelection();
    if (sel && !sel.isCollapsed && sel.rangeCount && a.contains(sel.getRangeAt(0).commonAncestorContainer)) return;
    if (this.anchor === a) this.close(false);
    else this.show(a);
  }

  private onRefKey(e: KeyboardEvent): void {
    const a = e.target as HTMLElement | null;
    if (!a?.classList?.contains(FILE_REF) || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      e.stopPropagation();
      if (this.anchor === a) this.close(true);
      else this.show(a);
    } else if (e.key === 'Escape' && this.anchor === a) {
      e.preventDefault();
      e.stopPropagation();
      this.close(true);
    }
  }

  private onKey(e: KeyboardEvent): void {
    // The popover's keys are its own: none scrolls the timeline, answers a question or stands you up. The text zoom
    // works from here too.
    if (zoomKey(e)) return;
    e.stopPropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      this.close(true);
    } else if (e.key === 'Tab') {
      // Its two stops, round and round (Esc leaves).
      e.preventDefault();
      (document.activeElement === this.btn ? this.pathEl : this.btn).focus();
    }
  }

  private async copy(): Promise<void> {
    if (!this.anchor) return;
    const gen = this.gen;
    let ok = false;
    try {
      ok = await this.host.copy(this.text);
    } catch {
      ok = false;
    }
    if (gen !== this.gen || !this.anchor) return;
    if (ok) {
      this.setState('copied');
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => {
        this.timer = null;
        if (gen === this.gen) this.setState('idle', true);
      }, COPIED_MS);
      return;
    }
    // Refused: the path is selected and has the keyboard, so the copy key does it.
    this.setState('failed');
    this.pathEl.focus({ preventScroll: true });
    this.selectPath();
  }

  private setState(state: 'idle' | 'copied' | 'failed', keepStatus = false): void {
    this.el.dataset.state = state;
    this.btnIcon.replaceChildren(duotone(state === 'copied' ? 'check' : 'copy'));
    this.btnText.textContent = state === 'copied' ? 'Copied' : 'Copy file path';
    const key = isMac() ? '⌘C' : 'Ctrl+C';
    if (state === 'copied') this.status.textContent = 'File path copied to the clipboard.';
    else if (state === 'failed') this.status.textContent = `Couldn’t copy: the browser refused the clipboard. The path is selected: press ${key} to copy it.`;
    else if (!keepStatus) this.status.textContent = '';
    // The place may change with the message's line.
    if (this.anchor) this.place();
  }

  private selectPath(): void {
    const sel = document.getSelection();
    if (!sel || !this.pathEl.firstChild) return;
    const range = document.createRange();
    range.selectNodeContents(this.pathEl);
    sel.removeAllRanges();
    sel.addRange(range);
  }
}
