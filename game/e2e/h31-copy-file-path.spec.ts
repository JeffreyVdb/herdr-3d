import { expect, test, type Page } from '@playwright/test';
import { frames, openGame, seatMode, shot, watchErrors } from './game';

// #31: a file reference in the transcript (`[label](/path)`) keeps its friendly label; activating it (Enter / Space,
// or a click) opens a popover with the full path and "Copy file path", which puts exactly the path on the clipboard.
// demo-m5 against the fixture bridge (`sim=1`): `sim.final` (tools/fixture-handoff.ts) plays Zippy's agent ending its
// turn with the message under test; Zippy's checkout is /home/dev/devel/herdr-3d, for the relative reference.

const SIM = 'play=none&sim=1&simms=150&simusage=0';
const REPRO = '/tmp/herdr-remote-runtime-handoff-2026-10-09.md';
const MESSAGE = `Saved the [handoff document](${REPRO}) in \`/tmp\`. The plan is in [the plan](./docs/plan%20v2.md), and [the site](https://example.com/) has the rest.`;

async function sitAtZippy(page: Page): Promise<void> {
  await openGame(page, 'demo-m5', '&prints=0', SIM);
  await page.evaluate(() => window.__h3d.enterFloor('herdr-3d'));
  await frames(page, 3);
  const id = await page.evaluate(() => window.__h3d.world().flatMap((f) => f.workers).find((w) => w.name === 'Zippy')?.id ?? '');
  expect(await page.evaluate((i) => window.__h3d.face(i), id)).toBe(true);
  await frames(page, 3);
  expect(await page.evaluate((i) => window.__h3d.sitAt(i), id)).toBe(true);
  await frames(page, 20);
  await seatMode(page, 'transcript');
  await expect(page.locator('.seat-transcript .tx .tx-scroll')).toBeFocused();
  const r = await page.evaluate((a) => window.__h3d.simHandoff('sim.final', a), { id, text: MESSAGE });
  expect(r.ok).toBe(true);
}

const clipboard = (page: Page) => page.evaluate(() => navigator.clipboard.readText());

test('a file reference opens by keyboard, copies its exact path, and gives the keyboard back on Esc', async ({ page, context }) => {
  const clean = watchErrors(page);
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await sitAtZippy(page);
  const tx = page.locator('.seat-transcript .tx');
  const ref = tx.getByRole('button', { name: 'handoff document', exact: true });
  await expect(ref).toHaveCount(1);
  // The friendly label is what shows; the path is not in the text, and the reference is no navigable link.
  await expect(ref).toHaveText('handoff document');
  await expect(ref).not.toHaveAttribute('href');
  await expect(ref).toHaveAttribute('aria-expanded', 'false');
  await expect(tx.locator('.tx-md', { hasText: 'Saved the' })).not.toContainText(REPRO);
  // The web link is unchanged.
  const web = tx.locator('a[href="https://example.com/"]');
  await expect(web).toHaveAttribute('target', '_blank');
  await expect(web).toHaveAttribute('rel', 'noopener noreferrer');
  await page.evaluate(() => navigator.clipboard.writeText('before'));

  // Both references are in the tab order: from the second, Shift+Tab reaches the first.
  await ref.scrollIntoViewIfNeeded();
  await tx.getByRole('button', { name: 'the plan', exact: true }).focus();
  await page.keyboard.press('Shift+Tab');
  await expect(ref).toBeFocused();
  await page.keyboard.press('Enter');
  const dlg = tx.getByRole('dialog', { name: 'File path' });
  await expect(dlg).toBeVisible();
  await expect(ref).toHaveAttribute('aria-expanded', 'true');
  await expect(dlg.locator('.tx-fref-path')).toHaveText(REPRO);
  const copy = dlg.getByRole('button', { name: 'Copy file path' });
  await expect(copy).toBeFocused();

  // Inside the screen: nothing clips it.
  const [p, s] = await Promise.all([dlg.boundingBox(), tx.boundingBox()]);
  expect(p && s).toBeTruthy();
  expect(p!.x).toBeGreaterThanOrEqual(s!.x - 0.5);
  expect(p!.y).toBeGreaterThanOrEqual(s!.y - 0.5);
  expect(p!.x + p!.width).toBeLessThanOrEqual(s!.x + s!.width + 0.5);
  expect(p!.y + p!.height).toBeLessThanOrEqual(s!.y + s!.height + 0.5);
  // The top-most thing at its centre is the popover itself.
  expect(await dlg.evaluate((d) => {
    const b = d.getBoundingClientRect();
    return d.contains(document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2));
  })).toBe(true);
  await shot(page, 'h31-popover');
  // The shot hides the HUD for a moment, which blurs what had the keyboard: back on Copy.
  await copy.focus();

  await page.keyboard.press('Enter');
  await expect(dlg.getByRole('button', { name: 'Copied' })).toBeVisible();
  await expect(dlg.getByRole('status')).toHaveText('File path copied to the clipboard.');
  expect(await clipboard(page)).toBe(REPRO);

  // Esc closes it, the keyboard is back on the reference, and you are still seated.
  await page.keyboard.press('Escape');
  await expect(dlg).toBeHidden();
  await expect(ref).toBeFocused();
  await expect(ref).toHaveAttribute('aria-expanded', 'false');
  expect(await page.evaluate(() => window.__h3d.seat().mode)).toBe('transcript');
  await expect(page.locator('.seat')).toBeVisible();

  // Space opens it as well; a click outside closes it.
  await page.keyboard.press(' ');
  await expect(dlg).toBeVisible();
  await tx.locator('.tx-bar .tx-title').click();
  await expect(dlg).toBeHidden();

  // A relative reference: a click, the path in Zippy's checkout, copied by pointer.
  const plan = tx.getByRole('button', { name: 'the plan', exact: true });
  await plan.click();
  await expect(dlg.locator('.tx-fref-path')).toHaveText('/home/dev/devel/herdr-3d/docs/plan v2.md');
  await expect(dlg.locator('.tx-fref-note')).toHaveText('Written as ./docs/plan v2.md, in the worker’s checkout.');
  await dlg.getByRole('button', { name: 'Copy file path' }).click();
  await expect.poll(() => clipboard(page)).toBe('/home/dev/devel/herdr-3d/docs/plan v2.md');
  await page.keyboard.press('Escape');
  await expect(plan).toBeFocused();
  clean();
});

test('a refused clipboard says so and leaves the path selected for the copy key', async ({ page, context }) => {
  const clean = watchErrors(page);
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await sitAtZippy(page);
  const tx = page.locator('.seat-transcript .tx');
  // The browser refuses the write (as it does without permission or outside a secure context).
  await page.evaluate(() => {
    const real = navigator.clipboard.writeText.bind(navigator.clipboard);
    (window as unknown as { __realWrite: typeof real }).__realWrite = real;
    navigator.clipboard.writeText = () => Promise.reject(new DOMException('Write permission denied.', 'NotAllowedError'));
  });
  const ref = tx.getByRole('button', { name: 'handoff document', exact: true });
  await ref.scrollIntoViewIfNeeded();
  await ref.focus();
  await page.keyboard.press('Enter');
  const dlg = tx.getByRole('dialog', { name: 'File path' });
  await page.keyboard.press('Enter');
  const status = dlg.getByRole('status');
  await expect(status).toBeVisible();
  await expect(status).toContainText('Couldn’t copy');
  await expect(status).toContainText(/press (Ctrl\+C|⌘C) to copy it/);
  await expect(dlg.locator('.tx-fref-path')).toBeFocused();
  expect(await page.evaluate(() => document.getSelection()?.toString())).toBe(REPRO);
  await shot(page, 'h31-copy-refused');
  // The shot hides the HUD for a moment, which blurs what had the keyboard: back on the path (selected again).
  await dlg.locator('.tx-fref-path').focus();
  // The copy key copies the selection (the browser's own copy, not the refused API).
  await page.evaluate(() => (window as unknown as { __realWrite: (t: string) => Promise<void> }).__realWrite('before'));
  expect(await clipboard(page)).toBe('before');
  await page.keyboard.press('ControlOrMeta+c');
  await expect.poll(() => clipboard(page)).toBe(REPRO);
  await page.keyboard.press('Escape');
  await expect(ref).toBeFocused();
  clean();
});

test('on a phone-sized screen the popover wraps the path and stays inside the transcript', async ({ page }) => {
  const clean = watchErrors(page);
  await page.setViewportSize({ width: 390, height: 740 });
  await sitAtZippy(page);
  const tx = page.locator('.seat-transcript .tx');
  const ref = tx.getByRole('button', { name: 'handoff document', exact: true });
  await ref.scrollIntoViewIfNeeded();
  await ref.click();
  const dlg = tx.getByRole('dialog', { name: 'File path' });
  await expect(dlg).toBeVisible();
  const path = dlg.locator('.tx-fref-path');
  await expect(path).toHaveText(REPRO);
  const [p, s] = await Promise.all([dlg.boundingBox(), tx.boundingBox()]);
  expect(p!.x).toBeGreaterThanOrEqual(s!.x - 0.5);
  expect(p!.x + p!.width).toBeLessThanOrEqual(s!.x + s!.width + 0.5);
  expect(p!.y).toBeGreaterThanOrEqual(s!.y - 0.5);
  expect(p!.y + p!.height).toBeLessThanOrEqual(s!.y + s!.height + 0.5);
  // The whole path shows, wrapped (no horizontal scroll inside it).
  expect(await path.evaluate((e) => e.scrollWidth <= e.clientWidth + 1)).toBe(true);
  await shot(page, 'h31-popover-narrow');
  clean();
});
