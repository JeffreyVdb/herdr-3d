import { expect, test, type Page } from '@playwright/test';
import { PNG } from 'pngjs';
import { frames, openGame, shot, watchErrors } from './game';
import { pixelStats } from './pixels';

// M17 (#50): day and night follow the operator's local time; the office has a wall clock. Nothing here reads the wall
// clock: a time is pinned with `?time=` (the override path) or the browser's clock is fixed with `page.clock` and the
// zone set with `timezoneId` (the real-clock path). demo-m3b: herdr-3d on top and pastry at the bottom run,
// depot-manager in the middle sleeps.

type Info = NonNullable<ReturnType<Window['__h3d']['daylight']>>;
const info = (page: Page): Promise<Info> => page.evaluate(() => window.__h3d.daylight() as Info);
const clock = (page: Page) => page.evaluate(() => window.__h3d.clock());

/** Stands `back` m north of the wall clock, facing it (the desks' side of the board partition). */
async function faceClock(page: Page, session: string, back = 2.4): Promise<void> {
  const box = await page.evaluate((s) => window.__h3d.layout(s)?.props.find((p) => p.id === 'clock')?.box ?? null, session);
  expect(box, 'the floor has a clock').not.toBeNull();
  const b = box as NonNullable<typeof box>;
  await page.evaluate(({ x, z }) => window.__h3d.setPose({ x, z, yaw: Math.PI, pitch: 0.12 }), { x: (b.min[0] + b.max[0]) / 2, z: b.min[2] - back });
  await frames(page, 4);
}

/** Mean luma (0–255) of the canvas alone, HUD hidden. */
async function luma(page: Page): Promise<number> {
  const png = await page.screenshot({ style: '.hud, #debug { visibility: hidden !important; }' });
  return pixelStats(PNG.sync.read(png).data).mean;
}

/** The same spot on a floor: the lounge side, looking east across the desks and out of the windows. */
async function standInRoom(page: Page, session: string): Promise<void> {
  await page.evaluate((s) => window.__h3d.enterFloor(s), session);
  const L = await page.evaluate((s) => window.__h3d.layout(s), session);
  await page.evaluate((d) => window.__h3d.setPose({ x: 2, z: d / 2, yaw: -Math.PI / 2, pitch: 0.05 }), (L as NonNullable<typeof L>).depth);
  await frames(page, 6);
}

/** On the far sidewalk, looking back at the building. */
async function standOnStreet(page: Page): Promise<void> {
  const b = (await page.evaluate(() => window.__h3d.building())) as unknown as { width: number; road: { z1: number } };
  await page.evaluate(({ x, z }) => window.__h3d.setPose({ x, z, y: 0, yaw: 0, pitch: 0.3 }), { x: b.width / 2, z: b.road.z1 + 2.5 });
  await frames(page, 6);
}

for (const [when, time] of [
  ['day', '12:00'],
  ['night', '23:00'],
] as const) {
  test(`${when} (?time=${time}): the city, a running floor, the clock, the street`, async ({ page }) => {
    test.setTimeout(180_000);
    const clean = watchErrors(page);
    await openGame(page, 'demo-m3b', `&time=2026-09-30T${time}&tz=Europe/Brussels`);
    // A pinned time starts where it stays: no easing from noon.
    const i = await info(page);
    expect(i).toMatchObject({ pinned: true, zone: 'Europe/Brussels', zoneSource: 'override', model: 'fixed', daylight: when === 'day' ? 1 : 0, target: when === 'day' ? 1 : 0 });
    expect(await clock(page)).toBe(`${time} · Wed 30 Sep`);
    await frames(page, 4);
    await shot(page, `m17-${when}-city`);
    await standInRoom(page, 'herdr-3d');
    const room = await info(page);
    // The lamps: two, on in both, fuller at night.
    expect(room.lamps).toHaveLength(2);
    if (when === 'night') expect(room.lamps[0]).toBeGreaterThan(50);
    else expect(room.lamps[0]).toBeLessThan(30);
    await shot(page, `m17-${when}-floor`);
    await faceClock(page, 'herdr-3d');
    expect(await page.evaluate(() => window.__h3d.lookAt())).toMatchObject({ kind: 'prop', id: 'clock' });
    // The bar names it and says what it shows; no key, no "Placeholder until".
    const bar = page.locator('.prompt');
    await expect(bar).toContainText('Clock');
    await expect(bar).toContainText(`${time} ·`);
    await expect(bar).toContainText('Europe/Brussels');
    await expect(bar).not.toContainText('Placeholder');
    await expect(bar.locator('kbd')).toHaveCount(0);
    expect((await info(page)).face).toMatchObject({ time, day: when === 'day' });
    await shot(page, `m17-${when}-clock`);
    await standOnStreet(page);
    await shot(page, `m17-${when}-street`);
    clean();
  });
}

test('an asleep floor is darker than a running one, by day and at night; night is darker than day', async ({ page }) => {
  test.setTimeout(180_000);
  const clean = watchErrors(page);
  const lumas: Record<string, number> = {};
  for (const time of ['12:00', '23:00']) {
    await openGame(page, 'demo-m3b', `&time=2026-09-30T${time}&tz=Europe/Brussels`);
    for (const s of ['pastry', 'depot-manager']) {
      await standInRoom(page, s);
      lumas[`${time} ${s}`] = await luma(page);
    }
  }
  console.log(`m17 luma: ${JSON.stringify(lumas)}`);
  const L = (k: string) => lumas[k] as number;
  expect(L('12:00 depot-manager')).toBeLessThan(L('12:00 pastry') * 0.75);
  expect(L('23:00 depot-manager')).toBeLessThan(L('23:00 pastry') * 0.75);
  expect(L('23:00 pastry')).toBeLessThan(L('12:00 pastry'));
  // Night + asleep: nearly black; day + asleep: dim but there.
  expect(L('23:00 depot-manager')).toBeLessThan(30);
  expect(L('12:00 depot-manager')).toBeGreaterThan(L('23:00 depot-manager') * 1.5);
  clean();
});

test('?lat= makes a Brussels June evening light and leaves December dark; without it the fixed curve', async ({ page }) => {
  const clean = watchErrors(page);
  const at = async (q: string) => {
    await openGame(page, 'demo-m3b', `&tz=Europe/Brussels&${q}`);
    return info(page);
  };
  expect(await at('time=2026-06-21T20:00&lat=50.85')).toMatchObject({ model: 'latitude', latitude: 50.85, daylight: 1 });
  expect(await at('time=2026-12-21T17:00&lat=50.85')).toMatchObject({ model: 'latitude', daylight: 0 });
  expect(await at('time=2026-06-21T20:00')).toMatchObject({ model: 'fixed', latitude: null, daylight: 0 });
  // An invalid override is ignored with a warning: the real clock and the browser's zone.
  expect(await at('time=25:61&lat=north')).toMatchObject({ pinned: false, latitude: null });
  clean();
});

test.describe('the real clock (page.clock, Brussels)', () => {
  test.use({ timezoneId: 'Europe/Brussels' });

  test('the clock shows the local hour and date, rolls over midnight without a reload and eases into the day', async ({ page }) => {
    test.setTimeout(180_000);
    const clean = watchErrors(page);
    // 23:59:40 on Wed 30 Sep in Brussels.
    await page.clock.setFixedTime(new Date('2026-09-30T21:59:40Z'));
    await page.goto(`/?backend=webgl2&ws=${encodeURIComponent('/fixture/demo-m3b?play=none')}`);
    await page.waitForFunction(() => window.__h3d?.ready && window.__h3d.frames >= 3, undefined, { timeout: 60_000 });
    expect(await clock(page)).toBe('23:59 · Wed 30 Sep');
    expect(await info(page)).toMatchObject({ pinned: false, zone: 'Europe/Brussels', zoneSource: 'browser', daylight: 0 });
    await page.evaluate(() => window.__h3d.enterFloor('herdr-3d'));
    await faceClock(page, 'herdr-3d');
    // The minute turns: the clock and the date follow, the face redrawn.
    await page.clock.setFixedTime(new Date('2026-09-30T22:00:05Z'));
    await expect.poll(() => clock(page), { timeout: 15_000 }).toBe('00:00 · Thu 1 Oct');
    await expect.poll(async () => (await info(page)).face, { timeout: 15_000 }).toMatchObject({ time: '00:00', date: 'Thu 1 Oct' });
    // Jump to 12:30 (the tab coming back after hours, say): the light eases up, it does not pop.
    await page.clock.setFixedTime(new Date('2026-10-01T10:30:00Z'));
    await expect.poll(async () => (await info(page)).target, { timeout: 15_000 }).toBe(1);
    const seen: number[] = [];
    for (let i = 0; i < 40 && (seen.at(-1) ?? 0) < 1; i++) {
      seen.push((await info(page)).daylight);
      await page.waitForTimeout(150);
    }
    expect(seen.some((v) => v > 0.05 && v < 0.95), `eased through ${JSON.stringify(seen)}`).toBe(true);
    await expect.poll(async () => (await info(page)).daylight, { timeout: 20_000 }).toBe(1);
    clean();
  });

  test('?tz= and the Settings field move the clock live; a bad zone is refused where it was typed and not kept', async ({ page }) => {
    test.setTimeout(120_000);
    const clean = watchErrors(page);
    await page.clock.setFixedTime(new Date('2026-09-30T12:05:00Z'));
    await page.goto(`/?backend=webgl2&tz=Asia/Tokyo&ws=${encodeURIComponent('/fixture/demo-m3b?play=none')}`);
    await page.waitForFunction(() => window.__h3d?.ready && window.__h3d.frames >= 3, undefined, { timeout: 60_000 });
    expect(await clock(page)).toBe('21:05 · Wed 30 Sep');

    await page.goto(`/?backend=webgl2&ws=${encodeURIComponent('/fixture/demo-m3b?play=none')}`);
    await page.waitForFunction(() => window.__h3d?.ready && window.__h3d.frames >= 3, undefined, { timeout: 60_000 });
    expect(await clock(page)).toBe('14:05 · Wed 30 Sep');
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Settings' });
    const zone = dialog.getByLabel('Timezone');
    await expect(dialog.getByText('In effect: Europe/Brussels, this browser’s zone.')).toBeVisible();
    // Refused: an offset, then a made-up place. Nothing stored, the clock unchanged.
    await zone.fill('+02:00');
    await zone.press('Enter');
    await expect(zone).toHaveAttribute('aria-invalid', 'true');
    await expect(dialog.getByText('A place name, not an offset', { exact: false })).toBeVisible();
    await zone.fill('Mars/Olympus');
    await zone.press('Enter');
    await expect(dialog.getByText('This browser does not know “Mars/Olympus”', { exact: false })).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem('h3d.time.zone'))).toBeNull();
    expect(await clock(page)).toBe('14:05 · Wed 30 Sep');
    // Accepted: New York, live, no reload.
    await zone.fill('America/New_York');
    await zone.press('Enter');
    await expect(zone).toHaveAttribute('aria-invalid', 'false');
    await expect(dialog.getByText('In effect: America/New_York.')).toBeVisible();
    await expect.poll(() => clock(page)).toBe('08:05 · Wed 30 Sep');
    expect(await page.evaluate(() => localStorage.getItem('h3d.time.zone'))).toBe('America/New_York');
    // Latitude: a bad one refused, a good one kept.
    const lat = dialog.getByLabel('Latitude');
    await lat.fill('123');
    await lat.press('Enter');
    await expect(lat).toHaveAttribute('aria-invalid', 'true');
    await lat.fill('50.85');
    await lat.press('Tab');
    await expect(lat).toHaveAttribute('aria-invalid', 'false');
    await expect.poll(async () => (await info(page)).latitude).toBe(50.85);
    await shot(page, 'm17-settings-time');
    // Cleared: back to the browser's zone.
    await zone.fill('');
    await zone.press('Enter');
    await expect.poll(() => clock(page)).toBe('14:05 · Wed 30 Sep');
    clean();
  });
});
