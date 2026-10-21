import { WheelLines } from '../laptop/seatTermLogic';

/**
 * #176 part 2: the seated terminal's history scrollbar, a slim rail at its right edge bound to herdr's history
 * (`terminal.history`: `offset` lines above the live bottom, at most `max`, `rows` shown). The thumb is the share of
 * the history on screen; 0 (the live bottom) is the rail's bottom. Herdr has no "go to line": dragging and the track
 * send wheel lines (`scroll`, coalesced like the wheel), the live bottom is `bottom`. Its own keys (PageUp/PageDown,
 * Home: the top of the history, End: live, the arrows a line) while it has the focus; a press never takes the focus
 * from the seat's keyboard. Hidden while there is no history.
 */

/** The thumb's smallest height in CSS px (a long history still has something to grab). */
export const MIN_THUMB_PX = 24;
/** How often the lines dragged or paged go to the bridge at most (as the wheel's). */
export const SCROLL_FLUSH_MS = 60;
/** How long after a local move the bridge's readings (which lag it) do not move the thumb back. */
export const SETTLE_MS = 700;
/** herdr's most lines in one scroll. */
const MAX_LINES = 1000;

export interface History {
  offset: number;
  max: number;
  rows: number;
}

/** The thumb's height in px for a track of `track` px: the rows on screen out of the history and them. */
export function thumbSize(h: History, track: number): number {
  if (track <= 0) return 0;
  const share = h.max > 0 ? Math.max(1, h.rows) / (h.max + Math.max(1, h.rows)) : 1;
  return Math.min(track, Math.max(Math.min(MIN_THUMB_PX, track), track * share));
}

/** The thumb's top in px: at the bottom for the live screen (offset 0), at the top for the oldest line (offset max). */
export function thumbTop(offset: number, max: number, track: number, size: number): number {
  if (max <= 0) return Math.max(0, track - size);
  const at = Math.min(max, Math.max(0, offset));
  return (track - size) * (1 - at / max);
}

/** The offset a thumb dragged to `top` px shows (the inverse of `thumbTop`, whole lines). */
export function offsetAt(top: number, max: number, track: number, size: number): number {
  const room = track - size;
  if (max <= 0 || room <= 0) return 0;
  return Math.round(max * (1 - Math.min(room, Math.max(0, top)) / room));
}

/** Where a key moves the view (null: not the scrollbar's key). PageUp/PageDown a screen less a line, Home the top. */
export function keyOffset(key: string, h: History): number | null {
  const page = Math.max(1, h.rows - 1);
  const to = (n: number) => Math.min(h.max, Math.max(0, n));
  switch (key) {
    case 'PageUp':
      return to(h.offset + page);
    case 'PageDown':
      return to(h.offset - page);
    case 'ArrowUp':
      return to(h.offset + 1);
    case 'ArrowDown':
      return to(h.offset - 1);
    case 'Home':
      return h.max;
    case 'End':
      return 0;
  }
  return null;
}

/** Wheel lines in commands herdr takes: at most 1000 a command, the sign kept (positive: up). */
export function scrollChunks(lines: number): number[] {
  const out: number[] = [];
  let left = Math.round(lines);
  while (left !== 0) {
    const n = Math.sign(left) * Math.min(MAX_LINES, Math.abs(left));
    out.push(n);
    left -= n;
  }
  return out;
}

export interface HistoryBarDeps {
  /** Wheel lines over the terminal (positive: up the history). */
  scroll(lines: number): void;
  /** Back to the live bottom. */
  bottom(): void;
  now?(): number;
}

export class HistoryBar {
  readonly el = document.createElement('div');
  private readonly thumb = document.createElement('div');
  private h: History | null = null;
  /** The offset the thumb shows: the bridge's, or where a drag or a key put it until the bridge catches up. */
  private view = 0;
  private pending = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private quietUntil = 0;
  private drag: { y: number; top: number; pointer: number } | null = null;
  private readonly wheel = new WheelLines();

  constructor(
    controls: HTMLElement,
    private readonly deps: HistoryBarDeps,
  ) {
    this.el.className = 'seat-scroll';
    this.thumb.className = 'seat-scroll-thumb';
    this.el.append(this.thumb);
    this.el.hidden = true;
    this.el.tabIndex = 0;
    this.el.setAttribute('role', 'scrollbar');
    this.el.setAttribute('aria-orientation', 'vertical');
    this.el.setAttribute('aria-label', 'Terminal history');
    if (!controls.id) controls.id = 'seat-term';
    this.el.setAttribute('aria-controls', controls.id);
    this.el.setAttribute('aria-valuemin', '0');
    this.el.title = 'The terminal’s history: drag, or PageUp, PageDown, Home and End while it has the focus';
    this.el.addEventListener('pointerdown', this.onDown);
    this.el.addEventListener('pointermove', this.onMove);
    this.el.addEventListener('pointerup', this.onUp);
    this.el.addEventListener('pointercancel', this.onUp);
    this.el.addEventListener('keydown', this.onKey);
    this.el.addEventListener('wheel', this.onWheel, { passive: false });
    // The rail's height follows the window: the thumb is placed again.
    this.resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => this.render());
    this.resize?.observe(this.el);
  }

  private readonly resize: ResizeObserver | null;

  private now(): number {
    return this.deps.now?.() ?? performance.now();
  }

  /** The bridge's reading (null: no history to show, as while read only). */
  update(h: History | null): void {
    this.h = h && h.max > 0 ? { ...h } : null;
    if (!this.h) {
      this.cancel();
      this.view = 0;
    } else if (!this.drag && !this.pending && this.now() >= this.quietUntil) this.view = Math.min(this.h.max, this.h.offset);
    this.render();
  }

  /** Where the thumb shows the view (tests). */
  get shown(): { offset: number; max: number } | null {
    return this.h ? { offset: this.view, max: this.h.max } : null;
  }

  private track(): number {
    return this.el.clientHeight;
  }

  private render(): void {
    const h = this.h;
    this.el.hidden = !h;
    if (!h) return;
    const track = this.track();
    const size = thumbSize(h, track);
    this.thumb.style.height = `${size}px`;
    this.thumb.style.transform = `translateY(${thumbTop(this.view, h.max, track, size)}px)`;
    // From the top, as a scrollbar's value is: the oldest line is 0, the live bottom is max.
    this.el.setAttribute('aria-valuemax', String(h.max));
    this.el.setAttribute('aria-valuenow', String(h.max - this.view));
    this.el.setAttribute('aria-valuetext', this.view > 0 ? `${this.view} ${this.view === 1 ? 'line' : 'lines'} up of ${h.max}` : 'Live');
    this.el.toggleAttribute('data-dragging', !!this.drag);
  }

  /** The view to `to` lines above the live bottom: the difference goes as wheel lines, the live bottom as itself. */
  private moveTo(to: number): void {
    const h = this.h;
    if (!h) return;
    const target = Math.min(h.max, Math.max(0, Math.round(to)));
    this.quietUntil = this.now() + SETTLE_MS;
    if (target === this.view) return;
    if (target === 0) {
      this.cancel();
      this.view = 0;
      this.render();
      this.deps.bottom();
      return;
    }
    this.pending += target - this.view;
    this.view = target;
    this.render();
    this.timer ??= setTimeout(() => this.flush(), SCROLL_FLUSH_MS);
  }

  private flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const lines = this.pending;
    this.pending = 0;
    for (const n of scrollChunks(lines)) this.deps.scroll(n);
  }

  private cancel(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pending = 0;
  }

  private readonly onDown = (e: PointerEvent) => {
    const h = this.h;
    if (!h || e.button !== 0) return;
    // The seat's keyboard keeps the focus (typing goes on); a keyboard user reaches the rail with Tab.
    e.preventDefault();
    const track = this.track();
    const size = thumbSize(h, track);
    const top = thumbTop(this.view, h.max, track, size);
    const y = e.clientY - this.el.getBoundingClientRect().top;
    if (y >= top && y <= top + size) {
      this.drag = { y: e.clientY, top, pointer: e.pointerId };
      this.el.setPointerCapture?.(e.pointerId);
      this.render();
      return;
    }
    // The track pages towards the press.
    const page = Math.max(1, h.rows - 1);
    this.moveTo(this.view + (y < top ? page : -page));
  };

  private readonly onMove = (e: PointerEvent) => {
    const d = this.drag;
    const h = this.h;
    if (!d || !h || e.pointerId !== d.pointer) return;
    const track = this.track();
    this.moveTo(offsetAt(d.top + (e.clientY - d.y), h.max, track, thumbSize(h, track)));
  };

  private readonly onUp = (e: PointerEvent) => {
    if (!this.drag || e.pointerId !== this.drag.pointer) return;
    this.drag = null;
    this.quietUntil = this.now() + SETTLE_MS;
    this.render();
  };

  private readonly onKey = (e: KeyboardEvent) => {
    const h = this.h;
    if (!h || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
    const to = keyOffset(e.key, { ...h, offset: this.view });
    if (to === null) return;
    // Its own: not the pane's (the seat's window listener would send PageUp to the terminal).
    e.preventDefault();
    e.stopPropagation();
    this.moveTo(to);
  };

  private readonly onWheel = (e: WheelEvent) => {
    if (!this.h || e.ctrlKey || e.metaKey) return;
    e.preventDefault();
    const lines = this.wheel.add(e.deltaY, e.deltaMode, 16, this.h.rows);
    if (lines) this.moveTo(this.view + lines);
  };

  dispose(): void {
    this.cancel();
    this.resize?.disconnect();
  }
}
