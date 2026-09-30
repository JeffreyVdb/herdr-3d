import { describe, expect, it } from 'vitest';
import { letterbox } from './logoFit';

const close = (a: number, b: number) => expect(a).toBeCloseTo(b, 9);

describe('letterbox', () => {
  it('fits a wide image to the width and centres it vertically', () => {
    const f = letterbox(400, 100, 300, 100);
    close(f.w, 300);
    close(f.h, 75);
    close(f.x, 0);
    close(f.y, 12.5);
  });

  it('fits a tall image to the height and centres it horizontally', () => {
    const f = letterbox(100, 400, 300, 100);
    close(f.h, 100);
    close(f.w, 25);
    close(f.x, 137.5);
    close(f.y, 0);
  });

  it('fits a square image to the short side', () => {
    const f = letterbox(50, 50, 300, 100);
    close(f.w, 100);
    close(f.h, 100);
    close(f.x, 100);
    close(f.y, 0);
  });

  it('keeps the aspect exactly, whatever the box', () => {
    for (const [iw, ih] of [[1024, 256], [37, 911], [640, 480], [1, 1]] as const) {
      const f = letterbox(iw, ih, 3.6, 0.9, 0.08);
      expect(f.w / f.h).toBeCloseTo(iw / ih, 9);
      expect(f.w).toBeLessThanOrEqual(3.6 + 1e-9);
      expect(f.h).toBeLessThanOrEqual(0.9 + 1e-9);
    }
  });

  it('enlarges a small image to the box: it is a texture, not pixels', () => {
    const f = letterbox(10, 5, 300, 100);
    close(f.w, 200);
    close(f.h, 100);
  });

  it('keeps the padding free on every side', () => {
    const f = letterbox(100, 100, 100, 100, 0.1);
    close(f.w, 80);
    close(f.x, 10);
    close(f.y, 10);
  });

  it('clamps silly padding', () => {
    expect(letterbox(10, 10, 100, 100, 0.9).w).toBeGreaterThan(0);
    expect(letterbox(10, 10, 100, 100, -1).w).toBeCloseTo(100, 9);
    expect(letterbox(10, 10, 100, 100, Number.NaN).w).toBeCloseTo(100, 9);
  });

  it('draws nothing for degenerate sizes', () => {
    const none = { w: 0, h: 0, x: 0, y: 0 };
    for (const a of [[0, 10, 100, 100], [10, 0, 100, 100], [10, 10, 0, 100], [10, 10, 100, 0], [-1, 10, 100, 100], [Number.NaN, 10, 1, 1], [10, 10, Infinity, 1], [10, Infinity, 1, 1]] as Array<[number, number, number, number]>) {
      expect(letterbox(a[0], a[1], a[2], a[3])).toEqual(none);
    }
  });
});
