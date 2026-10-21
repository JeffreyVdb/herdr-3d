// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HistoryBar, keyOffset, MIN_THUMB_PX, offsetAt, SCROLL_FLUSH_MS, scrollChunks, SETTLE_MS, thumbSize, thumbTop } from './seatScrollbar';

describe('#176 part 2: the history scrollbar’s math', () => {
  it('the thumb is the share on screen, never under its minimum, the whole rail without history', () => {
    expect(thumbSize({ offset: 0, max: 70, rows: 30 }, 400)).toBe(120);
    expect(thumbSize({ offset: 0, max: 100000, rows: 30 }, 400)).toBe(MIN_THUMB_PX);
    expect(thumbSize({ offset: 0, max: 0, rows: 30 }, 400)).toBe(400);
    expect(thumbSize({ offset: 0, max: 70, rows: 30 }, 10)).toBe(10);
    expect(thumbSize({ offset: 0, max: 70, rows: 30 }, 0)).toBe(0);
  });
  it('the live bottom is the rail’s bottom, the oldest line its top; a drag gives back the offset', () => {
    expect(thumbTop(0, 70, 400, 120)).toBe(280);
    expect(thumbTop(70, 70, 400, 120)).toBe(0);
    expect(thumbTop(35, 70, 400, 120)).toBe(140);
    expect(thumbTop(500, 70, 400, 120)).toBe(0); // clamped
    for (const off of [0, 1, 17, 35, 69, 70]) expect(offsetAt(thumbTop(off, 70, 400, 120), 70, 400, 120)).toBe(off);
    expect(offsetAt(-50, 70, 400, 120)).toBe(70);
    expect(offsetAt(1000, 70, 400, 120)).toBe(0);
    expect(offsetAt(10, 0, 400, 400)).toBe(0);
  });
  it('its keys: a screen less a line, a line, the top (Home) and live (End), within the history', () => {
    const h = { offset: 10, max: 100, rows: 30 };
    expect(keyOffset('PageUp', h)).toBe(39);
    expect(keyOffset('PageDown', h)).toBe(0);
    expect(keyOffset('PageUp', { ...h, offset: 90 })).toBe(100);
    expect(keyOffset('ArrowUp', h)).toBe(11);
    expect(keyOffset('ArrowDown', h)).toBe(9);
    expect(keyOffset('Home', h)).toBe(100);
    expect(keyOffset('End', h)).toBe(0);
    expect(keyOffset('a', h)).toBeNull();
  });
  it('lines go in commands of at most 1000', () => {
    expect(scrollChunks(0)).toEqual([]);
    expect(scrollChunks(5)).toEqual([5]);
    expect(scrollChunks(-2500)).toEqual([-1000, -1000, -500]);
  });
});

describe('#176 part 2: the history scrollbar', () => {
  afterEach(() => vi.useRealTimers());

  function make() {
    vi.useFakeTimers();
    let now = 0;
    const sent: Array<number | 'bottom'> = [];
    const term = document.createElement('div');
    const bar = new HistoryBar(term, { scroll: (n) => sent.push(n), bottom: () => sent.push('bottom'), now: () => now });
    document.body.append(term, bar.el);
    Object.defineProperty(bar.el, 'clientHeight', { value: 400 });
    bar.el.getBoundingClientRect = () => ({ top: 0, left: 0, right: 10, bottom: 400, width: 10, height: 400, x: 0, y: 0, toJSON: () => ({}) });
    return { bar, term, sent, tick: (ms: number) => ((now += ms), vi.advanceTimersByTime(ms)) };
  }

  it('is a keyboard scrollbar of the terminal, hidden without history', () => {
    const { bar, term } = make();
    expect(bar.el.hidden).toBe(true);
    bar.update({ offset: 0, max: 0, rows: 30 });
    expect(bar.el.hidden).toBe(true);
    bar.update({ offset: 20, max: 70, rows: 30 });
    expect(bar.el.hidden).toBe(false);
    expect(bar.el.getAttribute('role')).toBe('scrollbar');
    expect(bar.el.getAttribute('aria-controls')).toBe(term.id);
    expect(bar.el.tabIndex).toBe(0);
    expect([bar.el.getAttribute('aria-valuemin'), bar.el.getAttribute('aria-valuemax'), bar.el.getAttribute('aria-valuenow')]).toEqual(['0', '70', '50']);
    expect(bar.el.getAttribute('aria-valuetext')).toBe('20 lines up of 70');
    bar.update(null);
    expect(bar.el.hidden).toBe(true);
  });

  it('its keys move the view by wheel lines (coalesced); End is the live bottom; they are not the pane’s', () => {
    const { bar, sent, tick } = make();
    bar.update({ offset: 0, max: 100, rows: 30 });
    const key = (k: string) => {
      const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true });
      const reached = vi.fn();
      window.addEventListener('keydown', reached);
      bar.el.dispatchEvent(e);
      window.removeEventListener('keydown', reached);
      return { prevented: e.defaultPrevented, reached: reached.mock.calls.length };
    };
    expect(key('PageUp')).toEqual({ prevented: true, reached: 0 });
    key('ArrowUp');
    expect(sent).toEqual([]);
    tick(SCROLL_FLUSH_MS);
    expect(sent).toEqual([30]);
    expect(bar.shown).toEqual({ offset: 30, max: 100 });
    key('Home');
    tick(SCROLL_FLUSH_MS);
    expect(sent).toEqual([30, 70]);
    key('End');
    expect(sent).toEqual([30, 70, 'bottom']);
    expect(key('a')).toEqual({ prevented: false, reached: 1 }); // a letter still goes to the terminal
  });

  it('follows the bridge, but not while its own move is on its way', () => {
    const { bar, tick } = make();
    bar.update({ offset: 10, max: 100, rows: 30 });
    expect(bar.shown?.offset).toBe(10);
    bar.el.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageUp', bubbles: true }));
    bar.update({ offset: 10, max: 100, rows: 30 }); // an old reading
    expect(bar.shown?.offset).toBe(39);
    tick(SETTLE_MS);
    bar.update({ offset: 45, max: 106, rows: 30 }); // new output while up there: further up
    expect(bar.shown).toEqual({ offset: 45, max: 106 });
    // A reading during a move of its own is taken once that settled, without another reading.
    bar.el.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageDown', bubbles: true }));
    bar.update({ offset: 50, max: 109, rows: 30 });
    expect(bar.shown?.offset).toBe(16);
    tick(SETTLE_MS + SCROLL_FLUSH_MS);
    expect(bar.shown).toEqual({ offset: 50, max: 109 });
  });

  it('a drag of the thumb sends the lines it moved; the track pages; the focus stays where it was', () => {
    const { bar, sent, tick } = make();
    const keyboard = document.createElement('textarea');
    document.body.append(keyboard);
    keyboard.focus();
    bar.update({ offset: 0, max: 70, rows: 30 }); // thumb 120 px at 280
    const ptr = (type: string, y: number) => {
      const e = new MouseEvent(type, { clientY: y, button: 0, bubbles: true, cancelable: true }) as MouseEvent & { pointerId: number };
      Object.defineProperty(e, 'pointerId', { value: 1 });
      bar.el.dispatchEvent(e);
      return e;
    };
    expect(ptr('pointerdown', 300).defaultPrevented).toBe(true);
    ptr('pointermove', 160); // 140 px up: half the room
    ptr('pointerup', 160);
    tick(SCROLL_FLUSH_MS);
    expect(sent).toEqual([35]);
    expect(document.activeElement).toBe(keyboard);
    ptr('pointerdown', 20); // above the thumb: a page up
    tick(SCROLL_FLUSH_MS);
    expect(sent).toEqual([35, 29]);
    expect(bar.shown?.offset).toBe(64);
  });
});
