/**
 * The building around the office floors, a pure function of its outline and
 * floor count: storeys, the lobby on the ground storey, the fire escape down
 * the west wall, and the bounded street strip. Coordinates are the office's
 * (x west → east, z north → south) with y absolute: the street and the lobby
 * floor at 0, floor `storey` (0 = bottom office floor) at `floorY(storey)`.
 *
 * Everything the walker touches is an axis-aligned `Support` (something to
 * stand on) or `Solid` (a height-ranged obstacle), see collide.ts.
 */

import type { Solid, Support, WalkWorld } from './collide';
import { ROOM_HEIGHT, WALL_T, type Box3, type Outline, type Rect, type Vec2 } from './layout';

/** The floor slab between storeys. */
export const SLAB = 0.3;
/** Floor to floor. The corner office (#20) raises it: keep it one constant. */
export const STOREY = ROOM_HEIGHT + SLAB;
/** The facade skin outside the office walls: the outer faces sit FACE outside the room. */
export const SKIN = 0.05;
export const FACE = WALL_T + SKIN;
/** Fire-escape stairs: 9 risers a flight, two flights a storey, 0.28 m treads. */
export const RISERS = 9;
export const RISE = STOREY / (2 * RISERS);
export const TREAD = 0.28;
export const LANE = 1.2;
export const RAIL_GAP = 0.12;
export const RAIL_T = 0.1;
export const RAIL_H = 1.1;
/** Walkable ground around the building: this far out on the west (fire escape) side, the north and east. */
const YARD_W = 8;
const YARD_N = 7;
const YARD_E = 7;
/** Front sidewalk depth, curb to facade. */
export const SIDEWALK = 6.5;
/** Road width in front of the sidewalk (backdrop). */
export const ROAD_W = 7.4;

/** Storey -1 is the lobby (street level), 0.. the office floors. */
export const floorY = (storey: number): number => (storey + 1) * STOREY;

export type Area = 'floor' | 'lobby' | 'fire-escape' | 'street';

export interface Place {
  area: Area;
  /** The floor you are on (area `floor`), or the landing's floor on the fire escape; else null. */
  storey: number | null;
}

export interface Tread {
  storey: number;
  flight: 1 | 2;
  /** 1-based along the flight, going down. */
  step: number;
  rect: Rect;
  y: number;
}

export interface FireEscape {
  /** Outer edge (west) and the facade (east edge) of the walkable part. */
  x0: number;
  x1: number;
  /** Inner lane (against the wall), centre rail, outer lane. */
  inner: { x0: number; x1: number };
  outer: { x0: number; x1: number };
  rail: { x0: number; x1: number };
  /** Landings outside each floor's door: z range. */
  landing: { z0: number; z1: number };
  /** Flights between landing and half landing: z range. */
  flights: { z0: number; z1: number };
  /** Half landings: z range. */
  half: { z0: number; z1: number };
  /** The doors (west wall) of every floor. */
  door: { z0: number; z1: number; height: number };
  treads: Tread[];
}

export interface LobbyLayout {
  /** Front door on the south wall (glass, sliding): x range. */
  front: { x0: number; x1: number; height: number };
  /** Reception desk (counter) and where the receptionist stands behind it, facing the door (+z). */
  desk: Rect;
  receptionist: Vec2;
  /** The feature wall behind the receptionist (the building's name is on it). */
  backWall: Rect;
  bench: Rect;
  plants: Vec2[];
  /** Elevator doors on the south wall (as on every floor). */
  elevator: Box3;
  /** Where the elevator lets you out, facing north. */
  spawn: { x: number; z: number; yaw: number };
  /** Walls (with the front doorway open) and furniture, walking obstacles at street level. */
  colliders: Rect[];
  /** Solid walls and glass for line of sight (picking). */
  walls: Box3[];
  /** Pick volume of the reception desk. */
  deskBox: Box3;
}

export interface BuildingPlan {
  width: number;
  depth: number;
  floors: number;
  /** Floor to floor (STOREY), for clients that place things by storey. */
  storey: number;
  /** Top of the roof slab. */
  roofY: number;
  escape: FireEscape;
  lobby: LobbyLayout;
  /** Elevator shaft on the south facade. */
  shaft: Rect;
  /** Ground you can walk on (inside the fences). */
  yard: Rect;
  /** Where the fences / hedges / bollards stand (x or z of each side). */
  fence: { west: number; north: number; east: number; curb: number };
  road: { z0: number; z1: number };
  lamps: Vec2[];
  trees: Vec2[];
  /** Everything static the walker touches (street, fire escape, shaft, fences, street furniture). */
  supports: Support[];
  solids: Solid[];
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;
const solid = (x0: number, z0: number, x1: number, z1: number, y0: number, y1: number): Solid => ({ x0, z0, x1, z1, y0, y1 });
const box = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): Box3 => ({ min: [x0, y0, z0], max: [x1, y1, z1] });

export function fireEscape(depth: number, floors: number, door: { z0: number; z1: number; height: number }): FireEscape {
  const x1 = -FACE;
  const inner = { x0: r3(x1 - LANE), x1 };
  const rail = { x0: r3(inner.x0 - RAIL_GAP), x1: inner.x0 };
  const outer = { x0: r3(rail.x0 - LANE), x1: rail.x0 };
  const landing = { z0: r3(door.z0 - 0.5), z1: r3(Math.min(depth - 0.2, door.z1 + 0.4)) };
  const flights = { z0: r3(landing.z0 - (RISERS - 1) * TREAD), z1: landing.z0 };
  const half = { z0: r3(flights.z0 - LANE), z1: flights.z0 };
  const treads: Tread[] = [];
  for (let s = 0; s < floors; s++) {
    const top = floorY(s);
    for (let i = 1; i < RISERS; i++) {
      // Flight 1: the outer lane, down northwards from the landing.
      treads.push({ storey: s, flight: 1, step: i, rect: { x0: outer.x0, x1: outer.x1, z0: r3(landing.z0 - i * TREAD), z1: r3(landing.z0 - (i - 1) * TREAD) }, y: top - i * RISE });
    }
    for (let j = 1; j < RISERS; j++) {
      // Flight 2: the inner lane, down southwards from the half landing to the landing below.
      treads.push({
        storey: s,
        flight: 2,
        step: j,
        rect: { x0: inner.x0, x1: inner.x1, z0: r3(flights.z0 + (j - 1) * TREAD), z1: r3(flights.z0 + j * TREAD) },
        y: top - RISERS * RISE - j * RISE,
      });
    }
  }
  return { x0: outer.x0, x1, inner, outer, rail, landing, flights, half, door, treads };
}

export function lobbyLayout(width: number, depth: number): LobbyLayout {
  const T = WALL_T;
  const H = ROOM_HEIGHT;
  const fx = r3(Math.max(3.2, width / 2 - 4.6));
  const front = { x0: r3(fx - 0.9), x1: r3(fx + 0.9), height: 2.4 };
  const desk: Rect = { x0: r3(fx - 1.6), z0: r3(depth - 5.6), x1: r3(fx + 1.6), z1: r3(depth - 4.8) };
  const receptionist = { x: fx, z: r3(depth - 6.15) };
  const backWall: Rect = { x0: r3(desk.x0 - 0.5), z0: r3(receptionist.z - 0.95), x1: r3(desk.x1 + 0.5), z1: r3(receptionist.z - 0.8) };
  const bench: Rect = { x0: r3(width / 2 + 3.2), z0: r3(depth - 1.15), x1: r3(width / 2 + 5.6), z1: r3(depth - 0.6) };
  const plants: Vec2[] = [
    { x: 0.7, z: 0.7 },
    { x: r3(width - 0.7), z: 0.7 },
    { x: r3(width - 0.7), z: r3(depth - 0.7) },
    { x: r3(front.x0 - 0.7), z: r3(depth - 0.6) },
    { x: r3(front.x1 + 0.7), z: r3(depth - 0.6) },
    { x: r3(desk.x1 + 0.7), z: r3(desk.z0 - 0.9) },
  ];
  const elevator = box(width / 2 - 1.1, 0, depth - 0.12, width / 2 + 1.1, 2.4, depth);
  const plantRects = plants.map((p) => ({ x0: p.x - 0.3, z0: p.z - 0.3, x1: p.x + 0.3, z1: p.z + 0.3 }));
  const colliders: Rect[] = [
    { x0: -FACE, z0: -FACE, x1: width + FACE, z1: 0 }, // north
    { x0: -FACE, z0: 0, x1: 0, z1: depth }, // west
    { x0: width, z0: 0, x1: width + FACE, z1: depth }, // east
    { x0: -FACE, z0: depth, x1: front.x0, z1: depth + FACE }, // south, west of the door
    { x0: front.x1, z0: depth, x1: width + FACE, z1: depth + FACE }, // south, east of the door
    desk,
    backWall,
    { x0: receptionist.x - 0.35, z0: receptionist.z - 0.35, x1: receptionist.x + 0.35, z1: receptionist.z + 0.35 },
    bench,
    ...plantRects,
  ];
  const walls = [
    box(-T, 0, -T, width + T, H, 0),
    box(-T, 0, 0, 0, H, depth),
    box(width, 0, 0, width + T, H, depth),
    box(-T, 0, depth, width + T, H, depth + T),
  ];
  return {
    front,
    desk,
    receptionist,
    backWall,
    bench,
    plants,
    elevator,
    spawn: { x: r3(width / 2), z: r3(depth - 1.3), yaw: 0 },
    colliders,
    walls,
    // The counter and the air over it, where you talk to the receptionist.
    deskBox: box(desk.x0, 0, desk.z0, desk.x1, 1.9, desk.z1),
  };
}

/** Lamp and tree spots along a line, skipping the stretches in `skip`. */
function along(from: number, to: number, pitch: number, skip: Array<[number, number]>): number[] {
  const out: number[] = [];
  for (let x = from; x <= to + 1e-6; x += pitch) if (!skip.some(([a, b]) => x > a && x < b)) out.push(r3(x));
  return out;
}

export function buildingPlan(outline: Outline, floors: number, door: { z0: number; z1: number; height: number }): BuildingPlan {
  const W = outline.width;
  const D = outline.depth;
  const n = Math.max(1, floors);
  const escape = fireEscape(D, n, door);
  const lobby = lobbyLayout(W, D);
  const shaft: Rect = { x0: r3(W / 2 - 1.4), z0: D, x1: r3(W / 2 + 1.4), z1: r3(D + FACE + 2.05) };
  const fence = { west: -YARD_W, north: -YARD_N, east: r3(W + YARD_E), curb: r3(D + SIDEWALK) };
  const yard: Rect = { x0: fence.west + 0.1, z0: fence.north + 0.1, x1: fence.east - 0.1, z1: fence.curb - 0.1 };
  const road = { z0: r3(fence.curb + 0.25), z1: r3(fence.curb + 0.25 + ROAD_W) };
  const roofY = r3(floorY(n - 1) + ROOM_HEIGHT + SLAB);

  const supports: Support[] = [{ ...yard, y: 0 }];
  const solids: Solid[] = [];
  const topRail = floorY(n - 1) + RAIL_H + 0.1;
  const ex0 = escape.outer.x0 - RAIL_T;
  for (let s = 0; s < n; s++) {
    const y = floorY(s);
    // Landing (both lanes), its doorway threshold, and the half landing below it.
    supports.push({ x0: escape.outer.x0, x1: escape.inner.x1, z0: escape.landing.z0, z1: escape.landing.z1, y });
    supports.push({ x0: escape.inner.x1, x1: 0, z0: door.z0, z1: door.z1, y });
    supports.push({ x0: escape.outer.x0, x1: escape.inner.x1, z0: escape.half.z0, z1: escape.half.z1, y: y - RISERS * RISE });
    // Landing south rail (open underneath at street level).
    solids.push(solid(ex0, escape.landing.z1, escape.inner.x1, escape.landing.z1 + RAIL_T, y - 0.2, y + RAIL_H));
  }
  for (const t of escape.treads) supports.push({ ...t.rect, y: t.y });
  // Outer and north rails, and the centre rail between the flights, all the way up.
  solids.push(solid(ex0, escape.half.z0, escape.outer.x0, escape.landing.z1 + RAIL_T, 0, topRail));
  solids.push(solid(ex0, escape.half.z0 - RAIL_T, escape.inner.x1, escape.half.z0, 0, topRail));
  solids.push(solid(escape.rail.x0, escape.flights.z0, escape.rail.x1, escape.flights.z1, 0, topRail));
  // At street level, a gate across the outer lane: you don't walk in under the flights.
  solids.push(solid(escape.outer.x0, escape.landing.z0 - 0.05, escape.outer.x1, escape.landing.z0 + 0.05, 0, RAIL_H));
  // The top landing's inner lane ends in a rail.
  solids.push(solid(escape.inner.x0, escape.landing.z0 - RAIL_T, escape.inner.x1, escape.landing.z0, floorY(n - 1) - 0.2, floorY(n - 1) + RAIL_H));
  // Elevator shaft, fences.
  solids.push(solid(shaft.x0, shaft.z0, shaft.x1, shaft.z1, 0, roofY + 1.5));
  solids.push(solid(fence.west - 0.1, fence.north, fence.west + 0.1, fence.curb, 0, 1.3));
  solids.push(solid(fence.west, fence.north - 0.3, fence.east, fence.north + 0.3, 0, 1.3));
  solids.push(solid(fence.east - 0.3, fence.north, fence.east + 0.3, fence.curb, 0, 1.3));
  solids.push(solid(fence.west, fence.curb - 0.1, fence.east, fence.curb + 0.1, 0, 1));

  // Street furniture on the front sidewalk: lamps and trees, clear of the doors.
  const zs = r3(D + SIDEWALK - 1.1);
  const skip: Array<[number, number]> = [
    [lobby.front.x0 - 1.4, lobby.front.x1 + 1.4],
    [shaft.x0 - 0.6, shaft.x1 + 0.6],
  ];
  const lampX = along(fence.west + 2.5, fence.east - 2, 9, skip);
  const lamps: Vec2[] = [...lampX.map((x) => ({ x, z: zs })), { x: r3(fence.west + 1.2), z: r3(escape.half.z0 - 3) }];
  const trees: Vec2[] = [
    ...along(fence.west + 7, fence.east - 3, 9, skip).map((x) => ({ x, z: zs })),
    ...along(1.5, W - 1, 6.5, []).map((x) => ({ x, z: r3(fence.north + 2.2) })),
    ...along(2, D - 2, 6.5, []).map((z) => ({ x: r3(fence.east - 2.2), z })),
  ];
  for (const l of lamps) solids.push(solid(l.x - 0.14, l.z - 0.14, l.x + 0.14, l.z + 0.14, 0, 4));
  for (const t of trees) solids.push(solid(t.x - 0.22, t.z - 0.22, t.x + 0.22, t.z + 0.22, 0, 3));

  return { width: W, depth: D, floors: n, storey: STOREY, roofY, escape, lobby, shaft, yard, fence, road, lamps, trees, supports, solids };
}

/** The storey you are on for a feet height (-1: the lobby). */
export function storeyAt(y: number): number {
  return Math.round(y / STOREY) - 1;
}

/** Which area a point (feet) is in; on a landing (or its doorway), that landing's floor. */
export function placeAt(p: { x: number; y: number; z: number }, plan: BuildingPlan): Place {
  const s = storeyAt(p.y);
  if (p.x >= 0 && p.x <= plan.width && p.z >= 0 && p.z <= plan.depth) {
    return s < 0 ? { area: 'lobby', storey: null } : { area: 'floor', storey: Math.min(s, plan.floors - 1) };
  }
  const e = plan.escape;
  if (p.x >= e.x0 - 0.2 && p.x < 0 && p.z >= e.half.z0 - 0.3 && p.z <= e.landing.z1 + 0.3 && p.y > 0.12) {
    const onLanding = s >= 0 && s < plan.floors && Math.abs(p.y - floorY(s)) < 0.12 && p.z >= e.landing.z0 - 0.05;
    return { area: 'fire-escape', storey: onLanding ? s : null };
  }
  return { area: 'street', storey: null };
}

export interface Loaded {
  /** The floor with an interior: its storey, walking obstacles (office coordinates) and room size. */
  storey: number;
  colliders: readonly Rect[];
}

/**
 * Everything the walker touches right now: the static building and street,
 * the lobby, the interior of the loaded floor (with its fire-escape doorway
 * open), and every other floor as a closed block.
 */
export function walkWorld(plan: BuildingPlan, loaded: Loaded | null): WalkWorld {
  const W = plan.width;
  const D = plan.depth;
  const supports: Support[] = [...plan.supports];
  const solids: Solid[] = [...plan.solids];
  for (const r of plan.lobby.colliders) solids.push(solid(r.x0, r.z0, r.x1, r.z1, 0, ROOM_HEIGHT));
  for (let s = 0; s < plan.floors; s++) {
    const y = floorY(s);
    if (loaded && loaded.storey === s) {
      supports.push({ x0: 0, z0: 0, x1: W, z1: D, y });
      for (const r of loaded.colliders) solids.push(solid(r.x0, r.z0, r.x1, r.z1, y, y + ROOM_HEIGHT));
      // The facade skin outside the office's own walls.
      solids.push(solid(-FACE, 0, -WALL_T, plan.escape.door.z0, y, y + ROOM_HEIGHT));
      solids.push(solid(-FACE, plan.escape.door.z1, -WALL_T, D, y, y + ROOM_HEIGHT));
    } else {
      solids.push(solid(-FACE, -FACE, W + FACE, D + FACE, y, y + ROOM_HEIGHT));
    }
  }
  return { supports, solids };
}
