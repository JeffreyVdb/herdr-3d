import { expect, test, type Page } from '@playwright/test';
import { frames, openGame, watchErrors } from './game';

// #143 on demo-m118 (the lab floor's write-code runs, the simulator on): the scene under the opaque overview page is
// drawn at the frame policy's opaque cap (OPAQUE_HZ, 4: a frame every 200 ms on this 60 Hz headless display), under
// the whiteboard's scrim at SCRIM_HZ (20); the page keeps following the world meanwhile, and a close draws the world
// as it is at once, at the full rate again.

const OPAQUE_HZ = 4;
const SCRIM_HZ = 20;

const page_ = (page: Page) => page.evaluate(() => window.__h3d.overview()?.page);

/** Rendered frames over `ms` of wall clock, counted in the page. */
const rate = (page: Page, ms: number) =>
  page.evaluate(async (ms) => {
    const f0 = window.__h3d.frames;
    const t0 = performance.now();
    await new Promise((r) => setTimeout(r, ms));
    return ((window.__h3d.frames - f0) * 1000) / (performance.now() - t0);
  }, ms);

let seq = 7_000_000;

/**
 * AC5: the first frame drawn after a close shows the world as it is now. Right after a covered frame is drawn, worker
 * `id`'s status changes (`inject` applies it to the scene at once, but only a frame draws it), then the page closes
 * (`how`: the close button, Esc or the row's go-to), all in the same task, so no frame can come in between. The frame
 * after that must be the first one after the close, show the new status, have been stepped to a clock later than the
 * covered frame's (a `render()` without its `step()`, or a step on an old clock, keeps the old one) and at full rate.
 */
const closeFresh = (page: Page, id: string, how: 'button' | 'esc' | 'goto') =>
  page.evaluate(
    async ([id, how, seq]) => {
      const h = window.__h3d;
      const tick = () => new Promise<number>((r) => requestAnimationFrame(r));
      const w = h.worker(id);
      if (!w) throw new Error(`no worker ${id}`);
      const f = h.frames;
      while (h.frames === f) await tick();
      // A covered frame was just drawn; from here to the close nothing awaits, so no frame can be drawn in between.
      const f0 = h.frames;
      const at0 = h.frameAt;
      const from = h.status(id)?.status ?? null;
      const to = from === 'idle' ? 'working' : 'idle';
      h.inject({ t: 'worker.status', seq, id, session: w.session, workspace_id: w.workspace_id, status: to, prev_status: w.status, status_since: Date.now(), title: '' } as never);
      const stale = { frames: h.frames, shown: h.status(id)?.status ?? null, covering: h.overview()?.page.covering ?? null };
      const clickAt = performance.now();
      if (how === 'button') (document.querySelector('.ov [aria-label="Close the overview (Esc)"]') as HTMLButtonElement).click();
      else if (how === 'esc') document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }));
      else (document.querySelector(`.ov-row[data-key="${CSS.escape(id)}"]`) as HTMLElement).click();
      const covering = h.overview()?.page.covering ?? null;
      while (h.frames === f0) await tick();
      return { from, to, f0, at0, stale, clickAt, covering, frames: h.frames, frameAt: h.frameAt, shown: h.status(id)?.status ?? null, hz: h.pacing()?.hz ?? null };
    },
    [id, how, seq++] as const,
  );

const expectFresh = (r: Awaited<ReturnType<typeof closeFresh>>) => {
  const why = JSON.stringify(r);
  // Before the close: still covered, and the covered frame (the last drawn) shows the old status.
  expect(r.stale.covering, why).toBe(true);
  expect(r.stale.frames, why).toBe(r.f0);
  expect(r.stale.shown, why).toBe(r.from);
  expect(r.covering, why).toBe(false);
  // The first frame after the close shows the change, stepped on its own clock, at the full rate again.
  expect(r.frames, why).toBe(r.f0 + 1);
  expect(r.shown, why).toBe(r.to);
  expect(r.frameAt, why).toBeGreaterThan(r.at0);
  expect(r.hz, why).toBeGreaterThan(OPAQUE_HZ);
};

test('the overview page, once grown, draws the scene at a few frames a second; a close draws the world at once (#143)', async ({ page }) => {
  test.setTimeout(120_000);
  const clean = watchErrors(page);
  await openGame(page, 'demo-m118', '', `play=none&sim=1&simms=150&wb_key=h143${Date.now().toString(36)}`);
  await page.evaluate(() => window.__h3d.enterFloor('lab'));
  await frames(page, 3);
  expect(await rate(page, 1000)).toBeGreaterThan(20);

  await page.keyboard.press('KeyO');
  await expect.poll(async () => (await page_(page))?.open).toBe(true);
  await expect.poll(async () => (await page_(page))?.covering, { message: 'the grow ends' }).toBe(true);
  // At most one frame a second over the cap (`shouldRender`'s slack), never paused: step() still ticks.
  const covered = await rate(page, 3000);
  expect(covered).toBeLessThanOrEqual(OPAQUE_HZ + 1 + 0.4);
  expect(covered).toBeGreaterThanOrEqual(OPAQUE_HZ - 1);

  // The page follows the world under the cap: a status change reaches its row (the 250 ms refresh + a covered frame).
  const row = (await page_(page))?.rows.find((r) => r.kind === 'worker' && r.display !== 'needs_you');
  expect(row).toBeTruthy();
  const key = row?.key ?? '';
  const t0 = Date.now();
  expect(await page.evaluate((id) => window.__h3d.simStatus(id, 'blocked'), key)).toBe(true);
  await expect.poll(async () => (await page_(page))?.rows.find((r) => r.key === key)?.display, { timeout: 5000 }).toBe('needs_you');
  expect(Date.now() - t0).toBeLessThan(1500);
  // `frames()` waits still go on under the page.
  await frames(page, 2);

  // The close button, right after a covered frame: the next vsync draws the world as it is now (not the next covered
  // frame, up to 200 ms on), while the page shrinks away.
  expectFresh(await closeFresh(page, key, 'button'));
  expect(await rate(page, 400)).toBeGreaterThan(20); // during the shrink
  await expect.poll(async () => (await page_(page))?.open).toBe(false);
  expect(await rate(page, 1000)).toBeGreaterThan(20);

  // Esc on a grown page: the same.
  await page.keyboard.press('KeyO');
  await expect.poll(async () => (await page_(page))?.covering).toBe(true);
  expect(await rate(page, 1000)).toBeLessThanOrEqual(OPAQUE_HZ + 2);
  expectFresh(await closeFresh(page, key, 'esc'));
  expect(await rate(page, 300)).toBeGreaterThan(20);
  await expect.poll(async () => (await page_(page))?.open).toBe(false);

  // The whiteboard's scrim: the scene shows through, at a reduced rate.
  await page.evaluate(() => window.__h3d.openWhiteboard());
  await expect.poll(() => page.evaluate(() => window.__h3d.whiteboard()?.overlay.open)).toBe(true);
  const scrim = await rate(page, 2000);
  expect(scrim).toBeLessThanOrEqual(SCRIM_HZ + 2);
  expect(scrim).toBeGreaterThan(OPAQUE_HZ + 2);
  await page.keyboard.press('Escape');
  await expect.poll(() => page.evaluate(() => window.__h3d.whiteboard()?.overlay.open), { timeout: 15_000 }).toBe(false);
  expect(await rate(page, 1000)).toBeGreaterThan(20);

  // A row's go-to (`closeNow`, no shrink): the same.
  await page.keyboard.press('KeyO');
  await expect.poll(async () => (await page_(page))?.covering).toBe(true);
  expectFresh(await closeFresh(page, key, 'goto'));
  await expect.poll(async () => (await page_(page))?.open).toBe(false);
  clean();
});
