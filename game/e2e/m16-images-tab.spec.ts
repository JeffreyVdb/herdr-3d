import { expect, test, type Page } from '@playwright/test';
import { frames, hideQuestions, openGame, seatMode, shot, watchErrors } from './game';

// M16 phase 2: the Images tab, third mode of the seated view, for real on the WebGL2 path. demo-m5 with the simulating
// fixture server (sim=1): its demo timeline has real PNGs (tools/fixture-transcript.ts): the user sends a screenshot
// twice (so a x2 badge), one whose path is outside the bridge's roots (LOST, not available), the agent views two with a
// Read and generates two. You sit at Tofu, open the conversation, then the Images tab.

const FLOOR = 'herdr-3d';
const SIM = 'play=none&sim=1&simms=500&simusage=0';

type Tx = NonNullable<ReturnType<Window['__h3d']['transcript']>>;
const txState = (page: Page) => page.evaluate(() => window.__h3d.transcript()) as Promise<Tx>;
const sent = (page: Page) => page.evaluate(() => window.__h3d.sent());
/** The requests the game makes by itself (watches, the image feed), kept out of `sent()`. */
const watchLog = (page: Page) => page.evaluate(() => window.__h3d.watchLog());

async function sitAt(page: Page, name: string): Promise<string> {
  await openGame(page, 'demo-m5', '', SIM);
  await page.evaluate((s) => window.__h3d.enterFloor(s), FLOOR);
  await frames(page, 3);
  const id = await page.evaluate((n) => window.__h3d.world().flatMap((f) => f.workers).find((w) => w.name === n)?.id ?? '', name);
  expect(await page.evaluate((i) => window.__h3d.face(i), id), `facing ${name}`).toBe(true);
  await frames(page, 3);
  expect(await page.evaluate((w) => window.__h3d.sitAt(w), id)).toBe(true);
  await expect.poll(() => page.evaluate(() => window.__h3d.seated())).toBe(id);
  await expect(page.locator('.seat')).toBeVisible();
  await seatMode(page, 'transcript');
  await hideQuestions(page, id); // #187: Tofu's question opened the questions' sheet
  return id;
}

// A phone: every control of the lightbox is on the screen and can be hit (the Close button ran off the right edge).
test('the lightbox fits a 390 x 844 screen: zoom, copy, jump and close are all inside it', async ({ page }) => {
  test.setTimeout(120_000);
  const clean = watchErrors(page);
  await sitAt(page, 'Tofu');
  await page.setViewportSize({ width: 390, height: 844 });
  await frames(page, 6);
  // #98: the conversation is up as you sit.
  await seatMode(page, 'transcript');
  const box = page.locator('.seat-transcript');
  await expect.poll(async () => (await txState(page)).imageCount).toBeGreaterThan(0);
  await page.locator('.seat-rail').getByRole('tab', { name: /^Images/ }).click(); // #216: the rail
  await expect.poll(async () => (await txState(page)).mode).toBe('images');
  await expect.poll(async () => (await txState(page)).tabMounted, { message: 'the lazy Images view is mounted', timeout: 20_000 }).toBe(true);
  const tab = box.locator('.imgs');
  await tab.locator('.imgs-group[data-origin="input"] .imgs-item').first().locator('.imgs-tile').click();
  const lb = page.locator('dialog.ilb');
  await expect(lb).toBeVisible();
  await expect(lb.locator('.ilb-jump')).toBeVisible();
  await expect(lb.locator('.ilb-img.ilb-loading')).toHaveCount(0);
  const vp = page.viewportSize() as { width: number; height: number };
  const controls = await lb.locator('.ilb-btn, .ilb-nav').evaluateAll((els) =>
    els
      .filter((e) => getComputedStyle(e).display !== 'none' && !(e as HTMLElement).hidden)
      .map((e) => {
        const r = e.getBoundingClientRect();
        // What is at the middle of the control: the control itself (nothing covers it, it is not clipped).
        const at = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        return { cls: (e as HTMLElement).className, x0: r.left, y0: r.top, x1: r.right, y1: r.bottom, hit: !!at && (e === at || e.contains(at)) };
      }),
  );
  const names = controls.map((c) => c.cls);
  for (const want of ['ilb-zoom-out', 'ilb-zoom-in', 'ilb-fit', 'ilb-copy', 'ilb-jump', 'ilb-close']) expect(names.join(' '), `${want} is there`).toContain(want);
  for (const c of controls) {
    expect(c.x0, `${c.cls} left`).toBeGreaterThanOrEqual(0);
    expect(c.y0, `${c.cls} top`).toBeGreaterThanOrEqual(0);
    expect(c.x1, `${c.cls} right`).toBeLessThanOrEqual(vp.width);
    expect(c.y1, `${c.cls} bottom`).toBeLessThanOrEqual(vp.height);
    expect(c.hit, `${c.cls} can be hit`).toBe(true);
  }
  await shot(page, 'm16-lightbox-390');
  // Close closes (a tap on the button, not the Escape key).
  await lb.locator('.ilb-close').click();
  await expect(lb).toHaveCount(0);
  clean();
});

test('the Images tab: Input and Agent, deduped, lightbox, jump to message, live, and clean after standing up', async ({ page }) => {
  test.setTimeout(120_000);
  const clean = watchErrors(page);
  const worker = await sitAt(page, 'Tofu');
  await expect.poll(async () => (await txState(page)).items).toBeGreaterThan(10);

  // The conversation (#98: up as you sit), its strip led by its icon; #216: the rail's Images (its count) opens the tab.
  await seatMode(page, 'transcript');
  const box = page.locator('.seat-transcript');
  await expect(box.locator('.tx .tx-bar .seat-lead')).toBeVisible();
  await expect(page.locator('.seat-rail').getByRole('tab', { selected: true })).toHaveAttribute('data-mode', 'transcript');
  await expect.poll(async () => (await txState(page)).imageCount).toBeGreaterThan(0);
  await expect(page.locator('.seat-rail').getByRole('tab', { name: /^Images, \d+ images?$/ })).toBeVisible();
  await page.locator('.seat-rail').getByRole('tab', { name: /^Images/ }).click();
  await expect.poll(async () => (await txState(page)).mode).toBe('images');
  await expect.poll(async () => (await txState(page)).tabMounted, { message: 'the lazy Images view is mounted', timeout: 20_000 }).toBe(true);
  expect((await page.evaluate(() => window.__h3d.seat())).mode).toBe('images');
  const tab = box.locator('.imgs');
  await expect(tab).toBeVisible();
  await expect(box.locator('.tx')).toBeHidden();
  await expect(tab.locator('.imgs-bar .seat-lead')).toBeVisible();
  await expect(page.locator('.seat-rail').getByRole('tab', { selected: true })).toContainText('Images');
  await expect(page.locator('.seat-keys')).toContainText('Conversation');

  // Two groups. Input: the screenshot (sent twice: x2), the phone-sized one and the path that is not available.
  const input = tab.locator('.imgs-group[data-origin="input"] .imgs-item');
  const agent = tab.locator('.imgs-group[data-origin="agent"] .imgs-item');
  await expect(input).toHaveCount(3);
  await expect(agent).toHaveCount(4);
  await expect(tab.locator('.imgs-group[data-origin="input"] .imgs-n:not([hidden])')).toHaveText(['×2']);
  const lost = tab.locator('.imgs-group[data-origin="input"] .imgs-item-gone');
  await expect(lost).toHaveCount(1);
  await expect(lost).toContainText('Not available');
  await expect(lost.locator('.imgs-gone-path')).toHaveText('/etc/hosts.png');
  await expect(agent.locator('.imgs-kind')).toHaveText(['generated', 'generated', 'viewed', 'viewed']); // newest first
  // Thumbnails came through transcript.image and are real pictures.
  await expect.poll(() => tab.locator('img.imgs-img').evaluateAll((els) => els.filter((e) => (e as HTMLImageElement).naturalWidth > 0).length)).toBe(6);
  // (Desks near you may ask for their own prints' images: this worker's requests only.)
  const reads = (await watchLog(page)).filter((c) => (c.t === 'transcript.image' || c.t === 'transcript.images') && (c.args as { id: string }).id === worker);
  // The list is asked when the strip needs its count and again if the timeline's items changed it (a debounced few).
  expect(reads.filter((c) => c.t === 'transcript.images').length).toBeGreaterThanOrEqual(1);
  expect(reads.filter((c) => c.t === 'transcript.images').length).toBeLessThanOrEqual(3);
  expect(reads.filter((c) => c.t === 'transcript.image').every((c) => (c.args as { size: string }).size === 'thumb' && c.result?.ok)).toBe(true);
  await frames(page, 6);
  await shot(page, 'm16-images-tab');

  // Keys stay in the view: the flip key swaps the two ways to read, and nothing goes to the pane.
  const keysBefore = (await sent(page)).filter((c) => c.t === 'worker.keys').length;
  await page.keyboard.press('i');
  await expect.poll(async () => (await txState(page)).mode).toBe('transcript');
  await page.keyboard.press('i');
  await expect.poll(async () => (await txState(page)).mode).toBe('images');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowDown');
  expect((await sent(page)).filter((c) => c.t === 'worker.keys').length).toBe(keysBefore);
  expect((await txState(page)).counts.mounted).toBe(1); // the conversation was built once

  // The lightbox: the full image, zoom, copy; Esc closes only it.
  await input.first().locator('.imgs-tile').click();
  const lb = page.locator('dialog.ilb');
  await expect(lb).toBeVisible();
  await expect(lb.locator('.ilb-badge')).toHaveText('You sent');
  await expect.poll(async () => (await watchLog(page)).filter((c) => c.t === 'transcript.image' && (c.args as { size: string; id: string }).size === 'full' && (c.args as { id: string }).id === worker).length).toBe(1);
  await expect(lb.locator('.ilb-img.ilb-loading')).toHaveCount(0);
  await expect(lb.locator('.ilb-zoom-in')).toBeVisible();
  await expect(lb.locator('.ilb-copy')).toBeEnabled();
  await lb.locator('.ilb-zoom-in').click();
  await expect(lb.locator('.ilb-fit')).not.toHaveText('Fit');
  await page.keyboard.press('Escape');
  await expect(lb).toHaveCount(0);
  expect(await page.evaluate(() => window.__h3d.seated())).toBe(worker);
  expect((await txState(page)).mode).toBe('images');

  // The not-available tile opens a card with the path as text.
  await lost.locator('.imgs-tile').click();
  await expect(lb.locator('.ilb-card')).toContainText('Image not available');
  await expect(lb.locator('.ilb-card-path')).toHaveText('/etc/hosts.png');
  await page.keyboard.press('Escape');
  await expect(lb).toHaveCount(0);

  // Jump to message: what the agent viewed goes to the Read row that has it.
  await agent.filter({ has: page.locator('.imgs-kind', { hasText: 'viewed' }) }).first().locator('.imgs-tile').click();
  await expect(lb.locator('.ilb-badge')).toHaveText('Agent viewed');
  await lb.locator('.ilb-jump').click();
  await expect(lb).toHaveCount(0);
  await expect.poll(async () => (await txState(page)).mode).toBe('transcript');
  await expect(box.locator('[data-id="toolu_demo_read"].tx-flash')).toBeVisible();
  expect(await page.evaluate(() => window.__h3d.seated())).toBe(worker);

  // Live: a screenshot pasted into the worker shows up under Input within 3 s of the push.
  const fresh = await page.evaluate(() => window.__h3d.simImage({ origin: 'input', w: 400, h: 300, seed: 21 }));
  expect(fresh?.hash).toMatch(/^[0-9a-f]{64}$/);
  await page.keyboard.press('i');
  await expect.poll(async () => (await txState(page)).mode).toBe('images');
  await expect(input).toHaveCount(3);
  await page.evaluate(
    ([id, ref]) => window.__h3d.simTranscript({ id: id as string, items: [{ id: 'demo-new-shot', seq: 100, ts: Date.now(), kind: 'user', parts: [{ text: 'and this one' }, { image: ref }] }] }),
    [worker, fresh] as const,
  );
  await expect(input).toHaveCount(4, { timeout: 3000 });
  await expect(input.first().locator('img.imgs-img')).toHaveAttribute('src', /^blob:/);

  // Standing up leaves nothing: no overlay, tab, feed or watch.
  await page.keyboard.press('Escape');
  await expect.poll(() => page.evaluate(() => window.__h3d.seated())).toBeNull();
  expect(await page.locator('.seat-transcript').count()).toBe(0);
  await expect(page.locator('dialog.ilb')).toHaveCount(0);
  const c = (await txState(page)).counts;
  expect(c.tabsMounted).toBe(1);
  expect(c.tabsMounted).toBe(c.tabsDestroyed);
  expect(c.mounted).toBe(c.destroyed);
  expect(c.overlays).toBe(c.removed);
  clean();
});

test('sit / images / stand cycles leave no views, tabs, feeds or watches behind', async ({ page }) => {
  test.setTimeout(120_000);
  const clean = watchErrors(page);
  const worker = await sitAt(page, 'Nibble');
  // The print planner runs every 250 ms with hysteresis, so nearby desks can legitimately change between cycles.
  // Standing may keep exactly those desks' watches and feeds; no seated view's resources may remain beside them.
  for (let i = 0; i < 6; i++) {
    if (i > 0) {
      expect(await page.evaluate((w) => window.__h3d.sitAt(w), worker)).toBe(true);
      await expect.poll(() => page.evaluate(() => window.__h3d.seated())).toBe(worker);
    }
    await expect.poll(async () => (await txState(page)).watches).toBeGreaterThanOrEqual(1);
    // The last view is remembered per worker: the first sit is the conversation (#98), the others come back to the images.
    if ((await txState(page)).mode !== 'images') {
      await seatMode(page, 'transcript');
      await page.keyboard.press('i');
    }
    await expect.poll(async () => (await txState(page)).mode).not.toBe('terminal');
    await expect.poll(async () => (await txState(page)).tabMounted, { message: 'the lazy Images view is mounted', timeout: 20_000 }).toBe(true);
    await expect(page.locator('.seat-transcript .imgs')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect.poll(() => page.evaluate(() => window.__h3d.seated())).toBeNull();
    expect(await page.locator('.seat-transcript').count()).toBe(0);
    await expect.poll(() => page.evaluate(() => {
      const prints = window.__h3d.prints();
      const desks = (prints?.desks ?? []).map((desk) => desk.id).sort();
      return {
        watches: JSON.stringify([...(prints?.watches ?? [])].sort()) === JSON.stringify(desks),
        feeds: JSON.stringify(window.__h3d.imageFeeds().ids.sort()) === JSON.stringify(desks),
      };
    }), { message: 'only active print desks retain watches and image feeds after standing' }).toEqual({ watches: true, feeds: true });
  }
  const c = (await txState(page)).counts;
  expect(c.tabsMounted).toBe(6);
  expect(c.tabsMounted).toBe(c.tabsDestroyed);
  clean();
});
