/**
 * What the plan-limits widget remembers per browser: whether its panel is
 * open and whether it is hidden. localStorage can be missing or throw
 * (private windows, blocked site data), so every access is guarded and the
 * widget works without it.
 */

const OPEN = 'h3d.limits.open';
const HIDDEN = 'h3d.limits.hidden';

function defaultStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export class LimitsPrefs {
  private readonly listeners = new Set<() => void>();

  constructor(private readonly storage: Storage | null = defaultStorage()) {}

  private read(key: string): boolean {
    try {
      return this.storage?.getItem(key) === '1';
    } catch {
      return false;
    }
  }

  private write(key: string, on: boolean): void {
    try {
      if (on) this.storage?.setItem(key, '1');
      else this.storage?.removeItem(key);
    } catch {
      /* not remembered */
    }
  }

  get open(): boolean {
    return this.read(OPEN);
  }

  set open(on: boolean) {
    this.write(OPEN, on);
  }

  /** On by default: hidden only when the user hid it. */
  get hidden(): boolean {
    return this.read(HIDDEN);
  }

  set hidden(on: boolean) {
    this.write(HIDDEN, on);
    for (const fn of this.listeners) fn();
  }

  /** Called when `hidden` changes (the About dialog's switch and the widget keep in step). */
  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}
