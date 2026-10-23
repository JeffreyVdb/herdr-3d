/**
 * Settings → Harness models: which models of each harness the Hire dialog shows, remembered per browser. Models are
 * visible unless the player hides them, so nothing is hidden until they choose, and a newly discovered model shows up.
 * The hidden slugs are kept even while the bridge does not list them, so a model that comes back is still hidden.
 * Guarded like `hirePrefs.ts`: storage can be missing, throw or hold something malformed, and then nothing is hidden.
 */

import { bridgeKey } from '../net/bridgeScope';

const KEY = 'h3d.hire.hiddenModels';

/** Hidden slugs per harness, as stored: only harnesses with something hidden appear. */
export type HiddenModels = Record<string, string[]>;

const NONE: ReadonlySet<string> = new Set();

/** The stored value read back: anything that is not `{ harness: [slug, …] }` of strings counts as nothing hidden. */
export function parseHidden(raw: string | null): HiddenModels {
  if (!raw) return {};
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return {};
  const out: HiddenModels = {};
  for (const [harness, slugs] of Object.entries(v as Record<string, unknown>)) {
    if (!Array.isArray(slugs)) continue;
    const kept = [...new Set(slugs.filter((s): s is string => typeof s === 'string' && s !== ''))];
    if (kept.length) out[harness] = kept;
  }
  return out;
}

function defaultStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export class HireModelPrefs {
  private readonly listeners = new Set<() => void>();
  private hidden_: HiddenModels;
  private rev = 0;

  constructor(private readonly storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null = defaultStorage()) {
    let raw: string | null = null;
    try {
      raw = this.storage?.getItem(bridgeKey(KEY)) ?? null;
    } catch {
      raw = null;
    }
    this.hidden_ = parseHidden(raw);
  }

  /** Bumped on every change: a view that drew the list can tell it is out of date. */
  get version(): number {
    return this.rev;
  }

  /** The slugs of `harness` the player hides (empty when none). */
  hidden(harness: string): ReadonlySet<string> {
    const list = this.hidden_[harness];
    return list ? new Set(list) : NONE;
  }

  /** #190: every harness's hidden slugs, a copy (what `hire.interpret` sends as `hidden_models`; empty when none). */
  all(): HiddenModels {
    return Object.fromEntries(Object.entries(this.hidden_).map(([h, slugs]) => [h, [...slugs]]));
  }

  isShown(harness: string, slug: string): boolean {
    return !this.hidden(harness).has(slug);
  }

  /** Shows (`shown` true) or hides `slug` for the Hire dialog of `harness`. */
  setShown(harness: string, slug: string, shown: boolean): void {
    const cur = this.hidden_[harness] ?? [];
    const has = cur.includes(slug);
    if (shown === has) {
      this.write({ ...this.hidden_, [harness]: shown ? cur.filter((s) => s !== slug) : [...cur, slug] });
    }
  }

  /** Shows every model of `harness` again, the ones the bridge no longer lists included. */
  showAll(harness: string): void {
    if (!this.hidden_[harness]) return;
    const { [harness]: _, ...rest } = this.hidden_;
    this.write(rest);
  }

  /** Called when the list changes (the Settings section and an open Hire dialog keep in step). */
  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private write(next: HiddenModels): void {
    // A harness with nothing left hidden drops out, so an empty list is never stored.
    next = Object.fromEntries(Object.entries(next).filter(([, slugs]) => slugs.length));
    this.hidden_ = next;
    this.rev++;
    try {
      // Only what is hidden is stored: nothing hidden leaves no key behind.
      if (Object.keys(next).length) this.storage?.setItem(bridgeKey(KEY), JSON.stringify(next));
      else this.storage?.removeItem(bridgeKey(KEY));
    } catch {
      /* not remembered past this page */
    }
    for (const fn of this.listeners) fn();
  }
}
