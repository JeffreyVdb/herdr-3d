/**
 * #157: a shared Codex worker's async questions (docs/protocol.md "Codex async questions") as the game shows them.
 * Codex asks them with `request_user_input_async` and goes on working; herdr shows the worker `blocked` while the
 * asking turn runs. The bridge says when that `blocked` is only such a question's (`codex.async_blocked`: attached, no
 * approval or blocking question open), and then the worker keeps its working status (`effectiveStatus`) with a cue of
 * how many of its questions want an answer (`asyncAttention`). Also the transcript card's model: its batches (a twin
 * pair shown as one), what each question's state says from the bridge's evidence only, and the checks the bridge
 * makes of an answer. Pure: the store, the prompt overlay, the crew, the desk card and the transcript card use it.
 */

import type { CodexBatch, CodexQuestion, CommandArgs, Worker, WorkerCodex } from '../net/protocol';

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const STATES: readonly string[] = ['pending', 'sending', 'sent', 'answered', 'dismissed'];

type WithCodex = { codex?: WorkerCodex | null | undefined };

/** The worker's codex launch when it is a shared one (its own app-server, which the bridge joins), else null. */
export function sharedCodex(w: WithCodex | null | undefined): WorkerCodex | null {
  const c = w?.codex;
  return isObj(c) && c.mode === 'shared' ? c : null;
}

/**
 * herdr says `blocked`, and the bridge says that is only an async question's: the agent goes on working, a prompt
 * still goes in (through the app-server, queued), and nothing waits on a key press. A real block (an approval, a
 * blocking question open as a server request) keeps `async_blocked` false.
 */
export function asyncBlockedOnly(w: Pick<Worker, 'status'> & WithCodex): boolean {
  return w.status === 'blocked' && sharedCodex(w)?.async_blocked === true;
}

/** The status the game goes by: `working` for a worker blocked only by an async question, else herdr's. */
export function effectiveStatus(w: Pick<Worker, 'status'> & WithCodex): string {
  return asyncBlockedOnly(w) ? 'working' : w.status;
}

function validQuestion(q: unknown, i: number): q is CodexQuestion {
  return isObj(q) && q.index === i && typeof q.title === 'string' && STATES.includes(String(q.state)) && (q.options === undefined || (Array.isArray(q.options) && q.options.every((o) => typeof o === 'string')));
}

function validBatch(b: unknown): b is CodexBatch {
  return isObj(b) && typeof b.batch === 'string' && !!b.batch && Array.isArray(b.questions) && b.questions.length > 0 && b.questions.every(validQuestion);
}

/** The worker's well-formed batches, oldest first (a malformed one is left out). */
function batchesOf(c: WorkerCodex | null): CodexBatch[] {
  return c && Array.isArray(c.questions) ? c.questions.filter(validBatch) : [];
}

/** Still Codex's to read and nothing of ours is on its way: asked and not answered, or sent and dropped (undelivered). */
export function wantsAnswer(q: CodexQuestion): boolean {
  return q.state === 'pending' || (q.state === 'sent' && q.undelivered === true);
}

/** Why a card cannot answer a batch: live and history disagree on it, or the bridge is not joined to the thread. */
export type ReadOnly = 'conflict' | 'detached' | null;

/** One card: a batch (a twin pair is one card: the one seen first, answered with its own id). */
export interface AsyncCardBatch {
  /** Its key across upserts, replays and reconnects: `thread` + `batch`. */
  key: string;
  thread: string;
  /** The id `worker.answer_async` names. */
  batch: string;
  /** The twin shown in this card (null: none). */
  twin: string | null;
  turn: string;
  /** When the bridge first saw it (unix ms, bridge clock). */
  at: number;
  questions: CodexQuestion[];
  readOnly: ReadOnly;
}

/**
 * The card's batches, oldest first. A `twin` pair (one id seen live, the other only in the history, the same questions)
 * is one card: the batch seen first, each of its questions answered when the twin's is (an answer recorded under the
 * other id is still an answer). A `conflict` batch, or every batch while the bridge is not joined to the
 * thread, is read-only (answer in the terminal). A legacy worker has none.
 */
export function asyncBatches(w: WithCodex | null | undefined): AsyncCardBatch[] {
  const c = sharedCodex(w);
  const thread = typeof c?.thread === 'string' ? c.thread : '';
  if (!c || !thread) return [];
  const all = batchesOf(c);
  const byId = new Map(all.map((b) => [b.batch, b]));
  const folded = new Set<string>();
  const out: AsyncCardBatch[] = [];
  for (const b of all) {
    if (folded.has(b.batch)) continue;
    const t = typeof b.twin === 'string' ? byId.get(b.twin) : undefined;
    let questions = b.questions;
    if (t && t.questions.length === b.questions.length) {
      folded.add(t.batch);
      questions = b.questions.map((q, i) => {
        const o = t.questions[i] as CodexQuestion;
        return o.state === 'answered' && q.state !== 'answered' ? { ...o, index: q.index } : q;
      });
    }
    out.push({
      key: `${thread}\u0000${b.batch}`,
      thread,
      batch: b.batch,
      twin: t && folded.has(t.batch) ? t.batch : null,
      turn: typeof b.turn === 'string' ? b.turn : '',
      at: typeof b.at === 'number' && Number.isFinite(b.at) ? b.at : 0,
      questions,
      readOnly: b.conflict === true || t?.conflict === true ? 'conflict' : c.attached === true ? null : 'detached',
    });
  }
  return out;
}

/** How many of a shared worker's questions want an answer (each twin pair counted once; hidden ones not at all). */
export function asyncAttention(w: WithCodex | null | undefined): number {
  let n = 0;
  for (const b of asyncBatches(w)) for (const q of b.questions) if (wantsAnswer(q)) n++;
  return n;
}

/** The first question that wants an answer, in one line (empty: none). */
export function asyncLine(w: WithCodex | null | undefined): string {
  for (const b of asyncBatches(w)) for (const q of b.questions) if (wantsAnswer(q)) return q.title.replace(/\s+/g, ' ').trim();
  return '';
}

/** `1 question`, `3 questions`. */
export const questionWord = (n: number): string => `${n} question${n === 1 ? '' : 's'}`;

/** The cue beside a working worker: `asks 2 questions`. */
export const askingText = (n: number): string => `asks ${questionWord(n)}`;

/** What the card says of a question's reply, from what the bridge has seen. */
export type ReplyPhase = 'open' | 'failed' | 'sending' | 'sent' | 'unconfirmed' | 'undelivered' | 'answered' | 'hidden';

export function replyPhase(q: CodexQuestion): ReplyPhase {
  switch (q.state) {
    case 'dismissed':
      return 'hidden';
    case 'answered':
      return 'answered';
    case 'sending':
      return 'sending';
    case 'sent':
      return q.undelivered ? 'undelivered' : q.unconfirmed ? 'unconfirmed' : 'sent';
    default:
      return q.error ? 'failed' : 'open';
  }
}

/**
 * The reply's state in words, as the protocol establishes it (docs/research/codex-shared-tui.md §11): accepted is not
 * read, a steer whose turn ended first is dropped, `other` is anyone but herdr-3d. Empty: nothing sent yet.
 */
export function phaseText(q: CodexQuestion): string {
  switch (replyPhase(q)) {
    case 'failed':
      return `Not sent: ${(q.error ?? '').trim() || 'Codex refused it'}. Your answer is kept: send it again.`;
    case 'sending':
      return 'Sending…';
    case 'sent':
      return 'Sent — Codex will read it with its next step';
    case 'unconfirmed':
      return 'Sent, not confirmed: no reply came from Codex’s server, so it is not sent again';
    case 'undelivered':
      return 'Not delivered — the turn ended before Codex read it. Your answer is kept: send it again.';
    case 'answered':
      return q.answered_by === 'other' ? 'Answered elsewhere' : 'Answered';
    case 'hidden':
      return 'Hidden here: Codex still has it';
    default:
      return '';
  }
}

/** The polite announcement of a reply's new state (null: nothing to say). */
export function phaseAnnouncement(q: CodexQuestion): string | null {
  switch (replyPhase(q)) {
    case 'sending':
      return 'Sending your answer.';
    case 'sent':
      return 'Answer sent. Codex will read it with its next step.';
    case 'unconfirmed':
      return 'Answer sent, not confirmed.';
    case 'undelivered':
      return 'Answer not delivered: the turn ended before Codex read it.';
    case 'answered':
      return q.answered_by === 'other' ? 'Question answered elsewhere.' : 'Question answered.';
    case 'failed':
      return `Answer not sent: ${(q.error ?? '').trim() || 'Codex refused it'}.`;
    default:
      return null;
  }
}

/** The bridge's limit of one answer (bytes of UTF-8). */
export const ASYNC_ANSWER_MAX = 4096;

/** The bridge's limit of one suggested answer on the wire (bytes of UTF-8): a longer one comes cut to it, `truncated`. */
export const ASYNC_OPTION_MAX = 1000;

/**
 * Was one of q's suggested answers cut on its way here? The question says one of its texts was (`truncated`), and an
 * option is as long as a cut one can be (within a character of the limit). The bridge checks a reply against the
 * whole option, which the game never saw: such a question is answered in the terminal.
 */
export function cutOptions(q: Pick<CodexQuestion, 'options' | 'truncated'>): boolean {
  if (!q.truncated) return false;
  const enc = new TextEncoder();
  return (q.options ?? []).some((o) => enc.encode(o).length > ASYNC_OPTION_MAX - 4);
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
// What Go's unicode.IsControl calls a control character (C0, DEL, C1), but the line end and the tab.
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;

/**
 * Why `text` cannot go as the answer to `q` (null: it can), checked as the bridge does: a question with suggested
 * answers takes one of them exactly; one without takes 1–4096 bytes of UTF-8 that are not blank, without control
 * characters but line ends and tabs.
 */
export function answerProblem(q: Pick<CodexQuestion, 'options'>, text: string): string | null {
  const opts = q.options ?? [];
  if (opts.length) return opts.includes(text) ? null : 'Pick one of the suggested answers.';
  if (!text.trim()) return 'Write an answer first.';
  if (LONE_SURROGATE.test(text)) return 'The answer has a broken character in it.';
  if (CONTROL.test(text)) return 'The answer has a control character in it: only line breaks and tabs can go.';
  const n = new TextEncoder().encode(text).length;
  if (n > ASYNC_ANSWER_MAX) return `Too long: ${n} bytes, the most is ${ASYNC_ANSWER_MAX}.`;
  return null;
}

/** `worker.answer_async`'s args: the answered questions of one batch, in index order. */
export function answerAsyncArgs(id: string, b: Pick<AsyncCardBatch, 'thread' | 'batch'>, answers: ReadonlyArray<{ index: number; answer: string }>): CommandArgs['worker.answer_async'] {
  return { id, thread: b.thread, batch: b.batch, answers: [...answers].sort((x, y) => x.index - y.index).map((a) => ({ index: a.index, answer: a.answer })) };
}
