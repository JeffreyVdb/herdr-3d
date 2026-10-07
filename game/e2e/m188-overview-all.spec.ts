import { expect, test, type Page } from '@playwright/test';
import { frames, openGame, openMenu, shot, watchErrors } from './game';

// #188 on demo-m188 (demo-m118 with a run across two floors): Juniper orchestrates on lab (top of Work), Poppy, its
// working coder, sits on pastry (Floor 1); depot-manager is asleep; Quince in the scratchpad lost its orchestrator.
// O in the city or a lobby opens every floor's overview (active only by default); F shows everyone; Enter on a worker
// on another floor sits you at its laptop; Esc closes back to where you were.

const SIM = 'play=none&sim=1&simms=150';

const page_ = async (page: Page) => (await page.evaluate(() => window.__h3d.overview()))?.page;
const view = (page: Page) => page.evaluate(() => window.__h3d.view());
const keysOf = async (page: Page) => ((await page_(page))?.rows ?? []).map((r) => `${'  '.repeat(r.depth)}${r.key}`);
const workerId = (page: Page, name: string) => page.evaluate((n) => window.__h3d.world().flatMap((f) => f.workers).find((w) => w.name === n)?.id ?? null, name);

test('O in the city opens every floor: active only, the hidden line, F for everyone; Esc returns to the city', async ({ page }) => {
  test.setTimeout(150_000);
  const clean = watchErrors(page);
  await openGame(page, 'demo-m188');
  expect((await view(page)).mode).toBe('city');
  await page.keyboard.press('KeyO');
  await expect.poll(async () => (await page_(page))?.open).toBe(true);
  let p = await page_(page);
  expect(p).toMatchObject({ view: 'city', floor: null, filter: 'active', from: null });
  expect(p?.hidden).toMatch(/^\d+ idle hidden · 1 floor asleep$/);
  await expect(page.locator('.ov-floor')).toHaveText('All floors');
  await expect(page.locator('.toast')).not.toContainText('Walk onto'); // no more "walk onto a floor"
  // Floors in order (Work top floor first, then the lot); the asleep one hidden; Poppy once, under Juniper on lab.
  const floors = (p?.rows ?? []).filter((r) => r.depth === 0).map((r) => r.key);
  expect(floors).toEqual(['floor:lab', 'floor:herdr-3d', 'floor:pastry', 'floor:scratchpad']);
  const poppy = await workerId(page, 'Poppy');
  const juniper = await workerId(page, 'Juniper');
  const rows = await keysOf(page);
  expect(rows.filter((k) => k.trim() === poppy)).toEqual([`    ${poppy}`]);
  expect(rows.indexOf(`    ${poppy}`)).toBeGreaterThan(rows.indexOf(`  ${juniper}`));
  await expect(page.locator(`.ov-row[data-key="${poppy}"] .ov-floortag`)).toHaveText('Floor 1');
  // The header counts the whole system, whatever the filter shows.
  await expect(page.locator('.ov-counts .ov-count--asleep')).toContainText('asleep');
  await page.waitForTimeout(800); // the grow and the cascade
  await shot(page, 'm188-city-active');

  // F: everyone, every worker once; the asleep floor starts folded.
  await page.keyboard.press('KeyF');
  await expect.poll(async () => (await page_(page))?.filter).toBe('all');
  p = await page_(page);
  expect(p?.hidden).toBe('');
  expect(p?.rows.filter((r) => r.depth === 0).map((r) => [r.key, r.expanded])).toEqual([
    ['floor:lab', true],
    ['floor:herdr-3d', true],
    ['floor:depot-manager', false],
    ['floor:pastry', true],
    ['floor:scratchpad', true],
  ]);
  const ids = (p?.rows ?? []).filter((r) => r.display !== null).map((r) => r.key);
  expect(new Set(ids).size).toBe(ids.length);
  const all = await page.evaluate(() => window.__h3d.world().filter((f) => !f.asleep).flatMap((f) => f.workers.map((w) => w.id)));
  expect([...ids].sort()).toEqual([...all].sort());
  // Quince's orchestrator is gone: Unlinked, on its own floor.
  const quince = await workerId(page, 'Quince');
  const all2 = await keysOf(page);
  expect(all2.slice(all2.indexOf('  unlinked:scratchpad'), all2.indexOf('  unlinked:scratchpad') + 2)).toEqual(['  unlinked:scratchpad', `    ${quince}`]);
  await shot(page, 'm188-city-all');
  // Remembered for this page, in this browser; back to active only with the switch.
  expect(await page.evaluate(() => localStorage.getItem('h3d.overview.filter.city'))).toBe('all');
  await page.locator('.ov-seg', { hasText: 'Active only' }).click();
  await expect.poll(async () => (await page_(page))?.filter).toBe('active');
  await page.locator('.ov-hidden').click();
  await expect.poll(async () => (await page_(page))?.filter).toBe('all');

  await page.keyboard.press('Escape');
  await expect.poll(async () => (await page_(page))?.open).toBe(false);
  expect((await view(page)).mode).toBe('city');
  clean();
});

test('Enter on a worker on another floor sits you at its laptop; Enter on a floor goes there', async ({ page }) => {
  test.setTimeout(150_000);
  const clean = watchErrors(page);
  await openGame(page, 'demo-m188', '', SIM);
  await page.keyboard.press('KeyO');
  await expect.poll(async () => (await page_(page))?.open).toBe(true);
  const poppy = await workerId(page, 'Poppy');
  await page.locator(`.ov-row[data-key="${poppy}"]`).focus();
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await page_(page))?.open).toBe(false);
  await expect.poll(() => page.evaluate(() => window.__h3d.seated()), { timeout: 30_000 }).toBe(poppy);
  expect((await page.evaluate(() => window.__h3d.pose()))?.floor).toBe('pastry');
  await expect.poll(() => page.evaluate(() => window.__h3d.seat().mode)).toBe('transcript');

  // From a lobby: O opens every floor, Enter on a floor row takes the elevator there.
  await page.keyboard.press('Escape'); // stand up
  await page.evaluate(() => window.__h3d.enterLobby());
  await frames(page, 3);
  expect((await view(page)).area).toBe('lobby');
  await page.keyboard.press('KeyO');
  await expect.poll(async () => (await page_(page))?.view).toBe('city');
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await page_(page))?.open).toBe(false);
  expect((await view(page)).area).toBe('lobby');
  await page.keyboard.press('KeyO');
  await expect.poll(async () => (await page_(page))?.open).toBe(true);
  await page.locator('.ov-row[data-key="floor:herdr-3d"]').click();
  await expect.poll(async () => (await page_(page))?.open).toBe(false);
  await expect.poll(async () => (await page.evaluate(() => window.__h3d.pose()))?.floor, { timeout: 30_000 }).toBe('herdr-3d');
  clean();
});

test('a floor’s page: All by default, F hides the idle, A switches to every floor; the City menu and the palette open it', async ({ page }) => {
  test.setTimeout(150_000);
  const clean = watchErrors(page);
  await openGame(page, 'demo-m188');
  // The City section of the menu has its own Overview.
  await openMenu(page);
  const cityBtn = page.locator('.topbar-menu .btn--overview-all');
  await expect(cityBtn).toBeVisible();
  await expect(cityBtn.locator('.topbar-key')).toHaveAttribute('data-key', 'O');
  await cityBtn.click();
  await expect.poll(async () => (await page_(page))?.view).toBe('city');
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await page_(page))?.open).toBe(false);
  // The palette's command.
  await page.keyboard.press('Control+KeyP');
  await page.keyboard.type('all floors');
  await expect(page.locator('dialog.palette .pal-opt .pal-name').first()).toHaveText('All-floors overview');
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await page_(page))?.view).toBe('city');
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await page_(page))?.open).toBe(false);

  // On the lab floor: O is that floor's page, as before, and the City Overview steps aside for the floor's.
  await page.evaluate(() => window.__h3d.enterFloor('lab'));
  await frames(page, 3);
  await openMenu(page);
  await expect(cityBtn).toBeHidden();
  await page.keyboard.press('Escape');
  await page.keyboard.press('KeyO');
  await expect.poll(async () => (await page_(page))?.open).toBe(true);
  let p = await page_(page);
  expect(p).toMatchObject({ view: 'floor', floor: 'lab', filter: 'all', hidden: '' });
  const n = p?.rows.length ?? 0;
  await page.keyboard.press('KeyF');
  await expect.poll(async () => (await page_(page))?.filter).toBe('active');
  p = await page_(page);
  expect(p?.rows.length).toBeLessThan(n);
  expect(p?.rows.every((r) => r.display === null || ['working', 'needs_you', 'waiting'].includes(r.display) || r.expanded !== null)).toBe(true);
  expect(p?.hidden).toMatch(/^\d+ idle hidden$/);
  await shot(page, 'm188-floor-active');
  // A: every floor, in place; Esc closes the page onto the floor.
  await page.keyboard.press('KeyA');
  await expect.poll(async () => (await page_(page))?.view).toBe('city');
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await page_(page))?.open).toBe(false);
  expect((await page.evaluate(() => window.__h3d.pose()))?.floor).toBe('lab');
  // The All floors button does the same.
  await page.keyboard.press('KeyO');
  await expect.poll(async () => (await page_(page))?.view).toBe('floor');
  await page.getByRole('button', { name: 'All floors' }).click();
  await expect.poll(async () => (await page_(page))?.view).toBe('city');
  clean();
});

test('a phone: the switch and the hidden line under the counts, floor rows on two lines', async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await openGame(page, 'demo-m188');
  await page.keyboard.press('KeyO');
  await expect.poll(async () => (await page_(page))?.open).toBe(true);
  await expect(page.locator('.ov-filter')).toBeVisible();
  await expect(page.locator('.ov-hidden')).toBeVisible();
  await expect(page.locator('.ov-btn--floors')).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.waitForTimeout(800);
  await shot(page, 'm188-city-phone');
});
