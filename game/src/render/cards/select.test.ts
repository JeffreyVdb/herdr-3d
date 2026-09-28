import { describe, expect, it } from 'vitest';
import { rayBox, type V3 } from '../../world/collide';
import { EYE_HEIGHT, floorLayout, MEZZ_Y } from '../../world/layout';
import { CARD_RANGE, cardWeight, OVERLOOK_CARD_RANGE, selectCards } from './select';

const cam = { x: 0, y: 1.5, z: 0 };
const north = { x: 0, y: 0, z: -1 };
const at = (z: number, x = 0) => ({ x, y: 1.6, z });

describe('selectCards', () => {
  it('keeps cards in front, nearest first, fading with distance', () => {
    const got = selectCards(cam, north, [at(-3), at(-10), at(3), null, at(-20)], { near: 5, far: 15, cap: 10 });
    expect(got.map((c) => c.index)).toEqual([0, 1]);
    expect(got[0]?.alpha).toBe(1);
    expect(got[1]?.alpha).toBeCloseTo(0.5, 1);
  });
  it('caps the number of cards', () => {
    const anchors = Array.from({ length: 60 }, (_, i) => at(-1 - i * 0.2, (i % 5) * 0.1));
    const got = selectCards(cam, north, anchors, { near: 5, far: 30, cap: 24 });
    expect(got).toHaveLength(24);
    expect(got.map((c) => c.index)).toEqual([...Array(24).keys()]);
  });
  it('pulls weighted cards forward and drops occluded ones', () => {
    const got = selectCards(cam, north, [at(-4), at(-6), at(-5)], { near: 5, far: 15, cap: 2 }, (i) => (i === 1 ? 0.5 : 1), (i) => i === 0);
    expect(got.map((c) => c.index)).toEqual([1, 2]);
  });
  it('ignores cards outside the view cone', () => {
    expect(selectCards(cam, north, [at(-1, 5)], { near: 5, far: 15, cap: 5 })).toEqual([]);
  });
});

describe('cards from the corner office (#20)', () => {
  const CARD_Y = 1.62; // render/office.ts: a card's anchor height over its seat
  const SIT_DROP = 0.36; // input/walk.ts: the seated eye sits this much lower

  it("shows every 'needs you' card of a 96-desk floor from your seat, not just 24", () => {
    const L = floorLayout(96);
    const { sit } = L.mezzanine;
    const eye = { x: sit.x, y: MEZZ_Y + EYE_HEIGHT - SIT_DROP, z: sit.z };
    const fwd = { x: -Math.sin(sit.yaw) * Math.cos(sit.pitch), y: Math.sin(sit.pitch), z: -Math.cos(sit.yaw) * Math.cos(sit.pitch) };
    const anchors = L.slots.map((s) => ({ x: s.seat.x, y: CARD_Y, z: s.seat.z }));
    // As the office does: a card behind a wall from the camera is not shown.
    const occluded = (i: number, d: number) => {
      const a = anchors[i]!;
      const dir: V3 = [(a.x - eye.x) / d, (a.y - eye.y) / d, (a.z - eye.z) / d];
      return L.walls.some((w) => {
        const t = rayBox([eye.x, eye.y, eye.z], dir, w);
        return t !== null && t < d - 0.05;
      });
    };
    const everyone = () => cardWeight(true, true);
    const all = selectCards(eye, fwd, anchors, { ...CARD_RANGE, cap: Infinity }, everyone, occluded);
    const up = selectCards(eye, fwd, anchors, OVERLOOK_CARD_RANGE, everyone, occluded);
    // The whole floor is in front of the seat and in range, less the few desks beside or under it.
    expect(all.length).toBeGreaterThanOrEqual(90);
    expect(up).toEqual(all);
    // On the floor the cap stays.
    expect(selectCards(eye, fwd, anchors, CARD_RANGE, everyone, occluded)).toHaveLength(CARD_RANGE.cap);
  });

  it('weighs "needs you" nearer, and everything nearer from the mezzanine', () => {
    expect(cardWeight(false, false)).toBe(1);
    expect(cardWeight(true, false)).toBeLessThan(1);
    expect(cardWeight(true, true)).toBeLessThan(cardWeight(true, false));
    expect(cardWeight(false, true)).toBeLessThan(1);
  });
});
