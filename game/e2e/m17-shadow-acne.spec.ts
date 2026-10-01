import { expect, test, type Page } from '@playwright/test';
import { PNG } from 'pngjs';
import { frames, openGame, watchErrors } from './game';
import { pixelStats, stripeScore, type Rect } from './pixels';

// #86: with a latitude the sun sweeps the sky (M17), and every wall spends the day at grazing angles or with its back
// to the sun. The sun's shadow map then striped the faces turned away from it: the sofa, the whiteboard, the board
// partition, the city's walls. Each test pins one time at lat 51 (Europe/Brussels, 1 Oct), stands where the issue saw
// the stripes and scores plain stretches of those surfaces for vertical stripes (`stripeScore`: luma turning back on
// itself along a row; a flat surface and a lone shadow edge score ~0, acne tens). demo-m3b, floor herdr-3d, the
// default 1280x720 viewport: the rectangles are in its pixels, picked on surfaces with nothing drawn on them.

const DAY = '2026-10-01';
const TIMES = ['09:00', '11:00', '13:00', '15:00', '17:00'] as const;

/** Where to stand: the issue's poses. Facing -z (yaw 0) at the north wall, +z (yaw π) at the partition's desk side, and at the lounge. */
const POSE = {
  whiteboard: { x: 10, z: 3.5, yaw: 0, pitch: 0.05 },
  partition: { x: 9, z: 9.5, yaw: Math.PI, pitch: 0.05 },
  sofa: { x: 2.2, z: 4.2, yaw: 0, pitch: -0.25 },
} as const;

/** Plain stretches: the whiteboard's right margin, the partition's navy above and beside the clock and below the cards, the sofa's back, the city's west wall of the top building. */
const RECT = {
  whiteboard: [836, 296, 876, 476],
  partitionTop: [20, 275, 260, 350],
  partitionLow: [20, 545, 470, 590],
  sofaBack: [460, 340, 810, 372],
  cityWall: [160, 270, 320, 450],
} as const satisfies Record<string, Rect>;

/** Acne scores in the tens along a row (the old code: 10 to 150); legitimate shadow edges and anti-aliasing stay under 1. */
const MAX_STRIPES = 2;
/** The city's wall also holds window ledges and the floors' edges: a looser bound, the old code scored 14. */
const MAX_CITY_STRIPES = 5;

const canvas = async (page: Page) => PNG.sync.read(await page.screenshot({ style: '.hud, #debug { visibility: hidden !important; }' }));

async function stand(page: Page, at: keyof typeof POSE): Promise<PNG> {
  await page.evaluate((p) => window.__h3d.setPose(p), POSE[at]);
  await frames(page, 6);
  return canvas(page);
}

function expectFlat(png: PNG, what: string, rect: Rect, max = MAX_STRIPES): void {
  const score = stripeScore(png.data, png.width, rect);
  expect(score, `${what}: vertical stripes (score ${score.toFixed(2)}, rect ${rect.join(',')})`).toBeLessThan(max);
}

for (const hhmm of TIMES) {
  test(`no shadow acne at ${hhmm} (lat 51): city, whiteboard, partition, sofa`, async ({ page }) => {
    test.setTimeout(180_000);
    const clean = watchErrors(page);
    await openGame(page, 'demo-m3b', `&time=${DAY}T${hhmm}&tz=Europe/Brussels&lat=51`);
    await frames(page, 6);
    // The city: the walls of the dollhouses, from the default camera.
    expectFlat(await canvas(page), 'the city wall', RECT.cityWall, MAX_CITY_STRIPES);
    await page.evaluate(() => window.__h3d.enterFloor('herdr-3d'));
    expectFlat(await stand(page, 'whiteboard'), 'the whiteboard', RECT.whiteboard);
    const partition = await stand(page, 'partition');
    expectFlat(partition, 'the partition (above)', RECT.partitionTop);
    // Low on the partition the characters' own shadows fall at 09:00: a lone shadow edge scores ~0, but keep it to the hours it is bare.
    if (hhmm !== '09:00') expectFlat(partition, 'the partition (below)', RECT.partitionLow);
    expectFlat(await stand(page, 'sofa'), 'the sofa', RECT.sofaBack);
    clean();
  });
}

test('shadows of the mullions and desks still fall on the floor under a low sun', async ({ page }) => {
  test.setTimeout(180_000);
  const clean = watchErrors(page);
  await openGame(page, 'demo-m3b', `&time=${DAY}T15:00&tz=Europe/Brussels&lat=51`);
  await page.evaluate(() => window.__h3d.enterFloor('herdr-3d'));
  const png = await stand(page, 'whiteboard');
  // The floor strip under the wall: lit boards and about 800 here: the dark shadow of the window frames and the desks across it (a bare floor scores ~0).
  const floor = new Uint8Array(png.width * 90 * 4);
  floor.set(png.data.subarray(630 * png.width * 4, 720 * png.width * 4));
  expect(pixelStats(floor).variance, 'the floor strip has both lit and shadowed parts').toBeGreaterThan(300);
  clean();
});
