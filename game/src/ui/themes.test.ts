import { describe, expect, it } from 'vitest';
import { canvasFaces, clampZoom, DEFAULT_THEME, isThemeId, monoPx, prosePx, stepZoom, themeById, THEMES, themeVars, ZOOM } from './themes';

describe('the three presets (#59)', () => {
  it('are exactly three, Quiet the default, each with its own mono font, prose font and colours', () => {
    expect(THEMES.map((t) => t.id)).toEqual(['terminal', 'quiet', 'paper']);
    expect(DEFAULT_THEME).toBe('quiet');
    for (const key of ['mono', 'prose'] as const) expect(new Set(THEMES.map((t) => t[key].family)).size).toBe(3);
    expect(new Set(THEMES.map((t) => t.palette.bg)).size).toBe(3);
    expect(new Set(THEMES.map((t) => t.screen.bg)).size).toBe(3);
    // Every preset sets every colour, and every mono stack ends in the system's box-drawing monospace faces.
    const keys = Object.keys(themeById('quiet').palette).sort();
    for (const t of THEMES) {
      expect(Object.keys(t.palette).sort()).toEqual(keys);
      expect(t.mono.stack.startsWith(`"${t.mono.family}"`)).toBe(true);
      expect(t.mono.stack).toMatch(/Menlo, "DejaVu Sans Mono".*monospace$/);
    }
    expect(themeById('paper').prose.size).toBeGreaterThan(themeById('quiet').prose.size);
  });

  it('knows no fourth: a stored id that is not one of them is not a theme', () => {
    expect(['terminal', 'quiet', 'paper'].every(isThemeId)).toBe(true);
    for (const v of ['', 'dark', 'Quiet', null, 3, 'terminal ']) expect(isThemeId(v)).toBe(false);
  });

  it('puts its fonts, sizes and colours on the page as custom properties', () => {
    const v = themeVars(themeById('paper'), 100);
    expect(v['--font-mono']).toBe(themeById('paper').mono.stack);
    expect(v['--tx-prose']).toContain('Newsreader Variable');
    expect(v['--tx-bg']).toBe('#f2ead8');
    expect(v['--tx-fs']).toBe('15px');
    expect(v['--tx-mono-fs']).toBe('12px');
    expect(Number(v['--tx-k'])).toBeCloseTo(15 / 13.5, 3);
    expect(themeVars(themeById('quiet'), 200)['--tx-fs']).toBe('27px');
    expect(canvasFaces(themeById('terminal'))).toEqual(['400 16px "Departure Mono"']);
    expect(canvasFaces(themeById('quiet'))).toHaveLength(4);
  });
});

describe('zoom (#59)', () => {
  it('clamps to 70–200 on steps of 10; junk is 100', () => {
    expect([69, 70, 74, 76, 100, 199, 200, 250, -5].map(clampZoom)).toEqual([70, 70, 70, 80, 100, 200, 200, 200, 70]);
    expect(['130', ' 90 ', '', 'big', null, undefined, NaN, Infinity, {}].map(clampZoom)).toEqual([130, 90, 100, 100, 100, 100, 100, 100, 100]);
  });

  it('steps by 10 and stops at the ends; reset is 100', () => {
    expect(stepZoom(100, 1)).toBe(110);
    expect(stepZoom(100, -1)).toBe(90);
    expect(stepZoom(200, 1)).toBe(200);
    expect(stepZoom(70, -1)).toBe(70);
    expect(stepZoom(133, 1)).toBe(140);
    let z = 100;
    for (let i = 0; i < 20; i++) z = stepZoom(z, -1);
    expect(z).toBe(ZOOM.min);
    expect(ZOOM.reset).toBe(100);
  });

  it('100% is the preset’s own size, and switching preset at a zoom keeps the zoom', () => {
    for (const t of THEMES) expect(prosePx(t, 100)).toBe(t.prose.size);
    expect(prosePx(themeById('paper'), 150)).toBe(22.5);
    expect(prosePx(themeById('quiet'), 150)).toBe(20.25);
  });

  it('never gives Departure Mono a size off its 11px grid, at any step', () => {
    const terminal = themeById('terminal');
    const sizes = new Set<number>();
    for (let z = ZOOM.min; z <= ZOOM.max; z += ZOOM.step) {
      const px = monoPx(terminal, z);
      expect(px % 11, `${z}%`).toBe(0);
      expect(px).toBeGreaterThanOrEqual(11);
      sizes.add(px);
    }
    expect([...sizes].sort((a, b) => a - b)).toEqual([11, 22]);
    // It still grows with the zoom, never shrinks as the zoom grows.
    for (let z = ZOOM.min; z < ZOOM.max; z += ZOOM.step) expect(monoPx(terminal, z + ZOOM.step)).toBeGreaterThanOrEqual(monoPx(terminal, z));
    // The others follow the zoom on half pixels.
    expect(monoPx(themeById('quiet'), 100)).toBe(11.5);
    expect(monoPx(themeById('quiet'), 200)).toBe(23);
    expect(monoPx(themeById('quiet'), 70)).toBe(8);
  });
});
