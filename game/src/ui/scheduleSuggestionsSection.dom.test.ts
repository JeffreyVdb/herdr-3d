// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { CommandResult } from '../net/client';
import { ScheduleSuggestionsBook } from '../world/scheduleSuggest';
import { SCHEDULE_SUGGESTIONS_PRIVACY, scheduleSuggestionsSection } from './scheduleSuggestionsSection';

// #66: the "Schedule suggestions" section: off by default, no test gate, both models needed (each missing one named),
// the environment's switch read-only, the threshold, and the zone the bridge reads times in.

const state = (over: Record<string, unknown> = {}) => ({ enabled: false, threshold: 0.7, state: 'off', roles: { classifier: 'ready', llm: 'ready' }, env: [], ...over });

function mount(s: Record<string, unknown> | null, answers: Record<string, (args: Record<string, unknown>) => CommandResult> = {}) {
  document.body.replaceChildren();
  const book = new ScheduleSuggestionsBook();
  book.reset(s);
  const sent: Array<{ t: string; args: Record<string, unknown> }> = [];
  let shownAi = 0;
  const body = document.createElement('div');
  document.body.append(body);
  const handle = scheduleSuggestionsSection({
    book,
    send: ((t: string, args: Record<string, unknown>) => {
      sent.push({ t, args });
      return Promise.resolve((answers[t] ?? (() => ({ ok: true, data: {} })))(args));
    }) as never,
    showAi: () => shownAi++,
  })(body);
  handle.open?.();
  const box = () => body.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  const hint = () => document.getElementById(box().getAttribute('aria-describedby')!.split(' ')[1]!)!.textContent;
  const flush = () => new Promise((r) => setTimeout(r, 0));
  return { book, body, sent, box, hint, flush, shownAi: () => shownAi };
}

describe('the schedule suggestions section (#66)', () => {
  it('says the bridge has none when it sent no state', () => {
    const m = mount(null);
    expect(m.body.textContent).toContain('no schedule suggestions');
    expect(m.body.querySelector<HTMLElement>('.settings-fu')!.hidden).toBe(true);
  });

  it('is off by default, can be switched on without a test once both models are ready, and says nothing is sent', async () => {
    const m = mount(state());
    expect(m.box().checked).toBe(false);
    expect(m.box().disabled).toBe(false);
    expect(m.hint()).toBe('Off: nothing is sent.');
    expect(m.body.textContent).not.toContain('Test');
    const privacy = m.body.querySelector('.settings-fu-privacy')!;
    expect(privacy.textContent).toBe(SCHEDULE_SUGGESTIONS_PRIVACY);
    expect(privacy.compareDocumentPosition(m.box()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    m.box().click();
    await m.flush();
    expect(m.sent).toEqual([{ t: 'schedule_suggestions.set', args: { enabled: true } }]);
    expect(m.body.querySelector('.settings-status')!.textContent).toContain('On.');
  });

  it('while a model is not ready, the switch says which and why, and links to the AI integration', () => {
    const m = mount(state({ missing: ['llm'], roles: { classifier: 'ready', llm: 'off' } }));
    expect(m.box().disabled).toBe(true);
    expect(m.hint()).toContain('Unavailable until both models are ready');
    expect(m.hint()).toContain('not set up');
    const badges = [...m.body.querySelectorAll('.settings-fu-role .settings-badge')].map((b) => b.textContent);
    expect(badges).toEqual(['Ready', 'Not set up']);
    const link = [...m.body.querySelectorAll('button')].find((b) => b.textContent === 'Set up in AI integration')!;
    expect(link.hidden).toBe(false);
    link.click();
    expect(m.shownAi()).toBe(1);
    // On but incomplete: paused, and it can still be switched off.
    m.book.upsert(state({ enabled: true, state: 'incomplete', missing: ['classifier'], roles: { classifier: 'invalid', llm: 'ready' } }));
    expect(m.box().checked).toBe(true);
    expect(m.box().disabled).toBe(false);
    expect(m.hint()).toContain('On, but paused');
    expect(m.hint()).toContain('paused');
  });

  it('the environment’s switch is read-only and named', () => {
    const m = mount(state({ enabled: true, state: 'ready', env: ['enabled'] }));
    expect(m.box().checked).toBe(true);
    expect(m.box().disabled).toBe(true);
    expect(m.hint()).toContain('HERDR_WORLD_SCHEDULE_SUGGESTIONS_ENABLED');
  });

  it('the threshold is bounded and saved; a refusal is said plainly', async () => {
    const m = mount(state(), { 'schedule_suggestions.set': (a) => (a.enabled ? { ok: false, code: 'incomplete', message: 'x' } : { ok: true, data: {} }) });
    const th = m.body.querySelector<HTMLInputElement>('input[type="number"]')!;
    expect(th.value).toBe('0.70');
    th.value = '1.5';
    th.dispatchEvent(new Event('input'));
    th.dispatchEvent(new Event('change'));
    expect(th.getAttribute('aria-invalid')).toBe('true');
    expect(m.sent).toEqual([]);
    th.value = '0.8';
    th.dispatchEvent(new Event('input'));
    th.dispatchEvent(new Event('change'));
    await m.flush();
    expect(m.sent).toEqual([{ t: 'schedule_suggestions.set', args: { threshold: 0.8 } }]);
    m.box().click();
    await m.flush();
    expect(m.body.querySelector('.settings-status')!.textContent).toBe('Both models must be ready first: set them up under AI integration.');
  });

  it('says which zone times are read in', () => {
    const m = mount(state());
    expect(m.body.querySelector('.settings-ss-zone')!.textContent).toContain('read as UTC');
    m.book.upsert(state({ zone: 'Europe/Brussels' }));
    expect(m.body.querySelector('.settings-ss-zone')!.textContent).toContain('read in Europe/Brussels');
  });
});
