import { expect, test, type Page } from '@playwright/test';
import { frames, openGame, shot, watchErrors, openMenu } from './game';

// #118 on demo-m118 (demo-m6 with the overview's lines: issue titles, digests): the lab floor on top of Work holds
// two write-code runs (Sprout over Clementine, Fig and Pretzel; Juniper over eight freelancers) and Turnip, a one-off
// worker. The lounge wall's screen shows the floor; E at it, O anywhere on the floor or the top bar's Overview opens
// the page over the whole viewport.

const SIM = 'play=none&sim=1&simms=150';

const info = (page: Page) => page.evaluate(() => window.__h3d.overview());
const page_ = async (page: Page) => (await info(page))?.page;

/** In the lounge, a few metres off the west wall, looking at the overview screen. */
async function faceScreen(page: Page, x = 2.6, pitch = 0.45): Promise<void> {
  await page.evaluate(
    ([x, pitch]) => {
      const L = window.__h3d.layout('lab');
      const b = L?.props.find((p) => p.id === 'screen.overview')?.box;
      if (!b) throw new Error('no overview screen');
      window.__h3d.setPose({ x, z: (b.min[2] + b.max[2]) / 2, yaw: Math.PI / 2, pitch });
    },
    [x, pitch] as const,
  );
  await frames(page, 4);
}

async function onToy(page: Page, wsQuery = 'play=none'): Promise<void> {
  await openGame(page, 'demo-m118', '', wsQuery);
  await page.evaluate(() => window.__h3d.enterFloor('lab'));
  await frames(page, 3);
}

test('the lounge wall shows the floor: lit, every row, and E at it grows the page out of it to fill the viewport', async ({ page }) => {
  test.setTimeout(150_000);
  const clean = watchErrors(page);
  await onToy(page);
  await expect.poll(async () => (await info(page))?.wall).toMatchObject({ lit: true, rows: 13 });
  // The wall from across the lounge (make shot-style).
  await faceScreen(page, 7.5, 0.3);
  await shot(page, 'm118-wall');
  await faceScreen(page);
  expect(await page.evaluate(() => window.__h3d.lookAt())).toMatchObject({ kind: 'prop', id: 'screen.overview' });
  const bar = page.locator('.prompt');
  await expect(bar).toContainText('Floor overview');
  await expect(bar).not.toContainText('Placeholder');
  await expect(bar.locator('kbd')).toHaveText(['E']);

  await page.keyboard.press('KeyE');
  await expect.poll(async () => (await page_(page))?.open).toBe(true);
  const p = await page_(page);
  // It grew out of the screen's rectangle on the view.
  expect(p?.from).not.toBeNull();
  expect(p?.floor).toBe('lab');
  const ov = page.locator('.ov');
  await expect(ov).toBeVisible();
  await frames(page, 2);
  await page.waitForTimeout(600); // the grow
  const box = await ov.boundingBox();
  const vp = page.viewportSize();
  expect(box).toEqual({ x: 0, y: 0, width: vp?.width, height: vp?.height });
  // Over the top bar, the game behind it inert, the corner's plate and inbox chip out of the way, App.dialogOpen.
  expect(await page.evaluate(() => (document.querySelector('.hud') as HTMLElement | null)?.inert)).toBe(true);
  expect(await page.evaluate(() => document.elementFromPoint(window.innerWidth / 2, 30)?.closest('.ov') !== null)).toBe(true);
  expect(await page.evaluate(() => document.pointerLockElement)).toBeNull();
  await expect(page.locator('.ov-floor')).toHaveText('lab');
  await expect(page.locator('.ov-count--working')).toContainText('working');
  await shot(page, 'm118-page');

  // Esc shrinks it back into the wall.
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await page_(page))?.open).toBe(false);
  await expect(ov).toBeHidden();
  expect(await page.evaluate(() => (document.querySelector('.hud') as HTMLElement | null)?.inert)).toBe(false);
  clean();
});

test('O opens it from a desk, the top bar has Overview, and in the city or the lobby O says where to go', async ({ page }) => {
  test.setTimeout(120_000);
  const clean = watchErrors(page);
  await openGame(page, 'demo-m118');
  // The city.
  await page.keyboard.press('KeyO');
  await expect(page.locator('.toast')).toHaveText('Walk onto an office floor to see its overview.');
  await expect(page.locator('.topbar .btn--overview')).toBeHidden();
  // The lobby.
  await page.evaluate(() => window.__h3d.enterLobby());
  await frames(page, 3);
  await page.locator('.toast').evaluate((e) => ((e as HTMLElement).hidden = true));
  await page.keyboard.press('KeyO');
  await expect(page.locator('.toast')).toHaveText('Walk onto an office floor to see its overview.');
  expect((await page_(page))?.open).toBe(false);
  // A desk of the lab floor, far from the lounge: O, from the centre.
  await page.evaluate(() => window.__h3d.enterFloor('lab'));
  await frames(page, 3);
  await page.evaluate(() => {
    const s = window.__h3d.layout('lab')?.slots[9];
    if (s) window.__h3d.setPose({ x: s.seat.x, z: s.seat.z + 1.2, yaw: 0 });
  });
  await frames(page, 2);
  await page.keyboard.press('KeyO');
  await expect.poll(async () => (await page_(page))?.open).toBe(true);
  expect((await page_(page))?.from).toBeNull();
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await page_(page))?.open).toBe(false);
  // The menu's row, with its key cap.
  await expect(page.locator('.hint')).toContainText('O overview');
  await openMenu(page);
  const btn = page.getByRole('button', { name: 'Overview' });
  await expect(btn).toBeVisible();
  await expect(btn.locator('.topbar-key')).toHaveAttribute('data-key', 'O');
  await expect(btn).toHaveAttribute('aria-keyshortcuts', 'O');
  await btn.click();
  await expect.poll(async () => (await page_(page))?.open).toBe(true);
  clean();
});

test('an orchestrator and its freelancers render as a tree that collapses, by key and by click, and is remembered', async ({ page }) => {
  test.setTimeout(120_000);
  const clean = watchErrors(page);
  await onToy(page);
  await page.keyboard.press('KeyO');
  await expect.poll(async () => (await page_(page))?.open).toBe(true);
  const keys = async () => ((await page_(page))?.rows ?? []).map((r) => r.key);
  const all = await page_(page);
  const sprout = all?.rows.find((r) => r.text.startsWith('Sprout'));
  expect(sprout).toMatchObject({ depth: 0, expanded: true });
  // Sprout's crew under it: code, review, ux of round 3; Juniper's eight; Turnip last.
  const at = (all?.rows ?? []).findIndex((r) => r.key === sprout?.key);
  expect((all?.rows ?? []).slice(at, at + 4).map((r) => [r.depth, r.text.split(' ')[0]])).toEqual([
    [0, expect.stringMatching(/^Sprout/)],
    [1, expect.stringMatching(/^Clementine/)],
    [1, expect.stringMatching(/^Fig/)],
    [1, expect.stringMatching(/^Pretzel/)],
  ]);
  expect(all?.rows.at(-1)?.text).toMatch(/^Turnip/);
  // The ticket with its title, on the orchestrator only (the crew shares it).
  await expect(page.locator(`.ov-row[data-key="${sprout?.key}"] .ov-ticket`)).toHaveText(/#3\s*Port picker in the settings dialog/);
  await expect(page.locator('.ov-row--child .ov-ticket')).toHaveCount(0);
  await expect(page.locator('.ov-row', { hasText: 'Turnip' }).locator('.ov-task')).toContainText('Tidy the README');
  const n = (await keys()).length;
  // ← on Sprout (focused first) folds it; → opens it again.
  expect((await page_(page))?.focused).toBe(sprout?.key);
  await page.keyboard.press('ArrowLeft');
  await expect.poll(async () => (await keys()).length).toBe(n - 3);
  expect((await page_(page))?.rows[0]).toMatchObject({ key: sprout?.key, expanded: false });
  await page.keyboard.press('ArrowRight');
  await expect.poll(async () => (await keys()).length).toBe(n);
  // ↓ / j walk the rows.
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('j');
  expect((await page_(page))?.focused).toBe((await keys())[2]);
  // Shift+← collapses all, Shift+→ expands all; the chevron folds one.
  await page.keyboard.press('Shift+ArrowLeft');
  await expect.poll(async () => (await keys()).length).toBe(3);
  await page.keyboard.press('Shift+ArrowRight');
  await expect.poll(async () => (await keys()).length).toBe(n);
  await page.locator(`.ov-row[data-key="${sprout?.key}"] .ov-fold`).click();
  await expect.poll(async () => (await keys()).length).toBe(n - 3);
  // Remembered per orchestrator, in this browser.
  expect(await page.evaluate(() => localStorage.getItem('h3d.overview.collapsed'))).toBe(JSON.stringify([sprout?.key]));
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await page_(page))?.open).toBe(false);
  await page.keyboard.press('KeyO');
  await expect.poll(async () => (await keys()).length).toBe(n - 3);
  await shot(page, 'm118-collapsed');
  clean();
});

test('a row’s click ends seated at that laptop with its conversation on screen; a ticket opens the issue window over the page', async ({ page }) => {
  test.setTimeout(150_000);
  const clean = watchErrors(page);
  await onToy(page, SIM);
  await page.keyboard.press('KeyO');
  await expect.poll(async () => (await page_(page))?.open).toBe(true);
  // The ticket: the issue window on top of the page; Esc there closes it, not the page.
  const sprout = page.locator('.ov-row', { hasText: 'Sprout' }).first();
  await sprout.locator('.ov-ticket').click();
  await expect(page.locator('dialog.desk-dlg--item[open]')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('dialog.desk-dlg--item[open]')).toBeHidden();
  await page.keyboard.press('Escape'); // the board list it opened from
  await expect.poll(() => page.evaluate(() => !!document.querySelector('dialog:modal'))).toBe(false);
  expect((await page_(page))?.open).toBe(true);
  // A worker row: the go-to closes the page and sits you at the laptop, the conversation on screen.
  const turnip = (await page_(page))?.rows.find((r) => r.text.startsWith('Turnip'))?.key ?? null;
  expect(turnip).not.toBeNull();
  await page.locator('.ov-row', { hasText: 'Turnip' }).click();
  await expect.poll(async () => (await page_(page))?.open).toBe(false);
  await expect.poll(() => page.evaluate(() => window.__h3d.seated()), { timeout: 20_000 }).toBe(turnip);
  await expect.poll(() => page.evaluate(() => window.__h3d.seat().mode)).toBe('transcript');
  // O from the conversation brings the page back over it, still seated; Esc closes it back onto the conversation.
  await page.keyboard.press('KeyO');
  await expect.poll(async () => (await page_(page))?.open).toBe(true);
  expect((await page_(page))?.floor).toBe('lab');
  expect(await page.evaluate(() => window.__h3d.seated())).toBe(turnip);
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await page_(page))?.open).toBe(false);
  expect(await page.evaluate(() => window.__h3d.seated())).toBe(turnip);
  await expect.poll(() => page.evaluate(() => window.__h3d.seat().mode)).toBe('transcript');
  // The prompt box keeps its letters: an o typed there is text, not the overview.
  await page.locator('.tx-input').first().focus();
  await page.keyboard.type('go on');
  await frames(page, 2);
  expect((await page_(page))?.open).toBe(false);
  expect(await page.locator('.tx-input').first().evaluate((e) => (e as HTMLTextAreaElement).value ?? e.textContent)).toContain('go on');
  clean();
});

test('reduced motion: no blink, cascade or flap; steady lights on the page', async ({ page }) => {
  test.setTimeout(90_000);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await onToy(page);
  await page.keyboard.press('KeyO');
  await expect.poll(async () => (await page_(page))?.calm).toBe(true);
  const anim = await page.locator('.ov-row[data-display="working"] .ov-light').first().evaluate((e) => getComputedStyle(e).animationName);
  expect(anim).toBe('none');
  expect((await info(page))?.wall?.blinking).toBe(false);
});
