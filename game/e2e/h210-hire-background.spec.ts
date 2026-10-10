import { expect, test, type Page } from '@playwright/test';
import { frames, openGame, openMenu, watchErrors } from './game';
import { advance, beeps, forgetToasts, notes, pose, probe, SPAWNED, toasts } from './hireProbe';

// #210 on demo-m4 with the simulator on a manual clock (sim=1, simclock=manual): a hire's ack is held until the test
// releases it (`simAdvance`), so what happens between Hire and the ack is seen. Settings → Display "Hire in background"
// on: Hire closes the dialog at once and you play on; the ack is one toast, exactly "Agent spawned successfully.", and
// one beep, nothing in the inbox, no go-to. pastry (bottom, 16 desks, 14 and 15 empty).
//
// The beep, the toasts and desktop notifications are counted as e2e/hireProbe.ts says.

const SIM = 'play=none&sim=1&simms=150&simusage=0&simclock=manual';
const unique = () => `k${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

const hires = async (page: Page) => (await page.evaluate(() => window.__h3d.sent())).filter((c) => c.t === 'worker.hire');
const dialog = (page: Page) => page.evaluate(() => window.__h3d.dialog());
/** The first task as the editor shows it (without the caret's zero-width anchors). */
const task = async (page: Page) => ((await page.locator('#hire-task').textContent()) ?? '').replace(/\u200b/g, '');

/** On pastry, in the aisle behind desk 14's chair, facing along the aisle. */
async function onBaking(page: Page, extra = ''): Promise<{ x: number; z: number }> {
  await openGame(page, 'demo-m4', '', `${SIM}${extra}`);
  await page.evaluate(() => window.__h3d.enterFloor('pastry'));
  await frames(page, 3);
  const L = await page.evaluate(() => window.__h3d.layout('pastry'));
  const s = L?.slots[14];
  if (!L || !s) throw new Error('no desk 14');
  const at = { x: s.seat.x - Math.sin(s.yaw) * 1.1, z: s.seat.z - Math.cos(s.yaw) * 1.1 };
  await page.evaluate(([x, z]) => window.__h3d.setPose({ x, z, yaw: 0 }), [at.x, at.z] as const);
  await frames(page, 2);
  // What was said before this point is not the hire's.
  await forgetToasts(page);
  return at;
}

async function openHire(page: Page, desk: number): Promise<void> {
  await page.evaluate((d) => window.__h3d.openHire(d), desk);
  await expect.poll(async () => (await dialog(page))?.kind === 'hire' && (await dialog(page))?.state, { timeout: 10_000 }).toBe('ready');
  await page.locator('#hire-task').focus();
}

/** Pastes a small PNG named `name` into the first task. */
async function pasteImage(page: Page, name: string): Promise<void> {
  await page.evaluate(async (n) => {
    const c = document.createElement('canvas');
    c.width = 64;
    c.height = 64;
    (c.getContext('2d') as CanvasRenderingContext2D).fillRect(0, 0, 32, 32);
    const blob = await new Promise<Blob>((r) => c.toBlob((b) => r(b as Blob), 'image/png'));
    const dt = new DataTransfer();
    dt.items.add(new File([blob], n, { type: 'image/png' }));
    (document.querySelector('#hire-task') as HTMLElement).dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, name);
}

/** Opens the hire dialog for `desk`, types a first task and presses Enter: the dialog is gone at once. */
async function hire(page: Page, desk: number, task: string): Promise<void> {
  await openHire(page, desk);
  await page.keyboard.type(task);
  await page.keyboard.press('Enter');
  expect(await dialog(page)).toBeNull();
}

test('the setting is off by default, kept across a reload; on, Hire closes at once and the ack is one toast and one beep', async ({ page }) => {
  test.setTimeout(150_000);
  const clean = watchErrors(page);
  await probe(page, { background: false });
  await openGame(page, 'demo-m4', '', SIM);

  // Settings → Display: the row sits right after "Go to a new hire after hiring", off.
  await openMenu(page);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const display = page.getByRole('dialog', { name: 'Settings' }).locator('[data-section="display"]');
  await display.scrollIntoViewIfNeeded();
  const box = display.getByLabel(/^Hire in background/);
  await expect(box).not.toBeChecked();
  await expect(display.getByLabel(/^Go to a new hire after hiring/)).toBeChecked();
  expect(await display.locator('label.settings-switch').evaluateAll((ls) => ls.map((l) => l.querySelector('input')?.id))).toEqual(
    expect.arrayContaining(['settings-hire-goto', 'settings-hire-background']),
  );
  expect(await display.locator('#settings-hire-goto').evaluate((g) => g.closest('label')?.nextElementSibling?.querySelector('input')?.id)).toBe('settings-hire-background');
  await box.check();
  expect(await page.evaluate(() => localStorage.getItem('h3d.hire.background'))).toBe('on');
  await page.reload();
  await page.waitForFunction(() => window.__h3d?.ready && window.__h3d.frames >= 3);
  await openMenu(page);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Settings' }).locator('[data-section="display"]').getByLabel(/^Hire in background/)).toBeChecked();

  const at = await onBaking(page);
  const inbox = (await page.evaluate(() => window.__h3d.inboxItems())).length;
  await hire(page, 14, 'Label the loaves');
  // The desk is held for the hire; nothing said yet; the hire is one worker.hire.
  await expect.poll(() => page.evaluate(() => window.__h3d.desks()[14]?.plus)).toBe(false);
  expect(await page.evaluate(() => window.__h3d.desks()[14]?.worker ?? null)).toBeNull();
  expect(await hires(page)).toHaveLength(1);

  // You play on: walking works, nobody sits you down, no early toast or beep.
  await page.keyboard.down('KeyS');
  await frames(page, 6);
  await page.keyboard.up('KeyS');
  const moved = await pose(page);
  expect(Math.hypot(moved.x - at.x, moved.z - at.z)).toBeGreaterThan(0.05);
  expect(moved).toMatchObject({ area: 'floor', floor: 'pastry', seated: false });
  expect(await toasts(page)).toEqual([]);
  expect(await beeps(page)).toBe(0);

  // The ack: exactly the success toast and one beep; nothing in the inbox, no notification, no go-to (it is on).
  await advance(page, 150);
  await expect(page.locator('.toast')).toHaveText(SPAWNED);
  await expect.poll(() => beeps(page)).toBe(1);
  await expect.poll(() => page.evaluate(() => window.__h3d.desks()[14]?.worker ?? null)).not.toBeNull();
  await expect.poll(() => page.evaluate(() => window.__h3d.arrivals().length), { timeout: 20_000 }).toBe(0);
  await page.waitForTimeout(1500);
  expect(await page.evaluate(() => window.__h3d.seated())).toBeNull();
  const after = await pose(page);
  expect([after.x, after.z]).toEqual([moved.x, moved.z]);
  expect(await toasts(page)).toEqual([SPAWNED]);
  expect(await beeps(page)).toBe(1);
  expect((await page.evaluate(() => window.__h3d.inboxItems())).length).toBe(inbox);
  expect(await notes(page)).toBe(0);
  expect(await hires(page)).toHaveLength(1);
  clean();
});

test('muted: the toast, no sound', async ({ page }) => {
  test.setTimeout(150_000);
  const clean = watchErrors(page);
  await probe(page, { muted: true });
  await onBaking(page);
  await hire(page, 14, 'Quietly');
  await advance(page, 150);
  await expect(page.locator('.toast')).toHaveText(SPAWNED);
  await page.waitForTimeout(500);
  expect(await beeps(page)).toBe(0);
  expect(await toasts(page)).toEqual([SPAWNED]);
  clean();
});

test('an image that does not upload: the desk is held while it tries, then let go; no worker.hire, the draft kept', async ({ page }) => {
  test.setTimeout(150_000);
  // The forced failure is a real 502 the browser logs by itself: only script errors count here.
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const clean = () => expect(errors).toEqual([]);
  await probe(page);
  await onBaking(page, `&upload_key=${unique()}&fail_upload=all&upload_delay=1500`);
  await openHire(page, 14);
  await page.keyboard.type('See ');
  await pasteImage(page, 'grill.png');
  await page.keyboard.press('Enter');
  expect(await dialog(page)).toBeNull();
  // Uploading: the desk is already held, so no other hire can take it.
  await expect.poll(() => page.evaluate(() => window.__h3d.desks()[14]?.plus)).toBe(false);
  await expect(page.locator('.toast')).toHaveText(/^Nothing was hired at Desk 15: image 1 \(grill\.png\) did not upload/, { timeout: 10_000 });
  await expect.poll(() => page.evaluate(() => window.__h3d.desks()[14]?.plus)).toBe(true);
  expect(await hires(page)).toHaveLength(0);
  expect(await beeps(page)).toBe(0);
  await openHire(page, 14);
  expect(await task(page)).toContain('See');
  expect((await dialog(page)) as unknown).toMatchObject({ images: [{ name: 'grill.png', status: 'error' }] });
  clean();
});

test('off (foreground): the images go up before the desk is held, as before: Esc while they upload, the same desk opens again', async ({ page }) => {
  test.setTimeout(150_000);
  const clean = watchErrors(page);
  await probe(page, { background: false });
  await onBaking(page, `&upload_key=${unique()}&upload_delay=8000`);
  await openHire(page, 14);
  await page.keyboard.type('See ');
  await pasteImage(page, 'crumb.png');
  await page.keyboard.press('Enter');
  // The dialog waits on the upload; the desk is not held yet (nothing is sent until the image is up).
  expect(await dialog(page)).toMatchObject({ kind: 'hire', desk: 14, state: 'hiring', status: expect.stringMatching(/^Uploading the image/) });
  expect(await page.evaluate(() => window.__h3d.desks()[14]?.plus)).toBe(true);
  await page.keyboard.press('Escape');
  expect(await dialog(page)).toBeNull();
  // Esc did not cancel it, and did not take the desk: its dialog opens again.
  await openHire(page, 14);
  expect(await dialog(page)).toMatchObject({ kind: 'hire', desk: 14 });
  expect(await page.evaluate(() => window.__h3d.desks()[14]?.plus)).toBe(true);
  expect(await hires(page)).toHaveLength(0);
  await page.keyboard.press('Escape');
  // The image is up: now the desk is held and worker.hire goes, once, with its Drop Zone path.
  await expect.poll(() => hires(page), { timeout: 30_000 }).toHaveLength(1);
  expect(await page.evaluate(() => window.__h3d.desks()[14]?.plus)).toBe(false);
  expect(((await hires(page))[0]!.args as { prompt: string }).prompt).toMatch(/^See \[Image #1: \/home\/fixture\/drops\/\S+\.png\]$/);
  await advance(page, 150);
  await expect(page.locator('.toast')).toHaveText(/^Hired .* at Desk 15.*\. Here they come\./);
  await expect.poll(() => page.evaluate(() => window.__h3d.desks()[14]?.worker ?? null)).not.toBeNull();
  expect(await toasts(page)).not.toContain(SPAWNED);
  expect(await beeps(page)).toBe(0);
  clean();
});

test('a launch failure and a task not delivered: each its own error, the desk let go or taken, the draft kept, one worker.hire', async ({ page }) => {
  test.setTimeout(150_000);
  const clean = watchErrors(page);
  await probe(page);
  await onBaking(page, '&simfail=hire_failed');
  await hire(page, 14, 'Proof the dough');
  await advance(page, 150);
  await expect(page.locator('.toast')).toHaveText(/^Desk 15 of pastry · .*claude exited during startup/);
  await expect.poll(() => page.evaluate(() => window.__h3d.desks()[14]?.plus)).toBe(true);
  expect(await hires(page)).toHaveLength(1);
  expect(await beeps(page)).toBe(0);
  await openHire(page, 14);
  expect(await task(page)).toBe('Proof the dough');
  await page.keyboard.press('Escape');

  // A fresh page and simulator: the next hire's first task is not delivered.
  await onBaking(page, '&simfail=prompt_undelivered');
  await hire(page, 15, 'Score the loaves');
  await advance(page, 150);
  await expect(page.locator('.toast')).toHaveText(
    /^Hired .* at Desk 16\. The first task was not sent \(the agent did not take the task \(simulated\)\): prompt them yourself \(P\); the task is in their prompt\.$/,
  );
  await expect(page.locator('.toast')).toHaveAttribute('data-kind', 'error');
  await expect.poll(() => page.evaluate(() => window.__h3d.desks()[15]?.worker ?? null)).not.toBeNull();
  expect(await hires(page)).toHaveLength(1);
  expect(await beeps(page)).toBe(0);
  expect(await toasts(page)).not.toContain(SPAWNED);
  // The desk is theirs now (its hire dialog does not open): the task is in their Prompt (P) note, to send by hand.
  const id = (await page.evaluate(() => window.__h3d.desks()[15]?.worker ?? null)) as string;
  await page.evaluate((w) => window.__h3d.openPrompt(w), id);
  await expect.poll(() => page.evaluate(() => window.__h3d.panel())).toMatchObject({ kind: 'prompt', id, text: 'Score the loaves' });
  expect(await hires(page)).toHaveLength(1);
  clean();
});

test('a dialog edited while an earlier hire ends keeps its edits; two hires on their way end on their own', async ({ page }) => {
  test.setTimeout(150_000);
  const clean = watchErrors(page);
  await probe(page);
  await onBaking(page);
  await hire(page, 14, 'First loaf');
  await advance(page, 100); // (so the acks fall at different times)

  // Desk 15's dialog is being written in when desk 14's hire ends: it is told nothing and loses nothing.
  await openHire(page, 15);
  await page.keyboard.type('Second loaf');
  await advance(page, 60);
  await expect(page.locator('.toast')).toHaveText(SPAWNED);
  await expect.poll(() => beeps(page)).toBe(1);
  await expect.poll(() => page.evaluate(() => window.__h3d.desks()[14]?.worker ?? null)).not.toBeNull();
  expect(await dialog(page)).toMatchObject({ kind: 'hire', desk: 15, state: 'ready', status: '', error: false });
  await page.keyboard.type(', scored');
  expect(await task(page)).toBe('Second loaf, scored');
  await page.keyboard.press('Enter');
  expect(await dialog(page)).toBeNull();

  // The hire made room (desk 16, Desk 17): a second hire while desk 15's is still on its way.
  await advance(page, 50);
  await expect.poll(() => page.evaluate(() => window.__h3d.desks()[16]?.plus ?? false)).toBe(true);
  await hire(page, 16, 'Third loaf');
  // Desk 15's ack, then desk 16's: each its own toast and beep.
  await advance(page, 110);
  await expect.poll(() => beeps(page)).toBe(2);
  await expect.poll(() => page.evaluate(() => window.__h3d.desks()[15]?.worker ?? null)).not.toBeNull();
  expect(await page.evaluate(() => window.__h3d.desks()[16]?.worker ?? null)).toBeNull();
  await advance(page, 50);
  await expect.poll(() => beeps(page)).toBe(3);
  await expect.poll(() => page.evaluate(() => window.__h3d.desks()[16]?.worker ?? null)).not.toBeNull();
  expect(await toasts(page)).toEqual([SPAWNED, SPAWNED, SPAWNED]);
  expect((await hires(page)).map((h) => h.args as { desk_index: number; prompt: string })).toEqual([
    expect.objectContaining({ desk_index: 14, prompt: 'First loaf' }),
    expect.objectContaining({ desk_index: 15, prompt: 'Second loaf, scored' }),
    expect.objectContaining({ desk_index: 16, prompt: 'Third loaf' }),
  ]);
  clean();
});

test('a dropped connection while the hire is on its way: an outcome-unknown notice, never a second worker.hire', async ({ page }) => {
  test.setTimeout(150_000);
  const clean = watchErrors(page);
  await probe(page);
  await onBaking(page);
  await hire(page, 14, 'Maybe bake');
  await page.evaluate(() => window.__h3d.reconnect());
  await expect(page.locator('.toast')).toHaveText(/^No answer about the hire at Desk 15 of pastry: the connection dropped\. It may still have gone through/);
  await expect(page.locator('.toast')).toHaveAttribute('data-kind', 'warn');
  await expect.poll(() => page.evaluate(() => window.__h3d.connection().phase), { timeout: 20_000 }).toBe('live');
  await page.waitForTimeout(1000);
  expect(await hires(page)).toHaveLength(1);
  expect(await beeps(page)).toBe(0);
  expect(await toasts(page)).not.toContain(SPAWNED);
  expect(await page.evaluate(() => localStorage.getItem('h3d.draft.hire.pastry:14'))).toContain('Maybe bake');
  clean();
});
