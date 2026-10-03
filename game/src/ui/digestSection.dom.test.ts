// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { CommandResult } from '../net/client';
import { DigestBook } from '../world/digestSettings';
import { DIGEST_PRIVACY, digestSection } from './digestSection';

const state = (over: Record<string, unknown> = {}) => ({ enabled: false, state: 'off', roles: { llm: 'ready' }, env: [], tested: false, daily_cap: 300, calls_today: 0, ...over });

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
  const cap = () => body.querySelector<HTMLInputElement>('input[type="number"]')!;
  const button = (text: string) => [...body.querySelectorAll('button')].find((b) => b.textContent === text)!;
  const flush = () => new Promise((r) => setTimeout(r, 0));
  return { book, body, sent, box, cap, button, flush, ai: () => ai };
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
    expect(m.body.textContent).toContain('today’s cap is reached');
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
});
