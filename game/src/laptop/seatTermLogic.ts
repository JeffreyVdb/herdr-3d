import type { ITheme } from '@xterm/xterm';
import { openable } from '../ui/boards/external';
import { clampZoom, type ThemePreset } from '../ui/themes';
import type { ScreenTheme } from './paint';

/**
 * #176: the pure rules of the seated terminal (`seatTerm.ts` mounts the widget): the grid it asks herdr for, how a
 * wheel becomes history lines, which links open, its font size and colours. Tested without a DOM.
 */

/** The PTY sizes the bridge takes (docs/protocol.md "terminal.resize"); a smaller area is clipped, never sent. */
export const GRID = { minCols: 40, maxCols: 300, minRows: 10, maxRows: 100 } as const;

/** A fitted grid within the bridge's bounds. */
export function clampGrid(cols: number, rows: number): { cols: number; rows: number } {
  const c = Number.isFinite(cols) ? Math.floor(cols) : GRID.minCols;
  const r = Number.isFinite(rows) ? Math.floor(rows) : GRID.minRows;
  return { cols: Math.min(GRID.maxCols, Math.max(GRID.minCols, c)), rows: Math.min(GRID.maxRows, Math.max(GRID.minRows, r)) };
}

/** How long a size has to hold before it goes to the PTY (a window drag resizes the PTY once, at its end). */
export const RESIZE_DEBOUNCE_MS = 120;

/** How often wheel lines go to the bridge at most (the rest is summed up meanwhile). */
export const WHEEL_FLUSH_MS = 60;

/**
 * A wheel's movement as whole lines of history (positive: up, into the past), the fraction carried over. A
 * trackpad's pixels count by the cell's height; a mouse's lines and pages as they are.
 */
export class WheelLines {
  private acc = 0;

  /** Adds one wheel event; returns the whole lines it completes (0 for none yet). */
  add(deltaY: number, deltaMode: number, cellHeight: number, rows: number): number {
    if (!Number.isFinite(deltaY) || deltaY === 0) return 0;
    const lines = deltaMode === 1 ? deltaY : deltaMode === 2 ? deltaY * Math.max(1, rows) : deltaY / Math.max(1, cellHeight);
    this.acc -= lines; // wheel up (negative deltaY) goes up the history
    const whole = this.acc > 0 ? Math.floor(this.acc) : Math.ceil(this.acc);
    this.acc -= whole;
    return whole;
  }

  reset(): void {
    this.acc = 0;
  }
}

/** Herdr's modifier bits for a wheel over the pane (Shift 1, Ctrl 2, Alt 4). */
export function wheelModifiers(e: { shiftKey: boolean; ctrlKey: boolean; altKey: boolean }): number {
  return (e.shiftKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.altKey ? 4 : 0);
}

/**
 * A link in the terminal (a plain URL or an OSC 8 hyperlink) opens with Ctrl+click (⌘+click on a Mac), as in
 * xterm-based terminals: a plain click or drag is for selecting text. Only https URLs open, through the app's opener.
 */
export function linkOpens(e: { ctrlKey: boolean; metaKey: boolean; button?: number }, mac: boolean, url: string): boolean {
  if (e.button !== undefined && e.button !== 0) return false;
  return (mac ? e.metaKey : e.ctrlKey) && openable(url);
}

/** The words of a link's tooltip, by platform. */
export function linkHint(url: string, mac: boolean): string {
  return openable(url) ? `${mac ? '⌘' : 'Ctrl'}+click to open ${url}` : `Only https links open from here: ${url}`;
}

/** The seated terminal's font size at 100% for a preset: its mono size a fifth larger (the transcript's is for prose beside code). */
export function terminalPx(t: Pick<ThemePreset, 'mono'>, zoom: number): number {
  return Math.round(t.mono.size * 1.2 * (clampZoom(zoom) / 100) * 2) / 2;
}

const hex = (c: number) => `#${(c & 0xffffff).toString(16).padStart(6, '0')}`;
const ANSI = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'] as const;

/** The preset's screen colours as xterm's theme (the selection keeps its colour when the keyboard is elsewhere). */
export function xtermTheme(t: ScreenTheme): ITheme {
  const theme: ITheme = {
    background: hex(t.bg),
    foreground: hex(t.fg),
    cursor: hex(t.cursor),
    cursorAccent: hex(t.bg),
    selectionBackground: `${hex(t.cursor)}66`,
    selectionInactiveBackground: `${hex(t.cursor)}55`,
  };
  const out = theme as Record<string, string>;
  ANSI.forEach((name, i) => {
    out[name] = hex(t.ansi[i] ?? t.fg);
    out[`bright${name[0]?.toUpperCase()}${name.slice(1)}`] = hex(t.ansi[i + 8] ?? t.fg);
  });
  return theme;
}

/** Calls `fn` once `ms` after the last `call` (a window drag ends); `flush` runs a pending one now. */
export class Debounce {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pending: (() => void) | null = null;

  constructor(private readonly ms: number) {}

  call(fn: () => void): void {
    this.pending = fn;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), this.ms);
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const fn = this.pending;
    this.pending = null;
    fn?.();
  }

  cancel(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pending = null;
  }
}
