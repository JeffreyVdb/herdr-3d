import { describe, expect, it } from 'vitest';
import { AsyncDrafts } from './asyncDrafts';

describe('AsyncDrafts (#157)', () => {
  it('#108 round 4: memory only while “Review prompt secrets” is on (no storage key holds an answer), written again once off', () => {
    const m = new Map<string, string>();
    const s = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
    let on = false;
    const a = new AsyncDrafts(s, () => !on);
    a.set('w1', 'th', 'b1', 0, 'plain');
    expect(m.size).toBe(1);
    on = true;
    a.persistChanged();
    expect(m.size).toBe(0);
    a.set('w1', 'th', 'b1', 1, 'pw=hunter2');
    expect([...m.values()].some((v) => v.includes('hunter2'))).toBe(false);
    expect(a.get('w1', 'th', 'b1', 1)).toBe('pw=hunter2');
    // A fresh page with the switch on finds nothing stored.
    expect(new AsyncDrafts(s, () => !on).get('w1', 'th', 'b1', 1)).toBe('');
    on = false;
    a.persistChanged();
    expect(new AsyncDrafts(s).get('w1', 'th', 'b1', 1)).toBe('pw=hunter2');
  });
});
