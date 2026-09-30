import { describe, expect, it } from 'vitest';
import { civilAt, clockFace } from './daylight';
import { overridesFrom, TimeOfDay, type TimeSettings } from './timeOfDay';

const settings = (timeZone: string | null = null, latitude: number | null = null): TimeSettings => ({ timeZone, latitude });
const q = (s: string) => new URLSearchParams(s);
const NOW = Date.parse('2026-09-30T19:20:00Z'); // 21:20 in Brussels

describe('the page overrides (M17)', () => {
  it('?time=, ?tz= and ?lat=', () => {
    expect(overridesFrom(q('time=23:00&tz=Asia/Tokyo&lat=50.85'))).toEqual({ time: { date: null, hour: 23, minute: 0 }, timeZone: 'Asia/Tokyo', latitude: 50.85 });
    expect(overridesFrom(q('time=2026-06-21T12:30'))).toMatchObject({ time: { date: { year: 2026, month: 6, day: 21 }, hour: 12, minute: 30 } });
    expect(overridesFrom(q(''))).toEqual({ time: null, timeZone: null, latitude: null });
  });

  it('ignore invalid values, each with a warning', () => {
    const warned: string[] = [];
    expect(overridesFrom(q('time=25:00&tz=%2B02:00&lat=north'), (m) => warned.push(m))).toEqual({ time: null, timeZone: null, latitude: null });
    expect(warned).toHaveLength(3);
    expect(warned.join('\n')).toMatch(/time=25:00[\s\S]*tz=\+02:00[\s\S]*lat=north/);
  });
});

describe('the time of day', () => {
  it('follows the real clock in the browser zone by default', () => {
    let now = NOW;
    const t = new TimeOfDay(settings(), overridesFrom(q('')), () => now);
    expect(t.pinned).toBe(false);
    expect(t.zoneSource).toBe('browser');
    expect(t.instant()).toBe(NOW);
    now += 60_000;
    expect(t.instant()).toBe(NOW + 60_000);
  });

  it('the setting beats the browser, the page beats the setting', () => {
    const s = { timeZone: 'Europe/Brussels' as string | null, latitude: 50.85 as number | null };
    const t = new TimeOfDay(s, overridesFrom(q('')), () => NOW);
    expect([t.timeZone, t.zoneSource, t.latitude]).toEqual(['Europe/Brussels', 'setting', 50.85]);
    expect(t.sample().model).toBe('latitude');
    const o = new TimeOfDay(s, overridesFrom(q('tz=America/New_York&lat=-33.9')), () => NOW);
    expect([o.timeZone, o.zoneSource, o.latitude]).toEqual(['America/New_York', 'override', -33.9]);
    // Settings changed later are read live.
    s.timeZone = 'Asia/Tokyo';
    expect(t.timeZone).toBe('Asia/Tokyo');
    expect(clockFace(t.sample().civil)).toEqual({ time: '04:20', date: 'Thu 1 Oct' });
  });

  it('a pinned HH:MM is that time today in the zone, frozen', () => {
    let now = NOW;
    const t = new TimeOfDay(settings('Europe/Brussels'), overridesFrom(q('time=23:00')), () => now);
    expect(t.pinned).toBe(true);
    expect(clockFace(civilAt(t.instant(), 'Europe/Brussels'))).toEqual({ time: '23:00', date: 'Wed 30 Sep' });
    now += 3 * 3600_000;
    expect(clockFace(civilAt(t.instant(), 'Europe/Brussels'))).toEqual({ time: '23:00', date: 'Wed 30 Sep' });
    expect(t.sample().daylight).toBe(0);
  });

  it('a pinned time follows a zone change (civil time in the effective zone)', () => {
    const s = { timeZone: 'Europe/Brussels' as string | null, latitude: null };
    const t = new TimeOfDay(s, overridesFrom(q('time=12:00')), () => NOW);
    s.timeZone = 'Asia/Tokyo';
    // 21:20 Brussels is already 1 Oct in Tokyo: noon there, that day.
    expect(clockFace(civilAt(t.instant(), 'Asia/Tokyo'))).toEqual({ time: '12:00', date: 'Thu 1 Oct' });
  });

  it('a pinned date and time', () => {
    const t = new TimeOfDay(settings(), overridesFrom(q('time=2026-12-21T12:00&tz=Europe/Brussels&lat=50.85')), () => NOW);
    const s = t.sample();
    expect(clockFace(s.civil)).toEqual({ time: '12:00', date: 'Mon 21 Dec' });
    expect(s.elevation).toBeCloseTo(90 - 50.85 - 23.44, 0);
  });
});
