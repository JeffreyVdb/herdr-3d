import { beforeEach, describe, expect, it } from 'vitest';
import type { SocketLike } from './client';
import { setBridgeScope } from './bridgeScope';
import { BridgeBook, type BridgeList } from './bridges';
import type { LocationLike } from './endpoint';
import { Preopened } from './preopen';
import { applyBridgeList, FIRST_HELLO, handOver, LAST_BRIDGE_KEY, socketUrl, startEarly, type EarlyStart } from './startup';

class MemStorage {
  readonly m = new Map<string, string>();
  get length(): number {
    return this.m.size;
  }
  key(i: number): string | null {
    return [...this.m.keys()][i] ?? null;
  }
  getItem(k: string): string | null {
    return this.m.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.m.set(k, v);
  }
  removeItem(k: string): void {
    this.m.delete(k);
  }
}

class RawSocket implements SocketLike {
  closed: { code?: number | undefined; reason?: string | undefined } | null = null;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  constructor(readonly url: string) {}
  send(): void {}
  close(code?: number, reason?: string): void {
    this.closed = { code, reason };
  }
}

const loc = (search = '', host = '127.0.0.1:7777'): LocationLike => ({ protocol: 'http:', host, pathname: '/', search, hash: '' });
const list = (active: string, ...ids: string[]): BridgeList => ({ active, bridges: ids.map((id) => ({ id, name: id }) as BridgeList['bridges'][number]) });

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** startEarly with its three inputs held open, and every socket it opens. */
function early(o: Partial<Pick<EarlyStart, 'token' | 'location'>> & { storage?: MemStorage } = {}) {
  const init = deferred<void>();
  const listed = deferred<BridgeList | null>();
  const fonts = deferred<unknown>();
  const sockets: RawSocket[] = [];
  const book = new BridgeBook(null);
  const storage = o.storage ?? new MemStorage();
  const opts: EarlyStart = {
    init: init.promise,
    list: listed.promise,
    fonts: fonts.promise,
    token: o.token ?? null,
    book,
    storage,
    location: o.location ?? loc(),
    preopen: (url) =>
      new Preopened(
        url,
        (u) => {
          const s = new RawSocket(u);
          sockets.push(s);
          return s;
        },
        FIRST_HELLO,
      ),
  };
  const done = startEarly(opts);
  return { init, listed, fonts, sockets, book, storage, opts, done };
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

beforeEach(() => setBridgeScope(null));

describe('socketUrl (#146: one helper for the pre-opened socket and the game)', () => {
  it('the ?ws= fixture path, no token', () => {
    expect(socketUrl(loc(`?ws=${encodeURIComponent('/fixture/demo?play=none')}`, '127.0.0.1:5173'), null, { list: null })).toBe('ws://127.0.0.1:5173/fixture/demo?play=none');
  });

  it('open=none changes nothing about the socket (it only keeps links from opening a browser)', () => {
    const ws = `ws=${encodeURIComponent('/fixture/demo?play=none')}`;
    expect(socketUrl(loc(`?${ws}&open=none`), null, { list: null })).toBe(socketUrl(loc(`?${ws}`), null, { list: null }));
  });

  it('the helper path: the token and the bridge in use', () => {
    const book = new BridgeBook(null);
    applyBridgeList(list('b1', 'b0', 'b1'), 'tok', book, new MemStorage());
    expect(socketUrl(loc(), 'tok', book)).toBe('ws://127.0.0.1:7777/ws?token=tok&bridge=b1');
  });

  it('a helper with no bridge: bridge=none', () => {
    const book = new BridgeBook(null);
    applyBridgeList(list(''), 'tok', book, new MemStorage());
    expect(socketUrl(loc(), 'tok', book)).toBe('ws://127.0.0.1:7777/ws?token=tok&bridge=none');
  });

  it('the helper did not answer in time: the bridge it last named', () => {
    const storage = new MemStorage();
    storage.setItem(LAST_BRIDGE_KEY, 'b7');
    const book = new BridgeBook(null);
    applyBridgeList(null, 'tok', book, storage);
    expect(socketUrl(loc(), 'tok', book)).toBe('ws://127.0.0.1:7777/ws?token=tok&bridge=b7');
  });

  it('no answer and none remembered: no bridge named', () => {
    const book = new BridgeBook(null);
    applyBridgeList(null, 'tok', book, new MemStorage());
    expect(socketUrl(loc(), 'tok', book)).toBe('ws://127.0.0.1:7777/ws?token=tok');
  });
});

describe('startEarly (#146)', () => {
  it('opens the socket once the list is in, while the renderer is still starting, at the URL the game will use', async () => {
    const h = early({ token: 'tok' });
    h.listed.resolve(list('b1', 'b1'));
    await flush();
    expect(h.sockets.map((s) => s.url)).toEqual(['ws://127.0.0.1:7777/ws?token=tok&bridge=b1']);
    expect(h.storage.getItem(LAST_BRIDGE_KEY)).toBe('b1');
    // The game computes its URL after this, with the same helper and inputs.
    expect(socketUrl(h.opts.location, 'tok', h.book)).toBe(h.sockets[0]?.url);
    h.init.resolve();
    h.fonts.resolve(undefined);
    const pre = await h.done;
    expect(pre.url).toBe(h.sockets[0]?.url);
  });

  it('the fixture path (no helper): opens at once', async () => {
    const h = early({ location: loc(`?ws=${encodeURIComponent('/fixture/demo?play=none')}`, '127.0.0.1:5173') });
    h.listed.resolve(null);
    await flush();
    expect(h.sockets.map((s) => s.url)).toEqual(['ws://127.0.0.1:5173/fixture/demo?play=none']);
  });

  it('the helper not answering in time: opens to the bridge remembered', async () => {
    const storage = new MemStorage();
    storage.setItem(LAST_BRIDGE_KEY, 'b7');
    const h = early({ token: 'tok', storage });
    h.listed.resolve(null);
    await flush();
    expect(h.sockets[0]?.url).toBe('ws://127.0.0.1:7777/ws?token=tok&bridge=b7');
  });

  it('the renderer failed before the list came: no socket is ever opened', async () => {
    const h = early({ token: 'tok' });
    h.init.reject(new Error('no GPU'));
    await expect(h.done).rejects.toThrow('no GPU');
    h.listed.resolve(list('b1', 'b1'));
    await flush();
    expect(h.sockets).toHaveLength(0);
  });

  it('the renderer failed after the socket opened: it is closed', async () => {
    const h = early();
    h.listed.resolve(null);
    await flush();
    h.init.reject(new Error('no GPU'));
    await expect(h.done).rejects.toThrow('no GPU');
    expect(h.sockets[0]?.closed).toMatchObject({ code: 1000, reason: 'not used' });
  });
});

describe('handOver (#146)', () => {
  it('gives the game a factory whose first socket is the pre-opened one', () => {
    const raw = new RawSocket('ws://x/ws');
    const pre = new Preopened('ws://x/ws', () => raw, FIRST_HELLO);
    const opened: string[] = [];
    const first = handOver(pre, (u) => (opened.push(u), new RawSocket(u)), (socket) => [socket('ws://x/ws'), socket('ws://x/ws')]);
    expect(first[0]).not.toBe(raw); // the view the client drives
    expect(first[1]).toBeInstanceOf(RawSocket);
    expect(opened).toEqual(['ws://x/ws']);
    expect(raw.closed).toBeNull();
  });

  it('building the game threw: the pre-opened socket is closed and the error passed on', () => {
    const raw = new RawSocket('ws://x/ws');
    const pre = new Preopened('ws://x/ws', () => raw, FIRST_HELLO);
    expect(() =>
      handOver(pre, (u) => new RawSocket(u), () => {
        throw new Error('constructor failed');
      }),
    ).toThrow('constructor failed');
    expect(raw.closed).toMatchObject({ code: 1000, reason: 'not used' });
  });
});
