import { describe, expect, it } from 'vitest';
import type { Snapshot, WorldEvent } from '../src/net/protocol';
import { DEFAULT_HIRE_OPTIONS, WorldStore } from '../src/world/store';
import { loadFixture } from './fixture-server';
import { SIM_HIRE_OPTIONS, SimWorld } from './fixture-sim';

type Msg = Record<string, unknown>;

/** A sim on the demo fixture, a store fed by it, and manual timers. */
function rig(fixture = 'demo', fail?: string) {
  const timers: Array<() => void> = [];
  const { snapshot } = loadFixture(fixture);
  const sim = new SimWorld(snapshot as never, { fail, setTimeout: (fn) => timers.push(fn), clearTimeout: () => {} });
  const store = new WorldStore(0);
  store.applySnapshot(sim.snapshot() as unknown as Snapshot);
  const out: Msg[] = [];
  let n = 0;
  const send = (m: Msg) => {
    out.push(m);
    if (typeof m.seq === 'number') {
      expect(m.seq).toBe(store.seq + 1);
      store.applyEvent(m as unknown as WorldEvent);
    }
  };
  const cmd = (t: string, args: unknown) => {
    const req_id = `r${++n}`;
    const from = out.length;
    sim.handle({ t, req_id, args }, send);
    return { req_id, got: () => out.slice(from) };
  };
  /** The command's reply (ack or error), once it came. */
  const reply = (req_id: string) => out.find((m) => m.req_id === req_id);
  const tick = () => {
    const fn = timers.shift();
    if (!fn) throw new Error('nothing scheduled');
    fn();
  };
  const settle = () => {
    while (timers.length) tick();
  };
  return { sim, store, out, cmd, reply, tick, settle, timers };
}

const W = 'b_3f09a1c2d4e5';
const P = 'b_77aa01b2c3d4';

describe('SimWorld buildings', () => {
  it('creates, renames and deletes a building like the bridge, events before the ack', () => {
    const r = rig();
    const c = r.cmd('building.create', { name: '  Lab ' });
    const [ev, ack] = c.got();
    expect(ev).toMatchObject({ t: 'building.upsert', building: { name: 'Lab', sort: 2, floors: [] } });
    const id = (ack?.data as { id: string }).id;
    expect(ack).toEqual({ t: 'ack', req_id: c.req_id, data: { id } });
    expect(r.cmd('building.create', { name: 'lab' }).got()).toEqual([expect.objectContaining({ t: 'error', code: 'name_taken' })]);
    expect(r.cmd('building.create', { name: ' ' }).got()[0]).toMatchObject({ code: 'bad_request' });
    expect(r.cmd('building.create', { name: 'x', color: 1 }).got()[0]).toMatchObject({ code: 'bad_request' });
    r.cmd('building.rename', { id, name: 'Studio' });
    expect(r.store.buildings.get(id)?.name).toBe('Studio');
    expect(r.cmd('building.rename', { id: 'b_nope', name: 'x' }).got()[0]).toMatchObject({ code: 'not_found' });

    // Deleting Work sends its floors to the lot and shifts the later buildings up.
    const d = r.cmd('building.delete', { id: W }).got();
    expect(d.map((m) => m.t)).toEqual(['floor.upsert', 'floor.upsert', 'building.upsert', 'building.upsert', 'building.removed', 'ack']);
    expect(r.store.stack(null).map((f) => f.session)).toEqual(['herdr-3d', 'depot-manager']);
    expect(r.store.city().map((b) => b.building?.name ?? 'lot')).toEqual(['Personal', 'Studio', 'lot']);
  });

  it('reorders buildings and rejects an incomplete order', () => {
    const r = rig();
    expect(r.cmd('building.reorder', { ids: [P] }).got()[0]).toMatchObject({ code: 'bad_request' });
    r.cmd('building.reorder', { ids: [P, W] });
    expect(r.store.city().map((b) => b.building?.name)).toEqual(['Personal', 'Work']);
  });

  it('assigns floors: into a building at an index, out to the lot, unknown sessions refused', () => {
    const r = rig();
    r.cmd('floor.assign', { session: 'pastry', building: W, index: 0 });
    expect(r.store.stack(W).map((f) => f.session)).toEqual(['pastry', 'herdr-3d', 'depot-manager']);
    expect(r.store.stack(P)).toEqual([]);
    r.cmd('floor.assign', { session: 'pastry', building: W, index: 2 });
    expect(r.store.stack(W).map((f) => [f.session, f.floor.index])).toEqual([
      ['herdr-3d', 0],
      ['depot-manager', 1],
      ['pastry', 2],
    ]);
    r.cmd('floor.assign', { session: 'herdr-3d', building: null });
    expect(r.store.stack(null).map((f) => f.session)).toEqual(['herdr-3d']);
    expect(r.store.stack(W).map((f) => [f.session, f.floor.index])).toEqual([
      ['depot-manager', 0],
      ['pastry', 1],
    ]);
    expect(r.cmd('floor.assign', { session: 'nope', building: null }).got()[0]).toMatchObject({ code: 'unknown_session' });
    expect(r.cmd('floor.assign', { session: 'pastry', building: 'b_nope' }).got()[0]).toMatchObject({ code: 'not_found' });
  });

  it('answers unknown commands and a missing req_id like the bridge', () => {
    const r = rig();
    expect(r.cmd('worker.hire', {}).got()[0]).toMatchObject({ t: 'error', code: 'unknown_command' });
    r.sim.handle({ t: 'building.create', args: { name: 'x' } }, (m) => r.out.push(m));
    expect(r.out.at(-1)).toEqual({ t: 'error', code: 'bad_request', message: 'missing req_id' });
  });
});

describe('SimWorld floor settings', () => {
  it('sets, keeps and clears keys: absent = unchanged, null = clear', () => {
    const r = rig();
    r.cmd('floor.settings.set', { session: 'herdr-3d', repo: 'JeffreyVdb/herdr-3d', project: { owner: 'JeffreyVdb', number: 3 } });
    expect(r.store.floorView('herdr-3d')?.settings).toEqual({ repo: 'JeffreyVdb/herdr-3d', project: { owner: 'JeffreyVdb', number: 3 } });
    r.cmd('floor.settings.set', { session: 'herdr-3d', repo: null, default_hire: { harness: 'codex', model: 'gpt-6-sol', effort: 'ultra' } });
    expect(r.store.floorView('herdr-3d')?.settings).toEqual({
      project: { owner: 'JeffreyVdb', number: 3 },
      default_hire: { harness: 'codex', model: 'gpt-6-sol', effort: 'ultra' },
    });
  });

  it.each([
    [{ repo: 'nope' }],
    [{ project: { owner: 'o', number: 0 } }],
    [{ status_field: { name: 'S', options: ['a', 'a'] } }],
    [{ status_field: { name: 'S', options: [] } }],
    [{ default_cwd: 'relative/path' }],
    [{ default_cwd: '/home/missing' }],
    [{ default_hire: { harness: 'codex', model: 'gpt-6-luna', effort: 'ultra' } }],
    [{ colour: 'red' }],
  ])('refuses %j', (patch) => {
    const r = rig();
    expect(r.cmd('floor.settings.set', { session: 'herdr-3d', ...patch }).got()).toEqual([expect.objectContaining({ t: 'error', code: 'bad_request' })]);
  });
});

describe('SimWorld wake and sleep', () => {
  it('sleeps a floor: transition, then asleep workers at the same desks, then the ack', () => {
    const r = rig();
    const desks = () => r.store.floorView('herdr-3d')?.workers.map((w) => [w.worker.id, w.desk]);
    const before = desks();
    const c = r.cmd('floor.sleep', { session: 'herdr-3d' });
    expect(r.store.floorView('herdr-3d')).toMatchObject({ transition: 'sleeping', asleep: false });
    expect(r.reply(c.req_id)).toBeUndefined();
    r.settle();
    expect(r.store.floorView('herdr-3d')).toMatchObject({ transition: null, asleep: true });
    expect(r.store.floorView('herdr-3d')?.workers.every((w) => w.worker.status === 'unknown')).toBe(true);
    expect(desks()).toEqual(before);
    expect(r.reply(c.req_id)).toEqual({ t: 'ack', req_id: c.req_id });
    expect(r.cmd('floor.sleep', { session: 'herdr-3d' }).got()[0]).toMatchObject({ code: 'invalid_state' });
  });

  it('wakes a floor step by step with per-worker resume progress, and restores statuses', () => {
    const r = rig();
    const statuses = r.store.floorView('pastry')?.workers.map((w) => w.worker.status);
    r.cmd('floor.sleep', { session: 'pastry' });
    r.settle();
    const c = r.cmd('floor.wake', { session: 'pastry' });
    expect(r.store.floorView('pastry')).toMatchObject({ transition: 'waking', asleep: true });
    expect(r.cmd('floor.wake', { session: 'pastry' }).got()[0]).toMatchObject({ code: 'busy' });
    expect(r.cmd('floor.settings.set', { session: 'pastry', repo: null }).got()[0]).toMatchObject({ code: 'busy' });
    r.tick();
    const v = r.store.floorView('pastry');
    expect(v).toMatchObject({ transition: 'waking', asleep: false });
    expect(v?.resume).toEqual({ pending: 14, confirmed: 0, fallback: 0, failed: 0, total: 14 });
    r.tick();
    expect(r.store.floorView('pastry')?.resume).toMatchObject({ pending: 13, confirmed: 1 });
    r.settle();
    expect(r.store.floorView('pastry')).toMatchObject({ transition: null, asleep: false });
    expect(r.store.floorView('pastry')?.resume).toMatchObject({ pending: 0, confirmed: 10, fallback: 4 });
    expect(r.store.floorView('pastry')?.workers.map((w) => w.worker.status)).toEqual(statuses);
    const ack = r.reply(c.req_id) as { data: { workers: Array<{ resume: string }> } };
    expect(ack.data.workers).toHaveLength(14);
    expect(new Set(ack.data.workers.map((w) => w.resume))).toEqual(new Set(['confirmed', 'fallback']));
  });

  it('wakes a floor that was asleep in the fixture', () => {
    const r = rig();
    expect(r.cmd('floor.wake', { session: 'herdr-3d' }).got()[0]).toMatchObject({ code: 'invalid_state' });
    r.cmd('floor.wake', { session: 'depot-manager' });
    r.settle();
    expect(r.store.floorView('depot-manager')).toMatchObject({ asleep: false, transition: null, counts: { working: 3, idle: 5 } });
  });

  it('can script a failed wake: the transition ends, the floor stays asleep, wake_failed', () => {
    const r = rig('demo', 'wake_failed');
    const c = r.cmd('floor.wake', { session: 'depot-manager' });
    r.settle();
    expect(r.store.floorView('depot-manager')).toMatchObject({ asleep: true, transition: null });
    expect(r.reply(c.req_id)).toMatchObject({ t: 'error', code: 'wake_failed' });
    // Only once: the next wake works.
    r.cmd('floor.wake', { session: 'depot-manager' });
    r.settle();
    expect(r.store.floorView('depot-manager')?.asleep).toBe(false);
  });

  it('keeps the world across commands in its snapshot', () => {
    const r = rig();
    r.cmd('building.create', { name: 'Lab' });
    r.cmd('floor.assign', { session: 'pastry', building: null });
    const s = r.sim.snapshot() as { seq: number; world: { buildings: Array<{ name: string; floors: string[] }>; unassigned: string[] } };
    expect(s.seq).toBe(r.store.seq);
    expect(s.world.buildings.map((b) => [b.name, b.floors])).toEqual([
      ['Work', ['herdr-3d', 'depot-manager']],
      ['Personal', []],
      ['Lab', []],
    ]);
    expect(s.world.unassigned).toEqual(['pastry']);
  });

  it('uses the same hire options as the game’s fallback', () => {
    expect(SIM_HIRE_OPTIONS).toEqual(DEFAULT_HIRE_OPTIONS);
  });
});
