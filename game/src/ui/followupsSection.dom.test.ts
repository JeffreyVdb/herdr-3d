// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { CommandResult } from '../net/client';
import { FollowupsBook } from '../world/followup';
import { FOLLOWUPS_PRIVACY, followupsSection } from './followupsSection';

const state = (over: Record<string, unknown> = {}) => ({ enabled: false, threshold: 0.7, state: 'off', roles: { classifier: 'ready', llm: 'ready' }, env: [], tested: false, ...over });

function mount(s: Record<string, unknown> | null, answers: Record<string, (args: Record<string, unknown>) => CommandResult> = {}) {
  document.body.replaceChildren();
  const book = new FollowupsBook();
  book.reset(s);
  const sent: Array<{ t: string; args: Record<string, unknown> }> = [];
  let shownAi = 0;
  const body = document.createElement('div');
  document.body.append(body);
  const handle = followupsSection({
    book,
    send: ((t: string, args: Record<string, unknown>) => {
      sent.push({ t, args });
      return Promise.resolve((answers[t] ?? (() => ({ ok: true, data: {} })))(args));
    }) as never,
    showAi: () => shownAi++,
  })(body);
  handle.open?.();
  const box = () => body.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  const flush = () => new Promise((r) => setTimeout(r, 0));
  return { book, body, sent, box, flush, shownAi: () => shownAi };
}

describe('the follow-up questions section (#90)', () => {
  it('says the bridge has none when it sent no state', () => {
    const m = mount(null);
    expect(m.body.textContent).toContain('no follow-up questions');
    expect(m.body.querySelector<HTMLElement>('.settings-fu')!.hidden).toBe(true);
  });

  it('puts the privacy note above the switch, which stays off until a test passed', () => {
    const m = mount(state());
    const privacy = m.body.querySelector('.settings-fu-privacy')!;
    expect(privacy.textContent).toBe(FOLLOWUPS_PRIVACY);
    expect(privacy.compareDocumentPosition(m.box()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(m.box().disabled).toBe(true);
    expect(m.body.textContent).toContain('Run the test below first');
    m.book.upsert(state({ tested: true }));
    expect(m.box().disabled).toBe(false);
  });

  it('shows each model’s state and links to the AI integration while one is not ready', () => {
    const m = mount(state({ missing: ['llm'], roles: { classifier: 'ready', llm: 'invalid' } }));
    const badges = [...m.body.querySelectorAll('.settings-fu-role .settings-badge')].map((b) => b.textContent);
    expect(badges).toEqual(['Ready', 'Paused']);
    const link = [...m.body.querySelectorAll('button')].find((b) => b.textContent === 'Set up in AI integration')!;
    expect(link.hidden).toBe(false);
    link.click();
    expect(m.shownAi()).toBe(1);
    expect(m.box().disabled).toBe(true);
    expect([...m.body.querySelectorAll('button')].find((b) => b.textContent === 'Test')!.disabled).toBe(true);
  });

  it('Test shows both samples’ scores and the questions; switching on sends followups.set', async () => {
    const m = mount(state(), {
      'followups.test': () => ({
        ok: true,
        data: {
          ok: true,
          threshold: 0.7,
          latency_ms: 2000,
          samples: [
            { name: 'questions', expect: 'flag', score: 0.96, flagged: true, source: 'model', questions: [{ id: 'q1', question: 'Ship it?', kind: 'yes_no' }] },
            { name: 'done', expect: 'skip', score: 0.02, flagged: false },
          ],
        },
      }),
    });
    [...m.body.querySelectorAll('button')].find((b) => b.textContent === 'Test')!.click();
    await m.flush();
    expect(m.body.querySelector('.settings-fu-samples')!.textContent).toContain('0.96');
    expect(m.body.querySelector('.settings-fu-samples')!.textContent).toContain('0.02');
    expect(m.body.querySelector('.settings-fu-questions')!.textContent).toContain('Ship it?');
    expect(m.body.textContent).toContain('Test passed');
    m.book.upsert(state({ tested: true }));
    m.box().checked = true;
    m.box().dispatchEvent(new Event('change'));
    await m.flush();
    expect(m.sent.at(-1)).toEqual({ t: 'followups.set', args: { enabled: true } });
  });

  it('the environment’s switch is read-only', () => {
    const m = mount(state({ enabled: true, state: 'ready', env: ['enabled'] }));
    expect(m.box().checked).toBe(true);
    expect(m.box().disabled).toBe(true);
    expect(m.body.textContent).toContain('HERDR_WORLD_FOLLOWUPS_ENABLED');
  });

  it('commits the threshold on change, refusing what is out of range', async () => {
    const m = mount(state());
    const th = m.body.querySelector<HTMLInputElement>('input[type="number"]')!;
    expect(th.value).toBe('0.70');
    th.value = '1.5';
    th.dispatchEvent(new Event('input'));
    th.dispatchEvent(new Event('change'));
    expect(m.sent).toHaveLength(0);
    expect(th.getAttribute('aria-invalid')).toBe('true');
    th.value = '0.8';
    th.dispatchEvent(new Event('input'));
    th.dispatchEvent(new Event('change'));
    await m.flush();
    expect(m.sent).toEqual([{ t: 'followups.set', args: { threshold: 0.8 } }]);
  });
});
