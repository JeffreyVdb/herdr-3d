import { civilAt } from './daylight';

/**
 * #64 schedules (part 3 of #61): when a schedule fires, as typed in its form. Pure: the instant `now` and the zone are
 * parameters (the form passes `Date.now()` and `browserZone()`), so nothing here reads the host's clock or zone.
 *
 * - Relative: `in 24h`, `in 90m`, `in 2d`, `in 1h30m` (also `in 1 h 30 min`, `in 2 days`): elapsed time from now, so
 *   `in 24h` across a DST change is 24 real hours.
 * - Wall clock in the zone: `2026-10-18 10:45` (also `T` between, as a `datetime-local` input gives it, seconds
 *   allowed), `today 18:00`, `tomorrow 10:45` (the zone's calendar: tomorrow is the next date there, however long that
 *   day is), a bare `18:00` (today). A trailing `UTC` reads the date and the time in UTC instead.
 * - A wall-clock time the zone skips (the spring-forward gap) moves later by the gap's length; one it shows twice (the
 *   fall-back overlap) is the earlier instant: Temporal's `disambiguation: 'compatible'` (`wallToEpochMs`).
 * - Now or earlier is an error: the bridge refuses a `due_at` that is not in the future.
 */

export type When = { ok: true; at: number; zone: string; relative: boolean } | { ok: false; error: string };

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** The zone's offset (ms east of UTC) at an instant. Every IANA offset in use is whole minutes. */
const offsetAt = (tz: string, t: number) => civilAt(t, tz).offset * MIN;

/**
 * The instant the zone's clock reads y-m-d h:mi:s (unix ms). The candidates are the offsets a day either side (no zone
 * changes its offset twice within two days); one that reads back is the answer, two (an overlap) the earlier, none (a
 * gap) the time read with the offset before the change, which lands the gap's length later. Matches Temporal's
 * `'compatible'` disambiguation (checked against it on every quarter hour of 2025–2027 in 12 zones).
 */
export function wallToEpochMs(tz: string, y: number, mo: number, d: number, h: number, mi: number, s = 0): number {
  const wall = Date.UTC(y, mo - 1, d, h, mi, s);
  const before = offsetAt(tz, wall - DAY);
  const after = offsetAt(tz, wall + DAY);
  const hits = [...new Set([before, after])].map((o) => wall - o).filter((c) => offsetAt(tz, c) === wall - c);
  if (hits.length === 1) return hits[0] as number;
  if (hits.length === 2) return Math.min(...hits);
  return wall - before;
}

const UNIT: Record<string, number> = { d: DAY, day: DAY, days: DAY, h: HOUR, hr: HOUR, hrs: HOUR, hour: HOUR, hours: HOUR, m: MIN, min: MIN, mins: MIN, minute: MIN, minutes: MIN };

/** `24h`, `1h30m`, `1 h 30 min`, `2 days`: ms, or null when it is not a duration. */
export function parseDuration(text: string): number | null {
  const s = text.trim().toLowerCase();
  if (!s) return null;
  const re = /(\d+)\s*([a-z]+)\s*/gy;
  let total = 0;
  let m: RegExpExecArray | null;
  let end = 0;
  while ((m = re.exec(s))) {
    const unit = UNIT[m[2] as string];
    if (!unit) return null;
    total += Number(m[1]) * unit;
    end = re.lastIndex;
  }
  return end === s.length ? total : null;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** A date that exists (no 31 Feb). */
function realDate(y: number, mo: number, d: number): boolean {
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

const CLOCK = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/;

/** `HH:MM` (seconds allowed), or null. */
function clock(s: string): { h: number; mi: number; s: number } | null {
  const m = CLOCK.exec(s);
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  const sec = Number(m[3] ?? 0);
  return h <= 23 && mi <= 59 && sec <= 59 ? { h, mi, s: sec } : null;
}

const HINT = 'Try “in 24h”, “tomorrow 10:45”, “tomorrow 10:45 UTC” or “2026-10-18 10:45”.';

/** Reads `text` against `now` (unix ms) in the zone `tz`; see the top of the file. */
export function parseWhen(text: string, now: number, tz: string): When {
  const s = text.trim().replace(/\s+/g, ' ').toLowerCase();
  if (!s) return { ok: false, error: `Say when it should start. ${HINT}` };
  const future = (at: number, zone: string, relative: boolean): When => (at > now ? { ok: true, at, zone, relative } : { ok: false, error: `That is not in the future. ${HINT}` });

  if (s.startsWith('in ')) {
    const ms = parseDuration(s.slice(3).replace(/ utc$/, ''));
    if (s.endsWith(' utc')) return { ok: false, error: '“UTC” goes with a clock time (“tomorrow 10:45 UTC”); “in …” already counts from now.' };
    if (ms === null) return { ok: false, error: `“${text.trim()}” is not a duration: use d, h and m, as in “in 1h30m”.` };
    if (ms <= 0) return { ok: false, error: 'A duration of zero is now: give it some time.' };
    return future(now + ms, tz, true);
  }

  const utc = / ?(utc|z)$/.exec(s);
  const zone = utc ? 'UTC' : tz;
  const body = utc ? s.slice(0, utc.index).trim() : s;

  const day = /^(today|tomorrow)(?: at)? (.+)$/.exec(body);
  if (day) {
    const c = clock(day[2] as string);
    if (!c) return { ok: false, error: `“${day[2]}” is not a time of day: use HH:MM, as in “${day[1]} 10:45”.` };
    const t = civilAt(now, zone);
    const date = new Date(Date.UTC(t.year, t.month - 1, t.day + (day[1] === 'tomorrow' ? 1 : 0)));
    return future(wallToEpochMs(zone, date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), c.h, c.mi, c.s), zone, false);
  }

  const abs = /^(\d{4})-(\d{2})-(\d{2})(?:t| )(.+)$/.exec(body);
  if (abs) {
    const [y, mo, d] = [Number(abs[1]), Number(abs[2]), Number(abs[3])];
    const c = clock(abs[4] as string);
    if (!realDate(y, mo, d)) return { ok: false, error: `${abs[1]}-${abs[2]}-${abs[3]} is not a date.` };
    if (!c) return { ok: false, error: `“${abs[4]}” is not a time of day: use HH:MM.` };
    return future(wallToEpochMs(zone, y, mo, d, c.h, c.mi, c.s), zone, false);
  }

  const bare = clock(body);
  if (bare) {
    const t = civilAt(now, zone);
    const at = wallToEpochMs(zone, t.year, t.month, t.day, bare.h, bare.mi, bare.s);
    return at > now ? { ok: true, at, zone, relative: false } : { ok: false, error: `${pad(bare.h)}:${pad(bare.mi)} has passed today: say “tomorrow ${pad(bare.h)}:${pad(bare.mi)}”.` };
  }
  return { ok: false, error: `“${text.trim()}” is not a time I can read. ${HINT}` };
}

const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const abbrevs = new Map<string, Intl.DateTimeFormat>();

function shortName(at: number, tz: string, locale: string): string {
  const key = `${locale} ${tz}`;
  let f = abbrevs.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(locale, { timeZone: tz, timeZoneName: 'short' });
    abbrevs.set(key, f);
  }
  return f.formatToParts(at).find((p) => p.type === 'timeZoneName')?.value ?? tz;
}

/** The zone's short name at an instant: `EDT` (US English), `CEST` (British: US English only says GMT+2 there), else `GMT+5:30`. */
function zoneName(at: number, tz: string): string {
  const us = shortName(at, tz, 'en-US');
  return us.startsWith('GMT') ? shortName(at, tz, 'en-GB') : us;
}

/** `Sat 18 Oct 2026, 10:45 CEST`: an instant on the zone's clock (English names, so it reads the same everywhere). */
export function whenText(at: number, tz: string): string {
  const c = civilAt(at, tz);
  return `${WEEKDAY[c.weekday]} ${c.day} ${MONTH[c.month - 1]} ${c.year}, ${pad(c.hour)}:${pad(c.minute)} ${tz === 'UTC' ? 'UTC' : zoneName(at, tz)}`;
}

/** The UTC hint beside a local time: `08:45 UTC`, with the date when UTC's differs from the zone's (`Fri 17 Oct, 23:30 UTC`). */
export function utcHint(at: number, tz: string): string {
  const u = civilAt(at, 'UTC');
  const l = civilAt(at, tz);
  const time = `${pad(u.hour)}:${pad(u.minute)} UTC`;
  return u.day === l.day && u.month === l.month && u.year === l.year ? time : `${WEEKDAY[u.weekday]} ${u.day} ${MONTH[u.month - 1]}, ${time}`;
}

/** What a `datetime-local` input and the form's text field hold for an instant: `2026-10-18 10:45` on the zone's clock (`T` for the input). */
export function wallText(at: number, tz: string, sep: ' ' | 'T' = ' '): string {
  const c = civilAt(at, tz);
  return `${c.year}-${pad(c.month)}-${pad(c.day)}${sep}${pad(c.hour)}:${pad(c.minute)}`;
}

/** How long until (or since) an instant, coarsely: `in 2 d 3 h`, `in 4 h 5 min`, `in 3 min`, `in 40 s`, `due now`, `3 min overdue`. */
export function countdownText(at: number, now: number): string {
  const d = at - now;
  const a = Math.abs(d);
  if (a < 1000) return 'due now';
  let span: string;
  if (a < MIN) span = `${Math.floor(a / 1000)} s`;
  else if (a < HOUR) span = `${Math.floor(a / MIN)} min`;
  else if (a < DAY) span = `${Math.floor(a / HOUR)} h${Math.floor((a % HOUR) / MIN) ? ` ${Math.floor((a % HOUR) / MIN)} min` : ''}`;
  else span = `${Math.floor(a / DAY)} d${Math.floor((a % DAY) / HOUR) ? ` ${Math.floor((a % DAY) / HOUR)} h` : ''}`;
  return d > 0 ? `in ${span}` : `${span} overdue`;
}

/**
 * #66: a time near now in a few words, as a chip says it: `today 12:45`, `tomorrow 12:45`, `Wed 12:45` within the week,
 * else `Sat 31 Oct 12:45` (with the year when it is another). Days are the zone's calendar days.
 */
export function dayClockText(at: number, now: number, tz: string): string {
  const c = civilAt(at, tz);
  const n = civilAt(now, tz);
  const days = Math.round((Date.UTC(c.year, c.month - 1, c.day) - Date.UTC(n.year, n.month - 1, n.day)) / DAY);
  const clock = `${pad(c.hour)}:${pad(c.minute)}`;
  if (days === 0) return `today ${clock}`;
  if (days === 1) return `tomorrow ${clock}`;
  if (days === -1) return `yesterday ${clock}`;
  if (days > 1 && days < 7) return `${WEEKDAY[c.weekday]} ${clock}`;
  return `${WEEKDAY[c.weekday]} ${c.day} ${MONTH[c.month - 1]}${c.year === n.year ? '' : ` ${c.year}`} ${clock}`;
}
