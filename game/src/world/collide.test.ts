import { describe, expect, it } from 'vitest';
import { blocked3, nudgeClear, type Solid, type WalkWorld } from './collide';

const R = 0.28;
const solid = (x0: number, z0: number, x1: number, z1: number): Solid => ({ x0, z0, x1, z1, y0: 0, y1: 1.1 });
const room = (...solids: Solid[]): WalkWorld => ({ supports: [{ x0: 0, z0: 0, x1: 10, z1: 10, y: 0 }], solids });

describe('nudgeClear', () => {
  it('steps out of a seat that appeared under the walker, to the nearest free spot, on the same floor', () => {
    // A seat (±0.3) at (5, 5) with a desk behind it (north): the free way out is the aisle (south).
    const w = room(solid(4.7, 4.7, 5.3, 5.3), solid(3.5, 3.4, 6.5, 4.3));
    const p = { x: 5, y: 0, z: 5 };
    expect(blocked3(p, R, w)).toBe(true);
    const q = nudgeClear(p, R, w, { x: 0, z: 1 });
    expect(q).not.toBeNull();
    const to = q as NonNullable<typeof q>;
    expect(blocked3(to, R, w)).toBe(false);
    expect(to.y).toBe(0);
    expect(Math.hypot(to.x - p.x, to.z - p.z)).toBeLessThan(0.7);
    expect(to.z).toBeGreaterThan(p.z);
    expect(to.x).toBeCloseTo(p.x, 5);
  });

  it('is null when nothing is free within reach (the caller falls back to the entrance)', () => {
    const w = room(solid(2, 2, 8, 8));
    expect(nudgeClear({ x: 5, y: 0, z: 5 }, R, w)).toBeNull();
    // Reach is a limit: a free spot beyond `max` does not count.
    expect(nudgeClear({ x: 5, y: 0, z: 5 }, R, w, undefined, 1)).toBeNull();
    expect(nudgeClear({ x: 5, y: 0, z: 5 }, R, w, undefined, 4)).not.toBeNull();
  });

  it('is null with no ground to stand on', () => {
    expect(nudgeClear({ x: 5, y: 0, z: 5 }, R, { supports: [], solids: [] })).toBeNull();
  });
});
