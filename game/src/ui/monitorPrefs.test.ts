import { describe, expect, it } from 'vitest';
import { MonitorPrefs } from './monitorPrefs';

function memory(init: Record<string, string> = {}): Storage {
  const m = new Map(Object.entries(init));
  return {
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => void m.delete(k),
    setItem: (k, v) => void m.set(k, v),
  };
}

const throwing: Storage = {
  length: 0,
  clear() {
    throw new Error('blocked');
  },
  getItem() {
    throw new Error('blocked');
  },
  key() {
    throw new Error('blocked');
  },
  removeItem() {
    throw new Error('blocked');
  },
  setItem() {
    throw new Error('blocked');
  },
};

describe('MonitorPrefs (#98)', () => {
  it('shows the activity card by default, and remembers Terminal', () => {
    const s = memory();
    const p = new MonitorPrefs(s);
    expect(p.monitors).toBe('activity');
    p.monitors = 'terminal';
    expect(s.getItem('h3d.monitors')).toBe('terminal');
    expect(new MonitorPrefs(s).monitors).toBe('terminal');
    p.monitors = 'activity';
    expect(s.getItem('h3d.monitors')).toBeNull();
  });

  it('ignores a stored value that is not one of its own', () => {
    expect(new MonitorPrefs(memory({ 'h3d.monitors': 'banana' })).monitors).toBe('activity');
  });

  it('tells its listeners of a change, once', () => {
    const p = new MonitorPrefs(memory());
    let n = 0;
    const off = p.onChange(() => n++);
    p.monitors = 'terminal';
    p.monitors = 'terminal';
    expect(n).toBe(1);
    off();
    p.monitors = 'activity';
    expect(n).toBe(1);
  });

  it('works without storage, or with storage that throws', () => {
    const none = new MonitorPrefs(null);
    none.monitors = 'terminal';
    expect(none.monitors).toBe('terminal');
    const bad = new MonitorPrefs(throwing);
    expect(bad.monitors).toBe('activity');
    expect(() => (bad.monitors = 'terminal')).not.toThrow();
    expect(bad.monitors).toBe('terminal');
  });
});
