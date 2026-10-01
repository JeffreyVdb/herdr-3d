/** Summary statistics of an RGBA pixel buffer (luma, 0..255). */
export interface PixelStats {
  mean: number;
  variance: number;
  distinctColors: number;
}

export function pixelStats(rgba: Uint8Array | Uint8ClampedArray): PixelStats {
  const n = Math.floor(rgba.length / 4);
  if (n === 0) return { mean: 0, variance: 0, distinctColors: 0 };
  let sum = 0;
  let sumSq = 0;
  const colors = new Set<number>();
  for (let i = 0; i < n; i++) {
    const r = rgba[i * 4] ?? 0;
    const g = rgba[i * 4 + 1] ?? 0;
    const b = rgba[i * 4 + 2] ?? 0;
    const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    sum += y;
    sumSq += y * y;
    colors.add((r << 16) | (g << 8) | b);
  }
  const mean = sum / n;
  return { mean, variance: sumSq / n - mean * mean, distinctColors: colors.size };
}

/** A rectangle of the image in pixels: [x0, y0) to [x1, y1). */
export type Rect = readonly [x0: number, y0: number, x1: number, y1: number];

/**
 * Vertical-stripe score of a rectangle: the mean, per pixel row, of the times the luma turns back on itself by at
 * least `amp` levels going left to right. A flat or smoothly lit surface scores 0; a single shadow edge crossing a row
 * adds at most a turn or two; shadow acne, texel-wide bands, adds one per band, tens along a row.
 */
export function stripeScore(rgba: Uint8Array | Uint8ClampedArray, width: number, [x0, y0, x1, y1]: Rect, amp = 1): number {
  const luma = (x: number, y: number) => {
    const i = (y * width + x) * 4;
    return 0.2126 * (rgba[i] ?? 0) + 0.7152 * (rgba[i + 1] ?? 0) + 0.0722 * (rgba[i + 2] ?? 0);
  };
  let turns = 0;
  for (let y = y0; y < y1; y++) {
    let prev = luma(x0, y);
    let dir = 0;
    for (let x = x0 + 1; x < x1; x++) {
      const v = luma(x, y);
      if (Math.abs(v - prev) < amp) continue;
      const s = Math.sign(v - prev);
      if (dir !== 0 && s !== dir) turns++;
      dir = s;
      prev = v;
    }
  }
  return y1 > y0 ? turns / (y1 - y0) : 0;
}
