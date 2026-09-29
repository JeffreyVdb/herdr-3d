import type { IBuffer, IBufferCell } from '@xterm/xterm';

/**
 * M5: draws an xterm buffer (the VT state of a watched pane) into a 2D
 * canvas for a laptop screen: runs of same-styled cells as one fillRect and
 * one fillText each, the font squeezed to the cell width so columns line up.
 * The colours are the office's: a navy screen, the HUD's hues for ANSI, and
 * the sun-yellow cursor of the HUD's focus ring.
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

export const MONO = 'ui-monospace, "SF Mono", Menlo, "DejaVu Sans Mono", "Liberation Mono", monospace';

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
}

/** The subset of a 2D context the painter uses (a fake one in vitest). */
export type Paint2D = Pick<CanvasRenderingContext2D, 'fillStyle' | 'font' | 'textBaseline' | 'fillRect' | 'fillText' | 'measureText' | 'setTransform' | 'save' | 'restore'>;

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
export const CELL_ASPECT = { min: 0.42, max: 0.62 };

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

/**
 * Paints the visible screen of `buf`. Returns the number of text runs drawn
 * (a cost measure for tests and the bench).
 */
export function paintBuffer(g: Paint2D, buf: IBuffer, o: PaintOptions, cell: IBufferCell | undefined = undefined): number {
  const t = o.theme ?? SCREEN_THEME;
  const { cw, ch, x0, y0 } = cellGrid(o);
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.fillStyle = hex(t.bg);
  g.fillRect(0, 0, o.width, o.height);
  const size = Math.max(4, Math.round(ch * 0.8));
  const fonts = [0, 1, 2, 3].map((f) => `${f & ITALIC ? 'italic ' : ''}${f & BOLD ? '700 ' : '400 '}${size}px ${MONO}`);
  g.font = fonts[0] as string;
  const adv = g.measureText('M').width || size * 0.6;
  const sx = cw / adv;
  g.textBaseline = 'middle';
  const cur = { x: buf.cursorX, y: buf.cursorY, show: o.cursor && buf.viewportY === buf.baseY };
  const s: Style = { fg: t.fg, bg: t.bg, flags: 0 };
  let runs = 0;
  let c = cell;
  for (let y = 0; y < o.rows; y++) {
    const line = buf.getLine(buf.viewportY + y);
    if (!line) continue;
    const py = y0 + y * ch;
    let x = 0;
    while (x < o.cols) {
      c = line.getCell(x, c);
      if (!c) break;
      const w = c.getWidth();
      if (w === 0) {
        x++;
        continue;
      }
      styleOf(c, t, s);
      const start = x;
      const fg = s.fg;
      const bg = s.bg;
      const flags = s.flags;
      let text = c.getChars() || ' ';
      x += w;
      // Extend the run over single-width cells of the same style (not over the cursor, drawn on its own).
      if (w === 1 && !(cur.show && cur.y === y && cur.x === start)) {
        while (x < o.cols && !(cur.show && cur.y === y && cur.x === x)) {
          const n = line.getCell(x, c);
          if (!n || n.getWidth() !== 1) break;
          styleOf(n, t, s);
          if (s.fg !== fg || s.bg !== bg || s.flags !== flags) break;
          text += n.getChars() || ' ';
          x++;
        }
      }
      const px = x0 + start * cw;
      const wpx = (x - start) * cw;
      const isCursor = cur.show && cur.y === y && cur.x === start;
      const cellBg = isCursor ? t.cursor : bg;
      const cellFg = isCursor ? t.bg : fg;
      if (cellBg !== t.bg) {
        g.fillStyle = hex(cellBg);
        // A hair wider so adjacent runs leave no seams.
        g.fillRect(px, py, wpx + 0.5, ch + 0.5);
      }
      if (text.trim()) {
        g.fillStyle = hex(cellFg);
        g.font = fonts[flags & (BOLD | ITALIC)] as string;
        g.save();
        g.setTransform(sx, 0, 0, 1, 0, 0);
        g.fillText(text, px / sx, py + ch / 2);
        g.restore();
        runs++;
      }
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
