import { expect, test, type Page } from '@playwright/test';
import { frames, openGame, RESULTS, watchErrors } from './game';
import { bar, dictate, enterFloor, fakeOpenAI, field, hires, openBar, review, reviewReady, sentOf, setUpLlm, status, type Fake, type Review } from './dictation';
import { advance, beeps, forgetToasts, probe, SPAWNED, toasts } from './hireProbe';

// #214 (phase 5 of #209): the cross-phase edge cases of a dictated hire, one independent test each: repeated Enter, two
// hires on their way, a review edited while an earlier hire ends, a provider error during a review, a model change after
// a dictated effort, and a dropped connection or a timeout (an unknown outcome). demo-m4 with the simulator on a manual
// clock (the hire's ack is held until `simAdvance`) and a fake OpenAI server per test (e2e/dictation.ts). pastry (bottom,
// 16 desks, 14 and 15 empty).
//
// #33: a background dictated hire that is refused or gets no answer gives its reviewed task back: the review opens again
// as it was reviewed (its status line says what happened), or, with another dialog open, it is held behind the toast's
// Review again and a palette row. Nothing of it sends `worker.hire`: only a new Hire does.

const SIM = 'play=none&sim=1&simms=150&simusage=0&simclock=manual';

const reviewEl = (page: Page) => page.locator('.desk-dlg--review');
const hireButton = (page: Page) => reviewEl(page).locator('[data-key="hire"]');
/** Picks a chip of the open review (`what:value`): its radio is visually hidden, its label is what a player clicks. */
const pick = (page: Page, key: string) => reviewEl(page).locator(`label:has(> input[data-key="${key}"])`).click();
const now = async (page: Page) => (await review(page)) as Review;
const deskWorker = (page: Page, desk: number) => page.evaluate((d) => window.__h3d.desks()[d]?.worker ?? null, desk);
type HireArgs = { session: string; desk_index: number; harness: string; model: string; effort: string; prompt: string };
const hireArgs = async (page: Page) => (await hires(page)).map((h) => h.args as HireArgs);

/** The game on pastry with the fake LLM set up; `test` runs with it and the server is closed after, whatever happens. */
async function onPastry(page: Page, o: { background: boolean; sim?: string }, test: (llm: Fake) => Promise<void>): Promise<void> {
  await probe(page, { background: o.background });
  const llm = await fakeOpenAI();
  try {
    await openGame(page, 'demo-m4', '', `${SIM}${o.sim ?? ''}`);
    await setUpLlm(page, llm);
    await enterFloor(page, 'pastry');
    await forgetToasts(page);
    await test(llm);
  } finally {
    await llm.close();
  }
}

/** Dictates `text` (the bar opened for it) and waits for its review on pastry. */
async function dictateReview(page: Page, text: string): Promise<Review> {
  await openBar(page);
  await dictate(page, text);
  return reviewReady(page, 'pastry');
}

/** #33: the toast that says a hire had no answer (the review's status line says it instead when it opens again). */
const NO_ANSWER = /^No answer about the hire/;
const palette = (page: Page) => page.locator('dialog.palette');
const heldRow = (page: Page) => palette(page).locator('[data-kind="held"]');

/** Background: Hire on the open review; it goes at once. */
async function confirm(page: Page): Promise<void> {
  await hireButton(page).click();
  await expect.poll(() => review(page)).toBeNull();
}

test('repeated Enter: in the bar while the answer is on its way one request and one review; on the review’s Hire one worker.hire', { tag: '@smoke' }, async ({ page }) => {
  test.setTimeout(180_000);
  const clean = watchErrors(page);
  await onPastry(page, { background: false }, async () => {
    // The fake answers SLOW sentences after 2.5 s: Enter, Enter, Enter while it is on its way.
    await openBar(page);
    await dictate(page, 'Hire an agent on Sonnet 5.5 with high effort. SLOW Task: knead the dough twice.');
    await expect.poll(() => page.evaluate(() => window.__h3d.dictation()?.state)).toBe('pending');
    await field(page).press('Enter');
    await field(page).press('Enter');
    const r = await reviewReady(page, 'pastry');
    expect(r.choice.task).toBe('knead the dough twice.');
    await expect(bar(page)).toBeHidden();
    expect(await sentOf(page, 'hire.interpret')).toHaveLength(1);
    expect(await sentOf(page, 'hire.prepare')).toHaveLength(1);
    expect(await hires(page)).toHaveLength(0);

    // Foreground, the ack held: the review waits in `hiring`, and Enter on Hire again (and a click) sends nothing more.
    await hireButton(page).focus();
    await page.keyboard.press('Enter');
    await expect.poll(async () => (await review(page))?.state).toBe('hiring');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await hireButton(page).click({ force: true });
    await frames(page, 6);
    expect(await hires(page)).toHaveLength(1);
    await advance(page, 150);
    await expect(page.locator('.toast')).toHaveText(/^Hired .* at Desk 15.*\. Here they come\./);
    await expect.poll(() => deskWorker(page, 14)).not.toBeNull();
    await frames(page, 6);
    expect(await hireArgs(page)).toEqual([expect.objectContaining({ desk_index: 14, harness: 'claude', model: 'claude-sonnet-5-5', effort: 'high', prompt: 'knead the dough twice.' })]);
    expect(await sentOf(page, 'hire.interpret')).toHaveLength(1);
  });
  clean();
});

test('two dictated hires on their way at once: each ends with its own toast and beep at its own desk, no cross-talk', async ({ page }) => {
  test.setTimeout(180_000);
  const clean = watchErrors(page);
  await onPastry(page, { background: true }, async () => {
    expect((await dictateReview(page, 'Hire an agent on Opus 5.5 with low effort. Task: proof the first batch.')).desk).toBe(14);
    await confirm(page);
    await advance(page, 100); // (so the acks fall at different times)
    // The first one holds desk 14: the second review takes the next free desk.
    expect((await dictateReview(page, 'Hire a worker on Fable 5.1 with medium effort. Task: proof the second batch.')).desk).toBe(15);
    await confirm(page);
    expect(await hireArgs(page)).toEqual([
      expect.objectContaining({ floor: 'pastry', desk_index: 14, harness: 'claude', model: 'claude-opus-5-5', effort: 'low', prompt: 'proof the first batch.' }),
      expect.objectContaining({ floor: 'pastry', desk_index: 15, harness: 'claude', model: 'claude-fable-5-1', effort: 'medium', prompt: 'proof the second batch.' }),
    ]);
    expect(await toasts(page)).toEqual([]);
    expect(await beeps(page)).toBe(0);

    // The first ack: one toast, one beep, desk 14's worker only.
    await advance(page, 60);
    await expect.poll(() => beeps(page)).toBe(1);
    await expect.poll(() => deskWorker(page, 14)).not.toBeNull();
    expect(await deskWorker(page, 15)).toBeNull();
    expect(await toasts(page)).toEqual([SPAWNED]);
    // The second: its own.
    await advance(page, 100);
    await expect.poll(() => beeps(page)).toBe(2);
    await expect.poll(() => deskWorker(page, 15)).not.toBeNull();
    await page.waitForTimeout(500);
    expect(await toasts(page)).toEqual([SPAWNED, SPAWNED]);
    expect(await beeps(page)).toBe(2);
    expect(await deskWorker(page, 14)).not.toBe(await deskWorker(page, 15));
    expect(await hires(page)).toHaveLength(2);
    expect(await page.evaluate(() => window.__h3d.seated())).toBeNull();
  });
  clean();
});

test('a review being edited while an earlier dictated hire completes is not closed, reset or overwritten', async ({ page }) => {
  test.setTimeout(180_000);
  const clean = watchErrors(page);
  await onPastry(page, { background: true }, async () => {
    await dictateReview(page, 'Hire an agent on Opus 5.5 with low effort. Task: proof the first batch.');
    await confirm(page);
    await advance(page, 100);

    // The next review, edited: an effort picked, the task changed, the caret in it.
    const r = await dictateReview(page, 'Hire an agent on Sonnet 5.5. Task: sweep the bakery floor.');
    expect(r.desk).toBe(15);
    expect(r.choice.effort).toBe('');
    await pick(page, 'effort:medium');
    await reviewEl(page).locator('[data-key="sec:task"]').click();
    const task = page.locator('#review-task');
    await task.focus();
    await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.type(' Then mop.');
    const before = await now(page);
    expect(before.choice).toMatchObject({ effort: 'medium', task: 'sweep the bakery floor. Then mop.' });

    // The earlier hire ends meanwhile: its toast and beep, nothing else.
    await advance(page, 60);
    await expect(page.locator('.toast')).toHaveText(SPAWNED);
    await expect.poll(() => beeps(page)).toBe(1);
    await expect.poll(() => deskWorker(page, 14)).not.toBeNull();
    const after = await now(page);
    expect(after).toMatchObject({ kind: 'hire-review', floor: 'pastry', desk: 15, state: 'ready', status: '', error: false });
    expect(after.choice).toEqual(before.choice);
    expect(after.sections).toEqual(before.sections);
    // The keyboard is still in the task.
    await expect(task).toBeFocused();
    await page.keyboard.type(' Twice.');
    await expect(task).toHaveValue('sweep the bakery floor. Then mop. Twice.');
    expect(await hires(page)).toHaveLength(1);

    await confirm(page);
    expect((await hireArgs(page))[1]).toEqual(expect.objectContaining({ desk_index: 15, harness: 'claude', model: 'claude-sonnet-5-5', effort: 'medium', prompt: 'sweep the bakery floor. Then mop. Twice.' }));
    await advance(page, 200);
    await expect.poll(() => beeps(page)).toBe(2);
    expect(await toasts(page)).toEqual([SPAWNED, SPAWNED]);
  });
  clean();
});

test('a dictated follow-up whose interpretation fails leaves the open review as it was, hires nobody and says so in the bar', async ({ page }) => {
  test.setTimeout(180_000);
  const clean = watchErrors(page);
  await onPastry(page, { background: false }, async () => {
    const r = await dictateReview(page, 'Hire an agent on Sonnet 5.5. Task: sweep the bakery floor.');
    expect(r.choice.effort).toBe('');
    expect(r.blocker).not.toBeNull();

    // The follow-up: the provider answers 500.
    await openBar(page);
    await dictate(page, 'high FAIL');
    await expect(status(page)).toHaveText('The AI provider failed. Press Enter to try again.');
    await expect(status(page)).toHaveAttribute('data-tone', 'error');
    await expect(field(page)).toHaveValue('high FAIL');
    const follow = (await sentOf(page, 'hire.interpret')).at(-1)?.args as { text: string; pending?: { sources: string[] } };
    expect(follow.pending?.sources).toEqual(['Hire an agent on Sonnet 5.5. Task: sweep the bakery floor.']);
    // The review under the bar is untouched.
    const kept = await now(page);
    expect(kept).toMatchObject({ desk: 14, state: 'ready', status: '', error: false });
    expect(kept.choice).toEqual(r.choice);
    expect(kept.sections).toEqual(r.sections);
    expect(await hires(page)).toHaveLength(0);

    // Esc: the bar goes, the review is still there with the keyboard; a follow-up that works fills it.
    await page.keyboard.press('Escape');
    await expect(bar(page)).toBeHidden();
    expect(await page.evaluate(() => !!document.activeElement?.closest('.desk-dlg--review'))).toBe(true);
    await openBar(page);
    await dictate(page, 'high');
    await expect.poll(async () => (await review(page))?.choice.effort).toBe('high');
    expect((await now(page)).choice.task).toBe('sweep the bakery floor.');
    expect(await hires(page)).toHaveLength(0);
  });
  clean();
});

test('a model change after a dictated effort keeps it when the new model has it, else clears it, opens Effort and turns Hire off', async ({ page }) => {
  test.setTimeout(180_000);
  const clean = watchErrors(page);
  await onPastry(page, { background: false }, async () => {
    const r = await dictateReview(page, 'Hire a worker on GPT-6 Sol with ultra effort. Task: shard the dough queue.');
    expect([r.choice.harness, r.choice.model, r.choice.effort]).toEqual(['codex', 'gpt-6-sol', 'ultra']);
    await reviewEl(page).locator('[data-key="sec:agent"]').click();

    // GPT-6 Astra has ultra too: kept.
    await pick(page, 'model:gpt-6-astra');
    let c = await now(page);
    expect([c.choice.model, c.choice.effort]).toEqual(['gpt-6-astra', 'ultra']);
    expect(c.blocker).toBeNull();
    await expect(hireButton(page)).toBeEnabled();

    // GPT-6 Luna has not: cleared, never another level in its place; Effort opens and asks; Hire is off.
    await pick(page, 'model:gpt-6-luna');
    c = await now(page);
    expect([c.choice.model, c.choice.effort]).toEqual(['gpt-6-luna', '']);
    expect(c.sections.find((s) => s.id === 'effort')).toMatchObject({ open: true, attention: true });
    expect(c.blocker).not.toBeNull();
    await expect(hireButton(page)).toBeDisabled();
    await expect(reviewEl(page).locator('[data-pick="effort"] input:checked')).toHaveCount(0);
    await expect(reviewEl(page).locator('[data-pick="effort"] input[value="ultra"]')).toHaveCount(0);
    expect(c.choice.task).toBe('shard the dough queue.');
    expect(await hires(page)).toHaveLength(0);

    // The human picks one: now Hire, once, with it.
    await pick(page, 'effort:high');
    await expect(hireButton(page)).toBeEnabled();
    await hireButton(page).click();
    await expect.poll(async () => (await hires(page)).length).toBe(1);
    expect((await hireArgs(page))[0]).toEqual(expect.objectContaining({ harness: 'codex', model: 'gpt-6-luna', effort: 'high', prompt: 'shard the dough queue.' }));
  });
  clean();
});

test('a dropped connection while a confirmed dictated hire is on its way: its review again with an outcome-unknown notice, no toast or beep of success, never a second worker.hire', async ({ page }) => {
  test.setTimeout(180_000);
  const clean = watchErrors(page);
  await onPastry(page, { background: true }, async () => {
    await dictateReview(page, 'Hire an agent on Sonnet 5.5 with high effort. Task: maybe bake the rye.');
    await confirm(page);
    expect(await hires(page)).toHaveLength(1);
    await page.evaluate(() => window.__h3d.reconnect());
    // #33: nothing else is open: the review again, as it was reviewed, and its status line says it (not a toast as well).
    await expect.poll(async () => (await review(page))?.state, { timeout: 20_000 }).toBe('ready');
    const back = await now(page);
    expect(back).toMatchObject({ floor: 'pastry', desk: 14, error: true, status: 'No answer about the hire at Desk 15 of pastry: the connection dropped. It may still have gone through: look at the desk before you hire again.' });
    expect(back.choice).toMatchObject({ harness: 'claude', model: 'claude-sonnet-5-5', effort: 'high', task: 'maybe bake the rye.' });
    await expect(reviewEl(page).locator('.dd-status--error')).toHaveText(back.status);
    await expect(hireButton(page)).not.toBeFocused();
    await expect.poll(() => page.evaluate(() => window.__h3d.connection().phase), { timeout: 20_000 }).toBe('live');
    await page.waitForTimeout(1000);
    expect(await hires(page)).toHaveLength(1);
    expect(await beeps(page)).toBe(0);
    expect(await toasts(page)).not.toContain(SPAWNED);
    expect((await toasts(page)).filter((t) => NO_ANSWER.test(t))).toEqual([]);
    expect((await now(page)).choice).toEqual(back.choice);
  });
  clean();
});

test('a confirmed dictated hire herdr-world does not answer in time: its review again with an outcome-unknown notice; its late ack takes the desk (no Hire onto it) and a reconnect hires nobody again', async ({ page }) => {
  test.setTimeout(180_000);
  const clean = watchErrors(page);
  // The client's own `worker.hire` bound (120 s since #58, net/client.ts) shortened to 4 s: the real timeout path, sooner.
  await page.addInitScript(() => {
    const set = window.setTimeout;
    window.setTimeout = ((fn: TimerHandler, ms?: number, ...rest: unknown[]) => set(fn, ms === 120_000 ? 4000 : ms, ...rest)) as typeof window.setTimeout;
  });
  await onPastry(page, { background: true }, async () => {
    await dictateReview(page, 'Hire an agent on Sonnet 5.5 with high effort. Task: maybe bake the rye.');
    await confirm(page);
    expect(await hires(page)).toHaveLength(1);
    // #33: the review again, its status line the notice; the desk is free, so Hire can be pressed (it is not).
    await expect.poll(async () => (await review(page))?.state, { timeout: 20_000 }).toBe('ready');
    expect(await now(page)).toMatchObject({
      desk: 14,
      error: true,
      blocker: null,
      status: 'No answer about the hire at Desk 15 of pastry: herdr-world did not answer in time. It may still have gone through: look at the desk before you hire again.',
    });
    await expect(hireButton(page)).toBeEnabled();
    expect((await toasts(page)).filter((t) => NO_ANSWER.test(t))).toEqual([]);
    // The hire did go through after all (the bridge acks late): the worker comes, the client says nothing more, and the
    // open review offers no Hire onto the desk they took (only, explicitly, another desk).
    await advance(page, 200);
    await expect.poll(() => deskWorker(page, 14), { timeout: 20_000 }).not.toBeNull();
    await expect.poll(async () => (await review(page))?.blocker).toMatch(/just sat down at Desk 15\.$/);
    await expect(hireButton(page)).toBeDisabled();
    await expect(reviewEl(page).locator('[data-key="other-desk"]')).toHaveText('Hire at Desk 16 instead');
    expect((await now(page)).desk).toBe(14);
    await page.waitForTimeout(1000);
    expect(await beeps(page)).toBe(0);
    expect(await toasts(page)).not.toContain(SPAWNED);
    // A reconnect sends nothing again.
    await page.evaluate(() => window.__h3d.reconnect());
    await expect.poll(() => page.evaluate(() => window.__h3d.connection().phase), { timeout: 20_000 }).toBe('live');
    await page.waitForTimeout(1000);
    expect(await hires(page)).toHaveLength(1);
    expect(await beeps(page)).toBe(0);
    // (The review stays open; nothing in it was pressed.)
    expect((await now(page)).state).toBe('ready');
  });
  clean();
});

test('a refused dictated background hire: its review opens again as it was reviewed, ready; only a new Hire sends again', async ({ page }) => {
  test.setTimeout(180_000);
  const clean = watchErrors(page);
  await onPastry(page, { background: true, sim: '&simfail=hire_failed' }, async () => {
    const r = await dictateReview(page, 'Hire an agent on Opus 5.5 with low effort. Task: proof the first batch.');
    await confirm(page);
    await advance(page, 150);
    await expect.poll(async () => (await review(page))?.state, { timeout: 20_000 }).toBe('ready');
    const back = await now(page);
    expect(back).toMatchObject({ floor: 'pastry', desk: 14, error: true, blocker: null, form: r.form });
    expect(back.choice).toMatchObject({ harness: 'claude', model: 'claude-opus-5-5', effort: 'low', task: 'proof the first batch.' });
    expect(back.status).toMatch(/claude exited during startup/);
    await expect(reviewEl(page).locator('.dd-status--error')).toHaveText(back.status);
    // Opening it pressed nothing: Hire is there, not focused; one message (its status line), no toast, no beep.
    await expect(hireButton(page)).toBeEnabled();
    await expect(hireButton(page)).not.toBeFocused();
    await page.waitForTimeout(500);
    expect(await toasts(page)).toEqual([]);
    expect(await beeps(page)).toBe(0);
    expect(await hires(page)).toHaveLength(1);
    await page.screenshot({ path: `${RESULTS}/h33-review-again.png` });

    // A new Hire is a new hire, sent once (the simulator refuses only the first).
    await confirm(page);
    await expect.poll(async () => (await hires(page)).length).toBe(2);
    const [first, again] = await hireArgs(page);
    expect(again).toEqual(first);
    await advance(page, 150);
    await expect(page.locator('.toast')).toHaveText(SPAWNED);
    await expect.poll(() => beeps(page)).toBe(1);
    await expect.poll(() => deskWorker(page, 14)).not.toBeNull();
    expect(await hires(page)).toHaveLength(2);
  });
  clean();
});

test('refused while the next dictation’s review is open: that review is untouched; the task is held, and the palette opens it again once it is free', async ({ page }) => {
  test.setTimeout(180_000);
  const clean = watchErrors(page);
  await onPastry(page, { background: true, sim: '&simfail=hire_failed' }, async () => {
    await dictateReview(page, 'Hire an agent on Opus 5.5 with low effort. Task: proof the first batch.');
    await confirm(page);
    // The next review, edited, when the first hire is refused.
    expect((await dictateReview(page, 'Hire an agent on Sonnet 5.5. Task: sweep the bakery floor.')).desk).toBe(15);
    await pick(page, 'effort:medium');
    const editing = await now(page);
    await advance(page, 150);
    await expect(page.locator('.toast .toast-msg')).toHaveText(/^Desk 15 of pastry · .*claude exited during startup.* The task is kept: review it again here or from the command palette\.$/);
    await expect(page.locator('.toast')).toHaveAttribute('data-kind', 'error');
    await expect(page.locator('.toast .toast-act')).toHaveText('Review again');
    expect(await now(page)).toEqual(editing);
    await page.screenshot({ path: `${RESULTS}/h33-held-toast.png` });

    // The palette lists it; picked while this review is open, it says so and keeps it, the review untouched.
    await page.keyboard.press('ControlOrMeta+KeyP');
    await expect(heldRow(page)).toHaveCount(1);
    await expect(heldRow(page).locator('.pal-name')).toHaveText('Review again: Desk 15 of pastry');
    await expect(heldRow(page).locator('.pal-held-why')).toHaveText('Not hired');
    await expect(heldRow(page).locator('.pal-held-task')).toHaveText('“proof the first batch.”');
    await expect(heldRow(page)).toHaveAttribute('aria-selected', 'true');
    await page.screenshot({ path: `${RESULTS}/h33-held-palette.png` });
    await page.keyboard.press('Enter');
    await expect(page.locator('.toast')).toHaveText('A hire review is open: finish or close it first. The task for Desk 15 of pastry is still kept.');
    expect(await now(page)).toEqual(editing);

    // Cancelled, the review is free: the row opens the refused one again, as it was reviewed.
    await reviewEl(page).locator('[data-key="cancel"]').click();
    await expect.poll(() => review(page)).toBeNull();
    await page.keyboard.press('ControlOrMeta+KeyP');
    await heldRow(page).click();
    await expect.poll(async () => (await review(page))?.desk).toBe(14);
    const back = await now(page);
    expect(back).toMatchObject({ state: 'ready', error: true, blocker: null });
    expect(back.choice).toMatchObject({ harness: 'claude', model: 'claude-opus-5-5', effort: 'low', task: 'proof the first batch.' });
    expect(back.status).toMatch(/claude exited during startup/);
    await expect(hireButton(page)).not.toBeFocused();

    // From now on an ordinary review: Esc closes it, and it is held no more.
    await page.keyboard.press('Escape');
    await expect.poll(() => review(page)).toBeNull();
    await page.keyboard.press('ControlOrMeta+KeyP');
    await expect(palette(page)).toBeVisible();
    await expect(heldRow(page)).toHaveCount(0);
    await page.keyboard.press('Escape');
    expect(await hires(page)).toHaveLength(1);
    expect(await beeps(page)).toBe(0);
  });
  clean();
});
