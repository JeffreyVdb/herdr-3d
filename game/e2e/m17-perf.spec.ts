import { expect, test, type Browser } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { frames, openGame, RESULTS } from './game';

// M17 perf: the office at night has its own lamps (a constant set of non-shadow spot lights, dimmed by day, never
// added or removed), the street a tint and the lamps' pools. perf-floor60 (60 workers), shadows on, looking across the
// desks and out of the windows: night against noon, each on a page of its own (the first closed before the next, so two
// runs never share the CPU). The numbers go to test-results/m17-perf.json (the server's WebGL2 llvmpipe run).
// H3D_M17_RUNS=<n> alternates n day/night pairs (for the decisions log); H3D_DIST=<a pre-M17 build> gives the baseline
// (`?time=` is ignored there, both runs are its noon).

type Bench = Awaited<ReturnType<Window['__h3d']['bench']>>;

async function run(browser: Browser, time: string): Promise<{ bench: Bench; daylight: number | null; lamps: number[] }> {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await ctx.newPage();
  await openGame(page, 'perf-floor60', `&time=2026-09-30T${time}&tz=Europe/Brussels`, 'play=none');
  await page.evaluate(() => window.__h3d.enterFloor('perf-floor'));
  const L = await page.evaluate(() => window.__h3d.layout('perf-floor'));
  await page.evaluate((d) => window.__h3d.setPose({ x: 2, z: d / 2, yaw: -Math.PI / 2, pitch: 0.05 }), (L as NonNullable<typeof L>).depth);
  await frames(page, 20);
  const bench = await page.evaluate(() => window.__h3d.bench({ frames: 40, warm: 10, pipelined: false, raf: false }));
  const d = await page.evaluate(() => (typeof window.__h3d.daylight === 'function' ? window.__h3d.daylight() : null));
  await ctx.close();
  return { bench, daylight: d?.daylight ?? null, lamps: d?.lamps ?? [] };
}

test('the office at night (its own lamps, the tinted street) stays in the frame budget of noon', async ({ browser }) => {
  // 50-frame serialized benches at 90-200 ms a frame on llvmpipe, and `make e2e` runs six tests at once.
  const runs = Math.max(1, Number(process.env.H3D_M17_RUNS) || 1);
  test.setTimeout(240_000 * runs);
  const out: Array<{ day: Bench; night: Bench }> = [];
  let lamps: number[] = [];
  for (let i = 0; i < runs; i++) {
    const day = await run(browser, '12:00');
    const night = await run(browser, '23:00');
    lamps = night.lamps;
    if (night.daylight !== null) expect([day.daylight, night.daylight]).toEqual([1, 0]);
    out.push({ day: day.bench, night: night.bench });
    console.log(`m17 perf ${i + 1}/${runs}: day frame ${day.bench.frameMs.med} ms (p95 ${day.bench.frameMs.p95}), ${day.bench.drawCalls} draws; night ${night.bench.frameMs.med} ms (p95 ${night.bench.frameMs.p95}), ${night.bench.drawCalls} draws`);
  }
  const med = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] as number;
  const summary = {
    backend: out[0]?.day.backend,
    dist: process.env.H3D_DIST ?? 'dist',
    lamps,
    dayFrameMs: med(out.map((o) => o.day.frameMs.med)),
    nightFrameMs: med(out.map((o) => o.night.frameMs.med)),
    dayDraws: out[0]?.day.drawCalls,
    nightDraws: out[0]?.night.drawCalls,
  };
  mkdirSync(RESULTS, { recursive: true });
  writeFileSync(resolve(RESULTS, `m17-perf${process.env.H3D_DIST ? `-${process.env.H3D_DIST}` : ''}.json`), JSON.stringify({ summary, runs: out }, null, 2));
  console.log(`m17 perf summary: ${JSON.stringify(summary)}`);
  // The same light set day and night: the same draws; the lamps must not cost a frame's worth (llvmpipe jitters).
  expect(summary.nightDraws).toBe(summary.dayDraws);
  expect(summary.nightFrameMs).toBeLessThan(summary.dayFrameMs * 1.5 + 5);
});
