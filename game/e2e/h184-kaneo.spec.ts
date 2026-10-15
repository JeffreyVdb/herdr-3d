import { expect, test, type Locator, type Page } from '@playwright/test';
import { openGame, openMenu, settingsSection, shot, watchErrors } from './game';
import { enter } from './m7';

// #184: Kaneo as a floor's issue tracker, on demo-m6 with the simulating fixture server (tools/fixture-kaneo.ts):
// Settings → Kaneo (test and save the connection), a floor's tracker, workspace and project, and its Kaneo board.
// `simkaneo=connected` starts with https://kaneo.example.test saved (default workspace Studio); `simkaneoslow` is how
// long the Slow lane workspace's projects take. `open=none` records "Open in Kaneo" instead of opening a window.

const SIM = 'play=none&sim=1&simms=150&simusage=0';
const EXTRA = '&open=none';
const KEY = 'kaneo-e2e-key-0123456789';

async function settings(page: Page): Promise<Locator> {
  await openMenu(page);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await expect(dialog).toBeVisible();
  // #49: one section at a time: show Kaneo.
  return settingsSection(page, 'kaneo');
}

async function floorSettings(page: Page, session = 'lab'): Promise<Locator> {
  await enter(page, session);
  await page.evaluate(() => window.__h3d.openElevator());
  await page.getByRole('button', { name: `Settings for ${session}` }).click();
  await expect(page.locator('dialog.panel h2')).toHaveText('Floor settings');
  return page.locator('dialog.panel');
}

test('connect Kaneo in Settings: a failed test says why, Save follows a passing test, the key never stays in the page', async ({ page }) => {
  const clean = watchErrors(page);
  await openGame(page, 'demo-m6', EXTRA, SIM);
  const k = await settings(page);
  await expect(k.locator('.settings-store')).toHaveText('Bridge');
  await expect(k.locator('.settings-badge')).toHaveText('Not connected');
  const save = k.getByRole('button', { name: 'Save' });
  const testBtn = k.getByRole('button', { name: 'Test connection' });
  await k.getByLabel('Instance address').fill('https://kaneo.example.test');
  await expect(testBtn).toBeDisabled(); // a first connection needs its key
  await k.getByLabel('API key').fill('bad-key-000');
  await testBtn.click();
  await expect(k.locator('.settings-status')).toContainText('quota');
  await expect(save).toBeDisabled();
  await k.getByLabel('API key').fill(KEY);
  await testBtn.click();
  await expect(k.locator('.settings-status')).toContainText('5 workspaces');
  await expect(save).toBeEnabled();
  await k.getByLabel('Default workspace').selectOption({ label: 'Studio' });
  // An edit undoes the test.
  await k.getByLabel('Instance address').fill('https://kaneo.example.test/api');
  await expect(save).toBeDisabled();
  await testBtn.click();
  await expect(save).toBeEnabled();
  await k.getByLabel('Default workspace').selectOption({ label: 'Studio' });
  await save.click();
  await expect(k.locator('.settings-badge')).toHaveText('Connected');
  await expect(k.getByLabel('API key')).toHaveValue('');
  await shot(page, 'h184-settings-kaneo');
  const everything = await page.evaluate(() => document.documentElement.outerHTML + [...document.querySelectorAll('input')].map((e) => e.value).join('|'));
  expect(everything).not.toContain(KEY);
  const log = await page.evaluate(() => window.__h3d.sent());
  expect(log.filter((c) => c.t.startsWith('kaneo.')).length).toBeGreaterThanOrEqual(4);
  expect(JSON.stringify(log)).not.toContain(KEY);
  // Closed and opened again: the saved connection, a blank key.
  await page.keyboard.press('Escape');
  const again = await settings(page);
  await expect(again.getByLabel('Instance address')).toHaveValue('https://kaneo.example.test/api');
  await expect(again).toContainText('Leave blank to keep it');
  // A phone: the section fits, no sideways scroll.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(again.getByRole('button', { name: 'Disconnect' })).toBeInViewport({ ratio: 0.5 });
  expect(await page.evaluate(() => document.querySelector('dialog.settings')!.scrollWidth <= document.querySelector('dialog.settings')!.clientWidth)).toBe(true);
  // #49: nor inside the section's scroller, the Kaneo panel still the one shown.
  await expect(again).toBeVisible();
  expect(await page.evaluate(() => { const b = document.querySelector('dialog.settings .settings-body')!; return b.scrollWidth <= b.clientWidth; })).toBe(true);
  await shot(page, 'h184-settings-kaneo-phone');
  clean();
});

test('a floor uses Kaneo: the default workspace prefilled, a late list never lands, the project chosen by name, its board', async ({ page }) => {
  test.setTimeout(120_000);
  const clean = watchErrors(page);
  await openGame(page, 'demo-m6', EXTRA, `${SIM}&simkaneo=connected&simkaneoslow=900`);
  const panel = await floorSettings(page);
  await panel.locator('label.tracker-opt', { hasText: 'Kaneo' }).click();
  const ws = panel.locator('#set-kaneoWorkspace');
  const project = panel.locator('#set-kaneoProject');
  await expect(ws).toHaveValue('ws-studio');
  await expect(project.locator('option')).toHaveText(['Choose a project', 'herdr-3d', 'Website']);
  await expect(project).toHaveValue(''); // never picked for you
  // The GitHub Project fieldset steps aside; the repo stays (pull requests).
  await expect(panel.locator('#set-projectOwner')).toBeHidden();
  await expect(panel.locator('#set-repo')).toBeVisible();
  // Saving without a project says so.
  await panel.getByRole('button', { name: 'Save settings' }).click();
  await expect(panel.locator('#set-kaneoProject-hint')).toContainText('Choose the project');
  // Slow lane, then Home at once: Slow lane's late list never lands.
  await ws.selectOption({ label: 'Slow lane' });
  await ws.selectOption({ label: 'Home' });
  await expect(project.locator('option')).toHaveText(['Choose a project', 'Garden']);
  await page.waitForTimeout(1300);
  await expect(project.locator('option')).toHaveText(['Choose a project', 'Garden']);
  await ws.selectOption({ label: 'Locked' });
  await expect(panel.locator('#set-kaneoProject-hint')).toContainText('may not see');
  await ws.selectOption({ label: 'Studio' });
  await project.selectOption({ label: 'herdr-3d' });
  await panel.getByRole('button', { name: 'Save settings' }).click();
  await expect(panel.locator('p.panel-status[role="status"]')).toContainText('Saved the issue tracker, Kaneo project');
  await shot(page, 'h184-floor-kaneo');
  await page.keyboard.press('Escape');

  // The Kaneo board: tasks, its own columns, no GitHub close.
  await openMenu(page);
  await page.locator('.topbar button', { hasText: 'Issues' }).click();
  const board = page.locator('dialog.desk-dlg--board');
  await expect(board.locator('h2')).toHaveText('Tasks · lab');
  await expect(board.locator('.bd-col[data-kind="planned"]')).toBeVisible();
  await expect(board.locator('.bd-col[data-kind="archived"]')).toContainText('archived, not done');
  await expect(board.locator('.bd-col[data-done="true"]')).toHaveCount(2);
  await board.locator('.bd-card', { hasText: 'HRD-4' }).click();
  const item = page.getByRole('dialog').filter({ has: page.locator('#item-title') });
  await expect(item.locator('#item-title')).toHaveText('A task with a long description');
  await expect(item).toContainText('Step 40'); // the description the list left out
  await expect(item.getByRole('button', { name: 'Close issue…' })).toHaveCount(0);
  await item.getByRole('button', { name: 'Open in Kaneo' }).click();
  await expect.poll(() => page.evaluate(() => window.__h3d.opened().map((o) => o.url))).toContain('https://kaneo.example.test/dashboard/workspace/ws-studio/project/p-herdr/task/task-hrd-4');
  await shot(page, 'h184-kaneo-board');
  clean();
});

test('a refused key pauses the Kaneo board, and a re-test in Settings resumes it', async ({ page }) => {
  test.setTimeout(120_000);
  const clean = watchErrors(page);
  await openGame(page, 'demo-m6', EXTRA, `${SIM}&simkaneo=connected`);
  await page.setViewportSize({ width: 390, height: 844 });
  const panel = await floorSettings(page);
  await panel.locator('label.tracker-opt', { hasText: 'Kaneo' }).click();
  await panel.locator('#set-kaneoProject').selectOption({ label: 'herdr-3d' });
  expect(await panel.evaluate((d) => d.querySelector('.panel-body, form')!.scrollWidth <= d.querySelector('.panel-body, form')!.clientWidth + 1)).toBe(true);
  await shot(page, 'h184-floor-kaneo-phone');
  await page.setViewportSize({ width: 1280, height: 720 });
  await panel.getByRole('button', { name: 'Save settings' }).click();
  await expect(panel.locator('p.panel-status[role="status"]')).toContainText('Saved');
  await page.keyboard.press('Escape');
  await openMenu(page);
  await page.locator('.topbar button', { hasText: 'Issues' }).click();
  const board = page.locator('dialog.desk-dlg--board');
  await expect(board.locator('h2')).toHaveText('Tasks · lab');
  await page.evaluate(() => window.__h3d.simKaneo({ fail: 'unauthorized' }));
  await expect(board.locator('[data-tone]')).toContainText('refused herdr-world’s key');
  await expect(board.locator('[data-tone]')).toContainText('paused');
  await page.keyboard.press('Escape');
  const k = await settings(page);
  await expect(k.locator('.settings-badge')).toHaveText('Paused');
  await k.getByRole('button', { name: 'Test connection' }).click();
  await expect(k.locator('.settings-badge')).toHaveText('Connected');
  clean();
});
