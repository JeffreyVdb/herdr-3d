import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test, type Page } from '@playwright/test';
import { herdrInstructions } from '../tools/fixture-start.ts';
import { frames, openGame, openMenu, settingsSection, watchErrors } from './game';

// #117 on demo-m3 with the simulator (tools/fixture-hirepreset.ts): a plain Hire worker has the "Add herdr hiring
// instructions" box (off), and with it off the dialog asks "Hire with instructions" / "Hire without" when the classifier
// says the first task starts other agents. The classifier is the bridge's own (`hire_preset.check` →
// tools/fixture-ai.ts), reading a fake Jev started here that says yes to a task that starts an agent. pastry has desks 14
// and 15 free, herdr-3d desk 5.

const JEV_KEY = 'jev-test-key-0123456789';
const STARTS = /\bstart\b.*\bagent\b/i;
const TASK = 'Upgrade service per service. Let’s start a gpt-6.1-sol agent (on medium reasoning) for each service, giving it targeted instructions to roll out the upgrade.';
const PLAIN = 'Tidy up the README and fix the typos.';

type Hire = Extract<NonNullable<Awaited<ReturnType<typeof dialog>>>, { kind: 'hire' }>;
const keyOf = () => `h117-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const hireDlg = (page: Page) => page.locator('dialog.desk-dlg--hire');
const dialog = (page: Page) => page.evaluate(() => window.__h3d.dialog());
const hires = async (page: Page) => (await page.evaluate(() => window.__h3d.sent())).filter((c) => c.t === 'worker.hire').map((c) => c.args as Record<string, unknown>);
const checks = async (page: Page) => (await page.evaluate(() => window.__h3d.sent())).filter((c) => c.t === 'hire_preset.check');

/** Jev: a task that starts an agent scores high, anything else low. */
function fakeJev(): Promise<{ url: string; close(): Promise<void> }> {
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.headers.authorization !== `Bearer ${JEV_KEY}`) return void res.writeHead(401).end('{"error":"unauthorized"}');
    if (req.url === '/v1/models') return void res.end('{"models":[{"name":"jev-latest","description":"Newest"}]}');
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const prompt = (JSON.parse(body) as { state?: { prompt?: string } }).state?.prompt ?? '';
      res.end(JSON.stringify({ answers: { question: { noul: STARTS.test(prompt) ? 0.97 : 0.03 } } }));
    });
  });
  return new Promise((done) =>
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      done({ url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => (server.closeAllConnections(), server.close(() => r()))) });
    }),
  );
}

/** The game on a bridge whose classifier is set up through Settings (a fake Jev says yes to a task that starts an agent); `jev` null: no classifier. */
async function boot(page: Page, jev: string | null): Promise<void> {
  await page.addInitScript(() => {
    try {
      localStorage.setItem('h3d.hire.goto', 'off');
    } catch {
      /* blocked */
    }
  });
  await openGame(page, 'demo-m3', '', `play=none&sim=1&simms=150&simusage=0&simhirepresets=${keyOf()}${jev ? `&simjev=${encodeURIComponent(jev)}` : ''}`);
  if (!jev) return;
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

async function openHire(page: Page, floor: string, desk: number): Promise<void> {
  await page.evaluate((f) => window.__h3d.enterFloor(f), floor);
  await frames(page, 2);
  await page.evaluate((d) => window.__h3d.openHire(d), desk);
  await expect.poll(async () => {
    const d = await dialog(page);
    return d?.kind === 'hire' ? d.state : null;
  }, { timeout: 15_000 }).toBe('ready');
}

const write = async (page: Page, text: string) => {
  await page.locator('#hire-task').click();
  await page.keyboard.insertText(text);
};
const firstPrompts = (page: Page) => page.evaluate(() => window.__h3d.simFirstPrompts());

test('a plain Hire worker has the box, off: ticking it hires with the lines for this floor, and no question is asked', async ({ page }, info) => {
  test.setTimeout(120_000);
  const clean = watchErrors(page);
  await boot(page, null);
  await openHire(page, 'pastry', 14);
  const box = hireDlg(page).locator('#hire-instructions');
  await expect(box).not.toBeChecked();
  await expect(hireDlg(page).locator('[data-hook="instructions"]')).toContainText('Tick it if this task starts other agents');
  await write(page, TASK);
  await hireDlg(page).locator('label[for="hire-instructions"]').click();
  await expect(box).toBeChecked();
  await expect(hireDlg(page).locator('[data-hook="instructions"]')).toContainText('Each agent this worker starts');
  await hireDlg(page).locator('[data-hook="instructions-lines"] summary').click();
  await expect(hireDlg(page).locator('[data-hook="instructions-lines"] pre')).toContainText('h3d_floor=pastry,');
  await expect(hireDlg(page).locator('[data-hook="instructions-bytes"]')).toContainText('of 32,768 bytes');
  await page.screenshot({ path: info.outputPath('plain-hire-box.png') });
  await hireDlg(page).locator('[data-key="hire"]').click();
  await expect(hireDlg(page)).toBeHidden({ timeout: 20_000 });
  expect(await hires(page)).toEqual([expect.objectContaining({ floor: 'pastry', desk_index: 14, prompt: TASK, herdr_instructions: true })]);
  expect(await checks(page)).toEqual([]);
  expect(await firstPrompts(page)).toEqual([expect.objectContaining({ floor: 'pastry', prompt: `${TASK}\n\n${herdrInstructions('pastry')}` })]);
  clean();
});

test('the question: Esc keeps the task, “Hire without” hires as typed, “Hire with instructions” adds the lines, a task that starts no agent hires at once', async ({ page }, info) => {
  test.setTimeout(240_000);
  const jev = await fakeJev();
  const clean = watchErrors(page);
  try {
    await boot(page, jev.url);
    await openHire(page, 'pastry', 14);
    await write(page, TASK);
    await expect(hireDlg(page).locator('#hire-instructions')).not.toBeChecked();
    // Enter hires: the classifier answers, and the question is asked. The Enter that hired never answers it.
    await page.keyboard.press('Enter');
    const ask = hireDlg(page).locator('[data-hook="hire-ask"]');
    await expect(ask).toBeVisible();
    await expect(ask).toContainText('This task starts other agents');
    await expect(ask.getByRole('button', { name: 'Hire with instructions' })).toBeFocused();
    await page.waitForTimeout(500);
    await expect(ask).toBeVisible();
    expect(await hires(page)).toEqual([]);
    expect(await checks(page)).toHaveLength(1);
    expect(((await checks(page))[0]?.args as { prompt: string }).prompt).toBe(TASK);
    await page.screenshot({ path: info.outputPath('hire-question.png') });

    // Esc: back to the form, the task kept, nobody hired, the dialog open.
    await page.keyboard.press('Escape');
    await expect(ask).toBeHidden();
    await expect(hireDlg(page)).toBeVisible();
    expect(((await dialog(page)) as Hire).form.prompt).toBe(TASK);
    expect(await hires(page)).toEqual([]);

    // Hire again, "Hire without": as typed, no flag, no lines.
    await hireDlg(page).locator('[data-key="hire"]').click();
    await expect(ask).toBeVisible();
    await ask.getByRole('button', { name: 'Hire without' }).click();
    await expect(hireDlg(page)).toBeHidden({ timeout: 20_000 });
    expect(await hires(page)).toEqual([expect.objectContaining({ desk_index: 14, prompt: TASK })]);
    expect(await hires(page)).not.toEqual([expect.objectContaining({ herdr_instructions: true })]);
    expect((await firstPrompts(page)).map((x) => x.prompt)).toEqual([TASK]);

    // Another desk, the same task: asked again (the answer was for the first form); "Hire with instructions".
    await openHire(page, 'pastry', 15);
    await write(page, TASK);
    await hireDlg(page).locator('[data-key="hire"]').click();
    await expect(ask).toBeVisible();
    await ask.getByRole('button', { name: 'Hire with instructions' }).click();
    await expect(hireDlg(page)).toBeHidden({ timeout: 20_000 });
    expect((await hires(page)).map((a) => [a.desk_index, a.herdr_instructions])).toEqual([
      [14, undefined],
      [15, true],
    ]);
    await expect.poll(async () => (await firstPrompts(page)).map((x) => x.prompt)).toEqual([TASK, `${TASK}\n\n${herdrInstructions('pastry')}`]);

    // A task that starts no agent: hired at once, with no question.
    await openHire(page, 'herdr-3d', 5);
    await write(page, PLAIN);
    await hireDlg(page).locator('[data-key="hire"]').click();
    await expect(hireDlg(page)).toBeHidden({ timeout: 20_000 });
    expect((await hires(page)).at(-1)).toMatchObject({ floor: 'herdr-3d', prompt: PLAIN });
    expect((await hires(page)).at(-1)).not.toHaveProperty('herdr_instructions');
    expect(await checks(page)).toHaveLength(4);
  } finally {
    await jev.close();
  }
  clean();
});
