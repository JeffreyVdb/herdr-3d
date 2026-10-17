import { describe, expect, it } from 'vitest';
import { blocked3, BODY_H, groundAt, MAX_DROP, moveWalker, pickNearest, STEP_UP, type V3p, type WalkWorld } from './collide';
import { buildingPlan, FACE, floorY, loadedFloor, placeAt, RISE, RISERS, STOREY, walkWorld, type BuildingPlan } from './building';
import { EYE_HEIGHT, floorLayout, outlineOf, seatRect, type FloorLayout } from './layout';
import { walkOutRoute } from './route';

const counts = [20, 10, 16];
const outline = outlineOf(counts);
const floors: FloorLayout[] = counts.map((n) => floorLayout(n, outline));
const plan: BuildingPlan = buildingPlan(outline, counts.length, floors[0]!.fireDoor);
const e = plan.escape;
const xi = (e.inner.x0 + e.inner.x1) / 2;
const xo = (e.outer.x0 + e.outer.x1) / 2;
const dz = (e.door.z0 + e.door.z1) / 2;
const R = 0.28;

const world = (storey: number | null): WalkWorld => walkWorld(plan, storey === null ? null : loadedFloor(floors[storey]!, storey));

/** Walks in a straight line in small steps; returns where it ends up. */
function walk(w: WalkWorld, from: V3p, to: { x: number; z: number }, stepLen = 0.04): V3p {
  let p = from;
  for (let i = 0; i < 2000; i++) {
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

describe('storeys', () => {
  it('stacks the lobby at street level and each floor a storey up', () => {
    // The tall room of the corner office (#20): 6.5 m floor to ceiling plus the slab.
    expect(STOREY).toBeCloseTo(6.8, 6);
    expect(floorY(-1)).toBe(0);
    expect(floorY(0)).toBeCloseTo(STOREY, 6);
    expect(floorY(2)).toBeCloseTo(3 * STOREY, 6);
    expect(RISE * 2 * RISERS).toBeCloseTo(STOREY, 6);
    // Still a comfortable stair: a half landing between floors, risers under 0.19 m.
    expect(RISE).toBeLessThanOrEqual(0.19);
  });
});

describe('ground height', () => {
  const w = world(1);
  it('is the floor inside, the landing outside the door, the sidewalk below', () => {
    expect(groundAt(w.supports, 5, 5, floorY(1))).toBeCloseTo(floorY(1), 6);
    expect(groundAt(w.supports, xi, dz, floorY(1))).toBeCloseTo(floorY(1), 6);
    expect(groundAt(w.supports, xi, dz, floorY(0))).toBeCloseTo(floorY(0), 6);
    expect(groundAt(w.supports, -5, plan.depth + 2, 0)).toBe(0);
    expect(groundAt(w.supports, plan.width / 2 + 5, plan.depth + 3, 0.1)).toBe(0);
    // Nothing beyond the fences.
    expect(groundAt(w.supports, plan.fence.west - 1, plan.depth, 0)).toBeNull();
  });

  it('is each tread of both flights, one riser apart', () => {
    for (let s = 0; s < plan.floors; s++) {
      const top = floorY(s);
      let prev = top;
      for (let i = 1; i < RISERS; i++) {
        const z = e.landing.z0 - (i - 0.5) * 0.28;
        const g = groundAt(w.supports, xo, z, prev);
        expect(g, `storey ${s} flight 1 step ${i}`).toBeCloseTo(top - i * RISE, 6);
        prev = g as number;
      }
      const half = groundAt(w.supports, (xi + xo) / 2, (e.half.z0 + e.half.z1) / 2, prev);
      expect(half).toBeCloseTo(top - STOREY / 2, 6);
      prev = half as number;
      for (let j = 1; j < RISERS; j++) {
        const z = e.flights.z0 + (j - 0.5) * 0.28;
        const g = groundAt(w.supports, xi, z, prev);
        expect(g, `storey ${s} flight 2 step ${j}`).toBeCloseTo(top - STOREY / 2 - j * RISE, 6);
        prev = g as number;
      }
      expect(top - STOREY - prev).toBeCloseTo(-RISE, 6);
    }
  });

  it('never steps up more than STEP_UP: the flight a storey up is not ground', () => {
    // Standing on landing 0, the inner lane north of it is flight 2 of storey 1 going up, one riser.
    expect(groundAt(w.supports, xi, e.landing.z0 - 0.14, floorY(0))).toBeCloseTo(floorY(0) + RISE, 6);
    // From the street under the escape, landing 0 overhead is not reachable.
    expect(groundAt(w.supports, xi, dz, 0)).toBe(0);
    expect(STEP_UP).toBeGreaterThan(RISE);
    expect(STEP_UP).toBeLessThan(0.4);
  });
});

describe('walking the fire escape', () => {
  it('goes out the loaded floor door, down every flight to the street, and back up', () => {
    const w = world(2);
    let p: V3p = { x: 2, y: floorY(2), z: dz };
    p = walk(w, p, { x: xi, z: dz });
    expect(p.x).toBeCloseTo(xi, 2);
    expect(p.y).toBeCloseTo(floorY(2), 6);
    expect(placeAt(p, plan)).toEqual({ area: 'fire-escape', storey: 2 });
    for (let s = 2; s >= 0; s--) {
      p = walk(w, p, { x: xo, z: e.landing.z0 + 0.3 });
      p = walk(w, p, { x: xo, z: (e.half.z0 + e.half.z1) / 2 });
      expect(p.y, `half landing below ${s}`).toBeCloseTo(floorY(s) - STOREY / 2, 6);
      expect(placeAt(p, plan)).toEqual({ area: 'fire-escape', storey: null });
      p = walk(w, p, { x: xi, z: (e.half.z0 + e.half.z1) / 2 });
      p = walk(w, p, { x: xi, z: dz });
      expect(p.y, `landing ${s - 1}`).toBeCloseTo(floorY(s - 1), 6);
    }
    expect(placeAt(p, plan)).toEqual({ area: 'street', storey: null });
    // Out from under the escape to the front sidewalk.
    p = walk(w, p, { x: xi, z: plan.depth + 1.5 });
    expect(p.z).toBeCloseTo(plan.depth + 1.5, 2);
    expect(p.y).toBe(0);
    // And back up to the bottom landing.
    p = walk(w, p, { x: xi, z: dz });
    p = walk(w, p, { x: xi, z: (e.half.z0 + e.half.z1) / 2 });
    p = walk(w, p, { x: xo, z: (e.half.z0 + e.half.z1) / 2 });
    p = walk(w, p, { x: xo, z: e.landing.z0 + 0.3 });
    expect(p.y).toBeCloseTo(floorY(0), 6);
    expect(placeAt(p, plan)).toEqual({ area: 'fire-escape', storey: 0 });
  });

  it('keeps you on: railings, the centre rail and closed floors stop you', () => {
    const w = world(2);
    // West off a landing: the outer rail.
    const west = walk(w, { x: xi, y: floorY(1), z: dz }, { x: e.x0 - 3, z: dz });
    expect(west.x).toBeGreaterThan(e.x0);
    expect(west.y).toBeCloseTo(floorY(1), 6);
    // South off a landing: its south rail.
    const south = walk(w, { x: xi, y: floorY(1), z: dz }, { x: xi, z: e.landing.z1 + 3 });
    expect(south.z).toBeLessThan(e.landing.z1);
    // Across from flight 2 to flight 1: the centre rail.
    const mid = e.flights.z0 + 1.1;
    const g = groundAt(w.supports, xi, mid, floorY(1) - STOREY / 2) as number;
    const across = walk(w, { x: xi, y: g, z: mid }, { x: xo, z: mid });
    expect(across.x).toBeGreaterThan(e.rail.x1 - 0.01);
    // Floor 1 is not the loaded floor: its door stays shut.
    const shut = walk(w, { x: xi, y: floorY(1), z: dz }, { x: 3, z: dz });
    expect(shut.x).toBeLessThan(-FACE);
    // The loaded floor's door is open.
    const open = walk(w, { x: xi, y: floorY(2), z: dz }, { x: 3, z: dz });
    expect(open.x).toBeCloseTo(3, 2);
    expect(placeAt(open, plan)).toEqual({ area: 'floor', storey: 2 });
  });

  it('does not let a flight block the landing a storey above it', () => {
    const w = world(0);
    // Landing 1 sits over flight 1 and flight 2 of storey 0's lanes: walk across it end to end.
    const p = walk(w, { x: xi, y: floorY(1), z: e.landing.z1 - 0.35 }, { x: xo, z: e.landing.z0 + 0.3 });
    expect(p.x).toBeCloseTo(xo, 2);
    expect(p.y).toBeCloseTo(floorY(1), 6);
    // Under landing 0 at street level: the flights and landing overhead leave room.
    expect(blocked3({ x: xi, y: 0, z: dz }, R, w)).toBe(false);
    expect(BODY_H).toBeLessThan(STOREY - 0.2);
  });

  it('does not walk off an edge or into the void', () => {
    const edge: WalkWorld = { supports: [{ x0: 0, z0: 0, x1: 4, z1: 4, y: 1 }, { x0: 4, z0: 0, x1: 8, z1: 4, y: 0 }], solids: [] };
    const p = moveWalker({ x: 3.5, y: 1, z: 2 }, { x: 2, z: 0 }, R, edge);
    expect(p.x).toBeLessThanOrEqual(4);
    expect(p.y).toBe(1);
    const up: WalkWorld = { supports: [{ x0: 0, z0: 0, x1: 4, z1: 4, y: 0 }, { x0: 4, z0: 0, x1: 8, z1: 4, y: STEP_UP + 0.05 }], solids: [] };
    expect(moveWalker({ x: 3.5, y: 0, z: 2 }, { x: 2, z: 0 }, R, up).x).toBeLessThanOrEqual(4);
    const step: WalkWorld = { supports: [{ x0: 0, z0: 0, x1: 4, z1: 4, y: 0 }, { x0: 4, z0: 0, x1: 8, z1: 4, y: 0.3 }], solids: [] };
    const stepped = moveWalker({ x: 3.5, y: 0, z: 2 }, { x: 2, z: 0 }, R, step);
    expect(stepped.x).toBeCloseTo(5.5, 6);
    expect(stepped.y).toBe(0.3);
    expect(MAX_DROP).toBeLessThan(0.5);
    expect(moveWalker({ x: 1, y: 0, z: 1 }, { x: -3, z: 0 }, R, step).x).toBeGreaterThanOrEqual(0);
  });

  it('stops at the edge of the street: fences, hedges and the curb bollards', () => {
    const w = world(null);
    const f = plan.fence;
    expect(walk(w, { x: -3, y: 0, z: plan.depth + 2 }, { x: f.west - 5, z: plan.depth + 2 }).x).toBeGreaterThan(f.west);
    expect(walk(w, { x: 3, y: 0, z: plan.depth + 3 }, { x: 3, z: f.curb + 6 }).z).toBeLessThan(f.curb);
    expect(walk(w, { x: plan.width + 2, y: 0, z: 3 }, { x: f.east + 5, z: 3 }).x).toBeLessThan(f.east);
    expect(walk(w, { x: 3, y: 0, z: -2 }, { x: 3, z: f.north - 5 }).z).toBeGreaterThan(f.north);
    // Out to about 8 m on the fire-escape side.
    expect(-f.west).toBeGreaterThanOrEqual(7.5);
  });

  it('walks into the lobby through the front door, not through the glass', () => {
    const w = world(null);
    const L = plan.lobby;
    const fx = (L.front.x0 + L.front.x1) / 2;
    const inside = walk(w, { x: fx, y: 0, z: plan.depth + 2 }, { x: fx, z: plan.depth - 2 });
    expect(inside.z).toBeCloseTo(plan.depth - 2, 2);
    expect(placeAt(inside, plan)).toEqual({ area: 'lobby', storey: null });
    const glass = walk(w, { x: L.front.x1 + 2, y: 0, z: plan.depth + 2 }, { x: L.front.x1 + 2, z: plan.depth - 2 });
    expect(glass.z).toBeGreaterThan(plan.depth);
  });
});

describe('the lobby’s departures board (#65)', () => {
  it('hangs centred on the north wall, facing the elevator, clear of the plants, the reception and its feature wall; walk up and aim: it is what you hit', () => {
    for (const desks of [[0], [20, 10, 16], [96], [40, 40, 40, 40, 40, 40]]) {
      const o = outlineOf(desks);
      const fl = floorLayout(desks[0] ?? 0, o);
      const p = buildingPlan(o, desks.length, fl.fireDoor);
      const L = p.lobby;
      const b = L.departures;
      const at = `${p.width} x ${p.depth}`;
      expect(b.min[2], at).toBe(0);
      expect(b.max[2], at).toBeLessThanOrEqual(0.12);
      expect((b.min[0] + b.max[0]) / 2, at).toBeCloseTo(p.width / 2, 3);
      expect(b.max[0] - b.min[0], at).toBeGreaterThanOrEqual(4);
      expect(b.max[1], at).toBeLessThan(6.5 - 2);
      // Nothing of the lobby's stands in front of it or overlaps it: the plants, the feature wall, the desk, the elevator.
      for (const pl of L.plants) expect(pl.x + 0.3 < b.min[0] - 0.3 || pl.x - 0.3 > b.max[0] + 0.3 || pl.z - 0.3 > 1.5, `plant ${pl.x},${pl.z}`).toBe(true);
      for (const r of [L.backWall, L.desk]) expect(r.x1 < b.min[0] || r.z0 > 3, at).toBe(true);
      // Straight ahead out of the elevator, whole: the lines from the spawn to its corners pass clear of the feature wall.
      const mid: [number, number, number] = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, b.max[2]];
      const bw = L.backWall;
      for (const cx of [b.min[0], b.max[0]]) {
        const k = (L.spawn.z - bw.z1) / (L.spawn.z - b.max[2]);
        const x = L.spawn.x + (cx - L.spawn.x) * k;
        expect(x > bw.x1 || x < bw.x0, `${at}: the line to x ${cx} at the feature wall (x ${x})`).toBe(true);
      }
      // Walk up to it: free to stand 1.5 m in front, and aimed at from there it is the pick, before the wall behind it.
      const stand = walk(walkWorld(p, null), { x: L.spawn.x, y: 0, z: L.spawn.z }, { x: mid[0], z: 1.5 });
      expect(stand.z, at).toBeCloseTo(1.5, 1);
      const from: [number, number, number] = [stand.x, EYE_HEIGHT, stand.z];
      const d: [number, number, number] = [mid[0] - from[0], mid[1] - from[1], mid[2] - from[2]];
      const len = Math.hypot(...d);
      expect(len).toBeLessThan(3);
      const targets = [{ boxes: [b], value: 'departures' }, { boxes: [L.deskBox], value: 'reception' }, { boxes: [L.elevator], value: 'elevator' }];
      expect(pickNearest(from, [d[0] / len, d[1] / len, d[2] / len], targets, 3, L.walls)?.value, at).toBe('departures');
    }
  });
});

describe('walk-out route (M4)', () => {
  it.each([0, 1, 2])('from any desk on floor %i: out the door, down the escape, away along the sidewalk', (storey) => {
    const L = floors[storey]!;
    const w = walkWorld(plan, loadedFloor(L, storey));
    for (const desk of [0, Math.floor(L.desks / 2), L.desks - 1]) {
      const route = walkOutRoute(L, plan, storey, desk);
      const seat = L.slots[desk]!;
      expect(route[0]).toEqual({ x: seat.seat.x, y: floorY(storey), z: seat.seat.z });
      // Through this floor's door, then every landing below it.
      const landings = route.filter((p) => placeAt(p, plan).area === 'fire-escape' && placeAt(p, plan).storey !== null);
      expect(new Set(landings.map((p) => placeAt(p, plan).storey))).toEqual(new Set(Array.from({ length: storey + 1 }, (_, i) => i)));
      const last = route.at(-1)!;
      expect(placeAt(last, plan).area).toBe('street');
      expect(last.y).toBe(0);
      expect(last.z).toBeGreaterThan(plan.depth);
      expect(last.x).toBeGreaterThan(plan.width);
      // Every leg is walkable: no solid in the way (other workers' chairs included), no edge, no step over STEP_UP.
      const others = L.slots.filter((s) => s.index !== desk).map(seatRect);
      const busy: WalkWorld = { supports: w.supports, solids: [...w.solids, ...others.map((r) => ({ ...r, y0: floorY(storey), y1: floorY(storey) + 3 }))] };
      let p: V3p = route[0]!;
      for (const next of route.slice(1)) {
        const end = walk(busy, p, next, 0.03);
        expect(Math.hypot(end.x - next.x, end.z - next.z), `desk ${desk} to ${JSON.stringify(next)}`).toBeLessThan(0.02);
        expect(end.y).toBeCloseTo(next.y, 6);
        p = end;
      }
    }
  });
});
