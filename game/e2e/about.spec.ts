import { expect, test } from '@playwright/test';
import { openGame, watchErrors } from './game';

test('build versions are not on the canvas; the About panel has them, and only them', async ({ page }) => {
  const clean = watchErrors(page);
  await openGame(page);
  // Nothing sits in the corner of the screen over the HUD.
  await expect(page.locator('#debug')).toBeHidden();
  await expect(page.locator('#versions')).toHaveCount(0);

  const button = page.getByRole('button', { name: 'About' });
  await button.click();
  const dialog = page.getByRole('dialog', { name: 'About' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('Game', { exact: true })).toBeVisible();
  await expect(dialog.getByText('webgl2')).toBeVisible();
  // #91: read-only. What can be changed moved to Settings, and About says so.
  await expect(dialog.getByText('Settings moved to ⚙')).toBeVisible();
  await expect(dialog.locator('input, select, textarea')).toHaveCount(0);
  await expect(dialog.getByText('plan limits', { exact: false })).toHaveCount(0);
  await expect(dialog.getByText('Day and night')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(button).toBeFocused();
  clean();
});
