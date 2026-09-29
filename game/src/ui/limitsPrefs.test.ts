import { describe, expect, it } from 'vitest';
import { LimitsPrefs } from './limitsPrefs';

const memory = (): Storage => {
  const m = new Map<string, string>();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k), clear: () => m.clear(), key: () => null, length: 0 };
};
const broken = (): Storage => {
  const boom = () => {
    throw new Error('blocked');
  };
  return { getItem: boom, setItem: boom, removeItem: boom, clear: boom, key: boom, length: 0 };
};

describe('limits prefs', () => {
  it('are on and collapsed by default, and remembered', () => {
    const st = memory();
    const p = new LimitsPrefs(st);
    expect([p.hidden, p.open]).toEqual([false, false]);
    p.open = true;
    p.hidden = true;
    expect([new LimitsPrefs(st).hidden, new LimitsPrefs(st).open]).toEqual([true, true]);
    p.open = false;
    p.hidden = false;
    expect([new LimitsPrefs(st).hidden, new LimitsPrefs(st).open]).toEqual([false, false]);
  });

  it('work without storage: missing, or throwing on every access, the choice holds for the page', () => {
    for (const st of [null, broken()]) {
      const p = new LimitsPrefs(st);
      expect(() => {
        p.open = true;
        p.hidden = true;
      }).not.toThrow();
      expect([p.open, p.hidden]).toEqual([true, true]);
      p.open = false;
      p.hidden = false;
      expect([p.open, p.hidden]).toEqual([false, false]);
    }
  });

  it('read what is stored once, then keep their own state', () => {
    const st = memory();
    st.setItem('h3d.limits.open', '1');
    const p = new LimitsPrefs(st);
    expect(p.open).toBe(true);
    st.removeItem('h3d.limits.open'); // storage changing under it does not flip the page
    expect(p.open).toBe(true);
  });

  it('tell listeners when hidden changes', () => {
    const p = new LimitsPrefs(memory());
    let n = 0;
    const off = p.onChange(() => n++);
    p.hidden = true;
    off();
    p.hidden = false;
    expect(n).toBe(1);
  });
});
