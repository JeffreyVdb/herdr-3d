import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { frames, openGame, RESULTS } from './game';

// #141 perf: entering a floor. The office's instanced meshes and lamps come from a pool that outlives the office
// (render/floorPool.ts), so entering a floor seen before builds no shader. Each entry is timed from `enterFloor` to
// the next rendered frame, with the longest long-animation-frame of the 1.5 s after it. perf-floor60 is entered three
// times (left for the city between); demo-m3b's four floors twice each, then two of them in turn without leaving.
// The cold ride (the doors path, a new page) is timed from the doors closing to a second after they open: the longest
// frame meanwhile, how long they stayed shut, and the first frame after they start opening.
// Numbers: test-results/h141-floor-entry-perf[-<H3D_DIST>].json. H3D_DIST=<a build of the base> gives the baseline
// (its assertions fail: they are #141's); H3D_141_RUNS=<n> repeats each page n times.

interface Entry {
  floor: string;
  /** First visit of this floor on the page. */
  cold: boolean;
  /** Entered from another floor (no city between). */
  switch: boolean;
  swapMs: number;
  firstFrameMs: number;
  maxLoafMs: number;
}

const RUNS = Math.max(1, Number(process.env.H3D_141_RUNS) || 1);
const med = (xs: number[]) => (xs.length ? ([...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] as number) : NaN);

/** Long animation frames, kept on the page with their start times. */
async function observeFrames(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __loaf: Array<{ at: number; ms: number }> };
    w.__loaf = [];
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) w.__loaf.push({ at: e.startTime, ms: e.duration });
    }).observe({ type: 'long-animation-frame', buffered: false });
  });
}

async function enter(page: Page, floor: string, cold: boolean, sw: boolean): Promise<Entry> {
  const r = await page.evaluate(async (fl) => {
    const w = window as unknown as { __loaf: Array<{ at: number; ms: number }> };
    const f0 = window.__h3d.frames;
    const t0 = performance.now();
    await window.__h3d.enterFloor(fl);
    const t1 = performance.now();
    await new Promise<void>((res) => {
      const chk = () => (window.__h3d.frames > f0 ? res() : requestAnimationFrame(chk));
      requestAnimationFrame(chk);
    });
    const t2 = performance.now();
    await new Promise((res) => setTimeout(res, 1500));
    const loafs = w.__loaf.filter((e) => e.at + e.ms >= t0 && e.at <= t0 + 1500).map((e) => e.ms);
    return { swapMs: Math.round(t1 - t0), firstFrameMs: Math.round(t2 - t0), maxLoafMs: Math.round(Math.max(0, ...loafs)) };
  }, floor);
  return { floor, cold, switch: sw, ...r };
}

async function leave(page: Page): Promise<void> {
  await page.evaluate(() => window.__h3d.leaveFloor());
  await frames(page, 5);
}

/** One page: the floors entered (from the city) `rounds` times each, then `switches` floors in turn without leaving. */
async function entries(page: Page, fixture: string, floors: string[], rounds: number, switches: string[]): Promise<Entry[]> {
  await openGame(page, fixture, '', 'play=none&sim=1&simusage=0');
  await observeFrames(page);
  const out: Entry[] = [];
  const seen = new Set<string>();
  for (let r = 0; r < rounds; r++) {
    for (const f of floors) {
      out.push(await enter(page, f, !seen.has(f), false));
      seen.add(f);
      await leave(page);
    }
  }
  for (const f of switches) {
    out.push(await enter(page, f, !seen.has(f), out.length > 0 && switches.indexOf(f) > 0));
    seen.add(f);
  }
  return out;
}

interface Ride {
  floor: string;
  /** From the doors starting to close to their starting to open. */
  closedMs: number;
  /** The longest frame from the doors starting to close to their starting to open, and in the second after. */
  maxLoafClosedMs: number;
  maxLoafAfterMs: number;
  /** The first frame (rAF to rAF) after the doors start to open. */
  firstOpenFrameMs: number;
}

/** A new page's first ride to `floor` through the elevator doors (no office loaded, nothing compiled for it). */
async function ride(page: Page, fixture: string, floor: string): Promise<Ride> {
  await openGame(page, fixture, '', 'play=none&sim=1&simusage=0');
  await observeFrames(page);
  const r = await page.evaluate(async (fl) => {
    const w = window as unknown as { __loaf: Array<{ at: number; ms: number }> };
    const doors = document.querySelector('.doors') as HTMLElement;
    let closed = NaN;
    let opened = NaN;
    const mo = new MutationObserver(() => {
      const now = performance.now();
      if (doors.classList.contains('is-closed')) closed = Number.isNaN(closed) ? now : closed;
      else if (!Number.isNaN(closed) && Number.isNaN(opened)) opened = now;
    });
    mo.observe(doors, { attributes: true, attributeFilter: ['class'] });
    const ticks: number[] = [];
    let on = true;
    const loop = (t: number) => {
      ticks.push(t);
      if (on) requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
    // The floor list's button: the city's way in, the doors and all.
    (document.querySelector(`.floor-list button[data-floor="${fl}"]`) as HTMLButtonElement).click();
    const t0 = performance.now();
    while (Number.isNaN(opened) && performance.now() - t0 < 20_000) await new Promise((res) => setTimeout(res, 50));
    await new Promise((res) => setTimeout(res, 1000));
    on = false;
    mo.disconnect();
    const after = ticks.filter((t) => t >= opened);
    const firstOpen = after.length >= 2 ? (after[1] as number) - (after[0] as number) : NaN;
    const within = (a: number, b: number) => Math.round(Math.max(0, ...w.__loaf.filter((e) => e.at + e.ms >= a && e.at <= b).map((e) => e.ms)));
    return { closedMs: Math.round(opened - closed), maxLoafClosedMs: within(closed, opened), maxLoafAfterMs: within(opened, opened + 1000), firstOpenFrameMs: Math.round(firstOpen) };
  }, floor);
  return { floor, ...r };
}

test('a floor seen before is entered without rebuilding the office (#141)', { tag: '@perf' }, async ({ browser }) => {
  test.setTimeout(240_000 * RUNS);
  const all: Array<{ page: string; entries: Entry[] }> = [];
  for (let i = 0; i < RUNS; i++) {
    for (const c of [
      { fixture: 'perf-floor60', floors: ['perf-floor'], rounds: 3, switches: [] as string[] },
      { fixture: 'demo-m3b', floors: ['herdr-3d', 'depot-manager', 'pastry', 'scratchpad'], rounds: 2, switches: ['herdr-3d', 'pastry', 'herdr-3d', 'pastry'] },
    ]) {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
      const page = await ctx.newPage();
      all.push({ page: c.fixture, entries: await entries(page, c.fixture, c.floors, c.rounds, c.switches) });
      await ctx.close();
    }
  }
  const warm = all.flatMap((p) => p.entries.filter((e) => !e.cold));
  const summary = {
    dist: process.env.H3D_DIST ?? 'dist',
    warmFirstFrameMs: med(warm.map((e) => e.firstFrameMs)),
    warmFirstFrameMaxMs: Math.max(...warm.map((e) => e.firstFrameMs)),
    warmMaxLoafMs: Math.max(...warm.map((e) => e.maxLoafMs)),
    warmMedLoafMs: med(warm.map((e) => e.maxLoafMs)),
    floor60WarmFirstFrameMs: med(warm.filter((e) => e.floor === 'perf-floor').map((e) => e.firstFrameMs)),
    switchFirstFrameMs: med(warm.filter((e) => e.switch).map((e) => e.firstFrameMs)),
    coldFirstFrameMs: all.map((p) => p.entries[0]?.firstFrameMs ?? NaN),
  };
  mkdirSync(RESULTS, { recursive: true });
  writeFileSync(resolve(RESULTS, `h141-floor-entry-perf${process.env.H3D_DIST ? `-${process.env.H3D_DIST}` : ''}.json`), JSON.stringify({ summary, pages: all }, null, 2));
  for (const p of all) for (const e of p.entries) console.log(`h141 ${p.page} ${e.floor}${e.cold ? ' (cold)' : ''}${e.switch ? ' (switch)' : ''}: first frame ${e.firstFrameMs} ms, swap ${e.swapMs} ms, longest frame ${e.maxLoafMs} ms`);
  console.log(`h141 perf summary: ${JSON.stringify(summary)}`);
  // A warm entry draws its first frame in under half of the 650-835 ms it took before #141, every one of them.
  expect(summary.warmFirstFrameMaxMs).toBeLessThan(350);
});

test('the first ride to a floor keeps every frame short behind the doors (#141)', { tag: '@perf' }, async ({ browser }) => {
  test.setTimeout(120_000 * RUNS);
  const rides: Ride[] = [];
  for (let i = 0; i < RUNS; i++) {
    for (const c of [
      { fixture: 'perf-floor60', floor: 'perf-floor' },
      { fixture: 'demo-m3b', floor: 'pastry' },
    ]) {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
      rides.push(await ride(await ctx.newPage(), c.fixture, c.floor));
      await ctx.close();
    }
  }
  const summary = {
    dist: process.env.H3D_DIST ?? 'dist',
    closedMs: med(rides.map((r) => r.closedMs)),
    maxLoafClosedMs: Math.max(...rides.map((r) => r.maxLoafClosedMs)),
    maxLoafAfterMs: Math.max(...rides.map((r) => r.maxLoafAfterMs)),
    firstOpenFrameMs: Math.max(...rides.map((r) => r.firstOpenFrameMs)),
  };
  mkdirSync(RESULTS, { recursive: true });
  writeFileSync(resolve(RESULTS, `h141-floor-ride-perf${process.env.H3D_DIST ? `-${process.env.H3D_DIST}` : ''}.json`), JSON.stringify({ summary, rides }, null, 2));
  for (const r of rides) console.log(`h141 ride ${r.floor}: doors shut ${r.closedMs} ms, longest frame ${r.maxLoafClosedMs} ms shut / ${r.maxLoafAfterMs} ms after, first frame opening ${r.firstOpenFrameMs} ms`);
  console.log(`h141 ride summary: ${JSON.stringify(summary)}`);
  expect(summary.maxLoafClosedMs).toBeLessThan(350);
  expect(summary.firstOpenFrameMs).toBeLessThanOrEqual(150);
});
