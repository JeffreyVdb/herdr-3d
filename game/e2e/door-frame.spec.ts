import { test } from '@playwright/test';
import { frames, openGame, shot, watchErrors } from './game';

test('fire-escape frame close-ups from the room and threshold', { tag: '@visual' }, async ({ page }) => {
  const clean = watchErrors(page);
  await page.addInitScript(() => localStorage.setItem('h3d.theme.ui', 'ubuntu'));
  await openGame(page, 'demo-m3b');
  await page.evaluate(() => window.__h3d.enterFloor('herdr-3d'));
  const d = await page.evaluate(() => window.__h3d.layout('herdr-3d')!.fireDoor);
  for (const [name, x] of [['room', 0.65], ['threshold', 0.12]] as const) {
    await page.evaluate(({ x, z }) => window.__h3d.setPose({ x, z, yaw: Math.PI / 2 - 0.35, pitch: 0.2 }), { x, z: (d.z0 + d.z1) / 2 });
    await frames(page, 45);
    await shot(page, `door-frame-${name}`);
  }
  await page.evaluate((z) => window.__h3d.setPose({ x: 0.12, z, yaw: 0.45, pitch: 0.25 }), d.z0 + 0.25);
  await frames(page, 8);
  await shot(page, 'door-frame-jamb');
  // Look down from the landing at the sill and facade band: the reported gap and flickering strip.
  for (const [name, x, yaw] of [['outside', -0.65, -Math.PI / 2 + 0.35], ['inside', 0.35, Math.PI / 2 - 0.35]] as const) {
    await page.evaluate(({ x, yaw, z }) => window.__h3d.setPose({ x, z, yaw, pitch: -1.1 }), { x, yaw, z: (d.z0 + d.z1) / 2 });
    await frames(page, 45);
    await shot(page, `door-threshold-${name}`);
  }
  clean();
});
