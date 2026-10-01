/**
 * AI integration (#92): the bridge's classification model and LLM, as the
 * snapshot's `ai` and the `ai.update` events show them, and what the HUD says
 * about them (the "paused" toast, the chip), as plain data covered by vitest.
 * The bridge never sends a key: only `key_set` and `key_hint`.
 */

import type { AiClassifier, AiLastError, AiLlm, AiRole, AiRoleState, AiState } from '../net/protocol';

export const AI_ROLES: readonly AiRole[] = ['classifier', 'llm'];
export const AI_ROLE_NAME: Record<AiRole, string> = { classifier: 'Classification model', llm: 'LLM' };
/** How the toast names what stopped. */
const PAUSED_WHAT: Record<AiRole, string> = { classifier: 'classification key rejected', llm: 'LLM key rejected' };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const STATES: readonly string[] = ['off', 'incomplete', 'invalid', 'ready'];
const state = (v: unknown): AiRoleState => (typeof v === 'string' && STATES.includes(v) ? (v as AiRoleState) : 'off');
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

function classifierOf(v: Record<string, unknown>): AiClassifier {
  return { state: state(v.state), model: str(v.model), key_set: v.key_set === true, key_hint: str(v.key_hint), env: strings(v.env) };
}

function llmOf(v: Record<string, unknown>): AiLlm {
  const l: AiLlm = {
    state: state(v.state),
    base_url: str(v.base_url),
    model: str(v.model),
    key_set: v.key_set === true,
    key_hint: str(v.key_hint),
    json_mode: typeof v.json_mode === 'boolean' ? v.json_mode : null,
    env: strings(v.env),
  };
  if (isObj(v.extra_body)) l.extra_body = v.extra_body;
  return l;
}

/** A well-formed state (unknown keys dropped, so nothing else is ever kept), else null. */
export function aiStateOf(v: unknown): AiState | null {
  if (!isObj(v) || !isObj(v.classifier) || !isObj(v.llm)) return null;
  const s: AiState = { classifier: classifierOf(v.classifier), llm: llmOf(v.llm) };
  const e = v.last_error;
  if (isObj(e) && (e.role === 'classifier' || e.role === 'llm')) {
    const le: AiLastError = { role: e.role, kind: str(e.kind), message: str(e.message), at: typeof e.at === 'number' ? e.at : 0 };
    if (e.runtime === true) le.runtime = true;
    s.last_error = le;
  }
  return s;
}

/** What the HUD chip says while a role is configured but cannot be used. */
export interface AiChip {
  text: string;
  title: string;
  level: 'warn' | 'error';
}

export const roleState = (s: AiState, role: AiRole): AiRoleState => (role === 'llm' ? s.llm.state : s.classifier.state);

/** Null when nothing is wrong: every role is ready, or not configured at all. */
export function aiChip(s: AiState | null): AiChip | null {
  if (!s) return null;
  const bad = AI_ROLES.filter((r) => roleState(s, r) === 'invalid' || roleState(s, r) === 'incomplete');
  if (!bad.length) return null;
  const invalid = bad.filter((r) => roleState(s, r) === 'invalid');
  const names = bad.map((r) => AI_ROLE_NAME[r]).join(' and ');
  if (invalid.length) {
    const why = s.last_error && invalid.includes(s.last_error.role) ? ` ${s.last_error.message}` : '';
    return { text: 'AI paused', title: `${names}: not used until fixed in Settings.${why}`, level: 'error' };
  }
  return { text: 'AI setup unfinished', title: `${names}: a part is missing. Finish it in Settings.`, level: 'warn' };
}

/** The toast for a role that just stopped (ready → invalid by a feature's call); null for anything else. */
export function pausedNotice(prev: AiState | null, next: AiState): string | null {
  for (const r of AI_ROLES) {
    const was = prev ? roleState(prev, r) : 'off';
    if (was === 'invalid' || roleState(next, r) !== 'invalid') continue;
    if (next.last_error?.role !== r || !next.last_error.runtime) continue;
    return `AI integration paused: ${next.last_error.kind === 'auth_failed' ? PAUSED_WHAT[r] : `${AI_ROLE_NAME[r].toLowerCase()} stopped`}`;
  }
  return null;
}

/** The current state of the AI integration and who listens for changes. */
export class AiBook {
  /** The bridge sent an `ai` state (it has the service): the settings section can work. */
  known = false;
  /** Bumped on every change. */
  version = 0;
  private cur: AiState | null = null;
  private readonly listeners = new Set<(notice: string | null) => void>();

  get state(): AiState | null {
    return this.cur;
  }

  /** The snapshot: no toast, a reconnect is not news. */
  reset(v: unknown): void {
    this.cur = aiStateOf(v);
    this.known = this.cur !== null;
    this.version++;
    this.emit(null);
  }

  upsert(v: unknown): boolean {
    const next = aiStateOf(v);
    if (!next) return false;
    const notice = pausedNotice(this.cur, next);
    this.cur = next;
    this.known = true;
    this.version++;
    this.emit(notice);
    return true;
  }

  /** `notice` is the "paused" toast text when a call just stopped a role. Returns what removes the listener. */
  onChange(fn: (notice: string | null) => void): () => void {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }

  private emit(notice: string | null): void {
    for (const fn of [...this.listeners]) fn(notice);
  }
}

// ---- what a failed command says -------------------------------------------------------------

/** Plain words for an `ai.*` failure: what went wrong, and what to do. Never holds a key. */
export function aiFailureText(code: string, message: string): string {
  const why = message.trim();
  switch (code) {
    case 'auth_failed':
      return 'Key rejected. Check it and try again.';
    case 'no_models_endpoint':
      return 'This endpoint has no model list. Type the model id instead.';
    case 'unreachable':
      return `The endpoint cannot be reached${why ? `: ${why.replace(/^the endpoint cannot be reached:\s*/i, '')}` : ''}. Check the address.`;
    case 'timeout':
      return 'The model did not answer in time. Try again.';
    case 'bad_response':
      return `The endpoint answered something unexpected${why ? ` (${why})` : ''}. Is it OpenAI-compatible?`;
    case 'rate_limited':
      return 'The provider is rate limiting. Try again in a moment.';
    case 'provider_failed':
      return `The provider failed${why ? `: ${why.replace(/^the provider answered /i, '')}` : ''}.`;
    case 'incomplete':
      return why ? `${why[0]!.toUpperCase()}${why.slice(1)}.` : 'Fill in the missing field first.';
    case 'test_required':
      return 'Test these settings before saving them.';
    case 'env_locked':
      return 'The bridge’s environment sets that field.';
    case 'bad_request':
      return `Not accepted: ${why.replace(/^bad args:\s*/, '')}`;
    case 'unknown_command':
    case 'unsupported':
      return 'This bridge has no AI integration. Update it to use this.';
    case 'offline':
      return 'Not connected to herdr-world. Try again once it reconnects.';
    case 'disconnected':
      return 'The connection dropped before it answered. Check the state, then try again.';
  }
  return `${code}: ${why}`;
}
