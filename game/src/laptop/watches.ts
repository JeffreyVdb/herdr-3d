import type { CommandResult } from '../net/client';
import type { CommandArgs, TerminalClosed, TerminalFrame, TerminalState, ZoomInfo } from '../net/protocol';
import { isZoomInfo } from '../net/protocol';

/** Where frames go: a watched worker's screen, and when it stops being live. */
export interface ScreenSink {
  frame(id: string, f: TerminalFrame): void;
  /** Not live any more: it keeps its last frame (frozen), or its glow. */
  stop(id: string): void;
}

export interface WatchHost {
  send<T extends 'terminal.watch' | 'terminal.unwatch' | 'terminal.zoom'>(t: T, args: CommandArgs[T]): Promise<CommandResult>;
  sink: ScreenSink;
  /** A watch was refused (`capacity`, `invalid_state`, `unknown_worker`, …) or its observer failed. */
  failed(id: string, code: string, message: string): void;
  /** The bridge ended a watch (`terminal.closed`); `pane_changed` is re-watched by the next sync. */
  closed(id: string, reason: string): void;
  /** #74: a watch's zoom state or size changed (its ack, `terminal.state`, a zoom answer, a frame of a new size). */
  zoomChanged?(id: string): void;
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
  /** #74: the watch asks the bridge to zoom the pane's tab (the seated screen). */
  fullscreen: boolean;
  /** #74: where the pane stands in its tab, and the size its screen is at; null before the ack (and on a bridge before #74). */
  zoom: ZoomInfo | null;
  size: { cols: number; rows: number } | null;
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
    return w?.zoom ? { zoom: w.zoom, size: w.size, fullscreen: w.fullscreen } : null;
  }

  /**
   * `fullscreen`: the watches that ask the bridge to zoom their pane's tab (the seated screen; the others show a pane
   * at its own size and must not move the tab around). A change restarts the watch, as a new fps does.
   */
  sync(want: ReadonlyMap<string, number>, fullscreen: ReadonlySet<string> = new Set()): void {
    if (this.disabled) return;
    for (const id of [...this.on.keys()]) if (!want.has(id)) this.unwatch(id);
    for (const [id, fps] of want) {
      const fs = fullscreen.has(id) && !this.noFullscreen;
      const w = this.on.get(id);
      if (w?.fps !== fps || w.fullscreen !== fs) this.watch(id, fps, fs);
    }
  }

  private watch(id: string, fps: number, fullscreen = false): void {
    const gen = ++this.gen;
    // A watch that replaces another (a new fps, fullscreen on or off) keeps what the last one knew until its ack: the
    // seat bar's chip does not blink out and back in.
    const prev = this.on.get(id);
    this.on.set(id, { fps, gen, full: false, n: 0, resyncAt: this.host.now() + RESYNC_MS, fullscreen, zoom: prev?.zoom ?? null, size: prev?.size ?? null });
    // No cols / rows: the bridge observes at the pane's own size (herdr's observer clips a smaller one, it does not
    // reflow), and each frame says the size the screen is drawn at.
    void this.host.send('terminal.watch', { id, fps, ...(fullscreen ? { fullscreen: true } : {}) }).then((r) => {
      const w = this.on.get(id);
      if (!w || w.gen !== gen) return;
      if (r.ok) return this.acked(id, w, r.data);
      if (fullscreen && r.code === 'bad_request') {
        // A bridge before #74 does not know the argument: watch without it, and never ask again.
        this.noFullscreen = true;
        this.watch(id, fps);
        return;
      }
      this.on.delete(id);
      this.host.sink.stop(id);
      if (r.code === 'unknown_command') this.disable(r.message);
      this.host.failed(id, r.code, r.message);
    });
  }

  private acked(id: string, w: Watch, data: unknown): void {
    const a = data as { cols?: unknown; rows?: unknown; zoom?: unknown } | null;
    // An older bridge has no `zoom`: no chip, no error.
    w.zoom = a && isZoomInfo(a.zoom) ? a.zoom : null;
    if (a && Number.isInteger(a.cols) && Number.isInteger(a.rows)) w.size = { cols: a.cols as number, rows: a.rows as number };
    this.host.zoomChanged?.(id);
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
      if (now >= w.resyncAt) {
        this.on.delete(f.id);
        this.watch(f.id, w.fps, w.fullscreen);
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
    this.host.sink.stop(c.id);
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
