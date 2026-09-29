import * as THREE from 'three/webgpu';

/**
 * M3d: one texture per logo hash, shared by everything that shows the
 * building's logo (entrance sign, reception wall, the city sign). Fetched
 * once (concurrent asks for a hash share one request), decoded off the main
 * thread (`createImageBitmap`), mipmapped, and disposed when no building
 * uses the hash any more. A failed fetch is remembered, so the name shows
 * (no retry storm), until `retryFailed()` (a reconnect) or a new hash.
 *
 * Bytes are only ever stored under the hash they have. A response for another
 * hash (the logo was replaced between the building.upsert and the fetch) is a
 * *stale* miss: it is remembered for that URL only, never cached, and never
 * blocks another building that still advertises the hash (its own URL is
 * fetched when the first one comes back empty).
 */

export interface LogoEntry {
  hash: string;
  texture: THREE.Texture;
  /** Pixels of the stored logo: only its aspect matters. */
  width: number;
  height: number;
}

export interface DecodedLogo {
  image: THREE.Texture['image'];
  width: number;
  height: number;
  /** sha256 (hex) of the bytes the loader decoded, when it could tell. The cache refuses a logo whose hash is not the one asked for. */
  hash?: string | undefined;
}

/** The bridge no longer has the logo behind that hash (replaced or cleared), or the bytes are another logo's. */
export class LogoStaleError extends Error {}

export type LogoLoader = (url: string, hash: string) => Promise<DecodedLogo>;
export type TextureMaker = (d: DecodedLogo) => THREE.Texture;

/**
 * Fetches and decodes a logo. The bitmap is premultiplied and flipped at
 * decode time (a bitmap cannot be flipped by the GPU upload), so mipmaps of
 * a transparent edge do not pick up a dark fringe from the hidden colour.
 */
export const fetchLogo: LogoLoader = async (url, hash) => {
  const res = await fetch(url, { cache: 'default' });
  if (res.status === 404 || res.status === 409 || res.status === 410) throw new LogoStaleError(`logo ${res.status}`);
  if (!res.ok) throw new Error(`logo ${res.status}`);
  const buf = await res.arrayBuffer();
  // The hash names the bytes (sha256 of the stored PNG): check it, whatever the
  // server or a proxy did, before anything is cached under it. Without
  // crypto.subtle (an insecure origin) fall back to the ETag the bridge sets.
  const got = (await sha256Hex(buf)) ?? res.headers.get('etag')?.replace(/^W\//, '').replaceAll('"', '');
  if (got && got !== hash) throw new LogoStaleError(`logo bytes are ${got}, not ${hash}`);
  const blob = new Blob([buf], { type: res.headers.get('content-type') ?? 'image/png' });
  const bmp = await createImageBitmap(blob, { imageOrientation: 'flipY', premultiplyAlpha: 'premultiply', colorSpaceConversion: 'none' });
  return { image: bmp, width: bmp.width, height: bmp.height, hash: got ?? undefined };
};

async function sha256Hex(buf: ArrayBuffer): Promise<string | null> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return null;
  const d = new Uint8Array(await subtle.digest('SHA-256', buf));
  return Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('');
}

export const makeLogoTexture: TextureMaker = (d) => {
  const t = new THREE.Texture(d.image);
  t.colorSpace = THREE.SRGBColorSpace;
  t.flipY = false; // the bitmap is already flipped
  t.premultiplyAlpha = true; // and premultiplied: keep it so on the GPU (see logoMaterial)
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.anisotropy = 4;
  t.needsUpdate = true;
  return t;
};

export class LogoCache {
  private readonly entries = new Map<string, LogoEntry>();
  private readonly pending = new Map<string, Promise<LogoEntry | null>>();
  private readonly failed = new Set<string>();
  /** URL -> hash the bridge did not have there (see the class comment). */
  private readonly stale = new Map<string, string>();
  private disposed = false;
  /** Requests made, for tests and the `__h3d` hook. */
  fetches = 0;

  constructor(
    private readonly loader: LogoLoader = fetchLogo,
    private readonly make: TextureMaker = makeLogoTexture,
  ) {}

  /** The logo when it is loaded. */
  peek(hash: string | null): LogoEntry | null {
    return hash ? (this.entries.get(hash) ?? null) : null;
  }

  hasFailed(hash: string): boolean {
    return this.failed.has(hash);
  }

  /** The logo behind this hash could not be had (fetch failed, or the bridge has no such logo): the signs show the name. */
  unavailable(hash: string): boolean {
    if (this.entries.has(hash)) return false;
    return this.failed.has(hash) || [...this.stale.values()].includes(hash);
  }

  /** The bridge answered that this URL's logo is not that hash (any more): wait for the building's next hash. */
  isStale(url: string): boolean {
    return this.stale.has(url);
  }

  get size(): number {
    return this.entries.size;
  }

  /** Loads a logo (the URL should carry its hash); null when it cannot be fetched or decoded. */
  load(hash: string, url: string): Promise<LogoEntry | null> {
    if (this.disposed) return Promise.resolve(null);
    const have = this.entries.get(hash);
    if (have) return Promise.resolve(have);
    if (this.failed.has(hash) || this.stale.has(url)) return Promise.resolve(null);
    const inflight = this.pending.get(hash);
    if (inflight) return inflight;
    this.fetches++;
    const p = this.loader(url, hash).then(
      (d) => {
        this.pending.delete(hash);
        if (this.disposed) {
          (d.image as { close?: () => void } | null)?.close?.();
          return null;
        }
        if (d.hash !== undefined && d.hash !== hash) {
          (d.image as { close?: () => void } | null)?.close?.();
          this.stale.set(url, hash);
          return null;
        }
        const entry: LogoEntry = { hash, texture: this.make(d), width: d.width, height: d.height };
        this.entries.set(hash, entry);
        return entry;
      },
      (e: unknown) => {
        this.pending.delete(hash);
        if (e instanceof LogoStaleError) this.stale.set(url, hash);
        else this.failed.add(hash);
        return null;
      },
    );
    this.pending.set(hash, p);
    return p;
  }

  /** Forgets failures, so the next `load` fetches again; true when there were any. */
  retryFailed(): boolean {
    const any = this.failed.size > 0 || this.stale.size > 0;
    this.failed.clear();
    this.stale.clear();
    return any;
  }

  /**
   * Disposes every texture whose hash is not in `shown` (call after the views
   * have moved to the new ones), and forgets the failures of hashes that no
   * building has any more (`current`: the hashes buildings have now).
   */
  keep(shown: Iterable<string>, current: Iterable<string> = shown): void {
    const w = new Set(shown);
    for (const [hash, e] of this.entries) {
      if (w.has(hash)) continue;
      this.release(e);
      this.entries.delete(hash);
    }
    const c = new Set(current);
    for (const hash of this.failed) if (!c.has(hash)) this.failed.delete(hash);
    for (const [url, hash] of this.stale) if (!c.has(hash)) this.stale.delete(url);
  }

  dispose(): void {
    this.disposed = true;
    for (const e of this.entries.values()) this.release(e);
    this.entries.clear();
    this.failed.clear();
    this.stale.clear();
  }

  private release(e: LogoEntry): void {
    e.texture.dispose();
    (e.texture.image as { close?: () => void } | null)?.close?.();
  }
}
