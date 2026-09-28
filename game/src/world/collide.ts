import type { Box3, Rect, Vec2 } from './layout';

const overlaps = (x: number, z: number, r: number, b: Rect) => x + r > b.x0 && x - r < b.x1 && z + r > b.z0 && z - r < b.z1;

/**
 * Moves a walker (a square of half-size `r` on the floor plane) by `delta`,
 * one axis at a time so it slides along walls instead of sticking to them.
 */
export function moveWithCollision(pos: Vec2, delta: Vec2, r: number, obstacles: readonly Rect[]): Vec2 {
  let { x, z } = pos;
  // Sub-step so a fast frame cannot tunnel through a thin wall.
  const steps = Math.max(1, Math.ceil(Math.max(Math.abs(delta.x), Math.abs(delta.z)) / (r * 0.9)));
  const sx = delta.x / steps;
  const sz = delta.z / steps;
  for (let i = 0; i < steps; i++) {
    x += sx;
    for (const b of obstacles) {
      if (!overlaps(x, z, r, b)) continue;
      x = sx > 0 ? b.x0 - r : sx < 0 ? b.x1 + r : x;
    }
    z += sz;
    for (const b of obstacles) {
      if (!overlaps(x, z, r, b)) continue;
      z = sz > 0 ? b.z0 - r : sz < 0 ? b.z1 + r : z;
    }
  }
  return { x, z };
}

/** True when a walker at `p` would overlap an obstacle. */
export function blocked(p: Vec2, r: number, obstacles: readonly Rect[]): boolean {
  return obstacles.some((b) => overlaps(p.x, p.z, r, b));
}

export type V3 = readonly [number, number, number];

/** Ray/AABB slab test: distance along a unit `dir`, or null on a miss. */
export function rayBox(o: V3, dir: V3, b: Box3): number | null {
  let tmin = 0;
  let tmax = Infinity;
  for (let a = 0; a < 3; a++) {
    const d = dir[a] as number;
    const oa = o[a] as number;
    const lo = b.min[a] as number;
    const hi = b.max[a] as number;
    if (Math.abs(d) < 1e-9) {
      if (oa < lo || oa > hi) return null;
      continue;
    }
    let t1 = (lo - oa) / d;
    let t2 = (hi - oa) / d;
    if (t1 > t2) [t1, t2] = [t2, t1];
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return null;
  }
  return tmin;
}

export interface Pickable<T> {
  boxes: readonly Box3[];
  value: T;
}

/** Nearest pickable hit within `maxDist`; blockers (walls) stop the ray without being picked. */
export function pickNearest<T>(
  o: V3,
  dir: V3,
  targets: ReadonlyArray<Pickable<T>>,
  maxDist: number,
  blockers: readonly Box3[] = [],
): { value: T; dist: number } | null {
  let limit = maxDist;
  for (const b of blockers) {
    const t = rayBox(o, dir, b);
    if (t !== null && t < limit) limit = t;
  }
  let best: { value: T; dist: number } | null = null;
  for (const p of targets) {
    for (const b of p.boxes) {
      const t = rayBox(o, dir, b);
      if (t !== null && t <= limit && (!best || t < best.dist)) best = { value: p.value, dist: t };
    }
  }
  return best;
}
