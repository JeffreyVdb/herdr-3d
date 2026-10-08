import { describe, expect, it } from 'vitest';
import { HireModelPrefs, parseHidden } from './hireModelPrefs';

const KEY = 'h3d.hire.hiddenModels';

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

describe('harness model prefs', () => {
  it('show every model with no storage, empty storage, or a value that is not a list of slugs', () => {
    expect(new HireModelPrefs(null).hidden('codex').size).toBe(0);
    expect(new HireModelPrefs(memory()).isShown('claude', 'any-model')).toBe(true);
    for (const raw of ['', 'nope', '[]', '"x"', 'null', '42', '{"codex":"a"}', '{"codex":[1,null,{}]}', '{"codex":[""]}', '{"codex":{"a":1}}']) {
      const st = memory();
      st.m.set(KEY, raw);
      expect(new HireModelPrefs(st).hidden('codex').size, raw).toBe(0);
    }
  });

  it('keep the good entries of a partly malformed value and drop the rest', () => {
    expect(parseHidden('{"codex":["a",1,"a","b"],"claude":"nope","x":[]}')).toEqual({ codex: ['a', 'b'] });
  });

  it('keep each harness apart: hiding in one does not touch the other', () => {
    const p = new HireModelPrefs(memory());
    p.setShown('codex', 'm1', false);
    expect(p.isShown('codex', 'm1')).toBe(false);
    expect(p.isShown('claude', 'm1')).toBe(true);
    expect([...p.hidden('claude')]).toEqual([]);
  });

  it('store only what is hidden, and read it back in the next page', () => {
    const st = memory();
    const p = new HireModelPrefs(st);
    p.setShown('codex', 'm1', false);
    p.setShown('claude', 'c1', false);
    expect(JSON.parse(st.m.get(KEY)!)).toEqual({ codex: ['m1'], claude: ['c1'] });
    const again = new HireModelPrefs(st);
    expect(again.isShown('codex', 'm1')).toBe(false);
    expect(again.isShown('claude', 'c1')).toBe(false);
  });

  it('restore one model, and remove the key once nothing is hidden', () => {
    const st = memory();
    const p = new HireModelPrefs(st);
    p.setShown('codex', 'm1', false);
    p.setShown('codex', 'm2', false);
    p.setShown('codex', 'm1', true);
    expect(p.isShown('codex', 'm1')).toBe(true);
    expect(p.isShown('codex', 'm2')).toBe(false);
    p.setShown('codex', 'm2', true);
    expect(st.m.size).toBe(0);
  });

  it('show all of one harness, stale slugs included, and leave the other harness alone', () => {
    const st = memory();
    const p = new HireModelPrefs(st);
    p.setShown('codex', 'm1', false);
    p.setShown('codex', 'gone', false);
    p.setShown('claude', 'c1', false);
    p.showAll('codex');
    expect(p.hidden('codex').size).toBe(0);
    expect(p.isShown('claude', 'c1')).toBe(false);
    p.showAll('codex'); // nothing hidden: a no-op
    expect(JSON.parse(st.m.get(KEY)!)).toEqual({ claude: ['c1'] });
  });

  it('tell the listeners only on a real change, and stop after the unsubscribe', () => {
    const p = new HireModelPrefs(memory());
    let calls = 0;
    const off = p.onChange(() => calls++);
    p.setShown('codex', 'm1', true); // already shown
    p.showAll('codex'); // nothing hidden
    expect(calls).toBe(0);
    p.setShown('codex', 'm1', false);
    expect(calls).toBe(1);
    p.setShown('codex', 'm1', false);
    expect(calls).toBe(1);
    off();
    p.setShown('codex', 'm1', true);
    expect(calls).toBe(1);
  });

  it('bump the version on each change, so a view can tell its list is stale', () => {
    const p = new HireModelPrefs(memory());
    const v0 = p.version;
    p.setShown('codex', 'm1', false);
    expect(p.version).toBeGreaterThan(v0);
  });

  it('work when storage throws on every access: a change holds for the page', () => {
    const p = new HireModelPrefs(broken());
    expect(p.hidden('codex').size).toBe(0);
    let calls = 0;
    p.onChange(() => calls++);
    expect(() => p.setShown('codex', 'm1', false)).not.toThrow();
    expect(p.isShown('codex', 'm1')).toBe(false);
    expect(() => p.showAll('codex')).not.toThrow();
    expect(calls).toBe(2);
  });
});
