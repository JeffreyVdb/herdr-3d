import { describe, expect, test } from 'vitest';
import { civilAt, clockFace, daylightAt, isNamedTimeZone, parseLatitude, parseTimeSpec, standardOffset, sunPosition, warmthOf, zonedInstant } from './daylight';

const BXL = 'Europe/Brussels';
/** The Brussels instant its clock reads y-m-d h:m (the zone's own offset). */
const at = (iso: string) => {
  const m = /^(\d+)-(\d+)-(\d+)T(\d+):(\d+)$/.exec(iso);
  if (!m) throw new Error(iso);
  return zonedInstant(+m[1]!, +m[2]!, +m[3]!, +m[4]!, +m[5]!, BXL);
};

describe('the zone clock', () => {
  test.each([
    // Spring forward, 29 Mar 2026 01:00 UTC: 01:59:59 CET → 03:00:00 CEST; 02:xx never shows.
    ['2026-03-29T00:59:59Z', 1, 59, 59, 60],
    ['2026-03-29T01:00:00Z', 3, 0, 0, 120],
    // Fall back, 25 Oct 2026 01:00 UTC: 02:59:59 CEST → 02:00:00 CET; 02:30 shows twice.
    ['2026-10-25T00:59:59Z', 2, 59, 59, 120],
    ['2026-10-25T01:00:00Z', 2, 0, 0, 60],
    ['2026-10-25T00:30:00Z', 2, 30, 0, 120],
    ['2026-10-25T01:30:00Z', 2, 30, 0, 60],
    // Midnight is 00, not 24.
    ['2026-09-29T22:00:00Z', 0, 0, 0, 120],
  ])('%s in Brussels', (iso, hour, minute, second, offset) => {
    expect(civilAt(new Date(iso), BXL)).toMatchObject({ hour, minute, second, offset });
  });

  test('the standard offset is the smaller of January and July (south of the equator too)', () => {
    expect(standardOffset(2026, BXL)).toBe(60);
    expect(standardOffset(2026, 'Australia/Sydney')).toBe(600);
    expect(standardOffset(2026, 'UTC')).toBe(0);
  });

  test('a zoned wall time back to an instant, across both changes', () => {
    expect(new Date(at('2026-06-15T12:00')).toISOString()).toBe('2026-06-15T10:00:00.000Z');
    expect(new Date(at('2026-12-15T12:00')).toISOString()).toBe('2026-12-15T11:00:00.000Z');
    // 02:30 on 29 Mar does not exist: it lands an hour on, at 03:30 CEST.
    expect(civilAt(at('2026-03-29T02:30'), BXL)).toMatchObject({ hour: 3, minute: 30 });
    // 02:30 on 25 Oct shows twice: its second showing (CET).
    expect(new Date(at('2026-10-25T02:30')).toISOString()).toBe('2026-10-25T01:30:00.000Z');
  });
});

describe('the fixed curve (no latitude)', () => {
  const d = (hm: string, date = '2026-09-30') => daylightAt(at(`${date}T${hm}`), BXL);

  test('night at midnight, day at noon, ramps at dawn and dusk', () => {
    expect(d('00:00').daylight).toBe(0);
    expect(d('06:29').daylight).toBe(0);
    expect(d('07:15').daylight).toBeCloseTo(0.5, 5);
    expect(d('08:00').daylight).toBe(1);
    expect(d('12:00').daylight).toBe(1);
    expect(d('18:30').daylight).toBe(1);
    expect(d('19:15').daylight).toBeCloseTo(0.5, 5);
    expect(d('20:00').daylight).toBe(0);
    expect(d('23:00').daylight).toBe(0);
    expect(d('12:00').model).toBe('fixed');
  });

  test('dawn and dusk change gradually: no minute moves the light by more than 2 %', () => {
    let prev = d('00:00').daylight;
    for (let m = 1; m < 24 * 60; m++) {
      const v = d(`${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`).daylight;
      expect(Math.abs(v - prev)).toBeLessThan(0.02);
      prev = v;
    }
  });

  test('the sun is up by day, highest at 13:15, from the east in the morning and the west at dusk; warm at dawn and dusk only', () => {
    expect(d('13:15').elevation).toBeCloseTo(57, 5);
    expect(d('13:15').azimuth).toBeCloseTo(180, 5);
    expect(d('09:00').azimuth).toBeLessThan(180);
    expect(d('18:00').azimuth).toBeGreaterThan(180);
    expect(d('02:00').elevation).toBeLessThan(-30);
    expect(d('07:15').warmth).toBeGreaterThan(0.9);
    expect(d('19:15').warmth).toBeGreaterThan(0.9);
    expect(d('12:00').warmth).toBe(0);
    expect(d('00:00').warmth).toBe(0);
  });

  test('clock time, so summer time moves it with the clock', () => {
    // 07:15 on the clock is mid-dawn in winter and in summer alike.
    expect(d('07:15', '2026-01-15').daylight).toBeCloseTo(0.5, 5);
    expect(d('07:15', '2026-07-15').daylight).toBeCloseTo(0.5, 5);
    expect(d('07:15', '2026-07-15').dst).toBe(true);
    expect(d('07:15', '2026-01-15').dst).toBe(false);
  });

  test('around both 2026 changes in Brussels', () => {
    // 29 Mar: 01:59 CET then 03:00 CEST, both night; the morning after is the usual curve.
    expect(daylightAt(new Date('2026-03-29T00:59:00Z'), BXL).daylight).toBe(0);
    expect(daylightAt(new Date('2026-03-29T01:00:00Z'), BXL).daylight).toBe(0);
    expect(daylightAt(at('2026-03-29T07:15'), BXL).daylight).toBeCloseTo(0.5, 5);
    // 25 Oct: both 02:30s are night, same clock face, one in summer time, one not.
    const a = daylightAt(new Date('2026-10-25T00:30:00Z'), BXL);
    const b = daylightAt(new Date('2026-10-25T01:30:00Z'), BXL);
    expect([a.daylight, b.daylight]).toEqual([0, 0]);
    expect(clockFace(a.civil)).toEqual(clockFace(b.civil));
    expect([a.dst, b.dst]).toEqual([true, false]);
    expect(daylightAt(at('2026-10-25T19:15'), BXL).daylight).toBeCloseTo(0.5, 5);
  });
});

describe('the latitude model', () => {
  const BRUSSELS = 50.85;
  /** Hours of daylight over 50 or more for a day, minute by minute. */
  const dayLength = (date: string, lat: number, zone = BXL) => {
    const start = zone === BXL ? at(`${date}T00:00`) : Date.parse(`${date}T00:00:00Z`);
    let n = 0;
    for (let m = 0; m < 24 * 60; m++) if (daylightAt(start + m * 60_000, zone, lat).daylight >= 0.5) n++;
    return n / 60;
  };

  test('Brussels: a June day is much longer than a December day, noon at 13:00 on the summer clock', () => {
    const june = dayLength('2026-06-21', BRUSSELS);
    const dec = dayLength('2026-12-21', BRUSSELS);
    expect(june).toBeGreaterThan(16);
    expect(june).toBeLessThan(17.5);
    expect(dec).toBeGreaterThan(7.5);
    expect(dec).toBeLessThan(9);
    // Solar noon (no longitude) is 12:00 standard time: 13:00 on the clock in summer, 12:00 in winter.
    const summer = daylightAt(at('2026-06-21T13:00'), BXL, BRUSSELS);
    expect(summer.azimuth).toBeCloseTo(180, 0);
    expect(summer.elevation).toBeCloseTo(90 - BRUSSELS + 23.44, 0);
    const winter = daylightAt(at('2026-12-21T12:00'), BXL, BRUSSELS);
    expect(winter.azimuth).toBeCloseTo(180, 0);
    expect(winter.elevation).toBeCloseTo(90 - BRUSSELS - 23.44, 0);
    expect(summer.model).toBe('latitude');
  });

  test('night at midnight, full day at noon, dawn gradual', () => {
    expect(daylightAt(at('2026-09-30T00:00'), BXL, BRUSSELS).daylight).toBe(0);
    expect(daylightAt(at('2026-09-30T13:00'), BXL, BRUSSELS).daylight).toBe(1);
    let prev = 0;
    for (let m = 5 * 60; m < 10 * 60; m++) {
      const v = daylightAt(at('2026-09-30T00:00') + m * 60_000, BXL, BRUSSELS).daylight;
      expect(v).toBeGreaterThanOrEqual(prev);
      expect(v - prev).toBeLessThan(0.03);
      prev = v;
    }
    expect(prev).toBe(1);
  });

  test('the equator has about twelve hours every season; the south has its summer in December', () => {
    expect(dayLength('2026-06-21', 0, 'UTC')).toBeGreaterThan(11.8);
    expect(dayLength('2026-06-21', 0, 'UTC')).toBeLessThan(12.8);
    expect(dayLength('2026-12-21', -33.9, 'UTC')).toBeGreaterThan(dayLength('2026-06-21', -33.9, 'UTC') + 3);
    // Seen from the south, the noon sun stands in the north.
    const s = sunPosition(-33.9, 172, 12);
    expect(Math.min(s.azimuth, 360 - s.azimuth)).toBeLessThan(1);
  });

  test('polar day and polar night just clamp', () => {
    expect(dayLength('2026-06-21', 78.2, 'UTC')).toBe(24);
    expect(dayLength('2026-12-21', 78.2, 'UTC')).toBe(0);
    expect(dayLength('2026-06-21', 90, 'UTC')).toBe(24);
    expect(dayLength('2026-06-21', -90, 'UTC')).toBe(0);
  });

  test('warmth peaks on the horizon and is gone high up and deep at night', () => {
    expect(warmthOf(0)).toBeGreaterThan(0.9);
    expect(warmthOf(20)).toBe(0);
    expect(warmthOf(-12)).toBe(0);
  });
});

describe('the clock face', () => {
  test('24-hour HH:MM and the date in the zone', () => {
    expect(clockFace(civilAt(new Date('2026-09-30T12:05:00Z'), BXL))).toEqual({ time: '14:05', date: 'Wed 30 Sep' });
    expect(clockFace(civilAt(new Date('2026-09-30T12:05:00Z'), 'Asia/Tokyo'))).toEqual({ time: '21:05', date: 'Wed 30 Sep' });
    expect(clockFace(civilAt(new Date('2026-09-30T12:05:00Z'), 'America/New_York'))).toEqual({ time: '08:05', date: 'Wed 30 Sep' });
  });

  test('midnight rolls the date over (and the month, and the year)', () => {
    expect(clockFace(civilAt(new Date('2026-09-30T21:59:00Z'), BXL))).toEqual({ time: '23:59', date: 'Wed 30 Sep' });
    expect(clockFace(civilAt(new Date('2026-09-30T22:00:00Z'), BXL))).toEqual({ time: '00:00', date: 'Thu 1 Oct' });
    expect(clockFace(civilAt(new Date('2026-12-31T23:00:00Z'), BXL))).toEqual({ time: '00:00', date: 'Fri 1 Jan' });
    // In Tokyo it is already tomorrow.
    expect(clockFace(civilAt(new Date('2026-09-30T15:00:00Z'), 'Asia/Tokyo')).date).toBe('Thu 1 Oct');
  });

  test('across summer time: the jump forward and the repeated hour', () => {
    expect(clockFace(civilAt(new Date('2026-03-29T00:59:00Z'), BXL)).time).toBe('01:59');
    expect(clockFace(civilAt(new Date('2026-03-29T01:00:00Z'), BXL)).time).toBe('03:00');
    expect(clockFace(civilAt(new Date('2026-10-25T00:59:00Z'), BXL)).time).toBe('02:59');
    expect(clockFace(civilAt(new Date('2026-10-25T01:00:00Z'), BXL)).time).toBe('02:00');
  });
});

describe('what the operator may type', () => {
  test('named zones, aliases included; offsets and nonsense refused', () => {
    for (const z of ['Europe/Brussels', 'UTC', 'Europe/Kiev', 'Europe/Kyiv', 'America/Argentina/Buenos_Aires', ' Asia/Tokyo ', 'Etc/GMT+2']) expect(isNamedTimeZone(z), z).toBe(true);
    for (const z of ['', '  ', '+02:00', '-0500', 'UTC+1', 'GMT-3', 'Mars/Olympus', 'Brussels', '2']) expect(isNamedTimeZone(z), z).toBe(false);
  });

  test('latitudes', () => {
    expect(parseLatitude('50.85')).toBe(50.85);
    expect(parseLatitude(' -33.9 ')).toBe(-33.9);
    expect(parseLatitude('+90')).toBe(90);
    expect(parseLatitude('0')).toBe(0);
    for (const s of ['', '91', '-90.01', 'north', '50,85', '1e1', 'NaN', 'Infinity']) expect(parseLatitude(s), s).toBeNull();
  });

  test('pinned times', () => {
    expect(parseTimeSpec('23:00')).toEqual({ date: null, hour: 23, minute: 0 });
    expect(parseTimeSpec('7:05')).toEqual({ date: null, hour: 7, minute: 5 });
    expect(parseTimeSpec('2026-06-21T12:30')).toEqual({ date: { year: 2026, month: 6, day: 21 }, hour: 12, minute: 30 });
    for (const s of ['24:00', '12:60', '12', 'noon', '2026-02-30T12:00', '2026-13-01T12:00', '12:00:00', '2026-06-21 12:30']) expect(parseTimeSpec(s), s).toBeNull();
  });
});
