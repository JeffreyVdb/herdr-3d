import { expect, test, type Page } from '@playwright/test';
import { frames, openGame, seatMode, settingsSection, shot, watchErrors, openMenu } from './game';
import { CLEANUP, fakeJev, fakeOpenAI, setUpModels, setUpPackupClock, switchOn, withPositivePackup } from './packupFakes';

// #110 pack up on request against the fixture bridge (`sim=1`, tools/fixture-packup.ts), whose AI integration calls
// fake Jev and OpenAI-compatible servers started here on OS-leased loopback ports: no spec reaches a real provider.
// Set up both models, pass the pack-up test, switch it on; then a prompt that also says to leave is checked before it
// goes, and its confirm (the send home's pack-up mode) sends the task as a wrap-up, or the prompt as written.

const sent = (page: Page, t: string) => page.evaluate((x) => window.__h3d.sent().filter((c) => c.t === x), t);
type Dialog = NonNullable<ReturnType<Window['__h3d']['dialog']>>;
type Home = Extract<Dialog, { kind: 'send-home' }>;
const home = (page: Page) => page.evaluate(() => window.__h3d.dialog()) as Promise<Home | null>;

async function idOf(page: Page, session: string, name: string): Promise<string> {
  return page.evaluate(([s, n]) => window.__h3d.world().find((f) => f.session === s)?.workers.find((w) => w.name === n)?.id ?? '', [session, name] as const);
}

async function packupDialog(page: Page): Promise<Home> {
  await expect.poll(async () => {
    const d = await home(page);
    if (d?.kind === 'send-home' && d.mode === 'packup' && d.state === 'ready') return 'ready';
    return JSON.stringify({ dialog: d, detect: (await sent(page, 'packup.detect')).at(-1)?.result ?? null });
  }, { message: 'pack-up confirm ready', timeout: 10_000 }).toBe('ready');
  return (await home(page)) as Home;
}

test('Settings: the switch is off until a test passed, after the follow-up questions, in a wider dialog', async ({ page }) => {
  const clean = watchErrors(page);
  const [jev, llm] = [await fakeJev(), await fakeOpenAI()];
  try {
    await openGame(page, 'demo-m4', '', `play=none&sim=1&simms=150&simjev=${encodeURIComponent(jev.url)}`);
    await openMenu(page);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Settings' });
    // #49: far wider than the old 640 px on a desktop, the section picked from the list.
    expect(Math.round((await dialog.boundingBox())!.width)).toBeGreaterThan(900);
    const section = await settingsSection(page, 'packup');
    await expect(section.getByRole('heading', { name: 'Pack up on request', level: 3 })).toBeVisible();
    await expect(section.locator('.settings-store')).toHaveText('Bridge');
    // The request classifiers follow the follow-up questions; other classifiers can sit between them.
    expect(await dialog.locator('section.settings-section').evaluateAll((s) => s.map((x) => (x as HTMLElement).dataset.section))).toEqual(
      expect.arrayContaining(['followups', 'packup']),
    );
    const order = await dialog.locator('section.settings-section').evaluateAll((s) => s.map((x) => (x as HTMLElement).dataset.section));
    expect(order.indexOf('packup')).toBeGreaterThan(order.indexOf('followups'));
    const toggle = section.getByRole('checkbox', { name: 'Pack up on request' });
    await expect(toggle).not.toBeChecked();
    await expect(toggle).toBeDisabled();
    const [note, sw] = await Promise.all([section.locator('.settings-fu-privacy').boundingBox(), toggle.boundingBox()]);
    expect(note && sw && note.y + note.height <= sw.y).toBe(true);
    await setUpModels(page, dialog, llm);
    await expect(toggle).toBeDisabled();
    expect(await sent(page, 'packup.set')).toHaveLength(0);
    expect(await sent(page, 'packup.detect')).toHaveLength(0);
    await section.getByRole('button', { name: 'Test' }).click();
    await expect(section).toContainText('Test passed');
    await expect(section.locator('.settings-fu-result > .settings-fu-samples')).toContainText('Sent as: “Please make a PR”');
    await expect(section.locator('.settings-pk-all summary')).toHaveText(/^\d+ of 8 sample prompts as expected at 0\.85$/);
    await toggle.check();
    await expect(section).toContainText('On: each prompt is checked');
    expect(await page.evaluate(() => window.__h3d.packup())).toMatchObject({ enabled: true, state: 'ready', tested: true });
    await section.scrollIntoViewIfNeeded();
    await shot(page, 'settings-packup');
    // A phone: the dialog takes nearly the whole width (#49: 8 px margins), the section its one column, still showing.
    await page.setViewportSize({ width: 320, height: 640 });
    await expect.poll(async () => Math.round((await dialog.boundingBox())!.width)).toBeLessThanOrEqual(304);
    expect((await dialog.boundingBox())!.width).toBeGreaterThan(290);
    await expect(section).toBeVisible();
    await expect(dialog.getByLabel('Section', { exact: true })).toHaveValue('packup');
    const scroll = await dialog.locator('.settings-body').evaluate((e) => e.scrollWidth - e.clientWidth);
    expect(scroll).toBeLessThanOrEqual(0);
    await section.scrollIntoViewIfNeeded();
    await shot(page, 'settings-packup-phone');
  } finally {
    await Promise.all([jev.close(), llm.close()]);
  }
  clean();
});

test('the P overlay: checking…, the confirm with the leaving part struck, an edited task, Send and go home is a wrap-up', async ({ page }) => {
  test.setTimeout(120_000);
  await setUpPackupClock(page);
  const clean = watchErrors(page);
  const [jev, llm] = [await fakeJev(), await fakeOpenAI()];
  try {
    await openGame(page, 'demo-m4', '', `play=none&sim=1&simms=150&simmodel=packup&simjev=${encodeURIComponent(jev.url)}`);
    await switchOn(page, llm);
    await page.keyboard.press('Escape');
    await page.evaluate(() => window.__h3d.enterFloor('pastry'));
    await frames(page, 3);
    // Marble: a clean linked worktree the bridge made, so its branch may go too.
    const id = await idOf(page, 'pastry', 'Marble');
    await page.evaluate((i) => window.__h3d.openPrompt(i), id);
    const overlay = page.locator('dialog.desk-dlg--prompt');
    await expect(overlay).toBeVisible();
    await page.keyboard.type('Fix the header, then go home.');
    await withPositivePackup(page, () => page.keyboard.press('Enter'));
    const d = await packupDialog(page);
    expect(d.title).toBe('Send the task, then send Marble home');
    expect(d.choice).toBe('delete_branch');
    expect(d.packup).toEqual({ original: 'Fix the header, then go home.', task: 'Fix the header.', removed: [{ start: 14, end: 28 }] });
    const confirm = page.locator('dialog.desk-dlg--home');
    await expect(confirm.locator('[data-key="pk-original"] del')).toHaveText(', then go home');
    await expect(confirm.locator('[data-key="wrap-prompt"]')).toHaveValue('Fix the header.');
    await expect(confirm.locator('.dd-actions button')).toHaveText(['Cancel', 'Send as written (stay)', 'Send and go home']);
    await expect(confirm.locator('input[value="delete_branch"]')).toBeChecked();
    expect(await sent(page, 'worker.prompt')).toHaveLength(0);
    await shot(page, 'packup-confirm');
    // Edit the task, then Send and go home (a click: the choice is in plain sight).
    await confirm.locator('[data-key="wrap-prompt"]').fill('Fix the header in app.ts.');
    await confirm.locator('[data-key="send"]').click();
    await expect(confirm).toBeHidden();
    const wrap = await sent(page, 'worker.wrapup');
    expect(wrap.map((c) => c.args)).toEqual([{ id, prompt: `Fix the header in app.ts.\n\n${CLEANUP}`, worktree: 'delete_branch' }]);
    expect(wrap[0]!.result).toMatchObject({ ok: true });
    expect(await sent(page, 'worker.prompt')).toHaveLength(0);
    // The overlay says it, and its note is empty again.
    await expect(overlay.locator('p.dd-status[role="status"]')).toContainText('Marble gets the task, then goes home once it reports CLEAN');
    expect(await page.evaluate(() => (window.__h3d.panel() as { text?: string } | null)?.text)).toBe('');
    // CLEAN: the existing send home takes it.
    expect(await page.evaluate((i) => window.__h3d.simWrapUp({ id: i, verdict: 'clean' }), id)).toMatchObject({ ok: true });
    // (It packs a box and walks out first: give it the walk.)
    await expect.poll(() => page.evaluate((i) => window.__h3d.world().some((f) => f.workers.some((w) => w.id === i)), id), { timeout: 20_000 }).toBe(false);
  } finally {
    await Promise.all([jev.close(), llm.close()]);
  }
  clean();
});

async function sitAtTranscript(page: Page, name: string): Promise<string> {
  await page.evaluate(() => window.__h3d.enterFloor('herdr-3d'));
  await frames(page, 3);
  const id = await idOf(page, 'herdr-3d', name);
  expect(await page.evaluate((i) => window.__h3d.face(i), id)).toBe(true);
  await frames(page, 3);
  expect(await page.evaluate((i) => window.__h3d.sitAt(i), id)).toBe(true);
  await frames(page, 20);
  await seatMode(page, 'transcript');
  return id;
}

test('the laptop’s prompt box: send as written, cancel, nothing left, a tampered cut, Esc while checking, the timeouts', async ({ page }) => {
  test.setTimeout(180_000);
  await setUpPackupClock(page);
  const clean = watchErrors(page);
  const [jev, llm] = [await fakeJev(), await fakeOpenAI()];
  try {
    await openGame(page, 'demo-m5', '', `play=none&sim=1&simms=300&simusage=0&simecho=200&simmodel=packup&simjev=${encodeURIComponent(jev.url)}`);
    await switchOn(page, llm);
    await page.keyboard.press('Escape');
    const id = await sitAtTranscript(page, 'Pebble');
    const tx = page.locator('.seat-transcript .tx');
    const input = tx.locator('.tx-input');
    const confirm = page.locator('dialog.desk-dlg--home');
    const write = async (text: string, positive = false) => {
      await expect(input).toHaveAttribute('contenteditable', 'true', { timeout: 20_000 });
      await input.click();
      await page.keyboard.press('Control+A');
      await page.keyboard.press('Delete');
      await page.keyboard.type(text);
      if (positive) await withPositivePackup(page, () => page.keyboard.press('Enter'));
      else await page.keyboard.press('Enter');
    };
    const prompts = async () => (await sent(page, 'worker.prompt')).map((c) => (c.args as { text: string }).text);

    // Send as written (stay): the prompt goes as you wrote it, through worker.prompt.
    await write('Please make a PR and end your turn', true);
    await packupDialog(page);
    await expect(confirm.locator('[data-key="pk-original"] del')).toHaveText(' and end your turn');
    await confirm.getByRole('button', { name: 'Send as written (stay)' }).click();
    await expect(confirm).toBeHidden();
    await expect.poll(prompts).toEqual(['Please make a PR and end your turn']);
    await expect(input).toHaveText('');
    expect(await sent(page, 'worker.wrapup')).toHaveLength(0);

    // Cancel (Esc): nothing is sent, the draft stays in the box.
    await write('Please make a PR and stop working', true);
    await packupDialog(page);
    await page.keyboard.press('Escape');
    await expect(confirm).toBeHidden();
    await frames(page, 5);
    expect(await prompts()).toHaveLength(1);
    await expect(input).toHaveText('Please make a PR and stop working');

    // A prompt that does not ask to leave goes as written, no dialog.
    await write('Please make a PR');
    await expect.poll(prompts).toEqual(['Please make a PR and end your turn', 'Please make a PR']);
    expect(await home(page)).toBeNull();
    await expect(input).toHaveText(''); // its ack came: the box takes the next one

    // Nothing left of it: the plain send-home dialog, nothing sent.
    await write('Go home and clean up the worktree.', true);
    await expect.poll(async () => (await home(page))?.mode ?? null).toBe('home');
    await page.keyboard.press('Escape');
    expect(await prompts()).toHaveLength(2);
    await expect(input).toHaveText('Go home and clean up the worktree.');

    // A cut that is not in the prompt (the LLM tampered with it): sent as written, never eaten.
    await write('Ship it TAMPER and finish the day');
    await expect.poll(prompts).toContain('Ship it TAMPER and finish the day');
    expect(await home(page)).toBeNull();
    await expect(input).toHaveText('');

    // Esc while it is checked: nothing goes, the draft stays, you stay seated.
    await write('SLOW: make a PR and end your turn');
    await expect.poll(() => page.evaluate(() => window.__h3d.seat().note)).toBe('Checking the prompt…');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(3000);
    expect(await prompts()).not.toContain('SLOW: make a PR and end your turn');
    expect(await home(page)).toBeNull();
    await expect(input).toHaveText('SLOW: make a PR and end your turn');
    expect(await page.evaluate(() => window.__h3d.seated())).toBe(id);
    expect(await page.evaluate(() => window.__h3d.seat().note)).toBe('Not sent: the prompt is still in the box.');

    // A model too slow: the bridge gives up after 1.2 s, and the prompt goes as written. Under rendering load the
    // game's 1.5 s bound can win before that no-match reply is dispatched: both outcomes must fail open once.
    const lastDetect = async () => (await sent(page, 'packup.detect')).at(-1)?.result;
    let t0 = Date.now();
    await input.click();
    await page.keyboard.press('Enter');
    await expect.poll(prompts, { timeout: 6000 }).toContain('SLOW: make a PR and end your turn');
    expect(Date.now() - t0).toBeLessThan(4500);
    expect(await home(page)).toBeNull();
    const detected = await lastDetect();
    expect(detected).toMatchObject(detected?.ok ? { ok: true, data: { matched: false } } : { ok: false, code: 'timeout' });
    expect((await prompts()).filter((p) => p === 'SLOW: make a PR and end your turn')).toHaveLength(1);
    await expect(input).toHaveAttribute('contenteditable', 'true', { timeout: 20_000 });
    await expect(input).toHaveText('');

    // The game's own bound: an answer held 4 s on the way (a slow link, a busy bridge) is too late. 1.5 s after Send the
    // prompt goes as written, for a slow model's no match and for a match alike, and the late match opens nothing.
    expect(await page.evaluate(() => window.__h3d.simPackupLag(4000))).toBe(true);
    for (const text of ['SLOW: fix the docs and end your turn', 'Fix the docs and stop working']) {
      await write(text);
      t0 = Date.now(); // Enter is pressed
      await expect.poll(prompts, { timeout: 6000, intervals: [50] }).toContain(text);
      expect(Date.now() - t0).toBeLessThan(2300);
      expect(await lastDetect()).toMatchObject({ ok: false, code: 'timeout' });
      await expect(input).toHaveText('');
      await page.waitForTimeout(4500 - (Date.now() - t0)); // the held answer has come by now
      expect(await home(page)).toBeNull();
      await expect(confirm).toBeHidden();
      expect((await prompts()).filter((p) => p === text)).toHaveLength(1);
    }
    expect(await sent(page, 'worker.wrapup')).toHaveLength(0);
    const detects = await sent(page, 'packup.detect');
    expect(detects.every((c) => (c.args as { id: string }).id === id)).toBe(true);
  } finally {
    await Promise.all([jev.close(), llm.close()]);
  }
  clean();
});
