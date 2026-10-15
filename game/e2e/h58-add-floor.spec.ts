import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { openGame, openMenu, RESULTS, watchErrors } from './game';

// #58 Add floor → New herdr session, on demo-m3 and the simulating fixture server (tools/fixture-sim.ts: Work =
// herdr-3d + depot-manager, Personal = pastry, the lot holds scratchpad; herdr also has an asleep "old-notes" that is no
// floor). From the city's top bar: the name is checked as it is typed, the bridge's refusal lands in the field, a good
// name starts the floor ("Starting floor…"), and the Buildings panel opens on the new floor's Move menu to put it into a
// building with floor.assign. The Buildings panel's lot has its own Add floor; an older bridge says what is missing.

const WORK = 'b_3f09a1c2d4e5';
const SIM = 'play=none&sim=1&simms=1200';

type Dialog = NonNullable<ReturnType<Window['__h3d']['dialog']>>;
type AddFloor = Extract<Dialog, { kind: 'add-floor' }>;
type Panel = NonNullable<ReturnType<Window['__h3d']['panel']>>;

const dlg = (page: Page) => page.locator('dialog.desk-dlg--addfloor');
const addFloor = async (page: Page) => (await page.evaluate(() => window.__h3d.dialog())) as AddFloor | null;
const panel = (page: Page) => page.evaluate(() => window.__h3d.panel());
const sent = (page: Page) => page.evaluate(() => window.__h3d.sent());
const focusedKey = (page: Page) => page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.key ?? document.activeElement?.id ?? '');
const shot = (page: Page, name: string) => page.screenshot({ path: resolve(RESULTS, `${name}.png`) });

test('Add floor: a new herdr session from the city, checked like the bridge, then moved into a building', async ({ page }) => {
  const clean = watchErrors(page);
  await openGame(page, 'demo-m3', '', SIM);
  await expect(page.locator('.topbar-sub')).toHaveText('2 buildings · 4 floors');
  await openMenu(page);
  const opener = page.getByRole('button', { name: 'Add floor' });
  await opener.click();
  await expect(dlg(page)).toBeVisible();
  await expect(dlg(page).getByRole('heading', { name: 'Add floor' })).toBeVisible();
  await expect(dlg(page).getByRole('radio', { name: /New herdr session/ })).toBeChecked();
  const name = dlg(page).getByLabel('Session name');
  await expect(name).toBeFocused();
  const hint = dlg(page).locator('#af-name-hint');

  // Typed wrong: said at once, and Enter sends nothing.
  await page.keyboard.type('Billing');
  await expect(name).toHaveAttribute('aria-invalid', 'true');
  await expect(hint).toHaveText('Use only lowercase letters, digits, “_” and “-”.');
  await page.keyboard.press('Enter');
  await name.fill('default');
  await expect(hint).toHaveText('“default” is herdr’s own session: pick another name.');
  await name.fill('scratchpad');
  await expect(hint).toHaveText('“scratchpad” is already a floor.');
  expect((await sent(page)).filter((c) => c.t === 'session.create')).toEqual([]);

  // herdr knows a name the game does not show: the bridge's refusal goes to the field.
  await name.fill('old-notes');
  await expect(name).toHaveAttribute('aria-invalid', 'false');
  await page.keyboard.press('Enter');
  await expect(hint).toHaveText('“old-notes” is already a herdr session (asleep): wake its floor instead.');
  await expect(name).toHaveAttribute('aria-invalid', 'true');
  await expect(name).toBeFocused();

  // A good name: progress while herdr starts it, then the floor is in the lot and the Buildings panel offers the move.
  await name.fill('billing-api');
  await page.keyboard.press('Enter');
  await expect(dlg(page).locator('[data-key="add"]')).toHaveText('Starting floor…');
  await expect(dlg(page).locator('.dd-status[role="status"]')).toHaveText('Starting a herdr server for “billing-api”…');
  await expect.poll(async () => (await addFloor(page))?.state).toBe('busy');
  await shot(page, 'h58-add-floor-starting');
  await expect(dlg(page)).toBeHidden();
  expect((await sent(page)).filter((c) => c.t === 'session.create').map((c) => c.args)).toEqual([{ name: 'old-notes' }, { name: 'billing-api' }]);
  await expect(page.locator('dialog.panel h2')).toHaveText('Buildings');
  await expect(page.locator('dialog.panel .panel-status[role="status"]')).toHaveText('Added billing-api. It is in the Unassigned lot: pick a building to move it into.');
  const lot = ((await panel(page)) as Extract<Panel, { kind: 'buildings' }>).lot;
  expect(lot).toContain('billing-api');
  expect(await focusedKey(page)).toBe(`to:billing-api:${WORK}`);
  await shot(page, 'h58-add-floor-move');
  await page.keyboard.press('Enter');
  await expect
    .poll(async () => {
      const p = (await panel(page)) as Extract<Panel, { kind: 'buildings' }> | null;
      return p?.buildings.find((b) => b.id === WORK)?.floors.includes('billing-api') ?? false;
    })
    .toBe(true);
  await expect(page.locator('.topbar-sub')).toHaveText('2 buildings · 5 floors');

  // The lot's own Add floor, over the Buildings panel: Esc closes it and gives focus back.
  const lotAdd = page.locator('dialog.panel [data-key="add-floor"]');
  await lotAdd.click();
  await expect(dlg(page)).toBeVisible();
  await expect(name).toHaveValue('');
  await expect(name).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dlg(page)).toBeHidden();
  await expect(page.locator('dialog.panel')).toBeVisible();
  await expect(lotAdd).toBeFocused();
  clean();
});

test('Add floor: herdr fails to start it, and an older bridge without session.create', async ({ page }) => {
  const clean = watchErrors(page);
  await openGame(page, 'demo-m3', '', `${SIM}&simfail=session_create_failed`);
  await openMenu(page);
  await page.getByRole('button', { name: 'Add floor' }).click();
  await dlg(page).getByLabel('Session name').fill('crash');
  await page.keyboard.press('Enter');
  await expect(dlg(page).locator('.dd-status--error[role="alert"]')).toHaveText(
    'herdr started crash, but its floor was not seen running within 10s; it was stopped and removed again.',
  );
  await expect(dlg(page).locator('[data-key="add"]')).toHaveText('Add floor');
  await expect(dlg(page).getByLabel('Session name')).toBeEnabled();
  await page.keyboard.press('Escape');

  await openGame(page, 'demo-m3', '', `${SIM}&simfail=no_sessions`);
  await openMenu(page);
  await page.getByRole('button', { name: 'Add floor' }).click();
  await dlg(page).getByLabel('Session name').fill('later');
  await page.keyboard.press('Enter');
  await expect(dlg(page).locator('.dd-callout')).toHaveText('This herdr-world can’t start new herdr sessions yet. Update the bridge to use it.');
  expect((await addFloor(page))?.off).not.toBeNull();
  clean();
});
