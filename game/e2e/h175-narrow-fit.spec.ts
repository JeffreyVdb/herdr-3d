import { expect, test, type Page } from '@playwright/test';
import { frames, leftInTerminal, openGame, shot, watchErrors } from './game';

// #175: a split pane's laptop at 100% shows the pane's whole grid, letterboxed: nothing enlarges it by itself. Only
// the user's zoom grows the text (cropping to the bottom-left, following the cursor), and back at 100% the whole grid is
// there again. `simscreen=narrow` puts a recorded 60×40 shell on every laptop (tools/fixture-screen.ts).

const FLOOR = 'herdr-3d';
const SIM = (screen: string) => `play=none&sim=1&simms=500&simusage=0&simlimits=ok${screen ? `&simscreen=${screen}` : ''}`;

async function sitAt(page: Page, screen: string, name = 'Tofu'): Promise<string> {
  await page.addInitScript(() => localStorage.setItem('h3d.monitors', 'terminal'));
  await openGame(page, 'demo-m5', '&prints=0', SIM(screen));
  await page.evaluate((s) => window.__h3d.enterFloor(s), FLOOR);
  await frames(page, 3);
  const id = await page.evaluate((n) => window.__h3d.world().flatMap((f) => f.workers).find((w) => w.name === n)?.id ?? '', name);
  await leftInTerminal(page, id);
  expect(await page.evaluate((i) => window.__h3d.face(i), id)).toBe(true);
  await frames(page, 3);
  expect(await page.evaluate((w) => window.__h3d.sitAt(w), id)).toBe(true);
  await expect.poll(() => page.evaluate(() => window.__h3d.seated())).toBe(id);
  await expect.poll(() => page.evaluate((i) => window.__h3d.screenMesh(i)?.glance, id)).toBe(false);
  await frames(page, 8);
  return id;
}

const rows = (page: Page, id: string) => page.evaluate((i) => window.__h3d.screenText(i) ?? [], id);
const level = (page: Page) => page.locator('.seat-zoom-level');

test('a 60×40 pane at 100% shows all its rows; A+ / A− and Ctrl+0 zoom and restore it; a resize and the glance view', async ({ page }) => {
  test.setTimeout(180_000);
  const clean = watchErrors(page);
  await page.setViewportSize({ width: 1280, height: 720 });
  const id = await sitAt(page, 'narrow');
  // A key fast-forwards the recording to its end and keeps it there (the sim stops looping a typed-at screen).
  await page.locator('.seat-input').focus();
  await page.keyboard.press('ArrowRight');
  await expect.poll(async () => (await rows(page, id)).length).toBe(40);
  await expect.poll(async () => (await rows(page, id))[39]).toMatch(/^row 40/);
  expect((await rows(page, id))[0]).toMatch(/^row {2}1 /);
  await expect(level(page)).toHaveText('100%');
  await shot(page, 'h175-narrow-100');

  const larger = page.getByRole('button', { name: 'Larger terminal text' });
  for (let i = 0; i < 5; i++) await larger.click();
  await expect(level(page)).toHaveText('150%');
  await frames(page, 8);
  await shot(page, 'h175-narrow-150');
  for (let i = 0; i < 5; i++) await larger.click();
  await expect(level(page)).toHaveText('200%');
  await frames(page, 8);
  await shot(page, 'h175-narrow-200');
  await page.getByRole('button', { name: 'Smaller terminal text' }).click();
  await expect(level(page)).toHaveText('190%');
  await page.locator('.seat-input').focus();
  await page.keyboard.press('Control+0');
  await expect(level(page)).toHaveText('100%');
  await frames(page, 8);
  await shot(page, 'h175-narrow-reset');

  await page.setViewportSize({ width: 900, height: 760 });
  await frames(page, 12);
  await shot(page, 'h175-narrow-resized');
  await page.setViewportSize({ width: 1280, height: 720 });

  await page.locator('.seat').getByRole('button', { name: /Stand up/ }).click();
  await expect.poll(() => page.evaluate(() => window.__h3d.seated())).toBeNull();
  await expect.poll(() => page.evaluate((i) => window.__h3d.screenMesh(i)?.glance, id)).toBe(true);
  await frames(page, 12);
  await shot(page, 'h175-narrow-standing');
  clean();
});

test('a 120-column pane at 100% is unchanged: the whole grid', async ({ page }) => {
  test.setTimeout(120_000);
  const clean = watchErrors(page);
  await page.setViewportSize({ width: 1280, height: 720 });
  const id = await sitAt(page, '');
  await expect.poll(async () => (await rows(page, id)).length).toBe(36);
  await expect(level(page)).toHaveText('100%');
  await shot(page, 'h175-wide-100');
  clean();
});
