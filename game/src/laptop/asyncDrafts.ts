import type { WorkerCodex } from '../net/protocol';
import { asyncBatches } from '../world/codexQuestions';
import { Drafts, type DraftStorage } from '../ui/drafts';

/**
 * #157: what you wrote (or picked) for a Codex worker's async questions, kept above the transcript view: by worker,
 * thread, batch and question, so it outlives a re-render, an upsert, a refused or undelivered send, a reconnect and its
 * snapshot, standing up, and the terminal toggle (which unmounts the view). Kept like the other drafts (`Drafts`,
 * namespace `codex-async`: memory, and storage where it is allowed). A draft goes only when its question is answered
 * (`prune`, from the bridge's view) or its thread is no longer the worker's.
 *
 * Also what this page has seen of the batches, for the card: the ones seen with a question still open (so a batch
 * answered while you look stays, saying so, until you clear it) and the ones you cleared. Never a dismissal: hiding a
 * question is the bridge's (`worker.dismiss_async`), and a bridge restart may legitimately show it again.
 */
export class AsyncDrafts {
  private readonly store: Drafts;
  /** The draft keys written this page, per worker (so a thread change can drop them). */
  private readonly written = new Map<string, Set<string>>();
  private readonly seenOpen = new Set<string>();
  private readonly cleared = new Set<string>();
  private readonly showHidden = new Set<string>();

  /** #108 round 4: `persist` says whether storage may have them now (no: "Review prompt secrets" is on, memory only). */
  constructor(storage?: DraftStorage | null, persist?: () => boolean) {
    this.store = storage !== undefined ? new Drafts('codex-async', storage, persist) : new Drafts('codex-async', undefined, persist);
  }

  /** #108 round 4: `persist` changed (`Drafts.persistChanged`). */
  persistChanged(): void {
    this.store.persistChanged();
  }

  private key(worker: string, thread: string, batch: string, index: number): string {
    return JSON.stringify([worker, thread, batch, index]);
  }

  /** The draft of question `index` of a batch ('' when none). */
  get(worker: string, thread: string, batch: string, index: number): string {
    return this.store.get(this.key(worker, thread, batch, index))?.text ?? '';
  }

  set(worker: string, thread: string, batch: string, index: number, text: string): void {
    const k = this.key(worker, thread, batch, index);
    this.store.set(k, { text });
    let s = this.written.get(worker);
    if (!s) this.written.set(worker, (s = new Set()));
    s.add(k);
  }

  /**
   * Drops the drafts of questions the bridge has seen answered, and those of another thread (a `/new` in the terminal):
   * never on a missing `codex` (a reconnect's snapshot may not have it yet).
   */
  prune(worker: string, codex: WorkerCodex | null | undefined): void {
    if (!codex || codex.mode !== 'shared' || !codex.thread) return;
    for (const b of asyncBatches({ codex })) {
      for (const q of b.questions) if (q.state === 'answered') this.drop(worker, this.key(worker, b.thread, b.batch, q.index));
    }
    for (const k of [...(this.written.get(worker) ?? [])]) {
      const [, thread] = JSON.parse(k) as [string, string];
      if (thread !== codex.thread) this.drop(worker, k);
    }
  }

  private drop(worker: string, k: string): void {
    this.store.clear(k);
    this.written.get(worker)?.delete(k);
  }

  /** A batch (its card key) was seen with a question still to answer or on its way. */
  sawOpen(worker: string, key: string): void {
    this.seenOpen.add(`${worker}\u0000${key}`);
  }

  wasOpen(worker: string, key: string): boolean {
    return this.seenOpen.has(`${worker}\u0000${key}`);
  }

  /** A batch with nothing left to answer, taken off the card (it stays answered). */
  clear(worker: string, key: string): void {
    this.cleared.add(`${worker}\u0000${key}`);
  }

  isCleared(worker: string, key: string): boolean {
    return this.cleared.has(`${worker}\u0000${key}`);
  }

  /** Whether the card lists the worker's hidden questions too (read-only). */
  hiddenShown(worker: string): boolean {
    return this.showHidden.has(worker);
  }

  toggleHidden(worker: string): void {
    if (!this.showHidden.delete(worker)) this.showHidden.add(worker);
  }
}
