import { describe, expect, it } from 'vitest';
import { canvasFaces, clampZoom, DEFAULT_THEME, isThemeId, monoPx, prosePx, stepZoom, SYSTEM_MONO, themeById, THEMES, themeVars, ZOOM } from './themes';

/** WCAG 2.x contrast ratio of two `#rrggbb` colours (an `rgb(r g b / a%)` is laid over `under`). */
function ratio(fg: string, bg: string, under = '#000000'): number {
  const rgb = (c: string, base?: number[]): number[] => {
    const m = /^rgb\((\d+) (\d+) (\d+) \/ (\d+)%\)$/.exec(c);
    if (m && base) return [1, 2, 3].map((i) => Math.round(Number(m[i]) * (Number(m[4]) / 100) + base[i - 1]! * (1 - Number(m[4]) / 100)));
    return [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
  };
  const lum = (c: number[]) => {
    const [r, g, b] = c.map((v) => (v / 255 <= 0.03928 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  };
  const back = rgb(bg, rgb(under));
  const [hi, lo] = [lum(rgb(fg, back)), lum(back)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

describe('the two presets (#59, #172)', () => {
  it('are exactly two, Ubuntu then Quiet (the default), each with its own mono font, prose font and colours', () => {
    expect(THEMES.map((t) => t.id)).toEqual(['ubuntu', 'quiet']);
    expect(THEMES.map((t) => t.label)).toEqual(['Ubuntu', 'Quiet']);
    expect(DEFAULT_THEME).toBe('quiet');
    for (const key of ['mono', 'prose'] as const) expect(new Set(THEMES.map((t) => t[key].family)).size).toBe(2);
    expect(new Set(THEMES.map((t) => t.palette.bg)).size).toBe(2);
    expect(new Set(THEMES.map((t) => t.screen.bg)).size).toBe(2);
    // Every preset sets every colour, and every mono stack ends in the system's box-drawing monospace faces.
    const keys = Object.keys(themeById('quiet').palette).sort();
    for (const t of THEMES) {
      expect(Object.keys(t.palette).sort()).toEqual(keys);
      expect(t.mono.stack.startsWith(`"${t.mono.family}"`)).toBe(true);
      expect(t.mono.stack).toMatch(/Menlo, "DejaVu Sans Mono".*monospace$/);
    }
  });

  it('Ubuntu is the classic purple with white text and the Ubuntu palette anchors, in Ubuntu and Ubuntu Mono', () => {
    const u = themeById('ubuntu');
    expect(u.blurb).toBe('Classic Ubuntu purple, Ubuntu and Ubuntu Mono');
    expect(u.palette.bg).toBe('#300a24');
    expect(u.palette.text).toBe('#ffffff');
    expect(u.palette.blue).toBe('#e95420');
    expect(u.palette['code-bg']).toBe('#2c001e');
    expect(u.palette['bg-3']).toBe('#5e2750');
    expect(u.screen).toMatchObject({ bg: 0x300a24, fg: 0xffffff });
    expect(u.mono.stack).toBe(`"Ubuntu Mono", "H3D Box Ubuntu", "H3D Symbols Ubuntu", "H3D Symbols Ubuntu 2", "H3D Symbols Ubuntu Consolas", ${SYSTEM_MONO}`);
    expect(u.prose.stack).toBe('"Ubuntu", system-ui, sans-serif');
    // Four faces of Ubuntu Mono for the terminal: nothing is synthesised.
    expect(canvasFaces(u)).toEqual(['400 16px "Ubuntu Mono"', '700 16px "Ubuntu Mono"', 'italic 400 16px "Ubuntu Mono"', 'italic 700 16px "Ubuntu Mono"']);
  });

  it('Ubuntu’s text is 4.5:1 on every surface it sits on, its accent and sun 3:1 as a fill or a ring', () => {
    const { palette: p } = themeById('ubuntu');
    const surfaces = [p.bg, p['bg-2'], p['bg-3'], p['code-bg'], p['banner-bg'], p['ask-bg']];
    const texts = [p.text, p['text-2'], p['text-3'], p['blue-text'], p.green, p.red, p['sun-text']];
    for (const s of surfaces) for (const t of texts) expect(ratio(t, s), `${t} on ${s}`).toBeGreaterThanOrEqual(4.5);
    // The ask card's ground: 7% of the accent over bg-2; its red steps toward the text (transcript.css .tx-aq).
    const ask = '#47182f';
    expect(ratio(p['blue-text'], ask)).toBeGreaterThanOrEqual(4.5);
    expect(ratio(p['text-3'], ask)).toBeGreaterThanOrEqual(4.5);
    expect(ratio('#ff9c93', ask)).toBeGreaterThanOrEqual(4.5);
    // Text on the fills: white on the orange is 3.65:1, so the dark aubergine carries it.
    expect(ratio(p['on-accent'], p.blue)).toBeGreaterThanOrEqual(4.5);
    expect(ratio(p['on-sun'], p.sun)).toBeGreaterThanOrEqual(4.5);
    expect(ratio(p['on-sun'], p.green)).toBeGreaterThanOrEqual(4.5);
    // The diffs, each over the screen, and the code and its highlighting on the code ground.
    expect(ratio(p['add-text'], p['add-bg'], p.bg)).toBeGreaterThanOrEqual(4.5);
    expect(ratio(p['del-text'], p['del-bg'], p.bg)).toBeGreaterThanOrEqual(4.5);
    expect(ratio(p['text'], p['add-bg'], p.bg)).toBeGreaterThanOrEqual(4.5);
    expect(ratio(p['text'], p['del-bg'], p.bg)).toBeGreaterThanOrEqual(4.5);
    for (const k of ['code-text', 'hl-comment', 'hl-keyword', 'hl-string', 'hl-number', 'hl-title', 'hl-attr', 'hl-meta'] as const) expect(ratio(p[k], p['code-bg']), k).toBeGreaterThanOrEqual(4.5);
    // Focus rings, the Send fill and the waiting tape against the surfaces they touch.
    for (const s of [p.bg, p['bg-2'], p['bg-3'], p['code-bg']]) {
      expect(ratio(p.blue, s), `accent on ${s}`).toBeGreaterThanOrEqual(3);
      expect(ratio(p.sun, s), `sun on ${s}`).toBeGreaterThanOrEqual(3);
    }
    // Waiting, success and error read apart, and so does the accent from the waiting sun.
    expect(new Set([p.sun, p.green, p.red, p.blue]).size).toBe(4);
    expect(p['add-bg']).not.toBe(p['del-bg']);
  });

  it('#206: on the added and deleted bands (over the code ground) every token, the plain text, the sign and the line numbers are 4.5:1; the bands read apart from the ground', () => {
    const hex = (c: number[]) => `#${c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
    const rgb = (c: string) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
    /** transcript.css: the line numbers on a band, `color-mix(in srgb, <tint> 55%, var(--tx-text-3))`. */
    const mix = (a: string, b: string) => hex(rgb(a).map((v, i) => v * 0.55 + (rgb(b)[i] as number) * 0.45));
    for (const t of THEMES) {
      const p = t.palette;
      for (const [band, tint] of [
        [p['add-bg'], p['add-text']],
        [p['del-bg'], p['del-text']],
      ] as const) {
        const on = (fg: string) => ratio(fg, band, p['code-bg']);
        for (const k of ['text', 'hl-comment', 'hl-keyword', 'hl-string', 'hl-number', 'hl-title', 'hl-attr', 'hl-meta'] as const) expect(on(p[k]), `${t.id} ${k} on ${band}`).toBeGreaterThanOrEqual(4.5);
        expect(on(tint), `${t.id} sign on ${band}`).toBeGreaterThanOrEqual(4.5);
        expect(on(mix(tint, p['text-3'])), `${t.id} line numbers on ${band}`).toBeGreaterThanOrEqual(4.5);
        // Not a faint wash: the band itself stands off the ground.
        const ground = rgb(p['code-bg']);
        const m = /^rgb\((\d+) (\d+) (\d+) \/ (\d+)%\)$/.exec(band) as RegExpExecArray;
        const laid = hex([1, 2, 3].map((i) => Number(m[i]) * (Number(m[4]) / 100) + (ground[i - 1] as number) * (1 - Number(m[4]) / 100)));
        expect(ratio(laid, p['code-bg']), `${t.id} ${band} on the ground`).toBeGreaterThanOrEqual(1.35);
      }
      for (const k of ['hl-comment', 'hl-keyword', 'hl-string', 'hl-number', 'hl-title', 'hl-attr', 'hl-meta'] as const) expect(ratio(p[k], p['code-bg']), `${t.id} ${k}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('knows no third: a stored id that is not one of them is not a theme (the retired ones migrate in themePrefs)', () => {
    expect(['ubuntu', 'quiet'].every(isThemeId)).toBe(true);
    for (const v of ['', 'dark', 'Quiet', null, 3, 'ubuntu ', 'terminal', 'paper']) expect(isThemeId(v)).toBe(false);
  });

  it('puts its fonts, sizes and colours on the page as custom properties', () => {
    const v = themeVars(themeById('ubuntu'), 100);
    expect(v['--tx-mono']).toBe(themeById('ubuntu').mono.stack);
    // #216: the shell's mono is the UI theme's: a transcript preset never sets it.
    expect(v).not.toHaveProperty('--font-mono');
    expect(v).not.toHaveProperty('--font');
    expect(v['--tx-prose']).toContain('"Ubuntu"');
    expect(v['--tx-bg']).toBe('#300a24');
    expect(v['--tx-blue-text']).toBe(themeById('ubuntu').palette['blue-text']);
    expect(v['--tx-fs']).toBe('13.5px');
    expect(v['--tx-mono-fs']).toBe('14px');
    expect(Number(v['--tx-k'])).toBe(1);
    expect(themeVars(themeById('quiet'), 200)['--tx-fs']).toBe('27px');
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
    expect(prosePx(themeById('ubuntu'), 150)).toBe(20.25);
    expect(prosePx(themeById('quiet'), 150)).toBe(20.25);
  });

  it('follows the zoom on half pixels, at every step, and never shrinks as the zoom grows', () => {
    expect(monoPx(themeById('quiet'), 100)).toBe(11.5);
    expect(monoPx(themeById('quiet'), 200)).toBe(23);
    expect(monoPx(themeById('quiet'), 70)).toBe(8);
    // #172: Ubuntu has no pixel grid (Departure Mono's 11 px one went with the Terminal preset).
    const u = themeById('ubuntu');
    expect([70, 100, 150, 200].map((z) => monoPx(u, z))).toEqual([10, 14, 21, 28]);
    for (const t of THEMES) {
      for (let z = ZOOM.min; z <= ZOOM.max; z += ZOOM.step) {
        expect((monoPx(t, z) * 2) % 1).toBe(0);
        if (z < ZOOM.max) expect(monoPx(t, z + ZOOM.step)).toBeGreaterThanOrEqual(monoPx(t, z));
      }
    }
  });
});
