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
/** #20: up on the mezzanine the whole floor's cards show (the atlas has an instance per desk). */
export const OVERLOOK_CARD_RANGE: CardRange = { ...CARD_RANGE, cap: Infinity };
/** #20: cards are measured from the mezzanine as though you stood this much nearer (distance x this). */
export const OVERLOOK_CARD_SCALE = 0.45;

/** Distance weight of a desk's card: nearer for "needs you"; from the mezzanine, everything reads as nearer (#20). */
export function cardWeight(needsYou: boolean, overlook: boolean): number {
  return (needsYou ? 0.7 : 1) * (overlook ? OVERLOOK_CARD_SCALE : 1);
}

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
