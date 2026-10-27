import { describe, expect, it } from 'vitest';
import type { HandoffHire } from '../net/protocol';
import { ANNOUNCED_KEY, ANNOUNCED_MAX, HandoffHireAnnouncer, ORIGIN_KEY, type HandoffHireSession } from './handoffHires';
import { SPAWNED_TEXT } from './hireCoordinator';

// #219: the detached flow's outcomes, said once by the browser that asked: hired → the background toast and one beep;
// failed / cancelled → the review's give-back (or a toast after a reload); never twice on a repeated update, a late
// ack, a reconnect or a reload; never for another browser's record; never a hire.

class Mem implements Storage {
  private m = new Map<string, string>();
  get length() {
    return this.m.size;
  }
  clear() {
    this.m.clear();
  }
  getItem(k: string) {
    return this.m.get(k) ?? null;
  }
  key(i: number) {
    return [...this.m.keys()][i] ?? null;
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
  setItem(k: string, v: string) {
    this.m.set(k, v);
  }
}

const rec = (o: Partial<HandoffHire> = {}): HandoffHire => ({
  op: 'ho-1',
  worker: 'w1',
  worker_name: 'Pebble',
  mode: 'agent',
  floor: 'f1',
  desk_index: 3,
  harness: 'claude',
  model: 'claude-opus-5-5',
  effort: 'high',
  state: 'waiting',
  started_at: 1,
  ...o,
});

function rig(storage: Storage | null = new Mem()) {
  let records: HandoffHire[] = [];
  const toasts: Array<{ msg: string; kind: string }> = [];
  const timers: Array<() => void> = [];
  const held: Array<[string, string]> = [];
  let beeps = 0;
  const host = {
    records: () => records,
    toast: (msg: string, kind: string) => toasts.push({ msg, kind }),
    beep: () => beeps++,
    floorName: (id: string) => (id === 'f1' ? 'herdr-3d' : id),
    workerView: (id: string) => (id === 'new1' ? { name: 'Nova', desk: 3 } : null),
    holdTask: (id: string, text: string) => (held.push([id, text]), true),
    storage,
    later: (fn: () => void) => timers.push(fn),
  };
  const a = new HandoffHireAnnouncer(host);
  const set = (...rs: HandoffHire[]) => {
    records = rs;
    a.sync();
  };
  const flush = () => {
    while (timers.length) timers.shift()?.();
  };
  return { a, host, set, toasts, held, timers, flush, beeps: () => beeps };
}

function session(o: Partial<HandoffHireSession> = {}) {
  const log: string[] = [];
  const s: HandoffHireSession = { task: 'Fix the issue', watching: () => false, giveBack: (r) => log.push(`give:${r.state}:${r.reason ?? ''}`), done: () => log.push('done'), ...o };
  return { s, log };
}

describe('HandoffHireAnnouncer', () => {
  it('keeps one origin per browser; a broken or missing storage still gives one', () => {
    const st = new Mem();
    const one = rig(st).a.origin;
    expect(one).toMatch(/^[A-Za-z0-9_-]{1,80}$/);
    expect(st.getItem(ORIGIN_KEY)).toBe(one);
    expect(rig(st).a.origin).toBe(one);
    const broken = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } } as unknown as Storage;
    expect(rig(broken).a.origin).toMatch(/^br-/);
    expect(rig(null).a.origin).toMatch(/^br-/);
  });

  it('filed → hired: the background toast and one beep, once, whatever repeats', () => {
    const r = rig();
    const { s, log } = session();
    r.a.session('ho-1', s);
    const mine = rec({ origin: r.a.origin });
    r.set(mine);
    r.set({ ...mine, state: 'hiring', path: '/h/x.md' });
    expect(r.toasts).toEqual([]);
    const done = { ...mine, state: 'hired' as const, path: '/h/x.md', hired: 'new1', prompted: true };
    r.set(done);
    // A repeated upsert, a reconnect's snapshot, a late ack (the same record again): nothing more.
    r.set(done);
    r.set({ ...done });
    expect(r.toasts).toEqual([{ msg: SPAWNED_TEXT, kind: 'info' }]);
    expect(r.beeps()).toBe(1);
    expect(log).toEqual(['done']);
  });

  it('failed / cancelled with a session: the review gives the task back, once', () => {
    const r = rig();
    const one = session();
    r.a.session('ho-1', one.s);
    r.set(rec({ origin: r.a.origin, state: 'failed', code: 'handoff_failed', reason: 'It stopped.' }));
    r.set(rec({ origin: r.a.origin, state: 'failed', code: 'handoff_failed', reason: 'It stopped.' }));
    expect(one.log).toEqual(['give:failed:It stopped.', 'done']);
    const two = session();
    r.a.session('ho-2', two.s);
    r.set(rec({ op: 'ho-2', origin: r.a.origin, state: 'cancelled', code: 'cancelled', reason: 'Cancelled.' }));
    expect(two.log).toEqual(['give:cancelled:Cancelled.', 'done']);
    expect(r.toasts).toEqual([]);
    expect(r.beeps()).toBe(0);
  });

  it('another browser’s record is never said; a pending one is not said yet', () => {
    const r = rig();
    r.set(rec({ origin: 'someone-else', state: 'hired', hired: 'x', prompted: true }), rec({ op: 'ho-2', origin: 'someone-else', state: 'failed', reason: 'No.' }), rec({ op: 'ho-3', origin: r.a.origin }));
    r.flush();
    expect(r.toasts).toEqual([]);
    expect(r.beeps()).toBe(0);
  });

  it('the review open on it says it itself (watching), then claims it: nobody says it again', () => {
    const r = rig();
    let open = true;
    const { s, log } = session({ watching: () => open });
    r.a.session('ho-1', s);
    const failed = rec({ origin: r.a.origin, state: 'failed', reason: 'Desk taken.', path: '/h/x.md' });
    r.set(failed);
    expect(log).toEqual([]);
    r.a.claim('ho-1');
    open = false;
    r.set(failed);
    r.flush();
    expect(log).toEqual(['done']);
    expect(r.toasts).toEqual([]);
  });

  it('after a reload (no session): a toast with the reason and the path, once, also across another reload', () => {
    const st = new Mem();
    const first = rig(st);
    const failed = rec({ origin: first.a.origin, state: 'failed', code: 'desk_taken', reason: 'Desk 4 of herdr-3d was taken while the handoff was written.', path: '/h/x.md' });
    first.set(failed);
    expect(first.toasts).toEqual([]);
    first.flush();
    expect(first.toasts).toEqual([{ msg: 'Desk 4 of herdr-3d · Desk 4 of herdr-3d was taken while the handoff was written. Pebble’s handoff is saved at /h/x.md: hire from it in the cabinet.', kind: 'error' }]);
    // The next page of this browser: already said.
    const again = rig(st);
    again.set(failed);
    again.flush();
    expect(again.toasts).toEqual([]);
    // A hire that ended while the page reloaded is said after it.
    const hired = rec({ op: 'ho-9', origin: first.a.origin, state: 'hired', hired: 'new1', prompted: true });
    again.set(failed, hired);
    again.flush();
    expect(again.toasts).toEqual([{ msg: SPAWNED_TEXT, kind: 'info' }]);
    expect(again.beeps()).toBe(1);
  });

  it('a tab with the session says it before an orphan tab of the same browser', () => {
    const st = new Mem();
    const tabA = rig(st);
    const tabB = rig(st);
    const { s, log } = session();
    tabA.a.session('ho-1', s);
    const failed = rec({ origin: tabA.a.origin, state: 'failed', reason: 'No.' });
    tabB.set(failed);
    tabA.set(failed);
    tabB.flush();
    expect(log).toEqual(['give:failed:No.', 'done']);
    expect(tabB.toasts).toEqual([]);
  });

  it('hired without its task: the not-prompted words, the task in their Prompt note, no beep; uncertain delivery holds nothing', () => {
    const r = rig();
    r.a.session('ho-1', session().s);
    r.set(rec({ origin: r.a.origin, state: 'hired', hired: 'new1', path: '/h/x.md', prompted: false, prompt_error: 'pane busy' }));
    expect(r.held).toEqual([['new1', 'First read the handoff here: /h/x.md and then follow these instructions:\n\nFix the issue']]);
    expect(r.toasts).toEqual([{ msg: 'Hired Nova at Desk 4. The first task was not sent (pane busy): prompt them yourself (P); the task is in their prompt.', kind: 'error' }]);
    r.a.session('ho-2', session().s);
    r.set(rec({ op: 'ho-2', origin: r.a.origin, state: 'hired', hired: 'new1', path: '/h/x.md', prompted: false, delivery: 'unknown' }));
    expect(r.held).toHaveLength(1);
    expect(r.toasts[1]?.msg).toContain('Prompt delivery is uncertain.');
    expect(r.beeps()).toBe(0);
  });

  it('a send home that did not happen is said with the success', () => {
    const r = rig();
    r.set(rec({ origin: r.a.origin, state: 'hired', hired: 'new1', prompted: true, send_home: true, send_home_result: 'skipped', send_home_reason: 'Pebble is working' }));
    r.flush();
    expect(r.toasts).toEqual([{ msg: `${SPAWNED_TEXT} Pebble was not sent home: Pebble is working`, kind: 'warn' }]);
  });

  it('remembers a bounded list of said ops', () => {
    const st = new Mem();
    const r = rig(st);
    for (let i = 0; i < ANNOUNCED_MAX + 5; i++) r.a.claim(`op-${i}`);
    const list = JSON.parse(st.getItem(ANNOUNCED_KEY) ?? '[]') as string[];
    expect(list).toHaveLength(ANNOUNCED_MAX);
    expect(list[0]).toBe('op-5');
    expect(r.a.announced('op-0')).toBe(true);
    expect(rig(st).a.announced('op-0')).toBe(false);
  });
});
