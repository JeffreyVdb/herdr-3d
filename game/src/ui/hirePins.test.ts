import { describe, expect, it, vi } from 'vitest';
import type { HireOptions, HirePreset } from '../net/protocol';
import { HirePresetBook } from '../world/hirePresets';
import { deskPins, HirePins, parsePins, pinnedOn } from './hirePins';

const KEY = 'h3d.hire.pinnedPresets';

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

describe('hire preset pins', () => {
  it('pin nothing with no storage, empty storage, or a value that is not a list of ids', () => {
    expect(new HirePins(null).ids).toEqual([]);
    for (const raw of ['', 'nope', '{}', '"x"', 'null', '42', '[1,null,{}]', '[""]']) {
      const st = memory();
      st.m.set(KEY, raw);
      expect(new HirePins(st).ids, raw).toEqual([]);
    }
  });

  it('keep the good ids of a partly malformed value, once each, in order', () => {
    expect(parsePins('["b",1,"a","b",""]')).toEqual(['b', 'a']);
  });

  it('pin at the end, once, and read the order back in the next page', () => {
    const st = memory();
    const p = new HirePins(st);
    p.pin('a');
    p.pin('b');
    p.pin('a');
    expect(p.ids).toEqual(['a', 'b']);
    expect(p.has('b')).toBe(true);
    expect(new HirePins(st).ids).toEqual(['a', 'b']);
  });

  it('unpin one, and remove the key once nothing is pinned', () => {
    const st = memory();
    const p = new HirePins(st);
    p.pin('a');
    p.pin('b');
    p.unpin('a');
    expect(p.ids).toEqual(['b']);
    p.unpin('b');
    expect(st.m.size).toBe(0);
  });

  it('bump the version and tell listeners on a change only', () => {
    const p = new HirePins(memory());
    const fn = vi.fn();
    p.onChange(fn);
    p.pin('a');
    p.pin('a');
    p.unpin('zz');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(p.version).toBe(1);
  });

  it('keep working in memory when storage throws', () => {
    const p = new HirePins(broken());
    p.pin('a');
    expect(p.ids).toEqual(['a']);
  });

  it('move a pin to a place among the ones shown, leaving the hidden ones (another floor’s, deleted) where they were', () => {
    const p = new HirePins(memory());
    for (const id of ['a', 'x', 'b', 'y', 'c']) p.pin(id);
    const shown = ['a', 'b', 'c'];
    p.move('c', 1, shown);
    expect(p.ids).toEqual(['a', 'x', 'c', 'y', 'b']);
    p.move('a', 1, ['a', 'c', 'b']);
    expect(p.ids).toEqual(['c', 'x', 'a', 'y', 'b']);
    p.move('b', 0, ['c', 'a', 'b']);
    expect(p.ids).toEqual(['b', 'x', 'c', 'y', 'a']);
  });

  it('move nothing past either end, nor a pin that is not shown', () => {
    const p = new HirePins(memory());
    for (const id of ['a', 'b']) p.pin(id);
    const fn = vi.fn();
    p.onChange(fn);
    p.move('a', -1, ['a', 'b']);
    p.move('b', 2, ['a', 'b']);
    p.move('a', 0, ['a', 'b']);
    p.move('zz', 1, ['a', 'b']);
    p.move('a', 1, ['b']);
    p.move('a', 1, ['a', 'gone']);
    expect(p.ids).toEqual(['a', 'b']);
    expect(fn).not.toHaveBeenCalled();
  });

  it('show on a floor only the pins it offers, in pin order', () => {
    const offered = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    expect(pinnedOn(['c', 'gone', 'a'], offered).map((p) => p.id)).toEqual(['c', 'a']);
    expect(pinnedOn([], offered)).toEqual([]);
  });

  it('give a floor’s tab bar its pins: its own and the global ones, named, moved among themselves', () => {
    const cat: HireOptions = { codex: { models: ['x-1'], efforts: ['low'] } };
    const p = (id: string, name: string, floor?: string): HirePreset => ({ id, name, prompt: 'p', harness: 'codex', model: 'x-1', effort: 'low', created_at: 1, updated_at: 1, ...(floor ? { floor } : {}) });
    const book = new HirePresetBook();
    const pins = new HirePins(memory());
    expect(deskPins(pins, book, cat, 'web')).toBeUndefined();
    book.reset([p('g', 'Global one'), p('w', 'Web one', 'web'), p('o', 'Other floor', 'api')]);
    for (const id of ['o', 'g', 'gone', 'w']) pins.pin(id);
    const d = deskPins(pins, book, cat, 'web')!;
    expect(d.list.map((x) => [x.id, x.name])).toEqual([
      ['g', 'Global one'],
      ['w', 'Web one'],
    ]);
    expect(d.list[1]!.title).toContain('Codex · x-1 · low (this floor)');
    d.move!('w', 0);
    expect(pins.ids).toEqual(['o', 'w', 'gone', 'g']);
    expect(deskPins(undefined, book, cat, 'web')).toBeUndefined();
  });
});
