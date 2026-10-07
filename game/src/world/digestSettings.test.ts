import { describe, expect, it } from 'vitest';
import { DIGEST_TOKENS, DigestBook, digestFailureText, digestStateOf, effortChoices, effortNote, lineStatusText, reasonWord, usageText } from './digestSettings';

describe('the floor overview summaries’ state (#118)', () => {
  it('reads a well-formed state strictly, dropping what it does not know', () => {
    expect(digestStateOf({ enabled: true, state: 'ready', roles: { llm: 'ready' }, env: ['enabled', 3], tested: true, daily_cap: 300.7, calls_today: 12, extra: 1 })).toEqual({
      enabled: true, state: 'ready', roles: { llm: 'ready' }, env: ['enabled'], tested: true, daily_cap: 300, calls_today: 12,
      // #174: a bridge from before them: the provider's default effort, the default budget, nothing known of the model.
      reasoning_effort: '', max_tokens: 1024, effort_stale: false, reasoning: { support: 'unknown', efforts: ['low', 'medium', 'high'], listed: false },
    });
    expect(digestStateOf({ enabled: false, state: 'off', roles: { llm: 'weird' }, daily_cap: 300, missing: ['llm', 'x'] })).toMatchObject({ roles: { llm: 'off' }, missing: ['llm'], calls_today: 0, tested: false });
    for (const bad of [null, [], { enabled: 'yes', state: 'off', daily_cap: 1 }, { enabled: true, state: 'capped', daily_cap: 1 }, { enabled: true, state: 'ready' }]) {
      expect(digestStateOf(bad)).toBeNull();
    }
  });

  it('the book: a snapshot without it is unknown; an update replaces it and tells', () => {
    const b = new DigestBook();
    let n = 0;
    b.onChange(() => n++);
    b.reset(undefined);
    expect(b.known).toBe(false);
    expect(b.upsert({ t: 'digest.update', seq: 3, enabled: true, state: 'ready', roles: { llm: 'ready' }, env: [], tested: true, daily_cap: 5, calls_today: 1 })).toBe(true);
    expect(b.known).toBe(true);
    expect(b.state?.daily_cap).toBe(5);
    expect(b.upsert({ junk: true })).toBe(false);
    expect(n).toBe(2);
  });

  it('plain words for its failures', () => {
    expect(digestFailureText('test_required', 'x')).toContain('Run the test first');
    expect(digestFailureText('env_locked', 'x')).toContain('HERDR_WORLD_DIGEST_ENABLED');
    expect(digestFailureText('incomplete', 'x')).toContain('LLM must be ready');
    expect(digestFailureText('unsupported', 'x')).toContain('no floor overview summaries');
    expect(digestFailureText('timeout', 'x')).toContain('Try again');
  });
});

const LUNA = {
  enabled: true, state: 'ready', roles: { llm: 'ready' }, env: [], tested: true, daily_cap: 300, calls_today: 0,
  reasoning_effort: '', max_tokens: 2048, effort_stale: false,
  reasoning: { support: 'supported', model: 'openai/gpt-6-luna', efforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'], listed: true, default_effort: 'medium' },
};

describe('the reasoning effort and the completion budget (#174)', () => {
  it('reads them, and the model’s catalog entry', () => {
    const s = digestStateOf(LUNA)!;
    expect(s.reasoning_effort).toBe('');
    expect(s.max_tokens).toBe(2048);
    expect(s.reasoning).toEqual({ support: 'supported', model: 'openai/gpt-6-luna', efforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'], listed: true, default_effort: 'medium' });
    expect(digestStateOf({ ...LUNA, max_tokens: -3 })!.max_tokens).toBe(DIGEST_TOKENS.default);
    expect(DIGEST_TOKENS.default).toBe(1024);
    expect(digestStateOf({ ...LUNA, reasoning: { support: 'unsupported' } })!.reasoning).toMatchObject({ support: 'unsupported', efforts: [] });
  });

  it('offers the provider default first, then exactly the model’s efforts (never minimal for Luna)', () => {
    const c = effortChoices(digestStateOf(LUNA)!);
    expect(c.map((x) => x.value)).toEqual(['', 'none', 'low', 'medium', 'high', 'xhigh', 'max']);
    expect(c[0]!.label).toBe('Provider default (the model uses medium)');
    expect(c.find((x) => x.value === 'none')!.label).toBe('Off (no reasoning)');
    expect(c.some((x) => x.value === 'minimal')).toBe(false);
  });

  it('a model without reasoning offers only the default, and says so; an unknown one the generic three', () => {
    const none = digestStateOf({ ...LUNA, reasoning: { support: 'unsupported', model: 'plain/chat', efforts: [] } })!;
    expect(effortChoices(none).map((x) => x.value)).toEqual(['']);
    expect(effortNote(none)).toBe('Model plain/chat has no reasoning effort to choose: nothing is sent.');
    const unknown = digestStateOf({ ...LUNA, reasoning: { support: 'unknown', efforts: ['low', 'medium', 'high'] } })!;
    expect(effortChoices(unknown).map((x) => x.value)).toEqual(['', 'low', 'medium', 'high']);
    expect(effortNote(unknown)).toContain('does not describe');
    const must = digestStateOf({ ...LUNA, reasoning: { ...LUNA.reasoning, mandatory: true, efforts: ['low', 'high'] } })!;
    expect(effortNote(must)).toContain('cannot be turned off');
  });

  it('a saved effort the model does not take stays visible, marked, and is said not to be sent', () => {
    const st = digestStateOf({ ...LUNA, reasoning_effort: 'minimal', effort_stale: true })!;
    const c = effortChoices(st);
    expect(c.at(-1)).toEqual({ value: 'minimal', label: 'Minimal (not supported by this model)', stale: true });
    expect(effortNote(st)).toContain('is not sent');
  });

  it('a test sample’s spend', () => {
    expect(usageText({ completion_tokens: 412, reasoning_tokens: 380 }, 1024)).toBe('412 of 1,024 tokens, 380 reasoning');
    expect(usageText({ completion_tokens: 34 }, 80)).toBe('34 of 80 tokens');
    expect(usageText(undefined, 80)).toBe('');
  });

  it('what a line’s status says, and what to do', () => {
    const failed = lineStatusText({ state: 'failed', reason: 'truncated', attempts: 4 }, 'task');
    expect(failed.chip).toBe('AI failed');
    expect(failed.retry).toBe(true);
    expect(failed.detail).toContain('after 4 attempts');
    expect(failed.detail).toContain('token budget');
    expect(failed.detail).toContain('Raise the completion budget');
    expect(failed.detail).toContain('new prompt');
    expect(lineStatusText({ state: 'failed', reason: 'timeout' }, 'now').detail).toContain('after the next turn');
    const retrying = lineStatusText({ state: 'retrying', reason: 'bad_response', attempts: 1, retry_at: Date.UTC(2026, 9, 7, 14, 32) }, 'task');
    expect(retrying.chip).toMatch(/^AI retry \d\d:\d\d/);
    expect(retrying.detail).toContain('tries again at');
    expect(lineStatusText({ state: 'pending' }, 'task')).toMatchObject({ chip: 'AI pending', retry: false });
    expect(lineStatusText({ state: 'pending', reason: 'daily_cap' }, 'task')).toMatchObject({ chip: 'AI waiting', retry: false });
    expect(reasonWord('empty_answer')).toBe('the model answered with no text');
    expect(reasonWord('weird_code')).toBe('weird code');
  });

  it('plain words for a truncated answer', () => {
    expect(digestFailureText('truncated', 'the model used its whole completion budget (80 of 80 tokens)')).toContain('Raise the completion budget');
    expect(digestFailureText('empty_answer', 'x')).toContain('no text');
  });
});
