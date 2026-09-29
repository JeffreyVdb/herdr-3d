import { expect, test, type Page } from '@playwright/test';
import { frames, openGame, shot, watchErrors } from './game';

// The demo-m3 fixture on the simulating fixture server (tools/fixture-sim.ts):
// Work = herdr-3d (floor 2, running: 9 working, 3 need you, 6 idle) +
// depot-manager (floor 1, asleep, 8 workers); Personal = pastry; the lot
// holds scratchpad. Commands change the simulated world like the bridge would.

const WORK = 'b_3f09a1c2d4e5';
const PERSONAL = 'b_77aa01b2c3d4';
const SIM = 'play=none&sim=1&simms=150';

type Summary = NonNullable<ReturnType<Window['__h3d']['panel']>>;

const panel = (page: Page) => page.evaluate(() => window.__h3d.panel());
const sent = (page: Page) => page.evaluate(() => window.__h3d.sent());

async function summary<K extends Summary['kind']>(page: Page, kind: K): Promise<Extract<Summary, { kind: K }>> {
  const p = await panel(page);
  if (p?.kind !== kind) throw new Error(`panel is ${p?.kind ?? 'closed'}, not ${kind}`);
  return p as Extract<Summary, { kind: K }>;
}

/** Waits for the open panel to satisfy `fn` (it follows the world live). */
async function until(page: Page, fn: (p: Summary) => boolean, what: string): Promise<void> {
  await expect.poll(async () => {
    const p = await panel(page);
    return p ? fn(p) : false;
  }, { message: what, timeout: 10_000 }).toBe(true);
}

const key = (page: Page, k: string) => page.locator(`dialog.panel [data-key="${k}"]`);

/** Puts keyboard focus on a panel control and presses Enter, as a keyboard user would after tabbing there. */
async function press(page: Page, k: string): Promise<void> {
  await key(page, k).focus();
  await page.keyboard.press('Enter');
}

async function enter(page: Page, session: string): Promise<void> {
  await page.evaluate((s) => window.__h3d.enterFloor(s), session);
  await frames(page);
}

/** Turns on the spot with the left arrow until the elevator (behind the arrival point) is in sight. */
async function faceElevator(page: Page): Promise<void> {
  await page.keyboard.down('ArrowLeft');
  try {
    await expect.poll(() => page.evaluate(() => window.__h3d.lookAt()?.id), { message: 'turned to the elevator', timeout: 10_000, intervals: [40] }).toBe('elevator');
  } finally {
    await page.keyboard.up('ArrowLeft');
  }
  await frames(page);
  expect(await page.evaluate(() => window.__h3d.lookAt())).toMatchObject({ kind: 'prop', id: 'elevator' });
}

/** What has keyboard focus: its label or text, BODY for none. */
const focused = (page: Page) =>
  page.evaluate(() => {
    const a = document.activeElement;
    return !a || a === document.body ? 'BODY' : (a.getAttribute('aria-label') ?? a.textContent?.trim() ?? '');
  });

const desks = (page: Page, session: string) =>
  page.evaluate((s) => window.__h3d.world().find((f) => f.session === s)?.workers.map((w) => [w.id, w.desk, w.name]), session);

test('buildings panel: create, rename, assign, reorder and delete (with confirmation), all from the keyboard', async ({ page }) => {
  const clean = watchErrors(page);
  await openGame(page, 'demo-m3', '', SIM);
  await expect(page.locator('.topbar-sub')).toHaveText('2 buildings · 4 floors');
  await page.keyboard.press('m');
  await expect(page.locator('dialog.panel h2')).toHaveText('Buildings');
  expect(await page.evaluate(() => document.activeElement?.id)).toBe('dir-new-name');

  // Create: the name field has focus; Enter adds the building.
  await page.keyboard.type('Lab');
  await page.keyboard.press('Enter');
  await until(page, (p) => p.kind === 'buildings' && p.buildings.some((b) => b.name === 'Lab'), 'Lab created');
  await expect(page.locator('dialog.panel .panel-status[role="status"]')).toHaveText('Added Lab. Move floors into it below.');
  const lab = (await summary(page, 'buildings')).buildings.find((b) => b.name === 'Lab')?.id ?? '';
  expect(lab).toMatch(/^b_/);
  // A taken name is caught before anything is sent.
  const before = (await sent(page)).length;
  await page.keyboard.type('work');
  await page.keyboard.press('Enter');
  await expect(page.locator('#dir-new-hint')).toHaveText('Another building is already called “Work”.');
  await expect(page.locator('#dir-new-name')).toHaveAttribute('aria-invalid', 'true');
  expect((await sent(page)).length).toBe(before);
  await page.locator('#dir-new-name').fill('');

  // Assign: scratchpad from the lot into Lab.
  await press(page, 'move:scratchpad');
  await expect(page.locator('dialog.panel .dir-move button')).toHaveText(['Work', 'Personal', 'Lab', 'Cancel']);
  expect(await page.evaluate(() => (document.activeElement as HTMLElement).dataset.key)).toBe(`to:scratchpad:${WORK}`);
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  await until(page, (p) => p.kind === 'buildings' && p.lot.length === 0, 'scratchpad left the lot');
  expect((await summary(page, 'buildings')).buildings.find((b) => b.id === lab)?.floors).toEqual(['scratchpad']);
  expect((await sent(page)).at(-1)).toMatchObject({ t: 'floor.assign', args: { session: 'scratchpad', building: lab, index: 0 }, result: { ok: true } });

  // Reorder floors within Work: herdr-3d down, and back up.
  await press(page, 'fdown:herdr-3d');
  await until(page, (p) => p.kind === 'buildings' && p.buildings[0]?.floors.join() === 'depot-manager,herdr-3d', 'herdr-3d moved down');
  expect((await sent(page)).at(-1)).toMatchObject({ t: 'floor.assign', args: { session: 'herdr-3d', building: WORK, index: 1 } });
  // Focus stays on the arrow, now at the end (disabled, still focusable).
  expect(await page.evaluate(() => (document.activeElement as HTMLElement).dataset.key)).toBe('fdown:herdr-3d');
  await expect(key(page, 'fdown:herdr-3d')).toHaveAttribute('aria-disabled', 'true');
  await press(page, 'fup:herdr-3d');
  await until(page, (p) => p.kind === 'buildings' && p.buildings[0]?.floors.join() === 'herdr-3d,depot-manager', 'herdr-3d back on top');

  // Reorder buildings: Lab up past Personal.
  await press(page, `bup:${lab}`);
  await until(page, (p) => p.kind === 'buildings' && p.buildings.map((b) => b.name).join() === 'Work,Lab,Personal', 'Lab moved up');
  expect((await sent(page)).at(-1)).toMatchObject({ t: 'building.reorder', args: { ids: [WORK, lab, PERSONAL] } });

  // Rename: Esc cancels the edit only, Enter saves.
  await press(page, `rename:${lab}`);
  await expect(page.locator('#dir-rename')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('#dir-rename')).toHaveCount(0);
  await expect(page.locator('dialog.panel')).toBeVisible();
  await expect(key(page, `rename:${lab}`)).toBeFocused();
  await page.keyboard.press('Enter');
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('Studio');
  await page.keyboard.press('Enter');
  await until(page, (p) => p.kind === 'buildings' && p.buildings.some((b) => b.name === 'Studio'), 'renamed');
  await expect(page.locator('dialog.panel .panel-status[role="status"]')).toHaveText('Renamed Lab to Studio.');
  await expect(key(page, `rename:${lab}`)).toBeFocused();
  await shot(page, 'm3-buildings');

  // Delete asks first, naming the building and the floors that go back to the lot.
  await press(page, `delete:${lab}`);
  const confirm = page.locator('dialog.confirm');
  await expect(confirm.locator('h2')).toHaveText('Delete Studio?');
  await expect(confirm.locator('p')).toHaveText('Its 1 floor (scratchpad) goes back to the unassigned lot. The herdr sessions keep running; only the building goes.');
  await expect(confirm.getByRole('button', { name: 'Keep building' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(confirm).toBeHidden();
  expect((await summary(page, 'buildings')).buildings.some((b) => b.id === lab)).toBe(true);
  expect((await sent(page)).some((c) => c.t === 'building.delete')).toBe(false);
  await press(page, `delete:${lab}`);
  await page.keyboard.press('Tab');
  await expect(confirm.getByRole('button', { name: 'Delete building' })).toBeFocused();
  await page.keyboard.press('Enter');
  await until(page, (p) => p.kind === 'buildings' && p.lot.join() === 'scratchpad' && p.buildings.length === 2, 'Studio deleted');
  await expect(page.locator('dialog.panel .panel-status[role="status"]')).toHaveText('Deleted Studio. 1 floor moved to the unassigned lot.');

  await page.keyboard.press('Escape');
  await expect(page.locator('dialog.panel')).toBeHidden();
  expect(await panel(page)).toBeNull();
  await expect(page.locator('.topbar-sub')).toHaveText('2 buildings · 4 floors');
  clean();
});

test('elevator: E at the elevator lists the building’s floors with state and counts, and rides between them', async ({ page }) => {
  const clean = watchErrors(page);
  await openGame(page, 'demo-m3', '', SIM);
  await enter(page, 'herdr-3d');
  await faceElevator(page);
  await expect(page.locator('.prompt')).toHaveAttribute('aria-label', 'Elevator · E Elevator');
  await expect(page.locator('.prompt .key').first()).not.toHaveAttribute('aria-disabled', 'true');

  // A movement key held while the panel opens does not keep walking behind it.
  const pose = await page.evaluate(() => window.__h3d.pose());
  await page.keyboard.down('KeyW');
  await page.keyboard.press('KeyE');
  await expect(page.locator('dialog.panel h2')).toHaveText('Work');
  await frames(page, 6);
  expect(await page.evaluate(() => window.__h3d.pose())).toEqual(pose);
  await page.keyboard.up('KeyW');

  const p = await summary(page, 'elevator');
  expect(p).toMatchObject({ building: WORK, title: 'Work' });
  expect(p.rows).toEqual([
    {
      session: 'herdr-3d',
      number: 2,
      state: 'running',
      transition: null,
      counts: { working: 9, needsYou: 3, idle: 6, total: 18 },
      current: true,
      action: 'sleep',
      resume: null,
    },
    {
      session: 'depot-manager',
      number: 1,
      state: 'asleep',
      transition: null,
      counts: { working: 0, needsYou: 0, idle: 0, total: 8 },
      current: false,
      action: 'wake',
      resume: null,
    },
  ]);
  await expect(page.locator('dialog.panel .lift-display')).toHaveText('2');
  const here = page.locator('.lift-go[aria-current="location"]');
  await expect(here).toHaveAttribute('aria-label', 'Floor 2, herdr-3d: 9 working, 3 need you, 6 idle. You are here.');
  await expect(here).toBeFocused();
  await expect(page.locator('.lift-row[data-session="depot-manager"] .lift-go')).toHaveAttribute('aria-label', 'Floor 1, depot-manager: asleep, 8 workers. Go there.');
  await expect(page.getByRole('button', { name: 'Wake floor depot-manager' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sleep floor herdr-3d' })).toBeVisible();
  await shot(page, 'm3-elevator');

  // Arrow down to floor 1, Enter: the doors close, the panel goes, floor 1 opens.
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('.lift-row[data-session="depot-manager"] .lift-go')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('dialog.panel')).toBeHidden();
  await page.waitForFunction(() => window.__h3d.view().floor === 'depot-manager' && !window.__h3d.view().busy);
  await expect(page.locator('.topbar-sub')).toHaveText('Floor 1 of 2 · Work · asleep');
  expect(await page.evaluate(() => window.__h3d.view().asleep)).toBe(true);
  await expect(page.locator('.hint')).toContainText('This floor is asleep');

  // And back up from floor 1's own elevator.
  await faceElevator(page);
  await page.keyboard.press('KeyE');
  await expect(page.locator('.lift-go[aria-current="location"]')).toContainText('depot-manager');
  await page.locator('.lift-row[data-session="herdr-3d"] .lift-go').click();
  await page.waitForFunction(() => window.__h3d.view().floor === 'herdr-3d' && !window.__h3d.view().busy);
  expect(await page.evaluate(() => window.__h3d.view().asleep)).toBe(false);
  // Picking the floor you are on just closes the panel.
  await page.evaluate(() => window.__h3d.openElevator());
  await page.locator('.lift-go[aria-current="location"]').click();
  await expect(page.locator('dialog.panel')).toBeHidden();
  expect(await page.evaluate(() => window.__h3d.view().floor)).toBe('herdr-3d');
  clean();
});

test('city: clicking a building opens its elevator, picking a floor goes inside; the lot has one too', async ({ page }) => {
  const clean = watchErrors(page);
  await openGame(page, 'demo-m3', '', SIM);
  await frames(page);
  const pt = await page.evaluate(() => window.__h3d.floorPoint('pastry'));
  if (!pt) throw new Error('pastry is off screen');
  await page.mouse.click(pt.x, pt.y);
  await expect(page.locator('dialog.panel h2')).toHaveText('Personal');
  const p = await summary(page, 'elevator');
  expect(p.rows.map((r) => [r.session, r.number, r.current])).toEqual([['pastry', 1, false]]);
  await expect(page.locator('dialog.panel .lift-display')).toHaveText('L');
  await page.locator('.lift-row[data-session="pastry"] .lift-go').click();
  await page.waitForFunction(() => window.__h3d.view().floor === 'pastry' && !window.__h3d.view().busy);
  await page.evaluate(() => window.__h3d.leaveFloor());
  await page.waitForFunction(() => window.__h3d.view().mode === 'city' && !window.__h3d.view().busy);

  // Keyboard: the building list reaches every building's elevator, the lot's too.
  await page.locator('.building-list button[data-building="lot"]').focus();
  await expect(page.locator('.building-list button[data-building="lot"]')).toHaveText('Unassigned lot: 1 floor. Open the elevator');
  await page.keyboard.press('Enter');
  await expect(page.locator('dialog.panel h2')).toHaveText('Unassigned lot');
  expect((await summary(page, 'elevator')).rows.map((r) => [r.session, r.number])).toEqual([['scratchpad', null]]);
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.__h3d.view().floor === 'scratchpad' && !window.__h3d.view().busy);
  await expect(page.locator('.topbar-sub')).toHaveText('Unassigned lot');
  clean();
});

test('floor settings: the suggestion is marked until saved, validation like the bridge, only changed keys are sent', async ({ page }) => {
  const clean = watchErrors(page);
  await openGame(page, 'demo-m3', '', SIM);
  await page.evaluate((b) => window.__h3d.openElevator(b), WORK);
  await page.getByRole('button', { name: 'Settings for herdr-3d' }).click();
  await expect(page.locator('dialog.panel h2')).toHaveText('Floor settings');
  await expect(page.locator('#panel-sub')).toHaveText('herdr-3d · Floor 2 of Work');
  const repo = page.locator('#set-repo');
  await expect(repo).toHaveValue('JeffreyVdb/herdr-3d');
  await expect(repo).toBeFocused();
  await expect(page.locator('label[for="set-repo"] .tape--suggested')).toHaveText('Suggested');
  await expect(page.locator('#set-repo-hint')).toHaveText('Suggested from the workers’ git remotes. Save to keep it.');
  await expect(page.locator('#set-defaultCwd')).toHaveAttribute('placeholder', '/home/dev/devel/herdr-3d');
  // The status field needs no project; the pre-filled defaults are marked as such.
  await expect(page.locator('#set-statusName')).toBeEnabled();
  await expect(page.locator('label[for="set-statusName"] .tape--default')).toHaveText('Default');
  expect(await summary(page, 'settings')).toMatchObject({ statusDefault: true, form: { statusName: 'Status', statusOptions: ['Todo', 'Doing', 'QA', 'Done'] } });

  // Invalid input is caught in the panel, nothing is sent.
  await page.locator('#set-projectOwner').fill('JeffreyVdb');
  await page.locator('#set-projectNumber').fill('three');
  await page.locator('#set-harness').selectOption('claude');
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.locator('#set-projectNumber')).toBeFocused();
  await expect(page.locator('#set-projectNumber-hint')).toHaveText('The project number is a whole number from 1.');
  await expect(page.locator('#set-model-hint')).toHaveText('Choose a model.');
  await expect(page.locator('dialog.panel .panel-status--error')).toHaveText('Fix the highlighted field to save.');
  expect((await sent(page)).filter((c) => c.t === 'floor.settings.set')).toEqual([]);

  // harness → model → effort: the effort list follows the model.
  await page.locator('#set-projectNumber').fill('3');
  await page.locator('#set-model').selectOption('claude-opus-5-5');
  expect(await page.locator('#set-effort option').allTextContents()).toEqual(['Choose an effort', 'low', 'medium', 'high', 'xhigh', 'max']);
  await page.locator('#set-effort').selectOption('xhigh');
  await shot(page, 'm3-settings');
  await page.getByRole('button', { name: 'Save settings' }).click();
  // The untouched default status field is what a floor without one uses: not sent.
  await expect(page.locator('dialog.panel .panel-status[role="status"]')).toHaveText('Saved the repo, project, default hire.');
  const set = (await sent(page)).filter((c) => c.t === 'floor.settings.set');
  expect(set).toEqual([
    {
      t: 'floor.settings.set',
      args: {
        session: 'herdr-3d',
        repo: 'JeffreyVdb/herdr-3d',
        project: { owner: 'JeffreyVdb', number: 3 },
        default_hire: { harness: 'claude', model: 'claude-opus-5-5', effort: 'xhigh' },
      },
      result: { ok: true, data: undefined },
    },
  ]);
  // Stored now: no suggestion mark; saving again sends nothing.
  await expect(page.locator('.tape--suggested')).toHaveCount(0);
  expect((await summary(page, 'settings')).repoSuggested).toBe(false);
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.locator('dialog.panel .panel-status[role="status"]')).toHaveText('Nothing changed, so nothing was saved.');
  expect((await sent(page)).filter((c) => c.t === 'floor.settings.set')).toHaveLength(1);

  // One key changed → one key sent; clearing sends null; the bridge's refusal is shown.
  await page.locator('#set-repo').fill('');
  await page.locator('#set-defaultCwd').fill('/home/missing/dir');
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.locator('dialog.panel .panel-status--error')).toHaveText('herdr-world refused it: bad args: default_cwd /home/missing/dir: no such directory');
  expect((await sent(page)).at(-1)?.args).toEqual({ session: 'herdr-3d', repo: null, default_cwd: '/home/missing/dir' });
  await page.locator('#set-defaultCwd').fill('');
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.locator('dialog.panel .panel-status[role="status"]')).toHaveText('Saved the repo.');
  expect((await sent(page)).at(-1)?.args).toEqual({ session: 'herdr-3d', repo: null });
  // The suggestion is back once nothing is stored.
  await expect(page.locator('.tape--suggested')).toHaveText('Suggested');

  // Back to the elevator it came from.
  await page.getByRole('button', { name: 'Back to the elevator' }).click();
  await expect(page.locator('dialog.panel h2')).toHaveText('Work');
  clean();
});

test('keyboard only on a floor: the top bar, L and the arrow keys reach the elevator; travel, wake, sleep and settings from it', async ({ page }) => {
  const clean = watchErrors(page);
  await openGame(page, 'demo-m3', '', SIM);
  // City: Tab along the floor list to herdr-3d, Enter goes inside.
  const on = () => page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.session ?? '');
  for (let i = 0; i < 20 && (await on()) !== 'herdr-3d'; i++) await page.keyboard.press('Tab');
  expect(await on()).toBe('herdr-3d');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.__h3d.view().floor === 'herdr-3d' && !window.__h3d.view().busy);
  // Arrival faces away from the elevator: E alone does nothing.
  expect(await page.evaluate(() => window.__h3d.lookAt()?.id)).not.toBe('elevator');
  await page.keyboard.press('KeyE');
  expect(await panel(page)).toBeNull();

  // 1. The top bar: Shift+Tab, then Tab along to Elevator.
  expect(await focused(page)).toBe('BODY');
  await page.keyboard.press('Shift+Tab');
  expect(await focused(page)).toBe('City');
  for (const want of ['Issues', 'PRs', 'Elevator']) {
    await page.keyboard.press('Tab');
    expect(await focused(page)).toBe(want);
  }
  await expect(page.locator('.hint')).toContainText('L elevator');
  await page.keyboard.press('Enter');
  await expect(page.locator('dialog.panel h2')).toHaveText('Work');
  await expect(page.locator('.lift-go[aria-current="location"]')).toBeFocused();
  // Down a floor and ride there.
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.__h3d.view().floor === 'depot-manager' && !window.__h3d.view().busy);
  await expect(page.locator('.hint')).toContainText('This floor is asleep: the elevator (L) wakes it');

  // 2. L from anywhere on the floor: wake it, put it back to sleep, open its settings.
  await page.keyboard.press('KeyL');
  const here = page.locator('.lift-go[aria-current="location"]');
  await expect(here).toContainText('depot-manager');
  await expect(here).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Wake floor depot-manager' })).toBeFocused();
  await page.keyboard.press('Enter');
  await until(page, (p) => p.kind === 'elevator' && p.rows[1]?.state === 'running' && p.rows[1].transition === null, 'depot-manager awake');
  expect(await page.evaluate(() => window.__h3d.view().asleep)).toBe(false);
  await expect(page.getByRole('button', { name: 'Sleep floor depot-manager' })).toBeFocused();
  await page.keyboard.press('Enter');
  const confirm = page.locator('dialog.confirm');
  await expect(confirm.getByRole('button', { name: 'Keep running' })).toBeFocused();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  await until(page, (p) => p.kind === 'elevator' && p.rows[1]?.state === 'asleep' && p.rows[1].transition === null, 'depot-manager asleep again');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Settings for depot-manager' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#panel-sub')).toHaveText('depot-manager · Floor 1 of Work');
  await expect(page.locator('#set-repo')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('dialog.panel')).toBeHidden();
  // The ack can land after the world event the panel waited for: poll.
  await expect.poll(async () => (await sent(page)).map((c) => [c.t, c.result?.ok])).toEqual([
    ['floor.wake', true],
    ['floor.sleep', true],
  ]);

  // Closed, the panel hands focus back to the top bar's Elevator.
  expect(await focused(page)).toBe('Elevator');
  await shot(page, 'm3-topbar-elevator');

  // 3. The arrow keys turn on the spot: face the elevator, E opens it.
  const before = await page.evaluate(() => window.__h3d.pose());
  await faceElevator(page);
  const after = await page.evaluate(() => window.__h3d.pose());
  expect(after).toMatchObject({ x: before?.x, z: before?.z });
  expect(Math.abs((after?.yaw ?? 0) - (before?.yaw ?? 0))).toBeGreaterThan(1.5);
  await expect(page.locator('.prompt')).toHaveAttribute('aria-label', 'Elevator · E Elevator');
  await page.keyboard.press('KeyE');
  await expect(page.locator('.lift-go[aria-current="location"]')).toContainText('depot-manager');
  await page.keyboard.press('Escape');
  await expect(page.locator('dialog.panel')).toBeHidden();
  clean();
});

test('floor settings: one status per row, from the keyboard; commas survive; untouched statuses are never re-sent', async ({ page }) => {
  const clean = watchErrors(page);
  await openGame(page, 'demo-m3', '', SIM);
  await page.evaluate(() => window.__h3d.openSettings('herdr-3d'));
  const statuses = async () => (await summary(page, 'settings')).form.statusOptions;
  const saved = async (msg: string) => {
    await page.getByRole('button', { name: 'Save settings' }).click();
    await expect(page.locator('dialog.panel .panel-status[role="status"]')).toHaveText(msg);
    return (await sent(page)).at(-1)?.args;
  };

  // Add a status with a comma in it: the new row takes focus.
  await press(page, 'opt-add');
  await expect(page.getByRole('textbox', { name: 'Status 5 of 5' })).toBeFocused();
  await page.keyboard.type('Review, QA');
  // Move it up twice (focus stays on the arrow), remove QA (focus goes to the next row).
  await page.keyboard.press('Tab');
  expect(await focused(page)).toBe('Move “Review, QA” up');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  expect(await focused(page)).toBe('Move “Review, QA” up');
  expect(await statuses()).toEqual(['Todo', 'Doing', 'Review, QA', 'QA', 'Done']);
  await page.getByRole('button', { name: 'Remove “QA”', exact: true }).focus();
  await page.keyboard.press('Enter');
  expect(await statuses()).toEqual(['Todo', 'Doing', 'Review, QA', 'Done']);
  await expect(page.getByRole('textbox', { name: 'Status 4 of 4' })).toBeFocused();
  await expect(page.getByRole('textbox', { name: 'Status 4 of 4' })).toHaveValue('Done');
  // No longer the defaults: the mark goes.
  await expect(page.locator('label[for="set-statusName"] .tape--default')).toBeHidden();
  await expect(page.locator('#set-statusOptions-hint')).toHaveText('In board order. Remove them all and empty the name to go back to the defaults.');
  await shot(page, 'm3-statuses');
  expect(await saved('Saved the repo, status field.')).toEqual({
    session: 'herdr-3d',
    repo: 'JeffreyVdb/herdr-3d',
    status_field: { name: 'Status', options: ['Todo', 'Doing', 'Review, QA', 'Done'] },
  });

  // Stored now, with no project: saving something else leaves the statuses alone.
  expect(await summary(page, 'settings')).toMatchObject({ statusDefault: false, form: { projectOwner: '', statusOptions: ['Todo', 'Doing', 'Review, QA', 'Done'] } });
  await page.locator('#set-defaultCwd').fill('/srv/herdr-3d');
  expect(await saved('Saved the default folder.')).toEqual({ session: 'herdr-3d', default_cwd: '/srv/herdr-3d' });
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.locator('dialog.panel .panel-status[role="status"]')).toHaveText('Nothing changed, so nothing was saved.');

  // A duplicate is caught on its own row, nothing is sent.
  const before = (await sent(page)).length;
  await press(page, 'opt-add');
  await page.keyboard.type('Todo');
  await page.getByRole('button', { name: 'Save settings' }).click();
  const dup = page.getByRole('textbox', { name: 'Status 5 of 5' });
  await expect(dup).toBeFocused();
  await expect(dup).toHaveAttribute('aria-invalid', 'true');
  await expect(page.locator('#set-statusOptions-hint')).toHaveText('“Todo” is listed twice.');
  expect((await sent(page)).length).toBe(before);
  await page.getByRole('button', { name: 'Remove “Todo”', exact: true }).last().click();
  await expect(page.locator('#set-statusOptions-hint')).not.toHaveClass(/field-error/);

  // Emptying the name and every status clears the field: the defaults are back.
  await page.locator('#set-statusName').fill('');
  for (let n = 4; n > 0; n--) await page.getByRole('button', { name: /^Remove / }).first().click();
  await expect(page.locator('.opts .dir-empty')).toHaveText('No statuses.');
  expect(await saved('Saved the status field.')).toEqual({ session: 'herdr-3d', status_field: null });
  expect(await summary(page, 'settings')).toMatchObject({ statusDefault: true, form: { statusName: 'Status', statusOptions: ['Todo', 'Doing', 'QA', 'Done'] } });
  clean();
});

test('floor settings: twin statuses that differ by a space stay apart when one is removed or moved', async ({ page }) => {
  const clean = watchErrors(page);
  await openGame(page, 'demo-m3', '', SIM);
  // Valid on the bridge, and they look the same in their inputs.
  const open = async () => {
    await page.evaluate(
      (building) =>
        window.__h3d.inject({
          t: 'floor.upsert',
          seq: 0,
          floor: {
            session: 'herdr-3d',
            state: 'running',
            default: true,
            building,
            index: 0,
            desks: 20,
            settings: { repo: 'JeffreyVdb/herdr-3d', status_field: { name: 'Status', options: [' Done', 'Done'] } },
          },
        }),
      WORK,
    );
    await page.evaluate(() => window.__h3d.openSettings('herdr-3d'));
    await expect(page.getByRole('textbox', { name: 'Status 1 of 2' })).toHaveValue(' Done');
  };
  const saved = async () => {
    await page.getByRole('button', { name: 'Save settings' }).click();
    await expect(page.locator('dialog.panel .panel-status[role="status"]')).toHaveText('Saved the status field.');
    return (await sent(page)).at(-1)?.args;
  };

  // Remove the first twin: the second stays.
  await open();
  await press(page, 'odel:0');
  expect(await saved()).toEqual({ session: 'herdr-3d', status_field: { name: 'Status', options: ['Done'] } });
  await page.keyboard.press('Escape');
  await expect(page.locator('dialog.panel')).toBeHidden();

  // Swap them: the new order is sent.
  await open();
  await press(page, 'oup:1');
  expect(await saved()).toEqual({ session: 'herdr-3d', status_field: { name: 'Status', options: ['Done', ' Done'] } });
  clean();
});

test('a live update keeps keyboard focus on the panel header (Close, Back)', async ({ page }) => {
  const clean = watchErrors(page);
  await openGame(page, 'demo-m3', '', SIM);
  const rename = (name: string) =>
    page.evaluate(
      ([id, n]) => window.__h3d.inject({ t: 'building.upsert', seq: 0, building: { id, name: n, sort: 0, floors: ['herdr-3d', 'depot-manager'] } }),
      [WORK, name] as const,
    );
  await page.evaluate((b) => window.__h3d.openElevator(b), WORK);
  await page.locator('dialog.panel .panel-close').focus();
  await rename('Work HQ');
  await expect(page.locator('dialog.panel h2')).toHaveText('Work HQ');
  await expect(page.locator('dialog.panel .panel-close')).toBeFocused();

  await page.getByRole('button', { name: 'Settings for herdr-3d' }).click();
  await page.getByRole('button', { name: 'Back to the elevator' }).focus();
  await rename('Work');
  await expect(page.locator('#panel-sub')).toHaveText('herdr-3d · Floor 2 of Work');
  await expect(page.getByRole('button', { name: 'Back to the elevator' })).toBeFocused();
  await page.locator('dialog.panel .panel-close').focus();
  await rename('Work HQ');
  await expect(page.locator('#panel-sub')).toHaveText('herdr-3d · Floor 2 of Work HQ');
  await expect(page.locator('dialog.panel .panel-close')).toBeFocused();

  await page.keyboard.press('Escape');
  await page.keyboard.press('m');
  await page.locator('dialog.panel .panel-close').focus();
  await rename('Work');
  await expect(page.locator('dialog.panel .dir-bname').first()).toHaveText('Work');
  await expect(page.locator('dialog.panel .panel-close')).toBeFocused();
  clean();
});

test('sleep asks first; the floor falls asleep and wakes up live around you, workers at their desks', async ({ page }) => {
  const clean = watchErrors(page);
  await openGame(page, 'demo-m3', '', 'play=none&sim=1&simms=350');
  await enter(page, 'herdr-3d');
  const seated = await desks(page, 'herdr-3d');
  await page.evaluate(() => window.__h3d.openElevator());

  // Cancel first: nothing is sent.
  await page.getByRole('button', { name: 'Sleep floor herdr-3d' }).click();
  const confirm = page.locator('dialog.confirm');
  await expect(confirm.locator('h2')).toHaveText('Put herdr-3d to sleep?');
  await expect(confirm.locator('p')).toHaveText(
    '9 agents are working and 3 need you right now. herdr saves and stops the session; the agents pick their conversations back up when you wake the floor.',
  );
  await confirm.getByRole('button', { name: 'Keep running' }).click();
  await expect(confirm).toBeHidden();
  expect((await sent(page)).some((c) => c.t === 'floor.sleep')).toBe(false);

  await page.getByRole('button', { name: 'Sleep floor herdr-3d' }).click();
  await shot(page, 'm3-sleep-confirm');
  await confirm.getByRole('button', { name: 'Sleep floor' }).click();
  await until(page, (p) => p.kind === 'elevator' && p.rows[0]?.transition === 'sleeping', 'sleeping shows');
  await expect(page.locator('.lift-row[data-session="herdr-3d"] .tape--sleeping')).toHaveText('Going to sleep');
  await expect(page.locator('.lift-row[data-session="herdr-3d"] .lift-progress')).toContainText('stopping herdr');
  await until(page, (p) => p.kind === 'elevator' && p.rows[0]?.state === 'asleep' && p.rows[0].transition === null, 'asleep');
  // Still on the floor, lights off, every worker at the same desk, asleep.
  expect(await page.evaluate(() => window.__h3d.view())).toMatchObject({ mode: 'floor', floor: 'herdr-3d', asleep: true });
  expect(await desks(page, 'herdr-3d')).toEqual(seated);
  expect(await page.evaluate(() => window.__h3d.world().find((f) => f.session === 'herdr-3d')?.asleep)).toBe(true);
  await expect(page.locator('dialog.panel .panel-status[role="status"]')).toHaveText('herdr-3d is asleep. Its agents resume when you wake it.');
  await expect(page.locator('.topbar-sub')).toHaveText('Floor 2 of 2 · Work · asleep');

  // Wake: the transition, then each agent's resume, then running again.
  await page.getByRole('button', { name: 'Wake floor herdr-3d' }).click();
  await until(page, (p) => p.kind === 'elevator' && p.rows[0]?.transition === 'waking' && p.rows[0].state === 'running' && (p.rows[0].resume?.confirmed ?? 0) >= 3, 'resuming');
  await expect(page.locator('.lift-row[data-session="herdr-3d"] .lift-progress p')).toContainText('Resuming agents:');
  await expect(page.locator('.lift-row[data-session="herdr-3d"] .resume--confirmed').first()).toContainText('resumed');
  await expect(page.locator('.lift-row[data-session="herdr-3d"] .resume--pending').first()).toContainText('waiting');
  await expect(page.locator('.topbar-sub')).toHaveText('Floor 2 of 2 · Work · waking up…');
  await shot(page, 'm3-wake-progress');
  await until(page, (p) => p.kind === 'elevator' && p.rows[0]?.transition === null && p.rows[0].state === 'running', 'awake');
  await expect(page.locator('dialog.panel .panel-status[role="status"]')).toHaveText(/^herdr-3d is awake: \d+ resumed, \d+ relaunched\.$/);
  expect(await page.evaluate(() => window.__h3d.view())).toMatchObject({ floor: 'herdr-3d', asleep: false });
  expect(await desks(page, 'herdr-3d')).toEqual(seated);
  const statuses = await page.evaluate(() => window.__h3d.world().find((f) => f.session === 'herdr-3d')?.workers.map((w) => w.status));
  expect(statuses?.filter((s) => s === 'working')).toHaveLength(9);
  // The ones that needed the fallback stay listed after the wake.
  await expect(page.locator('.lift-row[data-session="herdr-3d"] .lift-progress p')).toHaveText(/^Woke up: 17 of 17 agents back$/);
  await expect(page.locator('.lift-row[data-session="herdr-3d"] .resume--fallback').first()).toContainText('relaunched');
  clean();
});

test('a failed wake says why; the floor stays asleep', async ({ page }) => {
  const clean = watchErrors(page);
  await openGame(page, 'demo-m3', '', 'play=none&sim=1&simms=100&simfail=wake_failed');
  await page.evaluate((b) => window.__h3d.openElevator(b), WORK);
  await page.getByRole('button', { name: 'Wake floor depot-manager' }).click();
  await expect(page.locator('dialog.panel .panel-status--error')).toHaveText(
    'depot-manager did not wake up: herdr server for depot-manager did not answer ping within 10s (simulated).',
  );
  expect((await summary(page, 'elevator')).rows[1]).toMatchObject({ session: 'depot-manager', state: 'asleep', transition: null, action: 'wake' });
  // Closed panel: a late result becomes a HUD toast instead.
  await page.keyboard.press('Escape');
  clean();
});

test('an older bridge: the M2 world still works, the new buttons explain what is missing', async ({ page }) => {
  const clean = watchErrors(page);
  await openGame(page); // demo fixture, read-only: every command gets unknown_command
  await expect(page.locator('.topbar-sub')).toHaveText('2 buildings · 3 floors');
  await page.getByRole('button', { name: 'Buildings' }).click();
  await page.locator('#dir-new-name').fill('Lab');
  await page.keyboard.press('Enter');
  await expect(page.locator('dialog.panel .panel-status--error')).toHaveText(
    'This herdr-world can’t create buildings yet (the fixture server is read-only). Update the bridge to use it.',
  );
  await page.keyboard.press('Escape');

  await page.evaluate((b) => window.__h3d.openElevator(b), WORK);
  const rows = (await summary(page, 'elevator')).rows;
  expect(rows.map((r) => [r.session, r.state, r.transition, r.resume])).toEqual([
    ['herdr-3d', 'running', null, null],
    ['depot-manager', 'asleep', null, null],
  ]);
  const wake = page.getByRole('button', { name: 'Wake floor depot-manager' });
  await wake.click();
  await expect(page.locator('dialog.panel .panel-status--error')).toHaveText(/^This herdr-world can’t wake floors yet/);
  // From now on the button says so up front.
  await expect(wake).toHaveAttribute('aria-disabled', 'true');
  await expect(wake).toHaveAttribute('title', /can’t wake floors yet/);

  await page.getByRole('button', { name: 'Settings for herdr-3d' }).click();
  await expect(page.locator('#set-repo')).toHaveValue('');
  await expect(page.locator('.tape--suggested')).toHaveCount(0);
  await page.locator('#set-repo').fill('JeffreyVdb/herdr-3d');
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.locator('dialog.panel .panel-status--error')).toHaveText(/^This herdr-world can’t store floor settings yet/);
  await expect(page.getByRole('button', { name: 'Save settings' })).toHaveAttribute('aria-disabled', 'true');
  clean();
});
