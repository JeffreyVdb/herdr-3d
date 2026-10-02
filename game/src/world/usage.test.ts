import { describe, expect, it } from 'vitest';
import type { Usage } from '../net/protocol';
import { contextMeter, contextText, costText, tokenCount, usageText, usageTotal } from './usage';

const usage = (over: Partial<Usage> = {}): Usage => ({
  tokens: 37_210,
  input: 1200,
  output: 9010,
  cache_write: 27_000,
  cache_read: 812_000,
  cost_usd_est: 0.0912,
  priced: 'known',
  model: 'claude-opus-5-5',
  context_pct: 4.2,
  context_window: 200_000,
  updated_at: 1_790_601_900_984,
  ...over,
});

describe('usage formatting', () => {
  it('writes the HUD line: ≈$ cost · tokens · context', () => {
    const t = usageText(usage());
    expect(t.line).toBe('≈$0.09 · 37k tokens · ctx 4%');
    expect(t.flagged).toBe(false);
    expect(t.title).toBe('≈$0.09: an API-equivalent estimate; 37k tokens in this agent session; ctx 4% of the context window (200k)');
  });

  it('flags a cost priced as an unknown model with a * and says why', () => {
    const t = usageText(usage({ priced: 'unknown_model', model: 'gpt-6-nova', cost_usd_est: 1.5 }));
    expect(t.cost).toBe('≈$1.50*');
    expect(t.line).toBe('≈$1.50* · 37k tokens · ctx 4%');
    expect(t.flagged).toBe(true);
    expect(t.title).toContain('gpt-6-nova is not in the pricing table: priced as the most expensive known model');
  });

  it('shows only the parts that are known', () => {
    expect(usageText(usage({ priced: 'none', cost_usd_est: 0 })).line).toBe('37k tokens · ctx 4%');
    expect(usageText(usage({ context_pct: null })).line).toBe('≈$0.09 · 37k tokens');
    expect(usageText(usage({ tokens: 0, context_pct: null })).line).toBe('≈$0.09');
    expect(usageText(null).line).toBe('');
    expect(usageText(undefined)).toMatchObject({ cost: null, tokens: null, context: null, flagged: false });
  });

  it('never prints a bare $', () => {
    for (const usd of [0, 0.004, 0.0912, 3.456, 12.4, 99.994, 184.4, 12_345.6]) expect(costText(usd)).toMatch(/^≈\$/);
    expect([0, 0.004, 0.0912, 12.4, 99.994, 184.4, 12_345.6].map(costText)).toEqual(['≈$0.00', '≈$0.00', '≈$0.09', '≈$12.40', '≈$99.99', '≈$184', '≈$12,346']);
  });

  it('shortens token counts', () => {
    expect([0, 812, 999, 1000, 3_450, 9_999, 10_400, 37_210, 999_400, 1_234_567, 12_600_000].map(tokenCount)).toEqual([
      '0', '812', '999', '1k', '3.4k', '9.9k', '10k', '37k', '999k', '1.2M', '13M',
    ]);
  });

  it('rounds the context share, keeping a sliver visible', () => {
    expect([0, 0.2, 0.5, 4.2, 57.5, 100, 130].map(contextText)).toEqual(['ctx 0%', 'ctx <1%', 'ctx 1%', 'ctx 4%', 'ctx 58%', 'ctx 100%', 'ctx 100%']);
  });
});

describe('usageTotal', () => {
  it('sums the priced workers of a floor, flagged when any is an unknown model', () => {
    const t = usageTotal([usage(), usage({ cost_usd_est: 1.2 }), undefined, usage({ priced: 'none', cost_usd_est: 9 })]);
    expect(t).toMatchObject({ usd: 1.2912, priced: 2, flagged: false, text: '≈$1.29' });
    expect(t.title).toBe('≈$1.29 on this floor: an API-equivalent estimate over 2 agents');
    const f = usageTotal([usage(), usage({ priced: 'unknown_model', cost_usd_est: 2 })]);
    expect(f.text).toBe('≈$2.09*');
    expect(f.title).toContain('(* 1 priced as the most expensive known model)');
  });

  it('is empty when nothing is priced', () => {
    expect(usageTotal([])).toMatchObject({ text: null, priced: 0 });
    expect(usageTotal([null, usage({ priced: 'none' })]).text).toBeNull();
  });
});

describe('contextMeter (#101)', () => {
  // `over` may hold undefined or junk: what a bridge could send.
  const claude = (over: Record<string, unknown> = {}) => ({ ...usage(), context_pct: 47.7, context_window: 1_000_000, context_tokens: 476_871, ...over }) as Usage;

  it('writes the label, the tooltip and the spoken value for a Claude session', () => {
    const m = contextMeter(claude())!;
    expect(m.pct).toBe(47.7);
    expect(m.pctText).toBe('48%');
    expect(m.label).toBe('48% · 477k / 1M');
    expect(m.level).toBe('ok');
    expect(m.title).toBe('Context in use: 476,871 of 1,000,000 tokens (47.7%). Estimate of what the next turn starts with, main thread only.');
    expect(m.valueText).toBe('48 percent, 476,871 of 1,000,000 tokens');
  });

  it('marks an assumed window with ~ and says so', () => {
    const m = contextMeter(claude({ context_window_estimated: true }))!;
    expect(m.label).toBe('48% · 477k / ~1M');
    expect(m.windowText).toBe('~1M');
    expect(m.title).toContain(' Window size assumed.');
    expect(m.valueText).toBe('48 percent, 476,871 of 1,000,000 tokens, window size assumed');
    expect(contextMeter(claude({ context_window_estimated: false }))!.windowText).toBe('1M');
  });

  it("tells Codex's percentage leaves out its 12,000-token baseline", () => {
    const m = contextMeter(usage({ model: 'gpt-6.1-sol', context_pct: 15.4, context_window: 258_400, context_tokens: 50_000 }))!;
    expect(m.label).toBe('15% · 50k / 258k');
    expect(m.title).toBe(
      "Context in use: 50,000 of 258,400 tokens (15.4%). Estimate of what the next turn starts with, main thread only. The percentage leaves out Codex's 12,000-token baseline.",
    );
    expect(m.valueText).toContain("excludes Codex's 12,000-token baseline");
    // Claude's has no such note, and neither has a worker whose model is not known yet.
    expect(contextMeter(claude())!.title).not.toContain('baseline');
    expect(contextMeter(claude({ model: undefined }))!.title).not.toContain('baseline');
  });

  it('steps ok → warm at 70 → hot at 90 on the unrounded share', () => {
    const level = (pct: number) => contextMeter(claude({ context_pct: pct }))!.level;
    expect([0, 12, 69.9, 69.95].map(level)).toEqual(['ok', 'ok', 'ok', 'ok']);
    expect([70, 74.5, 89.9, 89.99].map(level)).toEqual(['warm', 'warm', 'warm', 'warm']);
    expect([90, 96, 100].map(level)).toEqual(['hot', 'hot', 'hot']);
    // 69.6 reads 70% yet is not warm; 89.6 reads 90% yet is not hot: the number never contradicts the colour's rule.
    expect(contextMeter(claude({ context_pct: 69.6 }))!.pctText).toBe('70%');
    expect(level(69.6)).toBe('ok');
    expect(contextMeter(claude({ context_pct: 89.6 }))!.pctText).toBe('90%');
    expect(level(89.6)).toBe('warm');
  });

  it('is hidden when the share or the window is unknown, never a NaN or a 0%', () => {
    for (const bad of [undefined, null, NaN, Infinity, -Infinity, '12' as unknown as number]) {
      expect(contextMeter(claude({ context_pct: bad }))).toBeNull();
    }
    for (const bad of [undefined, 0, -5, NaN, Infinity]) expect(contextMeter(claude({ context_window: bad }))).toBeNull();
    expect(contextMeter(null)).toBeNull();
    expect(contextMeter(undefined)).toBeNull();
    expect(contextMeter('x' as unknown as Usage)).toBeNull();
  });

  it('clamps the share and shows a sliver and a true zero as they are', () => {
    expect(contextMeter(claude({ context_pct: 140 }))!.pct).toBe(100);
    expect(contextMeter(claude({ context_pct: -3 }))!.pct).toBe(0);
    expect(contextMeter(claude({ context_pct: 0.2, context_tokens: 2000 }))!.pctText).toBe('<1%');
    expect(contextMeter(claude({ context_pct: 0.2, context_tokens: 2000 }))!.valueText).toMatch(/^under 1 percent, /);
    expect(contextMeter(claude({ context_pct: 0, context_tokens: 5000 }))!.pctText).toBe('0%');
  });

  it('copes with a bridge that sends no count: the share and the window only, nothing reconstructed', () => {
    const m = contextMeter(claude({ context_tokens: undefined, context_window_estimated: true }))!;
    expect(m.usedText).toBeNull();
    expect(m.label).toBe('48% of ~1M');
    expect(m.title).toBe('Context in use: 47.7% of 1,000,000 tokens. Estimate of what the next turn starts with, main thread only. Window size assumed.');
    expect(m.valueText).toBe('48 percent, of a 1,000,000-token window, window size assumed');
    // The cumulative count is not the context.
    expect(m.label).not.toContain('37k');
    expect(contextMeter(claude({ context_tokens: 0 }))!.usedText).toBeNull();
  });
});
