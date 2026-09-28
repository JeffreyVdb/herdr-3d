import { describe, expect, it } from 'vitest';
import { buildingPlan, floorY, type BuildingPlan } from './building';
import { floorLayout, outlineOf, type FloorLayout } from './layout';
import { walkOutRoute } from './route';
import {
  ITEMS,
  PACK_S,
  PLUS_BACK_AFTER_M,
  SEAT_LIFT,
  STAND_LIFT,
  STAND_S,
  TAKE_LAPTOP_AT,
  WALK_SPEED,
  cumulative,
  poseAt,
  sampleRoute,
  timeline,
  walkInRoute,
} from './arrival';

const counts = [20, 10, 16];
const outline = outlineOf(counts);
const floors: FloorLayout[] = counts.map((n) => floorLayout(n, outline));
const plan: BuildingPlan = buildingPlan(outline, counts.length, floors[0]!.fireDoor);

describe('walk-in route', () => {
  it('is the walk-out route reversed, for any floor and desk', () => {
    for (const [storey, desk] of [
      [0, 0],
      [1, 7],
      [2, 15],
    ] as const) {
      const out = walkOutRoute(floors[storey]!, plan, storey, desk);
      const inn = walkInRoute(floors[storey]!, plan, storey, desk);
      expect(inn.length).toBeGreaterThan(10);
      expect(inn).toEqual([...out].reverse());
      // Starts on the street, ends at the desk's seat on that floor.
      expect(inn[0]!.y).toBe(0);
      expect(inn.at(-1)).toMatchObject({ x: floors[storey]!.slots[desk]!.seat.x, z: floors[storey]!.slots[desk]!.seat.z });
      expect(inn.at(-1)!.y).toBeCloseTo(floorY(storey), 3);
    }
    expect(walkInRoute(floors[0]!, plan, 0, 999)).toEqual([]);
  });
});

describe('sampleRoute', () => {
  const r = [
    { x: 0, y: 0, z: 0 },
    { x: 0, y: 0, z: 2 },
    { x: 3, y: 4, z: 2 },
  ];
  const at = cumulative(r);
  it('measures and interpolates, heights included', () => {
    expect(at).toEqual([0, 2, 7]);
    expect(sampleRoute(r, at, 1)).toEqual({ x: 0, y: 0, z: 1, yaw: 0 });
    const mid = sampleRoute(r, at, 4.5);
    expect(mid.x).toBeCloseTo(1.5);
    expect(mid.y).toBeCloseTo(2);
    expect(mid.yaw).toBeCloseTo(Math.PI / 2);
    expect(sampleRoute(r, at, 99)).toMatchObject({ x: 3, y: 4, z: 2 });
    expect(sampleRoute(r, at, -1)).toMatchObject({ x: 0, y: 0, z: 0, yaw: 0 });
  });
});

describe('timeline', () => {
  const storey = 2;
  const desk = 4;
  const L = floors[storey]!;
  const slot = L.slots[desk]!;
  const out = timeline('out', walkOutRoute(L, plan, storey, desk), slot.yaw);
  const inn = timeline('in', walkInRoute(L, plan, storey, desk), slot.yaw);

  it('orders its stages back to back', () => {
    expect(out.stages.map((s) => s.phase)).toEqual(['pack', 'stand', 'walk', 'vanish']);
    expect(inn.stages.map((s) => s.phase)).toEqual(['appear', 'walk', 'sit']);
    for (const tl of [out, inn]) {
      tl.stages.forEach((s, i) => {
        expect(s.t1).toBeGreaterThan(s.t0);
        if (i) expect(s.t0).toBe(tl.stages[i - 1]!.t1);
      });
      expect(tl.total).toBe(tl.stages.at(-1)!.t1);
    }
    const walk = out.stages[2]!;
    expect(walk.t1 - walk.t0).toBeCloseTo(out.length / WALK_SPEED, 6);
    expect(inn.length).toBeCloseTo(out.length, 6);
  });

  it('walk-out: packs seated, takes the laptop, stands, walks down the stairs, fades', () => {
    const seat = out.route[0]!;
    const p0 = poseAt(out, 0.1);
    expect(p0).toMatchObject({ phase: 'pack', seated: true, box: 'desk', laptop: 'desk', desk: 'busy', items: 0 });
    expect(p0.y).toBeCloseTo(seat.y + SEAT_LIFT, 6);
    expect(poseAt(out, TAKE_LAPTOP_AT - 0.05).items).toBe(ITEMS);
    expect(poseAt(out, TAKE_LAPTOP_AT + 0.1)).toMatchObject({ laptop: 'lift', desk: 'empty' });
    expect(poseAt(out, PACK_S - 0.01)).toMatchObject({ laptop: 'carried', desk: 'empty' });
    const standing = poseAt(out, PACK_S + STAND_S - 0.001);
    expect(standing.y).toBeCloseTo(seat.y + STAND_LIFT, 2);
    expect(standing).toMatchObject({ phase: 'stand', box: 'carried' });
    // Walking: on the route, feet on its heights; the "+" comes back once out of the pod.
    const w0 = out.stages[2]!;
    const early = poseAt(out, w0.t0 + 0.5);
    expect(early).toMatchObject({ phase: 'walk', desk: early.walked >= PLUS_BACK_AFTER_M ? 'free' : 'empty' });
    expect(early.stride).not.toBeNull();
    let prevY = Infinity;
    let sawStairs = false;
    for (let t = w0.t0; t < w0.t1; t += 0.25) {
      const p = poseAt(out, t);
      const onRoute = sampleRoute(out.route, out.at, p.walked);
      expect(p.y).toBeCloseTo(onRoute.y + STAND_LIFT, 6);
      expect(p.y).toBeLessThanOrEqual(prevY + 1e-6);
      if (p.y < seat.y - 0.5 && p.y > 1) sawStairs = true;
      prevY = p.y;
    }
    expect(sawStairs).toBe(true);
    expect(poseAt(out, w0.t1 - 0.01).desk).toBe('free');
    const end = poseAt(out, out.total + 1);
    expect(end).toMatchObject({ phase: 'done', scale: 0, desk: 'free' });
    expect(end.y).toBeCloseTo(STAND_LIFT, 6);
  });

  it('walk-in: pops up on the sidewalk, keeps the desk empty, sits down facing the desk', () => {
    const start = poseAt(inn, 0);
    expect(start).toMatchObject({ phase: 'appear', box: 'carried', laptop: 'carried', desk: 'empty' });
    expect(start.scale).toBe(0);
    expect(start.y).toBeCloseTo(inn.route[0]!.y + STAND_LIFT, 6);
    const w = inn.stages[1]!;
    for (let t = w.t0; t < w.t1; t += 1) expect(poseAt(inn, t).desk).toBe('empty');
    const sitting = poseAt(inn, inn.total - 0.001);
    expect(sitting.phase).toBe('sit');
    expect(sitting.yaw).toBeCloseTo(slot.yaw, 3);
    const done = poseAt(inn, inn.total);
    expect(done).toMatchObject({ phase: 'done', seated: true, desk: 'free' });
    expect(done.y).toBeCloseTo(floorY(storey) + SEAT_LIFT, 3);
  });
});
