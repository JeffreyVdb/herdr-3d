/**
 * #98: "Classify unknown commands", the bridge-wide switch that lets the AI integration's classifier name the shell
 * commands the bridge's rules cannot place (the desk monitor's activity word). Its settings and state as the
 * snapshot's `activity` and the `activity.update` events carry them (`ActivitySettingsBook`). Pure: the Settings
 * section uses it.
 */

import type { ActivityFeatureState, ActivityState, AiRoleState } from '../net/protocol';

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const count = (v: unknown): number => (num(v) && v > 0 ? Math.floor(v) : 0);
const ROLE_STATES: readonly string[] = ['off', 'incomplete', 'invalid', 'ready'];
const FEATURE: readonly string[] = ['off', 'incomplete', 'ready', 'capped'];

/** The ranges the section accepts (the bridge checks again: what it refuses is a `bad_request`). */
export const ACTIVITY_LIMITS = {
  threshold: { min: 0.05, max: 0.99 },
  margin: { min: 0, max: 0.99 },
  daily_cap: { min: 1, max: 1_000_000 },
} as const;

/** A well-formed state (unknown keys dropped), else null. */
export function activityStateOf(v: unknown): ActivityState | null {
  if (!isObj(v) || typeof v.model_enabled !== 'boolean' || !num(v.threshold) || !num(v.margin) || !num(v.daily_cap) || !FEATURE.includes(String(v.state))) return null;
  return {
    model_enabled: v.model_enabled,
    threshold: v.threshold,
    margin: v.margin,
    daily_cap: Math.floor(v.daily_cap),
    calls_today: count(v.calls_today),
    cache_size: count(v.cache_size),
    state: v.state as ActivityFeatureState,
    classifier: typeof v.classifier === 'string' && ROLE_STATES.includes(v.classifier) ? (v.classifier as AiRoleState) : 'off',
    env: Array.isArray(v.env) ? v.env.filter((x): x is string => typeof x === 'string') : [],
  };
}

/** The feature's settings and state, and who listens for changes. */
export class ActivitySettingsBook {
  /** The bridge sent an `activity` state (it has the feature). */
  known = false;
  version = 0;
  private cur: ActivityState | null = null;
  private readonly listeners = new Set<() => void>();

  get state(): ActivityState | null {
    return this.cur;
  }

  reset(v: unknown): void {
    this.cur = activityStateOf(v);
    this.known = this.cur !== null;
    this.version++;
    this.emit();
  }

  upsert(v: unknown): boolean {
    const next = activityStateOf(v);
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

/** Plain words for an `activity.*` failure. */
export function activityFailureText(code: string, message: string): string {
  const why = message.trim();
  switch (code) {
    case 'env_locked':
      return 'The bridge’s environment switches this (HERDR_WORLD_ACTIVITY_MODEL).';
    case 'bad_request':
      return `Not accepted: ${why.replace(/^bad args:\s*/, '')}`;
    case 'unknown_command':
    case 'unsupported':
      return 'This bridge cannot classify unknown commands. Update it to use this.';
    case 'offline':
      return 'Not connected to herdr-world. Try again once it reconnects.';
  }
  return why ? `${why[0]!.toUpperCase()}${why.slice(1)}` : code;
}
