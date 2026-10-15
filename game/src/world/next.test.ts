import { describe, expect, it } from 'vitest';
import type { Display } from './derive';
import { faceSpots, needQueue, nextNeed, type NeedCandidate } from './next';

const w = (id: string, display: Display, since: number, over: Partial<NeedCandidate> = {}): NeedCandidate => ({
  id,
  floor: 'top',
  building: 'work',
  display,
  since,
  desk: 0,
  name: id,
  ...over,
});

describe('needQueue', () => {
  const all = [
    w('busy', 'working', 1),
    w('done-new', 'done', 500),
    w('blocked-new', 'needs_you', 400, { floor: 'bottom' }),
    w('done-old', 'done', 100, { floor: 'bottom' }),
    w('blocked-old', 'needs_you', 300),
    w('idle', 'idle', 2),
    w('asleep', 'asleep', 3),
    w('lot-blocked', 'needs_you', 50, { building: null, floor: 'lot' }),
    w('lot-done', 'done', 10, { building: null, floor: 'lot' }),
  ];

  it('visits blocked (oldest first), then done (oldest first), in your building before the rest', () => {
    expect(needQueue(all, 'work').map((x) => x.id)).toEqual(['blocked-old', 'blocked-new', 'done-old', 'done-new', 'lot-blocked', 'lot-done']);
    expect(needQueue(all, 'work').map((x) => x.reason)).toEqual(['blocked', 'blocked', 'done', 'done', 'blocked', 'done']);
  });

  it('in the lot, the lot comes first; in the city, only the wait counts', () => {
    expect(needQueue(all, null).map((x) => x.id)).toEqual(['lot-blocked', 'lot-done', 'blocked-old', 'blocked-new', 'done-old', 'done-new']);
    expect(needQueue(all).map((x) => x.id)).toEqual(['lot-blocked', 'blocked-old', 'blocked-new', 'lot-done', 'done-old', 'done-new']);
  });

  it('#98: leaves out those waiting on their own background tasks', () => {
    const q = needQueue([w('waits', 'waiting', 1), w('done', 'done', 2), w('idle', 'idle', 0)], 'work');
    expect(q.map((x) => x.id)).toEqual(['done']);
  });

  it('breaks ties by floor, then desk', () => {
    const q = needQueue([w('b', 'needs_you', 5, { floor: 'top', desk: 3 }), w('a', 'needs_you', 5, { floor: 'top', desk: 1 }), w('c', 'needs_you', 5, { floor: 'bottom', desk: 9 })], 'work');
    expect(q.map((x) => x.id)).toEqual(['c', 'a', 'b']);
  });
});

describe('nextNeed', () => {
  const q = needQueue([w('a', 'needs_you', 1), w('b', 'needs_you', 2), w('c', 'done', 3)], 'work');
  it('starts at the front and cycles on repeated N', () => {
    const seen: string[] = [];
    let last: string | null = null;
    for (let i = 0; i < 5; i++) {
      last = nextNeed(q, last)?.id ?? null;
      seen.push(last ?? '');
    }
    expect(seen).toEqual(['a', 'b', 'c', 'a', 'b']);
  });
  it('starts over when the last one no longer needs you', () => {
    expect(nextNeed(q, 'gone')?.id).toBe('a');
    expect(nextNeed([], 'a')).toBeNull();
  });
});

describe('faceSpots', () => {
  it('stands behind the chair first, facing the worker', () => {
    // A worker facing south (+z) at (5, 5): behind it is north, and you look south at it.
    const [behind, side, other, across] = faceSpots({ x: 5, z: 5 }, 0);
    expect(behind).toMatchObject({ x: 5, z: 3.2, pitch: -0.13 });
    expect(Math.abs(behind?.yaw ?? 0)).toBeCloseTo(Math.PI, 3);
    expect(side?.z).toBeCloseTo(5);
    expect(other?.z).toBeCloseTo(5);
    expect(Math.abs((side?.x ?? 0) - 5)).toBeCloseTo(1.5);
    expect(across).toMatchObject({ x: 5, z: 7, yaw: 0 });
  });
  it('faces the seat from every spot (walker forward = (-sin yaw, -cos yaw))', () => {
    const seat = { x: 2, z: 7 };
    for (const s of faceSpots(seat, 1.1)) {
      const d = Math.hypot(seat.x - s.x, seat.z - s.z);
      expect(-Math.sin(s.yaw)).toBeCloseTo((seat.x - s.x) / d, 3);
      expect(-Math.cos(s.yaw)).toBeCloseTo((seat.z - s.z) / d, 3);
    }
  });
});
