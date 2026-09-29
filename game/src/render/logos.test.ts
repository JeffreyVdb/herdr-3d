import * as THREE from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { LogoCache, type DecodedLogo } from './logos';

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
