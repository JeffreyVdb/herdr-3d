import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type { Worker } from '../src/net/protocol';
import { frames, openGame, openMenu, RESULTS, seatMode, watchErrors } from './game';

// #247: `@r:` in the transcript's prompt box lists the repositories and folders of the other floors of the worker's
// building, against the simulating fixture server with demo-m5 set up for it (`simrepos`, tools/fixture-repos.ts):
// Pebble sits on herdr-3d in Work, whose other floors are depot-manager (a repo, its folder a checkout of it) and
// pastry (a folder only); scratchpad is in Personal with a repo and no folder. The "Repositories from other buildings"
// switch is the bridge's: turned on in one client, the other client's open popup lists scratchpad too.

const shot = (page: Page, name: string) => page.screenshot({ path: resolve(RESULTS, `${name}.png`) });

function demoWorker(name: string): Worker {
  const snap = JSON.parse(readFileSync(resolve(import.meta.dirname, '../fixtures/demo-m5.jsonl'), 'utf8').split('\n')[0] ?? '{}') as { world: { workers: Worker[] } };
  const w = snap.world.workers.find((x) => x.name === name);
  if (!w) throw new Error(`no ${name} in demo-m5`);
  return w;
}

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
const pop = (page: Page) => tx(page).locator('.cmp-pop');
const rows = (page: Page) => tx(page).locator('[role="option"]');
const labels = (page: Page) => rows(page).locator('.tx-repo-label');
const input = (page: Page) => tx(page).locator('.tx-input');
const prompts = (page: Page) => page.evaluate(() => window.__h3d.sent().filter((c) => c.t === 'worker.prompt').map((c) => (c.args as { text: string }).text));

test('@r: lists this building’s other floors; a pick puts in the folder; the shared switch adds the other building in another client', async ({ page, browser }) => {
  const clean = watchErrors(page);
  const key = `h247-${test.info().workerIndex}-${Date.now()}`;
  const sim = `play=none&sim=1&simms=300&simusage=0&simrepos=${key}`;
  const pebble = demoWorker('Pebble');
  await openGame(page, 'demo-m5', '', sim);
  await sitAtTranscript(page, pebble);

  await input(page).click();
  await page.keyboard.type('read @r:');
  await expect(pop(page)).toBeVisible();
  await expect(tx(page).getByRole('listbox')).toHaveAttribute('aria-label', 'Repositories on other floors');
  await expect(labels(page)).toHaveText(['fomra/depot-manager', 'pastry']);
  await expect(rows(page).first().locator('.tx-repo-floor')).toHaveText('depot-manager');
  await expect(rows(page).first().locator('.tx-repo-note')).toHaveCount(0);
  await expect(rows(page).nth(1).locator('.tx-repo-dir')).toHaveText('/home/dev/pastry');
  // Fuzzy: `ifm` is in depot-manager in order, not side by side.
  await page.keyboard.type('ifm');
  await expect(labels(page)).toHaveText(['fomra/depot-manager']);
  await expect(rows(page).first().locator('.tx-repo-name .tx-repo-hit')).toHaveText(['i', 'f', 'm']);
  await shot(page, 'h247-open');
  await page.keyboard.press('Enter');
  await expect(pop(page)).toBeHidden();
  await expect(input(page)).toHaveText('read /home/dev/devel/fomra/depot-manager ');
  // Plain text, not a file chip.
  await expect(input(page).locator('.cmp-file')).toHaveCount(0);

  // `@r` without the colon is still a file search.
  await page.keyboard.type('@r');
  await expect(tx(page).getByRole('listbox')).toHaveAttribute('aria-label', 'Files and folders');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Backspace');

  // A second client: its @repo: popup is open when the first one turns the switch on, and follows.
  const ctx = await browser.newContext({ viewport: page.viewportSize() ?? { width: 1280, height: 800 } });
  const other = await ctx.newPage();
  const cleanOther = watchErrors(other);
  await openGame(other, 'demo-m5', '', sim);
  await sitAtTranscript(other, pebble);
  await input(other).click();
  await other.keyboard.type('@repo:');
  await expect(labels(other)).toHaveText(['fomra/depot-manager', 'pastry']);

  await page.keyboard.press('Escape');
  await expect.poll(() => page.evaluate(() => window.__h3d.seated())).toBeNull();
  await openMenu(page);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const section = page.getByRole('dialog', { name: 'Settings' }).locator('[data-section="repos"]');
  await expect(section.locator('.settings-store')).toHaveText('Bridge');
  const toggle = section.getByRole('checkbox', { name: 'Repositories from other buildings' });
  await expect(toggle).not.toBeChecked();
  await toggle.check();
  await expect(section.locator('.settings-status')).toHaveText('On. @r: lists every building’s floors.');
  await section.scrollIntoViewIfNeeded();
  await shot(page, 'h247-settings-on');

  await expect(labels(other)).toHaveText(['fomra/depot-manager', 'pastry', 'JeffreyVdb/field-notes']);
  const scratch = rows(other).nth(2);
  await expect(scratch.locator('.tx-repo-floor')).toHaveText('scratchpad · Personal');
  await expect(scratch.locator('.tx-repo-note')).toHaveText('not cloned');
  await other.keyboard.type('notes');
  await expect(labels(other)).toHaveText(['JeffreyVdb/field-notes']);
  await shot(other, 'h247-other-building');
  await other.keyboard.press('Tab');
  await expect(input(other)).toHaveText('https://github.com/JeffreyVdb/field-notes ');
  await other.keyboard.type('please');
  await other.keyboard.press('Enter');
  await expect.poll(() => prompts(other)).toEqual(['https://github.com/JeffreyVdb/field-notes please']);

  cleanOther();
  await ctx.close();
  clean();
});
