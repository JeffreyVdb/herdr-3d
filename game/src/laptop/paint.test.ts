import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Terminal } from '@xterm/xterm';
import { describe, expect, it } from 'vitest';
import { THEMES } from '../ui/themes';
import { CELL_ASPECT, cellGrid, contrast, GLANCE, glanceView, paintBuffer, paletteColor, readable, SCREEN_THEME, screenTheme, viewport, type Paint2D } from './paint';

/**
 * A 2D context that records what is drawn: each glyph with its left edge and the width it takes on the canvas
 * (the context's horizontal scale applied), for a font whose advance is `ratio` of its size.
 */
function fakeCtx(ratio = 0.6) {
  const rects: Array<{ x: number; y: number; w: number; h: number; style: string }> = [];
  const texts: Array<{ text: string; style: string; font: string; x: number; y: number; w: number }> = [];
  const strokes: number[] = [];
  let sx = 1;
  const size = (font: string) => Number(/(\d+(?:\.\d+)?)px/.exec(font)?.[1] ?? 10);
  const g = {
    fillStyle: '' as string | CanvasGradient | CanvasPattern,
    strokeStyle: '' as string | CanvasGradient | CanvasPattern,
    lineWidth: 1,
    font: '',
    textBaseline: 'alphabetic' as CanvasTextBaseline,
    fillRect(x: number, y: number, w: number, h: number) {
      rects.push({ x, y, w, h, style: String(this.fillStyle) });
    },
    fillText(text: string, x: number, y: number, max?: number) {
      const adv = Math.min(size(this.font) * ratio * [...text].length, max ?? Infinity);
      texts.push({ text, style: String(this.fillStyle), font: this.font, x: x * sx, y, w: adv * sx });
    },
    measureText(t: string) {
      return { width: size(this.font) * ratio * t.length } as TextMetrics;
    },
    setTransform(a: number) {
      sx = a;
    },
    save() {},
    restore() {
      sx = 1;
    },
    beginPath() {},
    moveTo() {},
    lineTo() {},
    arcTo() {},
    stroke() {
      strokes.push(1);
    },
  };
  return { g: g as unknown as Paint2D, rects, texts, strokes };
}

/** The drawn glyphs back as text rows, placed by the cells they start in. */
function drawnRows(texts: ReturnType<typeof fakeCtx>['texts'], grid: { cw: number; ch: number; x0: number; y0: number }): string[] {
  const rows: string[][] = [];
  for (const t of texts) {
    const r = Math.floor((t.y - grid.y0) / grid.ch);
    const c = Math.round((t.x - grid.x0) / grid.cw);
    (rows[r] ??= [])[c] = t.text;
  }
  return Array.from(rows, (r) => Array.from(r ?? [], (x) => x ?? ' ').join('').trimEnd());
}

const write = (t: Terminal, s: string | Uint8Array) => new Promise<void>((r) => t.write(s, r));
const css = (c: number) => `#${c.toString(16).padStart(6, '0')}`;

describe('paletteColor', () => {
  it('maps the 16 to the theme, then the cube and the grey ramp', () => {
    expect(paletteColor(1)).toBe(SCREEN_THEME.ansi[1]);
    expect(paletteColor(16)).toBe(0x000000);
    expect(paletteColor(196)).toBe(0xff0000);
    expect(paletteColor(231)).toBe(0xffffff);
    expect(paletteColor(232)).toBe(0x080808);
    expect(paletteColor(255)).toBe(0xeeeeee);
  });
});

describe('cellGrid', () => {
  it('fills the screen at the usual shapes, letterboxes a wide pane and pillarboxes a tall one', () => {
    const fill = cellGrid({ cols: 120, rows: 36, width: 480, height: 310 });
    expect(fill.cw / fill.ch).toBeGreaterThan(CELL_ASPECT.min);
    const wide = cellGrid({ cols: 240, rows: 40, width: 480, height: 310 });
    expect(wide.cw / wide.ch).toBeCloseTo(CELL_ASPECT.min, 5);
    expect(wide.y0).toBeGreaterThan(fill.y0);
    const tall = cellGrid({ cols: 40, rows: 60, width: 480, height: 310 });
    expect(tall.cw / tall.ch).toBeCloseTo(CELL_ASPECT.max, 5);
    expect(tall.x0).toBeGreaterThan(fill.x0);
    // Centred: the grid ends as far from the right edge as it starts from the left.
    expect(tall.x0 + tall.cw * 40).toBeCloseTo(480 - tall.x0, 5);
  });
});

describe('paintBuffer', () => {
  it('draws runs of same-styled text, backgrounds, and the cursor', async () => {
    const t = new Terminal({ cols: 20, rows: 4, scrollback: 0 });
    await write(t, 'ls \x1b[31mred\x1b[0m ok\r\n\x1b[44m blue \x1b[0m\r\n$ ');
    const f = fakeCtx();
    const runs = paintBuffer(f.g, t.buffer.active, { cols: 20, rows: 4, width: 200, height: 80, cursor: true });
    expect(drawnRows(f.texts, cellGrid({ cols: 20, rows: 4, width: 200, height: 80 }))).toEqual(['ls red ok', ' blue', '$']);
    expect(runs).toBe(5);
    expect(f.texts.find((x) => x.text === 'r')?.style).toBe(css(SCREEN_THEME.ansi[1] as number));
    // The whole screen first, then the blue background run, then the cursor after "$ ".
    expect(f.rects[0]).toMatchObject({ x: 0, y: 0, w: 200, h: 80, style: css(SCREEN_THEME.bg) });
    expect(f.rects.some((r) => r.style === css(SCREEN_THEME.ansi[4] as number))).toBe(true);
    const { cw, ch, x0, y0 } = cellGrid({ cols: 20, rows: 4, width: 200, height: 80 });
    const cursor = f.rects.find((r) => r.style === css(SCREEN_THEME.cursor));
    expect(cursor).toMatchObject({ x: x0 + 2 * cw, y: y0 + 2 * ch });
    t.dispose();
  });

  it('hides the cursor when asked, and keeps bold/italic in the font', async () => {
    const t = new Terminal({ cols: 10, rows: 2, scrollback: 0 });
    await write(t, '\x1b[1mB\x1b[0m\x1b[3mi\x1b[0m');
    const f = fakeCtx();
    paintBuffer(f.g, t.buffer.active, { cols: 10, rows: 2, width: 100, height: 40, cursor: false });
    expect(f.rects.some((r) => r.style === css(SCREEN_THEME.cursor))).toBe(false);
    expect(f.texts.map((x) => [x.text, x.font.split(' ').slice(0, 2).join(' ')])).toEqual([
      ['B', '700 14px'],
      ['i', 'italic 400'],
    ]);
    t.dispose();
  });

  it('paints a recorded agent screen in a few hundred runs at most', async () => {
    const lines = readFileSync(join(import.meta.dirname, '../../fixtures/screens/agent.jsonl'), 'utf8').trim().split('\n');
    const meta = JSON.parse(lines[0] as string) as { cols: number; rows: number };
    const t = new Terminal({ cols: meta.cols, rows: meta.rows, scrollback: 0 });
    for (const l of lines.slice(1)) await write(t, Buffer.from((JSON.parse(l) as { data: string }).data, 'base64'));
    const f = fakeCtx();
    const runs = paintBuffer(f.g, t.buffer.active, { cols: meta.cols, rows: meta.rows, width: 480, height: 310, cursor: true });
    expect(drawnRows(f.texts, cellGrid({ cols: meta.cols, rows: meta.rows, width: 480, height: 310 })).join('\n')).toContain('Retries are in');
    expect(runs).toBeGreaterThan(20);
    expect(runs).toBeLessThan(400);
    t.dispose();
  });
});

/** #59: each preset's mono font, by its advance at 1px (measured from the files: `M`'s advance / units per em). */
const ADVANCE: Record<string, number> = { terminal: 350 / 550, quiet: 600 / 1000, paper: 612 / 1000 };

describe('paintBuffer with the presets (#59)', () => {
  it('draws every glyph in its own cell, never wider or taller than it, in each preset’s font, at every zoom and cell shape', async () => {
    const t = new Terminal({ cols: 40, rows: 6, scrollback: 0 });
    await write(t, '\r\n\r\n\r\na->b != c => d www 0xFF ...\r\n\x1b[1mbold\x1b[0m \x1b[3mital\x1b[0m ✓ → é\r\n$ ');
    const shapes = [
      { width: 640, height: 200 }, // the usual
      { width: 1600, height: 200 }, // wide cells: stretched to CELL_ASPECT.max
      { width: 200, height: 400 }, // narrow cells: squeezed to CELL_ASPECT.min
    ];
    for (const preset of THEMES) {
      for (const shape of shapes) {
        for (const zoom of [70, 100, 130, 200]) {
          const f = fakeCtx(ADVANCE[preset.id]);
          const o = { cols: 40, rows: 6, ...shape, cursor: true, font: preset.mono.stack, theme: screenTheme(preset.screen), zoom };
          paintBuffer(f.g, t.buffer.active, o);
          const v = viewport({ ...o, cursor: { x: 2, y: 5 } });
          expect(f.texts.length).toBeGreaterThan(8);
          for (const g of f.texts) {
            // One grapheme per draw: no ligature spans cells, no run of fallback advances moves the next one.
            expect([...g.text]).toHaveLength(1);
            const col = (g.x - v.x0) / v.cw;
            expect(Math.abs(col - Math.round(col))).toBeLessThan(1e-6);
            expect(g.w).toBeLessThanOrEqual(v.cw + 1e-6);
            expect(Number(/(\d+)px/.exec(g.font)?.[1])).toBeLessThanOrEqual(v.ch);
            expect(g.font).toContain(preset.mono.stack);
          }
          // The squeeze or stretch that fits a glyph to its cell stays within what reads as the font.
          const scale = v.cw / (Math.round(v.ch * 0.8) * (ADVANCE[preset.id] as number));
          expect(scale).toBeGreaterThan(0.8);
          expect(scale).toBeLessThan(1.5);
          expect(f.rects[0]?.style).toBe(css(preset.screen.bg));
          expect(f.rects.some((r) => r.style === css(preset.screen.cursor))).toBe(true);
        }
      }
    }
    t.dispose();
  });

  it('draws box drawing, blocks and braille as shapes inside their cells, never as text', async () => {
    const t = new Terminal({ cols: 12, rows: 4, scrollback: 0 });
    await write(t, '╭──┬─╮ ▀▄█\r\n│ab┃═║ ░▒▓\r\n╰──┴─╯ ⠋⠙⣿\r\n┄┅╌╳╱▖');
    const f = fakeCtx();
    const o = { cols: 12, rows: 4, width: 240, height: 120, cursor: false };
    paintBuffer(f.g, t.buffer.active, o);
    expect(f.texts.map((x) => x.text)).toEqual(['a', 'b']);
    const { cw, ch, x0, y0 } = cellGrid(o);
    const shapes = f.rects.slice(1);
    // Every cell but the blanks and the letters has ink; the diagonals and arcs are strokes.
    expect(shapes.length).toBeGreaterThan(40);
    expect(f.strokes.length).toBe(6);
    for (const r of shapes) {
      expect(r.x).toBeGreaterThanOrEqual(Math.floor(x0) - 1);
      expect(r.x + r.w).toBeLessThanOrEqual(Math.ceil(x0 + 12 * cw) + 1);
      expect(r.y).toBeGreaterThanOrEqual(Math.floor(y0) - 1);
      expect(r.y + r.h).toBeLessThanOrEqual(Math.ceil(y0 + 4 * ch) + 1);
    }
    // A horizontal line reaches both edges of its cell, so a frame joins up with its neighbours.
    const top = shapes.filter((r) => r.y < y0 + ch && r.h <= 3 && r.x >= x0 + cw - 2 && r.x + r.w <= x0 + 3 * cw + 2);
    expect(Math.min(...top.map((r) => r.x))).toBeLessThanOrEqual(x0 + cw);
    expect(Math.max(...top.map((r) => r.x + r.w))).toBeGreaterThanOrEqual(x0 + 3 * cw - 0.5);
    expect(top.reduce((n, r) => n + r.w, 0)).toBeGreaterThanOrEqual(2 * cw - 2);
    // The shades mix the text into the background.
    const shade = f.rects.filter((r) => Math.abs(r.w - cw) < 1.5 && Math.abs(r.h - ch) < 1.5 && r.style !== css(SCREEN_THEME.fg));
    expect(new Set(shade.map((r) => r.style)).size).toBeGreaterThanOrEqual(3);
    t.dispose();
  });

  it('keeps the preset’s text readable on an agent’s own backgrounds, and any colour on Paper’s light screen', async () => {
    const paper = screenTheme(THEMES[2].screen);
    const t = new Terminal({ cols: 20, rows: 2, scrollback: 0 });
    await write(t, '\x1b[41m-old\x1b[0m \x1b[97mwhite\x1b[0m\r\n\x1b[2mdim\x1b[0m');
    const f = fakeCtx();
    paintBuffer(f.g, t.buffer.active, { cols: 20, rows: 2, width: 200, height: 40, cursor: false, theme: paper });
    const rgb = (s: string) => parseInt(s.slice(1), 16);
    const on = (ch: string) => f.texts.find((x) => x.text === ch)!;
    expect(contrast(rgb(on('o').style), paper.ansi[1] as number)).toBeGreaterThanOrEqual(3);
    expect(contrast(rgb(on('w').style), paper.bg)).toBeGreaterThanOrEqual(3);
    // A dark screen leaves its own colours alone on its background (dim stays dim).
    const g = fakeCtx();
    paintBuffer(g.g, t.buffer.active, { cols: 20, rows: 2, width: 200, height: 40, cursor: false });
    expect(contrast(rgb(g.texts.find((x) => x.text === 'd')!.style), SCREEN_THEME.bg)).toBeLessThan(3);
    t.dispose();
  });
  it('keeps concealed text (SGR 8) invisible in every preset, on a cell background too, and in the glance view', async () => {
    const t = new Terminal({ cols: 30, rows: 3, scrollback: 0 });
    await write(t, 'a\x1b[8mSECRET\x1b[0mb\r\n\x1b[44;8mHIDDEN\x1b[0m\r\n\x1b[4;9;8mXY\x1b[0m');
    for (const preset of THEMES) {
      for (const glance of [false, true]) {
        const f = fakeCtx();
        paintBuffer(f.g, t.buffer.active, { cols: 30, rows: 3, width: 300, height: 60, cursor: false, glance, theme: screenTheme(preset.screen) });
        const drawn = f.texts.map((x) => x.text).join('');
        expect(drawn).toContain('a');
        expect(drawn).toContain('b');
        expect(drawn).not.toMatch(/[SECRTHIDNXY]/);
        // The blue cell background still shows; no underline or strike marks the concealed cells.
        if (!glance) expect(f.rects.some((r) => r.style === css(screenTheme(preset.screen).ansi[4] as number))).toBe(true);
        expect(f.rects.filter((r) => r.h < 3 && r.style !== css(screenTheme(preset.screen).ansi[4] as number)).length).toBe(0);
      }
    }
    t.dispose();
  });
});

describe('viewport (#59 zoom)', () => {
  const screen = { cols: 120, rows: 36, width: 1200, height: 800 };
  it('fits the whole pane at 100%, and shrinks it into the middle of the letterbox below', () => {
    const fit = viewport({ ...screen, zoom: 100 });
    expect(fit).toMatchObject({ col0: 0, row0: 0, cols: 120, rows: 36, ...cellGrid(screen) });
    const small = viewport({ ...screen, zoom: 70 });
    expect(small).toMatchObject({ col0: 0, row0: 0, cols: 120, rows: 36 });
    expect(small.cw).toBeCloseTo(fit.cw * 0.7, 6);
    expect(small.x0 + small.cw * 120).toBeCloseTo(1200 - small.x0, 6);
  });

  it('above 100% shows the bottom-left of the pane, bigger, and keeps the cursor in view wherever it is', () => {
    for (const zoom of [110, 150, 200]) {
      const v = viewport({ ...screen, zoom });
      expect(v.cols).toBeLessThan(120);
      expect(v.rows).toBeLessThan(36);
      expect(v).toMatchObject({ col0: 0, row0: 36 - v.rows });
      expect(v.cw).toBeCloseTo(cellGrid(screen).cw * (zoom / 100), 6);
      // The grid shown stays inside the screen.
      expect(v.x0).toBeGreaterThanOrEqual(0);
      expect(v.x0 + v.cw * v.cols).toBeLessThanOrEqual(1200 + 1e-6);
      expect(v.y0 + v.ch * v.rows).toBeLessThanOrEqual(800 + 1e-6);
      for (const cursor of [
        { x: 0, y: 0 },
        { x: 119, y: 0 },
        { x: 119, y: 35 },
        { x: 60, y: 17 },
        { x: 3, y: 35 },
      ]) {
        const c = viewport({ ...screen, zoom, cursor });
        expect(cursor.x).toBeGreaterThanOrEqual(c.col0);
        expect(cursor.x).toBeLessThan(c.col0 + c.cols);
        expect(cursor.y).toBeGreaterThanOrEqual(c.row0);
        expect(cursor.y).toBeLessThan(c.row0 + c.rows);
        expect(c.col0 + c.cols).toBeLessThanOrEqual(120);
        expect(c.row0 + c.rows).toBeLessThanOrEqual(36);
      }
    }
  });

  it('paints the cursor on screen at every zoom', async () => {
    const t = new Terminal({ cols: 80, rows: 24, scrollback: 0 });
    await write(t, '\x1b[3;70Hx');
    for (let zoom = 70; zoom <= 200; zoom += 10) {
      const f = fakeCtx();
      paintBuffer(f.g, t.buffer.active, { cols: 80, rows: 24, width: 800, height: 500, cursor: true, zoom });
      const cur = f.rects.find((r) => r.style === css(SCREEN_THEME.cursor));
      expect(cur, `zoom ${zoom}`).toBeDefined();
      expect(cur!.x).toBeGreaterThanOrEqual(0);
      expect(cur!.x + cur!.w).toBeLessThanOrEqual(800 + 1);
      expect(cur!.y).toBeGreaterThanOrEqual(0);
      expect(cur!.y + cur!.h).toBeLessThanOrEqual(500 + 1);
    }
    t.dispose();
  });
});

/** A screen given as text, one character per cell (tests). */
const grid = (lines: string[], cols = 60) => lines.map((l) => Array.from(l.padEnd(cols, ' ')).slice(0, cols));
const text = (rows: string[][], segs: ReturnType<typeof glanceView>) => segs.map((g) => rows[g.row]!.slice(g.c0, g.c1).join(''));

describe('glance view (M6b)', () => {
  it('keeps the rows that say something: no blank rows, no empty frames or prompt boxes', () => {
    const rows = grid(['╭──────────╮', '│ ✻ Worker │', '╰──────────╯', '', '● Bash(pnpm test)', '  ⎿  ✓ 42 passed', '', '╭────────────╮', '│ >          │', '╰────────────╯', '  ? for shortcuts']);
    expect(text(rows, glanceView(rows, 34))).toEqual(['│ ✻ Worker │', '● Bash(pnpm test)', '  ⎿  ✓ 42 passed']);
    // A prompt being typed says something; what follows a box that is not at the bottom stays too.
    const typed = grid(['● ok', '╭──────────╮', '│ > fix it │', '╰──────────╯', '  ? for shortcuts']);
    expect(text(typed, glanceView(typed, 34))).toEqual(['● ok', '│ > fix it │']);
    const boxed = grid(['╭────╮', '│ hi │', '╰────╯', 'one', 'two', 'three']);
    expect(text(boxed, glanceView(boxed, 34))).toEqual(['│ hi │', 'one', 'two', 'three']);
  });

  it('word-wraps long rows at the glance width, keeping the indent, and shows the last lines', () => {
    const rows = grid(['    ● Retries are in and the tests pass (42 passed). Anything else?', '    ok'], 80);
    const segs = glanceView(rows, 20, 8);
    expect(text(rows, segs).map((l) => l.trimEnd())).toEqual(['● Retries are in and', 'the tests pass (42', 'passed). Anything', 'else?', 'ok']);
    expect(segs.every((g) => g.c1 - g.c0 <= 20)).toBe(true);
    // The common indent goes, a deeper one stays.
    const deeper = grid(['  a b', '      c d']);
    expect(text(deeper, glanceView(deeper))).toEqual(['a b', '    c d']);
    // Only the last `max` lines.
    const many = grid(Array.from({ length: 30 }, (_, i) => `line ${i}`));
    expect(text(many, glanceView(many, 34, 8))).toEqual(Array.from({ length: 8 }, (_, i) => `line ${22 + i}`));
    expect(glanceView(grid(['', '   ', '──────']))).toEqual([]);
  });

  it('never splits a wide character', () => {
    const cells = [...Array.from('x'.repeat(19)), '界', '', ...Array.from('yyyy')];
    const segs = glanceView([cells], 20, 8);
    expect(segs[0]).toEqual({ row: 0, c0: 0, c1: 19 });
    expect(segs[1]).toEqual({ row: 0, c0: 19, c1: 25 });
  });

  it('lifts dim colours to 4.5:1 on their background, and leaves readable ones alone', () => {
    const dim = SCREEN_THEME.ansi[8] as number;
    expect(contrast(dim, SCREEN_THEME.bg)).toBeLessThan(4.5);
    expect(contrast(readable(dim, SCREEN_THEME.bg), SCREEN_THEME.bg)).toBeGreaterThanOrEqual(4.5);
    expect(readable(SCREEN_THEME.fg, SCREEN_THEME.bg)).toBe(SCREEN_THEME.fg);
    expect(contrast(readable(0xaaaaaa, 0xffffff), 0xffffff)).toBeGreaterThanOrEqual(4.5);
  });

  it('paints the recorded agent screen’s last lines big: the reply, no prompt box, no footer', async () => {
    const lines = readFileSync(join(import.meta.dirname, '../../fixtures/screens/agent.jsonl'), 'utf8').trim().split('\n');
    const meta = JSON.parse(lines[0] as string) as { cols: number; rows: number };
    const t = new Terminal({ cols: meta.cols, rows: meta.rows, scrollback: 0 });
    for (const l of lines.slice(1)) await write(t, Buffer.from((JSON.parse(l) as { data: string }).data, 'base64'));
    const f = fakeCtx();
    paintBuffer(f.g, t.buffer.active, { cols: meta.cols, rows: meta.rows, width: 768, height: 322, cursor: true, glance: true });
    const drawn = drawnRows(f.texts, cellGrid({ ...GLANCE, width: 768, height: 322 })).join('\n');
    // The last five lines: the end of the test run and the whole reply.
    expect(drawn).toContain('(1.2s)');
    expect(drawn).toContain('Retries are in');
    expect(drawn).toContain('Anything');
    expect(drawn).not.toContain('╭');
    expect(drawn).not.toContain('shortcuts');
    // A glance-sized font: 5 lines on the screen, against 36 for the whole one.
    const size = (x: { font: string }) => Number(/(\d+)px/.exec(x.font)?.[1]);
    const full = fakeCtx();
    paintBuffer(full.g, t.buffer.active, { cols: meta.cols, rows: meta.rows, width: 768, height: 322, cursor: true });
    expect(size(f.texts[0]!)).toBeGreaterThan(4 * size(full.texts[0]!));
    expect(size(f.texts[0]!)).toBe(Math.round(cellGrid({ ...GLANCE, width: 768, height: 322 }).ch * 0.8));
    // No cursor in the glance view.
    expect(f.rects.some((r) => r.style === css(SCREEN_THEME.cursor))).toBe(false);
    t.dispose();
  });
});
