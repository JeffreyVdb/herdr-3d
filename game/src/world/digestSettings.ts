/**
 * #118 floor overview summaries: the bridge-wide switch that lets the configured LLM write the floor overview's task
 * and now lines. Its settings and state as the snapshot's `digest` and the `digest.update` events carry them
 * (`DigestBook`). Pure: the Settings section uses it.
 */

import type { AiRole, AiRoleState, DigestFeatureState, DigestLineStatus, DigestReasoning, DigestState } from '../net/protocol';
import { followupFailureText } from './followup';

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const ROLE_STATES: readonly string[] = ['off', 'incomplete', 'invalid', 'ready'];
const FEATURE: readonly string[] = ['off', 'incomplete', 'ready'];

/** The daily cap the section accepts (the bridge checks again: what it refuses is a `bad_request`). */
export const DIGEST_CAP = { min: 1, max: 10_000 } as const;

/** #174: the completion budget (reasoning included, not the lines' length) the section accepts; the bridge checks again. */
export const DIGEST_TOKENS = { min: 64, max: 16_384, default: 1024 } as const;

const SUPPORT: readonly string[] = ['supported', 'unsupported', 'unknown'];
const GENERIC_EFFORTS = ['low', 'medium', 'high'];

/** A well-formed reasoning description (#9's settings read it too). */
export function reasoningOf(v: unknown): DigestReasoning {
  const r = isObj(v) ? v : {};
  const support = typeof r.support === 'string' && SUPPORT.includes(r.support) ? (r.support as DigestReasoning['support']) : 'unknown';
  const efforts = Array.isArray(r.efforts) ? r.efforts.filter((x): x is string => typeof x === 'string') : support === 'unsupported' ? [] : GENERIC_EFFORTS;
  return {
    support,
    ...(typeof r.model === 'string' && r.model ? { model: r.model } : {}),
    efforts,
    listed: r.listed === true,
    ...(typeof r.default_effort === 'string' && r.default_effort ? { default_effort: r.default_effort } : {}),
    ...(r.mandatory === true ? { mandatory: true } : {}),
  };
}

/** A well-formed state (unknown keys dropped), else null. */
export function digestStateOf(v: unknown): DigestState | null {
  if (!isObj(v) || typeof v.enabled !== 'boolean' || !FEATURE.includes(String(v.state)) || !num(v.daily_cap)) return null;
  const roles = isObj(v.roles) ? v.roles : {};
  const missing = Array.isArray(v.missing) ? v.missing.filter((x): x is AiRole => x === 'llm' || x === 'classifier') : [];
  return {
    enabled: v.enabled,
    state: v.state as DigestFeatureState,
    ...(missing.length ? { missing } : {}),
    roles: { llm: typeof roles.llm === 'string' && ROLE_STATES.includes(roles.llm) ? (roles.llm as AiRoleState) : 'off' },
    env: Array.isArray(v.env) ? v.env.filter((x): x is string => typeof x === 'string') : [],
    tested: v.tested === true,
    daily_cap: Math.floor(v.daily_cap),
    calls_today: num(v.calls_today) && v.calls_today > 0 ? Math.floor(v.calls_today) : 0,
    reasoning_effort: typeof v.reasoning_effort === 'string' ? v.reasoning_effort : '',
    max_tokens: num(v.max_tokens) && v.max_tokens > 0 ? Math.floor(v.max_tokens) : DIGEST_TOKENS.default,
    reasoning: reasoningOf(v.reasoning),
    effort_stale: v.effort_stale === true,
  };
}

/** The feature's settings and state, and who listens for changes. */
export class DigestBook {
  /** The bridge sent a `digest` state (it has the feature). */
  known = false;
  version = 0;
  private cur: DigestState | null = null;
  private readonly listeners = new Set<() => void>();

  get state(): DigestState | null {
    return this.cur;
  }

  reset(v: unknown): void {
    this.cur = digestStateOf(v);
    this.known = this.cur !== null;
    this.version++;
    this.emit();
  }

  upsert(v: unknown): boolean {
    const next = digestStateOf(v);
    if (!next) return false;
    this.cur = next;
    this.known = true;
    this.version++;
    this.emit();
    return true;
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of [...this.listeners]) fn();
  }
}

const EFFORT_WORD: Record<string, string> = { none: 'Off (no reasoning)', minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' };

/** An effort in words (an effort the game does not know is shown as the bridge sent it). */
export const effortWord = (e: string): string => EFFORT_WORD[e] ?? e;

export interface EffortChoice {
  value: string;
  label: string;
  /** Not selectable: a saved value the model does not take, kept visible so it is not silently lost. */
  stale?: boolean;
}

/**
 * The reasoning effort dropdown's entries for a state: the provider's default first (nothing sent, and the model's own
 * default when the catalog names it), then exactly the efforts the model's catalog lists (the generic low/medium/high
 * when effort selection is unknown; none when it is unsupported), and a saved effort the model does not take last,
 * marked, so it is surfaced rather than silently dropped.
 */
export function effortChoices(s: Pick<DigestState, 'reasoning' | 'reasoning_effort'>): EffortChoice[] {
  const r = s.reasoning;
  const def = r.default_effort ? ` (the model uses ${effortWord(r.default_effort).toLowerCase()})` : '';
  const out: EffortChoice[] = [{ value: '', label: `Provider default${def}` }];
  for (const e of r.efforts) out.push({ value: e, label: effortWord(e) });
  if (s.reasoning_effort && !out.some((c) => c.value === s.reasoning_effort)) out.push({ value: s.reasoning_effort, label: `${effortWord(s.reasoning_effort)} (not supported by this model)`, stale: true });
  return out;
}

/** What the effort control says about the model, under it. */
export function effortNote(s: Pick<DigestState, 'reasoning' | 'reasoning_effort' | 'effort_stale'>): string {
  const r = s.reasoning;
  const model = r.model ? ` ${r.model}` : '';
  if (s.effort_stale) return `The saved effort “${effortWord(s.reasoning_effort)}” is not one${model || ' this model'} takes, so it is not sent: the provider's default applies. Pick another or the default.`;
  switch (r.support) {
    case 'unsupported':
      return `${model ? `Model${model}` : 'This model'} has no reasoning effort to choose: nothing is sent.`;
    case 'unknown':
      return 'The endpoint does not describe this model’s reasoning, so the usual efforts are offered. One it does not take fails the call with a clear error; the provider’s default sends nothing.';
  }
  if (r.listed && r.efforts.length === 0) return `${model ? `Model${model}` : 'This model'} does not offer a reasoning effort choice: the provider’s default applies.`;
  if (r.mandatory) return `${model ? `Model${model}` : 'This model'} always reasons: it cannot be turned off.`;
  return r.listed ? `The efforts${model ? ` of${model}` : ''}, as its catalog lists them.` : 'The usual efforts; the catalog does not list this model’s own.';
}

/** The budget's outcome shown for a test sample: `412 of 1,024 tokens, 380 reasoning`; '' when the call reported nothing. */
export function usageText(d: { completion_tokens?: number; reasoning_tokens?: number } | undefined, budget: number): string {
  if (!d || typeof d.completion_tokens !== 'number') return '';
  const used = `${d.completion_tokens.toLocaleString('en-US')} of ${budget.toLocaleString('en-US')} tokens`;
  return typeof d.reasoning_tokens === 'number' ? `${used}, ${d.reasoning_tokens.toLocaleString('en-US')} reasoning` : used;
}

const REASON: Record<string, string> = {
  truncated: 'the model ran out of its token budget before it wrote a line (its reasoning counts against it)',
  empty_answer: 'the model answered with no text',
  bad_response: 'the model’s answer was not usable',
  no_line: 'the model’s answer held no line',
  provider_failed: 'the provider failed',
  timeout: 'the model did not answer in time',
  rate_limited: 'the provider is rate limiting',
  auth_failed: 'the provider rejected the key',
  unreachable: 'the endpoint could not be reached',
  bad_config: 'the provider refused the request (a reasoning effort it does not take?)',
  daily_cap: 'today’s daily cap is reached',
  failed: 'the call failed',
};

/** A failure's reason in words (an unknown code is shown as it came). */
export const reasonWord = (r: string | undefined): string => (r ? (REASON[r] ?? r.replace(/_/g, ' ')) : '');

/** A clock time for a retry, in the viewer's locale (`14:32`). */
const clock = (ms: number): string => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

export interface LineStatusText {
  /** The chip beside the line: short, in the board's voice. */
  chip: string;
  /** The sentence behind it: what happened, and what happens next or what to do. */
  detail: string;
  /** A manual retry makes sense. */
  retry: boolean;
}

/**
 * What a line's status says (#174): shown where the AI badge would be, while a fallback stands in for the model's line.
 * `kind` is the line it is of: the task is asked again by itself; the now line waits for the next turn. `kept` (#198):
 * the line shown is the model's previous now line, beside its AI mark, and a refresh of it from newer activity failed.
 */
export function lineStatusText(st: DigestLineStatus, kind: 'task' | 'now', kept = false): LineStatusText {
  const why = reasonWord(st.reason);
  const tries = st.attempts && st.attempts > 1 ? ` after ${st.attempts} attempts` : '';
  const settings = ' Raise the completion budget or lower the reasoning effort under Settings › Floor overview summaries.';
  const hint = st.reason === 'truncated' ? settings : '';
  if (kept && st.state !== 'pending') {
    const failed = `Refreshing this AI summary from newer activity failed${tries}: ${why}. The summary shown is the previous one; its age is when it was written.${hint}`;
    return st.state === 'retrying'
      ? {
          chip: st.retry_at ? `refresh failed · retry ${clock(st.retry_at)}` : 'refresh failed · retrying',
          detail: `${failed} It tries again${st.retry_at ? ` at ${clock(st.retry_at)}` : ' soon'}. Retry now with R.`,
          retry: true,
        }
      : { chip: 'refresh failed', detail: `${failed} Retry now with R; it also tries again by itself with newer activity or when the turn ends.`, retry: true };
  }
  switch (st.state) {
    case 'pending':
      return st.reason === 'daily_cap'
        ? { chip: 'AI waiting', detail: 'The AI line waits: today’s daily cap is reached. It is written when the cap is raised or tomorrow.', retry: false }
        : { chip: 'AI pending', detail: 'The AI line is being written; the line shown is the fallback until then.', retry: false };
    case 'retrying':
      return {
        chip: st.retry_at ? `AI retry ${clock(st.retry_at)}` : 'AI retrying',
        detail: `The AI line failed: ${why}. It tries again${st.retry_at ? ` at ${clock(st.retry_at)}` : ' soon'}; the line shown is the fallback.${hint} Retry now with R.`,
        retry: true,
      };
    default:
      return {
        chip: 'AI failed',
        detail: `The AI line failed${tries}: ${why}; the line shown is the fallback.${hint} ${kind === 'task' ? 'Retry now with R; it also tries again on a new prompt or when the settings change.' : 'Retry now with R; it also tries again by itself with newer activity or when the turn ends.'}`,
        retry: true,
      };
  }
}

/** Plain words for a `digest.*` failure. */
export function digestFailureText(code: string, message: string): string {
  switch (code) {
    case 'test_required':
      return 'Run the test first: it has to pass with the LLM in use.';
    case 'incomplete':
      return 'The LLM must be ready first: set it up under AI integration.';
    case 'env_locked':
      return 'The bridge’s environment switches this (HERDR_WORLD_DIGEST_ENABLED).';
    case 'unknown_command':
    case 'unsupported':
      return 'This bridge has no floor overview summaries. Update it to use this.';
    case 'truncated':
      return `The model used its whole token budget before writing anything (${message}). Raise the completion budget or lower the reasoning effort.`;
    case 'empty_answer':
      return 'The model answered with no text. Try again, or change the model or its reasoning effort.';
  }
  return followupFailureText(code, message);
}
