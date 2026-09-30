import { describe, expect, it } from 'vitest';
import { postUpload, precheckUpload, UPLOAD_MAX_BYTES, uploadUrl } from './upload';

describe('uploadUrl', () => {
  it('sits beside /ws with its token, label and n', () => {
    expect(uploadUrl('ws://127.0.0.1:7777/ws?token=abc', { label: 'nibble', n: 2 })).toBe('http://127.0.0.1:7777/upload?token=abc&label=nibble&n=2');
    expect(uploadUrl('wss://host.example/ws?token=abc')).toBe('https://host.example/upload?token=abc');
  });
  it('keeps a fixture server’s query, drops the fragment and any old label / n, ignores a bad n', () => {
    expect(uploadUrl('ws://h:1/fixture/demo?sim=1&fail_upload=1&label=x&n=9#frag', { label: 'a', n: 3 })).toBe('http://h:1/upload?sim=1&fail_upload=1&label=a&n=3');
    expect(uploadUrl('ws://h:1/ws', { n: 0 })).toBe('http://h:1/upload');
    expect(uploadUrl('ws://h:1/ws', { n: 1.5 })).toBe('http://h:1/upload');
  });
});

describe('precheckUpload', () => {
  const f = (name: string, size = 100, type = '') => ({ name, size, type });
  it('lets PNG, JPEG, GIF and WebP through, by type or (with no type) by extension', () => {
    expect(precheckUpload(f('a.png', 10, 'image/png'))).toBeNull();
    expect(precheckUpload(f('a.jpg', 10, 'image/jpeg'))).toBeNull();
    expect(precheckUpload(f('a.gif', 10, 'image/gif'))).toBeNull();
    expect(precheckUpload(f('a.webp', 10, 'image/webp'))).toBeNull();
    expect(precheckUpload(f('shot.JPEG', 10, ''))).toBeNull();
    expect(precheckUpload(f('', 10, 'image/png'))).toBeNull();
  });
  it('refuses other types with a friendly message, even when the extension looks right', () => {
    expect(precheckUpload(f('a.svg', 10, 'image/svg+xml'))).toMatch(/a\.svg is not a PNG, JPEG, GIF or WebP/);
    expect(precheckUpload(f('a.heic', 10, 'image/heic'))).toMatch(/not a PNG/);
    expect(precheckUpload(f('a.png', 10, 'text/plain'))).toMatch(/not a PNG/);
    expect(precheckUpload(f('noext', 10, ''))).toMatch(/not a PNG/);
    expect(precheckUpload(f('', 10, 'application/pdf'))).toMatch(/^That file is not a PNG/);
  });
  it('refuses empty files and takes exactly the cap, refusing one byte more', () => {
    expect(precheckUpload(f('a.png', 0, 'image/png'))).toBe('a.png is empty.');
    expect(precheckUpload(f('ok.png', UPLOAD_MAX_BYTES, 'image/png'))).toBeNull();
    expect(precheckUpload(f('big.png', UPLOAD_MAX_BYTES + 1, 'image/png'))).toBe('big.png is 25.0 MB. Images can be up to 25 MB: export it smaller.');
  });
});

const reply = (status: number, body: unknown) => async () => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const OK = { data: { path: '/d/2026-09/h3d-a-1.png', mime: 'image/png', size: 3 } };

describe('postUpload', () => {
  it('POSTs the raw bytes to the upload URL and returns the path, mime and size', async () => {
    let seen: { url: string; init: RequestInit | undefined } | null = null;
    const file = new Blob(['xyz'], { type: 'image/png' });
    const r = await postUpload('ws://h:1/ws?token=t', file, { label: 'a', n: 1 }, undefined, async (url, init) => {
      seen = { url, init };
      return { ok: true, status: 200, json: async () => OK };
    });
    expect(r).toEqual({ ok: true, data: { path: '/d/2026-09/h3d-a-1.png', mime: 'image/png', size: 3 } });
    expect(seen).toMatchObject({ url: 'http://h:1/upload?token=t&label=a&n=1', init: { method: 'POST', body: file, headers: { 'Content-Type': 'image/png' } } });
  });

  it('sends octet-stream when the file has no type', async () => {
    let init: RequestInit | undefined;
    await postUpload('ws://h:1/ws', new Blob(['x']), {}, undefined, async (_u, i) => {
      init = i;
      return { ok: true, status: 200, json: async () => OK };
    });
    expect(init?.headers).toEqual({ 'Content-Type': 'application/octet-stream' });
  });

  it('maps the bridge’s error codes and messages', async () => {
    const f = new Blob(['x']);
    expect(await postUpload('ws://h:1/ws', f, {}, undefined, reply(413, { t: 'error', code: 'upload_too_large', message: 'over 25 MB' }))).toEqual({ ok: false, code: 'upload_too_large', message: 'over 25 MB' });
    expect(await postUpload('ws://h:1/ws', f, {}, undefined, reply(415, { t: 'error', code: 'upload_unsupported', message: 'not an image' }))).toMatchObject({ code: 'upload_unsupported' });
    expect(await postUpload('ws://h:1/ws', f, {}, undefined, reply(502, { t: 'error', code: 'dropzone_unavailable', message: 'Drop Zone is down' }))).toMatchObject({ code: 'dropzone_unavailable', message: 'Drop Zone is down' });
  });

  it('falls back on the status when the body is not the bridge’s', async () => {
    const f = new Blob(['x']);
    const notJson = async () => ({
      ok: false,
      status: 502,
      json: async () => {
        throw new Error('not json');
      },
    });
    expect(await postUpload('ws://h:1/ws', f, {}, undefined, notJson)).toEqual({ ok: false, code: 'offline', message: 'HTTP 502' });
    expect(await postUpload('ws://h:1/ws', f, {}, undefined, reply(403, null))).toMatchObject({ code: 'forbidden' });
    expect(await postUpload('ws://h:1/ws', f, {}, undefined, reply(500, {}))).toMatchObject({ code: 'internal', message: 'HTTP 500' });
  });

  it('refuses a success that carries no path', async () => {
    const f = new Blob(['x']);
    expect(await postUpload('ws://h:1/ws', f, {}, undefined, reply(200, { data: { path: 3 } }))).toMatchObject({ ok: false, code: 'dropzone_bad_response' });
    expect(await postUpload('ws://h:1/ws', f, {}, undefined, reply(200, null))).toMatchObject({ ok: false, code: 'dropzone_bad_response' });
  });

  it('answers offline when the network fails', async () => {
    const r = await postUpload('ws://h:1/ws', new Blob(['x']), {}, undefined, async () => {
      throw new TypeError('fetch failed');
    });
    expect(r).toEqual({ ok: false, code: 'offline', message: 'could not reach herdr-world' });
  });

  it('answers aborted when the caller cancels, and upload_timeout when it takes too long', async () => {
    const hang: Parameters<typeof postUpload>[4] = (_u, init) =>
      new Promise((_res, rej) => init?.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError'))));
    const ac = new AbortController();
    const p = postUpload('ws://h:1/ws', new Blob(['x']), {}, ac.signal, hang);
    ac.abort();
    expect(await p).toMatchObject({ ok: false, code: 'aborted' });
    expect(await postUpload('ws://h:1/ws', new Blob(['x']), {}, undefined, hang, 5)).toMatchObject({ ok: false, code: 'upload_timeout' });
  });
});
