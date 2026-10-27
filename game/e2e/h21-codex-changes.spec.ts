import { expect, test, type Locator, type Page } from '@playwright/test';
import { frames, openGame, seatMode, shot, watchErrors } from './game';

// #21: Codex's code changes in the transcript, for real on the WebGL2 path: demo-h171 with the simulating fixture server and
// `simtx=demo-h21`, whose watches get the Codex timeline (tools/fixture-transcript.ts `h21Timeline`: what the bridge makes of
// its own Codex fixtures, every source and state, half of it older than the watch's window). Open it yourself:
// ?ws=%2Ffixture%2Fdemo-h171%3Fsim%3D1%26simtx%3Ddemo-h21 and sit at Nibble on herdr-3d.

const FLOOR = 'herdr-3d';
const SIM = 'play=none&sim=1&simms=500&simusage=0&simtx=demo-h21';
const P = '/home/dev/project/';
const DIRECT = 'call_c21direct0000000000000007';
const RENAME = 'exec-0c210011-0000-4000-8000-000000000001';
const RUNNING = 'call_c21exec0running00000014';
const LEGACY_EXEC = 'call_c21exec0nestfail000000010';
const OLD_PATCH = 'exec-0c210001-0000-4000-8000-000000000001';

type Theme = Awaited<ReturnType<Window['__h3d']['theme']>>;
const theme = (page: Page) => page.evaluate(() => window.__h3d.theme()) as Promise<Theme>;
const stored = (page: Page) => page.evaluate(() => localStorage.getItem('h3d.transcript.showChanges'));

async function sitAt(page: Page): Promise<Locator> {
  await openGame(page, 'demo-h171', '&prints=0', SIM);
  await page.evaluate((s) => window.__h3d.enterFloor(s), FLOOR);
  await frames(page, 3);
  const id = await page.evaluate(() => window.__h3d.world().flatMap((f) => f.workers).find((w) => w.name === 'Nibble')?.id ?? '');
  expect(await page.evaluate((i) => window.__h3d.face(i), id)).toBe(true);
  await frames(page, 3);
  expect(await page.evaluate((w) => window.__h3d.sitAt(w), id)).toBe(true);
  await expect.poll(() => page.evaluate(() => window.__h3d.seated())).toBe(id);
  await seatMode(page, 'transcript');
  const tx = page.locator('.seat-transcript .tx');
  await expect(tx).toBeVisible();
  await expect(tx.locator(`[data-id="${RUNNING}"]`)).toBeAttached();
  return tx;
}

const file = (tx: Locator, id: string, n = 0) => tx.locator(`[data-id="${id}"] .tx-chg-file`).nth(n);
const ids = (tx: Locator) => tx.locator('[data-id]').evaluateAll((els) => els.map((e) => e.getAttribute('data-id')));

test('Codex changes show by default, direct and exec-wrapped, with every status; the two switches stay apart', async ({ page }) => {
  test.setTimeout(150_000);
  const clean = watchErrors(page);
  const tx = await sitAt(page);
  expect(await theme(page)).toMatchObject({ showChanges: true, hideTools: false });

  // Direct apply_patch: Codex's record, with its line numbers; the raw input stays closed.
  const direct = tx.locator(`[data-id="${DIRECT}"]`);
  await direct.scrollIntoViewIfNeeded();
  await expect(direct.locator('.tx-tool-body')).toBeHidden();
  await expect(direct.locator('.tx-chg-head .tx-diff-path')).toHaveText([`${P}src/clock.ts`, `${P}tests/clock.test.ts`]);
  await expect(direct.locator('.tx-dh')).toHaveText(['@@ -7,1 +7,1 @@', '@@ -0,0 +1,2 @@']);
  await expect(file(tx, DIRECT, 1).locator('.tx-chg-op')).toHaveText(['new']);
  // A script's patch: its own row after the script, which shows none once done.
  const rename = tx.locator(`[data-id="${RENAME}"]`);
  await expect(rename.locator('.tx-tool-name')).toHaveText('apply_patch');
  await expect(rename.locator('.tx-chg-op')).toHaveText(['renamed', 'renamed']);
  await expect(rename.locator('.tx-chg-to').first()).toHaveText(`→ ${P}infra/buoy-cost.tf`);
  await expect(tx.locator('[data-id="call_c21exec0rename00000000011"] .tx-changes')).toHaveCount(0);
  await rename.scrollIntoViewIfNeeded();
  await frames(page, 4);
  await shot(page, 'h21-codex-renamed');
  // On a phone the long paths give way together: some of the new one still shows beside the old.
  await page.setViewportSize({ width: 390, height: 844 });
  const widths = () =>
    rename.locator('.tx-chg-head').first().evaluate((h) => ['.tx-chg-from', '.tx-chg-to'].map((s) => h.querySelector(s)!.getBoundingClientRect().width));
  await expect.poll(async () => Math.min(...(await widths()))).toBeGreaterThan(40);
  await rename.scrollIntoViewIfNeeded();
  await frames(page, 4);
  await shot(page, 'h21-codex-renamed-390');
  await page.setViewportSize({ width: 1280, height: 720 });
  // A nested patch that failed under a script that completed; a declined one; an interrupted script.
  await expect(tx.locator('[data-id="exec-0c210010-0000-4000-8000-000000000002"] .tx-chg-state')).toHaveText('The call failed: these changes may not have been applied, or only in part.');
  await expect(tx.locator(`[data-id="${LEGACY_EXEC}"] .tx-tool-status`)).toHaveText('done');
  await expect(tx.locator('[data-id="exec-0c210012-0000-4000-8000-000000000001"] .tx-chg-state')).toHaveText('Denied: not applied.');
  await expect(tx.locator('[data-id="call_c21exec0interrupt0000013"] .tx-tool-status')).toHaveText('interrupted');
  await expect(tx.locator('[data-id="call_c21exec0interrupt0000013"] .tx-changes')).toHaveCount(0);
  await expect(tx.locator('[data-id="call_c21directfail00000000008"] .tx-tool-status')).toHaveText('error');
  await expect(tx.locator('[data-id="call_c21directfail00000000008"] .tx-changes')).toHaveCount(0);
  // Still running: proposed, no line numbers made up; the patch it builds itself is said, not shown.
  const running = tx.locator(`[data-id="${RUNNING}"]`);
  await running.scrollIntoViewIfNeeded();
  await expect(running.locator('.tx-chg-state')).toHaveText('Proposed: not applied yet.');
  await expect(running.locator('.tx-changes > .tx-chg-note')).toHaveText('1 more patch is built by the script, not written out: the changes show once Codex applies it.');
  await expect(running.locator('.tx-dh')).toHaveCount(0);
  await frames(page, 4);
  await shot(page, 'h21-codex-changes');

  // Hide tools: the scripts go, their patches' changes stay (still open).
  await tx.locator('.tx-check-box').check();
  expect(await theme(page)).toMatchObject({ showChanges: true, hideTools: true });
  await expect(tx.locator('[data-id="call_c21exec0rename00000000011"]')).toBeHidden();
  await rename.scrollIntoViewIfNeeded();
  await expect(rename.locator('.tx-tool-row')).toBeHidden();
  await expect(rename.locator('.tx-changes')).toBeVisible();
  await expect(file(tx, RENAME, 1).locator('.tx-diff-body')).toBeVisible();
  await expect(direct.locator('.tx-changes')).toBeVisible();
  // Code changes off too: a line per file, stored; Hide tools off: the switches are apart.
  await tx.locator('.tx-chg-box').uncheck();
  expect(await theme(page)).toMatchObject({ showChanges: false, hideTools: true });
  expect(await stored(page)).toBe('0');
  await expect(file(tx, RENAME, 1).locator('.tx-chg-body')).toBeHidden();
  await tx.locator('.tx-check-box').uncheck();
  expect(await theme(page)).toMatchObject({ showChanges: false, hideTools: false });
  await expect(tx.locator('[data-id="call_c21exec0rename00000000011"]')).toBeVisible();
  await expect(file(tx, RENAME, 1).locator('.tx-chg-body')).toBeHidden();

  // To the terminal and back: the same changes, no duplicates; the choice holds.
  const heads = await tx.locator('.tx-chg-head').allTextContents();
  await seatMode(page, 'terminal');
  await seatMode(page, 'transcript');
  await expect(tx.locator('.tx-chg-head')).toHaveText(heads);
  await expect(file(tx, RENAME, 1).locator('.tx-chg-body')).toBeHidden();
  const seen = await ids(tx);
  expect(new Set(seen).size).toBe(seen.length);
  await tx.locator('.tx-chg-box').check();
  expect(await stored(page)).toBeNull();
  await expect(file(tx, RENAME, 1).locator('.tx-diff-body')).toBeVisible();
  clean();
});

test('older Codex changes page in once, with their line numbers; a reload restores the same history and choice', async ({ page }) => {
  test.setTimeout(150_000);
  const clean = watchErrors(page);
  let tx = await sitAt(page);
  // Past the watch's window: the first scripts' patches are not here yet.
  await expect(tx.locator(`[data-id="${OLD_PATCH}"]`)).toHaveCount(0);
  // "Jump to message" from the chart at the start pages them in.
  const box = page.locator('.seat-transcript');
  await page.locator('.seat-rail').getByRole('tab', { name: /^Images/ }).click(); // #216: the rail
  const input = box.locator('.imgs .imgs-group[data-origin="input"] .imgs-item');
  await expect(input).toHaveCount(1);
  await input.first().locator('.imgs-tile').click();
  const lb = page.locator('dialog.ilb');
  await lb.locator('.ilb-jump').click();
  await expect(lb).toHaveCount(0);
  await expect(box.locator('[data-id="h21-ask"].tx-flash')).toBeVisible();
  const log = [...(await page.evaluate(() => window.__h3d.sent())), ...(await page.evaluate(() => window.__h3d.watchLog()))];
  expect(log.filter((c) => c.t === 'transcript.page' && c.result?.ok).length).toBeGreaterThan(0);
  const old = tx.locator(`[data-id="${OLD_PATCH}"]`);
  await expect(old.locator('.tx-dh')).toHaveText('@@ -3,3 +3,4 @@');
  await expect(tx.locator('[data-id="exec-0c210002-0000-4000-8000-000000000002"] .tx-chg-op')).toHaveText(['deleted', 'new', 'new']);
  // Each item once, in order, the newest still there.
  const all = await ids(tx);
  expect(new Set(all).size).toBe(all.length);
  expect(all.indexOf('h21-ask')).toBeLessThan(all.indexOf(OLD_PATCH));
  expect(all).toContain(RUNNING);
  // Reading from the middle: switching code changes off and on keeps the row in place.
  const scroller = tx.locator('.tx-scroll');
  await old.evaluate((e) => e.scrollIntoView({ block: 'start' }));
  await scroller.evaluate((s) => s.dispatchEvent(new Event('scroll')));
  const top = () => old.evaluate((e) => Math.round(e.getBoundingClientRect().top - (e.closest('.tx-scroll') as HTMLElement).getBoundingClientRect().top));
  const before = await top();
  await tx.locator('.tx-chg-box').uncheck();
  expect(Math.abs((await top()) - before)).toBeLessThanOrEqual(2);
  await tx.locator('.tx-chg-box').check();
  expect(Math.abs((await top()) - before)).toBeLessThanOrEqual(2);
  await frames(page, 4);
  await shot(page, 'h21-codex-changes-paged');

  // Code changes off, then the game again: the restored history comes back with the choice kept.
  await tx.locator('.tx-chg-box').uncheck();
  tx = await sitAt(page);
  expect(await theme(page)).toMatchObject({ showChanges: false });
  const direct = tx.locator(`[data-id="${DIRECT}"]`);
  await direct.scrollIntoViewIfNeeded();
  await expect(direct.locator('.tx-chg-head')).toHaveCount(2);
  await expect(direct.locator('.tx-chg-body').first()).toBeHidden();
  clean();
});
