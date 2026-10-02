import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type { Worker } from '../src/net/protocol';
import { frames, openGame, shot, watchErrors } from './game';

// #100 on demo-m4 with the simulator and the plan limits (tools/fixture-limits.ts): the inbox chip under the plate.
// Work holds herdr-3d (top), depot-manager (asleep) and pastry; scratchpad is in the unassigned lot. Every blocked and
// done worker is set working first, so the inbox starts empty.

const SIM = 'play=none&sim=1&simms=150&simlimits=ok';

const workers = (): Worker[] => (JSON.parse(readFileSync(resolve(import.meta.dirname, '../fixtures/demo-m4.jsonl'), 'utf8').split('\n')[0] ?? '{}') as { world: { workers: Worker[] } }).world.workers;
const chip = (page: Page) => page.evaluate(() => window.__h3d.inbox());

/** A live `worker.status` for one worker, as the bridge would send it (each with the next seq). */
function statuses(page: Page): (w: Worker, status: string) => Promise<void> {
  let seq = 2_000_000;
  return async (w, status) => {
    await page.evaluate(([x, st, n]) => window.__h3d.inject({ t: 'worker.status', seq: n, id: x.id, session: x.session, workspace_id: x.workspace_id, status: st, prev_status: x.status, status_since: Date.now(), title: '' }), [w, status, seq++] as const);
  };
}

test('the inbox chip: hidden at zero, counts a live change anywhere, a click seats you at that laptop, it walks on and empties', async ({ page }) => {
  test.setTimeout(150_000);
  const clean = watchErrors(page);
  const all = workers();
  const setStatus = statuses(page);
  await openGame(page, 'demo-m4', '', SIM);
  await expect.poll(async () => (await page.evaluate(() => window.__h3d.limits()))?.lines.length, { timeout: 10_000 }).toBe(2);

  // Nothing pending: no chip, not even "Inbox 0".
  for (const w of all) if (w.status === 'blocked' || w.status === 'done') await setStatus(w, 'working');
  expect(await page.evaluate(() => window.__h3d.inboxItems())).toEqual([]);
  expect(await chip(page)).toEqual({ shown: false, count: 0, blocked: false });
  await expect(page.locator('.inbox')).toBeHidden();

  // On herdr-3d (Work), a worker in the lot needs you and one on pastry is done.
  await page.evaluate(() => window.__h3d.enterFloor('herdr-3d'));
  await frames(page, 3);
  const lot = all.find((w) => w.session === 'scratchpad' && w.workspace_id === 'w3')!;
  const baker = all.find((w) => w.session === 'pastry' && w.workspace_id === 'wb')!;
  await setStatus(lot, 'blocked');
  await expect.poll(() => chip(page)).toEqual({ shown: true, count: 1, blocked: true });
  await setStatus(baker, 'done');
  await expect.poll(() => chip(page)).toEqual({ shown: true, count: 2, blocked: true });
  const box = page.locator('.inbox');
  await expect(box).toHaveText('Inbox2');

  // Under the plate, right edges aligned, not overlapping it.
  const plate = (await page.locator('.limits').boundingBox())!;
  const at = (await box.boundingBox())!;
  expect(at.y).toBeGreaterThanOrEqual(plate.y + plate.height);
  expect(at.y - (plate.y + plate.height)).toBeLessThan(12);
  expect(Math.abs(at.x + at.width - (plate.x + plate.width))).toBeLessThan(1);
  console.log(`inbox shot: ${await shot(page, 'm100-inbox')}`);

  // The click teleports to the lot (the first: needs you before done) and sits at its laptop; the mouse is not grabbed.
  await box.click();
  await expect.poll(() => page.evaluate(() => window.__h3d.seated()), { timeout: 20_000 }).toBe(lot.id);
  expect(await page.evaluate(() => [window.__h3d.where()?.loaded, window.__h3d.pose()?.floor, window.__h3d.panel(), document.pointerLockElement])).toEqual(['scratchpad', 'scratchpad', null, null]);
  // Seated, the chip is out of the way, like the plate.
  await expect(box).toBeHidden();

  // Up again, still pending: the next click goes on to pastry's finished worker.
  await page.keyboard.press('Escape');
  await expect(box).toBeVisible();
  await box.click();
  await expect.poll(() => page.evaluate(() => window.__h3d.seated()), { timeout: 20_000 }).toBe(baker.id);
  expect(await page.evaluate(() => window.__h3d.where()?.loaded)).toBe('pastry');
  await page.keyboard.press('Escape');

  // Resolving them empties it.
  await setStatus(lot, 'working');
  await expect.poll(() => chip(page)).toEqual({ shown: true, count: 1, blocked: false });
  await expect(box).toHaveText('Inbox1');
  await expect(box).toHaveAttribute('data-blocked', 'false');
  await setStatus(baker, 'working');
  await expect.poll(() => chip(page)).toEqual({ shown: false, count: 0, blocked: false });
  await expect(box).toBeHidden();
  clean();
});

test('the inbox chip takes the plate’s spot when the plate is switched off', async ({ page }) => {
  test.setTimeout(120_000);
  await page.addInitScript(() => localStorage.setItem('h3d.limits.hidden', '1'));
  const clean = watchErrors(page);
  await openGame(page, 'demo-m4', '', SIM);
  await expect.poll(() => chip(page)).toMatchObject({ shown: true });
  await expect(page.locator('.limits')).toBeHidden();
  const at = (await page.locator('.inbox').boundingBox())!;
  const bar = (await page.locator('.topbar').boundingBox())!;
  expect(at.y - (bar.y + bar.height)).toBeLessThan(12);
  expect(at.x + at.width).toBeGreaterThan(1280 - 16);
  clean();
});
