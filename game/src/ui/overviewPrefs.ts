/**
 * #118: which groups of the floor overview are collapsed, per browser: the orchestrator ids (and `ghost:<id>`,
 * `unlinked`) the viewer folded. Every group is expanded by default, so only the collapsed ones are kept, the newest
 * last, at most `MAX` (orchestrators come and go). localStorage can be missing or throw (private windows, blocked site
 * data): every access is guarded and the page works without it, remembering for this page only.
 *
 * #188: the all-floors page adds its floors (`floor:<session>`) and each floor's Unlinked group (`unlinked:<session>`).
 * An asleep floor starts collapsed: a group collapsed by default is open only with an `open:<key>` marker, which the
 * viewer opening it leaves (and folding it again takes away). The same list, so the same cap.
 *
 * #188: and the filter, Active only or All, one setting per view (`OverviewFilterPrefs`).
 */

import { bridgeKey } from '../net/bridgeScope';

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
      raw = this.storage?.getItem(bridgeKey(KEY)) ?? null;
    } catch {
      /* none */
    }
    this.set = parseCollapsed(raw);
  }

  /** `byDefault`: the group starts collapsed (an asleep floor) and is open only when the viewer opened it. */
  collapsed(key: string, byDefault = false): boolean {
    return byDefault ? !this.set.has(`open:${key}`) : this.set.has(key);
  }

  /** The collapsed keys as `visibleRows` takes them, given the groups collapsed by default. */
  effective(byDefault: Iterable<string>): Set<string> {
    const out = new Set([...this.set].filter((k) => !k.startsWith('open:')));
    for (const k of byDefault) if (!this.set.has(`open:${k}`)) out.add(k);
    return out;
  }

  setCollapsed(key: string, on: boolean, byDefault = false): void {
    this.setAll([key], on, byDefault ? new Set([key]) : undefined);
  }

  /** Expand all / collapse all: the given groups at once (`byDefault`: those of them collapsed by default). */
  setAll(keys: readonly string[], on: boolean, byDefault?: ReadonlySet<string>): void {
    let changed = false;
    const bump = (k: string) => {
      this.set.delete(k);
      this.set.add(k); // the newest last
      changed = true;
    };
    for (const k of keys) {
      if (on) {
        bump(k);
        if (this.set.delete(`open:${k}`)) changed = true;
      } else {
        if (this.set.delete(k)) changed = true;
        if (byDefault?.has(k)) bump(`open:${k}`);
      }
    }
    if (!changed) return;
    while (this.set.size > MAX) this.set.delete(this.set.values().next().value as string);
    try {
      this.storage?.setItem(bridgeKey(KEY), JSON.stringify([...this.set]));
    } catch {
      /* this page only */
    }
  }
}

const FILTER_KEY = { city: 'h3d.overview.filter.city', floor: 'h3d.overview.filter.floor' } as const;
/** The default per view: the all-floors page shows who is running; a floor's page everyone, as before #188. */
const FILTER_DEFAULT = { city: true, floor: false } as const;

/** Stored `active` / `all` in, active only out (anything else: the view's default). */
export function parseFilter(raw: string | null, byDefault: boolean): boolean {
  return raw === 'active' ? true : raw === 'all' ? false : byDefault;
}

/** #188: Active only or All, remembered per view in this browser (guarded like the collapse state). */
export class OverviewFilterPrefs {
  private readonly on: Record<'city' | 'floor', boolean>;

  constructor(private readonly storage: Pick<Storage, 'getItem' | 'setItem'> | null = defaultStorage()) {
    const read = (v: 'city' | 'floor') => {
      try {
        return parseFilter(this.storage?.getItem(FILTER_KEY[v]) ?? null, FILTER_DEFAULT[v]);
      } catch {
        return FILTER_DEFAULT[v];
      }
    };
    this.on = { city: read('city'), floor: read('floor') };
  }

  activeOnly(view: 'city' | 'floor'): boolean {
    return this.on[view];
  }

  setActiveOnly(view: 'city' | 'floor', on: boolean): void {
    this.on[view] = on;
    try {
      this.storage?.setItem(FILTER_KEY[view], on ? 'active' : 'all');
    } catch {
      /* this page only */
    }
  }
}
