/**
 * Unsent writing that survives closing a dialog (#51): kept in memory, and in localStorage where it is allowed.
 *
 * A draft is `{ text, fields?, segments? }` under a caller-chosen key. Today's dialogs store the text and a few typed
 * fields; the shared composer (#13) stores its richer document in `segments` under the same key, so nothing above
 * this file changes when it lands. All storage access is try/catch'ed: blocked, full or corrupt storage leaves the
 * in-memory copy, and typing, closing and hiring never notice.
 */

export interface Draft {
  text: string;
  /** Other typed fields of the form (label, folder), by name. */
  fields?: Record<string, string>;
  /** Reserved for the composer's document (text runs and image chips in order). */
  segments?: unknown[];
}

interface Stored extends Draft {
  v: 1;
}

/** The slice of `Storage` used: tests pass a fake. */
export type DraftStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

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
    if (Array.isArray(o.segments)) d.segments = o.segments;
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
  ) {}

  private k(key: string): string {
    return `${PREFIX}${this.ns}.${key}`;
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
    return d;
  }

  /** Keeps the draft (an empty one clears the key instead). */
  set(key: string, d: Draft): void {
    if (isEmptyDraft(d)) {
      this.clear(key);
      return;
    }
    this.mem.set(key, d);
    try {
      this.storage?.setItem(this.k(key), JSON.stringify({ v: 1, ...d } satisfies Stored));
    } catch {
      /* full or blocked: the in-memory copy stays */
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
