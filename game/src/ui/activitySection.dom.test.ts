// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { CommandResult } from '../net/client';
import { ActivitySettingsBook } from '../world/activitySettings';
import { ACTIVITY_PRIVACY, activitySection } from './activitySection';
import { SettingsDialog } from './settings';

const state = (over: Record<string, unknown> = {}) => ({
  model_enabled: false,
  threshold: 0.6,
  margin: 0.2,
  daily_cap: 2000,
  calls_today: 0,
  cache_size: 0,
  state: 'off',
  classifier: 'ready',
  env: [],
  ...over,
});

function mount(s: Record<string, unknown> | null, answers: Record<string, (args: Record<string, unknown>) => CommandResult> = {}) {
  document.body.replaceChildren();
  const book = new ActivitySettingsBook();
  book.reset(s);
  const sent: Array<{ t: string; args: Record<string, unknown> }> = [];
  let shownAi = 0;
  const dialog = new SettingsDialog(document.body);
  dialog.addSection('ai', 'AI integration', (body) => void body.append('models'), { store: 'bridge', group: 'ai' });
  dialog.addSection(
    'activity',
    'Classify unknown commands',
    activitySection({
      book,
      send: ((t: string, args: Record<string, unknown>) => {
        sent.push({ t, args });
        return Promise.resolve((answers[t] ?? (() => ({ ok: true, data: book.state })))(args));
      }) as never,
      showAi: () => shownAi++,
    }),
    { store: 'bridge', group: 'ai' },
  );
  dialog.renderSections(); // #146: what the dialog's first open does
  const root = document.querySelector<HTMLElement>('[data-section="activity"]')!;
  const box = () => root.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  const field = (label: string) => {
    const l = [...root.querySelectorAll('label')].find((x) => x.textContent === label)!;
    return root.querySelector<HTMLInputElement>(`#${l.htmlFor}`)!;
  };
  const text = (sel: string) => root.querySelector(sel)?.textContent ?? '';
  const flush = () => new Promise((r) => setTimeout(r, 0));
  return { book, dialog, root, sent, box, field, text, flush, shownAi: () => shownAi };
}

describe('the “Classify unknown commands” section (#98)', () => {
  it('is not there at all while the bridge sends no state, and shows once it does', () => {
    const m = mount(null);
    // #49: out of the navigator, not just a section that is not the one showing (AI integration is).
    const tab = document.querySelector<HTMLElement>('[role="tab"][data-tab="activity"]')!;
    expect(m.root.hidden).toBe(true);
    expect(tab.hidden).toBe(true);
    m.book.upsert(state());
    expect(tab.hidden).toBe(false);
    m.dialog.reveal('activity');
    expect(m.root.hidden).toBe(false);
    expect(m.dialog.sectionIds).toEqual(['ai', 'activity']);
  });

  it('puts the privacy note above the switch; off says it sends nothing', () => {
    const m = mount(state());
    const privacy = m.root.querySelector('.settings-act-privacy')!;
    expect(privacy.textContent).toBe(ACTIVITY_PRIVACY);
    expect(privacy.textContent).toContain('TypeSafe');
    expect(privacy.textContent).toContain('never sent');
    expect(privacy.compareDocumentPosition(m.box()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(m.box().getAttribute('aria-describedby')).toContain(privacy.id);
    expect(m.box().checked).toBe(false);
    expect(m.box().disabled).toBe(false);
    expect(m.text('.settings-act-state .settings-badge')).toBe('Off');
    expect(m.text('.settings-act-state-text')).toBe('Rules only. Nothing is sent.');
    expect(m.root.querySelector<HTMLElement>('.settings-act-link')!.hidden).toBe(true);
  });

  it('switching on sends activity.set; with the classifier ready it says it classifies', async () => {
    const m = mount(state(), {
      'activity.set': (args) => {
        m.book.upsert(state({ ...args, state: 'ready' }));
        return { ok: true, data: m.book.state };
      },
    });
    m.box().checked = true;
    m.box().dispatchEvent(new Event('change'));
    expect(m.box().disabled).toBe(true); // busy
    await m.flush();
    expect(m.sent).toEqual([{ t: 'activity.set', args: { model_enabled: true } }]);
    expect(m.box().checked).toBe(true);
    expect(m.text('.settings-act-state .settings-badge')).toBe('Ready');
    expect(m.text('.settings-act-state-text')).toContain('classified');
    expect(m.text('.settings-status')).toBe('On. Unknown commands are classified from now on.');
  });

  it('on with the classifier not ready: incomplete, its state, and the way to the AI section', () => {
    const m = mount(state({ model_enabled: true, state: 'incomplete', classifier: 'invalid' }));
    expect(m.text('.settings-act-state .settings-badge')).toBe('Waiting');
    expect(m.text('.settings-act-state-text')).toBe('Needs the classification model, which is paused. Nothing is sent until it is ready.');
    expect(m.root.querySelector<HTMLElement>('.settings-act-state')!.dataset.classifier).toBe('invalid');
    const link = m.root.querySelector<HTMLButtonElement>('.settings-act-link')!;
    expect(link.hidden).toBe(false);
    expect(link.textContent).toBe('Set up in AI integration');
    link.click();
    expect(m.shownAi()).toBe(1);
    m.book.upsert(state({ model_enabled: true, state: 'incomplete', classifier: 'off' }));
    expect(m.text('.settings-act-state-text')).toContain('which is not set up.');
  });

  it('capped: the daily cap is reached, rules only today; the ledger shows calls of the cap and the cache', () => {
    const m = mount(state({ model_enabled: true, state: 'capped', calls_today: 2000, cache_size: 1234 }));
    expect(m.text('.settings-act-state .settings-badge')).toBe('Capped');
    expect(m.text('.settings-act-state-text')).toBe('Daily cap reached, rules only today.');
    const figures = [...m.root.querySelectorAll('.settings-act-figure')].map((x) => x.textContent);
    expect(figures).toEqual(['2,000 of 2,000', '1,234']);
    expect(m.root.querySelector<HTMLElement>('.settings-act-bar')!.dataset.level).toBe('full');
    m.book.upsert(state({ model_enabled: true, state: 'ready', calls_today: 1700, daily_cap: 2000 }));
    expect(m.root.querySelector<HTMLElement>('.settings-act-bar')!.dataset.level).toBe('near');
    expect(m.root.querySelector<HTMLElement>('.settings-act-fill')!.style.transform).toBe('scaleX(0.850)');
  });

  it('a switch set by the bridge environment is read-only and says so', () => {
    const m = mount(state({ model_enabled: true, state: 'ready', env: ['model_enabled'] }));
    expect(m.box().checked).toBe(true);
    expect(m.box().disabled).toBe(true);
    const hint = m.root.querySelector<HTMLElement>('.settings-switch + .settings-field-hint')!;
    expect(hint.hidden).toBe(false);
    expect(hint.textContent).toContain('HERDR_WORLD_ACTIVITY_MODEL');
    // The numbers stay editable.
    expect(m.field('Minimum confidence').disabled).toBe(false);
  });

  it('says under each number what it does, and what the cached classifications are', () => {
    const m = mount(state());
    const hint = (label: string) => document.getElementById(m.field(label).getAttribute('aria-describedby')!)!.textContent;
    expect(hint('Minimum confidence')).toBe('Use the model’s label only when its score reaches this (0.05–0.99). Higher accepts fewer labels. Default 0.60.');
    expect(hint('Minimum score gap')).toBe('The winning label must beat the next-best by at least this (0.00–0.99): 0.70 against 0.50 meets 0.20. Otherwise the monitor says Working. Default 0.20.');
    expect(hint('Daily cap')).toBe('Most classification calls a day; then rules only until tomorrow. Default 2,000.');
    const terms = [...m.root.querySelectorAll('.settings-act-ledger dt')].map((x) => x.textContent);
    expect(terms).toEqual(['Calls today', 'Cached classifications']);
    expect(m.text('.settings-act-ledger dt:last-of-type ~ .settings-act-note')).toBe('Saved answers for distinct normalised commands; a repeat reuses one without a model call.');
  });

  it('validates the minimum confidence, minimum score gap and daily cap before sending, and saves each on its own', async () => {
    const m = mount(state());
    expect([m.field('Minimum confidence').value, m.field('Minimum score gap').value, m.field('Daily cap').value]).toEqual(['0.60', '0.20', '2000']);
    const edit = (label: string, v: string) => {
      const input = m.field(label);
      input.value = v;
      input.dispatchEvent(new Event('input'));
      input.dispatchEvent(new Event('change'));
      return input;
    };
    expect(edit('Minimum confidence', '1.4').getAttribute('aria-invalid')).toBe('true');
    expect(m.text('.settings-status')).toBe('The minimum confidence must be between 0.05 and 0.99.');
    expect(edit('Minimum score gap', '-0.1').getAttribute('aria-invalid')).toBe('true');
    expect(m.text('.settings-status')).toBe('The minimum score gap must be between 0.00 and 0.99.');
    expect(edit('Daily cap', '12.5').getAttribute('aria-invalid')).toBe('true');
    expect(m.text('.settings-status')).toContain('whole number');
    expect(edit('Daily cap', '').getAttribute('aria-invalid')).toBe('true');
    expect(m.sent).toEqual([]);
    edit('Minimum confidence', '0.654');
    await m.flush();
    expect(m.text('.settings-status')).toBe('Minimum confidence saved: 0.65.');
    edit('Minimum score gap', '0.25');
    await m.flush();
    edit('Daily cap', '500');
    await m.flush();
    expect(m.sent).toEqual([
      { t: 'activity.set', args: { threshold: 0.65 } },
      { t: 'activity.set', args: { margin: 0.25 } },
      { t: 'activity.set', args: { daily_cap: 500 } },
    ]);
    expect(m.text('.settings-status')).toBe('Daily cap saved: 500.');
  });

  it('says what the bridge refused', async () => {
    const m = mount(state({ env: [] }), { 'activity.set': () => ({ ok: false, code: 'env_locked', message: 'model_enabled is set by the environment' }) });
    m.box().checked = true;
    m.box().dispatchEvent(new Event('change'));
    await m.flush();
    expect(m.box().checked).toBe(false);
    expect(m.root.querySelector('.settings-status')!.classList.contains('settings-field-error')).toBe(true);
    expect(m.text('.settings-status')).toContain('HERDR_WORLD_ACTIVITY_MODEL');
  });

  it('reads the state again when the window opens (the calls and the cache move)', async () => {
    const m = mount(state({ calls_today: 3 }), { 'activity.get': () => ({ ok: true, data: state({ calls_today: 9, cache_size: 4 }) }) });
    const d = document.querySelector('dialog')!;
    d.showModal = () => void d.setAttribute('open', '');
    m.dialog.open();
    await m.flush();
    expect(m.sent).toEqual([{ t: 'activity.get', args: {} }]);
    expect([...m.root.querySelectorAll('.settings-act-figure')].map((x) => x.textContent)).toEqual(['9 of 2,000', '4']);
  });
});
