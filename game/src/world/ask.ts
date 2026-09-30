/**
 * #57: a worker's ask — the structured question its agent's latest turn waits on (Claude's AskUserQuestion,
 * Codex's request_user_input), read by the bridge from its transcript — and answering it: the picks per
 * question, whether they answer everything, the `worker.answer_ask` args, and what a recorded answer says.
 * Pure: the transcript view's card (laptop/askCard.ts) and the quick reply where you stand use it.
 */

import type { Ask, AskAnswerArg, AskQuestion, CommandArgs, TranscriptAsk, Worker } from '../net/protocol';

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

function validQuestion(q: unknown): q is AskQuestion {
  return isObj(q) && typeof q.question === 'string' && Array.isArray(q.options) && q.options.every((o) => isObj(o) && typeof o.label === 'string');
}

/** A well-formed ask (a tool_use_id to answer and at least one question), else null. */
export function validAsk(a: unknown): Ask | null {
  if (!isObj(a) || typeof a.tool_use_id !== 'string' || !a.tool_use_id || !Array.isArray(a.questions) || !a.questions.length) return null;
  return a.questions.every(validQuestion) ? (a as unknown as Ask) : null;
}

/** The worker's ask, when there is one to answer. */
export function askOf(w: Pick<Worker, 'ask'> | null | undefined): Ask | null {
  return validAsk(w?.ask);
}

/** Who asks, as the view names it. */
export function askAgent(a: Pick<Ask, 'agent'> | Pick<TranscriptAsk, 'agent'>): string {
  return a.agent === 'codex' ? 'Codex' : 'Claude';
}

/** One question, one answer picked from its options: answerable with a digit from where you stand. */
export function isSimple(a: Ask): boolean {
  return a.questions.length === 1 && !(a.questions[0] as AskQuestion).multi;
}

const RECOMMENDED = /\s*\((recommended)\)\s*/i;

/** An option's label without its "(Recommended)", and whether it had one. */
export function optionLabel(label: string): { text: string; recommended: boolean } {
  if (!RECOMMENDED.test(label)) return { text: label, recommended: false };
  const text = label.replace(RECOMMENDED, ' ').replace(/\s+/g, ' ').trim();
  return { text: text || label, recommended: true };
}

/** What is picked for one question: option numbers (1-based) and a typed answer (null: not chosen). */
export interface AskPick {
  choices: number[];
  other: string | null;
}

export const emptyPicks = (a: Ask): AskPick[] => a.questions.map(() => ({ choices: [], other: null }));

/** Picks option n of question qi: the one answer of a single-select question, a toggle on a multi-select one. */
export function pickOption(a: Ask, picks: AskPick[], qi: number, n: number): AskPick[] {
  const q = a.questions[qi];
  if (!q || n < 1 || n > q.options.length) return picks;
  return picks.map((p, i) => {
    if (i !== qi) return p;
    if (!q.multi) return { choices: [n], other: null };
    const on = p.choices.includes(n);
    return { ...p, choices: on ? p.choices.filter((c) => c !== n) : [...p.choices, n].sort((x, y) => x - y) };
  });
}

/** Chooses (or, `text` null, drops) the typed answer of question qi; on a single-select question it replaces the option. */
export function pickOther(a: Ask, picks: AskPick[], qi: number, text: string | null): AskPick[] {
  const q = a.questions[qi];
  if (!q || !q.other) return picks;
  return picks.map((p, i) => (i !== qi ? p : q.multi ? { ...p, other: text } : { choices: text === null ? p.choices : [], other: text }));
}

/** The typed answer as it will be sent: one line, trimmed (null: none). */
export function otherText(p: AskPick): string | null {
  if (p.other === null) return null;
  const t = p.other.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  return t ? t : null;
}

/** Whether question qi has an answer. */
export function answered(a: Ask, picks: AskPick[], qi: number): boolean {
  const p = picks[qi];
  if (!p || !a.questions[qi]) return false;
  return p.choices.length > 0 || otherText(p) !== null;
}

/** Every question answered: Submit can go. */
export function complete(a: Ask, picks: AskPick[]): boolean {
  return a.questions.every((_, i) => answered(a, picks, i));
}

/** The first question without an answer (-1: none). */
export function firstUnanswered(a: Ask, picks: AskPick[]): number {
  return a.questions.findIndex((_, i) => !answered(a, picks, i));
}

/** `worker.answer_ask` args for complete picks (null otherwise). */
export function answerAskArgs(id: string, a: Ask, picks: AskPick[]): CommandArgs['worker.answer_ask'] | null {
  if (!complete(a, picks)) return null;
  const answers: AskAnswerArg[] = a.questions.map((q, i) => {
    const p = picks[i] as AskPick;
    const other = otherText(p);
    const arg: AskAnswerArg = { question: i };
    if (other !== null && !q.multi) arg.other = other;
    else {
      if (p.choices.length) arg.choices = [...p.choices];
      if (other !== null) arg.other = other;
    }
    return arg;
  });
  return { id, tool_use_id: a.tool_use_id, answers };
}

/** What the picks say for question qi, as the agent will read it (labels joined like Claude does). */
export function pickedText(a: Ask, picks: AskPick[], qi: number): string {
  const q = a.questions[qi];
  const p = picks[qi];
  if (!q || !p) return '';
  const labels = p.choices.map((n) => q.options[n - 1]?.label ?? String(n));
  const other = otherText(p);
  if (other !== null) labels.push(other);
  return labels.join(', ');
}

/** A card's recorded answers, one line per question: `question → answer` (with its notes). */
export function answeredLines(card: TranscriptAsk): Array<{ question: string; answer: string; notes?: string }> {
  const qs = Array.isArray(card.questions) ? card.questions : [];
  return (Array.isArray(card.answers) ? card.answers : [])
    .filter((x) => isObj(x) && typeof x.answer === 'string')
    .map((x) => ({ question: qs[x.question]?.question ?? '', answer: x.answer || '(nothing)', ...(x.notes ? { notes: x.notes } : {}) }));
}

/** How long it has waited: `waiting 12s`, `waiting 3m`, `waiting 1h 05m`. */
export function waitingText(since: number, now: number): string {
  if (!Number.isFinite(since) || since <= 0) return 'waiting';
  const s = Math.max(0, Math.floor((now - since) / 1000));
  if (s < 60) return `waiting ${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `waiting ${m}m`;
  return `waiting ${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

/** The ask in one line: its question, or how many there are. */
export function askLine(a: Ask): string {
  if (a.questions.length === 1) return (a.questions[0] as AskQuestion).question.replace(/\s+/g, ' ').trim();
  return `${a.questions.length} questions: ${a.questions.map((q) => q.header || q.question).join(', ')}`;
}

/** Why a digit from where you stand cannot answer it (null: it can). */
export function quickReplyBlocker(a: Ask): string | null {
  if (isSimple(a)) return null;
  const q = a.questions[0] as AskQuestion;
  return a.questions.length > 1 ? `${a.questions.length} questions` : q.multi ? 'pick several' : null;
}
