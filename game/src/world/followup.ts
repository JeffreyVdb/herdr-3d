/**
 * #90 follow-up questions: the open questions of an agent's final message (`Worker.followup`), found by the bridge
 * with the AI integration's models (#92) once the feature is switched on, and answering them: what is picked or
 * typed per question, whether there is anything to send, and the `worker.answer_followup` args. Also the feature's
 * settings as the snapshot's `followups` and the `followups.update` events carry them (`FollowupsBook`). Pure: the
 * transcript view's card (laptop/followupCard.ts), the desk card and the Settings section use it.
 */

import type { AiRole, AiRoleState, CommandArgs, Followup, FollowupAnswer, FollowupQuestion, FollowupRecommendation, FollowupsFeatureState, FollowupsState, Worker } from '../net/protocol';

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const KINDS: readonly string[] = ['yes_no', 'choice', 'open'];
const SOURCES: readonly string[] = ['parsed', 'model', 'fallback'];
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined);
const count = (v: unknown): number | undefined => (typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : undefined);

/** A question as the card can use it (#60's fields only when well-formed: an older bridge sends none), else null. */
function questionOf(q: unknown): FollowupQuestion | null {
  if (!isObj(q) || typeof q.id !== 'string' || !q.id || typeof q.question !== 'string' || !KINDS.includes(String(q.kind))) return null;
  const out: FollowupQuestion = { id: q.id, question: q.question, kind: q.kind as FollowupQuestion['kind'] };
  if (q.kind === 'choice') {
    if (!Array.isArray(q.options) || !q.options.length || !q.options.every((o) => typeof o === 'string')) return null;
    out.options = q.options as string[];
  }
  const label = str(q.label);
  if (label) out.label = label;
  const context = str(q.context);
  if (context) out.context = context;
  const r = q.recommendation;
  const text = isObj(r) ? str(r.text) : undefined;
  if (isObj(r) && text) {
    const rec: FollowupRecommendation = { text };
    const why = str(r.why);
    if (why) rec.why = why;
    if (typeof r.option === 'number' && Number.isInteger(r.option) && r.option >= 0 && r.option < (out.options?.length ?? 0)) rec.option = r.option;
    out.recommendation = rec;
  }
  return out;
}

/** A well-formed follow-up (a turn to answer and at least one question), else null; unknown fields dropped. */
export function validFollowup(f: unknown): Followup | null {
  if (!isObj(f) || typeof f.turn_id !== 'string' || !f.turn_id || !Array.isArray(f.questions) || !f.questions.length) return null;
  const questions = f.questions.map(questionOf);
  if (!questions.every((q): q is FollowupQuestion => q !== null)) return null;
  const out: Followup = {
    turn_id: f.turn_id,
    questions,
    score: typeof f.score === 'number' ? f.score : 0,
    source: SOURCES.includes(String(f.source)) ? (f.source as Followup['source']) : 'model',
    at: typeof f.at === 'number' ? f.at : 0,
  };
  const tail = str(f.tail);
  if (tail) out.tail = tail;
  const error = str(f.error);
  if (error) out.error = error;
  const unlisted = count(f.unlisted);
  if (unlisted) out.unlisted = unlisted;
  const retries = count(f.retries);
  if (retries) out.retries = retries;
  return out;
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

/** How a question is named: its label (`Q9`), else its number. */
export const questionName = (f: Followup, qi: number): string => f.questions[qi]?.label ?? String(qi + 1);

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

/** `worker.answer_followup` args (null: nothing answered yet, and no note). */
export function answerFollowupArgs(id: string, f: Followup, picks: FollowupPick[], note = ''): CommandArgs['worker.answer_followup'] | null {
  const answers = followupAnswers(f, picks);
  const n = note.trim();
  if (!answers.length && !n) return null;
  return n ? { id, turn_id: f.turn_id, answers, note: n } : { id, turn_id: f.turn_id, answers };
}

// ---- #60: the agent's recommendations ------------------------------------------------------------

/**
 * What accepting question qi's recommendation picks: a choice's option it names (else its text, as the typed answer),
 * Yes / No when the text starts with one, an open question's whole text. Null: it has none, or it is a yes / no
 * question whose recommendation says neither (the card shows it, to read).
 */
export function recommendedPick(f: Followup, qi: number): FollowupPick | null {
  const q = f.questions[qi];
  const r = q?.recommendation;
  if (!q || !r) return null;
  switch (q.kind) {
    case 'choice': {
      const o = r.option !== undefined ? q.options?.[r.option] : undefined;
      return o !== undefined ? { value: o, text: '' } : { value: null, text: r.text.trim() };
    }
    case 'yes_no': {
      const m = /^[\s*_]*(yes|no)\b/i.exec(r.text);
      return m ? { value: m[1]!.toLowerCase() === 'yes' ? 'Yes' : 'No', text: '' } : null;
    }
    default:
      return { value: null, text: r.text.trim() };
  }
}

/** Accepts question qi's recommendation (it replaces what was picked or typed there): the picks, unchanged when there is none. */
export function acceptRecommendation(f: Followup, picks: FollowupPick[], qi: number): FollowupPick[] {
  const r = recommendedPick(f, qi);
  return r ? picks.map((p, i) => (i === qi ? r : p)) : picks;
}

/** Accepts every recommendation of a question still unanswered (answers you gave stay): the picks, and how many it filled. */
export function acceptAllRecommendations(f: Followup, picks: FollowupPick[]): { picks: FollowupPick[]; filled: number } {
  let filled = 0;
  const next = picks.map((p, i) => {
    if (answeredFollowup(f, picks, i)) return p;
    const r = recommendedPick(f, i);
    if (!r) return p;
    filled++;
    return r;
  });
  return { picks: next, filled };
}

/** How many unanswered questions a recommendation could fill. */
export const recommendationsLeft = (f: Followup, picks: FollowupPick[]): number =>
  f.questions.filter((_, i) => !answeredFollowup(f, picks, i) && recommendedPick(f, i) !== null).length;

/** Whether question qi's answer is its recommendation as it was (the bridge then tells the agent so). */
export function isRecommended(f: Followup, picks: FollowupPick[], qi: number): boolean {
  const q = f.questions[qi];
  const r = q?.recommendation;
  const a = answerOf(f, picks, qi);
  if (!q || !r || !a || a.note) return false;
  if (q.kind === 'choice' && r.option !== undefined) return a.value === q.options?.[r.option];
  return q.kind === 'open' && a.value === r.text.trim();
}

/** The questions left unanswered, by name (`Q12`, or a number). */
export const unansweredNames = (f: Followup, picks: FollowupPick[]): string[] => f.questions.map((_, i) => i).filter((i) => !answeredFollowup(f, picks, i)).map((i) => questionName(f, i));

/** The prompt the bridge sends, as the agent will read it (docs/protocol.md "Follow-up questions", "Answering"). */
export function followupPrompt(f: Followup, picks: FollowupPick[], note = ''): string {
  const join = (a: FollowupAnswer) => (a.note ? `${a.value} ${a.note}` : a.value);
  const extra = note.replace(/\r\n/g, '\n').trim();
  const withNote = (s: string) => (!extra ? s : !s ? extra : `${s}\n\n${extra}`);
  if (f.source === 'fallback' && f.questions.length === 1) {
    const a = answerOf(f, picks, 0);
    return withNote(a ? join(a) : '');
  }
  const lines = ['Answers to your open questions:'];
  f.questions.forEach((q, i) => {
    const a = answerOf(f, picks, i);
    if (!a) return;
    const v = join(a) + (isRecommended(f, picks, i) ? ' (your recommendation)' : '');
    lines.push(q.label ? `- ${q.label} ${q.question} → ${v}` : `${i + 1}. ${q.question} → ${v}`);
  });
  if (lines.length === 1 && !extra) return '';
  const left = unansweredNames(f, picks);
  if (left.length) lines.push(`Unanswered: ${left.join(', ')}`);
  return withNote(lines.join('\n'));
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
