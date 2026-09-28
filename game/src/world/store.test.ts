import { describe, expect, it } from 'vitest';
import type { Floor, Snapshot, Worker } from '../net/protocol';
import { WorldStore } from './store';

const floor = (session: string, over: Partial<Floor> = {}): Floor => ({
  session,
  state: 'running',
  building: 'b1',
  index: 0,
  ...over,
});

const worker = (id: string, session: string, over: Partial<Worker> = {}): Worker => ({
  id,
  session,
  workspace_id: `ws-${id}`,
  label: `label-${id}`,
  status: 'idle',
  ...over,
});

const snap = (over: Partial<Snapshot['world']> = {}, seq = 10): Snapshot => ({
  t: 'world.snapshot',
  seq,
  world: {
    buildings: [{ id: 'b1', name: 'Work', sort: 0, floors: ['top', 'bottom'] }],
    unassigned: ['lot'],
    floors: [floor('top'), floor('bottom', { index: 1 }), floor('lot', { building: null, index: null, state: 'asleep' })],
    workers: [],
    ...over,
  },
});

describe('WorldStore snapshot', () => {
  it('uses the M2 fields when the bridge sends them', () => {
    const s = new WorldStore(1000);
    s.applySnapshot(
      snap({
        floors: [floor('top', { desks: 9 })],
        workers: [
          worker('a', 'top', { name: 'Nibble', desk_index: 4, harness: 'claude', model: 'claude-opus-5-5', status_since: 500 }),
          worker('b', 'top', { name: 'Pixel', desk_index: 0, status: 'working' }),
        ],
      }),
    );
    const v = s.floorView('top');
    expect(v?.desks).toBe(9);
    expect(v?.seats.map((x) => x?.name ?? null)).toEqual(['Pixel', null, null, null, 'Nibble', null, null, null, null]);
    expect(s.workerView('a')).toMatchObject({ name: 'Nibble', desk: 4, harness: 'claude', since: 500, display: 'idle' });
    expect(s.workerView('b')?.since).toBe(1000); // no status_since: page-load time
  });

  it('falls back for an older bridge: label names, local desks, desk formula, harness from agent_kind', () => {
    const s = new WorldStore(1000);
    s.applySnapshot(
      snap({
        floors: [floor('top')],
        workers: [
          worker('a', 'top', { agent_kind: 'claude' }),
          worker('b', 'top', { agent_kind: 'codex', status: 'blocked' }),
          worker('c', 'top', { label: '  ' }),
        ],
      }),
    );
    const v = s.floorView('top');
    expect(v?.desks).toBe(6); // min 6
    expect(v?.workers.map((w) => [w.name, w.desk, w.harness ?? null])).toEqual([
      ['label-a', 0, 'claude'],
      ['label-b', 1, 'codex'],
      ['Worker', 2, null],
    ]);
    expect(v?.counts).toEqual({ working: 0, needsYou: 1, idle: 2, done: 0, total: 3 });
  });

  it('always leaves two free desks above six workers, capped at 96', () => {
    const s = new WorldStore();
    const ws = (n: number) => Array.from({ length: n }, (_, i) => worker(`w${i}`, 'top'));
    s.applySnapshot(snap({ floors: [floor('top')], workers: ws(7) }));
    expect(s.floorView('top')?.desks).toBe(9);
    s.applySnapshot(snap({ floors: [floor('top')], workers: ws(120) }));
    expect(s.floorView('top')?.desks).toBe(120); // never fewer desks than slots in use
    s.applySnapshot(snap({ floors: [floor('top')], workers: ws(95) }));
    expect(s.floorView('top')?.desks).toBe(96);
  });

  it('never renders fewer desks than the highest desk index', () => {
    const s = new WorldStore();
    s.applySnapshot(snap({ floors: [floor('top', { desks: 3 })], workers: [worker('a', 'top', { desk_index: 7 })] }));
    expect(s.floorView('top')?.desks).toBe(8);
  });

  it('stacks building floors ground-first and numbers them', () => {
    const s = new WorldStore();
    s.applySnapshot(snap());
    const city = s.city();
    expect(city.map((b) => [b.building?.name ?? 'lot', b.floors.map((f) => f.session)])).toEqual([
      ['Work', ['bottom', 'top']],
      ['lot', ['lot']],
    ]);
    expect(s.floorView('top')?.level).toEqual({ number: 2, count: 2 });
    expect(s.floorView('bottom')?.level).toEqual({ number: 1, count: 2 });
    expect(s.floorView('lot')?.level).toBeNull();
    expect(s.floorView('lot')?.asleep).toBe(true);
  });

  it('shows every worker of an asleep floor as asleep', () => {
    const s = new WorldStore();
    s.applySnapshot(snap({ workers: [worker('z', 'lot', { status: 'unknown' })] }));
    expect(s.workerView('z')?.display).toBe('asleep');
    expect(s.floorView('lot')?.counts).toMatchObject({ working: 0, needsYou: 0, total: 1 });
  });

  it('keeps local desks for the same workers across a resync snapshot', () => {
    const s = new WorldStore();
    s.applySnapshot(snap({ floors: [floor('top')], workers: [worker('a', 'top'), worker('b', 'top'), worker('c', 'top')] }));
    expect(s.workerView('c')?.desk).toBe(2);
    s.applySnapshot(snap({ floors: [floor('top')], workers: [worker('c', 'top'), worker('d', 'top')] }));
    expect(s.workerView('c')?.desk).toBe(2);
    expect(s.workerView('d')?.desk).toBe(0);
  });
});

describe('WorldStore events', () => {
  const base = () => {
    const s = new WorldStore(1000);
    s.applySnapshot(
      snap({
        floors: [floor('top', { desks: 6 }), floor('bottom', { index: 1 })],
        workers: [
          worker('a', 'top', { name: 'Nibble', desk_index: 0, status: 'working', title: 'Fix the tests' }),
          worker('b', 'top', { name: 'Pixel', desk_index: 1 }),
        ],
      }),
    );
    return s;
  };

  it('applies a rich worker.status (status_since + title) as a worker-only change', () => {
    const s = base();
    const c = s.applyEvent({
      t: 'worker.status',
      seq: 11,
      id: 'a',
      session: 'top',
      workspace_id: 'ws-a',
      status: 'blocked',
      prev_status: 'working',
      status_since: 5000,
      title: 'Approve the migration?',
    });
    expect(c.structure).toBe(false);
    expect([...c.workers]).toEqual(['a']);
    expect(s.workerView('a')).toMatchObject({ display: 'needs_you', since: 5000 });
    expect(s.workers.get('a')?.title).toBe('Approve the migration?');
    expect(s.seq).toBe(11);
  });

  it('keeps the title on an old-style worker.status and stamps the receive time', () => {
    const s = base();
    s.applyEvent({ t: 'worker.status', seq: 11, id: 'a', session: 'top', workspace_id: 'ws-a', status: 'done' }, 7000);
    expect(s.workers.get('a')?.title).toBe('Fix the tests');
    expect(s.workerView('a')).toMatchObject({ display: 'done', since: 7000 });
  });

  it('clears the title when worker.status carries an empty one', () => {
    const s = base();
    s.applyEvent({ t: 'worker.status', seq: 11, id: 'a', session: 'top', workspace_id: 'ws-a', status: 'idle', title: '' });
    expect(s.workers.get('a')?.title).toBeUndefined();
  });

  it('ignores worker.status for an unknown worker', () => {
    const s = base();
    const c = s.applyEvent({ t: 'worker.status', seq: 11, id: 'nope', session: 'top', workspace_id: 'x', status: 'idle' });
    expect(c.workers.size).toBe(0);
  });

  it('hires into the given desk, frees it on removal', () => {
    const s = base();
    let c = s.applyEvent({ t: 'worker.upsert', seq: 11, worker: worker('n', 'top', { name: 'Mochi', desk_index: 2 }) });
    expect(c.structure).toBe(true);
    expect(s.floorView('top')?.seats[2]?.name).toBe('Mochi');
    c = s.applyEvent({ t: 'worker.removed', seq: 12, id: 'n', session: 'top', workspace_id: 'ws-n' });
    expect(c.structure).toBe(true);
    expect(s.floorView('top')?.seats[2]).toBeNull();
  });

  it('treats a worker.upsert that only changes the title as a worker change', () => {
    const s = base();
    const c = s.applyEvent({
      t: 'worker.upsert',
      seq: 11,
      worker: worker('b', 'top', { name: 'Pixel', desk_index: 1, title: 'Reading the docs' }),
    });
    expect(c.structure).toBe(false);
    expect([...c.workers]).toEqual(['b']);
  });

  it('moves a worker between floors', () => {
    const s = base();
    const c = s.applyEvent({ t: 'worker.upsert', seq: 11, worker: worker('b', 'bottom', { name: 'Pixel' }) });
    expect(c.structure).toBe(true);
    expect([...c.sessions].sort()).toEqual(['bottom', 'top']);
    expect(s.floorView('top')?.workers.map((w) => w.name)).toEqual(['Nibble']);
    expect(s.floorView('bottom')?.workers.map((w) => w.name)).toEqual(['Pixel']);
  });

  it('updates floors, desks and buildings', () => {
    const s = base();
    s.applyEvent({ t: 'floor.upsert', seq: 11, floor: floor('top', { desks: 12, state: 'asleep' }) });
    expect(s.floorView('top')).toMatchObject({ desks: 12, asleep: true });
    s.applyEvent({ t: 'building.upsert', seq: 12, building: { id: 'b1', name: 'Office', sort: 0, floors: ['bottom', 'top'] } });
    expect(s.floorView('top')?.level).toEqual({ number: 1, count: 2 });
    expect(s.city()[0]?.building?.name).toBe('Office');
    s.applyEvent({ t: 'floor.removed', seq: 13, session: 'top' });
    expect(s.floorView('top')).toBeNull();
    expect(s.workers.has('a')).toBe(false);
    s.applyEvent({ t: 'floor.upsert', seq: 14, floor: floor('bottom', { building: null, index: null }) });
    s.applyEvent({ t: 'building.removed', seq: 15, id: 'b1' });
    expect(s.city().map((b) => b.building)).toEqual([null]);
  });
});
