import { describe, expect, it } from 'vitest';
import type { Floor, Snapshot, Worker } from '../net/protocol';
import { crewRole } from './crew';
import type { InboxCandidate } from './inbox';
import { InboxPings, pingEntries, type PingClock, type PingOut } from './inboxPings';
import { WorldStore, type Change } from './store';

// #106: a dismissed finished row does not ping once its settle delay ends. The store's change drives the pings the way
// App.pingInbox does (`needCandidates` → `pingEntries` → `InboxPings.update`).

const floor: Floor = { session: 's1', state: 'running', building: 'b1', index: 0 };
const worker = (over: Partial<Worker> = {}): Worker => ({ id: 'w', session: 's1', workspace_id: 'ws-w', label: 'Chirp', status: 'working', ...over });
const snapshot = (workers: Worker[], dismissed: Record<string, number> = {}, seq = 10): Snapshot => ({
  t: 'world.snapshot',
  seq,
  world: { buildings: [{ id: 'b1', name: 'Work', sort: 0, floors: ['s1'] }], unassigned: [], floors: [floor], workers, inbox_dismissed: dismissed },
});

function setup() {
  let t = 1_000_000;
  let timers: Array<{ at: number; fn: () => void }> = [];
  const clock: PingClock = {
    now: () => t,
    later(fn, ms) {
      const timer = { at: t + ms, fn };
      timers.push(timer);
      return () => (timers = timers.filter((x) => x !== timer));
    },
  };
  const advance = (ms: number) => {
    const end = t + ms;
    for (;;) {
      const next = timers.filter((x) => x.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      timers = timers.filter((x) => x !== next);
      t = next.at;
      next.fn();
    }
    t = end;
  };
  const out: PingOut[] = [];
  const store = new WorldStore(1000);
  const pings = new InboxPings({ emit: (p) => out.push(p), focus: () => null, gates: () => ({ onNeeds: true, onFinished: true, freelancers: false }), clock });
  let snapshots = 0;
  // App.needCandidates / App.pingInbox.
  const candidates = (): InboxCandidate[] =>
    store.city().flatMap((b) => b.floors.flatMap((f) => f.workers.map((w) => ({ id: w.worker.id, session: f.session, building: b.building?.id ?? null, display: w.display, since: w.since, desk: w.desk, name: w.name, role: crewRole(w.worker) }))));
  const feed = (c: Change) => {
    const snap = store.snapshots !== snapshots;
    snapshots = store.snapshots;
    if (!snap && !c.structure && !c.workers.size && !c.sessions.size) return;
    pings.update(pingEntries(candidates(), store.inboxDismissed), snap);
  };
  let seq = 11;
  return {
    out,
    advance,
    pings,
    store,
    load: (workers: Worker[], dismissed?: Record<string, number>) => feed(store.applySnapshot(snapshot(workers, dismissed))),
    upsert: (w: Worker) => feed(store.applyEvent({ t: 'worker.upsert', seq: seq++, worker: w }, t)),
    dismiss: (since: number, id = 'w') => feed(store.applyEvent({ t: 'inbox.dismissed', seq: seq++, id, status_since: since })),
  };
}

const finished = (out: PingOut[]) => out.flatMap((p) => (p.t === 'ping' && p.kind === 'finished' ? [p.entry.id + '@' + p.entry.since] : []));

describe('a dismissed finished row and its ping (#106)', () => {
  it('reports the dismissed worker as changed, so the pings are fed again', () => {
    const { store, load } = setup();
    load([worker()]);
    const c = store.applyEvent({ t: 'inbox.dismissed', seq: 20, id: 'w', status_since: 5 });
    expect([...c.workers]).toEqual(['w']);
    expect([...c.sessions]).toEqual(['s1']);
    // Nothing to redraw for a worker this browser does not know.
    const gone = store.applyEvent({ t: 'inbox.dismissed', seq: 21, id: 'nobody', status_since: 5 });
    expect(gone.workers.size + gone.sessions.size).toBe(0);
  });

  it('does not ping when the finished row is dismissed within the settle delay', () => {
    const { out, advance, upsert, dismiss, load, pings } = setup();
    load([worker()]);
    upsert(worker({ status: 'done', status_since: 2000 }));
    expect(pings.pending()).toEqual(['w']);
    advance(2000);
    dismiss(2000);
    expect(pings.pending()).toEqual([]);
    advance(10_000);
    expect(finished(out)).toEqual([]);
  });

  it('still pings a finished row that is not dismissed, and a new working → done after a dismissal', () => {
    const { out, advance, upsert, dismiss, load } = setup();
    load([worker()]);
    upsert(worker({ status: 'done', status_since: 2000 }));
    advance(5000);
    expect(finished(out)).toEqual(['w@2000']);
    // Dismissed later, it is long pinged: the second episode is a new ping, the dismissed one never comes back.
    dismiss(2000);
    advance(10_000);
    expect(finished(out)).toEqual(['w@2000']);
    upsert(worker({ status: 'working', status_since: 3000 }));
    upsert(worker({ status: 'done', status_since: 4000 }));
    advance(5000);
    expect(finished(out)).toEqual(['w@2000', 'w@4000']);
  });

  it('pings the next episode after a dismissal that cancelled the previous one', () => {
    const { out, advance, upsert, dismiss, load } = setup();
    load([worker()]);
    upsert(worker({ status: 'done', status_since: 2000 }));
    dismiss(2000);
    advance(10_000);
    expect(finished(out)).toEqual([]);
    upsert(worker({ status: 'working', status_since: 3000 }));
    upsert(worker({ status: 'done', status_since: 4000 }));
    advance(5000);
    expect(finished(out)).toEqual(['w@4000']);
  });

  it('a stale dismissal (another episode) neither cancels nor hides a ping', () => {
    const { out, advance, upsert, dismiss, load } = setup();
    load([worker()]);
    upsert(worker({ status: 'done', status_since: 4000 }));
    dismiss(2000);
    advance(5000);
    expect(finished(out)).toEqual(['w@4000']);
  });

  it('a reconnect snapshot carrying the dismissal cancels the settle too, and says nothing', () => {
    const { out, advance, upsert, load, pings } = setup();
    load([worker()]);
    upsert(worker({ status: 'done', status_since: 2000 }));
    load([worker({ status: 'done', status_since: 2000 })], { w: 2000 });
    expect(pings.pending()).toEqual([]);
    advance(10_000);
    expect(out).toEqual([]);
  });
});
