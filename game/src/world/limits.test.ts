import { describe, expect, it } from 'vitest';
import type { Limits } from '../net/protocol';
import { isWorldEvent } from '../net/protocol';
import { harnessViews, LimitBook, limitsOf, limitsView, providerView, readText, resetText, severity, STALE_MS, warningOf } from './limits';
import { WorldStore } from './store';

const NOW = Date.UTC(2026, 8, 29, 17, 0); // Tue 29 Sep 2026, 17:00 UTC
const claude = (over: Partial<Limits> = {}): Limits => ({
  provider: 'claude',
  plan: 'team',
  windows: [
    { label: '5h', pct: 11, resets_at: NOW + 3 * 3600_000, window_mins: 300 },
    { label: 'week', pct: 61.5, resets_at: Date.UTC(2026, 9, 1, 22, 0), window_mins: 10080 },
    { label: 'week', model: 'Fable', pct: 3, resets_at: 0, window_mins: 10080 },
  ],
  at: NOW - 30_000,
  stale: false,
  source: 'probe',
  ...over,
});
const codex = (over: Partial<Limits> = {}): Limits => ({
  provider: 'codex',
  plan: 'prolite',
  windows: [{ label: 'week', pct: 19, resets_at: Date.UTC(2026, 9, 2, 8, 17), window_mins: 10080 }],
  at: NOW - 30_000,
  stale: false,
  source: 'probe',
  credits: { has_credits: true, unlimited: false, balance: '42.5' },
  ...over,
});

describe('colours', () => {
  it('turn amber at 60 % and red at 85 %', () => {
    expect([0, 59.9, 60, 84.9, 85, 100].map(severity)).toEqual(['ok', 'ok', 'warn', 'warn', 'high', 'high']);
  });

  it('follow each window and the provider’s worst', () => {
    const v = providerView(claude({ windows: [{ label: '5h', pct: 59, resets_at: 0 }, { label: 'week', pct: 85, resets_at: 0 }] }), NOW);
    expect(v.windows.map((w) => [w.label, w.severity])).toEqual([['5h', 'ok'], ['week', 'high']]);
    expect(v.worst).toBe(85);
    expect(v.worstSeverity).toBe('high');
    const edge = (pct: number) => providerView(claude({ windows: [{ label: '5h', pct, resets_at: 0 }] }), NOW).windows[0]!.severity;
    expect([edge(59), edge(60), edge(84), edge(85)]).toEqual(['ok', 'warn', 'warn', 'high']);
  });

  it('keep model weeks apart from the plan’s own windows', () => {
    const v = providerView(claude(), NOW);
    expect(v.windows.map((w) => w.label)).toEqual(['5h', 'week']);
    expect(v.models.map((w) => [w.model, w.pctText])).toEqual([['Fable', '3%']]);
    expect(v.worst).toBe(61.5);
  });
});

describe('stale readings', () => {
  it('are dimmed once the bridge stops sending, with the time they are as of', () => {
    const l = claude();
    expect(providerView(l, NOW).stale).toBe(false);
    expect(providerView(l, NOW).asOf).toBeNull();
    expect(providerView(l, l.at + STALE_MS).stale).toBe(false); // exactly 10 min
    const later = providerView(l, l.at + STALE_MS + 1000, 'UTC');
    expect(later.stale).toBe(true);
    expect(later.asOf).toBe('as of 16:59');
    expect(later.readNote).toBe('Last read 16:59 (10 min ago)');
  });

  it('are dimmed when the bridge says so (a transcript, a failed read)', () => {
    const t = providerView(codex({ stale: true, source: 'transcript', error: 'failed', at: NOW - 3600_000 }), NOW, 'UTC');
    expect(t.stale).toBe(true);
    expect(t.asOf).toBe('as of 16:00');
    expect(t.readNote).toBe('As of 16:00, from the last Codex session log');
    expect(t.problem).toBe('Could not be read.');
    expect(providerView(claude({ stale: true }), NOW).stale).toBe(true);
    expect(providerView(claude({ windows: [], error: 'no_plan' }), NOW).problem).toMatch(/^No plan limits/);
  });
});

describe('reached', () => {
  it('when Codex says so or a window is full', () => {
    expect(providerView(codex({ reached: 'rate_limit_reached' }), NOW).reached).toBe(true);
    expect(providerView(claude({ windows: [{ label: '5h', pct: 100, resets_at: 0 }] }), NOW).reached).toBe(true);
    expect(providerView(claude(), NOW).reached).toBe(false);
  });
});

describe('times', () => {
  it('show resets in the given zone: today by the clock, this week by weekday, later by date', () => {
    expect(resetText(NOW + 3 * 3600_000, NOW, 'UTC')).toBe('20:00');
    expect(resetText(NOW + 3 * 3600_000, NOW, 'Europe/Brussels')).toBe('22:00');
    expect(resetText(Date.UTC(2026, 9, 1, 22, 0), NOW, 'UTC')).toBe('Thu 22:00');
    expect(resetText(Date.UTC(2026, 9, 20, 9, 5), NOW, 'UTC')).toBe('20 Oct 09:05');
    // 23:30 UTC is already tomorrow in Brussels.
    expect(resetText(Date.UTC(2026, 8, 29, 23, 30), NOW, 'Europe/Brussels')).toBe('Wed 01:30');
    expect(resetText(0, NOW, 'UTC')).toBe('');
    expect(readText(NOW - 26 * 3600_000, NOW, 'UTC')).toBe('Mon 15:00');
  });
});

describe('warnings for the dialogs', () => {
  const book = new LimitBook();
  book.reset([claude({ windows: [{ label: '5h', pct: 40, resets_at: 0 }, { label: 'week', pct: 96, resets_at: Date.UTC(2026, 9, 1, 22, 0) }] }), codex()]);

  it('warn from 85 % with the window and its reset', () => {
    const [c, x] = limitsView(book, NOW, 'UTC');
    expect(warningOf(c!)).toBe('Claude week limit is at 96%, resets Thu 22:00.');
    expect(warningOf(x!)).toBe('');
    const at85 = providerView(codex({ windows: [{ label: 'week', pct: 85, resets_at: 0 }] }), NOW);
    expect(warningOf(at85)).toBe('Codex week limit is at 85%.');
    expect(warningOf(providerView(codex({ windows: [{ label: 'week', pct: 84, resets_at: 0 }] }), NOW))).toBe('');
  });

  it('say so when a limit is reached', () => {
    expect(warningOf(providerView(codex({ reached: 'rate_limit_reached', windows: [{ label: '5h', pct: 100, resets_at: NOW + 3600_000 }] }), NOW, 'UTC'))).toBe('Codex has used up its 5h limit, resets 18:00.');
    expect(warningOf(providerView(codex({ reached: 'x' }), NOW))).toBe('Codex has reached a limit.');
  });

  it('count the chosen model’s own window: week 61 %, its week 96 %', () => {
    const b = new LimitBook();
    b.reset([
      claude({
        windows: [
          { label: 'week', pct: 61, resets_at: 0 },
          { label: 'week', model: 'Opus', pct: 96, resets_at: Date.UTC(2026, 9, 1, 22, 0) },
          { label: 'week', model: 'Fable', pct: 3, resets_at: 0 },
        ],
      }),
    ]);
    const opus = harnessViews(b, [{ harness: 'claude', model: 'claude-opus-5-5' }], NOW, 'UTC')[0]!;
    expect(opus.models.map((w) => [w.model, w.pctText])).toEqual([['Opus', '96%']]);
    expect(warningOf(opus)).toBe('Claude week · Opus limit is at 96%, resets Thu 22:00.');
    // Another model is not warned about Opus's window.
    const fable = harnessViews(b, [{ harness: 'claude', model: 'claude-fable-5-1' }], NOW, 'UTC')[0]!;
    expect(fable.models.map((w) => w.model)).toEqual(['Fable']);
    expect(warningOf(fable)).toBe('');
    const sonnet = harnessViews(b, [{ harness: 'claude', model: 'claude-sonnet-5-5' }], NOW, 'UTC')[0]!;
    expect(sonnet.models).toEqual([]);
    expect(warningOf(sonnet)).toBe('');
    // No model to match: every model window counts. Several models (a team): the union.
    expect(warningOf(harnessViews(b, ['claude'], NOW, 'UTC')[0]!)).toContain('96%');
    expect(harnessViews(b, [{ harness: 'claude', model: 'claude-fable-5-1' }, { harness: 'claude', model: 'claude-opus-5-5' }], NOW)[0]!.models).toHaveLength(2);
    expect(harnessViews(b, [{ harness: 'claude', model: '' }], NOW)[0]!.models).toHaveLength(2);
  });

  it('warn about a model window at 100 % as a used-up limit, only for that model', () => {
    const l = claude({ windows: [{ label: 'week', pct: 20, resets_at: 0 }, { label: 'week', model: 'Opus', pct: 100, resets_at: 0 }] });
    const b = new LimitBook();
    b.reset([l]);
    expect(warningOf(harnessViews(b, [{ harness: 'claude', model: 'claude-opus-5-5' }], NOW)[0]!)).toBe('Claude has used up its week · Opus limit.');
    expect(harnessViews(b, [{ harness: 'claude', model: 'claude-fable-5-1' }], NOW)[0]!.reached).toBe(false);
  });

  it('keep a reached model limit to its own model (Codex Spark vs Sol)', () => {
    const b = new LimitBook();
    b.reset([
      codex({
        windows: [
          { label: '5h', pct: 20, resets_at: NOW + 3600_000 },
          { label: '5h', model: 'Spark', pct: 100, resets_at: NOW + 3600_000, reached: 'rate_limit_reached' },
        ],
      }),
    ]);
    const sol = harnessViews(b, [{ harness: 'codex', model: 'gpt-6-sol' }], NOW, 'UTC')[0]!;
    expect(sol.models).toEqual([]);
    expect(sol.reached).toBe(false);
    expect(warningOf(sol)).toBe('');
    const spark = harnessViews(b, [{ harness: 'codex', model: 'gpt-5.3-codex-spark' }], NOW, 'UTC')[0]!;
    expect(spark.reached).toBe(true);
    expect(warningOf(spark)).toBe('Codex has used up its 5h · Spark limit, resets 18:00.');
    // The widget's provider-wide view still pulses.
    expect(providerView(b.get('codex')!, NOW).reached).toBe(true);
    // A reached flag below 100 % still pulses the widget and warns only for that model.
    const odd = new LimitBook();
    odd.reset([codex({ windows: [{ label: 'week', model: 'Spark', pct: 40, resets_at: 0, reached: 'x' }] })]);
    expect(providerView(odd.get('codex')!, NOW).reached).toBe(true);
    expect(harnessViews(odd, [{ harness: 'codex', model: 'gpt-6-sol' }], NOW)[0]!.reached).toBe(false);
    expect(warningOf(harnessViews(odd, [{ harness: 'codex', model: 'gpt-5.3-codex-spark' }], NOW)[0]!)).toBe('Codex has reached a limit.');
  });

  it('match display names with a version ("Sonnet 4.5") by their name', () => {
    const b = new LimitBook();
    b.reset([claude({ windows: [{ label: 'week', model: 'Sonnet 4.5', pct: 90, resets_at: 0 }] })]);
    expect(harnessViews(b, [{ harness: 'claude', model: 'claude-sonnet-5-5' }], NOW)[0]!.models).toHaveLength(1);
  });

  it('pick the chosen harnesses’ views, each once, in display order', () => {
    expect(harnessViews(book, ['codex', 'claude', 'codex'], NOW).map((v) => v.provider)).toEqual(['claude', 'codex']);
    expect(harnessViews(book, ['claude'], NOW).map((v) => v.provider)).toEqual(['claude']);
    expect(harnessViews(new LimitBook(), ['claude'], NOW)).toEqual([]);
  });
});

describe('the book', () => {
  it('starts unknown (an older bridge), takes the snapshot and then events', () => {
    const store = new WorldStore();
    expect(store.limits.known).toBe(false);
    store.applySnapshot({ t: 'world.snapshot', seq: 1, world: { buildings: [], unassigned: [], floors: [], workers: [], limits: [] } });
    expect(store.limits.known).toBe(true);
    expect(store.limits.list()).toEqual([]);
    const v0 = store.limits.version;
    const ev = { t: 'limits.update', seq: 2, ...claude() };
    expect(isWorldEvent(ev as never)).toBe(true);
    store.applyEvent(ev as never);
    store.applyEvent({ t: 'limits.update', seq: 3, ...codex() } as never);
    expect(store.limits.list().map((l) => l.provider)).toEqual(['claude', 'codex']);
    expect(store.limits.version).toBe(v0 + 2);
    // A newer reading replaces it.
    store.applyEvent({ t: 'limits.update', seq: 4, ...claude({ plan: 'max' }) } as never);
    expect(store.limits.get('claude')?.plan).toBe('max');
    expect(store.limits.list()).toHaveLength(2);
  });

  it('drops malformed readings and unknown keys', () => {
    expect(limitsOf({ provider: 'claude' })).toBeNull();
    expect(limitsOf({ provider: 'claude', windows: [{ label: '5h' }, { label: 'week', pct: 5, resets_at: 1, codename: 1 }], at: 5, cinder: 1 })).toEqual({
      provider: 'claude',
      plan: '',
      windows: [{ label: 'week', pct: 5, resets_at: 1 }],
      at: 5,
      stale: false,
    });
    const b = new LimitBook();
    expect(b.upsert({ provider: 1 })).toBe(false);
    expect(b.version).toBe(0);
  });
});

describe('Codex profiles (#138)', () => {
  const own = { key: 'codex', name: 'codex', plan: 'prolite', default: true };
  const acct = (key: string, name = key) => ({ key, name, plan: 'team', default: false });

  it('keys Codex readings by profile: two homes never overwrite each other, the same one replaces itself', () => {
    const b = new LimitBook();
    b.upsert(codex({ account: own }));
    b.upsert(codex({ account: acct('work'), plan: 'team' }));
    b.upsert(codex({ account: acct('work'), plan: 'team', windows: [] }));
    expect(b.list()).toHaveLength(2);
    expect(b.get('codex', 'work')?.windows).toEqual([]);
    expect(b.get('codex')?.account?.key).toBe('codex');
  });

  it('orders Claude, the default profile, then the others by name, whatever came first', () => {
    const b = new LimitBook();
    b.reset([codex({ account: acct('zed', 'Zed') }), codex({ account: acct('alpha', 'beta') }), codex({ account: own }), claude(), codex({ account: acct('b', 'Alpha') })]);
    expect(b.list().map((l) => l.account?.key ?? l.provider)).toEqual(['claude', 'codex', 'b', 'alpha', 'zed']);
  });

  it('a reading without an account (an older bridge) is the default profile', () => {
    const b = new LimitBook();
    b.reset([codex({ account: acct('work') }), codex(), claude()]);
    expect(b.list().map((l) => l.account?.key ?? l.provider)).toEqual(['claude', 'codex', 'work']);
    expect(b.get('codex')?.account).toBeUndefined();
    const views = limitsView(b, NOW);
    expect(views.map((v) => [v.profile, v.isDefault])).toEqual([
      [null, true],
      ['default', true],
      ['work', false],
    ]);
    expect(harnessViews(b, ['codex'], NOW).map((v) => [v.account, v.profile])).toEqual([[null, null]]);
  });

  it('names a row only when its provider has two or more; one profile is "Codex" as before', () => {
    const b = new LimitBook();
    b.reset([claude(), codex({ account: own })]);
    expect(limitsView(b, NOW).map((v) => [v.name, v.profile])).toEqual([
      ['Claude', null],
      ['Codex', null],
    ]);
    b.upsert(codex({ account: acct('work', 'Work seat') }));
    expect(limitsView(b, NOW).map((v) => [v.name, v.profile, v.isDefault])).toEqual([
      ['Claude', null, true],
      ['Codex', 'codex', true],
      ['Codex', 'Work seat', false],
    ]);
  });

  it('#139: a dialog shows the limits of the profile it hires on: the default unless one is picked', () => {
    const b = new LimitBook();
    b.reset([claude(), codex({ account: own }), codex({ account: acct('work'), plan: 'team' })]);
    expect(harnessViews(b, [{ harness: 'codex' }], NOW).map((v) => v.account)).toEqual(['codex']);
    expect(harnessViews(b, [{ harness: 'codex', profile: 'work' }], NOW).map((v) => [v.account, v.profile])).toEqual([['work', null]]);
    expect(harnessViews(b, [{ harness: 'codex', profile: 'codex' }], NOW).map((v) => v.account)).toEqual(['codex']);
    expect(harnessViews(b, [{ harness: 'codex', profile: 'unread' }], NOW)).toEqual([]); // no reading: no line
    expect(harnessViews(b, [{ harness: 'claude', profile: 'work' }, { harness: 'codex' }], NOW).map((v) => v.account)).toEqual([null, 'codex']);
  });

  it('keeps the account from the wire (never more), and drops a malformed one', () => {
    expect(limitsOf({ ...codex(), account: { key: 'work', name: 'Work', plan: 'team', default: false, email: 'x@y' } })?.account).toEqual({ key: 'work', name: 'Work', plan: 'team', default: false });
    expect(limitsOf({ ...codex(), account: { name: 'no key' } })?.account).toBeUndefined();
  });

  it('the store drops a profile hidden or removed elsewhere when codex_profiles.update says so', () => {
    const store = new WorldStore();
    const p = (key: string, hidden = false) => ({ key, name: key, path: `/h/.codex-${key}`, display: `~/.codex-${key}`, plan: '', signed_in: true, default: key === 'codex', hidden, added: false });
    store.applySnapshot({
      t: 'world.snapshot',
      seq: 1,
      world: { buildings: [], unassigned: [], floors: [], workers: [], limits: [claude(), codex({ account: own }), codex({ account: acct('work') })], codex_profiles: { profiles: [p('codex'), p('work')] } },
    });
    expect(store.limits.list()).toHaveLength(3);
    const ev = { t: 'codex_profiles.update', seq: 2, profiles: [p('codex'), p('work', true)] };
    expect(isWorldEvent(ev as never)).toBe(true);
    store.applyEvent(ev as never);
    expect(store.codexProfiles.state?.profiles[1]?.hidden).toBe(true);
    expect(store.limits.list().map((l) => l.account?.key ?? l.provider)).toEqual(['claude', 'codex']);
  });
});
