import { expect, test, type Page } from '@playwright/test';
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PNG } from 'pngjs';
import { frames, openGame, shot, watchErrors } from './game';

// M3d building logos, on the simulating fixture server (tools/fixture-sim.ts, tools/fixture-logo.ts): the demo-m3
// fixture, Work = herdr-3d (running) + depot-manager (asleep), Personal = pastry. A logo is set in the Buildings
// panel from a file; the entrance sign, the reception wall and the city show it, lit while a floor runs and dim when
// all sleep; clearing it brings the name back. `H3D_DOC_SHOTS=1` also writes the screenshots the PR shows to
// docs/img/m3d-logos/.

const WORK = 'b_3f09a1c2d4e5';
const PERSONAL = 'b_77aa01b2c3d4';
const LOGO = resolve(import.meta.dirname, 'fixtures/test-logo.png');
const DOCS = resolve(import.meta.dirname, '../../docs/img/m3d-logos');

/** A world of its own on the fixture server: /logo requests carry the key back. */
const sim = (key: string, more = '') => `play=none&sim=1&simms=150&simusage=0&simlogo=${key}${more}`;
const unique = (name: string) => `${name}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

type Logos = NonNullable<ReturnType<Window['__h3d']['logos']>>;
const logos = async (page: Page): Promise<Logos> => (await page.evaluate(() => window.__h3d.logos())) as Logos;
const key = (page: Page, k: string) => page.locator(`dialog.panel [data-key="${k}"]`);

/** The magenta ring of the test logo: pixels of the page's canvas that are (nearly) that colour. */
async function magenta(page: Page, clip?: { x: number; y: number; width: number; height: number }): Promise<number> {
  const png = PNG.sync.read(await page.screenshot({ style: '.hud, #debug { visibility: hidden !important; }', ...(clip ? { clip } : {}) }));
  let n = 0;
  for (let i = 0; i < png.data.length; i += 4) {
    const r = png.data[i] as number;
    const g = png.data[i + 1] as number;
    const b = png.data[i + 2] as number;
    if (r > 170 && g < 110 && b > 60 && b < 190 && r - g > 100) n++;
  }
  return n;
}

/** Opens the Buildings panel and chooses the test logo for a building, the way a keyboard user would. */
async function setLogo(page: Page, building: string, file = LOGO): Promise<void> {
  if (!(await page.locator('dialog.panel h2').filter({ hasText: 'Buildings' }).isVisible())) await page.evaluate(() => window.__h3d.openBuildings());
  await expect(page.locator('dialog.panel h2')).toHaveText('Buildings');
  const chooser = page.waitForEvent('filechooser');
  await key(page, `logo-set:${building}`).focus();
  await page.keyboard.press('Enter');
  await (await chooser).setFiles(file);
}

async function docShot(page: Page, name: string): Promise<void> {
  if (!process.env.H3D_DOC_SHOTS) return;
  mkdirSync(DOCS, { recursive: true });
  writeFileSync(resolve(DOCS, `${name}.png`), await page.screenshot());
}

test('set a logo in the Buildings panel: the sign, the reception wall and the city show it; clear it and the name is back', async ({ page }) => {
  test.setTimeout(240_000);
  const clean = watchErrors(page);
  await openGame(page, 'demo-m3', '&open=none', sim(unique('set')));
  await expect(page.locator('.topbar-sub')).toHaveText('2 buildings · 4 floors');
  expect(await logos(page)).toMatchObject({ fetches: 0, cached: 0, city: [], lobby: null });

  // The panel: Work has no logo yet.
  await page.keyboard.press('m');
  await expect(page.locator('.dir-logo[data-logo=""]')).toHaveCount(2);
  await expect(key(page, `logo-set:${WORK}`)).toHaveAccessibleName('Set the logo of Work');
  await expect(key(page, `logo-clear:${WORK}`)).toHaveCount(0);

  await setLogo(page, WORK);
  await expect(page.locator('dialog.panel .panel-status[role="status"]')).toHaveText('Logo saved for Work.');
  await expect.poll(async () => (await logos(page)).city.length, { timeout: 15_000 }).toBe(1);
  await expect(page.locator(`.dir-building[data-id="${WORK}"] .logo-state`)).toHaveText('Shown on the entrance sign, the reception wall and the city.');
  const { hash } = (await logos(page)).city[0] as Logos['city'][number];
  expect(hash).toMatch(/^[0-9a-f]{64}$/);
  expect((await logos(page)).city[0]).toMatchObject({ building: WORK, lit: true });
  // The thumbnail is the fetched image; the button now changes it, and Clear is there. Focus is back on the button.
  const summary = (await page.evaluate(() => window.__h3d.panel())) as { buildings: Array<{ id: string; logo: string | null }> };
  expect(summary.buildings.find((b) => b.id === WORK)?.logo).toBe(hash);
  await expect(page.locator(`.dir-building[data-id="${WORK}"] .logo-thumb img`)).toBeVisible();
  expect(await page.locator(`.dir-building[data-id="${WORK}"] .logo-thumb img`).evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth)).toBe(720);
  await expect(key(page, `logo-set:${WORK}`)).toHaveAccessibleName('Change the logo of Work');
  await expect(key(page, `logo-set:${WORK}`)).toBeFocused();
  await expect(key(page, `logo-clear:${WORK}`)).toBeVisible();
  await expect(page.locator(`.dir-building[data-id="${PERSONAL}"] .dir-logo`)).toHaveAttribute('data-logo', '');
  await shot(page, 'm3d-panel');
  await docShot(page, 'buildings-panel');
  await page.keyboard.press('Escape');

  // The city: a sign in front of Work, lit (herdr-3d runs).
  await frames(page, 4);
  await docShot(page, 'city');
  expect(await magenta(page)).toBeGreaterThan(20);

  // The lobby, seen from the sidewalk: the logo sits on the canopy's sign; the reception wall has it too.
  await page.evaluate((b) => window.__h3d.enterLobby(b), WORK);
  await frames(page, 4);
  await expect.poll(async () => (await logos(page)).lobby, { timeout: 15_000 }).toEqual({ canopy: { showing: 'logo', hash }, wall: { showing: 'logo', hash } });
  const b = (await page.evaluate(() => window.__h3d.building())) as NonNullable<ReturnType<Window['__h3d']['building']>>;
  const fx = (b.lobby.front.x0 + b.lobby.front.x1) / 2;
  await page.addStyleTag({ content: '.rx-bubble { visibility: hidden !important; }' }); // the receptionist’s greeting is not the subject
  await page.evaluate(([x, z]) => window.__h3d.setPose({ x: x as number, z: z as number, y: 0, yaw: 0, pitch: 0.2 }), [fx, b.depth + 7.5]);
  await frames(page, 6);
  const noLogoSign = await magenta(page);
  expect(noLogoSign, 'the entrance sign shows the logo').toBeGreaterThan(100);
  await shot(page, 'm3d-sign');
  await docShot(page, 'entrance-sign');
  // Inside, a few steps from the door, looking down the lobby at the wall behind the receptionist.
  const at = [b.lobby.receptionist.x + 1.3, b.depth - 1.4];
  await page.evaluate(([x, z]) => window.__h3d.setPose({ x: x as number, z: z as number, y: 0, yaw: 0.16, pitch: 0.16 }), at);
  await page.addStyleTag({ content: '.rx-bubble { visibility: hidden !important; }' }); // the receptionist’s greeting hides the wall
  await frames(page, 6);
  await shot(page, 'm3d-wall');
  await docShot(page, 'reception-wall');

  // Clear it from the panel: everything goes back to the name.
  await page.evaluate(() => window.__h3d.openBuildings());
  await expect(page.locator('dialog.panel h2')).toHaveText('Buildings');
  await key(page, `logo-clear:${WORK}`).focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('dialog.panel .panel-status[role="status"]')).toHaveText('Cleared the logo of Work. The signs show its name again.');
  await expect.poll(async () => (await logos(page)).lobby, { timeout: 15_000 }).toEqual({ canopy: { showing: 'name', hash: null }, wall: { showing: 'name', hash: null } });
  expect((await logos(page)).city).toEqual([]);
  expect((await logos(page)).cached).toBe(0);
  await expect(key(page, `logo-set:${WORK}`)).toHaveAccessibleName('Set the logo of Work');
  await expect(key(page, `logo-set:${WORK}`)).toBeFocused();
  await expect(key(page, `logo-clear:${WORK}`)).toHaveCount(0);
  clean();
});

test('the city sign follows the facade: lit while a floor runs, dim once every floor sleeps', async ({ page }) => {
  test.setTimeout(240_000);
  const clean = watchErrors(page);
  await openGame(page, 'demo-m3', '&open=none', sim(unique('lit')));
  await page.keyboard.press('m');
  await setLogo(page, WORK);
  await expect.poll(async () => (await logos(page)).city.length, { timeout: 15_000 }).toBe(1);
  await setLogo(page, PERSONAL);
  await expect.poll(async () => (await logos(page)).city.length, { timeout: 15_000 }).toBe(2);
  const before = (await logos(page)).city;
  expect(before.map((c) => [c.building, c.lit]).sort()).toEqual([[WORK, true], [PERSONAL, true]]);
  const fetchesBefore = (await logos(page)).fetches;
  await page.keyboard.press('Escape');

  // Put Personal's only floor to sleep: its sign dims; Work's stays lit. No logo is fetched again (the signs are rebuilt with the city, the textures come from the cache by hash).
  await page.evaluate((b) => window.__h3d.openElevator(b), PERSONAL);
  await page.getByRole('button', { name: 'Sleep floor pastry' }).click();
  await page.locator('dialog.confirm').getByRole('button', { name: 'Sleep floor' }).click();
  await expect.poll(async () => (await logos(page)).city.find((c) => c.building === PERSONAL)?.lit, { timeout: 15_000 }).toBe(false);
  expect((await logos(page)).city.find((c) => c.building === WORK)?.lit).toBe(true);
  expect((await logos(page)).fetches).toBe(fetchesBefore);
  await page.keyboard.press('Escape');
  await frames(page, 4);
  await docShot(page, 'city-lit-and-dim');
  await shot(page, 'm3d-city-lit-dim');

  // And it wakes again.
  await page.evaluate((b) => window.__h3d.openElevator(b), PERSONAL);
  await page.getByRole('button', { name: 'Wake floor pastry' }).click();
  await expect.poll(async () => (await logos(page)).city.find((c) => c.building === PERSONAL)?.lit, { timeout: 15_000 }).toBe(true);
  clean();
});

test('a logo that cannot be fetched leaves the name; a reconnect tries again', async ({ page }) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // Both buildings start with a logo (simlogos=1) but the images are not there (simfail=logo_missing).
  await openGame(page, 'demo-m3', '&open=none', sim(unique('missing'), '&simlogos=1&simfail=logo_missing'));
  await expect.poll(async () => (await logos(page)).fetches, { timeout: 15_000 }).toBe(2);
  await page.evaluate((b) => window.__h3d.enterLobby(b), WORK);
  await frames(page, 4);
  expect(await logos(page)).toMatchObject({ city: [], cached: 0, lobby: { canopy: { showing: 'name', hash: null }, wall: { showing: 'name', hash: null } } });
  await page.waitForTimeout(600);
  expect((await logos(page)).fetches, 'one try each, no retry storm').toBe(2);
  // The Buildings panel does not claim the logo is shown: a visible line says it could not be loaded.
  await page.evaluate(() => window.__h3d.openBuildings());
  const state = page.locator(`.dir-building[data-id="${WORK}"] .logo-state`);
  await expect(state).toHaveText('Saved, but the image could not be loaded — showing the name. It will retry on reconnect.');
  await expect(state).toBeVisible();
  await expect(state).toHaveClass(/logo-state--error/);
  await page.keyboard.press('Escape');
  // Coming back after a dropped connection is a reason to try again.
  await page.evaluate(() => window.__h3d.reconnect());
  await expect.poll(async () => (await logos(page)).fetches, { timeout: 15_000 }).toBe(4);
  expect((await logos(page)).city).toEqual([]);
  expect(errors).toEqual([]);
});

test('refusals: the panel says what is wrong and what to do, and keeps the old logo', async ({ page }) => {
  test.setTimeout(240_000);
  // A refused upload is a 4xx the browser logs itself; nothing else may be an error.
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && !/Failed to load resource: the server responded with a status of (415|503)/.test(m.text()) && errors.push(m.text()));
  const clean = () => expect(errors).toEqual([]);
  const dir = resolve(import.meta.dirname, '../test-results/m3d');
  mkdirSync(dir, { recursive: true });
  await openGame(page, 'demo-m3', '&open=none', sim(unique('refuse'), '&simfail=logo_busy'));
  await page.keyboard.press('m');

  // The browser side checks first: the wrong type, nothing is sent.
  writeFileSync(resolve(dir, 'notes.txt'), 'not an image');
  await setLogo(page, WORK, resolve(dir, 'notes.txt'));
  await expect(page.locator('dialog.panel .panel-status[role="alert"]')).toHaveText('notes.txt is not a PNG, WebP or SVG image.');
  // Over 1 MiB.
  writeFileSync(resolve(dir, 'huge.png'), Buffer.alloc((1 << 20) + 1));
  await setLogo(page, WORK, resolve(dir, 'huge.png'));
  await expect(page.locator('dialog.panel .panel-status[role="alert"]')).toHaveText('huge.png is 1.0 MB. Logos can be up to 1 MB: export it smaller, or as an SVG.');
  // The bridge is the authority: a PNG name over other bytes. The first request meets a busy converter (simfail=logo_busy
  // fails once), the second is refused for what it is.
  writeFileSync(resolve(dir, 'fake.png'), 'GIF89a not a png');
  await setLogo(page, WORK, resolve(dir, 'fake.png'));
  await expect(page.locator('dialog.panel .panel-status[role="alert"]')).toHaveText('herdr-world is busy turning other logos into images. Try again in a moment.');
  await setLogo(page, WORK, resolve(dir, 'fake.png'));
  await expect(page.locator('dialog.panel .panel-status[role="alert"]')).toContainText('That file can’t be used as a logo: not a PNG, WebP or SVG image.');
  await expect(key(page, `logo-set:${WORK}`)).toBeFocused();
  expect((await logos(page)).city).toEqual([]);
  await setLogo(page, WORK);
  await expect(page.locator('dialog.panel .panel-status[role="status"]')).toContainText('Logo saved for Work.');
  await expect.poll(async () => (await logos(page)).city.length, { timeout: 15_000 }).toBe(1);
  // A refused replacement keeps what is there.
  const kept = (await logos(page)).city[0]?.hash;
  await setLogo(page, WORK, resolve(dir, 'fake.png'));
  await expect(page.locator('dialog.panel .panel-status[role="alert"]')).toBeVisible();
  expect((await logos(page)).city[0]?.hash).toBe(kept);
  copyFileSync(LOGO, resolve(dir, 'test-logo.png'));
  clean();
});
