import { expect, test, type Page } from '@playwright/test';
import { frames, openGame, shot, watchErrors } from './game';

// #83 on the demo-m4 fixture and the simulating fixture server (tools/fixture-sim.ts): "Wrap up, then send home" in the
// send-home dialog. Marble (pastry desk 2, done, a clean linked worktree the bridge made) and Noodle (herdr-3d desk 6,
// done, a clean linked worktree of its own); Jellybean (pastry desk 0, working) has unsaved work. `sim.wrapup` plays
// the agent's result line (`window.__h3d.simWrapUp`).

const SIM = 'play=none&sim=1&simms=150';

type Dialog = NonNullable<ReturnType<Window['__h3d']['dialog']>>;
type Home = Extract<Dialog, { kind: 'send-home' }>;

const dialog = (page: Page) => page.evaluate(() => window.__h3d.dialog());
const sent = (page: Page) => page.evaluate(() => window.__h3d.sent());
const home = async (page: Page) => (await dialog(page)) as Home;
const focusedKey = (page: Page) =>
  page.evaluate(() => {
    const a = document.activeElement as HTMLElement | null;
    return !a || a === document.body ? 'BODY' : (a.dataset.key ?? a.id);
  });

async function homeDialog(page: Page): Promise<Home> {
  await expect.poll(async () => (await dialog(page))?.kind === 'send-home' && (await dialog(page))?.state, { message: 'send-home dialog ready', timeout: 10_000 }).toBe('ready');
  return home(page);
}

async function enter(page: Page, session: string): Promise<void> {
  await page.evaluate((s) => window.__h3d.enterFloor(s), session);
  await frames(page, 3);
}

async function idOf(page: Page, session: string, name: string): Promise<string> {
  return page.evaluate(([s, n]) => window.__h3d.world().find((f) => f.session === s)?.workers.find((w) => w.name === n)?.id ?? '', [session, name] as const);
}

/** Stands behind a desk's seat, facing it: its worker's card is in view. */
async function faceDesk(page: Page, session: string, desk: number): Promise<void> {
  await page.evaluate(
    ([s, d]) => {
      const slot = window.__h3d.layout(s)?.slots[d];
      if (!slot) throw new Error(`no desk ${d} on ${s}`);
      const fx = Math.sin(slot.yaw);
      const fz = Math.cos(slot.yaw);
      window.__h3d.setPose({ x: slot.seat.x - fx * 1.1, z: slot.seat.z - fz * 1.1, yaw: Math.atan2(-fx, -fz), pitch: -0.3 });
    },
    [session, desk] as const,
  );
  await frames(page, 3);
}

const cardAt = (page: Page, desk: number) => page.evaluate((d) => window.__h3d.cards().find((c) => c.desk === d) ?? null, desk);

test('wrap up: delete preselected, Enter in the prompt adds lines, Enter on a delete asks first; CLEAN sends it home with its worktree deleted', async ({ page }) => {
  test.setTimeout(120_000);
  const clean = watchErrors(page);
  await openGame(page, 'demo-m4', '', SIM);
  await enter(page, 'pastry');
  await faceDesk(page, 'pastry', 2);
  const id = await idOf(page, 'pastry', 'Marble');
  await page.evaluate((i) => window.__h3d.openSendHome(i), id);
  let d = await homeDialog(page);
  expect(d).toMatchObject({ mode: 'home', choice: 'delete', confirming: false, wrapup: null });
  await expect(page.locator('dialog.desk-dlg--home [data-key="wrap"]')).toHaveText('Wrap up, then send home');

  // The second action: the editable prompt first, the worktree choice up front, the footer not shown.
  await page.locator('dialog.desk-dlg--home [data-key="wrap"]').click();
  await expect.poll(async () => (await home(page)).mode).toBe('wrapup');
  d = await home(page);
  expect(d.title).toBe('Wrap up Marble, then send home');
  expect(d.choice).toBe('delete');
  expect(d.prompt).toBe('Stop every server, background process, pane and freelancer you started in this session. Don’t touch anything else.');
  expect(await focusedKey(page)).toBe('wrap-prompt');
  await expect(page.locator('dialog.desk-dlg--home')).not.toContainText('H3D-WRAPUP');
  await expect(page.locator('dialog.desk-dlg--home [data-key="send"]')).toHaveText('Wrap up, then send home');
  // Enter and Shift+Enter in the prompt add lines; nothing is sent, no warning opens.
  await page.keyboard.press('Control+End');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('Also close the tmux pane you split.');
  await page.keyboard.press('Enter');
  d = await home(page);
  expect(d.prompt).toBe('Stop every server, background process, pane and freelancer you started in this session. Don’t touch anything else.\n\nAlso close the tmux pane you split.\n');
  expect(d.confirming).toBe(false);
  expect((await sent(page)).map((c) => c.t)).toEqual(['worker.fire.prepare']);
  await shot(page, 'm83-wrapup-prompt');

  // Enter on the delete choice: the warning, Cancel focused; a second Enter cancels.
  await page.locator('#home-delete').focus();
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await home(page)).confirming).toBe(true);
  await expect(page.locator('dialog.desk-dlg--home .dd-confirm')).toContainText('Delete the worktree at /home/dev/pastry-wt/timers? This cannot be undone.');
  expect(await focusedKey(page)).toBe('confirm-cancel');
  await shot(page, 'm83-wrapup-confirm');
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await home(page)).confirming).toBe(false);
  expect((await sent(page)).map((c) => c.t)).toEqual(['worker.fire.prepare']);
  // Esc in the warning steps back to the dialog, it does not close it.
  await page.locator('#home-delete').focus();
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await home(page)).confirming).toBe(true);
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await home(page))?.confirming).toBe(false);
  // Enter, Tab to the danger button, Enter: armed.
  await page.locator('#home-delete').focus();
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await home(page)).confirming).toBe(true);
  await page.keyboard.press('Tab');
  expect(await focusedKey(page)).toBe('confirm');
  await page.keyboard.press('Enter');
  await expect.poll(() => dialog(page)).toBeNull();
  expect((await sent(page)).filter((c) => c.t === 'worker.wrapup').map((c) => c.args)).toEqual([
    {
      id,
      prompt: 'Stop every server, background process, pane and freelancer you started in this session. Don’t touch anything else.\n\nAlso close the tmux pane you split.\n',
      worktree: 'delete',
    },
  ]);
  await expect(page.locator('.toast')).toHaveText('Marble is wrapping up. Once it reports CLEAN it goes home. Its worktree is deleted.');

  // At its desk: the cardboard tape. In the dialog: what it waits for, and Cancel wrap-up instead of a second arm.
  await expect.poll(async () => (await cardAt(page, 2))?.tape?.text ?? null).toBe('WRAPPING UP');
  await shot(page, 'm83-wrapping-up-card');
  await page.evaluate((i) => window.__h3d.openSendHome(i), id);
  d = await homeDialog(page);
  expect(d.wrapup).toMatchObject({ state: 'armed', worktree: 'delete' });
  await expect(page.locator('dialog.desk-dlg--home .dd-wrap')).toContainText('Marble is wrapping up. Once it reports CLEAN it goes home: its worktree is deleted.');
  await expect(page.locator('dialog.desk-dlg--home [data-key="wrap-cancel"]')).toHaveText('Cancel wrap-up');
  await expect(page.locator('dialog.desk-dlg--home [data-key="wrap"]')).toHaveCount(0);
  await shot(page, 'm83-wrapup-armed');
  await page.keyboard.press('Escape');
  await expect.poll(() => dialog(page)).toBeNull();

  // The agent reports CLEAN: sent home with its worktree deleted.
  expect((await page.evaluate((i) => window.__h3d.simWrapUp({ id: i, verdict: 'clean' }), id)).ok).toBe(true);
  await expect(page.locator('.toast')).toHaveText('Sent Marble home after wrap-up. Its worktree is deleted.');
  await expect.poll(async () => (await page.evaluate(() => window.__h3d.world())).find((f) => f.session === 'pastry')?.workers.some((w) => w.id === id)).toBe(false);
  clean();
});

test('wrap up needs you: the reason on the card and in the dialog; only Wrap up again re-arms; Cancel wrap-up', async ({ page }) => {
  test.setTimeout(120_000);
  const clean = watchErrors(page);
  await openGame(page, 'demo-m4', '', SIM);
  await enter(page, 'herdr-3d');
  await faceDesk(page, 'herdr-3d', 6);
  const id = await idOf(page, 'herdr-3d', 'Noodle');
  await page.evaluate((i) => window.__h3d.openSendHome(i), id);
  let d = await homeDialog(page);
  expect(d.choice).toBe('delete');
  await page.locator('dialog.desk-dlg--home [data-key="wrap"]').click();
  await expect.poll(async () => (await home(page)).mode).toBe('wrapup');
  // Keep it, and send with the button: keep needs no warning.
  await page.locator('label[for="home-keep"]').click();
  expect((await home(page)).choice).toBe('keep');
  await page.locator('dialog.desk-dlg--home [data-key="send"]').click();
  await expect.poll(() => dialog(page)).toBeNull();
  expect((await sent(page)).filter((c) => c.t === 'worker.wrapup').map((c) => c.args)).toEqual([
    { id, prompt: 'Stop every server, background process, pane and freelancer you started in this session. Don’t touch anything else.', worktree: 'keep' },
  ]);

  const reason = 'the preview server on port 4173 belongs to another session';
  expect((await page.evaluate(([i, r]) => window.__h3d.simWrapUp({ id: i, verdict: 'blocked', reason: r }), [id, reason] as const)).ok).toBe(true);
  await expect(page.locator('.toast')).toHaveText(`Noodle’s wrap-up needs you: ${reason}.`);
  await expect.poll(async () => (await cardAt(page, 6))?.display).toBe('needs_you');
  expect((await cardAt(page, 6))?.task).toBe(`Wrap-up: ${reason}`);
  await shot(page, 'm83-needs-you-card');

  await page.evaluate((i) => window.__h3d.openSendHome(i), id);
  d = await homeDialog(page);
  expect(d.wrapup).toMatchObject({ state: 'needs_you', reason });
  await expect(page.locator('dialog.desk-dlg--home [data-key="wrap-reason"]')).toHaveText(reason);
  await shot(page, 'm83-wrapup-needs-you');
  await page.keyboard.press('Escape');
  await expect.poll(() => dialog(page)).toBeNull();
  const before = (await sent(page)).filter((c) => c.t === 'worker.wrapup').length;
  // Wrap up again: the short follow-up, the choice it had, a fresh arm.
  await page.evaluate((i) => window.__h3d.openSendHome(i), id);
  await homeDialog(page);
  await page.locator('dialog.desk-dlg--home [data-key="wrap-again"]').click();
  await expect.poll(async () => (await home(page)).mode).toBe('wrapup');
  d = await home(page);
  expect(d).toMatchObject({ prompt: 'Report the wrap-up line again when done.', choice: 'keep' });
  await page.locator('dialog.desk-dlg--home [data-key="send"]').click();
  await expect.poll(() => dialog(page)).toBeNull();
  const arms = (await sent(page)).filter((c) => c.t === 'worker.wrapup');
  expect(arms.length).toBe(before + 1);
  expect(arms.at(-1)?.args).toEqual({ id, prompt: 'Report the wrap-up line again when done.', worktree: 'keep' });
  await expect.poll(async () => (await cardAt(page, 6))?.tape?.text ?? null).toBe('WRAPPING UP');

  // Cancel wrap-up: it stays at its desk, the tape goes.
  await page.evaluate((i) => window.__h3d.openSendHome(i), id);
  await homeDialog(page);
  await page.locator('dialog.desk-dlg--home [data-key="wrap-cancel"]').click();
  await expect.poll(async () => (await home(page)).wrapup).toBeNull();
  expect((await sent(page)).filter((c) => c.t === 'worker.wrapup.cancel').map((c) => c.args)).toEqual([{ id }]);
  await expect(page.locator('dialog.desk-dlg--home .dd-status[role="status"]')).toHaveText('Cancelled Noodle’s wrap-up. It stays at its desk.');
  await expect(page.locator('dialog.desk-dlg--home [data-key="wrap"]')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await cardAt(page, 6))?.tape ?? null).toBeNull();
  clean();
});

test('send home with keep: Enter sends at once (no warning)', async ({ page }) => {
  const clean = watchErrors(page);
  await openGame(page, 'demo-m4', '', SIM);
  await enter(page, 'pastry');
  const id = await idOf(page, 'pastry', 'Jellybean');
  await page.evaluate((i) => window.__h3d.openSendHome(i), id);
  const d = await homeDialog(page);
  // Unsaved work: delete is off, keep is chosen and focused.
  expect(d.choice).toBe('keep');
  expect(await focusedKey(page)).toBe('wt:keep');
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await sent(page)).filter((c) => c.t === 'worker.fire').map((c) => c.args)).toEqual([{ id, worktree: 'keep' }]);
  await expect(page.locator('.toast')).toContainText('Sent Jellybean home.');
  clean();
});
