import { describe, expect, it } from 'vitest';
import { DEFAULT_INBOX_SETTINGS, InboxPrefs, parseInboxSettings } from './inboxPrefs';

const memory = () => {
  const m = new Map<string, string>();
  return { m, getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
};
const broken = () => {
  const boom = (): never => {
    throw new Error('blocked');
  };
  return { getItem: boom, setItem: boom };
};

describe('inbox prefs (#100)', () => {
  it('start from the defaults: shown, desktop and chime on at 0.6, both kinds, no freelancers', () => {
    expect(new InboxPrefs(memory()).settings).toEqual({ show: true, desktop: true, chime: true, chimeVolume: 0.6, onNeeds: true, onFinished: true, freelancers: false });
    expect(new InboxPrefs(null).settings).toEqual(DEFAULT_INBOX_SETTINGS);
  });

  it('parse garbage, wrong types and missing keys to their defaults, keeping what is good', () => {
    for (const raw of [null, '', 'not json', '[]', '42', 'null', '"x"']) expect(parseInboxSettings(raw)).toEqual(DEFAULT_INBOX_SETTINGS);
    expect(parseInboxSettings(JSON.stringify({ chime: 'yes', desktop: false, chimeVolume: 'loud', freelancers: true, extra: 1 }))).toEqual({
      ...DEFAULT_INBOX_SETTINGS,
      desktop: false,
      freelancers: true,
    });
  });

  it('clamp the chime volume to 0..1 and drop one that is not a number', () => {
    expect(parseInboxSettings('{"chimeVolume":3}').chimeVolume).toBe(1);
    expect(parseInboxSettings('{"chimeVolume":-1}').chimeVolume).toBe(0);
    expect(parseInboxSettings('{"chimeVolume":0.25}').chimeVolume).toBe(0.25);
    const p = new InboxPrefs(memory());
    p.set({ chimeVolume: 7 });
    expect(p.settings.chimeVolume).toBe(1);
    p.set({ chimeVolume: Number.NaN });
    expect(p.settings.chimeVolume).toBe(DEFAULT_INBOX_SETTINGS.chimeVolume);
  });

  it('remember a change in one key, read back by the next page', () => {
    const st = memory();
    const p = new InboxPrefs(st);
    p.set({ chime: false, chimeVolume: 0.3, onFinished: false });
    expect([...st.m.keys()]).toEqual(['h3d.inbox']);
    expect(new InboxPrefs(st).settings).toEqual({ ...DEFAULT_INBOX_SETTINGS, chime: false, chimeVolume: 0.3, onFinished: false });
  });

  it('tell the listeners only when something changed, and stop after the unsubscribe', () => {
    const p = new InboxPrefs(memory());
    let calls = 0;
    const off = p.onChange(() => calls++);
    p.set({ chime: true }); // already on
    p.set({});
    expect(calls).toBe(0);
    p.set({ chime: false });
    expect(calls).toBe(1);
    p.set({ chime: false });
    expect(calls).toBe(1);
    off();
    p.set({ chime: true });
    expect(calls).toBe(1);
  });

  it('work without storage: missing or throwing on every access, a change holds for the page', () => {
    for (const st of [null, broken()]) {
      const p = new InboxPrefs(st);
      expect(p.settings).toEqual(DEFAULT_INBOX_SETTINGS);
      let calls = 0;
      p.onChange(() => calls++);
      expect(() => p.set({ desktop: false })).not.toThrow();
      expect(p.settings.desktop).toBe(false);
      expect(calls).toBe(1);
    }
  });
});
