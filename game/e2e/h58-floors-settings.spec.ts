import { expect, test, type Page } from '@playwright/test';
import { openGame, openMenu, settingsSection, shot, watchErrors } from './game';

// #58 stage 4: Settings → Floors and Add floor's "Virtual floor on an existing session", on demo-h58 and the simulating
// fixture server (tools/fixture-sim.ts). Work holds herdr-3d with its virtual floor "Frontend" (Biscuit and Pip work
// there), depot-manager (asleep) with "Depot docs", and pastry with its hidden, empty "Archive"; scratchpad is in the
// lot. From Settings: add a virtual floor, rename it, show and hide Archive, delete Depot docs (nobody on it) and
// Frontend (its two workers move to herdr-3d). From the city: Add floor's second choice. A v- id never reaches the screen.

const SIM = 'play=none&sim=1&simms=150';
const FRONT = 'v-00000000f0e1';
const DOCS = 'v-00000000f0e2';
const ARCHIVE = 'v-00000000f0e3';

const sent = (page: Page) => page.evaluate(() => window.__h3d.sent());
const world = (page: Page) => page.evaluate(() => window.__h3d.world());
const addDlg = (page: Page) => page.locator('dialog.desk-dlg--addfloor');
const sentOf = async (page: Page, t: string) => (await sent(page)).filter((c) => c.t === t).map((c) => c.args);

/** Every text and label on screen: a virtual floor's id must be in none of them. */
async function noIdShown(page: Page, where: string): Promise<void> {
  const shown = await page.evaluate(() => {
    const parts = [document.body.innerText];
    for (const el of document.querySelectorAll('[aria-label], [title]')) parts.push(el.getAttribute('aria-label') ?? '', el.getAttribute('title') ?? '');
    return parts.join('\n');
  });
  expect(shown.match(/v-[0-9a-f]{12}/g), `a floor id on screen (${where})`).toBeNull();
}

test('Settings → Floors: add a virtual floor, rename it, show and hide one, delete with and without workers', async ({ page }) => {
  test.setTimeout(90_000);
  const clean = watchErrors(page);
  await openGame(page, 'demo-h58', '', SIM);
  await openMenu(page);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const section = await settingsSection(page, 'floors');
  await expect(section.locator('.settings-store')).toHaveText('Bridge');
  const names = section.locator('.settings-fl-row .settings-fl-name');
  await expect(names).toHaveText(['depot-manager', 'Depot docs', 'herdr-3d', 'Frontend', 'pastry', 'Archive', 'scratchpad']);
  const row = (name: string) => section.locator('.settings-fl-row').filter({ has: page.locator('.settings-fl-name', { hasText: new RegExp(`^${name}$`) }) });
  await expect(row('Frontend').locator('.settings-fl-meta')).toHaveText('Virtual floor on session herdr-3d · 2 workers');
  await expect(row('Archive').locator('.settings-badge')).toHaveText('Hidden');
  await expect(section).toContainText('It shows again as soon as a worker is on it');
  await shot(page, 'h58-floors-settings');
  await noIdShown(page, 'Settings → Floors');

  // Add floor, over Settings, on a virtual floor: a name and a session, no building.
  const add = section.getByRole('button', { name: 'Add floor' });
  await add.click();
  await expect(addDlg(page)).toBeVisible();
  await expect(addDlg(page).getByRole('radio', { name: /Virtual floor on an existing session/ })).toBeChecked();
  const name = addDlg(page).getByLabel('Floor name');
  await expect(name).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(addDlg(page).locator('#af-name-hint')).toHaveText('Give the floor a name.');
  await name.fill('Billing');
  await addDlg(page).getByLabel('Base session').selectOption('pastry');
  await name.press('Enter');
  await expect(addDlg(page)).toBeHidden();
  await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible();
  await expect(add).toBeFocused();
  await expect(section.locator('.settings-status')).toHaveText('Added Billing on session pastry.');
  await expect(row('Billing').locator('.settings-fl-meta')).toHaveText('Virtual floor on session pastry · Nobody works here');
  expect(await sentOf(page, 'floor.create')).toEqual([{ name: 'Billing', base_session: 'pastry' }]);

  // Rename it in place, from the keyboard.
  await row('Billing').getByRole('button', { name: 'Rename Billing' }).click();
  const field = section.getByLabel('New name for Billing');
  await expect(field).toBeFocused();
  await expect(field).toHaveValue('Billing');
  await page.keyboard.type('Billing desk');
  await page.keyboard.press('Enter');
  await expect(section.locator('.settings-status')).toHaveText('Renamed Billing to Billing desk.');
  await expect(row('Billing desk').getByRole('button', { name: 'Rename Billing desk' })).toBeFocused();
  const billing = (await world(page)).find((f) => f.name === 'Billing desk');
  expect(billing).toMatchObject({ session: 'pastry', virtual: true, building: 'Work' });
  expect(await sentOf(page, 'floor.rename')).toEqual([{ floor: billing!.id, name: 'Billing desk' }]);
  // Esc ends a rename and leaves Settings open.
  await row('Billing desk').getByRole('button', { name: 'Rename Billing desk' }).click();
  await page.keyboard.press('Escape');
  await expect(section.locator('.settings-fl-edit')).toHaveCount(0);
  await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible();

  // Show and hide Archive (decision 2).
  await row('Archive').getByRole('button', { name: 'Show Archive' }).click();
  await expect(section.locator('.settings-status')).toHaveText('Archive is listed again.');
  await expect(row('Archive').locator('.settings-badge')).toHaveCount(0);
  // Listed again: in the world hook's floors (they follow the city), and in the city.
  expect((await world(page)).find((f) => f.id === ARCHIVE)?.hidden).toBe(false);
  await row('Archive').getByRole('button', { name: 'Hide Archive' }).click();
  await expect(section.locator('.settings-status')).toHaveText('Archive is hidden.');
  await expect(row('Archive').locator('.settings-badge')).toHaveText('Hidden');
  expect((await world(page)).some((f) => f.id === ARCHIVE)).toBe(false);
  expect(await sentOf(page, 'floor.hide')).toEqual([
    { floor: ARCHIVE, hidden: false },
    { floor: ARCHIVE, hidden: true },
  ]);

  // Delete Depot docs: nobody works there, a simple confirmation (Keep it first).
  await row('Depot docs').getByRole('button', { name: 'Delete Depot docs' }).click();
  const confirm = section.locator('.settings-fl-confirm');
  await expect(confirm.locator('.settings-fl-confirm-title')).toHaveText('Delete Depot docs?');
  await expect(confirm).toContainText('Nobody works on it.');
  await expect(confirm.getByRole('button', { name: 'Keep it' })).toBeFocused();
  await confirm.getByRole('button', { name: 'Delete floor' }).click();
  await expect(section.locator('.settings-status')).toHaveText('Deleted Depot docs.');
  await expect(row('Depot docs')).toHaveCount(0);

  // Delete Frontend: its workers are named, and they move to herdr-3d.
  await row('Frontend').getByRole('button', { name: 'Delete Frontend' }).click();
  await expect(confirm).toContainText('Biscuit and Pip work on it. Deleting it moves these 2 workers to herdr-3d, session herdr-3d’s own floor');
  await shot(page, 'h58-floors-settings-delete');
  await confirm.getByRole('button', { name: 'Move 2 workers and delete' }).click();
  await expect(section.locator('.settings-status')).toHaveText('Deleted Frontend. Biscuit and Pip moved to herdr-3d.');
  await expect(row('Frontend')).toHaveCount(0);
  expect(await sentOf(page, 'floor.delete')).toEqual([{ floor: DOCS }, { floor: FRONT, move_workers: true }]);
  await expect
    .poll(async () => (await world(page)).find((f) => f.id === 'herdr-3d')?.workers.map((w) => w.name).filter((n) => n === 'Biscuit' || n === 'Pip').sort())
    .toEqual(['Biscuit', 'Pip']);
  await noIdShown(page, 'after the deletes');
  clean();
});

test('a floor you walked to stays under you when Settings hides it', async ({ page }) => {
  const clean = watchErrors(page);
  await openGame(page, 'demo-h58', '', SIM);
  // Archive listed again, then reached from pastry by walking (a pose onto its storey takes the stairs' path), not by
  // the elevator: hiding it, empty, must not take it from under you.
  await openMenu(page);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  let section = await settingsSection(page, 'floors');
  const archive = () => section.locator('.settings-fl-row').filter({ has: page.locator('.settings-fl-name', { hasText: /^Archive$/ }) });
  await archive().getByRole('button', { name: 'Show Archive' }).click();
  await expect(section.locator('.settings-status')).toHaveText('Archive is listed again.');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Settings' })).toBeHidden();
  await page.evaluate(() => window.__h3d.enterFloor('pastry'));
  const where = await page.evaluate(() => window.__h3d.where());
  const storey = where!.floors.indexOf(ARCHIVE);
  expect(storey).toBeGreaterThanOrEqual(0);
  const storeyH = await page.evaluate(() => window.__h3d.building()!.storey);
  const from = (await page.evaluate(() => window.__h3d.pose()))!;
  await page.evaluate((p) => window.__h3d.setPose(p), { x: from.x, z: from.z, yaw: from.yaw, y: (storey + 1) * storeyH });
  await expect.poll(async () => (await page.evaluate(() => window.__h3d.pose()))?.floor).toBe(ARCHIVE);
  const on = (await page.evaluate(() => window.__h3d.pose()))!;

  await openMenu(page);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  section = await settingsSection(page, 'floors');
  await archive().getByRole('button', { name: 'Hide Archive' }).click();
  await expect(section.locator('.settings-status')).toHaveText('Archive is hidden.');
  await page.keyboard.press('Escape');
  // Still on Archive, at its height, with its interior: not the lobby.
  const after = (await page.evaluate(() => window.__h3d.pose()))!;
  expect(after).toMatchObject({ floor: ARCHIVE, area: 'floor', storey: on.storey });
  expect(after.y).toBeCloseTo(on.y, 3);
  expect((await page.evaluate(() => window.__h3d.where()))!.loaded).toBe(ARCHIVE);
  // Down in the lobby, it is no floor you stand on: hidden and empty, it leaves the building.
  await page.evaluate(() => window.__h3d.enterLobby());
  await expect.poll(async () => (await page.evaluate(() => window.__h3d.where()))?.floors.includes(ARCHIVE)).toBe(false);
  clean();
});

test('Add floor from the city: a virtual floor on an existing session, in its session’s building', async ({ page }) => {
  const clean = watchErrors(page);
  await openGame(page, 'demo-h58', '', SIM);
  await openMenu(page);
  await page.getByRole('button', { name: 'Add floor' }).click();
  await expect(addDlg(page)).toBeVisible();
  // A new session first, as before; the second choice from the keyboard.
  await expect(addDlg(page).getByRole('radio', { name: /New herdr session/ })).toBeChecked();
  await expect(addDlg(page).getByLabel('Base session')).toBeHidden();
  await addDlg(page).getByRole('radio', { name: /Virtual floor on an existing session/ }).check();
  await expect(addDlg(page).locator('#af-sub')).toHaveText('It starts empty, in its session’s building.');
  const base = addDlg(page).getByLabel('Base session');
  await expect(base.locator('option')).toHaveText(['depot-manager · asleep', 'herdr-3d', 'pastry', 'scratchpad']);
  await base.selectOption('depot-manager');
  await addDlg(page).getByLabel('Floor name').fill('Ops');
  await shot(page, 'h58-add-virtual-floor');
  await page.keyboard.press('Enter');
  await expect(addDlg(page)).toBeHidden();
  await expect(page.locator('.toast').last()).toHaveText('Added Ops on herdr session depot-manager, in Work.');
  expect(await sentOf(page, 'floor.create')).toEqual([{ name: 'Ops', base_session: 'depot-manager' }]);
  const ops = (await world(page)).find((f) => f.name === 'Ops');
  expect(ops).toMatchObject({ session: 'depot-manager', virtual: true, building: 'Work', asleep: true });
  await expect(page.locator(`.floor-list button[data-floor="${ops!.id}"]`)).toBeAttached();
  await noIdShown(page, 'the city after Add floor');
  clean();
});
