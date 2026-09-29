/**
 * M5: how the game shows a worker's usage: `≈$0.09 · 37k tokens · ctx 4%`,
 * only the parts that are known. The cost is the bridge's API-equivalent
 * estimate, so it always reads `≈$`, never a bare `$`; one priced as an
 * unknown model (at the most expensive known model's rates) carries a `*`.
 * Pure.
 */

import type { Usage } from '../net/protocol';

export interface UsageText {
  /** `≈$0.09*`, or null when no model was seen (nothing priced). */
  cost: string | null;
  /** `37k tokens`, or null when there are none yet. */
  tokens: string | null;
  /** `ctx 4%`, or null when unknown. */
  context: string | null;
  /** The known parts joined with ` · `; "" when nothing is known. */
  line: string;
  /** Priced as an unknown model. */
  flagged: boolean;
  /** Hover text: what the numbers mean, and why a `*`. */
  title: string;
}

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** `≈$0.09`, `≈$12.40`, `≈$184`: cents below $100, whole dollars above. */
export function costText(usd: number): string {
  const v = Math.max(0, usd);
  return v >= 100 ? `≈$${Math.round(v).toLocaleString('en-US')}` : `≈$${v.toFixed(2)}`;
}

/** `812`, `3.4k`, `37k`, `1.2M`. */
export function tokenCount(n: number): string {
  const v = Math.max(0, Math.round(n));
  if (v < 1000) return String(v);
  if (v < 10_000) return `${trim1(v / 1000)}k`;
  if (v < 1_000_000) return `${Math.round(v / 1000)}k`;
  if (v < 10_000_000) return `${trim1(v / 1_000_000)}M`;
  return `${Math.round(v / 1_000_000)}M`;
}

const trim1 = (x: number) => {
  const s = (Math.floor(x * 10) / 10).toFixed(1);
  return s.endsWith('.0') ? s.slice(0, -2) : s;
};

/** `ctx 4%`; a sliver above 0 reads `ctx <1%`. */
export function contextText(pct: number): string {
  const v = Math.min(100, Math.max(0, pct));
  if (v > 0 && v < 0.5) return 'ctx <1%';
  return `ctx ${Math.round(v)}%`;
}

export const UNKNOWN_MODEL_NOTE = 'priced as the most expensive known model';

/** The usage line and its parts for a worker (null usage: nothing known). */
export function usageText(u: Usage | null | undefined): UsageText {
  if (!u || typeof u !== 'object') return { cost: null, tokens: null, context: null, line: '', flagged: false, title: '' };
  const flagged = u.priced === 'unknown_model';
  const priced = u.priced !== 'none' && num(u.cost_usd_est);
  const cost = priced ? `${costText(u.cost_usd_est)}${flagged ? '*' : ''}` : null;
  const tokens = num(u.tokens) && u.tokens > 0 ? `${tokenCount(u.tokens)} tokens` : null;
  const context = num(u.context_pct) ? contextText(u.context_pct) : null;
  const line = [cost, tokens, context].filter((s): s is string => !!s).join(' · ');
  const model = typeof u.model === 'string' && u.model ? u.model : 'this model';
  const parts: string[] = [];
  if (cost) parts.push(`${cost}: an API-equivalent estimate${flagged ? ` (* ${model} is not in the pricing table: ${UNKNOWN_MODEL_NOTE})` : ''}`);
  if (tokens) parts.push(`${tokens} in this agent session`);
  if (context) parts.push(`${context} of the context window${num(u.context_window) ? ` (${tokenCount(u.context_window)})` : ''}`);
  return { cost, tokens, context, line, flagged, title: parts.join('; ') };
}

export interface UsageTotal {
  /** Sum of the priced workers' estimates. */
  usd: number;
  /** Workers whose usage has a price. */
  priced: number;
  /** Any of them priced as an unknown model. */
  flagged: boolean;
  /** `≈$1.23*`, null when nothing is priced. */
  text: string | null;
  title: string;
}

/** A floor's (or any group's) total estimate, for the top bar. */
export function usageTotal(usages: ReadonlyArray<Usage | null | undefined>): UsageTotal {
  let usd = 0;
  let priced = 0;
  let flagged = 0;
  for (const u of usages) {
    if (!u || u.priced === 'none' || !num(u.cost_usd_est)) continue;
    usd += Math.max(0, u.cost_usd_est);
    priced++;
    if (u.priced === 'unknown_model') flagged++;
  }
  if (!priced) return { usd: 0, priced: 0, flagged: false, text: null, title: '' };
  const text = `${costText(usd)}${flagged ? '*' : ''}`;
  const who = `${priced} ${priced === 1 ? 'agent' : 'agents'}`;
  const title = `${text} on this floor: an API-equivalent estimate over ${who}${flagged ? ` (* ${flagged} ${UNKNOWN_MODEL_NOTE})` : ''}`;
  return { usd, priced, flagged: flagged > 0, text, title };
}
