import { expect, test, type Page } from '@playwright/test';
import { frames, leftInTerminal, openGame, RESULTS, watchErrors } from './game';
import { resolve } from 'node:path';

// #147: the command palette (⌘/Ctrl+P) from every view, against the fixture bridge with the simulator (sim=1). `demo` has
// two buildings: Work (herdr-3d: three blocked, nine working; depot-manager: asleep) and Personal (pastry: one blocked).
// Playwright cannot see the browser's print dialog, so each view asserts the chord's keydown was `defaultPrevented`: a page
// that cancels it never prints. The events are recorded by a capture listener that runs before the game's, and read later.

const SIM = 'play=none&sim=1&simms=150';
const FLOOR = 'herdr-3d';

type Recorded = Window & { __chord: KeyboardEvent[] };

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as Recorded;
    w.__chord = [];
    window.addEventListener(
      'keydown',
      (e) => {
        if (e.code === 'KeyP' && (e.ctrlKey || e.metaKey)) w.__chord.push(e);
      },
      true,
    );
    localStorage.setItem('h3d.monitors', 'terminal');
  });
});

/** Presses the chord and says whether the page cancelled it (so the browser would not print). */
async function chord(page: Page, key = 'Control+KeyP'): Promise<boolean | null> {
  const before = await page.evaluate(() => (window as unknown as Recorded).__chord.length);
  await page.keyboard.press(key);
  return page.evaluate((n) => (window as unknown as Recorded).__chord[n]?.defaultPrevented ?? null, before);
}

const palette = (page: Page) => page.locator('dialog.palette');
const input = (page: Page) => palette(page).locator('.pal-input');
const rows = (page: Page) => palette(page).locator('.pal-opt .pal-name');
const view = (page: Page) => page.evaluate(() => window.__h3d.view());
const dialog = (page: Page) => page.evaluate(() => window.__h3d.dialog());

async function expectOpen(page: Page): Promise<void> {
  await expect(palette(page)).toBeVisible();
  await expect(input(page)).toBeFocused();
}

async function expectClosed(page: Page): Promise<void> {
  await expect(palette(page)).toBeHidden();
}

test('city: the chord opens it without a print dialog, again or Esc closes it', async ({ page }) => {
  const clean = watchErrors(page);
  await openGame(page, 'demo', '', SIM);
  expect((await view(page)).mode).toBe('city');
  expect(await chord(page)).toBe(true);
  await expectOpen(page);
  // The commands, Hire first; no floor-only row off a floor (no Elevator, no Floor plan).
  await expect(rows(page).first()).toHaveText('Hire');
  await expect(palette(page).locator('.pal-opt[aria-selected="true"]')).toHaveCount(1);
  expect(await rows(page).allTextContents()).not.toContain('Elevator');
  // The hint under the empty list: two floors need you.
  await expect(palette(page).locator('.pal-hint')).toHaveText('2 floors need you · type @');
  await page.screenshot({ path: resolve(RESULTS, 'palette-commands.png') });
  // The chord again closes it (and is cancelled too).
  expect(await chord(page)).toBe(true);
  await expectClosed(page);
  await chord(page);
  await expectOpen(page);
  await page.keyboard.press('Escape');
  await expectClosed(page);
  // Esc closed the palette only: the city is as it was.
  expect((await view(page)).mode).toBe('city');
  expect(await dialog(page)).toBeNull();
  clean();
});

test('city: ⌘P on a Mac', async ({ page }) => {
  await page.addInitScript(() => {
    // The game asks `navigator.userAgentData.platform` first, then `navigator.platform`.
    Object.defineProperty(navigator, 'userAgentData', { value: { platform: 'macOS' }, configurable: true });
    Object.defineProperty(navigator, 'platform', { value: 'MacIntel', configurable: true });
  });
  await openGame(page, 'demo', '', SIM);
  // Ctrl+P is not the chord there.
  await page.keyboard.press('Control+KeyP');
  await expectClosed(page);
  expect(await chord(page, 'Meta+KeyP')).toBe(true);
  await expectOpen(page);
});

test('city: Hire asks which floor, and the pick opens Hire there', async ({ page }) => {
  const clean = watchErrors(page);
  await openGame(page, 'demo', '', SIM);
  await chord(page);
  await expectOpen(page);
  await page.keyboard.type('hire');
  await expect(rows(page).first()).toHaveText('Hire');
  await page.keyboard.press('Enter');
  // The floor list under the command's question; nothing has been opened yet.
  await expect(palette(page).locator('.pal-title')).toHaveText('Hire on which floor?');
  await expect(input(page)).toHaveValue('@');
  await expect(rows(page)).toHaveText(['Personal › pastry', 'Work › herdr-3d', 'Work › depot-manager']);
  expect(await dialog(page)).toBeNull();
  expect((await view(page)).mode).toBe('city');
  await page.keyboard.type('herdr');
  await expect(rows(page)).toHaveText(['Work › herdr-3d']);
  await page.keyboard.press('Enter');
  await expectClosed(page);
  await expect.poll(async () => (await view(page)).floor, { timeout: 30_000 }).toBe(FLOOR);
  await expect.poll(() => page.evaluate(() => window.__h3d.dialog()?.kind), { timeout: 30_000 }).toBe('hire');
  clean();
});

test('a floor: on it Hire runs at once; @ lists every floor, needs-you first, with counts; Enter jumps to another building', async ({ page }) => {
  const clean = watchErrors(page);
  await openGame(page, 'demo', '', SIM);
  await page.evaluate((s) => window.__h3d.enterFloor(s), FLOOR);
  await frames(page, 3);
  expect(await chord(page)).toBe(true);
  await expectOpen(page);
  // On a floor the floor's own rows are there, and no "pick a floor".
  expect(await rows(page).allTextContents()).toEqual(expect.arrayContaining(['Hire', 'Elevator', 'Floor plan', 'Back to the city']));
  await expect(palette(page).locator('.pal-asks')).toHaveCount(0);
  await page.keyboard.type('@');
  await expect(rows(page)).toHaveText(['Personal › pastry', 'Work › herdr-3d', 'Work › depot-manager']);
  const chips = (i: number) => palette(page).locator('.pal-opt').nth(i).locator('.pal-chip').allTextContents();
  expect(await chips(0)).toEqual(['1 need you', '6 working', '5 idle', '2 done']);
  expect((await chips(1))[0]).toBe('3 need you');
  await page.screenshot({ path: resolve(RESULTS, 'palette-floors.png') });
  // The floor you are on says so; the asleep one says that and its worker count, with no pills.
  await expect(palette(page).locator('.pal-opt').nth(1)).toContainText('You are here');
  await expect(palette(page).locator('.pal-opt').nth(2)).toContainText('Asleep');
  expect(await chips(2)).toEqual([]);
  // A query only filters.
  await page.keyboard.type('r');
  await expect(rows(page)).toHaveText(['Personal › pastry', 'Work › herdr-3d', 'Work › depot-manager']);
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Enter'); // the first row: pastry, in the Personal building
  await expectClosed(page);
  await expect.poll(async () => (await view(page)).floor, { timeout: 30_000 }).toBe('pastry');
  await expect.poll(async () => (await view(page)).busy).toBe(false);
  expect((await view(page)).building).toBe('Personal');
  expect((await view(page)).mode).toBe('floor');
  // Enter on the floor you are on only closes the palette.
  await chord(page);
  await page.keyboard.type('@pastry');
  await expect(palette(page).locator('.pal-opt').first()).toContainText('You are here');
  await page.keyboard.press('Enter');
  await expectClosed(page);
  expect((await view(page)).busy).toBe(false);
  expect((await view(page)).floor).toBe('pastry');
  // And Hire there runs for this floor straight away.
  await chord(page);
  await page.keyboard.type('hire');
  await page.keyboard.press('Enter');
  await expectClosed(page);
  await expect.poll(() => page.evaluate(() => window.__h3d.dialog()?.kind), { timeout: 30_000 }).toBe('hire');
  clean();
});

test('the floor plan and a lobby: the chord opens it and is cancelled', async ({ page }) => {
  const clean = watchErrors(page);
  await openGame(page, 'demo', '', SIM);
  await page.evaluate((s) => window.__h3d.enterFloor(s), FLOOR);
  await frames(page, 3);
  await page.evaluate(() => window.__h3d.plan(true));
  await frames(page, 2);
  expect(await chord(page)).toBe(true);
  await expectOpen(page);
  await page.keyboard.press('Escape');
  await expectClosed(page);
  expect((await view(page)).plan).toBe(true);
  await page.evaluate(() => window.__h3d.plan(false));
  await page.evaluate(() => window.__h3d.enterLobby());
  await frames(page, 3);
  expect((await view(page)).area).toBe('lobby');
  expect(await chord(page)).toBe(true);
  await expectOpen(page);
  // From the lobby, Overview is a floor-scoped row: it asks.
  await page.keyboard.type('overview');
  await page.keyboard.press('Enter');
  await expect(palette(page).locator('.pal-title')).toHaveText('See the overview of which floor?');
  await page.keyboard.press('Escape');
  await expectClosed(page);
  clean();
});

test('seated at a terminal: the chord is the game’s, the pane gets no Ctrl+P, Esc gives the keyboard back', async ({ page }) => {
  test.setTimeout(150_000);
  const clean = watchErrors(page);
  await openGame(page, 'demo-m4', '', SIM);
  await page.evaluate((s) => window.__h3d.enterFloor(s), FLOOR);
  await frames(page, 3);
  const L = await page.evaluate((s) => window.__h3d.layout(s), FLOOR);
  const w = (await page.evaluate(() => window.__h3d.world())).find((f) => f.session === FLOOR);
  const sprout = w?.workers.find((x) => x.name === 'Sprout');
  if (!L || !sprout) throw new Error('no floor or worker');
  await leftInTerminal(page, sprout.id);
  const s = L.slots[sprout.desk];
  if (!s) throw new Error('no desk');
  const p = await page.evaluate(() => window.__h3d.pose());
  const [x, z] = [s.seat.x - Math.sin(s.yaw) * 1.4, s.seat.z - Math.cos(s.yaw) * 1.4];
  const yaw = Math.atan2(-(s.seat.x - x), -(s.seat.z - z));
  const pitch = Math.atan2(0.95 - (p?.eye ?? 1.6), Math.hypot(s.seat.x - x, s.seat.z - z));
  await page.evaluate(([yy, pp, xx, zz]) => window.__h3d.setPose({ x: xx, z: zz, yaw: yy, pitch: pp }), [yaw, pitch, x, z] as const);
  await frames(page, 2);
  expect(await page.evaluate((id) => window.__h3d.sitAt(id), sprout.id)).toBe(true);
  await expect.poll(() => page.evaluate(() => window.__h3d.seat().mode)).toBe('terminal');
  await expect(page.locator('.seat-input')).toBeFocused();
  await page.keyboard.type('ls');
  await page.keyboard.press('Control+KeyP');
  await expectOpen(page);
  await page.keyboard.press('Escape');
  await expectClosed(page);
  // Esc closed the palette only: still seated, and the keyboard is the terminal's again.
  expect(await page.evaluate(() => window.__h3d.seated())).toBe(sprout.id);
  await expect(page.locator('.seat-input')).toBeFocused();
  expect(await chord(page)).toBe(true);
  await expectOpen(page);
  expect(await chord(page)).toBe(true);
  await expectClosed(page);
  await page.keyboard.type('x');
  // Nothing of the chord reached the pane: the typed keys are all it got.
  await expect
    .poll(async () =>
      (await page.evaluate(() => window.__h3d.sent()))
        .filter((c) => c.t === 'worker.keys')
        .flatMap((c) => (c.args as { input: Array<{ text?: string; key?: string }> }).input)
        .map((k) => k.text ?? `<${k.key}>`)
        .join(''),
    )
    .toBe('lsx');
  // A command from the seat stands you up first: Settings opens, nobody is at a laptop.
  await chord(page);
  await page.keyboard.type('settings');
  await page.keyboard.press('Enter');
  await expectClosed(page);
  await expect.poll(() => page.evaluate(() => window.__h3d.seated())).toBeNull();
  await expect(page.locator('dialog[open]', { hasText: 'Settings' }).first()).toBeVisible();
  clean();
});

test('over the hire dialog: the palette sits on top, Esc closes only it and the field gets the keyboard back', async ({ page }) => {
  test.setTimeout(150_000);
  const clean = watchErrors(page);
  await openGame(page, 'demo-m4', '', SIM);
  await page.evaluate(() => window.__h3d.enterFloor('pastry'));
  await frames(page, 3);
  await page.evaluate(() => window.__h3d.openHire(14));
  await expect.poll(() => page.evaluate(() => window.__h3d.dialog()?.kind === 'hire' && window.__h3d.dialog()?.state), { timeout: 10_000 }).toBe('ready');
  await page.locator('#hire-task').focus();
  await page.keyboard.type('Label the loaves');
  expect(await chord(page)).toBe(true);
  await expectOpen(page);
  // The hire dialog is still up under it.
  expect((await dialog(page))?.kind).toBe('hire');
  await page.keyboard.press('Escape');
  await expectClosed(page);
  expect((await dialog(page))?.kind).toBe('hire');
  await expect(page.locator('#hire-task')).toBeFocused();
  await expect(page.locator('#hire-task')).toContainText('Label the loaves');
  // A command closes the dialog it sat over: Buildings opens, the hire dialog is gone.
  await chord(page);
  await page.keyboard.type('buildings');
  await page.keyboard.press('Enter');
  await expectClosed(page);
  await expect.poll(() => dialog(page)).toBeNull();
  await expect.poll(() => page.evaluate(() => window.__h3d.panel()?.kind)).toBe('buildings');
  clean();
});

test('on the whiteboard: the chord opens it over the board, Esc closes only the palette', async ({ page }) => {
  test.setTimeout(240_000);
  const clean = watchErrors(page);
  const key = `pal${Date.now().toString(36)}`;
  await openGame(page, 'demo', '&me=Theo', `${SIM}&simusage=0&wb_key=${key}`);
  await page.evaluate((f) => window.__h3d.enterFloor(f), FLOOR);
  await frames(page, 3);
  await page.evaluate((floor) => {
    const b = window.__h3d.layout(floor)?.props.find((p) => p.id === 'whiteboard')?.box;
    if (!b) throw new Error('no whiteboard prop');
    window.__h3d.setPose({ x: (b.min[0] + b.max[0]) / 2, z: 2.4, yaw: 0, pitch: 0.02 });
  }, FLOOR);
  await frames(page, 3);
  await page.keyboard.press('KeyE');
  await expect(page.locator('.wb .excalidraw')).toBeVisible({ timeout: 60_000 });
  await page.locator('.wb .excalidraw').click({ position: { x: 200, y: 200 } });
  expect(await chord(page)).toBe(true);
  await expectOpen(page);
  await page.keyboard.press('Escape');
  await expectClosed(page);
  // The board is still up, and the keyboard is its again.
  await expect(page.locator('.wb .excalidraw')).toBeVisible();
  expect(await chord(page)).toBe(true);
  await expectOpen(page);
  // A command closes the board (saved first) and runs: the inbox list is not empty here, Settings always opens.
  await page.keyboard.type('settings');
  await page.keyboard.press('Enter');
  await expectClosed(page);
  await expect(page.locator('.wb')).toBeHidden({ timeout: 30_000 });
  await expect(page.locator('dialog[open]', { hasText: 'Settings' }).first()).toBeVisible();
  clean();
});
