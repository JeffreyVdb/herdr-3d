// #58: virtual floors. The store keys floors by `Floor.id` and groups workers by `Worker.floor`; an older bridge (no
// id, name or floor) keeps working on the session name.
import { describe, expect, it } from 'vitest';
import type { Floor, Snapshot, Worker } from '../net/protocol';
import { floorName, WorldStore } from './store';

const floor = (id: string, over: Partial<Floor> = {}): Floor => ({
  id,
  name: id,
  session: id,
  base_session: id,
  virtual: false,
  state: 'running',
  building: 'b1',
  index: 0,
  ...over,
});

const vfloor = (id: string, name: string, base: string, over: Partial<Floor> = {}): Floor =>
  floor(id, { name, session: base, base_session: base, virtual: true, ...over });

const worker = (id: string, floorId: string, session = floorId, over: Partial<Worker> = {}): Worker => ({
  id,
  session,
  floor: floorId,
  workspace_id: `ws-${id}`,
  label: `label-${id}`,
  status: 'idle',
  ...over,
});

const V = 'v-0123456789ab';
const W = 'v-ba9876543210';

const snap = (over: Partial<Snapshot['world']> = {}): Snapshot => ({
  t: 'world.snapshot',
  seq: 10,
  world: {
    buildings: [{ id: 'b1', name: 'Work', sort: 0, floors: ['main', V, 'other'] }],
    unassigned: [],
    floors: [floor('main'), vfloor(V, 'Frontend', 'main', { index: 1 }), floor('other', { index: 2 })],
    workers: [worker('a', 'main'), worker('b', V, 'main', { desk_index: 0 }), worker('c', V, 'main', { desk_index: 3 })],
    ...over,
  },
});

describe('WorldStore: virtual floors (#58)', () => {
  it('keys floors by id and groups workers by their floor, not their session', () => {
    const s = new WorldStore(1000);
    s.applySnapshot(snap());
    expect([...s.floors.keys()]).toEqual(['main', V, 'other']);
    const v = s.floorView(V);
    expect(v).toMatchObject({ id: V, name: 'Frontend', baseSession: 'main', virtual: true });
    expect(v?.workers.map((x) => x.worker.id)).toEqual(['b', 'c']);
    expect(v?.seats[3]?.worker.id).toBe('c');
    expect(s.floorView('main')?.workers.map((x) => x.worker.id)).toEqual(['a']);
    expect(s.floorView('main')).toMatchObject({ id: 'main', name: 'main', baseSession: 'main', virtual: false });
    // Building order is the bridge's, ids included: top floor first.
    expect(s.stack('b1').map((f) => f.id)).toEqual(['main', V, 'other']);
    expect(s.level(V)).toEqual({ number: 2, count: 3 });
  });

  it('fills in id, name and a worker’s floor from the session for an older bridge', () => {
    const s = new WorldStore(1000);
    s.applySnapshot(
      snap({
        buildings: [{ id: 'b1', name: 'Work', sort: 0, floors: ['main'] }],
        floors: [{ session: 'main', state: 'running', building: 'b1', index: 0 }],
        workers: [{ id: 'a', session: 'main', workspace_id: 'w1', label: 'x', status: 'idle' }],
      }),
    );
    expect(s.floors.get('main')).toMatchObject({ id: 'main', name: 'main', base_session: 'main', virtual: false, hidden: false });
    expect(s.workers.get('a')?.floor).toBe('main');
    expect(s.floorView('main')?.workers).toHaveLength(1);
    s.applyEvent({ t: 'floor.upsert', seq: 11, floor: { session: 'new', state: 'running', building: null, index: null } });
    s.applyEvent({ t: 'worker.upsert', seq: 12, worker: { id: 'n', session: 'new', workspace_id: 'w2', label: 'y', status: 'idle' } });
    expect(s.floorView('new')?.workers.map((w) => w.worker.id)).toEqual(['n']);
    // An older bridge's floor.removed names the session only.
    s.applyEvent({ t: 'floor.removed', seq: 13, session: 'new' });
    expect(s.floors.has('new')).toBe(false);
    expect(s.workers.has('n')).toBe(false);
  });

  it('floorName is the display name, never a v- id', () => {
    expect(floorName(vfloor(V, 'Frontend', 'main'))).toBe('Frontend');
    expect(floorName({ session: 'old' })).toBe('old');
    expect(floorName(vfloor(V, ' ', 'main'))).toBe('Unnamed floor');
  });

  it('names a floor by id, also once it is gone (a v- id never shows)', () => {
    const s = new WorldStore(1000);
    s.applySnapshot(snap());
    expect(s.floorName(V)).toBe('Frontend');
    expect(s.floorName('main')).toBe('main');
    expect(s.floorName('gone')).toBe('gone');
    expect(s.floorName('v-ffffffffffff')).toBe('That floor');
  });

  it('a virtual floor upsert never replaces its base floor', () => {
    const s = new WorldStore(1000);
    s.applySnapshot(snap());
    s.applyEvent({ t: 'floor.upsert', seq: 11, floor: vfloor(V, 'Frontend app', 'main', { index: 1 }) });
    expect(s.floors.get('main')?.virtual).toBe(false);
    expect(s.floorView(V)?.name).toBe('Frontend app');
  });

  it('removing a virtual floor drops only its own workers', () => {
    const s = new WorldStore(1000);
    s.applySnapshot(snap());
    const c = s.applyEvent({ t: 'floor.removed', seq: 11, session: 'main', floor_id: V });
    expect(c.structure).toBe(true);
    expect([...s.floors.keys()]).toEqual(['main', 'other']);
    expect([...s.workers.keys()]).toEqual(['a']);
    expect(s.stack('b1').map((f) => f.id)).toEqual(['main', 'other']);
  });

  it('removing a session’s real floor drops its virtual floors and all their workers too', () => {
    const s = new WorldStore(1000);
    s.applySnapshot(snap());
    const c = s.applyEvent({ t: 'floor.removed', seq: 11, session: 'main', floor_id: 'main' });
    expect([...s.floors.keys()]).toEqual(['other']);
    expect(s.workers.size).toBe(0);
    expect([...c.floors].sort()).toEqual([V, 'main'].sort());
  });

  it('moves a worker between floors of one session (floor.delete with move_workers)', () => {
    const s = new WorldStore(1000);
    s.applySnapshot(snap());
    expect(s.floorView('main')?.workers).toHaveLength(1);
    const c = s.applyEvent({ t: 'worker.upsert', seq: 11, worker: worker('b', 'main', 'main', { desk_index: 1 }) });
    expect(c.structure).toBe(true);
    expect([...c.floors].sort()).toEqual([V, 'main'].sort());
    expect(s.floorView('main')?.workers.map((w) => w.worker.id)).toEqual(['a', 'b']);
    expect(s.floorView(V)?.workers.map((w) => w.worker.id)).toEqual(['c']);
  });

  it('marks the floor of a status, usage or removal by the worker’s floor', () => {
    const s = new WorldStore(1000);
    s.applySnapshot(snap());
    const c = s.applyEvent({ t: 'worker.status', seq: 11, id: 'b', session: 'main', floor_id: V, workspace_id: 'ws-b', status: 'working' });
    expect([...c.floors]).toEqual([V]);
    const r = s.applyEvent({ t: 'worker.removed', seq: 12, id: 'c', session: 'main', floor_id: V, workspace_id: 'ws-c' });
    expect([...r.floors]).toEqual([V]);
    expect(s.floorView(V)?.workers.map((w) => w.worker.id)).toEqual(['b']);
  });

  it('counts handoffs by floor id (an older bridge: by session)', () => {
    const s = new WorldStore(1000);
    s.applySnapshot(snap({ handoffs: { counts: { [V]: 2 } } }));
    expect(s.handoffs.count(V)).toBe(2);
    const entry = { id: 1, floor: V } as never;
    const c = s.applyEvent({ t: 'handoff.added', seq: 11, session: 'main', floor_id: V, handoff: entry, handoff_count: 3 });
    expect(s.handoffs.count(V)).toBe(3);
    expect(s.handoffs.count('main')).toBe(0);
    expect([...c.floors]).toEqual([V]);
    s.applyEvent({ t: 'handoff.removed', seq: 12, session: 'main', handoff_id: 1, handoff_count: 4 });
    expect(s.handoffs.count('main')).toBe(4);
  });

  describe('hidden floors (decision 2)', () => {
    const hidden = (workers: Worker[]) =>
      snap({
        buildings: [{ id: 'b1', name: 'Work', sort: 0, floors: ['main', V] }],
        floors: [floor('main', { hidden: true }), vfloor(V, 'Frontend', 'main', { index: 1 }), floor('lot', { building: null, index: null, hidden: true })],
        workers,
      });

    it('leaves a hidden floor with no workers out of the building, the lot and the city', () => {
      const s = new WorldStore(1000);
      s.applySnapshot(hidden([worker('b', V, 'main')]));
      expect(s.stack('b1').map((f) => f.id)).toEqual([V]);
      expect(s.stack(null)).toEqual([]);
      expect(s.city().map((b) => b.floors.map((f) => f.id))).toEqual([[V]]);
      expect(s.level(V)).toEqual({ number: 1, count: 1 });
      // Still in the world: a direct look (the URL, a test hook) finds it.
      expect(s.floorView('main')?.hidden).toBe(true);
    });

    it('shows a hidden floor again as soon as a worker is on it (an unattributed workspace)', () => {
      const s = new WorldStore(1000);
      s.applySnapshot(hidden([worker('b', V, 'main')]));
      const c = s.applyEvent({ t: 'worker.upsert', seq: 11, worker: worker('tui', 'main') });
      expect(c.structure).toBe(true);
      expect(s.stack('b1').map((f) => f.id)).toEqual(['main', V]);
      expect(s.level('main')).toEqual({ number: 2, count: 2 });
      s.applyEvent({ t: 'worker.upsert', seq: 12, worker: worker('l', 'lot') });
      expect(s.stack(null).map((f) => f.id)).toEqual(['lot']);
      s.applyEvent({ t: 'worker.removed', seq: 13, id: 'tui', session: 'main', floor_id: 'main', workspace_id: 'ws-tui' });
      expect(s.stack('b1').map((f) => f.id)).toEqual([V]);
    });

    it('applies a hide or unhide from floor.upsert', () => {
      const s = new WorldStore(1000);
      s.applySnapshot(snap());
      s.applyEvent({ t: 'floor.upsert', seq: 11, floor: floor('other', { index: 2, hidden: true }) });
      expect(s.stack('b1').map((f) => f.id)).toEqual(['main', V]);
      s.applyEvent({ t: 'floor.upsert', seq: 12, floor: floor('other', { index: 2, hidden: false }) });
      expect(s.stack('b1').map((f) => f.id)).toEqual(['main', V, 'other']);
    });

    it('keeps the floor you stand on listed while it is hidden and empty (stage 4: hiding never yanks you off it)', () => {
      const s = new WorldStore(1000);
      s.applySnapshot(hidden([worker('b', V, 'main'), worker('tui', 'main')]));
      expect(s.pin('main')).toBe(false); // it shows anyway: a worker is on it
      s.applyEvent({ t: 'worker.removed', seq: 11, id: 'tui', session: 'main', floor_id: 'main', workspace_id: 'ws-tui' });
      expect(s.stack('b1').map((f) => f.id)).toEqual(['main', V]);
      expect(s.level('main')).toEqual({ number: 2, count: 2 });
      // Leaving it: the lists change (the city rebuilds).
      const v = s.structureVersion;
      expect(s.pin(null)).toBe(true);
      expect(s.structureVersion).toBe(v + 1);
      expect(s.stack('b1').map((f) => f.id)).toEqual([V]);
      // A ?floor= link to a hidden floor: pinned before the building is read, it has a storey.
      expect(s.pin('lot')).toBe(true);
      expect(s.stack(null).map((f) => f.id)).toEqual(['lot']);
      expect(s.pin('lot')).toBe(false);
    });
  });

  describe('Settings → Floors rows (stage 4)', () => {
    it('groups the floors by session, the real floor first, with who works on each', () => {
      const s = new WorldStore(1000);
      s.applySnapshot(
        snap({
          floors: [floor('main'), vfloor(W, 'Backend', 'main', { index: 2, hidden: true }), vfloor(V, 'Frontend', 'main', { index: 1 }), floor('other', { index: 3, state: 'asleep' })],
          workers: [worker('a', 'main', 'main', { name: 'Nibble' }), worker('c', V, 'main', { desk_index: 3, name: 'Pixel' }), worker('b', V, 'main', { desk_index: 0, name: 'Mochi' })],
        }),
      );
      expect(s.floorList.groups).toEqual([
        {
          session: 'main',
          real: { id: 'main', name: 'main', session: 'main', virtual: false, hidden: false, asleep: false, workers: ['Nibble'] },
          virtual: [
            { id: W, name: 'Backend', session: 'main', virtual: true, hidden: true, asleep: false, workers: [] },
            { id: V, name: 'Frontend', session: 'main', virtual: true, hidden: false, asleep: false, workers: ['Mochi', 'Pixel'] },
          ],
        },
        { session: 'other', real: { id: 'other', name: 'other', session: 'other', virtual: false, hidden: false, asleep: true, workers: [] }, virtual: [] },
      ]);
      expect(s.floorList.row(V)?.name).toBe('Frontend');
      expect(s.floorList.row('gone')).toBeNull();
    });

    it('tells its listeners when the rows change, not on a worker’s status', () => {
      const s = new WorldStore(1000);
      s.applySnapshot(snap());
      let told = 0;
      s.floorList.onChange(() => told++);
      s.applyEvent({ t: 'worker.status', seq: 11, id: 'b', session: 'main', workspace_id: 'ws-b', status: 'working' });
      expect(told).toBe(0);
      s.applyEvent({ t: 'floor.upsert', seq: 12, floor: vfloor(V, 'Front end', 'main', { index: 1 }) });
      expect(told).toBe(1);
      expect(s.floorList.row(V)?.name).toBe('Front end');
      s.applyEvent({ t: 'worker.upsert', seq: 13, worker: worker('b', V, 'main', { desk_index: 0, name: 'Renamed' }) });
      expect(told).toBe(2);
      s.applyEvent({ t: 'floor.removed', seq: 14, session: 'main', floor_id: V });
      expect(told).toBe(3);
      expect(s.floorList.row(V)).toBeNull();
    });
  });

  it('lists a building’s floors that share a session (the floors a sleep puts to sleep)', () => {
    const s = new WorldStore(1000);
    s.applySnapshot(snap({ floors: [floor('main'), vfloor(V, 'Frontend', 'main', { index: 1 }), vfloor(W, 'Backend', 'main', { index: 2, hidden: true }), floor('other', { index: 3 })] }));
    expect(s.sessionFloors('main').map((f) => f.id)).toEqual(['main', V, W]);
    expect(s.sessionFloors('other').map((f) => f.id)).toEqual(['other']);
  });
});
