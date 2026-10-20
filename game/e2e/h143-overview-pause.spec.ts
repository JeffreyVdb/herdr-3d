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

  // The close button, right after a covered frame: the next frame comes at the next vsync (not the next covered one,
  // up to 200 ms on), while the page shrinks away.
  const first = await page.evaluate(async () => {
    const tick = () => new Promise<number>((r) => requestAnimationFrame(r));
    const f = window.__h3d.frames;
    while (window.__h3d.frames === f) await tick();
    const f0 = window.__h3d.frames;
    (document.querySelector('.ov [aria-label="Close the overview (Esc)"]') as HTMLButtonElement).click();
    const covering = window.__h3d.overview()?.page.covering;
    const t0 = performance.now();
    while (window.__h3d.frames === f0) await tick();
    return { covering, ms: performance.now() - t0 };
  });
  expect(first.covering).toBe(false);
  expect(first.ms).toBeLessThan(100);
  expect(await rate(page, 400)).toBeGreaterThan(20); // during the shrink
  await expect.poll(async () => (await page_(page))?.open).toBe(false);
  expect(await rate(page, 1000)).toBeGreaterThan(20);

  // Esc on a grown page: the same.
  await page.keyboard.press('KeyO');
  await expect.poll(async () => (await page_(page))?.covering).toBe(true);
  expect(await rate(page, 1000)).toBeLessThanOrEqual(OPAQUE_HZ + 2);
  await page.keyboard.press('Escape');
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
  clean();
});
