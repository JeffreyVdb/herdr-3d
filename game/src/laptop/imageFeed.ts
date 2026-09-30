import type { CommandResult } from '../net/client';
import type { CommandArgs, ImageRef, TranscriptImageAck, TranscriptImagesAck, TranscriptItem } from '../net/protocol';

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
  return { images, truncated: isObj(data) && data.truncated === true };
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
  /** Which subagent's timeline a hash came from (the bridge reads its log for it). */
  private readonly agentOf = new Map<string, string>();
  private readonly thumbs = new Map<string, Promise<ImageData | null>>();
  private readonly thumbData = new Map<string, ImageData>();
  private thumbBytes = 0;
  private readonly fulls = new Map<string, ImageData>();
  private list_: Promise<ImageRef[]> | null = null;
  private listed_: ImageRef[] | null = null;
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
  ) {}

  /** The feed learned of new images (`note` of items with images): the lists are stale. */
  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Items (a watch's ack, a push, a page) were shown to the connection: their hashes may be asked for. */
  note(items: readonly TranscriptItem[], agent?: string): ImageRef[] {
    const all: ImageRef[] = [];
    for (const it of items) for (const r of refsOfItem(it)) all.push(r);
    this.noteRefs(all, agent);
    return all;
  }

  noteRefs(refs: readonly ImageRef[], agent?: string): void {
    let fresh = false;
    for (const r of refs) {
      if (typeof r.hash !== 'string' || !r.hash || r.unavailable) continue;
      if (!this.sent.has(r.hash)) fresh = true;
      this.sent.add(r.hash);
      if (agent) this.agentOf.set(r.hash, agent);
    }
    if (fresh) this.changed();
  }

  /** A fresh watch (or another session): the hashes sent before, and the images fetched, belong to the old timeline. */
  reset(): void {
    this.sent.clear();
    this.agentOf.clear();
    this.list_ = null;
    this.listed_ = null;
    this.changed();
  }

  /** An item with images arrived: the session list is stale. */
  changed(): void {
    this.version++;
    this.list_ = null;
    for (const fn of [...this.listeners]) fn();
  }

  canFetch(ref: Pick<ImageRef, 'hash' | 'mime' | 'unavailable'>): boolean {
    return !!ref.hash && !ref.unavailable && ref.mime !== 'binary' && this.sent.has(ref.hash);
  }

  has(hash: string): boolean {
    return this.sent.has(hash);
  }

  // --- the session's images ---

  /** Every image of the session (the bridge's list), oldest first; asked once until an item with images arrives. */
  list(): Promise<ImageRef[]> {
    if (this.disposed) return Promise.resolve([]);
    if (this.list_) return this.list_;
    const p = (async () => {
      this.counts.lists++;
      const r = await this.host.send('transcript.images', { id: this.id });
      if (!r.ok) throw new Error(r.message || r.code);
      const refs = imagesAck(r.data).images;
      for (const ref of refs) if (typeof ref.hash === 'string' && ref.hash) this.sent.add(ref.hash);
      this.listed_ = refs;
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
    return this.host.send('transcript.image', { id: this.id, hash, size, ...(agent ? { agent } : {}) });
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

/** The feeds of the workers whose images are on screen. */
export class ImageFeeds {
  private readonly byId = new Map<string, ImageFeed>();

  constructor(private readonly host: ImageFeedHost) {}

  get(id: string): ImageFeed {
    let f = this.byId.get(id);
    if (!f || f.isDisposed) {
      f = new ImageFeed(id, this.host);
      this.byId.set(id, f);
    }
    return f;
  }

  peek(id: string): ImageFeed | null {
    return this.byId.get(id) ?? null;
  }

  drop(id: string): void {
    this.byId.get(id)?.dispose();
    this.byId.delete(id);
  }

  ids(): string[] {
    return [...this.byId.keys()];
  }

  dispose(): void {
    for (const f of this.byId.values()) f.dispose();
    this.byId.clear();
  }
}
