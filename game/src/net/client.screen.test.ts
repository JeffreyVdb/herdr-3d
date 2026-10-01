import { describe, expect, it } from 'vitest';
import { BridgeClient, type SocketLike } from './client';
import type { ConnMessage } from './protocol';

// M5: terminal.frame / terminal.closed carry no seq; they reach onConn and never touch the event sequence.

class Sock implements SocketLike {
  sent: Array<{ t: string }> = [];
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  send(d: string): void {
    this.sent.push(JSON.parse(d) as { t: string });
  }
  close(): void {}
  recv(m: object): void {
    this.onmessage?.({ data: JSON.stringify(m) });
  }
}

function live() {
  let s: Sock | null = null;
  const conn: ConnMessage[] = [];
  const events: number[] = [];
  const client = new BridgeClient({
    url: 'ws://x',
    clientName: 't',
    socket: () => (s = new Sock()),
    timers: { setTimeout: () => 0, clearTimeout: () => {} },
    handlers: { onSnapshot: () => {}, onEvent: (e) => events.push(e.seq), onConn: (m) => conn.push(m) },
  });
  client.start();
  const sock = s as unknown as Sock;
  sock.onopen?.({});
  sock.recv({ t: 'welcome', proto: 1, server_seq: 5, epoch: 'e', resume: 'snapshot' });
  sock.recv({ t: 'world.snapshot', seq: 5, world: { buildings: [], unassigned: [], floors: [], workers: [] } });
  return { client, sock, conn, events };
}

describe('connection-scoped screen messages', () => {
  it('hands frames and closes to onConn without moving the sequence', () => {
    const h = live();
    const frame = { t: 'terminal.frame', id: 'w1', pane: 'w1:p1', n: 1, full: true, cols: 120, rows: 36, data: 'JCA=' };
    h.sock.recv(frame);
    h.sock.recv({ t: 'terminal.closed', id: 'w1', reason: 'asleep' });
    h.sock.recv({ t: 'worker.status', seq: 6, id: 'w', session: 's', workspace_id: 'x', status: 'idle' });
    expect(h.conn).toEqual([frame, { t: 'terminal.closed', id: 'w1', reason: 'asleep' }]);
    expect(h.events).toEqual([6]);
    expect(h.client.resume.seq).toBe(6);
  });

  it('hands #74 terminal.state to onConn (no seq), and drops one without a valid zoom', () => {
    const h = live();
    const state = { t: 'terminal.state', id: 'w1', pane: 'w1:p1', cols: 131, rows: 47, zoom: { state: 'zoomed', applied: true } };
    h.sock.recv(state);
    h.sock.recv({ ...state, zoom: { state: 'huge', applied: true } });
    h.sock.recv({ ...state, zoom: undefined });
    h.sock.recv({ t: 'worker.status', seq: 6, id: 'w', session: 's', workspace_id: 'x', status: 'idle' });
    expect(h.conn).toEqual([state]);
    expect(h.client.resume.seq).toBe(6);
  });

  it('drops malformed frames', () => {
    const h = live();
    h.sock.recv({ t: 'terminal.frame', id: 'w1', n: 'one', full: true, cols: 1, rows: 1, data: '' });
    h.sock.recv({ t: 'terminal.closed', id: 'w1' });
    expect(h.conn).toEqual([]);
  });
});

// M16: transcript.items / transcript.closed are connection-scoped too.
describe('connection-scoped transcript messages', () => {
  it('hands items and closes to onConn without moving the sequence', () => {
    const h = live();
    const items = { t: 'transcript.items', id: 'w1', items: [{ id: 'a', seq: 1, ts: 0, kind: 'user', parts: [{ text: 'hi' }] }], updates: [] };
    h.sock.recv(items);
    h.sock.recv({ t: 'transcript.closed', id: 'w1', reason: 'session_changed' });
    h.sock.recv({ t: 'worker.status', seq: 6, id: 'w', session: 's', workspace_id: 'x', status: 'idle' });
    expect(h.conn).toEqual([items, { t: 'transcript.closed', id: 'w1', reason: 'session_changed' }]);
    expect(h.events).toEqual([6]);
  });

  it('drops malformed ones', () => {
    const h = live();
    h.sock.recv({ t: 'transcript.items', items: [] });
    h.sock.recv({ t: 'transcript.items', id: 'w1', items: 'x' });
    h.sock.recv({ t: 'transcript.closed', id: 'w1' });
    expect(h.conn).toEqual([]);
  });
});
