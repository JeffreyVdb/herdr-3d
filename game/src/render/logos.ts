import * as THREE from 'three/webgpu';

/**
 * M3d: one texture per logo hash, shared by everything that shows the
 * building's logo (entrance sign, reception wall, the city sign). Fetched
 * once (concurrent asks for a hash share one request), decoded off the main
 * thread (`createImageBitmap`), mipmapped, and disposed when no building
 * uses the hash any more. A failed fetch is remembered, so the name shows
 * (no retry storm), until `retryFailed()` (a reconnect) or a new hash.
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
}

export type LogoLoader = (url: string) => Promise<DecodedLogo>;
export type TextureMaker = (d: DecodedLogo) => THREE.Texture;

/**
 * Fetches and decodes a logo. The bitmap is premultiplied and flipped at
 * decode time (a bitmap cannot be flipped by the GPU upload), so mipmaps of
 * a transparent edge do not pick up a dark fringe from the hidden colour.
 */
export const fetchLogo: LogoLoader = async (url) => {
  const res = await fetch(url, { cache: 'default' });
  if (!res.ok) throw new Error(`logo ${res.status}`);
  const blob = await res.blob();
  const bmp = await createImageBitmap(blob, { imageOrientation: 'flipY', premultiplyAlpha: 'premultiply', colorSpaceConversion: 'none' });
  return { image: bmp, width: bmp.width, height: bmp.height };
};

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

  get size(): number {
    return this.entries.size;
  }

  /** Loads a logo (the URL should carry its hash); null when it cannot be fetched or decoded. */
  load(hash: string, url: string): Promise<LogoEntry | null> {
    if (this.disposed) return Promise.resolve(null);
    const have = this.entries.get(hash);
    if (have) return Promise.resolve(have);
    if (this.failed.has(hash)) return Promise.resolve(null);
    const inflight = this.pending.get(hash);
    if (inflight) return inflight;
    this.fetches++;
    const p = this.loader(url).then(
      (d) => {
        this.pending.delete(hash);
        if (this.disposed) {
          (d.image as { close?: () => void } | null)?.close?.();
          return null;
        }
        const entry: LogoEntry = { hash, texture: this.make(d), width: d.width, height: d.height };
        this.entries.set(hash, entry);
        return entry;
      },
      () => {
        this.pending.delete(hash);
        this.failed.add(hash);
        return null;
      },
    );
    this.pending.set(hash, p);
    return p;
  }

  /** Forgets failures, so the next `load` fetches again; true when there were any. */
  retryFailed(): boolean {
    const any = this.failed.size > 0;
    this.failed.clear();
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
  }

  dispose(): void {
    this.disposed = true;
    for (const e of this.entries.values()) this.release(e);
    this.entries.clear();
    this.failed.clear();
  }

  private release(e: LogoEntry): void {
    e.texture.dispose();
    (e.texture.image as { close?: () => void } | null)?.close?.();
  }
}
