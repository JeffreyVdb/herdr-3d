/**
 * M5: the P prompt overlay's rules: who can be prompted (an agent on an
 * awake floor that is not waiting on a question, on a bridge that knows
 * `worker.prompt`) and what text goes (1 byte to 16 KiB, no NUL). Pure.
 */

import { answerable } from './answer';
import { askOf, isSimple } from './ask';
import { asyncBlockedOnly } from './codexQuestions';
import type { FloorView, WorkerView } from './store';

export const PROMPT_MAX_BYTES = 16 * 1024;

/** Why `v` cannot be prompted now, null when it can. */
export function promptBlocker(v: WorkerView | null, floor: Pick<FloorView, 'asleep' | 'transition'> | null, unsupported: boolean): string | null {
  if (!v) return 'That worker is no longer on the floor.';
  if (unsupported) return 'This herdr-world can’t send prompts yet. Update the bridge to use it.';
  if (floor?.transition === 'waking') return `${v.worker.session} is waking up: prompt ${v.name} once it is awake.`;
  if (floor?.transition === 'sleeping') return `${v.worker.session} is going to sleep.`;
  if (floor?.asleep) return `${v.worker.session} is asleep. Wake it from the elevator (L) to prompt ${v.name}.`;
  if (!v.worker.agent_kind && !v.harness) return `${v.name} is a plain shell, not a coding agent: sit at its laptop (E) to type there.`;
  // #57: an agent waiting on its structured question takes no prompt either (its dialog would get the text).
  const ask = askOf(v.worker);
  if (ask) {
    return isSimple(ask)
      ? `${v.name} is asking a question first: pick an answer on its card (1–${Math.min(ask.questions[0]?.options.length ?? 1, 9)}, 0 dismisses) or at its laptop (E).`
      : `${v.name} is asking ${ask.questions.length > 1 ? `${ask.questions.length} questions` : 'a question'} first: answer at its laptop (E).`;
  }
  // The bridge refuses a prompt while the agent waits on its screen (invalid_state): the question comes first.
  // (M6: an over-cap orchestrator needs you too, but its agent waits for exactly that prompt.) #157: not a Codex
  // worker blocked only by an async question: it works on, and the bridge queues the prompt through its app-server.
  if (v.worker.status === 'blocked' && !asyncBlockedOnly(v.worker)) {
    const n = answerable(v.worker.question)?.choices.length ?? 0;
    return n
      ? `${v.name} is waiting for an answer first: pick one on its card (${n === 1 ? '1' : `1–${Math.min(n, 9)}`}, 0 denies).`
      : `${v.name} is waiting on its screen: answer there (sit at its laptop, E), or 0 dismisses it.`;
  }
  return null;
}

/** Why `text` cannot be sent, null when it can. */
export function promptTextError(text: string): string | null {
  if (!text.trim()) return 'Write something first.';
  if (text.includes('\0')) return 'The text has a NUL character in it.';
  const n = new TextEncoder().encode(text).length;
  if (n > PROMPT_MAX_BYTES) return `Too long: ${Math.ceil(n / 1024)} KiB, the most is 16 KiB.`;
  return null;
}

/** The worker is mid-turn: the agent takes the prompt on its next turn (queued). */
export function willQueue(v: WorkerView | null): boolean {
  return v?.display === 'working';
}
