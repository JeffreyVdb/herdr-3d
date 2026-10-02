import { expect, test, type Page } from '@playwright/test';
import { frames, openGame, watchErrors } from './game';

// #54 on demo-m4 with the simulator (sim=1): a hire never moves you off your spot. Standing in an empty desk's chair
// space is open floor until the worker sits there; then it is a collider, and used to send you to the floor entrance.
// The same when the room grows a desk (the bridge renders workers + 2) and the layout shifts under you. pastry (bottom,
// 16 desks, 14 and 15 empty). The events are the bridge's, injected, so the floor's desk count is ours to keep or grow.

const SIM = 'play=none&sim=1&simms=150';
type Layout = NonNullable<ReturnType<Window['__h3d']['layout']>>;

async function enter(page: Page, session: string): Promise<Layout> {
  await page.evaluate((s) => window.__h3d.enterFloor(s), session);
  await frames(page, 3);
  return layout(page, session);
}

async function layout(page: Page, session: string): Promise<Layout> {
  const L = await page.evaluate((s) => window.__h3d.layout(s), session);
  if (!L) throw new Error('no layout');
  return L;
}

/** The bridge says the floor renders `desks` desks. */
async function setDesks(page: Page, session: string, desks: number): Promise<void> {
  await page.evaluate(
    ([s, n]) => {
      const where = window.__h3d.where();
      if (!where) throw new Error('not in a building');
      window.__h3d.inject({ t: 'floor.upsert', seq: 0, floor: { session: s, state: 'running', building: where.building, index: where.floors.indexOf(s), desks: n } } as never);
    },
    [session, desks] as const,
  );
  await frames(page, 3);
}

const here = async (page: Page) => {
  const p = await page.evaluate(() => window.__h3d.pose());
  if (!p) throw new Error('not walking');
  return p;
};

test('a worker hired at the desk you stand behind seats without moving you to the floor entrance', async ({ page }) => {
  test.setTimeout(90_000);
  const clean = watchErrors(page);
  await openGame(page, 'demo-m4', '', SIM);
  const L = await enter(page, 'pastry');
  await setDesks(page, 'pastry', L.desks);
  const s = L.slots[14];
  if (!s) throw new Error('no desk 14');
  // In the chair space of the empty desk: open floor, until the worker sits there.
  await page.evaluate(([x, z]) => window.__h3d.setPose({ x, z, yaw: 0 }), [s.seat.x, s.seat.z] as const);
  await frames(page, 2);
  await page.evaluate(() => {
    const w = window.__h3d.worker(window.__h3d.world().find((f) => f.session === 'pastry')?.workers[0]?.id ?? '');
    if (!w) throw new Error('no worker to copy');
    window.__h3d.inject({ t: 'worker.upsert', seq: 0, worker: { ...w, id: 'h54-hire', label: 'CODE|h54', desk_index: 14, session: 'pastry' } } as never);
  });
  await frames(page, 4);
  expect(await page.evaluate(() => window.__h3d.desks()[14]?.worker)).toBe('h54-hire');
  const p = await here(page);
  expect(p).toMatchObject({ area: 'floor', floor: 'pastry' });
  expect(Math.hypot(p.x - s.seat.x, p.z - s.seat.z)).toBeLessThan(1);
  expect(Math.hypot(p.x - L.spawn.x, p.z - L.spawn.z)).toBeGreaterThan(2);
  // Out the back of the chair, into the aisle.
  expect((p.x - s.seat.x) * -Math.sin(s.yaw) + (p.z - s.seat.z) * -Math.cos(s.yaw)).toBeGreaterThan(0.3);
  clean();
});

test('standing in the aisle, a hire leaves your exact position', async ({ page }) => {
  test.setTimeout(90_000);
  const clean = watchErrors(page);
  await openGame(page, 'demo-m4', '', SIM);
  const L = await enter(page, 'pastry');
  await setDesks(page, 'pastry', L.desks);
  const s = L.slots[14];
  if (!s) throw new Error('no desk 14');
  // Behind the chair, clear of its seat rect (0.3) and the player's radius (0.28).
  const at = { x: s.seat.x - Math.sin(s.yaw) * 1.1, z: s.seat.z - Math.cos(s.yaw) * 1.1 };
  await page.evaluate(([x, z]) => window.__h3d.setPose({ x, z, yaw: 0 }), [at.x, at.z] as const);
  await frames(page, 2);
  await page.evaluate(() => {
    const w = window.__h3d.worker(window.__h3d.world().find((f) => f.session === 'pastry')?.workers[0]?.id ?? '');
    if (!w) throw new Error('no worker to copy');
    window.__h3d.inject({ t: 'worker.upsert', seq: 0, worker: { ...w, id: 'h54-hire', label: 'CODE|h54', desk_index: 14, session: 'pastry' } } as never);
  });
  await frames(page, 4);
  expect(await page.evaluate(() => window.__h3d.desks()[14]?.worker)).toBe('h54-hire');
  const p = await here(page);
  expect(p.x).toBeCloseTo(at.x, 3);
  expect(p.z).toBeCloseTo(at.z, 3);
  clean();
});

test('the room growing a desk under you (the layout shifts) nudges you out of what is now solid, not to the entrance', async ({ page }) => {
  test.setTimeout(90_000);
  const clean = watchErrors(page);
  await openGame(page, 'demo-m4', '', SIM);
  const L = await enter(page, 'pastry');
  await setDesks(page, 'pastry', L.desks + 1);
  const grown = await layout(page, 'pastry');
  await setDesks(page, 'pastry', L.desks);
  // A spot free in the room as it is and solid in the room as it will be (the centre of one of its desks or props).
  const hit = (r: { x0: number; z0: number; x1: number; z1: number }, x: number, z: number) => x + 0.28 > r.x0 && x - 0.28 < r.x1 && z + 0.28 > r.z0 && z - 0.28 < r.z1;
  const spot = grown.colliders
    .filter((r) => r.x1 - r.x0 < 2 && r.z1 - r.z0 < 2)
    .map((r) => ({ x: (r.x0 + r.x1) / 2, z: (r.z0 + r.z1) / 2 }))
    .find((p) => !L.colliders.some((r) => hit(r, p.x, p.z)) && p.x > 1 && p.z > 1 && p.x < L.width - 1 && p.z < L.depth - 1);
  expect(spot, 'a spot the grown room fills').toBeDefined();
  const at = spot as { x: number; z: number };
  await page.evaluate(([x, z]) => window.__h3d.setPose({ x, z, yaw: 0 }), [at.x, at.z] as const);
  await frames(page, 2);
  await setDesks(page, 'pastry', L.desks + 1);
  const p = await here(page);
  expect(p).toMatchObject({ area: 'floor', floor: 'pastry' });
  expect(Math.hypot(p.x - at.x, p.z - at.z)).toBeLessThan(1);
  expect(Math.hypot(p.x - L.spawn.x, p.z - L.spawn.z)).toBeGreaterThan(2);
  clean();
});
