import { describe, expect, it } from 'vitest';
import type { CrewRole } from './crew';
import { InboxPings, type PingClock, type PingEntry, type PingGates, type PingOut } from './inboxPings';

/** A clock that only moves when told to. */
function fakeClock(): PingClock & { advance(ms: number): void } {
  let t = 1_000_000;
  let timers: Array<{ at: number; fn: () => void }> = [];
  return {
    now: () => t,
    later(fn, ms) {
      const timer = { at: t + ms, fn };
      timers.push(timer);
      return () => (timers = timers.filter((x) => x !== timer));
    },
    advance(ms) {
      const end = t + ms;
      for (;;) {
        const next = timers.filter((x) => x.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!next) break;
        timers = timers.filter((x) => x !== next);
        t = next.at;
        next.fn();
      }
      t = end;
    },
  };
}

const ALL: PingGates = { onNeeds: true, onFinished: true, freelancers: false };

function setup(o: { gates?: Partial<PingGates>; focus?: string | null } = {}) {
  const clock = fakeClock();
  const out: PingOut[] = [];
  const state = { gates: { ...ALL, ...o.gates }, focus: o.focus ?? null };
  const pings = new InboxPings({ emit: (p) => out.push(p), focus: () => state.focus, gates: () => state.gates, clock });
  return { clock, out, state, pings };
}

const entry = (id: string, reason: 'blocked' | 'done', since = 1, role: CrewRole | null = null): PingEntry => ({ id, name: id.toUpperCase(), session: 's1', role, reason, since });
const kinds = (out: PingOut[]) => out.map((p) => (p.t === 'ping' ? `${p.kind}:${p.entry.id}${p.chime ? '!' : ''}` : p.t === 'burst' ? `burst:${p.entries.length}` : `away:${p.needs}/${p.finished}`));

describe('InboxPings', () => {
  it('a live change into needs you pings at once, for any role', () => {
    const { pings, out } = setup();
    pings.update([], true);
    pings.update([entry('a', 'blocked', 5)], false);
    pings.update([entry('a', 'blocked', 5), entry('f', 'blocked', 6, 'code')], false);
    expect(kinds(out)).toEqual(['needs:a!', 'needs:f']);
  });

  it('the same episode never pings twice; a new since is a new episode', () => {
    const { pings, out, clock } = setup();
    pings.update([], true);
    pings.update([entry('a', 'blocked', 5)], false);
    pings.update([entry('a', 'blocked', 5)], false);
    pings.update([], false); // resolved
    pings.update([entry('a', 'blocked', 5)], false); // a sleeping floor woke: the same episode
    clock.advance(20_000);
    pings.update([entry('a', 'blocked', 9)], false);
    expect(kinds(out)).toEqual(['needs:a!', 'needs:a!']);
  });

  it('done settles first: it pings after the delay, not when the worker went back to work meanwhile', () => {
    const { pings, out, clock } = setup();
    pings.update([], true);
    pings.update([entry('a', 'done', 5)], false);
    clock.advance(4_999);
    expect(out).toEqual([]);
    expect(pings.pending()).toEqual(['a']);
    clock.advance(1);
    expect(kinds(out)).toEqual(['finished:a!']);
    expect(pings.pending()).toEqual([]);

    clock.advance(20_000);
    pings.update([entry('b', 'done', 7)], false);
    clock.advance(2_000);
    pings.update([], false); // working again
    clock.advance(10_000);
    pings.update([entry('b', 'done', 8)], false); // a new turn ended
    clock.advance(5_000);
    expect(kinds(out)).toEqual(['finished:a!', 'finished:b!']);
  });

  it('done into needs you while settling pings the need only', () => {
    const { pings, out, clock } = setup();
    pings.update([], true);
    pings.update([entry('a', 'done', 5)], false);
    pings.update([entry('a', 'blocked', 6)], false);
    clock.advance(10_000);
    expect(kinds(out)).toEqual(['needs:a!']);
  });

  it('a freelancer that finishes pings only with freelancers on; the orchestrator is an employee', () => {
    const { pings, out, clock, state } = setup();
    pings.update([], true);
    pings.update([entry('c', 'done', 5, 'code'), entry('o', 'done', 5, 'orch')], false);
    clock.advance(5_000);
    expect(kinds(out)).toEqual(['finished:o!']);
    state.gates = { ...ALL, freelancers: true };
    clock.advance(20_000);
    pings.update([entry('r', 'done', 9, 'review')], false);
    clock.advance(5_000);
    expect(kinds(out)).toEqual(['finished:o!', 'finished:r!']);
  });

  it('the gates turn each kind off, and the gate is read when the ping fires', () => {
    const { pings, out, clock, state } = setup({ gates: { onNeeds: false } });
    pings.update([], true);
    pings.update([entry('a', 'blocked', 5), entry('b', 'done', 5)], false);
    state.gates = { ...ALL, onFinished: false };
    clock.advance(5_000);
    expect(out).toEqual([]);
  });

  it('never pings for the worker you are sat at, also when it is sat at during the settle', () => {
    const { pings, out, clock, state } = setup({ focus: 'a' });
    pings.update([], true);
    pings.update([entry('a', 'blocked', 5)], false);
    state.focus = null;
    pings.update([entry('a', 'blocked', 5), entry('b', 'done', 5)], false); // no ping for a's known episode
    state.focus = 'b';
    clock.advance(5_000);
    expect(out).toEqual([]);
  });

  it('a snapshot never pings: the first lists everything as one while-you-were-away', () => {
    const { pings, out, clock } = setup();
    pings.update([entry('a', 'blocked', 1), entry('b', 'done', 2), entry('c', 'done', 3), entry('d', 'done', 4, 'ux')], true);
    clock.advance(10_000);
    expect(kinds(out)).toEqual(['away:1/2']);
  });

  it('an empty snapshot says nothing', () => {
    const { pings, out } = setup();
    pings.update([], true);
    expect(out).toEqual([]);
  });

  it('a reconnect snapshot counts only what is new since, settling ones included, and cancels their settle', () => {
    const { pings, out, clock } = setup();
    pings.update([entry('a', 'blocked', 1)], true);
    out.length = 0;
    pings.update([entry('a', 'blocked', 1), entry('b', 'done', 2)], false); // settling when the bridge dropped
    pings.update([entry('a', 'blocked', 1), entry('b', 'done', 2), entry('c', 'blocked', 3)], true);
    clock.advance(10_000);
    expect(kinds(out)).toEqual(['away:1/1']);
    pings.update([entry('a', 'blocked', 1), entry('b', 'done', 2), entry('c', 'blocked', 3)], true);
    expect(out).toHaveLength(1); // nothing new
  });

  it('more than three pings in a burst collapse into one, updated as more arrive; one chime per burst', () => {
    const { pings, out, clock } = setup();
    pings.update([], true);
    const list: PingEntry[] = [];
    for (const id of ['a', 'b', 'c', 'd', 'e']) {
      list.push(entry(id, 'blocked', 5));
      pings.update(list, false);
      clock.advance(1_000);
    }
    expect(kinds(out)).toEqual(['needs:a!', 'needs:b', 'needs:c', 'burst:4', 'burst:5']);
    const last = out.at(-1);
    expect(last).toMatchObject({ t: 'burst', needs: 5, finished: 0 });
    expect(last?.t === 'burst' && last.entries.map((e) => e.id)).toEqual(['a', 'b', 'c', 'd', 'e']);

    // The burst is over 10 s after it started: the next one chimes again.
    clock.advance(6_000);
    pings.update([...list, entry('f', 'blocked', 9)], false);
    expect(kinds(out).at(-1)).toBe('needs:f!');
  });

  it('a burst counts a worker once', () => {
    const { pings, out, clock } = setup();
    pings.update([], true);
    pings.update([entry('a', 'blocked', 1)], false);
    pings.update([entry('a', 'done', 2)], false);
    clock.advance(5_000);
    pings.update([entry('a', 'done', 2), entry('b', 'blocked', 3), entry('c', 'blocked', 3)], false);
    expect(kinds(out)).toEqual(['needs:a!', 'finished:a', 'needs:b', 'needs:c']);
  });

  it('dispose cancels what is settling', () => {
    const { pings, out, clock } = setup();
    pings.update([], true);
    pings.update([entry('a', 'done', 5)], false);
    pings.dispose();
    clock.advance(10_000);
    expect(out).toEqual([]);
  });
});
