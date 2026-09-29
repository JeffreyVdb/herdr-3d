import { describe, expect, it } from 'vitest';
import { buildingPlan, floorY, type BuildingPlan } from './building';
import { floorLayout, outlineOf, type FloorLayout } from './layout';
import { walkOutRoute } from './route';
import {
  DROP_H,
  DROP_S,
  FALL_S,
  ITEM_LIFT_S,
  ITEMS,
  PACK_S,
  PLUS_BACK_AFTER_M,
  SEAT_LIFT,
  STAND_LIFT,
  STAND_S,
  TAKE_LAPTOP_AT,
  WAVE_S,
  WALK_SPEED,
  cumulative,
  deskOwners,
  itemAt,
  poseAt,
  sampleRoute,
  timeline,
} from './arrival';

const counts = [20, 10, 16];
const outline = outlineOf(counts);
const floors: FloorLayout[] = counts.map((n) => floorLayout(n, outline));
const plan: BuildingPlan = buildingPlan(outline, counts.length, floors[0]!.fireDoor);

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
  const route = walkOutRoute(L, plan, storey, desk);
  const out = timeline('out', route, slot.yaw);
  const seat = route[0]!;
  const inn = timeline('in', [seat], slot.yaw);

  it('orders its stages back to back', () => {
    expect(out.stages.map((s) => s.phase)).toEqual(['pack', 'stand', 'walk', 'vanish']);
    expect(inn.stages.map((s) => s.phase)).toEqual(['drop']);
    for (const tl of [out, inn]) {
      tl.stages.forEach((s, i) => {
        expect(s.t1).toBeGreaterThan(s.t0);
        if (i) expect(s.t0).toBe(tl.stages[i - 1]!.t1);
      });
      expect(tl.total).toBe(tl.stages.at(-1)!.t1);
    }
    const walk = out.stages[2]!;
    expect(walk.t1 - walk.t0).toBeCloseTo(out.length / WALK_SPEED, 6);
    // The walk-out is as long as it was (M4): pack, stand, the route at a stroll, fade.
    expect(out.total).toBeCloseTo(PACK_S + STAND_S + out.length / WALK_SPEED + 0.5, 6);
  });

  it('walk-out: packs seated, takes the laptop, stands, walks down the stairs, fades', () => {
    const p0 = poseAt(out, 0.1);
    expect(p0).toMatchObject({ phase: 'pack', seated: true, box: 'desk', laptop: 'desk', desk: 'busy', items: 0, itemLift: 0 });
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

  it('drop-in (M6b): no walk, under a second, the desk the worker’s from the first frame', () => {
    expect(inn.stages.some((s) => s.phase === 'walk')).toBe(false);
    expect(inn.total).toBe(DROP_S);
    expect(inn.total).toBeLessThanOrEqual(1);
    expect(inn.length).toBe(0);
    for (let t = 0; t <= inn.total + 0.2; t += 0.01) {
      const p = poseAt(inn, t);
      // Never `away`: the desk is as the world says (seated, card, pick) all along.
      expect(p.desk).toBe('free');
      expect(p).toMatchObject({ box: 'none', laptop: 'none', seated: true, stride: null });
      expect(p.x).toBe(seat.x);
      expect(p.z).toBe(seat.z);
      expect(p.yaw).toBe(slot.yaw);
    }
    // From above, falling faster and faster, onto the seat by FALL_S.
    const top = poseAt(inn, 0);
    expect(top).toMatchObject({ phase: 'drop', dy: DROP_H });
    expect(top.y).toBeCloseTo(seat.y + SEAT_LIFT + DROP_H, 6);
    const a = poseAt(inn, FALL_S * 0.25).dy;
    const b = poseAt(inn, FALL_S * 0.5).dy;
    const c = poseAt(inn, FALL_S * 0.75).dy;
    expect(DROP_H - a).toBeLessThan(a - b);
    expect(a - b).toBeLessThan(b - c);
    // The landing shadow grows on the seat meanwhile, then the dust puffs as it lands flattened and springs back.
    expect(poseAt(inn, FALL_S * 0.9).shadow).toBeGreaterThan(poseAt(inn, FALL_S * 0.2).shadow);
    expect(poseAt(inn, FALL_S * 0.5).squash).toBeGreaterThan(1);
    const land = poseAt(inn, FALL_S + 0.001);
    expect(land.dy).toBe(0);
    expect(land.squash).toBeLessThan(0.75);
    expect(land.puff).toBeCloseTo(0, 2);
    expect(land.shadow).toBe(0);
    expect(Math.max(...[0.1, 0.15, 0.2, 0.25].map((u) => poseAt(inn, FALL_S + u).squash))).toBeGreaterThan(1.02);
    // Settles to exactly seated: the world's own seat takes over with no pop.
    expect(poseAt(inn, DROP_S - 0.001).squash).toBeCloseTo(1, 3);
    const done = poseAt(inn, inn.total);
    expect(done).toMatchObject({ phase: 'done', seated: true, desk: 'free', dy: 0, squash: 1, puff: null });
    expect(done.y).toBeCloseTo(floorY(storey) + SEAT_LIFT, 3);
  });

  it('packing (M6b): the desk’s items go in one by one, then the laptop, whatever the desk has', () => {
    for (const n of [2, 3, 5]) {
      const tl = timeline('out', route, slot.yaw, 'box', n);
      expect(tl.items).toBe(n);
      const at = Array.from({ length: n }, (_, i) => itemAt(i, n));
      at.forEach((a, i) => {
        expect(poseAt(tl, a - 0.01)).toMatchObject({ items: i, itemLift: 0, laptop: 'desk', desk: 'busy' });
        const mid = poseAt(tl, a + ITEM_LIFT_S / 2);
        expect(mid.items).toBe(i);
        expect(mid.itemLift).toBeCloseTo(0.5, 5);
        expect(poseAt(tl, a + ITEM_LIFT_S + 0.001)).toMatchObject({ items: i + 1 });
        if (i) expect(a).toBeGreaterThanOrEqual(at[i - 1]! + ITEM_LIFT_S);
      });
      // Every item is in the box before the laptop comes out of its dock.
      expect(at.at(-1)! + ITEM_LIFT_S).toBeLessThanOrEqual(TAKE_LAPTOP_AT);
      expect(poseAt(tl, TAKE_LAPTOP_AT + 0.01)).toMatchObject({ items: n, laptop: 'lift', desk: 'empty' });
      expect(tl.total).toBeCloseTo(out.total, 6);
    }
  });
});

describe('desk owners while walks overlap', () => {
  const away = (session: string, desk: number, show: 'busy' | 'empty' | null, who: string) => ({ session, desk, show, who });

  it('the newest walk on a desk owns it: a drop-in behind a walk-out shows the new hire, as the world says', () => {
    // Pip was sent home from desk 5 and is still packing (busy); Gumdrop was hired to desk 5 after and drops in
    // (M6b: null, the desk as the world says, where the new hire already sits).
    const walkOut = poseAt(timeline('out', walkOutRoute(floors[0]!, plan, 0, 5), 0), 0.5);
    expect(walkOut.desk).toBe('busy');
    const got = deskOwners([], [away('f', 5, 'busy', 'pip-out'), away('f', 5, null, 'gumdrop-in')]);
    expect(got).toEqual([away('f', 5, null, 'gumdrop-in')]);
  });

  it('a walk that just ended does not override a walk still running on its desk', () => {
    expect(deskOwners([away('f', 5, null, 'pip-out ended')], [away('f', 5, 'empty', 'gumdrop-in')])).toEqual([away('f', 5, 'empty', 'gumdrop-in')]);
  });

  it('keeps one entry per desk and per floor; ended walks alone hand the desk back', () => {
    const got = deskOwners([away('f', 2, null, 'a ended'), away('g', 5, null, 'b ended')], [away('f', 5, 'busy', 'c'), away('f', 5, 'empty', 'd'), away('g', 1, 'empty', 'e')]);
    expect(got).toEqual([away('f', 2, null, 'a ended'), away('g', 5, null, 'b ended'), away('f', 5, 'empty', 'd'), away('g', 1, 'empty', 'e')]);
  });

  it('start order decides, not the kind of walk', () => {
    // Start order matters, not the kind: a walk-out that started after a walk-in owns the desk.
    expect(deskOwners([], [away('f', 3, 'empty', 'in first'), away('f', 3, 'busy', 'out later')])).toEqual([away('f', 3, 'busy', 'out later')]);
  });
});

// M6: freelancers walk out with a briefcase (M6b: they drop in, like a hire), and wave goodbye before they go.
describe('the freelancer walks (M6)', () => {
  const route = walkOutRoute(floors[0]!, plan, 0, 3);
  const yaw = floors[0]!.slots[3]!.yaw;

  it('leaving: stands up, waves with the briefcase in hand, walks out; no box, no packing', () => {
    const tl = timeline('out', route, yaw, 'briefcase');
    expect(tl.carry).toBe('briefcase');
    expect(tl.stages.map((s) => s.phase)).toEqual(['stand', 'wave', 'walk', 'vanish']);
    expect(tl.total).toBeCloseTo(STAND_S + WAVE_S + tl.length / WALK_SPEED + 0.5, 5);
    const standing = poseAt(tl, STAND_S * 0.3);
    expect(standing).toMatchObject({ phase: 'stand', box: 'none', laptop: 'none', briefcase: 'hand', wave: false, desk: 'empty' });
    const waving = poseAt(tl, STAND_S + WAVE_S / 2);
    expect(waving).toMatchObject({ phase: 'wave', seated: false, box: 'none', briefcase: 'hand', wave: true, desk: 'empty', walked: 0 });
    expect(waving.y).toBeCloseTo(route[0]!.y + STAND_LIFT, 5);
    const walking = poseAt(tl, STAND_S + WAVE_S + 3);
    expect(walking).toMatchObject({ phase: 'walk', box: 'none', laptop: 'none', briefcase: 'hand', wave: false });
    expect(walking.walked).toBeGreaterThan(0);
    // Out of the pod: the desk is free again.
    expect(poseAt(tl, STAND_S + WAVE_S + (PLUS_BACK_AFTER_M + 0.5) / WALK_SPEED).desk).toBe('free');
    expect(poseAt(tl, tl.total + 1)).toMatchObject({ phase: 'done', scale: 0, briefcase: 'none' });
  });

  it('arriving (M6b): drops in like a hire, the briefcase by its chair (the desk draws it)', () => {
    const tl = timeline('in', [route[0]!], yaw, 'briefcase');
    expect(tl.stages.map((s) => s.phase)).toEqual(['drop']);
    expect(poseAt(tl, 0.2)).toMatchObject({ phase: 'drop', box: 'none', laptop: 'none', briefcase: 'none', wave: false, desk: 'free' });
    expect(poseAt(tl, tl.total + 1)).toMatchObject({ phase: 'done', seated: true, briefcase: 'none' });
  });

  it('the M4 walks are as they were: box, no briefcase, no wave', () => {
    const tl = timeline('out', route, yaw);
    expect(tl.carry).toBe('box');
    expect(tl.stages.map((s) => s.phase)).toEqual(['pack', 'stand', 'walk', 'vanish']);
    expect(poseAt(tl, PACK_S + STAND_S + 2)).toMatchObject({ box: 'carried', laptop: 'carried', briefcase: 'none', wave: false });
    expect(poseAt(tl, TAKE_LAPTOP_AT - 0.1).items).toBeLessThanOrEqual(ITEMS);
    expect(poseAt(tl, 0.1).seated).toBe(true);
    expect(SEAT_LIFT).toBeGreaterThan(STAND_LIFT);
  });
});
