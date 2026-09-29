import { describe, expect, it } from 'vitest';
import { deleteLogo, LOGO_MAX_BYTES, logoUrl, precheckLogo, putLogo } from './logo';

describe('logoUrl', () => {
  it('sits beside /ws with its token and hash', () => {
    expect(logoUrl('ws://127.0.0.1:7777/ws?token=abc', 'b_1', 'deadbeef')).toBe('http://127.0.0.1:7777/logo/b_1?token=abc&h=deadbeef');
    expect(logoUrl('wss://host.example/ws?token=abc', 'b_1')).toBe('https://host.example/logo/b_1?token=abc');
  });
  it('works for a ?ws= override and without a token', () => {
    expect(logoUrl('ws://127.0.0.1:9000/fixture/demo', 'b 2')).toBe('http://127.0.0.1:9000/logo/b%202');
  });
  it('keeps the rest of the query (a fixture server’s world key) and drops the fragment and any old hash', () => {
    expect(logoUrl('ws://h:1/fixture/demo?sim=1&simlogo=k1&token=t#frag', 'b', 'abc')).toBe('http://h:1/logo/b?sim=1&simlogo=k1&token=t&h=abc');
    expect(logoUrl('ws://h:1/ws?h=old&token=t', 'b')).toBe('http://h:1/logo/b?token=t');
  });
});

describe('precheckLogo', () => {
  const f = (name: string, size = 100, type = '') => ({ name, size, type });
  it('lets PNG, WebP and SVG through, by type or by extension', () => {
    expect(precheckLogo(f('a.png', 10, 'image/png'))).toBeNull();
    expect(precheckLogo(f('a.webp', 10, 'image/webp'))).toBeNull();
    expect(precheckLogo(f('a.svg', 10, 'image/svg+xml'))).toBeNull();
    expect(precheckLogo(f('logo.SVG', 10, ''))).toBeNull();
    expect(precheckLogo(f('noext', 10, 'image/png'))).toBeNull();
  });
  it('refuses other types with a friendly message', () => {
    expect(precheckLogo(f('a.jpg', 10, 'image/jpeg'))).toMatch(/not a PNG, WebP or SVG/);
    expect(precheckLogo(f('a.gif', 10, 'image/gif'))).toMatch(/not a PNG, WebP or SVG/);
    expect(precheckLogo(f('notes.txt', 10, 'text/plain'))).toMatch(/notes\.txt is not a PNG/);
  });
  it('refuses empty and over 1 MiB files, and takes exactly 1 MiB', () => {
    expect(precheckLogo(f('a.png', 0, 'image/png'))).toMatch(/empty/);
    expect(precheckLogo(f('big.png', LOGO_MAX_BYTES + 1, 'image/png'))).toMatch(/big\.png is 1\.0 MB\. Logos can be up to 1 MB/);
    expect(precheckLogo(f('ok.png', LOGO_MAX_BYTES, 'image/png'))).toBeNull();
  });
});

const reply = (status: number, body: unknown) => async () => ({ ok: status >= 200 && status < 300, status, json: async () => body });

describe('putLogo / deleteLogo', () => {
  it('PUTs the file to the logo URL and returns the ack data', async () => {
    let seen: { url: string; init: RequestInit | undefined } | null = null;
    const file = new Blob(['x'], { type: 'image/png' });
    const r = await putLogo('ws://h:1/ws?token=t', 'b_1', file, async (url, init) => {
      seen = { url, init };
      return { ok: true, status: 200, json: async () => ({ t: 'ack', data: { logo: 'abc' } }) };
    });
    expect(r).toEqual({ ok: true, data: { logo: 'abc' } });
    expect(seen).toMatchObject({ url: 'http://h:1/logo/b_1?token=t', init: { method: 'PUT', body: file } });
  });
  it('DELETEs', async () => {
    let method = '';
    const r = await deleteLogo('ws://h:1/ws?token=t', 'b_1', async (_u, init) => {
      method = init?.method ?? '';
      return { ok: true, status: 200, json: async () => ({ t: 'ack' }) };
    });
    expect(r.ok).toBe(true);
    expect(method).toBe('DELETE');
  });
  it('turns the bridge’s error body into a failure', async () => {
    const r = await putLogo('ws://h:1/ws', 'b', new Blob(['x']), reply(413, { t: 'error', code: 'logo_too_large', message: 'the file is over 1048576 bytes' }));
    expect(r).toEqual({ ok: false, code: 'logo_too_large', message: 'the file is over 1048576 bytes' });
  });
  it('maps a helper or network failure to offline / forbidden', async () => {
    expect(await putLogo('ws://h:1/ws', 'b', new Blob(['x']), reply(502, null))).toMatchObject({ ok: false, code: 'offline' });
    expect(await putLogo('ws://h:1/ws', 'b', new Blob(['x']), reply(403, null))).toMatchObject({ ok: false, code: 'forbidden' });
    expect(await deleteLogo('ws://h:1/ws', 'b', async () => { throw new TypeError('network'); })).toMatchObject({ ok: false, code: 'offline' });
    expect(await deleteLogo('ws://h:1/ws', 'b', reply(500, 'oops'))).toMatchObject({ ok: false, code: 'internal' });
  });
});
