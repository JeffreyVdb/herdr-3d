/**
 * #100: what the inbox remembers per browser: whether the chip is shown, and
 * what pings you (desktop notifications, the chime, for which entries). One
 * JSON key; localStorage can be missing or throw (private windows, blocked
 * site data), so every access is guarded and the inbox works without it.
 */

const KEY = 'h3d.inbox';

export interface InboxSettings {
  /** Settings → Display "Show inbox". */
  show: boolean;
  /** Desktop notifications (they also need the browser's permission). */
  desktop: boolean;
  chime: boolean;
  /** The chime's own volume, 0..1, under the master volume and mute (`h3d.audio`). */
  chimeVolume: number;
  /** Ping for entries that need you. */
  onNeeds: boolean;
  /** Ping for entries that finished. */
  onFinished: boolean;
  /** Freelancers that finish are listed and ping too. */
  freelancers: boolean;
}

export const DEFAULT_INBOX_SETTINGS: Readonly<InboxSettings> = { show: true, desktop: true, chime: true, chimeVolume: 0.6, onNeeds: true, onFinished: true, freelancers: false };

function defaultStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** Stored JSON in, complete settings out: anything missing or of the wrong type takes its default. */
export function parseInboxSettings(raw: string | null): InboxSettings {
  let p: Record<string, unknown> = {};
  try {
    const v: unknown = raw ? JSON.parse(raw) : null;
    if (v && typeof v === 'object' && !Array.isArray(v)) p = v as Record<string, unknown>;
  } catch {
    /* defaults */
  }
  const d = DEFAULT_INBOX_SETTINGS;
  const flag = (k: keyof InboxSettings, dv: boolean) => (typeof p[k] === 'boolean' ? (p[k] as boolean) : dv);
  return {
    show: flag('show', d.show),
    desktop: flag('desktop', d.desktop),
    chime: flag('chime', d.chime),
    chimeVolume: typeof p.chimeVolume === 'number' && Number.isFinite(p.chimeVolume) ? clamp01(p.chimeVolume) : d.chimeVolume,
    onNeeds: flag('onNeeds', d.onNeeds),
    onFinished: flag('onFinished', d.onFinished),
    freelancers: flag('freelancers', d.freelancers),
  };
}

export class InboxPrefs {
  private readonly listeners = new Set<() => void>();
  /** The source of truth: storage only carries it to the next page load. */
  private value: InboxSettings;

  constructor(private readonly storage: Pick<Storage, 'getItem' | 'setItem'> | null = defaultStorage()) {
    let raw: string | null = null;
    try {
      raw = this.storage?.getItem(KEY) ?? null;
    } catch {
      /* defaults */
    }
    this.value = parseInboxSettings(raw);
  }

  get settings(): Readonly<InboxSettings> {
    return this.value;
  }

  /** Changes some settings, remembers them and tells the listeners (only when something changed). */
  set(patch: Partial<InboxSettings>): void {
    const next = parseInboxSettings(JSON.stringify({ ...this.value, ...patch }));
    if ((Object.keys(next) as (keyof InboxSettings)[]).every((k) => next[k] === this.value[k])) return;
    this.value = next;
    try {
      this.storage?.setItem(KEY, JSON.stringify(next));
    } catch {
      /* not remembered past this page */
    }
    for (const fn of this.listeners) fn();
  }

  /** Called after any change; returns the unsubscribe. */
  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}
