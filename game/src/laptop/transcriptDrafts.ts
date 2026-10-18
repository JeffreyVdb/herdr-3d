import { Draft as PromptDraft, type Uploader } from '../ui/composer/draft';
import { fromSaved, plainText, savedParts, WORKER_PROMPT_MAX_BYTES } from '../ui/composer/model';
import { Drafts, type DraftStorage } from '../ui/drafts';

/**
 * #141: each worker's unsent prompt, kept by the seated view across seats: the transcript's prompt box shows the
 * worker's own draft object, so standing up and sitting at another desk (or the same one later) gives back its text,
 * its chips (images with their uploads too), its caret and its undo history. What a reload can keep, its text and its
 * file chips, is written to storage (`Drafts`, namespace `transcript`, keyed by worker) on every change and read back
 * the first time the worker's draft is asked for; an image does not survive a reload (its bytes were the page's). A
 * sent prompt clears the draft (`Draft.clearIf`, the send's revision), and with it what storage kept.
 *
 * At most `KEEP` drafts are held live; the least recently used one goes (disposed: its uploads stop), and comes back
 * from storage when it is asked for again. One with a send on its way stays, and so does the one last asked for: when
 * every other one is sending, more are held for now, and the extra go once a send is answered (or at the next ask).
 *
 * Each worker's `SendGate` is kept here too, for the same reason: a send outlives the view that started it, so the
 * next view of the worker's draft must know it is still on its way (busy, no second send of the same prompt).
 *
 * #108: while "Review prompt secrets before sending" is on (`persist` says no), nothing is written: the drafts live in
 * memory only, and one storage kept from before is removed once it is read (`Drafts`). `persistChanged()` follows the
 * switch: on, every live draft's stored copy goes at once; off, they are written again.
 */

export interface TranscriptDraftsOptions {
  /** #64: one image to Drop Zone (none: a pasted image says it cannot go up). */
  upload?: Uploader;
  /** Where text and file chips survive a reload (null: memory only). */
  storage?: DraftStorage | null;
  /** #108: whether storage may keep them now (default: always). */
  persist?: () => boolean;
}

/** How many workers' drafts are held live. */
const KEEP = 24;

const NO_UPLOAD: Uploader = () => Promise.resolve({ ok: false, code: 'unavailable', message: 'images cannot be uploaded from here' });

/** #141: whether a prompt from one draft is on its way (from the send until the bridge answered it), for every view of it. */
export class SendGate {
  private on = false;
  private readonly subs = new Set<() => void>();

  get busy(): boolean {
    return this.on;
  }

  set(on: boolean): void {
    if (on === this.on) return;
    this.on = on;
    for (const fn of [...this.subs]) fn();
  }

  subscribe(fn: () => void): () => void {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }
}

export class TranscriptDrafts {
  private readonly live = new Map<string, { draft: PromptDraft; off: () => void; label: string }>();
  private readonly gates = new Map<string, SendGate>();
  private readonly store: Drafts;
  /** The worker whose draft was asked for last (never the one to go). */
  private last: string | null = null;

  constructor(private readonly o: TranscriptDraftsOptions = {}) {
    this.store = o.storage !== undefined ? new Drafts('transcript', o.storage, o.persist) : new Drafts('transcript', undefined, o.persist);
  }

  /** The worker's draft (its live one, else the one storage kept, else a new one); `label` names its uploads. */
  get(id: string, label: string): PromptDraft {
    this.last = id;
    const had = this.live.get(id);
    if (had) {
      had.label = label;
      // The most recently used goes last.
      this.live.delete(id);
      this.live.set(id, had);
      this.trim();
      return had.draft;
    }
    const entry = { draft: null as unknown as PromptDraft, off: () => {}, label };
    entry.draft = new PromptDraft({ upload: this.o.upload ?? NO_UPLOAD, label: () => `transcript-${entry.label}`, maxPromptBytes: WORKER_PROMPT_MAX_BYTES, holdRefused: true });
    const kept = this.store.get(id);
    if (kept) entry.draft.hydrate(kept.segments ? fromSaved(kept.segments) : [kept.text]);
    entry.off = entry.draft.subscribe((e) => {
      if (e.kind === 'doc') this.save(id, entry.draft);
    });
    this.live.set(id, entry);
    this.trim();
    return entry.draft;
  }

  /** The worker's send gate (the same one for every view of its draft). */
  sending(id: string): SendGate {
    let g = this.gates.get(id);
    if (!g) {
      const gate = (g = new SendGate());
      this.gates.set(id, gate);
      gate.subscribe(() => {
        if (!gate.busy) this.trim();
      });
    }
    return g;
  }

  /** The draft held for `id` now, if any (tests). */
  peek(id: string): PromptDraft | null {
    return this.live.get(id)?.draft ?? null;
  }

  /** Down to `KEEP` live, least recently used first, passing over the last asked for and any with a send on its way. */
  private trim(): void {
    for (const [k, v] of this.live) {
      if (this.live.size <= KEEP) break;
      if (k !== this.last && !this.gates.get(k)?.busy) this.drop(k, v);
    }
  }

  private save(id: string, d: PromptDraft): void {
    if (d.disposed) return;
    const doc = d.doc;
    // An empty draft clears the key (`Drafts.set`): a sent prompt leaves nothing behind.
    this.store.set(id, { text: plainText(doc), segments: savedParts(doc) });
  }

  private drop(id: string, v: { draft: PromptDraft; off: () => void }): void {
    this.live.delete(id);
    v.off();
    v.draft.dispose();
  }

  /** #108: `persist` changed: the live drafts' stored copies go (memory only now), or are written again. */
  persistChanged(): void {
    const keep = this.o.persist?.() ?? true;
    for (const [id, v] of this.live) {
      if (keep) this.save(id, v.draft);
      else this.store.forget(id);
    }
  }

  /** Every live draft goes (what storage kept stays). */
  dispose(): void {
    for (const [k, v] of [...this.live]) this.drop(k, v);
  }
}
