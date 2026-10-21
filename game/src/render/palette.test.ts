import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { OFFICE, OFFICE_UBUNTU, STATUS_CHIP_CSS, STATUS_CSS, WALL, WALL_UBUNTU } from './palette';

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

describe('the office in Ubuntu', () => {
  const ubuntu = css.slice(css.indexOf(":root[data-ui-theme='ubuntu'] {"));
  const tok = (name: string) => ubuntu.match(new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, 'i'))?.[1]?.toLowerCase();
  const hex = (n: number) => `#${n.toString(16).padStart(6, '0')}`;

  it('its screens are the page’s Ubuntu tokens (the glass the darkest aubergine)', () => {
    expect(WALL_UBUNTU.ink).toBe(tok('chrome'));
    expect(WALL_UBUNTU.flap).toBe(tok('raised'));
    expect(WALL_UBUNTU.ink3).toBe(tok('hover'));
    expect(WALL_UBUNTU.text).toBe(tok('text'));
    expect(WALL_UBUNTU.text2).toBe(tok('text-2'));
    expect(WALL_UBUNTU.text3).toBe(tok('text-3'));
    expect(WALL_UBUNTU.accent).toBe(tok('accent-text'));
    expect(WALL_UBUNTU.font.startsWith('"Ubuntu"')).toBe(true);
    // Every status light reads on its glass (>= 3:1), as on Quiet's.
    for (const [d, c] of Object.entries(STATUS_CSS)) expect(contrast(c, WALL_UBUNTU.ink), d).toBeGreaterThanOrEqual(3);
  });

  it('its room: the theme’s aubergines and orange where Quiet has navy and yellow', () => {
    expect(hex(OFFICE_UBUNTU.boardWall)).toBe(tok('hover'));
    expect(hex(OFFICE_UBUNTU.chairBase)).toBe(tok('chrome'));
    expect(hex(OFFICE_UBUNTU.frame)).toBe(tok('chrome'));
    expect(hex(OFFICE_UBUNTU.accent)).toBe(tok('action'));
    expect(hex(OFFICE_UBUNTU.rug)).toBe(tok('action'));
    expect(OFFICE_UBUNTU.sign).toEqual({ ground: tok('chrome'), text: tok('accent-text') });
    expect(contrast(OFFICE_UBUNTU.sign.text, OFFICE_UBUNTU.sign.ground)).toBeGreaterThanOrEqual(4.5);
    expect(OFFICE_UBUNTU.screens).toBe(WALL_UBUNTU);
    expect(OFFICE.screens).toBe(WALL);
  });
});
