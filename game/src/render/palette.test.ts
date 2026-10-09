import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { STATUS_CHIP_CSS, STATUS_CSS } from './palette';

/** WCAG 2 contrast ratio of two #rrggbb colours. */
function contrast(a: string, b: string): number {
  const lum = (h: string) => {
    const [r, g, bl] = [1, 3, 5].map((i) => {
      const c = parseInt(h.slice(i, i + 2), 16) / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    }) as [number, number, number];
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const css = readFileSync(resolve(import.meta.dirname, '../ui/uiTheme.css'), 'utf8');
const token = (name: string) => css.match(new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, 'i'))?.[1]?.toLowerCase();

describe('status colours', () => {
  it('white chip text reads at >= 4.5:1 on every status chip', () => {
    for (const [d, c] of Object.entries(STATUS_CHIP_CSS)) expect(contrast(c, '#ffffff'), d).toBeGreaterThanOrEqual(4.5);
  });

  it('uiTheme.css (Quiet) and palette.ts agree', () => {
    for (const [d, c] of Object.entries(STATUS_CSS)) expect(token(d), d).toBe(c);
    for (const [d, c] of Object.entries(STATUS_CHIP_CSS)) expect(token(`${d}-chip`) ?? token(d), `${d}-chip`).toBe(c);
  });
});
