import { mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type { Worker } from '../src/net/protocol';
import { frames, openGame, openMenu, seatMode, watchErrors } from './game';

const screens = process.env.H3D_MANUAL_SCREEN_DIR ?? resolve(import.meta.dirname, '../test-results/manual-processes');
mkdirSync(screens, { recursive: true });
const zippy = (JSON.parse(readFileSync(resolve(import.meta.dirname, '../fixtures/demo-m5.jsonl'), 'utf8').split('\n')[0]!) as { world: { workers: Worker[] } }).world.workers.find((w) => w.name === 'Zippy')!;
const sent = (page: Page) => page.evaluate(() => window.__h3d.sent());
const snap = (page: Page, name: string) => page.screenshot({ path: `${screens}/${name}.png`, animations: 'disabled' });
const noOverflow = async (page: Page) => expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

async function seat(page: Page, request: string, key: string): Promise<void> {
  await openGame(page, 'demo-m5', '', `play=none&sim=1&simms=150&simusage=0&simmanual=${key}&simcmdreq=${request}`);
  await page.evaluate(() => window.__h3d.enterFloor('herdr-3d')); await frames(page, 3);
  expect(await page.evaluate((id) => window.__h3d.face(id), zippy.id)).toBe(true); await frames(page, 3);
  expect(await page.evaluate((id) => window.__h3d.sitAt(id), zippy.id)).toBe(true); await frames(page, 20); await seatMode(page, 'transcript');
  await expect(page.locator('.mp-request')).toBeVisible();
}

test('request runs once, terminal detaches, stop and dismiss', async ({ page }) => {
  const clean = watchErrors(page); page.on('dialog', (d) => void d.accept());
  await seat(page, 'multi-line', `journey-${Date.now()}`);
  const card = page.locator('.mp-request');
  await expect(card.locator('pre').first()).toContainText('first'); await snap(page, 'desktop-card');
  await card.getByRole('button', { name: 'Run', exact: true }).dblclick({ delay: 0 });
  await expect(page.locator('.seat-processes')).toContainText('1 manual process');
  expect((await sent(page)).filter((x) => x.t === 'manual_process.start')).toHaveLength(1);
  await page.locator('.seat-processes').click();
  const dialog = page.locator('dialog.mp-dialog'); await expect(dialog).toContainText('State: running'); await snap(page, 'desktop-list');
  await dialog.getByRole('button', { name: 'Open terminal' }).click();
  await expect(dialog).toContainText('Closing this view does not stop the process');
  await expect.poll(async () => {
    const result = await page.evaluate(() => window.__h3d.simTerm('sim.watches', {}));
    return (result.data as { ids: string[] }).ids;
  }).toEqual(expect.arrayContaining([zippy.id, expect.stringMatching(/^mp:/)]));
  const input = dialog.locator('.mp-terminal-input'); await input.fill('hello-terminal');
  await expect(dialog.locator('.xterm-rows')).toContainText('hello-terminal');
  await input.press('Enter'); await input.fill('second-line');
  await expect(dialog.locator('.xterm-rows')).toContainText('second-line'); await snap(page, 'desktop-terminal');
  await dialog.getByRole('button', { name: 'Back to processes' }).click();
  await expect(dialog).toContainText('State: running');
  await dialog.getByRole('button', { name: 'Stop', exact: true }).click(); await expect(dialog).toContainText('State: stopped');
  await dialog.getByRole('button', { name: 'Dismiss' }).click(); await expect(dialog).toContainText('No manual processes yet');
  expect((await sent(page)).filter((x) => x.t === 'worker.keys')).toHaveLength(0);
  clean();
});

test('other host cannot run; manual processes retain distinct states and gone-worker cleanup', async ({ page }) => {
  const clean = watchErrors(page); page.on('dialog', (d) => void d.accept());
  await seat(page, 'other-host', `cleanup-${Date.now()}`);
  await expect(page.locator('.mp-request')).toContainText('The agent asked to run this on the build machine');
  await expect(page.locator('.mp-request').getByRole('button', { name: 'Run', exact: true })).toBeDisabled();
  await page.locator('.mp-request').getByRole('button', { name: 'Edit and run…' }).click();
  const dlg = page.locator('dialog.mp-dialog');
  await dlg.getByLabel('Command').fill('first process'); await dlg.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(dlg).toContainText('State: running');
  await dlg.getByRole('button', { name: 'Run a command…' }).click();
  await dlg.getByLabel('Command').fill('second process'); await dlg.getByRole('button', { name: 'Run', exact: true }).click();
  const rows = dlg.locator('.mp-row'); await expect(rows).toHaveCount(2);
  await rows.filter({ hasText: 'first process' }).getByRole('button', { name: 'Stop' }).click();
  await expect(rows.filter({ hasText: 'first process' })).toContainText('State: stopped');
  await expect(rows.filter({ hasText: 'second process' })).toContainText('State: running');
  await dlg.getByRole('button', { name: 'Close' }).click();
  await page.keyboard.press('Escape'); await frames(page, 3);
  await openMenu(page); await page.locator('[data-action="manual-processes.all"]').click();
  await expect(dlg).toContainText('Gone worker'); await expect(dlg).toContainText('Cleanup: needed');
  await dlg.locator('.mp-row').filter({ hasText: 'Gone worker' }).scrollIntoViewIfNeeded();
  await snap(page, 'desktop-all-cleanup'); clean();
});

test('password retry, success and cancel', async ({ page }) => {
  const clean = watchErrors(page);
  await seat(page, 'sudo', `credential-${Date.now()}`);
  await page.locator('.mp-request').getByRole('button', { name: 'Run', exact: true }).click();
  const credential = page.getByRole('dialog', { name: 'Password requested' }); await expect(credential).toBeVisible();
  await expect(credential).toContainText('sudo -A id'); await snap(page, 'desktop-password');
  await credential.getByLabel('Password').fill('wrong-fixture'); await credential.getByRole('button', { name: 'Submit' }).click();
  await expect(credential).toContainText('Wrong password, try again');
  await expect(credential.getByLabel('Password')).toHaveValue('');
  await credential.getByLabel('Password').fill('fixture-pass'); await credential.getByRole('button', { name: 'Submit' }).click(); await expect(credential).toBeHidden();
  expect(JSON.stringify(await sent(page))).not.toContain('fixture-pass');
  await page.locator('.seat-processes').click(); const dlg = page.locator('dialog.mp-dialog');
  await dlg.getByRole('button', { name: 'Run a command…' }).click(); await dlg.getByLabel('Command').fill('sudo id');
  await dlg.getByRole('button', { name: 'Run', exact: true }).click(); await expect(credential).toBeVisible();
  await credential.getByRole('button', { name: 'Cancel' }).click(); await expect(credential).toBeHidden(); await expect(dlg).toContainText('State: exited');
  clean();
});

test('phone width: card, list, terminal and dialog fit', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await seat(page, 'sudo', `phone-${Date.now()}`);
  await noOverflow(page); await snap(page, 'phone-card');
  await page.locator('.mp-request').getByRole('button', { name: 'Run', exact: true }).click();
  const credential = page.getByRole('dialog', { name: 'Password requested' }); await expect(credential).toBeVisible();
  await noOverflow(page); await snap(page, 'phone-password');
  await credential.getByLabel('Password').fill('fixture-pass'); await credential.getByRole('button', { name: 'Submit' }).click();
  await page.locator('.seat-processes').click(); const dlg = page.locator('dialog.mp-dialog');
  await expect(dlg).toContainText('State: running'); await noOverflow(page); await snap(page, 'phone-list');
  await dlg.getByRole('button', { name: 'Open terminal' }).click(); await noOverflow(page); await snap(page, 'phone-terminal');
});

test('foreground variant is offered and started exactly as reviewed', async ({ page }) => {
  await seat(page, 'tailscale-bg', `variant-${Date.now()}`);
  const card = page.locator('.mp-request');
  await expect(card).toContainText('Ends when the process stops');
  await expect(card).toContainText('sudo tailscale serve --https=8443 http://127.0.0.1:39525');
  await snap(page, 'desktop-variant');
  await card.getByRole('button', { name: 'Run temporary (foreground)' }).click();
  const credential = page.getByRole('dialog', { name: 'Password requested' });
  await expect(credential).toContainText('sudo -A tailscale serve --https=8443');
  const start = (await sent(page)).find((c) => c.t === 'manual_process.start');
  expect(start?.args).toMatchObject({ command: 'sudo tailscale serve --https=8443 http://127.0.0.1:39525', source: { kind: 'suggestion', index: 0 } });
  await credential.getByRole('button', { name: 'Cancel' }).click();
});


test('manual entry is available before any process or suggestion exists', async ({ page }) => {
  await openGame(page, 'demo-m5', '', `play=none&sim=1&simmanual=manual-${Date.now()}`);
  await page.evaluate(() => window.__h3d.enterFloor('herdr-3d')); await frames(page, 3);
  expect(await page.evaluate((id) => window.__h3d.sitAt(id), zippy.id)).toBe(true); await frames(page, 10);
  await expect(page.locator('.seat-processes')).toBeHidden();
  await page.locator('.seat-manual-run').click();
  const dlg = page.locator('dialog.mp-dialog');
  await expect(dlg.getByLabel('Folder')).toHaveValue(zippy.cwd ?? '');
  await dlg.getByLabel('Command').fill('manual process');
  await dlg.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(dlg).toContainText('manual process');
  const start = (await sent(page)).find((c) => c.t === 'manual_process.start');
  expect(start?.args).toMatchObject({ worker: zippy.id, command: 'manual process', source: { kind: 'manual' } });
});
