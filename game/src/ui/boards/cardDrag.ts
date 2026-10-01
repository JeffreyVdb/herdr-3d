import { afterFor, edgeSpeed, samePlace, slotAt, type DropColumn, type Slot } from './drag';

/**
 * #52: picking an issue card up and dropping it in another column (or another place of its own), with pointer events so
 * mouse, pen and touch all work (HTML5 drag and drop has no touch). A mouse or pen drag starts after a few pixels of
 * movement, so a click still opens the card; a finger has to rest on the card first (a long press), so a swipe still
 * scrolls the board. While a drag is live: the card's spot shows its ghost (the pin stays on the board), the card follows
 * the pointer, the column under it lights up and, when the board can order cards, a line shows the exact slot. Near the
 * board's edges it scrolls. Esc, a drop outside a column, a drop on the card's own place or a cancelled pointer send
 * nothing. The arithmetic is `drag.ts`; this is the DOM.
 *
 * The DOM it reads: `.bd-col[data-col]` sections (`data-drop="true"` when cards may land there), each with a
 * `.bd-col-cards` list of `.bd-card[data-id]` buttons; a card that may be picked up has `data-drag="true"`.
 */

export interface CardDragHost {
  /** Whether this card can be picked up now. */
  canDrag(id: string): boolean;
  /** The board sets the card's place too: an insertion line, and `after` on the drop; else only the column lights up. */
  ordered(id: string): boolean;
  /** A drop that changes something; `after` is undefined when the board does not order cards. */
  drop(id: string, column: string, after: string | null | undefined): void;
  /** A drag became live (true) or ended (false): the columns are not redrawn under a live drag. */
  live(on: boolean): void;
}

/** Movement that starts a mouse or pen drag, and that turns a resting finger into a scroll instead. */
const MOVE_PX = 5;
const TOUCH_SLOP = 10;
const LONG_PRESS_MS = 380;
/** A click that follows a drag's release is the drag's, not a click on the card (a touch's comes a little later). */
const CLICK_AFTER_MS = 400;

interface Pending {
  id: string;
  el: HTMLElement;
  pointerId: number;
  touch: boolean;
  x0: number;
  y0: number;
  x: number;
  y: number;
  timer: number | null;
}

interface Live {
  id: string;
  el: HTMLElement;
  from: string;
  pointerId: number;
  touch: boolean;
  ordered: boolean;
  lifted: HTMLElement;
  ox: number;
  oy: number;
  x: number;
  y: number;
  slot: Slot | null;
  frame: number;
}

export class CardDrag {
  private pending: Pending | null = null;
  private drag: Live | null = null;
  private readonly line: HTMLElement;
  private swallowUntil = 0;

  /** `body` scrolls the columns; `layer` (the dialog, in the top layer) holds the card that follows the pointer. */
  constructor(
    private readonly body: HTMLElement,
    private readonly layer: HTMLElement,
    private readonly host: CardDragHost,
  ) {
    this.line = document.createElement('div');
    this.line.className = 'bd-slot';
    this.line.setAttribute('aria-hidden', 'true');
    body.addEventListener('pointerdown', this.onDown);
    // Once a drag is live the finger moves the card, not the board: that needs touchmoves the page can cancel, so the
    // listener is there before the touch starts (one added on the way is too late for a touch that has begun).
    body.addEventListener('touchmove', this.onTouchMove, { passive: false });
    // A long press on a card is the start of a drag, never the browser's menu.
    body.addEventListener('contextmenu', (e) => {
      if (this.pending?.touch || this.drag) e.preventDefault();
    });
  }

  get active(): boolean {
    return this.drag !== null;
  }

  /** Whether an Esc that just ended a drag is still on its way (its dialog must not close for it). */
  get swallowing(): boolean {
    return performance.now() < this.swallowUntil;
  }

  /** Ends whatever is going on without a drop (the board closed, the floor changed). */
  cancel(): void {
    this.abandon();
    this.finish(false);
  }

  // ---- before the drag ------------------------------------------------------------------------------

  private readonly onDown = (e: PointerEvent): void => {
    if (this.drag || this.pending || !e.isPrimary) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const el = (e.target as HTMLElement | null)?.closest<HTMLElement>('.bd-card[data-drag="true"]');
    const id = el?.dataset.id;
    if (!el || !id || !this.body.contains(el) || !this.host.canDrag(id)) return;
    const touch = e.pointerType === 'touch';
    this.pending = { id, el, pointerId: e.pointerId, touch, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, timer: null };
    if (touch) this.pending.timer = window.setTimeout(() => this.start(), LONG_PRESS_MS);
    window.addEventListener('pointermove', this.onMove, true);
    window.addEventListener('pointerup', this.onUp, true);
    window.addEventListener('pointercancel', this.onCancel, true);
  };

  private readonly onTouchMove = (e: TouchEvent): void => {
    if (this.drag && e.cancelable) e.preventDefault();
  };

  private readonly onMove = (e: PointerEvent): void => {
    const p = this.pending;
    if (p && e.pointerId === p.pointerId) {
      p.x = e.clientX;
      p.y = e.clientY;
      const d = Math.hypot(p.x - p.x0, p.y - p.y0);
      if (p.touch) {
        if (d > TOUCH_SLOP) this.abandon(); // a swipe: the board scrolls
      } else if (d > MOVE_PX) this.start();
      return;
    }
    const g = this.drag;
    if (g && e.pointerId === g.pointerId) {
      e.preventDefault();
      g.x = e.clientX;
      g.y = e.clientY;
    }
  };

  private readonly onUp = (e: PointerEvent): void => {
    if (this.pending && e.pointerId === this.pending.pointerId) {
      this.abandon(); // a click (or a tap): the card opens as before
      return;
    }
    if (this.drag && e.pointerId === this.drag.pointerId) {
      this.drag.x = e.clientX;
      this.drag.y = e.clientY;
      this.finish(true);
    }
  };

  private readonly onCancel = (e: PointerEvent): void => {
    if (this.pending && e.pointerId === this.pending.pointerId) this.abandon();
    else if (this.drag && e.pointerId === this.drag.pointerId) this.finish(false);
  };

  private readonly onKey = (e: KeyboardEvent): void => {
    if (!this.drag || e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    this.swallowUntil = performance.now() + 250;
    this.finish(false);
  };

  /** Forgets a press that did not become a drag. */
  private abandon(): void {
    const p = this.pending;
    if (!p) return;
    this.pending = null;
    if (p.timer !== null) clearTimeout(p.timer);
    if (!this.drag) this.unlisten();
  }

  private unlisten(): void {
    window.removeEventListener('pointermove', this.onMove, true);
    window.removeEventListener('pointerup', this.onUp, true);
    window.removeEventListener('pointercancel', this.onCancel, true);
    window.removeEventListener('keydown', this.onKey, true);
  }

  // ---- the drag ---------------------------------------------------------------------------------------

  private start(): void {
    const p = this.pending;
    if (!p) return;
    this.pending = null;
    if (p.timer !== null) clearTimeout(p.timer);
    const from = p.el.closest<HTMLElement>('.bd-col')?.dataset.col;
    if (from === undefined || !p.el.isConnected || !this.host.canDrag(p.id)) {
      this.unlisten();
      return;
    }
    const r = p.el.getBoundingClientRect();
    const lifted = p.el.cloneNode(true) as HTMLElement;
    for (const a of ['data-key', 'data-id', 'data-drag', 'id', 'onclick']) lifted.removeAttribute(a);
    lifted.classList.add('bd-card--lifted');
    lifted.setAttribute('aria-hidden', 'true');
    lifted.tabIndex = -1;
    lifted.style.width = `${r.width}px`;
    lifted.style.height = `${r.height}px`;
    this.layer.append(lifted);
    p.el.classList.add('bd-card--ghost');
    this.body.classList.add('bd-dragging');
    try {
      this.body.setPointerCapture(p.pointerId);
    } catch {
      // (a pointer that is already gone: its pointerup or cancel ends the drag)
    }
    window.addEventListener('keydown', this.onKey, true);
    if (p.touch) navigator.vibrate?.(8);
    const g: Live = { id: p.id, el: p.el, from, pointerId: p.pointerId, touch: p.touch, ordered: this.host.ordered(p.id), lifted, ox: p.x - r.left, oy: p.y - r.top, x: p.x, y: p.y, slot: null, frame: 0 };
    this.drag = g;
    this.host.live(true);
    this.tick();
  }

  private readonly tick = (): void => {
    const g = this.drag;
    if (!g) return;
    this.scrollEdges(g);
    g.slot = this.slot(g);
    this.show(g);
    g.frame = requestAnimationFrame(this.tick);
  };

  private scrollEdges(g: Live): void {
    const r = this.body.getBoundingClientRect();
    const dx = edgeSpeed(g.x, r.left, r.right);
    const dy = edgeSpeed(g.y, r.top, r.bottom);
    if (dx) this.body.scrollLeft += dx;
    if (dy) this.body.scrollTop += dy;
  }

  /** The columns as they are on screen now (they scroll under the pointer). */
  private columns(): DropColumn[] {
    const bottom = this.body.getBoundingClientRect().bottom;
    return [...this.body.querySelectorAll<HTMLElement>('.bd-col[data-col]')].map((col) => {
      const r = col.getBoundingClientRect();
      return {
        id: col.dataset.col ?? '',
        // A short column still takes a drop anywhere below its cards.
        rect: { left: r.left, top: r.top, right: r.right, bottom: Math.max(r.bottom, bottom) },
        cards: [...col.querySelectorAll<HTMLElement>('.bd-col-cards > .bd-card[data-id]')].map((c) => ({ id: c.dataset.id ?? '', rect: c.getBoundingClientRect() })),
        accepts: col.dataset.drop === 'true',
      };
    });
  }

  private slot(g: Live): Slot | null {
    const b = this.body.getBoundingClientRect();
    if (g.x < b.left || g.x > b.right || g.y < b.top || g.y > b.bottom) return null;
    return slotAt({ x: g.x, y: g.y }, this.columns(), g.id);
  }

  private ids(column: string): string[] {
    const col = this.colEl(column);
    return col ? [...col.querySelectorAll<HTMLElement>('.bd-col-cards > .bd-card[data-id]')].map((c) => c.dataset.id ?? '') : [];
  }

  private colEl(column: string): HTMLElement | null {
    return this.body.querySelector<HTMLElement>(`.bd-col[data-col="${CSS.escape(column)}"]`);
  }

  private show(g: Live): void {
    g.lifted.style.transform = `translate3d(${g.x - g.ox}px, ${g.y - g.oy}px, 0)`;
    const over = g.slot ? this.colEl(g.slot.column) : null;
    for (const c of this.body.querySelectorAll<HTMLElement>('.bd-col[data-over]')) if (c !== over) delete c.dataset.over;
    if (over) over.dataset.over = 'true';
    const s = g.slot;
    if (!s || !over || !g.ordered || samePlace(g.from, this.ids(g.from), g.id, s)) {
      this.line.remove();
      delete this.line.dataset.column;
      return;
    }
    const list = over.querySelector<HTMLElement>('.bd-col-cards');
    if (!list) return;
    const box = list.getBoundingClientRect();
    const rects = [...list.querySelectorAll<HTMLElement>(':scope > .bd-card[data-id]')].filter((c) => c.dataset.id !== g.id).map((c) => c.getBoundingClientRect());
    const gap = parseFloat(getComputedStyle(list).rowGap) || 10;
    const before = rects[s.index - 1];
    const next = rects[s.index];
    const y = before && next ? (before.bottom + next.top) / 2 : next ? next.top - gap / 2 : before ? before.bottom + gap / 2 : box.top;
    // Over the note in the hand (the slot is usually under it), across the column's cards.
    if (!this.line.isConnected) this.layer.append(this.line);
    if (this.line.dataset.column !== s.column) {
      this.line.dataset.column = s.column;
      this.line.style.transition = 'none'; // a new column: no glide in from the old one
      this.line.style.top = `${y}px`;
      void this.line.offsetTop;
      this.line.style.transition = '';
    }
    this.line.style.left = `${box.left}px`;
    this.line.style.width = `${box.width}px`;
    this.line.style.top = `${y}px`;
    this.line.dataset.slot = String(s.index);
  }

  /** Ends the drag: a drop that changes something goes to the host, everything else changes nothing. */
  private finish(drop: boolean): void {
    const g = this.drag;
    if (!g) return;
    cancelAnimationFrame(g.frame);
    const slot = drop ? this.slot(g) : null;
    const target = slot ? this.ids(slot.column) : [];
    const same = slot ? samePlace(g.from, this.ids(g.from), g.id, slot) : true;
    this.drag = null;
    this.unlisten();
    try {
      if (this.body.hasPointerCapture(g.pointerId)) this.body.releasePointerCapture(g.pointerId);
    } catch {
      // (gone already)
    }
    g.lifted.remove();
    this.line.remove();
    delete this.line.dataset.column;
    g.el.classList.remove('bd-card--ghost');
    this.body.classList.remove('bd-dragging');
    for (const c of this.body.querySelectorAll<HTMLElement>('.bd-col[data-over]')) delete c.dataset.over;
    // The click the release makes is the drag's.
    const swallow = (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      window.removeEventListener('click', swallow, true);
    };
    window.addEventListener('click', swallow, true);
    window.setTimeout(() => window.removeEventListener('click', swallow, true), g.touch ? CLICK_AFTER_MS : 0);
    if (slot && !same) this.host.drop(g.id, slot.column, g.ordered ? afterFor(target, slot.index, g.id) : undefined);
    this.host.live(false);
  }
}
