import type { CommandResult } from '../net/client';
import type { CommandArgs, TranscriptClosed, TranscriptItem, TranscriptItems, TranscriptWatchAck } from '../net/protocol';

/** Where a watched transcript goes. */
export interface TranscriptSink {
  /** A watch (or a re-watch) was acked: the whole timeline so far, replacing what was there. */
  reset(id: string, ack: TranscriptWatchAck): void;
  /** Live: new items and whole replacements of items already sent (by `id`). */
  push(id: string, items: TranscriptItem[], updates: TranscriptItem[]): void;
  /** Not watched any more (stood up, closed for good, the connection dropped). */
  stop(id: string): void;
}

export interface TranscriptWatchHost {
  send<T extends 'transcript.watch' | 'transcript.unwatch'>(t: T, args: CommandArgs[T]): Promise<CommandResult>;
  sink: TranscriptSink;
  /** A watch was refused (`capacity`, `unknown_worker`, …). */
  failed(id: string, code: string, message: string): void;
  /** The bridge ended a watch (`transcript.closed`); `session_changed`, `resync` and `not_found` are watched again. */
  closed(id: string, reason: string): void;
  now(): number;
}

interface Watch {
  /** Tells a late answer to an older request from this one. */
  gen: number;
  /** The ack came: pushes go to the sink (before it, they wait for it). */
  ready: boolean;
  queued: TranscriptItems[];
}

/** How many items a watch starts with. */
export const WATCH_LIMIT = 200;
/** A close or a refusal is watched again after this long (a re-watch that closes again does not spin). */
const RETRY_MS = 2000;
const FAIL_MS = 5000;
/** Closes the game watches again right away (the next sync), unless the last one was under RETRY_MS ago. */
const REWATCH = new Set(['session_changed', 'resync', 'not_found']);

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isItem = (v: unknown): v is TranscriptItem => isObj(v) && typeof v.id === 'string' && typeof v.kind === 'string';
/** The items of an ack or push that look like items (a malformed one is dropped, not fatal). */
export const itemsOf = (v: unknown): TranscriptItem[] => (Array.isArray(v) ? v.filter(isItem) : []);

/** A `transcript.watch` ack, whatever the bridge sent (fields missing on an older or newer one get defaults). */
export function watchAck(data: unknown): TranscriptWatchAck {
  const d = isObj(data) ? data : {};
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  return {
    harness: str(d.harness),
    session: str(d.session),
    version: str(d.version),
    cursor: str(d.cursor),
    has_more: d.has_more === true,
    pending: d.pending === true,
    items: itemsOf(d.items),
  };
}

/**
 * M16: the connection's `transcript.watch`es, brought to what the game wants
 * (`sync`: the workers whose transcripts it reads; today the one you sit
 * at). Pushes before a watch's ack wait for it. The bridge's closes watch
 * again (`session_changed` with the new session's items, `resync`,
 * `not_found`) or end it (`worker_removed`, `asleep`); either way not more
 * often than every RETRY_MS. After `unknown_command` (an older bridge) it is
 * off for good and says why. Everything is gone when the connection drops
 * (`lost`); the next `sync` watches again. Mirrors `Watches` for terminals.
 */
export class TranscriptWatches {
  private readonly on = new Map<string, Watch>();
  /** Worker id → when it may be watched again (after a close or a refusal). */
  private readonly retryAt = new Map<string, number>();
  /** When each worker's watch was last closed by the bridge (the re-watch back-off). */
  private readonly lastClose = new Map<string, number>();
  private gen = 0;
  /** Why transcripts are off: the bridge does not know `transcript.watch`. */
  disabled: string | null = null;

  constructor(private readonly host: TranscriptWatchHost) {}

  get count(): number {
    return this.on.size;
  }

  ids(): string[] {
    return [...this.on.keys()];
  }

  has(id: string): boolean {
    return this.on.has(id);
  }

  /** The watch's ack came (its items are in the sink). */
  ready(id: string): boolean {
    return this.on.get(id)?.ready ?? false;
  }

  sync(want: ReadonlySet<string>): void {
    if (this.disabled) return;
    for (const id of [...this.on.keys()]) if (!want.has(id)) this.unwatch(id);
    for (const m of [this.retryAt, this.lastClose]) for (const id of [...m.keys()]) if (!want.has(id)) m.delete(id);
    const now = this.host.now();
    for (const id of want) {
      if (this.on.has(id) || (this.retryAt.get(id) ?? -Infinity) > now) continue;
      this.watch(id);
    }
  }

  private watch(id: string): void {
    const gen = ++this.gen;
    this.retryAt.delete(id);
    this.on.set(id, { gen, ready: false, queued: [] });
    void this.host.send('transcript.watch', { id, limit: WATCH_LIMIT }).then((r) => {
      const w = this.on.get(id);
      if (!w || w.gen !== gen) return;
      if (!r.ok) {
        this.on.delete(id);
        this.retryAt.set(id, this.host.now() + FAIL_MS);
        this.host.sink.stop(id);
        if (r.code === 'unknown_command') this.disable(r.message);
        this.host.failed(id, r.code, r.message);
        return;
      }
      w.ready = true;
      this.host.sink.reset(id, watchAck(r.data));
      const q = w.queued.splice(0);
      for (const m of q) this.deliver(m);
    });
  }

  private unwatch(id: string): void {
    this.on.delete(id);
    this.host.sink.stop(id);
    void this.host.send('transcript.unwatch', { id });
  }

  private disable(why: string): void {
    this.disabled = why || 'the bridge does not know transcript.watch';
    for (const id of [...this.on.keys()]) {
      this.on.delete(id);
      this.host.sink.stop(id);
    }
    this.retryAt.clear();
  }

  items(m: TranscriptItems): void {
    const w = this.on.get(m.id);
    if (!w) return;
    if (!w.ready) w.queued.push(m);
    else this.deliver(m);
  }

  private deliver(m: TranscriptItems): void {
    const items = itemsOf(m.items);
    const updates = itemsOf(m.updates);
    if (items.length || updates.length) this.host.sink.push(m.id, items, updates);
  }

  closed(c: TranscriptClosed): void {
    const w = this.on.get(c.id);
    if (!w) return;
    this.on.delete(c.id);
    const now = this.host.now();
    const last = this.lastClose.get(c.id) ?? -Infinity;
    this.lastClose.set(c.id, now);
    if (REWATCH.has(c.reason)) {
      // The view keeps what it shows until the new watch's ack replaces it; a close right after the last one waits.
      if (c.reason !== 'not_found' && now - last >= RETRY_MS) this.watch(c.id);
      else this.retryAt.set(c.id, now + RETRY_MS);
    } else {
      this.retryAt.set(c.id, now + RETRY_MS);
      this.host.sink.stop(c.id);
    }
    this.host.closed(c.id, c.reason);
  }

  /** The connection dropped: the bridge forgot every watch (pushes are not replayed). */
  lost(): void {
    for (const id of [...this.on.keys()]) {
      this.on.delete(id);
      this.host.sink.stop(id);
    }
    this.retryAt.clear();
    this.lastClose.clear();
  }
}
