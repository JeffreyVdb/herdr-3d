import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Terminal } from '@xterm/xterm';
import { describe, expect, it } from 'vitest';
import { CELL_ASPECT, cellGrid, contrast, GLANCE, glanceView, paintBuffer, paletteColor, readable, SCREEN_THEME, type Paint2D } from './paint';

/** A 2D context that records what is drawn. */
function fakeCtx() {
  const rects: Array<{ x: number; y: number; w: number; h: number; style: string }> = [];
  const texts: Array<{ text: string; style: string; font: string }> = [];
  const g = {
    fillStyle: '' as string | CanvasGradient | CanvasPattern,
    font: '',
    textBaseline: 'alphabetic' as CanvasTextBaseline,
    fillRect(x: number, y: number, w: number, h: number) {
      rects.push({ x, y, w, h, style: String(this.fillStyle) });
    },
    fillText(text: string) {
      texts.push({ text, style: String(this.fillStyle), font: this.font });
    },
    measureText: () => ({ width: 6 }) as TextMetrics,
    setTransform() {},
    save() {},
    restore() {},
  };
  return { g: g as unknown as Paint2D, rects, texts };
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
    expect(f.texts.map((x) => x.text.trimEnd())).toEqual(['ls', 'red', ' ok', ' blue', '$']);
    expect(runs).toBe(5);
    expect(f.texts[1]?.style).toBe(css(SCREEN_THEME.ansi[1] as number));
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
    expect(f.texts.map((x) => x.text).join('')).toContain('Retries are in');
    expect(runs).toBeGreaterThan(20);
    expect(runs).toBeLessThan(400);
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
    const drawn = f.texts.map((x) => x.text).join('');
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
