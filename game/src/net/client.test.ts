import { describe, expect, it } from 'vitest';
import {
  BridgeClient,
  DEFAULT_COMMAND_TIMEOUT_MS,
  backoffDelay,
  eventDecision,
  helloFor,
  type ConnState,
  type SocketLike,
  type Timers,
} from './client';
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
  recv(msg: object | string): void {
    this.onmessage?.({ data: typeof msg === 'string' ? msg : JSON.stringify(msg) });
  }
  drop(code = 1006, reason = ''): void {
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

const snapshot = (seq: number): Snapshot => ({
  t: 'world.snapshot',
  seq,
  world: { buildings: [], unassigned: [], floors: [], workers: [] },
});
const status = (seq: number): WorldEvent => ({
  t: 'worker.status',
  seq,
  id: 'w',
  session: 's',
  workspace_id: 'w1',
  status: 'working',
});

function harness() {
  const sockets: FakeSocket[] = [];
  const timers = new FakeTimers();
  const got: string[] = [];
  const states: ConnState[] = [];
  const client = new BridgeClient({
    url: 'ws://x/ws',
    clientName: 'test',
    socket: (url) => {
      const s = new FakeSocket(url);
      sockets.push(s);
      return s;
    },
    timers,
    rand: () => 0.5,
    handlers: {
      onSnapshot: (s) => got.push(`snap@${s.seq}`),
      onEvent: (e) => got.push(`${e.t}@${e.seq}`),
      onState: (s) => states.push(s),
    },
  });
  const last = () => {
    const s = sockets.at(-1);
    if (!s) throw new Error('no socket');
    return s;
  };
  return { client, sockets, timers, got, states, last };
}

describe('helloFor', () => {
  it('asks for a snapshot without a resume point', () => {
    expect(helloFor('c', { epoch: null, seq: null })).toEqual({ t: 'hello', proto: 1, client: 'c' });
    expect(helloFor('c', { epoch: 'e', seq: null })).toEqual({ t: 'hello', proto: 1, client: 'c' });
  });
  it('asks for a replay with epoch + seq', () => {
    expect(helloFor('c', { epoch: 'e', seq: 7 })).toEqual({ t: 'hello', proto: 1, client: 'c', since_seq: 7, epoch: 'e' });
  });
});

describe('eventDecision', () => {
  it.each([
    [null, 1, 'resync'],
    [5, 5, 'skip'],
    [5, 3, 'skip'],
    [5, 6, 'apply'],
    [5, 8, 'resync'],
  ] as const)('last %s, seq %s -> %s', (last, seq, want) => {
    expect(eventDecision(last, seq)).toBe(want);
  });
});

describe('backoffDelay', () => {
  it('doubles up to the cap', () => {
    const o = { initialMs: 500, maxMs: 4000, jitter: 0 };
    expect([1, 2, 3, 4, 5, 9].map((a) => backoffDelay(a, o))).toEqual([500, 1000, 2000, 4000, 4000, 4000]);
  });
  it('jitters within ±jitter', () => {
    const o = { initialMs: 1000, maxMs: 10_000, jitter: 0.2 };
    expect(backoffDelay(1, o, () => 0)).toBe(800);
    expect(backoffDelay(1, o, () => 1)).toBe(1200);
  });
});

describe('BridgeClient', () => {
  it('handshakes, applies the snapshot and then events in order', () => {
    const h = harness();
    h.client.start();
    const s = h.last();
    expect(s.url).toBe('ws://x/ws');
    s.open();
    expect(s.sent).toEqual([{ t: 'hello', proto: 1, client: 'test' }]);
    s.recv({ t: 'welcome', proto: 1, server_seq: 10, epoch: 'E1', resume: 'snapshot' });
    s.recv(snapshot(10));
    expect(h.client.state).toMatchObject({ phase: 'live', epoch: 'E1' });
    s.recv(status(11));
    s.recv(status(11)); // duplicate
    s.recv({ t: 'freelancer.report', seq: 12, x: 1 }); // unknown type: not applied, but advances seq
    s.recv(status(13));
    s.recv('not json');
    s.recv({ t: 'ack', req_id: '1' });
    expect(h.got).toEqual(['snap@10', 'worker.status@11', 'worker.status@13']);
    expect(h.client.resume).toEqual({ epoch: 'E1', seq: 13 });
  });

  it('ignores events before the welcome and between welcome and snapshot', () => {
    const h = harness();
    h.client.start();
    const s = h.last();
    s.open();
    s.recv(status(1));
    s.recv({ t: 'welcome', proto: 1, server_seq: 3, epoch: 'E', resume: 'snapshot' });
    s.recv(status(2));
    s.recv(snapshot(3));
    s.recv(status(4));
    expect(h.got).toEqual(['snap@3', 'worker.status@4']);
  });

  it('reconnects with backoff and resumes with since_seq + epoch (replay)', () => {
    const h = harness();
    h.client.start();
    let s = h.last();
    s.open();
    s.recv({ t: 'welcome', proto: 1, server_seq: 5, epoch: 'E', resume: 'snapshot' });
    s.recv(snapshot(5));
    s.recv(status(6));
    s.drop(1001, 'going away');
    expect(h.client.state).toMatchObject({ phase: 'waiting', reason: 'going away' });
    expect(h.timers.fire()).toBe(500);
    s = h.last();
    expect(h.sockets).toHaveLength(2);
    s.open();
    expect(s.sent[0]).toEqual({ t: 'hello', proto: 1, client: 'test', since_seq: 6, epoch: 'E' });
    s.recv({ t: 'welcome', proto: 1, server_seq: 8, epoch: 'E', resume: 'replay' });
    expect(h.client.state).toMatchObject({ phase: 'live', resume: 'replay' });
    s.recv(status(7));
    s.recv(status(8));
    expect(h.got).toEqual(['snap@5', 'worker.status@6', 'worker.status@7', 'worker.status@8']);
  });

  it('takes a fresh snapshot when the bridge restarted (new epoch)', () => {
    const h = harness();
    h.client.start();
    let s = h.last();
    s.open();
    s.recv({ t: 'welcome', proto: 1, server_seq: 5, epoch: 'E', resume: 'snapshot' });
    s.recv(snapshot(5));
    s.drop();
    h.timers.fire();
    s = h.last();
    s.open();
    s.recv({ t: 'welcome', proto: 1, server_seq: 2, epoch: 'F', resume: 'snapshot' });
    s.recv(status(3)); // before the snapshot: dropped
    s.recv(snapshot(2));
    s.recv(status(3));
    expect(h.got).toEqual(['snap@5', 'snap@2', 'worker.status@3']);
    expect(h.client.resume).toEqual({ epoch: 'F', seq: 3 });
  });

  it('backs off exponentially while the bridge is down, and resets once live', () => {
    const h = harness();
    h.client.start();
    const delays: number[] = [];
    for (let i = 0; i < 4; i++) {
      h.last().drop();
      delays.push(h.timers.fire());
    }
    expect(delays).toEqual([500, 1000, 2000, 4000]);
    const s = h.last();
    s.open();
    s.recv({ t: 'welcome', proto: 1, server_seq: 0, epoch: 'E', resume: 'snapshot' });
    s.recv(snapshot(0));
    s.drop();
    expect(h.timers.fire()).toBe(500);
  });

  it('resyncs from a snapshot on a seq gap', () => {
    const h = harness();
    h.client.start();
    let s = h.last();
    s.open();
    s.recv({ t: 'welcome', proto: 1, server_seq: 5, epoch: 'E', resume: 'snapshot' });
    s.recv(snapshot(5));
    s.recv(status(7));
    expect(s.closed).not.toBeNull();
    s = h.last();
    expect(h.sockets).toHaveLength(2);
    s.open();
    expect(s.sent[0]).toEqual({ t: 'hello', proto: 1, client: 'test' });
  });

  it('gives up on unsupported_proto', () => {
    const h = harness();
    h.client.start();
    const s = h.last();
    s.open();
    s.recv({ t: 'error', code: 'unsupported_proto', message: 'proto 1 unsupported' });
    s.drop(1008, 'unsupported');
    expect(h.client.state).toMatchObject({ phase: 'failed' });
    expect(h.timers.queue).toHaveLength(0);
  });

  it('stop closes the socket and cancels the retry', () => {
    const h = harness();
    h.client.start();
    h.last().drop();
    expect(h.timers.queue).toHaveLength(1);
    h.client.stop();
    expect(h.timers.queue).toHaveLength(0);
    expect(h.client.state).toEqual({ phase: 'stopped' });
  });
});

describe('BridgeClient.request', () => {
  const live = () => {
    const h = harness();
    h.client.start();
    const s = h.last();
    s.open();
    s.recv({ t: 'welcome', proto: 1, server_seq: 5, epoch: 'E', resume: 'snapshot' });
    s.recv(snapshot(5));
    return { ...h, s };
  };

  it('sends the command with a fresh req_id and resolves with the ack data', async () => {
    const h = live();
    const p = h.client.request('building.create', { name: 'Work' });
    const sent = h.s.sent.at(-1) as { t: string; req_id: string; args: unknown };
    expect(sent).toMatchObject({ t: 'building.create', args: { name: 'Work' } });
    expect(sent.req_id).toBeTruthy();
    const q = h.client.request('building.create', { name: 'Home' });
    const second = h.s.sent.at(-1) as { req_id: string };
    expect(second.req_id).not.toBe(sent.req_id);
    h.s.recv({ t: 'ack', req_id: second.req_id });
    h.s.recv({ t: 'ack', req_id: sent.req_id, data: { id: 'b_1' } });
    expect(await p).toEqual({ ok: true, data: { id: 'b_1' } });
    expect(await q).toEqual({ ok: true, data: undefined });
  });

  it('applies the events a command causes before its promise resolves', async () => {
    const h = live();
    const p = h.client.request('floor.assign', { session: 's', building: null });
    const { req_id } = h.s.sent.at(-1) as { req_id: string };
    h.s.recv(status(6));
    h.s.recv({ t: 'ack', req_id });
    await p;
    expect(h.got).toEqual(['snap@5', 'worker.status@6']);
  });

  it('resolves an error reply as a failure with its code, and keeps the connection', async () => {
    const h = live();
    const p = h.client.request('floor.wake', { session: 's' });
    const { req_id } = h.s.sent.at(-1) as { req_id: string };
    h.s.recv({ t: 'error', req_id, code: 'unknown_command', message: 'unknown command "floor.wake"' });
    expect(await p).toEqual({ ok: false, code: 'unknown_command', message: 'unknown command "floor.wake"' });
    expect(h.client.state.phase).toBe('live');
    expect(h.s.closed).toBeNull();
  });

  it('fails at once when not connected', async () => {
    const h = harness();
    h.client.start();
    expect(await h.client.request('building.delete', { id: 'b' })).toMatchObject({ ok: false, code: 'offline' });
    expect(h.last().sent).toEqual([]);
  });

  it('times out per command: a slow floor.wake ack is not a failure at the default timeout', async () => {
    const h = live();
    const wake = h.client.request('floor.wake', { session: 's' });
    const create = h.client.request('building.create', { name: 'x' });
    const timeouts = h.timers.queue.map((t) => t.ms).sort((a, b) => a - b);
    expect(timeouts[0]).toBe(DEFAULT_COMMAND_TIMEOUT_MS);
    expect(timeouts[1]).toBeGreaterThanOrEqual(45_000); // wake answers after every worker resumed (~20 s)
    // The short one fires first; the wake is still pending and gets its late ack.
    h.timers.queue.sort((a, b) => a.ms - b.ms);
    h.timers.fire();
    expect(await create).toMatchObject({ ok: false, code: 'timeout' });
    const { req_id } = h.s.sent.find((m) => (m as { t: string }).t === 'floor.wake') as { req_id: string };
    h.s.recv({ t: 'ack', req_id, data: { workers: [] } });
    expect(await wake).toEqual({ ok: true, data: { workers: [] } });
    expect(h.timers.queue).toHaveLength(0);
  });

  it('ignores an ack that arrives after its timeout', async () => {
    const h = live();
    const p = h.client.request('building.rename', { id: 'b', name: 'n' }, { timeoutMs: 100 });
    const { req_id } = h.s.sent.at(-1) as { req_id: string };
    h.timers.fire();
    expect(await p).toMatchObject({ ok: false, code: 'timeout' });
    h.s.recv({ t: 'ack', req_id });
    h.s.recv(status(6));
    expect(h.got).toEqual(['snap@5', 'worker.status@6']);
  });

  it('#110: gives a packup.detect 1.5 s, then drops its late match', async () => {
    const h = live();
    const p = h.client.request('packup.detect', { id: 'w', text: 'Please make a PR and end your turn' });
    const { req_id } = h.s.sent.at(-1) as { req_id: string };
    expect(h.timers.queue.map((t) => t.ms)).toEqual([1_500]);
    h.timers.fire();
    expect(await p).toMatchObject({ ok: false, code: 'timeout' });
    h.s.recv({ t: 'ack', req_id, data: { matched: true, task: 'Please make a PR', removed: [{ start: 16, end: 34 }], score: 0.97 } });
    h.s.recv(status(6));
    expect(h.got).toEqual(['snap@5', 'worker.status@6']);
  });

  it('fails pending commands when the connection drops (they may still have run)', async () => {
    const h = live();
    const p = h.client.request('floor.sleep', { session: 's' });
    h.s.drop(1001, 'going away');
    expect(await p).toMatchObject({ ok: false, code: 'disconnected' });
    expect(h.timers.queue.map((t) => t.ms)).toEqual([500]); // only the reconnect timer is left
  });
});
