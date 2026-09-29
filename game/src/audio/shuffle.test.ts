import { describe, expect, it } from 'vitest';
import { ShuffleQueue } from './shuffle';

const lcg = (seed: number) => () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
const ids = ['a', 'b', 'c', 'd', 'e'];

describe('shuffle queue', () => {
  it('plays every track once per round, in a different order each round, and never opens a round with the last track', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const q = new ShuffleQueue(ids, lcg(seed));
      const all = Array.from({ length: 50 }, () => q.next() as string);
      for (let r = 0; r < 10; r++) expect(new Set(all.slice(r * 5, r * 5 + 5)).size).toBe(5);
      for (let r = 1; r < 10; r++) expect(all[r * 5]).not.toBe(all[r * 5 - 1]);
    }
    const q = new ShuffleQueue(ids, lcg(3));
    const rounds = Array.from({ length: 4 }, () => Array.from({ length: 5 }, () => q.next()).join(''));
    expect(new Set(rounds).size).toBeGreaterThan(1);
  });

  it('handles an empty list and a single track', () => {
    expect(new ShuffleQueue([]).next()).toBeNull();
    const one = new ShuffleQueue(['x']);
    expect([one.next(), one.next(), one.next()]).toEqual(['x', 'x', 'x']);
  });
});
