import { Terminal, type IDisposable } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import type { TerminalFrame } from '../net/protocol';
import type { ScreenTheme } from './paint';
import { clampGrid, Debounce, linkHint, linkOpens, RESIZE_DEBOUNCE_MS, WheelLines, WHEEL_FLUSH_MS, wheelModifiers, xtermTheme } from './seatTermLogic';
import { decodeFrame } from './terminal';

/** A grid the seated terminal fits in its area: the PTY's size, and a cell's size in CSS px. */
export interface SeatGrid {
  cols: number;
  rows: number;
  cell: { width: number; height: number };
}

export interface SeatTermDeps {
  /** The area fits another grid (after the window, the layout, the font or the DPR changed; debounced). */
  grid(g: SeatGrid): void;
  /** A wheel over the terminal: `lines` (positive: up the history) at a cell with herdr's modifier bits. */
  wheel(lines: number, column: number, row: number, modifiers: number): void;
  /** A link was activated (Ctrl/⌘+click on an https URL): the app's validated opener takes it. */
  open(url: string): void;
  /** A paste that landed on the widget itself: it goes the seat's way (secrets review, image paste, lanes). */
  paste(text: string, files: File[]): void;
  /** The widget would take the keyboard (a click): the seat's own keyboard keeps it (IME, paste, the lanes). */
  keyboard(): void;
  mac: boolean;
}

/**
 * #176: the seated laptop's terminal, a real xterm.js 6 widget opened in the workspace (the distant monitors keep the
 * canvas textures of `terminal.ts`). It shows what the bridge sends (a full frame is RIS + the frame: no local history,
 * `scrollback: 0`; herdr owns the history), at a fixed font size, and fits its area: the grid it fits goes to the
 * bridge, which resizes the real PTY, and herdr's next full frame is at that size. It never types: `disableStdin`, no
 * `onData`, the parser's replies swallowed, every key the seat's (`Laptops.key`). Selection is the widget's own; links
 * (plain URLs, soft-wrapped ones too, and OSC 8) open through the app's opener on Ctrl/⌘+click; the wheel goes to
 * herdr's history.
 */
export class SeatTerminal {
  private term: Terminal | null = null;
  private fit: FitAddon | null = null;
  private readonly offs: IDisposable[] = [];
  private observer: ResizeObserver | null = null;
  private dpr: MediaQueryList | null = null;
  private readonly onDpr = () => this.refit(true);
  private readonly debounce = new Debounce(RESIZE_DEBOUNCE_MS);
  private readonly wheelLines = new WheelLines();
  private wheelAt: { lines: number; column: number; row: number; mods: number } | null = null;
  private wheelTimer: ReturnType<typeof setTimeout> | null = null;
  private font = 'monospace';
  private px = 14;
  private theme: ScreenTheme | null = null;
  private proposed: SeatGrid | null = null;
  private mounting: Promise<void> | null = null;
  /** Fits its area (the seat owns the pane) or shows the pane at its own size (read only). */
  private fitting = true;
  /** Frames written (tests). */
  frames = 0;

  constructor(
    readonly host: HTMLElement,
    private readonly deps: SeatTermDeps,
  ) {}

  /** The grid the area fits now (null before it was measured). */
  get grid(): SeatGrid | null {
    return this.proposed;
  }

  get opened(): boolean {
    return !!this.term;
  }

  get cols(): number {
    return this.term?.cols ?? 0;
  }

  get rows(): number {
    return this.term?.rows ?? 0;
  }

  /** The font as it is now: its size in CSS px, its stack. */
  get fontInfo(): { px: number; family: string } {
    return { px: this.px, family: this.font };
  }

  /**
   * Opens the widget once the workspace shows (it measures the DOM), after the preset's font has loaded (xterm
   * measures its cell once, on open and on a font change). Safe to call again.
   */
  mount(): Promise<void> {
    this.mounting ??= this.open();
    return this.mounting;
  }

  private async open(): Promise<void> {
    try {
      await document.fonts?.load(`${this.px}px ${this.font}`);
    } catch {
      // A font that cannot load: the stack's fallbacks draw.
    }
    const term = new Terminal({
      scrollback: 0,
      cols: 80,
      rows: 24,
      fontFamily: this.font,
      fontSize: this.px,
      lineHeight: 1,
      cursorBlink: false,
      disableStdin: true,
      altClickMovesCursor: false,
      macOptionClickForcesSelection: true,
      rightClickSelectsWord: false,
      allowProposedApi: true, // the unicode API (Unicode 11 widths, as herdr's grid)
      ...(this.theme ? { theme: xtermTheme(this.theme) } : {}),
      linkHandler: {
        activate: (e, uri) => this.activate(e, uri),
        hover: (_e, uri) => (this.host.title = linkHint(uri, this.deps.mac)),
        leave: () => (this.host.title = ''),
        allowNonHttpProtocols: false,
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon((e, uri) => this.activate(e, uri), { hover: (_e, uri) => (this.host.title = linkHint(uri, this.deps.mac)), leave: () => (this.host.title = '') }));
    term.loadAddon(new Unicode11Addon());
    term.unicode.activeVersion = '11';
    // Replies the parser would make (to a frame's query bytes) never become input: swallowed where they start.
    const swallow = () => true;
    const p = term.parser;
    this.offs.push(
      p.registerCsiHandler({ final: 'c' }, swallow),
      p.registerCsiHandler({ prefix: '>', final: 'c' }, swallow),
      p.registerCsiHandler({ prefix: '=', final: 'c' }, swallow),
      p.registerCsiHandler({ final: 'n' }, swallow),
      p.registerCsiHandler({ prefix: '?', final: 'n' }, swallow),
      p.registerCsiHandler({ intermediates: '$', final: 'p' }, swallow),
      p.registerCsiHandler({ prefix: '?', intermediates: '$', final: 'p' }, swallow),
      p.registerCsiHandler({ final: 't' }, swallow),
      p.registerDcsHandler({ intermediates: '$', final: 'q' }, swallow),
      ...[4, 10, 11, 12].map((ident) => p.registerOscHandler(ident, (data) => data.includes('?'))),
    );
    // Every key is the seat's (Esc, the lanes, IME through the seat's keyboard): the widget takes none.
    term.attachCustomKeyEventHandler(() => false);
    term.attachCustomWheelEventHandler((e) => this.onWheel(e));
    this.term = term;
    this.fit = fit;
    term.open(this.host);
    // The widget's own textarea never keeps the keyboard: the seat's does (one owner of focus and IME).
    term.textarea?.addEventListener('focus', () => this.deps.keyboard());
    this.host.addEventListener('paste', this.onPaste, { capture: true });
    // xterm knows its cell size only once it has rendered: a fit that found none is tried again then.
    this.offs.push(term.onRender(() => {
      if (!this.proposed && this.fitting) this.refit(true);
    }));
    this.observer = new ResizeObserver(() => this.refit());
    this.observer.observe(this.host);
    this.watchDpr();
    this.refit(true);
  }

  /** #176: a link's activation: Ctrl/⌘+click and https only, through the app's opener (never window.open, no confirm). */
  private activate(e: MouseEvent, uri: string): void {
    if (linkOpens(e, this.deps.mac, uri)) this.deps.open(uri);
  }

  private readonly onPaste = (e: ClipboardEvent) => {
    // Before xterm's own listener (bubble phase), which would turn it into input.
    e.preventDefault();
    e.stopPropagation();
    const files = [...(e.clipboardData?.files ?? [])];
    this.deps.paste(e.clipboardData?.getData('text/plain') ?? '', files);
  };

  private onWheel(e: WheelEvent): boolean {
    // Ctrl+wheel zooms the text (the seat's window listener); the rest is herdr's history.
    if (e.ctrlKey || e.metaKey) return false;
    if (e.cancelable) e.preventDefault();
    const cell = this.cell();
    const lines = this.wheelLines.add(e.deltaY, e.deltaMode, cell.height, this.rows);
    if (!lines) return false;
    const rect = this.term?.element?.getBoundingClientRect();
    const column = rect ? Math.max(0, Math.min(this.cols - 1, Math.floor((e.clientX - rect.left) / cell.width))) : 0;
    const row = rect ? Math.max(0, Math.min(this.rows - 1, Math.floor((e.clientY - rect.top) / cell.height))) : 0;
    const mods = wheelModifiers(e);
    if (this.wheelAt && Math.sign(this.wheelAt.lines) === Math.sign(lines) && this.wheelAt.mods === mods) this.wheelAt = { lines: this.wheelAt.lines + lines, column, row, mods };
    else {
      this.flushWheel();
      this.wheelAt = { lines, column, row, mods };
    }
    this.wheelTimer ??= setTimeout(() => this.flushWheel(), WHEEL_FLUSH_MS);
    return false;
  }

  private flushWheel(): void {
    if (this.wheelTimer) clearTimeout(this.wheelTimer);
    this.wheelTimer = null;
    const w = this.wheelAt;
    this.wheelAt = null;
    if (w) this.deps.wheel(w.lines, w.column, w.row, w.mods);
  }

  private watchDpr(): void {
    this.dpr?.removeEventListener('change', this.onDpr);
    this.dpr = globalThis.matchMedia?.(`(resolution: ${globalThis.devicePixelRatio || 1}dppx)`) ?? null;
    this.dpr?.addEventListener('change', this.onDpr, { once: true });
  }

  /** A cell's size in CSS px (xterm's own measure; the font's size as a fallback). */
  private cell(): { width: number; height: number } {
    const core = (this.term as unknown as { _core?: { _renderService?: { dimensions?: { css?: { cell?: { width: number; height: number } } } } } } | null)?._core;
    const c = core?._renderService?.dimensions?.css?.cell;
    return c && c.width > 0 && c.height > 0 ? { width: c.width, height: c.height } : { width: this.px * 0.6, height: this.px * 1.2 };
  }

  /**
   * The area or the font changed: the grid it fits now (within the bridge's bounds: a smaller area clips) goes to
   * `grid`, debounced, unless it is the one asked already. `now`: at once (a font, a DPR, the first measure).
   */
  private refit(now = false): void {
    if (now) this.watchDpr();
    const term = this.term;
    if (!term || !this.fitting || !this.host.isConnected || this.host.clientWidth === 0 || this.host.clientHeight === 0) return;
    const dims = this.fit?.proposeDimensions();
    if (!dims || !Number.isFinite(dims.cols) || !Number.isFinite(dims.rows)) return;
    const g = clampGrid(dims.cols, dims.rows);
    const grid: SeatGrid = { ...g, cell: this.cell() };
    const prev = this.proposed;
    if (prev && prev.cols === grid.cols && prev.rows === grid.rows && Math.abs(prev.cell.width - grid.cell.width) < 0.01 && Math.abs(prev.cell.height - grid.cell.height) < 0.01) return;
    this.proposed = grid;
    // The widget takes the new grid at once (what it shows reflows when herdr's frame at that size comes).
    if (term.cols !== grid.cols || term.rows !== grid.rows) term.resize(grid.cols, grid.rows);
    if (now || !prev) {
      this.debounce.cancel();
      this.deps.grid(grid);
    } else this.debounce.call(() => this.deps.grid(grid));
  }

  /** The seat owns the pane (fit its area) or shows it read only (the pane at its own size, never resized from here). */
  setFitting(on: boolean): void {
    if (on === this.fitting) return;
    this.fitting = on;
    this.host.toggleAttribute('data-readonly', !on);
    if (on) {
      this.proposed = null;
      this.refit(true);
    } else this.debounce.cancel();
  }

  /** The preset's font (loaded before) and colours, and the size the zoom gives: a new cell, so a new grid. */
  setLook(font: string, theme: ScreenTheme, px: number): void {
    const fontChanged = font !== this.font || px !== this.px;
    this.font = font;
    this.px = px;
    this.theme = theme;
    this.host.style.setProperty('--seat-term-bg', `#${(theme.bg & 0xffffff).toString(16).padStart(6, '0')}`);
    const term = this.term;
    if (!term) return;
    term.options.theme = xtermTheme(theme);
    if (!fontChanged) return;
    void (async () => {
      try {
        await document.fonts?.load(`${px}px ${font}`);
      } catch {
        // as at open
      }
      if (this.term !== term) return;
      term.options.fontFamily = font;
      term.options.fontSize = px;
      this.refit(true);
    })();
  }

  /** A frame of the watch: a full one resets the screen first (RIS: no history is kept here) at its size; a diff applies on top. */
  frame(f: TerminalFrame): boolean {
    const term = this.term;
    if (!term) return false;
    if (!f.full && (f.cols !== term.cols || f.rows !== term.rows)) return false;
    if (f.full) {
      if (f.cols !== term.cols || f.rows !== term.rows) term.resize(f.cols, f.rows);
      term.write('\x1bc');
    }
    term.write(decodeFrame(f.data));
    this.frames++;
    return true;
  }

  /** Forgets the screen (a new watch, a pane that changed). */
  clear(): void {
    this.term?.reset();
  }

  /** The selected text ('' for none). */
  selection(): string {
    return this.term?.hasSelection() ? this.term.getSelection() : '';
  }

  clearSelection(): void {
    this.term?.clearSelection();
  }

  /** The screen's text, one string per row, right-trimmed (tests). */
  lines(): string[] {
    const t = this.term;
    if (!t) return [];
    const b = t.buffer.active;
    return Array.from({ length: t.rows }, (_, y) => (b.getLine(b.viewportY + y)?.translateToString(true) ?? '').trimEnd());
  }

  dispose(): void {
    this.debounce.cancel();
    if (this.wheelTimer) clearTimeout(this.wheelTimer);
    this.wheelTimer = null;
    this.observer?.disconnect();
    this.dpr?.removeEventListener('change', this.onDpr);
    this.host.removeEventListener('paste', this.onPaste, { capture: true });
    for (const d of this.offs.splice(0)) d.dispose();
    this.term?.dispose();
    this.term = null;
    this.fit = null;
    this.mounting = null;
    this.proposed = null;
  }
}
