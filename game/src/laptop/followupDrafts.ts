import { Drafts, type DraftStorage } from '../ui/drafts';
import type { FollowupPick } from '../world/followup';

/** What you picked and wrote for one follow-up: by question id, and the round's note. */
export interface FollowupDraft {
  picks: Record<string, FollowupPick>;
  note: string;
  /** The follow-up's source when it was written: a fallback's free answer is no answer to a question read later. */
  source: string;
}

/**
 * #60: what you picked and wrote for a worker's follow-up questions, kept above the transcript view: by worker and the
 * turn they were asked in, so it outlives a re-render, the upsert of a retry (whose questions replace the fallback's),
 * a reconnect and its snapshot, standing up, and the terminal toggle (which unmounts the view). Kept like the other
 * drafts (`Drafts`, namespace `followup`: memory, and storage where it is allowed), one per worker: another turn's
 * follow-up starts afresh and replaces it. It goes once the answers were sent or the questions dismissed.
 */
export class FollowupDrafts {
  private readonly store: Drafts;

  constructor(storage?: DraftStorage | null) {
    this.store = storage !== undefined ? new Drafts('followup', storage) : new Drafts('followup');
  }

  /** The draft of worker's follow-up of turn (null: none, or another turn's). */
  get(worker: string, turn: string): FollowupDraft | null {
    const d = this.store.get(worker);
    if (!d || d.fields?.turn !== turn) return null;
    const picks: Record<string, FollowupPick> = {};
    for (const [k, v] of Object.entries(d.fields ?? {})) {
      if (!k.startsWith('q:')) continue;
      try {
        const p = JSON.parse(v) as { value?: unknown; text?: unknown };
        picks[k.slice(2)] = { value: typeof p.value === 'string' ? p.value : null, text: typeof p.text === 'string' ? p.text : '' };
      } catch {
        /* not one: left out */
      }
    }
    return { picks, note: d.text, source: d.fields?.source ?? '' };
  }

  set(worker: string, turn: string, d: FollowupDraft): void {
    const fields: Record<string, string> = {};
    for (const [id, p] of Object.entries(d.picks)) if (p.value !== null || p.text.trim()) fields[`q:${id}`] = JSON.stringify(p);
    if (!Object.keys(fields).length && !d.note.trim()) {
      this.clear(worker, turn);
      return;
    }
    this.store.set(worker, { text: d.note, fields: { ...fields, turn, source: d.source } });
  }

  /** Drops worker's draft of turn (sent or dismissed). */
  clear(worker: string, turn: string): void {
    if (this.store.get(worker)?.fields?.turn === turn) this.store.clear(worker);
  }
}
