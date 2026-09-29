import { describe, expect, it } from 'vitest';
import { DEFAULT_SCREENS, screensParam, WatchPlanner, type Candidate } from './screens';

/** Laptops in a row along x, every 2 m; you stand at `x` looking along +x (`back`: looking the other way). */
function row(x: number, count = 12, back = false): Candidate[] {
  return Array.from({ length: count }, (_, i) => {
    const lx = i * 2;
    return { id: `w${i}`, dist: Math.abs(lx - x) + 0.5, visible: back ? lx <= x : lx >= x - 0.5 };
  });
}

describe('screensParam', () => {
  it('reads screens=<n>, capped; bad values keep the default', () => {
    expect(screensParam(null)).toBe(4);
    expect(screensParam('0')).toBe(0);
    expect(screensParam('2')).toBe(2);
    expect(screensParam('99')).toBe(5);
    expect(screensParam('-1')).toBe(4);
    expect(screensParam('x')).toBe(4);
  });
});

describe('WatchPlanner', () => {
  it('watches the nearest n visible laptops in range', () => {
    const p = new WatchPlanner();
    const plan = p.plan(0, row(0));
    expect(plan.watch).toEqual(['w0', 'w1', 'w2', 'w3']);
    expect(plan.unwatch).toEqual([]);
    expect(p.live).toEqual(['w0', 'w1', 'w2', 'w3']);
    // Nothing changes standing still.
    expect(p.plan(250, row(0))).toEqual({ watch: [], unwatch: [] });
  });

  it('n = 0 watches nothing, and lowering n drops the farthest', () => {
    const p = new WatchPlanner();
    expect(p.plan(0, row(0), 0).watch).toEqual([]);
    p.plan(10, row(0), 4);
    expect(p.plan(20, row(0), 2)).toEqual({ watch: [], unwatch: ['w3', 'w2'] });
  });

  it('skips laptops out of view or out of range', () => {
    const p = new WatchPlanner();
    const c: Candidate[] = [
      { id: 'behind', dist: 1, visible: false },
      { id: 'far', dist: DEFAULT_SCREENS.range + 1, visible: true },
      { id: 'near', dist: 3, visible: true },
    ];
    expect(p.plan(0, c).watch).toEqual(['near']);
  });

  it('keeps a laptop live through a short look away, drops it after the grace', () => {
    const p = new WatchPlanner();
    p.plan(0, row(0));
    const away = row(0).map((x) => ({ ...x, visible: false }));
    expect(p.plan(1000, away)).toEqual({ watch: [], unwatch: [] });
    expect(p.plan(2000, row(0))).toEqual({ watch: [], unwatch: [] });
    expect(p.plan(3000, away).unwatch).toEqual([]);
    expect(p.plan(3000 + DEFAULT_SCREENS.graceMs + 1, away).unwatch.sort()).toEqual(['w0', 'w1', 'w2', 'w3']);
  });

  it('drops a laptop that leaves the floor (or its keep range) at once', () => {
    const p = new WatchPlanner();
    p.plan(0, row(0));
    expect(p.plan(100, row(0).filter((x) => x.id !== 'w1')).unwatch).toEqual(['w1']);
    // The freed slot goes to the next nearest.
    expect(p.live).toEqual(['w0', 'w2', 'w3', 'w4']);
  });

  it('walking down the row swaps screens one at a time, with hysteresis', () => {
    const p = new WatchPlanner();
    let watches = 0;
    let unwatches = 0;
    const seen: string[][] = [];
    // 2.3 m/s for 7 s, a plan every 250 ms (what the game does).
    for (let t = 0; t <= 7000; t += 250) {
      const x = (t / 1000) * 2.3;
      const plan = p.plan(t, row(x));
      watches += plan.watch.length;
      unwatches += plan.unwatch.length;
      expect(plan.watch.length).toBeLessThanOrEqual(4);
      expect(p.live.length).toBeLessThanOrEqual(4);
      seen.push(p.live);
    }
    // 16 m walked along 12 laptops: each is watched once at most, none flickers.
    expect(watches).toBeLessThanOrEqual(12);
    expect(unwatches).toBe(watches - p.live.length);
    // Near the end of the row the four ahead are live.
    expect(seen.at(-1)?.sort()).toEqual(['w10', 'w11', 'w8', 'w9']);
  });

  it('standing between two laptops with a jittering distance does not churn', () => {
    const p = new WatchPlanner();
    const cands = (j: number): Candidate[] =>
      Array.from({ length: 6 }, (_, i) => ({ id: `w${i}`, dist: 2 + i * 0.4 + (i % 2 ? j : -j), visible: true }));
    p.plan(0, cands(0));
    let changes = 0;
    for (let t = 250; t < 20_000; t += 250) {
      const plan = p.plan(t, cands(Math.sin(t / 300) * 0.3));
      changes += plan.watch.length + plan.unwatch.length;
    }
    expect(changes).toBe(0);
  });

  it('turning round keeps the old screens for the grace, then moves to what you face', () => {
    const p = new WatchPlanner();
    p.plan(0, row(10));
    expect(p.live).toEqual(['w5', 'w6', 'w7', 'w8']);
    // Turned round: w5 is still in view; the others go after the grace, the ones behind come in.
    const back = row(10, 12, true);
    expect(p.plan(500, back).watch).toEqual([]);
    const later = p.plan(500 + DEFAULT_SCREENS.graceMs + 1, back);
    expect(later.unwatch.sort()).toEqual(['w6', 'w7', 'w8']);
    expect(later.watch).toEqual(['w4', 'w3', 'w2']);
  });

  it('backs off a refused watch, and forgets a closed one', () => {
    const p = new WatchPlanner();
    p.plan(0, row(0));
    p.failed('w0', 100);
    expect(p.has('w0')).toBe(false);
    expect(p.plan(200, row(0)).watch).toEqual(['w4']);
    p.forget('w4');
    expect(p.plan(300, row(0)).watch).toEqual(['w4']);
    // Retried once the back-off is over and a slot is free.
    p.clear();
    expect(p.plan(100 + DEFAULT_SCREENS.retryMs + 1, row(0)).watch).toEqual(['w0', 'w1', 'w2', 'w3']);
  });
});
