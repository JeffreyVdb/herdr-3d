import { browserZone, civilAt, clockFace, daylightAt, isNamedTimeZone, parseLatitude, parseTimeSpec, zonedInstant, type Daylight, type TimeSpec } from './daylight';

/**
 * M17 (#50): which time the game shows, and in which zone. The page's
 * overrides (`?time=`, `?tz=`, `?lat=`) win over the stored settings for that
 * page load; the settings win over the browser's zone. A pinned time is
 * frozen: the clock shows it and the light does not move.
 */

/** The stored settings, as the time of day reads them (`ui/timePrefs.ts`). */
export interface TimeSettings {
  readonly timeZone: string | null;
  readonly latitude: number | null;
}

export interface TimeOverrides {
  time: TimeSpec | null;
  timeZone: string | null;
  latitude: number | null;
}

/** The overrides in a page's query; invalid ones are ignored with a warning. */
export function overridesFrom(params: URLSearchParams, warn: (m: string) => void = () => {}): TimeOverrides {
  const o: TimeOverrides = { time: null, timeZone: null, latitude: null };
  const time = params.get('time');
  if (time !== null) {
    o.time = parseTimeSpec(time);
    if (!o.time) warn(`h3d: ignoring ?time=${time}: HH:MM or YYYY-MM-DDTHH:MM`);
  }
  const tz = params.get('tz');
  if (tz !== null) {
    if (isNamedTimeZone(tz)) o.timeZone = tz.trim();
    else warn(`h3d: ignoring ?tz=${tz}: an IANA zone name such as Europe/Brussels`);
  }
  const lat = params.get('lat');
  if (lat !== null) {
    o.latitude = parseLatitude(lat);
    if (o.latitude === null) warn(`h3d: ignoring ?lat=${lat}: degrees from -90 to 90`);
  }
  return o;
}

export class TimeOfDay {
  /** When the page loaded: a pinned `HH:MM` takes that day's date in the zone. */
  private readonly loadedAt: number;

  constructor(
    private readonly settings: TimeSettings,
    private readonly overrides: TimeOverrides = { time: null, timeZone: null, latitude: null },
    private readonly now: () => number = () => Date.now(),
  ) {
    this.loadedAt = now();
  }

  /** The zone the clock and the light follow. */
  get timeZone(): string {
    return this.overrides.timeZone ?? this.settings.timeZone ?? browserZone();
  }

  /** Where it comes from: the page's `?tz=`, the setting, or the browser. */
  get zoneSource(): 'override' | 'setting' | 'browser' {
    return this.overrides.timeZone ? 'override' : this.settings.timeZone ? 'setting' : 'browser';
  }

  get latitude(): number | null {
    return this.overrides.latitude ?? this.settings.latitude;
  }

  get pinned(): boolean {
    return this.overrides.time !== null;
  }

  /** The instant shown: now, or the pinned time in the effective zone. */
  instant(): number {
    const p = this.overrides.time;
    if (!p) return this.now();
    const zone = this.timeZone;
    const d = p.date ?? civilAt(this.loadedAt, zone);
    return zonedInstant(d.year, d.month, d.day, p.hour, p.minute, zone);
  }

  sample(): Daylight {
    return daylightAt(this.instant(), this.timeZone, this.latitude);
  }

  /** The clock's face for a sample, and the zone it is in. */
  static face(s: Daylight, zone: string): { time: string; date: string; zone: string } {
    return { ...clockFace(s.civil), zone };
  }
}
