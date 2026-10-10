import { describe, expect, it } from 'vitest';
import { blocked3, moveWalker, type V3p, type WalkWorld } from './collide';
import { buildingPlan, floorY, loadedFloor, walkWorld, type BuildingPlan } from './building';
import { floorLayout, MEZZ_Y, outlineOf, seatRect, type FloorLayout } from './layout';
import { cabinetSpot, deskToCabinetRoute, deskToDeskRoute, handOver, HAND_LATERAL, reverseRoute, walkOutRoute, type Dest, type Waypoint } from './route';

const R = 0.28;
const counts = [20, 10, 16];
const outline = outlineOf(counts);
const floors: FloorLayout[] = counts.map((n) => floorLayout(n, outline));
const plan: BuildingPlan = buildingPlan(outline, counts.length, floors[0]!.fireDoor);

/** The floor `storey` of the demo building, as walked with every chair but `free` in its place. */
function worldWith(L: FloorLayout, storey: number, free: number[]): WalkWorld {
  const w = walkWorld(plan, loadedFloor(L, storey));
  const y = floorY(storey);
  const others = L.slots.filter((s) => !free.includes(s.index)).map(seatRect);
  return { supports: w.supports, solids: [...w.solids, ...others.map((r) => ({ ...r, y0: y, y1: y + 3 }))] };
}

function walk(w: WalkWorld, from: V3p, to: { x: number; z: number }, stepLen = 0.03): V3p {
  let p = from;
  for (let i = 0; i < 4000; i++) {
    const dx = to.x - p.x;
    const dz = to.z - p.z;
    const d = Math.hypot(dx, dz);
    if (d < 1e-3) break;
    const k = Math.min(1, stepLen / d);
    const next = moveWalker(p, { x: dx * k, z: dz * k }, R, w);
    if (next.x === p.x && next.z === p.z) break;
    p = next;
  }
  return p;
}

/** Walks a route leg by leg against the collision world; every leg must end where it should. */
function expectWalkable(route: Waypoint[], w: WalkWorld, what: string): void {
  let p: V3p = route[0]!;
  for (const next of route.slice(1)) {
    const end = walk(w, p, next);
    expect(Math.hypot(end.x - next.x, end.z - next.z), `${what} to ${JSON.stringify(next)}`).toBeLessThan(0.03);
    expect(end.y, `${what} height at ${JSON.stringify(next)}`).toBeCloseTo(next.y, 1);
    p = { ...end, y: next.y };
  }
}

describe('handOver', () => {
  it('stands beside the chair on the pod’s outer side, clear of the chair and the desk, facing the chair', () => {
    for (const L of floors) {
      for (const s of L.slots) {
        const h = handOver(L, { slot: s.index })!;
        expect(h.up).toBe(0);
        expect(Math.hypot(h.x - s.seat.x, h.z - s.seat.z)).toBeCloseTo(HAND_LATERAL, 2);
        // Clear of this chair (walker + chair half-widths), and nobody else's.
        const w = worldWith(L, 0, [s.index]);
        expect(blocked3({ x: h.x, y: floorY(0), z: h.z }, R, { supports: w.supports, solids: [...w.solids, ...L.slots.map(seatRect).map((r) => ({ ...r, y0: 0, y1: 3 }))] }), `desk ${s.index}`).toBe(false);
        // Outer side: away from the pod's middle.
        const pod = L.slots.filter((o) => o.pod === s.pod);
        const mid = pod.reduce((t, o) => t + o.desk.x, 0) / pod.length;
        if (pod.length > 1) expect(Math.sign(h.x - s.seat.x)).toBe(Math.sign(s.desk.x - mid) || Math.sign(h.x - s.seat.x));
        // Facing the orchestrator's chair.
        expect(Math.sin(h.yaw)).toBeCloseTo(Math.sign(s.seat.x - h.x), 6);
        // The chair swivels a quarter turn, no more.
        expect(Math.abs(h.swivel)).toBeCloseTo(Math.PI / 2, 6);
      }
    }
  });

  it('corner: up on the mezzanine, beside the corner seat, clear of its desk', () => {
    for (const L of floors) {
      for (const idx of [0, 1, 5]) {
        const h = handOver(L, { corner: idx })!;
        expect(h.up).toBe(MEZZ_Y);
        expect(h.seat).toEqual(L.mezzanine.orch.seat);
        expect(Math.hypot(h.x - h.seat.x, h.z - h.seat.z)).toBeCloseTo(HAND_LATERAL, 2);
        expect(Math.sin(h.yaw)).toBeCloseTo(Math.sign(h.seat.x - h.x), 6);
      }
    }
  });
});

describe('deskToDeskRoute', () => {
  it('between every pair of desks: straight, walkable legs from seat to the hand-over spot, and back', () => {
    for (const [storey, L] of floors.entries()) {
      for (const from of L.slots) {
        for (const to of L.slots) {
          if (from.index === to.index) continue;
          const route = deskToDeskRoute(L, storey, from.index, { slot: to.index });
          const what = `storey ${storey} desk ${from.index} → ${to.index}`;
          expect(route.length, what).toBeGreaterThanOrEqual(3);
          const spot = handOver(L, { slot: to.index })!;
          expect(route[0], what).toEqual({ x: from.seat.x, y: floorY(storey), z: from.seat.z });
          expect(route.at(-1), what).toEqual({ x: spot.x, y: floorY(storey), z: spot.z });
          // Out of the pod behind the chair first.
          expect(Math.abs((route[1] as Waypoint).z - from.seat.z), what).toBeGreaterThan(0.9);
          const w = worldWith(L, storey, [from.index]);
          expectWalkable(route, w, what);
          expectWalkable(reverseRoute(route), w, `${what} (back)`);
        }
      }
    }
  });

  it('pods at the grid’s edges and bigger floors', () => {
    for (const n of [4, 6, 7, 13, 28, 41]) {
      const o = outlineOf([n]);
      const L = floorLayout(n, o);
      const p = buildingPlan(o, 1, L.fireDoor);
      const edges = L.slots.filter((s) => s.index < 4 || s.index >= L.desks - 4 || s.index % 4 === 3);
      for (const from of edges) {
        for (const to of L.slots.filter((_, i) => i % 3 === 0)) {
          if (from.index === to.index) continue;
          const route = deskToDeskRoute(L, 0, from.index, { slot: to.index });
          expect(route.length, `${n} desks: ${from.index} → ${to.index}`).toBeGreaterThanOrEqual(3);
          const w = walkWorld(p, loadedFloor(L, 0));
          const busy = { supports: w.supports, solids: [...w.solids, ...L.slots.filter((s) => s.index !== from.index).map(seatRect).map((r) => ({ ...r, y0: 0, y1: 3 }))] };
          expectWalkable(route, busy, `${n} desks: ${from.index} → ${to.index}`);
        }
      }
    }
  });

  it('corner office: to the foot of the stair, up it, through the glass door, to the spot beside the orchestrator', () => {
    for (const [storey, L] of floors.entries()) {
      const m = L.mezzanine;
      for (const from of L.slots) {
        const to: Dest = { corner: from.index % 4 };
        const route = deskToDeskRoute(L, storey, from.index, to);
        const what = `storey ${storey} desk ${from.index} → corner`;
        expect(route.length, what).toBeGreaterThanOrEqual(6);
        const spot = handOver(L, to)!;
        const fy = floorY(storey);
        expect(route.at(-1), what).toEqual({ x: spot.x, y: fy + MEZZ_Y, z: spot.z });
        // Up the stair (x inside it) and through the door line.
        const stairPts = route.filter((p) => p.x > m.stair.x0 && p.x < m.stair.x1 && p.z > m.stair.top && p.z < m.stair.bottom);
        expect(stairPts.length, what).toBeGreaterThanOrEqual(1);
        const through = route.findIndex((p, i) => i > 0 && (route[i - 1] as Waypoint).z > m.door.z && p.z < m.door.z);
        expect(through, `${what} crosses the door line`).toBeGreaterThan(0);
        const a = route[through - 1]!;
        const b = route[through]!;
        const k = (a.z - m.door.z) / (a.z - b.z);
        const xDoor = a.x + (b.x - a.x) * k;
        expect(xDoor, what).toBeGreaterThan(m.door.x0 + R);
        expect(xDoor, what).toBeLessThan(m.door.x1 - R);
        expect(a.y + (b.y - a.y) * k, what).toBeGreaterThan(fy + m.y - 0.4);
        const w = worldWith(L, storey, [from.index]);
        expectWalkable(route, w, what);
        expectWalkable(reverseRoute(route), w, `${what} (back)`);
      }
    }
  });

  it('is empty for a desk that is not there', () => {
    expect(deskToDeskRoute(floors[0]!, 0, 99, { slot: 0 })).toEqual([]);
    expect(deskToDeskRoute(floors[0]!, 0, 0, { slot: 99 })).toEqual([]);
  });
});

describe('walkOutRoute from where the walker stands', () => {
  const storey = 2;
  const L = floors[storey]!;
  const w = () => walkWorld(plan, loadedFloor(L, storey));

  it('starts at the given point and reaches the street, every leg walkable', () => {
    const route = deskToDeskRoute(L, storey, 5, { slot: 9 });
    const mid = route[Math.floor(route.length / 2)]!;
    const from = { x: mid.x, y: mid.y, z: mid.z };
    const out = walkOutRoute(L, plan, storey, 5, from);
    expect(out[0]).toEqual(from);
    expect(out.at(-1)!.y).toBe(0);
    const world = w();
    expectWalkable(out, { supports: world.supports, solids: [...world.solids, ...L.slots.filter((s) => s.index !== 5).map(seatRect).map((r) => ({ ...r, y0: floorY(storey), y1: floorY(storey) + 3 }))] }, 'mid-delivery walk-out');
  });

  it('from the spot beside a desk, and from up in the corner office (back down the stair first)', () => {
    const spot = handOver(L, { slot: 9 })!;
    const a = walkOutRoute(L, plan, storey, 5, { x: spot.x, y: floorY(storey), z: spot.z });
    expect(a[0]).toMatchObject({ x: spot.x, z: spot.z });
    const world = w();
    const busy: WalkWorld = { supports: world.supports, solids: [...world.solids, ...L.slots.filter((s) => s.index !== 5).map(seatRect).map((r) => ({ ...r, y0: floorY(storey), y1: floorY(storey) + 3 }))] };
    expectWalkable(a, busy, 'from a spot');
    const c = handOver(L, { corner: 2 })!;
    const b = walkOutRoute(L, plan, storey, 5, { x: c.x, y: floorY(storey) + MEZZ_Y, z: c.z, corner: 2 });
    expect(b[0]).toMatchObject({ x: c.x, z: c.z });
    // Back down the stair before the aisles.
    const m = L.mezzanine;
    expect(b.some((p) => p.x > m.stair.x0 && p.x < m.stair.x1 && p.z > m.stair.top && p.z < m.stair.bottom)).toBe(true);
    expect(b.at(-1)!.y).toBe(0);
    expectWalkable(b, busy, 'from the corner office');
  });

  it('without a start it is the walk-out of old: seat first', () => {
    const out = walkOutRoute(L, plan, storey, 5);
    expect(out[0]).toEqual({ x: L.slots[5]!.seat.x, y: floorY(storey), z: L.slots[5]!.seat.z });
  });
});

describe('deskToCabinetRoute (#223)', () => {
  it('from every desk: straight, walkable legs to the spot in front of the filing cabinet, and back', () => {
    for (const [storey, L] of floors.entries()) {
      const spot = cabinetSpot(L)!;
      expect(spot).not.toBeNull();
      for (const from of L.slots) {
        const route = deskToCabinetRoute(L, storey, from.index);
        const what = `storey ${storey} desk ${from.index} → cabinet`;
        expect(route.length, what).toBeGreaterThanOrEqual(3);
        expect(route[0], what).toEqual({ x: from.seat.x, y: floorY(storey), z: from.seat.z });
        expect(route.at(-1), what).toEqual({ x: spot.x, y: floorY(storey), z: spot.z });
        const w = worldWith(L, storey, [from.index]);
        expectWalkable(route, w, what);
        expectWalkable(reverseRoute(route), w, `${what} (back)`);
      }
    }
  });
});
