import { describe, expect, it } from 'vitest';
import type { Snapshot, Worker } from '../src/net/protocol';
import { crewView } from '../src/world/crew';
import { WorldStore } from '../src/world/store';
import { nearestDesk } from './fixture-crew';
import { loadFixture } from './fixture-server';
import { SimWorld } from './fixture-sim';

type Msg = Record<string, unknown>;

function rig(crewMs?: number) {
  let now = 1_000;
  let id = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const { snapshot } = loadFixture('demo-m6');
  const sim = new SimWorld(snapshot as never, {
    stepMs: 100,
    usageMs: 0,
    ...(crewMs !== undefined ? { crewMs } : {}),
    now: () => now,
    setTimeout: (fn, ms) => {
      timers.set(++id, { at: now + ms, fn });
      return id;
    },
    clearTimeout: (h) => timers.delete(h as number),
  });
  const out: Msg[] = [];
  let n = 0;
  const cmd = (t: string, args: unknown) => {
    const req_id = `r${++n}`;
    const from = out.length;
    sim.handle({ t, req_id, args }, (m) => out.push(m));
    return { got: () => out.slice(from), reply: () => out.find((m) => m.req_id === req_id) as Msg | undefined };
  };
  const advance = (ms: number) => {
    const end = now + ms;
    for (;;) {
      const due = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!due) break;
      timers.delete(due[0]);
      now = Math.max(now, due[1].at);
      due[1].fn();
    }
    now = end;
  };
  return { sim, out, cmd, advance };
}

const lab = (loadFixture('demo-m6').snapshot as unknown as Snapshot).world.workers.filter((w) => w.session === 'lab');
const byLabel = (l: string) => lab.find((w) => w.label === l) as Worker;

describe('demo-m6: the lab floor from the fixture run dirs', () => {
  it('the over-cap run: ORCH pass 3 waiting for you, REVIEW r3 changes with 2 blockers, all in the first pod', () => {
    const orch = byLabel('ORCH|overcap');
    expect(orch).toMatchObject({ role: 'orch', run: '20260928-1400-overcap', phase: 'waiting_user', pass: 3, over_cap: true, issue: { repo: 'JeffreyVdb/lab', number: 3 } });
    const review = byLabel('REVIEW|overcap|3|r3');
    expect(review).toMatchObject({ role: 'review', round: 3, ticket: '3', orch_id: orch.id, harness: 'codex', model: 'gpt-6-sol', report: { state: 'ready', verdict: 'CHANGES_REQUIRED', blockers: 2, issues: 5 } });
    const crew = lab.filter((w) => w.run === '20260928-1400-overcap');
    expect(crew).toHaveLength(4);
    for (const w of crew) expect(Math.floor((w.desk_index as number) / 4)).toBe(Math.floor((orch.desk_index as number) / 4));
    // Coders on Opus, reviewers on Sol.
    expect(byLabel('CODE|overcap|3|r3')).toMatchObject({ harness: 'claude', model: 'claude-opus-5-5' });
    // The summary is cut to 300 bytes, like the bridge's.
    expect(Buffer.byteLength(byLabel('CODE|overcap|3|r3').report?.summary ?? '')).toBeLessThanOrEqual(300);
  });

  it('has every lifecycle state and each verdict', () => {
    const s = new WorldStore(0);
    s.applySnapshot(loadFixture('demo-m6').snapshot as unknown as Snapshot);
    const states = new Set(lab.map((w) => s.workerView(w.id)?.crew?.life).filter(Boolean));
    expect([...states].sort()).toEqual(['blocked', 'hired', 'onboarding', 'reporting', 'working']);
    const verdicts = new Set(lab.map((w) => w.report?.verdict).filter(Boolean));
    expect([...verdicts].sort()).toEqual(['CHANGES_REQUIRED', 'INCOMPLETE', 'PASS']);
    expect(lab.some((w) => w.report?.input_required)).toBe(true);
    expect(crewView(byLabel('UX|lobby|4|r1'), true)?.ask).toBe('Which port should the demo use? 5173 is taken by another worktree.');
  });
});

describe('sim.crew: the scripted freelancer', () => {
  it('nearestDesk: same pod first, then pod distance, then the lower index; a new desk when full', () => {
    expect(nearestDesk(4, new Set([4, 5]), 12)).toBe(6);
    expect(nearestDesk(4, new Set([4, 5, 6, 7]), 12)).toBe(0);
    expect(nearestDesk(4, new Set([0, 1, 2, 3, 4, 5, 6, 7]), 12)).toBe(8);
    expect(nearestDesk(0, new Set([0, 1, 2]), 3)).toBe(3);
  });

  it('walks one through hire → onboard → work → report → leave', () => {
    const { cmd, sim } = rig();
    const hire = cmd('sim.crew', { step: 'hire' });
    const ack = hire.reply()?.data as { id: string; step: string };
    expect(ack.step).toBe('hire');
    // The lab floor is full (13 of 14 desks): the free desk 13 is the one left.
    const up = hire.got().find((m) => m.t === 'worker.upsert') as { worker: Worker };
    const orch = byLabel('ORCH|overcap');
    expect(up.worker).toMatchObject({ id: ack.id, session: 'lab', role: 'code', run: orch.run, orch_id: orch.id, status: 'unknown', desk_index: 13, report: { state: 'pending' }, issue: orch.issue });
    expect(up.worker.agent_kind).toBeUndefined();
    const onboard = cmd('sim.crew', { step: 'onboard' }).got().find((m) => m.t === 'worker.upsert') as { worker: Worker };
    expect(onboard.worker).toMatchObject({ agent_kind: 'claude', status: 'idle' });
    expect(cmd('sim.crew', { step: 'work' }).got().find((m) => m.t === 'worker.status')).toMatchObject({ id: ack.id, status: 'working' });
    const rep = cmd('sim.crew', { step: 'report', verdict: 'PASS' }).got().find((m) => m.t === 'worker.upsert') as { worker: Worker };
    expect(rep.worker.report).toMatchObject({ state: 'ready', verdict: 'PASS', blockers: 0 });
    const leave = cmd('sim.crew', { step: 'leave' });
    expect(leave.got().find((m) => m.t === 'worker.removed')).toMatchObject({ id: ack.id, session: 'lab' });
    expect((sim.snapshot() as { world: { workers: Worker[] } }).world.workers.some((w) => w.id === ack.id)).toBe(false);
    // Nobody left to step.
    expect(cmd('sim.crew', { step: 'work' }).reply()).toMatchObject({ t: 'error', code: 'unknown_worker' });
    expect(cmd('sim.crew', { step: 'dance' }).reply()).toMatchObject({ t: 'error', code: 'bad_request' });
  });

  it('#215: a report request keeps its whole text and recipient, and resolve accepts it without resuming the worker', () => {
    const { cmd } = rig();
    cmd('sim.crew', { step: 'hire' });
    cmd('sim.crew', { step: 'onboard' });
    // Nothing asks yet.
    expect(cmd('sim.crew', { step: 'resolve' }).reply()).toMatchObject({ t: 'error', code: 'bad_request' });
    const text = `${'x'.repeat(600)} Or accept the existing evidence: ORCHESTRATOR ACCEPTANCE.`;
    const rep = cmd('sim.crew', { step: 'report', input_required: text, input_for: 'orchestrator', input_truncated: true }).got().find((m) => m.t === 'worker.upsert') as { worker: Worker };
    expect(rep.worker).toMatchObject({ status: 'done', report: { state: 'ready', input_required: text, input_for: 'orchestrator', input_truncated: true } });
    expect(rep.worker.report?.input_resolved).toBeUndefined();
    const res = cmd('sim.crew', { step: 'resolve', note: 'accepted as AC4 evidence' }).got().find((m) => m.t === 'worker.upsert') as { worker: Worker };
    expect(res.worker).toMatchObject({ status: 'done', report: { input_required: text, input_resolved: { by: 'orchestrator', note: 'accepted as AC4 evidence' } } });
    // The auto script never resolves by itself; an unknown recipient is dropped.
    const again = cmd('sim.crew', { step: 'report', input_required: 'x', input_for: 'bob' }).got().find((m) => m.t === 'worker.upsert') as { worker: Worker };
    expect(again.worker.report?.input_for).toBeUndefined();
    expect(again.worker.report?.input_resolved).toBeUndefined();
  });

  it('a second hire grows the floor by a desk', () => {
    const { cmd } = rig();
    cmd('sim.crew', { step: 'hire' });
    const second = cmd('sim.crew', { step: 'hire' }).got();
    expect(second.find((m) => m.t === 'floor.upsert')).toMatchObject({ floor: { session: 'lab', desks: 15 } });
    expect((second.find((m) => m.t === 'worker.upsert') as { worker: Worker }).worker.desk_index).toBe(14);
  });

  it('M6c: `corner: true` hires for the simulator’s orchestrator in the corner office (made once, working, flagged)', () => {
    const { cmd, sim } = rig();
    const first = cmd('sim.crew', { step: 'hire', corner: true });
    const made = first.got().filter((m) => m.t === 'worker.upsert').map((m) => (m as { worker: Worker }).worker);
    const corner = made.find((w) => w.role === 'orch')!;
    expect(corner).toMatchObject({ corner: true, status: 'working', run: 'sim-corner', phase: 'review', session: 'lab' });
    const hired = made.find((w) => w.role === 'code')!;
    expect(hired.orch_id).toBe(corner.id);
    expect(hired.desk_index).not.toBe(corner.desk_index);
    // The same orchestrator for the next one; the other runs are untouched.
    const second = cmd('sim.crew', { step: 'hire', corner: true }).got();
    expect(second.some((m) => m.t === 'worker.upsert' && (m as { worker: Worker }).worker.role === 'orch')).toBe(false);
    expect(((sim.snapshot() as { world: { workers: Worker[] } }).world.workers).filter((w) => w.corner === true)).toHaveLength(1);
    expect(byLabel('ORCH|overcap').corner).toBeUndefined();
    // Without it, the first orchestrator with a run, as ever.
    const plain = cmd('sim.crew', { step: 'hire' }).got().find((m) => m.t === 'worker.upsert') as { worker: Worker };
    expect(plain.worker.orch_id).toBe(byLabel('ORCH|overcap').id);
  });

  it('simcrew=<ms> plays the script by itself, every other round for the corner office', () => {
    const { sim, out, advance } = rig(100);
    sim.start((m) => out.push(m));
    advance(1200);
    const hires = out.filter((m) => m.t === 'worker.upsert' && (m as { worker: Worker }).worker.role === 'code' && (m as { worker: Worker }).worker.status === 'unknown').map((m) => (m as { worker: Worker }).worker);
    expect(hires.length).toBeGreaterThanOrEqual(2);
    expect(hires[0]!.orch_id).toBe(byLabel('ORCH|overcap').id);
    expect(hires[1]!.orch_id).not.toBe(byLabel('ORCH|overcap').id);
    expect(out.some((m) => m.t === 'worker.upsert' && (m as { worker: Worker }).worker.corner === true)).toBe(true);
  });

  it('simcrew=<ms> plays the script by itself', () => {
    const { sim, out, advance } = rig(500);
    const send = (m: Msg) => out.push(m);
    sim.start(send);
    advance(2600);
    const types = out.map((m) => m.t);
    expect(types).toContain('worker.upsert');
    expect(types).toContain('worker.status');
    expect(types).toContain('worker.removed');
  });
});
