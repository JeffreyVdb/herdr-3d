import { expect, test, type Page } from '@playwright/test';
import { frames, openGame, shot, watchErrors } from './game';

// M16: the transcript mode of the seated view, for real, on the WebGL2 path: demo-m5 with the simulating fixture server
// (sim=1), which answers transcript.watch / page / item like herdr-world (tools/fixture-transcript.ts: a demo timeline
// of every item kind, in the bridge's shape; the subagent's page is the bridge's own output for its fixture). You sit
// at Tofu (a blocked claude, so the banner has a real question) and its conversation is drawn over the monitor (#98:
// what you sit down to); Ctrl+Esc swaps it for the terminal and back, and a worker left in the terminal is found
// there next time.

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
  // No desk prints (?prints=0): they watch the transcripts of the desks near you too (e2e/m16-prints.spec.ts); this
  // counts the seat's watch alone.
  await openGame(page, 'demo-m5', '&prints=0', SIM);
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

/**
 * Phase 2 (#56): the images of the demo timeline are real PNGs served by the simulator like the bridge does
 * (transcript.image, only hashes it sent). The user's message has two screenshots and one outside the bridge's roots;
 * a Read of a PNG shows its images without opening the row (#70), under its header; two generated images in adjacent assistant items share one
 * strip; a click opens the lightbox (zoom, copy, Esc closes only it).
 */
async function imagesInTheConversation(page: Page, tx: ReturnType<Page['locator']>, worker: string): Promise<void> {
  const first = tx.locator('.tx-user').first();
  // A pasted image inline in the bubble, beside the one that is "not available" (its path as text).
  const strip = first.locator('.tx-bubble .tx-strip');
  // Thumbnails load when they scroll into view (the vitest with a controlled IntersectionObserver pins that down).
  await first.scrollIntoViewIfNeeded();
  await expect(strip.locator('.tx-thumb')).toHaveCount(2);
  await expect(strip.locator('.tx-thumb img')).toHaveCount(2);
  await expect.poll(() => strip.locator('.tx-thumb img').evaluateAll((els) => els.map((e) => (e as HTMLImageElement).naturalWidth))).toEqual([480, 270]);
  expect(await strip.evaluate((e) => getComputedStyle(e).flexWrap)).toBe('wrap');
  const card = strip.locator('.tx-imgcard');
  await expect(card).toHaveCount(1);
  await expect(card).toContainText('Image not available');
  await expect(card.locator('.tx-imgcard-path')).toHaveText('/etc/hosts.png');
  // Thumbnails are at most 480 px on the long side, on screen and on the wire.
  for (const box of await strip.locator('.tx-thumb').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().toJSON() as { width: number; height: number }))) {
    expect(Math.max(box.width, box.height)).toBeLessThanOrEqual(480);
  }
  const asked = async () => (await watchLog(page)).filter((c) => c.t === 'transcript.image').map((c) => c.args as { hash: string; size: string });
  expect((await asked()).every((a) => a.size === 'thumb')).toBe(true);
  // The strips further down that scrolled into view ask for theirs too: each has its answer before the check.
  await expect.poll(async () => (await watchLog(page)).filter((c) => c.t === 'transcript.image').every((c) => c.result)).toBe(true);
  expect((await watchLog(page)).filter((c) => c.t === 'transcript.image').every((c) => c.result?.ok)).toBe(true);

  // #70: a Read of a PNG shows its images collapsed, under its header, with no click; opened, the row shows its text
  // and not the images a second time.
  const read = tx.locator('.tx-tool', { hasText: 'hire-375x667.png' });
  const readHead = read.locator('.tx-tool-row');
  await read.scrollIntoViewIfNeeded();
  await expect(readHead).toHaveAttribute('aria-expanded', 'false');
  await expect(read.locator('.tx-tool-body')).toBeHidden();
  await expect(read.locator(':scope > .tx-tool-strip .tx-thumb img')).toHaveCount(2);
  await expect.poll(() => read.locator('.tx-thumb img').evaluateAll((els) => els.every((e) => (e as HTMLImageElement).naturalWidth > 0))).toBe(true);
  await expect(read.locator('.tx-tool-strip')).toHaveAttribute('aria-label', 'Read: dialog-evidence/hire-375x667.png — 2 images');
  // Under the header, not beside it; each thumbnail at most 240 px on its long side (two share the strip).
  const headBox = await readHead.boundingBox();
  for (const b of await read.locator('.tx-tool-strip .tx-thumb').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().toJSON() as { y: number; width: number; height: number }))) {
    expect(b.y).toBeGreaterThanOrEqual((headBox?.y ?? 0) + (headBox?.height ?? 0));
    expect(Math.max(b.width, b.height)).toBeLessThanOrEqual(240);
  }
  await frames(page, 2);
  await shot(page, 'm70-read-collapsed');
  await readHead.click();
  await expect(readHead).toHaveAttribute('aria-expanded', 'true');
  await expect(read.locator('.tx-tool-body')).toBeVisible();
  await expect(read.locator('.tx-tool-body .tx-thumb')).toHaveCount(0);
  await expect(read.locator('.tx-thumb')).toHaveCount(2);
  await readHead.click();
  await expect(read.locator('.tx-tool-body')).toBeHidden();

  // Two adjacent image-only assistant items share one strip (the second row is folded into the first).
  const merged = tx.locator('.tx-imgonly.tx-assistant:not(.tx-merged)');
  await expect(merged).toHaveCount(1);
  await expect(merged.locator('.tx-thumb')).toHaveCount(2);
  await expect(tx.locator('.tx-imgonly.tx-merged')).toHaveCount(1);
  // The user's later message has text: its image is its own strip.
  await expect(tx.locator('.tx-user', { hasText: 'Same screenshot again' }).locator('.tx-thumb')).toHaveCount(1);

  // Click: the lightbox with the full image (a second request, full), zoom and copy; Esc closes it and only it.
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => {});
  await strip.locator('.tx-thumb').first().click();
  const lb = page.locator('dialog.ilb');
  await expect(lb).toBeVisible();
  await expect.poll(async () => (await asked()).filter((a) => a.size === 'full').length).toBe(1);
  await expect.poll(() => lb.locator('.ilb-img').evaluate((e) => (e as HTMLImageElement).naturalWidth)).toBe(1280);
  await expect(lb.locator('.ilb-badge')).toHaveText('You sent');
  await lb.getByRole('button', { name: 'Zoom in' }).click();
  await expect(lb.locator('.ilb-fit')).not.toHaveText('Fit');
  expect(await lb.locator('.ilb-img').evaluate((e) => (e as HTMLElement).style.transform)).toContain('scale');
  await lb.getByRole('button', { name: 'Copy image' }).click();
  await expect(lb.locator('.ilb-status')).toContainText(/Image copied|Couldn’t copy/);
  await shot(page, 'm16-lightbox');
  await page.keyboard.press('Escape');
  await expect(lb).toHaveCount(0);
  expect(await page.evaluate(() => window.__h3d.seated())).toBe(worker);
  expect((await txState(page)).mode).toBe('transcript');
  // The not-available image opens as its card.
  await card.click();
  await expect(page.locator('dialog.ilb .ilb-card')).toContainText('/etc/hosts.png');
  await page.keyboard.press('Escape');
  await expect(page.locator('dialog.ilb')).toHaveCount(0);
  // #70: a click on the collapsed Read's thumbnail opens the lightbox on its two images and leaves the row closed.
  await read.scrollIntoViewIfNeeded();
  await read.locator('.tx-tool-strip .tx-thumb').nth(1).click();
  await expect(lb).toBeVisible();
  await expect(lb.locator('.ilb-count')).toHaveText('2 / 2');
  await expect(lb.locator('.ilb-badge')).toHaveText('Agent viewed');
  // Its full image answered before Esc (a request still on its way has no result for the check below).
  await expect.poll(() => lb.locator('.ilb-img').evaluate((e) => (e as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  await expect.poll(async () => (await watchLog(page)).filter((c) => c.t === 'transcript.image').every((c) => c.result)).toBe(true);
  await page.keyboard.press('Escape');
  await expect(lb).toHaveCount(0);
  await expect(readHead).toHaveAttribute('aria-expanded', 'false');
  await expect(read.locator('.tx-tool-body')).toBeHidden();
  // Only hashes the bridge sent were ever asked for.
  expect((await watchLog(page)).filter((c) => c.t === 'transcript.image').every((c) => c.result?.ok)).toBe(true);
}

test('sitting down opens the conversation over the monitor, fed by transcript.watch; Ctrl+Esc to the terminal and back', { tag: '@smoke' }, async ({ page }) => {
  test.setTimeout(120_000);
  const clean = watchErrors(page);
  const worker = await sitAt(page, 'Tofu');

  // #98: the transcript, over the monitor's glass, as you sit; watched from that moment, not counted as a terminal
  // watch; the terminal behind it watched at 1 fps.
  await expect.poll(async () => (await txState(page)).items).toBeGreaterThan(10);
  await expect.poll(async () => (await txState(page)).mounted).toBe(true);
  expect(await txState(page)).toMatchObject({ mode: 'transcript', watches: 1 });
  expect((await page.evaluate(() => window.__h3d.seat())).mode).toBe('transcript');
  expect((await watchLog(page)).filter((c) => c.t === 'transcript.watch').map((c) => c.args)).toEqual([{ id: worker, limit: 200 }]);
  const tx = page.locator('.seat-transcript .tx');
  await expect(tx).toBeVisible();
  await expect.poll(() => termFps(page, worker)).toBe(1);

  // Right after sitting down, with nothing clicked, the scroll keys work (the keyboard is on the timeline) and nothing
  // reaches the pane.
  const sentKeys = async () => (await sent(page)).filter((c) => c.t === 'worker.keys').length;
  const keysBefore = await sentKeys();
  const scroller = tx.locator('.tx-scroll');
  const scrollTop = () => scroller.evaluate((e) => e.scrollTop);
  await expect(tx.locator('.tx-user').first()).toBeVisible();
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
      // A control that is not shown (#59: the working chip while nothing runs) is not covered.
      .filter((e) => e.offsetParent !== null)
      .filter((e) => {
        const r = e.getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return !hit || !e.contains(hit);
      })
      .map((e) => e.className),
  );
  expect(covered).toEqual([]);

  // Rows: the bubble with the image placeholder, the agent's thinking text shown inline, tools, a divider; what the bridge hides waits
  // for "show system", its other notices show.
  await expect(tx.locator('.tx-user .tx-bubble').first()).toContainText('HUD overlaps');
  await imagesInTheConversation(page, tx, worker);
  await expect(tx.locator('.tx-thinking-body').first()).toContainText('The seat pose uses');
  await expect(tx.locator('.tx-thinking-body').first()).toBeVisible();
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
  expect(await tx.locator('script, .tx-md img, [onerror], a[href^="javascript"]').count()).toBe(0);
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
      updates: [{ id: 'toolu_demo_bash2', seq: 17, ts: Date.now(), kind: 'tool', tool: { name: 'Bash', input_summary: 'pnpm vitest run src/laptop --reporter dot', status: 'ok', output_text: 'Tests  42 passed' } }],
    }),
  );
  await expect(tx.locator('[data-id="toolu_demo_bash2"]')).toHaveAttribute('data-status', 'ok');
  await expect(tx.locator('[data-id="toolu_demo_bash2"]')).toHaveCount(1);

  // Thinking with text is the agent talking: dimmed and visible with no click, no chevron or button. An encrypted one
  // (no parts) is a muted chip that does not open.
  await page.evaluate(() =>
    window.__h3d.simTranscript({
      id: window.__h3d.seated(),
      items: [
        { id: 'demo-97', seq: 97, ts: Date.now(), kind: 'thinking', parts: [{ text: 'No blockers: the *coder* is starting now.' }] },
        { id: 'demo-98', seq: 98, ts: Date.now(), kind: 'thinking' },
      ],
    }),
  );
  const said = tx.locator('[data-id="demo-97"]');
  await expect(said.locator('.tx-thinking-body')).toBeVisible();
  await expect(said.locator('.tx-thinking-body em')).toHaveText('coder');
  await expect(said.locator('.tx-thinking-tag')).toHaveText('summary');
  await expect(tx.locator('.tx-thinking button, .tx-thinking [aria-expanded]')).toHaveCount(0);
  await expect(tx.locator('[data-id="demo-98"] .tx-chip-mute')).toHaveText('reasoning');

  // Ctrl+Esc: the live terminal at the seated fps; Ctrl+Esc again: the transcript, the terminal behind it frozen at
  // 1 fps, and the keyboard on the timeline again, no click needed.
  await page.keyboard.press('Control+Escape');
  await expect.poll(async () => (await txState(page)).mode).toBe('terminal');
  await expect.poll(() => termFps(page, worker)).toBeGreaterThan(1);
  const seatedFps = await termFps(page, worker);
  await expect.poll(async () => (await page.evaluate(() => window.__h3d.screens())).find((s) => s.id === worker)?.state).toBe('live');
  await expect.poll(() => page.evaluate((id) => (window.__h3d.screenText(id) ?? []).join('').trim().length, worker)).toBeGreaterThan(0);
  await page.keyboard.press('Control+Escape');
  await expect.poll(async () => (await txState(page)).mode).toBe('transcript');
  await expect(scroller).toBeFocused();
  await expect.poll(() => termFps(page, worker)).toBe(1);
  await expect.poll(async () => (await page.evaluate(() => window.__h3d.screens())).find((s) => s.id === worker)?.state).toBe('frozen');
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

/** Stands you up (Esc), then sits you at `id` again, facing it first. */
async function sitAgain(page: Page, id: string): Promise<void> {
  if (await page.evaluate(() => window.__h3d.seated())) {
    await page.keyboard.press('Escape');
    await expect.poll(() => page.evaluate(() => window.__h3d.seated())).toBeNull();
  }
  expect(await page.evaluate((i) => window.__h3d.face(i), id)).toBe(true);
  await frames(page, 3);
  expect(await page.evaluate((w) => window.__h3d.sitAt(w), id)).toBe(true);
  await expect.poll(() => page.evaluate(() => window.__h3d.seated())).toBe(id);
}

const terminalList = (page: Page) => page.evaluate(() => localStorage.getItem('h3d.seat.terminal'));

test('#98: a worker never sat at opens its conversation, one left in the terminal opens there, one with no transcript opens the terminal', async ({ page }) => {
  test.setTimeout(120_000);
  const clean = watchErrors(page);
  // The list of before #98 (who was read in transcript mode) is not read, and it goes.
  await page.addInitScript(() => localStorage.setItem('h3d.seat.transcript', JSON.stringify(['someone-else'])));
  const nibble = await sitAt(page, 'Nibble');
  expect((await txState(page)).mode).toBe('transcript');
  await expect.poll(async () => (await txState(page)).mounted).toBe(true);
  await expect(page.locator('.seat-transcript .tx .tx-scroll')).toBeFocused();
  expect(await page.evaluate(() => localStorage.getItem('h3d.seat.transcript'))).toBeNull();
  expect(await terminalList(page)).toBeNull();

  // Ctrl+Esc to the terminal, stand up, sit again: the terminal, remembered for Nibble alone.
  await page.keyboard.press('Control+Escape');
  await expect.poll(async () => (await txState(page)).mode).toBe('terminal');
  await sitAgain(page, nibble);
  expect((await txState(page)).mode).toBe('terminal');
  expect((await page.evaluate(() => window.__h3d.seat())).mode).toBe('terminal');
  await expect(page.locator('.seat-transcript')).toHaveCount(0);
  expect(await terminalList(page)).toBe(JSON.stringify([nibble]));
  // Keys go to its terminal.
  await page.keyboard.type('x');
  await expect.poll(async () => (await sent(page)).filter((c) => c.t === 'worker.keys' && (c.args as { id: string }).id === nibble).length).toBeGreaterThan(0);

  // Back to the conversation: that is remembered too.
  await page.keyboard.press('Control+Escape');
  await expect.poll(async () => (await txState(page)).mode).toBe('transcript');
  await sitAgain(page, nibble);
  expect((await txState(page)).mode).toBe('transcript');
  expect(await terminalList(page)).toBeNull();

  // Another agent never sat at (Pixel, a codex): its conversation.
  const id = (n: string) => page.evaluate((x) => window.__h3d.world().flatMap((f) => f.workers).find((w) => w.name === x)?.id ?? '', n);
  await sitAgain(page, await id('Pixel'));
  expect((await txState(page)).mode).toBe('transcript');

  // A plain shell (Sprout) writes no transcript: the terminal, and nothing remembered for it.
  const sprout = await id('Sprout');
  await sitAgain(page, sprout);
  expect((await txState(page)).mode).toBe('terminal');
  expect((await page.evaluate(() => window.__h3d.seat())).mode).toBe('terminal');
  await expect(page.locator('.seat-transcript')).toHaveCount(0);
  expect(await terminalList(page)).toBeNull();
  await page.keyboard.press('Escape');
  await expect.poll(() => page.evaluate(() => window.__h3d.seated())).toBeNull();
  clean();
});

test('#98: a bridge without transcripts opens the terminal at every worker', async ({ page }) => {
  test.setTimeout(120_000);
  const clean = watchErrors(page);
  await openGame(page, 'demo-m5', '&prints=0', `${SIM}&simfail=no_m16`);
  await page.evaluate((s) => window.__h3d.enterFloor(s), FLOOR);
  await frames(page, 3);
  const tofu = await page.evaluate(() => window.__h3d.world().flatMap((f) => f.workers).find((w) => w.name === 'Tofu')?.id ?? '');
  await sitAgain(page, tofu);
  await expect.poll(() => page.evaluate(() => window.__h3d.seat().mode)).toBe('terminal');
  await frames(page, 10);
  expect((await txState(page)).mode).toBe('terminal');
  // (The first sit may try the conversation before the bridge said it has none: its overlay is hidden then.)
  await expect(page.locator('.seat-transcript')).toBeHidden();
  expect(await terminalList(page)).toBeNull();
  clean();
});

test('sit / toggle / stand cycles leave no transcript watches or overlays behind', { tag: '@smoke' }, async ({ page }) => {
  test.setTimeout(120_000);
  const clean = watchErrors(page);
  const worker = await sitAt(page, 'Nibble');
  for (let i = 0; i < 5; i++) {
    if (i > 0) {
      expect(await page.evaluate((w) => window.__h3d.sitAt(w), worker)).toBe(true);
      await expect.poll(() => page.evaluate(() => window.__h3d.seated())).toBe(worker);
    }
    await expect.poll(async () => (await txState(page)).watches).toBe(1);
    // #98: the conversation as you sit (Escape stands you up from it: nothing is left in the terminal).
    expect((await txState(page)).mode).toBe('transcript');
    await expect.poll(async () => (await txState(page)).mounted).toBe(true);
    await page.keyboard.press('Escape');
    await expect.poll(() => page.evaluate(() => window.__h3d.seated())).toBeNull();
    await expect.poll(async () => (await txState(page)).watches).toBe(0);
    expect(await page.locator('.seat-transcript').count()).toBe(0);
  }
  await expect.poll(async () => (await page.evaluate(() => window.__h3d.simTranscripts()))?.watches).toBe(0);
  clean();
});

// #56: at 1280x720 the plan-limits plate hung over the top right of the overlay's header; it now steps out of the
// reading overlay like out of a screen dialog (an edge tab beside it, Shift+L peeks). At 960x600 a blocked question
// used to leave little room above the prompt: the banner is capped and compact, the timeline keeps its room.
for (const [w, h] of [
  [1280, 720],
  [960, 600],
] as const) {
  test(`the plan-limits plate and the blocked banner leave the conversation its room at ${w}x${h}`, async ({ page }) => {
    test.setTimeout(120_000);
    const clean = watchErrors(page);
    await page.setViewportSize({ width: w, height: h });
    await openGame(page, 'demo-m5', '&prints=0', `${SIM}&simlimits=ok`);
    await page.evaluate((s) => window.__h3d.enterFloor(s), FLOOR);
    await frames(page, 3);
    const id = await page.evaluate(() => window.__h3d.world().flatMap((f) => f.workers).find((x) => x.name === 'Tofu')?.id ?? '');
    expect(await page.evaluate((i) => window.__h3d.face(i), id)).toBe(true);
    await frames(page, 3);
    expect(await page.evaluate((i) => window.__h3d.sitAt(i), id)).toBe(true);
    await expect.poll(() => page.evaluate(() => window.__h3d.seated())).toBe(id);
    await frames(page, 20);
    // The plate is open in the corner while you stand at the desk... (#98: the conversation is up as you sit)
    await expect(page.locator('.limits')).toBeVisible();
    const tx = page.locator('.seat-transcript .tx');
    await expect(tx.locator('.tx-user').first()).toBeVisible();
    await frames(page, 8);
    // ... and steps out of the overlay: a slim tab (or nothing), never over the header.
    await expect(page.locator('.limits')).toHaveAttribute('data-dock', /^(tab|away)$/);
    const box = (await txState(page)).box as NonNullable<Tx['box']>;
    const plate = await page.locator('.limits').evaluate((e) => {
      const r = e.getBoundingClientRect();
      return getComputedStyle(e).display === 'none' ? null : { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
    });
    if (plate) expect(plate.left >= box.left + box.width || plate.right <= box.left || plate.top >= box.top + box.height || plate.bottom <= box.top, 'the plate is over the overlay').toBe(true);
    // Every control of the bar, the banner and the prompt is hit-testable (nothing covers it).
    const covered = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>('.seat-transcript .tx-bar button, .seat-transcript .tx-banner button, .seat-transcript .tx-send, .seat-transcript .tx-input')]
        .filter((e) => e.offsetParent !== null)
        .filter((e) => {
          const r = e.getBoundingClientRect();
          const hit = document.elementFromPoint(r.left + r.width / 2, r.top + Math.min(r.height / 2, 12));
          return !hit || !e.contains(hit);
        })
        .map((e) => e.className),
    );
    expect(covered).toEqual([]);
    // Peek: Shift+L brings the plate over the overlay for a moment.
    await page.keyboard.press('Shift+L');
    await expect(page.locator('.limits')).toHaveAttribute('data-peek', 'true');
    await page.keyboard.press('Shift+L');
    await expect(page.locator('.limits')).toHaveAttribute('data-peek', 'false');
    // Tofu is blocked: the banner takes less than half the overlay and the timeline keeps at least 130 px.
    await expect(tx.locator('.tx-banner')).toBeVisible();
    const m = await page.evaluate(() => {
      const q = (s: string) => document.querySelector<HTMLElement>(`.seat-transcript ${s}`)?.getBoundingClientRect();
      return { root: q('.tx')?.height ?? 0, banner: q('.tx-banner')?.height ?? 0, scroll: q('.tx-scroll')?.height ?? 0, input: q('.tx-input')?.height ?? 0 };
    });
    expect(m.banner).toBeLessThanOrEqual(m.root * 0.47);
    expect(m.scroll).toBeGreaterThanOrEqual(130);
    expect(m.input).toBeGreaterThan(20);
    await frames(page, 6);
    await shot(page, `m16-transcript-${w}x${h}`);
    clean();
  });
}
