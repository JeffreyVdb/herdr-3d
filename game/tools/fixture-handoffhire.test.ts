import { describe, expect, it } from 'vitest';
import type { HandoffHire } from '../src/net/protocol';
import { hireWithHandoffTask as gameTask } from '../src/world/handoff';
import { hireWithHandoffTask } from './fixture-handoffhire.ts';
import { SimWorld } from './fixture-sim.ts';

// #219: the simulator's pending handoff hires follow the contract (tools/fixture-handoffhire.ts): checked and held at
// the accept, hired once the handoff is filed, cancelled with the request, failed with the path when the hire is
// refused, never twice.

const world = {
  buildings: [{ id: 'b1', name: 'HQ', sort: 0, floors: ['f1'] }],
  unassigned: [],
  floors: [{ session: 'f1', state: 'running', building: 'b1', index: 0, desks: 6 }],
  workers: [{ id: 'A', session: 'f1', workspace_id: 'w1', label: 'pixel', name: 'Pixel', status: 'idle', agent_kind: 'claude', harness: 'claude', desk_index: 0, agent_session: 'sess' }],
};

function rig(o: Record<string, unknown> = { handoffHires: true }) {
  const sim = new SimWorld({ seq: 1, world: structuredClone(world) }, { stepMs: 1, ...o });
  const out: Record<string, unknown>[] = [];
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
    return { data: a.data as Record<string, unknown>, events: got.filter((m) => m.t !== 'ack') };
  };
  const records = (op: string) => out.filter((m) => m.t === 'handoff_hire.upsert' && (m.handoff_hire as HandoffHire).op === op).map((m) => m.handoff_hire as HandoffHire);
  const last = (op: string) => records(op).at(-1);
  const until = async (ok: () => boolean) => {
    for (let i = 0; i < 200 && !ok(); i++) await new Promise((r) => setTimeout(r, 2));
    expect(ok()).toBe(true);
  };
  return { sim, cmd, ack, out, records, last, until };
}

const hire = (o: Record<string, unknown> = {}) => ({ floor: 'f1', desk_index: 3, harness: 'claude', model: 'claude-opus-5-5', effort: 'high', prompt: 'Fix the issue', origin: 'tab-1', ...o });

describe('fixture handoff hires', () => {
  it('composes the first task exactly as the game does', () => {
    for (const [p, t] of [['/h/a b.md', 'Fix it'], ['/x.md', '\n\n  indented\n\nnext\n  \n'], ['/y.md', '']]) expect(hireWithHandoffTask(p as string, t as string)).toBe(gameTask(p as string, t as string));
  });

  it('has no handoff_hires without simhandoffhires, and refuses `hire` then', () => {
    const r = rig({});
    expect((r.sim.snapshot() as { world: Record<string, unknown> }).world.handoff_hires).toBeUndefined();
    expect(r.cmd('worker.handoff', { worker: 'A', mode: 'agent', op: 'op-1', hire: hire() }).at(-1)).toMatchObject({ t: 'error', code: 'bad_request' });
  });

  it('agent: holds the desk at the accept, hires once when filed with the composed task, never twice', async () => {
    const r = rig();
    expect((r.sim.snapshot() as { world: Record<string, unknown> }).world.handoff_hires).toEqual([]);
    const a = r.ack('worker.handoff', { worker: 'A', mode: 'agent', op: 'op-1', hire: hire() });
    expect(a.data.handoff_hire).toMatchObject({ op: 'op-1', worker: 'A', worker_name: 'Pixel', mode: 'agent', floor: 'f1', desk_index: 3, state: 'waiting', origin: 'tab-1' });
    expect(JSON.stringify(r.out)).not.toContain('Fix the issue');
    // Nobody else hires into the held desk.
    expect(r.cmd('worker.hire', { session: 'f1', desk_index: 3, harness: 'claude', model: 'claude-opus-5-5', effort: 'high' }).at(-1)).toMatchObject({ code: 'desk_taken', message: "Desk 4 is held for Pixel's handoff hire." });
    expect(r.cmd('worker.handoff', { worker: 'A', mode: 'agent', op: 'op-2', hire: hire() }).at(-1)).toMatchObject({ code: 'desk_taken' });
    // A replay: the same args answer the record; other args are refused.
    expect(r.ack('worker.handoff', { worker: 'A', mode: 'agent', op: 'op-1', hire: hire() }).data).toMatchObject({ existing: true, handoff_hire: { op: 'op-1', state: 'waiting' } });
    expect(r.cmd('worker.handoff', { worker: 'A', mode: 'agent', op: 'op-1', hire: hire({ desk_index: 4 }) }).at(-1)).toMatchObject({ code: 'bad_request', message: 'bad args: This request was already sent with other settings.' });
    const filed = r.ack('sim.agent_turn', { id: 'A' });
    const path = (filed.data.handoff as { path: string }).path;
    await r.until(() => r.last('op-1')?.state === 'hired');
    expect(r.records('op-1').map((x) => x.state)).toEqual(['waiting', 'hiring', 'hired']);
    const done = r.last('op-1') as HandoffHire;
    expect(done).toMatchObject({ path, prompted: true });
    const prompts = r.ack('sim.first_prompts', {}).data as unknown as Array<{ id: string; prompt: string }>;
    expect(prompts).toEqual([{ id: done.hired, floor: 'f1', prompt: `First read the handoff here: ${path} and then follow these instructions:\n\nFix the issue` }]);
    const snap = r.sim.snapshot() as { world: { workers: Array<{ id: string; desk_index: number }>; handoff_hires: HandoffHire[] } };
    expect(snap.world.workers.filter((w) => w.desk_index === 3)).toHaveLength(1);
    expect(snap.world.handoff_hires).toEqual([expect.objectContaining({ op: 'op-1', state: 'hired' })]);
  });

  it('cancels the request and its hire together; hire with literal is bad_args', () => {
    const r = rig();
    r.ack('worker.handoff', { worker: 'A', mode: 'agent', op: 'op-1', hire: hire() });
    r.ack('worker.handoff_cancel', { worker: 'A', op: 'op-1' });
    expect(r.last('op-1')).toMatchObject({ state: 'cancelled', code: 'cancelled' });
    expect(r.cmd('sim.agent_turn', { id: 'A' }).at(-1)).toMatchObject({ t: 'error' });
    expect(r.cmd('worker.handoff', { worker: 'A', mode: 'literal', session: 's', candidate: 'c', revision: 'r', op: 'op-3', hire: hire() }).at(-1)).toMatchObject({ code: 'bad_request' });
  });

  it('a failed handoff hires nobody; a hire refused after filing keeps the path; send home only after a hire', async () => {
    const r = rig();
    r.ack('worker.handoff', { worker: 'A', mode: 'agent', op: 'op-1', hire: hire() });
    r.ack('sim.agent_turn', { id: 'A', fail: 'a person took over' });
    expect(r.last('op-1')).toMatchObject({ state: 'failed', code: 'handoff_failed', reason: 'Nobody was hired, the handoff was not filed: a person took over.' });
    r.ack('worker.handoff', { worker: 'A', mode: 'agent', op: 'op-2', send_home: true, hire: hire() });
    r.ack('sim.handoff_hire', {});
    r.ack('sim.agent_turn', { id: 'A' });
    await r.until(() => r.last('op-2')?.state === 'failed');
    expect(r.last('op-2')).toMatchObject({ code: 'desk_taken', send_home_result: 'skipped', send_home_reason: 'The new agent was not hired; Pixel stays.' });
    expect(r.last('op-2')?.path).toMatch(/\.md$/);
    expect((r.sim.snapshot() as { world: { workers: unknown[] } }).world.workers).toHaveLength(1);
  });

  it('checks the hire before the ack: catalog, desk, blank task, too long', () => {
    const r = rig();
    expect(r.cmd('worker.handoff', { worker: 'A', mode: 'agent', op: 'op-1', hire: hire({ model: 'nope' }) }).at(-1)).toMatchObject({ code: 'bad_request' });
    expect(r.cmd('worker.handoff', { worker: 'A', mode: 'agent', op: 'op-1', hire: hire({ desk_index: 0 }) }).at(-1)).toMatchObject({ code: 'desk_taken' });
    expect(r.cmd('worker.handoff', { worker: 'A', mode: 'agent', op: 'op-1', hire: hire({ prompt: '  ' }) }).at(-1)).toMatchObject({ code: 'bad_request' });
    expect(r.cmd('worker.handoff', { worker: 'A', mode: 'agent', op: 'op-1', hire: hire({ prompt: 'x'.repeat(32 * 1024 - 900) }) }).at(-1)).toMatchObject({ code: 'bad_request' });
    expect(r.out.some((m) => m.t === 'handoff_hire.upsert')).toBe(false);
  });

  it('llm: hires once the job files', async () => {
    const r = rig({ handoffHires: true, handoffLlm: 'ready', handoffLlmOut: 'slow' });
    const c = r.ack('sim.final', { id: 'A', text: 'Done.' }).data.candidate as Record<string, string>;
    const a = r.ack('worker.handoff', { worker: 'A', mode: 'llm', session: c.session, candidate: c.id, revision: c.revision, op: 'op-1', hire: hire() });
    expect(a.data.handoff_hire).toMatchObject({ mode: 'llm', state: 'waiting' });
    r.ack('sim.llm_finish', { id: 'A' });
    await r.until(() => r.last('op-1')?.state === 'hired');
  });
  it('B-R5: a terminal record leaves 10 minutes after it ended with handoff_hire.removed, in an idle world; a snapshot never drops one silently', () => {
    let t = 1_000;
    const r = rig({ handoffHires: true, manualClock: true, now: () => t });
    const heard: Record<string, unknown>[] = [];
    r.sim.start((m) => heard.push(m));
    r.ack('worker.handoff', { worker: 'A', mode: 'agent', op: 'op-1', hire: hire() });
    r.ack('worker.handoff_cancel', { worker: 'A', op: 'op-1' });
    expect(r.last('op-1')).toMatchObject({ state: 'cancelled' });
    const listed = () => (r.sim.snapshot() as { world: { handoff_hires: HandoffHire[] } }).world.handoff_hires.map((x) => x.op);
    // The clock is past the 10 minutes, the timer not yet: a snapshot still lists it (no removal without its event).
    t += 11 * 60_000;
    for (let i = 0; i < 9; i++) r.ack('sim.advance', { ms: 60_000 });
    expect(listed()).toEqual(['op-1']);
    expect([...r.out, ...heard].some((m) => m.t === 'handoff_hire.removed')).toBe(false);
    r.ack('sim.advance', { ms: 60_000 });
    expect(heard.filter((m) => m.t === 'handoff_hire.removed')).toEqual([expect.objectContaining({ t: 'handoff_hire.removed', op: 'op-1' })]);
    expect(listed()).toEqual([]);
  });

  it('B-R5: beyond the newest 50 terminal records, the oldest leaves with handoff_hire.removed', () => {
    let t = 1_000;
    const r = rig({ handoffHires: true, now: () => ++t });
    for (let i = 1; i <= 51; i++) {
      r.ack('worker.handoff', { worker: 'A', mode: 'agent', op: `op-${i}`, hire: hire() });
      r.ack('worker.handoff_cancel', { worker: 'A', op: `op-${i}` });
    }
    expect(r.out.filter((m) => m.t === 'handoff_hire.removed').map((m) => m.op)).toEqual(['op-1']);
    const snap = (r.sim.snapshot() as { world: { handoff_hires: HandoffHire[] } }).world.handoff_hires;
    expect(snap).toHaveLength(50);
    expect(snap.some((x) => x.op === 'op-1')).toBe(false);
  });
  it('A r2: a replay after the record left is compared on what is kept (no handoff_hire then); every end without a hire skips the send home', () => {
    let t = 1_000;
    const r = rig({ handoffHires: true, manualClock: true, now: () => t });
    r.sim.start(() => undefined);
    r.ack('worker.handoff', { worker: 'A', mode: 'agent', op: 'op-1', send_home: true, hire: hire() });
    r.ack('worker.handoff_cancel', { worker: 'A', op: 'op-1' });
    expect(r.last('op-1')).toMatchObject({ state: 'cancelled', send_home_result: 'skipped', send_home_reason: 'The new agent was not hired; Pixel stays.' });
    t += 11 * 60_000;
    for (let i = 0; i < 10; i++) r.ack('sim.advance', { ms: 60_000 });
    const again = r.ack('worker.handoff', { worker: 'A', mode: 'agent', op: 'op-1', send_home: true, hire: hire() }).data;
    expect(again).toMatchObject({ existing: true });
    expect(again).not.toHaveProperty('handoff_hire');
    expect(r.cmd('worker.handoff', { worker: 'A', mode: 'agent', op: 'op-1', send_home: true, hire: hire({ desk_index: 4 }) }).at(-1)).toMatchObject({ code: 'bad_request', message: 'bad args: This request was already sent with other settings.' });
  });
});
