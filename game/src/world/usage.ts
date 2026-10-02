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

/** Codex keeps this much of its window for its own prompt; its percentage (and the bridge's) leaves it out. */
export const CODEX_BASELINE = 12_000;

export interface ContextMeter {
  /** The share in use, finite and clamped to 0–100, unrounded (the fill, the colour and `aria-valuenow`). */
  pct: number;
  /** `48%`; a sliver above 0 reads `<1%`. */
  pctText: string;
  /** `477k`, or null when the bridge sent no count (an older one). */
  usedText: string | null;
  /** `1M`, or `~1M` when the window was assumed. */
  windowText: string;
  /** `48% · 477k / ~1M` (`48% of ~1M` without a count): what the bar says in words. */
  label: string;
  /** Colour step on the unrounded share; the number is always there too. */
  level: 'ok' | 'warm' | 'hot';
  /** The native tooltip. */
  title: string;
  /** `aria-valuetext`: the same facts, spoken. */
  valueText: string;
}

/** From this share on the meter turns warm, then hot. */
export const CONTEXT_WARM = 70;
export const CONTEXT_HOT = 90;

const exact = (n: number) => Math.round(n).toLocaleString('en-US');

/**
 * #101: the context meter of the transcript bar, from a worker's usage. Null (no meter) when the share or the
 * window is unknown: a compact, no usage yet, an unknown model. Never a 0 from missing data. The count and the
 * window are the bridge's; they are not derived from the cumulative `tokens`. Codex's share leaves out its 12k
 * baseline, so the tooltip says so (a model that is not Claude's: the bridge's own rule for the harness).
 */
export function contextMeter(u: Usage | null | undefined): ContextMeter | null {
  if (!u || typeof u !== 'object') return null;
  const win = u.context_window;
  if (!num(u.context_pct) || !num(win) || win <= 0) return null;
  const pct = Math.min(100, Math.max(0, u.context_pct));
  const used = num(u.context_tokens) && u.context_tokens > 0 ? Math.round(u.context_tokens) : null;
  const estimated = u.context_window_estimated === true;
  const codex = typeof u.model === 'string' && u.model !== '' && !u.model.startsWith('claude-');
  const pctText = pct > 0 && pct < 0.5 ? '<1%' : `${Math.round(pct)}%`;
  const usedText = used === null ? null : tokenCount(used);
  const windowText = `${estimated ? '~' : ''}${tokenCount(win)}`;
  const label = usedText === null ? `${pctText} of ${windowText}` : `${pctText} · ${usedText} / ${windowText}`;
  const level = pct >= CONTEXT_HOT ? 'hot' : pct >= CONTEXT_WARM ? 'warm' : 'ok';

  const share = `${pct.toFixed(1)}%`;
  const assumed = estimated ? 'Window size assumed.' : '';
  const baseline = codex ? `The percentage leaves out Codex's ${exact(CODEX_BASELINE)}-token baseline.` : '';
  const title = [
    used === null ? `Context in use: ${share} of ${exact(win)} tokens.` : `Context in use: ${exact(used)} of ${exact(win)} tokens (${share}).`,
    'Estimate of what the next turn starts with, main thread only.',
    assumed,
    baseline,
  ]
    .filter(Boolean)
    .join(' ');
  const valueText = [
    pct > 0 && pct < 0.5 ? 'under 1 percent' : `${Math.round(pct)} percent`,
    used === null ? `of a ${exact(win)}-token window` : `${exact(used)} of ${exact(win)} tokens`,
    estimated ? 'window size assumed' : '',
    codex ? `excludes Codex's ${exact(CODEX_BASELINE)}-token baseline` : '',
  ]
    .filter(Boolean)
    .join(', ');
  return { pct, pctText, usedText, windowText, label, level, title, valueText };
}
