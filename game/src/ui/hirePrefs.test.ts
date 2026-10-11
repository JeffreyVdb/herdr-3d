import { describe, expect, it } from 'vitest';
import { HirePrefs } from './hirePrefs';

const memory = () => {
  const m = new Map<string, string>();
  return { m, getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
};
const broken = () => {
  const boom = (): never => {
    throw new Error('blocked');
  };
  return { getItem: boom, setItem: boom, removeItem: boom };
};

describe('hire prefs (#116)', () => {
  it('start on, with no storage, empty storage or a value that is not "off"', () => {
    expect(new HirePrefs(null).goToNew).toBe(true);
    expect(new HirePrefs(memory()).goToNew).toBe(true);
    for (const raw of ['', 'on', 'true', 'false', '0', 'OFF']) {
      const st = memory();
      st.m.set('h3d.hire.goto', raw);
      expect(new HirePrefs(st).goToNew).toBe(true);
    }
  });

  it('store only the choice that is not the default, read back by the next page', () => {
    const st = memory();
    const p = new HirePrefs(st);
    p.goToNew = false;
    expect([...st.m.entries()]).toEqual([['h3d.hire.goto', 'off']]);
    expect(new HirePrefs(st).goToNew).toBe(false);
    p.goToNew = true;
    expect(st.m.size).toBe(0);
    expect(new HirePrefs(st).goToNew).toBe(true);
  });

  it('tell the listeners only when the value changed, and stop after the unsubscribe', () => {
    const p = new HirePrefs(memory());
    let calls = 0;
    const off = p.onChange(() => calls++);
    p.goToNew = true; // already on
    expect(calls).toBe(0);
    p.goToNew = false;
    expect(calls).toBe(1);
    p.goToNew = false;
    expect(calls).toBe(1);
    off();
    p.goToNew = true;
    expect(calls).toBe(1);
  });

  it('work when storage throws on every access: on by default, a change holds for the page', () => {
    const p = new HirePrefs(broken());
    expect(p.goToNew).toBe(true);
    let calls = 0;
    p.onChange(() => calls++);
    expect(() => (p.goToNew = false)).not.toThrow();
    expect(p.goToNew).toBe(false);
    expect(calls).toBe(1);
  });
});

describe('hire in background (#210)', () => {
  it('starts off, with no storage, empty storage or a value that is not "on"', () => {
    expect(new HirePrefs(null).hireInBackground).toBe(false);
    expect(new HirePrefs(memory()).hireInBackground).toBe(false);
    for (const raw of ['', 'off', 'true', '1', 'ON']) {
      const st = memory();
      st.m.set('h3d.hire.background', raw);
      expect(new HirePrefs(st).hireInBackground).toBe(false);
    }
  });

  it('stores only "on", read back by the next page, next to the go-to choice', () => {
    const st = memory();
    const p = new HirePrefs(st);
    p.hireInBackground = true;
    expect([...st.m.entries()]).toEqual([['h3d.hire.background', 'on']]);
    expect(new HirePrefs(st).hireInBackground).toBe(true);
    p.goToNew = false;
    const again = new HirePrefs(st);
    expect([again.hireInBackground, again.goToNew]).toEqual([true, false]);
    p.hireInBackground = false;
    expect([...st.m.entries()]).toEqual([['h3d.hire.goto', 'off']]);
    expect(new HirePrefs(st).hireInBackground).toBe(false);
  });

  it('tells the same listeners, only on a change', () => {
    const p = new HirePrefs(memory());
    let calls = 0;
    p.onChange(() => calls++);
    p.hireInBackground = false;
    expect(calls).toBe(0);
    p.hireInBackground = true;
    p.hireInBackground = true;
    expect(calls).toBe(1);
  });

  it('works when storage throws: off by default, a change holds for the page', () => {
    const p = new HirePrefs(broken());
    expect(p.hireInBackground).toBe(false);
    expect(() => (p.hireInBackground = true)).not.toThrow();
    expect(p.hireInBackground).toBe(true);
  });
});


describe('worktree default', () => {
  it('defaults on and remembers an off choice across page loads independently of other hire preferences', () => {
    const st = memory();
    const prefs = new HirePrefs(st);
    expect(prefs.worktreeByDefault).toBe(true);
    prefs.worktreeByDefault = false;
    prefs.hireInBackground = true;
    expect(new HirePrefs(st).worktreeByDefault).toBe(false);
    expect(new HirePrefs(st).hireInBackground).toBe(true);
    prefs.worktreeByDefault = true;
    expect(st.m.has('h3d.hire.worktree')).toBe(false);
    expect(new HirePrefs(st).worktreeByDefault).toBe(true);
  });

  it('works without storage and notifies only on changes, until unsubscribed', () => {
    for (const st of [null, broken()]) {
      const prefs = new HirePrefs(st);
      let calls = 0;
      const off = prefs.onChange(() => calls++);
      prefs.worktreeByDefault = true;
      prefs.worktreeByDefault = false;
      prefs.worktreeByDefault = false;
      expect(prefs.worktreeByDefault).toBe(false);
      expect(calls).toBe(1);
      off();
      prefs.worktreeByDefault = true;
      expect(calls).toBe(1);
    }
  });
});
