import { describe, expect, it } from 'vitest';
import type { Schedule } from '../src/net/protocol.ts';
import { SimWorld, type SimOptions } from './fixture-sim.ts';

// #64 schedules: the simulator's scheduled agents follow #62's rules: the spec's checks, the state rules and their
// errors, the events, the fire (a hire through the simulator's own worker.hire), `sim.schedule_fire`'s outcomes and the
// `simschedules` seed.

const T = Date.UTC(2026, 9, 17, 7, 0);
const world = {
  buildings: [{ id: 'b1', name: 'HQ', sort: 0, floors: ['f1', 'f2'] }],
  unassigned: [],
  floors: [
    { session: 'f1', state: 'running', building: 'b1', index: 0, desks: 2 },
    { session: 'f2', state: 'asleep', building: 'b1', index: 1, desks: 2 },
  ],
  workers: [{ id: 'A', session: 'f1', workspace_id: 'w1', label: 'pixel', name: 'Pixel', status: 'idle', agent_kind: 'claude', harness: 'claude', desk_index: 0 }],
};

function rig(o: SimOptions = {}) {
  const sim = new SimWorld({ seq: 1, world: structuredClone(world) }, { stepMs: 1, now: () => T, manualClock: true, ...o });
  const out: Record<string, unknown>[] = [];
  sim.start((m) => out.push(m), { usageMs: 0 });
  let n = 0;
  const cmd = (t: string, args: Record<string, unknown>) => {
    const from = out.length;
    sim.handle({ t, req_id: `r${++n}`, args }, (m) => out.push(m));
    return out.slice(from);
  };
  const ack = (t: string, args: Record<string, unknown>) => {
    const got = cmd(t, args);
    const a = got.find((m) => m.t === 'ack' || m.t === 'error') as Record<string, unknown>;
    if (a.t !== 'ack') throw new Error(JSON.stringify(a));
    return { data: a.data as Schedule, events: got.filter((m) => m.t !== 'ack') };
  };
  const err = (t: string, args: Record<string, unknown>) => cmd(t, args).find((m) => m.t === 'error') as { code: string; message: string } | undefined;
  const advance = (ms: number) => sim.handle({ t: 'sim.advance', req_id: `r${++n}`, args: { ms } }, (m) => out.push(m));
  const view = () => (sim.snapshot().world as { schedules?: Schedule[] }).schedules;
  return { sim, cmd, ack, err, advance, view, out };
}

const SPEC = { floor: 'f1', title: 'After the soak', prompt: 'Delete the backups.', due_at: T + 3_600_000, harness: 'claude', model: 'claude-opus-5-5', effort: 'high', cwd: '/home/dev/herdr-3d' };

describe('fixture schedules', () => {
  it('the snapshot has the view; simfail=no_schedules plays a bridge before #62', () => {
    expect(rig().view()).toEqual([]);
    const old = rig({ fail: 'no_schedules' });
    expect(old.view()).toBeUndefined();
    expect(old.err('schedule.create', SPEC)?.code).toBe('unknown_command');
  });

  it('creates with the bridge’s defaults and checks the spec like it', () => {
    const r = rig();
    const c = r.ack('schedule.create', SPEC);
    expect(c.data).toMatchObject({ floor: 'f1', state: 'scheduled', on_miss: 'run_late', wake_floor: true, worktree: false, source: { kind: 'manual' }, created_at: T });
    expect(c.data.id).toMatch(/^sch_[0-9a-f]{16}$/);
    expect(c.events.map((e) => e.t)).toEqual(['schedule.upsert']);
    expect(r.view()?.map((s) => s.id)).toEqual([c.data.id]);
    const bad: Array<[Record<string, unknown>, RegExp]> = [
      [{ floor: 'nope' }, /unknown floor/],
      [{ title: ' ' }, /title/],
      [{ title: 'x'.repeat(201) }, /title/],
      [{ due_at: T }, /due_at must be in the future/],
      [{ on_miss: 'later' }, /on_miss/],
      [{ on_miss: 'skip', max_lateness_ms: 5 }, /run_late only/],
      [{ max_lateness_ms: 0 }, /positive/],
      [{ model: 'gpt' }, /no model/],
      [{ prompt: '' }, /prompt is required without a handoff_path/],
      [{ prompt: '--x' }, /not starting with/],
      [{ cwd: 'rel' }, /absolute/],
      [{ cwd: '/home/dev/gone/x' }, /no such file/],
      [{ handoff_path: 'rel.md' }, /handoff_path/],
      [{ source: { kind: 'robot' } }, /source/],
    ];
    for (const [o, re] of bad) {
      const e = r.err('schedule.create', { ...SPEC, ...o });
      expect(e?.code, JSON.stringify(o)).toBe('bad_request');
      expect(e?.message).toMatch(re);
    }
    expect(r.ack('schedule.create', { ...SPEC, prompt: '', handoff_path: '/h/a.md', source: { kind: 'transcript', worker: 'A', message: 'msg_1' } }).data).toMatchObject({ prompt: '', handoff_path: '/h/a.md', source: { kind: 'transcript', worker: 'A', message: 'msg_1' } });
  });

  it('update replaces the whole spec while scheduled; floor and source cannot change', () => {
    const r = rig();
    const id = r.ack('schedule.create', { ...SPEC, max_lateness_ms: 60_000, worktree: true }).data.id;
    const u = r.ack('schedule.update', { id, ...SPEC, title: 'Renamed', wake_floor: false });
    expect(u.data).toMatchObject({ title: 'Renamed', wake_floor: false, worktree: false });
    expect(u.data.max_lateness_ms).toBeUndefined();
    expect(u.events.map((e) => e.t)).toEqual(['schedule.upsert']);
    expect(r.err('schedule.update', { id, ...SPEC, floor: 'f2' })?.message).toMatch(/floor cannot change/);
    expect(r.err('schedule.update', { id, ...SPEC, source: { kind: 'manual' } })?.message).toMatch(/source cannot change/);
    expect(r.ack('schedule.update', { id, ...SPEC, floor: '' }).data.floor).toBe('f1');
  });

  it('the state rules: invalid_state and not_found, cancel and dismiss leave the view', () => {
    const r = rig();
    const id = r.ack('schedule.create', SPEC).data.id;
    expect(r.err('schedule.retry', { id })).toMatchObject({ code: 'invalid_state', message: expect.stringMatching(/is scheduled; schedule.retry needs it failed or skipped/) });
    expect(r.err('schedule.dismiss', { id })?.code).toBe('invalid_state');
    expect(r.err('schedule.cancel', { id: 'sch_nope' })?.code).toBe('not_found');
    const c = r.ack('schedule.cancel', { id });
    expect(c.data.state).toBe('cancelled');
    expect(c.events).toEqual([expect.objectContaining({ t: 'schedule.removed', id, floor_id: 'f1' })]);
    expect(r.view()).toEqual([]);
    expect(r.err('schedule.cancel', { id })?.message).toMatch(/is cancelled/);
    const f = r.ack('schedule.create', SPEC).data.id;
    r.ack('sim.schedule_fire', { id: f, fail: 'boom' });
    expect(r.err('schedule.run_now', { id: f })?.code).toBe('invalid_state');
    expect(r.err('schedule.update', { id: f, ...SPEC })?.code).toBe('invalid_state');
    const d = r.ack('schedule.dismiss', { id: f });
    expect(d.data.dismissed_at).toBe(T);
    expect(d.events.map((e) => e.t)).toEqual(['schedule.removed']);
    expect(r.err('schedule.retry', { id: f })?.message).toMatch(/is dismissed/);
  });

  it('run now hires at the first free desk: running, then done with the worker', () => {
    const r = rig();
    const id = r.ack('schedule.create', SPEC).data.id;
    const go = r.ack('schedule.run_now', { id });
    expect(go.data).toMatchObject({ state: 'running', fired_at: T });
    r.advance(10);
    const done = r.view()?.find((s) => s.id === id);
    expect(done?.state).toBe('done');
    const w = r.out.find((m) => m.t === 'worker.upsert' && (m.worker as { id: string }).id === done?.worker_id) as { worker: { desk_index: number; floor: string } } | undefined;
    expect(w?.worker).toMatchObject({ desk_index: 1, floor: 'f1' });
  });

  it('one due beyond a timer’s reach (~24.8 days) waits for its time, not the timer’s', () => {
    let now = T;
    const timers: Array<{ fn: () => void; ms: number }> = [];
    const r = rig({ manualClock: false, now: () => now, setTimeout: (fn, ms) => timers.push({ fn, ms }), clearTimeout: () => {} });
    const due = T + 30 * 86_400_000;
    const id = r.ack('schedule.create', { ...SPEC, due_at: due }).data.id;
    const capped = timers.find((t) => t.ms === 2 ** 31 - 1)!;
    now += capped.ms;
    capped.fn();
    expect(r.view()?.find((s) => s.id === id)?.state).toBe('scheduled');
    const rest = timers.find((t) => t.ms === due - now)!;
    expect(rest).toBeTruthy();
    now = due;
    rest.fn();
    expect(r.view()?.find((s) => s.id === id)).toMatchObject({ state: 'running', fired_at: due });
  });

  it('fires by itself at its due time; an asleep floor waits or fails', () => {
    const r = rig();
    const id = r.ack('schedule.create', { ...SPEC, due_at: T + 30_000 }).data.id;
    r.advance(29_999);
    expect(r.view()?.find((s) => s.id === id)?.state).toBe('scheduled');
    r.advance(1);
    r.advance(10);
    expect(r.view()?.find((s) => s.id === id)?.state).toBe('done');
    // The hire grew f1 a desk, as any hire does: the next one has room.
    const more = r.ack('schedule.create', SPEC).data.id;
    expect(r.ack('schedule.run_now', { id: more }).data).toMatchObject({ state: 'running' });
    expect(r.ack('schedule.create', { ...SPEC, floor: 'f2' }).data.id).toBeTruthy();
    const asleep = r.view()!.find((s) => s.floor === 'f2')!.id;
    expect(r.ack('schedule.run_now', { id: asleep }).data).toMatchObject({ state: 'waiting', state_reason: 'waking floor f2' });
    const off = r.ack('schedule.create', { ...SPEC, floor: 'f2', wake_floor: false }).data.id;
    expect(r.ack('schedule.run_now', { id: off }).data).toMatchObject({ state: 'failed', state_reason: 'floor asleep: wake_floor is off' });
    // A waiting one can be cancelled, not run again.
    expect(r.err('schedule.run_now', { id: asleep })?.code).toBe('invalid_state');
    expect(r.ack('schedule.cancel', { id: asleep }).data.state).toBe('cancelled');
  });

  it('sim.schedule_fire plays late, failed and skipped; retry fires a failed one again', () => {
    const r = rig();
    const id = r.ack('schedule.create', SPEC).data.id;
    r.ack('sim.schedule_fire', { id, late_ms: 3 * 3_600_000 });
    r.advance(10);
    const late = r.view()?.find((s) => s.id === id);
    expect(late).toMatchObject({ state: 'done', fired_at: SPEC.due_at + 3 * 3_600_000 });
    const f = r.ack('schedule.create', SPEC).data.id;
    expect(r.ack('sim.schedule_fire', { id: f, fail: true }).data).toMatchObject({ state: 'failed', state_reason: expect.stringMatching(/simulated/) });
    const s = r.ack('schedule.create', SPEC).data.id;
    expect(r.ack('sim.schedule_fire', { id: s, skip: true }).data).toMatchObject({ state: 'skipped', state_reason: expect.stringMatching(/^missed: bridge was offline at/) });
    expect(r.ack('schedule.retry', { id: f }).data).toMatchObject({ state: 'running', fired_at: T });
  });

  it('sim.schedule_fail answers the next create, update or retry with that error', () => {
    const r = rig();
    r.ack('sim.schedule_fail', { code: 'busy' });
    expect(r.err('schedule.create', SPEC)).toMatchObject({ code: 'busy', message: expect.stringMatching(/^busy: cwd is in the worktree being removed/) });
    expect(r.ack('schedule.create', SPEC).data.state).toBe('scheduled');
  });

  it('simschedules seeds every state across two floors', () => {
    const r = rig({ schedules: 8 });
    const v = r.view()!;
    expect(v.map((s) => s.state).sort()).toEqual(['done', 'done', 'failed', 'running', 'scheduled', 'scheduled', 'skipped', 'waiting']);
    expect(new Set(v.map((s) => s.floor))).toEqual(new Set(['f1', 'f2']));
    expect(v.find((s) => s.title === 'Re-run the flaky e2e')?.worker_id).toBe('A'); // at a desk of f1
    expect(v.find((s) => s.title === 'Morning triage')).toMatchObject({ worker_id: 'gone-worker-0001', fired_at: T - 6 * 3_600_000 });
    expect(rig({ schedules: 10 }).view()!.filter((s) => / 2$/.test(s.title))).toHaveLength(2);
  });
});
