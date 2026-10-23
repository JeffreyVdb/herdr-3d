// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { CommandResult } from '../net/client';
import { PackupBook } from '../world/packup';
import { PACKUP_PRIVACY, packupSection } from './packupSection';

const state = (over: Record<string, unknown> = {}) => ({ enabled: false, threshold: 0.85, state: 'off', roles: { classifier: 'ready', llm: 'ready' }, env: [], tested: false, ...over });

function mount(s: Record<string, unknown> | null, answers: Record<string, (args: Record<string, unknown>) => CommandResult> = {}) {
  document.body.replaceChildren();
  const book = new PackupBook();
  book.reset(s);
  const sent: Array<{ t: string; args: Record<string, unknown> }> = [];
  const body = document.createElement('div');
  document.body.append(body);
  const handle = packupSection({
    book,
    send: ((t: string, args: Record<string, unknown>) => {
      sent.push({ t, args });
      return Promise.resolve((answers[t] ?? (() => ({ ok: true, data: {} })))(args));
    }) as never,
    showAi: () => {},
  })(body);
  handle.open?.();
  const box = () => body.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  const button = (text: string) => [...body.querySelectorAll('button')].find((b) => b.textContent === text)!;
  const flush = () => new Promise((r) => setTimeout(r, 0));
  return { book, body, sent, box, button, flush };
}

describe('the pack up on request section (#110)', () => {
  it('says the bridge has none when it sent no state', () => {
    const m = mount(null);
    expect(m.body.textContent).toContain('no pack up on request');
    expect(m.body.querySelector<HTMLElement>('.settings-fu')!.hidden).toBe(true);
  });

  it('is off by default: the privacy note above a switch that stays off until a test passed', () => {
    const m = mount(state());
    expect(m.box().checked).toBe(false);
    const privacy = m.body.querySelector('.settings-fu-privacy')!;
    expect(privacy.textContent).toBe(PACKUP_PRIVACY);
    expect(privacy.compareDocumentPosition(m.box()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(m.body.querySelector('label.settings-switch')!.textContent).toBe('Pack up on request');
    expect(m.box().disabled).toBe(true);
    expect(m.body.textContent).toContain('Run the test below first');
    expect(m.body.querySelector<HTMLInputElement>('input[type="number"]')!.value).toBe('0.85');
    m.book.upsert(state({ tested: true }));
    expect(m.box().disabled).toBe(false);
  });

  it('needs both models: no test, no switch while one is not ready', () => {
    const m = mount(state({ missing: ['classifier'], roles: { classifier: 'incomplete', llm: 'ready' }, tested: true }));
    expect(m.box().disabled).toBe(true);
    expect(m.button('Test').disabled).toBe(true);
    expect(m.button('Set up in AI integration').hidden).toBe(false);
  });

  it('Test shows the core prompts and how many came out as expected; switching on sends packup.set', async () => {
    const m = mount(state(), {
      'packup.test': () => ({
        ok: true,
        data: {
          ok: true,
          threshold: 0.85,
          latency_ms: 4000,
          right: 29,
          total: 30,
          samples: [
            { text: 'Please make a PR and end your turn', expect: 'match', core: true, score: 0.97, matched: true, task: 'Please make a PR', right: true },
            { text: 'Please make a PR', expect: 'skip', core: true, score: 0.04, matched: false, right: true },
            { text: 'Mach einen PR und geh dann nach Hause.', expect: 'match', score: 0.6, matched: false, right: false },
          ],
        },
      }),
    });
    m.button('Test').click();
    await m.flush();
    const core = m.body.querySelector('.settings-fu-result > .settings-fu-samples')!;
    expect(core.textContent).toContain('0.97');
    expect(core.textContent).toContain('Sent as: “Please make a PR”');
    expect(core.textContent).not.toContain('Nach Hause');
    const all = m.body.querySelector('details.settings-pk-all')!;
    expect(all.querySelector('summary')!.textContent).toBe('29 of 30 classifier scores as expected at 0.85');
    expect(all.textContent).toContain('Gate missed · extraction not tested');
    expect(m.body.textContent).toContain('Test passed');
    m.book.upsert(state({ tested: true }));
    m.box().checked = true;
    m.box().dispatchEvent(new Event('change'));
    await m.flush();
    expect(m.sent.at(-1)).toEqual({ t: 'packup.set', args: { enabled: true } });
  });

  it('a failing test says why', async () => {
    const m = mount(state(), { 'packup.test': () => ({ ok: true, data: { ok: false, reason: '"Please make a PR" scored 0.90, at or over the threshold 0.85', threshold: 0.85, latency_ms: 1, right: 29, total: 30, samples: [] } }) });
    m.button('Test').click();
    await m.flush();
    expect(m.body.querySelector('.settings-status')!.textContent).toContain('Test failed: "Please make a PR" scored 0.90');
  });

  it('the environment’s switch is read-only', () => {
    const m = mount(state({ enabled: true, state: 'ready', env: ['enabled'] }));
    expect(m.box().checked).toBe(true);
    expect(m.box().disabled).toBe(true);
    expect(m.body.textContent).toContain('HERDR_WORLD_PACKUP_ENABLED');
  });

  it('commits the threshold', async () => {
    const m = mount(state());
    const th = m.body.querySelector<HTMLInputElement>('input[type="number"]')!;
    th.value = '0.9';
    th.dispatchEvent(new Event('input'));
    th.dispatchEvent(new Event('change'));
    await m.flush();
    expect(m.sent.filter((s) => s.t !== 'packup.get')).toEqual([{ t: 'packup.set', args: { threshold: 0.9 } }]);
  });
});

it('saves exactly the selected effort and budget, including higher reasoning', async () => {
  const m = mount(state({ reasoning_effort: '', max_tokens: 600, reasoning: { support: 'supported', listed: true, efforts: ['none', 'high'], model: 'example', default_effort: 'high' } }));
  const effort = m.body.querySelector('select')!;
  expect([...effort.options].map((o) => o.value)).toEqual(['', 'none', 'high']);
  effort.value = 'high';
  effort.dispatchEvent(new Event('change'));
  await m.flush();
  expect(m.sent.at(-1)).toEqual({ t: 'packup.set', args: { reasoning_effort: 'high' } });
  const tokens = m.body.querySelector<HTMLInputElement>('input[id$="-tokens"]')!;
  tokens.value = '2048';
  tokens.dispatchEvent(new Event('input'));
  tokens.dispatchEvent(new Event('change'));
  await m.flush();
  expect(m.sent.at(-1)).toEqual({ t: 'packup.set', args: { max_tokens: 2048 } });
  tokens.value = '0';
  tokens.dispatchEvent(new Event('input'));
  tokens.dispatchEvent(new Event('change'));
  expect(tokens.getAttribute('aria-invalid')).toBe('true');
});

it('keeps stale efforts visible and lets the user explicitly restore Provider default', async () => {
  const m = mount(state({ reasoning_effort: 'high', effort_stale: true, reasoning: { support: 'unsupported', listed: true, efforts: [] } }));
  const effort = m.body.querySelector('select')!;
  expect(effort.value).toBe('high');
  expect(effort.selectedOptions[0]!.disabled).toBe(true);
  expect(effort.disabled).toBe(false);
  expect(m.button('Test').disabled).toBe(true);
  expect(m.body.textContent).toContain('Checks are paused');
  effort.value = '';
  effort.dispatchEvent(new Event('change'));
  await m.flush();
  expect(m.sent.at(-1)).toEqual({ t: 'packup.set', args: { reasoning_effort: '' } });
});

it('offers no effort selector when the catalog describes reasoning without effort selection', () => {
  const m = mount(state({ reasoning: { support: 'supported', listed: true, efforts: [] } }));
  const effort = m.body.querySelector('select')!;
  expect(effort.disabled).toBe(true);
  expect([...effort.options].map((o) => o.value)).toEqual(['']);
});

it('separates gate-only positives from verified extractions and shows safe timing diagnostics', async () => {
  const m = mount(state(), { 'packup.test': () => ({ ok: true, data: {
    ok: false, threshold: .85, right: 1, total: 2, gate_right: 2, extractions: 1, verified: 0,
    model: 'example', reasoning_effort: 'high', max_tokens: 2048, timeout_ms: 1200,
    samples: [
      { text: 'Core prompt', core: true, expect: 'match', score: .9, extraction_tested: true, right: false, stage: 'timing', code: 'llm_timeout', classifier_ms: 20, extraction_ms: 1180, diag: { finish_reason: 'length', completion_tokens: 2048, reasoning_tokens: 2048 } },
      { text: 'Other positive', expect: 'match', score: .9, extraction_tested: false, right: true },
    ],
  } }) });
  m.button('Test').click();
  await m.flush();
  expect(m.body.textContent).toContain('0 of 1 attempted extractions verified');
  expect(m.body.textContent).toContain('Gate correct · extraction not tested');
  expect(m.body.textContent).toContain('Failed: timing');
  expect(m.body.textContent).toContain('Classifier 20 ms · extraction 1180 ms');
  expect(m.body.textContent).toContain('finish: length');
  expect(m.body.textContent).toContain('2,048 reasoning');
});
