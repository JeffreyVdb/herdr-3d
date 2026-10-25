import { expect, test } from '@playwright/test';
import { frames, shot, watchErrors } from './game';
import { boot, DESKTOP, NARROW, openDeskGames } from './ui-surfaces';

test('the corner-office monitor plays both games, keeps progress and owns the keyboard', async ({ page }) => {
  const clean = watchErrors(page);
  await boot(page, 'demo-m3b', {});
  await openDeskGames(page);
  const screen = page.locator('.desk-games');
  const status = screen.getByRole('status');
  await expect(screen.getByRole('button', { name: 'Patience', exact: true })).toHaveAttribute('aria-pressed', 'true');
  const seated = await page.evaluate(() => window.__h3d.pose());
  await page.keyboard.press('KeyW');
  await page.keyboard.press('Tab');
  await frames(page, 2);
  expect(await page.evaluate(() => window.__h3d.pose())).toEqual(seated);
  expect(await page.evaluate(() => window.__h3d.view().plan)).toBe(false);
  await screen.getByRole('button', { name: 'Draw a card (24 in stock)', exact: true }).click();
  await expect(status).toContainText('1 move');
  const waste = await screen.locator('[data-key="waste"]').getAttribute('aria-label');
  await screen.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(status).toContainText('0 moves');
  await expect(screen.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  await screen.getByRole('button', { name: 'Draw a card (24 in stock)', exact: true }).click();
  await expect(screen.locator('[data-key="waste"]')).toHaveAttribute('aria-label', waste!);

  await screen.getByRole('button', { name: 'Minesweeper', exact: true }).click();
  await screen.locator('[data-key="cell-0"]').click({ button: 'right' });
  await expect(screen.locator('[data-key="cell-0"]')).toHaveAttribute('aria-label', /flagged/);
  await expect(status).toContainText('9 mines unflagged');
  await screen.locator('[data-key="cell-0"]').press('f');
  await expect(status).toContainText('10 mines unflagged');
  await screen.locator('[data-key="cell-0"]').press('ArrowRight');
  await expect(screen.locator('[data-key="cell-1"]')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(screen.locator('[data-key="cell-1"]')).toHaveAttribute('data-revealed', 'true');
  await expect(status).not.toContainText('hit a mine');
  const revealed = await screen.locator('.dg-cell[data-revealed="true"]').count();
  expect(revealed).toBeGreaterThan(1);

  await screen.getByRole('button', { name: 'Patience', exact: true }).click();
  await expect(status).toContainText('1 move');
  await page.keyboard.press('Escape');
  await expect(screen).toBeHidden();
  expect((await page.evaluate(() => window.__h3d.pose()))?.seated).toBe(true);
  await page.keyboard.press('KeyE');
  await expect(screen).toBeVisible();
  await expect(status).toContainText('1 move');
  await screen.getByRole('button', { name: 'Minesweeper', exact: true }).click();
  await expect(screen.locator('.dg-cell[data-revealed="true"]')).toHaveCount(revealed);
  await screen.getByRole('button', { name: 'New game', exact: true }).click();
  await expect(screen.locator('.dg-cell[data-revealed="true"]')).toHaveCount(0);
  await screen.getByRole('button', { name: 'Stand up', exact: true }).click();
  await expect(screen).toBeHidden();
  expect((await page.evaluate(() => window.__h3d.pose()))?.seated).toBe(false);
  clean();
});

for (const ui of ['quiet', 'ubuntu'] as const) for (const [sizeName, size] of [['desktop', DESKTOP], ['narrow', NARROW]] as const) {
  test(`both games fit ${ui} ${sizeName}`, async ({ page }) => {
    const clean = watchErrors(page);
    await boot(page, 'demo-m3b', { ui }, '', 'play=none', size);
    await openDeskGames(page);
    for (const game of ['Patience', 'Minesweeper']) {
      await page.getByRole('button', { name: game, exact: true }).click();
      const geometry = await page.locator('.desk-games-body').evaluate((el) => ({ width: el.clientWidth, scroll: el.scrollWidth }));
      expect(geometry.scroll).toBeLessThanOrEqual(geometry.width + 1);
      const exit = await page.getByRole('button', { name: 'Back to office', exact: true }).boundingBox();
      expect(exit!.x).toBeGreaterThanOrEqual(0);
      expect(exit!.y + exit!.height).toBeLessThanOrEqual(size.height);
      await shot(page, `desk-games-${ui}-${sizeName}-${game.toLowerCase()}`);
    }
    await page.getByRole('button', { name: 'Flag mode', exact: true }).click();
    await page.locator('[data-key="cell-40"]').click();
    await expect(page.locator('[data-key="cell-40"]')).toHaveAttribute('aria-label', /flagged/);
    await page.getByRole('button', { name: 'Back to office', exact: true }).click();
    await expect(page.locator('.desk-games')).toBeHidden();
    clean();
  });
}

test('leaving the floor closes the monitor', async ({ page }) => {
  const clean = watchErrors(page);
  await boot(page, 'demo-m3b', {});
  await openDeskGames(page);
  await page.evaluate(() => window.__h3d.leaveFloor());
  await expect(page.locator('.desk-games')).toBeHidden();
  clean();
});
