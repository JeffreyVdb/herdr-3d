import './test/fakeCanvas';
import { describe, expect, it, vi } from 'vitest';
import { App } from './app';
import type { Snapshot, Usage, Worker, WorldEvent } from './net/protocol';
import { WorldStore, type Change } from './world/store';

/**
 * #144: which views a world change refreshes (`App.applyChange`). No App test builds a whole App (it needs a renderer and
 * a page): this calls it on a stand-in whose every other part records the calls made on it. The methods named in `RUN`
 * run for real (on the stand-in); every other method of App is recorded by its name.
 */

const usage = (tokens: number): Usage => ({ tokens, cost_usd_est: tokens / 100_000, priced: 'known', model: 'claude-opus-5-5', context_pct: 4.2 });
const worker = (id: string, desk: number, over: Partial<Worker> = {}): Worker => ({ id, session: 'top', workspace_id: `ws-${id}`, label: id, status: 'working', name: id, desk_index: desk, usage: usage(1000), ...over });
const snap = (): Snapshot => ({
  t: 'world.snapshot',
  seq: 10,
  world: {
    buildings: [{ id: 'b1', name: 'Work', sort: 0, floors: ['top', 'low'] }],
    unassigned: [],
    floors: [
      { session: 'top', state: 'running', building: 'b1', index: 1 },
      { session: 'low', state: 'running', building: 'b1', index: 0 },
    ],
    workers: [worker('a', 0), worker('b', 1, { status: 'done' }), worker('c', 0, { session: 'low' })],
  },
});

const RUN = new Set(['applyUsage', 'cityOnce', 'refreshTopbar', 'topbarFloor', 'needCandidates', 'inboxItems', 'inboxEntries', 'pingInbox']);
/** Of those, the ones that only read (left out of the calls). */
const HELPERS = new Set(['applyUsage', 'cityOnce', 'topbarFloor', 'needCandidates', 'inboxItems', 'inboxEntries']);

/** What `applyChange` refreshed for `change` (made by `make` on a store that has the snapshot). */
function run(make: (s: WorldStore) => Change, o: { mode?: 'city' | 'floor'; office?: string | null } = {}) {
  const store = new WorldStore(0);
  store.applySnapshot(snap(), 0);
  const change = make(store);
  const city = vi.spyOn(store, 'city');
  const calls: string[] = [];
  const stub = (path: string): unknown =>
    new Proxy(function () {}, {
      get: (_t, k) => (typeof k === 'symbol' ? undefined : stub(`${path}.${String(k)}`)),
      apply: (_t, _self, args: unknown[]) => {
        calls.push(path);
        return path === 'inbox.set' || path === 'hud.setFloor' ? args : undefined;
      },
      set: () => true,
    });
  const state: Record<string, unknown> = {
    store,
    pacing: { changes: 0 },
    mode: o.mode ?? 'city',
    // On a floor: standing on `top` (storey 1 of the building), in its office.
    place: { area: 'floor', storey: 1 },
    building: { id: 'b1', name: 'Work', floors: [{ id: 'low' }, { id: 'top' }] },
    office: o.office === undefined ? null : o.office === null ? null : { id: o.office, updateWorker: () => calls.push('office.updateWorker'), updateUsage: () => calls.push('office.updateUsage') },
  };
  const proto = App.prototype as unknown as Record<string, unknown>;
  const self: Record<string, unknown> = new Proxy(state, {
    get: (t, k) => {
      if (typeof k === 'symbol') return undefined;
      if (k in t) return t[k];
      const m = proto[k];
      if (typeof m === 'function')
        return function (this: unknown, ...args: unknown[]) {
          if (!HELPERS.has(k)) calls.push(k);
          return RUN.has(k) ? (m as (...a: unknown[]) => unknown).apply(this, args) : undefined;
        };
      return stub(k);
    },
    set: (t, k, v) => {
      t[k as string] = v;
      return true;
    },
  });
  (proto.applyChange as (this: unknown, c: Change) => void).call(self, change);
  return { calls, set: state, cityBuilt: city.mock.calls.length, change };
}

const ev = (e: Record<string, unknown>) => e as unknown as WorldEvent;
const usageEvent = (id: string, tokens: number) => (s: WorldStore) => s.applyEvent(ev({ t: 'worker.usage', seq: 11, id, session: 'top', usage: usage(tokens) }));

/** The refreshes every change but a usage-only one runs (App.applyChange). */
const FULL = [
  'refreshTopbar',
  'updateNotice',
  'prompt.refresh',
  'changes.refresh',
  'panels.refresh',
  'palette.refresh',
  'dictation.refresh',
  'hire.refresh',
  'hireReview.refresh',
  'sendHome.refresh',
  'revokeSecrets.refresh',
  'laptops.syncSecretFiles',
  'handoffDialog.refresh',
  'noteAgentHandoffs',
  'cabinet.refresh',
  'schedules.refresh',
  'scheduleForm.refresh',
  'syncDrawers',
  'playFilings',
  'startRun.refresh',
  'presetsPanel.refresh',
  'hirePresets.refresh',
  'addFloor.refresh',
  'limitsWidget.update',
  'inbox.set',
  'm6Buttons.sync',
  'pingInbox',
];

describe('App.applyChange: a usage-only change (#144)', () => {
  it('in the city refreshes nothing (no city view shows usage)', () => {
    const r = run(usageEvent('a', 2000));
    expect(r.calls).toEqual([]);
    expect(r.cityBuilt).toBe(0);
    for (const k of ['statusDirty', 'planDirty', 'overviewDirty']) expect(r.set[k], k).toBeUndefined();
  });

  it('on its floor redraws its card (the office keeps the rest) and the top bar’s total, and nothing else', () => {
    const r = run(usageEvent('a', 2000), { mode: 'floor', office: 'top' });
    expect(r.calls).toEqual(['office.updateUsage', 'refreshTopbar', 'hud.setFloor']);
    expect(r.cityBuilt).toBe(0);
  });

  it('of a worker on another floor than the one shown does not touch the top bar', () => {
    const r = run(usageEvent('c', 2000), { mode: 'floor', office: 'top' });
    expect(r.calls).toEqual([]);
  });

  it('of an unknown worker does nothing at all', () => {
    expect(run(usageEvent('zz', 2000), { mode: 'floor', office: 'top' }).calls).toEqual([]);
  });
});

describe('App.applyChange: every other change keeps every refresh (#144)', () => {
  const others: Array<[string, (s: WorldStore) => Change]> = [
    ['a status', (s) => s.applyEvent(ev({ t: 'worker.status', seq: 11, id: 'a', status: 'done', prev_status: 'working' }))],
    ['an upsert with new usage and status', (s) => s.applyEvent(ev({ t: 'worker.upsert', seq: 11, worker: worker('a', 0, { status: 'blocked', usage: usage(9000) }) }))],
    ['a snapshot', (s) => s.applySnapshot(snap(), 0)],
    ['a limits reading (no world part)', (s) => s.applyEvent(ev({ t: 'limits.update', seq: 11, provider: 'claude', plan: '', windows: [], at: 1, stale: false }))],
  ];
  for (const [name, make] of others)
    it(`${name}: the full path`, () => {
      const r = run(make);
      expect(r.change.usage).toBeNull();
      for (const k of FULL) expect(r.calls, k).toContain(k);
      expect(r.set).toMatchObject({ statusDirty: true, planDirty: true, overviewDirty: true });
    });

  it('a status change shows on the city and its floor, and pushes the boards', () => {
    const r = run(others[0]![1]);
    expect(r.calls).toEqual(expect.arrayContaining(['city.updateWorker', 'city.updateFloor', 'pushBoards']));
  });

  it('builds the city once for the top bar, the inbox and its pings (AC4)', () => {
    expect(run(others[0]![1]).cityBuilt).toBe(1);
    // A structure change builds the city's scene from the same one.
    const r = run((s) => s.applyEvent(ev({ t: 'worker.upsert', seq: 11, worker: worker('a', 3) })));
    expect(r.change.structure).toBe(true);
    expect(r.calls).toContain('city.build');
    expect(r.cityBuilt).toBe(1);
  });
});
