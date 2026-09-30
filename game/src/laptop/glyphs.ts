import type { Paint2D } from './paint';

/**
 * #59: box drawing (U+2500–257F), block elements (U+2580–259F) and braille (U+2800–28FF) drawn as shapes in their
 * cell, like xterm.js's custom glyphs. No preset's mono font has braille and two have no boxes (checked against their
 * files), and a fallback face differs per OS (DejaVu on Linux, Menlo on a Mac) and in its advance: drawn, a frame
 * joins up and a spinner turns the same in every preset, on every machine.
 */

export function isSymbol(cp: number): boolean {
  return (cp >= 0x2500 && cp <= 0x259f) || (cp >= 0x2800 && cp <= 0x28ff);
}

/**
 * Per box-drawing character from U+2500: its arms up, right, down, left (0 none, 1 light, 2 heavy, 3 double), then
 * a mark: `-` a straight one, `:` dashed, `a` an arc (rounded corner), `/` `\\` `x` the diagonals.
 */
const BOX = [
  '0101-', '0202-', '1010-', '2020-', '0101:', '0202:', '1010:', '2020:', '0101:', '0202:', '1010:', '2020:', // 2500
  '0110-', '0210-', '0120-', '0220-', '0011-', '0012-', '0021-', '0022-', '1100-', '1200-', '2100-', '2200-', // 250C
  '1001-', '1002-', '2001-', '2002-', '1110-', '1210-', '2110-', '1120-', '2120-', '2210-', '1220-', '2220-', // 2518
  '1011-', '1012-', '2011-', '1021-', '2021-', '2012-', '1022-', '2022-', '0111-', '0112-', '0211-', '0212-', // 2524
  '0121-', '0122-', '0221-', '0222-', '1101-', '1102-', '1201-', '1202-', '2101-', '2102-', '2201-', '2202-', // 2530
  '1111-', '1112-', '1211-', '1212-', '2111-', '1121-', '2121-', '2112-', '2211-', '1122-', '1221-', '2212-', // 253C
  '1222-', '2122-', '2221-', '2222-', '0101:', '0202:', '1010:', '2020:', '0303-', '3030-', '0310-', '0130-', // 2548
  '0330-', '0013-', '0031-', '0033-', '1300-', '3100-', '3300-', '1003-', '3001-', '3003-', '1310-', '3130-', // 2554
  '3330-', '1013-', '3031-', '3033-', '0313-', '0131-', '0333-', '1303-', '3101-', '3303-', '1313-', '3131-', // 2560
  '3333-', '0110a', '0011a', '1001a', '1100a', '0000/', '0000\\', '0000x', '0001-', '1000-', '0100-', '0010-', // 256C
  '0002-', '2000-', '0200-', '0020-', '0201-', '1020-', '0102-', '2010-', // 2578
];

/** Dashes per dashed character: ┄┅┆┇ three, ┈┉┊┋ four, ╌╍╎╏ two. */
const dashes = (cp: number) => (cp <= 0x2507 ? 3 : cp <= 0x250b ? 4 : 2);

const hex = (c: number) => `#${(c & 0xffffff).toString(16).padStart(6, '0')}`;
const mix = (a: number, b: number, k: number) => {
  const m = (s: number) => Math.round(((a >> s) & 255) * (1 - k) + ((b >> s) & 255) * k);
  return (m(16) << 16) | (m(8) << 8) | m(0);
};

/** Draws `cp` (an `isSymbol` one) in the cell at x, y (w × h px), in `fg` on `bg` (the shades mix the two). */
export function drawSymbol(g: Paint2D, cp: number, x: number, y: number, w: number, h: number, fg: number, bg: number): void {
  g.fillStyle = hex(fg);
  if (cp >= 0x2800) return braille(g, cp - 0x2800, x, y, w, h);
  if (cp >= 0x2580) return block(g, cp, x, y, w, h, fg, bg);
  box(g, cp, x, y, w, h, fg);
}

function box(g: Paint2D, cp: number, x: number, y: number, w: number, h: number, fg: number): void {
  const spec = BOX[cp - 0x2500];
  if (!spec) return;
  // Whole pixels, so a frame's lines are crisp and meet exactly from one cell to the next.
  const light = Math.max(1, Math.round(Math.min(w, h / 2) * 0.12));
  const heavy = light * 2;
  const cx = Math.floor(x + w / 2);
  const cy = Math.floor(y + h / 2);
  const mark = spec[4];
  if (mark === 'a') return arc(g, spec, x, y, w, h, cx, cy, light, fg);
  if (mark === '/' || mark === '\\' || mark === 'x') {
    g.strokeStyle = hex(fg);
    g.lineWidth = light;
    g.beginPath();
    if (mark !== '\\') {
      g.moveTo(x + w, y);
      g.lineTo(x, y + h);
    }
    if (mark !== '/') {
      g.moveTo(x, y);
      g.lineTo(x + w, y + h);
    }
    g.stroke();
    return;
  }
  if (mark === ':') {
    // One line across the cell in n dashes.
    const lw = spec.includes('2') ? heavy : light;
    const n = dashes(cp);
    if (spec[1] !== '0') segs(x, x + w, n, (a, b) => g.fillRect(a, Math.round(cy - lw / 2), b - a, lw));
    else segs(y, y + h, n, (a, b) => g.fillRect(Math.round(cx - lw / 2), a, lw, b - a));
    return;
  }
  const gap = Math.max(light + 1, Math.round(Math.min(w, h) * 0.18));
  // Arm k: 0 up, 1 right, 2 down, 3 left.
  for (let k = 0; k < 4; k++) {
    const kind = Number(spec[k]);
    if (!kind) continue;
    const lw = kind === 2 ? heavy : light;
    const offs = kind === 3 ? [-gap / 2, gap / 2] : [0];
    for (const off of offs) {
      // Double arms overshoot the centre by half the gap, so the corners of ╔ ╗ ╚ ╝ close.
      const over = kind === 3 ? Math.ceil(gap / 2) : Math.ceil(heavy / 2);
      if (k === 1 || k === 3) {
        const ly = Math.round(cy + off - lw / 2);
        const from = k === 1 ? cx - over : x;
        const to = k === 1 ? x + w : cx + over;
        g.fillRect(from, ly, to - from, lw);
      } else {
        const lx = Math.round(cx + off - lw / 2);
        const from = k === 2 ? cy - over : y;
        const to = k === 2 ? y + h : cy + over;
        g.fillRect(lx, from, lw, to - from);
      }
    }
  }
}

/** A line from a to b in n dashes with gaps between (each starting a dash's length apart, so cells tile). */
function segs(a: number, b: number, n: number, draw: (a: number, b: number) => void): void {
  const len = (b - a) / n;
  for (let i = 0; i < n; i++) draw(a + i * len, a + i * len + len * 0.6);
}

function arc(g: Paint2D, spec: string, x: number, y: number, w: number, h: number, cx: number, cy: number, lw: number, fg: number): void {
  const up = spec[0] !== '0';
  const right = spec[1] !== '0';
  const ex = right ? x + w : x;
  const ey = up ? y : y + h;
  const r = Math.min(w, h) / 2;
  const lx = cx + (lw % 2 ? 0.5 : 0);
  const ly = cy + (lw % 2 ? 0.5 : 0);
  g.strokeStyle = hex(fg);
  g.lineWidth = lw;
  g.beginPath();
  g.moveTo(lx, ey);
  g.arcTo(lx, ly, right ? lx + r : lx - r, ly, r);
  g.lineTo(ex, ly);
  g.stroke();
}

function block(g: Paint2D, cp: number, x: number, y: number, w: number, h: number, fg: number, bg: number): void {
  const rect = (fx: number, fy: number, fw: number, fh: number) => {
    const x0 = Math.round(x + w * fx);
    const y0 = Math.round(y + h * fy);
    g.fillRect(x0, y0, Math.round(x + w * (fx + fw)) - x0, Math.round(y + h * (fy + fh)) - y0);
  };
  if (cp === 0x2580) return rect(0, 0, 1, 0.5);
  if (cp >= 0x2581 && cp <= 0x2588) {
    const k = (cp - 0x2580) / 8;
    return rect(0, 1 - k, 1, k);
  }
  if (cp >= 0x2589 && cp <= 0x258f) return rect(0, 0, (8 - (cp - 0x2588)) / 8, 1);
  if (cp === 0x2590) return rect(0.5, 0, 0.5, 1);
  if (cp >= 0x2591 && cp <= 0x2593) {
    g.fillStyle = hex(mix(bg, fg, (cp - 0x2590) / 4));
    return rect(0, 0, 1, 1);
  }
  if (cp === 0x2594) return rect(0, 0, 1, 1 / 8);
  if (cp === 0x2595) return rect(7 / 8, 0, 1 / 8, 1);
  // Quadrants: upper left, upper right, lower left, lower right.
  const Q: Record<number, number> = { 0x2596: 0b0010, 0x2597: 0b0001, 0x2598: 0b1000, 0x2599: 0b1011, 0x259a: 0b1001, 0x259b: 0b1110, 0x259c: 0b1101, 0x259d: 0b0100, 0x259e: 0b0110, 0x259f: 0b0111 };
  const q = Q[cp] ?? 0;
  if (q & 0b1000) rect(0, 0, 0.5, 0.5);
  if (q & 0b0100) rect(0.5, 0, 0.5, 0.5);
  if (q & 0b0010) rect(0, 0.5, 0.5, 0.5);
  if (q & 0b0001) rect(0.5, 0.5, 0.5, 0.5);
}

/** Braille dots: bit i of the pattern is dot i+1 (1–3 and 7 down the left column, 4–6 and 8 down the right). */
const DOTS: ReadonlyArray<readonly [number, number]> = [
  [0, 0],
  [0, 1],
  [0, 2],
  [1, 0],
  [1, 1],
  [1, 2],
  [0, 3],
  [1, 3],
];

function braille(g: Paint2D, bits: number, x: number, y: number, w: number, h: number): void {
  const d = Math.max(1, Math.round(Math.min(w / 4, h / 8)));
  for (let i = 0; i < 8; i++) {
    if (!(bits & (1 << i))) continue;
    const [col, row] = DOTS[i] as readonly [number, number];
    g.fillRect(Math.round(x + w * (0.3 + 0.4 * col) - d / 2), Math.round(y + h * (0.14 + 0.24 * row) - d / 2), d, d);
  }
}
