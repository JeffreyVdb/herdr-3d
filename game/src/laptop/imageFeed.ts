import type { CommandResult } from '../net/client';
import type { CommandArgs, ImageRef, TranscriptChild, TranscriptImageAck, TranscriptImagesAck, TranscriptItem } from '../net/protocol';
import { targetKey } from './transcriptWatches';

/**
 * M16 phase 2: the images of one worker's watched transcript, fetched by hash.
 *
 * The bridge only serves a hash it sent this connection (an item, a page, the image list), and never takes a path: the
 * feed remembers which hashes it saw (`note`) and asks for nothing else. Thumbnails (480 px, PNG or JPEG) are fetched
 * a few at a time and kept in a small cache of blobs with object URLs (`<img>` and the desk prints' textures both start
 * from them); the full image is fetched on demand and only the last few are kept.
 *
 * One feed per worker whose images are on screen (the one you sit at, the desks with prints); `ImageFeeds` owns them.
 */

export interface ImageFeedHost {
  send<T extends 'transcript.image' | 'transcript.images'>(t: T, args: CommandArgs[T]): Promise<CommandResult>;
}

export interface ImageData {
  blob: Blob;
  /** An object URL of `blob`, valid until the feed drops it (cache eviction, `dispose`). */
  url: string;
  width: number;
  height: number;
  mime: string;
}

export type FullImage =
  | ({ ok: true; bytes: number } & ImageData)
  /** `too_large`: over 12 MiB of base64, the thumbnail is all there is; `not_available`: gone; `error`: try again. */
  | { ok: false; reason: 'too_large' | 'not_available' | 'error'; message: string };

/** Thumbnails asked for at once. */
export const THUMB_PARALLEL = 4;
/** Thumbnails kept: at most this many, and this many bytes. */
export const THUMB_KEEP = 240;
export const THUMB_KEEP_BYTES = 40 << 20;
/** Refs asked for per `transcript.images` request. A list takes as many as the session needs (no cap). */
export const LIST_PAGE = 1000;
/** Image places remembered to tell a new one from a re-sent item. */
const MAX_SEEN = 50_000;
/** Full images kept (they are big). */
export const FULL_KEEP = 3;

function toBlob(b64: string, mime: string): Blob {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/** A `transcript.image` ack, checked. */
export function imageAck(data: unknown): TranscriptImageAck | null {
  if (!isObj(data)) return null;
  const { mime, width, height, bytes, size, data: b64 } = data;
  if (typeof mime !== 'string' || typeof b64 !== 'string' || (size !== 'thumb' && size !== 'full')) return null;
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  return { mime, width: n(width), height: n(height), bytes: n(bytes), size, data: b64 };
}

/** The refs of a `transcript.images` ack that look like refs. */
export function imagesAck(data: unknown): TranscriptImagesAck {
  const list = isObj(data) && Array.isArray(data.images) ? data.images : [];
  const images = list.filter((r): r is ImageRef => isObj(r) && typeof r.source === 'string' && (r.origin === 'input' || r.origin === 'agent'));
  const cursor = isObj(data) && typeof data.cursor === 'string' && data.cursor ? data.cursor : undefined;
  return { images, ...(cursor ? { cursor } : {}), ...(isObj(data) && data.has_more === true ? { has_more: true } : {}) };
}

/** Every image ref in items (parts and tool output), in order. */
export function refsOfItem(it: TranscriptItem): ImageRef[] {
  const out: ImageRef[] = [];
  const add = (p: unknown) => {
    if (isObj(p) && isObj(p.image) && typeof p.image.source === 'string') out.push(p.image as unknown as ImageRef);
  };
  for (const p of Array.isArray(it.parts) ? it.parts : []) add(p);
  for (const p of Array.isArray(it.tool?.images) ? (it.tool?.images ?? []) : []) add(p);
  return out;
}

interface Queued {
  run: () => void;
  cancelled: boolean;
}

export class ImageFeed {
  /** Hashes the bridge sent this connection for this worker (the only ones it will serve). */
  private readonly sent = new Set<string>();
  /** The image occurrences (item, place in the item, what it resolved to) the main timeline showed: a new one is a list change. */
  private readonly seen = new Set<string>();
  /** Which subagent's timeline a hash came from (the bridge reads its log for it). */
  private readonly agentOf = new Map<string, string>();
  private readonly thumbs = new Map<string, Promise<ImageData | null>>();
  private readonly thumbData = new Map<string, ImageData>();
  private thumbBytes = 0;
  private readonly fulls = new Map<string, ImageData>();
  private list_: Promise<ImageRef[]> | null = null;
  private listed_: ImageRef[] | null = null;
  /** Lists started, and which of them `listed_` came from: an older one that ends late does not replace a newer one. */
  private lists = 0;
  private listedBy = 0;
  /** Bumps on `reset`: a list that was paging the old timeline stops. */
  private timeline = 0;
  private queue: Queued[] = [];
  private running = 0;
  private disposed = false;
  /** Bumps when the list may have changed (a push carried an image). */
  version = 0;
  private readonly listeners = new Set<() => void>();
  /** Requests made, for the tests. */
  readonly counts = { thumbs: 0, fulls: 0, lists: 0 };

  constructor(
    readonly id: string,
    private readonly host: ImageFeedHost,
    /** #26: the child whose transcript this is (its watch's images only: the bridge authorizes per watch); none, the worker's. */
    readonly child?: TranscriptChild,
  ) {}

  /** The feed learned of new images (`note` of items with images): the lists are stale. */
  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /**
   * Items (a watch's ack, a push, a page) were shown to the connection: their hashes may be asked for. `agent`: they are
   * a subagent's (the bridge reads that log for their bytes); they are not in the session list, which does not change.
   */
  note(items: readonly TranscriptItem[], agent?: string): ImageRef[] {
    const all: ImageRef[] = [];
    let fresh = false;
    for (const it of items) {
      refsOfItem(it).forEach((r, j) => {
        if (this.see(r, it.id, j, agent)) fresh = true;
        all.push(r);
      });
    }
    if (fresh) this.changed();
    return all;
  }

  noteRefs(refs: readonly ImageRef[], agent?: string): void {
    const at = new Map<string, number>();
    let fresh = false;
    for (const r of refs) {
      const item = r.item_id ?? '';
      const j = at.get(item) ?? 0;
      at.set(item, j + 1);
      if (this.see(r, item, j, agent)) fresh = true;
    }
    if (fresh) this.changed();
  }

  /**
   * One ref was shown. Its hash may be fetched from now on. True when it is a change of the session list: a place in
   * the timeline not seen before (a new item's image, also one whose bytes are already known, or that is not available),
   * or a ref that resolved to something else (a file that appeared).
   */
  private see(r: ImageRef, item: string, j: number, agent?: string): boolean {
    if (typeof r.hash === 'string' && r.hash && !r.unavailable) {
      // A hash the main timeline showed stays read from it.
      if (agent && !this.sent.has(r.hash)) this.agentOf.set(r.hash, agent);
      this.sent.add(r.hash);
    }
    if (agent) return false;
    const k = `${item}#${j}:${r.hash ?? ''}:${r.unavailable ? (r.reason ?? '?') : ''}`;
    if (this.seen.has(k)) return false;
    if (this.seen.size >= MAX_SEEN) this.seen.clear();
    this.seen.add(k);
    return true;
  }

  /** A fresh watch (or another session): the hashes sent before, and the images fetched, belong to the old timeline. */
  reset(): void {
    this.sent.clear();
    this.agentOf.clear();
    this.seen.clear();
    this.list_ = null;
    this.listed_ = null;
    this.timeline++;
    this.changed();
  }

  /** An item with images arrived: the session list is stale. */
  changed(): void {
    this.version++;
    this.list_ = null;
    for (const fn of [...this.listeners]) fn();
  }

  /** #98: a hash its worker's activity shows (`activity.image`): the bridge serves it to a connection on that floor. */
  admit(hash: string): void {
    if (!this.disposed && hash) this.sent.add(hash);
  }

  canFetch(ref: Pick<ImageRef, 'hash' | 'mime' | 'unavailable'>): boolean {
    return !!ref.hash && !ref.unavailable && ref.mime !== 'binary' && this.sent.has(ref.hash);
  }

  has(hash: string): boolean {
    return this.sent.has(hash);
  }

  // --- the session's images ---

  /**
   * Every image of the session (the bridge's list), oldest first; asked once until an item with images arrives. The
   * cursor is followed until the bridge has no more, however many pages that takes: nothing is cut off. A bridge whose
   * cursor does not move on (one it gave before, or none while it says there is more) fails the list, which the Images
   * tab shows, rather than looping or passing a part for the whole.
   */
  list(): Promise<ImageRef[]> {
    if (this.disposed) return Promise.resolve([]);
    if (this.list_) return this.list_;
    const mine = ++this.lists;
    const timeline = this.timeline;
    const p = (async (): Promise<ImageRef[]> => {
      this.counts.lists++;
      // The newest run first, then the older ones by cursor.
      const pages: ImageRef[][] = [];
      const cursors = new Set<string>();
      let before: string | undefined;
      for (;;) {
        const r = await this.host.send('transcript.images', { id: this.id, limit: LIST_PAGE, ...(before ? { before } : {}), ...(this.child ? { child: this.child } : {}) });
        if (this.disposed) return [];
        // Another timeline began (a fresh watch): these pages are the old one's; list the new one instead.
        if (this.timeline !== timeline) return this.list();
        if (!r.ok) throw new Error(r.message || r.code);
        const a = imagesAck(r.data);
        pages.push(a.images);
        if (!a.has_more) break;
        if (!a.cursor) throw new Error('the bridge said there are more images but gave no cursor');
        if (cursors.has(a.cursor)) throw new Error('the bridge repeated a page of the image list');
        cursors.add(a.cursor);
        before = a.cursor;
      }
      const refs = pages.reverse().flat();
      for (const ref of refs) if (typeof ref.hash === 'string' && ref.hash) this.sent.add(ref.hash);
      if (mine > this.listedBy) {
        this.listed_ = refs;
        this.listedBy = mine;
      }
      return refs;
    })();
    this.list_ = p;
    p.catch(() => {
      if (this.list_ === p) this.list_ = null;
    });
    return p;
  }

  /** The last list that came (null: none yet). */
  listed(): ImageRef[] | null {
    return this.listed_;
  }

  // --- bytes ---

  private enqueue<T>(job: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const q: Queued = {
        cancelled: false,
        run: () => {
          this.running++;
          void job()
            .then(resolve, reject)
            .finally(() => {
              this.running--;
              this.pump();
            });
        },
      };
      signal?.addEventListener('abort', () => {
        if (this.queue.includes(q)) {
          q.cancelled = true;
          this.queue = this.queue.filter((x) => x !== q);
          reject(new DOMException('aborted', 'AbortError'));
        }
      });
      this.queue.push(q);
      this.pump();
    });
  }

  private pump(): void {
    while (this.running < THUMB_PARALLEL && this.queue.length) {
      const q = this.queue.shift() as Queued;
      if (!q.cancelled) q.run();
    }
  }

  private request(hash: string, size: 'thumb' | 'full'): Promise<CommandResult> {
    const agent = this.agentOf.get(hash);
    return this.host.send('transcript.image', { id: this.id, hash, size, ...(this.child ? { child: this.child } : agent ? { agent } : {}) });
  }

  private make(ack: TranscriptImageAck): ImageData {
    const blob = toBlob(ack.data, ack.mime);
    return { blob, url: URL.createObjectURL(blob), width: ack.width, height: ack.height, mime: ack.mime };
  }

  /**
   * The thumbnail of an image, or null when it is not available (unknown hash, gone, binary, refused). Asked once per
   * hash; a failure other than "not available" is forgotten so that the next look tries again.
   */
  thumb(hash: string, signal?: AbortSignal): Promise<ImageData | null> {
    if (this.disposed || !this.sent.has(hash)) return Promise.resolve(null);
    const have = this.thumbs.get(hash);
    if (have) {
      // Most recently used goes last.
      this.thumbs.delete(hash);
      this.thumbs.set(hash, have);
      return have;
    }
    const p = this.enqueue(async () => {
      this.counts.thumbs++;
      const r = await this.request(hash, 'thumb');
      if (!r.ok) {
        if (r.code !== 'not_found') this.thumbs.delete(hash);
        return null;
      }
      const ack = imageAck(r.data);
      if (!ack || this.disposed) return null;
      const d = this.make(ack);
      this.thumbData.set(hash, d);
      this.thumbBytes += d.blob.size;
      this.evict();
      return d;
    }, signal).catch((e: unknown) => {
      this.thumbs.delete(hash);
      if (e instanceof DOMException && e.name === 'AbortError') return null;
      return null;
    });
    this.thumbs.set(hash, p);
    return p;
  }

  /** The thumbnail if it is here already. */
  thumbNow(hash: string): ImageData | null {
    return this.thumbData.get(hash) ?? null;
  }

  private evict(): void {
    for (const [hash] of this.thumbs) {
      if (this.thumbData.size <= THUMB_KEEP && this.thumbBytes <= THUMB_KEEP_BYTES) break;
      const d = this.thumbData.get(hash);
      if (!d) continue;
      this.thumbData.delete(hash);
      this.thumbs.delete(hash);
      this.thumbBytes -= d.blob.size;
      URL.revokeObjectURL(d.url);
    }
  }

  /** The full image. Never throws; `too_large` means the thumbnail is all that can be shown. */
  async full(hash: string): Promise<FullImage> {
    if (this.disposed || !this.sent.has(hash)) return { ok: false, reason: 'not_available', message: 'This image is not available.' };
    const have = this.fulls.get(hash);
    if (have) {
      this.fulls.delete(hash);
      this.fulls.set(hash, have);
      return { ok: true, bytes: have.blob.size, ...have };
    }
    let r: CommandResult;
    try {
      this.counts.fulls++;
      r = await this.enqueue(() => this.request(hash, 'full'));
    } catch (e) {
      return { ok: false, reason: 'error', message: e instanceof Error ? e.message : 'The request failed.' };
    }
    if (!r.ok) {
      if (r.code === 'too_large') return { ok: false, reason: 'too_large', message: 'This image is too large to open here: the thumbnail is shown.' };
      if (r.code === 'not_found') return { ok: false, reason: 'not_available', message: 'This image is not available any more.' };
      return { ok: false, reason: 'error', message: r.message || r.code };
    }
    const ack = imageAck(r.data);
    if (!ack || this.disposed) return { ok: false, reason: 'error', message: 'The bridge sent an image that could not be read.' };
    const d = this.make(ack);
    this.fulls.set(hash, d);
    while (this.fulls.size > FULL_KEEP) {
      const [old, od] = this.fulls.entries().next().value as [string, ImageData];
      this.fulls.delete(old);
      URL.revokeObjectURL(od.url);
    }
    return { ok: true, bytes: d.blob.size, ...d };
  }

  /** Drops everything: URLs revoked, queued requests forgotten, later answers ignored. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const d of this.thumbData.values()) URL.revokeObjectURL(d.url);
    for (const d of this.fulls.values()) URL.revokeObjectURL(d.url);
    this.thumbData.clear();
    this.fulls.clear();
    this.thumbs.clear();
    this.queue = [];
    this.listeners.clear();
    this.sent.clear();
  }

  get isDisposed(): boolean {
    return this.disposed;
  }
}

/** The feeds of the workers whose images are on screen (#26: and of a child's transcript, by its target). */
export class ImageFeeds {
  private readonly byId = new Map<string, ImageFeed>();

  constructor(private readonly host: ImageFeedHost) {}

  get(id: string, child?: TranscriptChild): ImageFeed {
    const key = targetKey(id, child);
    let f = this.byId.get(key);
    if (!f || f.isDisposed) {
      f = new ImageFeed(id, this.host, child);
      this.byId.set(key, f);
    }
    return f;
  }

  peek(id: string, child?: TranscriptChild): ImageFeed | null {
    return this.byId.get(targetKey(id, child)) ?? null;
  }

  drop(id: string, child?: TranscriptChild): void {
    const key = targetKey(id, child);
    this.byId.get(key)?.dispose();
    this.byId.delete(key);
  }

  ids(): string[] {
    return [...this.byId.keys()];
  }

  dispose(): void {
    for (const f of this.byId.values()) f.dispose();
    this.byId.clear();
  }
}
