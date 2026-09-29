import { describe, expect, it } from 'vitest';
import type { Snapshot, WorldEvent } from '../src/net/protocol';
import { DEFAULT_HIRE_OPTIONS, WorldStore } from '../src/world/store';
import { loadFixture } from './fixture-server';
import { SIM_HIRE_OPTIONS, SimWorld, type SimOptions } from './fixture-sim';
import { parseCaps } from './fixture-server';

type Msg = Record<string, unknown>;

/** A sim on the demo fixture, a store fed by it, and manual timers. */
function rig(fixture = 'demo', fail?: string, extra: Partial<SimOptions> = {}) {
  const timers: Array<() => void> = [];
  const { snapshot } = loadFixture(fixture);
  const sim = new SimWorld(snapshot as never, { fail, setTimeout: (fn) => timers.push(fn), clearTimeout: () => {}, ...extra });
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
    expect(r.cmd('worker.handoff', {}).got()[0]).toMatchObject({ t: 'error', code: 'unknown_command' });
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

  it('stores a status field on its own, labels as sent (commas, spaces)', () => {
    const r = rig();
    const status_field = { name: ' Stage ', options: ['Review, QA', ' Done'] };
    expect(r.cmd('floor.settings.set', { session: 'herdr-3d', status_field }).got().at(-1)).toMatchObject({ t: 'ack' });
    expect(r.store.floorView('herdr-3d')?.settings).toEqual({ status_field });
  });

  it.each([
    [{ repo: 'nope' }],
    [{ project: { owner: 'o', number: 0 } }],
    [{ status_field: { name: 'S', options: ['a', 'a'] } }],
    [{ status_field: { name: 'S', options: [] } }],
    [{ status_field: { name: 'S', options: ['a', '  '] } }],
    [{ status_field: { name: ' ', options: ['a'] } }],
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
    expect(r.cmd('floor.assign', { session: 'pastry', building: null }).got()[0]).toMatchObject({ code: 'busy' });
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

describe('SimWorld hire and send home (M4)', () => {
  const NOW = 1_790_600_000_000;
  const m4 = (fail?: string) => rig('demo-m4', fail, { now: () => NOW, caps: { scratchpad: { soft: 3, hard: 4 } } });
  const data = (m: Msg | undefined) => m?.data as Record<string, any>;
  const byLabel = (r: ReturnType<typeof m4>, label: string) => [...r.store.workers.values()].find((w) => w.label === label)!;

  it('prepares a hire: cwd, choice, next name, git base, capacity', () => {
    const r = m4();
    const p = data(r.cmd('hire.prepare', { session: 'pastry' }).got()[0]);
    expect(p).toMatchObject({ cwd: '/home/dev/pastry', choice: null, choice_source: 'none', label: 'Gumdrop' });
    expect(p.git).toMatchObject({ repo_root: '/home/dev/pastry', default_branch: 'main', fetched: true, base_time: NOW - 192 * 60_000 });
    expect(p.git.base_sha).toMatch(/^[0-9a-f]{40}$/);
    expect(p.capacity).toMatchObject({ floor: { count: 14, soft: 24, hard: 32 }, host: { soft: 60, hard: 80 } });
    // The floor default wins; a scratch folder is no repo; `offline` fails the fetch.
    expect(data(r.cmd('hire.prepare', { session: 'depot-manager' }).got()[0])).toBeUndefined();
    expect(r.cmd('hire.prepare', { session: 'depot-manager' }).got()[0]).toMatchObject({ t: 'error', code: 'invalid_state' });
    const s = data(r.cmd('hire.prepare', { session: 'scratchpad' }).got()[0]);
    expect(s).toMatchObject({ cwd: '/home/dev/scratch', git: null, capacity: { floor: { count: 3, soft: 3, hard: 4 } } });
    expect(data(r.cmd('hire.prepare', { session: 'pastry', cwd: '/home/dev/offline-repo' }).got()[0]).git).toMatchObject({ fetched: false, fetch_error: expect.stringMatching(/github/) });
    expect(r.cmd('hire.prepare', { session: 'pastry', cwd: 'rel' }).got()[0]).toMatchObject({ code: 'bad_request' });
    expect(r.cmd('hire.prepare', { session: 'nope' }).got()[0]).toMatchObject({ code: 'unknown_session' });
  });

  it('hires at a desk: worktree and branch, upsert before the ack, then the first task starts it', () => {
    const r = m4();
    const c = r.cmd('worker.hire', { session: 'pastry', desk_index: 14, harness: 'codex', model: 'gpt-6-sol', effort: 'ultra', label: 'Rye starter', worktree: true, prompt: 'Feed the starter\nat 8' });
    expect(c.got()).toEqual([]);
    r.tick();
    const got = c.got();
    // 15 workers: max(15, min(96, max(6, 17))) = 17 desks, the floor first.
    expect(got.map((m) => m.t)).toEqual(['floor.upsert', 'worker.upsert', 'ack']);
    expect(r.store.floorView('pastry')?.desks).toBe(17);
    const w = (got[1] as { worker: Record<string, unknown> }).worker;
    // Like the bridge: h3d/<name>-<first 6 hex of the id>.
    const branch = `h3d/gumdrop-${(w.id as string).replace(/-/g, '').slice(0, 6)}`;
    expect(w).toMatchObject({ session: 'pastry', desk_index: 14, name: 'Gumdrop', label: 'Rye starter', harness: 'codex', model: 'gpt-6-sol', effort: 'ultra', hired_at: NOW, branch });
    expect(w.worktree).toEqual({ repo_root: '/home/dev/pastry', repo_name: 'pastry', checkout_path: `/home/dev/pastry-wt/${branch.slice(4)}`, linked: true });
    expect(data(got[2])).toMatchObject({ id: w.id, branch, trust: 'approved', prompted: true });
    expect(r.store.floorView('pastry')?.seats[14]?.name).toBe('Gumdrop');
    r.tick();
    expect(r.store.workers.get(w.id as string)).toMatchObject({ status: 'working', title: 'Feed the starter' });
    // The last choice is remembered for the floor.
    expect(data(r.cmd('hire.prepare', { session: 'pastry' }).got()[0])).toMatchObject({ choice: { harness: 'codex', model: 'gpt-6-sol', effort: 'ultra' }, choice_source: 'last', label: 'Hopper' });
  });

  it('refuses taken desks, bad choices and hires over the hard cap; grows the floor', () => {
    const r = m4();
    const hire = (a: Record<string, unknown>) => r.cmd('worker.hire', { session: 'scratchpad', harness: 'claude', model: 'claude-opus-5-5', effort: 'high', ...a });
    expect(hire({ desk_index: 0 }).got()[0]).toMatchObject({ code: 'desk_taken' });
    expect(hire({ desk_index: 6 }).got()[0]).toMatchObject({ code: 'desk_taken', message: expect.stringMatching(/out of range/) });
    expect(hire({ desk_index: 3, effort: 'ultra' }).got()[0]).toMatchObject({ code: 'bad_request' });
    expect(hire({ desk_index: 3, worktree: true }).got()[0]).toMatchObject({ code: 'bad_request', message: expect.stringMatching(/not a git repository/) });
    expect(hire({ desk_index: 3, colour: 'red' }).got()[0]).toMatchObject({ code: 'bad_request' });
    expect(hire({ desk_index: 3, label: '-x' }).got()[0]).toMatchObject({ code: 'bad_request' });
    expect(hire({ desk_index: 3, prompt: '--help' }).got()[0]).toMatchObject({ code: 'bad_request' });
    const ok = hire({ desk_index: 5 });
    // The desk is held from the moment the hire is accepted.
    expect(hire({ desk_index: 5 }).got()[0]).toMatchObject({ code: 'desk_taken' });
    // The hire in flight counts against the cap already.
    expect(hire({ desk_index: 4 }).got()[0]).toMatchObject({ code: 'capacity' });
    r.tick();
    // 4 workers, the highest at desk 5: max(6, min(96, max(6, 6))) = 6 desks, no floor event; the next one is refused.
    expect(ok.got().filter((m) => m.t !== 'error').map((m) => m.t)).toEqual(['worker.upsert', 'ack']);
    expect(hire({ desk_index: 3 }).got()[0]).toMatchObject({ code: 'capacity', message: expect.stringMatching(/hard cap 4/) });
    // Growing: pastry has 14 workers on 16 desks; hiring at 15 and 14 makes it 16 on 18.
    r.cmd('worker.hire', { session: 'pastry', desk_index: 15, harness: 'claude', model: 'claude-opus-5-5', effort: 'high' });
    r.tick();
    const g = r.cmd('worker.hire', { session: 'pastry', desk_index: 14, harness: 'claude', model: 'claude-opus-5-5', effort: 'high' });
    r.tick();
    expect(g.got().map((m) => m.t)).toEqual(['floor.upsert', 'worker.upsert', 'ack']);
    expect(r.store.floorView('pastry')?.desks).toBe(18);
  });

  it('prepares a send-home: dirty, unpushed, whether the worktree may go', () => {
    const r = m4();
    const dirty = data(r.cmd('worker.fire.prepare', { id: byLabel(r, 'brioche').id }).got()[0]);
    expect(dirty).toMatchObject({ name: 'Jellybean', branch: 'h3d/brioche-levain', worktree: { path: '/home/dev/pastry-wt/brioche', linked: true }, unpushed: 2, can_delete: false });
    expect(dirty.dirty).toHaveLength(3);
    expect(dirty.reason).toBe('the worktree has uncommitted changes and 2 commits are not on any remote');
    expect(dirty.can_delete_branch).toBe(false);
    const clean = data(r.cmd('worker.fire.prepare', { id: byLabel(r, 'timers').id }).got()[0]);
    expect(clean).toMatchObject({ name: 'Marble', dirty: [], unpushed: 0, can_delete: true, can_delete_branch: true });
    expect(clean.reason).toBeUndefined();
    // Clean, but on a branch of the user's own: the worktree may go, the branch may not.
    expect(data(r.cmd('worker.fire.prepare', { id: byLabel(r, 'bridge-ws').id }).got()[0])).toMatchObject({ name: 'Noodle', branch: 'dev/bridge-ws', can_delete: true, can_delete_branch: false });
    const main = data(r.cmd('worker.fire.prepare', { id: byLabel(r, 'docs').id }).got()[0]);
    expect(main).toMatchObject({ worktree: { path: '/home/dev/devel/herdr-3d', linked: false }, can_delete: false });
    expect(data(r.cmd('worker.fire.prepare', { id: byLabel(r, 'pantry').id }).got()[0])).toMatchObject({ worktree: null, can_delete: false, can_fire: true });
    // The main checkout cannot go while its worktrees are open on the floor.
    expect(main).toMatchObject({ can_fire: false, fire_blocked: expect.stringMatching(/main checkout and 4 of its worktrees are still open here \(Pixel, Mochi, Noodle, Waffle\)/) });
    expect(r.cmd('worker.fire', { id: byLabel(r, 'docs').id }).got()[0]).toMatchObject({ code: 'fire_failed' });
    expect(r.cmd('worker.fire.prepare', { id: 'nope' }).got()[0]).toMatchObject({ code: 'unknown_worker' });
  });

  it('sends a worker home: worker.removed (sent_home) before the ack; never deletes a dirty tree', () => {
    const r = m4();
    const sour = byLabel(r, 'brioche');
    expect(r.cmd('worker.fire', { id: sour.id, worktree: 'delete' }).got()[0]).toMatchObject({ code: 'not_clean' });
    expect(r.cmd('worker.fire', { id: sour.id, worktree: 'burn' }).got()[0]).toMatchObject({ code: 'bad_request' });
    expect(r.cmd('worker.fire', { id: sour.id, handoff: true }).got()[0]).toMatchObject({ code: 'bad_request' });
    expect(r.cmd('worker.fire', { id: byLabel(r, 'pantry').id, worktree: 'delete' }).got()[0]).toMatchObject({ code: 'bad_request' });
    const timers = byLabel(r, 'timers');
    const c = r.cmd('worker.fire', { id: timers.id, worktree: 'delete_branch' });
    // Once on the way out, a second send-home is busy.
    expect(r.cmd('worker.fire', { id: timers.id }).got()[0]).toMatchObject({ code: 'busy' });
    r.tick();
    expect(c.got().filter((m) => m.t !== 'error')).toEqual([
      expect.objectContaining({ t: 'worker.removed', id: timers.id, session: 'pastry', reason: 'sent_home' }),
      // 13 workers, the highest at desk 13: 15 desks.
      expect.objectContaining({ t: 'floor.upsert', floor: expect.objectContaining({ session: 'pastry', desks: 15 }) }),
      { t: 'ack', req_id: c.req_id, data: { worktree: 'deleted_branch', released: true } },
    ]);
    expect(r.store.workers.has(timers.id)).toBe(false);
    const k = r.cmd('worker.fire', { id: sour.id });
    r.tick();
    expect(data(r.reply(k.req_id))).toEqual({ worktree: 'kept', released: true });
  });

  it('deletes only a branch it made for the worker (can_delete_branch)', () => {
    const r = m4();
    const noodle = byLabel(r, 'bridge-ws');
    expect(r.cmd('worker.fire', { id: noodle.id, worktree: 'delete_branch' }).got()[0]).toMatchObject({ code: 'bad_request', message: expect.stringMatching(/branch herdr-world made/) });
    expect(r.store.workers.has(noodle.id)).toBe(true);
    const k = r.cmd('worker.fire', { id: noodle.id, worktree: 'delete' });
    r.tick();
    expect(data(r.reply(k.req_id))).toEqual({ worktree: 'deleted', released: true });
    // A worktree hire records its branch: that one may go with it.
    const c = r.cmd('worker.hire', { session: 'pastry', desk_index: 15, harness: 'claude', model: 'claude-opus-5-5', effort: 'high', worktree: true });
    r.tick();
    const id = data(r.reply(c.req_id)).id as string;
    expect(data(r.cmd('worker.fire.prepare', { id }).got()[0])).toMatchObject({ branch: expect.stringMatching(/^h3d\//), worktree: { linked: true }, can_delete: true, can_delete_branch: true });
    const d = r.cmd('worker.fire', { id, worktree: 'delete_branch' });
    r.tick();
    expect(data(r.reply(d.req_id))).toEqual({ worktree: 'deleted_branch', released: true });
  });

  it('scripts failures: hire_failed, fire_failed, fetch_failed', () => {
    const h = m4('hire_failed');
    const c = h.cmd('worker.hire', { session: 'pastry', desk_index: 14, harness: 'claude', model: 'claude-opus-5-5', effort: 'high' });
    h.tick();
    expect(c.got()).toEqual([expect.objectContaining({ t: 'error', code: 'hire_failed' })]);
    const f = m4('fire_failed');
    const d = f.cmd('worker.fire', { id: byLabel(f, 'timers').id });
    f.tick();
    expect(d.got()).toEqual([expect.objectContaining({ t: 'error', code: 'fire_failed' })]);
    expect(f.store.workers.has(byLabel(f, 'timers').id)).toBe(true);
  });

  it('fetch_failed: origin stays unreachable; a worktree hire is refused and creates nothing, a plain hire goes through', () => {
    const g = m4('fetch_failed');
    for (let i = 0; i < 2; i++) expect(data(g.cmd('hire.prepare', { session: 'pastry' }).got()[0]).git).toMatchObject({ fetched: false, fetch_error: expect.stringMatching(/github/) });
    const before = g.store.workers.size;
    const c = g.cmd('worker.hire', { session: 'pastry', desk_index: 14, harness: 'claude', model: 'claude-opus-5-5', effort: 'high', worktree: true });
    g.tick();
    expect(c.got()).toEqual([expect.objectContaining({ t: 'error', code: 'fetch_failed', message: expect.stringMatching(/^fetch_failed: git fetch origin in \/home\/dev\/pastry: ssh: /) })]);
    expect(g.store.workers.size).toBe(before);
    // The desk was never held: the same desk hires without a worktree.
    const d = g.cmd('worker.hire', { session: 'pastry', desk_index: 14, harness: 'claude', model: 'claude-opus-5-5', effort: 'high', worktree: false });
    g.tick();
    expect(d.got().map((m) => m.t)).toEqual(['floor.upsert', 'worker.upsert', 'ack']);
    // An `offline` folder fails the same way, without simfail.
    const r = m4();
    const e = r.cmd('worker.hire', { session: 'pastry', desk_index: 15, harness: 'claude', model: 'claude-opus-5-5', effort: 'high', cwd: '/home/dev/offline-repo', worktree: true });
    r.tick();
    expect(e.got()).toEqual([expect.objectContaining({ t: 'error', code: 'fetch_failed' })]);
  });

  it('names the hire after a free generated-name label; a worktree of a repo with no open main checkout brings it along', () => {
    const r = m4();
    const c = r.cmd('worker.hire', { session: 'pastry', desk_index: 15, harness: 'claude', model: 'claude-opus-5-5', effort: 'high', label: 'Mango', cwd: '/home/dev/devel/grill', worktree: true });
    r.tick();
    const got = c.got();
    expect(got.map((m) => m.t)).toEqual(['floor.upsert', 'worker.upsert', 'floor.upsert', 'worker.upsert', 'ack']);
    const hired = (got[1] as { worker: Record<string, unknown> }).worker;
    const main = (got[3] as { worker: Record<string, unknown> }).worker;
    expect(hired).toMatchObject({ name: 'Mango', label: 'Mango', desk_index: 15, hired_at: NOW });
    // The main checkout: the lowest free desk (14), a generated name, no hired_at (no walk-in).
    expect(main).toMatchObject({ desk_index: 14, name: 'Gumdrop', cwd: '/home/dev/devel/grill', worktree: { linked: false } });
    expect(main.hired_at).toBeUndefined();
    // A label that is no generated name keeps the next name.
    const d = r.cmd('worker.hire', { session: 'scratchpad', desk_index: 3, harness: 'claude', model: 'claude-opus-5-5', effort: 'high', label: 'notes 2' });
    r.tick();
    expect((d.got().find((m) => m.t === 'worker.upsert') as { worker: Record<string, unknown> }).worker).toMatchObject({ name: 'Gumdrop', label: 'notes 2' });
  });

  it('reads caps from the query', () => {
    expect(parseCaps('scratchpad:3:4,pastry:10:12,bad:5:1,x')).toEqual({ scratchpad: { soft: 3, hard: 4 }, pastry: { soft: 10, hard: 12 } });
  });
});
