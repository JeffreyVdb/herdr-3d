import { expect, test, type Page } from '@playwright/test';
import { frames, openGame, openMenu, watchErrors } from './game';
import { dictate, enterFloor, fakeOpenAI, hires, openBar, review, reviewReady, sentOf, setUpLlm } from './dictation';
import { advance, beeps, forgetToasts, notes, pose, probe, SPAWNED, toasts } from './hireProbe';

// #214 (phase 5 of #209): the whole dictated hire, once per mode, across the phases: the bar (#213) → `hire.interpret`
// (#211; the fixture's, calling a fake OpenAI server, e2e/dictation.ts) → the review (#212) → an explicit Hire → the hire
// coordinator (#210) → the ack. demo-m4 with the simulator on a manual clock (`simclock=manual`): the hire's ack is held
// until the test releases it (`simAdvance`), so the window between Hire and the ack is seen. pastry (bottom, 16 desks,
// 14 and 15 empty): the review opens at desk 14 (Desk 15). Off by default and kept across a reload: h210's first test.

const SIM = 'play=none&sim=1&simms=150&simusage=0&simclock=manual';

/** Settings → Display "Hire in background", through the switch a player uses. */
async function setBackground(page: Page, on: boolean): Promise<void> {
  await openMenu(page);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  const box = dialog.locator('[data-section="display"]').getByLabel(/^Hire in background/);
  await box.scrollIntoViewIfNeeded();
  await box.setChecked(on);
  expect(await page.evaluate(() => localStorage.getItem('h3d.hire.background'))).toBe(on ? 'on' : null);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
}

/** On pastry, in the aisle behind desk 14's chair, facing along the aisle; toasts so far forgotten. */
async function standOnBaking(page: Page): Promise<{ x: number; z: number }> {
  await enterFloor(page, 'pastry');
  const L = await page.evaluate(() => window.__h3d.layout('pastry'));
  const s = L?.slots[14];
  if (!L || !s) throw new Error('no desk 14');
  const at = { x: s.seat.x - Math.sin(s.yaw) * 1.1, z: s.seat.z - Math.cos(s.yaw) * 1.1 };
  await page.evaluate(([x, z]) => window.__h3d.setPose({ x, z, yaw: 0 }), [at.x, at.z] as const);
  await frames(page, 2);
  await forgetToasts(page);
  return at;
}

const reviewEl = (page: Page) => page.locator('.desk-dlg--review');
/** Picks a chip of the open review (`what:value`, e.g. `model:claude-opus-5-5`): its radio is visually hidden, its label is what a player clicks. */
const pick = (page: Page, key: string) => reviewEl(page).locator(`label:has(> input[data-key="${key}"])`).click();

test('background on: dictated, reviewed and changed, Hire closes at once; while the ack is held you play on; then one toast, one beep, no go-to', async ({ page }) => {
  test.setTimeout(200_000);
  const clean = watchErrors(page);
  await probe(page, { background: false });
  const llm = await fakeOpenAI();
  try {
    await openGame(page, 'demo-m4', '', SIM);
    await setUpLlm(page, llm);
    await setBackground(page, true);
    const at = await standOnBaking(page);
    const inbox = (await page.evaluate(() => window.__h3d.inboxItems())).length;

    // Ctrl+Shift+Space, a complete hire sentence, Enter: the populated review, nothing hired.
    await openBar(page);
    await dictate(page, 'Hire an agent on Sonnet 5.5 with high effort. Task: label the loaves and list the flour bags.');
    let r = await reviewReady(page, 'pastry');
    expect(r.desk).toBe(14);
    expect([r.choice.harness, r.choice.model, r.choice.effort, r.choice.task]).toEqual(['claude', 'claude-sonnet-5-5', 'high', 'label the loaves and list the flour bags.']);
    expect(r.sections.filter((s) => s.open)).toEqual([]);
    expect(r.blocker).toBeNull();
    expect(await hires(page)).toHaveLength(0);

    // A changed selection: the model. A still-supported effort stays; still nothing hired.
    await reviewEl(page).locator('[data-key="sec:agent"]').click();
    await pick(page, 'model:claude-opus-5-5');
    r = (await review(page)) as NonNullable<Awaited<ReturnType<typeof review>>>;
    expect([r.choice.harness, r.choice.model, r.choice.effort]).toEqual(['claude', 'claude-opus-5-5', 'high']);
    expect(await hires(page)).toHaveLength(0);

    // Hire: the review goes at once, exactly one worker.hire with the reviewed tuple, the desk held.
    await reviewEl(page).locator('[data-key="hire"]').click();
    await expect.poll(() => page.evaluate(() => window.__h3d.dialog())).toBeNull();
    await expect.poll(async () => (await hires(page)).length).toBe(1);
    expect((await hires(page))[0]?.args).toEqual(
      expect.objectContaining({ session: 'pastry', desk_index: 14, harness: 'claude', model: 'claude-opus-5-5', effort: 'high', prompt: 'label the loaves and list the flour bags.' }),
    );
    expect(await page.evaluate(() => window.__h3d.desks()[14]?.plus)).toBe(false);
    expect(await page.evaluate(() => window.__h3d.desks()[14]?.worker ?? null)).toBeNull();

    // The held ack: you play on (walking works, nobody seats you), nothing said, no beep.
    await page.keyboard.down('KeyS');
    await frames(page, 6);
    await page.keyboard.up('KeyS');
    const moved = await pose(page);
    expect(Math.hypot(moved.x - at.x, moved.z - at.z)).toBeGreaterThan(0.05);
    expect(moved).toMatchObject({ area: 'floor', floor: 'pastry', seated: false });
    expect(await toasts(page)).toEqual([]);
    expect(await beeps(page)).toBe(0);

    // The ack: exactly the success toast and one beep; nothing in the inbox, no notification, no go-to.
    await advance(page, 150);
    await expect(page.locator('.toast')).toHaveText(SPAWNED);
    await expect.poll(() => beeps(page)).toBe(1);
    await expect.poll(() => page.evaluate(() => window.__h3d.desks()[14]?.worker ?? null)).not.toBeNull();
    await expect.poll(() => page.evaluate(() => window.__h3d.arrivals().length), { timeout: 20_000 }).toBe(0);
    await page.waitForTimeout(1500);
    expect(await page.evaluate(() => window.__h3d.seated())).toBeNull();
    const after = await pose(page);
    expect([after.x, after.z]).toEqual([moved.x, moved.z]);
    expect(after).toMatchObject({ area: 'floor', floor: 'pastry', seated: false });
    expect(await toasts(page)).toEqual([SPAWNED]);
    expect(await beeps(page)).toBe(1);
    expect((await page.evaluate(() => window.__h3d.inboxItems())).length).toBe(inbox);
    expect(await notes(page)).toBe(0);
    expect(await hires(page)).toHaveLength(1);
    expect(await sentOf(page, 'hire.interpret')).toHaveLength(1);
  } finally {
    await llm.close();
  }
  clean();
});

test('background off (the default): the same dictated hire waits in the review, then goes to the new worker as before #210', async ({ page }) => {
  test.setTimeout(200_000);
  const clean = watchErrors(page);
  await probe(page, { background: false });
  const llm = await fakeOpenAI();
  try {
    await openGame(page, 'demo-m4', '', SIM);
    await setUpLlm(page, llm);
    expect(await page.evaluate(() => localStorage.getItem('h3d.hire.background'))).toBeNull();
    await standOnBaking(page);

    await openBar(page);
    await dictate(page, 'Spawn a worker on GPT-6 Sol at medium effort. Task: count the grills on the bottom floor.');
    const r = await reviewReady(page, 'pastry');
    expect([r.choice.harness, r.choice.model, r.choice.effort, r.choice.task]).toEqual(['codex', 'gpt-6-sol', 'medium', 'count the grills on the bottom floor.']);
    expect(await hires(page)).toHaveLength(0);
    // A changed selection: the effort.
    await reviewEl(page).locator('[data-key="sec:effort"]').click();
    await pick(page, 'effort:high');
    expect((await review(page))?.choice.effort).toBe('high');
    expect(await hires(page)).toHaveLength(0);

    // Hire: the review stays and waits (the foreground's waiting state) while the ack is held.
    await reviewEl(page).locator('[data-key="hire"]').click();
    await expect.poll(async () => (await hires(page)).length).toBe(1);
    expect((await hires(page))[0]?.args).toEqual(
      expect.objectContaining({ session: 'pastry', desk_index: 14, harness: 'codex', model: 'gpt-6-sol', effort: 'high', prompt: 'count the grills on the bottom floor.' }),
    );
    await expect.poll(async () => (await review(page))?.status).toMatch(/^Hiring .*: (creating the worktree, )?starting codex, handing over the first task…$/);
    expect((await review(page))?.state).toBe('hiring');
    expect(await toasts(page)).toEqual([]);

    // The ack: the dialog's own toast, then the go-to: seated at the new worker's laptop, on its conversation. No beep.
    await advance(page, 150);
    await expect(page.locator('.toast')).toHaveText(/^Hired .* at Desk 15.*\. Here they come\./);
    await expect.poll(() => review(page)).toBeNull();
    await expect.poll(() => page.evaluate(() => window.__h3d.desks()[14]?.worker ?? null), { timeout: 20_000 }).not.toBeNull();
    const id = (await page.evaluate(() => window.__h3d.desks()[14]?.worker)) as string;
    await expect.poll(() => page.evaluate(() => window.__h3d.seated()), { timeout: 20_000 }).toBe(id);
    expect(await page.evaluate(() => window.__h3d.seat().mode)).toBe('transcript');
    expect(await beeps(page)).toBe(0);
    expect(await toasts(page)).not.toContain(SPAWNED);
    expect(await hires(page)).toHaveLength(1);
  } finally {
    await llm.close();
  }
  clean();
});

test('background on and muted: the dictated hire’s toast, no sound', async ({ page }) => {
  test.setTimeout(150_000);
  const clean = watchErrors(page);
  await probe(page, { background: true, muted: true });
  const llm = await fakeOpenAI();
  try {
    await openGame(page, 'demo-m4', '', SIM);
    await setUpLlm(page, llm);
    await standOnBaking(page);
    await openBar(page);
    await dictate(page, 'Hire an agent on Sonnet 5.5 with high effort. Task: maybe bake the rye.');
    await reviewReady(page, 'pastry');
    await reviewEl(page).locator('[data-key="hire"]').click();
    await expect.poll(() => page.evaluate(() => window.__h3d.dialog())).toBeNull();
    await advance(page, 150);
    await expect(page.locator('.toast')).toHaveText(SPAWNED);
    await page.waitForTimeout(500);
    expect(await beeps(page)).toBe(0);
    expect(await toasts(page)).toEqual([SPAWNED]);
    expect(await hires(page)).toHaveLength(1);
  } finally {
    await llm.close();
  }
  clean();
});
