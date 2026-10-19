import { describe, expect, it } from 'vitest';
import { countdownText, dayClockText, parseDuration, parseWhen, utcHint, wallText, wallToEpochMs, whenText } from './scheduleTime';

// #64 schedules: the form's time parsing. Node 26 has Temporal: it is the oracle for the wall-clock resolution
// (disambiguation 'compatible'). Typed locally, so no Temporal lib reaches the app's program (stable Safari lacks it).
interface Zoned {
  epochMilliseconds: number;
  year: number;
  month: number;
  day: number;
  add(d: { days: number }): Zoned;
}
const Temporal = (globalThis as unknown as {
  Temporal: {
    PlainDateTime: { from(s: string): { toZonedDateTime(tz: string, o: { disambiguation: 'compatible' }): Zoned } };
    Instant: { fromEpochMilliseconds(ms: number): { toZonedDateTimeISO(tz: string): Zoned } };
  };
}).Temporal;

const BXL = 'Europe/Brussels';
const NYC = 'America/New_York';
const KOL = 'Asia/Kolkata';
const LHI = 'Australia/Lord_Howe';
const ZONES = ['UTC', BXL, NYC, KOL, LHI];

const pad = (n: number) => String(n).padStart(2, '0');
const at = (iso: string) => Date.parse(iso);
const oracle = (tz: string, y: number, mo: number, d: number, h: number, mi: number) => Temporal.PlainDateTime.from(`${y}-${pad(mo)}-${pad(d)}T${pad(h)}:${pad(mi)}`).toZonedDateTime(tz, { disambiguation: 'compatible' }).epochMilliseconds;
const ok = (r: ReturnType<typeof parseWhen>) => {
  if (!r.ok) throw new Error(r.error);
  return r.at;
};

describe('wallToEpochMs (Temporal “compatible”)', () => {
  it('lands a gap the gap’s length later and an overlap on its earlier instant (the 2026 transitions)', () => {
    // [zone, wall clock, instant] from Temporal on Node 26 (the research's fixtures).
    const cases: Array<[string, [number, number, number, number, number], string]> = [
      [BXL, [2026, 3, 29, 2, 30], '2026-03-29T01:30:00Z'], // gap: 03:30 CEST
      [BXL, [2026, 10, 25, 2, 30], '2026-10-25T00:30:00Z'], // overlap: the earlier, CEST
      [NYC, [2026, 3, 8, 2, 30], '2026-03-08T07:30:00Z'], // gap
      [NYC, [2026, 11, 1, 1, 30], '2026-11-01T05:30:00Z'], // overlap: the earlier, EDT
      [LHI, [2026, 4, 5, 1, 45], '2026-04-04T14:45:00Z'], // 30-minute overlap: the earlier (+11:00)
      [LHI, [2026, 10, 4, 2, 15], '2026-10-03T15:45:00Z'], // 30-minute gap: 30 min later, not an hour
      [KOL, [2026, 10, 18, 10, 45], '2026-10-18T05:15:00Z'],
      ['UTC', [2026, 10, 18, 10, 45], '2026-10-18T10:45:00Z'],
    ];
    for (const [tz, [y, mo, d, h, mi], iso] of cases) {
      expect(wallToEpochMs(tz, y, mo, d, h, mi), `${tz} ${y}-${mo}-${d} ${h}:${mi}`).toBe(at(iso));
      expect(wallToEpochMs(tz, y, mo, d, h, mi)).toBe(oracle(tz, y, mo, d, h, mi));
    }
  });

  it('agrees with Temporal on every quarter hour of each 2026 transition day and the days around it', () => {
    const days: Array<[string, number, number]> = [
      [BXL, 3, 29],
      [BXL, 10, 25],
      [NYC, 3, 8],
      [NYC, 11, 1],
      [LHI, 4, 5],
      [LHI, 10, 4],
      [KOL, 3, 29],
      ['UTC', 3, 29],
    ];
    for (const [tz, mo, d0] of days) {
      for (let k = -1; k <= 1; k++) {
        const day = new Date(Date.UTC(2026, mo - 1, d0 + k));
        const [y, m, d] = [day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate()];
        for (let q = 0; q < 96; q++) {
          const h = Math.floor(q / 4);
          const mi = (q % 4) * 15;
          expect(wallToEpochMs(tz, y, m, d, h, mi), `${tz} ${y}-${m}-${d} ${h}:${mi}`).toBe(oracle(tz, y, m, d, h, mi));
        }
      }
    }
  });

  it('agrees with Temporal every 7 hours across 2026 in each zone', () => {
    for (const tz of ZONES) {
      for (let t = Date.UTC(2026, 0, 1); t < Date.UTC(2027, 0, 1); t += 7 * 3_600_000) {
        const c = new Date(t);
        const [y, mo, d, h, mi] = [c.getUTCFullYear(), c.getUTCMonth() + 1, c.getUTCDate(), c.getUTCHours(), 30];
        expect(wallToEpochMs(tz, y, mo, d, h, mi)).toBe(oracle(tz, y, mo, d, h, mi));
      }
    }
  });
});

describe('parseDuration', () => {
  it('reads d, h and m in their spellings', () => {
    expect(parseDuration('24h')).toBe(86_400_000);
    expect(parseDuration('90m')).toBe(5_400_000);
    expect(parseDuration('2d')).toBe(172_800_000);
    expect(parseDuration('1h30m')).toBe(5_400_000);
    expect(parseDuration('1 h 30 min')).toBe(5_400_000);
    expect(parseDuration('2 days 3 hours')).toBe(183_600_000);
    for (const bad of ['', '24', '5 parsecs', '1h30', 'h', '-2h']) expect(parseDuration(bad), bad).toBeNull();
  });
});

describe('parseWhen', () => {
  it('relative durations are elapsed time: “in 24h” across a DST change is exactly 24 real hours', () => {
    const now = at('2026-03-28T12:00:00Z'); // 13:00 CET; the clocks spring forward that night
    for (const tz of ZONES) {
      expect(ok(parseWhen('in 24h', now, tz))).toBe(now + 86_400_000);
      expect(ok(parseWhen('in 90m', now, tz))).toBe(now + 5_400_000);
      expect(ok(parseWhen('in 2d', now, tz))).toBe(now + 172_800_000);
      expect(ok(parseWhen('In 1h30m', now, tz))).toBe(now + 5_400_000);
    }
    // The wall clock moved: 13:00 CET becomes 14:00 CEST the next day.
    expect(wallText(ok(parseWhen('in 24h', now, BXL)), BXL)).toBe('2026-03-29 14:00');
    expect(parseWhen('in 24h', now, BXL)).toMatchObject({ relative: true, zone: BXL });
  });

  it('“tomorrow” is the zone’s next calendar date, across both 2026 transitions in Brussels and New York', () => {
    const cases: Array<[string, string, string, string]> = [
      // [zone, now, text, expected instant]
      [BXL, '2026-03-28T20:00:00Z', 'tomorrow 10:45', '2026-03-29T08:45:00Z'], // a 23-hour day: CET today, CEST tomorrow
      [BXL, '2026-10-24T20:00:00Z', 'tomorrow 10:45', '2026-10-25T09:45:00Z'], // a 25-hour day
      [NYC, '2026-03-07T20:00:00Z', 'tomorrow 10:45', '2026-03-08T14:45:00Z'],
      [NYC, '2026-10-31T20:00:00Z', 'tomorrow 10:45', '2026-11-01T15:45:00Z'],
      [BXL, '2026-03-28T20:00:00Z', 'tomorrow 02:30', '2026-03-29T01:30:00Z'], // into the gap: 03:30 CEST
      [BXL, '2026-10-24T20:00:00Z', 'tomorrow 02:30', '2026-10-25T00:30:00Z'], // into the overlap: its first showing
      [NYC, '2026-10-31T20:00:00Z', 'tomorrow 01:30', '2026-11-01T05:30:00Z'],
      [LHI, '2026-10-03T00:00:00Z', 'tomorrow 02:15', '2026-10-03T15:45:00Z'], // Lord Howe's 30-minute gap
      [LHI, '2026-04-04T00:00:00Z', 'tomorrow 01:45', '2026-04-04T14:45:00Z'], // and its 30-minute overlap
      [KOL, '2026-10-17T20:00:00Z', 'tomorrow 10:45', '2026-10-19T05:15:00Z'], // already the 18th in Kolkata
      ['UTC', '2026-10-17T20:00:00Z', 'tomorrow 10:45', '2026-10-18T10:45:00Z'],
    ];
    for (const [tz, nowIso, text, iso] of cases) {
      const now = at(nowIso);
      expect(ok(parseWhen(text, now, tz)), `${tz} ${nowIso} ${text}`).toBe(at(iso));
      // The oracle: Temporal's next calendar date in the zone, that wall clock on it, 'compatible'. (Not
      // `ZonedDateTime.with`, whose offset preference keeps today's offset in an overlap: the later instant.)
      const [h, mi] = text.split(' ')[1]!.split(':').map(Number) as [number, number];
      const t = Temporal.Instant.fromEpochMilliseconds(now).toZonedDateTimeISO(tz).add({ days: 1 });
      expect(ok(parseWhen(text, now, tz))).toBe(oracle(tz, t.year, t.month, t.day, h, mi));
    }
  });

  it('a trailing UTC reads the date and the time in UTC, whatever the zone', () => {
    const now = at('2026-10-17T20:00:00Z'); // 01:30 on the 18th in Kolkata, 22:00 in Brussels
    for (const tz of ZONES) {
      expect(ok(parseWhen('tomorrow 10:45 UTC', now, tz)), tz).toBe(at('2026-10-18T10:45:00Z'));
      expect(ok(parseWhen('2026-10-18 10:45 utc', now, tz))).toBe(at('2026-10-18T10:45:00Z'));
      expect(ok(parseWhen('today 21:00 UTC', now, tz))).toBe(at('2026-10-17T21:00:00Z'));
      expect(parseWhen('tomorrow 10:45 UTC', now, tz)).toMatchObject({ zone: 'UTC', relative: false });
    }
  });

  it('absolute local datetimes, as typed or as a datetime-local input gives them', () => {
    const now = at('2026-10-17T07:00:00Z');
    const cases: Array<[string, string, string]> = [
      [BXL, '2026-10-18 10:45', '2026-10-18T08:45:00Z'],
      [BXL, '2026-10-18T10:45', '2026-10-18T08:45:00Z'],
      [BXL, '2026-10-18T10:45:00', '2026-10-18T08:45:00Z'],
      [NYC, '2026-10-18 10:45', '2026-10-18T14:45:00Z'],
      [KOL, '2026-10-18 10:45', '2026-10-18T05:15:00Z'],
      [LHI, '2026-10-18 10:45', '2026-10-17T23:45:00Z'],
      ['UTC', '2026-10-18 10:45', '2026-10-18T10:45:00Z'],
      [BXL, '  2026-10-25   02:30 ', '2026-10-25T00:30:00Z'], // the overlap's first showing
      [NYC, '2027-03-14 02:30', '2027-03-14T07:30:00Z'], // a gap a year out
    ];
    for (const [tz, text, iso] of cases) expect(ok(parseWhen(text, now, tz)), `${tz} ${text}`).toBe(at(iso));
  });

  it('today and a bare time are today’s, on the zone’s clock', () => {
    const now = at('2026-10-17T07:00:00Z'); // 09:00 in Brussels
    expect(ok(parseWhen('today 18:00', now, BXL))).toBe(at('2026-10-17T16:00:00Z'));
    expect(ok(parseWhen('today at 18:00', now, BXL))).toBe(at('2026-10-17T16:00:00Z'));
    expect(ok(parseWhen('18:00', now, BXL))).toBe(at('2026-10-17T16:00:00Z'));
    expect(ok(parseWhen('9:30', now, BXL))).toBe(at('2026-10-17T07:30:00Z'));
  });

  it('the stored value is a whole UTC millisecond instant', () => {
    const now = at('2026-10-17T07:00:12.345Z');
    for (const tz of ZONES)
      for (const text of ['in 24h', 'tomorrow 10:45', 'tomorrow 10:45 UTC', '2026-12-01 08:00']) {
        const r = parseWhen(text, now, tz);
        expect(r.ok, `${tz} ${text}`).toBe(true);
        const v = ok(r);
        expect(Number.isInteger(v)).toBe(true);
        expect(new Date(v).toISOString()).toMatch(/Z$/);
      }
    // A wall-clock time has whole minutes; a relative one keeps now's milliseconds.
    expect(ok(parseWhen('tomorrow 10:45', now, BXL)) % 60_000).toBe(0);
    expect(ok(parseWhen('in 1h', now, BXL))).toBe(now + 3_600_000);
  });

  it('says what is wrong, and the past is an error', () => {
    const now = at('2026-10-17T07:00:00Z');
    const err = (text: string, tz = BXL) => {
      const r = parseWhen(text, now, tz);
      expect(r.ok, text).toBe(false);
      return r.ok ? '' : r.error;
    };
    expect(err('')).toMatch(/^Say when/);
    expect(err('next tuesday')).toMatch(/not a time I can read/);
    expect(err('2026-02-31 10:00')).toBe('2026-02-31 is not a date.');
    expect(err('tomorrow 25:00')).toMatch(/not a time of day/);
    expect(err('in 0m')).toMatch(/zero/);
    expect(err('in 5 parsecs')).toMatch(/not a duration/);
    expect(err('in 2h UTC')).toMatch(/goes with a clock time/);
    expect(err('today 08:00')).toMatch(/not in the future/); // 08:00 CEST is 06:00Z
    expect(err('2026-10-17 09:00')).toMatch(/not in the future/); // exactly now
    expect(err('08:00')).toBe('08:00 has passed today: say “tomorrow 08:00”.');
    expect(err('2020-01-01 00:00 UTC')).toMatch(/not in the future/);
  });
});

describe('the times as the dialog shows them', () => {
  it('the zone’s clock with its short name, the UTC hint, the field’s text', () => {
    const t = at('2026-10-18T08:45:00Z');
    expect(whenText(t, BXL)).toBe('Sun 18 Oct 2026, 10:45 CEST');
    expect(whenText(t, 'UTC')).toBe('Sun 18 Oct 2026, 08:45 UTC');
    expect(whenText(t, NYC)).toBe('Sun 18 Oct 2026, 04:45 EDT');
    expect(utcHint(t, BXL)).toBe('08:45 UTC');
    expect(utcHint(at('2026-10-17T23:30:00Z'), BXL)).toBe('Sat 17 Oct, 23:30 UTC'); // already the 18th in Brussels
    expect(wallText(t, BXL)).toBe('2026-10-18 10:45');
    expect(wallText(t, KOL, 'T')).toBe('2026-10-18T14:15');
  });

  it('a coarse countdown, and how late once past', () => {
    const now = at('2026-10-17T07:00:00Z');
    expect(countdownText(now + 40_000, now)).toBe('in 40 s');
    expect(countdownText(now + 3 * 60_000 + 5000, now)).toBe('in 3 min');
    expect(countdownText(now + 4 * 3_600_000 + 5 * 60_000, now)).toBe('in 4 h 5 min');
    expect(countdownText(now + 3_600_000, now)).toBe('in 1 h');
    expect(countdownText(now + 2 * 86_400_000 + 3 * 3_600_000, now)).toBe('in 2 d 3 h');
    expect(countdownText(now + 400, now)).toBe('due now');
    expect(countdownText(now - 3 * 60_000, now)).toBe('3 min overdue');
  });
});

describe('dayClockText (#66 the suggestion chip)', () => {
  const now = Date.UTC(2026, 9, 18, 21, 30); // Sun 18 Oct, 23:30 in Brussels
  it('names the day on the zone’s calendar', () => {
    expect(dayClockText(Date.UTC(2026, 9, 18, 21, 45), now, 'Europe/Brussels')).toBe('today 23:45');
    // 10:45 UTC on the 19th is tomorrow in Brussels, and in UTC too.
    expect(dayClockText(Date.UTC(2026, 9, 19, 10, 45), now, 'Europe/Brussels')).toBe('tomorrow 12:45');
    expect(dayClockText(Date.UTC(2026, 9, 19, 10, 45), now, 'UTC')).toBe('tomorrow 10:45');
    // 22:15 UTC on the 18th is already the 19th in Brussels: tomorrow there, today in UTC.
    expect(dayClockText(Date.UTC(2026, 9, 18, 22, 15), now, 'Europe/Brussels')).toBe('tomorrow 00:15');
    expect(dayClockText(Date.UTC(2026, 9, 18, 22, 15), now, 'UTC')).toBe('today 22:15');
  });
  it('a weekday within the week, else the date', () => {
    expect(dayClockText(Date.UTC(2026, 9, 21, 8, 0), now, 'UTC')).toBe('Wed 08:00');
    expect(dayClockText(Date.UTC(2026, 9, 31, 8, 0), now, 'UTC')).toBe('Sat 31 Oct 08:00');
    expect(dayClockText(Date.UTC(2027, 0, 2, 8, 0), now, 'UTC')).toBe('Sat 2 Jan 2027 08:00');
    expect(dayClockText(Date.UTC(2026, 9, 17, 8, 0), now, 'UTC')).toBe('yesterday 08:00');
  });
});
