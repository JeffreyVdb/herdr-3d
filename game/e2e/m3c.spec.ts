import { expect, test, type Page } from '@playwright/test';
import { frames, openGame, shot, watchErrors } from './game';

// M3c, the corner office (#20), on the demo-m3b fixture: herdr-3d is the top
// floor of Work (21 desks). Walking is real key input (W held, E, Esc);
// setPose only turns you towards the next point.

type Pose = NonNullable<ReturnType<Window['__h3d']['pose']>>;
type Layout = NonNullable<ReturnType<Window['__h3d']['layout']>>;
type Plan = NonNullable<ReturnType<Window['__h3d']['building']>>;

const FLOOR = 'herdr-3d';
const pose = (page: Page) => page.evaluate(() => window.__h3d.pose()) as Promise<Pose>;
const view = (page: Page) => page.evaluate(() => window.__h3d.view());

async function enter(page: Page): Promise<{ L: Layout; b: Plan; fy: number }> {
  await openGame(page, 'demo-m3b');
  await page.evaluate((s) => window.__h3d.enterFloor(s), FLOOR);
  await frames(page, 3);
  const L = await page.evaluate((s) => window.__h3d.layout(s), FLOOR);
  const b = await page.evaluate(() => window.__h3d.building());
  const where = await page.evaluate(() => window.__h3d.where());
  if (!L || !b || !where) throw new Error('not on the floor');
  const storey = where.floors.indexOf(FLOOR);
  return { L, b, fy: (storey + 1) * b.storey };
}

/** Turns towards (x, z) and holds W until you get there. */
async function walkTo(page: Page, x: number, z: number, what: string): Promise<Pose> {
  const p = await pose(page);
  await page.evaluate(([yy, q]) => window.__h3d.setPose({ x: q.x, z: q.z, y: q.y, yaw: yy, pitch: 0 }), [Math.atan2(-(x - p.x), -(z - p.z)), p] as const);
  const dir = [x - p.x, z - p.z] as const;
  const len = Math.hypot(...dir) || 1;
  const left = (q: Pose) => ((x - q.x) * dir[0] + (z - q.z) * dir[1]) / len;
  await page.keyboard.down('KeyW');
  try {
    await expect.poll(async () => left(await pose(page)), { message: what, timeout: 40_000, intervals: [25] }).toBeLessThan(0.12);
  } finally {
    await page.keyboard.up('KeyW');
  }
  await frames(page, 2);
  const q = await pose(page);
  expect(Math.hypot(q.x - x, q.z - z), `${what}: off the line`).toBeLessThan(0.6);
  return q;
}

/** Looks from where you stand at a point (feet-relative y is absolute). */
async function aim(page: Page, x: number, y: number, z: number): Promise<void> {
  const p = await pose(page);
  const eyeY = p.y + p.eye;
  const yaw = Math.atan2(-(x - p.x), -(z - p.z));
  const pitch = Math.atan2(y - eyeY, Math.hypot(x - p.x, z - p.z));
  await page.evaluate(([yy, pp, q]) => window.__h3d.setPose({ x: q.x, z: q.z, y: q.y, yaw: yy, pitch: pp }), [yaw, pitch, p] as const);
  await frames(page, 2);
}

test('walks from the elevator up the stair into the corner office, sits at your desk and gets up', async ({ page }) => {
  const clean = watchErrors(page);
  const { L, fy } = await enter(page);
  const m = L.mezzanine;
  const sx = (m.stair.x0 + m.stair.x1) / 2;
  expect((await pose(page)).y).toBeCloseTo(fy, 3);

  // Out of the elevator, east across the lobby strip, north to the foot of the stair, and up it.
  await walkTo(page, L.spawn.x, L.depth - 2.6, 'out of the elevator');
  await walkTo(page, sx, L.depth - 2.6, 'east along the board wall');
  await walkTo(page, sx, m.stair.bottom + 0.4, 'to the foot of the stair');
  const mid = await walkTo(page, sx, (m.stair.top + m.stair.bottom) / 2, 'half way up');
  expect(mid.y - fy).toBeGreaterThan(1);
  expect(mid.y - fy).toBeLessThan(2);
  const top = await walkTo(page, sx, m.rect.z1 - 0.7, 'through the glass door');
  expect(top.y).toBeCloseTo(fy + m.y, 3);
  expect(top.area).toBe('floor');
  expect(await view(page)).toMatchObject({ floor: FLOOR, overlook: true, seated: false });

  // To your desk: looking at it is your desk (not a worker desk), E sits you down facing the floor.
  await walkTo(page, m.rect.x0 + 1, m.desk.desk.z - 1.1, 'into the office');
  await walkTo(page, m.desk.seat.x, m.desk.seat.z - 0.6, 'to your desk');
  await aim(page, m.desk.desk.x, fy + m.y + 0.7, m.desk.desk.z);
  expect(await page.evaluate(() => window.__h3d.lookAt())).toMatchObject({ kind: 'own-desk', id: 'own-desk', name: 'You' });
  await expect(page.locator('.prompt')).toContainText('Your desk');
  await page.keyboard.press('KeyE');
  await frames(page, 4);
  const sat = await pose(page);
  expect(sat.seated).toBe(true);
  expect(sat.x).toBeCloseTo(m.sit.x, 3);
  expect(sat.z).toBeCloseTo(m.sit.z, 3);
  expect(sat.yaw).toBeCloseTo(m.sit.yaw, 3);
  expect((await view(page)).seated).toBe(true);
  await expect(page.locator('.hint')).toContainText('At your desk');
  // Every desk of the floor's cards show from up here.
  await frames(page, 6);
  const cards = await page.evaluate(() => window.__h3d.cards());
  const workers = (await page.evaluate(() => window.__h3d.world())).find((f) => f.session === 'herdr-3d')!.workers.length;
  console.log(`m3c: ${cards.length} cards of ${workers} workers from your desk`);
  expect(cards.length).toBeGreaterThanOrEqual(Math.min(workers, 8));
  await shot(page, 'm3c-desk-view');

  // Esc gets you up; so does walking.
  await page.keyboard.press('Escape');
  await frames(page, 2);
  expect((await pose(page)).seated).toBe(false);
  await aim(page, m.desk.desk.x, fy + m.y + 0.7, m.desk.desk.z);
  await page.keyboard.press('KeyE');
  await frames(page, 2);
  expect((await pose(page)).seated).toBe(true);
  await page.keyboard.down('KeyS');
  await page.waitForTimeout(250);
  await page.keyboard.up('KeyS');
  await frames(page, 2);
  const up = await pose(page);
  expect(up.seated).toBe(false);
  expect(up.y).toBeCloseTo(fy + m.y, 3);
  clean();
});

test('from the glass, look-at reaches a worker at a desk below; the plan shows the corner office', async ({ page }) => {
  const clean = watchErrors(page);
  const { L, fy } = await enter(page);
  const m = L.mezzanine;
  const world = await page.evaluate(() => window.__h3d.world());
  const floor = world.find((f) => f.session === FLOOR)!;
  // At the west glass, inside the office.
  const at = { x: m.rect.x0 + 0.45, z: 2.6 };
  await page.evaluate(([q, y]) => window.__h3d.setPose({ x: q.x, z: q.z, y, yaw: Math.PI / 2, pitch: -0.3 }), [at, fy + m.y] as const);
  await frames(page, 2);
  expect(await view(page)).toMatchObject({ overlook: true, area: 'floor' });
  // A worker at a desk out past the glass, more than 3 m away.
  const seated = floor.workers
    .map((w) => ({ w, s: L.slots[w.desk]! }))
    .filter(({ s }) => s.seat.x < m.rect.x0 - 1 || s.seat.z > m.rect.z1 + 1)
    .sort((a, b) => Math.hypot(a.s.seat.x - at.x, a.s.seat.z - at.z) - Math.hypot(b.s.seat.x - at.x, b.s.seat.z - at.z));
  const target = seated[0]!;
  expect(Math.hypot(target.s.seat.x - at.x, target.s.seat.z - at.z)).toBeGreaterThan(3);
  await aim(page, target.s.seat.x, fy + 0.9, target.s.seat.z);
  expect(await page.evaluate(() => window.__h3d.lookAt())).toMatchObject({ kind: 'worker', id: target.w.id, name: target.w.name });
  await expect(page.locator('.prompt')).toContainText(target.w.name);
  // The same aim from down on the floor, at that distance, reaches nothing (3 m).
  await page.evaluate(([q, y]) => window.__h3d.setPose({ x: q.x, z: q.z, y, yaw: 0 }), [at, fy] as const);
  await aim(page, target.s.seat.x, fy + 0.9, target.s.seat.z);
  if (Math.hypot(target.s.seat.x - at.x, target.s.seat.z - at.z) > 3.5) expect((await page.evaluate(() => window.__h3d.lookAt()))?.id).not.toBe(target.w.id);

  // The mezzanine seen from the floor: from the aisle in front of the board wall, looking up at it.
  await page.evaluate(([q, y]) => window.__h3d.setPose({ x: q.x, z: q.z, y, yaw: 0, pitch: 0 }), [{ x: m.rect.x0 - 1.2, z: L.boardWall.z0 - 0.8 }, fy] as const);
  await aim(page, m.rect.x0 + 3.4, fy + 3.2, m.rect.z0 + 2);
  await frames(page, 4);
  await shot(page, 'm3c-mezzanine');

  // The floor plan shows the mezzanine, the stair and your desk.
  await page.evaluate(() => window.__h3d.plan(true));
  await frames(page, 4);
  for (const label of ['Corner office (mezzanine)', 'Stair', 'Your desk']) await expect(page.locator('.plan-label', { hasText: label })).toHaveCount(1);
  await shot(page, 'm3c-plan');
  clean();
});

test('a 96-desk floor that all needs you: from up there the far desks answer and every card shows', async ({ page }) => {
  const clean = watchErrors(page);
  const F = 'perf-floor96';
  await openGame(page, F);
  await page.evaluate((s) => window.__h3d.enterFloor(s), F);
  await frames(page, 3);
  const L = (await page.evaluate((s) => window.__h3d.layout(s), F))!;
  const b = (await page.evaluate(() => window.__h3d.building()))!;
  const where = (await page.evaluate(() => window.__h3d.where()))!;
  const fy = (where.floors.indexOf(F) + 1) * b.storey;
  const m = L.mezzanine;
  const workers = (await page.evaluate(() => window.__h3d.world())).find((f) => f.session === F)!.workers;
  expect(workers).toHaveLength(96);

  // At the west glass: the farthest worker of the floor, well past 20 m, answers look-at.
  const at = { x: m.rect.x0 + 0.45, z: (m.rect.z0 + m.rect.z1) / 2 };
  await page.evaluate(([q, y]) => window.__h3d.setPose({ x: q.x, z: q.z, y, yaw: Math.PI / 2, pitch: -0.3 }), [at, fy + m.y] as const);
  await frames(page, 2);
  expect(await view(page)).toMatchObject({ overlook: true, area: 'floor' });
  const far = workers
    .map((w) => ({ w, s: L.slots[w.desk]! }))
    .sort((p, q) => Math.hypot(q.s.seat.x - at.x, q.s.seat.z - at.z) - Math.hypot(p.s.seat.x - at.x, p.s.seat.z - at.z))[0]!;
  expect(Math.hypot(far.s.seat.x - at.x, fy + 1 - (fy + m.y + 1.55), far.s.seat.z - at.z)).toBeGreaterThan(20);
  await aim(page, far.s.seat.x, fy + 1.3, far.s.seat.z);
  expect(await page.evaluate(() => window.__h3d.lookAt())).toMatchObject({ kind: 'worker', id: far.w.id });

  // Seated at your desk: every "needs you" card in front of you shows, far more than the floor's 24.
  await page.evaluate(([q, y]) => window.__h3d.setPose({ x: q.sit.x, z: q.sit.z, y, yaw: q.sit.yaw, pitch: q.sit.pitch }), [m, fy + m.y] as const);
  expect(await page.evaluate(() => window.__h3d.sit())).toBe(true);
  await frames(page, 6);
  const up = await page.evaluate(() => window.__h3d.cards());
  console.log(`m3c: ${up.length} cards of ${workers.length} workers needing you, from your desk`);
  expect(up.length).toBeGreaterThanOrEqual(90);
  expect(up.every((c) => c.display === 'needs_you')).toBe(true);
  await shot(page, 'm3c-desk-96');

  // Back down on the floor the cap stays.
  await page.keyboard.press('Escape');
  const row = L.slots.reduce((p, s) => Math.max(p, s.seat.z), 0) + 1.1;
  await page.evaluate(([x, z, y]) => window.__h3d.setPose({ x, z, y, yaw: 0, pitch: -0.2 }), [L.width / 2, row, fy] as const);
  await frames(page, 6);
  expect(await view(page)).toMatchObject({ overlook: false });
  expect((await page.evaluate(() => window.__h3d.cards())).length).toBeLessThanOrEqual(24);
  clean();
});
