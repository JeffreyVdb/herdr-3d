import { describe, expect, it } from 'vitest';
import { OverviewPrefs, parseCollapsed } from './overviewPrefs';

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

describe('overview prefs (#118)', () => {
  it('parse: a list of group keys; anything else is none collapsed (every group expanded)', () => {
    expect([...parseCollapsed('["o1","ghost:o2"]')]).toEqual(['o1', 'ghost:o2']);
    for (const raw of [null, '', '{', '{"a":1}', '"o1"', '[1,null,{}]', 'null']) expect(parseCollapsed(raw).size, String(raw)).toBe(0);
    expect([...parseCollapsed('["o1",3,"o1",""]')]).toEqual(['o1']);
  });

  it('default expanded; collapsing remembers the orchestrator id for the next page; expanding forgets it', () => {
    const st = memory();
    const p = new OverviewPrefs(st);
    expect(p.collapsed('o1')).toBe(false);
    p.setCollapsed('o1', true);
    expect(p.collapsed('o1')).toBe(true);
    expect(JSON.parse(st.m.get('h3d.overview.collapsed') ?? '[]')).toEqual(['o1']);
    expect(new OverviewPrefs(st).collapsed('o1')).toBe(true);
    p.setCollapsed('o1', false);
    expect(new OverviewPrefs(st).collapsed('o1')).toBe(false);
  });

  it('collapse all / expand all over a set of keys', () => {
    const st = memory();
    const p = new OverviewPrefs(st);
    p.setAll(['o1', 'o2', 'unlinked'], true);
    expect([...p.set].sort()).toEqual(['o1', 'o2', 'unlinked']);
    p.setAll(['o1', 'unlinked'], false);
    expect([...p.set]).toEqual(['o2']);
  });

  it('works without storage, or with storage that throws (in this page only)', () => {
    for (const st of [null, broken()]) {
      const p = new OverviewPrefs(st);
      expect(p.collapsed('o1')).toBe(false);
      p.setCollapsed('o1', true);
      expect(p.collapsed('o1')).toBe(true);
    }
  });

  it('keeps at most the last 200 keys', () => {
    const st = memory();
    const p = new OverviewPrefs(st);
    for (let i = 0; i < 250; i++) p.setCollapsed(`o${i}`, true);
    const kept = JSON.parse(st.m.get('h3d.overview.collapsed') ?? '[]') as string[];
    expect(kept.length).toBe(200);
    expect(kept.at(-1)).toBe('o249');
    expect(kept[0]).toBe('o50');
  });
});
