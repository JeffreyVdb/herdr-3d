// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import type { Limits } from '../net/protocol';
import { CodexProfilesBook } from '../world/codexProfiles';
import { LimitBook } from '../world/limits';
import { LimitsWidget, planLimits } from './limits';
import { LimitsPrefs } from './limitsPrefs';

// #138: one Codex row per Codex profile on the meter; with one profile it is the meter it was before profiles.

const NOW = Date.UTC(2026, 9, 21, 9, 0);
const MIN = 60_000;

const claude: Limits = { provider: 'claude', plan: 'team', windows: [{ label: '5h', pct: 11, resets_at: NOW + 120 * MIN, window_mins: 300 }], at: NOW, stale: false, source: 'probe' };
const codex = (over: Partial<Limits> = {}): Limits => ({
  provider: 'codex',
  plan: 'prolite',
  windows: [{ label: 'week', pct: 19, resets_at: NOW + 3 * 24 * 60 * MIN, window_mins: 10080 }],
  at: NOW,
  stale: false,
  source: 'probe',
  ...over,
});
const own = { key: 'codex', name: 'codex', plan: 'prolite', default: true };
const work = { key: 'work', name: 'work', plan: 'team', default: false };

afterEach(() => {
  document.body.innerHTML = '';
  localStorage.clear();
});

function mount(readings: Limits[], open = true) {
  const book = new LimitBook();
  book.reset(readings);
  const parent = document.createElement('div');
  document.body.append(parent);
  const prefs = new LimitsPrefs();
  prefs.open = open;
  const w = new LimitsWidget(parent, book, { now: () => NOW, refresh: async () => ({ ok: true }) as never, toast: () => undefined }, prefs);
  return { w, book, root: w.root };
}

describe('the plan-limits meter with Codex profiles (#138)', () => {
  it('shows one Codex row per profile, named, the default marked and first, each with its own numbers and stale marker', () => {
    const stale = codex({ plan: 'team', account: work, at: NOW - 50 * MIN, stale: true, error: 'failed', windows: [{ label: '5h', pct: 72, resets_at: NOW + 30 * MIN, window_mins: 300 }] });
    const { w, root } = mount([stale, codex({ account: own }), claude]);
    const s = w.summary();
    expect(s.lines.map((l) => [l.provider, l.account, l.stale])).toEqual([
      ['claude', undefined, false],
      ['codex', 'codex', false],
      ['codex', 'work', true],
    ]);
    expect(s.lines[1]!.windows).toEqual([{ label: 'week', pct: '19%', sev: 'ok' }]);
    expect(s.lines[2]!.windows).toEqual([{ label: '5h', pct: '72%', sev: 'warn' }]);
    const lines = [...root.querySelectorAll<HTMLElement>('.lm-lines .lm-line')];
    expect(lines.map((l) => l.querySelector('.lm-tape')?.textContent)).toEqual(['Claude', 'Codex', 'Codex']);
    expect(lines.map((l) => l.querySelector('.lm-acct-name')?.textContent ?? null)).toEqual([null, 'codex', 'work']);
    expect(lines[1]!.querySelector('.lm-acct-def')?.textContent).toBe('default');
    expect(lines[2]!.querySelector('.lm-acct-def')).toBeNull();
    expect(lines[2]!.querySelector('.lm-asof')?.textContent).toMatch(/^as of \d\d:\d\d$/);
    expect(lines[1]!.querySelector('.lm-asof')).toBeNull();
    // The panel: a section each, the work one with its own read note.
    const secs = [...root.querySelectorAll<HTMLElement>('.lm-sec')];
    expect(secs.map((x) => x.dataset.account ?? null)).toEqual([null, 'codex', 'work']);
    expect(secs[1]!.querySelector('header .lm-acct-def')?.textContent).toBe('default');
    expect(secs[2]!.dataset.stale).toBe('true');
    expect(secs[2]!.querySelector('.lm-read')?.textContent).toMatch(/^Last read \d\d:\d\d \(50 min ago\)$/);
    expect(root.querySelector('.lm-strip')?.getAttribute('aria-label')).toContain('Codex work team: 5h 72% (old reading)');
    expect(root.querySelector('.lm-strip')?.getAttribute('aria-label')).toContain('Codex codex (default) prolite: week 19%');
  });

  it('with one profile looks exactly as before profiles: no name, no marker', () => {
    const before = mount([claude, codex()]).root.innerHTML;
    document.body.innerHTML = '';
    const after = mount([claude, codex({ account: own })]).root.innerHTML;
    expect(after).toBe(before);
    expect(after).not.toContain('lm-acct');
    expect(after).not.toContain('data-account');
  });

  it('a hidden profile leaves the meter when the book keeps only the visible ones', () => {
    const { w, book } = mount([claude, codex({ account: own }), codex({ account: work })]);
    expect(w.summary().lines).toHaveLength(3);
    book.retainProfiles(new Set(['codex']));
    w.update();
    expect(w.summary().lines.map((l) => [l.provider, l.account])).toEqual([
      ['claude', undefined],
      ['codex', undefined],
    ]);
  });

  it('the hire and run dialogs show the default profile only, unnamed', () => {
    const book = new LimitBook();
    book.reset([claude, codex({ account: work, windows: [{ label: '5h', pct: 99, resets_at: 0 }] }), codex({ account: own })]);
    const inline = planLimits(book, ['codex'], NOW)!;
    const lines = [...inline.querySelectorAll<HTMLElement>('.lm-line')];
    expect(lines).toHaveLength(1);
    expect(lines[0]!.querySelector('.lm-acct')).toBeNull();
    expect(lines[0]!.textContent).toContain('19%');
    expect(inline.dataset.hot).toBe('false');
  });
});

describe('the meter’s drift mark (#167)', () => {
  const profiles = (share: boolean, drift: boolean) => {
    const b = new CodexProfilesBook();
    b.reset({
      profiles: [
        { key: 'codex', name: 'codex', path: '/u/.codex', display: '~/.codex', plan: '', signed_in: true, default: true, hidden: false, added: false },
        {
          key: 'work',
          name: 'work',
          path: '/u/.codex-work',
          display: '~/.codex-work',
          plan: '',
          signed_in: true,
          default: false,
          hidden: false,
          added: false,
          share: true,
          ...(drift ? { drift: [{ kind: 'hooks_missing', name: 'hooks.json', text: 'hooks.json is missing' }] } : {}),
        },
      ],
      ...(share ? { share: true } : {}),
    });
    return b;
  };
  const meter = (b: CodexProfilesBook) => {
    const book = new LimitBook();
    book.reset([codex({ account: own }), codex({ account: work, plan: 'team' })]);
    const parent = document.createElement('div');
    document.body.append(parent);
    const prefs = new LimitsPrefs();
    prefs.open = true;
    return new LimitsWidget(parent, book, { now: () => NOW, refresh: async () => ({ ok: true }) as never, toast: () => undefined }, prefs, b).root;
  };

  it('marks a drifted profile’s row and says what and where to fix it; follows the list as it changes', () => {
    const b = profiles(true, true);
    const root = meter(b);
    const line = root.querySelector<HTMLElement>('.lm-lines .lm-line[data-account="work"]')!;
    const tag = line.querySelector('[data-hook="drift-badge"]')!;
    expect(tag.textContent).toBe('drifted');
    expect(tag.getAttribute('title')).toBe('work’s shared setup differs from codex’s: hooks.json is missing. Fix it in Settings → Codex profiles.');
    expect(root.querySelector('.lm-lines .lm-line[data-account="codex"] [data-hook="drift-badge"]')).toBeNull();
    expect(root.querySelector('.lm-sec[data-account="work"] [data-hook="drift"]')?.textContent).toBe(tag.getAttribute('title'));
    b.upsert({ ...b.state!, profiles: b.state!.profiles.map((p) => ({ ...p, drift: undefined })) });
    expect(root.querySelector('[data-hook="drift-badge"]')).toBeNull();
  });

  it('shows nothing from a bridge without sharing, or without drift', () => {
    expect(meter(profiles(false, true)).querySelector('[data-hook="drift-badge"]')).toBeNull();
    expect(meter(profiles(true, false)).querySelector('[data-hook="drift-badge"]')).toBeNull();
  });
});
