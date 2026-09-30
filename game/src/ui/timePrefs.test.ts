import { describe, expect, it } from 'vitest';
import { TimePrefs } from './timePrefs';

const memory = (init: Record<string, string> = {}): Storage & { dump(): Record<string, string> } => {
  const m = new Map<string, string>(Object.entries(init));
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k), clear: () => m.clear(), key: () => null, length: 0, dump: () => Object.fromEntries(m) };
};
const broken = (): Storage => {
  const boom = () => {
    throw new Error('blocked');
  };
  return { getItem: boom, setItem: boom, removeItem: boom, clear: boom, key: boom, length: 0 };
};

describe('time prefs (M17)', () => {
  it('default to the browser zone and the fixed curve, and remember a choice', () => {
    const st = memory();
    const p = new TimePrefs(st);
    expect([p.timeZone, p.latitude]).toEqual([null, null]);
    expect(p.setTimeZone(' Europe/Brussels ')).toEqual({ ok: true });
    expect(p.setLatitude('50.85')).toEqual({ ok: true });
    const again = new TimePrefs(st);
    expect([again.timeZone, again.latitude]).toEqual(['Europe/Brussels', 50.85]);
    expect(st.dump()).toEqual({ 'h3d.time.zone': 'Europe/Brussels', 'h3d.time.lat': '50.85' });
    // Empty clears each back to its default.
    p.setTimeZone('');
    p.setLatitude('  ');
    expect([p.timeZone, p.latitude]).toEqual([null, null]);
    expect(st.dump()).toEqual({});
  });

  it('refuse what the browser cannot use, say why, and keep the last good value', () => {
    const st = memory();
    const p = new TimePrefs(st);
    p.setTimeZone('Asia/Tokyo');
    p.setLatitude('-33.9');
    const zone = p.setTimeZone('+02:00');
    expect(zone.ok).toBe(false);
    expect(!zone.ok && zone.error).toMatch(/not an offset/);
    const unknown = p.setTimeZone('Mars/Olympus');
    expect(!unknown.ok && unknown.error).toMatch(/does not know “Mars\/Olympus”/);
    const lat = p.setLatitude('95');
    expect(!lat.ok && lat.error).toMatch(/−90/);
    expect([p.timeZone, p.latitude]).toEqual(['Asia/Tokyo', -33.9]);
    expect(st.dump()).toEqual({ 'h3d.time.zone': 'Asia/Tokyo', 'h3d.time.lat': '-33.9' });
  });

  it('accept aliases the browser knows', () => {
    const p = new TimePrefs(memory());
    for (const z of ['UTC', 'Europe/Kiev']) expect(p.setTimeZone(z), z).toEqual({ ok: true });
  });

  it('ignore stored garbage (a hand-edited or older value)', () => {
    const p = new TimePrefs(memory({ 'h3d.time.zone': 'Nowhere/Land', 'h3d.time.lat': 'north' }));
    expect([p.timeZone, p.latitude]).toEqual([null, null]);
  });

  it('tell listeners about a change, and only a change', () => {
    const p = new TimePrefs(memory());
    let n = 0;
    const off = p.onChange(() => n++);
    p.setTimeZone('UTC');
    p.setTimeZone('UTC');
    p.setTimeZone('nope/nope');
    p.setLatitude('10');
    p.setLatitude('10');
    expect(n).toBe(2);
    off();
    p.setLatitude('');
    expect(n).toBe(2);
  });

  it('work without storage: missing, or throwing on every access', () => {
    for (const st of [null, broken()]) {
      const p = new TimePrefs(st);
      expect(p.setTimeZone('Europe/Brussels')).toEqual({ ok: true });
      expect(p.setLatitude('50')).toEqual({ ok: true });
      expect([p.timeZone, p.latitude]).toEqual(['Europe/Brussels', 50]);
    }
  });
});
