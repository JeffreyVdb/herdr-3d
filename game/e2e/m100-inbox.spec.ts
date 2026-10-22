import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type { Worker } from '../src/net/protocol';
import { frames, hideQuestions, openGame, openMenu, settingsSection, shot, watchErrors } from './game';

// #100 on demo-m5 with the simulator (it answers transcript.watch, so a plain sit opens the conversation) and the plan
// limits (tools/fixture-limits.ts): the inbox chip under the plate and its list. Work holds herdr-3d (top),
// depot-manager (asleep) and pastry; scratchpad is in the unassigned lot. Every blocked and done worker is set working
// first, so the inbox starts empty.

const SIM = 'play=none&sim=1&simms=150&simlimits=ok';

const workers = (): Worker[] => (JSON.parse(readFileSync(resolve(import.meta.dirname, '../fixtures/demo-m5.jsonl'), 'utf8').split('\n')[0] ?? '{}') as { world: { workers: Worker[] } }).world.workers;
const inbox = (page: Page) => page.evaluate(() => window.__h3d.inbox());
const pick = (all: Worker[], session: string, ws: string) => all.find((w) => w.session === session && w.workspace_id === ws)!;

/** A live `worker.status` for one worker, as the bridge would send it (each with the next seq). */
function statuses(page: Page): (w: Worker, status: string) => Promise<void> {
  let seq = 2_000_000;
  return async (w, status) => {
    await page.evaluate(([x, st, n]) => window.__h3d.inject({ t: 'worker.status', seq: n, id: x.id, session: x.session, workspace_id: x.workspace_id, status: st, prev_status: x.status, status_since: Date.now(), title: '' }), [w, status, seq++] as const);
  };
}

async function emptyInbox(page: Page, all: Worker[], setStatus: (w: Worker, s: string) => Promise<void>): Promise<void> {
  await openGame(page, 'demo-m5', '&prints=0', SIM);
  await expect.poll(async () => (await page.evaluate(() => window.__h3d.limits()))?.lines.length, { timeout: 10_000 }).toBe(2);
  for (const w of all) if (w.status === 'blocked' || w.status === 'done') await setStatus(w, 'working');
  await expect.poll(() => inbox(page)).toMatchObject({ shown: false, count: 0 });
}

test('the inbox: the chip opens a list of who and where across the buildings, live; a row seats you at that laptop', { tag: '@smoke' }, async ({ page }) => {
  test.setTimeout(180_000);
  const clean = watchErrors(page);
  const all = workers();
  const setStatus = statuses(page);
  await emptyInbox(page, all, setStatus);
  // Nothing pending: no chip, not even "Inbox 0".
  const box = page.locator('.inbox');
  const chip = page.locator('.ib-chip');
  await expect(box).toBeHidden();

  // On herdr-3d (Work): the lot's changelog needs you, then bridge-ws here and inventory on pastry finish.
  await page.evaluate(() => window.__h3d.enterFloor('herdr-3d'));
  await frames(page, 3);
  const lot = pick(all, 'scratchpad', 'w3');
  const here = pick(all, 'herdr-3d', 'w6');
  const baker = pick(all, 'pastry', 'wb');
  await setStatus(lot, 'blocked');
  await setStatus(here, 'done');
  await setStatus(baker, 'done');
  await expect.poll(() => inbox(page)).toMatchObject({ shown: true, count: 3, blocked: true, open: false });
  await expect(chip).toHaveText('Inbox3');

  // Under the plate, right edges aligned, not overlapping it.
  const plate = (await page.locator('.limits').boundingBox())!;
  let at = (await box.boundingBox())!;
  expect(at.y).toBeGreaterThanOrEqual(plate.y + plate.height);
  expect(at.y - (plate.y + plate.height)).toBeLessThan(12);
  expect(Math.abs(at.x + at.width - (plate.x + plate.width))).toBeLessThan(1);
  console.log(`chip shot: ${await shot(page, 'm100-inbox-chip')}`);

  // A click opens the list: needs you first, then finished, oldest first, each with where it is; the mouse is not grabbed.
  await chip.click();
  await expect.poll(() => inbox(page)).toMatchObject({ open: true });
  const rows = page.locator('.ib-row');
  await expect(rows).toHaveCount(3);
  const shown = async () => (await inbox(page))!.rows.map((r) => [r.id, r.where, r.reason]);
  expect(await shown()).toEqual([
    [lot.id, 'Unassigned › scratchpad', 'Needs you'],
    [here.id, 'Work › herdr-3d', 'Finished'],
    [baker.id, 'Work › pastry', 'Finished'],
  ]);
  expect(await page.evaluate(() => document.pointerLockElement)).toBeNull();

  // Live: nutrition on pastry needs you, and its row comes in after the lot's (needs you, oldest first).
  const nutrition = pick(all, 'pastry', 'w7');
  await setStatus(nutrition, 'blocked');
  await expect(rows).toHaveCount(4);
  expect((await shown())[1]).toEqual([nutrition.id, 'Work › pastry', 'Needs you']);
  await expect(chip).toHaveText('Inbox4');
  // It fits the 1280 px window under the plate, the plate untouched.
  at = (await box.boundingBox())!;
  expect(at.x).toBeGreaterThan(0);
  expect(at.x + at.width).toBeLessThanOrEqual(1280);
  expect(at.y).toBeGreaterThanOrEqual(plate.y + plate.height);
  await expect(rows.nth(1).locator('.ib-name')).toBeVisible();
  console.log(`list shot: ${await shot(page, 'm100-inbox-list')}`);

  // Esc shuts it (opened with the mouse, wherever the focus is).
  await page.keyboard.press('Escape');
  await expect.poll(() => inbox(page)).toMatchObject({ open: false });
  // By keyboard: Enter opens it, Esc gives the focus back to the chip; the arrows open it and walk in.
  await chip.focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => inbox(page)).toMatchObject({ open: true });
  await page.keyboard.press('Escape');
  await expect.poll(() => inbox(page)).toMatchObject({ open: false });
  expect(await page.evaluate(() => document.activeElement?.classList.contains('ib-chip'))).toBe(true);
  await page.keyboard.press('ArrowDown');
  await expect.poll(() => inbox(page)).toMatchObject({ open: true });
  expect(await page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.id)).toBe(lot.id);
  // A click elsewhere shuts it.
  await page.mouse.click(400, 500);
  await expect.poll(() => inbox(page)).toMatchObject({ open: false });
  await page.evaluate(() => document.exitPointerLock());

  // A row's click: straight to pastry (no elevator), seated at nutrition's laptop with its conversation on screen.
  await chip.click();
  await rows.nth(1).click();
  await expect.poll(() => page.evaluate(() => window.__h3d.seated()), { timeout: 20_000 }).toBe(nutrition.id);
  expect(await page.evaluate(() => [window.__h3d.where()?.loaded, window.__h3d.pose()?.floor, window.__h3d.panel(), document.pointerLockElement])).toEqual(['pastry', 'pastry', null, null]);
  await expect.poll(() => page.evaluate(() => window.__h3d.seat().mode)).toBe('transcript');
  await expect(page.locator('.seat-transcript')).toBeVisible();
  // Seated, the inbox is out of the way, like the plate.
  await expect(box).toBeHidden();
  // #187: nutrition's question opened the questions' sheet (its Esc closes it, the next one stands you up).
  await hideQuestions(page, nutrition.id);

  // Plain E still sits you down to its conversation (the inbox's view was for that sit only).
  await page.keyboard.press('Escape');
  await expect.poll(() => page.evaluate(() => window.__h3d.seated())).toBeNull();
  expect(await page.evaluate((id) => window.__h3d.sitAt(id), nutrition.id)).toBe(true);
  await expect.poll(() => page.evaluate(() => window.__h3d.seat().mode)).toBe('transcript');
  await page.keyboard.press('Escape');
  await expect.poll(() => page.evaluate(() => window.__h3d.seated())).toBeNull();

  // Resolving drops the rows, then the chip.
  await setStatus(nutrition, 'working');
  await expect.poll(() => inbox(page)).toMatchObject({ count: 3 });
  for (const w of [lot, here]) await setStatus(w, 'working');
  await expect.poll(() => inbox(page)).toMatchObject({ shown: true, count: 1, blocked: false });
  await expect(box).toHaveAttribute('data-blocked', 'false');
  await setStatus(baker, 'working');
  await expect.poll(() => inbox(page)).toMatchObject({ shown: false, count: 0 });
  await expect(box).toBeHidden();
  clean();
});

test('the inbox takes the plate’s spot when the plate is switched off, and Settings → Display hides it', async ({ page }) => {
  test.setTimeout(120_000);
  await page.addInitScript(() => localStorage.setItem('h3d.limits.hidden', '1'));
  const clean = watchErrors(page);
  await openGame(page, 'demo-m5', '&prints=0', SIM);
  await expect.poll(() => inbox(page)).toMatchObject({ shown: true });
  await expect(page.locator('.limits')).toBeHidden();
  const at = (await page.locator('.inbox').boundingBox())!;
  const bar = (await page.locator('.topbar').boundingBox())!;
  expect(at.y - (bar.y + bar.height)).toBeLessThan(12);
  expect(at.x + at.width).toBeGreaterThan(1280 - 16);

  // Show inbox off (Settings → Display): the chip goes, and that is remembered; on again, it is back.
  await openMenu(page);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await settingsSection(page, 'display'); // #49: one section at a time
  const sw = page.locator('#settings-inbox');
  await expect(sw).toBeChecked();
  await sw.uncheck();
  await expect.poll(() => inbox(page)).toMatchObject({ shown: false });
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('h3d.inbox') ?? '{}').show)).toBe(false);
  await page.keyboard.press('Escape');
  await expect.poll(() => inbox(page)).toMatchObject({ shown: false });
  await openMenu(page);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await settingsSection(page, 'display');
  await sw.check();
  await page.keyboard.press('Escape');
  await expect.poll(() => inbox(page)).toMatchObject({ shown: true });
  clean();
});

test('dismiss: a finished row’s × hides it (via the bridge), a click on one reads it, a new done brings it back; needs-you rows have neither', async ({ page }) => {
  test.setTimeout(180_000);
  const clean = watchErrors(page);
  const all = workers();
  const setStatus = statuses(page);
  await emptyInbox(page, all, setStatus);
  const sim = (w: Worker, status: string) => page.evaluate(([id, st]) => window.__h3d.simStatus(id, st), [w.id, status] as const);
  const dismissals = () => page.evaluate(() => window.__h3d.sent().filter((c) => c.t === 'inbox.dismiss'));
  const since = (w: Worker) => page.evaluate((id) => window.__h3d.inboxItems().find((x) => x.id === id)?.since, w.id);

  await page.evaluate(() => window.__h3d.enterFloor('herdr-3d'));
  await frames(page, 3);
  const lot = pick(all, 'scratchpad', 'w3');
  const here = pick(all, 'herdr-3d', 'w6');
  const baker = pick(all, 'pastry', 'wb');
  const marble = pick(all, 'pastry', 'w3');
  expect(await sim(lot, 'blocked')).toBe(true);
  for (const w of [here, baker, marble]) expect(await sim(w, 'done')).toBe(true);
  await expect.poll(() => inbox(page)).toMatchObject({ shown: true, count: 4, blocked: true });
  await page.locator('.ib-chip').click();
  const rows = page.locator('.ib-row');
  await expect(rows).toHaveCount(4);

  // A × on every finished row and none on the row that needs you; a real, named button, drawn without hover.
  expect((await inbox(page))!.rows.map((r) => [r.id, r.dismissable])).toEqual([[lot.id, false], [here.id, true], [baker.id, true], [marble.id, true]]);
  await expect(page.locator('.ib-x')).toHaveCount(3);
  await expect(page.locator(`.ib-item:has(.ib-row[data-id="${lot.id}"]) .ib-x`)).toHaveCount(0);
  await expect(page.locator(`.ib-x[data-id="${here.id}"]`)).toHaveAttribute('aria-label', /^Dismiss \S+/);
  await expect(page.locator(`.ib-x[data-id="${here.id}"]`)).toBeVisible();
  console.log(`dismiss shot: ${await shot(page, 'm106-inbox-dismiss')}`);

  // The × hides the row for good: the bridge records it, says so, the row and the count go; the click did not go to the worker.
  const hereSince = (await since(here))!;
  await page.locator(`.ib-x[data-id="${here.id}"]`).click();
  await expect(rows).toHaveCount(3);
  expect((await inbox(page))!.rows.map((r) => r.id)).toEqual([lot.id, baker.id, marble.id]);
  await expect(page.locator('.ib-chip')).toHaveText('Inbox3');
  expect(await dismissals()).toMatchObject([{ t: 'inbox.dismiss', args: { id: here.id, status_since: hereSince }, result: { ok: true, data: { dismissed: true } } }]);
  expect(await page.evaluate(() => [window.__h3d.seated(), window.__h3d.where()?.loaded])).toEqual([null, 'herdr-3d']);
  expect((await inbox(page))!.open).toBe(true);

  // Another browser's dismissal arrives as an event: the row goes here too.
  await page.evaluate(([id, st, n]) => window.__h3d.inject({ t: 'inbox.dismissed', seq: n, id, status_since: st }), [marble.id, (await since(marble))!, 3_000_000] as const);
  await expect.poll(async () => (await inbox(page))!.rows.map((r) => r.id)).toEqual([lot.id, baker.id]);

  // By keyboard: the arrows walk each row and then its ×; Enter dismisses; the focus lands on a neighbour, not the page.
  await page.locator(`.ib-row[data-id="${baker.id}"]`).focus();
  await page.keyboard.press('ArrowDown');
  expect(await page.evaluate(() => (document.activeElement as HTMLElement).dataset.key)).toBe(`x:${baker.id}`);
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await inbox(page))!.rows.map((r) => r.id)).toEqual([lot.id]);
  expect(await page.evaluate(() => (document.activeElement as HTMLElement).dataset.key)).toBe(`row:${lot.id}`);

  // Its next working → done is a new episode: the row is back (and a × on it with a new since).
  expect(await sim(here, 'working')).toBe(true);
  expect(await sim(here, 'done')).toBe(true);
  await expect.poll(async () => (await inbox(page))!.rows.map((r) => r.id)).toEqual([lot.id, here.id]);
  expect((await since(here))!).toBeGreaterThan(hereSince);

  // A needs-you row is not read by being gone to: it stays; a finished row is read: it goes.
  await rows.first().click();
  await expect.poll(() => page.evaluate(() => window.__h3d.seated()), { timeout: 20_000 }).toBe(lot.id);
  expect((await inbox(page))!.count).toBe(2);
  await page.keyboard.press('Escape');
  await expect.poll(() => page.evaluate(() => window.__h3d.seated())).toBeNull();
  await page.locator('.ib-chip').click();
  await page.locator(`.ib-row[data-id="${here.id}"]`).click();
  await expect.poll(() => page.evaluate(() => window.__h3d.seated()), { timeout: 20_000 }).toBe(here.id);
  await expect.poll(async () => (await inbox(page))!.count).toBe(1);
  expect((await dismissals()).at(-1)).toMatchObject({ args: { id: here.id }, result: { ok: true } });
  await page.keyboard.press('Escape');
  await expect.poll(() => page.evaluate(() => window.__h3d.seated())).toBeNull();
  await page.locator('.ib-chip').click();
  expect((await inbox(page))!.rows.map((r) => [r.id, r.reason])).toEqual([[lot.id, 'Needs you']]);
  clean();
});
