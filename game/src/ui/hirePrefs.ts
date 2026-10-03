/**
 * #116: whether a new hire takes you to its desk, remembered per browser: after a hire, you sit at its laptop with its
 * conversation on screen (the default), or stay where you are, as before. Guarded like `monitorPrefs.ts`:
 * localStorage can be missing or throw (private windows, blocked site data), so the value lives here and storage only
 * carries it to the next page load.
 */

const KEY = 'h3d.hire.goto';

function defaultStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export class HirePrefs {
  private readonly listeners = new Set<() => void>();
  private value: boolean;

  constructor(private readonly storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null = defaultStorage()) {
    let v: string | null = null;
    try {
      v = this.storage?.getItem(KEY) ?? null;
    } catch {
      v = null;
    }
    this.value = v !== 'off';
  }

  /** Settings → Display "Go to a new hire after hiring". */
  get goToNew(): boolean {
    return this.value;
  }

  set goToNew(v: boolean) {
    if (v === this.value) return;
    this.value = v;
    try {
      // Only the choice that is not the default is stored.
      if (!v) this.storage?.setItem(KEY, 'off');
      else this.storage?.removeItem(KEY);
    } catch {
      /* not remembered past this page */
    }
    for (const fn of this.listeners) fn();
  }

  /** Called when `goToNew` changes (the Settings row keeps in step). */
  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}
