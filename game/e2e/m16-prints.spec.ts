import { expect, test, type Page } from '@playwright/test';
import { frames, openGame, shot, watchErrors } from './game';

// M16 phase 2: prints on the desk, for real on the WebGL2 path. demo-m5 with the simulating fixture server (sim=1): its
// transcript has real PNGs (tools/fixture-transcript.ts): the user's two screenshots (one sent twice) and one outside the
// bridge's roots, what the agent viewed with a Read and two it generated. Standing near Tofu's desk, its transcript is
// watched with a handful of items and the images are laid out in two trays (IN on the worker's left, OUT on its right),
// the thumbnails as real textures. Walking off drops them all; sitting and standing 20 times leaks no texture.

const FLOOR = 'herdr-3d';
const SIM = 'play=none&sim=1&simms=500&simusage=0';

type Prints = NonNullable<Awaited<ReturnType<typeof printsOf>>>;
const printsOf = (page: Page) => page.evaluate(() => window.__h3d.prints());
const deskOf = async (page: Page, id: string) => (await printsOf(page))?.desks.find((d) => d.id === id) ?? null;

async function open(page: Page): Promise<{ id: string; desk: number }> {
  await openGame(page, 'demo-m5', '', SIM);
  await page.evaluate((s) => window.__h3d.enterFloor(s), FLOOR);
  await frames(page, 3);
  const w = await page.evaluate(() => window.__h3d.world().flatMap((f) => f.workers).find((x) => x.name === 'Tofu'));
  expect(w).toBeTruthy();
  const id = (w as { id: string }).id;
  expect(await page.evaluate((i) => window.__h3d.face(i), id), 'facing Tofu').toBe(true);
  return { id, desk: (w as { desk: number }).desk };
}

/**
 * Stands at a point of a desk’s slot space (default: just behind the chair) and looks at a world point (default: the
 * middle of the desk’s print strip). Slot space: the worker faces +z; a slot turned `yaw` maps (x, z) to
 * (x cos + z sin, -x sin + z cos).
 */
async function lookAtPrints(page: Page, desk: number, at: { x: number; y: number; z: number } | null = null, from: { x: number; z: number } = { x: 0, z: -0.2 }): Promise<void> {
  await page.evaluate(
    ([d, target, f]) => {
      const p = window.__h3d.pose();
      const L = window.__h3d.layout(window.__h3d.view().floor as string);
      const s = L?.slots[d as number];
      if (!p || !s) throw new Error('no pose');
      const fr = f as { x: number; z: number };
      const cx = s.seat.x + fr.x * Math.cos(s.yaw) + fr.z * Math.sin(s.yaw);
      const cz = s.seat.z - fr.x * Math.sin(s.yaw) + fr.z * Math.cos(s.yaw);
      const t = target as { x: number; y: number; z: number } | null;
      const tx = t?.x ?? s.seat.x + Math.sin(s.yaw) * 0.57;
      const ty = t?.y ?? 0.64;
      const tz = t?.z ?? s.seat.z + Math.cos(s.yaw) * 0.57;
      const dx = tx - cx;
      const dz = tz - cz;
      window.__h3d.setPose({ x: cx, z: cz, yaw: Math.atan2(-dx, -dz), pitch: Math.atan2(ty - p.eye, Math.hypot(dx, dz)) });
    },
    [desk, at, from] as const,
  );
  await frames(page, 3);
}

test('a desk near you shows the conversation’s images as prints: IN left, OUT right, real thumbnails, a blank card for the lost one', async ({ page }) => {
  test.setTimeout(150_000);
  const clean = watchErrors(page);
  const { id, desk } = await open(page);
  await lookAtPrints(page, desk);

  // Seven prints: three in (one sent twice shows once, one outside the roots is blank) and four out.
  await expect.poll(async () => (await deskOf(page, id))?.textures).toBe(6);
  const d = (await deskOf(page, id)) as Prints['desks'][number];
  expect(d.prints).toHaveLength(7);
  expect(d.prints.filter((p) => p.tray === 'in')).toHaveLength(3);
  expect(d.prints.filter((p) => p.tray === 'out')).toHaveLength(4);
  expect(d.prints.filter((p) => p.blank).map((p) => p.tray)).toEqual(['in']);
  expect(d.prints.filter((p) => !p.blank).every((p) => p.loaded)).toBe(true);
  // In is on slot +x (the worker’s left), out on -x.
  for (const p of d.prints) expect(Math.sign(p.x)).toBe(p.tray === 'in' ? 1 : -1);
  const st = (await printsOf(page)) as Prints;
  // Two desks are near (the nearest two); every desk of this conversation has six pictures.
  expect(st.desks.length).toBeLessThanOrEqual(2);
  await expect.poll(async () => (await printsOf(page))?.counts.alive).toBe(6 * st.desks.length);
  expect((await printsOf(page))?.counts).toMatchObject({ disposed: 0 });
  // At most 10 whatever the transcript holds; only the desks near you have any (and watched with a handful of items).
  expect(d.prints.length).toBeLessThanOrEqual(10);
  expect(st.desks.length).toBeLessThanOrEqual(2);
  const log = await page.evaluate(() => window.__h3d.watchLog());
  const limits = log.filter((c) => c.t === 'transcript.watch').map((c) => (c.args as { limit?: number }).limit);
  expect(limits.length).toBeGreaterThan(0);
  expect(Math.max(...(limits as number[]))).toBeLessThanOrEqual(1);
  // Close up, from the side: the prints in their trays.
  await lookAtPrints(page, desk, null, { x: 0.8, z: 0.4 });
  await frames(page, 4);
  await shot(page, 'm16-prints');

  // A click on a print opens the lightbox with the desk’s prints (the crosshair is the centre of the view).
  const idx = d.prints.findIndex((p) => p.tray === 'out' && p.loaded);
  const at = await page.evaluate(([dk, i]) => window.__h3d.printWorld(dk as number, i as number), [desk, idx] as const);
  expect(at).not.toBeNull();
  await lookAtPrints(page, desk, at);
  expect(await page.evaluate(() => window.__h3d.clickPrint(0, 0))).toBe(true);
  const lb = page.locator('.ilb');
  await expect(lb).toBeVisible();
  await expect(lb.locator('.ilb-count')).toHaveText(/^\d \/ 7$/);
  await expect(lb.locator('.ilb-badge')).toHaveText(/Agent/);
  await page.keyboard.press('Escape');
  await expect(lb).toBeHidden();
  // Esc closed only the lightbox: you are still standing on the floor.
  expect((await page.evaluate(() => window.__h3d.view())).mode).toBe('floor');
  // The blank card opens its "not available" card.
  const blank = d.prints.findIndex((p) => p.blank);
  const bat = await page.evaluate(([dk, i]) => window.__h3d.printWorld(dk as number, i as number), [desk, blank] as const);
  await lookAtPrints(page, desk, bat);
  expect(await page.evaluate(() => window.__h3d.clickPrint(0, 0))).toBe(true);
  await expect(lb.locator('.ilb-card-title')).toHaveText('Image not available');
  await expect(lb.locator('.ilb-card-path')).toHaveText('/etc/hosts.png');
  await page.keyboard.press('Escape');
  await expect(lb).toBeHidden();
  clean();
});

test('walking away takes every print, texture and watch with it; 20 sit / stand and near / far cycles leak nothing', async ({ page }) => {
  test.setTimeout(240_000);
  const clean = watchErrors(page);
  const { id, desk } = await open(page);
  await lookAtPrints(page, desk);
  await expect.poll(async () => (await deskOf(page, id))?.textures).toBe(6);
  const near = await page.evaluate(() => window.__h3d.pose());
  expect(near).not.toBeNull();

  const away = async () => {
    // Across the floor and out of the range of every desk’s prints (the floor is large; the far corner will do).
    await page.evaluate(() => window.__h3d.setPose({ x: 1, z: 1, yaw: 0, pitch: 0 }));
    await frames(page, 2);
  };
  await away();
  await expect.poll(async () => (await printsOf(page))?.counts.alive, { timeout: 15_000 }).toBe(0);
  await expect.poll(async () => (await printsOf(page))?.desks.length).toBe(0);
  await expect.poll(async () => (await printsOf(page))?.watches ?? ['x'], { timeout: 15_000 }).toEqual([]);
  const sim = await page.evaluate(() => window.__h3d.simTranscripts());
  expect(sim?.watches).toBe(0);

  // Back: the prints come again; then 20 rounds of sitting and standing, and of leaving and coming back.
  const created0 = (await printsOf(page))?.counts.created ?? 0;
  for (let i = 0; i < 20; i++) {
    expect(await page.evaluate((i2) => window.__h3d.face(i2), id)).toBe(true);
    await lookAtPrints(page, desk);
    await expect.poll(async () => (await deskOf(page, id))?.textures, { timeout: 15_000 }).toBe(6);
    expect(await page.evaluate((w) => window.__h3d.sitAt(w), id)).toBe(true);
    await expect.poll(() => page.evaluate(() => window.__h3d.seated())).toBe(id);
    await frames(page, 2);
    // Sitting there: the conversation’s own watch (not a few items any more) and the same prints.
    expect(((await printsOf(page)) as Prints).counts.alive).toBeLessThanOrEqual(12);
    await page.keyboard.press('Escape');
    await expect.poll(() => page.evaluate(() => window.__h3d.seated())).toBeNull();
    await away();
    await expect.poll(async () => (await printsOf(page))?.counts.alive, { timeout: 15_000 }).toBe(0);
  }
  const end = (await printsOf(page)) as Prints;
  expect(end.counts.alive).toBe(0);
  expect(end.counts.disposed).toBe(end.counts.created);
  expect(end.counts.closed).toBe(end.counts.created);
  // Each round made its six pictures again (a fresh watch, fresh thumbnails) and let every one go.
  expect(end.counts.created).toBeLessThanOrEqual(12 * 21 + created0);
  expect(end.watches).toEqual([]);
  expect((await page.evaluate(() => window.__h3d.simTranscripts()))?.watches).toBe(0);
  clean();
});
