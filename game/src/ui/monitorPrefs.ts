import type { MonitorPref } from '../world/activity';

/**
 * #98: what the desk monitors show while you stand, remembered per browser: the activity card (the default) or the
 * terminal everywhere, as before. Guarded like `limitsPrefs.ts`: localStorage can be missing or throw (private
 * windows, blocked site data), so the value lives here and storage only carries it to the next page load.
 */

const KEY = 'h3d.monitors';

function defaultStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export class MonitorPrefs {
  private readonly listeners = new Set<() => void>();
  private value: MonitorPref;

  constructor(private readonly storage: Storage | null = defaultStorage()) {
    let v: string | null = null;
    try {
      v = this.storage?.getItem(KEY) ?? null;
    } catch {
      v = null;
    }
    this.value = v === 'terminal' ? 'terminal' : 'activity';
  }

  get monitors(): MonitorPref {
    return this.value;
  }

  set monitors(v: MonitorPref) {
    if (v === this.value) return;
    this.value = v;
    try {
      // Only the choice that is not the default is stored.
      if (v === 'terminal') this.storage?.setItem(KEY, 'terminal');
      else this.storage?.removeItem(KEY);
    } catch {
      /* not remembered past this page */
    }
    for (const fn of this.listeners) fn();
  }

  /** Called when `monitors` changes (the Settings row and the monitors keep in step). */
  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}
