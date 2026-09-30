import { expect, test, type Page } from '@playwright/test';
import { frames, openGame, shot, watchErrors } from './game';

// M16: the transcript mode of the seated view, for real, on the WebGL2 path: demo-m5 with the simulating fixture server
// (sim=1), which answers transcript.watch / page / item like herdr-world (tools/fixture-transcript.ts: a demo timeline
// of every item kind, in the bridge's shape; the subagent's page is the bridge's own output for its fixture). You sit
// at Tofu (a blocked claude, so the banner has a real question), Ctrl+Esc swaps the terminal for the conversation
// drawn over the monitor, and Ctrl+Esc brings the terminal back.

const FLOOR = 'herdr-3d';
const SIM = 'play=none&sim=1&simms=500&simusage=0';
const SUBAGENT = 'aa3716c63ba631707';

type Tx = NonNullable<ReturnType<Window['__h3d']['transcript']>>;
const txState = (page: Page) => page.evaluate(() => window.__h3d.transcript()) as Promise<Tx>;
const sent = (page: Page) => page.evaluate(() => window.__h3d.sent());
const watchLog = (page: Page) => page.evaluate(() => window.__h3d.watchLog());
/** The fps of the last terminal.watch the game sent for a worker. */
const termFps = async (page: Page, id: string) => ((await watchLog(page)).filter((c) => c.t === 'terminal.watch' && (c.args as { id: string }).id === id).at(-1)?.args as { fps?: number } | undefined)?.fps;

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
  await frames(page, 30);
  return id;
}

test('Ctrl+Esc at a seated laptop: the conversation over the monitor, fed by transcript.watch, and back', async ({ page }) => {
  test.setTimeout(120_000);
  const clean = watchErrors(page);
  const worker = await sitAt(page, 'Tofu');

  // Watched from the moment you sit (the first switch is instant), not counted as a terminal watch.
  await expect.poll(async () => (await txState(page)).items).toBeGreaterThan(10);
  expect(await txState(page)).toMatchObject({ mode: 'terminal', watches: 1, box: null, mounted: false });
  expect((await watchLog(page)).filter((c) => c.t === 'transcript.watch').map((c) => c.args)).toEqual([{ id: worker, limit: 200 }]);
  const seatedFps = await termFps(page, worker);
  expect(seatedFps).toBeGreaterThan(1);

  // Ctrl+Esc: the transcript, over the monitor's glass; the terminal behind it frozen and watched at 1 fps.
  await page.keyboard.press('Control+Escape');
  await expect.poll(async () => (await txState(page)).mounted).toBe(true);
  const st = await txState(page);
  expect(st.mode).toBe('transcript');
  expect((await page.evaluate(() => window.__h3d.seat())).mode).toBe('transcript');
  const tx = page.locator('.seat-transcript .tx');
  await expect(tx).toBeVisible();
  await expect.poll(() => termFps(page, worker)).toBe(1);
  await expect.poll(async () => (await page.evaluate(() => window.__h3d.screens())).find((s) => s.id === worker)?.state).toBe('frozen');

  // Right after Ctrl+Esc, with nothing clicked, the scroll keys work (the keyboard is on the timeline) and nothing
  // reaches the pane.
  const sentKeys = async () => (await sent(page)).filter((c) => c.t === 'worker.keys').length;
  const keysBefore = await sentKeys();
  const scroller = tx.locator('.tx-scroll');
  const scrollTop = () => scroller.evaluate((e) => e.scrollTop);
  await expect(tx.locator('.tx-user')).toBeVisible();
  await expect(scroller).toBeFocused();
  const bottom = await scrollTop();
  expect(bottom).toBeGreaterThan(0); // it follows: at the bottom
  await page.keyboard.press('Home');
  expect(await scrollTop()).toBe(0);
  await page.keyboard.press('j');
  expect(await scrollTop()).toBeGreaterThan(0);
  await page.keyboard.press('PageDown');
  await page.keyboard.press('End');
  expect(await scrollTop()).toBeGreaterThanOrEqual(bottom - 2);
  expect(await sentKeys()).toBe(keysBefore);

  // The overlay sits between the top bar and the seat bar, over the laptop the camera looks at.
  const box = (await txState(page)).box as NonNullable<Tx['box']>;
  const seatTop = await page.locator('.seat').evaluate((e) => e.getBoundingClientRect().top);
  const topbar = await page.evaluate(() => parseFloat(document.querySelector<HTMLElement>('.hud')?.style.getPropertyValue('--topbar-bottom') ?? '') || 70);
  const vw = page.viewportSize() as { width: number; height: number };
  expect(box.top).toBeGreaterThanOrEqual(Math.floor(topbar));
  expect(box.top + box.height).toBeLessThanOrEqual(Math.ceil(seatTop));
  expect(box.width).toBeGreaterThan(vw.width * 0.4);
  expect(box.height).toBeGreaterThan(vw.height * 0.3);
  expect(Math.abs(box.left + box.width / 2 - vw.width / 2)).toBeLessThan(vw.width * 0.1);

  // Nothing of the HUD (the plan limits widget hangs over the top right) covers the view's controls.
  const covered = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('.seat-transcript .tx-bar button, .seat-transcript .tx-send, .seat-transcript .tx-input')]
      .filter((e) => {
        const r = e.getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return !hit || !e.contains(hit);
      })
      .map((e) => e.className),
  );
  expect(covered).toEqual([]);

  // Rows: the bubble with the image placeholder, collapsed reasoning, tools, a divider; what the bridge hides waits
  // for "show system", its other notices show.
  await expect(tx.locator('.tx-user .tx-bubble')).toContainText('HUD overlaps');
  await expect(tx.locator('.tx-img-chip')).toHaveText(/image — not shown yet/);
  await expect(tx.locator('.tx-thinking-body')).toBeHidden();
  await expect(tx.locator('.tx-compaction')).toBeVisible();
  await expect(tx.locator('.tx-notice', { hasText: 'Interrupted by user' })).toBeVisible();
  await expect(tx.locator('.tx-notice', { hasText: 'Turn took 41s' })).toBeHidden();
  await expect(tx.locator('.tx-unknown')).toBeHidden();
  await expect(tx.locator('.tx-tool[data-status="running"] .tx-tool-status')).toHaveText('running');

  // The edit: a coloured diff with the file's line numbers (the bridge's snake_case hunks).
  await tx.locator('.tx-tool', { hasText: 'Edit' }).locator('.tx-tool-row').click();
  await expect(tx.locator('.tx-diff .tx-add')).toHaveCount(1);
  await expect(tx.locator('.tx-diff .tx-del')).toHaveCount(1);
  await expect(tx.locator('.tx-diff .tx-dh')).toHaveText('@@ -341,4 +341,4 @@');
  await expect(tx.locator('.tx-diff .tx-dl:not(.tx-dh) .tx-dn').first()).toHaveText('341');
  const addBg = await tx.locator('.tx-diff .tx-add').evaluate((e) => getComputedStyle(e).backgroundColor);
  const delBg = await tx.locator('.tx-diff .tx-del').evaluate((e) => getComputedStyle(e).backgroundColor);
  expect(addBg).not.toBe(delBg);
  // The failing command, ANSI stripped.
  await tx.locator('.tx-tool[data-status="error"] .tx-tool-row').click();
  await expect(tx.locator('.tx-tool[data-status="error"] .tx-out')).toContainText('FAIL  src/laptop/keys.test.ts');
  expect(await tx.locator('.tx-tool[data-status="error"] .tx-out').textContent()).not.toContain('\u001b');

  // The subagent: its own timeline over the wire, as transcript.page with agent.
  await tx.locator('.tx-sub-row').click();
  await expect(tx.locator('.tx-nested > .tx-item').first()).toBeVisible();
  const reads = (await sent(page)).filter((c) => c.t === 'transcript.page' || c.t === 'transcript.item');
  expect(reads.map((c) => ({ t: c.t, args: c.args, ok: c.result?.ok }))).toEqual([{ t: 'transcript.page', args: { id: worker, before: '', agent: SUBAGENT, limit: 500 }, ok: true }]);
  await expect(tx.locator('.tx-nested .tx-tool-name').first()).toHaveText('Bash');

  // Untrusted markdown: nothing ran, nothing live.
  expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
  expect(await tx.locator('script, img, [onerror], a[href^="javascript"]').count()).toBe(0);
  // Code blocks get highlighted once the lazy highlighter loads.
  await expect(tx.locator('.tx-said pre code.hljs')).toHaveCount(1, { timeout: 15_000 });

  // Tofu is blocked: the banner with its question's numbered chips.
  await expect(tx.locator('.tx-banner')).toBeVisible();
  await expect(tx.locator('.tx-banner')).toContainText('Do you want to proceed?');
  await expect(tx.locator('.tx-choice')).toHaveCount(3);

  // Framed on the diff, with the highlighted code block above it.
  await tx.locator('.tx-said pre').evaluate((e) => e.scrollIntoView({ block: 'start' }));
  await frames(page, 6);
  await shot(page, 'm16-transcript');

  // Live: the running tool's result is an update in place.
  await page.evaluate(() =>
    window.__h3d.simTranscript({
      id: window.__h3d.seated(),
      updates: [{ id: 'toolu_demo_bash2', seq: 14, ts: Date.now(), kind: 'tool', tool: { name: 'Bash', input_summary: 'pnpm vitest run src/laptop --reporter dot', status: 'ok', output_text: 'Tests  42 passed' } }],
    }),
  );
  await expect(tx.locator('[data-id="toolu_demo_bash2"]')).toHaveAttribute('data-status', 'ok');
  await expect(tx.locator('[data-id="toolu_demo_bash2"]')).toHaveCount(1);

  // Back to the terminal and again (Ctrl+Esc twice): the keyboard is on the timeline again, no click needed.
  await page.keyboard.press('Control+Escape');
  await expect.poll(async () => (await txState(page)).mode).toBe('terminal');
  await page.keyboard.press('Control+Escape');
  await expect.poll(async () => (await txState(page)).mode).toBe('transcript');
  await expect(scroller).toBeFocused();
  await page.keyboard.press('End');
  const end = await scrollTop();
  await page.keyboard.press('k');
  expect(await scrollTop()).toBeLessThan(end);
  await page.keyboard.press('End');

  // Tofu is blocked, so the prompt is off (the bridge would refuse it): Enter does not reach it, typing sends nothing.
  await expect(tx.locator('.tx-input')).toBeDisabled();
  await expect(tx.locator('.tx-send')).toBeDisabled();
  await page.keyboard.press('Enter');
  await expect(tx.locator('.tx-input')).not.toBeFocused();
  await page.keyboard.type('xyz');
  expect((await sent(page)).filter((c) => c.t === 'worker.prompt')).toEqual([]);

  // Scrolled up, a new item shows the chip instead of moving the view.
  await page.keyboard.press('Home');
  await page.evaluate(() => window.__h3d.simTranscript({ id: window.__h3d.seated(), items: [{ id: 'demo-99', seq: 99, ts: Date.now(), kind: 'assistant', parts: [{ text: 'All green now.' }] }] }));
  await expect(tx.locator('.tx-jump')).toHaveText('1 new · jump to latest');
  expect(await scrollTop()).toBe(0);

  // `1` on the timeline answers the question (worker.answer); Tofu works again and the prompt comes back.
  await page.keyboard.press('1');
  await expect.poll(async () => (await sent(page)).filter((c) => c.t === 'worker.answer').at(-1)?.args).toMatchObject({ id: worker, choice: 1 });
  await expect(tx.locator('.tx-banner')).toBeHidden();
  await expect(tx.locator('.tx-input')).toBeEnabled();
  await tx.locator('.tx-jump').click();
  await expect(tx.locator('.tx-jump')).toBeHidden();

  // Enter goes to the prompt box; the prompt goes out as worker.prompt, not as keys.
  await page.keyboard.press('Enter');
  await expect(tx.locator('.tx-input')).toBeFocused();
  await page.keyboard.type('please rerun the tests');
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await sent(page)).filter((c) => c.t === 'worker.prompt').at(-1)?.args).toEqual({ id: worker, text: 'please rerun the tests' });
  expect(await sentKeys()).toBe(keysBefore);
  expect(await page.evaluate(() => window.__h3d.seated())).toBe(worker);

  // "Show system" reveals the hidden notice and the unknown entry.
  await tx.locator('.tx-sys-toggle').click();
  await expect(tx.locator('.tx-notice', { hasText: 'Turn took 41s' })).toBeVisible();
  await expect(tx.locator('.tx-unknown')).toContainText('queue-operation');

  // A new session (/clear): the game watches again and shows it.
  const watchesBefore = (await watchLog(page)).filter((c) => c.t === 'transcript.watch').length;
  await page.evaluate(() => window.__h3d.simTranscript({ id: window.__h3d.seated(), close: 'session_changed' }));
  await expect.poll(async () => (await watchLog(page)).filter((c) => c.t === 'transcript.watch').length, { timeout: 10_000 }).toBe(watchesBefore + 1);
  await expect(tx.locator('[data-id="demo-99"]')).toHaveCount(0);
  await expect.poll(async () => (await txState(page)).watches).toBe(1);

  // Ctrl+Esc again: the live terminal at the seated fps, the overlay hidden (kept for the next switch).
  await page.keyboard.press('Control+Escape');
  await expect.poll(async () => (await txState(page)).mode).toBe('terminal');
  expect((await txState(page)).box).toBeNull();
  await expect(page.locator('.seat-transcript')).toBeHidden();
  await expect.poll(() => termFps(page, worker)).toBe(seatedFps);
  await expect.poll(async () => (await page.evaluate(() => window.__h3d.screens())).find((s) => s.id === worker)?.state).toBe('live');
  expect((await page.evaluate(() => window.__h3d.seat())).mode).toBe('terminal');

  // Back in the transcript, with a draft in the prompt box: a single Esc stands you up, as everywhere seated. That
  // ends the transcript watch and removes the overlay.
  await page.keyboard.press('Control+Escape');
  await expect.poll(async () => (await txState(page)).mode).toBe('transcript');
  await page.keyboard.press('Enter');
  await expect(tx.locator('.tx-input')).toBeFocused();
  await page.keyboard.type('half a thought');
  await page.keyboard.press('Escape');
  await expect.poll(() => page.evaluate(() => window.__h3d.seated())).toBeNull();
  await expect.poll(async () => (await txState(page)).watches).toBe(0);
  await expect.poll(async () => (await page.evaluate(() => window.__h3d.simTranscripts()))?.watches).toBe(0);
  expect(await page.locator('.seat-transcript').count()).toBe(0);
  clean();
});

test('sit / toggle / stand cycles leave no transcript watches or overlays behind', async ({ page }) => {
  test.setTimeout(120_000);
  const clean = watchErrors(page);
  const worker = await sitAt(page, 'Nibble');
  for (let i = 0; i < 5; i++) {
    if (i > 0) {
      expect(await page.evaluate((w) => window.__h3d.sitAt(w), worker)).toBe(true);
      await expect.poll(() => page.evaluate(() => window.__h3d.seated())).toBe(worker);
    }
    await expect.poll(async () => (await txState(page)).watches).toBe(1);
    // The mode is remembered per worker: every other sit comes back in transcript mode.
    if ((await txState(page)).mode === 'terminal') await page.keyboard.press('Control+Escape');
    await expect.poll(async () => (await txState(page)).mounted).toBe(true);
    await page.keyboard.press('Escape');
    await expect.poll(() => page.evaluate(() => window.__h3d.seated())).toBeNull();
    await expect.poll(async () => (await txState(page)).watches).toBe(0);
    expect(await page.locator('.seat-transcript').count()).toBe(0);
  }
  await expect.poll(async () => (await page.evaluate(() => window.__h3d.simTranscripts()))?.watches).toBe(0);
  clean();
});
