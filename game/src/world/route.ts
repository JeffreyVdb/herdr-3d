/**
 * Walk-out route for M4 (a worker leaving the building): from a desk on any
 * floor to that floor's fire-escape door, down the fire escape to the
 * street, and away along the front sidewalk. Waypoints only, a pure function
 * of the layout; M4 plays the walk. Between two waypoints the way is straight
 * and walkable (vitest checks it against the collision world).
 */

import { groundAt } from './collide';
import { floorY, RISE, RISERS, TREAD, walkWorld, type BuildingPlan } from './building';
import { type FloorLayout } from './layout';

export interface Waypoint {
  x: number;
  y: number;
  z: number;
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;

export function walkOutRoute(layout: FloorLayout, plan: BuildingPlan, storey: number, desk: number): Waypoint[] {
  const slot = layout.slots[desk];
  if (!slot || storey < 0 || storey >= plan.floors) return [];
  const e = plan.escape;
  const D = layout.depth;
  const fy = floorY(storey);
  const pts: Array<[number, number, number]> = [];
  const at = (x: number, z: number, y: number) => pts.push([r3(x), r3(y), r3(z)]);

  // Out of the pod into the aisle behind the chair (north rows face south, so out is north).
  const out = slot.yaw === 0 ? -1 : 1;
  const aisle = slot.seat.z + out * (0.3 + 0.8);
  // The corridor between the lounge and the desk grid, then the open strip north of the board wall.
  const corridor = (layout.rug.x1 + layout.deskArea.x0) / 2;
  const strip = D - 5;
  const west = Math.max(0.9, layout.boardWall.x0 / 2);
  const dz = (e.door.z0 + e.door.z1) / 2;
  at(slot.seat.x, slot.seat.z, fy);
  at(slot.seat.x, aisle, fy);
  at(corridor, aisle, fy);
  at(corridor, strip, fy);
  at(west, strip, fy);
  at(west, dz, fy);
  const xi = (e.inner.x0 + e.inner.x1) / 2;
  const xo = (e.outer.x0 + e.outer.x1) / 2;
  const halfZ = (e.half.z0 + e.half.z1) / 2;
  for (let s = storey; s >= 0; s--) {
    const y = floorY(s);
    // Across the landing to the outer lane, down flight 1, round the half landing, down flight 2.
    at(xi, dz, y);
    at(xo, e.landing.z0 + 0.35, y);
    at(xo, e.landing.z0 - TREAD / 2, y - RISE);
    at(xo, e.flights.z0 + TREAD / 2, y - (RISERS - 1) * RISE);
    at(xo, halfZ, y - RISERS * RISE);
    at(xi, halfZ, y - RISERS * RISE);
    at(xi, e.flights.z0 + TREAD / 2, y - (RISERS + 1) * RISE);
    at(xi, e.landing.z0 - TREAD / 2, y - (2 * RISERS - 1) * RISE);
  }
  // Street level under the bottom landing, out past it to the front sidewalk, and away east.
  const front = D + 3.6;
  at(xi, e.landing.z0 + 0.35, 0);
  at(xi, e.landing.z1 + 0.6, 0);
  at(xi - 0.6, front, 0);
  at(plan.fence.east - 1.5, front, 0);

  // Snap every waypoint to the ground actually there (the treads' exact heights).
  const world = walkWorld(plan, { storey, colliders: layout.colliders });
  return pts.map(([x, y, z]) => ({ x, y: groundAt(world.supports, x, z, y + 0.05) ?? y, z }));
}
