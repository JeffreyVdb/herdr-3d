import { describe, expect, it } from 'vitest';
import type { CommandResult } from '../net/client';
import type { AgentHandoff, HandoffCandidate, HandoffEntry, LLMHandoff, Worker } from '../net/protocol';
import { HandoffFiling, type HandoffPlan } from './handoffFiling';
import type { PromptSecretsFlow } from './secretsFlow';

// #198: one handoff filed for "Hire with handoff": the request once, followed by its op only, the final path read back.

const CAND: HandoffCandidate = { id: 'cand-1', session: 'sess', revision: 'rev-1', harness: 'claude', message: 'msg_1', source: 'message', bytes: 300 };
const ENTRY: HandoffEntry = { id: 7, floor: 'herdr-3d', worker_id: 'A', worker_name: 'Pixel', path: '/home/u/handoff/herdr-3d/20261025-0800-pixel-loader.md', title: 'Loader', created_at: 0, source: 'agent', bytes: 300 };
const PLAN: HandoffPlan = { worker: 'A', name: 'Pixel', floorName: 'herdr-3d', mode: 'agent', candidate: CAND, instruction: 'focus on the tests', sendHome: false };

const flush = async () => {
  for (let n = 0; n < 20; n++) await Promise.resolve();
};

function setup(plan: Partial<HandoffPlan> = {}) {
  const sent: Array<{ t: string; args: Record<string, unknown> }> = [];
  const answers: Array<(r: CommandResult) => void> = [];
  const w: Worker = { id: 'A', session: 'herdr-3d', workspace_id: 'w1', label: 'x', status: 'idle' } as Worker;
  let worker: Worker | undefined = w;
  const host = {
    send: (t: string, args: Record<string, unknown>) => {
      sent.push({ t, args });
      return new Promise<CommandResult>((r) => answers.push(r));
    },
    worker: () => worker,
  };
  let alive = true;
  const f = new HandoffFiling(host as never, { ...PLAN, ...plan }, 'ho-op1', () => alive);
  let outcome: unknown = null;
  void f.run().then((o) => (outcome = o));
  return {
    f,
    sent,
    answer: async (r: CommandResult) => {
      answers.shift()!(r);
      await flush();
    },
    set: (a: Partial<Worker> | undefined) => {
      worker = a ? { ...w, ...a } : undefined;
      f.feed();
    },
    outcome: () => outcome,
    kill: () => (alive = false),
  };
}

const req = (over: Partial<AgentHandoff> = {}): AgentHandoff => ({ op: 'ho-op1', state: 'pending', started_at: 0, ...over });
const job = (over: Partial<LLMHandoff> = {}): LLMHandoff => ({ op: 'ho-op1', state: 'running', started_at: 0, updated_at: 0, ...over });

describe('HandoffFiling', () => {
  it('literal: files step 1’s candidate with the op and gives the filed entry (send home only when ticked)', async () => {
    const e = setup({ mode: 'literal', instruction: '' });
    expect(e.sent).toEqual([{ t: 'worker.handoff', args: { worker: 'A', mode: 'literal', session: 'sess', candidate: 'cand-1', revision: 'rev-1', op: 'ho-op1' } }]);
    expect(e.f.progress()).toBe('Saving Pixel’s last message…');
    await e.answer({ ok: true, data: { handoff: { ...ENTRY, source: 'literal' } } });
    expect(e.outcome()).toEqual({ kind: 'filed', entry: { ...ENTRY, source: 'literal' } });
  });

  it('literal: a reply no longer the latest is refused as stale; nothing is filed and the next try needs a new op', async () => {
    const e = setup({ mode: 'literal', sendHome: true });
    expect(e.sent[0]!.args.send_home).toBe(true);
    await e.answer({ ok: false, code: 'handoff_unavailable', message: 'the candidate is not current' });
    expect(e.outcome()).toMatchObject({ kind: 'failed', retry: false, stale: true, message: expect.stringContaining('Nobody was hired') });
  });

  it('an unanswered request may have gone: the same op is sent again on the next try', async () => {
    const e = setup({ mode: 'literal' });
    await e.answer({ ok: false, code: 'timeout', message: '' });
    expect(e.outcome()).toMatchObject({ kind: 'failed', retry: true, message: expect.stringContaining('it is filed once') });
  });

  it('agent: the instruction (never a task) goes with the op; filed only once its op says so, then the path is read back', async () => {
    const e = setup();
    expect(e.sent[0]).toEqual({ t: 'worker.handoff', args: { worker: 'A', mode: 'agent', op: 'ho-op1', instruction: 'focus on the tests' } });
    await e.answer({ ok: true, data: { request: req() } });
    expect(e.f.phase).toBe('waiting');
    // Delayed generation: other ops, a pending update and a filed request of another op do nothing.
    e.set({ agent_handoff: req({ op: 'ho-other', state: 'filed', handoff: 99 }) });
    e.set({ agent_handoff: req({ state: 'filing' }) });
    await flush();
    expect(e.outcome()).toBeNull();
    e.set({ agent_handoff: req({ state: 'filing' }) });
    await flush();
    expect(e.outcome()).toBeNull();
    expect(e.sent.filter((s) => s.t === 'handoff.get')).toHaveLength(0);
    e.set({ agent_handoff: req({ state: 'filed', handoff: 7 }) });
    // Repeated completion events read it once.
    e.set({ agent_handoff: req({ state: 'filed', handoff: 7 }) });
    await flush();
    expect(e.sent.filter((s) => s.t === 'handoff.get')).toEqual([{ t: 'handoff.get', args: { id: 7 } }]);
    expect(e.f.progress()).toBe('Filed. Reading its path…');
    await e.answer({ ok: true, data: { handoff: ENTRY, body: '# x' } });
    expect(e.outcome()).toEqual({ kind: 'filed', entry: ENTRY });
    e.set({ agent_handoff: req({ state: 'filed', handoff: 7 }) });
    await flush();
    expect(e.sent.filter((s) => s.t === 'handoff.get')).toHaveLength(1);
  });

  it('agent: an ack that is already filed reads it at once; a failed one says why', async () => {
    const a = setup();
    await a.answer({ ok: true, data: { request: req({ state: 'filed', handoff: 7 }) } });
    expect(a.sent.at(-1)).toEqual({ t: 'handoff.get', args: { id: 7 } });
    const b = setup();
    await b.answer({ ok: true, data: { request: req({ state: 'failed', reason: 'the turn ended without the handoff at /home/u/handoff/.pending/herdr-3d/ho-op1.md' }) } });
    expect(b.outcome()).toMatchObject({ kind: 'failed', retry: false, message: expect.stringContaining('was not filed') });
  });

  it('agent: another request of the worker answers instead of ours: nothing is followed', async () => {
    const e = setup();
    await e.answer({ ok: true, data: { request: req({ op: 'ho-composer' }), existing: true } });
    expect(e.outcome()).toMatchObject({ kind: 'failed', message: expect.stringContaining('already writing another handoff') });
  });

  it('a missing skill or a busy worker is refused with the bridge’s reason', async () => {
    const e = setup();
    await e.answer({ ok: false, code: 'invalid_state', message: 'Pixel lists no "handoff" skill' });
    expect(e.outcome()).toMatchObject({ kind: 'failed', retry: false, message: expect.stringContaining('no "handoff" skill') });
  });

  it('LLM: the candidate and instruction go with the op; a failed or timed-out job hires nobody', async () => {
    const e = setup({ mode: 'llm', llmModel: 'gpt-x' });
    expect(e.sent[0]!.args).toEqual({ worker: 'A', mode: 'llm', session: 'sess', candidate: 'cand-1', revision: 'rev-1', op: 'ho-op1', instruction: 'focus on the tests' });
    expect(e.f.progress()).toBe('The LLM (gpt-x) is writing the handoff…');
    await e.answer({ ok: true, data: { job: job() } });
    e.set({ llm_handoff: job({ state: 'failed', code: 'timeout', message: 'The LLM did not answer within 90 seconds; nothing was filed.' }) });
    await flush();
    expect(e.outcome()).toMatchObject({ kind: 'failed', retry: false, message: expect.stringContaining('within 90 seconds') });
  });

  it('LLM: filed through its job, never through the next handoff that appears', async () => {
    const e = setup({ mode: 'llm' });
    await e.answer({ ok: true, data: { job: job({ state: 'queued' }) } });
    e.set({ llm_handoff: job({ state: 'filed', handoff: 7 }) });
    await flush();
    await e.answer({ ok: true, data: { handoff: { ...ENTRY, source: 'llm' }, body: '' } });
    expect(e.outcome()).toMatchObject({ kind: 'filed', entry: { path: ENTRY.path } });
  });

  it('cancel stops the request on the bridge and hires nobody; a later filed update changes nothing', async () => {
    const e = setup();
    await e.answer({ ok: true, data: { request: req() } });
    const c = e.f.cancel();
    expect(e.sent.at(-1)).toEqual({ t: 'worker.handoff_cancel', args: { worker: 'A', op: 'ho-op1' } });
    // Ended on the call, before the bridge answers: nothing comes of it.
    await flush();
    expect(e.outcome()).toMatchObject({ kind: 'failed', retry: false });
    await e.answer({ ok: true, data: req({ state: 'failed', reason: 'cancelled' }) });
    expect(await c).toMatchObject({ kind: 'cancelled', message: expect.stringContaining('Cancelled') });
    e.set({ agent_handoff: req({ state: 'filed', handoff: 7 }) });
    await flush();
    expect(e.sent.filter((s) => s.t === 'handoff.get')).toHaveLength(0);
    expect(await e.f.cancel()).toBeNull();
  });

  it('cancel while the filed path is read: the read that answers first is not filed; the cancel says it is in the cabinet', async () => {
    const e = setup();
    await e.answer({ ok: true, data: { request: req() } });
    e.set({ agent_handoff: req({ state: 'filed', handoff: 7 }) });
    await flush();
    expect(e.f.phase).toBe('reading');
    const c = e.f.cancel();
    await e.answer({ ok: true, data: { handoff: ENTRY, body: '' } });
    expect(e.outcome()).toMatchObject({ kind: 'failed', retry: false, message: expect.stringContaining('in the cabinet') });
    await e.answer({ ok: true, data: req({ state: 'filed', handoff: 7 }) });
    expect(await c).toMatchObject({ kind: 'filed' });
  });

  it('cancel the bridge refuses or answers filed: not filed here all the same; the answer says how it ended', async () => {
    const e = setup({ mode: 'llm' });
    await e.answer({ ok: true, data: { job: job() } });
    const c = e.f.cancel();
    await e.answer({ ok: false, code: 'busy', message: 'the handoff is being filed' } as CommandResult);
    expect(await c).toMatchObject({ kind: 'refused', message: expect.stringContaining('may still be filed') });
    expect(e.outcome()).toMatchObject({ kind: 'failed', retry: false });
    const e2 = setup({ mode: 'llm' });
    await e2.answer({ ok: true, data: { job: job() } });
    const c2 = e2.f.cancel();
    await e2.answer({ ok: true, data: job({ state: 'filed', handoff: 7 }) });
    expect(await c2).toMatchObject({ kind: 'filed' });
    expect(e2.sent.filter((s) => s.t === 'handoff.get')).toHaveLength(0);
  });

  it('stopped (the review closed): gone; the completion that comes later reads nothing', async () => {
    const e = setup({ mode: 'llm' });
    await e.answer({ ok: true, data: { job: job() } });
    e.f.stop();
    await flush();
    expect(e.outcome()).toEqual({ kind: 'gone' });
    e.set({ llm_handoff: job({ state: 'filed', handoff: 7 }) });
    await flush();
    expect(e.sent.filter((s) => s.t === 'handoff.get')).toHaveLength(0);
  });

  it('stopped while the request is on its way: its ack is not followed', async () => {
    const e = setup();
    e.f.stop();
    await e.answer({ ok: true, data: { request: req({ state: 'filed', handoff: 7 }) } });
    expect(e.outcome()).toEqual({ kind: 'gone' });
    expect(e.sent.filter((s) => s.t === 'handoff.get')).toHaveLength(0);
  });

  it('the worker leaving before its request was seen filed hires nobody and points to the cabinet', async () => {
    const e = setup();
    await e.answer({ ok: true, data: { request: req() } });
    e.set(undefined);
    await flush();
    expect(e.outcome()).toMatchObject({ kind: 'failed', message: expect.stringContaining('hire from it in the cabinet') });
  });

  it('our request replaced by another after the worker showed it: nobody is hired', async () => {
    const e = setup();
    await e.answer({ ok: true, data: { request: req() } });
    e.set({ agent_handoff: req() });
    e.set({ agent_handoff: req({ op: 'ho-composer', state: 'filed', handoff: 9 }) });
    await flush();
    expect(e.outcome()).toMatchObject({ kind: 'failed', message: expect.stringContaining('replaced by another') });
    expect(e.sent.filter((s) => s.t === 'handoff.get')).toHaveLength(0);
  });

  it('a path that could not be read back keeps the op for the next try', async () => {
    const e = setup();
    await e.answer({ ok: true, data: { request: req({ state: 'filed', handoff: 7 }) } });
    await e.answer({ ok: false, code: 'not_found', message: 'no handoff 7' });
    expect(e.outcome()).toMatchObject({ kind: 'failed', retry: true });
  });

  it('#108: the instruction is reviewed before it goes; a cancelled review files nothing', async () => {
    const sent: string[] = [];
    const flow = {
      on: true,
      review: async () => ({ kind: 'kept', why: 'cancel', message: '' }),
      deliver: async () => ({ kind: 'kept', why: 'cancel', message: '' }),
    } as unknown as PromptSecretsFlow;
    const f = new HandoffFiling({ send: async (t: string) => (sent.push(t), { ok: true, data: {} }), worker: () => undefined, secrets: flow } as never, PLAN, 'ho-op1', () => true);
    expect(await f.run()).toMatchObject({ kind: 'failed', message: expect.stringContaining('review of the handoff instruction was cancelled') });
    expect(sent).toEqual([]);
  });
});
