import { describe, expect, it } from 'vitest';
import type { Floor, Snapshot, Worker } from '../net/protocol';
import { DEFAULT_HIRE_OPTIONS, WorldStore } from './store';
import { resolveChoice } from './hire';
import { effortsFor, parseForm, formFrom } from './settings';

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
    expect(v?.counts).toEqual({ working: 0, needsYou: 1, idle: 2, done: 0, waiting: 0, total: 3 });
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

describe('WorldStore M3 fields', () => {
  it('falls back for an older bridge: no transition, empty settings and suggestion, built-in hire options', () => {
    const s = new WorldStore();
    s.applySnapshot(snap());
    const v = s.floorView('top');
    expect(v).toMatchObject({ transition: null, settings: {}, suggested: {}, resume: null });
    expect(s.hireOptions).toEqual(DEFAULT_HIRE_OPTIONS);
    expect(s.hireOptions.codex?.extra_efforts).toEqual({ 'gpt-6-sol': ['ultra'], 'gpt-6-astra': ['ultra'] });
  });

  it('takes transition, settings, suggested and hire_options from the bridge', () => {
    const s = new WorldStore();
    const hire_options = { claude: { models: ['claude-opus-5-5'], efforts: ['high'] } };
    s.applySnapshot(
      snap({
        hire_options,
        floors: [
          floor('top', {
            transition: 'waking',
            settings: { repo: 'JeffreyVdb/herdr-3d', project: { owner: 'JeffreyVdb', number: 3 } },
            suggested: { repo: 'JeffreyVdb/herdr-3d', default_cwd: '/home/dev/devel/herdr-3d' },
          }),
        ],
      }),
    );
    expect(s.floorView('top')).toMatchObject({
      transition: 'waking',
      settings: { repo: 'JeffreyVdb/herdr-3d', project: { owner: 'JeffreyVdb', number: 3 } },
      suggested: { default_cwd: '/home/dev/devel/herdr-3d' },
    });
    expect(s.hireOptions).toEqual(hire_options);
  });

  it('ignores a transition or hire_options it does not understand', () => {
    const s = new WorldStore();
    s.applySnapshot(snap({ hire_options: { claude: { models: 'nope' } } as never, floors: [floor('top', { transition: 'melting' as never })] }));
    expect(s.floorView('top')?.transition).toBeNull();
    expect(s.hireOptions).toEqual(DEFAULT_HIRE_OPTIONS);
  });

  it('uses newly discovered models and exact effort sets in hire and settings choices', () => {
    const s = new WorldStore();
    const hire_options = {
      codex: { models: ['gpt-6.1-sol', 'gpt-future'], efforts: [], extra_efforts: { 'gpt-6.1-sol': ['high', 'ultra'], 'gpt-future': ['low'] } },
    };
    s.applySnapshot(snap({ hire_options }));
    const choice = { harness: 'codex', model: 'gpt-6.1-sol', effort: 'ultra' };
    expect(resolveChoice(s.hireOptions, choice)).toEqual(choice);
    expect(effortsFor(s.hireOptions, 'codex', 'gpt-future')).toEqual(['low']);
    expect(s.hireOptions.codex?.models).not.toContain('gpt-6-sol');
    const form = formFrom({ default_hire: choice }, {}).form;
    expect(parseForm(form, s.hireOptions).errors).toEqual({});
    expect(parseForm({ ...form, model: 'gpt-future' }, s.hireOptions).errors.effort).toBeTruthy();
  });

  it('flips asleep ↔ running on a live floor.upsert, keeping every worker at its desk', () => {
    const s = new WorldStore();
    s.applySnapshot(
      snap({
        floors: [floor('top', { desks: 6 })],
        workers: [worker('a', 'top', { desk_index: 3, status: 'working' }), worker('b', 'top', { status: 'blocked' })],
      }),
    );
    const desks = () => s.floorView('top')?.workers.map((w) => [w.worker.id, w.desk, w.display]);
    expect(desks()).toEqual([
      ['b', 0, 'needs_you'],
      ['a', 3, 'working'],
    ]);
    s.applyEvent({ t: 'floor.upsert', seq: 11, floor: floor('top', { desks: 6, transition: 'sleeping' }) });
    expect(s.floorView('top')).toMatchObject({ asleep: false, transition: 'sleeping' });
    s.applyEvent({ t: 'floor.upsert', seq: 12, floor: floor('top', { desks: 6, state: 'asleep' }) });
    expect(s.floorView('top')).toMatchObject({ asleep: true, transition: null });
    expect(desks()).toEqual([
      ['b', 0, 'asleep'],
      ['a', 3, 'asleep'],
    ]);
    s.applyEvent({ t: 'floor.upsert', seq: 13, floor: floor('top', { desks: 6, state: 'running' }) });
    expect(desks()).toEqual([
      ['b', 0, 'needs_you'],
      ['a', 3, 'working'],
    ]);
  });

  it('counts resume progress over the workers that report one', () => {
    const s = new WorldStore();
    s.applySnapshot(
      snap({
        floors: [floor('top', { transition: 'waking' })],
        workers: [
          worker('a', 'top', { resume: 'pending' }),
          worker('b', 'top', { resume: 'confirmed' }),
          worker('c', 'top', { resume: 'fallback' }),
          worker('d', 'top'),
        ],
      }),
    );
    expect(s.floorView('top')?.resume).toEqual({ pending: 1, confirmed: 1, fallback: 1, failed: 0, total: 3 });
    s.applyEvent({ t: 'worker.upsert', seq: 11, worker: worker('a', 'top', { resume: 'failed' }) });
    expect(s.floorView('top')?.resume).toMatchObject({ pending: 0, failed: 1 });
  });

  it('lists a building’s floors top to bottom, and the lot by name', () => {
    const s = new WorldStore();
    s.applySnapshot(snap({ floors: [floor('top'), floor('bottom', { index: 1 }), floor('lot', { building: null, index: null }), floor('alpha', { building: null, index: null })] }));
    expect(s.stack('b1').map((f) => f.session)).toEqual(['top', 'bottom']);
    expect(s.stack(null).map((f) => f.session)).toEqual(['alpha', 'lot']);
    expect(s.stack('nope')).toEqual([]);
  });
});

describe('WorldStore: building logos (M3d)', () => {
  it('keeps the logo hash of a building through snapshots and upserts, and ignores odd values', async () => {
    const { logoHashOf } = await import('../net/protocol');
    const s = new WorldStore(1000);
    const hash = 'a'.repeat(64);
    s.applySnapshot(snap({ buildings: [{ id: 'b1', name: 'Work', sort: 0, floors: ['top', 'bottom'], logo: hash }] }));
    expect(logoHashOf(s.buildings.get('b1'))).toBe(hash);
    // A building.upsert with a new hash replaces it and marks the structure changed (the views rebuild what they show).
    const c = s.applyEvent({ t: 'building.upsert', seq: 11, building: { id: 'b1', name: 'Work', sort: 0, floors: ['top', 'bottom'], logo: 'b'.repeat(64) } });
    expect(c.structure).toBe(true);
    expect(logoHashOf(s.buildings.get('b1'))).toBe('b'.repeat(64));
    // Cleared: the key is gone.
    s.applyEvent({ t: 'building.upsert', seq: 12, building: { id: 'b1', name: 'Work', sort: 0, floors: ['top', 'bottom'] } });
    expect(logoHashOf(s.buildings.get('b1'))).toBeNull();
    // Odd values (an older or newer bridge) are no logo.
    for (const odd of [123, '', 'not hex!', null, {}, 'ab']) {
      s.applyEvent({ t: 'building.upsert', seq: 13, building: { id: 'b1', name: 'Work', sort: 0, floors: [], logo: odd as never } });
      expect(logoHashOf(s.buildings.get('b1'))).toBeNull();
    }
  });
});
