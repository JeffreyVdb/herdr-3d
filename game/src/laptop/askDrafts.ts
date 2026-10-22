import type { Ask } from '../net/protocol';
import { Drafts, type DraftStorage } from '../ui/drafts';
import type { AskPick } from '../world/ask';

/** What a stored pick may be: read as untrusted, it must fit the ask it is restored to. */
function fits(a: Ask, raw: unknown): AskPick[] | null {
  if (!Array.isArray(raw) || raw.length !== a.questions.length) return null;
  const picks: AskPick[] = [];
  for (const [i, q] of a.questions.entries()) {
    const p = raw[i] as Partial<AskPick> | null;
    if (!p || typeof p !== 'object' || !Array.isArray(p.choices)) return null;
    const choices = [...new Set(p.choices.filter((n): n is number => Number.isInteger(n) && n >= 1 && n <= q.options.length))];
    const other = q.other && typeof p.other === 'string' ? p.other : null;
    picks.push({ choices: q.multi ? choices : choices.slice(0, 1), other });
  }
  return picks;
}

const hasPick = (picks: AskPick[]) => picks.some((p) => p.choices.length > 0 || p.other !== null);

/**
 * #187: what you picked and typed on a worker's ask (Claude's AskUserQuestion, Codex's request_user_input), kept above
 * the transcript view: by worker and the ask's tool_use_id, so it outlives closing and opening the questions' sheet, a
 * re-render, a reconnect and its snapshot, standing up, and the terminal toggle. Kept like the other answers' drafts
 * (`Drafts`, namespace `ask`: memory, and storage where it is allowed), one per worker: another ask starts afresh and
 * replaces it. An ask with a secret question (a password box) is never written to storage, only kept in memory. It
 * goes once the answer (or the dismissal) was recorded.
 */
export class AskDrafts {
  private readonly store: Drafts;
  private readonly secret: Drafts;

  /** `persist` says whether storage may have them now (no: "Review prompt secrets" is on, memory only). */
  constructor(storage?: DraftStorage | null, persist?: () => boolean) {
    this.store = storage !== undefined ? new Drafts('ask', storage, persist) : new Drafts('ask', undefined, persist);
    this.secret = new Drafts('ask', null);
  }

  /** `persist` changed (`Drafts.persistChanged`). */
  persistChanged(): void {
    this.store.persistChanged();
  }

  /** The picks of worker's ask a (null: none, another ask's, or ones that do not fit it). */
  get(worker: string, a: Ask): AskPick[] | null {
    const d = [this.secret.get(worker), this.store.get(worker)].find((x) => x?.fields?.id === a.tool_use_id);
    if (!d) return null;
    try {
      return fits(a, JSON.parse(d.fields?.picks ?? ''));
    } catch {
      return null;
    }
  }

  set(worker: string, a: Ask, picks: AskPick[]): void {
    if (!hasPick(picks)) {
      this.clear(worker, a.tool_use_id);
      return;
    }
    const d = { text: '', fields: { id: a.tool_use_id, picks: JSON.stringify(picks) } };
    const secret = a.questions.some((q) => q.secret);
    (secret ? this.store : this.secret).clear(worker);
    (secret ? this.secret : this.store).set(worker, d);
  }

  /** Drops worker's draft of ask id (answered or dismissed). */
  clear(worker: string, id: string): void {
    for (const s of [this.store, this.secret]) if (s.get(worker)?.fields?.id === id) s.clear(worker);
  }
}
