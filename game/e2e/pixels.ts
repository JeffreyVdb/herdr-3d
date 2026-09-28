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
