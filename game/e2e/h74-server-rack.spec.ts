import { expect, test, type Page } from '@playwright/test';
import { frames, openGame, shot, watchErrors } from './game';

// #74 on demo-m118 (the lab floor and others): the server rack stands against the north wall between the lounge window
// and the whiteboard. Looking at it asks the bridge for the host's stats (host.watch, after 300 ms), its monitor shows
// them and its LEDs follow the disks; looking away ends the watch after a grace of 10 s; a hidden tab, another floor and
// a bridge that does not know the command are handled. The fixture simulator plays the bridge (tools/fixture-host.ts).

const SIM = 'play=none&sim=1&simms=150&simhostms=1000';

const rack = (page: Page) => page.evaluate(() => window.__h3d.rack());
const sent = async (page: Page) => (await rack(page))?.sent.map((s) => s.t) ?? [];
const hostLog = (page: Page) => page.evaluate(async () => (await window.__h3d.simHost('sim.host_log', {})).data as { watch: number; unwatch: number; stats: number; disk: number; watching: boolean });

/** In the lounge side of the north wall, facing the rack from `dist` metres. */
async function faceRack(page: Page, dist = 2.2, pitch = -0.12): Promise<void> {
  await page.evaluate(
    ([dist, pitch]) => {
      const b = window.__h3d.layout('lab')?.props.find((p) => p.id === 'server.rack')?.box;
      if (!b) throw new Error('no server rack');
      window.__h3d.setPose({ x: (b.min[0] + b.max[0]) / 2, z: b.max[2] + dist, yaw: 0, pitch });
    },
    [dist, pitch] as const,
  );
  await frames(page, 3);
}

/** Looking at the south wall: the rack is out of view. */
async function turnAway(page: Page): Promise<void> {
  await page.evaluate(() => {
    const b = window.__h3d.layout('lab')?.props.find((p) => p.id === 'server.rack')?.box;
    window.__h3d.setPose({ x: ((b?.min[0] ?? 0) + (b?.max[0] ?? 0)) / 2, z: (b?.max[2] ?? 0) + 2.2, yaw: Math.PI, pitch: 0 });
  });
  await frames(page, 3);
}

/** On the lab floor, at its south end facing south: the rack is behind you, out of view. */
async function onLab(page: Page, wsQuery = SIM): Promise<void> {
  await openGame(page, 'demo-m118', '', wsQuery);
  await page.evaluate(() => {
    const L = window.__h3d.layout('lab');
    return window.__h3d.enterFloor('lab', { x: (L?.width ?? 18) / 2, z: (L?.depth ?? 14) - 1.3, yaw: Math.PI, pitch: 0 });
  });
  await frames(page, 3);
}

test('the rack is aimed at, says what it reads on the HUD, and its monitor shows the host (CPU, memory, updates, the sample time)', async ({ page }) => {
  test.setTimeout(120_000);
  const clean = watchErrors(page);
  await onLab(page);
  // Nobody has looked yet: the bridge was never asked.
  expect(await sent(page)).toEqual([]);
  expect((await hostLog(page)).watch).toBe(0);
  await faceRack(page);
  expect(await page.evaluate(() => window.__h3d.lookAt())).toMatchObject({ kind: 'prop', id: 'server.rack' });
  const bar = page.locator('.prompt');
  await expect(bar).toContainText('Server rack');
  await expect(bar.locator('kbd')).toHaveCount(0); // nothing to press
  await expect.poll(async () => (await sent(page)).join()).toBe('host.watch');
  await expect.poll(async () => (await rack(page))?.rack?.mode, { timeout: 20_000 }).toBe('live');
  await expect(bar).toContainText('CPU 12% · Mem 41%');
  const r = await rack(page);
  expect(r?.rack?.lines).toEqual(expect.arrayContaining(['CPU', '12%', 'Memory', '41%', '13.2 / 32.0 GiB', '3 updates pending']));
  expect(r?.rack?.lines.some((l) => /^\d\d:\d\d:\d\d$/.test(l))).toBe(true);
  expect(r?.rack?.tones).toEqual({ cpu: 'ok', mem: 'ok' });
  expect(r?.rack?.drawCalls).toBe(3);
  await page.waitForTimeout(500);
  await shot(page, 'h74-rack-live');
  await faceRack(page, 1.3, -0.35);
  await shot(page, 'h74-rack-close');
  clean();
});

test('the bars turn amber above 75 % and red above 90 %, and the updates line is hidden when the host reports none', async ({ page }) => {
  test.setTimeout(120_000);
  await onLab(page, `${SIM}&simhost=hot`);
  await faceRack(page);
  await expect.poll(async () => (await rack(page))?.rack?.mode, { timeout: 20_000 }).toBe('live');
  expect((await rack(page))?.rack?.tones).toEqual({ cpu: 'hot', mem: 'warn' });
  expect((await rack(page))?.rack?.lines).toContain('12 updates pending');
  await shot(page, 'h74-rack-hot');
  // The host stops reporting updates: the next frame has none, and the line goes.
  await page.evaluate(() => window.__h3d.simHost('sim.host', { updates: null, cpu: 50, mem: 20 }));
  await expect.poll(async () => (await rack(page))?.rack?.tones, { timeout: 20_000 }).toEqual({ cpu: 'ok', mem: 'ok' });
  const lines = (await rack(page))?.rack?.lines ?? [];
  expect(lines.some((l) => /update|Up to date/.test(l))).toBe(false);
  await page.evaluate(() => window.__h3d.simHost('sim.host', { updates: 0 }));
  await expect.poll(async () => (await rack(page))?.rack?.lines, { timeout: 20_000 }).toContain('Up to date');
});

test('the screen redraws once per host.stats frame, and the LEDs are written once per host.disk frame', async ({ page }) => {
  test.setTimeout(120_000);
  await onLab(page);
  await faceRack(page);
  await expect.poll(async () => (await rack(page))?.rack?.mode, { timeout: 20_000 }).toBe('live');
  // Many rendered frames pass between two bridge frames: the canvas is not touched by them.
  const a = (await rack(page))?.rack;
  await frames(page, 30);
  const b = (await rack(page))?.rack;
  const log = await hostLog(page);
  expect(b?.draws ?? 0).toBeGreaterThanOrEqual(a?.draws ?? 0);
  // Every redraw came from a frame (plus the waiting screen): never more than the frames received.
  expect(b?.draws ?? 0).toBeLessThanOrEqual(log.stats + 2);
  expect(b?.rateWrites ?? 0).toBeLessThanOrEqual(log.disk + 1);
  // The rates really follow the disk frames: a quiet disk, then a busy one.
  const levels = async () => (await rack(page))?.rack?.leds.filter((_, i) => i % 4 === 1 || i % 4 === 2).map((l) => l.level) ?? [];
  await page.evaluate(() => window.__h3d.simHost('sim.host', { disks: [{ name: 'nvme0n1', r_iops: 0, w_iops: 0 }] }));
  await expect.poll(async () => (await levels()).slice(0, 2), { timeout: 20_000 }).toEqual([0, 0]);
  const quiet = (await rack(page))?.rack?.rateWrites ?? 0;
  await page.evaluate(() => window.__h3d.simHost('sim.host', { disks: [{ name: 'nvme0n1', r_iops: 6000, w_iops: 100 }] }));
  await expect.poll(async () => (await levels()).slice(0, 2), { timeout: 20_000 }).toEqual([1, expect.closeTo(0.54, 1)]);
  // One disk: the other servers mirror its totals (reads near solid, writes a flicker), each with its own phase.
  expect((await levels()).slice(2).map((v) => +v.toFixed(1))).toEqual([1, 0.5, 1, 0.5, 1, 0.5, 1, 0.5]);
  expect((await rack(page))?.rack?.rateWrites ?? 0).toBeGreaterThan(quiet);
  await shot(page, 'h74-rack-busy');
});

test('looking sends host.watch, looking away sends host.unwatch after the grace, a hidden tab and another floor at once', async ({ page }) => {
  test.setTimeout(150_000);
  await onLab(page);
  await faceRack(page);
  await expect.poll(async () => (await sent(page)).join()).toBe('host.watch');
  await expect.poll(async () => (await hostLog(page)).watching).toBe(true);
  // A glance away and back inside the grace changes nothing.
  await turnAway(page);
  await page.waitForTimeout(1500);
  await faceRack(page);
  await page.waitForTimeout(500);
  expect(await sent(page)).toEqual(['host.watch']);
  // Away for good: nothing for a while, then host.unwatch ~10 s after the rack left the view.
  await turnAway(page);
  await page.waitForTimeout(6000);
  expect(await sent(page)).toEqual(['host.watch']);
  await expect.poll(async () => (await sent(page)).join(), { timeout: 15_000 }).toBe('host.watch,host.unwatch');
  await expect.poll(async () => (await hostLog(page)).watching).toBe(false);
  // The last frame stays on the monitor, dimmed, and the LEDs calm down.
  expect((await rack(page))?.rack?.mode).toBe('dim');
  expect((await rack(page))?.rack?.leds.filter((l) => l.kind === 1)).toEqual([]);
  // Looking again watches again (the tab goes hidden while it does: at once).
  await faceRack(page);
  await expect.poll(async () => (await sent(page)).join()).toBe('host.watch,host.unwatch,host.watch');
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect.poll(async () => (await sent(page)).join()).toBe('host.watch,host.unwatch,host.watch,host.unwatch');
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await frames(page, 3);
  // Another floor ends a watch at once.
  await expect.poll(async () => (await sent(page)).at(-1)).toBe('host.watch');
  await page.evaluate(() => window.__h3d.enterFloor('pastry'));
  await expect.poll(async () => (await sent(page)).at(-1)).toBe('host.unwatch');
});

test('a bridge before host.watch shows the calm idle screen, never an error', async ({ page }) => {
  test.setTimeout(90_000);
  const clean = watchErrors(page);
  await onLab(page, `${SIM}&simfail=no_host`);
  await faceRack(page);
  await expect.poll(async () => (await rack(page))?.link.mode, { timeout: 15_000 }).toBe('unsupported');
  const r = await rack(page);
  expect(r?.rack?.lines).toEqual(['No host stats on this bridge']);
  await expect(page.locator('.prompt')).toContainText('No host stats on this bridge');
  await expect(page.locator('.toast:not([hidden])').filter({ hasText: /host|rack|unknown/i })).toHaveCount(0);
  await page.waitForTimeout(2000);
  expect(await sent(page)).toEqual(['host.watch']); // asked once, never again
  await shot(page, 'h74-rack-old-bridge');
  clean();
});

test('bench: the rack costs three draws a floor and no canvas or buffer work per frame', { tag: '@perf' }, async ({ page }) => {
  test.setTimeout(240_000);
  const clean = watchErrors(page);
  await onLab(page, 'play=none&sim=1&simms=150&simhostms=60000');
  await faceRack(page, 3, -0.1);
  await expect.poll(async () => (await rack(page))?.link.watching, { timeout: 15_000 }).toBe(true);
  await page.waitForTimeout(500);
  await frames(page, 4);
  await shot(page, 'h74-rack-perf');
  const bench = () => page.evaluate(() => window.__h3d.bench({ frames: 30, warm: 5, pipelined: false, raf: false, sway: false }));
  const before = (await rack(page)) as NonNullable<Awaited<ReturnType<typeof rack>>>;
  const on = await bench();
  const during = (await rack(page)) as typeof before;
  await page.evaluate(() => window.__h3d.rackShown(false));
  await frames(page, 3);
  const off = await bench();
  await page.evaluate(() => window.__h3d.rackShown(true));
  console.log(`h74 perf: ${on.drawCalls} draw calls with the rack (frame ${on.frameMs.med} ms), ${off.drawCalls} without (frame ${off.frameMs.med} ms)`);
  expect(on.drawCalls - off.drawCalls).toBeLessThanOrEqual(3);
  expect(on.drawCalls - off.drawCalls).toBeGreaterThanOrEqual(1);
  expect(before.rack?.drawCalls).toBe(3);
  // 30 rendered frames and the bridge's frames in between (the 1 s disk ones): the screen is drawn and the LED buffer written
  // per frame received, never per rendered frame.
  const stats = during.link.frames - before.link.frames;
  expect((during.rack?.draws ?? 0) - (before.rack?.draws ?? 0)).toBeLessThanOrEqual(stats);
  expect((during.rack?.rateWrites ?? 0) - (before.rack?.rateWrites ?? 0)).toBeLessThanOrEqual(10);
  expect(on.frameMs.med).toBeLessThan(off.frameMs.med * 1.5 + 5);
  clean();
});
