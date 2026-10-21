import { expect, test, type Page } from '@playwright/test';
import { frames, leftInTerminal, openGame, shot, watchErrors } from './game';

// #175: nothing enlarges a split pane's text by itself: at 100% the cells are the preset's size; only the user's zoom
// grows them. `simscreen=narrow` puts a recorded 60×40 shell on every laptop (tools/fixture-screen.ts).
// #176: the seated terminal is the workspace's xterm. When the seat owns the pane, the pane's PTY takes the grid the
// window fits at that font size (the narrow pane reflows wide, the text never grows); watched read only (another
// client owns it, `simcontrol=busy`) it shows the pane at its own 60×40, at 100%, never stretched. Standing up, the
// monitor's glance view shows it again.

const FLOOR = 'herdr-3d';
const SIM = (screen: string, control = '') => `play=none&sim=1&simms=500&simusage=0&simlimits=ok${screen ? `&simscreen=${screen}` : ''}${control ? `&simcontrol=${control}` : ''}`;

async function sitAt(page: Page, screen: string, control = '', name = 'Tofu'): Promise<string> {
  await page.addInitScript(() => localStorage.setItem('h3d.monitors', 'terminal'));
  await openGame(page, 'demo-m5', '&prints=0', SIM(screen, control));
  await page.evaluate((s) => window.__h3d.enterFloor(s), FLOOR);
  await frames(page, 3);
  const id = await page.evaluate((n) => window.__h3d.world().flatMap((f) => f.workers).find((w) => w.name === n)?.id ?? '', name);
  await leftInTerminal(page, id);
  expect(await page.evaluate((i) => window.__h3d.face(i), id)).toBe(true);
  await frames(page, 3);
  expect(await page.evaluate((w) => window.__h3d.sitAt(w), id)).toBe(true);
  await expect.poll(() => page.evaluate(() => window.__h3d.seated())).toBe(id);
  await expect.poll(() => page.evaluate(() => window.__h3d.seatTerminal()?.opened ?? false)).toBe(true);
  await frames(page, 4);
  return id;
}

const term = (page: Page) => page.evaluate(() => window.__h3d.seatTerminal());
const level = (page: Page) => page.locator('.seat-zoom-level');

test('a 60×40 pane the seat owns: the PTY gets the window’s grid at 100%; A+ / A− and Ctrl+0 change the cells, not the window', async ({ page }) => {
  test.setTimeout(180_000);
  const clean = watchErrors(page);
  await page.setViewportSize({ width: 1280, height: 720 });
  const id = await sitAt(page, 'narrow');
  await expect.poll(async () => (await term(page))?.control?.mode).toBe('control');
  await expect(level(page)).toHaveText('100%');
  const base = (await term(page))!;
  // The narrow pane reflows into the window's columns; its text keeps the preset's size.
  expect(base.grid!.cols).toBeGreaterThan(60);
  await expect.poll(async () => (await term(page))?.cols).toBe(base.grid!.cols);
  await page.locator('.seat-input').focus();
  await page.keyboard.press('ArrowRight');
  await expect.poll(async () => (await term(page))?.lines.join('\n') ?? '').toMatch(/row 40/);
  await shot(page, 'h175-narrow-100');

  const larger = page.getByRole('button', { name: 'Larger terminal text' });
  for (let i = 0; i < 5; i++) await larger.click();
  await expect(level(page)).toHaveText('150%');
  await expect.poll(async () => (await term(page))?.font?.px).toBeGreaterThan(base.font!.px);
  await expect.poll(async () => (await term(page))?.grid?.cols).toBeLessThan(base.grid!.cols);
  await frames(page, 8);
  await shot(page, 'h175-narrow-150');
  await page.locator('.seat-input').focus();
  await page.keyboard.press('Control+0');
  await expect(level(page)).toHaveText('100%');
  await expect.poll(async () => (await term(page))?.font?.px).toBe(base.font!.px);
  await expect.poll(async () => (await term(page))?.grid?.cols).toBe(base.grid!.cols);

  // A smaller window: fewer columns, the same cells.
  await page.setViewportSize({ width: 900, height: 760 });
  await expect.poll(async () => (await term(page))?.grid?.cols).toBeLessThan(base.grid!.cols);
  expect((await term(page))!.font!.px).toBe(base.font!.px);
  await frames(page, 6);
  await shot(page, 'h175-narrow-resized');
  await page.setViewportSize({ width: 1280, height: 720 });

  await page.locator('.seat').getByRole('button', { name: /Stand up/ }).click();
  await expect.poll(() => page.evaluate(() => window.__h3d.seated())).toBeNull();
  await expect.poll(() => page.evaluate((i) => window.__h3d.screenMesh(i)?.glance, id)).toBe(true);
  await frames(page, 12);
  await shot(page, 'h175-narrow-standing');
  clean();
});

test('a 60×40 pane watched read only shows at its own size, at 100%: nothing enlarges it', async ({ page }) => {
  test.setTimeout(120_000);
  const clean = watchErrors(page);
  await page.setViewportSize({ width: 1280, height: 720 });
  await sitAt(page, 'narrow', 'busy');
  await expect.poll(async () => (await term(page))?.control?.mode).toBe('observe');
  await expect.poll(async () => (await term(page))?.cols).toBe(60);
  expect((await term(page))?.rows).toBe(40);
  await expect(level(page)).toHaveText('100%');
  // The widget is the pane's own 60 columns wide, at the preset's cell size (not stretched to the window).
  const width = await page.locator('.seat-term .xterm-screen').evaluate((e) => e.getBoundingClientRect().width);
  const px = (await term(page))!.font!.px;
  expect(width).toBeLessThan(60 * px); // a monospace cell is narrower than its font size
  expect(width).toBeGreaterThan(60 * px * 0.4);
  await shot(page, 'h175-narrow-readonly');
  clean();
});

test('a 120-column pane the seat owns takes the window’s grid at 100%', async ({ page }) => {
  test.setTimeout(120_000);
  const clean = watchErrors(page);
  await page.setViewportSize({ width: 1280, height: 720 });
  await sitAt(page, '');
  await expect.poll(async () => (await term(page))?.control?.mode).toBe('control');
  await expect(level(page)).toHaveText('100%');
  const t = (await term(page))!;
  await expect.poll(async () => (await term(page))?.cols).toBe(t.grid!.cols);
  expect(t.grid!.rows).toBeGreaterThan(30);
  await shot(page, 'h175-wide-100');
  clean();
});
