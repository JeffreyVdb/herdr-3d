import { expect, test, type Page } from '@playwright/test';
import { frames, openGame, shot, watchErrors } from './game';

// #65 (part 4 of #61): the departures boards against the fixture bridge's scheduled agents (`sim=1&simschedules=8`,
// tools/fixture-schedule.ts: schedules in every state on the first two floors). The floor's board stands on the board
// partition: E at it (from the desks' side or the elevator's) opens the schedule dialog on that floor, and a fire moves
// its rows on live. The lobby's board has a group per floor of the building: E at a group opens that floor's
// schedules, anywhere else on the board every floor's.

const SIM = 'play=none&sim=1&simms=150&simusage=0&simschedules=8';

type V3 = [number, number, number];

/** Stands `dist` m from the point `at` (in the floor's or the lobby's own frame) on the +z (`south`) or -z side and looks straight at it. */
async function aimAt(page: Page, at: V3, side: 'north' | 'south', dist = 1.6, dx = 0): Promise<void> {
  const z = side === 'south' ? at[2] + dist : at[2] - dist;
  const x = at[0] + dx;
  await page.evaluate(([x, z]) => window.__h3d.setPose({ x, z, yaw: 0, pitch: 0 }), [x, z] as const);
  const eye = (await page.evaluate(() => window.__h3d.pose()))?.eye ?? 1.55;
  // yaw 0 looks down -z (north); π looks south.
  const yaw = Math.atan2(-(at[0] - x), -(at[2] - z));
  const pitch = Math.atan2(at[1] - eye, Math.hypot(at[0] - x, at[2] - z));
  await page.evaluate(([x, z, yaw, pitch]) => window.__h3d.setPose({ x, z, yaw, pitch }), [x, z, yaw, pitch] as const);
  await frames(page, 3);
}

const dialog = (page: Page) => page.evaluate(() => window.__h3d.schedules());

test('the floor’s board shows its next departures; E at it, from either side, opens the dialog on that floor; a fire moves it on live', async ({ page }) => {
  const clean = watchErrors(page);
  await openGame(page, 'demo-m5', '', SIM);
  await page.evaluate(() => window.__h3d.enterFloor('herdr-3d'));
  await frames(page, 3);
  await expect.poll(async () => (await page.evaluate(() => window.__h3d.departures()))?.floor?.model?.rows.length ?? 0).toBeGreaterThan(0);
  // Off the elevator: the board stands over the board wall, straight ahead.
  await page.evaluate(() => window.__h3d.setPose({ ...window.__h3d.pose()!, pitch: 0.18 }));
  await frames(page, 3);
  await page.waitForTimeout(400);
  await shot(page, 'h65-floor-arrive');
  const first = (await page.evaluate(() => window.__h3d.departures()))!.floor!;
  expect(first.model?.known).toBe(true);
  expect(first.model!.rows.length).toBeLessThanOrEqual(3);
  // The seed has a failed and a skipped one on the first floor: the attention line.
  expect(first.model!.attention).toBeGreaterThan(0);
  const L = await page.evaluate(() => window.__h3d.layout('herdr-3d'));
  const b = L!.props.find((p) => p.id === 'board.departures')!.box;
  const mid: V3 = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2 + 0.1, b.min[2]];

  // From the desks (north of the partition), looking south at it.
  await aimAt(page, mid, 'north', 2.2);
  expect(await page.evaluate(() => window.__h3d.lookAt())).toMatchObject({ kind: 'board', id: 'board.departures' });
  await expect.poll(async () => (await page.evaluate(() => window.__h3d.departures()))?.floor?.share ?? 0).toBeGreaterThan(0.04);
  await page.waitForTimeout(600);
  await shot(page, 'h65-floor-board');
  await expect(page.locator('.prompt')).toContainText('Departures board');
  await page.keyboard.press('e');
  await expect(page.locator('dialog.sch')).toBeVisible();
  expect(await dialog(page)).toMatchObject({ open: true, floor: 'herdr-3d', allFloors: false });
  await page.keyboard.press('Escape');
  await expect(page.locator('dialog.sch')).toBeHidden();

  // From the elevator's side: the same board, the same scope.
  await aimAt(page, [mid[0], mid[1], b.max[2]], 'south', 2.2);
  expect(await page.evaluate(() => window.__h3d.lookAt())).toMatchObject({ kind: 'board', id: 'board.departures' });
  await shot(page, 'h65-floor-board-south');
  await page.keyboard.press('e');
  await expect(page.locator('dialog.sch')).toBeVisible();
  expect(await dialog(page)).toMatchObject({ floor: 'herdr-3d', allFloors: false });
  await page.keyboard.press('Escape');
  await expect(page.locator('dialog.sch')).toBeHidden();

  // A fire: the row departs (running), then leaves the board (done); the board follows without a reload.
  const id = first.model!.rows.find((r) => r.state === 'scheduled')?.id;
  expect(id).toBeTruthy();
  expect((await page.evaluate((id) => window.__h3d.simSchedule('sim.schedule_fire', { id }), id!)).ok).toBe(true);
  await expect.poll(async () => (await page.evaluate(() => window.__h3d.departures()))?.floor?.model?.rows.some((r) => r.id === id) ?? true, { timeout: 10_000 }).toBe(false);
  clean();
});

test('the lobby’s board: a group per floor of the building; E at a group opens that floor, elsewhere on the board every floor', async ({ page }) => {
  const clean = watchErrors(page);
  await openGame(page, 'demo-m5', '', SIM);
  await page.evaluate(() => window.__h3d.enterFloor('herdr-3d'));
  await frames(page, 3);
  await page.evaluate(() => window.__h3d.enterLobby());
  await frames(page, 3);
  expect(await page.evaluate(() => window.__h3d.view())).toMatchObject({ area: 'lobby' });
  const where = await page.evaluate(() => window.__h3d.where());
  const info = async () => (await page.evaluate(() => window.__h3d.departures()))?.lobby ?? null;
  await expect.poll(async () => (await info())?.model?.groups.length ?? 0).toBeGreaterThan(0);
  const lobby = (await info())!;
  // Only this building's floors, top floor first.
  expect(lobby.model!.groups.map((g) => g.floor)).toEqual([...(where?.floors ?? [])].reverse());
  expect(lobby.groups.map((g) => g.floor)).toEqual(lobby.model!.groups.map((g) => g.floor));
  const b = lobby.board;
  await page.waitForTimeout(400);
  await shot(page, 'h65-lobby-arrive');
  const herdr = lobby.groups.find((g) => g.floor === 'herdr-3d')!;
  const gm: V3 = [(herdr.box.min[0] + herdr.box.max[0]) / 2, (herdr.box.min[1] + herdr.box.max[1]) / 2, herdr.box.max[2]];
  await aimAt(page, gm, 'south', 2.2);
  await expect.poll(async () => (await info())?.share ?? 0).toBeGreaterThan(0.04);
  const t = await page.evaluate(() => window.__h3d.target());
  expect(t).toMatchObject({ kind: 'board', id: 'board.departures', label: 'Departures: herdr-3d' });
  await page.waitForTimeout(600);
  await shot(page, 'h65-lobby-board');
  await page.keyboard.press('e');
  await expect(page.locator('dialog.sch')).toBeVisible();
  expect(await dialog(page)).toMatchObject({ open: true, floor: 'herdr-3d', allFloors: false });
  await page.keyboard.press('Escape');
  await expect(page.locator('dialog.sch')).toBeHidden();

  // The header, above the groups: every floor's, every building's.
  const head: V3 = [(b.min[0] + b.max[0]) / 2, b.max[1] - 0.15, b.max[2]];
  await aimAt(page, head, 'south', 2.2);
  expect(await page.evaluate(() => window.__h3d.target())).toMatchObject({ kind: 'board', id: 'board.departures', label: 'Departures board' });
  await page.keyboard.press('e');
  await expect(page.locator('dialog.sch')).toBeVisible();
  expect(await dialog(page)).toMatchObject({ open: true, floor: null, allFloors: true });
  clean();
});
