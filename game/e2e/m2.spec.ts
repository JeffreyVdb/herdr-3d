import { expect, test, type Page } from '@playwright/test';
import { frames, openGame, shot, watchErrors } from './game';

// The demo fixture (fixtures/demo.jsonl): Work = herdr-3d (floor 2, running,
// 18 workers on 20 desks, desks 6 and 13 free) + depot-manager (floor 1,
// asleep); Personal = pastry.

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
  const badges = page.locator('.badge');
  await expect(badges).toHaveCount(3);
  const herdr = page.locator('.badge[data-session="herdr-3d"]');
  await expect(herdr).toHaveAttribute('data-state', 'running');
  await expect(herdr).toHaveAttribute('aria-label', 'herdr-3d: 9 working, 3 need you, 6 idle. Enter floor');
  await expect(page.locator('.badge[data-session="depot-manager"]')).toHaveAttribute('data-state', 'asleep');
  await shot(page, 'm2-city');
  clean();
});

test('picking a floor badge enters the floor in first person, at the entrance facing the board wall', async ({ page }) => {
  const clean = watchErrors(page);
  await openGame(page);
  await page.locator('.badge[data-session="herdr-3d"]').click();
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

test('first person: a desk row with workers, cards with task text, a free desk', async ({ page }) => {
  const clean = watchErrors(page);
  await openGame(page);
  const l = await enter(page);
  const s = l.slots[6];
  if (!s) throw new Error('slot 6');
  await page.evaluate((p) => window.__h3d.setPose(p), { x: s.seat.x + 1.2, z: s.seat.z + 2.6, yaw: 0.35, pitch: -0.12 });
  await frames(page, 4);
  expect((await page.evaluate(() => window.__h3d.cardsShown())).length).toBeGreaterThan(3);
  const cards = page.locator('.card:not([hidden])');
  await expect(cards.filter({ hasText: 'Replay buffer handles since_seq edge cases' })).toHaveCount(1);
  await expect(cards.filter({ hasText: 'Noodle' }).locator('.tape')).toHaveText('DONE');
  // A "needs you" card turns red.
  await expect(page.locator('.card[data-display="needs_you"]:not([hidden])').first()).toBeVisible();
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
  await page.evaluate((p) => window.__h3d.setPose(p), path[6]?.pose ?? l.spawn);
  await frames(page);
  await expect(page.locator('.prompt')).toHaveAttribute('aria-label', 'Desk 6 · E Hire');
  clean();
});

test('a status event from the fixture stream reaches the rendered state', async ({ page }) => {
  const clean = watchErrors(page);
  // Events every 400 ms after the snapshot: first, Nibble goes working → done.
  const ws = encodeURIComponent('/fixture/demo?play=400');
  await page.goto(`/?backend=webgl2&ws=${ws}`);
  await page.waitForFunction(() => window.__h3d?.ready, undefined, { timeout: 60_000 });
  const nibble = await page.evaluate(() => window.__h3d.world().flatMap((f) => f.workers).find((w) => w.name === 'Nibble')?.id);
  if (!nibble) throw new Error('Nibble missing');
  await page.waitForFunction((id) => window.__h3d.status(id)?.status === 'done', nibble, { timeout: 10_000 });
  // The new hire takes the lowest free desk (6) and the floor grows to 21 desks.
  await page.waitForFunction(
    () => window.__h3d.world().find((f) => f.session === 'herdr-3d')?.workers.some((w) => w.name === 'Gumdrop' && w.desk === 5),
    undefined,
    { timeout: 10_000 },
  );
  await page.waitForFunction(() => window.__h3d.world().find((f) => f.session === 'herdr-3d')?.desks === 21, undefined, { timeout: 10_000 });
  clean();
});
