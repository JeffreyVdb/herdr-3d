import { describe, expect, it } from 'vitest';
import type { HostStats } from '../net/protocol';
import { barTone, hudLine, HostWatchGate, ledLevel, memText, pctText, rackLevels, rackMode, sampleClock, updatesText } from './hostStats';

const disk = (name: string, r: number, w: number) => ({ name, r_iops: r, w_iops: w, r_bps: 0, w_bps: 0 });

describe('barTone', () => {
  it('is green up to 75 %, amber above it, red above 90 %', () => {
    expect([0, 40, 75].map(barTone)).toEqual(['ok', 'ok', 'ok']);
    expect([75.1, 80, 90].map(barTone)).toEqual(['warn', 'warn', 'warn']);
    expect([90.1, 99, 100].map(barTone)).toEqual(['hot', 'hot', 'hot']);
  });
});

describe('ledLevel', () => {
  it('goes from dark to near solid on a log scale of operations a second', () => {
    expect(ledLevel(0)).toBe(0);
    expect(ledLevel(-3)).toBe(0);
    expect(ledLevel(Number.NaN)).toBe(0);
    expect(ledLevel(0.01)).toBe(0);
    expect(ledLevel(1)).toBeGreaterThan(0.05); // an occasional blip
    expect(ledLevel(1)).toBeLessThan(0.15);
    expect(ledLevel(100)).toBeGreaterThan(0.4); // a steady flicker
    expect(ledLevel(100)).toBeLessThan(0.65);
    expect(ledLevel(5000)).toBe(1); // near solid
    expect(ledLevel(80_000)).toBe(1);
    let prev = -1;
    for (const x of [0, 1, 3, 10, 30, 100, 300, 1000, 3000, 5000]) {
      expect(ledLevel(x)).toBeGreaterThanOrEqual(prev);
      prev = ledLevel(x);
    }
  });
});

describe('rackLevels', () => {
  it('maps disk i to server i, read then write', () => {
    const l = rackLevels([disk('nvme0n1', 100, 5000), disk('sda', 0, 1)], 3);
    expect(l).toHaveLength(6);
    expect(l.slice(0, 4)).toEqual([ledLevel(100), ledLevel(5000), 0, ledLevel(1)]);
  });
  it('has the servers past the last disk mirror the total of all disks', () => {
    const l = rackLevels([disk('nvme0n1', 60, 40), disk('sda', 40, 10)], 4);
    expect(l.slice(4)).toEqual([ledLevel(100), ledLevel(50), ledLevel(100), ledLevel(50)]);
    const one = rackLevels([disk('nvme0n1', 12, 240)], 5);
    expect(one.slice(2)).toEqual([ledLevel(12), ledLevel(240), ledLevel(12), ledLevel(240), ledLevel(12), ledLevel(240), ledLevel(12), ledLevel(240)]);
  });
  it('is dark with no live data, and ignores disks past the last server', () => {
    expect(rackLevels(null, 2)).toEqual([0, 0, 0, 0]);
    expect(rackLevels([], 2)).toEqual([0, 0, 0, 0]);
    expect(rackLevels([disk('a', 1, 1), disk('b', 1, 1), disk('c', 1, 1)], 2)).toHaveLength(4);
  });
});

describe('texts', () => {
  it('formats the screen and the HUD', () => {
    expect(pctText(12.4)).toBe('12%');
    expect(pctText(99.5)).toBe('100%');
    expect(pctText(null)).toBe('—');
    expect(memText(13.5 * 2 ** 30, 31.25 * 2 ** 30)).toBe('13.5 / 31.3 GiB');
    expect(updatesText(undefined)).toBeNull();
    expect(updatesText({ count: 0, checked_at: 'x' })).toBe('Up to date');
    expect(updatesText({ count: 1, checked_at: 'x' })).toBe('1 update pending');
    expect(updatesText({ count: 3, checked_at: 'x' })).toBe('3 updates pending');
    expect(sampleClock('nope')).toBe('--:--:--');
    expect(sampleClock(new Date(2026, 9, 16, 9, 5, 7).toISOString())).toBe('09:05:07');
    const f = { cpu_pct: 12.4, mem_used_pct: 41.3 } as HostStats;
    expect(hudLine(f, false)).toBe('CPU 12% · Mem 41%');
    expect(hudLine({ ...f, cpu_pct: null }, false)).toBe('CPU — · Mem 41%');
    expect(hudLine(null, false)).toBe('Reading the host…');
    expect(hudLine(f, true)).toBe('No host stats on this bridge');
  });
});

describe('rackMode', () => {
  const base = { unsupported: false, hasFrame: true, watching: true, stale: false };
  it('picks the screen', () => {
    expect(rackMode({ ...base, unsupported: true })).toBe('unsupported');
    expect(rackMode({ ...base, hasFrame: false })).toBe('waiting');
    expect(rackMode({ ...base, hasFrame: false, watching: false })).toBe('idle');
    expect(rackMode(base)).toBe('live');
    expect(rackMode({ ...base, watching: false })).toBe('dim');
    expect(rackMode({ ...base, stale: true })).toBe('stale');
    expect(rackMode({ ...base, stale: true, watching: false })).toBe('dim');
  });
});

describe('HostWatchGate', () => {
  it('watches after 300 ms of being wanted, and not before', () => {
    const g = new HostWatchGate();
    expect(g.step(1000, true)).toBeNull();
    expect(g.step(1299, true)).toBeNull();
    expect(g.step(1300, true)).toBe('watch');
    expect(g.watching).toBe(true);
    expect(g.step(1400, true)).toBeNull(); // once
  });
  it('does not watch for a glimpse', () => {
    const g = new HostWatchGate();
    g.step(0, true);
    g.step(200, false);
    expect(g.step(400, true)).toBeNull(); // the clock starts again
    expect(g.step(699, true)).toBeNull();
    expect(g.step(700, true)).toBe('watch');
  });
  it('unwatches 10 s after it stops being wanted, and a look back in between keeps the watch', () => {
    const g = new HostWatchGate();
    g.step(0, true);
    g.step(300, true);
    expect(g.step(1000, false)).toBeNull();
    expect(g.step(10_999, false)).toBeNull();
    expect(g.step(5000, true)).toBeNull(); // back: no unwatch, and the off clock is gone
    expect(g.step(6000, false)).toBeNull();
    expect(g.step(15_999, false)).toBeNull();
    expect(g.step(16_000, false)).toBe('unwatch');
    expect(g.watching).toBe(false);
    expect(g.step(17_000, false)).toBeNull();
  });
  it('releases at once, and a reset sends nothing', () => {
    const g = new HostWatchGate();
    expect(g.release()).toBeNull();
    g.step(0, true);
    g.step(300, true);
    expect(g.release()).toBe('unwatch');
    expect(g.watching).toBe(false);
    expect(g.release()).toBeNull();
    g.step(1000, true);
    g.step(1300, true);
    g.reset();
    expect(g.watching).toBe(false);
    expect(g.step(1400, true)).toBeNull(); // the 300 ms count again
    expect(g.step(1700, true)).toBe('watch');
  });
});
