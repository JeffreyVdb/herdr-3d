import { describe, expect, it } from 'vitest';
import { BOARD_TEX, containIn, staleLines } from './whiteboardTexture';

describe('the room whiteboard face', () => {
  it('keeps the render in proportion, centred', () => {
    expect(containIn(2400, 1200, BOARD_TEX)).toEqual({ x: 240, y: 24, w: 1568, h: 784 });
    expect(containIn(4000, 400, BOARD_TEX)).toEqual({ x: 24, y: 316, w: 2000, h: 200 });
  });

  it('lists the newest stale pins', () => {
    const pin = (i: number) => ({ id: `p${i}`, kind: i % 2 ? 'image' : 'note', author: `A${i}`, note: `n${i}`, version: i, at: 0 });
    expect(staleLines({ stale_pins: [pin(1), pin(2)] })).toEqual(['A1: an image', 'A2: n2']);
    expect(staleLines({ stale_pins: [1, 2, 3, 4, 5, 6].map(pin) })).toEqual(['… and 2 more', 'A3: an image', 'A4: n4', 'A5: an image', 'A6: n6']);
  });
});
