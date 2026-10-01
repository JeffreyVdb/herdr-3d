import type { CommandResult } from '../net/client';
import type { CommandArgs, TranscriptClosed, TranscriptHead, TranscriptItem, TranscriptItems, TranscriptWatchAck } from '../net/protocol';

/** Which transcript a timeline is: its `seq`s count in it (another session is another log, counted from 1 again). */
export type TimelineOf = Pick<TranscriptHead, 'harness' | 'session'>;

/** Where a watched transcript goes. */
export interface TranscriptSink {
  /** A watch (or a re-watch) was acked: the whole timeline so far, replacing what was there. */
  reset(id: string, ack: TranscriptWatchAck): void;
  /**
   * Live, after the ack: new items and whole replacements of items already sent (by `id`). `head`: the transcript they
   * are of, when the push says (the first one of a pending watch, once its transcript appeared).
   */
  push(id: string, items: TranscriptItem[], updates: TranscriptItem[], head?: TimelineOf): void;
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
  /** The items the watch asked for (a re-watch replaces it with more when someone sits down). */
  limit: number;
  /**
   * The ack came: pushes go to the sink. Before it they are dropped: they come from the watch this one replaced (the
   * bridge pushes a watch's items only after its ack), and the ack's items are newer than they are.
   */
  ready: boolean;
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
 * at). Pushes before a watch's ack are dropped (they are the replaced
 * watch's, older than the ack's items). The bridge's closes watch
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
  /** Workers whose sink starts over (`refresh`): the next `sync` that wants them hands it a fresh ack. */
  private readonly fresh = new Set<string>();
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

  /**
   * The watches to have: a set of workers (each with `WATCH_LIMIT` items), or a map of worker to how many items it needs
   * (the desk prints only need the images, so a few; a worker you sit at needs the conversation). A watch that has fewer
   * items than wanted is made again (the bridge replaces the old one).
   */
  sync(want: ReadonlySet<string> | ReadonlyMap<string, number>): void {
    if (this.disabled) return;
    const limits = new Map<string, number>();
    if (want instanceof Map) for (const [id, n] of want) limits.set(id, n);
    else for (const id of want as ReadonlySet<string>) limits.set(id, WATCH_LIMIT);
    for (const id of [...this.on.keys()]) if (!limits.has(id)) this.unwatch(id);
    for (const m of [this.retryAt, this.lastClose]) for (const id of [...m.keys()]) if (!limits.has(id)) m.delete(id);
    for (const id of [...this.fresh]) if (!limits.has(id)) this.fresh.delete(id);
    const now = this.host.now();
    for (const [id, limit] of limits) {
      const w = this.on.get(id);
      // An ack still to come resets the sink anyway.
      if (w && !w.ready) this.fresh.delete(id);
      if (w && w.limit >= limit && !this.fresh.has(id)) continue;
      // Waiting out a close or a refusal (the watch made after it acks with the history).
      if (!w && (this.retryAt.get(id) ?? -Infinity) > now) continue;
      this.watch(id, Math.max(limit, w?.limit ?? 0));
    }
  }

  /**
   * The sink's view of `id` starts empty again (you sat down at it): it needs the history, which only an ack brings. The
   * next `sync` that wants `id` makes its watch again even when it has items enough (a desk print kept it after you
   * stood up), unless its ack is still to come.
   */
  refresh(id: string): void {
    if (!this.disabled) this.fresh.add(id);
  }

  /** The limit of a worker's watch (null: not watched). */
  limitOf(id: string): number | null {
    return this.on.get(id)?.limit ?? null;
  }

  private watch(id: string, limit = WATCH_LIMIT): void {
    const gen = ++this.gen;
    this.retryAt.delete(id);
    this.fresh.delete(id);
    this.on.set(id, { gen, limit, ready: false });
    void this.host.send('transcript.watch', { id, limit }).then((r) => {
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
    this.fresh.clear();
  }

  items(m: TranscriptItems): void {
    if (!this.on.get(m.id)?.ready) return;
    const items = itemsOf(m.items);
    const updates = itemsOf(m.updates);
    const head = typeof m.session === 'string' ? { harness: typeof m.harness === 'string' ? m.harness : '', session: m.session } : undefined;
    // #58: a pending watch's first push names the session even with nothing in it yet (the transcript appeared empty).
    if (items.length || updates.length || head) this.host.sink.push(m.id, items, updates, head);
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
      if (c.reason !== 'not_found' && now - last >= RETRY_MS) this.watch(c.id, w.limit);
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
    this.fresh.clear();
  }
}
