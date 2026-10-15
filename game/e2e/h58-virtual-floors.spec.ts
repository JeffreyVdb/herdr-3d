import { expect, test, type Page } from '@playwright/test';
import { frames, openGame, shot, watchErrors } from './game';

// #58 virtual floors, on demo-h58 and the simulating fixture server (tools/fixture-sim.ts). Work, top to bottom:
// herdr-3d, its virtual floor "Frontend" (two of its workers sit there), depot-manager (asleep) and its virtual floor
// "Depot docs" (asleep with it), pastry, and pastry's hidden virtual floor "Archive" (no workers: no list shows it).
// The client keys floors by id and shows names: a v- id never reaches the screen.

const SIM = 'play=none&sim=1&simms=150';
const WORK = 'b_3f09a1c2d4e5';
const FRONT = 'v-00000000f0e1';
const DOCS = 'v-00000000f0e2';
const ARCHIVE = 'v-00000000f0e3';

type Dialog = NonNullable<ReturnType<Window['__h3d']['dialog']>>;
type Hire = Extract<Dialog, { kind: 'hire' }>;
type Panel = NonNullable<ReturnType<Window['__h3d']['panel']>>;

const dialog = (page: Page) => page.evaluate(() => window.__h3d.dialog());
const panel = (page: Page) => page.evaluate(() => window.__h3d.panel());
const sent = (page: Page) => page.evaluate(() => window.__h3d.sent());
const world = (page: Page) => page.evaluate(() => window.__h3d.world());

/** Every text and label on screen: a virtual floor's id must be in none of them. */
async function noIdShown(page: Page, where: string): Promise<void> {
  const shown = await page.evaluate(() => {
    const parts = [document.body.innerText];
    for (const el of document.querySelectorAll('[aria-label], [title]')) parts.push(el.getAttribute('aria-label') ?? '', el.getAttribute('title') ?? '');
    return parts.join('\n');
  });
  expect(shown.match(/v-[0-9a-f]{12}/g), `a floor id on screen (${where})`).toBeNull();
}

test('a virtual floor stands in its base’s building by its name, takes a hire, and its sleep names every floor it takes down', async ({ page }) => {
  test.setTimeout(120_000);
  const clean = watchErrors(page);
  await openGame(page, 'demo-h58', '', SIM);

  // The city: Frontend in Work by its name, the hidden Archive nowhere.
  const front = page.locator(`.floor-list button[data-floor="${FRONT}"]`);
  await expect(front).toHaveText(/^Frontend: /);
  await expect(front).toHaveAttribute('data-session', 'herdr-3d');
  await expect(page.locator(`.floor-list button[data-floor="${DOCS}"]`)).toHaveText(/^Depot docs: asleep, 0 workers/);
  await expect(page.locator(`.floor-list button[data-floor="${ARCHIVE}"]`)).toHaveCount(0);
  const floors = await world(page);
  expect(floors.filter((f) => f.building === 'Work').map((f) => [f.name, f.session, f.virtual])).toEqual([
    ['pastry', 'pastry', false],
    ['Depot docs', 'depot-manager', true],
    ['depot-manager', 'depot-manager', false],
    ['Frontend', 'herdr-3d', true],
    ['herdr-3d', 'herdr-3d', false],
  ]);
  await noIdShown(page, 'city');

  // The elevator: Frontend right under herdr-3d, with its own number.
  await page.evaluate((b) => window.__h3d.openElevator(b), WORK);
  const lift = (await panel(page)) as Extract<Panel, { kind: 'elevator' }>;
  expect(lift.rows.map((r) => [r.number, r.name, r.state, r.action])).toEqual([
    [5, 'herdr-3d', 'running', 'sleep'],
    [4, 'Frontend', 'running', 'sleep'],
    [3, 'depot-manager', 'asleep', 'wake'],
    [2, 'Depot docs', 'asleep', 'wake'],
    [1, 'pastry', 'running', 'sleep'],
  ]);
  const frontRow = page.locator(`.lift-row[data-floor="${FRONT}"]`);
  await expect(frontRow.locator('.lift-session')).toHaveText('Frontend');
  await expect(frontRow.locator(`[data-key="ws:${FRONT}"]`)).toHaveText('Sleep session');
  await expect(page.locator(`.lift-row[data-floor="${DOCS}"] [data-key="ws:${DOCS}"]`)).toHaveText('Wake session');
  await noIdShown(page, 'elevator');

  // Sleeping Frontend sleeps herdr-3d's session: the confirmation lists both floors, nothing is sent before it.
  await frontRow.locator(`[data-key="ws:${FRONT}"]`).click();
  const confirm = page.locator('#confirm-title');
  await expect(confirm).toHaveText('Put herdr-3d and Frontend to sleep?');
  await expect(page.locator('#confirm-body')).toContainText('These floors share herdr session herdr-3d and all go to sleep: herdr-3d, Frontend.');
  await shot(page, 'h58-sleep-confirm');
  expect((await sent(page)).filter((c) => c.t === 'floor.sleep')).toEqual([]);
  await page.getByRole('button', { name: 'Keep running' }).click();
  await expect(confirm).toBeHidden();
  expect((await sent(page)).filter((c) => c.t === 'floor.sleep')).toEqual([]);

  // Ride to Frontend: the plate says its name; its two workers are there, not on herdr-3d.
  await frontRow.locator(`[data-key="go:${FRONT}"]`).click();
  await expect.poll(() => page.evaluate(() => window.__h3d.view().floor), { timeout: 20_000 }).toBe(FRONT);
  await frames(page, 3);
  await expect(page.locator('.topbar-name')).toHaveText('Frontend');
  const here = (await world(page)).find((f) => f.id === FRONT);
  expect(here?.workers.map((w) => w.desk)).toEqual([0, 1]);
  await noIdShown(page, 'on Frontend');

  // Hire on it: the dialog names Frontend, worker.hire names its id, the new worker lands on Frontend.
  await page.evaluate(() => window.__h3d.openHire(3));
  await expect.poll(async () => ((await dialog(page)) as Hire | null)?.state, { timeout: 10_000 }).toBe('ready');
  expect(await dialog(page)).toMatchObject({ kind: 'hire', floor: FRONT, desk: 3 });
  await expect(page.locator('#hire-sub')).toHaveText(/^Frontend · Floor 4 of 5 · Work$/);
  await noIdShown(page, 'hire dialog');
  await page.locator('dialog.desk-dlg--hire [data-key="hire"]').click();
  await expect.poll(() => dialog(page), { timeout: 15_000 }).toBeNull();
  const hire = (await sent(page)).filter((c) => c.t === 'worker.hire');
  expect(hire.map((c) => c.args)).toEqual([expect.objectContaining({ floor: FRONT, desk_index: 3 })]);
  expect(hire[0]?.args).not.toHaveProperty('session');
  await expect
    .poll(async () => (await world(page)).find((f) => f.id === FRONT)?.workers.map((w) => w.desk), { timeout: 15_000 })
    .toEqual([0, 1, 3]);
  const base = (await world(page)).find((f) => f.id === 'herdr-3d');
  expect(base?.workers.some((w) => w.desk === 3 && w.name === 'Gumdrop')).toBe(false);
  await shot(page, 'h58-hired-on-frontend');
  clean();
});

test('a virtual floor from the URL, and its Move menu only reorders it within its building', async ({ page }) => {
  const clean = watchErrors(page);
  await openGame(page, 'demo-h58', `&floor=${FRONT}`, SIM);
  await expect.poll(() => page.evaluate(() => window.__h3d.view().floor), { timeout: 20_000 }).toBe(FRONT);

  await page.evaluate(() => window.__h3d.openBuildings());
  const item = page.locator(`.dir-floor[data-floor="${FRONT}"]`);
  await expect(item.locator('.dir-fname')).toContainText('Frontend');
  await item.locator(`[data-key="move:${FRONT}"]`).click();
  const menu = item.locator('.dir-move');
  await expect(menu).toHaveAttribute('aria-label', 'Move Frontend within Work');
  await expect(menu.locator('button')).toHaveText(['Up a floor', 'Down a floor', 'Cancel']);
  await noIdShown(page, 'move menu');
  await menu.getByRole('button', { name: 'Down a floor' }).click();
  await expect.poll(async () => (await sent(page)).filter((c) => c.t === 'floor.assign').map((c) => c.args)).toEqual([{ floor: FRONT, building: WORK, index: 2 }]);
  await expect
    .poll(async () => {
      const p = (await panel(page)) as Extract<Panel, { kind: 'buildings' }> | null;
      return p?.buildings.find((b) => b.id === WORK)?.floors;
    })
    .toEqual(['herdr-3d', 'depot-manager', FRONT, DOCS, 'pastry']);
  clean();
});
