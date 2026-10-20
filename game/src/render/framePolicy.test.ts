import { describe, expect, it } from 'vitest';
import { ACTIVE_WINDOW_MS, OPAQUE_HZ, SCRIM_HZ, shouldRender, targetHz } from './framePolicy';

describe('targetHz', () => {
  it.each([
    [{ hidden: true, batterySaver: false, sinceActivity: 0 }, 0],
    [{ hidden: false, batterySaver: false, sinceActivity: 0 }, 120],
    [{ hidden: false, batterySaver: false, sinceActivity: ACTIVE_WINDOW_MS + 1 }, 60],
    [{ hidden: false, batterySaver: true, sinceActivity: 0 }, 60],
    [{ hidden: false, batterySaver: true, sinceActivity: ACTIVE_WINDOW_MS + 1 }, 30],
    [{ hidden: true, batterySaver: true, sinceActivity: 0 }, 0],
  ])('%j -> %i Hz', (inp, hz) => {
    expect(targetHz(inp)).toBe(hz);
  });

  // #143: a full-screen layer over the scene caps the rate, whatever else holds it up.
  it.each([
    [{ hidden: false, batterySaver: false, sinceActivity: 0, covered: 'none' as const }, 120],
    [{ hidden: false, batterySaver: true, sinceActivity: ACTIVE_WINDOW_MS + 1, covered: 'none' as const }, 30],
    [{ hidden: false, batterySaver: false, sinceActivity: 0, covered: 'opaque' as const }, OPAQUE_HZ],
    [{ hidden: false, batterySaver: false, sinceActivity: ACTIVE_WINDOW_MS + 1, covered: 'opaque' as const }, OPAQUE_HZ],
    [{ hidden: false, batterySaver: true, sinceActivity: 0, covered: 'opaque' as const }, OPAQUE_HZ],
    [{ hidden: true, batterySaver: false, sinceActivity: 0, covered: 'opaque' as const }, 0],
    [{ hidden: false, batterySaver: false, sinceActivity: 0, covered: 'scrim' as const }, SCRIM_HZ],
    [{ hidden: false, batterySaver: false, sinceActivity: ACTIVE_WINDOW_MS + 1, covered: 'scrim' as const }, SCRIM_HZ],
    [{ hidden: false, batterySaver: true, sinceActivity: ACTIVE_WINDOW_MS + 1, covered: 'scrim' as const }, SCRIM_HZ],
    [{ hidden: true, batterySaver: true, sinceActivity: 0, covered: 'scrim' as const }, 0],
  ])('%j -> %i Hz', (inp, hz) => {
    expect(targetHz(inp)).toBe(hz);
  });

  it('caps below every uncovered rate, opaque below scrim', () => {
    expect(OPAQUE_HZ).toBeLessThan(SCRIM_HZ);
    expect(SCRIM_HZ).toBeLessThan(30);
  });
});

describe('shouldRender', () => {
  /** Frames rendered out of `n` display vsyncs at `displayHz`. */
  const rendered = (displayHz: number, hz: number, n = 120) => {
    let last = -Infinity;
    let count = 0;
    for (let i = 0; i < n; i++) {
      const t = (i * 1000) / displayHz;
      if (shouldRender(t, last, hz)) {
        last = t;
        count++;
      }
    }
    return count;
  };
  it('renders every vsync at the display rate', () => {
    expect(rendered(120, 120)).toBe(120);
    expect(rendered(60, 60)).toBe(120);
  });
  it('halves the rate on a 120 Hz display when idle', () => {
    expect(rendered(120, 60)).toBe(60);
  });
  it('stays within 30–40 Hz for battery-saver idle', () => {
    const n = rendered(120, 30);
    expect(n).toBeGreaterThanOrEqual(30);
    expect(n).toBeLessThanOrEqual(40);
  });
  it('renders the opaque cap at about one frame a second more than it asks, on 60 and 120 Hz displays (#143)', () => {
    // 2 s of vsyncs: the quarter-frame slack rounds the 250 ms period down to the vsync at or past 187.5 ms.
    expect(rendered(60, OPAQUE_HZ, 120)).toBe(10); // every 200 ms
    expect(rendered(120, OPAQUE_HZ, 240)).toBeLessThanOrEqual(11); // every ~192 ms
    expect(rendered(120, OPAQUE_HZ, 240)).toBeGreaterThanOrEqual(2 * OPAQUE_HZ);
  });
  it('never renders when paused', () => {
    expect(rendered(120, 0)).toBe(0);
  });
});
