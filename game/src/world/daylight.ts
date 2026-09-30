/**
 * M17 (#50): the time of day. Turns an instant and a timezone (and, when the
 * operator set one, a latitude) into how light it is outside, where the sun
 * stands and how warm its light is, plus the civil clock time the office
 * clock shows. Pure: no DOM, no three.js; `Intl` only for the zone's clock.
 *
 * Two models, one output shape:
 * - **latitude** set: the sun's altitude from the latitude, the solar
 *   declination of the day of the year and the hour angle, with solar noon at
 *   12:00 local *standard* time (13:00 on the clock while the zone keeps
 *   summer time). Daylight is a smooth ramp of the altitude from civil
 *   twilight (−6°) to +7°, so day length and dawn follow the season and the
 *   latitude, and a polar day or night simply clamps.
 * - **fixed** (no latitude): dawn 06:30–08:00 and dusk 18:30–20:00 local
 *   clock time, and a sun arc (up at 07:15, down at 19:15, 57° at 13:15) so
 *   the light has an angle to come from.
 */

export interface Civil {
  year: number;
  /** 1–12. */
  month: number;
  day: number;
  /** 0 (Sunday) – 6. */
  weekday: number;
  hour: number;
  minute: number;
  second: number;
  /** Minutes east of UTC at this instant (Brussels: 60 in winter, 120 in summer). */
  offset: number;
}

export interface Daylight {
  /** 0 night … 1 full day. */
  daylight: number;
  /** The sun's altitude above the horizon, degrees (negative: below it). */
  elevation: number;
  /** The sun's compass bearing, degrees from north, clockwise (90 east, 180 south). */
  azimuth: number;
  /** 0 … 1: how much of dawn's or dusk's warm tint the light has (peaks with the sun on the horizon). */
  warmth: number;
  model: 'latitude' | 'fixed';
  /** The zone's clock at that instant. */
  civil: Civil;
  /** Whether the zone keeps summer time then. */
  dst: boolean;
}

/** The fixed curve's clock hours (see the module comment). */
export const FIXED = { dawn: [6.5, 8], dusk: [18.5, 20], rise: 7.25, set: 19.25, peak: 57 } as const;
/** The latitude model's daylight ramp, in degrees of altitude. */
export const RAMP = { from: -6, to: 7 } as const;

const DEG = Math.PI / 180;

export function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

// ---- the zone's clock -------------------------------------------------------------

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(zone: string | undefined): Intl.DateTimeFormat {
  const key = zone ?? '';
  let f = formatters.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', {
      ...(zone ? { timeZone: zone } : {}),
      calendar: 'gregory',
      numberingSystem: 'latn',
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formatters.set(key, f);
  }
  return f;
}

const ms = (t: number | Date) => (typeof t === 'number' ? t : t.getTime());

/** The clock in `timeZone` (the browser's own zone when left out) at an instant. */
export function civilAt(instant: number | Date, timeZone?: string): Civil {
  const t = Math.floor(ms(instant) / 1000) * 1000;
  const parts = formatter(timeZone).formatToParts(t);
  const n = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find((p) => p.type === type)?.value ?? NaN);
  const year = n('year');
  const month = n('month');
  const day = n('day');
  // Defensive: an engine that formats midnight as 24 despite h23.
  const hour = n('hour') % 24;
  const minute = n('minute');
  const second = n('second');
  const asUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  return { year, month, day, weekday: new Date(Date.UTC(year, month - 1, day)).getUTCDay(), hour, minute, second, offset: Math.round((asUtc - t) / 60_000) };
}

/** The zone's standard offset in a year: the smaller of its January and July offsets (minutes east of UTC). */
export function standardOffset(year: number, timeZone?: string): number {
  return Math.min(civilAt(Date.UTC(year, 0, 1), timeZone).offset, civilAt(Date.UTC(year, 6, 1), timeZone).offset);
}

/**
 * The instant the zone's clock reads y-m-d h:min. A time the clock skips (the
 * spring-forward hour) lands an hour later; a time it shows twice (the
 * autumn hour) is its second showing.
 */
export function zonedInstant(year: number, month: number, day: number, hour: number, minute: number, timeZone?: string): number {
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  let t = wall - civilAt(wall, timeZone).offset * 60_000;
  t = wall - civilAt(t, timeZone).offset * 60_000;
  return t;
}

// ---- the sun ---------------------------------------------------------------------

/** Warm tint: none at night, most with the sun on the horizon, gone once it is 16° up. */
export function warmthOf(elevation: number): number {
  return smoothstep(-9, -1, elevation) * (1 - smoothstep(4, 16, elevation));
}

/** The sun's altitude and bearing (degrees) at a latitude, a day of the year and a local standard hour. */
export function sunPosition(latitude: number, dayOfYear: number, standardHour: number): { elevation: number; azimuth: number } {
  const phi = Math.max(-90, Math.min(90, latitude)) * DEG;
  const decl = -23.44 * Math.cos(((2 * Math.PI) / 365) * (dayOfYear + 10)) * DEG;
  const h = 15 * (standardHour - 12) * DEG;
  const sinAlt = Math.sin(phi) * Math.sin(decl) + Math.cos(phi) * Math.cos(decl) * Math.cos(h);
  const elevation = Math.asin(Math.max(-1, Math.min(1, sinAlt))) / DEG;
  const az = Math.atan2(-Math.cos(decl) * Math.sin(h), Math.sin(decl) * Math.cos(phi) - Math.cos(decl) * Math.sin(phi) * Math.cos(h)) / DEG;
  return { elevation, azimuth: (az + 360) % 360 };
}

/** How light it is at an instant in a zone; `latitude` null or left out: the fixed curve. */
export function daylightAt(instant: number | Date, timeZone?: string, latitude?: number | null): Daylight {
  const t = ms(instant);
  const civil = civilAt(t, timeZone);
  const std = standardOffset(civil.year, timeZone);
  const dst = civil.offset > std;
  if (latitude !== null && latitude !== undefined && Number.isFinite(latitude)) {
    // Local standard time: the zone's clock without its summer hour.
    const local = new Date(t + std * 60_000);
    const y = local.getUTCFullYear();
    const dayOfYear = Math.floor((Date.UTC(y, local.getUTCMonth(), local.getUTCDate()) - Date.UTC(y, 0, 1)) / 86_400_000) + 1;
    const hour = local.getUTCHours() + local.getUTCMinutes() / 60 + local.getUTCSeconds() / 3600;
    const sun = sunPosition(latitude, dayOfYear, hour);
    return { daylight: smoothstep(RAMP.from, RAMP.to, sun.elevation), ...sun, warmth: warmthOf(sun.elevation), model: 'latitude', civil, dst };
  }
  const h = civil.hour + civil.minute / 60 + civil.second / 3600;
  const daylight = smoothstep(FIXED.dawn[0], FIXED.dawn[1], h) * (1 - smoothstep(FIXED.dusk[0], FIXED.dusk[1], h));
  // A 24-hour sine: up at `rise`, down at `set`, at its peak halfway, as far below at the opposite hour.
  const k = (h - FIXED.rise) / (FIXED.set - FIXED.rise);
  const elevation = FIXED.peak * Math.sin(Math.PI * k);
  const azimuth = (((90 + 180 * k) % 360) + 360) % 360;
  return { daylight, elevation, azimuth, warmth: warmthOf(elevation), model: 'fixed', civil, dst };
}

// ---- the clock face ----------------------------------------------------------------

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;
const pad = (n: number) => String(n).padStart(2, '0');

/** What the office clock shows: `14:05` and `Tue 30 Sep` (24-hour, English names whatever the browser's locale). */
export function clockFace(c: Civil): { time: string; date: string } {
  return { time: `${pad(c.hour)}:${pad(c.minute)}`, date: `${WEEKDAYS[c.weekday] ?? ''} ${c.day} ${MONTHS[c.month - 1] ?? ''}` };
}

// ---- settings and overrides -----------------------------------------------------------

/**
 * A named IANA zone the browser knows (aliases such as `UTC` and
 * `Europe/Kiev` included). Numeric offsets, which newer engines also take,
 * are refused: the setting asks for a place, whose summer time then applies.
 */
export function isNamedTimeZone(input: string): boolean {
  const zone = input.trim();
  if (!zone || /^[+-]|^\d/.test(zone) || /^(utc|gmt)[+-]/i.test(zone)) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: zone });
    return true;
  } catch (e) {
    if (e instanceof RangeError) return false;
    throw e;
  }
}

/** The browser's own zone (`UTC` when it will not say). */
export function browserZone(): string {
  try {
    return new Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** A latitude typed by the operator: degrees −90 … 90 (`50.85`, `-33.9`); null when it is not one. */
export function parseLatitude(input: string): number | null {
  const s = input.trim();
  if (!/^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(s)) return null;
  const v = Number(s);
  return Number.isFinite(v) && v >= -90 && v <= 90 ? v : null;
}

/** `?time=`: a clock time in the effective zone (today's date) or a date and time there. */
export interface TimeSpec {
  date: { year: number; month: number; day: number } | null;
  hour: number;
  minute: number;
}

/** `HH:MM` or `YYYY-MM-DDTHH:MM`; null for anything else (an hour past 23, 31 Feb, …). */
export function parseTimeSpec(input: string): TimeSpec | null {
  const s = input.trim();
  const m = /^(?:(\d{4})-(\d{2})-(\d{2})T)?(\d{1,2}):(\d{2})$/.exec(s);
  if (!m) return null;
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  if (hour > 23 || minute > 59) return null;
  if (m[1] === undefined) return { date: null, hour, minute };
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
  return { date: { year, month, day }, hour, minute };
}
