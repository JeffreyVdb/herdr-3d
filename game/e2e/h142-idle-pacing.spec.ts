import { expect, test, type Page } from '@playwright/test';
import { frames, openGame, watchErrors } from './game';
import { enter, waitNotes } from './m7';

// #142: world events are not interaction. With the simulating server sending events (working agents' `worker.usage`
// every `simusage` ms) and board pushes, and nobody touching the game, the frame loop targets the idle rate (60 Hz;
// 30 with battery saver), not 120. Headless Chromium draws at 60 Hz either way, so this checks what `tick` decides
// (`__h3d.pacing`), not the frames: `held` counts the display frames the fast rate was kept by the activity window
// alone, nothing animating. Input still gets the fast rate, and gives it back once its window is over.

type Pacing = NonNullable<ReturnType<Window['__h3d']['pacing']>>;

const SIM = 'play=none&sim=1&simms=300&simusage=250';
// Past ACTIVE_WINDOW_MS (1.5 s) after the last input or animation.
const SETTLE_MS = 2500;
const SAMPLE_MS = 5000;

/** The decisions over `ms` with no input; `poke` runs a few times meanwhile (a board poll). Logged before any assertion. */
async function sample(page: Page, label: string, poke?: () => Promise<unknown>): Promise<Pacing & { total: number }> {
  await page.waitForTimeout(SETTLE_MS);
  await page.evaluate(() => window.__h3d.pacing(true));
  for (let i = 0; i < 5; i++) {
    await page.waitForTimeout(SAMPLE_MS / 5);
    await poke?.();
  }
  const p = (await page.evaluate(() => window.__h3d.pacing()))!;
  const total = Object.values(p.ticks).reduce((a, b) => a + b, 0);
  console.log(`H142 ${label} ${JSON.stringify({ ...p, total, fastShare: +((p.ticks[120] ?? 0) / Math.max(1, total)).toFixed(3) })}`);
  return { ...p, total };
}

/** Every decision of the sample was the idle rate, while the world kept changing. A loaded host ticks far below 60/s. */
function expectIdle(p: Pacing & { total: number }, idle: number): void {
  expect(p.changes).toBeGreaterThan(10);
  expect(p.total).toBeGreaterThan(10);
  expect(p.held).toBe(0);
  expect(p.ticks[idle]).toBe(p.total);
}

/** A wheel over the canvas: input, so the fast rate within the window, then the idle rate once it is over. */
async function wheelThenIdle(page: Page, fast: number, idle: number): Promise<void> {
  const box = (await page.locator('canvas').first().boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -120);
  await expect.poll(async () => (await page.evaluate(() => window.__h3d.pacing()))!.hz, { timeout: 1400, intervals: [50] }).toBe(fast);
  await expect.poll(async () => (await page.evaluate(() => window.__h3d.pacing()))!.hz, { timeout: 8000, intervals: [100] }).toBe(idle);
}

test('world events in the city and on a floor keep the idle rate; a wheel gets 120 for its window', async ({ page }) => {
  test.setTimeout(120_000);
  const clean = watchErrors(page);
  await openGame(page, 'demo-m5', '', SIM);

  const city = await sample(page, 'city');
  expectIdle(city, 60);
  await wheelThenIdle(page, 120, 60);

  await page.evaluate(() => window.__h3d.enterFloor('herdr-3d'));
  await frames(page, 4);
  const floor = await sample(page, 'floor');
  // Real animation (an arrival, a walk-out) is 120 Hz by design: none plays here.
  expectIdle(floor, 60);
  await wheelThenIdle(page, 120, 60);
  clean();
});

test('board pushes on the floor you watch keep the idle rate', async ({ page }) => {
  test.setTimeout(120_000);
  const clean = watchErrors(page);
  await openGame(page, 'demo-m6', '&open=none', SIM);
  await enter(page, 'lab');
  await waitNotes(page, 8, 2);
  // A quiet poll: the boards are pushed again, nothing on them moves (m7-boards: no buffer is written).
  const boards = await sample(page, 'boards', () => page.evaluate(() => window.__h3d.simBoards({ poll: true })));
  expect(boards.boardPushes).toBeGreaterThanOrEqual(5);
  expectIdle(boards, 60);
  clean();
});

test('with battery saver, world events keep 30 Hz; a wheel gets 60 for its window', async ({ page }) => {
  test.setTimeout(120_000);
  const clean = watchErrors(page);
  await openGame(page, 'demo-m5', '&battery=1', SIM);
  const saver = await sample(page, 'battery');
  expectIdle(saver, 30);
  await wheelThenIdle(page, 60, 30);
  clean();
});
