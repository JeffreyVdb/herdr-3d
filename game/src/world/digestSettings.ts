/**
 * #118 floor overview summaries: the bridge-wide switch that lets the configured LLM write the floor overview's task
 * and now lines. Its settings and state as the snapshot's `digest` and the `digest.update` events carry them
 * (`DigestBook`). Pure: the Settings section uses it.
 */

import type { AiRole, AiRoleState, DigestFeatureState, DigestState } from '../net/protocol';
import { followupFailureText } from './followup';

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const ROLE_STATES: readonly string[] = ['off', 'incomplete', 'invalid', 'ready'];
const FEATURE: readonly string[] = ['off', 'incomplete', 'ready'];

/** The daily cap the section accepts (the bridge checks again: what it refuses is a `bad_request`). */
export const DIGEST_CAP = { min: 1, max: 10_000 } as const;

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
  }
  return followupFailureText(code, message);
}
