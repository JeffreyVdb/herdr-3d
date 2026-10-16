import { describe, expect, it } from 'vitest';
import { placeY, popRoom } from './fileRefPopover';

// #31 (U2): where the popover goes next to its reference. A short screen has little room on either side; the popover
// then never shrinks below the least (Copy and two lines of the path) and moves over the reference instead.
describe('placeY', () => {
  const room = { top: 100, bottom: 221, left: 0, right: 400 };

  it('goes below the reference when it fits there', () => {
    expect(placeY(60, 50, { top: 120, bottom: 136 }, room)).toEqual({ top: 140, height: 60, side: 'below' });
  });

  it('goes above when only that side has the room', () => {
    expect(placeY(60, 50, { top: 190, bottom: 206 }, room)).toEqual({ top: 126, height: 60, side: 'above' });
  });

  it('takes the roomier side, capped to it, when that is still at least the least', () => {
    expect(placeY(120, 50, { top: 160, bottom: 176 }, room)).toEqual({ top: 100, height: 56, side: 'above' });
  });

  it('keeps the least and moves over the reference, inside the room, when neither side has it', () => {
    const p = placeY(140, 101, { top: 150, bottom: 166 }, room);
    expect(p).toEqual({ top: 120, height: 101, side: 'below' });
    expect(p.top).toBeLessThan(166);
    expect(p.top + p.height).toBeLessThanOrEqual(room.bottom);
  });

  it('above, moved down over the reference only as far as it must', () => {
    const p = placeY(140, 101, { top: 180, bottom: 196 }, room);
    expect(p).toEqual({ top: 100, height: 101, side: 'above' });
  });

  it('never more than its own height, nor more than the room', () => {
    expect(placeY(40, 101, { top: 150, bottom: 166 }, room).height).toBe(40);
    expect(placeY(140, 101, { top: 120, bottom: 136 }, { ...room, bottom: 180 })).toEqual({ top: 100, height: 80, side: 'below' });
  });
});

describe('popRoom', () => {
  it('is the root inside the window, less the margin', () => {
    expect(popRoom({ top: 50, bottom: 300, left: 20, right: 380 }, 400, 800)).toEqual({ top: 56, bottom: 294, left: 26, right: 374 });
    expect(popRoom({ top: -20, bottom: 900, left: -5, right: 500 }, 400, 800)).toEqual({ top: 6, bottom: 794, left: 6, right: 394 });
  });
});
