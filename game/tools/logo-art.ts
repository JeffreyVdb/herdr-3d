// A neutral, made-up logo for tests, docs screenshots and the perf fixture: a
// ring next to three bars, on a transparent background (so it also shows that
// alpha survives). No third-party logo ships with the game.
//
// Plain erasable TypeScript: node runs it directly.
import { PNG } from 'pngjs';

export interface Palette {
  ring: [number, number, number];
  bars: Array<[number, number, number]>;
}

/** Distinct in hue from the scene's pastels, so a test can look for it in a screenshot. */
export const MAGENTA: Palette = { ring: [229, 48, 123], bars: [[15, 157, 154], [36, 64, 110], [242, 169, 59]] };

const SS = 3; // supersampling per axis

/** A `w` x `h` PNG (w >= 2h looks best) with the mark centred. */
export function logoPng(w = 720, h = 240, p: Palette = MAGENTA): Buffer {
  const png = new PNG({ width: w, height: h });
  const cy = h / 2;
  const r = h * 0.36;
  const thick = h * 0.13;
  const bw = h * 0.17;
  const gap = h * 0.09;
  // Ring, a space, three bars: centred as one mark.
  const span = 2 * r + thick + h * 0.28 + 3 * bw + 2 * gap;
  const left = (w - span) / 2;
  const cx = left + r + thick / 2;
  const bx0 = cx + r + h * 0.28;
  const heights = [0.34, 0.56, 0.78];
  const coverage = (x: number, y: number): [number, number, number] | null => {
    const d = Math.hypot(x - cx, y - cy);
    if (Math.abs(d - r) <= thick / 2) return p.ring;
    for (let i = 0; i < 3; i++) {
      const x0 = bx0 + i * (bw + gap);
      const hh = h * (heights[i] as number) * 0.8;
      if (x >= x0 && x <= x0 + bw && y >= cy + h * 0.4 - hh && y <= cy + h * 0.4) return p.bars[i] as [number, number, number];
    }
    return null;
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r0 = 0;
      let g0 = 0;
      let b0 = 0;
      let n = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const c = coverage(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS);
          if (!c) continue;
          r0 += c[0];
          g0 += c[1];
          b0 += c[2];
          n++;
        }
      }
      const i = (y * w + x) * 4;
      png.data[i] = n ? Math.round(r0 / n) : 0;
      png.data[i + 1] = n ? Math.round(g0 / n) : 0;
      png.data[i + 2] = n ? Math.round(b0 / n) : 0;
      png.data[i + 3] = Math.round((n / (SS * SS)) * 255);
    }
  }
  return PNG.sync.write(png);
}
