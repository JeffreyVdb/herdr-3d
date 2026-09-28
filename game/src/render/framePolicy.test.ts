import { describe, expect, it } from 'vitest';
import { ACTIVE_WINDOW_MS, shouldRender, targetHz } from './framePolicy';

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
  it('never renders when paused', () => {
    expect(rendered(120, 0)).toBe(0);
  });
});
