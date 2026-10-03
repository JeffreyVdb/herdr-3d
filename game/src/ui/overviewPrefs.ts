/**
 * #118: which groups of the floor overview are collapsed, per browser: the orchestrator ids (and `ghost:<id>`,
 * `unlinked`) the viewer folded. Every group is expanded by default, so only the collapsed ones are kept, the newest
 * last, at most `MAX` (orchestrators come and go). localStorage can be missing or throw (private windows, blocked site
 * data): every access is guarded and the page works without it, remembering for this page only.
 */

const KEY = 'h3d.overview.collapsed';
const MAX = 200;

function defaultStorage(): Pick<Storage, 'getItem' | 'setItem'> | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** Stored JSON in, the collapsed keys out (anything else: none). */
export function parseCollapsed(raw: string | null): Set<string> {
  try {
    const v: unknown = raw ? JSON.parse(raw) : null;
    if (Array.isArray(v)) return new Set(v.filter((k): k is string => typeof k === 'string' && k !== ''));
  } catch {
    /* none */
  }
  return new Set();
}

export class OverviewPrefs {
  /** The source of truth: storage only carries it to the next page load. Insertion order: oldest first. */
  readonly set: Set<string>;

  constructor(private readonly storage: Pick<Storage, 'getItem' | 'setItem'> | null = defaultStorage()) {
    let raw: string | null = null;
    try {
      raw = this.storage?.getItem(KEY) ?? null;
    } catch {
      /* none */
    }
    this.set = parseCollapsed(raw);
  }

  collapsed(key: string): boolean {
    return this.set.has(key);
  }

  setCollapsed(key: string, on: boolean): void {
    this.setAll([key], on);
  }

  /** Expand all / collapse all: the given groups at once. */
  setAll(keys: readonly string[], on: boolean): void {
    let changed = false;
    for (const k of keys) {
      if (on) {
        this.set.delete(k);
        this.set.add(k); // the newest last
        changed = true;
      } else if (this.set.delete(k)) changed = true;
    }
    if (!changed) return;
    while (this.set.size > MAX) this.set.delete(this.set.values().next().value as string);
    try {
      this.storage?.setItem(KEY, JSON.stringify([...this.set]));
    } catch {
      /* this page only */
    }
  }
}
