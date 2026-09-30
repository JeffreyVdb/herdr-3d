/**
 * Letterbox fit for a logo on a sign: the largest rectangle of the logo's
 * aspect that fits in the sign's box, centred; never stretched, never
 * enlarged beyond the box. Pure.
 */

export interface Fit {
  /** Size of the fitted image in the box's units. */
  w: number;
  h: number;
  /** Offset of its top-left corner from the box's top-left corner. */
  x: number;
  y: number;
}

const NONE: Fit = { w: 0, h: 0, x: 0, y: 0 };

/**
 * Fits an `iw` x `ih` image into a `bw` x `bh` box. Any size that is not a
 * positive finite number gives an empty fit (nothing to draw). `pad` is a
 * fraction of the box kept free on every side (0..0.45).
 */
export function letterbox(iw: number, ih: number, bw: number, bh: number, pad = 0): Fit {
  const ok = (n: number) => Number.isFinite(n) && n > 0;
  if (!ok(iw) || !ok(ih) || !ok(bw) || !ok(bh)) return NONE;
  const p = Number.isFinite(pad) ? Math.min(0.45, Math.max(0, pad)) : 0;
  const aw = bw * (1 - 2 * p);
  const ah = bh * (1 - 2 * p);
  const s = Math.min(aw / iw, ah / ih);
  const w = iw * s;
  const h = ih * s;
  return { w, h, x: (bw - w) / 2, y: (bh - h) / 2 };
}
