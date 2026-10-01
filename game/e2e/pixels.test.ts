import { describe, expect, it } from 'vitest';
import { pixelStats, stripeScore } from './pixels';

const solid = (px: number, [r, g, b]: [number, number, number]) =>
  Uint8Array.from({ length: px * 4 }, (_, i) => [r, g, b, 255][i % 4] ?? 0);

describe('pixelStats', () => {
  it('reports zero variance for a solid image', () => {
    const s = pixelStats(solid(100, [159, 214, 255]));
    expect(s.variance).toBeCloseTo(0, 6);
    expect(s.distinctColors).toBe(1);
  });

  it('reports variance for a two-colour image', () => {
    const img = new Uint8Array([...solid(50, [0, 0, 0]), ...solid(50, [255, 255, 255])]);
    const s = pixelStats(img);
    expect(s.mean).toBeCloseTo(127.5, 1);
    expect(s.variance).toBeCloseTo(127.5 * 127.5, 0);
    expect(s.distinctColors).toBe(2);
  });

  it('handles an empty buffer', () => {
    expect(pixelStats(new Uint8Array())).toEqual({ mean: 0, variance: 0, distinctColors: 0 });
  });
});

describe('stripeScore', () => {
  const W = 40;
  const rows = (f: (x: number, y: number) => number) =>
    Uint8Array.from({ length: W * 10 * 4 }, (_, i) => {
      const px = Math.floor(i / 4);
      return i % 4 === 3 ? 255 : f(px % W, Math.floor(px / W));
    });

  it('is 0 for a flat surface, a smooth ramp and a single edge', () => {
    expect(stripeScore(rows(() => 90), W, [0, 0, W, 10])).toBe(0);
    expect(stripeScore(rows((x) => 100 + x), W, [0, 0, W, 10])).toBe(0);
    expect(stripeScore(rows((x) => (x < 20 ? 200 : 120)), W, [0, 0, W, 10])).toBe(0);
  });

  it('counts the bands of a striped surface', () => {
    // 4 px bands, 8 levels apart: 9 steps along a 40 px row, 8 of them turn back.
    expect(stripeScore(rows((x) => (Math.floor(x / 4) % 2 ? 120 : 128)), W, [0, 0, W, 10])).toBe(8);
  });

  it('ignores steps below the amplitude and stays in the rectangle', () => {
    expect(stripeScore(rows((x) => (x % 2 ? 100 : 100.5)), W, [0, 0, W, 10], 2)).toBe(0);
    expect(stripeScore(rows((x) => (x >= 30 && x % 2 ? 50 : 100)), W, [0, 0, 30, 10])).toBe(0);
  });
});
