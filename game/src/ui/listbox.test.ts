import { describe, expect, it } from 'vitest';
import { listKey, wrapIndex } from './listbox';

const key = (k: string, mods: Partial<Record<'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey', boolean>> = {}) => ({ key: k, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...mods });

describe('listKey', () => {
  const open = { rows: true, can: true, tab: true };

  it('arrows move, Enter and Tab pick, Esc closes', () => {
    expect(listKey(key('ArrowDown'), open)).toBe('next');
    expect(listKey(key('ArrowUp'), open)).toBe('prev');
    expect(listKey(key('Enter'), open)).toBe('pick');
    expect(listKey(key('Tab'), open)).toBe('pick');
    expect(listKey(key('Escape'), open)).toBe('close');
    expect(listKey(key('a'), open)).toBeNull();
  });

  it('a modified key is the field’s', () => {
    for (const m of ['altKey', 'ctrlKey', 'metaKey', 'shiftKey'] as const) {
      for (const k of ['ArrowDown', 'Enter', 'Tab', 'Escape']) expect(listKey(key(k, { [m]: true }), open)).toBeNull();
    }
  });

  it('with no rows the arrows and Tab are the field’s; Enter says it has nothing to pick', () => {
    const none = { rows: false, can: false, tab: true };
    expect(listKey(key('ArrowDown'), none)).toBeNull();
    expect(listKey(key('ArrowUp'), none)).toBeNull();
    expect(listKey(key('Tab'), none)).toBeNull();
    expect(listKey(key('Enter'), none)).toBe('enter-empty');
    expect(listKey(key('Escape'), none)).toBe('close');
  });

  it('Tab picks only where the list says so', () => {
    expect(listKey(key('Tab'), { rows: true, can: true })).toBeNull();
  });
});

describe('wrapIndex', () => {
  it('wraps both ways and starts from the ends when nothing is active', () => {
    expect(wrapIndex(0, 3, -1)).toBe(2);
    expect(wrapIndex(2, 3, 1)).toBe(0);
    expect(wrapIndex(1, 3, 1)).toBe(2);
    expect(wrapIndex(-1, 3, 1)).toBe(0);
    expect(wrapIndex(-1, 3, -1)).toBe(2);
    expect(wrapIndex(0, 0, 1)).toBe(-1);
  });
});
