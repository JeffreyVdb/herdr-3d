import { expect, test, type Page } from '@playwright/test';
import { frames, openGame, shot, watchErrors } from './game';

// #139: hiring a Codex worker on a chosen Codex profile against the fixture bridge (`simcodexprofiles=2`,
// tools/fixture-codex-profiles.ts): the hire dialog's "Codex profile" (codex, the default, picked first; work; spare,
// not signed in, shown and not pickable; the hidden old not offered), the hire sending the profile picked, and the seat
// bar's profile line of the seeded workers (Pixel on work, Sprocket woken on codex after its profile went). With one
// profile (`simcodexprofiles=1`) the dialog is as before. At 390 × 844 and desktop width, in both UI themes, Quiet and
// Ubuntu (Settings → UI theme; the game's UI has no light theme and does not follow prefers-color-scheme).

const SIM = 'play=none&sim=1&simms=150&simusage=0';
const PIXEL = 'fc018d58-4789-46c2-afac-c062bc9fff9e';
const SPROCKET = '0f5107ad-89da-4dd9-a49f-832839d2ca53';
const SIZES = [
  { name: '390', width: 390, height: 844 },
  { name: 'desktop', width: 1280, height: 800 },
] as const;

const UBUNTU = { 'h3d.theme.ui': 'ubuntu', 'h3d.theme.transcript': 'ubuntu', 'h3d.theme.terminal': 'ubuntu' };
const THEMES = ['quiet', 'ubuntu'] as const;
type Theme = (typeof THEMES)[number];

const hireDlg = (page: Page) => page.locator('dialog.desk-dlg--hire');
const chip = (page: Page, key: string) => hireDlg(page).locator(`label:has(> [data-key="${key}"])`);

async function openHire(page: Page, desk: number): Promise<void> {
  await page.evaluate((d) => window.__h3d.openHire(d), desk);
  await expect.poll(async () => {
    const d = await page.evaluate(() => window.__h3d.dialog());
    return d?.kind === 'hire' ? d.state : null;
  }, { timeout: 15_000 }).toBe('ready');
}

async function boot(page: Page, profiles: number, theme: Theme = 'quiet'): Promise<void> {
  if (theme === 'ubuntu') await page.addInitScript((kv) => Object.entries(kv).forEach(([k, v]) => localStorage.setItem(k, v)), UBUNTU);
  await page.addInitScript(() => {
    try {
      localStorage.setItem('h3d.hire.goto', 'off');
    } catch {
      /* blocked */
    }
  });
  await openGame(page, 'demo-m5', '', `${SIM}&simcodexprofiles=${profiles}`);
  await page.evaluate(() => window.__h3d.enterFloor('herdr-3d'));
  await frames(page, 2);
}

for (const theme of THEMES)
test(`the hire dialog’s Codex profile: listed with two, the default first; a hire sends the one picked (${theme})`, async ({ page }) => {
  test.setTimeout(120_000);
  const clean = watchErrors(page);
  await boot(page, 2, theme);
  await openHire(page, 5);
  await chip(page, 'harness:codex').click();
  const field = hireDlg(page).locator('[data-pick="codex-profile"]');
  await expect(field).toBeVisible();
  await expect(field.locator('legend')).toHaveText('Codex profile');
  await expect(field.locator('.dd-chip')).toHaveText(['codex', 'work', 'sparenot signed in']);
  await expect(field.locator('[data-key="codex-profile:codex"]')).toBeChecked();
  await expect(field.locator('[data-key="codex-profile:spare"]')).toBeDisabled();
  await expect(field.locator('[data-key="codex-profile:old"]')).toHaveCount(0);
  if (theme === 'ubuntu') await expect(page.locator('html')).toHaveAttribute('data-ui-theme', 'ubuntu');
  for (const size of SIZES) {
    await page.setViewportSize(size);
    await field.scrollIntoViewIfNeeded();
    await expect(field).toBeInViewport();
    const box = await field.boundingBox();
    expect(box && box.x >= 0 && box.x + box.width <= size.width).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(size.width);
    await shot(page, `h139-hire-profile-${size.name}-${theme}`);
  }
  await chip(page, 'codex-profile:work').click();
  await expect(field.locator('[data-key="codex-profile:work"]')).toBeChecked();
  await hireDlg(page).locator('[data-key="hire"]').click();
  await expect.poll(async () => (await page.evaluate(() => window.__h3d.sent())).find((c) => c.t === 'worker.hire')?.args ?? null).toMatchObject({
    harness: 'codex',
    codex_profile: 'work',
  });
  clean();
});

test('with one profile the hire dialog has no Codex profile, and sends none', async ({ page }) => {
  const clean = watchErrors(page);
  await boot(page, 1);
  await openHire(page, 5);
  await chip(page, 'harness:codex').click();
  await expect(chip(page, 'harness:codex').locator('input')).toBeChecked();
  await expect(hireDlg(page).locator('[data-pick="codex-profile"]')).toHaveCount(0);
  await hireDlg(page).locator('[data-key="hire"]').click();
  await expect.poll(async () => (await page.evaluate(() => window.__h3d.sent())).find((c) => c.t === 'worker.hire')?.args ?? null).not.toBeNull();
  expect((await page.evaluate(() => window.__h3d.sent())).find((c) => c.t === 'worker.hire')?.args).not.toHaveProperty('codex_profile');
  clean();
});

for (const theme of THEMES)
test(`the seat bar names the profile a Codex worker runs on, and says when it woke on the default (${theme})`, async ({ page }) => {
  test.setTimeout(120_000);
  const clean = watchErrors(page);
  await boot(page, 2, theme);
  const seat = page.locator('.seat');
  const line = seat.locator('.seat-profile');
  for (const [id, text, tone] of [
    [PIXEL, 'Codex profilework', 'note'],
    [SPROCKET, 'Codex profilecodex. old-work is gone: woke on codex. Its Codex session stays in that folder, so a new one was started.', 'note'],
  ] as const) {
    expect(await page.evaluate((w) => window.__h3d.face(w), id)).toBe(true);
    await frames(page, 3);
    expect(await page.evaluate((w) => window.__h3d.sitAt(w), id)).toBe(true);
    await expect(line).toHaveText(text);
    await expect(line).toHaveAttribute('data-tone', tone);
    for (const size of SIZES) {
      await page.setViewportSize(size);
      await expect(line).toBeVisible();
      const box = await line.boundingBox();
      expect(box && box.x >= 0 && box.x + box.width <= size.width).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(size.width);
      await shot(page, `h139-seat-profile-${id === PIXEL ? 'pixel' : 'sprocket'}-${size.name}-${theme}`);
    }
    await page.keyboard.press('Escape');
    await expect.poll(() => page.evaluate(() => window.__h3d.seated())).toBeNull();
  }
  clean();
});
