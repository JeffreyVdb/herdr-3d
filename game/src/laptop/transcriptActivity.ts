import type { TranscriptItem } from '../net/protocol';

/**
 * #58: what the transcript view says the agent is doing right now, and the prompts you sent that its transcript has not
 * shown yet. Pure: `transcriptMode.ts` keeps the state, `transcriptRender.ts` draws it. The rules come from the spike
 * (docs/research/transcript-activity.md): the cue is derived from herdr's `status` and the last items, never from the
 * bridge (a `thinking` item is history: the CLIs write it once the reasoning is done).
 */

/** The live cue at the bottom of the timeline: its word and since when (unix ms, the bridge's `status_since`). */
export interface ActivityCue {
  kind: 'thinking' | 'working';
  since: number;
}

/** Notices, compaction markers, hidden lines and unknown entries say nothing about what the agent does. */
const meaningful = (it: TranscriptItem) => !it.hidden && (it.kind === 'user' || it.kind === 'assistant' || it.kind === 'thinking' || it.kind === 'tool' || it.kind === 'subagent');

/** A row that shows its own live state ("Still running…" and a ticking time): the cue does not double it. */
const speaks = (it: TranscriptItem) => (it.kind === 'tool' && it.tool?.status === 'running') || (it.kind === 'subagent' && it.subagent?.status === 'running');

/**
 * The cue for a worker (null: none). Only while `working`: idle / done have nothing to say, blocked has the banner.
 * `mark` is the current turn's start (the highest `seq` when the status last became working, or at your own send): only
 * later items say what the turn does, so the previous turn's text never reads as "Working…". Without one (you sat down
 * at a worker already at work) the last item is taken as it is.
 */
export function activityCue(items: readonly TranscriptItem[], status: string, since: number, mark: number | null): ActivityCue | null {
  if (status !== 'working') return null;
  let last: TranscriptItem | null = null;
  let running = false;
  for (const it of items) {
    if (!meaningful(it) || (mark !== null && it.seq <= mark)) continue;
    if (mark !== null && speaks(it)) running = true;
    if (!last || it.seq > last.seq) last = it;
  }
  if (running || (last && speaks(last))) return null;
  // The agent writing (or about to call a tool) is "Working…"; everything else, reasoning included, is "Thinking…".
  return { kind: last?.kind === 'assistant' ? 'working' : 'thinking', since };
}

/** The highest `seq` of the timeline (0: none). */
export function topSeq(items: readonly TranscriptItem[]): number {
  let n = 0;
  for (const it of items) if (Number.isFinite(it.seq) && it.seq > n) n = it.seq;
  return n;
}

// ---- pending prompts ---------------------------------------------------------------------------

/**
 * A prompt you sent from this view, until its `user` item arrives: `sending` (no ack yet), `sent`, `queued` (the agent
 * was working: it takes it when it can, mid-turn for both CLIs), `refused` (not sent, with the bridge's reason). `late`
 * says it was sent but the transcript has not shown it for a while (a hint, not an error: it may still come).
 */
export interface PendingPrompt {
  id: string;
  text: string;
  state: 'sending' | 'sent' | 'queued' | 'refused';
  late: boolean;
  /** Why it was refused. */
  reason?: string;
  /** The timeline's highest `seq` when it was sent: its item comes after. */
  mark: number;
  /** When the "not seen yet" hint shows (unix ms; null: not while the agent is still busy with it). */
  due: number | null;
}

/** A sent prompt's `user` item should be here by then (the bridge reads a watched transcript every second). */
export const SENT_TIMEOUT_MS = 15_000;

const IMAGE_MARKER = /\[Image #\d+: [^\]\n]+\]/g;

/** How both CLIs write a prompt: trimmed, the inside kept; line ends as LF. The images are compared apart (the bridge
 * turns each `[Image #n: path]` marker into an image part). */
export function promptKey(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(IMAGE_MARKER, '').trim();
}

/** The same with all runs of white space as one space: what is left between image markers may differ in its blanks. */
const loose = (key: string) => key.replace(/\s+/g, ' ');

/** A `user` item's text, as `promptKey` has it. */
export function itemKey(it: TranscriptItem): string {
  const text = (it.parts ?? []).map((p) => (p && typeof p === 'object' && 'text' in p && typeof p.text === 'string' ? p.text : '')).join('');
  return promptKey(text);
}

/** How an item that took a prompt is known again: its `id`, and its place with its text (should a resync give it another id). */
const marks = (it: TranscriptItem, key: string) => [`id:${it.id}`, `at:${it.seq}\u0000${key}`];

/**
 * The prompts that `items` (new or updated) show, removed: each `user` item after a prompt's mark takes the first
 * waiting prompt with its text (identical prompts in the order sent), else the first with the same words. Refused
 * prompts never match. `taken` holds the items that already took one, and gets the ones that take one now: an item
 * takes one prompt only, however often it comes again (an update, a resync's whole timeline). Returns the prompts still
 * waiting (the same array when nothing matched).
 */
export function reconcile(pending: readonly PendingPrompt[], items: readonly TranscriptItem[], taken: Set<string> = new Set()): readonly PendingPrompt[] {
  if (!pending.length) return pending;
  const users = items.filter((it) => it.kind === 'user' && !it.hidden).sort((a, b) => a.seq - b.seq);
  if (!users.length) return pending;
  let left = [...pending];
  let hit = false;
  for (const it of users) {
    const key = itemKey(it);
    const known = marks(it, key);
    if (known.some((k) => taken.has(k))) continue;
    const open = (p: PendingPrompt) => p.state !== 'refused' && it.seq > p.mark;
    let at = left.findIndex((p) => open(p) && promptKey(p.text) === key);
    if (at < 0) at = left.findIndex((p) => open(p) && loose(promptKey(p.text)) === loose(key));
    if (at < 0) continue;
    left = left.filter((_, i) => i !== at);
    for (const k of known) taken.add(k);
    hit = true;
  }
  return hit ? left : pending;
}
