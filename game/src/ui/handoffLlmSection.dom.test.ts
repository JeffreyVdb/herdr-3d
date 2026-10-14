// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { CommandResult } from '../net/client';
import { HandoffLLMBook } from '../world/handoffLlm';
import { handoffLlmPrivacy, handoffLlmSection } from './handoffLlmSection';

const CATS = ['your prompts to the worker', 'tool names and their inputs (commands, paths)', 'your handoff instruction'];
const state = (over: Record<string, unknown> = {}) => ({
  enabled: false, state: 'off', roles: { llm: 'ready' }, env: [], tested: false, input_bytes: 98304, max_tokens: 4096, reasoning_effort: '',
  reasoning: { support: 'unknown', efforts: ['low', 'medium', 'high'], listed: false }, effort_stale: false, timeout_s: 90, prompt_version: 'v1', categories: CATS, ...over,
});

function mount(s: Record<string, unknown> | null, answers: Record<string, (args: Record<string, unknown>) => CommandResult> = {}) {
  document.body.replaceChildren();
  const book = new HandoffLLMBook();
  book.reset(s);
  const sent: Array<{ t: string; args: Record<string, unknown> }> = [];
  const body = document.createElement('div');
  document.body.append(body);
  let ai = 0;
  const handle = handoffLlmSection({
    book,
    send: ((t: string, args: Record<string, unknown>) => {
      sent.push({ t, args });
      return Promise.resolve((answers[t] ?? (() => ({ ok: true, data: {} })))(args));
    }) as never,
    showAi: () => void ai++,
  })(body);
  handle.open?.();
  const box = () => body.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  const budget = () => body.querySelectorAll<HTMLInputElement>('input[type="number"]')[0]!;
  const tokens = () => body.querySelectorAll<HTMLInputElement>('input[type="number"]')[1]!;
  const button = (text: string) => [...body.querySelectorAll('button')].find((b) => b.textContent === text)!;
  const flush = () => new Promise((r) => setTimeout(r, 0));
  return { book, body, sent, box, budget, tokens, button, flush, ai: () => ai };
}

describe('the LLM handoffs section (#9)', () => {
  it('says the bridge has none when it sent no state', () => {
    const m = mount(null);
    expect(m.body.textContent).toContain('no LLM handoffs');
    expect(m.body.querySelector<HTMLElement>('.settings-fu')!.hidden).toBe(true);
  });

  it('is off by default, discloses what goes where, honestly, above a switch that waits for a test', () => {
    const m = mount(state());
    expect(m.box().checked).toBe(false);
    expect(m.box().disabled).toBe(true);
    const privacy = m.body.querySelector('.settings-fu-privacy')!.textContent!;
    expect(privacy).toBe(handoffLlmPrivacy(CATS));
    for (const words of ['configured LLM endpoint', ...CATS, 'Full tool output, images, hidden reasoning and subagent transcripts are left out', 'can miss a secret', 'Nothing is sent until you file a handoff this way']) {
      expect(privacy).toContain(words);
    }
    expect(m.body.textContent).toContain('Run the test below first');
    expect(m.budget().value).toBe('96');
    expect(m.tokens().value).toBe('4096');
    m.book.upsert(state({ tested: true }));
    expect(m.box().disabled).toBe(false);
  });

  it('tests with a sample (no real transcript), then switches on', async () => {
    const m = mount(state(), {
      'handoff_llm.test': () => ({ ok: true, data: { ok: true, title: 'Fix the flaky login test', bytes: 900, latency_ms: 4200, diag: { status: 200, completion_tokens: 600, content: 'nonempty', content_chars: 900 } } }),
      'handoff_llm.set': () => ({ ok: true, data: state({ enabled: true, state: 'ready', tested: true }) }),
    });
    m.button('Test').click();
    expect(m.body.textContent).toContain('a short sample session (no real transcript)');
    await m.flush();
    expect(m.body.querySelector('.settings-fu-result')!.textContent).toContain('“Fix the flaky login test”');
    expect(m.body.querySelector('.settings-fu-result')!.textContent).toContain('600 of 4,096 tokens');
    m.book.upsert(state({ tested: true }));
    m.box().checked = true;
    m.box().dispatchEvent(new Event('change'));
    await m.flush();
    expect(m.sent.at(-1)).toEqual({ t: 'handoff_llm.set', args: { enabled: true } });
  });

  it('says when a changed LLM or limit leaves it waiting for a test, and when the environment owns it', () => {
    const m = mount(state({ enabled: true, state: 'untested' }));
    expect(m.body.textContent).toContain('the LLM or the limits changed since the test');
    m.book.upsert(state({ enabled: true, state: 'ready', env: ['enabled'] }));
    expect(m.box().disabled).toBe(true);
    expect(m.body.textContent).toContain('HERDR_WORLD_HANDOFF_LLM_ENABLED');
  });

  it('saves the budgets in their units, refusing what is out of bounds', async () => {
    const m = mount(state({ enabled: true, state: 'ready' }));
    m.budget().value = '8';
    m.budget().dispatchEvent(new Event('input'));
    m.budget().dispatchEvent(new Event('change'));
    expect(m.budget().getAttribute('aria-invalid')).toBe('true');
    expect(m.sent.some((x) => x.t === 'handoff_llm.set')).toBe(false);
    m.budget().value = '128';
    m.budget().dispatchEvent(new Event('input'));
    m.budget().dispatchEvent(new Event('change'));
    await m.flush();
    expect(m.sent.at(-1)).toEqual({ t: 'handoff_llm.set', args: { input_bytes: 131072 } });
    m.tokens().value = '8192';
    m.tokens().dispatchEvent(new Event('input'));
    m.tokens().dispatchEvent(new Event('change'));
    await m.flush();
    expect(m.sent.at(-1)).toEqual({ t: 'handoff_llm.set', args: { max_tokens: 8192 } });
    expect(m.body.textContent).toContain('Run the test again');
  });

  it('needs the LLM: the way to the AI section while it is not ready', () => {
    const m = mount(state({ missing: ['llm'], roles: { llm: 'off' } }));
    expect(m.button('Test').disabled).toBe(true);
    m.button('Set up in AI integration').click();
    expect(m.ai()).toBe(1);
  });
});
