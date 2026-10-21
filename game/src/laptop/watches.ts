import type { CommandResult } from '../net/client';
import type { CommandArgs, TerminalClosed, TerminalControl, TerminalFrame, TerminalHistory, TerminalState, ZoomInfo } from '../net/protocol';
import { isZoomInfo } from '../net/protocol';

/** Where frames go: a watched worker's screen, and when it stops being live. */
export interface ScreenSink {
  frame(id: string, f: TerminalFrame): void;
  /**
   * Not live any more: it keeps its last frame (frozen), or its glow. `reason`: the bridge ended it (`terminal.closed`);
   * #52: after `pane_changed` the last frame is the old pane's, not the worker's screen any more.
   */
  stop(id: string, reason?: string): void;
}

export interface WatchHost {
  send<T extends 'terminal.watch' | 'terminal.unwatch' | 'terminal.zoom' | 'terminal.resize' | 'terminal.scroll'>(t: T, args: CommandArgs[T]): Promise<CommandResult>;
  sink: ScreenSink;
  /** A watch was refused (`capacity`, `invalid_state`, `unknown_worker`, …) or its observer failed. */
  failed(id: string, code: string, message: string): void;
  /** The bridge ended a watch (`terminal.closed`); `pane_changed` is re-watched by the next sync. */
  closed(id: string, reason: string): void;
  /** #74: a watch's zoom state or size changed (its ack, `terminal.state`, a zoom answer, a frame of a new size). */
  zoomChanged?(id: string): void;
  /** #176: who owns a control watch's pane changed (its ack, `terminal.control`), or where its view is in herdr's history. */
  controlChanged?(id: string): void;
  now(): number;
}

interface Watch {
  fps: number;
  /** Tells a late answer to an older request from this one. */
  gen: number;
  /** A full frame came for this watch (diffs before one are useless). */
  full: boolean;
  n: number;
  resyncAt: number;
  /**
   * #74: what the watch told the bridge: true asks it to zoom the pane's tab (the seated screen), false follows the
   * pane without zooming it, undefined sent nothing (the ambient laptops: shown as they are, never followed).
   */
  fullscreen: boolean | undefined;
  /** #74: where the pane stands in its tab, and the size its screen is at; null before the ack (and on a bridge before #74). */
  zoom: ZoomInfo | null;
  size: { cols: number; rows: number } | null;
  /** #176: the watch owns its pane (the seated laptop): the grid it asked for, and what the bridge said of it. */
  control: ControlState | null;
}

/**
 * #176: a control watch: `pending` until the bridge says (its ack has `control`), `control` while this watch owns the
 * pane, `observe` when it watches read only (`reason`: `busy`, `taken_over`, `failed`), `none` when the bridge cannot
 * own panes (an older one: it observes). `cols` × `rows` is the grid asked for (the last resize); `history` where the
 * view is in herdr's history (null: not known yet).
 */
export interface ControlState {
  mode: 'pending' | 'control' | 'observe' | 'none';
  reason: string | null;
  cols: number;
  rows: number;
  cell: { width: number; height: number } | null;
  history: { offset: number; max: number; rows: number } | null;
}

/** A grid the seat asks for: the PTY's size, and a cell's size in CSS px. */
export interface ControlGrid {
  cols: number;
  rows: number;
  cell?: { width: number; height: number };
}

/** A diff out of order asks for a fresh full frame (a re-watch), at most this often. */
const RESYNC_MS = 2000;

/**
 * M5: the connection's `terminal.watch`es, brought to what the game wants
 * (`sync`: worker id → fps; a new fps restarts the watch). Frames are applied
 * in `n` order from a full frame; a gap re-watches. After `unknown_command`
 * (an older bridge) it is off for good and says why. Everything is gone when
 * the connection drops (`lost`); the next `sync` watches again.
 */
export class Watches {
  private readonly on = new Map<string, Watch>();
  private gen = 0;
  /** Why screens are off: the bridge does not know `terminal.watch`. */
  disabled: string | null = null;
  /** #74: the bridge refused `fullscreen` as an argument (a bridge before it): watches go without. */
  private noFullscreen = false;
  /** #74: the bridge does not know `terminal.zoom`. */
  zoomUnsupported = false;
  /** #176: the bridge refused `control` as an argument (a bridge before it): the seat watches as before. */
  noControl = false;

  constructor(private readonly host: WatchHost) {}

  get count(): number {
    return this.on.size;
  }

  fps(id: string): number | null {
    return this.on.get(id)?.fps ?? null;
  }

  ids(): string[] {
    return [...this.on.keys()];
  }

  /** The zoom state of a watch (#74), null when it has none. */
  zoomOf(id: string): { zoom: ZoomInfo; size: { cols: number; rows: number } | null; fullscreen: boolean } | null {
    const w = this.on.get(id);
    return w?.zoom ? { zoom: w.zoom, size: w.size, fullscreen: w.fullscreen === true } : null;
  }

  /** #176: a control watch's state (null: not a control watch). */
  controlOf(id: string): ControlState | null {
    return this.on.get(id)?.control ?? null;
  }

  /**
   * `fullscreen`: the watches that say what they want of their pane's tab (the seated screen: true zooms it, false
   * only follows it; the others show a pane at its own size and must not move the tab around, so they are not in it).
   * A change restarts the watch, as a new fps does. #176: `control`, the watch that owns its pane (the seated laptop) at
   * that grid: neither a new fps nor a new grid restarts it (a restart would release the pane and attach again), only
   * control on or off does; `resize` changes its grid.
   */
  sync(want: ReadonlyMap<string, number>, fullscreen: ReadonlyMap<string, boolean> = new Map(), control: ReadonlyMap<string, ControlGrid> = new Map()): void {
    if (this.disabled) return;
    for (const id of [...this.on.keys()]) if (!want.has(id)) this.unwatch(id);
    for (const [id, fps] of want) {
      const fs = this.noFullscreen ? undefined : fullscreen.get(id);
      const grid = this.noControl ? undefined : control.get(id);
      const w = this.on.get(id);
      if (w && w.control && grid) continue; // #176: it keeps its process
      if (w?.fps !== fps || w.fullscreen !== fs || !!w.control !== !!grid) this.watch(id, fps, fs, grid);
    }
  }

  private watch(id: string, fps: number, fullscreen?: boolean, grid?: ControlGrid): void {
    const gen = ++this.gen;
    // A watch that replaces another (a new fps, fullscreen on or off) keeps what the last one knew until its ack: the
    // seat bar's chip does not blink out and back in.
    const prev = this.on.get(id);
    const control: ControlState | null = grid ? { mode: 'pending', reason: null, cols: grid.cols, rows: grid.rows, cell: grid.cell ?? null, history: null } : null;
    this.on.set(id, { fps, gen, full: false, n: 0, resyncAt: this.host.now() + RESYNC_MS, fullscreen, zoom: prev?.zoom ?? null, size: prev?.size ?? null, control });
    // No cols / rows: the bridge observes at the pane's own size (herdr's observer clips a smaller one, it does not
    // reflow), and each frame says the size the screen is drawn at. #176: a control watch's are the PTY's.
    const args: CommandArgs['terminal.watch'] = { id, fps, ...(fullscreen === undefined ? {} : { fullscreen }), ...(grid ? { control: true, cols: grid.cols, rows: grid.rows } : {}) };
    void this.host.send('terminal.watch', args).then((r) => {
      const w = this.on.get(id);
      if (!w || w.gen !== gen) return;
      if (r.ok) return this.acked(id, w, r.data);
      if (grid && r.code === 'bad_request' && !this.noControl) {
        // A bridge before #176 does not know `control`: the seat watches as before, and never asks again.
        this.noControl = true;
        this.watch(id, fps, fullscreen);
        return;
      }
      if (fullscreen !== undefined && r.code === 'bad_request') {
        // A bridge before #74 does not know the argument: watch without it, and never ask again.
        this.noFullscreen = true;
        this.watch(id, fps, undefined, grid);
        return;
      }
      this.on.delete(id);
      this.host.sink.stop(id);
      if (r.code === 'unknown_command') this.disable(r.message);
      this.host.failed(id, r.code, r.message);
    });
  }

  private acked(id: string, w: Watch, data: unknown): void {
    const a = data as { cols?: unknown; rows?: unknown; zoom?: unknown; control?: unknown } | null;
    // An older bridge has no `zoom`: no chip, no error.
    w.zoom = a && isZoomInfo(a.zoom) ? a.zoom : null;
    if (a && Number.isInteger(a.cols) && Number.isInteger(a.rows)) w.size = { cols: a.cols as number, rows: a.rows as number };
    // #176: a bridge that cannot own panes observes the seat (no `control` in its ack).
    if (w.control && w.control.mode === 'pending' && a?.control !== true) w.control.mode = 'none';
    this.host.zoomChanged?.(id);
    if (w.control) this.host.controlChanged?.(id);
  }

  /** #176: `terminal.control`: the bridge owns the pane for this watch, or watches it read only (from now on). */
  control(m: TerminalControl): void {
    const c = this.on.get(m.id)?.control;
    if (!c) return;
    c.mode = m.mode;
    c.reason = m.mode === 'observe' ? (m.reason ?? 'busy') : null;
    if (m.mode === 'observe') c.history = null;
    this.host.controlChanged?.(m.id);
  }

  /** #176: `terminal.history`: where the controlled view is in herdr's history. */
  history(m: TerminalHistory): void {
    const c = this.on.get(m.id)?.control;
    if (!c || c.mode === 'observe') return;
    const h = c.history;
    if (h && h.offset === m.offset && h.max === m.max && h.rows === m.rows) return;
    c.history = { offset: m.offset, max: m.max, rows: m.rows };
    this.host.controlChanged?.(m.id);
  }

  /**
   * #176: the controlled pane's PTY to `grid` (the seat debounces a window drag); a same grid again asks for a full
   * frame. Null when it is no control watch the bridge owns; a refusal is the bridge's answer (the next frame says the
   * size it really has).
   */
  resize(id: string, grid: ControlGrid): Promise<CommandResult> | null {
    const c = this.on.get(id)?.control;
    if (!c || c.mode === 'observe' || c.mode === 'none') return null;
    c.cols = grid.cols;
    c.rows = grid.rows;
    c.cell = grid.cell ?? c.cell;
    const cell = c.cell ? { cell_width_px: Math.min(256, Math.round(c.cell.width)), cell_height_px: Math.min(256, Math.round(c.cell.height)) } : {};
    return this.host.send('terminal.resize', { id, cols: grid.cols, rows: grid.rows, ...cell });
  }

  /** #176: a wheel over the controlled pane (`lines` > 0 up, < 0 down) at a cell, or (`bottom`) back to the live bottom. */
  scroll(id: string, s: { lines: number; column?: number; row?: number; modifiers?: number } | { bottom: true }): Promise<CommandResult> | null {
    const c = this.on.get(id)?.control;
    if (!c || c.mode !== 'control') return null;
    if ('bottom' in s) {
      // Optimistic: the indicator goes at once; the bridge's next reading confirms it.
      if (c.history && c.history.offset > 0) {
        c.history = { ...c.history, offset: 0 };
        this.host.controlChanged?.(id);
      }
      return this.host.send('terminal.scroll', { id, bottom: true });
    }
    if (!s.lines) return null;
    return this.host.send('terminal.scroll', { id, direction: s.lines > 0 ? 'up' : 'down', lines: Math.min(1000, Math.abs(Math.round(s.lines))), ...(s.column ? { column: s.column } : {}), ...(s.row ? { row: s.row } : {}), ...(s.modifiers ? { modifiers: s.modifiers } : {}) });
  }

  /** `terminal.state`: the pane's zoom, focus or size changed (the human zoomed, unzoomed or moved focus). */
  state(m: TerminalState): void {
    const w = this.on.get(m.id);
    if (!w) return;
    w.zoom = m.zoom;
    w.size = { cols: m.cols, rows: m.rows };
    this.host.zoomChanged?.(m.id);
  }

  /**
   * #74: the chip's switch. The watch keeps its place: `on` zooms the pane's tab (the bridge keeps it zoomed for as long
   * as the watch lasts), off goes back to the split view. Resolves to whether the bridge did it; a bridge that does not
   * know `terminal.zoom` hides the chip.
   */
  async zoom(id: string, on: boolean): Promise<CommandResult | null> {
    const w = this.on.get(id);
    if (!w) return null;
    // Optimistic, so the next sync does not restart the watch to say the same.
    const was = w.fullscreen;
    w.fullscreen = on;
    const gen = w.gen;
    const r = await this.host.send('terminal.zoom', { id, on });
    const cur = this.on.get(id);
    if (!cur || cur.gen !== gen) return r;
    if (r.ok) {
      const a = r.data as { cols?: unknown; rows?: unknown; zoom?: unknown } | null;
      if (a && isZoomInfo(a.zoom)) cur.zoom = a.zoom;
      if (a && Number.isInteger(a.cols) && Number.isInteger(a.rows)) cur.size = { cols: a.cols as number, rows: a.rows as number };
    } else if (r.code === 'unknown_command') {
      this.zoomUnsupported = true;
      cur.zoom = null;
    } else {
      // Refused: the next sync watches again as the preference says (one more try, with the watch's own zoom).
      cur.fullscreen = was;
    }
    this.host.zoomChanged?.(id);
    return r;
  }

  private unwatch(id: string): void {
    this.on.delete(id);
    this.host.sink.stop(id);
    void this.host.send('terminal.unwatch', { id });
  }

  private disable(why: string): void {
    this.disabled = why || 'the bridge does not know terminal.watch';
    for (const id of [...this.on.keys()]) {
      this.on.delete(id);
      this.host.sink.stop(id);
    }
  }

  frame(f: TerminalFrame): void {
    const w = this.on.get(f.id);
    if (!w) return;
    if (f.full) {
      w.full = true;
      w.n = f.n;
      if (w.size?.cols !== f.cols || w.size.rows !== f.rows) {
        w.size = { cols: f.cols, rows: f.rows };
        if (w.zoom) this.host.zoomChanged?.(f.id);
      }
      this.host.sink.frame(f.id, f);
      return;
    }
    if (!w.full || f.n !== w.n + 1) {
      // Missed a frame (or none full yet): the screen would be wrong until a full one; ask for it.
      const now = this.host.now();
      if (now >= w.resyncAt && w.control?.mode === 'control') {
        // #176: a controlled pane is not watched again (that would release it): its same grid asks for a full frame.
        w.resyncAt = now + RESYNC_MS;
        w.full = false;
        void this.resize(f.id, { cols: w.control.cols, rows: w.control.rows });
      } else if (now >= w.resyncAt) {
        this.on.delete(f.id);
        this.watch(f.id, w.fps, w.fullscreen, w.control ? { cols: w.control.cols, rows: w.control.rows, ...(w.control.cell ? { cell: w.control.cell } : {}) } : undefined);
        const nw = this.on.get(f.id);
        if (nw) {
          nw.resyncAt = now + RESYNC_MS;
          nw.zoom = w.zoom;
          nw.size = w.size;
        }
      }
      return;
    }
    w.n = f.n;
    this.host.sink.frame(f.id, f);
  }

  closed(c: TerminalClosed): void {
    if (!this.on.has(c.id)) return;
    this.on.delete(c.id);
    this.host.sink.stop(c.id, c.reason);
    if (c.reason === 'observer_failed') this.host.failed(c.id, 'observer_failed', 'the laptop screen stopped updating');
    this.host.closed(c.id, c.reason);
  }

  /** The connection dropped: the bridge forgot every watch (frames are not replayed). */
  lost(): void {
    for (const id of [...this.on.keys()]) {
      this.on.delete(id);
      this.host.sink.stop(id);
    }
  }
}
