import { describe, expect, it } from 'vitest';
import { selectCards } from './select';

const cam = { x: 0, y: 1.5, z: 0 };
const north = { x: 0, y: 0, z: -1 };
const at = (z: number, x = 0) => ({ x, y: 1.6, z });

describe('selectCards', () => {
  it('keeps cards in front, nearest first, fading with distance', () => {
    const got = selectCards(cam, north, [at(-3), at(-10), at(3), null, at(-20)], { near: 5, far: 15, cap: 10 });
    expect(got.map((c) => c.index)).toEqual([0, 1]);
    expect(got[0]?.alpha).toBe(1);
    expect(got[1]?.alpha).toBeCloseTo(0.5, 1);
  });
  it('caps the number of cards', () => {
    const anchors = Array.from({ length: 60 }, (_, i) => at(-1 - i * 0.2, (i % 5) * 0.1));
    const got = selectCards(cam, north, anchors, { near: 5, far: 30, cap: 24 });
    expect(got).toHaveLength(24);
    expect(got.map((c) => c.index)).toEqual([...Array(24).keys()]);
  });
  it('pulls weighted cards forward and drops occluded ones', () => {
    const got = selectCards(cam, north, [at(-4), at(-6), at(-5)], { near: 5, far: 15, cap: 2 }, (i) => (i === 1 ? 0.5 : 1), (i) => i === 0);
    expect(got.map((c) => c.index)).toEqual([1, 2]);
  });
  it('ignores cards outside the view cone', () => {
    expect(selectCards(cam, north, [at(-1, 5)], { near: 5, far: 15, cap: 5 })).toEqual([]);
  });
});
