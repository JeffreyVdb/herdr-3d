import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test, type Page } from '@playwright/test';
import { herdrInstructions } from '../tools/fixture-start.ts';
import { hiringScore } from '../tools/fixture-ai-responses.ts';
import { askFits, frames, openGame, openMenu, settingsSection, shot, watchErrors } from './game';

// #127 on demo-m3 with the simulator (tools/fixture-schedule.ts): the schedule form has "Add herdr hiring instructions"
// (off), and with it off Save asks "Schedule with instructions" / "Schedule without" when the classifier says the
// prompt starts other agents. Settings uses the fake Jev started here; the UI's `hire_preset.check` parses the same
// model response in process so provider latency cannot choose the fail-open path. The real classification threshold
// and the question still run. Run now fires it: the simulator's hire adds the floor's lines last.

const JEV_KEY = 'jev-test-key-0123456789';
const TASK = 'Roll the upgrade out: start an agent for each service, and recreate a worker’s workspace to resume it when one stops.';
const PLAIN = 'Tidy up the README and fix the typos.';

const keyOf = () => `h127-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const sent = async (page: Page, t: string) => (await page.evaluate(() => window.__h3d.sent())).filter((c) => c.t === t).map((c) => c.args as Record<string, unknown>);
const firstPrompts = (page: Page) => page.evaluate(() => window.__h3d.simFirstPrompts());
const form = (page: Page) => page.locator('dialog.desk-dlg--sched');

/** Jev: a prompt that starts an agent scores high, anything else low. */
function fakeJev(): Promise<{ url: string; close(): Promise<void> }> {
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.headers.authorization !== `Bearer ${JEV_KEY}`) return void res.writeHead(401).end('{"error":"unauthorized"}');
    if (req.url === '/v1/models') return void res.end('{"models":[{"name":"jev-latest","description":"Newest"}]}');
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const prompt = (JSON.parse(body) as { state?: { prompt?: string } }).state?.prompt ?? '';
      res.end(JSON.stringify({ answers: { question: { noul: hiringScore(prompt) } } }));
    });
  });
  return new Promise((done) =>
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      done({ url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => (server.closeAllConnections(), server.close(() => r()))) });
    }),
  );
}

/** The game on pastry; `jev`: a classifier set up through Settings (null: none). */
async function boot(page: Page, jev: string | null, more = ''): Promise<void> {
  await openGame(page, 'demo-m3', '', `play=none&sim=1&simms=150&simusage=0&simhirepresets=${keyOf()}${more}${jev ? `&simmodel=hiring&simjev=${encodeURIComponent(jev)}` : ''}`);
  if (jev) {
    await openMenu(page);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const section = await settingsSection(page, 'ai');
    const classifier = section.getByRole('group', { name: /Classification model/ });
    await classifier.getByLabel('Key', { exact: true }).fill(JEV_KEY);
    await classifier.getByRole('button', { name: 'Load models' }).click();
    await expect(classifier.getByLabel('Model')).toHaveValue('jev-latest');
    await classifier.getByRole('button', { name: 'Test' }).click();
    await expect(classifier).toContainText('Test passed');
    await classifier.getByRole('button', { name: 'Save' }).click();
    await expect(classifier.locator('.settings-badge')).toHaveText('Ready');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Settings' })).toBeHidden();
  }
  await page.evaluate(() => window.__h3d.enterFloor('pastry'));
  await frames(page, 3);
}

/** The Scheduled agents dialog, then "New": the form, prepared. */
async function newSchedule(page: Page): Promise<void> {
  await openMenu(page);
  await page.locator('.topbar-menu [data-action="schedules"]').click();
  const list = page.getByRole('dialog', { name: 'Scheduled agents' });
  await expect(list).toBeVisible();
  await list.locator('[data-key="new"]').click();
  await expect(form(page)).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__h3d.scheduleForm()?.preparing)).toBe(false);
}

async function fill(page: Page, title: string, prompt: string): Promise<void> {
  await form(page).locator('#sf-title-in').fill(title);
  await form(page).locator('#sf-when').fill('in 2h');
  await form(page).locator('#sf-prompt').click();
  await page.keyboard.insertText(prompt);
}

test('Save asks about a prompt that starts agents: “Schedule with instructions” saves the option, Edit shows it ticked, Run now adds the floor’s lines last', async ({ page }) => {
  test.setTimeout(240_000);
  const jev = await fakeJev();
  const clean = watchErrors(page);
  try {
    await boot(page, jev.url);
    await newSchedule(page);
    const box = form(page).locator('#sf-instructions');
    await expect(box).not.toBeChecked();
    await expect(form(page).locator('[data-hook="instructions"]')).toContainText('Tick it if this task starts other agents');
    await fill(page, 'Rollout', TASK);

    // Save: the classifier answers, and the question is asked in the form. Nothing is saved yet.
    await form(page).locator('[data-key="save"]').click();
    const ask = form(page).locator('[data-hook="sf-ask"]');
    await expect(ask).toBeVisible({ timeout: 15_000 });
    await expect(ask).toContainText('This scheduled task starts other agents');
    await expect(ask.getByRole('button', { name: 'Schedule with instructions' })).toBeFocused();
    expect(await sent(page, 'hire_preset.check')).toEqual([{ prompt: TASK }]);
    expect(await sent(page, 'schedule.create')).toEqual([]);
    await shot(page, 'h127-schedule-question');
    // On a phone the question wraps inside the dialog; on a desktop its answers keep one row.
    await askFits(page, form(page), ask, 'h127-schedule-question');
    await expect(ask.getByRole('button', { name: 'Schedule with instructions' })).toBeFocused();

    // Esc: back to the form, nothing saved; Save again asks again.
    await page.keyboard.press('Escape');
    await expect(ask).toBeHidden();
    await expect(form(page)).toBeVisible();
    expect(await sent(page, 'schedule.create')).toEqual([]);
    await form(page).locator('[data-key="save"]').click();
    await expect(ask).toBeVisible({ timeout: 15_000 });
    await ask.getByRole('button', { name: 'Schedule with instructions' }).click();
    await expect(form(page)).toBeHidden({ timeout: 15_000 });
    expect(await sent(page, 'schedule.create')).toEqual([expect.objectContaining({ floor: 'pastry', prompt: TASK, herdr_instructions: true })]);

    // Edit: the box is ticked, as saved; "What's added" shows this floor's lines.
    const list = page.getByRole('dialog', { name: 'Scheduled agents' });
    const id = (await page.evaluate(() => window.__h3d.schedules()))?.upcoming[0]?.id as string;
    await list.locator(`[data-key="edit:${id}"]`).click();
    await expect(form(page)).toBeVisible();
    await expect(box).toBeChecked();
    await form(page).locator('[data-hook="instructions-lines"] summary').click();
    await expect(form(page).locator('[data-hook="instructions-lines"] pre')).toContainText('h3d_floor=pastry,');
    await shot(page, 'h127-schedule-edit');
    await page.keyboard.press('Escape');
    await expect(form(page)).toBeHidden();

    // Run now: the fire's first prompt is the prompt, then the lines, once.
    await list.locator(`[data-key="run-now:${id}"]`).click();
    await expect.poll(async () => (await firstPrompts(page)).at(-1)?.prompt, { timeout: 20_000 }).toBe(`${TASK}\n\n${herdrInstructions('pastry')}`);

    // A prompt that starts no agent saves at once, with no question and no flag.
    await page.keyboard.press('Escape');
    await newSchedule(page);
    await fill(page, 'Docs', PLAIN);
    await form(page).locator('[data-key="save"]').click();
    await expect(form(page)).toBeHidden({ timeout: 15_000 });
    expect((await sent(page, 'schedule.create')).at(-1)).toMatchObject({ prompt: PLAIN });
    expect((await sent(page, 'schedule.create')).at(-1)).not.toHaveProperty('herdr_instructions');
    expect(await sent(page, 'hire_preset.check')).toHaveLength(3);
  } finally {
    await jev.close();
  }
  clean();
});

test('no classifier: the box ticked by hand saves the option; a bridge whose schedules do not take it shows no box', async ({ page }) => {
  test.setTimeout(120_000);
  const clean = watchErrors(page);
  await boot(page, null);
  await newSchedule(page);
  await fill(page, 'Rollout', TASK);
  await form(page).locator('label[for="sf-instructions"]').click();
  await expect(form(page).locator('#sf-instructions')).toBeChecked();
  await expect(form(page).locator('[data-hook="instructions"]')).toContainText('Each agent this worker starts');
  await form(page).locator('[data-key="save"]').click();
  await expect(form(page)).toBeHidden({ timeout: 15_000 });
  expect(await sent(page, 'hire_preset.check')).toEqual([]);
  expect(await sent(page, 'schedule.create')).toEqual([expect.objectContaining({ prompt: TASK, herdr_instructions: true })]);
  clean();

  const old = await page.context().newPage();
  const cleanOld = watchErrors(old);
  await boot(old, null, '&simfail=no_schedule_instructions');
  await newSchedule(old);
  await expect(form(old).locator('[data-hook="instructions"]')).toHaveCount(0);
  await fill(old, 'Rollout', TASK);
  await form(old).locator('[data-key="save"]').click();
  await expect(form(old)).toBeHidden({ timeout: 15_000 });
  expect((await sent(old, 'schedule.create'))[0]).not.toHaveProperty('herdr_instructions');
  cleanOld();
});

// U2: the prompt fits with its image's short marker, but not once the image's path and the lines are in: Save stops,
// and the error, the box and the dialog's controls stay on screen (the box's hidden input scrolled the dialog itself).
for (const [width, height] of [[1440, 900], [390, 844]] as const) {
  test(`at ${width}px, an uploaded image that takes a near-limit prompt with the box over the limit: the error and the ticked box stay in view`, async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width, height });
    const clean = watchErrors(page);
    await boot(page, null);
    await newSchedule(page);
    await fill(page, 'Image overflow', 'x'.repeat(32097));
    await page.evaluate(async () => {
      const c = document.createElement('canvas');
      c.width = 64;
      c.height = 64;
      (c.getContext('2d') as CanvasRenderingContext2D).fillRect(0, 0, 32, 32);
      const blob = await new Promise<Blob>((r) => c.toBlob((b) => r(b as Blob), 'image/png'));
      const dt = new DataTransfer();
      dt.items.add(new File([blob], 'overflow.png', { type: 'image/png' }));
      (document.querySelector('#sf-prompt') as HTMLElement).dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    });
    await expect(form(page).locator('.cmp-chip .cmp-state')).toHaveText('Uploaded', { timeout: 15_000 });
    const box = form(page).locator('#sf-instructions');
    await form(page).locator('label[for="sf-instructions"]').click();
    await expect(box).toBeChecked();
    await expect.poll(() => page.evaluate(() => window.__h3d.scheduleForm()?.instructions?.lines ?? null)).not.toBeNull();
    expect(await page.evaluate(() => window.__h3d.scheduleForm()?.blocker)).toBeNull();

    await form(page).locator('[data-key="save"]').click();
    await expect.poll(() => page.evaluate(() => window.__h3d.scheduleForm()?.error)).toBe(true);
    const alert = form(page).locator('.dd-foot [role="alert"]');
    await expect(alert).toContainText('with the image and file paths and the herdr hiring instructions');
    await expect(box).toBeFocused();
    await expect(box).toBeChecked();
    await frames(page, 2);

    // The dialog itself never scrolls: its header, the error, the box and the footer's buttons are inside it.
    expect(await form(page).evaluate((d) => d.scrollTop)).toBe(0);
    // Nothing in it reaches past its box, so no focus can scroll it.
    expect(await form(page).evaluate((d) => d.scrollHeight - d.clientHeight)).toBe(0);
    const dlg = (await form(page).boundingBox())!;
    const body = (await form(page).locator('.dd-body').boundingBox())!;
    const parts = [
      [form(page).locator('.dd-head'), dlg],
      [form(page).locator('[data-key="close"]'), dlg],
      [alert, dlg],
      [form(page).locator('[data-key="save"]'), dlg],
      [form(page).locator('[data-key="cancel"]'), dlg],
      // The box in the part of the form its scrolling body shows.
      [form(page).locator('label[for="sf-instructions"] .dd-check-box'), body],
    ] as const;
    for (const [part, within] of parts) {
      const b = (await part.boundingBox())!;
      const what = `at ${width}px: ${await part.evaluate((e) => e.outerHTML.slice(0, 60))}`;
      expect(b.y, what).toBeGreaterThanOrEqual(within.y);
      expect(b.y + b.height, what).toBeLessThanOrEqual(within.y + within.height + 0.5);
    }
    await shot(page, `h127-schedule-image-overflow-${width}`);
    expect(await sent(page, 'schedule.create')).toEqual([]);
    expect(await sent(page, 'schedule.update')).toEqual([]);
    expect(await sent(page, 'worker.handoff')).toEqual([]);
    clean();
  });
}
