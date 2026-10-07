// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { CommandResult } from '../net/client';
import { DigestBook } from '../world/digestSettings';
import { DIGEST_PRIVACY, DIGEST_SCOPE, DIGEST_TIMING, digestSection } from './digestSection';

const state = (over: Record<string, unknown> = {}) => ({ enabled: false, state: 'off', roles: { llm: 'ready' }, env: [], tested: false, daily_cap: 300, calls_today: 0, ...over });
const LUNA = {
  support: 'supported', model: 'openai/gpt-6-luna', efforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'], listed: true, default_effort: 'medium',
};

function mount(s: Record<string, unknown> | null, answers: Record<string, (args: Record<string, unknown>) => CommandResult> = {}) {
  document.body.replaceChildren();
  const book = new DigestBook();
  book.reset(s);
  const sent: Array<{ t: string; args: Record<string, unknown> }> = [];
  const body = document.createElement('div');
  document.body.append(body);
  let ai = 0;
  const handle = digestSection({
    book,
    send: ((t: string, args: Record<string, unknown>) => {
      sent.push({ t, args });
      return Promise.resolve((answers[t] ?? (() => ({ ok: true, data: {} })))(args));
    }) as never,
    showAi: () => void ai++,
  })(body);
  handle.open?.();
  const box = () => body.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  const cap = () => body.querySelectorAll<HTMLInputElement>('input[type="number"]')[0]!;
  const tokens = () => body.querySelectorAll<HTMLInputElement>('input[type="number"]')[1]!;
  const effort = () => body.querySelector<HTMLSelectElement>('select')!;
  const button = (text: string) => [...body.querySelectorAll('button')].find((b) => b.textContent === text)!;
  const flush = () => new Promise((r) => setTimeout(r, 0));
  return { book, body, sent, box, cap, tokens, effort, button, flush, ai: () => ai };
}

describe('the floor overview summaries section (#118)', () => {
  it('says the bridge has none when it sent no state', () => {
    const m = mount(null);
    expect(m.body.textContent).toContain('no floor overview summaries');
    expect(m.body.querySelector<HTMLElement>('.settings-fu')!.hidden).toBe(true);
  });

  it('is off by default: what is sent and where above a switch that stays off until a test passed', () => {
    const m = mount(state());
    expect(m.box().checked).toBe(false);
    const privacy = m.body.querySelector('.settings-fu-privacy')!;
    expect(privacy.textContent).toBe(DIGEST_PRIVACY);
    // Exactly what goes, and where.
    for (const words of ['configured LLM endpoint', 'first prompt', 'last 5 assistant turns', 'tool call’s name and input summary', 'Tool output and thinking are never sent', 'scrubbed']) {
      expect(DIGEST_PRIVACY).toContain(words);
    }
    expect(privacy.compareDocumentPosition(m.box()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(m.body.querySelector('label.settings-switch')!.textContent).toBe('Floor overview summaries');
    expect(m.box().disabled).toBe(true);
    expect(m.body.textContent).toContain('Run the test below first');
    expect(m.cap().value).toBe('300');
    // The cap stops new calls only: the lines written stay (no promise of fallbacks).
    expect(document.getElementById(m.cap().getAttribute('aria-describedby')!)!.textContent).toBe(
      'Most LLM calls a day; past it no new calls until tomorrow, and the lines already written stay. Default 300.',
    );
    expect(m.body.querySelector('.settings-act-figure')!.textContent).toBe('0 of 300');
    m.book.upsert(state({ tested: true }));
    expect(m.box().disabled).toBe(false);
  });

  it('needs the LLM: no test, no switch, and the way to the AI section while it is not ready', () => {
    const m = mount(state({ missing: ['llm'], roles: { llm: 'invalid' }, tested: true }));
    expect(m.box().disabled).toBe(true);
    expect(m.button('Test').disabled).toBe(true);
    const link = m.button('Set up in AI integration');
    expect(link.hidden).toBe(false);
    link.click();
    expect(m.ai()).toBe(1);
    expect(m.body.querySelector('.settings-badge')!.textContent).toBe('Paused');
  });

  it('Test shows both sample lines; switching on sends digest.set; a refusal says why', async () => {
    const m = mount(state(), {
      'digest.test': () => ({
        ok: true,
        data: { ok: true, latency_ms: 900, samples: [{ kind: 'task', line: 'Fix the flaky login test' }, { kind: 'now', line: 'Rerunning the login test 20 times' }] },
      }),
      'digest.set': (a) => (a.enabled ? { ok: false, code: 'test_required', message: 'run the summaries test first' } : { ok: true, data: {} }),
    });
    m.button('Test').click();
    await m.flush();
    const result = m.body.querySelector('.settings-fu-result')!;
    expect((result as HTMLElement).hidden).toBe(false);
    expect(result.textContent).toContain('Task line');
    expect(result.textContent).toContain('“Fix the flaky login test”');
    expect(result.textContent).toContain('“Rerunning the login test 20 times”');
    expect(m.body.textContent).toContain('Test passed');
    m.book.upsert(state({ tested: true }));
    m.box().checked = true;
    m.box().dispatchEvent(new Event('change'));
    await m.flush();
    expect(m.sent.at(-1)).toEqual({ t: 'digest.set', args: { enabled: true } });
    expect(m.body.querySelector('.settings-status')!.textContent).toBe('Run the test first: it has to pass with the LLM in use.');
    expect(m.box().checked).toBe(false);
  });

  it('a failed test says which line came back empty', async () => {
    const m = mount(state(), {
      'digest.test': () => ({ ok: true, data: { ok: false, reason: 'the LLM’s now line was empty', latency_ms: 900, samples: [{ kind: 'task', line: 'Fix it' }, { kind: 'now', error: 'the LLM’s answer holds no line' }] } }),
    });
    m.button('Test').click();
    await m.flush();
    expect(m.body.textContent).toContain('Test failed: the LLM’s now line was empty.');
    expect(m.body.querySelector('.settings-fu-result')!.textContent).toContain('Empty');
  });

  it('the daily cap: saved on Enter, refused out of range; the day’s calls fill the bar and warn at the cap', async () => {
    const m = mount(state({ enabled: true, state: 'ready', tested: true }));
    m.cap().value = '0';
    m.cap().dispatchEvent(new Event('input'));
    m.cap().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(m.cap().getAttribute('aria-invalid')).toBe('true');
    expect(m.sent.filter((s) => s.t === 'digest.set')).toEqual([]);
    m.cap().value = '500';
    m.cap().dispatchEvent(new Event('input'));
    m.cap().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    m.cap().dispatchEvent(new Event('change'));
    await m.flush();
    expect(m.sent.filter((s) => s.t === 'digest.set')).toEqual([{ t: 'digest.set', args: { daily_cap: 500 } }]);
    expect(m.body.textContent).toContain('Daily cap saved: 500.');
    m.book.upsert(state({ enabled: true, state: 'ready', tested: true, calls_today: 300 }));
    expect(m.body.querySelector<HTMLElement>('.settings-act-bar')!.dataset.level).toBe('full');
    expect(m.body.textContent).toContain('today’s cap is reached: no new calls until tomorrow. The lines already written stay, and an input seen before reuses its line.');
    expect(m.body.textContent).not.toContain('own lines until tomorrow');
  });

  it('the environment’s switch is read-only here and says so', () => {
    const m = mount(state({ enabled: true, state: 'incomplete', missing: ['llm'], roles: { llm: 'off' }, env: ['enabled'] }));
    expect(m.box().checked).toBe(true);
    expect(m.box().disabled).toBe(true);
    expect(m.body.textContent).toContain('HERDR_WORLD_DIGEST_ENABLED');
    expect(m.body.textContent).toContain('Paused until the LLM is ready.');
  });

  it('reads the day’s count again as the window opens', () => {
    const m = mount(state());
    expect(m.sent).toContainEqual({ t: 'digest.get', args: {} });
  });

  // #174
  it('opens with digest.get, which reads the model’s catalog on the bridge', () => {
    const m = mount(state());
    expect(m.sent.map((x) => x.t)).toContain('digest.get');
  });

  it('the reasoning effort is a dropdown of exactly the model’s efforts, with the provider default first', () => {
    const m = mount(state({ reasoning_effort: '', max_tokens: 1024, effort_stale: false, reasoning: LUNA }));
    expect([...m.effort().options].map((o) => o.value)).toEqual(['', 'none', 'low', 'medium', 'high', 'xhigh', 'max']);
    expect(m.effort().options[0]!.textContent).toBe('Provider default (the model uses medium)');
    expect(m.effort().value).toBe('');
    expect(m.effort().disabled).toBe(false);
    expect(document.getElementById(m.effort().getAttribute('aria-describedby')!)!.textContent).toContain('catalog lists');
  });

  it('choosing an effort or the default sends digest.set; a refusal says why and the control goes back', async () => {
    const m = mount(state({ reasoning_effort: '', max_tokens: 1024, effort_stale: false, reasoning: LUNA }), {
      'digest.set': (a) => (a.reasoning_effort === 'max' ? { ok: false, code: 'bad_request', message: 'this model does not take the reasoning effort' } : { ok: true, data: {} }),
    });
    m.effort().value = 'none';
    m.effort().dispatchEvent(new Event('change'));
    await m.flush();
    expect(m.sent.at(-1)).toEqual({ t: 'digest.set', args: { reasoning_effort: 'none' } });
    expect(m.body.querySelector('.settings-status')!.textContent).toContain('Run the test again');
    m.effort().value = 'max';
    m.effort().dispatchEvent(new Event('change'));
    await m.flush();
    expect(m.body.querySelector('.settings-status')!.textContent).toContain('does not take');
    m.book.upsert(state({ reasoning_effort: '', max_tokens: 1024, reasoning: LUNA }));
    expect(m.effort().value).toBe('');
    m.effort().value = '';
    m.effort().dispatchEvent(new Event('change'));
    await m.flush();
    expect(m.sent.at(-1)).toEqual({ t: 'digest.set', args: { reasoning_effort: '' } });
  });

  it('a model without reasoning: the control is disabled and says why; a stale effort is shown, not sent', () => {
    const m = mount(state({ reasoning: { support: 'unsupported', model: 'plain/chat', efforts: [], listed: false } }));
    expect(m.effort().disabled).toBe(true);
    expect([...m.effort().options].map((o) => o.value)).toEqual(['']);
    expect(document.getElementById(m.effort().getAttribute('aria-describedby')!)!.textContent).toContain('no reasoning effort to choose');
    m.book.upsert(state({ reasoning_effort: 'minimal', effort_stale: true, reasoning: LUNA }));
    const stale = [...m.effort().options].find((o) => o.value === 'minimal')!;
    expect(stale.disabled).toBe(true);
    expect(stale.textContent).toContain('not supported by this model');
    expect(m.effort().value).toBe('minimal');
    const hint = document.getElementById(m.effort().getAttribute('aria-describedby')!)!;
    expect(hint.textContent).toContain('is not sent');
    expect(hint.classList.contains('settings-field-error')).toBe(true);
  });

  it('the completion budget: shown as the effective value, validated, sent, and not the lines’ length', async () => {
    const m = mount(state({ max_tokens: 1024, reasoning: LUNA }));
    expect(m.tokens().value).toBe('1024');
    const hint = document.getElementById(m.tokens().getAttribute('aria-describedby')!)!.textContent!;
    expect(hint).toContain('In use: 1,024');
    expect(hint).toContain('reasoning included');
    expect(hint).toContain('not the line');
    expect(hint).toContain('80 characters');
    m.tokens().value = '10';
    m.tokens().dispatchEvent(new Event('input'));
    m.tokens().dispatchEvent(new Event('change'));
    expect(m.sent.filter((x) => x.t === 'digest.set')).toEqual([]);
    expect(m.tokens().getAttribute('aria-invalid')).toBe('true');
    expect(m.body.querySelector('.settings-status')!.textContent).toContain('from 64 to 16,384');
    m.tokens().value = '2048';
    m.tokens().dispatchEvent(new Event('input'));
    m.tokens().dispatchEvent(new Event('change'));
    await m.flush();
    expect(m.sent.at(-1)).toEqual({ t: 'digest.set', args: { max_tokens: 2048 } });
    expect(m.body.querySelector('.settings-status')!.textContent).toBe('Completion budget saved: 2,048 tokens.');
  });

  it('says which features the two settings reach, and when lines are written', () => {
    const m = mount(state());
    expect(m.body.textContent).toContain(DIGEST_SCOPE);
    expect(DIGEST_SCOPE).toContain('floor overview summaries only');
    expect(m.body.textContent).toContain(DIGEST_TIMING);
    for (const words of ['once per prompt', 'turn ends', '2 seconds', 'once a minute', 'floor someone is viewing', 'up to 4 times']) expect(DIGEST_TIMING).toContain(words);
  });

  it('Retry failed sends digest.retry and says how many lines', async () => {
    let retried = 2;
    const m = mount(state({ enabled: true, state: 'ready', tested: true }), { 'digest.retry': () => ({ ok: true, data: { retried } }) });
    m.button('Retry failed').click();
    await m.flush();
    expect(m.sent.at(-1)).toEqual({ t: 'digest.retry', args: {} });
    expect(m.body.querySelector('.settings-status')!.textContent).toBe('Trying 2 failed lines again.');
    retried = 0;
    m.button('Retry failed').click();
    await m.flush();
    expect(m.body.querySelector('.settings-status')!.textContent).toContain('nothing to retry');
    m.book.upsert(state());
    expect(m.button('Retry failed').disabled).toBe(true);
  });

  it('a test sample shows what it spent of the budget', async () => {
    const m = mount(state({ max_tokens: 1024 }), {
      'digest.test': () => ({
        ok: true,
        data: { ok: true, latency_ms: 900, samples: [{ kind: 'task', line: 'Fix the flaky login test', diag: { status: 200, finish_reason: 'stop', completion_tokens: 412, reasoning_tokens: 380, content: 'nonempty', content_chars: 24 } }, { kind: 'now', line: 'Rerunning the login test' }] },
      }),
    });
    m.button('Test').click();
    await m.flush();
    expect(m.body.querySelector('.settings-dg-usage')!.textContent).toBe('Spent 412 of 1,024 tokens, 380 reasoning');
    expect(m.body.querySelectorAll('.settings-dg-usage')).toHaveLength(1);
  });
});
