import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type CDPSession, type Page } from '@playwright/test';
import { frames, openGame, RESULTS } from './game';
import { Layers, metrics, summarise, trace, traceWhile, type TraceEvent } from './perfTrace';

// #145 perf: the overview page's own cost, m58's trace method (perfTrace.ts) on the page open over a busy floor
// (perf-floor60: 60 workers, 36 working, 6 needing you) and the whole city (perf-city240's all-floors page). The 3D
// scene under the page is stopped first so only the page is measured: a runtime counterfactual (the document reads as
// hidden, so the app stops its frame loop as for a hidden tab; #143 pauses the scene under the page for real), the page
// itself left as it is. Per fixture: the open page left alone for H3D_PERF_MS (default 60 s): paints, style recalcs
// (count and time), layouts, the compositor's layers, the main thread's busy time; then its board scrolled down and up
// by the wheel for up to 15 s: the gaps between frames. And on perf-floor96 (96 rows needing you) what an open costs
// the main thread, the first and three more: the key's own handler and the time to the end of the first frame after it.
// The numbers go to test-results/h145-overview-perf.json (run it on the base and the head build, same host, to compare:
// docs/decisions.md #145). Opt-in: H3D_PERF=1.

const MS = Number(process.env.H3D_PERF_MS) || 60_000;
const SCROLL_MS = Math.min(MS, 15_000);

test.skip(!process.env.H3D_PERF, 'perf run: H3D_PERF=1');

/** The app's frame loop stops as for a hidden tab: the scene draws nothing more, the page goes on. */
async function stopScene(page: Page): Promise<void> {
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

async function openPage(page: Page): Promise<void> {
  await page.keyboard.press('KeyO');
  await expect.poll(() => page.evaluate(() => window.__h3d.overview()?.page?.open)).toBe(true);
  await expect(page.locator('.ov')).not.toHaveClass(/ov--enter/, { timeout: 5000 });
}

const round = (x: number) => Math.round(x * 10) / 10;

/** The open page left alone. */
async function idle(page: Page, cdp: CDPSession, layers: Layers) {
  const before = await metrics(cdp);
  const f0 = await page.evaluate(() => window.__h3d.frames);
  const events = await trace(cdp, MS);
  const after = await metrics(cdp);
  const d = (k: string) => {
    const v = (after[k] ?? 0) - (before[k] ?? 0);
    return k.endsWith('Duration') ? Math.round(v * 1000) : v;
  };
  return {
    ...summarise(events, MS),
    sceneFrames: (await page.evaluate(() => window.__h3d.frames)) - f0,
    metrics: { TaskDuration: d('TaskDuration'), ScriptDuration: d('ScriptDuration'), RecalcStyleDuration: d('RecalcStyleDuration'), RecalcStyleCount: d('RecalcStyleCount'), LayoutDuration: d('LayoutDuration'), LayoutCount: d('LayoutCount') },
    layerCount: layers.last.length,
    // Endless animations on the page, and those in rows whose contents are drawn (a skipped row's are not).
    animations: await page.evaluate(() => {
      const all = document.getAnimations().filter((a) => a.effect?.getComputedTiming().iterations === Infinity && (a.effect as KeyframeEffect).target?.closest('.ov'));
      const drawn = all.filter((a) => (a.effect as KeyframeEffect).target?.closest('.ov-row')?.querySelector('.ov-name')?.checkVisibility({ contentVisibilityAuto: true }) ?? true);
      return { all: all.length, drawn: drawn.length };
    }),
  };
}

/** The board scrolled by the wheel, down to its end and up again, for SCROLL_MS: the gaps between frames. */
async function scroll(page: Page, cdp: CDPSession) {
  const board = page.locator('.ov-board');
  const box = await board.boundingBox();
  if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.evaluate(() => {
    const w = window as unknown as { h145: { gaps: number[]; on: boolean } };
    w.h145 = { gaps: [], on: true };
    let last = 0;
    const loop = (t: number) => {
      if (last) w.h145.gaps.push(t - last);
      last = t;
      if (w.h145.on) requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  });
  let dir = 1;
  const events = await traceWhile(cdp, async () => {
    const end = Date.now() + SCROLL_MS;
    for (let i = 0; Date.now() < end; i++) {
      await page.mouse.wheel(0, dir * 200);
      await page.waitForTimeout(40);
      if (i % 5 === 4) {
        const at = await board.evaluate((b) => ({ top: b.scrollTop, max: b.scrollHeight - b.clientHeight }));
        if (dir > 0 && at.top >= at.max - 1) dir = -1;
        else if (dir < 0 && at.top <= 0) dir = 1;
      }
    }
  });
  const gaps = await page.evaluate(() => {
    const w = window as unknown as { h145: { gaps: number[]; on: boolean } };
    w.h145.on = false;
    return w.h145.gaps;
  });
  const sorted = [...gaps].sort((a, b) => a - b);
  const q = (p: number) => round(sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0);
  const s = summarise(events, SCROLL_MS);
  return { seconds: SCROLL_MS / 1000, frames: gaps.length, gapMs: { p50: q(0.5), p95: q(0.95), p99: q(0.99), max: round(sorted.at(-1) ?? 0) }, over25ms: gaps.filter((g) => g > 25).length, paints: s.paints, recalcStyles: s.recalcStyles, layouts: s.layouts, styleMs: s.styleMs, layoutMs: s.layoutMs, paintMs: s.paintMs, longTasks: s.longTasks, busyMs: s.busyMs };
}

/** What an open costs the main thread: the key's own handler and the time from it to the end of the first frame after. */
function openCost(events: TraceEvent[]) {
  const threads = new Map<string, string>();
  for (const e of events) if (e.ph === 'M' && e.name === 'thread_name' && e.args?.name) threads.set(`${e.pid}:${e.tid}`, e.args.name);
  const main = events.filter((e) => e.ph === 'X' && threads.get(`${e.pid}:${e.tid}`) === 'CrRendererMain');
  const key = main.find((e) => e.name === 'EventDispatch' && (e.args?.data as { type?: string } | undefined)?.type === 'keydown');
  if (!key) return null;
  const frame = main.filter((e) => e.name === 'ProxyMain::BeginMainFrame' && e.ts >= key.ts + (key.dur ?? 0)).sort((a, b) => a.ts - b.ts)[0];
  const end = frame ? frame.ts + (frame.dur ?? 0) : key.ts + (key.dur ?? 0);
  const within = (n: string, from: number, to: number) => round(main.filter((e) => e.name === n && e.ts >= from && e.ts + (e.dur ?? 0) <= to).reduce((a, e) => a + (e.dur ?? 0) / 1000, 0));
  const k0 = key.ts;
  const k1 = key.ts + (key.dur ?? 0);
  return {
    keydownMs: round((key.dur ?? 0) / 1000),
    layoutInKeydownMs: within('Layout', k0, k1),
    firstFrameMs: round((frame?.dur ?? 0) / 1000),
    toFirstFrameEndMs: round((end - k0) / 1000),
    styleMs: within('UpdateLayoutTree', k0, end),
    layoutMs: within('Layout', k0, end),
    paintMs: within('Paint', k0, end),
  };
}

async function perfOverview(page: Page, fixture: 'perf-floor60' | 'perf-city240') {
  await openGame(page, fixture, '&screens=0');
  if (fixture === 'perf-floor60') await page.evaluate(() => window.__h3d.enterFloor('perf-floor'));
  await frames(page, 3);
  await page.waitForTimeout(fixture === 'perf-city240' ? 2500 : 500);
  await openPage(page);
  const rows = (await page.evaluate(() => window.__h3d.overview()?.page?.rows.length)) ?? 0;
  await stopScene(page);
  await page.waitForTimeout(1000);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  const layers = new Layers(cdp);
  await cdp.send('LayerTree.enable');
  await page.waitForTimeout(500);
  const open = await idle(page, cdp, layers);
  const scrolled = await scroll(page, cdp);
  await cdp.detach();
  return { rows, idle: open, scroll: scrolled };
}

test('the overview page alone: idle and scrolling on perf-floor60 and perf-city240, opening on perf-floor96', { tag: '@perf' }, async ({ browser }) => {
  test.setTimeout(2 * (MS + SCROLL_MS) + 300_000);
  const out: Record<string, unknown> = { ms: MS, scrollMs: SCROLL_MS };
  for (const fixture of ['perf-floor60', 'perf-city240'] as const) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    const r = await perfOverview(page, fixture);
    expect(r.rows).toBeGreaterThan(50);
    out[fixture] = r;
    console.log(`h145 ${fixture}: ${JSON.stringify(r)}`);
    await page.close();
  }
  // Opening: the first open of the page, then three more (closed between, a second apart).
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await openGame(page, 'perf-floor96', '&screens=0');
  await page.evaluate(() => window.__h3d.enterFloor('perf-floor96'));
  await frames(page, 3);
  await page.waitForTimeout(1000);
  await stopScene(page);
  await page.waitForTimeout(500);
  const cdp = await page.context().newCDPSession(page);
  const opens = [];
  for (let i = 0; i < 4; i++) {
    const events = await traceWhile(cdp, async () => {
      await page.keyboard.press('KeyO');
      await page.waitForTimeout(800);
    });
    await expect.poll(() => page.evaluate(() => window.__h3d.overview()?.page?.rows.length)).toBe(96);
    // The rows the open drew (their ring running): those near the view, unless the open drew them all.
    const rings = await page.evaluate(() => {
      const all = document.getAnimations().filter((a) => a.effect?.getComputedTiming().iterations === Infinity);
      return { all: all.length, drawn: all.filter((a) => (a.effect as KeyframeEffect).target?.closest('.ov-row')?.querySelector('.ov-name')?.checkVisibility({ contentVisibilityAuto: true }) ?? true).length };
    });
    const cost = openCost(events);
    opens.push(cost && { ...cost, rings });
    await expect(page.locator('.ov')).not.toHaveClass(/ov--enter/, { timeout: 5000 });
    await page.keyboard.press('Escape');
    await expect.poll(() => page.evaluate(() => window.__h3d.overview()?.page?.open)).toBe(false);
    await page.waitForTimeout(1000);
  }
  out['perf-floor96-open'] = { first: opens[0], again: opens.slice(1) };
  console.log(`h145 perf-floor96 open: ${JSON.stringify(out['perf-floor96-open'])}`);
  mkdirSync(RESULTS, { recursive: true });
  const name = `h145-overview-perf${process.env.H3D_DIST ? `-${process.env.H3D_DIST}` : ''}.json`;
  writeFileSync(resolve(RESULTS, name), `${JSON.stringify(out, null, 2)}\n`);
  expect(opens.every((o) => o !== null)).toBe(true);
});
