import { describe, expect, it } from 'vitest';
import { openable, openExternal } from './external';

describe('openExternal', () => {
  it('opens only absolute http(s) urls', () => {
    expect(openable('https://github.com/a/b')).toBe(true);
    expect(openable('http://x.example')).toBe(true);
    for (const u of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,x', '/relative', 'github.com', '']) expect(openable(u), u).toBe(false);
  });

  it('asks the helper first, with its token', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const opened: string[] = [];
    const via = await openExternal('https://github.com/a/b/issues/1', {
      token: 'tok',
      fetch: async (url, init) => (calls.push({ url, init }), { status: 204 }),
      open: (u) => opened.push(u),
    });
    expect(via).toBe('helper');
    expect(opened).toEqual([]);
    expect(calls[0]?.url).toBe('/api/open');
    expect(calls[0]?.init.method).toBe('POST');
    expect((calls[0]?.init.headers as Record<string, string>)['x-h3d-token']).toBe('tok');
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ url: 'https://github.com/a/b/issues/1' });
  });

  it('opens a window when there is no helper, or it refuses the host', async () => {
    for (const fetch of [async () => ({ status: 404 }), async () => ({ status: 400 }), async () => Promise.reject(new Error('down'))]) {
      const opened: string[] = [];
      expect(await openExternal('https://docs.example/x', { token: null, fetch, open: (u) => opened.push(u) })).toBe('window');
      expect(opened).toEqual(['https://docs.example/x']);
    }
  });

  it('refuses what is not a web url', async () => {
    const opened: string[] = [];
    expect(await openExternal('javascript:alert(1)', { token: null, open: (u) => opened.push(u) })).toBe('refused');
    expect(opened).toEqual([]);
  });
});
