import { describe, expect, it, vi } from 'vitest';
import { newLevelId, parseTaskLevels, TaskLevels } from './taskLevels';

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
/** Ids in order: id-1, id-2, … (the real ones are random and opaque). */
const ids = () => {
  let n = 0;
  return () => `id-${++n}`;
};
const stored = (st: ReturnType<typeof memory>) => JSON.parse(st.m.get(KEY) ?? 'null') as unknown;

const COMBO = { harness: 'claude', model: 'y-1', effort: 'medium' };
const NONE = { harness: '', model: '', effort: '' };

describe('task levels storage (#248, #40)', () => {
  it('starts with no levels in a fresh browser, with no storage, or with a value it cannot read', () => {
    expect(new TaskLevels(null).list()).toEqual([]);
    const fresh = memory();
    const t = new TaskLevels(fresh);
    expect(t.list()).toEqual([]);
    expect(t.any).toBe(false);
    expect(t.defaultId).toBeNull();
    // Nothing is written for a fresh browser: the examples are never created.
    expect(fresh.m.has(KEY)).toBe(false);
    for (const raw of ['', 'nope', '[]', '"x"', 'null', '42', '{"v":2}', '{"v":2,"levels":{}}', '{"v":3,"levels":[]}', '{"v":"2","levels":[]}']) {
      const st = memory();
      st.m.set(KEY, raw);
      expect(new TaskLevels(st).list(), raw).toEqual([]);
    }
  });

  it('reads levels back in their order, with their names, combinations and the default', () => {
    const st = memory();
    const v = { v: 2, levels: [{ id: 'b', name: 'Docs', ...COMBO }, { id: 'a', name: 'Quick fix', ...NONE }], default: 'a' };
    st.m.set(KEY, JSON.stringify(v));
    const t = new TaskLevels(st);
    expect(t.list()).toEqual([
      { id: 'b', name: 'Docs', ...COMBO },
      { id: 'a', name: 'Quick fix', ...NONE },
    ]);
    expect(t.defaultMark).toBe('a');
    expect(t.defaultId).toBe('a');
    // Only a set level counts.
    expect(t.any).toBe(true);
  });

  it('drops a malformed level and keeps the good ones', () => {
    const levels = [
      { id: 'a', name: 'Good', ...COMBO, extra: 1 },
      'x',
      null,
      { name: 'No id', ...COMBO },
      { id: '', name: 'Empty id', ...COMBO },
      { id: 'b', name: '', ...COMBO },
      { id: 'c', name: 'x'.repeat(41), ...COMBO },
      { id: 'd', name: 'good', ...COMBO },
      { id: 'a', name: 'Same id', ...COMBO },
      { id: 'e', name: 'Typed', harness: 1, model: 'y-1', effort: 'low' },
      // A combination half set: kept as a level that is not set yet.
      { id: 'f', name: 'Half', harness: 'claude', model: '', effort: 'low' },
      { id: 'g', name: 'Bare' },
    ];
    expect(parseTaskLevels(JSON.stringify({ v: 2, levels, default: 'gone' }), ids())).toEqual({
      levels: [
        { id: 'a', name: 'Good', ...COMBO },
        { id: 'f', name: 'Half', ...NONE },
        { id: 'g', name: 'Bare', ...NONE },
      ],
      default: null,
      migrated: false,
    });
  });

  it('keeps at most 20 levels', () => {
    const levels = Array.from({ length: 25 }, (_, i) => ({ id: `l${i}`, name: `L${i}`, ...COMBO }));
    expect(parseTaskLevels(JSON.stringify({ v: 2, levels }), ids()).levels).toHaveLength(20);
  });

  it('migrates the old three slots: each set one becomes a named level in order, Trivial the default; and stores the new shape', () => {
    const st = memory();
    st.m.set(KEY, JSON.stringify({ slightly_complex: { harness: 'codex', model: 'x-2', effort: 'ultra' }, trivial: COMBO, very_trivial: { harness: 'codex', model: 'x-1', effort: 'low' }, huge: COMBO }));
    const t = new TaskLevels(st, ids());
    expect(t.list()).toEqual([
      { id: 'id-1', name: 'Very trivial', harness: 'codex', model: 'x-1', effort: 'low' },
      { id: 'id-2', name: 'Trivial', ...COMBO },
      { id: 'id-3', name: 'Slightly complex', harness: 'codex', model: 'x-2', effort: 'ultra' },
    ]);
    expect(t.defaultMark).toBe('id-2');
    expect(stored(st)).toEqual({ v: 2, levels: t.list(), default: 'id-2' });
    // Read again: the same levels, nothing migrated twice.
    expect(new TaskLevels(st, ids()).list()).toEqual(t.list());
  });

  it('migrates only the set slots; no Trivial set leaves no default (the first is then)', () => {
    const st = memory();
    st.m.set(KEY, JSON.stringify({ slightly_complex: COMBO, trivial: { harness: 'claude' } }));
    const t = new TaskLevels(st, ids());
    expect(t.list()).toEqual([{ id: 'id-1', name: 'Slightly complex', ...COMBO }]);
    expect(t.defaultMark).toBeNull();
    expect(t.defaultId).toBe('id-1');
  });

  it('an old value with no set slot migrates to no levels', () => {
    for (const raw of ['{}', '{"trivial":"a"}', '{"trivial":{"harness":"","model":"y-1","effort":"low"}}']) {
      const st = memory();
      st.m.set(KEY, raw);
      expect(new TaskLevels(st).list(), raw).toEqual([]);
    }
  });

  it('never crashes on storage that throws, and still works for this page', () => {
    const t = new TaskLevels(broken(), ids());
    expect(t.list()).toEqual([]);
    const id = t.add('Quick fix');
    t.set(id!, COMBO);
    expect(t.get(id!)).toEqual({ id, name: 'Quick fix', ...COMBO });
    t.remove(id!);
    expect(t.list()).toEqual([]);
  });

  it('adds levels at the end, not set yet, with a valid name only, at most 20', () => {
    const t = new TaskLevels(memory(), ids());
    expect(t.add('  Quick fix ')).toBe('id-1');
    expect(t.add('Docs')).toBe('id-2');
    expect(t.list().map((l) => l.name)).toEqual(['Quick fix', 'Docs']);
    expect(t.get('id-1')).toEqual({ id: 'id-1', name: 'Quick fix', ...NONE });
    expect(t.any).toBe(false);
    expect(t.add('quick FIX')).toBeNull();
    expect(t.add('')).toBeNull();
    for (let i = t.list().length; i < 20; i++) expect(t.add(`L${i}`)).not.toBeNull();
    expect(t.full).toBe(true);
    expect(t.add('One more')).toBeNull();
    expect(t.list()).toHaveLength(20);
  });

  it('suggests a free name for a new level', () => {
    const t = new TaskLevels(memory(), ids());
    expect(t.suggestName()).toBe('Level 1');
    t.add('Level 1');
    t.add('level 2');
    expect(t.suggestName()).toBe('Level 3');
  });

  it('renames a level: trimmed, unique ignoring case (its own name aside), and says why not', () => {
    const t = new TaskLevels(memory(), ids());
    const a = t.add('Quick fix')!;
    t.add('Docs');
    expect(t.rename(a, ' Tiny ')).toBeNull();
    expect(t.get(a)?.name).toBe('Tiny');
    expect(t.rename(a, 'TINY')).toBeNull();
    expect(t.get(a)?.name).toBe('TINY');
    expect(t.rename(a, 'docs')).toMatch(/already/);
    expect(t.rename(a, ' ')).toMatch(/needs a name/);
    expect(t.rename(a, 'x'.repeat(41))).toMatch(/40 characters/);
    expect(t.get(a)?.name).toBe('TINY');
  });

  it('sets and clears a combination; clearing keeps the level and its name', () => {
    const t = new TaskLevels(memory(), ids());
    const a = t.add('Quick fix')!;
    t.set(a, COMBO);
    expect(t.any).toBe(true);
    t.clear(a);
    expect(t.get(a)).toEqual({ id: a, name: 'Quick fix', ...NONE });
    expect(t.any).toBe(false);
  });

  it('moves a level up and down, not past the ends', () => {
    const t = new TaskLevels(memory(), ids());
    for (const n of ['A', 'B', 'C']) t.add(n);
    t.move('id-3', -1);
    expect(t.list().map((l) => l.name)).toEqual(['A', 'C', 'B']);
    t.move('id-1', -1);
    t.move('id-2', 1);
    expect(t.list().map((l) => l.name)).toEqual(['A', 'C', 'B']);
    t.move('id-1', 1);
    expect(t.list().map((l) => l.name)).toEqual(['C', 'A', 'B']);
  });

  it('marks one level the default; without a mark the first is; removing the default unmarks it', () => {
    const t = new TaskLevels(memory(), ids());
    for (const n of ['A', 'B', 'C']) t.add(n);
    expect(t.defaultId).toBe('id-1');
    t.setDefault('id-3');
    expect(t.defaultId).toBe('id-3');
    t.setDefault('id-2');
    expect([t.defaultMark, t.defaultId]).toEqual(['id-2', 'id-2']);
    // Moving the first changes the default only while none is marked.
    t.move('id-1', 1);
    expect(t.defaultId).toBe('id-2');
    t.remove('id-2');
    expect(t.defaultMark).toBeNull();
    // B was first, A second: A is now.
    expect(t.defaultId).toBe('id-1');
    t.setDefault('gone');
    expect(t.defaultMark).toBeNull();
  });

  it('stores the list, its order, the names and the default, reads them back in the next page, and leaves no key once empty', () => {
    const st = memory();
    const t = new TaskLevels(st, ids());
    const a = t.add('Quick fix')!;
    const b = t.add('Docs')!;
    t.set(b, COMBO);
    t.move(b, -1);
    t.setDefault(a);
    expect(stored(st)).toEqual({ v: 2, levels: [{ id: b, name: 'Docs', ...COMBO }, { id: a, name: 'Quick fix', ...NONE }], default: a });
    const next = new TaskLevels(st);
    expect(next.list()).toEqual(t.list());
    expect(next.defaultId).toBe(a);
    next.remove(a);
    next.remove(b);
    expect(st.m.has(KEY)).toBe(false);
  });

  it('keeps a model the bridge does not list (it is not checked here)', () => {
    const st = memory();
    st.m.set(KEY, JSON.stringify({ v: 2, levels: [{ id: 'a', name: 'Old', harness: 'claude', model: 'gone-1', effort: 'high' }] }));
    expect(new TaskLevels(st).get('a')).toEqual({ id: 'a', name: 'Old', harness: 'claude', model: 'gone-1', effort: 'high' });
  });

  it('bumps the version and tells listeners on a change, and only then', () => {
    const t = new TaskLevels(memory(), ids());
    const fn = vi.fn();
    const off = t.onChange(fn);
    const a = t.add('A')!;
    expect(t.version).toBe(1);
    t.set(a, COMBO);
    expect(t.version).toBe(2);
    // No change: no news.
    t.set(a, { ...COMBO });
    t.rename(a, 'A');
    t.move(a, -1);
    t.setDefault('gone');
    t.add('a');
    t.remove('gone');
    expect(t.version).toBe(2);
    expect(fn).toHaveBeenCalledTimes(2);
    off();
    t.clear(a);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(t.version).toBe(3);
  });

  it('hands out copies: changing one does not change the stored level', () => {
    const t = new TaskLevels(memory(), ids());
    const a = t.add('A')!;
    t.set(a, COMBO);
    const l = t.get(a)!;
    l.model = 'other';
    t.list()[0]!.name = 'Z';
    expect(t.get(a)).toEqual({ id: a, name: 'A', ...COMBO });
  });

  it('makes opaque ids that do not repeat', () => {
    const seen = new Set(Array.from({ length: 50 }, () => newLevelId()));
    expect(seen.size).toBe(50);
    for (const id of seen) expect(id).toMatch(/^[\w-]{8,}$/);
  });
});
