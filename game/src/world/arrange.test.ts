import { describe, expect, it } from 'vitest';
import { buildingOrder, floorMove } from './arrange';

// Floors top to bottom as the store lists them; `index` counts sessions that are gone too.
const stack = (...xs: Array<[string, number]>) => xs.map(([session, index]) => ({ session, floor: { index } }));

describe('floorMove', () => {
  it('moves a floor one place up or down by taking its neighbour’s index', () => {
    const s = stack(['a', 0], ['b', 1], ['c', 2]);
    expect(floorMove(s, 'b', 'b1', -1)).toEqual({ session: 'b', building: 'b1', index: 0 });
    expect(floorMove(s, 'b', 'b1', 1)).toEqual({ session: 'b', building: 'b1', index: 2 });
    expect(floorMove(s, 'a', 'b1', -1)).toBeNull();
    expect(floorMove(s, 'c', 'b1', 1)).toBeNull();
    expect(floorMove(s, 'x', 'b1', 1)).toBeNull();
  });

  it('skips positions held by sessions that do not exist right now', () => {
    // A gone session holds index 1: moving b up must pass a, not just the ghost.
    const s = stack(['a', 0], ['b', 2]);
    expect(floorMove(s, 'b', 'b1', -1)).toEqual({ session: 'b', building: 'b1', index: 0 });
    expect(floorMove(s, 'a', 'b1', 1)).toEqual({ session: 'a', building: 'b1', index: 2 });
  });
});

describe('buildingOrder', () => {
  it('swaps a building with its neighbour and lists every id', () => {
    expect(buildingOrder(['w', 'p', 'l'], 'p', -1)).toEqual(['p', 'w', 'l']);
    expect(buildingOrder(['w', 'p', 'l'], 'p', 1)).toEqual(['w', 'l', 'p']);
    expect(buildingOrder(['w', 'p'], 'w', -1)).toBeNull();
    expect(buildingOrder(['w', 'p'], 'p', 1)).toBeNull();
    expect(buildingOrder(['w'], 'x', 1)).toBeNull();
  });
});
