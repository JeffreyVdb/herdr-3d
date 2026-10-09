/**
 * #116: whether a new hire takes you to its desk, remembered per browser: after a hire, you sit at its laptop with its
 * conversation on screen (the default), or stay where you are, as before. Guarded like `monitorPrefs.ts`:
 * localStorage can be missing or throw (private windows, blocked site data), so the value lives here and storage only
 * carries it to the next page load.
 * #210: and whether Hire waits in the dialog for the worker (the default) or closes it at once and says so when the
 * worker is up (`hireInBackground`).
 */

const KEY = 'h3d.hire.goto';
const BACKGROUND_KEY = 'h3d.hire.background';

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
  private background: boolean;

  constructor(private readonly storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null = defaultStorage()) {
    this.value = this.read(KEY) !== 'off';
    this.background = this.read(BACKGROUND_KEY) === 'on';
  }

  private read(key: string): string | null {
    try {
      return this.storage?.getItem(key) ?? null;
    } catch {
      return null;
    }
  }

  /** Only the choice that is not the default is stored. */
  private write(key: string, stored: string | null): void {
    try {
      if (stored !== null) this.storage?.setItem(key, stored);
      else this.storage?.removeItem(key);
    } catch {
      /* not remembered past this page */
    }
    for (const fn of this.listeners) fn();
  }

  /** Settings → Display "Go to a new hire after hiring". */
  get goToNew(): boolean {
    return this.value;
  }

  set goToNew(v: boolean) {
    if (v === this.value) return;
    this.value = v;
    this.write(KEY, v ? null : 'off');
  }

  /** #210: Settings → Display "Hire in background"; off by default. A hire reads it once, when Hire is pressed. */
  get hireInBackground(): boolean {
    return this.background;
  }

  set hireInBackground(v: boolean) {
    if (v === this.background) return;
    this.background = v;
    this.write(BACKGROUND_KEY, v ? 'on' : null);
  }

  /** Called when `goToNew` or `hireInBackground` changes (the Settings rows keep in step). */
  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}
