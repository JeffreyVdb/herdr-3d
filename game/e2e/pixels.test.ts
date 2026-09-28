import { describe, expect, it } from 'vitest';
import { pixelStats } from './pixels';

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
