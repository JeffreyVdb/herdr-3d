/**
 * #90 follow-up questions: the open questions of an agent's final message (`Worker.followup`), found by the bridge
 * with the AI integration's models (#92) once the feature is switched on, and answering them: what is picked or
 * typed per question, whether there is anything to send, and the `worker.answer_followup` args. Also the feature's
 * settings as the snapshot's `followups` and the `followups.update` events carry them (`FollowupsBook`). Pure: the
 * transcript view's card (laptop/followupCard.ts), the desk card and the Settings section use it.
 */

import type { AiRole, AiRoleState, CommandArgs, Followup, FollowupAnswer, FollowupQuestion, FollowupsFeatureState, FollowupsState, Worker } from '../net/protocol';

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const KINDS: readonly string[] = ['yes_no', 'choice', 'open'];

function validQuestion(q: unknown): q is FollowupQuestion {
  if (!isObj(q) || typeof q.id !== 'string' || !q.id || typeof q.question !== 'string' || !KINDS.includes(String(q.kind))) return false;
  if (q.kind !== 'choice') return true;
  return Array.isArray(q.options) && q.options.length > 0 && q.options.every((o) => typeof o === 'string');
}

/** A well-formed follow-up (a turn to answer and at least one question), else null. */
export function validFollowup(f: unknown): Followup | null {
  if (!isObj(f) || typeof f.turn_id !== 'string' || !f.turn_id || !Array.isArray(f.questions) || !f.questions.length) return null;
  return f.questions.every(validQuestion) ? (f as unknown as Followup) : null;
}

/** The worker's follow-up, when there is one to answer. */
export function followupOf(w: Pick<Worker, 'followup'> | null | undefined): Followup | null {
  return validFollowup(w?.followup);
}

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

/** How many: `1 question`, `3 questions`. */
export const questionsCount = (f: Followup): string => `${f.questions.length} question${f.questions.length === 1 ? '' : 's'}`;

/** The follow-up in one line, for the desk card: the question, or how many there are. */
export function followupLine(f: Followup): string {
  if (f.source === 'fallback') return 'The agent asked you something';
  if (f.questions.length === 1) return oneLine((f.questions[0] as FollowupQuestion).question);
  return `${questionsCount(f)}: ${oneLine((f.questions[0] as FollowupQuestion).question)}`;
}

/** What is chosen for one question: a value (Yes / No, an option, or null) and the typed text (Other, a note, the answer). */
export interface FollowupPick {
  value: string | null;
  text: string;
}

export const emptyFollowupPicks = (f: Followup): FollowupPick[] => f.questions.map(() => ({ value: null, text: '' }));

export const YES_NO = ['Yes', 'No'] as const;

/** Picks (or, the same again, drops) value `v` of question qi: Yes / No, or a choice's option. */
export function pickValue(f: Followup, picks: FollowupPick[], qi: number, v: string): FollowupPick[] {
  const q = f.questions[qi];
  if (!q || q.kind === 'open') return picks;
  const ok = q.kind === 'yes_no' ? (YES_NO as readonly string[]).includes(v) : (q.options ?? []).includes(v);
  if (!ok) return picks;
  return picks.map((p, i) => (i !== qi ? p : { ...p, value: p.value === v ? null : v }));
}

/** Sets the typed text of question qi (a choice's Other replaces its picked option). */
export function setText(f: Followup, picks: FollowupPick[], qi: number, text: string): FollowupPick[] {
  const q = f.questions[qi];
  if (!q) return picks;
  return picks.map((p, i) => (i !== qi ? p : { value: q.kind === 'choice' && text.trim() ? null : p.value, text }));
}

/** The answer to question qi as it will be sent (null: none). */
export function answerOf(f: Followup, picks: FollowupPick[], qi: number): FollowupAnswer | null {
  const q = f.questions[qi];
  const p = picks[qi];
  if (!q || !p) return null;
  const text = p.text.trim();
  switch (q.kind) {
    case 'yes_no':
      if (!p.value) return null;
      return text ? { id: q.id, value: p.value, note: text } : { id: q.id, value: p.value };
    case 'choice':
      if (p.value) return { id: q.id, value: p.value };
      return text ? { id: q.id, value: text } : null;
    default:
      return text ? { id: q.id, value: text } : null;
  }
}

/** Whether question qi has an answer. */
export const answeredFollowup = (f: Followup, picks: FollowupPick[], qi: number): boolean => answerOf(f, picks, qi) !== null;

/** The answers to send (the questions left unanswered are left out: the agent reads only these). */
export function followupAnswers(f: Followup, picks: FollowupPick[]): FollowupAnswer[] {
  return f.questions.map((_, i) => answerOf(f, picks, i)).filter((a): a is FollowupAnswer => a !== null);
}

/** `worker.answer_followup` args (null: nothing answered yet). */
export function answerFollowupArgs(id: string, f: Followup, picks: FollowupPick[]): CommandArgs['worker.answer_followup'] | null {
  const answers = followupAnswers(f, picks);
  return answers.length ? { id, turn_id: f.turn_id, answers } : null;
}

/** The prompt the bridge sends, as the agent will read it (docs/protocol.md "Follow-up questions"). */
export function followupPrompt(f: Followup, picks: FollowupPick[]): string {
  const join = (a: FollowupAnswer) => (a.note ? `${a.value} ${a.note}` : a.value);
  if (f.source === 'fallback' && f.questions.length === 1) {
    const a = answerOf(f, picks, 0);
    return a ? join(a) : '';
  }
  const lines = ['Answers to your open questions:'];
  f.questions.forEach((q, i) => {
    const a = answerOf(f, picks, i);
    if (a) lines.push(`${i + 1}. ${q.question} → ${join(a)}`);
  });
  return lines.length > 1 ? lines.join('\n') : '';
}

// ---- the feature's settings ------------------------------------------------------------------

const ROLE_STATES: readonly string[] = ['off', 'incomplete', 'invalid', 'ready'];
const roleState = (v: unknown): AiRoleState => (typeof v === 'string' && ROLE_STATES.includes(v) ? (v as AiRoleState) : 'off');
const FEATURE: readonly string[] = ['off', 'incomplete', 'ready'];

/** A well-formed state (unknown keys dropped), else null. */
export function followupsStateOf(v: unknown): FollowupsState | null {
  if (!isObj(v) || typeof v.enabled !== 'boolean' || typeof v.threshold !== 'number' || !FEATURE.includes(String(v.state))) return null;
  const roles = isObj(v.roles) ? v.roles : {};
  const s: FollowupsState = {
    enabled: v.enabled,
    threshold: v.threshold,
    state: v.state as FollowupsFeatureState,
    roles: { classifier: roleState(roles.classifier), llm: roleState(roles.llm) },
    env: Array.isArray(v.env) ? v.env.filter((x): x is string => typeof x === 'string') : [],
    tested: v.tested === true,
  };
  const missing = Array.isArray(v.missing) ? v.missing.filter((x): x is AiRole => x === 'classifier' || x === 'llm') : [];
  if (missing.length) s.missing = missing;
  return s;
}

/** The feature's settings and state, and who listens for changes. */
export class FollowupsBook {
  /** The bridge sent a `followups` state (it has the feature). */
  known = false;
  version = 0;
  private cur: FollowupsState | null = null;
  private readonly listeners = new Set<() => void>();

  get state(): FollowupsState | null {
    return this.cur;
  }

  reset(v: unknown): void {
    this.cur = followupsStateOf(v);
    this.known = this.cur !== null;
    this.version++;
    this.emit();
  }

  upsert(v: unknown): boolean {
    const next = followupsStateOf(v);
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

/** Plain words for a `followups.*` / `worker.*_followup` failure. */
export function followupFailureText(code: string, message: string): string {
  const why = message.trim();
  switch (code) {
    case 'test_required':
      return 'Run the test first: it has to pass with the models in use.';
    case 'incomplete':
      return 'Both models must be ready first: set them up under AI integration.';
    case 'env_locked':
      return 'The bridge’s environment switches this (HERDR_WORLD_FOLLOWUPS_ENABLED).';
    case 'stale':
      return 'These questions were answered or replaced meanwhile.';
    case 'auth_failed':
      return 'A key was rejected. Check the AI integration.';
    case 'timeout':
      return 'A model did not answer in time. Try again.';
    case 'unreachable':
      return 'A model cannot be reached. Check the AI integration.';
    case 'rate_limited':
      return 'The provider is rate limiting. Try again in a moment.';
    case 'bad_request':
      return `Not accepted: ${why.replace(/^bad args:\s*/, '')}`;
    case 'unknown_command':
    case 'unsupported':
      return 'This bridge has no follow-up questions. Update it to use this.';
    case 'offline':
      return 'Not connected to herdr-world. Try again once it reconnects.';
  }
  return why ? `${why[0]!.toUpperCase()}${why.slice(1)}` : code;
}
