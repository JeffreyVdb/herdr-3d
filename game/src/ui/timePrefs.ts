import { isNamedTimeZone, parseLatitude } from '../world/daylight';

/**
 * M17 (#50): what the time of day remembers per browser: a timezone (an IANA
 * name; none: the browser's own) for a TV or a shared screen whose clock is
 * not the operator's, and a latitude (none: the fixed dawn and dusk). Guarded
 * like `limitsPrefs.ts`: localStorage can be missing or throw, and the game
 * works without it. Invalid input is refused and never stored.
 */

const ZONE = 'h3d.time.zone';
const LAT = 'h3d.time.lat';

function defaultStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export type PrefResult = { ok: true } | { ok: false; error: string };

export class TimePrefs {
  private readonly listeners = new Set<() => void>();
  private tz: string | null;
  private lat: number | null;

  constructor(private readonly storage: Storage | null = defaultStorage()) {
    const zone = this.read(ZONE)?.trim() ?? '';
    this.tz = zone && isNamedTimeZone(zone) ? zone : null;
    const lat = this.read(LAT);
    this.lat = lat === null ? null : parseLatitude(lat);
  }

  private read(key: string): string | null {
    try {
      return this.storage?.getItem(key) ?? null;
    } catch {
      return null;
    }
  }

  private write(key: string, value: string | null): void {
    try {
      if (value === null) this.storage?.removeItem(key);
      else this.storage?.setItem(key, value);
    } catch {
      /* not remembered past this page */
    }
  }

  /** The chosen zone, null for the browser's own. */
  get timeZone(): string | null {
    return this.tz;
  }

  /** The chosen latitude, null for the fixed curve. */
  get latitude(): number | null {
    return this.lat;
  }

  /** Empty clears it (the browser's zone); a name the browser does not know, or a numeric offset, is refused. */
  setTimeZone(input: string): PrefResult {
    const zone = input.trim();
    if (zone && !isNamedTimeZone(zone)) return { ok: false, error: /^[+-]|^(utc|gmt)[+-]/i.test(zone) ? 'A place name, not an offset: Europe/Brussels, America/New_York, UTC' : `This browser does not know “${zone}”. An IANA name: Europe/Brussels, Asia/Tokyo, UTC` };
    const next = zone || null;
    if (next !== this.tz) {
      this.tz = next;
      this.write(ZONE, next);
      this.changed();
    }
    return { ok: true };
  }

  /** Empty clears it (the fixed dawn and dusk); anything but −90 … 90 is refused. */
  setLatitude(input: string): PrefResult {
    const s = input.trim();
    const v = s ? parseLatitude(s) : null;
    if (s && v === null) return { ok: false, error: 'Degrees from −90 (south pole) to 90 (north pole), e.g. 50.85' };
    if (v !== this.lat) {
      this.lat = v;
      this.write(LAT, v === null ? null : String(v));
      this.changed();
    }
    return { ok: true };
  }

  /** Called when either setting changes (the game re-reads the light at once). */
  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private changed(): void {
    for (const fn of this.listeners) fn();
  }
}
