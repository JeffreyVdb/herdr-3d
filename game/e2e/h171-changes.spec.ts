import { expect, test, type Locator, type Page } from '@playwright/test';
import { frames, openGame, seatMode, shot, watchErrors } from './game';

// #171: code changes in the transcript, for real on the WebGL2 path: demo-h171 with the simulating fixture server, whose
// watches get the code-changes timeline (tools/fixture-transcript.ts `h171Timeline`: what the bridge makes of its own
// Claude fixtures, every Edit / Write / Bash shape and state, plus a Codex patch, one still running, and an Edit whose
// diff the list cut). Open it yourself: ?ws=%2Ffixture%2Fdemo-h171%3Fsim%3D1 and sit at Nibble on herdr-3d.

const FLOOR = 'herdr-3d';
const SIM = 'play=none&sim=1&simms=500&simusage=0';
const P = '/home/dev/project/';

type Theme = Awaited<ReturnType<Window['__h3d']['theme']>>;
const theme = (page: Page) => page.evaluate(() => window.__h3d.theme()) as Promise<Theme>;
const stored = (page: Page) => page.evaluate(() => localStorage.getItem('h3d.transcript.showChanges'));

async function sitAt(page: Page, name = 'Nibble'): Promise<Locator> {
  await openGame(page, 'demo-h171', '&prints=0', SIM);
  await page.evaluate((s) => window.__h3d.enterFloor(s), FLOOR);
  await frames(page, 3);
  const id = await page.evaluate((n) => window.__h3d.world().flatMap((f) => f.workers).find((w) => w.name === n)?.id ?? '', name);
  expect(await page.evaluate((i) => window.__h3d.face(i), id)).toBe(true);
  await frames(page, 3);
  expect(await page.evaluate((w) => window.__h3d.sitAt(w), id)).toBe(true);
  await expect.poll(() => page.evaluate(() => window.__h3d.seated())).toBe(id);
  await seatMode(page, 'transcript');
  const tx = page.locator('.seat-transcript .tx');
  await expect(tx).toBeVisible();
  await expect(tx.locator('[data-id="h171-cut"]')).toBeAttached();
  return tx;
}

const file = (tx: Locator, id: string, n = 0) => tx.locator(`[data-id="${id}"] .tx-chg-file`).nth(n);

test('code changes show by default, every shape and state, and the two switches stay apart', async ({ page }) => {
  test.setTimeout(150_000);
  const clean = watchErrors(page);
  const tx = await sitAt(page);
  expect(await theme(page)).toMatchObject({ showChanges: true, hideTools: false });
  expect(await stored(page)).toBeNull();
  await expect(tx.locator('.tx-chg-box')).toBeChecked();

  // An Edit: its diff under the header, line numbers from the source, the raw input still closed.
  const edit = tx.locator('[data-id="toolu_c171_bash_one"]');
  await edit.scrollIntoViewIfNeeded();
  await expect(edit.locator('.tx-tool-body')).toBeHidden();
  await expect(file(tx, 'toolu_c171_bash_one').locator('.tx-diff-body')).toBeVisible();
  await expect(edit.locator('.tx-dh')).toHaveText('@@ -12,5 +12,5 @@');
  await expect(edit.locator('.tx-chg-head .tx-diff-path')).toHaveText(`${P}src/fetch.py`);

  // What happened to each file, and what has no diff.
  await expect(tx.locator('[data-id="toolu_c171_bash_multi"] .tx-chg-op')).toHaveText(['new', 'deleted', 'new']);
  await expect(tx.locator('[data-id="toolu_c171_wr_upd1"] .tx-chg-op')).toHaveText(['overwritten']);
  await expect(tx.locator('[data-id="toolu_c171_wr_nodiff"] .tx-chg-op')).toHaveText(['overwritten', 'no diff']);
  await expect(tx.locator('[data-id="toolu_c171_wr_nodiff"] .tx-chg-body')).toContainText('No diff recorded');
  await expect(tx.locator('[data-id="toolu_c171_bash_more"] .tx-chg-more summary')).toHaveText('3 more files changed, no diff recorded');
  await expect(tx.locator('[data-id="toolu_c171_bash_unavail"] .tx-changes > .tx-chg-note')).toContainText(['Incomplete: Claude Code could not record all']);
  await expect(tx.locator('[data-id="toolu_c171_bash_shared"] .tx-changes > .tx-chg-note')).toContainText(['some of these changes may be its']);
  await expect(tx.locator('[data-id="toolu_c171_bash_skipped"] .tx-changes > .tx-chg-note')).toContainText(['No diff taken: this command moves the working tree']);
  // No record: nothing extra. Failed, denied, interrupted edits: no diff, their status.
  for (const id of ['toolu_018Aah2uHCqF4KbGuUkTSEYa', 'toolu_c171_edit_fail', 'toolu_c171_write_denied', 'toolu_c171_edit_waiting']) await expect(tx.locator(`[data-id="${id}"] .tx-changes`)).toHaveCount(0);
  await expect(tx.locator('[data-id="toolu_c171_write_denied"] .tx-tool-status')).toHaveText('denied');
  // Codex: the patch's two files (no line numbers made up), and one still running: proposed.
  const codex = tx.locator('.tx-tool[data-status="ok"]', { has: page.locator('.tx-tool-name', { hasText: 'apply_patch' }) });
  await expect(codex.locator('.tx-chg-head .tx-diff-path')).toHaveText(['package.json', 'tsconfig.json']);
  await expect(codex.locator('.tx-dh')).toHaveCount(0);
  await expect(tx.locator('[data-id="h171-proposed"] .tx-chg-state')).toHaveText('Proposed: not applied yet.');
  await tx.locator('[data-id="h171-proposed"]').scrollIntoViewIfNeeded();
  await frames(page, 4);
  await shot(page, 'h171-changes-quiet');

  // A change the list cut: the whole of it through transcript.item, in place.
  const cut = tx.locator('[data-id="h171-cut"]');
  await cut.scrollIntoViewIfNeeded();
  await expect(cut.locator('.tx-chg-op')).toHaveText(['cut']);
  await expect(cut.locator('.tx-chg-head .tx-diff-stat')).toHaveText('+100 −100');
  await cut.getByRole('button', { name: 'Show the whole change' }).click();
  await expect(cut.locator('.tx-chg-head .tx-diff-stat')).toHaveText('+1250 −1250');
  await expect(cut.locator('.tx-chg-op')).toHaveCount(0);
  const items = (await page.evaluate(() => window.__h3d.sent())).filter((c) => c.t === 'transcript.item');
  expect(items.map((c) => [(c.args as { item: string }).item, c.result?.ok])).toEqual([['h171-cut', true]]);
  // Its lines: Tab from the header to them, and the timeline's keys scroll them, not the timeline.
  const lines = cut.locator('.tx-diff-body');
  const scroller = tx.locator('.tx-scroll');
  await expect(lines).toHaveAttribute('aria-label', `Changes to ${P}src/soundings.ts`);
  await cut.locator('.tx-chg-head').focus();
  await page.keyboard.press('Tab');
  await expect(lines).toBeFocused();
  const outer = await scroller.evaluate((s) => s.scrollTop);
  await page.keyboard.press('PageDown');
  await page.keyboard.press('ArrowDown');
  await expect.poll(() => lines.evaluate((e) => e.scrollTop)).toBeGreaterThan(0);
  expect(await scroller.evaluate((s) => s.scrollTop)).toBe(outer);
  await page.keyboard.press('End');
  await expect.poll(() => lines.evaluate((e) => e.scrollTop + e.clientHeight >= e.scrollHeight - 1)).toBe(true);
  // Past 2,000 lines: the rest a page at a time, from the keyboard, in place.
  const rows = cut.locator('.tx-diff-body .tx-dl:not(.tx-dh)');
  await expect(rows).toHaveCount(2000);
  const next = cut.getByRole('button', { name: 'Show next 500 lines (500 left)' });
  await next.focus();
  await page.keyboard.press('Enter');
  await expect(rows).toHaveCount(2500);
  await expect(rows.last()).toContainText("{ id: 1250, depth: 8, tide: 'high' },");
  await expect(cut.locator('.tx-diff-more')).toHaveCount(0);
  await expect(lines).toBeFocused();
  // (A screenshot takes the page's focus: last.)
  await frames(page, 2);
  await shot(page, 'h171-changes-lines-focused');
  // At 200% on a laptop's screen, both presets: the lines are never taller than the view, and from the keyboard alone
  // their last and first lines come into it.
  const inView = (el: Locator) =>
    el.evaluate((e) => {
      const r = e.getBoundingClientRect();
      const v = (e.closest('.tx-scroll') as HTMLElement).getBoundingClientRect();
      return r.top >= v.top - 1 && r.bottom <= v.bottom + 1;
    });
  // The view's measured height (--tx-view-h, from a ResizeObserver) caught up with a resize.
  const sized = () => tx.evaluate((e) => Math.abs(parseFloat((e as HTMLElement).style.getPropertyValue('--tx-view-h')) - (e.querySelector('.tx-scroll') as HTMLElement).clientHeight) <= 1);
  for (const preset of ['quiet', 'ubuntu']) {
    await tx.locator(`.tx-theme[data-theme-id="${preset}"]`).click();
    await cut.locator('.tx-chg-head').focus();
    while ((await theme(page)).transcriptZoom !== 200) await page.keyboard.press('Control+=');
    await page.keyboard.press('Tab');
    await expect(lines).toBeFocused();
    expect(await lines.evaluate((e) => e.getBoundingClientRect().height <= (e.closest('.tx-scroll') as HTMLElement).clientHeight)).toBe(true);
    for (const k of ['End', 'PageDown', 'ArrowDown', 'End']) await page.keyboard.press(k);
    await expect.poll(() => inView(rows.last())).toBe(true);
    await expect(lines).toBeFocused();
    for (const k of ['Home', 'PageUp', 'ArrowUp', 'Home']) await page.keyboard.press(k);
    await expect.poll(() => inView(rows.first())).toBe(true);
    // A smaller screen under it (1280x720 to 1024x600) leaves the lines above the view: the keys still bring them back.
    await page.setViewportSize({ width: 1024, height: 600 });
    await expect.poll(sized).toBe(true);
    for (const k of ['End', 'PageDown', 'ArrowDown', 'End']) await page.keyboard.press(k);
    await expect.poll(() => inView(rows.last())).toBe(true);
    await expect(lines).toBeFocused();
    for (const k of ['Home', 'PageUp', 'ArrowUp', 'Home']) await page.keyboard.press(k);
    await expect.poll(() => inView(rows.first())).toBe(true);
    await page.setViewportSize({ width: 1280, height: 720 });
    await expect.poll(sized).toBe(true);
    await page.keyboard.press('Control+0');
    await expect.poll(async () => (await theme(page)).transcriptZoom).toBe(100);
  }
  await tx.locator('.tx-theme[data-theme-id="quiet"]').click();

  // Hide tools: plain tool rows go, code changes stay (bare: no header, no body); changes still open.
  await tx.locator('.tx-check-box').check();
  expect(await theme(page)).toMatchObject({ showChanges: true, hideTools: true });
  await expect(tx.locator('[data-id="toolu_018Aah2uHCqF4KbGuUkTSEYa"]')).toBeHidden();
  await expect(tx.locator('[data-id="toolu_c171_edit_fail"]')).toBeHidden();
  await edit.scrollIntoViewIfNeeded();
  await expect(edit.locator('.tx-tool-row')).toBeHidden();
  await expect(edit.locator('.tx-changes')).toBeVisible();
  await expect(file(tx, 'toolu_c171_bash_one').locator('.tx-diff-body')).toBeVisible();
  await frames(page, 4);
  await shot(page, 'h171-changes-hidden-tools');

  // Code changes off too: one line per file, each still opens; stored as '0'.
  await tx.locator('.tx-chg-box').uncheck();
  expect(await theme(page)).toMatchObject({ showChanges: false, hideTools: true });
  expect(await stored(page)).toBe('0');
  await expect(file(tx, 'toolu_c171_bash_one').locator('.tx-chg-head')).toBeVisible();
  await expect(file(tx, 'toolu_c171_bash_one').locator('.tx-chg-body')).toBeHidden();
  await file(tx, 'toolu_c171_bash_one').locator('.tx-chg-head').click();
  await expect(file(tx, 'toolu_c171_bash_one').locator('.tx-diff-body')).toBeVisible();
  await expect(file(tx, 'toolu_c171_bash_multi').locator('.tx-chg-body')).toBeHidden();
  await frames(page, 4);
  await shot(page, 'h171-changes-off');
  // Hide tools off: the switches are apart (changes stay off).
  await tx.locator('.tx-check-box').uncheck();
  expect(await theme(page)).toMatchObject({ showChanges: false, hideTools: false });
  await expect(tx.locator('[data-id="toolu_018Aah2uHCqF4KbGuUkTSEYa"]')).toBeVisible();
  await expect(file(tx, 'toolu_c171_bash_multi').locator('.tx-chg-body')).toBeHidden();

  // To the terminal and back: the same changes, no duplicates.
  const heads = await tx.locator('.tx-chg-head').allTextContents();
  await seatMode(page, 'terminal');
  await seatMode(page, 'transcript');
  await expect(tx.locator('.tx-chg-head')).toHaveText(heads);

  // Ubuntu, changes on again: the same history, open.
  await tx.locator('.tx-chg-box').check();
  expect(await stored(page)).toBeNull();
  await expect(file(tx, 'toolu_c171_bash_multi').locator('.tx-chg-body')).toBeVisible();
  await tx.locator('.tx-theme[data-theme-id="ubuntu"]').click();
  await tx.locator('[data-id="toolu_c171_bash_multi"]').scrollIntoViewIfNeeded();
  await frames(page, 4);
  await shot(page, 'h171-changes-ubuntu');
  clean();
});

test('turning code changes off and on keeps the row you read in place', async ({ page }) => {
  test.setTimeout(120_000);
  const tx = await sitAt(page);
  const scroller = tx.locator('.tx-scroll');
  const row = tx.locator('[data-id="toolu_c171_bash_skipped"]');
  // Read from the middle: the skipped Bash at the top of the view (not following the bottom).
  await row.evaluate((e) => e.scrollIntoView({ block: 'start' }));
  await scroller.evaluate((s) => s.dispatchEvent(new Event('scroll')));
  const top = () => row.evaluate((e) => Math.round(e.getBoundingClientRect().top - (e.closest('.tx-scroll') as HTMLElement).getBoundingClientRect().top));
  const before = await top();
  await tx.locator('.tx-chg-box').uncheck();
  expect(Math.abs((await top()) - before)).toBeLessThanOrEqual(2);
  await tx.locator('.tx-chg-box').check();
  expect(Math.abs((await top()) - before)).toBeLessThanOrEqual(2);
});
