import type { CommandResult } from '../net/client';
import type { CommandArgs, TerminalClosed, TerminalFrame } from '../net/protocol';

/** Where frames go: a watched worker's screen, and when it stops being live. */
export interface ScreenSink {
  frame(id: string, f: TerminalFrame): void;
  /** Not live any more: it keeps its last frame (frozen), or its glow. */
  stop(id: string): void;
}

export interface WatchHost {
  send<T extends 'terminal.watch' | 'terminal.unwatch'>(t: T, args: CommandArgs[T]): Promise<CommandResult>;
  sink: ScreenSink;
  /** A watch was refused (`capacity`, `invalid_state`, `unknown_worker`, …) or its observer failed. */
  failed(id: string, code: string, message: string): void;
  /** The bridge ended a watch (`terminal.closed`); `pane_changed` is re-watched by the next sync. */
  closed(id: string, reason: string): void;
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

  sync(want: ReadonlyMap<string, number>): void {
    if (this.disabled) return;
    for (const id of [...this.on.keys()]) if (!want.has(id)) this.unwatch(id);
    for (const [id, fps] of want) if (this.on.get(id)?.fps !== fps) this.watch(id, fps);
  }

  private watch(id: string, fps: number): void {
    const gen = ++this.gen;
    this.on.set(id, { fps, gen, full: false, n: 0, resyncAt: this.host.now() + RESYNC_MS });
    // No cols / rows: the bridge observes at the pane's own size (herdr's observer clips a smaller one, it does not
    // reflow), and each frame says the size the screen is drawn at.
    void this.host.send('terminal.watch', { id, fps }).then((r) => {
      const w = this.on.get(id);
      if (r.ok || !w || w.gen !== gen) return;
      this.on.delete(id);
      this.host.sink.stop(id);
      if (r.code === 'unknown_command') this.disable(r.message);
      this.host.failed(id, r.code, r.message);
    });
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
      this.host.sink.frame(f.id, f);
      return;
    }
    if (!w.full || f.n !== w.n + 1) {
      // Missed a frame (or none full yet): the screen would be wrong until a full one; ask for it.
      const now = this.host.now();
      if (now >= w.resyncAt) {
        this.on.delete(f.id);
        this.watch(f.id, w.fps);
        const nw = this.on.get(f.id);
        if (nw) nw.resyncAt = now + RESYNC_MS;
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
