/**
 * Routes for M4 (a worker leaving the building: from a desk on any floor to
 * that floor's fire-escape door, down the fire escape to the street, and
 * away along the front sidewalk) and M6c (a freelancer carrying its report
 * to the orchestrator's desk and back). Waypoints only, pure functions of the
 * layout; the walks are played by `render/arrivals.ts`. Between two waypoints
 * the way is straight and walkable (vitest checks it against the collision
 * world).
 */

import { groundAt } from './collide';
import { floorY, loadedFloor, RISE, RISERS, TREAD, walkWorld, type BuildingPlan } from './building';
import { dockSide } from './deskKit';
import { MEZZ_Y, seatRect, type FloorLayout, type Rect, type Vec2 } from './layout';

export interface Waypoint {
  x: number;
  y: number;
  z: number;
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;

/**
 * Where a report is handed over. `slot`: the orchestrator sits at a floor desk. `corner`: the game-only "corner
 * seat" (docs/decisions.md, M6c): the orchestrator (desk index `corner`, which fixes the side of its desk the tray
 * is on) sits in the corner office up the mezzanine stair.
 */
export type Dest = { slot: number } | { corner: number };

/** Half a walker's width: the collision world's square. */
const R = 0.28;
/** How far beside the orchestrator's chair the freelancer stands (chair 0.3 + walker 0.28 + elbow room). */
export const HAND_LATERAL = 0.8;
/** Walk-out: the grid cell the path planner works on, and the room it keeps round furniture on top of the walker's own half-width. */
const CELL = 0.2;
const MARGIN = 0.12;

export interface HandOver {
  /** Where the freelancer stands. */
  x: number;
  z: number;
  /** Floor level the spot is on, above this floor's own (0, or the mezzanine's). */
  up: number;
  /** The way it faces: at the orchestrator's chair. */
  yaw: number;
  /** The orchestrator's seat, the way its chair faces and how far it swivels (radians) to face the spot. */
  seat: Vec2;
  seatYaw: number;
  swivel: number;
  /** The side of the orchestrator's desk (+1 / -1 in desk space) its tray is on: the dock's, the pod's outer side. */
  side: 1 | -1;
}

const wrap = (a: number) => {
  let d = a % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
};

/**
 * The hand-over spot beside an orchestrator's chair: on the side of its desk where the tray is (the pod's outer
 * side, where the aisle is), level with the chair so it is clear of the chair and the desk. The chair swivels about
 * 90° towards the spot, that is, it never turns back into the desk; the spot is outside the chair's swing.
 */
export function handOver(layout: FloorLayout, to: Dest): HandOver | null {
  if ('corner' in to) {
    const o = layout.mezzanine.orch;
    // The desk art is the orchestrator's own slot's (its dock side); at the corner seat's yaw 0 the slot's +x is the world's +x.
    const side = dockSide(layout.slots[to.corner] ?? { index: to.corner, yaw: o.yaw });
    const x = r3(o.seat.x + side * HAND_LATERAL);
    return { x, z: o.seat.z, up: MEZZ_Y, yaw: Math.atan2(-side, 0), seat: o.seat, seatYaw: o.yaw, swivel: wrap(Math.atan2(side, 0) - o.yaw), side };
  }
  const s = layout.slots[to.slot];
  if (!s) return null;
  const side = dockSide(s);
  // Desk space +x in world: cos(yaw) (yaw 0 or π).
  const outer = side * Math.round(Math.cos(s.yaw));
  const x = r3(s.seat.x + outer * HAND_LATERAL);
  return { x, z: s.seat.z, up: 0, yaw: Math.atan2(-outer, 0), seat: s.seat, seatYaw: s.yaw, swivel: wrap(Math.atan2(outer, 0) - s.yaw), side };
}

export const reverseRoute = (r: readonly Waypoint[]): Waypoint[] => [...r].reverse();

// ---- the floor's walkable plan ------------------------------------------------------

const grow = (r: Rect, d: number): Rect => ({ x0: r.x0 - d, z0: r.z0 - d, x1: r.x1 + d, z1: r.z1 + d });
const inside = (r: Rect, x: number, z: number) => x > r.x0 && x < r.x1 && z > r.z0 && z < r.z1;

/** A level to plan a walk on: its bounds and what stands on it. */
interface Level {
  bounds: Rect;
  obstacles: Rect[];
}

/** The floor: walls, desks, props, the mezzanine's posts and stair, and every seat but `free`. */
function floorLevel(layout: FloorLayout, free: ReadonlySet<number>): Level {
  const obstacles: Rect[] = [...layout.colliders];
  for (const b of layout.mezzanine.solids) if (b.y0 <= 0.01) obstacles.push({ x0: b.x0, z0: b.z0, x1: b.x1, z1: b.z1 });
  for (const s of layout.slots) if (!free.has(s.index)) obstacles.push(seatRect(s));
  return { bounds: { x0: 0, z0: 0, x1: layout.width, z1: layout.depth }, obstacles };
}

/** The corner office: its glass, desks, chair and plant (the walls close the bounds). */
function mezzLevel(layout: FloorLayout): Level {
  const m = layout.mezzanine;
  const T = 1;
  const { x0, z0, x1, z1 } = m.rect;
  const obstacles: Rect[] = m.solids.filter((b) => b.y0 >= m.y - 0.01).map((b) => ({ x0: b.x0, z0: b.z0, x1: b.x1, z1: b.z1 }));
  // Walls round it (the south side is the glass and the stair's door).
  obstacles.push({ x0: x0 - T, z0: z0 - T, x1: x0, z1: z1 + T }, { x0: x1, z0: z0 - T, x1: x1 + T, z1: z1 + T }, { x0: x0 - T, z0: z0 - T, x1: x1 + T, z1: z0 });
  return { bounds: m.rect, obstacles };
}

/** Straight and clear: no point along a → b (every 5 cm) is within `r` of an obstacle. */
function clear(a: Vec2, b: Vec2, grown: readonly Rect[]): boolean {
  const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / 0.05));
  const near = grown.filter((g) => g.x1 > Math.min(a.x, b.x) && g.x0 < Math.max(a.x, b.x) && g.z1 > Math.min(a.z, b.z) && g.z0 < Math.max(a.z, b.z));
  for (let i = 0; i <= n; i++) {
    const x = a.x + ((b.x - a.x) * i) / n;
    const z = a.z + ((b.z - a.z) * i) / n;
    if (near.some((g) => inside(g, x, z))) return false;
  }
  return true;
}

/** A binary min-heap of cell ids by priority. */
class Heap {
  private readonly ids: number[] = [];
  private readonly pri: number[] = [];
  get size(): number {
    return this.ids.length;
  }
  push(id: number, p: number): void {
    let i = this.ids.length;
    this.ids.push(id);
    this.pri.push(p);
    while (i > 0) {
      const up = (i - 1) >> 1;
      if ((this.pri[up] as number) <= p) break;
      this.ids[i] = this.ids[up] as number;
      this.pri[i] = this.pri[up] as number;
      i = up;
    }
    this.ids[i] = id;
    this.pri[i] = p;
  }
  pop(): number {
    const top = this.ids[0] as number;
    const id = this.ids.pop() as number;
    const p = this.pri.pop() as number;
    const n = this.ids.length;
    if (n) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && (this.pri[c + 1] as number) < (this.pri[c] as number)) c++;
        if ((this.pri[c] as number) >= p) break;
        this.ids[i] = this.ids[c] as number;
        this.pri[i] = this.pri[c] as number;
        i = c;
      }
      this.ids[i] = id;
      this.pri[i] = p;
    }
    return top;
  }
}

/**
 * A straight-segment path across the floor from `a` to `b` round the furniture: A* on a 20 cm grid that keeps the
 * walker's width plus a hand's breadth off every obstacle, pulled tight into as few straight segments as stay clear.
 * Includes both ends; null when there is no way.
 */
export function floorPath(layout: FloorLayout, a: Vec2, b: Vec2, free: ReadonlySet<number> = new Set()): Vec2[] | null {
  return levelPath(floorLevel(layout, free), a, b);
}

function levelPath(level: Level, a: Vec2, b: Vec2): Vec2[] | null {
  const obs = level.obstacles;
  const { x0: ox, z0: oz } = level.bounds;
  const wide = obs.map((r) => grow(r, R + MARGIN));
  const tight = obs.map((r) => grow(r, R + 0.03));
  if (clear(a, b, tight)) return [a, b];
  const nx = Math.ceil((level.bounds.x1 - ox) / CELL);
  const nz = Math.ceil((level.bounds.z1 - oz) / CELL);
  const blockedCell = new Uint8Array(nx * nz);
  for (const g of wide) {
    const i0 = Math.max(0, Math.floor((g.x0 - ox) / CELL));
    const i1 = Math.min(nx - 1, Math.floor((g.x1 - ox) / CELL));
    const j0 = Math.max(0, Math.floor((g.z0 - oz) / CELL));
    const j1 = Math.min(nz - 1, Math.floor((g.z1 - oz) / CELL));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) if (inside(g, ox + (i + 0.5) * CELL, oz + (j + 0.5) * CELL)) blockedCell[j * nx + i] = 1;
  }
  const cellOf = (p: Vec2) => ({ i: Math.min(nx - 1, Math.max(0, Math.floor((p.x - ox) / CELL))), j: Math.min(nz - 1, Math.max(0, Math.floor((p.z - oz) / CELL))) });
  // The nearest free cell to a point (the ends may stand inside the margin: a chair's back, a spot beside a desk).
  const freeNear = (p: Vec2): number => {
    const c = cellOf(p);
    for (let r = 0; r < 12; r++) {
      let best = -1;
      let bd = Infinity;
      for (let j = c.j - r; j <= c.j + r; j++)
        for (let i = c.i - r; i <= c.i + r; i++) {
          if (i < 0 || j < 0 || i >= nx || j >= nz || Math.max(Math.abs(i - c.i), Math.abs(j - c.j)) !== r || blockedCell[j * nx + i]) continue;
          const d = Math.hypot(ox + (i + 0.5) * CELL - p.x, oz + (j + 0.5) * CELL - p.z);
          if (d < bd) {
            bd = d;
            best = j * nx + i;
          }
        }
      if (best >= 0) return best;
    }
    return -1;
  };
  const start = freeNear(a);
  const goal = freeNear(b);
  if (start < 0 || goal < 0) return null;
  const gi = goal % nx;
  const gj = Math.floor(goal / nx);
  const h = (id: number) => {
    const dx = Math.abs((id % nx) - gi);
    const dz = Math.abs(Math.floor(id / nx) - gj);
    return (dx + dz + (Math.SQRT2 - 2) * Math.min(dx, dz)) * CELL;
  };
  const cost = new Float32Array(nx * nz).fill(Infinity);
  const from = new Int32Array(nx * nz).fill(-1);
  const heap = new Heap();
  cost[start] = 0;
  heap.push(start, h(start));
  while (heap.size) {
    const cur = heap.pop();
    if (cur === goal) break;
    const ci = cur % nx;
    const cj = Math.floor(cur / nx);
    for (let dj = -1; dj <= 1; dj++)
      for (let di = -1; di <= 1; di++) {
        if (!di && !dj) continue;
        const i = ci + di;
        const j = cj + dj;
        if (i < 0 || j < 0 || i >= nx || j >= nz || blockedCell[j * nx + i]) continue;
        // No cutting a corner of a blocked cell.
        if (di && dj && (blockedCell[cj * nx + i] || blockedCell[j * nx + ci])) continue;
        const id = j * nx + i;
        const c = (cost[cur] as number) + (di && dj ? Math.SQRT2 : 1) * CELL;
        if (c < (cost[id] as number)) {
          cost[id] = c;
          from[id] = cur;
          heap.push(id, c + h(id));
        }
      }
  }
  if ((from[goal] as number) < 0 && goal !== start) return null;
  const cells: Vec2[] = [];
  for (let id = goal; id >= 0; id = from[id] as number) cells.push({ x: ox + ((id % nx) + 0.5) * CELL, z: oz + (Math.floor(id / nx) + 0.5) * CELL });
  cells.reverse();
  // The exact ends, then pulled tight: from each point on to the farthest one in a straight clear line.
  const pts: Vec2[] = [a, ...cells, b];
  const out: Vec2[] = [a];
  let at = 0;
  while (at < pts.length - 1) {
    let next = at + 1;
    for (let k = pts.length - 1; k > at + 1; k--) {
      if (clear(pts[at] as Vec2, pts[k] as Vec2, tight)) {
        next = k;
        break;
      }
    }
    out.push(pts[next] as Vec2);
    at = next;
  }
  return out;
}

// ---- the corner office --------------------------------------------------------------

/**
 * From the foot of the mezzanine stair to the spot beside the corner orchestrator's chair: up the stair, through
 * the glass door, then round its desk to the spot (the chair is at the spot's side only when it is on the east).
 */
function cornerLeg(layout: FloorLayout, fy: number, spot: HandOver): Waypoint[] {
  const m = layout.mezzanine;
  const xs = r3((m.stair.x0 + m.stair.x1) / 2);
  const top = m.stair.treads.at(-1);
  const wp = (x: number, z: number, y: number): Waypoint => ({ x: r3(x), y: r3(y), z: r3(z) });
  const door = { x: xs, z: m.door.z - 0.5 };
  const way = levelPath(mezzLevel(layout), door, spot) ?? [door, spot];
  return [
    wp(xs, m.stair.bottom + 0.8, fy),
    wp(xs, m.stair.bottom + 0.05, fy),
    wp(xs, m.stair.top + 0.14, fy + (top?.y ?? m.y)),
    wp(door.x, door.z, fy + m.y),
    ...way.slice(1).map((p) => wp(p.x, p.z, fy + m.y)),
  ];
}

/** Where the corner leg meets the floor. */
const stairFoot = (leg: readonly Waypoint[]): Vec2 => ({ x: (leg[0] as Waypoint).x, z: (leg[0] as Waypoint).z });

/** The aisle behind a chair: out of the pod, on the side away from its desk. */
function behind(layout: FloorLayout, desk: number): Vec2 | null {
  const slot = layout.slots[desk];
  if (!slot) return null;
  const out = slot.yaw === 0 ? -1 : 1;
  return { x: slot.seat.x, z: slot.seat.z + out * (0.3 + 0.8) };
}

/**
 * M6c: the freelancer's way from its desk to where it hands its report over (`handOver`): out of the pod into the
 * aisle behind its chair, along the aisles, in to the spot beside the orchestrator's chair. To a corner office: to
 * the foot of the stair, up it, through the glass door and along the east wall. Every segment is straight and
 * walkable against the collision world with the other chairs in their places. Heights are this floor's own
 * (`storey`'s). `[]` when there is no way. The way back is `reverseRoute` of it.
 */
export function deskToDeskRoute(layout: FloorLayout, storey: number, from: number, to: Dest): Waypoint[] {
  const slot = layout.slots[from];
  const spot = handOver(layout, to);
  const aisle = behind(layout, from);
  if (!slot || !spot || !aisle || storey < 0) return [];
  const fy = floorY(storey);
  const wp = (p: Vec2, y = fy): Waypoint => ({ x: r3(p.x), y: r3(y), z: r3(p.z) });
  const route: Waypoint[] = [wp(slot.seat), wp(aisle)];
  if ('corner' in to) {
    const leg = cornerLeg(layout, fy, spot);
    const path = floorPath(layout, aisle, stairFoot(leg), new Set([from]));
    if (!path) return [];
    route.push(...path.slice(1).map((p) => wp(p)), ...leg.slice(1));
    return route;
  }
  const path = floorPath(layout, aisle, spot, new Set([from]));
  if (!path) return [];
  route.push(...path.slice(1).map((p) => wp(p)));
  return route;
}

/**
 * #223: where a worker stands to file a handoff: in front of the filing cabinet (it stands against the east wall and
 * faces west), facing it; where its hand holds the folder and where the folder goes in (the top drawer's slot). Null
 * without a cabinet.
 */
export function cabinetSpot(layout: FloorLayout): { x: number; z: number; yaw: number; hand: Waypoint; drop: Waypoint } | null {
  const c = layout.props.find((p) => p.id === 'filing');
  if (!c) return null;
  const [x0, , z0] = c.box.min;
  const [, y1, z1] = c.box.max;
  const z = r3((z0 + z1) / 2);
  const x = r3(x0 - (R + 0.22));
  return { x, z, yaw: Math.atan2(1, 0), hand: { x: r3(x + 0.32), y: 0.98, z }, drop: { x: r3(x0 + 0.12), y: r3(y1 - 0.12), z } };
}

/**
 * #223: a worker's way from its desk to the filing cabinet (`cabinetSpot`): out of the pod into the aisle behind its
 * chair, along the aisles to the spot. Straight, walkable segments, like `deskToDeskRoute`; `[]` when there is no way.
 * The way back is `reverseRoute` of it.
 */
export function deskToCabinetRoute(layout: FloorLayout, storey: number, from: number): Waypoint[] {
  const slot = layout.slots[from];
  const spot = cabinetSpot(layout);
  const aisle = behind(layout, from);
  if (!slot || !spot || !aisle || storey < 0) return [];
  const fy = floorY(storey);
  const wp = (p: Vec2): Waypoint => ({ x: r3(p.x), y: r3(fy), z: r3(p.z) });
  const path = floorPath(layout, aisle, spot, new Set([from]));
  if (!path) return [];
  return [wp(slot.seat), wp(aisle), ...path.slice(1).map((p) => wp(p))];
}

// ---- the way out ----------------------------------------------------------------------

/**
 * Walk-out route for M4: from the desk (M6c: or from `from`, a standing worker's position, e.g. mid-delivery) to
 * the floor's fire-escape door, down the fire escape and away along the sidewalk. `from.corner`: it stands up in the
 * corner office (the desk index of the orchestrator whose tray it is at).
 */
export function walkOutRoute(layout: FloorLayout, plan: BuildingPlan, storey: number, desk: number, from?: Waypoint & { corner?: number }): Waypoint[] {
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
  if (from) {
    at(from.x, from.z, from.y);
    // On the mezzanine or its stair: back down the way up (the corner leg, from the nearest point of it).
    let foot: Vec2 = { x: from.x, z: from.z };
    if (from.y > fy + 0.3) {
      const spot = handOver(layout, { corner: from.corner ?? 0 }) as HandOver;
      const leg = cornerLeg(layout, fy, spot);
      let best = 0;
      let bd = Infinity;
      for (let i = 0; i < leg.length - 1; i++) {
        const a = leg[i] as Waypoint;
        const b = leg[i + 1] as Waypoint;
        const len2 = (b.x - a.x) ** 2 + (b.z - a.z) ** 2;
        const k = len2 ? Math.min(1, Math.max(0, ((from.x - a.x) * (b.x - a.x) + (from.z - a.z) * (b.z - a.z)) / len2)) : 0;
        const d = Math.hypot(a.x + (b.x - a.x) * k - from.x, a.z + (b.z - a.z) * k - from.z);
        if (d < bd) {
          bd = d;
          best = i;
        }
      }
      for (let i = best; i >= 0; i--) {
        const w = leg[i] as Waypoint;
        at(w.x, w.z, w.y);
      }
      foot = stairFoot(leg);
    }
    const way = floorPath(layout, foot, { x: corridor, z: strip }, new Set([desk]));
    for (const p of (way ?? [foot, { x: corridor, z: strip }]).slice(1)) at(p.x, p.z, fy);
  } else {
    at(slot.seat.x, slot.seat.z, fy);
    at(slot.seat.x, aisle, fy);
    at(corridor, aisle, fy);
    at(corridor, strip, fy);
  }
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

  // Snap every waypoint to the ground actually there (the treads' exact heights); a start off the floor keeps its own height.
  const world = walkWorld(plan, loadedFloor(layout, storey));
  return pts.map(([x, y, z], i) => (from && i === 0 ? { x, y, z } : { x, y: groundAt(world.supports, x, z, y + 0.05) ?? y, z }));
}
