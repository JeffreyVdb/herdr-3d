import * as THREE from 'three/webgpu';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchLogo, LogoCache, LogoStaleError, type DecodedLogo } from './logos';

const decoded = (w = 100, h = 50): DecodedLogo => ({ image: { close() {} } as never, width: w, height: h });

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}

describe('LogoCache', () => {
  it('fetches a hash once, however many ask at the same time', async () => {
    const urls: string[] = [];
    const d = deferred<DecodedLogo>();
    const cache = new LogoCache((u) => (urls.push(u), d.promise));
    const a = cache.load('aaaa1111', 'http://x/logo/b?h=aaaa1111');
    const b = cache.load('aaaa1111', 'http://x/logo/c?h=aaaa1111');
    expect(cache.peek('aaaa1111')).toBeNull();
    d.resolve(decoded(200, 40));
    const [ea, eb] = await Promise.all([a, b]);
    expect(urls).toEqual(['http://x/logo/b?h=aaaa1111']);
    expect(ea).toBe(eb);
    expect(ea).toMatchObject({ hash: 'aaaa1111', width: 200, height: 40 });
    expect(ea?.texture).toBeInstanceOf(THREE.Texture);
    expect(cache.peek('aaaa1111')).toBe(ea);
    // Later asks are served from the cache.
    expect(await cache.load('aaaa1111', 'http://x/other')).toBe(ea);
    expect(cache.fetches).toBe(1);
  });

  it('sets the texture up: sRGB, mipmapped, anisotropic', async () => {
    const cache = new LogoCache(async () => decoded());
    const t = (await cache.load('h1', 'u'))!.texture;
    expect(t.colorSpace).toBe(THREE.SRGBColorSpace);
    expect(t.generateMipmaps).toBe(true);
    expect(t.minFilter).toBe(THREE.LinearMipmapLinearFilter);
    expect(t.anisotropy).toBe(4);
    expect(t.premultiplyAlpha).toBe(true);
  });

  it('returns null for a failed fetch, remembers it, and retries on request', async () => {
    let fail = true;
    let calls = 0;
    const cache = new LogoCache(async () => {
      calls++;
      if (fail) throw new Error('404');
      return decoded();
    });
    expect(await cache.load('h1', 'u')).toBeNull();
    expect(cache.hasFailed('h1')).toBe(true);
    expect(await cache.load('h1', 'u')).toBeNull();
    expect(calls).toBe(1); // no retry storm
    fail = false;
    expect(await cache.load('h2', 'u')).not.toBeNull(); // another hash is fetched
    expect(cache.retryFailed()).toBe(true);
    expect(cache.retryFailed()).toBe(false);
    expect(await cache.load('h1', 'u')).not.toBeNull();
    expect(calls).toBe(3);
  });

  it('forgets a failure only when no building has that hash any more', async () => {
    let calls = 0;
    const cache = new LogoCache(async () => {
      calls++;
      throw new Error('404');
    });
    await cache.load('gone', 'u');
    cache.keep([], ['gone']); // still the building's hash, nothing shown
    expect(cache.hasFailed('gone')).toBe(true);
    await cache.load('gone', 'u');
    expect(calls).toBe(1);
    cache.keep([], []); // the hash changed: a later return to it fetches again
    expect(cache.hasFailed('gone')).toBe(false);
  });

  it('disposes the textures nobody wants any more, and only those', async () => {
    const cache = new LogoCache(async () => decoded());
    const a = (await cache.load('a', 'u'))!;
    const b = (await cache.load('b', 'u'))!;
    let disposed = '';
    a.texture.addEventListener('dispose', () => (disposed += 'a'));
    b.texture.addEventListener('dispose', () => (disposed += 'b'));
    cache.keep(['b']);
    expect(disposed).toBe('a');
    expect(cache.peek('a')).toBeNull();
    expect(cache.peek('b')).toBe(b);
    expect(cache.size).toBe(1);
    // A hash that was evicted is fetched again when it comes back.
    expect(await cache.load('a', 'u')).not.toBe(a);
  });

  it('disposes everything on dispose(), and ignores a fetch that finishes afterwards', async () => {
    const d = deferred<DecodedLogo>();
    const cache = new LogoCache(() => d.promise);
    const ready = new LogoCache(async () => decoded());
    const e = (await ready.load('a', 'u'))!;
    let gone = false;
    e.texture.addEventListener('dispose', () => (gone = true));
    ready.dispose();
    expect(gone).toBe(true);
    expect(await ready.load('z', 'u')).toBeNull();

    const late = cache.load('late', 'u');
    cache.dispose();
    d.resolve(decoded());
    expect(await late).toBeNull();
    expect(cache.size).toBe(0);
  });
});

// The race: building A's logo was replaced (H1 -> H2) after the client read
// A's building.upsert (H1) but before it fetched. B still advertises H1.
describe('LogoCache and a logo that changed under a hash', () => {
  const urlA = 'http://x/logo/A?h=H1';
  const urlB = 'http://x/logo/B?h=H1';

  it('does not cache a stale answer under the old hash, and B still gets its own image', async () => {
    const asked: string[] = [];
    const cache = new LogoCache(async (u, hash) => {
      asked.push(u);
      if (u === urlA) throw new LogoStaleError('logo 404'); // the bridge has H2 for A now
      return { ...decoded(64, 64), hash };
    });
    // Both buildings ask at once: they share A's request, which comes back empty.
    const [a, b] = await Promise.all([cache.load('H1', urlA), cache.load('H1', urlB)]);
    expect(a).toBeNull();
    expect(b).toBeNull();
    expect(cache.peek('H1')).toBeNull(); // nothing filed under H1
    expect(cache.size).toBe(0);
    expect(cache.hasFailed('H1')).toBe(false); // not a failure of the hash
    expect(cache.isStale(urlA)).toBe(true);
    expect(cache.isStale(urlB)).toBe(false);
    // A is not asked again for H1 (its next upsert carries H2) ...
    expect(await cache.load('H1', urlA)).toBeNull();
    expect(asked).toEqual([urlA]);
    // ... and B's own request gets the image.
    const e = await cache.load('H1', urlB);
    expect(e).toMatchObject({ hash: 'H1', width: 64 });
    expect(cache.peek('H1')).toBe(e);
    expect(asked).toEqual([urlA, urlB]);
    // A's new hash is fetched as usual.
    expect(await cache.load('H2', 'http://x/logo/A?h=H2')).toMatchObject({ hash: 'H2' });
  });

  it('refuses bytes whose hash is not the one asked for', async () => {
    let closed = 0;
    const image = { close: () => closed++ } as never;
    const cache = new LogoCache(async () => ({ image, width: 8, height: 8, hash: 'H2' })); // A's new image, under H1's URL
    expect(await cache.load('H1', urlA)).toBeNull();
    expect(closed).toBe(1);
    expect(cache.peek('H1')).toBeNull();
    expect(cache.peek('H2')).toBeNull(); // not filed under the hash it does have either: nobody asked for it
    expect(cache.size).toBe(0);
    expect(cache.isStale(urlA)).toBe(true);
  });

  it('accepts a loader that cannot tell the hash (no crypto, no ETag)', async () => {
    const cache = new LogoCache(async () => decoded());
    expect(await cache.load('H1', urlA)).not.toBeNull();
  });

  it('forgets a stale URL when no building has its hash any more, and on retryFailed', async () => {
    let calls = 0;
    const cache = new LogoCache(async () => {
      calls++;
      throw new LogoStaleError('logo 404');
    });
    await cache.load('H1', urlA);
    cache.keep([], ['H1']);
    expect(cache.isStale(urlA)).toBe(true);
    cache.keep([], ['H2']); // A's upsert with H2 arrived
    expect(cache.isStale(urlA)).toBe(false);
    await cache.load('H1', urlA);
    expect(cache.retryFailed()).toBe(true);
    expect(cache.isStale(urlA)).toBe(false);
    expect(calls).toBe(2);
  });
});

describe('fetchLogo', () => {
  const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
  const sha = async (b: Uint8Array) =>
    Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', b as BufferSource)), (x) => x.toString(16).padStart(2, '0')).join('');
  const reply = (status: number, body: Uint8Array | null, headers: Record<string, string> = {}) =>
    vi.stubGlobal('fetch', async () => new Response(body as BodyInit | null, { status, headers: { 'content-type': 'image/png', ...headers } }));

  afterEach(() => vi.unstubAllGlobals());

  it('decodes the bytes when they hash to the hash asked for', async () => {
    const bmp = { width: 5, height: 3, close() {} };
    vi.stubGlobal('createImageBitmap', async () => bmp);
    const h = await sha(png);
    reply(200, png, { etag: `"${h}"` });
    expect(await fetchLogo('http://x/logo/A?h=' + h, h)).toMatchObject({ width: 5, height: 3, hash: h });
  });

  it('treats a 404 (the logo changed) and bytes of another hash as stale, and other errors as failures', async () => {
    const bmp = vi.fn(async () => ({ width: 1, height: 1, close() {} }));
    vi.stubGlobal('createImageBitmap', bmp);
    reply(404, new Uint8Array());
    await expect(fetchLogo('u', 'H1')).rejects.toBeInstanceOf(LogoStaleError);
    reply(200, png); // an old server: 200 with the current image for whatever ?h=
    await expect(fetchLogo('u', 'H1')).rejects.toBeInstanceOf(LogoStaleError);
    expect(bmp).not.toHaveBeenCalled(); // never decoded
    reply(500, new Uint8Array());
    const err = await fetchLogo('u', 'H1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(LogoStaleError);
  });
});
