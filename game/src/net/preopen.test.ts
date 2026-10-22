import { describe, expect, it } from 'vitest';
import { BridgeClient, helloFor, type ConnState, type SocketLike, type Timers } from './client';
import { firstPreopened, Preopened } from './preopen';
import type { Snapshot, WorldEvent } from './protocol';

class FakeSocket implements SocketLike {
  sent: unknown[] = [];
  closed: { code?: number | undefined; reason?: string | undefined } | null = null;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  constructor(readonly url: string) {}
  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }
  close(code?: number, reason?: string): void {
    this.closed = { code, reason };
  }
  open(): void {
    this.onopen?.({});
  }
  recv(msg: object): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  fail(code = 1006, reason = ''): void {
    this.onerror?.({});
    this.onclose?.({ code, reason });
  }
}

class FakeTimers implements Timers {
  queue: Array<{ fn: () => void; ms: number; id: number }> = [];
  private n = 0;
  setTimeout(fn: () => void, ms: number): unknown {
    const id = ++this.n;
    this.queue.push({ fn, ms, id });
    return id;
  }
  clearTimeout(h: unknown): void {
    this.queue = this.queue.filter((t) => t.id !== h);
  }
  fire(): number {
    const t = this.queue.shift();
    if (!t) throw new Error('no timer');
    t.fn();
    return t.ms;
  }
}

const URL = 'ws://x/ws?token=t&bridge=b1';
const CLIENT = 'test';
const HELLO = JSON.stringify(helloFor(CLIENT, { epoch: null, seq: null }));
const welcome = (seq: number, epoch = 'E') => ({ t: 'welcome', proto: 1, server_seq: seq, epoch, resume: 'snapshot' });
const snapshot = (seq: number): Snapshot => ({ t: 'world.snapshot', seq, world: { buildings: [], unassigned: [], floors: [], workers: [] } });
const status = (seq: number): WorldEvent => ({ t: 'worker.status', seq, id: 'w', session: 's', workspace_id: 'w1', status: 'working' });
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

/** A pre-opened socket (sockets[0]) and a client whose factory offers it first; every later socket is a new fake. */
function harness(clientUrl = URL) {
  const sockets: FakeSocket[] = [];
  const make = (url: string) => {
    const s = new FakeSocket(url);
    sockets.push(s);
    return s;
  };
  const pre = new Preopened(URL, make, HELLO);
  const timers = new FakeTimers();
  const got: string[] = [];
  const states: ConnState[] = [];
  const client = new BridgeClient({
    url: clientUrl,
    clientName: CLIENT,
    socket: firstPreopened(pre, make),
    timers,
    rand: () => 0.5,
    handlers: {
      onSnapshot: (s) => got.push(`snap@${s.seq}`),
      onEvent: (e) => got.push(`${e.t}@${e.seq}`),
      onState: (s) => states.push(s),
    },
  });
  const raw = sockets[0] as FakeSocket;
  return { pre, raw, client, sockets, timers, got, states };
}

describe('Preopened (#146)', () => {
  it('says hello as soon as it opens, before any client', () => {
    const h = harness();
    h.raw.open();
    expect(h.raw.sent).toEqual([{ t: 'hello', proto: 1, client: CLIENT }]);
  });

  it('already open with the welcome and snapshot in: one hello on the wire, everything delivered in order', async () => {
    const h = harness();
    h.raw.open();
    h.raw.recv(welcome(5));
    h.raw.recv(snapshot(5));
    h.raw.recv(status(6));
    h.client.start();
    expect(h.sockets).toHaveLength(1); // the pre-opened one, no second socket
    expect(h.got).toEqual([]); // replayed in a microtask, once every handler is set
    await tick();
    expect(h.got).toEqual(['snap@5', 'worker.status@6']);
    expect(h.client.state).toMatchObject({ phase: 'live', epoch: 'E', resume: 'snapshot' });
    h.raw.recv(status(7)); // after the replay: straight through
    expect(h.got).toEqual(['snap@5', 'worker.status@6', 'worker.status@7']);
    expect(h.raw.sent).toEqual([{ t: 'hello', proto: 1, client: CLIENT }]);
  });

  it('opens only after the client took it: still one hello', async () => {
    const h = harness();
    h.client.start();
    await tick();
    h.raw.open();
    h.raw.recv(welcome(1));
    h.raw.recv(snapshot(1));
    expect(h.raw.sent).toEqual([{ t: 'hello', proto: 1, client: CLIENT }]);
    expect(h.got).toEqual(['snap@1']);
    expect(h.client.state.phase).toBe('live');
  });

  it('keeps the order of what arrives between the take and the replay', async () => {
    const h = harness();
    h.raw.open();
    h.raw.recv(welcome(1));
    h.client.start();
    h.raw.recv(snapshot(1)); // after the take, before the replay
    h.raw.recv(status(2));
    await tick();
    expect(h.got).toEqual(['snap@1', 'worker.status@2']);
  });

  it('sends the client requests once live (only the hello is dropped, once)', async () => {
    const h = harness();
    h.raw.open();
    h.raw.recv(welcome(1));
    h.raw.recv(snapshot(1));
    h.client.start();
    await tick();
    void h.client.request('floor.wake', { floor: 's' });
    expect(h.raw.sent).toEqual([{ t: 'hello', proto: 1, client: CLIENT }, { t: 'floor.wake', req_id: 'g1', args: { floor: 's' } }]);
  });

  it('closed before the client took it (the helper refused the upgrade): a failed connect, then a new socket', async () => {
    const h = harness();
    h.raw.fail(1006, '');
    h.client.start();
    await tick();
    expect(h.client.state).toMatchObject({ phase: 'waiting', attempt: 1 });
    expect(h.timers.fire()).toBe(500); // the normal backoff
    expect(h.sockets).toHaveLength(2);
    const s = h.sockets[1] as FakeSocket;
    expect(s.url).toBe(URL);
    s.open();
    expect(s.sent).toEqual([{ t: 'hello', proto: 1, client: CLIENT }]); // the client's own hello on its own socket
  });

  it('opened, got the welcome, then closed before the take: delivered as it happened, then a reconnect', async () => {
    const h = harness();
    h.raw.open();
    h.raw.recv(welcome(3));
    h.raw.recv(snapshot(3));
    h.raw.fail(1001, 'going away');
    h.client.start();
    await tick();
    expect(h.got).toEqual(['snap@3']);
    expect(h.client.state).toMatchObject({ phase: 'waiting', reason: 'going away' });
    h.timers.fire();
    const s = h.sockets[1] as FakeSocket;
    s.open();
    // A resume: the client asks for a replay from what the pre-opened socket gave it.
    expect(s.sent).toEqual([{ t: 'hello', proto: 1, client: CLIENT, since_seq: 3, epoch: 'E' }]);
  });

  it('serves the first connect only: a reconnect after a drop makes a new socket', async () => {
    const h = harness();
    h.raw.open();
    h.raw.recv(welcome(1));
    h.raw.recv(snapshot(1));
    h.client.start();
    await tick();
    h.raw.fail();
    h.timers.fire();
    expect(h.sockets).toHaveLength(2);
    h.sockets[1]?.fail();
    h.timers.fire();
    expect(h.sockets).toHaveLength(3);
  });

  it('a resync (seq gap) on it closes it and connects anew', async () => {
    const h = harness();
    h.raw.open();
    h.raw.recv(welcome(1));
    h.raw.recv(snapshot(1));
    h.raw.recv(status(3)); // gap
    h.client.start();
    await tick();
    expect(h.raw.closed).toMatchObject({ code: 1000 });
    expect(h.sockets).toHaveLength(2);
    expect(h.got).toEqual(['snap@1']);
  });

  it('stop() before the replay: closed, and nothing delivered after it', async () => {
    const h = harness();
    h.raw.open();
    h.raw.recv(welcome(1));
    h.raw.recv(snapshot(1));
    h.client.start();
    h.client.stop();
    await tick();
    expect(h.raw.closed).toMatchObject({ code: 1000, reason: 'client stop' });
    expect(h.got).toEqual([]);
    expect(h.client.state.phase).toBe('stopped');
  });

  it('another URL: closes it and the client opens its own', () => {
    const h = harness('ws://x/ws?token=t&bridge=b2');
    h.raw.open();
    h.client.start();
    expect(h.raw.closed).toMatchObject({ code: 1000, reason: 'not used' });
    expect(h.raw.onmessage).toBeNull();
    expect(h.sockets).toHaveLength(2);
    expect(h.sockets[1]?.url).toBe('ws://x/ws?token=t&bridge=b2');
  });

  it('close() when nothing took it closes the socket; once taken it is the client’s', async () => {
    const left = harness();
    left.raw.open();
    left.pre.close();
    expect(left.raw.closed).toMatchObject({ code: 1000, reason: 'not used' });
    expect(left.pre.take(URL)).toBeNull();

    const taken = harness();
    taken.client.start();
    taken.pre.close();
    expect(taken.raw.closed).toBeNull();
  });
});
