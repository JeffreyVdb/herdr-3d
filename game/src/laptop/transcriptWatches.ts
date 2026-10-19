import type { CommandResult } from '../net/client';
import type { CommandArgs, TranscriptAvailability, TranscriptChild, TranscriptClosed, TranscriptHead, TranscriptItem, TranscriptItems, TranscriptWatchAck } from '../net/protocol';

/** Which transcript a timeline is: its `seq`s count in it (another session is another log, counted from 1 again). */
export type TimelineOf = Pick<TranscriptHead, 'harness' | 'session'>;

/**
 * A push's head: the transcript its items are of and (#26) where older items start and a child's availability, when
 * the push says (the first one of a pending watch, once its transcript appeared; a child's head alone while pending).
 */
export type PushHead = TimelineOf & Partial<Pick<TranscriptHead, 'cursor' | 'has_more' | 'pending' | 'availability'>>;

/** #26: what a watch reads: a worker's own transcript, or (`child`) one of its native children's. */
export interface TranscriptTarget {
  id: string;
  child?: TranscriptChild;
}

/** #26: a target's key: the worker id for its own transcript (as before #26), with the child's row for a child's. */
export const targetKey = (id: string, child?: TranscriptChild | null): string => (child ? `${id}\u0000${child.id}` : id);

/** Where a watched transcript goes. `child` (#26): the child watch's; absent, the worker's own. */
export interface TranscriptSink {
  /** A watch (or a re-watch) was acked: the whole timeline so far, replacing what was there. */
  reset(id: string, ack: TranscriptWatchAck, child?: TranscriptChild): void;
  /**
   * Live, after the ack: new items and whole replacements of items already sent (by `id`). `head`: the transcript they
   * are of, when the push says (the first one of a pending watch, once its transcript appeared).
   */
  push(id: string, items: TranscriptItem[], updates: TranscriptItem[], head?: PushHead, child?: TranscriptChild): void;
  /** Not watched any more (stood up, closed for good, the connection dropped). */
  stop(id: string, child?: TranscriptChild): void;
}

export interface TranscriptWatchHost {
  send<T extends 'transcript.watch' | 'transcript.unwatch'>(t: T, args: CommandArgs[T]): Promise<CommandResult>;
  sink: TranscriptSink;
  /** A watch was refused (`capacity`, `unknown_worker`, #26 a child's `stale` or `not_found`, …). */
  failed(id: string, code: string, message: string, child?: TranscriptChild): void;
  /**
   * The bridge ended a watch (`transcript.closed`); `session_changed`, `resync` and `not_found` are watched again. #26: a
   * child's `resync` and `not_found` are (its log went: the new ack says so), not its `session_changed` (its worker's
   * session was replaced: the child went with it) nor `evicted`.
   */
  closed(id: string, reason: string, child?: TranscriptChild): void;
  now(): number;
}

interface Watch {
  /** The worker, and (#26) the child whose transcript it is. */
  id: string;
  child?: TranscriptChild;
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
/** #26: a child watch's (another session is not the child's: it went with the old one). */
const CHILD_REWATCH = new Set(['resync', 'not_found']);
const AVAILABILITY = new Set<unknown>(['available', 'pending', 'unavailable']);

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
    ...(AVAILABILITY.has(d.availability) ? { availability: d.availability as TranscriptAvailability } : {}),
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
 *
 * #26: watches are by target (`targetKey`): a worker's own and one of its
 * children's are two watches side by side, each with its own acks, pushes
 * and back-off; a child's push or ack of another child or generation than
 * the one watched now is dropped.
 */
export class TranscriptWatches {
  /** By target (`targetKey`). */
  private readonly on = new Map<string, Watch>();
  /** Target → when it may be watched again (after a close or a refusal). */
  private readonly retryAt = new Map<string, number>();
  /** When each target's watch was last closed by the bridge (the re-watch back-off). */
  private readonly lastClose = new Map<string, number>();
  /** Targets whose sink starts over (`refresh`): the next `sync` that wants them hands it a fresh ack. */
  private readonly fresh = new Set<string>();
  private gen = 0;
  /** Why transcripts are off: the bridge does not know `transcript.watch`. */
  disabled: string | null = null;

  constructor(private readonly host: TranscriptWatchHost) {}

  get count(): number {
    return this.on.size;
  }

  /** The watched targets' keys (a worker's own: its id). */
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
   * items than wanted is made again (the bridge replaces the old one). #26: and `children`, children's transcripts (each
   * with `WATCH_LIMIT` items).
   */
  sync(want: ReadonlySet<string> | ReadonlyMap<string, number>, children: readonly TranscriptTarget[] = []): void {
    if (this.disabled) return;
    const limits = new Map<string, number>();
    const targets = new Map<string, TranscriptTarget>();
    if (want instanceof Map) for (const [id, n] of want) limits.set(id, n);
    else for (const id of want as ReadonlySet<string>) limits.set(id, WATCH_LIMIT);
    for (const id of limits.keys()) targets.set(id, { id });
    for (const t of children) {
      if (!t.child) continue;
      const key = targetKey(t.id, t.child);
      limits.set(key, WATCH_LIMIT);
      targets.set(key, t);
    }
    // A child of another generation is another target (its row id is too, but the bridge's answer says which it was).
    for (const [key, w] of [...this.on]) {
      const t = targets.get(key);
      if (!t || (w.child && t.child && w.child.generation !== t.child.generation)) this.unwatch(key);
    }
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
      this.watch(targets.get(id) as TranscriptTarget, Math.max(limit, w?.limit ?? 0));
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

  private watch(t: TranscriptTarget, limit = WATCH_LIMIT): void {
    const key = targetKey(t.id, t.child);
    const gen = ++this.gen;
    this.retryAt.delete(key);
    this.fresh.delete(key);
    const { id, child } = t;
    this.on.set(key, { id, ...(child ? { child } : {}), gen, limit, ready: false });
    void this.host.send('transcript.watch', { id, limit, ...(child ? { child } : {}) }).then((r) => {
      const w = this.on.get(key);
      if (!w || w.gen !== gen) return;
      if (!r.ok) {
        this.on.delete(key);
        this.retryAt.set(key, this.host.now() + FAIL_MS);
        this.host.sink.stop(id, child);
        if (r.code === 'unknown_command') this.disable(r.message);
        this.host.failed(id, r.code, r.message, child);
        return;
      }
      w.ready = true;
      this.host.sink.reset(id, watchAck(r.data), child);
    });
  }

  private unwatch(key: string): void {
    const w = this.on.get(key);
    if (!w) return;
    this.on.delete(key);
    this.host.sink.stop(w.id, w.child);
    void this.host.send('transcript.unwatch', { id: w.id, ...(w.child ? { child: w.child } : {}) });
  }

  private disable(why: string): void {
    this.disabled = why || 'the bridge does not know transcript.watch';
    for (const [key, w] of [...this.on]) {
      this.on.delete(key);
      this.host.sink.stop(w.id, w.child);
    }
    this.retryAt.clear();
    this.fresh.clear();
  }

  /** The watch a push or close is for: the one of its target, when it is the same child generation. */
  private of(id: string, child: unknown): Watch | undefined {
    const c = child && typeof child === 'object' ? (child as Partial<TranscriptChild>) : null;
    if (child !== undefined && (typeof c?.id !== 'string' || !c.id)) return undefined;
    const w = this.on.get(targetKey(id, c as TranscriptChild | null));
    if (!w || (w.child && w.child.generation !== c?.generation)) return undefined;
    return w;
  }

  items(m: TranscriptItems): void {
    const w = this.of(m.id, m.child);
    if (!w?.ready) return;
    const items = itemsOf(m.items);
    const updates = itemsOf(m.updates);
    let head: PushHead | undefined;
    if (typeof m.session === 'string') {
      head = { harness: typeof m.harness === 'string' ? m.harness : '', session: m.session };
      if (typeof m.cursor === 'string') head.cursor = m.cursor;
      if (typeof m.has_more === 'boolean') head.has_more = m.has_more;
      if (typeof m.pending === 'boolean') head.pending = m.pending;
      if (AVAILABILITY.has(m.availability)) head.availability = m.availability as TranscriptAvailability;
    }
    // #58: a pending watch's first push names the session even with nothing in it yet (the transcript appeared empty).
    if (items.length || updates.length || head) this.host.sink.push(w.id, items, updates, head, w.child);
  }

  closed(c: TranscriptClosed): void {
    const w = this.of(c.id, c.child);
    if (!w) return;
    const key = targetKey(w.id, w.child);
    this.on.delete(key);
    const now = this.host.now();
    const last = this.lastClose.get(key) ?? -Infinity;
    this.lastClose.set(key, now);
    if ((w.child ? CHILD_REWATCH : REWATCH).has(c.reason)) {
      // The view keeps what it shows until the new watch's ack replaces it; a close right after the last one waits.
      if (c.reason !== 'not_found' && now - last >= RETRY_MS) this.watch(w, w.limit);
      else this.retryAt.set(key, now + RETRY_MS);
    } else {
      this.retryAt.set(key, now + RETRY_MS);
      this.host.sink.stop(w.id, w.child);
    }
    this.host.closed(w.id, c.reason, w.child);
  }

  /** The connection dropped: the bridge forgot every watch (pushes are not replayed). */
  lost(): void {
    for (const [key, w] of [...this.on]) {
      this.on.delete(key);
      this.host.sink.stop(w.id, w.child);
    }
    this.retryAt.clear();
    this.lastClose.clear();
    this.fresh.clear();
  }
}
