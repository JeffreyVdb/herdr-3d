import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { frames, openGame, shot, watchErrors } from './game';

// The demo fixture (fixtures/demo.jsonl): Work = herdr-3d (floor 2, running,
// 18 workers on 20 desks, desks 6 and 13 free) + depot-manager (floor 1,
// asleep); Personal = pastry.

/**
 * The fixture's recorded events, in order: Nibble working → done, Tater
 * blocked → working, Gumdrop hired at desk 6, herdr-3d grows to 21 desks, …
 */
const [SNAPSHOT, ...EVENTS] = readFileSync(resolve(import.meta.dirname, '../fixtures/demo.jsonl'), 'utf8')
  .split('\n')
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l) as { t: string; seq: number; id?: string; world?: { workers: Array<{ name?: string }> } });
const [NIBBLE_DONE, TATER_WORKING, GUMDROP_HIRED, DESKS_21] = EVENTS;

type Layout = NonNullable<ReturnType<Window['__h3d']['layout']>>;

async function layout(page: Page, session: string): Promise<Layout> {
  const l = await page.evaluate((s) => window.__h3d.layout(s), session);
  if (!l) throw new Error(`no layout for ${session}`);
  return l;
}

async function enter(page: Page, session = 'herdr-3d'): Promise<Layout> {
  await page.evaluate((s) => window.__h3d.enterFloor(s), session);
  await frames(page);
  return layout(page, session);
}

/** yaw that looks from (x, z) towards (tx, tz); yaw 0 looks north (-z). */
const yawTo = (x: number, z: number, tx: number, tz: number) => Math.atan2(-(tx - x), -(tz - z));

test('city view: buildings, floors stacked, a badge per floor', async ({ page }) => {
  const clean = watchErrors(page);
  await openGame(page);
  await expect(page.locator('.topbar-sub')).toHaveText('2 buildings · 3 floors');
  // Badges are drawn in the scene; the floor list mirrors them for keyboards and screen readers.
  const floors = page.locator('.floor-list button');
  await expect(floors).toHaveCount(3);
  const herdr = page.locator('.floor-list button[data-session="herdr-3d"]');
  await expect(herdr).toHaveAttribute('data-state', 'running');
  await expect(herdr).toHaveText('herdr-3d: 9 working, 3 need you, 6 idle. Enter floor');
  await expect(page.locator('.floor-list button[data-session="depot-manager"]')).toHaveText('depot-manager: asleep, 8 workers. Enter floor');
  for (const s of ['herdr-3d', 'depot-manager', 'pastry']) expect(await page.evaluate((x) => window.__h3d.badgePoint(x), s), s).not.toBeNull();
  await shot(page, 'm2-city');
  clean();
});

test('picking a floor badge enters the floor in first person, at the entrance facing the board wall', async ({ page }) => {
  const clean = watchErrors(page);
  await openGame(page);
  await frames(page);
  const badge = await page.evaluate(() => window.__h3d.badgePoint('herdr-3d'));
  if (!badge) throw new Error('no badge on screen');
  await page.mouse.click(badge.x, badge.y);
  await page.waitForFunction(() => window.__h3d.view().mode === 'floor' && !window.__h3d.view().busy);
  await expect(page.locator('.topbar-name')).toHaveText('herdr-3d');
  await expect(page.locator('.topbar-sub')).toHaveText('Floor 2 of 2 · Work');
  const l = await layout(page, 'herdr-3d');
  const pose = await page.evaluate(() => window.__h3d.pose());
  expect(pose).toMatchObject({ x: l.spawn.x, z: l.spawn.z, yaw: l.spawn.yaw });
  expect(await page.evaluate(() => window.__h3d.lookAt())).toMatchObject({ kind: 'board', id: 'board.prs' });

  // Tab toggles the floor plan; Backspace goes back to the city.
  await page.keyboard.press('Tab');
  expect(await page.evaluate(() => window.__h3d.view().plan)).toBe(true);
  await page.keyboard.press('Tab');
  expect(await page.evaluate(() => window.__h3d.view().plan)).toBe(false);
  await page.keyboard.press('Backspace');
  await page.waitForFunction(() => window.__h3d.view().mode === 'city' && !window.__h3d.view().busy);

  // Keyboard: the floor list enters a floor too.
  await page.locator('.floor-list button[data-session="pastry"]').focus();
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.__h3d.view().floor === 'pastry' && !window.__h3d.view().busy);
  await expect(page.locator('.topbar-sub')).toHaveText('Floor 1 of 1 · Personal');
  clean();
});

test('keyboard on a floor: Shift+Tab reaches the top bar, Tab there moves focus, Issues opens', async ({ page }) => {
  const clean = watchErrors(page);
  await openGame(page);
  await page.locator('.floor-list button[data-session="herdr-3d"]').focus();
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.__h3d.view().floor === 'herdr-3d' && !window.__h3d.view().busy);
  const focused = () =>
    page.evaluate(() => {
      const a = document.activeElement;
      return !a || a === document.body ? 'BODY' : (a.getAttribute('aria-label') ?? a.textContent?.trim());
    });
  const plan = () => page.evaluate(() => window.__h3d.view().plan);
  expect(await focused()).toBe('BODY');
  await page.keyboard.press('Shift+Tab');
  expect(await focused()).toBe('City');
  // Inside the top bar Tab / Shift+Tab traverse it natively and leave the plan alone.
  await page.keyboard.press('Tab');
  expect(await focused()).toBe('Issues');
  await page.keyboard.press('Tab');
  expect(await focused()).toBe('PRs');
  await page.keyboard.press('Shift+Tab');
  expect(await focused()).toBe('Issues');
  expect(await plan()).toBe(false);
  await page.keyboard.press('Enter');
  await expect(page.locator('dialog.sheet h2')).toHaveText('Issues · herdr-3d');
  await page.keyboard.press('Escape');
  await expect(page.locator('dialog.sheet')).toBeHidden();
  // Back on the scene, plain Tab toggles the plan again.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('Tab');
  expect(await plan()).toBe(true);
  clean();
});

test('without pointer lock, clicking into the floor falls back to the floor plan', async ({ page }) => {
  await openGame(page);
  await enter(page);
  await page.mouse.click(640, 360);
  await page.waitForFunction(() => window.__h3d.view().plan || document.pointerLockElement !== null, undefined, { timeout: 5000 });
  const locked = await page.evaluate(() => document.pointerLockElement !== null);
  if (!locked) await expect(page.locator('.plan')).toBeVisible();
});

test('floor plan (Tab): desks, free desks with +, labelled placeholders', async ({ page }) => {
  const clean = watchErrors(page);
  await openGame(page);
  await enter(page);
  await page.keyboard.press('Tab');
  await frames(page);
  await expect(page.locator('.plan-label--desk')).toHaveText(['+ 6', '+ 13']);
  await expect(page.locator('.plan-label--worker')).toHaveCount(18);
  await expect(page.locator('.plan-label--prop')).toHaveText([
    'Issues board',
    'Pull requests board',
    'Services board',
    'Whiteboard',
    'Screen-share TV',
    'Filing cabinet',
    'Lounge',
    'Drop Zone inbox',
    'Elevator',
  ]);
  await shot(page, 'm2-floor-plan');
  clean();
});

/** The status dot of a worker's floor-plan label (its CSS colour variable). */
const planDot = (page: Page, name: string) => page.locator('.plan-label--worker').filter({ hasText: new RegExp(`^${name}$`) }).locator('i');

test('the open floor plan follows live status and seat changes while nothing moves', async ({ page }) => {
  const clean = watchErrors(page);
  await openGame(page);
  await enter(page);
  await page.evaluate(() => window.__h3d.plan(true));
  await frames(page);
  await expect(planDot(page, 'Nibble')).toHaveAttribute('style', /var\(--working\)/);
  await expect(planDot(page, 'Tater')).toHaveAttribute('style', /var\(--needs_you\)/);
  const pose = await page.evaluate(() => window.__h3d.pose());

  await page.evaluate((e) => window.__h3d.inject(e as never), NIBBLE_DONE);
  await expect(planDot(page, 'Nibble')).toHaveAttribute('style', /var\(--done\)/);
  await page.evaluate((e) => window.__h3d.inject(e as never), TATER_WORKING);
  await expect(planDot(page, 'Tater')).toHaveAttribute('style', /var\(--working\)/);
  // A new hire takes free desk 6 in place (same desk count)…
  await page.evaluate((e) => window.__h3d.inject(e as never), GUMDROP_HIRED);
  await expect(page.locator('.plan-label--desk')).toHaveText(['+ 13']);
  await expect(planDot(page, 'Gumdrop')).toHaveAttribute('style', /var\(--working\)/);
  // …and a bigger floor rebuilds the office with one more free desk.
  await page.evaluate((e) => window.__h3d.inject(e as never), DESKS_21);
  await expect(page.locator('.plan-label--desk')).toHaveText(['+ 13', '+ 21']);
  expect(await page.evaluate(() => window.__h3d.pose())).toEqual(pose);
  clean();
});

test('events during the elevator ride reach the office that opens after it', async ({ page }) => {
  const clean = watchErrors(page);
  await openGame(page);
  const nibble = NIBBLE_DONE?.id;
  await page.evaluate(
    ([done, hire]) => {
      // The floor list enters through the elevator doors; the bridge speaks while they are shut.
      document.querySelector<HTMLButtonElement>('.floor-list button[data-session="herdr-3d"]')?.click();
      if (!window.__h3d.view().busy) throw new Error('no door transition');
      window.__h3d.inject(done as never);
      window.__h3d.inject(hire as never);
    },
    [NIBBLE_DONE, GUMDROP_HIRED],
  );
  await page.waitForFunction(() => window.__h3d.view().mode === 'floor' && !window.__h3d.view().busy);
  await frames(page);
  expect(await page.evaluate((id) => window.__h3d.status(id ?? '')?.status, nibble)).toBe('done');
  await page.evaluate(() => window.__h3d.plan(true));
  await expect(planDot(page, 'Nibble')).toHaveAttribute('style', /var\(--done\)/);
  await expect(page.locator('.plan-label--desk')).toHaveText(['+ 13']);
  await expect(planDot(page, 'Gumdrop')).toHaveCount(1);
  clean();
});

test('a movement key held when leaving the floor does not keep walking', async ({ page }) => {
  const clean = watchErrors(page);
  await openGame(page);
  const still = async () => {
    const p = await page.evaluate(() => window.__h3d.pose());
    await frames(page, 10);
    expect(await page.evaluate(() => window.__h3d.pose())).toEqual(p);
  };
  // Pressed on the floor, released in the city.
  await enter(page);
  await page.keyboard.down('KeyW');
  await frames(page, 2);
  await page.evaluate(() => window.__h3d.leaveFloor());
  await page.keyboard.up('KeyW');
  await enter(page);
  await still();
  // Still held after coming back: leaving forgot it.
  await page.keyboard.down('ArrowUp');
  await frames(page, 2);
  await page.evaluate(() => window.__h3d.leaveFloor());
  await enter(page);
  await still();
  await page.keyboard.up('ArrowUp');
  clean();
});

test('first person: a desk row with workers, cards with task text, a free desk', async ({ page }) => {
  const clean = watchErrors(page);
  await openGame(page);
  const l = await enter(page);
  const s = l.slots[6];
  if (!s) throw new Error('slot 6');
  await page.evaluate((p) => window.__h3d.setPose(p), { x: s.seat.x + 1.2, z: s.seat.z + 2.6, yaw: 0.35, pitch: -0.12 });
  await frames(page, 4);
  const cards = await page.evaluate(() => window.__h3d.cards());
  expect(cards.length).toBeGreaterThan(3);
  expect(cards).toContainEqual(expect.objectContaining({ name: 'Noodle', display: 'done', task: 'Replay buffer handles since_seq edge cases' }));
  // A "needs you" card (drawn red) is among them.
  expect(cards.some((c) => c.display === 'needs_you')).toBe(true);
  await shot(page, 'm2-desk-row');
  clean();
});

test('look-at HUD picks the right thing along a scripted camera path', async ({ page }) => {
  const clean = watchErrors(page);
  await openGame(page);
  const l = await enter(page);
  const world = await page.evaluate(() => window.__h3d.world());
  const floor = world.find((f) => f.session === 'herdr-3d');
  const mochi = floor?.workers.find((w) => w.name === 'Mochi');
  if (!mochi) throw new Error('Mochi missing');
  const seat = l.slots[mochi.desk];
  const free = l.slots[5];
  const cabinet = l.props.find((p) => p.id === 'filing');
  const issues = l.props.find((p) => p.id === 'board.issues');
  if (!seat || !free || !cabinet || !issues) throw new Error('layout incomplete');
  expect(seat.yaw).toBeCloseTo(Math.PI); // a south-row seat: approach from the south

  const ix = (issues.box.min[0] + issues.box.max[0]) / 2;
  const cz = (cabinet.box.min[2] + cabinet.box.max[2]) / 2;
  const path: Array<{ what: string; pose: { x: number; z: number; yaw: number; pitch: number }; want: Record<string, unknown> | null }> = [
    { what: 'arrival: PRs board', pose: { ...l.spawn, pitch: -0.05 }, want: { kind: 'board', id: 'board.prs', label: 'Pull requests board' } },
    { what: 'Issues board', pose: { x: ix, z: l.spawn.z, yaw: 0, pitch: 0 }, want: { kind: 'board', id: 'board.issues' } },
    { what: 'ceiling: nothing', pose: { ...l.spawn, pitch: 1.2 }, want: null },
    {
      what: 'worker Mochi',
      pose: { x: seat.seat.x, z: seat.seat.z + 1.5, yaw: 0, pitch: -0.41 },
      want: { kind: 'worker', id: mochi.id, name: 'Mochi', label: 'CODE|m2-game|3|r1' },
    },
    // From the side (west, over open floor): in reach at 2.4 m, out of reach at 3.6 m.
    {
      what: 'Mochi from the side',
      pose: { x: seat.seat.x - 2.4, z: seat.seat.z, yaw: -Math.PI / 2, pitch: -0.265 },
      want: { kind: 'worker', name: 'Mochi' },
    },
    { what: 'Mochi out of reach', pose: { x: seat.seat.x - 3.6, z: seat.seat.z, yaw: -Math.PI / 2, pitch: -0.18 }, want: null },
    {
      what: 'free desk 6',
      pose: { x: free.seat.x, z: free.seat.z - 0.3, yaw: Math.PI, pitch: -0.68 },
      want: { kind: 'desk', id: 'desk-5', label: 'Desk 6' },
    },
    {
      what: 'filing cabinet',
      pose: { x: cabinet.box.min[0] - 1.5, z: cz, yaw: yawTo(cabinet.box.min[0] - 1.5, cz, cabinet.box.min[0], cz), pitch: -0.3 },
      want: { kind: 'prop', id: 'filing', label: 'Filing cabinet' },
    },
  ];
  for (const w of path) {
    await page.evaluate((p) => window.__h3d.setPose(p), w.pose);
    const got = await page.evaluate(() => window.__h3d.lookAt());
    if (w.want === null) expect(got, w.what).toBeNull();
    else expect(got, w.what).toMatchObject(w.want);
  }

  // The prompt bar follows the look-at target once a frame renders.
  await page.evaluate((p) => window.__h3d.setPose(p), path[3]?.pose ?? l.spawn);
  await frames(page);
  await expect(page.locator('.prompt')).toHaveAttribute('aria-label', 'Mochi · working · Wire the look-at HUD to the prompt bar · claude opus-5-5 high');
  await expect(page.locator('.prompt .key[aria-disabled="true"]')).toHaveText(['ELaptop', 'CChanges', 'PPrompt', 'HHandoff', 'XSend home']);
  // An upsert that only changes the effort still redraws the prompt.
  const mochiWorker = SNAPSHOT?.world?.workers.find((w) => w.name === 'Mochi');
  await page.evaluate((w) => window.__h3d.inject({ t: 'worker.upsert', seq: 5000, worker: { ...w, effort: 'low' } } as never), mochiWorker);
  await expect(page.locator('.prompt')).toHaveAttribute('aria-label', 'Mochi · working · Wire the look-at HUD to the prompt bar · claude opus-5-5 low');
  await page.evaluate((p) => window.__h3d.setPose(p), path[6]?.pose ?? l.spawn);
  await frames(page);
  await expect(page.locator('.prompt')).toHaveAttribute('aria-label', 'Desk 6 · E Hire');
  clean();
});

test('a status event from the fixture stream reaches the rendered state', async ({ page }) => {
  const clean = watchErrors(page);
  // Events every 400 ms after the snapshot: first, Nibble goes working → done.
  const ws = encodeURIComponent('/fixture/demo?play=400');
  await page.goto(`/?backend=webgl2&ws=${ws}&floor=herdr-3d&plan=1`);
  await page.waitForFunction(() => window.__h3d?.ready, undefined, { timeout: 60_000 });
  const nibble = await page.evaluate(() => window.__h3d.world().flatMap((f) => f.workers).find((w) => w.name === 'Nibble')?.id);
  if (!nibble) throw new Error('Nibble missing');
  await page.waitForFunction((id) => window.__h3d.status(id)?.status === 'done', nibble, { timeout: 10_000 });
  await expect(planDot(page, 'Nibble')).toHaveAttribute('style', /var\(--done\)/);
  // The new hire takes the lowest free desk (6) and the floor grows to 21 desks.
  await page.waitForFunction(
    () => window.__h3d.world().find((f) => f.session === 'herdr-3d')?.workers.some((w) => w.name === 'Gumdrop' && w.desk === 5),
    undefined,
    { timeout: 10_000 },
  );
  await page.waitForFunction(() => window.__h3d.world().find((f) => f.session === 'herdr-3d')?.desks === 21, undefined, { timeout: 10_000 });
  clean();
});
