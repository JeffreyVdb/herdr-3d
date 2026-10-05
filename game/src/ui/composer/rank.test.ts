import { describe, expect, it } from 'vitest';
import { rankByName } from './rank';

const names = (items: readonly string[], q: string) => rankByName(items, q, (s) => s).map((r) => r.item);
const hits = (items: readonly string[], q: string) => rankByName(items, q, (s) => s).map((r) => [r.item, r.hits]);

describe('rankByName', () => {
  it('an empty query keeps every item, in order, with nothing highlighted', () => {
    expect(hits(['b', 'a', 'c'], '')).toEqual([
      ['b', []],
      ['a', []],
      ['c', []],
    ]);
  });

  it('prefix matches first, then word starts (after `:`, `-`, `_`), then substrings; no match is left out', () => {
    const items = ['recap', 'caveman:caveman-commit', 'compact', 'code_review', 'clear', 'release:notes', 'deploy'];
    expect(names(items, 'c')).toEqual(['caveman:caveman-commit', 'compact', 'code_review', 'clear', 'recap']);
    expect(names(items, 're')).toEqual(['recap', 'release:notes', 'code_review']);
    expect(names(items, 'ea')).toEqual(['clear', 'release:notes']);
    expect(names(items, 'com')).toEqual(['compact', 'caveman:caveman-commit']);
    expect(names(items, 'zz')).toEqual([]);
  });

  it('is stable within a tier: the source order decides', () => {
    expect(names(['init', 'image', 'imagegen'], 'i')).toEqual(['init', 'image', 'imagegen']);
    expect(names(['a-x', 'b_x', 'c:x', 'dx'], 'x')).toEqual(['a-x', 'b_x', 'c:x', 'dx']);
  });

  it('ignores case', () => {
    expect(names(['Review', 'preview'], 'REV')).toEqual(['Review', 'preview']);
  });

  it('returns the matched characters: the prefix, the first word start, else the first occurrence', () => {
    expect(hits(['compact'], 'com')).toEqual([['compact', [0, 1, 2]]]);
    expect(hits(['caveman:caveman-commit'], 'comm')).toEqual([['caveman:caveman-commit', [16, 17, 18, 19]]]);
    expect(hits(['release:notes'], 'no')).toEqual([['release:notes', [8, 9]]]);
    expect(hits(['preview'], 'vie')).toEqual([['preview', [3, 4, 5]]]);
  });

  it('a word start wins over an earlier substring of the same name', () => {
    // `ab` is in `xab` (at 1), but the word start after `-` (at 4) is the one shown.
    expect(hits(['xab-ab'], 'ab')).toEqual([['xab-ab', [4, 5]]]);
  });

  it('a query with a separator in it matches across it', () => {
    expect(names(['caveman:caveman-commit', 'release:notes'], 'caveman:c')).toEqual(['caveman:caveman-commit']);
    expect(hits(['caveman:caveman-commit'], 'man-co')).toEqual([['caveman:caveman-commit', [12, 13, 14, 15, 16, 17]]]);
  });

  it('a few hundred items rank well inside a frame', () => {
    const many = Array.from({ length: 600 }, (_, i) => `plugin-${i % 17}:skill-${i}-name`);
    const t = performance.now();
    for (let k = 0; k < 10; k++) rankByName(many, 'sk', (s) => s);
    expect((performance.now() - t) / 10).toBeLessThan(16);
  });
});
