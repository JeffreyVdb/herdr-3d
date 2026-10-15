import { expect, test, type Page } from '@playwright/test';
import { frames, openGame, openMenu, settingsSection, watchErrors } from './game';

// #194 on demo-m4 with the simulator (sim=1): Settings → Harness models hides a model, and the Hire dialog for the
// desk stops offering it, on the next opening and in the form already open. Nothing is hidden until the player hides it.

const SIM = 'play=none&sim=1&simms=150';

async function openSettings(page: Page): Promise<void> {
  await openMenu(page);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible();
  // #49: one section at a time: show Harness models.
  await settingsSection(page, 'harness-models');
}

test('a model hidden in Settings leaves the Hire dialog, and comes back when shown again', async ({ page }) => {
  test.setTimeout(150_000);
  const clean = watchErrors(page);
  await openGame(page, 'demo-m4', '', SIM);
  await page.evaluate(() => window.__h3d.enterFloor('pastry'));
  await frames(page, 3);
  const openHire = async () => {
    await page.evaluate(() => window.__h3d.openHire(14));
    await expect.poll(() => page.evaluate(() => window.__h3d.dialog()?.kind === 'hire' && window.__h3d.dialog()?.state), { timeout: 10_000 }).toBe('ready');
  };
  const chips = () => page.locator('[data-pick="model"] input').evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value));

  await openHire();
  const form = await page.evaluate(() => { const d = window.__h3d.dialog(); return d?.kind === 'hire' ? d.form : null; });
  const before = await chips();
  expect(before.length).toBeGreaterThan(1);
  const harness = form?.harness === 'codex' ? 'Codex' : 'Claude Code';
  await page.keyboard.press('Escape');
  await expect.poll(() => page.evaluate(() => window.__h3d.dialog())).toBeNull();

  // Settings: no model is hidden at first.
  await openSettings(page);
  const section = page.locator('[data-section="harness-models"]');
  await expect(section).toBeVisible();
  const group = section.locator('.hm-group').filter({ has: page.getByRole('heading', { name: harness, exact: true }) });
  await expect(group.locator('.settings-badge')).toHaveText(`${before.length} of ${before.length} shown`);
  await expect(group.locator('.hm-row input:checked')).toHaveCount(before.length);
  await page.getByRole('dialog', { name: 'Settings' }).screenshot({ path: test.info().outputPath('harness-models.png') });

  // Hide the first model of that harness.
  const row = group.locator('.hm-row').first();
  const slug = (await row.locator('.hm-slug').textContent()) ?? '';
  await row.getByRole('checkbox').uncheck();
  await expect(group.locator('.settings-badge')).toHaveText(`${before.length - 1} of ${before.length} shown`);
  await page.keyboard.press('Escape');

  await openHire();
  expect(await chips()).toEqual(before.filter((v) => v !== slug));
  await page.keyboard.press('Escape');
  await expect.poll(() => page.evaluate(() => window.__h3d.dialog())).toBeNull();

  // Shown again: back on the list, in order.
  await openSettings(page);
  await group.locator('.hm-row').first().getByRole('checkbox').check();
  await page.keyboard.press('Escape');
  await openHire();
  expect(await chips()).toEqual(before);
  clean();
});

test('every model of the harness hidden: Hire says so, offers Settings, and Show all brings the list back', async ({ page }) => {
  test.setTimeout(150_000);
  const clean = watchErrors(page);
  await openGame(page, 'demo-m4', '', SIM);
  await page.evaluate(() => window.__h3d.enterFloor('pastry'));
  await frames(page, 3);
  await page.evaluate(() => window.__h3d.openHire(14));
  await expect.poll(() => page.evaluate(() => window.__h3d.dialog()?.kind === 'hire' && window.__h3d.dialog()?.state), { timeout: 10_000 }).toBe('ready');
  const harness = (await page.evaluate(() => { const d = window.__h3d.dialog(); return d?.kind === 'hire' ? d.form.harness : null; })) === 'codex' ? 'Codex' : 'Claude Code';
  await page.keyboard.press('Escape');
  await expect.poll(() => page.evaluate(() => window.__h3d.dialog())).toBeNull();

  await openSettings(page);
  const group = page.locator('[data-section="harness-models"] .hm-group').filter({ has: page.getByRole('heading', { name: harness, exact: true }) });
  const total = await group.locator('.hm-row input').count();
  for (let i = 0; i < total; i++) await group.locator('.hm-row input:checked').first().uncheck();
  await expect(group.locator('.settings-badge')).toHaveText(`0 of ${total} shown`);
  await page.keyboard.press('Escape');

  await page.evaluate(() => window.__h3d.openHire(14));
  await expect.poll(() => page.evaluate(() => window.__h3d.dialog()?.kind === 'hire' && window.__h3d.dialog()?.state), { timeout: 10_000 }).toBe('ready');
  const callout = page.locator('[data-hook="no-models"]');
  await expect(callout).toContainText(`All ${total} ${harness} models are hidden`);
  await expect(page.locator('[data-key="hire"]')).toHaveAttribute('aria-disabled', 'true');
  await page.locator('dialog.desk-dlg--hire[open]').screenshot({ path: test.info().outputPath('hire-no-models.png') });

  await page.locator('[data-key="show-models"]').click();
  await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible();
  // #49: the link shows Harness models whatever section was open, its heading focused.
  await expect(page.locator('[data-section="harness-models"]')).toBeVisible();
  await expect(page.locator('[data-section="harness-models"] h3')).toBeFocused();
  await group.getByRole('button', { name: `Show all ${harness} models` }).click();
  await expect(group.locator('.settings-badge')).toHaveText(`${total} of ${total} shown`);
  await page.keyboard.press('Escape');
  // The open Hire form follows the change: its list is back, and nothing is left to hire with.
  await expect(callout).toHaveCount(0);
  await expect(page.locator('[data-key="hire"]')).not.toHaveAttribute('aria-disabled', 'true');
  clean();
});
