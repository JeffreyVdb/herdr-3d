/**
 * M5: answering a blocked worker from where you stand. The digit keys pick
 * one of its question's numbered choices. Approve is the choice that says
 * yes (its label starts with Yes, Trust, Allow, Proceed or Continue: Claude's
 * trust dialog lists "No, exit" first), else the first choice unless that one
 * says no; Deny is the menu's "No" choice when it has one, else a cancel (Esc
 * on the pane). Pure.
 */

import type { CommandArgs, Question, QuestionChoice } from '../net/protocol';

export type Pick = { choice: number } | { cancel: true };

export interface AnswerKeys {
  /** The choice Approve picks (the one that says yes, else the first unless it says no), null when none. */
  approve: QuestionChoice | null;
  /** What Deny sends: the "No" choice, else a cancel. */
  deny: Pick;
  /** The "No" choice Deny picks, when there is one. */
  denyChoice: QuestionChoice | null;
}

const isNo = (label: string) => /^\s*(no|quit|exit)\b/i.test(label);
const isYes = (label: string) => /^\s*(yes|trust|allow|proceed|continue|approve)\b/i.test(label);

const validQuestion = (q: unknown): q is Question =>
  typeof q === 'object' && q !== null && typeof (q as Question).hash === 'string' && (q as Question).hash !== '' && Array.isArray((q as Question).choices);

/** A worker's question when it can be answered (a hash to answer), else null. */
export function answerable(q: Question | undefined | null): Question | null {
  return validQuestion(q) ? q : null;
}

/** The numbered choices, in order, well formed (1–9, labelled). */
export function choicesOf(q: Question): QuestionChoice[] {
  return q.choices.filter((c) => Number.isInteger(c?.n) && c.n >= 1 && c.n <= 9 && typeof c.label === 'string').sort((a, b) => a.n - b.n);
}

export function answerKeys(q: Question): AnswerKeys {
  const cs = choicesOf(q);
  const no = cs.length > 1 ? (cs.find((c) => isNo(c.label)) ?? null) : null;
  const first = cs[0] ?? null;
  const approve = cs.find((c) => isYes(c.label)) ?? (first && first !== no ? first : null);
  return { approve, deny: no ? { choice: no.n } : { cancel: true }, denyChoice: no };
}

/** The question as one line: its text, else the last excerpt line that asks something, else the last one with words. */
export function questionLine(q: Question): string {
  const t = q.text.trim();
  if (t) return t;
  const ex = Array.isArray(q.excerpt) ? q.excerpt.map((l) => String(l).trim()).filter((l) => /\p{L}/u.test(l)) : [];
  return [...ex].reverse().find((l) => l.includes('?')) ?? ex[ex.length - 1] ?? '';
}

/** `worker.answer` args for a digit key (null when the question has no such choice). */
export function digitPick(q: Question, digit: number): Pick | null {
  return choicesOf(q).some((c) => c.n === digit) ? { choice: digit } : null;
}

export function answerArgs(id: string, q: Question, pick: Pick): CommandArgs['worker.answer'] {
  return 'choice' in pick ? { id, hash: q.hash, choice: pick.choice } : { id, hash: q.hash, cancel: true };
}

/** What a pick says in feedback: `1. Yes`, or `Esc` for a cancel. */
export function pickLabel(q: Question, pick: Pick): string {
  if (!('choice' in pick)) return 'Esc (dismissed)';
  const c = choicesOf(q).find((x) => x.n === pick.choice);
  return c ? `${c.n}. ${c.label}` : String(pick.choice);
}
