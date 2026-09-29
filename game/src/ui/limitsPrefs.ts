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
  /** The source of truth: storage only carries it to the next page load. */
  private isOpen: boolean;
  private isHidden: boolean;

  constructor(private readonly storage: Storage | null = defaultStorage()) {
    this.isOpen = this.read(OPEN);
    this.isHidden = this.read(HIDDEN);
  }

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
      /* not remembered past this page */
    }
  }

  get open(): boolean {
    return this.isOpen;
  }

  set open(on: boolean) {
    this.isOpen = on;
    this.write(OPEN, on);
  }

  /** On by default: hidden only when the user hid it. */
  get hidden(): boolean {
    return this.isHidden;
  }

  set hidden(on: boolean) {
    this.isHidden = on;
    this.write(HIDDEN, on);
    for (const fn of this.listeners) fn();
  }

  /** Called when `hidden` changes (the About dialog's switch and the widget keep in step). */
  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}
