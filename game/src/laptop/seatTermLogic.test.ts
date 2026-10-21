import { describe, expect, it, vi } from 'vitest';
import { cellAt, clampGrid, CLICK_SLOP_PX, Debounce, GRID, isClick, linkHint, linkOpens, terminalPx, WheelLines, wheelModifiers, xtermTheme } from './seatTermLogic';
import { SCREEN_THEME } from './paint';

describe('the seated terminal’s rules (#176)', () => {
  it('a fitted grid stays within the bridge’s bounds: a smaller area is clipped, never sent smaller', () => {
    expect(clampGrid(150.9, 41.2)).toEqual({ cols: 150, rows: 41 });
    expect(clampGrid(12, 3)).toEqual({ cols: GRID.minCols, rows: GRID.minRows });
    expect(clampGrid(999, 999)).toEqual({ cols: GRID.maxCols, rows: GRID.maxRows });
    expect(clampGrid(Number.NaN, Number.POSITIVE_INFINITY)).toEqual({ cols: 40, rows: 10 });
  });

  it('a wheel becomes whole history lines (up positive), the rest carried over', () => {
    const w = new WheelLines();
    expect(w.add(-10, 0, 20, 40)).toBe(0); // half a line of trackpad
    expect(w.add(-10, 0, 20, 40)).toBe(1);
    expect(w.add(-3, 1, 20, 40)).toBe(3); // a mouse's lines
    expect(w.add(1, 2, 20, 40)).toBe(-40); // a page down
    expect(w.add(30, 0, 20, 40)).toBe(-1);
    expect(w.add(10, 0, 20, 40)).toBe(-1);
    expect(w.add(0, 0, 20, 40)).toBe(0);
    w.reset();
    expect(w.add(-15, 0, 20, 40)).toBe(0);
  });

  it('modifier bits as herdr takes them', () => {
    expect(wheelModifiers({ shiftKey: true, ctrlKey: false, altKey: true })).toBe(5);
    expect(wheelModifiers({ shiftKey: false, ctrlKey: true, altKey: false })).toBe(2);
  });

  it('links open with Ctrl+click (⌘ on a Mac), https only', () => {
    const https = 'https://example.com/x';
    expect(linkOpens({ ctrlKey: true, metaKey: false, button: 0 }, false, https)).toBe(true);
    expect(linkOpens({ ctrlKey: false, metaKey: false, button: 0 }, false, https)).toBe(false); // a plain click selects
    expect(linkOpens({ ctrlKey: true, metaKey: false, button: 2 }, false, https)).toBe(false);
    expect(linkOpens({ ctrlKey: false, metaKey: true }, true, https)).toBe(true);
    expect(linkOpens({ ctrlKey: true, metaKey: false }, true, https)).toBe(false); // Ctrl+click on a Mac is the menu
    for (const bad of ['http://example.com', 'javascript:alert(1)', 'file:///etc/passwd', 'not a url', 'ssh://host']) {
      expect(linkOpens({ ctrlKey: true, metaKey: true }, false, bad), bad).toBe(false);
    }
    expect(linkHint(https, false)).toBe('Ctrl+click to open https://example.com/x');
    expect(linkHint(https, true)).toBe('⌘+click to open https://example.com/x');
    expect(linkHint('http://x', false)).toMatch(/^Only https links open/);
  });

  it('a fixed font size: the preset’s mono a fifth larger, times the zoom', () => {
    expect(terminalPx({ mono: { size: 11.5 } } as never, 100)).toBe(14);
    expect(terminalPx({ mono: { size: 11.5 } } as never, 150)).toBe(20.5);
    expect(terminalPx({ mono: { size: 14 } } as never, 100)).toBe(17);
  });

  it('the preset’s colours as xterm’s theme, the selection visible without the keyboard', () => {
    const t = xtermTheme(SCREEN_THEME);
    expect(t).toMatchObject({ background: '#10162a', foreground: '#dde4f3', cursor: '#ffc233', red: '#ff6b5e', brightWhite: '#ffffff' });
    expect(t.selectionInactiveBackground).toBeTruthy();
  });

  it('debounces to the last call; flush and cancel', () => {
    vi.useFakeTimers();
    const calls: number[] = [];
    const d = new Debounce(120);
    d.call(() => calls.push(1));
    d.call(() => calls.push(2));
    vi.advanceTimersByTime(119);
    expect(calls).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(calls).toEqual([2]);
    d.call(() => calls.push(3));
    d.flush();
    expect(calls).toEqual([2, 3]);
    d.call(() => calls.push(4));
    d.cancel();
    vi.advanceTimersByTime(500);
    expect(calls).toEqual([2, 3]);
    vi.useRealTimers();
  });
});

describe('#176 part 2: clicks', () => {
  const cell = { width: 8, height: 16 };
  const screen = { left: 100, top: 50 };
  it('the cell under a point, 0-based, none off the grid', () => {
    expect(cellAt(100, 50, screen, cell, 80, 24)).toEqual({ column: 0, row: 0 });
    expect(cellAt(147.9, 85, screen, cell, 80, 24)).toEqual({ column: 5, row: 2 });
    expect(cellAt(100 + 80 * 8 - 0.1, 50 + 24 * 16 - 0.1, screen, cell, 80, 24)).toEqual({ column: 79, row: 23 });
    for (const [x, y] of [[99, 60], [100 + 80 * 8, 60], [120, 49], [120, 50 + 24 * 16]] as const) expect(cellAt(x, y, screen, cell, 80, 24)).toBeNull();
    expect(cellAt(120, 60, screen, { width: 0, height: 16 }, 80, 24)).toBeNull();
  });
  it('a click is a press and release on one cell, a few px apart, that selected nothing and opened no link', () => {
    const down = { x: 10, y: 10, column: 1, row: 0 };
    expect(isClick(down, { x: 12, y: 13, column: 1, row: 0 }, false, false)).toBe(true);
    expect(isClick(down, { x: 10 + CLICK_SLOP_PX + 1, y: 10, column: 1, row: 0 }, false, false)).toBe(false); // a drag
    expect(isClick(down, { x: 11, y: 10, column: 2, row: 0 }, false, false)).toBe(false); // the next cell
    expect(isClick(down, { x: 10, y: 10, column: 1, row: 0 }, true, false)).toBe(false); // a selection (a double click's word)
    expect(isClick(down, { x: 10, y: 10, column: 1, row: 0 }, false, true)).toBe(false); // Ctrl/⌘+click opened a link
    expect(isClick(down, null, false, false)).toBe(false); // released off the grid
  });
});
