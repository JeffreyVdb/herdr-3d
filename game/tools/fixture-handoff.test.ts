import { describe, expect, it } from 'vitest';
import { titleOf } from './fixture-handoff.ts';
import { SimWorld } from './fixture-sim.ts';

// #223: the simulator's handoffs follow the bridge's rules: a candidate from `sim.final`, a literal filing with an
// idempotent op, a stale candidate refused, the cabinet's list, search, get and confirmed delete.

const world = {
  buildings: [{ id: 'b1', name: 'HQ', sort: 0, floors: ['f1'] }],
  unassigned: [],
  floors: [{ session: 'f1', state: 'running', building: 'b1', index: 0, desks: 6 }],
  workers: [{ id: 'A', session: 'f1', workspace_id: 'w1', label: 'pixel', name: 'Pixel', status: 'idle', agent_kind: 'claude', harness: 'claude', desk_index: 0, agent_session: 'sess' }],
};

function rig(o = {}) {
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
  return { sim, cmd, ack };
}

describe('fixture handoffs', () => {
  it('titles like the bridge', () => {
    expect(titleOf('Intro\n# Real #', 'Ada', 0)).toBe('Real');
    expect(titleOf('```\n# no\n```\nplain', 'Ada', 0)).toBe('no');
    expect(titleOf('  \n', 'Ada', Date.UTC(2026, 0, 2, 3, 4))).toMatch(/^Ada 2026-01-0\d \d\d:04$/);
  });

  it('files a candidate once, refuses a stale one, lists, searches, gets and deletes', () => {
    const r = rig();
    const c = r.ack('sim.final', { id: 'A', text: '# Loader\n\nThe loader streams.' }).data.candidate as Record<string, string>;
    expect(c.message).toBe('msg_sim1');
    const pv = r.ack('worker.handoff_preview', { worker: 'A', candidate: c.id }).data;
    expect(pv).toMatchObject({ text: '# Loader\n\nThe loader streams.', title: 'Loader', can_send_home: true });
    const args = { worker: 'A', mode: 'literal', session: c.session, candidate: c.id, revision: c.revision, op: 'op-1' };
    const first = r.ack('worker.handoff', args);
    expect(first.events.map((e) => e.t)).toEqual(['handoff.added']);
    const again = r.ack('worker.handoff', args);
    expect(again.data.existing).toBe(true);
    expect(again.events).toEqual([]);
    expect(r.cmd('worker.handoff', { ...args, revision: 'x' }).at(-1)).toMatchObject({ t: 'error', code: 'handoff_unavailable' });
    const hits = r.ack('handoff.list', { floor: 'f1', q: 'strea' }).data.handoffs as Array<{ snippet: string }>;
    expect(hits).toHaveLength(1);
    expect(hits[0]?.snippet).toContain('streams');
    const id = (first.data.handoff as { id: number }).id;
    expect(r.ack('handoff.get', { id }).data.body).toBe('# Loader\n\nThe loader streams.');
    expect(r.cmd('handoff.delete', { id }).at(-1)).toMatchObject({ code: 'confirmation_required' });
    expect(r.ack('handoff.delete', { id, confirm: true }).events.map((e) => e.t)).toEqual(['handoff.removed']);
    r.ack('sim.prompt_turn', { id: 'A' });
    expect(r.cmd('worker.handoff_preview', { worker: 'A', candidate: c.id }).at(-1)).toMatchObject({ code: 'handoff_unavailable' });
  });

  it('has no cabinet with simfail=no_handoff, and seeds one with simhandoffs', () => {
    expect(rig({ fail: 'no_handoff' }).cmd('handoff.list', { floor: 'f1' }).at(-1)).toMatchObject({ code: 'unknown_command' });
    const r = rig({ handoffs: 3 });
    expect((r.ack('handoff.list', { floor: 'f1' }).data.handoffs as unknown[]).length).toBe(3);
  });

  it('#224 asks the agent: one request per op, the composer’s /handoff, filed as agent, a failure, a missing skill', () => {
    const r = rig({ handoffs: 'on' });
    const pv = r.ack('worker.handoff_preview', { worker: 'A', mode: 'agent' }).data;
    expect(pv.agent).toMatchObject({ call: '/handoff', can_ask: true, instruction: 'summarize the conversation' });
    expect((pv.cache as Record<string, unknown>).state).toBe('expired');
    const first = r.ack('worker.handoff', { worker: 'A', mode: 'agent', op: 'op-1', instruction: 'focus' });
    expect(first.data.request).toMatchObject({ op: 'op-1', state: 'pending', instruction: 'focus' });
    expect(r.ack('worker.handoff', { worker: 'A', mode: 'agent', op: 'op-1' }).data.existing).toBe(true);
    const p = r.ack('worker.prompt', { id: 'A', text: '/handoff' }).data;
    expect(p).toMatchObject({ existing: true, handoff: { op: 'op-1' } });
    const filed = r.ack('sim.agent_turn', { id: 'A' });
    expect(filed.events.find((m) => m.t === 'handoff.added')).toMatchObject({ handoff: { source: 'agent' } });
    expect(filed.data.request).toMatchObject({ state: 'filed' });
    r.ack('worker.handoff', { worker: 'A', mode: 'agent', op: 'op-2' });
    expect(r.ack('sim.agent_turn', { id: 'A', fail: 'a person took over' }).data.request).toMatchObject({ state: 'failed', reason: 'a person took over' });
    r.ack('sim.agent_skill', { missing: true });
    const err = r.cmd('worker.handoff', { worker: 'A', mode: 'agent', op: 'op-3' }).find((m) => m.t === 'error');
    expect(err).toMatchObject({ code: 'handoff_skill_missing' });
  });
});
