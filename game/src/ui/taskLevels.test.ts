import { describe, expect, it, vi } from 'vitest';
import { parseTaskLevels, TaskLevels } from './taskLevels';

const KEY = 'h3d.hire.taskLevels';

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

const TRIVIAL = { harness: 'claude', model: 'y-1', effort: 'medium' };

describe('task levels storage (#248)', () => {
  it('has every level unset with no storage, empty storage, or a value that is not an object of levels', () => {
    expect(new TaskLevels(null).get('trivial')).toBeNull();
    expect(new TaskLevels(memory()).any).toBe(false);
    for (const raw of ['', 'nope', '[]', '"x"', 'null', '42', '{"trivial":"a"}', '{"trivial":[1]}', '{"trivial":{"harness":"claude","model":"y-1"}}', '{"trivial":{"harness":"","model":"y-1","effort":"low"}}', '{"trivial":{"harness":1,"model":"y-1","effort":"low"}}']) {
      const st = memory();
      st.m.set(KEY, raw);
      const t = new TaskLevels(st);
      expect(t.get('trivial'), raw).toBeNull();
      expect(t.any, raw).toBe(false);
    }
  });

  it('keeps the good levels of a partly malformed value, drops unknown keys and extra fields', () => {
    expect(parseTaskLevels(JSON.stringify({ trivial: { ...TRIVIAL, extra: 1 }, very_trivial: { harness: 'codex' }, huge: TRIVIAL }))).toEqual({ trivial: TRIVIAL });
  });

  it('never crashes on storage that throws, and still works for this page', () => {
    const t = new TaskLevels(broken());
    expect(t.get('trivial')).toBeNull();
    t.set('trivial', TRIVIAL);
    expect(t.get('trivial')).toEqual(TRIVIAL);
    t.clear('trivial');
    expect(t.get('trivial')).toBeNull();
  });

  it('stores only the set levels, reads them back in the next page, and leaves no key once all are cleared', () => {
    const st = memory();
    const t = new TaskLevels(st);
    t.set('trivial', TRIVIAL);
    t.set('very_trivial', { harness: 'codex', model: 'x-1', effort: 'low' });
    expect(JSON.parse(st.m.get(KEY) ?? '{}')).toEqual({ trivial: TRIVIAL, very_trivial: { harness: 'codex', model: 'x-1', effort: 'low' } });
    const next = new TaskLevels(st);
    expect(next.get('trivial')).toEqual(TRIVIAL);
    expect(next.get('slightly_complex')).toBeNull();
    next.clear('trivial');
    next.clear('very_trivial');
    expect(st.m.has(KEY)).toBe(false);
  });

  it('keeps a model the bridge does not list (it is not checked here)', () => {
    const st = memory();
    st.m.set(KEY, JSON.stringify({ slightly_complex: { harness: 'claude', model: 'gone-1', effort: 'high' } }));
    expect(new TaskLevels(st).get('slightly_complex')).toEqual({ harness: 'claude', model: 'gone-1', effort: 'high' });
  });

  it('bumps the version and tells listeners on a change, and only then', () => {
    const t = new TaskLevels(memory());
    const fn = vi.fn();
    const off = t.onChange(fn);
    t.set('trivial', TRIVIAL);
    expect(t.version).toBe(1);
    t.set('trivial', { ...TRIVIAL });
    t.clear('slightly_complex');
    expect(t.version).toBe(1);
    expect(fn).toHaveBeenCalledTimes(1);
    t.set('trivial', { ...TRIVIAL, effort: 'high' });
    expect(fn).toHaveBeenCalledTimes(2);
    off();
    t.clear('trivial');
    expect(fn).toHaveBeenCalledTimes(2);
    expect(t.version).toBe(3);
  });

  it('hands out copies: changing one does not change the stored level', () => {
    const t = new TaskLevels(memory());
    t.set('trivial', TRIVIAL);
    const l = t.get('trivial')!;
    l.model = 'other';
    expect(t.get('trivial')).toEqual(TRIVIAL);
  });
});
