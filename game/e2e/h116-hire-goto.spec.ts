import { expect, test, type Page } from '@playwright/test';
import { expectCommandDone, frames, openGame, watchErrors } from './game';

// #116 on demo-m4 with the simulator (sim=1): after a hire is acknowledged, you are taken to the new worker's laptop with
// its conversation on screen (Settings → Display "Go to a new hire after hiring", on by default); off, the hire leaves
// you where you stand (#54). pastry (bottom, 16 desks, 14 and 15 empty).

const SIM = 'play=none&sim=1&simms=150';

const pose = async (page: Page) => {
  const p = await page.evaluate(() => window.__h3d.pose());
  if (!p) throw new Error('not walking');
  return p;
};

/** On pastry, in the aisle behind desk 14's chair, with the hire dialog open for desk 14 and a first task typed. */
async function startHire(page: Page): Promise<{ x: number; z: number }> {
  await openGame(page, 'demo-m4', '', SIM);
  await page.evaluate(() => window.__h3d.enterFloor('pastry'));
  await frames(page, 3);
  const L = await page.evaluate(() => window.__h3d.layout('pastry'));
  const s = L?.slots[14];
  if (!L || !s) throw new Error('no desk 14');
  const at = { x: s.seat.x - Math.sin(s.yaw) * 1.1, z: s.seat.z - Math.cos(s.yaw) * 1.1 };
  await page.evaluate(([x, z]) => window.__h3d.setPose({ x, z, yaw: 0 }), [at.x, at.z] as const);
  await frames(page, 2);
  await page.evaluate(() => window.__h3d.openHire(14));
  await expect.poll(() => page.evaluate(() => window.__h3d.dialog()?.kind === 'hire' && window.__h3d.dialog()?.state), { timeout: 10_000 }).toBe('ready');
  await page.locator('#hire-task').focus();
  await page.keyboard.type('Label the loaves');
  await page.keyboard.press('Enter');
  await expectCommandDone(page, 'worker.hire');
  await expect(page.locator('.toast')).toHaveText(/^Hired .* at Desk 15 .*Here they come\.$/);
  return at;
}

test('a hire takes you to the new worker: seated at its laptop, its conversation on screen', async ({ page }) => {
  test.setTimeout(150_000);
  const clean = watchErrors(page);
  await startHire(page);
  const id = await expect
    .poll(() => page.evaluate(() => window.__h3d.desks()[14]?.worker ?? null), { timeout: 20_000 })
    .not.toBeNull()
    .then(() => page.evaluate(() => window.__h3d.desks()[14]?.worker as string));
  // After the drop-in, never during it.
  await expect.poll(() => page.evaluate(() => window.__h3d.seated()), { timeout: 20_000 }).toBe(id);
  expect(await page.evaluate(() => window.__h3d.arrivals().some((a) => a.id === id))).toBe(false);
  expect(await page.evaluate(() => window.__h3d.seat().mode)).toBe('transcript');
  await expect(page.locator('.seat-transcript')).toBeVisible();
  expect(await pose(page)).toMatchObject({ area: 'floor', floor: 'pastry' });
  // One go-to per hire: standing up again, nothing sits you back down.
  await page.keyboard.press('Escape');
  await expect.poll(() => page.evaluate(() => window.__h3d.seated())).toBeNull();
  await frames(page, 30);
  expect(await page.evaluate(() => window.__h3d.seated())).toBeNull();
  clean();
});

test('with the setting off, a hire leaves you exactly where you stand', async ({ page }) => {
  test.setTimeout(150_000);
  const clean = watchErrors(page);
  await page.addInitScript(() => localStorage.setItem('h3d.hire.goto', 'off'));
  const at = await startHire(page);
  await expect.poll(() => page.evaluate(() => window.__h3d.desks()[14]?.worker ?? null), { timeout: 20_000 }).not.toBeNull();
  // Long enough for the drop-in to end and for a go-to to have fired, were it on.
  await expect.poll(() => page.evaluate(() => window.__h3d.arrivals().length), { timeout: 20_000 }).toBe(0);
  await page.waitForTimeout(1500);
  expect(await page.evaluate(() => window.__h3d.seated())).toBeNull();
  const p = await pose(page);
  expect(p).toMatchObject({ area: 'floor', floor: 'pastry' });
  expect(p.x).toBeCloseTo(at.x, 3);
  expect(p.z).toBeCloseTo(at.z, 3);
  clean();
});

test('Esc on the hire dialog while the hire is on its way: no go-to, only the toast', async ({ page }) => {
  test.setTimeout(150_000);
  const clean = watchErrors(page);
  await openGame(page, 'demo-m4', '', SIM);
  await page.evaluate(() => window.__h3d.enterFloor('pastry'));
  await frames(page, 3);
  await page.evaluate(() => window.__h3d.openHire(14));
  await expect.poll(() => page.evaluate(() => window.__h3d.dialog()?.kind === 'hire' && window.__h3d.dialog()?.state), { timeout: 10_000 }).toBe('ready');
  await page.locator('#hire-task').focus();
  await page.keyboard.type('Label the loaves');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Escape');
  await expect(page.locator('.toast').last()).toHaveText(/Here they come\.$/, { timeout: 30_000 });
  await expect.poll(() => page.evaluate(() => window.__h3d.desks()[14]?.worker ?? null), { timeout: 20_000 }).not.toBeNull();
  await expect.poll(() => page.evaluate(() => window.__h3d.arrivals().length), { timeout: 20_000 }).toBe(0);
  await page.waitForTimeout(1500);
  expect(await page.evaluate(() => window.__h3d.seated())).toBeNull();
  clean();
});
