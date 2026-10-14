import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { frames, openGame, openMenu, shot, watchErrors } from './game';
import { board, enter } from './m7';

// #39: `/` skills, `@` files and `@r:` repositories in the real Hire worker, Start run and Prompt dialogs, against
// the simulating fixture server (hire.commands, hire.files and hire.repos: tools/fixture-sim.ts). On demo-m4 and
// demo-m6, herdr-3d and lab share the Work building with depot-manager, whose stored repo has no folder: `@r:` puts in
// its URL. The orchestrator case is the issue's: a board work item (GitHub, and a Kaneo task with `simkaneo=connected`)
// handed to a worker, a repository picked in Extra instructions, carried by run.prepare's preview and by run.start.

const SIM = 'play=none&sim=1&simms=150&simusage=0';
const DEPOT = 'https://github.com/fomra/depot-manager';

type Sent = { t: string; args: Record<string, unknown> };
const sentOf = async (page: Page, t: string): Promise<Sent[]> => (await page.evaluate(() => window.__h3d.sent())).filter((c) => c.t === t) as Sent[];
const dialog = (page: Page) => page.evaluate(() => window.__h3d.dialog());
const optionsOf = (scope: Locator) => scope.locator('.cmp-pop:not([hidden]) [role="option"]');

/** Picks the repository row that `@r:` + `query` lists in `field`'s popup, and checks it went in as plain text. */
async function pickRepo(page: Page, scope: Locator, field: Locator, before: string, evidence?: string): Promise<void> {
  const query = 'depot';
  const chips = await field.locator('.cmp-file').count();
  await field.click();
  await page.keyboard.press('End');
  await page.keyboard.type(`${before}@r:${query}`);
  await expect(scope.getByRole('listbox')).toHaveAttribute('aria-label', 'Repositories on other floors');
  await expect(optionsOf(scope).locator('.tx-repo-label')).toHaveText(['fomra/depot-manager']);
  if (evidence) await shot(page, evidence);
  await page.keyboard.press('Enter');
  await expect(scope.locator('.cmp-pop')).toBeHidden();
  await expect(field).toContainText(`${before}${DEPOT}`);
  // Plain text, never a file chip.
  await expect(field.locator('.cmp-file')).toHaveCount(chips);
}

/** The start-run dialog is up for a work item, its preview made. */
async function startRunReady(page: Page): Promise<void> {
  await expect.poll(async () => (await dialog(page))?.kind, { timeout: 15_000 }).toBe('start-run');
  await expect.poll(async () => {
    const d = (await dialog(page)) as { state: string; preparing: boolean };
    return d.state === 'ready' && !d.preparing;
  }).toBe(true);
}

/** Extra instructions: `@r:` picks depot-manager; the preview and run.start carry the URL. */
async function extraCarriesRepo(page: Page, provider: string): Promise<void> {
  const run = page.locator('dialog.desk-dlg--run');
  await pickRepo(page, run, page.locator('#run-extra'), 'Please use ', `h39-run-extra-${provider}`);
  // run.prepare regenerates the First prompt with it.
  await expect(page.locator('#run-prompt')).toContainText(`Please use ${DEPOT}`, { timeout: 10_000 });
  expect((await sentOf(page, 'run.prepare')).at(-1)?.args.extra).toContain(`Please use ${DEPOT}`);
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect.poll(async () => (await sentOf(page, 'run.start')).length, { timeout: 15_000 }).toBe(1);
  const start = (await sentOf(page, 'run.start'))[0]!.args;
  expect(start).toMatchObject({ work_item: { provider } });
  expect(String(start.extra)).toContain(`Please use ${DEPOT}`);
  expect(start).not.toHaveProperty('prompt');
}

test('Hand to a worker (GitHub): @r: in Extra instructions picks another floor’s repository, through the preview and run.start', async ({ page }) => {
  test.setTimeout(150_000);
  const clean = watchErrors(page);
  await openGame(page, 'demo-m6', '&open=none', SIM);
  await enter(page, 'herdr-3d');
  await page.evaluate(() => window.__h3d.openBoardItem('issues', 'JeffreyVdb/herdr-3d#12'));
  await expect.poll(async () => (await board(page))?.item?.state, { timeout: 10_000 }).toBe('ready');
  await page.locator('dialog.desk-dlg--item [data-key="hand"]').click();
  await startRunReady(page);
  await extraCarriesRepo(page, 'github');
  clean();
});

test('Hand to a worker (Kaneo task): @r: in Extra instructions picks another floor’s repository, through the preview and run.start', async ({ page }) => {
  test.setTimeout(150_000);
  const clean = watchErrors(page);
  await openGame(page, 'demo-m6', '&open=none', `${SIM}&simkaneo=connected`);
  await enter(page, 'lab');
  await page.evaluate(() => window.__h3d.openElevator());
  await page.getByRole('button', { name: 'Settings for lab' }).click();
  const panel = page.locator('dialog.panel');
  await panel.locator('label.tracker-opt', { hasText: 'Kaneo' }).click();
  await panel.locator('#set-kaneoProject').selectOption({ label: 'herdr-3d' });
  await panel.getByRole('button', { name: 'Save settings' }).click();
  await expect(panel.locator('p.panel-status[role="status"]')).toContainText('Saved');
  await page.keyboard.press('Escape');
  await openMenu(page);
  await page.locator('.topbar button', { hasText: 'Issues' }).click();
  const tasks = page.locator('dialog.desk-dlg--board');
  await expect(tasks.locator('h2')).toHaveText('Tasks · lab');
  await tasks.locator('.bd-card', { hasText: 'HRD-4' }).click();
  const item = page.locator('dialog.desk-dlg--item');
  await expect(item.locator('[data-key="hand"]')).toBeVisible({ timeout: 10_000 });
  await item.locator('[data-key="hand"]').click();
  await startRunReady(page);
  expect(((await dialog(page)) as { ticket: { kind: string; item: { provider: string } } }).ticket).toMatchObject({ kind: 'work_item', item: { provider: 'kaneo' } });
  await extraCarriesRepo(page, 'kaneo');
  clean();
});

test('Hire worker: / picks a skill, @ a file chip, @r: a repository, all in the first task’s worker.hire', async ({ page }) => {
  test.setTimeout(120_000);
  const clean = watchErrors(page);
  await openGame(page, 'demo-m4', '', SIM);
  await page.evaluate(() => window.__h3d.enterFloor('herdr-3d'));
  await frames(page, 3);
  await page.evaluate(() => window.__h3d.openHire(5));
  await expect.poll(async () => (await dialog(page)) as { kind: string; state: string } | null, { timeout: 10_000 }).toMatchObject({ kind: 'hire', state: 'ready' });
  const hire = page.locator('dialog.desk-dlg--hire');
  await hire.locator('[data-pick="harness"] .dd-chip', { hasText: 'claude' }).click();
  const task = page.locator('#hire-task');
  await task.click();
  await page.keyboard.type('/hand');
  await expect(hire.getByRole('listbox')).toHaveAttribute('aria-label', 'Commands and skills');
  await expect(optionsOf(hire).locator('.tx-cmd-name')).toHaveText(['/handoff']);
  await expect(hire.locator('.cmp-pop-note')).toHaveText('Skills and commands · type @ for files');
  await shot(page, 'h39-hire-skills');
  await page.keyboard.press('Enter');
  await page.keyboard.type('then read @READ');
  await expect(hire.getByRole('listbox')).toHaveAttribute('aria-label', 'Files and folders');
  await expect(optionsOf(hire).first()).toContainText('README.md');
  await page.keyboard.press('Enter');
  await expect(task.locator('.cmp-file')).toHaveCount(1);
  await pickRepo(page, hire, task, 'and ');
  // The dialog stayed itself: focus in the task, Hire on.
  await expect(task).toBeFocused();
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await sentOf(page, 'worker.hire')).length, { timeout: 15_000 }).toBe(1);
  const prompt = String((await sentOf(page, 'worker.hire'))[0]!.args.prompt);
  expect(prompt).toBe(`/handoff then read @README.md and ${DEPOT} `);
  clean();
});

test('Prompt (P): / and @r: complete as in the worker’s transcript', async ({ page }) => {
  test.setTimeout(120_000);
  const clean = watchErrors(page);
  await openGame(page, 'demo-m5', '', SIM);
  const snap = JSON.parse(readFileSync(resolve(import.meta.dirname, '../fixtures/demo-m5.jsonl'), 'utf8').split('\n')[0] ?? '{}') as { world: { workers: { id: string; name: string }[] } };
  const id = snap.world.workers.find((w) => w.name === 'Nibble')?.id ?? '';
  await page.evaluate((w) => window.__h3d.openPrompt(w), id);
  const overlay = page.locator('dialog.desk-dlg--prompt');
  const note = page.locator('#prompt-text');
  await expect(note).toBeFocused();
  // At phone width the popup stays inside the overlay's body.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.keyboard.type('/rev');
  await expect(optionsOf(overlay).locator('.tx-cmd-name')).toHaveText(['/review']);
  const [pop, body] = await Promise.all([overlay.locator('.cmp-pop').boundingBox(), overlay.locator('form').boundingBox()]);
  expect(pop && body && pop.x >= body.x - 1 && pop.x + pop.width <= body.x + body.width + 1 && pop.y >= body.y - 1 && pop.y + pop.height <= body.y + body.height + 1).toBe(true);
  await shot(page, 'h39-prompt-phone');
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.keyboard.press('Enter');
  await expect(note).toHaveText('/review ');
  await pickRepo(page, overlay, note, 'against ');
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await sentOf(page, 'worker.prompt')).map((c) => c.args.text), { timeout: 10_000 }).toEqual([`/review against ${DEPOT} `]);
  clean();
});
