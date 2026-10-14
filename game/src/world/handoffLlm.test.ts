import { describe, expect, it } from 'vitest';
import type { LLMHandoffPreview } from '../net/protocol';
import { coverageText, handoffLlmStateOf, jobText, llmModeWhy, omittedText, payloadText, redactionText } from './handoffLlm';

const P: LLMHandoffPreview = {
  ready: true, model: 'm', host: 'h', payload_bytes: 2048, est_tokens: 700, budget_bytes: 98304, max_tokens: 4096, timeout_s: 90, prompt_version: 'v1', reduced: true,
  coverage: { messages: 10, kept: 10, omitted: [], compaction: 'none', gaps: [], complete: true }, redactions: {}, categories: [], artifacts: 0, verified: 0,
};

describe('LLM handoffs, in words (#9)', () => {
  it('reads a state, dropping what is malformed', () => {
    expect(handoffLlmStateOf({ enabled: true })).toBeNull();
    const s = handoffLlmStateOf({ enabled: true, state: 'untested', roles: { llm: 'ready' }, env: ['enabled', 3], input_bytes: -1 })!;
    expect(s.state).toBe('untested');
    expect(s.env).toEqual(['enabled']);
    expect(s.input_bytes).toBe(98304);
    expect(s.categories.length).toBeGreaterThan(0);
  });

  it('says why the mode is off, for each state', () => {
    expect(llmModeWhy(null, false)).toContain('can’t write handoffs with an LLM');
    const base = handoffLlmStateOf({ enabled: false, state: 'off', roles: { llm: 'ready' } })!;
    expect(llmModeWhy(base, true)).toContain('off');
    expect(llmModeWhy({ ...base, state: 'incomplete' }, true)).toContain('AI integration');
    expect(llmModeWhy({ ...base, state: 'untested' }, true)).toContain('run it again');
    expect(llmModeWhy({ ...base, state: 'ready' }, true)).toBe('');
  });

  it('sizes, coverage, omitted ranges, redactions and jobs', () => {
    expect(payloadText(P)).toBe('2 KB of transcript, about 700 tokens (budget 96 KB)');
    expect(coverageText(P)).toBe('All 10 messages.');
    expect(coverageText({ ...P, coverage: { ...P.coverage, kept: 4, complete: false, compaction: 'claude_summary' } })).toBe('4 of 10 messages; starts from the compaction summary.');
    expect(omittedText({ ...P, coverage: { ...P.coverage, omitted: [{ from: 2, to: 2, why: 'tool output' }, { from: 3, to: 9, why: '' }] } })).toEqual(['message 2 (tool output)', 'messages 3–9']);
    expect(redactionText({ github_token: 1, jwt: 3, bogus_kind: 2, none: 0 })).toBe('3 JSON web tokens, 2 bogus kind, 1 GitHub token');
    expect(redactionText(undefined)).toBe('');
    expect(jobText({ op: 'o', state: 'running', started_at: 1, updated_at: 1, model: 'm', host: 'h' })).toBe('Sent to m at h; waiting for its handoff.');
    expect(jobText({ op: 'o', state: 'failed', started_at: 1, updated_at: 1, message: 'why' })).toBe('why');
  });
});
