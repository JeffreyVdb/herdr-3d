import { describe, expect, it } from 'vitest';
import { isWorldEvent, parseMessage, type Activity, type Floor, type Snapshot, type Worker, type WorldEvent } from '../net/protocol';
import { needQueue } from './next';
import { WorldStore } from './store';

// #98: `Worker.activity` and the `worker.activity` event, the `waiting` display status and its count.

const floor: Floor = { session: 'top', state: 'running', building: 'b1', index: 0, desks: 8 };
const worker = (id: string, over: Partial<Worker> = {}): Worker => ({ id, session: 'top', workspace_id: `ws-${id}`, label: `label-${id}`, status: 'idle', harness: 'claude', ...over });
const testing: Activity = { kind: 'testing', detail: 'pytest -n auto', since: 1_000, source: 'rule' };
const waiting: Activity = { kind: 'waiting', detail: 'Testing in the background', since: 2_000, source: 'derived', tasks: 2 };

function store(workers: Worker[]): WorldStore {
  const s = new WorldStore(500);
  const snap: Snapshot = { t: 'world.snapshot', seq: 1, world: { buildings: [{ id: 'b1', name: 'Work', sort: 0, floors: ['top'] }], unassigned: [], floors: [floor], workers } };
  s.applySnapshot(snap);
  return s;
}

const ev = (id: string, activity: Activity | null | undefined, seq = 2): WorldEvent =>
  ({ t: 'worker.activity', seq, id, session: 'top', workspace_id: `ws-${id}`, ...(activity === undefined ? {} : { activity }) }) as WorldEvent;

describe('worker.activity', () => {
  it('is a world event; activity absent or null clears, anything else is not one', () => {
    const ok = (o: object) => {
      const m = parseMessage(JSON.stringify(o));
      return !!m && isWorldEvent(m);
    };
    expect(ok({ t: 'worker.activity', seq: 3, id: 'a', session: 'top', workspace_id: 'ws', activity: testing })).toBe(true);
    expect(ok({ t: 'worker.activity', seq: 3, id: 'a', session: 'top', workspace_id: 'ws' })).toBe(true);
    expect(ok({ t: 'worker.activity', seq: 3, id: 'a', activity: null })).toBe(true);
    expect(ok({ t: 'worker.activity', seq: 3, id: 'a', activity: 'testing' })).toBe(false);
    expect(ok({ t: 'worker.activity', seq: 3, activity: testing })).toBe(false);
    expect(ok({ t: 'worker.activity', id: 'a', activity: testing })).toBe(false);
  });

  it('comes in the snapshot, is set and cleared by the event as a worker-only change, and leaves the status alone', () => {
    const s = store([worker('a', { status: 'working', activity: testing, status_since: 900 })]);
    expect(s.workers.get('a')?.activity).toEqual(testing);
    const c = s.applyEvent(ev('a', { ...testing, kind: 'writing', detail: 'store.ts' }), 5_000);
    expect(c).toEqual({ structure: false, floors: new Set(['top']), workers: new Set(['a']), usage: null });
    expect(s.workers.get('a')?.activity?.kind).toBe('writing');
    expect(s.workers.get('a')?.status).toBe('working');
    expect(s.workerView('a')?.since).toBe(900);
    s.applyEvent(ev('a', undefined, 3));
    expect(s.workers.get('a')).not.toHaveProperty('activity');
    s.applyEvent(ev('a', testing, 4));
    s.applyEvent(ev('a', null, 5));
    expect(s.workers.get('a')).not.toHaveProperty('activity');
    expect(s.seq).toBe(5);
  });

  it('ignores the event for an unknown worker', () => {
    const s = store([worker('a')]);
    expect(s.applyEvent(ev('nobody', testing))).toEqual({ structure: false, floors: new Set(), workers: new Set(), usage: null });
  });

  it('keeps the activity across a worker.status (the bridge clears it with its own event)', () => {
    const s = store([worker('a', { status: 'working', activity: testing })]);
    s.applyEvent({ t: 'worker.status', seq: 2, id: 'a', session: 'top', workspace_id: 'ws-a', status: 'working', title: 'x' });
    expect(s.workers.get('a')?.activity).toEqual(testing);
  });
});

describe('the waiting display status', () => {
  it('is idle or done with a waiting activity; working stays working, needing you wins, asleep is asleep', () => {
    const s = store([
      worker('idle', { status: 'idle', activity: waiting }),
      worker('done', { status: 'done', activity: waiting }),
      worker('busy', { status: 'working', activity: { ...waiting, detail: 'sleep 30' } }),
      worker('plain', { status: 'idle' }),
      worker('stale', { status: 'idle', activity: testing }),
      worker('asks', {
        status: 'idle',
        activity: waiting,
        ask: { tool_use_id: 't1', source: 'AskUserQuestion', agent: 'claude', questions: [{ question: 'Ship it?', options: [{ label: 'Yes' }, { label: 'No' }] }], since: 5 } as unknown as NonNullable<Worker['ask']>,
      }),
      worker('blocked', { status: 'blocked', activity: waiting }),
    ]);
    const d = (id: string) => s.workerView(id)?.display;
    expect(d('idle')).toBe('waiting');
    expect(d('done')).toBe('waiting');
    expect(d('busy')).toBe('working');
    expect(d('plain')).toBe('idle');
    // A non-waiting label while idle is a stale one (the status beat the clearing event): plain idle.
    expect(d('stale')).toBe('idle');
    expect(d('asks')).toBe('needs_you');
    expect(d('blocked')).toBe('needs_you');
    s.applyEvent({ t: 'floor.upsert', seq: 9, floor: { ...floor, state: 'asleep' } });
    expect(d('idle')).toBe('asleep');
  });

  it('has a count of its own: not idle, not done, not in N’s queue', () => {
    const s = store([
      worker('w1', { status: 'idle', activity: waiting, desk_index: 0 }),
      worker('w2', { status: 'done', activity: waiting, desk_index: 1 }),
      worker('i', { status: 'idle', desk_index: 2 }),
      worker('d', { status: 'done', desk_index: 3 }),
      worker('busy', { status: 'working', desk_index: 4 }),
    ]);
    const f = s.floorView('top');
    expect(f?.counts).toEqual({ working: 1, needsYou: 0, idle: 2, done: 1, waiting: 2, total: 5 });
    const q = needQueue((f?.workers ?? []).map((v) => ({ id: v.worker.id, floor: 'top', building: 'b1', display: v.display, since: v.since, desk: v.desk, name: v.name })), 'b1');
    expect(q.map((x) => x.id)).toEqual(['d']);
    // The last task reports back: idle again, back in the idle count.
    s.applyEvent(ev('w1', null, 7));
    expect(s.floorView('top')?.counts).toMatchObject({ idle: 3, waiting: 1 });
  });
});
