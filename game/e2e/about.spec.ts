import { expect, test } from '@playwright/test';
import { openGame, watchErrors } from './game';

test('build versions are not on the canvas; the About panel has them', async ({ page }) => {
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
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(button).toBeFocused();
  clean();
});
