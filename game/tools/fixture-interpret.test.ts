import { describe, expect, it } from 'vitest';
import type { AiSim } from './fixture-ai.ts';
import { InterpretSim, interpretationProblem } from './fixture-interpret.ts';
import { SIM_HIRE_OPTIONS } from './fixture-sim.ts';

// #213: the fixture's `hire.interpret` passes the (fake) LLM's final answer on, checked; errors are acks.

class CmdError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const TEXT = 'Hire an agent. Task: fix the login bug.';
const hire = {
  sources: ['ignored: the fixture sets them'],
  harness: { provenance: 'dictated', value: 'claude' },
  model: { provenance: 'resolved', value: 'claude-sonnet-5-5' },
  effort: { provenance: 'missing' },
  task: { provenance: 'dictated', value: 'fix the login bug.', span: { source: 0, start: 21, end: 39 } },
  questions: [{ field: 'effort', text: 'What effort level should this agent use?' }],
  ready_for_review: false,
};

function sim(o: { ready?: boolean; answer?: (msgs: Array<{ content: string }>) => Promise<string> } = {}) {
  const calls: Array<Array<{ content: string }>> = [];
  const ai = {
    ready: () => o.ready ?? true,
    complete: (msgs: Array<{ role: string; content: string }>) => {
      calls.push(msgs);
      return o.answer ? o.answer(msgs) : Promise.resolve(JSON.stringify({ intent: 'hire', hire }));
    },
  } as unknown as AiSim;
  const s = new InterpretSim({ ai, hireOptions: () => SIM_HIRE_OPTIONS, error: (c, m) => new CmdError(c, m) });
  const run = (args: Record<string, unknown>) =>
    new Promise<unknown>((done, no) => {
      if (!s.handle('hire.interpret', args, done, no)) no(new Error('not handled'));
    });
  return { s, run, calls };
}

describe('the fixture’s hire.interpret (#213)', () => {
  it('passes a hire on with its sources, and sends the LLM the text, the pending proposal and the catalog', async () => {
    const t = sim();
    expect(await t.run({ text: TEXT })).toEqual({ text: TEXT, intent: 'hire', hire: { ...hire, sources: [TEXT] } });
    expect(JSON.parse(t.calls[0]!.at(-1)!.content)).toEqual({ command: TEXT, pending_hire: null, hire_options: SIM_HIRE_OPTIONS });
    // A follow-up: the sources grow by the reply.
    const pending = { ...hire, sources: [TEXT] };
    const f = sim({ answer: async () => JSON.stringify({ intent: 'hire', hire: { ...pending, effort: { provenance: 'dictated', value: 'high' }, questions: [], ready_for_review: true } }) });
    const r = (await f.run({ text: 'high', pending })) as { hire: { sources: string[]; effort: unknown } };
    expect(r.hire.sources).toEqual([TEXT, 'high']);
    expect(r.hire.effort).toEqual({ provenance: 'dictated', value: 'high' });
    expect(JSON.parse(f.calls[0]!.at(-1)!.content).pending_hire).toEqual(pending);
  });

  it('#190: hidden_models takes models out of the catalog the LLM reads (labels and extra efforts too); unknown ids are ignored; a malformed list is a bad request', async () => {
    const t = sim();
    await t.run({ text: TEXT, hidden_models: { codex: ['gpt-6-luna', 'gpt-6-astra', 'gpt-9-nova'], gemini: ['g-1'] } });
    const options = JSON.parse(t.calls[0]!.at(-1)!.content).hire_options;
    expect(options.codex.models).toEqual(['gpt-6-sol']);
    expect(Object.keys(options.codex.extra_efforts ?? {})).toEqual(['gpt-6-sol']);
    expect(Object.keys(options.codex.model_labels ?? {}).filter((m: string) => m !== 'gpt-6-sol')).toEqual([]);
    expect(options.claude).toEqual(SIM_HIRE_OPTIONS.claude);
    for (const bad of [['gpt-6-sol'], { codex: 'gpt-6-sol' }, { codex: [''] }, { codex: Array(257).fill('x') }, { codex: ['x'.repeat(201)] }]) {
      await expect(sim().run({ text: TEXT, hidden_models: bad })).rejects.toMatchObject({ code: 'bad_request' });
    }
  });

  it('passes unsupported and unclear on, with nothing else', async () => {
    expect(await sim({ answer: async () => '{"intent":"unsupported","reason":"multiple"}' }).run({ text: 'Hire two agents.' })).toEqual({ text: 'Hire two agents.', intent: 'unsupported', reason: 'multiple' });
    expect(await sim({ answer: async () => '{"intent":"unclear"}' }).run({ text: 'high' })).toEqual({ text: 'high', intent: 'unclear' });
  });

  it('acks errors: not ready (no call), the provider’s, an answer that is not one, a task not said', async () => {
    const off = sim({ ready: false });
    expect(await off.run({ text: TEXT })).toEqual({ text: TEXT, error: { code: 'not_ready', message: 'no LLM is ready to interpret commands' } });
    expect(off.calls).toHaveLength(0);
    const failed = Object.assign(new Error('the provider answered HTTP 500'), { code: 'provider_failed' });
    expect(await sim({ answer: () => Promise.reject(failed) }).run({ text: TEXT })).toMatchObject({ error: { code: 'provider_failed' } });
    expect(await sim({ answer: async () => 'nope' }).run({ text: TEXT })).toMatchObject({ error: { code: 'bad_answer' } });
    expect(await sim({ answer: async () => '{"intent":"fire"}' }).run({ text: TEXT })).toMatchObject({ error: { code: 'bad_answer' } });
    expect(await sim({ answer: async () => '{"intent":"unclear","hire":{}}' }).run({ text: TEXT })).toMatchObject({ error: { code: 'bad_answer' } });
    const wrong = { ...hire, task: { ...hire.task, span: { source: 0, start: 0, end: 5 } } };
    expect(await sim({ answer: async () => JSON.stringify({ intent: 'hire', hire: wrong }) }).run({ text: TEXT })).toMatchObject({ error: { code: 'bad_span' } });
  });

  it('times out past its bound (sim.interpret sets it)', async () => {
    const t = sim({ answer: () => new Promise((r) => setTimeout(() => r('{"intent":"unclear"}'), 200)) });
    await new Promise((done, no) => t.s.handle('sim.interpret', { timeout_ms: 20 }, done, no));
    expect(await t.run({ text: TEXT })).toEqual({ text: TEXT, error: { code: 'timeout', message: 'the LLM did not answer in time' } });
  });

  it('refuses bad args, and a pending proposal that is not one', async () => {
    const t = sim();
    await expect(t.run({ text: TEXT, catalog: {} })).rejects.toMatchObject({ code: 'bad_request' });
    await expect(t.run({ text: '' })).rejects.toMatchObject({ code: 'bad_request' });
    await expect(t.run({ text: 'a\u0000b' })).rejects.toMatchObject({ code: 'bad_request' });
    await expect(t.run({ text: 'x'.repeat(8193) })).rejects.toMatchObject({ code: 'bad_request' });
    expect(await t.run({ text: 'high', pending: { sources: [] } })).toMatchObject({ error: { code: 'bad_pending' } });
    expect(await t.run({ text: 'high', pending: { ...hire, sources: Array(6).fill(TEXT) } })).toMatchObject({ error: { code: 'bad_pending' } });
    expect(t.calls).toHaveLength(0);
  });

  it('checks a proposal’s shape and its task’s span', () => {
    expect(interpretationProblem({ ...hire, sources: [TEXT] })).toBeNull();
    expect(interpretationProblem({ ...hire, sources: ['other'] })).toBe('span');
    expect(interpretationProblem({ ...hire, sources: [TEXT], ready_for_review: 'yes' })).toBe('shape');
    expect(interpretationProblem({ ...hire, sources: [TEXT], model: { provenance: 'guessed' } })).toBe('shape');
  });
});
