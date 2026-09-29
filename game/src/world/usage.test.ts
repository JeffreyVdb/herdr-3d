import { describe, expect, it } from 'vitest';
import type { Usage } from '../net/protocol';
import { contextText, costText, tokenCount, usageText, usageTotal } from './usage';

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
