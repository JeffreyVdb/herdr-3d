import { describe, expect, it } from 'vitest';
import { TOKEN_KEY, bridgeUrl, takeToken, type LocationLike, type StorageLike } from './endpoint';

const loc = (over: Partial<LocationLike> = {}): LocationLike => ({
  protocol: 'http:',
  host: '127.0.0.1:7777',
  pathname: '/',
  search: '',
  hash: '',
  ...over,
});

class MemStorage implements StorageLike {
  m = new Map<string, string>();
  getItem(k: string): string | null {
    return this.m.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.m.set(k, v);
  }
}

describe('takeToken', () => {
  it('moves #token into storage and strips it from the URL', () => {
    const st = new MemStorage();
    const urls: string[] = [];
    expect(takeToken(loc({ hash: '#token=abc123', search: '?backend=webgl2' }), st, (u) => urls.push(u))).toBe('abc123');
    expect(st.getItem(TOKEN_KEY)).toBe('abc123');
    expect(urls).toEqual(['/?backend=webgl2']);
  });
  it('keeps other hash params', () => {
    const urls: string[] = [];
    takeToken(loc({ hash: '#token=t&x=1' }), new MemStorage(), (u) => urls.push(u));
    expect(urls).toEqual(['/#x=1']);
  });
  it('falls back to storage after a reload', () => {
    const st = new MemStorage();
    st.setItem(TOKEN_KEY, 'kept');
    const urls: string[] = [];
    expect(takeToken(loc(), st, (u) => urls.push(u))).toBe('kept');
    expect(urls).toEqual([]);
  });
  it('survives missing or throwing storage', () => {
    const bad: StorageLike = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    };
    expect(takeToken(loc(), bad, () => {})).toBeNull();
    expect(takeToken(loc({ hash: '#token=z' }), bad, () => {})).toBe('z');
    expect(takeToken(loc(), null, () => {})).toBeNull();
  });
});

describe('bridgeUrl', () => {
  it('defaults to same-origin /ws with the token', () => {
    expect(bridgeUrl(loc(), 'abc')).toBe('ws://127.0.0.1:7777/ws?token=abc');
    expect(bridgeUrl(loc(), null)).toBe('ws://127.0.0.1:7777/ws');
    expect(bridgeUrl(loc({ protocol: 'https:', host: 'h.example.net' }), 't')).toBe('wss://h.example.net/ws?token=t');
  });
  it('honours an absolute ?ws= override', () => {
    const search = `?ws=${encodeURIComponent('ws://127.0.0.1:9001/ws')}&backend=webgl2`;
    expect(bridgeUrl(loc({ search }), null)).toBe('ws://127.0.0.1:9001/ws');
  });
  it('resolves a path override against the page and switches the scheme', () => {
    expect(bridgeUrl(loc({ search: '?ws=/fixture/demo%3Fplay%3Dnone' }), 'k')).toBe(
      'ws://127.0.0.1:7777/fixture/demo?play=none&token=k',
    );
    expect(bridgeUrl(loc({ search: '?ws=http://localhost:5000/ws' }), null)).toBe('ws://localhost:5000/ws');
  });
});
