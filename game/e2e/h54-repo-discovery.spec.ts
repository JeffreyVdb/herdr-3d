import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import type { Worker } from '../src/net/protocol';
import { frames, openGame, openMenu, RESULTS, seatMode, settingsSection, watchErrors } from './game';

// #54: repository discovery, against the simulating fixture server with demo-m5 set up for `@r:` (`simrepos`,
// tools/fixture-repos.ts: its `DISK` is the bridge host's /home/dev/devel). A second client adds the folder in
// Settings → Repository discovery (kept on the bridge: both clients share it); the scan's repositories join the first
// client's open `@r:` popup in the transcript (one row per repository: depot-manager's floor keeps its own checkout,
// the others come without a floor), then the Hire worker dialog's first task and the Prompt overlay offer them too.

const shot = (page: Page, name: string) => page.screenshot({ path: resolve(RESULTS, `${name}.png`) });

function demo(): { workers: Worker[] } {
  return (JSON.parse(readFileSync(resolve(import.meta.dirname, '../fixtures/demo-m5.jsonl'), 'utf8').split('\n')[0] ?? '{}') as { world: { workers: Worker[] } }).world;
}
const workerNamed = (name: string): Worker => {
  const w = demo().workers.find((x) => x.name === name);
  if (!w) throw new Error(`no ${name} in demo-m5`);
  return w;
};

async function sitAtTranscript(page: Page, w: Worker): Promise<void> {
  await page.evaluate(() => window.__h3d.enterFloor('herdr-3d'));
  await frames(page, 3);
  expect(await page.evaluate((id) => window.__h3d.face(id), w.id)).toBe(true);
  await frames(page, 3);
  expect(await page.evaluate((id) => window.__h3d.sitAt(id), w.id)).toBe(true);
  await frames(page, 20);
  await seatMode(page, 'transcript');
  await expect(page.locator('.seat-transcript .tx .tx-scroll')).toBeFocused();
}

const tx = (page: Page) => page.locator('.seat-transcript .tx');
const options = (scope: Locator) => scope.locator('.cmp-pop:not([hidden]) [role="option"]');
const labels = (scope: Locator) => options(scope).locator('.tx-repo-label');
const input = (page: Page) => tx(page).locator('.tx-input');
const dialog = (page: Page) => page.evaluate(() => window.__h3d.dialog());

test('Repository discovery: folders set in Settings on one client; the scan joins @r: in the transcript (an open popup follows), Hire and Prompt', async ({ page, browser }) => {
  test.slow();
  const clean = watchErrors(page);
  const key = `h54-${test.info().workerIndex}-${Date.now()}`;
  const sim = `play=none&sim=1&simms=300&simusage=0&simrepos=${key}`;
  await openGame(page, 'demo-m5', '', sim);
  await sitAtTranscript(page, workerNamed('Pebble'));
  await input(page).click();
  await page.keyboard.type('read @r:');
  const box = tx(page).getByRole('listbox');
  await expect(box).toHaveAttribute('aria-label', 'Repositories on other floors');
  await expect(labels(tx(page))).toHaveText(['fomra/depot-manager', 'pastry']);

  // The other client: Settings → Repository discovery, next to Repositories.
  const ctx = await browser.newContext({ viewport: page.viewportSize() ?? { width: 1280, height: 800 } });
  const other = await ctx.newPage();
  const cleanOther = watchErrors(other);
  await openGame(other, 'demo-m5', '', sim);
  await openMenu(other);
  await other.getByRole('button', { name: 'Settings', exact: true }).click();
  const tabs = other.getByRole('dialog', { name: 'Settings' }).locator('[role="tab"]');
  const ids = await tabs.evaluateAll((ts) => ts.map((t) => (t as HTMLElement).dataset.tab));
  expect(ids.indexOf('repo-discovery')).toBe(ids.indexOf('repos') + 1);
  const section = await settingsSection(other, 'repo-discovery');
  await expect(section.locator('.settings-store')).toHaveText('Bridge');
  await expect(section.locator('.settings-role-head .settings-badge')).toHaveText('Off');
  await expect(section.locator('.settings-lede')).toContainText('bridge host');
  const add = section.getByLabel('Add a folder');
  const hint = section.locator(`#${await add.getAttribute('aria-describedby')}`);
  await add.fill('devel');
  await section.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(add).toHaveAttribute('aria-invalid', 'true');
  await expect(hint).toHaveText('Use an absolute path on the bridge host, starting with /.');
  await add.fill('/home/dev/devel/');
  await add.press('Enter');
  await expect(section.locator('.settings-status')).toHaveText('Added /home/dev/devel. Scanning it now.');
  await expect(section.locator('.settings-used')).toContainText('6 repositories in 7 checkouts. Last scanned at');
  await expect(section.locator('.settings-rd-root .settings-badge')).toHaveText(['7 checkouts']);
  await expect(section.locator('.settings-role-head .settings-badge')).toHaveText('Up to date');
  await add.fill('/media/missing/usb');
  await add.press('Enter');
  await expect(section.locator('.settings-rd-root .settings-badge')).toHaveText(['7 checkouts', 'Not readable']);
  await expect(section.locator('.settings-rd-root').nth(1).locator('.settings-field-error')).toHaveText('The folder does not exist on the bridge host.');
  await expect(section.locator('.settings-role-head .settings-badge')).toHaveText('Needs attention');
  await section.getByLabel('Refresh every (minutes)').fill('25');
  await section.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(section.locator('.settings-status')).toHaveText('Saved. The folders are scanned every 25 minutes.');
  await section.locator('.settings-rd-policy summary').click();
  await shot(other, 'h54-settings');
  await other.setViewportSize({ width: 390, height: 844 });
  await section.locator('.settings-rd-roots').scrollIntoViewIfNeeded();
  await shot(other, 'h54-settings-phone');

  // The first client's popup, open all along, follows the scan: one row per repository.
  await expect(box).toHaveAttribute('aria-label', 'Repositories');
  await expect(labels(tx(page))).toHaveText(['fomra/depot-manager', 'pastry', 'api', 'api', 'JeffreyVdb/field-notes', 'JeffreyVdb/herdr-3d', 'notes']);
  const rows = options(tx(page));
  await expect(rows.first().locator('.tx-repo-dir')).toHaveText('/home/dev/devel/fomra/depot-manager');
  await expect(rows.first().locator('.tx-repo-floor')).toHaveText('depot-manager');
  await expect(rows.nth(2).locator('.tx-repo-dir')).toHaveText('/home/dev/devel/scratch/api');
  await expect(rows.nth(3).locator('.tx-repo-dir')).toHaveText('/home/dev/devel/work/api');
  await expect(rows.nth(2).locator('.tx-repo-floor')).toHaveCount(0);
  await expect(rows.nth(4).locator('.tx-repo-note')).toHaveCount(0);
  await shot(page, 'h54-transcript');
  await page.keyboard.type('work/api');
  await expect(labels(tx(page))).toHaveText(['api']);
  await page.keyboard.press('Enter');
  await expect(input(page)).toHaveText('read /home/dev/devel/work/api ');
  await expect(input(page).locator('.cmp-file')).toHaveCount(0);
  // Plain `@` is still a file search.
  await page.keyboard.type('@REA');
  await expect(box).toHaveAttribute('aria-label', 'Files and folders');
  await page.keyboard.press('Escape');
  cleanOther();
  await ctx.close();

  // Hire worker: the first task's @r: lists them too.
  await page.keyboard.press('Escape');
  await expect.poll(() => page.evaluate(() => window.__h3d.seated())).toBeNull();
  await page.evaluate(() => window.__h3d.openHire(5));
  await expect.poll(async () => (await dialog(page)) as { kind: string; state: string } | null, { timeout: 10_000 }).toMatchObject({ kind: 'hire', state: 'ready' });
  const hire = page.locator('dialog.desk-dlg--hire');
  const task = page.locator('#hire-task');
  await task.click();
  await page.keyboard.type('fix @r:herdr-3d');
  await expect(hire.getByRole('listbox')).toHaveAttribute('aria-label', 'Repositories');
  await expect(labels(hire)).toHaveText(['JeffreyVdb/herdr-3d']);
  await page.keyboard.press('Enter');
  await expect(task).toContainText('fix /home/dev/devel/JeffreyVdb/herdr-3d ');
  await page.keyboard.press('Escape');
  await expect(hire).toBeHidden();

  // The Prompt overlay's.
  await page.evaluate((w) => window.__h3d.openPrompt(w), workerNamed('Nibble').id);
  const overlay = page.locator('dialog.desk-dlg--prompt');
  const note = page.locator('#prompt-text');
  await expect(note).toBeFocused();
  await page.keyboard.type('see @r:notes');
  await expect(overlay.getByRole('listbox')).toHaveAttribute('aria-label', 'Repositories');
  await expect(labels(overlay).first()).toHaveText('notes');
  await page.keyboard.press('Enter');
  await expect(note).toHaveText('see /home/dev/devel/notes ');
  clean();
});
