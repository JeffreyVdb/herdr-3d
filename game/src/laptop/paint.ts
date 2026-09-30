import type { IBuffer, IBufferCell } from '@xterm/xterm';
import { SYSTEM_MONO } from '../ui/themes';
import { drawSymbol, isSymbol } from './glyphs';

/**
 * M5: draws an xterm buffer (the VT state of a watched pane) into a 2D
 * canvas for a laptop screen: runs of same-styled cells as one fillRect and
 * one fillText each, the font squeezed to the cell width so columns line up.
 * The colours are the office's: a navy screen, the HUD's hues for ANSI, and
 * the sun-yellow cursor of the HUD's focus ring.
 *
 * #59: the terminal's preset picks the font, the background, the text and the
 * cursor (the 16 ANSI colours stay). Each glyph is drawn in its own cell, so
 * no font's ligatures (JetBrains Mono's `calt`) or fallback advances move a
 * column, and box drawing, block elements and braille are drawn as shapes
 * (`glyphs.ts`): no preset's mono font has braille, two have no boxes. Seated,
 * the zoom enlarges the cells past the fit (a viewport that keeps the cursor
 * in view) or shrinks them inside the letterbox.
 *
 * M6b: the desk monitors are read from the aisle, 3–5 m away, where a
 * 120-column screen is a grey smudge. Standing, a monitor shows the glance
 * view instead (`glanceView`): the last few lines that say something (no
 * blank rows, no empty box frames, no agent footer), wrapped at 22 columns
 * and set big and bold, every colour lifted to at least 4.5:1 against its
 * background: at 4 m that is about as small as text reads. The screen you
 * sit at is the whole terminal, as before.
 */

export interface ScreenTheme {
  bg: number;
  fg: number;
  cursor: number;
  ansi: readonly number[];
}

export const SCREEN_THEME: ScreenTheme = {
  bg: 0x10162a,
  fg: 0xdde4f3,
  cursor: 0xffc233,
  ansi: [
    0x1a2138, 0xff6b5e, 0x3ccf8e, 0xffc233, 0x5b8cff, 0xc07bf0, 0x4fd1e0, 0xc9d2e6,
    0x5b6685, 0xff8a80, 0x6ee7a8, 0xffd666, 0x8fb1ff, 0xd9a3ff, 0x8ae6f0, 0xffffff,
  ],
};

/** The system's monospace stack (the About card's font, and what every preset's stack falls back to). */
export const MONO = SYSTEM_MONO;

/** #59: a preset's screen colours on the office's ANSI 16. */
export function screenTheme(s: { bg: number; fg: number; cursor: number }): ScreenTheme {
  return { ...SCREEN_THEME, bg: s.bg, fg: s.fg, cursor: s.cursor };
}

/** xterm's 256-colour palette: the theme's 16, the 6×6×6 cube, the grey ramp. */
export function paletteColor(n: number, t: ScreenTheme = SCREEN_THEME): number {
  if (n < 16) return t.ansi[n] ?? t.fg;
  if (n < 232) {
    const i = n - 16;
    const q = (v: number) => (v ? 55 + v * 40 : 0);
    return (q(Math.floor(i / 36)) << 16) | (q(Math.floor(i / 6) % 6) << 8) | q(i % 6);
  }
  const g = 8 + (n - 232) * 10;
  return (g << 16) | (g << 8) | g;
}

const hex = (c: number) => `#${(c & 0xffffff).toString(16).padStart(6, '0')}`;
const mix = (a: number, b: number) => (((a & 0xfefefe) >>> 1) + ((b & 0xfefefe) >>> 1)) & 0xffffff;

export interface PaintOptions {
  cols: number;
  rows: number;
  width: number;
  height: number;
  /** Draw the cursor (DECTCEM: the pane shows it). */
  cursor: boolean;
  theme?: ScreenTheme;
  /** M6b: paint the glance view (the last lines, big) instead of the whole screen. */
  glance?: boolean;
  /** #59: the font stack (the preset's mono; default the system's). */
  font?: string;
  /** #59: the seated zoom, percent (100: the pane fits the screen). Not for the glance view. */
  zoom?: number;
}

/** M6b: the glance view's grid: this many columns and lines, whatever the pane's size. */
export const GLANCE = { cols: 22, rows: 5 } as const;

/** M6b: a line of the glance view: cells `c0`..`c1` (exclusive) of the screen's row `row`. */
export interface Segment {
  row: number;
  c0: number;
  c1: number;
}

/** Box drawing and block elements: a row of nothing else is a frame (an empty input box, a rule). */
const FRAME = /^[\u2500-\u259f]$/;
const blank = (c: string | undefined) => !c || c === ' ';

/**
 * M6b: the glance view of a screen, given each row as its cells' characters
 * (`''` for the second half of a wide one): the rows that say something,
 * from the leftmost column any of them starts at, word-wrapped at `cols`, the
 * last `max` lines of that. A row says nothing when it is blank, or all frame
 * but at most one character (an empty prompt box `│ > │`); nor do the one or
 * two rows under an agent's input box (its footer: `? for shortcuts`, the
 * key hints).
 */
export function glanceView(rows: ReadonlyArray<ReadonlyArray<string>>, cols: number = GLANCE.cols, max: number = GLANCE.rows): Segment[] {
  const kept: Array<{ row: number; first: number; last: number }> = [];
  let boxEnd = -1;
  rows.forEach((cells, row) => {
    let first = -1;
    let last = -1;
    let other = 0;
    for (let x = 0; x < cells.length; x++) {
      const c = cells[x] as string;
      if (blank(c)) continue;
      if (first < 0) first = x;
      last = x;
      if (!FRAME.test(c)) other++;
    }
    if (first >= 0 && other > 1) kept.push({ row, first, last });
    else if (first >= 0 && (cells[first] === '╰' || cells[first] === '└')) boxEnd = row;
  });
  // The footer under the last input box.
  if (boxEnd >= 0) {
    const below = kept.filter((k) => k.row > boxEnd);
    if (below.length && below.length <= 2) kept.splice(kept.length - below.length, below.length);
  }
  if (!kept.length) return [];
  const lead = Math.min(...kept.map((k) => k.first));
  const out: Segment[] = [];
  for (const { row, first, last } of kept) {
    const cells = rows[row] as ReadonlyArray<string>;
    // From the common indent (a row indented half the width or more starts at its text).
    let c = first - lead < cols / 2 ? lead : first;
    while (c <= last) {
      let end = c + cols;
      if (end > last) {
        out.push({ row, c0: c, c1: last + 1 });
        break;
      }
      // Break after the last space in the second half of the line, else mid-word (never inside a wide character).
      let brk = -1;
      for (let k = end; k > c + cols / 2; k--) {
        if (cells[k] === ' ') {
          brk = k;
          break;
        }
      }
      if (brk > 0) end = brk;
      else if (cells[end] === '') end--;
      out.push({ row, c0: c, c1: end });
      c = end;
      while (c <= last && blank(cells[c])) c++;
    }
  }
  return out.slice(-max);
}

/** WCAG relative luminance of a 0xRRGGBB colour. */
function luminance(c: number): number {
  const ch = (v: number) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * ch((c >> 16) & 255) + 0.7152 * ch((c >> 8) & 255) + 0.0722 * ch(c & 255);
}

export function contrast(a: number, b: number): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

const lerp = (a: number, b: number, k: number) => {
  const m = (s: number) => Math.round(((a >> s) & 255) + (((b >> s) & 255) - ((a >> s) & 255)) * k);
  return (m(16) << 16) | (m(8) << 8) | m(0);
};
const lifted = new Map<string, number>();

/** M6b: `fg` moved towards white (or black, on a light background) until it reads at 4.5:1 on `bg`. */
export function readable(fg: number, bg: number, min = 4.5): number {
  if (contrast(fg, bg) >= min) return fg;
  const key = `${fg}:${bg}:${min}`;
  const hit = lifted.get(key);
  if (hit !== undefined) return hit;
  const to = luminance(bg) > 0.3 ? 0x000000 : 0xffffff;
  let c = fg;
  for (let k = 0.15; k <= 1.001 && contrast(c, bg) < min; k += 0.15) c = lerp(fg, to, Math.min(1, k));
  if (lifted.size > 512) lifted.clear();
  lifted.set(key, c);
  return c;
}

/** The subset of a 2D context the painter uses (a fake one in vitest). */
export type Paint2D = Pick<
  CanvasRenderingContext2D,
  'fillStyle' | 'strokeStyle' | 'lineWidth' | 'font' | 'textBaseline' | 'fillRect' | 'fillText' | 'measureText' | 'setTransform' | 'save' | 'restore' | 'beginPath' | 'moveTo' | 'lineTo' | 'arcTo' | 'stroke'
>;

interface Style {
  fg: number;
  bg: number;
  flags: number;
}

const BOLD = 1;
const ITALIC = 2;
const UNDERLINE = 4;
const STRIKE = 8;
const OVERLINE = 16;

function styleOf(c: IBufferCell, t: ScreenTheme, out: Style): void {
  let fg = c.isFgRGB() ? c.getFgColor() : c.isFgPalette() ? paletteColor(c.getFgColor(), t) : t.fg;
  let bg = c.isBgRGB() ? c.getBgColor() : c.isBgPalette() ? paletteColor(c.getBgColor(), t) : t.bg;
  if (c.isInverse()) [fg, bg] = [bg, fg];
  // Bold keeps its colour (no bright shift); dim halves towards the background.
  if (c.isDim()) fg = mix(fg, bg);
  if (c.isInvisible()) fg = bg;
  out.fg = fg;
  out.bg = bg;
  out.flags = (c.isBold() ? BOLD : 0) | (c.isItalic() ? ITALIC : 0) | (c.isUnderline() ? UNDERLINE : 0) | (c.isStrikethrough() ? STRIKE : 0) | (c.isOverline() ? OVERLINE : 0);
}

/** Inner padding of the screen (a bezel's worth), as a fraction of the width. */
export const PAD = 0.025;

/** Cell width / height the grid keeps: a monospace cell, squeezed or stretched no further. */
export const CELL_ASPECT = { min: 0.42, max: 0.7 };

/**
 * The cell grid inside the padding: cell size and origin. The pane's own size decides cols × rows (the observer
 * does not reflow), so a wide or tall pane is letterboxed on the laptop's screen rather than distorted.
 */
export function cellGrid(o: Pick<PaintOptions, 'cols' | 'rows' | 'width' | 'height'>): { cw: number; ch: number; x0: number; y0: number } {
  const pad = Math.round(o.width * PAD);
  const w = o.width - pad * 2;
  const h = o.height - pad * 2;
  let cw = w / o.cols;
  let ch = h / o.rows;
  if (cw / ch < CELL_ASPECT.min) ch = cw / CELL_ASPECT.min;
  else if (cw / ch > CELL_ASPECT.max) cw = ch * CELL_ASPECT.max;
  return { cw, ch, x0: pad + (w - cw * o.cols) / 2, y0: pad + (h - ch * o.rows) / 2 };
}

/** #59: the part of the pane on screen at a zoom: the cells' size and origin, and the first column and row shown. */
export interface Viewport {
  cw: number;
  ch: number;
  x0: number;
  y0: number;
  col0: number;
  row0: number;
  cols: number;
  rows: number;
}

/** Columns kept between the cursor and the viewport's right edge when it scrolls sideways to follow it. */
const FOLLOW_MARGIN = 4;

/**
 * #59: the seated screen at a zoom (percent). At 100% and below, the whole pane, its cells scaled and centred in the
 * letterbox. Above, the cells grow past the fit and the screen shows the bottom-left of the pane, moved just enough
 * to keep the cursor in view (with a margin on its right): an agent's prompt is at the bottom, a shell's cursor may be
 * anywhere. Pure: the same screen and cursor give the same viewport.
 */
export function viewport(o: Pick<PaintOptions, 'cols' | 'rows' | 'width' | 'height'> & { zoom?: number; cursor?: { x: number; y: number } | null }): Viewport {
  const fit = cellGrid(o);
  const z = Math.min(2, Math.max(0.7, (o.zoom ?? 100) / 100));
  if (z === 1) return { ...fit, col0: 0, row0: 0, cols: o.cols, rows: o.rows };
  const cw = fit.cw * z;
  const ch = fit.ch * z;
  const pad = Math.round(o.width * PAD);
  const w = o.width - pad * 2;
  const h = o.height - pad * 2;
  const cols = Math.max(1, Math.min(o.cols, Math.floor(w / cw + 1e-6)));
  const rows = Math.max(1, Math.min(o.rows, Math.floor(h / ch + 1e-6)));
  let col0 = 0;
  let row0 = o.rows - rows;
  const c = o.cursor;
  if (c) {
    if (c.x >= col0 + cols) col0 = Math.min(o.cols - cols, c.x - cols + 1 + Math.min(FOLLOW_MARGIN, cols - 1));
    if (c.y < row0) row0 = Math.max(0, c.y);
    else if (c.y >= row0 + rows) row0 = Math.min(o.rows - rows, c.y - rows + 1);
  }
  return { cw, ch, x0: pad + (w - cw * cols) / 2, y0: pad + (h - ch * rows) / 2, col0, row0, cols, rows };
}

/** The screen's rows as their cells' characters (the glance view's input). */
function cellRows(buf: IBuffer, rows: number, cols: number, cell: IBufferCell | undefined): { rows: string[][]; cell: IBufferCell | undefined } {
  const out: string[][] = [];
  let c = cell;
  for (let y = 0; y < rows; y++) {
    const line = buf.getLine(buf.viewportY + y);
    const cells: string[] = [];
    for (let x = 0; x < cols; x++) {
      c = line?.getCell(x, c);
      cells.push(!c ? ' ' : c.getWidth() === 0 ? '' : c.getChars() || ' ');
    }
    out.push(cells);
  }
  return { rows: out, cell: c };
}

/**
 * Paints the visible screen of `buf` (M6b: or its glance view; #59: seated, at a zoom). Returns the number of text
 * runs drawn (a cost measure for tests and the bench): a run is cells of one style, its glyphs drawn one per cell.
 */
export function paintBuffer(g: Paint2D, buf: IBuffer, o: PaintOptions, cell: IBufferCell | undefined = undefined): number {
  const t = o.theme ?? SCREEN_THEME;
  const font = o.font ?? MONO;
  let c = cell;
  let lines: Segment[];
  const showCursor = !o.glance && o.cursor && buf.viewportY === buf.baseY;
  let view: Pick<Viewport, 'cw' | 'ch' | 'x0' | 'y0'>;
  if (o.glance) {
    const r = cellRows(buf, o.rows, o.cols, c);
    c = r.cell;
    lines = glanceView(r.rows);
    view = cellGrid({ ...GLANCE, width: o.width, height: o.height });
  } else {
    const v = viewport({ cols: o.cols, rows: o.rows, width: o.width, height: o.height, zoom: o.zoom ?? 100, cursor: showCursor ? { x: buf.cursorX, y: buf.cursorY } : null });
    lines = Array.from({ length: v.rows }, (_, i) => ({ row: v.row0 + i, c0: v.col0, c1: v.col0 + v.cols }));
    view = v;
  }
  const { cw, ch, x0, y0 } = view;
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.fillStyle = hex(t.bg);
  g.fillRect(0, 0, o.width, o.height);
  const size = Math.max(4, Math.round(ch * 0.8));
  // Glance: heavier strokes, so the letters survive being small on screen.
  const w = o.glance ? ['600 ', '800 '] : ['400 ', '700 '];
  const fonts = [0, 1, 2, 3].map((f) => `${f & ITALIC ? 'italic ' : ''}${f & BOLD ? w[1] : w[0]}${size}px ${font}`);
  g.font = fonts[0] as string;
  // The font's advance, squeezed or stretched to the cell (CELL_ASPECT keeps that within a monospace's range).
  const adv = g.measureText('M').width || size * 0.6;
  const sx = cw / adv;
  g.textBaseline = 'middle';
  const cur = { x: buf.cursorX, y: buf.cursorY, show: showCursor };
  const lightScreen = luminance(t.bg) > 0.5;
  const s: Style = { fg: t.fg, bg: t.bg, flags: 0 };
  const glyphs: string[] = [];
  const shapes: number[] = [];
  let runs = 0;
  for (let i = 0; i < lines.length; i++) {
    const { row: y, c0, c1 } = lines[i] as Segment;
    const line = buf.getLine(buf.viewportY + y);
    if (!line) continue;
    const py = y0 + i * ch;
    let x = c0;
    while (x < c1) {
      c = line.getCell(x, c);
      if (!c) break;
      const wd = c.getWidth();
      if (wd === 0) {
        x++;
        continue;
      }
      styleOf(c, t, s);
      const start = x;
      const fg = s.fg;
      const bg = s.bg;
      const flags = s.flags;
      glyphs.length = 0;
      glyphs.push(c.getChars());
      x += wd;
      // Extend the run over single-width cells of the same style (not over the cursor, drawn on its own).
      if (wd === 1 && !(cur.show && cur.y === y && cur.x === start)) {
        while (x < c1 && !(cur.show && cur.y === y && cur.x === x)) {
          const n = line.getCell(x, c);
          if (!n || n.getWidth() !== 1) break;
          styleOf(n, t, s);
          if (s.fg !== fg || s.bg !== bg || s.flags !== flags) break;
          glyphs.push(n.getChars());
          x++;
        }
      }
      const px = x0 + (start - c0) * cw;
      const wpx = (Math.min(x, c1) - start) * cw;
      const isCursor = cur.show && cur.y === y && cur.x === start;
      const cellBg = isCursor ? t.cursor : bg;
      // #59: the preset's text on an agent's own background (a diff's red and green lines), or any colour on a light
      // screen (Paper: ANSI white on cream), is kept to 3:1; the glance view lifts everything to 4.5:1 as before.
      const cellFg = isCursor ? t.bg : o.glance ? readable(fg, bg) : bg !== t.bg || lightScreen ? readable(fg, bg, 3) : fg;
      if (cellBg !== t.bg) {
        g.fillStyle = hex(cellBg);
        // A hair wider so adjacent runs leave no seams.
        g.fillRect(px, py, wpx + 0.5, ch + 0.5);
      }
      // Each glyph at its own cell: no ligature forms across cells, a fallback glyph's advance moves nothing after it.
      shapes.length = 0;
      let drawn = false;
      for (let k = 0; k < glyphs.length; k++) {
        const ch0 = glyphs[k] as string;
        if (!ch0 || ch0 === ' ') continue;
        const cp = ch0.codePointAt(0) as number;
        if (ch0.length <= 2 && isSymbol(cp)) {
          shapes.push(k, cp);
          continue;
        }
        if (!drawn) {
          g.fillStyle = hex(cellFg);
          g.font = fonts[flags & (BOLD | ITALIC)] as string;
          g.save();
          g.setTransform(sx, 0, 0, 1, 0, 0);
          drawn = true;
        }
        const gx = px / sx + k * adv;
        // Not the font's own (a fallback face): kept to its cells' width.
        if (cp > 0x7e) g.fillText(ch0, gx, py + ch / 2, adv * wd);
        else g.fillText(ch0, gx, py + ch / 2);
      }
      if (drawn) {
        g.restore();
        runs++;
      }
      for (let k = 0; k < shapes.length; k += 2) drawSymbol(g, shapes[k + 1] as number, px + (shapes[k] as number) * cw, py, cw, ch, cellFg, cellBg);
      if (flags & (UNDERLINE | STRIKE | OVERLINE)) {
        g.fillStyle = hex(cellFg);
        const lw = Math.max(1, ch / 14);
        if (flags & UNDERLINE) g.fillRect(px, py + ch - lw * 1.5, wpx, lw);
        if (flags & STRIKE) g.fillRect(px, py + ch / 2, wpx, lw);
        if (flags & OVERLINE) g.fillRect(px, py, wpx, lw);
      }
    }
  }
  return runs;
}
