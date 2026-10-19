/**
 * #66 schedule suggestions (part 5 of #61): when an agent's final message says a step must wait, the bridge's models
 * draft a schedule (`Worker.schedule_suggestion`), offered as a chip on that reply's row. Pure: the suggestion read
 * strictly (anything odd is none: the plain "Schedule follow-up…" stays), the chip's words, and the feature's settings
 * as the snapshot's `schedule_suggestions` and `schedule_suggestions.update` carry them (`ScheduleSuggestionsBook`).
 * Nothing here schedules: the chip opens the schedule form, and only its save does.
 */

import type { AiRole, AiRoleState, FollowupsFeatureState, HandoffCandidate, ScheduleSuggestion, ScheduleSuggestionsState, Worker } from '../net/protocol';
import { followupFailureText } from './followup';
import { dayClockText, utcHint } from './scheduleTime';

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

/** A well-formed suggestion (an id, a time, a title and a prompt), else null; unknown fields dropped. */
export function validSuggestion(v: unknown): ScheduleSuggestion | null {
  if (!isObj(v) || !str(v.id) || typeof v.due_at !== 'number' || !Number.isFinite(v.due_at) || v.due_at <= 0 || !str(v.title) || !str(v.draft_prompt)) return null;
  const out: ScheduleSuggestion = {
    id: v.id,
    due_at: v.due_at,
    title: v.title,
    draft_prompt: v.draft_prompt,
    score: typeof v.score === 'number' ? v.score : 0,
    at: typeof v.at === 'number' ? v.at : 0,
  };
  if (str(v.message)) out.message = v.message;
  return out;
}

/** The worker's open suggestion, when there is one. */
export function suggestionOf(w: Pick<Worker, 'schedule_suggestion'> | null | undefined): ScheduleSuggestion | null {
  return validSuggestion(w?.schedule_suggestion);
}

/** Whether the suggestion is of the candidate's row (the chip goes there; any other row keeps the plain button). */
export function suggestionFor(s: ScheduleSuggestion | null, c: HandoffCandidate | null): ScheduleSuggestion | null {
  return s && c && (s.message ?? '') === (c.message ?? '') ? s : null;
}

/**
 * The chip's time: `tomorrow 12:45` on the viewer's clock and `10:45 UTC` beside it (none when the zone is UTC), or,
 * once the time has passed, `passed`: the form then opens with the time flagged, to pick another.
 */
export function suggestionWhen(s: ScheduleSuggestion, now: number, tz: string): { when: string; utc: string; passed: boolean } {
  return { when: dayClockText(s.due_at, now, tz), utc: tz === 'UTC' ? '' : utcHint(s.due_at, tz), passed: s.due_at <= now };
}

const FEATURE: readonly string[] = ['off', 'incomplete', 'ready'];
const ROLE: readonly string[] = ['off', 'incomplete', 'invalid', 'ready'];
const roleState = (v: unknown): AiRoleState => (ROLE.includes(String(v)) ? (v as AiRoleState) : 'off');

/** The feature's state, read strictly (null: none, or malformed). */
export function scheduleSuggestionsStateOf(v: unknown): ScheduleSuggestionsState | null {
  if (!isObj(v) || typeof v.enabled !== 'boolean' || typeof v.threshold !== 'number' || !FEATURE.includes(String(v.state))) return null;
  const roles = isObj(v.roles) ? v.roles : {};
  const s: ScheduleSuggestionsState = {
    enabled: v.enabled,
    threshold: v.threshold,
    state: v.state as FollowupsFeatureState,
    roles: { classifier: roleState(roles.classifier), llm: roleState(roles.llm) },
    env: Array.isArray(v.env) ? v.env.filter((x): x is string => typeof x === 'string') : [],
  };
  const missing = Array.isArray(v.missing) ? v.missing.filter((x): x is AiRole => x === 'classifier' || x === 'llm') : [];
  if (missing.length) s.missing = missing;
  if (str(v.zone)) s.zone = v.zone;
  return s;
}

/** The feature's settings and state, and who listens for changes. */
export class ScheduleSuggestionsBook {
  /** The bridge sent a `schedule_suggestions` state (it has the feature). */
  known = false;
  version = 0;
  private cur: ScheduleSuggestionsState | null = null;
  private readonly listeners = new Set<() => void>();

  get state(): ScheduleSuggestionsState | null {
    return this.cur;
  }

  reset(v: unknown): void {
    this.cur = scheduleSuggestionsStateOf(v);
    this.known = this.cur !== null;
    this.version++;
    this.emit();
  }

  upsert(v: unknown): boolean {
    const next = scheduleSuggestionsStateOf(v);
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

/** Plain words for a `schedule_suggestions.*` / `worker.dismiss_schedule_suggestion` failure. */
export function scheduleSuggestFailureText(code: string, message: string): string {
  switch (code) {
    case 'incomplete':
      return 'Both models must be ready first: set them up under AI integration.';
    case 'env_locked':
      return 'The bridge’s environment switches this (HERDR_WORLD_SCHEDULE_SUGGESTIONS_ENABLED).';
    case 'stale':
      return 'This suggestion was used, dismissed or replaced meanwhile.';
    case 'unknown_command':
    case 'unsupported':
      return 'This bridge has no schedule suggestions. Update it to use this.';
  }
  return followupFailureText(code, message);
}
