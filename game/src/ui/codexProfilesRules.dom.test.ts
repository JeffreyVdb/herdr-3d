// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { CommandResult } from '../net/client';
import type { CodexProfile, CodexProfilesState, CodexRule } from '../net/protocol';
import { CodexProfilesBook } from '../world/codexProfiles';
import { codexProfilesSection } from './codexProfilesSection';
import { SettingsDialog } from './settings';

// #140: the Settings section's Auto rules and "May be used for anything", against a bridge that keeps them.

const profile = (key: string, o: Partial<CodexProfile> = {}): CodexProfile => ({
  key,
  name: key,
  path: `/home/u/.codex-${key}`,
  display: `~/.codex-${key}`,
  plan: '',
  signed_in: true,
  default: false,
  hidden: false,
  added: false,
  ...o,
});
const START: CodexProfilesState = {
  hire: true,
  auto: true,
  profiles: [profile('codex', { default: true, path: '/home/u/.codex', display: '~/.codex' }), profile('work', { name: 'Work' }), profile('old', { hidden: true })],
  rules: [{ match: 'github.com/acme/*', profile: 'work' }],
};

function mount(s: CodexProfilesState | null, refuse?: (args: Record<string, unknown>) => CommandResult | null) {
  document.body.replaceChildren();
  const book = new CodexProfilesBook();
  book.reset(s);
  const sent: Array<{ t: string; args: Record<string, unknown> }> = [];
  const dialog = new SettingsDialog(document.body);
  dialog.addSection(
    'codex-profiles',
    'Codex profiles',
    codexProfilesSection({
      book,
      send: ((t: string, args: Record<string, unknown>) => {
        sent.push({ t, args });
        const no = refuse?.(args);
        if (no) return Promise.resolve(no);
        const cur = book.state as CodexProfilesState;
        const profiles = cur.profiles.map((p) => (p.key !== args.key ? p : { ...p, ...(typeof args.anything === 'boolean' ? { anything: args.anything } : {}) }));
        const rules = Array.isArray(args.rules) ? (args.rules as CodexRule[]) : cur.rules;
        return Promise.resolve({ ok: true, data: { ...cur, profiles, rules } });
      }) as never,
    }),
    { store: 'bridge', group: 'workers' },
  );
  dialog.renderSections(); // #146: what the dialog's first open does
  const root = document.querySelector<HTMLElement>('[data-section="codex-profiles"]')!;
  const rules = () => [...root.querySelectorAll<HTMLElement>('.settings-cp-rule')];
  const match = (i: number) => root.querySelector<HTMLInputElement>(`[data-key="rule-match:${i}"]`)!;
  const pick = (i: number) => root.querySelector<HTMLSelectElement>(`[data-key="rule-profile:${i}"]`)!;
  const key = (k: string) => root.querySelector<HTMLButtonElement>(`[data-key="${k}"]`)!;
  const shown = () => rules().map((r) => `${r.querySelector('input')!.value} → ${(r.querySelector('select') as HTMLSelectElement).value}`);
  const type = (i: HTMLInputElement, v: string) => {
    i.value = v;
    i.dispatchEvent(new Event('input'));
  };
  const choose = (sel: HTMLSelectElement, v: string) => {
    sel.value = v;
    sel.dispatchEvent(new Event('change'));
  };
  const flush = () => new Promise((r) => setTimeout(r, 0));
  return { book, root, sent, rules, match, pick, key, shown, type, choose, flush };
}

describe('the Auto rules and “May be used for anything” (#140)', () => {
  it('are not there for a bridge without Auto', () => {
    const m = mount({ hire: true, profiles: START.profiles });
    expect(m.root.querySelector<HTMLElement>('.settings-cp-auto')!.hidden).toBe(true);
    expect(m.root.querySelector('.settings-cp-anything')).toBeNull();
  });

  it('“May be used for anything” is one change of one profile, sent at once, the default’s too', async () => {
    const m = mount(START);
    const box = (k: string) => m.root.querySelector<HTMLInputElement>(`[data-key="anything:${k}"]`)!;
    expect(['codex', 'work', 'old'].map((k) => box(k).checked)).toEqual([false, false, false]);
    expect(box('codex').closest('label')!.textContent).toBe('May be used for anything');
    box('codex').checked = true;
    box('codex').dispatchEvent(new Event('change'));
    await m.flush();
    expect(m.sent).toEqual([{ t: 'codex_profiles.set', args: { key: 'codex', anything: true } }]);
    expect(box('codex').checked).toBe(true);
    expect(m.root.querySelector('.settings-cp .settings-status')!.textContent).toBe('Auto may hire on codex when no rule matches.');
    expect(document.activeElement).toBe(box('codex'));
  });

  it('lists the rules in order; add, reorder and remove are a draft, saved whole in one change', async () => {
    const m = mount(START);
    expect(m.shown()).toEqual(['github.com/acme/* → work']);
    expect(m.key('rules-save').hidden).toBe(true);
    expect(m.key('rule-up:0').disabled).toBe(true);
    expect(m.key('rule-down:0').disabled).toBe(true);
    // The picker lists every profile, a hidden one marked.
    expect([...m.pick(0).options].map((o) => o.textContent)).toEqual(['codex', 'Work', 'old (hidden)']);

    m.key('rule-add').click();
    expect(document.activeElement).toBe(m.match(1));
    m.type(m.match(1), '~/src/mine');
    expect(m.key('rules-save').hidden).toBe(false);
    m.choose(m.pick(1), 'codex');
    m.key('rule-add').click();
    m.type(m.match(2), 'github.com/acme/widgets');
    m.choose(m.pick(2), 'codex');
    expect(m.shown()).toEqual(['github.com/acme/* → work', '~/src/mine → codex', 'github.com/acme/widgets → codex']);

    // The repo rule goes first: a move keeps the focus on the moved rule.
    m.key('rule-up:2').click();
    expect(document.activeElement).toBe(m.key('rule-up:1'));
    m.key('rule-up:1').click();
    expect(document.activeElement).toBe(m.key('rule-down:0'));
    m.key('rule-remove:2').click();
    expect(m.shown()).toEqual(['github.com/acme/widgets → codex', 'github.com/acme/* → work']);
    expect(m.sent).toEqual([]);

    m.key('rules-save').click();
    await m.flush();
    expect(m.sent).toEqual([
      { t: 'codex_profiles.set', args: { rules: [{ match: 'github.com/acme/widgets', profile: 'codex' }, { match: 'github.com/acme/*', profile: 'work' }] } },
    ]);
    expect(m.book.state?.rules).toHaveLength(2);
    expect(m.key('rules-save').hidden).toBe(true);
    expect(m.root.querySelector('.settings-cp-auto .settings-status')!.textContent).toBe('Saved 2 rules.');
  });

  it('a match the editor can tell is wrong is said under its row, before anything is sent', async () => {
    const m = mount(START);
    m.key('rule-add').click();
    m.type(m.match(1), 'acme/*');
    m.choose(m.pick(1), 'work');
    m.key('rules-save').click();
    await m.flush();
    expect(m.sent).toEqual([]);
    const hint = m.rules()[1]!.querySelector('.settings-field-error')!;
    expect(hint.textContent).toBe('Use github.com/<owner>/* or github.com/<owner>/<repo>, or a folder starting with / or ~/.');
    expect(m.match(1).getAttribute('aria-invalid')).toBe('true');
    expect(m.match(1).getAttribute('aria-describedby')).toBe(hint.id);
    expect(document.activeElement).toBe(m.match(1));
    // Typing clears it; an empty profile is the next thing said.
    m.type(m.match(1), 'github.com/acme/*');
    m.key('rule-add').click();
    m.type(m.match(2), '/srv/x');
    m.key('rules-save').click();
    await m.flush();
    expect(m.rules()[1]!.querySelector('.settings-field-error')!.textContent).toBe('Rule 1 already matches this.');
  });

  it('the bridge’s refusal goes under the row it names; Discard goes back to the saved rules', async () => {
    const m = mount(START, (a) => (Array.isArray(a.rules) ? { ok: false, code: 'bad_request', message: 'bad args: Rule 2: there is no Codex profile "gone".' } : null));
    m.key('rule-add').click();
    m.type(m.match(1), '/srv/x');
    m.choose(m.pick(1), 'work');
    m.key('rules-save').click();
    await m.flush();
    expect(m.sent).toHaveLength(1);
    expect(m.rules()[1]!.querySelector('.settings-field-error')!.textContent).toBe('There is no Codex profile "gone".');
    expect(document.activeElement).toBe(m.match(1));
    m.key('rules-discard').click();
    expect(m.shown()).toEqual(['github.com/acme/* → work']);
    expect(m.root.querySelector('.settings-field-error')).toBeNull();
  });

  it('a rule whose profile is hidden or gone says Auto passes it over', () => {
    const m = mount({ ...START, rules: [{ match: '/a', profile: 'old' }, { match: '/b', profile: 'nope' }] });
    expect(m.rules().map((r) => r.querySelector('.settings-field-hint')?.textContent)).toEqual([
      'old is hidden: Auto passes this rule over.',
      'nope is gone: Auto passes this rule over.',
    ]);
    expect(m.pick(1).value).toBe('nope');
    expect(m.pick(1).selectedOptions[0]!.textContent).toBe('nope (gone)');
  });

  it('with no rules, says so; typing in a rule keeps the caret while another change rebuilds the list', () => {
    const m = mount({ ...START, rules: [] });
    expect(m.root.querySelector<HTMLElement>('.settings-cp-rules-empty')!.hidden).toBe(false);
    m.key('rule-add').click();
    m.type(m.match(0), 'github.com/ac');
    m.match(0).setSelectionRange(5, 5);
    m.book.upsert({ ...START, rules: [] }); // another client's change: the draft stays
    expect(m.match(0).value).toBe('github.com/ac');
    expect(document.activeElement).toBe(m.match(0));
    expect(m.match(0).selectionStart).toBe(5);
  });
});
