import { expect, test } from '@playwright/test';
import { openGame, shot, watchErrors } from './game';

// #91: the Settings window (the gear in the top bar, `,`): Display and Day and night, each labelled with where it is
// kept. The limits switch and the time fields themselves are exercised in m10-limits and m17-daynight.

const gear = (page: import('@playwright/test').Page) => page.getByRole('button', { name: 'Settings', exact: true });

test('the gear opens Settings with its sections, each saying where it is kept; Esc and Close shut it', async ({ page }) => {
  const clean = watchErrors(page);
  await openGame(page);
  const button = gear(page);
  await expect(button).toHaveAttribute('title', /Settings/);
  await button.click();
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await expect(dialog).toBeVisible();

  const display = dialog.locator('[data-section="display"]');
  await expect(display.getByRole('heading', { name: 'Display', level: 3 })).toBeVisible();
  await expect(display.locator('.settings-store')).toHaveText('This browser');
  await expect(display.getByLabel('Show plan limits (Claude and Codex) in the corner')).toBeChecked();
  const time = dialog.locator('[data-section="time"]');
  await expect(time.getByRole('heading', { name: 'Day and night', level: 3 })).toBeVisible();
  await expect(time.locator('.settings-store')).toHaveText('This browser');
  await expect(time.getByLabel('Timezone')).toBeVisible();
  await expect(time.getByLabel('Latitude')).toBeVisible();
  await shot(page, 'settings');

  // Esc: shut, and the gear has focus again.
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(button).toBeFocused();

  // The Close button does the same.
  await button.click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(dialog).toBeHidden();
  await expect(button).toBeFocused();
  clean();
});

test('a click on the backdrop never closes Settings, not even a real press and release there', async ({ page }) => {
  const clean = watchErrors(page);
  await openGame(page);
  await gear(page).click();
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await expect(dialog).toBeVisible();
  // A half-typed field survives a stray click outside.
  const zone = dialog.getByLabel('Timezone');
  await zone.fill('Europe/Bru');
  await page.mouse.click(4, 4);
  await expect(dialog).toBeVisible();
  await expect(zone).toHaveValue('Europe/Bru');
  // Press on the backdrop, release inside, and the other way round: stays.
  const b = (await dialog.boundingBox())!;
  await page.mouse.move(4, 4);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 10 });
  await page.mouse.up();
  await expect(dialog).toBeVisible();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(4, 4, { steps: 10 });
  await page.mouse.up();
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  clean();
});

test('"," opens Settings from the scene and from a focused button, and types a comma in a field', async ({ page }) => {
  const clean = watchErrors(page);
  await openGame(page);
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await page.keyboard.press(',');
  await expect(dialog).toBeVisible();
  // A comma typed in a field is typed: it neither reopens nor closes anything.
  const lat = dialog.getByLabel('Latitude');
  await lat.focus();
  await page.keyboard.type('5,0');
  await expect(lat).toHaveValue('5,0');
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  // From a focused top-bar button (not a field) the comma still opens it.
  await gear(page).focus();
  await page.keyboard.press(',');
  await expect(dialog).toBeVisible();
  clean();
});

test('Settings fits a narrow screen', async ({ page }) => {
  const clean = watchErrors(page);
  await page.setViewportSize({ width: 360, height: 640 });
  await openGame(page);
  await gear(page).click();
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await expect(dialog).toBeVisible();
  const b = (await dialog.boundingBox())!;
  expect(b.x).toBeGreaterThanOrEqual(0);
  expect(b.x + b.width).toBeLessThanOrEqual(360);
  expect(b.y + b.height).toBeLessThanOrEqual(640);
  await shot(page, 'settings-narrow');
  clean();
});
