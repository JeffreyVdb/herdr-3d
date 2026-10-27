import { describe, expect, it, vi } from 'vitest';
import type { ConnMessage, TerminalFrame } from '../net/protocol';
import { RunTerminalBroker, type RunSurface } from './runTerminal';

type Call = [string, { id: string; control?: boolean }];

/** A surface that records what the broker tells it and, holding, watches as a mounted run terminal does. */
function surface(broker: RunTerminalBroker, watch: (t: 'terminal.watch', a: { id: string; control: boolean }) => void, id: string, kind: 'dialog' | 'seat') {
  const log: string[] = [];
  const s: RunSurface & { log: string[] } = {
    id: `mp:${id}`,
    kind,
    log,
    hold: () => { log.push('hold'); watch('terminal.watch', { id: `mp:${id}`, control: true }); },
    lose: () => log.push('lose'),
    message: (m) => log.push(`msg:${m.t}`),
  };
  return s;
}

function setup() {
  const calls: Call[] = [];
  const watch = vi.fn(async (t: string, a: { id: string }) => { calls.push([t, a]); return { ok: true as const, data: {} }; });
  const broker = new RunTerminalBroker(watch as never);
  const mk = (id: string, kind: 'dialog' | 'seat') => surface(broker, (t, a) => void watch(t, a), id, kind);
  /** The control watches the bridge would hold after these calls (a re-watch replaces, an unwatch ends). */
  const live = () => {
    const ids = new Set<string>();
    let most = 0;
    for (const [t, a] of calls) {
      if (t === 'terminal.watch') ids.add(a.id);
      if (t === 'terminal.unwatch') ids.delete(a.id);
      most = Math.max(most, ids.size);
    }
    return { ids: [...ids], most };
  };
  return { calls, broker, mk, live, kinds: () => calls.map(([t, a]) => `${t.replace('terminal.', '')} ${a.id}`) };
}

const frame = (id: string): TerminalFrame => ({ t: 'terminal.frame', id, n: 1, full: true, cols: 80, rows: 24, data: '' }) as TerminalFrame;

describe('RunTerminalBroker', () => {
  it('the dialog takes the seat’s run and hands it back on close: re-watches, never an unwatch in between', () => {
    const { broker, mk, kinds, live } = setup();
    const seat = mk('a', 'seat');
    broker.add(seat);
    expect(broker.holder).toBe(seat);
    const dialog = mk('a', 'dialog');
    broker.add(dialog);
    expect(broker.holder).toBe(dialog);
    expect(seat.log).toEqual(['hold', 'lose']);
    broker.remove(dialog);
    expect(broker.holder).toBe(seat);
    expect(seat.log).toEqual(['hold', 'lose', 'hold']);
    expect(kinds()).toEqual(['watch mp:a', 'watch mp:a', 'watch mp:a']);
    broker.remove(seat);
    expect(kinds().at(-1)).toBe('unwatch mp:a');
    expect(live().ids).toEqual([]);
  });

  it('sends frames and control messages to the holder only, and claims every mp: message', () => {
    const { broker, mk } = setup();
    const seat = mk('a', 'seat');
    const dialog = mk('a', 'dialog');
    broker.add(seat);
    broker.add(dialog);
    expect(broker.onConn(frame('mp:a'))).toBe(true);
    expect(broker.onConn({ t: 'terminal.control', id: 'mp:a', mode: 'control', cols: 80, rows: 24 } as ConnMessage)).toBe(true);
    expect(dialog.log.filter((l) => l.startsWith('msg'))).toEqual(['msg:terminal.frame', 'msg:terminal.control']);
    expect(seat.log.filter((l) => l.startsWith('msg'))).toEqual([]);
    // Another run's message, or one nobody holds: still the broker's, delivered to no one.
    expect(broker.onConn(frame('mp:zzz'))).toBe(true);
    expect(dialog.log.filter((l) => l.startsWith('msg'))).toHaveLength(2);
    // A worker's terminal is not.
    expect(broker.onConn(frame('w1'))).toBe(false);
  });

  it('disposing the surface that does not hold the run sends nothing', () => {
    const { broker, mk, calls } = setup();
    const seat = mk('a', 'seat');
    const dialog = mk('a', 'dialog');
    broker.add(seat);
    broker.add(dialog);
    const before = calls.length;
    broker.remove(seat);
    expect(calls.length).toBe(before);
    expect(broker.holder).toBe(dialog);
    broker.remove(dialog);
    expect(calls.at(-1)).toEqual(['terminal.unwatch', { id: 'mp:a' }]);
    expect(broker.holder).toBeNull();
  });

  it('never holds two runs’ control watches at once (the bridge allows one per connection)', () => {
    const { broker, mk, kinds, live } = setup();
    const seatA = mk('a', 'seat');
    broker.add(seatA);
    const dialogB = mk('b', 'dialog');
    broker.add(dialogB);
    expect(kinds()).toEqual(['watch mp:a', 'unwatch mp:a', 'watch mp:b']);
    broker.remove(dialogB);
    expect(kinds()).toEqual(['watch mp:a', 'unwatch mp:a', 'watch mp:b', 'unwatch mp:b', 'watch mp:a']);
    // A second seat surface of another run takes it from the first.
    const seatC = mk('c', 'seat');
    broker.add(seatC);
    expect(broker.holder).toBe(seatC);
    expect(seatA.log.at(-1)).toBe('lose');
    broker.remove(seatC);
    expect(broker.holder).toBe(seatA);
    expect(live().most).toBe(1);
    expect(live().ids).toEqual(['mp:a']);
  });

  it('a seat surface cannot take the run while the dialog’s is mounted (even of another run)', () => {
    const { broker, mk, calls } = setup();
    const dialog = mk('a', 'dialog');
    broker.add(dialog);
    const seat = mk('b', 'seat');
    broker.add(seat);
    expect(broker.holder).toBe(dialog);
    expect(seat.log).toEqual(['lose']);
    const before = calls.length;
    expect(broker.claim(seat)).toBe(false);
    expect(calls.length).toBe(before);
    broker.remove(dialog);
    expect(broker.holder).toBe(seat);
    expect(calls.slice(before).map(([t, a]) => `${t} ${a.id}`)).toEqual(['terminal.unwatch mp:a', 'terminal.watch mp:b']);
  });

  it('reconnect re-watches the holder only', () => {
    const { broker, mk, calls } = setup();
    const seat = mk('a', 'seat');
    const dialog = mk('a', 'dialog');
    broker.add(seat);
    broker.add(dialog);
    const before = calls.length;
    broker.reconnect();
    expect(calls.slice(before)).toEqual([['terminal.watch', { id: 'mp:a', control: true }]]);
    expect(dialog.log.at(-1)).toBe('hold');
    expect(seat.log.at(-1)).toBe('lose');
    broker.remove(dialog);
    broker.remove(seat);
    broker.reconnect();
    expect(calls.at(-1)?.[0]).toBe('terminal.unwatch');
  });

  it('ignores a surface it does not know and a second remove', () => {
    const { broker, mk, calls } = setup();
    const s = mk('a', 'seat');
    expect(broker.claim(s)).toBe(false);
    broker.remove(s);
    expect(calls).toEqual([]);
    broker.add(s);
    broker.remove(s);
    broker.remove(s);
    expect(calls.map(([t]) => t)).toEqual(['terminal.watch', 'terminal.unwatch']);
  });
});
