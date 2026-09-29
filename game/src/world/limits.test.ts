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
