/**
 * #9 LLM handoffs: the bridge-wide switch that lets the configured LLM write a handoff from a worker's reduced,
 * scrubbed transcript (the dialog's "Use configured LLM"). Its settings and state as the snapshot's `handoff_llm` and the
 * `handoff_llm.update` events carry them (`HandoffLLMBook`), and the words for its states, preview and jobs. Pure: the
 * Settings section and the handoff dialog use it.
 */

import type { AiRole, AiRoleState, HandoffLLMFeatureState, HandoffLLMState, LLMHandoff, LLMHandoffPreview } from '../net/protocol';
import { followupFailureText } from './followup';
import { reasoningOf } from './digestSettings';

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const ROLE_STATES: readonly string[] = ['off', 'incomplete', 'invalid', 'ready'];
const FEATURE: readonly string[] = ['off', 'incomplete', 'untested', 'ready'];

/** The limits the section accepts (the bridge checks again: what it refuses is a `bad_request`). */
export const HANDOFF_LLM_INPUT = { min: 16 << 10, max: 768 << 10, default: 96 << 10 } as const;
export const HANDOFF_LLM_TOKENS = { min: 1024, max: 32_768, default: 4096 } as const;

/** What a handoff sends the endpoint, when the bridge does not say (an older one). */
export const HANDOFF_LLM_CATEGORIES = [
  'your prompts to the worker',
  'the worker’s replies and explanations',
  'tool names and their inputs (commands, paths)',
  'bounded tool evidence (test results, errors, commit and PR references)',
  'your handoff instruction',
  'the bridge’s facts (worker, branch, git status now)',
];

/** A well-formed state (unknown keys dropped), else null. */
export function handoffLlmStateOf(v: unknown): HandoffLLMState | null {
  if (!isObj(v) || typeof v.enabled !== 'boolean' || !FEATURE.includes(String(v.state))) return null;
  const roles = isObj(v.roles) ? v.roles : {};
  const missing = strs(v.missing).filter((x): x is AiRole => x === 'llm' || x === 'classifier');
  const cats = strs(v.categories);
  return {
    enabled: v.enabled,
    state: v.state as HandoffLLMFeatureState,
    ...(missing.length ? { missing } : {}),
    roles: { llm: typeof roles.llm === 'string' && ROLE_STATES.includes(roles.llm) ? (roles.llm as AiRoleState) : 'off' },
    env: strs(v.env),
    tested: v.tested === true,
    input_bytes: num(v.input_bytes) && v.input_bytes > 0 ? Math.floor(v.input_bytes) : HANDOFF_LLM_INPUT.default,
    max_tokens: num(v.max_tokens) && v.max_tokens > 0 ? Math.floor(v.max_tokens) : HANDOFF_LLM_TOKENS.default,
    reasoning_effort: typeof v.reasoning_effort === 'string' ? v.reasoning_effort : '',
    reasoning: reasoningOf(v.reasoning),
    effort_stale: v.effort_stale === true,
    timeout_s: num(v.timeout_s) && v.timeout_s > 0 ? Math.floor(v.timeout_s) : 90,
    prompt_version: typeof v.prompt_version === 'string' ? v.prompt_version : '',
    categories: cats.length ? cats : HANDOFF_LLM_CATEGORIES,
  };
}

/** The feature's settings and state, and who listens for changes. */
export class HandoffLLMBook {
  /** The bridge sent a `handoff_llm` state (it has the feature). */
  known = false;
  version = 0;
  private cur: HandoffLLMState | null = null;
  private readonly listeners = new Set<() => void>();

  get state(): HandoffLLMState | null {
    return this.cur;
  }

  reset(v: unknown): void {
    this.cur = handoffLlmStateOf(v);
    this.known = this.cur !== null;
    this.version++;
    this.emit();
  }

  upsert(v: unknown): boolean {
    const next = handoffLlmStateOf(v);
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

/** Why the dialog's "Use configured LLM" can't be chosen now ('': it can). */
export function llmModeWhy(s: HandoffLLMState | null, known: boolean): string {
  if (!known || !s) return 'This bridge can’t write handoffs with an LLM (it needs the AI integration and a filing cabinet).';
  switch (s.state) {
    case 'ready':
      return '';
    case 'off':
      return 'LLM handoffs are off. Switch them on in Settings › LLM handoffs after a passing test.';
    case 'incomplete':
      return 'The LLM is not ready. Set it up in Settings › AI integration.';
    case 'untested':
      return 'The LLM or the handoff limits changed since the test. Run the test again in Settings › LLM handoffs.';
  }
  return 'LLM handoffs are not available.';
}

/** `98.3 KB` style sizes. */
export const sizeWord = (n: number): string => (n < 1024 ? `${n} bytes` : n < 1 << 20 ? `${Math.round(n / 102.4) / 10} KB` : `${Math.round(n / 104857.6) / 10} MB`);

const figures = (n: number) => n.toLocaleString('en-US');

/** Each category's words, one and many. */
const CATEGORY_WORD: Record<string, [string, string]> = {
  configured_secret: ['configured secret', 'configured secrets'],
  data_uri: ['inline image or data', 'inline images and data'],
  private_key: ['private key', 'private keys'],
  url_credentials: ['password in a URL', 'passwords in URLs'],
  slack_webhook: ['Slack webhook', 'Slack webhooks'],
  aws_access_key: ['AWS key id', 'AWS key ids'],
  aws_secret_key: ['AWS secret key', 'AWS secret keys'],
  github_token: ['GitHub token', 'GitHub tokens'],
  anthropic_key: ['Anthropic key', 'Anthropic keys'],
  openai_key: ['OpenAI key', 'OpenAI keys'],
  stripe_key: ['Stripe key', 'Stripe keys'],
  slack_token: ['Slack token', 'Slack tokens'],
  google_api_key: ['Google API key', 'Google API keys'],
  jwt: ['JSON web token', 'JSON web tokens'],
  auth_header: ['authorization header', 'authorization headers'],
  secret_assignment: ['secret-looking assignment', 'secret-looking assignments'],
};

/** Redaction counts in words, most first: `3 GitHub tokens, 1 password in a URL`; '' for none. */
export function redactionText(r: Record<string, number> | undefined): string {
  const rows = Object.entries(r ?? {}).filter(([, n]) => typeof n === 'number' && n > 0);
  rows.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return rows
    .map(([k, n]) => {
      const w = CATEGORY_WORD[k];
      return `${figures(n)} ${w ? w[n === 1 ? 0 : 1] : k.replace(/_/g, ' ')}`;
    })
    .join(', ');
}

/** The preview's size line: `24.1 KB of transcript, about 8,200 tokens (budget 96 KB)`. */
export function payloadText(p: LLMHandoffPreview): string {
  return `${sizeWord(p.payload_bytes)} of transcript, about ${figures(p.est_tokens)} tokens (budget ${sizeWord(p.budget_bytes)})`;
}

/** The preview's coverage line: what of the conversation goes. */
export function coverageText(p: LLMHandoffPreview): string {
  const c = p.coverage;
  if (!p.reduced) return 'Not read yet.';
  const head = c.complete ? `All ${figures(c.messages)} messages` : `${figures(c.kept)} of ${figures(c.messages)} messages`;
  const comp = c.compaction === 'claude_summary' ? '; starts from the compaction summary' : c.compaction === 'codex_retained' ? '; starts from what the compaction kept' : c.compaction === 'opaque' || c.compaction === 'missing' ? '; earlier history was compacted' : '';
  return `${head}${comp}.`;
}

/** The omitted ranges in words: `messages 3–20 (older assistant detail)`. */
export function omittedText(p: LLMHandoffPreview): string[] {
  return (p.coverage.omitted ?? []).map((r) => (r.from === r.to ? `message ${r.from}` : `messages ${r.from}–${r.to}`) + (r.why ? ` (${r.why})` : ''));
}

/** A job's progress or outcome in one sentence. */
export function jobText(j: LLMHandoff): string {
  switch (j.state) {
    case 'queued':
    case 'running':
      return `Sent to ${j.model || 'the LLM'}${j.host ? ` at ${j.host}` : ''}; waiting for its handoff.`;
    case 'filed':
      return 'Filed.';
    case 'cancelled':
      return j.message || 'Cancelled; nothing was filed.';
  }
  return j.message || 'It failed; nothing was filed.';
}

/** Plain words for a `handoff_llm.*` failure. */
export function handoffLlmFailureText(code: string, message: string): string {
  switch (code) {
    case 'test_required':
      return 'Run the test first: it has to pass with the LLM and the limits in use.';
    case 'incomplete':
      return 'The LLM must be ready first: set it up under AI integration.';
    case 'env_locked':
      return 'The bridge’s environment switches this (HERDR_WORLD_HANDOFF_LLM_ENABLED).';
    case 'unknown_command':
    case 'unsupported':
      return 'This bridge has no LLM handoffs. Update it to use this.';
    case 'truncated':
      return `The model used its whole completion budget before the handoff was complete (${message}). Raise the budget or lower the reasoning effort.`;
    case 'empty_answer':
      return 'The model answered with no text. Try again, or change the model or its reasoning effort.';
    case 'timeout':
      return 'The model did not answer within the time a handoff gets. It was not sent again.';
  }
  return followupFailureText(code, message);
}
