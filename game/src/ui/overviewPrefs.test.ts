import { describe, expect, it } from 'vitest';
import { OverviewFilterPrefs, OverviewPrefs, parseCollapsed, parseFilter } from './overviewPrefs';

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

describe('overview prefs: floors (#188)', () => {
  it('parse: `floor:<session>` keys and the `open:` marker of a floor opened against its default are kept like any other', () => {
    expect([...parseCollapsed('["floor:lab","open:floor:pastry","o1","unlinked:lab"]')]).toEqual(['floor:lab', 'open:floor:pastry', 'o1', 'unlinked:lab']);
  });

  it('a floor collapses and expands like a group; remembered for the next page', () => {
    const st = memory();
    const p = new OverviewPrefs(st);
    p.setCollapsed('floor:lab', true);
    expect(new OverviewPrefs(st).collapsed('floor:lab')).toBe(true);
    p.setCollapsed('floor:lab', false);
    expect(new OverviewPrefs(st).collapsed('floor:lab')).toBe(false);
  });

  it('an asleep floor starts collapsed; opened, it stays open (an `open:` marker), and folds again when asked', () => {
    const st = memory();
    const p = new OverviewPrefs(st);
    expect(p.collapsed('floor:den', true)).toBe(true);
    expect([...p.effective(['floor:den'])]).toEqual(['floor:den']);
    p.setCollapsed('floor:den', false, true);
    expect(p.collapsed('floor:den', true)).toBe(false);
    expect(JSON.parse(st.m.get('h3d.overview.collapsed') ?? '[]')).toEqual(['open:floor:den']);
    const again = new OverviewPrefs(st);
    expect(again.collapsed('floor:den', true)).toBe(false);
    expect([...again.effective(['floor:den'])]).toEqual([]);
    again.setCollapsed('floor:den', true, true);
    expect(again.collapsed('floor:den', true)).toBe(true);
    expect(JSON.parse(st.m.get('h3d.overview.collapsed') ?? '[]')).toEqual(['floor:den']);
    // Awake again, a floor folded while asleep stays folded.
    expect(again.collapsed('floor:den')).toBe(true);
  });

  it('expand all / collapse all act on floors and orchestrators together, each against its own default', () => {
    const st = memory();
    const p = new OverviewPrefs(st);
    const sleepy = new Set(['floor:den']);
    p.setAll(['floor:top', 'o1', 'floor:den'], false, sleepy);
    expect([...p.effective(sleepy)]).toEqual([]);
    p.setAll(['floor:top', 'o1', 'floor:den'], true, sleepy);
    expect([...p.effective(sleepy)].sort()).toEqual(['floor:den', 'floor:top', 'o1']);
  });
});

describe('overview filter (#188)', () => {
  it('parse: `active` or `all`; anything else is the view’s default', () => {
    expect(parseFilter('active', false)).toBe(true);
    expect(parseFilter('all', true)).toBe(false);
    for (const raw of [null, '', 'ACTIVE', '1', '"all"']) {
      expect(parseFilter(raw, true), String(raw)).toBe(true);
      expect(parseFilter(raw, false), String(raw)).toBe(false);
    }
  });

  it('defaults: active only on the all-floors page, all on a floor’s page; each view remembers its own', () => {
    const st = memory();
    const f = new OverviewFilterPrefs(st);
    expect(f.activeOnly('city')).toBe(true);
    expect(f.activeOnly('floor')).toBe(false);
    f.setActiveOnly('floor', true);
    f.setActiveOnly('city', false);
    const again = new OverviewFilterPrefs(st);
    expect(again.activeOnly('floor')).toBe(true);
    expect(again.activeOnly('city')).toBe(false);
    expect(st.m.get('h3d.overview.filter.floor')).toBe('active');
    expect(st.m.get('h3d.overview.filter.city')).toBe('all');
  });

  it('works without storage, or with storage that throws (in this page only)', () => {
    for (const st of [null, broken()]) {
      const f = new OverviewFilterPrefs(st);
      expect(f.activeOnly('city')).toBe(true);
      f.setActiveOnly('city', false);
      expect(f.activeOnly('city')).toBe(false);
    }
  });
});
