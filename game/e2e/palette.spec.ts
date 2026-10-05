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

/** Seats the player at Sprout's laptop on the herdr-3d floor of demo-m4, the terminal up and its input focused. */
async function sitAtSprout(page: Page, extra = SIM): Promise<string> {
  await openGame(page, 'demo-m4', '', extra);
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
  return sprout.id;
}

test('seated at a terminal: the chord is the game’s, the pane gets no Ctrl+P, Esc gives the keyboard back', async ({ page }) => {
  test.setTimeout(150_000);
  const clean = watchErrors(page);
  const sproutId = await sitAtSprout(page);
  await page.keyboard.type('ls');
  await page.keyboard.press('Control+KeyP');
  await expectOpen(page);
  await page.keyboard.press('Escape');
  await expectClosed(page);
  // Esc closed the palette only: still seated, and the keyboard is the terminal's again.
  expect(await page.evaluate(() => window.__h3d.seated())).toBe(sproutId);
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

// ---- the plan-limits plate: it steps out of the palette as its edge tab, on every view (#147, the user's requirement) ----------------
// `simlimits=ok`: Claude team 5h 11 % / week 61 %, Codex week 19 % (the tab shows the worst, 61 %).

const LIM = `${SIM}&simlimits=ok`;
const plate = (page: Page) => page.locator('.limits');

async function withReadings(page: Page): Promise<void> {
  await expect.poll(async () => (await page.evaluate(() => window.__h3d.limits()))?.lines.length ?? 0, { message: 'readings arrived', timeout: 15_000 }).toBe(2);
}

/** While the palette is open: the plate is its small edge tab (not the full plate), clear of the palette, and a click at its middle reaches it. */
async function expectTab(page: Page): Promise<void> {
  await expect(plate(page)).toHaveAttribute('data-dock', 'tab');
  await expect(plate(page).locator('.lm-tab')).toBeVisible();
  await expect(plate(page).locator('.lm-tab-pct')).toHaveText('61%');
  await expect(plate(page).locator('.lm-strip')).toBeHidden();
  await expect(plate(page).locator('.lm-panel')).toBeHidden();
  const hit = await page.evaluate(() => {
    const t = document.querySelector('.limits .lm-tab')?.getBoundingClientRect();
    const p = document.querySelector('dialog.palette')?.getBoundingClientRect();
    if (!t || !p) return { reached: false, clear: false, why: 'no box' };
    const at = document.elementFromPoint(t.left + t.width / 2, t.top + t.height / 2);
    return { reached: !!at?.closest('.lm-tab'), clear: t.left >= p.right, why: `${at?.tagName}.${at?.className} ${JSON.stringify([t.left, p.right])}` };
  });
  expect(hit.reached, `a click at the tab's middle reaches it: ${hit.why}`).toBe(true);
  expect(hit.clear, `the tab sits right of the palette: ${hit.why}`).toBe(true);
}

/** The saved plate is back: not docked, the strip shows, the tab does not. */
async function expectPlateBack(page: Page): Promise<void> {
  await expect(plate(page)).toHaveAttribute('data-dock', '');
  await expect(plate(page).locator('.lm-strip')).toBeVisible();
  await expect(plate(page).locator('.lm-tab')).toBeHidden();
}

for (const where of ['city', 'floor'] as const) {
  test(`${where}: the plan-limits plate is its edge tab while the palette is open, a click on it peeks, and the plate is back when it closes`, async ({ page }) => {
    const clean = watchErrors(page);
    await openGame(page, 'demo', '', LIM);
    await withReadings(page);
    if (where === 'floor') {
      await page.evaluate((s) => window.__h3d.enterFloor(s), FLOOR);
      await frames(page, 3);
    }
    await expectPlateBack(page);
    expect(await chord(page)).toBe(true);
    await expectOpen(page);
    await expectTab(page);
    await page.screenshot({ path: resolve(RESULTS, `palette-limits-tab-${where}.png`) });
    // The tab is clickable: it peeks the plate over the palette (the saved state is untouched) ...
    await plate(page).locator('.lm-tab').click();
    await expect(plate(page)).toHaveAttribute('data-peek', 'true');
    await expect(plate(page).locator('.lm-panel')).toBeVisible();
    await expect(palette(page)).toBeVisible();
    // ... and typing in the field is still the field's: Shift+L is an L there.
    await input(page).focus();
    await page.keyboard.type('L');
    await expect(input(page)).toHaveValue('L');
    // The chord closes the palette (the keyboard is wherever it is); the peek ends, the plate is what it was.
    expect(await chord(page)).toBe(true);
    await expectClosed(page);
    await expect(plate(page)).toHaveAttribute('data-peek', 'false');
    await expectPlateBack(page);
    expect(await page.evaluate(() => localStorage.getItem('h3d.limits.open'))).not.toBe('true');
    // Opened again: the tab again, then Esc gives the plate back.
    await chord(page);
    await expectOpen(page);
    await expectTab(page);
    await page.keyboard.press('Escape');
    await expectClosed(page);
    await expectPlateBack(page);
    clean();
  });
}

test('seated at a terminal: the plan-limits plate is its edge tab over the palette, and back at the laptop after', async ({ page }) => {
  test.setTimeout(150_000);
  const clean = watchErrors(page);
  await sitAtSprout(page, LIM);
  await withReadings(page);
  // Seated the plate was already docked as the tab beside the glass: it stays a tab, now clear of the palette and clickable.
  expect(await chord(page)).toBe(true);
  await expectOpen(page);
  await expectTab(page);
  await page.keyboard.press('Escape');
  await expectClosed(page);
  await expect(plate(page)).toHaveAttribute('data-dock', /tab|away/);
  await expect(page.locator('.seat-input')).toBeFocused();
  clean();
});

test('over the hire dialog: the plate (away under the sheet) is the edge tab over the palette, and clickable', async ({ page }) => {
  test.setTimeout(150_000);
  const clean = watchErrors(page);
  await openGame(page, 'demo-m4', '', LIM);
  await withReadings(page);
  await page.evaluate(() => window.__h3d.enterFloor('pastry'));
  await frames(page, 3);
  await page.evaluate(() => window.__h3d.openHire(14));
  await expect.poll(() => page.evaluate(() => window.__h3d.dialog()?.kind === 'hire' && window.__h3d.dialog()?.state), { timeout: 10_000 }).toBe('ready');
  await expect(plate(page)).toHaveAttribute('data-dock', 'away'); // the sheet leaves no gutter of its own
  expect(await chord(page)).toBe(true);
  await expectOpen(page);
  await expectTab(page);
  await plate(page).locator('.lm-tab').click();
  await expect(plate(page)).toHaveAttribute('data-peek', 'true');
  await expect(plate(page).locator('.lm-panel')).toBeVisible();
  await page.keyboard.press('Escape'); // from the plate: the palette (the topmost modal) closes
  await expectClosed(page);
  expect((await dialog(page))?.kind).toBe('hire');
  await expect(plate(page)).toHaveAttribute('data-dock', 'away'); // the sheet's own again
  clean();
});

const ovOpen = async (page: Page) => (await page.evaluate(() => window.__h3d.overview()))?.page.open ?? false;

// ---- over the floor overview (the page marks its siblings inert: the palette is not one of them) -----------------------------------

test('over the floor overview: the field has the keyboard, typing, ↑ ↓ and Enter work, and a command closes the overview and runs', async ({ page }) => {
  test.setTimeout(150_000);
  const clean = watchErrors(page);
  await openGame(page, 'demo', '', LIM);
  await withReadings(page);
  await page.evaluate((s) => window.__h3d.enterFloor(s), FLOOR);
  await frames(page, 3);
  await page.keyboard.press('KeyO');
  await expect.poll(() => ovOpen(page)).toBe(true);
  expect(await chord(page)).toBe(true);
  await expectOpen(page); // visible, and the field focused (an inert palette would not take the focus)
  await expectTab(page); // a clickable tab over the overview too
  await page.keyboard.type('is');
  await expect(rows(page).first()).toHaveText('Issues');
  await page.keyboard.press('ArrowDown');
  await expect(palette(page).locator('.pal-opt[aria-selected="true"] .pal-name')).not.toHaveText('Issues');
  await page.keyboard.press('ArrowUp');
  await expect(palette(page).locator('.pal-opt[aria-selected="true"] .pal-name')).toHaveText('Issues');
  // A click lands in the palette too (the page behind is the one that is inert).
  await input(page).click();
  await expect(input(page)).toBeFocused();
  await page.keyboard.press('Enter');
  await expectClosed(page);
  await expect.poll(() => ovOpen(page)).toBe(false);
  await expect(page.locator('dialog.desk-dlg--board')).toBeVisible({ timeout: 30_000 }); // Issues ran, on this floor
  clean();
});

test('over the floor overview: Esc closes only the palette, and the overview keeps its keys', async ({ page }) => {
  const clean = watchErrors(page);
  await openGame(page, 'demo', '', SIM);
  await page.evaluate((s) => window.__h3d.enterFloor(s), FLOOR);
  await frames(page, 3);
  await page.keyboard.press('KeyO');
  await expect.poll(() => ovOpen(page)).toBe(true);
  await chord(page);
  await expectOpen(page);
  await page.keyboard.press('Escape');
  await expectClosed(page);
  expect(await ovOpen(page)).toBe(true);
  // The overview is live again: Esc now closes it.
  await page.keyboard.press('Escape');
  await expect.poll(() => ovOpen(page)).toBe(false);
  clean();
});

// ---- over an image preview, and with a card in the air ------------------------------------------------------------------------------

test('over the enlarged image of the hire composer: the chord opens the palette on top, Esc closes only it, the next Esc the preview', async ({ page }) => {
  test.setTimeout(150_000);
  const clean = watchErrors(page);
  const key = `pal${Date.now().toString(36)}`;
  await openGame(page, 'demo-m4', '', `${SIM}&upload_key=${key}`);
  await page.evaluate(() => window.__h3d.enterFloor('herdr-3d'));
  await frames(page, 3);
  await page.evaluate(() => window.__h3d.openHire(5));
  await expect.poll(() => page.evaluate(() => window.__h3d.dialog()?.kind === 'hire' && window.__h3d.dialog()?.state), { timeout: 10_000 }).toBe('ready');
  await expect(page.locator('#hire-task')).toBeFocused();
  await page.evaluate(async () => {
    const c = document.createElement('canvas');
    c.width = 640;
    c.height = 360;
    (c.getContext('2d') as CanvasRenderingContext2D).fillRect(0, 0, 640, 360);
    const blob = await new Promise<Blob>((r) => c.toBlob((b) => r(b as Blob), 'image/png'));
    const dt = new DataTransfer();
    dt.items.add(new File([blob], 'shot-a.png', { type: 'image/png' }));
    (document.querySelector('#hire-task') as HTMLElement).dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  const lightbox = page.locator('dialog.cmp-lightbox[open]');
  await page.locator('#hire-task .cmp-thumb').first().click();
  await expect(lightbox).toBeVisible();
  expect(await chord(page)).toBe(true);
  await expectOpen(page);
  // The preview is still up under it. Keys in the field are the field's (↓ must not zoom or go anywhere else).
  await page.keyboard.type('sett');
  await page.keyboard.press('ArrowDown');
  await expect(lightbox).toBeVisible();
  await page.keyboard.press('Escape');
  await expectClosed(page);
  await expect(lightbox).toBeVisible();
  // Chord again and again: it opens and closes over the preview; the next Esc then closes the preview and leaves the dialog.
  await chord(page);
  await expectOpen(page);
  expect(await chord(page)).toBe(true);
  await expectClosed(page);
  await page.keyboard.press('Escape');
  await expect(lightbox).toHaveCount(0);
  expect((await dialog(page))?.kind).toBe('hire');
  clean();
});

test('with a card in the air over the Issues board: the chord opens the palette, the card goes back, nothing is dropped', async ({ page }) => {
  test.setTimeout(150_000);
  const clean = watchErrors(page);
  await openGame(page, 'demo-m6', '&open=none', 'play=none&sim=1&simms=150&simusage=0');
  await page.evaluate(() => window.__h3d.enterFloor('lab'));
  await frames(page, 3);
  await page.evaluate(() => window.__h3d.openBoard('issues'));
  const board = page.locator('dialog.desk-dlg--board');
  await expect(board).toBeVisible();
  const card = board.locator('.bd-card[data-drag="true"]').first();
  await expect(card).toBeVisible();
  await board.evaluate((d) => Promise.all(d.getAnimations({ subtree: true }).map((a) => a.finished)));
  const b = (await card.boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2 + 8, b.y + b.height / 2 + 8, { steps: 3 });
  await expect(page.locator('.bd-card--lifted')).toHaveCount(1);
  expect(await chord(page)).toBe(true);
  await expectOpen(page);
  await expect(page.locator('.bd-card--lifted')).toHaveCount(0);
  await expect(page.locator('.bd-dragging')).toHaveCount(0);
  await page.mouse.up();
  await frames(page, 3);
  expect((await page.evaluate(() => window.__h3d.sent())).filter((c) => c.t === 'issue.set_status')).toEqual([]);
  await page.keyboard.press('Escape');
  await expectClosed(page);
  await expect(board).toBeVisible();
  clean();
});
