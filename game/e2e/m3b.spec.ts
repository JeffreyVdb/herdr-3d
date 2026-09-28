import { expect, test, type Page } from '@playwright/test';
import { frames, openGame, shot, watchErrors } from './game';

// The demo-m3b fixture: Work holds three floors, herdr-3d on top (running,
// 21 desks), depot-manager in the middle (asleep, 10 desks) and pastry at the
// bottom (running, 16 desks), one outline for all three. Walking is real key
// input (W, held); setPose only turns you towards the next corner, or
// shortcuts to the start of a walk.

type Pose = NonNullable<ReturnType<Window['__h3d']['pose']>>;
type Plan = NonNullable<ReturnType<Window['__h3d']['building']>>;

const pose = (page: Page) => page.evaluate(() => window.__h3d.pose()) as Promise<Pose>;
const plan = async (page: Page): Promise<Plan> => {
  const b = await page.evaluate(() => window.__h3d.building());
  if (!b) throw new Error('not in a building');
  return b;
};
const floorY = (b: Plan, storey: number) => (storey + 1) * b.storey;

/** Turns towards (x, z) and holds W until you get there (or stop getting closer). */
async function walkTo(page: Page, x: number, z: number, what: string): Promise<Pose> {
  const p = await pose(page);
  const yaw = Math.atan2(-(x - p.x), -(z - p.z));
  await page.evaluate(([yy, q]) => window.__h3d.setPose({ x: q.x, z: q.z, y: q.y, yaw: yy, pitch: 0 }), [yaw, p] as const);
  const dir = [x - p.x, z - p.z];
  const len = Math.hypot(dir[0] as number, dir[1] as number) || 1;
  // Distance still to go along the line (negative once past the target).
  const left = (q: Pose) => ((x - q.x) * (dir[0] as number) + (z - q.z) * (dir[1] as number)) / len;
  await page.keyboard.down('KeyW');
  try {
    await expect.poll(async () => left(await pose(page)), { message: what, timeout: 30_000, intervals: [25] }).toBeLessThan(0.12);
  } finally {
    await page.keyboard.up('KeyW');
  }
  await frames(page, 2);
  const q = await pose(page);
  expect(Math.hypot(q.x - x, q.z - z), `${what}: off the line`).toBeLessThan(0.6);
  return q;
}

/** Holds W for `ms` towards (x, z): for walking into something. */
async function push(page: Page, x: number, z: number, ms: number): Promise<Pose> {
  const p = await pose(page);
  await page.evaluate(([yy, q]) => window.__h3d.setPose({ x: q.x, z: q.z, y: q.y, yaw: yy, pitch: 0 }), [Math.atan2(-(x - p.x), -(z - p.z)), p] as const);
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(ms);
  await page.keyboard.up('KeyW');
  await frames(page, 2);
  return pose(page);
}

const topbar = async (page: Page) => ({
  name: await page.locator('.topbar-name').textContent(),
  sub: await page.locator('.topbar-sub').textContent(),
});

/** Down one storey of the fire escape: across the landing, flight 1, the half landing, flight 2. */
async function downOne(page: Page, b: Plan, what: string): Promise<void> {
  const e = b.escape;
  const xi = (e.inner.x0 + e.inner.x1) / 2;
  const xo = (e.outer.x0 + e.outer.x1) / 2;
  const half = (e.half.z0 + e.half.z1) / 2;
  const top = (await pose(page)).y;
  await walkTo(page, xo, e.landing.z0 + 0.3, `${what}: to the flight down`);
  const h = await walkTo(page, xo, half, `${what}: down flight 1`);
  expect(h.y).toBeCloseTo(top - b.storey / 2, 3);
  expect(h).toMatchObject({ area: 'fire-escape', storey: null });
  await walkTo(page, xi, half, `${what}: round the half landing`);
  await walkTo(page, xi, (e.door.z0 + e.door.z1) / 2, `${what}: down flight 2`);
}

test('fire escape: out of the top floor, in and out of the middle one, down to the street and back in at the bottom', async ({ page }) => {
  test.setTimeout(240_000);
  const clean = watchErrors(page);
  await openGame(page, 'demo-m3b');
  await page.evaluate(() => window.__h3d.enterFloor('herdr-3d'));
  await frames(page, 3);
  const b = await plan(page);
  expect(b.floors).toBe(3);
  const world = await page.evaluate(() => window.__h3d.world());
  // One outline for the three floors, whatever their desk counts.
  const layouts = await page.evaluate(() => ['herdr-3d', 'depot-manager', 'pastry'].map((s) => window.__h3d.layout(s)));
  for (const l of layouts) expect([l?.width, l?.depth, l?.fireDoor]).toEqual([b.width, b.depth, layouts[0]?.fireDoor]);
  const e = b.escape;
  const dz = (e.door.z0 + e.door.z1) / 2;
  const xi = (e.inner.x0 + e.inner.x1) / 2;

  // Shortcut to the top floor's fire-escape door, then walk out through it.
  await page.evaluate((z) => window.__h3d.setPose({ x: 1.8, z, yaw: Math.PI / 2, pitch: 0 }), dz);
  expect(await pose(page)).toMatchObject({ area: 'floor', storey: 2, floor: 'herdr-3d' });
  let p = await walkTo(page, xi, dz, 'out the top floor door');
  expect(p).toMatchObject({ area: 'fire-escape', storey: 2, floor: 'herdr-3d' });
  expect(p.y).toBeCloseTo(floorY(b, 2), 3);
  expect(await topbar(page)).toEqual({ name: 'herdr-3d', sub: 'Fire escape · Floor 3 of 3 · Work' });

  // Down to the middle floor's landing: the top bar and the interior switch to it.
  await downOne(page, b, 'top to middle');
  p = await pose(page);
  expect(p).toMatchObject({ area: 'fire-escape', storey: 1, floor: 'depot-manager' });
  expect(p.y).toBeCloseTo(floorY(b, 1), 3);
  expect((await topbar(page)).name).toBe('depot-manager');
  expect((await page.evaluate(() => window.__h3d.where()))?.loaded).toBe('depot-manager');

  // In through the middle floor's door: asleep, lights off, its own cards.
  p = await walkTo(page, 2.2, dz, 'in at the middle floor');
  expect(p).toMatchObject({ area: 'floor', storey: 1, floor: 'depot-manager' });
  expect(await page.evaluate(() => window.__h3d.view())).toMatchObject({ mode: 'floor', floor: 'depot-manager', asleep: true, area: 'floor' });
  expect(await topbar(page)).toEqual({ name: 'depot-manager', sub: 'Floor 2 of 3 · Work · asleep' });
  await page.evaluate((z) => window.__h3d.setPose({ x: 2.2, z: z - 3, yaw: -Math.PI / 2 - 0.35, pitch: -0.1 }), dz);
  await frames(page, 4);
  const names = new Set(world.find((f) => f.session === 'depot-manager')?.workers.map((w) => w.name));
  const cards = await page.evaluate(() => window.__h3d.cards());
  expect(cards.length).toBeGreaterThan(0);
  for (const c of cards) {
    expect(names.has(c.name), c.name).toBe(true);
    expect(c.display).toBe('asleep');
  }
  await page.evaluate((z) => window.__h3d.setPose({ x: 2.2, z, yaw: Math.PI / 2, pitch: 0 }), dz);

  // Back out, all the way down to the street.
  p = await walkTo(page, xi, dz, 'out the middle floor door');
  expect(p).toMatchObject({ area: 'fire-escape', storey: 1 });
  await downOne(page, b, 'middle to bottom');
  expect(await pose(page)).toMatchObject({ area: 'fire-escape', storey: 0, floor: 'pastry' });
  expect((await topbar(page)).name).toBe('pastry');
  await downOne(page, b, 'bottom to the street');
  p = await pose(page);
  expect(p).toMatchObject({ area: 'street', storey: null });
  expect(p.y).toBe(0);
  expect(await topbar(page)).toEqual({ name: 'Work', sub: 'Outside · 3 floors' });
  p = await walkTo(page, xi, b.depth + 1.6, 'out from under the fire escape to the front sidewalk');
  expect(p).toMatchObject({ area: 'street', y: 0 });

  // The street ends at the curb (bollards) and the fence on the fire-escape side.
  const fx = (b.lobby.front.x0 + b.lobby.front.x1) / 2;
  await walkTo(page, fx, b.depth + 3, 'along the sidewalk');
  p = await push(page, fx, b.fence.curb + 10, 3000);
  expect(p.z).toBeLessThan(b.fence.curb);
  expect(p.z).toBeGreaterThan(b.fence.curb - 0.6);
  await walkTo(page, fx, b.depth + 3, 'back from the curb');
  await walkTo(page, b.fence.west + 1.5, b.depth + 3, 'along the sidewalk to the fence');
  p = await push(page, b.fence.west - 10, b.depth + 3, 2500);
  expect(p.x).toBeGreaterThan(b.fence.west);
  expect(p.x).toBeLessThan(b.fence.west + 0.8);
  expect(p.area).toBe('street');

  // Back under the fire escape and up to the bottom floor, in through its door.
  await walkTo(page, xi, b.depth + 1.6, 'back to the fire escape');
  await walkTo(page, xi, dz, 'under the bottom landing');
  const half = (e.half.z0 + e.half.z1) / 2;
  const xo = (e.outer.x0 + e.outer.x1) / 2;
  p = await walkTo(page, xi, half, 'up flight 2');
  expect(p.y).toBeCloseTo(b.storey / 2, 3);
  await walkTo(page, xo, half, 'round the half landing');
  p = await walkTo(page, xo, e.landing.z0 + 0.3, 'up flight 1');
  expect(p).toMatchObject({ area: 'fire-escape', storey: 0, floor: 'pastry' });
  await walkTo(page, xi, dz, 'across the bottom landing');
  p = await walkTo(page, 2.2, dz, 'in at the bottom floor');
  expect(p).toMatchObject({ area: 'floor', storey: 0, floor: 'pastry' });
  expect(p.y).toBeCloseTo(floorY(b, 0), 3);
  expect(await page.evaluate(() => window.__h3d.view())).toMatchObject({ floor: 'pastry', asleep: false });
  expect(await topbar(page)).toEqual({ name: 'pastry', sub: 'Floor 1 of 3 · Work' });
  clean();
});

test('lobby: in from the sidewalk through the front door, the reception desk, the Lobby stop and back', async ({ page }) => {
  test.setTimeout(120_000);
  const clean = watchErrors(page);
  await openGame(page, 'demo-m3b');
  await page.evaluate(() => window.__h3d.enterFloor('pastry'));
  await frames(page, 3);
  const b = await plan(page);
  const fx = (b.lobby.front.x0 + b.lobby.front.x1) / 2;
  await page.evaluate(([x, z]) => window.__h3d.setPose({ x, z, y: 0, yaw: 0, pitch: 0 }), [fx, b.depth + 3] as const);
  expect(await pose(page)).toMatchObject({ area: 'street', y: 0 });
  expect(await page.evaluate(() => window.__h3d.receptionEvents())).toEqual([]);

  let p = await walkTo(page, fx, b.depth - 2.4, 'in through the front door');
  expect(p).toMatchObject({ area: 'lobby', y: 0, storey: null });
  expect(await topbar(page)).toEqual({ name: 'Work', sub: 'Lobby · 3 floors' });
  // Walking in from the street is what the receptionist greets; the lobby needs no floor interior.
  expect((await page.evaluate(() => window.__h3d.receptionEvents())).map((r) => r.ev)).toEqual(['arrive-street']);
  expect(await page.evaluate(() => window.__h3d.view())).toMatchObject({ area: 'lobby', floor: null });
  // The greeting: a welcome by time of day, then (3 people upstairs need you) a nudge whose bubble names the floor.
  const rx = () => page.evaluate(() => window.__h3d.reception());
  let r = await rx();
  const welcome = r?.said[0];
  expect(welcome?.kind).toMatch(/^welcome-(morning|afternoon|evening|night)$/);
  expect(r?.said.map((l) => l.kind)).toEqual([welcome?.kind, 'nudge']);
  expect(r?.said[1]?.bubble).toContain('herdr-3d');
  expect(r?.clips[0]).toBe(welcome?.id);
  expect(r?.bubble).toBe(welcome?.bubble);
  await expect(page.locator('.rx-bubble-card')).toBeVisible();
  await expect(page.locator('.rx-bubble-card')).toContainText(welcome?.bubble ?? '???');
  await shot(page, 'm3b-lobby-greeting');
  // Facing the desk: E opens the floor directory (the elevator panel), with the Lobby stop lit.
  expect(await page.evaluate(() => window.__h3d.lookAt())).toMatchObject({ kind: 'prop', id: 'reception' });
  await page.keyboard.press('e');
  await expect.poll(() => page.evaluate(() => window.__h3d.panel()?.kind)).toBe('elevator');
  const panel = await page.evaluate(() => window.__h3d.panel());
  expect(panel).toMatchObject({ kind: 'elevator', title: 'Work', lobby: { current: true } });
  expect(panel?.kind === 'elevator' && panel.rows.map((r) => [r.session, r.current])).toEqual([
    ['herdr-3d', false],
    ['depot-manager', false],
    ['pastry', false],
  ]);
  expect((await page.evaluate(() => window.__h3d.receptionEvents())).map((r) => r.ev)).toEqual(['arrive-street', 'interact']);
  expect((await rx())?.said.at(-1)?.kind).toBe('interact');
  await page.keyboard.press('Escape');
  await expect.poll(() => page.evaluate(() => window.__h3d.panel())).toBeNull();

  // Out and straight back in: the game reports both crossings (the receptionist's cooldown decides what it says).
  p = await walkTo(page, fx, b.depth + 2.4, 'out the front door');
  expect(p.area).toBe('street');
  p = await walkTo(page, fx, b.depth - 2.4, 'back in');
  expect(p.area).toBe('lobby');
  expect((await page.evaluate(() => window.__h3d.receptionEvents())).map((r) => r.ev)).toEqual(['arrive-street', 'interact', 'leave-front', 'arrive-street']);
  // A goodbye on the way out, and no second welcome inside the two-minute cooldown.
  r = await rx();
  expect(r?.said.map((l) => l.kind)).toEqual([welcome?.kind, 'nudge', 'interact', 'goodbye']);
  expect(r?.cooldownUntil).toBeGreaterThan(Date.now() + 60_000);

  // The Lobby stop: up to the top floor from the panel, and back down.
  await page.keyboard.press('l');
  await expect.poll(() => page.evaluate(() => window.__h3d.panel()?.kind)).toBe('elevator');
  await page.locator('dialog.panel [data-key="go:herdr-3d"]').focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => page.evaluate(() => window.__h3d.view())).toMatchObject({ floor: 'herdr-3d', area: 'floor', busy: false });
  p = await pose(page);
  expect(p).toMatchObject({ area: 'floor', storey: 2, floor: 'herdr-3d' });
  expect(p.y).toBeCloseTo(floorY(b, 2), 3);
  await page.keyboard.press('l');
  await expect.poll(() => page.evaluate(() => window.__h3d.panel()?.kind)).toBe('elevator');
  expect(await page.evaluate(() => window.__h3d.panel())).toMatchObject({ lobby: { current: false } });
  await page.locator('dialog.panel [data-key="go:lobby"]').focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => page.evaluate(() => window.__h3d.view())).toMatchObject({ area: 'lobby', floor: null, busy: false });
  p = await pose(page);
  expect(p).toMatchObject({ area: 'lobby', y: 0 });
  expect(p.z).toBeCloseTo(b.depth - 1.3, 3);
  expect((await page.evaluate(() => window.__h3d.receptionEvents())).map((r) => r.ev).at(-1)).toBe('arrive-elevator');
  // The elevator greeting shares the welcome's cooldown: still nothing new.
  expect((await rx())?.said.map((l) => l.kind)).toEqual([welcome?.kind, 'nudge', 'interact', 'goodbye']);
  // From the lobby, the panel still lists the building's floors; the city pick still goes to a floor.
  await page.keyboard.press('l');
  await expect.poll(() => page.evaluate(() => window.__h3d.panel())).toMatchObject({ kind: 'elevator', lobby: { current: true } });
  await page.keyboard.press('Escape');
  clean();
});

test('screenshots: out of the windows, the fire escape, the facade, the lobby', async ({ page }) => {
  test.setTimeout(120_000);
  const clean = watchErrors(page);
  await openGame(page, 'demo-m3b');
  await page.evaluate(() => window.__h3d.enterFloor('pastry'));
  await frames(page, 3);
  const b = await plan(page);
  const e = b.escape;
  const at = async (name: string, p: { x: number; z: number; y?: number; yaw: number; pitch: number }) => {
    await page.evaluate((pp) => window.__h3d.setPose(pp), p);
    await frames(page, 8);
    await shot(page, name);
  };
  // Out of a south window, over the sill: the street a storey down, and three.
  const L = await page.evaluate(() => window.__h3d.layout('pastry'));
  const win = L?.openings.find((o) => o.wall === 'south' && o.kind === 'window');
  if (!win) throw new Error('no south window');
  const wx = (win.u0 + win.u1) / 2;
  await at('m3b-window-bottom', { x: wx, z: b.depth - 0.85, yaw: Math.PI - 0.15, pitch: -0.5 });
  await page.evaluate(() => window.__h3d.enterFloor('herdr-3d'));
  await frames(page, 3);
  await at('m3b-window-top', { x: wx, z: b.depth - 0.45, yaw: Math.PI - 0.15, pitch: -0.78 });
  await at('m3b-fire-escape', { x: (e.inner.x0 + e.inner.x1) / 2, z: e.landing.z1 - 0.4, y: floorY(b, 2), yaw: 0.35, pitch: -0.5 });
  await at('m3b-facade', { x: b.width / 2 - 5.5, z: b.depth + 6, y: 0, yaw: 0.32, pitch: 0.42 });
  await at('m3b-fire-escape-street', { x: -7.2, z: b.depth + 5.6, y: 0, yaw: -0.35, pitch: 0.38 });
  await at('m3b-lobby', { x: b.lobby.front.x0 + 0.4, z: b.depth - 1.1, y: 0, yaw: -0.12, pitch: -0.05 });
  expect(await page.evaluate(() => window.__h3d.lookAt())).toBeNull();
  clean();
});
