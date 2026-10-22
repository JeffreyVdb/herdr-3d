import { expect, test, type CDPSession, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { frames, leftInTerminal, openGame, RESULTS } from './game';
import { metrics } from './perfTrace';

// #144 perf: a `worker.usage` refreshes only what shows usage. Seated at a laptop on demo-m5 with the sim's usage on
// (`simusage=2000`), the plan-limits plate is the edge tab beside the glass: before #144 every world event placed it
// again, measuring the viewport right after the top bar's writes, a forced layout per event (and the inbox chip asked
// the corner). Here every worker of the floor gets a changed usage in one task, three times: CDP's LayoutCount over each
// burst (its own forced layouts and the frames meanwhile) stays about 0 per event, and the top bar's usage total says
// the new sum at once; the sim's own cadence moves it after. Numbers: test-results/h144-usage-perf.json.

const BURSTS = 3;
/** Layouts per usage event allowed: base is 1 (one forced layout each), head 0 plus the odd frame during a burst. */
const PER_EVENT = 0.25;

async function sitAtLaptop(page: Page): Promise<string> {
  await page.evaluate(() => window.__h3d.enterFloor('herdr-3d'));
  await frames(page, 3);
  const id = await page.evaluate(() => window.__h3d.world().find((f) => f.id === 'herdr-3d')!.workers[0]!.id);
  await leftInTerminal(page, id);
  expect(await page.evaluate((w) => window.__h3d.face(w), id)).toBe(true);
  await frames(page, 3);
  await page.keyboard.press('e');
  await expect.poll(() => page.evaluate(() => window.__h3d.seated())).toBe(id);
  await frames(page, 10);
  return id;
}

const total = (page: Page) => page.evaluate(() => document.querySelector('.topbar-usage')?.textContent ?? '');

/** Every worker of the floor at `usd` (priced), in one task: how many, how long, and the top bar's total right after. */
async function burst(page: Page, cdp: CDPSession, run: number, usd: number) {
  const before = (await metrics(cdp)).LayoutCount ?? 0;
  const r = await page.evaluate(
    ({ run, usd }) => {
      const h = window.__h3d;
      const all = h.world().find((f) => f.id === 'herdr-3d')!.workers;
      const t0 = performance.now();
      for (const [i, w0] of all.entries()) {
        const w = h.worker(w0.id)!;
        h.inject({ t: 'worker.usage', seq: 70_000_000 + run * 1000 + i, id: w.id, session: w.session, usage: { tokens: 50_000 + run * 1000 + i, cost_usd_est: usd, priced: 'known', model: 'claude-opus-5-5' } } as never);
      }
      return { n: all.length, ms: performance.now() - t0, total: document.querySelector('.topbar-usage')?.textContent ?? '' };
    },
    { run, usd },
  );
  const layouts = ((await metrics(cdp)).LayoutCount ?? 0) - before;
  return { ...r, layouts };
}

test('seated, usage events force no layout and still move the usage total (#144)', { tag: '@perf' }, async ({ page }) => {
  test.setTimeout(120_000);
  await openGame(page, 'demo-m5', '', 'play=none&sim=1&simusage=2000');
  await sitAtLaptop(page);
  await expect(page.locator('[data-hook="limits"]')).toHaveAttribute('data-dock', 'tab');
  expect(await total(page)).toMatch(/^≈\$/);

  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  const runs = [];
  for (let i = 0; i < BURSTS; i++) {
    const usd = 0.5 + i * 0.01;
    const r = await burst(page, cdp, i, usd);
    expect(r.n).toBeGreaterThan(5);
    expect(r.total).toBe(`≈$${(r.n * usd).toFixed(2)}`);
    runs.push(r);
    await frames(page, 5);
  }
  // The sim's cadence moves the total too (its next usage of a working agent is its own, not the burst's).
  const last = runs.at(-1)!.total;
  await expect.poll(() => total(page), { timeout: 15_000 }).not.toBe(last);
  const events = runs.reduce((n, r) => n + r.n, 0);
  const layouts = runs.reduce((n, r) => n + r.layouts, 0);
  const summary = { events, layouts, perEvent: Math.round((layouts / events) * 1000) / 1000, burstMs: runs.map((r) => Math.round(r.ms * 10) / 10) };
  mkdirSync(RESULTS, { recursive: true });
  writeFileSync(resolve(RESULTS, `h144-usage-perf${process.env.H3D_DIST ? `-${process.env.H3D_DIST}` : ''}.json`), JSON.stringify({ summary, runs }, null, 2));
  console.log(`h144 perf summary: ${JSON.stringify(summary)}`);
  expect(summary.perEvent).toBeLessThanOrEqual(PER_EVENT);
  // Seated still: the plate's tab is where it was.
  await expect(page.locator('[data-hook="limits"]')).toHaveAttribute('data-dock', 'tab');
});
