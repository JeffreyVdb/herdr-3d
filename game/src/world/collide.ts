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

// ---- height-aware walking (M3b) ------------------------------------------------

/** A height-ranged obstacle: blocks a walker whose body overlaps it. */
export interface Solid {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  y0: number;
  y1: number;
}

/** Something to stand on: a rectangle whose top is at `y` (a floor, a landing, a stair tread, the sidewalk). */
export interface Support {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  y: number;
}

export interface WalkWorld {
  supports: readonly Support[];
  solids: readonly Solid[];
}

export interface V3p {
  x: number;
  y: number;
  z: number;
}

/** Highest step up a walker takes without noticing (a stair riser is ~0.18 m). */
export const STEP_UP = 0.35;
/** Largest step down: anything deeper is an edge, and you don't walk off it. */
export const MAX_DROP = 0.35;
/** Walker body height for obstacles (the head clears ~1.8 m). */
export const BODY_H = 1.8;

/**
 * Ground under (x, z) for a walker whose feet are at `feet`: the highest
 * support no more than a step up. Null when there is nothing within a step
 * up (over the void, or only things far above).
 */
export function groundAt(supports: readonly Support[], x: number, z: number, feet: number): number | null {
  let g: number | null = null;
  for (const s of supports) {
    if (x < s.x0 || x > s.x1 || z < s.z0 || z > s.z1) continue;
    if (s.y > feet + STEP_UP) continue;
    if (g === null || s.y > g) g = s.y;
  }
  return g;
}

const hits = (x: number, z: number, r: number, g: number, b: Solid) =>
  x + r > b.x0 && x - r < b.x1 && z + r > b.z0 && z - r < b.z1 && b.y1 > g + STEP_UP && b.y0 < g + BODY_H;

/** True when a walker standing at `p` (feet on its ground) overlaps a solid, or has no ground. */
export function blocked3(p: V3p, r: number, w: WalkWorld): boolean {
  const g = groundAt(w.supports, p.x, p.z, p.y);
  if (g === null || g < p.y - MAX_DROP) return true;
  return w.solids.some((b) => hits(p.x, p.z, r, g, b));
}

/**
 * Moves a walker (a square of half-size `r`, feet at `pos.y`) by `delta` on
 * the ground: one axis at a time so it slides along walls, stepping up at most
 * STEP_UP and down at most MAX_DROP. A solid stops it flush against its face;
 * an edge (no ground within a step) stops it where it stands. Solids only
 * count between a step above the feet and the head, so a stair flight never
 * blocks the landing a storey above it.
 */
export function moveWalker(pos: V3p, delta: Vec2, r: number, w: WalkWorld): V3p {
  let { x, y, z } = pos;
  const steps = Math.max(1, Math.ceil(Math.max(Math.abs(delta.x), Math.abs(delta.z)) / (r * 0.5)));
  const sx = delta.x / steps;
  const sz = delta.z / steps;
  const axis = (dx: number, dz: number) => {
    let nx = x + dx;
    let nz = z + dz;
    let g = groundAt(w.supports, nx, nz, y);
    if (g === null || g < y - MAX_DROP) return;
    for (const b of w.solids) {
      if (!hits(nx, nz, r, g, b)) continue;
      if (dx > 0) nx = b.x0 - r;
      else if (dx < 0) nx = b.x1 + r;
      if (dz > 0) nz = b.z0 - r;
      else if (dz < 0) nz = b.z1 + r;
      g = groundAt(w.supports, nx, nz, y);
      if (g === null || g < y - MAX_DROP) return;
    }
    // Pushed back past where we started (a solid we were already touching): stay.
    if ((dx > 0 && nx < x) || (dx < 0 && nx > x) || (dz > 0 && nz < z) || (dz < 0 && nz > z)) return;
    if (w.solids.some((b) => hits(nx, nz, r, g as number, b))) return;
    x = nx;
    z = nz;
    y = g;
  };
  for (let i = 0; i < steps; i++) {
    if (sx) axis(sx, 0);
    if (sz) axis(0, sz);
  }
  return { x, y, z };
}
