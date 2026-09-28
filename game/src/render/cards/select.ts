/** Which speech-bubble cards to show: nearest in view, faded with distance, capped. */

export interface P3 {
  x: number;
  y: number;
  z: number;
}

export interface Chosen {
  index: number;
  dist: number;
  alpha: number;
}

export interface CardRange {
  /** Fully opaque up to here (m). */
  near: number;
  /** Invisible from here (m). */
  far: number;
  /** At most this many cards. */
  cap: number;
}

export const CARD_RANGE: CardRange = { near: 7, far: 16, cap: 24 };

/**
 * Picks cards for anchors in front of the camera (within ~70° of `fwd`),
 * nearest first. `weight(i)` < 1 pulls a card closer (e.g. "needs you");
 * `occluded(i, d)` drops cards behind walls.
 * Returned nearest first.
 */
export function selectCards(
  cam: P3,
  fwd: P3,
  anchors: ReadonlyArray<P3 | null>,
  range: CardRange = CARD_RANGE,
  weight: (i: number) => number = () => 1,
  occluded: (i: number, dist: number) => boolean = () => false,
): Chosen[] {
  const out: Chosen[] = [];
  for (let i = 0; i < anchors.length; i++) {
    const a = anchors[i];
    if (!a) continue;
    const dx = a.x - cam.x;
    const dy = a.y - cam.y;
    const dz = a.z - cam.z;
    const d = Math.hypot(dx, dy, dz);
    if (d < 1e-6) continue;
    if ((dx * fwd.x + dy * fwd.y + dz * fwd.z) / d < 0.34) continue;
    const eff = d * weight(i);
    if (eff >= range.far) continue;
    if (occluded(i, d)) continue;
    const alpha = eff <= range.near ? 1 : 1 - (eff - range.near) / (range.far - range.near);
    out.push({ index: i, dist: eff, alpha: Math.round(alpha * 1000) / 1000 });
  }
  out.sort((a, b) => a.dist - b.dist || a.index - b.index);
  return out.slice(0, range.cap);
}
