import { describe, expect, it } from 'vitest';
import { BridgeClient, type SocketLike } from './client';
import type { BoardMessage } from './protocol';

// M7: board.issues / board.prs carry no seq; they reach onBoard and never touch the event sequence.

class Sock implements SocketLike {
  sent: Array<{ t: string; req_id?: string; args?: unknown }> = [];
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
  const boards: BoardMessage[] = [];
  const events: number[] = [];
  const client = new BridgeClient({
    url: 'ws://x',
    clientName: 't',
    socket: () => (s = new Sock()),
    timers: { setTimeout: () => 0, clearTimeout: () => {} },
    handlers: { onSnapshot: () => {}, onEvent: (e) => events.push(e.seq), onBoard: (m) => boards.push(m) },
  });
  client.start();
  const sock = s as unknown as Sock;
  sock.onopen?.({});
  sock.recv({ t: 'welcome', proto: 1, server_seq: 5, epoch: 'e', resume: 'snapshot' });
  sock.recv({ t: 'world.snapshot', seq: 5, world: { buildings: [], unassigned: [], floors: [], workers: [] } });
  return { client, sock, boards, events };
}

const issues = { t: 'board.issues', session: 'herdr-3d', provider: 'github', provider_name: 'GitHub', initial: true, fetched_at: 1, columns: [], cards: [] };
const prs = { t: 'board.prs', session: 'herdr-3d', provider: 'github', provider_name: 'GitHub', initial: false, fetched_at: 1, prs: [], merged: [] };

describe('board messages', () => {
  it('reach onBoard without moving the sequence, in order', () => {
    const h = live();
    h.sock.recv(issues);
    h.sock.recv(prs);
    h.sock.recv({ t: 'worker.status', seq: 6, id: 'w', session: 's', workspace_id: 'x', status: 'idle' });
    expect(h.boards).toEqual([issues, prs]);
    expect(h.events).toEqual([6]);
    expect(h.client.resume.seq).toBe(6);
  });

  it('drops a malformed one and ignores unknown board.* types', () => {
    const h = live();
    h.sock.recv({ t: 'board.issues', session: 'x', columns: 'no', cards: [] });
    h.sock.recv({ t: 'board.prs', prs: [] });
    h.sock.recv({ t: 'board.future', session: 'x' });
    expect(h.boards).toEqual([]);
    expect(h.events).toEqual([]);
  });

  it('answers board.watch by req_id, and an older bridge’s unknown_command', async () => {
    const h = live();
    const p = h.client.request('board.watch', { floor: 'herdr-3d' });
    const sent = h.sock.sent.at(-1);
    expect(sent).toMatchObject({ t: 'board.watch', args: { floor: 'herdr-3d' } });
    h.sock.recv({ t: 'error', req_id: sent?.req_id, code: 'unknown_command', message: 'unknown command "board.watch"' });
    expect(await p).toEqual({ ok: false, code: 'unknown_command', message: 'unknown command "board.watch"' });
  });
});
