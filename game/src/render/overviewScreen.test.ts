import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { scrollAt, WALL_STATUS, wallPlan } from './overviewScreen';
import { STATUS_CHIP_CSS, STATUS_CSS } from './palette';

const lum = (hex: string) => {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * (c[0] ?? 0) + 0.7152 * (c[1] ?? 0) + 0.0722 * (c[2] ?? 0);
};
const contrast = (a: string, b: string) => {
  const [x, y] = [lum(a), lum(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};

describe('the wall screen’s plan (#118)', () => {
  it('two lines a row while they fit, then one line a row, then a scrolling window: never a row cut off', () => {
    expect(wallPlan(5, 600, 80, 45)).toEqual({ compact: false, fit: 7, scroll: false });
    expect(wallPlan(7, 600, 80, 45)).toEqual({ compact: false, fit: 7, scroll: false });
    expect(wallPlan(8, 600, 80, 45)).toEqual({ compact: true, fit: 13, scroll: false });
    expect(wallPlan(40, 600, 80, 45)).toEqual({ compact: true, fit: 13, scroll: true });
  });

  it('the window rests at the top, glides down, rests at the bottom and jumps back; calm: no glide', () => {
    expect(scrollAt(0, 0)).toBe(0);
    expect(scrollAt(99_999, 0)).toBe(0);
    // 6 rows past the window at 0.6 rows/s: a 10 s glide between two 4 s rests (an 18 s cycle).
    expect(scrollAt(2_000, 6)).toBe(0);
    expect(scrollAt(9_000, 6)).toBeCloseTo(0.5, 5);
    expect(scrollAt(15_000, 6)).toBe(1);
    expect(scrollAt(18_000 + 2_000, 6)).toBe(0);
    expect(scrollAt(9_000, 6, false)).toBe(1);
    expect(scrollAt(2_000, 6, false)).toBe(0);
  });
});

describe('the overview’s colours (#118)', () => {
  const css = readFileSync(resolve(import.meta.dirname, '../ui/overview.css'), 'utf8');
  const token = (name: string) => new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`).exec(css)?.[1] as string;

  it('the page and the wall share the ink, and draw the shared status palette (no hues of their own)', () => {
    expect(token('ov-ink')).toBe(WALL_STATUS.ink);
    expect(WALL_STATUS.light).toBe(STATUS_CSS);
    expect(WALL_STATUS.chip).toBe(STATUS_CHIP_CSS);
    // Working stays blue (the top bar's), done green.
    expect(STATUS_CSS.working).toBe('#2f6bf0');
    expect(css).not.toMatch(/--(working|done|needs_you|idle|asleep|waiting):/);
  });

  it('AA: every status light is >= 3:1 on the ink (and the hover row); text >= 4.5:1; white on every chip >= 4.5:1', () => {
    for (const bg of [token('ov-ink'), token('ov-ink-2')]) {
      for (const [k, c] of Object.entries(STATUS_CSS)) expect(contrast(c, bg), `${k} on ${bg}`).toBeGreaterThanOrEqual(3);
      for (const t of ['ov-text', 'ov-text-2', 'ov-text-3']) expect(contrast(token(t), bg), `${t} on ${bg}`).toBeGreaterThanOrEqual(4.5);
    }
    for (const [k, c] of Object.entries(STATUS_CHIP_CSS)) expect(contrast('#ffffff', c), `white on ${k}`).toBeGreaterThanOrEqual(4.5);
  });
});
