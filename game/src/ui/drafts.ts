/**
 * Unsent writing that survives closing a dialog (#51): kept in memory, and in localStorage where it is allowed.
 *
 * A draft is `{ text, fields?, segments? }` under a caller-chosen key. Today's dialogs store the text and a few typed
 * fields; the transcript's prompt box (#141) stores its document in `segments` too: its text runs and file chips in
 * order (`SavedPart`; images do not survive a reload). What storage gives back is read as untrusted: segments that are
 * not a list are dropped, a part that is not one (a path no chip may hold) is left out. All storage access is
 * try/catch'ed: blocked, full or corrupt storage leaves the in-memory copy, and typing, closing and hiring never
 * notice.
 *
 * #108: `persist` says whether storage may have them now: no ("Review prompt secrets before sending" on, the writing
 * may hold a secret), the drafts stay in memory only, and one kept in storage from before is removed once it is read.
 */

import { readSavedParts, type SavedPart } from './composer/model';
import { bridgeKey } from '../net/bridgeScope';

export interface Draft {
  text: string;
  /** Other typed fields of the form (label, folder), by name. */
  fields?: Record<string, string>;
  /** The composer's document: its text runs and file chips in order. */
  segments?: SavedPart[];
}

interface Stored extends Draft {
  v: 1;
}

/** The slice of `Storage` used: tests pass a fake. */
export type DraftStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> & Partial<Pick<Storage, 'length' | 'key'>>;

const PREFIX = 'h3d.draft.';

function defaultStorage(): DraftStorage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** A draft with nothing in it is no draft. */
export function isEmptyDraft(d: Draft): boolean {
  return !d.text.trim() && !Object.values(d.fields ?? {}).some((v) => v.trim()) && !d.segments?.length;
}

function parse(raw: string | null): Draft | null {
  if (!raw) return null;
  try {
    const o = JSON.parse(raw) as Partial<Stored> | null;
    if (!o || o.v !== 1 || typeof o.text !== 'string') return null;
    const d: Draft = { text: o.text };
    if (o.fields && typeof o.fields === 'object') d.fields = Object.fromEntries(Object.entries(o.fields).filter((e): e is [string, string] => typeof e[1] === 'string'));
    const segs = readSavedParts(o.segments);
    if (segs) d.segments = segs;
    return d;
  } catch {
    return null;
  }
}

export class Drafts {
  private readonly mem = new Map<string, Draft>();

  constructor(
    private readonly ns: string,
    private readonly storage: DraftStorage | null = defaultStorage(),
    private readonly persist: () => boolean = () => true,
  ) {}

  private k(key: string): string {
    return `${bridgeKey(PREFIX)}${this.ns}.${key}`;
  }

  /** Keys belonging to this bridge and composer, including drafts from a reload. */
  keys(): string[] {
    const keys = new Set(this.mem.keys());
    const prefix = this.k('');
    try {
      for (let i = 0; i < (this.storage?.length ?? 0); i++) {
        const key = this.storage?.key?.(i);
        if (key?.startsWith(prefix)) keys.add(key.slice(prefix.length));
      }
    } catch { /* memory only */ }
    return [...keys];
  }

  /** Whether the current copy really reached allowed storage (quota failures included). */
  stored(key: string): boolean {
    if (!this.persist()) return false;
    try { return JSON.stringify(parse(this.storage?.getItem(this.k(key)) ?? null)) === JSON.stringify(this.get(key)); }
    catch { return false; }
  }

  /** The draft for `key`: this session's copy first, else what storage kept from an earlier one. */
  get(key: string): Draft | null {
    const m = this.mem.get(key);
    if (m) return m;
    let raw: string | null = null;
    try {
      raw = this.storage?.getItem(this.k(key)) ?? null;
    } catch {
      /* unreadable: memory only */
    }
    const d = parse(raw);
    if (d) this.mem.set(key, d);
    // #108: in memory now, it leaves storage while drafts may not be kept there.
    if (raw !== null && !this.persist()) this.forget(key);
    return d;
  }

  /** Keeps the draft (an empty one clears the key instead). */
  set(key: string, d: Draft): void {
    if (isEmptyDraft(d)) {
      this.clear(key);
      return;
    }
    this.mem.set(key, d);
    if (!this.persist()) {
      this.forget(key);
      return;
    }
    try {
      this.storage?.setItem(this.k(key), JSON.stringify({ v: 1, ...d } satisfies Stored));
    } catch {
      /* full or blocked: the in-memory copy stays */
    }
  }

  /**
   * #108 round 4: `persist` changed: every draft in memory leaves storage now (the switch went on: memory only), or is
   * written to it again (off).
   */
  persistChanged(): void {
    for (const key of this.keys()) this.get(key);
    const keep = this.persist();
    for (const [key, d] of this.mem) {
      if (keep) this.set(key, d);
      else this.forget(key);
    }
  }

  /** #108: removes what storage has for `key`; the copy in memory stays. */
  forget(key: string): void {
    try {
      this.storage?.removeItem(this.k(key));
    } catch {
      /* nothing to do */
    }
  }

  clear(key: string): void {
    this.mem.delete(key);
    try {
      this.storage?.removeItem(this.k(key));
    } catch {
      /* nothing to do */
    }
  }

  /**
   * Clears the draft once what was sent from it is acknowledged, unless it was edited since (a hire answered after
   * Esc and a new dialog must not eat the newer writing).
   */
  clearIfUnchanged(key: string, sent: Draft): void {
    const now = this.get(key);
    if (!now) return;
    if (now.text === sent.text && JSON.stringify(now.fields ?? {}) === JSON.stringify(sent.fields ?? {}) && JSON.stringify(now.segments ?? null) === JSON.stringify(sent.segments ?? null)) this.clear(key);
  }
}
